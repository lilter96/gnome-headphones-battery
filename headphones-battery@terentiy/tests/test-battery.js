// Synthetic protocol fixtures, NOT claimed as hardware captures.
// No Node-only APIs: this suite also runs via `gjs -m`.
import {BatteryState, parseAapMessage, validPercentage, DEFAULT_TTLS} from '../airpods.js';

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
function ok(value) {
    if (!value)
        throw new Error('assertion failed');
}
const MAC = 'AA:BB:CC:DD:EE:FF';
function packet(values = {left: 57, right: 93}, statuses = {}) {
    const data = {version: 1, type: 'battery', address: MAC, source: 'aap', updated_at: 1793538071,
        left: null, right: null, case: null,
        charging: {left: null, right: null, case: null},
        status: {left: null, right: null, case: null}, present: Object.keys(values)};
    for (const [key, level] of Object.entries(values)) {
        data[key] = level;
        const status = statuses[key] ?? (level === null ? 'unknown' : 'discharging');
        data.status[key] = status;
        data.charging[key] = status === 'charging' ? true : status === 'discharging' ? false : null;
    }
    return data;
}

test('disconnect retains measured percentages as history without playback or refreshing age', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 50, right: 60, case: 70}), 10);
    state.updateAap(packet({left: null, right: null, case: null},
        {left: 'disconnected', right: 'disconnected', case: 'disconnected'}), 20);
    const view = state.select(25);
    equal(view.components.right.level, 60);
    equal(view.components.case.level, 70);
    equal(view.components.case.ageSeconds, 15);
    equal(view.components.case.historical, true);
    equal(view.components.right.eligibleForEstimate, false);
    equal(view.playback, null);
    equal(view.overall, null);
    const saved = state.snapshotHistory();
    const restored = new BatteryState(MAC);
    restored.restoreHistory(saved, 5, saved.case.updatedAt + 60);
    equal(restored.select(10).components.case.level, 70);
    equal(restored.select(10).components.case.ageSeconds, 65);
    equal(restored.select(10).playback, null);
    restored.updateAap(packet({case: 0}), 11);
    equal(restored.select(11).components.case.level, 0);
    equal(restored.select(11).components.case.stale, false);
});
test('history rejects invalid percentages and future timestamps', () => {
    const state = new BatteryState(MAC);
    state.restoreHistory({left: {level: 101, updatedAt: 10}, right: {level: 20, updatedAt: 100}}, 10, 50);
    equal(state.select(11).components, {left: null, right: null, case: null});
});
test('verified schema accepts JSON and canonical address', () => {
    const parsed = parseAapMessage(JSON.stringify(packet()), MAC.toLowerCase());
    equal(parsed.left, 57);
    equal(parsed.right, 93);
    equal(parsed.address, MAC);
});
test('schema clones input arrays and maps', () => {
    const data = packet();
    const parsed = parseAapMessage(data, MAC);
    data.present[0] = 'case';
    data.charging.left = true;
    equal(parsed.present, ['left', 'right']);
    equal(parsed.charging.left, false);
});
test('real reported zero is valid', () => equal(parseAapMessage(packet({left: 0}), MAC).left, 0));
test('unknown value is null', () => equal(parseAapMessage(packet({case: null}), MAC).case, null));
test('case disconnected is null', () => equal(parseAapMessage(packet({case: null}, {case: 'disconnected'}), MAC).status.case, 'disconnected'));
test('connected status may have unavailable level', () => equal(parseAapMessage(packet({left: null}, {left: 'discharging'}), MAC).left, null));
for (const input of ['', '{', 'x'.repeat(4097), 'null', '[]', '17'])
    test(`reject malformed JSON ${input.slice(0, 12)}`, () => equal(parseAapMessage(input, MAC), null));
test('wrong device rejected', () => equal(parseAapMessage(packet(), '11:22:33:44:55:66'), null));
test('no expected identity rejected', () => equal(parseAapMessage(packet()), null));
for (const [key, value] of [['version', 2], ['type', 'other'], ['source', 'manufacturer'],
    ['updated_at', -1], ['updated_at', Infinity], ['updated_at', 1.5], ['address', 'bad']]) {
    test(`invalid ${key}=${value}`, () => {
        const data = packet();
        data[key] = value;
        equal(parseAapMessage(data, MAC), null);
    });
}
for (const invalid of [-1, 101, NaN, Infinity, 12.3, '50', true, undefined]) {
    test(`invalid percent ${String(invalid)}`, () => {
        const data = packet();
        data.left = invalid;
        equal(parseAapMessage(data, MAC), null);
        equal(validPercentage(invalid), false);
    });
}
test('null status cannot carry known percentage', () => {
    const data = packet();
    data.status.left = null;
    equal(parseAapMessage(data, MAC), null);
});
test('unknown status cannot carry known percentage', () => equal(parseAapMessage(packet({left: 55}, {left: 'unknown'}), MAC), null));
test('disconnected zero rejected as contradictory', () => equal(parseAapMessage(packet({case: 0}, {case: 'disconnected'}), MAC), null));
test('unrecognized status rejected', () => equal(parseAapMessage(packet({left: 55}, {left: 'maybe'}), MAC), null));
test('charging flag must agree with status', () => {
    const data = packet();
    data.charging.left = true;
    equal(parseAapMessage(data, MAC), null);
});
for (const present of [[], ['left', 'left'], ['tail'], ['left', 'right', 'case', 'tail'], null]) {
    test(`bad present ${String(present)}`, () => {
        const data = packet();
        data.present = present;
        equal(parseAapMessage(data, MAC), null);
    });
}
test('omitted component cannot contain carried forward data', () => {
    const data = packet();
    data.present = ['right'];
    equal(parseAapMessage(data, MAC), null);
});

test('empty state is honestly unknown', () => {
    const result = new BatteryState(MAC).select(0);
    equal(result.overall, null);
    equal(result.playback, null);
    equal(result.components, {left: null, right: null, case: null});
});
test('non-Bluetooth UPower audio works without invented MAC', () => {
    const state = new BatteryState(null);
    equal(state.mac, null);
    equal(state.updateLevel('hfp', 75, 10), true);
    equal(state.select(11).overall.level, 75);
    equal(state.updateAap(packet(), 12), false);
    equal(state.select(12).components.left, null);
});
test('invalid nonnull identity still rejected', () => {
    let threw = false;
    try {
        new BatteryState('not-a-mac');
    } catch {
        threw = true;
    }
    ok(threw);
});
test('minimum active earbud selected', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 90, right: 17, case: 1}), 5);
    const result = state.select(6);
    equal(result.overall.level, 17);
    equal(result.overall.component, 'right');
    equal(result.playback.component, 'right');
    equal(result.eligibleForEstimate, true);
});
test('case never selected alone', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({case: 50}), 5);
    equal(state.select(5).overall, null);
    equal(state.select(5).components.case.level, 50);
});
test('charging bud does not drain playback estimate', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 5, right: 80}, {left: 'charging'}), 10);
    equal(state.select(11).overall.level, 80);
    equal(state.select(11).overall.component, 'right');
    equal(state.select(11).components.left.level, 5);
});
test('both charging shows charge without playback prediction', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 35, right: 80}, {left: 'charging', right: 'charging'}), 10);
    const view = state.select(11);
    equal(view.overall.level, 35);
    equal(view.overall.charging, true);
    equal(view.playback, null);
    equal(view.eligibleForEstimate, false);
});
test('disconnected left does not hide right', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: null, right: 35}, {left: 'disconnected'}), 20);
    equal(state.select(20).overall.component, 'right');
    equal(state.select(20).components.left.status, 'disconnected');
});
test('partial frame does not refresh other components', () => {
    const state = new BatteryState(MAC, {ttlSeconds: {aap: 20}});
    state.updateAap(packet({left: 50, right: 80, case: 60}), 10);
    state.updateAap(packet({right: 79}), 25);
    const view = state.select(35);
    equal(view.components.left.ageSeconds, 25);
    equal(view.components.case.ageSeconds, 25);
    equal(view.components.right.ageSeconds, 10);
    equal(view.components.left.stale, true);
    equal(view.components.right.stale, false);
    equal(view.overall.component, 'right');
});
test('timestamp is monotonic receipt, not helper wall-clock', () => {
    const state = new BatteryState(MAC);
    const data = packet();
    data.updated_at = 9999999999;
    state.updateAap(data, 50);
    equal(state.select(55).overall.ageSeconds, 5);
});
test('AAP transport liveness does not refresh measurement age', () => {
    const state = new BatteryState(MAC, {ttlSeconds: {aap: 10}});
    state.updateAap(packet(), 0);
    state.setSourceAvailable('aap', true);
    equal(state.select(11).overall.stale, true);
    equal(state.select(11).playback, null);
});
test('transport loss marks data stale immediately', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 5);
    state.setSourceAvailable('aap', false);
    equal(state.select(6).overall.stale, true);
    equal(state.select(6).components.left.stale, true);
});
test('latest packet revives only present components', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 5);
    state.setSourceAvailable('aap', false);
    state.updateAap(packet({right: 92}), 10);
    equal(state.select(11).components.left.stale, true);
    equal(state.select(11).components.right.stale, false);
});
test('invalid packet never mutates valid state', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 5);
    const before = state.select(6);
    equal(state.updateAap(packet({left: 101}), 6), false);
    equal(state.select(6), before);
});
test('out-of-order arrival ignored', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 50}), 10);
    equal(state.updateAap(packet({left: 90}), 9), false);
    equal(state.select(11).overall.level, 50);
});
test('negative/nonfinite monotonic clock rejected', () => {
    const state = new BatteryState(MAC);
    equal(state.updateAap(packet(), NaN), false);
    equal(state.updateAap(packet(), -1), false);
    equal(state.updateLevel('hfp', 80, Infinity), false);
    equal(state.select(2).overall, null);
});
test('clock reversal/invalidation marks data stale', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 10);
    equal(state.select(5).overall.stale, true);
    equal(state.select(NaN).overall.ageSeconds, null);
});

test('source priority AAP > LE > Battery1 > HFP', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 5);
    state.updateLevel('battery1', 65, 5);
    state.updateLevel('le', 62, 5);
    state.updateAap(packet({left: 55}), 5);
    equal(state.select(6).overall.source, 'aap');
    state.removeSource('aap');
    equal(state.select(6).overall.source, 'le');
    state.removeSource('le');
    equal(state.select(6).overall.source, 'battery1');
    state.removeSource('battery1');
    equal(state.select(6).overall.source, 'hfp');
});
test('fresh fallback beats stale higher-priority source', () => {
    const state = new BatteryState(MAC, {ttlSeconds: {aap: 10}});
    state.updateAap(packet(), 5);
    state.updateLevel('battery1', 55, 16);
    equal(state.select(17).overall.source, 'battery1');
    equal(state.select(17).components.left.stale, true);
});
test('fresh disconnected earbuds defeat older generic percentages', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 5);
    state.updateLevel('battery1', 68, 6);
    state.updateLevel('le', 67, 7);
    state.updateAap(packet({left: null, right: null}, {left: 'disconnected', right: 'disconnected'}), 10);
    equal(state.select(11).overall, null);
    equal(state.select(11).playback, null);
});
test('same-timestamp generic data cannot override explicit AAP disconnect', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 68, 10);
    state.updateAap(packet({left: null}, {left: 'disconnected'}), 10);
    equal(state.select(10).overall, null);
});
test('new actual standard measurement after disconnect may restore fallback', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 68, 5);
    state.updateAap(packet({left: null}, {left: 'disconnected'}), 10);
    equal(state.select(11).overall, null);
    state.updateLevel('battery1', 66, 12);
    equal(state.select(13).overall.level, 66);
    equal(state.select(13).playback.source, 'battery1');
});
test('AAP transport loss permits existing standard fallback', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 5);
    state.updateAap(packet({left: null}, {left: 'disconnected'}), 10);
    equal(state.select(11).overall, null);
    state.setSourceAvailable('aap', false);
    equal(state.select(12).overall.source, 'hfp');
});
test('expired AAP disconnect no longer suppresses current standard data', () => {
    const state = new BatteryState(MAC, {ttlSeconds: {aap: 10}});
    state.updateLevel('hfp', 70, 5);
    state.updateAap(packet({left: null}, {left: 'disconnected'}), 10);
    equal(state.select(11).overall, null);
    equal(state.select(21).overall.source, 'hfp');
});
test('case-only disconnected frame never suppresses standards', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 5);
    state.updateAap(packet({case: null}, {case: 'disconnected'}), 10);
    equal(state.select(11).overall.source, 'hfp');
});
test('unavailable level is not evidence that earbuds disconnected', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 5);
    state.updateAap(packet({left: null}, {left: 'unknown'}), 10);
    equal(state.select(11).overall.source, 'hfp');
});
test('a remaining fresh active bud stays usable after its peer disconnects', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet({left: 50, right: 80}), 5);
    state.updateLevel('hfp', 70, 6);
    state.updateAap(packet({left: null}, {left: 'disconnected'}), 10);
    equal(state.select(11).overall.component, 'right');
    equal(state.select(11).playback.level, 80);
});
test('Battery1 is overall, never invented left earbud', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 68, 10);
    equal(state.select(10).overall.component, null);
    equal(state.select(10).components.left, null);
    equal(state.select(10).overall.resolution, null);
});
test('zero standard battery is a real measurement', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('le', 0, 0);
    equal(state.select(0).overall.level, 0);
});
test('unknown and unsupported sources cannot provide readings', () => {
    const state = new BatteryState(MAC);
    equal(state.updateLevel('service-data', 50, 0), false);
    equal(state.updateLevel('aap', 50, 0), false);
    equal(state.updateLevel('hfp', NaN, 0), false);
    equal(state.select(0).overall, null);
});
test('unknown level explicitly removes a source', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('le', 50, 1);
    state.updateLevel('le', null, 2);
    equal(state.select(2).overall, null);
});
test('cached initial value is marked unknown-age/stale', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 60, 10, {cached: true});
    equal(state.select(11).overall.stale, true);
    equal(state.select(11).overall.ageSeconds, null);
    equal(state.select(11).playback, null);
});
test('re-reading DBus cache cannot refresh timestamp', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 60, 10);
    equal(state.updateLevel('battery1', 65, 20, {cached: true}), false);
    equal(state.select(21).overall.ageSeconds, 11);
    equal(state.select(21).overall.level, 60);
});
test('standard charging suppresses prediction', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 60, 10, {charging: true});
    equal(state.select(11).playback, null);
    equal(state.select(11).overall.charging, true);
});
test('HFP retains coarse source metadata and usable forecast', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 10);
    equal(state.select(11).overall.resolution, 10);
    equal(state.select(11).playback.source, 'hfp');
});
test('JBL coarse measurement not stale within five hours', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('hfp', 70, 0);
    equal(state.select(5 * 3600).overall.stale, false);
    equal(state.select(DEFAULT_TTLS.hfp + 1).overall.stale, true);
});
test('caller can conservatively disable generic estimation', () => {
    const state = new BatteryState(MAC);
    state.updateLevel('battery1', 70, 10, {eligibleForEstimate: false});
    equal(state.select(11).playback, null);
});
test('output mutation cannot mutate internal observations', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 0);
    state.select(0).components.left.level = 100;
    equal(state.select(0).components.left.level, 57);
});
test('clear removes observations, never persists stale battery', () => {
    const state = new BatteryState(MAC);
    state.updateAap(packet(), 0);
    state.updateLevel('hfp', 60, 0);
    state.clear();
    equal(state.select(1).overall, null);
    equal(state.select(1).components, {left: null, right: null, case: null});
});

// Deterministic malformed-input sweep: no environmental randomness or hardware.
test('all invalid byte percentages rejected', () => {
    for (let level = 101; level <= 255; level++)
        equal(parseAapMessage(packet({left: level}), MAC), null);
    for (let level = 0; level <= 100; level++)
        ok(parseAapMessage(packet({left: level}), MAC));
});

console.log(`battery: ${passed} tests passed`);
