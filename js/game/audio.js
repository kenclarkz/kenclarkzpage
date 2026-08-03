// All of the game's sound, synthesised at runtime.
//
// There are no audio files here for the same reason there are no image files:
// everything is precached for offline play, and a music loop long enough not to
// grate is megabytes. An oscillator is bytes. The music is therefore played
// rather than replayed — a scheduler walks a sixteen-step bar and builds each
// hit out of oscillators and filtered noise, which also means the tempo can
// follow the runner's speed and the arrangement can change when the guardian
// shows up.
//
// Two rules govern everything below:
//   - The AudioContext is created on a user gesture, never before. Mobile
//     Safari will not start one otherwise, and a context created too early
//     stays stuck in 'suspended' for the rest of the session.
//   - Nodes are one-shot. Oscillators and buffer sources cannot be restarted,
//     so every sound builds its own and lets it stop itself.

const SEMI = [0, 3, 5, 7, 10]; // minor pentatonic: the safe, folk-modal choice
const BASE = 110;              // A2

function freq(degree, octave = 0) {
  const s = SEMI[((degree % SEMI.length) + SEMI.length) % SEMI.length];
  return BASE * Math.pow(2, s / 12 + octave);
}

/** Standard soft-clip curve, for the guardian's growl. */
function distortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * Math.PI) / (180 + amount * Math.abs(x) * 180);
  }
  return curve;
}

export class Audio {
  constructor(musicOn = true, sfxOn = true) {
    this.ctx = null;
    this.musicOn = musicOn;
    this.sfxOn = sfxOn;
    this.running = false;
    this.step = 0;
    this.bar = 0;
    this.nextTime = 0;
    this.timer = 0;
    this.intensity = 0; // 0..1, follows the runner's speed
    this.chase = false;
  }

  /**
   * Build (or resume) the context. Must be called from inside a user gesture.
   * Safe to call repeatedly — every tap routes here, because a context can be
   * suspended again by the OS at any point.
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? 1 : 0;
      this.musicBus.connect(this.master);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxOn ? 1 : 0;
      this.sfxBus.connect(this.master);

      // One noise buffer, reused by every percussive and textural sound.
      const len = Math.floor(this.ctx.sampleRate * 2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.growlCurve = distortionCurve(40);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }

  setSfx(on) {
    this.sfxOn = on;
    if (this.ctx) this.sfxBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  // --- building blocks ----------------------------------------------------

  /** A pitched blip with an exponential pitch and amplitude fall. */
  tone(t, { type = 'sine', from, to, dur, gain = 0.3, dest = null, detune = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(from, t);
    // exponentialRamp cannot reach or pass through zero.
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to ?? from), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest || this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
    return o;
  }

  /** A filtered noise burst: every drum, scrape and whoosh in the game. */
  noise(t, { dur, gain = 0.3, type = 'bandpass', from = 900, to = null, q = 1, dest = null }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to !== null) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
    return src;
  }

  // --- one-shots ----------------------------------------------------------

  jump() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.tone(t, { type: 'triangle', from: 280, to: 720, dur: 0.16, gain: 0.16 });
    this.noise(t, { dur: 0.18, gain: 0.1, type: 'highpass', from: 500, to: 2200 });
  }

  land() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.tone(t, { type: 'sine', from: 170, to: 48, dur: 0.16, gain: 0.3 });
    this.noise(t, { dur: 0.1, gain: 0.16, type: 'lowpass', from: 1400, to: 260 });
  }

  slide() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    // Grit sweeping down as the runner scrubs off speed.
    this.noise(t, { dur: 0.5, gain: 0.2, type: 'bandpass', from: 2600, to: 500, q: 0.8 });
    this.noise(t, { dur: 0.45, gain: 0.1, type: 'lowpass', from: 900, to: 300 });
  }

  coin() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.tone(t, { type: 'triangle', from: 1318, to: 1318, dur: 0.07, gain: 0.12 });
    this.tone(t + 0.06, { type: 'triangle', from: 1976, to: 1976, dur: 0.12, gain: 0.1 });
  }

  hit() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.noise(t, { dur: 0.26, gain: 0.34, type: 'lowpass', from: 2200, to: 180 });
    this.tone(t, { type: 'square', from: 150, to: 40, dur: 0.24, gain: 0.2 });
  }

  /**
   * The guardian. Three layers: a distorted growl carrying the weight, a
   * wobbling mid band that makes it sound alive rather than synthetic, and a
   * short screech on top for the fright. The music ducks under it — without
   * that it competes with the drums and stops being frightening.
   */
  roar(big = false) {
    if (!this.ready || !this.sfxOn) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = big ? 1.9 : 1.4;

    const shaper = ctx.createWaveShaper();
    shaper.curve = this.growlCurve;
    const body = ctx.createGain();
    body.gain.value = big ? 0.42 : 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    shaper.connect(lp).connect(body).connect(this.sfxBus);

    // Two detuned saws beating against each other read as a throat.
    for (const detune of [-14, 12]) {
      this.tone(t, { type: 'sawtooth', from: big ? 88 : 74, to: 42, dur, gain: 0.5, dest: shaper, detune });
    }
    // Wobble.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = big ? 7.5 : 5.5;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start(t);
    lfo.stop(t + dur);

    this.noise(t, { dur: dur * 0.8, gain: 0.16, type: 'bandpass', from: 1100, to: 300, q: 1.4 });
    this.tone(t + 0.05, { type: 'sawtooth', from: 1050, to: 380, dur: 0.35, gain: 0.06 });

    if (this.musicOn) {
      const g = this.musicBus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.28, t + 0.06);
      g.linearRampToValueAtTime(1, t + dur * 0.75);
    }
  }

  caught() {
    if (!this.ready) return;
    this.roar(true);
    if (!this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.noise(t, { dur: 0.5, gain: 0.4, type: 'lowpass', from: 1800, to: 90 });
  }

  // --- music --------------------------------------------------------------

  /** @param {number} t 0..1, how fast the runner is going */
  setIntensity(t) {
    this.intensity = Math.max(0, Math.min(1, t));
  }

  setChase(on) {
    this.chase = on;
  }

  get bpm() {
    return 98 + this.intensity * 30 + (this.chase ? 16 : 0);
  }

  startMusic() {
    if (!this.ready || this.running) return;
    this.running = true;
    this.step = 0;
    this.bar = 0;
    this.nextTime = this.ctx.currentTime + 0.06;

    // A sustained drone under everything, so the gaps between hits are not
    // silence. Started once and held for as long as the music runs.
    this.drone = this.ctx.createGain();
    this.drone.gain.value = 0.0001;
    this.drone.gain.setTargetAtTime(0.05, this.ctx.currentTime, 0.8);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    this.drone.connect(lp).connect(this.musicBus);
    this.droneOsc = [];
    for (const detune of [-8, 6]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = BASE / 2;
      o.detune.value = detune;
      o.connect(this.drone);
      o.start();
      this.droneOsc.push(o);
    }

    // Lookahead scheduling: a timer this coarse would be audibly uneven if it
    // played notes directly, so instead it queues them a little ahead on the
    // audio clock, which is sample-accurate.
    this.timer = setInterval(() => this.pump(), 25);
  }

  stopMusic() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = 0;
    const t = this.ctx.currentTime;
    if (this.drone) {
      this.drone.gain.cancelScheduledValues(t);
      this.drone.gain.setTargetAtTime(0.0001, t, 0.12);
      for (const o of this.droneOsc) o.stop(t + 0.6);
      this.drone = null;
      this.droneOsc = [];
    }
  }

  pump() {
    if (!this.running || !this.ctx) return;
    const stepDur = 60 / this.bpm / 4; // sixteenth notes
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += stepDur;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  playStep(i, t) {
    const bus = this.musicBus;
    const chase = this.chase;

    // Kick: a four-on-the-floor pulse. Nothing sells running like it.
    if (i % 4 === 0) {
      this.tone(t, { type: 'sine', from: 130, to: 44, dur: 0.2, gain: 0.5, dest: bus });
    }
    // Frame drum accents, busier once something is behind you.
    if (i === 6 || i === 14 || (chase && (i === 3 || i === 11))) {
      this.tone(t, { type: 'sine', from: 240, to: 120, dur: 0.16, gain: 0.26, dest: bus });
    }
    // Shaker on every off-beat, accented on the quarter.
    if (i % 2 === 1) {
      this.noise(t, { dur: 0.05, gain: i % 4 === 3 ? 0.07 : 0.04, type: 'highpass', from: 5200, dest: bus });
    }

    // Bass, rooted with a fifth pickup before the bar turns over.
    if (i === 0 || i === 6 || i === 10) {
      const deg = i === 10 ? 3 : 0;
      this.tone(t, { type: 'triangle', from: freq(deg, -1), to: freq(deg, -1), dur: 0.3, gain: 0.22, dest: bus });
    }

    // Melody: four motifs, cycled by bar so the loop takes a while to repeat.
    const motif = [
      [null, 4, null, 2, null, null, 1, null],
      [3, null, null, 1, null, 0, null, null],
      [null, null, 2, null, 4, null, 3, null],
      [0, null, 1, null, null, 3, null, 2],
    ][this.bar % 4];
    if (i % 2 === 0) {
      const deg = motif[i / 2];
      if (deg !== null) {
        this.tone(t, {
          type: 'triangle',
          from: freq(deg, 1),
          to: freq(deg, 1),
          dur: 0.26,
          gain: chase ? 0.1 : 0.08,
          dest: bus,
        });
      }
    }

    // A dissonant semitone above the root, only while being hunted.
    if (chase && i === 8) {
      this.tone(t, { type: 'sawtooth', from: BASE * 1.06, to: BASE * 1.06, dur: 0.5, gain: 0.05, dest: bus });
    }
  }
}
