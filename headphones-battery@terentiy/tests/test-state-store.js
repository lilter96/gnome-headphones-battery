// Real GJS/GIO asynchronous persistence integration tests. No user's files.
// Run: gjs -m tests/test-state-store.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {MAX_STATE_BYTES, StateStore} from '../state-store.js';

const P = GLib.PRIORITY_DEFAULT;
const roots = [];
const failures = [];
let passed = 0;
function assert(value, message = 'assertion failed') {
    if (!value)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
}
function fixture() {
    const root = GLib.dir_make_tmp('hp-state-test-XXXXXX');
    roots.push(root);
    const directory = GLib.build_filenamev([root, 'private']);
    return {root, directory, path: GLib.build_filenamev([directory, 'state.json'])};
}
const state = n => ({version: 2, devices: {headset: {n}}, companions: {}});
function mkdir(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => file.make_directory_async(P, null, (_f, res) => {
        try { resolve(file.make_directory_finish(res)); } catch (error) { reject(error); }
    }));
}
function write(path, text, flags = Gio.FileCreateFlags.REPLACE_DESTINATION) {
    const file = Gio.File.new_for_path(path);
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    return new Promise((resolve, reject) => file.replace_contents_async(bytes, null, false, flags, null, (_f, res) => {
        try { resolve(file.replace_contents_finish(res)); } catch (error) { reject(error); }
    }));
}
function read(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => file.load_contents_async(null, (_f, res) => {
        try {
            const [ok, bytes] = file.load_contents_finish(res);
            assert(ok);
            resolve(bytes);
        } catch (error) { reject(error); }
    }));
}
async function text(path) {
    return new TextDecoder().decode(await read(path));
}
function info(path, attrs = 'standard::type,standard::size,unix::mode') {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => file.query_info_async(attrs,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, P, null, (_f, res) => {
            try { resolve(file.query_info_finish(res)); } catch (error) { reject(error); }
        }));
}
async function missing(path) {
    try { await info(path); return false; } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return true;
        throw error;
    }
}
function chmod(path, mode) {
    const file = Gio.File.new_for_path(path);
    const attributes = new Gio.FileInfo();
    attributes.set_attribute_uint32('unix::mode', mode);
    return new Promise((resolve, reject) => file.set_attributes_async(attributes,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, P, null, (_f, res) => {
            try { resolve(file.set_attributes_finish(res)); } catch (error) { reject(error); }
        }));
}
function symlink(path, target) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => file.make_symbolic_link_async(target, P, null, (_f, res) => {
        try { resolve(file.make_symbolic_link_finish(res)); } catch (error) { reject(error); }
    }));
}
async function test(name, run) {
    try { await run(); passed++; } catch (error) { failures.push(name + ': ' + error.message); }
}

await test('missing file loads normally and roundtrips asynchronously', async () => {
    const f = fixture();
    const errors = [];
    const store = new StateStore(f.path, {onError: message => errors.push(message)});
    equal(await store.load(null), null);
    equal(store.readOnly, false);
    equal(await store.save(state(7)), true);
    equal(await store.close(), true);
    const restored = new StateStore(f.path);
    equal(await restored.load(null), state(7));
    equal(await restored.close(), true);
    equal(errors, []);
});

await test('directory and replacement file are private', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    assert(await store.close(state(1)));
    equal((await info(f.directory)).get_attribute_uint32('unix::mode') & 0o777, 0o700);
    equal((await info(f.path)).get_attribute_uint32('unix::mode') & 0o777, 0o600);
});

await test('old readable directory/file are tightened only at their own location', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(1)));
    await chmod(f.directory, 0o755);
    await chmod(f.path, 0o644);
    const rootMode = (await info(f.root)).get_attribute_uint32('unix::mode') & 0o777;
    const store = new StateStore(f.path);
    equal(await store.load(), state(1));
    assert(await store.close(state(2)));
    equal((await info(f.directory)).get_attribute_uint32('unix::mode') & 0o777, 0o700);
    equal((await info(f.path)).get_attribute_uint32('unix::mode') & 0o777, 0o600);
    equal((await info(f.root)).get_attribute_uint32('unix::mode') & 0o777, rootMode);
});

await test('concurrent saves coalesce to latest and resolve every waiter', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    const saves = [];
    for (let n = 1; n <= 100; n++)
        saves.push(store.save(state(n)));
    assert((await Promise.all(saves)).every(Boolean));
    assert(await store.close());
    equal(JSON.parse(await text(f.path)), state(100));
});

await test('later saves cannot be overwritten by older asynchronous snapshots', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    const saves = [];
    for (let n = 1; n <= 30; n++) {
        saves.push(store.save(state(n)));
        await Promise.resolve();
    }
    const flushed = store.close(state(999));
    assert((await Promise.all(saves)).every(Boolean));
    assert(await flushed);
    equal(JSON.parse(await text(f.path)), state(999));
});

await test('snapshot bytes do not follow later mutations of caller objects', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    const snapshot = state(5);
    const saved = store.save(snapshot);
    snapshot.devices.headset.n = 6;
    assert(await saved);
    await store.close();
    equal(JSON.parse(await text(f.path)), state(5));
});

await test('save queued during load waits and close flushes final snapshot', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    const loading = store.load();
    const intermediate = store.save(state(1));
    const closed = store.close(state(2));
    equal(await loading, null);
    assert(await intermediate);
    assert(await closed);
    equal(JSON.parse(await text(f.path)), state(2));
});

await test('close is idempotent and rejects subsequent saves immediately', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    const closed = store.close(state(3));
    equal(await store.save(state(4)), false);
    assert(await closed);
    assert(await store.close(state(5)));
    equal(JSON.parse(await text(f.path)), state(3));
});

await test('save/close before load do not create or overwrite files', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    equal(await store.save(state(1)), false);
    equal(await store.close(state(2)), false);
    equal(await store.load(), null);
    assert(await missing(f.path));
    assert(await missing(f.directory));
});

await test('canceling before load permanently prevents writes', async () => {
    const f = fixture();
    const canceled = new Gio.Cancellable();
    canceled.cancel();
    const store = new StateStore(f.path);
    equal(await store.load(canceled), null);
    assert(store.readOnly);
    equal(await store.save(state(1)), false);
    equal(await store.close(state(2)), false);
    assert(await missing(f.directory));
});

await test('canceling in-flight load rejects queued writes and creates no file', async () => {
    const f = fixture();
    const canceled = new Gio.Cancellable();
    const store = new StateStore(f.path);
    const loading = store.load(canceled);
    const saved = store.save(state(1));
    canceled.cancel();
    equal(await loading, null);
    equal(await saved, false);
    equal(await store.close(state(2)), false);
    assert(await missing(f.directory));
});

await test('canceled load never overwrites an already existing state', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(7)));
    const canceled = new Gio.Cancellable();
    const store = new StateStore(f.path);
    const loading = store.load(canceled);
    const closed = store.close(state(8));
    canceled.cancel();
    equal(await loading, null);
    equal(await closed, false);
    equal(JSON.parse(await text(f.path)), state(7));
});

await test('invalid JSON is preserved and diagnostics do not disclose contents', async () => {
    const f = fixture();
    const original = '{"private-device-secret":"do-not-log-this",';
    await mkdir(f.directory);
    await write(f.path, original);
    const errors = [];
    const store = new StateStore(f.path, {onError: message => errors.push(message)});
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.save(state(1)), false);
    equal(await store.close(state(2)), false);
    equal(await text(f.path), original);
    equal(errors.length, 1);
    assert(!errors[0].includes('private-device-secret') && !errors[0].includes(f.path));
});

await test('unsupported future schema is preserved', async () => {
    const f = fixture();
    const original = '{"version":3,"devices":{"future":{"n":999}}}';
    await mkdir(f.directory);
    await write(f.path, original);
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal(await text(f.path), original);
});

await test('valid scalar JSON is not mistaken for missing estimator state', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, 'null');
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal(await text(f.path), 'null');
});

await test('malformed root containers are preserved instead of becoming empty calibration', async () => {
    const malformed = [
        {version: 2},
        {version: 2, devices: null},
        {version: 2, devices: []},
        {version: 2, devices: 'opaque'},
        {version: 2, devices: 1},
        {version: 2, devices: {}, companions: null},
        {version: 2, devices: {}, companions: []},
        {version: 2, devices: {}, companions: 'opaque'},
        {version: 2, devices: {}, companions: false},
    ];
    for (const value of malformed) {
        const f = fixture();
        await mkdir(f.directory);
        const original = JSON.stringify(value);
        await write(f.path, original);
        const errors = [];
        const store = new StateStore(f.path, {onError: message => errors.push(message)});
        equal(await store.load(), null);
        assert(store.readOnly);
        equal(await store.close(state(1)), false);
        equal(await text(f.path), original);
        equal(errors.length, 1);
    }
});

await test('legacy version2 without companions still loads and saves', async () => {
    const f = fixture();
    await mkdir(f.directory);
    const original = {version: 2, devices: {headset: {n: 25}}};
    await write(f.path, JSON.stringify(original));
    const store = new StateStore(f.path);
    equal(await store.load(), original);
    equal(store.readOnly, false);
    assert(await store.close(state(25)));
    equal(JSON.parse(await text(f.path)), state(25));
});

await test('per-device validation remains the estimator responsibility', async () => {
    const f = fixture();
    await mkdir(f.directory);
    const original = {version: 2, devices: {good: {n: 25}, bad: null}, companions: {}};
    await write(f.path, JSON.stringify(original));
    const store = new StateStore(f.path);
    equal(await store.load(), original);
    equal(store.readOnly, false);
    assert(await store.close());
    equal(JSON.parse(await text(f.path)), original);
});

await test('oversize state is preserved without loading unbounded contents', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, new Uint8Array(MAX_STATE_BYTES + 1).fill(32));
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal((await info(f.path)).get_size(), MAX_STATE_BYTES + 1);
});

await test('a valid state exactly at the byte limit is accepted', async () => {
    const f = fixture();
    const prefix = '{"version":2,"devices":{},"padding":"';
    const suffix = '"}';
    const original = prefix + 'x'.repeat(MAX_STATE_BYTES - prefix.length - suffix.length) + suffix;
    await mkdir(f.directory);
    await write(f.path, original);
    const store = new StateStore(f.path);
    const loaded = await store.load();
    equal(loaded.version, 2);
    equal(loaded.padding.length, MAX_STATE_BYTES - prefix.length - suffix.length);
    assert(await store.close(loaded));
    equal((await info(f.path)).get_size(), MAX_STATE_BYTES);
});

await test('invalid UTF-8 is preserved rather than silently replaced', async () => {
    const f = fixture();
    const original = new Uint8Array([123, 34, 255, 34, 58, 49, 125]);
    await mkdir(f.directory);
    await write(f.path, original);
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal(Array.from(await read(f.path)), Array.from(original));
});

await test('invalid outgoing snapshot preserves existing state and can recover', async () => {
    const f = fixture();
    const errors = [];
    const store = new StateStore(f.path, {onError: message => errors.push(message)});
    await store.load();
    assert(await store.save(state(1)));
    const cyclic = state(2);
    cyclic.self = cyclic;
    equal(await store.save(cyclic), false);
    equal(JSON.parse(await text(f.path)), state(1));
    equal(store.readOnly, false);
    assert(await store.close(state(3)));
    equal(JSON.parse(await text(f.path)), state(3));
    equal(errors.length, 1);
});

await test('oversize outgoing UTF-8 snapshot is rejected by byte size', async () => {
    const f = fixture();
    const store = new StateStore(f.path, {maxBytes: 256});
    await store.load();
    assert(await store.save(state(1)));
    equal(await store.save({version: 2, devices: {}, text: 'я'.repeat(140)}), false);
    await store.close();
    equal(JSON.parse(await text(f.path)), state(1));
});

await test('custom toJSON cannot replace a valid file with an unsupported schema', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    await store.load();
    assert(await store.save(state(1)));
    equal(await store.save({version: 2, devices: {}, toJSON: () => null}), false);
    equal(await store.save({version: 2, devices: {}, toJSON: () => ({version: 3})}), false);
    await store.close();
    equal(JSON.parse(await text(f.path)), state(1));
});

await test('state symlink is not followed for reading or writing', async () => {
    const f = fixture();
    await mkdir(f.directory);
    const target = GLib.build_filenamev([f.root, 'other.json']);
    await write(target, JSON.stringify(state(55)));
    await symlink(f.path, target);
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal(JSON.parse(await text(target)), state(55));
    equal((await info(f.path)).get_file_type(), Gio.FileType.SYMBOLIC_LINK);
});

await test('symlink parent is not followed to create state elsewhere', async () => {
    const f = fixture();
    const target = GLib.build_filenamev([f.root, 'other-directory']);
    await mkdir(target);
    await symlink(f.directory, target);
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    equal(await store.close(state(1)), false);
    assert(store.readOnly);
    assert(await missing(GLib.build_filenamev([target, 'state.json'])));
});

await test('nonregular file fails closed', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await mkdir(f.path);
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    assert(store.readOnly);
    equal(await store.close(state(1)), false);
    equal((await info(f.path)).get_file_type(), Gio.FileType.DIRECTORY);
});

await test('external change is not overwritten by an old ETag', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(1)));
    const errors = [];
    const store = new StateStore(f.path, {onError: message => errors.push(message)});
    equal(await store.load(), state(1));
    await write(f.path, JSON.stringify(state(222222)));
    equal(await store.close(state(3)), false);
    assert(store.readOnly);
    equal(JSON.parse(await text(f.path)), state(222222));
    assert(errors.some(message => message.includes('another writer')));
});

await test('same-size atomic replacement is detected even if ETag timestamps repeat', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(1)));
    const store = new StateStore(f.path);
    equal(await store.load(), state(1));
    await write(f.path, JSON.stringify(state(2)));
    equal(await store.close(state(3)), false);
    equal(JSON.parse(await text(f.path)), state(2));
});

await test('a file created by another writer after missing load is preserved', async () => {
    const f = fixture();
    const store = new StateStore(f.path);
    equal(await store.load(), null);
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(2)));
    equal(await store.close(state(3)), false);
    equal(JSON.parse(await text(f.path)), state(2));
});

await test('externally deleted state is not silently resurrected', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, JSON.stringify(state(1)));
    const store = new StateStore(f.path);
    await store.load();
    await deleteFile(Gio.File.new_for_path(f.path));
    equal(await store.close(state(2)), false);
    assert(await missing(f.path));
});

await test('broken logger cannot escape asynchronous error handling', async () => {
    const f = fixture();
    await mkdir(f.directory);
    await write(f.path, '{');
    const store = new StateStore(f.path, {onError: () => { throw new Error('logger gone'); }});
    equal(await store.load(), null);
    equal(await store.close(state(1)), false);
    equal(await text(f.path), '{');
});

await test('deep missing state directory is created privately', async () => {
    const f = fixture();
    const nested = GLib.build_filenamev([f.root, 'one', 'two', 'state.json']);
    const store = new StateStore(nested);
    equal(await store.load(), null);
    assert(await store.close(state(1)));
    equal(JSON.parse(await text(nested)), state(1));
    for (const path of [GLib.build_filenamev([f.root, 'one']), GLib.build_filenamev([f.root, 'one', 'two'])])
        equal((await info(path)).get_attribute_uint32('unix::mode') & 0o777, 0o700);
});

await test('custom validator can preserve a separately versioned JSON schema', async () => {
    const f = fixture();
    const validate = value => value?.schema === 'test-only';
    const store = new StateStore(f.path, {validate});
    await store.load();
    assert(await store.close({schema: 'test-only', value: 5}));
    const restored = new StateStore(f.path, {validate});
    equal(await restored.load(), {schema: 'test-only', value: 5});
    await restored.close();
});

// Cleanup only these exact mkdtemp-created trees; never a user state path.
function listChildren(file) {
    return new Promise((resolve, reject) => file.enumerate_children_async('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, P, null, (_f, result) => {
            try { resolve(file.enumerate_children_finish(result)); } catch (error) { reject(error); }
        }));
}
function nextChildren(enumerator) {
    return new Promise((resolve, reject) => enumerator.next_files_async(32, P, null, (_f, result) => {
        try { resolve(enumerator.next_files_finish(result)); } catch (error) { reject(error); }
    }));
}
function deleteFile(file) {
    return new Promise((resolve, reject) => file.delete_async(P, null, (_f, result) => {
        try { resolve(file.delete_finish(result)); } catch (error) { reject(error); }
    }));
}
async function cleanup(file) {
    const childInfo = await info(file.get_path());
    if (childInfo.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = await listChildren(file);
        while (true) {
            const children = await nextChildren(enumerator);
            if (!children.length)
                break;
            for (const child of children)
                await cleanup(file.get_child(child.get_name()));
        }
        await new Promise((resolve, reject) => enumerator.close_async(P, null, (_f, result) => {
            try { resolve(enumerator.close_finish(result)); } catch (error) { reject(error); }
        }));
    }
    await deleteFile(file);
}
for (const root of roots) {
    assert(root.startsWith(GLib.get_tmp_dir() + '/hp-state-test-'));
    await cleanup(Gio.File.new_for_path(root));
}

for (const failure of failures)
    console.error('FAIL state-store: ' + failure);
console.log('StateStore GJS tests: ' + passed + '/' + (passed + failures.length) + ' passed');
if (failures.length)
    throw new Error(String(failures.length) + ' StateStore test(s) failed');
