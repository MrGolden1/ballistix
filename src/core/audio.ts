/**
 * Procedural audio with a metal flavour: every sound effect and the music are synthesised with the
 * Web Audio API, so the game ships without audio files.
 *
 * - Hits are struck-steel tones: a few inharmonic sine partials (like a metal bar or plate) with fast
 *   decays, which sound metallic but stay smooth.
 * - Big moments (goal, smash, GO) use a distorted power chord and a cymbal crash.
 * - The music is a palm-muted metal groove (E minor, 132 BPM) with drums and a soft bell lead.
 * Everything goes through a gentle low-pass and a compressor so it never gets harsh or clips.
 */
export type Sfx =
  | 'paddle' | 'wall' | 'shield' | 'zap' | 'ball' | 'goal' | 'elim' | 'crate' | 'power' | 'beep' | 'go' | 'win' | 'spawn'
  | 'serve' | 'item' | 'swing' | 'smash' | 'life' | 'laststand';

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Free-bar / plate vibration modes (ratio, relative amplitude): the core of the metal sound. */
const METAL_PARTIALS: [number, number][] = [
  [1, 1],
  [2.0, 0.3],
  [2.76, 0.45],
  [4.07, 0.2],
  [5.4, 0.12],
  [6.8, 0.06],
];

function distortionCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  /** Inputs of the two "guitar amp" chains (distortion + cabinet filter): one for music, one for effects. */
  private gtrMusic!: GainNode;
  private gtrSfx!: GainNode;
  private noiseBuf!: AudioBuffer;
  private musicTimer = 0;
  private step = 0;
  private nextTime = 0;
  musicOn = true;
  sfxOn = true;

  /** Must be called from a user gesture (click/key) at least once. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = (this.ctx = new Ctor());

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(comp);

      // Effects: a soft low-pass keeps the metal partials from getting shrill.
      const sfxTone = ctx.createBiquadFilter();
      sfxTone.type = 'lowpass';
      sfxTone.frequency.value = 7000;
      sfxTone.connect(this.master);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 0.6;
      this.sfxBus.connect(sfxTone);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? 0.32 : 0;
      this.musicBus.connect(this.master);

      this.gtrMusic = this.makeAmp(this.musicBus, 0.45);
      this.gtrSfx = this.makeAmp(this.sfxBus, 0.35);

      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startMusic();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** A small guitar amp: high-pass, soft-clip distortion, cabinet low-pass. Returns its input. */
  private makeAmp(out: AudioNode, level: number): GainNode {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 85;
    const drive = ctx.createWaveShaper();
    drive.curve = distortionCurve(22);
    drive.oversample = '4x';
    const cab = ctx.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 2600;
    cab.Q.value = 0.7;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 800;
    mid.gain.value = -4; // a slight mid scoop: the classic metal tone, but not fizzy
    const g = ctx.createGain();
    g.gain.value = level;
    input.connect(hp).connect(drive).connect(cab).connect(mid).connect(g).connect(out);
    return input;
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 0.08);
  }

  setSfx(on: boolean): void {
    this.sfxOn = on;
  }

  // --- building blocks ---------------------------------------------------------------

  private env(g: GainNode, t0: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  private osc(type: OscillatorType, freq: number, t0: number, dur: number, peak: number, out: AudioNode, slideTo?: number, detune = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    this.env(g, t0, peak, 0.004, dur);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(t0: number, dur: number, peak: number, type: BiquadFilterType, freq: number, out: AudioNode, q = 0.8, sweepTo?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t0, peak, 0.002, dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  /** Struck steel: inharmonic partials, higher ones die faster, plus a short "tick" transient. */
  private metal(freq: number, dur: number, vol: number, when = 0, bright = 1, out?: AudioNode): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + when;
    const dest = out ?? this.sfxBus;
    for (const [ratio, amp] of METAL_PARTIALS) {
      const f = freq * ratio;
      if (f > 9000) continue;
      this.osc('sine', f, t0, dur / (1 + (ratio - 1) * 0.45 * bright), vol * amp * (ratio === 1 ? 1 : bright), dest);
    }
    this.noise(t0, 0.025, vol * 0.35 * bright, 'bandpass', Math.min(8000, freq * 5), dest, 1.4);
  }

  /** Distorted power chord (root, fifth, octave). `mute` = palm-muted chug. */
  private chord(root: number, dur: number, vol: number, when = 0, mute = false, music = false): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + when;
    let dest: AudioNode = music ? this.gtrMusic : this.gtrSfx;
    if (mute) {
      const pm = ctx.createBiquadFilter();
      pm.type = 'lowpass';
      pm.frequency.value = 650;
      pm.connect(dest);
      dest = pm;
    }
    for (const [semi, det] of [[0, -7], [0, 6], [7, 0], [12, 3]] as [number, number][]) {
      this.osc('sawtooth', NOTE(root + semi), t0, dur, vol, dest, undefined, det);
    }
  }

  private crash(when: number, vol: number, out?: AudioNode): void {
    const t0 = this.ctx!.currentTime + when;
    const dest = out ?? this.sfxBus;
    this.noise(t0, 1.3, vol, 'highpass', 5200, dest, 0.5);
    this.noise(t0, 0.6, vol * 0.5, 'bandpass', 9000, dest, 1.2);
  }

  private kick(t0: number, vol: number, out: AudioNode): void {
    this.osc('sine', 125, t0, 0.16, vol, out, 42);
    this.noise(t0, 0.012, vol * 0.4, 'highpass', 2500, out);
  }

  private snare(t0: number, vol: number, out: AudioNode): void {
    this.noise(t0, 0.17, vol, 'bandpass', 1900, out, 0.7);
    this.osc('triangle', 190, t0, 0.08, vol * 0.6, out, 150);
  }

  private hat(t0: number, vol: number, out: AudioNode, open = false): void {
    this.noise(t0, open ? 0.22 : 0.04, vol, 'highpass', 8000, out, 0.7);
  }

  // --- effects -----------------------------------------------------------------------

  play(name: Sfx, intensity = 0.5): void {
    if (!this.ctx || !this.sfxOn) return;
    const now = this.ctx.currentTime;
    switch (name) {
      case 'paddle':
        // Brighter, higher clang as the ball gets faster.
        this.metal(300 + intensity * 320, 0.45, 0.2, 0, 0.7 + intensity * 0.5);
        this.osc('sine', 95, now, 0.07, 0.18, this.sfxBus, 60);
        break;
      case 'wall':
        this.metal(150 + intensity * 30, 0.2, 0.1, 0, 0.35);
        this.noise(now, 0.05, 0.08, 'lowpass', 600, this.sfxBus);
        break;
      case 'shield':
        this.metal(880, 0.35, 0.09, 0, 0.8);
        this.noise(now, 0.15, 0.06, 'bandpass', 4000, this.sfxBus, 2);
        break;
      case 'zap':
        // Electric field: a short buzz with crackles.
        this.osc('sawtooth', 70 + Math.random() * 30, now, 0.18, 0.12, this.gtrSfx, 50);
        for (let i = 0; i < 3; i++) this.noise(now + i * 0.035 + Math.random() * 0.02, 0.03, 0.14, 'highpass', 3500, this.sfxBus);
        this.metal(1400, 0.15, 0.05, 0, 1);
        break;
      case 'ball':
        this.metal(720, 0.15, 0.07, 0, 0.6);
        break;
      case 'goal':
        // Net swish, a deep metal gong, then a short 'dun-DUN' power-chord pair and a soft cymbal.
        this.noise(now, 0.28, 0.16, 'bandpass', 1600, this.sfxBus, 0.9, 380);
        this.kick(now + 0.03, 0.6, this.sfxBus);
        this.metal(82, 1.6, 0.2, 0.03, 0.35);
        this.chord(40, 0.16, 0.17, 0.1);
        this.chord(47, 0.75, 0.17, 0.26);
        this.metal(NOTE(83), 0.9, 0.05, 0.26, 0.4);
        this.crash(0.26, 0.12);
        break;
      case 'elim':
        this.chord(40, 0.45, 0.22);
        this.chord(39, 0.9, 0.22, 0.28);
        this.metal(110, 1.2, 0.22, 0, 0.5);
        this.crash(0.28, 0.22);
        break;
      case 'crate':
        this.metal(520, 0.3, 0.12, 0, 0.8);
        this.noise(now, 0.06, 0.1, 'bandpass', 2600, this.sfxBus, 0.8);
        break;
      case 'power':
        [76, 79, 83, 88].forEach((n, i) => this.metal(NOTE(n), 0.5, 0.07, i * 0.06, 0.6));
        break;
      case 'spawn':
        this.metal(NOTE(88), 0.5, 0.06, 0, 0.5);
        break;
      case 'serve':
        this.metal(NOTE(64), 0.3, 0.06, 0, 0.5);
        this.metal(NOTE(71), 0.4, 0.06, 0.08, 0.5);
        break;
      case 'item':
        this.noise(now, 0.25, 0.12, 'bandpass', 500, this.sfxBus, 1.2, 3000);
        this.metal(NOTE(83), 0.5, 0.08, 0.05, 0.7);
        break;
      case 'swing':
        this.noise(now, 0.13, 0.12, 'bandpass', 700, this.sfxBus, 1.5, 3200);
        break;
      case 'smash':
        this.metal(185, 0.75, 0.3, 0, 1);
        this.chord(52, 0.22, 0.14);
        this.noise(now, 0.08, 0.25, 'highpass', 3000, this.sfxBus);
        break;
      case 'life':
        [72, 76, 79, 84].forEach((n, i) => this.metal(NOTE(n), 0.6, 0.08, i * 0.07, 0.5));
        break;
      case 'laststand':
        this.chord(36, 0.9, 0.18);
        this.metal(98, 1.2, 0.18, 0, 0.4);
        break;
      case 'beep':
        this.metal(NOTE(69), 0.4, 0.16, 0, 0.6);
        break;
      case 'go':
        this.chord(40, 0.8, 0.22);
        this.metal(NOTE(81), 0.8, 0.12, 0, 0.6);
        this.crash(0, 0.22);
        break;
      case 'win':
        [40, 43, 45, 52].forEach((r, i) => this.chord(r, i === 3 ? 1.4 : 0.32, 0.2, i * 0.3));
        this.crash(0.9, 0.24);
        [76, 79, 83, 88].forEach((n, i) => this.metal(NOTE(n), 0.8, 0.07, 0.9 + i * 0.08, 0.5));
        break;
    }
  }

  // --- music: palm-muted metal groove ----------------------------------------------

  private startMusic(): void {
    if (!this.ctx) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 50);
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const stepDur = 60 / 132 / 4;
    const roots = [40, 40, 43, 38]; // E5 E5 G5 D5
    // C = open chord, m = palm-muted chug, '' = rest
    const gtr = ['C', '', 'm', '', 'm', 'm', '', 'm', 'C', '', 'm', '', 'm', '', 'm', 'm'];
    const kick = [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0];
    const lead = [76, 0, 0, 0, 79, 0, 0, 0, 81, 0, 83, 0, 79, 0, 0, 0];
    const bus = this.musicBus;
    while (this.nextTime < ctx.currentTime + 0.25) {
      const when = this.nextTime - ctx.currentTime;
      const t0 = this.nextTime;
      const i = this.step % 16;
      const bar = Math.floor(this.step / 16) % 4;
      const phrase = Math.floor(this.step / 64) % 2;
      const root = roots[bar];
      const fill = bar === 3 && i >= 12;

      if (gtr[i] === 'C') this.chord(root, stepDur * 1.9, 0.12, when, false, true);
      else if (gtr[i] === 'm') this.chord(root, stepDur * 0.7, 0.13, when, true, true);

      if (kick[i] || (fill && i % 1 === 0 && i >= 14)) this.kick(t0, 0.55, bus);
      if (i === 4 || i === 12 || (fill && i === 13)) this.snare(t0, 0.28, bus);
      if (i % 2 === 0) this.hat(t0, i === 14 ? 0.07 : 0.045, bus, i === 14);
      if (i === 0 && bar === 0) this.crash(when, 0.08, bus);

      // A soft bell lead on every second phrase, so the loop keeps evolving.
      if (phrase === 1 && lead[i] && bar < 3) this.metal(NOTE(lead[i] + (bar === 2 ? 3 : 0)), 0.6, 0.035, when, 0.5, bus);

      this.nextTime += stepDur;
      this.step++;
    }
  }

  dispose(): void {
    window.clearInterval(this.musicTimer);
    void this.ctx?.close();
  }
}
