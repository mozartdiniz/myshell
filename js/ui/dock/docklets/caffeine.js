import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {InhibitFlags} from '../../../misc/gnomeSession.js';
import {Applet} from '../applet.js';

const HOVER_TIME = 400;
const STEAM_FRAME = 80; // ms per frame of the steam animation

const PORCELAIN = [0.92, 0.91, 0.88];
const PORCELAIN_OFF = [0.50, 0.50, 0.50];
const INSIDE_OFF = [0.20, 0.20, 0.20];
const SAUCER = [0.36, 0.36, 0.36];
const COFFEE = [0.36, 0.21, 0.11];
const CREMA = [0.62, 0.42, 0.24];
const STEAM = [0.88, 0.88, 0.88];

/**
 * Ask the session manager to block suspend and idle (screen blanking,
 * screen lock on idle) until the returned cookie is released.
 *
 * @returns {Promise<number>} the inhibitor cookie
 */
async function inhibit() {
    const reply = await Gio.DBus.session.call(
        'org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', 'Inhibit',
        new GLib.Variant('(susu)', [
            'org.gnome.Shell', 0, _('Caffeine is keeping the computer awake'),
            InhibitFlags.SUSPEND | InhibitFlags.IDLE,
        ]),
        new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null);
    const [cookie] = reply.deepUnpack();
    return cookie;
}

/** @param {number} cookie */
async function uninhibit(cookie) {
    await Gio.DBus.session.call(
        'org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', 'Uninhibit',
        new GLib.Variant('(u)', [cookie]),
        null, Gio.DBusCallFlags.NONE, -1, null);
}

/** @returns {number} seconds since the epoch */
function now() {
    return Math.floor(GLib.get_real_time() / GLib.USEC_PER_SEC);
}

/**
 * Keeps the computer awake, like the Caffeine app: while on, the screen
 * doesn't blank or lock on idle and the computer doesn't suspend. A
 * click toggles it; it can also turn itself off after a while. The tile
 * is a coffee cup, steaming and full while on, empty while off.
 */
export const CaffeineDocklet = GObject.registerClass(
class CaffeineDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'caffeine-docklet'});

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        box.add_child(this._area);
        this._left = new St.Label({
            style_class: 'applet-small applet-caffeine-left',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._left);
        this.set_child(box);

        this._cookie = null;
        this._problem = null;
        this._syncing = false;
        this._resync = false;
        this._destroyed = false;
        this._expireId = 0;

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        // Runs before the dock's own handler, so the saved state is off
        // and adding the applet again doesn't start it on. Destroying on
        // shutdown keeps the state, so it survives restarts.
        this.connect('remove-requested', () => this.setSetting('on', false));
        this.connect('destroy', () => {
            this._destroyed = true;
            this._stopExpiry();
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
            this._syncInhibit();
        });

        // A timed session that ran out while the shell wasn't running
        if (this.settings.on && this.settings.until && this.settings.until <= now())
            this.settings.on = false;
        this._sync();
    }

    get defaults() {
        // duration in minutes, 0 for until turned off; until in epoch seconds
        return {on: false, duration: 0, until: 0};
    }

    get interval() {
        return this.settings.on ? STEAM_FRAME : 0;
    }

    activate() {
        this.setSetting('on', !this.settings.on);
    }

    buildMenu(menu) {
        this.addToggle(menu, _('Keep Awake'), 'on');
        this.addChoice(menu, _('Turn Off After'), 'duration', [
            [0, _('Never')],
            [30, _('30 Minutes')],
            [60, _('1 Hour')],
            [120, _('2 Hours')],
            [240, _('4 Hours')],
        ]);
    }

    settingsChanged(key) {
        // Turning on, or picking another duration while on, starts the
        // countdown afresh; setSetting() saves until along with the change
        if (key === 'on' || (key === 'duration' && this.settings.on)) {
            this.settings.until = this.settings.on && this.settings.duration
                ? now() + this.settings.duration * 60 : 0;
        }
        this._sync();
    }

    _sync() {
        this._syncInhibit();
        this._syncExpiry();
        this._syncTimer();
        this.tick();
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
    }

    /** Take or release the inhibitor to match the setting, one call at a time. */
    async _syncInhibit() {
        if (this._syncing) {
            this._resync = true;
            return;
        }
        this._syncing = true;
        let failed = false;
        try {
            do {
                this._resync = false;
                const want = this.settings.on && !this._destroyed;
                if (want && this._cookie === null) {
                    // eslint-disable-next-line no-await-in-loop
                    this._cookie = await inhibit();
                    this._problem = null;
                } else if (!want && this._cookie !== null) {
                    const cookie = this._cookie;
                    this._cookie = null;
                    // eslint-disable-next-line no-await-in-loop
                    await uninhibit(cookie);
                }
            } while (this._resync);
        } catch (e) {
            // e.g. no gnome-session, as in a nested shell
            console.warn(`Caffeine: failed to change the session inhibitor: ${e.message}`);
            this._problem = Gio.DBusError.is_remote_error(e)
                ? Gio.DBusError.get_remote_error(e) : e.message;
            failed = true;
        } finally {
            this._syncing = false;
        }
        // Don't show a full cup while nothing keeps the computer awake
        if (failed && this._cookie === null && this.settings.on && !this._destroyed)
            this.setSetting('on', false);
    }

    _syncExpiry() {
        this._stopExpiry();
        if (!this.settings.on || !this.settings.until)
            return;
        const secs = Math.max(0, this.settings.until - now());
        this._expireId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._expireId = 0;
            this.setSetting('on', false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopExpiry() {
        if (this._expireId)
            GLib.source_remove(this._expireId);
        this._expireId = 0;
    }

    tick() {
        const left = this.settings.on && this.settings.until
            ? Math.max(0, this.settings.until - now()) : 0;
        // Minutes up to an hour, then 1h05, 2h…
        const mins = Math.ceil(left / 60);
        const [h, m] = [Math.floor(mins / 60), mins % 60];
        if (!left)
            this._left.text = '';
        else if (mins <= 60)
            this._left.text = `${mins}m`;
        else
            this._left.text = m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
        this.accessible_name = this._tooltipText();
        this._area.queue_repaint();
    }

    _tooltipText() {
        if (!this.settings.on && this._problem) {
            /* Translators: %s is a D-Bus error name or message */
            return _('Caffeine couldn’t keep the computer awake\n(%s)').format(this._problem);
        }
        if (!this.settings.on)
            return _('Caffeine is off\nClick to keep the computer awake');
        if (!this.settings.until)
            return _('Caffeine is on: the screen stays on\nand the computer won’t suspend');
        const end = GLib.DateTime.new_from_unix_local(this.settings.until);
        /* Translators: %s is a time, like 15:30 */
        return _('Caffeine is on until %s: the screen stays on\nand the computer won’t suspend')
            .format(end.format('%R'));
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
        const on = this.settings.on;

        // Drawn on a 64×64 grid
        const s = Math.min(w, h) / 64;
        cr.translate((w - 64 * s) / 2, (h - 64 * s) / 2);
        cr.scale(s, s);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        const cup = on ? PORCELAIN : PORCELAIN_OFF;

        // Saucer
        cr.save();
        cr.translate(31, 52);
        cr.scale(21, 3.5);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.setSourceRGBA(...SAUCER, 1);
        cr.fill();

        // Handle
        cr.setLineWidth(3.5);
        cr.setSourceRGBA(...cup, 1);
        cr.arc(46, 36, 6.5, -Math.PI / 2, Math.PI / 2);
        cr.stroke();

        // Body
        cr.moveTo(16, 27);
        cr.lineTo(47, 27);
        cr.lineTo(44, 45);
        cr.curveTo(43.4, 48.6, 41, 50.5, 37.5, 50.5);
        cr.lineTo(25.5, 50.5);
        cr.curveTo(22, 50.5, 19.6, 48.6, 19, 45);
        cr.closePath();
        cr.setSourceRGBA(...cup, 1);
        cr.fill();

        // Rim, seen from slightly above: full of coffee, or the empty inside
        const ellipse = (cx, cy, rx, ry, from = 0, to = 2 * Math.PI) => {
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0, 0, 1, from, to);
            cr.restore();
        };
        ellipse(31.5, 27, 15.5, 4);
        cr.setSourceRGBA(...cup, 1);
        cr.fill();
        ellipse(31.5, 27, 13.5, 3);
        const inside = on ? COFFEE : INSIDE_OFF;
        cr.setSourceRGBA(...inside, 1);
        cr.fill();

        if (on) {
            // Crema along the back of the cup
            ellipse(31.5, 27, 11.5, 2.1, Math.PI * 1.1, Math.PI * 1.9);
            cr.setLineWidth(1.4);
            cr.setSourceRGBA(...CREMA, 0.9);
            cr.stroke();
            this._paintSteam(cr);
        }

        cr.$dispose();
    }

    _paintSteam(cr) {
        const t = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
        const top = 5, bottom = 21;
        cr.setLineWidth(1.8);
        [[24, 0], [31.5, 2.1], [39, 4.2]].forEach(([x0, phase]) => {
            // Each wisp sways, and fades in and out on its own beat
            const beat = 0.55 + 0.45 * Math.sin(t * 1.7 + phase * 1.3);
            const gradient = new Cairo.LinearGradient(0, bottom, 0, top);
            gradient.addColorStopRGBA(0, ...STEAM, 0.85 * beat);
            gradient.addColorStopRGBA(1, ...STEAM, 0);
            cr.setSource(gradient);
            for (let y = bottom; y >= top; y -= 1) {
                const x = x0 + 2.2 * Math.sin(y * 0.42 + t * 3 + phase);
                if (y === bottom)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.stroke();
        });
    }
});
