// The chase camera.
//
// Low, close, and behind — a skate game's camera sits at about the height of the
// rider's hips, because that is the angle from which a board's rotation is
// readable and an ollie looks like it left the ground. A camera up at head height
// makes every trick look flat.
//
// Two rules make it feel like a camera rather than a boom arm. It follows the
// direction of *travel* rather than the direction the board is pointing, so a
// spin whips the board round in front of the lens instead of dragging the whole
// world with it. And it springs towards where it wants to be, so it always
// arrives late — which is the only reason speed is legible at all.

import * as THREE from '../game/three.js';
import * as C from './config.js';

const _want = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class ChaseCamera {
  constructor(camera, park) {
    this.cam = camera;
    this.park = park;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.roll = 0;
    this.dist = C.CAM_DIST;
    this.height = C.CAM_HEIGHT;
    this.ready = false;
  }

  /** Drop the camera straight onto its mark, for a respawn or the first frame. */
  snap(ride) {
    this.yaw = ride.yaw;
    this.roll = 0;
    this.ready = false;
    this.update(ride, null, 1 / 60);
  }

  update(ride, ragdoll, dt) {
    const bailing = ride.bailed && ragdoll && ragdoll.active;

    // --- where to look ----------------------------------------------------
    if (bailing) {
      ragdoll.centre(_look);
      _look.y += 0.35;
    } else {
      _look.copy(ride.pos);
      _look.y += C.CAM_LOOK_H;
      // A little lookahead, along the ground only. Taking the vertical part of the
      // velocity too was tried and is wrong: on a ramp it lifts the aim by the
      // same amount it lifts the camera, and the skater slides off the bottom of
      // the frame. Seeing further up a transition is the *camera's* job, and the
      // tilt term below is what does it.
      const planarV = Math.hypot(ride.vel.x, ride.vel.z);
      if (planarV > 0.5) {
        const k = Math.min(1.0, planarV * 0.12) / planarV;
        _look.x += ride.vel.x * k;
        _look.z += ride.vel.z * k;
      }
    }
    const lag = bailing ? 3.4 : C.CAM_LAG;
    this.target.lerp(_look, this.ready ? 1 - Math.exp(-lag * dt) : 1);

    // --- which way to sit -------------------------------------------------
    // The direction of travel, not the board's heading: on a 180 the board turns
    // and the camera does not, which is exactly what makes the trick visible.
    let want = this.yaw;
    const v = ride.vel;
    const planar = Math.hypot(v.x, v.z);
    if (planar > 1.1) want = Math.atan2(v.x, v.z);
    // Too slow for the velocity to mean anything: sit behind the board, and
    // behind whichever end of it is leading if the rider is rolling fakie.
    else if (ride.grounded) want = ride.yaw + (ride.speed < -0.2 ? Math.PI : 0);
    // Shortest way round, so passing through south does not spin the world.
    const delta = C.angleDelta(this.yaw, want);
    this.yaw += delta * (this.ready ? 1 - Math.exp(-C.CAM_YAW_LAG * dt) : 1);

    // --- how far back -----------------------------------------------------
    const speed = ride.groundSpeed;
    const air = Math.max(0, ride.airHeight);
    // On a transition the board is tipped back towards the coping, and a camera
    // that stays at hip height ends up staring at the ramp. Lifting with the
    // tilt is what lets you see over the lip on the way up to it.
    const tilt = Math.max(0, 1 - ride.up.y);
    // Back off and lift with speed and with height, so a big air stays in frame.
    const wantDist = C.CAM_DIST + speed * 0.085 + air * 0.16 + tilt * 0.9 + (bailing ? 0.5 : 0);
    const wantHeight = C.CAM_HEIGHT + air * 0.30 + tilt * 1.9 + (bailing ? 0.5 : 0);
    this.dist += (wantDist - this.dist) * (1 - Math.exp(-2.4 * dt));
    this.height += (wantHeight - this.height) * (1 - Math.exp(-3.0 * dt));

    _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _want.copy(this.target).addScaledVector(_dir, -this.dist);
    _want.y = this.target.y + this.height - C.CAM_LOOK_H + 0.28;

    // Never inside the concrete: a camera that clips through a quarterpipe deck
    // is the one bug in a chase camera nobody forgives.
    const floor = this.park.heightAt(_want.x, _want.z) + 0.45;
    if (_want.y < floor) _want.y = floor;

    this.pos.lerp(_want, this.ready ? 1 - Math.exp(-C.CAM_LAG * dt) : 1);
    this.cam.position.copy(this.pos);
    this.cam.up.copy(_up);
    this.cam.lookAt(this.target);

    // A little roll into the carve. Small on purpose — enough to feel the lean,
    // not enough to make anyone seasick.
    const wantRoll = bailing ? 0 : -ride.lean * 0.16;
    this.roll += (wantRoll - this.roll) * (1 - Math.exp(-5 * dt));
    this.cam.rotateZ(this.roll);

    // Field of view carries the speed the position spring cannot.
    const t = Math.min(1, speed / C.CAM_SPEED_REF);
    const fov = C.CAM_FOV + t * C.CAM_FOV_GAIN;
    if (Math.abs(this.cam.fov - fov) > 0.02) {
      this.cam.fov += (fov - this.cam.fov) * (1 - Math.exp(-2.2 * dt));
      this.cam.updateProjectionMatrix();
    }

    this.ready = true;
  }
}
