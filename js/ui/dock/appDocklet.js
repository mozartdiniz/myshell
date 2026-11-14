import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from '../appFavorites.js';
import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';
import {AppMenu} from '../appMenu.js';
import {AppTileDialog} from './appTileDialog.js';
import {Docklet} from './docklet.js';

const ICON_SIZE = 48;

/**
 * Tile of a pinned or running app. Pinned apps' tiles have settings
 * (see AppTileDialog): `command` replaces the app's own launch
 * command, `icon` its icon, and `autolaunch` starts it at login.
 * DockManager persists them and listens for 'settings-changed'.
 */
export const AppDocklet = GObject.registerClass({
    Signals: {'settings-changed': {}},
}, class AppDocklet extends Docklet {
    _init(app, settings = {}, params = {}) {
        super._init({
            style_class: 'docklet app-docklet',
            accessible_name: app.get_name(),
            ...params,
        });
        this.app = app;
        this.settings = settings;

        this._box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.set_child(this._box);

        this._icon = null;
        this._updateIcon();

        this._dot = new St.Widget({
            style_class: 'docklet-running-dot',
            // BinLayout only honors child alignment for expanding children
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._box.add_child(this._dot);

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = null;

        app.connectObject(
            'notify::state', () => this._updateRunningStyle(),
            'windows-changed', () => this._updateRunningStyle(),
            this);
        this._updateRunningStyle();

        this.connect('clicked', (_a, button) => this._onClicked(button));
        this.connect('popup-menu', () => this._popupMenu());
        this.connect('destroy', () => this._menu?.destroy());
    }

    get id() {
        return `app:${this.app.get_id()}`;
    }

    /** Whether files dropped on the tile can be opened with it. */
    get acceptsFiles() {
        const appInfo = this.app.get_app_info();
        return !!this.settings.command ||
            !!appInfo && (appInfo.supports_uris() || appInfo.supports_files());
    }

    dropFiles(uris) {
        this.launch(uris);
    }

    setSettings(settings) {
        this.settings = settings;
        this._updateIcon();
        this.emit('settings-changed');
    }

    _updateIcon() {
        const {icon} = this.settings;
        const newIcon = icon
            ? new St.Icon({gicon: iconFromString(icon), icon_size: ICON_SIZE})
            : this.app.create_icon_texture(ICON_SIZE);
        newIcon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._icon)
            this._box.replace_child(this._icon, newIcon);
        else
            this._box.insert_child_at_index(newIcon, 0);
        this._icon = newIcon;
    }

    _updateRunningStyle() {
        const running = this.app.state !== Shell.AppState.STOPPED;
        this._dot.visible = running;
        if (running)
            this.add_style_pseudo_class('running');
        else
            this.remove_style_pseudo_class('running');
    }

    _onClicked(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this._popupMenu();
            return;
        }

        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const isMiddle = button === Clutter.BUTTON_MIDDLE;
        const isCtrl = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const openNew = this.app.can_open_new_window() &&
            this.app.state === Shell.AppState.RUNNING &&
            (isCtrl || isMiddle);

        if (this.app.state === Shell.AppState.STOPPED || openNew) {
            this.launch();
            return;
        }

        // Clicking the focused app hides all its windows; clicking it
        // again brings them all back where they were.
        const windows = this._windows();
        const focused = Shell.WindowTracker.get_default().focus_app === this.app;
        if (focused && windows.some(w => !w.minimized)) {
            windows.forEach(w => w.minimize());
            return;
        }

        windows.forEach(w => w.unminimize());
        this.app.activate();
    }

    /**
     * Start the app, or open another window of it, through the custom
     * command if there is one.
     *
     * @param {string[]} uris - files to open
     */
    launch(uris = []) {
        this._animateLaunch();
        launchApp(this.app, this.settings, uris);
    }

    _windows() {
        return this.app.get_windows().filter(w => !w.skip_taskbar);
    }

    _animateLaunch() {
        // WindowMaker-style bounce
        this._icon.ease({
            translation_y: -8,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._icon.ease({
                translation_y: 0,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_IN_BOUNCE,
            }),
        });
    }

    _popupMenu() {
        if (!this._menu) {
            this._menu = new AppMenu(this, this.menuSide, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);

            // Next to Pin/Unpin, which decides whether it is shown
            this._settingsItem = new PopupMenu.PopupMenuItem(_('Tile Settings…'));
            this._settingsItem.connect('activate', () => this._openSettings());
            const items = this._menu._getMenuItems();
            this._menu.addMenuItem(this._settingsItem,
                items.indexOf(this._menu._toggleFavoriteItem) + 1);
            this._clipSection = new PopupMenu.PopupMenuSection();
            this._menu.addMenuItem(this._clipSection,
                items.indexOf(this._menu._toggleFavoriteItem) + 2);

            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }
        // Only pinned tiles keep settings
        this._settingsItem.visible = !!this.app.get_app_info() &&
            AppFavorites.getAppFavorites().isFavorite(this.app.get_id());
        this._clipSection.removeAll();
        Main.dock.clip.addTileItems(this._clipSection, this);
        this._menu.open();
    }

    _openSettings() {
        const dialog = new AppTileDialog(this.app, this.settings,
            settings => this.setSettings(settings));
        dialog.open();
    }
});

/**
 * Start `app`, or open another window of it, through the tile's custom
 * command if it has one.
 *
 * @param {Shell.App} app
 * @param {{command?: string}} settings - the app tile's settings
 * @param {string[]} uris - files to open
 */
export function launchApp(app, settings, uris = []) {
    const {command} = settings;
    try {
        if (command || uris.length) {
            const appInfo = command
                ? commandAppInfo(command, app.get_name())
                : app.get_app_info();
            appInfo.launch_uris(uris, global.create_app_launch_context(0, -1));
        } else if (app.state === Shell.AppState.STOPPED) {
            app.activate();
        } else {
            app.open_new_window(-1);
        }
    } catch (e) {
        Main.notifyError(_('Failed to launch “%s”').format(app.get_name()), e.message);
    }
}

/**
 * @param {string} icon - icon name, or path or URI of an image
 * @returns {Gio.Icon}
 */
function iconFromString(icon) {
    if (icon.startsWith('/'))
        return new Gio.FileIcon({file: Gio.File.new_for_path(icon)});
    if (icon.includes('://'))
        return new Gio.FileIcon({file: Gio.File.new_for_uri(icon)});
    return new Gio.ThemedIcon({name: icon});
}

/**
 * App info that runs `command`. Like a desktop file's Exec line it may
 * use %f, %F, %u or %U for files; without them files go at the end.
 *
 * @param {string} command
 * @param {string} name
 * @returns {GioUnix.DesktopAppInfo}
 */
function commandAppInfo(command, name) {
    const keyFile = new GLib.KeyFile();
    const group = GLib.KEY_FILE_DESKTOP_GROUP;
    keyFile.set_string(group, GLib.KEY_FILE_DESKTOP_KEY_TYPE, GLib.KEY_FILE_DESKTOP_TYPE_APPLICATION);
    keyFile.set_string(group, GLib.KEY_FILE_DESKTOP_KEY_NAME, name);
    keyFile.set_string(group, GLib.KEY_FILE_DESKTOP_KEY_EXEC,
        /%[fFuU]/.test(command) ? command : `${command} %F`);
    return GioUnix.DesktopAppInfo.new_from_keyfile(keyFile);
}
