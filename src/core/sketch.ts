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
