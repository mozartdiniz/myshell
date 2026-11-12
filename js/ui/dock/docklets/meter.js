// Shared helpers for the monitoring applets.

import GLib from 'gi://GLib';

const decoder = new TextDecoder();

/** Sample history length; one sample per pixel column of the graph. */
export const HISTORY = 54;

export const FG = [0.85, 0.85, 0.85];
export const ACCENT = [0.37, 0.70, 0.85];
export const ACCENT2 = [0.90, 0.62, 0.30];
export const TRACK = [0.10, 0.10, 0.10];

export const SYSTEM_MONITOR = [
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
    'io.missioncenter.MissionCenter.desktop',
];

/**
 * @param {string} path
 * @returns {string} file contents, or '' when unreadable
 */
export function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch {
        return '';
    }
}

/**
 * @param {number} bytes
 * @returns {string} compact size like 1.2G, 340M, 12K
 */
export function formatBytes(bytes) {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (bytes >= 1000 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    const digits = bytes < 10 && i > 0 ? 1 : 0;
    return `${bytes.toFixed(digits)}${units[i]}`;
}

/** Fixed-length ring of samples, oldest first. */
export class History {
    constructor(length = HISTORY) {
        this.values = new Array(length).fill(0);
    }

    push(value) {
        this.values.shift();
        this.values.push(value);
    }

    get max() {
        return Math.max(...this.values);
    }
}

/**
 * Draw an area graph of `values` scaled to `max` inside the given box.
 *
 * @param {object} cr - cairo context
 * @param {number[]} values
 * @param {number} max
 * @param {number[]} box - [x, y, width, height]
 * @param {number[]} rgb
 */
export function drawGraph(cr, values, max, [x, y, w, h], rgb) {
    if (max <= 0)
        return;
    const step = w / values.length;
    cr.setSourceRGBA(...rgb, 0.35);
    cr.moveTo(x, y + h);
    values.forEach((v, i) =>
        cr.lineTo(x + i * step, y + h - Math.min(1, v / max) * h));
    cr.lineTo(x + w, y + h);
    cr.closePath();
    cr.fillPreserve();
    cr.setSourceRGBA(...rgb, 1);
    cr.setLineWidth(1);
    cr.stroke();
}

/** Dark inset background used behind graphs and bars. */
export function drawTrack(cr, [x, y, w, h]) {
    cr.setSourceRGBA(...TRACK, 1);
    cr.rectangle(x, y, w, h);
    cr.fill();
}

/**
 * Draw small bold text with its baseline at y.
 *
 * @param {object} cr - cairo context
 * @param {string} text
 * @param {number} x - left edge, or right edge when `alignRight`
 * @param {number} y - baseline
 * @param {boolean} alignRight
 * @param {number[]} rgb
 */
export function drawText(cr, text, x, y, alignRight = false, rgb = FG) {
    cr.selectFontFace('Sans', 0, 1);
    cr.setFontSize(9);
    cr.setSourceRGBA(...rgb, 1);
    const dx = alignRight ? cr.textExtents(text).xAdvance : 0;
    cr.moveTo(x - dx, y);
    cr.showText(text);
}
