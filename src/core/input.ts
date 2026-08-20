export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface Ptr {
  id: number;
  kind: PointerKind;
  /** Position in canvas CSS pixels. */
  x: number; y: number;
  /** Where this pointer first went down. */
  startX: number; startY: number;
  justDown: boolean;
  justUp: boolean;
  /** Assigned by the touch controls so a finger keeps its job until released. */
  role: string;
  age: number;
}

/**
 * Keyboard plus multi-pointer input. Every active finger is tracked separately
 * so the touch layer can run a stick, an attack and the weapon wheel at once;
 * the single-pointer `mouse*` fields stay driven by mouse and pen only.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /** Every pointer currently down, keyed by pointerId. */
  pointers = new Map<number, Ptr>();
  /** Flips to true the first time a finger touches, and back if a mouse is used. */
  touchMode = false;

  /** Latest mouse/pen position in canvas CSS pixels. */
  pointer = { x: 0, y: 0 };
  mouseDown = false;
  mousePressed = false;
  mouseReleased = false;
  wheelDelta = 0;

  private el: HTMLElement;
  private detach: Array<() => void> = [];

  constructor(el: HTMLElement) {
    this.el = el;
    // A first guess so the menu shows the right instructions before the player
    // has touched anything; real input corrects it either way.
    this.touchMode = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.clearAll());
    this.on(el, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.on(el, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.on(window, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.on(window, 'pointercancel', (e) => this.onUp(e as PointerEvent));
    this.on(el, 'contextmenu', (e) => e.preventDefault());
    // Scrolling and zooming are already off via `touch-action: none` in CSS;
    // calling preventDefault here as well only earns a console warning.
    this.on(el, 'wheel', (e) => {
      e.preventDefault();
      this.wheelDelta += Math.sign((e as WheelEvent).deltaY);
    }, { passive: false });
  }

  private on(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.detach.push(() => t.removeEventListener(type, fn, opts));
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    const kind = (e.pointerType || 'mouse') as PointerKind;
    if (kind === 'touch') this.touchMode = true;
    const p = this.local(e);
    this.pointers.set(e.pointerId, {
      id: e.pointerId, kind, x: p.x, y: p.y, startX: p.x, startY: p.y,
      justDown: true, justUp: false, role: '', age: 0,
    });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (kind !== 'touch') {
      this.pointer = p;
      if (e.button === 0) { this.mouseDown = true; this.mousePressed = true; }
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    const tracked = this.pointers.get(e.pointerId);
    if (tracked) { tracked.x = p.x; tracked.y = p.y; }
    if ((e.pointerType || 'mouse') !== 'touch') {
      this.touchMode = false;
      this.pointer = p;
    }
  }

  private onUp(e: PointerEvent): void {
    const tracked = this.pointers.get(e.pointerId);
    if (tracked) { tracked.justUp = true; tracked.justDown = false; }
    if ((e.pointerType || 'mouse') !== 'touch' && e.button === 0) {
      this.mouseDown = false;
      this.mouseReleased = true;
    }
  }

  private clearAll(): void {
    this.held.clear();
    this.mouseDown = false;
    for (const p of this.pointers.values()) p.justUp = true;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    // Tab opens the weapon wheel and Space jumps, so both must stop the browser
    // from stealing them for focus traversal / page scrolling.
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    if (down) {
      if (!this.held.has(e.code)) this.pressed.add(e.code);
      this.held.add(e.code);
    } else {
      this.held.delete(e.code);
      this.released.add(e.code);
    }
  }

  down(code: string): boolean { return this.held.has(code); }
  justPressed(code: string): boolean { return this.pressed.has(code); }
  justReleased(code: string): boolean { return this.released.has(code); }

  anyDown(...codes: string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  /**
   * A press from any device this frame. Menus use this so a tap works the same
   * as a click without them having to know which is which.
   */
  pressPoint(): { x: number; y: number } | null {
    if (this.mousePressed) return { x: this.pointer.x, y: this.pointer.y };
    for (const p of this.pointers.values()) if (p.justDown) return { x: p.x, y: p.y };
    return null;
  }

  /** All pointers still down, oldest first. */
  active(): Ptr[] {
    const out: Ptr[] = [];
    for (const p of this.pointers.values()) if (!p.justUp) out.push(p);
    return out;
  }

  /** Clears per-frame edges and retires lifted pointers. Call at end of update. */
  endFrame(dt = 0): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = false;
    this.mouseReleased = false;
    this.wheelDelta = 0;
    for (const [id, p] of this.pointers) {
      if (p.justUp) { this.pointers.delete(id); continue; }
      p.justDown = false;
      p.age += dt;
    }
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach = [];
    this.pointers.clear();
  }
}
