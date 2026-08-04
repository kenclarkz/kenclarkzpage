// The ride model: everything that decides where the board goes, and what the
// rider's body is doing about it.
//
// The board is not a rigid body with a collision mesh. It is a contact patch on a
// height field, and the state that matters is small: a position, a heading, a
// scalar speed along that heading, and a lean. That is deliberate — a general
// rigid-body solver would spend all of its time keeping an 0.8 m plank from
// jittering on the concrete and none of it on the things that make skating feel
// like skating.
//
// What the model does insist on being right about:
//
//   Turning is a balance problem. Leaning by θ commits you to a lateral
//   acceleration of g·tanθ, so the radius is v²/(g·tanθ) — wide at speed, tight
//   at a crawl, and never something the player sets directly.
//
//   Leaving the ground is a consequence, not a state change. Every step compares
//   the surface against a free-fall path, and when the concrete drops away faster
//   than gravity can pull the board down, the board is in the air. Rolling off a
//   ledge, launching out of a transition and popping an ollie all fall out of that
//   one test instead of out of three separate rules.
//
//   A landing can be refused. The board has to be roughly level, roughly pointing
//   where it is going, and finished with whatever it started. Miss any of those
//   and the run ends on the floor.

import * as THREE from '../game/three.js';
import * as C from './config.js';
import { ROUGH } from './park.js';
import { makeRideState } from './skater.js';
import { byId, trickName, trickScore, grindName } from './tricks.js';

export const GROUND = 0;
export const AIR = 1;
export const GRIND = 2;
export const BAIL = 3;

/** The biggest step up the wheels will climb instead of catching on. */
const STEP_UP = 0.035;
/** Below this you bump into a curb; above it you go over the bars. */
const WALL_BAIL_SPEED = 1.6;
/** How fast the wheels kill sideways motion while they are gripping. */
const GRIP_RATE = 26;
/** Turning the board by twisting against it, at walking pace. rad/s. */
const PIVOT_RATE = 2.3;
/** Seconds after leaving a rail before another one can catch. */
const GRIND_COOL = 0.22;
/** Where the frame sits below a rail's top, riding the trucks or the deck. */
const GRIND_DROP_TRUCK = 0.055;
const GRIND_DROP_DECK = 0.081;

const _h = new THREE.Vector3();      // heading, in the surface plane
const _l = new THREE.Vector3();      // lateral, in the surface plane
const _n = new THREE.Vector3();      // surface normal
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _eul = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/** Fold a slip angle into 0..π/2: a board rolling tail-first is just fakie. */
function slipError(angle) {
  let a = Math.abs(angle) % Math.PI;
  if (a > Math.PI / 2) a = Math.PI - a;
  return a;
}

/** How far a rotation is from a whole number of turns. */
function turnError(rot, per = Math.PI * 2) {
  const r = ((rot % per) + per) % per;
  return Math.min(r, per - r);
}

export class Ride {
  constructor(park, board, skater) {
    this.park = park;
    this.board = board;
    this.skater = skater;

    // The frame is the board's contact patch, and both the board and the rider
    // are posed inside it. That is what keeps riding a transition from needing a
    // special case anywhere else in the code.
    this.frame = new THREE.Group();
    this.frame.add(board.group);
    this.frame.add(skater.group);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.surf = { y: 0, nx: 0, ny: 1, nz: 0, kind: 0 };
    this.ahead = { y: 0, nx: 0, ny: 1, nz: 0, kind: 0 };
    this.grindHit = { rail: null, t: 0, px: 0, py: 0, pz: 0 };
    this.state = makeRideState();
    this.events = [];

    this.reset();
  }

  reset(spawn = this.park.spawn) {
    this.pos.set(spawn.x, this.park.heightAt(spawn.x, spawn.z), spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = spawn.yaw;
    this.speed = 0;
    this.side = 0;
    this.mode = GROUND;
    this.up.set(0, 1, 0);
    this.wheelSpeed = 0;

    this.lean = 0;
    this.steer = 0;
    this.charge = 0;
    this.chargeHeld = 0;
    this.wasCharging = false;
    this.pendingTrick = null;
    this.pendingCharge = undefined;

    this.pop = -1;            // seconds since the tail snapped; -1 when idle
    this.popHeight = 0;
    this.trick = null;
    this.airTime = 0;
    this.airYaw = 0;
    this.airPitch = 0;
    this.apex = 0;

    this.push = -1;           // 0..1 through a push cycle; -1 when idle
    this.pushCool = 0;
    this.sliding = false;
    this.slideYaw = 0;

    this.manual = false;
    this.manualDist = 0;
    this.grind = null;
    this.grindCool = 0;
    this.balance = 0;
    this.balanceVel = 0;
    this.balanceBias = 0;

    this.compress = 0;
    this.sketch = 0;
    this.bailReason = null;
    this.bailTimer = 0;

    this.combo = { points: 0, names: [], live: false, idle: 0 };
    this.trickCount = 0;
    this.bails = 0;
    this.bestAir = 0;

    this.surfaceFrame(this.up);
    this.skater.settle();
    this.updatePose(1 / 60);
    this.applyTransforms();
    this.skater.pose(this.state, 1 / 60);
  }

  /**
   * Raise an event for main.js to turn into sound and text.
   *
   * `name` is spread last on purpose: a payload carrying its own `name` — a trick
   * or a grind, both of which have one — would otherwise overwrite the event's
   * kind and every listener would silently stop matching. Payload names go in
   * `label`.
   */
  emit(name, data) {
    this.events.push({ ...data, name });
  }

  get fakie() {
    return this.speed < -0.4;
  }

  get grounded() {
    return this.mode === GROUND;
  }

  get bailed() {
    return this.mode === BAIL;
  }

  /** How fast the board is travelling, whichever way it happens to be pointing. */
  get groundSpeed() {
    return this.mode === AIR ? this.vel.length() : Math.hypot(this.speed, this.side);
  }

  /** Height above whatever is directly below. Drives the HUD and the shadow. */
  get airHeight() {
    return Math.max(0, this.pos.y - this.park.heightAt(this.pos.x, this.pos.z));
  }

  // =========================================================================
  // the step
  // =========================================================================
  update(dt, input) {
    this.events.length = 0;
    if (this.mode === BAIL) {
      this.bailTimer += dt;
      return this.events;
    }

    if (this.grindCool > 0) this.grindCool -= dt;
    this.readInput(dt, input);

    switch (this.mode) {
      case GROUND:
        this.stepGround(dt);
        break;
      case AIR:
        this.stepAir(dt);
        break;
      case GRIND:
        this.stepGrind(dt);
        break;
    }

    this.advancePop(dt);
    this.advanceTrick(dt);
    this.advanceCombo(dt);

    this.compress -= this.compress * C.COMPRESS_RECOVER * dt;
    if (this.sketch > 0) this.sketch = Math.max(0, this.sketch - dt);

    // Wheels keep whatever speed they were given: there is nothing in the air to
    // slow them down, and they only pick up a new speed on the ground.
    if (this.mode === AIR) this.wheelSpeed *= Math.exp(-0.35 * dt);
    else this.wheelSpeed = Math.abs(this.speed);

    this.updatePose(dt);
    this.applyTransforms();
    if (this.mode !== BAIL) this.skater.pose(this.state, dt);
    this.board.roll(dt, this.wheelSpeed);
    return this.events;
  }

  // =========================================================================
  // input
  // =========================================================================
  readInput(dt, input) {
    this.steer += (input.steer - this.steer) * (1 - Math.exp(-14 * dt));
    this.sliding = !!input.slide && this.mode === GROUND;

    // --- tricks -----------------------------------------------------------
    // Read before the charge is touched, because a flick arrives on the same
    // frame the charge is released and the pop is worth exactly that charge.
    if (input.trick) {
      this.pendingTrick = input.trick;
      this.pendingCharge = input.trickCharge;
    }
    if (this.pendingTrick) {
      const def = byId[this.pendingTrick];
      this.pendingTrick = null;
      const charge = this.pendingCharge;
      this.pendingCharge = undefined;
      if (def) this.popOff(def, charge);
    }

    // --- the charge -------------------------------------------------------
    // Loading the legs. The crouch is worth height when it is released, and
    // holding it past where a real skater's legs would give out costs that height
    // back — which is also what tips the board into a manual.
    if (input.charge) {
      this.chargeHeld += dt;
      this.charge =
        this.chargeHeld < C.CHARGE_TIME
          ? this.chargeHeld / C.CHARGE_TIME
          : Math.max(0.25, 1 - (this.chargeHeld - C.CHARGE_TIME) * C.CHARGE_DECAY);
      if (this.mode === GROUND && this.chargeHeld > C.CHARGE_TIME * 1.45 && !this.manual) {
        this.startManual();
      }
    } else {
      // Let go without flicking and the nose simply comes back down.
      if (this.wasCharging && this.manual) this.endManual();
      this.charge = 0;
      this.chargeHeld = 0;
    }
    this.wasCharging = !!input.charge;

    // --- pushing ----------------------------------------------------------
    if (this.pushCool > 0) this.pushCool -= dt;
    if (
      input.push &&
      this.push < 0 &&
      this.mode === GROUND &&
      !this.manual &&
      this.pushCool <= 0 &&
      this.speed > -0.5
    ) {
      this.push = 0;
      this.pushCool = C.PUSH_MIN_INTERVAL;
      this.emit('push', {});
    }
    if (this.push >= 0) {
      this.push += dt / C.PUSH_TIME;
      if (this.push >= 1 || this.mode !== GROUND) this.push = -1;
    }

    // --- in-air rotation ---------------------------------------------------
    // The same stick that steers on the ground spins the body in the air, which
    // is how the game this copies does it.
    if (this.mode === AIR) {
      const spin = -input.steer * C.SPIN_RATE * dt;
      this.yaw += spin;
      this.airYaw += spin;
    }
  }

  // =========================================================================
  // on the ground
  // =========================================================================
  stepGround(dt) {
    const here = this.park.sample(this.pos.x, this.pos.z, this.surf);
    const rough = here.kind === ROUGH;
    _n.set(here.nx, here.ny, here.nz);
    this.easeUp(dt, _n, 18);
    this.surfaceFrame(_n);

    // --- lean --------------------------------------------------------------
    // Screen-right is -X when travelling towards +Z, so steering right is a lean
    // towards the toe side, which is negative.
    let leanTarget = -this.steer * C.LEAN_MAX;
    if (this.manual) leanTarget *= 0.55;  // a tail press has one truck of grip
    if (Math.abs(this.speed) < 0.6) leanTarget *= 0.35;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-C.LEAN_RATE * dt));

    // --- along the heading -------------------------------------------------
    const sgn = this.speed >= 0 ? 1 : -1;
    const sp = Math.abs(this.speed);
    let a = C.GRAVITY * _h.y;             // the slope's own pull
    if (sp > 0.02) {
      a -= sgn * (C.ROLL_FRICTION + C.ROLL_DRAG * sp * sp);
      if (rough) a -= sgn * C.ROUGH_FRICTION;
    }
    // The push drives only while the foot is actually sweeping, and gives out as
    // the board catches up with how fast a leg can move.
    if (this.pushDriving()) {
      a += C.PUSH_IMPULSE * Math.max(0, 1 - sp / C.PUSH_TOP_SPEED);
    }

    // --- steering ----------------------------------------------------------
    const aLat = 9.81 * Math.tan(this.lean);
    let yawRate = 0;
    if (Math.abs(aLat) > 1e-3) {
      const r = Math.max(C.TURN_R_MIN, (sp * sp) / Math.abs(aLat));
      yawRate = Math.sign(aLat) * Math.min(C.YAW_RATE_MAX, sp / r);
    }
    // Twisting the board round under you. Only worth anything at a crawl, which
    // is exactly when the carve above has nothing to work with.
    yawRate += -this.steer * PIVOT_RATE * Math.max(0, 1 - sp / 2.5) * (this.manual ? 2.2 : 1);
    // A cross-slope steers you downhill, harder the slower you are going — which
    // is why holding a line across a transition takes work.
    yawRate += (C.GRAVITY_STEER * (C.GRAVITY * _l.y)) / Math.max(2.5, sp);
    if (this.manual) yawRate *= 1.5;
    // Rolling backwards reverses which way a given lean turns you, exactly as it
    // does on a real board.
    this.yaw += yawRate * dt * sgn;

    // Tyre scrub: a carve costs speed in proportion to how hard it is.
    a -= sgn * C.CARVE_SCRUB * Math.abs(aLat);
    this.speed += a * dt;

    // --- sideways ----------------------------------------------------------
    if (this.sliding && sp > C.SLIDE_MIN_SPEED) {
      this.powerslide(dt);
    } else {
      this.slideYaw *= Math.exp(-6 * dt);
      this.side *= Math.exp(-GRIP_RATE * dt);   // the wheels grip
    }

    if (this.manual) {
      this.manualDist += Math.abs(this.speed) * dt;
      if (!this.stepBalance(dt, 1.0)) return;
    }

    // --- move --------------------------------------------------------------
    _v.copy(_h).multiplyScalar(this.speed).addScaledVector(_l, this.side);
    this.vel.copy(_v);
    const nx = this.pos.x + _v.x * dt;
    const nz = this.pos.z + _v.z * dt;

    // Free fall from here, for one step. Anything the surface does that this path
    // cannot follow is either a wall or the edge of something.
    const yBallistic = this.pos.y + _v.y * dt + 0.5 * C.GRAVITY * dt * dt;
    const ahead = this.park.sample(nx, nz, this.ahead);

    if (ahead.y - yBallistic > STEP_UP) {
      // Something the wheels will not climb.
      if (Math.abs(this.speed) > WALL_BAIL_SPEED) this.bail('hit');
      else {
        this.speed = 0;
        this.side = 0;
      }
      return;
    }

    this.pos.x = nx;
    this.pos.z = nz;

    if (ahead.y < yBallistic - 0.002) {
      // The ground dropped away faster than gravity: a launch, with no special
      // case for ledges, lips or kickers.
      this.pos.y = yBallistic;
      this.vel.y += C.GRAVITY * dt;
      this.takeOff();
    } else {
      this.pos.y = ahead.y;
      // Rolling onto a rail from the flat: the low end of a handrail, or a ledge
      // you have already ridden up onto.
      if (!this.manual) this.tryGrind(0.06);
    }
  }

  pushDriving() {
    return (
      this.push >= C.PUSH_KICK_START / C.PUSH_TIME && this.push < C.PUSH_KICK_END / C.PUSH_TIME
    );
  }

  /**
   * A powerslide. The board is kicked across the direction of travel; because the
   * velocity keeps going where it was, rotating the board's own axes under it is
   * what turns forward speed into sideways speed. Then sliding urethane scrubs
   * both components off at a near-constant rate, which is what a powerslide is
   * for.
   */
  powerslide(dt) {
    const kick = -this.steer * C.SLIDE_YAW_RATE * dt;
    this.yaw += kick;
    this.slideYaw += kick;
    const c = Math.cos(kick);
    const s = Math.sin(kick);
    const fwd = this.speed * c + this.side * s;
    const lat = -this.speed * s + this.side * c;
    this.speed = fwd;
    this.side = lat;

    const mag = Math.hypot(this.speed, this.side);
    const scrub = C.SLIDE_FRICTION * Math.min(1, Math.abs(Math.sin(this.slideYaw)) * 2.2) * dt;
    const f = Math.max(0, 1 - scrub / Math.max(0.01, mag));
    this.speed *= f;
    this.side *= f;
  }

  /** Ease the frame's up vector towards a target, so kinks do not snap. */
  easeUp(dt, target, rate) {
    this.up.lerp(target, 1 - Math.exp(-rate * dt)).normalize();
  }

  /**
   * Build the heading and lateral axes in the plane of `n`.
   *
   * The heading is the board's yaw projected onto the surface, so a board pointing
   * across a transition genuinely has a shallower climb than one pointing straight
   * up it — which is what makes carving up a ramp work.
   */
  surfaceFrame(n) {
    _h.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _h.addScaledVector(n, -_h.dot(n));
    if (_h.lengthSq() < 1e-8) _h.set(0, 0, 1);
    _h.normalize();
    _l.crossVectors(n, _h).normalize();
  }

  // =========================================================================
  // in the air
  // =========================================================================
  takeOff() {
    this.endManual();
    this.mode = AIR;
    this.airTime = 0;
    this.airYaw = 0;
    this.apex = this.pos.y;
    this.push = -1;
    this.emit('air', {});
  }

  stepAir(dt) {
    this.airTime += dt;
    this.vel.y += C.GRAVITY * dt;
    const v = this.vel.length();
    if (v > 0.01) this.vel.addScaledVector(this.vel, -C.AIR_DRAG * v * dt);
    if (this.pos.y > this.apex) this.apex = this.pos.y;

    // The board levels out as it flies and pitches a little towards the way it is
    // travelling — enough to read the arc, not enough to look like it is on rails.
    this.easeUp(dt, UP, 6);
    const traj = Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z));
    this.airPitch += (traj * 0.34 - this.airPitch) * (1 - Math.exp(-7 * dt));

    const px = this.pos.x;
    const py = this.pos.y;
    const pz = this.pos.z;
    this.pos.addScaledVector(this.vel, dt);

    // Rails are checked on the way down only: locking on while still rising is
    // what makes a grind look like a magnet instead of a trick.
    if (this.vel.y <= 0 && this.tryGrind(C.GRIND_SNAP_Y)) return;

    const ahead = this.park.sample(this.pos.x, this.pos.z, this.ahead);
    if (this.pos.y <= ahead.y && this.vel.y <= 0) {
      // Put the board on the surface rather than wherever the step happened to
      // end, so a landing at 12 m/s does not start 10 cm underneath it.
      const total = py - this.pos.y;
      const f = total > 1e-6 ? Math.max(0, Math.min(1, (py - ahead.y) / total)) : 0;
      this.pos.set(px + (this.pos.x - px) * f, ahead.y, pz + (this.pos.z - pz) * f);
      this.touchDown(ahead);
    }
  }

  /**
   * Touching down. Everything that decides whether this is a landing or a slam
   * happens here, and all of it is geometry: is the board level, is it pointing
   * where it is going, and did it finish what it started.
   */
  touchDown(surface) {
    _n.set(surface.nx, surface.ny, surface.nz);

    // Whatever is left of a rotation is exactly how far off level the board is.
    const flipErr = this.trick ? turnError(this.trick.flip) : 0;
    const shuvErr = this.trick ? turnError(this.trick.shuv, Math.PI) : 0;
    const pitchErr = this.trick ? turnError(this.trick.pitch) : 0;
    const rotErr = Math.max(flipErr, shuvErr, pitchErr);

    const velYaw = Math.atan2(this.vel.x, this.vel.z);
    const slip = slipError(velYaw - this.yaw);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // What the legs have to absorb is the closing speed along the *surface
    // normal*, not the vertical speed. Dropping into a transition at 10 m/s
    // nearly parallel to the concrete is not a hard landing, and treating it as
    // one is what makes a game refuse the single best thing about a ramp.
    const impact = -(this.vel.x * _n.x + this.vel.y * _n.y + this.vel.z * _n.z);
    const airPitch = this.airPitch;
    const height = this.apex - this.pos.y;
    if (height > this.bestAir) this.bestAir = height;

    let reason = null;
    if (impact > C.LAND_VY_BAIL) reason = 'flat';
    else if (rotErr > C.LAND_FLIP_OK) reason = 'primo';
    else if (slip > C.LAND_SLIP_SKETCH && speed > 1.4) reason = 'slide-out';
    else if (Math.abs(airPitch) > C.LAND_PITCH_OK) reason = 'nose';

    this.landOn(_n, velYaw, speed);
    if (reason) {
      this.bail(reason);
      return;
    }

    const sketchy =
      rotErr > C.LAND_ROLL_CLEAN || (slip > C.LAND_SLIP_CLEAN && speed > 1.4) || impact > 6.5;
    // The legs absorb the impact, and how much they had to absorb is exactly how
    // deep the compression looks.
    this.compress = Math.min(C.CROUCH_MAX * 0.9, impact * C.LAND_COMPRESS);
    if (sketchy) {
      this.sketch = C.SKETCH_TIME;
      this.speed *= C.SKETCH_SPEED_LOSS;
    }

    this.finishTrick(sketchy, height);
    this.emit('land', { sketchy, impact, height });
  }

  /** Settle onto a surface, and re-derive the rolling speed from the velocity. */
  landOn(n, velYaw, speed) {
    this.mode = GROUND;
    this.up.copy(n);
    // Snap the board to whichever way round it is closest to travelling, so a 180
    // lands rolling fakie instead of instantly sliding out. Below walking pace
    // the velocity's direction is noise — a board dropping almost straight down
    // into a transition has barely any horizontal motion to read — so the
    // heading is left alone.
    if (speed > 0.8) {
      const back = Math.abs(C.angleDelta(this.yaw, velYaw)) > Math.PI / 2;
      this.yaw = back ? velYaw + Math.PI : velYaw;
    }
    this.surfaceFrame(n);
    // Keep the part of the velocity that lies *in* the surface and give the rest
    // to the legs. On the flat that is just the horizontal speed, but landing
    // into a ramp it is nearly all of it — which is what makes dropping in, and
    // pumping between two transitions, work at all.
    _v.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
    this.speed = _v.dot(_h);
    this.side = _v.dot(_l);
    this.airPitch = 0;
    this.pop = -1;
    this.charge = 0;
    this.chargeHeld = 0;
  }

  // =========================================================================
  // popping
  // =========================================================================
  /**
   * Pop. The height comes from the charge and the launch speed comes from the
   * height — v = sqrt(2·g·h) — so a deeper crouch is worth exactly the air a
   * deeper crouch should be worth, and nothing is invented in between.
   */
  popOff(def, chargeOverride) {
    const fromGrind = this.mode === GRIND;
    if (this.mode !== GROUND && !fromGrind) return false;

    const charge = chargeOverride !== undefined ? chargeOverride : Math.max(this.charge, 0.2);
    const h = C.OLLIE_H_MIN + (C.OLLIE_H_MAX - C.OLLIE_H_MIN) * Math.min(1, charge);
    const vy = Math.sqrt(2 * -C.GRAVITY * h);

    this.endManual();
    if (fromGrind) this.leaveGrind(true);
    this.surfaceFrame(this.up);

    // Whatever the board was doing, plus a pop straight out of the surface. Out of
    // a transition that is not upwards, which is how you get air over a lip
    // instead of a strange vertical hop.
    _v.copy(_h).multiplyScalar(this.speed).addScaledVector(_l, this.side);
    this.vel.copy(_v).addScaledVector(this.up, vy);
    // Clear of the surface, so this step's ballistic test cannot re-land it.
    this.pos.addScaledVector(this.up, 0.012);

    this.popHeight = h;
    this.pop = 0;
    this.charge = 0;
    this.chargeHeld = 0;
    this.trick = {
      def,
      flip: 0,
      shuv: 0,
      pitch: 0,
      target: {
        flip: def.flip * Math.PI * 2,
        shuv: def.shuv * Math.PI * 2,
        pitch: def.pitch * Math.PI * 2,
      },
      done: def.flip === 0 && def.shuv === 0 && def.pitch === 0,
    };
    this.takeOff();
    this.emit('pop', { trick: def.id, height: h });
    return true;
  }

  /**
   * The ollie's own timeline: the tail snaps down, the board pitches nose-up hard,
   * then the front foot drags up the deck and levels it out. Those hundredths of a
   * second are the same whatever trick is riding on top, because on a real board
   * it is the same movement.
   */
  advancePop(dt) {
    if (this.pop < 0) return;
    this.pop += dt;
    if (this.pop > C.POP_LEVEL * 2.2) this.pop = -1;
  }

  popPitch() {
    if (this.pop < 0) return 0;
    if (this.pop < C.POP_SNAP) return C.POP_PITCH * (this.pop / C.POP_SNAP);
    const t = Math.min(1, (this.pop - C.POP_SNAP) / (C.POP_LEVEL - C.POP_SNAP));
    // Eased out: the nose comes down under the front foot rather than snapping.
    return C.POP_PITCH * (1 - t * t * (3 - 2 * t));
  }

  advanceTrick(dt) {
    const tr = this.trick;
    if (!tr || tr.done || this.mode !== AIR) return;
    // Nothing rotates until the tail has actually snapped.
    if (this.pop >= 0 && this.pop < C.POP_SNAP) return;

    let running = false;
    if (this.spinComponent(tr, 'flip', C.FLIP_RATE, dt)) running = true;
    if (this.spinComponent(tr, 'shuv', C.SHUV_RATE, dt)) running = true;
    if (this.spinComponent(tr, 'pitch', C.PITCH_RATE, dt)) running = true;
    if (!running) tr.done = true;
  }

  /** Advance one axis of a trick, stopping dead on its target. */
  spinComponent(tr, key, rate, dt) {
    const target = tr.target[key];
    if (target === 0) return false;
    const dir = Math.sign(target);
    tr[key] += dir * rate * dt;
    if ((dir > 0 && tr[key] >= target) || (dir < 0 && tr[key] <= target)) {
      tr[key] = target;
      return false;
    }
    return true;
  }

  /** Name and score whatever just landed. */
  finishTrick(sketchy, height) {
    const tr = this.trick;
    this.trick = null;
    if (!tr) return;
    const spin = this.airYaw;
    const fakie = this.speed < -0.4;
    // A plain ollie with nothing on it is a jump, not a trick.
    if (tr.def.id === 'ollie' && Math.abs(spin) < Math.PI * 0.6) return;
    const name = trickName(tr.def, { fakie, spin });
    let points = trickScore(tr.def, { spin, fakie });
    if (height > 1.2) points += Math.round((height - 1.2) * 120); // air is worth paying for
    if (sketchy) points = Math.round(points * 0.45);
    this.trickCount++;
    this.addToCombo(name, points, sketchy);
  }

  // =========================================================================
  // grinds
  // =========================================================================
  /**
   * Look for a rail to lock onto. `window` is how far above one the board can be
   * and still catch it: generous coming down out of the air, tight when rolling
   * along the flat.
   */
  tryGrind(window) {
    if (this.mode === GRIND || this.grindCool > 0) return false;
    if (Math.abs(this.speed) < 1.2 && this.mode === GROUND) return false;
    _h.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const rail = this.park.findGrind(this.pos, _h, C.GRIND_SNAP_XZ, window, C.GRIND_ALIGN, this.grindHit);
    if (!rail) return false;
    this.enterGrind(rail);
    return true;
  }

  enterGrind(rail) {
    const hit = this.grindHit;
    // Which way along the rail? Whichever way we were already going — a rail is
    // not directional.
    const along = this.vel.x * rail.dir.x + this.vel.y * rail.dir.y + this.vel.z * rail.dir.z;
    const dir = along >= 0 ? 1 : -1;
    const railYaw = Math.atan2(rail.dir.x * dir, rail.dir.z * dir);

    // How far across the rail the deck is sitting, folded into ±90° because a
    // board pointing backwards along a rail is the same grind.
    let across = C.angleDelta(railYaw, this.yaw);
    if (across > Math.PI / 2) across -= Math.PI;
    else if (across < -Math.PI / 2) across += Math.PI;
    const sideways = Math.abs(across) > Math.PI * 0.35;
    const snapped = sideways ? Math.sign(across) * (Math.PI / 2) : 0;
    const tailPress = this.manual || this.popPitch() > 0.2;

    this.grind = {
      rail,
      dir,
      t: hit.t,
      across: snapped,
      label: grindName(across, tailPress, false, rail.kind),
      dist: 0,
      points: 0,
    };
    this.mode = GRIND;
    this.yaw = railYaw;
    this.pos.set(
      hit.px,
      hit.py + rail.radius - (sideways ? GRIND_DROP_DECK : GRIND_DROP_TRUCK),
      hit.pz
    );
    this.speed = Math.abs(along) > 0.2 ? Math.abs(along) : Math.abs(this.speed);
    this.side = 0;
    this.up.set(0, 1, 0);
    this.airPitch = 0;
    this.pop = -1;
    this.trick = null;
    this.manual = false;

    this.balance = (Math.random() - 0.5) * 0.2;
    this.balanceVel = 0;
    // A rail always wants to fall one way for a given approach. Which way is
    // luck, and that is the whole point of a balance meter.
    this.balanceBias = (Math.random() - 0.5) * 1.4;
    this.emit('grindStart', { label: this.grind.label });
  }

  stepGrind(dt) {
    const g = this.grind;
    const rail = g.rail;

    // Steel is fast and concrete is not, and a board across a rail has far more
    // of itself in contact than one along it.
    const friction =
      rail.kind === 'coping'
        ? C.GRIND_FRICTION * 0.7
        : g.across === 0
          ? C.GRIND_FRICTION
          : C.SLIDE_GRIND_FRICTION;
    // The rail's own slope: a down-rail keeps you going.
    const slope = rail.dir.y * g.dir;
    this.speed += (C.GRAVITY * slope - Math.sign(this.speed) * friction) * dt;

    g.t += this.speed * g.dir * dt;
    g.dist += Math.abs(this.speed) * dt;
    g.points += Math.abs(this.speed) * dt * C.GRIND_POINTS_PER_M;

    if (!this.stepBalance(dt, g.across === 0 ? 1.0 : 1.25)) return;

    if (g.t <= 0 || g.t >= rail.len || Math.abs(this.speed) < 0.35) {
      this.leaveGrind(false);
      return;
    }

    rail.pointAt(g.t, _t);
    this.pos.set(
      _t.x,
      _t.y + rail.radius - (g.across === 0 ? GRIND_DROP_TRUCK : GRIND_DROP_DECK),
      _t.z
    );
    _h.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.vel.copy(_h).multiplyScalar(this.speed);
  }

  /**
   * Leave a rail. `popped` means the player ollied off, and popOff sets the air
   * state up itself; running off the end just drops you onto whatever is below.
   */
  leaveGrind(popped) {
    const g = this.grind;
    if (!g) return;
    this.grind = null;
    this.grindCool = GRIND_COOL;
    this.addToCombo(g.label, Math.round(g.points), false, g.dist);
    this.emit('grindEnd', { label: g.label, points: Math.round(g.points), dist: g.dist });
    if (popped) return;
    this.mode = AIR;
    this.airTime = 0;
    this.airYaw = 0;
    this.apex = this.pos.y;
    _h.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.vel.copy(_h).multiplyScalar(this.speed);
    this.pos.y += 0.01;
  }

  // =========================================================================
  // balance
  // =========================================================================
  startManual() {
    this.manual = true;
    this.manualDist = 0;
    this.balance = (Math.random() - 0.5) * 0.16;
    this.balanceVel = 0;
    this.balanceBias = (Math.random() - 0.5) * 0.9;
    this.emit('manual', {});
  }

  endManual() {
    if (!this.manual) return;
    this.manual = false;
    if (this.manualDist > 0.8) {
      const points = Math.round(this.manualDist * C.MANUAL_POINTS_PER_M);
      this.addToCombo('Manual', points, false, this.manualDist);
      this.emit('manualEnd', { points, dist: this.manualDist });
    }
    this.manualDist = 0;
  }

  /**
   * The inverted pendulum every grind and manual sits on.
   *
   * The tilt accelerates away from centre in proportion to how far it already is —
   * that is what makes it a balance problem rather than a wobble — and the
   * player's correction is an acceleration too, so it always arrives late. A
   * constant bias is drawn when the trick starts, so leaving the stick alone is
   * never an option.
   *
   * @returns false if balance was lost, in which case a bail has been raised.
   */
  stepBalance(dt, difficulty) {
    const accel =
      this.balance * C.BALANCE_FALL * difficulty +
      this.balanceBias * 0.5 +
      this.steer * C.BALANCE_CORRECT -
      this.balanceVel * C.BALANCE_DAMP;
    this.balanceVel += accel * dt;
    this.balance += this.balanceVel * dt;
    if (Math.abs(this.balance) > C.BALANCE_LIMIT) {
      this.bail(this.grind ? 'balance' : 'manual');
      return false;
    }
    return true;
  }

  // =========================================================================
  // combos
  // =========================================================================
  addToCombo(label, points, sketchy, dist = 0) {
    const c = this.combo;
    c.live = true;
    c.idle = 0;
    c.names.push(label);
    c.points += points;
    this.emit('trick', { label, points, sketchy, dist, chain: c.names.length });
  }

  /**
   * A combo banks once the skater has been rolling with nothing happening for
   * long enough. The multiplier is the number of tricks in the chain, which is
   * what makes linking two things worth more than doing one of them twice.
   */
  advanceCombo(dt) {
    const c = this.combo;
    if (!c.live) return;
    if (this.mode !== GROUND || this.manual || this.sketch > 0) {
      c.idle = 0;
      return;
    }
    c.idle += dt;
    if (c.idle < C.COMBO_WINDOW) return;
    const multiplier = c.names.length;
    this.emit('combo', {
      total: Math.round(c.points * multiplier),
      multiplier,
      names: c.names.slice(),
      points: c.points,
    });
    c.live = false;
    c.names.length = 0;
    c.points = 0;
    c.idle = 0;
  }

  /** Throw away whatever was being built. Called on a bail. */
  dropCombo() {
    const c = this.combo;
    if (c.live) this.emit('comboLost', { points: c.points, names: c.names.slice() });
    c.live = false;
    c.names.length = 0;
    c.points = 0;
    c.idle = 0;
  }

  // =========================================================================
  // bailing
  // =========================================================================
  bail(reason) {
    if (this.mode === BAIL) return;
    this.mode = BAIL;
    this.bailReason = reason;
    this.bailTimer = 0;
    this.bails++;
    this.grind = null;
    this.manual = false;
    this.manualDist = 0;
    this.trick = null;
    this.pop = -1;
    this.dropCombo();
    this.emit('bail', { reason, speed: this.groundSpeed });
  }

  // =========================================================================
  // pose
  // =========================================================================
  /**
   * Turn the ride state into the numbers the rider's body is posed from. This is
   * the only place the two halves of the game meet, and every line of it is the
   * consequence of something physical above.
   */
  updatePose(dt) {
    const s = this.state;
    const air = this.mode === AIR;
    s.speed = Math.abs(this.speed);

    // --- crouch -----------------------------------------------------------
    let crouch = this.charge * 0.19 + this.compress;
    if (air) {
      // The tuck: at the pop the board comes up to the body faster than the body
      // rises, then the legs reach back down for the landing.
      const tuck = Math.min(1, this.airTime / 0.14);
      const reach = this.vel.y < 0 ? Math.min(1, -this.vel.y / 3.4) : 0;
      crouch += 0.19 * tuck * (1 - reach * 0.85);
    }
    if (this.grind) crouch += 0.10;
    if (this.manual) crouch += 0.07;
    if (this.push >= 0) crouch += 0.06 * Math.sin(Math.min(1, this.push * 1.6) * Math.PI);
    s.crouch = Math.min(C.CROUCH_MAX, crouch);
    s.stiff = this.pop >= 0 && this.pop < C.POP_LEVEL;

    // --- lean and twist ---------------------------------------------------
    s.lean = this.lean;
    s.deckRoll = -this.lean * C.DECK_TILT_SHARE;
    s.hipShift = 0;
    s.spinePitch = 0.12 + (this.push >= 0 ? 0.14 : 0);

    // A board across a rail turns the rider with it: in a boardslide they end up
    // facing straight down the rail, a 90° twist out of a ride stance.
    s.deckYaw = this.grind ? this.grind.across : 0;
    s.twist =
      s.deckYaw + (air && this.airYaw ? Math.min(0.5, Math.abs(this.airYaw) * 0.12) * Math.sign(this.airYaw) : 0);

    // Shoulders lead into a turn, and wind up against a spin before it.
    s.shoulderLead = -this.steer * 0.22 - (air ? Math.sign(this.airYaw) * 0.18 : 0);
    s.lookYaw = 1.1 - Math.min(0.5, Math.abs(this.steer) * 0.3);

    // --- the deck ---------------------------------------------------------
    let pitch = this.popPitch();
    if (this.manual) pitch += C.MANUAL_PITCH;
    // A board pitching nose-up pivots on its *back axle*, not on its middle, so
    // the deck has to rise by half a wheelbase's worth of that angle. Without it a
    // manual quietly buries its back wheels in the concrete — and it is also
    // exactly why the pop of an ollie lifts the board before the rider is even
    // off the ground.
    s.deckLift = Math.sin(Math.abs(pitch)) * (C.WHEELBASE / 2);
    // Sampling under each truck is what makes the board pitch up as it rolls onto
    // a bank, before the frame itself has tilted. It follows the ground rather
    // than pivoting against it, so it takes no lift.
    if (this.mode === GROUND) pitch += this.truckPitch();
    s.deckPitch = pitch;

    // --- feet -------------------------------------------------------------
    this.poseFeet(s);

    // --- arms -------------------------------------------------------------
    let spread = 0.22 + Math.min(0.3, s.speed * 0.02);
    if (this.grind) spread = 0.85;
    else if (this.manual) spread = 0.7;
    else if (air) spread = this.trick && !this.trick.done ? 0.34 : 0.5;
    // Tucked, to keep a spin going: arms in is how you spin faster, on a board or
    // anywhere else.
    if (air && Math.abs(this.airYaw) > 1.2) spread = 0.1;
    s.armSpread = spread;
    s.armReach = air ? 0.1 : 0;
    s.armLift = this.grind || this.manual ? 0.12 : 0;

    // Balance corrections show up in the arms first, which is how a real grind
    // reads: the board is quiet and the upper body is not.
    const bal = this.grind || this.manual ? this.balance : 0;
    s.armWave = bal * 0.35 + (this.sketch > 0 ? Math.sin(this.sketch * 42) * 0.14 : 0);
    s.deckRoll += bal * 0.22 + (this.sketch > 0 ? Math.sin(this.sketch * 33) * 0.05 : 0);
    s.hipShift -= bal * 0.06;

    s.push = this.push;
    s.pushPlanted = this.pushDriving();
    s.frontFootTurn = this.push >= 0 ? 0.75 : 0;
  }

  /**
   * How much the two trucks disagree about the ground, over and above the tilt the
   * frame has already taken from the surface normal.
   */
  truckPitch() {
    _h.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const half = C.WHEELBASE / 2;
    const yF = this.park.heightAt(this.pos.x + _h.x * half, this.pos.z + _h.z * half);
    const yR = this.park.heightAt(this.pos.x - _h.x * half, this.pos.z - _h.z * half);
    const truck = Math.atan2(yF - yR, C.WHEELBASE);
    const frame = Math.asin(C.clamp(-(this.up.x * _h.x + this.up.z * _h.z), -1, 1));
    return C.clamp(truck - frame, -0.32, 0.32);
  }

  /**
   * The feet through a trick: the front foot drags up the deck and flicks off the
   * edge, both feet lift clear while the board goes round, and they come back down
   * to catch it as the rotation finishes.
   */
  poseFeet(s) {
    s.footFrontLift = 0;
    s.footBackLift = 0;
    s.footFrontSlide = 0;
    s.footBackSlide = 0;
    s.footFrontX = 0;
    s.footBackX = 0;

    // The drag: as the nose comes back down, the front foot is what is on it.
    if (this.pop >= 0) {
      const t = Math.min(1, this.pop / C.POP_LEVEL);
      s.footFrontSlide = Math.sin(t * Math.PI) * 0.09;
      s.footBackLift = Math.max(0, t - 0.4) * 0.05;
    }

    const tr = this.trick;
    if (!tr || this.mode !== AIR) return;
    const total =
      Math.abs(tr.target.flip) + Math.abs(tr.target.shuv) + Math.abs(tr.target.pitch);
    // A straight ollie: the feet stay on the board and the only thing moving is
    // how hard the legs are tucked.
    if (total < 0.1) return;

    // Off the board in the middle of the rotation, back on it at both ends.
    const clear = Math.sin(Math.min(1, this.trickProgress()) * Math.PI);
    s.footFrontLift = clear * 0.115;
    s.footBackLift = clear * 0.085;
    // The flick itself: the front foot goes out over whichever edge it is
    // flicking off — the toe side for a kickflip, the heel side for a heelflip.
    const flickSide = tr.target.flip > 0 ? -1 : tr.target.flip < 0 ? 1 : 0;
    s.footFrontX = flickSide * clear * 0.1;
    s.footFrontSlide += clear * 0.05;
    s.footBackX = -flickSide * clear * 0.03;
    if (!tr.done) s.footBackSlide = -clear * 0.03;
  }

  trickProgress() {
    const tr = this.trick;
    if (!tr) return 0;
    const total =
      Math.abs(tr.target.flip) + Math.abs(tr.target.shuv) + Math.abs(tr.target.pitch);
    if (total < 1e-6) return 0;
    return (Math.abs(tr.flip) + Math.abs(tr.shuv) + Math.abs(tr.pitch)) / total;
  }

  // =========================================================================
  // transforms
  // =========================================================================
  /**
   * Put the frame in the world, and the board inside the frame.
   *
   * The frame's +Y is the surface normal and its +Z is the heading, which is what
   * makes a rider on a transition stand square to the ramp. The board then adds
   * its own rotation: the part the feet share (an ollie's pitch, the deck's lean,
   * a boardslide's yaw) and the part they do not (the flip).
   */
  applyTransforms() {
    this.frame.position.copy(this.pos);

    _z.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _y.copy(this.up);
    _z.addScaledVector(_y, -_z.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1);
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    this.frame.quaternion.setFromRotationMatrix(_m);
    // The trajectory pitch is about the frame's own lateral axis, so it survives
    // the board being on a slope.
    if (this.airPitch) {
      _q.setFromAxisAngle(_x, -this.airPitch);
      this.frame.quaternion.premultiply(_q);
    }

    const s = this.state;
    _eul.set(-s.deckPitch, s.deckYaw, s.deckRoll, 'YXZ');
    _q.setFromEuler(_eul);
    const tr = this.trick;
    if (tr) {
      // Flip about the nose axis, shuv about vertical, pitch end over end.
      _eul.set(tr.pitch, tr.shuv, tr.flip, 'YXZ');
      _q.multiply(_q2.setFromEuler(_eul));
      // The board drops away from under the feet while it is going round.
      this.board.group.position.y =
        s.deckLift - 0.055 * Math.sin(Math.min(1, this.trickProgress()) * Math.PI);
    } else {
      this.board.group.position.y = s.deckLift;
    }
    this.board.group.quaternion.copy(_q);
  }
}
