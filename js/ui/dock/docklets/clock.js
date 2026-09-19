import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Docklet, TILE_SIZE} from '../docklet.js';

export const ClockDocklet = GObject.registerClass(
class ClockDocklet extends Docklet {
    _init(params = {}) {
        super._init({style_class: 'docklet clock-docklet', ...params});

        this._area = new St.DrawingArea({
            width: TILE_SIZE,
            height: TILE_SIZE,
        });
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);
    }

    get id() {
        return 'clock';
    }

    get interval() {
        return 1000;
    }

    tick() {
        this._area.queue_repaint();
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
        hand(base + sec * Math.PI / 30, r * 0.85, 1, [0.9, 0.3, 0.3]);

        cr.$dispose();
    }
});
