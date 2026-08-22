import { clamp, easeOutBack, easeOutCubic, hashNoise, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';
import type { Weapon } from '../game/weapons';

const FONT_STACK = '"Trebuchet MS", "Segoe UI", Verdana, sans-serif';

/**
 * Text is drawn twice with a sub-pixel offset so the letters look inked rather
 * than typeset, matching the wobble on everything else.
 */
export function inkText(
  sk: Sketch, text: string, x: number, y: number, size: number,
  opts: { align?: CanvasTextAlign; weight?: string; alpha?: number; color?: string; wobble?: number; baseline?: CanvasTextBaseline } = {},
): void {
  const c = sk.ctx;
  c.save();
  c.font = `${opts.weight ?? 'bold'} ${size}px ${FONT_STACK}`;
  c.textAlign = opts.align ?? 'center';
  c.textBaseline = opts.baseline ?? 'middle';
  c.globalAlpha = opts.alpha ?? 1;
  c.fillStyle = opts.color ?? '#000';
  const w = opts.wobble ?? 0.7;
  const j = (k: number) => hashNoise(k + Math.round(x), sk.boil) * w;
  c.fillText(text, x + j(1), y + j(2));
  c.globalAlpha = (opts.alpha ?? 1) * 0.55;
  c.fillText(text, x + j(3), y + j(4));
  c.restore();
}

export function measureText(sk: Sketch, text: string, size: number, weight = 'bold'): number {
  const c = sk.ctx;
  c.save();
  c.font = `${weight} ${size}px ${FONT_STACK}`;
  const w = c.measureText(text).width;
  c.restore();
  return w;
}

export interface Rect { x: number; y: number; w: number; h: number; }

/**
 * The key that equips slot `i`. The number row runs out at ten weapons, so the
 * two after it borrow the keys immediately to its right.
 */
export const slotKey = (i: number): string =>
  i < 9 ? String(i + 1) : i === 9 ? '0' : i === 10 ? '-' : '=';

export const hitRect = (r: Rect, p: Vec2): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * The impact border round whatever a gamepad has selected.
 *
 * Nothing else on screen is a rough double outline with its corners struck
 * through, so it reads as "this one" at a glance from across a room, which is
 * the whole job: a pad player cannot point, and has to be told.
 */
export function focusRing(sk: Sketch, r: Rect, time: number): void {
  const c = sk.ctx;
  const beat = 1 + Math.sin(time * 6) * 0.5;
  const pad = 7 + beat;
  const box = (g: number): Vec2[] => [
    { x: r.x - g, y: r.y - g }, { x: r.x + r.w + g, y: r.y - g },
    { x: r.x + r.w + g, y: r.y + r.h + g }, { x: r.x - g, y: r.y + r.h + g },
  ];
  c.save();
  // Difference, so it lands white on a filled row and black on an empty one
  // without either having to know the ring is there.
  c.globalCompositeOperation = 'difference';
  c.strokeStyle = '#fff';
  c.lineWidth = 3.4;
  sk.polyPath(box(pad), 2.2, true);
  c.stroke();
  c.lineWidth = 1.8;
  sk.polyPath(box(pad + 6), 3, true);
  c.stroke();
  // Struck corners: four short diagonals, the way a hit is drawn here.
  const tick = 9 + beat * 2;
  const corners: Array<[number, number, number, number]> = [
    [r.x - pad, r.y - pad, -1, -1], [r.x + r.w + pad, r.y - pad, 1, -1],
    [r.x + r.w + pad, r.y + r.h + pad, 1, 1], [r.x - pad, r.y + r.h + pad, -1, 1],
  ];
  c.lineWidth = 3;
  for (const [x, y, sx, sy] of corners) {
    sk.line({ x, y }, { x: x + sx * tick, y: y + sy * tick }, 3, 1, 0.8);
  }
  c.restore();
}

/** A hand-drawn button: rough box, inked label, inverts on hover. */
export function inkButton(sk: Sketch, r: Rect, label: string, hovered: boolean, size = 30): void {
  const c = sk.ctx;
  const pad = hovered ? 3 : 0;
  const pts: Vec2[] = [
    { x: r.x - pad, y: r.y - pad },
    { x: r.x + r.w + pad, y: r.y - pad },
    { x: r.x + r.w + pad, y: r.y + r.h + pad },
    { x: r.x - pad, y: r.y + r.h + pad },
  ];
  c.strokeStyle = '#000';
  if (hovered) {
    c.fillStyle = '#000';
    sk.polyPath(pts, 1.6);
    c.fill();
  }
  c.lineWidth = hovered ? 4.5 : 3.4;
  sk.polyPath(pts, 1.6);
  c.stroke();
  inkText(sk, label, r.x + r.w / 2, r.y + r.h / 2 + 1, size, {
    color: hovered ? '#fff' : '#000',
    wobble: hovered ? 1.1 : 0.6,
  });
}

/** The wall-destruction meter across the top of the screen. */
export function drawProgress(sk: Sketch, cx: number, y: number, w: number, frac: number, label: string): void {
  const c = sk.ctx;
  const h = 22;
  const x = cx - w / 2;
  c.strokeStyle = '#000';
  c.fillStyle = '#000';
  c.lineWidth = 3;
  sk.polyPath([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], 1.4);
  c.stroke();
  const fw = Math.max(0, (w - 8) * clamp(frac, 0, 1));
  if (fw > 1) {
    // The fill has a ragged right edge, as if it were scribbled in.
    const pts: Vec2[] = [{ x: x + 4, y: y + 4 }, { x: x + 4 + fw, y: y + 4 }];
    for (let i = 0; i <= 4; i++) {
      pts.push({ x: x + 4 + fw + hashNoise(i, sk.boil) * 3, y: y + 4 + (i / 4) * (h - 8) });
    }
    pts.push({ x: x + 4, y: y + h - 4 });
    sk.polyPath(pts, 1.1);
    c.fill();
  }
  inkText(sk, label, cx, y - 15, 19, { wobble: 0.5 });
}

/**
 * Where the slots sit. A full ring works with a mouse at screen centre, but a
 * thumb dragging up from a button at the bottom edge cannot reach the lower
 * half of a ring - so touch gets a fan spread above its anchor instead.
 */
export type WheelLayout =
  | { kind: 'ring'; anchor: Vec2; radius: number }
  | { kind: 'fan'; anchor: Vec2; radius: number; from: number; to: number };

function slotAngle(layout: WheelLayout, i: number, n: number): number {
  if (layout.kind === 'ring') return -Math.PI / 2 + (i / n) * TAU;
  return layout.from + (n <= 1 ? 0.5 : i / (n - 1)) * (layout.to - layout.from);
}

function slotPos(layout: WheelLayout, i: number, n: number, extra = 0): Vec2 {
  const a = slotAngle(layout, i, n);
  const r = layout.radius + extra;
  return { x: layout.anchor.x + Math.cos(a) * r, y: layout.anchor.y + Math.sin(a) * r };
}

/**
 * The weapon wheel. The highlighted slot swells and shows its name; selection
 * is by nearest slot to the pointer, which is what makes a touch drag feel
 * right - you go towards what you want rather than aiming an angle.
 */
export class WeaponWheel {
  open = 0;              // 0..1 reveal
  hovered = 0;
  private popped: number[] = [];

  /** Returns true when the highlighted slot changed this frame. */
  update(
    dt: number, isOpen: boolean, pointer: Vec2, layout: WheelLayout,
    count: number, numberKey: number | null,
  ): boolean {
    const target = isOpen ? 1 : 0;
    this.open += (target - this.open) * Math.min(1, dt * 18);
    if (this.open < 0.002) this.open = 0;
    if (this.popped.length !== count) this.popped = new Array(count).fill(0);
    if (!isOpen) return false;

    const prev = this.hovered;
    if (numberKey !== null && numberKey < count) {
      this.hovered = numberKey;
    } else {
      const dx = pointer.x - layout.anchor.x, dy = pointer.y - layout.anchor.y;
      // A dead zone around the anchor keeps the selection still until the
      // pointer actually commits to a direction.
      if (Math.hypot(dx, dy) > layout.radius * 0.28) {
        let best = this.hovered, bestD = Infinity;
        for (let i = 0; i < count; i++) {
          const p = slotPos(layout, i, count);
          const d = (p.x - pointer.x) ** 2 + (p.y - pointer.y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        this.hovered = best;
      }
    }
    for (let i = 0; i < count; i++) {
      const goal = i === this.hovered ? 1 : 0;
      this.popped[i] += (goal - this.popped[i]) * Math.min(1, dt * 16);
    }
    return this.hovered !== prev;
  }

  draw(
    sk: Sketch, layout: WheelLayout, weapons: Weapon[], equippedIndex: number,
    view: { w: number; h: number }, hint: string,
  ): void {
    if (this.open <= 0.001) return;
    const c = sk.ctx;
    const k = easeOutCubic(this.open);
    const n = weapons.length;
    // Size the slots from the spacing actually available along the arc, so a
    // narrow fan on a phone tightens up instead of overlapping itself.
    const span = layout.kind === 'ring' ? TAU : layout.to - layout.from;
    const gaps = layout.kind === 'ring' ? n : Math.max(1, n - 1);
    const slotSize = Math.min(38, (layout.radius * span / gaps) * 0.46);

    // Dim the field so the wheel reads clearly over the action.
    c.save();
    c.globalAlpha = 0.74 * k;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, view.w, view.h);
    c.restore();

    c.save();
    c.globalAlpha = k;
    c.strokeStyle = '#000';

    // Guide arc through the slots.
    c.lineWidth = 2;
    c.globalAlpha = 0.3 * k;
    const guide: Vec2[] = [];
    const steps = 44;
    for (let i = 0; i <= steps; i++) {
      const a = layout.kind === 'ring'
        ? (i / steps) * TAU
        : layout.from + (i / steps) * (layout.to - layout.from);
      guide.push({ x: layout.anchor.x + Math.cos(a) * layout.radius, y: layout.anchor.y + Math.sin(a) * layout.radius });
    }
    sk.polyPath(guide, 2.4, layout.kind === 'ring');
    c.stroke();
    c.globalAlpha = k;

    for (let i = 0; i < n; i++) {
      const pop = this.popped[i] ?? 0;
      const p = slotPos(layout, i, n, pop * 18 * (layout.kind === 'ring' ? 1 : -1));
      const size = (slotSize + pop * slotSize * 0.42) * easeOutBack(clamp(k * 1.4 - i * 0.02, 0, 1));
      const isEquipped = i === equippedIndex;

      c.lineWidth = 2.4 + pop * 2.4;
      if (pop > 0.02) {
        c.fillStyle = '#000';
        c.globalAlpha = k * pop;
        sk.polyPath(slotPts(p.x, p.y, size * 1.05), 1.6);
        c.fill();
        c.globalAlpha = k;
      }
      c.fillStyle = '#fff';
      if (pop <= 0.02) { sk.polyPath(slotPts(p.x, p.y, size), 1.6); c.fill(); }
      sk.polyPath(slotPts(p.x, p.y, size), 1.6);
      c.stroke();

      // Icon, drawn in white when the slot is highlighted.
      c.strokeStyle = pop > 0.5 ? '#fff' : '#000';
      c.fillStyle = pop > 0.5 ? '#fff' : '#000';
      weapons[i].icon(sk, p.x, p.y - 2, size * 1.05);
      c.strokeStyle = '#000';
      c.fillStyle = '#000';

      inkText(sk, slotKey(i), p.x, p.y + size * 0.78, size * 0.44, { alpha: k * 0.85, wobble: 0.4 });
      if (isEquipped) {
        c.lineWidth = 2.2;
        sk.line({ x: p.x - size * 0.7, y: p.y - size * 0.72 }, { x: p.x - size * 0.45, y: p.y - size * 0.5 }, 2.2, 1, 0.4);
        sk.line({ x: p.x - size * 0.45, y: p.y - size * 0.5 }, { x: p.x - size * 0.1, y: p.y - size * 0.95 }, 2.2, 1, 0.4);
      }
    }

    // The highlighted weapon's name and one-line pitch. A ring can hold them in
    // its middle; a fan has to stack them clear above the arc, or the label
    // lands on top of the slots at the apex.
    const w = weapons[this.hovered];
    if (w) {
      const nameSize = Math.min(34, view.w * 0.055);
      const x = layout.kind === 'ring' ? layout.anchor.x : view.w / 2;
      const top = layout.kind === 'ring'
        ? layout.anchor.y - 12
        : layout.anchor.y - layout.radius - slotSize - 14 - nameSize * 1.6;
      inkText(sk, w.name, x, top, nameSize, { alpha: k, wobble: 1 });
      inkText(sk, w.tagline.toUpperCase(), x, top + nameSize * 0.74, nameSize * 0.44, { alpha: k * 0.7, wobble: 0.5 });
      inkText(sk, hint, x, top + nameSize * 1.5, nameSize * 0.38, { alpha: k * 0.45, wobble: 0.4 });
    }
    c.restore();
  }
}

function slotPts(x: number, y: number, s: number): Vec2[] {
  const pts: Vec2[] = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.PI / 8;
    pts.push({ x: x + Math.cos(a) * s, y: y + Math.sin(a) * s });
  }
  return pts;
}
