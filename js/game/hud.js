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
