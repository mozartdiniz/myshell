import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Layout from '../layout.js';
import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';
import {TILE_SIZE} from './docklet.js';

export const CLIP_ID = 'clip';
/** Workspace of an omnipresent Clip icon */
export const ALL_WORKSPACES = -1;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
// As for the hot corner
const PEEK_PRESSURE = 100;
const PEEK_TIMEOUT = 1000;
const POLL_INTERVAL = 100;
const LEAVE_DELAY = 600;
/** Extra room around peeking or expanded tiles before they go again */
const LEAVE_MARGIN = TILE_SIZE / 2;

/**
 * WindowMaker's Clip, which the Clip applet (docklets/clip.js) is the
 * tile of. Tiles can be clipped to a workspace, or to all of them: the
 * DockManager lines up the current workspace's ones next to the Clip
 * and hides the rest. With Auto-attract, apps that aren't pinned get
 * their temporary tile in the Clip of their workspace instead of on
 * the dock. The Clip can be collapsed, by hand or whenever the pointer
 * isn't on it (Auto-collapse).
 *
 * Focus mode, per workspace, hides every tile outside the Clip and
 * gives their screen space to the windows. It can turn itself on while
 * a window is maximized, and pushing the pointer against an edge peeks
 * at that edge's hidden tiles.
 *
 * Which tiles are clipped, and where Focus mode is on, live in
 * $XDG_CONFIG_HOME/tessera/clip.json; the Clip applet's own settings
 * hold its options.
 */
export class Clip {
    /** @param {import('./dockManager.js').DockManager} dock */
    constructor(dock) {
        this._dock = dock;
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'tessera', 'clip.json']));
        const state = this._load();
        /** @type {{id: string, workspace: number}[]} in strip order */
        this._members = Array.isArray(state.members)
            ? state.members.filter(m => typeof m?.id === 'string' && Number.isInteger(m.workspace))
            : [];
        /** workspaces in Focus mode */
        this._focus = new Set(Array.isArray(state.focus)
            ? state.focus.filter(ws => Number.isInteger(ws)) : []);
        /** ...of which these turned it on for a maximized window */
        this._autoFocused = new Set();
        /** workspace → whether it had a maximized window when last checked */
        this._maximized = new Map();
        /** tile id → workspace of apps the Clip attracted; not saved */
        this._attracted = new Map();
        /** apps dragged out of the Clip, not attracted again while they run */
        this._released = new Set();
        this._saveId = 0;
        this._checkId = 0;

        this._peekEdge = null;
        this._peekWatch = null;
        this._hoverExpanded = false;
        this._hoverWatch = null;
        /** edge → Meta.Barrier */
        this._barriers = new Map();
        this._pressure = new Layout.PressureBarrier(PEEK_PRESSURE, PEEK_TIMEOUT,
            Shell.ActionMode.NORMAL);
        this._pressure.connect('trigger', () => this._onPressure());

        const wm = global.workspace_manager;
        wm.connectObject(
            'active-workspace-changed', () => {
                this._endPeek();
                this._dock.syncLayout();
                this._queueCheckMaximized();
            },
            'notify::n-workspaces', () => this._onWorkspacesChanged(),
            this);
        global.window_manager.connectObject(
            'size-changed', () => this._queueCheckMaximized(),
            'minimize', () => this._queueCheckMaximized(),
            'unminimize', () => this._queueCheckMaximized(),
            'map', () => this._queueCheckMaximized(),
            'destroy', () => this._queueCheckMaximized(),
            this);
        global.display.connectObject('window-left-monitor',
            () => this._queueCheckMaximized(), this);

        Main.wm.addKeybinding('toggle-focus-mode',
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => this.toggleFocus());
    }

    /** The Clip's tile; the Clip only works while it is shown. */
    get tile() {
        return this._dock.tileById(CLIP_ID);
    }

    get active() {
        return !!this.tile;
    }

    get _settings() {
        return this.tile?.settings ?? {};
    }

    get _workspace() {
        return global.workspace_manager.get_active_workspace_index();
    }

    /** Called by the DockManager when the Clip's tile is added. */
    attach(tile) {
        tile.connectObject('notify::hover', () => {
            if (tile.hover && this._settings.autoCollapse && !this._hoverExpanded)
                this._hoverExpand();
        }, this);
        this._queueCheckMaximized();
    }

    /** Called by the DockManager when the Clip's tile has gone. */
    detach() {
        this._endPeek();
        this._hoverWatch?.stop();
        this._hoverExpanded = false;
        this.syncBarriers([]);
    }

    // ---- icons ------------------------------------------------------

    /** Whether tile `id` belongs in the Clip, on any workspace. */
    isMember(id) {
        return this.active &&
            (this._attracted.has(id) || this._members.some(m => m.id === id));
    }

    /** @returns {number|null} the workspace tile `id` is clipped to */
    workspaceOf(id) {
        return this._members.find(m => m.id === id)?.workspace ??
            this._attracted.get(id) ?? null;
    }

    /** Ids of the tiles to line up next to the Clip now, in order. */
    stripIds() {
        if (!this.active)
            return [];
        const ws = this._workspace;
        const here = w => w === ws || w === ALL_WORKSPACES;
        return [
            ...this._members.filter(m => here(m.workspace)).map(m => m.id),
            ...[...this._attracted].filter(([, w]) => here(w)).map(([id]) => id),
        ];
    }

    /** Desktop ids of the apps clipped for good, which keep a tile. */
    appIds() {
        if (!this.active)
            return [];
        return this._members.filter(m => m.id.startsWith('app:'))
            .map(m => m.id.slice('app:'.length));
    }

    /**
     * Clip tile `id` to `workspace`, before tile `beforeId` in the
     * strip, or at its end.
     *
     * @param {string} id
     * @param {number} workspace - an index or ALL_WORKSPACES
     * @param {string|null} beforeId
     */
    add(id, workspace, beforeId = null) {
        this._attracted.delete(id);
        this._members = this._members.filter(m => m.id !== id);
        const at = this._members.findIndex(m => m.id === beforeId);
        const member = {id, workspace};
        if (at >= 0)
            this._members.splice(at, 0, member);
        else
            this._members.push(member);
        this._queueSave();
        this._dock.refresh();
    }

    /** Take tile `id` out of the Clip. */
    remove(id, sync = true) {
        if (this._attracted.delete(id) && id.startsWith('app:'))
            this._released.add(id.slice('app:'.length));
        this._members = this._members.filter(m => m.id !== id);
        this._queueSave();
        if (sync)
            this._dock.refresh();
    }

    _setWorkspace(id, workspace) {
        const member = this._members.find(m => m.id === id);
        if (member)
            member.workspace = workspace;
        else
            this._attracted.set(id, workspace);
        this._queueSave();
        this._dock.syncLayout();
    }

    /** Whether a running app's temporary tile should go in the Clip. */
    shouldAttract(app) {
        return this.active && !!this._settings.autoAttract &&
            !this._released.has(app.get_id());
    }

    /** Put a running app's temporary tile in the Clip of its workspace. */
    attract(tileId, app) {
        const window = app.get_windows().find(w => !w.skip_taskbar);
        let workspace = this._workspace;
        if (window?.is_on_all_workspaces())
            workspace = ALL_WORKSPACES;
        else if (window?.get_workspace())
            workspace = window.get_workspace().index();
        this._attracted.set(tileId, workspace);
    }

    /**
     * Forget attracted apps that have stopped, and let apps dragged out
     * of the Clip be attracted again once they have.
     *
     * @param {Set<string>} running - desktop ids of running apps
     */
    pruneApps(running) {
        for (const id of this._attracted.keys()) {
            if (!running.has(id.slice('app:'.length)))
                this._attracted.delete(id);
        }
        for (const appId of this._released) {
            if (!running.has(appId))
                this._released.delete(appId);
        }
    }

    tileDestroyed(id) {
        this._attracted.delete(id);
    }

    /**
     * Add the Clip items for `tile` to its menu.
     *
     * @param {PopupMenu.PopupMenuBase} menu
     * @param {import('./docklet.js').Docklet} tile
     */
    addTileItems(menu, tile) {
        if (!this.active || tile.id === CLIP_ID)
            return;
        const {id} = tile;
        const ws = this._workspace;
        const member = this._members.find(m => m.id === id);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Clip')));

        if (!member) {
            if (this._attracted.has(id)) {
                menu.addAction(_('Keep in Clip'),
                    () => this.add(id, this._attracted.get(id)));
            } else {
                menu.addAction(_('Clip to “%s”').format(Meta.prefs_get_workspace_name(ws)),
                    () => this.add(id, ws));
                menu.addAction(_('Clip to All Workspaces'), () => this.add(id, ALL_WORKSPACES));
                return;
            }
        }

        const current = this.workspaceOf(id);
        const all = new PopupMenu.PopupSwitchMenuItem(_('On All Workspaces'),
            current === ALL_WORKSPACES);
        all.connect('toggled', (_i, on) =>
            this._setWorkspace(id, on ? ALL_WORKSPACES : ws));
        menu.addMenuItem(all);

        const n = global.workspace_manager.n_workspaces;
        if (n > 1) {
            const move = new PopupMenu.PopupSubMenuMenuItem(_('Move to Workspace'));
            for (let i = 0; i < n; i++) {
                if (i !== current)
                    move.menu.addAction(Meta.prefs_get_workspace_name(i), () => this._setWorkspace(id, i));
            }
            menu.addMenuItem(move);
        }
        menu.addAction(_('Unclip'), () => this.remove(id));
    }

    // ---- collapsing -------------------------------------------------

    /** Whether the Clip's icons are tucked away behind it. */
    get collapsed() {
        if (this._settings.autoCollapse)
            return !this._hoverExpanded;
        return !!this._settings.collapsed;
    }

    toggleCollapsed() {
        if (!this.active)
            return;
        if (this._settings.autoCollapse) {
            if (this._hoverExpanded) {
                this._hoverWatch?.stop();
                this._hoverExpanded = false;
                this._dock.syncLayout();
            } else {
                this._hoverExpand();
            }
            return;
        }
        this.tile.setSetting('collapsed', !this._settings.collapsed);
    }

    /** Show the icons until the pointer has left the Clip for a moment. */
    _hoverExpand() {
        this._hoverExpanded = true;
        this._dock.syncLayout();
        this._hoverWatch?.stop();
        this._hoverWatch = new PointerWatch(
            () => [this.tile, ...this.stripIds().map(id => this._dock.tileById(id))]
                .filter(t => t && !t.dockHidden)
                .map(t => grow(this._dock.tileRect(t), LEAVE_MARGIN)),
            () => {
                this._hoverWatch = null;
                this._hoverExpanded = false;
                this._dock.syncLayout();
            },
            () => this._dock.dragging);
    }

    // ---- focus mode -------------------------------------------------

    /** Whether the tiles outside the Clip are hidden now. */
    get focusActive() {
        return this.active && this._focus.has(this._workspace);
    }

    /** The edge whose hidden tiles are peeking out, if any. */
    get peekEdge() {
        return this._peekEdge;
    }

    toggleFocus() {
        this.setFocus(!this.focusActive);
    }

    /**
     * Whether Focus mode is on for workspace `ws`, other than for a
     * maximized window, which turns it on by itself.
     */
    isFocused(ws) {
        return this._focus.has(ws) && !this._autoFocused.has(ws);
    }

    /**
     * @param {boolean} on
     * @param {number} [ws] - the workspace; the current one by default
     */
    setFocus(on, ws = this._workspace) {
        if (!this.active)
            return;
        this._autoFocused.delete(ws);
        if (on)
            this._focus.add(ws);
        else
            this._focus.delete(ws);
        this._endPeek();
        this._queueSave();
        this._dock.syncLayout();
    }

    /**
     * Turning the option off brings back the tiles it hid; turning it
     * on applies it to a window that's maximized already.
     */
    focusOnMaximizeChanged() {
        if (this._settings.focusOnMaximize) {
            this._maximized.clear();
            this._queueCheckMaximized();
            return;
        }
        for (const ws of this._autoFocused)
            this._focus.delete(ws);
        this._autoFocused.clear();
        this._endPeek();
        this._queueSave();
    }

    _queueCheckMaximized() {
        if (this._checkId)
            return;
        this._checkId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._checkId = 0;
            this._checkMaximized();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Turn Focus mode on when a window on the current workspace gets
     * maximized, and back off when none is, unless it was on already
     * or turned off by hand in between.
     */
    _checkMaximized() {
        const ws = this._workspace;
        const primary = global.display.get_primary_monitor();
        const maximized = global.workspace_manager.get_active_workspace().list_windows()
            .some(w => !w.minimized && !w.skip_taskbar && w.is_maximized() &&
                w.get_monitor() === primary);
        const was = this._maximized.get(ws) ?? false;
        this._maximized.set(ws, maximized);
        if (!this.active || !this._settings.focusOnMaximize || maximized === was)
            return;

        if (maximized && !this._focus.has(ws)) {
            this._focus.add(ws);
            this._autoFocused.add(ws);
        } else if (!maximized && this._autoFocused.has(ws)) {
            this._focus.delete(ws);
            this._autoFocused.delete(ws);
        } else {
            return;
        }
        this._endPeek();
        this._queueSave();
        this._dock.syncLayout();
    }

    /**
     * Put pressure barriers on the screen edges whose tiles are hidden,
     * so pushing against one peeks at them. Edges shared with another
     * monitor get none, as they'd stop the pointer crossing over.
     *
     * @param {string[]} edges
     */
    syncBarriers(edges) {
        const wanted = new Set(this._settings.peek && this.focusActive
            ? edges.filter(e => this._isOuterEdge(e)) : []);
        for (const [edge, barrier] of this._barriers) {
            if (wanted.has(edge) && barrier._monitorRect === this._monitorKey())
                continue;
            this._pressure.removeBarrier(barrier);
            barrier.destroy();
            this._barriers.delete(edge);
        }
        for (const edge of wanted) {
            if (this._barriers.has(edge))
                continue;
            const barrier = new Meta.Barrier({backend: global.backend, ...barrierLine(edge)});
            barrier._edge = edge;
            barrier._monitorRect = this._monitorKey();
            barrier.connect('hit', () => (this._pressureEdge = edge));
            this._pressure.addBarrier(barrier);
            this._barriers.set(edge, barrier);
        }
    }

    _monitorKey() {
        const m = Main.layoutManager.primaryMonitor;
        return m ? `${m.x},${m.y},${m.width},${m.height}` : '';
    }

    _isOuterEdge(edge) {
        const m = Main.layoutManager.primaryMonitor;
        return !Main.layoutManager.monitors.some(o => {
            if (o === m)
                return false;
            const overlapsY = o.y < m.y + m.height && o.y + o.height > m.y;
            const overlapsX = o.x < m.x + m.width && o.x + o.width > m.x;
            switch (edge) {
            case 'left': return overlapsY && o.x + o.width === m.x;
            case 'right': return overlapsY && o.x === m.x + m.width;
            case 'top': return overlapsX && o.y + o.height === m.y;
            default: return overlapsX && o.y === m.y + m.height;
            }
        });
    }

    _onPressure() {
        const edge = this._pressureEdge;
        if (!edge || !this.focusActive || this._peekEdge === edge)
            return;
        this._peekEdge = edge;
        this._dock.syncLayout();
        this._peekWatch?.stop();
        this._peekWatch = new PointerWatch(
            () => [grow(this._dock.edgeBand(edge), LEAVE_MARGIN)],
            () => {
                this._peekWatch = null;
                this._peekEdge = null;
                this._dock.syncLayout();
            },
            () => this._dock.dragging);
    }

    _endPeek() {
        this._peekWatch?.stop();
        this._peekWatch = null;
        this._peekEdge = null;
    }

    // ---- workspaces -------------------------------------------------

    /** Icons and Focus mode of a removed workspace go to the new last one. */
    _onWorkspacesChanged() {
        const last = global.workspace_manager.n_workspaces - 1;
        for (const m of this._members)
            m.workspace = Math.min(m.workspace, last);
        for (const [id, w] of this._attracted)
            this._attracted.set(id, Math.min(w, last));
        for (const set of [this._focus, this._autoFocused]) {
            for (const ws of [...set]) {
                if (ws > last)
                    set.delete(ws);
            }
        }
        this._queueSave();
        this._dock.syncLayout();
    }

    // ---- persistence ------------------------------------------------

    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const state = JSON.parse(new TextDecoder().decode(bytes));
            return state && typeof state === 'object' ? state : {};
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load clip.json: ${e.message}`);
            return {};
        }
    }

    _queueSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        // Focus mode for a maximized window comes back by itself
        const focus = [...this._focus].filter(ws => !this._autoFocused.has(ws));
        try {
            const dir = this._file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._file.replace_contents(
                JSON.stringify({members: this._members, focus}, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save clip.json: ${e.message}`);
        }
    }
}

/**
 * Calls `onLeave` once the pointer has been outside all of `rects()`
 * for a moment, while no menu is open and `busy()` is false.
 */
class PointerWatch {
    constructor(rects, onLeave, busy) {
        let outside = 0;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => {
            const [x, y] = global.get_pointer();
            const inside = rects().some(r =>
                x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
            if (inside || busy() || Main.actionMode !== Shell.ActionMode.NORMAL) {
                outside = 0;
                return GLib.SOURCE_CONTINUE;
            }
            outside += POLL_INTERVAL;
            if (outside < LEAVE_DELAY)
                return GLib.SOURCE_CONTINUE;
            this._id = 0;
            onLeave();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

function grow({x, y, width, height}, by) {
    return {x: x - by, y: y - by, width: width + 2 * by, height: height + 2 * by};
}

/** Barrier along a whole edge of the primary monitor, facing in. */
function barrierLine(edge) {
    const m = Main.layoutManager.primaryMonitor;
    switch (edge) {
    case 'left':
        return {
            x1: m.x, y1: m.y, x2: m.x, y2: m.y + m.height,
            directions: Meta.BarrierDirection.POSITIVE_X,
        };
    case 'right':
        return {
            x1: m.x + m.width, y1: m.y, x2: m.x + m.width, y2: m.y + m.height,
            directions: Meta.BarrierDirection.NEGATIVE_X,
        };
    case 'top':
        return {
            x1: m.x, y1: m.y, x2: m.x + m.width, y2: m.y,
            directions: Meta.BarrierDirection.POSITIVE_Y,
        };
    default:
        return {
            x1: m.x, y1: m.y + m.height, x2: m.x + m.width, y2: m.y + m.height,
            directions: Meta.BarrierDirection.NEGATIVE_Y,
        };
    }
}
