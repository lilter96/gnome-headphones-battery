// Pure discovery reconciliation. A registry key never changes when a second
// provider arrives, so provider order cannot duplicate or orphan a card.
import {
    identifyDevice, normalizeMac, macFromPath, normalizeModel,
    isAirPods, looksLikeHeadphones, uuidList, BATTERY_SERVICE_UUID,
} from './bluez.js';

const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';

function adapterPathFor(path, props) {
    const candidate = props?.Adapter;
    return typeof candidate === 'string' && /^\/org\/bluez\/hci[0-9]+$/.test(candidate)
        ? candidate : path.slice(0, path.lastIndexOf('/'));
}

function adapterAvailable(objects, path, props) {
    // ObjectManager publishes individual removals/properties in sequence. A
    // stale Connected=true must not keep the helper alive after adapter loss.
    // Also wait for Adapter1 during initial snapshot reconstruction.
    return objects.get(adapterPathFor(path, props))?.[ADAPTER]?.Powered === true;
}

function connected(objects, path, props) {
    return props?.Connected === true && adapterAvailable(objects, path, props);
}

export function planDevices(objects, upower, bluezOnline) {
    const plans = new Map();
    const devicesByMac = new Map();
    // Deterministic adapter choice if the same identity is temporarily visible
    // as connected through two adapters. Map enumeration order is not identity.
    for (const [path, ifaces] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
        const props = ifaces[DEVICE];
        if (!props)
            continue;
        const mac = normalizeMac(props.Address) || macFromPath(path);
        if (!mac)
            continue;
        const candidates = devicesByMac.get(mac) || [];
        candidates.push({path, props, connected: connected(objects, path, props)});
        devicesByMac.set(mac, candidates);
        if (bluezOnline && connected(objects, path, props) && looksLikeHeadphones(props)) {
            const identified = identifyDevice(props, path);
            if (!identified)
                continue;
            if (!plans.has(mac))
                plans.set(mac, fromBlueZ(identified, props, path, objects));
        }
    }
    for (const descriptor of upower) {
        if (!descriptor.audio || descriptor.isPresent === false)
            continue;
        const mac = normalizeMac(descriptor.mac) || macFromPath(descriptor.nativePath || '');
        const known = devicesByMac.get(mac) || [];
        // Device1 Connected=false is authoritative, even if UPower's removal
        // notification arrives later. A dead BlueZ cannot carry a BT stream.
        if (known.length && !known.some(d => d.connected))
            continue;
        if (known.length && bluezOnline === false)
            continue;
        if (bluezOnline === false && descriptor.nativePath?.startsWith('/org/bluez/'))
            continue;
        if (bluezOnline === true && descriptor.nativePath?.startsWith('/org/bluez/') &&
            !known.length)
            continue;
        const id = mac || descriptor.id || descriptor.path;
        let plan = plans.get(id);
        if (!plan) {
            const active = known.find(d => d.path === descriptor.nativePath &&
                d.connected) || known.find(d => d.connected);
            if (active) {
                const identity = identifyDevice(active.props, active.path);
                if (identity)
                    plan = fromBlueZ(identity, active.props, active.path, objects);
            }
            plan ??= {
                id, address: mac, displayName: descriptor.model || 'Наушники',
                model: normalizeModel(descriptor.model) || 'Наушники',
                airpods: isAirPods(descriptor.model), bluezPath: null,
                bluezProps: null, adapterPath: null, adapterAddress: null, upowerPaths: [],
            };
            plans.set(id, plan);
        }
        if (!plan.upowerPaths.includes(descriptor.path))
            plan.upowerPaths.push(descriptor.path);
    }
    return plans;
}

function fromBlueZ(identity, props, path, objects) {
    const adapterPath = identity.adapterPath;
    return {
        id: identity.mac, address: identity.mac,
        displayName: identity.displayName, model: identity.model,
        airpods: identity.isAirPods, bluezPath: path, bluezProps: props,
        adapterPath,
        adapterAddress: normalizeMac(objects.get(adapterPath)?.[ADAPTER]?.Address),
        upowerPaths: [],
    };
}

// A separate LE address is associated only with the legacy, explicitly named
// JBL "-LE" companion. Never guess an Apple randomized advertising identity.
// Multiple same-model pairs/candidates are deliberately treated as ambiguous.
export function findBatteryTarget(plan, objects, allPlans) {
    const batteryUuid = BATTERY_SERVICE_UUID.toLowerCase();
    const supportsBattery = props => uuidList(props?.UUIDs).includes(batteryUuid);
    const direct = plan.bluezPath && objects.get(plan.bluezPath)?.[DEVICE];
    if (direct && connected(objects, plan.bluezPath, direct) && supportsBattery(direct))
        return {path: plan.bluezPath, props: direct, companion: false};
    if (!plan.bluezPath || !direct || !connected(objects, plan.bluezPath, direct) ||
        !plan.adapterPath || plan.airpods || !/^JBL\s/i.test(plan.model || ''))
        return null;
    const peers = [...allPlans.values()].filter(p => p.model === plan.model);
    if (peers.length !== 1)
        return null;
    const names = new Set([plan.model + '-LE', plan.model + ' LE',
        plan.displayName + '-LE', plan.displayName + ' LE']);
    const matches = [];
    for (const [path, ifaces] of objects) {
        const props = ifaces[DEVICE];
        if (!props || path === plan.bluezPath || !supportsBattery(props))
            continue;
        if (!adapterAvailable(objects, path, props) || adapterPathFor(path, props) !== plan.adapterPath)
            continue;
        if (!names.has(props.Name) && !names.has(props.Alias))
            continue;
        if (normalizeMac(props.Address) === plan.address)
            continue;
        matches.push({path, props, companion: true});
    }
    return matches.length === 1 ? matches[0] : null;
}
