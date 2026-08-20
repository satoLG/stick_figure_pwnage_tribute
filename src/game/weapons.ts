import type { SfxName } from '../core/audio';
import { clamp, hashNoise, rand, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Particles } from './particles';
import { applyBlast, BLASTS, Projectile } from './projectiles';
import { ARM_LEN, type HandTargets, type Stickman } from './stickman';
import type { Terrain } from './terrain';

export interface WeaponCtx {
  sm: Stickman;
  terrain: Terrain;
  particles: Particles;
  projectiles: Projectile[];
  aimPoint: Vec2;
  dt: number;
  time: number;
  shake(a: number): void;
  flash(a: number): void;
  invert(seconds: number): void;
  sfx(name: SfxName, pitch?: number): void;
}

/**
 * Where a hand sits: `fwd` units in front of the sternum along the aim line,
 * `side` units perpendicular to it. The arm is ARM_LEN long, so anything much
 * under ~26 folds the elbow into a zigzag - keep held poses in the 28..46 band.
 */
function grip(ctx: WeaponCtx, fwd: number, side = 0): Vec2 {
  const { chest } = ctx.sm.pose;
  const a = ctx.sm.pose.aim;
  const c = Math.cos(a), s = Math.sin(a);
  const d = clamp(fwd, -14, ARM_LEN * 0.92);
  return { x: chest.x + c * d - s * side, y: chest.y + s * d + c * side + 2 };
}

/** Debris, sparks and speed lines wherever something bites into the wall. */
function impact(ctx: WeaponCtx, x: number, y: number, dir: number, power: number): void {
  ctx.particles.debris(x, y, Math.round(4 + power * 16), 90 + power * 320, dir + Math.PI, 2.4);
  ctx.particles.sparks(x, y, Math.round(3 + power * 9), 140 + power * 320, dir + Math.PI, 2.0);
  ctx.particles.streaks(x, y, Math.round(2 + power * 6), dir + Math.PI, 1.9, 16 + power * 40);
}

export abstract class Weapon {
  abstract readonly id: number;
  abstract readonly name: string;
  abstract readonly tagline: string;

  /** Held-trigger weapons keep firing; the rest need a fresh click. */
  auto = false;
  cooldown = 0.3;
  /** Seconds of hold before a charged weapon will release. 0 = fires instantly. */
  chargeTime = 0;

  protected timer = 0;
  charge = 0;
  /** Attack animation clock, counting down. */
  protected anim = 0;
  protected animLen = 0.2;
  protected swap = 1;
  private chargeSfx = false;

  /** Fraction 0..1 through the current attack animation, 0 when idle. */
  protected get t(): number {
    return this.anim > 0 ? 1 - this.anim / this.animLen : 0;
  }
  get busy(): boolean { return this.anim > 0; }
  get ready(): boolean { return this.timer <= 0; }
  /** Drives the cooldown ring in the HUD. */
  get cooldownFrac(): number { return this.cooldown > 0 ? clamp(this.timer / this.cooldown, 0, 1) : 0; }

  onEquip(): void { this.charge = 0; this.anim = 0; this.timer = Math.min(this.timer, 0.12); }
  onUnequip(_ctx: WeaponCtx): void { this.charge = 0; this.chargeSfx = false; }

  update(ctx: WeaponCtx, held: boolean, pressed: boolean): void {
    this.timer -= ctx.dt;
    if (this.anim > 0) this.anim = Math.max(0, this.anim - ctx.dt);
    this.tick(ctx, held);

    if (this.chargeTime > 0) {
      if (held && this.timer <= 0) {
        if (this.charge === 0 && !this.chargeSfx) { ctx.sfx('charge'); this.chargeSfx = true; }
        this.charge = Math.min(1, this.charge + ctx.dt / this.chargeTime);
      } else if (this.charge > 0) {
        this.release(ctx, this.charge);
        this.timer = this.cooldown;
        this.charge = 0;
        this.chargeSfx = false;
      }
      return;
    }

    const wants = this.auto ? held : pressed;
    if (wants && this.timer <= 0) {
      this.timer = this.cooldown;
      this.anim = this.animLen;
      this.swap = -this.swap;
      this.release(ctx, 1);
    }
  }

  /** Per-frame hook for weapons with continuous effects (fire, beam). */
  protected tick(_ctx: WeaponCtx, _held: boolean): void {}

  /** Fires. `power` is the charge fraction for charged weapons, else 1. */
  protected abstract release(ctx: WeaponCtx, power: number): void;

  /** Where the hands should go this frame. */
  abstract hands(ctx: WeaponCtx): HandTargets | null;

  /** Draws the weapon itself, in world space, after the figure. */
  abstract draw(sk: Sketch, ctx: WeaponCtx): void;

  /** Small emblem for the selection wheel; draw inside a box of `s` units. */
  abstract icon(sk: Sketch, x: number, y: number, s: number): void;

  /** Shared: a hitscan shot that bores a hole and a short tunnel. */
  protected hitscan(ctx: WeaponCtx, from: Vec2, angle: number, range: number, holeR: number, depth: number): boolean {
    const hit = ctx.terrain.raycast(from.x, from.y, Math.cos(angle), Math.sin(angle), range, 3);
    if (!hit) return false;
    ctx.terrain.carveBlob(hit.x, hit.y, holeR, 0.34, 14);
    // The tunnel behind the entry wound is what makes repeated shots eat through.
    ctx.terrain.carveCapsule(
      hit.x, hit.y,
      hit.x + Math.cos(angle) * depth, hit.y + Math.sin(angle) * depth,
      holeR * 0.72, 0.3,
    );
    impact(ctx, hit.x, hit.y, angle, holeR / 26);
    return true;
  }

  /** Shared: muzzle flash drawn as a star of ink at the barrel tip. */
  protected muzzle(sk: Sketch, x: number, y: number, size: number, seed: number): void {
    const c = sk.ctx;
    c.lineWidth = 2.6;
    sk.burst(x, y, 7, size * 0.25, size, 2.6, TAU, 0, seed);
    sk.poly([
      { x: x + size * 0.9, y }, { x: x + size * 0.15, y: y - size * 0.5 },
      { x: x - size * 0.2, y }, { x: x + size * 0.15, y: y + size * 0.5 },
    ], 2.2, true, 0.8);
  }
}

// ---------------------------------------------------------------------------
// 1. FISTS
// ---------------------------------------------------------------------------
export class Fists extends Weapon {
  readonly id = 1;
  readonly name = 'BARE HANDS';
  readonly tagline = 'no gear, pure attitude';
  override cooldown = 0.19;
  override auto = true;
  private struck = false;

  constructor() { super(); this.animLen = 0.19; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    ctx.sfx('swing', rand(0.9, 1.15));
  }

  protected override tick(ctx: WeaponCtx): void {
    if (this.anim > 0 && !this.struck && this.t > 0.42) {
      this.struck = true;
      const a = ctx.sm.pose.aim;
      const from = grip(ctx, 6);
      const hit = ctx.terrain.raycast(from.x, from.y, Math.cos(a), Math.sin(a), 74, 3);
      if (hit) {
        ctx.terrain.carveBlob(hit.x, hit.y, 25, 0.35, 16);
        ctx.terrain.carveCapsule(hit.x, hit.y, hit.x + Math.cos(a) * 16, hit.y + Math.sin(a) * 16, 15, 0.3);
        impact(ctx, hit.x, hit.y, a, 0.55);
        ctx.sfx('punch', rand(0.9, 1.1));
        ctx.shake(5);
        ctx.sm.applyRecoil(0.35, a, 40);
      }
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    // A punch is an ease-out thrust followed by a slower recovery.
    const t = this.t;
    const push = this.anim > 0 ? (t < 0.45 ? Math.pow(t / 0.45, 0.55) : 1 - (t - 0.45) / 0.55) : 0;
    const lead = this.swap > 0;
    const ext = 33 + push * 13;
    const back = 30 - push * 4;
    const main = grip(ctx, lead ? ext : back, lead ? -4 : 12);
    const off = grip(ctx, lead ? back : ext, lead ? 14 : -4);
    return { main, off };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    if (this.anim > 0 && this.t < 0.6) {
      const h = this.swap > 0 ? ctx.sm.pose.handR : ctx.sm.pose.handL;
      const a = ctx.sm.pose.aim;
      sk.ctx.lineWidth = 2.2;
      sk.burst(h.x, h.y, 4, 8, 22, 2.2, 1.5, a + Math.PI, 77);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    c.lineWidth = 2.2;
    sk.poly([
      { x: x - s * 0.3, y: y - s * 0.3 }, { x: x + s * 0.28, y: y - s * 0.34 },
      { x: x + s * 0.34, y: y + s * 0.22 }, { x: x - s * 0.26, y: y + s * 0.3 },
    ], 2.2, false, 0.6);
    sk.burst(x + s * 0.42, y, 3, s * 0.15, s * 0.5, 2, 1.6, 0, 5);
  }
}

// ---------------------------------------------------------------------------
// 2. KATANA
// ---------------------------------------------------------------------------
export class Katana extends Weapon {
  readonly id = 2;
  readonly name = 'KATANA';
  readonly tagline = 'one clean crescent';
  override cooldown = 0.34;
  override auto = true;
  private struck = false;
  private readonly len = 84;

  constructor() { super(); this.animLen = 0.3; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    ctx.sfx('swing', rand(0.85, 1.05));
  }

  private bladeAngle(ctx: WeaponCtx): number {
    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    if (this.anim <= 0) return a + 0.95 * f * this.swap * 0.4 - 0.5 * f;
    const t = this.t;
    // Wind up, then a hard fast sweep through the target arc.
    const e = t < 0.28 ? -0.5 * (t / 0.28) : Math.pow((t - 0.28) / 0.72, 0.45);
    return a + this.swap * f * (1.45 - e * 2.9) * (t < 0.28 ? 1 : 1);
  }

  protected override tick(ctx: WeaponCtx): void {
    if (this.anim > 0 && !this.struck && this.t > 0.42) {
      this.struck = true;
      const a = ctx.sm.pose.aim;
      const f = ctx.sm.facing;
      const h = grip(ctx, 33);
      const from = a + this.swap * f * 1.15;
      const to = a - this.swap * f * 1.15;
      // The cut is a crescent centred on the hand, so it bites deeper in the
      // middle of the swing and tapers at both ends, like a real slash.
      const res = ctx.terrain.carveArc(h.x, h.y, this.len * 0.72, from, to, 26);
      if (res.removed > 0) {
        ctx.sfx('slash', rand(0.9, 1.15));
        ctx.shake(7);
        const tip = { x: h.x + Math.cos(a) * this.len * 0.8, y: h.y + Math.sin(a) * this.len * 0.8 };
        impact(ctx, tip.x, tip.y, a, 0.8);
        ctx.sm.applyRecoil(0.3, a, 25);
      }
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const t = this.t;
    const fwd = this.anim > 0 ? 30 + Math.sin(t * Math.PI) * 14 : 33;
    const side = this.anim > 0 ? this.swap * ctx.sm.facing * (1 - t) * 14 : 6;
    return { main: grip(ctx, fwd, side), off: grip(ctx, fwd - 5, side + 13) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ba = this.bladeAngle(ctx);
    const ca = Math.cos(ba), sa = Math.sin(ba);

    // Motion trail: the swing leaves a fan of afterimages behind the blade.
    if (this.anim > 0) {
      const f = ctx.sm.facing;
      c.globalAlpha = 0.35;
      c.lineWidth = 2;
      for (let i = 1; i <= 4; i++) {
        const back = ba + this.swap * f * i * 0.19;
        c.beginPath();
        c.moveTo(h.x + Math.cos(back) * 16, h.y + Math.sin(back) * 16);
        c.lineTo(h.x + Math.cos(back) * this.len, h.y + Math.sin(back) * this.len);
        c.stroke();
      }
      c.globalAlpha = 1;
      // The crescent arc itself.
      c.lineWidth = 2.6;
      c.beginPath();
      const r = this.len * 0.92;
      const from = ba + this.swap * f * 0.9;
      c.arc(h.x, h.y, r, Math.min(from, ba), Math.max(from, ba));
      c.stroke();
    }

    // Guard, grip and blade.
    c.lineWidth = 3;
    const guard = { x: h.x + ca * 8, y: h.y + sa * 8 };
    sk.line({ x: h.x - ca * 10, y: h.y - sa * 10 }, guard, 4.2, 1, 0.5);
    sk.line({ x: guard.x - sa * 9, y: guard.y + ca * 9 }, { x: guard.x + sa * 9, y: guard.y - ca * 9 }, 3.2, 1, 0.5);
    // Slightly curved single-edged blade.
    const tip = { x: h.x + ca * this.len, y: h.y + sa * this.len };
    const bow = { x: (guard.x + tip.x) / 2 - sa * 7, y: (guard.y + tip.y) / 2 + ca * 7 };
    sk.curve(guard, bow, tip, 3.4, 0.5);
    sk.line({ x: guard.x - sa * 3.5, y: guard.y + ca * 3.5 }, { x: tip.x, y: tip.y }, 1.6, 2, 0.5);
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.line({ x: x - s * 0.42, y: y + s * 0.38 }, { x: x + s * 0.42, y: y - s * 0.4 }, 2.6, 2, 0.5);
    sk.line({ x: x - s * 0.34, y: y + s * 0.14 }, { x: x - s * 0.08, y: y + s * 0.4 }, 2.2, 1, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 3. TWIN DAGGERS
// ---------------------------------------------------------------------------
export class Daggers extends Weapon {
  readonly id = 3;
  readonly name = 'TWIN DAGGERS';
  readonly tagline = 'fast, shallow, relentless';
  override cooldown = 0.115;
  override auto = true;
  private struck = false;

  constructor() { super(); this.animLen = 0.115; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    ctx.sfx('stab', rand(1.0, 1.35));
  }

  protected override tick(ctx: WeaponCtx): void {
    if (this.anim > 0 && !this.struck && this.t > 0.35) {
      this.struck = true;
      const a = ctx.sm.pose.aim + rand(-0.05, 0.05);
      const from = grip(ctx, 30);
      const hit = ctx.terrain.raycast(from.x, from.y, Math.cos(a), Math.sin(a), 78, 3);
      if (hit) {
        ctx.terrain.carveCapsule(hit.x, hit.y, hit.x + Math.cos(a) * 30, hit.y + Math.sin(a) * 30, 9.5, 0.35);
        impact(ctx, hit.x, hit.y, a, 0.3);
        ctx.shake(3);
      }
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const t = this.t;
    const push = this.anim > 0 ? (t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6) : 0;
    const lead = this.swap > 0;
    const a = 33 + push * 13, b = 28 - push * 2;
    return {
      main: grip(ctx, lead ? a : b, lead ? -4 : 13),
      off: grip(ctx, lead ? b : a, lead ? 15 : -4),
    };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const a = ctx.sm.pose.aim;
    for (const h of [ctx.sm.pose.handL, ctx.sm.pose.handR]) {
      const ca = Math.cos(a), sa = Math.sin(a);
      sk.poly([
        { x: h.x + ca * 40, y: h.y + sa * 40 },
        { x: h.x + ca * 10 - sa * 5, y: h.y + sa * 10 + ca * 5 },
        { x: h.x + ca * 10 + sa * 5, y: h.y + sa * 10 - ca * 5 },
      ], 2.6, false, 0.5);
      sk.line({ x: h.x - ca * 7 - sa * 6, y: h.y - sa * 7 + ca * 6 },
        { x: h.x - ca * 7 + sa * 6, y: h.y - sa * 7 - ca * 6 }, 2.6, 1, 0.4);
    }
    if (this.anim > 0 && this.t < 0.5) {
      const h = this.swap > 0 ? ctx.sm.pose.handR : ctx.sm.pose.handL;
      sk.ctx.lineWidth = 1.8;
      sk.burst(h.x + Math.cos(a) * 44, h.y + Math.sin(a) * 44, 3, 4, 16, 1.8, 1.2, a, 31);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    for (const d of [-1, 1]) {
      sk.line({ x: x - s * 0.3, y: y + d * s * 0.22 }, { x: x + s * 0.4, y: y + d * s * 0.05 }, 2.4, 1, 0.4);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. PISTOL
// ---------------------------------------------------------------------------
export class Pistol extends Weapon {
  readonly id = 4;
  readonly name = 'SIDEARM';
  readonly tagline = 'crisp little holes';
  override cooldown = 0.16;
  private flashT = 0;

  constructor() { super(); this.animLen = 0.16; }

  protected release(ctx: WeaponCtx): void {
    const a = ctx.sm.pose.aim + rand(-0.012, 0.012);
    const muzzle = grip(ctx, 57);
    this.flashT = 0.055;
    ctx.sfx('pistol', rand(0.95, 1.08));
    ctx.sm.applyRecoil(0.5, a, 20);
    ctx.shake(3.5);
    ctx.particles.streaks(muzzle.x, muzzle.y, 3, a, 0.3, 40);
    this.hitscan(ctx, muzzle, a, 1400, 12, 30);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
  }

  hands(ctx: WeaponCtx): HandTargets {
    return { main: grip(ctx, 37, 1), off: grip(ctx, 30, 15) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    c.strokeStyle = '#000';
    sk.poly([
      { x: -6, y: -6 }, { x: 20, y: -7 }, { x: 20, y: -2 }, { x: 2, y: -1 },
      { x: 1, y: 10 }, { x: -6, y: 11 },
    ], 3, false, 0.5);
    sk.line({ x: -4, y: -8 }, { x: 6, y: -8 }, 2.2, 1, 0.4);
    if (this.flashT > 0) this.muzzle(sk, 24, -4.5, 16, 101);
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.34, y: y - s * 0.2 }, { x: x + s * 0.4, y: y - s * 0.24 },
      { x: x + s * 0.4, y: y - s * 0.05 }, { x: x - s * 0.06, y: y },
      { x: x - s * 0.1, y: y + s * 0.36 }, { x: x - s * 0.34, y: y + s * 0.38 },
    ], 2.2, false, 0.5);
  }
}

// ---------------------------------------------------------------------------
// 5. ASSAULT RIFLE
// ---------------------------------------------------------------------------
export class Rifle extends Weapon {
  readonly id = 5;
  readonly name = 'ASSAULT RIFLE';
  readonly tagline = 'hold it down, watch it crumble';
  override cooldown = 0.072;
  override auto = true;
  private flashT = 0;
  private heat = 0;

  protected release(ctx: WeaponCtx): void {
    this.heat = Math.min(1, this.heat + 0.16);
    const a = ctx.sm.pose.aim + rand(-1, 1) * (0.008 + this.heat * 0.055);
    const muzzle = grip(ctx, 90);
    this.flashT = 0.045;
    ctx.sfx('rifle', rand(0.94, 1.06));
    ctx.sm.applyRecoil(0.34, a, 12);
    ctx.shake(2.6);
    // Ejected brass.
    ctx.particles.sparks(muzzle.x - Math.cos(a) * 34, muzzle.y - Math.sin(a) * 34, 1, 150, -Math.PI / 2 + rand(-0.5, 0.5), 0.6);
    this.hitscan(ctx, muzzle, a, 1500, 10.5, 34);
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
    if (!held) this.heat = Math.max(0, this.heat - ctx.dt * 1.6);
  }

  hands(ctx: WeaponCtx): HandTargets {
    return { main: grip(ctx, 31, 3), off: grip(ctx, 45, 4) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    // Receiver + stock + barrel + handguard, all one continuous outline.
    sk.poly([
      { x: -30, y: -3 }, { x: -22, y: -8 }, { x: 6, y: -8 }, { x: 10, y: -11 },
      { x: 34, y: -10 }, { x: 34, y: -6 }, { x: 44, y: -6 }, { x: 44, y: -2 },
      { x: 10, y: -1 }, { x: 8, y: 8 }, { x: 1, y: 9 }, { x: 0, y: -1 },
      { x: -22, y: -1 }, { x: -30, y: 2 },
    ], 2.8, false, 0.55);
    sk.line({ x: 12, y: -13 }, { x: 26, y: -13 }, 2, 1, 0.4);   // rail
    sk.poly([{ x: 14, y: -1 }, { x: 22, y: -1 }, { x: 20, y: 12 }, { x: 15, y: 12 }], 2.4, false, 0.5); // magazine
    sk.line({ x: 44, y: -4 }, { x: 58, y: -4 }, 3.2, 1, 0.4);   // barrel
    if (this.flashT > 0) this.muzzle(sk, 60, -4, 20 + this.heat * 8, 202);
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.42, y: y - s * 0.1 }, { x: x + s * 0.42, y: y - s * 0.16 },
      { x: x + s * 0.42, y: y + s * 0.02 }, { x: x - s * 0.16, y: y + s * 0.06 },
      { x: x - s * 0.2, y: y + s * 0.34 }, { x: x - s * 0.3, y: y + s * 0.32 },
    ], 2.1, false, 0.5);
  }
}

// ---------------------------------------------------------------------------
// 6. SHOTGUN
// ---------------------------------------------------------------------------
export class Shotgun extends Weapon {
  readonly id = 6;
  readonly name = 'SHOTGUN';
  readonly tagline = 'wide bites, hard kick';
  override cooldown = 0.72;
  private flashT = 0;

  constructor() { super(); this.animLen = 0.5; }

  protected release(ctx: WeaponCtx): void {
    const base = ctx.sm.pose.aim;
    const muzzle = grip(ctx, 84);
    this.flashT = 0.09;
    ctx.sfx('shotgun');
    ctx.shake(13);
    ctx.flash(0.22);
    ctx.sm.applyRecoil(1.1, base, 260);
    for (let i = 0; i < 11; i++) {
      const a = base + rand(-1, 1) * 0.17;
      this.hitscan(ctx, muzzle, a, 700, 13, 22);
    }
    ctx.particles.smoke(muzzle.x, muzzle.y, 5, 8);
    ctx.particles.streaks(muzzle.x, muzzle.y, 9, base, 0.5, 60);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
  }

  hands(ctx: WeaponCtx): HandTargets {
    // Pump action: the support hand racks back and forward after each shot.
    const t = this.t;
    const pump = this.anim > 0 ? Math.sin(clamp((t - 0.15) / 0.7, 0, 1) * Math.PI) : 0;
    return { main: grip(ctx, 30, 3), off: grip(ctx, 45 - pump * 14, 4) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    const t = this.t;
    const pump = this.anim > 0 ? Math.sin(clamp((t - 0.15) / 0.7, 0, 1) * Math.PI) : 0;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    sk.poly([
      { x: -28, y: 4 }, { x: -20, y: -7 }, { x: 52, y: -8 }, { x: 52, y: -1 },
      { x: 2, y: 0 }, { x: 0, y: 9 }, { x: -8, y: 9 }, { x: -20, y: -1 },
    ], 2.9, false, 0.55);
    // Sliding forend.
    const fx = 26 - pump * 17;
    sk.poly([{ x: fx, y: -1 }, { x: fx + 16, y: -1 }, { x: fx + 16, y: 6 }, { x: fx, y: 6 }], 2.4, false, 0.5);
    sk.line({ x: 4, y: -10 }, { x: 50, y: -11 }, 2.2, 2, 0.5); // magazine tube
    if (this.flashT > 0) {
      this.muzzle(sk, 56, -5, 30, 303);
      sk.ctx.lineWidth = 2.4;
      sk.burst(56, -5, 9, 6, 46, 2.4, 0.9, 0, 304);
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.4, y: y + s * 0.16 }, { x: x - s * 0.26, y: y - s * 0.12 },
      { x: x + s * 0.42, y: y - s * 0.16 }, { x: x + s * 0.42, y: y - s * 0.02 },
      { x: x - s * 0.2, y: y + s * 0.02 }, { x: x - s * 0.24, y: y + s * 0.3 },
    ], 2.1, false, 0.5);
    sk.line({ x: x - s * 0.05, y: y - s * 0.22 }, { x: x + s * 0.4, y: y - s * 0.26 }, 1.8, 1, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 7. ROCKET LAUNCHER
// ---------------------------------------------------------------------------
export class RocketLauncher extends Weapon {
  readonly id = 7;
  readonly name = 'ROCKET TUBE';
  readonly tagline = 'craters on delivery';
  override cooldown = 0.95;

  constructor() { super(); this.animLen = 0.6; }

  protected release(ctx: WeaponCtx): void {
    const a = ctx.sm.pose.aim;
    const muzzle = grip(ctx, 88);
    ctx.projectiles.push(new Projectile({
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(a) * 900, vy: Math.sin(a) * 900,
      kind: 'rocket', gravity: 300, radius: 6, life: 5, blast: BLASTS.rocket,
    }));
    ctx.sfx('launch');
    ctx.shake(7);
    ctx.sm.applyRecoil(0.9, a, 90);
    // Backblast out of the rear of the tube.
    const back = grip(ctx, -12);
    ctx.particles.smoke(back.x, back.y, 7, 9);
    ctx.particles.sparks(back.x, back.y, 8, 240, a + Math.PI, 1.1);
  }

  hands(ctx: WeaponCtx): HandTargets {
    return { main: grip(ctx, 30, 7), off: grip(ctx, 45, 7) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    // Tube with a flared rear, a sight, and a grip.
    sk.poly([
      { x: -34, y: -14 }, { x: -26, y: -9 }, { x: 54, y: -9 }, { x: 54, y: 4 },
      { x: -26, y: 4 }, { x: -34, y: 9 },
    ], 3, false, 0.55);
    sk.line({ x: 6, y: -9 }, { x: 6, y: -19 }, 2.2, 1, 0.4);
    sk.line({ x: 0, y: -19 }, { x: 14, y: -19 }, 2.2, 1, 0.4);
    sk.line({ x: 2, y: 4 }, { x: 0, y: 14 }, 2.6, 1, 0.4);
    if (this.anim > 0 && this.t < 0.3) this.muzzle(sk, 58, -3, 24, 404);
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.42, y: y - s * 0.16 }, { x: x + s * 0.36, y: y - s * 0.16 },
      { x: x + s * 0.36, y: y + s * 0.08 }, { x: x - s * 0.42, y: y + s * 0.08 },
    ], 2.2, false, 0.5);
    sk.poly([{ x: x + s * 0.36, y: y - s * 0.2 }, { x: x + s * 0.5, y: y - s * 0.04 }, { x: x + s * 0.36, y: y + s * 0.12 }], 2, false, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 8. SIEGE CANNON
// ---------------------------------------------------------------------------
export class Cannon extends Weapon {
  readonly id = 8;
  readonly name = 'SIEGE CANNON';
  readonly tagline = 'hold to charge, brace for it';
  override cooldown = 1.35;
  override chargeTime = 0.95;
  private fireT = 0;

  protected release(ctx: WeaponCtx, power: number): void {
    const a = ctx.sm.pose.aim;
    const muzzle = grip(ctx, 106);
    const scale = 0.55 + power * 0.75;
    ctx.projectiles.push(new Projectile({
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(a) * 1250, vy: Math.sin(a) * 1250,
      kind: 'shell', gravity: 180, radius: 5 + power * 4, life: 5,
      blast: { ...BLASTS.cannon, radius: BLASTS.cannon.radius * scale, debris: Math.round(BLASTS.cannon.debris * scale) },
    }));
    this.fireT = 0.16;
    this.anim = this.animLen;
    ctx.sfx('cannon');
    ctx.shake(20 * scale);
    ctx.flash(0.4 * scale);
    ctx.sm.applyRecoil(1.5, a, 300 * scale);
    ctx.particles.smoke(muzzle.x, muzzle.y, 10, 14);
    ctx.particles.streaks(muzzle.x, muzzle.y, 12, a, 0.7, 90);
    ctx.particles.shockwave(muzzle.x, muzzle.y, 60 * scale);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.fireT = Math.max(0, this.fireT - ctx.dt);
    if (this.charge > 0.05) {
      const muzzle = grip(ctx, 106);
      if (Math.random() < this.charge * 0.6) {
        ctx.particles.sparks(muzzle.x + rand(-20, 20), muzzle.y + rand(-20, 20), 1, 90, Math.atan2(muzzle.y, muzzle.x) + Math.PI, 1);
      }
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const brace = this.charge * 5;
    return { main: grip(ctx, 30 - brace, 9), off: grip(ctx, 45 - brace, 7) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);

    // Breech block.
    sk.poly([
      { x: -36, y: -18 }, { x: -18, y: -22 }, { x: 12, y: -20 }, { x: 14, y: 10 },
      { x: -18, y: 12 }, { x: -36, y: 8 },
    ], 3.2, false, 0.6);
    // Barrel with a muzzle brake.
    sk.poly([{ x: 12, y: -14 }, { x: 62, y: -12 }, { x: 62, y: -1 }, { x: 12, y: 2 }], 3, false, 0.55);
    sk.poly([{ x: 62, y: -16 }, { x: 76, y: -15 }, { x: 76, y: 3 }, { x: 62, y: 3 }], 2.8, false, 0.5);
    sk.line({ x: 66, y: -15 }, { x: 66, y: 3 }, 2, 1, 0.4);
    sk.line({ x: 71, y: -15 }, { x: 71, y: 3 }, 2, 1, 0.4);
    // Shoulder brace and grip.
    sk.line({ x: -36, y: -6 }, { x: -52, y: -2 }, 3, 1, 0.5);
    sk.line({ x: -52, y: -12 }, { x: -52, y: 8 }, 3, 1, 0.5);
    sk.line({ x: -6, y: 11 }, { x: -8, y: 24 }, 2.8, 1, 0.5);

    // Charge tell: rings closing on the muzzle, plus a swelling core.
    if (this.charge > 0.02) {
      const k = this.charge;
      c.lineWidth = 1.8 + k * 2;
      for (let i = 0; i < 3; i++) {
        const phase = (ctx.time * 2.2 + i / 3) % 1;
        const r = (1 - phase) * 46 * k + 6;
        sk.polyPath(circlePts(74, -5, r, 12, ctx.time * 3), 1.6);
        c.stroke();
      }
      c.fillStyle = '#000';
      sk.polyPath(circlePts(74, -5, 3 + k * 9, 10, -ctx.time * 4), 1.4);
      c.fill();
      sk.burst(74, -5, 6, 12 + k * 10, 20 + k * 34, 2, TAU, 0, 555);
    }
    if (this.fireT > 0) {
      this.muzzle(sk, 80, -6, 46 * (this.fireT / 0.16), 505);
      c.lineWidth = 3;
      sk.burst(80, -6, 11, 10, 78, 3, 1.0, 0, 506);
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.42, y: y - s * 0.2 }, { x: x - s * 0.1, y: y - s * 0.24 },
      { x: x - s * 0.08, y: y + s * 0.16 }, { x: x - s * 0.42, y: y + s * 0.12 },
    ], 2.2, false, 0.5);
    sk.poly([
      { x: x - s * 0.1, y: y - s * 0.14 }, { x: x + s * 0.44, y: y - s * 0.16 },
      { x: x + s * 0.44, y: y + s * 0.04 }, { x: x - s * 0.1, y: y + s * 0.06 },
    ], 2.2, false, 0.5);
  }
}

// ---------------------------------------------------------------------------
// 9. FIRE MAGIC
// ---------------------------------------------------------------------------
export class FireMagic extends Weapon {
  readonly id = 9;
  readonly name = 'PYRO STREAM';
  readonly tagline = 'melts it away, hold to burn';
  override cooldown = 0;
  override auto = true;
  private active = 0;
  private sfxTimer = 0;
  /** Emission is rate-based, not per-frame, or the page fills with solid ink. */
  private spawn = 0;

  protected release(): void { /* the burn happens continuously in tick() */ }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.active = held ? Math.min(1, this.active + ctx.dt * 5) : Math.max(0, this.active - ctx.dt * 4);
    if (!held) return;

    const a = ctx.sm.pose.aim;
    const hand = ctx.sm.pose.handR;
    this.sfxTimer -= ctx.dt;
    if (this.sfxTimer <= 0) { ctx.sfx('fire', rand(0.8, 1.3)); this.sfxTimer = 0.07; }
    ctx.sm.applyRecoil(0.06, a, 0);

    this.spawn += ctx.dt * 34;
    const puffs = Math.floor(this.spawn);
    this.spawn -= puffs;
    if (puffs > 0) ctx.particles.flames(hand.x, hand.y, puffs, a, 420);

    // Probes across the cone, each melting a small bite. The wall dissolves
    // gradually instead of being punched, which is what reads as heat.
    for (let i = 0; i < 3; i++) {
      const ang = a + rand(-0.16, 0.16);
      const hit = ctx.terrain.raycast(hand.x, hand.y, Math.cos(ang), Math.sin(ang), 300, 4);
      if (hit) {
        ctx.terrain.carveBlob(hit.x, hit.y, 10 + Math.random() * 5, 0.45, 12);
        if (puffs > 0) ctx.particles.flames(hit.x, hit.y, 1, ang + Math.PI + rand(-0.9, 0.9), 130);
        if (Math.random() < 0.12) ctx.particles.debris(hit.x, hit.y, 1, 120, ang + Math.PI, 2.2);
        if (Math.random() < 0.05) ctx.particles.smoke(hit.x, hit.y, 1, 8);
      }
    }
    ctx.shake(1.6);
  }

  hands(ctx: WeaponCtx): HandTargets {
    const push = this.active * 8;
    return { main: grip(ctx, 34 + push, -3), off: grip(ctx, 29, 16) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    const k = this.active;

    // A little fire around the hand, so the weapon reads as equipped even at
    // rest - kept sparse, because solid black would swallow the figure.
    const el = ctx.sm.pose.elbowR;
    c.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const t = 0.45 + i * 0.28;
      const px = el.x + (h.x - el.x) * t;
      const py = el.y + (h.y - el.y) * t;
      const w = 5 + i * 2.5 + k * 4;
      const flick = hashNoise(i, Math.floor(ctx.time * 14)) * 4;
      sk.curve(
        { x: px, y: py + w * 0.5 },
        { x: px - Math.cos(a) * w + flick, y: py - w * 1.5 },
        { x: px, y: py - w * 0.6 },
        1.9, 1.2,
      );
    }

    if (k > 0.02) {
      // The stream: a handful of open tongues widening along the aim. The gaps
      // between them are the point - the wall has to stay visible through it.
      const len = 250 * k;
      c.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const t = (i + 0.5) / 5;
        const wob = hashNoise(i * 3, Math.floor(ctx.time * 15)) * 0.16;
        const ang = a + (t - 0.5) * 0.44 + wob;
        const l = len * (0.45 + Math.abs(hashNoise(i * 7, Math.floor(ctx.time * 11))) * 0.6);
        const mid = { x: h.x + Math.cos(ang) * l * 0.5, y: h.y + Math.sin(ang) * l * 0.5 - 14 * t };
        sk.curve(h, mid, { x: h.x + Math.cos(ang) * l, y: h.y + Math.sin(ang) * l }, 2.2, 2.2);
      }
      c.lineWidth = 2.4;
      sk.burst(h.x, h.y, 5, 8, 24 * k, 2.4, 2.0, a, 606);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.curve(
      { x: x - s * 0.05, y: y + s * 0.4 },
      { x: x - s * 0.42, y: y - s * 0.1 },
      { x: x, y: y - s * 0.42 }, 2.3, 0.5,
    );
    sk.curve(
      { x: x, y: y - s * 0.42 },
      { x: x + s * 0.4, y: y - s * 0.05 },
      { x: x - s * 0.05, y: y + s * 0.4 }, 2.3, 0.5,
    );
    sk.curve(
      { x: x - s * 0.02, y: y + s * 0.34 },
      { x: x + s * 0.14, y: y + s * 0.05 },
      { x: x + s * 0.02, y: y - s * 0.14 }, 1.8, 0.5,
    );
  }
}

// ---------------------------------------------------------------------------
// 10. ENERGY BEAM
// ---------------------------------------------------------------------------
export class EnergyBeam extends Weapon {
  readonly id = 10;
  readonly name = 'PWNAGE BEAM';
  readonly tagline = 'charge it, then delete a column';
  override cooldown = 1.5;
  override chargeTime = 0.85;
  private beam = 0;
  private beamMax = 0.62;
  private beamAngle = 0;
  private power = 1;
  private sfxTimer = 0;

  protected release(ctx: WeaponCtx, power: number): void {
    this.beam = this.beamMax;
    this.power = 0.45 + power * 0.55;
    this.beamAngle = ctx.sm.pose.aim;
    ctx.sfx('beam', 0.6);
    ctx.flash(0.55 * this.power);
    ctx.invert(0.07);
    ctx.shake(18 * this.power);
  }

  protected override tick(ctx: WeaponCtx): void {
    if (this.beam <= 0) return;
    this.beam = Math.max(0, this.beam - ctx.dt);
    const k = this.beam / this.beamMax;

    // The beam tracks the aim, but lags: it is a heavy thing to swing around.
    const target = ctx.sm.pose.aim;
    let d = target - this.beamAngle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.beamAngle += d * Math.min(1, ctx.dt * 6);

    const origin = grip(ctx, 44);
    const radius = (34 * this.power) * (0.45 + k * 0.55);
    const a = this.beamAngle;
    // Bore straight through: a capsule out to the far edge of the world.
    ctx.terrain.carveCapsule(
      origin.x, origin.y,
      origin.x + Math.cos(a) * 1600, origin.y + Math.sin(a) * 1600,
      radius, 0.16,
    );
    ctx.sm.applyRecoil(0.5, a, 260 * ctx.dt * this.power);
    ctx.shake(9 * k * this.power);

    this.sfxTimer -= ctx.dt;
    if (this.sfxTimer <= 0) { ctx.sfx('beam', rand(0.85, 1.2)); this.sfxTimer = 0.06; }

    const hit = ctx.terrain.raycast(origin.x, origin.y, Math.cos(a), Math.sin(a), 1600, 6);
    if (hit) {
      ctx.particles.debris(hit.x, hit.y, 3, 320, a + Math.PI, 2.2);
      ctx.particles.sparks(hit.x, hit.y, 4, 400, a + Math.PI, 2.4);
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const k = Math.max(this.charge, this.beam / this.beamMax);
    // Cupped hands at the hip while charging, thrust forward when firing.
    // Cupped low at the hip while charging, thrust out along the aim when firing.
    const fwd = this.beam > 0 ? 40 : 20 + k * 6;
    const side = this.beam > 0 ? 2 : 26 - k * 8;
    return { main: grip(ctx, fwd, side - 7), off: grip(ctx, fwd - 3, side + 7) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const o = ctx.sm.pose.handL;
    const mid = { x: (h.x + o.x) / 2, y: (h.y + o.y) / 2 };

    // --- charging: energy converging into the cupped hands ------------------
    if (this.charge > 0.01) {
      const k = this.charge;
      c.lineWidth = 2 + k * 1.6;
      // Long straight lines racing inward - the signature "gathering" look.
      const n = 14;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + ctx.time * 0.7;
        const phase = ((ctx.time * 1.6 + i * 0.13) % 1);
        const r0 = 30 + (1 - phase) * 150 * k;
        const r1 = r0 + 30 + k * 60;
        c.beginPath();
        c.moveTo(mid.x + Math.cos(ang) * r0, mid.y + Math.sin(ang) * r0);
        c.lineTo(mid.x + Math.cos(ang) * r1, mid.y + Math.sin(ang) * r1);
        c.stroke();
      }
      // The core itself: a solid blob with a white bite out of the middle.
      c.fillStyle = '#000';
      sk.polyPath(circlePts(mid.x, mid.y, 8 + k * 20, 11, ctx.time * 2), 1.6);
      c.fill();
      c.fillStyle = '#fff';
      sk.polyPath(circlePts(mid.x, mid.y, (8 + k * 20) * 0.45, 9, -ctx.time * 3), 1.2);
      c.fill();
      c.fillStyle = '#000';
      c.lineWidth = 2.6;
      sk.burst(mid.x, mid.y, 9, 14 + k * 22, 30 + k * 60, 2.6, TAU, 0, 707);
    }

    // --- firing: a white channel with a hard ink outline --------------------
    if (this.beam > 0) {
      const k = this.beam / this.beamMax;
      const a = this.beamAngle;
      const origin = grip(ctx, 40);
      const r = (34 * this.power) * (0.5 + k * 0.5);
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      const L = 1700;

      const p = (d: number, off: number): Vec2 => ({ x: origin.x + ca * d + nx * off, y: origin.y + sa * d + ny * off });
      // Flared cone at the source widening to a straight column.
      const top: Vec2[] = [], bot: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const d = t * L;
        const wob = hashNoise(i, Math.floor(ctx.time * 20)) * 3;
        const w = r * (0.55 + Math.min(1, t * 8) * 0.55) + wob;
        top.push(p(d, -w));
        bot.push(p(d, w));
      }
      c.fillStyle = '#fff';
      c.beginPath();
      c.moveTo(top[0].x, top[0].y);
      for (const q of top) c.lineTo(q.x, q.y);
      for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
      c.closePath();
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = 4.5;
      c.beginPath();
      for (let i = 0; i < top.length; i++) { if (i === 0) c.moveTo(top[i].x, top[i].y); else c.lineTo(top[i].x, top[i].y); }
      c.stroke();
      c.beginPath();
      for (let i = 0; i < bot.length; i++) { if (i === 0) c.moveTo(bot[i].x, bot[i].y); else c.lineTo(bot[i].x, bot[i].y); }
      c.stroke();
      // Speed lines inside the column.
      c.lineWidth = 2;
      for (let i = 0; i < 9; i++) {
        const off = (hashNoise(i, Math.floor(ctx.time * 24))) * r * 0.8;
        const d0 = ((ctx.time * 2600 + i * 220) % L);
        const s0 = p(d0, off), s1 = p(Math.min(L, d0 + 150), off);
        c.beginPath(); c.moveTo(s0.x, s0.y); c.lineTo(s1.x, s1.y); c.stroke();
      }
      // Muzzle bloom.
      c.lineWidth = 3.4;
      sk.burst(origin.x, origin.y, 10, r * 1.1, r * 3.2, 3.4, TAU, 0, 808);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    c.fillStyle = '#000';
    sk.polyPath(circlePts(x - s * 0.18, y, s * 0.16, 9, 0), 0.8);
    c.fill();
    c.lineWidth = 2.2;
    sk.poly([
      { x: x - s * 0.02, y: y - s * 0.12 }, { x: x + s * 0.46, y: y - s * 0.2 },
      { x: x + s * 0.46, y: y + s * 0.2 }, { x: x - s * 0.02, y: y + s * 0.12 },
    ], 2.2, false, 0.5);
  }
}

function circlePts(x: number, y: number, r: number, n: number, rot: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  return pts;
}

export function createArsenal(): Weapon[] {
  return [
    new Fists(), new Katana(), new Daggers(), new Pistol(), new Rifle(),
    new Shotgun(), new RocketLauncher(), new Cannon(), new FireMagic(), new EnergyBeam(),
  ];
}

export { applyBlast };
