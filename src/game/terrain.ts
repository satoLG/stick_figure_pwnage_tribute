import { clamp, hashNoise, TAU, type Vec2 } from '../core/math';

/** How thick the floor slab is, in world units. Fixed, because the figure is. */
const FLOOR_THICKNESS = 124;
/** The lowest part of the floor is never carved, so nobody digs out of the world. */
const BEDROCK_DEPTH = 48;

export interface WorldSize { w: number; h: number; }

/**
 * Picks playfield dimensions that exactly match the viewport's aspect ratio, so
 * the canvas fills the screen with no letterbox bars in any orientation.
 *
 * Landscape keeps a fixed height and lets the width grow (more running room);
 * portrait keeps a fixed width and lets the height grow (a taller wall). Both
 * are clamped so the fixed-size stick figure never ends up lost in the frame.
 */
export function computeWorldSize(vw: number, vh: number): WorldSize {
  const aspect = Math.max(0.25, Math.min(4, (vw || 1) / (vh || 1)));
  let w: number, h: number;
  if (aspect >= 1) { h = 720; w = h * aspect; }
  else { w = 640; h = w / aspect; }
  // Each clamp re-derives the other side from the aspect, so it is preserved.
  if (w < 820) { w = 820; h = w / aspect; }
  if (w > 2200) { w = 2200; h = w / aspect; }
  if (h < 620) { h = 620; w = h * aspect; }
  if (h > 1500) { h = 1500; w = h * aspect; }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Maps a destination coordinate back to its source, in two linear pieces that
 * meet at a landmark both sizes share (the wall face, or the floor surface).
 */
function remap(v: number, dstSplit: number, dstMax: number, srcSplit: number, srcMax: number): number {
  if (v <= dstSplit) return dstSplit > 0 ? (v / dstSplit) * srcSplit : srcSplit;
  const t = (v - dstSplit) / Math.max(1, dstMax - dstSplit);
  return srcSplit + t * (srcMax - srcSplit);
}

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
  w: number;
  h: number;
  mask!: Uint8Array;
  canvas: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;

  /** Top surface of the floor slab. */
  groundTop = 0;
  private bedrockY = 0;
  /** Nominal left face of the wall; the real edge wobbles around it. */
  wallX = 0;

  /** Only wall pixels count towards the win condition; the floor is scenery. */
  private wallTotal = 0;
  private wallLeft = 0;
  /** Marks which solid pixels belong to the wall rather than the floor. */
  private isWall!: Uint8Array;

  /** Per-row / per-column silhouette, precomputed so building is one cheap pass. */
  private faceX!: Float32Array;
  private surfY!: Float32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.canvas = document.createElement('canvas');
    const c = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!c) throw new Error('2D context unavailable');
    this.tctx = c;
    this.rebuild();
  }

  // --------------------------------------------------------------- build ---

  private layout(): void {
    this.groundTop = this.h - FLOOR_THICKNESS;
    this.bedrockY = this.h - BEDROCK_DEPTH;
    // A thinner wall on narrow screens, so portrait still leaves running room.
    const thickness = clamp(this.w * 0.27, 190, 380);
    this.wallX = this.w - thickness;
  }

  /** Builds pristine terrain at the current size, discarding any damage. */
  private rebuild(): void {
    this.layout();
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.mask = new Uint8Array(this.w * this.h);
    this.isWall = new Uint8Array(this.w * this.h);

    this.faceX = new Float32Array(this.h);
    for (let y = 0; y < this.h; y++) this.faceX[y] = this.wallFace(y);
    this.surfY = new Float32Array(this.w);
    for (let x = 0; x < this.w; x++) this.surfY[x] = this.groundSurface(x);

    this.wallTotal = 0;
    const wallBottom = this.groundTop + 40;
    for (let y = 0; y < this.h; y++) {
      const face = this.faceX[y];
      const row = y * this.w;
      const inWallRow = y <= wallBottom;
      for (let x = 0; x < this.w; x++) {
        const inWall = inWallRow && x >= face;
        if (inWall || y >= this.surfY[x]) {
          this.mask[row + x] = 1;
          if (inWall && y < this.groundTop) {
            this.isWall[row + x] = 1;
            this.wallTotal++;
          }
        }
      }
    }
    this.wallLeft = this.wallTotal;
    this.repaintFromMask();
  }

  /**
   * Re-lays the world at a new size (rotation, window resize) while keeping the
   * damage already done.
   *
   * Damage cannot simply be copied across: the wall's thickness and the floor's
   * depth are clamped differently at different sizes, so a straight offset
   * would drop most holes outside the new wall. Instead each axis is remapped
   * piecewise about its landmark - the wall's face on x, the floor's surface on
   * y - so the open ground maps to open ground and the wall maps to the wall,
   * and the fraction destroyed survives even a full rotation.
   */
  resizeTo(nw: number, nh: number): void {
    if (nw === this.w && nh === this.h) return;
    const oldMask = this.mask;
    const ow = this.w, oh = this.h;
    const oldWallX = this.wallX, oldGround = this.groundTop;
    // The old silhouette, kept so we can tell a hole the player made from a
    // spot that was simply never solid. Without this the wall's ragged face
    // reads as damage, because its wobble lands differently at the new size.
    const oldFace = this.faceX, oldSurf = this.surfY;
    const oldWallBottom = oldGround + 40;

    this.w = nw; this.h = nh;
    this.rebuild();

    // Precompute the source column for every destination column.
    const srcX = new Int32Array(nw);
    for (let x = 0; x < nw; x++) {
      srcX[x] = clamp(Math.round(remap(x, this.wallX, nw, oldWallX, ow)), 0, ow - 1);
    }

    for (let y = 0; y < nh; y++) {
      const oy = clamp(Math.round(remap(y, this.groundTop, nh, oldGround, oh)), 0, oh - 1);
      const orow = oy * ow, nrow = y * nw;
      const face = oldFace[oy];
      const inWallRow = oy <= oldWallBottom;
      for (let x = 0; x < nw; x++) {
        const ox = srcX[x];
        if (oldMask[orow + ox] !== 0) continue;
        // Only a pixel that used to be solid counts as destroyed.
        if (!((inWallRow && ox >= face) || oy >= oldSurf[ox])) continue;
        const i = nrow + x;
        if (this.mask[i] === 1) {
          this.mask[i] = 0;
          if (this.isWall[i] === 1) { this.isWall[i] = 0; this.wallLeft--; }
        }
      }
    }
    this.repaintFromMask();
  }

  /** Paints the visible bitmap from the mask. Only used on build and resize. */
  private repaintFromMask(): void {
    const img = this.tctx.createImageData(this.w, this.h);
    const px = img.data;
    for (let i = 0, p = 0; i < this.mask.length; i++, p += 4) {
      if (this.mask[i] === 1) px[p + 3] = 255; // opaque black; rgb stays 0
    }
    this.tctx.putImageData(img, 0, 0);
  }

  /** Height of the floor surface at a given x. */
  groundSurface(x: number): number {
    return this.groundTop
      + Math.sin(x * 0.013) * 5
      + Math.sin(x * 0.047 + 1.7) * 2.6
      + Math.sin(x * 0.11 + 0.4) * 1.4;
  }

  /** x position of the wall's left face at a given y - deliberately ragged. */
  private wallFace(y: number): number {
    return this.wallX
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
      if (y >= this.bedrockY) break; // bedrock is indestructible
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
    if (maxY > this.bedrockY) {
      c.beginPath();
      c.rect(0, 0, this.w, this.bedrockY);
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

  /**
   * Near the end the leftovers are a handful of scattered slivers that are no
   * fun to hunt down, so anything still standing is swept away.
   */
  sweepRemains(): void {
    const x0 = Math.max(0, Math.floor(this.wallX) - 90);
    for (let y = 0; y < this.groundTop; y++) {
      const row = y * this.w;
      for (let x = x0; x < this.w; x++) {
        const idx = row + x;
        if (this.isWall[idx] === 1) { this.isWall[idx] = 0; this.mask[idx] = 0; }
      }
    }
    this.wallLeft = 0;
    const c = this.tctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillRect(x0, 0, this.w - x0, this.groundTop);
    c.restore();
  }

  /** Bounding box of what is left of the wall, for the "last chunks" hint. */
  wallBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = this.w, y0 = this.h, x1 = 0, y1 = 0, found = false;
    const startX = Math.max(0, Math.floor(this.wallX) - 90);
    for (let y = 0; y < this.groundTop; y += 3) {
      const row = y * this.w;
      for (let x = startX; x < this.w; x += 3) {
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

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.canvas, 0, 0);
  }
}
