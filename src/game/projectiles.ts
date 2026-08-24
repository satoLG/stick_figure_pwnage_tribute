import { angleDelta, clamp, rand, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Terrain } from './terrain';

export interface Blast {
  radius: number;
  shake: number;
  flash: number;
  debris: number;
  sfx: 'explosion' | 'cannon' | 'fire';
  /** Extra ragged bites around the rim so craters never look like circles. */
  bites: number;
}

export type ProjectileKind =
  | 'rocket' | 'shell' | 'missile' | 'orb' | 'fireball' | 'kunai' | 'shuriken'
  | 'bolt' | 'pellet';

export class Projectile {
  x: number; y: number;
  vx: number; vy: number;
  kind: ProjectileKind;
  gravity: number;
  radius: number;
  life: number;
  blast: Blast;
  spin = 0;
  angle = 0;
  trail: Vec2[] = [];
  dead = false;
  /** Set when the projectile has hit and the game still owes it an explosion. */
  hitAt: Vec2 | null = null;

  /**
   * Guidance. A round with a `target` bends its own velocity towards it at
   * `turn` radians a second instead of flying the line it was launched on -
   * which is what lets ten missiles leave one back and still arrive spread
   * across the whole face of the wall.
   */
  target: Vec2 | null = null;
  private turn = 0;
  private accel = 0;
  private topSpeed = Infinity;
  /** Seconds of dumb flight before the guidance wakes up, so the salvo fans out. */
  private armT = 0;
  /** How hard the flight path snakes; a missile does not fly a ruled line. */
  private weave = 0;
  private weavePhase = rand(TAU);
  /**
   * How many times it may glance off the scenery before it goes off. A round
   * with bounces left reflects about the surface it hit and carries on, which
   * is what makes a discharge skip along the floor towards the wall instead of
   * dying in the dirt at his feet.
   */
  private bounces = 0;
  /**
   * Radius of the bite taken out of whatever it glances off. A discharge that
   * skipped along the wall without marking it read as a stone; every touch
   * should cost the masonry something, even if only a little.
   */
  private bounceBite = 0;
  /** Points it has actually bounced at, for anything that wants to draw them. */
  readonly hops: Vec2[] = [];

  constructor(opts: {
    x: number; y: number; vx: number; vy: number;
    kind: ProjectileKind; gravity?: number; radius?: number; life?: number; blast: Blast;
    target?: Vec2 | null; turn?: number; accel?: number; topSpeed?: number;
    arm?: number; weave?: number; bounces?: number; bounceBite?: number;
  }) {
    this.x = opts.x; this.y = opts.y;
    this.vx = opts.vx; this.vy = opts.vy;
    this.kind = opts.kind;
    this.gravity = opts.gravity ?? 0;
    this.radius = opts.radius ?? 6;
    this.life = opts.life ?? 4;
    this.blast = opts.blast;
    this.target = opts.target ?? null;
    this.turn = opts.turn ?? 0;
    this.accel = opts.accel ?? 0;
    this.topSpeed = opts.topSpeed ?? Infinity;
    this.armT = opts.arm ?? 0;
    this.weave = opts.weave ?? 0;
    this.bounces = opts.bounces ?? 0;
    this.bounceBite = opts.bounceBite ?? 0;
    this.angle = Math.atan2(this.vy, this.vx);
  }

  update(dt: number, terrain: Terrain): void {
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; this.hitAt = { x: this.x, y: this.y }; return; }

    this.vy += this.gravity * dt;
    this.armT = Math.max(0, this.armT - dt);
    if (this.target && this.turn > 0 && this.armT <= 0) this.steer(dt);
    // A rocket steers towards its own velocity, which makes the arc readable.
    this.angle = Math.atan2(this.vy, this.vx);

    const px = this.x, py = this.y;
    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;

    const hit = terrain.raycast(px, py, nx - px, ny - py, Math.hypot(nx - px, ny - py) + 1, 2);
    if (hit) {
      if (this.bounces > 0) { this.bounce(hit, terrain); return; }
      this.x = hit.x; this.y = hit.y;
      this.dead = true;
      this.hitAt = { x: hit.x, y: hit.y };
      return;
    }

    this.x = nx; this.y = ny;
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 22) this.trail.shift();

    if (this.x < -200 || this.x > terrain.w + 200 || this.y > terrain.h + 300 || this.y < -900) {
      this.dead = true;
    }
    this.spin += dt * 14;
  }

  /**
   * One frame of guidance: turn the velocity a little way towards the target
   * and open the throttle. The turn rate is deliberately finite - a missile
   * that snapped onto its aim point would fly a straight line and stop being a
   * missile. What you should see is a curve.
   */
  private steer(dt: number): void {
    const t = this.target!;
    const speed = Math.hypot(this.vx, this.vy) || 1;
    const here = Math.atan2(this.vy, this.vx);
    const want = Math.atan2(t.y - this.y, t.x - this.x)
      // The snake: a slow sideways wander laid over the intercept course.
      + Math.sin(this.life * 9 + this.weavePhase) * this.weave;
    const step = clamp(angleDelta(here, want), -this.turn * dt, this.turn * dt);
    const a = here + step;
    const s = Math.min(this.topSpeed, speed + this.accel * dt);
    this.vx = Math.cos(a) * s;
    this.vy = Math.sin(a) * s;
  }

  /**
   * Glance off whatever it just hit. The surface normal is estimated by asking
   * the terrain which way the empty space lies from the point of contact - a
   * ring of samples, averaged - which is cheap, needs nothing stored on the
   * terrain, and is quite accurate enough for something that is going to hit
   * the wall a moment later anyway.
   */
  private bounce(at: Vec2, terrain: Terrain): void {
    this.bounces--;
    this.hops.push({ x: at.x, y: at.y });
    if (this.bounceBite > 0) {
      terrain.carveBlob(at.x, at.y, this.bounceBite, 0.42, 13, this.bounceBite * 0.9);
    }
    let nx = 0, ny = 0;
    const probe = Math.max(4, this.radius * 1.6);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      if (!terrain.solidAt(at.x + ca * probe, at.y + sa * probe)) { nx += ca; ny += sa; }
    }
    const len = Math.hypot(nx, ny);
    if (len < 1e-4) {
      // Buried: nothing to reflect off, so it simply goes off where it is.
      this.dead = true;
      this.hitAt = { x: at.x, y: at.y };
      return;
    }
    nx /= len; ny /= len;
    const dot = this.vx * nx + this.vy * ny;
    this.vx = (this.vx - 2 * dot * nx) * 0.88;
    this.vy = (this.vy - 2 * dot * ny) * 0.88;
    // Step clear of the surface, or the next frame finds the same pixel again.
    this.x = at.x + nx * (probe + 1);
    this.y = at.y + ny * (probe + 1);
    this.angle = Math.atan2(this.vy, this.vx);
  }

  draw(sk: Sketch): void {
    const c = sk.ctx;
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineCap = 'round';
    c.save();
    c.translate(this.x, this.y);
    c.rotate(this.angle);

    switch (this.kind) {
      case 'rocket': {
        const r = this.radius;
        sk.poly([
          { x: r * 2.1, y: 0 }, { x: r * 0.4, y: -r * 0.75 }, { x: -r * 1.5, y: -r * 0.7 },
          { x: -r * 1.5, y: r * 0.7 }, { x: r * 0.4, y: r * 0.75 },
        ], 2.4, true, 0.5);
        // Fins.
        sk.line({ x: -r * 1.4, y: -r * 0.7 }, { x: -r * 2.4, y: -r * 1.5 }, 2.2, 1, 0.4);
        sk.line({ x: -r * 1.4, y: r * 0.7 }, { x: -r * 2.4, y: r * 1.5 }, 2.2, 1, 0.4);
        // Exhaust plume.
        c.lineWidth = 2;
        sk.burst(-r * 2.2, 0, 4, r * 0.4, r * 2.6, 2, 1.5, Math.PI, 4001);
        break;
      }
      case 'shell': {
        const r = this.radius;
        sk.poly([
          { x: r * 2.4, y: 0 }, { x: r * 0.6, y: -r }, { x: -r * 1.9, y: -r * 0.95 },
          { x: -r * 1.9, y: r * 0.95 }, { x: r * 0.6, y: r },
        ], 2.8, true, 0.6);
        c.lineWidth = 2.4;
        sk.burst(-r * 2.4, 0, 6, r * 0.5, r * 4, 2.4, 1.7, Math.PI, 4101);
        break;
      }
      case 'missile': {
        // A slim guided round: a dart with swept fins and a hot, ragged tail.
        const r = this.radius;
        sk.poly([
          { x: r * 2.6, y: 0 }, { x: r * 0.5, y: -r * 0.62 }, { x: -r * 1.6, y: -r * 0.58 },
          { x: -r * 1.6, y: r * 0.58 }, { x: r * 0.5, y: r * 0.62 },
        ], 2.2, true, 0.45);
        sk.line({ x: -r * 0.9, y: -r * 0.58 }, { x: -r * 2.1, y: -r * 1.5 }, 2, 1, 0.4);
        sk.line({ x: -r * 0.9, y: r * 0.58 }, { x: -r * 2.1, y: r * 1.5 }, 2, 1, 0.4);
        c.lineWidth = 2;
        sk.burst(-r * 2.2, 0, 5, r * 0.5, r * 3.4, 2, 1.2, Math.PI, 4301);
        break;
      }
      case 'orb': {
        // A ball of gathered energy: a solid core with a white bite out of it
        // and a ring of spikes, so it reads as light rather than as a stone.
        const r = this.radius;
        c.rotate(-this.angle);                 // an orb has no nose to point
        c.fillStyle = '#000';
        sk.polyPath(ring(r, 10, this.spin), 1.4);
        c.fill();
        c.fillStyle = '#fff';
        sk.polyPath(ring(r * 0.42, 8, -this.spin * 1.6), 1);
        c.fill();
        c.fillStyle = '#000';
        c.lineWidth = 2.2;
        sk.burst(0, 0, 8, r * 1.25, r * 2.5, 2.2, TAU, 0, 4401);
        break;
      }
      case 'kunai': {
        // A little throwing blade: leaf point, wrapped grip and a ring on the
        // butt. Thrown flat and point first - it does not tumble. A blade
        // turning end over end reads as dropped rather than thrown, and a
        // shinobi does not drop them.
        const r = this.radius;
        sk.poly([
          { x: r * 2.6, y: 0 }, { x: r * 0.6, y: -r * 0.75 }, { x: -r * 0.4, y: -r * 0.5 },
          { x: -r * 0.4, y: r * 0.5 }, { x: r * 0.6, y: r * 0.75 },
        ], 2.2, false, 0.4);
        sk.line({ x: -r * 0.4, y: 0 }, { x: -r * 2.2, y: 0 }, 2.8, 1, 0.4);
        sk.polyPath(ring(r * 0.55, 7, 0).map((p) => ({ x: p.x - r * 2.2, y: p.y })), 0.8);
        c.stroke();
        // A couple of speed lines off the back of it, since it is not spinning.
        sk.line({ x: -r * 2.6, y: -r * 0.5 }, { x: -r * 5.2, y: -r * 0.7 }, 1.6, 1, 0.4);
        sk.line({ x: -r * 2.6, y: r * 0.5 }, { x: -r * 5.4, y: r * 0.8 }, 1.6, 1, 0.4);
        break;
      }
      case 'shuriken': {
        // The big one. Four points round a hole, turning hard - the one thing
        // in his hand that is *supposed* to spin.
        const r = this.radius;
        c.rotate(-this.angle + this.spin * 2.6);
        const star: Vec2[] = [];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const rr = i % 2 === 0 ? r : r * 0.34;
          star.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
        }
        c.fillStyle = '#fff';
        sk.polyPath(star, 1.1);
        c.fill();
        sk.poly(star, 3.4, false, 1.1);
        // The hole in the middle, and an edge line down each point.
        sk.polyPath(ring(r * 0.16, 8, 0), 0.6);
        c.stroke();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU;
          sk.line({ x: Math.cos(a) * r * 0.34, y: Math.sin(a) * r * 0.34 },
            { x: Math.cos(a) * r * 0.9, y: Math.sin(a) * r * 0.9 }, 1.8, 1, 0.4);
        }
        break;
      }
      case 'bolt': {
        // Electricity is never a shape, and it is never a tidy zigzag either:
        // it is a ragged cluster of curved tapered strokes going the way it is
        // going, with a few thrown back the other way.
        const r = this.radius;
        c.rotate(-this.angle);
        const seed = Math.floor(this.spin * 5);
        c.fillStyle = '#000';
        sk.tuftPath(0, 0, 6, r * 0.4, r * 6, 1.1, this.angle, seed, 0.09);
        c.fill();
        sk.tuftPath(0, 0, 4, r * 0.3, r * 2.6, 2.6, this.angle + Math.PI, seed + 31, 0.1);
        c.fill();
        c.rotate(this.angle);
        break;
      }
      case 'fireball': {
        // The reference draws a fireball as a torn white shape over a patch of
        // halftone with sharp licks flicked off it - not a hoop of petals.
        const r = this.radius;
        c.rotate(-this.angle);
        // Halftone bed: poured into the blob as a pattern, so the dots stop on
        // its torn edge instead of on a clipping box.
        sk.ragPath(0, 0, r * 1.25, 15, 0.34, 4205);
        c.fillStyle = '#fff';
        c.fill();
        c.fillStyle = sk.screenTone();
        c.fill();
        // The body of it: paper, rimmed with a pen that lifts.
        sk.inked(() => sk.ragPath(0, 0, r * 0.92, 15, 0.26, 4202), 4.4, 0.4, 4206);
        // Licks off the rim and a tail dragging behind it, all thin and sharp.
        c.fillStyle = '#000';
        sk.tuftPath(0, 0, 20, r * 0.85, r * 1.85, TAU, 0, 4201, 0.085);
        c.fill();
        sk.tuftPath(-r * 0.5, 0, 10, r * 0.6, r * 3.2, 1.7, Math.PI, 4203, 0.09);
        c.fill();
        // One curl inside it, so it has some turn to it.
        c.strokeStyle = '#000';
        c.lineWidth = 2.6;
        sk.polyPath(ring(r * 0.46, 9, this.spin * 0.5), r * 0.09);
        c.stroke();
        break;
      }
      case 'pellet': {
        c.lineWidth = 2.6;
        c.beginPath();
        c.moveTo(-this.radius * 3, 0);
        c.lineTo(this.radius * 1.2, 0);
        c.stroke();
        break;
      }
    }
    c.restore();

    // A summoned orb drags a real trail: a thick white band with an ink edge,
    // so four of them crossing the room read as four lines going somewhere
    // rather than four dots that happen to be moving.
    if (this.kind === 'orb' && this.trail.length > 3) {
      const n = this.trail.length;
      const top: Vec2[] = [], bot: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const p = this.trail[i];
        const q = this.trail[Math.min(n - 1, i + 1)];
        const dx = q.x - p.x || 1, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const w = this.radius * (0.25 + (i / n) * 0.85);
        top.push({ x: p.x - (dy / len) * w, y: p.y + (dx / len) * w });
        bot.push({ x: p.x + (dy / len) * w, y: p.y - (dx / len) * w });
      }
      c.beginPath();
      c.moveTo(top[0].x, top[0].y);
      for (const p of top) c.lineTo(p.x, p.y);
      for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
      c.closePath();
      c.fillStyle = '#fff';
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = 2.8;
      c.stroke();
    }

    // Motion trail: a thinning ribbon behind the projectile.
    if (this.kind !== 'pellet' && this.kind !== 'fireball' && this.kind !== 'orb'
      && this.trail.length > 2) {
      c.beginPath();
      for (let i = 0; i < this.trail.length; i++) {
        const p = this.trail[i];
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.lineWidth = 1.4;
      c.globalAlpha = 0.5;
      c.stroke();
      c.globalAlpha = 1;
    }
  }
}

function ring(r: number, n: number, rot: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const rr = r * (0.75 + ((i * 37) % 11) / 22);
    pts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  return pts;
}

/** Shared crater shape used by every explosive: a main bowl plus ragged bites. */
export function applyBlast(terrain: Terrain, x: number, y: number, blast: Blast): number {
  // An explosion is the one thing that has any business getting *into* the
  // wall rather than scuffing it: a swing takes a fifth of its own width off
  // the face, a charge going off against the stone takes half its radius. It
  // still cannot reach past what is in front of it - the crater eats forward
  // from the face like everything else - it just eats a lot further per go,
  // which is the whole reason to carry a rocket instead of your fists.
  const dig = blast.radius * 0.5;
  let removed = terrain.carveBlob(x, y, blast.radius, 0.26, 26, dig).removed;
  for (let i = 0; i < blast.bites; i++) {
    const a = (i / blast.bites) * TAU + Math.random() * 0.6;
    const d = blast.radius * (0.62 + Math.random() * 0.5);
    const r = blast.radius * (0.2 + Math.random() * 0.3);
    removed += terrain.carveBlob(x + Math.cos(a) * d, y + Math.sin(a) * d, r, 0.4, 12, dig * 0.7).removed;
  }
  return removed;
}

export const BLASTS: Record<string, Blast> = {
  /** The bazooka: one warhead, and a hole you can walk through. */
  bazooka: { radius: 74, shake: 26, flash: 0.7, debris: 52, sfx: 'explosion', bites: 10 },
  /** One of a swarm. Small on its own; ten of them take a wall apart. */
  missile: { radius: 34, shake: 9, flash: 0.24, debris: 20, sfx: 'explosion', bites: 6 },
  /** A bolt off the staff - a bite of light rather than a charge going off. */
  orb: { radius: 31, shake: 7, flash: 0.2, debris: 16, sfx: 'explosion', bites: 5 },
  /** A thrown blade: barely a mark, but there are always two of them. */
  kunai: { radius: 15, shake: 4, flash: 0.08, debris: 7, sfx: 'explosion', bites: 3 },
  // Every third throw. It is not a bigger kunai - it is the reason you counted
  // the first two.
  shuriken: { radius: 62, shake: 15, flash: 0.24, debris: 30, sfx: 'explosion', bites: 6 },
  /** One discharge earthing itself into the masonry. */
  bolt: { radius: 27, shake: 8, flash: 0.26, debris: 13, sfx: 'explosion', bites: 5 },
  /** The fireball, which is most of a doorway on its own. */
  fireball: { radius: 104, shake: 30, flash: 0.85, debris: 70, sfx: 'explosion', bites: 12 },
  /** The warhammer does not explode, but it craters exactly like something did. */
  maul: { radius: 94, shake: 32, flash: 0.5, debris: 68, sfx: 'explosion', bites: 13 },
};

export const clampBlast = (b: Blast, scale: number): Blast => ({
  ...b, radius: b.radius * clamp(scale, 0.3, 2), debris: Math.round(b.debris * scale),
});
