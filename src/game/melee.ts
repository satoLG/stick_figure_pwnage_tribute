import type { SfxName } from '../core/audio';
import {
  clamp, damp, easeInCubic, easeOutCubic, easeOutQuint, lerpVec, rand, smoothstep, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { applyBlast, type Blast } from './projectiles';
import { RUN_ATTACK_SPEED, type HandTargets, type Stance, type StanceKind } from './stickman';
import { gripAt, toward, Weapon, type WeaponCtx } from './weapon-base';

/**
 * Which sequence of strikes the figure is in the middle of. Every melee weapon
 * carries four of them, and which one a swing comes from is decided by what the
 * player was doing at the moment they attacked - not by a separate button.
 */
export type MeleeMode = 'ground' | 'run' | 'air' | 'hold';

/** How long the trigger has to be down before the swings turn into heavy ones. */
const HOLD_TIME = 0.34;
/** Let go of the rhythm for this long and the chain drops back to its first hit. */
const COMBO_WINDOW = 0.62;

/** One strike in a chain. Everything about how it feels lives in here. */
export interface MeleeMove {
  /** A sweep of the weapon, or a straight thrust down the aim line. */
  kind?: 'arc' | 'thrust';
  /** Where the wind-up parks the weapon and where the strike finishes, in
   *  radians relative to the aim and mirrored with the facing. */
  from: number; to: number;
  /** Fractions of the animation spent coiling, then actually striking. */
  wind: number; strike: number;
  anim: number; cooldown: number;
  /** Reach as a fraction of the weapon's length, and how wide a bite it takes. */
  reach?: number; thick?: number;
  /** Impulses: forward along the facing, upward, and a shove back after the hit. */
  dash?: number; lift?: number; recover?: number;
  /** Whole turns of body rotation, and the hop that makes room for them. */
  spin?: number; hop?: number;
  /** Seconds of low-friction travel, so a committed step becomes a slide. */
  slide?: number;
  /** A full-body stance held through the strike. */
  stance?: StanceKind;
  stanceLean?: number; stanceHip?: number;
  /** Seconds the stance takes to let go once the strike has landed. */
  stanceOut?: number;
  /** A second bite mirrored about the aim: the X cut. */
  cross?: boolean;
  /**
   * Claws. Instead of one solid wedge the sweep leaves this many separate
   * parallel gouges, which is the whole reading of a raking hit: the wall is
   * not cut through, it is scored, and you can count the marks.
   */
  rake?: number;
  /** Craters instead of slicing - the hammer. */
  blast?: Blast;
  /** Bigger recovery, louder hit, more screen. */
  heavy?: boolean;
  swingSfx?: SfxName; swingPitch?: number;
  hitSfx?: SfxName; hitPitch?: number;
  shake?: number; flash?: number; invert?: number;
  ghost?: number;
  /** Kicks dust and a ring out along the floor where it lands. */
  quake?: number;
  /**
   * How big the fan of lines converging on the point of contact comes out,
   * 0.3..2. The default is a light or a heavy hit; a weapon whose whole point
   * is the size of the blow - the hammer - asks for the top of the range, and
   * gets a sheet of speed lines across a third of the screen.
   */
  impact?: number;
  /** Shown in the HUD while the chain is running. */
  name?: string;
}

/**
 * How much of the weapon's length, measured out from the hand, is allowed to be
 * inside the scenery before it counts as buried. A hand pressed flat against
 * the masonry is two drawings overlapping and nothing to fix; a blade halfway
 * through the floor is.
 */
const CLEAR_FROM = 0.34;
/** How far the weapon may be turned off its intended angle to get itself out. */
const CLEAR_LIMIT = 1.5;

/** How much of the weapon, from the hand out, is in open air at this angle. */
function freeRun(ctx: WeaponCtx, from: Vec2, len: number, ang: number): number {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const step = len * 0.06;
  for (let d = len * CLEAR_FROM; d <= len; d += step) {
    if (ctx.terrain.solidAt(from.x + ca * d, from.y + sa * d)) return d;
  }
  return len;
}

/**
 * Keeps a weapon out of the scenery.
 *
 * A sword or a hammer is drawn as a rigid bar hanging off a hand, and nothing
 * in the pose knows the floor is there - so a low guard puts a metre of blade
 * under the pavement, a swing finishes with the head buried in the ground it
 * cannot break, and a stance up against the wall runs the whole weapon into the
 * masonry. The figure collides with the world; the thing he is carrying should
 * too.
 *
 * It is not a physics body, and it should not be: what the eye wants is simply
 * that the weapon never crosses a surface. So the intended angle is tested, and
 * if the bar is inside anything it is turned - the smallest amount, and
 * whichever way is nearer - until it is lying clear.
 *
 * Standing in the corner between the floor and the wall there may be no clear
 * angle at all, and the answer there is *not* to give up and take the intended
 * one: that is the case where a weapon disappears into the masonry entirely.
 * Instead the angle that keeps the most of the weapon in open air wins, so it
 * ends up leaning against whatever it has run into, which is what a heavy thing
 * with a floor under it actually does.
 */
export function clearOfTerrain(
  ctx: WeaponCtx, from: Vec2, len: number, want: number,
  limit = CLEAR_LIMIT, step = 0.09,
): number {
  let best = freeRun(ctx, from, len, want);
  if (best >= len) return want;
  let bestAng = want;
  for (let d = step; d <= limit; d += step) {
    for (const s of [-1, 1]) {
      const a = want + s * d;
      const run = freeRun(ctx, from, len, a);
      // Fully clear, and the nearest such angle, since the search walks out.
      if (run >= len) return a;
      // Otherwise remember whichever leans least far into the material. The
      // margin keeps it from swapping between two near-equal answers frame to
      // frame, which is what a weapon flickering between poses looks like.
      if (run > best + len * 0.04) { best = run; bestAng = a; }
    }
  }
  return bestAng;
}

const FALLBACK: MeleeMove = {
  from: -1.6, to: 0.9, wind: 0.34, strike: 0.2, anim: 0.3, cooldown: 0.3,
};

/**
 * The shared body of every melee weapon: combo chains, the timing of a strike,
 * the carve it takes out of the wall and the pose it drags the figure through.
 *
 * A subclass only has to say how long the weapon is, what its four chains are,
 * where it rests, and how to draw it.
 */
export abstract class MeleeWeapon extends Weapon {
  override readonly ranged = false;
  override auto = true;

  /** Length of the weapon in world units. Reach is measured against this. */
  protected abstract readonly len: number;
  /** The four chains. Each is cycled from the top while the player keeps going. */
  protected abstract readonly sets: Record<MeleeMode, readonly MeleeMove[]>;

  /**
   * Whether the scenery is allowed to stop this weapon.
   *
   * On for anything with a real body to it - a slab of a blade, a block of a
   * head - and off for a fist, which has nothing sticking out of it to bury.
   */
  protected readonly collides: boolean = false;
  /** The damped turn currently keeping it out of the floor and the wall. */
  private clearAdj = 0;

  protected move: MeleeMove = FALLBACK;
  protected mode: MeleeMode = 'ground';
  /** How many strikes have landed back to back without losing the rhythm. */
  protected combo = 0;
  /** How far the hands travel out along the weapon when it is swinging. */
  protected gripFwd = 36;
  protected gripLead = 0.3;

  private chain = 0;
  private idle = 0;
  private struck = false;
  /**
   * A held chain, once it has started, is a committed sequence.
   *
   * Without this the swordsman's charge falls apart the instant it leaves the
   * ground: the leap that opens it makes him airborne, `pickMode` reads that
   * as the air chain, the chain counter resets, and the three cuts he jumped
   * across the room to land never come out. A hold chain therefore keeps hold
   * of the mode until it has run all the way round.
   */
  private holdLock = false;

  override onEquip(): void {
    super.onEquip();
    this.chain = 0;
    this.combo = 0;
    this.holdLock = false;
    this.mode = 'ground';
    this.move = this.sets.ground[0] ?? FALLBACK;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.combo = 0;
    this.chain = 0;
    this.holdLock = false;
  }

  override get comboLabel(): string | null {
    if (this.combo < 2 || (this.anim <= 0 && this.idle > COMBO_WINDOW)) return null;
    const n = this.move.name;
    return n ? `${n}  x${this.combo}` : `x${this.combo}`;
  }

  // ------------------------------------------------------------- selection ---

  /**
   * What the player was doing when they swung. Airborne beats everything, then
   * a real run, then a held trigger; standing still is the default chain.
   */
  private pickMode(ctx: WeaponCtx): MeleeMode {
    if (this.holdLock) return 'hold';
    if (!ctx.sm.onGround) return 'air';
    if (Math.abs(ctx.sm.vel.x) > RUN_ATTACK_SPEED) return 'run';
    if (this.heldFor > HOLD_TIME) return 'hold';
    return 'ground';
  }

  protected override release(ctx: WeaponCtx): void {
    const mode = this.pickMode(ctx);
    if (mode !== this.mode) { this.mode = mode; this.chain = 0; }
    const list = this.sets[mode].length > 0 ? this.sets[mode] : this.sets.ground;
    const mv = list[this.chain % list.length] ?? FALLBACK;

    this.chain++;
    // A multi-step hold chain holds the mode until it wraps back to its start.
    this.holdLock = mode === 'hold' && list.length > 1 && this.chain % list.length !== 0;
    this.startMove(ctx, mv);
  }

  /**
   * Run one named strike, whatever the chain was going to do.
   *
   * A weapon whose held trigger is a *wind-up* rather than a chain - the
   * smasher, which stores it and then batters the wall with it once you let
   * go - drives its own sequence through here, so the timing, the impulses and
   * the sound of a swing all stay in one place.
   */
  protected startMove(ctx: WeaponCtx, mv: MeleeMove): void {
    this.combo++;
    this.move = mv;
    this.struck = false;
    this.idle = 0;

    // The base class started a default-length animation a moment ago; a combo
    // step owns its own timing, so both clocks get re-pointed here - including
    // the public cooldown, which is what the HUD meter reads.
    this.startAnim(mv.anim);
    this.cooldown = mv.cooldown;
    this.timer = mv.cooldown;

    const sm = ctx.sm;
    const f = sm.facing;
    if (mv.dash || mv.lift) sm.dash(f * (mv.dash ?? 0), -(mv.lift ?? 0));
    if (mv.slide) sm.slide(mv.slide);
    if (mv.spin) sm.spinFlourish(f * Math.sign(mv.spin), Math.abs(mv.spin), mv.hop ?? 0);
    // Afterimages only for a spin, where they read as rotation. On an ordinary
    // swing they are nine extra skeletons of ink for no information at all.
    if (mv.spin || mv.ghost) sm.addGhostBurst(mv.ghost ?? 0.22);

    ctx.sfx(mv.swingSfx ?? (mv.heavy ? 'heavyswing' : 'swing'),
      (mv.swingPitch ?? 1) * rand(0.94, 1.08));
    this.onRelease(ctx, mv);
  }

  /** Extra flavour a specific weapon wants at the moment a swing starts. */
  protected onRelease(_ctx: WeaponCtx, _mv: MeleeMove): void {}
  /** Called every frame the weapon is at rest; where weapon idles live. */
  protected idleTick(_ctx: WeaponCtx): void {}

  protected override tick(ctx: WeaponCtx, _held: boolean): void {
    // Where the scenery says the weapon may be, worked out once for the frame:
    // `bladeAngle` is read several times over a drawing - the hands, the carve,
    // the weapon itself - and all of them must agree on one answer.
    if (this.collides) {
      const raw = this.swingAngle(ctx);
      const want = clearOfTerrain(ctx, ctx.sm.pose.handR, this.len, raw) - raw;
      // Quick to get out of the way, slower to settle back, so a weapon coming
      // off a surface eases down onto its intended line rather than snapping.
      this.clearAdj = damp(this.clearAdj, want, Math.abs(want) > Math.abs(this.clearAdj) ? 26 : 12, ctx.dt);
    } else {
      this.clearAdj = 0;
    }

    if (this.anim <= 0) {
      this.idle += ctx.dt;
      if (this.idle > COMBO_WINDOW && (this.chain !== 0 || this.combo !== 0)) {
        this.chain = 0;
        this.combo = 0;
        this.holdLock = false;
      }
      this.idleTick(ctx);
      return;
    }

    const mv = this.move;
    if (!this.struck && this.t > mv.wind + mv.strike * 0.4) {
      this.struck = true;
      this.land(ctx, mv);
    }
  }

  // ----------------------------------------------------------------- damage ---

  /** The moment of contact: what gets carved, and everything that sells it. */
  private land(ctx: WeaponCtx, mv: MeleeMove): void {
    const sm = ctx.sm;
    const h = sm.pose.handR;
    const a = sm.pose.aim;
    const f = sm.facing;
    const ca = Math.cos(a), sa = Math.sin(a);
    const reach = this.len * (mv.reach ?? 0.8);
    const thick = mv.thick ?? 22;
    const heavy = !!mv.heavy;
    let removed = 0;
    let at: Vec2 = { x: h.x + ca * reach, y: h.y + sa * reach };

    if (mv.kind === 'thrust') {
      // Straight down the aim, and into the face rather than through it: a
      // punch drives a wide dent, it does not drill. The tunnel this used to
      // bore behind the mouth was the one thing that let a jab reach past the
      // masonry in front of it.
      const hit = ctx.terrain.strikePoint(h.x, h.y, ca, sa, reach + 24, 3);
      if (hit) {
        at = hit;
        removed = ctx.terrain.carveBlob(hit.x, hit.y, thick * 1.5, 0.35, 18, thick * 0.4).removed;
      }
      ctx.particles.streaks(h.x + ca * 20, h.y + sa * 20, heavy ? 7 : 4, a, 0.5, 30 + thick * 2);
    } else {
      const from = a + mv.from * f;
      const to = a + mv.to * f;
      // A solid wedge from the hilt right out to the tip. It used to be an
      // annulus - a crescent hanging out at the end of the blade - which is
      // how a swing came to take a bite out of the middle of the wall and
      // leave the slab in front of it standing. A blade sweeps everything
      // between the hand and the point, and now so does this.
      //
      // `thick` no longer sets where the cut starts; it sets how far into the
      // stone the edge gets, which is the only thing that should separate a
      // greatsword from a jab.
      const bite = thick * 0.22;
      if (mv.rake) {
        // Claws: a handful of thin concentric arcs at different radii, so what
        // is left in the masonry is a set of parallel scores rather than one
        // missing wedge. The gaps between them are the effect.
        const n = mv.rake;
        const band = reach * 0.5;
        const gouge = Math.max(4, band / (n * 2.1));
        for (let i = 0; i < n; i++) {
          const r0 = reach - band * (i / Math.max(1, n - 1)) - gouge;
          const cut = ctx.terrain.carveSector(h.x, h.y, r0, r0 + gouge, from, to, bite * 1.5);
          removed += cut.removed;
          for (const p of cut.edges.slice(0, 2)) {
            ctx.particles.debris(p.x, p.y, 1, 220, a + Math.PI, 2.2);
          }
        }
      } else {
        const cut = ctx.terrain.carveSector(h.x, h.y, 0, reach, from, to, bite);
        removed = cut.removed;
        // Fragments the cut stranded and knocked loose fall as real debris.
        for (const p of cut.edges.slice(0, 5)) ctx.particles.debris(p.x, p.y, 1, 190, a + Math.PI, 2.2);
      }
      if (mv.cross) {
        const from2 = a - mv.from * f, to2 = a - mv.to * f;
        removed += ctx.terrain.carveSector(h.x, h.y, 0, reach, from2, to2, bite).removed;
      }
    }

    if (mv.blast) {
      // A crater weapon. The head lands wherever the swing put it, but the
      // floor does not break, so a smash that finds only ground still has to
      // reach for the wall in front of him or the weapon does nothing at all.
      const ang = this.bladeAngle(ctx);
      const tip = { x: h.x + Math.cos(ang) * this.len, y: h.y + Math.sin(ang) * this.len };
      const hitPoint = ctx.terrain.strikePoint(h.x, h.y, Math.cos(ang), Math.sin(ang), this.len + 26, 3)
        ?? ctx.terrain.strikePoint(h.x, h.y, ca, sa, this.len + 70, 3)
        ?? ctx.terrain.strikePoint(tip.x, tip.y, ca, sa, 90, 3);
      if (hitPoint) {
        at = hitPoint;
        removed += applyBlast(ctx.terrain, hitPoint.x, hitPoint.y, mv.blast);
        // Particle sizes are now fractions of the playfield (see #9 / game.ts:detonate
        // for the same change). Melee blasts are smaller than projectile blasts, so the
        // fractions are scaled down accordingly; the `mv.blast.radius * k` terms still
        // let a Warhammer slam read bigger than a sword tap.
        const mw = ctx.terrain.w;
        ctx.particles.shockwave(hitPoint.x, hitPoint.y, mw * 0.12 + mv.blast.radius * 0.35);
        ctx.particles.debris(hitPoint.x, hitPoint.y, mv.blast.debris, mw * 0.24 + mv.blast.radius * 1.1);
        ctx.particles.smoke(hitPoint.x, hitPoint.y, 6, mw * 0.034);
      }
    }

    // --- what the strike does to the world and the screen --------------------
    //
    // Everything here is the reference film's grammar for a landed blow, and
    // nothing else is allowed in: one fan of lines converging on the point of
    // contact, two frames of inverted screen, and a couple of held frames. No
    // debris cloud, no sparks, no smoke - they are what turned every hit into
    // an unreadable scribble.
    const bit = removed > 0;
    const shake = mv.shake ?? (heavy ? 17 : 6);
    ctx.shake(bit ? shake : shake * 0.4);
    ctx.hit(at.x, at.y, a, mv.impact ?? (heavy ? 1.6 : 0.85));
    // Inverting the whole screen is the loudest thing this game can do, so it
    // is spent only on a charged special - the held chain's heavy finishers.
    if (heavy && this.mode === 'hold') ctx.invert(0.16);
    // One drawing of held time on a light hit, two on a heavy one. At
    // the source's 15Hz clock that is 67ms and 133ms of dead stop; see
    // WeaponCtx.freeze and Game.decayEffects for the picture-clock math.
    ctx.freeze(heavy ? 2 : 1);
    if (mv.quake) this.quake(ctx, at, mv.quake);

    const defaultHit: SfxName = mv.kind === 'thrust' ? 'punch' : 'slash';
    ctx.sfx(mv.hitSfx ?? defaultHit, (mv.hitPitch ?? 1) * (bit ? rand(0.92, 1.1) : rand(1.18, 1.36)));

    if (bit) {
      // A few big chunks off a heavy hit, and only off a heavy hit.
      if (heavy) ctx.particles.debris(at.x, at.y, 6, 260, a + Math.PI, 1.8);
      sm.applyRecoil(heavy ? 0.6 : 0.3, a, heavy ? 55 : 22);
    }
    if (mv.recover) sm.dash(-f * mv.recover);
  }

  /** The shock running out along the floor from a landed heavy strike. */
  private quake(ctx: WeaponCtx, at: Vec2, power: number): void {
    for (const d of [-1, 1]) {
      const gx = at.x + d * 40;
      const drop = ctx.terrain.groundBelow(gx, at.y - 10, 160);
      if (drop >= 160) continue;
      const gy = at.y - 10 + drop;
      ctx.particles.updraft(gx + d * 70 * power, gy, Math.round(4 + power * 5), 70, 150 + power * 160);
      ctx.particles.dust(gx + d * 30, gy, 3, d > 0 ? 0 : Math.PI, power);
      ctx.particles.shockwave(gx + d * 60, gy - 4, 70 * power);
    }
  }

  // ------------------------------------------------------------------- pose ---

  /** Where the weapon points when nothing is happening. */
  protected abstract restAngle(ctx: WeaponCtx): number;

  /**
   * The angle the weapon is held at right now: where the swing wants it, turned
   * by however much the floor and the wall are refusing to let it be there.
   */
  protected bladeAngle(ctx: WeaponCtx): number {
    return this.swingAngle(ctx) + this.clearAdj;
  }

  /** Where the swing alone would put it, with nothing in the way. */
  private swingAngle(ctx: WeaponCtx): number {
    const rest = this.restAngle(ctx);
    if (this.anim <= 0) return rest;
    const mv = this.move;
    const t = this.t;
    const f = ctx.sm.facing;
    const a = ctx.sm.pose.aim;
    const from = a + mv.from * f;
    const to = a + mv.to * f;

    if (t < mv.wind) {
      // Coil: slow at first, then snapping into the top of the swing.
      const k = t / mv.wind;
      return toward(rest, from, easeInCubic(k) * 0.4 + easeOutCubic(k) * 0.6);
    }
    if (t < mv.wind + mv.strike) {
      // The strike itself: almost all of the travel in the first third.
      return from + (to - from) * easeOutQuint((t - mv.wind) / mv.strike);
    }
    // Follow-through, then a drift back into the guard.
    const k = clamp((t - mv.wind - mv.strike) / Math.max(0.01, 1 - mv.wind - mv.strike), 0, 1);
    return toward(to, rest, k * k * 0.75);
  }

  /** 0..1: how far into the strike itself we are, for trails and glints. */
  protected get striking(): number {
    if (this.anim <= 0) return 0;
    const mv = this.move;
    return clamp((this.t - mv.wind) / Math.max(0.01, mv.strike * 2.4), 0, 1);
  }

  override stance(ctx: WeaponCtx): Stance | null {
    const mv = this.move;
    const kind = mv.stance;
    if (this.anim <= 0 || !kind) return null;
    const t = this.t;
    const out = mv.stanceOut ?? 0.34;
    const k = t < mv.wind
      ? easeOutCubic(t / mv.wind)
      : Math.max(0, 1 - (t - mv.wind) / out);
    if (k < 0.02) return null;
    const air = ctx.sm.onGround ? 1 : 0.3;
    return {
      kind,
      weight: clamp(k * air, 0, 1),
      lean: mv.stanceLean ?? -0.12,
      hip: mv.stanceHip ?? -8,
    };
  }

  /** Where the hands sit when the weapon is not swinging. */
  protected abstract restHands(ctx: WeaponCtx, angle: number): HandTargets;

  hands(ctx: WeaponCtx): HandTargets | null {
    const ba = this.bladeAngle(ctx);
    const f = ctx.sm.facing;
    const rest = this.restHands(ctx, ba);
    if (this.anim <= 0) return rest;
    // Mid-swing the hands ride the hilt, so the arms drag the weapon around
    // instead of it floating off a frozen grip.
    const k = smoothstep(Math.min(this.t, 1 - this.t) / 0.18);
    const main = gripAt(ctx, ba - this.gripLead * f, this.gripFwd, 3 * f);
    const off = gripAt(ctx, ba - (this.gripLead + 0.2) * f, this.gripFwd - 6, 13 * f);
    return {
      main: lerpVec(rest.main, main, k),
      // A weapon that rests one-handed keeps its off arm free to swing.
      off: rest.off ? lerpVec(rest.off, off, k) : null,
    };
  }

  // ---------------------------------------------------------------- drawing ---

  /** Draws the weapon itself around `angle`, anchored at the main hand. */
  protected abstract drawWeapon(sk: Sketch, ctx: WeaponCtx, angle: number): void;

  draw(sk: Sketch, ctx: WeaponCtx): void {
    // No fan of ghost blades, no ribbon off the tip. A fast weapon is one
    // shape moving between two drawings, not a stack of translucent copies -
    // the copies are exactly what made a swing unreadable.
    this.drawWeapon(sk, ctx, this.bladeAngle(ctx));
  }
}
