import { angleDelta, clamp, dampAngle, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import { hitRect, inkText, measureText, type Rect } from './ui';

/**
 * How the aiming thumb becomes an aim direction.
 *
 * A stick is not a crosshair. Reading its angle straight off is fine for
 * swinging a bat, where anywhere in the right half of the world is a hit, but
 * for a rifle it is hopeless: near the vertical a couple of degrees of thumb
 * wobble crosses the axis and spins the whole figure round. These are the
 * usual answers to that, kept side by side so they can be felt against each
 * other rather than argued about.
 */
export type AimMode = 'smooth' | 'direct' | 'elevation' | 'crosshair' | 'absolute' | 'snap8';

export interface AimModeInfo { id: AimMode; name: string; blurb: string }

export const AIM_MODES: AimModeInfo[] = [
  { id: 'smooth', name: 'EASED', blurb: 'free aim that swings at a capped speed — a nudge creeps, a shove whips' },
  { id: 'crosshair', name: 'CROSSHAIR', blurb: 'drag a crosshair round the world like a trackpad' },
  { id: 'elevation', name: 'ELEVATION', blurb: 'sideways picks the side, up and down set the angle' },
  { id: 'direct', name: 'DIRECT', blurb: 'the raw stick angle, instantly — fastest, twitchiest' },
  { id: 'absolute', name: 'TOUCH POINT', blurb: 'aim straight at the spot under your thumb' },
  { id: 'snap8', name: 'EIGHT WAY', blurb: 'locked to the eight compass directions' },
];

const SENS = [
  { name: 'SLOW', k: 0.55 },
  { name: 'MED', k: 1 },
  { name: 'FAST', k: 1.8 },
];

export interface AimSettings {
  mode: AimMode;
  /** Index into SENS. */
  sens: number;
  /** Keep the figure facing where he was while the aim is near vertical. */
  guard: boolean;
}

const STORE = 'pwnage.aim.v1';

function load(): AimSettings {
  const fallback: AimSettings = { mode: 'smooth', sens: 1, guard: true };
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return fallback;
    const got = JSON.parse(raw) as Partial<AimSettings>;
    return {
      mode: AIM_MODES.some((m) => m.id === got.mode) ? (got.mode as AimMode) : fallback.mode,
      sens: typeof got.sens === 'number' ? clamp(Math.round(got.sens), 0, SENS.length - 1) : fallback.sens,
      guard: typeof got.guard === 'boolean' ? got.guard : fallback.guard,
    };
  } catch {
    return fallback;   // private mode, blocked storage: the defaults still play
  }
}

export const aimSettings: AimSettings = load();

export function saveAimSettings(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(aimSettings));
  } catch {
    /* Not being able to remember the choice is not worth failing over. */
  }
}

/** How far off vertical the aim must lean before it is allowed to turn him. */
export const FACE_GUARD = 0.34;

// --------------------------------------------------------------- solving ---

/** How fast EASED swings at full deflection, in radians a second. */
const TURN_MAX = 7;
/** ELEVATION: how far sideways the thumb must go to change which side he faces. */
const SIDE_ON = 0.5;
/** ELEVATION: the thumb travel that maps to the full up/down range, and that range. */
const ELEV_SPAN = 0.8;
const ELEV_MAX = 1.5;
/** CROSSHAIR: where it starts, and how far it travels per unit of thumb. */
const CROSS_DIST = 320;
const CROSS_GAIN = 1;

export interface AimInput {
  /** A thumb is on the aiming stick. */
  active: boolean;
  /** It landed this frame. */
  fresh: boolean;
  /** Stick deflection, each component -1..1, magnitude already clamped to 1. */
  nx: number;
  ny: number;
  /** Deflection below this is not a drag at all. */
  dead: number;
  /** Where the thumb is, and how far it moved this frame, in world units. */
  world: Vec2;
  delta: Vec2;
  /** The shoulder the aim is cast from. */
  eye: Vec2;
  view: { w: number; h: number };
}

/** Turns thumb movement into an aim direction, whichever way is selected. */
export class AimSolver {
  /** Unit vector, or null until the aim has been used at all. */
  dir: Vec2 | null = null;
  /** Where CROSSHAIR mode has parked its mark, for drawing. */
  cross: Vec2 | null = null;
  private angle = 0;
  private side = 1;

  reset(): void {
    this.dir = null;
    this.cross = null;
    this.angle = 0;
    this.side = 1;
  }

  update(dt: number, i: AimInput): Vec2 | null {
    if (!i.active) {
      this.cross = null;
      return this.dir;      // sticky: a lifted thumb leaves the aim where it was
    }
    if (i.fresh && this.dir) this.angle = Math.atan2(this.dir.y, this.dir.x);

    const k = SENS[clamp(aimSettings.sens, 0, SENS.length - 1)].k;
    const m = Math.min(1, Math.hypot(i.nx, i.ny));
    const pushed = m > i.dead;
    const push = pushed ? (m - i.dead) / (1 - i.dead) : 0;

    switch (aimSettings.mode) {
      case 'direct':
        if (pushed) this.set(Math.atan2(i.ny, i.nx));
        break;

      case 'smooth': {
        // Speed rises with the square of the push, so the first few degrees of
        // thumb are for placing a shot and the far edge is for spinning round.
        if (pushed) {
          const step = TURN_MAX * k * push * push * dt;
          const to = Math.atan2(i.ny, i.nx);
          this.set(this.angle + clamp(angleDelta(this.angle, to), -step, step));
        }
        break;
      }

      case 'elevation': {
        // Two separate controls sharing one thumb: which way he faces, and how
        // steeply. Pushing straight down can never cross the axis by accident
        // because down does not touch the side at all.
        if (Math.abs(i.nx) > SIDE_ON) this.side = i.nx >= 0 ? 1 : -1;
        if (pushed) {
          const el = clamp(i.ny / ELEV_SPAN, -1, 1) * ELEV_MAX;
          const to = Math.atan2(Math.sin(el), this.side * Math.cos(el));
          this.set(dampAngle(this.angle, to, 16 * k, dt));
        }
        break;
      }

      case 'crosshair': {
        // A trackpad, not a stick: the mark keeps the world position the thumb
        // pushed it to, so it does not spring back and cannot flip on a wobble.
        if (!this.cross) {
          const d = this.dir ?? { x: this.side, y: 0 };
          this.cross = { x: i.eye.x + d.x * CROSS_DIST, y: i.eye.y + d.y * CROSS_DIST };
        }
        this.cross.x = clamp(this.cross.x + i.delta.x * CROSS_GAIN * k, 6, i.view.w - 6);
        this.cross.y = clamp(this.cross.y + i.delta.y * CROSS_GAIN * k, 6, i.view.h - 6);
        const dx = this.cross.x - i.eye.x, dy = this.cross.y - i.eye.y;
        if (Math.hypot(dx, dy) > 1) this.set(Math.atan2(dy, dx));
        break;
      }

      case 'absolute': {
        const dx = i.world.x - i.eye.x, dy = i.world.y - i.eye.y;
        if (Math.hypot(dx, dy) > 24) this.set(Math.atan2(dy, dx));
        break;
      }

      case 'snap8': {
        if (pushed) {
          const to = Math.atan2(i.ny, i.nx);
          const step = TAU / 8;
          // Hysteresis: it takes leaving the notch by a good margin to move on,
          // so a thumb sitting on a boundary does not rattle between two.
          if (!this.dir || Math.abs(angleDelta(this.angle, to)) > step * 0.72) {
            this.set(Math.round(to / step) * step);
          }
        }
        break;
      }
    }
    return this.dir;
  }

  private set(a: number): void {
    this.angle = a;
    this.dir = { x: Math.cos(a), y: Math.sin(a) };
    if (Math.abs(this.dir.x) > 0.2) this.side = this.dir.x >= 0 ? 1 : -1;
  }
}

// ----------------------------------------------------------------- panel ---

/**
 * A tap-sized chip and the list it opens, so the modes can be swapped mid-fight
 * on the device they are meant for rather than guessed at from a desk.
 */
export class AimPanel {
  open = false;
  chip: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rows: Array<{ r: Rect; act: () => void }> = [];
  private panel: Rect = { x: 0, y: 0, w: 0, h: 0 };

  get modeName(): string {
    return AIM_MODES.find((m) => m.id === aimSettings.mode)?.name ?? '?';
  }

  /**
   * World units are not screen units - a portrait phone runs about 2.1 world
   * units to the CSS pixel - so everything here is sized off the view rather
   * than in constants, or the taps come out half the size of a thumb.
   */
  layout(view: { w: number; h: number }, safe: { top: number; right: number }): void {
    const h = clamp(view.h * 0.05, 44, 92);
    const w = Math.min(view.w * 0.36, h * 3.6);
    this.chip = { x: view.w - w - h * 0.2 - safe.right, y: h * 0.2 + safe.top, w, h };
  }

  /**
   * Routes a press. Returns true when the panel took it, which is also the
   * signal not to let it reach the game underneath.
   */
  press(p: Vec2): boolean {
    if (hitRect(this.chip, p)) {
      this.open = !this.open;
      return true;
    }
    if (!this.open) return false;
    for (const row of this.rows) {
      if (hitRect(row.r, p)) {
        row.act();
        saveAimSettings();
        return true;
      }
    }
    // Anywhere else dismisses it, and is swallowed rather than fired.
    this.open = false;
    return true;
  }

  draw(sk: Sketch, view: { w: number; h: number }): void {
    const c = sk.ctx;
    c.save();
    plate(sk, this.chip, false);
    inkText(sk, `AIM · ${this.modeName}`, this.chip.x + this.chip.w / 2, this.chip.y + this.chip.h / 2 + 1,
      this.chip.h * 0.4, { alpha: 0.85, wobble: 0.4 });
    c.restore();
    if (!this.open) { this.rows = []; return; }

    this.rows = [];
    const rowH = clamp(view.h * 0.062, 52, 128);
    const pad = rowH * 0.2;
    const footH = rowH * 0.8;
    const title = rowH * 0.34;
    const w = Math.min(view.w - pad * 2, view.h * 0.62);
    const h = pad * 2 + title * 2 + AIM_MODES.length * rowH + footH * 2 + pad;
    const x = (view.w - w) / 2;
    const y = clamp(this.chip.y + this.chip.h + pad, 0, Math.max(0, view.h - h - pad));
    this.panel = { x, y, w, h };

    c.save();
    // Dim the field behind it, the same way the weapon wheel does.
    c.globalAlpha = 0.62;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, view.w, view.h);
    c.globalAlpha = 1;
    plate(sk, this.panel, false);

    let ty = y + pad + title * 0.6;
    inkText(sk, 'AIM CONTROL — TOUCH', x + w / 2, ty, title, { alpha: 0.9 });
    ty += title * 0.6 + pad;

    for (const m of AIM_MODES) {
      const r: Rect = { x: x + pad, y: ty, w: w - pad * 2, h: rowH - pad * 0.4 };
      const on = m.id === aimSettings.mode;
      plate(sk, r, on);
      const ink = on ? '#fff' : '#000';
      inkText(sk, m.name, r.x + pad * 0.8, r.y + r.h * 0.34, rowH * 0.29,
        { align: 'left', color: ink, alpha: on ? 1 : 0.9 });
      fitText(sk, m.blurb.toUpperCase(), r.x + pad * 0.8, r.y + r.h * 0.71, r.w - pad * 1.6, rowH * 0.19,
        { align: 'left', color: ink, alpha: on ? 0.85 : 0.5, wobble: 0.35 });
      this.rows.push({ r, act: () => { aimSettings.mode = m.id; this.open = false; } });
      ty += rowH;
    }

    ty += pad * 0.4;
    this.chips(sk, x + pad, ty, w - pad * 2, footH - pad * 0.4, 'SPEED',
      SENS.map((s, i) => ({ label: s.name, on: i === aimSettings.sens, act: () => { aimSettings.sens = i; } })));
    ty += footH;
    this.chips(sk, x + pad, ty, w - pad * 2, footH - pad * 0.4, 'TURN GUARD',
      [
        { label: 'ON', on: aimSettings.guard, act: () => { aimSettings.guard = true; } },
        { label: 'OFF', on: !aimSettings.guard, act: () => { aimSettings.guard = false; } },
      ]);
    c.restore();
  }

  /** A labelled row of little toggles. */
  private chips(
    sk: Sketch, x: number, y: number, w: number, h: number, label: string,
    opts: Array<{ label: string; on: boolean; act: () => void }>,
  ): void {
    const size = h * 0.34;
    inkText(sk, label, x, y + h / 2, size, { align: 'left', alpha: 0.6, wobble: 0.35 });
    const labelW = measureText(sk, label, size) + h * 0.3;
    const gap = h * 0.14;
    const bw = (w - labelW - gap * (opts.length - 1)) / opts.length;
    opts.forEach((o, i) => {
      const r: Rect = { x: x + labelW + i * (bw + gap), y, w: bw, h };
      plate(sk, r, o.on);
      inkText(sk, o.label, r.x + r.w / 2, r.y + r.h / 2 + 1, size * 1.1,
        { color: o.on ? '#fff' : '#000', alpha: o.on ? 1 : 0.75 });
      this.rows.push({ r, act: o.act });
    });
  }
}

/** Left-aligned text shrunk, if it has to be, to stay inside `w`. */
function fitText(
  sk: Sketch, text: string, x: number, y: number, w: number, size: number,
  opts: Parameters<typeof inkText>[5],
): void {
  const wide = measureText(sk, text, size);
  inkText(sk, text, x, y, wide > w ? size * (w / wide) : size, opts);
}

/** A rough inked box, filled when it is the one in force. */
function plate(sk: Sketch, r: Rect, filled: boolean): void {
  const c = sk.ctx;
  const pts: Vec2[] = [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
  c.fillStyle = filled ? '#000' : '#fff';
  sk.polyPath(pts, 1.4);
  c.fill();
  c.strokeStyle = '#000';
  c.lineWidth = filled ? 3.4 : 2.4;
  sk.polyPath(pts, 1.4);
  c.stroke();
}
