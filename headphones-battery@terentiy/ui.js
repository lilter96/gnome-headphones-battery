// Shell widgets for the pet: the animated hero card, the panel glyph and the
// rolling labels. All motion is driven by springs from pet.js.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {
    GLYPH, HERO, MOODS, NEUTRAL_COLOR, PARTICLE_BOX, Pet, SCENE, Spring,
    aimColor, drawGlyph, drawParticle, fromOklch, particleXf, toOklch,
} from './pet.js';
import {presentDevice} from './presentation.js';

export {formatLong, plural} from './presentation.js';

const DEG = 180 / Math.PI;
const now = () => GLib.get_monotonic_time() / 1e6;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const animationsEnabled = () => St.Settings.get().enable_animations;

// Sizes below are in logical pixels; St wants physical ones on HiDPI screens.
const theme = () => St.ThemeContext.get_for_stage(global.stage);

function followScale(actor, callback) {
    const ctx = theme();
    const id = ctx.connect('notify::scale-factor', () => callback(ctx.scale_factor));
    actor.connect('destroy', () => ctx.disconnect(id));
    callback(ctx.scale_factor);
}

// Calls back on every frame of the actor's monitor until stopped or the
// callback returns false.
class FrameLoop {
    constructor(actor, callback) {
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._frameId = this._timeline.connect('new-frame', () => {
            if (!this._timeline)
                return;
            const t = now();
            const dt = clamp(t - this._last, 0, 0.05);
            this._last = t;
            if (callback(dt) === false)
                this.stop();
        });
    }

    start() {
        if (!this._timeline || this._timeline.is_playing())
            return;
        this._last = now();
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
    }

    destroy() {
        this.stop();
        if (this._timeline && this._frameId)
            this._timeline.disconnect(this._frameId);
        this._frameId = 0;
        this._timeline = null;
    }
}

function applyXf(actor, cache, xf, k) {
    const tx = (xf.tx ?? 0) * k, ty = (xf.ty ?? 0) * k;
    const rot = (xf.rot ?? 0) * DEG;
    const sx = xf.sx ?? xf.s ?? 1, sy = xf.sy ?? xf.s ?? 1;
    const op = Math.round(clamp(xf.alpha ?? 1, 0, 1) * 255);
    if (cache.tx !== tx || cache.ty !== ty) {
        actor.set_translation(tx, ty, 0);
        cache.tx = tx;
        cache.ty = ty;
    }
    if (cache.rot !== rot) {
        actor.rotation_angle_z = rot;
        cache.rot = rot;
    }
    if (cache.sx !== sx || cache.sy !== sy) {
        actor.set_scale(sx, sy);
        cache.sx = sx;
        cache.sy = sy;
    }
    if (cache.op !== op) {
        actor.opacity = op;
        actor.visible = op > 0;
        cache.op = op;
    }
}

function paintArea(area, box, k, draw) {
    const cr = area.get_context();
    cr.save();
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.restore();
    cr.scale(k, k);
    cr.translate(-box[0], -box[1]);
    draw(cr);
    cr.$dispose();
}

// The scene from pet.js as a tree of Clutter actors. Each layer is a texture
// that is redrawn only when its key changes; everything else is a transform.
export const HeroView = GObject.registerClass(
class HeroView extends St.Widget {
    _init(pet) {
        super._init({reactive: true, x_align: Clutter.ActorAlign.CENTER});
        this.pet = pet;
        this.onFrame = null;
        this._pose = pet.pose;
        this._layers = [];
        this._particles = new Map();
        this._loop = new FrameLoop(this, dt => this._frame(dt));
        this.connect('destroy', () => this._loop.destroy());
        followScale(this, f => this._rebuild(f));
    }

    // Textures are drawn at the final pixel size, so a new scale means new actors.
    _rebuild(factor) {
        this.destroy_all_children();
        this._layers = [];
        this._particles.clear();
        this._k = HERO.scale * factor;
        this.set_size(HERO.w * this._k, HERO.h * this._k);
        this._build(SCENE, this, HERO.x0, HERO.y0);
        this._sync();
    }

    _build(layers, parent, ox, oy) {
        const k = this._k;
        for (const l of layers) {
            const [bx, by, bw, bh] = l.box;
            const actor = l.draw
                ? new St.DrawingArea({width: bw * k, height: bh * k})
                : new St.Widget({width: bw * k, height: bh * k});
            actor.set_position((bx - ox) * k, (by - oy) * k);
            const [px, py] = l.pivot ?? [bx + bw / 2, by + bh / 2];
            actor.pivot_point = new Graphene.Point({x: (px - bx) / bw, y: (py - by) / bh});
            if (l.draw)
                actor.connect('repaint', area => paintArea(area, l.box, k, cr => l.draw(cr, this._pose)));
            parent.add_child(actor);
            this._layers.push({l, actor, key: undefined, cache: {}});
            if (l.children)
                this._build(l.children, actor, bx, by);
        }
    }

    _sync() {
        const p = this._pose = this.pet.pose;
        for (const r of this._layers) {
            if (r.l.key) {
                const key = r.l.key(p);
                if (key !== r.key) {
                    r.key = key;
                    r.actor.queue_repaint();
                }
            }
            if (r.l.xf)
                applyXf(r.actor, r.cache, r.l.xf(p), this._k);
        }

        const alive = new Set(p.particles);
        for (const [q, actor] of this._particles) {
            if (!alive.has(q)) {
                actor.destroy();
                this._particles.delete(q);
            }
        }
        for (const q of p.particles) {
            let actor = this._particles.get(q);
            if (!actor) {
                const [bx, by, bw, bh] = PARTICLE_BOX;
                const k = this._k;
                actor = new St.DrawingArea({width: bw * k, height: bh * k});
                actor.set_position((bx - HERO.x0) * k, (by - HERO.y0) * k);
                actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
                actor.connect('repaint', area => paintArea(area, PARTICLE_BOX, k, cr => drawParticle(cr, q.kind)));
                actor._cache = {};
                this.add_child(actor);
                this._particles.set(q, actor);
            }
            applyXf(actor, actor._cache, particleXf(q), this._k);
        }
        this.onFrame?.();
    }

    _frame(dt) {
        this.pet.step(dt);
        this._sync();
        return this.pet.moving;
    }

    // The popup opened.
    play() {
        this.pet.reduced = !animationsEnabled();
        this.pet.intro();
        this._sync();
        this._loop.start();
    }

    pause() {
        this._loop.stop();
        this.pet.pointer(null);
    }

    // New readings must update even while reduced motion has stopped the loop.
    refresh() {
        this.pet.reduced = !animationsEnabled();
        if (this.pet.reduced || !this.mapped) {
            this.pet.settle();
            this._sync();
        } else {
            this._loop.start();
        }
    }

    vfunc_motion_event(event) {
        const [x, y] = event.get_coords();
        const [ok, lx, ly] = this.transform_stage_point(x, y);
        if (ok)
            this.pet.pointer([lx / this._k + HERO.x0, ly / this._k + HERO.y0]);
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
        this.pet.pointer(null);
        return super.vfunc_leave_event(event);
    }

    vfunc_button_press_event() {
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        this.pet.poke();
        this._loop.start();
        return Clutter.EVENT_STOP;
    }
});

// The cat head in the panel. It moves only when something changes: it pops in
// when the headphones connect, nods when music starts, dozes off in silence.
export const PanelGlyph = GObject.registerClass(
class PanelGlyph extends St.DrawingArea {
    _init() {
        super._init({y_align: Clutter.ActorAlign.CENTER});
        followScale(this, f => {
            this._k = f;
            this.set_size(GLYPH.w * f, GLYPH.h * f);
        });
        const c = toOklch(MOODS[0].color);
        this._s = {
            scale: new Spring(1, 0.5, 0.55),
            plumb: new Spring(1, 0.6, 0.5),
            roll: new Spring(0, 0.42, 0.3),
            dy: new Spring(0, 0.3, 0.45),
            open: new Spring(1, 0.6),
            L: new Spring(c[0], 0.9),
            C: new Spring(c[1], 0.9),
            h: new Spring(c[2], 0.9),
        };
        this._mood = 0;
        this._playing = false;
        this._sleeping = false;
        this._loop = new FrameLoop(this, dt => this._frame(dt));
        this.connect('destroy', () => this._loop.destroy());
    }

    set({mood, playing = false, sleeping = false, batteryKnown = true,
        estimateKnown = true, est = undefined}) {
        const s = this._s;
        const known = batteryKnown && estimateKnown && est !== null &&
            Number.isInteger(mood) && !!MOODS[mood];
        aimColor([s.L, s.C, s.h], known ? MOODS[mood].color : NEUTRAL_COLOR);
        s.open.tune(sleeping ? 2 : 0.35, sleeping ? 1 : 0.55).to(sleeping ? 0 : 1);
        // Music starts: one nod, about 10° and 1.5 px, then back to calm.
        if (playing && !this._playing) {
            s.roll.kick(-3.4);
            s.dy.kick(40);
        }
        if (known && mood === 3 && this._mood !== 3)
            s.plumb.kick(5);
        this._mood = known ? mood : -1;
        this._playing = playing;
        this._sleeping = sleeping;
        this._kick();
    }

    pop() {
        this._s.scale.snap(0.35);
        this._s.scale.to(1);
        this._s.plumb.snap(-0.5);
        this._s.plumb.to(1);
        this._kick();
    }

    // Off screen (e.g. while the shell starts up) there is nothing to watch:
    // land on the final pose at once instead of freezing half-way.
    _kick() {
        if (!animationsEnabled() || !this.mapped) {
            for (const sp of Object.values(this._s))
                sp.snap(sp.target);
            this.queue_repaint();
            return;
        }
        this._loop.start();
    }

    _frame(dt) {
        const springs = Object.values(this._s);
        springs.forEach(sp => sp.step(dt));
        this.queue_repaint();
        return !springs.every(sp => sp.resting);
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const s = this._s;
        const cr = this.get_context();
        cr.scale(this._k, this._k);
        const fg = this.get_theme_node().get_foreground_color();
        drawGlyph(cr, [fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255], {
            open: s.open.x,
            roll: s.roll.x,
            dy: s.dy.x,
            scale: Math.max(s.scale.x, 0),
            plumb: clamp(s.plumb.x, 0, 1.6),
            color: fromOklch([s.L.x, s.C.x, s.h.x]),
        });
        cr.$dispose();
    }
});

// A label whose text rolls like a counter: down when the value drops, up when
// it grows. Springs, so a new value can interrupt a roll mid-way.
export const RollingLabel = GObject.registerClass(
class RollingLabel extends St.Widget {
    _init(params = {}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
        this._label = this._make('');
        this._in = null;
        this._out = [];
        this._loop = new FrameLoop(this, dt => this._frame(dt));
        this.connect('destroy', () => this._loop.destroy());
    }

    _make(text) {
        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.START});
        this.add_child(label);
        return label;
    }

    get text() {
        return this._label.text;
    }

    // dir: -1 the value went down, 1 it went up, 0 just replace
    set(text, dir = 0) {
        if (text === this._label.text)
            return;
        if (!dir || !this.mapped || !animationsEnabled()) {
            this._settle();
            this._label.text = text;
            return;
        }
        // Bursty D-Bus updates must not leave an unbounded trail of old labels.
        if (this._out.length >= 3)
            this._settle();
        const h = Math.max(this.height, 12) * 0.8;
        const old = this._label;
        this._out.push({
            label: old,
            spring: new Spring(0, 0.3).to(1),
            ty0: old.translation_y,
            op0: old.opacity / 255,
            ty1: -dir * h,
        });
        this._label = this._make(text);
        // the new value follows a beat later and lands with a slight overshoot
        this._in = {spring: new Spring(0, 0.5, 0.72).to(1), from: dir * h, wait: 0.05};
        this._frame(0);
        this._loop.start();
    }

    _frame(dt) {
        this._out = this._out.filter(o => {
            o.spring.step(dt);
            const q = clamp(o.spring.x, 0, 1);
            o.label.translation_y = o.ty0 + (o.ty1 - o.ty0) * q;
            o.label.opacity = Math.round(o.op0 * (1 - q) * 255);
            if (q < 0.98)
                return true;
            o.label.destroy();
            return false;
        });
        const r = this._in;
        if (r) {
            r.wait -= dt;
            if (r.wait < 0)
                r.spring.step(dt);
            const x = r.spring.x;
            this._label.translation_y = r.from * (1 - x);
            this._label.opacity = Math.round(clamp(x * 1.6, 0, 1) * 255);
            if (r.spring.resting)
                this._settle();
        }
        return this._out.length > 0 || this._in !== null;
    }

    _settle() {
        this._out.forEach(o => o.label.destroy());
        this._out = [];
        this._in = null;
        this._label.translation_y = 0;
        this._label.opacity = 255;
    }
});

function makeRow(name) {
    const box = new St.BoxLayout({style_class: 'hp-row'});
    box.add_child(new St.Label({
        text: name,
        style_class: 'hp-row-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    }));
    const right = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END});
    const value = new St.Label({style_class: 'hp-row-value', x_align: Clutter.ActorAlign.END});
    const sub = new St.Label({style_class: 'hp-row-sub', x_align: Clutter.ActorAlign.END});
    sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    right.add_child(value);
    right.add_child(sub);
    box.add_child(right);
    return {box, value, sub};
}

// Popup card for one pair of headphones.
export const DeviceCard = GObject.registerClass(
class DeviceCard extends St.BoxLayout {
    _init(model) {
        super._init({vertical: true, style_class: 'hp-card'});
        this.pet = new Pet({reducedMotion: !animationsEnabled()});
        this.pet.update({batteryKnown: false, hours: null});
        this.pet.settle();
        this.hero = new HeroView(this.pet);
        this.hero.onFrame = () => this._syncPct();
        this._pctValue = null;
        this._pctPrefix = '';
        this._ringGoal = 0;

        const center = Clutter.ActorAlign.CENTER;
        this._pct = new St.Label({style_class: 'hp-pct', x_align: center});
        this._name = new St.Label({style_class: 'hp-name', x_align: center, text: model});
        this._status = new St.Label({style_class: 'hp-status', x_align: center});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._status.clutter_text.line_wrap = true;

        this._group = new St.BoxLayout({vertical: true, style_class: 'hp-group'});
        this._rows = {music: makeRow('Музыка'), quiet: makeRow('Без звука'), rate: makeRow('Расход')};
        Object.values(this._rows).forEach((r, i) => {
            if (i > 0)
                this._group.add_child(new St.Widget({style_class: 'hp-row-sep', x_expand: true}));
            this._group.add_child(r.box);
        });

        // A fixed actor tree avoids recreating/reparenting rows on every tick.
        this._components = new St.BoxLayout({vertical: true, style_class: 'hp-group'});
        this._compRows = {};
        for (const [i, [key, label]] of [['left', 'Левый'], ['right', 'Правый'], ['case', 'Кейс']].entries()) {
            if (i > 0)
                this._components.add_child(new St.Widget({style_class: 'hp-row-sep', x_expand: true}));
            const row = this._compRows[key] = makeRow(label);
            this._components.add_child(row.box);
        }
        this._components.visible = false;

        this._note = new St.Label({style_class: 'hp-note'});
        this._note.clutter_text.line_wrap = true;
        this._note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        for (const a of [this.hero, this._pct, this._name, this._status, this._components, this._group, this._note])
            this.add_child(a);
        this._syncPct();
    }

    // Battery observation is independent of the optional runtime prediction.
    setName(name) {
        this._name.text = typeof name === 'string' ? name : 'Наушники';
    }

    update(info = {}) {
        info ??= {};
        const view = presentDevice(info);
        this._pctPrefix = view.prefix;
        this._pctValue = view.value;
        this._ringGoal = view.ring.precise ? view.ring.level : view.ring.lo;
        this._status.text = view.status;
        this._note.text = view.note;
        this._pct.accessible_name = view.batteryKnown ? `Заряд: ${view.pctText}` : view.status;
        this._components.visible = view.componentsVisible;
        for (const component of view.components) {
            const row = this._compRows[component.key];
            row.value.text = component.value;
            row.sub.text = component.sub;
            if (component.stale)
                row.box.add_style_class_name('hp-row-stale');
            else
                row.box.remove_style_class_name('hp-row-stale');
            row.box.accessible_name = `${component.label}: ${component.value}, ${component.sub}`;
        }
        for (const [key, content] of Object.entries(view.rows)) {
            this._rows[key].value.text = content.value;
            this._rows[key].sub.text = content.sub;
        }
        this.pet.update({
            ...view.ring,
            hours: view.hours,
            playing: !!info.playing,
            volume: Number.isFinite(info.volume) ? clamp(info.volume, 0, 1) : 0,
            idleFor: Number.isFinite(info.idleFor) ? Math.max(info.idleFor, 0) : 0,
        });
        this.hero.refresh();
        this._syncPct();
    }

    _syncPct() {
        if (this._pctValue === null) {
            this._pct.text = '—';
            return;
        }
        // the pet sets its own targets on the next frame, so measure against the estimate
        const goal = this._ringGoal;
        const progress = goal > 0 ? clamp(this.pet.s.ring.x / goal, 0, 1) : 1;
        this._pct.text = `${this._pctPrefix}${Math.round(this._pctValue * progress)}%`;
    }
});
