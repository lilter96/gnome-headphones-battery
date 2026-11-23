// Node 22.15+/24: node tests/test-extension.js
// Imports the ACTUAL extension.js, ui.js, pet.js and pure policy modules.
// GI/Shell actors and I/O adapters are mocked for orchestration tests only.
// Real GJS/D-Bus/native suites remain separate; this is not hardware validation.
import assert from 'node:assert/strict';
import {mock, flush, upowerDevice, UPower, MockStream} from './mocks/shell.js';

const {default: Extension} = await import('../extension.js');
const {DeviceCard} = await import('../ui.js');
const {BatteryState} = await import('../airpods.js');
const {DEVICE_IFACE: DEVICE, BATTERY_IFACE: BATTERY, BATTERY_SERVICE_UUID,
    GATT_CHAR_IFACE: GATT, LEVEL_UUID} = await import('../bluez.js');

const MAC = 'AA:BB:CC:DD:EE:FF';
const LE_MAC = 'AA:BB:CC:DD:EE:02';
const PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
const LE_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_02';
const CHAR = `${LE_PATH}/service001/char001`;
const SINK_UUID = '0000110b-0000-1000-8000-00805f9b34fb';

function deviceProps({model = 'AirPods Pro', connected = true} = {}) {
    return {
        Address: MAC, Name: model, Alias: model, Connected: connected,
        Paired: true, Trusted: true, ServicesResolved: true,
        UUIDs: [SINK_UUID], Adapter: '/org/bluez/hci0',
    };
}

function packet(readings, address = MAC) {
    const result = {
        version: 1, type: 'battery', address, source: 'aap',
        present: Object.keys(readings), updated_at: Math.floor(Date.now() / 1000),
        left: null, right: null, case: null,
        status: {left: null, right: null, case: null},
        charging: {left: null, right: null, case: null},
    };
    for (const [key, input] of Object.entries(readings)) {
        const reading = typeof input === 'number'
            ? {level: input, status: 'discharging'} : input;
        result[key] = reading.level;
        result.status[key] = reading.status;
        result.charging[key] = reading.status === 'charging' ? true
            : reading.status === 'discharging' ? false : null;
    }
    return result;
}

async function enabled() {
    const extension = new Extension();
    extension.enable();
    await flush();
    assert.equal(extension._ready, true, 'extension completed asynchronous initialization');
    return extension;
}

function appear(extension, props = deviceProps(), extra = []) {
    const bluez = extension._bluez;
    bluez.objects.set('/org/bluez/hci0', {'org.bluez.Adapter1': {Address: 'AA:00:00:00:00:01', Powered: true}});
    bluez.objects.set(PATH, {[DEVICE]: props});
    for (const [path, interfaces] of extra)
        bluez.objects.set(path, interfaces);
    bluez.availability(true);
    for (const [path, interfaces] of bluez.objects)
        bluez.options.onUpdate(path, interfaces, {kind: 'initial', changed: [], invalidated: []});
    return bluez;
}

function changeConnected(bluez, connected, path = PATH) {
    const interfaces = bluez.objects.get(path);
    bluez.update(path, {...interfaces, [DEVICE]: {...interfaces[DEVICE], Connected: connected}}, {
        kind: 'properties', interfaceName: DEVICE, changed: ['Connected'], invalidated: [],
    });
}

function clean() {
    assert.deepEqual(mock.resources(), {
        signals: 0, timers: 0, panels: 0, login: 0, playingTimelines: 0,
        liveActors: 0, liveSessions: 0, liveMonitors: 0,
    }, 'all owned signals/timers/actors/processes/monitors cleaned up');
}

const tests = [];
function test(name, run) { tests.push({name, run}); }

test('real DeviceCard updates L/R/case rows, unknown and genuine zero', async () => {
    const card = new DeviceCard('Test AirPods');
    try {
        card.update({battery: {overall: null, components: {left: null, right: null, case: null}}});
        assert.equal(card._pct.text, '—');
        assert.equal(card._components.visible, false);
        assert.equal(card.pet.state.batteryKnown, false);
        const state = new BatteryState(MAC);
        state.updateAap(packet({left: 57, right: 93, case: {level: null, status: 'disconnected'}}), mock.now);
        card.update({battery: state.select(mock.now), est: null, playing: true, volume: 0.5});
        assert.equal(card._pct.text, '57%');
        assert.equal(card._compRows.left.value.text, '57%');
        assert.equal(card._compRows.right.value.text, '93%');
        assert.equal(card._compRows.case.value.text, '—');
        assert.equal(card._compRows.case.sub.text, 'Недоступно');
        assert.equal(card._rows.music.value.text, '—');
        assert.equal(card.pet.state.playing, true);
        state.updateAap(packet({left: 0}), mock.now + 1);
        card.update({battery: state.select(mock.now + 1)});
        assert.equal(card._pct.text, '0%');
        assert.equal(card._status.text, 'Разряжены');
        state.setSourceAvailable('aap', false);
        card.update({battery: state.select(mock.now + 1)});
        assert.equal(card._pct.text, '—');
        assert.equal(card._compRows.left.value.text, '0%');
        assert.match(card._compRows.left.sub.text, /Устарело/);
        assert.equal(card.pet.state.batteryKnown, false);
    } finally {
        card.destroy();
    }
});

test('enable/disable before state loading finishes cannot resurrect actors or providers', async () => {
    let finish;
    mock.loadGate = new Promise(resolve => { finish = resolve; });
    const extension = new Extension();
    extension.enable();
    await flush();
    extension.disable();
    finish(null);
    await flush();
    assert.equal(mock.monitors.length, 0);
    assert.equal(mock.sessions.length, 0);
    assert.equal(extension._indicator, null);
});

test('late UPower initialization callback is ignored after disable', async () => {
    const extension = await enabled();
    extension.disable();
    const client = mock.completeUPower([upowerDevice({address: MAC})]);
    await flush();
    assert.equal(client._signals.size, 0);
    assert.equal(extension._audio.size, 0);
});

test('UPower first then BlueZ keeps one canonical entry and one AAP session', async () => {
    const extension = await enabled();
    try {
        const dev = upowerDevice({address: MAC});
        const client = mock.completeUPower([dev]);
        assert.equal(extension._audio.size, 1);
        const original = extension._audio.get(MAC);
        const bluez = appear(extension);
        assert.equal(extension._audio.size, 1);
        assert.equal(extension._audio.get(MAC), original);
        assert.equal(mock.sessions.length, 1);
        assert.equal(extension._indicator.menu.actor.children.length, 1);
        client.emit('device-removed', dev.get_object_path());
        assert.equal(extension._audio.get(MAC), original, 'UPower removal retains connected BlueZ');
        assert.equal(dev._signals.size, 0);
        changeConnected(bluez, false);
        assert.equal(extension._audio.size, 0);
        assert.equal(original.session, null);
    } finally { extension.disable(); }
});

test('BlueZ first then UPower remains deduplicated and disconnect beats lingering UPower', async () => {
    const extension = await enabled();
    try {
        const bluez = appear(extension);
        const original = extension._audio.get(MAC);
        const dev = upowerDevice({address: MAC.toLowerCase()});
        mock.completeUPower([dev]);
        assert.equal(extension._audio.size, 1);
        assert.equal(extension._audio.get(MAC), original);
        assert.equal(mock.sessions.length, 1);
        changeConnected(bluez, false);
        assert.equal(extension._audio.size, 0, 'Connected=false is authoritative');
        assert.equal(extension._indicator._shown, false);
        assert.equal(mock.sessions[0].stopRequested, true);
        changeConnected(bluez, true);
        assert.equal(extension._audio.size, 1);
        await flush();
        assert.equal(mock.sessions.length, 2);
    } finally { extension.disable(); }
});

test('connected AirPods without any battery are visible and do not manufacture an ETA', async () => {
    const extension = await enabled();
    try {
        appear(extension);
        const entry = extension._audio.get(MAC);
        assert.equal(extension._indicator._shown, true);
        assert.equal(extension._indicator.pct.text, '—');
        assert.equal(extension._indicator.time.text, '');
        assert.equal(entry.card._pct.text, '—');
        assert.equal(entry.card._rows.music.value.text, '—');
        assert.equal(entry.card.pet.state.batteryKnown, false);
    } finally { extension.disable(); }
});

test('AAP source reaches actual card and separate earbud estimators; case never drives ETA', async () => {
    const extension = await enabled();
    try {
        mock.mixer.sinks.push(new MockStream(MAC, {playing: true}));
        appear(extension);
        const entry = extension._audio.get(MAC);
        const session = entry.session;
        session.packet(packet({left: 57, right: 93, case: {level: null, status: 'disconnected'}}));
        session.status('live');
        assert.equal(extension._indicator.pct.text, '57%');
        assert.match(extension._indicator.time.text, /^~/);
        assert.equal(entry.card._compRows.right.value.text, '93%');
        assert.equal(entry.card._compRows.case.value.text, '—');
        assert.equal(entry.tracks.get(`${MAC}:left`).source, 'airpods');
        assert.equal(entry.tracks.get(`${MAC}:right`).source, 'airpods');
        assert.equal(entry.tracks.has(`${MAC}:case`), false);
        assert.equal(entry.card.pet.state.playing, true);

        mock.now++;
        session.packet(packet({left: {level: null, status: 'disconnected'}}));
        assert.equal(extension._indicator.pct.text, '93%');
        assert.equal(entry.card._compRows.left.value.text, '57%');
        assert.match(entry.card._compRows.left.sub.text, /Последний заряд/);
        assert.equal(entry.tracks.has(`${MAC}:left`), false);
        mock.now++;
        session.packet(packet({right: {level: null, status: 'disconnected'}, case: 40}));
        assert.equal(extension._indicator.pct.text, '—');
        assert.equal(extension._indicator.time.text, '');
        assert.equal(entry.card._compRows.case.value.text, '40%');
        assert.equal(entry.card._rows.music.value.text, '—');
        assert.equal(entry.tracks.size, 0);
    } finally { extension.disable(); }
});

test('old AAP callbacks cannot mutate a reconnect-created entry', async () => {
    const extension = await enabled();
    try {
        const bluez = appear(extension);
        const old = extension._audio.get(MAC);
        const retiredSession = old.session;
        changeConnected(bluez, false);
        changeConnected(bluez, true);
        const current = extension._audio.get(MAC);
        assert.notEqual(current, old);
        retiredSession.packet(packet({left: 99, right: 100}));
        retiredSession.status('permission');
        assert.equal(current.battery.select(mock.now).overall, null);
        assert.notEqual(current.diagnostic, 'Система запретила AAP-соединение. Проверьте scripts/doctor.sh; не выдавайте права вслепую.');
        await flush();
        current.session.packet(packet({left: 24, right: 60}));
        assert.equal(extension._indicator.pct.text, '24%');
    } finally { extension.disable(); }
});

test('_refresh is rendering/learning only, no Bluetooth calls or process launches', async () => {
    const extension = await enabled();
    try {
        const bluez = appear(extension);
        const sessionCount = mock.sessions.length;
        const calls = bluez.calls.length;
        const saves = mock.stores[0].saves.length;
        for (let i = 0; i < 20; i++)
            extension._refresh();
        assert.equal(mock.sessions.length, sessionCount);
        assert.equal(bluez.calls.length, calls);
        assert.equal(mock.stores[0].saves.length, saves);
    } finally { extension.disable(); }
});

function jbl(extension) {
    return appear(extension, deviceProps({model: 'JBL TUNE520BT'}), [
        [LE_PATH, {[DEVICE]: {Address: LE_MAC, Name: 'JBL TUNE520BT-LE', Alias: 'JBL TUNE520BT-LE',
            Connected: true, ServicesResolved: true, UUIDs: [BATTERY_SERVICE_UUID], Adapter: '/org/bluez/hci0'}}],
        [CHAR, {[GATT]: {UUID: LEVEL_UUID, Flags: ['read']}}],
    ]);
}

test('JBL BLE read works without UPower and a late read after main disconnect is ignored', async () => {
    const extension = await enabled();
    try {
        const bluez = jbl(extension);
        assert.equal(mock.sessions.length, 0);
        assert.equal(bluez.calls.length, 1);
        assert.equal(bluez.calls[0].args[0], CHAR);
        bluez.calls[0].resolve([new Uint8Array([13])]);
        await flush();
        assert.equal(extension._indicator.pct.text, '13%');
        const entry = extension._audio.get(MAC);
        assert.equal(entry.tracks.get(MAC).source, 'le');
        mock.now += 61;
        extension._tick();
        assert.equal(bluez.calls.length, 2);
        changeConnected(bluez, false);
        bluez.calls[1].resolve([new Uint8Array([12])]);
        await flush();
        assert.equal(extension._audio.size, 0);
        assert.equal(extension._indicator._shown, false);
    } finally { extension.disable(); }
});

test('late GATT completion after disable cannot touch destroyed card', async () => {
    const extension = await enabled();
    const bluez = jbl(extension);
    extension.disable();
    bluez.calls[0].resolve([new Uint8Array([80])]);
    await flush();
    assert.equal(extension._audio.size, 0);
    assert.equal(extension._indicator, null);
});

test('companion disconnect invalidates an in-flight GATT read', async () => {
    const extension = await enabled();
    try {
        const bluez = jbl(extension);
        changeConnected(bluez, false, LE_PATH);
        bluez.calls[0].resolve([new Uint8Array([80])]);
        await flush();
        const reading = extension._audio.get(MAC).battery.select(mock.now).overall;
        assert.ok(reading === null || reading.stale, 'disconnected companion cannot supply a fresh late measurement');
    } finally { extension.disable(); }
});

test('removed GATT characteristic invalidates an in-flight read', async () => {
    const extension = await enabled();
    try {
        const bluez = jbl(extension);
        bluez.update(CHAR, null, {kind: 'object-removed'});
        bluez.calls[0].resolve([new Uint8Array([80])]);
        await flush();
        const reading = extension._audio.get(MAC).battery.select(mock.now).overall;
        assert.ok(reading === null || reading.stale, 'removed characteristic cannot supply a fresh late measurement');
    } finally { extension.disable(); }
});

test('screen lock and suspend stop visuals/transport and resume creates one new session', async () => {
    const extension = await enabled();
    try {
        appear(extension);
        const entry = extension._audio.get(MAC);
        const first = entry.session;
        first.packet(packet({left: 57, right: 93}));
        mock.sessionMode.isLocked = true;
        mock.sessionMode.emit('updated');
        assert.equal(extension._indicator._shown, false);
        mock.sessionMode.isLocked = false;
        mock.sessionMode.emit('updated');
        assert.equal(extension._indicator._shown, true);
        mock.login.prepareForSleep(true);
        assert.equal(first.stopRequested, true);
        assert.equal(entry.session, null);
        assert.equal(extension._indicator.pct.text, '—');
        first.packet(packet({left: 100}));
        assert.equal(extension._indicator.pct.text, '—');
        mock.login.prepareForSleep(false);
        await flush();
        assert.equal(mock.sessions.length, 2);
        assert.notEqual(entry.session, first);
    } finally { extension.disable(); }
});

test('UPower notification is live evidence even when update_time is unavailable', async () => {
    const extension = await enabled();
    try {
        const dev = upowerDevice({address: MAC, model: 'JBL TUNE520BT', updateTime: 0});
        mock.completeUPower([dev]);
        dev.percentage = 50;
        dev.emit('notify', {name: 'percentage'});
        const reading = extension._audio.get(MAC).battery.select(mock.now).overall;
        assert.equal(reading?.stale, false, 'actual percentage signal should not remain an unknown-age initial cache');
    } finally { extension.disable(); }
});

for (const signal of ['percentage', 'update-time']) {
    test(`future-dated UPower cache remains stale until a genuine ${signal} event`, async () => {
        const extension = await enabled();
        try {
            const dev = upowerDevice({address: MAC, model: 'JBL TUNE520BT', percentage: 60,
                updateTime: Date.now() / 1000 + 3600});
            mock.completeUPower([dev]);
            const entry = extension._audio.get(MAC);
            const cached = entry.battery.select(mock.now);
            assert.equal(extension._indicator._shown, true, 'connected device remains visible');
            assert.equal(cached.overall.level, 60, 'historical percentage is retained');
            assert.equal(cached.overall.stale, true, 'future timestamp is not fresh evidence');
            assert.equal(cached.overall.ageSeconds, null, 'invalid wall timestamp has unknown age');
            assert.equal(cached.playback, null);
            assert.equal(entry.tracks.size, 0, 'untrusted cache never feeds an estimator');
            assert.equal(extension._indicator.pct.text, '—');
            assert.equal(extension._indicator.time.text, '');
            assert.equal(entry.card._pct.text, '—');
            assert.equal(entry.card._status.text, 'Данные о заряде устарели');
            assert.match(entry.card._note.text, /Последний заряд: 60%/);
            assert.equal(entry.card._rows.music.value.text, '—');
            assert.equal(entry.card.pet.state.batteryKnown, false);

            mock.now += 10;
            dev.model = 'JBL TUNE520BT renamed';
            dev.emit('notify', {name: 'model'});
            dev.emit('notify', {name: 'state'});
            const afterMetadata = entry.battery.select(mock.now).overall;
            assert.equal(afterMetadata.stale, true, 'metadata/status cannot legitimize future cache');
            assert.equal(afterMetadata.receivedAt, cached.overall.receivedAt);
            assert.equal(entry.tracks.size, 0);
            assert.equal(entry.card._rows.music.value.text, '—');

            mock.now += 5;
            if (signal === 'percentage')
                dev.percentage = 50;
            else
                dev.update_time += 1; // Still invalid as a wall time; the received event is evidence.
            dev.emit('notify', {name: signal});
            const fresh = entry.battery.select(mock.now);
            assert.equal(fresh.overall.level, dev.percentage);
            assert.equal(fresh.overall.stale, false, 'actual measurement event uses local receipt time');
            assert.equal(fresh.overall.receivedAt, mock.now);
            assert.equal(fresh.overall.ageSeconds, 0);
            assert.ok(fresh.playback);
            assert.equal(entry.tracks.get(MAC).source, 'hfp');
            assert.notEqual(extension._indicator.pct.text, '—');
            assert.match(extension._indicator.time.text, /^~/);
            assert.match(entry.card._rows.music.value.text, /^~/);
            assert.equal(entry.card.pet.state.batteryKnown, true);
        } finally { extension.disable(); }
    });
}

test('UI card name tracks BlueZ Alias changes', async () => {
    const extension = await enabled();
    try {
        const bluez = appear(extension);
        const interfaces = bluez.objects.get(PATH);
        bluez.update(PATH, {...interfaces, [DEVICE]: {...interfaces[DEVICE], Alias: 'Мои AirPods'}}, {
            kind: 'properties', interfaceName: DEVICE, changed: ['Alias'], invalidated: [],
        });
        const entry = extension._audio.get(MAC);
        assert.equal(entry.card._name.text, entry.displayName);
    } finally { extension.disable(); }
});

test('AAP reconnect waits for retired process exit, including disable/re-enable', async () => {
    const extension = await enabled();
    let release;
    try {
        let bluez = appear(extension);
        const old = extension._audio.get(MAC).session;
        old.stopPromise = new Promise(resolve => { release = resolve; });
        changeConnected(bluez, false);
        changeConnected(bluez, true);
        await flush();
        assert.equal(mock.sessions.length, 1, 'no overlap while old helper is alive');
        assert.equal(extension._audio.get(MAC).session, null);
        extension.disable();
        extension.enable();
        await flush();
        bluez = appear(extension);
        await flush();
        assert.equal(mock.sessions.length, 1, 'disable/enable preserves retirement fence');
        release();
        await flush();
        assert.equal(mock.sessions.length, 2, 'exactly one replacement after process is reaped');
        assert.equal(old.stopped, true);
        assert.ok(extension._audio.get(MAC).session);
        assert.equal(bluez.calls.length, 0);
    } finally {
        release?.();
        extension.disable();
        await flush();
    }
});

test('charging earbud and case do not determine active-earbud playback estimate', async () => {
    const extension = await enabled();
    try {
        appear(extension);
        const entry = extension._audio.get(MAC);
        entry.session.packet(packet({left: {level: 5, status: 'charging'}, right: 80, case: 100}));
        assert.equal(extension._indicator.pct.text, '80%');
        assert.equal(entry.card._compRows.left.value.text, '5%');
        assert.equal(entry.card._compRows.left.sub.text, 'Заряжается');
        assert.match(entry.card._rows.music.value.text, /^~/);
        entry.session.packet(packet({right: {level: 80, status: 'charging'}}));
        assert.equal(extension._indicator.pct.text, '5%');
        assert.equal(extension._indicator.time.text, '');
        assert.equal(entry.card._rows.music.value.text, '—');
    } finally { extension.disable(); }
});

test('Battery1 properties are overall not left; unrelated events do not refresh measurement', async () => {
    const extension = await enabled();
    try {
        const bluez = appear(extension, deviceProps({model: 'Other headphones'}));
        bluez.update(PATH, {...bluez.objects.get(PATH), [BATTERY]: {Percentage: 60}}, {
            kind: 'interface-added', interfaceName: BATTERY, changed: ['Percentage'], invalidated: [],
        });
        const entry = extension._audio.get(MAC);
        const original = entry.battery.select(mock.now);
        assert.equal(original.overall.level, 60);
        assert.equal(original.components.left, null);
        const timestamp = original.overall.receivedAt;
        mock.now += 15;
        bluez.update(PATH, {...bluez.objects.get(PATH), [DEVICE]: {...bluez.objects.get(PATH)[DEVICE], Alias: 'Other alias'}}, {
            kind: 'properties', interfaceName: DEVICE, changed: ['Alias'], invalidated: [],
        });
        assert.equal(entry.battery.select(mock.now).overall.receivedAt, timestamp);
        bluez.update(PATH, {[DEVICE]: bluez.objects.get(PATH)[DEVICE]}, {
            kind: 'interface-removed', interfaceName: BATTERY, changed: [], invalidated: [],
        });
        assert.equal(entry.battery.select(mock.now).overall, null);
    } finally { extension.disable(); }
});

test('invalid standard GATT percentage never reaches UI or estimator', async () => {
    const extension = await enabled();
    try {
        const bluez = jbl(extension);
        bluez.calls[0].resolve([new Uint8Array([255])]);
        await flush();
        const entry = extension._audio.get(MAC);
        assert.equal(entry.battery.select(mock.now).overall, null);
        assert.equal(entry.tracks.size, 0);
        assert.equal(extension._indicator.pct.text, '—');
    } finally { extension.disable(); }
});

const errors = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => errors.push(args.join(' '));
console.warn = (...args) => errors.push(args.join(' '));
let failures = 0;
try {
    for (const {name, run} of tests) {
        mock.reset();
        const beforeErrors = errors.length;
        try {
            await run();
            await flush();
            assert.deepEqual(errors.slice(beforeErrors), [], 'no swallowed runtime errors');
            clean();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures++;
            originalError(`FAIL ${name}\n${error.stack}`);
        }
    }
} finally {
    console.error = originalError;
    console.warn = originalWarn;
}
console.log(`Extension/UI orchestration: ${tests.length - failures}/${tests.length} scenarios passed (mock GI/Shell, real source modules)`);
if (failures)
    process.exitCode = 1;
