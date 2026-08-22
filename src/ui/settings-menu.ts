import { audio } from '../core/audio';
import { clamp, type Vec2 } from '../core/math';
import {
  AIM_SPEEDS, musicVolume, saveSettings, settings, sfxVolume, VOLUMES,
} from '../core/settings';
import type { Sketch } from '../core/sketch';
import { focusRing, hitRect, inkText, measureText, type Rect } from './ui';

/** What the machine can be played with, and which of them is in hand. */
export interface InputReport {
  touch: boolean;
  desk: boolean;
  pad: string | null;
  active: 'touch' | 'desk' | 'pad';
}

/**
 * One selectable thing. `line` and `col` are its place in the grid a gamepad
 * walks: down and up step between rows of the card, left and right along one.
 */
interface Row { r: Rect; act: () => void; line: number; col: number }

/**
 * The settings menu: a chip in the top right and the card it opens.
 *
 * Everything in it takes effect the moment it is touched - no apply, no close
 * - and is written through to storage, so a choice survives the tab. The world
 * holds still while it is up, which is what makes it a menu rather than an
 * overlay you have to fight the game through.
 */
export class SettingsMenu {
  open = false;
  chip: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rows: Row[] = [];
  private card: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private pointer: Vec2 | null = null;
  /** Where the gamepad's selection is. Kept as a place, not an index, so it
   * survives the card being rebuilt every frame. */
  private focus = { line: 0, col: 0 };
  private line = 0;
  /** Only shown once a pad has actually moved it: a mouse does not need it. */
  padFocus = false;

  /** Where the cursor is, so the thing under it can show that it is under it. */
  hover(p: Vec2 | null): void {
    this.pointer = p;
  }

  private under(r: Rect): boolean {
    return !!this.pointer && this.open && hitRect(r, this.pointer);
  }

  /**
   * World units are not screen units - a portrait phone runs about 2.1 world
   * units to the CSS pixel - so this is all sized off the view rather than in
   * constants, or the taps come out half the size of a thumb.
   */
  layout(view: { w: number; h: number }, safe: { top: number; right: number }): void {
    const h = clamp(view.h * 0.05, 44, 92);
    this.chip = { x: view.w - h - h * 0.24 - safe.right, y: h * 0.24 + safe.top, w: h, h };
  }

  toggle(): void {
    this.open = !this.open;
    if (this.open) this.focus = { line: 0, col: 0 };
  }

  /** Steps the gamepad's selection. Returns true if it moved something. */
  moveFocus(dx: number, dy: number): boolean {
    if (!this.open || (dx === 0 && dy === 0) || !this.rows.length) return false;
    this.padFocus = true;
    const lines = [...new Set(this.rows.map((r) => r.line))].sort((a, b) => a - b);
    let li = Math.max(0, lines.indexOf(this.focus.line));
    if (dy !== 0) {
      li = (li + (dy > 0 ? 1 : -1) + lines.length) % lines.length;
      this.focus.line = lines[li];
      // Landing on a shorter row keeps as much of the column as it has.
      this.focus.col = Math.min(this.focus.col, this.count(this.focus.line) - 1);
    } else {
      const n = this.count(this.focus.line);
      this.focus.col = (this.focus.col + (dx > 0 ? 1 : -1) + n) % n;
    }
    return true;
  }

  private count(line: number): number {
    return Math.max(1, this.rows.filter((r) => r.line === line).length);
  }

  private selected(): Row | undefined {
    return this.rows.find((r) => r.line === this.focus.line && r.col === this.focus.col)
      ?? this.rows[0];
  }

  /** Fires whatever the gamepad has selected. */
  confirm(): boolean {
    const row = this.selected();
    if (!this.open || !row) return false;
    this.padFocus = true;
    row.act();
    saveSettings();
    return true;
  }

  /**
   * Routes a press. Returns true when the menu took it, which is also the
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
        saveSettings();
        return true;
      }
    }
    // Anywhere off the card dismisses it, and is swallowed rather than fired.
    if (!hitRect(this.card, p)) this.open = false;
    return true;
  }

  draw(sk: Sketch, view: { w: number; h: number }, input: InputReport, time: number): void {
    const c = sk.ctx;
    c.save();
    const onChip = !!this.pointer && hitRect(this.chip, this.pointer);
    plate(sk, onChip ? grow(this.chip, this.chip.h * 0.05) : this.chip, this.open);
    gear(sk, this.chip.x + this.chip.w / 2, this.chip.y + this.chip.h / 2,
      this.chip.h * (onChip ? 0.33 : 0.3), this.open ? '#fff' : '#000');
    c.restore();
    if (!this.open) { this.rows = []; return; }

    this.rows = [];
    this.line = 0;
    const rowH = clamp(view.h * 0.055, 46, 116);
    const pad = rowH * 0.24;
    const head = rowH * 0.7;
    const lines = 3;                       // touch, keyboard and mouse, gamepad
    const w = Math.min(view.w - pad * 2, view.h * 0.66);
    const h = pad * 2 + rowH * 0.8         // title
      + head + rowH * 2                    // audio
      + head + lines * rowH * 0.62 + rowH  // input
      + pad;
    const x = (view.w - w) / 2;
    const y = clamp(this.chip.y + this.chip.h + pad, 0, Math.max(0, view.h - h - pad));
    this.card = { x, y, w, h };

    // Dim the field behind it, the same way the weapon wheel does.
    c.save();
    c.globalAlpha = 0.66;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, view.w, view.h);
    c.globalAlpha = 1;
    plate(sk, this.card, false);

    let ty = y + pad;
    inkText(sk, 'SETTINGS', x + w / 2, ty + rowH * 0.4, rowH * 0.4, { alpha: 0.9 });
    ty += rowH * 0.8;

    ty = this.heading(sk, x + pad, ty, w - pad * 2, head, 'AUDIO');
    this.choice(sk, x + pad, ty, w - pad * 2, rowH, 'MUSIC',
      VOLUMES.map((o, i) => ({
        label: o.name, on: i === settings.music,
        act: () => { settings.music = i; audio.setMusicVolume(musicVolume()); },
      })));
    ty += rowH;
    this.choice(sk, x + pad, ty, w - pad * 2, rowH, 'EFFECTS',
      VOLUMES.map((o, i) => ({
        label: o.name, on: i === settings.sfx,
        act: () => { settings.sfx = i; audio.setSfxVolume(sfxVolume()); audio.play('ui'); },
      })));
    ty += rowH;

    ty = this.heading(sk, x + pad, ty, w - pad * 2, head, 'INPUT');
    const lineH = rowH * 0.62;
    const devices: Array<[boolean, string, string]> = [
      [input.touch, 'TOUCH', 'two on-screen sticks'],
      [input.desk, 'KEYBOARD & MOUSE', 'WASD to move, mouse to aim'],
      [!!input.pad, 'GAMEPAD', input.pad ? shortName(input.pad) : 'none connected'],
    ];
    const kinds: Array<InputReport['active']> = ['touch', 'desk', 'pad'];
    devices.forEach(([live, name, note], i) => {
      const here = kinds[i] === input.active && live;
      const size = lineH * 0.36;
      mark(sk, x + pad + size * 0.6, ty + lineH / 2, size * 0.42, here, live);
      inkText(sk, name, x + pad + size * 2.4, ty + lineH / 2, size,
        { align: 'left', alpha: live ? 0.95 : 0.35 });
      inkText(sk, (here ? 'IN USE - ' : '') + note.toUpperCase(), x + w - pad, ty + lineH / 2, size * 0.82,
        { align: 'right', alpha: live ? 0.55 : 0.3, wobble: 0.35 });
      ty += lineH;
    });

    this.choice(sk, x + pad, ty, w - pad * 2, rowH, 'AIM SPEED',
      AIM_SPEEDS.map((o, i) => ({
        label: o.name, on: i === settings.aimSpeed, act: () => { settings.aimSpeed = i; },
      })));

    // Last, over the plates, so the ring reads against whichever it is on.
    if (this.ring) focusRing(sk, this.ring, time);
    this.ring = null;
    c.restore();
  }

  /** The rect the focus ring goes round this frame, filled in while drawing. */
  private ring: Rect | null = null;

  private heading(sk: Sketch, x: number, y: number, w: number, h: number, label: string): number {
    const size = h * 0.42;
    inkText(sk, label, x, y + h * 0.62, size, { align: 'left', alpha: 0.55, wobble: 0.35 });
    const c = sk.ctx;
    c.globalAlpha = 0.25;
    sk.line({ x: x + measureText(sk, label, size) + size * 0.6, y: y + h * 0.62 },
      { x: x + w, y: y + h * 0.62 }, 2, 2, 0.6);
    c.globalAlpha = 1;
    return y + h;
  }

  /** A labelled row of buttons, exactly one of them in force. */
  private choice(
    sk: Sketch, x: number, y: number, w: number, h: number, label: string,
    opts: Array<{ label: string; on: boolean; act: () => void }>,
  ): void {
    const line = this.line++;
    const size = h * 0.28;
    const box = h - h * 0.24;
    inkText(sk, label, x, y + h / 2, size, { align: 'left', alpha: 0.75, wobble: 0.35 });
    const labelW = Math.max(measureText(sk, label, size), w * 0.26) + size;
    const gap = h * 0.1;
    const bw = (w - labelW - gap * (opts.length - 1)) / opts.length;
    opts.forEach((o, i) => {
      const r: Rect = { x: x + labelW + i * (bw + gap), y: y + (h - box) / 2, w: bw, h: box };
      const hot = this.under(r);
      plate(sk, hot ? grow(r, box * 0.06) : r, o.on);
      inkText(sk, o.label, r.x + r.w / 2, r.y + r.h / 2 + 1, Math.min(size * 1.1, bw * 0.42),
        { color: o.on ? '#fff' : '#000', alpha: o.on || hot ? 1 : 0.75, wobble: hot ? 1 : 0.7 });
      this.rows.push({ r, act: o.act, line, col: i });
      if (this.padFocus && this.focus.line === line && this.focus.col === i) this.ring = r;
    });
  }
}

/** Pads announce themselves with a paragraph of vendor ids; keep the name. */
function shortName(id: string): string {
  const paren = id.indexOf('(');
  const name = (paren > 0 ? id.slice(0, paren) : id).trim();
  return (name || id).slice(0, 28).toUpperCase();
}

/**
 * The mark against a device in the list: a filled arrowhead for the one in
 * hand, a dash for one that is merely there, nothing at all for one that is
 * not. Drawn rather than typed, so it inks like the rest of the page instead
 * of arriving as whatever glyph the platform feels like substituting.
 */
function mark(sk: Sketch, x: number, y: number, r: number, here: boolean, live: boolean): void {
  const c = sk.ctx;
  c.save();
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  if (here) {
    c.globalAlpha = 0.9;
    sk.polyPath([{ x: x - r, y: y - r }, { x: x + r, y }, { x: x - r, y: y + r }], 1.2);
    c.fill();
  } else if (live) {
    c.globalAlpha = 0.45;
    sk.line({ x: x - r, y }, { x: x + r, y }, r * 0.5, 1, 0.5);
  }
  c.restore();
}

/** A rect swollen by `by` on every side, for the one under the cursor. */
const grow = (r: Rect, by: number): Rect =>
  ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

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

/** The cog on the chip, drawn rather than typed so it inks like everything else. */
function gear(sk: Sketch, x: number, y: number, r: number, ink: string): void {
  const c = sk.ctx;
  const teeth = 8;
  const pts: Vec2[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rad = r * (i % 2 === 0 ? 1 : 0.72);
    pts.push({ x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad });
  }
  c.strokeStyle = ink;
  c.lineWidth = r * 0.26;
  sk.polyPath(pts, 1.2);
  c.stroke();
  c.beginPath();
  c.arc(x, y, r * 0.3, 0, Math.PI * 2);
  c.stroke();
}
