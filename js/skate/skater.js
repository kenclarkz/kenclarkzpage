// The rider: an articulated figure posed entirely from physics state.
//
// There is no animation data anywhere in this file. Every frame the ride model
// hands over a state object — how deep the crouch is, how far the board is
// leaned, where in a push cycle the back foot is, how much of a flip has gone by
// — and this module solves a pose from it. That is the only way the movement can
// stay honest: a canned run cycle looks right at one speed and wrong at every
// other, and a canned ollie plays at the same rate whether the skater popped one
// foot off the flat or cleared a handrail.
//
// Two ideas do most of the work.
//
// Everything happens in *frame space*. The frame is the board's contact patch:
// its origin is where the wheels touch, +Z is where the board is going, +Y is
// the surface normal. Posing the rider there makes the stance a pair of
// constants, makes riding a steep transition need no special case at all, and
// reduces the difference between rider and board during a flip to the board's own
// local rotation. A skater on a transition really is stood square to the ramp
// rather than to the world, and this frame gives that for free.
//
// The legs are solved with inverse kinematics rather than driven by joint angles.
// The feet are pinned to the deck and the hips are placed by the crouch, so the
// knees have no say in where they go — which means every knee bend in the game is
// the consequence of something physical: a deeper charge, a steeper ramp, the
// compression of a landing, a foot reaching for the ground on a push.

import * as THREE from '../game/three.js';
import { box, merge } from '../game/geo.js';
import * as C from './config.js';

export const PALETTE = {
  skin: 0xc9a07c,
  hair: 0x2a2016,
  cap: 0x2f3b52,
  shirt: 0xdcdcd6,
  sleeve: 0x9aa4b4,
  pants: 0x3d4658,
  pantsDark: 0x333b4b,
  shoe: 0xe8e6df,
  sole: 0xb8b4a8,
  band: 0x27282c,
};

// --- scratch --------------------------------------------------------------
// Posing runs 120 times a second and touches a few dozen vectors, so all of them
// live here: an allocation in this file is an allocation in the whole game.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qDeck = new THREE.Quaternion();
const _qChest = new THREE.Quaternion();
const _eul = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Point a bone from `from` to `to`.
 *
 * The bone's geometry runs up its own +Y, so the rotation is built as an
 * explicit basis: +Y onto the bone's direction, +X onto whatever survives of the
 * twist reference. Building the basis rather than reaching for
 * setFromUnitVectors is what stops a limb spinning about its own length as it
 * passes through vertical, and a shin twisting on the way through straight is
 * the most obvious tell that a rig is being driven badly.
 */
function bone(obj, from, to, twistRef) {
  _y.subVectors(to, from);
  const len = _y.length();
  if (len < 1e-6) return;
  _y.multiplyScalar(1 / len);
  _x.crossVectors(twistRef, _y);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  else _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(from).addScaledVector(_y, len / 2);
}

/** A right-handed basis with +Z along `zDir` and +Y as close to `upHint`. */
function basis(obj, zDir, upHint) {
  _z.copy(zDir).normalize();
  _x.crossVectors(upHint, _z);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  else _x.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
}

/**
 * Two-bone inverse kinematics: where does the joint between them sit?
 *
 * The knee (or elbow) is somewhere on a circle around the hip-to-foot line, and
 * `pole` picks which point on it — the direction the joint should break towards.
 * Get the pole wrong and the knee bends backwards, which is why it is an
 * explicit argument at every call site instead of a default.
 */
function solveJoint(root, target, a, b, pole, out) {
  _u.subVectors(target, root);
  let d = _u.length();
  // Clamped just inside full extension: at exactly a + b the limb is straight,
  // the pole stops meaning anything, and the joint snaps flat.
  const min = Math.abs(a - b) + 1e-3;
  const max = a + b - 1e-3;
  if (d < min) d = min;
  else if (d > max) d = max;
  if (_u.lengthSq() < 1e-9) _u.set(0, -1, 0);
  else _u.normalize();

  const x = (d * d + a * a - b * b) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  _p.copy(pole).addScaledVector(_u, -pole.dot(_u)); // the pole, off the limb axis
  if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1).addScaledVector(_u, -_u.z);
  _p.normalize();
  return out.copy(root).addScaledVector(_u, x).addScaledVector(_p, h);
}

/** Exponential approach towards a target, in one dimension. */
class Spring {
  constructor(value = 0, rate = 12) {
    this.v = value;
    this.rate = rate;
  }

  step(dt, target, rate = this.rate) {
    this.v += (target - this.v) * (1 - Math.exp(-rate * dt));
    return this.v;
  }
}

/**
 * A spring with momentum, for anything that should overshoot.
 *
 * Arms and hands are not servos. A skater's arms lag behind a change of
 * direction and swing past it before settling, and that overshoot is most of
 * what separates a figure that looks weighted from one that looks pinned.
 */
class Spring3 {
  constructor(stiffness = 150, damping = 17) {
    this.p = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.k = stiffness;
    this.c = damping;
  }

  step(dt, target) {
    // Semi-implicit Euler: stable at these stiffnesses, and it is one line.
    _s3.subVectors(target, this.p).multiplyScalar(this.k).addScaledVector(this.v, -this.c);
    this.v.addScaledVector(_s3, dt);
    this.p.addScaledVector(this.v, dt);
    return this.p;
  }

  set(target) {
    this.p.copy(target);
    this.v.set(0, 0, 0);
  }
}

// --- geometry -------------------------------------------------------------
/** A limb segment, built centred on the origin and running up its own +Y. */
function segment(color, w, len, d, taper = 1) {
  const parts = [];
  const n = 3;
  // Three stacked boxes buy a taper for the price of one draw call, and that
  // matters more on a thigh than it sounds: an untapered block reads as a robot
  // however well it is animated.
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const s = 1 + (taper - 1) * t;
    parts.push(box(color, w * s, len / n + 0.005, d * s, 0, -len / 2 + (len * (i + 0.5)) / n, 0));
  }
  return merge(parts, 6);
}

function buildGeometries(p) {
  return {
    pelvis: merge(
      [
        box(p.pants, C.HIP_W * 2 + 0.10, 0.155, 0.18, 0, 0, 0),
        box(p.band, C.HIP_W * 2 + 0.105, 0.032, 0.186, 0, 0.072, 0), // belt
      ],
      6
    ),
    // The torso is one piece from the waist to the neck: a chest block, a
    // shoulder yoke and two sleeves. Its origin is its middle, and +Z is the
    // direction the rider faces.
    chest: merge(
      [
        box(p.shirt, 0.30, C.CHEST, 0.21, 0, 0, 0),
        box(p.shirt, C.SHOULDER_W * 2, 0.12, 0.2, 0, C.SHOULDER_UP, 0),
        box(p.sleeve, 0.1, 0.12, 0.15, C.SHOULDER_W, C.SHOULDER_UP - 0.03, 0),
        box(p.sleeve, 0.1, 0.12, 0.15, -C.SHOULDER_W, C.SHOULDER_UP - 0.03, 0),
        box(p.shirt, 0.25, 0.1, 0.195, 0, -C.CHEST / 2 + 0.04, 0), // waist, narrower
        // A neck. Without one there is a visible gap between collar and jaw, and
        // the head reads as floating rather than as attached.
        box(p.skin, 0.09, 0.11, 0.09, 0, C.SHOULDER_UP + 0.055, -0.005),
      ],
      6
    ),
    head: merge(
      [
        box(p.skin, 0.165, 0.2, 0.185, 0, 0, 0),
        box(p.skin, 0.09, 0.075, 0.03, 0, -0.055, 0.1),         // jaw
        box(p.hair, 0.17, 0.06, 0.19, 0, 0.08, -0.004),
        box(p.cap, 0.176, 0.075, 0.196, 0, 0.115, 0),
        box(p.cap, 0.15, 0.022, 0.075, 0, 0.088, 0.13),         // peak
        box(0x1a1a1c, 0.026, 0.02, 0.02, 0.042, 0.015, 0.095),  // eyes
        box(0x1a1a1c, 0.026, 0.02, 0.02, -0.042, 0.015, 0.095),
      ],
      6
    ),
    thigh: segment(p.pants, 0.15, C.THIGH, 0.16, 0.76),
    shin: segment(p.pantsDark, 0.12, C.SHIN, 0.13, 0.84),
    upperArm: segment(p.skin, 0.085, C.UPPER_ARM, 0.085, 0.86),
    forearm: segment(p.skin, 0.075, C.FOREARM, 0.075, 0.9),
    // A shoe. Its origin is the ankle and the toe points up its own +Z.
    shoe: merge(
      [
        box(p.shoe, 0.09, 0.062, C.FOOT_L * 0.8, 0, -0.03, 0.035),
        box(p.sole, 0.094, 0.022, C.FOOT_L * 0.84, 0, -0.062, 0.035),
        box(p.shoe, 0.084, 0.08, 0.08, 0, 0.012, -0.055),       // heel cup
      ],
      6
    ),
    hand: merge([box(p.skin, 0.075, 0.09, 0.052, 0, 0, 0)], 6),
  };
}

export class Skater {
  constructor(palette = PALETTE) {
    this.group = new THREE.Group();
    this.material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 14,
      specular: 0x1e1a16,
    });

    this.geos = buildGeometries(palette);
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, this.material);
      this.group.add(m);
      return m;
    };

    this.pelvis = mk(this.geos.pelvis);
    this.chest = mk(this.geos.chest);
    this.head = mk(this.geos.head);
    this.legs = [0, 1].map(() => ({ thigh: mk(this.geos.thigh), shin: mk(this.geos.shin) }));
    this.shoes = [mk(this.geos.shoe), mk(this.geos.shoe)];
    this.arms = [0, 1].map(() => ({
      upper: mk(this.geos.upperArm),
      fore: mk(this.geos.forearm),
      hand: mk(this.geos.hand),
    }));

    // The body's own response to the pose has inertia, and this is where it
    // lives. Hips and lean ease; hands and feet have momentum.
    this.hipY = new Spring(C.HIP_H, 18);
    this.leanS = new Spring(0, 9);
    this.twistS = new Spring(0, 7);
    this.headYaw = new Spring(1.1, 8);
    this.hands = [new Spring3(150, 17), new Spring3(150, 17)];
    this.feetS = [new Spring3(900, 46), new Spring3(900, 46)];
    this.ready = false;

    // Joint positions in frame space, kept so the ragdoll can take over from
    // exactly the pose that was on screen when the bail happened.
    this.joints = {
      pelvis: new THREE.Vector3(),
      chest: new THREE.Vector3(),
      head: new THREE.Vector3(),
      hip: [new THREE.Vector3(), new THREE.Vector3()],
      knee: [new THREE.Vector3(), new THREE.Vector3()],
      foot: [new THREE.Vector3(), new THREE.Vector3()],
      shoulder: [new THREE.Vector3(), new THREE.Vector3()],
      elbow: [new THREE.Vector3(), new THREE.Vector3()],
      hand: [new THREE.Vector3(), new THREE.Vector3()],
    };
  }

  set visible(v) {
    this.group.visible = v;
  }

  /**
   * Pose the rider. `s` is the ride state; makeRideState() below documents it.
   *
   * Index 0 is the front foot — the one towards the nose — and index 1 the back
   * foot, throughout. For a regular-footed rider that makes 0 the left side of
   * the body, and `s.switchStance` swaps which end of the board each is over
   * without anything else having to know.
   */
  pose(s, dt) {
    // --- the body's frame -------------------------------------------------
    // A regular rider faces the toe side, which is -X. Riding fakie after a 180
    // means facing the other way, and mirroring this one number is all of it.
    const face = s.switchStance ? 1 : -1;
    const twist = this.twistS.step(dt, s.twist);
    const lean = this.leanS.step(dt, s.lean);
    // The deck takes a quarter of the lean; the body takes the rest.
    const bodyLean = lean * (1 - C.DECK_TILT_SHARE);

    _fwd.set(face * Math.cos(twist), 0, -face * Math.sin(twist)).normalize();
    // A carve leans the rider sideways relative to the board, which in frame
    // space is towards ±X — not towards the rider's own right, which is where
    // this went wrong the first time. Positive lean tips towards the heel side.
    _up.set(Math.sin(bodyLean), Math.cos(bodyLean), 0);
    _right.crossVectors(_fwd, _up).normalize();

    // --- the feet ---------------------------------------------------------
    // Foot targets start as the stance: two constants on the deck. Everything
    // that moves a foot — a push, an ollie's front-foot drag, a flip's flick — is
    // an offset from there, and the springs give each one weight.
    const mirror = s.switchStance ? -1 : 1;
    const ankle = C.DECK_Y + C.FOOT_H;
    const feet = [];
    for (let i = 0; i < 2; i++) {
      const front = i === 0;
      _a.set(
        front ? s.footFrontX : s.footBackX,
        ankle + (front ? s.footFrontLift : s.footBackLift),
        (front ? C.FOOT_FRONT_Z : C.FOOT_BACK_Z) * mirror +
          (front ? s.footFrontSlide : s.footBackSlide) * mirror
      );
      if (!front && s.push >= 0) this.pushFoot(s, _a, mirror);
      else this.deckToFrame(s, _a);
      if (!this.ready) this.feetS[i].set(_a);
      feet.push(this.feetS[i].step(dt, _a));
    }

    // --- the hips ---------------------------------------------------------
    // Over the middle of the stance, dropped by the crouch, and biased towards
    // the back foot — which is where a skater's weight sits, and what stops the
    // figure looking like it is mid-lunge.
    const hipH = this.hipY.step(dt, C.HIP_H - s.crouch, s.stiff ? 34 : 18);
    _mid.copy(feet[0]).add(feet[1]).multiplyScalar(0.5).lerp(feet[1], 0.16);
    const pelvis = this.joints.pelvis;
    // Start on the deck plane and go up the *leaned* up axis: that puts the hips
    // out over the inside of the turn without a separate offset for it.
    pelvis.set(_mid.x, ankle - C.FOOT_H, _mid.z).addScaledVector(_up, hipH);
    pelvis.x += s.hipShift;
    pelvis.y = Math.max(pelvis.y, ankle + 0.28); // never through the deck

    // --- torso ------------------------------------------------------------
    // The spine folds forward with the crouch and, a little, with speed: you
    // cannot drop your hips 25 cm and keep your shoulders above them.
    const pitch = s.spinePitch + s.crouch * 0.8 + Math.min(0.16, s.speed * 0.012);
    const chest = this.joints.chest;
    chest.copy(pelvis).addScaledVector(_up, C.SPINE * Math.cos(pitch));
    chest.addScaledVector(_fwd, C.SPINE * Math.sin(pitch));

    // The chest's own basis: pitched forward, and turned further into the
    // direction of travel than the hips are. The gap between the two is the
    // counter-rotation that makes a carve read as a whole-body movement.
    _z.copy(_fwd).addScaledVector(_up, -Math.sin(pitch)).addScaledVector(_right, s.shoulderLead);
    basis(this.chest, _z, _up);
    this.chest.position.copy(chest);
    _qChest.copy(this.chest.quaternion);
    _y.set(0, 1, 0).applyQuaternion(_qChest); // the chest's own up

    // The head looks where the board is going, which for a rider stood sideways
    // means turned most of the way out of the shoulders.
    const head = this.joints.head;
    head.copy(chest).addScaledVector(_y, C.NECK);
    this.head.position.copy(head);
    _q.setFromAxisAngle(UP, this.headYaw.step(dt, s.lookYaw) * face * -1);
    this.head.quaternion.copy(_qChest).premultiply(_q);

    _z.copy(_fwd).addScaledVector(_right, -s.shoulderLead * 0.55);
    basis(this.pelvis, _z, _up);
    this.pelvis.position.copy(pelvis);

    // --- legs -------------------------------------------------------------
    _d.set(1, 0, 0).applyQuaternion(this.pelvis.quaternion); // the pelvis's right
    const hips = this.joints.hip;
    hips[0].copy(pelvis).addScaledVector(_d, -C.HIP_W).addScaledVector(_up, -0.05);
    hips[1].copy(pelvis).addScaledVector(_d, C.HIP_W).addScaledVector(_up, -0.05);

    for (let i = 0; i < 2; i++) {
      // Knees break forwards and outwards, further out the deeper the crouch —
      // which is what a skater's stance does, and it keeps the thighs out of the
      // torso in a full squat.
      const outward = i === 0 ? -1 : 1;
      _a.copy(_fwd)
        .multiplyScalar(0.72)
        .addScaledVector(_right, outward * (0.30 + s.crouch * 1.5))
        .addScaledVector(_up, -0.12)
        .normalize();
      solveJoint(hips[i], feet[i], C.THIGH, C.SHIN, _a, this.joints.knee[i]);
      this.joints.foot[i].copy(feet[i]);
      bone(this.legs[i].thigh, hips[i], this.joints.knee[i], _a);
      bone(this.legs[i].shin, this.joints.knee[i], feet[i], _a);
    }

    // --- shoes ------------------------------------------------------------
    // Placed, not solved: they are bolted to the deck, or planted flat on the
    // ground mid-push, and both of those are known exactly.
    for (let i = 0; i < 2; i++) {
      const shoe = this.shoes[i];
      shoe.position.copy(feet[i]);
      const planted = i === 1 && s.push >= 0 && s.pushPlanted;
      const across = i === 0 ? C.FOOT_FRONT_YAW * (1 - s.frontFootTurn) : C.FOOT_BACK_YAW;
      // Toes point over the toe side, so the yaw follows `face`.
      _q.setFromAxisAngle(UP, (planted ? 0.12 : across) * face);
      shoe.quaternion.copy(this.deckQuat(s, planted)).multiply(_q);
    }

    // --- arms -------------------------------------------------------------
    this.poseArms(s, dt, chest, _qChest);
    this.ready = true;
    return this;
  }

  /**
   * The board's rotation inside the frame: pitch from an ollie or a manual, roll
   * from the deck's share of the lean, yaw when it is sideways on a rail.
   *
   * A flip's roll is deliberately *not* in here. During a flip the feet are off
   * the board, so the parts of the rider that follow the deck must not follow the
   * spin — that separation is the difference between a kickflip and the rider's
   * legs snapping round with the board.
   */
  deckQuat(s, planted) {
    // A planted pushing foot is flat on the ground, not on the deck.
    if (planted) return _qDeck.identity();
    // Nose-up is a negative rotation about +X, since +X takes +Z towards -Y.
    _eul.set(-s.deckPitch, s.deckYaw, s.deckRoll, 'YXZ');
    return _qDeck.setFromEuler(_eul);
  }

  /** Move a point from deck-relative into frame space. */
  deckToFrame(s, v) {
    if (!s.deckPitch && !s.deckRoll && !s.deckYaw) return v;
    // The deck rotates about its own middle at deck height, so the pivot has to
    // come out and go back or an ollie's pitch would translate the feet upwards.
    v.y -= C.DECK_Y;
    v.applyQuaternion(this.deckQuat(s, false));
    v.y += C.DECK_Y + s.deckLift;
    return v;
  }

  /**
   * The pushing foot's path: off the tail, down to the ground on the toe side, a
   * drive backwards, then a swing forward to land back on the deck.
   *
   * The drive window matches PUSH_KICK_START..PUSH_KICK_END exactly, because that
   * is when physics is adding speed. A foot sweeping out of time with the
   * acceleration is what makes a pushing animation look fake.
   */
  pushFoot(s, out, mirror) {
    const p = s.push;
    const side = s.switchStance ? 1 : -1;   // the toe side: where the foot goes
    const ground = C.FOOT_H;                // sole on the surface, in frame space
    const tail = C.FOOT_BACK_Z * mirror;
    const deck = C.DECK_Y + C.FOOT_H;
    const reachEnd = C.PUSH_KICK_START / C.PUSH_TIME;
    const driveEnd = C.PUSH_KICK_END / C.PUSH_TIME;

    if (p < reachEnd) {
      const t = p / reachEnd;
      out.set(side * 0.20 * t, deck + (ground - deck) * t, tail + (0.16 - tail) * t);
    } else if (p < driveEnd) {
      // Planted: in frame space the foot sweeps backwards while the board moves
      // forwards over it.
      const t = (p - reachEnd) / (driveEnd - reachEnd);
      out.set(side * 0.20, ground, 0.16 - t * 0.62);
    } else {
      const t = (p - driveEnd) / (1 - driveEnd);
      const e = t * t * (3 - 2 * t);
      out.set(
        side * 0.20 * (1 - e),
        ground + (deck - ground) * e + Math.sin(e * Math.PI) * 0.07,
        -0.46 * (1 - e) + tail * e
      );
    }
    return out;
  }

  /**
   * Arms. Their targets are set in frame space and chased by springs with real
   * momentum, so they trail a change of direction and swing past it — the one
   * part of the rig allowed to overshoot, and most of why the figure reads as
   * balancing rather than as posed.
   */
  poseArms(s, dt, chest, chestQ) {
    const shoulders = this.joints.shoulder;
    _d.set(1, 0, 0).applyQuaternion(chestQ);
    _y.set(0, 1, 0).applyQuaternion(chestQ);
    shoulders[0].copy(chest).addScaledVector(_d, -C.SHOULDER_W).addScaledVector(_y, C.SHOULDER_UP);
    shoulders[1].copy(chest).addScaledVector(_d, C.SHOULDER_W).addScaledVector(_y, C.SHOULDER_UP);

    const reach = C.UPPER_ARM + C.FOREARM;
    for (let i = 0; i < 2; i++) {
      const lead = i === 0 ? 1 : -1; // 0 is the nose-side arm
      const spread = s.armSpread;
      // Hands sit at about hip height with the elbows just broken, and they are
      // spread along the board rather than out to the sides — one towards the
      // nose, one towards the tail, which is how a skater actually carries them.
      _a.copy(shoulders[i])
        .addScaledVector(_right, lead * reach * (0.24 + spread * 0.5))
        .addScaledVector(_fwd, reach * (0.20 + spread * 0.12) + s.armReach * lead)
        .addScaledVector(
          _up,
          -reach * (0.80 - spread * 0.42) + s.armLift + s.armWave * lead
        );
      const spring = this.hands[i];
      if (!this.ready) spring.set(_a);
      const hand = spring.step(dt, _a);

      // Elbows break down and back, away from the body.
      _b.copy(_fwd)
        .multiplyScalar(-0.35)
        .addScaledVector(_up, -0.75)
        .addScaledVector(_right, lead * 0.5)
        .normalize();
      solveJoint(shoulders[i], hand, C.UPPER_ARM, C.FOREARM, _b, this.joints.elbow[i]);
      this.joints.hand[i].copy(hand);
      bone(this.arms[i].upper, shoulders[i], this.joints.elbow[i], _b);
      bone(this.arms[i].fore, this.joints.elbow[i], hand, _b);
      this.arms[i].hand.position.copy(hand);
      this.arms[i].hand.quaternion.copy(this.arms[i].fore.quaternion);
    }
  }

  /** Forget every spring's momentum, so a respawn does not slide into place. */
  settle() {
    this.ready = false;
    for (const s of this.hands) s.v.set(0, 0, 0);
    for (const s of this.feetS) s.v.set(0, 0, 0);
  }
}

/**
 * A neutral ride state — and the documentation of what the pose reads.
 *
 * physics.js owns the live one and mutates it in place; this is what each field
 * means, and where it sits when nothing is happening.
 */
export function makeRideState() {
  return {
    speed: 0,             // m/s, for the parts of the pose that scale with it
    crouch: 0,            // metres the hips are dropped from HIP_H
    lean: 0,              // radians of carve lean, positive towards the heel side
    twist: 0,             // radians the whole body is turned out of its stance
    hipShift: 0,          // metres the hips are pushed off the board sideways
    spinePitch: 0.12,     // radians of forward bend at the waist
    shoulderLead: 0,      // how far the shoulders turn ahead of the hips
    lookYaw: 1.1,         // radians the head is turned out of the chest
    switchStance: false,  // riding fakie, after a body 180

    deckPitch: 0,         // radians of nose-up: an ollie's snap, a manual
    deckLift: 0,          // metres the deck rises from pivoting on one truck
    deckRoll: 0,          // the deck's own share of the lean
    deckYaw: 0,           // sideways on a rail

    push: -1,             // -1 idle, else 0..1 through the push cycle
    pushPlanted: false,   // the pushing foot is on the ground right now

    footFrontLift: 0,     // metres each foot is off the deck
    footBackLift: 0,
    footFrontSlide: 0,    // metres slid along the deck: the ollie's drag
    footBackSlide: 0,
    footFrontX: 0,        // metres off the deck's centreline: the flick
    footBackX: 0,
    frontFootTurn: 0,     // 0 = across the deck, 1 = pointing at the nose

    armSpread: 0.22,      // 0 tucked, 1 flung wide for balance
    armLift: 0,
    armReach: 0,
    armWave: 0,           // opposing vertical wobble, for sketchy landings
    stiff: false,         // snap the hips instead of easing them
  };
}

// --- ragdoll rendering ----------------------------------------------------
/** A basis with +Y along `yDir` and +X as close to `xHint` as it can manage. */
function orient(obj, pos, yDir, xHint) {
  _y.copy(yDir);
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0);
  _y.normalize();
  _x.copy(xHint).addScaledVector(_y, -xHint.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  else _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(pos);
}

/**
 * Draw the rider from ragdoll particles instead of from a pose.
 *
 * The same meshes are reused, in world space — the group's own transform is
 * cleared, so this must only ever be called while the group is parented to the
 * scene rather than to the ride frame.
 */
Skater.prototype.poseRagdoll = function poseRagdoll(P) {
  this.group.position.set(0, 0, 0);
  this.group.quaternion.identity();

  _mid.copy(P.hipL.p).add(P.hipR.p).multiplyScalar(0.5);
  _a.subVectors(P.chest.p, _mid);
  _b.subVectors(P.hipR.p, P.hipL.p);
  orient(this.pelvis, _mid, _a, _b);

  _a.subVectors(P.head.p, P.chest.p);
  _b.subVectors(P.shoulderR.p, P.shoulderL.p);
  orient(this.chest, P.chest.p, _a, _b);
  orient(this.head, P.head.p, _a, _b);

  const limbs = [
    [P.hipL, P.kneeL, P.footL, 0],
    [P.hipR, P.kneeR, P.footR, 1],
  ];
  for (const [hip, knee, foot, i] of limbs) {
    _b.subVectors(P.hipR.p, P.hipL.p);
    bone(this.legs[i].thigh, hip.p, knee.p, _b);
    bone(this.legs[i].shin, knee.p, foot.p, _b);
    _a.subVectors(knee.p, foot.p);
    orient(this.shoes[i], foot.p, _a, _b);
  }

  const arms = [
    [P.shoulderL, P.elbowL, P.handL, 0],
    [P.shoulderR, P.elbowR, P.handR, 1],
  ];
  for (const [shoulder, elbow, hand, i] of arms) {
    _b.subVectors(P.shoulderR.p, P.shoulderL.p);
    bone(this.arms[i].upper, shoulder.p, elbow.p, _b);
    bone(this.arms[i].fore, elbow.p, hand.p, _b);
    this.arms[i].hand.position.copy(hand.p);
    this.arms[i].hand.quaternion.copy(this.arms[i].fore.quaternion);
  }
};
