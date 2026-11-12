import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet} from '../applet.js';

export const ClockDocklet = GObject.registerClass(
class ClockDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'clock-docklet'});

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._interfaceSettings.connectObject('changed::clock-format',
            () => this.tick(), this);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));

        this._digital = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeLabel = new St.Label({
            style_class: 'applet-clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._subLabel = new St.Label({
            style_class: 'applet-small',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._digital.add_child(this._timeLabel);
        this._digital.add_child(this._subLabel);

        this.connect('destroy', () => {
            this._area.destroy();
            this._digital.destroy();
        });
        this._syncStyle();
    }

    get defaults() {
        return {style: 'analog', seconds: true};
    }

    get interval() {
        return 1000;
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Style'), 'style', [
            ['analog', _('Analog')],
            ['digital', _('Digital')],
        ]);
        this.addToggle(menu, _('Show Seconds'), 'seconds');
        this.addAppAction(menu, _('Open Clocks'), 'org.gnome.clocks.desktop');
    }

    settingsChanged(key) {
        if (key === 'style')
            this._syncStyle();
        this.tick();
    }

    _syncStyle() {
        // set_child() unparents the other view without destroying it
        const child = this.settings.style === 'digital' ? this._digital : this._area;
        if (this.get_child() !== child)
            this.set_child(child);
    }

    tick() {
        if (this.settings.style === 'analog') {
            this._area.queue_repaint();
            return;
        }

        const now = GLib.DateTime.new_now_local();
        const twelve = this._interfaceSettings.get_string('clock-format') === '12h';
        this._timeLabel.text = now.format(twelve ? '%l:%M' : '%H:%M').trim();
        const parts = [];
        if (this.settings.seconds)
            parts.push(now.format(':%S'));
        if (twelve)
            parts.push(now.format('%p'));
        this._subLabel.text = parts.join(' ') || now.format('%a');
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const now = GLib.DateTime.new_now_local();
        const hour = now.get_hour() % 12;
        const min = now.get_minute();
        const sec = now.get_second();

        const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;

        // face
        cr.setSourceRGBA(0.12, 0.12, 0.12, 1);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fill();

        // ticks
        cr.setSourceRGBA(0.75, 0.75, 0.75, 1);
        cr.setLineWidth(1);
        for (let i = 0; i < 12; i++) {
            const a = i * Math.PI / 6;
            const len = i % 3 === 0 ? 5 : 2;
            cr.moveTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
            cr.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        cr.stroke();

        const hand = (angle, len, width, rgb) => {
            cr.setSourceRGBA(...rgb, 1);
            cr.setLineWidth(width);
            cr.moveTo(cx, cy);
            cr.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
            cr.stroke();
        };
        const base = -Math.PI / 2;
        hand(base + (hour + min / 60) * Math.PI / 6, r * 0.5, 3, [0.9, 0.9, 0.9]);
        hand(base + (min + sec / 60) * Math.PI / 30, r * 0.75, 2, [0.9, 0.9, 0.9]);
        if (this.settings.seconds)
            hand(base + sec * Math.PI / 30, r * 0.85, 1, [0.9, 0.3, 0.3]);

        cr.$dispose();
    }
});
