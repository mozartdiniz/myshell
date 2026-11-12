import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet, findApp} from '../applet.js';
import {
    ACCENT, History, SYSTEM_MONITOR, drawGraph, drawText, drawTrack, readFile,
} from './meter.js';

/** @returns {number[][]} [busy, total] jiffies; index 0 is all CPUs */
function readCpuTimes() {
    return readFile('/proc/stat').split('\n')
        .filter(l => /^cpu\d*\s/.test(l))
        .map(l => {
            // guest time is already included in user/nice, so skip it
            const f = l.trim().split(/\s+/).slice(1, 9).map(Number);
            const idle = f[3] + (f[4] ?? 0); // idle + iowait
            const total = f.reduce((a, b) => a + b, 0);
            return [total - idle, total];
        });
}

export const CpuDocklet = GObject.registerClass(
class CpuDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        this._history = new History();
        this._cores = [];
        this._last = readCpuTimes();
    }

    get defaults() {
        return {mode: 'graph'};
    }

    get interval() {
        return 1000;
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Show'), 'mode', [
            ['graph', _('Usage History')],
            ['cores', _('Each Core')],
        ]);
        this.addAppAction(menu, _('Open System Monitor'), ...SYSTEM_MONITOR);
    }

    activate() {
        findApp(...SYSTEM_MONITOR)?.activate();
    }

    settingsChanged() {
        this._area.queue_repaint();
    }

    tick() {
        const now = readCpuTimes();
        const usage = now.map(([busy, total], i) => {
            const [lastBusy, lastTotal] = this._last[i] ?? [busy, total];
            const dt = total - lastTotal;
            return dt > 0 ? (busy - lastBusy) / dt : 0;
        });
        this._last = now;

        this._history.push(usage[0] ?? 0);
        this._cores = usage.slice(1);
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const box = [4, 18, w - 8, h - 22];
        drawText(cr, 'CPU', 4, 13);
        drawText(cr, `${Math.round(this._history.values.at(-1) * 100)}%`, w - 4, 13, true);
        drawTrack(cr, box);

        if (this.settings.mode === 'cores' && this._cores.length) {
            const [x, y, bw, bh] = box;
            const n = this._cores.length;
            const colW = bw / n;
            cr.setSourceRGBA(...ACCENT, 1);
            this._cores.forEach((u, i) => {
                const barH = Math.max(1, u * bh);
                cr.rectangle(x + i * colW, y + bh - barH, Math.max(1, colW - 1), barH);
            });
            cr.fill();
        } else {
            drawGraph(cr, this._history.values, 1, box, ACCENT);
        }
        cr.$dispose();
    }
});
