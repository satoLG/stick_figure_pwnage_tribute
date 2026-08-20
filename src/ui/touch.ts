import { TAU, type Vec2 } from '../core/math';
import type { Input, Ptr } from '../core/input';
import type { Sketch } from '../core/sketch';
import type { WheelLayout } from './ui';
import { inkText } from './ui';

/** How far the stick knob travels before it reads as fully deflected. */
const STICK_R = 74;
const DEAD = 0.2;
const JUMP_ON = 0.44;
const JUMP_OFF = 0.3;
const CROUCH_ON = 0.46;

export interface TouchState {
  /** Analog walk, -1..1. */
  axis: number;
  crouch: boolean;
  jump: boolean;
  jumpHeld: boolean;
  aim: Vec2 | null;
  firing: boolean;
  firePressed: boolean;
  wheelOpen: boolean;
  wheelPointer: Vec2;
  /** True on the frame the wheel closed, meaning "equip what is highlighted". */
  wheelReleased: boolean;
}

/**
 * The on-screen controls.
 *
 * The left side of the screen is a floating stick: it appears wherever the
 * thumb lands, and its direction alone drives walking, crouching and jumping -
 * there are no separate buttons for those. The right side aims and attacks.
 * A translucent pad at the bottom centre opens the weapon fan while held; the
 * weapon the thumb is over when it lifts is the one equipped.
 */
export class TouchControls {
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private stickFade = 0;
  private jumpLatched = false;

  private attackId = -1;
  private aim: Vec2 | null = null;

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
    toWorld: (x: number, y: number) => Vec2,
  ): TouchState {
    this.pad = this.padCentre(view);
    this.padR = Math.min(46, view.w * 0.06 + 26);

    const out: TouchState = {
      axis: 0, crouch: false, jump: false, jumpHeld: false,
      aim: null, firing: false, firePressed: false,
      wheelOpen: false, wheelPointer: this.pad, wheelReleased: false,
    };

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
        out.firePressed = true;
      }
    }

    const byId = new Map<number, Ptr>();
    for (const p of input.pointers.values()) if (!p.justUp) byId.set(p.id, p);

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
    if (attack) {
      this.aim = toWorld(attack.x, attack.y);
      out.aim = this.aim;
      out.firing = true;
    } else {
      this.attackId = -1;
      out.aim = this.aim;   // keep facing the last target so he does not snap
    }

    // --- weapon pad ---------------------------------------------------------
    const padPtr = byId.get(this.padId);
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
    this.aim = null;
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

  /** A ring marking where the attacking finger is aiming. */
  drawAim(sk: Sketch, time: number): void {
    if (!this.aim || this.attackId < 0) return;
    const c = sk.ctx;
    c.save();
    c.strokeStyle = '#000';
    c.lineWidth = 2.4;
    c.globalAlpha = 0.55;
    sk.polyPath(ring(this.aim.x, this.aim.y, 20 + Math.sin(time * 8) * 2, 9), 1.4);
    c.stroke();
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
