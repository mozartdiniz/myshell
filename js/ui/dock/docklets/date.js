import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Applet, findApp} from '../applet.js';

const CALENDAR = ['org.gnome.Calendar.desktop', 'gnome-calendar.desktop'];

/** Tear-off calendar page: weekday, day of month, month. */
export const DateDocklet = GObject.registerClass(
class DateDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'date-docklet'});

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._top = new St.Label({
            style_class: 'applet-small applet-date-top',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._day = new St.Label({
            style_class: 'applet-date-day',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._bottom = new St.Label({
            style_class: 'applet-small',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._top);
        box.add_child(this._day);
        box.add_child(this._bottom);
        this.set_child(box);
    }

    get defaults() {
        return {bottom: 'month'};
    }

    get interval() {
        return 30000;
    }

    buildMenu(menu) {
        this.addChoice(menu, _('Bottom Line'), 'bottom', [
            ['month', _('Month')],
            ['year', _('Month and Year')],
            ['week', _('Week Number')],
        ]);
        this.addAppAction(menu, _('Open Calendar'), ...CALENDAR);
    }

    activate() {
        findApp(...CALENDAR)?.activate();
    }

    tick() {
        const now = GLib.DateTime.new_now_local();
        this._top.text = now.format('%a').toUpperCase();
        this._day.text = String(now.get_day_of_month());
        switch (this.settings.bottom) {
        case 'year':
            this._bottom.text = now.format('%b %Y').toUpperCase();
            break;
        case 'week':
            /* Translators: short week-of-year label, %d is the week number */
            this._bottom.text = _('WEEK %d').format(now.get_week_of_year());
            break;
        default:
            this._bottom.text = now.format('%B').toUpperCase();
        }
    }
});
