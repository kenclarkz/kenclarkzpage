// DOM overlay: the in-run readouts, and the home / store / options screens.
//
// Kept out of WebGL entirely — text, buttons and scrolling lists are the things
// the DOM does better, and a menu that is real DOM is a menu that gets focus
// rings, tap targets and text scaling for free.

import { SKINS } from './skins.js';

const SCREENS = ['home', 'store', 'options', 'paused', 'result'];

export class Hud {
  constructor() {
    this.scoreEl = document.getElementById('score');
    this.coinsEl = document.getElementById('coins');
    this.bestEl = document.getElementById('best');
    this.debugEl = document.getElementById('debug');
    this.statsEl = document.getElementById('stats');
    this.chaseEl = document.getElementById('chase');
    this.chaseBar = document.getElementById('chase-bar');

    this.overlay = document.getElementById('overlay');
    this.screens = {};
    for (const name of SCREENS) this.screens[name] = document.getElementById(`screen-${name}`);

    this.bankEls = Array.from(document.querySelectorAll('.bank-value'));
    this.storeList = document.getElementById('store-list');
    this.avatarEl = document.getElementById('avatar');
    this.profileName = document.getElementById('profile-name');
    this.profileBest = document.getElementById('profile-best');
    this.resultTitle = document.getElementById('result-title');
    this.resultBody = document.getElementById('result-body');

    this.installBtn = document.getElementById('install');
    this.iosHint = document.getElementById('ios-hint');
    this.iosDismiss = document.getElementById('ios-dismiss');

    this._score = -1;
    this._coins = -1;
    this._best = -1;
    this._chase = -1;
    this.current = null;

    /** Wired by main.js. */
    this.on = {
      play: null,
      store: null,
      options: null,
      home: null,
      resume: null,
      pick: null,
      toggleMusic: null,
      toggleSfx: null,
      reset: null,
    };

    this.bindButtons();
  }

  bindButtons() {
    const click = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    click('btn-play', () => this.on.play?.());
    click('btn-store', () => this.on.store?.());
    click('btn-options', () => this.on.options?.());
    click('btn-store-back', () => this.on.home?.());
    click('btn-options-back', () => this.on.home?.());
    click('btn-resume', () => this.on.resume?.());
    click('btn-quit', () => this.on.home?.());
    click('btn-again', () => this.on.play?.());
    click('btn-result-home', () => this.on.home?.());

    this.musicBtn = document.getElementById('opt-music');
    this.sfxBtn = document.getElementById('opt-sfx');
    this.resetBtn = document.getElementById('opt-reset');
    this.musicBtn?.addEventListener('click', () => this.on.toggleMusic?.());
    this.sfxBtn?.addEventListener('click', () => this.on.toggleSfx?.());

    // Wiping progress is the one irreversible thing in here, so it takes two
    // taps and says so in between.
    this.resetArmed = false;
    this.resetBtn?.addEventListener('click', () => {
      if (!this.resetArmed) {
        this.resetArmed = true;
        this.resetBtn.textContent = 'Tap again to erase everything';
        this.resetBtn.classList.add('danger');
        clearTimeout(this._resetTimer);
        this._resetTimer = setTimeout(() => this.disarmReset(), 4000);
        return;
      }
      this.disarmReset();
      this.on.reset?.();
    });
  }

  disarmReset() {
    this.resetArmed = false;
    clearTimeout(this._resetTimer);
    if (this.resetBtn) {
      this.resetBtn.textContent = 'Reset progress';
      this.resetBtn.classList.remove('danger');
    }
  }

  // --- in-run readouts ----------------------------------------------------

  setScore(v) {
    const n = Math.floor(v);
    if (n === this._score) return;
    this._score = n;
    this.scoreEl.textContent = n.toLocaleString();
  }

  setCoins(v) {
    if (v === this._coins) return;
    this._coins = v;
    this.coinsEl.textContent = v;
  }

  setBest(v) {
    const n = Math.floor(v);
    if (n === this._best) return;
    this._best = n;
    this.bestEl.textContent = n.toLocaleString();
  }

  /** The banked coin total, shown on the home and store screens. */
  setBank(v) {
    for (const el of this.bankEls) el.textContent = Math.floor(v).toLocaleString();
  }

  /**
   * The home screen's profile card: who you are wearing, and your best run.
   * The avatar is built from the equipped skin's own palette rather than from
   * a set of pictures, so a new skin needs no new art here.
   */
  setProfile(skin, best) {
    if (this.profileName) this.profileName.textContent = skin.name;
    if (this.profileBest) this.profileBest.textContent = Math.floor(best).toLocaleString();
    if (!this.avatarEl) return;

    const hex = (v) => `#${v.toString(16).padStart(6, '0')}`;
    const p = skin.palette;
    this.avatarEl.textContent = '';
    this.avatarEl.style.background = hex(p.skin);
    for (const cls of ['av-hair', 'av-band', 'av-eye l', 'av-eye r']) {
      const el = document.createElement('i');
      el.className = cls;
      el.style.background = hex(cls === 'av-hair' ? p.hair : cls === 'av-band' ? p.gold : p.dark);
      this.avatarEl.appendChild(el);
    }
  }

  /**
   * How much of the chase window is left, 0..1. Drives both the depleting bar
   * and the red edge glow — without some readout the ten seconds are invisible,
   * and the rule stops being something the player can actually play around.
   */
  setChase(t) {
    const v = Math.max(0, Math.min(1, t));
    // The 0 and 1 ends always go through: they are what show and hide the
    // warning, and skipping one on a rounding coincidence would strand it
    // on screen for the rest of the run.
    if (v > 0 && Math.abs(v - this._chase) < 0.005) return;
    if (v === this._chase) return;
    const wasOn = this._chase > 0;
    this._chase = v;
    if (v > 0) {
      if (!wasOn) this.chaseEl.hidden = false;
      this.chaseBar.style.transform = `scaleX(${v})`;
    } else if (wasOn) {
      this.chaseEl.hidden = true;
    }
  }

  setDebug(text) {
    if (this.debugEl.hidden) return;
    this.debugEl.textContent = text;
  }

  enableDebug() {
    this.debugEl.hidden = false;
  }

  // --- screens ------------------------------------------------------------

  show(name) {
    for (const key of SCREENS) this.screens[key].hidden = key !== name;
    this.overlay.hidden = false;
    this.current = name;
    // The run readouts mean nothing on a menu, and a stale "0 0 0" sitting
    // above the home screen just looks unfinished.
    this.statsEl.hidden = true;
    if (name !== 'options') this.disarmReset();
  }

  hide() {
    this.overlay.hidden = true;
    this.statsEl.hidden = false;
    this.current = null;
  }

  get visible() {
    return !this.overlay.hidden;
  }

  showResult(title, score, coins, best, isBest) {
    this.resultTitle.textContent = title;
    this.resultBody.innerHTML =
      `<p class="big">${Math.floor(score).toLocaleString()}</p>` +
      `<p class="sub">${coins} coins collected &middot; best ${Math.floor(best).toLocaleString()}</p>` +
      (isBest ? '<p class="flag">New best</p>' : '');
    this.show('result');
  }

  // --- store --------------------------------------------------------------

  /**
   * Rebuild the skin list. Called on open and after any purchase, so the whole
   * list is regenerated rather than patched — five rows of DOM is far cheaper
   * than the bugs that come from keeping two representations in step.
   */
  renderStore(save) {
    if (!this.storeList) return;
    this.storeList.textContent = '';

    for (const skin of SKINS) {
      const owned = save.owns(skin.id);
      const equipped = save.skin === skin.id;
      const afford = save.coins >= skin.price;

      const row = document.createElement('div');
      row.className = `skin${equipped ? ' equipped' : ''}`;

      const dots = document.createElement('div');
      dots.className = 'swatch';
      for (const key of skin.swatch) {
        const dot = document.createElement('span');
        dot.style.background = `#${skin.palette[key].toString(16).padStart(6, '0')}`;
        dots.appendChild(dot);
      }
      row.appendChild(dots);

      const meta = document.createElement('div');
      meta.className = 'skin-meta';
      const name = document.createElement('strong');
      name.textContent = skin.name;
      const status = document.createElement('span');
      status.textContent = equipped ? 'Equipped' : owned ? 'Owned' : `${skin.price.toLocaleString()} coins`;
      meta.append(name, status);
      row.appendChild(meta);

      const btn = document.createElement('button');
      btn.type = 'button';
      if (equipped) {
        btn.textContent = 'Worn';
        btn.disabled = true;
      } else if (owned) {
        btn.textContent = 'Wear';
        btn.className = 'wear';
      } else {
        btn.textContent = 'Buy';
        btn.disabled = !afford;
        if (afford) btn.className = 'buy';
      }
      btn.addEventListener('click', () => this.on.pick?.(skin.id));
      row.appendChild(btn);

      this.storeList.appendChild(row);
    }
  }

  setOptions(music, sfx) {
    if (this.musicBtn) {
      this.musicBtn.textContent = `Music: ${music ? 'On' : 'Off'}`;
      this.musicBtn.classList.toggle('off', !music);
    }
    if (this.sfxBtn) {
      this.sfxBtn.textContent = `Sound effects: ${sfx ? 'On' : 'Off'}`;
      this.sfxBtn.classList.toggle('off', !sfx);
    }
  }
}
