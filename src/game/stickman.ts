import {
  clamp, damp, dampAngle, hashNoise, lerp, rotate, smoothstep, solveIK, TAU, vec, type Vec2,
} from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Terrain } from './terrain';

// --- proportions, in world units -------------------------------------------
const THIGH = 31, SHIN = 31;
export const LEG_LEN = THIGH + SHIN;
const UPPER_ARM = 25, FOREARM = 25;
/** Full arm span; weapons size their grips against this. */
export const ARM_LEN = UPPER_ARM + FOREARM;
/**
 * A short torso and a big head. These figures are drawn as limbs first: the
 * body is a hinge between them, not a trunk, which is what lets a pose read
 * entirely from how the arms and legs are folded.
 */
const TORSO = 40;
const NECK = 9;
export const HEAD_R = 16;
const HALF_W = 11;
/**
 * Standing hip height. Deliberately well under the leg's full length - a leg
 * locked straight is the single thing that makes a stick figure read as a
 * cardboard cut-out, so even at rest the knees carry a bend.
 */
const STAND_HIP = 51;
const CROUCH_HIP = 28;
export const BODY_H = STAND_HIP + TORSO + NECK + HEAD_R * 2;

const DEG = Math.PI / 180;

// --- movement tuning --------------------------------------------------------
/**
 * Three speeds out of one analog axis. A barely tilted stick strolls, a normal
 * tilt runs, and the last quarter of the travel is a flat-out sprint - which is
 * also what SHIFT gives the keyboard, since a key has no in-between.
 */
const WALK_SPEED = 130;
const RUN_SPEED = 340;
const SPRINT_SPEED = 486;
/** Deflection at which the gait reads as a full run; past it, a sprint. */
export const RUN_PUSH = 0.72;
/** Ground speed past which an attack comes out of a run instead of a stand. */
export const RUN_ATTACK_SPEED = 215;

const AIR_SPEED = 330;
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
/** Ground covered per half-stride. Short and quick walking, long at a sprint. */
const STRIDE_WALK = 33, STRIDE_RUN = 56, STRIDE_SPRINT = 74;

/**
 * A gait is written as poses, not as a formula: each key says where the thigh
 * points, how hard the knee is folded, and how far the hips have dropped. The
 * cycle below is a real run - heel strike, absorb, drive, then the heel snapping
 * up under the hips and the knee swinging through high in front.
 *
 * Angles are degrees from straight down; positive leads in the facing direction.
 */
interface LegKey {
  /** Position in the cycle, 0..1. */
  u: number;
  thigh: number;
  /** How far the knee is folded. 0 is a locked leg; 120 folds the heel up. */
  knee: number;
  /** Hip drop at this point in the cycle; positive sinks. */
  hip: number;
}

const RUN_CYCLE: readonly LegKey[] = [
  { u: 0.00, thigh: 42, knee: 22, hip: 0.1 },    // contact, foot out in front
  { u: 0.14, thigh: 20, knee: 54, hip: 1.0 },    // absorb - the hips are lowest here
  { u: 0.34, thigh: -12, knee: 30, hip: 0.2 },   // passing over the planted foot
  { u: 0.50, thigh: -40, knee: 14, hip: -0.9 },  // toe-off, leg straight out behind
  { u: 0.62, thigh: -8, knee: 118, hip: -0.5 },  // heel snaps up under the hips
  { u: 0.78, thigh: 32, knee: 104, hip: 0 },     // knee driven high in front
  { u: 0.90, thigh: 50, knee: 52, hip: 0.1 },    // shin reaches for the ground
  { u: 1.00, thigh: 42, knee: 22, hip: 0.1 },
];

/**
 * Standing around. The feet are set well apart and the knees stay soft: a
 * figure whose legs meet in one vertical stroke reads as a post, not a person.
 */
const IDLE_KEY: LegKey = { u: 0, thigh: 15, knee: 22, hip: 0 };

export interface Pose {
  pelvis: Vec2; mid: Vec2; chest: Vec2; neck: Vec2; head: Vec2;
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

/**
 * A dramatic full-body stance a weapon can ask for, blended in over the solved
 * pose. `hover` also switches gravity off, which is what lets the beam be
 * charged and fired in mid-air before the figure drops back to the floor.
 */
export type StanceKind = 'brace' | 'hover' | 'crouch' | 'lunge';

export interface Stance {
  /**
   * `brace` plants and coils, `hover` switches gravity off, `crouch` drops the
   * whole figure to the floor (the ninja slash), `lunge` throws the front leg
   * out ahead and drives off the back one.
   */
  kind: StanceKind;
  /** 0..1 how strongly the stance takes over. */
  weight: number;
  /** Torso lean relative to facing; negative arches backwards. */
  lean?: number;
  /** Hip height delta - negative sinks into the stance. */
  hip?: number;
}

export type MoveState = 'idle' | 'walk' | 'run' | 'sprint' | 'jump' | 'fall' | 'wallslide' | 'crouch';

/** One control frame, from the keyboard or from the on-screen stick. */
export interface Controls {
  /** Analog walk, -1 (left) to 1 (right). Magnitude picks walk / run / sprint. */
  axis: number;
  down: boolean;
  jump: boolean;
  jumpHeld: boolean;
}

/** A frozen copy of the skeleton, used for the motion-blur afterimages. */
interface Ghost { pose: Pose; life: number; max: number; }

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
  private twist = 0;          // shoulders counter-rotating against the hips
  private bodyAngle = 0;      // used by the flip on the second jump
  private flipSpin = 0;
  private squash = 0;         // landing compression
  /** Upper-back curl: forward over a landing, arched back out of a brace. */
  private spine = 0;
  /** 0..1 how deep he is folded into a landing; decays over a few frames. */
  private landSquat = 0;
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

  /** 0..1.5, how hard the legs are working; 1 is a full run. */
  gaitPower = 0;
  /** 0..1 blend into the flat-out sprint animation. */
  sprintT = 0;
  private halfStride = 0;
  /** True on the frame a foot plants, so the game can kick up dust. */
  justStepped = false;
  stepPower = 0;

  // --- stances and floating -------------------------------------------------
  private stance: Stance | null = null;
  private stanceKind: StanceKind = 'brace';
  private stanceW = 0;
  private hoverT = 0;
  /** Seconds of low-friction ground travel left; what makes a slash slide. */
  private slideT = 0;

  // --- afterimages ----------------------------------------------------------
  private ghosts: Ghost[] = [];
  private ghostTimer = 0;
  /** Seconds of forced afterimages; weapons bump this on their big swings. */
  private ghostBurst = 0;

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
    this.twist = 0;
    this.bodyAngle = 0;
    this.flipSpin = 0;
    this.squash = 0;
    this.recoil = 0;
    this.airJumps = this.maxAirJumps;
    this.stance = null;
    this.stanceW = 0;
    this.hoverT = 0;
    this.slideT = 0;
    this.ghosts.length = 0;
    this.ghostBurst = 0;
    this.sprintT = 0;
    this.gaitPower = 0;
  }

  // ------------------------------------------------------------- physics ---

  update(dt: number, terrain: Terrain, ctrl: Controls, aimTarget: Vec2): void {
    this.justLanded = false;
    this.justJumped = false;
    this.justStepped = false;
    this.slideT = Math.max(0, this.slideT - dt);

    // `axis` is analog: a half-tilted thumb (or a keyboard without SHIFT)
    // walks, the far end of the travel sprints.
    const dir = clamp(ctrl.axis, -1, 1);
    const push = Math.abs(dir);
    this.crouching = ctrl.down && this.onGround;

    // The float answers the *request*, not the damped blend: waiting for the
    // stance to ease in would let him hit the floor before it caught him.
    const floating = !!this.stance && this.stance.kind === 'hover'
      && this.stance.weight > 0.05 && !this.onGround;
    // Catching a fall is a hard stop in mid-air, which is most of the drama.
    if (floating && this.hoverT < 0.05 && this.vel.y > 0) this.vel.y *= 0.22;
    this.hoverT = damp(this.hoverT, floating ? 1 : 0, floating ? 15 : 5, dt);

    // --- horizontal acceleration ------------------------------------------
    const topSpeed = this.groundTopSpeed(push);
    const accel = this.onGround ? ACCEL : AIR_ACCEL;
    if (push > 0.01) {
      this.vel.x += Math.sign(dir) * accel * dt * lerp(1, 0.45, this.hoverT);
      this.vel.x = clamp(this.vel.x, -topSpeed, topSpeed);
    } else if (this.onGround) {
      // A slash that slides keeps its speed: the floor lets go for a moment.
      const f = FRICTION * (this.slideT > 0 ? 0.1 : 1) * dt;
      this.vel.x = Math.abs(this.vel.x) <= f ? 0 : this.vel.x - Math.sign(this.vel.x) * f;
    } else {
      this.vel.x *= Math.exp(-(0.9 + this.hoverT * 5) * dt);
    }

    // --- jumping, with coyote time and an input buffer ---------------------
    if (ctrl.jump) this.jumpBuffer = JUMP_BUFFER;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.onGround ? COYOTE : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && this.hoverT < 0.5) {
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
    if (this.hoverT > 0.01) {
      // Floating: gravity all but switched off, and a slow breathing bob so it
      // reads as held up by the power rather than paused mid-fall.
      const g = GRAVITY * lerp(0.86, 0, this.hoverT);
      this.vel.y = Math.min(MAX_FALL, this.vel.y + g * dt);
      // Not a hover so much as a slow climb: the power lifts him off the floor.
      const bob = -34 + Math.sin(this.breathe * 1.7) * 22;
      this.vel.y = damp(this.vel.y, bob, 9 * this.hoverT, dt);
      this.flipSpin *= Math.exp(-9 * dt);
    } else {
      const g = this.vel.y < 0 ? GRAVITY * 0.86 : GRAVITY;
      this.vel.y = Math.min(MAX_FALL, this.vel.y + g * dt);
    }

    if (this.onWall !== 0 && this.vel.y > 0 && Math.sign(dir) === this.onWall && push > 0.3) {
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
        // Take the landing in the legs: knees fold, hips drop, back curls over.
        this.landSquat = clamp(0.3 + this.landVel / 750, 0.3, 1.15);
        this.flipSpin = 0;
        this.bodyAngle = 0;
      }
    } else {
      this.fallTime += dt;
    }

    if (this.pos.y > terrain.h + 300) this.reset(220, 300);

    // --- state selection ---------------------------------------------------
    const speed = Math.abs(this.vel.x);
    if (!this.onGround) {
      this.state = this.onWall !== 0 && this.vel.y > 0 ? 'wallslide' : (this.vel.y < 0 ? 'jump' : 'fall');
    } else if (this.crouching) this.state = 'crouch';
    else if (speed <= 20) this.state = 'idle';
    else if (speed > RUN_SPEED * 0.95) this.state = 'sprint';
    else this.state = speed > WALK_SPEED * 1.25 ? 'run' : 'walk';

    // --- facing follows the aim, not the movement: he can run and shoot back
    const aimDx = aimTarget.x - (this.pos.x);
    if (Math.abs(aimDx) > 6) this.facing = aimDx >= 0 ? 1 : -1;
    this.aim = Math.atan2(aimTarget.y - (this.pos.y - STAND_HIP - TORSO * 0.55), aimDx);

    this.animate(dt, terrain);
  }

  /** Walk / run / sprint blended out of one analog magnitude. */
  private groundTopSpeed(push: number): number {
    const crouch = this.crouching ? 0.45 : 1;
    if (!this.onGround) return AIR_SPEED * Math.max(0.4, push);
    const runT = smoothstep(clamp(push / RUN_PUSH, 0, 1));
    const sprintT = clamp((push - RUN_PUSH) / (1 - RUN_PUSH), 0, 1);
    const base = lerp(WALK_SPEED * 0.55, RUN_SPEED, runT) + (SPRINT_SPEED - RUN_SPEED) * sprintT;
    return base * crouch;
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

  /** The stance a weapon wants this frame; null falls back to normal movement. */
  setStance(s: Stance | null): void {
    this.stance = s;
    if (s && s.weight > 0.02) this.stanceKind = s.kind;
  }

  get hovering(): number { return this.hoverT; }
  get stanceBlend(): number { return this.stanceW; }

  /** A short burst of motion-blur afterimages, for the big swings. */
  addGhostBurst(seconds: number): void {
    this.ghostBurst = Math.max(this.ghostBurst, seconds);
  }

  /** A committed step into a swing: heavy weapons lunge with their weight. */
  dash(vx: number, vy = 0): void {
    this.vel.x += vx;
    this.vel.y += vy;
    if (vy < 0) this.onGround = false;
  }

  /**
   * A spinning flourish. `hop` lifts him off the floor first, which is what a
   * full somersaulting swing needs; a low hop keeps a grounded spin-slash from
   * dragging its own feet through the ground.
   */
  spinFlourish(dir: number, turns = 1, hop = 235): void {
    if (this.onGround && hop > 0) {
      this.vel.y = -hop;
      this.onGround = false;
    }
    this.flipSpin = Math.sign(dir || 1) * TAU * turns;
    this.addGhostBurst(0.34);
  }

  /** Cuts ground friction for a moment: a committed step becomes a slide. */
  slide(seconds: number): void {
    this.slideT = Math.max(this.slideT, seconds);
  }

  // ----------------------------------------------------------- animation ---

  private animate(dt: number, terrain: Terrain): void {
    const speed = Math.abs(this.vel.x);
    this.gaitPower = damp(this.gaitPower, clamp(speed / RUN_SPEED, 0, 1.45), 16, dt);
    const rawSprint = clamp((speed - RUN_SPEED * 0.9) / (SPRINT_SPEED - RUN_SPEED * 0.9), 0, 1);
    this.sprintT = damp(this.sprintT, this.onGround ? rawSprint : rawSprint * 0.3, 8, dt);

    // Stance blending. Everything downstream reads `stanceW`, so a stance can
    // be dropped at any moment and the figure eases back out of it.
    const sw = this.stance ? clamp(this.stance.weight, 0, 1) : 0;
    this.stanceW = damp(this.stanceW, sw, 11, dt);

    // Gait advances with distance covered, so footfalls always match the
    // ground - and the stride itself grows from a walk to a sprint.
    const stride = lerp(STRIDE_WALK, STRIDE_RUN, clamp(this.gaitPower, 0, 1))
      + (STRIDE_SPRINT - STRIDE_RUN) * this.sprintT;
    this.gait += (this.vel.x * dt) / stride * Math.PI;
    if (this.onGround && speed < 12) this.gait = damp(this.gait, Math.round(this.gait / Math.PI) * Math.PI, 8, dt);

    // Each half turn of the cycle is one foot planting.
    const half = Math.floor(this.gait / Math.PI);
    if (half !== this.halfStride) {
      if (this.onGround && speed > 26 && this.stanceW < 0.5) {
        this.justStepped = true;
        this.stepPower = clamp(this.gaitPower, 0, 1.4);
      }
      this.halfStride = half;
    }

    this.breathe += dt * (2.1 + this.gaitPower * 2.4);
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

    // Torso lean: into the run (harder the faster he goes), back under recoil,
    // and whatever the current stance asks for on top.
    const stanceLean = (this.stance?.lean ?? 0) * this.facing * this.stanceW;
    const targetLean =
      (this.vel.x / RUN_SPEED) * (0.17 + this.sprintT * 0.2)
      - Math.cos(this.recoilAngle) * this.recoil * 0.16
      + (this.state === 'wallslide' ? -this.onWall * 0.16 : 0)
      + stanceLean;
    this.lean = damp(this.lean, targetLean, 13, dt);

    // Shoulders counter-rotate against the hips; without it a run reads as a
    // stiff cardboard cut-out sliding along the floor.
    const twistGoal = -Math.sin(this.gait) * (0.5 + this.sprintT * 0.45) * clamp(this.gaitPower, 0, 1.2);
    this.twist = damp(this.twist, twistGoal * (1 - this.stanceW), 15, dt);

    // A landing is absorbed, not bounced off: the fold is deep and lets go over
    // a few frames rather than snapping back.
    this.landSquat = damp(this.landSquat, 0, 9, dt);

    // The back curls over a landing or a crouch and arches back out of a brace.
    const curl = this.landSquat * 0.42
      + (this.crouching ? 0.34 : 0)
      + (this.stanceKind === 'crouch' || this.stanceKind === 'lunge' ? this.stanceW * 0.24 : 0)
      - (this.stanceKind === 'brace' ? this.stanceW * 0.34 : 0)
      + clamp(this.gaitPower, 0, 1) * 0.07;
    this.spine = damp(this.spine, curl * this.facing, 12, dt);

    // Hip height. The bob is not a decoration on top of the walk - it *is* the
    // walk: the hips sink onto each planted foot and rise over the push-off,
    // straight out of the same pose cycle the legs are reading.
    const power = clamp(this.gaitPower, 0, 1.2);
    const sink = (sampleLeg(this.gait / TAU).hip + sampleLeg((this.gait + Math.PI) / TAU).hip) * 0.5;
    const bobbing = sink * (3 + power * 9);
    const airTuck = this.onGround ? 0 : clamp(-this.vel.y / 700, -0.35, 0.55) * 6;
    const stanceHip = (this.stance?.hip ?? 0) * this.stanceW;
    const target = (this.crouching ? CROUCH_HIP : STAND_HIP)
      - this.squash * 10 - bobbing - this.landSquat * 15 + airTuck + stanceHip
      + Math.sin(this.breathe) * (this.onGround && speed < 12 ? 1.3 : 0.4);
    this.hipH = damp(this.hipH, target, 22, dt);

    this.buildPose(dt, terrain);
    this.updateGhosts(dt);
  }

  private buildPose(dt: number, terrain: Terrain): void {
    const p = this.pose;
    const f = this.facing;
    const ang = this.bodyAngle;
    const power = clamp(this.gaitPower, 0, 1.2);

    // Root: pelvis, then everything above it hangs off the lean.
    const pelvis = { x: this.pos.x, y: this.pos.y - this.hipH };
    // While flipping, the whole figure orbits its own pelvis.
    const spin = (v: Vec2): Vec2 => {
      if (ang === 0) return v;
      const r = rotate({ x: v.x - pelvis.x, y: v.y - pelvis.y }, ang);
      return { x: pelvis.x + r.x, y: pelvis.y + r.y };
    };

    // The spine is two segments, not one: the lower back leads the lean and the
    // upper back carries it further, so the figure can curl over a landing and
    // arch back out of it instead of tipping like a plank.
    const curl = this.spine;
    const lowV = rotate({ x: 0, y: -TORSO * 0.45 }, this.lean * 0.55 + curl * 0.35);
    const mid = { x: pelvis.x + lowV.x, y: pelvis.y + lowV.y };
    const upV = rotate({ x: 0, y: -TORSO * 0.55 }, this.lean * 1.35 + curl);
    const chest = { x: mid.x + upV.x, y: mid.y + upV.y };
    const neckV = rotate({ x: 0, y: -NECK }, this.lean * 0.7 + this.headTilt + curl * 0.5);
    const neck = { x: chest.x + neckV.x, y: chest.y + neckV.y };

    // Head looks where the weapon points; while bracing it tips up and back,
    // which is most of what makes a charge-up read as defiant.
    const look = this.aimVisual;
    // A brace tips the head up and back; a crouch or a lunge ducks it forward
    // over the strike instead, which is the difference between defiance and
    // committing to a cut.
    const braceUp = this.stanceKind === 'brace' ? this.stanceW
      : this.stanceKind === 'hover' ? this.stanceW * 0.5
        : -this.stanceW * 0.7;
    const headOff = rotate({ x: 0, y: -HEAD_R * 1.02 }, this.lean * 0.5);
    const head = {
      x: neck.x + headOff.x + Math.cos(look) * 3.2,
      y: neck.y + headOff.y + Math.sin(look) * 2.4 - braceUp * 2.4,
    };
    this.headTilt = damp(this.headTilt, Math.sin(look) * 0.12 - braceUp * 0.16 * f, 10, dt);

    // --- legs --------------------------------------------------------------
    const hipSpread = 10;
    const hipTwist = -this.twist * 4.5 * f;
    const hipL = { x: pelvis.x - hipSpread * 0.5 - hipTwist, y: pelvis.y + 1 };
    const hipR = { x: pelvis.x + hipSpread * 0.5 + hipTwist, y: pelvis.y + 1 };
    const legL = this.legPose(0, hipL, terrain, power);
    const legR = this.legPose(1, hipR, terrain, power);

    // --- arms --------------------------------------------------------------
    const shoulderY = chest.y + 2;
    const shSpread = 11;
    const shTwist = this.twist * 5.5 * f;
    const shL = { x: chest.x - shSpread * 0.5 * f - shTwist, y: shoulderY };
    const shR = { x: chest.x + shSpread * 0.5 * f + shTwist, y: shoulderY };

    const armL = this.armPose(0, shL, power);
    const armR = this.armPose(1, shR, power);

    const recoilPush = {
      x: -Math.cos(this.recoilAngle) * this.recoil * 15,
      y: -Math.sin(this.recoilAngle) * this.recoil * 15,
    };
    const b = this.weaponBlend;
    const handR = this.handMainSet
      ? { x: lerp(armR.hand.x, this.handMain.x + recoilPush.x, b), y: lerp(armR.hand.y, this.handMain.y + recoilPush.y, b) }
      : armR.hand;
    const handL = this.handOffSet
      ? { x: lerp(armL.hand.x, this.handOff.x + recoilPush.x * 0.8, b), y: lerp(armL.hand.y, this.handOff.y + recoilPush.y * 0.8, b) }
      : armL.hand;

    // Everything is already solved; the spin just carries the finished figure.
    p.pelvis = spin(pelvis);
    p.mid = spin(mid);
    p.chest = spin(chest);
    p.neck = spin(neck);
    p.head = spin(head);
    p.hipL = spin(hipL); p.hipR = spin(hipR);
    p.footL = spin(legL.foot); p.footR = spin(legR.foot);
    p.kneeL = spin(legL.knee); p.kneeR = spin(legR.knee);
    p.shL = spin(shL); p.shR = spin(shR);
    p.handL = spin(handL); p.handR = spin(handR);

    // A weapon places the hand, so that arm has to be solved backwards from it;
    // a free arm already knows where its elbow is.
    p.elbowL = this.handOffSet
      ? spin(solveIK(shL, handL, UPPER_ARM, FOREARM, f))
      : spin(armL.elbow);
    p.elbowR = this.handMainSet
      ? spin(solveIK(shR, handR, UPPER_ARM, FOREARM, f))
      : spin(armR.elbow);
    p.facing = f;
    p.aim = this.aimVisual;
    p.bodyAngle = ang;
  }

  /** A point `len` away at `deg` from straight down; positive leads the facing. */
  private off(deg: number, len: number): Vec2 {
    const a = deg * DEG;
    return { x: Math.sin(a) * this.facing * len, y: Math.cos(a) * len };
  }

  /**
   * One leg, solved forwards from the pose cycle - thigh angle, then knee fold -
   * instead of from a foot target. That is the whole difference between a leg
   * that swings and a leg that slides: the knee angle is *authored*, so it can
   * fold right up under the hips on the recovery and drive straight out behind
   * on the push, which an IK chain reaching for a point on the floor never does.
   *
   * The ground still gets the last word: a foot that ends up inside the terrain
   * is planted on the surface and the knee re-solved, so he clambers over rubble.
   */
  private legPose(leg: number, hip: Vec2, terrain: Terrain, power: number): { knee: Vec2; foot: Vec2 } {
    const f = this.facing;
    const front = (leg === 1) === (f > 0);
    const key = this.legKey(leg, front, power);

    // A landing folds both knees hard and drops the hips into the floor.
    const bend = key.knee + this.landSquat * 46 + (this.crouching ? 34 : 0);
    const thigh = key.thigh - this.landSquat * 6;

    const kv = this.off(thigh, THIGH);
    let knee = { x: hip.x + kv.x, y: hip.y + kv.y };
    const sv = this.off(thigh - bend, SHIN);
    let foot = { x: knee.x + sv.x, y: knee.y + sv.y };

    // Blend into a weapon's stance, which asks for a foot position outright.
    if (this.stanceW > 0.02) {
      const s = this.stanceTarget(front, this.pos.x, hip.y, terrain);
      foot = { x: lerp(foot.x, s.x, this.stanceW), y: lerp(foot.y, s.y, this.stanceW) };
      knee = solveIK(hip, foot, THIGH, SHIN, -f);
    }

    if (this.onGround) {
      const probeY = this.pos.y - 34;
      const surface = probeY + terrain.groundBelow(foot.x, probeY, 90);
      if (foot.y > surface) {
        foot = { x: foot.x, y: surface };
        knee = solveIK(hip, foot, THIGH, SHIN, -f);
      }
    }
    return { knee, foot };
  }

  /** The pose this leg is in right now, from whichever cycle applies. */
  private legKey(leg: number, front: boolean, power: number): LegKey {
    if (!this.onGround) {
      const rise = clamp(-this.vel.y / 620, -1, 1);
      // Mid-somersault he pulls into a ball. Nobody flips with straight legs,
      // and the tuck is what makes the rotation read as a rotation.
      const spin = clamp(Math.abs(this.flipSpin) / 3, 0, 1);
      if (spin > 0.15) {
        return {
          u: 0,
          thigh: lerp(40, 78, spin) * (front ? 1 : 0.75),
          knee: lerp(80, 128, spin),
          hip: 0,
        };
      }
      if (this.state === 'wallslide') {
        return front
          ? { u: 0, thigh: 30, knee: 100, hip: 0 }
          : { u: 0, thigh: -16, knee: 58, hip: 0 };
      }
      // Rising, both knees fold up under him; falling, the front leg reaches
      // for the floor and the back one trails behind, still folded.
      const tuck = clamp(0.5 + rise * 0.5, 0, 1);
      return front
        ? { u: 0, thigh: lerp(38, 64, tuck), knee: lerp(44, 116, tuck), hip: 0 }
        : { u: 0, thigh: lerp(-34, -4, tuck), knee: lerp(70, 108, tuck), hip: 0 };
    }
    // On the ground: the run cycle, faded in over the idle stance by how hard
    // the legs are actually working.
    const k = clamp(power, 0, 1);
    const run = sampleLeg((this.gait + leg * Math.PI) / TAU);
    const travel = this.vel.x === 0 ? 1 : Math.sign(this.vel.x) * this.facing;
    const idleThigh = (front ? 1 : -1) * IDLE_KEY.thigh;
    return {
      u: run.u,
      thigh: lerp(idleThigh, run.thigh * travel, k),
      knee: lerp(IDLE_KEY.knee, run.knee, k),
      hip: run.hip * k,
    };
  }

  /**
   * One arm. Elbows are never locked: even standing still the arm carries a
   * fold, and a run pumps it. The swing is taken from the *opposite* leg, which
   * is what stops a run reading as a cardboard cut-out sliding along the floor.
   */
  private armPose(side: number, sh: Vec2, power: number): { elbow: Vec2; hand: Vec2 } {
    const k = clamp(power, 0, 1);
    const front = side === 1;
    let upper: number;
    let bend: number;

    if (!this.onGround) {
      const rise = clamp(-this.vel.y / 600, -1, 1) * (1 - this.hoverT);
      const spin = clamp(Math.abs(this.flipSpin) / 3, 0, 1);
      // Arms throw up on the way up and out for balance on the way down - and
      // clamp in tight around the knees through a somersault.
      upper = lerp((front ? 1 : -1) * (26 + rise * 34) - rise * 26 + this.hoverT * 30, 52, spin);
      bend = lerp(52 + Math.abs(rise) * 26, 132, spin);
    } else {
      const opp = sampleLeg((this.gait + (side === 1 ? Math.PI : 0)) / TAU);
      const travel = this.vel.x === 0 ? 1 : Math.sign(this.vel.x) * this.facing;
      // At rest the elbow sits back and the forearm comes forward, so the arm
      // reads as a bent limb beside the body instead of vanishing into it.
      const idle = (front ? -16 : 9);
      upper = lerp(idle, opp.thigh * 0.5 * travel, k);
      // Bent hard at a run, softly at rest, and a touch more as the arm comes
      // through in front.
      bend = lerp(48, 104, k) + Math.max(0, opp.thigh) * 0.22 * k;
    }
    upper += this.lean * 26 + Math.sin(this.breathe * 0.9) * 1.6;

    const uv = this.off(upper, UPPER_ARM);
    const elbow = { x: sh.x + uv.x, y: sh.y + uv.y };
    const fv = this.off(upper + bend, FOREARM);
    return { elbow, hand: { x: elbow.x + fv.x, y: elbow.y + fv.y } };
  }

  /** Where a foot goes in the current stance. */
  private stanceTarget(front: boolean, px: number, py: number, terrain: Terrain): Vec2 {
    const f = this.facing;
    /** Drops a foot onto whatever is actually under it at that x. */
    const onFloor = (x: number): Vec2 => {
      const drop = terrain.groundBelow(x, this.pos.y - 26, 80);
      return { x, y: clamp(this.pos.y - 26 + drop, this.pos.y - 26, this.pos.y + 26) };
    };
    if (this.stanceKind === 'crouch') {
      // Folded right down over the floor, front leg thrown out along the slide,
      // back leg tucked under the hips. The pose the katana cuts out of.
      return onFloor(front ? px + f * 44 : px - f * 8);
    }
    if (this.stanceKind === 'lunge') {
      // Everything committed forward: the step a heavy swing lands on.
      return onFloor(front ? px + f * 54 : px - f * 44);
    }
    if (this.stanceKind === 'hover' && !this.onGround) {
      // Floating: the front leg folds up, the back leg trails, both drifting
      // with a slow bob. Nothing touches the ground, and it should look like it.
      const bob = Math.sin(this.breathe * 1.7 + (front ? 0 : 0.8)) * 3.4;
      return front
        ? { x: px + f * 23, y: py + 33 + bob }
        : { x: px - f * 21, y: py + 53 + bob };
    }
    // Braced: a wide, low, planted stance - front foot forward and turned out,
    // back leg driving into the floor.
    return onFloor(front ? px + f * 27 : px - f * 40);
  }

  // --------------------------------------------------------- afterimages ---

  private updateGhosts(dt: number): void {
    this.ghostBurst = Math.max(0, this.ghostBurst - dt);
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i].life -= dt;
      if (this.ghosts[i].life <= 0) this.ghosts.splice(i, 1);
    }
    const wants = this.ghostBurst > 0 || this.sprintT > 0.55 || Math.abs(this.flipSpin) > 1.2;
    this.ghostTimer -= dt;
    if (!wants || this.ghostTimer > 0) return;
    this.ghostTimer = 0.055;
    const life = this.ghostBurst > 0 ? 0.2 : 0.13;
    this.ghosts.push({ pose: clonePose(this.pose), life, max: life });
    if (this.ghosts.length > 3) this.ghosts.shift();
  }

  // -------------------------------------------------------------- drawing ---

  draw(sk: Sketch): void {
    const c = sk.ctx;

    // Afterimages first: thin, pale copies of where he just was.
    for (const g of this.ghosts) {
      const k = g.life / g.max;
      c.save();
      c.globalAlpha = 0.3 * k;
      this.drawPose(sk, g.pose, 0.72);
      c.restore();
    }

    // Speed lines dragging off a flat-out sprint.
    if (this.sprintT > 0.35 && this.onGround) {
      const back = -Math.sign(this.vel.x || 1);
      c.save();
      c.globalAlpha = 0.35 * this.sprintT;
      c.strokeStyle = '#000';
      c.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const y = this.pos.y - 20 - i * 22 - hashNoise(i, sk.boil) * 6;
        const len = 26 + i * 12 + this.sprintT * 30;
        const x0 = this.pos.x + back * (18 + i * 4);
        c.beginPath();
        c.moveTo(x0, y);
        c.lineTo(x0 + back * len, y + hashNoise(i + 5, sk.boil) * 3);
        c.stroke();
      }
      c.restore();
    }

    // In a power stance the aura is a thicket of ink behind him, so the figure
    // gets a white outline first and reads clean straight through it.
    if (this.stanceW > 0.12) {
      c.save();
      c.globalAlpha = Math.min(1, this.stanceW * 1.6);
      this.drawPose(sk, this.pose, 2.15, '#fff');
      c.restore();
    }
    this.drawPose(sk, this.pose, 1);

    // A puff of dust under the feet when he lands hard.
    if (this.landImpact > 0.05 && this.onGround) {
      c.lineWidth = 2;
      sk.burst(this.pos.x, this.pos.y - 2, 5, 6, 10 + this.landImpact * 26, 2, Math.PI * 0.9, Math.PI * 0.85, 991);
    }
  }

  /** The figure itself, from any pose - the live one or an afterimage. */
  private drawPose(sk: Sketch, p: Pose, weight: number, color = '#000'): void {
    const c = sk.ctx;
    c.strokeStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const LIMB = 4.0 * weight;
    const BODY = 4.6 * weight;

    // Back limbs first so the front arm and leg read on top.
    const backIsL = p.facing > 0;
    const bl = backIsL ? { hip: p.hipL, knee: p.kneeL, foot: p.footL } : { hip: p.hipR, knee: p.kneeR, foot: p.footR };
    const fl = backIsL ? { hip: p.hipR, knee: p.kneeR, foot: p.footR } : { hip: p.hipL, knee: p.kneeL, foot: p.footL };

    sk.begin(LIMB, color);
    this.limb(sk, bl.hip, bl.knee, bl.foot, LIMB * 0.92);
    this.limb(sk, p.shL, p.elbowL, p.handL, LIMB * 0.9);

    // Torso, drawn as two segments so the curl in the back actually shows.
    sk.line(p.pelvis, p.mid, BODY, 1, 0.7);
    sk.line(p.mid, p.chest, BODY, 1, 0.7);
    sk.line(p.chest, p.neck, BODY * 0.85, 1, 0.7);

    this.limb(sk, fl.hip, fl.knee, fl.foot, LIMB);
    this.limb(sk, p.shR, p.elbowR, p.handR, LIMB);

    // Head, drawn as a rough polygon the way these figures always are.
    sk.head(p.head.x, p.head.y, HEAD_R, p.aim * 0.12 + p.bodyAngle, 4.4 * weight, 10);

    // Hips and shoulders get a short bar so the joints do not look pinched.
    sk.line(p.hipL, p.hipR, BODY * 0.8, 1, 0.5);
    sk.line(p.shL, p.shR, BODY * 0.8, 1, 0.5);
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
  /** Height from the feet to the top of the head, for auras and effects. */
  get height(): number { return this.hipH + TORSO + NECK + HEAD_R * 2; }

  /** Small idle wobble used to keep muzzle positions from looking mechanical. */
  jitterSeed(i: number): number { return hashNoise(i, Math.floor(this.breathe * 8)); }
}

/** Wraps a cycle position into 0..1. */
function mod1(v: number): number {
  const m = v % 1;
  return m < 0 ? m + 1 : m;
}

/** The interpolated leg pose at a point in the cycle, in cycles (not radians). */
function sampleLeg(cycles: number): LegKey {
  const u = mod1(cycles);
  let i = 0;
  while (i < RUN_CYCLE.length - 2 && RUN_CYCLE[i + 1].u <= u) i++;
  const a = RUN_CYCLE[i], b = RUN_CYCLE[i + 1];
  const t = smoothstep((u - a.u) / Math.max(1e-6, b.u - a.u));
  return {
    u,
    thigh: lerp(a.thigh, b.thigh, t),
    knee: lerp(a.knee, b.knee, t),
    hip: lerp(a.hip, b.hip, t),
  };
}

function blankPose(): Pose {
  const z = () => vec(0, 0);
  return {
    pelvis: z(), mid: z(), chest: z(), neck: z(), head: z(),
    hipL: z(), kneeL: z(), footL: z(),
    hipR: z(), kneeR: z(), footR: z(),
    shL: z(), elbowL: z(), handL: z(),
    shR: z(), elbowR: z(), handR: z(),
    facing: 1, aim: 0, bodyAngle: 0,
  };
}

function clonePose(p: Pose): Pose {
  const v = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
  return {
    pelvis: v(p.pelvis), mid: v(p.mid), chest: v(p.chest), neck: v(p.neck), head: v(p.head),
    hipL: v(p.hipL), kneeL: v(p.kneeL), footL: v(p.footL),
    hipR: v(p.hipR), kneeR: v(p.kneeR), footR: v(p.footR),
    shL: v(p.shL), elbowL: v(p.elbowL), handL: v(p.handL),
    shR: v(p.shR), elbowR: v(p.elbowR), handR: v(p.handR),
    facing: p.facing, aim: p.aim, bodyAngle: p.bodyAngle,
  };
}
