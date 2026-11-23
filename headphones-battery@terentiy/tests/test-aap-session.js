// GJS integration tests using real subprocesses and synthetic NDJSON only.
// Run: gjs -m tests/test-aap-session.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {AapSession} from '../aap-session.js';

const testDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
const helper = GLib.build_filenamev([testDir, 'fixtures', 'fake-aap-helper.js']);
const mono = () => GLib.get_monotonic_time() / 1000;
let passed = 0;

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function until(predicate, message, timeout = 4000) {
    const deadline = mono() + timeout;
    return new Promise((resolve, reject) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
            try {
                if (predicate()) {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }
                if (mono() >= deadline) {
                    reject(new Error(`Timeout: ${message}`));
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            } catch (error) {
                reject(error);
                return GLib.SOURCE_REMOVE;
            }
        });
    });
}

function create(mode, options = {}) {
    const packets = [];
    const statuses = [];
    const session = new AapSession({
        helperPath: helper,
        address: `AA:BB:CC:DD:EE:${mode.toString(16).padStart(2, '0').toUpperCase()}`,
        onPacket: packet => packets.push(packet),
        onStatus: status => statuses.push(status),
        timing: {startupMs: 1000, idleMs: 1000, retryBaseMs: 1000, retryMaxMs: 2000, drainMs: 200},
        random: () => 0.5,
        ...options,
    });
    return {session, packets, statuses};
}

async function clean(session) {
    const child = session._run?.process;
    await session.stop();
    await until(() => session._run === null, 'child must be reaped');
    assert(session._retrySource === 0, 'no reconnect source after stop');
    assert(session.state === 'stopped', 'stopped state');
    if (child)
        assert(child.get_if_exited() || child.get_if_signaled(), 'stopped child has a reaped exit status');
}

async function check(name, callback) {
    await callback();
    passed++;
    print(`ok ${passed} - ${name}`);
}

await check('valid streaming packets; stop cancels pending reads and reaps child', async () => {
    const {session, packets} = create(1);
    session.start();
    try {
        await until(() => packets.length >= 2, 'two packets');
        assert(session.state === 'live', 'live state after valid data');
        assert(packets[0].left === 57 && packets[0].right === 93, 'real fixture values preserved');
        assert(packets[0].case === null, 'unavailable case remains null');
    } finally {
        await clean(session);
    }
    const count = packets.length;
    await delay(50);
    assert(packets.length === count, 'no late packet after stop');
});

await check('buffered final packet is delivered even if process already exited', async () => {
    const {session, packets} = create(2);
    session.start();
    try {
        await until(() => session.state === 'backoff', 'EOF backoff');
        assert(packets.length === 1, 'one buffered packet retained');
    } finally {
        await clean(session);
    }
});

for (const [mode, name] of [[3, 'malformed JSON'], [4, 'wrong device address'],
    [5, 'oversized output line'], [9, 'invalid UTF-8'], [11, 'unbounded stderr']]) {
    await check(`reject ${name} without reporting battery`, async () => {
        const {session, packets} = create(mode);
        session.start();
        try {
            await until(() => session.state === 'backoff', name);
            assert(packets.length === 0, 'invalid output never becomes telemetry');
            assert(session._run === null, 'failed process fully reaped before backoff');
        } finally {
            await clean(session);
        }
    });
}

await check('permission exit is terminal until explicit restart', async () => {
    const {session} = create(6, {timing: {retryBaseMs: 20}});
    session.start();
    try {
        await until(() => session.state === 'permission', 'permission diagnostic');
        assert(session._retrySource === 0 && !session._active, 'no privilege retry loop');
        await delay(60);
        assert(session._run === null, 'permission failure does not respawn');
    } finally {
        await clean(session);
    }
});

await check('incompatible helper exit is terminal and actionable', async () => {
    const {session} = create(0);
    session.start();
    try {
        await until(() => session.state === 'error', 'helper version/usage failure');
        assert(session._retrySource === 0 && !session._active, 'no incompatible-helper retry loop');
    } finally {
        await clean(session);
    }
});

await check('startup watchdog kills a silent helper asynchronously', async () => {
    const {session, packets} = create(7, {timing: {startupMs: 250, retryBaseMs: 1000}});
    let heartbeat = 0;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        heartbeat++;
        return GLib.SOURCE_CONTINUE;
    });
    session.start();
    try {
        await until(() => session.state === 'backoff', 'startup timeout');
        assert(heartbeat >= 5, 'main loop stayed responsive');
        assert(packets.length === 0, 'timeout creates no battery sample');
    } finally {
        GLib.Source.remove(timer);
        await clean(session);
    }
});

await check('idle watchdog handles helper that stops updating', async () => {
    const {session, packets} = create(8, {timing: {startupMs: 1000, idleMs: 150, retryBaseMs: 1000}});
    session.start();
    try {
        await until(() => session.state === 'backoff', 'idle timeout');
        assert(packets.length === 1, 'only the real packet is reported');
    } finally {
        await clean(session);
    }
});

await check('NDJSON split across pipe chunks is reconstructed', async () => {
    const {session, packets} = create(10);
    session.start();
    try {
        await until(() => packets.length === 1, 'split packet');
        assert(packets[0].left === 57, 'split packet decoded');
    } finally {
        await clean(session);
    }
});

await check('fast failures grow backoff and stopping cancels future retries', async () => {
    const {session, statuses} = create(12, {
        timing: {startupMs: 1000, retryBaseMs: 30, retryMaxMs: 120, healthyMs: 10000},
    });
    session.start();
    try {
        await until(() => session._retryAttempt >= 3 && session.state === 'backoff', 'three failures');
        assert(statuses.filter(s => s.state === 'connecting').length >= 3, 'reconnect attempts visible');
        assert(session._retryAttempt >= 3, 'short-lived connection does not reset failures');
    } finally {
        await clean(session);
    }
    const count = statuses.length;
    await delay(200);
    assert(statuses.length === count, 'stopped backoff never calls consumer');
});

await check('backoff resets only after an observed healthy interval', async () => {
    const {session, packets} = create(1, {timing: {healthyMs: 150}});
    session.start();
    session._retryAttempt = 3; // Existing failed-attempt state before this connection's first event.
    try {
        await until(() => packets.length === 1, 'first healthy packet');
        assert(session._retryAttempt === 3, 'one event does not erase a crash loop');
        await until(() => packets.length >= 3, 'sustained telemetry');
        assert(session._retryAttempt === 0, 'sustained healthy connection resets backoff');
    } finally {
        await clean(session);
    }
});

await check('address normalization and adapter argv preserve device identity', async () => {
    const {session, packets} = create(13, {adapterAddress: '11:22:33:44:55:66'});
    session.start();
    try {
        await until(() => packets.length === 1, 'normalized packet');
        assert(packets[0].address === 'AA:BB:CC:DD:EE:0D', 'canonical device address');
    } finally {
        await clean(session);
    }
});

await check('message flood is bounded', async () => {
    const {session, packets} = create(14);
    session.start();
    try {
        await until(() => session.state === 'backoff', 'rate limit');
        assert(packets.length <= 120, 'message count is bounded');
    } finally {
        await clean(session);
    }
});

await check('EOF with a partial line never becomes a packet', async () => {
    const {session, packets} = create(15);
    session.start();
    try {
        await until(() => session.state === 'backoff', 'partial EOF');
        assert(packets.length === 0, 'unterminated packet discarded');
    } finally {
        await clean(session);
    }
});

await check('invalid packet after valid data stops the stream', async () => {
    const {session, packets} = create(16);
    session.start();
    try {
        await until(() => session.state === 'backoff', 'bad second packet');
        assert(packets.length === 1, 'bad packet not forwarded');
    } finally {
        await clean(session);
    }
});

await check('permission denial after one event does not discard that event', async () => {
    const {session, packets} = create(17);
    session.start();
    try {
        await until(() => session.state === 'permission', 'permission after data');
        assert(packets.length === 1, 'valid packet was delivered');
        assert(session._retrySource === 0, 'permission failure remains terminal');
    } finally {
        await clean(session);
    }
});

await check('missing executable shows actionable status with no retry', async () => {
    const {session} = create(1, {helperPath: '/nonexistent/headphones-battery-helper-test'});
    session.start();
    try {
        await until(() => session.state === 'missing', 'missing executable');
        assert(session._retrySource === 0 && session._run === null, 'no missing-binary loop');
    } finally {
        await clean(session);
    }
});

await check('non-executable path shows permission status', async () => {
    const {session} = create(1, {helperPath: GLib.build_filenamev([testDir, '..', 'estimator.js'])});
    session.start();
    try {
        await until(() => session.state === 'permission', 'exec denied');
        assert(session._retrySource === 0 && session._run === null, 'no exec-denied loop');
    } finally {
        await clean(session);
    }
});

await check('bad configuration does not create a child', async () => {
    const {session} = create(1, {address: 'invalid'});
    session.start();
    assert(session.state === 'error' && session._run === null, 'invalid MAC rejected');
    await clean(session);
});

await check('rapid stop/start never overlaps helper lifetimes', async () => {
    const {session, packets} = create(1);
    session.start();
    try {
        await until(() => packets.length === 1, 'first session');
        const firstPid = session.processId;
        const firstChild = session._run.process;
        session.stop();
        session.start();
        await until(() => packets.length >= 2 && session.processId !== firstPid, 'restarted session');
        assert(firstChild.get_if_exited() || firstChild.get_if_signaled(), 'old helper is reaped before replacement');
    } finally {
        await clean(session);
    }
});

await check('stop completion fences cross-instance replacement after process and pipes settle', async () => {
    const first = create(1);
    first.session.start();
    await until(() => first.packets.length === 1, 'original stream');
    const run = first.session._run;
    const stopping = first.session.stop();
    assert(typeof stopping?.then === 'function', 'stop returns a completion promise');
    await stopping;
    assert(run.exited && run.stdoutClosed && run.stderrClosed, 'completion covers reaping and both pipe closes');
    assert(first.session._run === null, 'owner releases run before completion');
    const next = create(1);
    next.session.start();
    try {
        await until(() => next.packets.length === 1, 'replacement stream');
        assert(run.process.get_if_exited() || run.process.get_if_signaled(), 'old child remains exited');
    } finally {
        await clean(next.session);
        await clean(first.session);
    }
});

await check('reentrant stop from consumer prevents further packets', async () => {
    let session;
    let count = 0;
    ({session} = create(1, {onPacket: () => {
        count++;
        session.stop();
    }}));
    session.start();
    await until(() => count === 1 && session._run === null, 'consumer stop');
    await delay(150);
    assert(count === 1, 'no packets after reentrant stop');
    await clean(session);
});

await check('idempotent start/stop uses one child and no leftover timers', async () => {
    const {session, packets} = create(1);
    session.start();
    session.start();
    try {
        await until(() => packets.length === 1, 'idempotent start');
        const pid = session.processId;
        session.start();
        assert(session.processId === pid, 'start while live leaves same child');
    } finally {
        session.stop();
        session.stop();
        await clean(session);
    }
});

await check('stopping during connecting status never spawns a child', async () => {
    let session;
    ({session} = create(1, {onStatus: status => {
        if (status.state === 'connecting')
            session.stop();
    }}));
    session.start();
    await delay(30);
    assert(session._run === null && session._retrySource === 0, 'reentrant startup cancel leaves no resources');
    await clean(session);
});

print(`AAP subprocess integration: ${passed} tests passed (synthetic fixtures; no Bluetooth hardware).`);
