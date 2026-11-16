// The desktop's icons on a grid, with what a file manager does with
// them: selecting, opening, menus, dragging in and out, cut and paste.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Files from './files.js';

const CELL_WIDTH = 96;
const CELL_HEIGHT = 100;
const ICON_SIZE = 48;
/** Space between the window's edge and the grid */
const MARGIN = 12;
/** An icon is this much narrower than its cell */
const ICON_INSET = 4;
const RELOAD_DELAY = 150;
/** How long icons take to glide into place on Arrange, in µs */
const ARRANGE_TIME = 260 * 1000;
/** Each icon sets off this much after the one before it, up to MAX_STAGGER */
const STAGGER_TIME = 8 * 1000;
const MAX_STAGGER = 120 * 1000;
/** How long a cell kept for a file on its way here waits for it, in µs */
const PENDING_TIME = 120 * GLib.USEC_PER_SEC;
const CONFIG_PATH = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'tessera', 'desktop-icons.json']);
/** Where the first version kept the cells, with the shell's settings */
const OLD_CONFIG_PATH = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'tessera', 'desktop.json']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One file: its icon, or thumbnail, and its name. */
const DesktopIcon = GObject.registerClass(
class DesktopIcon extends Gtk.Box {
    constructor(entry) {
        super({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['desktop-icon'],
        });
        this._image = new Gtk.Image({
            pixel_size: ICON_SIZE,
            css_classes: ['desktop-icon-image'],
        });
        this._label = new Gtk.Label({
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            lines: 2,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 1,
            css_classes: ['desktop-icon-label'],
        });
        this.append(this._image);
        this.append(this._label);

        /** @type {[number, number]|null} grid cell, column and row */
        this.cell = null;
        /** @type {{x: number, y: number, width: number, height: number}} */
        this.rect = {x: 0, y: 0, width: 0, height: 0};
        /** Where it was last drawn, which can be on its way to `rect` */
        this.shown = null;
        /** @type {{x: number, y: number, start: number}|null} a glide to `rect` */
        this.glide = null;
        this.setEntry(entry);
    }

    /** @param {import('./files.js').Entry} entry */
    setEntry(entry) {
        this.entry = entry;
        this._image.gicon = entry.icon;
        this._label.label = entry.displayName;
    }

    setIcon(icon) {
        this._image.gicon = icon;
    }

    get selected() {
        return this.has_css_class('selected');
    }

    set selected(selected) {
        if (selected)
            this.add_css_class('selected');
        else
            this.remove_css_class('selected');
        // The whole name shows while it's selected
        this._label.lines = selected ? -1 : 2;
        this._label.ellipsize = selected ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
    }

    contains(x, y) {
        const {rect} = this;
        return x >= rect.x && x < rect.x + rect.width &&
            y >= rect.y && y < rect.y + rect.height;
    }
});

/**
 * The files of the Desktop folder on a grid, filling the free cells
 * from the top left, a column at a time, folders first. An icon that
 * was moved keeps its cell; the cells, by file name, live in
 * $XDG_CONFIG_HOME/tessera/desktop-icons.json.
 *
 * A click selects (Ctrl or Shift adds), dragging on the empty desktop
 * selects a rectangle, a double click or Enter opens. Icons drag to
 * other cells, into folders, onto launchers, or out to any app; files
 * dragged in from apps are moved or copied here, or into the folder
 * they're dropped on (Ctrl copies, Shift moves). Right-click on an icon
 * for its menu; on the empty desktop, the shell's root menu shows
 * through `onDesktopMenu`.
 */
export const DesktopGrid = GObject.registerClass(
class DesktopGrid extends Gtk.Widget {
    /**
     * @param {object} params
     * @param {function(string): void} params.onDesktopMenu - called with
     *   'root' or 'windows' for a click on the empty desktop
     */
    constructor({onDesktopMenu}) {
        super({
            focusable: true,
            hexpand: true,
            vexpand: true,
            css_classes: ['desktop-grid'],
        });
        this._onDesktopMenu = onDesktopMenu;
        this._folder = Files.desktopFolder();
        this._folderFilesystem = null;

        const config = this._load();
        /** @type {Map<string, [number, number]>} cells by file name */
        this._cells = config.cells;
        /** @type {Map<string, number>} files on their way, by name, when they were expected */
        this._pending = new Map();
        /** @type {{cells: Array<[number, number]>, time: number}|null} cells for the next new files */
        this._landing = null;
        this._loaded = false;

        /** @type {Map<string, DesktopIcon>} by file name */
        this._icons = new Map();
        this._columns = 1;
        this._rows = 1;
        this._width = 0;
        this._height = 0;
        /** The icon Shift+click and arrows go from */
        this._anchor = null;

        this._rubberband = new Gtk.Box({css_classes: ['rubberband'], visible: false});
        this._rubberband.set_parent(this);
        this._dropSpot = new Gtk.Box({css_classes: ['drop-spot'], visible: false});
        this._dropSpot.set_parent(this);
        /** @type {{icons: DesktopIcon[], x: number, y: number}|null} our own drag */
        this._drag = null;
        this._dropFolder = null;

        this._thumbnailer = new Files.Thumbnailer();
        this._cancellable = null;
        this._reloadId = 0;
        this._menu = null;

        this._setupActions();
        this._setupDesktopGestures();
        this._setupDropTarget();
        this._setupKeys();

        if (this._folder) {
            try {
                this._monitor = this._folder.monitor_directory(
                    Gio.FileMonitorFlags.WATCH_MOVES, null);
                this._monitor.connect('changed', () => this._queueReload());
            } catch (e) {
                console.warn(`Failed to watch the Desktop folder: ${e.message}`);
            }
        }
        this._reload();
    }

    vfunc_dispose() {
        this._cancellable?.cancel();
        this._thumbnailer.destroy();
        this._monitor?.cancel();
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        let child;
        while ((child = this.get_first_child()))
            child.unparent();
        super.vfunc_dispose();
    }

    get folder() {
        return this._folder;
    }

    // ---- layout -------------------------------------------------------------

    vfunc_measure() {
        return [0, 0, -1, -1];
    }

    vfunc_size_allocate(width, height, _baseline) {
        if (width !== this._width || height !== this._height) {
            this._width = width;
            this._height = height;
            this._assignCells();
        }
        const now = this.get_frame_clock()?.get_frame_time() ?? 0;
        for (const icon of this._icons.values()) {
            const [col, row] = icon.cell;
            const w = CELL_WIDTH - ICON_INSET * 2;
            const [, h] = icon.measure(Gtk.Orientation.VERTICAL, w);
            icon.rect = {
                x: MARGIN + col * CELL_WIDTH + ICON_INSET,
                y: MARGIN + row * CELL_HEIGHT + ICON_INSET,
                width: w,
                height: h,
            };
            let {x, y} = icon.rect;
            if (icon.glide) {
                const t = clamp((now - icon.glide.start) / ARRANGE_TIME, 0, 1);
                const ease = 1 - (1 - t) ** 3;
                x = Math.round(icon.glide.x + (x - icon.glide.x) * ease);
                y = Math.round(icon.glide.y + (y - icon.glide.y) * ease);
                if (t >= 1)
                    icon.glide = null;
            }
            icon.shown = {x, y};
            allocateAt(icon, x, y, w, h);
        }
        for (const box of [this._rubberband, this._dropSpot]) {
            if (box.visible && box.rect)
                allocateAt(box, box.rect.x, box.rect.y, box.rect.width, box.rect.height);
        }
        // Popovers are sized and placed by their parent
        for (let child = this.get_first_child(); child; child = child.get_next_sibling()) {
            if (child instanceof Gtk.Popover)
                child.present();
        }
    }

    /** @returns {[number, number]} the nearest cell to x, y */
    _cellAt(x, y) {
        return [
            clamp(Math.floor((x - MARGIN) / CELL_WIDTH), 0, this._columns - 1),
            clamp(Math.floor((y - MARGIN) / CELL_HEIGHT), 0, this._rows - 1),
        ];
    }

    _cellRect([col, row]) {
        return {
            x: MARGIN + col * CELL_WIDTH + ICON_INSET,
            y: MARGIN + row * CELL_HEIGHT + ICON_INSET,
            width: CELL_WIDTH - ICON_INSET * 2,
            height: CELL_HEIGHT - ICON_INSET * 2,
        };
    }

    /**
     * Put every icon in a cell: moved ones where they were left, as long
     * as that cell is on screen, the others in the free cells.
     */
    _assignCells() {
        this._columns = Math.max(1, Math.floor((this._width - 2 * MARGIN) / CELL_WIDTH));
        this._rows = Math.max(1, Math.floor((this._height - 2 * MARGIN) / CELL_HEIGHT));
        const taken = new Set();
        const unplaced = [];
        for (const icon of this._sortedIcons()) {
            const cell = this._cells.get(icon.entry.name);
            if (cell && cell[0] < this._columns && cell[1] < this._rows &&
                !taken.has(key(cell))) {
                taken.add(key(cell));
                icon.cell = cell;
            } else {
                unplaced.push(icon);
            }
        }
        const free = this._freeCells(taken);
        for (const icon of unplaced) {
            // More files than cells: they pile up in the last one
            icon.cell = free.next().value ?? [this._columns - 1, this._rows - 1];
            taken.add(key(icon.cell));
        }
    }

    /** Free cells, a column at a time from the top left, or from `start`. */
    *_freeCells(taken, start = [0, 0]) {
        const total = this._columns * this._rows;
        for (let i = start[0] * this._rows + start[1]; i < total; i++) {
            const cell = [Math.floor(i / this._rows), i % this._rows];
            if (!taken.has(key(cell)))
                yield cell;
        }
    }

    /** Free cells nearest `cell` first, for things dropped there. */
    _nearestFreeCells(cell, taken) {
        const cells = [];
        for (let c = 0; c < this._columns; c++) {
            for (let r = 0; r < this._rows; r++) {
                if (!taken.has(key([c, r])))
                    cells.push([c, r]);
            }
        }
        const distance = ([c, r]) => (c - cell[0]) ** 2 + (r - cell[1]) ** 2;
        return cells.sort((a, b) => distance(a) - distance(b));
    }

    /** Folders first, then by name, as Files lists them. */
    _sortedIcons() {
        return [...this._icons.values()].sort((a, b) =>
            (b.entry.isDir - a.entry.isDir) ||
            GLib.utf8_collate(a.entry.displayName, b.entry.displayName));
    }

    /** Keep every icon where it is now, as one of them moves. */
    _freezeCells() {
        for (const icon of this._icons.values())
            this._cells.set(icon.entry.name, icon.cell);
    }

    /** Forget where icons were moved and line them all up again. */
    arrange() {
        this._cells.clear();
        this._save();
        this._assignCells();
        this._glideToCells();
        this.queue_allocate();
    }

    /**
     * Make the icons glide from where they're shown to their cells,
     * quickly and easing out, one just after another in the order
     * they fill the grid.
     */
    _glideToCells() {
        const clock = this.get_frame_clock();
        if (!clock || !Gtk.Settings.get_default().gtk_enable_animations)
            return;
        const start = clock.get_frame_time();
        const order = icon => icon.cell[0] * this._rows + icon.cell[1];
        const icons = [...this._icons.values()]
            .filter(icon => icon.shown)
            .sort((a, b) => order(a) - order(b));
        icons.forEach((icon, i) => {
            const [col, row] = icon.cell;
            const x = MARGIN + col * CELL_WIDTH + ICON_INSET;
            const y = MARGIN + row * CELL_HEIGHT + ICON_INSET;
            if (icon.shown.x === x && icon.shown.y === y) {
                icon.glide = null;
                return;
            }
            icon.glide = {...icon.shown, start: start + Math.min(i * STAGGER_TIME, MAX_STAGGER)};
        });
        this._tickId ||= this.add_tick_callback(() => {
            this.queue_allocate();
            if ([...this._icons.values()].some(icon => icon.glide))
                return GLib.SOURCE_CONTINUE;
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- folder contents ------------------------------------------------------

    _queueReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        let entries = [];
        if (this._folder) {
            try {
                entries = await Files.listEntries(this._folder, cancellable);
                const info = await this._folder.query_info_async('id::filesystem',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
                this._folderFilesystem = info.get_attribute_string('id::filesystem');
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`Failed to read the Desktop folder: ${e.message}`);
            }
        }
        if (cancellable.is_cancelled())
            return;

        const names = new Set(entries.map(e => e.name));
        const added = [];
        for (const [name, icon] of this._icons) {
            if (names.has(name))
                continue;
            if (this._anchor === icon)
                this._anchor = null;
            icon.unparent();
            this._icons.delete(name);
        }
        for (const entry of entries) {
            let icon = this._icons.get(entry.name);
            if (icon) {
                icon.setEntry(entry);
            } else {
                icon = this._createIcon(entry);
                this._icons.set(entry.name, icon);
                if (this._loaded)
                    added.push(entry.name);
            }
            this._thumbnailer.request(entry, gicon => {
                if (this._icons.get(entry.name) === icon)
                    icon.setIcon(gicon);
            });
        }

        // Files that went away don't keep a cell for a new file, unless
        // they're on their way here
        const now = GLib.get_monotonic_time();
        for (const [name, time] of this._pending) {
            if (names.has(name) || now - time > PENDING_TIME)
                this._pending.delete(name);
        }
        let changed = false;
        // Files just dropped or pasted land where that happened, under
        // whatever names Files gave them
        if (this._landing && now - this._landing.time < PENDING_TIME) {
            for (const name of added) {
                if (this._cells.has(name) || this._landing.cells.length === 0)
                    continue;
                this._cells.set(name, this._landing.cells.shift());
                changed = true;
            }
        }
        for (const name of this._cells.keys()) {
            if (!names.has(name) && !this._pending.has(name)) {
                this._cells.delete(name);
                changed = true;
            }
        }
        if (changed)
            this._save();

        this._loaded = true;
        this._assignCells();
        this._raiseSelected();
        this.queue_allocate();

        // A new folder from Ctrl+Shift+N gets its name typed in
        const renaming = this._renameWhenShown && this._icons.get(this._renameWhenShown);
        if (renaming) {
            this._renameWhenShown = null;
            this._select([renaming]);
            this._startRename(renaming);
        }
    }

    _createIcon(entry) {
        const icon = new DesktopIcon(entry);
        // Under the rubberband and drop spot
        icon.insert_before(this, this._rubberband);

        const click = new Gtk.GestureClick({button: 0});
        click.connect('pressed', (gesture, nPress, x, y) =>
            this._onIconPressed(icon, gesture, nPress, x, y));
        click.connect('released', (gesture, nPress) =>
            this._onIconReleased(icon, gesture, nPress));
        icon.add_controller(click);

        const source = new Gtk.DragSource({
            actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK,
        });
        source.connect('prepare', (_s, x, y) => this._onDragPrepare(icon, x, y));
        source.connect('drag-begin', (s, drag) => this._onDragBegin(icon, s, drag));
        source.connect('drag-end', () => this._onDragEnd());
        icon.add_controller(source);
        return icon;
    }

    // ---- selection --------------------------------------------------------------

    get _selection() {
        return this._sortedIcons().filter(icon => icon.selected);
    }

    get selectedFiles() {
        return this._selection.map(icon => icon.entry.file);
    }

    _select(icons, {add = false} = {}) {
        const set = new Set(icons);
        for (const icon of this._icons.values()) {
            if (set.has(icon))
                icon.selected = true;
            else if (!add)
                icon.selected = false;
        }
        if (icons.length)
            this._anchor = icons.at(-1);
        this._raiseSelected();
        this._syncActions();
        this.queue_allocate();
    }

    unselectAll() {
        this._select([]);
    }

    selectAll() {
        this._select([...this._icons.values()]);
    }

    /** Selected icons over their neighbours, as their whole names show. */
    _raiseSelected() {
        for (const icon of this._icons.values()) {
            if (icon.selected)
                icon.insert_before(this, this._rubberband);
        }
    }

    _onIconPressed(icon, gesture, nPress, x, y) {
        this.grab_focus();
        const button = gesture.get_current_button();
        const state = gesture.get_current_event_state();
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        if (button === Gdk.BUTTON_SECONDARY) {
            if (!icon.selected)
                this._select([icon]);
            this._popupIconMenu(icon.rect.x + x, icon.rect.y + y);
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            return;
        }
        if (button !== Gdk.BUTTON_PRIMARY)
            return;

        if (nPress === 2 && !ctrl && !shift) {
            this._openSelection();
            return;
        }
        if (ctrl) {
            icon.selected = !icon.selected;
            this._anchor = icon;
            this._raiseSelected();
            this._syncActions();
            this.queue_allocate();
        } else if (shift && this._anchor) {
            this._select(this._iconsBetween(this._anchor, icon), {add: true});
        } else if (!icon.selected) {
            this._select([icon]);
        }
        // Pressing one of several selected icons keeps them for a drag;
        // a release without one selects just it
        this._pressedSelected = !ctrl && !shift && icon.selected;
    }

    _onIconReleased(icon, _gesture, nPress) {
        if (nPress === 1 && this._pressedSelected && this._selection.length > 1)
            this._select([icon]);
        this._pressedSelected = false;
    }

    /** Icons from `a` to `b` in the order they fill the grid. */
    _iconsBetween(a, b) {
        const index = icon => icon.cell[0] * this._rows + icon.cell[1];
        const [from, to] = [index(a), index(b)].sort((x, y) => x - y);
        return [...this._icons.values()].filter(i => index(i) >= from && index(i) <= to);
    }

    _setupDesktopGestures() {
        // Presses on the empty desktop: menus come from the shell
        const click = new Gtk.GestureClick({button: 0});
        click.connect('pressed', (gesture, _n, x, y) => {
            if (this._iconAt(x, y))
                return;
            const button = gesture.get_current_button();
            if (button === Gdk.BUTTON_SECONDARY || button === Gdk.BUTTON_MIDDLE) {
                gesture.set_state(Gtk.EventSequenceState.CLAIMED);
                this.unselectAll();
                this._onDesktopMenu(button === Gdk.BUTTON_MIDDLE ? 'windows' : 'root');
            }
        });
        this.add_controller(click);

        const longPress = new Gtk.GestureLongPress({touch_only: true});
        longPress.connect('pressed', (_g, x, y) => {
            if (!this._iconAt(x, y))
                this._onDesktopMenu('root');
        });
        this.add_controller(longPress);

        // Dragging on the empty desktop selects a rectangle
        const band = new Gtk.GestureDrag({button: Gdk.BUTTON_PRIMARY});
        band.connect('drag-begin', (gesture, x, y) => {
            if (this._iconAt(x, y)) {
                gesture.set_state(Gtk.EventSequenceState.DENIED);
                return;
            }
            this.grab_focus();
            const state = gesture.get_current_event_state();
            const add = (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK)) !== 0;
            this._bandBase = add ? new Set(this._selection) : new Set();
            if (!add)
                this.unselectAll();
            this._bandStart = [x, y];
        });
        band.connect('drag-update', (_g, dx, dy) => {
            const [x0, y0] = this._bandStart;
            const rect = {
                x: Math.min(x0, x0 + dx),
                y: Math.min(y0, y0 + dy),
                width: Math.abs(dx),
                height: Math.abs(dy),
            };
            this._rubberband.rect = rect;
            this._rubberband.visible = true;
            const inside = [...this._icons.values()].filter(icon => intersects(icon.rect, rect));
            this._select([...this._bandBase, ...inside]);
        });
        band.connect('drag-end', () => {
            this._rubberband.visible = false;
            this.queue_allocate();
        });
        this.add_controller(band);
    }

    _iconAt(x, y) {
        // Selected icons are on top
        const icons = [...this._icons.values()].sort((a, b) => b.selected - a.selected);
        return icons.find(icon => icon.contains(x, y)) ?? null;
    }

    // ---- dragging out and around -------------------------------------------------

    _onDragPrepare(icon, x, y) {
        if (!icon.selected)
            this._select([icon]);
        this._pressedSelected = false;
        const icons = this._selection;
        this._drag = {icons, x: icon.rect.x + x, y: icon.rect.y + y, hotX: x, hotY: y, icon};
        return Files.fileListProvider(icons.map(i => i.entry.file));
    }

    _onDragBegin(icon, source, _drag) {
        source.set_icon(new Gtk.WidgetPaintable({widget: icon}),
            this._drag.hotX, this._drag.hotY);
        for (const i of this._drag.icons)
            i.add_css_class('dragged');
    }

    _onDragEnd() {
        for (const icon of this._icons.values())
            icon.remove_css_class('dragged');
        this._drag = null;
        this._setDropFeedback(null, null);
    }

    // ---- dropping in ------------------------------------------------------------------

    _setupDropTarget() {
        const target = Gtk.DropTarget.new(Gdk.FileList.$gtype,
            Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK);
        target.preload = true;
        target.connect('motion', (t, x, y) => this._onDropMotion(t, x, y));
        target.connect('leave', () => this._setDropFeedback(null, null));
        target.connect('drop', (t, value, x, y) => this._onDrop(t, value, x, y));
        this.add_controller(target);
    }

    /**
     * Where a drop at x, y goes: into a folder or launcher under it that
     * isn't being dragged, or else onto the desktop.
     *
     * @returns {DesktopIcon|null}
     */
    _dropIconAt(x, y) {
        const icon = this._iconAt(x, y);
        if (!icon || this._drag?.icons.includes(icon))
            return null;
        return icon.entry.isDir || icon.entry.launcher ? icon : null;
    }

    _onDropMotion(target, x, y) {
        const icon = this._dropIconAt(x, y);
        const action = this._dropAction(target, icon);
        this._setDropFeedback(action ? icon : null,
            action && !icon ? this._cellAt(...this._dropOrigin(x, y)) : null);
        return action;
    }

    /** Top left of where the dragged icon goes when dropped at x, y. */
    _dropOrigin(x, y) {
        if (this._drag)
            return [x - this._drag.hotX + CELL_WIDTH / 2, y - this._drag.hotY + CELL_HEIGHT / 2];
        return [x, y];
    }

    _dropAction(target, icon) {
        const state = target.get_current_event_state();
        return this._actionFor(target.get_value()?.get_files?.() ?? [], icon, {
            copy: (state & Gdk.ModifierType.CONTROL_MASK) !== 0,
            move: (state & Gdk.ModifierType.SHIFT_MASK) !== 0,
        });
    }

    /**
     * What dropping `files` on `icon`, or the empty desktop, does: Ctrl
     * copies and Shift moves; otherwise our own icons move about, and
     * files from elsewhere move if they're on the same disk, as in Files.
     *
     * @returns {Gdk.DragAction} COPY, MOVE, or 0 for nothing
     */
    _actionFor(files, icon, {copy = false, move = false} = {}) {
        if (!this._folder)
            return 0;
        if (icon?.entry.launcher || copy)
            return Gdk.DragAction.COPY;
        if (move || this._drag)
            return Gdk.DragAction.MOVE;
        const folder = icon?.entry.file ?? this._folder;
        const filesystem = icon ? icon.entry.filesystem : this._folderFilesystem;
        if (files.length && files.every(f => Files.sameFilesystem(f, folder, filesystem)))
            return Gdk.DragAction.MOVE;
        return Gdk.DragAction.COPY;
    }

    _setDropFeedback(icon, cell) {
        if (this._dropFolder !== icon) {
            this._dropFolder?.remove_css_class('drop-target');
            this._dropFolder = icon;
            icon?.add_css_class('drop-target');
        }
        this._dropSpot.visible = !!cell;
        if (cell)
            this._dropSpot.rect = this._cellRect(cell);
        this.queue_allocate();
    }

    _onDrop(target, value, x, y) {
        const icon = this._dropIconAt(x, y);
        const action = this._dropAction(target, icon);
        this._setDropFeedback(null, null);
        // Our own drags carry our files; there's no need to read them
        const files = this._drag
            ? this._drag.icons.map(i => i.entry.file)
            : value?.get_files() ?? [];
        return this._dropFiles(files, icon, action, x, y);
    }

    /**
     * Files dragged from the shell, such as from a Folder applet's fan,
     * and dropped at x, y.
     *
     * @param {Gio.File[]} files
     * @param {number} x
     * @param {number} y
     * @param {string} mode - 'copy', 'move', or 'default' for what a
     *   plain drag does
     */
    dropFiles(files, x, y, mode) {
        const icon = this._dropIconAt(x, y);
        const action = this._actionFor(files, icon,
            {copy: mode === 'copy', move: mode === 'move'});
        this._dropFiles(files, icon, action, x, y);
    }

    /** Do `action` with `files` dropped at x, y, on `icon` if there's one. */
    _dropFiles(files, icon, action, x, y) {
        if (!action || files.length === 0)
            return false;

        if (icon?.entry.launcher) {
            Files.openWith(icon.entry.launcher, files, this);
            return true;
        }
        if (icon) {
            if (action === Gdk.DragAction.MOVE)
                Files.moveFiles(files, icon.entry.file);
            else
                Files.copyFiles(files, icon.entry.file);
            return true;
        }

        const cell = this._cellAt(...this._dropOrigin(x, y));
        if (this._drag && action === Gdk.DragAction.MOVE) {
            this._moveIcons(this._drag.icons, this._drag.icon, cell);
            return true;
        }

        // Into the Desktop folder, landing where they were dropped
        const local = files.filter(f => this._folder.equal(f.get_parent()));
        const incoming = files.filter(f => !local.includes(f));
        if (action === Gdk.DragAction.MOVE && incoming.length === 0) {
            // Our own files, dragged from a Files window
            const icons = local.map(f => this._icons.get(f.get_basename())).filter(i => i);
            if (icons.length)
                this._moveIcons(icons, icons[0], cell);
            return icons.length > 0;
        }
        this._expect(action === Gdk.DragAction.MOVE ? incoming.length : files.length, cell);
        if (action === Gdk.DragAction.MOVE)
            Files.moveFiles(incoming, this._folder);
        else
            Files.copyFiles(files, this._folder);
        return true;
    }

    /**
     * Move `icons` so `lead` lands in `cell` and the others keep their
     * places around it, as close as free cells allow.
     */
    _moveIcons(icons, lead, cell) {
        this._freezeCells();
        const moving = new Set(icons);
        const [dc, dr] = [cell[0] - lead.cell[0], cell[1] - lead.cell[1]];
        const taken = new Set([...this._icons.values()]
            .filter(i => !moving.has(i)).map(i => key(i.cell)));
        for (const icon of icons) {
            let target = [
                clamp(icon.cell[0] + dc, 0, this._columns - 1),
                clamp(icon.cell[1] + dr, 0, this._rows - 1),
            ];
            if (taken.has(key(target)))
                target = this._nearestFreeCells(target, taken)[0] ?? icon.cell;
            taken.add(key(target));
            this._cells.set(icon.entry.name, target);
        }
        this._save();
        this._assignCells();
        this.queue_allocate();
    }

    /**
     * Keep `count` cells near `cell` for the next files to show up,
     * whatever Files names them (a copy next to its original is
     * “name (Copy)”).
     */
    _expect(count, cell) {
        this._freezeCells();
        const taken = new Set([...this._cells.values()].map(key));
        this._landing = {
            cells: this._nearestFreeCells(cell, taken).slice(0, count),
            time: GLib.get_monotonic_time(),
        };
        this._save();
    }

    // ---- actions --------------------------------------------------------------------

    _setupActions() {
        const group = new Gio.SimpleActionGroup();
        const add = (name, activate, type = null) => {
            const action = new Gio.SimpleAction({
                name,
                parameter_type: type ? new GLib.VariantType(type) : null,
            });
            action.connect('activate', (_a, param) => activate(param?.deepUnpack()));
            group.add_action(action);
        };
        add('open', () => this._openSelection());
        add('open-with', id => {
            const app = Gio.AppInfo.get_all().find(a => a.get_id() === id);
            if (app)
                Files.openWith(app, this.selectedFiles, this);
        }, 's');
        add('cut', () => this._copy(true));
        add('copy', () => this._copy(false));
        add('paste', () => this.paste());
        add('rename', () => this._startRename());
        add('trash', () => Files.trashFiles(this.selectedFiles));
        add('delete', () => Files.deleteFiles(this.selectedFiles));
        add('properties', () => Files.showProperties(this.selectedFiles));
        add('select-all', () => this.selectAll());
        add('new-folder', () => this.newFolder());
        add('undo', () => Files.undo());
        add('redo', () => Files.redo());
        this._actions = group;
        this.insert_action_group('desk', group);
        this._syncActions();
    }

    _syncActions() {
        const n = this._selection.length;
        const one = n === 1;
        const enable = (name, enabled) => {
            const action = this._actions?.lookup_action(name);
            if (action)
                action.enabled = enabled;
        };
        for (const name of ['open', 'open-with', 'cut', 'copy', 'trash', 'delete', 'properties'])
            enable(name, n > 0);
        enable('rename', one);
    }

    _openSelection() {
        Files.openEntries(this._selection.map(icon => icon.entry), this);
    }

    _copy(cut) {
        const files = this.selectedFiles;
        if (files.length)
            Files.setClipboard(this.get_clipboard(), files, cut);
    }

    /**
     * Paste the files on the clipboard into the Desktop folder, near
     * x, y if given; cut ones are moved.
     */
    async paste(x = null, y = null) {
        if (!this._folder)
            return;
        const {files, cut} = await Files.readClipboard(this.get_clipboard());
        if (files.length === 0)
            return;
        const cell = x === null ? this._firstFreeCell() : this._cellAt(x, y);
        if (cut) {
            const incoming = files.filter(f => !this._folder.equal(f.get_parent()));
            this._expect(incoming.length, cell);
            Files.moveFiles(incoming, this._folder);
        } else {
            this._expect(files.length, cell);
            Files.copyFiles(files, this._folder);
        }
    }

    _firstFreeCell() {
        const taken = new Set([...this._icons.values()].map(i => key(i.cell)));
        return this._freeCells(taken).next().value ?? [0, 0];
    }

    /**
     * Make a folder in the Desktop folder, near x, y if given. Without a
     * name, it's “New Folder” and its name can be typed straight away.
     */
    newFolder(name = null, x = null, y = null) {
        if (!this._folder)
            return;
        const folderName = Files.freeName(this._folder, name || 'New Folder');
        const cell = x === null ? this._firstFreeCell() : this._cellAt(x, y);
        this._freezeCells();
        const taken = new Set([...this._cells.values()].map(key));
        this._cells.set(folderName, this._nearestFreeCells(cell, taken)[0] ?? cell);
        this._pending.set(folderName, GLib.get_monotonic_time());
        this._save();
        if (!name)
            this._renameWhenShown = folderName;
        Files.createFolder(this._folder, folderName);
    }

    // ---- menus and renaming -------------------------------------------------------------

    _popupIconMenu(x, y) {
        const selection = this._selection;
        const menu = new Gio.Menu();

        const open = new Gio.Menu();
        open.append('Open', 'desk.open');
        const types = new Set(selection.map(i => i.entry.contentType));
        if (types.size === 1 && !selection[0].entry.launcher) {
            const apps = Files.appsFor(selection[0].entry.contentType);
            if (apps.length) {
                const openWith = new Gio.Menu();
                for (const app of apps) {
                    const item = Gio.MenuItem.new(app.get_display_name(), null);
                    item.set_action_and_target_value('desk.open-with',
                        new GLib.Variant('s', app.get_id()));
                    openWith.append_item(item);
                }
                open.append_submenu('Open With', openWith);
            }
        }
        menu.append_section(null, open);

        const edit = new Gio.Menu();
        edit.append('Cut', 'desk.cut');
        edit.append('Copy', 'desk.copy');
        if (selection.length === 1)
            edit.append('Rename…', 'desk.rename');
        menu.append_section(null, edit);

        const remove = new Gio.Menu();
        remove.append('Move to Trash', 'desk.trash');
        menu.append_section(null, remove);

        const props = new Gio.Menu();
        props.append('Properties', 'desk.properties');
        menu.append_section(null, props);

        this._showMenu(menu, x, y);
    }

    _showMenu(model, x, y) {
        this._menu?.unparent();
        const menu = this._menu = Gtk.PopoverMenu.new_from_model(model);
        menu.set_parent(this);
        menu.has_arrow = false;
        menu.halign = Gtk.Align.START;
        menu.pointing_to = new Gdk.Rectangle({x, y, width: 1, height: 1});
        menu.connect('closed', () => {
            // Unparenting during the signal breaks its actions
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._menu === menu) {
                    menu.unparent();
                    this._menu = null;
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.popup();
    }

    _startRename(icon = this._selection[0]) {
        if (!icon)
            return;
        const {entry} = icon;
        const popover = new Gtk.Popover({css_classes: ['desktop-rename']});
        const entryWidget = new Gtk.Entry({
            text: entry.displayName,
            width_chars: 24,
            activates_default: false,
        });
        popover.set_child(entryWidget);
        popover.set_parent(this);
        // Its cell, as it may not be laid out yet
        popover.pointing_to = new Gdk.Rectangle(this._cellRect(icon.cell));
        popover.position = Gtk.PositionType.BOTTOM;

        entryWidget.connect('activate', () => {
            const name = entryWidget.text.trim();
            popover.popdown();
            if (!name || name === entry.displayName || name.includes('/'))
                return;
            const cell = this._cells.get(entry.name) ?? icon.cell;
            this._cells.set(name, cell);
            this._pending.set(name, GLib.get_monotonic_time());
            this._save();
            Files.renameFile(entry.file, name);
        });
        popover.connect('closed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                popover.unparent();
                return GLib.SOURCE_REMOVE;
            });
            this.grab_focus();
        });
        popover.popup();
        entryWidget.grab_focus();
        // The name without its extension, as Files does
        const dot = entry.isDir ? -1 : entry.displayName.lastIndexOf('.');
        entryWidget.select_region(0, dot > 0 ? dot : -1);
    }

    // ---- keyboard -------------------------------------------------------------------------

    _setupKeys() {
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) =>
            this._onKeyPressed(keyval, state));
        this.add_controller(keys);
    }

    _onKeyPressed(keyval, state) {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const activate = name => {
            if (this._actions.lookup_action(name)?.enabled)
                this._actions.activate_action(name, null);
            return Gdk.EVENT_STOP;
        };
        const lower = Gdk.keyval_to_lower(keyval);

        if (ctrl) {
            switch (lower) {
            case Gdk.KEY_a: return activate('select-all');
            case Gdk.KEY_c: return activate('copy');
            case Gdk.KEY_x: return activate('cut');
            case Gdk.KEY_v: return activate('paste');
            case Gdk.KEY_z: return activate(shift ? 'redo' : 'undo');
            case Gdk.KEY_y: return activate('redo');
            case Gdk.KEY_n: return shift ? activate('new-folder') : Gdk.EVENT_PROPAGATE;
            case Gdk.KEY_o: return activate('open');
            case Gdk.KEY_i: return activate('properties');
            }
            return Gdk.EVENT_PROPAGATE;
        }

        switch (keyval) {
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            return activate('open');
        case Gdk.KEY_Delete:
        case Gdk.KEY_KP_Delete:
            return activate(shift ? 'delete' : 'trash');
        case Gdk.KEY_F2:
            return activate('rename');
        case Gdk.KEY_Escape:
            this.unselectAll();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Menu:
        case Gdk.KEY_F10:
            if (keyval === Gdk.KEY_F10 && !shift)
                return Gdk.EVENT_PROPAGATE;
            if (this._anchor?.selected) {
                const {rect} = this._anchor;
                this._popupIconMenu(rect.x + rect.width / 2, rect.y + rect.height / 2);
            }
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Left: return this._moveSelection(-1, 0, shift);
        case Gdk.KEY_Right: return this._moveSelection(1, 0, shift);
        case Gdk.KEY_Up: return this._moveSelection(0, -1, shift);
        case Gdk.KEY_Down: return this._moveSelection(0, 1, shift);
        }
        return Gdk.EVENT_PROPAGATE;
    }

    /** Select the nearest icon from the anchor towards dc, dr. */
    _moveSelection(dc, dr, add) {
        const icons = [...this._icons.values()];
        if (icons.length === 0)
            return Gdk.EVENT_STOP;
        const from = this._anchor ?? null;
        if (!from) {
            this._select([this._sortedIcons()[0]]);
            return Gdk.EVENT_STOP;
        }
        const [c, r] = from.cell;
        const candidates = icons.filter(icon => {
            const [ic, ir] = icon.cell;
            return icon !== from &&
                (dc ? Math.sign(ic - c) === dc : Math.sign(ir - r) === dr);
        });
        // Mostly along the direction, a little across it
        const score = icon => {
            const [ic, ir] = icon.cell;
            const along = dc ? Math.abs(ic - c) : Math.abs(ir - r);
            const across = dc ? Math.abs(ir - r) : Math.abs(ic - c);
            return along + across * 2;
        };
        const next = candidates.sort((a, b) => score(a) - score(b))[0];
        if (next)
            this._select([next], {add});
        return Gdk.EVENT_STOP;
    }

    // ---- config ----------------------------------------------------------------------------

    _load() {
        const cells = new Map();
        for (const path of [CONFIG_PATH, OLD_CONFIG_PATH]) {
            try {
                const [, bytes] = GLib.file_get_contents(path);
                const config = JSON.parse(decoder.decode(bytes));
                for (const [name, cell] of Object.entries(config.cells ?? {})) {
                    if (Array.isArray(cell) && cell.length === 2 &&
                        cell.every(n => Number.isInteger(n) && n >= 0))
                        cells.set(name, cell);
                }
                break;
            } catch (e) {
                if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                    console.warn(`Failed to load ${path}: ${e.message}`);
            }
        }
        return {cells};
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG_PATH), 0o755);
            GLib.file_set_contents(CONFIG_PATH, encoder.encode(
                JSON.stringify({cells: Object.fromEntries(this._cells)}, null, 2)));
        } catch (e) {
            console.warn(`Failed to save the desktop icons: ${e.message}`);
        }
    }
});

function key([col, row]) {
    return `${col},${row}`;
}

function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

function allocateAt(widget, x, y, width, height) {
    const transform = new Gsk.Transform().translate(new Graphene.Point({x, y}));
    widget.allocate(width, height, -1, transform);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
