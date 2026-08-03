// Everything that outlives a run: the coin bank, which skins are owned, and
// the audio settings.
//
// localStorage throws outright in iOS private browsing, so every access is
// wrapped. Losing saved progress is bad; crashing the game over it is worse.

const KEY = 'templeRunner.save';
const HIGH_SCORE_KEY = 'templeRunner.highScore';

const DEFAULTS = {
  best: 0,
  coins: 0,
  owned: ['explorer'],
  skin: 'explorer',
  music: true,
  sfx: true,
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      // Carry over a high score written by a version that predated this file,
      // so an existing player does not appear to have lost it.
      const legacy = parseInt(localStorage.getItem(HIGH_SCORE_KEY), 10);
      return { ...DEFAULTS, best: Number.isFinite(legacy) ? legacy : 0 };
    }
    const parsed = JSON.parse(raw);
    const save = { ...DEFAULTS, ...parsed };
    // A hand-edited or partially written record should not be able to break
    // the game, so anything structural gets checked rather than trusted.
    if (!Array.isArray(save.owned) || !save.owned.length) save.owned = [...DEFAULTS.owned];
    if (!save.owned.includes('explorer')) save.owned.unshift('explorer');
    if (typeof save.skin !== 'string' || !save.owned.includes(save.skin)) save.skin = 'explorer';
    save.best = Math.max(0, Math.floor(Number(save.best) || 0));
    save.coins = Math.max(0, Math.floor(Number(save.coins) || 0));
    save.music = save.music !== false;
    save.sfx = save.sfx !== false;
    return save;
  } catch {
    return { ...DEFAULTS };
  }
}

const state = read();

function flush() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* nothing we can do, and nothing worth telling the player about */
  }
}

export const save = {
  get best() {
    return state.best;
  },
  get coins() {
    return state.coins;
  },
  get skin() {
    return state.skin;
  },
  get music() {
    return state.music;
  },
  get sfx() {
    return state.sfx;
  },

  owns(id) {
    return state.owned.includes(id);
  },

  /** @returns {boolean} true if this beat the previous best */
  recordScore(score) {
    const n = Math.floor(score);
    if (n <= state.best) return false;
    state.best = n;
    flush();
    return true;
  },

  addCoins(n) {
    if (n <= 0) return;
    state.coins += Math.floor(n);
    flush();
  },

  /** Buy and equip in one step — nobody buys a skin they do not want to wear. */
  buy(id, price) {
    if (state.owned.includes(id) || state.coins < price) return false;
    state.coins -= price;
    state.owned.push(id);
    state.skin = id;
    flush();
    return true;
  },

  equip(id) {
    if (!state.owned.includes(id)) return false;
    state.skin = id;
    flush();
    return true;
  },

  setMusic(on) {
    state.music = !!on;
    flush();
  },

  setSfx(on) {
    state.sfx = !!on;
    flush();
  },

  reset() {
    Object.assign(state, { ...DEFAULTS, owned: [...DEFAULTS.owned] });
    flush();
    try {
      localStorage.removeItem(HIGH_SCORE_KEY);
    } catch {
      /* ignore */
    }
  },
};
