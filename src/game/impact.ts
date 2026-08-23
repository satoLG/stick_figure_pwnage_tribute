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
/** Seconds each stage of the fan is held: one drawing at fifteen a second. */
const STAGE = 1 / 15;

export class ImpactFx {
  private list: Hit[] = [];

  add(x: number, y: number, dir: number, power = 1): void {
    // Only ever one hit on the paper. Two overlapping fans is the exact thing
    // that turns a fight into a scribble, and the reference never does it.
    this.list.length = 0;
    this.list.push({ x, y, dir, power: clamp(power, 0.3, 2), age: 0, seed: (x * 7 + y * 13) | 0 });
  }

  clear(): void { this.list.length = 0; this.acc = 0; }

  /**
   * The effect is authored in drawings, not seconds, so it ages on the
   * animation's own 15 Hz clock however fast the game happens to be painting.
   */
  private acc = 0;
  step(dt: number): void {
    this.acc += dt;
    while (this.acc >= STAGE) {
      this.acc -= STAGE;
      for (let i = this.list.length - 1; i >= 0; i--) {
        if (++this.list[i].age >= FAN.length) this.list.splice(i, 1);
      }
    }
  }

  get busy(): boolean { return this.list.length > 0; }

  /**
   * The whole hit is *one* drawing.
   *
   * Every blade of the fan starts at exactly the same point - where the blow
   * landed - and sweeps back past the figure, so the effect reads as a single
   * connected form rather than an arc here and some loose strokes there. It is
   * built as one path: filled white once, then outlined in one pass, which is
   * what gives the reference's look of nested strokes with paper showing
   * through them.
   *
   * `inverted` flips it solid, because on an inverted frame a white-filled
   * shape with a black outline would vanish into the black ground.
   */
  draw(sk: Sketch, worldW: number, inverted = false): void {
    const c = sk.ctx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    for (const h of this.list) {
      const n = FAN[h.age];
      // The fan opens back against the blow, wide enough to frame the figure.
      const back = h.dir + Math.PI;
      const spread = 2.3 + h.power * 0.35;
      const reach = worldW * (0.26 + h.power * 0.2);
      const fade = 1 - h.age * 0.14;

      c.beginPath();
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = back + (t - 0.5) * spread + hashNoise(h.seed + i, h.age) * 0.07;
        const len = reach * (0.42 + Math.abs(hashNoise(h.seed + i * 3, 1)) * 0.9) * fade;
        const w = (4 + h.power * 8) * fade * (0.6 + Math.abs(hashNoise(h.seed + i * 7, 4)) * 0.8);
        // Each blade bows a little, the way a drawn stroke does.
        const bow = hashNoise(h.seed + i * 11, 5) * len * 0.1;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = -sa, ny = ca;
        const p = (d: number, o: number): Vec2 => ({ x: h.x + ca * d + nx * o, y: h.y + sa * d + ny * o });
        const tip = p(len, bow);
        // Apex, out along one edge to the point, and back along the other.
        c.moveTo(h.x, h.y);
        const e1 = p(len * 0.34, w * 0.5 + bow * 0.35);
        const e2 = p(len * 0.34, -w * 0.5 + bow * 0.35);
        c.quadraticCurveTo(e1.x, e1.y, tip.x, tip.y);
        c.quadraticCurveTo(e2.x, e2.y, h.x, h.y);
      }
      c.fillStyle = inverted ? '#000' : '#fff';
      c.fill();
      // The rim is walked with a pen that lifts: long runs of ink round some
      // blades, nothing at all round others. A fan outlined all the way round
      // reads as cut paper; one outlined in pieces reads as drawn.
      if (inverted) {
        c.strokeStyle = '#000';
        c.lineWidth = 5;
        c.stroke();
      } else {
        sk.rim(3.2, 0.45, h.seed + h.age * 17);
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
