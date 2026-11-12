import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {Applet, findApp} from '../applet.js';
import {loadInterfaceXML} from '../../../misc/fileUtils.js';

const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const DisplayDeviceInterface = loadInterfaceXML('org.freedesktop.UPower.Device');
const PowerManagerProxy = Gio.DBusProxy.makeProxyWrapper(DisplayDeviceInterface);

/** @returns {string} seconds as H:MM */
function formatTime(seconds) {
    const minutes = Math.round(seconds / 60);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

export const BatteryDocklet = GObject.registerClass(
class BatteryDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            style_class: 'applet-icon',
            icon_size: 24,
            icon_name: 'battery-missing-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'applet-small',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.set_child(box);

        this._proxy = new PowerManagerProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error)
                    console.warn(`Battery applet: ${error.message}`);
                else
                    proxy.connectObject('g-properties-changed', () => this.tick(), this);
                this.tick();
            });
    }

    get defaults() {
        return {show: 'percent'};
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Show'), 'show', [
            ['percent', _('Percentage')],
            ['time', _('Time Remaining')],
        ]);
        this.addAppAction(menu, _('Power Settings'), 'gnome-power-panel.desktop');
    }

    activate() {
        findApp('gnome-power-panel.desktop')?.activate();
    }

    tick() {
        const p = this._proxy;
        if (!p?.IsPresent) {
            this._icon.icon_name = 'ac-adapter-symbolic';
            this._label.text = _('No Battery');
            return;
        }

        this._icon.icon_name = p.IconName || 'battery-missing-symbolic';
        const charging = p.State === UPower.DeviceState.CHARGING;
        const seconds = charging ? p.TimeToFull : p.TimeToEmpty;
        if (this.settings.show === 'time' && seconds > 0)
            this._label.text = `${charging ? '+' : ''}${formatTime(seconds)}`;
        else if (p.State === UPower.DeviceState.FULLY_CHARGED)
            this._label.text = _('Full');
        else
            this._label.text = `${Math.round(p.Percentage)}%`;
    }
});
