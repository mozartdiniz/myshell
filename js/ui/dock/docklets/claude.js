import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as PopupMenu from '../../popupMenu.js';
import {formatTime} from '../../../misc/dateUtils.js';
import {Applet} from '../applet.js';
import {ACCENT, ACCENT2, FG, drawText, drawTrack} from './meter.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// What Claude Code's /usage shows. Not a public API: it can change.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const USAGE_PAGE = 'https://claude.ai/settings/usage';

const FETCH_INTERVAL = 5 * GLib.TIME_SPAN_MINUTE;
const TICK = 60 * 1000;
// Opening the popup refreshes data older than this
const STALE_TIME = GLib.TIME_SPAN_MINUTE;
const POPUP_BAR_WIDTH = 240;
const HOVER_TIME = 400;

const CRITICAL = [0.88, 0.33, 0.30];
const DIM = [0.45, 0.45, 0.45];
const COLORS = {normal: ACCENT, warning: ACCENT2, critical: CRITICAL};

const decoder = new TextDecoder();
let _httpSession = null;

/**
 * Your Claude plan's usage limits, as Claude Code's /usage shows them:
 * the current five-hour session and the week, as two bars coloured by
 * how close they are to the limit. A click shows when each resets,
 * per-model weekly limits, extra usage and where the week went.
 *
 * It signs in with Claude Code's OAuth token, read from
 * ~/.claude/.credentials.json for every request and never refreshed
 * here: Claude Code rotates the refresh token, so refreshing from two
 * places would sign it out. While the token is expired (Claude Code
 * hasn't run for hours) the bars dim and keep the last numbers.
 */
export const ClaudeDocklet = GObject.registerClass(
class ClaudeDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', a => this._repaint(a));
        this.set_child(this._area);

        /** Last good reply from the usage endpoint */
        this._usage = null;
        this._fetchedAt = 0;
        /** null, or why the numbers are old: 'signed-out', 'expired', 'offline', 'error' */
        this._problem = null;
        this._fetching = null;
        this._showingPopup = false;
        this._cancellable = new Gio.Cancellable();

        // Hovering shows when the limits reset
        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });
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
        const lines = [];
        if (this._problem)
            lines.push(problemText(this._problem, !!this._usage));
        const rows = [[_('Session'), this._session], [_('Week'), this._week]];
        for (const [name, limit] of rows) {
            if (!limit)
                continue;
            const percent = `${name} ${Math.round(limit.percent)}%`;
            const reset = resetText(limit.resetsAt);
            /* Translators: e.g. "Session 89% · Resets in 31 min (01:00)" */
            lines.push(reset ? _('%s · %s').format(percent, reset) : percent);
        }
        return lines.join('\n') || _('Claude usage');
    }

    get interval() {
        return TICK;
    }

    tick() {
        const age = GLib.get_monotonic_time() - this._fetchedAt;
        if (!this._fetchedAt || age > FETCH_INTERVAL || this._resetPassed())
            this._fetch();
        this._sync();
    }

    activate() {
        if (GLib.get_monotonic_time() - this._fetchedAt > STALE_TIME)
            this._fetch();
        this._showingPopup = true;
        this.openPopup(menu => this._buildPopup(menu));
    }

    openMenu() {
        this._showingPopup = false;
        super.openMenu();
    }

    buildMenu(menu) {
        menu.addAction(_('Refresh'), () => this._fetch());
        menu.addAction(_('Open Usage Settings'), () => openUri(USAGE_PAGE));
    }

    // ---- data -------------------------------------------------------

    /** The session or week has reset since the last fetch. */
    _resetPassed() {
        const now = Date.now();
        return [this._session, this._week].some(l => l?.resetsAt && l.resetsAt <= now);
    }

    _fetch() {
        this._fetching ??= this._doFetch().finally(() => (this._fetching = null));
        return this._fetching;
    }

    async _doFetch() {
        const token = readToken();
        if (token.problem) {
            this._setProblem(token.problem);
            return;
        }

        _httpSession ??= new Soup.Session({timeout: 20});
        const message = Soup.Message.new('GET', USAGE_URL);
        const headers = message.get_request_headers();
        headers.append('Authorization', `Bearer ${token.accessToken}`);
        headers.append('anthropic-beta', OAUTH_BETA);
        headers.append('Accept', 'application/json');

        let bytes;
        try {
            bytes = await _httpSession.send_and_read_async(message,
                GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._setProblem('offline');
            return;
        }

        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
            this._setProblem('expired');
            return;
        }
        if (status !== Soup.Status.OK) {
            log(`Claude applet: usage request failed: ${status}`);
            this._setProblem('error');
            return;
        }
        try {
            this._usage = JSON.parse(decoder.decode(bytes.get_data()));
        } catch (e) {
            log(`Claude applet: bad usage reply: ${e.message}`);
            this._setProblem('error');
            return;
        }
        this._fetchedAt = GLib.get_monotonic_time();
        this._fetchedWall = Date.now();
        this._setProblem(null);
    }

    _setProblem(problem) {
        this._problem = problem;
        this._sync();
        if (this._showingPopup && this._menu?.isOpen) {
            this._menu.removeAll();
            this._buildPopup(this._menu);
        }
    }

    /** @returns {{percent: number, severity: string, resetsAt: ?number}|null} */
    _limit(group, kind) {
        const usage = this._usage;
        if (!usage)
            return null;
        const limit = usage.limits?.find(l => l.group === group && (!kind || l.kind === kind));
        if (limit) {
            return {
                percent: limit.percent ?? 0,
                severity: limit.severity ?? severityOf(limit.percent),
                resetsAt: parseTime(limit.resets_at),
            };
        }
        // Older replies only have the windows themselves
        const window = usage[group === 'session' ? 'five_hour' : 'seven_day'];
        if (!window)
            return null;
        return {
            percent: window.utilization ?? 0,
            severity: severityOf(window.utilization),
            resetsAt: parseTime(window.resets_at),
        };
    }

    get _session() {
        return this._limit('session', 'session');
    }

    get _week() {
        return this._limit('weekly', 'weekly_all');
    }

    _sync() {
        const session = this._session;
        const week = this._week;
        if (session && week) {
            this.accessible_name = _('Claude: session %d%%, week %d%%').format(
                Math.round(session.percent), Math.round(week.percent));
        } else {
            this.accessible_name = _('Claude usage');
        }
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w] = area.get_surface_size();
        const dim = this._problem !== null;
        const rows = [
            /* Translators: short label for the five-hour session limit */
            [_('5H'), this._session],
            /* Translators: short label for the weekly limit */
            [_('WEEK'), this._week],
        ];

        let y = 4;
        for (const [name, limit] of rows) {
            const frac = limit ? Math.clamp(limit.percent / 100, 0, 1) : 0;
            const value = limit ? `${Math.round(limit.percent)}%` : '--';
            drawText(cr, name, 4, y + 9, false, dim ? DIM : FG);
            drawText(cr, value, w - 4, y + 9, true, dim ? DIM : FG);

            const bar = [4, y + 13, w - 8, 7];
            drawTrack(cr, bar);
            cr.setSourceRGBA(...(dim ? DIM : COLORS[limit?.severity] ?? ACCENT), 1);
            cr.rectangle(bar[0], bar[1], bar[2] * frac, bar[3]);
            cr.fill();
            y += 26;
        }
        cr.$dispose();
    }

    // ---- popup ------------------------------------------------------

    _buildPopup(menu) {
        const usage = this._usage;
        if (this._problem)
            menu.addMenuItem(statusItem(problemText(this._problem, !!usage)));
        if (!usage) {
            if (!this._problem)
                menu.addMenuItem(statusItem(_('Loading…')));
            menu.addAction(_('Refresh'), () => this._fetch());
            return;
        }

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'claude-applet-box',
            x_expand: true,
        });
        box.add_child(limitRow(_('Current session'), this._session));
        box.add_child(limitRow(_('This week'), this._week));

        // Weekly limits of one model or surface, once they're in use
        for (const limit of usage.limits ?? []) {
            if (limit.kind !== 'weekly_scoped' || !(limit.percent > 0))
                continue;
            const scope = limit.scope?.model?.display_name ?? limit.scope?.surface ?? '';
            box.add_child(limitRow(_('This week, %s').format(scope), {
                percent: limit.percent,
                severity: limit.severity ?? severityOf(limit.percent),
                resetsAt: parseTime(limit.resets_at),
            }));
        }

        const extra = usage.extra_usage;
        if (extra?.is_enabled) {
            const scale = 10 ** (extra.decimal_places ?? 2);
            const money = v => formatMoney(v / scale, extra.currency);
            box.add_child(caption(_('Extra usage: %s of %s this month').format(
                money(extra.used_credits ?? 0), money(extra.monthly_limit ?? 0))));
        }

        const rows = usage.seven_day_breakdown?.rows?.filter(r => r.percent > 0) ?? [];
        if (rows.length > 0) {
            box.add_child(caption(_('This week: %s').format(
                rows.map(r => `${r.display_name} ${Math.round(r.percent)}%`).join(' · '))));
        }

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.add_child(box);
        menu.addMenuItem(item);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._fetchedWall) {
            menu.addMenuItem(statusItem(_('Updated %s').format(
                formatTime(new Date(this._fetchedWall), {timeOnly: true}))));
        }
        menu.addAction(_('Refresh'), () => this._fetch());
        menu.addAction(_('Open Usage Settings'), () => openUri(USAGE_PAGE));
    }
});

/**
 * Claude Code's OAuth access token, unless it's missing or expired.
 *
 * @returns {{accessToken?: string, problem?: string}}
 */
function readToken() {
    const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    const path = GLib.build_filenamev([configDir, '.credentials.json']);
    let oauth;
    try {
        const [, bytes] = GLib.file_get_contents(path);
        oauth = JSON.parse(decoder.decode(bytes)).claudeAiOauth;
    } catch {
        return {problem: 'signed-out'};
    }
    if (!oauth?.accessToken)
        return {problem: 'signed-out'};
    if (oauth.expiresAt && oauth.expiresAt <= Date.now())
        return {problem: 'expired'};
    return {accessToken: oauth.accessToken};
}

function problemText(problem, haveOld) {
    const old = haveOld ? ` ${_('Showing the last numbers.')}` : '';
    switch (problem) {
    case 'signed-out':
        return _('Sign in to Claude Code to see your usage.');
    case 'expired':
        return _('Claude Code’s sign-in has expired; it renews when you use Claude Code.') + old;
    case 'offline':
        return _('Can’t reach Claude.') + old;
    default:
        return _('Couldn’t get your usage.') + old;
    }
}

function severityOf(percent = 0) {
    if (percent >= 100)
        return 'critical';
    return percent >= 80 ? 'warning' : 'normal';
}

function parseTime(text) {
    const time = text ? Date.parse(text) : NaN;
    return Number.isNaN(time) ? null : time;
}

/** "Resets in 34 min (01:00)", or with a weekday when it's days away. */
function resetText(resetsAt) {
    if (!resetsAt)
        return '';
    const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
    // Resets come a hair before the hour (22:59:59.7); show 23:00
    const date = new Date(Math.round(resetsAt / 60000) * 60000);
    const time = formatTime(date, {timeOnly: true});
    if (minutes < 60)
        return _('Resets in %d min (%s)').format(minutes, time);
    if (minutes < 24 * 60) {
        return _('Resets in %d h %d min (%s)').format(
            Math.floor(minutes / 60), minutes % 60, time);
    }
    const day = date.toLocaleDateString(undefined, {weekday: 'long'});
    /* Translators: weekday and time, e.g. "Resets Sunday 23:00" */
    return _('Resets %s %s').format(day, time);
}

function formatMoney(value, currency) {
    try {
        return value.toLocaleString(undefined, {style: 'currency', currency});
    } catch {
        return `${value.toFixed(2)} ${currency ?? ''}`.trim();
    }
}

function limitRow(title, limit) {
    const row = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'claude-applet-limit',
    });
    const top = new St.BoxLayout();
    top.add_child(new St.Label({
        style_class: 'claude-applet-limit-title',
        text: title,
        x_expand: true,
    }));
    top.add_child(new St.Label({
        style_class: 'claude-applet-limit-percent',
        text: limit ? `${Math.round(limit.percent)}%` : '--',
    }));
    row.add_child(top);

    const track = new St.Widget({
        style_class: 'claude-applet-bar',
        width: POPUP_BAR_WIDTH,
    });
    const fill = new St.Widget({
        style_class: `claude-applet-bar-fill ${limit?.severity ?? 'normal'}`,
        width: Math.round(POPUP_BAR_WIDTH * Math.clamp((limit?.percent ?? 0) / 100, 0, 1)),
    });
    track.add_child(fill);
    row.add_child(track);
    if (limit?.resetsAt)
        row.add_child(caption(resetText(limit.resetsAt)));
    return row;
}

function caption(text) {
    return new St.Label({style_class: 'claude-applet-caption', text});
}

function statusItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
    item.add_style_class_name('claude-applet-status');
    item.label.clutter_text.line_wrap = true;
    return item;
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError(_('Failed to open %s').format(uri), e.message);
    }
}
