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

const AUDIO_KINDS = new Set([
    UPower.DeviceKind.HEADPHONES,
    UPower.DeviceKind.HEADSET,
    UPower.DeviceKind.OTHER_AUDIO,
]);
const BATTERY_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
const TICK_SECONDS = 15;
const SAVE_EVERY_TICKS = 4;
const LE_RETRY_MIN = 30;
const LE_RETRY_MAX = 300;

const monotonic = () => GLib.get_monotonic_time() / 1e6;

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
                opacity: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
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
        this._statePath = GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'headphones-battery', 'state.json']);
        this._estimator = new Estimator(this._loadState());
        this._audio = new Map();    // UPower path -> headphones entry
        this._others = new Map();   // UPower path -> other Bluetooth battery (BLE companion candidates)
        this._mixer = getMixerControl();
        // the Bluetooth sink shows up a moment after the headphones connect
        this._mixerIds = ['stream-added', 'stream-removed'].map(sig =>
            this._mixer.connect(sig, () => {
                this._account();
                this._refresh();
            }));
        this._ticks = 0;
        this._lastTick = monotonic();
        this._shownHours = null;
        this._shownLevel = null;

        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._sessionId = Main.sessionMode.connect('updated', () => this._refresh());
        this._menuId = this._indicator.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
            for (const entry of this._audio.values()) {
                if (open)
                    entry.card.hero.play();
                else
                    entry.card.hero.pause();
            }
        });

        this._cancellable = new Gio.Cancellable();
        UPower.Client.new_async(this._cancellable, (_src, res) => {
            try {
                this._client = UPower.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`[${this.uuid}] UPower client failed: ${e.message}`);
                return;
            }
            this._clientIds = [
                this._client.connect('device-added', (_c, dev) => this._addDevice(dev)),
                this._client.connect('device-removed', (_c, path) => this._removeDevice(path)),
            ];
            for (const dev of this._client.get_devices())
                this._addDevice(dev);
        });

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._cancellable.cancel();
        GLib.source_remove(this._tickId);
        Main.sessionMode.disconnect(this._sessionId);
        this._indicator.menu.disconnect(this._menuId);
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._account();
        this._save();
        if (this._client) {
            this._clientIds.forEach(id => this._client.disconnect(id));
            this._client = null;
        }
        for (const entry of this._audio.values()) {
            entry.dev.disconnect(entry.notifyId);
            this._unwatchSink(entry);
            this._unlink(entry);
        }
        this._audio.clear();
        this._others.clear();
        this._indicator.destroy();
        this._indicator = null;
        this._estimator = null;
        this._mixer = null;
        this._cancellable = null;
    }

    // --- devices ---------------------------------------------------------

    _addDevice(dev) {
        const path = dev.get_object_path();
        if (this._audio.has(path) || this._others.has(path))
            return;

        if (!AUDIO_KINDS.has(dev.kind)) {
            if (dev.native_path?.startsWith('/org/bluez/')) {
                this._others.set(path, {dev});
                this._linkAll();
            }
            return;
        }

        const entry = {
            path, dev,
            id: dev.serial || dev.native_path || path,
            model: dev.model || 'Наушники',
            companion: null,
            sink: null,
            stream: null,
            streamIds: [],
            lastPlay: monotonic(),
            leBusy: false,
            leBackoff: LE_RETRY_MIN,
            leRetryAt: 0,
        };
        this._estimator.attach(entry.id, entry.model, 'hfp', Math.round(dev.percentage));
        entry.notifyId = dev.connect('notify::percentage', () => {
            this._observe(entry, 'hfp', Math.round(dev.percentage));
        });
        this._buildMenu(entry);
        this._audio.set(path, entry);
        this._account();    // picks up the sink and starts following it
        this._linkAll();
        this._ensureLe(entry);
        this._save();
        this._refresh();
    }

    _removeDevice(path) {
        if (this._others.has(path)) {
            for (const entry of this._audio.values()) {
                if (entry.companion?.path === path)
                    this._unlink(entry);
            }
            this._others.delete(path);
            this._refresh();
            return;
        }

        const entry = this._audio.get(path);
        if (!entry)
            return;
        this._account();
        entry.dev.disconnect(entry.notifyId);
        this._unwatchSink(entry);
        this._unlink(entry);
        entry.section.destroy();
        this._audio.delete(path);
        this._save();
        this._refresh();
    }

    // The BLE side of the same headphones (e.g. "JBL TUNE520BT-LE") reports the
    // battery with 1% resolution, unlike the 10% HFP steps.
    _linkAll() {
        for (const entry of this._audio.values()) {
            if (entry.companion)
                continue;
            for (const [path, other] of this._others) {
                const model = other.dev.model ?? '';
                if (!model.startsWith(entry.model) || other.dev.serial === entry.id)
                    continue;
                if ([...this._audio.values()].some(e => e.companion?.path === path))
                    continue;
                const dev = other.dev;
                entry.companion = {
                    path, dev,
                    notifyId: dev.connect('notify::percentage', () => {
                        this._observe(entry, 'le', Math.round(dev.percentage));
                    }),
                };
                this._estimator.state.companions[model] = entry.id;
                this._estimator.attach(entry.id, entry.model, 'le', Math.round(dev.percentage));
                entry.leBackoff = LE_RETRY_MIN;
                this._refresh();
                break;
            }
        }
    }

    _unlink(entry) {
        if (!entry.companion)
            return;
        entry.companion.dev.disconnect(entry.companion.notifyId);
        entry.companion = null;
    }

    _observe(entry, src, level) {
        this._account();
        const sample = this._estimator.observe(entry.id, entry.model, src, level);
        if (sample) {
            const t = sample.theta.map(v => v.toFixed(2)).join(', ');
            console.log(`[${this.uuid}] ${entry.model} ${src} ${level}%: drop ${sample.y}% ` +
                `predicted ${sample.predicted.toFixed(2)}% (idle ${(sample.x[0] * 60).toFixed(0)}m, ` +
                `play ${(sample.x[1] * 60).toFixed(0)}m) → θ=[${t}]`);
        }
        this._save();
        this._refresh();
    }

    // Keep the BLE companion connected while the headphones are connected.
    // It is not paired, so BlueZ never reconnects it on its own.
    _ensureLe(entry) {
        if (entry.companion || entry.leBusy || monotonic() < entry.leRetryAt)
            return;
        entry.leBusy = true;

        const finish = ok => {
            entry.leBusy = false;
            entry.leBackoff = ok ? LE_RETRY_MIN : Math.min(entry.leBackoff * 2, LE_RETRY_MAX);
            entry.leRetryAt = monotonic() + entry.leBackoff;
        };
        const cancelled = e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

        Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', null, null, Gio.DBusCallFlags.NONE, 10000, this._cancellable,
            (conn, res) => {
                let target = null;
                try {
                    const [objects] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        const d = ifaces['org.bluez.Device1'];
                        if (d && d.Address !== entry.id && (d.Alias ?? '').startsWith(entry.model) &&
                            (d.UUIDs ?? []).includes(BATTERY_UUID)) {
                            target = {path, connected: d.Connected};
                            break;
                        }
                    }
                } catch (e) {
                    if (cancelled(e))
                        return;
                    console.warn(`[${this.uuid}] BlueZ query failed: ${e.message}`);
                }
                if (!target || target.connected || !this._audio.has(entry.path)) {
                    finish(!!target);
                    return;
                }
                conn.call('org.bluez', target.path, 'org.bluez.Device1', 'Connect',
                    null, null, Gio.DBusCallFlags.NONE, 30000, this._cancellable,
                    (c, r) => {
                        try {
                            c.call_finish(r);
                            finish(true);
                        } catch (e) {
                            if (cancelled(e))
                                return;
                            finish(false);
                        }
                    });
            });
    }

    // --- accounting ------------------------------------------------------

    _findSink(mac) {
        const prefix = `bluez_output.${mac.replace(/:/g, '_')}`;
        return this._mixer?.get_sinks().find(s => s.get_name()?.startsWith(prefix)) ?? null;
    }

    _sinkState(stream) {
        if (!stream)
            return {mode: 'idle', u: 0, volume: 0};
        const volume = Math.min(stream.get_volume() / this._mixer.get_vol_max_norm(), 1);
        return {
            mode: stream.get_state() === Gvc.MixerStreamState.RUNNING ? 'play' : 'idle',
            u: stream.get_is_muted() ? 0 : volume ** 3,
            volume,
        };
    }

    // Follow play/pause and volume as they happen, so the cat reacts at once
    // and the time is booked under the state it was really spent in.
    _watchSink(entry, stream) {
        if (entry.stream === stream)
            return;
        this._unwatchSink(entry);
        entry.stream = stream;
        if (!stream)
            return;
        const changed = () => {
            this._account();
            this._refresh();
        };
        entry.streamIds = [
            stream.connect('notify::state', changed),
            stream.connect('notify::volume', changed),
            stream.connect('notify::is-muted', changed),
        ];
    }

    _unwatchSink(entry) {
        entry.streamIds.forEach(id => entry.stream.disconnect(id));
        entry.streamIds = [];
        entry.stream = null;
    }

    // Book the time since the previous call under the state it was spent in.
    _account() {
        const now = monotonic();
        // Cap the step: suspend stops the monotonic clock anyway, stalls should not count double.
        const dt = Math.min(now - this._lastTick, 4 * TICK_SECONDS) / 3600;
        this._lastTick = now;

        const connected = new Set();
        for (const entry of this._audio.values()) {
            const stream = this._findSink(entry.id);
            const state = this._sinkState(stream);
            const spent = entry.sink ?? state;
            this._estimator.account(entry.id, dt, spent.mode, spent.u);
            if (spent.mode === 'play' || state.mode === 'play')
                entry.lastPlay = now;
            entry.sink = state;
            this._watchSink(entry, stream);
            connected.add(entry.id);
        }
        // BLE companion alive while the headphones are connected elsewhere (phone):
        // they drain, but we cannot see how.
        for (const other of this._others.values()) {
            const id = this._estimator.state.companions[other.dev.model];
            if (id && !connected.has(id))
                this._estimator.account(id, dt, 'unknown');
        }
    }

    _tick() {
        this._account();
        for (const entry of this._audio.values())
            this._ensureLe(entry);
        if (++this._ticks % SAVE_EVERY_TICKS === 0)
            this._save();
        this._refresh();
    }

    // --- UI --------------------------------------------------------------

    _buildMenu(entry) {
        const section = new PopupMenu.PopupMenuSection();
        if (this._audio.size > 0)
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        entry.card = new DeviceCard(entry.model);
        section.box.add_child(entry.card);

        const reset = new PopupMenu.PopupMenuItem('Сбросить статистику разряда');
        reset.add_style_class_name('hp-action');
        reset.connect('activate', () => {
            this._estimator.reset(entry.id);
            this._save();
            this._refresh();
        });
        section.addMenuItem(reset);

        this._indicator.menu.addMenuItem(section);
        entry.section = section;
    }

    _refresh() {
        if (!this._indicator)
            return;

        const now = monotonic();
        let main = null;
        for (const entry of this._audio.values()) {
            const precise = !!entry.companion;
            const sink = entry.sink ?? this._sinkState(this._findSink(entry.id));
            const playing = sink.mode === 'play';
            const est = this._estimator.estimate(entry.id, precise ? 'le' : 'hfp',
                {playing, u: sink.u});
            if (!est)
                continue;

            const idleFor = playing ? 0 : now - entry.lastPlay;
            const info = {
                est, precise, playing, idleFor,
                volume: sink.volume,
                sleeping: !playing && idleFor >= SLEEP_AFTER,
                mood: moodFor(est.hours),
            };
            entry.card.update(info);
            if (!main || est.hours < main.est.hours)
                main = info;
        }

        const ind = this._indicator;
        if (main) {
            const {est, precise} = main;
            const level = precise ? est.level : Math.round(est.soc);
            const dir = (prev, next) => prev === null ? 0 : Math.sign(next - prev);
            ind.pct.set(`${precise ? '' : '≈'}${level}%`, dir(this._shownLevel, level));
            const time = `~${formatDuration(est.hours, true)}`;
            if (time !== ind.time.text)
                ind.time.set(time, dir(this._shownHours, est.hours));
            this._shownLevel = level;
            this._shownHours = est.hours;
            ind.glyph.set(main);
            ind.accessible_name = `Наушники: ${level}%, музыки примерно на ${formatDuration(est.hours)}`;
        }
        ind.setShown(!!main && !Main.sessionMode.isLocked);
    }

    // --- persistence -----------------------------------------------------

    _loadState() {
        try {
            const [, bytes] = GLib.file_get_contents(this._statePath);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    _save() {
        if (!this._estimator)
            return;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._statePath), 0o755);
            GLib.file_set_contents(this._statePath, JSON.stringify(this._estimator.state));
        } catch (e) {
            console.error(`[${this.uuid}] cannot save state: ${e.message}`);
        }
    }
}
