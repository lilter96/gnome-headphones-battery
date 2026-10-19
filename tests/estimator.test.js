import {Estimator, TESTED_HOURS, formatDuration, interval, prior} from '../headphones-battery@terentiy/estimator.js';
import {assert, deepEqual, equal, near, test} from './harness.js';

const ID = '00:11:22:33:44:55';
const MODEL = 'JBL TUNE520BT';
const HALF_VOLUME = 0.5 ** 3;

// One exact LE segment: attach, then a first drop makes the next segment exact.
function exactLe(e, level = 50) {
    e.attach(ID, MODEL, 'le', level + 1);
    e.observe(ID, MODEL, 'le', level);
    return e;
}

test('prior reproduces independent run-time tests at half volume', () => {
    const {theta} = prior(MODEL);
    const rate = theta[1] + theta[2] * HALF_VOLUME;
    near(100 / rate, TESTED_HOURS[MODEL], 0.6, 'hours of playback');
});

test('unknown models fall back to a 30 h prior', () => {
    const {theta} = prior('Some Headset');
    near(100 / (theta[1] + theta[2] * HALF_VOLUME), 30, 0.3);
});

test('HFP level R means [R-10, R), LE level L means [L, L+1)', () => {
    deepEqual(interval('hfp', 20), [10, 20]);
    deepEqual(interval('hfp', 10), [0, 10]);
    deepEqual(interval('le', 13), [13, 14]);
    deepEqual(interval('le', 100), [100, 100]);
});

test('no estimate before a level is known', () => {
    const e = new Estimator();
    equal(e.estimate(ID, 'le', {playing: true, u: 0.5}), null);
});

test('a fresh HFP reading is taken from the middle of its 10% step', () => {
    const e = new Estimator();
    e.attach(ID, MODEL, 'hfp', 20);
    const est = e.estimate(ID, 'hfp', {playing: false, u: HALF_VOLUME});
    near(est.soc, 15, 1e-9);
    equal(est.lo, 10);
    equal(est.hi, 20);
});

test('a full battery lasts about the tested hours with the prior', () => {
    const e = new Estimator();
    e.attach(ID, MODEL, 'le', 100);
    const est = e.estimate(ID, 'le', {playing: true, u: HALF_VOLUME});
    near(est.hours, TESTED_HOURS[MODEL], 0.6);
});

test('the range always brackets the estimate', () => {
    const e = exactLe(new Estimator(), 37);
    e.account(ID, 0.3, 'play', 0.4);
    for (const playing of [true, false]) {
        const est = e.estimate(ID, 'le', {playing, u: 0.4});
        assert(est.hoursMin <= est.hours && est.hours <= est.hoursMax,
            `${est.hoursMin} <= ${est.hours} <= ${est.hoursMax}`);
        assert(est.soc >= est.lo && est.soc <= est.hi, `soc ${est.soc} in [${est.lo}, ${est.hi}]`);
    }
});

test('the charge counts down between drops', () => {
    const e = exactLe(new Estimator(), 40);
    const before = e.estimate(ID, 'le', {playing: true, u: HALF_VOLUME}).soc;
    e.account(ID, 0.25, 'play', HALF_VOLUME);
    const after = e.estimate(ID, 'le', {playing: true, u: HALF_VOLUME}).soc;
    assert(after < before, `${after} < ${before}`);
});

test('the first drop after connecting is not learned from', () => {
    const e = new Estimator();
    e.attach(ID, MODEL, 'le', 50);
    e.account(ID, 1, 'play', HALF_VOLUME);
    equal(e.observe(ID, MODEL, 'le', 49), null, 'partial segment');
    e.account(ID, 1, 'play', HALF_VOLUME);
    assert(e.observe(ID, MODEL, 'le', 48) !== null, 'full segment is a sample');
    equal(e.state.devices[ID].n, 1);
});

test('segments shorter than ~1 minute are ignored', () => {
    const e = exactLe(new Estimator());
    e.account(ID, 0.01, 'play', HALF_VOLUME);
    equal(e.observe(ID, MODEL, 'le', 49), null);
});

test('time used by another device invalidates the sample', () => {
    const e = exactLe(new Estimator());
    e.account(ID, 0.5, 'play', HALF_VOLUME);
    e.account(ID, 0.2, 'unknown');
    equal(e.observe(ID, MODEL, 'le', 49), null);
});

test('HFP steps are not learned from while the precise LE source is seen', () => {
    const e = new Estimator();
    e.attach(ID, MODEL, 'hfp', 50);
    e.observe(ID, MODEL, 'hfp', 40);          // HFP segment becomes exact
    e.attach(ID, MODEL, 'le', 39);
    e.account(ID, 3, 'play', HALF_VOLUME);
    equal(e.observe(ID, MODEL, 'hfp', 30), null, 'double counting');

    const solo = new Estimator();
    solo.attach(ID, MODEL, 'hfp', 50);
    solo.observe(ID, MODEL, 'hfp', 40);
    solo.account(ID, 3, 'play', HALF_VOLUME);
    assert(solo.observe(ID, MODEL, 'hfp', 30) !== null, 'HFP alone is learned from');
});

test('small rises are voltage rebound, big rises are charging', () => {
    const e = exactLe(new Estimator(), 40);
    e.observe(ID, MODEL, 'le', 41);
    equal(e.state.devices[ID].read.le, 40, 'rebound keeps the minimum');
    e.observe(ID, MODEL, 'le', 45);
    equal(e.state.devices[ID].read.le, 45, 'charging takes the new level');
    equal(e.state.devices[ID].segs.le.exact, false, 'and starts over');
});

test('learning recovers a simulated drain model', () => {
    // True drain in %/h: 0.5 idle, 1.8 playing, +0.9 at full volume.
    const truth = [0.5, 1.8, 0.9];
    const e = new Estimator();
    const dt = 1 / 60;
    let charge = 99.95;
    e.attach(ID, MODEL, 'le', Math.floor(charge));
    const plan = [['play', 0.05], ['idle', 0], ['play', 0.66], ['play', 0.3], ['idle', 0], ['play', 0.9]];
    for (let minute = 0; charge > 5; minute++) {
        const [mode, u] = plan[Math.floor(minute / 90) % plan.length];
        e.account(ID, dt, mode, u);
        charge -= dt * (mode === 'play' ? truth[1] + truth[2] * u : truth[0]);
        const level = Math.floor(charge);
        if (level < e.state.devices[ID].read.le)
            e.observe(ID, MODEL, 'le', level);
    }
    const d = e.state.devices[ID];
    assert(d.n > 50, `samples ${d.n}`);
    for (const u of [0.05, 0.3, 0.66]) {
        const rate = e.estimate(ID, 'le', {playing: true, u}).rate;
        const real = truth[1] + truth[2] * u;
        near(rate / real, 1, 0.05, `playing rate at u=${u}`);
    }
    near(d.theta[0] / truth[0], 1, 0.15, 'idle rate');
});

test('learned parameters stay within physical bounds', () => {
    const e = exactLe(new Estimator());
    e.account(ID, 0.03, 'play', 1);
    e.observe(ID, MODEL, 'le', 0);             // an absurd 50% drop in 2 minutes
    const [a, b, c] = e.state.devices[ID].theta;
    assert(a >= 0.05 && a <= 3 && b >= 0.3 && b <= 10 && c >= 0 && c <= 10, `${a}, ${b}, ${c}`);
});

test('forgetting never inflates uncertainty beyond the prior', () => {
    const e = exactLe(new Estimator(), 99);
    const {sd} = prior(MODEL);
    for (let level = 98; level > 0; level--) {
        e.account(ID, 0.6, 'play', HALF_VOLUME);   // constant volume never excites c
        e.observe(ID, MODEL, 'le', level);
    }
    const P = e.state.devices[ID].P;
    for (let i = 0; i < 3; i++)
        assert(P[i][i] <= sd[i] ** 2 * (1 + 1e-9), `P[${i}][${i}] ${P[i][i]} <= ${sd[i] ** 2}`);
});

test('reset returns to the prior', () => {
    const e = exactLe(new Estimator());
    e.account(ID, 2, 'play', HALF_VOLUME);
    e.observe(ID, MODEL, 'le', 45);
    e.reset(ID);
    const d = e.state.devices[ID];
    deepEqual(d.theta, prior(MODEL).theta);
    equal(d.n, 0);
});

test('state survives a JSON round trip; old formats are ignored', () => {
    const e = exactLe(new Estimator());
    e.account(ID, 1.5, 'play', 0.4);
    e.observe(ID, MODEL, 'le', 48);
    e.account(ID, 0.2, 'idle');
    const restored = new Estimator(JSON.parse(JSON.stringify(e.state)));
    deepEqual(restored.estimate(ID, 'le', {playing: true, u: 0.4}), e.estimate(ID, 'le', {playing: true, u: 0.4}));
    deepEqual(new Estimator({version: 1, devices: {[ID]: {}}}).state.devices, {});
});

test('durations read like a person would say them', () => {
    const cases = [
        [0.05, '5 мин', '5м'],
        [0.4, '25 мин', '25м'],
        [0.99, '1 ч', '1ч'],
        [2.5, '2 ч 30 мин', '2ч30м'],
        [5.83, '5 ч 50 мин', '5ч50м'],
        [9.97, '10 ч', '10ч'],
        [12.4, '12 ч', '12ч'],
    ];
    for (const [h, long, short] of cases) {
        equal(formatDuration(h), long, `${h} h`);
        equal(formatDuration(h, true), short, `${h} h short`);
    }
});
