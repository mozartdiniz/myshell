import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const WM_PREFS_SCHEMA = 'org.gnome.desktop.wm.preferences';
const DEFAULT_COUNT = 4;
// Mutter's own limit
export const MAX_WORKSPACES = 36;

/**
 * A fixed number of workspaces, as in WindowMaker: they are only added
 * and removed on request, so per-workspace state like the Clip's icons
 * stays put. GNOME's dynamic-workspaces setting is shared with the
 * stock session, so it is left alone: while it is on, Tessera keeps
 * the count itself in $XDG_CONFIG_HOME/tessera/workspaces.json (and
 * WorkspaceTracker doesn't add or remove any); while it is off,
 * mutter's num-workspaces is the count.
 */
export class FixedWorkspaces {
    constructor() {
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'tessera', 'workspaces.json']));
        this._wmPrefs = new Gio.Settings({schema_id: WM_PREFS_SCHEMA});

        const wm = global.workspace_manager;
        if (Meta.prefs_get_dynamic_workspaces()) {
            const count = Math.clamp(this._load() ?? DEFAULT_COUNT, 1, MAX_WORKSPACES);
            while (wm.n_workspaces < count)
                wm.append_new_workspace(false, global.get_current_time());
            while (wm.n_workspaces > count) {
                wm.remove_workspace(wm.get_workspace_by_index(wm.n_workspaces - 1),
                    global.get_current_time());
            }
        }
        wm.connect('notify::n-workspaces', () => {
            if (Meta.prefs_get_dynamic_workspaces())
                this._save(wm.n_workspaces);
        });
    }

    /**
     * Add a workspace at the end.
     *
     * @param {boolean} activate - switch to it too
     */
    add(activate = false) {
        const wm = global.workspace_manager;
        const index = wm.n_workspaces;
        if (index >= MAX_WORKSPACES)
            return;
        if (Meta.prefs_get_dynamic_workspaces()) {
            const ws = wm.append_new_workspace(false, global.get_current_time());
            if (activate)
                ws.activate(global.get_current_time());
            return;
        }
        if (activate) {
            const id = wm.connect('notify::n-workspaces', () => {
                wm.disconnect(id);
                wm.get_workspace_by_index(index)?.activate(global.get_current_time());
            });
        }
        this._wmPrefs.set_int('num-workspaces', index + 1);
    }

    /** Remove the last workspace; mutter moves its windows to the one before. */
    removeLast() {
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        if (n <= 1)
            return;
        if (Meta.prefs_get_dynamic_workspaces())
            wm.remove_workspace(wm.get_workspace_by_index(n - 1), global.get_current_time());
        else
            this._wmPrefs.set_int('num-workspaces', n - 1);
    }

    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const {count} = JSON.parse(new TextDecoder().decode(bytes));
            return Number.isInteger(count) ? count : null;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load workspaces: ${e.message}`);
            return null;
        }
    }

    _save(count) {
        try {
            const dir = this._file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._file.replace_contents(JSON.stringify({count}, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save workspaces: ${e.message}`);
        }
    }
}
