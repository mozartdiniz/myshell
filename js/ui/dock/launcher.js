import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from '../../misc/animationUtils.js';
import * as Main from '../main.js';
import * as ModalDialog from '../modalDialog.js';
import * as Search from '../search.js';
import * as ShellEntry from '../shellEntry.js';
import {getTermsForSearchString} from '../searchController.js';
import {APPLETS} from './applets.js';

const APP_ICON_SIZE = 48;

/** One entry in the launcher's all-apps grid. */
const LauncherAppTile = GObject.registerClass(
class LauncherAppTile extends St.Button {
    _init(app) {
        super._init({
            style_class: 'launcher-app',
            accessible_name: app.get_name(),
            can_focus: true,
            track_hover: true,
        });
        this.app = app;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(app.create_icon_texture(APP_ICON_SIZE));
        const label = new St.Label({
            style_class: 'launcher-app-label',
            text: app.get_name(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        this.set_child(box);
    }
});

/**
 * Row in the Applets page; click adds or removes the applet, or adds
 * another instance of a `multiple` one.
 */
const LauncherAppletRow = GObject.registerClass(
class LauncherAppletRow extends St.Button {
    _init(info) {
        super._init({
            style_class: 'launcher-applet',
            accessible_name: info.name,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        this.info = info;

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({
            style_class: 'launcher-applet-icon',
            icon_name: info.icon,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({
            style_class: 'launcher-applet-name',
            text: info.name,
        }));
        text.add_child(new St.Label({
            style_class: 'launcher-applet-description',
            text: info.description,
        }));
        box.add_child(text);

        if (info.multiple) {
            this._count = new St.Label({
                style_class: 'launcher-applet-count',
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(this._count);
        }
        this._check = new St.Icon({
            style_class: 'launcher-applet-check',
            icon_name: info.multiple ? 'list-add-symbolic' : 'object-select-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._check);
        this.set_child(box);
        this.sync();
    }

    sync() {
        if (this.info.multiple) {
            const count = Main.dock.appletCount(this.info.id);
            const shown = ngettext('%d shown', '%d shown', count).format(count);
            this._count.text = count ? shown : '';
            this.accessible_name = count
                ? `${this.info.name}, ${shown}` : this.info.name;
            return;
        }

        const enabled = Main.dock.isAppletEnabled(this.info.id);
        this._check.opacity = enabled ? 255 : 0;
        if (enabled)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
        this.accessible_name = enabled
            ? _('%s, shown').format(this.info.name)
            : this.info.name;
    }
});

/**
 * Global search + app launcher. Opened with the overlay key (Super).
 * With an empty entry it shows a page of every installed app, or the
 * Applets page where dock applets are added and removed. Typing
 * switches to the overview's SearchResultsView and all search providers.
 */
export class Launcher extends ModalDialog.ModalDialog {
    static {
        GObject.registerClass(this);

        const bindingPool = this.get_binding_pool();
        bindingPool.install_closure(
            'close', Clutter.KEY_Escape, Clutter.RELEASE_MASK,
            obj => {
                if (obj._entry.get_text() !== '')
                    obj._entry.set_text('');
                else
                    obj.close();
                return Clutter.EVENT_STOP;
            });
    }

    _init() {
        super._init({
            styleClass: 'launcher-dialog',
            destroyOnClose: false,
            shouldFadeIn: false,
            shouldFadeOut: false,
            actionMode: Shell.ActionMode.OVERVIEW,
        });

        this._entry = new St.Entry({
            style_class: 'launcher-entry search-entry',
            hint_text: _('Search apps, files, settings…'),
            track_hover: true,
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.set_primary_icon(new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-find-symbolic',
        }));
        this.contentLayout.add_child(this._entry);

        this._text = this._entry.clutter_text;
        this._text.connect('text-changed', () => this._onTextChanged());
        this._text.connect('activate', () => this._results.activateDefault());
        this._text.connect('key-focus-in', () => this._results.highlightDefault(true));
        this._text.connect('key-focus-out', () => this._results.highlightDefault(false));
        this._entry.connect('popup-menu', () => {
            if (this._entry.get_text() === '')
                return;
            this._entry.menu.close();
            this._results.popupMenuDefault();
        });

        const keyController = new Clutter.KeyController();
        keyController.connect('key-press', () => this._onEntryKeyPress(keyController));
        this._entry.add_action_full(
            'launcher-key-nav', Clutter.EventPhase.CAPTURE, keyController);

        this._tabs = new St.BoxLayout({
            style_class: 'launcher-tabs',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._tabButtons = new Map();
        for (const [page, label] of [['apps', _('Applications')], ['applets', _('Applets')]]) {
            const button = new St.Button({
                style_class: 'launcher-tab',
                label,
                can_focus: true,
                track_hover: true,
            });
            button.connect('clicked', () => this._setPage(page));
            this._tabButtons.set(page, button);
            this._tabs.add_child(button);
        }
        this.contentLayout.add_child(this._tabs);

        this._scroll = new St.ScrollView({
            style_class: 'launcher-results',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._results = new Search.SearchResultsView();
        this._scroll.set_child(this._results);
        this.contentLayout.add_child(this._scroll);

        this._appGrid = new St.Viewport({
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                homogeneous: true,
            }),
            style_class: 'launcher-app-grid',
            x_expand: true,
        });
        this._appScroll = new St.ScrollView({
            style_class: 'launcher-apps',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._appGrid,
        });
        this.contentLayout.add_child(this._appScroll);

        this._appletList = new St.BoxLayout({
            style_class: 'launcher-applet-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._appletScroll = new St.ScrollView({
            style_class: 'launcher-apps',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._appletList,
        });
        this.contentLayout.add_child(this._appletScroll);
        for (const info of APPLETS) {
            const row = new LauncherAppletRow(info);
            row.connect('clicked', () => {
                if (info.multiple)
                    Main.dock.addAppletInstance(info.id);
                else
                    Main.dock.setAppletEnabled(info.id, !Main.dock.isAppletEnabled(info.id));
            });
            row.connect('key-focus-in',
                () => ensureActorVisibleInScrollView(this._appletScroll, row));
            this._appletList.add_child(row);
        }
        Main.dock.connectObject('applets-changed',
            () => this._appletList.get_children().forEach(r => r.sync()), this);

        this._page = 'apps';
        this._appsDirty = true;
        Shell.AppSystem.get_default().connectObject('installed-changed',
            () => (this._appsDirty = true), this);

        global.focus_manager.add_group(this._results);
        global.focus_manager.add_group(this._appGrid);
        global.focus_manager.add_group(this._appletList);
        this.setInitialKeyFocus(this._entry);
    }

    _rebuildApps() {
        if (!this._appsDirty)
            return;
        this._appsDirty = false;
        this._appGrid.destroy_all_children();

        const appSys = Shell.AppSystem.get_default();
        const apps = appSys.get_installed()
            .filter(info => info.should_show())
            .map(info => appSys.lookup_app(info.get_id()))
            .filter(app => app)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        for (const app of apps) {
            const tile = new LauncherAppTile(app);
            tile.connect('clicked', () => {
                this.close();
                app.activate();
            });
            tile.connect('key-focus-in',
                () => ensureActorVisibleInScrollView(this._appScroll, tile));
            this._appGrid.add_child(tile);
        }
    }

    _setPage(page) {
        this._page = page;
        this._syncVisibility();
    }

    get _pageView() {
        return this._page === 'applets' ? this._appletList : this._appGrid;
    }

    _syncVisibility() {
        const searching = this._entry.get_text().trim() !== '';
        this._scroll.visible = searching;
        this._tabs.visible = !searching;
        this._appScroll.visible = !searching && this._page === 'apps';
        this._appletScroll.visible = !searching && this._page === 'applets';
        for (const [page, button] of this._tabButtons) {
            if (page === this._page)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
    }

    _onTextChanged() {
        const terms = getTermsForSearchString(this._entry.get_text());
        this._results.setTerms(terms);
        this._syncVisibility();
    }

    _onEntryKeyPress(controller) {
        const [, symbol] = controller.get_key();
        if (this._entry.get_text() === '') {
            if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_Down) {
                this._pageView.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_Down) {
            this._results.navigateFocus(St.DirectionType.DOWN);
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_ISO_Left_Tab) {
            this._results.navigateFocus(St.DirectionType.TAB_BACKWARD);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    toggle() {
        if (this.state === ModalDialog.State.OPENED ||
            this.state === ModalDialog.State.OPENING)
            this.close();
        else
            this.open();
    }

    open() {
        this._rebuildApps();
        this._entry.set_text('');
        this._page = 'apps';
        this._syncVisibility();
        this._appScroll.vadjustment.value = 0;
        if (!super.open())
            return false;
        this._entry.grab_key_focus();
        return true;
    }
}
