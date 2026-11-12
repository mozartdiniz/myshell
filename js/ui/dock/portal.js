import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Ask the desktop's file chooser portal for a file or folder.
 *
 * @param {string} title
 * @param {object} params
 * @param {boolean} [params.directory] - pick a folder instead of a file
 * @param {string} [params.currentFolder] - path the chooser starts in
 * @param {Array<[string, string[]]>} [params.filters] - [name, MIME
 *   types] pairs the user can restrict the list to
 * @returns {Promise<string|null>} URI of the chosen file, or null if
 *   the user cancelled
 */
export function chooseFile(title, params = {}) {
    const bus = Gio.DBus.session;
    const token = `myshell_chooser_${GLib.random_int()}`;
    const sender = bus.get_unique_name().slice(1).replaceAll('.', '_');
    const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

    const options = {
        handle_token: new GLib.Variant('s', token),
        directory: new GLib.Variant('b', !!params.directory),
    };
    if (params.currentFolder) {
        options.current_folder = new GLib.Variant('ay',
            new TextEncoder().encode(`${params.currentFolder}\0`));
    }
    if (params.filters?.length) {
        // 1 = MIME type pattern
        options.filters = new GLib.Variant('a(sa(us))',
            params.filters.map(([name, types]) => [name, types.map(t => [1, t])]));
    }

    return new Promise((resolve, reject) => {
        // Subscribe before calling so the response can't be missed
        const id = bus.signal_subscribe('org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request', 'Response', handle, null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, args) => {
                bus.signal_unsubscribe(id);
                const [response, results] = args.recursiveUnpack();
                // 0 = chosen, 1 = cancelled, 2 = failed
                resolve(response === 0 ? results.uris?.[0] ?? null : null);
            });

        bus.call('org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser', 'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', title, options]),
            new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    bus.signal_unsubscribe(id);
                    reject(e);
                }
            });
    });
}
