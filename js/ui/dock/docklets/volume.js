import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {Applet, findApp} from '../applet.js';
import {getMixerControl} from '../../status/volume.js';
import {ACCENT, TRACK} from './meter.js';

export const VolumeDocklet = GObject.registerClass(
class VolumeDocklet extends Applet {
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
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'applet-small',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._bar = new St.DrawingArea({style_class: 'applet-volume-bar'});
        this._bar.connect('repaint', a => this._repaintBar(a));
        box.add_child(this._icon);
        box.add_child(this._label);
        box.add_child(this._bar);
        this.set_child(box);

        this._stream = null;
        this._control = getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._readSink(),
            'default-sink-changed', () => this._readSink(),
            this);
        this._readSink();
    }

    get defaults() {
        return {step: 5};
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Scroll Step'), 'step', [
            [2, '2%'],
            [5, '5%'],
            [10, '10%'],
        ]);
        this.addAppAction(menu, _('Sound Settings'), 'gnome-sound-panel.desktop');
    }

    _readSink() {
        const stream = this._control.get_state() === Gvc.MixerControlState.READY
            ? this._control.get_default_sink() : null;
        if (stream !== this._stream) {
            this._stream?.disconnectObject(this);
            this._stream = stream;
            this._stream?.connectObject(
                'notify::volume', () => this.tick(),
                'notify::is-muted', () => this.tick(),
                this);
        }
        this.tick();
    }

    get _level() {
        if (!this._stream)
            return 0;
        return this._stream.volume / this._control.get_vol_max_norm();
    }

    activate() {
        this._stream?.change_is_muted(!this._stream.is_muted);
    }

    vfunc_scroll_event(event) {
        if (!this._stream)
            return Clutter.EVENT_PROPAGATE;

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
        if (!delta)
            return Clutter.EVENT_STOP;

        const max = this._control.get_vol_max_norm();
        const level = Math.max(0, Math.min(1, this._level + delta * this.settings.step / 100));
        this._stream.volume = level * max;
        this._stream.push_volume();
        if (delta > 0 && this._stream.is_muted)
            this._stream.change_is_muted(false);
        return Clutter.EVENT_STOP;
    }

    tick() {
        const muted = !this._stream || this._stream.is_muted;
        const level = this._level;
        let name = 'audio-volume-muted-symbolic';
        if (!muted && level > 0)
            name = `audio-volume-${['low', 'medium', 'high'][Math.min(2, Math.floor(level * 3))]}-symbolic`;
        this._icon.icon_name = name;
        this._label.text = this._stream
            ? muted ? _('Muted') : `${Math.round(level * 100)}%`
            : _('No Output');
        this._bar.queue_repaint();
    }

    _repaintBar(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.setSourceRGBA(...TRACK, 1);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const alpha = this._stream?.is_muted ? 0.35 : 1;
        cr.setSourceRGBA(...ACCENT, alpha);
        cr.rectangle(0, 0, w * Math.min(1, this._level), h);
        cr.fill();
        cr.$dispose();
    }
});
