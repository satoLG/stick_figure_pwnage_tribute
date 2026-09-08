import { clamp, hashNoise, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';

/**
 * The punctuation of a hit.
 *
 * Watched frame by frame, one landed blow in the source film is not a cloud of
 * debris. It is three things and nothing else:
 *
 *   1. a frame or two of the whole screen inverted, carrying one solid shape;
 *   2. a mark that converges on the single point of contact - never scattered,
 *      never from more than one origin;
 *   3. that mark thinning out over the next fifth of a second until the paper
 *      is empty again.
 *
 * The emptying is the whole trick: it is what makes the next blow land.
 *
 * What the mark *is*, though, is different for every power, and that is the
 * point of this file. A sword does not scatter a hammer's splinters; a bullet
 * does not open a hammer's crater; wind cuts in threes. One shared drawing for
 * fourteen powers reads as a stamp - the same picture pasted over whatever just
 * happened - so each weapon names its own kind here and gets its own.
 */
export type MarkKind =
  /** Long splinters thrown back off the point. The default, and the hammer's. */
  | 'splinter'
  /** One long crescent lying along the cut, with a few splinters off it. */
  | 'slash'
  /** Spikes all the way round, thrown out of a hole. */
  | 'crater'
  /** A tight dense star of short needles: a round going in. */
  | 'spark'
  /** Three arcs abreast: wind, and anything else that cuts in threes. */
  | 'claw'
  /** Forked jagged legs, thrown off where a discharge earths itself. */
  | 'bolt'
  /** A ring of round lobes: what a charge going off leaves. */
  | 'bloom'
  /** A narrow double cone through the point: a beam arriving. */
  | 'pierce';

interface Hit {
  x: number; y: number;
  /** Direction the force is travelling, in radians. The mark opens against it. */
  dir: number;
  power: number;
  kind: MarkKind;
  /** Seconds since it landed. Continuous, so the mark collapses smoothly. */
  t: number;
  seed: number;
}

/** How many strokes are left on each stage of a mark's life. */
const FAN = [21, 13, 7, 3];
/** Seconds a stage lasts. Authored as one of the film's drawings; played at 60. */
const STAGE = 1 / 15;
const LIFE = FAN.length * STAGE;

export class ImpactFx {
  private list: Hit[] = [];

  add(x: number, y: number, dir: number, power = 1, kind: MarkKind = 'splinter'): void {
    // Only ever one hit on the paper. Two overlapping marks is the exact thing
    // that turns a fight into a scribble, and the reference never does it.
    this.list.length = 0;
    this.list.push({
      x, y, dir, kind, power: clamp(power, 0.3, 2), t: 0,
      seed: (x * 7 + y * 13) | 0,
    });
  }

  clear(): void { this.list.length = 0; }

  step(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      this.list[i].t += dt;
      if (this.list[i].t >= LIFE) this.list.splice(i, 1);
    }
  }

  get busy(): boolean { return this.list.length > 0; }

  /**
   * The live mark, drawn where the blow actually landed.
   *
   * `inverted` flips it solid, because on an inverted frame a white-filled
   * shape with a black outline would vanish into the black ground.
   */
  draw(sk: Sketch, worldW: number, inverted = false): void {
    for (const h of this.list) {
      const stage = Math.min(FAN.length - 1, Math.floor(h.t / STAGE));
      // Continuous inside the stage: at sixty frames a second four identical
      // drawings in a row is a stutter, so only the *count* steps and
      // everything else eases.
      const age = h.t / STAGE;
      drawMark(sk, {
        kind: h.kind, x: h.x, y: h.y, dir: h.dir, power: h.power, seed: h.seed,
        strokes: FAN[stage], fade: clamp(1 - age * 0.16, 0.15, 1),
        reach: worldW * (0.26 + h.power * 0.2), inverted, scale: 1,
      });
    }
  }

  /** Where the last blow landed, for whoever wants to draw on top of it. */
  get last(): { x: number; y: number; dir: number; power: number; kind: MarkKind } | null {
    const h = this.list[this.list.length - 1];
    return h ? { x: h.x, y: h.y, dir: h.dir, power: h.power, kind: h.kind } : null;
  }

  /** A ring of hard spikes around a crater; the wall shattering, not smoking. */
  burstRing(sk: Sketch, x: number, y: number, radius: number, count = 9): void {
    const c = sk.ctx;
    c.save();
    c.fillStyle = '#000';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + hashNoise(i, sk.boil) * 0.2;
      const r0 = radius * 0.7;
      const len = radius * (0.4 + Math.abs(hashNoise(i * 3, sk.boil)) * 0.9);
      const ca = Math.cos(a), sa = Math.sin(a);
      const w = radius * 0.16;
      c.beginPath();
      c.moveTo(x + ca * r0 - sa * w, y + sa * r0 + ca * w);
      c.lineTo(x + ca * r0 + sa * w, y + sa * r0 - ca * w);
      c.lineTo(x + ca * (r0 + len), y + sa * (r0 + len));
      c.closePath();
      c.fill();
    }
    c.restore();
  }
}

export interface MarkSpec {
  kind: MarkKind;
  x: number; y: number;
  dir: number;
  power: number;
  seed: number;
  /** How many strokes this drawing has left. */
  strokes: number;
  /** 0..1, how much of the mark is left. */
  fade: number;
  /** How far the longest stroke may run, in world units. */
  reach: number;
  /** White on black instead of white-with-a-rim on paper. */
  inverted: boolean;
  /** Blown up for the inverted card, which shows one mark and nothing else. */
  scale: number;
}

/**
 * One mark, in whichever shape the power that made it uses.
 *
 * Every kind is built the same way and that is deliberate: a set of tapered
 * shapes traced into one path, filled, and then walked with a pen that lifts.
 * Filled white with a black rim they read as hard black slivers over the paper
 * and as white ones over the wall - the same drawing, right on both grounds,
 * which is what the film does. Filled solid on an inverted frame they are the
 * only thing on it.
 */
export function drawMark(sk: Sketch, m: MarkSpec): void {
  const c = sk.ctx;
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const trace = MARKS[m.kind] ?? MARKS.splinter;
  c.beginPath();
  trace(sk, m);
  c.fillStyle = m.inverted ? '#fff' : '#fff';
  c.fill();
  if (m.inverted) {
    // On black paper the shape is the whole drawing; a rim would only eat it.
    c.restore();
    return;
  }
  c.beginPath();
  trace(sk, m);
  sk.rim(3.1, 0, m.seed + Math.round(m.fade * 100));
  c.restore();
}

/** A tapered sliver from `d0` to `d1` along `a`, bowed by `bow`. */
function sliver(
  c: CanvasRenderingContext2D, m: MarkSpec, a: number,
  d0: number, d1: number, w: number, bow: number,
): void {
  const ca = Math.cos(a), sa = Math.sin(a);
  const nx = -sa, ny = ca;
  const p = (d: number, o: number): Vec2 =>
    ({ x: m.x + ca * d + nx * o, y: m.y + sa * d + ny * o });
  const base = p(d0, 0);
  const tip = p(d1, bow);
  const mid = d0 + (d1 - d0) * 0.4;
  const e1 = p(mid, w * 0.5 + bow * 0.4);
  const e2 = p(mid, -w * 0.5 + bow * 0.4);
  c.moveTo(base.x, base.y);
  c.quadraticCurveTo(e1.x, e1.y, tip.x, tip.y);
  c.quadraticCurveTo(e2.x, e2.y, base.x, base.y);
}

/** A crescent: an arc of radius `r` swept `span` wide, `w` thick at its belly. */
function crescent(
  c: CanvasRenderingContext2D, cx: number, cy: number,
  r: number, mid: number, span: number, w: number,
): void {
  const N = 16;
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = mid + (t - 0.5) * span;
    const k = Math.sin(t * Math.PI);
    pts.push({ x: cx + Math.cos(a) * (r + w * 0.5 * k), y: cy + Math.sin(a) * (r + w * 0.5 * k) });
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const a = mid + (t - 0.5) * span;
    const k = Math.sin(t * Math.PI);
    pts.push({ x: cx + Math.cos(a) * (r - w * 0.5 * k), y: cy + Math.sin(a) * (r - w * 0.5 * k) });
  }
  c.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) c.lineTo(p.x, p.y);
  c.closePath();
}

type Trace = (sk: Sketch, m: MarkSpec) => void;

const MARKS: Record<MarkKind, Trace> = {
  /**
   * The default: long splinters thrown back against the blow, all from the one
   * point, at wildly uneven lengths. What a heavy blunt thing does to stone.
   */
  splinter(sk, m) {
    const c = sk.ctx;
    const n = m.strokes;
    const back = m.dir + Math.PI;
    const spread = 2.3 + m.power * 0.35;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = back + (t - 0.5) * spread + hashNoise(m.seed + i, sk.boil) * 0.07;
      const len = m.reach * m.scale
        * (0.34 + Math.abs(hashNoise(m.seed + i * 3, 1)) * 1.15) * m.fade;
      const w = (3.4 + m.power * 4.6) * m.scale * m.fade
        * (0.45 + Math.abs(hashNoise(m.seed + i * 7, 4)) * 1.5);
      sliver(c, m, a, len * 0.12, len, w, hashNoise(m.seed + i * 11, 5) * len * 0.1);
    }
  },

  /**
   * A cut: one long crescent lying across the line of the blow, with a handful
   * of splinters shed off its back. The blade's own path, left on the paper.
   */
  slash(sk, m) {
    const c = sk.ctx;
    const r = m.reach * m.scale * (0.46 + m.power * 0.12);
    const w = (16 + m.power * 26) * m.scale * m.fade;
    // Centred behind the contact so the arc passes through it.
    const cx = m.x - Math.cos(m.dir) * r;
    const cy = m.y - Math.sin(m.dir) * r;
    crescent(c, cx, cy, r, m.dir, (0.7 + m.power * 0.3) * m.fade, w);
    const n = Math.max(2, Math.round(m.strokes * 0.35));
    for (let i = 0; i < n; i++) {
      const a = m.dir + Math.PI + (i / n - 0.5) * 2.2 + hashNoise(m.seed + i, sk.boil) * 0.2;
      const len = m.reach * m.scale * (0.3 + Math.abs(hashNoise(m.seed + i * 5, 2)) * 0.8) * m.fade;
      sliver(c, m, a, len * 0.18, len, (3 + m.power * 3) * m.scale * m.fade, 0);
    }
  },

  /**
   * A hole: spikes the whole way round it, longest where the blow was going.
   * Nothing here points back at whoever swung.
   */
  crater(sk, m) {
    const c = sk.ctx;
    const n = m.strokes;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + hashNoise(m.seed + i, sk.boil) * 0.25;
      // Longest along the blow, shortest against it.
      const along = 0.55 + 0.45 * Math.cos(a - m.dir);
      const len = m.reach * m.scale * (0.16 + Math.abs(hashNoise(m.seed + i * 3, 1)) * 0.5)
        * (0.5 + along) * m.fade;
      const w = (5 + m.power * 7) * m.scale * m.fade
        * (0.5 + Math.abs(hashNoise(m.seed + i * 7, 4)));
      sliver(c, m, a, len * 0.22, len, w, hashNoise(m.seed + i * 11, 5) * len * 0.12);
    }
  },

  /**
   * A round going in: a tight dense star of short needles, and two long ones
   * carrying on the way the round was travelling.
   */
  spark(sk, m) {
    const c = sk.ctx;
    const n = m.strokes + 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + hashNoise(m.seed + i, sk.boil) * 0.4;
      const len = m.reach * m.scale * (0.05 + Math.abs(hashNoise(m.seed + i * 3, 1)) * 0.16) * m.fade;
      sliver(c, m, a, len * 0.1, len, (2.4 + m.power * 2.6) * m.scale * m.fade, 0);
    }
    for (const s of [-1, 1]) {
      const a = m.dir + s * 0.16;
      const len = m.reach * m.scale * 0.4 * m.fade;
      sliver(c, m, a, len * 0.05, len, (2.6 + m.power * 2) * m.scale * m.fade, 0);
    }
  },

  /** Three arcs abreast, raked through the point together. */
  claw(sk, m) {
    const c = sk.ctx;
    const r = m.reach * m.scale * 0.5;
    const w = (9 + m.power * 12) * m.scale * m.fade;
    const gap = w * 1.9;
    const cx = m.x - Math.cos(m.dir) * r;
    const cy = m.y - Math.sin(m.dir) * r;
    for (let i = -1; i <= 1; i++) {
      const rr = r + i * gap;
      const span = (0.85 - Math.abs(i) * 0.16) * m.fade;
      crescent(c, cx, cy, rr, m.dir + hashNoise(m.seed + i, sk.boil) * 0.05, span,
        w * (i === 0 ? 1 : 0.72));
    }
  },

  /**
   * Where a discharge earths itself: legs that kink as they go and fork once,
   * rather than the clean slivers everything else throws.
   */
  bolt(sk, m) {
    const c = sk.ctx;
    const n = Math.max(3, Math.round(m.strokes * 0.6));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU + hashNoise(m.seed + i, sk.boil) * 0.5;
      const len = m.reach * m.scale * (0.18 + Math.abs(hashNoise(m.seed + i * 3, 1)) * 0.62) * m.fade;
      const w = (4 + m.power * 5) * m.scale * m.fade;
      // Two kinked segments, then a shorter fork off the knee.
      const knee = len * 0.55;
      const a1 = a0 + hashNoise(m.seed + i * 5, 2) * 0.7;
      const kx = m.x + Math.cos(a0) * knee, ky = m.y + Math.sin(a0) * knee;
      sliver(c, m, a0, 0, knee, w, 0);
      sliver(c, { ...m, x: kx, y: ky }, a1, 0, len - knee, w * 0.8, 0);
      if (i % 2 === 0) {
        const a2 = a0 - hashNoise(m.seed + i * 7, 3) * 0.9;
        sliver(c, { ...m, x: kx, y: ky }, a2, 0, (len - knee) * 0.6, w * 0.5, 0);
      }
    }
  },

  /** A charge going off: round lobes crowding out of the point. */
  bloom(sk, m) {
    const c = sk.ctx;
    const n = Math.max(4, Math.round(m.strokes * 0.5));
    const R = m.reach * m.scale * 0.3 * (0.6 + m.fade * 0.6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + hashNoise(m.seed + i, sk.boil) * 0.3;
      const d = R * (0.45 + Math.abs(hashNoise(m.seed + i * 3, 1)) * 0.7);
      const r = R * (0.3 + Math.abs(hashNoise(m.seed + i * 5, 2)) * 0.45);
      const cx = m.x + Math.cos(a) * d, cy = m.y + Math.sin(a) * d;
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, TAU);
    }
    // And a few splinters out of the cloud, so it is a blast and not a puff.
    for (let i = 0; i < Math.max(2, m.strokes - 8); i++) {
      const a = (i / 6) * TAU + hashNoise(m.seed + i * 9, sk.boil);
      const len = R * (1.3 + Math.abs(hashNoise(m.seed + i * 11, 3)) * 1.5);
      sliver(c, m, a, R * 0.8, len, (4 + m.power * 4) * m.scale * m.fade, 0);
    }
  },

  /**
   * A beam arriving: a narrow double cone through the point, along the beam,
   * with nothing thrown sideways at all.
   */
  pierce(sk, m) {
    const c = sk.ctx;
    const len = m.reach * m.scale * (0.35 + m.power * 0.2) * m.fade;
    const w = (7 + m.power * 9) * m.scale * m.fade;
    sliver(c, m, m.dir, 0, len * 0.5, w * 0.7, 0);
    sliver(c, m, m.dir + Math.PI, 0, len, w, 0);
    for (let i = 0; i < Math.max(2, Math.round(m.strokes * 0.25)); i++) {
      const s = i % 2 === 0 ? 1 : -1;
      const a = m.dir + Math.PI + s * (0.2 + Math.abs(hashNoise(m.seed + i, sk.boil)) * 0.25);
      sliver(c, m, a, len * 0.2, len * (0.5 + Math.abs(hashNoise(m.seed + i * 3, 2)) * 0.5),
        w * 0.45, 0);
    }
  },
};
