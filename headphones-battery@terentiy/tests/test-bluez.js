// No Node-only imports: runnable with `gjs -m` as well as `node`.
import {
    normalizeMac, macFromPath, pathFromMac, normalizeUuid, uuidList,
    modelFromModalias, displayName, normalizeModel, isAirPods,
    looksLikeHeadphones, identifyDevice,
} from '../bluez.js';

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

const MAC = 'AA:BB:CC:DD:EE:FF';
const PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
test('MAC canonical form', () => equal(normalizeMac('aa:bb:cc:dd:ee:ff'), MAC));
for (const invalid of [null, undefined, 7, '', 'A:BB:CC:DD:EE:FF', 'AAA:BB:CC:DD:EE:FF',
    'AA:BB:CC:DD:EE:FF:00', 'AA:BB:CC:DD:EE', 'GG:BB:CC:DD:EE:FF',
    ' AA:BB:CC:DD:EE:FF', 'AA:BB:CC:DD:EE:FF\n', 'AA_BB_CC_DD_EE_FF']) {
    test(`reject MAC ${String(invalid)}`, () => equal(normalizeMac(invalid), null));
}
test('MAC from BlueZ device path', () => equal(macFromPath(PATH), MAC));
test('multiple adapters', () => equal(macFromPath('/org/bluez/hci12/dev_aa_bb_cc_dd_ee_ff'), MAC));
test('reject GATT child as device', () => equal(macFromPath(`${PATH}/service001`), null));
test('reject non-BlueZ path', () => equal(macFromPath('/other/dev_AA_BB_CC_DD_EE_FF'), null));
test('path from canonical identity', () => equal(pathFromMac(MAC, '/org/bluez/hci2'), '/org/bluez/hci2/dev_AA_BB_CC_DD_EE_FF'));
test('invalid path adapter rejected', () => equal(pathFromMac(MAC, '/org/bluez/hci0/other'), null));
test('invalid path MAC rejected', () => equal(pathFromMac('bad'), null));

const SINK = '0000110b-0000-1000-8000-00805f9b34fb';
test('UUID16 expansion', () => equal(normalizeUuid('110B'), SINK));
test('UUID32 expansion', () => equal(normalizeUuid('0000110b'), SINK));
test('UUID128 no separators', () => equal(normalizeUuid(SINK.replace(/-/g, '').toUpperCase()), SINK));
test('UUID128 case', () => equal(normalizeUuid(SINK.toUpperCase()), SINK));
test('UUID list deduplicates and rejects invalid', () => equal(uuidList(['110b', SINK, 'not-a-uuid', null]), [SINK]));
test('bad UUID list', () => equal(uuidList('110b'), []));
test('audio sink classified', () => equal(looksLikeHeadphones({UUIDs: ['110B']}), true));
test('audio source alone not classified', () => equal(looksLikeHeadphones({UUIDs: ['110A']}), false));
test('HSP headset classified', () => equal(looksLikeHeadphones({UUIDs: ['1108']}), true));
test('HFP handsfree classified', () => equal(looksLikeHeadphones({UUIDs: ['111E']}), true));
for (const minor of [1, 2, 6])
    test(`headset device class ${minor}`, () => equal(looksLikeHeadphones({Class: (4 << 8) | (minor << 2)}), true));
for (const minor of [4, 5])
    test(`portable/car class not headphones ${minor}`, () => equal(looksLikeHeadphones({Class: (4 << 8) | (minor << 2)}), false));
test('computer class excluded', () => equal(looksLikeHeadphones({Class: 0x0104}), false));
test('headphone icon classified', () => equal(looksLikeHeadphones({Icon: 'audio-headphones'}), true));
test('null props safe', () => equal(looksLikeHeadphones(null), false));

test('specific AirPods Pro before prefix', () => equal(normalizeModel('AirPods Pro (2nd generation)'), 'AirPods Pro'));
test('specific AirPods Max before prefix', () => equal(normalizeModel('AirPods Max'), 'AirPods Max'));
test('AirPods generic', () => equal(normalizeModel('AirPods (3rd generation)'), 'AirPods'));
test('renamed AirPods text hint', () => equal(normalizeModel("Terentiy's AirPods Pro"), 'AirPods Pro'));
test('names case-insensitive', () => equal(normalizeModel('airpods MAX USB-C'), 'AirPods Max'));
test('JBL model not renamed', () => equal(normalizeModel('JBL TUNE520BT'), 'JBL TUNE520BT'));
test('no accidental AirPodship match', () => equal(isAirPods('AirPodship'), false));
test('unknown alias retained', () => equal(normalizeModel('My headset'), 'My headset'));
test('verified USB-C product identity', () => equal(modelFromModalias('bluetooth:v004Cp2024d215C'), 'AirPods Pro'));
test('verified Pro2 product identity', () => equal(modelFromModalias('bluetooth:v004Cp2014d0001'), 'AirPods Pro'));
test('verified Max product identity', () => equal(modelFromModalias('bluetooth:v004Cp201Fd0001'), 'AirPods Max'));
test('unknown Apple product not inferred', () => equal(modelFromModalias('bluetooth:v004CpFFFFd0001'), null));
test('non-Apple vendor rejected', () => equal(modelFromModalias('bluetooth:v1234p2024d215C'), null));
test('USB vendor not confused with Bluetooth vendor', () => equal(modelFromModalias('usb:v004Cp2024d215C'), null));
test('model uses known identity despite arbitrary alias', () => equal(normalizeModel('Любимые наушники', 'bluetooth:v004Cp2024d215C'), 'AirPods Pro'));
test('aliases sanitized for one line', () => equal(displayName('  One\nTwo\u0000Three  '), 'One Two Three'));
test('aliases bounded', () => equal(displayName('x'.repeat(10000)).length, 120));

test('device identification preserves display alias', () => {
    const identity = identifyDevice({Address: MAC, Alias: 'Любимые наушники', Name: 'AirPods Pro',
        Modalias: 'bluetooth:v004Cp2024d215C', Connected: true, Paired: true, Trusted: true}, PATH);
    equal(identity.displayName, 'Любимые наушники');
    equal(identity.model, 'AirPods Pro');
    equal(identity.mac, MAC);
    equal(identity.connected, true);
    equal(identity.isAirPods, true);
    equal(identity.adapterPath, '/org/bluez/hci0');
});
test('path MAC fallback only if Address absent', () => equal(identifyDevice({}, PATH).mac, MAC));
test('bad Address does not silently use another identity', () => equal(identifyDevice({Address: 'bad'}, PATH), null));
test('Device1 Address resolution is authoritative', () => equal(identifyDevice({Address: '11:22:33:44:55:66'}, PATH).mac, '11:22:33:44:55:66'));
test('paired is not connected', () => equal(identifyDevice({Paired: true}, PATH).connected, false));
test('strict bool connected', () => equal(identifyDevice({Connected: 'yes'}, PATH).connected, false));
test('invalid Device1 path excluded', () => equal(identifyDevice({Address: MAC}, '/random'), null));

console.log(`bluez: ${passed} tests passed`);
