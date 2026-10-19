import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import {
    GLYPH, HERO, MOODS, Pet, SCENE, SLEEP_AFTER, Spring,
    aimColor, compose, drawGlyph, fromOklch, moodFor, toOklch,
} from '../headphones-battery@terentiy/pet.js';
import {assert, equal, near, seeded, test} from './harness.js';

const FRAME = 1 / 165;

function settleSpring(sp, seconds) {
    let peak = sp.x;
    for (let t = 0; t < seconds; t += FRAME) {
        sp.step(FRAME);
        peak = Math.max(peak, sp.x);
    }
    return peak;
}

function newPet(state = {}, opts = {}) {
    const pet = new Pet({random: seeded(7), ...opts});
    pet.update({level: 64, lo: 64, hi: 65, precise: true, hours: 20, playing: false, volume: 0.87, idleFor: 0, ...state});
    return pet;
}

function run(pet, seconds) {
    for (let t = 0; t < seconds; t += FRAME)
        pet.step(FRAME);
}

function layers(list = SCENE, out = []) {
    for (const l of list) {
        out.push(l);
        if (l.children)
            layers(l.children, out);
    }
    return out;
}

// gjs cannot read Cairo pixels directly: go through a PNG.
function pixels(surf) {
    const path = GLib.build_filenamev([GLib.get_tmp_dir(), `hp-test-${GLib.random_int()}.png`]);
    surf.writeToPNG(path);
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    GLib.unlink(path);
    const data = pb.get_pixels(), stride = pb.get_rowstride(), n = pb.get_n_channels();
    return (x, y) => {
        const i = Math.round(y) * stride + Math.round(x) * n;
        return [data[i], data[i + 1], data[i + 2], n === 4 ? data[i + 3] : 255];
    };
}

test('mood follows hours of music left, with Sims colours', () => {
    equal(moodFor(12), 0);
    equal(moodFor(3), 0);
    equal(moodFor(2.99), 1);
    equal(moodFor(1), 1);
    equal(moodFor(0.99), 2);
    equal(moodFor(1 / 3), 2);
    equal(moodFor(0.2), 3);
    equal(moodFor(NaN), 0, 'unknown is calm');
    equal(MOODS.length, 4);
});

test('springs: the undamped period equals the response (SwiftUI semantics)', () => {
    const sp = new Spring(0, 0.5, 0).to(1);
    for (let t = 0; t < 0.25; t += 1 / 240)
        sp.step(1 / 240);
    near(sp.x, 2, 0.06, 'half a period: furthest point');
    for (let t = 0; t < 0.25; t += 1 / 240)
        sp.step(1 / 240);
    near(sp.x, 0, 0.06, 'a full period: back at the start');
});

test('springs: critical damping never overshoots, low damping does', () => {
    const critical = settleSpring(new Spring(0, 0.4, 1).to(1), 2);
    assert(critical <= 1 + 1e-6, `critical peak ${critical}`);
    const bouncy = settleSpring(new Spring(0, 0.4, 0.3).to(1), 2);
    assert(bouncy > 1.2, `bouncy peak ${bouncy}`);
});

test('springs settle and report rest; from() keeps the target, snap() moves it', () => {
    const sp = new Spring(0, 0.3, 1).to(5);
    settleSpring(sp, 2);
    assert(sp.resting, 'resting');
    near(sp.x, 5, 1e-3);
    sp.from(0);
    equal(sp.target, 5);
    assert(!sp.resting);
    sp.snap(2);
    equal(sp.target, 2);
    assert(sp.resting);
});

test('springs are frame-rate independent', () => {
    const at = hz => {
        const sp = new Spring(0, 0.5, 0.7).to(1);
        for (let i = 0; i < Math.round(0.3 * hz); i++)
            sp.step(1 / hz);
        return sp.x;
    };
    near(at(60), at(165), 0.01);
    near(at(30), at(240), 0.02);
});

test('OKLCH round-trips sRGB', () => {
    const rand = seeded(3);
    for (let i = 0; i < 200; i++) {
        const c = [rand(), rand(), rand()];
        const back = fromOklch(toOklch(c));
        // The published OKLab matrices are rounded to 10 digits; one 8-bit step is 0.004.
        for (let k = 0; k < 3; k++)
            near(back[k], c[k], 1e-5, `channel ${k} of ${c}`);
    }
});

test('green turns red through warm colours, not brown', () => {
    const [L, C, h] = toOklch(MOODS[0].color).map(v => new Spring(v, 0.9));
    aimColor([L, C, h], MOODS[3].color);
    assert(Math.abs(h.target - h.x) < Math.PI, 'short way round the hue circle');
    let minSpread = 1;
    for (let t = 0; t < 2; t += FRAME) {
        [L, C, h].forEach(sp => sp.step(FRAME));
        const rgb = fromOklch([L.x, C.x, h.x]);
        minSpread = Math.min(minSpread, Math.max(...rgb) - Math.min(...rgb));
    }
    // A straight RGB mix of the two passes a muddy (0.59, 0.55, 0.29): spread 0.30.
    assert(minSpread > 0.45, `colour stays vivid, spread ${minSpread.toFixed(2)}`);
});

test('the first mood is shown as is, later changes animate', () => {
    const pet = newPet({hours: 0.2});
    const red = MOODS[3].color;
    pet.color.forEach((v, k) => near(v, red[k], 1e-6));
    pet.update({hours: 20});
    pet.step(FRAME);
    assert(Math.abs(pet.color[1] - red[1]) < 0.2, 'no jump to green');
});

test('the cat dozes off after silence and a click wakes it for a while', () => {
    const pet = newPet({playing: false, idleFor: SLEEP_AFTER - 1});
    assert(!pet.sleeping);
    run(pet, 2);
    assert(pet.sleeping, 'asleep after silence');
    pet.poke();
    assert(!pet.sleeping, 'awake after a click');
    run(pet, 5);
    assert(pet.sleeping, 'dozes off again');
});

test('music starts the bobble-head and the notes', () => {
    const pet = newPet({playing: true});
    let notes = 0, maxRoll = 0;
    for (let t = 0; t < 8; t += FRAME) {
        pet.step(FRAME);
        notes = Math.max(notes, pet.particles.filter(q => q.kind === 'note').length);
        maxRoll = Math.max(maxRoll, Math.abs(pet.s.roll.x));
    }
    assert(notes > 0, 'notes fly');
    assert(maxRoll > 0.02, `head bobs, roll ${maxRoll}`);
    assert(!pet.sleeping);
});

test('sleeping cats breathe out Z, poked cats send a heart', () => {
    const sleepy = newPet({idleFor: SLEEP_AFTER + 10});
    run(sleepy, 4);
    assert(sleepy.particles.some(q => q.kind === 'z'), 'Z');
    const awake = newPet();
    awake.poke();
    assert(awake.particles.some(q => q.kind === 'heart'), 'heart');
});

test('the intro sweeps the ring from zero to the level', () => {
    const pet = newPet({level: 64});
    run(pet, 2);
    pet.intro();
    near(pet.shownLevel, 0, 1e-9, 'starts empty');
    let last = 0, monotone = true;
    for (let t = 0; t < 0.4; t += FRAME) {
        pet.step(FRAME);
        monotone &&= pet.shownLevel >= last - 1e-9;
        last = pet.shownLevel;
    }
    assert(monotone, 'counts up');
    run(pet, 2);
    near(pet.shownLevel, 64, 0.5, 'lands on the level');
});

test('reopening the popup does not resume particles frozen last time', () => {
    const pet = newPet({idleFor: SLEEP_AFTER + 10});
    run(pet, 4);
    assert(pet.particles.length > 0, 'Zs while asleep');
    pet.update({playing: true, idleFor: 0});
    pet.intro();
    equal(pet.particles.length, 0);
});

test('reduced motion: everything lands at once and the loop can stop', () => {
    const pet = newPet({playing: true}, {reducedMotion: true});
    pet.intro();
    near(pet.shownLevel, 64, 1e-9);
    run(pet, 5);
    equal(pet.particles.length, 0, 'no particles');
    assert(!pet.moving, 'nothing left to animate');
});

test('redraw budget: textures repaint only when their look changes', () => {
    const pet = newPet({playing: false});
    run(pet, 3);
    const counted = layers().filter(l => l.key);
    const keys = new Map(counted.map(l => [l.id, l.key(pet.pose)]));
    const changes = new Map(counted.map(l => [l.id, 0]));
    const frames = 165 * 3;
    for (let i = 0; i < frames; i++) {
        pet.step(FRAME);
        const p = pet.pose;
        for (const l of counted) {
            const k = l.key(p);
            if (k !== keys.get(l.id)) {
                keys.set(l.id, k);
                changes.set(l.id, changes.get(l.id) + 1);
            }
        }
    }
    for (const id of ['disc', 'ring', 'face'])
        assert(changes.get(id) <= 1, `${id} repainted ${changes.get(id)} times`);
    assert(changes.get('eyes') < frames * 0.3, `eyes repainted ${changes.get('eyes')} of ${frames}`);
});

test('the whole scene renders for every mood and state', () => {
    for (const [hours, playing, idleFor] of [[20, true, 0], [2, false, 0], [0.5, false, 30], [0.1, false, SLEEP_AFTER + 5]]) {
        const pet = newPet({hours, playing, idleFor});
        run(pet, 1.5);
        const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, HERO.w, HERO.h);
        const cr = new Cairo.Context(surf);
        cr.translate(-HERO.x0, -HERO.y0);
        compose(cr, pet.pose);
        cr.$dispose();
        const px = pixels(surf);
        equal(px(1, HERO.h - 2)[3], 0, `corner is transparent (${hours} h)`);
        equal(px(-HERO.x0, -HERO.y0 + 20)[3], 255, `the cat is painted (${hours} h)`);
    }
});

test('the panel glyph: ink in the middle, clear corners, plumbob in mood colour', () => {
    for (const [mood, channel] of [[0, 1], [3, 0]]) {
        const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, GLYPH.w, GLYPH.h);
        const cr = new Cairo.Context(surf);
        drawGlyph(cr, [0.91, 0.91, 0.93, 0.7], {open: 1, roll: 0, dy: 0, scale: 1, plumb: 1, color: MOODS[mood].color});
        cr.$dispose();
        const px = pixels(surf);
        equal(px(0, 0)[3], 0, 'top-left corner');
        equal(px(GLYPH.w - 1, 0)[3], 0, 'top-right corner');
        assert(px(GLYPH.w / 2, 23)[3] > 150, 'the cat face is inked');
        const plumb = px(GLYPH.w / 2, 3.3);
        assert(plumb[3] > 200, 'the plumbob is opaque');
        assert(plumb[channel] === Math.max(...plumb.slice(0, 3)), `plumbob colour ${plumb} for mood ${mood}`);
    }
});
