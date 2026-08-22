import { clamp, hashNoise, TAU, type Vec2 } from '../core/math';

/** How thick the floor slab is, in world units. Fixed, because the figure is. */
const FLOOR_THICKNESS = 124;

/**
 * The wall, in world units. Fixed, because the figure is: a wall that grew with
 * the viewport meant a phone got one twice as tall as a laptop's and a game
 * twice as long for it. The screen decides how much room there is around the
 * scene, never how big the scene itself is.
 */
const WALL_H = 564;
const WALL_W = 420;
/**
 * What happens to height left over once the wall and the floor have had
 * theirs. It all goes into deepening the floor, which is what pushes the wall
 * up the picture, until the wall sits centred in the space under the HUD strip
 * - the framing the whole scene is composed for.
 *
 * The cap is the limit on that: past about a quarter of the screen the floor
 * stops reading as ground and starts reading as a black band along the bottom,
 * so on a very tall phone the wall settles a little low rather than the picture
 * turning into a slab. `FLOOR_EXTRA_MIN` keeps the old behaviour on the short
 * screens where a share of the height is all there is to give.
 */
const FLOOR_MAX_SHARE = 0.26;
const FLOOR_EXTRA_MIN = 110;

/**
 * Every carve is scaled by this before it touches the bitmap. It is the single
 * knob for how tough the wall is: at 1 a rifle magazine opens a doorway, and
 * the whole thing is gone in well under a minute.
 *
 * A tenth of that is the point of the game. Bare hands were levelling as much
 * masonry per second as a rocket, which made every weapon feel the same and
 * the wall feel like paper. Down here a single blow takes a bite you can see
 * and no more, and the wall comes down the way the film does it - by hitting
 * it, over and over, faster and faster.
 */
const DAMAGE_SCALE = 0.105;
/**
 * Radii scale by the square root of it, so the knob above stays a straight
 * multiplier on *area removed* whatever shape does the removing.
 */
const DAMAGE_SCALE_LEN = Math.sqrt(DAMAGE_SCALE);
/**
 * Wall fragments smaller than this, once cut free of everything around them,
 * are not left hanging in the air: they fall away as debris and count as
 * destroyed. Nobody should have to chase single specks around the screen.
 */
const SPECK_LIMIT = 620;

export interface WorldSize { w: number; h: number; }

/**
 * Picks playfield dimensions that exactly match the viewport's aspect ratio, so
 * the canvas fills the screen with no letterbox bars in any orientation.
 *
 * This decides how much room there is around the scene, never how big the
 * scene is: the figure, the floor and the wall are all fixed sizes laid out
 * inside whatever comes back, so a phone gets more sky and a deeper floor
 * rather than a taller wall. The lower clamp on the height is what guarantees
 * the whole wall fits under the HUD strip even on a letterbox-wide screen.
 */
export function computeWorldSize(vw: number, vh: number): WorldSize {
  const aspect = Math.max(0.25, Math.min(4, (vw || 1) / (vh || 1)));
  let w: number, h: number;
  if (aspect >= 1) { h = 864; w = h * aspect; }
  else { w = 768; h = w / aspect; }
  // Each clamp re-derives the other side from the aspect, so it is preserved.
  if (w < 984) { w = 984; h = w / aspect; }
  if (w > 2640) { w = 2640; h = w / aspect; }
  if (h < 840) { h = 840; w = h * aspect; }
  if (h > 1800) { h = 1800; w = h * aspect; }
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
  /** Top of the wall. Nothing solid is ever drawn above this. */
  wallTop = 0;
  /** Left face of the wall. It starts perfectly straight and gets eaten away. */
  wallX = 0;
  /** Height of the strip at the top of the screen the scene must stay out of. */
  private topGap: number;

  /** The ceiling of the playable space: the HUD strip's underside. */
  get sceneTop(): number { return this.topGap; }

  /** Only wall pixels count towards the win condition; the floor is scenery. */
  private wallTotal = 0;
  private wallLeft = 0;
  /** Marks which solid pixels belong to the wall rather than the floor. */
  private isWall!: Uint8Array;

  /** Per-row / per-column silhouette, precomputed so building is one cheap pass. */
  private faceX!: Float32Array;
  private surfY!: Float32Array;

  constructor(w: number, h: number, topGap = 0) {
    this.w = w;
    this.h = h;
    this.topGap = topGap;
    this.canvas = document.createElement('canvas');
    const c = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!c) throw new Error('2D context unavailable');
    this.tctx = c;
    this.rebuild();
  }

  // --------------------------------------------------------------- build ---

  /**
   * The scene is a fixed-size thing placed on a variable-size screen, not a
   * thing stretched to fill it. The wall is always the same wall; whatever
   * height is left over after the HUD strip becomes sky above it and a deeper
   * floor below, so it sits in much the same place whatever the screen shape.
   *
   * Where in that leftover it sits is the framing. The wall is aimed at the
   * middle of the space under the HUD strip - the picture is composed around
   * it, so it belongs in the middle of the picture - by deepening the floor
   * until it gets there, as far as the cap allows.
   */
  private layout(): void {
    const room = Math.max(200, this.h - this.topGap - FLOOR_THICKNESS);
    // Only a screen too short to hold the whole thing shrinks it, and then the
    // HUD strip is what gives way first.
    const wallH = Math.min(WALL_H, room);
    const slack = room - wallH;
    // Exactly the extra floor that would put the wall's middle on the middle of
    // the visible band. Negative on a short screen, where the wall is already
    // as low as it can go and the floor stays a plain slab.
    const centred = this.h - FLOOR_THICKNESS - (this.topGap + this.h) / 2 - wallH / 2;
    const cap = Math.max(FLOOR_EXTRA_MIN, this.h * FLOOR_MAX_SHARE - FLOOR_THICKNESS);
    const floorExtra = clamp(centred, 0, Math.min(slack, cap));
    this.wallTop = Math.round(Math.max(0, this.h - FLOOR_THICKNESS - floorExtra - wallH));
    this.groundTop = this.wallTop + wallH;
    this.wallX = Math.max(this.w * 0.34, this.w - WALL_W);
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
      const inWallRow = y >= this.wallTop && y <= wallBottom;
      for (let x = 0; x < this.w; x++) {
        const inWall = inWallRow && x >= face;
        if (inWall || y >= this.surfY[x]) {
          this.mask[row + x] = 1;
          if (inWall && y < this.groundTop && y >= this.wallTop) {
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
  resizeTo(nw: number, nh: number, topGap = this.topGap): void {
    if (nw === this.w && nh === this.h && topGap === this.topGap) return;
    const oldMask = this.mask;
    const ow = this.w, oh = this.h;
    const oldWallX = this.wallX, oldGround = this.groundTop, oldTop = this.wallTop;
    // The old silhouette, kept so we can tell a hole the player made from a
    // spot that was simply never solid. Without this the wall's ragged face
    // reads as damage, because its wobble lands differently at the new size.
    const oldFace = this.faceX, oldSurf = this.surfY;
    const oldWallBottom = oldGround + 40;

    this.w = nw; this.h = nh; this.topGap = topGap;
    this.rebuild();

    // Precompute the source column for every destination column.
    const srcX = new Int32Array(nw);
    for (let x = 0; x < nw; x++) {
      srcX[x] = clamp(Math.round(remap(x, this.wallX, nw, oldWallX, ow)), 0, ow - 1);
    }

    // The wall is the same wall at every size, so its rows line up one to one
    // and damage moves across untouched; only the sky above and the floor
    // below change depth, and neither can hold damage.
    const band = Math.max(1, this.groundTop - this.wallTop);
    const oldBand = Math.max(1, oldGround - oldTop);
    for (let y = 0; y < nh; y++) {
      const oy = y < this.wallTop
        ? -1
        : y <= this.groundTop
          ? clamp(Math.round(oldTop + ((y - this.wallTop) / band) * oldBand), 0, oh - 1)
          : clamp(Math.round(oldGround + (y - this.groundTop)), 0, oh - 1);
      if (oy < 0) continue;
      const orow = oy * ow, nrow = y * nw;
      const face = oldFace[oy];
      const inWallRow = oy <= oldWallBottom;
      for (let x = 0; x < nw; x++) {
        const ox = srcX[x];
        if (oldMask[orow + ox] !== 0) continue;
        // Only a pixel that used to be solid counts as destroyed.
        if (!((inWallRow && ox >= face) || oy >= oldSurf[ox])) continue;
        // Only the wall can have been damaged, so only the wall is re-punched.
        const i = nrow + x;
        if (this.isWall[i] === 1) {
          this.isWall[i] = 0;
          this.mask[i] = 0;
          this.wallLeft--;
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

  /**
   * x position of the wall's left face at a given y. Dead straight: the wall is
   * built, not eroded, and every notch in it should be one the player put there.
   */
  private wallFace(_y: number): number {
    return this.wallX;
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
   *
   * Only the wall is destructible. The floor is a fixed stage the fight happens
   * on - it keeps its uneven surface, but nothing digs into it - so both the
   * mask pass and the bitmap pass are confined to the wall's rectangle.
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
    // The destructible region: the wall, from the top of the world down to the
    // floor. Anything outside it is scenery and is left alone.
    const zoneX = Math.max(0, Math.floor(this.wallX));
    const zoneY = Math.max(0, Math.floor(this.groundTop));
    if (maxX < zoneX || minX > this.w || maxY < 0 || minY > zoneY) return result;
    const y0 = clamp(Math.floor(minY), 0, zoneY - 1);
    const y1 = clamp(Math.ceil(maxY), 0, zoneY - 1);

    // Scanline fill into the mask.
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
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
        const sx = clamp(Math.ceil(xs[s]), zoneX, this.w - 1);
        const ex = clamp(Math.floor(xs[s + 1]), zoneX, this.w - 1);
        for (let x = sx; x <= ex; x++) {
          const idx = row + x;
          if (this.isWall[idx] === 1) {
            this.isWall[idx] = 0;
            this.mask[idx] = 0;
            this.wallLeft--;
            result.removed++;
            // Cheap sampling for debris spawn points.
            if ((result.removed & 255) === 0) result.edges.push({ x, y });
          }
        }
      }
    }

    // Same polygon punched out of the visible bitmap, clipped to the wall.
    const c = this.tctx;
    c.save();
    c.beginPath();
    c.rect(zoneX, 0, this.w - zoneX, zoneY);
    c.clip();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.closePath();
    c.fill();
    c.restore();

    // Anything the cut just stranded goes with it.
    if (result.removed > 0) {
      const swept = this.sweepSpecks(minX, minY, maxX, maxY);
      result.removed += swept.removed;
      for (const p of swept.pts) result.edges.push(p);
    }
    return result;
  }

  /**
   * Cuts loose any small fragment left standing on its own around a fresh hole.
   *
   * Carving shapes out of a wall constantly strands little islands - a sliver
   * between two overlapping bites, a chip in the middle of a crater - and
   * leaving them floating there looks broken and makes the last few percent of
   * the wall a scavenger hunt. So after every carve the neighbourhood is walked:
   * anything that no longer reaches the edge of that neighbourhood and is
   * smaller than a fragment worth keeping is knocked out and counted as
   * destroyed. Returns where the pieces fell, for debris.
   */
  private sweepSpecks(x0: number, y0: number, x1: number, y1: number): { pts: Vec2[]; removed: number } {
    const bx0 = clamp(Math.floor(x0) - 4, 0, this.w - 1);
    const by0 = clamp(Math.floor(y0) - 4, 0, this.h - 1);
    const bx1 = clamp(Math.ceil(x1) + 4, 0, this.w - 1);
    const by1 = clamp(Math.ceil(y1) + 4, 0, this.h - 1);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    // A beam's box can be most of the screen; walking that every frame is not
    // worth it, and long thin cuts do not strand islands anyway.
    if (bw < 3 || bh < 3 || bw * bh > 90000) return { pts: [], removed: 0 };

    const seen = new Uint8Array(bw * bh);
    const stack = new Int32Array(bw * bh);
    const comp = new Int32Array(bw * bh);
    const fell: Vec2[] = [];
    let swept = 0;

    for (let sy = 0; sy < bh; sy++) {
      for (let sx = 0; sx < bw; sx++) {
        const si = sy * bw + sx;
        if (seen[si] === 1 || this.isWall[(by0 + sy) * this.w + bx0 + sx] !== 1) continue;
        // Flood this fragment, noting whether it escapes the neighbourhood.
        let top = 0, size = 0, open = false;
        stack[top++] = si;
        seen[si] = 1;
        while (top > 0) {
          const i = stack[--top];
          comp[size++] = i;
          const cx = i % bw, cy = (i / bw) | 0;
          if (cx === 0 || cy === 0 || cx === bw - 1 || cy === bh - 1) open = true;
          if (size > SPECK_LIMIT) { open = true; break; }
          for (let k = 0; k < 4; k++) {
            const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
            const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            const ni = ny * bw + nx;
            if (seen[ni] === 1 || this.isWall[(by0 + ny) * this.w + bx0 + nx] !== 1) continue;
            seen[ni] = 1;
            stack[top++] = ni;
          }
        }
        if (open) continue;

        // Marooned and small: let it go.
        let mx = 0, my = 0;
        for (let k = 0; k < size; k++) {
          const i = comp[k];
          const px = bx0 + (i % bw), py = by0 + ((i / bw) | 0);
          this.isWall[py * this.w + px] = 0;
          this.mask[py * this.w + px] = 0;
          this.wallLeft--;
          swept++;
          mx += px; my += py;
        }
        this.tctx.save();
        this.tctx.globalCompositeOperation = 'destination-out';
        for (let k = 0; k < size; k++) {
          const i = comp[k];
          this.tctx.fillRect(bx0 + (i % bw), by0 + ((i / bw) | 0), 1, 1);
        }
        this.tctx.restore();
        fell.push({ x: mx / size, y: my / size });
      }
    }
    return { pts: fell, removed: swept };
  }

  /** A crater: a circle whose radius wobbles, so nothing looks stamped. */
  carveBlob(x: number, y: number, radius: number, roughness = 0.22, sides = 22): CarveResult {
    const pts: Vec2[] = [];
    const seed = (x * 13 + y * 7) | 0;
    radius *= DAMAGE_SCALE_LEN;
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
    radius *= DAMAGE_SCALE_LEN;
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

  /**
   * The wedge a swung blade actually sweeps: everything between the hilt and
   * the tip, right across the arc.
   *
   * This used to carve a thin crescent out at the tip's radius, which left the
   * wall standing *between* the figure and the bite - as if the blade had
   * teleported past it. Nothing can be cut at arm's length without the stuff in
   * front of it going first, so the sweep is a solid sector now.
   */
  carveSector(cx: number, cy: number, inner: number, outer: number, from: number, to: number): CarveResult {
    const r1 = outer * DAMAGE_SCALE_LEN;
    const r0 = Math.max(0, inner * DAMAGE_SCALE_LEN);
    const pts: Vec2[] = [];
    const steps = Math.max(6, Math.min(28, Math.round(Math.abs(to - from) * 9)));
    const seed = (cx * 5 + cy * 3) | 0;
    for (let i = 0; i <= steps; i++) {
      const a = from + (to - from) * (i / steps);
      // The far edge is ragged: a cut edge is torn, not compass-drawn.
      const r = r1 * (1 + hashNoise(seed + i, 1) * 0.07);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    if (r0 < 2) {
      pts.push({ x: cx, y: cy });
    } else {
      for (let i = steps; i >= 0; i--) {
        const a = from + (to - from) * (i / steps);
        pts.push({ x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0 });
      }
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
