// README media driver, see ../capture.sh. Runs inside an isolated headless
// gnome-shell, feeds the card demo states computed by the real estimator and
// takes screenshots. Needs a connected headset for the card to exist; its own
// readings are replaced by the demo states.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Estimator, formatDuration} from '../headphones-battery@terentiy/estimator.js';
import {SLEEP_AFTER, moodFor} from '../headphones-battery@terentiy/pet.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
const OUT = GLib.getenv('HP_MEDIA_OUT');
const UUID = 'headphones-battery@terentiy';
const MODEL = 'JBL TUNE520BT';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
const log = m => console.log(`[hp-media] ${m}`);
const now = () => GLib.get_monotonic_time() / 1000;
const meta = {};

// The popup is 98.5% opaque: nothing personal (desktop icons, windows) may
// show through. The overview shows the window group again when it hides, so
// hide everything behind right before every shot.
function hideBehind() {
    global.window_group.hide();
    Main.layoutManager._backgroundGroup.hide();
}

async function shot(name, [x, y, w, h]) {
    hideBehind();
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot_area(Math.round(x), Math.round(y), Math.round(w), Math.round(h), stream);
    stream.close(null);
}

function rectOf(actor, pad = 0) {
    const r = actor.get_transformed_extents();
    return [r.origin.x - pad, r.origin.y - pad, r.size.width + 2 * pad, r.size.height + 2 * pad];
}

// The real estimator with its prior (the device has no learned samples yet).
function demo({src, level, playing, volume = 0.87, idleFor = 0, usedPlay = 0}) {
    const e = new Estimator();
    const id = 'demo';
    const u = volume ** 3;
    if (usedPlay) {
        e.attach(id, MODEL, src, level + 1);
        e.observe(id, MODEL, src, level);
        e.account(id, usedPlay, 'play', u);
    } else {
        e.attach(id, MODEL, src, level);
    }
    e.state.devices[id].uAvg = 0.65;
    const est = e.estimate(id, src, {playing, u});
    return {
        est, precise: src === 'le', playing, idleFor: playing ? 0 : idleFor, volume,
        sleeping: !playing && idleFor >= SLEEP_AFTER,
        mood: moodFor(est.hours),
    };
}

const STATES = {
    playing: demo({src: 'le', level: 72, playing: true}),
    low: demo({src: 'le', level: 2, playing: true, usedPlay: 0.6}),
    red: demo({src: 'le', level: 0, playing: false, idleFor: 20, usedPlay: 0.3}),
    dozing: demo({src: 'hfp', level: 20, playing: false, idleFor: SLEEP_AFTER + 400}),
    yellow: demo({src: 'le', level: 4, playing: false, idleFor: 30}),
};

export default class Media extends Extension {
    enable() {
        this._run().catch(e => { log(`FAILED ${e}\n${e.stack}`); global.context.terminate(); });
    }
    disable() {}

    async _run() {
        await sleep(3000);
        Main.overview.hide();
        await sleep(1000);
        hideBehind();
        const ctx = St.ThemeContext.get_for_stage(global.stage);
        await sleep(1500);
        const ind = Main.panel.statusArea[UUID];
        const ext = Main.extensionManager.lookup(UUID);
        const me = ext.stateObj;
        const entries = [...me._audio.values()];
        log(`scale=${ctx.scale_factor} panel h=${Main.panel.height} glyph=${ind.glyph.width}x${ind.glyph.height} ` +
            `entries=${entries.length} error=${ext.error ?? ''}`);
        for (const [k, s] of Object.entries(STATES))
            log(`${k}: ${s.est.level}% soc=${s.est.soc.toFixed(2)} h=${s.est.hours.toFixed(2)} mood=${s.mood} sleeping=${s.sleeping}`);
        const card = entries[0].card;
        log(`hero ${card.hero.width}x${card.hero.height}`);
        me._refresh = () => {};

        const show = s => {
            card.update(s);
            const level = s.precise ? s.est.level : Math.round(s.est.soc);
            ind.pct.set(`${s.precise ? '' : '≈'}${level}%`, 0);
            ind.time.set(`~${formatDuration(s.est.hours, true)}`, 0);
            ind.glyph.set(s);
        };
        const panelRect = () => rectOf(ind, 10);

        // the panel in every mood
        for (const k of ['playing', 'yellow', 'low', 'red', 'dozing']) {
            show(STATES[k]);
            await sleep(2200);
            await shot(`panel_${k}`, panelRect());
        }
        meta.panelBg = Main.panel.get_theme_node().get_background_color().to_string();

        // popup stills, a few moments each to pick from
        for (const k of ['playing', 'low', 'dozing']) {
            show(STATES[k]);
            await sleep(300);
            ind.menu.open();
            await sleep(2400);
            for (let i = 0; i < 6; i++) {
                await shot(`card_${k}_${i}`, rectOf(ind.menu.box));
                await sleep(450);
            }
            meta.card = rectOf(ind.menu.box);
            ind.menu.close();
            await sleep(900);
        }

        // the intro and a poke, as fast as screenshots go
        show(STATES.playing);
        await sleep(1000);
        const frames = [];
        const t0 = now();
        ind.menu.open();
        let poked = false;
        while (now() - t0 < 5200) {
            const t = now() - t0;
            if (!poked && t > 3300) {
                card.hero.vfunc_button_release_event();
                poked = true;
            }
            const name = `gif_${String(frames.length).padStart(4, '0')}`;
            await shot(name, rectOf(ind.menu.box));
            frames.push([name, Math.round(t)]);
        }
        meta.frames = frames;
        log(`gif: ${frames.length} frames in ${Math.round(now() - t0)} ms`);
        ind.menu.close();

        GLib.file_set_contents(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
        log('done');
        await sleep(300);
        global.context.terminate();
    }
}
