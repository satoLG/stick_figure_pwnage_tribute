import { audio, type SfxName } from '../core/audio';
import { Input } from '../core/input';
import { clamp, damp, easeOutBack, hashNoise, rand, TAU, vec, type Vec2 } from '../core/math';
import { Sketch } from '../core/sketch';
import { TouchControls, type TouchState } from '../ui/touch';
import {
  drawProgress, hitRect, inkButton, inkText, measureText, slotKey, WeaponWheel,
  type Rect, type WheelLayout,
} from '../ui/ui';
import { ImpactFx } from './impact';
import { Particles } from './particles';
import { applyBlast, Projectile } from './projectiles';
import { RUN_PUSH, Stickman, type Controls } from './stickman';
import { computeWorldSize, Terrain } from './terrain';
import { createArsenal, type Weapon, type WeaponCtx } from './weapons';

type Phase = 'menu' | 'playing' | 'won';

/** The wall is never quite 100% clean; sweep the last slivers instead. */
const WIN_THRESHOLD = 0.994;

/** Slots 11 and 12 run off the two keys sitting right after the number row. */
const NUMBER_KEYS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'Minus', 'Equal',
];

/** Everything the player is asking for this frame, whatever device said it. */
interface Intent extends Controls {
  aim: Vec2;
  firing: boolean;
  firePressed: boolean;
  wheelOpen: boolean;
  wheelPointer: Vec2;
  wheelReleased: boolean;
  numberKey: number | null;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sk: Sketch;
  private input: Input;
  private touch = new TouchControls();

  /** Playfield size in world units; follows the viewport aspect exactly. */
  private view = { w: 1280, h: 720 };
  private terrain: Terrain;
  private sm = new Stickman();
  private particles = new Particles();
  private impacts = new ImpactFx();
  /**
   * Held time left after a hit, in seconds. Stopping the world for a couple of
   * drawings is what turns a swing into a blow: it gives the eye a still frame
   * to read the impact pose in, which no amount of extra ink does.
   */
  private freezeT = 0;
  /** Damage waiting on its own round to arrive, so nothing lands early. */
  private pending: Array<{ t: number; fn: () => void }> = [];
  private projectiles: Projectile[] = [];
  private weapons: Weapon[] = createArsenal();
  private equipped = 0;
  private wheel = new WeaponWheel();

  private phase: Phase = 'menu';
  private time = 0;
  private phaseTime = 0;
  private last = 0;
  private raf = 0;

  // --- screen effects -------------------------------------------------------
  private shakeAmt = 0;
  private shakeOff: Vec2 = vec(0, 0);
  private flashAmt = 0;
  private invertT = 0;
  private timeScale = 1;
  private hintFade = 1;

  private scaleX = 1;
  private scaleY = 1;
  private cssW = 1280;
  private cssH = 720;
  /** Notch / home-bar insets in world units, so the HUD stays clear of them. */
  private safe = { top: 0, right: 0, bottom: 0, left: 0 };
  private probe = document.getElementById('safe-probe');

  private stats = { shots: 0, elapsed: 0 };

  /** Read-only peeks, used by the dev console and the automated smoke tests. */
  get player(): Stickman { return this.sm; }
  get destroyedPct(): number { return this.terrain.destroyed; }
  get currentPhase(): string { return this.phase; }
  get viewSize(): { w: number; h: number } { return this.view; }
  get equippedIndex(): number { return this.equipped; }
  get touchActive(): boolean { return this.isTouch; }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('2D canvas is not available in this browser');
    this.ctx = c;
    this.sk = new Sketch(c);
    this.input = new Input(canvas);
    this.view = computeWorldSize(window.innerWidth, window.innerHeight);
    this.terrain = new Terrain(this.view.w, this.view.h);
    this.resetWorld();
    this.fit();

    const refit = () => this.fit();
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
    window.visualViewport?.addEventListener('resize', refit);
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); });
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // Clamp so a background tab does not teleport the player through the wall.
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.step(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.input.dispose();
  }

  // ------------------------------------------------------------- viewport ---

  /**
   * The canvas always fills the window; the world is re-sized to the viewport's
   * exact aspect ratio so there are never letterbox bars in any orientation.
   */
  private fit(): void {
    const vw = Math.max(1, Math.round(window.visualViewport?.width ?? window.innerWidth));
    const vh = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const size = computeWorldSize(vw, vh);

    this.cssW = vw;
    this.cssH = vh;
    this.canvas.style.width = `${vw}px`;
    this.canvas.style.height = `${vh}px`;
    this.canvas.width = Math.round(vw * dpr);
    this.canvas.height = Math.round(vh * dpr);

    if (size.w !== this.view.w || size.h !== this.view.h) {
      this.view = size;
      // Re-lays the level at the new size, keeping the damage already done.
      this.terrain.resizeTo(size.w, size.h);
      this.settlePlayer();
      this.layoutButtons();
    }
    this.scaleX = this.canvas.width / this.view.w;
    this.scaleY = this.canvas.height / this.view.h;
    this.readSafeArea();
  }

  /** Reads env(safe-area-inset-*) off the probe and converts it to world units. */
  private readSafeArea(): void {
    if (!this.probe) return;
    const cs = getComputedStyle(this.probe);
    const px = (v: string): number => parseFloat(v) || 0;
    const kx = this.view.w / this.cssW;
    const ky = this.view.h / this.cssH;
    this.safe = {
      top: px(cs.paddingTop) * ky,
      right: px(cs.paddingRight) * kx,
      bottom: px(cs.paddingBottom) * ky,
      left: px(cs.paddingLeft) * kx,
    };
  }

  /** After a re-lay, make sure the figure is not buried inside the new terrain. */
  private settlePlayer(): void {
    this.sm.pos.x = clamp(this.sm.pos.x, 50, this.view.w - 50);
    let guard = 0;
    while (guard++ < 400 && this.terrain.solidAt(this.sm.pos.x, this.sm.pos.y - 4)) {
      this.sm.pos.y -= 4;
    }
    if (this.sm.pos.y < 0) this.sm.pos.y = this.terrain.groundTop;
  }

  private toWorld = (cssX: number, cssY: number): Vec2 => ({
    x: clamp((cssX / this.cssW) * this.view.w, 0, this.view.w),
    y: clamp((cssY / this.cssH) * this.view.h, 0, this.view.h),
  });

  private pointerWorld(): Vec2 {
    return this.toWorld(this.input.pointer.x, this.input.pointer.y);
  }

  // ---------------------------------------------------------------- world ---

  private startBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private restartBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private menuBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  private layoutButtons(): void {
    const { w, h } = this.view;
    const bw = clamp(w * 0.42, 260, 380);
    const bh = clamp(h * 0.09, 62, 84);
    this.startBtn = { x: w / 2 - bw / 2, y: h * 0.56, w: bw, h: bh };

    const sw = clamp(w * 0.3, 170, 240);
    const sh = clamp(h * 0.075, 54, 68);
    const gap = 20;
    const y = h * 0.6;
    this.restartBtn = { x: w / 2 - sw - gap / 2, y, w: sw, h: sh };
    this.menuBtn = { x: w / 2 + gap / 2, y, w: sw, h: sh };
  }

  private resetWorld(): void {
    this.terrain = new Terrain(this.view.w, this.view.h);
    this.particles.clear();
    this.impacts.clear();
    this.freezeT = 0;
    this.pending.length = 0;
    this.projectiles.length = 0;
    this.weapons = createArsenal();
    this.equipped = 0;
    this.wheel.hovered = 0;
    this.touch.reset();
    this.sm.reset(Math.min(230, this.view.w * 0.22), this.terrain.groundTop - 40);
    this.shakeAmt = 0;
    this.flashAmt = 0;
    this.invertT = 0;
    this.hintFade = 1;
    this.stats = { shots: 0, elapsed: 0 };
    this.layoutButtons();
  }

  private get weapon(): Weapon { return this.weapons[this.equipped]; }
  private get isTouch(): boolean { return this.input.touchMode; }

  private wheelLayout(): WheelLayout {
    if (this.isTouch) return this.touch.layout(this.view);
    return {
      kind: 'ring',
      anchor: { x: this.view.w / 2, y: this.view.h / 2 },
      radius: clamp(Math.min(this.view.w, this.view.h) * 0.3, 150, 240),
    };
  }

  private makeCtx(dt: number, aim: Vec2): WeaponCtx {
    return {
      sm: this.sm,
      terrain: this.terrain,
      particles: this.particles,
      projectiles: this.projectiles,
      aimPoint: aim,
      dt,
      time: this.time,
      shake: (a) => this.shake(a),
      flash: (a) => { this.flashAmt = Math.min(1, this.flashAmt + a); },
      invert: (s) => { this.invertT = Math.max(this.invertT, s); },
      hit: (x, y, dir, power) => this.impacts.add(x, y, dir, power),
      freeze: (frames) => { this.freezeT = Math.max(this.freezeT, frames / 15); },
      after: (seconds, fn) => { this.pending.push({ t: seconds, fn }); },
      sfx: (n: SfxName, p?: number) => audio.play(n, p),
    };
  }

  private shake(a: number): void {
    this.shakeAmt = Math.min(46, this.shakeAmt + a);
  }

  // ----------------------------------------------------------------- loop ---

  /**
   * The whole game is drawn on twos.
   *
   * The reference animation runs at about fifteen drawings a second, and that
   * is not a limitation of the medium - it is the medium. Sixty smoothly
   * interpolated frames a second read as floating; fifteen stepped ones read as
   * drawn. So the world is simulated and painted on a fixed 15 Hz step and
   * simply held in between, and the ink wobble advances once per step with it.
   */
  private frameAcc = 0;
  /**
   * Frames drawn per second. 60 is smooth and responsive; 15 is the reference
   * film's own cadence, and costs the input latency that comes with it. V
   * toggles, because the two really are different games to play.
   */
  private animFps = 60;

  private step(rawDt: number): void {
    const stepLen = 1 / this.animFps;
    this.frameAcc += rawDt;
    if (this.frameAcc < stepLen) return;      // hold the frame already on screen
    // Catch up after a stall, but never in one huge leap.
    const dt = Math.min(stepLen * 3, this.frameAcc);
    this.frameAcc = 0;
    this.tickFrame(dt);
  }

  private tickFrame(rawDt: number): void {
    this.time += rawDt;
    this.phaseTime += rawDt;
    this.sk.update(this.time);
    // A/B the cadence against plain 60 fps while we tune the feel.
    if (this.input.justPressed('KeyV')) this.animFps = this.animFps === 60 ? 15 : 60;

    // Held time: the world stops, the picture stays up, the screen keeps
    // shaking. Input still reaches the buffer, it just cannot move anything yet.
    if (this.freezeT > 0) {
      this.freezeT = Math.max(0, this.freezeT - rawDt);
      this.decayEffects(rawDt);
      this.render(rawDt);
      this.input.endFrame(rawDt);
      return;
    }
    this.impacts.step(rawDt);

    switch (this.phase) {
      case 'menu': this.updateMenu(rawDt); break;
      case 'playing': this.updatePlaying(rawDt); break;
      case 'won': this.updateWon(rawDt); break;
    }

    this.render(rawDt);
    this.input.endFrame(rawDt);
  }

  /** Merges keyboard/mouse and on-screen controls into one set of wishes. */
  private readIntent(rawDt: number): Intent {
    const inp = this.input;
    const t = this.touch.update(inp, rawDt, this.view, this.toWorld);

    let numberKey: number | null = null;
    for (let i = 0; i < NUMBER_KEYS.length; i++) {
      if (inp.justPressed(NUMBER_KEYS[i])) numberKey = i;
    }

    // A key has no in-between, so it reports exactly the deflection that means
    // "run", and SHIFT pushes it the rest of the way into a sprint. A thumb on
    // the analog stick gets the whole range for free.
    const keyAxis = ((inp.anyDown('KeyD', 'ArrowRight') ? 1 : 0) - (inp.anyDown('KeyA', 'ArrowLeft') ? 1 : 0))
      * (inp.anyDown('ShiftLeft', 'ShiftRight') ? 1 : RUN_PUSH);
    const tabOpen = inp.down('Tab');
    const wheelOpen = tabOpen || t.wheelOpen;

    return {
      axis: keyAxis !== 0 ? keyAxis : t.axis,
      down: inp.anyDown('KeyS', 'ArrowDown') || t.crouch,
      jump: inp.justPressed('Space') || t.jump,
      jumpHeld: inp.down('Space') || t.jumpHeld,
      aim: this.resolveAim(t),
      firing: (!wheelOpen && inp.mouseDown) || t.firing,
      firePressed: (!wheelOpen && inp.mousePressed) || t.firePressed,
      wheelOpen,
      wheelPointer: t.wheelOpen ? t.wheelPointer : this.pointerWorld(),
      wheelReleased: inp.justReleased('Tab') || t.wheelReleased,
      numberKey,
    };
  }

  /** Shoulder height, where his aim is measured from. */
  private get eye(): Vec2 {
    return { x: this.sm.pos.x, y: this.sm.pos.y - 74 };
  }

  /**
   * Where the figure is looking, which is also which way he faces.
   *
   * Aiming owns this outright - the cursor, or the aiming thumb - and the
   * walking controls never touch it: he can run, jump and crouch one way while
   * still looking and swinging the other. A mouse points at a spot, so it can
   * be used as the aim outright. The thumb instead gives a *direction*, which
   * is cast out from his shoulder rather than aimed at: far enough that the
   * offset between his shoulder and a muzzle stops mattering, so every barrel
   * fires the way the thumb is pointing rather than converging on a spot.
   */
  private resolveAim(t: TouchState): Vec2 {
    if (!this.isTouch) return this.pointerWorld();
    const dir = t.aimDir ?? { x: this.sm.facing, y: 0 };
    const eye = this.eye;
    const far = Math.max(this.view.w, this.view.h);
    return { x: eye.x + dir.x * far, y: eye.y + dir.y * far };
  }

  // ----------------------------------------------------------------- menu ---

  private updateMenu(dt: number): void {
    // The world keeps breathing behind the title card.
    const aim = { x: this.sm.pos.x + 200, y: this.sm.pos.y - 90 };
    this.sm.update(dt, this.terrain, { axis: 0, down: false, jump: false, jumpHeld: false }, aim);
    this.particles.update(dt, this.terrain);
    this.decayEffects(dt);

    const press = this.input.pressPoint();
    if (press && hitRect(this.startBtn, this.toWorld(press.x, press.y))) void this.beginRun();
    if (this.input.justPressed('Enter') || this.input.justPressed('Space')) void this.beginRun();
  }

  private async beginRun(): Promise<void> {
    if (this.phase === 'playing') return;
    this.phase = 'playing';
    this.phaseTime = 0;
    this.resetWorld();
    // Audio can only be created from inside a user gesture, which is exactly
    // what the start button gives us.
    try {
      await audio.init();
      audio.startMusic();
    } catch {
      /* Audio is a nicety; the game stays playable without it. */
    }
    audio.play('ui');
  }

  // -------------------------------------------------------------- playing ---

  private updatePlaying(rawDt: number): void {
    const intent = this.readIntent(rawDt);

    // --- weapon wheel, which also slows the action right down --------------
    const wasOpen = this.wheel.open > 0.01;
    const changed = this.wheel.update(
      rawDt, intent.wheelOpen, intent.wheelPointer, this.wheelLayout(),
      this.weapons.length, intent.numberKey,
    );
    if (changed) audio.play('wheel', 0.9 + this.wheel.hovered * 0.05);
    if (intent.wheelOpen && !wasOpen) audio.play('wheel', 0.7);
    if (!intent.wheelOpen && wasOpen) this.equip(this.wheel.hovered);

    // Numbers and the scroll wheel work without opening the wheel at all.
    if (!intent.wheelOpen) {
      if (intent.numberKey !== null && intent.numberKey < this.weapons.length) this.equip(intent.numberKey);
      if (this.input.wheelDelta !== 0) {
        const n = this.weapons.length;
        this.equip((this.equipped + this.input.wheelDelta + n) % n);
      }
    }

    this.timeScale = damp(this.timeScale, intent.wheelOpen ? 0.16 : 1, 14, rawDt);
    const dt = rawDt * this.timeScale;
    this.stats.elapsed += rawDt;
    if (this.hintFade > 0 && this.phaseTime > 9) this.hintFade = Math.max(0, this.hintFade - rawDt * 0.5);

    // --- character ---------------------------------------------------------
    this.sm.update(dt, this.terrain, intent, intent.aim);
    if (this.sm.justJumped) audio.play('jump', rand(0.9, 1.15));
    if (this.sm.justLanded) audio.play('land', rand(0.9, 1.1));
    if (this.sm.justStepped) {
      // Every footfall throws a little dust back down the track, which is most
      // of what sells the difference between walking and flat-out running.
      const p = this.sm.stepPower;
      audio.play('step', 0.85 + p * 0.5);
      const back = -Math.sign(this.sm.vel.x || 1);
      this.particles.dust(this.sm.pos.x - back * 4, this.sm.pos.y - 3, 1 + Math.round(p * 2), back > 0 ? 0 : Math.PI, p);
    }

    // --- weapon ------------------------------------------------------------
    const wctx = this.makeCtx(dt, intent.aim);
    const firing = !intent.wheelOpen && intent.firing;
    const pressed = !intent.wheelOpen && intent.firePressed;
    if (pressed) this.stats.shots++;
    this.weapon.update(wctx, firing, pressed);
    this.sm.setHands(this.weapon.hands(wctx));
    // Weapons that own the whole body - a charge-up, a heavy wind-up - say so
    // here, every frame, so dropping the stance is just saying nothing.
    this.sm.setStance(this.weapon.stance(wctx));

    // --- projectiles + their craters ---------------------------------------
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt, this.terrain);
      if (p.dead) {
        if (p.hitAt) this.detonate(p, p.hitAt);
        this.projectiles.splice(i, 1);
      }
    }

    this.particles.update(dt, this.terrain);
    this.runPending(dt);
    this.decayEffects(rawDt);

    // --- win check ---------------------------------------------------------
    if (this.terrain.destroyed >= WIN_THRESHOLD) {
      this.terrain.sweepRemains();
      this.phase = 'won';
      this.phaseTime = 0;
      this.timeScale = 1;
      this.flashAmt = 1;
      this.invertT = 0.25;
      this.shake(30);
      this.particles.shockwave(this.view.w * 0.84, this.view.h * 0.42, 320);
      audio.play('win');
    }
  }

  /** Fires anything whose flight time has run out - a bullet reaching the wall. */
  private runPending(dt: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t > 0) continue;
      this.pending.splice(i, 1);
      p.fn();
    }
  }

  private detonate(p: Projectile, at: Vec2): void {
    applyBlast(this.terrain, at.x, at.y, p.blast);
    const b = p.blast;
    audio.play(b.sfx === 'cannon' ? 'cannon' : 'explosion');
    this.shake(b.shake);
    this.flashAmt = Math.min(1, this.flashAmt + b.flash);
    if (b.flash > 0.6) this.invertT = Math.max(this.invertT, 0.06);
    this.particles.shockwave(at.x, at.y, b.radius * 1.5);
    this.particles.debris(at.x, at.y, b.debris, 240 + b.radius * 3);
    this.particles.sparks(at.x, at.y, Math.round(b.debris * 0.6), 380 + b.radius * 3);
    this.particles.smoke(at.x, at.y, Math.round(b.radius / 8), b.radius * 0.45);
    this.particles.streaks(at.x, at.y, 12, Math.atan2(-p.vy, -p.vx), TAU, b.radius * 0.9);

    // Blowback on the player if they stood too close to their own rocket.
    const dx = this.sm.pos.x - at.x, dy = (this.sm.pos.y - 50) - at.y;
    const d = Math.hypot(dx, dy);
    if (d < b.radius * 2.4) {
      const f = (1 - d / (b.radius * 2.4)) * b.radius * 7;
      this.sm.vel.x += (dx / (d || 1)) * f;
      this.sm.vel.y += (dy / (d || 1)) * f - 60;
      this.sm.onGround = false;
    }
  }

  private equip(i: number): void {
    if (i === this.equipped || i < 0 || i >= this.weapons.length) return;
    this.weapon.onUnequip(this.makeCtx(0, this.pointerWorld()));
    this.equipped = i;
    this.weapon.onEquip();
    this.wheel.hovered = i;
    audio.play('ui');
  }

  private decayEffects(dt: number): void {
    this.shakeAmt = damp(this.shakeAmt, 0, 9, dt);
    this.flashAmt = Math.max(0, this.flashAmt - dt * 3.4);
    this.invertT = Math.max(0, this.invertT - dt);
    const s = this.shakeAmt;
    this.shakeOff = {
      x: hashNoise(1, Math.floor(this.time * 90)) * s,
      y: hashNoise(2, Math.floor(this.time * 90) + 5) * s,
    };
  }

  // ------------------------------------------------------------------ won ---

  private updateWon(dt: number): void {
    this.sm.update(dt, this.terrain, { axis: 0, down: false, jump: false, jumpHeld: false },
      { x: this.sm.pos.x + 300, y: this.sm.pos.y - 120 });
    this.sm.setHands(null);
    this.sm.setStance(null);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt, this.terrain);
      if (p.dead) { if (p.hitAt) this.detonate(p, p.hitAt); this.projectiles.splice(i, 1); }
    }
    this.particles.update(dt, this.terrain);
    this.decayEffects(dt);

    if (this.phaseTime > 0.7) {
      const press = this.input.pressPoint();
      if (press) {
        const p = this.toWorld(press.x, press.y);
        if (hitRect(this.restartBtn, p)) this.restart();
        else if (hitRect(this.menuBtn, p)) this.toMenu();
      }
      if (this.input.justPressed('KeyR')) this.restart();
      if (this.input.justPressed('Escape')) this.toMenu();
    }
  }

  private restart(): void {
    audio.play('ui');
    this.phase = 'playing';
    this.phaseTime = 0;
    this.resetWorld();
  }

  private toMenu(): void {
    audio.play('ui');
    audio.stopMusic();
    this.phase = 'menu';
    this.phaseTime = 0;
    this.resetWorld();
  }

  // --------------------------------------------------------------- render ---

  private render(dt: number): void {
    const c = this.ctx;
    const { w, h } = this.view;
    c.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);

    c.save();
    c.translate(this.shakeOff.x, this.shakeOff.y);

    this.terrain.draw(c);
    this.particles.draw(this.sk);
    // The impact fan sits under the figure: a hit must never hide who threw it.
    this.impacts.draw(this.sk, w, this.invertT > 0);

    const wctx = this.makeCtx(dt, this.pointerWorld());
    if (this.phase === 'playing') this.weapon.drawBehind(this.sk, wctx);
    this.sm.draw(this.sk);
    if (this.phase === 'playing') this.weapon.draw(this.sk, wctx);
    for (const p of this.projectiles) p.draw(this.sk);

    c.restore();

    // A hard black/white inversion is the punctuation these animations use for
    // their biggest hits, so that is exactly what a heavy blast does here.
    if (this.flashAmt > 0.01 || this.invertT > 0) {
      c.save();
      c.globalCompositeOperation = 'difference';
      c.globalAlpha = this.invertT > 0 ? 1 : clamp(this.flashAmt, 0, 1) * 0.85;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, w, h);
      c.restore();
    }

    if (this.phase === 'playing') {
      this.drawHud();
      if (this.isTouch) {
        this.touch.drawStick(this.sk);
        this.touch.drawAim(this.sk, this.time, this.eye);
        this.touch.drawPad(this.sk, this.view, (x, y, s) => this.weapon.icon(this.sk, x, y, s));
      }
    }
    this.wheel.draw(
      this.sk, this.wheelLayout(), this.weapons, this.equipped, this.view,
      this.isTouch ? 'LIFT YOUR FINGER TO EQUIP' : 'RELEASE TAB TO EQUIP',
    );
    if (this.phase === 'menu') this.drawMenu();
    if (this.phase === 'won') this.drawWin();
    if (!this.isTouch) this.drawCursor();
  }

  private drawHud(): void {
    const sk = this.sk;
    const c = this.ctx;
    const { w, h } = this.view;
    const frac = this.terrain.destroyed;
    const barW = clamp(w * 0.42, 240, 470);
    const topY = 34 + this.safe.top;
    drawProgress(sk, w / 2, topY, barW, frac, `WALL DESTROYED  ${(frac * 100).toFixed(1)}%`);

    // Current weapon. On touch the bottom edge belongs to the thumbs, so the
    // readout moves up under the meter instead.
    const w2 = this.weapon;
    const compact = this.isTouch;
    const left = 44 + this.safe.left;
    const baseY = compact ? topY + 58 : h - 70 - this.safe.bottom;
    // The bottom strip of the screen is the floor slab, which is solid black.
    // Anything printed down there has to be knocked out in white to be read.
    const ink = baseY > this.terrain.groundTop ? '#fff' : '#000';
    c.save();
    const nameSize = clamp(w * 0.02, 15, 24);
    inkText(sk, slotKey(this.equipped), left, baseY + 8, nameSize * 1.65, { align: 'center', alpha: 0.85, color: ink });
    inkText(sk, w2.name, left + nameSize * 1.35, baseY, nameSize, { align: 'left', color: ink });
    if (!compact) inkText(sk, w2.tagline.toUpperCase(), left + 34, baseY + 24, 13, { align: 'left', alpha: 0.55, color: ink });

    const barX = left + nameSize * 1.35;
    const barY = baseY + (compact ? nameSize * 0.85 : 38);
    const cdW = clamp(w * 0.16, 110, 180);
    const meter = w2.charge > 0 ? w2.charge : 1 - w2.cooldownFrac;
    c.strokeStyle = ink;
    c.lineWidth = 2;
    sk.polyPath([
      { x: barX, y: barY }, { x: barX + cdW, y: barY },
      { x: barX + cdW, y: barY + 8 }, { x: barX, y: barY + 8 },
    ], 0.8);
    c.stroke();
    c.fillStyle = ink;
    c.fillRect(barX + 2, barY + 2, Math.max(0, (cdW - 4) * clamp(meter, 0, 1)), 4);
    if (w2.charge > 0.02) inkText(sk, 'CHARGING', barX + cdW + 44, barY + 4, 12, { alpha: 0.7, color: ink });

    // The running melee chain, so the player can see the combo they are on.
    const combo = w2.comboLabel;
    if (combo) {
      inkText(sk, combo, barX + cdW + 16, barY + 5, clamp(w * 0.017, 12, 17),
        { align: 'left', alpha: 0.85, wobble: 1.2, color: ink });
    }
    c.restore();

    // Controls, fading out once the player has clearly got the idea. On touch
    // they sit centred under the meter; the right edge is too narrow for them
    // and the bottom corners belong to the thumbs.
    if (this.hintFade > 0.01) {
      c.save();
      c.globalAlpha = this.hintFade;
      const size = clamp(w * 0.013, 10, 14);
      if (this.isTouch) {
        const lines = [
          'TILT THE LEFT SIDE TO WALK  ·  PUSH IT FURTHER TO SPRINT',
          'UP JUMPS  ·  DOWN CROUCHES  ·  DRAG THE RIGHT SIDE TO AIM',
          'HOLD THE PAD BELOW, SLIDE, LIFT TO EQUIP',
        ];
        // Centred on the open ground, not the screen: on a narrow portrait
        // screen the middle is already black wall and the text vanishes into it.
        const cx = clamp(this.terrain.wallX / 2, w * 0.26, w / 2);
        lines.forEach((l, i) => inkText(
          sk, l, cx, topY + 46 + i * (size + 7), size, { align: 'center', alpha: 0.55 },
        ));
      } else {
        const lines = [
          'WASD / ARROWS  RUN     HOLD SHIFT  SPRINT',
          'SPACE  JUMP  (again in mid-air to flip)',
          'MOUSE  AIM     CLICK  ATTACK     HOLD  HEAVY COMBO',
          'HOLD TAB  WEAPON WHEEL     1-0 - =  QUICK SWAP',
        ];
        const y0 = h - 96 - this.safe.bottom;
        const hintInk = y0 > this.terrain.groundTop ? '#fff' : '#000';
        lines.forEach((l, i) => inkText(
          sk, l, w - 20 - this.safe.right, y0 + i * (size + 8), size,
          { align: 'right', alpha: 0.6, color: hintInk },
        ));
      }
      c.restore();
    }

    // Once the wall is nearly gone, ring what is left so nobody hunts pixels.
    if (frac > 0.9 && frac < WIN_THRESHOLD) {
      const b = this.terrain.wallBounds();
      if (b) {
        const pulse = 0.4 + Math.sin(this.time * 7) * 0.25;
        c.save();
        c.globalAlpha = pulse;
        c.strokeStyle = '#000';
        c.lineWidth = 2.5;
        c.setLineDash([9, 7]);
        c.strokeRect(b.x0 - 14, b.y0 - 14, (b.x1 - b.x0) + 28, (b.y1 - b.y0) + 28);
        c.restore();
        inkText(sk, 'LAST PIECES', (b.x0 + b.x1) / 2, b.y0 - 28, 15, { alpha: pulse });
      }
    }
  }

  private drawMenu(): void {
    const sk = this.sk;
    const c = this.ctx;
    const { w, h } = this.view;
    const t = this.phaseTime;

    c.save();
    c.globalAlpha = 0.86;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);
    c.restore();

    const big = clamp(w * 0.115, 46, 108);
    const small = big * 0.7;
    const titleY = h * 0.22;

    const pop = easeOutBack(clamp(t / 0.7, 0, 1));
    c.save();
    c.translate(w / 2, titleY);
    c.scale(pop, pop);
    inkText(sk, 'STICK FIGURE', 0, -big * 0.46, small, { wobble: 1.4 });
    inkText(sk, 'PWNAGE', 0, big * 0.34, big, { wobble: 1.6 });
    c.restore();

    // Speed lines flanking the title, straight out of the source material.
    const lineFade = clamp((t - 0.35) / 0.5, 0, 1);
    c.save();
    c.globalAlpha = lineFade * 0.8;
    c.strokeStyle = '#000';
    const titleW = measureText(sk, 'PWNAGE', big) / 2 + big * 0.4;
    for (const side of [-1, 1]) {
      sk.burst(w / 2 + side * titleW, titleY + big * 0.2, 7, 20, Math.min(190, w * 0.2), 3, 1.1,
        side > 0 ? 0 : Math.PI, 40 + side);
    }
    c.restore();

    inkText(sk, 'A PLAYABLE TRIBUTE', w / 2, h * 0.4, clamp(w * 0.022, 14, 19),
      { alpha: clamp((t - 0.5) / 0.5, 0, 1) * 0.72, wobble: 0.6 });
    inkText(sk, 'ONE STICK FIGURE, TWELVE WEAPONS, ONE VERY DOOMED WALL', w / 2, h * 0.4 + 26,
      clamp(w * 0.019, 12, 17), { alpha: clamp((t - 0.5) / 0.5, 0, 1) * 0.55, wobble: 0.5 });

    const press = this.input.pointer;
    const hovered = !this.isTouch && hitRect(this.startBtn, this.toWorld(press.x, press.y));
    c.save();
    c.globalAlpha = clamp((t - 0.6) / 0.4, 0, 1);
    inkButton(sk, this.startBtn, 'START PWNAGE', hovered, clamp(w * 0.032, 22, 34));
    c.restore();

    const cf = clamp((t - 0.9) / 0.6, 0, 1);
    const rows: Array<[string, string]> = this.isTouch
      ? [
          ['LEFT THUMB', 'tilt to walk, push it out to sprint'],
          ['UP / DOWN', 'jump and crouch, on the same thumb'],
          ['RIGHT THUMB', 'press to attack, drag to swing the aim round'],
          ['PAD AT THE BOTTOM', 'hold, slide to a weapon, lift to equip'],
          ['GOAL', 'wipe the black wall off the screen'],
        ]
      : [
          ['WASD / ARROWS', 'run and crouch'],
          ['SHIFT', 'sprint — attacking from a run is its own move'],
          ['SPACE', 'jump — press again in the air to somersault'],
          ['MOUSE', 'aim   ·   CLICK to attack, keep going for combos'],
          ['HOLD TAB', 'weapon wheel   ·   1-0 - = to quick swap'],
          ['GOAL', 'wipe the black wall off the screen'],
        ];
    const rowSize = clamp(w * 0.019, 11, 16);
    const rowGap = rowSize + 10;
    const rowsTop = h * 0.73;
    rows.forEach((r, i) => {
      const y = rowsTop + i * rowGap;
      inkText(sk, r[0], w / 2 - 12, y, rowSize, { align: 'right', alpha: cf * 0.9 });
      inkText(sk, r[1].toUpperCase(), w / 2 + 12, y, rowSize * 0.94, { align: 'left', alpha: cf * 0.55 });
    });
    inkText(sk, 'SOUND: GUITAR, BASS AND DRUMS, ALL SYNTHESISED LIVE IN YOUR BROWSER',
      w / 2, h - 16, clamp(w * 0.014, 9, 12), { alpha: cf * 0.4 });
  }

  private drawWin(): void {
    const sk = this.sk;
    const c = this.ctx;
    const { w, h } = this.view;
    const t = this.phaseTime;

    c.save();
    c.globalAlpha = clamp(t / 0.5, 0, 1) * 0.82;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);
    c.restore();

    const cy = h * 0.4;
    const big = clamp(w * 0.14, 54, 138);

    // Radiating impact lines behind the banner.
    c.save();
    c.globalAlpha = clamp(t / 0.4, 0, 1);
    c.strokeStyle = '#000';
    const n = 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this.time * 0.25;
      const r0 = big * 1.55 + Math.sin(this.time * 4 + i) * 12;
      const r1 = r0 + big * 0.9 + hashNoise(i, 3) * 90;
      c.lineWidth = 2 + (i % 3);
      c.beginPath();
      c.moveTo(w / 2 + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.62);
      c.lineTo(w / 2 + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.62);
      c.stroke();
    }
    c.restore();

    const pop = easeOutBack(clamp(t / 0.55, 0, 1));
    const wob = 1 + Math.sin(this.time * 6) * 0.014;
    c.save();
    c.translate(w / 2, cy);
    c.scale(pop * wob, pop * wob);
    c.rotate(Math.sin(this.time * 2.2) * 0.012);
    inkText(sk, 'YOU PWNED', 0, 0, big, { wobble: 2.2 });
    c.restore();

    const sub = clamp((t - 0.5) / 0.5, 0, 1);
    inkText(sk, `WALL ERASED IN ${this.stats.elapsed.toFixed(1)}S  ·  ${this.stats.shots} ATTACKS`,
      w / 2, cy + big * 0.78, clamp(w * 0.022, 13, 19), { alpha: sub * 0.75 });

    const ptr = this.toWorld(this.input.pointer.x, this.input.pointer.y);
    c.save();
    c.globalAlpha = clamp((t - 0.7) / 0.4, 0, 1);
    const btnSize = clamp(w * 0.026, 18, 28);
    inkButton(sk, this.restartBtn, 'AGAIN', !this.isTouch && hitRect(this.restartBtn, ptr), btnSize);
    inkButton(sk, this.menuBtn, 'MAIN MENU', !this.isTouch && hitRect(this.menuBtn, ptr), btnSize);
    if (!this.isTouch) {
      inkText(sk, 'R  RESTART        ESC  MENU', w / 2, this.restartBtn.y + this.restartBtn.h + 30, 13, { alpha: 0.45 });
    }
    c.restore();
  }

  /** A drawn crosshair, since the CSS cursor is hidden over the canvas. */
  private drawCursor(): void {
    const p = this.pointerWorld();
    const c = this.ctx;
    const sk = this.sk;
    const spin = this.time * 0.6;
    c.save();
    c.strokeStyle = '#000';
    c.lineWidth = 2.4;
    const r = this.phase === 'playing' ? 13 : 9;
    const pts: Vec2[] = [];
    for (let i = 0; i < 7; i++) {
      const a = spin + (i / 7) * TAU;
      pts.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
    }
    sk.polyPath(pts, 1);
    c.stroke();
    for (const d of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      c.beginPath();
      c.moveTo(p.x + Math.cos(d) * (r + 4), p.y + Math.sin(d) * (r + 4));
      c.lineTo(p.x + Math.cos(d) * (r + 11), p.y + Math.sin(d) * (r + 11));
      c.stroke();
    }
    c.restore();
  }
}
