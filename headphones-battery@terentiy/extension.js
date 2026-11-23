import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Estimator, formatDuration} from './estimator.js';
import {SLEEP_AFTER, moodFor} from './pet.js';
import {DeviceCard, PanelGlyph, RollingLabel} from './ui.js';
import {presentDevice} from './presentation.js';
import {
    normalizeMac, macFromPath, normalizeUuid, displayName,
    DEVICE_IFACE, BATTERY_IFACE, GATT_CHAR_IFACE, LEVEL_UUID,
} from './bluez.js';
import {BlueZMonitor} from './bluez-monitor.js';
import {BatteryState, validPercentage} from './airpods.js';
import {AapSession} from './aap-session.js';
import {StateStore} from './state-store.js';
import {planDevices, findBatteryTarget} from './registry.js';

const AUDIO_KINDS = new Set([
    UPower.DeviceKind.HEADPHONES, UPower.DeviceKind.HEADSET, UPower.DeviceKind.OTHER_AUDIO,
]);
const TICK_SECONDS = 15;
const SAVE_EVERY_TICKS = 4;
const LE_READ_SECONDS = 60;
const LE_RETRY_MIN = 30;
const LE_RETRY_MAX = 300;
const monotonic = () => GLib.get_monotonic_time() / 1e6;
const cancelled = error => error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Headphones Battery');
        this.menu.actor.add_style_class_name('hp-menu');
        const box = new St.BoxLayout({style_class: 'hp-panel-box'});
        this.glyph = new PanelGlyph();
        this.pct = new RollingLabel({style_class: 'hp-panel-pct'});
        this.time = new RollingLabel({style_class: 'hp-panel-time', opacity: 150});
        box.add_child(this.glyph);
        box.add_child(this.pct);
        box.add_child(this.time);
        this.add_child(box);
        this._shown = false;
        this.visible = false;
    }
    setShown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        this.remove_transition('opacity');
        if (shown) {
            this.visible = true;
            this.opacity = 0;
            this.ease({opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this.glyph.pop();
        } else {
            this.ease({
                opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (!this._shown)
                        this.visible = false;
                },
            });
        }
    }
});

export default class HeadphonesBatteryExtension extends Extension {
    enable() {
        if (this._enabled)
            return;
        this._generation = (this._generation || 0) + 1;
        this._enabled = true;
        this._ready = false;
        this._suspended = false;
        this._cancellable = new Gio.Cancellable();
        this._audio = new Map(); // Stable identity -> entry; provider order cannot change the key.
        // Retiring processes may outlive an entry, but a replacement may not
        // take the same AirPods channel until the old process is fully reaped.
        this._retiringAap ??= new Map();
        this._upower = new Map(); // UPower path -> signal ownership and last observation.
        this._plans = new Map();
        this._ticks = 0;
        this._lastTick = monotonic();
        this._shownLevel = null;
        this._shownHours = null;
        this._shownDevice = null;
        this._stateWarning = null;
        this._mixerIds = [];
        this._clientIds = [];
        this._bluezOnline = null;
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._sessionId = Main.sessionMode.connect('updated', () => {
            for (const entry of this._audio.values()) {
                if (Main.sessionMode.isLocked)
                    entry.card.hero.pause();
            }
            this._refresh();
        });
        this._menuId = this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!this._ready)
                return;
            this._account();
            for (const entry of this._audio.values()) {
                if (open && !Main.sessionMode.isLocked) {
                    entry.card.hero.play();
                    this._pollLe(entry, true);
                } else {
                    entry.card.hero.pause();
                }
            }
            this._refresh();
        });
        const epoch = this._generation;
        const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'headphones-battery', 'state.json']);
        this._store = new StateStore(path, {onError: message => {
            if (this._alive(epoch)) {
                this._stateWarning = message;
                this._refresh();
            }
        }});
        this._initialize(epoch).catch(error => {
            if (this._alive(epoch) && !cancelled(error))
                console.error('[' + this.uuid + '] initialization failed: ' + error.message);
        });
    }
    _alive(epoch) {
        return this._enabled && this._generation === epoch;
    }
    async _initialize(epoch) {
        // Re-enable must not race the previous instance's final atomic write.
        await this._pendingSave;
        if (!this._alive(epoch))
            return;
        const state = await this._store.load(this._cancellable);
        if (!this._alive(epoch))
            return;
        this._estimator = new Estimator(state);
        const history = state?.batteryHistory;
        this._estimator.state.batteryHistory = history && typeof history === 'object' && !Array.isArray(history)
            ? history : {};

        this._mixer = getMixerControl();
        this._mixerIds = ['stream-added', 'stream-removed'].map(signal =>
            this._mixer.connect(signal, () => {
                if (!this._alive(epoch))
                    return;
                this._account();
                this._refresh();
            }));
        this._ready = true;
        this._lastTick = monotonic();
        this._bluez = new BlueZMonitor({
            onAvailability: online => {
                if (!this._alive(epoch))
                    return;
                this._account();
                this._bluezOnline = online;
                this._syncRegistry();
                this._refresh();
            },
            onUpdate: (path, interfaces, event) => {
                if (this._alive(epoch))
                    this._onBlueZUpdate(path, interfaces, event);
            },
            log: message => {
                if (this._alive(epoch))
                    console.warn('[' + this.uuid + '] ' + message);
            },
        });
        this._bluez.start();
        this._setupUPower(epoch);
        this._watchSuspend(epoch);
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            if (!this._alive(epoch))
                return GLib.SOURCE_REMOVE;
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }
    disable() {
        if (!this._enabled)
            return;
        this._account();
        const state = this._estimator?.state;
        this._enabled = false;
        this._generation++;
        this._cancellable?.cancel();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = 0;
        if (this._menuId)
            this._indicator?.menu.disconnect(this._menuId);
        this._menuId = 0;
        if (this._loginSignal)
            this._loginConnection.signal_unsubscribe(this._loginSignal);
        this._loginSignal = 0;
        this._loginConnection = null; // Shared bus: NEVER close it.
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._mixerIds = [];
        for (const entry of [...this._audio.values()])
            this._dropEntry(entry);
        this._bluez?.stop();
        this._bluez = null;
        for (const record of this._upower.values())
            record.dev.disconnect(record.notifyId);
        this._upower.clear();
        if (this._client) {
            this._clientIds.forEach(id => this._client.disconnect(id));
            this._client = null;
        }
        this._clientIds = [];
        this._plans.clear();
        this._indicator?.destroy();
        this._indicator = null;
        this._ready = false;
        this._estimator = null;
        this._mixer = null;
        this._cancellable = null;
        // The store owns its completion, not Shell actors; no timer/signal remains.
        this._pendingSave = this._store?.close(state);
        this._store = null;
    }

    // ---- UPower observations, independently owned from canonical entries ----
    _setupUPower(epoch) {
        UPower.Client.new_async(this._cancellable, (_source, result) => {
            let client;
            try {
                client = UPower.Client.new_finish(result);
            } catch (error) {
                if (this._alive(epoch) && !cancelled(error))
                    console.warn('[' + this.uuid + '] UPower is unavailable.');
                return;
            }
            if (!this._alive(epoch))
                return;
            this._client = client;
            this._clientIds = [
                client.connect('device-added', (_client, device) => this._addUPower(device, epoch)),
                client.connect('device-removed', (_client, path) => this._removeUPower(path)),
            ];
            for (const device of client.get_devices())
                this._addUPower(device, epoch);
        });
    }
    _describeUPower(dev) {
        const path = dev.get_object_path();
        const nativePath = dev.native_path || '';
        const mac = normalizeMac(dev.serial) || macFromPath(nativePath);
        return {
            path, nativePath, mac, id: mac || dev.serial || nativePath || path,
            model: displayName(dev.model) || 'Наушники',
            audio: AUDIO_KINDS.has(dev.kind), isPresent: dev.is_present,
        };
    }
    _readUPower(record, observed = false) {
        const dev = record.dev;
        let level = Number.isFinite(dev.percentage) ? Math.round(dev.percentage) : null;
        if (!validPercentage(level) || dev.is_present === false)
            level = null;
        // UPower unset defaults are zero; a genuine EMPTY=0 reading remains valid.
        if (level === 0 && dev.state === UPower.DeviceState.UNKNOWN &&
            dev.battery_level === UPower.DeviceLevel.UNKNOWN)
            level = null;
        const charging = dev.state === UPower.DeviceState.CHARGING ? true :
            [UPower.DeviceState.DISCHARGING, UPower.DeviceState.EMPTY,
                UPower.DeviceState.FULLY_CHARGED].includes(dev.state) ? false : null;
        const now = monotonic();
        const wallNow = Date.now() / 1000;
        // A daemon cache timestamp far in the future is not evidence of a
        // current reading (for example after a wall-clock correction).
        const wallAge = Number.isFinite(dev.update_time) && dev.update_time > 0 &&
            dev.update_time <= wallNow + 5
            ? Math.max(0, wallNow - dev.update_time) : null;
        // A real percentage/update-time notification is a new observation even
        // on backends which do not expose UpdateTime. Metadata/status changes
        // alone must not make an old percentage fresh.
        const previous = record.sample;
        record.sample = {
            level, charging,
            at: observed ? now : previous?.at ??
                (wallAge === null ? now : Math.max(0, now - wallAge)),
            cached: observed ? false : previous?.cached ?? (wallAge === null || wallAge > now),
        };
        record.sequence++;
    }
    _addUPower(dev, epoch) {
        if (!this._alive(epoch))
            return;
        const path = dev.get_object_path();
        if (this._upower.has(path))
            return;
        const descriptor = this._describeUPower(dev);
        if (!descriptor.audio && !descriptor.nativePath.startsWith('/org/bluez/'))
            return;
        const record = {dev, descriptor, sequence: 0};
        this._readUPower(record);
        record.notifyId = dev.connect('notify', (_device, pspec) => {
            if (!this._alive(epoch) || this._upower.get(path) !== record)
                return;
            const name = pspec.name;
            if (!['percentage', 'state', 'is-present', 'kind', 'model', 'serial',
                'native-path', 'battery-level', 'update-time'].includes(name))
                return;
            this._account();
            record.descriptor = this._describeUPower(dev);
            if (['percentage', 'state', 'is-present', 'battery-level', 'update-time'].includes(name))
                this._readUPower(record, name === 'percentage' || name === 'update-time');
            this._syncRegistry();
            this._refresh();
        });
        this._upower.set(path, record);
        this._syncRegistry();
        this._refresh();
    }
    _removeUPower(path) {
        const record = this._upower.get(path);
        if (!record)
            return;
        this._account();
        record.dev.disconnect(record.notifyId);
        this._upower.delete(path);
        this._syncRegistry();
        this._refresh();
    }

    // ---- Merge providers without changing a canonical key ----
    _syncRegistry() {
        if (!this._ready || !this._enabled)
            return;
        const objects = this._bluez?.objects || new Map();
        const plans = planDevices(objects, [...this._upower.values()].map(r => r.descriptor),
            this._bluezOnline);
        this._plans = plans;
        for (const [id, entry] of this._audio) {
            if (!plans.has(id))
                this._dropEntry(entry);
        }
        for (const [id, plan] of plans) {
            let entry = this._audio.get(id);
            if (!entry)
                entry = this._createEntry(plan);
            const old = entry.plan;
            const identityChanged = old.bluezPath !== plan.bluezPath ||
                old.adapterAddress !== plan.adapterAddress || old.airpods !== plan.airpods;
            entry.plan = plan;
            if (identityChanged) {
                this._stopAap(entry);
                entry.battery.setSourceAvailable('aap', false);
                entry.battery.removeSource('battery1');
                entry.battery1Seeded = false;
                this._resetLe(entry);
            }
            if (entry.displayName !== plan.displayName) {
                entry.displayName = plan.displayName;
                entry.card.setName?.(plan.displayName);
            }
            const paths = new Set(plan.upowerPaths);
            for (const path of entry.upowerSequences.keys()) {
                if (!paths.has(path))
                    entry.upowerSequences.delete(path);
            }
            if (!paths.size)
                entry.battery.removeSource('hfp');
            for (const path of paths) {
                const record = this._upower.get(path);
                if (!record || entry.upowerSequences.get(path) === record.sequence)
                    continue;
                entry.upowerSequences.set(path, record.sequence);
                const sample = record.sample;
                entry.battery.updateLevel('hfp', sample.level, sample.at, {
                    charging: sample.charging, resolution: 10, cached: sample.cached,
                });
            }
            // An existing daemon cache is not a newly observed radio measurement.
            if (!entry.battery1Seeded && plan.bluezPath) {
                entry.battery1Seeded = true;
                const props = objects.get(plan.bluezPath)?.[BATTERY_IFACE];
                if (validPercentage(props?.Percentage))
                    entry.battery.updateLevel('battery1', props.Percentage, monotonic(), {cached: true});
            }
            this._ensureAap(entry);
            this._ensureLe(entry);
        }
    }
    _createEntry(plan) {
        const entry = {
            id: plan.id, plan, displayName: plan.displayName,
            battery: new BatteryState(plan.address), tracks: new Map(),
            upowerSequences: new Map(), battery1Seeded: false,
            sink: null, stream: null, streamIds: [], lastPlay: monotonic(),
            session: null, diagnostic: null, le: null, leSerial: 0,
        };
        entry.battery.restoreHistory(this._estimator.state.batteryHistory?.[entry.id], monotonic());
        this._audio.set(entry.id, entry);
        this._buildMenu(entry);
        return entry;
    }
    _entryAlive(entry) {
        return this._enabled && this._audio.get(entry.id) === entry;
    }
    _dropEntry(entry) {
        this._audio.delete(entry.id); // Invalidate async consumers before cleanup.
        this._stopAap(entry);
        entry.leSerial++;
        this._unwatchSink(entry);
        for (const id of entry.tracks.keys())
            this._estimator?.detach(id);
        entry.tracks.clear();
        entry.battery.clear();
        entry.section?.destroy();
    }
    _onBlueZUpdate(path, interfaces, event) {
        this._account();
        this._syncRegistry();
        const isBatteryEvent = event.interfaceName === BATTERY_IFACE ||
            event.kind === 'initial' || event.kind === 'object-added';
        for (const entry of this._audio.values()) {
            if (entry.plan.bluezPath !== path || !isBatteryEvent)
                continue;
            const props = interfaces?.[BATTERY_IFACE];
            if (!props || (event.invalidated || []).includes('Percentage')) {
                entry.battery.removeSource('battery1');
                continue;
            }
            if (event.kind !== 'properties' || (event.changed || []).includes('Percentage')) {
                entry.battery.updateLevel('battery1',
                    validPercentage(props.Percentage) ? props.Percentage : null,
                    monotonic(), {cached: event.kind === 'initial'});
            }
        }
        this._refresh();
    }

    // ---- AAP: one asynchronous process per connected, paired AirPods ----
    _stopAap(entry) {
        const session = entry.session;
        if (!session)
            return;
        entry.session = null; // Ignore synchronous stop/status callbacks.
        const address = entry.plan.address;
        const previous = this._retiringAap.get(address);
        const fence = Promise.all([previous, session.stop()]).catch(() => {}).then(() => {
            if (this._retiringAap.get(address) !== fence)
                return;
            this._retiringAap.delete(address);
            if (this._enabled && this._ready && !this._suspended) {
                const current = this._audio.get(entry.id);
                if (current)
                    this._ensureAap(current);
            }
        });
        this._retiringAap.set(address, fence);
    }

    _ensureAap(entry) {
        const plan = entry.plan;
        const allowed = !this._suspended && plan.airpods && plan.address &&
            normalizeMac(plan.adapterAddress) &&
            plan.bluezProps?.Connected === true &&
            (plan.bluezProps?.Paired === true || plan.bluezProps?.Bonded === true);
        if (!allowed) {
            if (entry.session) {
                this._stopAap(entry);
                entry.battery.setSourceAvailable('aap', false);
            }
            return;
        }
        if (entry.session || this._retiringAap.has(plan.address))
            return;
        const session = new AapSession({
            helperPath: this.dir.get_child('headphones-battery-aap-helper').get_path(),
            address: plan.address, adapterAddress: plan.adapterAddress,
            onPacket: packet => {
                if (!this._entryAlive(entry) || entry.session !== session || this._suspended)
                    return;
                this._account();
                if (entry.battery.updateAap(packet, monotonic())) {
                    this._estimator.state.batteryHistory ??= {};
                    this._estimator.state.batteryHistory[entry.id] = entry.battery.snapshotHistory();
                    this._store?.save(this._estimator.state);
                    entry.diagnostic = null;
                    this._refresh();
                }
            },
            onStatus: status => {
                if (!this._entryAlive(entry) || entry.session !== session)
                    return;
                if (status.state !== 'live')
                    entry.battery.setSourceAvailable('aap', false);
                const messages = {
                    missing: 'AAP-хелпер не установлен. Выполните scripts/install.sh.',
                    permission: 'Система запретила AAP-соединение. Проверьте scripts/doctor.sh; не выдавайте права вслепую.',
                    backoff: 'AAP временно недоступен; повторное подключение с задержкой.',
                    connecting: 'Подключение к источнику заряда AirPods…',
                    error: 'AAP-хелпер завершился с ошибкой. Проверьте установку.',
                };
                entry.diagnostic = messages[status.state] || null;
                this._refresh();
            },
        });
        entry.session = session;
        session.start();
    }

    // ---- Standard Battery Service / unambiguous legacy JBL companion ----
    _resetLe(entry) {
        entry.leSerial++;
        entry.le = null;
        entry.battery.setSourceAvailable('le', false);
    }
    _ensureLe(entry) {
        if (this._suspended || !this._bluez?.online)
            return;
        const target = findBatteryTarget(entry.plan, this._bluez.objects, this._plans);
        if (!target) {
            if (entry.le)
                this._resetLe(entry);
            return;
        }
        if (entry.le?.path !== target.path) {
            this._resetLe(entry);
            entry.le = {
                path: target.path, char: null, busy: false, retryAt: 0,
                backoff: LE_RETRY_MIN, nextPoll: 0, lastRead: -Infinity,
            };
        }
        const le = entry.le;
        const token = entry.leSerial;
        const now = monotonic();
        if (!target.props.Connected || !target.props.ServicesResolved) {
            le.char = null;
            entry.battery.setSourceAvailable('le', false);
        }
        if (le.busy || now < le.retryAt)
            return;
        if (!target.props.Connected) {
            entry.battery.setSourceAvailable('le', false);
            if (!target.companion)
                return;
            le.busy = true;
            this._bluez.call(target.path, DEVICE_IFACE, 'Connect', null, null, 10000)
                .then(() => {
                    if (this._entryAlive(entry) && entry.le === le && entry.leSerial === token) {
                        le.busy = false;
                        le.retryAt = monotonic() + LE_RETRY_MIN;
                        le.backoff = LE_RETRY_MIN;
                        this._ensureLe(entry);
                    }
                }).catch(() => this._leFailure(entry, le, token));
            return;
        }
        if (!target.props.ServicesResolved)
            return;
        const chars = [...this._bluez.objects].filter(([path, ifaces]) =>
            path.startsWith(target.path + '/') &&
            normalizeUuid(ifaces[GATT_CHAR_IFACE]?.UUID) === LEVEL_UUID &&
            (!ifaces[GATT_CHAR_IFACE].Flags || ifaces[GATT_CHAR_IFACE].Flags.includes('read')));
        // Multiple characteristics may denote independent batteries; do not guess.
        le.char = chars.length === 1 ? chars[0][0] : null;
        if (!le.char)
            entry.battery.setSourceAvailable('le', false);
        if (le.char && now >= le.nextPoll)
            this._pollLe(entry);
    }
    _leFailure(entry, le, token) {
        if (!this._entryAlive(entry) || entry.le !== le || entry.leSerial !== token)
            return;
        le.busy = false;
        le.retryAt = monotonic() + le.backoff;
        le.backoff = Math.min(le.backoff * 2, LE_RETRY_MAX);
        entry.battery.setSourceAvailable('le', false);
        this._refresh();
    }
    _pollLe(entry, force = false) {
        const le = entry.le;
        const now = monotonic();
        if (!this._entryAlive(entry) || this._suspended || !le?.char || le.busy ||
            now < le.retryAt || now - le.lastRead < 10 || (!force && now < le.nextPoll))
            return;
        const token = entry.leSerial;
        const char = le.char;
        le.busy = true;
        le.lastRead = now;
        this._bluez.call(char, GATT_CHAR_IFACE, 'ReadValue',
            new GLib.Variant('(a{sv})', [{}]), new GLib.VariantType('(ay)'), 10000)
            .then(([bytes]) => {
                if (!this._entryAlive(entry) || entry.le !== le || entry.leSerial !== token)
                    return;
                le.busy = false;
                if (le.char !== char || this._suspended)
                    return;
                const current = this._bluez.objects.get(le.path)?.[DEVICE_IFACE];
                if (!current?.Connected || !current.ServicesResolved ||
                    !this._bluez.objects.get(char)?.[GATT_CHAR_IFACE]) {
                    this._leFailure(entry, le, token);
                    return;
                }
                if (!bytes || bytes.length !== 1 || !validPercentage(bytes[0])) {
                    this._leFailure(entry, le, token);
                    return;
                }
                this._account();
                le.busy = false;
                le.retryAt = 0;
                le.backoff = LE_RETRY_MIN;
                le.nextPoll = monotonic() + LE_READ_SECONDS;
                entry.battery.updateLevel('le', bytes[0], monotonic(), {resolution: 1});
                this._refresh();
            }).catch(() => this._leFailure(entry, le, token));
    }

    // ---- Per-battery learning and audio accounting ----
    _syncLearning(entry, battery) {
        const wanted = new Map();
        for (const component of ['left', 'right']) {
            const reading = battery.components[component];
            if (reading?.source === 'aap' && !reading.stale && validPercentage(reading.level) &&
                ['charging', 'discharging'].includes(reading.status))
                wanted.set(entry.id + ':' + component, {reading, source: 'airpods'});
        }
        const overall = battery.overall;
        if (overall && overall.source !== 'aap' && !overall.stale && validPercentage(overall.level))
            wanted.set(entry.id, {reading: overall, source: overall.source});
        for (const [id] of entry.tracks) {
            if (!wanted.has(id)) {
                this._estimator.detach(id);
                entry.tracks.delete(id);
            }
        }
        for (const [id, {reading, source}] of wanted) {
            const previous = entry.tracks.get(id);
            if (previous?.source === source && previous.at === reading.receivedAt &&
                previous.level === reading.level && previous.charging === reading.charging)
                continue;
            const options = {charging: reading.charging, resolution: reading.resolution ?? 10};
            if (!previous || previous.source !== source) {
                this._estimator.detach(id);
                this._estimator.attach(id, entry.plan.model, source, reading.level, options);
            } else {
                this._estimator.observe(id, entry.plan.model, source, reading.level, options);
            }
            entry.tracks.set(id, {source, at: reading.receivedAt, level: reading.level,
                charging: reading.charging});
        }
    }
    _findSink(mac) {
        const normalized = normalizeMac(mac);
        if (!normalized || !this._mixer)
            return null;
        const suffix = normalized.replaceAll(':', '_');
        const prefixes = ['bluez_output.' + suffix, 'bluez_sink.' + suffix];
        return this._mixer.get_sinks().find(stream => {
            const name = stream.get_name()?.toUpperCase();
            return name && prefixes.some(prefix => name === prefix.toUpperCase() ||
                name.startsWith(prefix.toUpperCase() + '.'));
        }) || null;
    }
    _sinkState(stream) {
        if (!stream)
            return {mode: 'idle', u: 0, volume: 0};
        const maximum = this._mixer?.get_vol_max_norm() || 1;
        const raw = stream.get_volume() / maximum;
        const volume = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 1)) : 0;
        return {
            mode: stream.get_state() === Gvc.MixerStreamState.RUNNING ? 'play' : 'idle',
            u: stream.get_is_muted() ? 0 : volume ** 3, volume,
        };
    }
    _watchSink(entry, stream) {
        if (entry.stream === stream)
            return;
        this._unwatchSink(entry);
        entry.stream = stream;
        if (stream) {
            entry.streamIds = ['notify::state', 'notify::volume', 'notify::is-muted'].map(signal =>
                stream.connect(signal, () => {
                    if (this._entryAlive(entry)) {
                        this._account();
                        this._refresh();
                    }
                }));
        }
    }
    _unwatchSink(entry) {
        if (entry.stream)
            entry.streamIds.forEach(id => entry.stream.disconnect(id));
        entry.streamIds = [];
        entry.stream = null;
    }
    _account() {
        if (!this._ready || !this._estimator)
            return;
        const now = monotonic();
        const elapsed = Math.max(0, now - this._lastTick);
        this._lastTick = now;
        for (const entry of this._audio.values()) {
            const stream = this._findSink(entry.plan.address);
            const state = this._sinkState(stream);
            const spent = entry.sink || state;
            if (elapsed > TICK_SECONDS * 6 || this._suspended) {
                for (const id of entry.tracks.keys())
                    this._estimator.detach(id);
                entry.tracks.clear();
            } else {
                this._syncLearning(entry, entry.battery.select(now));
                for (const id of entry.tracks.keys())
                    this._estimator.account(id, elapsed / 3600, spent.mode, spent.u);
            }
            if (spent.mode === 'play' || state.mode === 'play')
                entry.lastPlay = now;
            entry.sink = state;
            this._watchSink(entry, stream);
        }
    }
    _tick() {
        this._account();
        for (const entry of this._audio.values())
            this._ensureLe(entry);
        if (++this._ticks % SAVE_EVERY_TICKS === 0)
            this._store?.save(this._estimator.state);
        this._refresh();
    }
    _watchSuspend(epoch) {
        Gio.bus_get(Gio.BusType.SYSTEM, this._cancellable, (_source, result) => {
            let connection;
            try {
                connection = Gio.bus_get_finish(result);
            } catch {
                return;
            }
            if (!this._alive(epoch))
                return;
            this._loginConnection = connection;
            this._loginSignal = connection.signal_subscribe('org.freedesktop.login1',
                'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1',
                null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
                    if (!this._alive(epoch))
                        return;
                    this._account();
                    const [sleeping] = params.unpack();
                    this._suspended = sleeping;
                    this._lastTick = monotonic();
                    for (const entry of this._audio.values()) {
                        this._stopAap(entry);
                        this._resetLe(entry);
                        for (const source of ['aap', 'le', 'battery1', 'hfp'])
                            entry.battery.setSourceAvailable(source, false);
                        for (const id of entry.tracks.keys())
                            this._estimator.detach(id);
                        entry.tracks.clear();
                        if (!sleeping) {
                            this._ensureAap(entry);
                            this._ensureLe(entry);
                        }
                    }
                    this._refresh();
                });
        });
    }

    // ---- Device-driven visibility; an estimator is not required to show UI ----
    _buildMenu(entry) {
        const section = new PopupMenu.PopupMenuSection();
        entry.card = new DeviceCard(entry.displayName);
        section.box.add_child(entry.card);
        const reset = new PopupMenu.PopupMenuItem('Сбросить статистику разряда');
        reset.add_style_class_name('hp-action');
        reset.connect('activate', () => {
            if (!this._entryAlive(entry))
                return;
            for (const id of [entry.id, entry.id + ':left', entry.id + ':right'])
                this._estimator.reset(id);
            this._store?.save(this._estimator.state);
            this._refresh();
        });
        section.addMenuItem(reset);
        this._indicator.menu.addMenuItem(section);
        entry.section = section;
    }
    _estimate(entry, battery, sink) {
        if (!battery.playback || this._suspended)
            return {est: null, component: null, componentEstimates: {}};
        if (battery.overall?.source === 'aap') {
            const estimates = [];
            for (const component of ['left', 'right']) {
                if (!battery.components[component]?.eligibleForEstimate)
                    continue;
                const est = this._estimator.estimate(entry.id + ':' + component, 'airpods',
                    {playing: sink.mode === 'play', u: sink.u});
                if (est)
                    estimates.push({est, component});
            }
            const first = estimates.sort((a, b) => a.est.hours - b.est.hours)[0];
            return {...(first || {est: null, component: null}),
                componentEstimates: Object.fromEntries(estimates.map(item => [item.component, item.est]))};
        }
        return {
            est: this._estimator.estimate(entry.id, battery.overall.source,
                {playing: sink.mode === 'play', u: sink.u}),
            component: null,
        };
    }
    _refresh() {
        if (!this._enabled || !this._ready || !this._indicator)
            return;
        const now = monotonic();
        const candidates = [];
        for (const entry of this._audio.values()) {
            const battery = entry.battery.select(now);
            if (!this._suspended)
                this._syncLearning(entry, battery);
            const sink = entry.sink || this._sinkState(this._findSink(entry.plan.address));
            const playing = sink.mode === 'play';
            const {est, component, componentEstimates} = this._estimate(entry, battery, sink);
            const idleFor = playing ? 0 : now - entry.lastPlay;
            const info = {
                battery, est, componentEstimates, airpods: entry.plan.airpods, playing, idleFor, volume: sink.volume,
                sleeping: !playing && idleFor >= SLEEP_AFTER,
                mood: est ? moodFor(est.hours) : null, estimateComponent: component,
                diagnostic: entry.diagnostic || this._stateWarning,
            };
            entry.card.update(info);
            candidates.push({entry, info, view: presentDevice(info)});
        }
        candidates.sort((a, b) => Number(b.info.playing) - Number(a.info.playing) ||
            (a.view.hours ?? Infinity) - (b.view.hours ?? Infinity));
        const main = candidates[0];
        const indicator = this._indicator;
        if (main) {
            const {entry, info, view} = main;
            if (this._shownDevice !== entry.id) {
                this._shownLevel = null;
                this._shownHours = null;
                this._shownDevice = entry.id;
            }
            const direction = (previous, next) => previous === null || next === null
                ? 0 : Math.sign(next - previous);
            indicator.pct.set(view.pctText, direction(this._shownLevel, view.value));
            indicator.time.set(view.estimateKnown ? '~' + formatDuration(view.hours, true) : '',
                direction(this._shownHours, view.hours));
            indicator.glyph.set({...info, batteryKnown: view.batteryKnown,
                estimateKnown: view.estimateKnown});
            indicator.accessible_name = entry.displayName + ': ' + view.pctText +
                (view.estimateKnown ? ', музыки примерно на ' + formatDuration(view.hours) : ', ' + view.status);
            this._shownLevel = view.value;
            this._shownHours = view.hours;
        } else {
            this._shownDevice = null;
            this._shownLevel = null;
            this._shownHours = null;
        }
        indicator.setShown(!!main && !Main.sessionMode.isLocked);
    }
}
