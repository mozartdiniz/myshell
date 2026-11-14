import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from '../main.js';

const SHOW_TIME = 800;
const FADE_TIME = 400;

/**
 * Shows the workspace's name in the middle of the screen whenever
 * another workspace becomes active, as WindowMaker does. It stands in
 * for GNOME's workspace switcher popup.
 */
export class WorkspaceName {
    constructor() {
        this._label = new St.Label({
            style_class: 'workspace-name',
            visible: false,
        });
        Main.uiGroup.add_child(this._label);
        this._label.connect('destroy', () => {
            this._label = null;
            this._stopTimeout();
        });
        this._timeoutId = 0;

        global.workspace_manager.connect('active-workspace-changed', () => this._show());
    }

    _show() {
        const label = this._label;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!label || !monitor || Main.sessionMode.isLocked)
            return;

        label.text = Meta.prefs_get_workspace_name(
            global.workspace_manager.get_active_workspace_index());
        label.remove_all_transitions();
        label.opacity = 255;
        label.show();
        Main.uiGroup.set_child_above_sibling(label, null);
        const [, , width, height] = label.get_preferred_size();
        label.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + (monitor.height - height) / 2));

        this._stopTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_TIME, () => {
            this._timeoutId = 0;
            label.ease({
                opacity: 0,
                duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => label.hide(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimeout() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }
}
