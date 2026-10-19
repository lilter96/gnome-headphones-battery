// The pet: a kitten in white headphones with a pink bow and a Sims plumbob.
// Drawn with Cairo and animated with springs; no Shell imports, so it also
// renders under plain gjs (handy for checking frames without restarting).
//
// Coordinates are "cat units": the backdrop disc has radius 100 and is centred
// at the origin, y grows downwards. HERO.scale maps units to logical pixels.

import Cairo from 'cairo';

const TAU = 2 * Math.PI;

export const HERO = {scale: 0.625, x0: -128, y0: -200, w: 256, h: 320};
export const GLYPH = {w: 22, h: 26};

export const SLEEP_AFTER = 180;    // seconds of silence before the cat dozes off
const BPM = 112;

// --- colour ------------------------------------------------------------------

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};

// Mood colours animate in OKLCH, the short way round the hue circle: green
// turns red through yellow and orange like the plumbob, not through brown.
const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

export function toOklch(rgb) {
    const [r, g, b] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q;
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q, Math.hypot(A, B), Math.atan2(B, A)];
}

export function fromOklch([L, C, h]) {
    const A = C * Math.cos(h), B = C * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const q = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
        -0.0041960863 * l - 0.7034186453 * m + 1.7076147010 * q,
    ].map(v => toGamma(clamp(v, 0, 1)));
}

// Point three springs [L, C, h] at an sRGB colour.
export function aimColor([L, C, h], rgb, snap = false) {
    const [l, c, hue] = toOklch(rgb);
    const near = hue + 2 * Math.PI * Math.round((h.x - hue) / (2 * Math.PI));
    for (const [sp, v] of [[L, l], [C, c], [h, near]]) {
        if (snap)
            sp.snap(v);
        else
            sp.to(v);
    }
}

// Sims mood colours, taken from Apple's dark-mode system palette.
// Mood follows how much music is left, not the bare percentage.
export const MOODS = [
    {min: 3, color: hex('#30d158'), energy: 1},
    {min: 1, color: hex('#ffd60a'), energy: 0.8},
    {min: 1 / 3, color: hex('#ff9f0a'), energy: 0.55},
    {min: 0, color: hex('#ff453a'), energy: 0.32},
];

export function moodFor(hours) {
    if (!(hours >= 0))
        return 0;
    return MOODS.findIndex(m => hours >= m.min);
}

const WHITE = [1, 1, 1];
const BLACK = [0, 0, 0];
const FUR_LIGHT = hex('#fbdcb6');
const FUR = hex('#efb784');
const FUR_SHADE = hex('#d39159');
const FUR_DEEP = hex('#b9733f');
const CREAM = hex('#fff4e8');
const CREAM_SHADE = hex('#f0d6bb');
const EAR_PINK = hex('#f290a5');
const EAR_PINK_LIGHT = hex('#ffc7d1');
const NOSE = hex('#ef8299');
const LINE = hex('#5b3323');
const EYE = hex('#1f130d');
const EYE_GLOW = hex('#5d3626');
const SHELL = hex('#f1f2f5');
const SHELL_SHADE = hex('#c3c8d2');
const CUSHION = hex('#e4dde6');
const CUSHION_SHADE = hex('#c9bfcc');
const BOW = hex('#ff4f9b');
const BOW_LIGHT = hex('#ff93c6');
const BOW_SHADE = hex('#d93485');
const BLUSH = hex('#ff7a9c');
const SWEAT = hex('#8fd5ff');

function src(cr, c, a = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], a);
}

function stops(p, list) {
    for (const [o, c, a = 1] of list)
        p.addColorStopRGBA(o, c[0], c[1], c[2], a);
    return p;
}

const linear = (x0, y0, x1, y1, list) => stops(new Cairo.LinearGradient(x0, y0, x1, y1), list);
const radial = (x0, y0, r0, x1, y1, r1, list) =>
    stops(new Cairo.RadialGradient(x0, y0, r0, x1, y1, r1), list);

// Static patterns live in fixed (head- or body-local) coordinates, build once.
const PAT = {};
function pat(name, make) {
    return PAT[name] ??= make();
}

// --- paths -------------------------------------------------------------------

const parsed = new Map();

// A small SVG path-data subset: M L H V C Q Z, absolute and relative.
function parse(d) {
    let out = parsed.get(d);
    if (out)
        return out;
    out = [];
    const tok = d.match(/[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)/g);
    let i = 0, cmd = 'M', x = 0, y = 0, sx = 0, sy = 0;
    const num = () => parseFloat(tok[i++]);
    while (i < tok.length) {
        if (/[A-Za-z]/.test(tok[i]))
            cmd = tok[i++];
        const rel = cmd === cmd.toLowerCase();
        const ox = rel ? x : 0, oy = rel ? y : 0;
        switch (cmd.toUpperCase()) {
        case 'M':
            x = ox + num(); y = oy + num();
            sx = x; sy = y;
            out.push([0, x, y]);
            cmd = rel ? 'l' : 'L';
            break;
        case 'L':
            x = ox + num(); y = oy + num();
            out.push([1, x, y]);
            break;
        case 'H':
            x = ox + num();
            out.push([1, x, y]);
            break;
        case 'V':
            y = oy + num();
            out.push([1, x, y]);
            break;
        case 'C': {
            const c = [ox + num(), oy + num(), ox + num(), oy + num()];
            x = ox + num(); y = oy + num();
            out.push([2, ...c, x, y]);
            break;
        }
        case 'Q': {
            const qx = ox + num(), qy = oy + num();
            const nx = ox + num(), ny = oy + num();
            out.push([2, x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y),
                nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny), nx, ny]);
            x = nx; y = ny;
            break;
        }
        case 'Z':
            out.push([3]);
            x = sx; y = sy;
            break;
        default:
            i++;
        }
    }
    parsed.set(d, out);
    return out;
}

function path(cr, d, newPath = true) {
    if (newPath)
        cr.newPath();
    for (const c of parse(d)) {
        if (c[0] === 0)
            cr.moveTo(c[1], c[2]);
        else if (c[0] === 1)
            cr.lineTo(c[1], c[2]);
        else if (c[0] === 2)
            cr.curveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        else
            cr.closePath();
    }
}

function ellipse(cr, x, y, rx, ry = rx) {
    cr.save();
    cr.translate(x, y);
    cr.scale(rx, ry);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

function arcPath(cr, cx, cy, rx, ry, a0, a1) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.newPath();
    cr.arc(0, 0, 1, a0, a1);
    cr.restore();
}

function mirrored(cr, fn) {
    fn(-1);
    cr.save();
    cr.scale(-1, 1);
    fn(1);
    cr.restore();
}

// --- shapes (cat units) ------------------------------------------------------

const HEAD = 'M 0 -58 C 36 -58 62 -40 63 -12 C 64 16 44 37 0 37 C -44 37 -64 16 -63 -12 C -62 -40 -36 -58 0 -58 Z';
const EAR = 'M -60 -22 C -62 -46 -56 -70 -47 -82 C -45 -85.5 -41 -85.5 -39 -83 C -30 -74 -20 -62 -12 -52 Z';
const EAR_IN = 'M -53 -34 C -54 -52 -49.5 -66 -44.5 -74.5 C -43.3 -76.5 -41.2 -76.6 -40 -74.8 C -34 -66.5 -27.5 -58 -21 -50 Z';
const EAR_PIVOT = [-38, -46];
const STRIPE_MID = 'M -3 -57.6 C -2.6 -51 -1.4 -46.5 0 -43.5 C 1.4 -46.5 2.6 -51 3 -57.6 Z';
const STRIPE_SIDE = 'M -16.5 -55.8 C -14.5 -51 -12.2 -48 -9.6 -46.2 C -10.4 -49.5 -11 -53 -11 -57 Z';
const MUZZLE = 'M -16 14 C -16 8 -9 6 0 8.5 C 9 6 16 8 16 14 C 16 21 9 24 0 21.5 C -9 24 -16 21 -16 14 Z';
const NOSE_PATH = 'M -4.8 8.6 C -4.8 6.8 4.8 6.8 4.8 8.6 C 4.8 10.6 1.7 12.8 0 12.8 C -1.7 12.8 -4.8 10.6 -4.8 8.6 Z';
const MOUTH = 'M 0 12.6 L 0 15 C 0 18.4 -4.6 19.6 -6.4 16.6 M 0 15 C 0 18.4 4.6 19.6 6.4 16.6';
const BODY = 'M -34 22 C -46 38 -52 62 -47 79 C -42 88 42 88 47 79 C 52 62 46 38 34 22 Z';
const TAIL = 'M 30 80 C 58 86 79 72 79 52 C 79 42 75 35 70 32';
const TAIL_PIVOT = [32, 78];
const NECK = 28;
const BOW_AT = [-28, -64];
const BOW_LOOP = 'M 0 0 C -5 -10 -17 -15 -20.5 -7.5 C -23 -1 -14 7 0 0 Z';
const BOW_FOLD = 'M -3 -1.2 C -8 -5.2 -12 -7.2 -15.5 -6.4';
const BOW_TAIL = 'M -1.5 1.5 C -4.5 6.5 -7.5 11 -9.5 15.5 L -4.4 14 C -3.2 10.2 -1.4 5.8 0.6 2.6 Z';
const NOTE = 'M 1.6 2.2 L 1.6 -11 C 4.6 -9.6 7.6 -8 7.4 -4.2';
const HEART = 'M 0 6 C -10 -1 -8 -9 -2.8 -8 C -1.2 -7.7 -0.4 -6.6 0 -5.5 C 0.4 -6.6 1.2 -7.7 2.8 -8 C 8 -9 10 -1 0 6 Z';
const ZED = 'M -4 -4 L 4 -4 L -4 4 L 4 4';
const DROP = 'M 0 -6 C 2.5 -2 4 0.5 4 2.6 C 4 5 2.2 6.6 0 6.6 C -2.2 6.6 -4 5 -4 2.6 C -4 0.5 -2.5 -2 0 -6 Z';

const RING_R = 112;
const RING_W = 11;
const PLUMB_Y = -156;

// --- springs -------------------------------------------------------------------

// SwiftUI-style spring: `response` is the period of the undamped oscillation in
// seconds, `damping` the damping fraction (1 = critical, < 1 bounces).
export class Spring {
    constructor(x, response = 0.5, damping = 1) {
        this.x = x;
        this.v = 0;
        this.target = x;
        this.tune(response, damping);
    }

    tune(response, damping = 1) {
        this.k = (TAU / response) ** 2;
        this.c = 4 * Math.PI * damping / response;
        return this;
    }

    to(target) {
        this.target = target;
        return this;
    }

    snap(x) {
        this.x = this.target = x;
        this.v = 0;
    }

    // Restart from x, keeping the target.
    from(x) {
        this.x = x;
        this.v = 0;
        return this;
    }

    kick(v) {
        this.v += v;
    }

    step(dt) {
        const n = Math.ceil(dt * 240);
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
            this.x += this.v * h;
        }
    }

    get resting() {
        return Math.abs(this.x - this.target) < 1e-3 && Math.abs(this.v) < 1e-2;
    }
}

// Blink: lids drop in 70 ms, rise in 120 ms.
function blinkCurve(t) {
    if (t < 0 || t > 0.19)
        return 1;
    return t < 0.07 ? 1 - smooth(0, 0.07, t) : smooth(0.07, 0.19, t);
}

// --- behaviour ---------------------------------------------------------------

export class Pet {
    constructor({random = Math.random, reducedMotion = false} = {}) {
        this.rand = random;
        this.reduced = reducedMotion;
        this.t = 0;
        this.state = {level: 0, lo: 0, hi: 0, precise: true, hours: 10, playing: false, volume: 0.5};
        this.idleFor = 0;
        this.mood = 0;
        this.particles = [];
        this.next = {blink: 1.2, glance: 0.8, squint: 3, twitch: 6, yawn: 20, note: 0, z: 0.4};
        this.blinkAt = -1;
        this.blinkTwice = false;
        this.squinting = false;
        this.look = [0, 0];
        this.pointerAt = null;
        this.wokeAt = -10;
        this.wakeUntil = 0;
        this.pokeUntil = 0;
        this.yawnUntil = 0;
        this.beat = 0;
        this.beatSign = 1;
        this.spin = 0.6;
        this.tailPhase = 0;
        this.breathPhase = 0;
        this._blink = 1;

        const c = toOklch(MOODS[0].color);
        const S = (x, r, d) => new Spring(x, r, d);
        this.s = {
            ring: S(0, 0.95, 0.9), ringHi: S(0, 0.95, 0.9),
            cL: S(c[0], 0.9), cC: S(c[1], 0.9), ch: S(c[2], 0.9),
            plumbY: S(0, 0.55, 0.45), plumbA: S(1, 0.3), plumbX: S(0, 0.7, 0.7), plumbK: S(1, 0.35, 0.35),
            roll: S(0, 0.45, 0.3), dip: S(0, 0.3, 0.45), sag: S(0, 1.6), bob: S(0, 0.8),
            earL: S(0, 0.5, 0.45), earR: S(0, 0.5, 0.45), bow: S(0, 0.3, 0.22),
            open: S(1, 0.22), happy: S(0, 0.25), lookX: S(0, 0.2, 0.82), lookY: S(0, 0.2, 0.82),
            blush: S(0.3, 0.6), sweat: S(0, 0.8), mouth: S(0, 0.3, 0.7),
            tailAmp: S(0.08, 1.2), breathAmp: S(1, 1.5),
        };
    }

    get sleeping() {
        return !this.state.playing && this.idleFor >= SLEEP_AFTER && this.t >= this.wakeUntil;
    }

    // state: {level, lo, hi, precise, hours, playing, volume, idleFor}
    update(state) {
        const wasSleeping = this.sleeping;
        const oldMood = this.mood;
        Object.assign(this.state, state);
        if (state.idleFor !== undefined)
            this.idleFor = state.idleFor;
        this.mood = moodFor(this.state.hours);
        // the first mood is where we start, not a change to animate
        if (!this._colored) {
            this._colored = true;
            aimColor([this.s.cL, this.s.cC, this.s.ch], MOODS[this.mood].color, true);
        }
        if (this.mood === 3 && oldMood !== 3)
            this.s.plumbK.kick(4);
        if (wasSleeping && !this.sleeping)
            this._wake();
    }

    _wake() {
        this.wokeAt = this.t;
        this.s.earL.kick(-3.2);
        this.s.earR.kick(-3.2);
        this.s.roll.kick(this.rand() < 0.5 ? -1.4 : 1.4);
        this.next.blink = this.t + 1.2;
    }

    // Popup opened: the ring sweeps in, the plumbob drops into place.
    intro() {
        const s = this.s;
        // Notes and Zs froze in mid-air when the popup closed; start clean.
        this.particles = [];
        if (this.reduced) {
            this.settle();
            return;
        }
        s.ring.from(0);
        s.ringHi.from(0);
        s.plumbY.from(-26);
        s.plumbA.from(0);
        if (!this.sleeping) {
            s.earL.kick(-2.4);
            s.earR.kick(-2.4);
            this.blinkAt = this.t + 0.32;
        }
    }

    // Jump straight to the resting pose (reduced motion, first frame).
    settle() {
        this.step(0);
        for (const sp of Object.values(this.s))
            sp.snap(sp.target);
        this.particles = [];
    }

    // Pointer position in cat units, or null when it leaves.
    pointer(p) {
        if (p && !this.pointerAt && this.sleeping)
            this.s.earR.kick(-2.6);
        this.pointerAt = p;
    }

    // A click on the cat.
    poke() {
        if (this.sleeping) {
            this.wakeUntil = this.t + 4;
            this._wake();
            return;
        }
        this.pokeUntil = this.t + 1.4;
        this.s.dip.kick(-70);
        this._emit('heart', 0, -66, 0, -42, 1.3);
    }

    _emit(kind, x, y, vx, vy, life) {
        this.particles.push({kind, x, y, vx, vy, life, age: 0, seed: this.rand() * TAU});
    }

    step(dt) {
        dt = Math.min(dt, 0.05);
        const t = this.t += dt;
        const R = this.rand, s = this.s, st = this.state, m = MOODS[this.mood];
        const sleeping = this.sleeping;
        const playing = st.playing && !sleeping;
        const lively = !this.reduced;
        if (!st.playing)
            this.idleFor += dt;

        aimColor([s.cL, s.cC, s.ch], m.color);
        s.ring.to(st.precise ? st.level : st.lo);
        s.ringHi.to(st.precise ? st.level : st.hi);
        s.plumbY.to(0);
        s.plumbA.to(1);
        s.plumbK.to(1);

        // Eyes: blinks, happy squints while the music plays, sleep.
        let blink = 1;
        if (!sleeping && lively) {
            if (t >= this.next.blink) {
                this.blinkAt = t;
                this.blinkTwice = R() < 0.18;
                this.next.blink = t + 2.2 + R() * 4.5;
            }
            blink = blinkCurve(t - this.blinkAt);
            if (this.blinkTwice)
                blink = Math.min(blink, blinkCurve(t - this.blinkAt - 0.26));
        }
        if (playing && lively) {
            if (t >= this.next.squint) {
                this.squinting = !this.squinting;
                this.next.squint = t + (this.squinting ? 1.5 + R() * 1.8 : 3 + R() * 4);
            }
        } else {
            this.squinting = false;
        }
        const happy = t < this.pokeUntil || this.squinting;
        if (!sleeping && !playing && this.mood >= 1 && lively && t >= this.next.yawn) {
            this.yawnUntil = t + 1.5;
            this.next.yawn = t + 16 + R() * 18;
        }
        const yawning = t < this.yawnUntil;

        const awakeOpen = [1, 0.86, 0.66, 0.5][this.mood];
        if (sleeping)
            s.open.tune(2.4);
        else if (t - this.wokeAt < 0.9)
            s.open.tune(0.34, 0.4);
        else
            s.open.tune(0.22);
        s.open.to(sleeping || happy ? 0 : yawning ? 0.25 : awakeOpen);
        s.happy.to(happy ? 1 : 0);
        s.mouth.to(yawning ? 1 : 0);

        // Gaze: follow the pointer, otherwise glance around now and then.
        if (sleeping) {
            this.look = [0, 0.3];
        } else if (this.pointerAt) {
            const [px, py] = this.pointerAt;
            this.look = [clamp(px / 70, -1, 1), clamp((py + 8) / 60, -1, 1)];
        } else if (lively && t >= this.next.glance) {
            this.look = R() < 0.35 ? [0, 0] : [R() * 2 - 1, (R() * 2 - 1) * 0.6];
            this.next.glance = t + 1.8 + R() * 4;
        }
        s.lookX.to(this.look[0]);
        s.lookY.to(this.look[1]);

        // Ears droop with the mood; one of them flicks once in a while.
        const droop = sleeping ? 0.16 : [0, 0.09, 0.2, 0.32][this.mood];
        s.earL.to(droop);
        s.earR.to(droop);
        if (!sleeping && lively && t >= this.next.twitch) {
            (R() < 0.5 ? s.earL : s.earR).kick(-2.6);
            this.next.twitch = t + 5 + R() * 9;
        }

        // Bobble-head: impulses on the beat into an underdamped neck spring.
        s.bob.to(playing && lively ? (0.55 + 0.6 * st.volume) * m.energy : 0);
        if (s.bob.x > 0.02) {
            this.beat += dt * BPM / 60;
            if (this.beat >= 1) {
                this.beat -= 1;
                this.beatSign = -this.beatSign;
                s.roll.kick(this.beatSign * 1.5 * s.bob.x);
                s.dip.kick(46 * s.bob.x);
                if (this.beatSign > 0 && R() < 0.75 * s.bob.x) {
                    const side = R() < 0.5 ? -1 : 1;
                    this._emit('note', side * 82, -14, side * (12 + R() * 8), -36 - R() * 10, 1.9);
                }
            }
        }
        const tilt = sleeping ? 0.07 : this.mood === 3 ? 0.05 : 0;
        s.roll.to(tilt + s.lookX.x * 0.05);
        s.dip.to(0);
        s.sag.to(sleeping ? 1 : this.mood === 3 ? 0.5 : 0);
        s.bow.to(s.roll.x);

        s.blush.to((t < this.pokeUntil ? 1 : playing ? 0.6 : 0.32) * (this.mood >= 2 ? 0.6 : 1));
        s.sweat.to(this.mood === 3 && !sleeping ? 1 : 0);

        // Breathing and the tail run on phase accumulators so that changes of
        // tempo never jump.
        s.tailAmp.to(!lively ? 0 : sleeping ? 0.03 : playing ? 0.13 : 0.08);
        s.breathAmp.to(lively ? 1 : 0);
        this.tailPhase += dt * TAU * (sleeping ? 0.15 : playing ? BPM / 120 : 0.35);
        this.breathPhase += dt * TAU / (sleeping ? 4.8 : 3.4);
        if (lively)
            this.spin += dt * TAU / 4.8;
        s.plumbX.to(s.roll.x * 22);

        if (sleeping && lively && t >= this.next.z) {
            this._emit('z', 34, -64, 14, -24, 2.8);
            this.next.z = t + 1.7;
        }

        for (const sp of Object.values(s))
            sp.step(dt);

        for (const p of this.particles) {
            p.age += dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
        this.particles = this.particles.filter(p => p.age < p.life);
        this._blink = blink;
    }

    // True while something is still moving; with reduced motion the loop can stop.
    get moving() {
        return !this.reduced || this.particles.length > 0 ||
            Object.values(this.s).some(sp => !sp.resting);
    }

    get color() {
        return fromOklch([this.s.cL.x, this.s.cC.x, this.s.ch.x]);
    }

    // The ring value to print next to the drawing, follows the sweep.
    get shownLevel() {
        return this.s.ring.x;
    }

    get pose() {
        const s = this.s;
        const breath = 1 + 0.014 * s.breathAmp.x * Math.sin(this.breathPhase);
        return {
            t: this.t,
            color: this.color,
            ring: s.ring.x,
            ringHi: s.ringHi.x,
            plumb: {
                x: s.plumbX.x,
                y: s.plumbY.x + 2.6 * s.breathAmp.x * Math.sin(this.t * TAU / 2.6),
                alpha: clamp(s.plumbA.x, 0, 1),
                scale: s.plumbK.x,
                spin: this.spin,
            },
            breath,
            tail: s.tailAmp.x * Math.sin(this.tailPhase),
            head: {
                roll: s.roll.x,
                dip: s.dip.x,
                sag: s.sag.x,
            },
            earL: s.earL.x,
            earR: s.earR.x,
            bow: (s.bow.x - s.roll.x) * 1.8,
            eyes: {
                open: Math.max(s.open.x, 0) * this._blink,
                happy: clamp(s.happy.x, 0, 1),
                lookX: s.lookX.x,
                lookY: s.lookY.x,
            },
            mouth: clamp(s.mouth.x, 0, 1.2),
            blush: clamp(s.blush.x, 0, 1),
            sweat: clamp(s.sweat.x, 0, 1),
            particles: this.particles,
        };
    }
}

// --- scene -------------------------------------------------------------------
//
// The hero is a tree of layers, like Core Animation: every layer is drawn once
// into its own texture and then only moved, turned, scaled or faded. A layer is
// redrawn only when its key() changes (eyes blinking, ring sweeping, plumbob
// spinning). Boxes sit on a grid of 8 units, so with HERO.scale = 5/8 every
// texture lands on whole pixels.
//
// Clutter composites this tree in the Shell, compose() does it with Cairo.

const qz = (v, step) => Math.round(v / step);
const colorKey = c => c.map(v => Math.round(v * 255)).join(',');

const headDy = p => p.head.dip + p.head.sag * 5 - (p.breath - 1) * 60;

export const SCENE = [
    {id: 'disc', box: [-104, -104, 208, 208], key: p => colorKey(p.color), draw: drawDisc},
    {id: 'ring', box: [-120, -120, 240, 240], draw: drawRing,
        key: p => `${qz(p.ring, 0.04)}|${qz(p.ringHi, 0.04)}|${colorKey(p.color)}`},
    {id: 'plumb', box: [-40, -200, 80, 88], pivot: [0, PLUMB_Y],
        key: p => `${qz(p.plumb.spin % (Math.PI / 2), 0.004)}|${colorKey(p.color)}`,
        draw: (cr, p) => drawPlumbob(cr, 0, PLUMB_Y, 12.5, p.plumb.spin, p.color, 1, true),
        xf: p => ({tx: p.plumb.x, ty: p.plumb.y, s: p.plumb.scale, alpha: p.plumb.alpha})},
    {id: 'shadow', box: [-56, 80, 112, 16], draw: drawShadow},
    {id: 'tail', box: [24, 24, 64, 72], pivot: TAIL_PIVOT, draw: drawTail,
        xf: p => ({rot: p.tail})},
    {id: 'body', box: [-56, 16, 112, 80], pivot: [0, 86], draw: drawBody,
        xf: p => ({sx: 1 + (p.breath - 1) * 0.4, sy: p.breath})},
    {id: 'paws', box: [-32, 72, 64, 24], draw: drawPaws},
    {id: 'head', box: [-88, -96, 176, 136], pivot: [0, NECK],
        xf: p => ({ty: headDy(p), rot: p.head.roll,
            sx: 1 + p.head.dip * 0.004, sy: 1 - p.head.dip * 0.006}),
        children: [
            {id: 'earL', box: [-64, -88, 56, 72], pivot: EAR_PIVOT,
                draw: cr => drawEar(cr, -1), xf: p => ({rot: -p.earL})},
            {id: 'earR', box: [8, -88, 56, 72], pivot: [-EAR_PIVOT[0], EAR_PIVOT[1]],
                draw: cr => drawEar(cr, 1), xf: p => ({rot: p.earR})},
            {id: 'skull', box: [-72, -64, 144, 104], draw: drawSkull},
            {id: 'blush', box: [-56, 0, 112, 24], draw: drawBlush, xf: p => ({alpha: p.blush})},
            {id: 'eyes', box: [-48, -32, 96, 56], draw: drawEyes,
                key: p => `${qz(p.eyes.open, 0.01)}|${qz(p.eyes.happy, 0.02)}`,
                xf: p => ({tx: p.eyes.lookX * 2.6, ty: p.eyes.lookY * 1.8})},
            {id: 'face', box: [-16, 0, 32, 32], key: p => qz(p.mouth, 0.02), draw: drawFace},
            {id: 'sweat', box: [40, -56, 16, 24], draw: drawSweat, xf: p => ({alpha: p.sweat})},
            {id: 'phones', box: [-88, -80, 176, 112], draw: drawPhones},
            {id: 'bow', box: [-56, -96, 64, 64], pivot: BOW_AT, draw: drawBow,
                xf: p => ({rot: p.bow})},
        ]},
];

export const PARTICLE_BOX = [-16, -16, 32, 32];

export function particleXf(q) {
    const k = q.age / q.life;
    const a = smooth(0, 0.12, k) * (1 - smooth(0.6, 1, k));
    if (q.kind === 'note') {
        return {tx: q.x + 5 * Math.sin(q.seed + q.age * 3.2), ty: q.y,
            rot: 0.25 * Math.sin(q.seed + q.age * 2.4), s: 0.75 + 0.3 * k, alpha: 0.8 * a};
    }
    if (q.kind === 'z')
        return {tx: q.x + 4 * Math.sin(q.seed + q.age * 1.6), ty: q.y, s: 0.6 + 0.6 * k, alpha: 0.7 * a};
    return {tx: q.x + 3 * Math.sin(q.seed + q.age * 5), ty: q.y,
        s: 0.6 + 0.9 * smooth(0, 0.25, k), alpha: a};
}

export function drawParticle(cr, kind) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    if (kind === 'note') {
        src(cr, WHITE);
        ellipse(cr, -1.6, 2.6, 3.6, 2.7);
        cr.fill();
        cr.setLineWidth(1.6);
        path(cr, NOTE);
        cr.stroke();
    } else if (kind === 'z') {
        cr.setLineWidth(2.2);
        src(cr, WHITE);
        path(cr, ZED);
        cr.stroke();
    } else {
        path(cr, HEART);
        src(cr, BOW);
        cr.fill();
    }
}

function withXf(cr, pivot, xf, fn) {
    const [px, py] = pivot ?? [0, 0];
    const alpha = xf.alpha ?? 1;
    if (alpha <= 0.004)
        return;
    cr.save();
    cr.translate(px + (xf.tx ?? 0), py + (xf.ty ?? 0));
    cr.rotate(xf.rot ?? 0);
    cr.scale(xf.sx ?? xf.s ?? 1, xf.sy ?? xf.s ?? 1);
    cr.translate(-px, -py);
    if (alpha < 0.996)
        cr.pushGroup();
    fn();
    if (alpha < 0.996) {
        cr.popGroupToSource();
        cr.paintWithAlpha(alpha);
    }
    cr.restore();
}

// Cairo compositor for the scene; cr must be in cat units.
export function compose(cr, p, layers = SCENE) {
    for (const l of layers) {
        withXf(cr, l.pivot, l.xf?.(p) ?? {}, () => {
            l.draw?.(cr, p);
            if (l.children)
                compose(cr, p, l.children);
        });
    }
    if (layers === SCENE) {
        for (const q of p.particles)
            withXf(cr, null, particleXf(q), () => drawParticle(cr, q.kind));
    }
}

// --- layer drawings (absolute cat units) ---------------------------------------

function drawDisc(cr, p) {
    cr.newPath();
    ellipse(cr, 0, 0, 100);
    cr.setSource(pat('disc', () => radial(-18, -46, 0, 0, 0, 100,
        [[0, WHITE, 0.13], [0.7, WHITE, 0.06], [1, WHITE, 0.035]])));
    cr.fillPreserve();
    src(cr, p.color, 0.07);
    cr.fill();
}

function drawRing(cr, p) {
    const c = p.color;
    const a0 = -Math.PI / 2;
    const v = clamp(p.ring / 100, 0, 1);
    const vh = clamp(p.ringHi / 100, 0, 1);
    cr.setLineWidth(RING_W);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, c, 0.17);
    cr.newPath();
    cr.arc(0, 0, RING_R, 0, TAU);
    cr.stroke();

    // HFP reports in 10% steps: solid up to the lower bound, fading out towards
    // the upper one. Segments overwrite each other (SOURCE), so no seams.
    if (vh > v + 0.002) {
        const n = 32;
        cr.pushGroup();
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setLineCap(Cairo.LineCap.BUTT);
        for (let i = 0; i < n; i++) {
            const f0 = v + (vh - v) * i / n;
            const f1 = Math.min(v + (vh - v) * (i + 1.5) / n, vh);
            src(cr, c, 0.8 * (1 - i / n) ** 1.5 + 0.06);
            cr.newPath();
            cr.arc(0, 0, RING_R, a0 + f0 * TAU, a0 + f1 * TAU);
            cr.stroke();
        }
        cr.popGroupToSource();
        cr.paint();
    }
    if (v > 0.0005) {
        src(cr, c);
        cr.newPath();
        cr.arc(0, 0, RING_R, a0, a0 + v * TAU);
        cr.stroke();
    }
}

function drawShadow(cr) {
    cr.save();
    cr.translate(0, 88);
    cr.scale(1, 0.12);
    cr.setSource(pat('shadow', () => radial(0, 0, 0, 0, 0, 50,
        [[0, BLACK, 0.34], [0.6, BLACK, 0.16], [1, BLACK, 0]])));
    cr.newPath();
    cr.arc(0, 0, 50, 0, TAU);
    cr.fill();
    cr.restore();
}

function drawTail(cr) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(10.5);
    path(cr, TAIL);
    cr.setSource(pat('tail', () => linear(30, 80, 76, 34, [[0, FUR_SHADE], [0.5, FUR], [1, FUR_SHADE]])));
    cr.strokePreserve();
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setDash([3.2, 6.5], 4);
    src(cr, FUR_DEEP, 0.35);
    cr.stroke();
    cr.setDash([], 0);
}

function drawBody(cr) {
    path(cr, BODY);
    cr.setSource(pat('body', () => radial(-16, 34, 4, -4, 50, 70,
        [[0, FUR_LIGHT], [0.5, FUR], [1, FUR_SHADE]])));
    cr.fill();
    cr.save();
    cr.translate(0, 52);
    cr.scale(1, 1.18);
    cr.setSource(pat('chest', () => radial(0, 0, 0, 0, 0, 20,
        [[0, CREAM, 0.95], [0.65, CREAM, 0.7], [1, CREAM, 0]])));
    cr.newPath();
    cr.arc(0, 0, 20, 0, TAU);
    cr.fill();
    cr.restore();
    cr.setLineWidth(1.6);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, FUR_SHADE, 0.45);
    mirrored(cr, () => {
        path(cr, 'M -40 60 C -33 59 -29 67 -30 78');
        cr.stroke();
    });
}

function drawPaws(cr) {
    mirrored(cr, () => {
        cr.newPath();
        ellipse(cr, -15, 81, 11, 6.8);
        cr.setSource(pat('paw', () => linear(0, 74.5, 0, 88, [[0, CREAM], [1, CREAM_SHADE]])));
        cr.fill();
        cr.setLineWidth(1.1);
        cr.setLineCap(Cairo.LineCap.ROUND);
        src(cr, FUR_SHADE, 0.5);
        for (const dx of [-3.6, 3.6]) {
            cr.newPath();
            cr.moveTo(-15 + dx, 78.8);
            cr.lineTo(-15 + dx * 1.1, 82);
            cr.stroke();
        }
    });
}

function drawEar(cr, side) {
    cr.save();
    cr.scale(side < 0 ? 1 : -1, 1);
    path(cr, EAR);
    cr.setSource(pat('ear', () => linear(-46, -84, -34, -40, [[0, FUR_SHADE], [0.35, FUR], [1, FUR_SHADE]])));
    cr.fill();
    path(cr, EAR_IN);
    cr.setSource(pat('earIn', () => linear(-43, -76, -36, -44, [[0, EAR_PINK_LIGHT], [1, EAR_PINK]])));
    cr.fill();
    cr.restore();
}

function drawSkull(cr) {
    path(cr, HEAD);
    cr.setSource(pat('head', () => radial(-20, -38, 4, -6, -14, 92,
        [[0, FUR_LIGHT], [0.55, FUR], [1, FUR_SHADE]])));
    cr.fill();
    src(cr, FUR_DEEP, 0.42);
    path(cr, STRIPE_MID);
    cr.fill();
    mirrored(cr, () => {
        path(cr, STRIPE_SIDE);
        cr.fill();
    });
    path(cr, MUZZLE);
    cr.setSource(pat('muzzle', () => linear(0, 7, 0, 23, [[0, CREAM], [1, CREAM_SHADE]])));
    cr.fill();
}

function drawBlush(cr) {
    mirrored(cr, () => {
        cr.save();
        cr.translate(-39, 13);
        cr.scale(1, 0.58);
        cr.setSource(pat('blush', () => radial(0, 0, 0, 0, 0, 10, [[0, BLUSH, 0.55], [1, BLUSH, 0]])));
        cr.newPath();
        cr.arc(0, 0, 10, 0, TAU);
        cr.fill();
        cr.restore();
    });
}

function drawEyes(cr, p) {
    drawEye(cr, -25, -6, p.eyes, -1);
    drawEye(cr, 25, -6, p.eyes, 1);
}

function drawEye(cr, x, y, e, side) {
    const o = clamp(e.open, 0, 1.3);
    const h = e.happy;
    const wide = Math.max(o - 1, 0);
    const rx = 11.2 * (1 + 0.22 * wide), ry = 13.4 * (1 + 0.35 * wide);
    const shut = Math.min(o, 1);
    const top = y - ry, bottom = y + ry, H = 2 * ry;
    // the upper lid comes down to blink or doze, the lower one rises to smile
    const lidTop = top + (1 - shut) * (1 - h) * H * 1.04;
    const lidBot = bottom - (1 - shut) * h * H * 1.04;
    const bTop = 1.2 * (1 - shut) * (1 - h);
    const bBot = 4.9 * (1 - shut) * h;
    // a tired lid sags towards the outer corner
    const sag = 4.2 * (1 - shut) * (1 - h) * smooth(0.02, 0.3, shut);
    const t0 = -side * sag, t1 = side * sag;
    const X0 = x - rx - 2, X1 = x + rx + 2;
    const topLid = () => {
        cr.moveTo(X0, lidTop + t0);
        cr.curveTo(x - rx * 0.4, lidTop + bTop + t0 * 0.45, x + rx * 0.4, lidTop + bTop + t1 * 0.45,
            X1, lidTop + t1);
    };
    const botLid = () => {
        cr.moveTo(X0, lidBot);
        cr.curveTo(x - rx * 0.4, lidBot - bBot, x + rx * 0.4, lidBot - bBot, X1, lidBot);
    };

    if (shut > 0.03) {
        cr.save();
        cr.newPath();
        ellipse(cr, x, y, rx, ry);
        cr.clip();
        // Two separate clips, so crossing lid curves can never leave a sliver.
        cr.newPath();
        topLid();
        cr.lineTo(X1, bottom + 20);
        cr.lineTo(X0, bottom + 20);
        cr.closePath();
        cr.clip();
        cr.newPath();
        botLid();
        cr.lineTo(X1, top - 20);
        cr.lineTo(X0, top - 20);
        cr.closePath();
        cr.clip();
        cr.setSource(radial(x, y + 7.5, 1, x, y + 2, 17, [[0, EYE_GLOW], [1, EYE]]));
        cr.paint();
        src(cr, WHITE, 0.95);
        cr.newPath();
        ellipse(cr, x + 4.4, y - 5.6, 4.6);
        cr.fill();
        src(cr, WHITE, 0.75);
        ellipse(cr, x - 4.2, y + 5.4, 2.1);
        cr.fill();
        cr.restore();

        const edge = smooth(0.98, 0.8, shut);
        if (edge > 0.01) {
            cr.save();
            cr.newPath();
            ellipse(cr, x, y, rx + 0.9, ry + 0.9);
            cr.clip();
            cr.newPath();
            if (h < 0.5)
                topLid();
            else
                botLid();
            cr.setLineWidth(1.5);
            cr.setLineCap(Cairo.LineCap.ROUND);
            src(cr, LINE, 0.6 * edge);
            cr.stroke();
            cr.restore();
        }
    }

    // fully closed: ^ when happy, a soft ‿ when asleep
    const closed = smooth(0.2, 0.04, shut);
    if (closed > 0.01) {
        const ctrl = -8 * h + 6 * (1 - h);
        const end = 2 * h - 1.5 * (1 - h);
        cr.newPath();
        cr.moveTo(x - 9, y + end);
        cr.curveTo(x - 4, y + ctrl, x + 4, y + ctrl, x + 9, y + end);
        cr.setLineWidth(2.6);
        cr.setLineCap(Cairo.LineCap.ROUND);
        src(cr, LINE, closed);
        cr.stroke();
    }
}

function drawFace(cr, p) {
    if (p.mouth > 0.03) {
        const m = p.mouth;
        cr.newPath();
        ellipse(cr, 0, 18.6 + 1.5 * m, 2.4 + 2.6 * m, 1 + 4.6 * m);
        src(cr, hex('#7a2c35'));
        cr.fillPreserve();
        cr.save();
        cr.clip();
        cr.newPath();
        ellipse(cr, 0, 22 + 4 * m, 3.4 * m + 1, 2.6 * m);
        src(cr, hex('#f27c95'));
        cr.fill();
        cr.restore();
    }
    path(cr, NOSE_PATH);
    cr.setSource(pat('nose', () => linear(0, 7, 0, 13, [[0, hex('#f7a3b5')], [1, NOSE]])));
    cr.fill();
    cr.newPath();
    ellipse(cr, -1.4, 8.3, 1.6, 0.9);
    src(cr, WHITE, 0.55);
    cr.fill();
    cr.setLineWidth(1.5);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, LINE, 0.9);
    path(cr, MOUTH);
    cr.stroke();
}

function drawSweat(cr) {
    cr.save();
    cr.translate(47, -42);
    cr.scale(0.9, 0.9);
    path(cr, DROP);
    cr.setSource(pat('sweat', () => linear(0, -6, 0, 6.6, [[0, WHITE, 0.95], [1, SWEAT, 0.95]])));
    cr.fill();
    cr.restore();
}

function drawPhones(cr) {
    mirrored(cr, () => {
        cr.newPath();
        ellipse(cr, -56.5, -1, 8.5, 22.5);
        cr.setSource(pat('cushion', () => linear(-63, 0, -49, 0, [[0, CUSHION_SHADE], [1, CUSHION]])));
        cr.fill();
    });

    cr.setLineCap(Cairo.LineCap.BUTT);
    arcPath(cr, 0, -18, 66, 52, Math.PI, TAU);
    cr.setLineWidth(9);
    cr.setSource(pat('band', () => linear(0, -75, 0, -38, [[0, WHITE], [1, hex('#d9dde5')]])));
    cr.stroke();
    cr.setLineWidth(0.8);
    src(cr, BLACK, 0.08);
    arcPath(cr, 0, -18, 70.5, 56.5, Math.PI * 1.03, Math.PI * 1.97);
    cr.stroke();
    src(cr, BLACK, 0.12);
    arcPath(cr, 0, -18, 61.5, 47.5, Math.PI * 1.03, Math.PI * 1.97);
    cr.stroke();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(1.6);
    src(cr, WHITE, 0.95);
    arcPath(cr, 0, -18, 68, 54, Math.PI * 1.2, Math.PI * 1.8);
    cr.stroke();

    for (const side of [-1, 1]) {
        const cx = side * 67.5;
        cr.newPath();
        ellipse(cr, cx, -1, 15, 25.5);
        cr.setSource(pat(`shell${side}`, () => radial(cx - 5.5, -13, 2, cx + 0.5, -3, 30,
            [[0, WHITE], [0.55, SHELL], [1, SHELL_SHADE]])));
        cr.fillPreserve();
        src(cr, BLACK, 0.09);
        cr.setLineWidth(0.9);
        cr.stroke();
        ellipse(cr, cx + side * 2.5, -1, 9.5, 19);
        cr.setSource(pat('plate', () => linear(0, -20, 0, 18, [[0, WHITE], [1, hex('#e1e4eb')]])));
        cr.fillPreserve();
        src(cr, BLACK, 0.05);
        cr.setLineWidth(0.8);
        cr.stroke();
        ellipse(cr, cx - 4 + side * 1.5, -13, 2.4, 5.6);
        src(cr, WHITE, 0.9);
        cr.fill();
    }
}

function drawBow(cr) {
    cr.save();
    cr.translate(...BOW_AT);
    cr.rotate(-0.32);
    src(cr, BOW_SHADE);
    mirrored(cr, () => {
        path(cr, BOW_TAIL);
        cr.fill();
    });
    for (const side of [-1, 1]) {
        cr.save();
        cr.scale(side, 1);
        path(cr, BOW_LOOP);
        cr.setSource(pat(`loop${side}`, () => radial(-9 * side, -9, 1, -9 * side, -5, 16,
            [[0, BOW_LIGHT], [0.6, BOW], [1, BOW_SHADE]])));
        cr.fill();
        cr.setLineWidth(1.2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        src(cr, BOW_SHADE, 0.7);
        path(cr, BOW_FOLD);
        cr.stroke();
        cr.restore();
    }
    cr.newPath();
    ellipse(cr, 0, -0.6, 4.6, 5);
    cr.setSource(pat('knot', () => radial(-1.2, -2.2, 0.5, 0, -0.6, 5.5, [[0, BOW_LIGHT], [1, BOW_SHADE]])));
    cr.fill();
    cr.restore();
}

// An elongated octahedron spinning about its vertical axis, seen slightly from above.
export function drawPlumbob(cr, x, y, w, spin, color, alpha = 1, glow = false) {
    if (alpha <= 0.01 || w <= 0)
        return;
    const hT = w * 1.38, hB = w * 2.05;
    cr.save();
    cr.translate(x, y);
    if (glow) {
        cr.setSource(radial(0, 0, 0, 0, 0, w * 2.9,
            [[0, color, 0.42 * alpha], [0.45, color, 0.14 * alpha], [1, color, 0]]));
        cr.rectangle(-w * 3, -w * 3, w * 6, w * 6);
        cr.fill();
    }
    const pitch = -0.24, cp = Math.cos(pitch), sp = Math.sin(pitch);
    const view = ([vx, vy, vz]) => [vx, vy * cp - vz * sp, vy * sp + vz * cp];
    const top = view([0, -hT, 0]);
    const bot = view([0, hB, 0]);
    const eq = [0, 1, 2, 3].map(k => view([
        w * Math.cos(spin + k * Math.PI / 2), 0, w * Math.sin(spin + k * Math.PI / 2)]));
    const L = [-0.45, -0.62, 0.64];
    const light = mix(color, WHITE, 0.55);
    const dark = mix(color, BLACK, 0.42);
    const faces = [];
    for (let k = 0; k < 4; k++) {
        const a = eq[k], b = eq[(k + 1) % 4];
        faces.push([top, a, b, true], [bot, b, a, false]);
    }
    for (const [p0, p1, p2, upper] of faces) {
        const u = p1.map((v, i) => v - p0[i]);
        const v = p2.map((q, i) => q - p0[i]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const cen = [0, 1, 2].map(i => (p0[i] + p1[i] + p2[i]) / 3);
        if (n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] < 0)
            n = n.map(q => -q);
        if (n[2] <= 0)
            continue;
        const len = Math.hypot(...n);
        const lam = clamp((n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / len, 0, 1);
        const fill = mix(dark, light, clamp(lam * 1.05 + (upper ? 0.12 : 0), 0, 1));
        cr.newPath();
        cr.moveTo(p0[0], p0[1]);
        cr.lineTo(p1[0], p1[1]);
        cr.lineTo(p2[0], p2[1]);
        cr.closePath();
        src(cr, fill, alpha);
        cr.fillPreserve();
        src(cr, WHITE, 0.28 * alpha);
        cr.setLineWidth(Math.max(w * 0.05, 0.25));
        cr.stroke();
    }
    cr.restore();
}

// --- drawing: panel glyph ----------------------------------------------------

// Monochrome, cut like a symbolic icon: the classic headphones symbol (band and
// two cups) with a cat face inside; only the plumbob above carries colour.
// Knockouts keep the parts apart. Geometry in panel pixels.
// g: {open, roll, dy, scale, plumb, color}
const G = {
    head: [11, 19.8, 6.6, 5.1],
    earOut: [5.9, -1.6], earTip: [4.3, -8.6], earIn: [1.5, -4.7], earR: 0.7,
    band: [18.2, 9.2, 1.5, 0.12],   // centre y, radius, width, end angle
    cup: [9.05, 16.0, 3.3, 7.0, 1.5],   // centre dx, top, width, height, corner
    gap: 0.85,
    eye: [2.7, 0.1, 1.1, 1.45],
    noseY: 2.4,
    plumb: [3.3, 2.1],
};

function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export function drawGlyph(cr, fg, g) {
    const [cx, hy, hrx, hry] = G.head;
    const [by, R, bw, a0] = G.band;
    const [cupX, cupY, cupW, cupH, cupR] = G.cup;
    const band = () => {
        cr.newPath();
        cr.arc(cx, by, R, Math.PI + a0, TAU - a0);
    };
    const cups = (grow = 0) => {
        cr.newPath();
        for (const side of [-1, 1]) {
            roundRect(cr, cx + side * cupX - cupW / 2 - grow, cupY - grow,
                cupW + 2 * grow, cupH + 2 * grow, cupR + grow);
        }
    };

    cr.save();
    cr.translate(cx, hy + g.dy);
    cr.scale(g.scale, g.scale);
    cr.rotate(g.roll);
    cr.translate(-cx, -hy);

    // opaque inside the group, the panel alpha is applied once at the end
    cr.pushGroup();
    src(cr, fg);
    cr.newPath();
    ellipse(cr, cx, hy, hrx, hry);
    cr.fill();
    for (const side of [-1, 1]) {
        const [ox, oy] = G.earOut, [tx, ty] = G.earTip, [ix, iy] = G.earIn, r = G.earR;
        const ax = cx + side * tx, ay = hy + ty;
        cr.newPath();
        cr.moveTo(cx + side * ox, hy + oy);
        cr.lineTo(ax + side * r * 0.3, ay + r);
        cr.curveTo(ax, ay - r * 0.2, ax, ay - r * 0.2, ax + side * r, ay + r * 0.55);
        cr.lineTo(cx + side * ix, hy + iy);
        cr.closePath();
        cr.fill();
    }

    cr.setOperator(Cairo.Operator.CLEAR);
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setLineWidth(bw + 2 * G.gap);
    band();
    cr.stroke();
    cups(G.gap);
    cr.fill();

    const [eyeX, eyeY, eyeRx, eyeRy] = G.eye;
    const o = clamp(g.open, 0, 1);
    for (const side of [-1, 1]) {
        const ex = cx + side * eyeX, ey = hy + eyeY;
        cr.newPath();
        if (o > 0.25) {
            ellipse(cr, ex, ey, eyeRx, eyeRy * o);
            cr.fill();
        } else {
            cr.setLineWidth(0.95);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.moveTo(ex - 1.3, ey - 0.3);
            cr.curveTo(ex - 0.6, ey + 0.8, ex + 0.6, ey + 0.8, ex + 1.3, ey - 0.3);
            cr.stroke();
        }
    }
    cr.newPath();
    cr.moveTo(cx - 0.9, hy + G.noseY);
    cr.lineTo(cx + 0.9, hy + G.noseY);
    cr.lineTo(cx, hy + G.noseY + 0.9);
    cr.closePath();
    cr.fill();

    cr.setOperator(Cairo.Operator.OVER);
    src(cr, fg);
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setLineWidth(bw);
    band();
    cr.stroke();
    cups();
    cr.fill();
    cr.popGroupToSource();
    cr.paintWithAlpha(fg[3] ?? 1);
    cr.restore();

    const [plY, plW] = G.plumb;
    drawPlumbob(cr, cx, plY + g.dy * 0.4, plW * g.plumb * g.scale, 0.62, g.color, 1, false);
}
