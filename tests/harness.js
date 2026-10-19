// A tiny test harness for plain gjs: no npm, no GNOME Shell.

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export class AssertionError extends Error {}

export function assert(cond, message = 'assertion failed') {
    if (!cond)
        throw new AssertionError(message);
}

export function equal(actual, expected, message = '') {
    if (actual !== expected)
        throw new AssertionError(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function near(actual, expected, tolerance, message = '') {
    if (!(Math.abs(actual - expected) <= tolerance))
        throw new AssertionError(`${message} expected ${expected} ± ${tolerance}, got ${actual}`);
}

export function deepEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new AssertionError(`${message} expected ${e}, got ${a}`);
}

// Deterministic random numbers (mulberry32), so animation tests are repeatable.
export function seeded(seed = 1) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export async function run() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
            if (!(e instanceof AssertionError))
                print(e.stack);
        }
    }
    print(`\n${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
    return failed;
}
