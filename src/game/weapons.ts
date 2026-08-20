import type { SfxName } from '../core/audio';
import {
  clamp, damp, easeInCubic, easeOutCubic, easeOutQuint, hashNoise, lerp, lerpVec, rand,
  smoothstep, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Particles } from './particles';
import { applyBlast, BLASTS, Projectile } from './projectiles';
import { ARM_LEN, HEAD_R, type HandTargets, type Stance, type Stickman } from './stickman';
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
  return gripAt(ctx, ctx.sm.pose.aim, fwd, side);
}

/**
 * The same, but around an arbitrary direction instead of the aim. Melee weapons
 * hang their hands off the *blade* angle, so the arms lead the swing and the
 * whole body reads as throwing the weapon around rather than holding it out.
 */
function gripAt(ctx: WeaponCtx, ang: number, fwd: number, side = 0): Vec2 {
  const { chest } = ctx.sm.pose;
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = clamp(fwd, -30, ARM_LEN * 0.94);
  return { x: chest.x + c * d - s * side, y: chest.y + s * d + c * side + 2 };
}

/** Mirrors a world-space angle when the figure turns around. */
function mirror(a: number, facing: number): number {
  return facing > 0 ? a : Math.PI - a;
}

/** Shortest path between two angles, for swings that must not take the long way. */
function toward(from: number, to: number, t: number): number {
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

class SlashFx {
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
      this.startAnim();
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
  /** 0, 1 = jabs; 2 = the hook that ends the combo. */
  private step = 0;
  private idle = 0;

  constructor() { super(); this.animLen = 0.19; }

  override onEquip(): void { super.onEquip(); this.step = 0; }

  private get hook(): boolean { return this.step === 2; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    this.idle = 0;
    if (this.hook) {
      // The finisher steps into the target and swings the whole body with it.
      ctx.sfx('heavyswing', rand(1.05, 1.2));
      ctx.sm.dash(Math.cos(ctx.sm.pose.aim) * 130);
      ctx.sm.addGhostBurst(0.2);
    } else {
      ctx.sfx('swing', rand(0.95, 1.2));
    }
    // Queue the next step now: the base class reads these when it starts the
    // next attack, so each hit in the chain gets its own timing.
    this.step = (this.step + 1) % 3;
    this.cooldown = this.hook ? 0.34 : 0.17;   // the hook needs a real recovery
    this.animLen = this.hook ? 0.3 : 0.17;
  }

  protected override tick(ctx: WeaponCtx): void {
    // A pause drops the combo back to a jab.
    if (this.anim <= 0) {
      this.idle += ctx.dt;
      if (this.idle > 0.55 && this.step !== 0) {
        this.step = 0;
        this.cooldown = 0.17;
        this.animLen = 0.17;
      }
    }
    if (this.anim > 0 && !this.struck && this.t > 0.42) {
      this.struck = true;
      // `step` has already advanced, so the hit that is landing is the one before.
      const wasHook = this.step === 0;
      const a = ctx.sm.pose.aim;
      const from = grip(ctx, 6);
      const reach = wasHook ? 88 : 74;
      const hit = ctx.terrain.raycast(from.x, from.y, Math.cos(a), Math.sin(a), reach, 3);
      if (hit) {
        const r = wasHook ? 40 : 25;
        ctx.terrain.carveBlob(hit.x, hit.y, r, 0.35, 18);
        ctx.terrain.carveCapsule(hit.x, hit.y, hit.x + Math.cos(a) * (wasHook ? 34 : 16), hit.y + Math.sin(a) * (wasHook ? 34 : 16), r * 0.62, 0.3);
        impact(ctx, hit.x, hit.y, a, wasHook ? 1 : 0.55);
        ctx.sfx('punch', wasHook ? 0.72 : rand(0.95, 1.15));
        ctx.shake(wasHook ? 13 : 5);
        if (wasHook) {
          ctx.flash(0.14);
          ctx.particles.shockwave(hit.x, hit.y, 60);
        }
        ctx.sm.applyRecoil(wasHook ? 0.7 : 0.35, a, wasHook ? 90 : 40);
      }
    }
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    const t = this.t;
    const f = ctx.sm.facing;
    // Between punches the arms are released back to the gait, so running with
    // bare hands swings them instead of carrying a frozen guard around.
    if (this.anim <= 0 && Math.abs(ctx.sm.vel.x) > 45) return null;
    // The hook swings in from outside instead of pistoning straight out.
    if (this.anim > 0 && this.step === 0) {
      const swing = t < 0.34 ? -0.9 * (t / 0.34) : lerp(-0.9, 0.75, easeOutCubic((t - 0.34) / 0.5));
      const ext = 30 + Math.sin(clamp((t - 0.2) / 0.5, 0, 1) * Math.PI) * 18;
      return {
        main: gripAt(ctx, ctx.sm.pose.aim + swing * f, ext, -6 * f),
        off: grip(ctx, 26, 16),
      };
    }
    // A jab is an ease-out thrust followed by a slower recovery.
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
      const hook = this.step === 0;
      const h = hook || this.swap > 0 ? ctx.sm.pose.handR : ctx.sm.pose.handL;
      const a = ctx.sm.pose.aim;
      sk.ctx.lineWidth = hook ? 3 : 2.2;
      sk.burst(h.x, h.y, hook ? 7 : 4, 8, hook ? 40 : 22, hook ? 3 : 2.2, hook ? 2.4 : 1.5, a + Math.PI, 77);
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

/** One cut of a sword combo, in blade angles relative to the aim. */
interface Cut {
  /** Where the wind-up parks the blade, and where the cut finishes. */
  from: number; to: number;
  /** Fractions of the animation spent coiling and then actually cutting. */
  wind: number; strike: number;
  anim: number; cooldown: number;
  /** Carve radius as a fraction of the blade, and how deep the crescent bites. */
  reach: number; thick: number;
  heavy: boolean;
}

/**
 * Three cuts that chain into each other: down through the shoulder, back up the
 * same line, then a full body-turn that takes everything in front of him. Hold
 * the button and the figure keeps cycling the kata.
 */
const KATANA_CUTS: readonly Cut[] = [
  { from: -1.75, to: 0.95, wind: 0.34, strike: 0.2, anim: 0.32, cooldown: 0.3, reach: 0.76, thick: 26, heavy: false },
  { from: 1.35, to: -1.45, wind: 0.28, strike: 0.18, anim: 0.28, cooldown: 0.27, reach: 0.76, thick: 26, heavy: false },
  { from: 2.35, to: -1.15, wind: 0.44, strike: 0.2, anim: 0.5, cooldown: 0.66, reach: 0.92, thick: 44, heavy: true },
];

export class Katana extends Weapon {
  readonly id = 2;
  readonly name = 'KATANA';
  readonly tagline = 'three cuts, one breath';
  override cooldown = 0.3;
  override auto = true;
  private struck = false;
  private readonly len = 92;
  private step = 0;
  private active: Cut = KATANA_CUTS[0];
  private idle = 0;
  private fx = new SlashFx();
  private tipTrail: Vec2[] = [];

  constructor() { super(); this.animLen = KATANA_CUTS[0].anim; }

  override onEquip(): void {
    super.onEquip();
    this.step = 0;
    this.animLen = KATANA_CUTS[0].anim;
    this.cooldown = KATANA_CUTS[0].cooldown;
  }

  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.fx.clear(); this.tipTrail.length = 0; }

  protected release(ctx: WeaponCtx): void {
    this.active = KATANA_CUTS[this.step];
    this.struck = false;
    this.idle = 0;
    this.tipTrail.length = 0;
    const f = ctx.sm.facing;

    if (this.active.heavy) {
      // The finisher commits: he steps through the cut, and the afterimages
      // carry the body around with the blade.
      ctx.sfx('heavyswing', 0.95);
      ctx.sm.dash(Math.cos(ctx.sm.pose.aim) * 175, ctx.sm.onGround ? -40 : 0);
      ctx.sm.addGhostBurst(this.active.anim * 0.8);
    } else {
      ctx.sfx('swing', rand(0.9, 1.1));
      ctx.sm.dash(f * 42);
      ctx.sm.addGhostBurst(0.12);
    }

    // Queue the next cut so the base class starts it with the right timing.
    this.step = (this.step + 1) % KATANA_CUTS.length;
    this.animLen = KATANA_CUTS[this.step].anim;
    this.cooldown = KATANA_CUTS[this.step].cooldown;
  }

  /** The resting guard: blade up beside the head, edge towards the target. */
  private kamae(ctx: WeaponCtx): number {
    const f = ctx.sm.facing;
    return ctx.sm.pose.aim + (-1.48 + Math.sin(ctx.time * 1.5) * 0.06) * f;
  }

  private bladeAngle(ctx: WeaponCtx): number {
    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    const rest = this.kamae(ctx);
    if (this.anim <= 0) return rest;

    const cut = this.active;
    const t = this.t;
    const from = a + cut.from * f;
    const to = a + cut.to * f;

    if (t < cut.wind) {
      // Coil: slow at first, then snapping into the top of the swing.
      return toward(rest, from, easeInCubic(t / cut.wind) * 0.4 + easeOutCubic(t / cut.wind) * 0.6);
    }
    if (t < cut.wind + cut.strike) {
      // The cut itself: almost all of the travel happens in the first third.
      return from + (to - from) * easeOutQuint((t - cut.wind) / cut.strike);
    }
    // Follow-through, then the blade drifts back up into the guard.
    const k = clamp((t - cut.wind - cut.strike) / Math.max(0.01, 1 - cut.wind - cut.strike), 0, 1);
    return toward(to, rest, k * k * 0.7);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.fx.update(ctx.dt);

    if (this.anim <= 0) {
      this.idle += ctx.dt;
      // Losing the rhythm drops him back to the opening cut.
      if (this.idle > 0.7 && this.step !== 0) {
        this.step = 0;
        this.animLen = KATANA_CUTS[0].anim;
        this.cooldown = KATANA_CUTS[0].cooldown;
      }
      return;
    }

    // Sample the tip every frame of the swing: that ribbon is the whole look.
    const h = ctx.sm.pose.handR;
    const ba = this.bladeAngle(ctx);
    this.tipTrail.push({ x: h.x + Math.cos(ba) * this.len, y: h.y + Math.sin(ba) * this.len });
    if (this.tipTrail.length > 16) this.tipTrail.shift();

    const cut = this.active;
    if (!this.struck && this.t > cut.wind + cut.strike * 0.4) {
      this.struck = true;
      const a = ctx.sm.pose.aim;
      const f = ctx.sm.facing;
      const from = a + cut.from * f;
      const to = a + cut.to * f;
      const r = this.len * cut.reach;
      const res = ctx.terrain.carveArc(h.x, h.y, r, from, to, cut.thick);

      // The visible crescent goes up whether or not it found anything: a cut
      // through empty air still has to look like a cut.
      this.fx.add(h.x, h.y, r, from, to, cut.thick * (cut.heavy ? 1.15 : 1.1),
        cut.heavy ? 0.32 : 0.22, cut.heavy ? 30 : 20);

      if (cut.heavy) {
        ctx.sfx('slash', 0.7);
        ctx.shake(17);
        ctx.flash(0.3);
        ctx.invert(0.045);
        ctx.particles.shockwave(h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, r * 0.6);
      } else if (res.removed > 0) {
        ctx.sfx('slash', rand(0.95, 1.2));
        ctx.shake(7);
      } else {
        ctx.sfx('slash', rand(1.2, 1.4));
      }

      if (res.removed > 0) {
        const tip = { x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r };
        impact(ctx, tip.x, tip.y, a, cut.heavy ? 1.3 : 0.8);
        ctx.sm.applyRecoil(cut.heavy ? 0.55 : 0.3, a, cut.heavy ? 60 : 25);
      }
    }
  }

  /** The finisher drops into a low, wide stance and drives up out of it. */
  override stance(ctx: WeaponCtx): Stance | null {
    if (this.anim <= 0 || !this.active.heavy) return null;
    const t = this.t;
    const cut = this.active;
    const k = t < cut.wind ? easeOutCubic(t / cut.wind) : Math.max(0, 1 - (t - cut.wind) / 0.34);
    if (k < 0.02) return null;
    return { kind: 'brace', weight: k * (ctx.sm.onGround ? 0.7 : 0.25), lean: -0.12, hip: -7 };
  }

  hands(ctx: WeaponCtx): HandTargets {
    const ba = this.bladeAngle(ctx);
    const f = ctx.sm.facing;
    // At rest the hands sit in front of the chest and the blade stands up out
    // of them - the guard. Mid-swing they ride the hilt instead, so the arms
    // lead the sword around rather than the sword floating off a static grip.
    const guardMain = grip(ctx, 33, 11 * f);
    const guardOff = grip(ctx, 27, 21 * f);
    if (this.anim <= 0) return { main: guardMain, off: guardOff };
    const k = smoothstep(Math.min(this.t, 1 - this.t) / 0.18);
    return {
      main: lerpVec(guardMain, gripAt(ctx, ba - 0.3 * f, 36, 3 * f), k),
      off: lerpVec(guardOff, gripAt(ctx, ba - 0.5 * f, 30, 13 * f), k),
    };
  }

  /** The cuts hang behind the figure, so a big slash never hides him. */
  override drawBehind(sk: Sketch): void { this.fx.draw(sk); }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ba = this.bladeAngle(ctx);
    const ca = Math.cos(ba), sa = Math.sin(ba);

    // Motion trail: a fan of afterimages plus the ribbon the tip carved.
    if (this.anim > 0) {
      const f = ctx.sm.facing;
      const cut = this.active;
      const swinging = this.t > cut.wind && this.t < cut.wind + cut.strike * 2.2;
      if (swinging) {
        c.save();
        c.globalAlpha = 0.32;
        c.lineWidth = 2;
        const back = Math.sign(cut.to - cut.from) * f;
        for (let i = 1; i <= 5; i++) {
          const a2 = ba - back * i * 0.17 * f;
          c.beginPath();
          c.moveTo(h.x + Math.cos(a2) * 16, h.y + Math.sin(a2) * 16);
          c.lineTo(h.x + Math.cos(a2) * this.len, h.y + Math.sin(a2) * this.len);
          c.stroke();
        }
        c.restore();
      }
      if (this.tipTrail.length > 2) {
        c.save();
        c.globalAlpha = 0.5;
        c.lineWidth = 2.4;
        c.beginPath();
        for (let i = 0; i < this.tipTrail.length; i++) {
          const p = this.tipTrail[i];
          if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
        }
        c.stroke();
        c.restore();
      }
    }

    // Guard, wrapped grip and blade.
    c.lineWidth = 3;
    const guard = { x: h.x + ca * 9, y: h.y + sa * 9 };
    const butt = { x: h.x - ca * 13, y: h.y - sa * 13 };
    sk.line(butt, guard, 4.4, 1, 0.5);
    for (let i = 1; i <= 2; i++) {
      const t = i / 3;
      const gx = butt.x + (guard.x - butt.x) * t, gy = butt.y + (guard.y - butt.y) * t;
      sk.line({ x: gx - sa * 3, y: gy + ca * 3 }, { x: gx + sa * 3, y: gy - ca * 3 }, 1.6, 1, 0.3);
    }
    // The tsuba, drawn as a small oval bar across the blade.
    sk.line({ x: guard.x - sa * 10, y: guard.y + ca * 10 }, { x: guard.x + sa * 10, y: guard.y - ca * 10 }, 3.4, 1, 0.5);
    // Slightly curved single-edged blade with a fuller line and a hard tip.
    const tip = { x: h.x + ca * this.len, y: h.y + sa * this.len };
    const bow = { x: (guard.x + tip.x) / 2 - sa * 8, y: (guard.y + tip.y) / 2 + ca * 8 };
    sk.curve(guard, bow, tip, 3.6, 0.5);
    sk.line({ x: guard.x - sa * 4, y: guard.y + ca * 4 }, tip, 1.6, 2, 0.5);
    sk.line({ x: tip.x - ca * 16 - sa * 4, y: tip.y - sa * 16 + ca * 4 }, tip, 2.2, 1, 0.4);

    // A glint running along the edge, brightest in the middle of a cut.
    const t = this.t;
    if (this.anim > 0 && t > this.active.wind * 0.6) {
      c.lineWidth = 2;
      sk.burst(tip.x, tip.y, 3, 4, 20, 2, 1.4, ba, 771);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.line({ x: x - s * 0.42, y: y + s * 0.38 }, { x: x + s * 0.42, y: y - s * 0.4 }, 2.6, 2, 0.5);
    sk.line({ x: x - s * 0.34, y: y + s * 0.14 }, { x: x - s * 0.08, y: y + s * 0.4 }, 2.2, 1, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 3. TWIN SHORTSWORDS
// ---------------------------------------------------------------------------
export class Shortswords extends Weapon {
  readonly id = 3;
  readonly name = 'TWIN SHORTSWORDS';
  readonly tagline = 'a blur, then a cross';
  override cooldown = 0.13;
  override auto = true;
  private struck = false;
  private readonly len = 54;
  /** 0-2 are the fast alternating cuts, 3 is the spinning cross. */
  private step = 0;
  private idle = 0;
  private fx = new SlashFx();
  private spin = 0;

  constructor() { super(); this.animLen = 0.13; }

  override onEquip(): void {
    super.onEquip();
    this.step = 0;
    this.animLen = 0.13;
    this.cooldown = 0.13;
  }

  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.fx.clear(); this.spin = 0; }

  /** True while the animation currently running is the cross finisher. */
  private get crossing(): boolean { return this.step === 0 && this.anim > 0; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    this.idle = 0;
    const finisher = this.step === 3;

    if (finisher) {
      // Leap, turn over, and put both blades through the same point.
      const f = ctx.sm.facing;
      ctx.sm.spinFlourish(f, 1);
      ctx.sm.dash(Math.cos(ctx.sm.pose.aim) * 150);
      ctx.sfx('heavyswing', 1.25);
      this.spin = 1;
    } else {
      ctx.sfx('stab', rand(1.05, 1.4));
    }

    this.step = (this.step + 1) % 4;
    const next = this.step === 3;
    this.animLen = next ? 0.34 : 0.13;
    this.cooldown = next ? 0.42 : 0.115;
  }

  protected override tick(ctx: WeaponCtx): void {
    this.fx.update(ctx.dt);
    this.spin = Math.max(0, this.spin - ctx.dt * 2.4);

    if (this.anim <= 0) {
      this.idle += ctx.dt;
      if (this.idle > 0.5 && this.step !== 0) {
        this.step = 0;
        this.animLen = 0.13;
        this.cooldown = 0.13;
      }
      return;
    }
    if (this.struck || this.t < 0.34) return;
    this.struck = true;

    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    const hand = grip(ctx, 30);

    if (this.crossing) {
      // Two crossing diagonals: an X cut straight into the face of the wall.
      const hit = ctx.terrain.raycast(hand.x, hand.y, Math.cos(a), Math.sin(a), 150, 3);
      const cx = hit ? hit.x : hand.x + Math.cos(a) * 96;
      const cy = hit ? hit.y : hand.y + Math.sin(a) * 96;
      const arm = 62;
      for (const d of [-0.7, 0.7]) {
        const ang = a + Math.PI / 2 + d;
        ctx.terrain.carveCapsule(
          cx - Math.cos(ang) * arm, cy - Math.sin(ang) * arm,
          cx + Math.cos(ang) * arm, cy + Math.sin(ang) * arm, 11, 0.3,
        );
        // Each stroke of the X gets its own hanging crescent.
        this.fx.add(hand.x, hand.y, 88, a - 1.15 * f * Math.sign(d), a + 1.05 * f * Math.sign(d), 22, 0.28, 34);
      }
      ctx.sfx('slash', 0.85);
      ctx.shake(13);
      ctx.flash(0.24);
      impact(ctx, cx, cy, a, 1.1);
      ctx.particles.shockwave(cx, cy, 74);
      ctx.sm.applyRecoil(0.4, a, 30);
      return;
    }

    // A fast alternating cut: short, shallow, and there are a lot of them.
    const lean = this.swap > 0 ? 1 : -1;
    const ang = a + rand(-0.05, 0.05);
    const from = ang + lean * f * 0.85;
    const to = ang - lean * f * 0.5;
    const res = ctx.terrain.carveArc(hand.x, hand.y, this.len + 22, from, to, 15);
    this.fx.add(hand.x, hand.y, this.len + 22, from, to, 13, 0.16, 22);
    if (res.removed > 0) {
      const tip = { x: hand.x + Math.cos(ang) * (this.len + 22), y: hand.y + Math.sin(ang) * (this.len + 22) };
      impact(ctx, tip.x, tip.y, ang, 0.32);
      ctx.shake(3.4);
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const t = this.t;
    const f = ctx.sm.facing;
    if (this.crossing) {
      // Arms thrown wide open, then snapped shut across the body.
      const open = t < 0.4 ? easeOutCubic(t / 0.4) : 1 - easeOutQuint((t - 0.4) / 0.6);
      const spread = 10 + open * 26;
      return {
        main: gripAt(ctx, ctx.sm.pose.aim - 0.5 * f * open, 34 + open * 8, -spread),
        off: gripAt(ctx, ctx.sm.pose.aim + 0.5 * f * open, 34 + open * 8, spread),
      };
    }
    const push = this.anim > 0 ? (t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6) : 0;
    const lead = this.swap > 0;
    const a = 34 + push * 14, b = 27 - push * 2;
    return {
      main: grip(ctx, lead ? a : b, lead ? -5 : 14),
      off: grip(ctx, lead ? b : a, lead ? 16 : -5),
    };
  }

  override drawBehind(sk: Sketch): void { this.fx.draw(sk); }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const aim = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    const t = this.t;
    const hands: Array<[Vec2, number]> = [
      [ctx.sm.pose.handR, this.crossing ? aim + 0.55 * f * (1 - t) : aim],
      [ctx.sm.pose.handL, this.crossing ? aim - 0.55 * f * (1 - t) : aim],
    ];

    for (const [h, ang] of hands) {
      this.blade(sk, h, ang);
    }

    if (this.anim > 0 && this.t < 0.5 && !this.crossing) {
      const h = this.swap > 0 ? ctx.sm.pose.handR : ctx.sm.pose.handL;
      c.lineWidth = 1.8;
      sk.burst(h.x + Math.cos(aim) * (this.len + 12), h.y + Math.sin(aim) * (this.len + 12), 3, 4, 16, 1.8, 1.2, aim, 31);
    }
  }

  /** A proper little sword: cross guard, tapered leaf blade, fuller, pommel. */
  private blade(sk: Sketch, h: Vec2, ang: number): void {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
    const L = this.len;
    sk.poly([
      at(L, 0), at(L * 0.78, -5.4), at(14, -6.2), at(11, -3), at(11, 3), at(14, 6.2), at(L * 0.78, 5.4),
    ], 2.4, false, 0.45);
    sk.line(at(15, 0), at(L * 0.86, 0), 1.3, 2, 0.35);          // fuller
    sk.line(at(11, -9), at(11, 9), 2.8, 1, 0.4);                // cross guard
    sk.line(at(-2, 0), at(11, 0), 3.2, 1, 0.4);                 // grip
    sk.line(at(-4, -3), at(-4, 3), 3, 1, 0.35);                 // pommel
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    for (const d of [-1, 1]) {
      sk.poly([
        { x: x + s * 0.44, y: y + d * s * 0.02 },
        { x: x + s * 0.1, y: y + d * s * 0.16 },
        { x: x - s * 0.16, y: y + d * s * 0.2 },
        { x: x - s * 0.16, y: y + d * s * 0.1 },
        { x: x + s * 0.1, y: y + d * s * 0.06 },
      ], 2, false, 0.4);
      sk.line({ x: x - s * 0.14, y: y + d * s * 0.3 }, { x: x - s * 0.2, y: y - d * s * 0.02 }, 2, 1, 0.3);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. GREATSWORD
// ---------------------------------------------------------------------------
/**
 * A slab of a sword. Everything about it is slower than the katana - the coil,
 * the swing, the recovery - and in exchange one hit takes a bite out of the
 * wall that a dozen dagger cuts could not.
 */
export class Greatsword extends Weapon {
  readonly id = 4;
  readonly name = 'GREATSWORD';
  readonly tagline = 'winds up slow, lands like a truck';
  override cooldown = 1.05;
  override auto = true;
  private struck = false;
  private readonly len = 158;
  private fx = new SlashFx();
  /** Alternates between the overhead chop and the horizontal sweep. */
  private overhead = true;
  private tipTrail: Vec2[] = [];

  constructor() { super(); this.animLen = 0.86; }

  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.fx.clear(); this.tipTrail.length = 0; }

  private get wind(): number { return 0.44; }
  private get strike(): number { return 0.16; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    this.overhead = !this.overhead;
    this.tipTrail.length = 0;
    ctx.sfx('heavyswing', 0.8);
    ctx.sm.addGhostBurst(0.5);
  }

  private rest(ctx: WeaponCtx): number {
    // Carried on the shoulder, tip up and back. Where he happens to be aiming
    // does not enter into it: the thing is too heavy to point at anything.
    return mirror(-2.45 + Math.sin(ctx.time * 1.1) * 0.05, ctx.sm.facing);
  }

  private bladeAngle(ctx: WeaponCtx): number {
    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    if (this.anim <= 0) return this.rest(ctx);
    const t = this.t;
    const from = a + (this.overhead ? -1.8 : 2.0) * f;
    const to = a + (this.overhead ? 0.8 : -0.9) * f;
    if (t < this.wind) {
      // The coil takes its time and drags the whole body back with it.
      return toward(this.rest(ctx), from, easeOutCubic(t / this.wind));
    }
    if (t < this.wind + this.strike) {
      return from + (to - from) * easeOutQuint((t - this.wind) / this.strike);
    }
    const k = clamp((t - this.wind - this.strike) / Math.max(0.01, 1 - this.wind - this.strike), 0, 1);
    // A long, heavy recovery: the blade hangs where it landed, then comes up.
    return toward(to, this.rest(ctx), easeInCubic(k) * 0.9);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.fx.update(ctx.dt);
    if (this.anim <= 0) return;

    const h = ctx.sm.pose.handR;
    const ba = this.bladeAngle(ctx);
    this.tipTrail.push({ x: h.x + Math.cos(ba) * this.len, y: h.y + Math.sin(ba) * this.len });
    if (this.tipTrail.length > 14) this.tipTrail.shift();

    // The wind-up hauls dust off the floor: the swing is telegraphed on purpose.
    if (this.t < this.wind && Math.random() < 0.3) {
      ctx.particles.updraft(ctx.sm.pos.x, ctx.sm.pos.y - 4, 1, 26, 90);
    }

    if (this.struck || this.t < this.wind + this.strike * 0.4) return;
    this.struck = true;

    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    const from = a + (this.overhead ? -1.8 : 2.0) * f;
    const to = a + (this.overhead ? 0.8 : -0.9) * f;
    const r = this.len * 0.82;
    const res = ctx.terrain.carveArc(h.x, h.y, r, from, to, 54);
    this.fx.add(h.x, h.y, r, from, to, 60, 0.36, 26);

    ctx.sfx('slam', 0.85);
    ctx.shake(24);
    ctx.flash(0.4);
    ctx.invert(0.06);
    ctx.sm.applyRecoil(0.8, a, 40);
    const tip = { x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r };
    ctx.particles.shockwave(tip.x, tip.y, r * 0.6);
    ctx.particles.streaks(tip.x, tip.y, 14, a, 1.4, 90);

    if (res.removed > 0) {
      impact(ctx, tip.x, tip.y, a, 1.6);
      ctx.particles.debris(tip.x, tip.y, 30, 420, a + Math.PI, 2.6);
    }

    // An overhead chop keeps going into the floor and splits it open ahead.
    if (this.overhead) {
      const gy = ctx.sm.pos.y - 6;
      const x0 = ctx.sm.pos.x + f * 40;
      ctx.terrain.carveCapsule(x0, gy, x0 + f * 260, gy + 10, 13, 0.5);
      ctx.particles.debris(x0 + f * 120, gy, 16, 300, -Math.PI / 2, 1.6);
      ctx.particles.updraft(x0 + f * 130, gy, 10, 110, 190);
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    const ba = this.bladeAngle(ctx);
    const f = ctx.sm.facing;
    // Both fists on a long hilt, dragged around by the weight of the head.
    const drive = this.anim > 0 ? 38 : 30;
    return {
      main: gripAt(ctx, ba - 0.34 * f, drive, 4 * f),
      off: gripAt(ctx, ba - 0.52 * f, drive - 12, 12 * f),
    };
  }

  override stance(ctx: WeaponCtx): Stance | null {
    if (this.anim <= 0) return null;
    const t = this.t;
    // Sink into the coil, then drive up through the swing.
    const k = t < this.wind ? easeOutCubic(t / this.wind) : Math.max(0, 1 - (t - this.wind) / 0.3);
    if (k < 0.02) return null;
    return { kind: 'brace', weight: k * (ctx.sm.onGround ? 0.75 : 0.3), lean: -0.16, hip: -8 };
  }

  override drawBehind(sk: Sketch): void { this.fx.draw(sk); }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ba = this.bladeAngle(ctx);
    const ca = Math.cos(ba), sa = Math.sin(ba);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });

    if (this.anim > 0 && this.tipTrail.length > 2) {
      c.save();
      c.globalAlpha = 0.45;
      c.lineWidth = 3;
      c.beginPath();
      for (let i = 0; i < this.tipTrail.length; i++) {
        const p = this.tipTrail[i];
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.stroke();
      c.restore();
    }

    const L = this.len;
    // Hilt, then a huge cross guard, then a slab of a blade with a bevel line.
    sk.line(at(-26, 0), at(20, 0), 4.6, 2, 0.5);
    sk.line(at(-26, -5), at(-26, 5), 4, 1, 0.4);
    sk.line(at(20, -19), at(20, 19), 4.4, 1, 0.5);
    sk.line(at(24, -13), at(20, -19), 3, 1, 0.4);
    sk.line(at(24, 13), at(20, 19), 3, 1, 0.4);
    sk.poly([
      at(L, 0), at(L * 0.9, -13), at(L * 0.44, -17), at(24, -15),
      at(24, 15), at(L * 0.44, 17), at(L * 0.9, 13),
    ], 3.4, false, 0.6);
    sk.line(at(30, -6), at(L * 0.9, -4), 1.6, 2, 0.4);
    sk.line(at(30, 6), at(L * 0.9, 4), 1.6, 2, 0.4);

    // Weight lines trailing the head of the blade through the swing.
    if (this.anim > 0 && this.t > this.wind && this.t < this.wind + this.strike * 2.6) {
      c.save();
      c.globalAlpha = 0.3;
      c.lineWidth = 2.4;
      const dir = this.overhead ? 1 : -1;
      for (let i = 1; i <= 4; i++) {
        const a2 = ba - dir * ctx.sm.facing * i * 0.2;
        c.beginPath();
        c.moveTo(h.x + Math.cos(a2) * 28, h.y + Math.sin(a2) * 28);
        c.lineTo(h.x + Math.cos(a2) * L, h.y + Math.sin(a2) * L);
        c.stroke();
      }
      c.restore();
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x + s * 0.42, y: y - s * 0.42 }, { x: x + s * 0.2, y: y - s * 0.44 },
      { x: x - s * 0.24, y: y + s * 0.1 }, { x: x - s * 0.1, y: y + s * 0.24 },
      { x: x + s * 0.44, y: y - s * 0.2 },
    ], 2.2, false, 0.5);
    sk.line({ x: x - s * 0.34, y: y - s * 0.04 }, { x: x - s * 0.02, y: y + s * 0.28 }, 2.4, 1, 0.4);
    sk.line({ x: x - s * 0.42, y: y + s * 0.16 }, { x: x - s * 0.22, y: y + s * 0.38 }, 2.4, 1, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 5. WARHAMMER
// ---------------------------------------------------------------------------
/**
 * The other end of the melee scale: no edge, no finesse, just a head the size
 * of an anvil coming down. It craters instead of cutting, and the ground picks
 * the shock up and carries it forward.
 */
export class Warhammer extends Weapon {
  readonly id = 5;
  readonly name = 'WARHAMMER';
  readonly tagline = 'one swing, one crater';
  override cooldown = 1.25;
  override auto = true;
  private struck = false;
  private readonly shaft = 112;
  private smashT = 0;

  constructor() { super(); this.animLen = 0.98; }

  private get wind(): number { return 0.48; }
  private get strike(): number { return 0.15; }

  protected release(ctx: WeaponCtx): void {
    this.struck = false;
    ctx.sfx('heavyswing', 0.62);
    ctx.sm.addGhostBurst(0.55);
  }

  private rest(ctx: WeaponCtx): number {
    // Head resting on the floor in front of him: he has to heave it up off the
    // ground before anything happens, which is the whole point of the weapon.
    return mirror(0.86 + Math.sin(ctx.time * 1.05) * 0.03, ctx.sm.facing);
  }

  private headAngle(ctx: WeaponCtx): number {
    const a = ctx.sm.pose.aim;
    const f = ctx.sm.facing;
    if (this.anim <= 0) return this.rest(ctx);
    const t = this.t;
    const from = a - 2.35 * f;      // hauled up and over behind the shoulder
    const to = a + 1.25 * f;        // straight down through the target
    if (t < this.wind) return toward(this.rest(ctx), from, easeOutCubic(t / this.wind));
    if (t < this.wind + this.strike) {
      return from + (to - from) * easeOutQuint((t - this.wind) / this.strike);
    }
    const k = clamp((t - this.wind - this.strike) / Math.max(0.01, 1 - this.wind - this.strike), 0, 1);
    return toward(to, this.rest(ctx), easeInCubic(k) * 0.85);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.smashT = Math.max(0, this.smashT - ctx.dt);
    if (this.anim <= 0) return;

    if (this.t < this.wind && Math.random() < 0.34) {
      ctx.particles.updraft(ctx.sm.pos.x, ctx.sm.pos.y - 4, 1, 30, 80);
    }
    if (this.struck || this.t < this.wind + this.strike * 0.55) return;
    this.struck = true;

    const f = ctx.sm.facing;
    const h = ctx.sm.pose.handR;
    const ang = this.headAngle(ctx);
    const tip = { x: h.x + Math.cos(ang) * this.shaft, y: h.y + Math.sin(ang) * this.shaft };

    // Find something to hit: whatever the head sweeps into, or the floor below.
    const swept = ctx.terrain.raycast(h.x, h.y, Math.cos(ang), Math.sin(ang), this.shaft + 26, 3);
    let at: Vec2 | null = swept;
    if (!at) {
      const drop = ctx.terrain.groundBelow(tip.x, tip.y, 110);
      if (drop < 110) at = { x: tip.x, y: tip.y + drop };
    }

    this.smashT = 0.22;
    ctx.sm.applyRecoil(1.0, ctx.sm.pose.aim, 30);

    if (!at) {
      // A clean miss still moves air.
      ctx.sfx('heavyswing', 1.1);
      ctx.shake(6);
      ctx.particles.streaks(tip.x, tip.y, 8, ang, 1.6, 60);
      return;
    }

    applyBlast(ctx.terrain, at.x, at.y, BLASTS.maul);
    ctx.sfx('slam', 0.95);
    ctx.shake(30);
    ctx.flash(0.55);
    ctx.invert(0.075);
    ctx.particles.shockwave(at.x, at.y, 150);
    ctx.particles.shockwave(at.x, at.y, 96);
    ctx.particles.debris(at.x, at.y, 46, 460);
    ctx.particles.sparks(at.x, at.y, 22, 520);
    ctx.particles.smoke(at.x, at.y, 8, 26);
    ctx.particles.updraft(at.x, at.y, 14, 60, 240);

    // The shock runs out along the ground on both sides of the impact.
    for (const d of [-1, 1]) {
      const gx = at.x + d * 40;
      const drop = ctx.terrain.groundBelow(gx, at.y - 10, 140);
      if (drop >= 140) continue;
      const gy = at.y - 10 + drop;
      ctx.terrain.carveCapsule(gx, gy, gx + d * 150, gy + 12, 12, 0.55);
      ctx.particles.updraft(gx + d * 80, gy, 6, 60, 200);
    }
    // Everything nearby gets thrown, the player included.
    const dx = ctx.sm.pos.x - at.x, dy = (ctx.sm.pos.y - 40) - at.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 200) ctx.sm.dash(-Math.cos(ctx.sm.pose.aim) * 90, -110 * (1 - dist / 200));
    void f;
  }

  hands(ctx: WeaponCtx): HandTargets {
    const ba = this.headAngle(ctx);
    const f = ctx.sm.facing;
    const drive = this.anim > 0 ? 36 : 26;
    return {
      main: gripAt(ctx, ba - 0.3 * f, drive, 5 * f),
      off: gripAt(ctx, ba - 0.5 * f, drive - 16, 14 * f),
    };
  }

  override stance(ctx: WeaponCtx): Stance | null {
    if (this.anim <= 0) return null;
    const t = this.t;
    const k = t < this.wind ? easeOutCubic(t / this.wind) : Math.max(0, 1 - (t - this.wind) / 0.34);
    if (k < 0.02) return null;
    return { kind: 'brace', weight: k * (ctx.sm.onGround ? 0.85 : 0.3), lean: -0.2, hip: -12 };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ang = this.headAngle(ctx);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
    const L = this.shaft;

    // Haft.
    sk.line(at(-30, 0), at(L - 26, 0), 5, 2, 0.6);
    sk.line(at(-30, -5), at(-30, 5), 4, 1, 0.4);
    // The head: a heavy block with a striking face and a spike behind it.
    sk.poly([
      at(L - 30, -25), at(L + 4, -25), at(L + 4, 25), at(L - 30, 25),
    ], 3.6, false, 0.7);
    sk.line(at(L - 2, -25), at(L - 2, 25), 2.4, 1, 0.5);
    sk.poly([at(L - 30, -13), at(L - 46, -6), at(L - 46, 6), at(L - 30, 13)], 3, false, 0.5);
    sk.line(at(L - 30, -25), at(L - 30, 25), 2.6, 1, 0.5);

    // Weight lines through the fall, and a flash of impact on landing.
    if (this.anim > 0 && this.t > this.wind && this.t < this.wind + this.strike * 3) {
      c.save();
      c.globalAlpha = 0.32;
      c.lineWidth = 3;
      for (let i = 1; i <= 4; i++) {
        const a2 = ang - ctx.sm.facing * i * 0.22;
        c.beginPath();
        c.moveTo(h.x + Math.cos(a2) * 40, h.y + Math.sin(a2) * 40);
        c.lineTo(h.x + Math.cos(a2) * (L + 8), h.y + Math.sin(a2) * (L + 8));
        c.stroke();
      }
      c.restore();
    }
    if (this.smashT > 0) {
      const k = this.smashT / 0.22;
      const tip = at(L + 6, 0);
      c.lineWidth = 3.4;
      sk.burst(tip.x, tip.y, 11, 12, 30 + k * 70, 3.4, TAU, 0, 909);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.line({ x: x - s * 0.4, y: y + s * 0.4 }, { x: x + s * 0.18, y: y - s * 0.18 }, 2.8, 2, 0.5);
    sk.poly([
      { x: x + s * 0.06, y: y - s * 0.3 }, { x: x + s * 0.42, y: y - s * 0.44 },
      { x: x + s * 0.5, y: y - s * 0.12 }, { x: x + s * 0.14, y: y + s * 0.02 },
    ], 2.4, false, 0.5);
  }
}
// ---------------------------------------------------------------------------
// 6. PISTOL
// ---------------------------------------------------------------------------
export class Pistol extends Weapon {
  readonly id = 6;
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
// 7. ASSAULT RIFLE
// ---------------------------------------------------------------------------
export class Rifle extends Weapon {
  readonly id = 7;
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
// 8. SHOTGUN
// ---------------------------------------------------------------------------
export class Shotgun extends Weapon {
  readonly id = 8;
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
// 9. ROCKET LAUNCHER
// ---------------------------------------------------------------------------
export class RocketLauncher extends Weapon {
  readonly id = 9;
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
// 10. SIEGE CANNON
// ---------------------------------------------------------------------------
export class Cannon extends Weapon {
  readonly id = 10;
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
    this.startAnim();
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
// 11. FIRE MAGIC
// ---------------------------------------------------------------------------
export class FireMagic extends Weapon {
  readonly id = 11;
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
// 12. ENERGY BEAM
// ---------------------------------------------------------------------------
export class EnergyBeam extends Weapon {
  readonly id = 12;
  readonly name = 'PWNAGE BEAM';
  readonly tagline = 'gather everything, then let go';
  override cooldown = 1.5;
  override chargeTime = 0.85;
  private beam = 0;
  private beamMax = 0.62;
  private beamAngle = 0;
  private power = 1;
  private sfxTimer = 0;
  /** Latched when the charge begins: a charge started in the air stays in the air. */
  private airborne = false;
  private charging = false;
  /** Smoothed aura level, so it swells in and out instead of snapping. */
  private aura = 0;
  private auraSfx = 0;
  /** Held above zero through the beam, so the aura does not blink off on release. */
  private thrust = 0;

  override onEquip(): void {
    super.onEquip();
    this.aura = 0;
    this.charging = false;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.beam = 0;
    this.aura = 0;
    this.charging = false;
  }

  protected release(ctx: WeaponCtx, power: number): void {
    this.beam = this.beamMax;
    this.power = 0.45 + power * 0.55;
    this.beamAngle = ctx.sm.pose.aim;
    this.thrust = 1;
    ctx.sfx('beam', 0.6);
    ctx.flash(0.55 * this.power);
    ctx.invert(0.07);
    ctx.shake(18 * this.power);
    ctx.particles.shockwave(ctx.sm.center.x, ctx.sm.center.y, 150 * this.power);
    ctx.sm.addGhostBurst(0.2);
    if (this.airborne) {
      // Fired from a float: the recoil shoves him back and up, and only when
      // the beam dies does the stance let go and gravity take him down again.
      ctx.sm.dash(-Math.cos(this.beamAngle) * 70, -Math.sin(this.beamAngle) * 40 - 30);
    }
  }

  protected override tick(ctx: WeaponCtx): void {
    const charging = this.charge > 0.01;

    // Latch where this charge started. Once he is holding himself up, a stray
    // frame near the floor must not drop him out of the float.
    if (charging && !this.charging) {
      this.charging = true;
      this.airborne = !ctx.sm.onGround;
    }
    if (!charging && this.beam <= 0) this.charging = false;

    this.thrust = Math.max(0, this.thrust - ctx.dt * 1.6);
    const level = Math.max(this.charge, this.beam > 0 ? 0.8 : 0, this.thrust * 0.6);
    this.aura = damp(this.aura, level, level > this.aura ? 9 : 5, ctx.dt);

    // --- the charge itself: the whole screen should feel it building --------
    if (charging) {
      const k = this.charge;
      ctx.shake(1.6 + k * 7);
      this.auraSfx -= ctx.dt;
      if (this.auraSfx <= 0) { ctx.sfx('aura', 0.7 + k * 0.7); this.auraSfx = 0.34; }

      const feet = ctx.sm.pos.y;
      if (ctx.sm.onGround) {
        // Floor debris tearing loose and climbing the aura.
        if (Math.random() < 0.25 + k * 0.7) {
          ctx.particles.updraft(ctx.sm.pos.x, feet - 4, 1, 34 + k * 46, 120 + k * 220);
        }
      } else if (Math.random() < k * 0.5) {
        ctx.particles.sparks(ctx.sm.pos.x + rand(-30, 30), feet + rand(-10, 20), 1, 130, -Math.PI / 2, 1.4);
      }
      if (Math.random() < k * 0.4) {
        // Chips climbing the edges of the aura rather than crossing the figure.
        const c = ctx.sm.center;
        ctx.particles.updraft(c.x + (Math.random() < 0.5 ? -1 : 1) * rand(38, 62), c.y + rand(-30, 30), 1, 6, 150 + k * 200);
      }
    }

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
    // Floating, the recoil pushes him rather than his feet, so it is halved.
    ctx.sm.applyRecoil(0.5, a, 260 * ctx.dt * this.power * (this.airborne ? 0.5 : 1));
    ctx.shake(9 * k * this.power);

    this.sfxTimer -= ctx.dt;
    if (this.sfxTimer <= 0) { ctx.sfx('beam', rand(0.85, 1.2)); this.sfxTimer = 0.06; }

    const hit = ctx.terrain.raycast(origin.x, origin.y, Math.cos(a), Math.sin(a), 1600, 6);
    if (hit) {
      ctx.particles.debris(hit.x, hit.y, 3, 320, a + Math.PI, 2.2);
      ctx.particles.sparks(hit.x, hit.y, 4, 400, a + Math.PI, 2.4);
    }
  }

  /**
   * The pose. On the ground he plants himself and arches back into the charge;
   * in the air the same charge holds him up, and he fires from a float before
   * the power lets go and drops him.
   */
  override stance(_ctx: WeaponCtx): Stance | null {
    const k = Math.max(this.charge * 2.4, this.beam > 0 ? 1 : 0, this.thrust);
    if (k < 0.03) return null;
    const w = clamp(k, 0, 1);
    if (this.airborne) return { kind: 'hover', weight: w, lean: -0.12, hip: 4 };
    return { kind: 'brace', weight: w * 0.9, lean: -0.3, hip: -14 };
  }

  hands(ctx: WeaponCtx): HandTargets {
    const f = ctx.sm.facing;
    if (this.beam > 0) {
      // Thrust out along the beam, one hand stacked on the other.
      const k = this.beam / this.beamMax;
      const fwd = 40 + (1 - k) * 4;
      return { main: grip(ctx, fwd, -7), off: grip(ctx, fwd - 3, 7) };
    }
    const k = this.charge;
    // Cupped at the hip, drawn back behind the body as the charge builds.
    const ang = ctx.sm.pose.aim + (2.35 + k * 0.25) * f;
    const r = 26 + k * 8;
    return { main: gripAt(ctx, ang, r, -8 * f), off: gripAt(ctx, ang, r - 4, 8 * f) };
  }

  /**
   * The aura, drawn under the figure: a jagged sheet of energy standing up off
   * the body, the ink-and-paper version of a power-up that is about to go off.
   */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const k = this.aura;
    if (k < 0.03) return;
    const c = sk.ctx;
    const sm = ctx.sm;
    const feet = sm.pos.y;
    const top = sm.pose.head.y - HEAD_R;
    const cx = sm.pos.x;
    const cy = (feet + top) / 2;
    const rx = 54 + 30 * k;
    const ry = (feet - top) / 2 + 14 + 30 * k;

    c.save();
    c.strokeStyle = '#000';
    c.fillStyle = '#000';

    // One jagged silhouette, filled white. Filling it is what keeps the figure
    // readable: the aura burns the wall back off him instead of scribbling on
    // top of him, and the alternating radius turns the blob into fire.
    const n = 22;
    const pts: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * TAU;
      const spike = i % 2 === 0 ? 1.2 : 0.86;
      // Everything is dragged upwards: an aura climbs, it does not float.
      const up = Math.max(0, -Math.sin(a));
      const flick = 1 + hashNoise(i * 3, sk.boil) * 0.16 + Math.sin(i * 2.3 + ctx.time * 11) * 0.07;
      const r1 = rx * spike * flick;
      const r2 = ry * spike * flick * (1 + up * (0.35 + k * 0.5));
      pts.push({ x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r2 });
    }
    c.globalAlpha = 0.92;
    c.fillStyle = '#fff';
    sk.polyPath(pts, 1.4);
    c.fill();
    c.globalAlpha = 0.9;
    c.lineWidth = 2.4;
    c.fillStyle = '#000';
    sk.poly(pts, 2.4, false, 1.4);

    // Tongues licking up past the head, kept out to the sides so they frame
    // the figure instead of scribbling over him.
    c.globalAlpha = 0.8;
    c.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const off = side * (0.55 + Math.abs(hashNoise(i * 7, sk.boil)) * 0.6) * rx;
      const base = { x: cx + off, y: cy + ry * 0.4 };
      const len = (30 + 54 * k) * (0.6 + Math.abs(hashNoise(i * 11, sk.boil)) * 0.8);
      const tip = { x: base.x + off * 0.3, y: top - len * 0.45 };
      const ctrl = { x: base.x + hashNoise(i * 13, sk.boil) * 22, y: (base.y + tip.y) / 2 };
      sk.curve(base, ctrl, tip, 2, 1.8);
    }

    // Radiating charge lines, and a shockwave ring standing on the floor.
    c.globalAlpha = 0.7;
    c.lineWidth = 2.2;
    sk.burst(cx, cy, 12, rx * 1.25, rx * (1.7 + k), 2.2, TAU, 0, 3101);

    if (sm.onGround) {
      c.globalAlpha = 0.6;
      c.lineWidth = 2.6;
      const rr = 40 + 70 * k;
      const ring: Vec2[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        ring.push({ x: cx + Math.cos(a) * rr, y: feet - 2 + Math.sin(a) * rr * 0.26 });
      }
      sk.poly(ring, 2.6, false, 1.6);
      sk.burst(cx, feet - 4, 9, rr * 0.5, rr * 1.15, 2.2, Math.PI * 1.1, Math.PI, 3102);
    } else {
      // Floating: the power blows downwards out from under him instead.
      c.globalAlpha = 0.65;
      c.lineWidth = 2.4;
      sk.burst(cx, feet + 8, 8, 12, 40 + 60 * k, 2.4, 1.5, Math.PI / 2, 3103);
    }
    c.restore();
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
      const n = 10;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + ctx.time * 0.7;
        const phase = ((ctx.time * 1.6 + i * 0.13) % 1);
        // Never start inside the body: the gathering lines converge on the
        // hands from outside the figure, they do not cross it.
        const r0 = 62 + (1 - phase) * 150 * k;
        const r1 = r0 + 30 + k * 60;
        c.beginPath();
        c.moveTo(mid.x + Math.cos(ang) * r0, mid.y + Math.sin(ang) * r0);
        c.lineTo(mid.x + Math.cos(ang) * r1, mid.y + Math.sin(ang) * r1);
        c.stroke();
      }
      // The core itself: a solid blob with a white bite out of the middle.
      const core = 7 + k * 13;
      c.fillStyle = '#000';
      sk.polyPath(circlePts(mid.x, mid.y, core, 11, ctx.time * 2), 1.6);
      c.fill();
      c.fillStyle = '#fff';
      sk.polyPath(circlePts(mid.x, mid.y, core * 0.45, 9, -ctx.time * 3), 1.2);
      c.fill();
      c.fillStyle = '#000';
      c.lineWidth = 2.6;
      sk.burst(mid.x, mid.y, 8, 16 + k * 16, 30 + k * 44, 2.6, TAU, 0, 707);
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
  // Melee first, then the guns, then the two that stop being weapons and start
  // being weather. The order is the order of the number keys.
  return [
    new Fists(), new Katana(), new Shortswords(), new Greatsword(), new Warhammer(),
    new Pistol(), new Rifle(), new Shotgun(), new RocketLauncher(), new Cannon(),
    new FireMagic(), new EnergyBeam(),
  ];
}

export { applyBlast };
