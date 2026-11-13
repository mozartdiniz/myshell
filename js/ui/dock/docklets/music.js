import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as PopupMenu from '../../popupMenu.js';
import * as Signals from '../../../misc/signals.js';
import {loadInterfaceXML} from '../../../misc/fileUtils.js';
import {Applet, findApp} from '../applet.js';

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.DBus'));

// The shell's own MPRIS interface files only have what its media
// notification needs
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
  </interface>
</node>`);
const TrackListProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.TrackList">
    <method name="GetTracksMetadata">
      <arg direction="in" name="TrackIds" type="ao"/>
      <arg direction="out" name="Metadata" type="aa{sv}"/>
    </method>
    <method name="GoTo"><arg direction="in" name="TrackId" type="o"/></method>
    <signal name="TrackListReplaced">
      <arg name="Tracks" type="ao"/>
      <arg name="CurrentTrack" type="o"/>
    </signal>
    <property name="Tracks" type="ao" access="read"/>
  </interface>
</node>`);

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const FIGARO = 'io.github.mozartdiniz.Figaro.desktop';
const FIGARO_BUS_NAME = `${MPRIS_PREFIX}figaro`;
const UP_NEXT = 10;
const SCROLL_TIME = 250;
const ART_SIZE = 62;
const POPUP_ART_SIZE = 64;
const ROW_ART_SIZE = 32;

/**
 * One MPRIS player on the session bus. Emits 'changed' when its state
 * or track changes and 'tracks-changed' when its track list does.
 */
class MprisPlayer extends Signals.EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this._root = null;
        this._player = null;
        this._trackList = null;
        this._replacedId = 0;
        this.metadata = parseMetadata({});
        this.lastPlayed = 0;
    }

    async init(cancellable) {
        const flags = Gio.DBusProxyFlags.DO_NOT_AUTO_START |
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES;
        [this._root, this._player] = await Promise.all([
            MprisProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH, cancellable, flags),
            PlayerProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH, cancellable, flags),
        ]);
        if (this._root.HasTrackList) {
            this._trackList = await TrackListProxy.newAsync(Gio.DBus.session,
                this.busName, MPRIS_PATH, cancellable, flags);
            this._trackList.connectObject('g-properties-changed',
                () => this.emit('tracks-changed'), this);
            this._replacedId = this._trackList.connectSignal('TrackListReplaced',
                () => this.emit('tracks-changed'));
        }
        this._player.connectObject('g-properties-changed', () => this._sync(), this);
        this._root.connectObject('g-properties-changed', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._root?.disconnectObject(this);
        this._player?.disconnectObject(this);
        this._trackList?.disconnectObject(this);
        if (this._replacedId)
            this._trackList.disconnectSignal(this._replacedId);
    }

    get identity() {
        return this.app?.get_name() ?? this._root?.Identity ?? this.busName.slice(MPRIS_PREFIX.length);
    }

    get app() {
        const entry = this._root?.DesktopEntry;
        return entry ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`) : null;
    }

    get status() {
        return this._player?.PlaybackStatus ?? 'Stopped';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get canGoNext() {
        return !!this._player?.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._player?.CanGoPrevious;
    }

    get hasTrackList() {
        return !!this._trackList;
    }

    _sync() {
        const raw = {};
        for (const [key, value] of Object.entries(this._player.Metadata ?? {}))
            raw[key] = value.deepUnpack();
        this.metadata = parseMetadata(raw);
        if (this.playing)
            this.lastPlayed = GLib.get_monotonic_time();
        this.emit('changed');
    }

    playPause() {
        this._player?.PlayPauseAsync().catch(logError);
    }

    next() {
        this._player?.NextAsync().catch(logError);
    }

    previous() {
        this._player?.PreviousAsync().catch(logError);
    }

    goTo(trackId) {
        this._trackList?.GoToAsync(trackId).catch(logError);
    }

    get canQuit() {
        return !!this._root?.CanQuit;
    }

    quit() {
        this._root?.QuitAsync().catch(logError);
    }

    raise() {
        // Activating the app also works when it has quit since
        const app = this.app;
        if (app)
            app.activate();
        else if (this._root?.CanRaise)
            this._root.RaiseAsync().catch(logError);
    }

    /**
     * @param {number} count
     * @returns {Promise<{tracks: object[], more: number}>} the tracks after
     *   the current one, and how many more there are after those
     */
    async upNext(count) {
        if (!this._trackList)
            return {tracks: [], more: 0};
        const ids = this._trackList.Tracks ?? [];
        const current = ids.indexOf(this.metadata.trackId);
        const after = ids.slice(current + 1);
        const wanted = after.slice(0, count);
        if (wanted.length === 0)
            return {tracks: [], more: 0};
        const [list] = await this._trackList.GetTracksMetadataAsync(wanted);
        const tracks = list.map(dict => {
            const raw = {};
            for (const [key, value] of Object.entries(dict))
                raw[key] = value.deepUnpack();
            return parseMetadata(raw);
        });
        return {tracks, more: after.length - tracks.length};
    }
}

/** The MPRIS fields we show, validated: some players send odd types. */
function parseMetadata(raw) {
    const artists = raw['xesam:artist'];
    return {
        trackId: typeof raw['mpris:trackid'] === 'string' ? raw['mpris:trackid'] : null,
        title: typeof raw['xesam:title'] === 'string' ? raw['xesam:title'] : '',
        artist: Array.isArray(artists) ? artists.filter(a => typeof a === 'string').join(', ') : '',
        album: typeof raw['xesam:album'] === 'string' ? raw['xesam:album'] : '',
        artUrl: typeof raw['mpris:artUrl'] === 'string' ? raw['mpris:artUrl'] : '',
    };
}

/** @returns {Gio.Icon|null} for an artwork URI (file:// or http(s)://) */
function artIcon(uri) {
    if (!uri)
        return null;
    try {
        return new Gio.FileIcon({file: Gio.File.new_for_uri(uri)});
    } catch {
        return null;
    }
}

/**
 * Every MPRIS player on the session bus. Emits 'players-changed' when
 * one comes or goes and 'changed' when any player's state changes.
 */
class MprisWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, MprisPlayer>} */
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._nameOwnerId = 0;
        this._init();
    }

    get players() {
        return [...this._players.values()];
    }

    async _init() {
        try {
            this._proxy = await DBusProxy.newAsync(Gio.DBus.session,
                'org.freedesktop.DBus', '/org/freedesktop/DBus', this._cancellable);
            this._nameOwnerId = this._proxy.connectSignal('NameOwnerChanged',
                (_p, _s, [name, oldOwner, newOwner]) => {
                    if (!name.startsWith(MPRIS_PREFIX))
                        return;
                    if (oldOwner)
                        this._remove(name);
                    if (newOwner)
                        this._add(name);
                });
            const [names] = await this._proxy.ListNamesAsync();
            for (const name of names) {
                if (name.startsWith(MPRIS_PREFIX))
                    this._add(name);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Music applet: watching media players');
        }
    }

    async _add(busName) {
        if (this._players.has(busName))
            return;
        const player = new MprisPlayer(busName);
        this._players.set(busName, player);
        try {
            await player.init(this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                log(`Music applet: ignoring ${busName}: ${e.message}`);
            if (this._players.get(busName) === player)
                this._players.delete(busName);
            return;
        }
        if (this._players.get(busName) !== player) {
            player.destroy(); // went away meanwhile
            return;
        }
        player.connect('changed', () => this.emit('changed'));
        player.connect('tracks-changed', () => this.emit('tracks-changed', player));
        this.emit('players-changed');
    }

    _remove(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.destroy();
        this.emit('players-changed');
    }

    destroy() {
        this._cancellable.cancel();
        if (this._nameOwnerId)
            this._proxy.disconnectSignal(this._nameOwnerId);
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
    }
}

/**
 * Figaro's tile (or another MPRIS player's): it shows the album art,
 * or the app's icon, with a play/pause button in its corner. The button
 * plays and pauses; the rest of the tile opens the song's details, the
 * transport buttons and the songs up next, which can be played from
 * there (for players that share their queue, as Figaro does). Scrolling
 * skips songs; middle-click shows or hides the app's window. With the
 * app not running, a click starts it.
 *
 * It stands in for the app's own tile, so the dock gives the app none
 * while it runs.
 */
export const MusicDocklet = GObject.registerClass(
class MusicDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'music-docklet'});

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._art = new St.Icon({
            style_class: 'music-docklet-art',
            icon_size: ART_SIZE,
            x_expand: true,
            y_expand: true,
        });
        this._noArt = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appIcon = new St.Icon({
            style_class: 'applet-icon',
            icon_size: 36,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            style_class: 'applet-small applet-music-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._noArt.add_child(this._appIcon);
        this._noArt.add_child(this._title);

        // Not reactive: the tile tells a click on it apart by position
        this._button = new St.Bin({
            style_class: 'music-docklet-button',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            child: new St.Icon({
                style_class: 'music-docklet-button-icon',
                icon_name: 'media-playback-start-symbolic',
            }),
        });
        this._dot = new St.Widget({
            style_class: 'docklet-running-dot',
            // BinLayout only honors child alignment for expanding children
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._art);
        box.add_child(this._noArt);
        box.add_child(this._button);
        box.add_child(this._dot);
        this.set_child(box);

        this._lastScroll = 0;
        this.connect('scroll-event', (_a, event) => this._onScroll(event));

        this._showingPopup = false;
        this._upNextGeneration = 0;
        this._watcher = new MprisWatcher();
        this._watcher.connectObject(
            'players-changed', () => this._sync(),
            'changed', () => this._sync(),
            'tracks-changed', (_w, player) => {
                if (player === this._player)
                    this._refreshPopup();
            },
            this);
        Shell.AppSystem.get_default().connectObject('app-state-changed',
            () => this._sync(), this);
        this.connect('destroy', () => this._watcher.destroy());
        this._player = null;
        this._claimed = [];
        this._sync();
    }

    get defaults() {
        // 'auto', or the bus name suffix of the player to follow
        return {player: 'figaro'};
    }

    get claimedAppIds() {
        return this._claimed;
    }

    /**
     * The player to show: the chosen one, if it runs; with 'auto', one
     * that plays, the one that played last, Figaro, then any.
     */
    _pickPlayer() {
        const players = this._watcher.players;
        const {player} = this.settings;
        if (player !== 'auto')
            return players.find(p => p.busName === MPRIS_PREFIX + player) ?? null;
        const playing = players.filter(p => p.playing)
            .sort((a, b) => b.lastPlayed - a.lastPlayed);
        if (playing.length > 0)
            return playing[0];
        const played = players.filter(p => p.lastPlayed > 0)
            .sort((a, b) => b.lastPlayed - a.lastPlayed);
        return played[0] ??
            players.find(p => p.busName === FIGARO_BUS_NAME) ??
            players[0] ?? null;
    }

    settingsChanged() {
        this._sync();
    }

    _sync() {
        const player = this._pickPlayer();
        const changed = player !== this._player ||
            player?.metadata.trackId !== this._trackId ||
            player?.playing !== this._playing;
        this._player = player;
        this._trackId = player?.metadata.trackId;
        this._playing = player?.playing;

        const app = this._app;
        const claimed = app ? [app.get_id()] : [];
        if (claimed.join() !== this._claimed.join()) {
            this._claimed = claimed;
            this.emit('claims-changed');
        }

        const meta = player?.metadata;
        const art = artIcon(meta?.artUrl);
        this._art.gicon = art;
        this._art.visible = !!art;
        this._noArt.visible = !art;
        this._title.text = meta?.title || app?.get_name() || player?.identity || _('Music');
        if (app)
            this._appIcon.gicon = app.get_icon();
        else
            this._appIcon.icon_name = 'audio-x-generic-symbolic';
        this._dot.visible = !!app && app.state !== Shell.AppState.STOPPED;

        this._button.visible = !!player;
        this._button.child.icon_name = player?.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        if (!player)
            this.accessible_name = _('Music: not playing');
        else if (meta.title)
            this.accessible_name = `${meta.title}${meta.artist ? ` — ${meta.artist}` : ''}`;
        else
            this.accessible_name = player.identity;

        if (changed)
            this._refreshPopup();
    }

    /** The app the tile stands for: the player's, or Figaro if it's chosen. */
    get _app() {
        return this._player?.app ??
            (this.settings.player === 'figaro' ? findApp(FIGARO) : null);
    }

    /** Whether the app has a window showing; hidden or minimized ones don't count. */
    get _windowShown() {
        return !!this._app?.get_windows().some(w => !w.minimized);
    }

    /** Hide the app's windows by minimizing them, or bring them back. */
    _toggleWindow() {
        const app = this._app;
        if (!app)
            return;
        const windows = app.get_windows();
        if (this._windowShown) {
            for (const window of windows)
                window.minimize();
        } else if (windows.length > 0) {
            // Most recent last, so it ends up on top with the focus
            for (const window of windows.reverse())
                Main.activateWindow(window);
        } else {
            // A window the app hid, or a stopped app: ask it to show
            // itself
            app.activate();
        }
    }

    activate(button) {
        const player = this._player;
        if (button === Clutter.BUTTON_MIDDLE) {
            this._toggleWindow();
            return;
        }
        if (!player) {
            const app = this._app;
            if (app)
                app.activate();
            else
                Main.notify(_('No music player is running'), '');
            return;
        }

        const event = Clutter.get_current_event();
        const fromKeyboard = event?.type() === Clutter.EventType.KEY_PRESS ||
            event?.type() === Clutter.EventType.KEY_RELEASE;
        if (fromKeyboard || this._overButton()) {
            player.playPause();
            return;
        }
        this._showingPopup = true;
        this.openPopup(menu => this._buildPopup(menu));
    }

    openMenu() {
        this._showingPopup = false;
        super.openMenu();
    }

    _overButton() {
        const [px, py] = global.get_pointer();
        const box = this._button.get_transformed_extents();
        // A little slack: it's a small target in a corner
        return px >= box.origin.x - 4 && py >= box.origin.y - 4 &&
            px <= box.origin.x + box.size.width && py <= box.origin.y + box.size.height;
    }

    _onScroll(event) {
        const player = this._player;
        if (!player)
            return Clutter.EVENT_PROPAGATE;

        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            if (Math.abs(dy) < 0.5)
                return Clutter.EVENT_STOP;
            direction = dy > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
        }
        // One skip per flick, not one per scroll step
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastScroll < SCROLL_TIME)
            return Clutter.EVENT_STOP;
        this._lastScroll = now;

        if (direction === Clutter.ScrollDirection.DOWN && player.canGoNext)
            player.next();
        else if (direction === Clutter.ScrollDirection.UP && player.canGoPrevious)
            player.previous();
        return Clutter.EVENT_STOP;
    }

    buildMenu(menu) {
        const players = this._watcher.players;
        if (players.length > 1) {
            this.addChoice(menu, _('Player'), 'player', [
                ['auto', _('Automatic')],
                ...players.map(p => [p.busName.slice(MPRIS_PREFIX.length), p.identity]),
            ]);
        }
        this._addWindowActions(menu);
    }

    /** Show/Hide the app's window, and Quit. */
    _addWindowActions(menu) {
        const app = this._app;
        const name = app?.get_name() ?? this._player?.identity;
        if (app) {
            menu.addAction(this._windowShown
                ? _('Hide %s').format(name) : _('Show %s').format(name),
            () => this._toggleWindow());
        } else if (this._player) {
            menu.addAction(_('Show %s').format(name), () => this._player?.raise());
        }
        if (this._player?.canQuit)
            menu.addAction(_('Quit %s').format(name), () => this._player?.quit());
    }

    // ---- popup ------------------------------------------------------

    _refreshPopup() {
        if (!this._showingPopup || !this._menu?.isOpen)
            return;
        if (!this._player) {
            this._menu.close();
            return;
        }
        this._menu.removeAll();
        this._buildPopup(this._menu);
    }

    _buildPopup(menu) {
        const player = this._player;
        if (!player)
            return;
        const meta = player.metadata;

        // The song
        const nowItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'music-applet-now',
        });
        const nowBox = new St.BoxLayout({style_class: 'music-applet-now-box', x_expand: true});
        const art = artIcon(meta.artUrl);
        nowBox.add_child(new St.Icon({
            style_class: 'music-applet-now-art',
            gicon: art,
            icon_name: art ? null : 'audio-x-generic-symbolic',
            icon_size: POPUP_ART_SIZE,
        }));
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        text.add_child(label('music-applet-title', meta.title || _('Not Playing')));
        if (meta.artist)
            text.add_child(label('music-applet-artist', meta.artist));
        if (meta.album)
            text.add_child(label('music-applet-album', meta.album));
        nowBox.add_child(text);
        nowItem.add_child(nowBox);
        menu.addMenuItem(nowItem);

        // Transport
        const controlsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'music-applet-controls',
        });
        const controls = new St.BoxLayout({
            style_class: 'music-applet-controls-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const transport = [
            ['media-skip-backward-symbolic', _('Previous'), player.canGoPrevious, () => player.previous()],
            [player.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                player.playing ? _('Pause') : _('Play'), true, () => player.playPause()],
            ['media-skip-forward-symbolic', _('Next'), player.canGoNext, () => player.next()],
        ];
        for (const [iconName, name, sensitive, action] of transport) {
            const button = new St.Button({
                style_class: 'music-applet-control',
                icon_name: iconName,
                accessible_name: name,
                can_focus: true,
                reactive: sensitive,
            });
            if (!sensitive)
                button.add_style_pseudo_class('insensitive');
            button.connect('clicked', action);
            controls.add_child(button);
        }
        controlsItem.add_child(controls);
        menu.addMenuItem(controlsItem);

        // Up next
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Up Next')));
        const section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(section);
        if (player.hasTrackList) {
            section.addMenuItem(statusItem(_('Loading…')));
            this._fillUpNext(section, player);
        } else {
            section.addMenuItem(statusItem(
                _('%s doesn’t share what’s up next').format(player.identity)));
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addWindowActions(menu);
    }

    async _fillUpNext(section, player) {
        const generation = ++this._upNextGeneration;
        let result;
        try {
            result = await player.upNext(UP_NEXT);
        } catch (e) {
            result = null;
            log(`Music applet: up next from ${player.busName}: ${e.message}`);
        }
        // The popup was rebuilt or closed meanwhile
        if (generation !== this._upNextGeneration || !this._menu?.isOpen)
            return;

        section.removeAll();
        if (!result) {
            section.addMenuItem(statusItem(_('Couldn’t get the queue')));
            return;
        }
        if (result.tracks.length === 0) {
            section.addMenuItem(statusItem(_('Nothing more in the queue')));
            return;
        }
        for (const track of result.tracks) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'music-applet-track'});
            const art = artIcon(track.artUrl);
            item.add_child(new St.Icon({
                style_class: 'music-applet-track-art',
                gicon: art,
                icon_name: art ? null : 'audio-x-generic-symbolic',
                icon_size: ROW_ART_SIZE,
            }));
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            text.add_child(label('music-applet-track-title', track.title || _('Unknown title')));
            if (track.artist)
                text.add_child(label('music-applet-track-artist', track.artist));
            item.add_child(text);
            item.connect('activate', () => player.goTo(track.trackId));
            section.addMenuItem(item);
        }
        if (result.more > 0) {
            /* Translators: %d is a number of songs */
            section.addMenuItem(statusItem(_('and %d more').format(result.more)));
        }
    }
});

function label(styleClass, text) {
    const l = new St.Label({style_class: styleClass, text});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function statusItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
    item.add_style_class_name('music-applet-status');
    return item;
}
