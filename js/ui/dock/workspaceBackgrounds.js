import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from '../../misc/signals.js';
import {chooseFile} from './portal.js';

/**
 * A wallpaper of its own for each workspace, as WindowMaker's
 * WorkspaceSpecificBack: a workspace without one shows the desktop's
 * wallpaper. The desktop's BackgroundManagers (background.js) ask
 * `fileFor()` which image to show. The images, by workspace index,
 * live in $XDG_CONFIG_HOME/tessera/wallpapers.json.
 *
 * Emits 'changed' with the index of the workspace whose wallpaper
 * changed.
 */
export class WorkspaceBackgrounds extends Signals.EventEmitter {
    constructor() {
        super();
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'tessera', 'wallpapers.json']));
        /** @type {(string|null)[]} URIs by workspace index */
        this._uris = this._load();

        global.workspace_manager.connect('notify::n-workspaces',
            () => this._onWorkspacesChanged());
    }

    /** @returns {string|null} the URI of workspace `index`'s own wallpaper */
    uriFor(index) {
        return this._uris[index] ?? null;
    }

    /**
     * @param {number} index
     * @returns {Gio.File|null} workspace `index`'s own wallpaper, if
     *   it has one that still exists
     */
    fileFor(index) {
        const uri = this.uriFor(index);
        if (!uri)
            return null;
        const file = Gio.File.new_for_uri(uri);
        return file.query_exists(null) ? file : null;
    }

    /**
     * @param {number} index
     * @param {string|null} uri - null for the desktop's wallpaper
     */
    set(index, uri) {
        if (this.uriFor(index) === (uri || null))
            return;
        this._uris[index] = uri || null;
        while (this._uris.length && !this._uris.at(-1))
            this._uris.pop();
        this._save();
        this.emit('changed', index);
    }

    /** Ask for an image to be workspace `index`'s wallpaper. */
    async choose(index) {
        const current = this.fileFor(index)?.get_parent()?.get_path() ??
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        try {
            const uri = await chooseFile(_('Workspace Wallpaper'), {
                currentFolder: current,
                filters: [[_('Images'), ['image/*']]],
            });
            if (uri)
                this.set(index, uri);
        } catch (e) {
            console.warn(`Failed to choose a wallpaper: ${e.message}`);
        }
    }

    /** A removed workspace's wallpaper doesn't come back with a new one. */
    _onWorkspacesChanged() {
        const n = global.workspace_manager.n_workspaces;
        if (this._uris.length <= n)
            return;
        const removed = this._uris.splice(n).some(uri => uri);
        if (removed)
            this._save();
    }

    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const {wallpapers} = JSON.parse(new TextDecoder().decode(bytes));
            return Array.isArray(wallpapers)
                ? wallpapers.map(uri => typeof uri === 'string' && uri ? uri : null)
                : [];
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load wallpapers.json: ${e.message}`);
            return [];
        }
    }

    _save() {
        try {
            const dir = this._file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._file.replace_contents(
                JSON.stringify({wallpapers: this._uris}, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save wallpapers.json: ${e.message}`);
        }
    }
}
