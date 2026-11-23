// Asynchronous, lifecycle-owned BlueZ ObjectManager integration.
// This module deliberately does not own/close the shared system bus connection.
// Gio maintains the object cache and rebuilds it when bluetoothd restarts.
// See https://docs.gtk.org/gio/class.DBusObjectManagerClient.html

import Gio from 'gi://Gio';

const MANAGER_PATH = '/';

function unpack(value) {
    if (value?.recursiveUnpack)
        return value.recursiveUnpack();
    if (value?.deepUnpack)
        return unpack(value.deepUnpack());
    if (Array.isArray(value))
        return value.map(unpack);
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
        const result = Object.create(null);
        for (const [key, item] of Object.entries(value))
            result[key] = unpack(item);
        return result;
    }
    return value;
}

function cancelledError() {
    return new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.CANCELLED,
        message: 'BlueZ operation canceled because its owner or lifecycle changed',
    });
}

export class BlueZMonitor {
    constructor({onUpdate = () => {}, onAvailability = () => {},
        connection = null, busName = 'org.bluez', log = console.warn} = {}) {
        this.objects = new Map();
        this.online = false;
        this._onUpdate = onUpdate;
        this._onAvailability = onAvailability;
        this._providedConnection = connection;
        this._busName = busName;
        this._log = log;
        this._manager = null;
        this._connection = null;
        this._signalIds = [];
        this._owner = null;
        this._generation = 0;
        this._running = false;
        this._ready = null;
        this._initCancel = null;
        this._callCancel = null;
    }

    get connection() {
        return this._connection;
    }

    // The Promise never rejects: callers may safely use start() without await.
    // False means canceled/failed initialization; BlueZ absence itself is normal
    // and a successfully initialized manager will watch for its future return.
    start() {
        if (this._running)
            return this._ready ?? Promise.resolve(true);
        this._running = true;
        const generation = ++this._generation;
        const cancellable = this._initCancel = new Gio.Cancellable();
        this._ready = new Promise(resolve => {
            const finish = (_source, result) => {
                let manager;
                try {
                    manager = this._providedConnection
                        ? Gio.DBusObjectManagerClient.new_finish(result)
                        : Gio.DBusObjectManagerClient.new_for_bus_finish(result);
                } catch (error) {
                    if (this._running && generation === this._generation) {
                        this._running = false;
                        this._notifyAvailability(false, true);
                        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            this._report(`BlueZ monitor initialization failed: ${error.message}`);
                    }
                    resolve(false);
                    return;
                }
                if (!this._running || generation !== this._generation) {
                    // No handlers have been installed on this stale manager.
                    manager.run_dispose();
                    resolve(false);
                    return;
                }
                this._install(manager, generation);
                resolve(Boolean(this._live(generation)));
            };
            const flags = Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START;
            try {
                if (this._providedConnection) {
                    Gio.DBusObjectManagerClient.new(this._providedConnection, flags,
                        this._busName, MANAGER_PATH, null, cancellable, finish);
                } else {
                    Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM, flags,
                        this._busName, MANAGER_PATH, null, cancellable, finish);
                }
            } catch (error) {
                if (generation === this._generation) {
                    this._running = false;
                    this._notifyAvailability(false, true);
                    this._report(`BlueZ monitor initialization failed: ${error.message}`);
                }
                resolve(false);
            }
        });
        return this._ready;
    }

    stop() {
        this._running = false;
        ++this._generation;
        this._initCancel?.cancel();
        this._callCancel?.cancel();
        this._initCancel = null;
        this._callCancel = null;
        if (this._manager) {
            for (const id of this._signalIds)
                this._manager.disconnect(id);
            this._manager.run_dispose();
        }
        this._signalIds = [];
        this._manager = null;
        this._connection = null;
        this._owner = null;
        this._ready = null;
        this.objects.clear();
        this.online = false;
        // Do not notify consumers during their own teardown, and never close
        // connection: Gio's system/session bus is shared by unrelated clients.
    }

    _live(generation) {
        return this._running && generation === this._generation && this._manager;
    }

    _install(manager, generation) {
        this._manager = manager;
        this._connection = manager.get_connection();
        const active = () => this._live(generation) && this.online && manager.get_name_owner();
        this._signalIds = [
            manager.connect('notify::name-owner', () => {
                if (this._live(generation))
                    this._ownerChanged();
            }),
            manager.connect('object-added', (_manager, object) => {
                if (active())
                    this._publish(object, {kind: 'object-added'});
            }),
            manager.connect('object-removed', (_manager, object) => {
                if (!active())
                    return;
                const path = object.get_object_path();
                this.objects.delete(path);
                this._notifyUpdate(path, null, {kind: 'object-removed'});
            }),
            manager.connect('interface-added', (_manager, object, iface) => {
                if (active()) {
                    this._publish(object, {
                        kind: 'interface-added',
                        interfaceName: iface.get_interface_name(),
                        changed: iface.get_cached_property_names() ?? [],
                    });
                }
            }),
            manager.connect('interface-removed', (_manager, object, iface) => {
                if (active()) {
                    const interfaceName = iface.get_interface_name();
                    this._publish(object, {kind: 'interface-removed', interfaceName}, interfaceName);
                }
            }),
            manager.connect('interface-proxy-properties-changed',
                (_manager, object, iface, changed, invalidated) => {
                    if (active()) {
                        this._publish(object, {
                            kind: 'properties',
                            interfaceName: iface.get_interface_name(),
                            changed: Object.keys(unpack(changed) ?? {}),
                            invalidated: [...invalidated],
                        });
                    }
                }),
        ];
        this._ownerChanged(true);
    }

    _ownerChanged(initial = false) {
        const manager = this._manager;
        const generation = this._generation;
        const owner = manager.get_name_owner();
        if (!initial && owner === this._owner)
            return;
        this._callCancel?.cancel();
        this._callCancel = new Gio.Cancellable();
        const wasOnline = this.online;
        this._owner = owner;
        this.objects.clear();
        if (wasOnline)
            this._notifyAvailability(false);
        if (!this._live(generation) || this._manager !== manager)
            return;
        if (!owner) {
            this._notifyAvailability(false, initial);
            return;
        }
        this._notifyAvailability(true);
        if (!this._live(generation) || this._manager !== manager)
            return;
        // Object-added may occur while name-owner is temporarily null during a
        // service restart. Rebuild the full authoritative snapshot after Gio
        // publishes the new owner, rather than accepting half-built objects.
        for (const object of manager.get_objects()) {
            if (!this._live(generation))
                break;
            this._publish(object, {kind: 'initial'});
        }
    }

    _publish(object, event, excludedInterface = null) {
        const path = object.get_object_path();
        const interfaces = Object.create(null);
        for (const iface of object.get_interfaces()) {
            const name = iface.get_interface_name();
            if (name === excludedInterface)
                continue;
            const props = Object.create(null);
            for (const prop of iface.get_cached_property_names() ?? []) {
                const value = iface.get_cached_property(prop);
                if (value !== null)
                    props[prop] = unpack(value);
            }
            interfaces[name] = props;
        }
        this.objects.set(path, interfaces);
        this._notifyUpdate(path, interfaces, event);
    }

    _notifyUpdate(path, interfaces, event) {
        const detail = {changed: [], invalidated: [], ...event};
        try {
            this._onUpdate(path, interfaces, detail);
        } catch (error) {
            this._report(`BlueZ update consumer failed: ${error.message}`);
        }
    }

    _notifyAvailability(online, force = false) {
        if (this.online === online && !force)
            return;
        this.online = online;
        try {
            this._onAvailability(online);
        } catch (error) {
            this._report(`BlueZ availability consumer failed: ${error.message}`);
        }
    }

    _report(message) {
        try {
            this._log(message);
        } catch {
            // Logging must not prevent cleanup of the desktop's shared bus.
        }
    }

    // Resolves to a recursively unpacked return tuple. All outstanding calls
    // are canceled on stop() or BlueZ owner replacement. Capturing the unique
    // owner prevents a queued operation from silently reaching a new daemon.
    call(path, iface, method, params = null, replyType = null, timeout = 10000) {
        if (!this._running || !this.online || !this._connection || !this._owner)
            return Promise.reject(new Error('BlueZ is unavailable'));
        const generation = this._generation;
        const owner = this._owner;
        const connection = this._connection;
        const cancellable = this._callCancel;
        const deadline = Number.isFinite(timeout)
            ? Math.min(30000, Math.max(100, Math.trunc(timeout))) : 10000;
        return new Promise((resolve, reject) => {
            connection.call(owner, path, iface, method, params, replyType,
                Gio.DBusCallFlags.NONE, deadline, cancellable, (conn, result) => {
                    try {
                        const reply = conn.call_finish(result);
                        if (!this._running || generation !== this._generation || owner !== this._owner)
                            throw cancelledError();
                        resolve(unpack(reply));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }
}
