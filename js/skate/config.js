// Every tunable for the skate game, in real units: metres, seconds, radians,
// kilograms. No imports, so the Node harness in tools/ can read these too.
//
// The units are not a stylistic choice. The whole point of this build is that
// the skater moves like a skater, and the only way to keep a hundred separate
// numbers honest about that is to make each one a quantity you can check
// against the real thing: a 32-inch deck is 0.81 m, a 54 mm wheel is 0.027 m,
// gravity is 9.81 m/s², a good ollie clears about 0.6 m, and a pushing skater
// tops out around 6.5 m/s. When something feels wrong, it is nearly always
// because a number here has drifted away from its physical counterpart.

// --- the board ------------------------------------------------------------
export const DECK_LEN = 0.81;        // 32"
export const DECK_W = 0.205;         // 8.06"
export const DECK_T = 0.013;
export const WHEELBASE = 0.36;       // bolt-to-bolt, so the trucks sit at ±0.18
export const WHEEL_R = 0.027;        // 54 mm
export const WHEEL_W = 0.031;
export const TRUCK_H = 0.053;        // axle to deck underside
// Deck top above flat ground: wheel + truck + deck. Everything the rider
// stands on is measured from here.
export const DECK_Y = WHEEL_R + TRUCK_H + DECK_T;   // ≈ 0.093
export const NOSE_KICK = 0.35;       // radians of upturn at nose and tail
export const KICK_START = 0.145;     // where the kick begins, from centre

// --- the rider ------------------------------------------------------------
export const THIGH = 0.44;
export const SHIN = 0.44;
export const FOOT_H = 0.075;         // ankle to sole
export const FOOT_L = 0.27;
export const HIP_W = 0.095;          // half-distance between the hip joints
export const SPINE = 0.27;           // pelvis centre to chest centre
export const CHEST = 0.34;           // length of the torso block
export const SHOULDER_UP = 0.13;     // chest centre up to the shoulder joints
export const NECK = 0.33;            // chest centre to the middle of the head
export const SHOULDER_W = 0.185;     // half-distance between the shoulders
export const UPPER_ARM = 0.30;
export const FOREARM = 0.28;

// Stance: where each foot sits along the deck, measured from the centre in
// metres, and how far it is turned off the board's long axis in radians.
// A real ride stance has the back foot on the tail pocket, angled almost
// across the deck, and the front foot behind the front bolts at about 45°.
export const FOOT_BACK_Z = -0.235;
export const FOOT_FRONT_Z = 0.155;
export const FOOT_BACK_YAW = 1.15;
export const FOOT_FRONT_YAW = 0.72;
// Hip height above the deck when relaxed. Skaters ride with a permanent bend
// in the knees — standing straight is what a non-skater does on a board.
export const HIP_H = 0.80;
export const CROUCH_MAX = 0.30;      // how far the hips can drop from HIP_H

// --- world ----------------------------------------------------------------
export const GRAVITY = -9.81;
export const AIR_DRAG = 0.013;       // per (m/s)², on the whole rider+board mass

// --- rolling --------------------------------------------------------------
// Coasting deceleration: bearing and urethane losses are near-constant, air
// resistance grows with the square. Eased off a notch from a real board's
// numbers — this is a game, and a run that bleeds speed as fast as the real
// thing spends too much of it pushing rather than skating.
export const ROLL_FRICTION = 0.10;   // m/s², constant term
export const ROLL_DRAG = 0.0075;     // m/s² per (m/s)²
export const ROUGH_FRICTION = 1.9;   // m/s² extra on grass/dirt outside the park

// --- pushing --------------------------------------------------------------
export const PUSH_TIME = 0.56;       // one full push cycle, foot down to foot back
export const PUSH_KICK_START = 0.16; // when in the cycle the foot is driving
export const PUSH_KICK_END = 0.42;
export const PUSH_IMPULSE = 7.8;     // m/s² while driving
export const PUSH_TOP_SPEED = 8.6;   // pushes stop helping here — legs run out
export const PUSH_MIN_INTERVAL = 0.30;

// How much of a lean the deck itself takes. A skateboard's trucks only tilt
// ten or fifteen degrees before the bushings bottom out and the wheels touch —
// the other three quarters of a hard carve is the rider's body hanging off the
// inside of the turn, which is why a carving skater looks like they are falling
// and a carving board looks nearly flat.
export const DECK_TILT_SHARE = 0.26;

// --- steering -------------------------------------------------------------
// Turning is a balance problem, not a steering-wheel problem. Leaning the board
// by θ commits the rider to a lateral acceleration of g·tanθ, and the radius
// that follows is whatever the current speed makes it: r = v²/(g·tanθ). That
// single relation is why a skateboard carves wide at speed and pivots on the
// spot when it is barely moving.
export const LEAN_MAX = 0.52;        // radians (30°) — past this the wheels lose it
export const LEAN_RATE = 6.4;        // how fast weight shifts, rad/s
export const TURN_R_MIN = 0.95;      // truck geometry floor on the radius, metres
export const YAW_RATE_MAX = 4.2;     // rad/s, the low-speed pivot ceiling
export const CARVE_SCRUB = 0.085;    // speed lost to tyre scrub, per m/s² of lateral
export const GRAVITY_STEER = 0.32;   // how strongly a cross-slope turns you downhill

// --- powerslide -----------------------------------------------------------
export const SLIDE_FRICTION = 7.2;   // m/s² of scrub while sideways
export const SLIDE_YAW_RATE = 5.0;   // how fast the board swings out
export const SLIDE_MIN_SPEED = 2.4;  // below this it just grips and stops

// --- ollies and pops ------------------------------------------------------
// Pop height is set by how deep the crouch was, and the launch speed follows
// from it exactly: v = sqrt(2·g·h). A 0.60 m ollie is 3.43 m/s and 0.70 s of
// air, which is what a real one looks like on video.
export const OLLIE_H_MIN = 0.24;
export const OLLIE_H_MAX = 0.68;
export const CHARGE_TIME = 0.42;     // crouch to full load
export const CHARGE_DECAY = 1.4;     // hold too long and the legs tire, 1/s
// The pop itself, as a timeline in seconds from the tail snapping down.
export const POP_SNAP = 0.075;       // tail hits, board pitches nose-up hard
export const POP_LEVEL = 0.20;       // front foot has dragged the board level
export const POP_PITCH = 0.62;       // radians of nose-up at the snap

// --- landing --------------------------------------------------------------
// What the board will forgive. Beyond the sketchy band it is a bail, which is
// the whole reason a trick has stakes.
export const LAND_ROLL_CLEAN = 0.30; // radians of board roll off the surface
export const LAND_PITCH_OK = 0.55;   // nose- or tail-first beyond this digs in
export const LAND_SLIP_CLEAN = 0.45; // radians between heading and velocity
export const LAND_SLIP_SKETCH = 1.0;
export const LAND_FLIP_OK = 0.55;    // radians short of finishing a flip
export const LAND_VY_BAIL = 9.4;     // ~4.5 m drop; the legs stop absorbing
export const LAND_COMPRESS = 0.055;  // metres of knee dip per m/s of impact
export const COMPRESS_RECOVER = 7.0; // spring rate back to the ride stance
export const SKETCH_SPEED_LOSS = 0.68;
export const SKETCH_TIME = 0.55;     // how long the wobble lasts

// --- grinds ---------------------------------------------------------------
export const GRIND_SNAP_XZ = 0.34;   // how close the board must pass the rail
export const GRIND_SNAP_Y = 0.30;    // vertical window, generous on the way down
// How far off a rail's line the board can be pointing and still lock on. A
// boardslide comes in nearly sideways, so it needs a far wider window than the
// angle a 50-50 accepts — and the angle it locks on at is what decides which
// grind it turns out to be.
export const GRIND_ALIGN = 1.42;
export const GRIND_FRICTION = 1.35;  // m/s² of speed scrubbed while grinding
export const SLIDE_GRIND_FRICTION = 2.6; // boardslides scrub harder than 50-50s
export const GRIND_POINTS_PER_M = 12;

// --- balance (grinds and manuals) ----------------------------------------
// A balance meter is not decoration here: it is an inverted pendulum with a
// bias, so it always falls somewhere and holding it needs constant correction.
export const BALANCE_FALL = 2.6;     // rad/s² away from centre, per rad of tilt
export const BALANCE_CORRECT = 3.4;  // rad/s² the rider can apply
export const BALANCE_LIMIT = 1.0;    // past this the trick is lost
export const BALANCE_DAMP = 1.5;
export const MANUAL_PITCH = 0.30;    // radians of nose-up in a manual
export const MANUAL_POINTS_PER_M = 7;

// --- flips and spins ------------------------------------------------------
// Flip speeds are what the foot can actually impart: a kickflip is one full
// revolution in about 0.34 s, a tre flip needs the same flick plus a scoop.
export const FLIP_RATE = 18.5;       // rad/s about the board's long axis
export const SHUV_RATE = 15.0;       // rad/s about vertical
export const PITCH_RATE = 13.0;      // rad/s end over end, for impossibles
export const SPIN_RATE = 7.4;        // rad/s of rider body spin

// --- bail -----------------------------------------------------------------
export const BAIL_SETTLE = 1.5;      // seconds of ragdoll before the reset offer

// --- scoring --------------------------------------------------------------
export const COMBO_WINDOW = 1.35;    // seconds on the ground before a combo banks

// --- camera ---------------------------------------------------------------
export const CAM_DIST = 4.0;
export const CAM_HEIGHT = 1.32;      // low, like the game it is copying
export const CAM_LOOK_H = 1.05;
export const CAM_LAG = 3.4;          // position spring, 1/s
export const CAM_YAW_LAG = 2.9;      // heading spring, 1/s
export const CAM_FOV = 62;
export const CAM_FOV_GAIN = 13;      // widens with speed
export const CAM_SPEED_REF = 9.0;    // m/s that counts as flat out

// --- rendering ------------------------------------------------------------
export const SKY_TOP = 0x2f6ba8;
export const SKY_HORIZON = 0xd8d3c4;
export const FOG_NEAR = 46;
export const FOG_FAR = 150;
export const CAMERA_NEAR = 0.08;
export const CAMERA_FAR = 220;

// --- loop -----------------------------------------------------------------
// 120 Hz, not 60. Every hard case in here — the tail snapping in an ollie, a
// wheel catching a rail edge, a flip landing — resolves inside a couple of
// hundredths of a second, and at 60 Hz those land on the wrong side of a step
// often enough to be visible as luck.
export const FIXED_DT = 1 / 120;
export const MAX_FRAME_DT = 0.05;


/** Frame-rate independent exponential approach: how far to move this step. */
export function ease(dt, rate) {
  return 1 - Math.exp(-rate * dt);
}

/** Shortest signed angle from a to b. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
