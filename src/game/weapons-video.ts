/**
 * The four arsenals lifted straight out of the source animation.
 *
 * Everything in here is a shape somebody drew in the film first and a weapon
 * second, so the drawing leads: the mecha exists because of the winged head in
 * the reference, the rod array because of the four spikes fanning off a back,
 * the claws because of three parallel rips left in a wall. The numbers were
 * fitted to the pictures afterwards, never the other way round.
 */
import {
  clamp, damp, easeOutCubic, easeOutQuint, hashNoise, lerp, rand, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { MeleeWeapon, type MeleeMode, type MeleeMove } from './melee';
import { BLASTS, Projectile } from './projectiles';
import { type HandTargets, type Stance } from './stickman';
import { grip, gripAt, SlashFx, wallPoint, Weapon, type WeaponCtx } from './weapon-base';

/** A rough ring, the way everything round in this game is drawn. */
function ring(x: number, y: number, r: number, n: number, rot: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  return pts;
}

/**
 * A band of white with a hard ink edge, from one point to another. Every beam,
 * laser and bolt trail in here is one of these: it is the only shape that reads
 * as light on paper *and* as light against a solid black wall.
 */
function lightBand(sk: Sketch, from: Vec2, to: Vec2, w0: number, w1: number, wob = 2.4): void {
  const c = sk.ctx;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const steps = 10;
  const top: Vec2[] = [], bot: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = lerp(w0, w1, t) + hashNoise(i, sk.boil) * wob;
    top.push({ x: from.x + dx * t + nx * w, y: from.y + dy * t + ny * w });
    bot.push({ x: from.x + dx * t - nx * w, y: from.y + dy * t - ny * w });
  }
  c.beginPath();
  c.moveTo(top[0].x, top[0].y);
  for (const p of top) c.lineTo(p.x, p.y);
  for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
  c.closePath();
  c.fillStyle = '#fff';
  c.fill();
  c.strokeStyle = '#000';
  c.lineWidth = 3.2;
  c.beginPath();
  for (let i = 0; i < top.length; i++) { if (i === 0) c.moveTo(top[i].x, top[i].y); else c.lineTo(top[i].x, top[i].y); }
  c.stroke();
  c.beginPath();
  for (let i = 0; i < bot.length; i++) { if (i === 0) c.moveTo(bot[i].x, bot[i].y); else c.lineTo(bot[i].x, bot[i].y); }
  c.stroke();
}

// ---------------------------------------------------------------------------
// 4. CLAWS
// ---------------------------------------------------------------------------
/**
 * What the claws leave behind is the whole weapon: not a wedge missing out of
 * the wall but three parallel scores with masonry standing between them, which
 * is exactly how the reference draws a raking hit. `rake` on a move is what
 * turns one solid sector carve into that set of gouges.
 */
const CLAW_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    {
      from: -1.15, to: 0.9, wind: 0.22, strike: 0.16, anim: 0.17, cooldown: 0.15, reach: 1.15, thick: 26,
      rake: 3, hitSfx: 'slash', hitPitch: 1.28, shake: 5, name: 'RAKE',
    },
    {
      from: 1.1, to: -0.95, wind: 0.2, strike: 0.16, anim: 0.16, cooldown: 0.14, reach: 1.15, thick: 26,
      rake: 3, hitSfx: 'slash', hitPitch: 1.36, shake: 5, name: 'BACKHAND',
    },
    {
      from: -1.4, to: 1.15, wind: 0.24, strike: 0.18, anim: 0.21, cooldown: 0.18, reach: 1.25, thick: 32,
      rake: 4, hitSfx: 'slash', hitPitch: 1.18, shake: 7, name: 'RIP',
    },
    {
      from: 1.35, to: -1.3, wind: 0.3, strike: 0.18, anim: 0.34, cooldown: 0.36, reach: 1.4, thick: 44,
      rake: 4, heavy: true, dash: 140, flash: 0.24, shake: 14, hitPitch: 0.95, name: 'SHRED',
    },
  ],
  run: [
    {
      from: -1.05, to: 1.0, wind: 0.22, strike: 0.16, anim: 0.26, cooldown: 0.26, reach: 1.3, thick: 32,
      rake: 4, dash: 330, slide: 0.2, ghost: 0.3, stance: 'lunge', stanceHip: -8, stanceLean: 0.12,
      hitSfx: 'slash', hitPitch: 1.1, shake: 9, name: 'POUNCE',
    },
    {
      from: 1.25, to: -1.05, wind: 0.18, strike: 0.16, anim: 0.2, cooldown: 0.2, reach: 1.25, thick: 28,
      rake: 3, dash: 190, slide: 0.12, hitSfx: 'slash', hitPitch: 1.2, shake: 6, name: 'PASSING RIP',
    },
  ],
  air: [
    {
      from: -2.0, to: 1.25, wind: 0.22, strike: 0.16, anim: 0.28, cooldown: 0.26, reach: 1.3, thick: 34,
      rake: 4, dash: 70, hitSfx: 'slash', hitPitch: 1.05, shake: 9, name: 'FALLING RIP',
    },
    {
      from: 2.3, to: -1.3, wind: 0.2, strike: 0.16, anim: 0.36, cooldown: 0.34, reach: 1.35, thick: 40,
      rake: 4, spin: 1, heavy: true, flash: 0.2, shake: 12, hitPitch: 0.9, name: 'WHIRL',
    },
  ],
  hold: [
    // The flurry: four passes so fast the cooldown is shorter than the swing,
    // then one that opens the whole thing up.
    {
      from: -1.5, to: 1.2, wind: 0.16, strike: 0.14, anim: 0.11, cooldown: 0.085, reach: 1.35, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.42, shake: 5, name: 'FLURRY',
    },
    {
      from: 1.45, to: -1.15, wind: 0.16, strike: 0.14, anim: 0.11, cooldown: 0.085, reach: 1.35, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.5, shake: 5, name: 'FLURRY',
    },
    {
      from: -1.2, to: 1.45, wind: 0.16, strike: 0.14, anim: 0.11, cooldown: 0.085, reach: 1.35, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.46, shake: 5, name: 'FLURRY',
    },
    {
      from: 1.2, to: -1.45, wind: 0.16, strike: 0.14, anim: 0.11, cooldown: 0.085, reach: 1.35, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.54, shake: 5, name: 'FLURRY',
    },
    {
      from: -2.4, to: 1.6, wind: 0.3, strike: 0.18, anim: 0.42, cooldown: 0.44, reach: 1.5, thick: 56,
      rake: 4, heavy: true, spin: 1, hop: 180, flash: 0.32, invert: 0.04, shake: 19, quake: 0.6,
      hitPitch: 0.82, name: 'EVISCERATE',
    },
  ],
};

export class Claws extends MeleeWeapon {
  readonly id = 4;
  readonly name = 'CLAWS';
  readonly tagline = 'three marks a pass, and a lot of passes';
  protected readonly len = 52;
  protected readonly sets = CLAW_SETS;

  /** The white crescents a pass leaves hanging - one per claw, not one per swing. */
  private marks = new SlashFx();
  private marked = false;

  constructor() {
    super();
    this.animLen = 0.17;
    this.cooldown = 0.15;
    this.gripFwd = 34;
    this.gripLead = 0.18;
  }

  override onEquip(): void { super.onEquip(); this.marks.clear(); this.marked = false; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.marks.clear(); }

  protected restAngle(ctx: WeaponCtx): number { return ctx.sm.pose.aim; }

  protected restHands(ctx: WeaponCtx): HandTargets {
    // Loose, low and open - hands that are about to be somewhere else.
    const lead = this.swap > 0;
    return {
      main: grip(ctx, lead ? 34 : 28, lead ? -6 : 13),
      off: grip(ctx, lead ? 28 : 34, lead ? 15 : -6),
    };
  }

  /**
   * The trails are spawned when the strike actually begins rather than when
   * the swing is called for, so the marks appear with the contact instead of
   * hanging in the air through the wind-up.
   */
  protected override tick(ctx: WeaponCtx, held: boolean): void {
    super.tick(ctx, held);
    this.marks.update(ctx.dt);
    if (this.anim <= 0) { this.marked = false; return; }
    if (this.marked || this.t <= this.move.wind) return;
    this.marked = true;
    this.addMarks(ctx);
  }

  private addMarks(ctx: WeaponCtx): void {
    const mv = this.move;
    const h = ctx.sm.pose.handR;
    const f = ctx.sm.facing;
    const a = ctx.sm.pose.aim;
    const from = a + mv.from * f;
    const to = a + mv.to * f;
    const n = mv.rake ?? 3;
    const reach = this.len * (mv.reach ?? 1);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      this.marks.add(
        h.x, h.y, reach * (0.5 + t * 0.55), from, to,
        4 + (mv.thick ?? 26) * 0.13, 0.22, 10,
      );
    }
  }

  protected drawWeapon(sk: Sketch, ctx: WeaponCtx, ba: number): void {
    const f = ctx.sm.facing;
    const mv = this.move;
    const swinging = this.anim > 0;
    // The off hand trails the leading one through the same arc.
    const offAngle = swinging ? ba + (mv.to - mv.from) * f * 0.3 : ctx.sm.pose.aim + 0.24 * f;
    this.claw(sk, ctx.sm.pose.handR, swinging ? ba : ctx.sm.pose.aim, 1);
    this.claw(sk, ctx.sm.pose.handL, offAngle, 0.86);
    this.marks.draw(sk);
  }

  /** Three blades off one fist: short, curved and getting shorter outwards. */
  private claw(sk: Sketch, h: Vec2, ang: number, scale: number): void {
    const L = this.len * scale;
    for (let i = -1; i <= 1; i++) {
      const a = ang + i * 0.2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
      const l = L * (i === 0 ? 1 : 0.84);
      sk.poly([at(6, -2.6), at(l * 0.7, -2.2), at(l, 0), at(l * 0.66, 2.4), at(6, 2.6)], 2.2, false, 0.4);
    }
    // The knuckle bar the blades are socketed into.
    const ca = Math.cos(ang), sa = Math.sin(ang);
    sk.line({ x: h.x - sa * 8, y: h.y + ca * 8 }, { x: h.x + sa * 8, y: h.y - ca * 8 }, 3.2, 1, 0.4);
    sk.line({ x: h.x - ca * 5, y: h.y - sa * 5 }, { x: h.x + ca * 6, y: h.y + sa * 6 }, 2.6, 1, 0.4);
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    // Three rips, which is the mark rather than the weapon - it is the thing
    // you actually recognise on the wall afterwards.
    for (let i = -1; i <= 1; i++) {
      const o = i * s * 0.22;
      sk.curve(
        { x: x - s * 0.4 + o * 0.3, y: y - s * 0.34 + o },
        { x: x + o * 0.6, y: y + o * 0.7 },
        { x: x + s * 0.42 + o * 0.3, y: y + s * 0.3 + o },
        i === 0 ? 3.2 : 2.4, 0.6,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 9. MISSILE PODS
// ---------------------------------------------------------------------------
/** Seconds of held trigger before the pods stop firing singles and load a salvo. */
const SALVO_HOLD = 0.5;
/** How many go up when the whole thing lets go at once. */
const SALVO_SIZE = 10;

export class MissilePods extends Weapon {
  readonly id = 9;
  readonly name = 'MISSILE PODS';
  readonly tagline = 'three at a time, or everything at once';
  override auto = true;
  override cooldown = 0.8;
  /** 0..1 recent launch, for the tube flash. */
  private launch = 0;
  /** 0..1 how far the salvo has finished loading. */
  private load = 0;
  private loadSfx = 0;

  override onEquip(): void { super.onEquip(); this.load = 0; this.launch = 0; }

  /** Where a tube mouth sits: behind the shoulder, `slot` down the pod. */
  /** How far open the rack is standing right now. */
  private get open(): number { return 0.85 + this.load * 0.45 + this.launch * 0.15; }

  /**
   * Which way a plate sweeps. Both of them go up and back - one steep, one
   * shallow - rather than one up and one down: a plate swept downwards ends up
   * buried in his own legs, and the pair stop reading as a pair.
   */
  private axis(ctx: WeaponCtx, side: number): number {
    const f = ctx.sm.facing;
    const back = f > 0 ? Math.PI : 0;
    return back + f * (side < 0 ? 1.25 : 0.42) * (0.78 + 0.3 * this.open);
  }

  private root(ctx: WeaponCtx, side: number): Vec2 {
    const c = ctx.sm.pose.chest;
    return { x: c.x, y: c.y - 8 + side * 4 };
  }

  /** A tube mouth: `slot` of three, out along the plate's outer edge. */
  private pod(ctx: WeaponCtx, side: number, slot: number): Vec2 {
    const a = this.axis(ctx, side);
    const r = this.root(ctx, side);
    const L = 84 * this.open;
    const d = L * (0.28 + slot * 0.24);
    const o = -18 * side;
    return { x: r.x + Math.cos(a) * d - Math.sin(a) * o, y: r.y + Math.sin(a) * d + Math.cos(a) * o };
  }

  private fire(ctx: WeaponCtx, from: Vec2, dir: number, target: Vec2, arm: number): void {
    const speed = 340 + rand(0, 120);
    ctx.projectiles.push(new Projectile({
      x: from.x, y: from.y,
      vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
      kind: 'missile', gravity: 0, radius: 5, life: 4.5, blast: BLASTS.missile,
      target, turn: 3.4, accel: 1500, topSpeed: 1450, arm, weave: 0.2,
    }));
    ctx.particles.smoke(from.x, from.y, 2, 4);
    ctx.particles.sparks(from.x, from.y, 3, 180, dir + Math.PI, 1.2);
  }

  /** The ordinary attack: three rounds, all bending towards the crosshair. */
  protected release(ctx: WeaponCtx): void {
    const f = ctx.sm.facing;
    this.launch = 1;
    this.cooldown = 0.8;
    this.timer = this.cooldown;
    this.startAnim(0.4);
    ctx.sfx('launch', rand(1.15, 1.3));
    ctx.shake(4);
    ctx.sm.applyRecoil(0.3, ctx.sm.pose.aim, 24);
    for (let i = 0; i < 3; i++) {
      const from = this.pod(ctx, i === 1 ? 0 : (i === 0 ? -1 : 1), 0);
      // Up and back out of the tubes, then round onto the target. Everything
      // launches with some climb in it: a guided round that leaves level with
      // the floor spends its turn radius on the ground it was standing on.
      const dir = -Math.PI / 2 + (i - 1) * 0.42 - f * 0.3;
      const target = {
        x: ctx.aimPoint.x + rand(-70, 70),
        y: ctx.aimPoint.y + rand(-60, 60),
      };
      this.fire(ctx, from, dir, target, 0.12 + i * 0.03);
    }
  }

  /** Everything the pods have, at everything still standing. */
  private salvo(ctx: WeaponCtx): void {
    const f = ctx.sm.facing;
    this.launch = 1;
    this.cooldown = 1.9;
    this.timer = this.cooldown;
    this.startAnim(0.7);
    ctx.sfx('launch', 0.8);
    ctx.shake(11);
    ctx.flash(0.16);
    ctx.sm.applyRecoil(0.6, ctx.sm.pose.aim, 40);
    for (let i = 0; i < SALVO_SIZE; i++) {
      // Rippled rather than simultaneous: ten rounds leaving on the same frame
      // is one bang, and ten leaving over a third of a second is a salvo.
      ctx.after(i * 0.045, () => {
        const side = i % 2 === 0 ? -1 : 1;
        const from = this.pod(ctx, side, i % 3);
        // Straight up out of his back and fanned, so the salvo climbs above
        // him first and comes down on the wall from ten different angles.
        const dir = -Math.PI / 2 + side * rand(0.15, 0.85) - f * 0.2;
        this.fire(ctx, from, dir, wallPoint(ctx), 0.16 + (i % 4) * 0.05);
        ctx.sfx('launch', rand(1.1, 1.35));
      });
    }
  }

  protected override suppressFire(): boolean {
    return this.heldFor > SALVO_HOLD;
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor > SALVO_HOLD && this.load > 0.25) this.salvo(ctx);
    this.load = 0;
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.launch = Math.max(0, this.launch - ctx.dt * 4);
    const loading = held && this.heldFor > SALVO_HOLD;
    this.load = loading ? Math.min(1, this.load + ctx.dt / 0.85) : damp(this.load, 0, 12, ctx.dt);
    if (!loading) return;
    this.loadSfx -= ctx.dt;
    if (this.loadSfx <= 0) { ctx.sfx('aura', 1.1 + this.load * 0.5); this.loadSfx = 0.3; }
    if (Math.random() < this.load * 0.4) {
      const p = this.pod(ctx, Math.random() < 0.5 ? -1 : 1, Math.floor(rand(0, 3)));
      ctx.particles.sparks(p.x, p.y, 1, 110, ctx.sm.pose.aim + Math.PI, 1.6);
    }
  }

  /** One arm out marking the target; the pods do the rest of the work. */
  hands(ctx: WeaponCtx): HandTargets {
    const k = this.load;
    return { main: grip(ctx, 40 - k * 6, -4 - k * 4), off: null };
  }

  /**
   * The pods themselves: two swept plates standing off his back, half wing and
   * half rack, with the tube mouths facing out along them. They sit behind the
   * figure so the man stays the thing you read first.
   */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const open = this.open;
    c.save();
    c.strokeStyle = '#000';
    for (const side of [-1, 1]) {
      const base = this.root(ctx, side);
      const a = this.axis(ctx, side);
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (d: number, o: number): Vec2 => ({ x: base.x + ca * d - sa * o, y: base.y + sa * d + ca * o });
      const L = 84 * open;
      // The plate, knocked out in white so it reads over the wall as well as
      // over the paper.
      const plate = [at(0, -15 * side), at(L * 0.5, -22 * side), at(L, -10 * side), at(L * 0.86, 10 * side), at(4, 13 * side)];
      c.fillStyle = '#fff';
      sk.polyPath(plate, 1.2);
      c.fill();
      sk.poly(plate, 2.8, false, 1.2);
      // Three tube mouths down the outer edge.
      for (let i = 0; i < 3; i++) {
        const d = L * (0.28 + i * 0.24);
        sk.line(at(d, -18 * side), at(d, -8 * side), 3.2, 1, 0.4);
      }
      // The spar it is all bolted to, so it reads as a rack and not a fin.
      sk.line(at(2, 0), at(L * 0.9, -6 * side), 2.2, 2, 0.5);
      if (this.launch > 0.02) {
        c.lineWidth = 2.4;
        const mouth = at(L * 0.6, -16 * side);
        sk.burst(mouth.x, mouth.y, 5, 5, 34 * this.launch, 2.4, 1.4, a, 5100 + side);
      }
    }
    c.restore();
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    if (this.load < 0.03) return;
    // Loading tell: rings closing on the pods, so the wind-up is visible from
    // the far side of the screen before ten rounds arrive.
    const c = sk.ctx;
    const k = this.load;
    c.save();
    c.strokeStyle = '#000';
    c.lineWidth = 1.8 + k * 1.6;
    for (const side of [-1, 1]) {
      const p = this.pod(ctx, side, 1);
      for (let i = 0; i < 2; i++) {
        const phase = (ctx.time * 2.4 + i / 2) % 1;
        sk.polyPath(ring(p.x, p.y, (1 - phase) * 34 * k + 5, 10, ctx.time * 2), 1.4);
        c.stroke();
      }
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    // A rack of three tubes with one round already on its way out.
    sk.poly([
      { x: x - s * 0.42, y: y - s * 0.28 }, { x: x + s * 0.04, y: y - s * 0.34 },
      { x: x + s * 0.06, y: y + s * 0.22 }, { x: x - s * 0.42, y: y + s * 0.3 },
    ], 2.2, false, 0.5);
    for (let i = -1; i <= 1; i++) {
      sk.line({ x: x + s * 0.05, y: y + i * s * 0.17 }, { x: x + s * 0.16, y: y + i * s * 0.17 }, 2.2, 1, 0.3);
    }
    sk.poly([
      { x: x + s * 0.2, y: y - s * 0.24 }, { x: x + s * 0.48, y: y - s * 0.14 },
      { x: x + s * 0.2, y: y - s * 0.04 },
    ], 2, false, 0.4);
    sk.line({ x: x + s * 0.1, y: y - s * 0.14 }, { x: x + s * 0.2, y: y - s * 0.14 }, 1.8, 1, 0.3);
  }
}

// ---------------------------------------------------------------------------
// 10. ARCANE STAFF
// ---------------------------------------------------------------------------
const STAFF_RANGE = 1500;
/**
 * World units of masonry the staff beam eats a second. The pwnage beam does
 * 340 and bores most of the way through a wall in one discharge; this one is
 * deliberately a fraction of that. It is twice as wide and it barely scratches
 * - which is the joke, and the reason both of them get to exist.
 */
const STAFF_BORE = 74;

export class ArcaneStaff extends Weapon {
  readonly id = 10;
  readonly name = 'ARCANE STAFF';
  readonly tagline = 'four bolts, or one very wide beam';
  override cooldown = 0.5;
  override chargeTime = 0.9;
  /** Under this much charge a release is the four-bolt volley, not the beam. */
  private readonly tapMax = 0.34;
  private beam = 0;
  private beamMax = 0.8;
  private beamAngle = 0;
  private reach = STAFF_RANGE;
  private power = 1;
  private cast = 0;
  private sfxTimer = 0;

  override onEquip(): void { super.onEquip(); this.beam = 0; this.cast = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.beam = 0; }

  /** The head of the staff, where everything comes out of. */
  private head(ctx: WeaponCtx): Vec2 { return grip(ctx, 74); }

  protected release(ctx: WeaponCtx, power: number): void {
    if (power < this.tapMax) { this.bolts(ctx); return; }
    this.cooldown = 1.5;
    this.power = 0.5 + power * 0.5;
    this.beam = this.beamMax;
    this.beamAngle = ctx.sm.pose.aim;
    this.reach = STAFF_RANGE;
    this.cast = 1;
    ctx.sfx('beam', 0.42);
    ctx.flash(0.24);
    ctx.shake(4);
    ctx.sm.applyRecoil(0.6, this.beamAngle, 40);
    ctx.particles.shockwave(this.head(ctx).x, this.head(ctx).y, 90);
  }

  /**
   * The ordinary cast: four bolts thrown out in a fan, so they arrive spread
   * across the face instead of stacking into one hole.
   */
  private bolts(ctx: WeaponCtx): void {
    const from = this.head(ctx);
    const base = this.aimFrom(ctx, from);
    this.cooldown = 0.42;
    this.cast = 1;
    this.startAnim(0.28);
    ctx.sfx('fire', 0.7);
    ctx.shake(3);
    ctx.sm.applyRecoil(0.35, base, 16);
    for (let i = 0; i < 4; i++) {
      const a = base + (i - 1.5) * 0.135 + rand(-0.025, 0.025);
      const speed = 820 + rand(-60, 60);
      ctx.projectiles.push(new Projectile({
        x: from.x + Math.cos(a) * 10, y: from.y + Math.sin(a) * 10,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        kind: 'orb', gravity: 0, radius: 7, life: 3, blast: BLASTS.orb,
      }));
    }
    ctx.particles.streaks(from.x, from.y, 5, base, 0.6, 50);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.cast = Math.max(0, this.cast - ctx.dt * 3.4);
    if (this.beam <= 0) return;
    this.beam = Math.max(0, this.beam - ctx.dt);
    const k = this.beam / this.beamMax;

    // It swings round with the aim, lazily.
    let d = ctx.sm.pose.aim - this.beamAngle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.beamAngle += d * Math.min(1, ctx.dt * 5);

    const origin = this.head(ctx);
    const a = this.beamAngle;
    const ca = Math.cos(a), sa = Math.sin(a);
    const radius = this.width(k);
    const front = ctx.terrain.strikePoint(origin.x, origin.y, ca, sa, STAFF_RANGE, 6);
    const bore = STAFF_BORE * ctx.dt * this.power;
    this.reach = front
      ? Math.min(STAFF_RANGE, Math.hypot(front.x - origin.x, front.y - origin.y) + bore + radius)
      : STAFF_RANGE;
    ctx.terrain.carveCapsule(
      origin.x, origin.y, origin.x + ca * this.reach, origin.y + sa * this.reach,
      radius, 0.2, bore,
    );
    ctx.sm.applyRecoil(0.25, a, 70 * ctx.dt * this.power);
    ctx.shake(1.6 * k);
    this.sfxTimer -= ctx.dt;
    if (this.sfxTimer <= 0) { ctx.sfx('beam', rand(0.5, 0.68)); this.sfxTimer = 0.09; }
    if (front) {
      // It is wide and it is warm and it is not getting in: what comes back
      // off the face is dust, not the wall.
      ctx.particles.smoke(front.x, front.y, 1, radius * 0.6);
      if (Math.random() < 0.5) ctx.particles.sparks(front.x, front.y, 2, 200, a + Math.PI, 2.4);
    }
  }

  private width(k: number): number { return (58 * this.power) * (0.55 + k * 0.45); }

  /** Both hands on the shaft, and the whole thing levelled at the target. */
  hands(ctx: WeaponCtx): HandTargets {
    const k = Math.max(this.charge, this.beam > 0 ? 1 : 0);
    return { main: grip(ctx, 36 + k * 4, -2), off: grip(ctx, 20, 13) };
  }

  override stance(ctx: WeaponCtx): Stance | null {
    const k = Math.max(this.charge, this.beam > 0 ? 1 : 0);
    if (k < 0.2) return null;
    const w = clamp((k - 0.2) / 0.8, 0, 1);
    return ctx.sm.onGround
      ? { kind: 'brace', weight: w * 0.7, lean: -0.16, hip: -8 }
      : { kind: 'hover', weight: w * 0.6, lean: -0.08, hip: 2 };
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const h = ctx.sm.pose.handR;
    const a = ctx.sm.pose.aim;
    const ca = Math.cos(a), sa = Math.sin(a);
    const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });

    // --- the staff ----------------------------------------------------------
    c.strokeStyle = '#000';
    sk.line(at(-34, 0), at(58, 0), 4.2, 3, 0.7);
    sk.line(at(-34, -4), at(-34, 4), 3.4, 1, 0.4);
    // The head: two horns curling forward round the space the orb sits in.
    for (const side of [-1, 1]) {
      sk.curve(at(58, side * 3), at(72, side * 15), at(86, side * 5), 3, 0.6);
    }
    sk.line(at(52, -5), at(52, 5), 3, 1, 0.4);

    const head = at(74, 0);

    // --- charging: the two rings and the ball between the horns -------------
    if (this.charge > 0.01) {
      const k = this.charge;
      // The rings, which is what the drawing in the reference actually is: two
      // hoops standing round the point the shot is going to come out of.
      c.lineWidth = 2.4 + k * 2;
      c.strokeStyle = '#000';
      for (let i = 0; i < 2; i++) {
        const spin = ctx.time * (1.6 + i * 0.9) * (i === 0 ? 1 : -1);
        const r = (16 + i * 11) * (0.5 + k);
        const squash = 0.35 + Math.abs(Math.sin(ctx.time * 1.3 + i)) * 0.6;
        const pts = ring(head.x, head.y, r, 14, spin)
          .map((p) => ({ x: head.x + (p.x - head.x), y: head.y + (p.y - head.y) * squash }));
        sk.polyPath(pts, 1.4);
        c.stroke();
      }
      // Energy racing in from outside the figure to the head.
      c.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * TAU + ctx.time * 0.9;
        const phase = (ctx.time * 1.7 + i * 0.15) % 1;
        const r0 = 48 + (1 - phase) * 120 * k;
        c.beginPath();
        c.moveTo(head.x + Math.cos(ang) * r0, head.y + Math.sin(ang) * r0);
        c.lineTo(head.x + Math.cos(ang) * (r0 + 26 + k * 40), head.y + Math.sin(ang) * (r0 + 26 + k * 40));
        c.stroke();
      }
      // And the ball itself, swelling into the gap between the horns.
      const core = 6 + k * 16;
      c.fillStyle = '#000';
      sk.polyPath(ring(head.x, head.y, core, 11, ctx.time * 2), 1.5);
      c.fill();
      c.fillStyle = '#fff';
      sk.polyPath(ring(head.x, head.y, core * 0.44, 9, -ctx.time * 3), 1.1);
      c.fill();
      c.fillStyle = '#000';
      c.lineWidth = 2.4;
      sk.burst(head.x, head.y, 8, core * 1.5, core * 3, 2.4, TAU, 0, 6001);
    } else if (this.cast > 0.02) {
      c.lineWidth = 2.4;
      c.strokeStyle = '#000';
      sk.burst(head.x, head.y, 7, 6, 30 * this.cast, 2.4, TAU, 0, 6002);
    }

    // --- firing: a fat, slow column ----------------------------------------
    if (this.beam > 0) {
      const k = this.beam / this.beamMax;
      const r = this.width(k);
      const ang = this.beamAngle;
      const origin = this.head(ctx);
      const end = {
        x: origin.x + Math.cos(ang) * Math.max(60, this.reach),
        y: origin.y + Math.sin(ang) * Math.max(60, this.reach),
      };
      c.save();
      lightBand(sk, origin, end, r * 0.5, r, 3.4);
      // A couple of lazy pulses travelling up it - slow, because nothing about
      // this beam is in a hurry.
      c.strokeStyle = '#000';
      c.lineWidth = 2.2;
      const len = Math.max(60, this.reach);
      const ca2 = Math.cos(ang), sa2 = Math.sin(ang);
      for (let i = 0; i < 4; i++) {
        // Chevrons rather than bars: a rung across the column reads as a
        // ladder, and a chevron pointing down it reads as something moving.
        const d = ((ctx.time * 900 + i * 260) % len);
        const p = (dd: number, o: number): Vec2 =>
          ({ x: origin.x + ca2 * dd - sa2 * o, y: origin.y + sa2 * dd + ca2 * o });
        sk.line(p(d, -r * 0.62), p(d + r * 0.5, 0), 2.2, 1, 1.2);
        sk.line(p(d + r * 0.5, 0), p(d, r * 0.62), 2.2, 1, 1.2);
      }
      c.lineWidth = 3;
      sk.burst(origin.x, origin.y, 9, r * 0.8, r * 2.2, 3, TAU, 0, 6003);
      if (this.reach < STAFF_RANGE - 1) {
        c.fillStyle = '#fff';
        sk.polyPath(ring(end.x, end.y, r * 0.95, 11, ctx.time * 2), 2.4);
        c.fill();
        c.strokeStyle = '#000';
        c.lineWidth = 3;
        sk.burst(end.x, end.y, 9, r * 0.7, r * 1.7, 3, 2.4, ang + Math.PI, 6004);
      }
      c.restore();
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    sk.line({ x: x - s * 0.3, y: y + s * 0.44 }, { x: x + s * 0.08, y: y - s * 0.22 }, 2.8, 2, 0.5);
    for (const side of [-1, 1]) {
      sk.curve(
        { x: x + s * 0.04, y: y - s * 0.16 },
        { x: x + s * 0.06 + side * s * 0.22, y: y - s * 0.34 },
        { x: x + s * 0.16, y: y - s * 0.44 }, 2.2, 0.4,
      );
    }
    c.fillStyle = '#000';
    sk.polyPath(ring(x + s * 0.1, y - s * 0.28, s * 0.12, 9, 0), 0.7);
    c.fill();
    c.lineWidth = 2;
    sk.burst(x + s * 0.1, y - s * 0.28, 6, s * 0.2, s * 0.34, 2, TAU, 0, 6005);
  }
}

// ---------------------------------------------------------------------------
// 11. MECHA
// ---------------------------------------------------------------------------
/** Seconds of held trigger before the rod array unfolds out of his back. */
const ROD_HOLD = 0.5;
/** How long the converging lasers stay on target once they go. */
const LASER_TIME = 0.45;
/** The blade that slides out of the forearm on the ground. */
const MECHA_BLADE = 76;
/** Where the four rods point, relative to the aim - two forward, two back. */
const ROD_ANGLES = [-2.35, -0.95, 0.95, 2.35];

/**
 * The winged machine. Equipping it is less a weapon swap than a mode: the
 * wings come out and the sky is his, jump climbs and crouch dives, and what
 * the trigger does depends entirely on whether his feet are on the floor.
 */
export class Mecha extends Weapon {
  readonly id = 11;
  readonly name = 'MECHA';
  readonly tagline = 'wings out — blade below, guns above';
  override auto = true;
  override cooldown = 0.1;

  /** 0..1 how far the rod array has unfolded, and how charged it is. */
  private rods = 0;
  private rodCharge = 0;
  private laserT = 0;
  private laserAt: Vec2 = { x: 0, y: 0 };
  private laserPower = 1;
  /** Set while the running animation is a ground swing rather than a shot. */
  private slashing = false;
  private struck = false;
  private flashT = 0;
  private auraSfx = 0;

  override onEquip(): void {
    super.onEquip();
    this.rods = 0;
    this.rodCharge = 0;
    this.laserT = 0;
    this.slashing = false;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.rods = 0;
    this.rodCharge = 0;
    this.laserT = 0;
  }

  /** The wings hold him up the moment his feet leave the ground. */
  override stance(ctx: WeaponCtx): Stance | null {
    if (ctx.sm.onGround) return null;
    return { kind: 'fly', weight: 1, lean: 0.16, hip: -4 };
  }

  // ------------------------------------------------------------- attacking ---

  protected release(ctx: WeaponCtx): void {
    if (ctx.sm.onGround) this.swing(ctx); else this.shoot(ctx);
  }

  /** On the floor: the blade slides out of the arm and he cuts with it. */
  private swing(ctx: WeaponCtx): void {
    this.slashing = true;
    this.struck = false;
    this.cooldown = 0.34;
    this.timer = this.cooldown;
    this.startAnim(0.34);
    ctx.sfx('swing', rand(1.05, 1.2));
  }

  /** In the air: small, fast, cheap rounds, one every few frames. */
  private shoot(ctx: WeaponCtx): void {
    this.slashing = false;
    this.cooldown = 0.085;
    this.timer = this.cooldown;
    this.startAnim(0.14);
    const muzzle = grip(ctx, 46);
    const a = this.aimFrom(ctx, muzzle) + rand(-0.035, 0.035);
    this.flashT = 0.05;
    ctx.sfx('rifle', rand(1.28, 1.45));
    ctx.sm.applyRecoil(0.22, a, 6);
    ctx.shake(1.4);
    this.hitscan(ctx, muzzle, a, 1300, 5.4);
  }

  /** The direction the forearm blade is pointing this frame. */
  private bladeAngle(ctx: WeaponCtx): number {
    const f = ctx.sm.facing;
    const a = ctx.sm.pose.aim;
    const d = this.swap;
    const from = a - 1.5 * f * d;
    const to = a + 1.05 * f * d;
    const t = this.t;
    if (t < 0.3) return lerp(a, from, easeOutCubic(t / 0.3));
    if (t < 0.56) return lerp(from, to, easeOutQuint((t - 0.3) / 0.26));
    return lerp(to, a, easeOutCubic((t - 0.56) / 0.44) * 0.85);
  }

  /** 0..1 how far the blade has slid out of the arm. */
  private get extend(): number {
    if (!this.slashing || this.anim <= 0) return 0;
    const t = this.t;
    return t < 0.22 ? t / 0.22 : t > 0.78 ? (1 - t) / 0.22 : 1;
  }

  private cut(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const h = sm.pose.handR;
    const f = sm.facing;
    const a = sm.pose.aim;
    const d = this.swap;
    const from = a - 1.5 * f * d;
    const to = a + 1.05 * f * d;
    const cut = ctx.terrain.carveSector(h.x, h.y, 0, MECHA_BLADE, from, to, 9);
    const at = { x: h.x + Math.cos(a) * MECHA_BLADE * 0.8, y: h.y + Math.sin(a) * MECHA_BLADE * 0.8 };
    for (const p of cut.edges.slice(0, 4)) ctx.particles.debris(p.x, p.y, 1, 200, a + Math.PI, 2.2);
    ctx.sfx('slash', rand(0.95, 1.15) * (cut.removed > 0 ? 1 : 1.25));
    ctx.hit(at.x, at.y, a, 1);
    ctx.shake(cut.removed > 0 ? 9 : 4);
    ctx.freeze(1);
    if (cut.removed > 0) sm.applyRecoil(0.35, a, 26);
  }

  // ------------------------------------------------------- the rod array ---

  protected override suppressFire(): boolean {
    return this.heldFor > ROD_HOLD;
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor <= ROD_HOLD || this.rods < 0.35) { this.rodCharge = 0; return; }
    this.laserPower = 0.35 + this.rodCharge * 0.65;
    // Wherever the crosshair is - or, if the wall is between him and it, the
    // face of the wall, because that is what the beams will actually reach.
    const c = ctx.sm.center;
    const dx = ctx.aimPoint.x - c.x, dy = ctx.aimPoint.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const hit = ctx.terrain.strikePoint(c.x, c.y, dx / len, dy / len, len + 400, 5);
    this.laserAt = hit ?? { x: ctx.aimPoint.x, y: ctx.aimPoint.y };
    this.laserT = LASER_TIME;
    this.rodCharge = 0;
    this.cooldown = 1.1;
    this.timer = this.cooldown;
    ctx.sfx('beam', 0.75);
    ctx.flash(0.3 * this.laserPower);
    ctx.shake(7 * this.laserPower);
    ctx.particles.shockwave(this.laserAt.x, this.laserAt.y, 110 * this.laserPower);
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.flashT = Math.max(0, this.flashT - ctx.dt);
    if (this.anim <= 0) this.slashing = false;
    if (this.slashing && !this.struck && this.t > 0.42) { this.struck = true; this.cut(ctx); }

    // The array: out while the trigger is down past the threshold, folded away
    // the moment it comes back up.
    // The array stays out through its own discharge: folding it away on the
    // frame the trigger comes up leaves four beams starting from nothing.
    const out = (held && this.heldFor > ROD_HOLD) || this.laserT > 0;
    this.rods = damp(this.rods, out ? 1 : 0, out ? 9 : 11, ctx.dt);
    if (out) {
      this.rodCharge = Math.min(1, this.rodCharge + ctx.dt / 0.85);
      ctx.shake(0.6 + this.rodCharge * 1.6);
      this.auraSfx -= ctx.dt;
      if (this.auraSfx <= 0) { ctx.sfx('aura', 0.85 + this.rodCharge * 0.6); this.auraSfx = 0.3; }
      if (Math.random() < this.rodCharge * 0.5) {
        const p = this.rodTip(ctx, Math.floor(rand(0, 4)));
        ctx.particles.sparks(p.x, p.y, 1, 90, rand(0, TAU), TAU);
      }
    }

    if (this.laserT <= 0) return;
    this.laserT = Math.max(0, this.laserT - ctx.dt);
    // The lasers eat forward into whatever they are all pointing at, so the
    // hole opens over the half second they are on rather than in one frame.
    const at = this.laserAt;
    const r = 22 + 26 * this.laserPower;
    ctx.terrain.carveBlob(at.x, at.y, r, 0.32, 20, 340 * ctx.dt * this.laserPower);
    ctx.shake(3 * this.laserPower);
    ctx.particles.debris(at.x, at.y, 2, 300, ctx.sm.pose.aim + Math.PI, 2.4);
    ctx.particles.sparks(at.x, at.y, 3, 380, ctx.sm.pose.aim + Math.PI, 2.6);
    if (Math.random() < 0.4) ctx.particles.smoke(at.x, at.y, 1, r * 0.6);
    if (this.laserT <= 0) ctx.hit(at.x, at.y, ctx.sm.pose.aim, 1.6);
  }

  /** Where the rods are anchored: the middle of his back. */
  private rodRoot(ctx: WeaponCtx): Vec2 {
    const f = ctx.sm.facing;
    const c = ctx.sm.pose.chest;
    return { x: c.x - f * 7, y: c.y - 2 };
  }

  private rodTip(ctx: WeaponCtx, i: number): Vec2 {
    const root = this.rodRoot(ctx);
    const a = ctx.sm.pose.aim + ROD_ANGLES[i] * ctx.sm.facing;
    const L = 34 + 44 * this.rods;
    return { x: root.x + Math.cos(a) * L, y: root.y + Math.sin(a) * L };
  }

  // ------------------------------------------------------------ the pose ---

  hands(ctx: WeaponCtx): HandTargets | null {
    const f = ctx.sm.facing;
    if (this.rods > 0.25) {
      // Arms flung wide while the array is out: he is the mount, not the gun.
      const a = ctx.sm.pose.aim;
      const k = this.rods;
      return {
        main: gripAt(ctx, a - 1.15 * f * k, 32, -4 * f),
        off: gripAt(ctx, a + 1.15 * f * k, 30, 4 * f),
      };
    }
    if (this.slashing && this.anim > 0) {
      const ba = this.bladeAngle(ctx);
      return { main: gripAt(ctx, ba, 36, -3 * f), off: grip(ctx, 26, 16) };
    }
    if (!ctx.sm.onGround) return { main: grip(ctx, 40, -5), off: null };
    // Standing about with the wings folded: he just stands about.
    return null;
  }

  // ----------------------------------------------------------- the wings ---

  /**
   * Five plated feathers a side, knocked out in white with a hard ink edge so
   * they read over the black wall as well as over the paper. They fan open and
   * beat faster the harder he is flying.
   */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const f = sm.facing;
    const sp = sm.flightBlend;
    const root = { x: sm.pose.chest.x - f * 5, y: sm.pose.chest.y - 7 };
    const back = f > 0 ? Math.PI : 0;
    const flap = Math.sin(ctx.time * (5 + sp * 8)) * (0.04 + sp * 0.1);

    c.save();
    c.strokeStyle = '#000';
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = back + (f > 0 ? 1 : -1) * ((-0.95 + t * 1.55) * (0.7 + sp * 0.5) + flap * (1 - t * 0.6));
      const L = (44 + Math.sin(t * Math.PI) * 30) * (0.82 + sp * 0.42);
      const w = 8 - t * 3;
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (d: number, o: number): Vec2 => ({ x: root.x + ca * d - sa * o, y: root.y + sa * d + ca * o });
      const feather = [at(0, -w * 0.6), at(L * 0.68, -w), at(L, -w * 0.2), at(L * 0.74, w * 0.6), at(0, w * 0.6)];
      c.fillStyle = '#fff';
      sk.polyPath(feather, 1);
      c.fill();
      sk.poly(feather, 2.6, false, 1);
      // The plate line down the middle: what makes it machinery and not a bird.
      sk.line(at(6, 0), at(L * 0.8, 0), 1.6, 2, 0.5);
    }
    // Thrust off the root of the wings whenever they are actually carrying him.
    if (sp > 0.12) {
      c.lineWidth = 2.4;
      sk.burst(root.x, root.y + 6, 6, 10, 20 + sp * 38, 2.4, 1.5, back, 7001);
    }
    c.restore();
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;

    // --- the forearm blade --------------------------------------------------
    const ext = this.extend;
    if (ext > 0.01) {
      const h = sm.pose.handR;
      const ba = this.bladeAngle(ctx);
      const ca = Math.cos(ba), sa = Math.sin(ba);
      const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
      const L = MECHA_BLADE * ext;
      c.strokeStyle = '#000';
      c.fillStyle = '#fff';
      const blade = [at(-14, -4), at(L * 0.8, -5), at(L, 0), at(L * 0.78, 4), at(-14, 4)];
      sk.polyPath(blade, 0.8);
      c.fill();
      sk.poly(blade, 2.8, false, 0.8);
      sk.line(at(-10, 0), at(L * 0.86, 0), 1.5, 2, 0.4);
      // The housing it slides out of, clamped over the forearm.
      sk.line(at(-18, -7), at(-18, 7), 3.4, 1, 0.5);
      sk.line(at(-26, -5), at(-26, 5), 3, 1, 0.5);
    }

    // --- muzzle flash off the flying shots ----------------------------------
    if (this.flashT > 0) {
      const m = grip(ctx, 46);
      c.strokeStyle = '#000';
      this.muzzle(sk, m.x, m.y, 16, 7101);
    }

    // --- the rod array ------------------------------------------------------
    if (this.rods > 0.02) {
      const root = this.rodRoot(ctx);
      c.save();
      c.strokeStyle = '#000';
      for (let i = 0; i < 4; i++) {
        const a = sm.pose.aim + ROD_ANGLES[i] * sm.facing;
        const tip = this.rodTip(ctx, i);
        const ca = Math.cos(a), sa = Math.sin(a);
        // The rod: a thin white spar with an ink edge, so it never disappears
        // into the wall behind it.
        const rod = [
          { x: root.x - sa * 4, y: root.y + ca * 4 },
          { x: tip.x - sa * 2, y: tip.y + ca * 2 },
          { x: tip.x + sa * 2, y: tip.y - ca * 2 },
          { x: root.x + sa * 4, y: root.y - ca * 4 },
        ];
        c.fillStyle = '#fff';
        sk.polyPath(rod, 0.8);
        c.fill();
        sk.poly(rod, 2.4, false, 0.8);
        // The ball on the end, which is where the light is being kept.
        const r = (4 + this.rodCharge * 8) * this.rods;
        c.fillStyle = '#000';
        sk.polyPath(ring(tip.x, tip.y, r, 10, ctx.time * 2 + i), 1.2);
        c.fill();
        c.fillStyle = '#fff';
        sk.polyPath(ring(tip.x, tip.y, r * 0.42, 8, -ctx.time * 3), 0.9);
        c.fill();
        c.lineWidth = 2.2;
        sk.burst(tip.x, tip.y, 6, r * 1.5, r * (2.4 + this.rodCharge * 1.6), 2.2, TAU, 0, 7200 + i);
      }
      c.restore();
    }

    // --- and the four beams converging on one point -------------------------
    if (this.laserT > 0) {
      const k = this.laserT / LASER_TIME;
      const at = this.laserAt;
      c.save();
      for (let i = 0; i < 4; i++) {
        const tip = this.rodTip(ctx, i);
        lightBand(sk, tip, at, 3 + this.laserPower * 4, 6 + this.laserPower * 9 * k, 2);
      }
      // Where all four land: one white splash and a fan of ink thrown back.
      c.fillStyle = '#fff';
      const r = (26 + this.laserPower * 26) * (0.6 + k * 0.6);
      sk.polyPath(ring(at.x, at.y, r, 12, ctx.time * 3), 3);
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = 3.4;
      sk.burst(at.x, at.y, 12, r * 0.9, r * 2.4, 3.4, TAU, 0, 7300);
      c.restore();
    }
  }

  /**
   * The emblem is the machine's face, not a gun: the horned visored head the
   * reference cuts to when the wings come out. It has to be recognisable at
   * about twenty pixels, so it is a silhouette, a solid visor slit and a crest,
   * and nothing else.
   */
  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // Angular skull with a pointed chin - a helmet, never a bucket.
    sk.poly([
      { x: x - s * 0.26, y: y - s * 0.14 },
      { x: x - s * 0.16, y: y - s * 0.36 },
      { x: x + s * 0.16, y: y - s * 0.36 },
      { x: x + s * 0.26, y: y - s * 0.14 },
      { x: x + s * 0.17, y: y + s * 0.18 },
      { x: x, y: y + s * 0.4 },
      { x: x - s * 0.17, y: y + s * 0.18 },
    ], 2.4, false, 0.45);
    // The visor: one solid shape, dipping to a point in the middle, which is
    // the whole difference between a face and a container.
    c.fillStyle = '#000';
    sk.polyPath([
      { x: x - s * 0.23, y: y - s * 0.16 }, { x: x - s * 0.05, y: y - s * 0.07 },
      { x: x + s * 0.05, y: y - s * 0.07 }, { x: x + s * 0.23, y: y - s * 0.16 },
      { x: x + s * 0.19, y: y + s * 0.01 }, { x: x, y: y + s * 0.09 },
      { x: x - s * 0.19, y: y + s * 0.01 },
    ], 0.6);
    c.fill();
    // Crest fin.
    sk.poly([
      { x: x - s * 0.05, y: y - s * 0.34 }, { x: x, y: y - s * 0.52 },
      { x: x + s * 0.05, y: y - s * 0.34 },
    ], 2.2, false, 0.35);
    // Swept horns off the temples - the bit that says machine and not knight.
    for (const d of [-1, 1]) {
      sk.poly([
        { x: x + d * s * 0.2, y: y - s * 0.3 },
        { x: x + d * s * 0.5, y: y - s * 0.44 },
        { x: x + d * s * 0.26, y: y - s * 0.18 },
      ], 2.1, false, 0.4);
    }
    // Jaw vents.
    for (const d of [-1, 0, 1]) {
      sk.line({ x: x + d * s * 0.08, y: y + s * 0.14 }, { x: x + d * s * 0.08, y: y + s * 0.24 }, 1.8, 1, 0.25);
    }
  }
}
