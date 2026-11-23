// Runs actual pet animation and Cairo rendering without a GNOME Shell session.
import Cairo from 'cairo';
import {HERO, MOODS, NEUTRAL_COLOR, Pet, compose, moodFor} from '../pet.js';

let checks = 0;
function check(condition, message) {
    checks++;
    if (!condition)
        throw new Error(message);
}
function colorClose(actual, expected) {
    return actual.every((value, i) => Math.abs(value - expected[i]) < 0.0001);
}
function finitePose(pet) {
    return Object.values(pet.s).every(s => Number.isFinite(s.x) && Number.isFinite(s.target));
}
function render(pet) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, HERO.w, HERO.h);
    const cr = new Cairo.Context(surface);
    cr.translate(-HERO.x0, -HERO.y0);
    compose(cr, pet.pose);
    cr.$dispose();
}

const pet = new Pet({random: () => 0.5, reducedMotion: true});
pet.update({level: 57, lo: 57, hi: 58, precise: true, hours: 2.5,
    batteryKnown: true, playing: true, volume: 0.5, idleFor: 0});
pet.settle();
check(pet.mood === 1, 'known forecast retains its normal mood');
check(Math.abs(pet.pose.ring - 57) < 0.0001, 'known measurement drives ring');
check(colorClose(pet.color, MOODS[1].color), 'known forecast retains mood color');
render(pet);

pet.update({hours: null});
pet.settle();
check(pet.mood === 0, 'missing forecast must not make cat exhausted');
check(colorClose(pet.color, NEUTRAL_COLOR), 'missing forecast has neutral color');
check(Math.abs(pet.pose.ring - 57) < 0.0001, 'real percentage does not require a runtime forecast');
render(pet);

pet.update({batteryKnown: false, hours: null, playing: true});
pet.settle();
check(pet.pose.ring === 0 && pet.pose.ringHi === 0, 'unknown/stale battery has no active charge ring');
check(colorClose(pet.color, NEUTRAL_COLOR), 'unknown battery has neutral color');
check(pet.state.playing, 'unknown battery retains audio activity');
check(finitePose(pet), 'unknown data cannot poison spring values');
render(pet);

pet.update({level: 0, lo: 0, hi: 0, precise: true, hours: 0, batteryKnown: true});
pet.settle();
check(pet.mood === 3, 'actual zero runtime is exhausted, unlike missing data');
check(colorClose(pet.color, MOODS[3].color), 'real empty battery retains warning color');
render(pet);

pet.reduced = false;
pet.update({batteryKnown: false, hours: null, playing: false, idleFor: 240});
for (let i = 0; i < 150; i++)
    pet.step(0.02);
check(pet.sleeping, 'unknown battery preserves sleep behavior');
check(finitePose(pet), 'animated unavailable state remains finite');
render(pet);

for (const missing of [null, undefined, NaN, Infinity, -1])
    check(moodFor(missing) === 0, 'invalid forecast has a safe fallback');

print(`Pet/Cairo: ${checks} checks passed; five real Cairo frames rendered in memory.`);
