import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from '../../main.js';
import {Applet} from '../applet.js';
import {FolderFan} from '../folderFan.js';
import {chooseFile} from '../portal.js';

const PLACES = [
    GLib.UserDirectory.DIRECTORY_DESKTOP,
    GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    GLib.UserDirectory.DIRECTORY_MUSIC,
    GLib.UserDirectory.DIRECTORY_PICTURES,
    GLib.UserDirectory.DIRECTORY_VIDEOS,
];
const QUERY_ATTRS = 'standard::display-name,standard::icon';
const TOOLTIP_GAP = 6;
const TOOLTIP_FADE_TIME = 100;

/**
 * A folder shortcut: click fans out its newest items (or opens it in
 * the file manager, as set in the menu); middle-click always opens it.
 * Holding the tile shows the full path; the menu picks another folder.
 * Several can be added, each with its own folder.
 */
export const FolderDocklet = GObject.registerClass(
class FolderDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            icon_size: 36,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._name = new St.Label({
            style_class: 'applet-small applet-folder-name',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._icon);
        box.add_child(this._name);
        this.set_child(box);

        this._tooltip = null;
        // Recognizing cancels the click, so holding doesn't open the
        // folder; the tile can still be dragged afterwards.
        const hold = new Clutter.LongPressGesture({
            required_button: Clutter.BUTTON_PRIMARY,
        });
        hold.can_not_cancel(this._panGesture);
        hold.connect('recognize', () => this._showPath());
        hold.connect('end', () => this._hidePath());
        hold.connect('cancel', () => this._hidePath());
        this.add_action(hold);
        this.connect('drag-begin', () => {
            this._hidePath();
            this._fan.close();
        });
        this._fan = new FolderFan(this);

        this._cancellable = null;
        this._missing = false;
        this.connect('destroy', () => {
            this._cancellable?.cancel();
            this._tooltip?.destroy();
            this._fan.destroy();
        });
        this._sync();
    }

    get defaults() {
        return {path: GLib.get_home_dir(), click: 'fan'};
    }

    get _file() {
        return Gio.File.new_for_path(this.settings.path);
    }

    activate(button) {
        if (this.settings.click === 'fan' && button !== Clutter.BUTTON_MIDDLE &&
            !this._missing)
            this._fan.toggle(this._file, () => this._openFolder());
        else
            this._openFolder();
    }

    _openFolder() {
        if (this._missing) {
            Main.notifyError(_('Folder not found'), this.settings.path);
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(this._file.get_uri(),
                global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError(_('Failed to open folder'), e.message);
        }
    }

    buildMenu(menu) {
        menu.addAction(_('Open'), () => this._openFolder());
        menu.addAction(_('Choose Folder…'), () => this._chooseFolder());
        this.addChoice(menu, _('Places'), 'path', this._places());
        this.addChoice(menu, _('Click'), 'click', [
            ['fan', _('Show Newest Items')],
            ['open', _('Open Folder')],
        ]);
    }

    /** Home and the XDG folders, plus the current folder if it's another one. */
    _places() {
        const home = GLib.get_home_dir();
        const places = [[home, _('Home')]];
        for (const dir of PLACES) {
            const path = GLib.get_user_special_dir(dir);
            if (path && path !== home)
                places.push([path, GLib.path_get_basename(path)]);
        }
        const {path} = this.settings;
        if (!places.some(([p]) => p === path))
            places.push([path, GLib.path_get_basename(path)]);
        return places;
    }

    async _chooseFolder() {
        try {
            const uri = await chooseFile(_('Choose Folder'), {
                directory: true,
                currentFolder: this.settings.path,
            });
            if (uri)
                this.setSetting('path', Gio.File.new_for_uri(uri).get_path());
        } catch (e) {
            Main.notifyError(_('Failed to open the folder chooser'), e.message);
        }
    }

    settingsChanged() {
        this._sync();
    }

    _sync() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();

        const file = this._file;
        const isHome = this.settings.path === GLib.get_home_dir();
        file.query_info_async(QUERY_ATTRS, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                let name = file.get_basename();
                let icon = new Gio.ThemedIcon({name: 'folder'});
                try {
                    const info = f.query_info_finish(res);
                    name = info.get_display_name();
                    icon = info.get_icon();
                    this._missing = false;
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._missing = true;
                }
                this._icon.gicon = icon;
                this._icon.opacity = this._missing ? 128 : 255;
                this._name.text = isHome ? _('Home') : name;
                this.accessible_name = this._name.text;
                if (this._tooltip)
                    this._tooltip.text = this.settings.path;
            });
    }

    _showPath() {
        if (!this._tooltip) {
            this._tooltip = new St.Label({style_class: 'docklet-tooltip'});
            // uiGroup may be destroyed before us on shutdown
            this._tooltip.connect('destroy', () => (this._tooltip = null));
            Main.uiGroup.add_child(this._tooltip);
        }
        this._tooltip.text = this.settings.path;
        this._tooltip.opacity = 0;
        this._tooltip.show();
        Main.uiGroup.set_child_above_sibling(this._tooltip, null);

        // Beside the tile, on the side facing into the screen
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        const [, , tw, th] = this._tooltip.get_preferred_size();
        let tx = x + (w - tw) / 2;
        let ty = y + (h - th) / 2;
        switch (this.menuSide) {
        case St.Side.LEFT:
            tx = x + w + TOOLTIP_GAP;
            break;
        case St.Side.RIGHT:
            tx = x - tw - TOOLTIP_GAP;
            break;
        case St.Side.TOP:
            ty = y + h + TOOLTIP_GAP;
            break;
        case St.Side.BOTTOM:
            ty = y - th - TOOLTIP_GAP;
            break;
        }
        const m = Main.layoutManager.findMonitorForActor(this) ??
            Main.layoutManager.primaryMonitor;
        tx = Math.clamp(tx, m.x, m.x + m.width - tw);
        ty = Math.clamp(ty, m.y, m.y + m.height - th);
        this._tooltip.set_position(Math.round(tx), Math.round(ty));
        this._tooltip.ease({
            opacity: 255,
            duration: TOOLTIP_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hidePath() {
        this._tooltip?.ease({
            opacity: 0,
            duration: TOOLTIP_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._tooltip?.hide(),
        });
    }
});
