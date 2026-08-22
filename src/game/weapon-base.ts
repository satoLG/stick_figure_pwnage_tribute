import type { SfxName } from '../core/audio';
import { clamp, easeOutCubic, rand, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Particles } from './particles';
import type { Projectile } from './projectiles';
import { ARM_LEN, type HandTargets, type Stance, type Stickman } from './stickman';
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
  /** The converging fan of lines that punctuates a landed blow. */
  hit(x: number, y: number, dir: number, power?: number): void;
  /** Stop the world for a couple of frames, so the impact pose can be read. */
  freeze(frames: number): void;
  /** Run something once, `seconds` from now - a round arriving, for instance. */
  after(seconds: number, fn: () => void): void;
  sfx(name: SfxName, pitch?: number): void;
}

/**
 * Where a hand sits: `fwd` units in front of the sternum along the aim line,
 * `side` units perpendicular to it. The arm is ARM_LEN long, so anything much
 * under ~26 folds the elbow into a zigzag - keep held poses in the 28..46 band.
 */
export function grip(ctx: WeaponCtx, fwd: number, side = 0): Vec2 {
  return gripAt(ctx, ctx.sm.pose.aim, fwd, side);
}

/**
 * The same, but around an arbitrary direction instead of the aim. Melee weapons
 * hang their hands off the *blade* angle, so the arms lead the swing and the
 * whole body reads as throwing the weapon around rather than holding it out.
 */
export function gripAt(ctx: WeaponCtx, ang: number, fwd: number, side = 0): Vec2 {
  const { chest } = ctx.sm.pose;
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = clamp(fwd, -30, ARM_LEN * 0.94);
  // The torso got shorter, so the grip is lifted to keep the swing arc on the
  // wall instead of sweeping through the indestructible floor.
  return { x: chest.x + c * d - s * side, y: chest.y + s * d + c * side - 5 };
}

/** Mirrors a world-space angle when the figure turns around. */
export function mirror(a: number, facing: number): number {
  return facing > 0 ? a : Math.PI - a;
}

/** Shortest path between two angles, for swings that must not take the long way. */
export function toward(from: number, to: number, t: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return from + d * t;
}

/**
 * The white crescents a blade leaves hanging in the air for a beat after a cut.
 * They are the single biggest thing separating "a line moved" from "something
 * just got cut in half", so every edged weapon in here feeds this.
 */
interface Slash {
  x: number; y: number;
  r: number; from: number; to: number;
  width: number; grow: number;
  life: number; max: number;
}

export class SlashFx {
  private list: Slash[] = [];

  add(x: number, y: number, r: number, from: number, to: number, width: number, life = 0.26, grow = 34): void {
    this.list.push({ x, y, r, from, to, width, grow, life, max: life });
    if (this.list.length > 8) this.list.shift();
  }

  clear(): void { this.list.length = 0; }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      this.list[i].life -= dt;
      if (this.list[i].life <= 0) this.list.splice(i, 1);
    }
  }

  draw(sk: Sketch): void {
    const c = sk.ctx;
    for (const s of this.list) {
      const k = s.life / s.max;                 // 1 -> 0
      const spread = easeOutCubic(1 - k);       // the cut keeps opening as it fades
      const r = s.r + s.grow * spread;
      const w = s.width * (0.35 + k * 0.9);
      const steps = 18;
      const outer: Vec2[] = [], inner: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = s.from + (s.to - s.from) * t;
        // Thickest in the middle of the sweep, tapering to nothing at the tips.
        const taper = Math.sin(t * Math.PI) ** 0.7;
        const half = w * 0.5 * taper + 0.4;
        outer.push({ x: s.x + Math.cos(a) * (r + half), y: s.y + Math.sin(a) * (r + half) });
        inner.push({ x: s.x + Math.cos(a) * (r - half), y: s.y + Math.sin(a) * (r - half) });
      }
      c.save();
      c.globalAlpha = clamp(k * 1.5, 0, 1);
      c.beginPath();
      c.moveTo(outer[0].x, outer[0].y);
      for (const p of outer) c.lineTo(p.x, p.y);
      for (let i = inner.length - 1; i >= 0; i--) c.lineTo(inner[i].x, inner[i].y);
      c.closePath();
      c.fillStyle = '#fff';
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = 3.4 * k + 1;
      c.stroke();
      c.restore();
    }
  }
}

/**
 * A point on whatever masonry is still standing, for weapons that pick their
 * own targets rather than firing where the player points - the missile salvo,
 * mostly. Falls back to the middle of what is left, and to the crosshair once
 * there is nothing left at all.
 */
export function wallPoint(ctx: WeaponCtx, tries = 26): Vec2 {
  const b = ctx.terrain.wallBounds();
  if (!b) return { ...ctx.aimPoint };
  for (let i = 0; i < tries; i++) {
    const x = rand(b.x0, b.x1);
    const y = rand(b.y0, b.y1);
    if (ctx.terrain.solidAt(x, y)) return { x, y };
  }
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** Debris, sparks and speed lines wherever something bites into the wall. */
export function impact(ctx: WeaponCtx, x: number, y: number, dir: number, power: number): void {
  ctx.particles.debris(x, y, Math.round(4 + power * 16), 90 + power * 320, dir + Math.PI, 2.4);
  ctx.particles.sparks(x, y, Math.round(3 + power * 9), 140 + power * 320, dir + Math.PI, 2.0);
  ctx.particles.streaks(x, y, Math.round(2 + power * 6), dir + Math.PI, 1.9, 16 + power * 40);
}

export abstract class Weapon {
  abstract readonly id: number;
  abstract readonly name: string;
  abstract readonly tagline: string;

  /**
   * Whether this fires down a line rather than swinging through an arc. It
   * decides how a thumb's aim is read: a swing forgives a few degrees, a shot
   * does not.
   */
  readonly ranged: boolean = true;

  /** Held-trigger weapons keep firing; the rest need a fresh click. */
  auto = false;
  cooldown = 0.3;
  /** Seconds of hold before a charged weapon will release. 0 = fires instantly. */
  chargeTime = 0;

  protected timer = 0;
  charge = 0;
  /**
   * Seconds the trigger has been down without a break. Weapons whose held
   * behaviour is a different move rather than more of the same one - the melee
   * chains, the mecha's rod array, the missile salvo - read it instead of
   * running a clock of their own.
   */
  protected heldFor = 0;
  private wasHeld = false;
  /** Attack animation clock, counting down. */
  protected anim = 0;
  protected animLen = 0.2;
  /**
   * Length of the animation actually running. Combo weapons retune `animLen`
   * between hits, so the clock in flight has to remember its own duration.
   */
  private animRun = 0.2;
  protected swap = 1;
  private chargeSfx = false;

  /** Fraction 0..1 through the current attack animation, 0 when idle. */
  protected get t(): number {
    return this.anim > 0 ? 1 - this.anim / this.animRun : 0;
  }

  /** Starts the attack clock. Combos call it with their own step's length. */
  protected startAnim(len = this.animLen): void {
    this.animRun = Math.max(0.01, len);
    this.anim = this.animRun;
  }
  get busy(): boolean { return this.anim > 0; }
  get ready(): boolean { return this.timer <= 0; }
  /** Drives the cooldown ring in the HUD. */
  get cooldownFrac(): number { return this.cooldown > 0 ? clamp(this.timer / this.cooldown, 0, 1) : 0; }
  /** Melee weapons report their running combo here; everything else is silent. */
  get comboLabel(): string | null { return null; }

  onEquip(): void {
    this.charge = 0;
    this.anim = 0;
    this.heldFor = 0;
    this.wasHeld = false;
    this.timer = Math.min(this.timer, 0.12);
  }
  onUnequip(_ctx: WeaponCtx): void {
    this.charge = 0;
    this.chargeSfx = false;
    this.heldFor = 0;
    this.wasHeld = false;
  }

  update(ctx: WeaponCtx, held: boolean, pressed: boolean): void {
    this.timer -= ctx.dt;
    if (this.anim > 0) this.anim = Math.max(0, this.anim - ctx.dt);
    // The frame the trigger comes up is handled before the hold clock is
    // cleared, so a weapon letting go of something it was winding up can still
    // see how long it had.
    if (this.wasHeld && !held) this.onLetGo(ctx);
    this.wasHeld = held;
    this.heldFor = held ? this.heldFor + ctx.dt : 0;
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
    if (wants && this.timer <= 0 && !this.suppressFire(ctx)) {
      this.timer = this.cooldown;
      this.startAnim();
      this.swap = -this.swap;
      this.release(ctx, 1);
    }
  }

  /** Per-frame hook for weapons with continuous effects (fire, beam). */
  protected tick(_ctx: WeaponCtx, _held: boolean): void {}

  /**
   * "Not right now." A weapon whose held trigger means something other than
   * more shots - a rod array unfolding, a salvo loading - says so here, and the
   * ordinary attack stops coming out while it does.
   */
  protected suppressFire(_ctx: WeaponCtx): boolean { return false; }

  /** The frame the trigger comes back up; where a held-up attack goes off. */
  protected onLetGo(_ctx: WeaponCtx): void {}

  /** Fires. `power` is the charge fraction for charged weapons, else 1. */
  protected abstract release(ctx: WeaponCtx, power: number): void;

  /** Where the hands should go this frame. */
  abstract hands(ctx: WeaponCtx): HandTargets | null;

  /**
   * A full-body stance to blend into the figure this frame, for weapons whose
   * pose matters more than their hands. Null means "just move normally".
   */
  stance(_ctx: WeaponCtx): Stance | null { return null; }

  /** Anything that belongs *under* the figure - auras, ground effects. */
  drawBehind(_sk: Sketch, _ctx: WeaponCtx): void {}

  /** Draws the weapon itself, in world space, after the figure. */
  abstract draw(sk: Sketch, ctx: WeaponCtx): void;

  /** Small emblem for the selection wheel; draw inside a box of `s` units. */
  abstract icon(sk: Sketch, x: number, y: number, s: number): void;

  /**
   * The angle from a point to whatever the crosshair is on.
   *
   * Firing along the figure's aim angle from a muzzle that sits a barrel's
   * length in front of him is not the same line: it is parallel to it and
   * offset, so shots land off the crosshair by that offset. Every barrel aims
   * from where the barrel actually is.
   */
  protected aimFrom(ctx: WeaponCtx, from: Vec2): number {
    return Math.atan2(ctx.aimPoint.y - from.y, ctx.aimPoint.x - from.x);
  }

  /**
   * Shared: a hitscan shot that bores a hole and a short tunnel, and draws the
   * round travelling down the firing line so the burst reads as bullets.
   *
   * The wall does not open until the round gets there. Punching the hole on the
   * frame the trigger goes means the damage appears ahead of its own tracer,
   * which reads as the wall breaking by itself.
   */
  protected hitscan(ctx: WeaponCtx, from: Vec2, angle: number, range: number, holeR: number): boolean {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const hit = ctx.terrain.strikePoint(from.x, from.y, ca, sa, range, 3);
    const end = hit ?? { x: from.x + ca * range, y: from.y + sa * range };
    const speed = 3600;
    ctx.particles.tracer(from.x, from.y, end.x, end.y, speed, clamp(holeR / 10, 0.4, 1.6));
    if (!hit) return false;
    const flight = Math.hypot(end.x - from.x, end.y - from.y) / speed;
    const terrain = ctx.terrain;
    ctx.after(flight, () => {
      // Entry wound plus the spall around it: one round bite, reaching about
      // as far in as it is wide. A round is small enough that "shallow" comes
      // out on its own - what it must not do is punch a needle straight
      // through and leave the face it came in by standing.
      terrain.carveBlob(hit.x, hit.y, holeR * 1.9, 0.34, 14, holeR * 1.2);
      impact(ctx, hit.x, hit.y, angle, holeR / 34);
    });
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
