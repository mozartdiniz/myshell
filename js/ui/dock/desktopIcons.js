import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Config from '../../misc/config.js';
import * as Main from '../main.js';
import {NameDialog} from './nameDialog.js';

const APP_ID = 'org.tessera.Desktop';
const APP_PATH = '/org/tessera/Desktop';
const APP_SCRIPT = GLib.build_filenamev([Config.PKGDATADIR, 'desktop', 'main.js']);

/** It's started again after it stops, unless it keeps stopping */
const RESTART_DELAY = 1000;
const MAX_QUICK_EXITS = 5;
const QUICK_EXIT_TIME = 30 * GLib.USEC_PER_SEC;

const DesktopIface = `<node>
  <interface name="org.tessera.Shell.Desktop">
    <method name="PopupMenu">
      <arg type="s" direction="in" name="menu"/>
    </method>
  </interface>
</node>`;

/**
 * The files in the Desktop folder (XDG_DESKTOP_DIR), shown as icons on
 * the primary monitor's desktop. WindowMaker itself never did this: its
 * desktop holds only appicons, and file icons came from other programs.
 *
 * The icons are an app of their own (js/desktop/), which can drag files
 * to and from other apps as the shell can't. It runs as a trusted
 * Wayland client, so its window, and only its, becomes the desktop:
 * under every window, on every workspace, filling the work area so it
 * stays clear of the docks. A click on the empty desktop comes back here
 * over D-Bus for the root menu or the window list.
 *
 * Whether the icons show lives in $XDG_CONFIG_HOME/tessera/desktop.json;
 * the app keeps where they are in desktop-icons.json.
 */
export class DesktopIcons {
    constructor() {
        this._configFile = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'tessera', 'desktop.json']));
        this._show = this._load().show;

        const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        // Without a Desktop folder of its own, XDG puts the desktop in
        // home, whose files would bury the desktop
        this._dir = path && path !== GLib.get_home_dir()
            ? Gio.File.new_for_path(path) : null;

        this._client = null;
        this._window = null;
        this._exits = [];
        this._restartId = 0;

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DesktopIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/tessera/Shell/Desktop');

        global.display.connect('window-created', (_d, window) => this._onWindowCreated(window));
        global.display.connect('workareas-changed', () => this._place());
        Main.layoutManager.connect('monitors-changed', () => this._place());

        if (this._show)
            this._launch();
    }

    get shown() {
        return this._show;
    }

    set shown(show) {
        if (this._show === show)
            return;
        this._show = show;
        this._save();
        if (show)
            this._launch();
        else
            this._stop();
    }

    get folder() {
        return this._dir;
    }

    /** Line the icons up again, forgetting where they were moved. */
    arrange() {
        this._action('arrange');
    }

    /** Paste the files on the clipboard at x, y on the stage. */
    paste(x, y) {
        this._action('paste', new GLib.Variant('(ii)', this._toWindow(x, y)));
    }

    /** Ask for a name and make a folder at x, y on the stage. */
    newFolder(x, y) {
        new NameDialog({
            title: _('New Folder'),
            description: _('A folder on the desktop.'),
            name: _('New Folder'),
            action: _('Create'),
        }, name => this._action('new-folder',
            new GLib.Variant('(sii)', [name, ...this._toWindow(x, y)]))).open();
    }

    openFolder() {
        if (!this._dir)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(this._dir.get_uri(),
                global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError(_('Failed to open the Desktop folder'), e.message);
        }
    }

    // ---- D-Bus, from the app ------------------------------------------------

    PopupMenu(menu) {
        const [x, y] = global.get_pointer();
        if (menu === 'windows')
            Main.rootMenu?.popupWindowList(x, y);
        else
            Main.rootMenu?.popup(x, y);
    }

    // ---- the app ------------------------------------------------------------

    _launch() {
        if (this._client || !this._dir)
            return;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        let client;
        try {
            client = Meta.WaylandClient.new_subprocess(global.context, launcher,
                ['gjs', '-m', APP_SCRIPT]);
        } catch (e) {
            console.warn(`Failed to start the desktop icons: ${e.message}`);
            return;
        }
        this._client = client;
        client.get_subprocess().wait_async(null, (subprocess, res) => {
            try {
                subprocess.wait_finish(res);
            } catch {}
            if (this._client !== client)
                return;
            this._client = null;
            this._window = null;
            this._onExited();
        });
    }

    _onExited() {
        if (!this._show)
            return;
        const now = GLib.get_monotonic_time();
        this._exits = [...this._exits.filter(t => now - t < QUICK_EXIT_TIME), now];
        if (this._exits.length >= MAX_QUICK_EXITS) {
            console.warn('The desktop icons keep stopping; not starting them again');
            return;
        }
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY, () => {
            this._restartId = 0;
            this._launch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
        const client = this._client;
        this._client = null;
        this._window = null;
        client?.get_subprocess().send_signal(15);
    }

    _onWindowCreated(window) {
        // Its menus and popovers are windows of their own
        if (!this._client?.owns_window(window) ||
            window.get_window_type() !== Meta.WindowType.NORMAL ||
            window.get_transient_for())
            return;
        this._window = window;
        window.set_type(Meta.WindowType.DESKTOP);
        window.stick();
        window.connect('unmanaged', () => {
            if (this._window === window)
                this._window = null;
        });
        // Placed once it has shown, as resizing it before its first
        // frame races with how it starts
        const actor = window.get_compositor_private();
        const id = actor?.connect('first-frame', () => {
            actor.disconnect(id);
            this._place();
        });
    }

    /** Fit the desktop to the primary monitor's work area. */
    _place() {
        const window = this._window;
        if (!window)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        window.move_resize_frame(false, area.x, area.y, area.width, area.height);
    }

    /** @returns {[number, number]} x, y on the stage in the window's coordinates */
    _toWindow(x, y) {
        const rect = this._window?.get_frame_rect();
        return rect ? [Math.round(x - rect.x), Math.round(y - rect.y)] : [x, y];
    }

    /**
     * Activate one of the app's actions.
     *
     * @param {string} name
     * @param {GLib.Variant} [param]
     */
    _action(name, param) {
        Gio.DBus.session.call(APP_ID, APP_PATH,
            'org.freedesktop.Application', 'ActivateAction',
            new GLib.Variant('(sava{sv})', [name, param ? [param] : [], {}]),
            null, Gio.DBusCallFlags.NONE, -1, null)
            .catch(e => console.warn(`Desktop icons: failed to ${name}: ${e.message}`));
    }

    // ---- config ---------------------------------------------------------------

    _load() {
        const config = {show: true};
        try {
            const [, bytes] = this._configFile.load_contents(null);
            const {show} = JSON.parse(new TextDecoder().decode(bytes));
            if (typeof show === 'boolean')
                config.show = show;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load desktop.json: ${e.message}`);
        }
        return config;
    }

    _save() {
        try {
            const dir = this._configFile.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._configFile.replace_contents(JSON.stringify({show: this._show}, null, 2),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save desktop.json: ${e.message}`);
        }
    }
}
