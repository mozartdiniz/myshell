import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../main.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const QUERY_ATTRS = [
    'standard::name',
    'standard::display-name',
    'standard::icon',
    'standard::is-hidden',
    'standard::is-backup',
    'time::modified',
    'thumbnail::path',
].join(',');
const BATCH_SIZE = 200;

const ICON_SIZE = 48;
const ICON_BOX = 56;
const OPEN_ICON_SIZE = 28;
/** Distance between item centres along the fan */
const STEP = 60;
/** Gap between the tile and the nearest item */
const GAP = 8;
/** Sideways offset of item i is BEND * i², which curves the fan */
const BEND = 0.8;
/** Items tilt by this share of the curve's slope */
const TILT = 0.6;
const MAX_ITEMS = 12;
const OPEN_TIME = 180;
const STAGGER_TIME = 12;
const CLOSE_TIME = 100;
const DROP_TIME = 150;
const RETURN_TIME = 200;

/**
 * A folder's contents fanned out from its tile, as in the macOS Dock:
 * newest first, nearest the tile, curving gently away from it, with
 * "Open in Files" at the far end. On a top or bottom edge the fan
 * grows into the screen with its labels on the side that has more
 * room; on a left or right edge it runs along the edge, up or down
 * from the tile, whichever has more room, with labels facing inwards.
 * The work area bounds it, so it never covers the other docks.
 *
 * It shows on a full-screen layer with a modal grab: a click outside
 * an item, Escape, or clicking the tile again closes it.
 *
 * Items can be dragged out, as the fan makes way: onto the desktop
 * (into the folder icon under them, or where they're dropped), or onto
 * a tile that takes files, such as another folder, an app or the
 * Trash. Ctrl copies and Shift moves, as in Files. The shell can't drag
 * to other apps' windows, so a drop anywhere else takes the item back.
 */
export class FolderFan {
    /** @param {import('./docklet.js').Docklet} tile */
    constructor(tile) {
        this._tile = tile;
        this._grab = null;
        this._cancellable = null;
        /** @type {{file: Gio.File, grab: Clutter.Grab, icon: St.Icon, offset: number[]}|null} */
        this._drag = null;
        this._dropTile = null;

        this._layer = new St.Widget({
            reactive: true,
            visible: false,
            constraints: new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
        });
        // Presses on items bubble up here too (St.Button clicks through a
        // gesture), so only one on the layer itself is outside the fan
        this._layer.connect('button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) !== this._layer)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('touch-event', (_a, event) => {
            if (global.stage.get_event_actor(event) !== this._layer)
                return Clutter.EVENT_PROPAGATE;
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        // uiGroup may be destroyed before us on shutdown
        this._layer.connect('destroy', () => (this._layer = null));
        Main.uiGroup.add_child(this._layer);
    }

    get isOpen() {
        return !!this._grab;
    }

    destroy() {
        this._endDrag(false);
        this._cancellable?.cancel();
        this._popModal();
        this._layer?.destroy();
    }

    /**
     * @param {Gio.File} folder
     * @param {function(): void} openFolder - opens the folder itself
     */
    async open(folder, openFolder) {
        if (this.isOpen || !this._layer)
            return;

        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        let entries;
        try {
            entries = await listNewestFirst(folder, cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError(_('Failed to read folder'), e.message);
            return;
        }
        if (cancellable.is_cancelled() || !this._layer)
            return;

        this._layer.destroy_all_children();
        this._layer.show();
        Main.uiGroup.set_child_above_sibling(this._layer, null);
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});

        this._layout(entries, folder, openFolder);
    }

    close() {
        this._endDrag(false);
        this._cancellable?.cancel();
        this._popModal();
        if (!this._layer)
            return;

        const items = this._layer.get_children();
        if (items.length === 0) {
            this._layer.hide();
            return;
        }
        const layer = this._layer;
        items.forEach((item, i) => {
            item.reactive = false;
            item.ease({
                opacity: 0,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: i > 0 ? undefined : () => {
                    if (this.isOpen)
                        return; // opened again meanwhile
                    layer.hide();
                    layer.destroy_all_children();
                },
            });
        });
    }

    toggle(folder, openFolder) {
        if (this.isOpen)
            this.close();
        else
            this.open(folder, openFolder);
    }

    _popModal() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const directions = {
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        };
        const direction = directions[key];
        if (direction === undefined)
            return Clutter.EVENT_PROPAGATE;

        const focus = global.stage.key_focus;
        if (!focus || !this._layer.contains(focus))
            this._layer.get_first_child()?.grab_key_focus();
        else
            this._layer.navigate_focus(focus, direction, false);
        return Clutter.EVENT_STOP;
    }

    _layout(entries, folder, openFolder) {
        const geometry = fanGeometry(this._tile);
        const fits = Math.max(1,
            Math.min(MAX_ITEMS, Math.floor((geometry.room - ICON_BOX / 2) / STEP) + 1));
        const shown = entries.slice(0, fits - 1);

        const items = shown.map(entry => {
            const item = this._createItem(entry.name, entry.icon,
                geometry.labelsLeft, () => launchUri(entry.file.get_uri()));
            this._makeDraggable(item, entry.file, entry.icon);
            return item;
        });
        const more = entries.length - shown.length;
        const openLabel = more > 0
            /* Translators: %d is how many items didn't fit in the fan */
            ? _('Open in Files (%d more)').format(more)
            : _('Open in Files');
        const openItem = this._createItem(openLabel,
            new Gio.ThemedIcon({name: 'go-jump-symbolic'}), geometry.labelsLeft, openFolder,
            OPEN_ICON_SIZE);
        openItem.add_style_class_name('folder-fan-open');
        items.push(openItem);

        const [tileX, tileY] = this._tile.get_transformed_position();
        const [tileW, tileH] = this._tile.get_transformed_size();
        const fromX = tileX + tileW / 2;
        const fromY = tileY + tileH / 2;

        items.forEach((item, i) => {
            this._layer.add_child(item);
            const [, , w, h] = item.get_preferred_size();
            const iconX = geometry.labelsLeft ? w - ICON_BOX / 2 : ICON_BOX / 2;
            const cx = geometry.x + geometry.bend * BEND * i * i;
            const cy = geometry.y + geometry.dir * STEP * i;
            // Each item lies across the curve: tilt it by the curve's slope
            const slope = 2 * BEND * i * geometry.bend * -geometry.dir;
            const angle = TILT * Math.atan2(slope, STEP) * 180 / Math.PI;

            item.set_position(Math.round(cx - iconX), Math.round(cy - h / 2));
            item.pivot_point = new Graphene.Point({x: iconX / w, y: 0.5});

            // Grow out of the tile, nearest items first
            item.set({
                opacity: 0,
                scale_x: 0.4,
                scale_y: 0.4,
                rotation_angle_z: 0,
                translation_x: fromX - cx,
                translation_y: fromY - cy,
            });
            item.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                rotation_angle_z: angle,
                translation_x: 0,
                translation_y: 0,
                delay: i * STAGGER_TIME,
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _createItem(text, gicon, labelsLeft, action, iconSize = ICON_SIZE) {
        const label = new St.Label({
            style_class: 'folder-fan-label',
            text,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        const icon = new St.Icon({
            style_class: 'folder-fan-icon',
            gicon,
            icon_size: iconSize,
            width: ICON_BOX,
            height: ICON_BOX,
        });
        const box = new St.BoxLayout({style_class: 'folder-fan-item-box'});
        if (labelsLeft) {
            box.add_child(label);
            box.add_child(icon);
        } else {
            box.add_child(icon);
            box.add_child(label);
        }

        const item = new St.Button({
            style_class: 'folder-fan-item',
            child: box,
            can_focus: true,
            accessible_name: text,
        });
        item.connect('clicked', () => {
            this.close();
            action();
        });
        return item;
    }

    // ---- dragging items out --------------------------------------------

    // The drag is the shell's own: the icon follows the pointer over a
    // grab, and what's under it on release takes the file.
    _makeDraggable(item, file, gicon) {
        const pan = new Clutter.PanGesture({begin_threshold: 8});
        pan.connect('recognize', () => this._beginDrag(item, file, gicon));
        pan.connect('pan-update', () => this._updateDrag());
        pan.connect('end', () => this._endDrag(true));
        pan.connect('cancel', () => this._endDrag(false));
        item.add_action(pan);
    }

    _beginDrag(item, file, gicon) {
        const [px, py] = global.get_pointer();
        const icon = new St.Icon({
            style_class: 'folder-fan-icon',
            gicon,
            icon_size: ICON_SIZE,
            reactive: false,
        });
        Main.uiGroup.add_child(icon);
        Main.uiGroup.set_child_above_sibling(icon, null);
        // Under the pointer where the item's icon was grabbed
        const [ix, iy] = item.get_child().get_children()
            .find(c => c instanceof St.Icon).get_transformed_position();
        const offset = [
            clampOffset(px - ix - (ICON_BOX - ICON_SIZE) / 2),
            clampOffset(py - iy - (ICON_BOX - ICON_SIZE) / 2),
        ];
        icon.set_position(px - offset[0], py - offset[1]);
        this._drag = {file, grab: global.stage.grab(item), icon, offset};

        // The fan makes way for the drop
        for (const child of this._layer.get_children()) {
            child.reactive = false;
            child.ease({
                opacity: 0,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _updateDrag() {
        if (!this._drag)
            return;
        const [px, py] = global.get_pointer();
        const {icon, offset} = this._drag;
        icon.set_position(px - offset[0], py - offset[1]);
        this._setDropTile(this._tileAt(px, py));
    }

    _endDrag(released) {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        drag.grab.dismiss();
        this._setDropTile(null);

        const [x, y, mods] = global.get_pointer();
        const dropped = released && this._drop(drag.file, x, y, mods);
        const {icon} = drag;
        if (dropped) {
            icon.set_pivot_point(0.5, 0.5);
            icon.ease({
                opacity: 0,
                scale_x: 0.5,
                scale_y: 0.5,
                duration: DROP_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => icon.destroy(),
            });
        } else {
            // Back into the folder's tile
            const [tx, ty] = this._tile.get_transformed_position();
            const [tw, th] = this._tile.get_transformed_size();
            icon.ease({
                x: tx + (tw - ICON_SIZE) / 2,
                y: ty + (th - ICON_SIZE) / 2,
                opacity: 0,
                duration: RETURN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => icon.destroy(),
            });
        }
        this.close();
    }

    /**
     * Give `file` to what's at x, y: a tile that takes files, or the
     * desktop if it's the window there.
     *
     * @returns {boolean} whether something took it
     */
    _drop(file, x, y, mods) {
        const uris = [file.get_uri()];
        const tile = this._tileAt(x, y);
        if (tile) {
            tile.dropFiles(uris);
            return true;
        }
        const desktop = Main.desktopIcons;
        if (desktop?.window && windowAt(x, y) === desktop.window) {
            let mode = 'default';
            if (mods & Clutter.ModifierType.CONTROL_MASK)
                mode = 'copy';
            else if (mods & Clutter.ModifierType.SHIFT_MASK)
                mode = 'move';
            desktop.dropFiles(uris, x, y, mode);
            return true;
        }
        return false;
    }

    /** A tile other than the folder's own that takes files dropped at x, y. */
    _tileAt(x, y) {
        return Main.dock?.tiles.find(t => t !== this._tile && t.acceptsFiles &&
            t.mapped && contains(t, x, y)) ?? null;
    }

    _setDropTile(tile) {
        if (this._dropTile === tile)
            return;
        this._dropTile?.remove_style_pseudo_class('drop-target');
        this._dropTile = tile;
        tile?.add_style_pseudo_class('drop-target');
    }
}

/** Keeps the grabbed point on the dragged icon. */
function clampOffset(offset) {
    return Math.clamp(offset, 0, ICON_SIZE);
}

function contains(actor, x, y) {
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax && x < ax + w && y >= ay && y < ay + h;
}

function rectContains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** @returns {Meta.Window|null} the topmost window at x, y on this workspace */
function windowAt(x, y) {
    const workspace = global.workspace_manager.get_active_workspace();
    return global.get_window_actors().map(a => a.meta_window).reverse()
        .find(w => !w.minimized && w.showing_on_its_workspace() &&
            w.located_on_workspace(workspace) &&
            rectContains(w.get_frame_rect(), x, y)) ?? null;
}

/**
 * Where the fan starts and which way it goes, from the tile's edge.
 *
 * @returns {{x: number, y: number, dir: number, bend: number,
 *   labelsLeft: boolean, room: number}} centre of the first item's
 *   icon; `dir` is -1 to grow up, 1 down; `bend` is the sideways
 *   direction the curve takes; `room` is the space along the fan
 */
function fanGeometry(tile) {
    const [x, y] = tile.get_transformed_position();
    const [w, h] = tile.get_transformed_size();
    const monitor = Main.layoutManager.findMonitorForActor(tile) ??
        Main.layoutManager.primaryMonitor;
    const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    const top = area.y;
    const bottom = area.y + area.height;
    const edge = tile.placement?.edge ?? 'bottom';

    if (edge === 'top' || edge === 'bottom') {
        const dir = edge === 'bottom' ? -1 : 1;
        const cy = edge === 'bottom'
            ? y - GAP - ICON_BOX / 2
            : y + h + GAP + ICON_BOX / 2;
        const labelsLeft = x + w / 2 > monitor.x + monitor.width / 2;
        return {
            x: x + w / 2,
            y: cy,
            dir,
            // Curve away from the labels, as macOS does
            bend: labelsLeft ? 1 : -1,
            labelsLeft,
            room: dir < 0 ? cy - top : bottom - cy,
        };
    }

    // Along a side edge, just inside the tile, towards the bigger half
    const cy = y + h / 2;
    const dir = cy - top > bottom - cy ? -1 : 1;
    const labelsLeft = edge === 'right';
    return {
        x: edge === 'left' ? x + w + GAP + ICON_BOX / 2 : x - GAP - ICON_BOX / 2,
        y: cy,
        dir,
        // Curve away from the edge
        bend: labelsLeft ? -1 : 1,
        labelsLeft,
        room: dir < 0 ? cy - top : bottom - cy,
    };
}

/** @returns {Promise<Array<{file: Gio.File, name: string, icon: Gio.Icon, time: number}>>} */
async function listNewestFirst(folder, cancellable) {
    const enumerator = await folder.enumerate_children_async(QUERY_ATTRS,
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const entries = [];
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const infos = await enumerator.next_files_async(BATCH_SIZE,
            GLib.PRIORITY_DEFAULT, cancellable);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            if (info.get_is_hidden() || info.get_is_backup())
                continue;
            const thumbnail = info.get_attribute_byte_string('thumbnail::path');
            entries.push({
                file: enumerator.get_child(info),
                name: info.get_display_name(),
                icon: thumbnail
                    ? new Gio.FileIcon({file: Gio.File.new_for_path(thumbnail)})
                    : info.get_icon(),
                time: info.get_modification_date_time()?.to_unix() ?? 0,
            });
        }
    }
    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
    return entries.sort((a, b) => b.time - a.time);
}

function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri,
            global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError(_('Failed to open “%s”').format(uri), e.message);
    }
}
