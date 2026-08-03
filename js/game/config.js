// Every gameplay tunable lives here, so balancing never means touching the
// systems that read them. No imports — this file is loaded by the browser and
// by the Node test harness in tools/.

// --- track geometry -------------------------------------------------------
export const LANE_W = 1.6;          // metres between lane centres
export const HALF_W = 2.8;          // corridor half-width (floor edge)
export const WALL_T = 0.5;
// Tall enough that the corridor, not the empty sky above it, fills the frame.
export const WALL_H = 4.6;
export const FLOOR_T = 0.6;

export const SEGMENT_LEN = 20;      // metres of track per straight chunk
export const ARC_RADIUS = 6.0;      // 90-degree corner radius

// --- pacing ---------------------------------------------------------------
export const SPEED_0 = 15;          // m/s at the start
export const SPEED_MAX = 34;
export const SPEED_RAMP = 0.0034;   // m/s gained per metre travelled; caps ~5.6 km

// --- player physics -------------------------------------------------------
// Gravity and jump velocity rise together with the running speed: a floatier
// jump at 34 m/s would carry the runner most of a corridor section.
export const GRAVITY = -26;
export const JUMP_VY = 8.4;         // apex ~1.36 m, airborne ~0.65 s
export const FAST_FALL_VY = -20;
export const SLIDE_TIME = 0.55;
export const LATERAL_EASE = 17;     // higher = snappier lane changes
export const PLAYER_HALF_W = 0.42;  // collider half-width

// --- the chase ------------------------------------------------------------
// Hitting something does not end the run: it puts the guardian on your heels.
// Survive CHASE_SECONDS without hitting anything else and you pull away; hit
// something while it is still back there and it has you.
export const CHASE_SECONDS = 10;
export const CHASE_RECEDE = 1.3;    // seconds it takes to drop out of sight
export const POUNCE_TIME = 0.55;    // the catch animation, before the panel
export const STUMBLE_TIME = 0.5;    // how long a glancing hit costs you
export const STUMBLE_SPEED = 0.62;  // speed multiplier while stumbling

// --- streaming ------------------------------------------------------------
export const SPAWN_AHEAD = 135;     // must exceed FOG_FAR
export const RETIRE_BEHIND = 25;

// --- rendering ------------------------------------------------------------
// Warm dusty haze, not darkness. Distance is conveyed by air rather than by
// gloom, which keeps obstacles readable at the far end of the corridor — and at
// 34 m/s, seeing them at the far end is the whole game. The sky gradient ends
// on exactly this colour so the horizon has no seam.
export const FOG_COLOR = 0x6d5340;
export const FOG_NEAR = 45;
// Draw distance is reaction time. At the 34 m/s top speed this is a little
// over three seconds of warning, which is what keeps the faster pacing fair.
export const FOG_FAR = 115;
export const CAMERA_FAR = 140;
export const CAMERA_NEAR = 0.1;
// A phone in portrait is ~0.46 aspect, so the *horizontal* field of view is
// much narrower than this number suggests. 72 vertical is about 37 horizontal,
// which is the minimum that shows enough of a corner to react to it.
export const FOV_BASE = 72;
export const FOV_SPEED_GAIN = 16;   // widens with speed; sells the pace

// --- pools ----------------------------------------------------------------
// Must cover (SPAWN_AHEAD + RETIRE_BEHIND) / SEGMENT_LEN, with headroom.
export const MAX_STRAIGHT_CHUNKS = 14;
export const MAX_CORNER_CHUNKS = 3;   // per direction
export const MAX_COINS = 240;
export const MAX_OBSTACLES = 48;      // per obstacle kind
export const MAX_PILLARS = 48;

// --- loop -----------------------------------------------------------------
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.05;   // clamp so a backgrounded tab can't teleport you

// --- scoring --------------------------------------------------------------
export const COIN_VALUE = 10;
export const POINTS_PER_METRE = 1;
export const HIGH_SCORE_KEY = 'templeRunner.highScore';

// mulberry32 — small, fast, and seedable, which is what makes the Playwright
// runs reproducible.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
