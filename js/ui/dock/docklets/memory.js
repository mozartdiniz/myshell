import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet, findApp} from '../applet.js';
import {
    ACCENT, ACCENT2, SYSTEM_MONITOR, drawText, drawTrack, formatBytes, readFile,
} from './meter.js';

/** @returns {Map<string, number>} /proc/meminfo fields in bytes */
function readMeminfo() {
    const map = new Map();
    for (const line of readFile('/proc/meminfo').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m)
            map.set(m[1], Number(m[2]) * 1024);
    }
    return map;
}

export const MemoryDocklet = GObject.registerClass(
class MemoryDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        this._rows = [];
    }

    get defaults() {
        return {swap: true, units: 'percent'};
    }

    get interval() {
        return 2000;
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Show Usage As'), 'units', [
            ['percent', _('Percentage')],
            ['size', _('Size')],
        ]);
        this.addToggle(menu, _('Show Swap'), 'swap');
        this.addAppAction(menu, _('Open System Monitor'), ...SYSTEM_MONITOR);
    }

    activate() {
        findApp(...SYSTEM_MONITOR)?.activate();
    }

    tick() {
        const info = readMeminfo();
        const total = info.get('MemTotal') ?? 0;
        const used = total - (info.get('MemAvailable') ?? info.get('MemFree') ?? 0);
        this._rows = [['MEM', used, total, ACCENT]];

        const swapTotal = info.get('SwapTotal') ?? 0;
        if (this.settings.swap && swapTotal > 0) {
            const swapUsed = swapTotal - (info.get('SwapFree') ?? 0);
            this._rows.push(['SWP', swapUsed, swapTotal, ACCENT2]);
        }
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w] = area.get_surface_size();
        const rowH = 26;
        let y = this._rows.length > 1 ? 4 : 17;

        for (const [name, used, total, rgb] of this._rows) {
            const frac = total > 0 ? used / total : 0;
            const value = this.settings.units === 'size'
                ? formatBytes(used)
                : `${Math.round(frac * 100)}%`;

            drawText(cr, name, 4, y + 9);
            drawText(cr, value, w - 4, y + 9, true);

            const bar = [4, y + 13, w - 8, 7];
            drawTrack(cr, bar);
            cr.setSourceRGBA(...rgb, 1);
            cr.rectangle(bar[0], bar[1], bar[2] * frac, bar[3]);
            cr.fill();
            y += rowH;
        }
        cr.$dispose();
    }
});
