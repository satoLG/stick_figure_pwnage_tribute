export const TAU = Math.PI * 2;

export interface Vec2 { x: number; y: number; }

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Framerate independent exponential smoothing. `rate` ~ how fast it converges. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

export const dampVec = (a: Vec2, b: Vec2, rate: number, dt: number): Vec2 => {
  const t = 1 - Math.exp(-rate * dt);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
};

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const dampAngle = (a: number, b: number, rate: number, dt: number): number =>
  a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeOutBack = (t: number): number => {
  const c = 1.70158, c3 = c + 1, x = clamp(t, 0, 1);
  return 1 + c3 * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

export const rand = (a = 1, b?: number): number =>
  b === undefined ? Math.random() * a : a + Math.random() * (b - a);

export const randInt = (a: number, b: number): number => Math.floor(rand(a, b + 1));

export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * Cheap deterministic hash noise in [-1, 1]. Used to give every stroke a stable
 * per-frame wobble so the art keeps the "drawn by hand on paper" boil.
 */
export function hashNoise(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** A rotation applied to a point around the origin. */
export function rotate(p: Vec2, ang: number): Vec2 {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/**
 * Two bone inverse kinematics. Returns the middle joint position for a chain
 * anchored at `root` reaching for `target`. `bend` (+1 / -1) picks the elbow or
 * knee side so limbs never snap through themselves.
 */
export function solveIK(
  root: Vec2, target: Vec2, l1: number, l2: number, bend: number,
): Vec2 {
  let dx = target.x - root.x;
  let dy = target.y - root.y;
  let d = Math.hypot(dx, dy);
  const min = Math.abs(l1 - l2) + 0.001;
  const max = l1 + l2 - 0.001;
  if (d < 1e-5) { dx = 0; dy = 1; d = 1e-5; }
  const cd = clamp(d, min, max);
  const ux = dx / d, uy = dy / d;
  const a = (l1 * l1 - l2 * l2 + cd * cd) / (2 * cd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  return {
    x: root.x + ux * a - uy * h * bend,
    y: root.y + uy * a + ux * h * bend,
  };
}

/** Point on a quadratic bezier, used for curved limbs and blade arcs. */
export function quadPoint(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}
