import { clamp, easeOutBack, easeOutCubic, hashNoise, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import { drawHand, handPenPoint, handWidth, scribbleBox } from './handwriting';

/**
 * The one instruction the game ever gives, written on the paper at the start
 * of a run: DESTROY THE WALL, with a short arrow hooking off it into the
 * masonry.
 *
 * Two things matter about how it is drawn. It is *written* - stroke by stroke
 * in the same hand as the figure and the craters, not set in a font and faded
 * in, because a caption in Trebuchet next to a stick figure reads as a caption
 * bolted on. And it is *pinned to the wall*, not to the screen: the words sit
 * just off the wall's face and the arrow is a short hop from them into the
 * stone, so it stays a note scribbled beside the target on a phone and on an
 * ultrawide alike, instead of a banner with a yard of arrow crossing the room.
 *
 * The moment the first blow lands, the whole thing scribbles itself out again.
 */

/** Seconds spent writing the line out. */
const WRITE = 0.78;
/** When the arrow starts being dragged out, and how long that takes. */
const ARROW_AT = 0.62;
const ARROW_DRAW = 0.46;

const LINE = 'DESTROY THE WALL';

/** The largest cap height the line fits into `maxWidth` at, never above `preferred`. */
export function fitCueSize(maxWidth: number, preferred: number): number {
  const w = handWidth(LINE, preferred);
  return w <= maxWidth ? preferred : Math.max(9, preferred * (maxWidth / w));
}

/** Width of the line at a given cap height, so a caller can place it. */
export function cueWidth(size: number): number {
  return handWidth(LINE, size);
}

export interface CueLayout {
  /** Centre of the line of text. */
  x: number;
  y: number;
  /** Cap height of the text, in world units. */
  size: number;
  /** Where the arrow should end up pointing - the wall's face. */
  target: Vec2;
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
  // Going away, the whole note lifts and shrinks a touch - it is being taken
  // off the paper, not switched off.
  c.translate(l.x, l.y);
  const shrink = 1 - out * 0.1;
  c.scale(shrink, shrink);
  c.translate(-l.x, -l.y - out * 16);

  const write = clamp(t / WRITE, 0, 1);
  drawHand(sk, LINE, l.x, l.y, l.size, {
    progress: write,
    alpha: fade,
    wobble: 1.15,
    weight: Math.max(2.4, l.size * 0.125),
  });
  // A scrub of pencil riding along at the nib while the line is still being
  // written. It is what makes the letters look worked at rather than revealed.
  if (write < 1 && out < 0.2) {
    const nib = handPenPoint(LINE, l.x, l.y, l.size, write);
    scribbleBox(sk, nib.x, nib.y, l.size * 0.7, l.size * 0.85, 3, fade * 0.55);
  }

  drawArrow(sk, t, fade, out, l);
  c.restore();
}

/**
 * The arrow: a short hook out from under the last word, bowing right and down
 * into the wall's face. Thin where it leaves the words and heavy where it
 * arrives, because it is a brush mark, not a line with a triangle on it.
 *
 * It is built as an outline and filled rather than stroked, since a stroke has
 * one width and the whole point of this shape is that it does not.
 */
function drawArrow(sk: Sketch, t: number, fade: number, out: number, l: CueLayout): void {
  const draw = clamp((t - ARROW_AT) / ARROW_DRAW, 0, 1);
  if (draw <= 0) return;
  const c = sk.ctx;

  const half = cueWidth(l.size) / 2;
  // It leaves from under the tail of the line, not from its middle: that is
  // the corner nearest the wall, and it keeps the hop short.
  const p0: Vec2 = { x: l.x + half * 0.52, y: l.y + l.size * 0.78 };
  const p3 = l.target;
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  // Down out of the words, then over to the right so the last stretch runs
  // flat into the stone. The pulled-out handles are what bow it.
  const c1: Vec2 = { x: p0.x - dx * 0.08, y: p0.y + dy * 0.72 + l.size * 0.5 };
  const c2: Vec2 = { x: p0.x + dx * 0.4, y: p3.y + Math.abs(dy) * 0.2 + l.size * 0.35 };

  const at = (u: number): Vec2 => {
    const m = 1 - u;
    return {
      x: m * m * m * p0.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * p3.x,
      y: m * m * m * p0.y + 3 * m * m * u * c1.y + 3 * m * u * u * c2.y + u * u * u * p3.y,
    };
  };

  // Nearly all the way: the head then sits over the shaft's last inch rather
  // than floating off the end of it.
  const headroom = 0.96;
  const end = easeOutCubic(draw) * headroom;
  const thin = Math.max(1.4, l.size * 0.05);
  const thick = l.size * 0.4;
  const steps = 22;

  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * end;
    const q = at(u);
    const n = at(Math.min(1, u + 0.01));
    const tx = n.x - q.x, ty = n.y - q.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    // Width follows how far along the *whole* curve this point is, so the
    // stroke keeps swelling as the arrow grows rather than re-tapering.
    const w = (thin + (thick - thin) * (u / headroom) ** 1.5) * 0.5;
    left.push({ x: q.x + nx * w, y: q.y + ny * w });
    right.push({ x: q.x - nx * w, y: q.y - ny * w });
  }

  c.save();
  c.globalAlpha = fade;
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  // Filled, then run round once with a thin line: a brush mark gone over at
  // the edges, which is how everything else here is inked.
  sk.polyPath([...left, ...[...right].reverse()], l.size * 0.045);
  c.fill();
  c.lineWidth = Math.max(1.2, l.size * 0.035);
  c.globalAlpha = fade * 0.65;
  sk.polyPath([...left, ...[...right].reverse()], l.size * 0.075);
  c.stroke();

  // The head, which lands with a thump once the shaft has arrived.
  const headK = clamp((draw - 0.7) / 0.3, 0, 1);
  if (headK > 0) {
    const tip = at(1);
    const back = at(0.88);
    const ax = tip.x - back.x, ay = tip.y - back.y;
    const len = Math.hypot(ax, ay) || 1;
    const ux = ax / len, uy = ay / len;
    const nx = -uy, ny = ux;
    const s = thick * 1.45 * easeOutBack(headK);
    c.globalAlpha = fade;
    sk.poly([
      { x: tip.x + ux * s * 0.5, y: tip.y + uy * s * 0.5 },
      { x: tip.x - ux * s * 0.95 + nx * s * 0.8, y: tip.y - uy * s * 0.95 + ny * s * 0.8 },
      { x: tip.x - ux * s * 0.55, y: tip.y - uy * s * 0.55 },
      { x: tip.x - ux * s * 0.95 - nx * s * 0.8, y: tip.y - uy * s * 0.95 - ny * s * 0.8 },
    ], Math.max(1.4, l.size * 0.05), true, l.size * 0.05);

    // A couple of ticks off the point, so it reads as jabbing at the wall
    // rather than resting against it.
    if (out < 0.5) {
      const beat = 0.5 + Math.sin(t * 9) * 0.5;
      c.globalAlpha = fade * (0.25 + beat * 0.55);
      const w = Math.max(1.6, l.size * 0.06);
      sk.burst(tip.x, tip.y, 5, s * 1.15, s * (1.8 + beat * 0.6), w, 1.7,
        Math.atan2(uy, ux), 4242 + Math.round(hashNoise(1, sk.boil) * 3));
    }
  }
  c.restore();
}
