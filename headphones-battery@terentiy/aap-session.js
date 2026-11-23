// One supervised AAP connection per paired, connected device.
// No synchronous reads/waits, shell command strings, capabilities, or raw logs.
// Gio owns process reaping; we deliberately do not cancel wait_async when stopping.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {normalizeMac} from './bluez.js';
import {parseAapMessage} from './airpods.js';

const CHUNK_BYTES = 1024;
const MAX_LINE_BYTES = 4096;
const MAX_STDERR_BYTES = 16384;
const MAX_WINDOW_BYTES = 65536;
const MAX_WINDOW_MESSAGES = 120;
const DEFAULT_TIMING = Object.freeze({
    startupMs: 70000,
    idleMs: 210000,
    drainMs: 1000,
    retryBaseMs: 5000,
    retryMaxMs: 300000,
    healthyMs: 30000,
});

const nowMs = () => GLib.get_monotonic_time() / 1000;
const cancelled = error => error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
const matches = (error, domain, code) => Boolean(error?.matches?.(domain, code));

function clearSource(owner, name) {
    const id = owner[name];
    owner[name] = 0;
    if (id)
        GLib.Source.remove(id);
}

function safeCallback(callback, value) {
    try {
        callback?.(value);
    } catch {
        // A consumer exception must not strand a child or stop its pipe drain.
        console.error('[headphones-battery] AAP consumer callback failed');
    }
}

export class AapSession {
    constructor({helperPath, address, adapterAddress = null, onPacket, onStatus,
        timing = {}, random = Math.random} = {}) {
        this._helperPath = typeof helperPath === 'string' ? helperPath : '';
        this._address = normalizeMac(address);
        this._adapterAddress = adapterAddress === null ? null : normalizeMac(adapterAddress);
        this._invalidAdapter = adapterAddress !== null && !this._adapterAddress;
        this._onPacket = onPacket;
        this._onStatus = onStatus;
        this._random = typeof random === 'function' ? random : Math.random;
        this._timing = {...DEFAULT_TIMING};
        for (const key of Object.keys(DEFAULT_TIMING)) {
            if (Number.isFinite(timing[key]) && timing[key] >= 1)
                this._timing[key] = Math.floor(timing[key]);
        }
        this._timing.retryMaxMs = Math.max(this._timing.retryBaseMs, this._timing.retryMaxMs);
        this._active = false;
        this._generation = 0;
        this._retryAttempt = 0;
        this._retrySource = 0;
        this._run = null;
        this._state = 'stopped';
        this._message = null;
    }

    get state() {
        return this._state;
    }

    // Useful for local diagnostics/tests; never use this PID to signal a process.
    // Gio.Subprocess.force_exit owns signalling and avoids PID-reuse races.
    get processId() {
        return this._run?.process.get_identifier() ?? null;
    }

    start() {
        if (this._active)
            return;
        this._active = true;
        this._generation++;
        this._retryAttempt = 0;
        if (!this._address || this._invalidAdapter || !GLib.path_is_absolute(this._helperPath)) {
            this._active = false;
            this._setStatus('error', 'Неверные параметры запуска AAP-хелпера.');
            return;
        }
        this._setStatus('connecting', 'Подключение к батарее AirPods…');
        // A rapid stop()/start() waits until the old child is actually reaped.
        if (!this._run)
            this._spawn(this._generation);
    }

    stop() {
        this._active = false;
        this._generation++;
        clearSource(this, '_retrySource');
        const run = this._run;
        // Cross-instance owners (device removal/recreation or adapter changes)
        // can await this fence before launching the next AAP connection.
        const finished = run ? new Promise(resolve => run.stopWaiters.push(resolve)) : Promise.resolve();
        if (run)
            this._terminate(run, 'stopped');
        this._setStatus('stopped', null);
        return finished;
    }

    _setStatus(state, message) {
        if (state === this._state && message === this._message)
            return;
        this._state = state;
        this._message = message;
        safeCallback(this._onStatus, {state, message});
    }

    _current(run) {
        return this._active && this._run === run && this._generation === run.generation;
    }

    _spawn(generation) {
        if (!this._active || generation !== this._generation || this._run)
            return;
        this._setStatus('connecting', 'Подключение к батарее AirPods…');
        if (!this._active || generation !== this._generation)
            return;
        const argv = [this._helperPath, '--watch'];
        if (this._adapterAddress)
            argv.push('--adapter', this._adapterAddress);
        argv.push(this._address);

        let process;
        try {
            process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            if (matches(error, GLib.SpawnError, GLib.SpawnError.NOENT) ||
                matches(error, Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this._active = false;
                this._setStatus('missing', 'AAP-хелпер не установлен. Выполните сборку и установку расширения.');
            } else if (matches(error, GLib.SpawnError, GLib.SpawnError.ACCES) ||
                matches(error, Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)) {
                this._active = false;
                this._setStatus('permission', 'Нет разрешения на запуск AAP-хелпера. Проверьте установку.');
            } else {
                this._retry(generation, 'Не удалось запустить AAP-хелпер.');
            }
            return;
        }

        const run = {
            generation, process,
            ioCancel: new Gio.Cancellable(),
            stdout: process.get_stdout_pipe(),
            stderr: process.get_stderr_pipe(),
            stdoutPending: false, stderrPending: false,
            stdoutDone: false, stderrDone: false,
            stdoutClosing: false, stderrClosing: false,
            stdoutClosed: false, stderrClosed: false,
            stopWaiters: [],
            line: [], stderrBytes: 0,
            windowStarted: nowMs(), windowBytes: 0, windowMessages: 0,
            firstPacketAt: null, exited: false, exitCode: null,
            terminating: false, reason: null,
            startupSource: 0, idleSource: 0, drainSource: 0,
        };
        this._run = run;
        run.startupSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timing.startupMs, () => {
            run.startupSource = 0;
            if (this._current(run))
                this._terminate(run, 'timeout');
            return GLib.SOURCE_REMOVE;
        });

        // Not cancellable: cancelling wait does not terminate the child and would
        // lose the completion event needed for strict single-child ownership.
        process.wait_async(null, (proc, result) => {
            try {
                proc.wait_finish(result);
                run.exited = true;
                run.exitCode = proc.get_if_exited() ? proc.get_exit_status() : null;
            } catch {
                run.exited = true;
                run.reason ??= 'wait';
            }
            clearSource(run, 'startupSource');
            clearSource(run, 'idleSource');
            // Allow buffered stdout to arrive after wait completes. Bound the
            // drain in case an erroneous helper child inherited an output pipe.
            if (!run.stdoutDone || !run.stderrDone) {
                run.drainSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timing.drainMs, () => {
                    run.drainSource = 0;
                    run.ioCancel.cancel();
                    this._maybeFinalize(run);
                    return GLib.SOURCE_REMOVE;
                });
            }
            this._maybeFinalize(run);
        });
        this._read(run, 'stdout');
        this._read(run, 'stderr');
    }

    _read(run, name) {
        const stream = run[name];
        const pending = `${name}Pending`;
        const done = `${name}Done`;
        if (run[done] || run[pending])
            return;
        if (run.ioCancel.is_cancelled()) {
            run[done] = true;
            this._closePipe(run, name);
            this._maybeFinalize(run);
            return;
        }
        run[pending] = true;
        stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_DEFAULT_IDLE, run.ioCancel,
            (pipe, result) => {
                run[pending] = false;
                let bytes;
                try {
                    bytes = pipe.read_bytes_finish(result).get_data() ?? new Uint8Array();
                } catch (error) {
                    run[done] = true;
                    this._closePipe(run, name);
                    if (!cancelled(error) && this._current(run))
                        this._terminate(run, 'read');
                    this._maybeFinalize(run);
                    return;
                }
                if (!bytes.length || run.ioCancel.is_cancelled()) {
                    run[done] = true;
                    this._closePipe(run, name);
                    if (!bytes.length && name === 'stdout' && this._current(run) && !run.exited)
                        this._terminate(run, 'eof');
                    this._maybeFinalize(run);
                    return;
                }
                if (this._current(run) && !run.terminating) {
                    if (name === 'stdout')
                        this._consume(run, bytes);
                    else {
                        // Deliberately never forward stderr text (could contain
                        // MACs, arbitrary control characters, or protocol data).
                        run.stderrBytes += bytes.length;
                        if (run.stderrBytes > MAX_STDERR_BYTES)
                            this._terminate(run, 'output-limit');
                    }
                }
                this._read(run, name);
            });
    }

    _consume(run, bytes) {
        const now = nowMs();
        if (now - run.windowStarted >= 1000) {
            run.windowStarted = now;
            run.windowBytes = 0;
            run.windowMessages = 0;
        }
        run.windowBytes += bytes.length;
        if (run.windowBytes > MAX_WINDOW_BYTES) {
            this._terminate(run, 'output-limit');
            return;
        }
        for (const byte of bytes) {
            if (!this._current(run) || run.terminating)
                return;
            if (byte !== 10) {
                if (run.line.length >= MAX_LINE_BYTES) {
                    this._terminate(run, 'output-limit');
                    return;
                }
                run.line.push(byte);
                continue;
            }
            if (++run.windowMessages > MAX_WINDOW_MESSAGES) {
                this._terminate(run, 'output-limit');
                return;
            }
            let packet = null;
            try {
                const line = new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array(run.line));
                packet = parseAapMessage(line, this._address);
            } catch {
                // Decode/schema failure is a failed connection, never telemetry.
            }
            run.line.length = 0;
            if (!packet) {
                this._terminate(run, 'protocol');
                return;
            }
            if (run.firstPacketAt === null) {
                run.firstPacketAt = nowMs();
                clearSource(run, 'startupSource');
            } else if (nowMs() - run.firstPacketAt >= this._timing.healthyMs) {
                this._retryAttempt = 0;
            }
            clearSource(run, 'idleSource');
            run.idleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timing.idleMs, () => {
                run.idleSource = 0;
                if (this._current(run))
                    this._terminate(run, 'timeout');
                return GLib.SOURCE_REMOVE;
            });
            this._setStatus('live', null);
            if (this._current(run) && !run.terminating)
                safeCallback(this._onPacket, packet);
        }
    }

    _terminate(run, reason) {
        run.reason ??= reason;
        clearSource(run, 'startupSource');
        clearSource(run, 'idleSource');
        if (!run.terminating) {
            run.terminating = true;
            if (!run.exited) {
                try {
                    run.process.force_exit();
                } catch {
                    // Gio still owns the wait/reap path.
                }
            }
        }
        run.ioCancel.cancel();
        for (const name of ['stdout', 'stderr']) {
            if (!run[`${name}Pending`]) {
                run[`${name}Done`] = true;
                this._closePipe(run, name);
            }
        }
        this._maybeFinalize(run);
    }

    _closePipe(run, name) {
        const closed = `${name}Closed`;
        const closing = `${name}Closing`;
        if (run[closed] || run[closing])
            return;
        const stream = run[name];
        if (!stream || stream.is_closed()) {
            run[closed] = true;
            this._maybeFinalize(run);
            return;
        }
        // Called only after this stream's outstanding read has finished.
        run[closing] = true;
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (pipe, result) => {
            try {
                pipe.close_finish(result);
            } catch {
                // Closing an already dead pipe is harmless. Never log contents.
            }
            run[closing] = false;
            run[closed] = true;
            this._maybeFinalize(run);
        });
    }

    _maybeFinalize(run) {
        if (!run.exited || !run.stdoutDone || !run.stderrDone ||
            !run.stdoutClosed || !run.stderrClosed || this._run !== run)
            return;
        clearSource(run, 'startupSource');
        clearSource(run, 'idleSource');
        clearSource(run, 'drainSource');
        run.line.length = 0;
        this._run = null;
        for (const resolve of run.stopWaiters.splice(0))
            resolve();
        if (!this._active)
            return;
        if (this._generation !== run.generation) {
            // stop() followed immediately by start(): old child is now gone.
            this._spawn(this._generation);
            return;
        }
        if (run.exitCode === 77) {
            this._active = false;
            this._setStatus('permission', 'AAP-соединение запрещено системой. Проверьте Bluetooth-политику.');
            return;
        }
        if (run.exitCode === 64) {
            this._active = false;
            this._setStatus('error', 'Несовместимая версия AAP-хелпера. Пересоберите и установите расширение.');
            return;
        }
        const message = run.reason === 'protocol' || run.reason === 'output-limit'
            ? 'Некорректный ответ AAP-хелпера. Повторное подключение…'
            : run.reason === 'timeout'
                ? 'AirPods не обновляют заряд. Повторное подключение…'
                : 'AAP-соединение потеряно. Повторное подключение…';
        this._retry(run.generation, message);
    }

    _retry(generation, message) {
        if (!this._active || this._generation !== generation || this._retrySource)
            return;
        const nominal = Math.min(this._timing.retryMaxMs,
            this._timing.retryBaseMs * 2 ** Math.min(this._retryAttempt++, 16));
        const random = this._random();
        const jitter = Number.isFinite(random) ? 0.8 + Math.max(0, Math.min(1, random)) * 0.4 : 1;
        const delay = Math.max(1, Math.min(this._timing.retryMaxMs, Math.round(nominal * jitter)));
        this._setStatus('backoff', message);
        if (!this._active || this._generation !== generation)
            return;
        this._retrySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retrySource = 0;
            this._spawn(generation);
            return GLib.SOURCE_REMOVE;
        });
    }
}
