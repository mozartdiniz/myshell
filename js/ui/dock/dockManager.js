import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as AppFavorites from '../appFavorites.js';
import * as DND from '../dnd.js';
import * as Main from '../main.js';
import * as Signals from '../../misc/signals.js';
import {AppDocklet, launchApp} from './appDocklet.js';
import {APPLETS, DEFAULT_APPLETS, appletInfo} from './applets.js';
import {TILE_SIZE} from './docklet.js';

export const EDGES = ['left', 'right', 'top', 'bottom'];

const DEFAULT_APP_EDGE = 'right';
const DEFAULT_APPLET_EDGE = 'left';
const SNAP_TIME = 150;
const MAX_DEPTH = 4;
const URI_LIST = 'text/uri-list';

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
 *
 * Applets (see applets.js) are added and removed by the user; which
 * ones are shown and their settings live in applets.json next to the
 * layout. Emits 'applets-changed' when the set of shown applets changes.
 * Settings of pinned app tiles live in app-tiles.json.
 *
 * Each edge with tiles reserves a strut as deep as its tiles reach, so
 * maximized windows stay clear of the docks, as in WindowMaker. Files
 * dragged from an app can be dropped on an app tile to open them.
 */
export class DockManager extends Signals.EventEmitter {
    constructor() {
        super();

        /** @type {Map<string, import('./docklet.js').Docklet>} */
        this._tiles = new Map();

        const configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'myshell']);
        this._stateFile = Gio.File.new_for_path(
            GLib.build_filenamev([configDir, 'tiles.json']));
        this._appletsFile = Gio.File.new_for_path(
            GLib.build_filenamev([configDir, 'applets.json']));
        this._appTilesFile = Gio.File.new_for_path(
            GLib.build_filenamev([configDir, 'app-tiles.json']));
        /** id → placement; authoritative layout, survives tile destruction */
        this._layout = this._loadState();
        this._loadApplets();
        /** app id → settings of its pinned tile */
        this._appSettings = this._loadJson(this._appTilesFile) ?? {};
        this._saveId = 0;

        /** edge → invisible chrome actor that reserves the strut */
        this._struts = new Map();
        this._strutsId = 0;

        this._dropTile = null;
        this._dropUris = null;
        this._dragMonitor = {dragMotion: event => this._onDragMotion(event)};
        Main.xdndHandler.connectObject(
            'drag-begin', () => this._onClientDragBegin(),
            'drag-end', () => this._onClientDragEnd(),
            this);

        this._favorites = AppFavorites.getAppFavorites();
        this._favorites.connectObject('changed',
            () => this._syncAppTiles(), this);
        // The favorites list leaves out apps it can't show yet (e.g.
        // before parental controls are ready), so watch the setting
        this._pinnedIds = this._pinnedAppIds();
        global.settings.connectObject('changed::favorite-apps',
            () => this._onPinnedChanged(), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed',
            () => this._syncAppTiles(), this);

        this._populated = false;
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onMonitorsChanged(),
            'startup-complete', () => this._autolaunch(),
            this);
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
            this._queueUpdateStruts();
            return;
        }
        this._populated = true;
        for (const id of this._enabledApplets)
            this._addApplet(id);
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

    _queueUpdateStruts() {
        if (this._strutsId)
            return;
        this._strutsId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._strutsId = 0;
            this._updateStruts();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Reserve each edge as deep as its tiles reach. */
    _updateStruts() {
        const m = this._monitor();
        for (const edge of EDGES) {
            const depths = this.tiles
                .filter(t => t.placement?.edge === edge)
                .map(t => t.placement.depth + 1);
            const thickness = depths.length ? Math.max(...depths) * TILE_SIZE : 0;
            let strut = this._struts.get(edge);
            if (!thickness || !m) {
                strut?.destroy();
                this._struts.delete(edge);
                continue;
            }
            if (!strut) {
                strut = new Clutter.Actor({reactive: false});
                strut.connect('destroy', () => this._struts.delete(edge));
                Main.layoutManager.addChrome(strut, {affectsStruts: true});
                this._struts.set(edge, strut);
            }
            // Spanning the whole edge tells the layout manager its side
            switch (edge) {
            case 'left':
                strut.set({x: m.x, y: m.y, width: thickness, height: m.height});
                break;
            case 'right':
                strut.set({x: m.x + m.width - thickness, y: m.y, width: thickness, height: m.height});
                break;
            case 'top':
                strut.set({x: m.x, y: m.y, width: m.width, height: thickness});
                break;
            case 'bottom':
                strut.set({x: m.x, y: m.y + m.height - thickness, width: m.width, height: thickness});
                break;
            }
        }
    }

    /**
     * Pack the tiles of each edge from its top/left end, keeping their
     * order, like WindowMaker's Arrange Icons.
     */
    arrangeTiles() {
        const byEdge = EDGES.map(edge => this.tiles
            .filter(t => t.placement?.edge === edge)
            .sort((a, b) => a.placement.depth - b.placement.depth ||
                a.placement.slot - b.placement.slot));
        // Unplaced tiles don't block the free-slot search
        byEdge.flat().forEach(t => (t.placement = null));
        EDGES.forEach((edge, i) => {
            let slot = 0;
            for (const tile of byEdge[i]) {
                const wanted = {edge, slot, depth: 0};
                const placement = this._nearestFree(wanted, tile) ?? wanted;
                this._place(tile, placement, true);
                slot = placement.slot + 1;
            }
        });
        this._queueUpdateStruts();
        this._queueSave();
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
        tile.connect('destroy', () => {
            this._tiles.delete(tile.id);
            this._queueUpdateStruts();
        });
        this._queueUpdateStruts();
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
        this._queueUpdateStruts();
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
        // Running apps get a tile unless an applet stands in for them
        const claimed = new Set(this.tiles.flatMap(t => t.claimedAppIds ?? []));
        for (const app of appSystem.get_running()) {
            if (!claimed.has(app.get_id()))
                wanted.set(app.get_id(), app);
        }

        for (const tile of [...this._tiles.values()]) {
            if (tile instanceof AppDocklet && !wanted.has(tile.app.get_id()))
                this._forgetTile(tile);
        }

        for (const [appId, app] of wanted) {
            if (this._tiles.has(`app:${appId}`))
                continue;
            const tile = new AppDocklet(app, this._appSettings[appId] ?? {});
            tile.connect('settings-changed', () => {
                const {command, icon, autolaunch} = tile.settings;
                if (command || icon || autolaunch)
                    this._appSettings[appId] = {...tile.settings};
                else
                    delete this._appSettings[appId];
                this._queueSave();
            });
            this._addTile(tile, this._firstFree(DEFAULT_APP_EDGE));
        }
    }

    _pinnedAppIds() {
        return new Set(global.settings.get_strv('favorite-apps'));
    }

    /** Unpinning an app forgets its tile settings. */
    _onPinnedChanged() {
        const pinned = this._pinnedAppIds();
        for (const appId of this._pinnedIds) {
            if (pinned.has(appId) || !this._appSettings[appId])
                continue;
            delete this._appSettings[appId];
            this._tiles.get(`app:${appId}`)?.setSettings({});
            this._queueSave();
        }
        this._pinnedIds = pinned;
    }

    /** Start the pinned apps whose tiles say so, once per session. */
    _autolaunch() {
        const appSystem = Shell.AppSystem.get_default();
        for (const [appId, settings] of Object.entries(this._appSettings)) {
            const app = appSystem.lookup_app(appId);
            if (!settings.autolaunch || app?.state !== Shell.AppState.STOPPED)
                continue;
            const tile = this._tiles.get(`app:${appId}`);
            if (tile)
                tile.launch();
            else
                launchApp(app, settings);
        }
    }

    // ---- files dropped from apps ------------------------------------

    _onClientDragBegin() {
        const selection = global.display.get_selection();
        if (selection.get_mimetypes(Meta.SelectionType.SELECTION_DND).includes(URI_LIST))
            DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion({x, y, source}) {
        if (source !== Main.xdndHandler)
            return DND.DragMotionResult.CONTINUE;
        const tile = this.tiles.find(t =>
            t instanceof AppDocklet && t.acceptsFiles && contains(t, x, y));
        this._setDropTile(tile ?? null);
        // Read the files while the drag is on: a drop on a tile isn't
        // a drop on a client, so the source goes away with it.
        if (tile && !this._dropUris)
            this._dropUris = readDraggedUris();
        return DND.DragMotionResult.CONTINUE;
    }

    _setDropTile(tile) {
        if (this._dropTile === tile)
            return;
        this._dropTile?.remove_style_pseudo_class('drop-target');
        this._dropTile = tile;
        tile?.add_style_pseudo_class('drop-target');
    }

    async _onClientDragEnd() {
        DND.removeDragMonitor(this._dragMonitor);
        const tile = this._dropTile;
        const uris = this._dropUris;
        this._setDropTile(null);
        this._dropUris = null;
        if (!tile || !uris)
            return;

        // The drag also ends on Escape; only a release is a drop
        const type = Clutter.get_current_event()?.type();
        const [x, y, mods] = global.get_pointer();
        const released = type === undefined
            ? !(mods & Clutter.ModifierType.BUTTON1_MASK)
            : type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END;
        if (!released || !contains(tile, x, y))
            return;

        const list = await uris;
        // The tile may have gone while the files were read
        if (list.length && this._tiles.get(tile.id) === tile)
            tile.launch(list);
    }

    // ---- applets -----------------------------------------------------

    isAppletEnabled(id) {
        return this._enabledApplets.includes(id);
    }

    /** Number of shown instances of a `multiple` applet. */
    appletCount(type) {
        return this._enabledApplets.filter(id => id.startsWith(`${type}:`)).length;
    }

    /** Show another instance of a `multiple` applet. */
    addAppletInstance(type) {
        if (!APPLETS.find(a => a.id === type)?.multiple)
            return;
        let n = 1;
        while (this.isAppletEnabled(`${type}:${n}`))
            n++;
        this.setAppletEnabled(`${type}:${n}`, true);
    }

    setAppletEnabled(id, enabled) {
        const info = appletInfo(id);
        if (enabled === this.isAppletEnabled(id) || !info)
            return;

        if (enabled) {
            this._enabledApplets.push(id);
            if (this._populated)
                this._addApplet(id);
        } else {
            this._enabledApplets = this._enabledApplets.filter(a => a !== id);
            // An instance id may be reused by the next one added
            if (info.multiple)
                delete this._appletSettings[id];
            const tile = this._tiles.get(id);
            if (tile) {
                this._forgetTile(tile);
                // A running app it stood in for needs its own tile again
                if (tile.claimedAppIds.length > 0)
                    this._syncAppTiles();
            }
        }
        this._queueSave();
        this.emit('applets-changed');
    }

    _addApplet(id) {
        const info = appletInfo(id);
        if (!info || this._tiles.has(id))
            return;
        let tile;
        try {
            tile = new info.type(id, this._appletSettings[id] ?? {});
        } catch (e) {
            console.error(`Failed to create applet ${id}: ${e.message}`);
            return;
        }
        tile.connect('settings-changed', () => {
            this._appletSettings[id] = {...tile.settings};
            this._queueSave();
        });
        tile.connect('remove-requested', () => this.setAppletEnabled(id, false));
        tile.connect('claims-changed', () => this._syncAppTiles());
        this._addTile(tile, this._firstFree(DEFAULT_APPLET_EDGE));
        if (tile.claimedAppIds.length > 0)
            this._syncAppTiles();
    }

    // ---- persistence ------------------------------------------------

    _loadApplets() {
        this._enabledApplets = [...DEFAULT_APPLETS];
        this._appletSettings = {};
        try {
            const [, bytes] = this._appletsFile.load_contents(null);
            const state = JSON.parse(new TextDecoder().decode(bytes));
            if (Array.isArray(state.enabled))
                this._enabledApplets = state.enabled.filter(id => appletInfo(id));
            if (state.settings && typeof state.settings === 'object')
                this._appletSettings = state.settings;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load applets: ${e.message}`);
        }
    }

    /** @returns {object|null} the file's JSON object, or null */
    _loadJson(file) {
        try {
            const [, bytes] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return data && typeof data === 'object' ? data : null;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Failed to load ${file.get_basename()}: ${e.message}`);
            return null;
        }
    }

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
        this._writeJson(this._stateFile, list);
        this._writeJson(this._appletsFile, {
            enabled: this._enabledApplets,
            settings: this._appletSettings,
        });
        this._writeJson(this._appTilesFile, this._appSettings);
    }

    _writeJson(file, data) {
        try {
            const dir = file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            file.replace_contents(
                JSON.stringify(data, null, 2), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Failed to save ${file.get_basename()}: ${e.message}`);
        }
    }
}

/** Whether stage point x, y is inside `actor`'s on-screen box. */
function contains(actor, x, y) {
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax && x < ax + w && y >= ay && y < ay + h;
}

/**
 * Files offered by the drag in progress.
 *
 * @returns {Promise<string[]>} their URIs
 */
function readDraggedUris() {
    const selection = global.display.get_selection();
    const stream = Gio.MemoryOutputStream.new_resizable();
    return new Promise(resolve => {
        selection.transfer_async(Meta.SelectionType.SELECTION_DND, URI_LIST, -1,
            stream, null, (_s, res) => {
                try {
                    selection.transfer_finish(res);
                    if (!stream.is_closed())
                        stream.close(null);
                    const text = new TextDecoder().decode(stream.steal_as_bytes().toArray());
                    // text/uri-list: one URI per line, # starts a comment
                    resolve(text.split(/\r?\n/).map(l => l.trim())
                        .filter(l => l && !l.startsWith('#')));
                } catch (e) {
                    console.warn(`Failed to read dropped files: ${e.message}`);
                    resolve([]);
                }
            });
    });
}
