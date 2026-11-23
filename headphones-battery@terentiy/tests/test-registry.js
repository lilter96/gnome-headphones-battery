// Pure reconciliation tests; no Bluetooth hardware or GNOME Shell necessary.
import {planDevices, findBatteryTarget} from '../registry.js';

let passed = 0;
function test(name, action) {
    try {
        action();
        passed++;
    } catch (error) {
        throw new Error(`${name}: ${error.message}`);
    }
}
function equal(actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';
const MAC = 'AA:BB:CC:DD:EE:FF';
const OTHER = 'AA:BB:CC:DD:EE:00';
const LE = '11:22:33:44:55:66';
const UPATH = '/org/freedesktop/UPower/devices/headset_1';
const apath = (index = 0) => `/org/bluez/hci${index}`;
const dpath = (mac = MAC, index = 0) => `${apath(index)}/dev_${mac.replace(/:/g, '_')}`;
function adapter(index = 0, powered = true) {
    return [apath(index), {[ADAPTER]: {Address: `00:11:22:33:44:0${index}`, Powered: powered}}];
}
function device(mac = MAC, index = 0, overrides = {}) {
    return [dpath(mac, index), {[DEVICE]: {
        Address: mac, Adapter: apath(index), Name: 'JBL TUNE520BT', Alias: 'JBL TUNE520BT',
        UUIDs: ['110b'], Connected: true, Paired: true, ServicesResolved: true, ...overrides,
    }}];
}
function companion(mac = LE, index = 0, overrides = {}) {
    return device(mac, index, {Name: 'JBL TUNE520BT-LE', Alias: 'JBL TUNE520BT-LE',
        UUIDs: ['180f'], Connected: false, Paired: false, ServicesResolved: false, ...overrides});
}
function upower(overrides = {}) {
    return {path: UPATH, nativePath: dpath(), mac: MAC, id: MAC,
        model: 'JBL TUNE520BT', audio: true, isPresent: true, ...overrides};
}
function objects(...extra) {
    return new Map([adapter(), device(), ...extra]);
}

test('BlueZ discovery without UPower', () => {
    const plans = planDevices(objects(), [], true);
    equal(plans.size, 1);
    equal(plans.get(MAC).bluezPath, dpath());
    equal(plans.get(MAC).upowerPaths, []);
});
test('UPower arrives after BlueZ, one stable key', () => {
    equal([...planDevices(objects(), [], true).keys()], [MAC]);
    const plans = planDevices(objects(), [upower()], true);
    equal([...plans.keys()], [MAC]);
    equal(plans.get(MAC).upowerPaths, [UPATH]);
});
test('BlueZ arrives after UPower, one stable key', () => {
    const provisional = planDevices(new Map(), [upower()], null);
    equal([...provisional.keys()], [MAC]);
    const combined = planDevices(objects(), [upower()], true);
    equal([...combined.keys()], [MAC]);
    equal(combined.get(MAC).bluezPath, dpath());
});
test('UPower removal leaves connected BlueZ device', () => {
    equal(planDevices(objects(), [upower()], true).size, 1);
    equal(planDevices(objects(), [], true).size, 1);
});
test('BlueZ disconnect wins over delayed UPower removal', () => {
    equal(planDevices(objects(device(MAC, 0, {Connected: false})), [upower()], true).size, 0);
});
test('BlueZ object removed cannot be resurrected by its stale UPower object', () => {
    equal(planDevices(new Map([adapter()]), [upower()], true).size, 0);
});
test('BlueZ service loss hides Bluetooth-backed UPower device', () => {
    equal(planDevices(new Map(), [upower()], false).size, 0);
});
test('service loss defeats stale objects even without nativePath', () => {
    equal(planDevices(objects(), [upower({nativePath: ''})], false).size, 0);
});
test('adapter Powered=false wins over stale Connected=true', () => {
    equal(planDevices(objects(adapter(0, false)), [upower()], true).size, 0);
});
test('adapter removed wins over stale child Device1', () => {
    equal(planDevices(new Map([device()]), [upower()], true).size, 0);
});
test('initial snapshot waits for Adapter1', () => {
    const cache = new Map([device()]);
    equal(planDevices(cache, [], true).size, 0);
    const [path, value] = adapter();
    cache.set(path, value);
    equal(planDevices(cache, [], true).size, 1);
});
test('paired but not connected is not shown', () => {
    equal(planDevices(objects(device(MAC, 0, {Connected: false, Paired: true})), [], true).size, 0);
});
test('non-audio Bluetooth device not shown', () => {
    equal(planDevices(objects(device(MAC, 0, {UUIDs: ['1812'], Icon: 'input-keyboard'})), [], true).size, 0);
});
test('non-audio UPower battery not shown', () => {
    equal(planDevices(new Map(), [upower({audio: false})], null).size, 0);
});
test('absent UPower audio not shown', () => {
    equal(planDevices(new Map(), [upower({isPresent: false})], null).size, 0);
});
test('non-Bluetooth USB UPower audio remains supported', () => {
    const plans = planDevices(new Map(), [upower({mac: null, id: 'usb-headset', nativePath: '/sys/devices/usb/headset'})], false);
    equal(plans.size, 1);
    equal(plans.get('usb-headset').address, null);
    equal(plans.get('usb-headset').bluezPath, null);
});
test('MAC case normalization deduplicates', () => {
    equal(planDevices(objects(), [upower({mac: MAC.toLowerCase()})], true).size, 1);
});
test('duplicate UPower descriptors do not duplicate paths', () => {
    equal(planDevices(objects(), [upower(), upower()], true).get(MAC).upowerPaths, [UPATH]);
});
test('multiple audio devices remain separate', () => {
    equal(planDevices(objects(device(OTHER)), [], true).size, 2);
});
test('renamed AirPods uses Modalias, preserves alias label', () => {
    const plans = planDevices(objects(device(MAC, 0, {Name: 'Work audio', Alias: 'Любимые наушники',
        Modalias: 'bluetooth:v004Cp2024d215C'})), [], true);
    const plan = plans.get(MAC);
    equal(plan.airpods, true);
    equal(plan.model, 'AirPods Pro');
    equal(plan.displayName, 'Любимые наушники');
});
test('same MAC on multiple adapters is deterministic', () => {
    const cache = objects(adapter(1), device(MAC, 1));
    const reversed = new Map([...cache].reverse());
    equal(planDevices(cache, [], true).get(MAC).bluezPath, dpath());
    equal(planDevices(reversed, [], true).get(MAC).bluezPath, dpath());
    equal(planDevices(cache, [], true).size, 1);
});
test('powered adapter wins over unplugged previous adapter', () => {
    const plans = planDevices(objects(adapter(0, false), adapter(1), device(MAC, 1)), [upower()], true);
    equal(plans.size, 1);
    equal(plans.get(MAC).bluezPath, dpath(MAC, 1));
    equal(plans.get(MAC).adapterAddress, '00:11:22:33:44:01');
});
test('invalid Adapter property falls back to validated path adapter', () => {
    const plans = planDevices(objects(device(MAC, 0, {Adapter: 'not/an/adapter'})), [], true);
    equal(plans.get(MAC).adapterPath, apath(0));
});

test('direct standard battery source', () => {
    const cache = objects(device(MAC, 0, {UUIDs: ['110b', '180F']}));
    const plans = planDevices(cache, [], true);
    const target = findBatteryTarget(plans.get(MAC), cache, plans);
    equal(target.path, dpath());
    equal(target.companion, false);
});
test('JBL unpaired -LE companion found without UPower', () => {
    const cache = objects(companion());
    const plans = planDevices(cache, [], true);
    equal(plans.size, 1);
    const target = findBatteryTarget(plans.get(MAC), cache, plans);
    equal(target.path, dpath(LE));
    equal(target.companion, true);
});
test('JBL companion alternative space-LE suffix', () => {
    const cache = objects(companion(LE, 0, {Name: 'JBL TUNE520BT LE', Alias: ''}));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans).path, dpath(LE));
});
test('ambiguous same-model JBL pairs reject companion', () => {
    const cache = objects(device(OTHER), companion());
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('ambiguous companion addresses reject association', () => {
    const cache = objects(companion(), companion('11:22:33:44:55:77'));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('companion on a different adapter rejected', () => {
    const cache = objects(adapter(1), companion(LE, 1));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('not any prefix match, exact legacy companion suffix required', () => {
    const cache = objects(companion(LE, 0, {Name: 'JBL TUNE520BT stranger', Alias: ''}));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('battery service must be advertised, name alone not sufficient', () => {
    const cache = objects(companion(LE, 0, {UUIDs: []}));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('AirPods randomized advertising identity never linked by name', () => {
    const cache = objects(device(MAC, 0, {Name: 'AirPods Pro', Alias: 'AirPods Pro'}),
        companion(LE, 0, {Name: 'AirPods Pro-LE', Alias: 'AirPods Pro-LE'}));
    const plans = planDevices(cache, [], true);
    equal(findBatteryTarget(plans.get(MAC), cache, plans), null);
});
test('adapter loss invalidates previously selected BLE target', () => {
    const cache = objects(companion());
    const plans = planDevices(cache, [], true);
    const plan = plans.get(MAC);
    cache.set(apath(), {[ADAPTER]: {Address: '00:11:22:33:44:00', Powered: false}});
    equal(findBatteryTarget(plan, cache, plans), null);
});
test('UPower-only JBL cannot attach another devices companion', () => {
    const cache = new Map([adapter(), companion()]);
    const plans = planDevices(cache, [upower({nativePath: '', mac: null, id: 'usb-jbl'})], true);
    equal(findBatteryTarget(plans.get('usb-jbl'), cache, plans), null);
});

console.log(`registry: ${passed} tests passed`);
