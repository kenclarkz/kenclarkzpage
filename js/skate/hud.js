// The DOM overlay: readouts, trick call-outs, the balance meter, and the menus.
//
// Kept out of WebGL entirely. Text, buttons and lists are what the DOM is good at,
// and a menu made of real elements gets focus rings, tap targets and text scaling
// for nothing.

const SCREENS = ['start', 'paused', 'guide', 'bail'];

/** Reasons a bail can happen, in the words a skater would use. */
const BAIL_TEXT = {
  hit: 'Rolled straight into it',
  primo: 'Landed on the side of the board',
  'slide-out': 'Landed sideways',
  nose: 'Nosedived',
  flat: 'Too far to flat',
  balance: 'Lost it on the rail',
  manual: 'Lost the manual',
};

export class Hud {
  constructor() {
    this.scoreEl = document.getElementById('score');
    this.bestEl = document.getElementById('best');
    this.comboEl = document.getElementById('combo');
    this.comboList = document.getElementById('combo-list');
    this.comboMult = document.getElementById('combo-mult');
    this.callout = document.getElementById('callout');
    this.speedEl = document.getElementById('speed');
    this.airEl = document.getElementById('air');
    this.balance = document.getElementById('balance');
    this.balancePip = document.getElementById('balance-pip');
    this.chargeEl = document.getElementById('charge');
    this.chargeBar = document.getElementById('charge-bar');
    this.debugEl = document.getElementById('debug');
    this.stats = document.getElementById('stats');

    this.overlay = document.getElementById('overlay');
    this.screens = {};
    for (const n of SCREENS) this.screens[n] = document.getElementById(`screen-${n}`);
    this.bailWhy = document.getElementById('bail-why');
    this.soundBtn = document.getElementById('opt-sound');
    this.statLines = document.getElementById('stat-lines');

    this.on = { play: null, resume: null, retry: null, guide: null, back: null, sound: null, reset: null };
    this._score = -1;
    this._best = -1;
    this.calloutTimer = 0;
    this.bind();
  }

  bind() {
    const click = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    click('btn-play', () => this.on.play?.());
    click('btn-guide', () => this.on.guide?.());
    click('btn-guide-back', () => this.on.back?.());
    click('btn-resume', () => this.on.resume?.());
    click('btn-pause-menu', () => this.on.back?.());
    click('btn-bail-menu', () => this.on.back?.());
    click('btn-retry', () => this.on.retry?.());
    click('opt-sound', () => this.on.sound?.());
    click('opt-reset', () => this.on.reset?.());
  }

  // --- readouts ----------------------------------------------------------
  setScore(v) {
    const n = Math.floor(v);
    if (n === this._score) return;
    this._score = n;
    this.scoreEl.textContent = n.toLocaleString();
  }

  setBest(v) {
    const n = Math.floor(v);
    if (n === this._best) return;
    this._best = n;
    this.bestEl.textContent = n.toLocaleString();
  }

  /** Speed in km/h: metres per second means nothing to most people. */
  setSpeed(ms) {
    const kmh = Math.round(ms * 3.6);
    if (kmh === this._speed) return;
    this._speed = kmh;
    this.speedEl.textContent = `${kmh}`;
  }

  /** Height off the ground, shown only while it is worth showing. */
  setAir(metres) {
    const show = metres > 0.25;
    if (show !== this._airShown) {
      this._airShown = show;
      this.airEl.hidden = !show;
    }
    if (show) this.airEl.textContent = `${metres.toFixed(2)} m`;
  }

  /**
   * The live combo. Rebuilt only when the chain changes, since this is the one
   * readout that can update several times a second.
   */
  setCombo(names, points, multiplier) {
    const live = names.length > 0;
    if (live !== this._comboLive) {
      this._comboLive = live;
      this.comboEl.hidden = !live;
    }
    if (!live) return;
    const key = `${names.join('+')}|${Math.floor(points)}`;
    if (key === this._comboKey) return;
    this._comboKey = key;
    this.comboList.textContent = names.join('  +  ');
    this.comboMult.textContent = `${Math.floor(points).toLocaleString()} × ${multiplier}`;
  }

  /** A trick's name, thrown up over the action and left to fade. */
  say(text, kind = '') {
    this.callout.textContent = text;
    this.callout.className = kind;
    this.callout.hidden = false;
    // Restarting the animation needs the class off for a frame, and reading
    // offsetWidth is what forces that reflow.
    this.callout.classList.remove('pop');
    void this.callout.offsetWidth;
    this.callout.classList.add('pop');
    this.calloutTimer = 1.6;
  }

  tick(dt) {
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.callout.hidden = true;
    }
  }

  /**
   * The balance meter. Shown whenever a grind or a manual is live, because
   * without it the drift is invisible and the trick stops being playable.
   */
  setBalance(active, value, limit) {
    if (active !== this._balanceOn) {
      this._balanceOn = active;
      this.balance.hidden = !active;
    }
    if (!active) return;
    const t = Math.max(-1, Math.min(1, value / limit));
    // The pip is half the width of the track, so ±100% of its own width is the
    // full range and the ends line up with losing it.
    this.balancePip.style.transform = `translateX(${t * 100}%)`;
    this.balance.classList.toggle('warn', Math.abs(t) > 0.62);
  }

  /** How loaded the legs are, so a flick's pop is something you can aim. */
  setCharge(v) {
    const show = v > 0.01;
    if (show !== this._chargeOn) {
      this._chargeOn = show;
      this.chargeEl.hidden = !show;
    }
    if (!show) return;
    this.chargeBar.style.transform = `scaleX(${Math.min(1, v)})`;
    this.chargeEl.classList.toggle('full', v > 0.92);
  }

  setDebug(text) {
    if (this.debugEl.hidden) return;
    this.debugEl.textContent = text;
  }

  enableDebug() {
    this.debugEl.hidden = false;
  }

  // --- screens -----------------------------------------------------------
  show(name) {
    for (const n of SCREENS) this.screens[n].hidden = n !== name;
    this.overlay.hidden = false;
    this.current = name;
    this.stats.hidden = true;
  }

  hide() {
    this.overlay.hidden = true;
    this.stats.hidden = false;
    this.current = null;
  }

  get visible() {
    return !this.overlay.hidden;
  }

  showBail(reason) {
    this.bailWhy.textContent = BAIL_TEXT[reason] || 'Slam';
    this.show('bail');
  }

  setSound(on) {
    if (this.soundBtn) {
      this.soundBtn.textContent = `Sound: ${on ? 'On' : 'Off'}`;
      this.soundBtn.classList.toggle('off', !on);
    }
  }

  /** The career numbers, on the start screen. */
  setStats(save) {
    if (!this.statLines) return;
    this.statLines.innerHTML =
      `<span>Best combo <b>${save.best.toLocaleString()}</b></span>` +
      `<span>Best single trick <b>${save.bestTrick.toLocaleString()}</b></span>` +
      `<span>Tricks landed <b>${save.tricks.toLocaleString()}</b></span>` +
      `<span>Biggest air <b>${save.bestAir.toFixed(2)} m</b></span>` +
      `<span>Slams <b>${save.bails.toLocaleString()}</b></span>`;
  }
}
