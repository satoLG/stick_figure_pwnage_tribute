import { clamp, easeOutBack, easeOutCubic, hashNoise, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import { inkText, measureText } from './ui';

/**
 * The one instruction the game ever gives, written on the paper at the start
 * of a run: DESTROY THE WALL, with an arrow drawn under it curving over to the
 * masonry.
 *
 * It is animated rather than simply placed, because a title that is already
 * there when the run begins reads as furniture and gets skipped. Watching the
 * words being scribbled on and the arrow being dragged out towards the wall
 * takes about a second and a half and cannot be ignored, which is the whole
 * job: nobody should have to be told twice, and nobody is - the moment the
 * first blow lands on the wall the cue scribbles itself out again.
 */

/** Seconds spent writing the line out, letter by letter. */
const WRITE = 0.66;
/** When the arrow starts being dragged out, and how long that takes. */
const ARROW_AT = 0.44;
const ARROW_DRAW = 0.62;

export interface CueLayout {
  /** Centre of the line of text. */
  x: number;
  y: number;
  /** Cap height of the text, in world units. */
  size: number;
  /** Where the arrow should end up pointing - the wall's face. */
  target: Vec2;
}

const LINE = 'DESTROY THE WALL';

/**
 * The largest cap height the line fits into `maxWidth` at, never bigger than
 * `preferred`. The cue has to live in the open ground to the left of the wall,
 * which on a narrow phone is not very much ground at all.
 */
export function fitCueSize(sk: Sketch, maxWidth: number, preferred: number): number {
  const w = measureText(sk, LINE, preferred);
  return w <= maxWidth ? preferred : Math.max(11, preferred * (maxWidth / w));
}

/**
 * `t` is seconds since the run started, `out` is 0..1 through the wipe that
 * follows the first hit on the wall. At `out >= 1` there is nothing left to
 * draw and the caller can stop asking.
 */
export function drawStartCue(sk: Sketch, t: number, out: number, l: CueLayout): void {
  if (out >= 1) return;
  const c = sk.ctx;
  const fade = 1 - easeOutCubic(clamp(out, 0, 1));

  c.save();
  // Going away, the whole cue lifts and shrinks a touch - it is being taken
  // off the paper, not switched off.
  c.translate(l.x, l.y);
  const shrink = 1 - out * 0.12;
  c.scale(shrink, shrink);
  c.translate(-l.x, -l.y + out * -18);

  writeLine(sk, t, fade, l);
  drawArrow(sk, t, fade, out, l);
  c.restore();
}

/** The line itself, one letter arriving at a time under a scrub of pencil. */
function writeLine(sk: Sketch, t: number, fade: number, l: CueLayout): void {
  const c = sk.ctx;
  const n = LINE.length;
  const per = WRITE / n;
  // Laid out from the measured width of the whole string, so the letters land
  // exactly where a centred draw of it would have put them.
  const total = measureText(sk, LINE, l.size);
  let x = l.x - total / 2;

  for (let i = 0; i < n; i++) {
    const ch = LINE[i];
    const cw = measureText(sk, ch, l.size);
    if (ch !== ' ') {
      // Each letter has its own little life: it lands, overshoots, settles.
      const k = clamp((t - i * per) / (per * 2.1), 0, 1);
      if (k > 0) {
        const pop = easeOutBack(k);
        const wobble = (1 - k) * 5;
        c.save();
        c.globalAlpha = fade;
        c.translate(x + cw / 2, l.y);
        c.scale(0.6 + pop * 0.4, 0.6 + pop * 0.4);
        c.rotate((1 - k) * hashNoise(i, 3) * 0.5);
        inkText(sk, ch, 0, 0, l.size, { alpha: fade * clamp(k * 1.8, 0, 1), wobble: 0.8 + wobble });
        c.restore();
        // Pencil scrubbed across the letter while it is still arriving. It is
        // gone by the time the letter has settled, so what is left is clean.
        if (k < 1) scribble(sk, x + cw / 2, l.y, cw * 0.8, l.size * 0.9, i, fade * (1 - k) * 0.9);
      }
    }
    x += cw;
  }
}

/** A few fast zigzag strokes through a box - the sound of a pencil, drawn. */
function scribble(sk: Sketch, cx: number, cy: number, w: number, h: number, seed: number, alpha: number): void {
  if (alpha <= 0.01) return;
  const c = sk.ctx;
  c.save();
  c.globalAlpha = alpha;
  c.strokeStyle = '#000';
  c.lineWidth = 2.2;
  c.beginPath();
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const y = cy - h / 2 + (i / rows) * h + hashNoise(seed * 7 + i, sk.boil) * 3;
    const left = cx - w / 2 + hashNoise(seed + i, sk.boil + 2) * 4;
    const right = cx + w / 2 + hashNoise(seed + i * 3, sk.boil + 5) * 4;
    if (i === 0) c.moveTo(left, y);
    else if (i % 2 === 1) c.lineTo(right, y);
    else c.lineTo(left, y);
  }
  c.stroke();
  c.restore();
}

/**
 * The arrow: out from under the text, dropping away and then sweeping right
 * into the wall, thin where it leaves the words and heavy where it arrives.
 *
 * It is drawn as an outline rather than stroked, because a stroke has one
 * width and the whole point of this shape is that it does not - it is a brush
 * mark that starts as a hair and ends as a wedge.
 */
function drawArrow(sk: Sketch, t: number, fade: number, out: number, l: CueLayout): void {
  const draw = clamp((t - ARROW_AT) / ARROW_DRAW, 0, 1);
  if (draw <= 0) return;
  const c = sk.ctx;

  const p0: Vec2 = { x: l.x - l.size * 0.15, y: l.y + l.size * 0.72 };
  const p3 = l.target;
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  // Straight down out of the text, then bending over to the right so the last
  // stretch runs flat into the wall. Both handles are pulled well out, which
  // is what gives it the lazy hand-drawn bow instead of a diagonal.
  const c1: Vec2 = { x: p0.x - dx * 0.06, y: p0.y + dy * 0.66 + 40 };
  const c2: Vec2 = { x: p0.x + dx * 0.42, y: p3.y + Math.abs(dy) * 0.16 + 30 };

  const at = (u: number): Vec2 => {
    const m = 1 - u;
    return {
      x: m * m * m * p0.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * p3.x,
      y: m * m * m * p0.y + 3 * m * m * u * c1.y + 3 * m * u * u * c2.y + u * u * u * p3.y,
    };
  };

  // The tail is a hair and the head is a wedge; the shaft stops short of the
  // tip so the arrowhead is the thing that actually touches the wall.
  const grown = easeOutCubic(draw);
  // Nearly all the way: the head then sits over the shaft's last inch rather
  // than floating off the end of it.
  const headroom = 0.96;
  const end = grown * headroom;
  const thin = 1.6;
  const thick = l.size * 0.36;
  const steps = 26;

  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * end;
    const p = at(u);
    const q = at(Math.min(1, u + 0.01));
    const tx = q.x - p.x, ty = q.y - p.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    // Width follows how far along the *whole* curve this point is, so the
    // stroke keeps swelling as the arrow grows rather than re-tapering.
    const w = (thin + (thick - thin) * (u / headroom) ** 1.5) * 0.5;
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  }

  c.save();
  c.globalAlpha = fade;
  c.fillStyle = '#000';
  sk.polyPath([...left, ...right.reverse()], 1.3);
  c.fill();

  // The head, which lands with a thump once the shaft has arrived.
  const headK = clamp((draw - 0.72) / 0.28, 0, 1);
  if (headK > 0) {
    const tip = at(1);
    const back = at(0.9);
    const ax = tip.x - back.x, ay = tip.y - back.y;
    const len = Math.hypot(ax, ay) || 1;
    const ux = ax / len, uy = ay / len;
    const nx = -uy, ny = ux;
    const s = thick * 1.5 * easeOutBack(headK);
    sk.poly([
      { x: tip.x + ux * s * 0.5, y: tip.y + uy * s * 0.5 },
      { x: tip.x - ux * s * 0.95 + nx * s * 0.78, y: tip.y - uy * s * 0.95 + ny * s * 0.78 },
      { x: tip.x - ux * s * 0.55, y: tip.y - uy * s * 0.55 },
      { x: tip.x - ux * s * 0.95 - nx * s * 0.78, y: tip.y - uy * s * 0.95 - ny * s * 0.78 },
    ], 2, true, 1.4);

    // A couple of impact ticks off the point, so it reads as jabbing at the
    // wall rather than resting against it.
    if (out < 0.5) {
      const beat = 0.5 + Math.sin(t * 9) * 0.5;
      c.globalAlpha = fade * (0.25 + beat * 0.55);
      c.strokeStyle = '#000';
      c.lineWidth = 2.6;
      sk.burst(tip.x, tip.y, 5, s * 1.2, s * (1.9 + beat * 0.7), 2.6, 1.7, Math.atan2(uy, ux), 4242);
    }
  }
  c.restore();
}
