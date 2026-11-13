import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from '../../grabHelper.js';
import * as Main from '../../main.js';
import {Applet} from '../applet.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

const ZOOM = 10; // loupe pixels per screen pixel
const LOUPE_PIXELS = 15; // screen pixels across the loupe; odd, so one is in the middle
const LOUPE_SIZE = ZOOM * LOUPE_PIXELS;
const RING_WIDTH = 5;
const READOUT_GAP = 8;

const HOVER_TIME = 400;

const ARROW_STEPS = {
    [Clutter.KEY_Left]: [-1, 0],
    [Clutter.KEY_Right]: [1, 0],
    [Clutter.KEY_Up]: [0, -1],
    [Clutter.KEY_Down]: [0, 1],
};

/**
 * @param {{red: number, green: number, blue: number}} color
 * @returns {string} '#RRGGBB'
 */
function toHex({red, green, blue}) {
    return `#${[red, green, blue]
        .map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * @param {string} hex - '#RRGGBB'
 * @returns {{red: number, green: number, blue: number}|null}
 */
function fromHex(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    if (!m)
        return null;
    const [red, green, blue] = m.slice(1).map(c => parseInt(c, 16));
    return {red, green, blue};
}

function toRgb({red, green, blue}) {
    return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * @param {{red: number, green: number, blue: number}} color
 * @returns {number} perceived lightness, 0–1
 */
function luminance(color) {
    return (0.299 * color.red + 0.587 * color.green + 0.114 * color.blue) / 255;
}

/**
 * Exact color of one pixel of `texture`, in texture pixels.
 *
 * @param {Cogl.Texture} texture
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{red: number, green: number, blue: number}>}
 */
async function readPixel(texture, x, y) {
    const stream = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture, x, y, 1, 1, 1, null, 0, 0, 1, stream);
    stream.close(null);
    const [red, green, blue] = pixbuf.read_pixel_bytes().toArray();
    return {red, green, blue};
}

/** Cuts an actor to the circle inscribed in it, with a 1px soft edge. */
const CircleMaskEffect = GObject.registerClass(
class CircleMaskEffect extends Clutter.ShaderEffect {
    _init(params) {
        super._init(params);
        this.set_uniform_float('feather', 1, [1 / LOUPE_SIZE]);
    }

    vfunc_get_static_snippet() {
        const decl = 'uniform float feather;\n';
        const src = `
            float r = length(cogl_tex_coord_in[0].xy - vec2(0.5));      \n
            cogl_color_out *= 1.0 - smoothstep(0.5 - feather, 0.5, r);  \n`;
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, src);
    }
});

/**
 * Full-screen picker: freezes the screen, hides the pointer and shows a
 * round loupe of the pixels around it. A primary click or Enter picks
 * the pixel in the loupe's center square; the arrow keys move it one
 * pixel at a time; Esc or a secondary click cancels.
 */
const ColorPickOverlay = GObject.registerClass(
class ColorPickOverlay extends St.Widget {
    /**
     * @param {Clutter.TextureContent} content - frozen screen
     */
    _init(content) {
        super._init({
            reactive: true,
            can_focus: true,
            width: global.stage.width,
            height: global.stage.height,
        });
        this.set_cursor_type(Clutter.CursorType.NONE);

        this._texture = content.get_texture();
        this._width = this._texture.get_width();
        this._height = this._texture.get_height();
        // Texture pixels per stage pixel; above 1 on HiDPI screens
        this._scale = this._width / global.stage.width;

        this._result = null;
        this._color = null;
        this._pixel = null;
        this._wanted = null;
        this._reading = null;
        this._picking = false;
        this._done = false;

        // The frozen screen, so what's under the loupe is what's shown
        this.add_child(new Clutter.Actor({
            content,
            width: global.stage.width,
            height: global.stage.height,
        }));

        this._loupe = new St.Widget({
            width: LOUPE_SIZE,
            height: LOUPE_SIZE,
            clip_to_allocation: true,
            effect: new CircleMaskEffect(),
        });
        this._zoomed = new Clutter.Actor({
            content,
            width: this._width * ZOOM,
            height: this._height * ZOOM,
        });
        this._zoomed.set_content_scaling_filters(
            Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        this._loupe.add_child(this._zoomed);
        this._overlay = new St.DrawingArea({
            width: LOUPE_SIZE,
            height: LOUPE_SIZE,
        });
        this._overlay.connect('repaint', a => this._repaintOverlay(a));
        this._loupe.add_child(this._overlay);
        this.add_child(this._loupe);

        this._readout = new St.Label({style_class: 'color-picker-readout'});
        this.add_child(this._readout);

        const click = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY});
        click.connect('recognize', () => {
            const {x, y} = click.get_coords_abs();
            this._moveTo(x * this._scale, y * this._scale);
            this._pick();
        });
        this.add_action(click);

        const cancel = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY});
        cancel.connect('recognize', () => this._finish());
        this.add_action(cancel);

        const motion = new Clutter.MotionController();
        motion.connect('motion', (_c, _sprite, x, y) =>
            this._moveTo(x * this._scale, y * this._scale));
        this.add_action(motion);

        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => this._onKeyPress(keys));
        this.add_action(keys);

        this._grabHelper = new GrabHelper.GrabHelper(this);
    }

    /**
     * @returns {Promise<{red: number, green: number, blue: number}|null>}
     *   the picked color, or null if cancelled
     */
    async pickAsync() {
        Main.uiGroup.add_child(this);
        Main.uiGroup.set_child_above_sibling(this, null);

        const [x, y] = global.get_pointer();
        this._moveTo(x * this._scale, y * this._scale);

        try {
            await this._grabHelper.grabAsync({actor: this, focus: this});
        } finally {
            this._done = true;
            GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => this.destroy());
        }
        return this._result;
    }

    _onKeyPress(keys) {
        const [, key] = keys.get_key();
        const step = ARROW_STEPS[key];
        if (step && this._pixel) {
            const [px, py] = this._pixel;
            this._moveTo(px + step[0] + 0.5, py + step[1] + 0.5);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter ||
            key === Clutter.KEY_space) {
            this._pick();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Center the loupe on a texture position.
     *
     * @param {number} x
     * @param {number} y
     */
    _moveTo(x, y) {
        const px = Math.clamp(Math.floor(x), 0, this._width - 1);
        const py = Math.clamp(Math.floor(y), 0, this._height - 1);
        if (this._pixel?.[0] === px && this._pixel?.[1] === py)
            return;
        this._pixel = [px, py];

        // Center of the pixel, in stage coordinates
        const cx = (px + 0.5) / this._scale;
        const cy = (py + 0.5) / this._scale;
        this._loupe.set_position(
            Math.round(cx - LOUPE_SIZE / 2), Math.round(cy - LOUPE_SIZE / 2));
        const middle = (LOUPE_SIZE - ZOOM) / 2;
        this._zoomed.set_position(middle - px * ZOOM, middle - py * ZOOM);
        this._placeReadout();

        this._wanted = [px, py];
        if (!this._reading)
            this._reading = this._readWanted();
    }

    /** Read the latest wanted pixel, skipping any passed over meanwhile. */
    async _readWanted() {
        try {
            while (this._wanted && !this._done) {
                const [px, py] = this._wanted;
                this._wanted = null;
                // eslint-disable-next-line no-await-in-loop
                const color = await readPixel(this._texture, px, py);
                if (!this._done)
                    this._setColor(color);
            }
        } catch (e) {
            logError(e, 'Color picker: failed to read pixel');
        } finally {
            this._reading = null;
        }
    }

    _setColor(color) {
        this._color = color;
        this._readout.text = toHex(color);
        this._overlay.queue_repaint();
        this._placeReadout();
    }

    /** Readout below the loupe, or above it near the bottom of the monitor. */
    _placeReadout() {
        const [, , w, h] = this._readout.get_preferred_size();
        const x = this._loupe.x + (LOUPE_SIZE - w) / 2;
        let y = this._loupe.y + LOUPE_SIZE + READOUT_GAP;
        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()];
        if (monitor && y + h > monitor.y + monitor.height)
            y = this._loupe.y - READOUT_GAP - h;
        this._readout.set_position(Math.round(x), Math.round(y));
    }

    async _pick() {
        if (this._done || this._picking || !this._pixel)
            return;
        this._picking = true;
        await this._reading;
        const [px, py] = this._pixel;
        try {
            this._result = await readPixel(this._texture, px, py);
        } catch (e) {
            logError(e, 'Color picker: failed to read pixel');
        }
        this._finish();
    }

    _finish() {
        this._grabHelper.ungrab({actor: this});
    }

    _repaintOverlay(area) {
        const cr = area.get_context();
        const r = LOUPE_SIZE / 2;

        // Pixel grid, faint enough not to change how the colors read
        cr.save();
        cr.arc(r, r, r, 0, 2 * Math.PI);
        cr.clip();
        cr.setLineWidth(1);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
        for (let i = ZOOM; i < LOUPE_SIZE; i += ZOOM) {
            cr.moveTo(i + 0.5, 0);
            cr.lineTo(i + 0.5, LOUPE_SIZE);
            cr.moveTo(0, i + 0.5);
            cr.lineTo(LOUPE_SIZE, i + 0.5);
        }
        cr.stroke();
        cr.restore();

        // The picked pixel: dark and light outline, visible on any color
        const middle = (LOUPE_SIZE - ZOOM) / 2;
        cr.setLineWidth(1);
        cr.setSourceRGBA(0, 0, 0, 0.9);
        cr.rectangle(middle - 0.5, middle - 0.5, ZOOM + 1, ZOOM + 1);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.rectangle(middle + 0.5, middle + 0.5, ZOOM - 1, ZOOM - 1);
        cr.stroke();

        // Ring in the color under the center square
        const ring = this._color ?? {red: 43, green: 43, blue: 43};
        cr.setLineWidth(RING_WIDTH);
        cr.setSourceRGBA(ring.red / 255, ring.green / 255, ring.blue / 255, 1);
        cr.arc(r, r, r - RING_WIDTH / 2, 0, 2 * Math.PI);
        cr.stroke();
        cr.setLineWidth(1);
        cr.setSourceRGBA(0.08, 0.08, 0.08, 1);
        cr.arc(r, r, r - 0.5, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(0.35, 0.35, 0.35, 1);
        cr.arc(r, r, r - RING_WIDTH - 0.5, 0, 2 * Math.PI);
        cr.stroke();

        cr.$dispose();
    }
});

/**
 * Eyedropper. Click to pick a color anywhere on screen; it is copied to
 * the clipboard as #RRGGBB and shown on the tile with its RGB values.
 */
export const ColorPickerDocklet = GObject.registerClass(
class ColorPickerDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'color-picker-docklet'});

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._swatch = new St.Widget({
            style_class: 'applet-color-swatch',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hex = new St.Label({
            style_class: 'applet-small',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._rgb = new St.Label({
            style_class: 'applet-small applet-color-rgb',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._swatch);
        box.add_child(this._hex);
        box.add_child(this._rgb);
        this.set_child(box);

        this._picking = false;

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });

        this._sync();
    }

    get defaults() {
        return {color: null};
    }

    settingsChanged() {
        this._sync();
    }

    buildMenu(menu) {
        menu.addAction(_('Pick a Color'), () => this._pick());
        const color = fromHex(this.settings.color);
        if (!color)
            return;
        menu.addAction(_('Copy %s').format(toHex(color)), () => this._copy(toHex(color)));
        menu.addAction(_('Copy %s').format(toRgb(color)), () => this._copy(toRgb(color)));
        menu.addAction(_('Clear'), () => this.setSetting('color', null));
    }

    activate() {
        this._pick();
    }

    async _pick() {
        if (this._picking)
            return;
        this._picking = true;
        this._clearHover();
        try {
            // Let the tooltip and any menu leave the screen before freezing it
            await new Promise(resolve =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
            const [content] = await new Shell.Screenshot().screenshot_stage_to_content();
            const color = await new ColorPickOverlay(content).pickAsync();
            if (color) {
                this._copy(toHex(color));
                this.setSetting('color', toHex(color));
            }
        } catch (e) {
            logError(e, 'Color picker failed');
        } finally {
            this._picking = false;
        }
    }

    _copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _sync() {
        const color = fromHex(this.settings.color);
        this._swatch.visible = this._hex.visible = this._rgb.visible = !!color;
        if (!color) {
            this.accessible_name = _('Color Picker');
            return;
        }
        const hex = toHex(color);
        // A light outline on dark colors, a dark one on light colors
        const edge = luminance(color) < 0.25 ? '#808080' : '#151515';
        this._swatch.style = `background-color: ${hex}; border-color: ${edge};`;
        this._hex.text = hex;
        this._rgb.text = `${color.red} ${color.green} ${color.blue}`;
        this.accessible_name = `${hex}, ${toRgb(color)}`;
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
    }

    _tooltipText() {
        const color = fromHex(this.settings.color);
        const hint = _('Click to pick a color from the screen');
        return color ? `${toHex(color)}  ·  ${toRgb(color)}\n${hint}` : hint;
    }

    _clearHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;
        this.hideTooltip();
    }

    _onHover() {
        this._clearHover();
        if (!this.hover)
            return;
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_TIME, () => {
            this._hoverId = 0;
            if (this.hover && !this._picking && !this._menu?.isOpen)
                this.showTooltip(this._tooltipText());
            return GLib.SOURCE_REMOVE;
        });
    }
});
