/**
 * Everything you hear is synthesised at runtime with the Web Audio API - there
 * are no audio files in this project. The soundtrack is an original upbeat
 * pop-rock loop (drums, distorted power chords, driving bass, lead hook) built
 * from a generic four chord vamp, and every weapon sound is shaped noise.
 */

const A4 = 440;
/** Semitone offset from A4 -> frequency. */
const hz = (semi: number): number => A4 * Math.pow(2, semi / 12);

// Scale degrees are written as semitone offsets from A4 so the whole track can
// be transposed by touching a single constant.
const N = {
  A2: hz(-24), B2: hz(-22), C3: hz(-21), D3: hz(-19), E3: hz(-17), F3: hz(-16), G3: hz(-14),
  A3: hz(-12), C4: hz(-9), D4: hz(-7), E4: hz(-5), F4: hz(-4), G4: hz(-2),
  A4: hz(0), B4: hz(2), C5: hz(3), D5: hz(5), E5: hz(7), G5: hz(10), A5: hz(12),
};

/** vi - IV - I - V in C major: the workhorse of upbeat pop-rock. */
const PROGRESSION = [
  { root: N.A2, third: N.C3, fifth: N.E3, lead: [N.A4, N.C5, N.E5, N.C5] },
  { root: N.F3, third: N.A3, fifth: N.C4, lead: [N.C5, N.A4, N.F4, N.A4] },
  { root: N.C3, third: N.E3, fifth: N.G3, lead: [N.E5, N.G5, N.E5, N.C5] },
  { root: N.G3, third: N.B2, fifth: N.D4, lead: [N.D5, N.B4, N.G4, N.B4] },
];

const BPM = 152;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private distortion!: WaveShaperNode;

  private nextNoteTime = 0;
  private step = 0;          // 16th note counter
  private timer: number | null = null;
  private playing = false;

  musicVolume = 0.5;
  sfxVolume = 0.75;
  muted = false;

  /** Must be called from a user gesture (the START PWNAGE button). */
  async init(): Promise<void> {
    if (this.ctx) { await this.ctx.resume(); return; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    // A limiter keeps stacked explosions from clipping into crackle.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(this.master);

    // Two seconds of white noise, reused for drums, gunfire and explosions.
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    this.distortion = ctx.createWaveShaper();
    this.distortion.curve = makeDistortionCurve(58);
    this.distortion.oversample = '4x';

    await ctx.resume();
  }

  private get t(): number { return this.ctx ? this.ctx.currentTime : 0; }

  // ---------------------------------------------------------------- music ---

  startMusic(): void {
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextNoteTime = this.t + 0.12;
    this.musicBus.gain.cancelScheduledValues(this.t);
    this.musicBus.gain.setValueAtTime(0.0001, this.t);
    this.musicBus.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.musicVolume), this.t + 1.2);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  stopMusic(fade = 0.6): void {
    if (!this.ctx || !this.playing) return;
    this.playing = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.musicBus.gain.cancelScheduledValues(this.t);
    this.musicBus.gain.setValueAtTime(Math.max(0.0001, this.musicBus.gain.value), this.t);
    this.musicBus.gain.exponentialRampToValueAtTime(0.0001, this.t + fade);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.t, 0.05);
  }

  /** Classic lookahead scheduler: queue every 16th note that falls in the window. */
  private tick(): void {
    if (!this.ctx || !this.playing) return;
    const SIXTEENTH = BEAT / 4;
    while (this.nextNoteTime < this.t + 0.15) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += SIXTEENTH;
      this.step++;
    }
  }

  private scheduleStep(step: number, when: number): void {
    const inBar = step % 16;
    const bar = Math.floor(step / 16);
    const chord = PROGRESSION[bar % 4];
    // 8 bar phrases: the first is a stripped back verse, then the chorus opens
    // up with the lead hook and busier drums. Keeps a 3 minute session alive.
    const phrase = Math.floor(bar / 4) % 2;
    const chorus = phrase === 1;

    // --- drums -------------------------------------------------------------
    if (inBar === 0 || inBar === 6 || inBar === 10) this.kick(when);
    if (chorus && inBar === 14) this.kick(when, 0.7);
    if (inBar === 4 || inBar === 12) this.snare(when);
    if (chorus && inBar === 15 && bar % 4 === 3) this.snare(when, 0.55);
    if (inBar % 2 === 0) this.hat(when, inBar % 4 === 0 ? 0.32 : 0.2);
    else if (chorus) this.hat(when, 0.12);
    // A crash lands on every phrase change.
    if (inBar === 0 && bar % 4 === 0) this.crash(when, chorus ? 0.35 : 0.22);

    // --- bass: straight eighths with an octave lift on the & of 4 ----------
    if (inBar % 2 === 0) {
      const oct = inBar === 14 ? 2 : 1;
      this.bass(chord.root * oct, when, BEAT / 2 * 0.9);
    }

    // --- rhythm guitar: chugging power chords ------------------------------
    if (inBar % 4 === 0 || inBar === 6 || inBar === 10 || inBar === 14) {
      const dur = inBar % 4 === 0 ? BEAT * 0.85 : BEAT * 0.4;
      this.powerChord(chord.root * 2, when, dur, chorus ? 0.2 : 0.13);
    }

    // --- lead hook: chorus only, so the drop has somewhere to go -----------
    if (chorus && inBar % 4 === 0) {
      const note = chord.lead[(inBar / 4) | 0];
      this.lead(note, when, BEAT * 0.75);
      if (inBar === 8) this.lead(note * 1.5, when + BEAT * 0.5, BEAT * 0.3, 0.06);
    }
    // Pad glue underneath, quiet.
    if (inBar === 0) this.pad(chord.third * 2, chord.fifth * 2, when, BAR);
  }

  private env(node: AudioNode, when: number, peak: number, attack: number, decay: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    node.connect(g);
    return g;
  }

  private kick(when: number, gain = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.11);
    this.env(o, when, 0.85 * gain, 0.002, 0.24).connect(this.musicBus);
    o.start(when); o.stop(when + 0.3);
    // Click transient for punch through the guitars.
    const c = ctx.createBufferSource();
    c.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'lowpass'; hp.frequency.value = 900;
    c.connect(hp);
    this.env(hp, when, 0.12 * gain, 0.001, 0.02).connect(this.musicBus);
    c.start(when); c.stop(when + 0.05);
  }

  private snare(when: number, gain = 1): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = 1.2;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    n.connect(bp);
    this.env(bp, when, 0.34 * gain, 0.001, 0.17).connect(this.musicBus);
    n.start(when); n.stop(when + 0.22);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(210, when);
    body.frequency.exponentialRampToValueAtTime(140, when + 0.09);
    this.env(body, when, 0.16 * gain, 0.001, 0.1).connect(this.musicBus);
    body.start(when); body.stop(when + 0.14);
  }

  private hat(when: number, gain: number): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = 2.4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7200;
    n.connect(hp);
    this.env(hp, when, gain, 0.001, 0.045).connect(this.musicBus);
    n.start(when); n.stop(when + 0.07);
  }

  private crash(when: number, gain: number): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = 0.85;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4200;
    n.connect(hp);
    this.env(hp, when, gain, 0.002, 1.1).connect(this.musicBus);
    n.start(when); n.stop(when + 1.3);
  }

  private bass(freq: number, when: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500, when);
    lp.frequency.exponentialRampToValueAtTime(320, when + dur);
    lp.Q.value = 6;
    o.connect(lp);
    this.env(lp, when, 0.3, 0.006, dur).connect(this.musicBus);
    o.start(when); o.stop(when + dur + 0.1);
  }

  /** Root + fifth + octave through a waveshaper: a distorted guitar chug. */
  private powerChord(root: number, when: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const mix = ctx.createGain();
    mix.gain.value = 1;
    for (const [ratio, detune] of [[1, -7], [1, 7], [1.4983, 0], [2, 5]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = root * ratio;
      o.detune.value = detune;
      o.connect(mix);
      o.start(when); o.stop(when + dur + 0.08);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    mix.connect(this.distortion).connect(lp);
    this.env(lp, when, gain, 0.004, dur).connect(this.musicBus);
  }

  private lead(freq: number, when: number, dur: number, gain = 0.09): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq, when);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3400;
    o.connect(lp);
    const g = this.env(lp, when, gain, 0.008, dur);
    // A touch of slap delay makes the hook sit in a room instead of the void.
    const dly = ctx.createDelay(0.5);
    dly.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.25;
    g.connect(this.musicBus);
    g.connect(dly).connect(fb).connect(dly);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    dly.connect(wet).connect(this.musicBus);
    o.start(when); o.stop(when + dur + 0.1);
  }

  private pad(a: number, b: number, when: number, dur: number): void {
    const ctx = this.ctx!;
    const mix = ctx.createGain();
    for (const f of [a, b]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(mix);
      o.start(when); o.stop(when + dur + 0.2);
    }
    this.env(mix, when, 0.045, 0.25, dur).connect(this.musicBus);
  }

  // ------------------------------------------------------------------ sfx ---

  /** Shared helper: a filtered burst of the noise buffer. */
  private noiseHit(when: number, opts: {
    gain: number; attack: number; decay: number; type: BiquadFilterType;
    from: number; to: number; q?: number; rate?: number;
  }): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = opts.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.Q.value = opts.q ?? 1;
    f.frequency.setValueAtTime(opts.from, when);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.to), when + opts.attack + opts.decay);
    n.connect(f);
    this.env(f, when, opts.gain, opts.attack, opts.decay).connect(this.sfxBus);
    n.start(when); n.stop(when + opts.attack + opts.decay + 0.05);
  }

  private tone(when: number, type: OscillatorType, from: number, to: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, when);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + dur);
    this.env(o, when, gain, 0.004, dur).connect(this.sfxBus);
    o.start(when); o.stop(when + dur + 0.05);
  }

  /** One entry point so gameplay code never touches the synth graph directly. */
  play(name: SfxName, pitch = 1): void {
    if (!this.ctx || this.muted) return;
    const w = this.t + 0.001;
    switch (name) {
      case 'punch':
        this.noiseHit(w, { gain: 0.4, attack: 0.001, decay: 0.09, type: 'lowpass', from: 1400 * pitch, to: 180 });
        this.tone(w, 'sine', 190 * pitch, 60, 0.1, 0.28);
        break;
      case 'swing':
        this.noiseHit(w, { gain: 0.22, attack: 0.03, decay: 0.13, type: 'bandpass', from: 700 * pitch, to: 2600, q: 2.5 });
        break;
      case 'slash':
        this.noiseHit(w, { gain: 0.4, attack: 0.002, decay: 0.2, type: 'highpass', from: 2600 * pitch, to: 900 });
        this.tone(w, 'triangle', 1600 * pitch, 400, 0.16, 0.12);
        break;
      case 'stab':
        this.noiseHit(w, { gain: 0.3, attack: 0.001, decay: 0.07, type: 'bandpass', from: 3200 * pitch, to: 1400, q: 4 });
        break;
      case 'pistol':
        this.noiseHit(w, { gain: 0.55, attack: 0.001, decay: 0.13, type: 'lowpass', from: 5200 * pitch, to: 380 });
        this.tone(w, 'square', 320 * pitch, 70, 0.07, 0.16);
        break;
      case 'rifle':
        this.noiseHit(w, { gain: 0.4, attack: 0.001, decay: 0.085, type: 'lowpass', from: 6000 * pitch, to: 600 });
        this.tone(w, 'sawtooth', 260 * pitch, 90, 0.05, 0.12);
        break;
      case 'shotgun':
        this.noiseHit(w, { gain: 0.62, attack: 0.002, decay: 0.3, type: 'lowpass', from: 3200 * pitch, to: 160, rate: 0.7 });
        this.tone(w, 'sine', 160, 45, 0.22, 0.3);
        break;
      case 'cannon':
        this.noiseHit(w, { gain: 0.8, attack: 0.003, decay: 0.75, type: 'lowpass', from: 1800, to: 70, rate: 0.55 });
        this.tone(w, 'sine', 130, 30, 0.5, 0.5);
        this.tone(w + 0.02, 'sawtooth', 90, 28, 0.35, 0.2);
        break;
      case 'explosion':
        this.noiseHit(w, { gain: 0.75, attack: 0.004, decay: 0.9, type: 'lowpass', from: 2400, to: 60, rate: 0.5 });
        this.tone(w, 'sine', 110, 26, 0.6, 0.42);
        break;
      case 'launch':
        this.noiseHit(w, { gain: 0.35, attack: 0.01, decay: 0.35, type: 'highpass', from: 400, to: 2200 });
        break;
      case 'fire':
        this.noiseHit(w, { gain: 0.1, attack: 0.02, decay: 0.16, type: 'bandpass', from: 800 * pitch, to: 1800, q: 1.2 });
        break;
      case 'beam':
        this.noiseHit(w, { gain: 0.14, attack: 0.02, decay: 0.14, type: 'bandpass', from: 2200 * pitch, to: 3400, q: 6 });
        this.tone(w, 'sawtooth', 700 * pitch, 900 * pitch, 0.12, 0.05);
        break;
      case 'charge':
        this.tone(w, 'sawtooth', 180, 1500, 0.9, 0.14);
        break;
      case 'jump':
        this.tone(w, 'triangle', 420, 700, 0.1, 0.1);
        break;
      case 'land':
        this.noiseHit(w, { gain: 0.16, attack: 0.001, decay: 0.09, type: 'lowpass', from: 900, to: 140 });
        break;
      case 'ui':
        this.tone(w, 'square', 880, 880, 0.05, 0.09);
        break;
      case 'wheel':
        this.tone(w, 'square', 520 * pitch, 780 * pitch, 0.06, 0.07);
        break;
      case 'win':
        [0, 0.11, 0.22, 0.42].forEach((d, i) => {
          this.tone(w + d, 'square', hz([-9, -5, -2, 3][i]), hz([-9, -5, -2, 3][i]), 0.3, 0.16);
        });
        break;
    }
  }
}

export type SfxName =
  | 'punch' | 'swing' | 'slash' | 'stab' | 'pistol' | 'rifle' | 'shotgun'
  | 'cannon' | 'explosion' | 'launch' | 'fire' | 'beam' | 'charge'
  | 'jump' | 'land' | 'ui' | 'wheel' | 'win';

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

export const audio = new AudioEngine();
