import assert from 'node:assert/strict';
import test from 'node:test';
import {formatAge, formatLong, plural, presentDevice, sourceLabel} from '../presentation.js';

const reading = (level, more = {}) => ({
    level, source: 'aap', resolution: 1, stale: false, ageSeconds: 4,
    charging: false, status: 'discharging', eligibleForEstimate: true, ...more,
});
const estimate = (more = {}) => ({
    level: 57, soc: 56.5, lo: 57, hi: 58, hours: 2.5, hoursMin: 2,
    hoursMax: 3, standby: 12, rate: 20, uRef: 0.125, n: 2, ...more,
});
const info = (more = {}) => ({
    battery: {overall: reading(57), components: {left: reading(57), right: reading(93), case: null}},
    est: estimate(), playing: true, ...more,
});

test('absent battery renders dash, not a fabricated percentage or duration', () => {
    const result = presentDevice();
    assert.equal(result.pctText, '—');
    assert.equal(result.value, null);
    assert.equal(result.batteryKnown, false);
    assert.equal(result.hours, null);
    assert.equal(result.rows.music.value, '—');
    assert.equal(result.componentsVisible, false);
    assert.equal(result.status, 'Заряд неизвестен');
    assert.ok(!result.note.includes('undefined'));
});

test('precise measurement is not replaced by model SOC interpolation', () => {
    const result = presentDevice(info());
    assert.equal(result.pctText, '57%');
    assert.equal(result.hours, 2.5);
    assert.equal(result.status, 'Слушает музыку');
    assert.ok(result.rows.music.value.startsWith('~'));
    assert.ok(result.note.includes('AirPods AAP'));
    assert.equal(result.components[2].value, '—');
});

test('coarse HFP interpolation is labelled as an estimate with source precision', () => {
    const result = presentDevice(info({
        battery: {overall: reading(60, {source: 'hfp', resolution: 10}), components: {}},
    }));
    assert.equal(result.pctText, '≈57%');
    assert.ok(result.note.includes('10%'));
    assert.ok(result.note.includes('расчётная оценка'));
    assert.equal(result.componentsVisible, false);
});

test('coarse observation without a prediction retains reported level', () => {
    const result = presentDevice(info({
        battery: {overall: reading(60, {source: 'hfp', resolution: 10})}, est: null,
    }));
    assert.equal(result.pctText, '≈60%');
    assert.equal(result.rows.music.value, '—');
});

test('zero is a real measurement and distinct from null/disconnected', () => {
    const result = presentDevice(info({
        battery: {overall: reading(0), components: {
            left: reading(0), right: reading(null, {status: 'disconnected'}), case: reading(0),
        }}, est: estimate({soc: 0, hours: 0, hoursMin: 0, hoursMax: 0, standby: 0}),
    }));
    assert.equal(result.pctText, '0%');
    assert.equal(result.status, 'Разряжены');
    assert.equal(result.rows.music.value, '~0 мин');
    assert.equal(result.components[0].value, '0%');
    assert.equal(result.components[1].value, '—');
    assert.equal(result.components[1].sub, 'Недоступно');
    assert.equal(result.components[2].value, '0%');
});

test('case-only measurement never becomes earbud percentage or playback duration', () => {
    const result = presentDevice(info({
        battery: {overall: null, components: {case: reading(80)}},
    }));
    assert.equal(result.pctText, '—');
    assert.equal(result.estimateKnown, false);
    assert.equal(result.hours, null);
    assert.equal(result.status, 'Заряд наушников неизвестен');
    assert.equal(result.components[2].value, '80%');
});

test('stale measurements are historical only and cannot drive a prediction', () => {
    const old = reading(57, {stale: true, ageSeconds: 600});
    const result = presentDevice(info({battery: {overall: old, components: {left: old}}}));
    assert.equal(result.pctText, '—');
    assert.equal(result.estimateKnown, false);
    assert.equal(result.components[0].value, '57%');
    assert.ok(result.components[0].sub.includes('Устарело'));
    assert.ok(result.note.includes('Последний заряд: 57%'));
    assert.equal(result.ring.batteryKnown, false);
});

test('charging suppresses drain forecasts without suppressing the measurement', () => {
    const result = presentDevice(info({battery: {
        overall: reading(57, {charging: true, status: 'charging'}), components: {},
    }}));
    assert.equal(result.pctText, '57%');
    assert.equal(result.hours, null);
    assert.equal(result.status, 'Заряжаются');
    assert.ok(result.rows.music.sub.includes('зарядке'));
});

test('unknown charging status still displays measured percentage, not fake state', () => {
    const r = reading(48, {status: 'unknown', charging: null, eligibleForEstimate: false});
    const result = presentDevice(info({battery: {overall: r, components: {left: r}}}));
    assert.equal(result.pctText, '48%');
    assert.equal(result.hours, null);
    assert.equal(result.components[0].sub, 'Состояние зарядки неизвестно');
});

test('invalid and nonfinite inputs cannot leak NaN or undefined to UI', () => {
    for (const level of [NaN, Infinity, -1, 101, '50', undefined]) {
        const result = presentDevice(info({battery: {overall: reading(level), components: {left: reading(level)}}}));
        assert.equal(result.pctText, '—');
        assert.equal(result.hours, null);
        assert.equal(result.components[0].value, '—');
        assert.doesNotMatch(JSON.stringify(result), /NaN|undefined|Infinity/);
    }
    for (const key of ['soc', 'hours', 'hoursMin', 'hoursMax', 'standby', 'rate', 'uRef']) {
        const result = presentDevice(info({est: estimate({[key]: NaN})}));
        assert.equal(result.pctText, '57%');
        assert.equal(result.estimateKnown, false);
        assert.doesNotMatch(result.rows.music.value, /NaN/);
    }
});

test('forecast notes do not claim independently tested lifetime or fixed training time', () => {
    const result = presentDevice(info({est: estimate({n: 0})}));
    assert.ok(result.note.includes('стартовая оценка'));
    assert.ok(!result.note.includes('независимым тестам'));
    assert.ok(!result.note.includes('часа музыки'));
});

test('per-earbud forecast identifies the limiting component, never the case', () => {
    assert.ok(presentDevice(info({estimateComponent: 'left'})).note.includes('ограничен левым наушником'));
    assert.ok(presentDevice(info({estimateComponent: 'right'})).note.includes('ограничен правым наушником'));
    assert.ok(!presentDevice(info({estimateComponent: 'case'})).note.includes('Прогноз ограничен'));
    assert.ok(!presentDevice(info({estimateComponent: 'left', est: null})).note.includes('Прогноз ограничен'));
});

test('diagnostic text is bounded and safe as plain label text', () => {
    const result = presentDevice({diagnostic: 'x'.repeat(1000)});
    assert.ok(result.note.endsWith('x'.repeat(240)));
    assert.ok(result.note.length < 400);
});

test('age, duration and plural helpers handle boundaries and missing values', () => {
    assert.equal(formatAge(null), 'время неизвестно');
    assert.equal(formatAge(Infinity), 'время неизвестно');
    assert.equal(formatAge(-1), 'время неизвестно');
    assert.equal(formatAge(0), 'только что');
    assert.equal(formatAge(45), '45 с назад');
    assert.equal(formatAge(60), '1 мин назад');
    assert.equal(formatAge(3600), '1 ч назад');
    assert.equal(formatAge(86400 * 2), '2 дня назад');
    assert.equal(formatLong(null), '—');
    assert.equal(formatLong(0), '0 мин');
    assert.equal(formatLong(48), '2 дня');
    assert.equal(plural(11, 'а', 'б', 'в'), 'в');
    assert.equal(plural(21, 'а', 'б', 'в'), 'а');
    assert.equal(sourceLabel('not-a-provider'), 'Bluetooth');
    assert.equal(sourceLabel('__proto__'), 'Bluetooth');
    assert.equal(presentDevice(null).pctText, '—');
});


test('separate earbud forecasts use their own estimates and exclude case and stale readings', () => {
    const result = presentDevice(info({componentEstimates: {
        left: estimate({hours: 1}), right: estimate({hours: 3}), case: estimate({hours: 20}),
    }}));
    assert.equal(result.components[0].sub, 'Музыки ~1 ч');
    assert.equal(result.components[1].sub, 'Музыки ~3 ч');
    const old = presentDevice(info({battery: {overall: null, components: {
        case: reading(75, {historical: true, stale: true, ageSeconds: 120}),
    }}, componentEstimates: {case: estimate()}}));
    assert.equal(old.components[2].value, '75%');
    assert.equal(old.components[2].sub, 'Последний заряд · 2 мин назад');
    assert.equal(old.hours, null);
});

test('AirPods always show all three component rows before the first packet', () => {
    const result = presentDevice({airpods: true});
    assert.equal(result.componentsVisible, true);
    assert.equal(result.components.length, 3);
    assert.match(result.note, /откройте кейс/);
});
