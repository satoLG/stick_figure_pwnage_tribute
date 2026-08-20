/**
 * Keyboard + mouse state. Keys are tracked both as a held set and as
 * "pressed this frame" edges, which the weapon wheel and menus rely on.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /** Pointer position in canvas CSS pixels; the game maps it to world space. */
  pointer = { x: 0, y: 0 };
  /** Pointer position in world units, written by the game each frame. */
  world = { x: 0, y: 0 };
  mouseDown = false;
  mousePressed = false;
  mouseReleased = false;
  wheelDelta = 0;

  private el: HTMLElement;
  private detach: Array<() => void> = [];

  constructor(el: HTMLElement) {
    this.el = el;
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => { this.held.clear(); this.mouseDown = false; });
    this.on(el, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.on(el, 'pointerdown', (e) => {
      const pe = e as PointerEvent;
      this.onMove(pe);
      if (pe.button === 0) { this.mouseDown = true; this.mousePressed = true; }
      (e.target as HTMLElement).setPointerCapture?.(pe.pointerId);
    });
    this.on(window, 'pointerup', (e) => {
      if ((e as PointerEvent).button === 0) { this.mouseDown = false; this.mouseReleased = true; }
    });
    this.on(el, 'contextmenu', (e) => e.preventDefault());
    this.on(el, 'wheel', (e) => {
      e.preventDefault();
      this.wheelDelta += Math.sign((e as WheelEvent).deltaY);
    }, { passive: false });
  }

  private on(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.detach.push(() => t.removeEventListener(type, fn, opts));
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

  private onMove(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    this.pointer.x = e.clientX - r.left;
    this.pointer.y = e.clientY - r.top;
  }

  down(code: string): boolean { return this.held.has(code); }
  justPressed(code: string): boolean { return this.pressed.has(code); }
  justReleased(code: string): boolean { return this.released.has(code); }

  anyDown(...codes: string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  /** Clears per-frame edges. Call at the very end of the update step. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = false;
    this.mouseReleased = false;
    this.wheelDelta = 0;
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach = [];
  }
}
