import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as CheckBox from '../checkBox.js';
import * as Dialog from '../dialog.js';
import * as Main from '../main.js';
import * as ModalDialog from '../modalDialog.js';
import * as ShellEntry from '../shellEntry.js';
import {chooseFile} from './portal.js';

/**
 * Settings of a pinned app's tile, like WindowMaker's "Docked
 * Application Settings": a command to run instead of the app's own,
 * a custom icon, and whether to start the app at login. Empty fields
 * mean the app's defaults.
 */
export const AppTileDialog = GObject.registerClass(
class AppTileDialog extends ModalDialog.ModalDialog {
    /**
     * @param {Shell.App} app
     * @param {{command?: string, icon?: string, autolaunch?: boolean}} settings
     * @param {function(object): void} onSave - called with the new settings
     */
    _init(app, settings, onSave) {
        // Stays alive while hidden for the file chooser
        super._init({styleClass: 'app-tile-dialog', destroyOnClose: false});
        this._onSave = onSave;
        this._done = false;
        this.connect('closed', () => {
            if (this._done)
                this.destroy();
        });

        const content = new Dialog.MessageDialogContent({
            title: _('%s Tile').format(app.get_name()),
            description: _('Leave a field empty to use the app’s own.'),
        });
        this.contentLayout.add_child(content);

        const appInfo = app.get_app_info();
        this._command = this._addEntry(content, _('Command'),
            settings.command, appInfo?.get_commandline() ?? '');
        content.add_child(new St.Label({
            style_class: 'app-tile-dialog-hint',
            text: _('Files dropped on the tile go where %F or %U is, or at the end.'),
        }));

        const iconRow = new St.BoxLayout({style_class: 'app-tile-dialog-row'});
        this._icon = this._addEntry(iconRow, _('Icon'),
            settings.icon, appInfo?.get_icon()?.to_string() ?? '');
        const chooseButton = new St.Button({
            style_class: 'button app-tile-dialog-choose',
            label: _('Choose…'),
            y_align: Clutter.ActorAlign.END,
        });
        chooseButton.connect('clicked', () => this._chooseIcon());
        iconRow.add_child(chooseButton);
        content.add_child(iconRow);

        this._autolaunch = new CheckBox.CheckBox(_('Start when I log in'));
        this._autolaunch.checked = !!settings.autolaunch;
        content.add_child(this._autolaunch);

        this.setButtons([{
            label: _('Cancel'),
            action: () => this._finish(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Save'),
            action: () => {
                this._onSave({
                    command: this._command.text.trim(),
                    icon: this._icon.text.trim(),
                    autolaunch: this._autolaunch.checked,
                });
                this._finish();
            },
            default: true,
        }]);
        this.setInitialKeyFocus(this._command);
    }

    _addEntry(parent, label, text, placeholder) {
        const box = new St.BoxLayout({
            style_class: 'app-tile-dialog-field',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const labelActor = new St.Label({
            style_class: 'app-tile-dialog-label',
            text: label,
        });
        box.add_child(labelActor);
        const entry = new St.Entry({
            style_class: 'app-tile-dialog-entry',
            text: text ?? '',
            hint_text: placeholder,
            can_focus: true,
            x_expand: true,
        });
        entry.label_actor = labelActor;
        ShellEntry.addContextMenu(entry);
        box.add_child(entry);
        parent.add_child(box);
        return entry;
    }

    _finish() {
        this._done = true;
        this.close();
    }

    async _chooseIcon() {
        // The chooser is a client window, which can't get input while
        // the dialog holds its grab
        await new Promise(resolve => {
            const id = this.connect('closed', () => {
                this.disconnect(id);
                resolve();
            });
            this.close();
        });
        try {
            const uri = await chooseFile(_('Choose Icon'), {
                filters: [[_('Images'), ['image/*']]],
            });
            if (uri)
                this._icon.text = Gio.File.new_for_uri(uri).get_path() ?? uri;
        } catch (e) {
            Main.notifyError(_('Failed to open the file chooser'), e.message);
        }
        this.open();
    }
});
