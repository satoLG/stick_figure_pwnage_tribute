import {
  clamp, damp, easeOutCubic, easeOutQuint, hashNoise, rand, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { dragAngle, MeleeWeapon, type MeleeMode, type MeleeMove } from './melee';
import { applyBlast, BLASTS, Projectile } from './projectiles';
import { HEAD_R, type HandTargets, type Stance } from './stickman';
import { grip, gripAt, mirror, Weapon, type WeaponCtx } from './weapon-base';

export { Weapon };
export type { WeaponCtx };

// ---------------------------------------------------------------------------
// 1. FISTS
// ---------------------------------------------------------------------------
/**
 * Four punches on the ground, a shoulder charge out of a run, a dive out of a
 * jump and a pair of haymakers if you lean on the button. No weapon to draw, so
 * everything has to be in the arms.
 */
const FIST_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    { kind: 'thrust', from: 0, to: 0, wind: 0.26, strike: 0.24, anim: 0.17, cooldown: 0.16, reach: 0.9, thick: 15, shake: 4, name: 'JAB' },
    { kind: 'thrust', from: 0, to: 0, wind: 0.24, strike: 0.24, anim: 0.18, cooldown: 0.17, reach: 0.95, thick: 17, shake: 5, name: 'CROSS' },
    {
      from: -0.95, to: 0.8, wind: 0.32, strike: 0.22, anim: 0.28, cooldown: 0.28, reach: 1, thick: 26,
      dash: 90, hitSfx: 'punch', shake: 9, name: 'HOOK',
    },
    {
      from: 1.25, to: -1.35, wind: 0.34, strike: 0.2, anim: 0.34, cooldown: 0.4, reach: 0.95, thick: 30,
      lift: 130, heavy: true, hitSfx: 'punch', hitPitch: 0.78, flash: 0.14, shake: 13, name: 'UPPERCUT',
    },
  ],
  run: [
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.24, strike: 0.24, anim: 0.3, cooldown: 0.34, reach: 1.15, thick: 26,
      dash: 300, slide: 0.2, stance: 'lunge', stanceHip: -10, stanceLean: 0.14, heavy: true,
      hitSfx: 'punch', hitPitch: 0.8, shake: 14, name: 'SHOULDER CHARGE',
    },
    {
      from: 2.2, to: -0.9, wind: 0.28, strike: 0.2, anim: 0.4, cooldown: 0.42, reach: 1.05, thick: 28,
      spin: 1, hop: 150, dash: 120, hitSfx: 'punch', hitPitch: 0.7, flash: 0.16, shake: 15, name: 'SPIN KICK',
    },
  ],
  air: [
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.22, strike: 0.24, anim: 0.26, cooldown: 0.28, reach: 1.05, thick: 22,
      dash: 110, lift: -240, hitSfx: 'punch', hitPitch: 0.85, shake: 10, name: 'DIVE PUNCH',
    },
    {
      from: -2.3, to: 1.2, wind: 0.26, strike: 0.2, anim: 0.36, cooldown: 0.38, reach: 1, thick: 26,
      spin: 1, hitSfx: 'punch', hitPitch: 0.72, shake: 12, name: 'AXE KICK',
    },
  ],
  hold: [
    {
      from: -1.5, to: 1.05, wind: 0.48, strike: 0.16, anim: 0.5, cooldown: 0.5, reach: 1.05, thick: 40,
      dash: 130, heavy: true, hitSfx: 'punch', hitPitch: 0.62, flash: 0.24, invert: 0.04, shake: 20,
      quake: 0.7, name: 'HAYMAKER',
    },
    {
      from: 2.5, to: -1.2, wind: 0.42, strike: 0.18, anim: 0.54, cooldown: 0.56, reach: 1.05, thick: 42,
      spin: 1, hop: 170, heavy: true, hitSfx: 'punch', hitPitch: 0.58, flash: 0.28, invert: 0.05,
      shake: 22, name: 'BACKFIST',
    },
  ],
};

export class Fists extends MeleeWeapon {
  readonly id = 1;
  readonly name = 'BARE HANDS';
  readonly tagline = 'four punches, then something worse';
  protected readonly len = 74;
  protected readonly sets = FIST_SETS;

  constructor() { super(); this.animLen = 0.18; this.cooldown = 0.16; }

  protected restAngle(ctx: WeaponCtx): number { return ctx.sm.pose.aim; }

  protected restHands(ctx: WeaponCtx): HandTargets {
    return { main: grip(ctx, 33, -4), off: grip(ctx, 30, 14) };
  }

  /**
   * Bare hands do not ride a hilt, so the generic blade grip is thrown away and
   * the arms are driven directly: jabs piston, hooks swing in from outside.
   */
  override hands(ctx: WeaponCtx): HandTargets | null {
    const t = this.t;
    const f = ctx.sm.facing;
    // Between punches the arms are released back to the gait, so running with
    // bare hands swings them instead of carrying a frozen guard around.
    if (this.anim <= 0 && Math.abs(ctx.sm.vel.x) > 45) return null;
    if (this.anim <= 0) return this.restHands(ctx);

    const mv = this.move;
    if (mv.kind === 'thrust') {
      // An ease-out thrust followed by a slower recovery.
      const push = t < 0.45 ? Math.pow(t / 0.45, 0.55) : 1 - (t - 0.45) / 0.55;
      const lead = this.swap > 0;
      const ext = 33 + push * 14;
      const back = 30 - push * 4;
      return {
        main: grip(ctx, lead ? ext : back, lead ? -4 : 12),
        off: grip(ctx, lead ? back : ext, lead ? 14 : -4),
      };
    }
    // A swinging punch: the fist comes in from outside the shoulder line.
    const ba = this.bladeAngle(ctx);
    const ext = 30 + Math.sin(clamp((t - 0.15) / 0.6, 0, 1) * Math.PI) * 18;
    return {
      main: gripAt(ctx, ba, ext, -6 * f),
      off: grip(ctx, 26, 16),
    };
  }

  /** No weapon: what you see is the shock coming off the knuckles. */
  protected drawWeapon(sk: Sketch, ctx: WeaponCtx): void {
    if (this.anim <= 0 || this.t > 0.62) return;
    const mv = this.move;
    const big = !!mv.heavy || (mv.thick ?? 0) > 24;
    const h = this.swap > 0 || mv.kind !== 'thrust' ? ctx.sm.pose.handR : ctx.sm.pose.handL;
    const a = ctx.sm.pose.aim;
    sk.ctx.lineWidth = big ? 3 : 2.2;
    sk.burst(h.x, h.y, big ? 7 : 4, 8, big ? 40 : 22, big ? 3 : 2.2, big ? 2.4 : 1.5, a + Math.PI, 77);
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
/**
 * Standing still it is a three cut kata with a whirlwind on the end. Out of a
 * run it is the one everybody wants: he drops under his own momentum, slides
 * past on one knee opening a cut as he goes, and springs straight back out of
 * it to where he started.
 */
const KATANA_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    { from: -1.75, to: 0.95, wind: 0.34, strike: 0.2, anim: 0.32, cooldown: 0.3, reach: 0.8, thick: 32, name: 'KESA' },
    { from: 1.35, to: -1.45, wind: 0.28, strike: 0.18, anim: 0.28, cooldown: 0.27, reach: 0.8, thick: 32, name: 'GYAKU' },
    {
      from: 2.35, to: -1.15, wind: 0.44, strike: 0.2, anim: 0.5, cooldown: 0.5, reach: 0.92, thick: 50,
      heavy: true, dash: 175, lift: 40, flash: 0.3, invert: 0.045, shake: 17, hitPitch: 0.7,
      stance: 'brace', stanceLean: -0.12, stanceHip: -7, name: 'DO-GIRI',
    },
    {
      from: -2.6, to: 1.4, wind: 0.3, strike: 0.18, anim: 0.52, cooldown: 0.6, reach: 0.95, thick: 52,
      heavy: true, spin: 1, hop: 190, dash: 90, flash: 0.34, invert: 0.05, shake: 19, hitPitch: 0.66,
      name: 'TSUMUJI',
    },
  ],
  run: [
    {
      // The one out of the source material: down onto one knee, a single flat
      // cut opening as he slides past, then straight back up and back off.
      from: 1.15, to: -0.6, wind: 0.3, strike: 0.14, anim: 0.46, cooldown: 0.4, reach: 0.98, thick: 42,
      dash: 470, slide: 0.3, recover: 330, ghost: 0.42,
      stance: 'crouch', stanceHip: -26, stanceLean: 0.18, stanceOut: 0.2,
      flash: 0.18, shake: 12, hitPitch: 0.9, name: 'IAI SLASH',
    },
    {
      from: -1.95, to: 0.7, wind: 0.24, strike: 0.16, anim: 0.34, cooldown: 0.32, reach: 0.9, thick: 36,
      dash: 210, slide: 0.14, ghost: 0.3, shake: 9, name: 'RETURN CUT',
    },
  ],
  air: [
    {
      from: -2.05, to: 1.3, wind: 0.26, strike: 0.18, anim: 0.34, cooldown: 0.3, reach: 0.9, thick: 38,
      dash: 60, shake: 10, name: 'TSUBAME',
    },
    {
      from: 2.4, to: -1.2, wind: 0.24, strike: 0.18, anim: 0.44, cooldown: 0.42, reach: 0.96, thick: 46,
      spin: 1, heavy: true, flash: 0.2, shake: 14, hitPitch: 0.78, name: 'FALLING WHEEL',
    },
  ],
  hold: [
    {
      from: -2.35, to: 1.1, wind: 0.46, strike: 0.16, anim: 0.55, cooldown: 0.5, reach: 0.96, thick: 52,
      heavy: true, dash: 70, flash: 0.26, invert: 0.04, shake: 20, quake: 0.6, hitPitch: 0.68,
      stance: 'lunge', stanceLean: -0.14, stanceHip: -12, name: 'OVERHEAD',
    },
    {
      from: 2.6, to: -1.6, wind: 0.4, strike: 0.18, anim: 0.62, cooldown: 0.6, reach: 1, thick: 58,
      heavy: true, spin: 1, hop: 205, flash: 0.32, invert: 0.055, shake: 22, hitPitch: 0.6,
      name: 'WIDE TSUMUJI',
    },
  ],
};

export class Katana extends MeleeWeapon {
  readonly id = 2;
  readonly name = 'KATANA';
  readonly tagline = 'three cuts, one breath';
  protected readonly len = 92;
  protected readonly sets = KATANA_SETS;

  constructor() { super(); this.animLen = 0.32; this.cooldown = 0.3; }

  /** The resting guard: blade up beside the head, edge towards the target. */
  protected restAngle(ctx: WeaponCtx): number {
    const f = ctx.sm.facing;
    return ctx.sm.pose.aim + (-1.48 + Math.sin(ctx.time * 1.5) * 0.06) * f;
  }

  protected restHands(ctx: WeaponCtx): HandTargets {
    const f = ctx.sm.facing;
    // At rest the hands sit in front of the chest and the blade stands up out
    // of them - the guard.
    return { main: grip(ctx, 33, 11 * f), off: grip(ctx, 27, 21 * f) };
  }

  /** A crouching slash throws grit off the floor for as long as it slides. */
  protected override onRelease(ctx: WeaponCtx, mv: MeleeMove): void {
    if (mv.stance !== 'crouch') return;
    const f = ctx.sm.facing;
    ctx.particles.dust(ctx.sm.pos.x - f * 10, ctx.sm.pos.y - 3, 6, f > 0 ? Math.PI : 0, 1.2);
    ctx.particles.streaks(ctx.sm.pos.x, ctx.sm.pos.y - 24, 6, f > 0 ? Math.PI : 0, 0.6, 70);
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ba: number): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ca = Math.cos(ba), sa = Math.sin(ba);

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
    if (this.striking > 0.02) {
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
const SHORTSWORD_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    { from: 0.85, to: -0.5, wind: 0.24, strike: 0.18, anim: 0.14, cooldown: 0.13, reach: 1.35, thick: 18, hitSfx: 'stab', hitPitch: 1.2, shake: 3, name: 'SLICE' },
    { from: -0.85, to: 0.5, wind: 0.24, strike: 0.18, anim: 0.14, cooldown: 0.13, reach: 1.35, thick: 18, hitSfx: 'stab', hitPitch: 1.25, shake: 3, name: 'SLICE' },
    { from: 0.7, to: -0.75, wind: 0.22, strike: 0.18, anim: 0.15, cooldown: 0.13, reach: 1.4, thick: 19, hitSfx: 'stab', hitPitch: 1.15, shake: 3.4, name: 'SLICE' },
    {
      from: -1.15, to: 1.05, wind: 0.36, strike: 0.2, anim: 0.34, cooldown: 0.42, reach: 1.6, thick: 30,
      cross: true, dash: 150, heavy: true, flash: 0.24, shake: 13, hitPitch: 0.85, name: 'CROSS CUT',
    },
  ],
  run: [
    {
      from: -1.0, to: 0.95, wind: 0.24, strike: 0.18, anim: 0.28, cooldown: 0.3, reach: 1.55, thick: 24,
      cross: true, dash: 360, slide: 0.22, ghost: 0.3, stance: 'lunge', stanceHip: -8, stanceLean: 0.12,
      shake: 9, hitPitch: 1.0, name: 'SCISSOR PASS',
    },
    {
      from: 1.2, to: -1.1, wind: 0.2, strike: 0.16, anim: 0.22, cooldown: 0.24, reach: 1.45, thick: 22,
      dash: 180, slide: 0.12, shake: 6, hitSfx: 'stab', name: 'PASSING CUT',
    },
  ],
  air: [
    {
      from: 2.5, to: -1.4, wind: 0.2, strike: 0.2, anim: 0.4, cooldown: 0.4, reach: 1.5, thick: 26,
      spin: 2, cross: true, flash: 0.2, shake: 11, hitPitch: 0.95, name: 'PROPELLER',
    },
  ],
  hold: [
    {
      from: -1.3, to: 1.2, wind: 0.4, strike: 0.18, anim: 0.42, cooldown: 0.44, reach: 1.65, thick: 34,
      cross: true, heavy: true, dash: 90, flash: 0.26, invert: 0.035, shake: 15, hitPitch: 0.8, name: 'RENDING X',
    },
    {
      from: 1.4, to: -1.4, wind: 0.34, strike: 0.18, anim: 0.46, cooldown: 0.5, reach: 1.6, thick: 34,
      spin: 1, hop: 175, cross: true, heavy: true, flash: 0.28, shake: 16, hitPitch: 0.76, name: 'BLENDER',
    },
  ],
};

export class Shortswords extends MeleeWeapon {
  readonly id = 3;
  readonly name = 'TWIN SHORTSWORDS';
  readonly tagline = 'a blur, then a cross';
  protected readonly len = 54;
  protected readonly sets = SHORTSWORD_SETS;

  constructor() {
    super();
    this.animLen = 0.14;
    this.cooldown = 0.13;
    this.gripFwd = 33;
  }

  protected restAngle(ctx: WeaponCtx): number { return ctx.sm.pose.aim; }

  protected restHands(ctx: WeaponCtx): HandTargets {
    const lead = this.swap > 0;
    return {
      main: grip(ctx, lead ? 36 : 28, lead ? -5 : 14),
      off: grip(ctx, lead ? 28 : 36, lead ? 16 : -5),
    };
  }

  /**
   * Both blades move: the main hand rides the cut, the off hand mirrors it, and
   * on a cross they open wide and snap shut through the same point.
   */
  override hands(ctx: WeaponCtx): HandTargets {
    if (this.anim <= 0) return this.restHands(ctx);
    const t = this.t;
    const f = ctx.sm.facing;
    const mv = this.move;
    const ba = this.bladeAngle(ctx);
    if (mv.cross) {
      const open = t < 0.4 ? easeOutCubic(t / 0.4) : 1 - easeOutQuint((t - 0.4) / 0.6);
      const spread = 10 + open * 26;
      return {
        main: gripAt(ctx, ba - 0.35 * f * open, 34 + open * 8, -spread),
        off: gripAt(ctx, ba + 0.5 * f * open, 34 + open * 8, spread),
      };
    }
    const push = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
    return {
      main: gripAt(ctx, ba - 0.2 * f, 32 + push * 10, -5),
      off: gripAt(ctx, ba + 0.55 * f, 28, 15),
    };
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ba: number): void {
    const c = sk.ctx;
    const f = ctx.sm.facing;
    const mv = this.move;
    const swinging = this.anim > 0;
    // The off blade trails the main one, or mirrors it through a cross.
    const offAngle = swinging && mv.cross ? ba + (mv.to - mv.from) * f * 0.55 : ba + 0.28 * f;
    this.blade(sk, ctx.sm.pose.handR, swinging ? ba : ctx.sm.pose.aim);
    this.blade(sk, ctx.sm.pose.handL, swinging ? offAngle : ctx.sm.pose.aim + 0.16 * f);

    if (this.striking > 0.02 && !mv.cross) {
      const h = ctx.sm.pose.handR;
      c.lineWidth = 1.8;
      sk.burst(h.x + Math.cos(ba) * (this.len + 12), h.y + Math.sin(ba) * (this.len + 12), 3, 4, 16, 1.8, 1.2, ba, 31);
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
 * wall that a dozen dagger cuts could not. Walking with it, he cannot hold the
 * thing up: the tip drags along the floor and throws sparks the whole way.
 */
const GREATSWORD_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    {
      from: -1.8, to: 0.8, wind: 0.44, strike: 0.16, anim: 0.8, cooldown: 0.95, reach: 0.82, thick: 54,
      heavy: true, flash: 0.4, invert: 0.06, shake: 24, quake: 1, hitSfx: 'slam', hitPitch: 0.85,
      stance: 'brace', stanceLean: -0.16, stanceHip: -8, name: 'CLEAVE',
    },
    {
      from: 2.0, to: -0.9, wind: 0.4, strike: 0.16, anim: 0.78, cooldown: 0.9, reach: 0.84, thick: 54,
      heavy: true, dash: 70, flash: 0.34, invert: 0.05, shake: 22, hitSfx: 'slam', hitPitch: 0.9,
      stance: 'brace', stanceLean: -0.14, stanceHip: -8, name: 'SWEEP',
    },
    {
      // The whole body turns with the sword and everything in front of him goes.
      from: -2.7, to: 1.5, wind: 0.34, strike: 0.18, anim: 0.9, cooldown: 1.1, reach: 0.95, thick: 62,
      heavy: true, spin: 1, hop: 215, dash: 110, flash: 0.5, invert: 0.07, shake: 28, quake: 1.2,
      hitSfx: 'slam', hitPitch: 0.78, name: 'WHIRLWIND',
    },
  ],
  run: [
    {
      // Out of the drag: the tip is already on the floor, so he just keeps
      // running and rips it up through everything in the way.
      from: 1.4, to: -1.35, wind: 0.3, strike: 0.18, anim: 0.62, cooldown: 0.7, reach: 0.9, thick: 50,
      heavy: true, dash: 230, slide: 0.26, lift: 90, flash: 0.3, shake: 20, quake: 0.8,
      hitSfx: 'slam', hitPitch: 0.95, name: 'RISING DRAG',
    },
    {
      from: -2.2, to: 1.0, wind: 0.32, strike: 0.16, anim: 0.68, cooldown: 0.78, reach: 0.88, thick: 52,
      heavy: true, dash: 150, slide: 0.16, flash: 0.34, invert: 0.04, shake: 22, quake: 1,
      hitSfx: 'slam', hitPitch: 0.85, stance: 'lunge', stanceHip: -12, name: 'RUNNING CLEAVE',
    },
  ],
  air: [
    {
      from: -1.6, to: 1.45, wind: 0.3, strike: 0.16, anim: 0.5, cooldown: 0.66, reach: 0.92, thick: 58,
      heavy: true, lift: -430, flash: 0.45, invert: 0.06, shake: 26, quake: 1.4,
      hitSfx: 'slam', hitPitch: 0.7, name: 'PLUNGE',
    },
  ],
  hold: [
    {
      from: -2.8, to: 1.6, wind: 0.38, strike: 0.2, anim: 1.15, cooldown: 1.3, reach: 1, thick: 68,
      heavy: true, spin: 2, hop: 265, dash: 90, flash: 0.55, invert: 0.08, shake: 30, quake: 1.4,
      hitSfx: 'slam', hitPitch: 0.66, name: 'DOUBLE WHIRLWIND',
    },
  ],
};

export class Greatsword extends MeleeWeapon {
  readonly id = 4;
  readonly name = 'GREATSWORD';
  readonly tagline = 'drags on the floor, lands like a truck';
  protected readonly len = 158;
  protected readonly sets = GREATSWORD_SETS;

  /** 0..1 blend into the "too heavy to carry" drag pose. */
  private dragT = 0;
  /** Metres of floor dragged since the last scrape, so sparks track speed. */
  private scraped = 0;

  constructor() {
    super();
    this.animLen = 0.8;
    this.cooldown = 0.95;
    this.gripFwd = 38;
    this.gripLead = 0.34;
  }

  override onEquip(): void { super.onEquip(); this.dragT = 0; }

  /**
   * Carried on the shoulder when he is standing, dragged behind him the moment
   * he starts moving: the tip finds the floor and stays on it.
   */
  protected restAngle(ctx: WeaponCtx): number {
    const shoulder = mirror(-2.45 + Math.sin(ctx.time * 1.1) * 0.05, ctx.sm.facing);
    if (this.dragT < 0.01) return shoulder;
    const drag = dragAngle(ctx, ctx.sm.pose.handR, this.len - 4, ctx.sm.facing);
    return drag === null ? shoulder : shoulder + (drag - shoulder) * this.dragT;
  }

  /** The drag itself: sparks, grit and a scraping edge for as long as he walks. */
  protected override idleTick(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const speed = Math.abs(sm.vel.x);
    const wants = sm.onGround && speed > 26 ? 1 : 0;
    this.dragT = damp(this.dragT, wants, wants > 0 ? 7 : 5, ctx.dt);
    if (this.dragT < 0.4 || wants === 0) return;

    const ang = this.restAngle(ctx);
    const h = sm.pose.handR;
    const tip = { x: h.x + Math.cos(ang) * this.len, y: h.y + Math.sin(ang) * this.len };
    this.scraped += speed * ctx.dt;
    if (this.scraped < 26) return;
    this.scraped = 0;
    const back = sm.vel.x > 0 ? Math.PI : 0;
    ctx.particles.sparks(tip.x, tip.y - 2, 2, 90 + speed * 0.6, back, 1.5);
    ctx.particles.dust(tip.x, tip.y, 1, back, 0.5);
    ctx.sfx('scrape', clamp(0.7 + speed / 500, 0.7, 1.5));
  }

  protected restHands(ctx: WeaponCtx, ba: number): HandTargets {
    const f = ctx.sm.facing;
    // Both fists on a long hilt, dragged around by the weight of the head.
    return {
      main: gripAt(ctx, ba - 0.34 * f, 30, 4 * f),
      off: gripAt(ctx, ba - 0.52 * f, 18, 12 * f),
    };
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ba: number): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ca = Math.cos(ba), sa = Math.sin(ba);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
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

    // Sparks where the edge is actually touching the floor.
    if (this.anim <= 0 && this.dragT > 0.5) {
      const tip = at(L, 0);
      c.save();
      c.globalAlpha = this.dragT;
      c.lineWidth = 2;
      sk.burst(tip.x, tip.y - 2, 4, 3, 14, 2, 1.5, ctx.sm.vel.x > 0 ? Math.PI : 0, 4141);
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
const MAUL = BLASTS.maul;
const MAUL_LIGHT = { ...MAUL, radius: MAUL.radius * 0.85, debris: Math.round(MAUL.debris * 0.8) };
const MAUL_BIG = { ...MAUL, radius: MAUL.radius * 1.4, debris: Math.round(MAUL.debris * 1.4) };

const HAMMER_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    {
      from: -2.35, to: 1.25, wind: 0.48, strike: 0.15, anim: 0.9, cooldown: 1.0, reach: 0.9, thick: 46,
      blast: MAUL, heavy: true, flash: 0.55, invert: 0.075, shake: 30, quake: 1.4,
      hitSfx: 'slam', hitPitch: 0.95, stance: 'brace', stanceLean: -0.2, stanceHip: -12, name: 'SMASH',
    },
    {
      from: 2.2, to: -0.55, wind: 0.42, strike: 0.16, anim: 0.78, cooldown: 0.9, reach: 0.92, thick: 62,
      heavy: true, dash: 90, flash: 0.34, invert: 0.05, shake: 24, quake: 0.9,
      hitSfx: 'slam', hitPitch: 1.05, name: 'LOW SWEEP',
    },
  ],
  run: [
    {
      from: -2.0, to: 1.1, wind: 0.34, strike: 0.16, anim: 0.72, cooldown: 0.85, reach: 0.92, thick: 54,
      blast: MAUL_LIGHT, heavy: true, dash: 260, slide: 0.22, flash: 0.4, invert: 0.05, shake: 26,
      quake: 1.1, hitSfx: 'slam', hitPitch: 1.0, stance: 'lunge', stanceHip: -12, name: 'RUNNING SWING',
    },
  ],
  air: [
    {
      from: -1.5, to: 1.5, wind: 0.28, strike: 0.16, anim: 0.52, cooldown: 0.9, reach: 0.95, thick: 54,
      blast: MAUL_BIG, heavy: true, lift: -520, flash: 0.6, invert: 0.08, shake: 32, quake: 1.6,
      hitSfx: 'slam', hitPitch: 0.8, name: 'METEOR',
    },
  ],
  hold: [
    {
      from: 2.7, to: -1.4, wind: 0.4, strike: 0.18, anim: 1.0, cooldown: 1.2, reach: 0.95, thick: 70,
      blast: MAUL_BIG, heavy: true, spin: 1, hop: 225, flash: 0.6, invert: 0.085, shake: 34, quake: 1.5,
      hitSfx: 'slam', hitPitch: 0.72, name: 'GIANT SWING',
    },
  ],
};

export class Warhammer extends MeleeWeapon {
  readonly id = 5;
  readonly name = 'WARHAMMER';
  readonly tagline = 'one swing, one crater';
  protected readonly len = 112;
  protected readonly sets = HAMMER_SETS;

  private dragT = 0;
  private scraped = 0;

  constructor() {
    super();
    this.animLen = 0.95;
    this.cooldown = 1.15;
    this.gripFwd = 36;
    this.gripLead = 0.3;
  }

  /**
   * Head resting on the floor in front of him: he has to heave it up off the
   * ground before anything happens, which is the whole point of the weapon -
   * and walking, it simply ploughs along behind.
   */
  protected restAngle(ctx: WeaponCtx): number {
    const carried = mirror(0.86 + Math.sin(ctx.time * 1.05) * 0.03, ctx.sm.facing);
    if (this.dragT < 0.01) return carried;
    // The head is a block hanging off the end of the shaft, so it rides a
    // little short of the full length.
    const drag = dragAngle(ctx, ctx.sm.pose.handR, this.len - 18, ctx.sm.facing);
    return drag === null ? carried : carried + (drag - carried) * this.dragT;
  }

  protected override idleTick(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const speed = Math.abs(sm.vel.x);
    const wants = sm.onGround && speed > 26 ? 1 : 0;
    this.dragT = damp(this.dragT, wants, wants > 0 ? 6 : 5, ctx.dt);
    if (this.dragT < 0.45 || wants === 0) return;
    const ang = this.restAngle(ctx);
    const h = sm.pose.handR;
    const tip = { x: h.x + Math.cos(ang) * this.len, y: h.y + Math.sin(ang) * this.len };
    this.scraped += speed * ctx.dt;
    if (this.scraped < 34) return;
    this.scraped = 0;
    const back = sm.vel.x > 0 ? Math.PI : 0;
    ctx.particles.dust(tip.x, tip.y, 2, back, 0.8);
    ctx.particles.sparks(tip.x, tip.y - 2, 1, 80, back, 1.4);
    ctx.sfx('scrape', clamp(0.45 + speed / 900, 0.45, 0.9));
  }

  protected restHands(ctx: WeaponCtx, ba: number): HandTargets {
    const f = ctx.sm.facing;
    return {
      main: gripAt(ctx, ba - 0.3 * f, 26, 5 * f),
      off: gripAt(ctx, ba - 0.5 * f, 12, 14 * f),
    };
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ang: number): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
    const L = this.len;

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

    // A flash of impact on landing.
    if (this.striking > 0.55 && this.striking < 0.95) {
      const tip = at(L + 6, 0);
      c.lineWidth = 3.4;
      sk.burst(tip.x, tip.y, 11, 12, 60, 3.4, TAU, 0, 909);
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
