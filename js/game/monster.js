// The temple guardian that hunts you after a stumble.
//
// The camera only ever sees this thing from behind, so it is designed entirely
// for a back view: the silhouette is a hunched back, sweeping horns and wide
// swinging arms, and the only bright detail is a row of glowing spine ridges.
// Nothing here would read from the front, and nothing needs to.
//
// Like the player it lives in scene space and never leaves it — only its Z
// changes, driven by how close the chase is.

import * as THREE from './three.js';
import { box, merge } from './geo.js';

const COL = {
  hide: 0x453730,
  hideDark: 0x2b211d,
  hideLight: 0x5c4a40,
  horn: 0xcbb994,
  claw: 0xe0d3b4,
  collar: 0xc9962e,
};

const EMBER = 0xff5a1e;

// How far off the runner's shoulder the guardian runs.
const SIDE_OFFSET = 1.45;

const BODY_MAT = new THREE.MeshPhongMaterial({
  vertexColors: true,
  shininess: 6,
  specular: 0x1a1512,
  // It spends its time behind the runner, outside the torch's reach, so a
  // little self-illumination keeps it from turning into a black cut-out.
  emissive: 0x1c1210,
});
const EMBER_MAT = new THREE.MeshBasicMaterial({ color: EMBER });

/** Torso, head, horns and the glowing ridges, as one hunched mass. */
function buildTrunk() {
  const e = [
    box(COL.hide, 1.5, 1.0, 1.15, 0, 1.5, 0),            // barrel chest
    box(COL.hideLight, 1.72, 0.46, 1.0, 0, 1.94, 0.06),  // shoulder mass
    box(COL.hide, 1.05, 0.72, 0.9, 0, 0.95, 0.05),       // gut
    box(COL.collar, 1.56, 0.16, 1.04, 0, 1.68, 0.04),    // collar band
    box(COL.hideDark, 0.72, 0.62, 0.66, 0, 2.16, 0.24),  // head, sunk into the shoulders
    box(COL.hideDark, 0.5, 0.26, 0.3, 0, 1.98, -0.16),   // muzzle
  ];
  // Horns, curving up and back off the skull. Kept short and close to the head
  // — swept out wide they stop reading as horns and become floating slabs.
  for (const side of [-1, 1]) {
    e.push(box(COL.horn, 0.12, 0.3, 0.12, side * 0.24, 2.42, 0.24, 0, 0, side * 0.3));
    e.push(box(COL.horn, 0.1, 0.2, 0.1, side * 0.35, 2.62, 0.3, 0, 0, side * 0.62));
  }
  return merge(e, 1);
}

/** The spine ridges, self-lit so the shape stays legible in the dark. */
function buildRidges() {
  const e = [];
  // Small and spaced. These are unlit, so they hold full brightness at any
  // distance — a continuous ridge here turns into one solid orange bar the
  // moment the thing is close.
  const rows = [
    [2.3, 0.1],
    [2.02, 0.13],
    [1.72, 0.14],
    [1.4, 0.12],
  ];
  for (const [y, s] of rows) e.push(box(EMBER, s, s * 1.3, s, 0, y, 0.55));
  // Eyes, visible when it turns into the frame at the edges.
  for (const side of [-1, 1]) e.push(box(EMBER, 0.1, 0.08, 0.06, side * 0.17, 2.2, -0.06));
  return merge(e, 1);
}

/** A limb hanging from its pivot, so rotation.x swings it from the joint. */
function buildArm() {
  return merge(
    [
      box(COL.hide, 0.36, 0.8, 0.36, 0, -0.4, 0),
      box(COL.hideLight, 0.32, 0.5, 0.32, 0, -1.02, 0.04),
      box(COL.claw, 0.38, 0.22, 0.42, 0, -1.36, 0.02),   // fist
    ],
    1
  );
}

function buildLeg() {
  return merge(
    [
      box(COL.hideDark, 0.42, 0.72, 0.44, 0, -0.36, 0),
      box(COL.hide, 0.36, 0.3, 0.5, 0, -0.86, -0.06),    // foot
    ],
    1
  );
}

export class Monster {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;

    const trunk = new THREE.Mesh(buildTrunk(), BODY_MAT);
    this.trunk = trunk;
    this.group.add(trunk);

    const ridges = new THREE.Mesh(buildRidges(), EMBER_MAT);
    trunk.add(ridges); // rides the trunk's lurch
    this.ridges = ridges;

    const armGeo = buildArm();
    const legGeo = buildLeg();
    const mk = (geo, x, y) => {
      const m = new THREE.Mesh(geo, BODY_MAT);
      m.position.set(x, y, 0);
      this.group.add(m);
      return m;
    };
    this.armL = mk(armGeo, -0.92, 1.98);
    this.armR = mk(armGeo, 0.92, 1.98);
    this.legL = mk(legGeo, -0.36, 0.95);
    this.legR = mk(legGeo, 0.36, 0.95);

    // Built at a scale that reads on its own, then brought down to something
    // that fits in frame alongside the runner rather than swallowing them.
    this.group.scale.setScalar(0.82);

    this.phase = 0;
    this.lateral = 0;
  }

  reset() {
    this.phase = 0;
    this.lateral = 0;
    this.group.visible = false;
  }

  /**
   * Pose the guardian for a throwaway warm-up render.
   *
   * Its two materials are unlike any others in the scene, so the first frame it
   * appears on is the frame the GPU compiles and links their programs and
   * uploads their buffers — measured at ~160 ms, which lands as a hard stall
   * exactly when the chase starts. Drawing it once during load moves that cost
   * somewhere nobody is playing.
   *
   * It is posed in full view on purpose: a fragment shader is only guaranteed
   * to be compiled once fragments actually shade, so parking it in the fog or
   * behind the camera risks the driver deferring the work to the frame that
   * matters. See the paired render calls in the boot sequence — the warm-up
   * frame is overwritten before the browser ever composites the canvas.
   */
  warmUp() {
    this.group.visible = true;
    this.group.position.set(0, 0, 2);
    this.trunk.rotation.set(0, 0, 0);
  }

  /** Which side of the runner it hunts down, and how far out. */
  station(lateral, lunge = 0) {
    const side = lateral > 0 ? -1 : 1;
    return lateral + side * (SIDE_OFFSET - lunge * 1.3);
  }

  /**
   * A chase is starting. Snap to the flank rather than easing out to it: the
   * ease takes about a second, and for that second it would be sitting directly
   * behind the runner with the camera looking straight through it.
   */
  enter(lateral) {
    this.lateral = this.station(lateral);
  }

  /**
   * @param {number} dt
   * @param {number} speed    the runner's speed, which sets the gait
   * @param {number} near     1 = right on your heels, 0 = gone
   * @param {number} lateral  the runner's lane offset, followed with a lag
   * @param {number} lunge    0..1, the pounce as it catches you
   */
  update(dt, speed, near, lateral, lunge) {
    if (near <= 0 && lunge <= 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Hunt down whichever side of the runner has more room, and weave lazily
    // across when they switch lanes.
    //
    // The offset is not decoration. The camera is directly behind the player,
    // so anything sharing their lane and nearer the lens hides them completely
    // — and not being able to see your own runner is worse than not being able
    // to see what is chasing them.
    this.lateral += (this.station(lateral, lunge) - this.lateral) * Math.min(1, dt * 2.2);

    // Nearer the camera means bigger, and the camera is only a few metres back:
    // at full menace this sits just behind the runner, not up against the lens.
    const z = 2.0 + (1 - near) * 7.5 + lunge * 1.4;
    this.group.position.set(this.lateral, 0, z);

    this.phase += dt * Math.max(speed, 6) * 0.5;
    const sw = Math.sin(this.phase);

    // A heavy four-beat lurch: shoulders roll, body drops on each footfall.
    this.trunk.rotation.z = sw * 0.11;
    this.trunk.rotation.x = -0.18 + Math.abs(Math.cos(this.phase)) * 0.09;
    this.group.position.y = Math.abs(Math.sin(this.phase * 2)) * 0.14 - lunge * 0.2;

    this.armL.rotation.x = sw * 1.15 - 0.35;
    this.armR.rotation.x = -sw * 1.15 - 0.35;
    this.armL.rotation.z = 0.16;
    this.armR.rotation.z = -0.16;
    this.legL.rotation.x = -sw * 0.85;
    this.legR.rotation.x = sw * 0.85;

    // Reaching, as it closes the last of the gap.
    if (lunge > 0) {
      const reach = -1.5 * lunge;
      this.armL.rotation.x = reach;
      this.armR.rotation.x = reach;
      this.trunk.rotation.x = -0.5 * lunge;
    }
  }
}
