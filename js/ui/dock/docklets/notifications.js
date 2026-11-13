import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as PopupMenu from '../../popupMenu.js';
import * as Util from '../../../misc/util.js';
import {formatTimeSpan} from '../../../misc/dateUtils.js';
import {Applet} from '../applet.js';

const MAX_SHOWN = 30;
const BOUNCE_HEIGHT = 12;
const BOUNCE_UP_TIME = 140;
const BOUNCE_DOWN_TIME = 520;

/**
 * The notifications GNOME Shell keeps, which the hidden top bar's
 * calendar menu would list: the tile shows how many there are on a red
 * badge that bounces when one arrives. A click lists them, newest
 * first; clicking one opens it, × dismisses it. Do Not Disturb is the
 * desktop's own setting, so banners stop but notifications still
 * collect here.
 */
export const NotificationsDocklet = GObject.registerClass(
class NotificationsDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'notifications-docklet'});

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._icon = new St.Icon({
            style_class: 'applet-icon',
            icon_size: 32,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // BinLayout only honors child alignment for expanding children
        this._badge = new St.Label({
            style_class: 'applet-badge notifications-docklet-badge',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.set_child(box);

        this._showingPopup = false;
        this._count = 0;

        this._dndSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._dndSettings.connectObject('changed::show-banners', () => {
            this._sync();
            this._refreshPopup();
        }, this);

        const tray = Main.messageTray;
        tray.connectObject(
            'source-added', (_t, source) => this._watchSource(source),
            'source-removed', () => this._onChanged(),
            this);
        for (const source of tray.getSources())
            this._watchSource(source);
        this._sync();
    }

    _watchSource(source) {
        source.connectObject(
            'notification-added', (_s, notification) => this._onAdded(notification),
            'notification-removed', () => this._onChanged(),
            'notify::count', () => this._onChanged(),
            this);
        this._onChanged();
    }

    /** @returns {MessageTray.Notification[]} newest first */
    get _notifications() {
        return Main.messageTray.getSources()
            .flatMap(source => source.notifications)
            .sort((a, b) => b.datetime.compare(a.datetime));
    }

    _onAdded(notification) {
        this._onChanged();
        // Transient ones come and go as a banner; only bounce for keepers
        if (!notification.isTransient)
            this._bounce();
    }

    _onChanged() {
        this._sync();
        this._refreshPopup();
    }

    _sync() {
        const count = this._notifications.length;
        this._count = count;
        this._badge.text = count > 99 ? '99+' : String(count);
        this._badge.visible = count > 0;

        const dnd = !this._dndSettings.get_boolean('show-banners');
        this._icon.icon_name = dnd
            ? 'notifications-disabled-symbolic'
            : 'preferences-system-notifications-symbolic';
        this._icon.opacity = count > 0 || dnd ? 255 : 160;

        this.accessible_name = count > 0
            ? _('%d notifications').format(count)
            : _('No notifications');
    }

    /** Hop up and bounce back down, like a ball. */
    _bounce() {
        const badge = this._badge;
        if (!badge.visible || !this.mapped)
            return;
        // Hop away from the edge the tile is on
        const away = {
            [St.Side.TOP]: [0, 1],
            [St.Side.BOTTOM]: [0, -1],
            [St.Side.LEFT]: [0, -1],
            [St.Side.RIGHT]: [0, -1],
        }[this.menuSide] ?? [0, -1];
        badge.remove_all_transitions();
        badge.set_pivot_point(0.5, 0.5);
        badge.set({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        badge.ease({
            translation_x: away[0] * BOUNCE_HEIGHT,
            translation_y: away[1] * BOUNCE_HEIGHT,
            scale_x: 1.25,
            scale_y: 1.25,
            duration: BOUNCE_UP_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                badge.ease({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    duration: BOUNCE_DOWN_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
                });
            },
        });
    }

    activate() {
        this._showingPopup = true;
        this.openPopup(menu => this._buildPopup(menu));
    }

    openMenu() {
        this._showingPopup = false;
        super.openMenu();
    }

    buildMenu(menu) {
        this._addDndSwitch(menu);
        if (this._count > 0)
            menu.addAction(_('Clear All'), () => clearAll());
    }

    _addDndSwitch(menu) {
        const dnd = new PopupMenu.PopupSwitchMenuItem(_('Do Not Disturb'),
            !this._dndSettings.get_boolean('show-banners'));
        dnd.connect('toggled', (_i, state) =>
            this._dndSettings.set_boolean('show-banners', !state));
        menu.addMenuItem(dnd);
    }

    // ---- popup ------------------------------------------------------

    _refreshPopup() {
        if (!this._showingPopup || !this._menu?.isOpen)
            return;
        this._menu.removeAll();
        this._buildPopup(this._menu);
    }

    _buildPopup(menu) {
        const notifications = this._notifications;
        if (notifications.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No Notifications'), {reactive: false});
            empty.add_style_class_name('notifications-applet-empty');
            menu.addMenuItem(empty);
        } else {
            const list = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'notifications-applet-list',
            });
            for (const notification of notifications.slice(0, MAX_SHOWN))
                list.add_child(this._createRow(notification));
            if (notifications.length > MAX_SHOWN) {
                list.add_child(new St.Label({
                    style_class: 'notifications-applet-more',
                    /* Translators: %d is a number of notifications */
                    text: _('and %d more').format(notifications.length - MAX_SHOWN),
                }));
            }
            const scroll = new St.ScrollView({
                style_class: 'notifications-applet-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                child: list,
            });
            // Not reactive itself: the rows are buttons of their own
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(scroll);
            menu.addMenuItem(item);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addDndSwitch(menu);
        if (notifications.some(n => !n.resident))
            menu.addAction(_('Clear All'), () => clearAll());
    }

    _createRow(notification) {
        const source = notification.source;
        const row = new St.BoxLayout({style_class: 'notifications-applet-row'});

        // St.Button centres its child unless the child expands
        const content = new St.BoxLayout({
            style_class: 'notifications-applet-content',
            x_expand: true,
        });
        content.add_child(new St.Icon({
            style_class: 'notifications-applet-icon',
            gicon: notification.gicon ?? source?.icon ?? null,
            fallback_icon_name: 'preferences-system-notifications-symbolic',
            icon_size: 32,
            y_align: Clutter.ActorAlign.START,
        }));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'notifications-applet-header'});
        header.add_child(label('notifications-applet-app', source?.title ?? '', true));
        header.add_child(label('notifications-applet-time', formatTimeSpan(notification.datetime)));
        text.add_child(header);
        text.add_child(label('notifications-applet-title',
            (notification.title ?? '').replace(/\n/g, ' ')));
        if (notification.body) {
            const body = new St.Label({style_class: 'notifications-applet-body'});
            body.clutter_text.set_markup(Util.fixMarkup(notification.body,
                notification.useBodyMarkup));
            body.clutter_text.line_wrap = true;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(body);
        }
        content.add_child(text);

        const open = new St.Button({
            style_class: 'notifications-applet-open',
            child: content,
            can_focus: true,
            x_expand: true,
            accessible_name: notification.title ?? '',
        });
        open.connect('clicked', () => {
            this._menu?.close();
            notification.activate();
        });
        row.add_child(open);

        const close = new St.Button({
            style_class: 'notifications-applet-close',
            icon_name: 'window-close-symbolic',
            accessible_name: _('Dismiss'),
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => notification.destroy());
        row.add_child(close);
        return row;
    }
});

/** Dismiss every notification that can be dismissed. */
function clearAll() {
    for (const source of Main.messageTray.getSources()) {
        for (const notification of [...source.notifications]) {
            if (!notification.resident)
                notification.destroy();
        }
    }
}

function label(styleClass, text, expand = false) {
    const l = new St.Label({style_class: styleClass, text, x_expand: expand});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}
