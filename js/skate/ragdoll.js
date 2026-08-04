// The bail.
//
// When a landing is refused, the rider stops being a posed figure and becomes
// fourteen points with distance constraints between them. Verlet integration plus
// a handful of relaxation passes is all a ragdoll needs to be convincing, and it
// has one property no scripted fall has: it starts from exactly the pose that was
// on screen, carrying exactly the velocity the board had, so a slam out of a
// 12 m/s grind throws the rider further than one off a standing manual — without
// anybody having authored either.
//
// The board gets the same treatment with three points instead of fourteen. Three
// is the interesting number: two would give a plank that tumbles end over end but
// never rolls, and three define a whole frame, so the deck spins about its own
// length as well.

import * as THREE from '../game/three.js';
import * as C from './config.js';

const DAMP = 0.994;        // air drag on the whole body, per step
const BOUNCE = 0.14;       // how much of a landing a limb gives back
const GROUND_FRICTION = 0.42;
const ITERATIONS = 7;      // constraint passes per step; below five it stretches

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

class Point {
  constructor(x, y, z, radius = 0.09) {
    this.p = new THREE.Vector3(x, y, z);
    this.prev = new THREE.Vector3(x, y, z);
    this.r = radius;
  }
}

export class Ragdoll {
  constructor(park) {
    this.park = park;
    this.active = false;
    this.points = [];
    this.links = [];
    this.surf = { y: 0, nx: 0, ny: 1, nz: 0, kind: 0 };
    this.joints = null;
    this.board = { points: [], links: [] };
    this.settled = 0;
  }

  /**
   * Take over from the posed rider.
   *
   * `joints` are the skater's own joint positions, which live in frame space, so
   * they come through the frame's matrix to get to the world. `vel` is the board's
   * velocity at the moment it went wrong, and `spin` is the body rotation that was
   * still going — both of which get handed to every point, because a rider does
   * not stop moving just because they stopped skating.
   */
  start(skater, frame, vel, spin) {
    frame.updateMatrixWorld(true);
    const M = frame.matrixWorld;
    const j = skater.joints;
    const world = (v) => _t.copy(v).applyMatrix4(M);

    const pt = (v, r) => {
      const w = world(v);
      return new Point(w.x, w.y, w.z, r);
    };

    // Indices are fixed and referred to by name below, so the constraint list
    // stays readable.
    const P = {
      pelvis: pt(j.pelvis, 0.13),
      chest: pt(j.chest, 0.15),
      head: pt(j.head, 0.11),
      hipL: pt(j.hip[0], 0.09),
      hipR: pt(j.hip[1], 0.09),
      kneeL: pt(j.knee[0], 0.08),
      kneeR: pt(j.knee[1], 0.08),
      footL: pt(j.foot[0], 0.07),
      footR: pt(j.foot[1], 0.07),
      shoulderL: pt(j.shoulder[0], 0.08),
      shoulderR: pt(j.shoulder[1], 0.08),
      elbowL: pt(j.elbow[0], 0.06),
      elbowR: pt(j.elbow[1], 0.06),
      handL: pt(j.hand[0], 0.06),
      handR: pt(j.hand[1], 0.06),
    };
    this.named = P;
    this.points = Object.values(P);

    // The skeleton. Bone lengths are taken from where the points actually are
    // rather than from config, so whatever pose the bail interrupted is the pose
    // the ragdoll is built at.
    const link = (a, b, stiff = 1) => {
      this.links.push({ a, b, len: a.p.distanceTo(b.p), stiff });
    };
    link(P.pelvis, P.chest);
    link(P.chest, P.head);
    link(P.pelvis, P.hipL);
    link(P.pelvis, P.hipR);
    link(P.hipL, P.kneeL);
    link(P.hipR, P.kneeR);
    link(P.kneeL, P.footL);
    link(P.kneeR, P.footR);
    link(P.chest, P.shoulderL);
    link(P.chest, P.shoulderR);
    link(P.shoulderL, P.elbowL);
    link(P.shoulderR, P.elbowR);
    link(P.elbowL, P.handL);
    link(P.elbowR, P.handR);
    // Cross braces. Without them the torso folds flat and the shoulders end up
    // inside the hips — a rag, rather than a body.
    link(P.shoulderL, P.shoulderR, 0.9);
    link(P.hipL, P.hipR, 0.9);
    link(P.shoulderL, P.hipR, 0.5);
    link(P.shoulderR, P.hipL, 0.5);
    link(P.head, P.shoulderL, 0.4);
    link(P.head, P.shoulderR, 0.4);
    // Loose limits, so knees and elbows resist folding all the way over.
    link(P.hipL, P.footL, 0.06);
    link(P.hipR, P.footR, 0.06);
    link(P.shoulderL, P.handL, 0.05);
    link(P.shoulderR, P.handR, 0.05);

    // Every point starts with the board's velocity, plus what the spin was giving
    // it: a point 40 cm off the axis in a 7 rad/s spin is moving at nearly 3 m/s,
    // and leaving that out is what makes a ragdoll look dropped rather than
    // thrown.
    const dt = C.FIXED_DT;
    const centre = P.pelvis.p;
    for (const p of this.points) {
      _v.copy(vel);
      if (spin) {
        _v.x += -(p.p.z - centre.z) * spin;
        _v.z += (p.p.x - centre.x) * spin;
      }
      p.prev.copy(p.p).addScaledVector(_v, -dt);
    }

    this.startBoard(frame, vel, spin);
    this.active = true;
    this.settled = 0;
    return this;
  }

  /** The board, as three points: nose, tail, and one out to the side. */
  startBoard(frame, vel, spin) {
    frame.updateMatrixWorld(true);
    const M = frame.matrixWorld;
    const mk = (x, y, z) => {
      _t.set(x, y, z).applyMatrix4(M);
      return new Point(_t.x, _t.y, _t.z, 0.03);
    };
    const y = C.WHEEL_R + C.TRUCK_H;
    const nose = mk(0, y, C.DECK_LEN / 2);
    const tail = mk(0, y, -C.DECK_LEN / 2);
    const side = mk(C.DECK_W / 2, y, 0);
    const pts = [nose, tail, side];
    this.board.points = pts;
    this.board.links = [
      { a: nose, b: tail, len: nose.p.distanceTo(tail.p), stiff: 1 },
      { a: nose, b: side, len: nose.p.distanceTo(side.p), stiff: 1 },
      { a: tail, b: side, len: tail.p.distanceTo(side.p), stiff: 1 },
    ];
    // A board that has just been kicked out tumbles harder than the rider does.
    const tumble = 5 + Math.random() * 7;
    for (const p of pts) {
      _v.copy(vel).multiplyScalar(1.15);
      _v.x += (Math.random() - 0.5) * tumble * 0.5;
      _v.y += Math.random() * 1.6;
      _v.z += (Math.random() - 0.5) * tumble * 0.5;
      if (spin) {
        _v.x += -(p.p.z - tail.p.z) * spin;
        _v.z += (p.p.x - tail.p.x) * spin;
      }
      p.prev.copy(p.p).addScaledVector(_v, -C.FIXED_DT);
    }
  }

  stop() {
    this.active = false;
    this.points = [];
    this.links = [];
    this.board.points = [];
    this.board.links = [];
  }

  step(dt) {
    if (!this.active) return;
    this.integrate(this.points, dt);
    this.integrate(this.board.points, dt);
    for (let i = 0; i < ITERATIONS; i++) {
      this.relax(this.links);
      this.relax(this.board.links);
      this.collide(this.points);
      this.collide(this.board.points);
    }
    // How still it has gone, so the game knows when to offer a reset.
    let motion = 0;
    for (const p of this.points) motion += p.p.distanceToSquared(p.prev);
    this.settled = motion < 1e-5 ? this.settled + dt : 0;
  }

  integrate(points, dt) {
    const g = C.GRAVITY * dt * dt;
    for (const p of points) {
      _v.subVectors(p.p, p.prev).multiplyScalar(DAMP);
      p.prev.copy(p.p);
      p.p.add(_v);
      p.p.y += g;
    }
  }

  relax(links) {
    for (const l of links) {
      _v.subVectors(l.b.p, l.a.p);
      const d = _v.length();
      if (d < 1e-6) continue;
      // The loose limits are one-sided: they stop a joint over-extending and say
      // nothing at all about it bending.
      if (l.stiff < 0.1 && d < l.len) continue;
      const correction = ((d - l.len) / d) * 0.5 * l.stiff;
      _v.multiplyScalar(correction);
      l.a.p.add(_v);
      l.b.p.sub(_v);
    }
  }

  /**
   * Points against the park. Sliding along concrete is most of what a slam looks
   * like, so the tangential friction matters more here than the bounce does.
   */
  collide(points) {
    for (const p of points) {
      const s = this.park.sample(p.p.x, p.p.z, this.surf);
      const floor = s.y + p.r;
      if (p.p.y >= floor) continue;
      p.p.y = floor;
      const vy = p.prev.y - p.p.y;
      // Kill most of the downward velocity, and scrub what was sideways.
      p.prev.y = p.p.y + vy * BOUNCE;
      p.prev.x += (p.p.x - p.prev.x) * GROUND_FRICTION;
      p.prev.z += (p.p.z - p.prev.z) * GROUND_FRICTION;
    }
  }

  /** Where the camera should look while this plays out. */
  centre(out) {
    if (!this.points.length) return out.set(0, 0, 0);
    return out.copy(this.named.chest.p);
  }
}
