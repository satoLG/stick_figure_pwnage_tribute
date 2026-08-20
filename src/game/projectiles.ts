import { clamp, TAU, type Vec2 } from '../core/math';
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

export type ProjectileKind = 'rocket' | 'shell' | 'fireball' | 'pellet';

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

  constructor(opts: {
    x: number; y: number; vx: number; vy: number;
    kind: ProjectileKind; gravity?: number; radius?: number; life?: number; blast: Blast;
  }) {
    this.x = opts.x; this.y = opts.y;
    this.vx = opts.vx; this.vy = opts.vy;
    this.kind = opts.kind;
    this.gravity = opts.gravity ?? 0;
    this.radius = opts.radius ?? 6;
    this.life = opts.life ?? 4;
    this.blast = opts.blast;
    this.angle = Math.atan2(this.vy, this.vx);
  }

  update(dt: number, terrain: Terrain): void {
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; this.hitAt = { x: this.x, y: this.y }; return; }

    this.vy += this.gravity * dt;
    // A rocket steers towards its own velocity, which makes the arc readable.
    this.angle = Math.atan2(this.vy, this.vx);

    const px = this.x, py = this.y;
    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;

    const hit = terrain.raycast(px, py, nx - px, ny - py, Math.hypot(nx - px, ny - py) + 1, 2);
    if (hit) {
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
      case 'fireball': {
        const r = this.radius;
        c.lineWidth = 2.4;
        sk.polyPath(ring(r * 1.05, 9, this.spin), 2.2);
        c.stroke();
        sk.burst(0, 0, 7, r * 1.1, r * 2.4, 2, TAU, 0, 4201);
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

    // Motion trail: a thinning ribbon behind the projectile.
    if (this.kind !== 'pellet' && this.trail.length > 2) {
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
  let removed = terrain.carveBlob(x, y, blast.radius, 0.26, 26).removed;
  for (let i = 0; i < blast.bites; i++) {
    const a = (i / blast.bites) * TAU + Math.random() * 0.6;
    const d = blast.radius * (0.62 + Math.random() * 0.5);
    const r = blast.radius * (0.2 + Math.random() * 0.3);
    removed += terrain.carveBlob(x + Math.cos(a) * d, y + Math.sin(a) * d, r, 0.4, 12).removed;
  }
  return removed;
}

export const BLASTS: Record<string, Blast> = {
  rocket: { radius: 62, shake: 16, flash: 0.5, debris: 34, sfx: 'explosion', bites: 7 },
  cannon: { radius: 104, shake: 30, flash: 0.9, debris: 60, sfx: 'cannon', bites: 10 },
  /** The warhammer does not explode, but it craters exactly like something did. */
  maul: { radius: 86, shake: 30, flash: 0.5, debris: 50, sfx: 'explosion', bites: 11 },
  fireball: { radius: 34, shake: 6, flash: 0.18, debris: 14, sfx: 'fire', bites: 5 },
};

export const clampBlast = (b: Blast, scale: number): Blast => ({
  ...b, radius: b.radius * clamp(scale, 0.3, 2), debris: Math.round(b.debris * scale),
});
