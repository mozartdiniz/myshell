import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from '../main.js';
import {NameDialog} from './nameDialog.js';

/** Seconds a set waits for the windows of the apps it opened */
const LAUNCH_TIMEOUT = 60;
/**
 * Pause after one of those windows arrived before asking for another,
 * as apps that restore their own session open several by themselves
 */
const NEXT_WINDOW_DELAY = 1500;

/**
 * Workspace sets, as PowerToys Workspaces or a Stage Manager set: a
 * workspace saved under a name, with its windows (which apps, where
 * they sit, maximized or not, in stacking order), its wallpaper and
 * Focus mode. Opening a set on a workspace gives it the set's name,
 * moves the windows of the set's apps that are on it already into
 * place, and opens the ones that are missing. A single-window app that
 * runs elsewhere comes over. Other windows are left alone.
 *
 * The sets live in $XDG_CONFIG_HOME/tessera/sets.json.
 */
export class WorkspaceSets {
    constructor() {
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'tessera', 'sets.json']));
        /**
         * @type {{name: string, wallpaper: string|null, focus: boolean,
         *   windows: object[]}[]}
         */
        this._sets = this._load();
        /** app id → windows asked of it that haven't appeared yet */
        this._pending = new Map();

        global.display.connect('window-created', (_d, window) => this._onWindowCreated(window));
    }

    /** @returns {string[]} the sets' names, in the order they were made */
    get names() {
        return this._sets.map(s => s.name);
    }

    has(name) {
        return this._sets.some(s => s.name === name);
    }

    /**
     * Save workspace `index` as set `name`, replacing any set by that
     * name.
     *
     * @param {string} name
     * @param {number} index
     */
    save(name, index) {
        const ws = global.workspace_manager.get_workspace_by_index(index);
        if (!ws)
            return;
        const tracker = Shell.WindowTracker.get_default();
        const windows = global.display.sort_windows_by_stacking(ws.list_windows().filter(isSetWindow))
            .map(window => [window, tracker.get_window_app(window)])
            .filter(([, app]) => app && !app.is_window_backed())
            .map(([window, app]) => {
                const monitor = window.get_monitor();
                const geometry = global.display.get_monitor_geometry(monitor);
                const rect = window.get_frame_rect();
                return {
                    app: app.get_id(),
                    monitor,
                    x: rect.x - geometry.x,
                    y: rect.y - geometry.y,
                    width: rect.width,
                    height: rect.height,
                    maximized: window.is_maximized(),
                    fullscreen: window.is_fullscreen(),
                    minimized: window.minimized,
                };
            });

        const set = {
            name,
            wallpaper: Main.workspaceBackgrounds.uriFor(index),
            focus: Main.dock.clip.isFocused(index),
            windows,
        };
        const at = this._sets.findIndex(s => s.name === name);
        if (at >= 0)
            this._sets[at] = set;
        else
            this._sets.push(set);
        this._save();
    }

    remove(name) {
        this._sets = this._sets.filter(s => s.name !== name);
        this._save();
    }

    /**
     * Open set `name` on the current workspace, or on a new one.
     *
     * @param {string} name
     * @param {boolean} [newWorkspace]
     */
    async restore(name, newWorkspace = false) {
        const set = this._sets.find(s => s.name === name);
        if (!set)
            return;
        let ws = global.workspace_manager.get_active_workspace();
        if (newWorkspace) {
            ws = await Main.fixedWorkspaces.add(true);
            if (!ws)
                return;
        }
        const index = ws.index();

        Meta.prefs_change_workspace_name(index, set.name);
        Main.workspaceBackgrounds.set(index, set.wallpaper);
        Main.dock.clip.setFocus(set.focus, index);

        // Windows already here go first, oldest stacking first
        const tracker = Shell.WindowTracker.get_default();
        const unused = global.display.sort_windows_by_stacking(ws.list_windows().filter(isSetWindow));
        const placed = [];
        /** app id → windows still to find */
        const missing = new Map();
        for (const entry of set.windows) {
            const i = unused.findIndex(w => tracker.get_window_app(w)?.get_id() === entry.app);
            if (i >= 0) {
                const [window] = unused.splice(i, 1);
                place(window, entry, index);
                placed.push(window);
            } else if (missing.has(entry.app)) {
                missing.get(entry.app).push(entry);
            } else {
                missing.set(entry.app, [entry]);
            }
        }

        const appSys = Shell.AppSystem.get_default();
        for (const [appId, entries] of missing) {
            const app = appSys.lookup_app(appId);
            if (!app)
                continue;
            if (app.state === Shell.AppState.RUNNING && !app.can_open_new_window()) {
                const window = app.get_windows().find(isSetWindow);
                if (window) {
                    place(window, entries[0], index);
                    placed.push(window);
                }
                continue;
            }
            this._request(app, entries, index);
        }

        // Stack them as they were, with the top one focused
        for (const window of placed)
            window.raise();
        const top = placed.findLast(w => !w.minimized);
        if (top)
            Main.activateWindow(top);
    }

    // ---- windows of apps the set opened -----------------------------

    /** Open windows of `app` on workspace `index` for `entries`. */
    _request(app, entries, index) {
        const appId = app.get_id();
        this._cancel(appId);
        const pending = {app, index, entries: [...entries], timeoutId: 0, nextId: 0};
        pending.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LAUNCH_TIMEOUT, () => {
            pending.timeoutId = 0;
            this._cancel(appId);
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(appId, pending);
        openWindow(app, index);
    }

    _cancel(appId) {
        const pending = this._pending.get(appId);
        if (!pending)
            return;
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
        if (pending.nextId)
            GLib.source_remove(pending.nextId);
        this._pending.delete(appId);
    }

    _onWindowCreated(window) {
        if (!this._pending.size)
            return;
        // Placed once it shows, when its app is known for sure
        const actor = window.get_compositor_private();
        const id = actor?.connect('first-frame', () => {
            actor.disconnect(id);
            this._claim(window);
        });
    }

    _claim(window) {
        if (!isSetWindow(window))
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const pending = app && this._pending.get(app.get_id());
        if (!pending)
            return;

        place(window, pending.entries.shift(), pending.index);
        if (!pending.entries.length) {
            this._cancel(app.get_id());
            return;
        }
        if (pending.nextId)
            GLib.source_remove(pending.nextId);
        pending.nextId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NEXT_WINDOW_DELAY, () => {
            pending.nextId = 0;
            openWindow(pending.app, pending.index);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- persistence ------------------------------------------------

    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const {sets} = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(sets))
                return [];
            return sets.filter(s => typeof s?.name === 'string' && s.name && Array.isArray(s.windows))
                .map(s => ({
                    name: s.name,
                    wallpaper: typeof s.wallpaper === 'string' ? s.wallpaper : null,
                    focus: !!s.focus,
                    windows: s.windows.filter(isEntry),
                }));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load sets.json: ${e.message}`);
            return [];
        }
    }

    _save() {
        try {
            const dir = this._file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._file.replace_contents(
                JSON.stringify({sets: this._sets}, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save sets.json: ${e.message}`);
        }
    }
}

/**
 * Ask for a name and save workspace `index` as a set by that name.
 *
 * @param {number} index
 */
export function saveSet(index) {
    new NameDialog({
        title: _('Save Workspace as Set'),
        description: _('The set keeps the workspace’s windows, wallpaper and Focus mode. A set with the same name is replaced.'),
        name: Meta.prefs_get_workspace_name(index),
        action: _('Save'),
    }, name => Main.workspaceSets.save(name, index)).open();
}

/** Whether `window` is one a set keeps: no dialogs or sticky windows. */
function isSetWindow(window) {
    return window.window_type === Meta.WindowType.NORMAL &&
        !window.skip_taskbar && !window.get_transient_for() &&
        !window.is_on_all_workspaces();
}

function isEntry(entry) {
    return typeof entry?.app === 'string' &&
        ['monitor', 'x', 'y', 'width', 'height'].every(k => Number.isInteger(entry[k]));
}

/** Start `app` on workspace `index`, or open another window of it. */
function openWindow(app, index) {
    if (app.state === Shell.AppState.STOPPED)
        app.launch(0, index, Shell.AppLaunchGpu.APP_PREF);
    else if (app.state === Shell.AppState.RUNNING)
        app.open_new_window(index);
    // Still starting: its first window is on the way
}

/**
 * Put `window` on workspace `index` where `entry` says, keeping it
 * inside the monitor's work area.
 */
function place(window, entry, index) {
    const ws = global.workspace_manager.get_workspace_by_index(index);
    if (!ws)
        return;
    if (window.get_workspace() !== ws)
        window.change_workspace(ws);

    const display = global.display;
    const monitor = entry.monitor < display.get_n_monitors()
        ? entry.monitor : display.get_primary_monitor();
    if (entry.fullscreen || entry.maximized) {
        if (window.get_monitor() !== monitor)
            window.move_to_monitor(monitor);
        if (entry.fullscreen) {
            window.make_fullscreen();
        } else {
            window.unmake_fullscreen();
            if (!window.is_maximized() && window.can_maximize())
                window.maximize();
        }
    } else {
        window.unmake_fullscreen();
        if (window.is_maximized())
            window.unmaximize();
        const geometry = display.get_monitor_geometry(monitor);
        const area = ws.get_work_area_for_monitor(monitor);
        const width = Math.min(entry.width, area.width);
        const height = Math.min(entry.height, area.height);
        const x = Math.clamp(geometry.x + entry.x, area.x, area.x + area.width - width);
        const y = Math.clamp(geometry.y + entry.y, area.y, area.y + area.height - height);
        window.move_resize_frame(true, x, y, width, height);
    }

    if (entry.minimized)
        window.minimize();
    else
        window.unminimize();
}
