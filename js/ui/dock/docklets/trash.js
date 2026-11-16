import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from '../../main.js';
import {Applet} from '../applet.js';

const TRASH_URI = 'trash:///';
const COUNT_ATTR = 'trash::item-count';

export const TrashDocklet = GObject.registerClass(
class TrashDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._icon = new St.Icon({
            icon_size: 48,
            icon_name: 'user-trash',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // BinLayout only honors child alignment for expanding children
        this._count = new St.Label({
            style_class: 'applet-badge',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        box.add_child(this._icon);
        box.add_child(this._count);
        this.set_child(box);

        this._items = 0;
        this._cancellable = new Gio.Cancellable();
        this._trash = Gio.File.new_for_uri(TRASH_URI);
        try {
            this._monitor = this._trash.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connectObject('changed', () => this.tick(), this);
        } catch (e) {
            console.warn(`Trash applet: ${e.message}`);
        }
        this.connect('destroy', () => {
            this._cancellable.cancel();
            this._monitor?.cancel();
        });
        this.tick();
    }

    get defaults() {
        return {count: true};
    }

    get acceptsFiles() {
        return true;
    }

    /** Files dropped on the Trash go to it. */
    dropFiles(uris) {
        for (const uri of uris) {
            Gio.File.new_for_uri(uri).trash_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    file.trash_finish(res);
                } catch (e) {
                    Main.notifyError(_('Failed to move “%s” to the Trash')
                        .format(file.get_basename()), e.message);
                }
            });
        }
    }

    buildMenu(menu) {
        menu.addAction(_('Open Trash'), () => this.activate());
        const empty = menu.addAction(_('Empty Trash…'), () => this._emptyTrash());
        empty.setSensitive(this._items > 0);
        this.addToggle(menu, _('Show Item Count'), 'count');
    }

    activate() {
        try {
            Gio.AppInfo.launch_default_for_uri(TRASH_URI,
                global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`Trash applet: ${e.message}`);
        }
    }

    _emptyTrash() {
        // Nautilus asks for confirmation itself
        Gio.DBus.session.call(
            'org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
            'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    console.warn(`Failed to empty trash: ${e.message}`);
                }
            });
    }

    settingsChanged() {
        this._sync();
    }

    tick() {
        this._trash.query_info_async(COUNT_ATTR, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, res) => {
                try {
                    this._items = file.query_info_finish(res).get_attribute_uint32(COUNT_ATTR);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._items = 0;
                }
                this._sync();
            });
    }

    _sync() {
        this._icon.icon_name = this._items > 0 ? 'user-trash-full' : 'user-trash';
        this._count.text = String(this._items);
        this._count.visible = this.settings.count && this._items > 0;
    }
});
