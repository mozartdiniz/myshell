import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../main.js';
import * as ModalDialog from '../modalDialog.js';
import * as Search from '../search.js';
import * as ShellEntry from '../shellEntry.js';
import {getTermsForSearchString} from '../searchController.js';

/**
 * Global search + app launcher. Opened with the overlay key (Super).
 * Reuses the overview's SearchResultsView and all search providers.
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

        global.focus_manager.add_group(this._results);
        this.setInitialKeyFocus(this._entry);
    }

    _onTextChanged() {
        const terms = getTermsForSearchString(this._entry.get_text());
        this._results.setTerms(terms);
        this._scroll.visible = terms.length > 0;
    }

    _onEntryKeyPress(controller) {
        const [, symbol] = controller.get_key();
        if (this._entry.get_text() === '')
            return Clutter.EVENT_PROPAGATE;

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
        this._entry.set_text('');
        this._scroll.hide();
        if (!super.open())
            return false;
        this._entry.grab_key_focus();
        return true;
    }
}
