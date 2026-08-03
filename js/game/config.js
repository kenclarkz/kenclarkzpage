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
export const SPEED_0 = 11;          // m/s at the start
export const SPEED_MAX = 26;
export const SPEED_RAMP = 0.0025;   // m/s gained per metre travelled

// --- player physics -------------------------------------------------------
export const GRAVITY = -21;
export const JUMP_VY = 7.2;
export const FAST_FALL_VY = -16;
export const SLIDE_TIME = 0.62;
export const LATERAL_EASE = 13;     // higher = snappier lane changes
export const PLAYER_HALF_W = 0.42;  // collider half-width

// --- streaming ------------------------------------------------------------
export const SPAWN_AHEAD = 100;     // must exceed FOG_FAR
export const RETIRE_BEHIND = 25;

// --- rendering ------------------------------------------------------------
export const FOG_COLOR = 0x0b0e14;
export const FOG_NEAR = 26;
export const FOG_FAR = 78;
export const CAMERA_FAR = 95;
export const CAMERA_NEAR = 0.1;
// A phone in portrait is ~0.46 aspect, so the *horizontal* field of view is
// much narrower than this number suggests. 72 vertical is about 37 horizontal,
// which is the minimum that shows enough of a corner to react to it.
export const FOV_BASE = 72;
export const FOV_SPEED_GAIN = 11;

// --- pools ----------------------------------------------------------------
export const MAX_STRAIGHT_CHUNKS = 10;
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
