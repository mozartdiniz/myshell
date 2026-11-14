import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Dialog from '../dialog.js';
import * as ModalDialog from '../modalDialog.js';
import * as ShellEntry from '../shellEntry.js';

/**
 * A dialog asking for a name, such as a workspace's.
 */
export const NameDialog = GObject.registerClass(
class NameDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} params
     * @param {string} params.title
     * @param {string} params.description
     * @param {string} params.name - the text the entry starts with
     * @param {string} params.action - label of the button that accepts
     * @param {boolean} [params.allowEmpty] - whether an empty name is OK
     * @param {function(string): void} onDone - called with the name
     */
    _init(params, onDone) {
        super._init({styleClass: 'name-dialog'});

        const content = new Dialog.MessageDialogContent({
            title: params.title,
            description: params.description,
        });
        this.contentLayout.add_child(content);

        const entry = new St.Entry({
            text: params.name,
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(entry);
        content.add_child(entry);

        const done = () => {
            const name = entry.text.trim();
            if (!name && !params.allowEmpty)
                return;
            onDone(name);
            this.close();
        };
        entry.clutter_text.connect('activate', done);
        this.setButtons([{
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }, {
            label: params.action,
            action: done,
            default: true,
        }]);
        this.setInitialKeyFocus(entry);
        entry.clutter_text.set_selection(0, -1);
    }
});

/** Ask for a new name for workspace `index`. */
export function renameWorkspace(index) {
    new NameDialog({
        title: _('Rename Workspace'),
        description: _('Leave it empty for the default name.'),
        name: Meta.prefs_get_workspace_name(index),
        action: _('Rename'),
        allowEmpty: true,
    }, name => Meta.prefs_change_workspace_name(index, name)).open();
}
