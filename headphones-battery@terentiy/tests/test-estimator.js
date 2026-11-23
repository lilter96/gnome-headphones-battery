// Pure JS: runnable by both `gjs -m tests/test-estimator.js` and Node ESM.
import {Estimator, TESTED_HOURS, formatDuration, interval, normalizeModelForPrior, prior} from '../estimator.js';

let passed = 0;
const failures = [];
function assert(value, message = 'assertion failed') {
    if (!value)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
function close(actual, expected, epsilon = 1e-9) {
    assert(Math.abs(actual - expected) <= epsilon, String(actual) + ' != ' + String(expected));
}
function test(name, run) {
    try {
        run();
        passed++;
    } catch (error) {
        failures.push(name + ': ' + error.message);
    }
}
function fresh(src = 'le', model = 'JBL TUNE520BT', level = 90, options) {
    const e = new Estimator(null);
    assert(e.attach('device', model, src, level, options));
    return e;
}
function drop(e, level, src = 'le', dt = 0.2, options) {
    e.account('device', dt, 'play', 0.125);
    return e.observe('device', e.state.devices.device.model, src, level, options);
}
function finiteEstimate(est) {
    assert(est !== null, 'expected estimate');
    for (const key of ['level', 'soc', 'hours', 'hoursMin', 'hoursMax', 'rate', 'standby'])
        assert(Number.isFinite(est[key]) && est[key] >= 0, 'invalid ' + key);
    assert(est.soc <= 100);
    assert(est.hoursMin <= est.hoursMax);
}

test('JBL baseline is unchanged', () => {
    equal(TESTED_HOURS['JBL TUNE520BT'], 60.6);
    close(prior('JBL TUNE520BT').theta[1], 0.92 * 100 / 60.6);
});
test('specific AirPods model normalization precedes generic family', () => {
    equal(normalizeModelForPrior('AirPods Pro (2nd generation)'), 'AirPods Pro');
    equal(normalizeModelForPrior('AirPods Pro 2 USB-C'), 'AirPods Pro');
    equal(normalizeModelForPrior('AirPods Max'), 'AirPods Max');
    equal(normalizeModelForPrior('AirPods (3rd generation)'), 'AirPods');
});
test('normalization handles names, spacing and case', () => {
    equal(normalizeModelForPrior("Terentiy’s AirPods Pro"), 'AirPods Pro');
    equal(normalizeModelForPrior('  AIRPODS MAX (USB-C)  '), 'AirPods Max');
    equal(normalizeModelForPrior('jbl tune 520bt-LE'), 'JBL TUNE520BT');
});
test('unknown and hostile model names get a finite generic prior', () => {
    for (const name of [null, undefined, {}, 'Other', '__proto__', 'constructor']) {
        assert(prior(name).theta.every(Number.isFinite));
        close(prior(name).theta[1], 0.92 * 100 / 30);
    }
});
test('better model identification repairs an untrained prior', () => {
    const e = fresh('airpods', 'Unknown earbuds', 80);
    e.attach('device', 'AirPods Pro (2nd generation)', 'airpods', 80);
    equal(e.state.devices.device.theta, prior('AirPods Pro').theta);
});
test('renaming a device never loses already learned calibration', () => {
    const e = fresh();
    drop(e, 89);
    drop(e, 88);
    const before = [...e.state.devices.device.theta];
    e.attach('device', 'My renamed JBL', 'le', 88);
    equal(e.state.devices.device.theta, before);
    equal(e.state.devices.device.n, 1);
});
test('HFP and LE intervals preserve JBL quantization', () => {
    equal(interval('hfp', 20), [11, 21]);
    equal(interval('hfp', 10), [1, 11]);
    equal(interval('le', 13), [13, 14]);
    equal(interval('le', 100), [100, 100]);
});
test('AAP uses integer granularity without assuming rounding direction', () => {
    equal(interval('airpods', 80), [79, 81]);
    equal(interval('airpods', 100), [99, 100]);
});
test('Battery1 is conservative unless precision was explicitly verified', () => {
    equal(interval('battery1', 80), [70, 90]);
    equal(interval('battery1', 80, 1), [79, 81]);
    equal(interval('battery1', 80, NaN), [70, 90]);
});
test('zero interval is exact for all supported sources', () => {
    for (const src of ['hfp', 'le', 'airpods', 'battery1'])
        equal(interval(src, 0), [0, 0]);
});
test('invalid intervals fail closed', () => {
    for (const level of [null, undefined, -1, 101, NaN, Infinity, '50', 50.5])
        equal(interval('airpods', level), null);
    for (const src of ['manufacturer', 'service-data', '__proto__', null])
        equal(interval(src, 50), null);
});
test('invalid attach cannot create a device or mutate estimator state', () => {
    const e = new Estimator(null);
    for (const level of [null, undefined, NaN, Infinity, -1, 101, '50', 50.5])
        equal(e.attach('bad', 'AirPods', 'airpods', level), false);
    equal(Object.keys(e.state.devices), []);
});
test('unsafe keys and unrecognized sources are rejected', () => {
    const e = new Estimator(null);
    for (const id of ['', '__proto__', 'prototype', 'constructor', null, {}])
        equal(e.attach(id, 'AirPods', 'airpods', 50), false);
    for (const src of ['manufacturer', 'toString', '__proto__', undefined])
        equal(e.attach('device', 'AirPods', src, 50), false);
    equal(Object.keys(e.state.devices), []);
});
test('no reading means no invented estimate', () => {
    const e = new Estimator(null);
    equal(e.estimate('device', 'airpods'), null);
    e.account('device', 1, 'play', 1);
    equal(Object.keys(e.state.devices), []);
});
test('valid source attaches and produces finite estimates', () => {
    for (const src of ['hfp', 'le', 'airpods', 'battery1'])
        finiteEstimate(fresh(src).estimate('device', src, {playing: true, u: 0.125}));
});
test('zero battery means zero time, not a nonzero SOC floor', () => {
    for (const src of ['hfp', 'le', 'airpods', 'battery1']) {
        const est = fresh(src, 'AirPods Pro', 0).estimate('device', src);
        equal([est.soc, est.hours, est.hoursMin, est.hoursMax, est.standby], [0, 0, 0, 0, 0]);
    }
});
test('formatDuration zero and unavailable values are honest', () => {
    equal(formatDuration(0), '0 мин');
    equal(formatDuration(0, true), '0м');
    for (const value of [undefined, null, NaN, Infinity, -0.01, '2'])
        equal(formatDuration(value), '—');
});
test('normal duration rendering remains Russian and stable', () => {
    equal(formatDuration(1.5), '1 ч 30 мин');
    equal(formatDuration(1.5, true), '1ч30м');
    equal(formatDuration(10.4), '10 ч');
    equal(formatDuration(0.5), '30 мин');
});
test('first observed drop only establishes a complete interval boundary', () => {
    const e = fresh();
    equal(drop(e, 89), null);
    equal(e.state.devices.device.n, 0);
    assert(drop(e, 88) !== null);
    equal(e.state.devices.device.n, 1);
});
test('unchanged readings do not train or reset accumulated time', () => {
    const e = fresh();
    drop(e, 89);
    e.account('device', 0.2, 'play', 0.125);
    equal(e.observe('device', 'JBL TUNE520BT', 'le', 89), null);
    equal(e.state.devices.device.segs.le.tPlay, 0.2);
    assert(e.observe('device', 'JBL TUNE520BT', 'le', 88) !== null);
});
test('small voltage rebound is not fake drain', () => {
    const e = fresh('airpods', 'AirPods Pro', 93);
    e.observe('device', 'AirPods Pro', 'airpods', 94);
    equal(e.state.devices.device.read.airpods, 93);
    equal(e.observe('device', 'AirPods Pro', 'airpods', 93), null);
    equal(e.state.devices.device.n, 0);
});
test('a large rise resets segment without discarding learned calibration', () => {
    const e = fresh();
    drop(e, 89);
    drop(e, 88);
    const theta = [...e.state.devices.device.theta];
    equal(e.observe('device', 'JBL TUNE520BT', 'le', 100), null);
    equal(e.state.devices.device.theta, theta);
    equal(e.state.devices.device.read.le, 100);
    equal(e.state.devices.device.segs.le.exact, false);
    equal(e.state.devices.device.n, 1);
});
test('explicit charging never trains or estimates playback', () => {
    const e = fresh('airpods', 'AirPods Pro', 57, {charging: true});
    e.account('device', 1, 'play', 0.5);
    equal(e.estimate('device', 'airpods'), null);
    equal(e.observe('device', 'AirPods Pro', 'airpods', 56, {charging: true}), null);
    equal(e.state.devices.device.n, 0);
    equal(e.state.devices.device.segs.airpods.tPlay, 0);
});
test('end of charging requires a fresh full discharge interval', () => {
    const e = fresh('airpods', 'AirPods Pro', 57, {charging: true});
    e.observe('device', 'AirPods Pro', 'airpods', 60, {charging: false});
    finiteEstimate(e.estimate('device', 'airpods'));
    equal(drop(e, 59, 'airpods'), null);
    assert(drop(e, 58, 'airpods') !== null);
});
test('charging transition invalidates other sources too', () => {
    const e = fresh('hfp');
    e.attach('device', 'JBL TUNE520BT', 'le', 89);
    e.observe('device', 'JBL TUNE520BT', 'le', 90, {charging: true});
    equal(e.state.devices.device.segs.hfp.active, false);
    e.attach('device', 'JBL TUNE520BT', 'hfp', 90);
    equal(e.estimate('device', 'hfp'), null);
});
test('detach removes stale readings from estimates and accounting', () => {
    const e = fresh();
    drop(e, 89);
    drop(e, 88);
    e.detach('device', 'le');
    equal(e.estimate('device', 'le'), null);
    e.account('device', 1, 'play', 1);
    equal(e.state.devices.device.segs.le.tPlay, 0);
    equal(e.state.devices.device.n, 1);
});
test('same reading on reconnect does not preserve an old segment', () => {
    const e = fresh();
    drop(e, 89);
    e.account('device', 0.5, 'play', 0.125);
    e.attach('device', 'JBL TUNE520BT', 'le', 89);
    equal(e.state.devices.device.segs.le.tPlay, 0);
    equal(drop(e, 88), null);
    equal(e.state.devices.device.n, 0);
});
test('observe after detach rebases rather than learning across offline time', () => {
    const e = fresh();
    drop(e, 89);
    e.detach('device');
    equal(e.observe('device', 'JBL TUNE520BT', 'le', 70), null);
    equal(e.state.devices.device.segs.le.exact, false);
    equal(e.state.devices.device.n, 0);
});
test('HFP remains learnable when no precise source covers its interval', () => {
    const e = fresh('hfp');
    equal(drop(e, 80, 'hfp', 4), null);
    assert(drop(e, 70, 'hfp', 4) !== null);
    equal(e.state.devices.device.n, 1);
});
test('HFP and LE overlapping streams cannot double count drain', () => {
    const e = fresh('hfp');
    drop(e, 80, 'hfp', 1);
    e.attach('device', 'JBL TUNE520BT', 'le', 79);
    drop(e, 78, 'le');
    assert(drop(e, 77, 'le') !== null);
    equal(drop(e, 70, 'hfp', 1), null);
    equal(e.state.devices.device.n, 1);
});
test('AAP also suppresses overlapping LE observations', () => {
    const e = fresh('le', 'AirPods Pro');
    drop(e, 89);
    e.attach('device', 'AirPods Pro', 'airpods', 89);
    drop(e, 88, 'airpods');
    assert(drop(e, 87, 'airpods') !== null);
    equal(drop(e, 87, 'le'), null);
    equal(e.state.devices.device.n, 1);
});
test('lower source can learn again after higher source detaches', () => {
    const e = fresh('hfp');
    e.attach('device', 'JBL TUNE520BT', 'le', 89);
    e.detach('device', 'le');
    equal(drop(e, 80, 'hfp', 1), null);
    assert(drop(e, 70, 'hfp', 4) !== null);
});
test('excessive unknown time discards learning sample', () => {
    const e = fresh();
    drop(e, 89);
    e.account('device', 0.5, 'unknown');
    equal(drop(e, 88), null);
    equal(e.state.devices.device.n, 0);
});
test('invalid time, mode and volume cannot poison state', () => {
    for (const [dt, mode, volume] of [[NaN, 'play', 1], [Infinity, 'play', 1],
        [-1, 'play', 1], [1000, 'play', 1], [1, 'garbage', 1], [1, 'play', NaN]]) {
        const e = fresh();
        drop(e, 89);
        e.account('device', dt, mode, volume);
        equal(drop(e, 88), null);
        finiteEstimate(e.estimate('device', 'le', {playing: true, u: NaN}));
        assert(!JSON.stringify(e.state).includes('null,"theta"'));
    }
});
test('volume is bounded to physical normalized range', () => {
    const e = fresh();
    e.account('device', 1, 'play', 100);
    equal(e.state.devices.device.segs.le.uInt, 1);
    e.account('device', 1, 'play', -100);
    equal(e.state.devices.device.segs.le.uInt, 1);
});
test('AirPods coefficients are not clipped to old long-runtime JBL maxima', () => {
    const e = fresh('airpods', 'AirPods Pro', 90);
    drop(e, 89, 'airpods');
    assert(drop(e, 79, 'airpods', 0.5) !== null);
    assert(e.state.devices.device.theta[1] > 10);
    assert(e.state.devices.device.theta[0] > 3);
    finiteEstimate(e.estimate('device', 'airpods', {playing: true, u: 0.125}));
});
test('per-component ids have independent calibration', () => {
    const e = new Estimator(null);
    e.attach('mac:left', 'AirPods Pro', 'airpods', 57);
    e.attach('mac:right', 'AirPods Pro', 'airpods', 93);
    const rightTheta = [...e.state.devices['mac:right'].theta];
    e.account('mac:left', 0.1, 'play', 0.125);
    e.observe('mac:left', 'AirPods Pro', 'airpods', 56);
    e.account('mac:left', 0.1, 'play', 0.125);
    e.observe('mac:left', 'AirPods Pro', 'airpods', 55);
    equal(e.state.devices['mac:left'].n, 1);
    equal(e.state.devices['mac:right'].n, 0);
    equal(e.state.devices['mac:right'].theta, rightTheta);
});
test('version2 persistence preserves valid JBL calibration, not live segments', () => {
    const e = fresh();
    drop(e, 89);
    drop(e, 88);
    e.state.companions['JBL TUNE520BT-LE'] = 'device';
    const saved = JSON.parse(JSON.stringify(e.state));
    const restored = new Estimator(saved);
    const before = e.state.devices.device;
    const after = restored.state.devices.device;
    equal(after.theta, before.theta);
    equal(after.P, before.P);
    equal(after.n, before.n);
    equal(after.uAvg, before.uAvg);
    equal(restored.state.companions['JBL TUNE520BT-LE'], 'device');
    equal(restored.state.version, 2);
    equal(restored.estimate('device', 'le'), null);
    restored.attach('device', 'JBL TUNE520BT', 'le', 88);
    finiteEstimate(restored.estimate('device', 'le'));
    equal(restored.state.devices.device.n, 1);
});
test('legacy state without active flag is still migrated safely', () => {
    const old = {version: 2, devices: {jbl: {model: 'JBL TUNE520BT', theta: [0.4, 1.5, 1],
        P: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], n: 20, uAvg: 0.125,
        read: {hfp: 80, le: 77}, segs: {le: {level: 77, exact: true, tPlay: 4}}}}};
    const e = new Estimator(old);
    equal(e.state.devices.jbl.n, 20);
    equal(e.state.devices.jbl.theta, [0.4, 1.5, 1]);
    equal(e.estimate('jbl', 'le'), null);
    e.attach('jbl', 'JBL TUNE520BT', 'le', 70);
    equal(e.state.devices.jbl.segs.le.tPlay, 0);
});
test('lowercase UPower MAC calibration migrates without losing learned data', () => {
    const lower = 'a0:b1:c2:d3:e4:f5';
    const upper = 'A0:B1:C2:D3:E4:F5';
    const legacy = {model: 'JBL TUNE520BT', theta: [0.4, 1.5, 1],
        P: [[1, 0, 0], [0, 2, 0], [0, 0, 3]], n: 25, uAvg: 0.2,
        read: {le: 77}, segs: {le: {level: 77, exact: true, active: true, tPlay: 3}}};
    const e = new Estimator({version: 2, devices: {[lower]: legacy},
        companions: {'JBL TUNE520BT-LE': lower}});
    equal(e.state.devices[lower], undefined);
    equal(e.state.devices[upper].theta, legacy.theta);
    equal(e.state.devices[upper].P, legacy.P);
    equal(e.state.devices[upper].n, 25);
    equal(e.state.devices[upper].uAvg, 0.2);
    equal(e.state.companions['JBL TUNE520BT-LE'], upper);
    equal(e.estimate(upper, 'le'), null);
    e.attach(upper, 'JBL TUNE520BT', 'le', 77);
    equal(e.state.devices[upper].theta, legacy.theta);
    equal(e.state.devices[upper].n, 25);
    equal(e.state.devices[upper].segs.le.exact, false);
});
test('MAC case collision preserves both records without merging calibration', () => {
    const lower = 'a0:b1:c2:d3:e4:f5';
    const upper = 'A0:B1:C2:D3:E4:F5';
    const e = new Estimator({version: 2, devices: {
        [lower]: {model: 'JBL TUNE520BT', theta: [0.4, 1.5, 1], n: 25, read: {le: 70}},
        [upper]: {model: 'JBL TUNE520BT', theta: [0.5, 1.6, 1.2], n: 40, read: {le: 77}},
    }, companions: {'legacy companion': lower, 'canonical companion': upper}});
    equal(e.state.devices[lower].n, 25);
    equal(e.state.devices[upper].n, 40);
    equal(e.state.devices[lower].theta, [0.4, 1.5, 1]);
    equal(e.state.devices[upper].theta, [0.5, 1.6, 1.2]);
    equal(e.state.companions['legacy companion'], lower);
    equal(e.state.companions['canonical companion'], upper);
    equal(e.estimate(lower, 'le'), null);
    equal(e.estimate(upper, 'le'), null);
});
test('untrained canonical collision is not silently overwritten by a legacy record', () => {
    const lower = 'a0:b1:c2:d3:e4:f5';
    const upper = 'A0:B1:C2:D3:E4:F5';
    const e = new Estimator({version: 2, devices: {
        [lower]: {model: 'JBL TUNE520BT', n: 25},
        [upper]: {model: 'JBL TUNE520BT', n: 0},
    }});
    equal(e.state.devices[lower].n, 25);
    equal(e.state.devices[upper].n, 0);
});
test('component MAC migration preserves left/right separation and freshness', () => {
    const e = new Estimator({version: 2, devices: {
        'a0:b1:c2:d3:e4:f5:left': {model: 'AirPods Pro', n: 3, read: {airpods: 57}},
        'a0:b1:c2:d3:e4:f5:right': {model: 'AirPods Pro', n: 5, read: {airpods: 93}},
    }});
    equal(e.state.devices['A0:B1:C2:D3:E4:F5:left'].n, 3);
    equal(e.state.devices['A0:B1:C2:D3:E4:F5:right'].n, 5);
    equal(e.state.devices['a0:b1:c2:d3:e4:f5:left'], undefined);
    equal(e.estimate('A0:B1:C2:D3:E4:F5:left', 'airpods'), null);
    equal(e.estimate('A0:B1:C2:D3:E4:F5:right', 'airpods'), null);
});
test('generic ids and strings containing a MAC are not normalized', () => {
    const ids = ['my headphones', '/org/bluez/hci0/dev_a0_b1_c2_d3_e4_f5',
        'prefix:a0:b1:c2:d3:e4:f5', 'a0:b1:c2:d3:e4:f5:custom', 'gg:b1:c2:d3:e4:f5'];
    const devices = Object.fromEntries(ids.map(id => [id, {model: 'JBL TUNE520BT', n: 4}]));
    const e = new Estimator({version: 2, devices});
    equal(Object.keys(e.state.devices), ids);
    for (const id of ids)
        equal(e.state.devices[id].n, 4);
});
test('constructor copies calibration rather than sharing mutable caller state', () => {
    const source = fresh().state;
    const e = new Estimator(source);
    e.state.devices.device.theta[0] = 999;
    assert(source.devices.device.theta[0] !== 999);
});
test('invalid versions and malformed objects are safe', () => {
    for (const state of [null, undefined, [], 3, 'x', {version: 1}, {version: 2, devices: []},
        {version: 2, devices: {bad: null}}]) {
        const e = new Estimator(state);
        equal(e.estimate('bad', 'le'), null);
        assert(e.attach('ok', 'JBL TUNE520BT', 'le', 50));
        finiteEstimate(e.estimate('ok', 'le'));
    }
});
test('corrupt coefficients and covariance are replaced, not rendered as NaN', () => {
    const bad = {version: 2, devices: {bad: {model: 'AirPods Pro',
        theta: [0, null, 'x'], P: [[1, 2, 0], [2, 1, 0], [0, 0, -1]],
        n: -1, uAvg: Infinity, read: {airpods: 50, le: 999}}}};
    const e = new Estimator(bad);
    equal(e.state.devices.bad.theta, prior('AirPods Pro').theta);
    equal(e.state.devices.bad.n, 0);
    equal(e.state.devices.bad.uAvg, null);
    e.attach('bad', 'AirPods Pro', 'airpods', 50);
    finiteEstimate(e.estimate('bad', 'airpods'));
});
test('malicious JSON keys cannot pollute any prototypes', () => {
    const bad = JSON.parse('{"version":2,"devices":{"__proto__":{"polluted":true},"constructor":{"polluted":true}},"companions":{"__proto__":"polluted","constructor":"polluted"}}');
    const e = new Estimator(bad);
    equal(Object.keys(e.state.devices), []);
    equal(Object.keys(e.state.companions), []);
    equal({}.polluted, undefined);
    equal(Object.getPrototypeOf(e.state.devices), null);
});
test('underflow-sized persisted rates cannot produce infinite forecasts', () => {
    const old = {version: 2, devices: {tiny: {model: 'JBL TUNE520BT', theta: [1e-320, 1e-320, 0]}}};
    const e = new Estimator(old);
    e.attach('tiny', 'JBL TUNE520BT', 'le', 50);
    equal(e.state.devices.tiny.theta, prior('JBL TUNE520BT').theta);
    finiteEstimate(e.estimate('tiny', 'le'));
});
test('generic Battery1 precision changes start a new observation segment', () => {
    const e = fresh('battery1', 'JBL TUNE520BT', 80);
    e.observe('device', 'JBL TUNE520BT', 'battery1', 70);
    e.account('device', 1, 'play', 0.125);
    equal(e.observe('device', 'JBL TUNE520BT', 'battery1', 69, {resolution: 1}), null);
    equal(e.state.devices.device.segs.battery1.exact, false);
    equal(e.estimate('device', 'battery1').resolution, 1);
});
test('reset preserves latest real reading and restarts learning safely', () => {
    const e = fresh();
    drop(e, 89);
    drop(e, 88);
    e.account('device', 0.5, 'play', 0.125);
    e.reset('device');
    equal(e.state.devices.device.n, 0);
    equal(e.state.devices.device.read.le, 88);
    equal(e.state.devices.device.segs.le.tPlay, 0);
    equal(e.state.devices.device.segs.le.exact, false);
    finiteEstimate(e.estimate('device', 'le'));
});
test('long deterministic learning sequences remain finite and serializable', () => {
    for (const [src, model] of [['le', 'JBL TUNE520BT'], ['hfp', 'JBL TUNE520BT'],
        ['airpods', 'AirPods Pro'], ['battery1', 'Unknown headphones']]) {
        const e = fresh(src, model, 100);
        for (let cycle = 0; cycle < 5; cycle++) {
            e.attach('device', model, src, 100);
            for (let level = 99; level >= 0; level--) {
                e.account('device', 0.025 + (level % 4) * 0.005, 'play', (level % 10) / 10);
                e.observe('device', model, src, level);
                finiteEstimate(e.estimate('device', src, {playing: true, u: 0.125}));
            }
        }
        const restored = new Estimator(JSON.parse(JSON.stringify(e.state)));
        assert(restored.state.devices.device.n > 0);
        equal(restored.estimate('device', src), null);
    }
});

for (const failure of failures)
    console.error('FAIL estimator: ' + failure);
console.log('Estimator tests: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length)
    throw new Error(String(failures.length) + ' estimator test(s) failed');
