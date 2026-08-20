import { audio, type SfxName } from '../core/audio';
import { Input } from '../core/input';
import { clamp, damp, easeOutBack, easeOutCubic, hashNoise, rand, TAU, vec, type Vec2 } from '../core/math';
import { Sketch } from '../core/sketch';
import {
  drawProgress, hitRect, inkButton, inkText, measureText, WeaponWheel, type Rect,
} from '../ui/ui';
import { Particles } from './particles';
import { applyBlast, Projectile } from './projectiles';
import { Stickman } from './stickman';
import { GROUND_Y, Terrain, WORLD_H, WORLD_W } from './terrain';
import { createArsenal, type Weapon, type WeaponCtx } from './weapons';

type Phase = 'menu' | 'playing' | 'won';

/** The wall is never quite 100% clean; sweep the last slivers instead. */
const WIN_THRESHOLD = 0.994;

const NUMBER_KEYS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
];

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sk: Sketch;
  private input: Input;

  private terrain = new Terrain();
  private sm = new Stickman();
  private particles = new Particles();
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

  private viewScale = 1;
  private cssW = WORLD_W;
  private cssH = WORLD_H;

  private startBtn: Rect = { x: WORLD_W / 2 - 170, y: 420, w: 340, h: 76 };
  private restartBtn: Rect = { x: WORLD_W / 2 - 250, y: 452, w: 230, h: 64 };
  private menuBtn: Rect = { x: WORLD_W / 2 + 20, y: 452, w: 230, h: 64 };

  private stats = { shots: 0, elapsed: 0 };

  /** Read-only peeks, used by the dev console and the automated smoke tests. */
  get player(): Stickman { return this.sm; }
  get destroyedPct(): number { return this.terrain.destroyed; }
  get currentPhase(): string { return this.phase; }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const c = canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('2D canvas is not available in this browser');
    this.ctx = c;
    this.sk = new Sketch(c);
    this.input = new Input(canvas);
    this.resetWorld();
    this.fit();
    window.addEventListener('resize', () => this.fit());
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

  private fit(): void {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const scale = Math.min(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
    this.cssW = Math.floor(WORLD_W * scale);
    this.cssH = Math.floor(WORLD_H * scale);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.viewScale = this.canvas.width / WORLD_W;
  }

  private pointerWorld(): Vec2 {
    return {
      x: clamp((this.input.pointer.x / this.cssW) * WORLD_W, 0, WORLD_W),
      y: clamp((this.input.pointer.y / this.cssH) * WORLD_H, 0, WORLD_H),
    };
  }

  // ---------------------------------------------------------------- world ---

  private resetWorld(): void {
    this.terrain = new Terrain();
    this.particles.clear();
    this.projectiles.length = 0;
    this.weapons = createArsenal();
    this.equipped = 0;
    this.wheel.hovered = 0;
    this.sm.reset(230, GROUND_Y - 40);
    this.shakeAmt = 0;
    this.flashAmt = 0;
    this.invertT = 0;
    this.hintFade = 1;
    this.stats = { shots: 0, elapsed: 0 };
  }

  private get weapon(): Weapon { return this.weapons[this.equipped]; }

  private makeCtx(dt: number): WeaponCtx {
    return {
      sm: this.sm,
      terrain: this.terrain,
      particles: this.particles,
      projectiles: this.projectiles,
      aimPoint: this.pointerWorld(),
      dt,
      time: this.time,
      shake: (a) => this.shake(a),
      flash: (a) => { this.flashAmt = Math.min(1, this.flashAmt + a); },
      invert: (s) => { this.invertT = Math.max(this.invertT, s); },
      sfx: (n: SfxName, p?: number) => audio.play(n, p),
    };
  }

  private shake(a: number): void {
    this.shakeAmt = Math.min(46, this.shakeAmt + a);
  }

  // ----------------------------------------------------------------- loop ---

  private step(rawDt: number): void {
    this.time += rawDt;
    this.phaseTime += rawDt;
    this.sk.update(this.time);

    switch (this.phase) {
      case 'menu': this.updateMenu(rawDt); break;
      case 'playing': this.updatePlaying(rawDt); break;
      case 'won': this.updateWon(rawDt); break;
    }

    this.render(rawDt);
    this.input.endFrame();
  }

  // ----------------------------------------------------------------- menu ---

  private updateMenu(dt: number): void {
    // The world keeps breathing behind the title card.
    const aim = { x: this.sm.pos.x + 200, y: this.sm.pos.y - 90 };
    this.sm.update(dt, this.terrain, {
      left: false, right: false, up: false, down: false, jump: false, jumpHeld: false,
    }, aim);
    this.particles.update(dt, this.terrain);
    this.decayEffects(dt);

    const p = this.pointerWorld();
    const hovering = hitRect(this.startBtn, p);
    if (this.input.mousePressed && hovering) void this.beginRun();
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
    const inp = this.input;

    // --- weapon wheel, which also slows the action right down --------------
    const wheelOpen = inp.down('Tab');
    let numberKey: number | null = null;
    for (let i = 0; i < NUMBER_KEYS.length; i++) {
      if (inp.justPressed(NUMBER_KEYS[i])) numberKey = i;
    }
    const wasOpen = this.wheel.open > 0.01;
    const changed = this.wheel.update(
      rawDt, wheelOpen, this.pointerWorld(), { x: WORLD_W / 2, y: WORLD_H / 2 },
      this.weapons.length, numberKey,
    );
    if (changed) audio.play('wheel', 0.9 + this.wheel.hovered * 0.05);
    if (wheelOpen && !wasOpen) audio.play('wheel', 0.7);
    if (!wheelOpen && wasOpen) this.equip(this.wheel.hovered);

    // Numbers and the scroll wheel work without opening the wheel at all.
    if (!wheelOpen) {
      if (numberKey !== null && numberKey < this.weapons.length) this.equip(numberKey);
      if (inp.wheelDelta !== 0) {
        const n = this.weapons.length;
        this.equip((this.equipped + inp.wheelDelta + n) % n);
      }
    }

    this.timeScale = damp(this.timeScale, wheelOpen ? 0.16 : 1, 14, rawDt);
    const dt = rawDt * this.timeScale;
    this.stats.elapsed += rawDt;
    if (this.hintFade > 0 && this.phaseTime > 9) this.hintFade = Math.max(0, this.hintFade - rawDt * 0.5);

    // --- character ---------------------------------------------------------
    const aim = this.pointerWorld();
    this.sm.update(dt, this.terrain, {
      left: inp.anyDown('KeyA', 'ArrowLeft'),
      right: inp.anyDown('KeyD', 'ArrowRight'),
      up: inp.anyDown('KeyW', 'ArrowUp'),
      down: inp.anyDown('KeyS', 'ArrowDown'),
      jump: inp.justPressed('Space'),
      jumpHeld: inp.down('Space'),
    }, aim);
    if (this.sm.justJumped) audio.play('jump', rand(0.9, 1.15));
    if (this.sm.justLanded) audio.play('land', rand(0.9, 1.1));

    // --- weapon ------------------------------------------------------------
    const wctx = this.makeCtx(dt);
    const firing = !wheelOpen && inp.mouseDown;
    const pressed = !wheelOpen && inp.mousePressed;
    if (pressed) this.stats.shots++;
    this.weapon.update(wctx, firing, pressed);
    this.sm.setHands(this.weapon.hands(wctx));

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
      this.particles.shockwave(1080, 300, 320);
      audio.play('win');
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
    this.weapon.onUnequip(this.makeCtx(0));
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
    this.sm.update(dt, this.terrain, {
      left: false, right: false, up: false, down: false, jump: false, jumpHeld: false,
    }, { x: this.sm.pos.x + 300, y: this.sm.pos.y - 120 });
    this.sm.setHands(null);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt, this.terrain);
      if (p.dead) { if (p.hitAt) this.detonate(p, p.hitAt); this.projectiles.splice(i, 1); }
    }
    this.particles.update(dt, this.terrain);
    this.decayEffects(dt);

    if (this.phaseTime > 0.7) {
      const p = this.pointerWorld();
      if (this.input.mousePressed) {
        if (hitRect(this.restartBtn, p)) { audio.play('ui'); this.phase = 'playing'; this.phaseTime = 0; this.resetWorld(); }
        else if (hitRect(this.menuBtn, p)) { audio.play('ui'); audio.stopMusic(); this.phase = 'menu'; this.phaseTime = 0; this.resetWorld(); }
      }
      if (this.input.justPressed('KeyR')) { audio.play('ui'); this.phase = 'playing'; this.phaseTime = 0; this.resetWorld(); }
      if (this.input.justPressed('Escape')) { audio.stopMusic(); this.phase = 'menu'; this.phaseTime = 0; this.resetWorld(); }
    }
  }

  // --------------------------------------------------------------- render ---

  private render(dt: number): void {
    const c = this.ctx;
    c.setTransform(this.viewScale, 0, 0, this.viewScale, 0, 0);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, WORLD_W, WORLD_H);

    c.save();
    c.translate(this.shakeOff.x, this.shakeOff.y);

    this.terrain.draw(c);
    this.particles.draw(this.sk);

    const wctx = this.makeCtx(dt);
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
      c.fillRect(0, 0, WORLD_W, WORLD_H);
      c.restore();
    }

    if (this.phase === 'playing') this.drawHud();
    this.wheel.draw(this.sk, { x: WORLD_W / 2, y: WORLD_H / 2 }, this.weapons, this.equipped);
    if (this.phase === 'menu') this.drawMenu();
    if (this.phase === 'won') this.drawWin();
    if (this.phase !== 'menu' || true) this.drawCursor();
  }

  private drawHud(): void {
    const sk = this.sk;
    const c = this.ctx;
    const frac = this.terrain.destroyed;
    drawProgress(sk, WORLD_W / 2, 34, 460, frac, `WALL DESTROYED  ${(frac * 100).toFixed(1)}%`);

    // Current weapon, bottom left, with a cooldown or charge readout.
    const w = this.weapon;
    c.save();
    inkText(sk, `${(w.id) % 10}`, 44, WORLD_H - 62, 44, { align: 'center', alpha: 0.85 });
    inkText(sk, w.name, 76, WORLD_H - 70, 26, { align: 'left' });
    inkText(sk, w.tagline.toUpperCase(), 78, WORLD_H - 46, 13, { align: 'left', alpha: 0.55 });

    const barX = 78, barY = WORLD_H - 32, barW = 190;
    const meter = w.charge > 0 ? w.charge : 1 - w.cooldownFrac;
    c.strokeStyle = '#000';
    c.lineWidth = 2;
    sk.polyPath([
      { x: barX, y: barY }, { x: barX + barW, y: barY },
      { x: barX + barW, y: barY + 8 }, { x: barX, y: barY + 8 },
    ], 0.8);
    c.stroke();
    c.fillStyle = '#000';
    c.fillRect(barX + 2, barY + 2, Math.max(0, (barW - 4) * clamp(meter, 0, 1)), 4);
    if (w.charge > 0.02) inkText(sk, 'CHARGING', barX + barW + 46, barY + 4, 13, { alpha: 0.7 });
    c.restore();

    // Controls, fading out once the player has clearly got the idea.
    if (this.hintFade > 0.01) {
      c.save();
      c.globalAlpha = this.hintFade;
      const lines = [
        'WASD / ARROWS  MOVE',
        'SPACE  JUMP  (again in mid-air to flip)',
        'MOUSE  AIM     CLICK  ATTACK',
        'HOLD TAB  WEAPON WHEEL     1-0  QUICK SWAP',
      ];
      lines.forEach((l, i) => inkText(sk, l, WORLD_W - 24, WORLD_H - 96 + i * 22, 14, { align: 'right', alpha: 0.6 }));
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
    const t = this.phaseTime;

    c.save();
    c.globalAlpha = 0.86;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, WORLD_W, WORLD_H);
    c.restore();

    const pop = easeOutBack(clamp(t / 0.7, 0, 1));
    c.save();
    c.translate(WORLD_W / 2, 176);
    c.scale(pop, pop);
    inkText(sk, 'STICK FIGURE', 0, -46, 76, { wobble: 1.4 });
    inkText(sk, 'PWNAGE', 0, 34, 108, { wobble: 1.6 });
    c.restore();

    // Speed lines flanking the title, straight out of the source material.
    const lineFade = clamp((t - 0.35) / 0.5, 0, 1);
    c.save();
    c.globalAlpha = lineFade * 0.8;
    c.strokeStyle = '#000';
    const titleW = Math.max(360, measureText(sk, 'PWNAGE', 108) / 2 + 40);
    for (const side of [-1, 1]) {
      sk.burst(WORLD_W / 2 + side * titleW, 190, 7, 20, 190, 3, 1.1, side > 0 ? 0 : Math.PI, 40 + side);
    }
    c.restore();

    inkText(sk, 'A PLAYABLE TRIBUTE  ·  ONE STICK FIGURE, TEN WEAPONS, ONE VERY DOOMED WALL',
      WORLD_W / 2, 300, 17, { alpha: clamp((t - 0.5) / 0.5, 0, 1) * 0.72, wobble: 0.6 });

    const p = this.pointerWorld();
    const hovered = hitRect(this.startBtn, p);
    c.save();
    c.globalAlpha = clamp((t - 0.6) / 0.4, 0, 1);
    inkButton(sk, this.startBtn, 'START PWNAGE', hovered, 34);
    c.restore();

    const cf = clamp((t - 0.9) / 0.6, 0, 1);
    const rows = [
      ['WASD / ARROWS', 'run and crouch'],
      ['SPACE', 'jump — press again in the air to somersault'],
      ['MOUSE', 'aim   ·   CLICK to attack'],
      ['HOLD TAB', 'weapon wheel   ·   1-0 to quick swap'],
      ['GOAL', 'wipe the black wall off the screen'],
    ];
    rows.forEach((r, i) => {
      const y = 546 + i * 26;
      inkText(sk, r[0], WORLD_W / 2 - 16, y, 16, { align: 'right', alpha: cf * 0.9 });
      inkText(sk, r[1].toUpperCase(), WORLD_W / 2 + 16, y, 15, { align: 'left', alpha: cf * 0.55 });
    });
    inkText(sk, 'SOUND: ORIGINAL POP-ROCK, SYNTHESISED LIVE IN YOUR BROWSER',
      WORLD_W / 2, WORLD_H - 18, 12, { alpha: cf * 0.4 });
  }

  private drawWin(): void {
    const sk = this.sk;
    const c = this.ctx;
    const t = this.phaseTime;

    c.save();
    c.globalAlpha = clamp(t / 0.5, 0, 1) * 0.82;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, WORLD_W, WORLD_H);
    c.restore();

    // Radiating impact lines behind the banner.
    c.save();
    c.globalAlpha = clamp(t / 0.4, 0, 1);
    c.strokeStyle = '#000';
    const n = 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this.time * 0.25;
      const r0 = 210 + Math.sin(this.time * 4 + i) * 12;
      const r1 = r0 + 120 + hashNoise(i, 3) * 90;
      c.lineWidth = 2 + (i % 3);
      c.beginPath();
      c.moveTo(WORLD_W / 2 + Math.cos(a) * r0, 300 + Math.sin(a) * r0 * 0.62);
      c.lineTo(WORLD_W / 2 + Math.cos(a) * r1, 300 + Math.sin(a) * r1 * 0.62);
      c.stroke();
    }
    c.restore();

    const pop = easeOutBack(clamp(t / 0.55, 0, 1));
    const wob = 1 + Math.sin(this.time * 6) * 0.014;
    c.save();
    c.translate(WORLD_W / 2, 300);
    c.scale(pop * wob, pop * wob);
    c.rotate(Math.sin(this.time * 2.2) * 0.012);
    inkText(sk, 'YOU PWNED', 0, 0, 138, { wobble: 2.2 });
    c.restore();

    const sub = clamp((t - 0.5) / 0.5, 0, 1);
    inkText(sk, `WALL ERASED IN ${this.stats.elapsed.toFixed(1)}S  ·  ${this.stats.shots} ATTACKS`,
      WORLD_W / 2, 392, 19, { alpha: sub * 0.75 });

    const p = this.pointerWorld();
    c.save();
    c.globalAlpha = clamp((t - 0.7) / 0.4, 0, 1);
    inkButton(sk, this.restartBtn, 'AGAIN', hitRect(this.restartBtn, p), 28);
    inkButton(sk, this.menuBtn, 'MAIN MENU', hitRect(this.menuBtn, p), 28);
    inkText(sk, 'R  RESTART        ESC  MENU', WORLD_W / 2, 552, 13, { alpha: 0.45 });
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
    void easeOutCubic;
  }
}
