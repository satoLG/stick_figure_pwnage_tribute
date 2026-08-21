import { clamp, hashNoise, TAU, type Vec2 } from '../core/math';
import type { Sketch } from '../core/sketch';

/**
 * The punctuation of a hit, copied from how the reference film actually does it.
 *
 * Watched frame by frame, one landed blow there is not a cloud of debris. It is
 * three things and nothing else:
 *
 *   1. two frames of the whole screen inverted, carrying one solid shape;
 *   2. a fan of long, sharp lines that all converge on the single point of
 *      contact - never scattered, never from more than one origin;
 *   3. the fan thinning out, line by line, over the next three or four frames
 *      until the paper is empty again.
 *
 * The count coming down is the whole trick: 13 lines, then 8, then 5, then 2,
 * then nothing. That emptying is what makes the next hit land.
 */
interface Hit {
  x: number; y: number;
  /** Direction the force is travelling, in radians. The fan opens against it. */
  dir: number;
  power: number;
  /** Frames since it landed; the game steps on a fixed clock, so this is exact. */
  age: number;
  seed: number;
}

/** How many lines are left on each frame of a hit's life. */
const FAN = [13, 8, 5, 2];

export class ImpactFx {
  private list: Hit[] = [];

  add(x: number, y: number, dir: number, power = 1): void {
    // Only ever one hit on the paper. Two overlapping fans is the exact thing
    // that turns a fight into a scribble, and the reference never does it.
    this.list.length = 0;
    this.list.push({ x, y, dir, power: clamp(power, 0.3, 2), age: 0, seed: (x * 7 + y * 13) | 0 });
  }

  clear(): void { this.list.length = 0; }

  /** One tick per drawn frame - the effect is authored in frames, not seconds. */
  step(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (++this.list[i].age >= FAN.length) this.list.splice(i, 1);
    }
  }

  get busy(): boolean { return this.list.length > 0; }

  draw(sk: Sketch, worldW: number): void {
    const c = sk.ctx;
    c.save();
    c.fillStyle = '#000';
    c.strokeStyle = '#000';
    c.lineCap = 'butt';
    for (const h of this.list) {
      const n = FAN[h.age];
      // The fan opens back against the blow, wide enough to frame the figure.
      const back = h.dir + Math.PI;
      const spread = 2.1 + h.power * 0.3;
      const reach = worldW * (0.22 + h.power * 0.17);

      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = back + (t - 0.5) * spread + hashNoise(h.seed + i, h.age) * 0.08;
        const len = reach * (0.45 + Math.abs(hashNoise(h.seed + i * 3, 1)) * 0.85);
        const r0 = 4 + Math.abs(hashNoise(h.seed + i * 5, 2)) * 16;
        const w = (3.4 + h.power * 4.2) * (1 - h.age * 0.16);
        // A long sharp spike: wide at the point of contact, a point at the far
        // end. Drawn as a triangle, not a stroke, so the taper is real.
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = -sa, ny = ca;
        c.beginPath();
        c.moveTo(h.x + ca * r0 + nx * w * 0.5, h.y + sa * r0 + ny * w * 0.5);
        c.lineTo(h.x + ca * r0 - nx * w * 0.5, h.y + sa * r0 - ny * w * 0.5);
        c.lineTo(h.x + ca * (r0 + len), h.y + sa * (r0 + len));
        c.closePath();
        c.fill();
      }

      // The first two frames also carry one solid shape. The screen is inverted
      // over them, so this black wedge is what reads as the white flash.
      if (h.age < 2) {
        const a = back;
        const r = 26 + h.power * 30;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = -sa, ny = ca;
        const p = (d: number, o: number): Vec2 => ({ x: h.x + ca * d + nx * o, y: h.y + sa * d + ny * o });
        sk.poly([
          p(r * 0.1, 0), p(r * 0.75, r * 0.62), p(r * 1.5, r * 0.34),
          p(r * 0.95, 0), p(r * 1.5, -r * 0.34), p(r * 0.75, -r * 0.62),
        ], 2, true, 1.4);
      }
    }
    c.restore();
  }

  /** A ring of hard spikes around a crater; the wall shattering, not smoking. */
  burstRing(sk: Sketch, x: number, y: number, radius: number, count = 9): void {
    const c = sk.ctx;
    c.save();
    c.fillStyle = '#000';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + hashNoise(i, sk.boil) * 0.2;
      const r0 = radius * 0.7;
      const len = radius * (0.4 + Math.abs(hashNoise(i * 3, sk.boil)) * 0.9);
      const ca = Math.cos(a), sa = Math.sin(a);
      const w = radius * 0.16;
      c.beginPath();
      c.moveTo(x + ca * r0 - sa * w, y + sa * r0 + ca * w);
      c.lineTo(x + ca * r0 + sa * w, y + sa * r0 - ca * w);
      c.lineTo(x + ca * (r0 + len), y + sa * (r0 + len));
      c.closePath();
      c.fill();
    }
    c.restore();
  }
}
