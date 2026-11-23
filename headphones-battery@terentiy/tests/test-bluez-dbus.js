// Run: dbus-run-session -- gjs -m tests/test-bluez-dbus.js
// This is a real D-Bus integration test with a fake BlueZ service. It uses
// neither the system bus nor a Bluetooth adapter and needs no root privileges.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {BlueZMonitor} from '../bluez-monitor.js';

const NAME = 'org.example.HeadphonesBattery.TestBlueZ';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';
const GATT = 'org.bluez.GattCharacteristic1';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OM = 'org.freedesktop.DBus.ObjectManager';
const PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
const SECOND = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01';
const CHAR = `${PATH}/service001/char001`;

let assertions = 0;
function assert(condition, description) {
    if (!condition)
        throw new Error(description);
    assertions++;
}

function equal(actual, expected, description) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        `${description}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function eventually(predicate, description, timeoutMs = 3000) {
    const start = GLib.get_monotonic_time();
    while (!predicate()) {
        if ((GLib.get_monotonic_time() - start) / 1000 >= timeoutMs)
            throw new Error(`Timed out: ${description}`);
        await delay(5);
    }
    assertions++;
}

function connection() {
    const address = GLib.getenv('DBUS_SESSION_BUS_ADDRESS');
    if (!address)
        throw new Error('Run this test with dbus-run-session');
    return Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        null, null);
}

function busMethod(conn, method, params) {
    return conn.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', method, params, null, Gio.DBusCallFlags.NONE, 3000, null).recursiveUnpack();
}

const xml = {
    [OM]: `<node><interface name="${OM}">
        <method name="GetManagedObjects"><arg type="a{oa{sa{sv}}}" direction="out"/></method>
        <signal name="InterfacesAdded"><arg type="o"/><arg type="a{sa{sv}}"/></signal>
        <signal name="InterfacesRemoved"><arg type="o"/><arg type="as"/></signal>
    </interface></node>`,
    [DEVICE]: `<node><interface name="${DEVICE}">
        <property name="Address" type="s" access="read"/>
        <property name="Alias" type="s" access="read"/>
        <property name="Connected" type="b" access="read"/>
        <property name="UUIDs" type="as" access="read"/>
        <method name="Connect"/>
        <method name="Delayed"><arg type="s" direction="out"/></method>
    </interface></node>`,
    [BATTERY]: `<node><interface name="${BATTERY}">
        <property name="Percentage" type="y" access="read"/>
    </interface></node>`,
    [GATT]: `<node><interface name="${GATT}">
        <property name="UUID" type="s" access="read"/>
        <method name="ReadValue"><arg type="a{sv}" direction="in"/><arg type="ay" direction="out"/></method>
    </interface></node>`,
};

class FakeBlueZ {
    constructor(conn) {
        this.conn = conn;
        this.objects = {};
        this.registrations = new Map();
        this.delayedCalls = 0;
        this.timers = new Set();
        this._register('/', OM);
    }

    _register(path, iface) {
        const info = Gio.DBusNodeInfo.new_for_xml(xml[iface]).interfaces[0];
        const id = this.conn.register_object(path, info,
            (_conn, _sender, _path, _iface, method, _params, invocation) => {
                if (method === 'GetManagedObjects') {
                    invocation.return_value(new GLib.Variant('(a{oa{sa{sv}}})', [this.objects]));
                } else if (method === 'ReadValue') {
                    invocation.return_value(new GLib.Variant('(ay)', [[57]]));
                } else if (method === 'Delayed') {
                    this.delayedCalls++;
                    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                        this.timers.delete(timer);
                        invocation.return_value(new GLib.Variant('(s)', ['old reply']));
                        return GLib.SOURCE_REMOVE;
                    });
                    this.timers.add(timer);
                } else {
                    invocation.return_value(new GLib.Variant('()', []));
                }
            },
            (_conn, _sender, objectPath, interfaceName, property) =>
                this.objects[objectPath]?.[interfaceName]?.[property] ?? null,
            null);
        this.registrations.set(`${path}:${iface}`, id);
    }

    add(path, iface, props, signal = true) {
        this.objects[path] ??= {};
        this.objects[path][iface] = props;
        this._register(path, iface);
        if (signal) {
            this.conn.emit_signal(null, '/', OM, 'InterfacesAdded',
                new GLib.Variant('(oa{sa{sv}})', [path, {[iface]: props}]));
        }
    }

    remove(path, iface) {
        const key = `${path}:${iface}`;
        this.conn.unregister_object(this.registrations.get(key));
        this.registrations.delete(key);
        delete this.objects[path][iface];
        if (!Object.keys(this.objects[path]).length)
            delete this.objects[path];
        this.conn.emit_signal(null, '/', OM, 'InterfacesRemoved', new GLib.Variant('(oas)', [path, [iface]]));
    }

    change(path, iface, changes, invalidated = []) {
        Object.assign(this.objects[path][iface], changes);
        for (const name of invalidated)
            delete this.objects[path][iface][name];
        this.conn.emit_signal(null, path, PROPERTIES, 'PropertiesChanged',
            new GLib.Variant('(sa{sv}as)', [iface, changes, invalidated]));
    }

    acquire() {
        const [result] = busMethod(this.conn, 'RequestName', new GLib.Variant('(su)', [NAME, 4]));
        assert(result === 1, 'test service acquired private name');
    }

    release() {
        const [result] = busMethod(this.conn, 'ReleaseName', new GLib.Variant('(s)', [NAME]));
        assert(result === 1, 'test service released private name');
    }

    stop() {
        for (const timer of this.timers)
            GLib.source_remove(timer);
        this.timers.clear();
        for (const id of this.registrations.values())
            this.conn.unregister_object(id);
        this.registrations.clear();
    }
}

const deviceProps = address => ({
    Address: new GLib.Variant('s', address),
    Alias: new GLib.Variant('s', 'Test headphones'),
    Connected: new GLib.Variant('b', true),
    UUIDs: new GLib.Variant('as', ['0000110b-0000-1000-8000-00805f9b34fb']),
});

async function run() {
    const serviceConnection = connection();
    const clientConnection = connection();
    const service = new FakeBlueZ(serviceConnection);
    const updates = [];
    const availability = [];
    const logs = [];
    const monitor = new BlueZMonitor({
        connection: clientConnection,
        busName: NAME,
        onUpdate: (path, interfaces, event) => updates.push({path, interfaces, event}),
        onAvailability: value => availability.push(value),
        log: message => logs.push(message),
    });
    try {
        service.add(PATH, DEVICE, deviceProps('AA:BB:CC:DD:EE:FF'), false);
        service.add(PATH, BATTERY, {Percentage: new GLib.Variant('y', 57)}, false);
        service.add(CHAR, GATT, {UUID: new GLib.Variant('s', '00002a19-0000-1000-8000-00805f9b34fb')}, false);

        // A missing bluetoothd is a normal condition, not an extension failure.
        assert(await monitor.start(), 'manager starts when service is absent');
        equal(availability, [false], 'initial absence reported once');
        equal(monitor.objects.size, 0, 'absent service has no objects');
        const ready1 = monitor.start();
        const ready2 = monitor.start();
        assert(ready1 === ready2, 'repeated start shares initialization Promise');

        service.acquire();
        await eventually(() => monitor.online && monitor.objects.has(PATH), 'service appears');
        const initial = monitor.objects.get(PATH);
        equal(initial[DEVICE].Address, 'AA:BB:CC:DD:EE:FF', 'Device1 properties unpacked');
        equal(initial[BATTERY].Percentage, 57, 'byte percentage unpacked as number');
        equal(initial[DEVICE].UUIDs, ['0000110b-0000-1000-8000-00805f9b34fb'], 'nested arrays unpacked');
        assert(updates.some(u => u.path === PATH && u.event.kind === 'initial'), 'initial event has actual device path');

        let baseline = updates.length;
        service.change(PATH, DEVICE, {Alias: new GLib.Variant('s', 'Renamed headphones')});
        await eventually(() => updates.length > baseline, 'alias PropertiesChanged');
        const aliasEvent = updates.at(-1);
        equal(aliasEvent.path, PATH, 'property callback path is not signal name or root');
        equal(aliasEvent.event.interfaceName, DEVICE, 'property callback has interface');
        equal(aliasEvent.event.changed, ['Alias'], 'precise freshness metadata excludes battery');
        equal(aliasEvent.interfaces[BATTERY].Percentage, 57, 'unrelated cached battery preserved');
        equal(aliasEvent.interfaces[DEVICE].Address, 'AA:BB:CC:DD:EE:FF', 'partial update retains device identity');

        baseline = updates.length;
        service.change(PATH, DEVICE, {Connected: new GLib.Variant('b', false)});
        await eventually(() => updates.length > baseline, 'disconnect PropertiesChanged');
        equal(monitor.objects.get(PATH)[DEVICE].Connected, false, 'disconnect state reaches cache');

        baseline = updates.length;
        service.change(PATH, BATTERY, {}, ['Percentage']);
        await eventually(() => updates.length > baseline, 'invalidated property');
        equal(updates.at(-1).event.invalidated, ['Percentage'], 'invalidated fields propagated');
        assert(!Object.hasOwn(monitor.objects.get(PATH)[BATTERY], 'Percentage'), 'invalidated value not retained');

        baseline = updates.length;
        service.remove(PATH, BATTERY);
        await eventually(() => updates.length > baseline, 'interface removal');
        equal(updates.at(-1).event.kind, 'interface-removed', 'interface-only removal recognized');
        assert(Boolean(monitor.objects.get(PATH)[DEVICE]), 'device survives Battery1 removal');
        assert(!monitor.objects.get(PATH)[BATTERY], 'removed interface absent from published snapshot');

        service.add(PATH, BATTERY, {Percentage: new GLib.Variant('y', 58)});
        await eventually(() => monitor.objects.get(PATH)?.[BATTERY]?.Percentage === 58, 'Battery1 reappears');
        assert(updates.some(u => u.path === PATH && u.event.kind === 'interface-added'), 'interface addition delivered');

        service.add(SECOND, DEVICE, deviceProps('AA:BB:CC:DD:EE:01'));
        await eventually(() => monitor.objects.has(SECOND), 'new object appears');
        service.remove(SECOND, DEVICE);
        await eventually(() => !monitor.objects.has(SECOND), 'object removed');
        assert(updates.some(u => u.path === SECOND && u.interfaces === null && u.event.kind === 'object-removed'),
            'object removal publishes null snapshot');

        const [level] = await monitor.call(CHAR, GATT, 'ReadValue', new GLib.Variant('(a{sv})', [{}]));
        equal(Array.from(level), [57], 'async GATT method returns unpacked byte tuple');

        // Daemon death cancels calls even if the old peer eventually replies.
        const pending = monitor.call(PATH, DEVICE, 'Delayed').then(
            () => ({resolved: true}), error => ({error}));
        await eventually(() => service.delayedCalls === 1, 'delayed request reached service');
        service.release();
        await eventually(() => !monitor.online, 'service loss observed');
        equal(monitor.objects.size, 0, 'service loss clears object registry');
        const canceledByOwner = await pending;
        assert(Boolean(canceledByOwner.error), 'owner loss cancels pending method');
        assert(canceledByOwner.error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED), 'owner cancellation has Gio canceled code');
        service.objects[PATH][BATTERY].Percentage = new GLib.Variant('y', 61);
        service.acquire();
        await eventually(() => monitor.online && monitor.objects.get(PATH)?.[BATTERY]?.Percentage === 61,
            'daemon restart reloads full state');

        const pendingStop = monitor.call(PATH, DEVICE, 'Delayed').then(
            () => ({resolved: true}), error => ({error}));
        await eventually(() => service.delayedCalls === 2, 'second delayed request reached service');
        monitor.stop();
        baseline = updates.length;
        const availabilityAfterStop = availability.length;
        service.change(PATH, BATTERY, {Percentage: new GLib.Variant('y', 62)});
        assert(Boolean((await pendingStop).error), 'stop cancels pending method');
        await delay(230);
        equal(updates.length, baseline, 'no update callbacks after stop');
        equal(availability.length, availabilityAfterStop, 'no availability callbacks after stop');
        assert(!clientConnection.is_closed(), 'monitor does not close shared bus');
        assert(busMethod(clientConnection, 'ListNames', null)[0].includes(NAME), 'shared bus still usable');
        equal(monitor.objects.size, 0, 'stop clears registry');

        for (let i = 0; i < 3; i++) {
            assert(await monitor.start(), `restart ${i} succeeds`);
            await eventually(() => monitor.objects.has(PATH), `restart ${i} receives objects`);
            baseline = updates.length;
            service.change(PATH, BATTERY, {Percentage: new GLib.Variant('y', 63 + i)});
            await eventually(() => updates.length > baseline, `restart ${i} receives one property event`);
            await delay(10);
            equal(updates.length - baseline, 1, `restart ${i} has no duplicate signal handlers`);
            monitor.stop();
        }

        const initializing = monitor.start();
        monitor.stop();
        baseline = updates.length;
        assert(!(await initializing), 'stop during init returns false');
        await delay(30);
        equal(updates.length, baseline, 'late initialization never recreates callbacks');

        // A new enable must not be undone by the previous enable's callback.
        const oldStart = monitor.start();
        monitor.stop();
        const newStart = monitor.start();
        assert(!(await oldStart), 'previous canceled start remains canceled');
        assert(await newStart, 'new start survives old initialization callback');
        await eventually(() => monitor.online && monitor.objects.has(PATH), 'interleaved restart is online');
        monitor.stop();

        // Consumers may disable the extension from an availability callback.
        let reentrant;
        let reentrantUpdates = 0;
        reentrant = new BlueZMonitor({
            connection: clientConnection,
            busName: NAME,
            onAvailability: online => {
                if (online)
                    reentrant.stop();
            },
            onUpdate: () => reentrantUpdates++,
            log: message => logs.push(message),
        });
        assert(!(await reentrant.start()), 'consumer teardown during initialization is safe');
        equal(reentrantUpdates, 0, 'no object callbacks after reentrant stop');
        assert(!clientConnection.is_closed(), 'reentrant stop leaves shared bus open');
        equal(logs, [], 'no runtime errors or consumer errors logged');
    } finally {
        monitor.stop();
        service.stop();
        serviceConnection.close_sync(null);
        clientConnection.close_sync(null);
    }
    print(`PASS BlueZ D-Bus integration: ${assertions} assertions`);
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
run().catch(error => {
    failed = true;
    printerr(error.stack ?? String(error));
}).finally(() => loop.quit());
loop.run();
if (failed)
    System.exit(1);
