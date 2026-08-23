import {
  clamp, damp, hashNoise, rand, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { dragAngle, MeleeWeapon, type MeleeMode, type MeleeMove } from './melee';
import { applyBlast, BLASTS, Projectile } from './projectiles';
import { HEAD_R, type HandTargets, type Stance } from './stickman';
import { grip, gripAt, mirror, Weapon, type WeaponCtx } from './weapon-base';
import { Shout, SplitHead, Titan } from './weapons-forms';
import { ArcaneStaff, Mecha, MissilePods, Shinobi, Thunderbolt, Wind } from './weapons-video';

export { Weapon };
export type { WeaponCtx };

// ---------------------------------------------------------------------------
// 1. FISTS
// ---------------------------------------------------------------------------
/**
 * Four punches on the ground, a shoulder charge out of a run, a dive out of a
 * jump, a pair of haymakers if you lean on the button - and, if you keep
 * leaning on it, the barrage. No weapon to draw, so everything has to be in
 * the arms and in what comes off the knuckles.
 */
/** Seconds of held trigger before the haymakers turn into the barrage. */
const BARRAGE_HOLD = 0.6;
/** How long it can run before he is out of it. */
const BARRAGE_MAX = 5;
/** Seconds between blows. Fast enough that you cannot count them. */
const BARRAGE_RATE = 0.075;
/** How far in front of his chest the barrage can find a wall to hit. */
const BARRAGE_REACH = 235;

/** One blow of the barrage, for the fraction of a second it is on the paper. */
interface BigPunch {
  x: number; y: number;
  ang: number; size: number;
  life: number; max: number;
  seed: number;
}
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
  readonly tagline = 'four punches, then hold on';
  protected readonly len = 74;
  protected readonly sets = FIST_SETS;

  /** Seconds the barrage has been running; zero when it is not. */
  private barrageT = 0;
  /** Set when it has run its full length: no more until the trigger comes up. */
  private spent = false;
  /** Rate limiter for the blows themselves. */
  private punchT = 0;
  private punches: BigPunch[] = [];

  constructor() { super(); this.animLen = 0.18; this.cooldown = 0.16; }

  override onEquip(): void { super.onEquip(); this.endBarrage(); this.punches.length = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.endBarrage(); }

  private endBarrage(): void {
    this.barrageT = 0;
    this.spent = false;
    this.punchT = 0;
  }

  /**
   * Once the barrage is up, the arms come off the drawing entirely. They are
   * moving faster than fifteen frames a second can say anything about, and two
   * limbs vibrating in place read as a mistake; the storm of impacts in front
   * of his chest is the whole action, and it should be the only thing there.
   */
  override get hidesArms(): boolean { return this.barrageT > 0.08; }

  override get comboLabel(): string | null {
    if (this.barrageT > 0) {
      // Counting down what is left of it, because five seconds of this is a
      // resource and the player should be able to see it going.
      return `BARRAGE  ${Math.max(0, BARRAGE_MAX - this.barrageT).toFixed(1)}`;
    }
    return super.comboLabel;
  }

  /**
   * Once the barrage is up the ordinary chain stops coming out - and it stays
   * stopped after the five seconds are gone, until the trigger is released. An
   * empty barrage dropping the player back into haymakers would read as the
   * flurry restarting rather than as running out.
   */
  protected override suppressFire(): boolean {
    return this.heldFor > BARRAGE_HOLD;
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    super.tick(ctx, held);
    for (let i = this.punches.length - 1; i >= 0; i--) {
      this.punches[i].life -= ctx.dt;
      if (this.punches[i].life <= 0) this.punches.splice(i, 1);
    }

    if (!held || this.heldFor <= BARRAGE_HOLD) {
      if (this.barrageT > 0 || this.spent) this.endBarrage();
      return;
    }
    if (this.spent) return;

    this.barrageT += ctx.dt;
    if (this.barrageT >= BARRAGE_MAX) {
      // Out of it. A real recovery, so the last blow lands and then nothing
      // does for a moment.
      this.spent = true;
      this.barrageT = 0;
      this.cooldown = 0.8;
      this.timer = 0.8;
      ctx.sfx('heavyswing', 0.6);
      return;
    }
    // He is leaning into it, so the whole figure creeps forward as it runs,
    // and the arms are moving fast enough to smear.
    ctx.sm.dash(ctx.sm.facing * 26 * ctx.dt);
    ctx.sm.addGhostBurst(0.12);
    ctx.shake(2.5);

    this.punchT -= ctx.dt;
    if (this.punchT > 0) return;
    this.punchT = BARRAGE_RATE;
    this.throwPunch(ctx);
  }

  /**
   * One blow of the barrage. It is not a hand reaching the wall - his arm is
   * nowhere near it - it is the *shock* of the punch arriving there as a fist
   * several times the size of his own, which is exactly how the reference
   * draws a flurry that matters.
   */
  private throwPunch(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const c = sm.pose.chest;
    const a = sm.pose.aim + rand(-0.34, 0.34);
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = ctx.terrain.strikePoint(c.x, c.y, ca, sa, BARRAGE_REACH, 3);
    const at = hit ?? { x: c.x + ca * 150, y: c.y + sa * 150 };
    // Every fifth or so lands properly, so the flurry has a beat in it instead
    // of being one continuous noise.
    const big = Math.random() < 0.28;
    const size = (big ? 74 : 48) * rand(0.85, 1.25);

    if (hit) {
      // Wide and shallow. The reference draws its ink on *paper* - the wall
      // has already gone where the blow lands, and the spikes and the hand
      // read black on white. A narrow deep bite leaves the effect sitting on
      // the black slab where half of it cannot be seen at all.
      ctx.terrain.carveBlob(at.x, at.y, size * 1.05, 0.42, 18, size * 0.34);
      ctx.particles.debris(at.x, at.y, big ? 4 : 2, 260, a + Math.PI, 2.4);
      ctx.particles.streaks(at.x, at.y, big ? 6 : 3, a + Math.PI, 1.9, 40 + size);
    }
    // They outlive the gap between blows on purpose: four or five of them
    // overlapping at once is what makes it a flurry rather than a metronome.
    this.punches.push({
      x: at.x, y: at.y, ang: a, size,
      life: 0.26, max: 0.26, seed: Math.floor(rand(0, 9999)),
    });
    if (this.punches.length > 9) this.punches.shift();

    ctx.sfx('punch', (big ? 0.68 : 1) * rand(0.9, 1.2));
    ctx.shake(big ? 8 : 3.5);
    if (big) ctx.flash(0.1);
    sm.applyRecoil(0.14, a, 0);
  }

  /** Leaning bodily into the flurry for as long as it lasts. */
  override stance(ctx: WeaponCtx): Stance | null {
    if (this.barrageT <= 0) return super.stance(ctx);
    const k = clamp(this.barrageT / 0.25, 0, 1);
    return { kind: 'brace', weight: k * 0.85, lean: 0.2, hip: -10 };
  }

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
    // Through the barrage the arms are not drawn at all, so there is nothing
    // to place: the pose is the lean, and the effect does the rest.
    if (this.barrageT > 0) return null;
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
    if (this.punches.length > 0) this.drawPunches(sk);
    if (this.anim <= 0 || this.t > 0.62) return;
    const mv = this.move;
    const big = !!mv.heavy || (mv.thick ?? 0) > 24;
    const h = this.swap > 0 || mv.kind !== 'thrust' ? ctx.sm.pose.handR : ctx.sm.pose.handL;
    const a = ctx.sm.pose.aim;
    sk.ctx.lineWidth = big ? 3 : 2.2;
    sk.burst(h.x, h.y, big ? 7 : 4, 8, big ? 40 : 22, big ? 3 : 2.2, big ? 2.4 : 1.5, a + Math.PI, 77);
  }

  /**
   * The barrage itself, and the whole point of the weapon.
   *
   * Not a tidy fist: a blow going off. Each one is a ragged white hole punched
   * in the picture with a heavy ink edge, a wild fan of tapered slivers thrown
   * out of it in every direction, and a handful of long loose scrawls dragging
   * back down the line it came in on. Nothing in it is even, nothing is
   * measured, and each one keeps opening out as it fades - which between them
   * is the difference between "a hand touched the wall" and the frantic mess
   * the reference actually draws.
   */
  private drawPunches(sk: Sketch): void {
    const c = sk.ctx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    // Only the newest blow gets a hand drawn on it. The reference never has
    // two of these on the paper at once - what the older ones leave behind is
    // their ink and their speed lines, and five overlapping mittens read as a
    // bunch of grapes rather than as a fist.
    const newest = this.punches.length - 1;
    for (let pi = 0; pi < this.punches.length; pi++) {
      const p = this.punches[pi];
      const k = p.life / p.max;                    // 1 -> 0
      const open = 1 - k;
      const s = p.size * (0.8 + open * 0.4);
      const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
      const at = (d: number, o: number): Vec2 =>
        ({ x: p.x + ca * d - sa * o, y: p.y + sa * d + ca * o });
      c.globalAlpha = clamp(k * 1.7, 0, 1);

      // The fist, which the reference draws as a cloud of overlapping rounded
      // knuckles in *outline* - no fill, no heavy edge, every stroke the same
      // weight as the stick figure's own. It is several times the size of his
      // actual hand, which is the whole joke, and it is left open so the wall
      // shows through it.
      c.strokeStyle = '#000';
      // Three times his own height, which is what the reference draws. A fist
      // the size of a fist is just a fist; the joke is the scale.
      const F = s * 2.8;
      // Knuckles are ovals, squashed across the line of the punch; balls read
      // as fruit. Everything below is drawn in that squashed frame.
      const oval = (dx: number, dy: number, r: number, n: number): Vec2[] => {
        const q = at(dx, dy);
        const pts: Vec2[] = [];
        for (let i2 = 0; i2 < n; i2++) {
          const a2 = (i2 / n) * TAU;
          const ex = Math.cos(a2) * r * 0.82, ey = Math.sin(a2) * r * 1.08;
          pts.push({ x: q.x + ca * ex - sa * ey, y: q.y + sa * ex + ca * ey });
        }
        return pts;
      };
      // A mitten: one big mass for the back of the hand and a row of knuckles
      // along the leading edge.
      const lobes: Array<[number, number, number]> = [
        [-F * 0.5, F * 0.02, F * 0.5],
        [-F * 0.02, -F * 0.3, F * 0.34],
        [F * 0.16, F * 0.02, F * 0.33],
        [F * 0.1, F * 0.34, F * 0.3],
        [-F * 0.2, F * 0.5, F * 0.26],
      ];
      // Knocked back once behind the whole hand so it reads over the black
      // wall, then outlined - never filled per lobe, or it turns into a bunch
      // of grapes instead of a hand.
      if (pi === newest) {
        c.fillStyle = '#fff';
        for (const [dx, dy, r] of lobes) {
          sk.polyPath(oval(dx, dy, r, 15), 1.4);
          c.fill();
        }
        c.lineWidth = 2.8;
        for (const [dx, dy, r] of lobes) {
          sk.polyPath(oval(dx, dy, r, 15), 1.4);
          c.stroke();
        }
      }
      // The creases between the knuckles, and one fingernail.
      if (pi === newest) {
        c.lineWidth = 2.4;
        for (let i2 = 0; i2 < 2; i2++) {
          sk.line(at(-F * 0.16, -F * 0.16 + i2 * F * 0.34),
            at(F * 0.16, -F * 0.1 + i2 * F * 0.34), 2.4, 1, 0.7);
        }
        sk.polyPath(oval(F * 0.04, -F * 0.36, F * 0.1, 9), 0.9);
        c.stroke();
      }

      // Long thin speed slivers raining past it on the line it came in on -
      // solid black, sharply pointed, scattered well clear of the hand rather
      // than through it. Half of what sells the speed is these.
      c.fillStyle = '#000';
      for (let i2 = 0; i2 < 9; i2++) {
        const o = hashNoise(p.seed + i2 * 5, sk.boil) * F * 1.9;
        const back = F * (0.9 + Math.abs(hashNoise(p.seed + i2 * 9, sk.boil)) * 2.2);
        const l = F * (0.28 + Math.abs(hashNoise(p.seed + i2 * 3, sk.boil)) * 0.55);
        const q = at(-back, o);
        sk.tuftPath(q.x, q.y, 1, 0, l, 0.1, p.ang + Math.PI, p.seed + i2, 0.04);
        c.fill();
      }
      // And a small clump of ink at the contact point itself. Small: the
      // reference marks a hit, it does not stab the drawing with it.
      const bite = at(F * 0.42, 0);
      sk.tuftPath(bite.x, bite.y, 16, s * 0.06, s * (0.8 + open * 0.5), 2.8,
        p.ang + Math.PI, p.seed + 51, 0.05);
      c.fill();
    }
    c.globalAlpha = 1;
    c.restore();
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
// 2. GREATSWORD
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
  readonly id = 2;
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
   * He never lifts it. Standing or walking, the point is on the floor behind
   * him and stays there - the weapon is simply heavier than he is, and the
   * only time it comes up off the ground is the swing itself. Only in mid-air,
   * with no floor to rest on, does it go up over the shoulder.
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
    // On the ground it is always down, whether he is moving or not.
    const wants = sm.onGround ? 1 : 0;
    this.dragT = damp(this.dragT, wants, wants > 0 ? 7 : 5, ctx.dt);
    // Standing still it just lies there; the noise and the sparks are what
    // dragging it *along* costs.
    if (this.dragT < 0.4 || wants === 0 || speed <= 26) return;

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

    // Sparks where the edge is actually touching the floor - and only while it
    // is being hauled along it.
    if (this.anim <= 0 && this.dragT > 0.5 && Math.abs(ctx.sm.vel.x) > 26) {
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
// 3. WARHAMMER
// ---------------------------------------------------------------------------
/**
 * The other end of the melee scale, and deliberately absurd: a head about as
 * tall as he is on a haft he can barely get both hands round. It craters
 * instead of cutting, the ground picks the shock up and carries it forward,
 * and every landing asks for the biggest fan of lines the game can draw -
 * `impact: 2` is a sheet of speed lines across a third of the screen, which is
 * how the reference punctuates a blow this size.
 */
const MAUL = BLASTS.maul;
const MAUL_LIGHT = { ...MAUL, radius: MAUL.radius * 0.85, debris: Math.round(MAUL.debris * 0.8) };
const MAUL_BIG = { ...MAUL, radius: MAUL.radius * 1.4, debris: Math.round(MAUL.debris * 1.4) };

const HAMMER_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    {
      // Straight up over the head and straight back down, which is the swing
      // the reference draws: everything above him, then everything below.
      from: -2.45, to: 1.05, wind: 0.5, strike: 0.15, anim: 1.0, cooldown: 1.1, reach: 0.92, thick: 66,
      blast: MAUL, heavy: true, impact: 2, flash: 0.55, invert: 0.075, shake: 30, quake: 1.6,
      hitSfx: 'slam', hitPitch: 0.9, stance: 'brace', stanceLean: -0.22, stanceHip: -14, name: 'SMASH',
    },
    {
      from: 2.25, to: -0.55, wind: 0.42, strike: 0.16, anim: 0.86, cooldown: 0.95, reach: 0.94, thick: 84,
      heavy: true, impact: 1.8, dash: 90, flash: 0.34, invert: 0.05, shake: 24, quake: 1.1,
      hitSfx: 'slam', hitPitch: 1.0, name: 'LOW SWEEP',
    },
  ],
  run: [
    {
      from: -2.1, to: 1.15, wind: 0.34, strike: 0.16, anim: 0.78, cooldown: 0.9, reach: 0.94, thick: 74,
      blast: MAUL_LIGHT, heavy: true, impact: 1.9, dash: 260, slide: 0.22, flash: 0.4, invert: 0.05,
      shake: 26, quake: 1.2, hitSfx: 'slam', hitPitch: 0.95, stance: 'lunge', stanceHip: -14,
      name: 'RUNNING SWING',
    },
  ],
  air: [
    {
      from: -1.6, to: 1.3, wind: 0.28, strike: 0.16, anim: 0.56, cooldown: 0.95, reach: 0.96, thick: 74,
      blast: MAUL_BIG, heavy: true, impact: 2, lift: -520, flash: 0.6, invert: 0.08, shake: 32, quake: 1.8,
      hitSfx: 'slam', hitPitch: 0.76, name: 'METEOR',
    },
  ],
  hold: [
    {
      from: 2.8, to: -1.45, wind: 0.4, strike: 0.18, anim: 1.1, cooldown: 1.3, reach: 0.98, thick: 96,
      blast: MAUL_BIG, heavy: true, impact: 2, spin: 1, hop: 235, flash: 0.6, invert: 0.085, shake: 34,
      quake: 1.7, hitSfx: 'slam', hitPitch: 0.68, name: 'GIANT SWING',
    },
  ],
};

export class Warhammer extends MeleeWeapon {
  readonly id = 3;
  readonly name = 'WARHAMMER';
  readonly tagline = 'the head is bigger than he is';
  protected readonly len = 168;
  protected readonly sets = HAMMER_SETS;

  /** Half the height of the striking face, and how deep the block runs. */
  private readonly headW = 44;
  private readonly headD = 56;

  private dragT = 0;
  private scraped = 0;

  constructor() {
    super();
    this.animLen = 1.0;
    this.cooldown = 1.15;
    this.gripFwd = 34;
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
    // The head is a block hanging off the end of the shaft, so the tip that
    // actually finds the floor is a whole head-depth short of the full length.
    const drag = dragAngle(ctx, ctx.sm.pose.handR, this.len - this.headD * 0.6, ctx.sm.facing);
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
    ctx.particles.dust(tip.x, tip.y, 3, back, 1);
    ctx.particles.sparks(tip.x, tip.y - 2, 2, 90, back, 1.4);
    ctx.sfx('scrape', clamp(0.4 + speed / 900, 0.4, 0.85));
  }

  protected restHands(ctx: WeaponCtx, ba: number): HandTargets {
    const f = ctx.sm.facing;
    // Both fists crowded onto the butt of the haft: the only way to hold
    // something with this much of its weight out at the far end.
    return {
      main: gripAt(ctx, ba - 0.3 * f, 24, 5 * f),
      off: gripAt(ctx, ba - 0.52 * f, 10, 14 * f),
    };
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ang: number): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
    const L = this.len;
    const W = this.headW;
    const D = this.headD;

    c.strokeStyle = '#000';
    // Haft: one heavy stroke, running well behind his hands so the thing has a
    // butt to counterweight against.
    sk.line(at(-46, 0), at(L - D + 8, 0), 6.5, 2, 0.6);
    sk.line(at(-46, -8), at(-46, 8), 5, 1, 0.4);
    // The collar the haft disappears into.
    sk.poly([at(L - D - 20, -15), at(L - D, -22), at(L - D, 22), at(L - D - 20, 15)], 3.6, false, 0.5);

    // The head: a plain slab, knocked out in white with a heavy ink edge. A
    // block this size drawn solid would swallow the figure every time it swung
    // past him, and drawn as bare outline it would vanish into the black wall
    // exactly where it matters - so it is white with an edge, like everything
    // else in here that has to read over both.
    const block = [at(L - D, -W), at(L + 12, -W), at(L + 12, W), at(L - D, W)];
    c.fillStyle = '#fff';
    sk.polyPath(block, 1.3);
    c.fill();
    sk.poly(block, 5.2, false, 1.3);
    // The striking face banded off the body of the block, and a seam behind it.
    sk.line(at(L, -W), at(L, W), 3.4, 1, 0.7);
    sk.line(at(L - D + 14, -W), at(L - D + 14, W), 2.6, 1, 0.7);

    // A flash of impact on landing, sized off the head rather than off nothing.
    if (this.striking > 0.55 && this.striking < 0.95) {
      const tip = at(L + 16, 0);
      c.lineWidth = 4;
      sk.burst(tip.x, tip.y, 13, 20, 110, 4, TAU, 0, 909);
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    // Long haft, and a head that takes up most of the box.
    sk.line({ x: x - s * 0.42, y: y + s * 0.44 }, { x: x + s * 0.06, y: y - s * 0.12 }, 3, 2, 0.5);
    sk.poly([
      { x: x - s * 0.14, y: y - s * 0.44 }, { x: x + s * 0.42, y: y - s * 0.44 },
      { x: x + s * 0.42, y: y + s * 0.06 }, { x: x - s * 0.14, y: y + s * 0.06 },
    ], 2.8, false, 0.5);
    sk.line({ x: x + s * 0.3, y: y - s * 0.44 }, { x: x + s * 0.3, y: y + s * 0.06 }, 2, 1, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 5. MAGNUM
// ---------------------------------------------------------------------------
/**
 * One hand, one hammer, and a hole out of all proportion to the thing that
 * made it. It is slow, it kicks the arm straight up, and every round takes a
 * proper bite out of the wall - the opposite trade to the rifle in every way.
 */
export class Magnum extends Weapon {
  readonly id = 5;
  readonly name = 'MAGNUM';
  readonly tagline = 'one hand, one hole, one at a time';
  override cooldown = 0.42;
  private flashT = 0;
  /** How far the barrel is still thrown up by the last round. */
  private kick = 0;

  constructor() { super(); this.animLen = 0.34; }

  protected release(ctx: WeaponCtx): void {
    const muzzle = grip(ctx, 52);
    const a = this.aimFrom(ctx, muzzle) + rand(-0.008, 0.008);
    this.flashT = 0.085;
    this.kick = 1;
    ctx.sfx('pistol', rand(0.6, 0.68));
    // Fired one-handed, so it throws the whole arm up and shoves him back.
    ctx.sm.applyRecoil(1.15, a, 85);
    ctx.shake(9);
    ctx.flash(0.12);
    ctx.particles.streaks(muzzle.x, muzzle.y, 6, a, 0.4, 70);
    ctx.particles.smoke(muzzle.x, muzzle.y, 2, 5);
    this.hitscan(ctx, muzzle, a, 1600, 17);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
    this.kick = Math.max(0, this.kick - ctx.dt * 3.4);
  }

  /**
   * One hand on it and nothing on the other: the off arm is left out of the
   * targets entirely, so it swings with the gait instead of coming up to a
   * support grip that is not there.
   */
  hands(ctx: WeaponCtx): HandTargets {
    return { main: grip(ctx, 38 - this.kick * 5, 1 - this.kick * 7), off: null };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    // The barrel is thrown up off the aim by the recoil and settles back down.
    const a = ctx.sm.pose.aim - ctx.sm.facing * this.kick * 0.5;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    c.strokeStyle = '#000';
    // A long-barrelled revolver: frame, heavy vented barrel, and a fat
    // cylinder sitting proud of it - which is the whole silhouette.
    sk.poly([
      { x: -7, y: -7 }, { x: 6, y: -8 }, { x: 30, y: -8 }, { x: 30, y: -2 },
      { x: 4, y: -1 }, { x: 2, y: 12 }, { x: -7, y: 13 },
    ], 3.2, false, 0.5);
    sk.poly([{ x: 5, y: -7 }, { x: 15, y: -7 }, { x: 15, y: 4 }, { x: 5, y: 4 }], 2.8, false, 0.45);
    sk.line({ x: 8, y: -7 }, { x: 8, y: 4 }, 1.8, 1, 0.3);        // cylinder flute
    sk.line({ x: 12, y: -7 }, { x: 12, y: 4 }, 1.8, 1, 0.3);
    sk.line({ x: 20, y: -11 }, { x: 20, y: -8 }, 2, 1, 0.3);      // rib and sight
    sk.line({ x: 18, y: -11 }, { x: 30, y: -11 }, 2.2, 1, 0.4);
    sk.line({ x: -5, y: -9 }, { x: 3, y: -9 }, 2.2, 1, 0.4);      // hammer spur
    if (this.flashT > 0) {
      this.muzzle(sk, 34, -5, 28, 101);
      c.lineWidth = 2.4;
      sk.burst(34, -5, 7, 8, 40, 2.4, 1.1, 0, 102);
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.3, y: y - s * 0.22 }, { x: x + s * 0.44, y: y - s * 0.24 },
      { x: x + s * 0.44, y: y - s * 0.08 }, { x: x - s * 0.02, y: y - s * 0.04 },
      { x: x - s * 0.08, y: y + s * 0.36 }, { x: x - s * 0.3, y: y + s * 0.38 },
    ], 2.2, false, 0.5);
    // The cylinder: the one part that says revolver and not pistol.
    sk.poly([
      { x: x - s * 0.12, y: y - s * 0.22 }, { x: x + s * 0.1, y: y - s * 0.22 },
      { x: x + s * 0.1, y: y + s * 0.02 }, { x: x - s * 0.12, y: y + s * 0.02 },
    ], 2, false, 0.4);
  }
}

// ---------------------------------------------------------------------------
// 6. ASSAULT RIFLE
// ---------------------------------------------------------------------------
export class Rifle extends Weapon {
  readonly id = 6;
  readonly name = 'ASSAULT RIFLE';
  readonly tagline = 'hold it down, watch it crumble';
  override cooldown = 0.072;
  override auto = true;
  private flashT = 0;
  private heat = 0;

  protected release(ctx: WeaponCtx): void {
    this.heat = Math.min(1, this.heat + 0.16);
    const muzzle = grip(ctx, 90);
    const a = this.aimFrom(ctx, muzzle) + rand(-1, 1) * (0.008 + this.heat * 0.055);
    this.flashT = 0.045;
    ctx.sfx('rifle', rand(0.94, 1.06));
    ctx.sm.applyRecoil(0.34, a, 12);
    ctx.shake(2.6);
    // Ejected brass.
    ctx.particles.sparks(muzzle.x - Math.cos(a) * 34, muzzle.y - Math.sin(a) * 34, 1, 150, -Math.PI / 2 + rand(-0.5, 0.5), 0.6);
    this.hitscan(ctx, muzzle, a, 1500, 5.6);
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

  /**
   * The emblem is the weapon in miniature rather than a generic gun outline:
   * shouldered stock, receiver, pistol grip, the curved magazine hanging out
   * of the middle of it, handguard, barrel, and the sight on top. The magazine
   * is the part that actually reads as "assault rifle" at this size, so it is
   * drawn as its own shape and given room.
   */
  icon(sk: Sketch, x: number, y: number, s: number): void {
    // Stock through receiver to muzzle, in one outline.
    sk.poly([
      { x: x - s * 0.46, y: y - s * 0.02 }, { x: x - s * 0.32, y: y - s * 0.14 },
      { x: x + s * 0.06, y: y - s * 0.14 }, { x: x + s * 0.1, y: y - s * 0.2 },
      { x: x + s * 0.34, y: y - s * 0.2 }, { x: x + s * 0.34, y: y - s * 0.12 },
      { x: x + s * 0.5, y: y - s * 0.12 }, { x: x + s * 0.5, y: y - s * 0.05 },
      { x: x + s * 0.08, y: y - s * 0.03 }, { x: x + s * 0.05, y: y + s * 0.22 },
      { x: x - s * 0.04, y: y + s * 0.22 }, { x: x - s * 0.06, y: y - s * 0.03 },
      { x: x - s * 0.32, y: y - s * 0.03 }, { x: x - s * 0.46, y: y + s * 0.06 },
    ], 2.1, false, 0.45);
    // Curved magazine.
    sk.poly([
      { x: x + s * 0.12, y: y - s * 0.02 }, { x: x + s * 0.24, y: y - s * 0.02 },
      { x: x + s * 0.3, y: y + s * 0.32 }, { x: x + s * 0.18, y: y + s * 0.34 },
    ], 2.1, false, 0.4);
    // Optic rail and front sight.
    sk.line({ x: x + s * 0.12, y: y - s * 0.26 }, { x: x + s * 0.3, y: y - s * 0.26 }, 1.9, 1, 0.35);
    sk.line({ x: x + s * 0.44, y: y - s * 0.22 }, { x: x + s * 0.44, y: y - s * 0.12 }, 1.9, 1, 0.3);
  }
}

// ---------------------------------------------------------------------------
// 7. SHOTGUN
// ---------------------------------------------------------------------------
export class Shotgun extends Weapon {
  readonly id = 7;
  readonly name = 'SHOTGUN';
  readonly tagline = 'wide bites, hard kick';
  override cooldown = 0.72;
  private flashT = 0;

  constructor() { super(); this.animLen = 0.5; }

  protected release(ctx: WeaponCtx): void {
    const muzzle = grip(ctx, 84);
    const base = this.aimFrom(ctx, muzzle);
    this.flashT = 0.09;
    ctx.sfx('shotgun');
    ctx.shake(13);
    ctx.flash(0.22);
    ctx.sm.applyRecoil(1.1, base, 260);
    for (let i = 0; i < 11; i++) {
      const a = base + rand(-1, 1) * 0.17;
      this.hitscan(ctx, muzzle, a, 700, 6.8);
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
// 8. BAZOOKA
// ---------------------------------------------------------------------------
/**
 * One tube on the shoulder and one warhead in it. It replaces both of the old
 * artillery pieces, and it is meant to: nothing here needs a charge meter and
 * a wind-up to say "this is the big one" - a rocket the size of his torso
 * leaving a tube beside his ear already says it.
 */
export class Bazooka extends Weapon {
  readonly id = 8;
  readonly name = 'BAZOOKA';
  readonly tagline = 'shoulder it, and stand back';
  override cooldown = 1.15;
  private fireT = 0;

  constructor() { super(); this.animLen = 0.7; }

  protected release(ctx: WeaponCtx): void {
    const muzzle = grip(ctx, 96);
    const a = this.aimFrom(ctx, muzzle);
    ctx.projectiles.push(new Projectile({
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(a) * 1020, vy: Math.sin(a) * 1020,
      kind: 'rocket', gravity: 210, radius: 8, life: 5, blast: BLASTS.bazooka,
    }));
    this.fireT = 0.18;
    ctx.sfx('launch', 0.82);
    ctx.shake(12);
    ctx.flash(0.2);
    ctx.sm.applyRecoil(1.2, a, 170);
    // Backblast: everything the tube did not put into the rocket comes out of
    // the open end behind his shoulder.
    const back = grip(ctx, -26);
    ctx.particles.smoke(back.x, back.y, 9, 12);
    ctx.particles.sparks(back.x, back.y, 12, 320, a + Math.PI, 1.0);
    ctx.particles.streaks(back.x, back.y, 7, a + Math.PI, 0.8, 80);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.fireT = Math.max(0, this.fireT - ctx.dt);
  }

  hands(ctx: WeaponCtx): HandTargets {
    // Both hands under the tube, the rear one back at the trigger group.
    return { main: grip(ctx, 28, 11), off: grip(ctx, 48, 9) };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    // A long fat tube, flared at the back, with the warhead's nose showing.
    sk.poly([
      { x: -44, y: -17 }, { x: -32, y: -11 }, { x: 62, y: -11 }, { x: 62, y: 3 },
      { x: -32, y: 3 }, { x: -44, y: 10 },
    ], 3.2, false, 0.6);
    sk.line({ x: -32, y: -11 }, { x: -32, y: 3 }, 2.4, 1, 0.4);   // blast ring
    sk.poly([{ x: 62, y: -9 }, { x: 74, y: -4 }, { x: 62, y: 1 }], 2.6, false, 0.4); // warhead nose
    sk.line({ x: 4, y: -11 }, { x: 4, y: -23 }, 2.4, 1, 0.4);     // sight post
    sk.line({ x: -4, y: -23 }, { x: 14, y: -23 }, 2.4, 1, 0.4);
    sk.line({ x: -14, y: 3 }, { x: -16, y: 17 }, 3, 1, 0.5);      // trigger grip
    sk.line({ x: 24, y: 3 }, { x: 26, y: 15 }, 2.8, 1, 0.5);      // forward grip
    if (this.fireT > 0) {
      const k = this.fireT / 0.18;
      this.muzzle(sk, 78, -4, 34 * k, 404);
      c.lineWidth = 2.8;
      sk.burst(-42, -4, 8, 8, 54 * k, 2.8, 1.3, Math.PI, 405);
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    sk.poly([
      { x: x - s * 0.46, y: y - s * 0.18 }, { x: x + s * 0.28, y: y - s * 0.18 },
      { x: x + s * 0.28, y: y + s * 0.1 }, { x: x - s * 0.46, y: y + s * 0.1 },
    ], 2.2, false, 0.5);
    // The warhead poking out of the muzzle, which is what says bazooka.
    sk.poly([
      { x: x + s * 0.28, y: y - s * 0.16 }, { x: x + s * 0.5, y: y - s * 0.04 },
      { x: x + s * 0.28, y: y + s * 0.08 },
    ], 2.1, false, 0.4);
    sk.line({ x: x - s * 0.16, y: y + s * 0.1 }, { x: x - s * 0.2, y: y + s * 0.36 }, 2.2, 1, 0.4);
    sk.line({ x: x - s * 0.1, y: y - s * 0.18 }, { x: x - s * 0.1, y: y - s * 0.34 }, 2, 1, 0.3);
  }
}

// ---------------------------------------------------------------------------
// 14. ENERGY BEAM
// ---------------------------------------------------------------------------
/** How far down the firing line the beam is capable of reaching at all. */
const BEAM_RANGE = 1600;
/**
 * World units of masonry the beam eats per second while pressed against it.
 * The wall is a few hundred units thick, and one discharge lasts well under a
 * second, so a single beam bores most of the way in and no further.
 */
const BEAM_BORE = 340;

export class EnergyBeam extends Weapon {
  readonly id = 14;
  readonly name = 'PWNAGE BEAM';
  readonly tagline = 'gather everything, then let go';
  override cooldown = 1.5;
  override chargeTime = 0.85;
  private beam = 0;
  private beamMax = 0.62;
  private beamAngle = 0;
  /**
   * How far down the firing line the beam currently reaches. It stops where
   * the wall does and eats forward from there, so the column you see is the
   * column that is actually doing something.
   */
  private tip = BEAM_RANGE;
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
    this.tip = BEAM_RANGE;
    this.thrust = 1;
    ctx.sfx('beam', 0.6);
    ctx.flash(0.55 * this.power);
    ctx.invert(0.07);
    ctx.shake(5 * this.power);
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
      // The gathering is sold by the aura and the rubble climbing it, not by
      // shaking the paper apart: barely a tremor until it is nearly full.
      ctx.shake(0.4 + k * 1.8);
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
    // Wide enough that the shaft it leaves matches the column you can see: a
    // beam that draws a sixty-unit pillar has no business boring a scratch.
    const radius = (42 * this.power) * (0.45 + k * 0.55);
    const a = this.beamAngle;
    const ca = Math.cos(a), sa = Math.sin(a);

    // It does not go through the wall - it goes *into* it. Every frame the
    // beam finds the face it is pressed against and pushes the hole a little
    // further in, so a discharge drills a shaft rather than opening a doorway
    // in one flash. Hold it on one spot, or come back with a second charge,
    // and it will get all the way through; it just does not do it at once.
    const front = ctx.terrain.strikePoint(origin.x, origin.y, ca, sa, BEAM_RANGE, 6);
    const bore = BEAM_BORE * ctx.dt * this.power;
    const reach = front
      ? Math.hypot(front.x - origin.x, front.y - origin.y) + bore + radius
      : BEAM_RANGE;
    this.tip = Math.min(BEAM_RANGE, reach);
    // The capsule is only the beam's reach; how much of it comes off is the
    // bore rate, in world units of stone a second. Measuring it in time rather
    // than in polygon keeps it identical at fifteen frames a second and at
    // sixty, and keeps the beam eating forward from the face it is leaning on
    // instead of appearing at the far end of its own column.
    ctx.terrain.carveCapsule(
      origin.x, origin.y,
      origin.x + ca * this.tip, origin.y + sa * this.tip,
      radius, 0.16, bore,
    );
    // Floating, the recoil pushes him rather than his feet, so it is halved.
    ctx.sm.applyRecoil(0.5, a, 260 * ctx.dt * this.power * (this.airborne ? 0.5 : 1));
    ctx.shake(2.5 * k * this.power);

    this.sfxTimer -= ctx.dt;
    if (this.sfxTimer <= 0) { ctx.sfx('beam', rand(0.85, 1.2)); this.sfxTimer = 0.06; }

    // Everything it is chewing through comes back out of the hole at you.
    if (front) {
      ctx.particles.debris(front.x, front.y, 3, 320, a + Math.PI, 2.2);
      ctx.particles.sparks(front.x, front.y, 4, 400, a + Math.PI, 2.4);
      ctx.particles.smoke(front.x, front.y, 1, radius * 0.7);
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

  /**
   * Carrying it is not a pose. Until the trigger goes down he is a stick
   * figure walking around with his hands empty - null hands hand the arms back
   * to the gait - and the cupped stance only appears with the charge that
   * needs it, which is what makes the stance mean something when it arrives.
   */
  hands(ctx: WeaponCtx): HandTargets | null {
    const f = ctx.sm.facing;
    if (this.beam > 0) {
      // Thrust out along the beam, one hand stacked on the other.
      const k = this.beam / this.beamMax;
      const fwd = 40 + (1 - k) * 4;
      return { main: grip(ctx, fwd, -7), off: grip(ctx, fwd - 3, 7) };
    }
    const k = Math.max(this.charge, this.thrust);
    if (k < 0.02) return null;
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
      // Drawn to where it actually reaches: the column ends against the wall
      // with the far end packed into it, instead of a clean line out to the
      // horizon that says nothing about what it is doing.
      const L = Math.max(60, this.tip);
      const blocked = this.tip < BEAM_RANGE - 1;

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

      // And the same again where it is pressed into the wall: a white splash
      // spraying back down the line, which is what "pushing" looks like.
      if (blocked) {
        const end = p(L, 0);
        c.fillStyle = '#fff';
        sk.polyPath(circlePts(end.x, end.y, r * 1.15, 11, ctx.time * 3), 2.6);
        c.fill();
        c.strokeStyle = '#000';
        c.lineWidth = 3.4;
        sk.burst(end.x, end.y, 11, r * 0.9, r * (2.4 + Math.abs(hashNoise(4, sk.boil)) * 1.4),
          3.4, 2.5, a + Math.PI, 909);
      }
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
  // Hands and edges first, then the things with triggers, then the four that
  // stop being weapons and start being weather. The order is the order of the
  // number keys, so it also has to climb: slot 12 must feel like slot 12.
  return [
    new Fists(), new Greatsword(), new Warhammer(), new Wind(),
    new Magnum(), new Rifle(), new Shotgun(), new Bazooka(), new MissilePods(),
    new ArcaneStaff(), new Shinobi(), new Thunderbolt(), new Mecha(), new EnergyBeam(),
    new Shout(), new Titan(), new SplitHead(),
  ];
}

export { applyBlast };
