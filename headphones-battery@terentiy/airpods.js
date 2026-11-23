// Pure battery validation and source arbitration. No Bluetooth I/O here.
//
// The v2 archive guessed Apple advertisement byte offsets and treated arbitrary
// ServiceData bytes <= 100 as battery readings. Those paths are deliberately
// removed. Only the native helper's verified AAP schema and standard battery
// sources may produce readings. Random BLE addresses are never guessed to be
// the paired AirPods identity.

import {normalizeMac} from './bluez.js';

export const COMPONENTS = Object.freeze(['left', 'right', 'case']);
export const MAX_AAP_LINE_LENGTH = 4096;
export const DEFAULT_TTLS = Object.freeze({aap: 900, le: 180, battery1: 3600, hfp: 21600});

const PRIORITY = Object.freeze({aap: 4, le: 3, battery1: 2, hfp: 1});
const RESOLUTION = Object.freeze({aap: 1, le: 1, battery1: null, hfp: 10});
const STANDARD_SOURCES = new Set(['le', 'battery1', 'hfp']);
const STATUS = new Set(['charging', 'discharging', 'disconnected', 'unknown', null]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => Number.isFinite(value) && value >= 0;
export const validPercentage = value => Number.isInteger(value) && value >= 0 && value <= 100;

/** Validate one complete helper JSON line. A bad frame changes no state. */
export function parseAapMessage(input, expectedMac) {
    const expected = normalizeMac(expectedMac);
    if (!expected)
        return null;
    let data = input;
    if (typeof input === 'string') {
        if (!input.length || input.length > MAX_AAP_LINE_LENGTH)
            return null;
        try {
            data = JSON.parse(input);
        } catch {
            return null;
        }
    }
    if (!record(data) || data.version !== 1 || data.type !== 'battery' || data.source !== 'aap' ||
        normalizeMac(data.address) !== expected || !Number.isSafeInteger(data.updated_at) || data.updated_at < 0 ||
        !record(data.charging) || !record(data.status) || !Array.isArray(data.present) ||
        data.present.length < 1 || data.present.length > COMPONENTS.length)
        return null;
    const present = new Set(data.present);
    if (present.size !== data.present.length || [...present].some(key => !COMPONENTS.includes(key)))
        return null;

    const output = {
        version: 1,
        type: 'battery',
        address: expected,
        left: null,
        right: null,
        case: null,
        charging: {left: null, right: null, case: null},
        status: {left: null, right: null, case: null},
        present: [...present],
        source: 'aap',
        updated_at: data.updated_at,
    };
    for (const key of COMPONENTS) {
        const level = data[key];
        const charging = data.charging[key];
        const status = data.status[key];
        if (!(level === null || validPercentage(level)) ||
            !(charging === null || typeof charging === 'boolean') || !STATUS.has(status))
            return null;
        if (!present.has(key)) {
            // Contract is a per-frame delta, not a snapshot with hidden carry-over.
            if (level !== null || charging !== null || status !== null)
                return null;
            continue;
        }
        if (status === 'charging' || status === 'discharging') {
            if (charging !== (status === 'charging'))
                return null;
        } else if (level !== null || charging !== null) {
            return null;
        }
        output[key] = level;
        output.charging[key] = charging;
        output.status[key] = status;
    }
    return output;
}

/**
 * One connected device's session-only battery observations.
 * now is monotonic seconds supplied by the caller, never wall-clock time.
 * A source being alive does not refresh the timestamp of its measurements.
 * updateAap applies only present components, preserving other components' ages.
 */
export class BatteryState {
    constructor(mac = null, {ttlSeconds = {}} = {}) {
        // UPower also exposes USB/non-Bluetooth audio. Those devices may use
        // standard sources without a MAC; never invent an address for AAP.
        this.mac = mac === null ? null : normalizeMac(mac);
        if (mac !== null && !this.mac)
            throw new TypeError('BatteryState requires a valid Bluetooth address or null');
        this._ttl = {...DEFAULT_TTLS};
        for (const source of Object.keys(DEFAULT_TTLS)) {
            const value = ttlSeconds[source];
            if (Number.isFinite(value) && value > 0)
                this._ttl[source] = value;
        }
        this._levels = new Map();
        this._components = {left: null, right: null, case: null};
        this._history = {};
    }

    updateAap(input, now) {
        const packet = parseAapMessage(input, this.mac);
        if (!packet || !validTime(now))
            return false;
        let applied = false;
        for (const component of packet.present) {
            const previous = this._components[component];
            // Ignore out-of-order callbacks from an older observation.
            if (previous && now < previous.receivedAt)
                continue;
            this._components[component] = {
                level: packet[component],
                charging: packet.charging[component],
                status: packet.status[component],
                source: 'aap',
                resolution: 1,
                component,
                receivedAt: now,
                reportedAt: packet.updated_at,
                available: true,
                cached: false,
            };
            if (validPercentage(packet[component]))
                this._history[component] = {...this._components[component], reportedAt: Math.floor(Date.now() / 1000)};
            applied = true;
        }
        return applied;
    }

    // History is display-only. Restoring it never creates a current observation
    // or an estimator sample, and a disconnected frame never erases it.
    restoreHistory(snapshot, now, wallNow = Date.now() / 1000) {
        if (!record(snapshot) || !validTime(now) || !validTime(wallNow))
            return;
        for (const component of COMPONENTS) {
            const saved = snapshot[component];
            if (!record(saved) || !validPercentage(saved.level) ||
                !Number.isSafeInteger(saved.updatedAt) || saved.updatedAt < 0 || saved.updatedAt > wallNow)
                continue;
            this._history[component] = {
                level: saved.level, reportedAt: saved.updatedAt,
                receivedAt: now - (wallNow - saved.updatedAt), source: 'aap', resolution: 1,
                component, status: 'unknown', charging: null, available: false, cached: false,
            };
        }
    }

    snapshotHistory() {
        return Object.fromEntries(Object.entries(this._history).map(([key, reading]) =>
            [key, {level: reading.level, updatedAt: reading.reportedAt}]));
    }

    /**
     * Add a standard overall battery value. Battery1 is not a left-earbud value.
     * cached:true is for an initial D-Bus cache whose measurement time is unknown;
     * it is visibly stale and cannot refresh/replace an existing observation.
     * Call with cached:false only on an actual signal/read, not every GetAll poll.
     */
    updateLevel(source, level, now, options = {}) {
        if (!STANDARD_SOURCES.has(source) || !validTime(now) || !record(options))
            return false;
        if (level === null) {
            this._levels.delete(source);
            return true;
        }
        if (!validPercentage(level))
            return false;
        const previous = this._levels.get(source);
        if (previous && (now < previous.receivedAt || options.cached === true))
            return false;
        const charging = options.charging ?? null;
        if (!(charging === null || typeof charging === 'boolean'))
            return false;
        const resolution = options.resolution === undefined ? RESOLUTION[source] : options.resolution;
        if (!(resolution === null || Number.isInteger(resolution) && resolution >= 1 && resolution <= 100))
            return false;
        this._levels.set(source, {
            level,
            charging,
            status: charging === true ? 'charging' : charging === false ? 'discharging' : 'unknown',
            source,
            resolution,
            component: null,
            receivedAt: now,
            reportedAt: null,
            available: true,
            cached: options.cached === true,
            canEstimate: options.eligibleForEstimate !== false,
        });
        return true;
    }

    /** Mark transport loss without turning historical measurements into zero. */
    setSourceAvailable(source, available) {
        if (typeof available !== 'boolean')
            return;
        const readings = source === 'aap' ? Object.values(this._components) : [this._levels.get(source)];
        for (const reading of readings) {
            if (reading)
                reading.available = available;
        }
    }

    removeSource(source) {
        if (source === 'aap')
            this._components = {left: null, right: null, case: null};
        else
            this._levels.delete(source);
    }

    clear() {
        this._history = {};
        this._levels.clear();
        this._components = {left: null, right: null, case: null};
    }

    _view(reading, now) {
        if (!reading)
            return null;
        const ageSeconds = reading.cached || !validTime(now) || now < reading.receivedAt
            ? null : now - reading.receivedAt;
        const stale = !validTime(now) || now < reading.receivedAt || !reading.available ||
            reading.cached || ageSeconds > this._ttl[reading.source];
        const eligibleForEstimate = !stale && reading.level !== null &&
            (reading.source === 'aap' ? reading.status === 'discharging' :
                reading.charging !== true && reading.canEstimate);
        return {...reading, ageSeconds, stale, eligibleForEstimate};
    }

    select(now) {
        const components = Object.fromEntries(COMPONENTS.map(key => [key, this._view(this._components[key], now)]));
        const earbuds = ['left', 'right'].map(key => components[key]).filter(reading => reading && reading.level !== null);
        const freshEarbuds = earbuds.filter(reading => !reading.stale);
        // A bud charging in its case should not determine playback time while
        // the other bud is discharging in use. If all available buds are charging,
        // show the lower measured charge, but do not claim a playback forecast.
        const active = freshEarbuds.filter(reading => reading.status === 'discharging');
        const aapChoice = [...(active.length ? active : freshEarbuds)]
            .sort((a, b) => a.level - b.level)[0] ?? null;
        // A fresh, explicit AAP disconnection is stronger evidence than an
        // older generic cached percentage. Otherwise closing the case can
        // resurrect an HFP/Battery1 ETA while Device1 lags behind the earbuds.
        // This is not a blanket ban on fallback: a later actual standard
        // measurement, or loss/expiry of the AAP source, may still be used.
        // Case-only frames and unknown battery values prove no disconnection.
        const disconnectAt = aapChoice ? -Infinity : Math.max(-Infinity,
            ...['left', 'right'].map(key => components[key])
                .filter(reading => reading && !reading.stale && reading.status === 'disconnected')
                .map(reading => reading.receivedAt));
        const candidates = [...this._levels.values()]
            .map(reading => this._view(reading, now))
            .filter(reading => reading.receivedAt > disconnectAt);
        if (aapChoice)
            candidates.push(aapChoice);
        const fresh = candidates.filter(reading => !reading.stale);
        let overall = fresh.sort((a, b) => PRIORITY[b.source] - PRIORITY[a.source])[0] ?? null;
        if (!overall) {
            // Historical readings may be displayed as such; never fed into ETA.
            const old = [...candidates, ...earbuds].filter(reading => reading.stale);
            overall = old.sort((a, b) => b.receivedAt - a.receivedAt || PRIORITY[b.source] - PRIORITY[a.source])[0] ?? null;
        }
        const playback = overall?.eligibleForEstimate ? overall : null;
        return {
            overall,
            components: Object.fromEntries(COMPONENTS.map(key => {
                const current = components[key];
                if (current && current.level !== null)
                    return [key, current];
                const old = this._history[key];
                return [key, old ? {...this._view(old, now), stale: true, historical: true,
                    status: 'unknown', charging: null, eligibleForEstimate: false} : current];
            })),
            playback,
            eligibleForEstimate: playback !== null,
            estimateComponent: playback?.component ?? null,
        };
    }
}
