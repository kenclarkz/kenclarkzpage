// Every sound, synthesised at runtime. No audio files, for the same reason there
// are no image files: the whole game is precached for offline play, and an
// oscillator is bytes where a sample is megabytes.
//
// The one sound that matters most is the roll. A skateboard on concrete is
// filtered noise whose brightness tracks speed, and because it is continuous it is
// the only cue that tells you how fast you are going without looking at anything.
// Everything else — the pop, the landing, the grind, the slam — hangs off it.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Audio {
  constructor(on = true) {
    this.ctx = null;
    this.on = on;
    this.rollGain = null;
    this.grindGain = null;
    this.speed = 0;
    this.surface = 0;
  }

  /**
   * Build or resume the context. Must be called from inside a user gesture, and is
   * safe to call on every one — mobile Safari will not start a context otherwise,
   * and the OS can suspend it again at any point.
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.on ? 0.85 : 0;
      this.master.connect(ctx.destination);

      // One two-second noise buffer, looped and reused by everything textural.
      const len = Math.floor(ctx.sampleRate * 2);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.buildRoll();
      this.buildGrind();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setEnabled(on) {
    this.on = on;
    if (this.master) this.master.gain.value = on ? 0.85 : 0;
  }

  source(loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    return s;
  }

  /**
   * The rolling loop: broadband noise through a bandpass that opens up with
   * speed, plus a low resonant peak for the rumble of urethane on concrete.
   */
  buildRoll() {
    const ctx = this.ctx;
    const src = this.source();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 400;
    band.Q.value = 0.7;
    const low = ctx.createBiquadFilter();
    low.type = 'peaking';
    low.frequency.value = 120;
    low.gain.value = 8;
    low.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(low).connect(gain).connect(this.master);
    src.start();
    this.rollGain = gain;
    this.rollBand = band;
  }

  /** Grinding: the same noise, far brighter, plus a metallic ring on top. */
  buildGrind() {
    const ctx = this.ctx;
    const src = this.source();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const ring = ctx.createBiquadFilter();
    ring.type = 'peaking';
    ring.frequency.value = 2600;
    ring.gain.value = 14;
    ring.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(ring).connect(gain).connect(this.master);
    src.start();
    this.grindGain = gain;
    this.grindRing = ring;
  }

  /**
   * Follow the ride. Called every frame with how fast the board is going, whether
   * it is on the ground, and whether it is on a rail.
   */
  follow(speed, grounded, grinding, rough) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const v = clamp(speed / 9, 0, 1.2);
    const rollTarget = grounded && !grinding ? 0.02 + v * 0.20 : 0;
    this.rollGain.gain.setTargetAtTime(rollTarget, t, 0.05);
    // Brightness with speed is what makes the loop read as motion rather than as
    // a hiss; the rough surface just gets louder and coarser.
    this.rollBand.frequency.setTargetAtTime(320 + v * 1500 + (rough ? 400 : 0), t, 0.08);
    this.rollBand.Q.setTargetAtTime(rough ? 0.4 : 0.9, t, 0.1);

    this.grindGain.gain.setTargetAtTime(grinding ? 0.05 + v * 0.16 : 0, t, 0.03);
    if (grinding) this.grindRing.frequency.setTargetAtTime(1800 + v * 2200, t, 0.1);
  }

  /** A short filtered noise burst: the workhorse behind most of the one-shots. */
  burst({ gain = 0.4, attack = 0.002, decay = 0.14, type = 'bandpass', freq = 800, q = 1, sweep = 0 }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this.source(false);
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + decay);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  /** A short pitched thump, for the tail hitting concrete. */
  thump(freq, gain, decay) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.4, t + decay);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  }

  // --- one-shots ---------------------------------------------------------
  /** The tail snapping down: a hard wooden crack, not a boing. */
  pop(height = 0.5) {
    this.thump(190 - height * 40, 0.4, 0.1);
    this.burst({ gain: 0.34, freq: 2200, q: 0.8, decay: 0.07, sweep: 0.3 });
  }

  /** Wheels coming back down. The harder the landing, the lower it lands. */
  land(impact = 3) {
    const hard = clamp(impact / 8, 0.2, 1);
    this.thump(150 - hard * 50, 0.28 + hard * 0.3, 0.12 + hard * 0.1);
    this.burst({ gain: 0.2 + hard * 0.2, freq: 900, q: 0.6, decay: 0.1, sweep: 0.25 });
  }

  /** Locking onto a rail: metal meeting metal. */
  lock() {
    this.burst({ gain: 0.3, freq: 3200, q: 3, decay: 0.12, sweep: 0.5 });
    this.thump(320, 0.14, 0.06);
  }

  /** A shoe pushing off concrete. */
  push() {
    this.burst({ gain: 0.22, freq: 700, q: 0.5, decay: 0.22, sweep: 0.5 });
  }

  /** Urethane giving up. */
  slide() {
    this.burst({ gain: 0.26, freq: 1400, q: 0.7, decay: 0.3, sweep: 0.4 });
  }

  /** The slam: a body and a board arriving separately. */
  bail() {
    this.thump(90, 0.5, 0.3);
    this.burst({ gain: 0.4, freq: 500, q: 0.4, decay: 0.4, sweep: 0.2 });
    if (!this.ready) return;
    // The board's own clatter, a moment later.
    setTimeout(() => this.burst({ gain: 0.3, freq: 1800, q: 1.4, decay: 0.35, sweep: 0.3 }), 120);
  }

  /** Banking a combo. Two notes, so it reads as a reward and not as an alert. */
  chime(big) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = big ? [523.25, 659.25, 783.99] : [523.25, 659.25];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0;
      const at = t + i * 0.07;
      g.gain.linearRampToValueAtTime(0.16, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      osc.connect(g).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.45);
    });
  }

  /** Everything quiet, for a pause or a menu. */
  hush() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.rollGain.gain.setTargetAtTime(0, t, 0.05);
    this.grindGain.gain.setTargetAtTime(0, t, 0.05);
  }
}
