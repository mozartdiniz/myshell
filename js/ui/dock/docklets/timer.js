import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Dialog from '../../dialog.js';
import * as Main from '../../main.js';
import * as MessageTray from '../../messageTray.js';
import * as ModalDialog from '../../modalDialog.js';
import * as PopupMenu from '../../popupMenu.js';
import * as ShellEntry from '../../shellEntry.js';
import {formatTime} from '../../../misc/dateUtils.js';
import {Applet} from '../applet.js';
import {ACCENT, TRACK} from './meter.js';

const MAX_MINUTES = 99;
const PRESETS = [5, 10, 15, 20, 25, 30, 45, 60, 90];

const ICON = 'alarm-symbolic';
const SOUND = 'alarm-clock-elapsed';

const HOVER_TIME = 400;
const FADE_TIME = 200;
// The bell swings RING_SWINGS times every RING_PERIOD ms while ringing
const RING_ANGLE = 18;
const RING_SWING_TIME = 80;
const RING_SWINGS = 4;
const RING_PERIOD = 1500;

const State = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    RINGING: 'ringing',
};

/**
 * @param {number} ms
 * @returns {string} m:ss, rounding up so it reaches 0:00 only at the end
 */
function formatRemaining(ms) {
    const secs = Math.ceil(ms / 1000);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * A countdown of up to 99 minutes. A click starts or pauses it; at zero
 * the numbers give way to a ringing bell and a notification, and once
 * that is acknowledged the timer starts again from the full duration.
 */
export const TimerDocklet = GObject.registerClass(
class TimerDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'timer-docklet'});

        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        // The number in the middle, seconds in the top right corner and
        // the bar along the bottom. BinLayout only honors child alignment
        // for expanding children.
        this._numbers = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._big = new St.Label({
            style_class: 'applet-timer-big',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._small = new St.Label({
            style_class: 'applet-small applet-timer-corner',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._bar = new St.DrawingArea({
            style_class: 'applet-timer-bar',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._bar.connect('repaint', a => this._repaintBar(a));
        this._numbers.add_child(this._big);
        this._numbers.add_child(this._small);
        this._numbers.add_child(this._bar);

        this._bell = new St.Icon({
            style_class: 'applet-icon',
            icon_name: ICON,
            icon_size: 40,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.15}),
            visible: false,
        });

        stack.add_child(this._numbers);
        stack.add_child(this._bell);
        this.set_child(stack);

        this._state = State.IDLE;
        /** ms left while not running */
        this._remaining = this._duration;
        /** wall-clock µs the countdown reaches zero while running */
        this._endTime = 0;
        this._countdownId = 0;
        this._ringId = 0;
        this._notification = null;

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            this._stopCountdown();
            this._stopRinging();
            this._dismissNotification();
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });
        this._sync();
    }

    get defaults() {
        return {minutes: 25};
    }

    get _duration() {
        return Math.clamp(this.settings.minutes, 1, MAX_MINUTES) * 60000;
    }

    get _remainingMs() {
        if (this._state !== State.RUNNING)
            return this._remaining;
        return Math.max(0, (this._endTime - GLib.get_real_time()) / 1000);
    }

    activate(button) {
        if (button === Clutter.BUTTON_MIDDLE) {
            this._reset();
            return;
        }
        switch (this._state) {
        case State.RINGING:
            this._restart();
            break;
        case State.RUNNING:
            this._pause();
            break;
        default:
            this._start();
        }
    }

    buildMenu(menu) {
        switch (this._state) {
        case State.RINGING:
            menu.addAction(_('Start Again'), () => this._restart());
            menu.addAction(_('Stop'), () => this._reset());
            break;
        case State.RUNNING:
            menu.addAction(_('Pause'), () => this._pause());
            menu.addAction(_('Reset'), () => this._reset());
            break;
        case State.PAUSED:
            menu.addAction(_('Resume'), () => this._start());
            menu.addAction(_('Reset'), () => this._reset());
            break;
        default:
            menu.addAction(_('Start'), () => this._start());
        }

        const minutes = this.settings.minutes;
        this.addChoice(menu, _('Duration'), 'minutes', PRESETS.map(m =>
            [m, ngettext('%d minute', '%d minutes', m).format(m)]));
        const custom = menu.addAction(PRESETS.includes(minutes)
            ? _('Custom…')
            /* Translators: %d is the number of minutes */
            : _('Custom (%d min)…').format(minutes),
        () => this._chooseDuration());
        custom.setOrnament(PRESETS.includes(minutes)
            ? PopupMenu.Ornament.NO_DOT : PopupMenu.Ornament.DOT);
    }

    settingsChanged(key) {
        if (key !== 'minutes')
            return;
        // A new duration starts over; a running or ringing timer keeps going
        const run = this._state === State.RUNNING || this._state === State.RINGING;
        this._reset();
        if (run)
            this._start();
    }

    vfunc_scroll_event(event) {
        if (this._state === State.RINGING)
            return Clutter.EVENT_STOP;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            delta = -Math.sign(event.get_scroll_delta()[1]);
            break;
        }
        if (delta)
            this.setSetting('minutes', Math.clamp(this.settings.minutes + delta, 1, MAX_MINUTES));
        return Clutter.EVENT_STOP;
    }

    _chooseDuration() {
        const dialog = new DurationDialog(this.settings.minutes,
            minutes => this.setSetting('minutes', minutes));
        dialog.open();
    }

    // ---- countdown ---------------------------------------------------

    _start() {
        if (this._state !== State.IDLE && this._state !== State.PAUSED)
            return;
        // Wall-clock time, so the countdown also runs across a suspend
        this._endTime = GLib.get_real_time() + this._remaining * 1000;
        this._state = State.RUNNING;
        this._scheduleTick();
        this._sync();
    }

    _pause() {
        if (this._state !== State.RUNNING)
            return;
        this._remaining = this._remainingMs;
        this._state = State.PAUSED;
        this._stopCountdown();
        this._sync();
    }

    _reset() {
        this._stopCountdown();
        this._stopRinging();
        this._dismissNotification();
        this._remaining = this._duration;
        this._state = State.IDLE;
        this._sync();
    }

    _restart() {
        this._reset();
        this._start();
    }

    /** Wake up when the shown seconds change next, or at zero. */
    _scheduleTick() {
        this._stopCountdown();
        const ms = this._remainingMs;
        if (ms <= 0) {
            this._ring();
            return;
        }
        const delay = Math.ceil(ms % 1000 || 1000);
        this._countdownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._countdownId = 0;
            this._scheduleTick();
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCountdown() {
        if (this._countdownId)
            GLib.source_remove(this._countdownId);
        this._countdownId = 0;
    }

    // ---- ringing -----------------------------------------------------

    _ring() {
        this._remaining = 0;
        this._state = State.RINGING;
        this._startRinging();
        this._notify();
    }

    _startRinging() {
        this.add_style_pseudo_class('ringing');
        this._numbers.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._numbers.hide(),
        });
        this._bell.set({opacity: 0, scale_x: 0.5, scale_y: 0.5, visible: true});
        this._bell.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => this._swing(),
        });
        this._ringId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RING_PERIOD, () => {
            this._swing();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** One burst of the bell swinging from side to side. */
    _swing() {
        const bell = this._bell;
        bell.ease({
            rotation_angle_z: -RING_ANGLE,
            duration: RING_SWING_TIME / 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => bell.ease({
                rotation_angle_z: RING_ANGLE,
                duration: RING_SWING_TIME,
                // an odd repeat count ends back at -RING_ANGLE
                repeatCount: 2 * RING_SWINGS - 1,
                autoReverse: true,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => bell.ease({
                    rotation_angle_z: 0,
                    duration: RING_SWING_TIME / 2,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                }),
            }),
        });
    }

    _stopRinging() {
        if (this._ringId)
            GLib.source_remove(this._ringId);
        this._ringId = 0;
        this.remove_style_pseudo_class('ringing');
        this._bell.remove_all_transitions();
        this._bell.set({rotation_angle_z: 0, visible: false});
        this._numbers.remove_all_transitions();
        this._numbers.set({opacity: 255, visible: true});
    }

    _notify() {
        const source = new MessageTray.Source({
            title: _('Timer'),
            iconName: ICON,
        });
        Main.messageTray.add(source);

        const minutes = this.settings.minutes;
        const notification = new MessageTray.Notification({
            source,
            title: _('Time’s up'),
            body: ngettext('%d minute has passed.', '%d minutes have passed.', minutes)
                .format(minutes),
            gicon: new Gio.ThemedIcon({name: ICON}),
            // Stays on screen until answered, even with Do Not Disturb
            urgency: MessageTray.Urgency.CRITICAL,
            sound: new MessageTray.Sound(null, SOUND),
        });
        let stop = false;
        notification.addAction(_('Start Again'), () => {});
        notification.addAction(_('Stop'), () => (stop = true));
        // Clicking it, a button or × all end in destroy(DISMISSED);
        // anything else is the shell closing it, not the user answering
        notification.connect('destroy', (_n, reason) => {
            if (this._notification !== notification)
                return;
            this._notification = null;
            if (reason !== MessageTray.NotificationDestroyedReason.DISMISSED)
                return;
            if (stop)
                this._reset();
            else
                this._restart();
        });
        this._notification = notification;
        source.addNotification(notification);
    }

    _dismissNotification() {
        const notification = this._notification;
        this._notification = null;
        notification?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    // ---- display -----------------------------------------------------

    _sync() {
        const ms = this._remainingMs;
        if (this._state === State.IDLE) {
            this._big.text = String(this.settings.minutes);
            this._small.text = _('MIN');
            this._small.show();
        } else {
            // minutes with seconds in the corner, then only seconds in the
            // last minute
            const secs = Math.ceil(ms / 1000);
            const lastMinute = secs < 60;
            this._big.text = String(lastMinute ? secs : Math.floor(secs / 60));
            this._small.text = String(secs % 60).padStart(2, '0');
            this._small.visible = !lastMinute;
        }
        for (const label of [this._big, this._small]) {
            if (this._state === State.PAUSED)
                label.add_style_pseudo_class('paused');
            else
                label.remove_style_pseudo_class('paused');
        }

        this.accessible_name = this._tooltipText();
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
        this._bar.queue_repaint();
    }

    _repaintBar(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.setSourceRGBA(...TRACK, 1);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const alpha = this._state === State.RUNNING ? 1 : 0.35;
        cr.setSourceRGBA(...ACCENT, alpha);
        cr.rectangle(0, 0, w * Math.min(1, this._remainingMs / this._duration), h);
        cr.fill();
        cr.$dispose();
    }

    _onHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;
        if (!this.hover) {
            this.hideTooltip();
            return;
        }
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_TIME, () => {
            this._hoverId = 0;
            if (this.hover && !this._menu?.isOpen)
                this.showTooltip(this._tooltipText());
            return GLib.SOURCE_REMOVE;
        });
    }

    _tooltipText() {
        const minutes = this.settings.minutes;
        const total = ngettext('%d minute', '%d minutes', minutes).format(minutes);
        switch (this._state) {
        case State.RUNNING: {
            const ends = new Date(Date.now() + this._remainingMs);
            /* Translators: "12:34 left of 45 minutes, ends at 14:05" */
            return _('%s left of %s, ends at %s').format(
                formatRemaining(this._remainingMs), total,
                formatTime(ends, {timeOnly: true}));
        }
        case State.PAUSED:
            /* Translators: "Paused with 12:34 left of 45 minutes" */
            return _('Paused with %s left of %s').format(
                formatRemaining(this._remaining), total);
        case State.RINGING:
            return _('Time’s up! Click to start again');
        default:
            /* Translators: %s is a duration like "45 minutes" */
            return _('Timer of %s: click to start, scroll to change').format(total);
        }
    }
});

/** Asks for a duration of 1 to 99 minutes. */
const DurationDialog = GObject.registerClass(
class DurationDialog extends ModalDialog.ModalDialog {
    /**
     * @param {number} minutes - the current duration
     * @param {function(number): void} onChoose
     */
    _init(minutes, onChoose) {
        super._init({styleClass: 'timer-duration-dialog'});
        this._onChoose = onChoose;

        const content = new Dialog.MessageDialogContent({
            title: _('Timer Duration'),
            description: _('Minutes, from 1 to %d').format(MAX_MINUTES),
        });
        this.contentLayout.add_child(content);

        this._entry = new St.Entry({
            style_class: 'timer-duration-entry',
            text: String(minutes),
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('text-changed', () => this._validate());
        this._entry.clutter_text.connect('activate', () => this._choose());
        content.add_child(this._entry);

        this.setButtons([{
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Set'),
            action: () => this._choose(),
            default: true,
        }]);
        this.setInitialKeyFocus(this._entry);
        this._entry.clutter_text.set_selection(0, -1);
        this._validate();
    }

    /** @returns {number|null} the entered minutes, if valid */
    get _minutes() {
        const text = this._entry.text.trim();
        if (!/^\d{1,2}$/.test(text))
            return null;
        const minutes = Number(text);
        return minutes >= 1 && minutes <= MAX_MINUTES ? minutes : null;
    }

    _validate() {
        const valid = this._minutes !== null;
        this.buttonLayout.get_last_child()?.set({reactive: valid, can_focus: valid});
        if (valid)
            this._entry.remove_style_pseudo_class('error');
        else
            this._entry.add_style_pseudo_class('error');
    }

    _choose() {
        const minutes = this._minutes;
        if (minutes === null)
            return;
        this._onChoose(minutes);
        this.close();
    }
});
