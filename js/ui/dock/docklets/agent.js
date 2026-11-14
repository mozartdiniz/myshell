import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from '../../main.js';
import {Applet} from '../applet.js';
import {chooseFile} from '../portal.js';

const TERMINAL = 'ptyxis';
const SPRITES = '/org/gnome/shell/theme/agent';
// The sheets keep every other frame of the 33 fps originals
const FRAME_TIME = 60;
const SPRITE_SIZE = 40;
const HOVER_TIME = 400;
// How often a cooking tile checks its session didn't stop without a
// Stop hook (Esc interrupts send none), and how long after the last
// hook event Claude Code's own status is believed
const POLL_TIME = 5000;
const POLL_GRACE = 2000;

// Pause after each loop, in ms, so the quiet states stay calm
const REST = {dead: 3000, idle: 2000, done: 1000};

// Tools that stop and ask you something
const ASKING_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];

const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

const HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'PreCompact',
    'Stop',
    'StopFailure',
];

// Run by Claude Code for each hook event of a session the applet
// started; $1 is the tile's state file, $2 the event. Only the start of
// the payload is parsed: the top-level fields come before tool input
// and output, which can be huge. The write is atomic since parallel
// tool calls fire hooks at once, and nothing is printed because
// SessionStart and UserPromptSubmit output would reach Claude.
const HOOK_SCRIPT = String.raw`#!/bin/sh
input=$(head -c 4096)
cat > /dev/null
field() {
    printf '%s' "$input" | sed -n "/\"$1\":\"/{s/\"$1\":\"/\n/;s/.*\n//;s/\".*//;p;q;}"
}
tmp="$1.$$"
printf '{"event":"%s","tool":"%s","notification":"%s","session":"%s","transcript":"%s"}\n' \
    "$2" "$(field tool_name)" "$(field notification_type)" \
    "$(field session_id)" "$(field transcript_path)" > "$tmp" &&
    mv -f "$tmp" "$1"
`;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** @type {Map<string, St.ImageContent[]>} each state's frames, shared by all tiles */
const _frames = new Map();

/**
 * @param {string} state
 * @returns {St.ImageContent[]} its animation, cut from a horizontal
 *   strip of square frames
 */
function framesFor(state) {
    let frames = _frames.get(state);
    if (frames)
        return frames;

    const sheet = GdkPixbuf.Pixbuf.new_from_resource(`${SPRITES}/${state}.png`);
    const size = sheet.height;
    const coglContext = global.stage.context.get_backend().get_cogl_context();
    frames = [];
    for (let x = 0; x + size <= sheet.width; x += size) {
        const frame = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, size, size);
        sheet.copy_area(x, 0, size, size, frame, 0, 0);
        const content = St.ImageContent.new_with_preferred_size(size, size);
        content.set_bytes(coglContext, frame.read_pixel_bytes(),
            Cogl.PixelFormat.RGBA_8888, size, size, frame.rowstride);
        frames.push(content);
    }
    _frames.set(state, frames);
    return frames;
}

/** Where hooks leave each tile's latest event, with the hook script. */
function stateDir() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'tessera-agents']);
}

/**
 * @param {string} script - path of the hook script
 * @param {string} stateFile - where it records events
 * @returns {string} Claude Code settings JSON adding the hooks
 */
function hookSettings(script, stateFile) {
    const hooks = {};
    for (const event of HOOK_EVENTS) {
        const command = ['sh', script, stateFile, event]
            .map(arg => GLib.shell_quote(arg)).join(' ');
        hooks[event] = [{hooks: [{type: 'command', command, timeout: 5}]}];
    }
    return JSON.stringify({hooks});
}

/**
 * Run `argv` through the user's login shell, so it gets the PATH and
 * environment a terminal would.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function inLoginShell(argv) {
    const shell = GLib.getenv('SHELL');
    if (!shell || !POSIX_SHELLS.includes(GLib.path_get_basename(shell)))
        return argv;
    return [shell, '-lc', 'exec "$0" "$@"', ...argv];
}

/**
 * A Claude Code session in its own terminal window, in a folder chosen
 * from the menu. The tile's face shows what the session is doing:
 * a spinning gear while it works, a raised hand when it needs an answer or a
 * permission, a party when it finished while you weren't looking, and
 * a skull when no session runs. A click starts the session, or hides
 * and shows its window.
 *
 * The session lives as long as its window: closing it ends Claude
 * (Ptyxis asks first), and the next click resumes the conversation.
 * Removing the tile closes the window. Several can be added, each with
 * its own session.
 *
 * States come from Claude Code hooks added for this session only
 * (with --settings), which write the latest event to a file the tile
 * watches; your own settings are left alone.
 */
export const AgentDocklet = GObject.registerClass(
class AgentDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sprite = new St.Widget({
            width: SPRITE_SIZE,
            height: SPRITE_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        });
        this._name = new St.Label({
            style_class: 'applet-small applet-agent-name',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._sprite);
        box.add_child(this._name);
        this.set_child(box);

        /** null while no session runs */
        this._proc = null;
        this._pid = 0;
        this._state = 'dead';
        this._tool = '';
        this._frame = 0;
        this._rest = 0;
        this._eventTime = 0;
        this._statusFile = null;
        this._pollId = 0;

        GLib.mkdir_with_parents(stateDir(), 0o700);
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev(
            [stateDir(), `${appletId.replace(/\W/g, '-')}.json`]));
        this._monitor = this._stateFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, _f, _o, type) => {
            if (type !== Gio.FileMonitorEvent.DELETED)
                this._readEvent();
        });

        global.display.connectObject('notify::focus-window',
            () => this._onFocusChanged(), this);

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('remove-requested', () => this._end());
        this.connect('destroy', () => {
            // The session may outlive the tile (shutdown, or a close
            // you cancelled after Remove); stop listening for its exit
            this._proc = null;
            this._monitor.cancel();
            this._stopPoll();
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });

        this._syncName();
        this._syncState();
    }

    get defaults() {
        return {path: GLib.get_home_dir(), sessionId: '', transcript: ''};
    }

    get interval() {
        return FRAME_TIME;
    }

    tick() {
        if (this._rest > 0) {
            this._rest -= FRAME_TIME;
            return;
        }
        const frames = framesFor(this._state);
        this._sprite.content = frames[this._frame % frames.length];
        this._frame = (this._frame + 1) % frames.length;
        if (this._frame === 0)
            this._rest = REST[this._state] ?? 0;
    }

    activate() {
        if (!this._proc) {
            this._start();
            return;
        }
        const window = this._window;
        if (!window)
            return; // still opening
        if (window.has_focus() && !window.minimized)
            window.minimize();
        else
            Main.activateWindow(window);
    }

    buildMenu(menu) {
        if (this._proc) {
            menu.addAction(_('Show Session'), () => this._show());
            menu.addAction(_('End Session'), () => this._end());
            return;
        }
        if (this._resumable) {
            menu.addAction(_('Resume Session'), () => this._start());
            menu.addAction(_('Start New Session'), () => this._start(true));
        } else {
            menu.addAction(_('Start Session'), () => this._start());
        }
        menu.addAction(_('Choose Folder…'), () => this._chooseFolder());
    }

    settingsChanged(key) {
        if (key !== 'path')
            return;
        // Claude Code resumes conversations per folder
        this.setSetting('sessionId', '');
        this.setSetting('transcript', '');
        this._syncName();
        this._syncState();
    }

    // ---- session ----------------------------------------------------

    /** Whether the last conversation here can be picked up again. */
    get _resumable() {
        const {sessionId, transcript} = this.settings;
        return !!sessionId && !!transcript &&
            GLib.file_test(transcript, GLib.FileTest.EXISTS);
    }

    /** @param {boolean} fresh - start a new conversation even if one can be resumed */
    _start(fresh = false) {
        const terminal = GLib.find_program_in_path(TERMINAL);
        if (!terminal) {
            Main.notifyError(_('Ptyxis isn’t installed'),
                _('Claude Agent opens its sessions in Ptyxis.'));
            return;
        }

        const resume = !fresh && this._resumable;
        if (!resume) {
            this.setSetting('sessionId', GLib.uuid_string_random());
            this.setSetting('transcript', '');
        }

        const script = GLib.build_filenamev([stateDir(), 'hook.sh']);
        try {
            GLib.mkdir_with_parents(stateDir(), 0o700);
            GLib.file_set_contents(script, encoder.encode(HOOK_SCRIPT));
            this._stateFile.delete(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                Main.notifyError(_('Failed to start Claude'), e.message);
                return;
            }
        }

        const claude = [
            'claude',
            resume ? '--resume' : '--session-id', this.settings.sessionId,
            '--settings', hookSettings(script, this._stateFile.get_path()),
        ];
        const argv = [
            terminal, '--standalone', '--new-window',
            '--working-directory', this.settings.path,
            '--title', `Claude · ${this._name.text}`,
            '--', ...inLoginShell(claude),
        ];

        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notifyError(_('Failed to start Claude'), e.message);
            return;
        }
        this._proc = proc;
        this._pid = Number(proc.get_identifier());
        this._statusFile = null;
        proc.wait_async(null, () => {
            if (this._proc !== proc)
                return;
            this._proc = null;
            this._pid = 0;
            this._setState('dead');
        });
        this._setState('idle');
    }

    _show() {
        const window = this._window;
        if (window)
            Main.activateWindow(window);
    }

    /** Close the window; Ptyxis asks first while Claude runs in it. */
    _end() {
        const window = this._window;
        if (window)
            window.delete(global.get_current_time());
        else
            this._proc?.send_signal(15); // SIGTERM
    }

    /** @returns {Meta.Window|null} the session's terminal window */
    get _window() {
        if (!this._pid)
            return null;
        return global.get_window_actors().map(a => a.meta_window)
            .find(w => w.get_pid() === this._pid) ?? null;
    }

    async _chooseFolder() {
        try {
            const uri = await chooseFile(_('Choose Folder'), {
                directory: true,
                currentFolder: this.settings.path,
            });
            if (uri)
                this.setSetting('path', Gio.File.new_for_uri(uri).get_path());
        } catch (e) {
            Main.notifyError(_('Failed to open the folder chooser'), e.message);
        }
    }

    // ---- state ------------------------------------------------------

    _readEvent() {
        if (!this._proc)
            return;
        let event;
        try {
            const [, bytes] = this._stateFile.load_contents(null);
            event = JSON.parse(decoder.decode(bytes));
        } catch {
            return;
        }
        this._eventTime = Date.now();

        // /clear starts another session in the same process
        if (event.session && event.session !== this.settings.sessionId) {
            this.setSetting('sessionId', event.session);
            this._statusFile = null;
        }
        if (event.transcript)
            this.setSetting('transcript', event.transcript);
        this._tool = event.tool ?? '';
        this._setState(this._stateAfter(event));
    }

    /**
     * @param {object} event - as the hook script records it
     * @returns {string} the state it leaves the session in
     */
    _stateAfter({event, tool, notification}) {
        switch (event) {
        case 'SessionStart':
            return 'idle';
        case 'PreToolUse':
            return ASKING_TOOLS.includes(tool) ? 'input' : 'cooking';
        case 'PermissionRequest':
            return 'input';
        case 'Notification':
            if (notification === 'permission_prompt' || notification === 'elicitation_dialog')
                return 'input';
            // Sent after a while at the prompt: a turn ended by Esc
            // sends no Stop
            if (notification === 'idle_prompt' && this._state === 'cooking')
                return 'idle';
            return this._state;
        case 'Stop':
            return this._watched ? 'idle' : 'done';
        case 'StopFailure':
            return 'error';
        default: // prompts, tool results, compacting
            return 'cooking';
        }
    }

    /** Whether you're looking at the session's window. */
    get _watched() {
        return !!this._window?.has_focus();
    }

    _onFocusChanged() {
        if (this._state === 'done' && this._watched)
            this._setState('idle');
    }

    _setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        this._syncState();
    }

    _syncState() {
        this._frame = 0;
        this._rest = 0;
        if (this.mapped)
            this.tick();

        if (this._state === 'cooking')
            this._startPoll();
        else
            this._stopPoll();

        this.accessible_name = `${_('Claude Agent')}: ${this._statusText()}`;
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
    }

    _statusText() {
        switch (this._state) {
        case 'idle':
            return _('Waiting for you');
        case 'cooking':
            return this._tool
                ? _('Cooking (%s)').format(this._tool.replace(/^mcp__/, ''))
                : _('Cooking');
        case 'input':
            return _('Needs your answer');
        case 'done':
            return _('Done');
        case 'error':
            return _('Something went wrong');
        default:
            return this._resumable
                ? _('Not running — click to resume')
                : _('Not running — click to start');
        }
    }

    _tooltipText() {
        return `${this.settings.path}\n${this._statusText()}`;
    }

    _syncName() {
        const {path} = this.settings;
        this._name.text = path === GLib.get_home_dir()
            ? _('Home') : GLib.path_get_basename(path);
    }

    // ---- Esc fallback ---------------------------------------------

    _startPoll() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_TIME, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    _poll() {
        const status = this._sessionStatus();
        if (status?.status === 'idle' &&
            status.statusUpdatedAt > this._eventTime + POLL_GRACE)
            this._setState('idle');
    }

    /**
     * Claude Code keeps each running session's status in sessions/
     * beside projects/, where the transcript is. That isn't a public
     * API, so anything unexpected counts as no answer.
     *
     * @returns {object|null}
     */
    _sessionStatus() {
        const {sessionId, transcript} = this.settings;
        if (!transcript)
            return null;
        try {
            if (this._statusFile) {
                const status = this._loadStatus(this._statusFile);
                if (status?.sessionId === sessionId)
                    return status;
                this._statusFile = null;
            }
            const configDir = Gio.File.new_for_path(transcript)
                .get_parent()?.get_parent()?.get_parent();
            const dir = configDir?.get_child('sessions');
            if (!dir)
                return null;
            const children = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            for (const info of children) {
                if (!info.get_name().endsWith('.json'))
                    continue;
                const file = dir.get_child(info.get_name());
                const status = this._loadStatus(file);
                if (status?.sessionId === sessionId) {
                    this._statusFile = file;
                    return status;
                }
            }
        } catch {
            // No sessions folder, or it changed shape
        }
        return null;
    }

    _loadStatus(file) {
        try {
            const [, bytes] = file.load_contents(null);
            return JSON.parse(decoder.decode(bytes));
        } catch {
            return null;
        }
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
});
