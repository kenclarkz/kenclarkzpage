// The runner: a state machine plus a character built from merged box clusters.
//
// The player never moves through world space. It owns three scalars —
// `distance` along the path, `lateral` offset from the centreline, and jump
// height `y` — and main.js turns those into the world's transform. So the mesh
// here only ever animates in place.

import * as THREE from './three.js';
import { GLTFLoader } from './loaders.js';
import { box, merge } from './geo.js';
import * as C from './config.js';

const gltfLoader = new GLTFLoader();
let cachedModel = null;

export const RUNNING = 0;
export const JUMPING = 1;
export const SLIDING = 2;
export const DEAD = 3;

// How far back the runner reclines in a slide, in radians. Positive pitches
// backwards; see the note in animate().
//
// Kept well short of horizontal on purpose. The camera sits above and behind,
// so a fully flat slide foreshortens into an unreadable blob — around 35
// degrees is the most lean that still shows a silhouette from back there.
const SLIDE_PITCH = 0.65;

// One material for the whole character: every part carries its colour in the
// vertex attribute, so the pieces below cost nothing extra to author — and a
// skin change is a geometry rebuild rather than a new material, which keeps
// every skin on the same already-compiled shader.
const SKIN_MAT = new THREE.MeshPhongMaterial({
  vertexColors: true,
  shininess: 12,
  specular: 0x2a2018,
});

/**
 * A limb, with the pivot baked into the geometry so `rotation.x` swings from
 * the joint with no nested empties to keep in sync.
 */
function limb(color, w, h, d, footColor, fw, fh, fd, fz) {
  const parts = [box(color, w, h, d, 0, -h / 2, 0)];
  if (footColor !== undefined) parts.push(box(footColor, fw, fh, fd, 0, -h - fh / 2 + 0.02, fz));
  return merge(parts, 1);
}

/** Every geometry the character is made of, in one palette's colours. */
function buildGeometries(c) {
  return {
    torso: merge(
      [
        box(c.shirt, 0.5, 0.7, 0.3, 0, 0, 0),
        box(c.shirtDark, 0.58, 0.15, 0.32, 0, 0.3, 0),        // shoulder yoke
        box(c.gold, 0.54, 0.09, 0.34, 0, -0.28, 0),            // belt
        box(c.shirtDark, 0.13, 0.74, 0.33, 0.08, 0.02, 0, 0, 0, 0.32), // sash
        box(c.pack, 0.3, 0.34, 0.14, 0, 0.06, 0.21),           // pack
      ],
      1
    ),
    head: merge(
      [
        box(c.skin, 0.36, 0.36, 0.34, 0, 0, 0),
        box(c.hair, 0.38, 0.1, 0.36, 0, 0.205, 0.01),          // hair
        box(c.gold, 0.4, 0.09, 0.38, 0, 0.125, 0),             // headband, sits
        // proud of the hair so it catches the light from the camera's high angle
        box(c.dark, 0.07, 0.07, 0.04, -0.09, 0.01, -0.17),     // eyes
        box(c.dark, 0.07, 0.07, 0.04, 0.09, 0.01, -0.17),
      ],
      1
    ),
    arm: limb(c.skin, 0.16, 0.55, 0.16, c.skin, 0.19, 0.17, 0.19, 0),
    leg: limb(c.pants, 0.2, 0.65, 0.2, c.boot, 0.24, 0.17, 0.3, -0.04),
    // A trailing scarf. It costs one draw call and does more for the sense of
    // speed than anything else on the character.
    scarf: merge(
      [
        box(c.shirtDark, 0.22, 0.34, 0.08, 0, -0.17, 0),
        box(c.shirt, 0.17, 0.3, 0.07, 0, -0.46, 0.02),
      ],
      1
    ),
  };
}

function loadModelAsync() {
  if (cachedModel) return Promise.resolve(cachedModel);
  return new Promise((resolve) => {
    gltfLoader.load('vendor/models/character.glb', (gltf) => {
      cachedModel = gltf.scene;
      resolve(cachedModel);
    }, undefined, (err) => {
      console.warn('Failed to load character model:', err);
      resolve(null);
    });
  });
}

function buildCharacter(geos) {
  const root = new THREE.Group();

  const mk = (geo, x, y, z = 0) => {
    const m = new THREE.Mesh(geo, SKIN_MAT);
    m.position.set(x, y, z);
    root.add(m);
    return m;
  };

  const torso = mk(geos.torso, 0, 1.0);
  const head = mk(geos.head, 0, 1.53);
  const armL = mk(geos.arm, -0.33, 1.28);
  const armR = mk(geos.arm, 0.33, 1.28);
  const legL = mk(geos.leg, -0.14, 0.68);
  const legR = mk(geos.leg, 0.14, 0.68);
  const scarf = mk(geos.scarf, 0, 1.36, 0.19);

  return { root, torso, head, armL, armR, legL, legR, scarf };
}

export class Player {
  constructor(palette) {
    this.group = new THREE.Group();
    this.modelLoaded = false;
    this.modelBody = null;

    this.geos = buildGeometries(palette);
    const parts = buildCharacter(this.geos);
    this.parts = parts;
    this.body = parts.root;
    this.group.add(this.body);

    // A flat disc reads jump height far better than a real shadow map, and
    // costs one transparent draw call instead of a whole shadow pass.
    const shadowGeo = new THREE.CircleGeometry(0.5, 14);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false })
    );
    this.shadow.position.y = 0.02;
    this.group.add(this.shadow);

    this.reset();
    this.loadModel();
  }

  loadModel() {
    loadModelAsync().then((model) => {
      if (!model) return;
      const modelCopy = model.clone();
      modelCopy.traverse((node) => {
        if (node.isMesh) {
          node.material = SKIN_MAT;
          node.castShadow = false;
          node.receiveShadow = false;
        }
      });
      this.modelBody = modelCopy;
      this.modelLoaded = true;
      // Replace procedural body with model
      this.group.remove(this.body);
      this.group.add(this.modelBody);
      this.body = this.modelBody;
    });
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
    this.stumbleTimer = 0;
    this.onSound = this.onSound || null;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.group.position.set(0, 0, 0);
    this.shadow.visible = true;
  }

  /**
   * Swap the character's palette. For procedural character, rebuilds merged geometries.
   * For model-based character, this is a no-op since the model has its own appearance.
   */
  setSkin(palette) {
    if (this.modelLoaded) return;
    const next = buildGeometries(palette);
    const p = this.parts;
    p.torso.geometry = next.torso;
    p.head.geometry = next.head;
    p.armL.geometry = next.arm;
    p.armR.geometry = next.arm;
    p.legL.geometry = next.leg;
    p.legR.geometry = next.leg;
    p.scarf.geometry = next.scarf;
    for (const g of Object.values(this.geos)) g.dispose();
    this.geos = next;
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

  /** Set by main.js to route 'jump' | 'land' | 'slide' to the audio engine. */
  cue(name) {
    if (this.onSound) this.onSound(name);
  }

  jump() {
    if (this.state === DEAD) return;
    if (this.state === JUMPING) return;
    this.state = JUMPING;
    this.vy = C.JUMP_VY;
    this.slideTimer = 0;
    this.cue('jump');
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
    this.cue('slide');
  }

  /** A glancing hit: costs speed and balance, but not the run. */
  stumble() {
    if (this.state === DEAD) return;
    this.stumbleTimer = C.STUMBLE_TIME;
  }

  get isStumbling() {
    return this.stumbleTimer > 0;
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

    let speed = Math.min(C.SPEED_MAX, C.SPEED_0 + this.distance * C.SPEED_RAMP);
    if (this.stumbleTimer > 0) {
      // Losing ground is the point: this is what lets the guardian close in.
      this.stumbleTimer = Math.max(0, this.stumbleTimer - dt);
      speed *= C.STUMBLE_SPEED;
    }
    this.speed = speed;
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
        this.cue('land');
        if (this.slideOnLand) {
          this.slideOnLand = false;
          this.state = SLIDING;
          this.slideTimer = C.SLIDE_TIME;
          this.cue('slide');
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
    const usingModel = this.modelLoaded;

    if (this.state === SLIDING) {
      const ease = Math.min(1, dt * 16);
      this.body.rotation.x += (SLIDE_PITCH - this.body.rotation.x) * ease;
      this.body.position.y += (-0.26 - this.body.position.y) * ease;
      this.body.position.z += (-0.4 - this.body.position.z) * ease;
      if (!usingModel) {
        p.legL.rotation.x += (0.68 - p.legL.rotation.x) * ease;
        p.legR.rotation.x += (0.45 - p.legR.rotation.x) * ease;
        p.armL.rotation.x += (-0.72 - p.armL.rotation.x) * ease;
        p.armR.rotation.x += (0.42 - p.armR.rotation.x) * ease;
      }
    } else {
      this.body.rotation.x += (0 - this.body.rotation.x) * Math.min(1, dt * 14);
      this.body.position.y += (0 - this.body.position.y) * Math.min(1, dt * 14);
      this.body.position.z += (0 - this.body.position.z) * Math.min(1, dt * 14);

      if (this.state === JUMPING) {
        const tuck = Math.min(1, dt * 12);
        if (!usingModel) {
          p.legL.rotation.x += (0.95 - p.legL.rotation.x) * tuck;
          p.legR.rotation.x += (0.45 - p.legR.rotation.x) * tuck;
          p.armL.rotation.x += (-1.1 - p.armL.rotation.x) * tuck;
          p.armR.rotation.x += (-1.1 - p.armR.rotation.x) * tuck;
        }
      } else {
        this.runPhase += dt * this.speed * 0.62;
        if (!usingModel) {
          const sw = Math.sin(this.runPhase);
          p.legL.rotation.x = sw * 0.95;
          p.legR.rotation.x = -sw * 0.95;
          p.armR.rotation.x = sw * 0.75;
          p.armL.rotation.x = -sw * 0.75;
        }
      }
    }

    if (!usingModel) {
      const lift = Math.min(1.35, 0.4 + this.speed * 0.032);
      p.scarf.rotation.x = lift + Math.sin(this.runPhase * 2) * 0.16;
      p.scarf.rotation.z = lateralGap * 0.22 + Math.sin(this.runPhase * 1.4) * 0.1;
    } else {
      this.runPhase += dt * this.speed * 0.62;
    }

    // Bank into the lane change, and bob on the run cycle.
    this.body.rotation.z = lateralGap * -0.18;

    // A stumble rides on top of whatever pose is current, so it reads the same
    // whether it lands mid-run, mid-jump or mid-slide.
    if (this.stumbleTimer > 0) {
      const k = this.stumbleTimer / C.STUMBLE_TIME;
      const swing = Math.sin(k * Math.PI);
      this.body.rotation.x -= swing * 0.42;
      this.body.rotation.z += Math.sin(k * Math.PI * 3) * 0.16;
    }
    const bob = this.state === RUNNING ? Math.abs(Math.cos(this.runPhase)) * 0.06 : 0;
    this.group.position.y = this.y + bob;

    this.shadow.position.y = 0.02 - this.y - bob;
    this.shadow.material.opacity = Math.max(0, 0.4 * (1 - this.y / 2.2));
  }

  updateDeath(dt) {
    this.tumble += dt;
    const t = Math.min(1, this.tumble * 1.6);
    this.body.rotation.x = -t * 2.2;
    this.body.position.z = t * 0.9;
    this.group.position.y = this.y * (1 - t);
    this.shadow.material.opacity = Math.max(0, 0.4 * (1 - t));
  }
}
