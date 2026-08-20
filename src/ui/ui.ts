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

export const hitRect = (r: Rect, p: Vec2): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

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
 * The TAB wheel. Ten slots on a ring; the highlighted one swells and shows its
 * name in the middle. Selection follows the mouse angle or the number keys.
 */
export class WeaponWheel {
  open = 0;              // 0..1 reveal
  selected = 0;
  hovered = 0;
  private popped: number[] = [];

  update(dt: number, isOpen: boolean, pointer: Vec2, center: Vec2, count: number, numberKey: number | null): boolean {
    const target = isOpen ? 1 : 0;
    this.open += (target - this.open) * Math.min(1, dt * 18);
    if (this.open < 0.002) this.open = 0;
    if (!isOpen) return false;

    const prev = this.hovered;
    if (numberKey !== null && numberKey < count) {
      this.hovered = numberKey;
    } else {
      const dx = pointer.x - center.x, dy = pointer.y - center.y;
      if (Math.hypot(dx, dy) > 46) {
        // Slot 0 sits at the top, going clockwise.
        const a = Math.atan2(dy, dx) + Math.PI / 2;
        const norm = ((a % TAU) + TAU) % TAU;
        this.hovered = Math.round(norm / (TAU / count)) % count;
      }
    }
    if (this.popped.length !== count) this.popped = new Array(count).fill(0);
    for (let i = 0; i < count; i++) {
      const goal = i === this.hovered ? 1 : 0;
      this.popped[i] += (goal - this.popped[i]) * Math.min(1, dt * 16);
    }
    return this.hovered !== prev;
  }

  draw(sk: Sketch, center: Vec2, weapons: Weapon[], equippedIndex: number): void {
    if (this.open <= 0.001) return;
    const c = sk.ctx;
    const k = easeOutCubic(this.open);
    const n = weapons.length;
    const radius = 210 * k;

    // Dim the field so the wheel reads clearly over the action.
    c.save();
    c.globalAlpha = 0.72 * k;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, 1280, 720);
    c.restore();

    c.save();
    c.globalAlpha = k;
    c.strokeStyle = '#000';

    // Guide ring.
    c.lineWidth = 2;
    c.globalAlpha = 0.35 * k;
    const ring: Vec2[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU;
      ring.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
    }
    sk.polyPath(ring, 2.5);
    c.stroke();
    c.globalAlpha = k;

    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * TAU;
      const pop = this.popped[i] ?? 0;
      const r = radius + pop * 16;
      const x = center.x + Math.cos(a) * r;
      const y = center.y + Math.sin(a) * r;
      const size = (34 + pop * 16) * easeOutBack(clamp(k * 1.4 - i * 0.02, 0, 1));
      const isEquipped = i === equippedIndex;

      // Slot plate.
      c.lineWidth = 2.4 + pop * 2.4;
      if (pop > 0.02) {
        c.fillStyle = '#000';
        c.globalAlpha = k * pop;
        sk.polyPath(slotPts(x, y, size * 1.05), 1.6);
        c.fill();
        c.globalAlpha = k;
      }
      c.fillStyle = '#fff';
      if (pop <= 0.02) { sk.polyPath(slotPts(x, y, size), 1.6); c.fill(); }
      sk.polyPath(slotPts(x, y, size), 1.6);
      c.stroke();

      // Icon, drawn in white when the slot is highlighted.
      c.strokeStyle = pop > 0.5 ? '#fff' : '#000';
      c.fillStyle = pop > 0.5 ? '#fff' : '#000';
      weapons[i].icon(sk, x, y - 2, size * 1.05);
      c.strokeStyle = '#000';
      c.fillStyle = '#000';

      // Slot number, plus a tick on whatever is currently equipped.
      inkText(sk, String((i + 1) % 10), x, y + size * 0.78, 16, { alpha: k * 0.85, wobble: 0.4 });
      if (isEquipped) {
        c.lineWidth = 2.2;
        sk.line({ x: x - size * 0.7, y: y - size * 0.72 }, { x: x - size * 0.45, y: y - size * 0.5 }, 2.2, 1, 0.4);
        sk.line({ x: x - size * 0.45, y: y - size * 0.5 }, { x: x - size * 0.1, y: y - size * 0.95 }, 2.2, 1, 0.4);
      }
    }

    // Centre: the highlighted weapon's name and one-line pitch.
    const w = weapons[this.hovered];
    if (w) {
      inkText(sk, w.name, center.x, center.y - 12, 34, { alpha: k, wobble: 1 });
      inkText(sk, w.tagline.toUpperCase(), center.x, center.y + 18, 15, { alpha: k * 0.7, wobble: 0.5 });
      inkText(sk, 'RELEASE TAB TO EQUIP', center.x, center.y + 48, 13, { alpha: k * 0.45, wobble: 0.4 });
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
