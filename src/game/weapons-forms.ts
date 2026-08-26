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
  angleDelta, clamp, damp, easeOutCubic, hashNoise, lerp, quadPoint, rand, TAU,
  type Vec2,
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
  readonly name = 'MONSTER TAMER';
  readonly tagline = 'straight ahead, and it does not aim';
  override cooldown = 0.9;
  override chargeTime = 1.2;

  private shout = 0;
  private beamR = 0;
  /** 0..1 how far the thing behind him is out of the ground. */
  private rise = 0;
  private roar = 0;
  /** Where it currently is, which chases where it wants to be. */
  private beastX = 0;
  /** 0..1 how far it has ducked back under the floor to move. */
  private burrow = 0;
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
    this.burrow = 0;
    this.beastX = this.beastGoal(ctx);
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

    // It follows him. If he walks off, it drops back under the floor, moves,
    // and comes up again behind wherever he has got to - which is the whole
    // reason for summoning something that lives in the ground. The dip is what
    // sells it: the head sinks, travels, and breaks the surface again.
    const goal = this.beastGoal(ctx);
    const gap = goal - this.beastX;
    if (Math.abs(gap) > 40) {
      this.burrow = Math.min(1, this.burrow + ctx.dt * 2.4);
      this.beastX += clamp(gap, -520 * ctx.dt, 520 * ctx.dt) * this.burrow;
      if (this.burrow > 0.5 && Math.random() < 0.6) {
        ctx.particles.updraft(this.beastX + rand(-60, 60), ctx.sm.pos.y, 1, 30, 170);
      }
    } else {
      this.beastX += gap * Math.min(1, ctx.dt * 3);
      this.burrow = Math.max(0, this.burrow - ctx.dt * 2.2);
    }

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

  /** How tall and how wide the thing behind him gets, fully out of the floor. */
  private static readonly BEAST_H = 350;
  private static readonly BEAST_W = 152;

  /**
   * Where the thing is standing.
   *
   * It follows him. Not by teleporting to wherever he happens to be this
   * frame - it goes back under the floor and comes up again behind wherever he
   * has got to, so walking away from it buys you a second and then it is there
   * again. The composition the reference draws is the creature filling the
   * back of the frame with the figure small under its jaw, so it wants to be
   * close in, and the clamp keeps it on the paper.
   */
  private beastBase(ctx: WeaponCtx): Vec2 {
    return { x: this.beastX, y: ctx.sm.pos.y + 6 };
  }

  /** Where it is trying to get to: just behind him, and never off the paper. */
  private beastGoal(ctx: WeaponCtx): number {
    const f = ctx.sm.facing;
    return clamp(ctx.sm.pos.x - f * 96, 130, ctx.terrain.w - 130);
  }

  /** The gap between the two jaws, which is where its beam leaves it. */
  private beastMaw(ctx: WeaponCtx): Vec2 {
    const b = this.beastBase(ctx);
    const f = ctx.sm.facing;
    const up = easeOutCubic(this.rise);
    const W = Shout.BEAST_W * (0.5 + up * 0.5);
    return { x: b.x + f * W * 0.72, y: b.y - Shout.BEAST_H * up * 0.52 };
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
   * The thing under the floor.
   *
   * Copied off the frames rather than invented: it is a bulbous head-shaped
   * mass that comes up out of the ground, and the reference does not draw it
   * solid black - it *screens* it, in dots, with one heavy ragged outline
   * round the whole thing. On top of that grey there are exactly two features
   * and no others: a single round eye, dark with a white pupil in it, and a
   * maw that takes up the whole front of the head, its two jaws crowded with
   * long white teeth outlined in black. No horns, no second eye, no limbs.
   */
  private drawBeast(sk: Sketch, ctx: WeaponCtx): void {
    const c = sk.ctx;
    const f = ctx.sm.facing;
    const b = this.beastBase(ctx);
    // Ducking under to travel: the whole thing sinks, so what you see is the
    // head going down, moving, and breaking the surface again somewhere else.
    const up = easeOutCubic(this.rise) * (1 - this.burrow * 0.86);
    const H = Shout.BEAST_H * up;
    const W = Shout.BEAST_W * (0.5 + up * 0.5);
    if (H < 6) return;
    /** dx runs forward off its chest, dy runs up off the floor. */
    const at = (dx: number, dy: number): Vec2 => ({ x: b.x + f * dx * W, y: b.y - dy * H });

    // How far the jaws are apart. The mouth is not a shape laid over the head;
    // it is a wedge cut *out* of the front of it, which is why the reference's
    // creature reads as one mass with a bite taken out rather than as a head
    // with a mouth drawn on.
    const openK = this.roar > 0 ? 1 : clamp((up - 0.45) / 0.55, 0, 1);
    const g = (0.5 + 0.34 * this.power) * openK;
    const upperLip = at(0.96, 0.5 + 0.42 * g);
    const throat = at(-0.3, 0.48);
    const lowerLip = at(0.88, 0.5 - 0.36 * g);

    const outline: Vec2[] = [
      at(-1.04, 0), at(-1.14, 0.34), at(-1.02, 0.7), at(-0.72, 0.96),
      at(-0.28, 1.1), at(0.2, 1.08), at(0.6, 0.94),
      upperLip, throat, lowerLip,
      at(0.72, 0.18), at(0.54, 0),
    ];
    const body = outline.map((q, i) => ({
      x: q.x + hashNoise(i * 5, sk.boil) * 7,
      y: q.y + hashNoise(i * 9, sk.boil + 3) * 7,
    }));
    const trace = (): void => {
      c.beginPath();
      c.moveTo(body[0].x, body[0].y);
      for (let i = 1; i < body.length; i++) c.lineTo(body[i].x, body[i].y);
      c.closePath();
    };

    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // --- the body ------------------------------------------------------------
    //
    // It is not a head on a stick. Under the skull there is a neck, a pair of
    // shoulders and two clawed forelimbs hauling the rest of it up out of the
    // hole, and the further it climbs the more of that you see. Drawn first
    // and in the same tone, so the head sits on top of a mass rather than
    // floating over one.
    // Two of them: one hauling on the lip of the hole out in front, one
    // braced behind. Each is a tapered band bent through an elbow, in the same
    // tone as the mass, with three claws dug in at the end.
    const limbs: readonly (readonly [number, number, number, number, number, number, number])[] = [
      // rootX rootY elbowX elbowY clawX clawY thickness
      [0.6, 0.4, 1.55, 0.66, 2.05, 0.04, 0.27],
      [-0.74, 0.4, -1.32, 0.5, -1.6, 0.03, 0.22],
    ];
    for (const [rx, ry, ex, ey, cx2, cy2, th] of limbs) {
      const root = at(rx, ry), elbow = at(ex, ey), claw = at(cx2, cy2);
      const N = 12;
      const top: Vec2[] = [], bot: Vec2[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p0 = quadPoint(root, elbow, claw, t);
        const p1 = quadPoint(root, elbow, claw, Math.min(1, t + 0.05));
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const l = Math.hypot(dx, dy) || 1;
        const wdt = W * th * (1 - t * 0.42);
        top.push({ x: p0.x - (dy / l) * wdt, y: p0.y + (dx / l) * wdt });
        bot.push({ x: p0.x + (dy / l) * wdt, y: p0.y - (dx / l) * wdt });
      }
      c.beginPath();
      c.moveTo(top[0].x, top[0].y);
      for (const p0 of top) c.lineTo(p0.x, p0.y);
      for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i].x, bot[i].y);
      c.closePath();
      c.fillStyle = '#fff';
      c.fill();
      c.fillStyle = sk.screenTone();
      c.fill();
      c.strokeStyle = '#000';
      c.lineWidth = 4.6;
      c.stroke();
      // Claws, dug into the lip of the hole and pointing the way it is pulling.
      const back = { x: claw.x - elbow.x, y: claw.y - elbow.y };
      const bl = Math.hypot(back.x, back.y) || 1;
      for (let i = -1; i <= 1; i++) {
        const o = i * W * th * 0.6;
        const from = { x: claw.x - (back.y / bl) * o, y: claw.y + (back.x / bl) * o };
        sk.line(from,
          { x: from.x + (back.x / bl) * W * 0.4, y: from.y + (back.y / bl) * W * 0.4 },
          3.4, 2, 0.8);
      }
    }

    // Paper first so the tone reads over the black wall too, then screen tone
    // poured into the same path, then one heavy ragged line round the lot.
    trace();
    c.fillStyle = '#fff';
    c.fill();
    c.fillStyle = sk.screenTone();
    c.fill();
    trace();
    c.strokeStyle = '#000';
    c.lineWidth = 5.5;
    c.stroke();

    // The seam where the skull sits on the shoulders, so the two read as two.
    c.strokeStyle = '#000';
    sk.curve(at(-1.0, 0.4), at(-0.1, 0.28), at(0.62, 0.36), 4, 1.4);

    // --- the eye: dark socket, white pupil, and nothing else on the face ----
    const eye = at(0.12, 0.9);
    const er = W * 0.17;
    c.fillStyle = '#000';
    sk.polyPath(ring(eye.x, eye.y, er, 11, 0.4), 1.4);
    c.fill();
    c.fillStyle = '#fff';
    sk.polyPath(ring(eye.x + f * er * 0.22, eye.y - er * 0.1, er * 0.44, 9, 1.1), 0.9);
    c.fill();

    // --- teeth ---------------------------------------------------------------
    //
    // Long white spikes off both edges of the wedge, leaning back down the
    // jaw, every one of them outlined. They are the only white left inside the
    // grey and that contrast is the whole read of the thing.
    if (g > 0.05) {
      const centre = { x: (upperLip.x + lowerLip.x) * 0.5, y: (upperLip.y + lowerLip.y) * 0.5 };
      const fangs = (from: Vec2, to: Vec2, seed: number): void => {
        const dx = to.x - from.x, dy = to.y - from.y;
        const l = Math.hypot(dx, dy) || 1;
        // Into the mouth, whichever side of this edge that turns out to be.
        let nx = -dy / l, ny = dx / l;
        if ((centre.x - from.x) * nx + (centre.y - from.y) * ny < 0) { nx = -nx; ny = -ny; }
        const n = 6;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const root = { x: from.x + dx * t, y: from.y + dy * t };
          const half = (l / n) * 0.42;
          // Longest at the hinge end, and every one a different length.
          const len = H * 0.13 * (0.55 + (1 - t) * 0.7)
            * (0.72 + Math.abs(hashNoise(seed + i * 7, sk.boil)) * 0.5);
          const tip = {
            x: root.x + nx * len + (dx / l) * len * 0.42,
            y: root.y + ny * len + (dy / l) * len * 0.42,
          };
          c.beginPath();
          c.moveTo(root.x - (dx / l) * half, root.y - (dy / l) * half);
          c.lineTo(tip.x, tip.y);
          c.lineTo(root.x + (dx / l) * half, root.y + (dy / l) * half);
          c.closePath();
          c.fillStyle = '#fff';
          c.fill();
          c.strokeStyle = '#000';
          c.lineWidth = 3;
          c.stroke();
        }
      };
      fangs(upperLip, throat, 91);
      fangs(lowerLip, throat, 137);
    }

    // Chunks of floor still coming up with it while it climbs.
    if (up < 1) {
      c.fillStyle = '#000';
      sk.tuftPath(b.x, b.y, 11, W * 0.5, W * (0.7 + up * 0.6), 1.9, -Math.PI / 2, 9001, 0.08);
      c.fill();
    }
    c.restore();
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
      const r = (34 + 26 * this.power) * (0.55 + k * 0.55);
      const ca = Math.cos(this.dir), sa = Math.sin(this.dir);
      const front = ctx.terrain.strikePoint(from.x, from.y, ca, sa, 1800, 6);
      const len = front ? Math.hypot(front.x - from.x, front.y - from.y) + r : 1800;
      c.save();
      const L = Math.max(60, len);
      beamBand(sk, from, this.dir, L, r, 0.7);
      // What makes the reference's roar a roar and not a plank of light: the
      // whole length of it is feathered with heavy ink spikes flicked off both
      // edges, thinning as they go, and a torn clump at the mouth.
      c.fillStyle = '#000';
      for (let i = 0; i < 9; i++) {
        const t = 0.04 + (i / 8) * 0.92;
        const w = r * (0.7 + t * 0.9);
        for (const side of [-1, 1]) {
          const px = from.x + ca * L * t - sa * w * side;
          const py = from.y + sa * L * t + ca * w * side;
          sk.tuftPath(px, py, 5, 2, r * (0.9 - t * 0.4), 1.5,
            this.dir + side * Math.PI * 0.5, 9110 + i * 7 + side, 0.075);
          c.fill();
        }
      }
      sk.tuftPath(from.x, from.y, 15, r * 0.8, r * 2.4, 3.0, this.dir, 9102, 0.08);
      c.fill();
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
  readonly name = 'GIANT ROBOT';
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

  /**
   * Where the eyes are looking.
   *
   * Not simply "at the crosshair". The machine's head rides two and a half
   * bodies up, far above where the pointer naturally sits, so taking the raw
   * angle from there to the cursor sent the beams back over its own shoulder
   * as soon as the crosshair was anywhere near his feet. A head that size
   * turns to look: the aim only picks a direction *within the arc it can turn
   * to*, which is a shallow cone the way it happens to be facing, and the wall
   * is always inside that cone.
   */
  private beamAngle(ctx: WeaponCtx): number {
    const head = this.big(ctx, ctx.sm.pose.head);
    const forward = ctx.sm.facing > 0 ? 0 : Math.PI;
    const raw = Math.atan2(ctx.aimPoint.y - head.y, ctx.aimPoint.x - head.x);
    return forward + clamp(angleDelta(forward, raw), -0.42, 0.42);
  }

  /** Two thin beams out of the head, into whatever it has turned to look at. */
  private burnEyes(ctx: WeaponCtx): void {
    const head = this.big(ctx, ctx.sm.pose.head);
    const a = this.beamAngle(ctx);
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
    // Standing, the machine's arms hang down and *out*, clear of the chest,
    // the way a suit with a barrel for a torso has to hold them. Boxing them
    // up in front put both mitts over its own visor.
    // Wide, not just down. The drawn shoulders sit out at the edge of a barrel
    // of a torso, so hand targets near his spine dragged both arms diagonally
    // back across the chest and buried the ribbed panel behind them.
    return {
      main: gripAt(ctx, Math.PI / 2, 38, -f * 40),
      off: gripAt(ctx, Math.PI / 2, 36, f * 34),
    };
  }

  // ---------------------------------------------------------------- drawing ---

  /**
   * One limb segment.
   *
   * The machine in the reference is not built out of angular plates - it is
   * built out of *tubes*: rounded capsules stacked two and three deep down
   * each arm and leg, like a diving suit, with a thin even line round each
   * one and nothing filled in. Getting this wrong is what made the last pass
   * read as a robot from a different film, so this draws the stadium the
   * reference draws and nothing more elaborate.
   */
  private tube(sk: Sketch, a: Vec2, b: Vec2, r0: number, r1: number, line = 2.6): void {
    const c = sk.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const an = Math.atan2(dx / len, -dy / len);
    const pts: Vec2[] = [];
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = an - Math.PI * (i / N);
      pts.push({ x: b.x + Math.cos(t) * r1, y: b.y + Math.sin(t) * r1 });
    }
    for (let i = 0; i <= N; i++) {
      const t = an - Math.PI - Math.PI * (i / N);
      pts.push({ x: a.x + Math.cos(t) * r0, y: a.y + Math.sin(t) * r0 });
    }
    c.fillStyle = '#fff';
    sk.polyPath(pts, 0.9);
    c.fill();
    sk.poly(pts, line, false, 0.9);
  }

  /**
   * A limb the way the reference builds one: two *fat* segments and a block on
   * the end of them.
   *
   * The two things that were wrong before are both here. The segments were
   * thin - in the source a forearm is very nearly as thick as it is long, and
   * the whole machine reads as chunky because of it. And the ends were balls:
   * a circle at the wrist and a circle at the ankle, which is exactly what a
   * mech does *not* have. What goes on the end is a rounded block carrying on
   * in the direction the limb was already going - a fist, or a boot.
   *
   * `endDir`, when given, turns that block a different way: a foot points
   * forward off the shin rather than carrying straight on down it.
   */
  private limb(
    sk: Sketch, a: Vec2, b: Vec2, c2: Vec2, r: number, mitt: number, endDir?: Vec2,
  ): void {
    this.tube(sk, a, b, r * 1.16, r * 0.98);
    this.tube(sk, b, c2, r * 1.02, r * 0.92);
    if (mitt <= 0) return;
    // Which way the block on the end runs.
    let dx = endDir ? endDir.x : c2.x - b.x;
    let dy = endDir ? endDir.y : c2.y - b.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const tip = { x: c2.x + dx * mitt * 0.9, y: c2.y + dy * mitt * 0.9 };
    this.tube(sk, c2, tip, mitt, mitt * 0.92);
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
    const q = (v: Vec2): Vec2 => {
      const w = B(v);
      return { x: w.x, y: sm.pos.y - (sm.pos.y - w.y) * k };
    };

    c.save();
    c.strokeStyle = '#000';
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // The machine's arms are longer than his are - they hang past the hip
    // instead of folding up over the chest, which is what a barrel of a torso
    // forces. Both joints are pushed out along the line of his own arm.
    const REACH = 1.28;
    // His shoulders sit a few units either side of his spine. The machine's
    // torso is a barrel five times that wide, so the arms have to be hung off
    // the *edge* of it - hanging them off his skeleton's shoulders ran both
    // limbs straight down the front of the chest and buried the whole torso.
    const SPAN = 30;
    const shoulder = (sh: Vec2, out: number): Vec2 => {
      const p0 = q(sh);
      return { x: p0.x + f * out * SPAN, y: p0.y - 4 };
    };
    const arm = (sh: Vec2, jt: Vec2, out: number): Vec2 => {
      const a0 = shoulder(sh, out), a1 = q(jt);
      return { x: a0.x + (a1.x - a0.x) * REACH, y: a0.y + (a1.y - a0.y) * REACH };
    };

    // Back limbs first, a shade thinner so the near side reads in front.
    this.limb(sk, q(p.hipL), q(p.kneeL), q(p.footL), 27, 25, { x: f * 1, y: 0.12 });
    this.limb(sk, shoulder(p.shL, -0.9), arm(p.shL, p.elbowL, -0.9), arm(p.shL, p.handL, -0.9), 23, 23);

    // --- torso: a barrel with a ribbed panel down the front of it ----------
    const chest = q(p.chest), pelvis = q(p.pelvis), neck = q(p.neck);
    this.tube(sk, neck, chest, 42, 54, 3);
    this.tube(sk, chest, pelvis, 52, 34, 3);
    // The ribs. Five short bars stacked down the middle of the chest is the
    // single most recognisable thing about this machine.
    c.strokeStyle = '#000';
    const ribs = 5;
    for (let i = 0; i < ribs; i++) {
      const t = 0.12 + (i / (ribs - 1)) * 0.72;
      const cx = lerp(chest.x, pelvis.x, t) + f * 4;
      const cy = lerp(chest.y, pelvis.y, t);
      const w = 15 * (1 - t * 0.35);
      sk.line({ x: cx - w, y: cy }, { x: cx + w, y: cy }, 2.4, 1, 0.5);
    }

    // --- pauldrons: rounded caps sitting over the shoulders ----------------
    for (const [sh, out] of [[p.shL, -0.9], [p.shR, 0.85]] as const) {
      const s2 = shoulder(sh, out);
      this.tube(sk, { x: s2.x - f * 8, y: s2.y - 12 }, { x: s2.x + f * 12, y: s2.y + 12 }, 30, 26, 3);
    }

    // --- the near leg ------------------------------------------------------
    this.limb(sk, q(p.hipR), q(p.kneeR), q(p.footR), 30, 28, { x: f * 1, y: 0.12 });

    // --- the helmet --------------------------------------------------------
    //
    // Low and wide, sunk into the shoulders with no neck showing: a dome
    // split by a seam down the middle, two bolts either side of it, a brim,
    // and one solid black visor band under the brim. That band is the only
    // filled shape on the whole machine.
    const h = q(p.head);
    const R = HEAD_R * this.scale * 1.42 * (0.4 + k * 0.6);
    const dome: Vec2[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI + (i / 14) * Math.PI;
      dome.push({ x: h.x + Math.cos(a) * R * 1.06, y: h.y + Math.sin(a) * R * 0.86 });
    }
    dome.push({ x: h.x + R * 1.02, y: h.y + R * 0.3 });
    dome.push({ x: h.x - R * 1.02, y: h.y + R * 0.3 });
    c.fillStyle = '#fff';
    sk.polyPath(dome, 1);
    c.fill();
    sk.poly(dome, 3, false, 1);
    // Seam and bolts.
    sk.line({ x: h.x + f * 2, y: h.y - R * 0.84 }, { x: h.x + f * 2, y: h.y - R * 0.1 }, 3, 1, 0.5);
    for (const d of [-1, 1]) {
      sk.polyPath(ring(h.x + d * R * 0.34 + f * 2, h.y - R * 0.44, R * 0.11, 8, 0), 0.5);
      c.stroke();
      sk.polyPath(ring(h.x + d * R * 0.34 + f * 2, h.y - R * 0.2, R * 0.11, 8, 0), 0.5);
      c.stroke();
    }
    // Brim, then the visor band under it, then the jaw plate.
    this.tube(sk, { x: h.x - R * 1.06, y: h.y + R * 0.04 }, { x: h.x + R * 1.06, y: h.y }, 6, 6, 2.6);
    c.fillStyle = '#000';
    sk.polyPath([
      { x: h.x - R * 0.9, y: h.y + R * 0.2 }, { x: h.x + R * 0.9, y: h.y + R * 0.16 },
      { x: h.x + R * 0.88, y: h.y + R * 0.56 }, { x: h.x - R * 0.88, y: h.y + R * 0.6 },
    ], 0.8);
    c.fill();
    this.tube(sk, { x: h.x - R * 0.72, y: h.y + R * 0.82 }, { x: h.x + R * 0.72, y: h.y + R * 0.8 }, 11, 11, 2.6);

    // --- the near arm, and whatever it is currently being ------------------
    if (this.phase === 'aim' || this.phase === 'volley') {
      // The forearm folded into a launcher: the tubes stay, a squared muzzle
      // block goes on the end of them.
      const e = arm(p.shR, p.elbowR, 0.85), hd = arm(p.shR, p.handR, 0.85);
      this.tube(sk, shoulder(p.shR, 0.85), e, 25, 21, 2.8);
      const dx = hd.x - e.x, dy = hd.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const tip = { x: hd.x + (dx / len) * 40, y: hd.y + (dy / len) * 40 };
      this.tube(sk, e, tip, 22, 25, 2.8);
      const nx = -dy / len, ny = dx / len;
      for (let i = -1; i <= 1; i++) {
        sk.line(
          { x: tip.x + nx * i * 9, y: tip.y + ny * i * 9 },
          { x: tip.x + (dx / len) * 9 + nx * i * 9, y: tip.y + (dy / len) * 9 + ny * i * 9 },
          3.2, 1, 0.4,
        );
      }
      if (this.muzzleT > 0) {
        c.fillStyle = '#000';
        sk.tuftPath(tip.x, tip.y, 9, 8, 58, 1.5, Math.atan2(dy, dx), 9201, 0.08);
        c.fill();
      }
    } else {
      this.limb(sk, shoulder(p.shR, 0.85), arm(p.shR, p.elbowR, 0.85), arm(p.shR, p.handR, 0.85), 25, 26);
      // The shock coming off the mitt, as thin spikes and not as a starburst.
      if (this.punch > 0.02) {
        const hd = arm(p.shR, p.handR, 0.85);
        c.fillStyle = '#000';
        sk.tuftPath(hd.x, hd.y, 9, 22, 22 + 58 * this.punch, 2.0,
          f > 0 ? 0 : Math.PI, 9202, 0.075);
        c.fill();
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
      const a = this.beamAngle(ctx);
      const ca = Math.cos(a), sa = Math.sin(a);
      const hit = ctx.terrain.strikePoint(head.x, head.y, ca, sa, 1600, 5);
      const len = hit ? Math.hypot(hit.x - head.x, hit.y - head.y) : 1600;
      const land = { x: head.x + ca * len, y: head.y + sa * len };
      c.save();
      // The reference's mech does not fire a rope of light. It draws two hair
      // lines from the two eyes that *converge* on one spot, and a small tuft
      // of spikes where they meet the wall - and that is the whole effect.
      const nx = -sa, ny = ca;
      for (const d of [-11, 11]) {
        const from = { x: head.x + nx * d, y: head.y + ny * d };
        c.strokeStyle = '#fff';
        c.lineWidth = 5;
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(land.x, land.y);
        c.stroke();
        c.strokeStyle = '#000';
        c.lineWidth = 1.8;
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(land.x, land.y);
        c.stroke();
      }
      if (hit) {
        c.fillStyle = '#000';
        sk.tuftPath(land.x, land.y, 11, 5, 34, 2.6, a + Math.PI, 9301, 0.08);
        c.fill();
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
/** Half-width of the cutting beam. It is meant to be seen from across the room. */
const BEAM_HALF = 17;

/**
 * His head opens down the middle. What is inside is a machine: a lens that
 * cuts thin lines wherever you point, and - when the halves swing right out -
 * a rack of four very unfriendly missiles.
 */
export class SplitHead extends Weapon {
  readonly id = 17;
  readonly name = 'SPLIT HEAD';
  readonly tagline = 'four in the rack, and a torch behind them';
  override auto = true;
  override cooldown = 1.5;

  /** 0..1 how far the skull is open. */
  private open = 0;
  private lens = 0;
  private volley = 0;
  private lensT = 0;
  /** 0..1 how far the split has turned from the hatch into the full opening. */
  private wide = 0;
  /** Seconds of beam still running, and where it is pointing. */
  private beamT = 0;
  private beamAngle = 0;
  private beamLen = 0;
  private sfxT = 0;

  override onEquip(): void { super.onEquip(); this.open = 0; this.lens = 0; }
  override onUnequip(ctx: WeaponCtx): void { super.onUnequip(ctx); this.open = 0; }

  /** The weapon draws its own head for as long as there is a seam in it. */
  override get hidesHead(): boolean { return this.open > 0.02; }

  override get comboLabel(): string | null {
    if (this.beamT > 0) return 'CUTTING';
    return this.volley > 0 ? 'RACK OPEN' : null;
  }

  /**
   * A press is the rack: the face hinges apart on the seam across the middle
   * and four of them leave the hole. This used to be the held move and the
   * lasers were the tap, which had it exactly backwards - what you reach for
   * on a click should be the thing the slot is *for*.
   */
  protected release(ctx: WeaponCtx): void {
    this.volley = 0.8;
    this.cooldown = 1.5;
    this.timer = this.cooldown;
    this.startAnim(0.5);
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

  protected override suppressFire(): boolean {
    return this.heldFor > SPLIT_HOLD || this.beamT > 0;
  }

  /**
   * Held, the skull comes apart the *other* way - straight down the middle,
   * both halves swinging out sideways - and what stands in the gap pours a
   * cutting beam out until he lets go. Same machine, a different door, and a
   * beam thick enough to be worth opening the whole face for.
   */
  private runBeam(ctx: WeaponCtx): void {
    const from = this.core(ctx);
    const a = this.aimFrom(ctx, from);
    const ca = Math.cos(a), sa = Math.sin(a);
    this.beamAngle = a;
    const hit = ctx.terrain.strikePoint(from.x, from.y, ca, sa, 1600, 4);
    this.beamLen = hit ? Math.hypot(hit.x - from.x, hit.y - from.y) : 1600;
    ctx.shake(2.6);
    this.sfxT -= ctx.dt;
    if (this.sfxT <= 0) { ctx.sfx('beam', rand(0.85, 1)); this.sfxT = 0.22; }
    if (!hit) return;
    // A slot rather than a hole: it is a cutting beam, and it reads as one
    // against everything else in the arsenal that punches.
    ctx.terrain.carveCapsule(hit.x, hit.y, hit.x + ca * 70, hit.y + sa * 70,
      BEAM_HALF, 0.34, 320 * ctx.dt);
    ctx.particles.sparks(hit.x, hit.y, 2, 380, a + Math.PI, 2.2);
    if (Math.random() < 0.4) ctx.particles.debris(hit.x, hit.y, 1, 220, a + Math.PI, 2);
  }

  protected override tick(ctx: WeaponCtx, held: boolean): void {
    this.lens = Math.max(0, this.lens - ctx.dt * 5);
    this.lensT = Math.max(0, this.lensT - ctx.dt);
    this.volley = Math.max(0, this.volley - ctx.dt);
    this.beamT = Math.max(0, this.beamT - ctx.dt);

    const cutting = held && this.heldFor > SPLIT_HOLD;
    if (cutting) { this.beamT = 0.09; this.runBeam(ctx); }

    // Cracked open for a salvo, and right open the other way for the beam.
    const want = this.beamT > 0 ? 1
      : this.volley > 0 ? 1
        : held || this.anim > 0 || this.timer > 0 ? 0.4
          : 0;
    this.open = damp(this.open, want, want > this.open ? 14 : 7, ctx.dt);
    // Which door: the seam across the middle, or the split down it.
    this.wide = damp(this.wide, this.beamT > 0 ? 1 : 0, 12, ctx.dt);
  }

  /**
   * Half a skull: a dome from one side of the split round to the other, drawn
   * at `rot` about its own centre so it can swing open.
   */
  private halfHead(sk: Sketch, cx: number, cy: number, rot: number, top: boolean, R = HEAD_R): void {
    const c = sk.ctx;
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

    // Two doors, and which one is open says what is about to come out.
    //
    // For a salvo the skull hinges apart on the seam across the middle: the
    // lid tips up and back, the jaw drops, and the rack shows between them.
    // For the beam it comes apart the other way entirely - straight down the
    // middle, both halves swinging out sideways - so the machine is standing
    // in a doorway rather than peering out of a slot.
    const w = this.wide;
    // The skull swells as it comes apart. A head this size split down the
    // middle is four pixels of daylight; letting it grow while it opens is
    // what makes the machinery inside legible at all.
    const R = HEAD_R * (1 + this.open * 0.45);
    c.fillStyle = '#000';
    if (w < 0.5) {
      // The seam across the middle. The dark of the inside goes down first and
      // is left showing between the halves; without it the two domes close up
      // into one slightly odd head.
      const lift = this.open * R * 2.05;
      const g = lift * 0.78;
      if (this.open > 0.08) {
        sk.polyPath([
          { x: h.x - R * 0.86, y: h.y - g },
          { x: h.x + R * 0.86, y: h.y - g * 0.8 },
          { x: h.x + R * 0.8, y: h.y + g * 0.8 },
          { x: h.x - R * 0.8, y: h.y + g },
        ], 1.2);
        c.fill();
      }
      this.halfHead(sk, h.x - f * this.open * 8, h.y - lift, -f * this.open * 1.15, true, R);
      this.halfHead(sk, h.x + f * this.open * 4, h.y + lift * 0.5, f * this.open * 0.5, false, R);
    } else {
      // Straight down the middle: both halves swing out sideways and turn
      // their cut faces to us, and what stands in the gap is a doorway rather
      // than a slot.
      const part = this.open * R * 1.45;
      if (this.open > 0.08) {
        sk.polyPath([
          { x: h.x - part * 0.72, y: h.y - R * 0.94 },
          { x: h.x + part * 0.72, y: h.y - R * 0.9 },
          { x: h.x + part * 0.72, y: h.y + R * 0.9 },
          { x: h.x - part * 0.72, y: h.y + R * 0.94 },
        ], 1.2);
        c.fill();
      }
      this.halfHead(sk, h.x - part, h.y, -Math.PI / 2 - this.open * 0.34, true, R);
      this.halfHead(sk, h.x + part, h.y, Math.PI / 2 + this.open * 0.34, true, R);
    }

    // The machine between them.
    const core = this.core(ctx);
    const k = this.open;
    c.fillStyle = '#fff';
    const box: Vec2[] = [];
    const bw = 9 + k * 6, bh = (3 + k * 10);
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

    // The beam. Not the hairline it was: a band you could put your arm in,
    // with a torn mouth on it and the wall coming apart where it lands.
    if (this.beamT > 0) {
      const ba = this.beamAngle;
      const ca = Math.cos(ba), sa = Math.sin(ba);
      const end = { x: core.x + ca * this.beamLen, y: core.y + sa * this.beamLen };
      beamBand(sk, core, ba, this.beamLen, BEAM_HALF, 0.6);
      // Chevrons running down it, so it plainly has something travelling in it.
      c.strokeStyle = '#000';
      for (let i = 0; i < 5; i++) {
        const d = (ctx.time * 1100 + i * 240) % Math.max(1, this.beamLen);
        const p = (dd: number, o: number): Vec2 =>
          ({ x: core.x + ca * dd - sa * o, y: core.y + sa * dd + ca * o });
        sk.line(p(d, -BEAM_HALF * 0.7), p(d + BEAM_HALF * 0.7, 0), 2.2, 1, 1);
        sk.line(p(d + BEAM_HALF * 0.7, 0), p(d, BEAM_HALF * 0.7), 2.2, 1, 1);
      }
      c.fillStyle = '#000';
      sk.tuftPath(end.x, end.y, 13, BEAM_HALF * 0.6, BEAM_HALF * 3.4, 2.7,
        ba + Math.PI, 9401, 0.055);
      c.fill();
      sk.tuftPath(core.x, core.y, 9, BEAM_HALF * 0.8, BEAM_HALF * 2, TAU, 0, 9402, 0.07);
      c.fill();
    }
    // Loading tell while the rack is coming open.
    if (this.volley > 0) {
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
