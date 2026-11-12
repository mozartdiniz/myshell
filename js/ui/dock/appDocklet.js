import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';
import {AppMenu} from '../appMenu.js';
import {Docklet} from './docklet.js';

const ICON_SIZE = 48;

export const AppDocklet = GObject.registerClass(
class AppDocklet extends Docklet {
    _init(app, params = {}) {
        super._init({
            style_class: 'docklet app-docklet',
            accessible_name: app.get_name(),
            ...params,
        });
        this.app = app;

        this._box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.set_child(this._box);

        this._icon = app.create_icon_texture(ICON_SIZE);
        this._icon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);

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

        if (this.app.state === Shell.AppState.STOPPED || openNew)
            this._animateLaunch();

        if (openNew) {
            this.app.open_new_window(-1);
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
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }
        this._menu.open();
    }
});
