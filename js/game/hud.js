// DOM overlay: score, menus, and the debug readout.
// Kept out of WebGL entirely — text is the one thing the DOM does better.

import { HIGH_SCORE_KEY } from './config.js';

// localStorage throws outright in iOS private browsing, so every access is
// wrapped. A lost high score is not worth a crashed game.
export function loadHighScore() {
  try {
    return parseInt(localStorage.getItem(HIGH_SCORE_KEY), 10) || 0;
  } catch {
    return 0;
  }
}

export function saveHighScore(value) {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(value));
  } catch {
    /* nothing we can do, and nothing worth telling the player about */
  }
}

export class Hud {
  constructor() {
    this.scoreEl = document.getElementById('score');
    this.coinsEl = document.getElementById('coins');
    this.bestEl = document.getElementById('best');
    this.debugEl = document.getElementById('debug');
    this.chaseEl = document.getElementById('chase');
    this.chaseBar = document.getElementById('chase-bar');
    this._chase = -1;

    this.overlay = document.getElementById('overlay');
    this.panelTitle = document.getElementById('panel-title');
    this.panelBody = document.getElementById('panel-body');
    this.panelAction = document.getElementById('panel-action');
    this.installBtn = document.getElementById('install');
    this.iosHint = document.getElementById('ios-hint');
    this.iosDismiss = document.getElementById('ios-dismiss');

    this._score = -1;
    this._coins = -1;
    this._best = -1;
  }

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

  showPanel(title, body, action) {
    this.panelTitle.textContent = title;
    this.panelBody.innerHTML = body;
    this.panelAction.textContent = action;
    this.overlay.hidden = false;
  }

  hidePanel() {
    this.overlay.hidden = true;
  }

  get panelVisible() {
    return !this.overlay.hidden;
  }

  setDebug(text) {
    if (this.debugEl.hidden) return;
    this.debugEl.textContent = text;
  }

  enableDebug() {
    this.debugEl.hidden = false;
  }
}
