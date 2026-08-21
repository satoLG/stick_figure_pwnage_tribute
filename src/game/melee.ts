import type { SfxName } from '../core/audio';
import {
  clamp, easeInCubic, easeOutCubic, easeOutQuint, lerpVec, rand, smoothstep, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { applyBlast, type Blast } from './projectiles';
import { RUN_ATTACK_SPEED, type HandTargets, type Stance, type StanceKind } from './stickman';
import { gripAt, SlashFx, toward, Weapon, type WeaponCtx } from './weapon-base';

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
  /** Shown in the HUD while the chain is running. */
  name?: string;
}

/**
 * The angle that puts the far end of a `len`-long weapon flat on the floor
 * behind the figure - what "too heavy to carry" looks like. Null when there is
 * no floor under it to drag along.
 */
export function dragAngle(ctx: WeaponCtx, from: Vec2, len: number, facing: number): number | null {
  const probeX = from.x - facing * len * 0.9;
  const drop = ctx.terrain.groundBelow(probeX, from.y, 260);
  if (drop >= 260) return null;
  // The tip is `len` from the hand, so the drop straight down fixes the sine.
  const a = Math.asin(clamp(drop / len, -0.96, 0.96));
  return facing > 0 ? Math.PI - a : a;
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
  override auto = true;

  /** Length of the weapon in world units. Reach is measured against this. */
  protected abstract readonly len: number;
  /** The four chains. Each is cycled from the top while the player keeps going. */
  protected abstract readonly sets: Record<MeleeMode, readonly MeleeMove[]>;

  protected fx = new SlashFx();
  protected move: MeleeMove = FALLBACK;
  protected mode: MeleeMode = 'ground';
  /** How many strikes have landed back to back without losing the rhythm. */
  protected combo = 0;
  /** How far the hands travel out along the weapon when it is swinging. */
  protected gripFwd = 36;
  protected gripLead = 0.3;

  private chain = 0;
  private idle = 0;
  private heldFor = 0;
  private struck = false;

  override onEquip(): void {
    super.onEquip();
    this.chain = 0;
    this.combo = 0;
    this.mode = 'ground';
    this.heldFor = 0;
    this.move = this.sets.ground[0] ?? FALLBACK;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.fx.clear();
    this.combo = 0;
    this.chain = 0;
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

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.fx.update(ctx.dt);
    this.heldFor = held ? this.heldFor + ctx.dt : 0;

    if (this.anim <= 0) {
      this.idle += ctx.dt;
      if (this.idle > COMBO_WINDOW && (this.chain !== 0 || this.combo !== 0)) {
        this.chain = 0;
        this.combo = 0;
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
      // Straight down the aim: a small mouth and a deep tunnel behind it.
      const hit = ctx.terrain.raycast(h.x, h.y, ca, sa, reach + 24, 3);
      if (hit) {
        at = hit;
        removed = ctx.terrain.carveBlob(hit.x, hit.y, thick, 0.35, 18).removed;
        removed += ctx.terrain.carveCapsule(
          hit.x, hit.y, hit.x + ca * thick * 1.6, hit.y + sa * thick * 1.6, thick * 0.66, 0.3,
        ).removed;
      }
      ctx.particles.streaks(h.x + ca * 20, h.y + sa * 20, heavy ? 7 : 4, a, 0.5, 30 + thick * 2);
    } else {
      const from = a + mv.from * f;
      const to = a + mv.to * f;
      removed = ctx.terrain.carveArc(h.x, h.y, reach, from, to, thick).removed;
      // The visible crescent goes up whether or not it found anything: a cut
      // through empty air still has to look like a cut.
      this.fx.add(h.x, h.y, reach, from, to, thick * 1.12, heavy ? 0.2 : 0.14, heavy ? 34 : 22);
      if (mv.cross) {
        const from2 = a - mv.from * f, to2 = a - mv.to * f;
        removed += ctx.terrain.carveArc(h.x, h.y, reach, from2, to2, thick).removed;
        this.fx.add(h.x, h.y, reach, from2, to2, thick * 1.12, 0.14, 26);
      }
    }

    if (mv.blast) {
      // A crater weapon. The head lands wherever the swing put it, but the
      // floor does not break, so a smash that finds only ground still has to
      // reach for the wall in front of him or the weapon does nothing at all.
      const ang = this.bladeAngle(ctx);
      const tip = { x: h.x + Math.cos(ang) * this.len, y: h.y + Math.sin(ang) * this.len };
      const hitPoint = ctx.terrain.raycast(h.x, h.y, Math.cos(ang), Math.sin(ang), this.len + 26, 3)
        ?? ctx.terrain.raycast(h.x, h.y, ca, sa, this.len + 70, 3)
        ?? ctx.terrain.raycast(tip.x, tip.y, ca, sa, 90, 3);
      if (hitPoint) {
        at = hitPoint;
        removed += applyBlast(ctx.terrain, hitPoint.x, hitPoint.y, mv.blast);
        ctx.particles.shockwave(hitPoint.x, hitPoint.y, mv.blast.radius * 1.5);
        ctx.particles.debris(hitPoint.x, hitPoint.y, mv.blast.debris, 240 + mv.blast.radius * 3);
        ctx.particles.smoke(hitPoint.x, hitPoint.y, 6, 22);
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
    ctx.hit(at.x, at.y, a, heavy ? 1.6 : 0.85);
    // Two drawn frames inverted, then back to paper.
    ctx.invert(heavy ? 0.2 : 0.14);
    // One drawn frame of held time on a light hit, two on a heavy one. At
    // fifteen frames a second that is already 66 and 133ms of dead stop.
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

  /** The angle the weapon is held at right now, mid-swing or at rest. */
  protected bladeAngle(ctx: WeaponCtx): number {
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

  /** The cuts hang behind the figure, so a big slash never hides him. */
  override drawBehind(sk: Sketch): void { this.fx.draw(sk); }

  /** Draws the weapon itself around `angle`, anchored at the main hand. */
  protected abstract drawWeapon(sk: Sketch, ctx: WeaponCtx, angle: number): void;

  draw(sk: Sketch, ctx: WeaponCtx): void {
    // No fan of ghost blades, no ribbon off the tip. A fast weapon is one
    // shape moving between two drawings, not a stack of translucent copies -
    // the copies are exactly what made a swing unreadable.
    this.drawWeapon(sk, ctx, this.bladeAngle(ctx));
  }
}
