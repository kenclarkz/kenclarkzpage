// The board: a 32" deck with real kicks, two trucks, and four wheels that spin
// at the speed the board is actually travelling.
//
// Board-local axes, used by every other module and worth memorising:
//
//   +Z  the nose            -Z  the tail
//   +Y  up through the grip tape
//   +X  the rider's heel side       -X  the toe side
//
// The heel/toe assignment follows from the stance rather than being a choice:
// with the nose at +Z and up at +Y, a regular-footed rider (left foot forward)
// ends up facing -X, so their toes hang over -X and their heels over +X. Every
// trick that has a direction — kickflips, heelflips, shuvits — is signed off
// that fact.

import * as THREE from '../game/three.js';
import { box, piece, merge } from '../game/geo.js';
import * as C from './config.js';

const DECK = 0x9b6a3f;      // maple plys, seen from below
const GRIP = 0x1b1b1e;      // grip tape
const PLY = 0xd8b183;       // the light edge of the laminate
const TRUCK = 0xb9bec6;
const WHEEL = 0xe6e2d8;
const BEARING = 0x8d8f93;
const BOLT = 0x6e7378;

/** Half the length of the flat middle of the deck. */
const FLAT = C.KICK_START;
/** Length of each kicked end, measured along the kick. */
const KICK_L = (C.DECK_LEN - 2 * FLAT) / 2;

/**
 * One end of the deck, kicked up by NOSE_KICK.
 *
 * A rotation about +X takes +Z towards -Y, so the tail (at -Z) is kicked with a
 * positive angle and the nose (at +Z) with a negative one.
 */
function kickEnd(entries, sign, color, w, t, dy) {
  const kick = C.NOSE_KICK;
  const cz = sign * (FLAT + (Math.cos(kick) * KICK_L) / 2);
  const cy = (Math.sin(kick) * KICK_L) / 2 + dy;
  entries.push(box(color, w, t, KICK_L, 0, cy, cz, -sign * kick, 0, 0));
}

function buildDeck() {
  const entries = [];
  const W = C.DECK_W;
  const T = C.DECK_T;

  // Underside: the maple, flat middle plus both kicks.
  entries.push(box(DECK, W, T, FLAT * 2, 0, 0, 0));
  kickEnd(entries, 1, DECK, W, T, 0);
  kickEnd(entries, -1, DECK, W, T, 0);

  // Grip tape sits on top, a hair proud of the deck and a hair narrower, so the
  // pale laminate edge shows all the way round — which is what makes a board
  // read as a board from the camera's low angle rather than as a dark plank.
  const g = T * 0.34;
  entries.push(box(GRIP, W - 0.008, g, FLAT * 2, 0, T / 2 + g / 2, 0));
  kickEnd(entries, 1, GRIP, W - 0.008, g, T / 2 + g / 2);
  kickEnd(entries, -1, GRIP, W - 0.008, g, T / 2 + g / 2);

  // A pale stripe along each edge, standing in for the visible ply lines.
  for (const s of [-1, 1]) {
    entries.push(box(PLY, 0.006, T * 0.9, FLAT * 2, (s * (W - 0.006)) / 2, 0, 0));
  }

  return entries;
}

function buildTruck(entries, z) {
  const T = C.DECK_T;
  const under = -T / 2;
  // Baseplate, hanger, axle, kingpin. Small pieces, but the silhouette of a
  // skateboard from behind is mostly trucks and wheels.
  entries.push(box(TRUCK, 0.075, 0.008, 0.055, 0, under - 0.004, z));
  entries.push(box(TRUCK, 0.10, 0.026, 0.042, 0, under - 0.024, z + Math.sign(z) * -0.012));
  const axle = new THREE.CylinderGeometry(0.0045, 0.0045, 0.196, 6, 1);
  entries.push(piece(axle, TRUCK, 1, 1, 1, 0, under - C.TRUCK_H + 0.008, z, 0, 0, Math.PI / 2));
  entries.push(box(BOLT, 0.012, 0.03, 0.012, 0, under - 0.02, z + Math.sign(z) * 0.026));
  // Mounting bolts through the deck.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      entries.push(box(BOLT, 0.008, T * 1.9, 0.008, sx * 0.026, 0, z + sz * 0.019));
    }
  }
  return axle;
}

/** One axle's pair of wheels, merged so the pair spins as a single mesh. */
function buildWheels() {
  const entries = [];
  const cyl = new THREE.CylinderGeometry(C.WHEEL_R, C.WHEEL_R, C.WHEEL_W, 12, 1);
  const core = new THREE.CylinderGeometry(C.WHEEL_R * 0.42, C.WHEEL_R * 0.42, C.WHEEL_W + 0.004, 8, 1);
  for (const s of [-1, 1]) {
    const x = s * 0.088;
    entries.push(piece(cyl, WHEEL, 1, 1, 1, x, 0, 0, 0, 0, Math.PI / 2));
    // The dark core is what makes the spin visible at all: a plain urethane
    // cylinder rotating about its own axis looks completely static.
    entries.push(piece(core, BEARING, 1, 1, 1, x, 0, 0, 0, 0, Math.PI / 2));
  }
  const geo = merge(entries, 6);
  cyl.dispose();
  core.dispose();
  return geo;
}

export class Board {
  constructor() {
    this.group = new THREE.Group();

    this.material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 40,
      specular: 0x3a3d42,
    });

    const entries = buildDeck();
    const a1 = buildTruck(entries, C.WHEELBASE / 2);
    const a2 = buildTruck(entries, -C.WHEELBASE / 2);
    // uvScale 8: the deck is 20 cm across, so a texture repeating every three
    // metres — the park's scale — would not vary across it at all.
    const deckGeo = merge(entries, 8);
    a1.dispose();
    a2.dispose();

    this.deck = new THREE.Mesh(deckGeo, this.material);
    // The deck's origin is the middle of the board at deck level; lifting it by
    // the axle height puts the wheels' contact patch at the group's own origin,
    // which is the point physics tracks along the ground.
    this.deck.position.y = C.WHEEL_R + C.TRUCK_H;
    this.group.add(this.deck);

    const wheelGeo = buildWheels();
    this.axles = [];
    for (const z of [C.WHEELBASE / 2, -C.WHEELBASE / 2]) {
      const m = new THREE.Mesh(wheelGeo, this.material);
      m.position.set(0, C.WHEEL_R, z);
      this.group.add(m);
      this.axles.push(m);
    }

    this.spin = 0;
  }

  /**
   * Roll the wheels. ω = v / r, which at 8 m/s on 54 mm wheels is 296 rad/s —
   * genuinely 47 revolutions a second, so the dark bearing core smears into a
   * grey ring exactly as it does on a real board.
   */
  roll(dt, speed) {
    this.spin = (this.spin + (speed / C.WHEEL_R) * dt) % (Math.PI * 2);
    // The axles are mounted across the board, so the spin is about local X.
    for (const a of this.axles) a.rotation.x = this.spin;
  }
}

const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();

/**
 * Place the board from three loose ragdoll points, in world space.
 *
 * Three points are exactly enough to pin down a full orientation: the nose and
 * tail give the length, and the third — out to the heel side — gives the roll, so
 * a kicked-out board tumbles end over end *and* spins about its own length. Only
 * valid while the group is parented to the scene rather than to the ride frame.
 */
Board.prototype.poseFree = function poseFree(nose, tail, side) {
  _bz.subVectors(nose.p, tail.p).normalize();
  // Measured from the middle of the deck, then squared up against the length, so
  // the roll axis stays perpendicular however far the constraints have drifted.
  _bx.copy(nose.p).add(tail.p).multiplyScalar(0.5);
  _bx.subVectors(side.p, _bx);
  _bx.addScaledVector(_bz, -_bx.dot(_bz));
  if (_bx.lengthSq() < 1e-8) _bx.set(1, 0, 0);
  else _bx.normalize();
  _by.crossVectors(_bz, _bx);
  _bm.makeBasis(_bx, _by, _bz);
  this.group.quaternion.setFromRotationMatrix(_bm);
  // The points were sampled at deck height, and the group's origin is the wheels'
  // contact plane, so it hangs that far below the middle of the deck.
  this.group.position
    .copy(nose.p)
    .add(tail.p)
    .multiplyScalar(0.5)
    .addScaledVector(_by, -(C.WHEEL_R + C.TRUCK_H));
};
