// The Desktop folder's files, their thumbnails, and what can be done
// with them. File operations go through Nautilus, so they show its
// progress, ask about conflicts and can be undone, as in Files.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gdk.Clipboard.prototype, 'read_async');
Gio._promisify(Gdk.Clipboard.prototype, 'read_value_async');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype,
    'generate_thumbnail_async', 'generate_thumbnail_finish');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype,
    'save_thumbnail_async', 'save_thumbnail_finish');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype,
    'create_failed_thumbnail_async', 'create_failed_thumbnail_finish');

const QUERY_ATTRS = [
    'standard::name',
    'standard::display-name',
    'standard::icon',
    'standard::type',
    'standard::content-type',
    'standard::is-hidden',
    'standard::is-backup',
    'access::can-execute',
    'time::modified',
    'thumbnail::path',
    'thumbnail::failed',
    'id::filesystem',
].join(',');
const BATCH_SIZE = 200;

/** What Files puts on the clipboard to tell a cut from a copy */
const COPIED_FILES_TYPE = 'x-special/gnome-copied-files';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @returns {Gio.File|null} the Desktop folder; none if XDG puts the
 *   desktop in home, whose files would bury the desktop
 */
export function desktopFolder() {
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    return path && path !== GLib.get_home_dir() ? Gio.File.new_for_path(path) : null;
}

/**
 * @typedef {object} Entry
 * @property {Gio.File} file
 * @property {string} name - the file's name on disk
 * @property {string} displayName
 * @property {Gio.Icon} icon
 * @property {boolean} isDir
 * @property {string|null} contentType
 * @property {number} mtime - seconds
 * @property {string|null} filesystem
 * @property {boolean} hasThumbnail - whether `icon` is its thumbnail,
 *   or it can't have one
 * @property {GioUnix.DesktopAppInfo|null} launcher - for a trusted
 *   (executable) .desktop file, the app it starts
 */

/** @returns {Promise<Entry[]>} the folder's files that aren't hidden */
export async function listEntries(folder, cancellable) {
    const enumerator = await folder.enumerate_children_async(QUERY_ATTRS,
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const entries = [];
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const infos = await enumerator.next_files_async(BATCH_SIZE,
            GLib.PRIORITY_DEFAULT, cancellable);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            if (info.get_is_hidden() || info.get_is_backup())
                continue;
            entries.push(entryFor(enumerator.get_child(info), info));
        }
    }
    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
    return entries;
}

function entryFor(file, info) {
    const contentType = info.get_content_type();
    const thumbnail = info.get_attribute_byte_string('thumbnail::path');
    const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
    const entry = {
        file,
        name: info.get_name(),
        displayName: info.get_display_name(),
        icon: thumbnail
            ? new Gio.FileIcon({file: Gio.File.new_for_path(thumbnail)})
            : info.get_icon(),
        isDir,
        contentType,
        mtime: info.get_attribute_uint64('time::modified'),
        filesystem: info.get_attribute_string('id::filesystem'),
        hasThumbnail: !!thumbnail || isDir ||
            info.get_attribute_boolean('thumbnail::failed'),
        launcher: null,
    };

    // A launcher only runs if it's executable, as in GNOME: a .desktop
    // file that was just downloaded opens as text instead
    if (contentType === 'application/x-desktop' &&
        info.get_attribute_boolean('access::can-execute')) {
        const appInfo = GioUnix.DesktopAppInfo.new_from_filename(file.get_path());
        if (appInfo) {
            entry.launcher = appInfo;
            entry.displayName = appInfo.get_name();
            entry.icon = appInfo.get_icon() ?? entry.icon;
            entry.hasThumbnail = true;
        }
    }
    return entry;
}

/**
 * Makes the thumbnails files don't have yet, one at a time, as Files
 * does when it shows them.
 */
export class Thumbnailer {
    constructor() {
        this._factory = GnomeDesktop.DesktopThumbnailFactory.new(
            GnomeDesktop.DesktopThumbnailSize.LARGE);
        /** @type {Array<{entry: Entry, done: function(Gio.Icon): void}>} */
        this._queue = [];
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._queue = [];
    }

    /**
     * @param {Entry} entry
     * @param {function(Gio.Icon): void} done - called with the thumbnail
     */
    request(entry, done) {
        if (entry.hasThumbnail || !entry.contentType)
            return;
        this._queue = this._queue.filter(job => job.entry.name !== entry.name);
        this._queue.push({entry, done});
        this._next();
    }

    async _next() {
        if (this._busy)
            return;
        const job = this._queue.shift();
        if (!job)
            return;
        this._busy = true;
        const {entry} = job;
        const uri = entry.file.get_uri();
        try {
            if (this._factory.can_thumbnail(uri, entry.contentType, entry.mtime) &&
                !this._factory.has_valid_failed_thumbnail(uri, entry.mtime)) {
                const pixbuf = await this._factory.generate_thumbnail_async(uri,
                    entry.contentType, this._cancellable);
                await this._factory.save_thumbnail_async(pixbuf, uri, entry.mtime,
                    this._cancellable);
                const path = this._factory.lookup(uri, entry.mtime);
                if (path)
                    job.done(new Gio.FileIcon({file: Gio.File.new_for_path(path)}));
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._factory.create_failed_thumbnail_async(uri, entry.mtime,
                this._cancellable).catch(() => {});
        }
        this._busy = false;
        this._next();
    }
}

// ---- file operations ------------------------------------------------------

/**
 * Call one of Nautilus's file operations, which shows its own progress,
 * questions and errors.
 */
function fileOperation(method, signature, args) {
    return Gio.DBus.session.call(
        'org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', method,
        new GLib.Variant(signature, [...args, {}]),
        null, Gio.DBusCallFlags.NONE, -1, null)
        .catch(e => console.warn(`Files failed to ${method}: ${e.message}`));
}

/** @param {Gio.File[]} files */
const uris = files => files.map(f => f.get_uri());

/** Copy `files` into `folder`. */
export function copyFiles(files, folder) {
    return fileOperation('CopyURIs', '(assa{sv})', [uris(files), folder.get_uri()]);
}

/** Move `files` into `folder`. */
export function moveFiles(files, folder) {
    return fileOperation('MoveURIs', '(assa{sv})', [uris(files), folder.get_uri()]);
}

/** Move `files` to the Trash. */
export function trashFiles(files) {
    return fileOperation('TrashURIs', '(asa{sv})', [uris(files)]);
}

/** Delete for good; Files asks first. */
export function deleteFiles(files) {
    return fileOperation('DeleteURIs', '(asa{sv})', [uris(files)]);
}

/** Make a folder called `name` in `folder`. */
export function createFolder(folder, name) {
    return fileOperation('CreateFolder', '(ssa{sv})', [folder.get_uri(), name]);
}

/** Give `file` a new name. */
export function renameFile(file, name) {
    return fileOperation('RenameURI', '(ssa{sv})', [file.get_uri(), name]);
}

/** Undo the last file operation, as Ctrl+Z in Files. */
export function undo() {
    return fileOperation('Undo', '(a{sv})', []);
}

/** Redo what was undone. */
export function redo() {
    return fileOperation('Redo', '(a{sv})', []);
}

/** Show the Properties of `files` in Files. */
export function showProperties(files) {
    Gio.DBus.session.call(
        'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItemProperties',
        new GLib.Variant('(ass)', [uris(files), '']),
        null, Gio.DBusCallFlags.NONE, -1, null)
        .catch(e => console.warn(`Failed to show properties: ${e.message}`));
}

/**
 * @param {Gio.File} file
 * @param {Gio.File} folder
 * @returns {boolean} whether moving `file` into `folder` is a move
 *   within one disk, which a plain drag does, rather than a copy
 */
export function sameFilesystem(file, folder, folderFilesystem) {
    try {
        const info = file.query_info('id::filesystem', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_string('id::filesystem') === folderFilesystem;
    } catch {
        return !!file.get_path() && !!folder.get_path();
    }
}

/** A name for a new file in `folder` that isn't taken. */
export function freeName(folder, name) {
    let candidate = name;
    for (let n = 2; folder.get_child(candidate).query_exists(null); n++)
        candidate = `${name} ${n}`;
    return candidate;
}

// ---- launching --------------------------------------------------------------

/** @returns {Gio.AppLaunchContext} for apps started from `widget` */
export function launchContext(widget) {
    return widget.get_display().get_app_launch_context();
}

/**
 * Open `entries`: launchers start their apps, the rest open in their
 * default apps.
 */
export function openEntries(entries, widget) {
    for (const entry of entries) {
        try {
            if (entry.launcher)
                entry.launcher.launch([], launchContext(widget));
            else
                Gio.AppInfo.launch_default_for_uri(entry.file.get_uri(), launchContext(widget));
        } catch (e) {
            console.warn(`Failed to open ${entry.name}: ${e.message}`);
        }
    }
}

/** Open `files` with `appInfo`. */
export function openWith(appInfo, files, widget) {
    try {
        appInfo.launch(files, launchContext(widget));
    } catch (e) {
        console.warn(`Failed to open with ${appInfo.get_id()}: ${e.message}`);
    }
}

/** @returns {Gio.AppInfo[]} the apps that open `contentType`, the default first */
export function appsFor(contentType) {
    if (!contentType)
        return [];
    const preferred = Gio.AppInfo.get_default_for_type(contentType, false);
    const apps = Gio.AppInfo.get_all_for_type(contentType)
        .filter(app => app.should_show() && (!preferred || !app.equal(preferred)));
    return preferred ? [preferred, ...apps] : apps;
}

// ---- clipboard and drags ------------------------------------------------------

/**
 * A content provider holding `files`, for a drag or the clipboard, as
 * text/uri-list, which apps read as files, and as their paths. (A
 * GdkFileList value made in gjs reaches other apps empty.)
 */
export function fileListProvider(files) {
    const bytes = text => new GLib.Bytes(encoder.encode(text));
    return Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes('text/uri-list',
            bytes(uris(files).map(uri => `${uri}\r\n`).join(''))),
        Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8',
            bytes(files.map(f => f.get_path() ?? f.get_uri()).join('\n'))),
    ]);
}

/** Put `files` on the clipboard, to be pasted as a copy or, if `cut`, moved. */
export function setClipboard(clipboard, files, cut) {
    const text = [cut ? 'cut' : 'copy', ...uris(files)].join('\n');
    clipboard.set_content(Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes(COPIED_FILES_TYPE,
            new GLib.Bytes(encoder.encode(text))),
        fileListProvider(files),
    ]));
}

/**
 * @returns {Promise<{files: Gio.File[], cut: boolean}>} the files on
 *   the clipboard, and whether they were cut
 */
export async function readClipboard(clipboard) {
    const formats = clipboard.get_formats();
    if (formats.contain_mime_type(COPIED_FILES_TYPE)) {
        try {
            const [stream] = await clipboard.read_async([COPIED_FILES_TYPE],
                GLib.PRIORITY_DEFAULT, null);
            const chunks = [];
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null);
                if (bytes.get_size() === 0)
                    break;
                chunks.push(decoder.decode(bytes.toArray()));
            }
            const [action, ...lines] = chunks.join('').split(/\r?\n/).filter(l => l);
            return {
                files: lines.map(uri => Gio.File.new_for_uri(uri)),
                cut: action === 'cut',
            };
        } catch (e) {
            console.warn(`Failed to read copied files: ${e.message}`);
        }
    }
    if (formats.contain_gtype(Gdk.FileList.$gtype)) {
        try {
            const value = await clipboard.read_value_async(Gdk.FileList.$gtype,
                GLib.PRIORITY_DEFAULT, null);
            return {files: value.get_files(), cut: false};
        } catch (e) {
            console.warn(`Failed to read pasted files: ${e.message}`);
        }
    }
    return {files: [], cut: false};
}
