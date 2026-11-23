// Private, bounded and asynchronous storage for estimator schema version 2.
// No Shell actors, synchronous file I/O, subprocesses or GLib timers.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MAX_STATE_BYTES = 1024 * 1024;
const PRIORITY = GLib.PRIORITY_DEFAULT;
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
const PRIVATE_REPLACE = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;
const CHUNK = 64 * 1024;
const FILE_ATTRIBUTES = 'standard::type,standard::size,etag::value,unix::inode';

function fingerprint(info) {
    return {etag: info.get_attribute_string('etag::value'), size: info.get_size(),
        inode: info.get_attribute_as_string('unix::inode')};
}

function sameFile(a, b) {
    return a?.etag === b?.etag && a?.size === b?.size && a?.inode === b?.inode;
}

function changedFile() {
    const error = new Error('Concurrent state modification');
    error.stateConflict = true;
    return error;
}

function ioError(error, code) {
    return error?.matches?.(Gio.IOErrorEnum, code) === true;
}

function queryInfo(file, attributes, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, NOFOLLOW, PRIORITY, cancellable, (_file, result) => {
            try { resolve(file.query_info_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function openRead(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.read_async(PRIORITY, cancellable, (_file, result) => {
            try { resolve(file.read_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function streamInfo(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.query_info_async(FILE_ATTRIBUTES, PRIORITY, cancellable, (_stream, result) => {
            try { resolve(stream.query_info_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, PRIORITY, cancellable, (_stream, result) => {
            try { resolve(stream.read_bytes_finish(result).get_data()); } catch (error) { reject(error); }
        });
    });
}

function closeStream(stream) {
    // Cleanup is deliberately not canceled with the user's load operation.
    return new Promise((resolve, reject) => {
        stream.close_async(PRIORITY, null, (_stream, result) => {
            try { resolve(stream.close_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function makeDirectory(file) {
    return new Promise((resolve, reject) => {
        file.make_directory_async(PRIORITY, null, (_file, result) => {
            try { resolve(file.make_directory_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function setPrivateDirectory(file) {
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o700);
    return new Promise((resolve, reject) => {
        file.set_attributes_async(info, NOFOLLOW, PRIORITY, null, (_file, result) => {
            try {
                const [ok] = file.set_attributes_finish(result);
                if (!ok)
                    throw new Error('Unable to set private directory mode');
                resolve(true);
            } catch (error) { reject(error); }
        });
    });
}

function replaceContents(file, bytes, etag) {
    return new Promise((resolve, reject) => {
        file.replace_contents_async(bytes, etag, false, PRIVATE_REPLACE, null, (_file, result) => {
            try {
                const [ok, nextEtag] = file.replace_contents_finish(result);
                if (!ok)
                    throw new Error('Unable to replace state contents');
                resolve(nextEtag ?? null);
            } catch (error) { reject(error); }
        });
    });
}

function defaultValidator(value) {
    const objectMap = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    // Validate the root containers before Estimator can sanitize individual
    // devices. An opaque/corrupt container must not be rewritten as an empty
    // calibration database. Older version-2 files may omit companions.
    return objectMap(value) && value.version === 2 && objectMap(value.devices) &&
        (!Object.prototype.hasOwnProperty.call(value, 'companions') || objectMap(value.companions));
}

export class StateStore {
    constructor(path, {onError = () => {}, validate = defaultValidator, maxBytes = MAX_STATE_BYTES} = {}) {
        if (typeof path !== 'string' || !GLib.path_is_absolute(path) || path.includes('\0'))
            throw new TypeError('StateStore requires an absolute local file path');
        this._file = Gio.File.new_for_path(GLib.canonicalize_filename(path, null));
        this._parent = this._file.get_parent();
        this._onError = typeof onError === 'function' ? onError : () => {};
        this._validate = typeof validate === 'function' ? validate : defaultValidator;
        this._maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_STATE_BYTES
            ? maxBytes : MAX_STATE_BYTES;
        this._readOnly = false;
        this._canceled = false;
        this._loaded = false;
        this._closed = false;
        this._loadPromise = null;
        this._closePromise = null;
        this._worker = null;
        this._pending = null;
        this._waiters = [];
        this._revision = 0;
        this._etag = null;
        this._expectedFile = null;
    }

    get readOnly() {
        return this._readOnly || this._canceled;
    }

    _report(message) {
        // The logger may outlive the extension. Its exception must not create
        // an unhandled rejection or retry an unsafe write.
        try { this._onError(message); } catch { /* reporting is best effort */ }
    }

    _protect(message) {
        this._readOnly = true;
        this._pending = null;
        this._settle(Infinity, false);
        this._report(message);
    }

    _settle(revision, result) {
        const remaining = [];
        for (const waiter of this._waiters) {
            if (waiter.revision <= revision)
                waiter.resolve(result);
            else
                remaining.push(waiter);
        }
        this._waiters = remaining;
    }

    load(cancellable = null) {
        if (this._loadPromise)
            return this._loadPromise;
        if (this._closed)
            return Promise.resolve(null);
        this._loadPromise = this._load(cancellable).finally(() => {
            this._loaded = true;
            if (this.readOnly) {
                this._pending = null;
                this._settle(Infinity, false);
            } else {
                this._kick();
            }
        });
        return this._loadPromise;
    }

    async _load(cancellable) {
        let stream = null;
        let existed = false;
        try {
            if (cancellable?.is_cancelled()) {
                this._canceled = true;
                return null;
            }
            const info = await queryInfo(this._file, FILE_ATTRIBUTES, cancellable);
            existed = true;
            if (info.get_file_type() !== Gio.FileType.REGULAR) {
                this._protect('State file is not a regular file. It was preserved; saving is disabled.');
                return null;
            }
            if (info.get_size() > this._maxBytes) {
                this._protect('State file exceeds the size limit. It was preserved; saving is disabled.');
                return null;
            }
            stream = await openRead(this._file, cancellable);
            const before = await streamInfo(stream, cancellable);
            if (before.get_size() > this._maxBytes) {
                this._protect('State file exceeds the size limit. It was preserved; saving is disabled.');
                return null;
            }
            const chunks = [];
            let size = 0;
            while (size <= this._maxBytes) {
                const bytes = await readBytes(stream, Math.min(CHUNK, this._maxBytes + 1 - size), cancellable);
                if (!bytes.length)
                    break;
                chunks.push(bytes);
                size += bytes.length;
                if (size > this._maxBytes) {
                    this._protect('State file exceeds the size limit. It was preserved; saving is disabled.');
                    return null;
                }
            }
            const after = await streamInfo(stream, cancellable);
            const beforeFile = fingerprint(before);
            const afterFile = fingerprint(after);
            if (!sameFile(beforeFile, afterFile)) {
                this._protect('State file changed during loading. It was preserved; saving is disabled.');
                return null;
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            let value;
            try {
                value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
                if (!this._validate(value))
                    throw new Error('Unsupported state schema');
            } catch {
                this._protect('State file is corrupt or uses an unsupported schema. It was preserved; saving is disabled until repaired.');
                return null;
            }
            this._expectedFile = afterFile;
            this._etag = afterFile.etag ?? info.get_attribute_string('etag::value') ?? null;
            return value;
        } catch (error) {
            if (cancellable?.is_cancelled() || ioError(error, Gio.IOErrorEnum.CANCELLED)) {
                this._canceled = true;
                return null;
            }
            if (ioError(error, Gio.IOErrorEnum.NOT_FOUND) && !existed)
                return null;
            this._protect('Unable to read state. Existing data was preserved; saving is disabled.');
            return null;
        } finally {
            if (stream) {
                try { await closeStream(stream); } catch {
                    this._protect('Unable to close state input safely. Saving is disabled.');
                }
            }
            if (cancellable?.is_cancelled())
                this._canceled = true;
        }
    }

    save(state) {
        if (this._closed || this.readOnly || !this._loadPromise)
            return Promise.resolve(false);
        let bytes;
        try {
            if (!this._validate(state))
                throw new Error('Unsupported state schema');
            const json = JSON.stringify(state);
            if (typeof json !== 'string' || json.length > this._maxBytes)
                throw new Error('State too large');
            // A custom toJSON implementation must not pass the object check
            // and then replace valid on-disk state with null/another schema.
            if (!this._validate(JSON.parse(json)))
                throw new Error('Serialized state has an unsupported schema');
            bytes = new TextEncoder().encode(json);
            if (bytes.length > this._maxBytes)
                throw new Error('State too large');
        } catch {
            this._report('State snapshot could not be serialized safely. The existing file was not replaced.');
            return Promise.resolve(false);
        }
        const revision = ++this._revision;
        // Serialize immediately: callers may mutate their estimator while an
        // earlier asynchronous write is running. Only the latest pending
        // snapshot is retained; in-flight bytes are never reused or mutated.
        this._pending = {revision, bytes};
        const promise = new Promise(resolve => this._waiters.push({revision, resolve}));
        this._kick();
        return promise;
    }

    _kick() {
        if (!this._loaded || this._worker || !this._pending || this.readOnly)
            return;
        this._worker = this._writeLoop().finally(() => {
            this._worker = null;
            if (this._pending && !this.readOnly)
                this._kick();
        });
    }

    async _ensureDirectory(file, makePrivate) {
        const path = file?.get_path();
        if (!path)
            throw new Error('Invalid state directory');
        let info;
        try {
            info = await queryInfo(file, 'standard::type,unix::mode');
        } catch (error) {
            if (!ioError(error, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
            const parent = file.get_parent();
            if (!parent)
                throw new Error('No parent directory');
            await this._ensureDirectory(parent, false);
            try { await makeDirectory(file); } catch (makeError) {
                if (!ioError(makeError, Gio.IOErrorEnum.EXISTS))
                    throw makeError;
            }
            info = await queryInfo(file, 'standard::type,unix::mode');
            makePrivate = true;
        }
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            throw new Error('State parent is not a directory');
        if (makePrivate && (info.get_attribute_uint32('unix::mode') & 0o777) !== 0o700)
            await setPrivateDirectory(file);
    }

    async _writeLoop() {
        try {
            // Never chmod broad user/system directories when a caller passes
            // a bad path. The actual app uses its dedicated state directory.
            const parentPath = this._parent?.get_path();
            const broad = ['/', GLib.get_home_dir(), GLib.get_user_state_dir(), GLib.get_tmp_dir()];
            if (!parentPath || broad.includes(parentPath))
                throw new Error('State needs a dedicated directory');
            await this._ensureDirectory(this._parent, true);
            while (this._pending && !this.readOnly) {
                const snapshot = this._pending;
                this._pending = null;
                // Local GIO ETags can repeat on filesystems with coarse
                // timestamps. Also compare size/inode, and never overwrite a
                // file that appeared since a successful "missing" load.
                let current = null;
                try {
                    const info = await queryInfo(this._file, FILE_ATTRIBUTES);
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        throw changedFile();
                    current = fingerprint(info);
                } catch (error) {
                    if (!ioError(error, Gio.IOErrorEnum.NOT_FOUND))
                        throw error;
                }
                if ((current === null) !== (this._expectedFile === null) ||
                    (current && !sameFile(current, this._expectedFile)))
                    throw changedFile();
                this._etag = await replaceContents(this._file, snapshot.bytes, this._etag);
                const written = await queryInfo(this._file, FILE_ATTRIBUTES);
                if (written.get_file_type() !== Gio.FileType.REGULAR ||
                    written.get_size() !== snapshot.bytes.length ||
                    written.get_attribute_string('etag::value') !== this._etag)
                    throw changedFile();
                this._expectedFile = fingerprint(written);
                this._settle(snapshot.revision, true);
            }
        } catch (error) {
            this._protect(error.stateConflict || ioError(error, Gio.IOErrorEnum.WRONG_ETAG)
                ? 'State was modified by another writer. It was preserved; saving is disabled.'
                : 'Unable to save state atomically. Saving is disabled; existing data was not intentionally discarded.');
        }
    }

    close(finalState) {
        if (this._closePromise)
            return this._closePromise;
        const finalWrite = arguments.length ? this.save(finalState) : Promise.resolve(!this.readOnly);
        this._closed = true;
        this._closePromise = (async () => {
            if (!this._loadPromise)
                return false;
            await this._loadPromise;
            const ok = await finalWrite;
            while (this._worker)
                await this._worker;
            return ok && !this.readOnly;
        })();
        return this._closePromise;
    }
}
