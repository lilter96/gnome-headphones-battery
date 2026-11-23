// Pure, GJS-compatible battery estimation. No Shell or platform imports.
//
// rate = a * idle + b * playing + c * playing * volume^3, in % / hour.
// Recursive Bayesian least squares learns from complete discharge intervals.
// A provider reconnect, charging interval or source overlap is NOT a sample.

const LAMBDA = 0.95;
const MAX_UNKNOWN = 10 / 60;
const THETA_MIN = [0.05, 0.3, 0];
const SOURCES = Object.freeze({
    // The original JBL HFP observations use a ceiling in ten-percent steps.
    hfp: {sigma: 1.5, rise: 10, resolution: 10, rank: 1},
    le: {sigma: 0.35, rise: 3, resolution: 1, rank: 3},
    // Only validated AAP packets may use this source. BLE advertisements may
    // have a different granularity and must NOT be passed as airpods.
    airpods: {sigma: 0.7, rise: 5, resolution: 1, rank: 4},
    // Battery1 itself does not identify the underlying reporting precision.
    battery1: {sigma: 3, rise: 10, resolution: 10, rank: 1},
});

// Public name retained for compatibility. JBL's baseline is from independent
// runtime tests (60h52m / 60h39m); the AirPods family values are deliberately
// approximate initial priors, NOT measurements of this user's generation,
// ANC configuration, battery health or listening volume.
export const TESTED_HOURS = Object.freeze({
    'JBL TUNE520BT': 60.6,
    'AirPods': 5,
    'AirPods Pro': 5.5,
    'AirPods Max': 20,
});
const DEFAULT_TESTED_HOURS = 30;
const dictionary = () => Object.create(null);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 512 &&
    key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
const validSource = src => typeof src === 'string' && own(SOURCES, src);
const validLevel = level => Number.isInteger(level) && level >= 0 && level <= 100;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
const validVector = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const modelName = model => typeof model === 'string' && model.length <= 256 ? model : '';

// Legacy UPower serials were sometimes lower-case. Only recognize an entire
// MAC identity (optionally one of our earbud suffixes), not arbitrary names,
// paths or strings that merely contain an address.
function canonicalStoredId(id) {
    const match = /^((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})(?::(left|right))?$/.exec(id);
    return match ? match[1].toUpperCase() + (match[2] ? ':' + match[2] : '') : id;
}

export function normalizeModelForPrior(model) {
    const name = modelName(model).trim();
    // Most specific first: AirPods must not swallow AirPods Pro or Max.
    if (/\bairpods\s+max\b/i.test(name))
        return 'AirPods Max';
    if (/\bairpods\s+pro\b/i.test(name))
        return 'AirPods Pro';
    if (/\bairpods\b/i.test(name))
        return 'AirPods';
    if (/^jbl\s+tune\s*520bt(?:-le)?$/i.test(name))
        return 'JBL TUNE520BT';
    return name;
}

export function prior(model) {
    const key = normalizeModelForPrior(model);
    const hours = own(TESTED_HOURS, key) ? TESTED_HOURS[key] : DEFAULT_TESTED_HOURS;
    const r = 100 / hours;
    return {
        theta: [0.24 * r, 0.92 * r, 0.65 * r],
        sd: [0.25 * r, 0.60 * r, 0.80 * r],
    };
}

function covariance(p) {
    return p.sd.map((s, i) => p.sd.map((_, j) => i === j ? s * s : 0));
}

// Accept a finite, symmetric positive semidefinite 3x3 covariance. Corrupt
// JSON must not introduce NaN or a negative variance into the Shell process.
function validatedCovariance(value) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(validVector))
        return null;
    const result = value.map(row => [...row]);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (Math.abs(result[i][j]) > 1e6 ||
                Math.abs(result[i][j] - result[j][i]) > 1e-7 * Math.max(1, Math.abs(result[i][j])))
                return null;
            result[i][j] = (value[i][j] + value[j][i]) / 2;
        }
    }
    const l = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j <= i; j++) {
            let v = result[i][j];
            for (let k = 0; k < j; k++)
                v -= l[i][k] * l[j][k];
            if (i === j) {
                if (v < -1e-8)
                    return null;
                l[i][j] = Math.sqrt(Math.max(v, 0));
            } else if (l[j][j] > 1e-10) {
                l[i][j] = v / l[j][j];
            } else if (Math.abs(v) > 1e-8) {
                return null;
            }
        }
    }
    return result;
}

function resolutionFor(src, requested) {
    if (src === 'battery1' && Number.isInteger(requested) && requested >= 1 && requested <= 100)
        return requested;
    return SOURCES[src].resolution;
}

function newSeg(level, exact, resolution, active = true) {
    return {level, exact, resolution, active, superseded: false,
        tIdle: 0, tPlay: 0, uInt: 0, tUnknown: 0, leSeen: false};
}

export function interval(src, level, resolution) {
    if (!validSource(src) || !validLevel(level))
        return null;
    // A reported zero must never produce positive remaining playback time.
    if (level === 0)
        return [0, 0];
    if (src === 'hfp')
        return [Math.max(level - 9, 0), Math.min(level + 1, 100)];
    if (src === 'le')
        return [level, Math.min(level + 1, 100)];
    // Integer resolution does not prove the device's rounding direction or
    // physical accuracy. Be conservative for AAP and generic Battery1.
    const step = resolutionFor(src, resolution);
    return [Math.max(level - step, 0), Math.min(level + step, 100)];
}

function freshDevice(model) {
    const p = prior(model);
    return {model: modelName(model), theta: p.theta, P: covariance(p), n: 0,
        read: dictionary(), segs: dictionary(), uAvg: null, charging: false};
}

function hydrateDevice(value) {
    if (!record(value))
        return null;
    const d = freshDevice(value.model);
    if (validVector(value.theta) && value.theta[0] >= THETA_MIN[0] && value.theta[1] >= THETA_MIN[1] &&
        value.theta[2] >= 0 && value.theta.every(v => v <= 1000))
        d.theta = [...value.theta];
    d.P = validatedCovariance(value.P) ?? d.P;
    if (Number.isSafeInteger(value.n) && value.n >= 0)
        d.n = value.n;
    if (Number.isFinite(value.uAvg) && value.uAvg >= 0 && value.uAvg <= 1)
        d.uAvg = value.uAvg;
    if (record(value.read)) {
        for (const [src, level] of Object.entries(value.read)) {
            if (!validSource(src) || !validLevel(level))
                continue;
            d.read[src] = level;
            const res = resolutionFor(src, value.segs?.[src]?.resolution);
            // Keep calibration and historical readings, but never treat data
            // from the previous process as a current measurement.
            d.segs[src] = newSeg(level, false, res, false);
        }
    }
    return d;
}

export class Estimator {
    constructor(state) {
        this.state = {version: 2, devices: dictionary(), companions: dictionary()};
        if (!record(state) || state.version !== 2)
            return;
        if (record(state.devices)) {
            for (const [id, value] of Object.entries(state.devices)) {
                if (!safeKey(id))
                    continue;
                const d = hydrateDevice(value);
                if (d)
                    this.state.devices[id] = d;
            }
        }
        const moved = new Map();
        // Inspect all hydrated keys before moving any. A canonical record is
        // authoritative if it already exists; never overwrite or merge its
        // calibration with another case-variant record. Collisions remain
        // saved under their original ids for explicit user recovery.
        for (const id of Object.keys(this.state.devices).sort()) {
            const canonical = canonicalStoredId(id);
            if (canonical !== id && !own(this.state.devices, canonical)) {
                this.state.devices[canonical] = this.state.devices[id];
                delete this.state.devices[id];
                moved.set(id, canonical);
            }
        }
        if (record(state.companions)) {
            for (const [model, id] of Object.entries(state.companions)) {
                if (safeKey(model) && safeKey(id))
                    this.state.companions[model] = moved.get(id) ?? id;
            }
        }
    }

    _dev(id, model) {
        if (!safeKey(id))
            return null;
        let d = this.state.devices[id];
        if (!d) {
            d = freshDevice(model);
            this.state.devices[id] = d;
        } else if (modelName(model) && d.model !== model) {
            const priorChanged = normalizeModelForPrior(d.model) !== normalizeModelForPrior(model);
            d.model = modelName(model);
            // Better identification (e.g. generic AirPods -> Pro) may repair
            // an untrained prior, but never erase measured calibration.
            if (priorChanged && d.n === 0) {
                const p = prior(d.model);
                d.theta = p.theta;
                d.P = covariance(p);
            }
        }
        return d;
    }

    _rank(src, seg) {
        return src === 'battery1' && seg?.resolution === 1 ? 2 : SOURCES[src].rank;
    }

    _markOverlap(d, src) {
        const rank = this._rank(src, d.segs[src]);
        for (const [other, seg] of Object.entries(d.segs)) {
            if (other === src || !seg.active)
                continue;
            if (this._rank(other, seg) <= rank) {
                seg.superseded = true;
                if (other === 'hfp')
                    seg.leSeen = true;
            } else {
                d.segs[src].superseded = true;
            }
        }
    }

    // Provider appearance/reconnection is a boundary, even if its integer
    // reading happens to equal the last one. Offline time is not observed.
    attach(id, model, src, level, options = {}) {
        if (!validSource(src) || !validLevel(level))
            return false;
        const d = this._dev(id, model);
        if (!d)
            return false;
        const opts = record(options) ? options : {};
        const charging = typeof opts.charging === 'boolean' ? opts.charging : d.charging;
        if (charging !== d.charging)
            this.detach(id);
        d.charging = charging;
        d.read[src] = level;
        d.segs[src] = newSeg(level, false, resolutionFor(src, opts.resolution));
        this._markOverlap(d, src);
        return true;
    }

    // Retain learned calibration, but make stale/disconnected data ineligible
    // for display, accounting and learning until a new measurement arrives.
    detach(id, src = null) {
        const d = safeKey(id) ? this.state.devices[id] : null;
        if (!d)
            return;
        for (const [key, seg] of Object.entries(d.segs)) {
            if (src === null || key === src)
                d.segs[key] = newSeg(seg.level, false, seg.resolution, false);
        }
    }

    // Returns a learning sample only for a complete, observed discharge step.
    observe(id, model, src, level, options = {}) {
        if (!validSource(src) || !validLevel(level))
            return null;
        const d = this._dev(id, model);
        if (!d)
            return null;
        const opts = record(options) ? options : {};
        const seg = d.segs[src];
        const resolution = resolutionFor(src, opts.resolution ?? seg?.resolution);
        const charging = typeof opts.charging === 'boolean' ? opts.charging : d.charging;
        if (!seg?.active || seg.resolution !== resolution || charging !== d.charging) {
            this.attach(id, model, src, level, {charging, resolution});
            return null;
        }
        const last = d.read[src];
        if (charging) {
            // A charging battery is not training data for discharge, even if
            // its reported percentage temporarily falls under load.
            this.attach(id, model, src, level, {charging: true, resolution});
            return null;
        }
        this._markOverlap(d, src);
        if (level === last)
            return null;
        if (level > last) {
            const threshold = src === 'battery1' ? Math.max(3, resolution) : SOURCES[src].rise;
            if (level - last >= threshold) {
                for (const other of Object.keys(d.segs))
                    this.detach(id, other);
                this.attach(id, model, src, level, {charging: false, resolution});
            }
            // Small voltage rebounds do not create fake discharge samples.
            return null;
        }

        let sample = null;
        if (seg.exact && !seg.superseded && seg.tUnknown <= MAX_UNKNOWN) {
            const x = [seg.tIdle, seg.tPlay, seg.uInt];
            if (x[0] + x[1] > 0.02) {
                const sigma = src === 'battery1' ? Math.max(0.35, resolution / Math.sqrt(12)) : SOURCES[src].sigma;
                sample = this._learn(d, x, seg.level - level, sigma);
            }
        }
        d.read[src] = level;
        d.segs[src] = newSeg(level, true, resolution);
        this._markOverlap(d, src);
        return sample;
    }

    // dt is hours; mode is play / idle / unknown. Calling code must detach
    // expired providers and not use a stale measurement as a new sample.
    account(id, dt, mode, u = 0) {
        const d = safeKey(id) ? this.state.devices[id] : null;
        if (!d || d.charging)
            return;
        if (!Number.isFinite(dt) || dt < 0 || dt > 24 || !['play', 'idle', 'unknown'].includes(mode)) {
            // A bad clock interval is a gap, not zero-time observed playback.
            for (const seg of Object.values(d.segs))
                seg.exact = false;
            return;
        }
        if (dt === 0)
            return;
        if (!Number.isFinite(u))
            mode = 'unknown';
        u = Number.isFinite(u) ? clamp(u, 0, 1) : 0;
        let active = false;
        for (const seg of Object.values(d.segs)) {
            if (!seg.active)
                continue;
            active = true;
            if (mode === 'play') {
                seg.tPlay += dt;
                seg.uInt += dt * u;
            } else if (mode === 'idle') {
                seg.tIdle += dt;
            } else {
                seg.tUnknown += dt;
            }
        }
        if (active && mode === 'play')
            d.uAvg = d.uAvg === null ? u : d.uAvg + (u - d.uAvg) * (1 - Math.exp(-dt / 3));
    }

    _learn(d, x, y, sigma) {
        if (!validVector(x) || x.some(v => v < 0) || !Number.isFinite(y) || y <= 0)
            return null;
        const p = prior(d.model);
        const P = d.P.map(row => row.map(v => v / LAMBDA));
        for (let i = 0; i < 3; i++) {
            const max = p.sd[i] ** 2;
            if (P[i][i] > max) {
                const k = Math.sqrt(max / P[i][i]);
                for (let j = 0; j < 3; j++) {
                    P[i][j] *= k;
                    P[j][i] *= k;
                }
            }
        }
        const Px = P.map(row => dot(row, x));
        const s = dot(x, Px) + sigma * sigma;
        if (!Number.isFinite(s) || s <= 0)
            return null;
        const K = Px.map(v => v / s);
        const predicted = dot(x, d.theta);
        const err = y - predicted;
        // Preserve the historical JBL bounds, but scale up for short-runtime
        // devices. AirPods' b starts near 17: clamping it to 10 corrupted the
        // first learned sample in v2.
        const maxima = [3, 10, 10].map((v, i) => Math.max(v, p.theta[i] * 5, d.theta[i]));
        const theta = d.theta.map((t, i) => clamp(t + K[i] * err, THETA_MIN[i], maxima[i]));
        const nextP = P.map((row, i) => row.map((v, j) => v - K[i] * Px[j]));
        const checked = validatedCovariance(nextP);
        if (!theta.every(Number.isFinite) || !checked)
            return null;
        d.theta = theta;
        d.P = checked;
        d.n = Math.min(d.n + 1, Number.MAX_SAFE_INTEGER);
        return {x, y, predicted, theta: [...d.theta]};
    }

    reset(id) {
        const d = safeKey(id) ? this.state.devices[id] : null;
        if (!d)
            return;
        const p = prior(d.model);
        d.theta = p.theta;
        d.P = covariance(p);
        d.n = 0;
        for (const [src, seg] of Object.entries(d.segs))
            d.segs[src] = newSeg(d.read[src], false, seg.resolution, seg.active);
        for (const [src, seg] of Object.entries(d.segs)) {
            if (seg.active)
                this._markOverlap(d, src);
        }
    }

    estimate(id, src, options = {}) {
        const d = safeKey(id) ? this.state.devices[id] : null;
        const seg = d?.segs[src];
        const level = d?.read[src];
        if (!validSource(src) || !validLevel(level) || !seg?.active || d.charging)
            return null;
        const {playing = false, u = 0} = record(options) ? options : {};
        const [lo, hi] = interval(src, level, seg.resolution);
        const used = dot(d.theta, [seg.tIdle, seg.tPlay, seg.uInt]);
        const floor = level === 0 ? 0 : Math.min(level, lo + Math.max(hi - lo, 0.2) * 0.05);
        const start = src === 'airpods' || src === 'battery1' ? level : seg.exact ? hi : (lo + hi) / 2;
        const soc = level === 0 ? 0 : clamp(start - used, floor, Math.max(hi, floor));
        const socMin = level === 0 ? 0 : clamp(lo - used, floor, Math.max(hi, floor));
        const socMax = level === 0 ? 0 : clamp(hi - used, floor, Math.max(hi, floor));
        const inputU = Number.isFinite(u) ? clamp(u, 0, 1) : d.uAvg ?? 0.125;
        const uRef = playing ? inputU : d.uAvg ?? inputU;
        const g = [0, 1, uRef];
        const rate = dot(g, d.theta);
        const sd = Math.sqrt(Math.max(dot(g, d.P.map(row => dot(row, g))), 0));
        if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(sd))
            return null;
        return {
            level, src, lo, hi, soc, resolution: seg.resolution,
            hours: soc / rate,
            hoursMin: socMin / (rate + 1.28 * sd),
            hoursMax: socMax / Math.max(rate - 1.28 * sd, rate * 0.5),
            standby: soc / d.theta[0], rate, idleRate: d.theta[0], uRef, n: d.n,
        };
    }
}

export function formatDuration(hours, short = false) {
    if (!Number.isFinite(hours) || hours < 0)
        return '—';
    const [hu, mu, sep] = short ? ['ч', 'м', ''] : [' ч', ' мин', ' '];
    if (hours === 0)
        return '0' + mu;
    let min = Math.round(hours * 60);
    if (min < 58)
        return String(Math.max(5, Math.round(min / 5) * 5)) + mu;
    if (hours >= 10)
        return String(Math.round(hours)) + hu;
    min = Math.round(min / 10) * 10;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? String(h) + hu + sep + String(m) + mu : String(h) + hu;
}
