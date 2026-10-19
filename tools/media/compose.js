// Turns the raw screenshots from capture.sh into README media:
// rounded corners, a soft shadow, transparent background.
//
//   gjs -m tools/media/compose.js <screenshots dir> <docs/media dir>
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [src, dst] = ARGV.map(p => GLib.canonicalize_filename(p, null));
// The cat is random, so every capture differs: pick the nicest moment by eye.
const PICK = {playing: 5, low: 0, dozing: 3};
const R_CARD = 52;      // .hp-menu radius at 2x
const R_PANEL = 20;
const decoder = new TextDecoder();
const meta = JSON.parse(decoder.decode(GLib.file_get_contents(`${src}/meta.json`)[1]));

const load = name => Cairo.ImageSurface.createFromPNG(`${src}/${name}.png`);

// The card is not fully opaque. Its side margins hold nothing but background,
// so any pattern there is something from the desktop showing through.
function assertPlain(name) {
    const pb = GdkPixbuf.Pixbuf.new_from_file(`${src}/${name}.png`);
    const px = pb.get_pixels(), stride = pb.get_rowstride(), n = pb.get_n_channels();
    const w = pb.get_width();
    const ref = px.slice(40 * stride + 16 * n, 40 * stride + 16 * n + 3);
    for (let y = 40; y < 600; y++) {
        for (const [x0, x1] of [[16, 140], [w - 140, w - 16]]) {
            for (let x = x0; x < x1; x++) {
                const i = y * stride + x * n;
                if (Math.max(...[0, 1, 2].map(c => Math.abs(px[i + c] - ref[c]))) > 1)
                    throw new Error(`${name}: something shows through at ${x},${y}`);
            }
        }
    }
}

function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A cheap soft shadow: stacked translucent rounded rects.
function shadow(cr, x, y, w, h, r, spread, alpha) {
    for (let i = spread; i > 0; i--) {
        roundRect(cr, x - i, y - i + spread * 0.45, w + 2 * i, h + 2 * i, r + i);
        cr.setSourceRGBA(0, 0, 0, alpha * (1 - i / spread) ** 2 / spread * 3);
        cr.fill();
    }
}

function paste(cr, surf, x, y, w, h, r, scale = 1) {
    cr.save();
    roundRect(cr, x, y, w * scale, h * scale, r * scale);
    cr.clip();
    cr.translate(x, y);
    cr.scale(scale, scale);
    cr.setSourceSurface(surf, 0, 0);
    cr.getSource().setFilter(Cairo.Filter.BEST);
    cr.paint();
    cr.restore();
}

function canvas(w, h, draw, path) {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(w), Math.ceil(h));
    const cr = new Cairo.Context(surf);
    draw(cr);
    cr.$dispose();
    surf.writeToPNG(path);
}

GLib.mkdir_with_parents(dst, 0o755);

// Three moods side by side, top-aligned.
{
    const s = 0.75, pad = 44, gap = 40;
    const names = ['playing', 'low', 'dozing'].map(k => `card_${k}_${PICK[k]}`);
    names.forEach(assertPlain);
    const cards = names.map(load);
    const w = cards[0].getWidth();
    const h = Math.max(...cards.map(c => c.getHeight()));
    canvas(2 * pad + 3 * w * s + 2 * gap, 2 * pad + h * s, cr => {
        cards.forEach((c, i) => {
            const x = pad + i * (w * s + gap);
            shadow(cr, x, pad, w * s, c.getHeight() * s, R_CARD * s, 26, 0.55);
            paste(cr, c, x, pad, w, c.getHeight(), R_CARD, s);
        });
    }, `${dst}/cards.png`);
}

// The panel item in every mood.
{
    const pad = 24, gap = 22;
    const shots = ['playing', 'yellow', 'low', 'red', 'dozing'].map(k => load(`panel_${k}`));
    const h = shots[0].getHeight();
    const total = shots.reduce((sum, p) => sum + p.getWidth(), 0);
    canvas(2 * pad + total + (shots.length - 1) * gap, 2 * pad + h, cr => {
        let x = pad;
        for (const p of shots) {
            shadow(cr, x, pad, p.getWidth(), h, R_PANEL, 12, 0.16);
            paste(cr, p, x, pad, p.getWidth(), h, R_PANEL);
            x += p.getWidth() + gap;
        }
    }, `${dst}/panel.png`);
}

// Frames of the popup opening; the first one predates the layout. Screenshots
// come at uneven times, so lay them on an even 30 fps grid (seq_NNNN.png),
// repeating a frame where the capture fell behind, then hold the last one.
{
    const s = 0.6, fps = 30, hold = 1.5;
    const frames = meta.frames.slice(1);
    const first = load(frames[0][0]);
    const w = first.getWidth(), h = first.getHeight();
    GLib.mkdir_with_parents(`${src}/frames`, 0o755);
    for (const [name] of frames) {
        assertPlain(name);
        const surf = load(name);
        if (surf.getWidth() !== w || surf.getHeight() !== h)
            throw new Error(`${name} is ${surf.getWidth()}×${surf.getHeight()}, expected ${w}×${h}`);
        canvas(w * s, h * s, cr => paste(cr, surf, 0, 0, w, h, R_CARD, s), `${src}/frames/${name}.png`);
    }
    const t0 = frames[0][1], end = frames.at(-1)[1] + hold * 1000;
    let k = 0, n = 0;
    for (let t = t0; t <= end; t += 1000 / fps, n++) {
        while (k + 1 < frames.length && frames[k + 1][1] <= t)
            k++;
        Gio.File.new_for_path(`${src}/frames/seq_${String(n).padStart(4, '0')}.png`)
            .make_symbolic_link(`${frames[k][0]}.png`, null);
    }
    print(`${frames.length} frames → ${n} at ${fps} fps`);
}

System.exit(0);
