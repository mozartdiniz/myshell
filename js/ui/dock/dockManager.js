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
 * actor docked to a screen corner on a TILE_SIZE grid indexed from
 * that corner. Placements are persisted to
 * $XDG_CONFIG_HOME/myshell/tiles.json.
 */
export class DockManager {
    constructor() {
        /** @type {Map<string, import('./docklet.js').Docklet>} */
        this._tiles = new Map();

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

    _onMonitorsChanged() {
        if (!this._monitor())
            return;
        if (this._populated) {
            this._relayoutAll();
            return;
        }
        this._populated = true;
        this._addTile(new ClockDocklet(), {corner: 'top-left', col: 0, row: 0});
        this._syncFavorites();
    }

    get tiles() {
        return [...this._tiles.values()];
    }

    // ---- placement --------------------------------------------------

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    /** Screen position of a grid cell. */
    _cellToPosition({corner, col, row}) {
        const m = this._monitor();
        const x = corner.endsWith('left')
            ? m.x + col * TILE_SIZE
            : m.x + m.width - (col + 1) * TILE_SIZE;
        const y = corner.startsWith('top')
            ? m.y + row * TILE_SIZE
            : m.y + m.height - (row + 1) * TILE_SIZE;
        return [x, y];
    }

    /** Nearest corner + grid cell for a tile whose top-left is at x,y. */
    _positionToCell(x, y) {
        const m = this._monitor();
        const cx = x + TILE_SIZE / 2, cy = y + TILE_SIZE / 2;
        const left = cx - m.x < m.width / 2;
        const top = cy - m.y < m.height / 2;
        const corner = `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`;
        const dx = left ? x - m.x : m.x + m.width - (x + TILE_SIZE);
        const dy = top ? y - m.y : m.y + m.height - (y + TILE_SIZE);
        return {
            corner,
            col: Math.max(0, Math.round(dx / TILE_SIZE)),
            row: Math.max(0, Math.round(dy / TILE_SIZE)),
        };
    }

    _isFree(cell, except = null) {
        const [x, y] = this._cellToPosition(cell);
        const m = this._monitor();
        if (x < m.x || y < m.y ||
            x + TILE_SIZE > m.x + m.width || y + TILE_SIZE > m.y + m.height)
            return false;
        for (const tile of this._tiles.values()) {
            if (tile === except || !tile.placement)
                continue;
            const [tx, ty] = this._cellToPosition(tile.placement);
            if (Math.abs(tx - x) < TILE_SIZE && Math.abs(ty - y) < TILE_SIZE)
                return false;
        }
        return true;
    }

    /** Closest free cell to `cell` in the same corner (spiral search). */
    _nearestFreeCell(cell, except = null) {
        if (this._isFree(cell, except))
            return cell;
        for (let r = 1; r < 32; r++) {
            const candidates = [];
            for (let dc = -r; dc <= r; dc++) {
                for (let dr = -r; dr <= r; dr++) {
                    if (Math.max(Math.abs(dc), Math.abs(dr)) !== r)
                        continue;
                    const c = {corner: cell.corner, col: cell.col + dc, row: cell.row + dr};
                    if (c.col >= 0 && c.row >= 0 && this._isFree(c, except))
                        candidates.push(c);
                }
            }
            if (candidates.length) {
                candidates.sort((a, b) =>
                    Math.hypot(a.col - cell.col, a.row - cell.row) -
                    Math.hypot(b.col - cell.col, b.row - cell.row));
                return candidates[0];
            }
        }
        return null;
    }

    /** First free cell stacking down/up along the edge of `corner`. */
    _firstFreeCell(corner) {
        const m = this._monitor();
        const rows = Math.floor(m.height / TILE_SIZE);
        for (let col = 0; col < 8; col++) {
            for (let row = 0; row < rows; row++) {
                const c = {corner, col, row};
                if (this._isFree(c))
                    return c;
            }
        }
        return {corner, col: 0, row: 0};
    }

    _place(tile, cell, animate = false) {
        tile.placement = cell;
        const [x, y] = this._cellToPosition(cell);
        if (animate) {
            tile.ease({
                x, y,
                duration: SNAP_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            tile.set_position(x, y);
        }
    }

    _relayoutAll() {
        for (const tile of this._tiles.values()) {
            if (tile.placement)
                this._place(tile, tile.placement);
        }
    }

    // ---- tiles ------------------------------------------------------

    _addTile(tile, fallback) {
        const cell = this._saved.get(tile.id) ?? fallback;
        Main.layoutManager.addChrome(tile, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._tiles.set(tile.id, tile);
        this._place(tile, this._nearestFreeCell(cell, tile) ?? cell);

        tile.connect('drag-end', (t, x, y) => this._onTileDropped(t, x, y));
        tile.connect('destroy', () => this._tiles.delete(tile.id));
        this._queueSave();
    }

    _onTileDropped(tile, x, y) {
        const wanted = this._positionToCell(x, y);
        const cell = this._nearestFreeCell(wanted, tile) ?? tile.placement;
        this._place(tile, cell, true);
        this._queueSave();
    }

    _syncFavorites() {
        if (!this._populated)
            return;
        const wanted = new Set(this._favorites.getFavorites().map(a => a.get_id()));

        for (const [id, tile] of this._tiles) {
            if (tile instanceof AppDocklet && !wanted.has(tile.app.get_id())) {
                this._tiles.delete(id);
                tile.destroy();
            }
        }

        const appSystem = Shell.AppSystem.get_default();
        for (const appId of wanted) {
            const id = `app:${appId}`;
            if (this._tiles.has(id))
                continue;
            const app = appSystem.lookup_app(appId);
            if (!app)
                continue;
            this._addTile(new AppDocklet(app), this._firstFreeCell(DEFAULT_APP_CORNER));
        }
        this._queueSave();
    }

    // ---- persistence ------------------------------------------------

    _loadState() {
        const map = new Map();
        try {
            const [, bytes] = this._stateFile.load_contents(null);
            const list = JSON.parse(new TextDecoder().decode(bytes));
            for (const {id, corner, col, row} of list) {
                if (CORNERS.includes(corner))
                    map.set(id, {corner, col: col | 0, row: row | 0});
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
