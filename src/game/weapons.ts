import {
  clamp, damp, easeOutCubic, hashNoise, lerp, rand, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { dragAngle, MeleeWeapon, type MeleeMode, type MeleeMove } from './melee';
import { applyBlast, BLASTS, Projectile } from './projectiles';
import { HEAD_R, type HandTargets, type Stance } from './stickman';
import {
  grip, gripAt, headTilt, mirror, throwArms, toward, Weapon, type WeaponCtx,
} from './weapon-base';
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
/**
 * The barrage is a *ramp*, not a switch.
 *
 * It opens with punches you can count, thrown with the arms plainly drawn, and
 * every one of them lands sooner than the last. Somewhere around a second in
 * they are coming faster than fifteen frames a second can say anything about,
 * the arms stop being drawn and the field of drags takes over. Letting go runs
 * the same thing backwards: the blows slow down, the drags thin out and the
 * arms come back. Snapping straight into the storm was the thing that made it
 * read as a different weapon rather than as the same one, wound up.
 */
const RAMP_IN = 1.05;
const RAMP_OUT = 0.85;
/** Seconds between blows at the start of the ramp, and at full speed. */
const BARRAGE_SLOW = 0.2;
const BARRAGE_RATE = 0.055;
/** How far in front of his chest the barrage can find a wall to hit. */
const BARRAGE_REACH = 235;

/** One blow of the barrage: where it landed, for the ink it leaves there. */
interface BigPunch {
  x: number; y: number;
  ang: number; size: number;
  life: number; max: number;
  seed: number;
}

/**
 * One smear of the barrage, and the whole look of it.
 *
 * In the reference this is not a fist and it is not a starburst: it is a long
 * tapered drag of ink thrown backwards off him, blunt and hooked at the end
 * nearest his shoulder and drawn out to a point behind it, with the paper
 * showing through in nicks along its length the way a brush run dry does. At
 * any moment there are twenty of them at wildly different lengths and slightly
 * different angles, layered over each other and over him, and his arms are
 * simply not there any more.
 */
interface Smear {
  x: number; y: number;
  ang: number;
  len: number;
  width: number;
  /** How far it bows off its own axis. */
  bow: number;
  /** A few of them are drawn as open outlines instead of solid. */
  hollow: boolean;
  life: number; max: number;
  seed: number;
}
const FIST_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  // Punches. Only punches - no spin kicks, no axe kicks, nothing that turns
  // him over in the middle of a combination. A boxer plants and drives; every
  // strike here is a fist going out on a line, and what sells it is the body
  // moving under it rather than the figure pirouetting round it. Each carries
  // its own stance, so the hips and shoulders load and unload with the arm.
  ground: [
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.2, strike: 0.26, anim: 0.15, cooldown: 0.13,
      reach: 0.92, thick: 16, dash: 46, shake: 5,
      stance: 'brace', stanceLean: 0.16, stanceHip: -4, stanceOut: 0.1, name: 'JAB',
    },
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.2, strike: 0.26, anim: 0.17, cooldown: 0.15,
      reach: 0.98, thick: 19, dash: 70, shake: 7, hitSfx: 'punch', hitPitch: 1.05,
      stance: 'brace', stanceLean: 0.22, stanceHip: -6, stanceOut: 0.1, name: 'CROSS',
    },
    {
      from: -0.95, to: 0.8, wind: 0.28, strike: 0.24, anim: 0.24, cooldown: 0.22, reach: 1, thick: 26,
      dash: 120, hitSfx: 'punch', hitPitch: 0.92, shake: 10,
      stance: 'brace', stanceLean: 0.26, stanceHip: -10, stanceOut: 0.12, name: 'HOOK',
    },
    {
      from: 1.25, to: -1.35, wind: 0.3, strike: 0.22, anim: 0.3, cooldown: 0.36, reach: 0.95, thick: 32,
      lift: 150, dash: 60, heavy: true, hitSfx: 'punch', hitPitch: 0.78, flash: 0.14, shake: 14,
      stance: 'brace', stanceLean: -0.2, stanceHip: -14, stanceOut: 0.16, name: 'UPPERCUT',
    },
  ],
  run: [
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.22, strike: 0.26, anim: 0.28, cooldown: 0.3, reach: 1.15, thick: 26,
      dash: 320, slide: 0.2, stance: 'lunge', stanceHip: -10, stanceLean: 0.16, heavy: true,
      hitSfx: 'punch', hitPitch: 0.8, shake: 14, name: 'SHOULDER CHARGE',
    },
    {
      // Still a punch: he keeps running and throws the far hand across, so the
      // whole body turns into it without ever leaving the floor.
      kind: 'thrust', from: 0, to: 0, wind: 0.2, strike: 0.26, anim: 0.3, cooldown: 0.32, reach: 1.1, thick: 28,
      dash: 220, slide: 0.16, heavy: true, hitSfx: 'punch', hitPitch: 0.74, flash: 0.12, shake: 15,
      stance: 'lunge', stanceHip: -12, stanceLean: 0.24, name: 'RUNNING CROSS',
    },
  ],
  air: [
    {
      kind: 'thrust', from: 0, to: 0, wind: 0.2, strike: 0.26, anim: 0.24, cooldown: 0.26, reach: 1.05, thick: 22,
      dash: 130, lift: -240, hitSfx: 'punch', hitPitch: 0.85, shake: 10, name: 'DIVE PUNCH',
    },
    {
      // A hammer of a punch straight down, not a kick and not a somersault.
      from: -1.5, to: 1.15, wind: 0.24, strike: 0.22, anim: 0.3, cooldown: 0.34, reach: 1, thick: 28,
      lift: -120, heavy: true, hitSfx: 'punch', hitPitch: 0.72, shake: 13, name: 'FALLING HAMMER',
    },
  ],
  hold: [
    {
      from: -1.5, to: 1.05, wind: 0.42, strike: 0.18, anim: 0.44, cooldown: 0.42, reach: 1.05, thick: 40,
      dash: 160, heavy: true, hitSfx: 'punch', hitPitch: 0.62, flash: 0.24, invert: 0.04, shake: 20,
      quake: 0.7, stance: 'brace', stanceLean: 0.3, stanceHip: -12, name: 'HAYMAKER',
    },
    {
      // The other hand, thrown just as hard. It used to be a spinning backfist,
      // which put a somersault in the middle of a punching combination.
      from: 1.5, to: -1.0, wind: 0.4, strike: 0.2, anim: 0.46, cooldown: 0.46, reach: 1.05, thick: 42,
      dash: 150, heavy: true, hitSfx: 'punch', hitPitch: 0.58, flash: 0.28, invert: 0.05,
      shake: 22, stance: 'brace', stanceLean: 0.28, stanceHip: -12, name: 'OVERHAND',
    },
  ],
};

export class Fists extends MeleeWeapon {
  readonly id = 1;
  readonly name = 'BRAWLER';
  readonly tagline = 'four punches, then hold on';
  protected readonly len = 74;
  protected readonly sets = FIST_SETS;

  /** Seconds the barrage has been running; zero when it is not. */
  private barrageT = 0;
  /**
   * 0..1 how far into the blur it is: 0 is countable punches with the arms
   * drawn, 1 is the storm with no arms at all. It chases the ramp on the way
   * in and unwinds on the way out, which is what makes the transition a change
   * of speed rather than a change of weapon.
   */
  private blur = 0;
  /** Runs on while the trigger is up, so the arms come back rather than snap back. */
  private winddown = 0;
  /** Alternates the driving arm through the ramp, and drives the piston pose. */
  private armPhase = 0;
  private armSide = 1;
  /** Set when it has run its full length: no more until the trigger comes up. */
  private spent = false;
  /** Rate limiter for the blows themselves. */
  private punchT = 0;
  private punches: BigPunch[] = [];
  private smears: Smear[] = [];
  /** Fractional smear budget, so the rate is per second and not per frame. */
  private smearAcc = 0;

  constructor() { super(); this.animLen = 0.18; this.cooldown = 0.16; }

  override onEquip(): void {
    super.onEquip();
    this.endBarrage();
    this.punches.length = 0;
    this.smears.length = 0;
  }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.endBarrage(); }

  private endBarrage(): void {
    this.barrageT = 0;
    this.spent = false;
    this.punchT = 0;
    this.blur = 0;
    this.winddown = 0;
  }

  /**
   * Once the barrage is up, the arms come off the drawing entirely. They are
   * moving faster than fifteen frames a second can say anything about, and two
   * limbs vibrating in place read as a mistake; the storm of impacts in front
   * of his chest is the whole action, and it should be the only thing there.
   */
  override get hidesArms(): boolean { return this.blur > 0.62; }

  override get comboLabel(): string | null {
    if (this.barrageT > 0) {
      // Counting down what is left of it, because five seconds of this is a
      // resource and the player should be able to see it going.
      return `BARRAGE  ${Math.max(0, BARRAGE_MAX - this.barrageT).toFixed(1)}`;
    }
    if (this.winddown > 0) return 'BARRAGE';
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
    for (let i = this.smears.length - 1; i >= 0; i--) {
      this.smears[i].life -= ctx.dt;
      if (this.smears[i].life <= 0) this.smears.splice(i, 1);
    }

    const running = held && this.heldFor > BARRAGE_HOLD && !this.spent;
    if (running) {
      this.barrageT += ctx.dt;
      this.winddown = RAMP_OUT;
      if (this.barrageT >= BARRAGE_MAX) {
        // Out of it. A real recovery, so the last blow lands and then nothing
        // does for a moment.
        this.spent = true;
        this.barrageT = 0;
        this.cooldown = 0.8;
        this.timer = 0.8;
        ctx.sfx('heavyswing', 0.6);
      }
    } else {
      this.barrageT = 0;
      if (!held) this.spent = false;
      this.winddown = Math.max(0, this.winddown - ctx.dt);
    }
    if (this.winddown <= 0 && this.blur <= 0.002) {
      if (this.blur !== 0) this.blur = 0;
      if (this.armPhase !== 0) this.armPhase = 0;
      return;
    }

    // --- the ramp ------------------------------------------------------------
    //
    // On the way in, how far through the wind-up he is; on the way out, how
    // much of the wind-up is left. `blur` chases it, so nothing about the
    // handover between drawn arms and drags happens on a single frame.
    const wants = running ? clamp(this.barrageT / RAMP_IN, 0, 1) : 0;
    this.blur = damp(this.blur, wants, wants > this.blur ? 5.5 : 2.6, ctx.dt);
    const speed = this.blur;

    if (running) {
      // He is leaning into it, so the whole figure creeps forward as it runs.
      ctx.sm.dash(ctx.sm.facing * (10 + speed * 26) * ctx.dt);
      if (speed > 0.5) ctx.sm.addGhostBurst(0.12);
      ctx.shake(0.8 + speed * 2.2);
    }

    // The drags only start once the arms are actually going too fast to draw,
    // and they thin out again the moment they are not.
    const field = clamp((this.blur - 0.3) / 0.7, 0, 1);
    if (field > 0.01) {
      this.smearAcc += ctx.dt * 105 * field;
      while (this.smearAcc >= 1) {
        this.smearAcc -= 1;
        this.addSmear(ctx, field);
      }
    }

    // The blows themselves, arriving sooner every time.
    const rate = lerp(BARRAGE_SLOW, BARRAGE_RATE, easeOutCubic(speed));
    if (this.blur > 0.08) this.armPhase += ctx.dt / Math.max(0.02, rate);
    else this.armPhase = 0;
    this.punchT -= ctx.dt;
    if (!running || this.punchT > 0) return;
    this.punchT = rate;
    this.armSide = -this.armSide;
    this.throwPunch(ctx, speed);
  }

  /**
   * One drag of ink. It is anchored on his shoulders and thrown *backwards* -
   * these are the arms smearing, not the punches landing - fanned a little
   * either side of the line he is punching along.
   */
  private addSmear(ctx: WeaponCtx, field: number): void {
    const sm = ctx.sm;
    const c = sm.pose.chest;
    const f = sm.facing;
    // Backwards along the *facing*, not along the aim. In the reference the
    // drags lie roughly level however he is pointing - they are his arms
    // smearing sideways, and a fan radiating out of one point at whatever the
    // crosshair happens to be reads as a firework instead.
    // Level-ish, but not ruled: the reference has a few running steeply across
    // the others, and a field of exactly parallel drags reads as hatching.
    const back = (f > 0 ? Math.PI : 0)
      + (Math.random() < 0.22 ? rand(-0.9, 0.9) : rand(-0.3, 0.3));
    // Spread right out behind and around him. They are where his arms have
    // *been*, not where his shoulders are, so they cover a wide field - and
    // starting them all on his sternum blots one spot solid black.
    // In front of him and across his middle, not trailing off behind. These are
    // the arms working in the space between his chest and the wall, and the
    // field has to be big enough to very nearly bury him: parking it behind
    // his shoulders left the busiest part of the drawing where nothing was
    // happening and the figure standing clear in front of it.
    const off = rand(-98, 88);
    const fwd = rand(-96, 178);
    this.smears.push({
      x: c.x + f * fwd,
      y: c.y + off,
      ang: back,
      // Lengths spread over five to one: a few reach right across the paper.
      // Short and chunky. Drags that cross the whole paper read as spears;
      // the reference's longest is about a third of the frame and most are
      // half that again.
      len: (58 + Math.pow(Math.random(), 1.8) * 200) * (0.55 + field * 0.45),
      width: rand(11, 30) * (0.6 + field * 0.4),
      bow: rand(-0.16, 0.16),
      hollow: Math.random() < 0.16,
      life: rand(0.2, 0.36),
      max: 0.36,
      seed: Math.floor(rand(0, 9999)),
    });
    if (this.smears.length > 52) this.smears.shift();
  }

  /**
   * One blow of the barrage. It is not a hand reaching the wall - his arm is
   * nowhere near it - it is the *shock* of the punch arriving there as a fist
   * several times the size of his own, which is exactly how the reference
   * draws a flurry that matters.
   */
  private throwPunch(ctx: WeaponCtx, speed: number): void {
    const sm = ctx.sm;
    const c = sm.pose.chest;
    const a = sm.pose.aim + rand(-0.34, 0.34);
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = ctx.terrain.strikePoint(c.x, c.y, ca, sa, BARRAGE_REACH, 3);
    const at = hit ?? { x: c.x + ca * 150, y: c.y + sa * 150 };
    // Every fifth or so lands properly, so the flurry has a beat in it instead
    // of being one continuous noise.
    const big = Math.random() < 0.18 + speed * 0.2;
    const size = (big ? 74 : 48) * rand(0.85, 1.25) * (0.72 + speed * 0.28);

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

    ctx.sfx('punch', (big ? 0.68 : 1) * rand(0.9, 1.2) * (0.9 + speed * 0.3));
    ctx.shake((big ? 8 : 3.5) * (0.6 + speed * 0.4));
    if (big && speed > 0.5) ctx.flash(0.1);
    sm.applyRecoil(0.2 + speed * 0.12, a, 0);
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
    // Through the barrage the arms are pistoning: one out along the line he is
    // punching along, the other cocked right back, swapping every blow. They
    // are only dropped once they are moving too fast for the drawing to say
    // anything about them - `hidesArms` takes them off then, and until it does
    // you can watch them speed up.
    if (this.blur > 0.08) {
      // Same throw, over and over, faster and faster - so the ramp is plainly
      // the ordinary punch speeding up rather than a different motion. It stops
      // the moment the blur is nearly gone: an arm reappearing out of the storm
      // still hammering away at nothing reads as a glitch, so what comes back
      // is a guard, and it comes back *still*.
      return throwArms(ctx, this.armPhase % 1, this.armSide > 0, 46);
    }
    if (this.winddown > 0.001) return this.restHands(ctx);
    // Between punches the arms are released back to the gait, so running with
    // bare hands swings them instead of carrying a frozen guard around.
    if (this.anim <= 0 && Math.abs(ctx.sm.vel.x) > 45) return null;
    if (this.anim <= 0) return this.restHands(ctx);

    const mv = this.move;
    if (mv.kind === 'thrust') {
      // A punch is a throw. The fist comes from behind the shoulder and whips
      // through - the same drive every hand-thrown thing in the game uses -
      // rather than pistoning in and out on the aim line.
      return throwArms(ctx, t, this.swap > 0, 48);
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
  /**
   * The barrage, which is the whole weapon and which I had wrong twice.
   *
   * It is not a fist and it is not an explosion. Watched frame by frame it is
   * a field of long tapered drags of ink thrown backwards off his shoulders,
   * blunt and hooked at the near end and drawn out to a point behind them, at
   * five different lengths and slightly different angles, layered over each
   * other and over him. The paper shows through in nicks along every one of
   * them, the way a brush run dry does. His arms are not drawn at all - the
   * smears are where his arms went.
   */
  private drawPunches(sk: Sketch): void {
    const c = sk.ctx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // Two passes, and it has to be two: every drag is knocked back in white
    // so it survives the black wall, and if each one paints its own halo just
    // before its own ink then the next one along wipes the last one out. All
    // the paper first, then all the ink on top of it.
    const geom = this.smears.map((m) => {
      const k = clamp(m.life / m.max, 0, 1);
      const ca = Math.cos(m.ang), sa = Math.sin(m.ang);
      const nx = -sa, ny = ca;
      const L = m.len * (0.8 + (1 - k) * 0.3);
      const at = (d: number, o: number): Vec2 =>
        ({ x: m.x + ca * d + nx * o, y: m.y + sa * d + ny * o });
      return {
        m, k, L, at,
        head: at(0, 0),
        ctrl: at(L * 0.5, m.bow * L * 0.35),
        tail: at(L, m.bow * L),
        w: m.width * (0.5 + k * 0.7),
      };
    });

    c.fillStyle = '#fff';
    for (const g of geom) {
      c.globalAlpha = clamp(g.k * 3.4, 0, 1);
      const { m, L, at } = g;
      const segs = 2 + Math.floor(Math.abs(hashNoise(m.seed, 3)) * 3);
      let d = 0;
      for (let sgi = 0; sgi < segs && d < L; sgi++) {
        const run = L * (0.32 + Math.abs(hashNoise(m.seed + sgi * 5, sk.boil)) * 0.5);
        const d1 = Math.min(L, d + run);
        const t = d / L;
        const w = g.w * (1 - t * 0.45) + 2.6;
        const o0 = m.bow * d, o1 = m.bow * d1;
        sk.ribbonPath(at(d, o0), at((d + d1) / 2, (o0 + o1) / 2), at(d1, o1), w, 0.3, 0.72);
        c.fill();
        d = d1 + L * (0.05 + Math.abs(hashNoise(m.seed + sgi * 9, sk.boil)) * 0.16);
      }
    }

    for (const g of geom) {
      const { m, k, L, at } = g;
      c.globalAlpha = clamp(k * 3.4, 0, 1);
      // Not a black blob: a white-bellied drag walled in by a heavy rim that
      // is only drawn part of the way round it. Where the drag runs thin the
      // two sides of the rim meet and it reads solid black, and where it runs
      // fat the paper shows straight through the middle - which is precisely
      // the mix the reference frames are made of, and why they look brushed.
      const segs = 2 + Math.floor(Math.abs(hashNoise(m.seed, 3)) * 3);
      let d = 0;
      for (let sgi = 0; sgi < segs && d < L; sgi++) {
        const run = L * (0.32 + Math.abs(hashNoise(m.seed + sgi * 5, sk.boil)) * 0.5);
        const d1 = Math.min(L, d + run);
        // Fat near the front of each stroke, drawn out to a point behind it.
        const t = d / L;
        const w = g.w * (1 - t * 0.45);
        const o0 = m.bow * d, o1 = m.bow * d1;
        const trace = (): void =>
          sk.ribbonPath(at(d, o0), at((d + d1) / 2, (o0 + o1) / 2), at(d1, o1), w, 0.3, 0.72);
        sk.inked(trace, 4.4, m.hollow ? 0.6 : 0.14, m.seed + sgi * 13);
        // The lift-off before the brush comes back down.
        d = d1 + L * (0.05 + Math.abs(hashNoise(m.seed + sgi * 9, sk.boil)) * 0.16);
      }
      // A hooked tick off the blunt end, the way the reference finishes them.
      if (!m.hollow && k > 0.4) {
        c.fillStyle = '#000';
        sk.tuftPath(g.head.x, g.head.y, 2, 0, g.w * 2.4, 1.1, m.ang + Math.PI, m.seed + 41, 0.09);
        c.fill();
      }
    }

    // And the ink where the blows are actually landing.
    //
    // Not a clump of separate black spikes with a line round every one of
    // them: *one* torn white shape with a single contour round the whole set,
    // the way the reference draws a hit. Drawn as one closed zigzag - tips out
    // at wildly uneven lengths, valleys pulled back in near the point of
    // contact - so there is exactly one outline and the paper shows through
    // the middle of it.
    for (const p of this.punches) {
      const k = clamp(p.life / p.max, 0, 1);
      c.globalAlpha = clamp(k * 1.8, 0, 1);
      const r1 = p.size * (0.72 + (1 - k) * 0.55);
      sk.inked(
        () => sk.starPath(p.x, p.y, 11, p.size * 0.1, r1, 3.0, p.ang + Math.PI, p.seed),
        3.2, 0.12, p.seed + 5,
      );
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
  // Everything here is a *heave*. A blade this heavy does not flick: it comes
  // round from behind the far shoulder, travels most of a half circle, and
  // carries him with it - which is why every one of these has a stance, a real
  // step in it and a shove back afterwards. The arcs are long because the reach
  // is: the cut opens far wider than the blade, and it should look as though
  // the weight is what did it.
  ground: [
    {
      from: -2.5, to: 1.1, wind: 0.4, strike: 0.18, anim: 0.72, cooldown: 0.72, reach: 1.35, thick: 80,
      heavy: true, impact: 1.8, dash: 130, recover: 40, flash: 0.4, invert: 0.06, shake: 24, quake: 1,
      hitSfx: 'slam', hitPitch: 0.85,
      stance: 'brace', stanceLean: -0.24, stanceHip: -12, stanceOut: 0.16, name: 'CLEAVE',
    },
    {
      from: 2.6, to: -1.15, wind: 0.36, strike: 0.18, anim: 0.7, cooldown: 0.7, reach: 1.4, thick: 82,
      heavy: true, impact: 1.8, dash: 150, recover: 40, flash: 0.34, invert: 0.05, shake: 22,
      quake: 1, hitSfx: 'slam', hitPitch: 0.9,
      stance: 'brace', stanceLean: -0.22, stanceHip: -12, stanceOut: 0.16, name: 'SWEEP',
    },
    {
      // The whole body turns with the sword and everything in front of him goes.
      from: -3.1, to: 1.75, wind: 0.32, strike: 0.2, anim: 0.84, cooldown: 0.95, reach: 1.5, thick: 96,
      heavy: true, spin: 1, hop: 215, dash: 170, flash: 0.5, invert: 0.07, shake: 28, quake: 1.2,
      hitSfx: 'slam', hitPitch: 0.78, name: 'WHIRLWIND',
    },
  ],
  run: [
    {
      // Out of the drag: the tip is already down by the floor, so he just keeps
      // running and rips it up through everything in the way.
      from: 1.6, to: -1.55, wind: 0.28, strike: 0.2, anim: 0.58, cooldown: 0.6, reach: 1.45, thick: 78,
      heavy: true, impact: 1.8, dash: 260, slide: 0.26, lift: 90, flash: 0.3, shake: 20, quake: 0.8,
      hitSfx: 'slam', hitPitch: 0.95, name: 'RISING DRAG',
    },
    {
      from: -2.6, to: 1.25, wind: 0.3, strike: 0.18, anim: 0.62, cooldown: 0.66, reach: 1.4, thick: 78,
      heavy: true, impact: 1.8, dash: 190, slide: 0.16, flash: 0.34, invert: 0.04, shake: 22, quake: 1,
      hitSfx: 'slam', hitPitch: 0.85, stance: 'lunge', stanceHip: -12, name: 'RUNNING CLEAVE',
    },
  ],
  air: [
    {
      from: -1.9, to: 1.7, wind: 0.28, strike: 0.18, anim: 0.48, cooldown: 0.6, reach: 1.45, thick: 88,
      heavy: true, impact: 2, lift: -430, flash: 0.45, invert: 0.06, shake: 26, quake: 1.4,
      hitSfx: 'slam', hitPitch: 0.7, name: 'PLUNGE',
    },
  ],
  // Held, it stops being one big swing and becomes a charge: he throws himself
  // a long way forward turning over twice with the sword out, lands on the
  // wall, and puts three cuts through it before the momentum runs out. Each of
  // the three is a full-weight strike, so the chain is worth crossing the room
  // for and not just a flourish.
  hold: [
    {
      from: -3.1, to: 1.8, wind: 0.3, strike: 0.18, anim: 0.86, cooldown: 0.1, reach: 1.5, thick: 84,
      heavy: true, spin: 2, hop: 250, dash: 1250, slide: 0.5, flash: 0.5, invert: 0.07,
      shake: 28, quake: 1.3, hitSfx: 'slam', hitPitch: 0.66, name: 'LEAPING WHIRL',
    },
    {
      from: -2.8, to: 1.5, wind: 0.16, strike: 0.16, anim: 0.34, cooldown: 0.04, reach: 1.45, thick: 88,
      heavy: true, impact: 1.7, dash: 120, flash: 0.4, invert: 0.05, shake: 24, quake: 1,
      hitSfx: 'slam', hitPitch: 0.8, name: 'CUT ONE',
    },
    {
      from: 2.7, to: -1.45, wind: 0.14, strike: 0.16, anim: 0.32, cooldown: 0.04, reach: 1.45, thick: 88,
      heavy: true, impact: 1.7, dash: 110, flash: 0.4, invert: 0.05, shake: 24, quake: 1,
      hitSfx: 'slam', hitPitch: 0.88, name: 'CUT TWO',
    },
    {
      from: -2.9, to: 1.7, wind: 0.16, strike: 0.18, anim: 0.44, cooldown: 0.72, reach: 1.55, thick: 104,
      heavy: true, impact: 2, dash: 140, flash: 0.55, invert: 0.075, shake: 30, quake: 1.5,
      hitSfx: 'slam', hitPitch: 0.7, name: 'CUT THREE',
    },
  ],
};

/** How far clear of the floor the point rides while he only carries it. */
const DRAG_LIFT = 26;
/** The band the drag settles into, radians off the horizontal. */
const DRAG_LOW = 0.24, DRAG_HIGH = 0.66;
/** He may be off the floor this long before it comes up over the shoulder. */
const DRAG_COYOTE = 0.3;

export class Greatsword extends MeleeWeapon {
  readonly id = 2;
  readonly name = 'SWORDSMAN';
  readonly tagline = 'rides the floor, lands like a truck';
  protected readonly len = 196;
  protected readonly sets = GREATSWORD_SETS;

  /** 0..1 blend into the "too heavy to carry" drag pose. */
  private dragT = 0;
  /** Metres of floor dragged since the last scrape, so sparks track speed. */
  private scraped = 0;
  /** Seconds since his feet last touched, so a bump mid-run keeps the drag. */
  private airT = 0;

  constructor() {
    super();
    this.animLen = 0.8;
    this.cooldown = 0.95;
    this.gripFwd = 38;
    this.gripLead = 0.34;
  }

  override onEquip(): void { super.onEquip(); this.dragT = 0; this.airT = 0; }

  /**
   * He never lifts it. Standing or walking, the point is on the floor behind
   * him and stays there - the weapon is simply heavier than he is, and the
   * only time it comes up off the ground is the swing itself. Only in mid-air,
   * with no floor to rest on, does it go up over the shoulder.
   */
  protected restAngle(ctx: WeaponCtx): number {
    const shoulder = mirror(-2.45 + Math.sin(ctx.time * 1.1) * 0.05, ctx.sm.facing);
    if (this.dragT < 0.01) return shoulder;
    return toward(shoulder, this.dragPose(ctx), this.dragT);
  }

  /**
   * Where the slab lies when he is only carrying it: trailing behind him on a
   * slant with the point riding a hand's breadth clear of the floor, so you can
   * see the whole length of it. Aiming the tip *exactly* at the ground buries
   * it - on a rise the angle goes vertical and it reads as a post he is leaning
   * on - so the tip is lifted and the angle held inside a band. Whatever the
   * ground does, it stays a diagonal.
   */
  private dragPose(ctx: WeaponCtx): number {
    const sm = ctx.sm;
    const h = sm.pose.handR;
    const drop = ctx.terrain.groundBelow(h.x - sm.facing * this.len * 0.7, h.y, 320);
    const fall = drop >= 320 ? this.len * 0.5 : drop - DRAG_LIFT;
    const a = clamp(Math.asin(clamp(fall / this.len, -0.98, 0.98)), DRAG_LOW, DRAG_HIGH);
    // A slow heave with the stride: the weight swings, it does not track him.
    const sway = Math.sin(ctx.time * 5.2) * 0.06 * Math.min(1, Math.abs(sm.vel.x) / 220);
    return mirror(Math.PI - a + sway, sm.facing);
  }

  /** The drag itself: sparks, grit and a scraping edge for as long as he walks. */
  protected override idleTick(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const speed = Math.abs(sm.vel.x);
    // On the ground it is always down, whether he is moving or not - and a
    // bump in the run that lifts his feet for two frames must not throw the
    // sword up over his shoulder and back, so the drag holds through short
    // hops and only lets go once he is properly airborne.
    this.airT = sm.onGround ? 0 : this.airT + ctx.dt;
    const wants = this.airT < DRAG_COYOTE ? 1 : 0;
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
    // The point rides clear of the floor, so the grit it throws up comes off
    // the floor under it rather than out of thin air.
    const gap = ctx.terrain.groundBelow(tip.x, tip.y, 90);
    const fy = tip.y + Math.min(gap, 90);
    const back = sm.vel.x > 0 ? Math.PI : 0;
    ctx.particles.sparks(tip.x, fy - 2, 2, 90 + speed * 0.6, back, 1.5);
    ctx.particles.dust(tip.x, fy, 1, back, 0.5);
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
      const fy = tip.y + Math.min(ctx.terrain.groundBelow(tip.x, tip.y, 90), 90);
      c.save();
      c.globalAlpha = this.dragT;
      c.lineWidth = 2;
      sk.burst(tip.x, fy - 2, 4, 3, 14, 2, 1.5, ctx.sm.vel.x > 0 ? Math.PI : 0, 4141);
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
  // Holding the trigger does not swing anything - it *stores* it. What comes
  // out when you let go is the frenzy: he beats the wall with the thing left,
  // right, left, right, faster than a head that size has any business moving,
  // and only the last one is a proper wind-up. See `FRENZY` below.
  hold: [
    {
      from: -2.1, to: 1.15, wind: 0.1, strike: 0.16, anim: 0.24, cooldown: 0.02, reach: 0.98, thick: 84,
      blast: MAUL_LIGHT, heavy: true, impact: 1.8, flash: 0.34, invert: 0.04, shake: 24, quake: 1.1,
      hitSfx: 'slam', hitPitch: 1.02, name: 'BATTER',
    },
    {
      from: 2.1, to: -1.1, wind: 0.1, strike: 0.16, anim: 0.24, cooldown: 0.02, reach: 0.98, thick: 84,
      blast: MAUL_LIGHT, heavy: true, impact: 1.8, flash: 0.34, invert: 0.04, shake: 24, quake: 1.1,
      hitSfx: 'slam', hitPitch: 0.94, name: 'BATTER BACK',
    },
    {
      from: -2.4, to: 1.3, wind: 0.16, strike: 0.18, anim: 0.46, cooldown: 0.6, reach: 1, thick: 108,
      blast: MAUL_BIG, heavy: true, impact: 2, flash: 0.6, invert: 0.085, shake: 34, quake: 1.7,
      hitSfx: 'slam', hitPitch: 0.68, name: 'AND THE LAST ONE',
    },
  ],
};

/** Seconds of held trigger before letting go sets the frenzy off. */
const FRENZY_HOLD = 0.4;
/** How many blows it lands, and how far apart. */
const FRENZY_BLOWS = 7;
const FRENZY_RATE = 0.19;

export class Warhammer extends MeleeWeapon {
  readonly id = 3;
  readonly name = 'SMASHER';
  readonly tagline = 'the head is bigger than he is';
  protected readonly len = 268;
  protected readonly sets = HAMMER_SETS;
  /** Blows left in the frenzy, and the clock between them. */
  private frenzy = 0;
  private frenzyT = 0;

  /**
   * Half the height of the striking face, and how long the drum runs back off
   * it. The source's mallet is not a warhammer head on a haft - it is a barrel
   * as tall as the figure and nearly as long, with a stick out of the back of
   * it, and no bands, cheeks or claws anywhere on it.
   */
  private readonly headW = 92;
  private readonly headD = 214;

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
   * Nothing comes out while the trigger is down.
   *
   * The whole point of the hold is that he is *storing* it - heaving the thing
   * back over his shoulder - and running the chain meanwhile turned the wind-up
   * into just another combo. Letting go is what sets it off.
   */
  protected override suppressFire(): boolean {
    return this.frenzy > 0 || this.heldFor > FRENZY_HOLD;
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor <= FRENZY_HOLD || this.frenzy > 0) return;
    this.frenzy = FRENZY_BLOWS;
    this.frenzyT = 0;
    ctx.sfx('heavyswing', 0.5);
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    super.tick(ctx, held);
    if (this.frenzy <= 0) return;
    this.frenzyT -= ctx.dt;
    if (this.frenzyT > 0) return;
    // Left, right, left, right - and the last one is the only one he winds up
    // for, so the burst finishes on a bang rather than trailing off.
    const list = this.sets.hold;
    const mv = this.frenzy === 1 ? list[2] : list[(FRENZY_BLOWS - this.frenzy) % 2];
    this.frenzy--;
    this.frenzyT = this.frenzy === 1 ? FRENZY_RATE * 1.6 : FRENZY_RATE;
    this.startMove(ctx, mv);
  }

  override get comboLabel(): string | null {
    if (this.frenzy > 0) return `FRENZY  x${FRENZY_BLOWS - this.frenzy + 1}`;
    if (this.heldFor > FRENZY_HOLD) return 'WINDING UP';
    return super.comboLabel;
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
    const drag = dragAngle(ctx, ctx.sm.pose.handR, this.len - this.headD * 0.42, ctx.sm.facing);
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
    // Haft: one plain stroke into the back of the head. Short and thin - in
    // the source it is almost an afterthought next to what is on the end of it.
    sk.line(at(-30, 0), at(L - D + 6, 0), 5.5, 2, 0.6);

    // The head.
    //
    // Not a drum with a flat cap on it - that is a lampshade, and that is what
    // it read as. The source's mallet is a great smooth *capsule*: parallel
    // sides that barely swell, and a striking end that is fully domed over.
    // The whole thing is about twice his height long and very nearly as wide
    // as he is tall.
    const back = L - D;
    const pts: Vec2[] = [];
    pts.push(at(back, -W * 0.9));
    pts.push(at(back + D * 0.42, -W));
    // The dome. A half capsule, slightly squashed along its own axis so the
    // end reads as rounded rather than as half a circle stuck on.
    const domeX = L - W * 0.62;
    for (let i = 0; i <= 10; i++) {
      const th = -Math.PI / 2 + (i / 10) * Math.PI;
      pts.push(at(domeX + Math.cos(th) * W * 0.66, Math.sin(th) * W));
    }
    pts.push(at(back + D * 0.42, W));
    pts.push(at(back, W * 0.9));
    c.fillStyle = '#fff';
    sk.polyPath(pts, 1.4);
    c.fill();
    sk.poly(pts, 5.4, false, 1.4);

    // The collar: a wide curved lip flaring off the back of the head where the
    // haft goes in. It is the one piece of the source's mallet that is not the
    // barrel, and without it the barrel is just a barrel.
    for (const side of [-1, 1]) {
      const lip = [
        at(back + 12, side * W * 0.86),
        at(back - 6, side * W * 1.5),
        at(back - 24, side * W * 1.34),
        at(back - 6, side * W * 0.5),
      ];
      c.fillStyle = '#fff';
      sk.polyPath(lip, 1.2);
      c.fill();
      sk.poly(lip, 4, false, 1.2);
    }

    // Two lengthwise strokes down the barrel and nothing else. The source has
    // no bands, no rivets and no cheeks on this thing.
    sk.line(at(back + 26, -W * 0.52), at(L - W * 0.9, -W * 0.56), 2.4, 2, 0.8);
    sk.line(at(back + 34, W * 0.44), at(L - W, W * 0.5), 2.2, 2, 0.8);

    // A flash of impact on landing, sized off the head rather than off nothing.
    if (this.striking > 0.55 && this.striking < 0.95) {
      const tip = at(L + 10, 0);
      c.fillStyle = '#000';
      sk.tuftPath(tip.x, tip.y, 17, W * 0.5, W * 2.4, TAU, 0, 909, 0.05);
      c.fill();
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
// 5. GUNSLINGER
// ---------------------------------------------------------------------------
/**
 * Four guns, one man, and no reason to pick between them.
 *
 * The magnum, the shotgun, the rifle and the bazooka used to be four slots on
 * the wheel that did the same job at four ranges. They are one slot now, and
 * *he* chooses: the three he is not holding ride on his back where you can see
 * them, and the one in his hands is whichever the distance to the wall calls
 * for. Far out it is the revolver, one hole at a time. Up against the masonry
 * it is the shotgun.
 *
 * Holding the trigger shoulders the tube instead, and letting go runs the
 * whole trick: three grenades lobbed down one line, then the rifle comes off
 * his back and shoots every one of them out of the air.
 */
type Gun = 'magnum' | 'shotgun' | 'rifle' | 'bazooka';

/** Inside this much wall the revolver is the wrong tool and he knows it. */
const CLOSE_RANGE = 250;
/** Seconds of held trigger before the bazooka comes off his back. */
const SLING_HOLD = 0.42;
/** When the grenades leave his hand, and when the rifle comes off his back. */
const GRENADE_AT = 0.34;
const RIFLE_AT = 0.72;
/** How little air has to be left in front of a grenade before he shoots it. */
const SNIPE_AT = 210;
/** How long an over-arm throw takes to play out. */
const THROW_TIME = 0.26;

export class Gunslinger extends Weapon {
  readonly id = 5;
  readonly name = 'GUNSLINGER';
  readonly tagline = 'four on his back, one in his hands';
  override cooldown = 0.42;

  /** What is in his hands right now. */
  private gun: Gun = 'magnum';
  private flashT = 0;
  /** How far the revolver's barrel is still thrown up by the last round. */
  private kick = 0;
  /** Bazooka backblast clock. */
  private fireT = 0;
  private heat = 0;
  /** The finisher, once it is running. */
  private volley = 0;
  /** Grenades in the air that the rifle still owes a bullet to. */
  private live: Projectile[] = [];
  /** Rate limiter on the sniping, so three rounds are three drawings. */
  private snipeT = 0;
  /** Counts down through an over-arm throw. */
  private throwT = 0;
  /** How far through the swap the hands are, so a gun does not teleport. */
  private swapT = 0;

  override onEquip(): void {
    super.onEquip();
    this.gun = 'magnum';
    this.volley = 0;
    this.live.length = 0;
  }

  override get comboLabel(): string | null {
    if (this.volley > 0) return 'FUSILLADE';
    if (this.heldFor > SLING_HOLD) return 'TUBE UP';
    return this.gun === 'shotgun' ? 'CLOSE' : null;
  }

  /** How far the wall is down the line he is pointing, or Infinity. */
  private wallRange(ctx: WeaponCtx, from: Vec2): number {
    const a = this.aimFrom(ctx, from);
    const hit = ctx.terrain.strikePoint(from.x, from.y, Math.cos(a), Math.sin(a), 1600, 4);
    return hit ? Math.hypot(hit.x - from.x, hit.y - from.y) : Infinity;
  }

  protected override suppressFire(_ctx: WeaponCtx): boolean {
    return this.volley > 0 || this.heldFor > SLING_HOLD;
  }

  protected release(ctx: WeaponCtx): void {
    // Which gun the shot wants. The swap is instant in his hands and takes a
    // beat on the page, which is the whole appeal of carrying four.
    const probe = grip(ctx, 52);
    const near = this.wallRange(ctx, probe) < CLOSE_RANGE;
    const want: Gun = near ? 'shotgun' : 'magnum';
    if (want !== this.gun) { this.gun = want; this.swapT = 1; ctx.sfx('ui', 1.4); }
    this.cooldown = near ? 0.66 : 0.42;
    this.animLen = near ? 0.5 : 0.34;
    if (near) this.fireShotgun(ctx); else this.fireMagnum(ctx);
  }

  private fireMagnum(ctx: WeaponCtx): void {
    const muzzle = grip(ctx, 52);
    const a = this.aimFrom(ctx, muzzle) + rand(-0.008, 0.008);
    this.flashT = 0.085;
    this.kick = 1;
    ctx.sfx('pistol', rand(0.6, 0.68));
    ctx.sm.applyRecoil(1.15, a, 85);
    ctx.shake(9);
    ctx.flash(0.12);
    ctx.particles.streaks(muzzle.x, muzzle.y, 6, a, 0.4, 70);
    ctx.particles.smoke(muzzle.x, muzzle.y, 2, 5);
    this.hitscan(ctx, muzzle, a, 1600, 17);
  }

  private fireShotgun(ctx: WeaponCtx): void {
    const muzzle = grip(ctx, 84);
    const base = this.aimFrom(ctx, muzzle);
    this.flashT = 0.09;
    ctx.sfx('shotgun');
    ctx.shake(13);
    ctx.flash(0.22);
    ctx.sm.applyRecoil(1.1, base, 260);
    for (let i = 0; i < 11; i++) this.hitscan(ctx, muzzle, base + rand(-1, 1) * 0.17, 700, 6.8);
    ctx.particles.smoke(muzzle.x, muzzle.y, 5, 8);
    ctx.particles.streaks(muzzle.x, muzzle.y, 9, base, 0.5, 60);
  }

  /**
   * The trick. Three grenades leave the tube down one line, and while they are
   * still in the air the rifle comes off his back and puts a round through
   * each of them in turn - so the wall takes three explosions in a row, spaced
   * out along whatever he happened to be pointing at.
   */
  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor <= SLING_HOLD || this.volley > 0) return;
    const a = this.aimFrom(ctx, grip(ctx, 96));
    this.volley = 3.2;
    this.timer = 2.4;
    this.gun = 'bazooka';
    this.swapT = 1;
    this.live.length = 0;

    // 1. The rocket. One, out of the tube on his shoulder, and it goes off
    //    against the wall on its own - it is not part of the trick, it is what
    //    opens the door for the rest of it.
    const muzzle = grip(ctx, 96);
    ctx.projectiles.push(new Projectile({
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(a) * 1080, vy: Math.sin(a) * 1080,
      kind: 'rocket', gravity: 190, radius: 8, life: 5, blast: BLASTS.bazooka,
    }));
    this.fireT = 0.18;
    ctx.sfx('launch', 0.8);
    ctx.shake(12);
    ctx.flash(0.2);
    ctx.sm.applyRecoil(1.2, a, 170);
    const back = grip(ctx, -26);
    ctx.particles.smoke(back.x, back.y, 9, 12);
    ctx.particles.streaks(back.x, back.y, 7, a + Math.PI, 0.8, 80);

    // 2. Three grenades, thrown by hand after it down the same line at three
    //    speeds so they string out instead of arriving as one lump. Nobody
    //    else in the arsenal has these; they are his party piece.
    for (let i = 0; i < 3; i++) {
      ctx.after(GRENADE_AT + i * 0.13, () => {
        const from = grip(ctx, 46, -6);
        // Fastest first, so they stay strung out instead of the tail catching
        // the head and all three arriving together.
        const speed = 900 - i * 130;
        const p = new Projectile({
          x: from.x, y: from.y,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 150,
          kind: 'grenade', gravity: 620, radius: 9, life: 6, blast: BLASTS.grenade,
        });
        this.live.push(p);
        ctx.projectiles.push(p);
        this.throwT = THROW_TIME;
        ctx.sfx('swing', 1.25 + i * 0.06);
        ctx.sm.applyRecoil(0.3, a, 14);
      });
    }

    // 3. And the rifle comes off his back to meet them there.
    ctx.after(RIFLE_AT, () => { this.gun = 'rifle'; this.swapT = 1; ctx.sfx('ui', 1.5); });
  }

  /**
   * Waiting on the grenades.
   *
   * The rifle does not fire on a stopwatch: it fires when a grenade is nearly
   * on the wall, so the three explosions land *there* rather than halfway
   * across the room. Every frame the front one is cast along its own flight,
   * and the moment there is less than a body's length of air left in front of
   * it he puts a round through it.
   */
  private watchGrenades(ctx: WeaponCtx): void {
    this.snipeT = Math.max(0, this.snipeT - ctx.dt);
    if (this.gun !== 'rifle' || this.snipeT > 0) return;
    while (this.live.length > 0 && this.live[0].dead) this.live.shift();
    const g = this.live[0];
    if (!g) return;
    const sp = Math.hypot(g.vx, g.vy) || 1;
    const ahead = ctx.terrain.strikePoint(g.x, g.y, g.vx / sp, g.vy / sp, SNIPE_AT, 3);
    // Or it has run out of air time and is about to bury itself in the floor.
    if (!ahead && g.life > 0.35) return;
    this.snipeT = 0.09;
    this.shootOne(ctx);
  }

  /** One rifle round, aimed at the oldest grenade still up. */
  private shootOne(ctx: WeaponCtx): void {
    this.heat = Math.min(1, this.heat + 0.3);
    const muzzle = grip(ctx, 90);
    while (this.live.length > 0 && this.live[0].dead) this.live.shift();
    const g = this.live.shift();
    const a = g
      ? Math.atan2(g.y - muzzle.y, g.x - muzzle.x)
      : this.aimFrom(ctx, muzzle);
    this.flashT = 0.05;
    ctx.sfx('rifle', rand(0.94, 1.06));
    ctx.sm.applyRecoil(0.34, a, 12);
    ctx.shake(3);
    ctx.particles.sparks(muzzle.x - Math.cos(a) * 34, muzzle.y - Math.sin(a) * 34, 1, 150,
      -Math.PI / 2 + rand(-0.5, 0.5), 0.6);
    if (!g) { this.hitscan(ctx, muzzle, a, 1500, 5.6); return; }
    const dist = Math.hypot(g.x - muzzle.x, g.y - muzzle.y);
    ctx.particles.tracer(muzzle.x, muzzle.y, g.x, g.y, 3600, 0.7);
    // The round arrives, and the grenade is where it was going to be anyway.
    ctx.after(dist / 3600, () => {
      if (g.dead) return;
      g.dead = true;
      g.hitAt = { x: g.x, y: g.y };
    });
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
    this.kick = Math.max(0, this.kick - ctx.dt * 3.4);
    this.fireT = Math.max(0, this.fireT - ctx.dt);
    this.swapT = Math.max(0, this.swapT - ctx.dt * 4);
    this.throwT = Math.max(0, this.throwT - ctx.dt);
    if (!held) this.heat = Math.max(0, this.heat - ctx.dt * 1.6);
    if (this.volley > 0) {
      this.volley -= ctx.dt;
      this.watchGrenades(ctx);
      // The sequence is not over while anything is still in the air.
      if (this.volley <= 0 && this.live.some((g) => !g.dead)) this.volley = 0.4;
      if (this.volley <= 0) { this.live.length = 0; this.gun = 'magnum'; this.swapT = 1; }
      return;
    }
    // Shouldering the tube while the trigger is down.
    if (held && this.heldFor > SLING_HOLD && this.gun !== 'bazooka') {
      this.gun = 'bazooka';
      this.swapT = 1;
      ctx.sfx('ui', 1.2);
    }
  }

  hands(ctx: WeaponCtx): HandTargets {
    // The grenades go over-arm. They are the one thing in this slot that
    // leaves his hand rather than a barrel, and they should look like it.
    if (this.throwT > 0) return throwArms(ctx, 1 - this.throwT / THROW_TIME, true, 48);
    switch (this.gun) {
      case 'magnum':
        // One hand on it; the other swings with the gait.
        return { main: grip(ctx, 38 - this.kick * 5, 1 - this.kick * 7), off: null };
      case 'shotgun': {
        const pump = this.anim > 0 ? Math.sin(clamp((this.t - 0.15) / 0.7, 0, 1) * Math.PI) : 0;
        return { main: grip(ctx, 30, 3), off: grip(ctx, 45 - pump * 14, 4) };
      }
      case 'rifle':
        return { main: grip(ctx, 31, 3), off: grip(ctx, 45, 4) };
      default:
        return { main: grip(ctx, 28, 11), off: grip(ctx, 48, 9) };
    }
  }

  // ---------------------------------------------------------------- drawing ---

  /**
   * The three he is not holding, slung across his back.
   *
   * This is the whole point of the slot: you can see at a glance that he has
   * the other three on him, and which one has just come off the strap.
   */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const p = ctx.sm.pose;
    const f = ctx.sm.facing;
    // Hung off the spine, angled across the back, fanned so all three read.
    const mid = { x: (p.neck.x + p.pelvis.x) * 0.5 - f * 9, y: (p.neck.y + p.pelvis.y) * 0.5 };
    c.save();
    c.strokeStyle = '#000';
    const slung: Gun[] = (['magnum', 'shotgun', 'rifle', 'bazooka'] as Gun[])
      .filter((g) => g !== this.gun);
    // Stacked *parallel* across his back like a rack, not fanned out of one
    // point: three silhouettes radiating from the same shoulder piled into one
    // black scribble, and three lying side by side read instantly as three.
    // Muzzles up over the far shoulder, grips down by the hip - carried, not
    // hung. Laid out behind the spine so the barrels clear his own silhouette.
    const lay = f > 0 ? Math.PI + 0.74 : -0.74;
    const nx = -Math.sin(lay), ny = Math.cos(lay);
    for (let i = 0; i < slung.length; i++) {
      const o = (i - 1) * 13;
      c.save();
      c.translate(mid.x + nx * o - f * 12, mid.y + ny * o + 8);
      c.rotate(lay);
      c.scale(0.9, 0.9);
      this.slungGun(sk, slung[i]);
      c.restore();
    }
    // The strap itself, so they are plainly carried and not floating.
    sk.line({ x: p.neck.x - f * 2, y: p.neck.y + 2 }, { x: p.pelvis.x - f * 16, y: p.pelvis.y + 10 }, 3, 2, 0.8);
    c.restore();
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = this.gun === 'magnum'
      ? ctx.sm.pose.aim - ctx.sm.facing * this.kick * 0.5
      : ctx.sm.pose.aim;
    c.save();
    c.translate(h.x, h.y);
    c.rotate(a);
    if (Math.cos(a) < 0) c.scale(1, -1);
    // Coming off the back: it swings up into the hand rather than appearing.
    if (this.swapT > 0) c.rotate(-this.swapT * 0.9 * Math.sign(Math.cos(a) || 1));
    c.strokeStyle = '#000';
    this.drawGun(sk, this.gun, this.flashT);
    c.restore();
  }

  /**
   * A gun on the strap. Not the same drawing as the one in his hands, and it
   * must not be: three detailed weapons at two thirds scale piled into one
   * black smudge. On his back each is a silhouette with the one feature that
   * names it - a cylinder, a magazine, a pump, a flared tube.
   */
  private slungGun(sk: Sketch, gun: Gun): void {
    const c = sk.ctx;
    c.strokeStyle = '#000';
    switch (gun) {
      case 'magnum':
        sk.poly([{ x: -4, y: -4 }, { x: 20, y: -4 }, { x: 20, y: 1 }, { x: 1, y: 1 },
          { x: -1, y: 9 }, { x: -6, y: 9 }], 2, false, 0.5);
        sk.poly([{ x: 3, y: -4 }, { x: 10, y: -4 }, { x: 10, y: 1 }, { x: 3, y: 1 }], 2, false, 0.4);
        break;
      case 'shotgun':
        sk.poly([{ x: -18, y: 3 }, { x: -13, y: -4 }, { x: 34, y: -5 }, { x: 34, y: -1 },
          { x: 1, y: 0 }, { x: 0, y: 6 }, { x: -6, y: 6 }, { x: -13, y: 0 }], 2.4, false, 0.5);
        sk.line({ x: 3, y: -7 }, { x: 32, y: -8 }, 2, 1, 0.4);
        break;
      case 'rifle':
        sk.poly([{ x: -20, y: -2 }, { x: -15, y: -5 }, { x: 28, y: -6 }, { x: 28, y: -1 },
          { x: 6, y: -1 }, { x: 5, y: 5 }, { x: 0, y: 5 }, { x: 0, y: -1 },
          { x: -15, y: -1 }], 2.4, false, 0.5);
        sk.poly([{ x: 9, y: -1 }, { x: 15, y: -1 }, { x: 14, y: 8 }, { x: 10, y: 8 }], 2.1, false, 0.4);
        break;
      default:
        sk.poly([{ x: -26, y: -9 }, { x: -19, y: -6 }, { x: 34, y: -6 }, { x: 34, y: 2 },
          { x: -19, y: 2 }, { x: -26, y: 6 }], 2.6, false, 0.5);
        sk.poly([{ x: 34, y: -5 }, { x: 41, y: -2 }, { x: 34, y: 1 }], 2.2, false, 0.4);
        break;
    }
  }

  /** One gun in its own local space: hand at the origin, muzzle to +x. */
  private drawGun(sk: Sketch, gun: Gun, flash: number): void {
    const c = sk.ctx;
    c.strokeStyle = '#000';
    switch (gun) {
      case 'magnum': {
        sk.poly([
          { x: -7, y: -7 }, { x: 6, y: -8 }, { x: 30, y: -8 }, { x: 30, y: -2 },
          { x: 4, y: -1 }, { x: 2, y: 12 }, { x: -7, y: 13 },
        ], 3.2, false, 0.5);
        sk.poly([{ x: 5, y: -7 }, { x: 15, y: -7 }, { x: 15, y: 4 }, { x: 5, y: 4 }], 2.8, false, 0.45);
        sk.line({ x: 8, y: -7 }, { x: 8, y: 4 }, 1.8, 1, 0.3);
        sk.line({ x: 12, y: -7 }, { x: 12, y: 4 }, 1.8, 1, 0.3);
        sk.line({ x: 18, y: -11 }, { x: 30, y: -11 }, 2.2, 1, 0.4);
        sk.line({ x: -5, y: -9 }, { x: 3, y: -9 }, 2.2, 1, 0.4);
        if (flash > 0) this.muzzle(sk, 34, -5, 26, 101);
        break;
      }
      case 'shotgun': {
        const pump = this.anim > 0 ? Math.sin(clamp((this.t - 0.15) / 0.7, 0, 1) * Math.PI) : 0;
        sk.poly([
          { x: -28, y: 4 }, { x: -20, y: -7 }, { x: 52, y: -8 }, { x: 52, y: -1 },
          { x: 2, y: 0 }, { x: 0, y: 9 }, { x: -8, y: 9 }, { x: -20, y: -1 },
        ], 2.9, false, 0.55);
        const fx = 26 - pump * 17;
        sk.poly([{ x: fx, y: -1 }, { x: fx + 16, y: -1 }, { x: fx + 16, y: 6 }, { x: fx, y: 6 }], 2.4, false, 0.5);
        sk.line({ x: 4, y: -10 }, { x: 50, y: -11 }, 2.2, 2, 0.5);
        if (flash > 0) this.muzzle(sk, 56, -5, 30, 303);
        break;
      }
      case 'rifle': {
        sk.poly([
          { x: -30, y: -3 }, { x: -22, y: -8 }, { x: 6, y: -8 }, { x: 10, y: -11 },
          { x: 34, y: -10 }, { x: 34, y: -6 }, { x: 44, y: -6 }, { x: 44, y: -2 },
          { x: 10, y: -1 }, { x: 8, y: 8 }, { x: 1, y: 9 }, { x: 0, y: -1 },
          { x: -22, y: -1 }, { x: -30, y: 2 },
        ], 2.8, false, 0.55);
        sk.line({ x: 12, y: -13 }, { x: 26, y: -13 }, 2, 1, 0.4);
        sk.poly([{ x: 14, y: -1 }, { x: 22, y: -1 }, { x: 20, y: 12 }, { x: 15, y: 12 }], 2.4, false, 0.5);
        sk.line({ x: 44, y: -4 }, { x: 58, y: -4 }, 3.2, 1, 0.4);
        if (flash > 0) this.muzzle(sk, 60, -4, 20 + this.heat * 8, 202);
        break;
      }
      default: {
        sk.poly([
          { x: -44, y: -17 }, { x: -32, y: -11 }, { x: 62, y: -11 }, { x: 62, y: 3 },
          { x: -32, y: 3 }, { x: -44, y: 10 },
        ], 3.2, false, 0.6);
        sk.line({ x: -32, y: -11 }, { x: -32, y: 3 }, 2.4, 1, 0.4);
        sk.poly([{ x: 62, y: -9 }, { x: 74, y: -4 }, { x: 62, y: 1 }], 2.6, false, 0.4);
        sk.line({ x: 4, y: -11 }, { x: 4, y: -23 }, 2.4, 1, 0.4);
        sk.line({ x: -4, y: -23 }, { x: 14, y: -23 }, 2.4, 1, 0.4);
        sk.line({ x: -14, y: 3 }, { x: -16, y: 17 }, 3, 1, 0.5);
        sk.line({ x: 24, y: 3 }, { x: 26, y: 15 }, 2.8, 1, 0.5);
        if (this.fireT > 0) {
          const k = this.fireT / 0.18;
          this.muzzle(sk, 78, -4, 34 * k, 404);
          c.lineWidth = 2.8;
          sk.burst(-42, -4, 8, 8, 54 * k, 2.8, 1.3, Math.PI, 405);
        }
        break;
      }
    }
  }

  /**
   * The emblem is not one of the four guns - picking one would be a lie about
   * what the slot is. It is a revolver crossed with a rifle over a strap,
   * which reads as "he is carrying an armoury" at twenty pixels.
   */
  icon(sk: Sketch, x: number, y: number, s: number): void {
    for (const d of [-1, 1]) {
      const c = sk.ctx;
      c.save();
      c.translate(x, y);
      c.rotate(d * 0.62);
      sk.poly([
        { x: -s * 0.34, y: -s * 0.1 }, { x: s * 0.3, y: -s * 0.12 },
        { x: s * 0.3, y: s * 0.02 }, { x: -s * 0.16, y: s * 0.04 },
        { x: -s * 0.2, y: s * 0.3 }, { x: -s * 0.36, y: s * 0.3 },
      ], 2.1, false, 0.45);
      c.restore();
    }
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
/** Under this much charge a release is a thrown ball rather than the beam. */
const ORB_TAP = 0.22;

export class EnergyBeam extends Weapon {
  readonly id = 14;
  readonly name = 'SAYAJEANS';
  override readonly group = 'extra' as const;
  readonly tagline = 'two hands throwing, or gather it all and let go';
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
  /** Seconds since the last thrown ball, and which hand threw it. */
  private orbT = 0;
  private orbSide = 1;

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
    if (power < ORB_TAP) { this.throwOrb(ctx); return; }
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

  /**
   * The ordinary shot: one ball of light out of one hand, and the next one out
   * of the other.
   *
   * No wind-up, no charge meter and - deliberately - no screen shake at all.
   * The whole weight of this slot lives in the held beam, so what the trigger
   * does on a tap has to be *light*: the aura barely comes up, the hands take
   * turns, and he can hang in the air throwing them.
   */
  private throwOrb(ctx: WeaponCtx): void {
    this.orbSide = -this.orbSide;
    this.orbT = 0.2;
    this.cooldown = 0.19;
    this.timer = this.cooldown;
    this.startAnim(0.19);
    // A light lift under the aura rather than a shove: enough for it to show.
    this.thrust = Math.max(this.thrust, 0.42);
    if (!ctx.sm.onGround) this.airborne = true;

    const from = grip(ctx, 44, this.orbSide * 12);
    const a = this.aimFrom(ctx, from) + rand(-0.02, 0.02);
    ctx.projectiles.push(new Projectile({
      x: from.x, y: from.y,
      vx: Math.cos(a) * 1150, vy: Math.sin(a) * 1150,
      kind: 'orb', gravity: 0, radius: 9, life: 2.6,
      blast: { ...BLASTS.orb, radius: BLASTS.orb.radius * 1.15, shake: 4 },
    }));
    ctx.sfx('fire', rand(1.15, 1.3));
    ctx.particles.streaks(from.x, from.y, 3, a, 0.5, 46);
    // He is pushed a hair back by each one, and in the air that is what keeps
    // him up: throwing is the thrust.
    ctx.sm.applyRecoil(0.22, a, this.airborne ? 26 : 8);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.orbT = Math.max(0, this.orbT - ctx.dt);
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
  override stance(ctx: WeaponCtx): Stance | null {
    // Throwing keeps him up. A ball a fifth of a second, each one shoving him
    // back a little, is exactly the excuse a figure needs to hang in the air -
    // so as long as they keep coming, so does the float.
    if (this.orbT > 0 && !ctx.sm.onGround) {
      return { kind: 'hover', weight: 1, lean: -0.06, hip: 2 };
    }
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
    if (this.orbT > 0 && this.beam <= 0 && this.charge < 0.05) {
      // The hand that just threw swings through from behind the shoulder; the
      // other is cocked back with the next one already in it.
      return throwArms(ctx, 1 - this.orbT / 0.2, this.orbSide > 0, 46);
    }
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
   * The hair.
   *
   * A soft nod and no more: five swept-back spikes standing off the top of the
   * skull, white with an ink edge like everything else that has to read over
   * the wall. They stand taller and rake back further as the aura comes up, so
   * the head is doing the same thing the rest of the figure is - and it is the
   * one mark that names this slot before anything has been fired.
   */
  private drawHair(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const p = sm.pose.head;
    const f = sm.facing;
    const R = HEAD_R;
    const k = this.aura;
    const tilt = headTilt(sm);
    const cs = Math.cos(tilt), sn = Math.sin(tilt);
    const at = (dx: number, dy: number): Vec2 =>
      ({ x: p.x + dx * cs - dy * sn, y: p.y + dx * sn + dy * cs });

    c.save();
    c.strokeStyle = '#000';
    const n = 5;
    for (let i = 0; i < n; i++) {
      // Rooted across the crown, front to back, and swept the way he faces.
      const t = i / (n - 1) - 0.5;
      const rootX = -f * t * R * 1.5;
      const rootY = -R * (0.82 - Math.abs(t) * 0.34);
      // The middle spikes are the long ones; every drawing they flick a little.
      const len = R * (1.05 + Math.cos(t * 2.4) * 0.5) * (1 + k * 0.55)
        * (1 + hashNoise(i * 7, sk.boil) * 0.1);
      const rake = -f * (0.35 + Math.abs(t) * 0.5) * len;
      const half = R * 0.3 * (1 - Math.abs(t) * 0.3);
      const spike = [
        at(rootX - half, rootY),
        at(rootX + rake * 0.55 - half * 0.4, rootY - len * 0.62),
        at(rootX + rake, rootY - len),
        at(rootX + rake * 0.6 + half * 0.5, rootY - len * 0.5),
        at(rootX + half, rootY + R * 0.06),
      ];
      c.fillStyle = '#fff';
      sk.polyPath(spike, 0.8);
      c.fill();
      sk.poly(spike, 3, false, 0.8);
    }
    c.restore();
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

    this.drawHair(sk, ctx);

    // --- the ball still in the other hand -----------------------------------
    if (this.orbT > 0 && this.beam <= 0 && this.charge < 0.05) {
      const k = this.orbT / 0.2;
      const held = this.orbSide > 0 ? o : h;
      const r = 6 + k * 4;
      const ball: Vec2[] = [];
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * TAU + ctx.time * 3;
        ball.push({ x: held.x + Math.cos(ang) * r, y: held.y + Math.sin(ang) * r });
      }
      sk.inked(() => sk.polyPath(ball, 1), 3.2, 0.3, 771);
      c.strokeStyle = '#000';
      c.lineWidth = 2;
      sk.burst(held.x, held.y, 6, r * 1.4, r * 2.6, 2, TAU, 0, 772);
    }

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
    // MAIN - the set the source film actually shows him using, in the order it
    // climbs: hands, edges, weather, then the things that stop being weapons.
    new Fists(), new Greatsword(), new Warhammer(), new Wind(),
    new Gunslinger(), new MissilePods(), new ArcaneStaff(), new Shinobi(),
    new Thunderbolt(), new Mecha(), new SplitHead(), new Titan(), new Shout(),
    // EXTRA - built on top of the film rather than taken from it.
    new EnergyBeam(),
  ];
}

export { applyBlast };
