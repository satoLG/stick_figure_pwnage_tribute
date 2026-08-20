import {
  clamp, damp, dampAngle, hashNoise, lerp, rotate, solveIK, TAU, vec, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Terrain } from './terrain';

// --- proportions, in world units -------------------------------------------
const THIGH = 31, SHIN = 31;
const UPPER_ARM = 25, FOREARM = 25;
/** Full arm span; weapons size their grips against this. */
export const ARM_LEN = UPPER_ARM + FOREARM;
const TORSO = 46;
const NECK = 12;
export const HEAD_R = 15;
const HALF_W = 11;
const STAND_HIP = 57;
const CROUCH_HIP = 36;
export const BODY_H = STAND_HIP + TORSO + NECK + HEAD_R * 2;

// --- movement tuning --------------------------------------------------------
const RUN_SPEED = 330;
const AIR_SPEED = 300;
const ACCEL = 2900;
const AIR_ACCEL = 1700;
const FRICTION = 3400;
const GRAVITY = 1980;
const JUMP_V = 620;
const AIR_JUMP_V = 560;
const MAX_FALL = 1250;
const COYOTE = 0.11;
const JUMP_BUFFER = 0.13;
const WALL_SLIDE_V = 190;
const STRIDE = 52;

export interface Pose {
  pelvis: Vec2; chest: Vec2; neck: Vec2; head: Vec2;
  hipL: Vec2; kneeL: Vec2; footL: Vec2;
  hipR: Vec2; kneeR: Vec2; footR: Vec2;
  shL: Vec2; elbowL: Vec2; handL: Vec2;
  shR: Vec2; elbowR: Vec2; handR: Vec2;
  facing: number; aim: number; bodyAngle: number;
}

export interface HandTargets {
  /** Weapon-side hand (drawn in front). */
  main: Vec2;
  /** Support hand; null leaves the off arm free to swing. */
  off: Vec2 | null;
}

export type MoveState = 'idle' | 'run' | 'jump' | 'fall' | 'wallslide' | 'crouch';

/**
 * The player character. There is not a single sprite or keyframe in here: every
 * joint is solved each frame from the movement state, so the figure reacts to
 * slopes, rubble, recoil and landings instead of playing back a fixed clip.
 */
export class Stickman {
  /** Origin sits at the feet, which makes ground collision trivial. */
  pos: Vec2 = vec(220, 400);
  vel: Vec2 = vec(0, 0);

  onGround = false;
  onWall = 0;              // -1 wall on the left, +1 on the right, 0 none
  facing = 1;
  crouching = false;

  private coyote = 0;
  private jumpBuffer = 0;
  private airJumps = 1;
  private maxAirJumps = 1;

  // --- animation state (all spring-damped, nothing ever snaps) --------------
  gait = 0;
  private hipH = STAND_HIP;
  private lean = 0;
  private bodyAngle = 0;      // used by the flip on the second jump
  private flipSpin = 0;
  private squash = 0;         // landing compression
  private breathe = 0;
  private headTilt = 0;
  aim = 0;
  private aimVisual = 0;
  private recoil = 0;
  private recoilAngle = 0;
  private handMain: Vec2 = vec(0, 0);
  private handOff: Vec2 = vec(0, 0);
  private handMainSet = false;
  private handOffSet = false;
  private weaponBlend = 0;
  private fallTime = 0;
  private wasOnGround = true;
  private landImpact = 0;

  state: MoveState = 'idle';
  /** Set by game.ts when a landing should make noise. */
  justLanded = false;
  justJumped = false;

  pose: Pose = blankPose();

  reset(x: number, y: number): void {
    this.pos = vec(x, y);
    this.vel = vec(0, 0);
    this.onGround = false;
    this.gait = 0;
    this.lean = 0;
    this.bodyAngle = 0;
    this.flipSpin = 0;
    this.squash = 0;
    this.recoil = 0;
    this.airJumps = this.maxAirJumps;
  }

  // ------------------------------------------------------------- physics ---

  update(dt: number, terrain: Terrain, ctrl: {
    left: boolean; right: boolean; up: boolean; down: boolean; jump: boolean; jumpHeld: boolean;
  }, aimTarget: Vec2): void {
    this.justLanded = false;
    this.justJumped = false;

    const dir = (ctrl.right ? 1 : 0) - (ctrl.left ? 1 : 0);
    this.crouching = ctrl.down && this.onGround;

    // --- horizontal acceleration ------------------------------------------
    const topSpeed = (this.onGround ? RUN_SPEED : AIR_SPEED) * (this.crouching ? 0.45 : 1);
    const accel = this.onGround ? ACCEL : AIR_ACCEL;
    if (dir !== 0) {
      this.vel.x += dir * accel * dt;
      this.vel.x = clamp(this.vel.x, -topSpeed, topSpeed);
    } else if (this.onGround) {
      const f = FRICTION * dt;
      this.vel.x = Math.abs(this.vel.x) <= f ? 0 : this.vel.x - Math.sign(this.vel.x) * f;
    } else {
      this.vel.x *= Math.exp(-0.9 * dt);
    }

    // --- jumping, with coyote time and an input buffer ---------------------
    if (ctrl.jump) this.jumpBuffer = JUMP_BUFFER;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.onGround ? COYOTE : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0) {
      if (this.coyote > 0) {
        this.vel.y = -JUMP_V;
        this.jumpBuffer = 0; this.coyote = 0;
        this.onGround = false;
        this.justJumped = true;
        this.squash = -0.5;
      } else if (this.onWall !== 0) {
        // Wall jump: kick away from the surface, the classic stick-fight move.
        this.vel.y = -JUMP_V * 0.94;
        this.vel.x = -this.onWall * RUN_SPEED * 1.05;
        this.jumpBuffer = 0;
        this.airJumps = this.maxAirJumps;
        this.justJumped = true;
        this.flipSpin = -this.onWall * TAU;
      } else if (this.airJumps > 0) {
        this.airJumps--;
        this.vel.y = -AIR_JUMP_V;
        this.jumpBuffer = 0;
        this.justJumped = true;
        // A full somersault on the second jump.
        this.flipSpin = (this.vel.x >= 0 ? 1 : -1) * TAU;
      }
    }
    // Variable jump height: releasing early cuts the rise.
    if (!ctrl.jumpHeld && this.vel.y < -180) this.vel.y += GRAVITY * 1.6 * dt;

    // --- gravity, with a slower rise for a floatier apex -------------------
    const g = this.vel.y < 0 ? GRAVITY * 0.86 : GRAVITY;
    this.vel.y = Math.min(MAX_FALL, this.vel.y + g * dt);

    if (this.onWall !== 0 && this.vel.y > 0 && dir === this.onWall) {
      this.vel.y = Math.min(this.vel.y, WALL_SLIDE_V);
    }

    // --- integrate against the terrain bitmap ------------------------------
    this.wasOnGround = this.onGround;
    this.moveX(this.vel.x * dt, terrain);
    this.moveY(this.vel.y * dt, terrain);
    this.detectWall(terrain);

    if (this.onGround) {
      this.airJumps = this.maxAirJumps;
      this.fallTime = 0;
      if (!this.wasOnGround) {
        this.justLanded = true;
        this.landImpact = clamp(this.landVel / 900, 0, 1);
        this.squash = this.landImpact;
        this.flipSpin = 0;
        this.bodyAngle = 0;
      }
    } else {
      this.fallTime += dt;
    }

    if (this.pos.y > terrain.h + 300) this.reset(220, 300);

    // --- state selection ---------------------------------------------------
    if (!this.onGround) {
      this.state = this.onWall !== 0 && this.vel.y > 0 ? 'wallslide' : (this.vel.y < 0 ? 'jump' : 'fall');
    } else if (this.crouching) this.state = 'crouch';
    else this.state = Math.abs(this.vel.x) > 20 ? 'run' : 'idle';

    // --- facing follows the aim, not the movement: he can run and shoot back
    const aimDx = aimTarget.x - (this.pos.x);
    if (Math.abs(aimDx) > 6) this.facing = aimDx >= 0 ? 1 : -1;
    this.aim = Math.atan2(aimTarget.y - (this.pos.y - STAND_HIP - TORSO * 0.55), aimDx);

    this.animate(dt, terrain);
  }

  private landVel = 0;

  private moveX(dx: number, terrain: Terrain): void {
    if (dx === 0) return;
    const step = Math.sign(dx);
    let remaining = Math.abs(dx);
    while (remaining > 0) {
      const move = Math.min(4, remaining);
      remaining -= move;
      const nx = this.pos.x + step * move;
      if (!this.blockedColumn(nx, this.pos.y, terrain)) { this.pos.x = nx; continue; }
      // Try to walk up over rubble before giving up.
      let stepped = false;
      for (let up = 2; up <= 16; up += 2) {
        if (!this.blockedColumn(nx, this.pos.y - up, terrain)) {
          this.pos.x = nx;
          this.pos.y -= up;
          stepped = true;
          break;
        }
      }
      if (!stepped) { this.vel.x = 0; break; }
    }
  }

  /** True when the character's body would overlap solid pixels at (x, feetY). */
  private blockedColumn(x: number, feetY: number, terrain: Terrain): boolean {
    const edge = x + Math.sign(this.vel.x || 1) * HALF_W;
    const top = feetY - (this.crouching ? CROUCH_HIP + TORSO : BODY_H - HEAD_R * 0.6);
    for (let y = feetY - 3; y > top; y -= 7) {
      if (terrain.solidAt(edge, y)) return true;
    }
    return terrain.solidAt(edge, top);
  }

  private moveY(dy: number, terrain: Terrain): void {
    if (dy === 0) return;
    const step = Math.sign(dy);
    let remaining = Math.abs(dy);
    this.onGround = false;
    while (remaining > 0) {
      const move = Math.min(4, remaining);
      remaining -= move;
      const ny = this.pos.y + step * move;
      if (step > 0) {
        if (this.footSolid(this.pos.x, ny, terrain)) {
          // Snap precisely onto the surface.
          let y = ny;
          while (y > ny - 8 && this.footSolid(this.pos.x, y, terrain)) y -= 1;
          this.pos.y = y;
          this.landVel = Math.abs(this.vel.y);
          this.vel.y = 0;
          this.onGround = true;
          return;
        }
      } else {
        const headY = ny - BODY_H + HEAD_R;
        if (terrain.solidAt(this.pos.x, headY) || terrain.solidAt(this.pos.x + HALF_W * 0.6, headY)) {
          this.vel.y = Math.max(this.vel.y, -30);
          return;
        }
      }
      this.pos.y = ny;
    }
    // Standing still on the ground still needs a support check.
    if (step > 0 && this.footSolid(this.pos.x, this.pos.y + 1, terrain)) {
      this.onGround = true;
      this.vel.y = 0;
    }
  }

  private footSolid(x: number, y: number, terrain: Terrain): boolean {
    return terrain.solidAt(x, y)
      || terrain.solidAt(x - HALF_W * 0.8, y)
      || terrain.solidAt(x + HALF_W * 0.8, y);
  }

  private detectWall(terrain: Terrain): void {
    if (this.onGround) { this.onWall = 0; return; }
    const midY = this.pos.y - STAND_HIP;
    const r = terrain.solidAt(this.pos.x + HALF_W + 4, midY) || terrain.solidAt(this.pos.x + HALF_W + 4, midY - 30);
    const l = terrain.solidAt(this.pos.x - HALF_W - 4, midY) || terrain.solidAt(this.pos.x - HALF_W - 4, midY - 30);
    this.onWall = r ? 1 : l ? -1 : 0;
  }

  // ------------------------------------------------------- external pokes ---

  /** Weapons call this on fire; it kicks the arms back and rocks the torso. */
  applyRecoil(amount: number, angle: number, knockback = 0): void {
    this.recoil = Math.min(1.6, this.recoil + amount);
    this.recoilAngle = angle;
    if (knockback > 0) {
      this.vel.x -= Math.cos(angle) * knockback;
      this.vel.y -= Math.sin(angle) * knockback * 0.55;
      if (this.onGround && this.vel.y < 0) this.onGround = false;
    }
  }

  /** Weapons place the hands; anything not set falls back to the gait swing. */
  setHands(h: HandTargets | null): void {
    if (!h) { this.handMainSet = false; this.handOffSet = false; return; }
    this.handMain = h.main;
    this.handMainSet = true;
    if (h.off) { this.handOff = h.off; this.handOffSet = true; }
    else this.handOffSet = false;
  }

  // ----------------------------------------------------------- animation ---

  private animate(dt: number, terrain: Terrain): void {
    const speed = Math.abs(this.vel.x);
    const speedRatio = clamp(speed / RUN_SPEED, 0, 1);

    // Gait advances with distance covered, so footfalls always match the ground.
    this.gait += (this.vel.x * dt) / STRIDE * Math.PI * (this.facing >= 0 ? 1 : 1);
    if (this.onGround && speed < 12) this.gait = damp(this.gait, Math.round(this.gait / Math.PI) * Math.PI, 8, dt);

    this.breathe += dt * (2.1 + speedRatio * 2);
    this.squash = damp(this.squash, 0, 11, dt);
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.landImpact = damp(this.landImpact, 0, 6, dt);
    this.aimVisual = dampAngle(this.aimVisual, this.aim, 22, dt);
    this.weaponBlend = damp(this.weaponBlend, this.handMainSet ? 1 : 0, 16, dt);

    // Somersault spin decays smoothly back to upright.
    if (Math.abs(this.flipSpin) > 0.001) {
      const consume = Math.sign(this.flipSpin) * Math.min(Math.abs(this.flipSpin), Math.abs(this.flipSpin) * 6.5 * dt + 3 * dt);
      this.bodyAngle += consume;
      this.flipSpin -= consume;
      if (Math.abs(this.flipSpin) < 0.02) { this.flipSpin = 0; }
    } else {
      this.bodyAngle = dampAngle(this.bodyAngle, 0, 14, dt);
    }

    // Torso lean: into the run, back under recoil, forward on landing.
    const targetLean =
      (this.vel.x / RUN_SPEED) * 0.19
      - Math.cos(this.recoilAngle) * this.recoil * 0.16
      + (this.state === 'wallslide' ? -this.onWall * 0.16 : 0);
    this.lean = damp(this.lean, targetLean, 13, dt);

    // Hip height: crouch, landing squash, run bob, breathing.
    const bobbing = Math.cos(this.gait * 2) * 3.4 * speedRatio;
    const airTuck = this.onGround ? 0 : clamp(-this.vel.y / 700, -0.35, 0.55) * 6;
    const target = (this.crouching ? CROUCH_HIP : STAND_HIP)
      - this.squash * 16 + bobbing + airTuck
      + Math.sin(this.breathe) * (this.onGround && speed < 12 ? 1.3 : 0.4);
    this.hipH = damp(this.hipH, target, 20, dt);

    this.buildPose(dt, terrain, speedRatio);
  }

  private buildPose(dt: number, terrain: Terrain, speedRatio: number): void {
    const p = this.pose;
    const f = this.facing;
    const ang = this.bodyAngle;

    // Root: pelvis, then everything above it hangs off the lean.
    const pelvis = { x: this.pos.x, y: this.pos.y - this.hipH };
    // While flipping, the whole figure orbits its own pelvis.
    const spin = (v: Vec2): Vec2 => {
      if (ang === 0) return v;
      const r = rotate({ x: v.x - pelvis.x, y: v.y - pelvis.y }, ang);
      return { x: pelvis.x + r.x, y: pelvis.y + r.y };
    };

    const leanV = rotate({ x: 0, y: -TORSO }, this.lean);
    const chest = { x: pelvis.x + leanV.x, y: pelvis.y + leanV.y };
    const neckV = rotate({ x: 0, y: -NECK }, this.lean * 0.7 + this.headTilt);
    const neck = { x: chest.x + neckV.x, y: chest.y + neckV.y };

    // Head looks where the weapon points.
    const look = this.aimVisual;
    const headOff = rotate({ x: 0, y: -HEAD_R * 1.02 }, this.lean * 0.5);
    const head = {
      x: neck.x + headOff.x + Math.cos(look) * 3.2,
      y: neck.y + headOff.y + Math.sin(look) * 2.4,
    };
    this.headTilt = damp(this.headTilt, Math.sin(look) * 0.12, 10, dt);

    // --- legs --------------------------------------------------------------
    const hipSpread = 10;
    const hipL = { x: pelvis.x - hipSpread * 0.5, y: pelvis.y + 1 };
    const hipR = { x: pelvis.x + hipSpread * 0.5, y: pelvis.y + 1 };
    const footL = this.footTarget(0, terrain, speedRatio);
    const footR = this.footTarget(1, terrain, speedRatio);

    // --- arms --------------------------------------------------------------
    const shoulderY = chest.y + 2;
    const shSpread = 11;
    const shL = { x: chest.x - shSpread * 0.5 * f, y: shoulderY };
    const shR = { x: chest.x + shSpread * 0.5 * f, y: shoulderY };

    const swing = -Math.cos(this.gait) * 0.95 * speedRatio;
    const airArm = this.onGround ? 0 : clamp(-this.vel.y / 600, -1, 1);
    // Arms hang nearly straight - a bent-up elbow reads as a zigzag scribble at
    // this line weight, so the hand is placed close to full arm length and the
    // swing keeps its full horizontal travel.
    const freeHand = (sh: Vec2, phase: number, bias: number): Vec2 => {
      const reach = (UPPER_ARM + FOREARM) * 0.93;
      const a = Math.PI / 2 + this.lean * 0.8 + phase + bias * f - airArm * 1.2
        + Math.sin(this.breathe * 0.9) * 0.04;
      return { x: sh.x + Math.cos(a) * reach, y: sh.y + Math.sin(a) * reach };
    };

    // The near arm sits slightly forward and the far arm slightly back, so at
    // rest they read as two limbs instead of one thick stroke.
    const gaitHandR = freeHand(shR, swing, -0.2);
    const gaitHandL = freeHand(shL, -swing, 0.24);

    const recoilPush = {
      x: -Math.cos(this.recoilAngle) * this.recoil * 15,
      y: -Math.sin(this.recoilAngle) * this.recoil * 15,
    };
    const b = this.weaponBlend;
    const handR = this.handMainSet
      ? { x: lerp(gaitHandR.x, this.handMain.x + recoilPush.x, b), y: lerp(gaitHandR.y, this.handMain.y + recoilPush.y, b) }
      : gaitHandR;
    const handL = this.handOffSet
      ? { x: lerp(gaitHandL.x, this.handOff.x + recoilPush.x * 0.8, b), y: lerp(gaitHandL.y, this.handOff.y + recoilPush.y * 0.8, b) }
      : gaitHandL;

    // Solve every chain, then spin the finished figure if a flip is running.
    p.pelvis = spin(pelvis);
    p.chest = spin(chest);
    p.neck = spin(neck);
    p.head = spin(head);
    p.hipL = spin(hipL); p.hipR = spin(hipR);
    p.footL = spin(footL); p.footR = spin(footR);
    p.shL = spin(shL); p.shR = spin(shR);
    p.handL = spin(handL); p.handR = spin(handR);

    // Knees bend forward relative to facing, elbows backward: never inside out.
    p.kneeL = solveIK(p.hipL, p.footL, THIGH, SHIN, -f);
    p.kneeR = solveIK(p.hipR, p.footR, THIGH, SHIN, -f);
    p.elbowL = solveIK(p.shL, p.handL, UPPER_ARM, FOREARM, f);
    p.elbowR = solveIK(p.shR, p.handR, UPPER_ARM, FOREARM, f);
    p.facing = f;
    p.aim = this.aimVisual;
    p.bodyAngle = ang;
  }

  /**
   * Foot placement. On the ground the feet ride a walk cycle and then get
   * dropped onto whatever the terrain actually is at that x, so the figure
   * clambers naturally over craters and rubble.
   */
  private footTarget(leg: number, terrain: Terrain, speedRatio: number): Vec2 {
    const pelvisX = this.pos.x;
    const pelvisY = this.pos.y - this.hipH;
    const moveDir = this.vel.x === 0 ? this.facing : Math.sign(this.vel.x);

    if (!this.onGround) {
      // Airborne: legs tuck and scissor, front leg reaching, back leg folded.
      const rise = clamp(-this.vel.y / 620, -1, 1);
      const split = (leg === 0 ? -1 : 1) * (0.45 + rise * 0.5);
      const tuck = this.state === 'wallslide' ? 0.55 : clamp(0.35 + rise * 0.45, 0.2, 0.95);
      const len = (THIGH + SHIN) * (1 - tuck * 0.45);
      const a = Math.PI / 2 + split * 0.85 * this.facing - rise * 0.35 * this.facing;
      return { x: pelvisX + Math.cos(a) * len, y: pelvisY + Math.sin(a) * len };
    }

    const ph = this.gait + leg * Math.PI;
    const amp = STRIDE * 0.5 * (0.18 + speedRatio * 0.82);
    // Standing still, the feet plant apart; at speed they line up under the body.
    const stance = 12 - speedRatio * 9;
    const fx = pelvisX - Math.cos(ph) * amp * moveDir + (leg === 0 ? -stance : stance);
    const lift = Math.sin(ph);
    const liftH = (10 + speedRatio * 26) * Math.max(0, lift);

    // Conform to the ground under this foot instead of a flat baseline.
    const probeY = this.pos.y - 26;
    const drop = terrain.groundBelow(fx, probeY, 70);
    const surface = clamp(probeY + drop, this.pos.y - 26, this.pos.y + 26);
    const idle = speedRatio < 0.02 ? Math.sin(this.breathe + leg * 1.4) * 0.6 : 0;
    return { x: fx, y: surface - liftH + idle };
  }

  // -------------------------------------------------------------- drawing ---

  draw(sk: Sketch): void {
    const p = this.pose;
    const c = sk.ctx;
    c.strokeStyle = '#000';
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const LIMB = 4.0;
    const BODY = 4.6;

    // Back limbs first so the front arm and leg read on top.
    const backIsL = p.facing > 0;
    const bl = backIsL ? { hip: p.hipL, knee: p.kneeL, foot: p.footL } : { hip: p.hipR, knee: p.kneeR, foot: p.footR };
    const fl = backIsL ? { hip: p.hipR, knee: p.kneeR, foot: p.footR } : { hip: p.hipL, knee: p.kneeL, foot: p.footL };

    sk.begin(LIMB);
    this.limb(sk, bl.hip, bl.knee, bl.foot, LIMB * 0.92);
    this.limb(sk, p.shL, p.elbowL, p.handL, LIMB * 0.9);

    // Torso and neck.
    sk.line(p.pelvis, p.chest, BODY, 2, 0.9);
    sk.line(p.chest, p.neck, BODY * 0.85, 1, 0.7);

    this.limb(sk, fl.hip, fl.knee, fl.foot, LIMB);
    this.limb(sk, p.shR, p.elbowR, p.handR, LIMB);

    // Head, drawn as a rough polygon the way these figures always are.
    sk.head(p.head.x, p.head.y, HEAD_R, p.aim * 0.12 + p.bodyAngle, 4.4, 10);

    // Hips and shoulders get a short bar so the joints do not look pinched.
    sk.line(p.hipL, p.hipR, BODY * 0.8, 1, 0.5);
    sk.line(p.shL, p.shR, BODY * 0.8, 1, 0.5);

    // A puff of dust under the feet when he lands hard.
    if (this.landImpact > 0.05 && this.onGround) {
      c.lineWidth = 2;
      sk.burst(this.pos.x, this.pos.y - 2, 5, 6, 10 + this.landImpact * 26, 2, Math.PI * 0.9, Math.PI * 0.85, 991);
    }
  }

  /** A limb drawn as two slightly bowed segments plus a hand or foot tick. */
  private limb(sk: Sketch, a: Vec2, b: Vec2, c: Vec2, w: number): void {
    sk.line(a, b, w, 2, 0.85);
    sk.line(b, c, w * 0.94, 2, 0.85);
  }

  /** World-space point a weapon should hang from. */
  get shoulderPos(): Vec2 { return this.pose.shR; }
  get chestPos(): Vec2 { return this.pose.chest; }
  get center(): Vec2 { return { x: this.pos.x, y: this.pos.y - this.hipH - TORSO * 0.4 }; }

  /** Small idle wobble used to keep muzzle positions from looking mechanical. */
  jitterSeed(i: number): number { return hashNoise(i, Math.floor(this.breathe * 8)); }
}

function blankPose(): Pose {
  const z = () => vec(0, 0);
  return {
    pelvis: z(), chest: z(), neck: z(), head: z(),
    hipL: z(), kneeL: z(), footL: z(),
    hipR: z(), kneeR: z(), footR: z(),
    shL: z(), elbowL: z(), handL: z(),
    shR: z(), elbowR: z(), handR: z(),
    facing: 1, aim: 0, bodyAngle: 0,
  };
}
