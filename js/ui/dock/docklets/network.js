import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet, findApp} from '../applet.js';
import {
    ACCENT, ACCENT2, History, drawGraph, drawText, drawTrack, formatBytes,
    readFile,
} from './meter.js';

// Interfaces that only carry traffic already counted elsewhere
const VIRTUAL = /^(lo|veth|docker|br-|virbr|vnet|tun|tap|wg|tailscale)/;

/** @returns {Map<string, number[]>} interface → [rx bytes, tx bytes] */
function readNetDev() {
    const map = new Map();
    for (const line of readFile('/proc/net/dev').split('\n').slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m)
            continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        map.set(m[1], [f[0], f[8]]);
    }
    return map;
}

export const NetworkDocklet = GObject.registerClass(
class NetworkDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        this._rx = new History();
        this._tx = new History();
        this._rate = [0, 0];
        this._last = null;
    }

    get defaults() {
        return {iface: 'all'};
    }

    get interval() {
        return 1000;
    }

    buildMenu(menu) {
        const names = [...readNetDev().keys()].filter(n => n !== 'lo');
        this.addChoice(menu, _('Interface'), 'iface', [
            ['all', _('All Physical')],
            ...names.map(n => [n, n]),
        ]);
        this.addAppAction(menu, _('Network Settings'), 'gnome-network-panel.desktop');
    }

    activate() {
        findApp('gnome-network-panel.desktop')?.activate();
    }

    settingsChanged() {
        this._last = null;
        this._rx = new History();
        this._tx = new History();
        this._rate = [0, 0];
        this._area.queue_repaint();
    }

    _totals() {
        let rx = 0, tx = 0;
        for (const [name, [r, t]] of readNetDev()) {
            const wanted = this.settings.iface === 'all'
                ? !VIRTUAL.test(name) : name === this.settings.iface;
            if (wanted) {
                rx += r;
                tx += t;
            }
        }
        return [rx, tx, GLib.get_monotonic_time()];
    }

    tick() {
        const now = this._totals();
        if (this._last) {
            const dt = (now[2] - this._last[2]) / 1e6;
            if (dt > 0) {
                this._rate = [
                    Math.max(0, (now[0] - this._last[0]) / dt),
                    Math.max(0, (now[1] - this._last[1]) / dt),
                ];
                this._rx.push(this._rate[0]);
                this._tx.push(this._rate[1]);
            }
        }
        this._last = now;
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        // Cairo's toy text API has no glyph fallback, so draw the arrows
        const arrow = (y, down, rgb) => {
            cr.setSourceRGBA(...rgb, 1);
            cr.moveTo(4, down ? y - 6 : y);
            cr.lineTo(12, down ? y - 6 : y);
            cr.lineTo(8, down ? y : y - 6);
            cr.closePath();
            cr.fill();
        };
        arrow(12, true, ACCENT);
        drawText(cr, formatBytes(this._rate[0]), w - 4, 13, true);
        arrow(24, false, ACCENT2);
        drawText(cr, formatBytes(this._rate[1]), w - 4, 25, true);

        const box = [4, 30, w - 8, h - 34];
        drawTrack(cr, box);
        const max = Math.max(this._rx.max, this._tx.max, 1024);
        drawGraph(cr, this._rx.values, max, box, ACCENT);
        drawGraph(cr, this._tx.values, max, box, ACCENT2);
        cr.$dispose();
    }
});
