import { angleDelta, clamp, type Vec2 } from '../core/math';
import { aimSpeed } from '../core/settings';

/**
 * How a thumb or a stick becomes an aim direction.
 *
 * A stick is not a crosshair. Reading its angle straight off is right for a
 * bat, where anywhere in the right half of the world is a hit; for a rifle it
 * is hopeless, because near the vertical a couple of degrees of wobble crosses
 * the axis and spins the whole figure round, and the smallest useful push is
 * worth ninety degrees of aim. So each device and weapon gets the reading that
 * suits it rather than one compromise for all three.
 */
export type AimMode =
  /** Straight at the spot under the thumb. Nothing to wobble: touch, ranged. */
  | 'point'
  /** The raw stick angle, instantly. Fastest and twitchiest: touch, melee. */
  | 'direct'
  /** Swings towards the stick at a capped speed. For a real stick: a gamepad. */
  | 'eased';

/** How fast EASED swings at full deflection, in radians a second. */
const TURN_MAX = 7;

export interface AimInput {
  /** A thumb is down, or a stick is being read at all. */
  active: boolean;
  /** It landed this frame, so nothing is carried over from the last one. */
  fresh: boolean;
  /** Deflection, each component -1..1, magnitude already clamped to 1. */
  nx: number;
  ny: number;
  /** Deflection below this is not a push at all. */
  dead: number;
  /** Where the thumb is, in world units, for the modes that aim at a place. */
  world: Vec2;
  /** The shoulder the aim is cast from. */
  eye: Vec2;
}

/**
 * Turns stick movement into an aim direction. The direction is sticky: a press
 * that never pushes leaves it exactly as it was, under every mode, so tapping
 * to attack always swings along the aim already showing.
 */
export class AimSolver {
  /** Unit vector, or null until the aim has been used at all. */
  dir: Vec2 | null = null;
  private angle = 0;

  reset(): void {
    this.dir = null;
    this.angle = 0;
  }

  update(dt: number, mode: AimMode, i: AimInput): Vec2 | null {
    if (!i.active) return this.dir;
    if (i.fresh && this.dir) this.angle = Math.atan2(this.dir.y, this.dir.x);

    const m = Math.min(1, Math.hypot(i.nx, i.ny));
    const pushed = m > i.dead;

    switch (mode) {
      case 'point': {
        const dx = i.world.x - i.eye.x, dy = i.world.y - i.eye.y;
        if (Math.hypot(dx, dy) > 24) this.set(Math.atan2(dy, dx));
        break;
      }

      case 'direct':
        if (pushed) this.set(Math.atan2(i.ny, i.nx));
        break;

      case 'eased': {
        // Speed rises with the square of the push, so the first few degrees of
        // travel are for placing a shot and the outer edge is for spinning
        // round. Nothing here can jump: the aim only ever sweeps.
        if (pushed) {
          const push = (m - i.dead) / (1 - i.dead);
          const step = TURN_MAX * aimSpeed() * push * push * dt;
          const to = Math.atan2(i.ny, i.nx);
          this.set(this.angle + clamp(angleDelta(this.angle, to), -step, step));
        }
        break;
      }
    }
    return this.dir;
  }

  private set(a: number): void {
    this.angle = a;
    this.dir = { x: Math.cos(a), y: Math.sin(a) };
  }
}
