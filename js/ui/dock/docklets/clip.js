import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as PopupMenu from '../../popupMenu.js';
import {Applet} from '../applet.js';
import {MAX_WORKSPACES} from '../fixedWorkspaces.js';
import {renameWorkspace} from '../nameDialog.js';
import {saveSet} from '../workspaceSets.js';
import {ACCENT, FG} from './meter.js';

const WM_PREFS_SCHEMA = 'org.gnome.desktop.wm.preferences';
/** Side of the square in a corner that a click on an arrow hits */
const ARROW_HIT = 22;
const ARROW_SIZE = 12;
const ARROW_INSET = 3;
const HOVER_TIME = 600;

/**
 * WindowMaker's Clip (see ../clip.js for what it does with the other
 * tiles). The tile shows the workspace's number and name; the arrows
 * in its top-right and bottom-left corners go to the next and previous
 * workspace, wrapping around; the menu adds workspaces. Scrolling
 * switches too.
 *
 * Click toggles Focus mode, Ctrl+click spreads out the windows
 * (Exposé), middle-click collapses or expands the Clip's icons, and
 * right-click opens the menu. An image dropped on it becomes the
 * workspace's wallpaper; the menu also saves and opens workspace sets.
 */
export const ClipDocklet = GObject.registerClass(
class ClipDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'clip-docklet'});

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        box.add_child(this._area);

        const corner = new St.BoxLayout({
            style_class: 'clip-docklet-corner',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        corner.add_child(new St.Icon({
            style_class: 'applet-icon',
            icon_name: 'mail-attachment-symbolic',
            icon_size: 12,
        }));
        this._count = new St.Label({style_class: 'applet-small clip-docklet-count'});
        corner.add_child(this._count);
        box.add_child(corner);

        this._number = new St.Label({
            style_class: 'clip-docklet-number',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._number);
        this._name = new St.Label({
            style_class: 'applet-small clip-docklet-name',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._name);
        this.set_child(box);

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this.tick(),
            'notify::n-workspaces', () => this.tick(),
            this);
        this._wmPrefs = new Gio.Settings({schema_id: WM_PREFS_SCHEMA});
        this._wmPrefs.connectObject('changed::workspace-names', () => this.tick(), this);

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });

        this._focus = false;
        this._hidden = 0;
        this.tick();
    }

    get defaults() {
        return {
            collapsed: false,
            autoCollapse: false,
            autoAttract: true,
            focusOnMaximize: true,
            peek: true,
        };
    }

    // Ctrl+click is Exposé here; the menu is on right-click
    get ctrlClickOpensMenu() {
        return false;
    }

    get acceptsFiles() {
        return true;
    }

    /** The first image dropped becomes the workspace's wallpaper. */
    dropFiles(uris) {
        const uri = uris.find(u => {
            const [type] = Gio.content_type_guess(u, null);
            return Gio.content_type_is_mime_type(type, 'image/*');
        });
        if (uri) {
            Main.workspaceBackgrounds.set(
                global.workspace_manager.get_active_workspace_index(), uri);
        }
    }

    /**
     * Called by the DockManager after it laid out the tiles.
     *
     * @param {boolean} focus - whether Focus mode is on
     * @param {number} hidden - icons tucked away by collapsing
     */
    syncState(focus, hidden) {
        if (this._focus === focus && this._hidden === hidden)
            return;
        this._focus = focus;
        this._hidden = hidden;
        this.tick();
    }

    tick() {
        const index = global.workspace_manager.get_active_workspace_index();
        this._number.text = String(index + 1);
        this._name.text = Meta.prefs_get_workspace_name(index);
        this._count.text = this._hidden > 0 ? `+${this._hidden}` : '';
        if (this._focus)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
        this._area.queue_repaint();
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
    }

    settingsChanged(key) {
        if (key === 'focusOnMaximize')
            Main.dock.clip.focusOnMaximizeChanged();
        Main.dock.syncLayout();
        this.tick();
    }

    activate(button) {
        const clip = Main.dock.clip;
        if (button === Clutter.BUTTON_MIDDLE) {
            clip.toggleCollapsed();
            return;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return;
        const event = Clutter.get_current_event();
        switch (this._arrowAt(event)) {
        case 'next':
            this._step(1);
            return;
        case 'previous':
            this._step(-1);
            return;
        }
        const ctrl = event &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl)
            Main.dock.expose.open();
        else
            clip.toggleFocus();
    }

    /** @returns {string|null} 'next' or 'previous' for a click on an arrow */
    _arrowAt(event) {
        if (!event)
            return null;
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = this.transform_stage_point(sx, sy);
        if (!ok)
            return null;
        const [w, h] = this.get_size();
        if (x >= w - ARROW_HIT && y < ARROW_HIT)
            return 'next';
        if (x < ARROW_HIT && y >= h - ARROW_HIT)
            return 'previous';
        return null;
    }

    /** Go to the next or previous workspace, wrapping around. */
    _step(direction) {
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const index = (wm.get_active_workspace_index() + direction + n) % n;
        wm.get_workspace_by_index(index).activate(global.get_current_time());
    }

    vfunc_scroll_event(event) {
        const wm = global.workspace_manager;
        let direction;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            direction = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            direction = 1;
            break;
        default:
            return Clutter.EVENT_STOP;
        }
        // Scrolling neither wraps around nor adds workspaces
        const index = wm.get_active_workspace_index() + direction;
        if (index >= 0 && index < wm.n_workspaces)
            wm.get_workspace_by_index(index).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }

    buildMenu(menu) {
        const clip = Main.dock.clip;
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const index = wm.get_active_workspace_index();

        menu.addAction(_('Rename Workspace…'), () => renameWorkspace(index));
        menu.addAction(_('Wallpaper…'), () => Main.workspaceBackgrounds.choose(index));
        if (Main.workspaceBackgrounds.uriFor(index)) {
            menu.addAction(_('Use the Desktop’s Wallpaper'),
                () => Main.workspaceBackgrounds.set(index, null));
        }
        const add = menu.addAction(_('New Workspace'), () => Main.fixedWorkspaces.add(true));
        add.setSensitive(n < MAX_WORKSPACES);
        const remove = menu.addAction(_('Delete Last Workspace'),
            () => Main.fixedWorkspaces.removeLast());
        remove.setSensitive(n > 1);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Sets')));
        menu.addAction(_('Save Workspace as Set…'), () => saveSet(index));
        const sets = Main.workspaceSets.names;
        if (sets.length) {
            const open = new PopupMenu.PopupSubMenuMenuItem(_('Open Set'));
            for (const name of sets)
                open.menu.addAction(name, () => Main.workspaceSets.restore(name));
            menu.addMenuItem(open);
            const del = new PopupMenu.PopupSubMenuMenuItem(_('Delete Set'));
            for (const name of sets)
                del.menu.addAction(name, () => Main.workspaceSets.remove(name));
            menu.addMenuItem(del);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const focus = new PopupMenu.PopupSwitchMenuItem(_('Focus Mode'), clip.focusActive);
        focus.connect('toggled', (_i, on) => clip.setFocus(on));
        menu.addMenuItem(focus);
        menu.addAction(_('Exposé'), () => Main.dock.expose.open());

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Icons')));
        if (!this.settings.autoCollapse) {
            const collapse = new PopupMenu.PopupSwitchMenuItem(_('Collapsed'), clip.collapsed);
            collapse.connect('toggled', () => clip.toggleCollapsed());
            menu.addMenuItem(collapse);
        }
        this.addToggle(menu, _('Auto-collapse'), 'autoCollapse');
        this.addToggle(menu, _('Auto-attract Icons'), 'autoAttract');

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Focus Mode')));
        this.addToggle(menu, _('Turn On When a Window Is Maximized'), 'focusOnMaximize');
        this.addToggle(menu, _('Peek at Hidden Tiles from the Edge'), 'peek');
    }

    _tooltipText() {
        const name = Meta.prefs_get_workspace_name(
            global.workspace_manager.get_active_workspace_index());
        return _('%s\nClick: Focus mode · Ctrl+click: Exposé\nMiddle-click: collapse the Clip')
            .format(name);
    }

    _onHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;
        if (!this.hover) {
            this.hideTooltip();
            return;
        }
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_TIME, () => {
            this._hoverId = 0;
            if (this.hover && !this._menu?.isOpen)
                this.showTooltip(this._tooltipText());
            return GLib.SOURCE_REMOVE;
        });
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        // Next, top right
        cr.moveTo(w - ARROW_INSET - ARROW_SIZE, ARROW_INSET);
        cr.lineTo(w - ARROW_INSET, ARROW_INSET);
        cr.lineTo(w - ARROW_INSET, ARROW_INSET + ARROW_SIZE);
        cr.closePath();
        // Previous, bottom left
        cr.moveTo(ARROW_INSET, h - ARROW_INSET - ARROW_SIZE);
        cr.lineTo(ARROW_INSET + ARROW_SIZE, h - ARROW_INSET);
        cr.lineTo(ARROW_INSET, h - ARROW_INSET);
        cr.closePath();
        const color = this._focus ? ACCENT : FG;
        cr.setSourceRGBA(...color, 0.9);
        cr.fill();
        cr.$dispose();
    }
});
