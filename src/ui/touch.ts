import { TAU, type Vec2 } from '../core/math';
import type { Input, Ptr } from '../core/input';
import type { Sketch } from '../core/sketch';
import { AimSolver } from './aim';
import type { WheelLayout } from './ui';
import { inkText } from './ui';

/** A floating stick: where the thumb landed, and where it is now. */
interface Stick { id: number; ox: number; oy: number; x: number; y: number }

/** How far the stick knob travels before it reads as fully deflected. */
const STICK_R = 74;
const DEAD = 0.2;
const JUMP_ON = 0.44;
const JUMP_OFF = 0.3;
const CROUCH_ON = 0.46;

/** The aiming stick is smaller: a flick of the thumb should swing him round. */
const AIM_R = 56;
/** Below this the thumb has not really been dragged, so the aim stands. */
const AIM_DEAD = 13;
/** How far out from the shoulder the aim mark is drawn. */
const AIM_MARK = 150;

export interface TouchState {
  /** Analog walk, -1..1. */
  axis: number;
  crouch: boolean;
  jump: boolean;
  jumpHeld: boolean;
  /** Unit vector the aiming thumb has swung to; null until it is first used. */
  aimDir: Vec2 | null;
  firing: boolean;
  firePressed: boolean;
  wheelOpen: boolean;
  wheelPointer: Vec2;
  /** True on the frame the wheel closed, meaning "equip what is highlighted". */
  wheelReleased: boolean;
}

/**
 * The on-screen controls: two floating sticks and a pad.
 *
 * Neither stick is drawn until a thumb lands on it, and neither cares where on
 * its side of the screen that was - only which way it is then dragged. The
 * bottom left one walks, jumps and crouches. The other one aims: a press
 * attacks along the aim he already has, and dragging swings the aim, and him
 * with it, round to point that way. A translucent pad at the bottom centre
 * opens the weapon fan while held; the weapon the thumb is over when it lifts
 * is the one equipped.
 */
export class TouchControls {
  private stick: Stick | null = null;
  private stickFade = 0;
  private jumpLatched = false;

  private attackId = -1;
  private aimStick: Stick | null = null;
  private aimFade = 0;
  /** Sticky: a tap that never drags keeps whatever the last drag chose. */
  private aim = new AimSolver();
  private aimPrev: Vec2 | null = null;

  private padId = -1;
  private padPress = 0;
  wheelOpen = false;

  /** Button geometry, recomputed each frame from the view size. */
  private pad: Vec2 = { x: 0, y: 0 };
  private padR = 44;

  padCentre(view: { w: number; h: number }): Vec2 {
    return { x: view.w / 2, y: view.h - Math.min(96, view.h * 0.11) };
  }

  /** The fan the weapon wheel uses on touch: spread above the pad. */
  layout(view: { w: number; h: number }): WheelLayout {
    const radius = Math.min(view.w * 0.36, view.h * 0.4, 300);
    return { kind: 'fan', anchor: this.padCentre(view), radius, from: Math.PI * 1.06, to: Math.PI * 1.94 };
  }

  update(
    input: Input, dt: number, view: { w: number; h: number },
    toWorld: (x: number, y: number) => Vec2, eye: Vec2,
  ): TouchState {
    this.pad = this.padCentre(view);
    this.padR = Math.min(46, view.w * 0.06 + 26);

    const out: TouchState = {
      axis: 0, crouch: false, jump: false, jumpHeld: false,
      aimDir: null, firing: false, firePressed: false,
      wheelOpen: false, wheelPointer: this.pad, wheelReleased: false,
    };

    const byId = new Map<number, Ptr>();
    for (const p of input.pointers.values()) if (!p.justUp) byId.set(p.id, p);

    // --- let go of anything whose finger has gone, before handing out roles --
    // Order matters: a stick still held by a vanished pointer would otherwise
    // turn the very next touch into an attack, which is what made a jammed
    // stick feel unrecoverable. Pointer ids are recycled too, so the id alone
    // is no proof of ownership - the role has to match as well.
    if (this.stick) {
      const held = byId.get(this.stick.id);
      if (!held || held.role !== 'stick') {
        this.stick = null;
        this.jumpLatched = false;
      }
    }
    // A world reset drops the stick while the thumb may still be down. Adopt
    // that finger back rather than leaving it inert until it happens to lift.
    if (!this.stick) {
      for (const p of byId.values()) {
        if (p.role !== 'stick') continue;
        const w = toWorld(p.x, p.y);
        this.stick = { id: p.id, ox: w.x, oy: w.y, x: w.x, y: w.y };
        this.jumpLatched = false;
        break;
      }
    }

    // --- hand out a role to every new finger, once, and keep it -------------
    for (const p of input.pointers.values()) {
      if (p.kind !== 'touch' || p.role !== '') continue;
      const w = toWorld(p.x, p.y);
      if (Math.hypot(w.x - this.pad.x, w.y - this.pad.y) < this.padR * 1.5) {
        p.role = 'pad';
        this.padId = p.id;
        this.wheelOpen = true;
      } else if (w.x < view.w * 0.45 && this.stick === null) {
        p.role = 'stick';
        this.stick = { id: p.id, ox: w.x, oy: w.y, x: w.x, y: w.y };
        this.jumpLatched = false;
      } else {
        p.role = 'attack';
        this.attackId = p.id;
        this.aimStick = { id: p.id, ox: w.x, oy: w.y, x: w.x, y: w.y };
        out.firePressed = true;
      }
    }

    // --- stick --------------------------------------------------------------
    if (this.stick) {
      const p = byId.get(this.stick.id);
      if (!p) {
        this.stick = null;
        this.jumpLatched = false;
      } else {
        const w = toWorld(p.x, p.y);
        this.stick.x = w.x; this.stick.y = w.y;
        let dx = w.x - this.stick.ox, dy = w.y - this.stick.oy;
        const d = Math.hypot(dx, dy);
        // A floating stick: drag past the edge and the base follows the thumb,
        // so long swipes never run out of travel.
        if (d > STICK_R) {
          this.stick.ox = w.x - (dx / d) * STICK_R;
          this.stick.oy = w.y - (dy / d) * STICK_R;
          dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R;
        }
        const nx = dx / STICK_R, ny = dy / STICK_R;
        out.axis = Math.abs(nx) < DEAD ? 0 : Math.sign(nx) * ((Math.abs(nx) - DEAD) / (1 - DEAD));
        const up = -ny;
        out.crouch = ny > CROUCH_ON;
        out.jumpHeld = up > JUMP_OFF;
        if (up > JUMP_ON && !this.jumpLatched) { out.jump = true; this.jumpLatched = true; }
        if (up < JUMP_OFF) this.jumpLatched = false;
      }
    }
    this.stickFade += ((this.stick ? 1 : 0) - this.stickFade) * Math.min(1, dt * 14);

    // --- attack -------------------------------------------------------------
    let attack = byId.get(this.attackId);
    if (!attack || attack.role !== 'attack') {
      attack = undefined;
      // Fall back to any other attack finger still down.
      for (const p of byId.values()) if (p.role === 'attack') { attack = p; this.attackId = p.id; break; }
    }
    // The second stick. Where on the screen the thumb landed says nothing; only
    // what it does next, and how that is read is the selected aim mode's
    // business - see ui/aim.ts. A press that never moves leaves the aim exactly
    // as it was under every mode, so tapping attacks along the current aim.
    let fresh = false;
    let dx = 0, dy = 0;
    let here: Vec2 = eye;
    if (attack) {
      here = toWorld(attack.x, attack.y);
      if (!this.aimStick || this.aimStick.id !== attack.id) {
        this.aimStick = { id: attack.id, ox: here.x, oy: here.y, x: here.x, y: here.y };
        this.aimPrev = null;
        fresh = true;
      }
      this.aimStick.x = here.x; this.aimStick.y = here.y;
      dx = here.x - this.aimStick.ox; dy = here.y - this.aimStick.oy;
      const d = Math.hypot(dx, dy);
      // The base follows the thumb past the edge, so swinging the aim back the
      // other way takes one travel, not one travel plus however far it went.
      if (d > AIM_R) {
        this.aimStick.ox = here.x - (dx / d) * AIM_R;
        this.aimStick.oy = here.y - (dy / d) * AIM_R;
        dx = (dx / d) * AIM_R; dy = (dy / d) * AIM_R;
      }
      out.firing = true;
    } else {
      this.attackId = -1;
      this.aimStick = null;
      this.aimPrev = null;
    }
    const moved: Vec2 = this.aimPrev ? { x: here.x - this.aimPrev.x, y: here.y - this.aimPrev.y } : { x: 0, y: 0 };
    this.aimPrev = attack ? { x: here.x, y: here.y } : null;
    out.aimDir = this.aim.update(dt, {
      active: !!attack, fresh,
      nx: dx / AIM_R, ny: dy / AIM_R, dead: AIM_DEAD / AIM_R,
      world: here, delta: moved, eye, view,
    });
    this.aimFade += ((this.aimStick ? 1 : 0) - this.aimFade) * Math.min(1, dt * 14);

    // --- weapon pad ---------------------------------------------------------
    let padPtr = byId.get(this.padId);
    if (padPtr && padPtr.role !== 'pad') padPtr = undefined;
    if (this.wheelOpen && !padPtr) {
      this.wheelOpen = false;
      out.wheelReleased = true;
      this.padId = -1;
    }
    if (padPtr) out.wheelPointer = toWorld(padPtr.x, padPtr.y);
    out.wheelOpen = this.wheelOpen;
    this.padPress += ((this.wheelOpen ? 1 : 0) - this.padPress) * Math.min(1, dt * 16);

    return out;
  }

  reset(): void {
    this.stick = null;
    this.attackId = -1;
    this.padId = -1;
    this.wheelOpen = false;
    this.aimStick = null;
    this.aimPrev = null;
    this.aim.reset();
  }

  // -------------------------------------------------------------- drawing ---

  /** The stick, drawn only while a thumb is actually on it. */
  drawStick(sk: Sketch): void {
    if (this.stickFade <= 0.01 || !this.stick) return;
    const c = sk.ctx;
    const s = this.stick;
    const a = this.stickFade;
    let dx = s.x - s.ox, dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R; }

    c.save();
    c.strokeStyle = '#000';
    c.fillStyle = '#000';

    // Base ring.
    c.globalAlpha = 0.22 * a;
    c.lineWidth = 3;
    sk.polyPath(ring(s.ox, s.oy, STICK_R, 16), 2);
    c.stroke();

    // Up / down affordances light up as the thumb reaches them.
    const ny = dy / STICK_R, up = -ny;
    c.globalAlpha = (0.16 + Math.max(0, up) * 0.5) * a;
    inkText(sk, 'JUMP', s.ox, s.oy - STICK_R - 16, 15, { alpha: c.globalAlpha });
    c.globalAlpha = (0.16 + Math.max(0, ny) * 0.5) * a;
    inkText(sk, 'CROUCH', s.ox, s.oy + STICK_R + 16, 15, { alpha: c.globalAlpha });

    // Knob.
    c.globalAlpha = 0.38 * a;
    sk.polyPath(ring(s.ox + dx, s.oy + dy, 27, 12), 1.6);
    c.fill();
    c.globalAlpha = 0.5 * a;
    c.lineWidth = 3;
    sk.polyPath(ring(s.ox + dx, s.oy + dy, 27, 12), 1.6);
    c.stroke();
    c.restore();
  }

  /** The translucent weapon pad. Hidden while the fan it opened is showing. */
  drawPad(sk: Sketch, view: { w: number; h: number }, icon: (x: number, y: number, s: number) => void): void {
    const c = sk.ctx;
    const p = this.padCentre(view);
    const fade = 1 - this.padPress;
    if (fade <= 0.02) return;
    c.save();
    c.globalAlpha = (0.26 + this.padPress * 0.3) * fade;
    c.fillStyle = '#fff';
    sk.polyPath(ring(p.x, p.y, this.padR, 10), 1.4);
    c.fill();
    c.strokeStyle = '#000';
    c.lineWidth = 3;
    sk.polyPath(ring(p.x, p.y, this.padR, 10), 1.4);
    c.stroke();
    c.globalAlpha = (0.5 + this.padPress * 0.4) * fade;
    c.fillStyle = '#000';
    icon(p.x, p.y - 2, this.padR * 1.15);
    c.globalAlpha = 0.4 * fade;
    inkText(sk, 'HOLD', p.x, p.y + this.padR + 13, 12, { alpha: 0.4 * fade });
    c.restore();
  }

  /**
   * The aiming stick under the thumb, and a mark out in front of `from` - the
   * figure's shoulder - showing which way the aim it is steering now points.
   */
  drawAim(sk: Sketch, time: number, from: Vec2): void {
    if (this.aimFade <= 0.01 || !this.aimStick) return;
    const c = sk.ctx;
    const s = this.aimStick;
    const a = this.aimFade;
    let dx = s.x - s.ox, dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    if (d > AIM_R) { dx = (dx / d) * AIM_R; dy = (dy / d) * AIM_R; }

    c.save();
    c.strokeStyle = '#000';
    c.fillStyle = '#000';

    c.globalAlpha = 0.2 * a;
    c.lineWidth = 3;
    sk.polyPath(ring(s.ox, s.oy, AIM_R, 14), 2);
    c.stroke();

    c.globalAlpha = 0.34 * a;
    sk.polyPath(ring(s.ox + dx, s.oy + dy, 22, 12), 1.6);
    c.fill();
    c.globalAlpha = 0.46 * a;
    sk.polyPath(ring(s.ox + dx, s.oy + dy, 22, 12), 1.6);
    c.stroke();

    // Where that adds up to on him, so the aim is readable without hunting for
    // the arm. CROSSHAIR mode parks a mark at a real spot in the world, so that
    // is what gets drawn; every other mode only has a direction, and shows it
    // as a ring out along the line he is about to swing down.
    const dir = this.aim.dir;
    const mark = this.aim.cross ?? (dir && { x: from.x + dir.x * AIM_MARK, y: from.y + dir.y * AIM_MARK });
    if (mark) {
      const r = 18 + Math.sin(time * 8) * 2;
      c.globalAlpha = 0.5 * a;
      c.lineWidth = 2.4;
      sk.polyPath(ring(mark.x, mark.y, r, 9), 1.4);
      c.stroke();
      if (this.aim.cross) {
        // A parked mark is a place, not a heading: cross it so it reads as one.
        c.globalAlpha = 0.4 * a;
        sk.line({ x: mark.x - r * 1.5, y: mark.y }, { x: mark.x + r * 1.5, y: mark.y }, 1.8, 1, 0.4);
        sk.line({ x: mark.x, y: mark.y - r * 1.5 }, { x: mark.x, y: mark.y + r * 1.5 }, 1.8, 1, 0.4);
      }
    }
    c.restore();
  }
}

function ring(x: number, y: number, r: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  return pts;
}
