import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';
import {Docklet} from './docklet.js';

/**
 * A docklet that can be added and removed from the launcher's Applets
 * page. Each applet has a settings object that DockManager persists;
 * right-click or Ctrl+click opens a menu with the applet's settings
 * (from `buildMenu()`) and a Remove item. Plain clicks go to
 * `activate()`.
 */
export const Applet = GObject.registerClass({
    Signals: {
        'settings-changed': {},
        'remove-requested': {},
        'claims-changed': {},
    },
}, class Applet extends Docklet {
    /**
     * @param {string} appletId
     * @param {object} settings - saved settings, merged over `defaults`
     * @param {object} params - St.Button params
     */
    _init(appletId, settings = {}, params = {}) {
        super._init({
            ...params,
            style_class: `docklet applet-docklet ${params.style_class ?? ''}`,
        });
        this._appletId = appletId;
        this.settings = {...this.defaults, ...settings};

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = null;

        this.connect('clicked', (_a, button) => {
            const event = Clutter.get_current_event();
            const ctrl = event &&
                (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            if (button === Clutter.BUTTON_SECONDARY || ctrl)
                this.openMenu();
            else
                this.activate(button);
        });
        this.connect('popup-menu', () => this.openMenu());
        this.connect('destroy', () => this._menu?.destroy());
    }

    get id() {
        return this._appletId;
    }

    /**
     * Desktop ids of apps this applet stands in for. The dock gives them
     * no tile of their own while they run (unless they're pinned); emit
     * 'claims-changed' when the list changes.
     *
     * @returns {string[]}
     */
    get claimedAppIds() {
        return [];
    }

    /** Default settings; subclasses override. */
    get defaults() {
        return {};
    }

    /** Called with the button after a plain (non-menu) click. */
    activate(_button) {
    }

    /** Add the applet's settings items to `menu`. */
    buildMenu(_menu) {
    }

    /** Called after a setting changed; default repaints via tick(). */
    settingsChanged(_key) {
        this.tick();
    }

    setSetting(key, value) {
        if (this.settings[key] === value)
            return;
        this.settings[key] = value;
        this.settingsChanged(key);
        this.emit('settings-changed');
    }

    /** Radio group: a titled separator followed by one item per choice. */
    addChoice(menu, title, key, choices) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
        for (const [value, label] of choices) {
            const item = menu.addAction(label, () => this.setSetting(key, value));
            item.setOrnament(this.settings[key] === value
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
    }

    addToggle(menu, label, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, !!this.settings[key]);
        item.connect('toggled', (_i, state) => this.setSetting(key, state));
        menu.addMenuItem(item);
    }

    /** Menu item that launches the first installed app of `desktopIds`. */
    addAppAction(menu, label, ...desktopIds) {
        const app = findApp(...desktopIds);
        if (app)
            menu.addAction(label, () => app.activate());
    }

    openMenu() {
        this.openPopup(menu => {
            this.buildMenu(menu);
            if (!menu.isEmpty())
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(_('Remove'), () => this.emit('remove-requested'));
        });
    }

    /**
     * Open a popup menu beside the tile, filled by `build(menu)`. The
     * settings menu uses it too, so only one of them is open at a time.
     *
     * @param {function(PopupMenu.PopupMenu): void} build
     * @returns {PopupMenu.PopupMenu}
     */
    openPopup(build) {
        // Recreate when the tile moved to another edge so the arrow
        // points the right way.
        if (this._menu && this._menuSide !== this.menuSide) {
            this._menu.destroy();
            this._menu = null;
        }
        if (!this._menu) {
            this._menuSide = this.menuSide;
            this._menu = new PopupMenu.PopupMenu(this, 0.5, this._menuSide);
            this._menu.actor.hide();
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }

        this._menu.removeAll();
        build(this._menu);
        this._menu.open();
        return this._menu;
    }
});

/**
 * @param {...string} desktopIds
 * @returns {Shell.App|null} the first of `desktopIds` that is installed
 */
export function findApp(...desktopIds) {
    const appSys = Shell.AppSystem.get_default();
    for (const id of desktopIds) {
        const app = appSys.lookup_app(id);
        if (app)
            return app;
    }
    return null;
}
