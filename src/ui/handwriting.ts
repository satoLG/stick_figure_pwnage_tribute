import { hashNoise, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';

/**
 * Letters drawn as strokes, not typeset.
 *
 * Everything else on this paper is a line somebody drew - the figure, the
 * craters, the impact fans, the buttons - and every one of them wobbles,
 * because the wobble is what says a hand made it. Text set in a font does not
 * wobble. It can be jittered around, which is what `inkText` does and which is
 * fine for a readout, but a *caption* set in Trebuchet next to a hand-drawn
 * stick figure reads as a caption bolted on afterwards.
 *
 * So the alphabet here is capital letters written out as polylines in a unit
 * box, put through the same boil as every other stroke in the game, and drawn
 * along their own length so they can be watched being written.
 */

interface Glyph {
  /** Advance width, as a multiple of the cap height. */
  w: number;
  /** Pen strokes, in a box where x runs right from 0 and y runs down 0..1. */
  strokes: readonly (readonly Vec2[])[];
}

const p = (...xy: number[]): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push({ x: xy[i], y: xy[i + 1] });
  return out;
};

/**
 * Written the way a hand writes them: down-strokes first, cross-strokes after,
 * bowls as one sweep rather than two arcs meeting. The little irregularities
 * are deliberate - an E whose bars are all exactly the same length is a font
 * again.
 */
const FONT: Record<string, Glyph> = {
  A: { w: 0.72, strokes: [p(0.02, 1, 0.36, 0.02, 0.71, 1), p(0.13, 0.63, 0.59, 0.61)] },
  B: {
    w: 0.66,
    strokes: [
      p(0.03, 0.01, 0, 1),
      p(0.02, 0.02, 0.46, 0.05, 0.6, 0.22, 0.48, 0.46, 0.01, 0.5),
      p(0.01, 0.5, 0.54, 0.55, 0.66, 0.76, 0.5, 0.97, 0, 1),
    ],
  },
  C: { w: 0.68, strokes: [p(0.66, 0.16, 0.48, 0.02, 0.2, 0.04, 0.04, 0.26, 0.02, 0.72, 0.2, 0.96, 0.5, 0.98, 0.68, 0.85)] },
  D: { w: 0.68, strokes: [p(0.03, 0.01, 0, 1), p(0.02, 0.02, 0.4, 0.04, 0.64, 0.26, 0.66, 0.72, 0.42, 0.96, 0, 1)] },
  E: { w: 0.6, strokes: [p(0.04, 0.01, 0, 1), p(0.02, 0.03, 0.57, 0), p(0.02, 0.5, 0.46, 0.48), p(0, 0.99, 0.59, 0.97)] },
  F: { w: 0.56, strokes: [p(0.04, 0.01, 0, 1), p(0.02, 0.03, 0.54, 0), p(0.02, 0.49, 0.44, 0.47)] },
  G: {
    w: 0.72,
    strokes: [p(0.68, 0.16, 0.5, 0.02, 0.22, 0.04, 0.04, 0.26, 0.02, 0.72, 0.2, 0.96, 0.52, 0.96, 0.7, 0.78, 0.7, 0.56, 0.42, 0.55)],
  },
  H: { w: 0.68, strokes: [p(0.03, 0.01, 0, 1), p(0.66, 0.02, 0.68, 1), p(0.01, 0.5, 0.67, 0.47)] },
  I: { w: 0.26, strokes: [p(0.14, 0.01, 0.11, 1), p(0.01, 0.03, 0.26, 0), p(0, 0.99, 0.25, 0.97)] },
  J: { w: 0.52, strokes: [p(0.48, 0.02, 0.45, 0.75, 0.31, 0.96, 0.1, 0.94, 0, 0.75)] },
  K: { w: 0.64, strokes: [p(0.03, 0.01, 0, 1), p(0.62, 0.02, 0.02, 0.57), p(0.23, 0.42, 0.64, 1)] },
  L: { w: 0.54, strokes: [p(0.04, 0.01, 0, 1, 0.54, 0.97)] },
  M: { w: 0.88, strokes: [p(0, 1, 0.07, 0.02, 0.44, 0.63, 0.81, 0.02, 0.88, 1)] },
  N: { w: 0.72, strokes: [p(0, 1, 0.05, 0.02, 0.68, 1, 0.72, 0.02)] },
  O: { w: 0.74, strokes: [p(0.37, 0.02, 0.11, 0.15, 0.02, 0.5, 0.1, 0.86, 0.37, 0.99, 0.64, 0.86, 0.73, 0.5, 0.64, 0.14, 0.37, 0.02)] },
  P: { w: 0.62, strokes: [p(0.03, 0.01, 0, 1), p(0.02, 0.02, 0.44, 0.05, 0.6, 0.22, 0.49, 0.45, 0.01, 0.51)] },
  Q: {
    w: 0.76,
    strokes: [
      p(0.37, 0.02, 0.11, 0.15, 0.02, 0.5, 0.1, 0.86, 0.37, 0.99, 0.64, 0.86, 0.73, 0.5, 0.64, 0.14, 0.37, 0.02),
      p(0.46, 0.7, 0.76, 1.08),
    ],
  },
  R: {
    w: 0.66,
    strokes: [p(0.03, 0.01, 0, 1), p(0.02, 0.02, 0.44, 0.05, 0.6, 0.22, 0.49, 0.45, 0.01, 0.51), p(0.27, 0.51, 0.66, 1)],
  },
  S: { w: 0.62, strokes: [p(0.6, 0.15, 0.42, 0.02, 0.16, 0.05, 0.04, 0.21, 0.13, 0.41, 0.47, 0.57, 0.58, 0.75, 0.45, 0.95, 0.15, 0.96, 0.02, 0.84)] },
  T: { w: 0.62, strokes: [p(0.01, 0.04, 0.62, 0), p(0.33, 0.02, 0.3, 1)] },
  U: { w: 0.7, strokes: [p(0.03, 0.02, 0, 0.71, 0.14, 0.94, 0.44, 0.99, 0.66, 0.82, 0.69, 0.01)] },
  V: { w: 0.7, strokes: [p(0.01, 0.02, 0.35, 1, 0.7, 0.01)] },
  W: { w: 0.98, strokes: [p(0, 0.01, 0.21, 1, 0.49, 0.25, 0.76, 1, 0.98, 0.02)] },
  X: { w: 0.66, strokes: [p(0.01, 0.02, 0.66, 1), p(0.64, 0.01, 0.02, 0.98)] },
  Y: { w: 0.66, strokes: [p(0.01, 0.02, 0.34, 0.52, 0.66, 0.01), p(0.34, 0.5, 0.32, 1)] },
  Z: { w: 0.64, strokes: [p(0.01, 0.03, 0.62, 0, 0.02, 0.98, 0.64, 0.95)] },
  '!': { w: 0.24, strokes: [p(0.12, 0.02, 0.1, 0.68), p(0.1, 0.88, 0.11, 1)] },
  '?': { w: 0.58, strokes: [p(0.04, 0.2, 0.2, 0.02, 0.44, 0.05, 0.54, 0.22, 0.4, 0.42, 0.28, 0.55, 0.28, 0.68), p(0.28, 0.88, 0.29, 1)] },
};

/** Blank width, and the air left between two letters. */
const SPACE = 0.34;
const TRACK = 0.11;

/** How long a stroke segment may get before it is split, in cap heights. */
const SEG = 0.17;

/** Width of `text` at cap height `size`, in world units. */
export function handWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text.toUpperCase()) {
    w += (ch === ' ' ? SPACE : (FONT[ch]?.w ?? SPACE)) + TRACK;
  }
  return Math.max(0, w - TRACK) * size;
}

export interface HandOpts {
  /** 0..1 along the pen's whole journey. 1 draws the finished line. */
  progress?: number;
  align?: 'left' | 'center' | 'right';
  alpha?: number;
  color?: string;
  /** Stroke width in world units; scales with the size if left out. */
  weight?: number;
  /** How much the ink wanders. 1 is the house wobble. */
  wobble?: number;
}

/**
 * Writes `text` with `y` at the middle of the cap height.
 *
 * With `progress` under 1 the line is drawn only as far as the pen has got,
 * which is measured in actual ink length rather than in letters - so a W takes
 * longer to arrive than an I, exactly as it would if somebody were writing it.
 */
export function drawHand(sk: Sketch, text: string, x: number, y: number, size: number, opts: HandOpts = {}): void {
  const c = sk.ctx;
  const upper = text.toUpperCase();
  const total = handWidth(upper, size);
  const align = opts.align ?? 'center';
  const left = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const top = y - size / 2;

  // Lay the whole line out in world coordinates first, so the pen's budget can
  // be spent across letters rather than per letter.
  const strokes: Vec2[][] = [];
  let pen = left;
  for (const ch of upper) {
    const g = FONT[ch];
    if (g) {
      for (const s of g.strokes) {
        strokes.push(resample(s.map((q) => ({ x: pen + q.x * size, y: top + q.y * size })), SEG * size));
      }
    }
    pen += ((ch === ' ' ? SPACE : (g?.w ?? SPACE)) + TRACK) * size;
  }

  const prog = opts.progress ?? 1;
  let budget = Infinity;
  if (prog < 1) {
    let ink = 0;
    for (const s of strokes) ink += polyLength(s);
    budget = ink * Math.max(0, prog);
  }

  const weight = opts.weight ?? Math.max(2, size * 0.115);
  const wobble = opts.wobble ?? 1;
  c.save();
  c.strokeStyle = opts.color ?? '#000';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const s of strokes) {
    if (budget <= 0) break;
    const drawn = budget === Infinity ? s : cut(s, budget);
    if (budget !== Infinity) budget -= polyLength(s);
    if (drawn.length < 2) continue;
    // Twice over, the way a pencil line gets gone back across: the second pass
    // lands on its own noise, so the two never quite agree and the edge frays.
    c.globalAlpha = opts.alpha ?? 1;
    c.lineWidth = weight;
    sk.polyPath(drawn, wobble, false);
    c.stroke();
    c.globalAlpha = (opts.alpha ?? 1) * 0.5;
    c.lineWidth = weight * 0.8;
    sk.polyPath(drawn, wobble * 1.5, false);
    c.stroke();
  }
  c.restore();
}

/**
 * Where the pen is at `progress`, so something can be dropped at the end of a
 * half-written line - a cursor, a scribble, the start of an arrow.
 */
export function handPenPoint(text: string, x: number, y: number, size: number, progress: number, align: HandOpts['align'] = 'center'): Vec2 {
  const upper = text.toUpperCase();
  const total = handWidth(upper, size);
  const left = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const top = y - size / 2;
  const strokes: Vec2[][] = [];
  let pen = left;
  for (const ch of upper) {
    const g = FONT[ch];
    if (g) for (const s of g.strokes) strokes.push(s.map((q) => ({ x: pen + q.x * size, y: top + q.y * size })));
    pen += ((ch === ' ' ? SPACE : (g?.w ?? SPACE)) + TRACK) * size;
  }
  let ink = 0;
  for (const s of strokes) ink += polyLength(s);
  let budget = ink * Math.max(0, Math.min(1, progress));
  let last: Vec2 = { x: left, y };
  for (const s of strokes) {
    const len = polyLength(s);
    if (budget <= len) return cut(s, budget).pop() ?? last;
    budget -= len;
    last = s[s.length - 1];
  }
  return last;
}

// ------------------------------------------------------------ polylines ---

function polyLength(pts: readonly Vec2[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

/**
 * Splits long segments up.
 *
 * The boil perturbs points, so a stroke drawn as two points stays dead
 * straight however much noise is on it - which is precisely the look this is
 * here to avoid. Chopping every stroke into short pieces first is what lets
 * the wobble get into the middle of a letter's downstroke.
 */
function resample(pts: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) });
  }
  return out;
}

/** The first `len` world units of a polyline. */
function cut(pts: readonly Vec2[], len: number): Vec2[] {
  if (len <= 0) return [];
  const out: Vec2[] = [pts[0]];
  let left = len;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d >= left) {
      const t = d > 0 ? left / d : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return out;
    }
    out.push(b);
    left -= d;
  }
  return out;
}

/**
 * A short scrub of pencil through a box - what a hand does over a letter it is
 * still deciding on, and what this game's ink sounds like.
 */
export function scribbleBox(sk: Sketch, cx: number, cy: number, w: number, h: number, seed: number, alpha: number): void {
  if (alpha <= 0.01) return;
  const c = sk.ctx;
  c.save();
  c.globalAlpha = alpha;
  c.strokeStyle = '#000';
  c.lineWidth = Math.max(1.6, h * 0.06);
  c.beginPath();
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const y = cy - h / 2 + (i / rows) * h + hashNoise(seed * 7 + i, sk.boil) * h * 0.09;
    const l = cx - w / 2 + hashNoise(seed + i, sk.boil + 2) * w * 0.14;
    const r = cx + w / 2 + hashNoise(seed + i * 3, sk.boil + 5) * w * 0.14;
    if (i === 0) c.moveTo(l, y);
    else if (i % 2 === 1) c.lineTo(r, y);
    else c.lineTo(l, y);
  }
  c.stroke();
  c.restore();
}
