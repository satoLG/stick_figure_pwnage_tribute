/**
 * Everything you hear is synthesised at runtime with the Web Audio API - there
 * are no audio files in this project.
 *
 * The band is built out of physical models rather than plain oscillators:
 *
 *  - guitars and bass are Karplus-Strong plucked strings (a burst of noise fed
 *    round a delay line that loses a little brightness on every lap, which is
 *    what a real string does), run through a distortion curve and a speaker
 *    cabinet filter;
 *  - the kit is a synthesised drum machine - pitch-swept sines for the kick and
 *    toms, noise plus tuned bodies for the snare, and a stack of detuned square
 *    waves through a highpass for the metal of the hats and cymbals;
 *  - a generated impulse response puts the whole kit in a room.
 *
 * The arrangement is a sixteen bar pop-rock loop over a vi-IV-I-V vamp.
 */

const A4 = 440;
/** Semitone offset from A4 -> frequency. */
const hz = (semi: number): number => A4 * Math.pow(2, semi / 12);

// Scale degrees are written as semitone offsets from A4 so the whole track can
// be transposed by touching a single constant.
const N = {
  A1: hz(-36), C2: hz(-33), F2: hz(-28), G2: hz(-26),
  A2: hz(-24), C3: hz(-21), E3: hz(-17), F3: hz(-16), G3: hz(-14),
  A3: hz(-12), B3: hz(-11), C4: hz(-9), D4: hz(-7), E4: hz(-5), F4: hz(-4), G4: hz(-2),
  A4: hz(0), B4: hz(2), C5: hz(3), D5: hz(5), E5: hz(7), F5: hz(8), G5: hz(10), A5: hz(12),
};

interface Chord {
  /** Bass root, an octave below the guitar. */
  bass: number;
  /** Guitar root; the power chord adds the fifth and the octave itself. */
  root: number;
  /** Four notes of the hook over this bar. */
  lead: readonly number[];
}

/** vi - IV - I - V in C major: the workhorse of upbeat pop-rock. */
const PROGRESSION: readonly Chord[] = [
  { bass: N.A1, root: N.A2, lead: [N.A4, N.C5, N.E5, N.C5] },
  { bass: N.F2, root: N.F3, lead: [N.C5, N.A4, N.F4, N.G4] },
  { bass: N.C2, root: N.C3, lead: [N.E5, N.G5, N.E5, N.C5] },
  { bass: N.G2, root: N.G3, lead: [N.D5, N.B4, N.G4, N.B4] },
];

/**
 * Four bar sections, played in order, sixteen bars round the loop. The strings
 * are one bar of sixteenth notes: `x` is a hit, `o` an accent, `.` a rest.
 */
interface Section {
  kick: string;
  snare: string;
  hat: string;
  /** Palm-muted sixteenth chugs (verse) or ringing open chords (chorus). */
  chug: boolean;
  lead: boolean;
  crash: boolean;
  /** How loud the whole band sits in this section. */
  drive: number;
}

const SECTIONS: readonly Section[] = [
  { kick: 'x..x..x...x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', chug: true, lead: false, crash: true, drive: 0.8 },
  { kick: 'x..x..x...x...x.', snare: '....x.......x..x', hat: 'x.x.x.x.x.x.xxxx', chug: true, lead: false, crash: false, drive: 0.9 },
  { kick: 'x..x..x...x..x..', snare: '....x.......x...', hat: 'oxxxoxxxoxxxoxxx', chug: false, lead: true, crash: true, drive: 1 },
  { kick: 'x..x..x...x..x..', snare: '....x...x...x..x', hat: 'oxxxoxxxoxxxox.x', chug: false, lead: true, crash: false, drive: 1 },
];

const BPM = 152;
const BEAT = 60 / BPM;
const SIXTEENTH = BEAT / 4;
/**
 * Headroom for the band. The whole mix has to leave room for a shotgun and two
 * explosions on top of it without the limiter clamping down on the music.
 */
const MUSIC_TRIM = 0.85;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  /** Everything that wants a room around it sends here. */
  private verb!: GainNode;
  private noiseBuffer!: AudioBuffer;
  /**
   * Complete, permanent instrument chains. Every note connects *into* one of
   * these and nothing is ever wired out of a shared node into a per-note one:
   * doing that fans the shared node out to every chain ever built, so the mix
   * piles up and the audio thread slowly strangles. That, plus a per-note delay
   * feedback loop - a cycle the browser can never collect - is why the music
   * used to stutter and then die a minute in.
   */
  private guitarOpen!: GainNode;
  private guitarMute!: GainNode;
  private bassIn!: GainNode;
  private leadIn!: GainNode;
  /** Shared slap-delay send, built once. */
  private slap!: GainNode;
  private hardCurve!: Float32Array<ArrayBuffer>;
  private softCurve!: Float32Array<ArrayBuffer>;
  /** Plucked string bodies, built once per note and reused. */
  private strings = new Map<string, AudioBuffer>();

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
    this.musicBus.gain.value = this.musicVolume * MUSIC_TRIM;
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

    this.hardCurve = makeDistortionCurve(58);
    // A gentler curve: enough to thicken a bass string without fuzzing it out.
    this.softCurve = makeDistortionCurve(6);

    // The room. A short exponentially decaying noise burst is a perfectly
    // convincing impulse response for a rehearsal space.
    const conv = ctx.createConvolver();
    conv.buffer = makeRoom(ctx, 1.35);
    this.verb = ctx.createGain();
    this.verb.gain.value = 0.9;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.verb.connect(conv).connect(wet).connect(this.master);

    this.buildInstruments();
    await ctx.resume();
  }

  /**
   * One amp and cabinet per instrument, wired up once and left alone. A note is
   * two nodes - the plucked string and its envelope - connected into the front
   * of the chain, so nothing accumulates however long the song runs.
   */
  private buildInstruments(): void {
    const ctx = this.ctx!;
    const amp = (drive: Float32Array<ArrayBuffer>, over: OverSampleType, cab: number,
      presence: number, level: number, verb: number): GainNode => {
      const input = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.curve = drive;
      shaper.oversample = over;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = cab; lp.Q.value = 0.9;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 95;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking'; peak.frequency.value = presence; peak.gain.value = 5; peak.Q.value = 1.1;
      const out = ctx.createGain();
      out.gain.value = level;
      input.connect(shaper).connect(lp).connect(hp).connect(peak).connect(out).connect(this.musicBus);
      if (verb > 0) this.room(out, verb);
      return input;
    };

    this.guitarMute = amp(this.hardCurve, '4x', 2100, 2300, 1.4, 0);
    this.guitarOpen = amp(this.hardCurve, '4x', 3400, 2300, 1.1, 0.12);
    this.leadIn = amp(this.hardCurve, '2x', 3600, 2600, 1, 0.2);

    // Bass: dark, slightly driven, in its own quiet lane.
    this.bassIn = ctx.createGain();
    const bLp = ctx.createBiquadFilter();
    bLp.type = 'lowpass'; bLp.frequency.value = 900; bLp.Q.value = 1.2;
    const bDrive = ctx.createWaveShaper();
    bDrive.curve = this.softCurve;
    bDrive.oversample = '2x';
    const bOut = ctx.createGain();
    bOut.gain.value = 1;
    this.bassIn.connect(bLp).connect(bDrive).connect(bOut).connect(this.musicBus);

    // The lead's slap delay, built once.
    const dly = ctx.createDelay(0.6);
    dly.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.24;
    dly.connect(fb).connect(dly);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    dly.connect(wet).connect(this.musicBus);
    this.slap = ctx.createGain();
    this.slap.connect(dly);
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
    this.musicBus.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.musicVolume * MUSIC_TRIM), this.t + 1.2);
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
    while (this.nextNoteTime < this.t + 0.15) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += SIXTEENTH;
      this.step++;
    }
  }

  private scheduleStep(step: number, when: number): void {
    const i = step % 16;                       // sixteenth within the bar
    const bar = Math.floor(step / 16);
    const chord = PROGRESSION[bar % 4];
    const sec = SECTIONS[Math.floor(bar / 4) % SECTIONS.length];
    /** Last bar of a four bar block: where the fill goes. */
    const fillBar = bar % 4 === 3;
    const g = sec.drive;

    // --- kit ---------------------------------------------------------------
    if (sec.kick[i] === 'x' && !(fillBar && i >= 12)) this.kick(when, g);
    if (sec.snare[i] === 'x' && !(fillBar && i >= 12)) this.snare(when, g);
    const hat = sec.hat[i];
    if (hat !== '.' && !(fillBar && i >= 12)) {
      if (i === 14 && !fillBar) this.openHat(when, 0.16 * g);
      else this.hat(when, (hat === 'o' ? 0.36 : 0.2) * g);
    }
    if (sec.crash && i === 0) this.crash(when, 0.3 * g);
    // A tom fill across the last beat of every fourth bar.
    if (fillBar && i >= 12) {
      const tomFreqs = [210, 175, 140, 112];
      this.tom(when, tomFreqs[i - 12], 0.4 * g);
      if (i === 15) this.snare(when + SIXTEENTH * 0.5, 0.7 * g);
    }

    // --- bass: straight eighths, walking up onto the next chord ------------
    if (i % 2 === 0) {
      const climb = i === 14 ? 2 : 1;          // octave lift into the turnaround
      this.bass(chord.bass * climb, when, BEAT * 0.46, 0.34 * g);
    }

    // --- guitars ------------------------------------------------------------
    if (sec.chug) {
      // Palm-muted sixteenths with the downbeats let off the mute: the engine
      // room of every song this game is trying to sound like.
      const open = i === 0 || i === 6 || i === 10;
      if (i % 2 === 0 || i === 7 || i === 15) {
        this.powerChord(chord.root, when, open ? BEAT * 0.5 : BEAT * 0.13, (open ? 0.2 : 0.12) * g, !open);
      }
    } else if (i === 0 || i === 6 || i === 10 || i === 14) {
      // Ringing open chords: fewer, longer, much bigger.
      this.powerChord(chord.root, when, i === 0 ? BEAT * 1.6 : BEAT * 0.8, 0.2 * g, false);
    }

    // --- lead hook: chorus only, so the drop has somewhere to go -----------
    if (sec.lead) {
      const note = chord.lead[(i / 4) | 0];
      if (i % 4 === 0) this.lead(note, when, BEAT * 0.7, 0.1);
      if (i === 10) this.lead(chord.lead[2] * 1.5, when, BEAT * 0.4, 0.07);
      if (i === 14 && fillBar) this.lead(chord.lead[3] * 2, when, BEAT * 0.5, 0.08);
    }
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

  /** Sends a voice to the room as well as straight to the bus. */
  private room(node: AudioNode, amount: number): void {
    const ctx = this.ctx!;
    const send = ctx.createGain();
    send.gain.value = amount;
    node.connect(send).connect(this.verb);
  }

  // ------------------------------------------------------------- the kit ---

  private kick(when: number, gain = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, when);
    o.frequency.exponentialRampToValueAtTime(41, when + 0.1);
    const drive = ctx.createWaveShaper();
    drive.curve = this.softCurve;
    o.connect(drive);
    this.env(drive, when, 0.9 * gain, 0.002, 0.26).connect(this.musicBus);
    o.start(when); o.stop(when + 0.34);
    // Beater click, so it cuts through the guitars on a laptop speaker.
    const c = ctx.createBufferSource();
    c.buffer = this.noiseBuffer;
    c.playbackRate.value = 1.4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    c.connect(lp);
    this.env(lp, when, 0.1 * gain, 0.001, 0.022).connect(this.musicBus);
    c.start(when); c.stop(when + 0.05);
  }

  private snare(when: number, gain = 1): void {
    const ctx = this.ctx!;
    // Wires: bright noise with a fast, slightly rounded tail.
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = 1.25;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 420;
    n.connect(bp).connect(hp);
    const wires = this.env(hp, when, 0.34 * gain, 0.001, 0.19);
    wires.connect(this.musicBus);
    this.room(wires, 0.22 * gain);
    n.start(when); n.stop(when + 0.26);
    // Drum head: two detuned tuned bodies, the way a real shell rings.
    for (const [f, amp, dur] of [[196, 0.17, 0.11], [258, 0.1, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, when);
      o.frequency.exponentialRampToValueAtTime(f * 0.72, when + dur);
      this.env(o, when, amp * gain, 0.001, dur).connect(this.musicBus);
      o.start(when); o.stop(when + dur + 0.05);
    }
  }

  private tom(when: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, when);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, when + 0.22);
    const out = this.env(o, when, gain, 0.002, 0.24);
    out.connect(this.musicBus);
    this.room(out, 0.2);
    o.start(when); o.stop(when + 0.3);
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * 4; bp.Q.value = 1.2;
    n.connect(bp);
    this.env(bp, when, gain * 0.28, 0.001, 0.05).connect(this.musicBus);
    n.start(when); n.stop(when + 0.09);
  }

  /**
   * Cymbal metal: six square waves at deliberately inharmonic ratios, run
   * through a highpass. It is the oldest trick in the drum machine book and
   * still the only cheap way to get something that rings like brass.
   */
  private metal(when: number, gain: number, decay: number, cutoff: number, base = 40): GainNode {
    const ctx = this.ctx!;
    const mix = ctx.createGain();
    mix.gain.value = 0.14;
    for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * r;
      o.connect(mix);
      o.start(when); o.stop(when + decay + 0.08);
    }
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = cutoff;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = cutoff * 1.4; bp.Q.value = 0.7;
    mix.connect(hp).connect(bp);
    const out = this.env(bp, when, gain, 0.001, decay);
    out.connect(this.musicBus);
    return out;
  }

  private hat(when: number, gain: number): void {
    this.metal(when, gain, 0.045, 8200);
  }

  private openHat(when: number, gain: number): void {
    const out = this.metal(when, gain, 0.34, 7600);
    this.room(out, 0.16);
  }

  private crash(when: number, gain: number): void {
    const ctx = this.ctx!;
    const out = this.metal(when, gain * 0.5, 1.4, 4200, 62);
    this.room(out, 0.5);
    // A wash of noise under the metal is what makes it a crash and not a bell.
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.playbackRate.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 3800;
    n.connect(hp);
    const wash = this.env(hp, when, gain * 0.8, 0.003, 1.2);
    wash.connect(this.musicBus);
    this.room(wash, 0.4);
    n.start(when); n.stop(when + 1.4);
  }

  // --------------------------------------------------------- the strings ---

  /**
   * Karplus-Strong. A ring buffer of noise one wavelength long, averaged with
   * its neighbour on every lap and losing a little amplitude each time: the
   * high harmonics die first and the fundamental hangs on, exactly like a
   * plucked string. `bright` is how much treble survives each lap.
   */
  private string(freq: number, decay: number, bright: number): AudioBuffer {
    const key = `${Math.round(freq)}:${decay}:${bright}`;
    const cached = this.strings.get(key);
    if (cached) return cached;

    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const period = Math.max(2, Math.round(sr / freq));
    const total = Math.floor(sr * decay);
    const buf = ctx.createBuffer(1, total, sr);
    const out = buf.getChannelData(0);
    const ring = new Float32Array(period);
    // The pluck: noise shaped by where along the string it was struck.
    for (let i = 0; i < period; i++) {
      const w = Math.sin((i / period) * Math.PI);
      ring[i] = (Math.random() * 2 - 1) * w;
    }
    // Per-lap loss chosen so the note is ~60 dB down at the end of the buffer.
    const laps = Math.max(1, (total / period));
    const loss = Math.pow(0.001, 1 / laps);
    let idx = 0;
    for (let i = 0; i < total; i++) {
      const cur = ring[idx];
      const nxt = ring[(idx + 1) % period];
      out[i] = cur;
      ring[idx] = (cur * bright + nxt * (1 - bright)) * loss;
      idx = (idx + 1) % period;
    }
    this.strings.set(key, buf);
    return buf;
  }

  private pluck(freq: number, when: number, dur: number, gain: number, opts: {
    decay: number; bright: number; through?: AudioNode; attack?: number; detune?: number;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.string(freq, opts.decay, opts.bright);
    if (opts.detune) src.detune.value = opts.detune;
    const g = this.env(src, when, gain, opts.attack ?? 0.002, dur);
    g.connect(opts.through ?? this.musicBus);
    src.start(when);
    src.stop(when + dur + 0.1);
  }

  /** Root, fifth and octave, strummed a hair apart, through amp and cabinet. */
  private powerChord(root: number, when: number, dur: number, gain: number, muted: boolean): void {
    const chain = muted ? this.guitarMute : this.guitarOpen;
    const decay = muted ? 0.3 : 1.4;
    const bright = muted ? 0.35 : 0.52;
    [1, 1.4983, 2].forEach((ratio, i) => {
      // A downstroke: the strings do not all speak at the same instant.
      this.pluck(root * ratio, when + i * 0.006, dur, gain * 1.7, {
        decay, bright, through: chain, detune: (i - 1) * 4,
      });
    });
  }

  /** The bass: a long, dark string plus a sine sub so phones feel it too. */
  private bass(freq: number, when: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    this.pluck(freq, when, dur, gain * 2.2, { decay: 0.9, bright: 0.62, through: this.bassIn });
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq;
    this.env(sub, when, gain * 0.5, 0.008, dur * 0.9).connect(this.musicBus);
    sub.start(when); sub.stop(when + dur + 0.1);
  }

  /** The hook: a brighter string through the lead amp and the shared slap. */
  private lead(freq: number, when: number, dur: number, gain = 0.09): void {
    this.pluck(freq, when, dur, gain * 6, { decay: 1.1, bright: 0.6, through: this.leadIn });
    this.pluck(freq, when, dur, gain * 1.6, { decay: 1.1, bright: 0.6, through: this.slap });
  }

  // ------------------------------------------------------------------ sfx ---

  /** Shared helper: a filtered burst of the noise buffer. */
  private noiseHit(when: number, opts: {
    gain: number; attack: number; decay: number; type: BiquadFilterType;
    from: number; to: number; q?: number; rate?: number; verb?: number;
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
    const g = this.env(f, when, opts.gain, opts.attack, opts.decay);
    g.connect(this.sfxBus);
    if (opts.verb) this.room(g, opts.verb);
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
        this.noiseHit(w, { gain: 0.55, attack: 0.001, decay: 0.13, type: 'lowpass', from: 5200 * pitch, to: 380, verb: 0.25 });
        this.tone(w, 'square', 320 * pitch, 70, 0.07, 0.16);
        break;
      case 'rifle':
        this.noiseHit(w, { gain: 0.4, attack: 0.001, decay: 0.085, type: 'lowpass', from: 6000 * pitch, to: 600, verb: 0.18 });
        this.tone(w, 'sawtooth', 260 * pitch, 90, 0.05, 0.12);
        break;
      case 'shotgun':
        this.noiseHit(w, { gain: 0.62, attack: 0.002, decay: 0.3, type: 'lowpass', from: 3200 * pitch, to: 160, rate: 0.7, verb: 0.3 });
        this.tone(w, 'sine', 160, 45, 0.22, 0.3);
        break;
      case 'cannon':
        this.noiseHit(w, { gain: 0.8, attack: 0.003, decay: 0.75, type: 'lowpass', from: 1800, to: 70, rate: 0.55, verb: 0.4 });
        this.tone(w, 'sine', 130, 30, 0.5, 0.5);
        this.tone(w + 0.02, 'sawtooth', 90, 28, 0.35, 0.2);
        break;
      case 'explosion':
        this.noiseHit(w, { gain: 0.75, attack: 0.004, decay: 0.9, type: 'lowpass', from: 2400, to: 60, rate: 0.5, verb: 0.4 });
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
      case 'heavyswing':
        // A slow, heavy weapon tearing the air open: a long low whoosh.
        this.noiseHit(w, { gain: 0.34, attack: 0.07, decay: 0.26, type: 'bandpass', from: 300 * pitch, to: 1500, q: 1.6, rate: 0.6 });
        this.tone(w + 0.04, 'sine', 170 * pitch, 70, 0.24, 0.14);
        break;
      case 'slam':
        // The hammer landing: a body blow with a tail of tumbling rubble.
        this.noiseHit(w, { gain: 0.85, attack: 0.002, decay: 0.55, type: 'lowpass', from: 1500, to: 60, rate: 0.45, verb: 0.35 });
        this.tone(w, 'sine', 105 * pitch, 24, 0.45, 0.55);
        this.tone(w + 0.03, 'triangle', 62, 20, 0.3, 0.24);
        this.noiseHit(w + 0.09, { gain: 0.24, attack: 0.02, decay: 0.5, type: 'bandpass', from: 900, to: 260, q: 1.1 });
        break;
      case 'aura':
        // The charge-up bed: a rising, resonant swell under the whole pose.
        this.noiseHit(w, { gain: 0.16, attack: 0.09, decay: 0.5, type: 'bandpass', from: 260 * pitch, to: 1700, q: 7 });
        this.tone(w, 'sawtooth', 90 * pitch, 260 * pitch, 0.55, 0.07);
        break;
      case 'scrape':
        // Steel dragging over concrete: grit with a ringing edge on top.
        this.noiseHit(w, { gain: 0.11, attack: 0.006, decay: 0.12, type: 'bandpass', from: 1700 * pitch, to: 900 * pitch, q: 2.2, rate: 0.9 });
        this.tone(w, 'sawtooth', 2100 * pitch, 1500 * pitch, 0.09, 0.02);
        break;
      case 'step':
        this.noiseHit(w, { gain: 0.075 * pitch, attack: 0.001, decay: 0.055, type: 'lowpass', from: 1100, to: 200 });
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
        // The band stabs the tonic chord with you.
        [0, 0.11, 0.22, 0.42].forEach((d, i) => {
          this.tone(w + d, 'square', hz([-9, -5, -2, 3][i]), hz([-9, -5, -2, 3][i]), 0.3, 0.16);
        });
        this.crash(w, 0.4);
        this.powerChord(N.C3, w + 0.42, BEAT * 2, 0.24, false);
        break;
    }
  }
}

export type SfxName =
  | 'punch' | 'swing' | 'slash' | 'stab' | 'pistol' | 'rifle' | 'shotgun'
  | 'cannon' | 'explosion' | 'launch' | 'fire' | 'beam' | 'charge'
  | 'heavyswing' | 'slam' | 'aura' | 'step' | 'scrape'
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

/** A rehearsal room, as an impulse response: decaying noise with early taps. */
function makeRoom(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // A little pre-delay keeps the tail behind the dry hit.
      const gate = i < sr * 0.012 ? 0 : 1;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * gate * 0.7;
    }
    // Early reflections: a handful of discrete bounces off the near walls.
    for (const [ms, amp] of [[13, 0.5], [21, 0.38], [34, 0.28], [47, 0.2]] as const) {
      const i = Math.floor(sr * (ms / 1000)) + (ch === 1 ? 37 : 0);
      if (i < len) d[i] += amp * (ch === 0 ? 1 : -1);
    }
  }
  return buf;
}

export const audio = new AudioEngine();
