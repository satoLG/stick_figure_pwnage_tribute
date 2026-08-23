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
// 4. WIND
// ---------------------------------------------------------------------------
/**
 * There is nothing in his hands. What cuts is the air: every swing throws
 * three parallel claws of wind a long way out in front of him, and what they
 * leave in the masonry is three scores with wall still standing between them
 * rather than one missing wedge - `rake` on a move is what does that.
 *
 * The reach is enormous by melee standards and deliberately so. A cut that
 * lands at arm's length is a blade; a cut that opens the wall from twenty feet
 * away is weather.
 */
/** Seconds of held trigger before the swings stop and the storm starts gathering. */
const GALE_HOLD = 0.55;
/** How long the storm takes to blow itself out once it is let go. */
const GALE_TIME = 0.85;

/** One cut of air on its way out; it keeps opening as it goes. */
interface Gust {
  x: number; y: number;
  ang: number; len: number;
  life: number; max: number;
  seed: number;
}

const WIND_SETS: Record<MeleeMode, readonly MeleeMove[]> = {
  ground: [
    {
      from: -0.95, to: 0.75, wind: 0.22, strike: 0.16, anim: 0.19, cooldown: 0.17, reach: 1.1, thick: 26,
      rake: 3, swingSfx: 'swing', swingPitch: 1.3, hitSfx: 'slash', hitPitch: 1.3, shake: 5, name: 'GUST',
    },
    {
      from: 0.9, to: -0.8, wind: 0.2, strike: 0.16, anim: 0.18, cooldown: 0.16, reach: 1.1, thick: 26,
      rake: 3, swingSfx: 'swing', swingPitch: 1.35, hitSfx: 'slash', hitPitch: 1.38, shake: 5, name: 'BACK GUST',
    },
    {
      from: -1.15, to: 0.95, wind: 0.24, strike: 0.18, anim: 0.23, cooldown: 0.2, reach: 1.2, thick: 32,
      rake: 4, swingSfx: 'swing', swingPitch: 1.2, hitSfx: 'slash', hitPitch: 1.2, shake: 7, name: 'SHEAR',
    },
    {
      from: 1.15, to: -1.1, wind: 0.3, strike: 0.18, anim: 0.36, cooldown: 0.38, reach: 1.3, thick: 44,
      rake: 4, heavy: true, impact: 1.7, dash: 120, flash: 0.22, shake: 13, hitPitch: 1.0, name: 'DOWNBURST',
    },
  ],
  run: [
    {
      from: -0.9, to: 0.85, wind: 0.22, strike: 0.16, anim: 0.27, cooldown: 0.27, reach: 1.25, thick: 32,
      rake: 4, dash: 330, slide: 0.2, ghost: 0.3, stance: 'lunge', stanceHip: -8, stanceLean: 0.12,
      hitSfx: 'slash', hitPitch: 1.12, shake: 9, name: 'SQUALL',
    },
    {
      from: 1.05, to: -0.9, wind: 0.18, strike: 0.16, anim: 0.21, cooldown: 0.21, reach: 1.2, thick: 28,
      rake: 3, dash: 190, slide: 0.12, hitSfx: 'slash', hitPitch: 1.22, shake: 6, name: 'PASSING GUST',
    },
  ],
  air: [
    {
      from: -1.7, to: 1.1, wind: 0.22, strike: 0.16, anim: 0.29, cooldown: 0.27, reach: 1.25, thick: 34,
      rake: 4, dash: 70, hitSfx: 'slash', hitPitch: 1.06, shake: 9, name: 'FALLING SHEAR',
    },
    {
      from: 2.0, to: -1.15, wind: 0.2, strike: 0.16, anim: 0.38, cooldown: 0.36, reach: 1.3, thick: 40,
      rake: 4, spin: 1, heavy: true, impact: 1.7, flash: 0.2, shake: 12, hitPitch: 0.92, name: 'CYCLONE',
    },
  ],
  hold: [
    // Only ever the lead-in: past GALE_HOLD the ordinary chain is suppressed
    // and the storm takes over.
    {
      from: -1.3, to: 1.05, wind: 0.2, strike: 0.15, anim: 0.14, cooldown: 0.11, reach: 1.25, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.44, shake: 5, name: 'FLURRY',
    },
    {
      from: 1.25, to: -1.0, wind: 0.2, strike: 0.15, anim: 0.14, cooldown: 0.11, reach: 1.25, thick: 30,
      rake: 3, ghost: 0.16, hitSfx: 'slash', hitPitch: 1.5, shake: 5, name: 'FLURRY',
    },
  ],
};

export class Wind extends MeleeWeapon {
  readonly id = 4;
  readonly name = 'WIND';
  readonly tagline = 'three claws of air, or the whole storm';
  protected readonly len = 172;
  protected readonly sets = WIND_SETS;

  /** The claw marks a pass leaves hanging - one per claw, not one per swing. */
  private marks = new SlashFx();
  private marked = false;
  /** 0..1 how much of the storm he has pulled in around himself. */
  private gather = 0;
  private gatherSfx = 0;
  /** Counts down through the storm itself. */
  private storm = 0;
  private stormPower = 1;
  private gusts: Gust[] = [];

  constructor() {
    super();
    this.animLen = 0.19;
    this.cooldown = 0.17;
    this.gripFwd = 34;
    this.gripLead = 0.16;
  }

  override onEquip(): void {
    super.onEquip();
    this.marks.clear();
    this.gusts.length = 0;
    this.marked = false;
    this.gather = 0;
    this.storm = 0;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.marks.clear();
    this.gusts.length = 0;
    this.gather = 0;
    this.storm = 0;
  }

  override get comboLabel(): string | null {
    if (this.gather > 0.02) return `GATHERING  ${Math.round(this.gather * 100)}%`;
    if (this.storm > 0) return 'TEMPEST';
    return super.comboLabel;
  }

  protected restAngle(ctx: WeaponCtx): number { return ctx.sm.pose.aim; }

  protected restHands(ctx: WeaponCtx): HandTargets {
    const lead = this.swap > 0;
    return {
      main: grip(ctx, lead ? 34 : 28, lead ? -6 : 13),
      off: grip(ctx, lead ? 28 : 34, lead ? 15 : -6),
    };
  }

  // -------------------------------------------------------------- the storm ---

  protected override suppressFire(): boolean {
    return this.heldFor > GALE_HOLD || this.storm > 0;
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor <= GALE_HOLD || this.gather < 0.2) { this.gather = 0; return; }
    this.stormPower = 0.4 + this.gather * 0.6;
    this.storm = GALE_TIME;
    this.gather = 0;
    this.cooldown = 1.4;
    this.timer = this.cooldown;
    ctx.sfx('heavyswing', 0.55);
    ctx.shake(10 * this.stormPower);
    ctx.flash(0.2 * this.stormPower);
    ctx.sm.applyRecoil(0.7, ctx.sm.pose.aim, 60 * this.stormPower);
    ctx.sm.addGhostBurst(0.3);

    // The tempest itself: a run of cuts arriving across the whole face over
    // the next second, each one three claws wide, at its own place and angle.
    const cuts = Math.round(8 + this.stormPower * 8);
    for (let i = 0; i < cuts; i++) {
      ctx.after(i * (GALE_TIME / cuts) * 0.9, () => this.stormCut(ctx));
    }
  }

  /** One cut of the tempest: three parallel rips into whatever it reaches. */
  private stormCut(ctx: WeaponCtx): void {
    const sm = ctx.sm;
    const c = sm.center;
    const a = sm.pose.aim + rand(-0.55, 0.55);
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = ctx.terrain.strikePoint(c.x, c.y, ca, sa, 1100, 5);
    const at = hit ?? { x: c.x + ca * 420, y: c.y + sa * 420 };
    const reach = 70 + this.stormPower * 60;
    if (hit) {
      // Three gouges side by side, cut along the line the wind is travelling.
      // Wind scores the face; it does not open a doorway - the depth is what
      // keeps the storm spectacular without making everything else pointless.
      for (let i = -1; i <= 1; i++) {
        const o = i * (18 + this.stormPower * 8);
        const x0 = at.x - sa * o, y0 = at.y + ca * o;
        ctx.terrain.carveCapsule(x0, y0, x0 + ca * reach, y0 + sa * reach,
          8 + this.stormPower * 4, 0.35, 26 + this.stormPower * 20);
      }
      ctx.particles.debris(at.x, at.y, 3, 260, a + Math.PI, 2.2);
      ctx.particles.streaks(at.x, at.y, 5, a, 0.7, 90);
    }
    this.gusts.push({
      x: at.x - ca * 60, y: at.y - sa * 60, ang: a,
      len: 180 + this.stormPower * 160, life: 0.3, max: 0.3,
      seed: Math.floor(rand(0, 9999)),
    });
    if (this.gusts.length > 10) this.gusts.shift();
    ctx.sfx('slash', rand(1.15, 1.5));
    ctx.shake(4);
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    super.tick(ctx, held);
    this.marks.update(ctx.dt);
    for (let i = this.gusts.length - 1; i >= 0; i--) {
      this.gusts[i].life -= ctx.dt;
      if (this.gusts[i].life <= 0) this.gusts.splice(i, 1);
    }
    this.storm = Math.max(0, this.storm - ctx.dt);

    // Pulling the air in. It has to be visible from across the room, because
    // what happens next takes a second and a half to play out.
    const pulling = held && this.heldFor > GALE_HOLD && this.storm <= 0;
    if (pulling) {
      this.gather = Math.min(1, this.gather + ctx.dt / 1.1);
      ctx.shake(0.6 + this.gather * 2.2);
      this.gatherSfx -= ctx.dt;
      if (this.gatherSfx <= 0) { ctx.sfx('swing', 0.5 + this.gather * 0.5); this.gatherSfx = 0.22; }
      if (Math.random() < 0.3 + this.gather * 0.6) {
        const c = ctx.sm.center;
        const a = rand(0, TAU);
        const r = 90 + this.gather * 70;
        ctx.particles.streaks(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, 1, a + Math.PI, 0.5, 60);
      }
    } else if (!held) {
      this.gather = damp(this.gather, 0, 12, ctx.dt);
    }

    if (this.anim <= 0) { this.marked = false; return; }
    if (this.marked || this.t <= this.move.wind) return;
    this.marked = true;
    this.addMarks(ctx);
  }

  /**
   * Three claws of air, thrown at the outer end of the reach and set to keep
   * opening outwards as they fade. The growth is what turns a crescent into a
   * gust: it does not sit where it was cut, it travels.
   */
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
        h.x, h.y, reach * (0.56 + t * 0.44), from, to,
        7 + (mv.thick ?? 26) * 0.2, 0.3, 78,
      );
    }
    ctx.particles.streaks(
      h.x + Math.cos(a) * reach * 0.7, h.y + Math.sin(a) * reach * 0.7,
      4, a, 1.1, 70,
    );
  }

  override stance(ctx: WeaponCtx): Stance | null {
    if (this.gather > 0.03) {
      return { kind: 'brace', weight: clamp(this.gather * 1.4, 0, 1) * 0.8, lean: -0.2, hip: -10 };
    }
    return super.stance(ctx);
  }

  /** The air moving round him at all times, so the weapon reads while idle. */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const cx = sm.center.x, cy = sm.center.y;
    c.save();
    c.strokeStyle = '#000';
    c.globalAlpha = 0.34 + this.gather * 0.5;
    c.lineWidth = 2 + this.gather * 1.6;
    const n = 4 + Math.round(this.gather * 5);
    for (let i = 0; i < n; i++) {
      // Ribbons of air sweeping round him, tighter and faster as he pulls
      // more of it in.
      const phase = (ctx.time * (0.7 + this.gather * 1.9) + i / n) % 1;
      const a = phase * TAU + i * 1.7;
      const r = (58 + i * 13) * (1 - this.gather * 0.3) + Math.sin(ctx.time * 2 + i) * 6;
      const sweep = 1.1 + this.gather * 0.9;
      const p0 = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.7 };
      const p1 = { x: cx + Math.cos(a + sweep) * r, y: cy + Math.sin(a + sweep) * r * 0.7 };
      const mid = {
        x: cx + Math.cos(a + sweep * 0.5) * r * 1.28,
        y: cy + Math.sin(a + sweep * 0.5) * r * 0.9,
      };
      sk.curve(p0, mid, p1, 2 + this.gather * 1.4, 1.6);
    }
    // While it is gathering the air is coming *in*, hard.
    if (this.gather > 0.05) {
      c.globalAlpha = this.gather * 0.8;
      c.lineWidth = 2.6;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + ctx.time * 1.4;
        const r0 = 210 * (1 - ((ctx.time * 1.3 + i * 0.11) % 1)) * this.gather + 70;
        sk.scrawl(
          { x: cx + Math.cos(a) * (r0 + 70), y: cy + Math.sin(a) * (r0 + 70) },
          { x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0 },
          2.6, 14, 3,
        );
      }
    }
    c.restore();
  }

  /** Nothing in his hands: the marks and the gusts are the whole weapon. */
  protected drawWeapon(sk: Sketch, _ctx: WeaponCtx): void {
    const c = sk.ctx;
    this.marks.draw(sk);
    if (this.gusts.length === 0) return;
    c.save();
    c.lineJoin = 'round';
    for (const g of this.gusts) {
      const k = g.life / g.max;
      const open = 1 - k;
      c.globalAlpha = clamp(k * 1.6, 0, 1);
      c.fillStyle = '#fff';
      c.strokeStyle = '#000';
      c.lineWidth = 3;
      // Three long claws of air travelling along the cut, opening as they go.
      sk.blastPath(g.x, g.y, 3, g.len * 0.12, g.len * (0.9 + open * 0.5),
        26 + open * 22, 0.34, g.ang, g.seed);
      c.fill();
      c.stroke();
      // And the loose air torn along with them.
      c.lineWidth = 2.4;
      for (let i = 0; i < 4; i++) {
        const o = (hashNoise(g.seed + i * 5, sk.boil)) * 46;
        const nx = -Math.sin(g.ang), ny = Math.cos(g.ang);
        const l = g.len * (0.5 + Math.abs(hashNoise(g.seed + i * 9, sk.boil)) * 0.8);
        sk.scrawl(
          { x: g.x + nx * o, y: g.y + ny * o },
          { x: g.x + nx * o + Math.cos(g.ang) * l, y: g.y + ny * o + Math.sin(g.ang) * l },
          2.4, 18, 4,
        );
      }
    }
    c.globalAlpha = 1;
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    // Three curls of air, which is what it leaves behind and all you ever see.
    for (let i = -1; i <= 1; i++) {
      const o = i * s * 0.24;
      sk.curve(
        { x: x - s * 0.46, y: y + o - s * 0.06 },
        { x: x + s * 0.06, y: y + o - s * 0.2 },
        { x: x + s * 0.4, y: y + o + s * 0.12 },
        i === 0 ? 3 : 2.3, 0.6,
      );
      sk.curve(
        { x: x + s * 0.4, y: y + o + s * 0.12 },
        { x: x + s * 0.5, y: y + o + s * 0.02 },
        { x: x + s * 0.34, y: y + o - s * 0.04 },
        i === 0 ? 2.6 : 2, 0.5,
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
  readonly tagline = 'three out the front, or ten off his back';
  override auto = true;
  override cooldown = 0.9;
  /** 0..1 recent launch, for the tube flash. */
  private launch = 0;
  /** 0..1 how far the salvo has finished loading. */
  private load = 0;
  private loadSfx = 0;
  /** Which of the three front barrels fires next. */
  private barrel = 0;

  override onEquip(): void { super.onEquip(); this.load = 0; this.launch = 0; this.barrel = 0; }

  /** How far open the rack is standing right now. */
  private get open(): number { return 0.9 + this.load * 0.35 + this.launch * 0.12; }

  /**
   * Where the whole rig hangs from: the middle of his chest, not his
   * shoulders. Everything fans out from here, and it has to be low enough that
   * the tubes stay under his head - a rack drawn across the face of the figure
   * stops being a rack and starts being a bush.
   */
  private root(ctx: WeaponCtx): Vec2 {
    const c = ctx.sm.pose.chest;
    return { x: c.x, y: c.y + 4 };
  }

  // --------------------------------------------------------- the geometry ---
  //
  // The rig is a bundle of long square tubes strapped round his shoulders: a
  // bank of three running forward along the aim, ending in open mouths, and a
  // bank of four swept back behind him. Front bank fires the singles, back
  // bank dumps the salvo - which is also the only shape that reads at a
  // glance, because a mouth pointing at the wall is obviously where a missile
  // comes out of.

  /** Perpendicular offset of front barrel `i`, biased below the aim line. */
  private frontOffset(i: number): number { return (i - 1) * 15 + 8; }

  /** The mouth of front barrel `i`. */
  private frontMouth(ctx: WeaponCtx, i: number): Vec2 {
    const a = ctx.sm.pose.aim;
    const r = this.root(ctx);
    const d = 12 + 58 * this.open;
    const o = this.frontOffset(i);
    return { x: r.x + Math.cos(a) * d - Math.sin(a) * o, y: r.y + Math.sin(a) * d + Math.cos(a) * o };
  }

  /**
   * Which way back tube `i` of four sweeps: a fan from below the shoulder line
   * round to just above it, so the bank spreads behind him rather than over him.
   */
  private backAxis(ctx: WeaponCtx, i: number): number {
    const f = ctx.sm.facing;
    const back = f > 0 ? Math.PI : 0;
    return back + f * (-0.34 + i * 0.27) * (0.85 + 0.2 * this.open);
  }

  /** The mouth of back tube `i`. */
  private backPod(ctx: WeaponCtx, i: number): Vec2 {
    const a = this.backAxis(ctx, i);
    const r = this.root(ctx);
    const d = (24 + (i % 2) * 14) + 38 * this.open;
    return { x: r.x + Math.cos(a) * d, y: r.y + Math.sin(a) * d };
  }

  // ------------------------------------------------------------- shooting ---

  private fire(ctx: WeaponCtx, from: Vec2, dir: number, target: Vec2, speed: number, arm: number): void {
    ctx.projectiles.push(new Projectile({
      x: from.x, y: from.y,
      vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
      kind: 'missile', gravity: 0, radius: 5, life: 4.5, blast: BLASTS.missile,
      target, turn: 3.4, accel: 1500, topSpeed: 1450, arm, weave: 0.2,
    }));
    ctx.particles.smoke(from.x, from.y, 2, 4);
    ctx.particles.sparks(from.x, from.y, 3, 200, dir + Math.PI, 1.2);
  }

  /**
   * The ordinary attack: three rounds out of the front barrels, one after the
   * other rather than all together - a ripple of three you can count is worth
   * more than one triple bang, and the barrels take it in turns so you can see
   * where each came from.
   */
  protected release(ctx: WeaponCtx): void {
    this.cooldown = 0.9;
    this.timer = this.cooldown;
    this.startAnim(0.5);
    ctx.sm.applyRecoil(0.3, ctx.sm.pose.aim, 20);
    for (let i = 0; i < 3; i++) {
      ctx.after(i * 0.13, () => {
        const b = this.barrel % 3;
        this.barrel++;
        const from = this.frontMouth(ctx, b);
        // Straight out of the mouth along the aim; the guidance only has to
        // tidy up the spread afterwards.
        const dir = this.aimFrom(ctx, from) + rand(-0.05, 0.05);
        const target = {
          x: ctx.aimPoint.x + rand(-60, 60),
          y: ctx.aimPoint.y + rand(-55, 55),
        };
        this.fire(ctx, from, dir, target, 620, 0.05);
        this.launch = 1;
        ctx.sfx('launch', rand(1.15, 1.32));
        ctx.shake(3.5);
        ctx.particles.streaks(from.x, from.y, 3, dir, 0.4, 44);
      });
    }
  }

  /** Everything the pods have, off his back, at everything still standing. */
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
      // is one bang, and ten leaving over half a second is a salvo.
      ctx.after(i * 0.045, () => {
        const side = i % 2 === 0 ? -1 : 1;
        const from = this.backPod(ctx, i % 4);
        // Up out of the back tubes and fanned, so the salvo climbs above him
        // first and comes down on the wall from ten different angles.
        const dir = -Math.PI / 2 + side * rand(0.15, 0.85) - f * 0.2;
        this.fire(ctx, from, dir, wallPoint(ctx), 340 + rand(0, 120), 0.16 + (i % 4) * 0.05);
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
      const p = this.backPod(ctx, Math.floor(rand(0, 4)));
      ctx.particles.sparks(p.x, p.y, 1, 110, ctx.sm.pose.aim + Math.PI, 1.6);
    }
  }

  /** One hand under the front bank, steadying it; the rig does the rest. */
  hands(ctx: WeaponCtx): HandTargets {
    const k = this.load;
    return { main: grip(ctx, 36 - k * 4, 14 + k * 3), off: null };
  }

  /** One square tube, knocked out in white with a heavy ink edge. */
  private tube(sk: Sketch, from: Vec2, ang: number, len: number, half: number, mouth: boolean): void {
    const c = sk.ctx;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (d: number, o: number): Vec2 => ({ x: from.x + ca * d - sa * o, y: from.y + sa * d + ca * o });
    const box = [at(0, -half), at(len, -half), at(len, half), at(0, half)];
    c.fillStyle = '#fff';
    sk.polyPath(box, 1);
    c.fill();
    sk.poly(box, 2.8, false, 1);
    // A band or two down it, which is what stops a long white box reading as a
    // blank slab.
    sk.line(at(len * 0.34, -half), at(len * 0.34, half), 2, 1, 0.4);
    sk.line(at(len * 0.66, -half), at(len * 0.66, half), 2, 1, 0.4);
    // The open mouth at the far end: a darker lip, so you can see it is a hole.
    if (mouth) {
      sk.line(at(len - 5, -half), at(len - 5, half), 3.2, 1, 0.5);
      c.fillStyle = '#000';
      sk.polyPath([at(len - 4, -half * 0.72), at(len, -half * 0.72), at(len, half * 0.72), at(len - 4, half * 0.72)], 0.6);
      c.fill();
    }
  }

  /** The back bank, behind the figure: four tubes swept out over his shoulder. */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const root = this.root(ctx);
    c.save();
    c.strokeStyle = '#000';
    for (let i = 0; i < 4; i++) {
      const a = this.backAxis(ctx, i);
      const len = (46 + (i % 2) * 14) * this.open;
      const start = { x: root.x + Math.cos(a) * 5, y: root.y + Math.sin(a) * 5 };
      this.tube(sk, start, a, len, 7 - (i % 2) * 1.2, true);
    }
    // The yoke it is all hung off, across his back.
    const a0 = this.backAxis(ctx, 0), a3 = this.backAxis(ctx, 3);
    sk.line(
      { x: root.x + Math.cos(a0) * 18, y: root.y + Math.sin(a0) * 18 },
      { x: root.x + Math.cos(a3) * 18, y: root.y + Math.sin(a3) * 18 },
      3.4, 2, 0.6,
    );
    c.restore();
  }

  /**
   * The front bank, over the figure: three barrels running along the aim with
   * their mouths pointing at whatever he is. Drawn on top of him, because in
   * the reference the rig is strapped over the arm rather than behind it.
   */
  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const a = ctx.sm.pose.aim;
    const root = this.root(ctx);
    const len = 58 * this.open;
    c.save();
    c.strokeStyle = '#000';
    const seat = (o: number): Vec2 => ({
      x: root.x + Math.cos(a) * 12 - Math.sin(a) * o,
      y: root.y + Math.sin(a) * 12 + Math.cos(a) * o,
    });
    for (let i = 0; i < 3; i++) {
      this.tube(sk, seat(this.frontOffset(i)), a, len * (i === 1 ? 1 : 0.86), 7, true);
    }
    // The block they are all socketed into, across the near ends.
    sk.line(seat(this.frontOffset(0) - 8), seat(this.frontOffset(2) + 8), 4, 2, 0.6);

    if (this.launch > 0.02) {
      const m = this.frontMouth(ctx, (this.barrel + 2) % 3);
      c.lineWidth = 2.8;
      sk.burst(m.x, m.y, 7, 6, 42 * this.launch, 2.8, 1.5, a, 5100);
    }
    // Loading tell: rings closing on the back tubes, so ten rounds arriving is
    // never a surprise.
    if (this.load > 0.03) {
      c.lineWidth = 1.8 + this.load * 1.6;
      for (const i of [0, 3]) {
        const p = this.backPod(ctx, i);
        for (let r = 0; r < 2; r++) {
          const phase = (ctx.time * 2.4 + r / 2) % 1;
          sk.polyPath(ring(p.x, p.y, (1 - phase) * 34 * this.load + 5, 10, ctx.time * 2), 1.4);
          c.stroke();
        }
      }
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    // Three barrels seen from the side, mouths to the right, one round away.
    for (let i = -1; i <= 1; i++) {
      const y0 = y + i * s * 0.2;
      sk.poly([
        { x: x - s * 0.46, y: y0 - s * 0.07 }, { x: x + s * 0.06, y: y0 - s * 0.07 },
        { x: x + s * 0.06, y: y0 + s * 0.07 }, { x: x - s * 0.46, y: y0 + s * 0.07 },
      ], 2, false, 0.4);
      sk.line({ x: x + s * 0.02, y: y0 - s * 0.07 }, { x: x + s * 0.02, y: y0 + s * 0.07 }, 2, 1, 0.3);
    }
    sk.poly([
      { x: x + s * 0.18, y: y - s * 0.09 }, { x: x + s * 0.46, y: y },
      { x: x + s * 0.18, y: y + s * 0.09 },
    ], 2.1, false, 0.4);
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

/** Seconds a summoned set hangs in the air before it starts going in. */
const SIGIL_HOLD = 1;
/** Gap between one orb of a set leaving and the next. */
const SIGIL_STEP = 0.16;

/** Four orbs summoned together, waiting on their moment. */
interface Sigil {
  /** Where each of the four is hanging, and where each is going. */
  orbs: Array<{ x: number; y: number; target: Vec2; gone: boolean }>;
  /** Counts up; under SIGIL_HOLD they wait, after it they leave one by one. */
  age: number;
  seed: number;
}

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
  /** Sets of summoned orbs waiting to go in. Several can be up at once. */
  private sigils: Sigil[] = [];

  override onEquip(): void {
    super.onEquip();
    this.beam = 0;
    this.cast = 0;
    this.sigils.length = 0;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.beam = 0;
    this.sigils.length = 0;
  }

  override get comboLabel(): string | null {
    const waiting = this.sigils.reduce((n, s) => n + s.orbs.filter((o) => !o.gone).length, 0);
    return waiting > 0 ? `${waiting} HELD` : null;
  }

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
   * The ordinary cast: four orbs summoned into the air in front of him, which
   * then simply *wait*. A second later they go in one at a time, at four
   * points around wherever the crosshair was when they were called - so the
   * cast is a decision made now and paid off in a moment, and casting again
   * while a set is still hanging stacks another one beside it.
   */
  private bolts(ctx: WeaponCtx): void {
    const from = this.head(ctx);
    const base = this.aimFrom(ctx, from);
    this.cooldown = 0.42;
    this.cast = 1;
    this.startAnim(0.3);
    ctx.sfx('charge', 1.5);
    ctx.shake(2);
    ctx.sm.applyRecoil(0.2, base, 6);

    // Hung in an arc in front of the staff, and aimed where he was looking.
    const orbs = [];
    for (let i = 0; i < 4; i++) {
      const spread = (i - 1.5) * 0.34;
      const d = 62 + Math.abs(i - 1.5) * 8;
      orbs.push({
        x: from.x + Math.cos(base + spread) * d,
        y: from.y + Math.sin(base + spread) * d,
        target: {
          x: ctx.aimPoint.x + rand(-90, 90),
          y: ctx.aimPoint.y + rand(-80, 80),
        },
        gone: false,
      });
    }
    this.sigils.push({ orbs, age: 0, seed: Math.floor(rand(0, 9999)) });
    if (this.sigils.length > 4) this.sigils.shift();
    ctx.particles.streaks(from.x, from.y, 4, base, 1.2, 40);
  }

  /** Ages the summoned sets and lets them go, one orb at a time. */
  private runSigils(ctx: WeaponCtx): void {
    for (let i = this.sigils.length - 1; i >= 0; i--) {
      const g = this.sigils[i];
      g.age += ctx.dt;
      // They breathe on the spot while they wait, which is most of what makes
      // four dots hanging in the air read as held magic rather than as a bug.
      if (g.age < SIGIL_HOLD) continue;
      const due = Math.floor((g.age - SIGIL_HOLD) / SIGIL_STEP);
      for (let k = 0; k <= due && k < g.orbs.length; k++) {
        const o = g.orbs[k];
        if (o.gone) continue;
        o.gone = true;
        const a = Math.atan2(o.target.y - o.y, o.target.x - o.x);
        const speed = 900;
        ctx.projectiles.push(new Projectile({
          x: o.x, y: o.y,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
          kind: 'orb', gravity: 0, radius: 8, life: 3, blast: BLASTS.orb,
          // A little guidance, so a set called at a moving crosshair still
          // lands where it was pointed rather than sailing past.
          target: o.target, turn: 2.4, arm: 0.05,
        }));
        ctx.sfx('fire', rand(0.9, 1.1));
        ctx.particles.streaks(o.x, o.y, 4, a, 0.8, 44);
      }
      if (g.orbs.every((o) => o.gone)) this.sigils.splice(i, 1);
    }
  }

  protected override tick(ctx: WeaponCtx): void {
    this.cast = Math.max(0, this.cast - ctx.dt * 3.4);
    this.runSigils(ctx);
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
      // Two more hoops, further back down the shaft than the ball is: they
      // slide along the staff towards the head as it fills, so the charge
      // reads as being drawn up the weapon and out of the end of it.
      c.lineWidth = 2.2 + k * 1.4;
      for (let i = 0; i < 2; i++) {
        const slide = ((ctx.time * 0.9 + i * 0.5) % 1);
        const d = 4 + slide * 54;
        const p = at(d, 0);
        const rr = (13 + (1 - slide) * 9) * (0.6 + k * 0.6);
        const pts = ring(p.x, p.y, rr, 12, ctx.time * (1.4 + i))
          .map((q) => ({
            // Squashed along the shaft, so each hoop reads as encircling it
            // rather than lying flat on the paper beside it.
            x: p.x + (q.x - p.x) * (0.26 + Math.abs(Math.sin(ctx.time * 1.6 + i)) * 0.2) * ca
              - (q.y - p.y) * sa,
            y: p.y + (q.x - p.x) * (0.26 + Math.abs(Math.sin(ctx.time * 1.6 + i)) * 0.2) * sa
              + (q.y - p.y) * ca,
          }));
        sk.polyPath(pts, 1.2);
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

    // --- summoned orbs, hanging and waiting --------------------------------
    for (const g of this.sigils) {
      const wait = clamp(g.age / SIGIL_HOLD, 0, 1);
      for (let i = 0; i < g.orbs.length; i++) {
        const o = g.orbs[i];
        if (o.gone) continue;
        // Breathing on the spot, and winding tighter as their moment comes.
        const bob = Math.sin(ctx.time * 3.4 + i * 1.3) * 3;
        const ox = o.x, oy = o.y + bob;
        const r = 7 + Math.sin(ctx.time * 5 + i) * 0.8 + wait * 2.5;
        c.strokeStyle = '#000';
        // The little ring each one sits inside: the magic bit.
        c.lineWidth = 1.8;
        c.globalAlpha = 0.55 + wait * 0.45;
        sk.polyPath(ring(ox, oy, r * 2.4 - wait * r * 0.7, 9, -ctx.time * (1.1 + i * 0.3)), 1.2);
        c.stroke();
        sk.polyPath(ring(ox, oy, r * 1.6, 7, ctx.time * (1.6 + i * 0.2)), 1);
        c.stroke();
        c.globalAlpha = 1;
        c.fillStyle = '#000';
        sk.polyPath(ring(ox, oy, r, 10, ctx.time * 2 + i), 1.2);
        c.fill();
        c.fillStyle = '#fff';
        sk.polyPath(ring(ox, oy, r * 0.42, 8, -ctx.time * 3), 0.9);
        c.fill();
        c.fillStyle = '#000';
        c.lineWidth = 2;
        sk.burst(ox, oy, 6, r * 1.4, r * (2.2 + wait), 2, TAU, 0, g.seed + i);
      }
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
// 11. SHINOBI
// ---------------------------------------------------------------------------
/** Under this much charge a release is the pair of blades, not the fireball. */
const SEAL_TAP = 0.28;
/** How long he stays bent over the breath after it goes. */
const BREATH_TIME = 0.55;

export class Shinobi extends Weapon {
  readonly id = 11;
  readonly name = 'SHINOBI';
  readonly tagline = 'two blades, or one very large breath';
  override cooldown = 0.36;
  override chargeTime = 1.05;
  /** Counts down through the exhale, which owns the whole pose while it runs. */
  private breath = 0;
  private throwT = 0;

  override onEquip(): void { super.onEquip(); this.breath = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.breath = 0; }

  protected release(ctx: WeaponCtx, power: number): void {
    if (power < SEAL_TAP) { this.kunai(ctx); return; }
    this.fireball(ctx, power);
  }

  /** Two blades, one after the other, roughly where he is looking. */
  private kunai(ctx: WeaponCtx): void {
    this.cooldown = 0.36;
    this.throwT = 0.26;
    this.startAnim(0.26);
    ctx.sm.applyRecoil(0.3, ctx.sm.pose.aim, 10);
    for (let i = 0; i < 2; i++) {
      ctx.after(i * 0.09, () => {
        const from = grip(ctx, 42, i === 0 ? -8 : 8);
        // Thrown rather than aimed: near enough the crosshair, never exactly.
        const a = this.aimFrom(ctx, from) + rand(-0.075, 0.075);
        ctx.projectiles.push(new Projectile({
          x: from.x, y: from.y,
          vx: Math.cos(a) * 1180, vy: Math.sin(a) * 1180,
          kind: 'kunai', gravity: 260, radius: 5, life: 3, blast: BLASTS.kunai,
        }));
        ctx.sfx('stab', rand(1.25, 1.45));
        ctx.particles.streaks(from.x, from.y, 2, a, 0.3, 34);
        this.throwT = 0.2;
      });
    }
    ctx.shake(2);
  }

  /**
   * The one the seals were for. One hand goes to his mouth, he folds forward
   * over the aim, and what comes out is bigger than he is - a ball of fire
   * that crosses the room and takes a doorway out of the wall.
   */
  private fireball(ctx: WeaponCtx, power: number): void {
    const sm = ctx.sm;
    this.cooldown = 1.9;
    this.breath = BREATH_TIME;
    this.startAnim(BREATH_TIME);
    const head = sm.pose.head;
    const a = this.aimFrom(ctx, head);
    // Sized so the ball and its flames together come out about twice his
    // height across - which is what "bigger than he is" has to mean when the
    // tongues around it are half the silhouette.
    const r = clamp(sm.height * 0.46, 50, 78) * (0.78 + power * 0.22);
    const d = r * 1.5 + 26;
    const mouth = { x: head.x + Math.cos(a) * d, y: head.y + Math.sin(a) * d };
    ctx.projectiles.push(new Projectile({
      x: mouth.x, y: mouth.y,
      vx: Math.cos(a) * 720, vy: Math.sin(a) * 720,
      kind: 'fireball', gravity: 60, radius: r, life: 4,
      blast: {
        ...BLASTS.fireball,
        radius: BLASTS.fireball.radius * (0.7 + power * 0.4),
        debris: Math.round(BLASTS.fireball.debris * (0.7 + power * 0.4)),
      },
    }));
    ctx.sfx('fire', 0.4);
    ctx.sfx('launch', 0.55);
    ctx.shake(13);
    ctx.flash(0.32);
    // Blowing something that size shoves him backwards off his own feet.
    sm.applyRecoil(1.1, a, 150);
    ctx.particles.smoke(mouth.x, mouth.y, 8, r * 0.4);
    ctx.particles.streaks(head.x, head.y, 10, a, 0.9, 120);
    ctx.particles.shockwave(mouth.x, mouth.y, r * 1.6);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.breath = Math.max(0, this.breath - ctx.dt);
    this.throwT = Math.max(0, this.throwT - ctx.dt);
  }

  /**
   * Down into the seals while it builds, then folded right over the breath.
   */
  override stance(_ctx: WeaponCtx): Stance | null {
    if (this.breath > 0) {
      const k = this.breath / BREATH_TIME;
      return { kind: 'lunge', weight: clamp(k * 1.6, 0, 1), lean: 0.3, hip: -10 };
    }
    if (this.charge < 0.03) return null;
    // Sunk into a crouch with the hands together: the whole body settles.
    const k = clamp(this.charge * 2, 0, 1);
    return { kind: 'brace', weight: k * 0.85, lean: 0.1, hip: -20 };
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    const sm = ctx.sm;
    const f = sm.facing;
    if (this.breath > 0) {
      // One hand cupped at his mouth, the other braced out behind him.
      const head = sm.pose.head;
      return {
        main: { x: head.x + f * 12, y: head.y + 11 },
        off: gripAt(ctx, sm.pose.aim + 2.5 * f, 30, 6 * f),
      };
    }
    if (this.charge > 0.02) {
      // Hands together in front of the sternum, making the seal.
      const k = this.charge;
      return { main: grip(ctx, 30 - k * 3, 5), off: grip(ctx, 30 - k * 3, -5) };
    }
    if (this.throwT > 0) {
      const k = this.throwT / 0.26;
      return { main: grip(ctx, 30 + (1 - k) * 16, -4), off: grip(ctx, 28, 14) };
    }
    return null;
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;

    // --- the seals, as an inset ---------------------------------------------
    if (this.charge > 0.02) {
      const k = this.charge;
      const f = sm.facing;
      const hands = { x: (sm.pose.handR.x + sm.pose.handL.x) / 2, y: (sm.pose.handR.y + sm.pose.handL.y) / 2 };
      const R = 34 + k * 12;
      // Up and behind him, and never off the paper: it is an inset panel, and
      // an inset panel over his own head is just a hat.
      const cx = clamp(hands.x - f * 104, R + 12, ctx.terrain.w - R - 12);
      const cy = Math.max(R + 14, hands.y - 132);

      c.save();
      // The two lines running out to the hands, so the circle reads as a
      // magnified detail of them rather than as a bubble floating beside him.
      c.strokeStyle = '#000';
      c.globalAlpha = 0.55;
      c.lineWidth = 1.8;
      sk.line({ x: cx + f * R * 0.9, y: cy + R * 0.35 }, { x: hands.x - f * 10, y: hands.y - 10 }, 1.8, 2, 1.2);
      sk.line({ x: cx + f * R * 0.45, y: cy + R * 0.92 }, { x: hands.x - f * 2, y: hands.y + 10 }, 1.8, 2, 1.2);
      c.globalAlpha = 1;

      // The lens itself.
      c.fillStyle = '#fff';
      sk.polyPath(ring(cx, cy, R, 16, 0), 1.2);
      c.fill();
      c.lineWidth = 4;
      sk.polyPath(ring(cx, cy, R, 16, 0), 1.2);
      c.stroke();

      // Inside it: two hands pressed together, the fingers changing every few
      // frames so it reads as a sequence of seals rather than one pose held.
      const seal = Math.floor(ctx.time * 7) % 3;
      c.lineWidth = 2.6;
      const s = R * 0.62;
      sk.line({ x: cx - s * 0.7, y: cy + s * 0.9 }, { x: cx - s * 0.15, y: cy - s * 0.1 }, 2.8, 2, 0.5);
      sk.line({ x: cx + s * 0.7, y: cy + s * 0.9 }, { x: cx + s * 0.15, y: cy - s * 0.1 }, 2.8, 2, 0.5);
      for (let i = 0; i < 3; i++) {
        const up = seal === 0 ? i !== 1 : seal === 1 ? i === 1 : i === 0;
        const x0 = cx + (i - 1) * s * 0.34;
        sk.line(
          { x: x0, y: cy - s * 0.05 },
          { x: x0 + (up ? 0 : (i - 1) * s * 0.3), y: cy - (up ? s * 0.85 : s * 0.35) },
          2.4, 1, 0.4,
        );
      }
      // A tick or two of "this is moving", and the charge ring round the rim.
      c.lineWidth = 2.2;
      sk.burst(cx, cy, 5, R * 1.08, R * (1.25 + k * 0.5), 2.2, TAU, 0, 8101);
      c.lineWidth = 3;
      c.beginPath();
      c.arc(cx, cy, R + 7, -Math.PI / 2, -Math.PI / 2 + k * TAU);
      c.stroke();
      c.restore();
    }

    // --- the breath ---------------------------------------------------------
    if (this.breath > 0) {
      const k = this.breath / BREATH_TIME;
      const head = sm.pose.head;
      const a = sm.pose.aim;
      c.save();
      c.fillStyle = '#fff';
      c.strokeStyle = '#000';
      c.lineWidth = 3;
      // The plume still coming out of him, chasing the ball it just threw.
      sk.blastPath(head.x + Math.cos(a) * 18, head.y + Math.sin(a) * 18,
        9, 12, 60 + 120 * k, 26, 1.1, a, 8201);
      c.fill();
      c.stroke();
      c.restore();
    }

    // --- a blade in hand between throws -------------------------------------
    if (this.throwT > 0.02 && this.charge < 0.02 && this.breath <= 0) {
      const h = sm.pose.handR;
      const a = sm.pose.aim;
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (d: number, o: number): Vec2 => ({ x: h.x + ca * d - sa * o, y: h.y + sa * d + ca * o });
      c.strokeStyle = '#000';
      sk.poly([at(20, 0), at(6, -5), at(-2, -3), at(-2, 3), at(6, 5)], 2.2, false, 0.4);
      sk.line(at(-2, 0), at(-14, 0), 2.6, 1, 0.4);
      sk.polyPath(ring(at(-16, 0).x, at(-16, 0).y, 4, 7, 0), 0.7);
      c.stroke();
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // A kunai over a puff of flame: the two halves of the weapon in one mark.
    c.fillStyle = '#fff';
    sk.ragPath(x + s * 0.16, y + s * 0.12, s * 0.26, 11, 0.42, 8301);
    c.fill();
    c.lineWidth = 2.4;
    sk.ragPath(x + s * 0.16, y + s * 0.12, s * 0.26, 11, 0.42, 8301);
    c.stroke();
    sk.poly([
      { x: x + s * 0.12, y: y - s * 0.44 }, { x: x - s * 0.06, y: y - s * 0.16 },
      { x: x - s * 0.02, y: y - s * 0.04 }, { x: x + s * 0.1, y: y - s * 0.06 },
      { x: x + s * 0.2, y: y - s * 0.18 },
    ], 2.2, false, 0.4);
    sk.line({ x: x + s * 0.06, y: y - s * 0.05 }, { x: x - s * 0.16, y: y + s * 0.3 }, 2.6, 1, 0.4);
    sk.polyPath(ring(x - s * 0.2, y + s * 0.36, s * 0.08, 7, 0), 0.6);
    c.stroke();
  }
}

// ---------------------------------------------------------------------------
// 12. THUNDERBOLT
// ---------------------------------------------------------------------------
/** Under this much charge a release is the skipping bolts, not the discharge. */
const VOLT_TAP = 0.3;
/** How long the drawn arcs of a discharge stay on the paper. */
const ARC_TIME = 0.36;
/** How many ways the discharge goes at once. */
const ARC_COUNT = 22;

/** One drawn arc of electricity, from the body out to whatever it earthed on. */
interface Arc {
  pts: Vec2[];
  life: number; max: number;
  width: number;
}

export class Thunderbolt extends Weapon {
  readonly id = 12;
  readonly name = 'THUNDERBOLT';
  readonly tagline = 'bolts that skip, or all of it at once';
  override cooldown = 0.3;
  override chargeTime = 1.1;
  private arcs: Arc[] = [];
  private crackle = 0;
  private auraSfx = 0;

  override onEquip(): void { super.onEquip(); this.arcs.length = 0; this.crackle = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.arcs.length = 0; }

  /**
   * A jagged path between two points. Everything electric in here is one of
   * these: a run of segments kicked off the straight line by a hash, so it is
   * stable within a frame and completely different in the next.
   */
  private static bolt(from: Vec2, to: Vec2, steps: number, kick: number, seed: number): Vec2[] {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pts: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const o = i === 0 || i === steps ? 0 : hashNoise(seed + i, i * 7) * kick * Math.sin(t * Math.PI);
      pts.push({ x: from.x + dx * t + nx * o, y: from.y + dy * t + ny * o });
    }
    return pts;
  }

  protected release(ctx: WeaponCtx, power: number): void {
    if (power < VOLT_TAP) { this.skip(ctx); return; }
    this.discharge(ctx, power);
  }

  /**
   * The ordinary shot: three discharges thrown forward that glance off the
   * ground and skip on rather than dying in it, so they walk their way to the
   * wall instead of drilling straight at it.
   */
  private skip(ctx: WeaponCtx): void {
    const from = grip(ctx, 44);
    const base = this.aimFrom(ctx, from);
    this.cooldown = 0.3;
    this.crackle = 1;
    this.startAnim(0.22);
    ctx.sfx('rifle', rand(1.35, 1.55));
    ctx.shake(3);
    ctx.sm.applyRecoil(0.4, base, 14);
    for (let i = 0; i < 3; i++) {
      const a = base + (i - 1) * 0.14 + rand(-0.05, 0.05);
      const speed = 900 + rand(-70, 70);
      ctx.projectiles.push(new Projectile({
        x: from.x, y: from.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        kind: 'bolt', gravity: 420, radius: 6, life: 2.4, blast: BLASTS.bolt,
        bounces: 3,
      }));
    }
    // The arc leaving his hand, so the shot starts as electricity rather than
    // as three darts appearing in mid-air.
    for (let i = 0; i < 3; i++) {
      this.arcs.push({
        pts: Thunderbolt.bolt(
          from, { x: from.x + Math.cos(base) * 90, y: from.y + Math.sin(base) * 90 },
          5, 22, Math.floor(rand(0, 9999)),
        ),
        life: 0.12, max: 0.12, width: 3.4,
      });
    }
  }

  /**
   * Everything he has been holding, in every direction at once. Each way out
   * earths itself on the first thing it reaches and takes a bite out of it, so
   * standing inside the wall's reach when this goes off opens the whole face.
   */
  private discharge(ctx: WeaponCtx, power: number): void {
    const sm = ctx.sm;
    const c = sm.center;
    const k = 0.5 + power * 0.5;
    this.cooldown = 1.7;
    this.crackle = 1;
    this.startAnim(0.45);
    ctx.sfx('cannon', 1.25);
    ctx.sfx('beam', 1.5);
    ctx.shake(20 * k);
    ctx.flash(0.7 * k);
    ctx.invert(0.07);
    ctx.particles.shockwave(c.x, c.y, 190 * k);
    sm.addGhostBurst(0.26);

    for (let i = 0; i < ARC_COUNT; i++) {
      const a = (i / ARC_COUNT) * TAU + rand(-0.06, 0.06);
      const ca = Math.cos(a), sa = Math.sin(a);
      const range = 300 + 320 * k;
      const hit = ctx.terrain.strikePoint(c.x, c.y, ca, sa, range, 5);
      const end = hit ?? { x: c.x + ca * range, y: c.y + sa * range };
      // They start clear of him rather than at his sternum, so twenty-two
      // bolts leaving at once still leave a figure to see them leaving.
      const from = { x: c.x + ca * 34, y: c.y + sa * 34 };
      this.arcs.push({
        pts: Thunderbolt.bolt(from, end, 7, 26 + 20 * k, Math.floor(rand(0, 9999))),
        life: ARC_TIME, max: ARC_TIME, width: 3 + k * 3,
      });
      if (!hit) continue;
      ctx.terrain.carveBlob(hit.x, hit.y, (20 + 18 * k), 0.4, 15, (26 + 26 * k));
      ctx.particles.debris(hit.x, hit.y, 3, 280, a + Math.PI, 2.2);
      ctx.particles.sparks(hit.x, hit.y, 4, 380, a + Math.PI, 2.4);
    }
    ctx.hit(c.x, c.y, sm.pose.aim, 2);
    ctx.freeze(2);
  }

  protected override tick(ctx: WeaponCtx): void {
    this.crackle = Math.max(0, this.crackle - ctx.dt * 3);
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].life -= ctx.dt;
      if (this.arcs[i].life <= 0) this.arcs.splice(i, 1);
    }
    if (this.charge <= 0.02) return;
    // Winding up: it crawls all over him and the floor starts lifting.
    const k = this.charge;
    ctx.shake(0.8 + k * 3);
    this.auraSfx -= ctx.dt;
    if (this.auraSfx <= 0) { ctx.sfx('aura', 1.3 + k * 0.8); this.auraSfx = 0.22; }
    if (Math.random() < 0.3 + k * 0.6) {
      const c = ctx.sm.center;
      ctx.particles.sparks(c.x + rand(-40, 40), c.y + rand(-46, 46), 1, 200, rand(0, TAU), TAU);
    }
    if (ctx.sm.onGround && Math.random() < k * 0.6) {
      ctx.particles.updraft(ctx.sm.pos.x, ctx.sm.pos.y - 4, 1, 30 + k * 40, 110 + k * 180);
    }
  }

  override stance(ctx: WeaponCtx): Stance | null {
    if (this.charge < 0.05) return null;
    const k = clamp(this.charge * 1.4, 0, 1);
    return ctx.sm.onGround
      ? { kind: 'brace', weight: k * 0.9, lean: -0.26, hip: -12 }
      : { kind: 'hover', weight: k * 0.7, lean: -0.1, hip: 2 };
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    if (this.charge > 0.02) {
      // Arms flung wide, holding it in.
      const f = ctx.sm.facing;
      const a = ctx.sm.pose.aim;
      const k = this.charge;
      return {
        main: gripAt(ctx, a - (1.5 + k * 0.4) * f, 30, 0),
        off: gripAt(ctx, a + (1.5 + k * 0.4) * f, 30, 0),
      };
    }
    if (this.anim > 0) {
      const push = Math.sin(clamp(this.t / 0.4, 0, 1) * Math.PI);
      return { main: grip(ctx, 32 + push * 14, -4), off: grip(ctx, 28, 14) };
    }
    return null;
  }

  /** Electricity crawling over the figure while he holds it in. */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const k = Math.max(this.charge, this.crackle * 0.5);
    if (k < 0.04) return;
    const c = sk.ctx;
    const sm = ctx.sm;
    const p = sm.pose;
    const joints = [p.head, p.chest, p.pelvis, p.handR, p.handL, p.footR, p.footL, p.kneeR, p.kneeL];
    c.save();
    c.strokeStyle = '#000';
    c.lineCap = 'round';
    // Between his own joints: the charge has nowhere to go yet, so it runs
    // round the outside of him looking for somewhere.
    const n = 3 + Math.round(k * 6);
    for (let i = 0; i < n; i++) {
      const a = joints[Math.abs(Math.floor(hashNoise(i * 3, sk.boil) * joints.length)) % joints.length];
      const b = joints[Math.abs(Math.floor(hashNoise(i * 7 + 3, sk.boil) * joints.length)) % joints.length];
      const pts = Thunderbolt.bolt(a, b, 5, 16 + k * 16, i * 31 + sk.boil);
      c.lineWidth = 4 + k * 2;
      c.strokeStyle = '#fff';
      strokePts(c, pts);
      c.lineWidth = 2 + k * 1.6;
      c.strokeStyle = '#000';
      strokePts(c, pts);
    }
    // And a halo of it standing off him, bigger the longer he holds.
    c.strokeStyle = '#000';
    c.lineWidth = 2.4;
    const cc = sm.center;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + ctx.time * 2.2;
      const r0 = 42 + k * 24;
      const r1 = r0 + 24 + k * 60;
      sk.scrawl(
        { x: cc.x + Math.cos(a) * r0, y: cc.y + Math.sin(a) * r0 },
        { x: cc.x + Math.cos(a) * r1, y: cc.y + Math.sin(a) * r1 },
        2.4, 20, 4,
      );
    }
    c.restore();
  }

  draw(sk: Sketch, _ctx: WeaponCtx): void {
    if (this.arcs.length === 0) return;
    const c = sk.ctx;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const a of this.arcs) {
      const k = a.life / a.max;
      c.globalAlpha = clamp(k * 1.8, 0, 1);
      // Thick white core with an ink edge either side of it, which is the only
      // way a bolt reads over the paper and over the black wall at once.
      c.strokeStyle = '#000';
      c.lineWidth = a.width * (0.6 + k) + 5;
      strokePts(c, a.pts);
      c.strokeStyle = '#fff';
      c.lineWidth = a.width * (0.6 + k) + 1;
      strokePts(c, a.pts);
      // Forks, thrown off wherever it kinked.
      c.strokeStyle = '#000';
      c.lineWidth = 2.4;
      for (let i = 1; i < a.pts.length - 1; i += 2) {
        const p = a.pts[i];
        const fa = hashNoise(i * 13, sk.boil) * TAU;
        const l = (14 + Math.abs(hashNoise(i * 17, sk.boil)) * 30) * k;
        sk.scrawl(p, { x: p.x + Math.cos(fa) * l, y: p.y + Math.sin(fa) * l }, 2.4, 8, 2);
      }
    }
    c.globalAlpha = 1;
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // The bolt itself, filled solid: it has to read at twenty pixels.
    c.fillStyle = c.strokeStyle as string;
    sk.polyPath([
      { x: x + s * 0.16, y: y - s * 0.46 }, { x: x - s * 0.26, y: y + s * 0.06 },
      { x: x - s * 0.02, y: y + s * 0.06 }, { x: x - s * 0.16, y: y + s * 0.46 },
      { x: x + s * 0.28, y: y - s * 0.08 }, { x: x + s * 0.04, y: y - s * 0.08 },
    ], 0.8);
    c.fill();
    c.lineWidth = 2;
    sk.line({ x: x + s * 0.3, y: y - s * 0.34 }, { x: x + s * 0.46, y: y - s * 0.42 }, 2, 1, 0.4);
    sk.line({ x: x - s * 0.32, y: y + s * 0.3 }, { x: x - s * 0.46, y: y + s * 0.4 }, 2, 1, 0.4);
  }
}

/** Strokes an open polyline; every bolt in here is drawn twice through this. */
function strokePts(c: CanvasRenderingContext2D, pts: readonly Vec2[]): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) c.moveTo(pts[i].x, pts[i].y); else c.lineTo(pts[i].x, pts[i].y);
  }
  c.stroke();
}

// ---------------------------------------------------------------------------
// 13. MECHA
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
  readonly id = 13;
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
