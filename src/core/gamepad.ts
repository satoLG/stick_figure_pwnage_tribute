import type { Vec2 } from './math';

/**
 * A gamepad, read the way this game wants it: two sticks and a handful of
 * edges, with the browser's own button numbering kept in one place.
 *
 * Everything is polled rather than evented - the Gamepad API only fires for
 * connection, not for input - and the first pad reporting any activity wins,
 * so plugging a second controller in does not fight the first.
 */
export interface PadState {
  connected: boolean;
  /** The browser's name for it, for the settings menu. */
  name: string;
  /** Left stick, deadzoned and rescaled so the deadzone edge reads as zero. */
  move: Vec2;
  /** Right stick, same treatment. */
  aim: Vec2;
  fire: boolean;
  firePressed: boolean;
  jump: boolean;
  jumpPressed: boolean;
  crouch: boolean;
  /** Held, opening the weapon fan; the aim stick then picks a slot. */
  wheel: boolean;
  wheelReleased: boolean;
  /** Edges, for stepping through the arsenal a weapon at a time. */
  next: boolean;
  prev: boolean;
  menu: boolean;
  /**
   * Menu navigation: one step per push, from the d-pad or the left stick, and
   * repeating if it is held. Menus are read, not steered, so a stick shoved and
   * kept there should walk the list rather than sit on the second item.
   */
  navX: number;
  navY: number;
  confirm: boolean;
  back: boolean;
  /** Anything at all happened this frame, so the game can switch device. */
  any: boolean;
}

/** Standard mapping, which every pad worth supporting reports. */
const B = {
  a: 0, b: 1, x: 2, y: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9,
  up: 12, down: 13, left: 14, right: 15,
};

/** Sticks rest a long way off centre on worn hardware. */
const DEAD = 0.22;
const TRIGGER = 0.4;

function stick(x: number, y: number): Vec2 {
  const m = Math.hypot(x, y);
  if (m < DEAD) return { x: 0, y: 0 };
  // Rescale so the deadzone edge is zero and the rim is still exactly one:
  // without this every push starts at a fifth of full speed.
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return { x: x * k, y: y * k };
}

const IDLE: PadState = {
  connected: false, name: '', move: { x: 0, y: 0 }, aim: { x: 0, y: 0 },
  fire: false, firePressed: false, jump: false, jumpPressed: false, crouch: false,
  wheel: false, wheelReleased: false, next: false, prev: false, menu: false,
  navX: 0, navY: 0, confirm: false, back: false, any: false,
};

/** How long a held direction waits before it starts walking a list, and how
 * fast it walks once it does. */
const NAV_DELAY = 0.42;
const NAV_REPEAT = 0.13;
/** A direction has to be pushed this far to count as one at all. */
const NAV_ON = 0.6;
const NAV_OFF = 0.4;

export class Gamepads {
  private held = new Set<string>();
  private wheelWas = false;
  private lastName = '';
  private navDir = { x: 0, y: 0 };
  private navTime = 0;
  private lastRead = 0;

  /** The name of the pad in use, or null. Read by the settings menu. */
  get name(): string | null {
    return this.lastName || null;
  }

  /** True when the browser can see a pad at all, whether or not it is in use. */
  get present(): boolean {
    return this.pads().length > 0;
  }

  private pads(): Gamepad[] {
    const list = navigator.getGamepads?.() ?? [];
    const out: Gamepad[] = [];
    for (const p of list) if (p && p.connected) out.push(p);
    return out;
  }

  /** The pad doing something, or failing that the first one plugged in. */
  private active(): Gamepad | null {
    const pads = this.pads();
    if (!pads.length) return null;
    for (const p of pads) {
      if (p.buttons.some((b) => b.pressed)) return p;
      if (p.axes.some((a) => Math.abs(a) > DEAD)) return p;
    }
    return pads[0];
  }

  read(): PadState {
    const pad = this.active();
    if (!pad) {
      this.held.clear();
      this.wheelWas = false;
      this.lastName = '';
      this.navDir = { x: 0, y: 0 };
      this.lastRead = 0;
      return IDLE;
    }
    this.lastName = pad.id;

    const down = (i: number): boolean => (pad.buttons[i]?.pressed ?? false)
      || (pad.buttons[i]?.value ?? 0) > TRIGGER;
    // Every edge is taken exactly once, into a table, because reading one
    // consumes it: asking twice - or short-circuiting past an `||` - would
    // hand the press to whichever question happened to be asked first.
    const hit: Record<number, boolean> = {};
    for (const i of Object.values(B)) {
      const key = `b${i}`;
      const now = down(i);
      hit[i] = now && !this.held.has(key);
      if (now) this.held.add(key); else this.held.delete(key);
    }
    const edge = (i: number): boolean => hit[i] ?? false;

    const move = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const aim = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    // The wheel is held rather than toggled, exactly like the touch pad, so the
    // same release-to-equip flow works without the game knowing the difference.
    const wheel = down(B.l1) || down(B.l2);
    const wheelReleased = this.wheelWas && !wheel;
    this.wheelWas = wheel;

    // The face buttons all attack: which one is muscle memory, not doctrine.
    const fire = down(B.r1) || down(B.r2) || down(B.x);
    const firePressed = edge(B.r1) || edge(B.r2) || edge(B.x);
    // Pushing the left stick up jumps as well, so the touch layout transfers
    // straight across; a band between the two thresholds stops it retriggering.
    const up = move.y < -0.55;
    const jumpPressed = edge(B.a) || (up && !this.held.has('up'));
    if (up) this.held.add('up'); else if (move.y > -0.45) this.held.delete('up');
    const jump = down(B.a) || up;

    const nav = this.nav(pad, move);
    const state: PadState = {
      connected: true, name: pad.id, move, aim,
      fire, firePressed, jump, jumpPressed,
      crouch: down(B.b) || move.y > 0.55,
      wheel, wheelReleased,
      next: edge(B.right) || edge(B.y), prev: edge(B.left),
      menu: edge(B.start) || edge(B.select),
      navX: nav.x, navY: nav.y,
      confirm: edge(B.a), back: edge(B.b),
      any: false,
    };
    state.any = Math.hypot(move.x, move.y) > 0 || Math.hypot(aim.x, aim.y) > 0
      || fire || state.crouch || jump || wheel || state.next || state.prev || state.menu;
    return state;
  }

  /**
   * One nav step per push, then a repeat if it is held. The d-pad and the left
   * stick feed the same thing, so a menu can be walked with either without
   * knowing which it was.
   */
  private nav(pad: Gamepad, move: Vec2): Vec2 {
    const now = performance.now() / 1000;
    const dt = this.lastRead > 0 ? Math.min(0.1, now - this.lastRead) : 0;
    this.lastRead = now;

    const b = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    const axis = (v: number, was: number): number =>
      v > (was > 0 ? NAV_OFF : NAV_ON) ? 1 : v < -(was < 0 ? NAV_OFF : NAV_ON) ? -1 : 0;
    const x = b(B.left) ? -1 : b(B.right) ? 1 : axis(move.x, this.navDir.x);
    const y = b(B.up) ? -1 : b(B.down) ? 1 : axis(move.y, this.navDir.y);

    if (x !== this.navDir.x || y !== this.navDir.y) {
      this.navDir = { x, y };
      this.navTime = 0;
      return { x, y };            // the push itself always steps
    }
    if (x === 0 && y === 0) return { x: 0, y: 0 };
    this.navTime += dt;
    const due = this.navTime > NAV_DELAY;
    if (!due) return { x: 0, y: 0 };
    // Held: step again every repeat, by rewinding the clock rather than
    // resetting it, so the cadence does not drift with the frame rate.
    this.navTime -= NAV_REPEAT;
    return { x, y };
  }
}
