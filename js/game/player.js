// The runner: a state machine plus a character built from six boxes.
//
// The player never moves through world space. It owns three scalars —
// `distance` along the path, `lateral` offset from the centreline, and jump
// height `y` — and main.js turns those into the world's transform. So the mesh
// here only ever animates in place.

import * as THREE from './three.js';
import * as C from './config.js';

export const RUNNING = 0;
export const JUMPING = 1;
export const SLIDING = 2;
export const DEAD = 3;

const SKIN = new THREE.MeshLambertMaterial({ color: 0xd9a06b });
const SHIRT = new THREE.MeshLambertMaterial({ color: 0xc0392b });
const PANTS = new THREE.MeshLambertMaterial({ color: 0x2f4257 });

function limbGeometry(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  // Bake the pivot into the geometry so rotation.x swings from the joint,
  // with no nested empties to keep in sync.
  g.translate(0, -h / 2, 0);
  return g;
}

function buildCharacter() {
  const root = new THREE.Group();

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), SHIRT);
  torso.position.y = 1.0;
  root.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.34), SKIN);
  head.position.y = 1.53;
  root.add(head);

  const armGeo = limbGeometry(0.16, 0.55, 0.16);
  const legGeo = limbGeometry(0.2, 0.65, 0.2);

  const mk = (geo, mat, x, y) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, 0);
    root.add(m);
    return m;
  };

  const armL = mk(armGeo, SKIN, -0.33, 1.28);
  const armR = mk(armGeo, SKIN, 0.33, 1.28);
  const legL = mk(legGeo, PANTS, -0.14, 0.68);
  const legR = mk(legGeo, PANTS, 0.14, 0.68);

  return { root, torso, head, armL, armR, legL, legR };
}

export class Player {
  constructor() {
    this.group = new THREE.Group();

    const parts = buildCharacter();
    this.parts = parts;
    this.body = parts.root;
    this.group.add(this.body);

    // A flat disc reads jump height far better than a real shadow map, and
    // costs one transparent draw call instead of a whole shadow pass.
    const shadowGeo = new THREE.CircleGeometry(0.46, 12);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.shadow.position.y = 0.02;
    this.group.add(this.shadow);

    this.reset();
  }

  reset() {
    this.state = RUNNING;
    this.deathReason = null;
    this.distance = 0;
    this.lateral = 0;
    this.targetLane = 0;
    this.y = 0;
    this.vy = 0;
    this.slideTimer = 0;
    this.slideOnLand = false;
    this.runPhase = 0;
    this.speed = C.SPEED_0;
    this.tumble = 0;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.group.position.set(0, 0, 0);
    this.shadow.visible = true;
  }

  get isSliding() {
    return this.state === SLIDING;
  }

  get isDead() {
    return this.state === DEAD;
  }

  moveLane(delta) {
    if (this.state === DEAD) return;
    this.targetLane = Math.max(-1, Math.min(1, this.targetLane + delta));
  }

  jump() {
    if (this.state === DEAD) return;
    if (this.state === JUMPING) return;
    this.state = JUMPING;
    this.vy = C.JUMP_VY;
    this.slideTimer = 0;
  }

  slide() {
    if (this.state === DEAD) return;
    if (this.state === JUMPING) {
      // Fast-fall, then slide on landing — same as the real game.
      this.vy = C.FAST_FALL_VY;
      this.slideOnLand = true;
      return;
    }
    this.state = SLIDING;
    this.slideTimer = C.SLIDE_TIME;
  }

  die(reason) {
    if (this.state === DEAD) return;
    this.state = DEAD;
    this.deathReason = reason;
    this.tumble = 0;
  }

  /** True once the death animation has played far enough to show the panel. */
  get settled() {
    return this.state === DEAD && this.tumble > 0.7;
  }

  update(dt) {
    if (this.state === DEAD) {
      this.updateDeath(dt);
      return;
    }

    this.speed = Math.min(C.SPEED_MAX, C.SPEED_0 + this.distance * C.SPEED_RAMP);
    this.distance += this.speed * dt;

    // Lateral is an independent tween rather than a state, so a lane change can
    // overlap a jump or a slide.
    const target = this.targetLane * C.LANE_W;
    const prevGap = target - this.lateral;
    this.lateral += prevGap * Math.min(1, dt * C.LATERAL_EASE);

    if (this.state === JUMPING) {
      this.vy += C.GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        if (this.slideOnLand) {
          this.slideOnLand = false;
          this.state = SLIDING;
          this.slideTimer = C.SLIDE_TIME;
        } else {
          this.state = RUNNING;
        }
      }
    } else if (this.state === SLIDING) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0) this.state = RUNNING;
    }

    this.animate(dt, prevGap);
  }

  animate(dt, lateralGap) {
    const p = this.parts;

    if (this.state === SLIDING) {
      this.body.rotation.x += (-1.15 - this.body.rotation.x) * Math.min(1, dt * 18);
      this.body.position.y += (0.32 - this.body.position.y) * Math.min(1, dt * 18);
      const tuck = Math.min(1, dt * 16);
      p.legL.rotation.x += (0.35 - p.legL.rotation.x) * tuck;
      p.legR.rotation.x += (0.2 - p.legR.rotation.x) * tuck;
      p.armL.rotation.x += (-0.5 - p.armL.rotation.x) * tuck;
      p.armR.rotation.x += (-0.5 - p.armR.rotation.x) * tuck;
    } else {
      this.body.rotation.x += (0 - this.body.rotation.x) * Math.min(1, dt * 14);
      this.body.position.y += (0 - this.body.position.y) * Math.min(1, dt * 14);

      if (this.state === JUMPING) {
        const tuck = Math.min(1, dt * 12);
        p.legL.rotation.x += (0.95 - p.legL.rotation.x) * tuck;
        p.legR.rotation.x += (0.45 - p.legR.rotation.x) * tuck;
        p.armL.rotation.x += (-1.1 - p.armL.rotation.x) * tuck;
        p.armR.rotation.x += (-1.1 - p.armR.rotation.x) * tuck;
      } else {
        this.runPhase += dt * this.speed * 0.62;
        const sw = Math.sin(this.runPhase);
        p.legL.rotation.x = sw * 0.95;
        p.legR.rotation.x = -sw * 0.95;
        p.armR.rotation.x = sw * 0.75;
        p.armL.rotation.x = -sw * 0.75;
      }
    }

    // Bank into the lane change, and bob on the run cycle.
    this.body.rotation.z = lateralGap * -0.18;
    const bob = this.state === RUNNING ? Math.abs(Math.cos(this.runPhase)) * 0.06 : 0;
    this.group.position.y = this.y + bob;

    this.shadow.position.y = 0.02 - this.y - bob;
    this.shadow.material.opacity = Math.max(0, 0.35 * (1 - this.y / 2.2));
  }

  updateDeath(dt) {
    this.tumble += dt;
    const t = Math.min(1, this.tumble * 1.6);
    this.body.rotation.x = -t * 2.2;
    this.body.position.z = t * 0.9;
    this.group.position.y = this.y * (1 - t);
    this.shadow.material.opacity = Math.max(0, 0.35 * (1 - t));
  }
}
