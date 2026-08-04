// Everything that outlives a session: the best combo, a lifetime trick count, and
// the sound setting.
//
// localStorage throws outright in iOS private browsing, so every access is
// wrapped. Losing a high score is bad; crashing the game over one is worse.

const KEY = 'skate.save';

const DEFAULTS = {
  best: 0,
  bestTrick: 0,
  tricks: 0,
  bails: 0,
  bestAir: 0,
  sound: true,
  seenGuide: false,
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const s = { ...DEFAULTS, ...parsed };
    // A hand-edited or half-written record must not be able to break the game.
    for (const k of ['best', 'bestTrick', 'tricks', 'bails']) {
      s[k] = Math.max(0, Math.floor(Number(s[k]) || 0));
    }
    s.bestAir = Math.max(0, Number(s.bestAir) || 0);
    s.sound = s.sound !== false;
    s.seenGuide = s.seenGuide === true;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const state = read();

function flush() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* nothing to be done, and nothing worth telling the player about */
  }
}

export const save = {
  get best() {
    return state.best;
  },
  get bestTrick() {
    return state.bestTrick;
  },
  get tricks() {
    return state.tricks;
  },
  get bails() {
    return state.bails;
  },
  get bestAir() {
    return state.bestAir;
  },
  get sound() {
    return state.sound;
  },
  get seenGuide() {
    return state.seenGuide;
  },

  /** @returns true if this beat the previous best combo. */
  recordCombo(points) {
    const n = Math.floor(points);
    if (n <= state.best) return false;
    state.best = n;
    flush();
    return true;
  },

  recordTrick(points) {
    state.tricks++;
    if (points > state.bestTrick) state.bestTrick = Math.floor(points);
    flush();
  },

  recordBail() {
    state.bails++;
    flush();
  },

  recordAir(metres) {
    if (metres <= state.bestAir) return false;
    state.bestAir = Math.round(metres * 100) / 100;
    flush();
    return true;
  },

  setSound(on) {
    state.sound = !!on;
    flush();
  },

  markGuideSeen() {
    state.seenGuide = true;
    flush();
  },

  reset() {
    Object.assign(state, DEFAULTS);
    flush();
  },
};
