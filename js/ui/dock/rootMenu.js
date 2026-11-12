import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../main.js';
import * as SystemActions from '../../misc/systemActions.js';
import {findApp} from './applet.js';
import {APPLETS} from './applets.js';

const KEYBINDINGS_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const WM_PREFS_SCHEMA = 'org.gnome.desktop.wm.preferences';
const MAX_WORKSPACE_KEYBINDING = 12;
/** Pointer travel that turns a release into a selection */
const ARM_DISTANCE = 4;
/** How long the pointer may rest on a sibling on its way to a submenu */
const SUBMENU_DELAY = 200;

/**
 * @typedef {object} ItemDef
 * @property {string} label
 * @property {boolean} [ornament] - show the ◆ marker (current choice)
 * @property {string} [accel] - right-aligned text, e.g. a shortcut
 * @property {boolean} [sensitive=true]
 * @property {function(): MenuDef} [submenu]
 * @property {function(): void} [activate]
 */

/**
 * @typedef {object} MenuDef
 * @property {string} [id] - top-level menus: a torn-off menu with the
 *   same id comes back instead of a second copy
 * @property {string} title
 * @property {function(): ItemDef[]} items - called on every (re)build
 */

const MenuItem = GObject.registerClass({
    Signals: {'clicked': {}},
}, class MenuItem extends St.BoxLayout {
    /**
     * @param {Menu} menu
     * @param {ItemDef} def
     */
    _init(menu, def) {
        super._init({
            style_class: 'wm-menu-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this.menu = menu;
        this.def = def;
        this.sensitive = def.sensitive ?? true;
        if (!this.sensitive)
            this.add_style_pseudo_class('insensitive');

        this.add_child(new St.Label({
            style_class: 'wm-menu-ornament',
            text: def.ornament ? '◆' : '',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(new St.Label({
            style_class: 'wm-menu-label',
            text: def.label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (def.accel) {
            this.add_child(new St.Label({
                style_class: 'wm-menu-accel',
                text: def.accel,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (def.submenu) {
            this.add_child(new St.Icon({
                style_class: 'wm-menu-arrow',
                icon_name: 'pan-end-symbolic',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Only used by torn-off menus; open menus are driven by the
        // manager, which sees every event while it holds the grab.
        this._click = new Clutter.ClickGesture({enabled: false});
        this._click.connect('recognize', () => this.emit('clicked'));
        this.add_action(this._click);
    }

    set clickable(clickable) {
        this._click.enabled = clickable;
    }

    set selected(selected) {
        if (selected)
            this.add_style_pseudo_class('selected');
        else
            this.remove_style_pseudo_class('selected');
    }
});

/**
 * One menu: a title bar and a column of items. Dragging the title
 * moves the menu and emits 'torn-off'; torn-off menus show a close
 * button.
 */
const Menu = GObject.registerClass({
    Signals: {
        'torn-off': {},
        'close-requested': {},
    },
}, class Menu extends St.BoxLayout {
    /** @param {MenuDef} def */
    _init(def) {
        super._init({
            style_class: 'wm-menu',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this.def = def;
        this.pinned = false;
        /** item of the parent menu this one cascades from */
        this.sourceItem = null;
        /** @type {MenuItem|null} */
        this.selected = null;
        /** Called when an item of a torn-off menu is clicked */
        this.onItemClicked = null;

        this._title = new St.BoxLayout({
            style_class: 'wm-menu-title',
            reactive: true,
        });
        this._title.add_child(new St.Label({
            style_class: 'wm-menu-title-label',
            text: def.title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._closeButton = new St.Button({
            style_class: 'wm-menu-close',
            child: new St.Icon({
                style_class: 'wm-menu-close-icon',
                icon_name: 'window-close-symbolic',
            }),
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closeButton.connect('clicked', () => this.emit('close-requested'));
        this._title.add_child(this._closeButton);
        this.add_child(this._title);

        this._items = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(this._items);

        const pan = new Clutter.PanGesture({begin_threshold: 8});
        pan.connect('recognize', () => this._onDragBegin());
        pan.connect('pan-update', () => this._onDragUpdate());
        pan.connect('end', () => this._onDragEnd());
        pan.connect('cancel', () => this._onDragEnd());
        this._title.add_action(pan);
        this.connect('destroy', () => this._grab?.dismiss());

        this.refresh();
    }

    get items() {
        return this._items.get_children();
    }

    get dragging() {
        return !!this._grab;
    }

    get titleHeight() {
        return this._title.get_preferred_height(-1)[1];
    }

    setPinned(pinned) {
        this.pinned = pinned;
        this._closeButton.visible = pinned;
        if (pinned)
            this.add_style_class_name('wm-menu-pinned');
        else
            this.remove_style_class_name('wm-menu-pinned');
        this.items.forEach(i => (i.clickable = pinned));
    }

    /** Rebuild the items, keeping the selection by position. */
    refresh() {
        const index = this.items.indexOf(this.selected);
        this._items.destroy_all_children();
        this.selected = null;
        for (const def of this.def.items()) {
            const item = new MenuItem(this, def);
            item.clickable = this.pinned;
            item.connect('clicked', () => this.onItemClicked?.(item));
            this._items.add_child(item);
        }
        if (index >= 0)
            this.select(this.items[index] ?? null);
    }

    select(item) {
        if (this.selected === item)
            return;
        if (this.selected)
            this.selected.selected = false;
        this.selected = item;
        if (item)
            item.selected = true;
    }

    /** Select the next sensitive item in `direction` (±1), wrapping. */
    selectNext(direction) {
        const items = this.items.filter(i => i.sensitive);
        if (!items.length)
            return;
        const index = items.indexOf(this.selected);
        const next = index < 0
            ? direction > 0 ? 0 : items.length - 1
            : (index + direction + items.length) % items.length;
        this.select(items[next]);
    }

    _onDragBegin() {
        const [px, py] = global.get_pointer();
        this._dragOffset = [px - this.x, py - this.y];
        this._grab = global.stage.grab(this);
    }

    _onDragUpdate() {
        if (!this._grab)
            return;
        const [px, py] = global.get_pointer();
        const [dx, dy] = this._dragOffset;
        this.set_position(Math.round(px - dx), Math.round(py - dy));
    }

    _onDragEnd() {
        if (!this._grab)
            return;
        this._grab.dismiss();
        this._grab = null;
        if (!this.pinned)
            this.emit('torn-off');
    }
});

/**
 * WindowMaker-style root menu, opened by right-clicking the desktop,
 * and window list, opened by middle-clicking it.
 *
 * Open menus form a chain (root, then each cascaded submenu) shown on a
 * full-screen layer that holds a modal grab, so the manager sees every
 * event: hovering an item cascades its submenu, and releasing a press
 * over an item activates it, whether the press started on the item or
 * on the desktop. Dragging a menu's title tears it off: it leaves the
 * chain and stays on screen as chrome until its close button is used.
 */
export class RootMenu {
    constructor() {
        this._chain = [];
        this._pinned = new Set();
        this._grab = null;
        this._lastMotion = null;
        this._hoverTimeoutId = 0;

        this._layer = new St.Widget({
            reactive: true,
            visible: false,
            constraints: new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
        });
        this._layer.connect('captured-event', (_a, event) => this._onEvent(event));
        Main.uiGroup.add_child(this._layer);

        this._keybindings = new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA});
        this._wmPrefs = new Gio.Settings({schema_id: WM_PREFS_SCHEMA});

        const wm = global.workspace_manager;
        this._activeWorkspace = wm.get_active_workspace_index();
        this._lastWorkspace = -1;
        wm.connectObject(
            'active-workspace-changed', () => {
                this._lastWorkspace = this._activeWorkspace;
                this._activeWorkspace = wm.get_active_workspace_index();
                this._refreshPinned();
            },
            'notify::n-workspaces', () => this._refreshPinned(),
            this);
        Main.dock.connectObject('applets-changed', () => this._refreshPinned(), this);
        // Keeps a torn-off window list current
        global.display.connectObject(
            'restacked', () => this._refreshPinned(),
            'notify::focus-window', () => this._refreshPinned(),
            this);

        // Hide Others keeps this app, even if the desktop took focus
        const tracker = Shell.WindowTracker.get_default();
        this._lastFocusApp = tracker.focus_app;
        tracker.connectObject('notify::focus-app', () => {
            if (tracker.focus_app)
                this._lastFocusApp = tracker.focus_app;
        }, this);

        Main.wm.addKeybinding('open-window-list',
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => {
                const [x, y] = global.get_pointer();
                this.popupWindowList(x, y, true);
            });
    }

    /**
     * Open the root menu with its title under the pointer at x, y.
     *
     * @param {number} x
     * @param {number} y
     * @param {boolean} [fromKeyboard] - select the first item
     */
    popup(x, y, fromKeyboard = false) {
        this._popup(this._rootDef(), x, y, fromKeyboard);
    }

    /** Open the list of all windows at x, y. */
    popupWindowList(x, y, fromKeyboard = false) {
        this._popup(this._windowListDef(), x, y, fromKeyboard);
    }

    _popup(def, x, y, fromKeyboard) {
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return;
        this.close();

        // There is only one of each: a torn-off one comes back
        let menu = [...this._pinned].find(m => m.def.id === def.id);
        if (menu)
            this._unpin(menu);
        else
            menu = this._createMenu(def);

        this._layer.add_child(menu);
        this._chain.push(menu);
        const monitor = this._monitorAt(x, y);
        const [, , w, h] = menu.get_preferred_size();
        menu.set_position(
            Math.round(Math.clamp(x - 24, monitor.x, monitor.x + monitor.width - w)),
            Math.round(Math.clamp(y - menu.titleHeight / 2, monitor.y, monitor.y + monitor.height - h)));

        this._pressPoint = [x, y];
        this._armed = false;
        this._layer.show();
        Main.uiGroup.set_child_above_sibling(this._layer, null);
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        if (fromKeyboard)
            menu.selectNext(1);
    }

    /** Close all open (not torn-off) menus. */
    close() {
        this._cancelHoverTimeout();
        for (const menu of this._chain) {
            if (menu.sourceItem?.menu.pinned)
                menu.sourceItem.menu.select(null);
            menu.destroy();
        }
        this._chain = [];
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._layer.hide();
    }

    _createMenu(def) {
        const menu = new Menu(def);
        menu.connect('torn-off', () => this._pin(menu));
        menu.connect('close-requested', () => {
            if (this._chain[0]?.sourceItem?.menu === menu)
                this.close();
            menu.destroy();
        });
        menu.connect('destroy', () => this._pinned.delete(menu));
        menu.onItemClicked = item => this._activate(item);
        return menu;
    }

    // ---- open chain ---------------------------------------------------

    _onEvent(event) {
        // A menu being dragged by its title has a grab of its own
        if (this._chain.some(m => m.dragging))
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        const [x, y] = event.get_coords();

        switch (type) {
        case Clutter.EventType.MOTION: {
            const [px, py] = this._pressPoint;
            if (Math.abs(x - px) > ARM_DISTANCE || Math.abs(y - py) > ARM_DISTANCE)
                this._armed = true;
            const item = this._itemAt(x, y);
            if (item)
                this._hover(item, x, y);
            this._lastMotion = [x, y];
            return Clutter.EVENT_PROPAGATE;
        }
        case Clutter.EventType.BUTTON_PRESS:
        case Clutter.EventType.TOUCH_BEGIN:
            this._armed = true;
            if (!this._chain.some(m => contains(m, x, y))) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.EventType.BUTTON_RELEASE:
        case Clutter.EventType.TOUCH_END: {
            const item = this._itemAt(x, y);
            if (!item || !this._armed)
                return Clutter.EVENT_PROPAGATE;
            this._activate(item);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.KEY_PRESS:
            return this._onKeyPress(event.get_key_symbol());
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(symbol) {
        const menu = this._chain.at(-1);
        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_Up:
            menu.selectNext(symbol === Clutter.KEY_Down ? 1 : -1);
            this._truncate(menu);
            break;
        case Clutter.KEY_Right:
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space: {
            const item = menu.selected;
            if (item?.def.submenu && item.sensitive)
                this._openSubmenu(item)?.selectNext(1);
            else if (item && symbol !== Clutter.KEY_Right)
                this._activate(item);
            break;
        }
        case Clutter.KEY_Left:
            if (this._chain.length > 1 && this._chain.includes(menu.sourceItem?.menu))
                this._truncate(menu.sourceItem.menu);
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    /**
     * Item of an open menu at x, y. Found by geometry rather than by
     * picking, which can lag behind a menu that was just opened.
     */
    _itemAt(x, y) {
        // Cascaded menus can overlap their parent; the deepest is on top
        const menu = this._chain.findLast(m => contains(m, x, y));
        return menu?.items.find(i => contains(i, x, y)) ?? null;
    }

    _hover(item, x, y, force = false) {
        this._cancelHoverTimeout();
        const next = this._chain[this._chain.indexOf(item.menu) + 1];
        if (next?.sourceItem === item) {
            item.menu.select(item);
            return;
        }
        // Heading for the open submenu across a sibling: keep it open,
        // unless the pointer comes to rest on the sibling.
        if (next && !force && this._movingToward(next, x, y)) {
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBMENU_DELAY, () => {
                this._hoverTimeoutId = 0;
                const [px, py] = global.get_pointer();
                if (this._itemAt(px, py) === item)
                    this._hover(item, px, py, true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        item.menu.select(item.sensitive ? item : null);
        this._truncate(item.menu);
        if (item.def.submenu && item.sensitive)
            this._openSubmenu(item);
    }

    _cancelHoverTimeout() {
        if (this._hoverTimeoutId)
            GLib.source_remove(this._hoverTimeoutId);
        this._hoverTimeoutId = 0;
    }

    /**
     * Whether the pointer, moving from its last position to x, y, is
     * inside the triangle spanned by that position and the near edge
     * of `submenu`.
     */
    _movingToward(submenu, x, y) {
        if (!this._lastMotion)
            return false;
        const [ax, ay] = this._lastMotion;
        const [sx, sy] = submenu.get_transformed_position();
        const [sw, sh] = submenu.get_transformed_size();
        const edge = sx >= ax ? sx : sx + sw;
        return inTriangle(x, y, ax, ay, edge, sy, edge, sy + sh);
    }

    /** Close every menu cascaded from `menu`. */
    _truncate(menu) {
        const index = this._chain.indexOf(menu);
        if (index < 0)
            return;
        for (const m of this._chain.splice(index + 1))
            m.destroy();
    }

    /** Cascade `item`'s submenu beside it, opening the chain if needed. */
    _openSubmenu(item) {
        const menu = this._createMenu(item.def.submenu());
        menu.sourceItem = item;
        this._layer.add_child(menu);

        const [mx, my] = item.menu.get_transformed_position();
        const [mw] = item.menu.get_transformed_size();
        const [, iy] = item.get_transformed_position();
        const [, , w, h] = menu.get_preferred_size();
        const monitor = this._monitorAt(mx, iy);
        let x = mx + mw;
        if (x + w > monitor.x + monitor.width)
            x = mx - w;
        // Line the first item up with the item it cascades from
        const y = Math.clamp(iy - menu.titleHeight, monitor.y, monitor.y + monitor.height - h);
        menu.set_position(Math.round(x), Math.round(y));

        if (item.menu.pinned) {
            // A torn-off menu opens a fresh chain of its own
            this.close();
            item.menu.select(item);
            this._chain.push(menu);
            this._pressPoint = global.get_pointer();
            this._armed = false;
            this._layer.show();
            Main.uiGroup.set_child_above_sibling(this._layer, null);
            this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        } else {
            this._chain.push(menu);
        }
        return menu;
    }

    _activate(item) {
        if (!item.sensitive)
            return;
        if (item.def.submenu) {
            if (item.menu.pinned)
                this._openSubmenu(item);
            return;
        }
        this.close();
        item.def.activate?.();
    }

    // ---- torn-off menus -------------------------------------------------

    _pin(menu) {
        const index = this._chain.indexOf(menu);
        if (index < 0)
            return;
        // The torn-off menu stays; everything else closes
        this._chain.splice(index, 1);
        this.close();

        menu.sourceItem = null;
        this._layer.remove_child(menu);
        Main.layoutManager.addChrome(menu, {trackFullscreen: true});
        menu.setPinned(true);
        menu.select(null);
        menu.refresh();
        this._pinned.add(menu);
    }

    _unpin(menu) {
        this._pinned.delete(menu);
        Main.layoutManager.removeChrome(menu);
        menu.setPinned(false);
        menu.select(null);
        menu.refresh();
    }

    _refreshPinned() {
        for (const menu of this._pinned)
            menu.refresh();
    }

    _monitorAt(x, y) {
        const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
        const index = global.display.get_monitor_index_for_rect(rect);
        return Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
    }

    // ---- menu contents --------------------------------------------------

    _rootDef() {
        const actions = SystemActions.getDefault();
        return {
            id: 'root',
            title: _('MyShell'),
            items: () => [
                {label: _('Workspaces'), submenu: () => this._workspacesDef()},
                {label: _('Workspace'), submenu: () => this._workspaceDef()},
                {label: _('Applets'), submenu: () => this._appletsDef()},
                {
                    label: _('Display Settings'),
                    sensitive: Main.sessionMode.allowSettings,
                    activate: () => findApp('gnome-display-panel.desktop')?.activate(),
                },
                {
                    label: _('Settings'),
                    sensitive: Main.sessionMode.allowSettings,
                    activate: () => findApp('org.gnome.Settings.desktop')?.activate(),
                },
                {
                    label: _('Exit'),
                    sensitive: actions.canLogout,
                    activate: () => actions.activateLogout(),
                },
            ],
        };
    }

    _workspacesDef() {
        return {
            title: _('Workspaces'),
            items: () => {
                const wm = global.workspace_manager;
                const n = wm.n_workspaces;
                const dynamic = Meta.prefs_get_dynamic_workspaces();
                const items = [
                    {label: _('New'), activate: () => this._newWorkspace()},
                    {
                        // Dynamic workspaces remove empty ones themselves
                        label: _('Destroy Last'),
                        sensitive: !dynamic && n > 1,
                        activate: () => this._wmPrefs.set_int('num-workspaces', n - 1),
                    },
                    {
                        label: _('Last Used'),
                        sensitive: this._lastWorkspace >= 0 && this._lastWorkspace < n,
                        activate: () => this._activateWorkspace(this._lastWorkspace),
                    },
                ];
                const active = wm.get_active_workspace_index();
                for (let i = 0; i < n; i++) {
                    items.push({
                        label: Meta.prefs_get_workspace_name(i),
                        ornament: i === active,
                        accel: this._workspaceAccel(i),
                        activate: () => this._activateWorkspace(i),
                    });
                }
                return items;
            },
        };
    }

    /** Actions on the current workspace, as in WindowMaker. */
    _workspaceDef() {
        return {
            title: _('Workspace'),
            items: () => [
                {
                    label: _('Hide Others'),
                    sensitive: !!this._lastFocusApp,
                    activate: () => this._hideOthers(),
                },
                {label: _('Show All'), activate: () => this._showAll()},
                {label: _('Arrange Icons'), activate: () => Main.dock.arrangeTiles()},
            ],
        };
    }

    /** Windows on the current workspace that can be hidden. */
    _workspaceWindows() {
        return global.workspace_manager.get_active_workspace().list_windows()
            .filter(w => !w.skip_taskbar && w.can_minimize());
    }

    /** Minimize every window that isn't the focused app's. */
    _hideOthers() {
        const tracker = Shell.WindowTracker.get_default();
        for (const window of this._workspaceWindows()) {
            if (tracker.get_window_app(window) !== this._lastFocusApp)
                window.minimize();
        }
    }

    _showAll() {
        for (const window of this._workspaceWindows())
            window.unminimize();
    }

    /** Every window, by workspace, as in WindowMaker's window list. */
    _windowListDef() {
        return {
            id: 'windows',
            title: _('Windows'),
            items: () => {
                const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
                    .filter(w => !w.skip_taskbar);
                // On every workspace comes first
                const workspaceOf = w => w.is_on_all_workspaces()
                    ? -1 : w.get_workspace()?.index() ?? -1;
                windows.sort((a, b) => workspaceOf(a) - workspaceOf(b) ||
                    a.get_stable_sequence() - b.get_stable_sequence());
                if (!windows.length)
                    return [{label: _('No Windows'), sensitive: false}];

                const tracker = Shell.WindowTracker.get_default();
                const focus = global.display.focus_window;
                return windows.map(window => {
                    const index = workspaceOf(window);
                    return {
                        label: window.title || tracker.get_window_app(window)?.get_name() || _('Untitled'),
                        ornament: window === focus,
                        accel: index < 0 ? _('All') : Meta.prefs_get_workspace_name(index),
                        activate: () => Main.activateWindow(window),
                    };
                });
            },
        };
    }

    _appletsDef() {
        return {
            title: _('Applets'),
            items: () => APPLETS.map(info => {
                if (info.multiple) {
                    const count = Main.dock.appletCount(info.id);
                    return {
                        label: _('Add %s').format(info.name),
                        accel: count ? String(count) : '',
                        activate: () => Main.dock.addAppletInstance(info.id),
                    };
                }
                const enabled = Main.dock.isAppletEnabled(info.id);
                return {
                    label: info.name,
                    ornament: enabled,
                    activate: () => Main.dock.setAppletEnabled(info.id, !enabled),
                };
            }),
        };
    }

    _activateWorkspace(index) {
        global.workspace_manager.get_workspace_by_index(index)
            ?.activate(global.get_current_time());
    }

    _newWorkspace() {
        const wm = global.workspace_manager;
        if (Meta.prefs_get_dynamic_workspaces()) {
            // There is always an empty workspace at the end
            this._activateWorkspace(wm.n_workspaces - 1);
            return;
        }
        const index = wm.n_workspaces;
        const id = wm.connect('notify::n-workspaces', () => {
            wm.disconnect(id);
            this._activateWorkspace(index);
        });
        this._wmPrefs.set_int('num-workspaces', index + 1);
    }

    _workspaceAccel(index) {
        if (index >= MAX_WORKSPACE_KEYBINDING)
            return '';
        const [accel] = this._keybindings.get_strv(`switch-to-workspace-${index + 1}`);
        return accel ? formatAccelerator(accel) : '';
    }
}

/** Whether stage point x, y is inside `actor`'s on-screen box. */
function contains(actor, x, y) {
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax && x < ax + w && y >= ay && y < ay + h;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const side = (x1, y1, x2, y2) => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d1 = side(ax, ay, bx, by);
    const d2 = side(bx, by, cx, cy);
    const d3 = side(cx, cy, ax, ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

/** '<Super><Shift>Home' → 'Super+Shift+Home' */
function formatAccelerator(accel) {
    const names = {Primary: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl'};
    return accel.replace(/<(\w+)>/g, (_m, mod) => `${names[mod] ?? mod}+`);
}
