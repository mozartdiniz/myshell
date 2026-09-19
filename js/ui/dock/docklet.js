import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const TILE_SIZE = 64;

/**
 * Base class for a dock tile. Subclasses override `tick()` and
 * `interval` for live content, and handle `clicked` for actions.
 */
export const Docklet = GObject.registerClass({
    Properties: {
        'corner': GObject.ParamSpec.string(
            'corner', null, null,
            GObject.ParamFlags.READWRITE,
            'top-right'),
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
            x_expand: false,
            y_expand: false,
            ...params,
        });

        this._tickId = 0;
        this.connect('notify::mapped', () => this._syncTimer());
        this.connect('destroy', () => this._stopTimer());
    }

    /** ms between tick() calls; 0 disables */
    get interval() {
        return 0;
    }

    tick() {
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

    /** Side a popup menu should open towards, based on corner. */
    get menuSide() {
        return this.corner.endsWith('right') ? St.Side.RIGHT : St.Side.LEFT;
    }
});
