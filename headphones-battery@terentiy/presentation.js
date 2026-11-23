// Pure presentation policy, shared by the Shell UI and deterministic tests.
// Percentages are observations (or explicitly marked interpolation), never a
// fabricated value used to keep the animation running.

import {formatDuration} from './estimator.js';

const COMPONENTS = [['left', 'Левый'], ['right', 'Правый'], ['case', 'Кейс']];
const finite = n => typeof n === 'number' && Number.isFinite(n);
const levelIsValid = n => finite(n) && n >= 0 && n <= 100;
const unavailable = r => !r || r.status === 'disconnected';

export function plural(n, one, few, many) {
    const d = n % 10;
    const h = n % 100;
    return d === 1 && h !== 11 ? one
        : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

export function formatAge(seconds) {
    if (!finite(seconds) || seconds < 0)
        return 'время неизвестно';
    if (seconds < 5)
        return 'только что';
    if (seconds < 60)
        return `${Math.floor(seconds)} с назад`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} мин назад`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)} ч назад`;
    const days = Math.floor(seconds / 86400);
    return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

export function formatLong(hours) {
    if (!finite(hours) || hours < 0)
        return '—';
    if (hours === 0)
        return '0 мин';
    if (hours >= 48) {
        const days = Math.round(hours / 24);
        return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
    }
    return formatDuration(hours);
}

export function sourceLabel(source) {
    switch (source) {
    case 'aap':
    case 'airpods': return 'AirPods AAP';
    case 'le':
    case 'gatt': return 'Bluetooth LE';
    case 'battery1':
    case 'bluez': return 'BlueZ Battery1';
    case 'hfp': return 'UPower / HFP';
    case 'upower': return 'UPower';
    default: return 'Bluetooth';
    }
}

function validEstimate(est) {
    if (!est || !levelIsValid(est.soc))
        return false;
    const nonnegative = ['hours', 'hoursMin', 'hoursMax', 'standby', 'rate', 'uRef'];
    return nonnegative.every(k => finite(est[k]) && est[k] >= 0) &&
        est.hoursMin <= est.hoursMax && est.uRef <= 1;
}

function componentView(key, label, reading, estimate) {
    const known = !unavailable(reading) && levelIsValid(reading?.level);
    const stale = known && reading.stale === true;
    let sub = 'Нет данных';
    if (reading?.status === 'disconnected')
        sub = 'Недоступно';
    else if (stale)
        sub = `${reading.historical ? 'Последний заряд' : 'Устарело'} · ${formatAge(reading.ageSeconds)}`;
    else if (known && reading.charging === true)
        sub = 'Заряжается';
    else if (known && reading.charging === false)
        sub = key !== 'case' && reading.eligibleForEstimate && validEstimate(estimate)
            ? `Музыки ~${formatLong(estimate.hours)}` : 'Не заряжается';
    else if (known)
        sub = 'Состояние зарядки неизвестно';
    const prefix = reading?.resolution > 1 ? '≈' : '';
    return {key, label, value: known ? `${prefix}${Math.round(reading.level)}%` : '—', sub, stale};
}

export function presentDevice(info = {}) {
    info ??= {};
    const overall = info.battery?.overall ?? null;
    const readings = info.battery?.components ?? {};
    const components = COMPONENTS.map(([key, label]) => componentView(key, label, readings[key], info.componentEstimates?.[key]));
    const componentsVisible = info.airpods === true || COMPONENTS.some(([key]) => readings[key] !== null && readings[key] !== undefined);
    const observed = !unavailable(overall) && levelIsValid(overall?.level);
    const stale = observed && overall.stale === true;
    const batteryKnown = observed && !stale;
    const charging = batteryKnown && overall.charging === true;
    const estimateKnown = batteryKnown && !charging && overall.eligibleForEstimate !== false && validEstimate(info.est);
    const est = estimateKnown ? info.est : null;
    const coarse = overall?.resolution > 1;
    const interpolated = batteryKnown && coarse && est !== null;
    const value = batteryKnown ? Math.round(interpolated ? est.soc : overall.level) : null;
    const prefix = batteryKnown && coarse ? '≈' : '';
    const pctText = value === null ? '—' : `${prefix}${value}%`;

    let status;
    if (stale)
        status = 'Данные о заряде устарели';
    else if (!batteryKnown)
        status = componentsVisible ? 'Заряд наушников неизвестен' : 'Заряд неизвестен';
    else if (charging)
        status = 'Заряжаются';
    else if (overall.level === 0)
        status = 'Разряжены';
    else if (est && est.hours < 1 / 3)
        status = 'Почти разряжены';
    else if (est && est.hours < 1)
        status = 'Пора на зарядку';
    else if (info.playing)
        status = 'Слушает музыку';
    else if (info.sleeping)
        status = 'Дремлет';
    else
        status = 'Ждёт музыку';

    const rows = {
        music: {value: '—', sub: charging ? 'прогноз на зарядке недоступен' : 'нет актуального прогноза'},
        quiet: {value: '—', sub: 'подключены, звука нет'},
        rate: {value: '—', sub: 'нет актуального прогноза'},
    };
    if (est) {
        rows.music = {
            value: `~${formatLong(est.hours)}`,
            sub: `от ${formatLong(est.hoursMin)} до ${formatLong(est.hoursMax)}`,
        };
        rows.quiet.value = `~${formatLong(est.standby)}`;
        rows.rate = {
            value: `${est.rate.toFixed(1).replace('.', ',')} % в час`,
            sub: `при громкости ${Math.round(Math.cbrt(est.uRef) * 100)}%`,
        };
    }

    const notes = [];
    if (observed) {
        notes.push(`Источник: ${sourceLabel(overall.source)}. Измерение: ${formatAge(overall.ageSeconds)}.`);
        if (stale)
            notes.push(`Последний заряд: ${Math.round(overall.level)}%. Текущий заряд неизвестен.`);
        else if (coarse)
            notes.push(`Шаг показаний устройства: ${overall.resolution}%.${interpolated ? ' На экране расчётная оценка между измерениями.' : ''}`);
    } else {
        notes.push('Нет актуальных показаний батареи наушников.');
        if (readings.case)
            notes.push('Заряд кейса не определяет время прослушивания.');
    }
    if (est) {
        if (info.estimateComponent === 'left' || info.estimateComponent === 'right')
            notes.push(`Прогноз ограничен ${info.estimateComponent === 'left' ? 'левым' : 'правым'} наушником.`);
        const n = Number.isSafeInteger(est.n) && est.n > 0 ? est.n : 0;
        notes.push(n
            ? `Прогноз уточнён по ${n} ${plural(n, 'замеру', 'замерам', 'замерам')} разряда.`
            : 'Время работы — стартовая оценка; она уточняется по разряду.');
    }
    if (info.airpods && components.some(item => item.value === '—'))
        notes.push('Чтобы получить заряд кейса и второго наушника, откройте кейс рядом с компьютером. Последние полученные проценты сохраняются.');
    if (typeof info.diagnostic === 'string' && info.diagnostic.trim())
        notes.push(info.diagnostic.trim().slice(0, 240));

    // Only the drawing gets safe neutral coordinates when battery is absent;
    // neither these values nor a fabricated runtime are rendered as readings.
    const lo = interpolated && levelIsValid(est.lo) ? est.lo : overall?.level;
    const hi = interpolated && levelIsValid(est.hi) ? est.hi : overall?.level;
    const ring = {
        level: batteryKnown ? overall.level : 0,
        lo: batteryKnown && levelIsValid(lo) ? lo : 0,
        hi: batteryKnown && levelIsValid(hi) ? hi : 0,
        precise: !coarse,
        batteryKnown,
    };
    return {
        pctText, value, prefix, status, ring, batteryKnown, estimateKnown,
        hours: est?.hours ?? null, stale, charging,
        components, componentsVisible, rows, note: notes.join(' '),
    };
}
