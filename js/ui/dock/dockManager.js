import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as AppFavorites from '../appFavorites.js';
import * as Main from '../main.js';
import {AppDocklet} from './appDocklet.js';
import {ClockDocklet} from './docklets/clock.js';
import {TILE_SIZE} from './docklet.js';

export const EDGES = ['left', 'right', 'top', 'bottom'];

const DEFAULT_APP_EDGE = 'right';
const SNAP_TIME = 150;
const MAX_DEPTH = 4;

/**
 * Owns all free-floating tiles. Each tile is an independent chrome
 * actor magnetically docked to the nearest screen edge, keeping the
 * position along that edge where it was dropped (snapped to a
 * TILE_SIZE grid so tiles line up). Occupied slots push the tile to
 * the closest free one. Layout is persisted to
 * $XDG_CONFIG_HOME/myshell/tiles.json.
 *
 * A placement is {edge, slot, depth}: `slot` counts tiles along the
 * edge from the top/left, `depth` counts tiles away from the edge.
 */
export class DockManager {
    constructor() {
        /** @type {Map<string, import('./docklet.js').Docklet>} */
        this._tiles = new Map();

        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'myshell', 'tiles.json']));
        /** id → placement; authoritative layout, survives tile destruction */
        this._layout = this._loadState();
        this._saveId = 0;

        this._favorites = AppFavorites.getAppFavorites();
        this._favorites.connectObject('changed',
            () => this._syncAppTiles(), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed',
            () => this._syncAppTiles(), this);

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
        this._addTile(new ClockDocklet(), {edge: 'left', slot: 0, depth: 0});
        this._syncAppTiles();
    }

    // ---- geometry ---------------------------------------------------

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _slotsAlong(edge) {
        const m = this._monitor();
        const len = edge === 'left' || edge === 'right' ? m.height : m.width;
        return Math.max(1, Math.floor(len / TILE_SIZE));
    }

    /** Screen position for a placement. */
    _placementToPosition({edge, slot, depth}) {
        const m = this._monitor();
        const along = slot * TILE_SIZE;
        const away = depth * TILE_SIZE;
        switch (edge) {
        case 'left':
            return [m.x + away, m.y + along];
        case 'right':
            return [m.x + m.width - TILE_SIZE - away, m.y + along];
        case 'top':
            return [m.x + along, m.y + away];
        case 'bottom':
        default:
            return [m.x + along, m.y + m.height - TILE_SIZE - away];
        }
    }

    /** Nearest edge and grid placement for a tile whose top-left is x,y. */
    _positionToPlacement(x, y) {
        const m = this._monitor();
        const dist = {
            left: x - m.x,
            right: m.x + m.width - (x + TILE_SIZE),
            top: y - m.y,
            bottom: m.y + m.height - (y + TILE_SIZE),
        };
        const edge = EDGES.reduce((a, b) => dist[a] <= dist[b] ? a : b);
        const along = edge === 'left' || edge === 'right' ? y - m.y : x - m.x;
        // Always magnetize onto the surface; depth > 0 only arises
        // when the slot on the edge is already taken.
        return {
            edge,
            slot: this._clampSlot(edge, Math.round(along / TILE_SIZE)),
            depth: 0,
        };
    }

    _clampSlot(edge, slot) {
        return Math.max(0, Math.min(this._slotsAlong(edge) - 1, slot));
    }

    _isFree(placement, except = null) {
        const [x, y] = this._placementToPosition(placement);
        for (const tile of this._tiles.values()) {
            if (tile === except || !tile.placement)
                continue;
            const [tx, ty] = this._placementToPosition(tile.placement);
            if (Math.abs(tx - x) < TILE_SIZE && Math.abs(ty - y) < TILE_SIZE)
                return false;
        }
        return true;
    }

    /**
     * Closest free placement to `wanted` on the same edge: first try
     * sliding along the edge, then stepping further away from it.
     */
    _nearestFree(wanted, except = null) {
        const {edge} = wanted;
        const slots = this._slotsAlong(edge);
        let best = null, bestCost = Infinity;
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            for (let slot = 0; slot < slots; slot++) {
                // Prefer sliding along the surface over leaving it
                const cost = Math.abs(slot - wanted.slot) +
                    Math.abs(depth - wanted.depth) * slots;
                if (cost >= bestCost)
                    continue;
                const p = {edge, slot, depth};
                if (this._isFree(p, except)) {
                    best = p;
                    bestCost = cost;
                }
            }
        }
        return best;
    }

    _place(tile, placement, animate = false) {
        tile.placement = placement;
        this._layout.set(tile.id, placement);
        const [x, y] = this._placementToPosition(placement);
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
            if (!tile.placement)
                continue;
            const p = {...tile.placement};
            p.slot = this._clampSlot(p.edge, p.slot);
            this._place(tile, this._nearestFree(p, tile) ?? p);
        }
    }

    // ---- tiles ------------------------------------------------------

    _addTile(tile, fallback) {
        const wanted = this._layout.get(tile.id) ?? fallback;
        Main.layoutManager.addChrome(tile, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._tiles.set(tile.id, tile);
        this._place(tile, this._nearestFree(wanted, tile) ?? wanted);

        tile.connect('drag-end', (t, x, y) => this._onTileDropped(t, x, y));
        tile.connect('destroy', () => this._tiles.delete(tile.id));
        this._queueSave();
    }

    /** Remove a tile and forget its placement. */
    _forgetTile(tile) {
        this._layout.delete(tile.id);
        tile.destroy();
        this._queueSave();
    }

    _onTileDropped(tile, x, y) {
        const wanted = this._positionToPlacement(x, y);
        this._place(tile, this._nearestFree(wanted, tile) ?? tile.placement, true);
        this._queueSave();
    }

    /** First free slot along `edge`, nearest the top/left. */
    _firstFree(edge) {
        return this._nearestFree({edge, slot: 0, depth: 0}) ??
            {edge, slot: 0, depth: 0};
    }

    /**
     * Pinned (favorite) apps always have a tile; any other running app
     * gets a temporary one that goes away when it quits, so it can be
     * pinned from its menu.
     */
    _syncAppTiles() {
        if (!this._populated)
            return;
        const appSystem = Shell.AppSystem.get_default();
        const wanted = new Map();
        for (const app of this._favorites.getFavorites())
            wanted.set(app.get_id(), app);
        for (const app of appSystem.get_running())
            wanted.set(app.get_id(), app);

        for (const tile of [...this._tiles.values()]) {
            if (tile instanceof AppDocklet && !wanted.has(tile.app.get_id()))
                this._forgetTile(tile);
        }

        for (const [appId, app] of wanted) {
            if (!this._tiles.has(`app:${appId}`))
                this._addTile(new AppDocklet(app), this._firstFree(DEFAULT_APP_EDGE));
        }
    }

    // ---- persistence ------------------------------------------------

    _loadState() {
        const map = new Map();
        try {
            const [, bytes] = this._stateFile.load_contents(null);
            const list = JSON.parse(new TextDecoder().decode(bytes));
            for (const {id, edge, slot, depth} of list) {
                if (EDGES.includes(edge))
                    map.set(id, {edge, slot: slot | 0, depth: depth | 0});
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
        const list = [...this._layout].map(([id, p]) => ({id, ...p}));
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
