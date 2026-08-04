// Birds. Pure atmosphere: a slow circuit above the park so the sky is not
// empty and height has something else in it to read against. No physics, no
// collision, no state that outlives the frame it is computed in — a flight
// path is three sines, and a wingbeat is a fourth.

import * as THREE from '../game/three.js';
import { box, merge } from '../game/geo.js';

function buildBody(color) {
  const entries = [
    box(color, 0.05, 0.045, 0.15, 0, 0, 0),
    box(color, 0.032, 0.032, 0.05, 0, 0.008, 0.09), // head
    box(0xd8b34a, 0.02, 0.018, 0.04, 0, -0.002, 0.13), // beak
  ];
  return merge(entries, 20);
}

/** One wing, built with its span already baked in on the given side — a
 * pivot mirrored by negative scale would also flip the sense of its own
 * rotation, which is the last thing two wings that are meant to flap in step
 * need. */
function buildWing(color, side) {
  return merge([box(color, 0.16, 0.006, 0.06, side * 0.08, 0, 0)], 20);
}

export class Bird {
  constructor(color = 0x24211c) {
    this.group = new THREE.Group();
    const material = new THREE.MeshPhongMaterial({ color, shininess: 3 });

    this.body = new THREE.Mesh(buildBody(color), material);
    this.group.add(this.body);

    this.wings = [-1, 1].map((side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.018, 0.006, 0);
      const m = new THREE.Mesh(buildWing(color, side), material);
      pivot.add(m);
      this.group.add(pivot);
      return pivot;
    });

    this.center = new THREE.Vector3();
    this.radius = 14;
    this.height = 11;
    this.speed = 0.24;
    this.phase = Math.random() * Math.PI * 2;
    this.flapRate = 6 + Math.random() * 2;
    this.bobPhase = Math.random() * Math.PI * 2;
  }

  /** Park it on a lazy ellipse around `center`, at `height`, going at `speed`. */
  configure(center, radius, height, speed, phase = 0) {
    this.center.copy(center);
    this.radius = radius;
    this.height = height;
    this.speed = speed;
    this.phase = phase;
  }

  update(t) {
    const a = this.phase + t * this.speed;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const x = this.center.x + cos * this.radius;
    const z = this.center.z + sin * this.radius * 0.72;
    const y = this.height + Math.sin(t * 0.5 + this.bobPhase) * 0.55;
    this.group.position.set(x, y, z);
    // Face the direction of travel: the derivative of the ellipse above.
    this.group.rotation.y = Math.atan2(-sin * this.speed, cos * this.speed * 0.72);
    // Built with the left wing's span at local -x and the right's at +x, so
    // lifting both together needs opposite rotation signs about Z.
    const flap = Math.sin(t * this.flapRate + this.phase) * 0.85 + 0.15;
    this.wings[0].rotation.z = -flap;
    this.wings[1].rotation.z = flap;
  }
}

const COLORS = [0x24211c, 0x342c20, 0x1c1a17];

/** A small flock, spread round the sky above one park. */
export function makeBirds(count = 3) {
  const birds = [];
  const center = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < count; i++) {
    const b = new Bird(COLORS[i % COLORS.length]);
    b.configure(
      center,
      13 + i * 6,
      8.5 + i * 2.6,
      (0.16 + i * 0.05) * (i % 2 === 0 ? 1 : -1),
      (i / count) * Math.PI * 2
    );
    birds.push(b);
  }
  return birds;
}
