import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Applet} from '../applet.js';
import {ACCENT, FG, TRACK} from './meter.js';

const PAD = 4;
const GAP = 2;

/** Pager: one cell per workspace, optionally with window outlines. */
export const WorkspacesDocklet = GObject.registerClass(
class WorkspacesDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        const wm = global.workspace_manager;
        wm.connectObject(
            'active-workspace-changed', () => this.tick(),
            'notify::n-workspaces', () => this.tick(),
            this);
        global.display.connectObject('restacked', () => this.tick(), this);
    }

    get defaults() {
        return {windows: true};
    }

    get interval() {
        // Window outlines follow moves and resizes
        return this.settings.windows ? 1000 : 0;
    }

    buildMenu(menu) {
        this.addToggle(menu, _('Show Windows'), 'windows');
    }

    settingsChanged(key) {
        if (key === 'windows') {
            this._stopTimer();
            this._syncTimer();
        }
        this.tick();
    }

    tick() {
        this._area.queue_repaint();
    }

    /** @returns {number[][]} [x, y, w, h] per workspace in area coords */
    _cells(w, h) {
        const n = global.workspace_manager.n_workspaces;
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cw = (w - 2 * PAD - (cols - 1) * GAP) / cols;
        const ch = (h - 2 * PAD - (rows - 1) * GAP) / rows;
        const cells = [];
        for (let i = 0; i < n; i++) {
            const c = i % cols, r = Math.floor(i / cols);
            cells.push([PAD + c * (cw + GAP), PAD + r * (ch + GAP), cw, ch]);
        }
        return cells;
    }

    activate() {
        const event = Clutter.get_current_event();
        if (!event)
            return;
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = this._area.transform_stage_point(sx, sy);
        if (!ok)
            return;
        const [w, h] = this._area.get_size();
        const index = this._cells(w, h).findIndex(([cx, cy, cw, ch]) =>
            x >= cx && x < cx + cw && y >= cy && y < cy + ch);
        if (index >= 0) {
            global.workspace_manager.get_workspace_by_index(index)
                .activate(global.get_current_time());
        }
    }

    vfunc_scroll_event(event) {
        const wm = global.workspace_manager;
        let dir;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            dir = Meta.MotionDirection.LEFT;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            dir = Meta.MotionDirection.RIGHT;
            break;
        default:
            return Clutter.EVENT_STOP;
        }
        wm.get_active_workspace().get_neighbor(dir)
            .activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        const monitor = global.display.get_monitor_geometry(
            global.display.get_primary_monitor());

        this._cells(w, h).forEach(([x, y, cw, ch], i) => {
            cr.setSourceRGBA(...(i === active ? ACCENT : TRACK), i === active ? 0.45 : 1);
            cr.rectangle(x, y, cw, ch);
            cr.fill();

            if (!this.settings.windows)
                return;
            const sx = cw / monitor.width, sy = ch / monitor.height;
            const windows = wm.get_workspace_by_index(i).list_windows()
                .filter(win => !win.minimized && !win.skip_taskbar &&
                    win.get_monitor() === global.display.get_primary_monitor())
                .sort((a, b) => a.get_user_time() - b.get_user_time());
            for (const win of windows) {
                const r = win.get_frame_rect();
                const rx = x + (r.x - monitor.x) * sx, ry = y + (r.y - monitor.y) * sy;
                cr.rectangle(rx + 0.5, ry + 0.5,
                    Math.max(2, r.width * sx) - 1, Math.max(2, r.height * sy) - 1);
                cr.setSourceRGBA(0.2, 0.2, 0.2, 1);
                cr.fillPreserve();
                cr.setSourceRGBA(...FG, 0.8);
                cr.setLineWidth(1);
                cr.stroke();
            }
        });
        cr.$dispose();
    }
});
