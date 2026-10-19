// Pure estimation logic, no GNOME Shell imports, so it can be tested with plain gjs.
//
// Drain model, in % of battery per hour:
//
//     rate = a·[idle] + b·[playing] + c·[playing]·u,   u = volume³
//
// (u is PipeWire's cubic volume, i.e. roughly the linear output amplitude.)
// θ = [a, b, c] is learned per device with recursive Bayesian least squares:
// every observed level drop is one sample "drop = a·t_idle + b·t_play + c·∫u dt"
// over the time since the previous observed drop. The prior comes from
// independent run-time tests, so the estimate is sane before any data exists,
// and a forgetting factor keeps it following battery ageing and habits.
//
// Level sources:
//   'le'  - BLE Battery Service, 1% resolution: level L means [L, L+1).
//   'hfp' - AT+IPHONEACCEV 0..9, which PipeWire shows as (v+1)·10. The headset
//           rounds up (seen at once: BLE 13% with "20%", BLE 10% with "10%"),
//           so a shown level R means BLE R-9…R, i.e. [R-9, R+1). "20%" is 11-20%.

const LAMBDA = 0.95;
const SIGMA = {le: 0.35, hfp: 1.5};
const MAX_UNKNOWN = 10 / 60;
const THETA_MIN = [0.05, 0.3, 0];
const THETA_MAX = [3, 10, 10];
const RISE_IS_CHARGE = {le: 3, hfp: 10};

// Continuous playback at moderate volume, hours.
// JBL Tune 520BT: SoundGuys 60h52m at 75 dB(SPL), Gough Lui 60h39m (claimed 57h).
export const TESTED_HOURS = {
    'JBL TUNE520BT': 60.6,
};
const DEFAULT_TESTED_HOURS = 30;

export function prior(model) {
    const r = 100 / (TESTED_HOURS[model] ?? DEFAULT_TESTED_HOURS);
    // b + c·0.125 = r (tests run around half volume, 0.5³), full volume ≈ +55%,
    // connected-idle ≈ 1.8 mA against ≈ 7.4 mA playing ⇒ a ≈ 0.24·r.
    return {
        theta: [0.24 * r, 0.92 * r, 0.65 * r],
        sd: [0.25 * r, 0.60 * r, 0.80 * r],
    };
}

const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const newSeg = (level, exact) => ({level, exact, tIdle: 0, tPlay: 0, uInt: 0, tUnknown: 0, leSeen: false});

export function interval(src, level) {
    return src === 'hfp'
        ? [Math.max(level - 9, 0), Math.min(level + 1, 100)]
        : [level, Math.min(level + 1, 100)];
}

export class Estimator {
    constructor(state) {
        this.state = state?.version === 2 ? state : {version: 2, devices: {}, companions: {}};
        this.state.companions ??= {};
    }

    _dev(id, model) {
        let d = this.state.devices[id];
        if (!d) {
            const p = prior(model);
            d = this.state.devices[id] = {
                model,
                theta: p.theta,
                P: p.sd.map((s, i) => p.sd.map((_, j) => i === j ? s * s : 0)),
                n: 0,
                read: {},
                segs: {},
                uAvg: null,
            };
        }
        return d;
    }

    // A level source (re)appeared. The open segment survives only if the level
    // did not change while we were not watching.
    attach(id, model, src, level) {
        const d = this._dev(id, model);
        if (d.read[src] !== level || !d.segs[src]) {
            d.read[src] = level;
            d.segs[src] = newSeg(level, false);
        }
        if (src === 'le' && d.segs.hfp)
            d.segs.hfp.leSeen = true;
    }

    // Returns the learning sample if this reading completed one.
    observe(id, model, src, level) {
        const d = this._dev(id, model);
        const last = d.read[src];
        if (last === undefined || last === null) {
            this.attach(id, model, src, level);
            return null;
        }
        if (src === 'le' && d.segs.hfp)
            d.segs.hfp.leSeen = true;
        if (level === last)
            return null;

        if (level > last) {
            // Small rises are voltage rebound after load drops; keep the minimum.
            if (level - last >= RISE_IS_CHARGE[src]) {
                d.read = {[src]: level};
                d.segs = {[src]: newSeg(level, false)};
            }
            return null;
        }

        let sample = null;
        const seg = d.segs[src];
        // HFP steps are only used when the precise source was absent all along,
        // otherwise the same drain would be counted twice.
        if (seg?.exact && seg.tUnknown <= MAX_UNKNOWN && !(src === 'hfp' && seg.leSeen)) {
            const x = [seg.tIdle, seg.tPlay, seg.uInt];
            if (x[0] + x[1] > 0.02)
                sample = this._learn(d, x, seg.level - level, SIGMA[src]);
        }
        d.read[src] = level;
        d.segs[src] = newSeg(level, true);
        return sample;
    }

    // mode: 'play' | 'idle' | 'unknown' (in use, but not by us); dt in hours.
    account(id, dt, mode, u = 0) {
        const d = this.state.devices[id];
        if (!d || dt <= 0)
            return;
        for (const seg of Object.values(d.segs)) {
            if (!seg)
                continue;
            if (mode === 'play') {
                seg.tPlay += dt;
                seg.uInt += dt * u;
            } else if (mode === 'idle') {
                seg.tIdle += dt;
            } else {
                seg.tUnknown += dt;
            }
        }
        if (mode === 'play')
            d.uAvg = d.uAvg === null ? u : d.uAvg + (u - d.uAvg) * (1 - Math.exp(-dt / 3));
    }

    _learn(d, x, y, sigma) {
        const p = prior(d.model);
        const P = d.P.map(row => row.map(v => v / LAMBDA));
        // Forgetting must not push directions that are never excited (e.g. the
        // volume term at constant volume) beyond the prior uncertainty.
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
        const K = Px.map(v => v / s);
        const err = y - dot(x, d.theta);
        d.theta = d.theta.map((t, i) => clamp(t + K[i] * err, THETA_MIN[i], THETA_MAX[i]));
        d.P = P.map((row, i) => row.map((v, j) => v - K[i] * Px[j]));
        d.n += 1;
        return {x, y, predicted: y - err, theta: [...d.theta]};
    }

    reset(id) {
        const d = this.state.devices[id];
        if (!d)
            return;
        const p = prior(d.model);
        d.theta = p.theta;
        d.P = p.sd.map((s, i) => p.sd.map((_, j) => i === j ? s * s : 0));
        d.n = 0;
    }

    estimate(id, src, {playing, u}) {
        const d = this.state.devices[id];
        const level = d?.read[src];
        if (level === undefined || level === null)
            return null;

        const [lo, hi] = interval(src, level);
        const floor = lo + Math.max(hi - lo, 0.2) * 0.05;
        const seg = d.segs[src];
        const used = seg ? dot(d.theta, [seg.tIdle, seg.tPlay, seg.uInt]) : 0;
        const exact = !!seg?.exact;
        const soc = clamp((exact ? hi : (lo + hi) / 2) - used, floor, Math.max(hi, floor));
        const socMin = clamp((exact ? hi : lo) - used, floor, Math.max(hi, floor));
        const socMax = clamp(hi - used, floor, Math.max(hi, floor));

        const uRef = playing ? u : d.uAvg ?? u;
        const g = [0, 1, uRef];
        const rate = dot(g, d.theta);
        const sd = Math.sqrt(Math.max(dot(g, d.P.map(row => dot(row, g))), 0));

        return {
            level, src, lo, hi, soc,
            hours: soc / rate,
            hoursMin: socMin / (rate + 1.28 * sd),
            hoursMax: socMax / Math.max(rate - 1.28 * sd, rate * 0.5),
            standby: soc / d.theta[0],
            rate,
            idleRate: d.theta[0],
            uRef,
            n: d.n,
        };
    }
}

export function formatDuration(hours, short = false) {
    const [hu, mu, sep] = short ? ['ч', 'м', ''] : [' ч', ' мин', ' '];
    let min = Math.round(hours * 60);
    if (min < 58)
        return `${Math.max(5, Math.round(min / 5) * 5)}${mu}`;
    if (hours >= 10)
        return `${Math.round(hours)}${hu}`;
    min = Math.round(min / 10) * 10;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}${hu}${sep}${m}${mu}` : `${h}${hu}`;
}
