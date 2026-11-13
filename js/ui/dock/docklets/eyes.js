import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet} from '../applet.js';

const SCLERA = [0.96, 0.96, 0.96];
const OUTLINE = [0.05, 0.05, 0.05];
const PUPIL = [0.07, 0.07, 0.07];
// The tile's own background, so a lid looks like the eye closing
const LID = [0.17, 0.17, 0.17];

const OUTLINE_WIDTH = 2.5;
const PUPIL_RADIUS = 4.5;

const BLINK_TIME = 180;
const BLINK_FRAME = 16;
// A blink comes every BLINK_MIN to BLINK_MAX ms
const BLINK_MIN = 3000;
const BLINK_MAX = 9000;

/**
 * Where a pupil sits: toward the pointer, but inside the ellipse with
 * radii a, b it can move in.
 *
 * @param {number} dx - pointer x relative to the eye's center
 * @param {number} dy - pointer y relative to the eye's center
 * @param {number} a
 * @param {number} b
 * @returns {number[]} the pupil's offset from the eye's center
 */
function pupilOffset(dx, dy, a, b) {
    const k = Math.hypot(dx / a, dy / b);
    return k > 1 ? [dx / k, dy / k] : [dx, dy];
}

/** Traces an ellipse with the current line width unscaled. */
function ellipse(cr, cx, cy, rx, ry) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
}

/** A pair of eyes that watches the pointer wherever it goes. */
export const EyesDocklet = GObject.registerClass(
class EyesDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        /** pointer in stage coordinates */
        this._pointer = global.get_pointer().slice(0, 2);
        /** 0 = open, 1 = closed */
        this._lid = 0;
        this._blinkStart = 0;
        this._blinkFrameId = 0;
        this._nextBlinkId = 0;

        // Clutter only sees motion over the shell's own actors; the
        // cursor tracker reports it over windows too
        this._cursorTracker = global.backend.get_cursor_tracker();
        this.connect('notify::mapped', () => this._syncTracking());
        this.connect('destroy', () => {
            this._cursorTracker.disconnectObject(this);
            this._stopBlinking();
        });
    }

    get defaults() {
        return {blink: true};
    }

    activate() {
        this._blink();
    }

    buildMenu(menu) {
        this.addToggle(menu, _('Blink Now and Then'), 'blink');
    }

    settingsChanged() {
        this._syncTracking();
    }

    _syncTracking() {
        this._cursorTracker.disconnectObject(this);
        this._stopBlinking();
        if (!this.mapped)
            return;

        this._cursorTracker.connectObject('position-invalidated',
            () => this._onPointerMoved(), this);
        this._onPointerMoved();
        if (this.settings.blink)
            this._scheduleBlink();
    }

    _onPointerMoved() {
        const [x, y] = global.get_pointer();
        if (x === this._pointer[0] && y === this._pointer[1])
            return;
        this._pointer = [x, y];
        this._area.queue_repaint();
    }

    // ---- blinking ----------------------------------------------------

    _scheduleBlink() {
        const delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        this._nextBlinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._nextBlinkId = 0;
            this._blink();
            this._scheduleBlink();
            return GLib.SOURCE_REMOVE;
        });
    }

    _blink() {
        if (this._blinkFrameId)
            return;
        this._blinkStart = GLib.get_monotonic_time();
        this._blinkFrameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_FRAME, () => {
            // Down and back up again
            const t = (GLib.get_monotonic_time() - this._blinkStart) / 1000 / BLINK_TIME;
            this._lid = t < 1 ? 1 - Math.abs(2 * t - 1) : 0;
            this._area.queue_repaint();
            if (t < 1)
                return GLib.SOURCE_CONTINUE;
            this._blinkFrameId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopBlinking() {
        if (this._nextBlinkId)
            GLib.source_remove(this._nextBlinkId);
        this._nextBlinkId = 0;
        if (this._blinkFrameId)
            GLib.source_remove(this._blinkFrameId);
        this._blinkFrameId = 0;
        this._lid = 0;
    }

    // ---- drawing -----------------------------------------------------

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [ax, ay] = area.get_transformed_position();
        const [px, py] = [this._pointer[0] - ax, this._pointer[1] - ay];

        const rx = w * 0.2;
        const ry = h * 0.32;
        const cy = h / 2;
        // room a pupil has to move in, so it stays inside the outline
        const a = rx - PUPIL_RADIUS - OUTLINE_WIDTH - 1;
        const b = ry - PUPIL_RADIUS - OUTLINE_WIDTH - 1;

        cr.setLineWidth(OUTLINE_WIDTH);
        for (const cx of [w / 2 - rx - 2, w / 2 + rx + 2]) {
            ellipse(cr, cx, cy, rx, ry);
            cr.setSourceRGBA(...SCLERA, 1);
            cr.fill();

            const [ox, oy] = pupilOffset(px - cx, py - cy, a, b);
            cr.arc(cx + ox, cy + oy, PUPIL_RADIUS, 0, 2 * Math.PI);
            cr.setSourceRGBA(...PUPIL, 1);
            cr.fill();

            if (this._lid > 0) {
                const edge = cy - ry + 2 * ry * this._lid;
                cr.save();
                ellipse(cr, cx, cy, rx, ry);
                cr.clip();
                cr.rectangle(cx - rx, cy - ry, 2 * rx, edge - (cy - ry));
                cr.setSourceRGBA(...LID, 1);
                cr.fill();
                // the lid's edge, as wide as the eye at that height
                const half = rx * Math.sqrt(Math.max(0, 1 - ((edge - cy) / ry) ** 2));
                cr.moveTo(cx - half, edge);
                cr.lineTo(cx + half, edge);
                cr.setSourceRGBA(...OUTLINE, 1);
                cr.stroke();
                cr.restore();
            }

            ellipse(cr, cx, cy, rx, ry);
            cr.setSourceRGBA(...OUTLINE, 1);
            cr.stroke();
        }
        cr.$dispose();
    }
});
