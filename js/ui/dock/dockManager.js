import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as AppFavorites from '../appFavorites.js';
import * as Main from '../main.js';
import {AppDocklet} from './appDocklet.js';
import {ClockDocklet} from './docklets/clock.js';

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * One dockable surface anchored to a screen corner. Tiles stack
 * vertically away from the corner.
 */
export const Dock = GObject.registerClass(
class Dock extends St.BoxLayout {
    _init(corner) {
        super._init({
            name: `dock-${corner}`,
            style_class: `dock dock-${corner}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this.corner = corner;
    }

    addDocklet(docklet) {
        docklet.corner = this.corner;
        if (this.corner.startsWith('top'))
            this.add_child(docklet);
        else
            this.insert_child_at_index(docklet, 0);
    }

    get docklets() {
        return this.get_children();
    }
});

export class DockManager {
    constructor() {
        this._docks = new Map();
        for (const corner of CORNERS) {
            const dock = new Dock(corner);
            Main.layoutManager.addChrome(dock, {
                affectsStruts: false,
                trackFullscreen: true,
            });
            dock.connectObject(
                'child-added', () => this._relayout(),
                'child-removed', () => this._relayout(),
                this);
            this._docks.set(corner, dock);
        }

        Main.layoutManager.connectObject('monitors-changed',
            () => this._relayout(), this);
        this._relayout();

        this._favorites = AppFavorites.getAppFavorites();
        this._favorites.connectObject('changed',
            () => this._syncFavorites(), this);
        this._syncFavorites();

        this.getDock('top-left').addDocklet(new ClockDocklet());
    }

    getDock(corner) {
        return this._docks.get(corner);
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        for (const [corner, dock] of this._docks) {
            const [top, left] = [corner.startsWith('top'), corner.endsWith('left')];
            const [, w] = dock.get_preferred_width(-1);
            const [, h] = dock.get_preferred_height(w);
            dock.set_position(
                left ? monitor.x : monitor.x + monitor.width - w,
                top ? monitor.y : monitor.y + monitor.height - h);
        }
    }

    _syncFavorites() {
        const dock = this.getDock('top-right');
        for (const child of dock.docklets) {
            if (child instanceof AppDocklet)
                child.destroy();
        }
        for (const app of this._favorites.getFavorites())
            dock.addDocklet(new AppDocklet(app));
        this._relayout();
    }
}
