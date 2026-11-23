// Pure identity helpers. Transport and GJS lifecycle code live in extension.js.
// A BLE advertising address is NOT an identity for the paired BR/EDR device:
// do not merge unrelated Apple advertisements by name or manufacturer id.

export const BLUEZ = 'org.bluez';
export const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
export const PROPERTIES = 'org.freedesktop.DBus.Properties';
export const ADAPTER_IFACE = 'org.bluez.Adapter1';
export const GATT_CHAR_IFACE = 'org.bluez.GattCharacteristic1';
export const DEVICE_IFACE = 'org.bluez.Device1';
export const BATTERY_IFACE = 'org.bluez.Battery1';
export const BATTERY_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
export const LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb';
export const BATTERY_SERVICE_UUID = BATTERY_UUID;
export const BATTERY_LEVEL_UUID = LEVEL_UUID;

const BLUETOOTH_BASE = '-0000-1000-8000-00805f9b34fb';
const AUDIO_UUIDS = new Set([
    `0000110b${BLUETOOTH_BASE}`, // A2DP Audio Sink (includes speakers).
    `00001108${BLUETOOTH_BASE}`, // Headset.
    `0000111e${BLUETOOTH_BASE}`, // Hands-Free.
]);

// Product identifiers, not firmware-version guesses. Family identification is
// not a claim that every generation has been hardware-tested by this project.
// Protocol implementer's compatibility table:
// https://maniacx.github.io/BudsLink/airpods (consulted 2026-11-01).
const APPLE_AUDIO_PRODUCTS = new Map([
    [0x2002, 'AirPods'],
    [0x200f, 'AirPods'],
    [0x2013, 'AirPods'],
    [0x2019, 'AirPods'],
    [0x201b, 'AirPods'],
    [0x200e, 'AirPods Pro'],
    [0x2014, 'AirPods Pro'],
    [0x2024, 'AirPods Pro'],
    [0x200a, 'AirPods Max'],
    [0x201f, 'AirPods Max'],
]);

export function normalizeMac(value) {
    return typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)
        ? value.toUpperCase() : null;
}

export function macFromPath(path) {
    if (typeof path !== 'string')
        return null;
    const match = /^\/org\/bluez\/hci[0-9]+\/dev_((?:[0-9a-f]{2}_){5}[0-9a-f]{2})$/i.exec(path);
    return match ? normalizeMac(match[1].replace(/_/g, ':')) : null;
}

export function pathFromMac(mac, adapter = '/org/bluez/hci0') {
    const normalized = normalizeMac(mac);
    if (!normalized || typeof adapter !== 'string' || !/^\/org\/bluez\/hci[0-9]+$/.test(adapter))
        return null;
    return `${adapter}/dev_${normalized.replace(/:/g, '_')}`;
}

export function normalizeUuid(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.toLowerCase();
    if (/^[0-9a-f]{4}$/.test(text))
        return `0000${text}${BLUETOOTH_BASE}`;
    if (/^[0-9a-f]{8}$/.test(text))
        return `${text}${BLUETOOTH_BASE}`;
    if (/^[0-9a-f]{32}$/.test(text))
        return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(text) ? text : null;
}

export function uuidList(values) {
    return Array.isArray(values) ? [...new Set(values.map(normalizeUuid).filter(Boolean))] : [];
}

export function modelFromModalias(value) {
    if (typeof value !== 'string')
        return null;
    const match = /^bluetooth:v([0-9a-f]{4})p([0-9a-f]{4})d[0-9a-f]{4}$/i.exec(value);
    if (!match || Number.parseInt(match[1], 16) !== 0x004c)
        return null;
    return APPLE_AUDIO_PRODUCTS.get(Number.parseInt(match[2], 16)) ?? null;
}

export function displayName(value) {
    // St.Label receives plain text, not markup. Avoid newlines/control characters
    // or an unbounded Bluetooth alias in a fixed-size popup nonetheless.
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120)
        : '';
}

export function normalizeModel(name, modalias = null) {
    const identified = modelFromModalias(modalias);
    if (identified)
        return identified;
    const text = displayName(name);
    // Specific names must precede the common AirPods prefix. Also recognize
    // user aliases such as "Terentiy's AirPods Pro" without changing the label.
    if (/\bairpods\s+max\b/i.test(text))
        return 'AirPods Max';
    if (/\bairpods\s+pro\b/i.test(text))
        return 'AirPods Pro';
    if (/\bairpods\b/i.test(text))
        return 'AirPods';
    return text;
}

export function isAirPods(name, modalias = null) {
    return ['AirPods', 'AirPods Pro', 'AirPods Max'].includes(normalizeModel(name, modalias));
}

export function looksLikeHeadphones(device) {
    if (!device || typeof device !== 'object')
        return false;
    if (uuidList(device.UUIDs).some(uuid => AUDIO_UUIDS.has(uuid)))
        return true;
    const cls = device.Class;
    if (Number.isInteger(cls) && cls >= 0 && cls <= 0xffffff) {
        const major = (cls >> 8) & 0x1f;
        const minor = (cls >> 2) & 0x3f;
        // Audio/Video minor classes: 1 wearable headset, 2 hands-free,
        // 6 headphones. The old 4/5 check matched portable/car audio instead.
        if (major === 0x04 && [0x01, 0x02, 0x06].includes(minor))
            return true;
    }
    return device.Icon === 'audio-headphones' || device.Icon === 'audio-headset';
}

export function identifyDevice(props, path) {
    if (!props || typeof props !== 'object' || !macFromPath(path))
        return null;
    // Device1.Address is authoritative once BlueZ has resolved an identity.
    // Never substitute another advertising object's address heuristically.
    const mac = props.Address === undefined ? macFromPath(path) : normalizeMac(props.Address);
    if (!mac)
        return null;
    const name = displayName(props.Alias) || displayName(props.Name) || 'Наушники';
    const model = normalizeModel(props.Name || name, props.Modalias) || name;
    const adapterPath = typeof props.Adapter === 'string' && /^\/org\/bluez\/hci[0-9]+$/.test(props.Adapter)
        ? props.Adapter : path.slice(0, path.lastIndexOf('/'));
    return {
        mac,
        path,
        displayName: name,
        model,
        isAirPods: isAirPods(props.Name || name, props.Modalias),
        connected: props.Connected === true,
        paired: props.Paired === true,
        trusted: props.Trusted === true,
        adapterPath,
    };
}
