import Clutter from 'gi://Clutter';
import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Dialog from '../../dialog.js';
import * as ModalDialog from '../../modalDialog.js';
import * as PopupMenu from '../../popupMenu.js';
import * as ShellEntry from '../../shellEntry.js';
import {formatTime} from '../../../misc/dateUtils.js';
import {Applet} from '../applet.js';

Gio._promisify(Geoclue.Simple, 'new');

const WEATHER = ['org.gnome.Weather.desktop'];
const PROVIDERS =
    GWeather.Provider.METAR |
    GWeather.Provider.MET_NO |
    GWeather.Provider.OWM;
const UNITS = {
    default: GWeather.TemperatureUnit.DEFAULT,
    centigrade: GWeather.TemperatureUnit.CENTIGRADE,
    fahrenheit: GWeather.TemperatureUnit.FAHRENHEIT,
};
const UPDATE_INTERVAL = 30 * 60 * 1000;
// Opening the forecast refreshes data older than this
const STALE_TIME = 10 * GLib.TIME_SPAN_MINUTE;
const MAX_HOURS = 6;
const MAX_DAYS = 5;
const MAX_RESULTS = 30;

/**
 * Current conditions for a city, or for where the computer is: the
 * tile shows the sky and temperature, a click shows the coming hours
 * and days. The city comes from GWeather's own database, so the
 * Weather app isn't needed. Automatic location asks Geoclue as
 * org.gnome.Shell, which geoclue lets through as a system component.
 */
export const WeatherDocklet = GObject.registerClass(
class WeatherDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'weather-docklet'});

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
        this._temp = new St.Label({
            style_class: 'applet-weather-temp',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._place = new St.Label({
            style_class: 'applet-small applet-weather-place',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._place.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._icon);
        box.add_child(this._temp);
        box.add_child(this._place);
        this.set_child(box);

        this._info = new GWeather.Info({
            application_id: 'org.gnome.Shell',
            contact_info: 'https://gitlab.gnome.org/GNOME/gnome-shell/-/raw/HEAD/gnome-shell.doap',
            enabled_providers: PROVIDERS,
        });
        this._info.connectObject('updated', () => this._onUpdated(), this);
        this._hasLocation = false;
        this._loading = false;
        this._lastUpdate = 0;
        this._showingForecast = false;
        this._destroyed = false;

        this._gclue = null;
        this._gclueStarting = false;
        this._locationSettings = new Gio.Settings({
            schema_id: 'org.gnome.system.location',
        });
        this._locationSettings.connectObject('changed::enabled',
            () => this._syncLocation(), this);

        this.connect('destroy', () => {
            this._destroyed = true;
            this._info.abort();
            this._stopAutoLocation();
        });
        this._syncLocation();
    }

    get defaults() {
        // location is {name, station, latitude, longitude}; null means
        // automatic. The station (an ICAO code) adds observed conditions.
        return {location: null, unit: 'default'};
    }

    get interval() {
        return UPDATE_INTERVAL;
    }

    tick() {
        this._update();
    }

    settingsChanged(key) {
        if (key === 'location')
            this._syncLocation();
        else
            this._sync();
    }

    activate() {
        if (GLib.get_monotonic_time() - this._lastUpdate > STALE_TIME)
            this._update();
        this._showingForecast = true;
        this.openPopup(menu => this._buildForecast(menu));
    }

    openMenu() {
        this._showingForecast = false;
        super.openMenu();
    }

    buildMenu(menu) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Location')));
        const auto = menu.addAction(_('Automatic'),
            () => this.setSetting('location', null));
        auto.setOrnament(this.settings.location
            ? PopupMenu.Ornament.NO_DOT : PopupMenu.Ornament.DOT);
        if (this.settings.location && this._hasLocation) {
            const city = menu.addAction(this._placeName(), () => {});
            city.setOrnament(PopupMenu.Ornament.DOT);
        }
        menu.addAction(_('Choose City…'), () => this._chooseCity());

        this.addChoice(menu, _('Temperature'), 'unit', [
            ['default', _('Default')],
            ['centigrade', _('Celsius')],
            ['fahrenheit', _('Fahrenheit')],
        ]);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Refresh'), () => this._update(true));
        this.addAppAction(menu, _('Open Weather'), ...WEATHER);
    }

    // ---- location ---------------------------------------------------

    _syncLocation() {
        const {location} = this.settings;
        if (location) {
            this._stopAutoLocation();
            // Saved as coordinates: deserializing a GWeather city goes
            // by its station, which nearby cities share
            this._setLocation(detachedLocation(location));
        } else if (this._locationSettings.get_boolean('enabled')) {
            this._startAutoLocation();
        } else {
            this._stopAutoLocation();
            this._setLocation(null);
        }
    }

    get _wantsAutoLocation() {
        return !this._destroyed && !this.settings.location &&
            this._locationSettings.get_boolean('enabled');
    }

    async _startAutoLocation() {
        if (this._gclue || this._gclueStarting)
            return;

        this._gclueStarting = true;
        let gclue;
        try {
            gclue = await Geoclue.Simple.new('org.gnome.Shell',
                Geoclue.AccuracyLevel.CITY, null);
        } catch (e) {
            log(`Weather applet: no location from Geoclue: ${e.message}`);
            return;
        } finally {
            this._gclueStarting = false;
        }
        // The setting may have changed while Geoclue was starting
        if (!this._wantsAutoLocation)
            return;

        this._gclue = gclue;
        this._gclue.get_client().distance_threshold = 100;
        this._gclue.connectObject('notify::location',
            () => this._onGeoLocation(), this);
        this._onGeoLocation();
    }

    _stopAutoLocation() {
        this._gclue?.disconnectObject(this);
        this._gclue = null;
    }

    _onGeoLocation() {
        const geo = this._gclue?.location;
        if (!geo)
            return;
        // An empty name lets GWeather name it after the nearest station
        this._setLocation(GWeather.Location.new_detached('', null,
            geo.latitude, geo.longitude));
    }

    _setLocation(location) {
        // GWeather falls back to a default station without a location,
        // so its own location is never null
        const current = this._hasLocation ? this._info.location : null;
        if (location === current || (location && current && location.equal(current))) {
            this._sync();
            return;
        }

        this._info.abort();
        this._hasLocation = location !== null;
        this._info.set_location(location);
        this._lastUpdate = 0;
        this._update();
    }

    /** City name to show; automatic locations get the nearest city's. */
    _placeName() {
        if (!this._hasLocation)
            return '';
        const loc = this._info.location;
        if (this.settings.location)
            return this.settings.location.name;
        if (loc.get_level() === GWeather.LocationLevel.CITY || !loc.has_coords())
            return loc.get_name();
        const city = GWeather.Location.get_world().find_nearest_city(...loc.get_coords());
        return city?.get_name() ?? loc.get_name();
    }

    _chooseCity() {
        const dialog = new CityDialog(location => {
            const [latitude, longitude] = location.get_coords();
            this.setSetting('location', {
                name: location.get_name(),
                station: cityStation(location),
                latitude,
                longitude,
            });
        });
        dialog.open();
    }

    // ---- data -------------------------------------------------------

    _update(force = false) {
        if (!this._hasLocation) {
            this._sync();
            return;
        }
        if (!force && this._loading)
            return;
        this._loading = true;
        this._sync();
        this._info.update();
    }

    _onUpdated() {
        this._loading = false;
        this._lastUpdate = GLib.get_monotonic_time();
        this._sync();
        if (this._showingForecast && this._menu?.isOpen) {
            this._menu.removeAll();
            this._buildForecast(this._menu);
        }
    }

    _formatTemp(info) {
        const [ok, value] = info.get_value_temp(UNITS[this.settings.unit] ?? UNITS.default);
        return ok ? `${Math.round(value)}°` : '--';
    }

    _sync() {
        const info = this._info;
        const place = this._placeName();
        this._place.text = place;
        this._place.visible = place !== '';

        if (!this._hasLocation) {
            this._icon.icon_name = 'weather-few-clouds-symbolic';
            this._icon.opacity = 128;
            this._temp.text = '--';
            this.accessible_name = _('Weather: no location');
        } else if (info.is_valid()) {
            this._icon.icon_name = info.get_symbolic_icon_name();
            this._icon.opacity = 255;
            this._temp.text = this._formatTemp(info);
            this.accessible_name = `${place}: ${info.get_sky()}, ${this._temp.text}`;
        } else {
            this._icon.icon_name = this._loading
                ? 'content-loading-symbolic' : 'network-offline-symbolic';
            this._icon.opacity = 128;
            this._temp.text = this._loading ? '…' : '--';
            this.accessible_name = _('Weather');
        }
    }

    // ---- forecast popup ---------------------------------------------

    _buildForecast(menu) {
        const info = this._info;
        if (!this._hasLocation) {
            menu.addAction(_('Choose City…'), () => this._chooseCity());
            if (!this._locationSettings.get_boolean('enabled'))
                menu.addMenuItem(statusItem(_('Location services are off')));
            return;
        }

        if (!info.is_valid()) {
            let status = _('Weather Information Unavailable');
            if (this._loading)
                status = _('Loading…');
            else if (info.network_error())
                status = _('Go Online for Weather Information');
            menu.addMenuItem(statusItem(status));
            menu.addAction(_('Refresh'), () => this._update(true));
            return;
        }

        const forecasts = validForecasts(info);
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'weather-applet-forecast',
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'weather-applet-box',
            x_expand: true,
        });
        item.add_child(box);

        // Now
        const now = new St.BoxLayout({style_class: 'weather-applet-now'});
        now.add_child(new St.Icon({
            icon_name: info.get_symbolic_icon_name(),
            style_class: 'weather-applet-now-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const nowText = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        nowText.add_child(new St.Label({
            style_class: 'weather-applet-place',
            text: this._placeName(),
        }));
        nowText.add_child(new St.Label({
            style_class: 'weather-applet-now-temp',
            text: `${this._formatTemp(info)}  ${skyText(info, forecasts)}`,
        }));
        nowText.add_child(new St.Label({
            style_class: 'weather-applet-details',
            /* Translators: feels-like temperature, humidity and wind */
            text: _('Feels like %s · Humidity %s · Wind %s').format(
                info.get_apparent(), info.get_humidity(), info.get_wind()),
        }));
        now.add_child(nowText);
        box.add_child(now);

        // The coming hours
        const hours = new St.Widget({
            style_class: 'weather-applet-hours',
            layout_manager: new Clutter.GridLayout({column_spacing: 16, row_spacing: 4}),
        });
        const grid = hours.layout_manager;
        let last = 0;
        let col = 0;
        for (const [time, fc] of forecasts) {
            if (col === MAX_HOURS)
                break;
            if (time - last < 3600)
                continue;
            last = time;
            grid.attach(cell('weather-applet-hour-time',
                formatTime(new Date(time * 1000), {timeOnly: true, ampm: false})),
                col, 0, 1, 1);
            grid.attach(new St.Icon({
                icon_name: fc.get_symbolic_icon_name(),
                style_class: 'weather-applet-hour-icon',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            }), col, 1, 1, 1);
            grid.attach(cell('weather-applet-hour-temp', this._formatTemp(fc)), col, 2, 1, 1);
            col++;
        }
        if (col > 0)
            box.add_child(hours);

        // The coming days, from the hourly forecasts: the highest and
        // lowest temperature of each day, and the sky around midday
        const days = new St.Widget({
            style_class: 'weather-applet-days',
            layout_manager: new Clutter.GridLayout({column_spacing: 14, row_spacing: 4}),
        });
        const daysGrid = days.layout_manager;
        const unit = UNITS[this.settings.unit] ?? UNITS.default;
        let row = 0;
        for (const day of dailyForecasts(forecasts, unit).slice(0, MAX_DAYS)) {
            daysGrid.attach(cell('weather-applet-day-name', day.name, Clutter.ActorAlign.START), 0, row, 1, 1);
            daysGrid.attach(new St.Icon({
                icon_name: day.icon,
                style_class: 'weather-applet-day-icon',
            }), 1, row, 1, 1);
            daysGrid.attach(cell('weather-applet-day-max', `${Math.round(day.max)}°`,
                Clutter.ActorAlign.END), 2, row, 1, 1);
            daysGrid.attach(cell('weather-applet-day-min', `${Math.round(day.min)}°`,
                Clutter.ActorAlign.END), 3, row, 1, 1);
            row++;
        }
        if (row > 0)
            box.add_child(days);

        menu.addMenuItem(item);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const [, updated] = info.get_value_update();
        if (updated) {
            menu.addMenuItem(statusItem(_('Updated %s').format(
                formatTime(new Date(updated * 1000), {timeOnly: true}))));
        }
    }
});

function cell(styleClass, text, xAlign = Clutter.ActorAlign.CENTER) {
    const label = new St.Label({style_class: styleClass, text, x_align: xAlign});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function statusItem(text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
    item.add_style_class_name('weather-applet-status');
    return item;
}

/**
 * "Rain showers" when the station reports conditions, else the sky,
 * e.g. "Few clouds"; locations without a station only have forecasts.
 */
function skyText(info, forecasts) {
    if (info.get_value_conditions()[0])
        return info.get_conditions();
    for (const fc of [info, ...forecasts.map(([, f]) => f)]) {
        if (fc.get_value_sky()[0])
            return fc.get_sky();
    }
    return '';
}

/** @returns {Array<[number, GWeather.Info]>} future forecasts with their times */
function validForecasts(info) {
    const now = GLib.get_real_time() / GLib.USEC_PER_SEC;
    const forecasts = [];
    for (const fc of info.get_forecast_list()) {
        const [valid, time] = fc.get_value_update();
        // 0 means 'never updated'
        if (valid && time !== 0 && time >= now - 1800)
            forecasts.push([time, fc]);
    }
    return forecasts.sort((a, b) => a[0] - b[0]);
}

function dailyForecasts(forecasts, unit) {
    const days = new Map();
    for (const [time, fc] of forecasts) {
        const [ok, temp] = fc.get_value_temp(unit);
        if (!ok)
            continue;
        const date = GLib.DateTime.new_from_unix_local(time);
        const key = date.format('%F');
        let day = days.get(key);
        if (!day) {
            day = {name: date.format('%a'), min: temp, max: temp, icon: null, noon: Infinity};
            days.set(key, day);
        }
        day.min = Math.min(day.min, temp);
        day.max = Math.max(day.max, temp);
        const fromNoon = Math.abs(date.get_hour() - 13);
        if (fromNoon < day.noon) {
            day.noon = fromNoon;
            day.icon = fc.get_symbolic_icon_name();
        }
    }
    // Today is usually only the rest of the day; still worth a row
    const result = [...days.values()];
    if (result.length > 0)
        result[0].name = _('Today');
    return result;
}

/** @type {Array<{location: GWeather.Location, name: string, detail: string}>|null} */
let _cities = null;

/** Every city in GWeather's database; about 4,000, read once. */
function allCities() {
    if (_cities)
        return _cities;

    _cities = [];
    const walk = parent => {
        let child = null;
        while ((child = parent.next_child(child))) {
            const level = child.get_level();
            if (level === GWeather.LocationLevel.CITY)
                _cities.push(cityEntry(child));
            else if (level < GWeather.LocationLevel.CITY)
                walk(child);
        }
    };
    walk(GWeather.Location.get_world());
    _cities.sort((a, b) => a.name.localeCompare(b.name));
    return _cities;
}

/** @param {{name: string, station: ?string, latitude: number, longitude: number}} saved */
function detachedLocation({name, station, latitude, longitude}) {
    // With a station, GWeather takes the coordinates in radians
    if (station) {
        return GWeather.Location.new_detached(name, station,
            latitude * Math.PI / 180, longitude * Math.PI / 180);
    }
    return GWeather.Location.new_detached(name, null, latitude, longitude);
}

/** @returns {string|null} ICAO code of the city's own weather station */
function cityStation(city) {
    let child = null;
    while ((child = city.next_child(child))) {
        if (child.get_level() === GWeather.LocationLevel.WEATHER_STATION)
            return child.get_code();
    }
    return null;
}

function cityEntry(location) {
    const country = location.get_country_name();
    const parent = location.get_parent();
    const region = parent?.get_level() === GWeather.LocationLevel.ADM1
        ? parent.get_name() : null;
    const detail = [region, country].filter(s => s).join(', ');
    const name = location.get_name();
    return {location, name, detail, text: `${name} ${detail}`, folded: fold(name)};
}

function fold(text) {
    return GLib.str_to_ascii(text, null).toLowerCase();
}

/** Search-as-you-type over GWeather's cities. */
const CityDialog = GObject.registerClass(
class CityDialog extends ModalDialog.ModalDialog {
    /** @param {function(GWeather.Location): void} onChoose */
    _init(onChoose) {
        super._init({styleClass: 'weather-city-dialog'});
        this._onChoose = onChoose;

        const content = new Dialog.MessageDialogContent({
            title: _('Weather Location'),
            description: _('Search for a city'),
        });
        this.contentLayout.add_child(content);

        this._entry = new St.Entry({
            style_class: 'weather-city-entry',
            hint_text: _('City name'),
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('text-changed', () => this._search());
        this._entry.clutter_text.connect('activate', () => {
            const first = this._results.get_first_child();
            if (first)
                this._choose(first._city);
        });
        content.add_child(this._entry);

        this._results = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'weather-city-results',
        });
        this._scroll = new St.ScrollView({
            style_class: 'weather-city-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._results,
        });
        content.add_child(this._scroll);

        this.setButtons([{
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }]);
        this.setInitialKeyFocus(this._entry);
    }

    _search() {
        this._results.destroy_all_children();
        const term = this._entry.text.trim();
        if (term === '')
            return;

        // The city itself, then cities named after the term, then
        // cities in a region or country of that name
        const folded = fold(term);
        const rank = city => {
            if (city.folded === folded)
                return 0;
            return GLib.str_match_string(term, city.name, true) ? 1 : 2;
        };
        const matches = allCities()
            .filter(c => GLib.str_match_string(term, c.text, true))
            .map(city => ({city, rank: rank(city)}))
            .sort((a, b) => a.rank - b.rank)
            .map(m => m.city);

        for (const city of matches.slice(0, MAX_RESULTS)) {
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            box.add_child(new St.Label({style_class: 'weather-city-name', text: city.name}));
            box.add_child(new St.Label({style_class: 'weather-city-detail', text: city.detail}));
            const button = new St.Button({
                style_class: 'weather-city-result',
                child: box,
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            button._city = city;
            button.connect('clicked', () => this._choose(city));
            this._results.add_child(button);
        }
        if (matches.length === 0) {
            this._results.add_child(new St.Label({
                style_class: 'weather-city-detail',
                text: _('No cities found'),
            }));
        }
    }

    _choose(city) {
        if (!city)
            return;
        this._onChoose(city.location);
        this.close();
    }
});
