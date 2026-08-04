// The DOM overlay: readouts, trick call-outs, the balance meter, and the menus.
//
// Kept out of WebGL entirely. Text, buttons and lists are what the DOM is good at,
// and a menu made of real elements gets focus rings, tap targets and text scaling
// for nothing.

const SCREENS = ['start', 'paused', 'guide', 'parks', 'bail'];

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

/**
 * The tutorial, one move per step. Every step names its keyboard, touch and
 * gamepad input so the same walkthrough works whichever the player showed up
 * with — nobody is told to go check a different section for their device.
 */
const TUTORIAL = [
  {
    title: 'Move & steer',
    body: 'Turning is a lean, not a wheel: at speed you carve wide, and at walking pace you can pivot on the spot.',
    keys: 'A / D  or  ← / →',
    touch: 'Left half — drag to steer',
    pad: 'Left stick',
  },
  {
    title: 'Push',
    body: 'Builds your speed. Push again the moment one cycle ends to keep it climbing — legs only move so fast, so there is a ceiling.',
    keys: 'W',
    touch: 'Left half — slide down',
    pad: 'A  or  right trigger',
  },
  {
    title: 'Charge & ollie',
    body: 'Pull back to load your legs, then let go straight up. How far you pulled is how much pop you get.',
    keys: 'Space — hold, then release',
    touch: 'Right half — pull down, then flick up',
    pad: 'Right stick — pull down, then flick up',
  },
  {
    title: 'Kickflip & heelflip',
    body: 'Flick up and across the board. The toe side spins a kickflip, the heel side a heelflip.',
    keys: 'J  kickflip · K  heelflip',
    touch: 'Flick up-left / up-right',
    pad: 'Flick up-left / up-right',
  },
  {
    title: 'Shove-its',
    body: 'Flick straight sideways and the board spins out flat underneath you, no flip at all.',
    keys: 'U  pop shuv · I  frontside shuv',
    touch: 'Flick left / right',
    pad: 'Flick left / right',
  },
  {
    title: '360s, and combinations',
    body: 'A quarter circle — down, then round to the side, then up — scoops the board a full turn. Add a flip on top for a tre flip or a hardflip.',
    keys: 'O  360 shuv · N  varial · M  tre flip · ,  hardflip · .  impossible',
    touch: 'Quarter-circle flick',
    pad: 'Quarter-circle flick',
  },
  {
    title: 'Grinds',
    body: 'Ollie onto a rail or a ledge and the board locks on. It always wants to fall one way — hold the balance until you roll off the end.',
    keys: 'Steer to correct the balance',
    touch: 'Drag the steering side to correct',
    pad: 'Left stick to correct',
  },
  {
    title: 'Manuals',
    body: 'Hold the charge without ever flicking it, and your legs give out into a nose-up manual. Let go to drop it back down.',
    keys: 'Hold Space',
    touch: 'Hold the pull, do not flick',
    pad: 'Hold the pull, do not flick',
  },
  {
    title: 'Powerslide',
    body: 'Kicks the board sideways at speed, scrubbing it off fast — useful before a tight landing, or just for style.',
    keys: 'Shift',
    touch: 'Two-finger hold',
    pad: 'Shoulder buttons',
  },
  {
    title: 'Land it — or don’t',
    body: 'The board has to be level, pointing roughly where it is going, and finished with whatever it started. Miss any of that and it is a slam — get up and roll again.',
    keys: '',
    touch: '',
    pad: '',
  },
];

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
    this.logosEl = document.getElementById('logos-readout');
    this.logosCount = document.getElementById('logos-count');

    this.overlay = document.getElementById('overlay');
    this.screens = {};
    for (const n of SCREENS) this.screens[n] = document.getElementById(`screen-${n}`);
    this.bailWhy = document.getElementById('bail-why');
    this.soundBtn = document.getElementById('opt-sound');
    this.statLines = document.getElementById('stat-lines');
    this.parkNow = document.getElementById('park-now');
    this.parkGrid = document.getElementById('park-grid');

    this.tutTitle = document.getElementById('tut-title');
    this.tutBody = document.getElementById('tut-body');
    this.tutKeys = document.getElementById('tut-keys');
    this.tutTouch = document.getElementById('tut-touch');
    this.tutPad = document.getElementById('tut-pad');
    this.tutDots = document.getElementById('tut-dots');
    this.tutPrev = document.getElementById('btn-tut-prev');
    this.tutNext = document.getElementById('btn-tut-next');
    this.tutStep = 0;

    this.on = {
      play: null,
      resume: null,
      retry: null,
      guide: null,
      back: null,
      sound: null,
      reset: null,
      parks: null,
      selectPark: null,
    };
    this._score = -1;
    this._best = -1;
    this.calloutTimer = 0;
    this.bind();
    this.buildTutDots();
  }

  bind() {
    const click = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    click('btn-play', () => this.on.play?.());
    click('btn-guide', () => this.on.guide?.());
    click('btn-guide-back', () => this.on.back?.());
    click('btn-parks', () => this.on.parks?.());
    click('btn-parks-back', () => this.on.back?.());
    click('btn-resume', () => this.on.resume?.());
    click('btn-pause-menu', () => this.on.back?.());
    click('btn-bail-menu', () => this.on.back?.());
    click('btn-retry', () => this.on.retry?.());
    click('opt-sound', () => this.on.sound?.());
    click('opt-reset', () => this.on.reset?.());
    click('btn-tut-prev', () => this.showTutStep(this.tutStep - 1));
    click('btn-tut-next', () => {
      if (this.tutStep >= TUTORIAL.length - 1) this.on.play?.();
      else this.showTutStep(this.tutStep + 1);
    });
    this.parkGrid?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-park]');
      if (card) this.on.selectPark?.(card.dataset.park);
    });
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

  /** How many of this park's six logos are in, so far this run. */
  setLogos(count, total) {
    if (!this.logosEl) return;
    this.logosEl.hidden = false;
    const key = `${count}/${total}`;
    if (key === this._logosKey) return;
    this._logosKey = key;
    this.logosCount.textContent = key;
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
    if (name === 'guide') this.showTutStep(0);
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
      `<span>Logos found <b>${save.logos.toLocaleString()}</b></span>` +
      `<span>Slams <b>${save.bails.toLocaleString()}</b></span>`;
  }

  /** Which park is loaded, named on the start screen. */
  setCurrentPark(name) {
    if (this.parkNow) this.parkNow.textContent = `Skating: ${name}`;
  }

  // --- park picker ---------------------------------------------------------
  /** Build the choice of maps, once — `parks` is the PARKS array from park.js. */
  renderParks(parks, currentId) {
    if (!this.parkGrid) return;
    this.parkGrid.innerHTML = parks
      .map(
        (p) =>
          `<button type="button" class="park-card${p.id === currentId ? ' current' : ''}" data-park="${p.id}">` +
          `<b>${p.name}</b><span>${p.blurb}</span></button>`
      )
      .join('');
  }

  // --- tutorial --------------------------------------------------------------
  buildTutDots() {
    if (!this.tutDots) return;
    this.tutDots.innerHTML = TUTORIAL.map(() => '<i></i>').join('');
    this.tutDotEls = [...this.tutDots.children];
  }

  showTutStep(i) {
    const n = TUTORIAL.length;
    this.tutStep = Math.max(0, Math.min(n - 1, i));
    const step = TUTORIAL[this.tutStep];
    if (this.tutTitle) this.tutTitle.textContent = step.title;
    if (this.tutBody) this.tutBody.textContent = step.body;
    if (this.tutKeys) this.tutKeys.textContent = step.keys;
    if (this.tutTouch) this.tutTouch.textContent = step.touch;
    if (this.tutPad) this.tutPad.textContent = step.pad;
    this.tutDotEls?.forEach((el, idx) => el.classList.toggle('on', idx === this.tutStep));
    if (this.tutPrev) this.tutPrev.disabled = this.tutStep === 0;
    if (this.tutNext) this.tutNext.textContent = this.tutStep === n - 1 ? "Let's ride" : 'Next';
  }
}
