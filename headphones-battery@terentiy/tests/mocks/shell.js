// Deliberately small GI/Shell stand-ins for Node orchestration tests.
// They do not claim to reproduce GObject, rendering or real D-Bus behavior.
// The actual extension/UI/pure modules are imported unchanged by the harness.
import {registerHooks} from 'node:module';

let nextSignal = 1;
const emitters = new Set();
const actors = new Set();
const timelines = new Set();

export class Emitter {
    constructor() {
        this._signals = new Map();
        emitters.add(this);
    }
    connect(name, callback) {
        if (this.destroyed)
            throw new Error('connected a signal to a destroyed actor');
        const id = nextSignal++;
        this._signals.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        if (!this._signals.delete(id))
            throw new Error(`unknown signal id ${id}`);
    }
    emit(name, ...args) {
        for (const [id, signal] of [...this._signals]) {
            if (this._signals.has(id) && signal.name === name)
                signal.callback(this, ...args);
        }
    }
}

class Actor extends Emitter {
    constructor(...args) {
        super();
        actors.add(this);
        this._init(...args);
    }
    _init(params = {}) {
        this.children = [];
        this.styles = new Set();
        this.visible = true;
        this.mapped = false;
        this.width = 20;
        this.height = 20;
        this.opacity = 255;
        this.translation_x = 0;
        this.translation_y = 0;
        this.scale_x = 1;
        this.scale_y = 1;
        this.clutter_text = {};
        Object.assign(this, params);
    }
    add_child(child) {
        if (child.parent && child.parent !== this)
            throw new Error('actor already has a parent');
        if (this.children.includes(child))
            throw new Error('actor added twice');
        this.children.push(child);
        child.parent = this;
    }
    remove_child(child) {
        this.children = this.children.filter(item => item !== child);
        child.parent = null;
    }
    destroy_all_children() {
        for (const child of [...this.children])
            child.destroy();
    }
    destroy() {
        if (this.destroyed)
            return;
        this.emit('destroy');
        this.destroy_all_children();
        this._signals.clear();
        this.parent?.remove_child(this);
        this.destroyed = true;
    }
    set_size(width, height) { this.width = width; this.height = height; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; }
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; }
    add_style_class_name(name) { this.styles.add(name); }
    remove_style_class_name(name) { this.styles.delete(name); }
    remove_transition() {}
    queue_repaint() {}
    ease({onStopped, ...params}) {
        Object.assign(this, params);
        onStopped?.();
    }
    vfunc_leave_event() { return 0; }
    vfunc_style_changed() {}
}

class Label extends Actor {
    _init(params = {}) { super._init({text: '', ...params}); }
}

class Timeline extends Emitter {
    constructor(params) {
        super();
        this.params = params;
        this.playing = false;
        timelines.add(this);
    }
    start() { this.playing = true; }
    stop() { this.playing = false; }
    is_playing() { return this.playing; }
}

class Menu extends Emitter {
    constructor() {
        super();
        this.actor = new Actor();
    }
    addMenuItem(item) { this.actor.add_child(item); }
    destroy() { this.actor.destroy(); this._signals.clear(); }
}

class PanelButton extends Actor {
    _init() {
        super._init();
        this.menu = new Menu();
    }
    destroy() {
        this.menu.destroy();
        super.destroy();
    }
}

class Section extends Actor {
    _init() {
        super._init();
        this.box = new Actor();
        this.add_child(this.box);
    }
    addMenuItem(item) { this.box.add_child(item); }
}

class MenuItem extends Actor {
    _init(text) { super._init({text}); }
}

export class MockStream extends Emitter {
    constructor(address, {playing = false, volume = 50} = {}) {
        super();
        this.name = `bluez_output.${address.replaceAll(':', '_')}.1`;
        this.playing = playing;
        this.volume = volume;
        this.muted = false;
    }
    get_name() { return this.name; }
    get_state() { return this.playing ? 1 : 0; }
    get_volume() { return this.volume; }
    get_is_muted() { return this.muted; }
}

const mixer = new Emitter();
mixer.sinks = [];
mixer.get_sinks = () => mixer.sinks;
mixer.get_vol_max_norm = () => 100;
const sessionMode = new Emitter();
sessionMode.isLocked = false;
const theme = new Emitter();
theme.scale_factor = 1;

class Variant {
    constructor(signature, value) { this.signature = signature; this.value = value; }
    unpack() { return this.value; }
    recursiveUnpack() { return this.value; }
    deepUnpack() { return this.value; }
}

class Cancellable {
    cancel() { this.canceled = true; }
}

const login = {
    subscriptions: new Map(),
    signal_subscribe(...args) {
        const id = nextSignal++;
        this.subscriptions.set(id, args.at(-1));
        return id;
    },
    signal_unsubscribe(id) {
        if (!this.subscriptions.delete(id))
            throw new Error('double unsubscription');
    },
    prepareForSleep(sleeping) {
        for (const callback of this.subscriptions.values())
            callback(this, ':login', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager',
                'PrepareForSleep', new Variant('(b)', [sleeping]));
    },
};

export const mock = {
    now: 10000,
    timers: new Map(),
    mixer, sessionMode, theme, login,
    panelItems: new Map(),
    upowerPending: [],
    upowerClients: [],
    stores: [],
    monitors: [],
    sessions: [],
    stateData: null,
    loadGate: null,
    closeGate: null,
    animations: false,
    reset() {
        this.now = 10000;
        this.stateData = null;
        this.loadGate = null;
        this.closeGate = null;
        this.upowerPending = [];
        this.upowerClients = [];
        this.stores = [];
        this.monitors = [];
        this.sessions = [];
        this.animations = false;
        mixer.sinks = [];
        sessionMode.isLocked = false;
    },
    completeUPower(devices = [], index = 0) {
        const pending = this.upowerPending.splice(index, 1)[0];
        if (!pending)
            throw new Error('no UPower request pending');
        const client = new Emitter();
        client.get_devices = () => devices;
        this.upowerClients.push(client);
        pending.callback(null, {client});
        return client;
    },
    resources() {
        return {
            signals: [...emitters].reduce((sum, emitter) => sum + emitter._signals.size, 0),
            timers: this.timers.size,
            panels: this.panelItems.size,
            login: login.subscriptions.size,
            playingTimelines: [...timelines].filter(timeline => timeline.playing).length,
            liveActors: [...actors].filter(actor => !actor.destroyed).length,
            liveSessions: this.sessions.filter(session => session.started && !session.stopped).length,
            liveMonitors: this.monitors.filter(monitor => monitor.started && !monitor.stopped).length,
        };
    },
};

const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    get_monotonic_time: () => mock.now * 1e6,
    get_user_state_dir: () => '/tmp/hp-test-state',
    build_filenamev: parts => parts.join('/'),
    timeout_add_seconds(_priority, seconds, callback) {
        const id = nextSignal++;
        mock.timers.set(id, {seconds, callback});
        return id;
    },
    source_remove(id) {
        if (!mock.timers.delete(id))
            throw new Error(`invalid GLib source ${id}`);
    },
    Variant,
    VariantType: class { constructor(signature) { this.signature = signature; } },
    spawn_sync() { throw new Error('blocking process invocation in Shell'); },
};

const Gio = {
    Cancellable,
    IOErrorEnum: {CANCELLED: 1},
    BusType: {SYSTEM: 0},
    DBusSignalFlags: {NONE: 0},
    bus_get(_busType, cancellable, callback) { queueMicrotask(() => callback(null, {connection: login, cancellable})); },
    bus_get_finish(result) { return result.connection; },
};

const UPower = {
    DeviceKind: {HEADPHONES: 1, HEADSET: 2, OTHER_AUDIO: 3, UNKNOWN: 0},
    DeviceState: {UNKNOWN: 0, CHARGING: 1, DISCHARGING: 2, EMPTY: 3, FULLY_CHARGED: 4},
    DeviceLevel: {UNKNOWN: 0, NORMAL: 1},
    Client: {
        new_async(cancellable, callback) { mock.upowerPending.push({cancellable, callback}); },
        new_finish(result) { return result.client; },
    },
};
export {UPower};

export function upowerDevice({path = '/org/freedesktop/UPower/devices/headset_test', address,
    nativePath, model = 'AirPods Pro', percentage = 60, updateTime = Date.now() / 1000,
    kind = UPower.DeviceKind.HEADPHONES} = {}) {
    const dev = new Emitter();
    Object.assign(dev, {
        serial: address, native_path: nativePath ?? `/org/bluez/hci0/dev_${address.replaceAll(':', '_')}`,
        model, percentage, update_time: updateTime, kind,
        is_present: true, state: UPower.DeviceState.DISCHARGING,
        battery_level: UPower.DeviceLevel.NORMAL,
        get_object_path: () => path,
    });
    return dev;
}

class MockBlueZMonitor {
    constructor(options) {
        this.options = options;
        this.objects = new Map();
        this.online = false;
        this.calls = [];
        mock.monitors.push(this);
    }
    start() { this.started = true; this.stopped = false; return Promise.resolve(true); }
    stop() { this.stopped = true; this.online = false; this.objects.clear(); }
    availability(online) {
        this.online = online;
        if (!online)
            this.objects.clear();
        this.options.onAvailability(online);
    }
    update(path, interfaces, event = {kind: 'object-added'}) {
        if (interfaces === null)
            this.objects.delete(path);
        else
            this.objects.set(path, interfaces);
        this.options.onUpdate(path, interfaces, event);
    }
    call(...args) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        this.calls.push({args, resolve, reject});
        return promise;
    }
}

class MockAapSession {
    constructor(options) { this.options = options; mock.sessions.push(this); }
    start() { this.started = true; this.stopped = false; this.options.onStatus({state: 'connecting'}); }
    stop() {
        this.stopRequested = true;
        this._stopResult ??= (this.stopPromise ?? Promise.resolve()).then(() => { this.stopped = true; });
        return this._stopResult;
    }
    packet(packet) { this.options.onPacket(packet); }
    status(state) { this.options.onStatus({state}); }
}

class MockStateStore {
    constructor(path, options) { this.path = path; this.options = options; this.saves = []; mock.stores.push(this); }
    load() { return mock.loadGate ?? Promise.resolve(mock.stateData); }
    save(state) { this.saves.push(structuredClone(state)); return Promise.resolve(); }
    close(state) { this.closed = true; this.finalState = state ? structuredClone(state) : null; return mock.closeGate ?? Promise.resolve(); }
}

class Extension {
    constructor({uuid = 'headphones-battery@terentiy'} = {}) {
        this.uuid = uuid;
        this.dir = {get_child: name => ({get_path: () => `/test-extension/${name}`})};
    }
}

const registry = {
    GLib, Gio, UPowerGlib: UPower,
    GObject: {registerClass: value => value},
    Gvc: {MixerStreamState: {RUNNING: 1}},
    Graphene: {Point: class { constructor(params) { Object.assign(this, params); } }},
    Pango: {EllipsizeMode: {NONE: 0, END: 1}},
    Cairo: {Operator: {CLEAR: 0}},
    Clutter: {
        Timeline, BinLayout: class {}, ActorAlign: {CENTER: 0, START: 1, END: 2},
        AnimationMode: {EASE_OUT_QUAD: 0}, EVENT_STOP: 1, EVENT_PROPAGATE: 0,
    },
    St: {
        Widget: Actor, BoxLayout: Actor, Label, DrawingArea: Actor,
        Settings: {get: () => ({enable_animations: mock.animations})},
        ThemeContext: {get_for_stage: () => theme},
    },
    Extension, PanelButton, Section, MenuItem,
    Main: {
        sessionMode,
        panel: {addToStatusArea(uuid, actor) {
            if (mock.panelItems.has(uuid))
                throw new Error('duplicate indicator');
            mock.panelItems.set(uuid, actor);
            actor.connect('destroy', () => mock.panelItems.delete(uuid));
        }},
    },
    mixer, MockBlueZMonitor, MockAapSession, MockStateStore,
};

globalThis.stage = {};
globalThis.__hpMock = registry;
const moduleSource = source => `data:text/javascript,${encodeURIComponent(source)}`;
const replacements = new Map([
    ['resource:///org/gnome/shell/extensions/extension.js', 'export const Extension=globalThis.__hpMock.Extension;'],
    ['resource:///org/gnome/shell/ui/main.js', 'export const {panel,sessionMode}=globalThis.__hpMock.Main;'],
    ['resource:///org/gnome/shell/ui/panelMenu.js', 'export const Button=globalThis.__hpMock.PanelButton;'],
    ['resource:///org/gnome/shell/ui/popupMenu.js', 'export const PopupMenuSection=globalThis.__hpMock.Section;export const PopupMenuItem=globalThis.__hpMock.MenuItem;'],
    ['resource:///org/gnome/shell/ui/status/volume.js', 'export const getMixerControl=()=>globalThis.__hpMock.mixer;'],
]);
const ioModules = new Map([
    [new URL('../../bluez-monitor.js', import.meta.url).href, 'export const BlueZMonitor=globalThis.__hpMock.MockBlueZMonitor;'],
    [new URL('../../aap-session.js', import.meta.url).href, 'export const AapSession=globalThis.__hpMock.MockAapSession;'],
    [new URL('../../state-store.js', import.meta.url).href, 'export const StateStore=globalThis.__hpMock.MockStateStore;'],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('gi://')) {
            const name = specifier.slice(5);
            if (!Object.hasOwn(registry, name))
                throw new Error(`unmocked GI import ${specifier}`);
            return {url: moduleSource(`export default globalThis.__hpMock.${name};`), shortCircuit: true};
        }
        if (specifier === 'cairo')
            return {url: moduleSource('export default globalThis.__hpMock.Cairo;'), shortCircuit: true};
        if (replacements.has(specifier))
            return {url: moduleSource(replacements.get(specifier)), shortCircuit: true};
        const url = context.parentURL ? new URL(specifier, context.parentURL).href : specifier;
        if (ioModules.has(url))
            return {url: moduleSource(ioModules.get(url)), shortCircuit: true};
        return nextResolve(specifier, context);
    },
});

export const flush = () => new Promise(resolve => setImmediate(resolve));
