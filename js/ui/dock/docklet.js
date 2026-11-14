import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const TILE_SIZE = 64;

/**
 * Base class for a free-floating tile. Every tile is its own chrome
 * actor: it can be dragged anywhere and docks to the nearest screen
 * corner when released. Subclasses override `tick()` and `interval`
 * for live content, and handle `clicked` for actions.
 */
export const Docklet = GObject.registerClass({
    Signals: {
        'drag-begin': {},
        'drag-end': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    },
}, class Docklet extends St.Button {
    _init(params = {}) {
        super._init({
            style_class: 'docklet',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            width: TILE_SIZE,
            height: TILE_SIZE,
            ...params,
        });

        /** @type {{edge: string, slot: number, depth: number}|null} */
        this.placement = null;

        this._tickId = 0;
        this.connect('notify::mapped', () => this._syncTimer());
        this.connect('destroy', () => this._stopTimer());

        this._panGesture = new Clutter.PanGesture({begin_threshold: 8});
        this._panGesture.connect('recognize', () => this._onDragBegin());
        this._panGesture.connect('pan-update', () => this._onDragUpdate());
        this._panGesture.connect('end', () => this._onDragEnd());
        this._panGesture.connect('cancel', () => this._onDragEnd());
        this.add_action(this._panGesture);
    }

    /** Stable id used for persistence, e.g. 'clock' or 'app:foo.desktop' */
    get id() {
        return this.constructor.name;
    }

    /** ms between tick() calls; 0 disables */
    get interval() {
        return 0;
    }

    tick() {
    }

    /** Whether files dragged from apps can be dropped on the tile. */
    get acceptsFiles() {
        return false;
    }

    /**
     * Called with the files dropped on the tile.
     *
     * @param {string[]} _uris
     */
    dropFiles(_uris) {
    }

    _syncTimer() {
        if (this.mapped && this.interval > 0)
            this._startTimer();
        else
            this._stopTimer();
    }

    _startTimer() {
        if (this._tickId)
            return;
        this.tick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.interval, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    _onDragBegin() {
        // Gesture centroids are actor-relative; use stage-space pointer
        // coordinates so moving the actor doesn't feed back into the drag.
        const [px, py] = global.get_pointer();
        this._dragOffset = [px - this.x, py - this.y];
        this._grab = global.stage.grab(this);
        this.get_parent()?.set_child_above_sibling(this, null);
        this.add_style_pseudo_class('dragging');
        this.emit('drag-begin');
    }

    _onDragUpdate() {
        const [px, py] = global.get_pointer();
        const [dx, dy] = this._dragOffset;
        this.set_position(Math.round(px - dx), Math.round(py - dy));
    }

    _onDragEnd() {
        if (!this._grab)
            return;
        this._grab.dismiss();
        this._grab = null;
        this.remove_style_pseudo_class('dragging');
        this.emit('drag-end', this.x, this.y);
    }

    /** Side of the tile a popup menu's arrow should sit on. */
    get menuSide() {
        switch (this.placement?.edge) {
        case 'right': return St.Side.RIGHT;
        case 'top': return St.Side.TOP;
        case 'bottom': return St.Side.BOTTOM;
        default: return St.Side.LEFT;
        }
    }
});
