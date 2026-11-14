import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../main.js';
import {UnalignedLayoutStrategy} from '../workspace.js';

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const ANIMATION_TIME = 250;
const PADDING = 32;
const SPACING = 24;
const HIGHLIGHT_WIDTH = 4;
const TITLE_GAP = 8;
// As in the overview's WorkspaceLayout
const LAYOUT_SCALE_WEIGHT = 1;
const LAYOUT_SPACE_WEIGHT = 0.1;

/**
 * Exposé: spreads out the windows of the current workspace, each on
 * its own monitor, without leaving the desktop. The windows are live
 * clones. A click on one, or the arrow keys and Enter, focuses it;
 * Escape or a click on the background goes back.
 */
export class Expose {
    constructor() {
        this._layer = null;
        this._closing = false;

        Main.wm.addKeybinding('toggle-expose',
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => this.toggle());
    }

    get isOpen() {
        return !!this._layer && !this._closing;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._layer)
            return;
        const windows = global.display.sort_windows_by_stacking(
            global.workspace_manager.get_active_workspace().list_windows()
                .filter(w => w.showing_on_its_workspace() && !w.skip_taskbar &&
                    w.get_compositor_private()));
        if (!windows.length)
            return;

        this._layer = new St.Widget({
            reactive: true,
            can_focus: true,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._background = new St.Widget({
            style_class: 'expose-background',
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });
        this._layer.add_child(this._background);
        this._highlight = new St.Widget({style_class: 'expose-highlight', visible: false});
        this._layer.add_child(this._highlight);

        this._items = windows.map(window => this._addItem(window));
        this._title = new St.Label({style_class: 'expose-title', visible: false});
        this._layer.add_child(this._title);

        Main.uiGroup.add_child(this._layer);
        Main.uiGroup.set_child_above_sibling(this._layer, null);
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        this._layer.connect('button-release-event', (_a, event) => this._onRelease(event));
        this._layer.connect('key-press-event', (_a, event) => this._onKeyPress(event));

        this._layoutSlots();
        this._background.ease({
            opacity: 255,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        for (const item of this._items)
            this._easeClone(item, item.slot);

        const focus = this._items.find(i => i.window === global.display.focus_window);
        this._select(focus ?? this._items.at(-1));
    }

    /**
     * Go back to the desktop, focusing `window` if one was picked.
     *
     * @param {Meta.Window} [window]
     */
    close(window = null) {
        if (!this._layer || this._closing)
            return;
        this._closing = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._highlight.hide();
        this._title.hide();

        const picked = this._items.find(i => i.window === window);
        if (picked) {
            this._layer.set_child_above_sibling(picked.clone, null);
            Main.activateWindow(window);
        }

        this._background.ease({
            opacity: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._destroyLayer(),
        });
        for (const item of this._items)
            this._easeClone(item, null);
    }

    _addItem(window) {
        const actor = window.get_compositor_private();
        const clone = new Clutter.Clone({
            source: actor,
            reactive: true,
            x: actor.x,
            y: actor.y,
            width: actor.width,
            height: actor.height,
        });
        const item = {window, actor, clone, slot: null};
        clone.connect('enter-event', () => this._select(item));
        // A window that goes away takes its clone with it
        actor.connectObject('destroy', () => {
            clone.destroy();
            this._items = this._items.filter(i => i !== item);
            if (this._selected === item)
                this._select(this._items[0] ?? null);
        }, clone);
        this._layer.add_child(clone);
        // The clone stands in for the window until the end
        actor.opacity = 0;
        return item;
    }

    _destroyLayer() {
        for (const {actor} of this._items ?? [])
            actor.opacity = 255;
        this._items = [];
        this._layer?.destroy();
        this._layer = null;
        this._selected = null;
        this._closing = false;
    }

    /** Lay out each monitor's windows like the overview does. */
    _layoutSlots() {
        const byMonitor = new Map();
        for (const item of this._items) {
            const index = item.window.get_monitor();
            if (!byMonitor.has(index))
                byMonitor.set(index, []);
            byMonitor.get(index).push(item);
        }
        for (const [index, items] of byMonitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
            const area = {
                x: workArea.x + PADDING,
                y: workArea.y + PADDING,
                width: workArea.width - 2 * PADDING,
                height: workArea.height - 2 * PADDING,
            };
            const entries = items.map(item => {
                const r = item.window.get_frame_rect();
                return {
                    item,
                    boundingBox: {x: r.x, y: r.y, width: r.width, height: r.height},
                    windowCenter: {x: r.x + r.width / 2, y: r.y + r.height / 2},
                };
            });
            const strategy = new UnalignedLayoutStrategy({
                monitor: Main.layoutManager.monitors[index],
                rowSpacing: SPACING,
                columnSpacing: SPACING,
            });
            const layout = bestLayout(strategy, entries, area);
            for (const [x, y, width, height, entry] of strategy.computeWindowSlots(layout, area))
                entry.item.slot = {x, y, width, height};
        }
    }

    /**
     * Move a clone so its window's frame fills `slot`, or back over
     * the window when `slot` is null.
     */
    _easeClone({window, actor, clone}, slot) {
        let x = actor.x, y = actor.y, width = actor.width, height = actor.height;
        if (slot) {
            // The actor is bigger than the frame by its shadows
            const frame = window.get_frame_rect();
            const s = slot.width / frame.width;
            x = slot.x - (frame.x - actor.x) * s;
            y = slot.y - (frame.y - actor.y) * s;
            width *= s;
            height *= s;
        }
        clone.ease({
            x, y, width, height,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _select(item) {
        this._selected = item;
        if (!item?.slot || this._closing) {
            this._highlight.hide();
            this._title.hide();
            return;
        }
        const {x, y, width, height} = item.slot;
        this._highlight.set({
            x: x - HIGHLIGHT_WIDTH,
            y: y - HIGHLIGHT_WIDTH,
            width: width + 2 * HIGHLIGHT_WIDTH,
            height: height + 2 * HIGHLIGHT_WIDTH,
            visible: true,
        });
        this._layer.set_child_below_sibling(this._highlight, item.clone);

        const tracker = Shell.WindowTracker.get_default();
        this._title.text = item.window.title ||
            tracker.get_window_app(item.window)?.get_name() || '';
        const [, , tw, th] = this._title.get_preferred_size();
        const monitor = Main.layoutManager.monitors[item.window.get_monitor()];
        this._title.set_position(
            Math.round(Math.clamp(x + (width - tw) / 2, monitor.x, monitor.x + monitor.width - tw)),
            Math.round(Math.min(y + height + TITLE_GAP, monitor.y + monitor.height - th)));
        this._title.show();
        this._layer.set_child_above_sibling(this._title, null);
    }

    _onRelease(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        const target = global.stage.get_event_actor(event);
        this.close(this._items.find(i => i.clone === target)?.window ?? null);
        return Clutter.EVENT_STOP;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const super_ = (event.get_state() & Clutter.ModifierType.MOD4_MASK) !== 0;
        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            this.close(this._selected?.window ?? null);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const back = symbol === Clutter.KEY_ISO_Left_Tab ||
                (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            const n = this._items.length;
            const i = this._items.indexOf(this._selected);
            this._select(this._items[(i + (back ? n - 1 : 1)) % n]);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Left:
            this._selectToward(-1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._selectToward(1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._selectToward(0, -1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._selectToward(0, 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_e:
        case Clutter.KEY_E:
            // The keybinding isn't active while this is modal
            if (super_)
                this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    /** Select the nearest window whose slot lies in direction dx, dy. */
    _selectToward(dx, dy) {
        const from = this._selected?.slot;
        if (!from) {
            this._select(this._items[0] ?? null);
            return;
        }
        const center = s => [s.x + s.width / 2, s.y + s.height / 2];
        const [fx, fy] = center(from);
        let best = null, bestCost = Infinity;
        for (const item of this._items) {
            if (item === this._selected || !item.slot)
                continue;
            const [cx, cy] = center(item.slot);
            const along = (cx - fx) * dx + (cy - fy) * dy;
            if (along <= 0)
                continue;
            const across = Math.abs((cx - fx) * dy) + Math.abs((cy - fy) * dx);
            const cost = along + 2 * across;
            if (cost < bestCost) {
                best = item;
                bestCost = cost;
            }
        }
        if (best)
            this._select(best);
    }
}

/** The overview's choice of row count: add rows while it pays off. */
function bestLayout(strategy, entries, area) {
    let last = null, lastColumns = -1, lastScale = 0, lastSpace = 0;
    for (let rows = 1; ; rows++) {
        const columns = Math.ceil(entries.length / rows);
        if (columns === lastColumns)
            break;
        const layout = strategy.computeLayout(entries, {numRows: rows});
        const [scale, space] = strategy.computeScaleAndSpace(layout, area);
        if (last && !isBetter(lastScale, lastSpace, scale, space))
            break;
        last = layout;
        lastColumns = columns;
        lastScale = scale;
        lastSpace = space;
    }
    return last;
}

function isBetter(oldScale, oldSpace, scale, space) {
    const spacePower = (space - oldSpace) * LAYOUT_SPACE_WEIGHT;
    const scalePower = (scale - oldScale) * LAYOUT_SCALE_WEIGHT;
    if (scale > oldScale && space > oldSpace)
        return true;
    if (scale > oldScale)
        return scalePower > spacePower;
    if (space > oldSpace)
        return spacePower > scalePower;
    return false;
}
