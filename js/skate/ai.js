// Ambient AI skaters.
//
// Each one gets exactly the rig the player gets — its own Board, its own
// Skater, its own Ride — driven not by Input but by a pursuit controller a
// few lines long: steer at the next waypoint, push to keep the speed up, and
// pop a trick every few seconds when the ground underfoot allows it. Every
// ollie a bot lands is landed by the same physics the player's tricks are, so
// a bystander at the top of the ramp is proof the model works, not a fake.
//
// What it does not get is a ragdoll. A bail freezes the last posed frame for
// a moment — a wipeout, held — and then the bot reappears at its next
// waypoint. Cheap, and in a park with real skaters in it, someone eating it
// and getting back up is exactly the right note.

import * as C from './config.js';
import { Board } from './board.js';
import { Skater, PALETTE } from './skater.js';
import { Ride, GROUND, BAIL } from './physics.js';

const TRICKS = ['ollie', 'kickflip', 'heelflip', 'shuvit', 'fsshuvit'];

/** A handful of outfits, so a park full of bots does not look like one clone. */
const PALETTES = [
  { ...PALETTE, shirt: 0xc65b4a, sleeve: 0x9a4638, pants: 0x2b2f38, cap: 0x7a2e22 },
  { ...PALETTE, shirt: 0x3f7fb0, sleeve: 0x33648c, pants: 0x22242c, cap: 0x244a63 },
  { ...PALETTE, shirt: 0x5aa15c, sleeve: 0x477e49, pants: 0x2a3324, cap: 0x35502f },
  { ...PALETTE, shirt: 0xcf9c3e, sleeve: 0xa87c30, pants: 0x33291a, cap: 0x7a5a20 },
];

const BAIL_WAIT = 1.6;      // seconds a wipeout is held before the reset
const ARRIVE_R = 2.2;       // metres from a waypoint that counts as "there"
const CRUISE_SPEED = 5.2;   // m/s a bot tries to hold on the flat

export class AiSkater {
  constructor(park, paletteIndex, patrol, startIdx) {
    this.board = new Board();
    this.skater = new Skater(PALETTES[paletteIndex % PALETTES.length]);
    this.ride = new Ride(park, this.board, this.skater);
    this.patrol = patrol;
    this.target = startIdx % patrol.length;
    this.bailWait = 0;
    this.trickCool = 1.5 + Math.random() * 3;
    this.pushCool = Math.random() * 0.4;
    this.toStart();
  }

  /** Drop onto the patrol loop, facing the next point along it. */
  toStart() {
    const wp = this.patrol[this.target];
    const next = this.patrol[(this.target + 1) % this.patrol.length];
    const yaw = Math.atan2(next.x - wp.x, next.z - wp.z);
    this.ride.reset({ x: wp.x, y: 0, z: wp.z, yaw });
  }

  /** Hand the bot a new park to tour — a fresh patrol loop, a fresh spawn. */
  setPark(park, paletteIndex) {
    this.ride.park = park;
    this.patrol = park.patrol;
    this.target = paletteIndex % this.patrol.length;
    this.bailWait = 0;
    this.trickCool = 1.5 + Math.random() * 3;
    this.toStart();
  }

  step(dt) {
    const ride = this.ride;
    if (ride.mode === BAIL) {
      this.bailWait += dt;
      if (this.bailWait > BAIL_WAIT) {
        this.bailWait = 0;
        this.target = (this.target + 1) % this.patrol.length;
        this.toStart();
      }
      return;
    }

    const wp = this.patrol[this.target];
    const dx = wp.x - ride.pos.x;
    const dz = wp.z - ride.pos.z;
    if (dx * dx + dz * dz < ARRIVE_R * ARRIVE_R) {
      this.target = (this.target + 1) % this.patrol.length;
    }

    const wantYaw = Math.atan2(dx, dz);
    const steer = C.clamp(C.angleDelta(ride.yaw, wantYaw) / 1.1, -1, 1);
    const input = { steer, charge: false, slide: false, push: false, trick: null, trickCharge: undefined };

    if (this.pushCool > 0) this.pushCool -= dt;
    if (ride.mode === GROUND && Math.abs(ride.speed) < CRUISE_SPEED && this.pushCool <= 0) {
      input.push = true;
      this.pushCool = 0.5;
    }

    if (ride.mode === GROUND && !ride.grind && !ride.manual) {
      this.trickCool -= dt;
      if (this.trickCool <= 0 && Math.abs(ride.speed) > 2.4) {
        input.trick = TRICKS[(Math.random() * TRICKS.length) | 0];
        input.trickCharge = 0.5 + Math.random() * 0.4;
        this.trickCool = 3 + Math.random() * 4;
      }
    }

    ride.update(dt, input);
  }
}

/** A small crowd, spread evenly around the patrol loop so they start apart. */
export function makeAiSkaters(park, count = 3) {
  const bots = [];
  for (let i = 0; i < count; i++) {
    const startIdx = Math.round((i * park.patrol.length) / count);
    bots.push(new AiSkater(park, i, park.patrol, startIdx));
  }
  return bots;
}
