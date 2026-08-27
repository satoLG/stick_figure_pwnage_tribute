import { hashNoise, quadPoint, type Vec2 } from './math';

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
   * A curved tapered ribbon: a stroke with real width that swells along its
   * length and comes to a point at both ends, bent through a control point.
   *
   * This is the shape fluid things are drawn with in the reference - wind,
   * smoke, the curl of a slash - and it is why they read as brushed rather
   * than ruled. `fat` moves the widest point along the curve, so a ribbon can
   * be a leaf (0.5), a comma (0.25) or a tail (0.8). Traces only; the caller
   * fills and strokes.
   */
  ribbonPath(a: Vec2, ctrl: Vec2, b: Vec2, width: number, fat = 0.5, taper = 0.7): void {
    this.ctx.beginPath();
    this.ribbonInto(a, ctrl, b, width, fat, taper);
  }

  /** The same, appended to a path already open - for fans of them. */
  private ribbonInto(a: Vec2, ctrl: Vec2, b: Vec2, width: number, fat: number, taper: number): void {
    const c = this.ctx;
    const N = 14;
    const top: Vec2[] = [], bot: Vec2[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = quadPoint(a, ctrl, b, t);
      const q = quadPoint(a, ctrl, b, Math.min(1, t + 0.03));
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      // Remapped so the widest point sits at `fat` rather than the middle.
      const u = t < fat ? (t / Math.max(1e-3, fat)) * 0.5
        : 0.5 + ((t - fat) / Math.max(1e-3, 1 - fat)) * 0.5;
      const w = width * 0.5 * Math.pow(Math.sin(u * Math.PI), taper) + 0.35;
      top.push({ x: p.x + nx * w, y: p.y + ny * w });
      bot.push({ x: p.x - nx * w, y: p.y - ny * w });
    }
    c.moveTo(top[0].x, top[0].y);
    for (const p of top) c.lineTo(p.x, p.y);
    for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
    c.closePath();
  }

  /**
   * The feathered fan the reference draws raw energy with: tapered slivers
   * that *curve* as they go, at wildly uneven lengths, clustered rather than
   * evenly spaced. `blastPath` throws straight splinters; this one is the same
   * idea with a bend in every stroke, which is what separates electricity and
   * wind from shrapnel. Traces only.
   */
  sparkPath(
    cx: number, cy: number, count: number, r0: number, r1: number, width: number,
    spread = Math.PI * 2, dir = 0, seed = 0, curl = 0.42,
  ): void {
    const c = this.ctx;
    const step = spread / Math.max(1, count);
    c.beginPath();
    for (let i = 0; i < count; i++) {
      // Clustered: the jitter is a good fraction of the gap, so strokes crowd
      // together in threes and fours and leave paper between the clusters.
      const a = dir + (count === 1 ? 0 : (i / (count - 1) - 0.5) * spread)
        + hashNoise(seed + i, this.boil) * step * 1.1;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      const l0 = r0 * (0.4 + Math.abs(hashNoise(seed + i * 3, this.boil)) * 1.1);
      const l1 = l0 + (r1 - r0) * (0.2 + Math.abs(hashNoise(seed + i * 5, this.boil + 2)) * 1.6);
      const w = width * (0.35 + Math.abs(hashNoise(seed + i * 7, this.boil + 4)) * 1.5);
      const bend = hashNoise(seed + i * 11, this.boil + 6) * (l1 - l0) * curl;
      const p = (d: number, o: number): Vec2 => ({ x: cx + ca * d + nx * o, y: cy + sa * d + ny * o });
      this.ribbonInto(p(l0, 0), p((l0 + l1) * 0.5, bend), p(l1, bend * 0.35), w, 0.42, 0.75);
    }
  }

  /**
   * A polyline given real width: the outline of a run of segments as one closed
   * contour, swelling from `w0` at the start to `w1` at the end.
   *
   * Stroking a jagged path gives you a rope of even thickness; this gives you a
   * *shape*, which is the only way a trail can share a belly with the spikes
   * thrown off it and still read as one drawing. Traces only.
   */
  trailPath(pts: readonly Vec2[], w0: number, w1 = w0): void {
    const c = this.ctx;
    const n = pts.length;
    if (n < 2) return;
    const top: Vec2[] = [], bot: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l;
      const w = (w0 + (w1 - w0) * (i / (n - 1))) * 0.5;
      top.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
      bot.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
    }
    c.beginPath();
    c.moveTo(top[0].x, top[0].y);
    for (const p of top) c.lineTo(p.x, p.y);
    for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
    c.closePath();
  }

  /**
   * Several shapes drawn as ONE.
   *
   * `inked` fills a path white and walks a pen round it, which is right for a
   * single form and wrong the moment two of them touch: every overlap gets its
   * own contour and what should have been one gesture turns into a pile of
   * outlined pieces. That is exactly what a bolt of lightning must not look
   * like - the trail, the kinks it throws off and the burst where it earths are
   * one connected thing with ink only round the *outside* of the lot.
   *
   * So the whole group is laid down fat and solid black first, and then every
   * shape is filled white on top of it. What survives is a thin even rim round
   * the union and unbroken white through the middle, with no seam anywhere two
   * of them cross. Each shape is filled on its own pass, so their winding
   * directions never cancel one another out.
   */
  inkedUnion(traces: readonly (() => void)[], rim = 3): void {
    const c = this.ctx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.fillStyle = '#000';
    c.strokeStyle = '#000';
    c.lineWidth = rim * 2;
    for (const t of traces) { t(); c.fill(); c.stroke(); }
    c.fillStyle = '#fff';
    for (const t of traces) { t(); c.fill(); }
    c.restore();
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

  /**
   * The mark the reference actually leaves where something hits.
   *
   * Not a starburst and not a fan of leaves: a dense little tuft of thin,
   * sharp, solid-black slivers flicked out of the point of contact, at wildly
   * uneven lengths, each one bent a touch off its own axis. Aspect ratio is the
   * whole thing - a spike is eight or ten times as long as it is wide, and the
   * moment they get fat they stop being ink and start being foliage.
   *
   * Traces only; fill it black.
   */
  tuftPath(
    cx: number, cy: number, count: number, r0: number, r1: number,
    spread = Math.PI * 2, dir = 0, seed = 0, thin = 0.055,
  ): void {
    const c = this.ctx;
    const step = spread / Math.max(1, count);
    c.beginPath();
    for (let i = 0; i < count; i++) {
      const a = dir + (count === 1 ? 0 : (i / (count - 1) - 0.5) * spread)
        + hashNoise(seed + i, this.boil) * step * 1.3;
      // Lengths spread over more than a factor of three, biased short, so the
      // cluster has a handful of long ones sticking out of a lot of stubs.
      const g = Math.abs(hashNoise(seed + i * 3, this.boil + 1));
      const l0 = r0 * (0.25 + Math.abs(hashNoise(seed + i * 5, this.boil)) * 1.1);
      const l1 = l0 + (r1 - r0) * (0.08 + g * g * g * 2.2);
      const len = Math.max(2, l1 - l0);
      const w = len * thin + 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      const bend = hashNoise(seed + i * 7, this.boil + 2) * len * 0.2;
      const p = (d: number, o: number): Vec2 => ({ x: cx + ca * d + nx * o, y: cy + sa * d + ny * o });
      const tip = p(l1, bend);
      const m1 = p(l0 + len * 0.45, bend * 0.4 + w * 0.5);
      const m2 = p(l0 + len * 0.45, bend * 0.4 - w * 0.5);
      c.moveTo(cx + ca * l0 + nx * w, cy + sa * l0 + ny * w);
      c.quadraticCurveTo(m1.x, m1.y, tip.x, tip.y);
      c.quadraticCurveTo(m2.x, m2.y, cx + ca * l0 - nx * w, cy + sa * l0 - ny * w);
      c.closePath();
    }
  }

  /**
   * The mark a blow leaves, as ONE shape.
   *
   * `tuftPath` traces a spike per subpath, which is right when they are meant
   * to be flicks of solid ink - but the moment you want the white-bellied
   * treatment on them it gives you a separate outline round every single
   * spike, and a landed punch turns into a bag of little leaves. This traces
   * the same cluster as a single closed zigzag: tips at wildly uneven lengths,
   * valleys pulled back in near the point of contact, one continuous contour
   * round the lot. Fill it white and stroke it once.
   *
   * A partial `spread` closes back through the centre, so a fan is still one
   * shape rather than an open ribbon.
   */
  starPath(
    cx: number, cy: number, count: number, r0: number, r1: number,
    spread = Math.PI * 2, dir = 0, seed = 0,
  ): void {
    const full = spread >= Math.PI * 2 - 0.01;
    const n = Math.max(3, count);
    const pts: Vec2[] = [];
    const span = full ? Math.PI * 2 : spread;
    for (let i = 0; i < n; i++) {
      const t = full ? i / n : i / (n - 1);
      const a = dir + (full ? t * span : (t - 0.5) * span);
      const half = span / (full ? n * 2 : (n - 1) * 2);
      // The valley leading into this spike, then the spike itself. Lengths run
      // over more than a factor of three and lean short, so a handful stick
      // right out of a lot of stubs.
      const g = Math.abs(hashNoise(seed + i * 3, this.boil));
      const vr = r0 * (0.7 + Math.abs(hashNoise(seed + i * 7, this.boil + 1)) * 0.9);
      const tr = r0 + (r1 - r0) * (0.14 + g * g * 1.5);
      const va = a - half * (0.75 + hashNoise(seed + i * 11, this.boil) * 0.3);
      const ta = a + hashNoise(seed + i * 5, this.boil + 2) * half * 0.5;
      pts.push({ x: cx + Math.cos(va) * vr, y: cy + Math.sin(va) * vr });
      pts.push({ x: cx + Math.cos(ta) * tr, y: cy + Math.sin(ta) * tr });
    }
    if (!full) pts.push({ x: cx, y: cy });
    this.polyPath(pts, 0.9);
  }

  /**
   * The reference's only grey, as a fill you can pour into any shape.
   *
   * `halftone` below shades whatever is clipped, which is fine for a box but
   * fragile for anything else; this hands back a tiled dot screen you set as
   * `fillStyle` and then fill a path with, so the dots stop exactly at the
   * outline with no clipping involved at all. Built once and kept.
   */
  private tone: CanvasPattern | null = null;
  screenTone(): CanvasPattern | string {
    if (this.tone) return this.tone;
    const t = document.createElement('canvas');
    t.width = 6; t.height = 6;
    const g = t.getContext('2d');
    if (!g) return '#000';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 6, 6);
    g.fillStyle = '#000';
    g.beginPath(); g.arc(1.5, 1.5, 1.45, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(4.5, 4.5, 1.45, 0, Math.PI * 2); g.fill();
    this.tone = this.ctx.createPattern(t, 'repeat');
    return this.tone ?? '#000';
  }

  /**
   * The reference's only grey, and it is not grey: it is a screen of dots.
   * Fills whatever region is currently clipped, so the caller clips to a shape
   * and calls this to shade it.
   */
  halftone(x0: number, y0: number, x1: number, y1: number, step = 5, r = 1.35): void {
    const c = this.ctx;
    c.beginPath();
    let row = 0;
    for (let y = y0; y < y1; y += step, row++) {
      const off = (row % 2) * step * 0.5;
      for (let x = x0 + off; x < x1; x += step) {
        c.moveTo(x + r, y);
        c.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    c.fill();
  }

  /**
   * The mark this whole film is drawn with.
   *
   * Nothing in the reference is a solid black blob. Every effect - a punch
   * drag, a gout of flame, a blade of wind, the fan off an impact - is a
   * *thick* shape with a WHITE belly and a black rim, and the rim is only ever
   * drawn part of the way round. The pen goes down, follows an edge for a
   * while, lifts, picks up again further along. That unclosed rim is the
   * whole reason the reference reads as fast and hand-drawn rather than as
   * shapes someone filled in: the eye completes the form itself.
   *
   * `trace` lays down the path (any of the *Path helpers below); this fills it
   * white and then walks a broken pen round it. `broken` is how much of the
   * rim is *missing* - 0 draws the full outline, 0.6 leaves well over half of
   * it to the imagination.
   */
  inked(trace: () => void, rim = 2.4, broken = 0.5, seed = 0): void {
    const c = this.ctx;
    trace();
    c.fillStyle = '#fff';
    c.fill();
    if (rim <= 0) return;
    c.strokeStyle = '#000';
    this.brokenPen(rim, broken, seed);
    c.stroke();
    c.setLineDash([]);
  }

  /**
   * Set the pen up to draw only part of whatever is stroked next: long
   * confident runs of ink with paper between them, starting at a different
   * point of the outline every drawing so the gaps never sit still.
   */
  brokenPen(width: number, broken = 0.5, seed = 0): void {
    const c = this.ctx;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (broken <= 0) { c.setLineDash([]); return; }
    const on = 22 + Math.abs(hashNoise(seed, this.boil)) * 90;
    c.setLineDash([on, on * (broken * 1.6)]);
    // Where the pen happens to be down when it meets the shape.
    c.lineDashOffset = hashNoise(seed + 977, this.boil) * 120;
  }

  /** Rim an already-traced path without refilling it. */
  rim(width: number, broken = 0.5, seed = 0): void {
    const c = this.ctx;
    c.strokeStyle = '#000';
    this.brokenPen(width, broken, seed);
    c.stroke();
    c.setLineDash([]);
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
