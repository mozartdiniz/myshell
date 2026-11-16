// Tessera's desktop: the files of the Desktop folder as icons on the
// wallpaper. The shell starts it as a trusted Wayland client, puts its
// one window under every other one, on all workspaces, over the primary
// monitor's work area, and starts it again if it stops. Being an app
// lets files drag in from other apps and out to them.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {programInvocationName} from 'system';

import {DesktopGrid} from './grid.js';

const APP_ID = 'org.tessera.Desktop';

const CSS = `
window.tessera-desktop,
window.tessera-desktop > contents {
  background: none;
  box-shadow: none;
}

.desktop-icon {
  padding: 4px 2px;
  border-radius: 8px;
}
.desktop-icon:hover { background-color: alpha(white, 0.1); }
.desktop-icon.selected { background-color: alpha(@accent_bg_color, 0.4); }
.desktop-icon.drop-target {
  background-color: alpha(@accent_bg_color, 0.6);
  outline: 2px solid @accent_bg_color;
  outline-offset: -2px;
}
.desktop-icon.dragged { opacity: 0.5; }

.desktop-icon-image {
  -gtk-icon-shadow: 0 2px 4px alpha(black, 0.5);
}

.desktop-icon-label {
  margin-top: 4px;
  padding: 0 3px;
  border-radius: 4px;
  font-size: 10pt;
  color: white;
  text-shadow: 0 1px 2px alpha(black, 0.9);
}
.desktop-icon.selected .desktop-icon-label {
  background-color: @accent_bg_color;
  color: @accent_fg_color;
  text-shadow: none;
}

.rubberband {
  background-color: alpha(@accent_bg_color, 0.25);
  border: 1px solid @accent_bg_color;
  border-radius: 2px;
}

.drop-spot {
  border: 2px dashed alpha(white, 0.7);
  border-radius: 8px;
  background-color: alpha(white, 0.1);
}
`;

const DesktopWindow = GObject.registerClass(
class DesktopWindow extends Gtk.ApplicationWindow {
    constructor(application) {
        super({
            application,
            title: 'Desktop',
            decorated: false,
            css_classes: ['tessera-desktop'],
        });
        this.grid = new DesktopGrid({onDesktopMenu: menu => popupShellMenu(menu)});
        this.set_child(this.grid);
        // Alt+F4 doesn't close the desktop
        this.connect('close-request', () => true);
    }
});

/**
 * Ask the shell for its root menu or window list under the pointer,
 * for a click on the empty desktop.
 *
 * @param {string} menu - 'root' or 'windows'
 */
function popupShellMenu(menu) {
    Gio.DBus.session.call('org.gnome.Shell', '/org/tessera/Shell/Desktop',
        'org.tessera.Shell.Desktop', 'PopupMenu', new GLib.Variant('(s)', [menu]),
        null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (e) {
                console.warn(`Failed to open the shell's menu: ${e.message}`);
            }
        });
}

const DesktopApplication = GObject.registerClass(
class DesktopApplication extends Adw.Application {
    constructor() {
        super({application_id: APP_ID});

        // The shell's root menu calls these over D-Bus; points are in
        // the window's coordinates
        const add = (name, type, activate) => {
            const action = new Gio.SimpleAction({
                name,
                parameter_type: type ? new GLib.VariantType(type) : null,
            });
            action.connect('activate', (_a, param) => activate(param?.deepUnpack()));
            this.add_action(action);
        };
        add('arrange', null, () => this._window?.grid.arrange());
        add('paste', '(ii)', ([x, y]) => this._window?.grid.paste(x, y));
        add('new-folder', '(sii)', ([name, x, y]) => this._window?.grid.newFolder(name, x, y));
        add('unselect', null, () => this._window?.grid.unselectAll());
        add('quit', null, () => this.quit());
    }

    vfunc_startup() {
        super.vfunc_startup();
        // The wallpaper is the shell's; the desktop never goes dark
        Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.PREFER_DARK;
        const provider = new Gtk.CssProvider();
        provider.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    vfunc_activate() {
        this._window ??= new DesktopWindow(this);
        this._window.present();
    }
});

new DesktopApplication().run([programInvocationName, ...ARGV]);
