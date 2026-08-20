import { clamp, hashNoise, rand, TAU, type Vec2 } from '../core/math';

export const WORLD_W = 1280;
export const WORLD_H = 720;

/** Top surface of the floor slab. */
export const GROUND_Y = 596;
/** The bottom of the floor can never be dug through, so the player cannot fall out. */
const BEDROCK_Y = GROUND_Y + 76;
/** Nominal left face of the wall; the real edge wobbles around it. */
export const WALL_X = 902;

export interface CarveResult {
  removed: number;
  /** Sampled points that were solid a moment ago - good places to spawn debris. */
  edges: Vec2[];
}

/**
 * The scenery is one black bitmap. Two representations are kept in lockstep:
 *
 *  - `mask`, a Uint8Array of 1/0 used for collision and for counting how much
 *    of the wall is left;
 *  - an offscreen canvas, which is what actually gets drawn.
 *
 * Both are modified through `carvePolygon`, which fills the exact same polygon
 * into each (scanline into the array, `destination-out` into the canvas), so
 * what you see is always what you collide with.
 */
export class Terrain {
  readonly w = WORLD_W;
  readonly h = WORLD_H;
  mask: Uint8Array;
  canvas: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;

  /** Only wall pixels count towards the win condition; the floor is scenery. */
  private wallTotal = 0;
  private wallLeft = 0;
  /** Marks which solid pixels belong to the wall rather than the floor. */
  private isWall: Uint8Array;

  constructor() {
    this.mask = new Uint8Array(this.w * this.h);
    this.isWall = new Uint8Array(this.w * this.h);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    const c = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!c) throw new Error('2D context unavailable');
    this.tctx = c;
    this.build();
  }

  // --------------------------------------------------------------- build ---

  /**
   * The silhouette is drawn first with wobbly edges (layered sines, the same
   * trick as the hand-drawn strokes) and then rasterised into the mask, so the
   * initial shape and the collision data cannot drift apart.
   */
  private build(): void {
    const c = this.tctx;
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#000';

    // --- floor slab, with a lumpy top surface -------------------------------
    c.beginPath();
    c.moveTo(-4, this.h + 4);
    for (let x = -4; x <= this.w + 4; x += 8) {
      c.lineTo(x, this.groundSurface(x));
    }
    c.lineTo(this.w + 4, this.h + 4);
    c.closePath();
    c.fill();

    // --- the wall on the right, with a torn vertical face ------------------
    c.beginPath();
    c.moveTo(this.w + 4, -4);
    c.lineTo(this.w + 4, GROUND_Y + 40);
    for (let y = GROUND_Y + 40; y >= -4; y -= 6) {
      c.lineTo(this.wallFace(y), y);
    }
    c.closePath();
    c.fill();

    // Rasterise both regions into the mask / ownership arrays.
    for (let y = 0; y < this.h; y++) {
      const face = this.wallFace(y);
      const surf = this.groundSurface(y); // unused per-row, kept out of the hot path
      void surf;
      const row = y * this.w;
      for (let x = 0; x < this.w; x++) {
        const inWall = y <= GROUND_Y + 40 && x >= face;
        const inGround = y >= this.groundSurface(x);
        if (inWall || inGround) {
          this.mask[row + x] = 1;
          if (inWall && y < GROUND_Y) {
            this.isWall[row + x] = 1;
            this.wallTotal++;
          }
        }
      }
    }
    this.wallLeft = this.wallTotal;
  }

  /** Height of the floor surface at a given x. */
  groundSurface(x: number): number {
    return GROUND_Y
      + Math.sin(x * 0.013) * 5
      + Math.sin(x * 0.047 + 1.7) * 2.6
      + Math.sin(x * 0.11 + 0.4) * 1.4;
  }

  /** x position of the wall's left face at a given y - deliberately ragged. */
  private wallFace(y: number): number {
    return WALL_X
      + Math.sin(y * 0.017) * 18
      + Math.sin(y * 0.052 + 2.1) * 9
      + Math.sin(y * 0.131 + 0.9) * 4.5
      + hashNoise(y | 0, 7) * 3;
  }

  // ---------------------------------------------------------- collision ---

  solidAt(x: number, y: number): boolean {
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return iy >= this.h;
    return this.mask[iy * this.w + ix] === 1;
  }

  /** March along a ray and return the first solid hit, or null. */
  raycast(x: number, y: number, dx: number, dy: number, maxDist: number, step = 2): Vec2 | null {
    const len = Math.hypot(dx, dy) || 1;
    const sx = (dx / len) * step, sy = (dy / len) * step;
    let px = x, py = y;
    for (let d = 0; d < maxDist; d += step) {
      if (px < -80 || px > this.w + 80 || py > this.h + 80) return null;
      if (this.solidAt(px, py)) {
        // Step back at 1px resolution for a clean contact point.
        for (let k = 0; k < step; k++) {
          const bx = px - (sx / step) * k, by = py - (sy / step) * k;
          if (!this.solidAt(bx, by)) return { x: bx, y: by };
        }
        return { x: px, y: py };
      }
      px += sx; py += sy;
    }
    return null;
  }

  /** Distance down to the first solid pixel, used to plant feet on rubble. */
  groundBelow(x: number, y: number, maxDist = 200): number {
    for (let d = 0; d < maxDist; d++) {
      if (this.solidAt(x, y + d)) return d;
    }
    return maxDist;
  }

  // ------------------------------------------------------------- carving ---

  /**
   * Removes a polygon from both the mask and the picture. This is the single
   * primitive every weapon is built on: craters are noisy circles, sword cuts
   * are thin arcs, beams are long capsules.
   */
  carvePolygon(pts: readonly Vec2[]): CarveResult {
    const result: CarveResult = { removed: 0, edges: [] };
    if (pts.length < 3) return result;

    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of pts) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    const y0 = clamp(Math.floor(minY), 0, this.h - 1);
    const y1 = clamp(Math.ceil(maxY), 0, this.h - 1);
    if (maxX < 0 || minX > this.w || maxY < 0 || minY > this.h) return result;

    // Scanline fill into the mask.
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      if (y >= BEDROCK_Y) break; // bedrock is indestructible
      const cy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a.y > cy) !== (b.y > cy)) {
          xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const row = y * this.w;
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const sx = clamp(Math.ceil(xs[s]), 0, this.w - 1);
        const ex = clamp(Math.floor(xs[s + 1]), 0, this.w - 1);
        for (let x = sx; x <= ex; x++) {
          const idx = row + x;
          if (this.mask[idx] === 1) {
            this.mask[idx] = 0;
            result.removed++;
            if (this.isWall[idx] === 1) {
              this.isWall[idx] = 0;
              this.wallLeft--;
            }
            // Cheap sampling for debris spawn points.
            if ((result.removed & 255) === 0) result.edges.push({ x, y });
          }
        }
      }
    }

    // Same polygon punched out of the visible bitmap.
    const c = this.tctx;
    c.save();
    if (maxY > BEDROCK_Y) {
      c.beginPath();
      c.rect(0, 0, this.w, BEDROCK_Y);
      c.clip();
    }
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.closePath();
    c.fill();
    c.restore();

    return result;
  }

  /** A crater: a circle whose radius wobbles, so nothing looks stamped. */
  carveBlob(x: number, y: number, radius: number, roughness = 0.22, sides = 22): CarveResult {
    const pts: Vec2[] = [];
    const seed = (x * 13 + y * 7) | 0;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      const r = radius * (1 + hashNoise(seed + i, i * 3) * roughness);
      pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
    }
    return this.carvePolygon(pts);
  }

  /** A capsule between two points: sword cuts, bullet tunnels, energy beams. */
  carveCapsule(ax: number, ay: number, bx: number, by: number, radius: number, roughness = 0.25): CarveResult {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pts: Vec2[] = [];
    const steps = Math.max(4, Math.min(28, Math.round(len / 12)));
    const seed = (ax * 3 + ay * 11) | 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = radius * (1 + hashNoise(seed + i, 1) * roughness) * (0.75 + Math.sin(t * Math.PI) * 0.35);
      pts.push({ x: ax + dx * t + nx * r, y: ay + dy * t + ny * r });
    }
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const r = radius * (1 + hashNoise(seed + i, 2) * roughness) * (0.75 + Math.sin(t * Math.PI) * 0.35);
      pts.push({ x: ax + dx * t - nx * r, y: ay + dy * t - ny * r });
    }
    return this.carvePolygon(pts);
  }

  /** A crescent slice, for sword swings. */
  carveArc(cx: number, cy: number, radius: number, from: number, to: number, thickness: number): CarveResult {
    const pts: Vec2[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const a = from + (to - from) * (i / steps);
      const r = radius + thickness * 0.5 * (0.8 + Math.sin((i / steps) * Math.PI) * 0.6);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    for (let i = steps; i >= 0; i--) {
      const a = from + (to - from) * (i / steps);
      const r = Math.max(1, radius - thickness * 0.5 * (0.8 + Math.sin((i / steps) * Math.PI) * 0.6));
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return this.carvePolygon(pts);
  }

  // -------------------------------------------------------------- status ---

  /** 0..1 fraction of the wall that has been destroyed. */
  get destroyed(): number {
    if (this.wallTotal === 0) return 1;
    return 1 - this.wallLeft / this.wallTotal;
  }

  get wallRemaining(): number { return this.wallLeft; }

  /**
   * Near the end the leftovers are a handful of scattered slivers that are no
   * fun to hunt down, so anything under this many pixels is swept away.
   */
  sweepRemains(): void {
    for (let y = 0; y < GROUND_Y; y++) {
      const row = y * this.w;
      for (let x = WALL_X - 80; x < this.w; x++) {
        const idx = row + x;
        if (this.isWall[idx] === 1) { this.isWall[idx] = 0; this.mask[idx] = 0; }
      }
    }
    this.wallLeft = 0;
    const c = this.tctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillRect(WALL_X - 80, 0, this.w - (WALL_X - 80), GROUND_Y);
    c.restore();
  }

  /** Bounding box of what is left of the wall, for the "last chunks" hint. */
  wallBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = this.w, y0 = this.h, x1 = 0, y1 = 0, found = false;
    for (let y = 0; y < GROUND_Y; y += 3) {
      const row = y * this.w;
      for (let x = WALL_X - 90; x < this.w; x += 3) {
        if (this.isWall[row + x] === 1) {
          found = true;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return found ? { x0, y0, x1, y1 } : null;
  }

  /** Picks a solid point near a position, used to aim splash damage. */
  randomSolidNear(x: number, y: number, radius: number): Vec2 | null {
    for (let i = 0; i < 24; i++) {
      const a = rand(TAU), r = rand(radius);
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (this.solidAt(px, py)) return { x: px, y: py };
    }
    return null;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.canvas, 0, 0);
  }
}
