import { hashNoise, type Vec2 } from './math';

/**
 * The whole game is drawn as black ink on white paper. Real frame-by-frame
 * stick animations wobble because every frame is redrawn by hand, so instead of
 * clean geometry every stroke here is perturbed by a seeded noise that only
 * advances a few times a second. That is what gives the picture its "boil".
 */
export class Sketch {
  ctx: CanvasRenderingContext2D;
  /** Advances ~10x a second so the wobble reads as redrawn frames, not static. */
  boil = 0;
  /** Global wobble amount in world units. */
  jitter = 1.15;
  private strokeId = 0;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  /**
   * Called once per drawn frame; `t` is elapsed seconds. The wobble advances on
   * its own clock, about twelve times a second, so the ink looks re-drawn at a
   * hand-drawn rate whether the game is painting 15 frames a second or 60.
   */
  update(t: number): void {
    this.boil = Math.floor(t * 12);
    this.strokeId = 0;
  }

  private nx(seed: number): number {
    return hashNoise(seed * 2 + 1, this.boil) * this.jitter;
  }
  private ny(seed: number): number {
    return hashNoise(seed * 2 + 7919, this.boil * 3 + 11) * this.jitter;
  }

  begin(width: number, color = '#000'): void {
    const c = this.ctx;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = color;
    c.lineWidth = width;
  }

  /**
   * A wobbly line. Split into segments whose midpoints drift, so a "straight"
   * limb never looks like it came out of a vector editor.
   */
  line(a: Vec2, b: Vec2, width: number, segments = 2, wobble = 1): void {
    const c = this.ctx;
    const id = ++this.strokeId * 31;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(a.x + this.nx(id) * 0.5, a.y + this.ny(id) * 0.5);
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const edge = i === segments ? 0.5 : wobble;
      c.lineTo(px + this.nx(id + i) * edge, py + this.ny(id + i) * edge);
    }
    c.stroke();
  }

  /** A curved limb / tail / flame tongue through a quadratic control point. */
  curve(a: Vec2, ctrl: Vec2, b: Vec2, width: number, wobble = 1): void {
    const c = this.ctx;
    const id = ++this.strokeId * 37;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(a.x + this.nx(id) * 0.5, a.y + this.ny(id) * 0.5);
    c.quadraticCurveTo(
      ctrl.x + this.nx(id + 1) * wobble * 2,
      ctrl.y + this.ny(id + 1) * wobble * 2,
      b.x + this.nx(id + 2) * 0.5,
      b.y + this.ny(id + 2) * 0.5,
    );
    c.stroke();
  }

  /** Trace a polygon path (does not paint) so the caller can fill or stroke. */
  polyPath(pts: readonly Vec2[], wobble = 1, close = true): void {
    const c = this.ctx;
    const id = ++this.strokeId * 41;
    c.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p.x + this.nx(id + i) * wobble;
      const y = p.y + this.ny(id + i) * wobble;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    if (close) c.closePath();
  }

  poly(pts: readonly Vec2[], width: number, fill = false, wobble = 1): void {
    const c = this.ctx;
    this.polyPath(pts, wobble);
    if (fill) { c.fillStyle = c.strokeStyle as string; c.fill(); }
    c.lineWidth = width;
    c.stroke();
  }

  /**
   * The heads in these animations are never true circles - they read as rough
   * 9 or 10 sided blobs, so that is what we draw.
   */
  head(cx: number, cy: number, r: number, ang: number, width: number, sides = 10): void {
    const pts: Vec2[] = [];
    const id = ++this.strokeId * 53;
    for (let i = 0; i < sides; i++) {
      const a = ang + (i / sides) * Math.PI * 2;
      const rr = r * (1 + hashNoise(id + i, this.boil) * 0.07);
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    this.poly(pts, width, false, 0.5);
  }

  /**
   * A loose, fast, scrawled stroke. Where `line` keeps close to the straight
   * path between its ends, this one lets the middle wander a long way off it,
   * so the mark reads as thrown down at speed rather than measured out. It is
   * what the reference's wilder frames are made of.
   */
  scrawl(a: Vec2, b: Vec2, width: number, wobble = 5, segments = 4): void {
    const c = this.ctx;
    const id = ++this.strokeId * 61;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(a.x, a.y);
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      // Off the axis, not just jittered around the point: a scrawl bows.
      const off = i === segments ? 0 : hashNoise(id + i, this.boil) * wobble * Math.sin(t * Math.PI);
      c.lineTo(a.x + dx * t + nx * off, a.y + dy * t + ny * off);
    }
    c.stroke();
  }

  /**
   * The explosive fan. Traces (but does not paint) a set of long tapered
   * slivers radiating from a point: wildly uneven lengths, each bowed off its
   * own axis, so nothing about the shape is regular. `burst` draws neat rays
   * for small punctuation; this is for when something has actually gone off,
   * and the caller fills and strokes it - white with an ink edge is what reads
   * over the paper and over the black wall alike.
   */
  blastPath(
    cx: number, cy: number, count: number, r0: number, r1: number, width: number,
    spread = Math.PI * 2, dir = 0, seed = 0,
  ): void {
    const c = this.ctx;
    const step = spread / Math.max(1, count);
    c.beginPath();
    for (let i = 0; i < count; i++) {
      const a = dir + (count === 1 ? 0 : (i / (count - 1) - 0.5) * spread)
        + hashNoise(seed + i, this.boil) * step * 0.75;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      const l0 = r0 * (0.45 + Math.abs(hashNoise(seed + i * 3, this.boil)) * 0.9);
      const l1 = l0 + (r1 - r0) * (0.22 + Math.abs(hashNoise(seed + i * 5, this.boil + 2)) * 1.5);
      const w = width * (0.4 + Math.abs(hashNoise(seed + i * 7, this.boil + 4)) * 1.4);
      const bow = hashNoise(seed + i * 11, this.boil + 6) * (l1 - l0) * 0.24;
      const p = (d: number, o: number): Vec2 => ({ x: cx + ca * d + nx * o, y: cy + sa * d + ny * o });
      const base = p(l0, 0);
      const tip = p(l1, bow);
      const mid = l0 + (l1 - l0) * 0.38;
      const e1 = p(mid, w * 0.5 + bow * 0.4);
      const e2 = p(mid, -w * 0.5 + bow * 0.4);
      c.moveTo(base.x, base.y);
      c.quadraticCurveTo(e1.x, e1.y, tip.x, tip.y);
      c.quadraticCurveTo(e2.x, e2.y, base.x, base.y);
    }
  }

  /**
   * A ragged closed blob - the white hole an explosion punches in the picture.
   * Alternating radii, so it is spiky rather than round.
   */
  ragPath(cx: number, cy: number, r: number, points = 13, rough = 0.5, seed = 0): void {
    const pts: Vec2[] = [];
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      const spike = i % 2 === 0 ? 1 : 1 - rough;
      const rr = r * spike * (1 + hashNoise(seed + i, this.boil) * 0.28);
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    this.polyPath(pts, 1.2);
  }

  /** Short radiating impact / speed lines, the signature "hit" punctuation. */
  burst(cx: number, cy: number, count: number, r0: number, r1: number, width: number, spread = Math.PI * 2, dir = 0, seed = 0): void {
    const c = this.ctx;
    c.lineWidth = width;
    c.beginPath();
    for (let i = 0; i < count; i++) {
      const a = dir + (count === 1 ? 0 : (i / (count - 1) - 0.5) * spread) + hashNoise(seed + i, this.boil) * 0.12;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rr0 = r0 * (0.7 + Math.abs(hashNoise(seed + i * 3, this.boil)) * 0.6);
      const rr1 = r1 * (0.6 + Math.abs(hashNoise(seed + i * 5, this.boil + 3)) * 0.8);
      c.moveTo(cx + ca * rr0, cy + sa * rr0);
      c.lineTo(cx + ca * rr1, cy + sa * rr1);
    }
    c.stroke();
  }
}
