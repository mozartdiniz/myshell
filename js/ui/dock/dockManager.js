import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as AppFavorites from '../appFavorites.js';
import * as Main from '../main.js';
import {AppDocklet} from './appDocklet.js';
import {ClockDocklet} from './docklets/clock.js';
import {TILE_SIZE} from './docklet.js';

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

const DEFAULT_APP_CORNER = 'top-right';
const SNAP_TIME = 150;

/**
 * Owns all free-floating tiles. Each tile is an independent chrome
 * actor docked to one of the four screen corners. Tiles in a corner
 * form a packed stack that grows along the vertical edge away from
 * the corner, wrapping into a new column when the edge is full.
 * Dropping a tile anywhere docks it into the nearest corner's stack
 * at the index closest to the drop point. Layout is persisted to
 * $XDG_CONFIG_HOME/myshell/tiles.json.
 */
export class DockManager {
    constructor() {
        /** @type {Map<string, import('./docklet.js').Docklet>} */
        this._tiles = new Map();
        /** @type {Map<string, import('./docklet.js').Docklet[]>} */
        this._stacks = new Map(CORNERS.map(c => [c, []]));

        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'myshell', 'tiles.json']));
        this._saved = this._loadState();
        this._saveId = 0;

        this._favorites = AppFavorites.getAppFavorites();
        this._favorites.connectObject('changed',
            () => this._syncFavorites(), this);

        this._populated = false;
        Main.layoutManager.connectObject('monitors-changed',
            () => this._onMonitorsChanged(), this);
        this._onMonitorsChanged();
    }

    get tiles() {
        return [...this._tiles.values()];
    }

    _onMonitorsChanged() {
        if (!this._monitor())
            return;
        if (this._populated) {
            this._relayoutAll();
            return;
        }
        this._populated = true;
        this._addTile(new ClockDocklet(), 'top-left');
        this._syncFavorites();
    }

    // ---- geometry ---------------------------------------------------

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _rowsPerColumn() {
        return Math.max(1, Math.floor(this._monitor().height / TILE_SIZE));
    }

    /** Screen position of stack slot `index` in `corner`. */
    _slotPosition(corner, index) {
        const m = this._monitor();
        const rows = this._rowsPerColumn();
        const col = Math.floor(index / rows);
        const row = index % rows;
        const x = corner.endsWith('left')
            ? m.x + col * TILE_SIZE
            : m.x + m.width - (col + 1) * TILE_SIZE;
        const y = corner.startsWith('top')
            ? m.y + row * TILE_SIZE
            : m.y + m.height - (row + 1) * TILE_SIZE;
        return [x, y];
    }

    /** Nearest corner and stack index for a tile dropped at x,y. */
    _dropTarget(x, y) {
        const m = this._monitor();
        const cx = x + TILE_SIZE / 2, cy = y + TILE_SIZE / 2;
        const left = cx - m.x < m.width / 2;
        const top = cy - m.y < m.height / 2;
        const corner = `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`;

        const rows = this._rowsPerColumn();
        const dx = left ? x - m.x : m.x + m.width - (x + TILE_SIZE);
        const dy = top ? y - m.y : m.y + m.height - (y + TILE_SIZE);
        const col = Math.max(0, Math.round(dx / TILE_SIZE));
        const row = Math.max(0, Math.min(rows - 1, Math.round(dy / TILE_SIZE)));
        return {corner, index: col * rows + row};
    }

    // ---- stacks -----------------------------------------------------

    _stackOf(tile) {
        return tile.placement ? this._stacks.get(tile.placement.corner) : null;
    }

    _detach(tile) {
        const stack = this._stackOf(tile);
        if (!stack)
            return;
        const i = stack.indexOf(tile);
        if (i >= 0)
            stack.splice(i, 1);
        tile.placement = null;
    }

    _insert(tile, corner, index) {
        const stack = this._stacks.get(corner);
        index = Math.max(0, Math.min(stack.length, index));
        stack.splice(index, 0, tile);
        tile.placement = {corner, index};
    }

    _layoutStack(corner, animate = false) {
        const stack = this._stacks.get(corner);
        stack.forEach((tile, index) => {
            tile.placement = {corner, index};
            const [x, y] = this._slotPosition(corner, index);
            if (animate) {
                tile.ease({
                    x, y,
                    duration: SNAP_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                tile.set_position(x, y);
            }
        });
    }

    _relayoutAll(animate = false) {
        for (const corner of CORNERS)
            this._layoutStack(corner, animate);
    }

    // ---- tiles ------------------------------------------------------

    _addTile(tile, fallbackCorner) {
        const saved = this._saved.get(tile.id);
        const corner = saved?.corner ?? fallbackCorner;
        const index = saved?.index ?? Number.MAX_SAFE_INTEGER;

        Main.layoutManager.addChrome(tile, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._tiles.set(tile.id, tile);
        this._insert(tile, corner, index);
        this._layoutStack(corner);

        tile.connect('drag-end', (t, x, y) => this._onTileDropped(t, x, y));
        tile.connect('destroy', () => this._removeTile(tile));
        this._queueSave();
    }

    _removeTile(tile) {
        const corner = tile.placement?.corner;
        this._detach(tile);
        this._tiles.delete(tile.id);
        if (corner)
            this._layoutStack(corner, true);
        this._queueSave();
    }

    _onTileDropped(tile, x, y) {
        const from = tile.placement.corner;
        const {corner, index} = this._dropTarget(x, y);
        this._detach(tile);
        this._insert(tile, corner, index);
        if (from !== corner)
            this._layoutStack(from, true);
        this._layoutStack(corner, true);
        this._queueSave();
    }

    _syncFavorites() {
        if (!this._populated)
            return;
        const wanted = new Set(this._favorites.getFavorites().map(a => a.get_id()));

        for (const tile of [...this._tiles.values()]) {
            if (tile instanceof AppDocklet && !wanted.has(tile.app.get_id()))
                tile.destroy();
        }

        const appSystem = Shell.AppSystem.get_default();
        for (const appId of wanted) {
            if (this._tiles.has(`app:${appId}`))
                continue;
            const app = appSystem.lookup_app(appId);
            if (app)
                this._addTile(new AppDocklet(app), DEFAULT_APP_CORNER);
        }
    }

    // ---- persistence ------------------------------------------------

    _loadState() {
        const map = new Map();
        try {
            const [, bytes] = this._stateFile.load_contents(null);
            const list = JSON.parse(new TextDecoder().decode(bytes));
            for (const {id, corner, index} of list) {
                if (CORNERS.includes(corner))
                    map.set(id, {corner, index: index | 0});
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load tile layout: ${e.message}`);
        }
        return map;
    }

    _queueSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        const list = [];
        for (const tile of this._tiles.values()) {
            if (tile.placement)
                list.push({id: tile.id, ...tile.placement});
        }
        for (const [id, p] of this._saved) {
            if (!this._tiles.has(id))
                list.push({id, ...p}); // keep layout of tiles not currently present
        }
        try {
            const dir = this._stateFile.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._stateFile.replace_contents(
                JSON.stringify(list, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save tile layout: ${e.message}`);
        }
    }
}
