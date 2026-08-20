import { rand, randInt, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Terrain } from './terrain';

type Kind = 'chunk' | 'spark' | 'smoke' | 'flame' | 'shockwave' | 'streak';

interface Particle {
  kind: Kind;
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  spin: number; rot: number;
  gravity: number;
  drag: number;
  verts?: Vec2[];
  bounced?: boolean;
}

/**
 * Everything that flies off the wall. Debris chunks are little irregular black
 * polygons that tumble and bounce off whatever terrain is still standing, which
 * sells the "the wall is really coming apart" feeling more than any shader.
 */
export class Particles {
  private pool: Particle[] = [];
  private max = 900;

  get count(): number { return this.pool.length; }

  clear(): void { this.pool.length = 0; }

  private push(p: Particle): void {
    if (this.pool.length >= this.max) this.pool.shift();
    this.pool.push(p);
  }

  debris(x: number, y: number, count: number, speed: number, dir?: number, spread = TAU): void {
    for (let i = 0; i < count; i++) {
      const a = (dir ?? rand(TAU)) + rand(-spread / 2, spread / 2);
      const s = speed * rand(0.35, 1.25);
      const size = rand(2.2, 8);
      const n = randInt(3, 6);
      const verts: Vec2[] = [];
      for (let k = 0; k < n; k++) {
        const va = (k / n) * TAU + rand(-0.3, 0.3);
        const vr = size * rand(0.55, 1.25);
        verts.push({ x: Math.cos(va) * vr, y: Math.sin(va) * vr });
      }
      this.push({
        kind: 'chunk', x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - rand(20, 140),
        life: rand(0.9, 2.4), maxLife: 2.4, size,
        spin: rand(-14, 14), rot: rand(TAU),
        gravity: 1500, drag: 0.4, verts,
      });
    }
  }

  sparks(x: number, y: number, count: number, speed: number, dir = 0, spread = TAU): void {
    for (let i = 0; i < count; i++) {
      const a = dir + rand(-spread / 2, spread / 2);
      const s = speed * rand(0.4, 1.4);
      this.push({
        kind: 'spark', x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(0.12, 0.34), maxLife: 0.34, size: rand(6, 22),
        spin: 0, rot: a, gravity: 260, drag: 2.2,
      });
    }
  }

  /** Outlined puffs - drawn as open rings so the page still reads as white. */
  smoke(x: number, y: number, count: number, spread: number): void {
    for (let i = 0; i < count; i++) {
      this.push({
        kind: 'smoke', x: x + rand(-spread, spread), y: y + rand(-spread, spread),
        vx: rand(-40, 40), vy: rand(-90, -25),
        life: rand(0.6, 1.5), maxLife: 1.5, size: rand(10, 30),
        spin: rand(-1.5, 1.5), rot: rand(TAU), gravity: -30, drag: 1.1,
      });
    }
  }

  flames(x: number, y: number, count: number, dir: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = dir + rand(-0.4, 0.4);
      this.push({
        kind: 'flame', x, y,
        vx: Math.cos(a) * speed * rand(0.5, 1.3), vy: Math.sin(a) * speed * rand(0.5, 1.3) - rand(10, 70),
        life: rand(0.18, 0.4), maxLife: 0.4, size: rand(7, 19),
        spin: rand(-6, 6), rot: rand(TAU), gravity: -180, drag: 1.6,
      });
    }
  }

  shockwave(x: number, y: number, size: number): void {
    this.push({
      kind: 'shockwave', x, y, vx: 0, vy: 0,
      life: 0.42, maxLife: 0.42, size, spin: 0, rot: rand(TAU), gravity: 0, drag: 0,
    });
  }

  /** The straight speed lines that punctuate every impact in these animations. */
  streaks(x: number, y: number, count: number, dir: number, spread: number, len: number): void {
    for (let i = 0; i < count; i++) {
      const a = dir + rand(-spread / 2, spread / 2);
      this.push({
        kind: 'streak', x, y,
        vx: Math.cos(a) * rand(120, 420), vy: Math.sin(a) * rand(120, 420),
        life: rand(0.1, 0.26), maxLife: 0.26, size: len * rand(0.5, 1.4),
        spin: 0, rot: a, gravity: 0, drag: 1.4,
      });
    }
  }

  update(dt: number, terrain: Terrain): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) { this.pool.splice(i, 1); continue; }
      if (p.kind === 'shockwave') continue;

      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + p.gravity * dt;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;

      if (p.kind === 'chunk') {
        // Bounce debris off whatever is still standing, once, then let it settle.
        if (terrain.solidAt(nx, ny)) {
          if (!p.bounced && Math.hypot(p.vx, p.vy) > 90) {
            p.bounced = true;
            if (terrain.solidAt(p.x, ny)) p.vy = -p.vy * 0.34;
            if (terrain.solidAt(nx, p.y)) p.vx = -p.vx * 0.34;
            p.vx *= 0.7;
            p.spin *= 0.5;
            p.life = Math.min(p.life, 0.9);
          } else {
            p.vx *= 0.2; p.vy = 0; p.spin *= 0.3;
            p.life = Math.min(p.life, 0.45);
          }
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.rot += p.spin * dt;
          continue;
        }
      }
      p.x = nx; p.y = ny;
      p.rot += p.spin * dt;
      if (p.y > terrain.h + 100 || p.x < -120 || p.x > terrain.w + 120) this.pool.splice(i, 1);
    }
  }

  draw(sk: Sketch): void {
    const c = sk.ctx;
    c.save();
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineCap = 'round';
    c.lineJoin = 'round';

    for (const p of this.pool) {
      const t = p.life / p.maxLife;
      switch (p.kind) {
        case 'chunk': {
          c.save();
          c.translate(p.x, p.y);
          c.rotate(p.rot);
          const s = 0.55 + t * 0.45;
          c.beginPath();
          const vs = p.verts!;
          c.moveTo(vs[0].x * s, vs[0].y * s);
          for (let i = 1; i < vs.length; i++) c.lineTo(vs[i].x * s, vs[i].y * s);
          c.closePath();
          c.fill();
          c.restore();
          break;
        }
        case 'spark': {
          const l = p.size * t;
          c.lineWidth = 1.6;
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(p.x - Math.cos(p.rot) * l, p.y - Math.sin(p.rot) * l);
          c.stroke();
          break;
        }
        case 'streak': {
          const l = p.size * t;
          c.lineWidth = 2.4 * t + 0.8;
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(p.x - Math.cos(p.rot) * l, p.y - Math.sin(p.rot) * l);
          c.stroke();
          break;
        }
        case 'smoke': {
          const r = p.size * (1.6 - t);
          c.lineWidth = 1.5 * t + 0.4;
          sk.polyPath(ringPts(p.x, p.y, r, p.rot), 1.6);
          c.stroke();
          break;
        }
        case 'flame': {
          // A flame tongue: a teardrop outline pointing along its velocity.
          const r = p.size * (0.4 + t * 0.9);
          const a = Math.atan2(p.vy, p.vx);
          c.lineWidth = 1.8;
          c.beginPath();
          c.moveTo(p.x + Math.cos(a) * r * 1.9, p.y + Math.sin(a) * r * 1.9);
          c.quadraticCurveTo(
            p.x + Math.cos(a + 2.1) * r, p.y + Math.sin(a + 2.1) * r,
            p.x - Math.cos(a) * r * 0.7, p.y - Math.sin(a) * r * 0.7,
          );
          c.quadraticCurveTo(
            p.x + Math.cos(a - 2.1) * r, p.y + Math.sin(a - 2.1) * r,
            p.x + Math.cos(a) * r * 1.9, p.y + Math.sin(a) * r * 1.9,
          );
          c.stroke();
          break;
        }
        case 'shockwave': {
          const k = 1 - t;
          const r = p.size * (0.15 + k * 1.05);
          c.lineWidth = 6 * t + 0.6;
          sk.polyPath(ringPts(p.x, p.y, r, p.rot, 18), 3);
          c.stroke();
          break;
        }
      }
    }
    c.restore();
  }
}

function ringPts(x: number, y: number, r: number, rot: number, n = 12): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  return pts;
}
