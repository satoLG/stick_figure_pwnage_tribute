/**
 * The three powers that change what he *is* rather than what he is holding.
 *
 * A cape and a mouth that opens far wider than a head should. A machine he
 * climbs inside and then throws at the wall. A skull that splits down the
 * middle. They all take pieces of the figure off the drawing - `hidesHead`,
 * `hidesBody`, `headScale` - and put their own back in its place, posed off
 * the same skeleton so the gait, the lean and the recoil still drive them.
 */
import {
  clamp, damp, easeOutCubic, hashNoise, lerp, rand, TAU, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import { BLASTS, Projectile } from './projectiles';
import { HEAD_R, type HandTargets, type Stance } from './stickman';
import { grip, gripAt, wallPoint, Weapon, type WeaponCtx } from './weapon-base';

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
 * A white column with a hard ink edge, from a point along an angle. Every beam
 * in this file is one, and the flare at the mouth is what stops it looking
 * like a plank.
 */
function beamBand(
  sk: Sketch, from: Vec2, ang: number, len: number, r: number, flare = 0.55,
): void {
  const c = sk.ctx;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const nx = -sa, ny = ca;
  const steps = 14;
  const top: Vec2[] = [], bot: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wob = hashNoise(i, sk.boil) * r * 0.09;
    // Narrow at the mouth, opening out down its length.
    const w = r * (flare + Math.min(1, t * 5) * (1 - flare) + t * 0.22) + wob;
    top.push({ x: from.x + ca * len * t + nx * w, y: from.y + sa * len * t + ny * w });
    bot.push({ x: from.x + ca * len * t - nx * w, y: from.y + sa * len * t - ny * w });
  }
  c.beginPath();
  c.moveTo(top[0].x, top[0].y);
  for (const p of top) c.lineTo(p.x, p.y);
  for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
  c.closePath();
  c.fillStyle = '#fff';
  c.fill();
  c.strokeStyle = '#000';
  c.lineWidth = 4.4;
  c.beginPath();
  for (let i = 0; i < top.length; i++) { if (i === 0) c.moveTo(top[i].x, top[i].y); else c.lineTo(top[i].x, top[i].y); }
  c.stroke();
  c.beginPath();
  for (let i = 0; i < bot.length; i++) { if (i === 0) c.moveTo(bot[i].x, bot[i].y); else c.lineTo(bot[i].x, bot[i].y); }
  c.stroke();
  // Speed lines down the inside of it.
  c.lineWidth = 2.2;
  for (let i = 0; i < 7; i++) {
    const o = hashNoise(i * 3, sk.boil) * r * 0.7;
    const d0 = (sk.boil * 90 + i * 190) % Math.max(1, len);
    c.beginPath();
    c.moveTo(from.x + ca * d0 + nx * o, from.y + sa * d0 + ny * o);
    const d1 = Math.min(len, d0 + 130);
    c.lineTo(from.x + ca * d1 + nx * o, from.y + sa * d1 + ny * o);
    c.stroke();
  }
}

/**
 * A beam that bores forward into whatever it is leaning on, and reports how
 * far down its own line it actually reaches. Shared by the shout and by the
 * thing that answers it.
 */
function boreBeam(
  ctx: WeaponCtx, from: Vec2, ang: number, radius: number, bore: number, range: number,
): number {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const front = ctx.terrain.strikePoint(from.x, from.y, ca, sa, range, 6);
  const reach = front
    ? Math.min(range, Math.hypot(front.x - from.x, front.y - from.y) + bore + radius)
    : range;
  ctx.terrain.carveCapsule(from.x, from.y, from.x + ca * reach, from.y + sa * reach,
    radius, 0.16, bore);
  if (front) {
    ctx.particles.debris(front.x, front.y, 3, 340, ang + Math.PI, 2.2);
    ctx.particles.sparks(front.x, front.y, 4, 420, ang + Math.PI, 2.4);
    ctx.particles.smoke(front.x, front.y, 1, radius * 0.7);
  }
  return reach;
}

// ---------------------------------------------------------------------------
// 15. THE SHOUT
// ---------------------------------------------------------------------------
/** Seconds the mouth is open on an ordinary shout. */
const SHOUT_TIME = 0.7;
/** How long the thing behind him takes to come up out of the floor. */
const RISE_TIME = 0.9;
/** And how long its own answer lasts once it opens. */
const ROAR_TIME = 1.3;
/** Under this much charge a release is his shout, not the summon. */
const SHOUT_TAP = 0.3;

/**
 * A cape, a mouth that opens wider than a head should, and something under the
 * floor that opens wider still.
 *
 * Neither attack aims. Both go straight out along his facing, which is the
 * whole character of it: you point this by standing somewhere, not by pointing.
 */
export class Shout extends Weapon {
  readonly id = 15;
  readonly name = 'THE SHOUT';
  readonly tagline = 'straight ahead, and it does not aim';
  override cooldown = 0.9;
  override chargeTime = 1.2;

  private shout = 0;
  private beamR = 0;
  /** 0..1 how far the thing behind him is out of the ground. */
  private rise = 0;
  private roar = 0;
  private summoned = false;
  private power = 1;
  /** Latched at the moment of firing: neither beam turns once it is out. */
  private dir = 0;
  private sfxT = 0;

  override onEquip(): void {
    super.onEquip();
    this.shout = 0;
    this.rise = 0;
    this.roar = 0;
    this.summoned = false;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.shout = 0;
    this.rise = 0;
    this.roar = 0;
    this.summoned = false;
  }

  /** The mouth swells with the shout; the rest of the time he is himself. */
  override get headScale(): number {
    return 1 + Math.max(this.shout / SHOUT_TIME, this.charge * 0.5) * 0.55;
  }

  override get comboLabel(): string | null {
    if (this.roar > 0) return 'ROAR';
    if (this.summoned) return 'RISING';
    return null;
  }

  protected release(ctx: WeaponCtx, power: number): void {
    this.dir = ctx.sm.facing > 0 ? 0 : Math.PI;
    if (power < SHOUT_TAP) {
      this.cooldown = 0.9;
      this.shout = SHOUT_TIME;
      this.beamR = 26;
      this.power = 1;
      ctx.sfx('beam', 0.45);
      ctx.sfx('cannon', 1.4);
      ctx.shake(7);
      ctx.flash(0.24);
      ctx.sm.applyRecoil(0.9, this.dir, 90);
      return;
    }
    // The summon. It comes up out of the floor behind him and takes its time.
    this.cooldown = 3.4;
    this.power = 0.6 + power * 0.4;
    this.summoned = true;
    this.rise = 0;
    ctx.sfx('slam', 0.4);
    ctx.shake(16);
    ctx.invert(0.06);
    ctx.particles.shockwave(ctx.sm.pos.x - ctx.sm.facing * 120, ctx.sm.pos.y, 220);
    for (let i = 0; i < 14; i++) {
      ctx.particles.updraft(ctx.sm.pos.x - ctx.sm.facing * (60 + rand(0, 180)), ctx.sm.pos.y, 2, 30, 260);
    }
  }

  protected override tick(ctx: WeaponCtx): void {
    this.sfxT -= ctx.dt;

    if (this.shout > 0) {
      this.shout = Math.max(0, this.shout - ctx.dt);
      const k = this.shout / SHOUT_TIME;
      const from = this.maw(ctx);
      const r = this.beamR * (0.5 + k * 0.7);
      boreBeam(ctx, from, this.dir, r, 210 * ctx.dt, 1500);
      ctx.shake(4 * k);
      ctx.sm.applyRecoil(0.4, this.dir, 120 * ctx.dt);
      if (this.sfxT <= 0) { ctx.sfx('beam', rand(0.5, 0.7)); this.sfxT = 0.08; }
    }

    if (!this.summoned) return;
    this.rise = Math.min(1, this.rise + ctx.dt / RISE_TIME);
    if (this.rise < 1) {
      ctx.shake(2 + this.rise * 5);
      if (Math.random() < 0.5) {
        const b = this.beastBase(ctx);
        ctx.particles.updraft(b.x + rand(-140, 140), b.y, 1, 40, 200);
      }
      return;
    }
    // Up, and answering. Its beam is the same shape as his and four times it.
    if (this.roar <= 0 && this.rise >= 1 && this.roarDone === false) {
      this.roar = ROAR_TIME;
      ctx.sfx('cannon', 0.5);
      ctx.flash(0.5);
      ctx.invert(0.08);
      ctx.shake(24);
    }
    if (this.roar <= 0) return;
    this.roar = Math.max(0, this.roar - ctx.dt);
    const k = this.roar / ROAR_TIME;
    const from = this.beastMaw(ctx);
    boreBeam(ctx, from, this.dir, (60 + 44 * this.power) * (0.55 + k * 0.55), 520 * ctx.dt, 1800);
    ctx.shake(9 * k);
    if (this.sfxT <= 0) { ctx.sfx('beam', rand(0.3, 0.42)); this.sfxT = 0.07; }
    if (this.roar <= 0) {
      this.roarDone = true;
      // It goes back down as fast as it came up.
      this.summoned = false;
      this.rise = 0;
      this.roarDone = false;
    }
  }

  private roarDone = false;

  /** Where his own beam leaves him: the front of an over-large mouth. */
  private maw(ctx: WeaponCtx): Vec2 {
    const h = ctx.sm.pose.head;
    const f = ctx.sm.facing;
    return { x: h.x + f * HEAD_R * this.headScale * 0.9, y: h.y + 3 };
  }

  /** Where the thing behind him stands. */
  private beastBase(ctx: WeaponCtx): Vec2 {
    const f = ctx.sm.facing;
    // Behind him, but never off the edge of the paper: it is 300 units tall
    // and it should be all the way on screen when it arrives.
    return {
      x: clamp(ctx.sm.pos.x - f * 150, 170, ctx.terrain.w - 170),
      y: ctx.sm.pos.y + 6,
    };
  }

  private beastMaw(ctx: WeaponCtx): Vec2 {
    const b = this.beastBase(ctx);
    const f = ctx.sm.facing;
    const H = 300 * easeOutCubic(this.rise);
    return { x: b.x + f * 96, y: b.y - H * 0.72 };
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    if (this.shout > 0) {
      // Braced against his own voice, fists down and back.
      const f = ctx.sm.facing;
      return { main: gripAt(ctx, this.dir + 2.3 * f, 30, 0), off: gripAt(ctx, this.dir - 2.3 * f, 30, 0) };
    }
    if (this.charge > 0.02) {
      const k = this.charge;
      return { main: grip(ctx, 28 - k * 4, 12), off: grip(ctx, 28 - k * 4, -12) };
    }
    return null;
  }

  override stance(_ctx: WeaponCtx): Stance | null {
    if (this.shout > 0) {
      const k = this.shout / SHOUT_TIME;
      return { kind: 'brace', weight: clamp(k * 1.6, 0, 1), lean: -0.3, hip: -12 };
    }
    if (this.summoned) return { kind: 'brace', weight: 0.7, lean: -0.24, hip: -8 };
    if (this.charge < 0.04) return null;
    return { kind: 'brace', weight: clamp(this.charge * 1.5, 0, 1) * 0.9, lean: -0.28, hip: -14 };
  }

  /** The cape, and whatever is coming up out of the floor behind him. */
  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const f = sm.facing;
    const neck = sm.pose.neck;
    const hip = sm.pose.pelvis;

    c.save();
    c.strokeStyle = '#000';
    // Cape: a broad sheet hung off his shoulders, blowing back off whatever is
    // going on. Knocked out in white so it reads over the wall.
    const blow = 22 + Math.abs(sm.vel.x) * 0.06 + this.charge * 40
      + (this.shout > 0 ? 70 : 0) + this.rise * 50;
    const sway = Math.sin(ctx.time * 2.6) * 7;
    const hem = { x: hip.x - f * (18 + blow), y: hip.y + 44 - blow * 0.3 + sway };
    const pts: Vec2[] = [
      { x: neck.x - f * 13, y: neck.y - 2 },
      { x: neck.x + f * 11, y: neck.y + 1 },
      { x: hip.x + f * (6 - blow * 0.25), y: hip.y + 40 + sway * 0.4 },
      hem,
      { x: hip.x - f * (34 + blow), y: hip.y + 8 - blow * 0.5 },
    ];
    c.fillStyle = '#fff';
    sk.polyPath(pts, 1.6);
    c.fill();
    sk.poly(pts, 3.6, false, 1.6);
    // Folds.
    for (let i = 1; i <= 2; i++) {
      const t = i / 3;
      sk.curve(
        { x: neck.x - f * (4 + t * 8), y: neck.y + 4 },
        { x: hip.x - f * (14 + blow * t), y: hip.y + 18 },
        { x: lerp(pts[2].x, pts[4].x, t), y: lerp(pts[2].y, pts[4].y, t) },
        2.2, 1.4,
      );
    }
    // The collar clasp.
    sk.line({ x: neck.x - f * 12, y: neck.y - 1 }, { x: neck.x + f * 10, y: neck.y + 2 }, 4, 1, 0.5);

    if (this.summoned || this.roar > 0) this.drawBeast(sk, ctx);
    c.restore();
  }

  /**
   * The thing under the floor. It is drawn solid black with white gouged out
   * of it - the opposite treatment to everything else in the game, which is
   * exactly why it reads as something that does not belong here.
   */
  private drawBeast(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const f = ctx.sm.facing;
    const b = this.beastBase(ctx);
    const up = easeOutCubic(this.rise);
    const H = 300 * up;
    const W = 150 * (0.5 + up * 0.5);
    if (H < 6) return;

    const at = (dx: number, dy: number): Vec2 => ({ x: b.x + f * dx, y: b.y - dy });
    // A hunched mass with horns, ragged along every edge.
    const body: Vec2[] = [
      at(-W, 0), at(-W * 0.86, H * 0.5), at(-W * 0.5, H * 0.82),
      at(-W * 0.24, H * 1.02), at(0, H * 0.94),
      at(W * 0.2, H * 1.05), at(W * 0.52, H * 0.86), at(W * 0.7, H * 0.6),
      at(W * 0.86, H * 0.34), at(W * 0.72, 0),
    ];
    const rag = body.map((p, i) => ({
      x: p.x + hashNoise(i * 5, sk.boil) * 9,
      y: p.y + hashNoise(i * 9, sk.boil + 3) * 9,
    }));
    c.fillStyle = '#000';
    sk.polyPath(rag, 2.4);
    c.fill();

    // Horns off the top, drawn as solid hooks.
    for (const d of [-0.3, 0.16]) {
      const root = at(W * d, H * 0.94);
      const tip = at(W * (d - 0.42), H * 1.42);
      c.beginPath();
      c.moveTo(root.x, root.y - 10);
      c.quadraticCurveTo(root.x + f * 10, tip.y + 24, tip.x, tip.y);
      c.quadraticCurveTo(root.x - f * 6, tip.y + 40, root.x, root.y + 10);
      c.closePath();
      c.fill();
    }

    // Eyes and the maw: white cut out of the black, which is the whole read.
    c.fillStyle = '#fff';
    const eye = at(W * 0.44, H * 0.8);
    sk.polyPath([
      { x: eye.x - f * 30, y: eye.y - 6 }, { x: eye.x + f * 6, y: eye.y - 14 },
      { x: eye.x + f * 4, y: eye.y + 6 },
    ], 1.4);
    c.fill();
    const eye2 = at(W * 0.12, H * 0.86);
    sk.polyPath([
      { x: eye2.x - f * 24, y: eye2.y - 5 }, { x: eye2.x + f * 4, y: eye2.y - 12 },
      { x: eye2.x + f * 2, y: eye2.y + 5 },
    ], 1.4);
    c.fill();

    // The mouth, open as far as the roar has it open.
    const m = this.beastMaw(ctx);
    const open = this.roar > 0 ? 1 : clamp((up - 0.55) / 0.45, 0, 1);
    const jaw = (56 + 44 * this.power) * open;
    if (jaw > 3) {
      const mouth: Vec2[] = [
        { x: m.x - f * 20, y: m.y - jaw * 0.9 },
        { x: m.x + f * 26, y: m.y - jaw * 0.5 },
        { x: m.x + f * 30, y: m.y + jaw * 0.5 },
        { x: m.x - f * 20, y: m.y + jaw * 0.9 },
      ];
      c.fillStyle = '#fff';
      sk.polyPath(mouth, 2);
      c.fill();
      // Teeth, cut back out of the white in black.
      c.fillStyle = '#000';
      for (let i = 0; i < 5; i++) {
        const t = (i + 0.5) / 5;
        const y0 = lerp(mouth[0].y, mouth[3].y, t);
        const x0 = lerp(mouth[0].x, mouth[3].x, t);
        c.beginPath();
        c.moveTo(x0, y0 - jaw * 0.09);
        c.lineTo(x0 + f * 20, y0);
        c.lineTo(x0, y0 + jaw * 0.09);
        c.closePath();
        c.fill();
      }
    }
    // Chunks of floor still falling off it while it climbs.
    if (up < 1) {
      c.fillStyle = '#000';
      c.lineWidth = 2.4;
      c.strokeStyle = '#000';
      sk.burst(b.x, b.y, 9, W * 0.5, W * (0.8 + up), 2.4, 1.6, -Math.PI / 2, 9001);
    }
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const f = sm.facing;

    // --- his own mouth, open far wider than a head should go ---------------
    const shoutK = this.shout > 0 ? this.shout / SHOUT_TIME : 0;
    const open = Math.max(shoutK, this.charge * 0.35);
    if (open > 0.03) {
      const h = sm.pose.head;
      const R = HEAD_R * this.headScale;
      const jaw = R * (0.5 + open * 1.1);
      c.save();
      c.fillStyle = '#fff';
      c.strokeStyle = '#000';
      const mouth: Vec2[] = [
        { x: h.x + f * R * 0.1, y: h.y - jaw * 0.55 },
        { x: h.x + f * (R + jaw * 0.4), y: h.y - jaw * 0.25 },
        { x: h.x + f * (R + jaw * 0.5), y: h.y + jaw * 0.3 },
        { x: h.x + f * R * 0.1, y: h.y + jaw * 0.6 },
      ];
      sk.polyPath(mouth, 1.4);
      c.fill();
      sk.poly(mouth, 3.6, false, 1.4);
      c.restore();
    }

    // --- the beams, neither of which turns ---------------------------------
    if (this.shout > 0) {
      const k = shoutK;
      const from = this.maw(ctx);
      const r = this.beamR * (0.5 + k * 0.7);
      const ca = Math.cos(this.dir), sa = Math.sin(this.dir);
      const front = ctx.terrain.strikePoint(from.x, from.y, ca, sa, 1500, 6);
      const len = front ? Math.hypot(front.x - from.x, front.y - from.y) + r : 1500;
      c.save();
      beamBand(sk, from, this.dir, Math.max(50, len), r);
      c.strokeStyle = '#000';
      c.lineWidth = 3.2;
      sk.burst(from.x, from.y, 9, r * 1.2, r * 3, 3.2, TAU, 0, 9101);
      c.restore();
    }
    if (this.roar > 0) {
      const k = this.roar / ROAR_TIME;
      const from = this.beastMaw(ctx);
      const r = (60 + 44 * this.power) * (0.55 + k * 0.55);
      const ca = Math.cos(this.dir), sa = Math.sin(this.dir);
      const front = ctx.terrain.strikePoint(from.x, from.y, ca, sa, 1800, 6);
      const len = front ? Math.hypot(front.x - from.x, front.y - from.y) + r : 1800;
      c.save();
      beamBand(sk, from, this.dir, Math.max(60, len), r, 0.7);
      c.strokeStyle = '#000';
      c.lineWidth = 4;
      sk.burst(from.x, from.y, 12, r * 1.1, r * 2.6, 4, TAU, 0, 9102);
      c.restore();
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // A head in profile with the mouth wide and a beam leaving it.
    sk.polyPath(ring(x - s * 0.2, y - s * 0.04, s * 0.24, 9, 0), 0.8);
    c.stroke();
    c.fillStyle = c.strokeStyle as string;
    sk.polyPath([
      { x: x - s * 0.06, y: y - s * 0.14 }, { x: x + s * 0.46, y: y - s * 0.26 },
      { x: x + s * 0.46, y: y + s * 0.2 }, { x: x - s * 0.06, y: y + s * 0.1 },
    ], 1);
    c.fill();
    // Cape behind it.
    sk.curve(
      { x: x - s * 0.34, y: y - s * 0.22 },
      { x: x - s * 0.52, y: y + s * 0.1 },
      { x: x - s * 0.3, y: y + s * 0.42 }, 2.6, 0.6,
    );
  }
}

// ---------------------------------------------------------------------------
// 16. THE TITAN
// ---------------------------------------------------------------------------
type TitanPhase = 'idle' | 'aim' | 'volley' | 'burn' | 'eject' | 'monolith' | 'gone';

/** Seconds of held trigger before the arm folds into a launcher. */
const TITAN_HOLD = 0.55;
/** The scripted collapse, in the order it happens. */
const T_VOLLEY = 1.0, T_BURN = 1.1, T_EJECT = 0.5, T_MONO = 0.75, T_GONE = 1.6;

/**
 * He climbs inside a machine several times his size. While it is up he is not
 * drawn at all - `hidesBody` - and the titan is posed off his own skeleton, so
 * it walks with his gait, leans with his lean and takes his recoil.
 *
 * Its held attack is a sequence rather than a shot: five missiles, then the
 * thing catches fire, then he climbs out of it, then it folds itself into a
 * slab which he picks up and throws at the wall.
 */
export class Titan extends Weapon {
  readonly id = 16;
  readonly name = 'TITAN';
  readonly tagline = 'punches, eye beams, and then he throws it';
  override auto = true;
  override cooldown = 0.42;
  override readonly ranged = false;

  private phase: TitanPhase = 'idle';
  private phaseT = 0;
  /** 0..1 how much of the machine is standing; 0 while it is gone. */
  private up = 1;
  /** Alternates punch, punch, eye beam through the ordinary combo. */
  private step = 0;
  private punch = 0;
  private beam = 0;
  private muzzleT = 0;
  /** The slab, once it exists: a position and a flight. */
  private slab: { x: number; y: number; vx: number; vy: number; spin: number } | null = null;

  override onEquip(): void {
    super.onEquip();
    this.phase = 'idle';
    this.up = 1;
    this.step = 0;
    this.slab = null;
  }

  override onUnequip(ctx: WeaponCtx): void {
    super.onUnequip(ctx);
    this.phase = 'idle';
    this.up = 1;
    this.slab = null;
  }

  override get hidesBody(): boolean {
    // From the moment he kicks the hatch he is the thing to watch, so the
    // machine stops standing in for him even though it is still standing.
    if (this.phase === 'eject' || this.phase === 'monolith' || this.phase === 'gone') return false;
    return this.up > 0.25;
  }

  override get comboLabel(): string | null {
    switch (this.phase) {
      case 'aim': return 'LOCKING';
      case 'volley': return 'VOLLEY';
      case 'burn': return 'CRITICAL';
      case 'eject': return 'EJECT';
      case 'monolith': return 'MONOLITH';
      case 'gone': return 'REBUILDING';
      default: return null;
    }
  }

  // ---------------------------------------------------------------- scale ---
  //
  // Everything is drawn off the skeleton, blown up about a machine's worth
  // around the point his feet are standing on.

  private readonly scale = 2.55;
  private big(ctx: WeaponCtx, p: Vec2): Vec2 {
    const o = ctx.sm.pos;
    return { x: o.x + (p.x - o.x) * this.scale, y: o.y + (p.y - o.y) * this.scale };
  }

  // ------------------------------------------------------------- attacking ---

  protected release(ctx: WeaponCtx): void {
    if (this.phase !== 'idle' || this.up < 0.9) { this.timer = 0.2; return; }
    this.step++;
    if (this.step % 3 === 0) this.eyeBeam(ctx); else this.throwPunch(ctx);
  }

  private throwPunch(ctx: WeaponCtx): void {
    this.cooldown = 0.42;
    this.timer = this.cooldown;
    this.startAnim(0.4);
    this.punch = 1;
    const f = ctx.sm.facing;
    const fist = this.big(ctx, ctx.sm.pose.handR);
    const a = f > 0 ? 0 : Math.PI;
    const hit = ctx.terrain.strikePoint(fist.x, fist.y, Math.cos(a), Math.sin(a), 220, 4);
    const at = hit ?? { x: fist.x + Math.cos(a) * 150, y: fist.y };
    ctx.sfx('slam', rand(0.85, 1));
    ctx.shake(hit ? 16 : 6);
    if (hit) {
      ctx.terrain.carveBlob(at.x, at.y, 72, 0.34, 18, 64);
      ctx.particles.debris(at.x, at.y, 14, 320, a + Math.PI, 2.2);
      ctx.hit(at.x, at.y, a, 1.7);
      ctx.freeze(2);
    }
  }

  private eyeBeam(ctx: WeaponCtx): void {
    this.cooldown = 0.62;
    this.timer = this.cooldown;
    this.startAnim(0.5);
    this.beam = 0.34;
    ctx.sfx('beam', 0.9);
    ctx.shake(6);
    ctx.flash(0.16);
  }

  protected override suppressFire(): boolean {
    return this.heldFor > TITAN_HOLD || this.phase !== 'idle';
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    // Letting go always happens out of 'aim' - that is what holding it did -
    // so both count as ready. Anything past that is a sequence already running.
    if ((this.phase !== 'idle' && this.phase !== 'aim')
      || this.heldFor <= TITAN_HOLD || this.up < 0.9) return;
    this.phase = 'volley';
    this.phaseT = T_VOLLEY;
    this.cooldown = 6;
    this.timer = this.cooldown;
    // Five, out of the hand that has just folded itself into a launcher.
    for (let i = 0; i < 5; i++) {
      ctx.after(i * 0.14, () => {
        const from = this.big(ctx, ctx.sm.pose.handR);
        const f = ctx.sm.facing;
        ctx.projectiles.push(new Projectile({
          x: from.x, y: from.y,
          vx: f * (620 + rand(0, 120)), vy: rand(-260, -60),
          kind: 'missile', gravity: 0, radius: 7, life: 4,
          blast: { ...BLASTS.missile, radius: BLASTS.missile.radius * 1.5, debris: 34 },
          target: wallPoint(ctx), turn: 3.4, accel: 1500, topSpeed: 1500, arm: 0.12, weave: 0.2,
        }));
        this.muzzleT = 0.12;
        ctx.sfx('launch', rand(0.95, 1.1));
        ctx.shake(6);
        ctx.particles.smoke(from.x, from.y, 3, 8);
      });
    }
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.punch = Math.max(0, this.punch - ctx.dt * 3);
    this.beam = Math.max(0, this.beam - ctx.dt);
    this.muzzleT = Math.max(0, this.muzzleT - ctx.dt);

    if (this.beam > 0) this.burnEyes(ctx);
    if (this.slab) this.flySlab(ctx);

    // The arm folds up while the trigger is down and it is still standing.
    if (this.phase === 'idle' && held && this.heldFor > TITAN_HOLD && this.up > 0.9) {
      this.phase = 'aim';
      this.phaseT = 0;
    }
    if (this.phase === 'aim') {
      this.phaseT += ctx.dt;
      if (!held) this.phase = 'idle';
      ctx.shake(1.4);
      return;
    }
    if (this.phase === 'idle') {
      // Rebuilding after a throw.
      this.up = damp(this.up, 1, 3, ctx.dt);
      return;
    }

    this.phaseT -= ctx.dt;
    if (this.phaseT > 0) {
      this.runPhase(ctx);
      return;
    }
    this.advance(ctx);
  }

  private runPhase(ctx: WeaponCtx): void {
    switch (this.phase) {
      case 'burn':
        // Alight and shaking itself apart.
        ctx.shake(6);
        if (Math.random() < 0.7) {
          const p = this.big(ctx, ctx.sm.pose.chest);
          ctx.particles.flames(p.x + rand(-40, 40), p.y + rand(-50, 50), 1, -Math.PI / 2, 130);
          ctx.particles.smoke(p.x + rand(-40, 40), p.y + rand(-60, 20), 1, 10);
        }
        break;
      case 'monolith':
        this.up = damp(this.up, 0, 9, ctx.dt);
        ctx.shake(4);
        break;
      case 'gone':
        this.up = damp(this.up, 0, 8, ctx.dt);
        break;
      default:
        break;
    }
  }

  private advance(ctx: WeaponCtx): void {
    switch (this.phase) {
      case 'volley':
        this.phase = 'burn';
        this.phaseT = T_BURN;
        ctx.sfx('fire', 0.6);
        break;
      case 'burn':
        this.phase = 'eject';
        this.phaseT = T_EJECT;
        // He comes out of the top of it.
        ctx.sm.dash(-ctx.sm.facing * 90, -520);
        ctx.sm.addGhostBurst(0.3);
        ctx.sfx('jump', 0.8);
        ctx.shake(9);
        break;
      case 'eject':
        this.phase = 'monolith';
        this.phaseT = T_MONO;
        ctx.sfx('slam', 1.3);
        ctx.shake(14);
        ctx.flash(0.2);
        break;
      case 'monolith': {
        // He picks the slab up and puts it through the wall.
        const from = ctx.sm.pose.handR;
        const target = wallPoint(ctx);
        const a = Math.atan2(target.y - from.y, target.x - from.x);
        this.slab = {
          x: from.x, y: from.y,
          vx: Math.cos(a) * 1150, vy: Math.sin(a) * 1150 - 90,
          spin: 0,
        };
        this.phase = 'gone';
        this.phaseT = T_GONE;
        ctx.sfx('heavyswing', 0.6);
        ctx.sm.applyRecoil(0.9, a, 60);
        ctx.shake(8);
        break;
      }
      case 'gone':
        this.phase = 'idle';
        break;
      default:
        this.phase = 'idle';
    }
  }

  /** Two thin beams out of the head, into whatever the crosshair is on. */
  private burnEyes(ctx: WeaponCtx): void {
    const head = this.big(ctx, ctx.sm.pose.head);
    const a = Math.atan2(ctx.aimPoint.y - head.y, ctx.aimPoint.x - head.x);
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = ctx.terrain.strikePoint(head.x, head.y, ca, sa, 1400, 5);
    if (!hit) return;
    ctx.terrain.carveBlob(hit.x, hit.y, 22, 0.4, 14, 200 * ctx.dt);
    ctx.particles.sparks(hit.x, hit.y, 2, 340, a + Math.PI, 2.2);
  }

  private flySlab(ctx: WeaponCtx): void {
    const s = this.slab!;
    s.spin += ctx.dt * 8;
    s.vy += 360 * ctx.dt;
    const nx = s.x + s.vx * ctx.dt, ny = s.y + s.vy * ctx.dt;
    const hit = ctx.terrain.raycast(s.x, s.y, nx - s.x, ny - s.y,
      Math.hypot(nx - s.x, ny - s.y) + 1, 2);
    if (hit || nx < -200 || nx > ctx.terrain.w + 200 || ny > ctx.terrain.h + 200) {
      const at = hit ?? { x: nx, y: ny };
      // Everything the machine had left, in one go.
      const blast = { ...BLASTS.bazooka, radius: 132, debris: 90, bites: 15 };
      ctx.projectiles.push(new Projectile({
        x: at.x, y: at.y, vx: 0, vy: 0, kind: 'shell',
        gravity: 0, radius: 2, life: 0.001, blast,
      }));
      this.slab = null;
      return;
    }
    s.x = nx; s.y = ny;
    ctx.particles.sparks(s.x, s.y, 1, 140, Math.atan2(-s.vy, -s.vx), 1.4);
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    if (this.up < 0.25) return null;
    const f = ctx.sm.facing;
    const a = ctx.sm.pose.aim;
    if (this.phase === 'aim' || this.phase === 'volley') {
      return { main: grip(ctx, 44, -4), off: gripAt(ctx, a + 2.2 * f, 26, 0) };
    }
    if (this.punch > 0.02) {
      const push = Math.sin(clamp(this.t / 0.45, 0, 1) * Math.PI);
      return { main: grip(ctx, 30 + push * 16, -3), off: grip(ctx, 26, 15) };
    }
    return { main: grip(ctx, 30, 6), off: grip(ctx, 28, -10) };
  }

  // ---------------------------------------------------------------- drawing ---

  /** One armour plate: a rough box, white with a heavy ink edge. */
  private plate(sk: Sketch, a: Vec2, b: Vec2, w0: number, w1: number, seed: number): void {
    const c = sk.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pts: Vec2[] = [
      { x: a.x + nx * w0, y: a.y + ny * w0 },
      { x: b.x + nx * w1, y: b.y + ny * w1 },
      { x: b.x - nx * w1, y: b.y - ny * w1 },
      { x: a.x - nx * w0, y: a.y - ny * w0 },
    ];
    c.fillStyle = '#fff';
    sk.polyPath(pts, 1.1);
    c.fill();
    sk.poly(pts, 3.4, false, 1.1);
    // A band across it, so a plate is plainly a plate.
    const m = 0.62;
    sk.line(
      { x: lerp(a.x, b.x, m) + nx * lerp(w0, w1, m), y: lerp(a.y, b.y, m) + ny * lerp(w0, w1, m) },
      { x: lerp(a.x, b.x, m) - nx * lerp(w0, w1, m), y: lerp(a.y, b.y, m) - ny * lerp(w0, w1, m) },
      2.2, 1, 0.4,
    );
    void seed;
  }

  override drawBehind(sk: Sketch, ctx: WeaponCtx): void {
    if (this.up < 0.04) return;
    const c = sk.ctx;
    const sm = ctx.sm;
    const p = sm.pose;
    const f = sm.facing;
    const B = (v: Vec2): Vec2 => this.big(ctx, v);
    // Collapsing: everything squashes down towards the floor.
    const k = this.up;
    const squash = (v: Vec2): Vec2 => {
      const q = B(v);
      return { x: q.x, y: sm.pos.y - (sm.pos.y - q.y) * k };
    };

    c.save();
    c.strokeStyle = '#000';
    c.lineJoin = 'round';

    // Back arm and back leg first.
    this.plate(sk, squash(p.hipL), squash(p.kneeL), 23, 19, 1);
    this.plate(sk, squash(p.kneeL), squash(p.footL), 19, 23, 2);
    this.plate(sk, squash(p.shL), squash(p.elbowL), 21, 17, 3);
    this.plate(sk, squash(p.elbowL), squash(p.handL), 17, 20, 4);

    // Torso: a slab of a chest over a narrower waist.
    const chest = squash(p.chest), pelvis = squash(p.pelvis);
    this.plate(sk, chest, pelvis, 46, 29, 5);
    this.plate(sk, squash(p.neck), chest, 28, 44, 6);
    // Shoulder pauldrons.
    for (const sh of [p.shL, p.shR]) {
      const s = squash(sh);
      const pts = [
        { x: s.x - f * 21, y: s.y - 26 }, { x: s.x + f * 29, y: s.y - 21 },
        { x: s.x + f * 26, y: s.y + 18 }, { x: s.x - f * 21, y: s.y + 13 },
      ];
      c.fillStyle = '#fff';
      sk.polyPath(pts, 1.2);
      c.fill();
      sk.poly(pts, 3.4, false, 1.2);
    }

    // Front leg and front arm.
    this.plate(sk, squash(p.hipR), squash(p.kneeR), 24, 20, 7);
    this.plate(sk, squash(p.kneeR), squash(p.footR), 20, 24, 8);

    // The head: a blocky helm with a visor, and the eye beams' sockets.
    const h = squash(p.head);
    const R = HEAD_R * this.scale * 0.92 * (0.4 + k * 0.6);
    const helm = [
      { x: h.x - R * 0.9, y: h.y - R * 0.5 }, { x: h.x - R * 0.6, y: h.y - R },
      { x: h.x + R * 0.7, y: h.y - R }, { x: h.x + R, y: h.y - R * 0.4 },
      { x: h.x + R * 0.8, y: h.y + R * 0.85 }, { x: h.x - R * 0.75, y: h.y + R * 0.8 },
    ];
    c.fillStyle = '#fff';
    sk.polyPath(helm, 1.2);
    c.fill();
    sk.poly(helm, 3.8, false, 1.2);
    c.fillStyle = '#000';
    sk.polyPath([
      { x: h.x - R * 0.62, y: h.y - R * 0.16 }, { x: h.x + R * 0.8, y: h.y - R * 0.3 },
      { x: h.x + R * 0.74, y: h.y + R * 0.16 }, { x: h.x - R * 0.6, y: h.y + R * 0.2 },
    ], 1);
    c.fill();

    // Arm in front, and whatever it is currently being.
    this.plate(sk, squash(p.shR), squash(p.elbowR), 22, 18, 9);
    if (this.phase === 'aim' || this.phase === 'volley') {
      // The forearm folded into a launcher.
      const e = squash(p.elbowR), hd = squash(p.handR);
      const dx = hd.x - e.x, dy = hd.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const tip = { x: hd.x + (dx / len) * 34, y: hd.y + (dy / len) * 34 };
      this.plate(sk, e, tip, 21, 26, 10);
      const nx = -dy / len, ny = dx / len;
      for (let i = -1; i <= 1; i++) {
        sk.line(
          { x: tip.x + nx * i * 9, y: tip.y + ny * i * 9 },
          { x: tip.x + (dx / len) * 8 + nx * i * 9, y: tip.y + (dy / len) * 8 + ny * i * 9 },
          3.4, 1, 0.4,
        );
      }
      if (this.muzzleT > 0) {
        c.strokeStyle = '#000';
        c.lineWidth = 3;
        sk.burst(tip.x, tip.y, 8, 10, 60, 3, 1.4, Math.atan2(dy, dx), 9201);
      }
    } else {
      this.plate(sk, squash(p.elbowR), squash(p.handR), 18, 23, 11);
      // A fist, and the shock coming off it.
      const hd = squash(p.handR);
      if (this.punch > 0.02) {
        c.strokeStyle = '#000';
        c.lineWidth = 3.4;
        sk.burst(hd.x, hd.y, 8, 16, 60 * this.punch, 3.4, 2.2, f > 0 ? 0 : Math.PI, 9202);
      }
    }
    c.restore();
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;

    // --- eye beams ----------------------------------------------------------
    if (this.beam > 0 && this.up > 0.5) {
      const head = this.big(ctx, sm.pose.head);
      const a = Math.atan2(ctx.aimPoint.y - head.y, ctx.aimPoint.x - head.x);
      const ca = Math.cos(a), sa = Math.sin(a);
      const hit = ctx.terrain.strikePoint(head.x, head.y, ca, sa, 1400, 5);
      const len = hit ? Math.hypot(hit.x - head.x, hit.y - head.y) : 1400;
      c.save();
      c.strokeStyle = '#000';
      const nx = -sa, ny = ca;
      for (const d of [-9, 9]) {
        const from = { x: head.x + nx * d, y: head.y + ny * d };
        c.lineWidth = 8;
        c.strokeStyle = '#fff';
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(from.x + ca * len, from.y + sa * len);
        c.stroke();
        c.lineWidth = 3.4;
        c.strokeStyle = '#000';
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(from.x + ca * len, from.y + sa * len);
        c.stroke();
      }
      if (hit) {
        c.fillStyle = '#fff';
        sk.ragPath(hit.x, hit.y, 22, 11, 0.44, 9301);
        c.fill();
        c.lineWidth = 3;
        c.strokeStyle = '#000';
        sk.ragPath(hit.x, hit.y, 22, 11, 0.44, 9301);
        c.stroke();
      }
      c.restore();
    }

    // --- the slab, once it is one ------------------------------------------
    const showSlab = this.phase === 'monolith' || this.slab !== null;
    if (showSlab) {
      const at = this.slab ?? { x: sm.pose.handR.x, y: sm.pose.handR.y, spin: 0 };
      const rot = this.slab ? this.slab.spin : Math.sin(ctx.time * 3) * 0.1;
      c.save();
      c.translate(at.x, at.y);
      c.rotate(rot);
      c.strokeStyle = '#000';
      c.fillStyle = '#fff';
      const w = 26, hgt = 44;
      const box = [{ x: -w, y: -hgt }, { x: w, y: -hgt }, { x: w, y: hgt }, { x: -w, y: hgt }];
      sk.polyPath(box, 1.2);
      c.fill();
      sk.poly(box, 4, false, 1.2);
      // Circuitry: a few lines and a solid core, so it reads as a machine
      // compressed rather than as a rock.
      for (let i = -2; i <= 2; i++) {
        sk.line({ x: -w, y: i * 15 }, { x: w, y: i * 15 }, 2, 1, 0.4);
      }
      c.fillStyle = '#000';
      sk.polyPath([{ x: -9, y: -12 }, { x: 9, y: -12 }, { x: 9, y: 12 }, { x: -9, y: 12 }], 0.8);
      c.fill();
      c.restore();
      if (this.slab) {
        c.strokeStyle = '#000';
        c.lineWidth = 2.6;
        sk.burst(at.x, at.y, 6, 30, 74, 2.6, 1.2,
          Math.atan2(-this.slab.vy, -this.slab.vx), 9302);
      }
    }
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // A blocky helm with a solid visor and a pauldron either side.
    sk.poly([
      { x: x - s * 0.26, y: y - s * 0.34 }, { x: x + s * 0.26, y: y - s * 0.34 },
      { x: x + s * 0.3, y: y + s * 0.06 }, { x: x + s * 0.2, y: y + s * 0.24 },
      { x: x - s * 0.2, y: y + s * 0.24 }, { x: x - s * 0.3, y: y + s * 0.06 },
    ], 2.6, false, 0.5);
    c.fillStyle = c.strokeStyle as string;
    sk.polyPath([
      { x: x - s * 0.2, y: y - s * 0.12 }, { x: x + s * 0.2, y: y - s * 0.16 },
      { x: x + s * 0.18, y: y + s * 0.02 }, { x: x - s * 0.18, y: y + s * 0.04 },
    ], 0.8);
    c.fill();
    for (const d of [-1, 1]) {
      sk.poly([
        { x: x + d * s * 0.32, y: y - s * 0.24 }, { x: x + d * s * 0.5, y: y - s * 0.16 },
        { x: x + d * s * 0.48, y: y + s * 0.12 }, { x: x + d * s * 0.32, y: y + s * 0.08 },
      ], 2.2, false, 0.4);
    }
  }
}

// ---------------------------------------------------------------------------
// 17. SPLIT HEAD
// ---------------------------------------------------------------------------
/** Seconds of held trigger before the skull opens all the way. */
const SPLIT_HOLD = 0.5;

/**
 * His head opens down the middle. What is inside is a machine: a lens that
 * cuts thin lines wherever you point, and - when the halves swing right out -
 * a rack of four very unfriendly missiles.
 */
export class SplitHead extends Weapon {
  readonly id = 17;
  readonly name = 'SPLIT HEAD';
  readonly tagline = 'a lens behind the face, and four in the rack';
  override auto = true;
  override cooldown = 0.13;

  /** 0..1 how far the skull is open. */
  private open = 0;
  private lens = 0;
  private volley = 0;
  private lensT = 0;

  override onEquip(): void { super.onEquip(); this.open = 0; this.lens = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.open = 0; }

  /** The weapon draws its own head for as long as there is a seam in it. */
  override get hidesHead(): boolean { return this.open > 0.02; }

  override get comboLabel(): string | null {
    return this.open > 0.7 && this.heldFor > SPLIT_HOLD ? 'RACK OPEN' : null;
  }

  /** The lens: a thin line, and it cuts a thin line. */
  protected release(ctx: WeaponCtx): void {
    this.cooldown = 0.13;
    this.timer = this.cooldown;
    this.startAnim(0.12);
    this.lens = 1;
    this.lensT = 0.1;
    const from = this.core(ctx);
    const a = this.aimFrom(ctx, from);
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = ctx.terrain.strikePoint(from.x, from.y, ca, sa, 1500, 4);
    ctx.sfx('beam', rand(1.5, 1.75));
    ctx.shake(2);
    ctx.sm.applyRecoil(0.14, a, 0);
    if (!hit) return;
    // A slot rather than a hole: it is a cutting beam, and it should read as
    // one against everything else in the arsenal that punches.
    ctx.terrain.carveCapsule(hit.x, hit.y, hit.x + ca * 46, hit.y + sa * 46, 6, 0.3, 34);
    ctx.particles.sparks(hit.x, hit.y, 3, 380, a + Math.PI, 2.2);
    ctx.particles.debris(hit.x, hit.y, 1, 200, a + Math.PI, 2);
  }

  protected override suppressFire(): boolean {
    return this.heldFor > SPLIT_HOLD;
  }

  protected override onLetGo(ctx: WeaponCtx): void {
    if (this.heldFor <= SPLIT_HOLD || this.open < 0.6) return;
    this.volley = 0.5;
    this.cooldown = 2.2;
    this.timer = this.cooldown;
    ctx.sfx('launch', 0.7);
    ctx.shake(12);
    ctx.flash(0.2);
    ctx.sm.applyRecoil(0.8, ctx.sm.pose.aim, 60);
    // Four, straight out of the open skull, and each one hits like a rocket.
    for (let i = 0; i < 4; i++) {
      ctx.after(i * 0.11, () => {
        const from = this.core(ctx);
        const a = this.aimFrom(ctx, from);
        const spread = (i - 1.5) * 0.4;
        ctx.projectiles.push(new Projectile({
          x: from.x, y: from.y,
          vx: Math.cos(a + spread) * 560, vy: Math.sin(a + spread) * 560 - 120,
          kind: 'missile', gravity: 0, radius: 8, life: 4,
          blast: { ...BLASTS.missile, radius: 62, debris: 44, bites: 9, flash: 0.4, shake: 16 },
          target: { x: ctx.aimPoint.x + rand(-70, 70), y: ctx.aimPoint.y + rand(-70, 70) },
          turn: 3.6, accel: 1600, topSpeed: 1500, arm: 0.1, weave: 0.18,
        }));
        ctx.sfx('launch', rand(1, 1.15));
        ctx.particles.smoke(from.x, from.y, 3, 7);
        ctx.shake(5);
      });
    }
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.lens = Math.max(0, this.lens - ctx.dt * 5);
    this.lensT = Math.max(0, this.lensT - ctx.dt);
    this.volley = Math.max(0, this.volley - ctx.dt);
    // Cracked open just enough for the lens while firing; right open while the
    // rack is loading, and shut again the moment nothing is happening.
    const want = this.volley > 0 ? 1
      : held && this.heldFor > SPLIT_HOLD ? 1
        : held || this.anim > 0 || this.timer > 0 ? 0.35
          : 0;
    this.open = damp(this.open, want, want > this.open ? 14 : 7, ctx.dt);
    if (held && this.heldFor > SPLIT_HOLD && this.open > 0.6) {
      ctx.shake(1.6);
      if (Math.random() < 0.3) {
        const p = this.core(ctx);
        ctx.particles.sparks(p.x, p.y, 1, 90, ctx.sm.pose.aim, 2);
      }
    }
  }

  /**
   * Half a skull: a dome from one side of the split round to the other, drawn
   * at `rot` about its own centre so it can swing open.
   */
  private halfHead(sk: Sketch, cx: number, cy: number, rot: number, top: boolean): void {
    const c = sk.ctx;
    const R = HEAD_R;
    const from = top ? Math.PI : 0;
    const pts: Vec2[] = [];
    for (let i = 0; i <= 10; i++) {
      const ang = from + (i / 10) * Math.PI;
      pts.push({ x: Math.cos(ang) * R * 1.04, y: Math.sin(ang) * R * 1.04 });
    }
    c.save();
    c.translate(cx, cy);
    c.rotate(rot);
    c.fillStyle = '#fff';
    sk.polyPath(pts, 1.1);
    c.fill();
    sk.poly(pts, 4.2, false, 1.1);
    // The cut face, so each half reads as a shell with a thickness.
    sk.line({ x: -R * 0.86, y: 0 }, { x: R * 0.86, y: 0 }, 3, 1, 0.5);
    c.restore();
  }

  /** The machine behind the face, which is where everything comes out of. */
  private core(ctx: WeaponCtx): Vec2 {
    const h = ctx.sm.pose.head;
    const f = ctx.sm.facing;
    return { x: h.x + f * HEAD_R * 0.45, y: h.y };
  }

  hands(ctx: WeaponCtx): HandTargets | null {
    if (this.open < 0.5) return null;
    // Head back, arms loose and low: the head is doing the work.
    const f = ctx.sm.facing;
    const a = ctx.sm.pose.aim;
    return { main: gripAt(ctx, a + 1.9 * f, 28, 0), off: gripAt(ctx, a - 1.9 * f, 28, 0) };
  }

  override stance(ctx: WeaponCtx): Stance | null {
    if (this.open < 0.5) return null;
    const k = clamp((this.open - 0.5) * 2, 0, 1);
    return ctx.sm.onGround
      ? { kind: 'brace', weight: k * 0.7, lean: -0.22, hip: -8 }
      : null;
  }

  draw(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const sm = ctx.sm;
    const f = sm.facing;
    const h = sm.pose.head;
    const a = sm.pose.aim;

    if (this.open <= 0.02) return;
    c.save();
    c.strokeStyle = '#000';
    c.lineJoin = 'round';

    // The skull comes apart across the middle: the lid hinges up and back and
    // the jaw drops, which is the drawing in the reference and also the only
    // split that leaves the machine between them visible from the side.
    const lift = this.open * HEAD_R * 2.05;
    // The dark of the inside, drawn first and left showing between the halves.
    // Without it the two domes close up into one slightly odd head.
    if (this.open > 0.08) {
      const g = lift * 0.78;
      c.fillStyle = '#000';
      sk.polyPath([
        { x: h.x - HEAD_R * 0.86, y: h.y - g },
        { x: h.x + HEAD_R * 0.86, y: h.y - g * 0.8 },
        { x: h.x + HEAD_R * 0.8, y: h.y + g * 0.8 },
        { x: h.x - HEAD_R * 0.8, y: h.y + g },
      ], 1.2);
      c.fill();
    }
    this.halfHead(sk, h.x - f * this.open * 8, h.y - lift, -f * this.open * 1.15, true);
    this.halfHead(sk, h.x + f * this.open * 4, h.y + lift * 0.5, f * this.open * 0.5, false);

    // The machine between them.
    const core = this.core(ctx);
    const k = this.open;
    c.fillStyle = '#fff';
    const box: Vec2[] = [];
    const bw = 8 + k * 4, bh = (3 + k * 7);
    for (const [dx, dy] of [[-bw, -bh], [bw, -bh * 0.7], [bw, bh * 0.7], [-bw, bh]] as const) {
      box.push({ x: core.x + Math.cos(a) * dx - Math.sin(a) * dy, y: core.y + Math.sin(a) * dx + Math.cos(a) * dy });
    }
    sk.polyPath(box, 1);
    c.fill();
    sk.poly(box, 3.2, false, 1);
    // The lens itself: a solid slot, brighter the moment it fires.
    c.fillStyle = '#000';
    const lens: Vec2[] = [];
    const lw = 3.5 + this.lens * 2, lh = bh * 0.55;
    for (const [dx, dy] of [[bw - lw, -lh], [bw, -lh * 0.8], [bw, lh * 0.8], [bw - lw, lh]] as const) {
      lens.push({ x: core.x + Math.cos(a) * dx - Math.sin(a) * dy, y: core.y + Math.sin(a) * dx + Math.cos(a) * dy });
    }
    sk.polyPath(lens, 0.6);
    c.fill();
    // Ribs down the seam, so it reads as machinery and not as a wound.
    c.lineWidth = 2;
    for (let i = -1; i <= 1; i++) {
      const dy = i * bh * 0.55;
      sk.line(
        { x: core.x - Math.cos(a) * bw - Math.sin(a) * dy, y: core.y - Math.sin(a) * bw + Math.cos(a) * dy },
        { x: core.x + Math.cos(a) * (bw * 0.4) - Math.sin(a) * dy, y: core.y + Math.sin(a) * (bw * 0.4) + Math.cos(a) * dy },
        2, 1, 0.35,
      );
    }

    // The shot, while it is going.
    if (this.lensT > 0) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const hit = ctx.terrain.strikePoint(core.x, core.y, ca, sa, 1500, 4);
      const len = hit ? Math.hypot(hit.x - core.x, hit.y - core.y) : 1500;
      c.lineWidth = 6;
      c.strokeStyle = '#fff';
      c.beginPath();
      c.moveTo(core.x, core.y);
      c.lineTo(core.x + ca * len, core.y + sa * len);
      c.stroke();
      c.lineWidth = 2.4;
      c.strokeStyle = '#000';
      c.beginPath();
      c.moveTo(core.x, core.y);
      c.lineTo(core.x + ca * len, core.y + sa * len);
      c.stroke();
      if (hit) {
        c.lineWidth = 2.6;
        sk.burst(hit.x, hit.y, 7, 7, 34, 2.6, 2.2, a + Math.PI, 9401);
      }
    }
    // Loading tell while the rack is open.
    if (this.open > 0.7 && this.heldFor > SPLIT_HOLD) {
      c.strokeStyle = '#000';
      c.lineWidth = 2;
      for (let i = 0; i < 2; i++) {
        const phase = (ctx.time * 2.6 + i / 2) % 1;
        sk.polyPath(ring(core.x, core.y, (1 - phase) * 40 + 6, 10, ctx.time * 2), 1.3);
        c.stroke();
      }
    }
    c.restore();
  }

  icon(sk: Sketch, x: number, y: number, s: number): void {
    const c = sk.ctx;
    // A head split down the middle with a lit slot between the halves.
    for (const d of [-1, 1]) {
      const pts: Vec2[] = [];
      for (let i = 0; i <= 9; i++) {
        const ang = Math.PI * (i / 9) * d - Math.PI / 2;
        pts.push({ x: x + Math.cos(ang) * s * 0.3, y: y + Math.sin(ang) * s * 0.3 + d * s * 0.14 });
      }
      sk.poly(pts, 2.6, false, 0.5);
    }
    c.fillStyle = c.strokeStyle as string;
    sk.polyPath([
      { x: x - s * 0.16, y: y - s * 0.07 }, { x: x + s * 0.3, y: y - s * 0.05 },
      { x: x + s * 0.3, y: y + s * 0.05 }, { x: x - s * 0.16, y: y + s * 0.07 },
    ], 0.7);
    c.fill();
    sk.line({ x: x + s * 0.32, y: y }, { x: x + s * 0.5, y: y }, 2.4, 1, 0.3);
  }
}
