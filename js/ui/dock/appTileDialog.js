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
 * @param {string} icon - icon name, or path or URI of an image
 * @returns {Gio.Icon}
 */
export function iconFromString(icon) {
    if (icon.startsWith('/'))
        return new Gio.FileIcon({file: Gio.File.new_for_path(icon)});
    if (icon.includes('://'))
        return new Gio.FileIcon({file: Gio.File.new_for_uri(icon)});
    return new Gio.ThemedIcon({name: icon});
}

/**
 * @param {Gio.Icon|null} gicon
 * @returns {string} how the icon field shows `gicon`
 */
function iconToString(gicon) {
    if (gicon instanceof Gio.ThemedIcon)
        return gicon.get_names()[0] ?? '';
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path() ?? gicon.get_file().get_uri();
    return gicon?.to_string() ?? '';
}

/**
 * Base of the tile dialogs: labeled entries, and an icon field whose
 * Choose… button picks an image file.
 */
const TileDialog = GObject.registerClass(
class TileDialog extends ModalDialog.ModalDialog {
    _init() {
        // Stays alive while hidden for the file chooser
        super._init({styleClass: 'app-tile-dialog', destroyOnClose: false});
        this._done = false;
        this.connect('closed', () => {
            if (this._done)
                this.destroy();
        });
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

    /**
     * @param {St.Widget} parent
     * @param {string} [icon] - the current custom icon
     * @param {Gio.Icon|null} defaultIcon - shown while the field is empty
     */
    _addIconField(parent, icon, defaultIcon) {
        const iconRow = new St.BoxLayout({style_class: 'app-tile-dialog-row'});
        this._icon = this._addEntry(iconRow, _('Icon'), icon, iconToString(defaultIcon));
        const chooseButton = new St.Button({
            style_class: 'button app-tile-dialog-choose',
            label: _('Choose…'),
            y_align: Clutter.ActorAlign.END,
        });
        chooseButton.connect('clicked', () => this._chooseIcon());
        iconRow.add_child(chooseButton);
        parent.add_child(iconRow);
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

/**
 * Settings of a pinned app's tile, like WindowMaker's "Docked
 * Application Settings": a command to run instead of the app's own,
 * a custom icon, and whether to start the app at login. Empty fields
 * mean the app's defaults.
 */
export const AppTileDialog = GObject.registerClass(
class AppTileDialog extends TileDialog {
    /**
     * @param {Shell.App} app
     * @param {{command?: string, icon?: string, autolaunch?: boolean}} settings
     * @param {function(object): void} onSave - called with the new settings
     */
    _init(app, settings, onSave) {
        super._init();
        this._onSave = onSave;

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

        this._addIconField(content, settings.icon, appInfo?.get_icon() ?? null);

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
});

/**
 * Asks for the icon of an applet's tile: an icon name or an image
 * file. Empty means the applet's own icon.
 */
export const AppletIconDialog = GObject.registerClass(
class AppletIconDialog extends TileDialog {
    /**
     * @param {string} name - the applet's name
     * @param {string} icon - the current custom icon, or ''
     * @param {Gio.Icon|null} defaultIcon - the applet's own icon
     * @param {function(string): void} onSave - called with the new icon
     */
    _init(name, icon, defaultIcon, onSave) {
        super._init();

        const content = new Dialog.MessageDialogContent({
            title: name ? _('%s Icon').format(name) : _('Applet Icon'),
            description: _('An icon name or an image. Leave it empty to use the applet’s own.'),
        });
        this.contentLayout.add_child(content);
        this._addIconField(content, icon, defaultIcon);

        const save = () => {
            onSave(this._icon.text.trim());
            this._finish();
        };
        this._icon.clutter_text.connect('activate', save);
        this.setButtons([{
            label: _('Cancel'),
            action: () => this._finish(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Save'),
            action: save,
            default: true,
        }]);
        this.setInitialKeyFocus(this._icon);
    }
});
