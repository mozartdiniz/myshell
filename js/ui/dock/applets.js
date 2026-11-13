import {AgentDocklet} from './docklets/agent.js';
import {BatteryDocklet} from './docklets/battery.js';
import {CaffeineDocklet} from './docklets/caffeine.js';
import {ClaudeDocklet} from './docklets/claude.js';
import {ClockDocklet} from './docklets/clock.js';
import {ColorPickerDocklet} from './docklets/colorPicker.js';
import {CpuDocklet} from './docklets/cpu.js';
import {DateDocklet} from './docklets/date.js';
import {FolderDocklet} from './docklets/folder.js';
import {MemoryDocklet} from './docklets/memory.js';
import {MusicDocklet} from './docklets/music.js';
import {NetworkDocklet} from './docklets/network.js';
import {NotificationsDocklet} from './docklets/notifications.js';
import {SystemDocklet} from './docklets/system.js';
import {TimerDocklet} from './docklets/timer.js';
import {TrashDocklet} from './docklets/trash.js';
import {VolumeDocklet} from './docklets/volume.js';
import {WeatherDocklet} from './docklets/weather.js';
import {WorkspacesDocklet} from './docklets/workspaces.js';

/**
 * Applets the user can add from the launcher. `id` is also the tile id
 * used for layout persistence, so it must never change. `multiple`
 * applets can be added any number of times; each instance gets the id
 * `<id>:<n>`.
 */
export const APPLETS = [
    {
        id: 'system',
        name: _('System'),
        description: _('Quick settings, lock, log out and power off'),
        icon: 'open-menu-symbolic',
        type: SystemDocklet,
    },
    {
        id: 'clock',
        name: _('Clock'),
        description: _('Analog or digital clock'),
        icon: 'preferences-system-time-symbolic',
        type: ClockDocklet,
    },
    {
        id: 'date',
        name: _('Date'),
        description: _('Weekday, day and month'),
        icon: 'x-office-calendar-symbolic',
        type: DateDocklet,
    },
    {
        id: 'timer',
        name: _('Timer'),
        description: _('Counts down up to 99 minutes, rings, and starts again'),
        icon: 'alarm-symbolic',
        type: TimerDocklet,
    },
    {
        id: 'weather',
        name: _('Weather'),
        description: _('Conditions and forecast for a city'),
        icon: 'weather-few-clouds-symbolic',
        type: WeatherDocklet,
    },
    {
        id: 'music',
        name: _('Figaro'),
        description: _('Figaro’s tile: play, pause, up next, show or hide its window'),
        icon: 'audio-x-generic-symbolic',
        type: MusicDocklet,
    },
    {
        id: 'claude',
        name: _('Claude Usage'),
        description: _('Your plan’s session and weekly limits'),
        icon: 'starred-symbolic',
        type: ClaudeDocklet,
    },
    {
        id: 'agent',
        name: _('Claude Agent'),
        description: _('A Claude Code session; its face shows what it’s doing'),
        icon: 'utilities-terminal-symbolic',
        type: AgentDocklet,
        multiple: true,
    },
    {
        id: 'notifications',
        name: _('Notifications'),
        description: _('How many notifications are waiting, and the list of them'),
        icon: 'preferences-system-notifications-symbolic',
        type: NotificationsDocklet,
    },
    {
        id: 'caffeine',
        name: _('Caffeine'),
        description: _('Keeps the screen on and the computer from suspending'),
        icon: 'display-brightness-symbolic',
        type: CaffeineDocklet,
    },
    {
        id: 'color-picker',
        name: _('Color Picker'),
        description: _('Pick a color from the screen; copies it as #RRGGBB'),
        icon: 'color-select-symbolic',
        type: ColorPickerDocklet,
    },
    {
        id: 'cpu',
        name: _('CPU Load'),
        description: _('Processor usage history or per-core bars'),
        icon: 'power-profile-performance-symbolic',
        type: CpuDocklet,
    },
    {
        id: 'memory',
        name: _('Memory'),
        description: _('Memory and swap usage'),
        icon: 'drive-harddisk-solidstate-symbolic',
        type: MemoryDocklet,
    },
    {
        id: 'network',
        name: _('Network'),
        description: _('Download and upload speed'),
        icon: 'network-wired-symbolic',
        type: NetworkDocklet,
    },
    {
        id: 'volume',
        name: _('Volume'),
        description: _('Scroll to change, click to mute'),
        icon: 'audio-volume-high-symbolic',
        type: VolumeDocklet,
    },
    {
        id: 'battery',
        name: _('Battery'),
        description: _('Charge level and time remaining'),
        icon: 'battery-good-symbolic',
        type: BatteryDocklet,
    },
    {
        id: 'workspaces',
        name: _('Workspaces'),
        description: _('Workspace pager with window outlines'),
        icon: 'view-grid-symbolic',
        type: WorkspacesDocklet,
    },
    {
        id: 'folder',
        name: _('Folder'),
        description: _('Opens a folder; click to add another'),
        icon: 'folder-symbolic',
        type: FolderDocklet,
        multiple: true,
    },
    {
        id: 'trash',
        name: _('Trash'),
        description: _('Open or empty the trash'),
        icon: 'user-trash-symbolic',
        type: TrashDocklet,
    },
];

/**
 * @param {string} id - applet id, or instance id for `multiple` applets
 * @returns {object|null} the APPLETS entry it belongs to
 */
export function appletInfo(id) {
    const [type, instance] = id.split(':');
    const info = APPLETS.find(a => a.id === type);
    if (!info || !!info.multiple !== (instance !== undefined))
        return null;
    return info;
}

/** Applets shown on first start. */
export const DEFAULT_APPLETS = ['system', 'clock'];
