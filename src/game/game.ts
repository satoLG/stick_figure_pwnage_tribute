import { audio, type SfxName } from '../core/audio';
import { Input } from '../core/input';
import { clamp, damp, easeOutBack, hashNoise, rand, TAU, vec, type Vec2 } from '../core/math';
import { Sketch } from '../core/sketch';
import { Gamepads, type PadState } from '../core/gamepad';
import { installer } from '../core/pwa';
import { AimSolver, type AimMode } from '../ui/aim';
import { cueWidth, drawStartCue, fitCueSize } from '../ui/cue';
import { SettingsMenu, type InputReport } from '../ui/settings-menu';
import { TouchControls, type TouchState } from '../ui/touch';
import {
  drawProgress, focusRing, hitRect, inkButton, inkText, measureText, slotKey, WeaponWheel,
  type Rect, type WheelLayout,
} from '../ui/ui';
import { ImpactFx } from './impact';
import { Particles } from './particles';
import { applyBlast, Projectile } from './projectiles';
import { BODY_H, RUN_PUSH, Stickman, type Controls } from './stickman';
import { computeWorldSize, Terrain } from './terrain';
import { createArsenal, type Weapon, type WeaponCtx } from './weapons';

type Phase = 'menu' | 'playing' | 'won';

/** The wall is never quite 100% clean; sweep the last slivers instead. */
const WIN_THRESHOLD = 0.994;

/**
 * How far the aiming stick has to go to read as a swing, and how far back it
 * has to come to stop being one. The gap between them is what stops a stick
 * resting on the line from machine-gunning.
 */
const SWING_ON = 0.62;
const SWING_OFF = 0.42;

/** Past the number row the slots carry on along the top of the keyboard. */
const NUMBER_KEYS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight',
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
  /**
   * Where a drawing is actually made. The picture is remade fifteen times a
   * second, and the last one made is blitted onto the glass sixty times a
   * second with the cursor drawn on top of it - so the scene keeps the film's
   * cadence while the crosshair still tracks the mouse at the rate the mouse
   * moves. A crosshair stepping at fifteen is not a stylistic choice, it is a
   * broken mouse.
   */
  private frame = document.createElement('canvas');
  private frameCtx: CanvasRenderingContext2D;
  private sk: Sketch;
  private input: Input;
  private touch = new TouchControls();
  private pads = new Gamepads();
  private padAim = new AimSolver();
  private menu = new SettingsMenu();
  /** Whichever device spoke last; it decides the controls, HUD and aim mode. */
  private device: 'touch' | 'desk' | 'pad' = 'desk';
  private pad: PadState = this.pads.read();

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
  /** Light banked from blasts, spent on inverted drawings. Never painted. */
  private flashAmt = 0;
  private invertT = 0;
  /**
   * The swipe card: seconds left on the two drawings where the whole picture
   * is thrown away and replaced by one white sweep on black paper.
   *
   * The source cuts to it on the blows that matter, and it is doing something
   * an inversion cannot: an inverted frame still shows the scene, only in
   * negative, so the eye keeps reading positions out of it. This shows nothing
   * but the shape of the stroke, which is why the blow after it lands so hard.
   */
  private swipeT = 0;
  private swipeDir = 0;
  private swipeSeed = 0;
  private timeScale = 1;
  private hintFade = 1;
  /**
   * Whether the wall has been hit yet, which is the run's real starting gun.
   * Until it happens the screen carries the cue telling the player what to do
   * and nothing else; the moment it does, the cue goes and the meter arrives.
   * Nobody needs a progress bar for progress they have not started making.
   */
  private wallHit = false;
  /** 0..1 through the cue's exit, and 0..1 through the meter's entrance. */
  private cueOut = 0;
  private meterIn = 0;

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
  /** Where the wall's face starts, so a test can stand him a fixed way off it. */
  get wallFaceX(): number { return this.terrain.wallX; }
  get equippedIndex(): number { return this.equipped; }
  get installOffer(): string | null { return installer.offer; }
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('2D canvas is not available in this browser');
    this.ctx = c;
    const fc = this.frame.getContext('2d', { alpha: false });
    if (!fc) throw new Error('2D canvas is not available in this browser');
    this.frameCtx = fc;
    this.sk = new Sketch(c);
    this.input = new Input(canvas);
    // A first guess from the media query, so the title card offers the right
    // instructions before anything has been touched, clicked or pressed.
    this.device = this.input.touchMode ? 'touch' : 'desk';
    this.view = computeWorldSize(window.innerWidth, window.innerHeight);
    this.terrain = new Terrain(this.view.w, this.view.h, this.hudBand);
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
    // Resizing empties the buffer, so the next frame has to be a real drawing
    // rather than a blit of what is no longer in there.
    this.frame.width = this.canvas.width;
    this.frame.height = this.canvas.height;
    this.drawnTick = -1;

    const resized = size.w !== this.view.w || size.h !== this.view.h;
    this.view = size;
    this.scaleX = this.canvas.width / this.view.w;
    this.scaleY = this.canvas.height / this.view.h;
    // The strip depends on the safe area, and the terrain is laid out under the
    // strip, so both have to be read before the level is told where to sit.
    this.readSafeArea();
    this.menu.layout(this.view, { top: this.topInset, right: this.safe.right });
    if (resized || this.terrainGap !== this.hudBand) {
      this.terrainGap = this.hudBand;
      // Re-lays the level at the new size, keeping the damage already done.
      this.terrain.resizeTo(size.w, size.h, this.terrainGap);
      this.settlePlayer();
      this.layoutButtons();
    }
  }

  /**
   * The strip along the top that belongs to the HUD - the meter and the cog,
   * and whatever joins them later. The scene is laid out underneath it, so the
   * wall never climbs into the readouts; it is all white either way, so the two
   * read as one picture rather than a game with a bar bolted over it.
   */
  private get hudBand(): number {
    return this.topInset + clamp(this.view.h * 0.05, 44, 92) * this.hudK + 26;
  }

  /**
   * How far down the HUD has to start.
   *
   * The notch inset covers notches and home bars, and nothing else: a phone
   * browser's own toolbar is not part of the safe area, and in landscape it
   * sits translucently over the top of the page and was slicing the top off
   * the meter's label. So the strip is never thinner than a toolbar's worth of
   * CSS pixels, whatever the safe area says.
   */
  private get topInset(): number {
    return Math.max(this.safe.top, (22 * this.view.h) / Math.max(1, this.cssH));
  }
  private terrainGap = -1;

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

  /**
   * After a re-lay the figure can be anywhere relative to the new terrain -
   * mid-air, or inside the wall. The same containment that runs every frame of
   * play sorts it out, so there is only ever one idea of where he may be.
   */
  private settlePlayer(): void {
    const t = this.terrain;
    const sm = this.sm;
    sm.pos.x = clamp(sm.pos.x, 20, t.w - 20);
    sm.pos.y = clamp(sm.pos.y, t.sceneTop + BODY_H, t.h);
    // Out of play - a rotation, a window drag - there is no such thing as being
    // flung, so if the new level has swallowed him he is simply lifted clear of
    // it, and failing that set back down on the open ground.
    let guard = 0;
    while (guard++ < 400 && t.solidAt(sm.pos.x, sm.pos.y - 8)) sm.pos.y -= 4;
    if (t.solidAt(sm.pos.x, sm.pos.y - 8) || sm.pos.y < t.sceneTop + BODY_H) {
      sm.pos.x = Math.max(60, t.wallX - 90);
      sm.pos.y = t.groundSurface(sm.pos.x);
    }
    sm.contain(t);
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
  private installBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Showing the iOS "add to home screen" recipe, which is all iOS allows. */
  private howToInstall = false;
  private restartBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private menuBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };

  private layoutButtons(): void {
    const { w, h } = this.view;
    const bw = clamp(w * 0.42, 260, 380);
    const bh = clamp(h * 0.09, 62, 84);
    this.startBtn = { x: w / 2 - bw / 2, y: h * 0.56, w: bw, h: bh };
    // Under it, and deliberately smaller: an offer, not a second front door.
    const iw = bw * 0.62;
    const ih = bh * 0.62;
    this.installBtn = { x: w / 2 - iw / 2, y: this.startBtn.y + bh + ih * 0.4, w: iw, h: ih };

    const sw = clamp(w * 0.3, 170, 240);
    const sh = clamp(h * 0.075, 54, 68);
    const gap = 20;
    const y = h * 0.6;
    this.restartBtn = { x: w / 2 - sw - gap / 2, y, w: sw, h: sh };
    this.menuBtn = { x: w / 2 + gap / 2, y, w: sw, h: sh };
  }

  private resetWorld(): void {
    this.terrain = new Terrain(this.view.w, this.view.h, this.hudBand);
    this.particles.clear();
    this.impacts.clear();
    this.freezeT = 0;
    this.pending.length = 0;
    this.projectiles.length = 0;
    this.weapons = createArsenal();
    this.equipped = 0;
    this.wheel.hovered = 0;
    this.touch.reset();
    this.sm.reset(Math.min(276, this.view.w * 0.22), this.terrain.groundTop - 40);
    this.wallHit = false;
    this.cueOut = 0;
    this.meterIn = 0;
    this.shakeAmt = 0;
    this.flashAmt = 0;
    this.invertT = 0;
    this.swipeT = 0;
    this.hintFade = 1;
    this.stats = { shots: 0, elapsed: 0 };
    this.layoutButtons();
  }

  private get weapon(): Weapon { return this.weapons[this.equipped]; }
  private get isTouch(): boolean { return this.device === 'touch'; }

  /**
   * How the aim is read, which depends on both the device in hand and what is
   * in his: a shot down a line cannot afford the slop a swing shrugs off.
   *
   * A thumb has no stick under it, so for anything ranged it aims at the spot
   * it is touching - the one reading with no wobble in it at all - and for
   * melee at the raw angle, which is instant and forgiving. A real stick does
   * spring back and does need easing.
   */
  private get aimMode(): AimMode {
    if (this.device === 'pad') return 'eased';
    // A finger already *is* a position. On touch there is nothing to gain by
    // reading a swing as a direction the way a thumbstick has to be read - you
    // put your finger where you want the blow to land and it lands there - so
    // every power points at the touch point, melee included.
    if (this.device === 'touch') return 'point';
    return this.weapon.ranged ? 'point' : 'direct';
  }

  private wheelLayout(): WheelLayout {
    if (this.isTouch) return this.touch.layout(this.view);
    return {
      kind: 'ring',
      anchor: { x: this.view.w / 2, y: this.view.h / 2 },
      radius: clamp(Math.min(this.view.w, this.view.h) * 0.3, 150, 240),
    };
  }

  /** What this machine can be played with, and what is in hand right now. */
  private inputReport(): InputReport {
    return {
      touch: (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window,
      desk: window.matchMedia?.('(pointer: fine)')?.matches ?? true,
      pad: this.pads.name,
      active: this.device,
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
      flash: (a) => this.addFlash(a),
      invert: (s) => { this.invertT = Math.max(this.invertT, s); },
      hit: (x, y, dir, power) => {
        this.impacts.add(x, y, dir, power);
        // Only the heavy end of the range earns the card; on every jab it
        // would be a strobe rather than punctuation.
        if ((power ?? 1) >= 1.5) this.swipe(dir);
      },
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
   * How often the world is stepped. Sixty, always: this is what the controls
   * are read on, and nothing about the look of the thing is worth answering a
   * button sixty milliseconds late.
   */
  private animFps = 60;

  /**
   * How often a new drawing is *made*, which is a separate question and the
   * one the film answers for us.
   *
   * Counted off the source frame by frame, half of every pair of video frames
   * in it is pixel-identical to the one before: it is animated on twos, at
   * fifteen unique drawings a second, and holding each of them for two frames
   * is a good part of why it moves the way it does. A stick figure redrawn
   * sixty times a second is a smooth interpolation of a drawing; redrawn
   * fifteen times it is a drawing.
   *
   * So the world runs at sixty and the picture is remade at fifteen. What is
   * on the glass between two of those is simply the last one, still up. `V`
   * puts it back on sixty for comparison.
   */
  private drawHz = 15;
  private drawnTick = -1;
  /** Real seconds banked since the last drawing, so `ctx.dt` stays honest. */
  private drawAcc = 0;

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
    if (this.input.justPressed('KeyV')) this.drawHz = this.drawHz === 15 ? 60 : 15;

    this.pad = this.pads.read();
    this.pickDevice();
    this.routeMenu();

    // The settings menu holds the world still. Anything else would have the
    // player fighting the game with one hand while changing it with the other.
    if (this.menu.open) {
      this.present(rawDt);
      this.input.endFrame(rawDt);
      return;
    }

    // Held time: the world stops, the picture stays up, the screen keeps
    // shaking. Input still reaches the buffer, it just cannot move anything yet.
    if (this.freezeT > 0) {
      this.freezeT = Math.max(0, this.freezeT - rawDt);
      this.decayEffects(rawDt);
      this.present(rawDt);
      this.input.endFrame(rawDt);
      return;
    }
    this.impacts.step(rawDt);

    switch (this.phase) {
      case 'menu': this.updateMenu(rawDt); break;
      case 'playing': this.updatePlaying(rawDt); break;
      case 'won': this.updateWon(rawDt); break;
    }

    this.present(rawDt);
    this.input.endFrame(rawDt);
  }

  /**
   * One drawing every 1/15s, and the one already on the glass in between.
   * The banked time goes to whoever is drawn, so anything that ages inside a
   * draw ages by the whole gap rather than by one sixtieth of it.
   */
  private present(rawDt: number): void {
    this.drawAcc += rawDt;
    const tick = Math.floor(this.time * this.drawHz);
    if (tick !== this.drawnTick) {
      this.drawnTick = tick;
      const dt = this.drawAcc;
      this.drawAcc = 0;
      // Everything paints into the buffer; the glass is only ever blitted to.
      const glass = this.ctx;
      this.ctx = this.frameCtx;
      this.sk.ctx = this.frameCtx;
      this.render(dt);
      this.ctx = glass;
      this.sk.ctx = glass;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.frame, 0, 0);
    if (this.device === 'desk') {
      c.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
      this.drawCursor();
    }
  }

  /**
   * Whichever device spoke last owns the screen. A pad only takes over once it
   * actually does something, so plugging one in mid-run changes nothing until
   * it is picked up, and touching the glass hands it straight back.
   */
  private pickDevice(): void {
    if (this.pad.any) this.device = 'pad';
    else if (this.input.touchActivity) this.device = 'touch';
    else if (this.input.deskActivity) this.device = 'desk';
    // Nothing said anything: whoever had it, keeps it. Letting go of both
    // sticks is not the same as reaching for the mouse.
  }

  /**
   * The settings menu gets first refusal on every press, and marks whatever it
   * takes so the controls underneath never see it as a swing.
   */
  private routeMenu(): void {
    const inp = this.input;
    if (this.phase === 'won') { this.menu.open = false; return; }
    if (inp.justPressed('Escape') || this.pad.menu) {
      this.menu.toggle();
      audio.play('ui');
    }
    for (const p of inp.pointers.values()) {
      if (p.kind !== 'touch' || p.role !== '' || !p.justDown) continue;
      if (this.menu.press(this.toWorld(p.x, p.y))) p.role = 'ui';
    }
    if (inp.mousePressed && this.menu.press(this.pointerWorld())) inp.mousePressed = false;

    // A pad cannot point at anything, so it walks the card instead: a step per
    // push of either stick or the d-pad, A to take it, B to back out.
    if (!this.menu.open) return;
    if (this.menu.moveFocus(this.pad.navX, this.pad.navY)) audio.play('wheel', 1.15);
    if (this.pad.confirm && this.menu.confirm()) audio.play('ui', 1.1);
    if (this.pad.back) { this.menu.open = false; audio.play('ui', 0.85); }
  }

  /** True while a gamepad is what is driving the menus, so they say where they are. */
  private get padPicking(): boolean {
    return this.device === 'pad';
  }

  /** Which of the two win-screen buttons a gamepad has selected. */
  private winFocus = 0;
  /** And which of the title card's, when there is more than one to pick from. */
  private titleFocus = 0;

  /** Merges keyboard, mouse, thumbs and gamepad into one set of wishes. */
  private readIntent(rawDt: number): Intent {
    const inp = this.input;
    const pad = this.pad;
    const mode = this.aimMode;
    const t = this.touch.update(inp, rawDt, this.view, this.toWorld, this.eye, mode);

    let numberKey: number | null = null;
    for (let i = 0; i < NUMBER_KEYS.length; i++) {
      if (inp.justPressed(NUMBER_KEYS[i])) numberKey = i;
    }

    // A key has no in-between, so it reports exactly the deflection that means
    // "run", and SHIFT pushes it the rest of the way into a sprint. A thumb on
    // the analog stick gets the whole range for free, and so does a pad's.
    const keyAxis = ((inp.anyDown('KeyD', 'ArrowRight') ? 1 : 0) - (inp.anyDown('KeyA', 'ArrowLeft') ? 1 : 0))
      * (inp.anyDown('ShiftLeft', 'ShiftRight') ? 1 : RUN_PUSH);
    const wheelOpen = inp.down('Tab') || t.wheelOpen || pad.wheel;

    const shove = this.padAttack(pad, wheelOpen);
    // The pad's right stick is a stick like the touch one, only a real one, so
    // it goes through the same solver - eased, because it springs back.
    const padAim = this.padAim.update(rawDt, mode, {
      active: this.device === 'pad', fresh: false,
      nx: shove.aim.x, ny: shove.aim.y, dead: 0.001,
      world: this.eye, eye: this.eye,
    });

    return {
      axis: keyAxis !== 0 ? keyAxis : (pad.move.x !== 0 ? pad.move.x : t.axis),
      down: inp.anyDown('KeyS', 'ArrowDown') || t.crouch || pad.crouch,
      jump: inp.justPressed('Space') || t.jump || pad.jumpPressed,
      jumpHeld: inp.down('Space') || t.jumpHeld || pad.jump,
      aim: this.resolveAim(t, padAim),
      firing: (!wheelOpen && (inp.mouseDown || shove.firing)) || t.firing,
      firePressed: (!wheelOpen && (inp.mousePressed || shove.pressed)) || t.firePressed,
      wheelOpen,
      wheelPointer: this.wheelPointer(t, pad),
      wheelReleased: inp.justReleased('Tab') || t.wheelReleased || pad.wheelReleased,
      numberKey,
    };
  }

  /** True while the aiming stick is shoved far enough to count as an attack. */
  private stickSwinging = false;

  /**
   * Attacking with a pad, the way a fighting game does it: a direction is an
   * attack, and an attack takes a direction.
   *
   * Shoving the right stick swings that way on its own - no button - and lets
   * go of a charge the moment the stick comes back to centre, so a charged shot
   * to the right is hold-right-then-release. The attack button is still there
   * for a swing straight ahead, and while it is held the *left* stick aims as
   * well as walks, so a run can be turned into a lunge without moving a thumb.
   *
   * The two cannot fight over the aim because the right stick always wins it:
   * a hand shoving one stick to aim is not also asking with the other.
   */
  private padAttack(pad: PadState, wheelOpen: boolean): { aim: Vec2; firing: boolean; pressed: boolean } {
    const shove = Math.hypot(pad.aim.x, pad.aim.y);
    const was = this.stickSwinging;
    // Two thresholds: it takes a shove to start swinging and a real let-go to
    // stop, so a stick resting on the line does not machine-gun.
    const swinging = this.device === 'pad' && !wheelOpen
      && shove > (was ? SWING_OFF : SWING_ON);
    const pressed = swinging && !was;
    this.stickSwinging = swinging;

    const aim = shove > 0.001 ? pad.aim
      // Nothing on the aiming stick: the walking one steers the swing instead,
      // but only while the button is actually down, or every step would aim.
      : (pad.fire && Math.hypot(pad.move.x, pad.move.y) > 0.001) ? pad.move
        : { x: 0, y: 0 };
    return { aim, firing: swinging || pad.fire, pressed: pressed || pad.firePressed };
  }

  /** Where the wheel thinks the pointer is, in whichever way it is being driven. */
  private wheelPointer(t: TouchState, pad: PadState): Vec2 {
    if (t.wheelOpen) return t.wheelPointer;
    if (this.device === 'pad') {
      // A stick has no position, so it points *out* of the ring's middle and
      // the wheel picks the slot nearest whatever it lands on.
      const l = this.wheelLayout();
      return { x: l.anchor.x + pad.aim.x * l.radius, y: l.anchor.y + pad.aim.y * l.radius };
    }
    return this.pointerWorld();
  }

  /** Shoulder height, where his aim is measured from. */
  private get eye(): Vec2 {
    return { x: this.sm.pos.x, y: this.sm.pos.y - 74 };
  }

  /**
   * Where the figure is looking, which is also which way he faces.
   *
   * Aiming owns this outright - the cursor, the aiming thumb or the right stick
   * - and the walking controls never touch it: he can run, jump and crouch one
   * way while still looking and swinging the other. A mouse points at a spot,
   * so it is the aim. A stick gives a *direction*, which is cast out from his
   * shoulder rather than aimed at: far enough that the offset between his
   * shoulder and a muzzle stops mattering, so every barrel fires the way the
   * stick points instead of converging on a spot in front of him.
   */
  private resolveAim(t: TouchState, padAim: Vec2 | null): Vec2 {
    if (this.device === 'desk') return this.pointerWorld();
    // A finger under a spot is a crosshair on that spot. Everything that wants
    // a target rather than a heading - a homing salvo, a summoned orb, the
    // place a punch is thrown at - gets exactly where the thumb is, and melee
    // swings at it too rather than reading the drag as a direction.
    if (this.device === 'touch' && t.aimAt) return t.aimAt;
    const dir = (this.device === 'pad' ? padAim : t.aimDir) ?? { x: this.sm.facing, y: 0 };
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
    const offer = installer.offer;
    // The recipe card is modal in the smallest possible way: while it is up the
    // only thing a press can do is put it away again.
    if (this.howToInstall) {
      if (press || this.pad.confirm || this.pad.back || this.input.justPressed('Escape')) {
        this.howToInstall = false;
        audio.play('ui', 0.85);
      }
      return;
    }
    if (press && offer && hitRect(this.installBtn, this.toWorld(press.x, press.y))) {
      audio.play('ui');
      if (offer === 'ios') this.howToInstall = true;
      else void installer.promptNow();
      return;
    }
    if (press && hitRect(this.startBtn, this.toWorld(press.x, press.y))) void this.beginRun();
    if (this.input.justPressed('Enter') || this.input.justPressed('Space')) void this.beginRun();

    // A pad walks the card the same as any other menu, when there are two
    // things on it to walk between.
    if (!offer) this.titleFocus = 0;
    else if (this.pad.navY !== 0 || this.pad.navX !== 0) {
      this.titleFocus = this.titleFocus === 0 ? 1 : 0;
      audio.play('wheel', 1.15);
    }
    if (this.pad.confirm || this.pad.firePressed) {
      if (this.titleFocus === 1 && offer) {
        audio.play('ui');
        if (offer === 'ios') this.howToInstall = true;
        else void installer.promptNow();
      } else {
        void this.beginRun();
      }
    }
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
      this.weapons, intent.numberKey,
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
    if (this.sm.justWallJumped) {
      // The scuff of two feet shoving off masonry, thrown back off the wall.
      const side = this.sm.wallKickSide;
      audio.play('step', 1.35);
      this.particles.dust(this.sm.pos.x + side * 14, this.sm.pos.y - 46, 5, side > 0 ? Math.PI : 0, 1.1);
    }
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
    // Swinging in mid-air very nearly stops the fall, so a combo begun off a
    // jump gets to play out up there instead of being dumped on the floor
    // halfway through. Charging counts too - winding up is part of the swing.
    if (!this.sm.onGround
      && (firing || pressed || this.weapon.busy || this.weapon.charge > 0.02)) {
      this.sm.stallFall(0.22);
    }
    this.sm.setHands(this.weapon.hands(wctx));
    // A weapon whose effect has swallowed the arms says so every frame, so
    // putting it away is just not saying it any more.
    this.sm.armsHidden = this.weapon.hidesArms;
    this.sm.headHidden = this.weapon.hidesHead;
    this.sm.bodyHidden = this.weapon.hidesBody;
    this.sm.headScale = this.weapon.headScale;
    this.sm.jumpBoost = this.weapon.jumpBoost;
    this.sm.fallScale = this.weapon.fallScale;
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

    // --- the run properly begins on the first blow that lands --------------
    if (!this.wallHit && this.terrain.destroyed > 0) this.wallHit = true;
    if (this.wallHit) {
      this.cueOut = Math.min(1, this.cueOut + rawDt * 2.6);
      this.meterIn = Math.min(1, this.meterIn + rawDt * 2.2);
    }

    // --- win check ---------------------------------------------------------
    if (this.terrain.destroyed >= WIN_THRESHOLD) {
      this.terrain.sweepRemains();
      this.phase = 'won';
      this.phaseTime = 0;
      this.timeScale = 1;
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
    this.addFlash(b.flash);
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

  /**
   * Arm the swipe card. Two drawings, and never stacked: a second blow landing
   * inside the first only ever re-aims it, because two cards back to back is a
   * flicker and the source never does that.
   */
  private swipe(dir: number): void {
    // A shade under two drawings' worth, so it lands on exactly two of them
    // wherever in the frame the blow happened to arrive.
    this.swipeT = 1.55 / 15;
    this.swipeDir = dir;
    this.swipeSeed = Math.floor(this.time * 60);
  }

  /**
   * The card itself: black paper, one white stroke, nothing else.
   *
   * The stroke is a crescent lying across the blow with its belly thrown the
   * way the blow was going, which is how the source draws the sweep of a
   * weapon when it stops drawing the weapon.
   */
  private drawSwipe(): void {
    const c = this.ctx;
    const { w, h } = this.view;
    c.save();
    c.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);

    const cx = w * (0.46 + hashNoise(this.swipeSeed, 3) * 0.06);
    const cy = h * (0.45 + hashNoise(this.swipeSeed + 5, 3) * 0.05);
    // A third of the picture, as in the source: the card is a stroke on a
    // page, not a shape that fills the frame.
    const len = Math.min(w * 0.46, h * 0.58);
    const ca = Math.cos(this.swipeDir), sa = Math.sin(this.swipeDir);
    // Across the blow for the chord, along it for the belly.
    const px = -sa, py = ca;
    const back = len * 0.12;
    const a = { x: cx - px * len * 0.5 - ca * back, y: cy - py * len * 0.5 - sa * back };
    const b = { x: cx + px * len * 0.5 - ca * back, y: cy + py * len * 0.5 - sa * back };
    const ctrl = { x: cx + ca * len * 0.62, y: cy + sa * len * 0.62 };
    this.sk.ribbonPath(a, ctrl, b, len * 0.3, 0.46, 0.5);
    c.fillStyle = '#fff';
    c.fill();
    c.restore();
  }

  /**
   * Light thrown by a blast. It banks up rather than being painted: past a
   * threshold it spends itself on a single inverted drawing and resets, which
   * is the only form the source has for it. A run of small flashes therefore
   * reads as one hard blink instead of a grey haze that never quite clears.
   */
  private addFlash(a: number): void {
    this.flashAmt += a;
    if (this.flashAmt < 0.45) return;
    this.flashAmt = 0;
    this.invertT = Math.max(this.invertT, 1 / 15);
  }

  private decayEffects(dt: number): void {
    this.shakeAmt = damp(this.shakeAmt, 0, 9, dt);
    this.flashAmt = Math.max(0, this.flashAmt - dt * 3.4);
    this.invertT = Math.max(0, this.invertT - dt);
    this.swipeT = Math.max(0, this.swipeT - dt);
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
    this.sm.armsHidden = false;
    this.sm.headHidden = false;
    this.sm.bodyHidden = false;
    this.sm.headScale = 1;
    this.sm.jumpBoost = 1;
    this.sm.fallScale = 1;
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
      // A pad has no pointer, so it walks the two buttons and takes one.
      if (this.pad.navX !== 0) {
        this.winFocus = this.winFocus === 0 ? 1 : 0;
        audio.play('wheel', 1.15);
      }
      if (this.pad.confirm) { if (this.winFocus === 0) this.restart(); else this.toMenu(); }
      if (this.input.justPressed('KeyR')) this.restart();
      if (this.input.justPressed('Escape') || this.pad.menu || this.pad.back) this.toMenu();
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

    // The swipe card, which outranks everything: for two drawings the picture
    // is gone and one white stroke stands on black paper.
    if (this.swipeT > 0) {
      this.drawSwipe();
    } else if (this.invertT > 0) {
      // A hard black/white inversion is the punctuation these animations use
      // for their biggest hits, so that is what a heavy blast does here - and
      // all it does. There is no half-inversion in the source: the paper is
      // white or it is black, never the grey wash a partly-opaque difference
      // pass leaves over the whole picture.
      c.save();
      c.globalCompositeOperation = 'difference';
      c.fillStyle = '#fff';
      c.fillRect(0, 0, w, h);
      c.restore();
    }

    if (this.phase === 'playing') {
      this.drawHud();
      if (this.isTouch) {
        this.touch.drawStick(this.sk);
        this.touch.drawAim(this.sk, this.time, this.eye, this.aimMode);
        this.touch.drawPad(this.sk, this.view, (x, y, s) => this.weapon.icon(this.sk, x, y, s));
      }
    }
    this.wheel.draw(
      this.sk, this.wheelLayout(), this.weapons, this.equipped, this.view,
      this.device === 'touch' ? 'LIFT YOUR FINGER TO EQUIP'
        : this.device === 'pad' ? 'LET GO OF L1 TO EQUIP' : 'RELEASE TAB TO EQUIP',
    );
    if (this.phase === 'menu') this.drawMenu();
    if (this.phase === 'won') this.drawWin();
    // The menu sits over everything, including the wheel and the title card -
    // and the cursor over that, or it would be pointing at the game from
    // behind the card it is supposed to be picking things out of.
    if (this.phase !== 'won') {
      this.menu.padFocus = this.padPicking;
      this.menu.hover(this.device === 'desk' ? this.pointerWorld() : null);
      this.menu.draw(this.sk, this.view, this.inputReport(), this.time);
    }
    // The cursor is not drawn here: it goes on the glass every frame, over the
    // blit of whichever drawing is currently up.
  }

  /**
   * The HUD is drawn in world units like everything else, so pulling the
   * camera in made all of it a third bigger on the glass. It is furniture,
   * not scene: it goes back to the size it was, which is this much smaller in
   * the units the scene is now measured in.
   */
  private readonly hudK = 0.77;

  private drawHud(): void {
    const sk = this.sk;
    const c = this.ctx;
    const { w, h } = this.view;
    const k = this.hudK;
    const frac = this.terrain.destroyed;
    const barW = clamp(w * 0.42, 240, 470) * k;
    const topY = 30 + this.topInset;
    // Before the first blow the strip is empty and the cue has the screen; the
    // meter drops in behind the first hit, which is the moment it means
    // anything. It arrives from above so it reads as the HUD assembling.
    if (this.meterIn > 0.001) {
      const k = easeOutBack(this.meterIn);
      c.save();
      c.globalAlpha = clamp(this.meterIn * 1.6, 0, 1);
      c.translate(0, (1 - k) * -46);
      drawProgress(sk, w / 2, topY, barW, frac, `WALL DESTROYED  ${(frac * 100).toFixed(1)}%`);
      c.restore();
    }
    if (this.cueOut < 1) this.drawCue();

    // Current weapon. On touch the bottom edge belongs to the thumbs, so the
    // readout moves up under the meter instead.
    const w2 = this.weapon;
    const compact = this.isTouch;
    const left = 44 * k + this.safe.left;
    const baseY = compact ? topY + 58 * k : h - 62 * k - this.safe.bottom;
    // The bottom strip of the screen is the floor slab, which is solid black.
    // Anything printed down there has to be knocked out in white to be read.
    const ink = baseY > this.terrain.groundTop ? '#fff' : '#000';
    c.save();
    const nameSize = clamp(w * 0.02, 15, 24) * k;
    inkText(sk, slotKey(this.equipped), left, baseY + 8, nameSize * 1.65, { align: 'center', alpha: 0.85, color: ink });
    inkText(sk, w2.name, left + nameSize * 1.35, baseY, nameSize, { align: 'left', color: ink });
    // Which half of the arsenal this came out of, set small after the name.
    inkText(sk, w2.group === 'extra' ? 'EXTRA' : 'MAIN',
      left + nameSize * 1.35 + measureText(sk, w2.name, nameSize) + 12, baseY + 1,
      nameSize * 0.5, { align: 'left', alpha: 0.4, color: ink });
    if (!compact) inkText(sk, w2.tagline.toUpperCase(), left + 34 * k, baseY + 24 * k, 13 * k, { align: 'left', alpha: 0.55, color: ink });

    const barX = left + nameSize * 1.35;
    const barY = baseY + (compact ? nameSize * 0.85 : 38 * k);
    const cdW = clamp(w * 0.16, 110, 180) * k;
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
    if (w2.charge > 0.02) inkText(sk, 'CHARGING', barX + cdW + 44 * k, barY + 4, 12 * k, { alpha: 0.7, color: ink });

    // The running melee chain, so the player can see the combo they are on.
    const combo = w2.comboLabel;
    if (combo) {
      inkText(sk, combo, barX + cdW + 16 * k, barY + 5, clamp(w * 0.017, 12, 17) * k,
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
      if (this.isTouch || this.device === 'pad') {
        const lines = this.device === 'pad'
          ? [
              'LEFT STICK  MOVE  ·  UP JUMPS  ·  DOWN CROUCHES',
              'SHOVE THE RIGHT STICK TO SWING THAT WAY  ·  LET GO TO RELEASE A CHARGE',
              'R1 / R2 / X  SWING AHEAD  ·  HOLD L1 AND POINT TO EQUIP  ·  START  SETTINGS',
            ]
          : [
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
          'SPACE  JUMP  (again in mid-air to flip, at a wall to kick off it)',
          'MOUSE  AIM     CLICK  ATTACK     HOLD  HEAVY COMBO',
          'HOLD TAB  WEAPON WHEEL     TOP ROW OF KEYS  QUICK SWAP',
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
        // Pinned under the HUD strip: the last pieces are often the top ones,
        // and its caption was the thing that ended up under the browser bar.
        inkText(sk, 'LAST PIECES', (b.x0 + b.x1) / 2,
          Math.max(b.y0 - 28, this.topInset + 14), 15, { alpha: pulse });
      }
    }
  }

  /**
   * "DESTROY THE WALL", written on the paper with an arrow swept over to the
   * masonry - the only instruction the game gives, and only until it has been
   * followed once.
   *
   * It lives in the open ground to the left of the wall rather than across the
   * middle of the screen, because the middle of the screen on a narrow phone
   * *is* the wall, and black ink on a black slab says nothing.
   */
  private drawCue(): void {
    const t = this.terrain;
    const { w } = this.view;
    // Everything is measured off the wall, never off the screen. The note is
    // written on the paper immediately beside the face it is pointing at, so
    // the arrow only ever has to be a short hook - a banner in the middle of
    // an ultrawide with a yard of arrow reaching across it says less, not
    // more. The open ground is only consulted to stop the words running off
    // the left edge of a narrow phone.
    const open = Math.max(160, t.wallX);
    const size = fitCueSize(open * 0.62, clamp(w * 0.028, 15, 38) * this.hudK);
    const half = cueWidth(size) / 2;
    const x = Math.max(half + size * 0.7, t.wallX - size * 1.4 - half);
    const band = t.groundTop - t.wallTop;
    // The point lands on the wall's face, in its upper third - head height for
    // a figure standing at the foot of it, and well clear of the HUD strip.
    const target = { x: t.wallX - size * 0.62, y: t.wallTop + band * 0.34 };
    const y = Math.max(this.hudBand + size * 1.1, target.y - size * 2.3);
    drawStartCue(this.sk, this.phaseTime, this.cueOut, { x, y, size, target });
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
    inkText(sk, 'ONE STICK FIGURE, FOURTEEN POWERS, ONE VERY DOOMED WALL', w / 2, h * 0.4 + 26,
      clamp(w * 0.019, 12, 17), { alpha: clamp((t - 0.5) / 0.5, 0, 1) * 0.55, wobble: 0.5 });

    const press = this.input.pointer;
    const ptr = this.toWorld(press.x, press.y);
    const hovered = this.device === 'desk' && hitRect(this.startBtn, ptr);
    c.save();
    c.globalAlpha = clamp((t - 0.6) / 0.4, 0, 1);
    inkButton(sk, this.startBtn, 'START PWNAGE', hovered, clamp(w * 0.032, 22, 34));

    // The install offer, only where it can lead anywhere.
    const offer = installer.offer;
    if (offer) {
      const b = this.installBtn;
      inkButton(sk, b, offer === 'ios' ? 'ADD TO HOME SCREEN' : 'INSTALL APP',
        this.device === 'desk' && hitRect(b, ptr),
        Math.min(clamp(w * 0.019, 13, 20), b.w / 11));
    }
    if (this.padPicking && !this.howToInstall) {
      focusRing(sk, this.titleFocus === 1 && offer ? this.installBtn : this.startBtn, this.time);
    }
    c.restore();
    if (this.howToInstall) this.drawInstallCard();

    const cf = clamp((t - 0.9) / 0.6, 0, 1);
    const rows: Array<[string, string]> = this.device === 'pad'
      ? [
          ['LEFT STICK', 'move — up jumps, down crouches'],
          ['JUMP AT A WALL', 'kick off it — chain them to climb'],
          ['RIGHT STICK', 'shove it to swing that way — let go to fire a charge'],
          ['R1 / R2 / X', 'swing where he looks; the left stick steers it too'],
          ['HOLD L1', 'weapon fan — point at one and let go'],
          ['START', 'settings'],
          ['GOAL', 'wipe the black wall off the screen'],
        ]
      : this.isTouch
      ? [
          ['LEFT THUMB', 'tilt to walk, push it out to sprint'],
          ['UP / DOWN', 'jump and crouch, on the same thumb'],
          ['JUMP AT A WALL', 'kick off it — chain them to climb'],
          ['RIGHT THUMB', 'press to attack — guns aim where you touch'],
          ['PAD AT THE BOTTOM', 'hold, slide to a weapon, lift to equip'],
          ['GOAL', 'wipe the black wall off the screen'],
        ]
      : [
          ['WASD / ARROWS', 'run and crouch'],
          ['SHIFT', 'sprint — attacking from a run is its own move'],
          ['SPACE', 'jump — again in the air to somersault'],
          ['SPACE AT A WALL', 'kick off it — chain them to climb'],
          ['MOUSE', 'aim   ·   CLICK to attack, keep going for combos'],
          ['HOLD TAB', 'weapon wheel   ·   the top row of keys quick-swaps'],
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
    const deskHere = this.device === 'desk';
    inkButton(sk, this.restartBtn, 'AGAIN', deskHere && hitRect(this.restartBtn, ptr), btnSize);
    inkButton(sk, this.menuBtn, 'MAIN MENU', deskHere && hitRect(this.menuBtn, ptr), btnSize);
    if (this.padPicking) focusRing(sk, this.winFocus === 0 ? this.restartBtn : this.menuBtn, this.time);
    if (!this.isTouch) {
      const keys = this.padPicking ? 'D-PAD  CHOOSE        A  TAKE IT' : 'R  RESTART        ESC  MENU';
      inkText(sk, keys, w / 2, this.restartBtn.y + this.restartBtn.h + 30, 13, { alpha: 0.45 });
    }
    c.restore();
  }

  /**
   * What to do on iOS, where there is no install prompt to fire and never will
   * be - only Share, then Add to Home Screen, which nobody finds by accident.
   * The wording follows the browser in hand: the share button is in the bottom
   * bar in Safari and up beside the address in every other one.
   */
  private drawInstallCard(): void {
    const sk = this.sk;
    const c = this.ctx;
    const { w, h } = this.view;
    const cw = Math.min(w - 40, 620);
    const size = clamp(cw * 0.036, 14, 24);
    const lines = installer.iosSteps;
    // Chrome, Firefox and Edge on iOS only grew an Add to Home Screen of their
    // own in 16.4. On anything older the item simply is not in their share
    // sheet, and the player would hunt for it forever without being told.
    const note = installer.iosNeedsSafariNote
      ? 'NEEDS IOS 16.4+; OTHERWISE USE SAFARI'
      : null;
    const ch = size * 3.1 + lines.length * size * 1.7 + (note ? size * 1.6 : 0);
    const x = (w - cw) / 2;
    // Sat in the open space above the buttons rather than over them: the card
    // is an aside, and covering the front door with it would read as a block.
    const y = clamp(h * 0.42 - ch / 2, this.hudBand + 10, Math.max(this.hudBand + 10, h - ch - 20));

    c.save();
    c.globalAlpha = 0.72;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 1;
    const box: Vec2[] = [
      { x, y }, { x: x + cw, y }, { x: x + cw, y: y + ch }, { x, y: y + ch },
    ];
    c.fillStyle = '#fff';
    sk.polyPath(box, 1.6);
    c.fill();
    c.strokeStyle = '#000';
    c.lineWidth = 3.4;
    sk.polyPath(box, 1.6);
    c.stroke();

    inkText(sk, 'INSTALLING ON IOS', x + cw / 2, y + size * 1.4, size * 1.15, { alpha: 0.92 });
    lines.forEach((l, i) => {
      const ly = y + size * 2.8 + i * size * 1.7;
      inkText(sk, String(i + 1), x + size * 1.6, ly, size * 0.95, { alpha: 0.55 });
      inkText(sk, l, x + size * 2.8, ly, size * 0.86, { align: 'left', alpha: 0.85, wobble: 0.4 });
    });
    if (note) {
      inkText(sk, note, x + cw / 2, y + ch - size * 2.1, size * 0.7,
        { alpha: 0.5, wobble: 0.4 });
    }
    inkText(sk, 'TAP ANYWHERE TO CLOSE', x + cw / 2, y + ch - size * 0.7, size * 0.7,
      { alpha: 0.4, wobble: 0.35 });
    c.restore();
  }

  /**
   * A drawn crosshair, since the CSS cursor is hidden over the canvas.
   *
   * It is painted as a difference against whatever is under it rather than in
   * ink, so it comes out white over the wall and black over the paper, pixel by
   * pixel - a black crosshair simply vanished the moment it reached the wall,
   * which is exactly where it is needed. Over the settings card it drops the
   * ring and shortens to a plain pointer: aiming is not what it is doing there.
   */
  private drawCursor(): void {
    const p = this.pointerWorld();
    const c = this.ctx;
    const sk = this.sk;
    const picking = this.menu.open;
    c.save();
    // White through `difference` inverts what is behind it; grey lands as its
    // own complement, which still reads against the grey it came from.
    c.globalCompositeOperation = 'difference';
    c.strokeStyle = '#fff';
    c.lineWidth = picking ? 2.8 : 2.4;
    const r = picking ? 7 : this.phase === 'playing' ? 13 : 9;
    if (!picking) {
      const spin = this.time * 0.6;
      const pts: Vec2[] = [];
      for (let i = 0; i < 7; i++) {
        const a = spin + (i / 7) * TAU;
        pts.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
      }
      sk.polyPath(pts, 1);
      c.stroke();
    }
    const gap = picking ? 2 : r + 4;
    const len = picking ? r + 6 : r + 11;
    for (const d of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      c.beginPath();
      c.moveTo(p.x + Math.cos(d) * gap, p.y + Math.sin(d) * gap);
      c.lineTo(p.x + Math.cos(d) * len, p.y + Math.sin(d) * len);
      c.stroke();
    }
    c.restore();
  }
}
