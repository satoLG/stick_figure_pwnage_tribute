export type PointerKind = 'mouse' | 'touch' | 'pen';

/** Cancels a browser default that would fight the game for the same gesture. */
const kill = (e: Event): void => { if (e.cancelable) e.preventDefault(); };

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
  /** True once the canvas took pointer capture, so its loss can retire this. */
  captured: boolean;
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
    // Capture is released the moment a pointer really ends, so losing it is the
    // one signal that survives a `pointerup` the browser forgot to deliver -
    // which is what used to leave a thumb-less stick stuck at full deflection.
    // The button state is left to `pointerup`; this only retires the pointer.
    this.on(el, 'lostpointercapture', (e) => {
      const tracked = this.pointers.get((e as PointerEvent).pointerId);
      if (tracked) this.end(tracked);
    });
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.clearAll(); });

    // Nothing on this page is meant to be scrolled, zoomed, selected or
    // dragged: every press is a game input. `touch-action` in CSS covers the
    // common cases, but iOS still double-tap-zooms, pinch-zooms via its own
    // gesture events and pops a selection/callout on a long press, so the
    // defaults are cancelled here as well. The touch list also doubles as a
    // ground truth for which fingers are genuinely still down.
    const raw = { passive: false } as AddEventListenerOptions;
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      this.on(el, type, (e) => this.onTouch(e as TouchEvent), raw);
    }
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.on(document, type, kill, raw);
    }
    this.on(document, 'contextmenu', kill);
    this.on(document, 'selectstart', kill);
    this.on(document, 'dragstart', kill);
    this.on(el, 'dblclick', kill);

    this.on(el, 'wheel', (e) => {
      e.preventDefault();
      this.wheelDelta += Math.sign((e as WheelEvent).deltaY);
    }, raw);
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
    // A fresh press is a good moment to notice fingers that are no longer
    // there: pointer ids get recycled, so a ghost left behind by a dropped
    // `pointerup` would otherwise be mistaken for this new one.
    this.dropGhosts();
    const p = this.local(e);
    let captured = false;
    try {
      this.el.setPointerCapture?.(e.pointerId);
      captured = this.el.hasPointerCapture?.(e.pointerId) ?? false;
    } catch {
      /* The pointer ended between the event and here; the sweeps will bin it. */
    }
    this.pointers.set(e.pointerId, {
      id: e.pointerId, kind, x: p.x, y: p.y, startX: p.x, startY: p.y,
      justDown: true, justUp: false, role: '', age: 0, captured,
    });
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
    if (tracked) this.end(tracked);
    if ((e.pointerType || 'mouse') !== 'touch' && e.button === 0) {
      this.mouseDown = false;
      this.mouseReleased = true;
    }
  }

  /** Retires pointers the canvas has silently lost capture of. */
  private dropGhosts(): void {
    if (!this.el.hasPointerCapture) return;
    for (const p of this.pointers.values()) {
      if (!p.justUp && p.captured && !this.el.hasPointerCapture(p.id)) this.end(p);
    }
  }

  private end(p: Ptr): void {
    p.justUp = true;
    p.justDown = false;
  }

  /**
   * Touch events carry the full list of fingers on the glass, so they can say
   * with certainty how many are left. Any tracked pointer that no longer has a
   * touch near it is gone, whatever events did or did not arrive for it.
   */
  private onTouch(e: TouchEvent): void {
    if (e.cancelable) e.preventDefault();
    if (!e.touches) return;

    const live: Ptr[] = [];
    for (const p of this.pointers.values()) if (p.kind === 'touch' && !p.justUp) live.push(p);
    if (live.length <= e.touches.length) return;

    const r = this.el.getBoundingClientRect();
    const claimed = new Set<Ptr>();
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i];
      const x = t.clientX - r.left, y = t.clientY - r.top;
      let best: Ptr | null = null;
      let bestD = Infinity;
      for (const p of live) {
        if (claimed.has(p)) continue;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) claimed.add(best);
    }
    for (const p of live) if (!claimed.has(p)) this.end(p);
  }

  private clearAll(): void {
    this.held.clear();
    this.mouseDown = false;
    for (const p of this.pointers.values()) this.end(p);
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
