// The skatepark: its geometry, and the surface query the physics rides on.
//
// Every obstacle is defined once, as a spec object, and each spec knows how to
// do two things: answer "how high is the ground at (x, z), and which way is it
// facing", and hand back merge entries for its mesh. That pairing is the whole
// design. A park drawn by one piece of code and collided against by another is a
// park where the transition you can see is not the transition you are riding,
// and there is no way to tune your way out of that.
//
// The surface query is a height field: the highest feature at (x, z) wins.
// Which means the sides of anything raised are not surfaces at all — they are a
// discontinuity, and physics.js reads a step up it cannot roll over as a wall to
// hit. That is exactly how a curb behaves.
//
// Below the primitives sits `PARKS`: one spec object per map. Every map shares
// the same pad, fence and dirt — only the obstacles inside `build()` change —
// which is what lets six very different-feeling parks stay one small file.

import * as THREE from '../game/three.js';
import { box, piece, merge } from '../game/geo.js';

// --- palette --------------------------------------------------------------
const CONCRETE = 0xb4afa2;
const CONCRETE_DARK = 0x9a9587;
const RAMP = 0x8c8578;      // skatelite: darker and smoother than the flat
const COPING = 0xc2c6cc;    // galvanised steel, polished by decades of grinds
const STEEL = 0x9fa5ad;
const PAINT = 0xd6c064;
const DIRT = 0x7d6c50;
const CURB = 0xc6c1b2;

// Surface kinds, so physics can tell paved from dirt and flat from transition.
export const SMOOTH = 0;
export const ROUGH = 1;
export const TRANSITION = 2;

// --- park extent ------------------------------------------------------------
// Every map shares this footprint. Six differently-shaped parks on six
// differently-sized pads would each need their own fence, camera bounds and
// AI patrol logic; one shared size means only the obstacles inside it differ.
export const PARK_X = 26;
export const PARK_Z = 30;

// The dirt sits a couple of centimetres below the concrete pad. Not decoration:
// sample() resolves ties by keeping the first feature it saw, so two surfaces at
// exactly y = 0 would leave the whole park reading as dirt.
const DIRT_Y = -0.02;

// --- feature types --------------------------------------------------------
// Each has at(x, z, out) -> boolean, filling `out` only on a hit, and
// build(entries) pushing its merge entries.

class Slab {
  /** A flat top: the ground, a platform deck, a ledge, a manual pad. */
  constructor(x0, x1, z0, z1, y, kind = SMOOTH, color = CONCRETE, depth = 0.4) {
    Object.assign(this, { x0, x1, z0, z1, y, kind, color, depth });
  }

  at(x, z, out) {
    if (x < this.x0 || x > this.x1 || z < this.z0 || z > this.z1) return false;
    out.y = this.y;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.kind = this.kind;
    return true;
  }

  build(entries) {
    entries.push(
      box(
        this.color,
        this.x1 - this.x0,
        this.depth,
        this.z1 - this.z0,
        (this.x0 + this.x1) / 2,
        this.y - this.depth / 2,
        (this.z0 + this.z1) / 2
      )
    );
  }
}

/**
 * A straight ramp. `axis` is the one the slope runs along; the surface rises
 * linearly from y0 at the low end of that axis to y1 at the high end.
 */
class Bank {
  constructor(x0, x1, z0, z1, axis, y0, y1, color = RAMP) {
    Object.assign(this, { x0, x1, z0, z1, axis, y0, y1, color });
    this.len = axis === 'x' ? x1 - x0 : z1 - z0;
    // Precomputed: it is the normal for every point on the ramp.
    const dy = (y1 - y0) / this.len;
    const inv = 1 / Math.hypot(dy, 1);
    this.slopeN = -dy * inv;
    this.upN = inv;
  }

  at(x, z, out) {
    if (x < this.x0 || x > this.x1 || z < this.z0 || z > this.z1) return false;
    const t = this.axis === 'x' ? (x - this.x0) / this.len : (z - this.z0) / this.len;
    out.y = this.y0 + t * (this.y1 - this.y0);
    out.nx = this.axis === 'x' ? this.slopeN : 0;
    out.nz = this.axis === 'z' ? this.slopeN : 0;
    out.ny = this.upN;
    out.kind = SMOOTH;
    return true;
  }

  build(entries) {
    // The skirt below zero keeps the ramp looking solid where it meets ground.
    profile(
      entries,
      [[0, -0.6], [this.len, -0.6], [this.len, this.y1], [0, this.y0]],
      this.axis,
      this.axis === 'x' ? this.x0 : this.z0,
      1,
      this.axis === 'x' ? this.z0 : this.x0,
      this.axis === 'x' ? this.z1 : this.x1,
      this.color
    );
  }
}

/**
 * A quarterpipe. The transition is a circular arc tangent to the flat at its
 * base, which is what makes a real one rideable: the curve has to start at zero
 * slope, or the bottom of the ramp would be a kink that stops you dead.
 *
 * With the arc's centre directly above the base point, the surface is
 * y = R - sqrt(R² - u²) for u measured from the base into the ramp — vertical at
 * u = R, so H is kept a good way under R to stop the lip going past anything a
 * skater would actually ride up.
 */
class Quarter {
  constructor(c0, c1, base, axis, sign, R, H, deck = 0, color = RAMP) {
    Object.assign(this, { c0, c1, base, axis, sign, R, H, deck, color });
    // Where the arc reaches deck height, from y = R - sqrt(R² - u²).
    this.uTop = Math.sqrt(Math.max(0, 2 * R * H - H * H));
    // Cross extent, named as x0/x1 or z0/z1 depending on which way it runs.
    if (axis === 'z') {
      this.x0 = c0;
      this.x1 = c1;
    } else {
      this.z0 = c0;
      this.z1 = c1;
    }
  }

  at(x, z, out) {
    const c = this.axis === 'z' ? x : z;
    if (c < this.c0 || c > this.c1) return false;
    const u = this.sign * ((this.axis === 'z' ? z : x) - this.base);
    if (u < 0 || u > this.uTop) return false;
    const root = Math.sqrt(Math.max(1e-6, this.R * this.R - u * u));
    out.y = this.R - root;
    // The normal points from the surface back towards the arc's centre, so it
    // rolls from straight up at the base to nearly horizontal at the lip.
    const nu = (-u / this.R) * this.sign;
    out.nx = this.axis === 'x' ? nu : 0;
    out.nz = this.axis === 'z' ? nu : 0;
    out.ny = root / this.R;
    out.kind = TRANSITION;
    return true;
  }

  build(entries) {
    const p = [[0, -0.6]];
    const STEPS = 18;
    for (let i = 0; i <= STEPS; i++) {
      const u = (this.uTop * i) / STEPS;
      p.push([u, this.R - Math.sqrt(Math.max(0, this.R * this.R - u * u))]);
    }
    // `deck` extends the top as a platform. Kickers set it to zero, so the lip
    // is a clean edge with nothing behind it to walk on that the height field
    // does not know about.
    if (this.deck > 0) p.push([this.uTop + this.deck, this.H]);
    p.push([this.uTop + this.deck, -0.6]);
    profile(entries, p, this.axis, this.base, this.sign, this.c0, this.c1, this.color);
  }
}

/** A stair set. Riding it is a bail; the handrail beside it is the point. */
class Stairs {
  constructor(c0, c1, top, axis, sign, steps, rise, run) {
    Object.assign(this, { c0, c1, top, axis, sign, steps, rise, run });
    this.yTop = steps * rise;
    this.len = steps * run;
  }

  at(x, z, out) {
    const c = this.axis === 'z' ? x : z;
    if (c < this.c0 || c > this.c1) return false;
    const u = this.sign * ((this.axis === 'z' ? z : x) - this.top);
    if (u < 0 || u > this.len) return false;
    const i = Math.min(this.steps - 1, Math.floor(u / this.run));
    out.y = this.yTop - (i + 1) * this.rise;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.kind = SMOOTH;
    return true;
  }

  build(entries) {
    const p = [[0, -0.6], [0, this.yTop]];
    for (let i = 0; i < this.steps; i++) {
      const y = this.yTop - (i + 1) * this.rise;
      p.push([i * this.run, y], [(i + 1) * this.run, y]);
    }
    p.push([this.len, -0.6]);
    profile(entries, p, this.axis, this.top, this.sign, this.c0, this.c1, CONCRETE_DARK);
  }
}

/**
 * Extrude a (distance-along-axis, height) profile across a feature's width.
 *
 * ExtrudeGeometry builds its shape in XY and pushes it along +Z, so the yaw
 * below is what maps the profile's first axis onto the world axis the feature
 * runs along, in the direction `sign` points.
 */
function profile(entries, points, axis, base, sign, c0, c1, color) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const width = c1 - c0;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -width / 2); // so placement is about the feature's middle

  const yaw = axis === 'z' ? (sign > 0 ? -Math.PI / 2 : Math.PI / 2) : sign > 0 ? 0 : Math.PI;
  const cx = axis === 'z' ? (c0 + c1) / 2 : base;
  const cz = axis === 'z' ? base : (c0 + c1) / 2;
  entries.push(piece(geo, color, 1, 1, 1, cx, 0, cz, 0, yaw, 0));
}

/**
 * Free the one-off geometries an entry list was built from. Has to run after the
 * merge, not before it: merge() reads every source it is handed.
 */
function disposeSources(entries) {
  for (const e of entries) if (e.geo.type !== 'BoxGeometry') e.geo.dispose();
}

// --- grindable lines ------------------------------------------------------
/**
 * Anything you can lock onto: round rails, ledge edges, and coping. Held as a
 * segment plus a precomputed unit direction, because grind detection runs every
 * step against every line and the normalising would otherwise dominate it.
 */
class Grind {
  constructor(ax, ay, az, bx, by, bz, kind, radius) {
    this.a = new THREE.Vector3(ax, ay, az);
    this.b = new THREE.Vector3(bx, by, bz);
    this.dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
    this.len = this.dir.length();
    this.dir.multiplyScalar(1 / this.len);
    this.kind = kind; // 'rail' | 'ledge' | 'coping'
    this.radius = radius;
  }

  /**
   * How far along the rail the closest point to p lies. Clamped to the segment,
   * so running off the end of a rail ends the grind instead of extrapolating
   * one into thin air.
   */
  project(p) {
    const t =
      (p.x - this.a.x) * this.dir.x + (p.y - this.a.y) * this.dir.y + (p.z - this.a.z) * this.dir.z;
    return t < 0 ? 0 : t > this.len ? this.len : t;
  }

  pointAt(t, out) {
    return out.set(
      this.a.x + this.dir.x * t,
      this.a.y + this.dir.y * t,
      this.a.z + this.dir.z * t
    );
  }
}

export class Park {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.blurb = def.blurb;
    this.spawn = def.spawn;
    this.patrol = def.patrol;
    this.logos = def.logos;

    this.features = [];
    this.grinds = [];
    this.rails = [];   // mesh specs, filled by rail()
    this.copings = [];
    this.group = new THREE.Group();
    this._hit = { y: 0, nx: 0, ny: 1, nz: 0, kind: SMOOTH };
    this._probe = { y: 0, nx: 0, ny: 1, nz: 0, kind: SMOOTH };

    this.layout();
    this.buildMeshes();
  }

  add(f) {
    this.features.push(f);
    return f;
  }

  /**
   * Every map starts here: dirt out to the horizon, then the paved pad on top
   * of it. Riding off the concrete is punished with friction rather than with
   * an invisible wall. What sits on the pad is the one thing that changes
   * between maps, and that is entirely `def.build`'s job.
   */
  layout() {
    this.add(new Slab(-200, 200, -200, 200, DIRT_Y, ROUGH, DIRT, 1.2));
    this.add(new Slab(-PARK_X, PARK_X, -PARK_Z, PARK_Z, 0, SMOOTH, CONCRETE, 0.55));
    this.def.build(this);
  }

  /** A round grindable bar, plus the posts that hold it up. */
  rail(ax, ay, az, bx, by, bz, radius) {
    this.grinds.push(new Grind(ax, ay, az, bx, by, bz, 'rail', radius));
    this.rails.push({ ax, ay, az, bx, by, bz, radius });
  }

  /** Steel pipe let into a ramp's lip. Grindable, and it reads as a real park. */
  coping(x0, x1, z, y) {
    this.grinds.push(new Grind(x0, y, z, x1, y, z, 'coping', 0.032));
    this.copings.push({ x0, x1, z0: z, z1: z, y });
  }

  /** As coping(), but for a wall that runs along z instead of x. */
  copingZ(x, y, z0, z1) {
    this.grinds.push(new Grind(x, y, z0, x, y, z1, 'coping', 0.032));
    this.copings.push({ x0: x, x1: x, z0, z1, y });
  }

  /** A ledge edge — the grindable line only; the platform is a Slab of its own. */
  ledge(ax, ay, az, bx, by, bz) {
    this.grinds.push(new Grind(ax, ay, az, bx, by, bz, 'ledge', 0.05));
  }

  // --- the surface query -------------------------------------------------
  /**
   * Highest surface at (x, z). Fills `out` with y, the unit normal and the
   * surface kind, and returns it.
   *
   * This is the single function the entire ride model stands on, so it
   * allocates nothing, and it does not stop at the first feature it finds — the
   * tallest has to win, or a ledge beside a ramp would put you inside the ledge.
   */
  sample(x, z, out) {
    const hit = this._hit;
    out.y = -1e9;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.kind = SMOOTH;
    const fs = this.features;
    for (let i = 0; i < fs.length; i++) {
      if (!fs[i].at(x, z, hit)) continue;
      if (hit.y <= out.y) continue;
      out.y = hit.y;
      out.nx = hit.nx;
      out.ny = hit.ny;
      out.nz = hit.nz;
      out.kind = hit.kind;
    }
    return out;
  }

  /** Height only, for the things that do not care which way the ground faces. */
  heightAt(x, z) {
    return this.sample(x, z, this._probe).y;
  }

  /**
   * The best grind line for a board at `pos` heading along `heading`.
   *
   * "Best" is nearest in the horizontal plane, among lines whose height is
   * within reach and whose direction is not too far off the board's — a rail you
   * are crossing at right angles is not a rail you can lock onto, it is one you
   * slam into.
   */
  findGrind(pos, heading, snapXZ, snapY, maxAlign, out) {
    let best = null;
    let bestDist = Infinity;
    for (const g of this.grinds) {
      const t = g.project(pos);
      const px = g.a.x + g.dir.x * t;
      const py = g.a.y + g.dir.y * t;
      const pz = g.a.z + g.dir.z * t;
      const dxz = Math.hypot(pos.x - px, pos.z - pz);
      if (dxz > snapXZ || dxz >= bestDist) continue;
      const dy = pos.y - py;
      // Generous from above (you drop onto rails), tight from below.
      if (dy > snapY || dy < -snapY * 0.45) continue;
      // Rails are two-way: a heading 180° off the stored direction is a
      // perfectly good grind, ridden the other way.
      const dot = Math.abs(heading.x * g.dir.x + heading.z * g.dir.z);
      if (Math.acos(Math.min(1, dot)) > maxAlign) continue;
      bestDist = dxz;
      best = g;
      out.t = t;
      out.px = px;
      out.py = py;
      out.pz = pz;
    }
    out.rail = best;
    return best;
  }

  // --- meshes ------------------------------------------------------------
  buildMeshes() {
    const entries = [];
    for (const f of this.features) f.build(entries);

    // Painted lines on the flat, purely so that speed reads. Without something
    // regular on the ground, open concrete gives the eye nothing to measure
    // motion against and 8 m/s looks like 3.
    for (let z = -18; z <= 18; z += 6) entries.push(box(PAINT, 44, 0.012, 0.09, 0, 0.006, z));
    entries.push(box(PAINT, 0.09, 0.012, 40, 0, 0.006, 0));

    // Curbs around the paved edge. They read as a boundary, and the height field
    // makes them something to ollie rather than something to roll over.
    const h = 0.14;
    entries.push(box(CURB, PARK_X * 2 + 0.6, h, 0.3, 0, h / 2, -PARK_Z - 0.15));
    entries.push(box(CURB, PARK_X * 2 + 0.6, h, 0.3, 0, h / 2, PARK_Z + 0.15));
    entries.push(box(CURB, 0.3, h, PARK_Z * 2, -PARK_X - 0.15, h / 2, 0));
    entries.push(box(CURB, 0.3, h, PARK_Z * 2, PARK_X + 0.15, h / 2, 0));

    for (const r of this.rails) {
      tube(entries, STEEL, r.ax, r.ay, r.az, r.bx, r.by, r.bz, r.radius);
      const dx = r.bx - r.ax;
      const dy = r.by - r.ay;
      const dz = r.bz - r.az;
      const len = Math.hypot(dx, dy, dz);
      const posts = Math.max(2, Math.round(len / 2.2));
      for (let i = 0; i < posts; i++) {
        const t = i / (posts - 1);
        const px = r.ax + dx * t;
        const py = r.ay + dy * t;
        const pz = r.az + dz * t;
        const ground = this.heightAt(px, pz);
        const ph = Math.max(0.05, py - ground - r.radius);
        entries.push(box(STEEL, 0.05, ph, 0.05, px, ground + ph / 2, pz));
      }
    }

    for (const c of this.copings) {
      // Sunk a centimetre into the lip, the way coping is actually set.
      tube(entries, COPING, c.x0, c.y - 0.012, c.z0, c.x1, c.y - 0.012, c.z1, 0.032);
    }

    const geo = merge(entries, 0.35);
    disposeSources(entries);
    this.material = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 9, specular: 0x222428 });
    const mesh = new THREE.Mesh(geo, this.material);
    // One draw call for the whole park; deciding whether to cull it is more
    // expensive than the chance of ever being able to.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.mesh = mesh;

    this.buildScenery();
  }

  /** Fences, trees and lamp posts. None of it is collided against. */
  buildScenery() {
    const entries = [];
    const FENCE = 0x6f7580;
    for (const side of [-1, 1]) {
      for (let x = -PARK_X; x <= PARK_X; x += 2.4) {
        entries.push(box(FENCE, 0.06, 2.2, 0.06, x, 1.1, side * (PARK_Z + 1.2)));
      }
      for (const y of [1.1, 2.15]) {
        entries.push(box(FENCE, PARK_X * 2, 0.05, 0.05, 0, y, side * (PARK_Z + 1.2)));
      }
      for (let z = -PARK_Z; z <= PARK_Z; z += 2.4) {
        entries.push(box(FENCE, 0.06, 2.2, 0.06, side * (PARK_X + 1.2), 1.1, z));
      }
      for (const y of [1.1, 2.15]) {
        entries.push(box(FENCE, 0.05, 0.05, PARK_Z * 2, side * (PARK_X + 1.2), y, 0));
      }
    }

    // Trees beyond the fence. Crude, but they give the horizon a scale and the
    // camera something to sweep past on a spin. Seeded per park, so the trees
    // are the same shape every time you load a given map but different across
    // the six of them.
    let a = this.def.seed || 0x51ed;
    const rng = () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 44; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = 40 + rng() * 48;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad * 0.85;
      const th = 4 + rng() * 4;
      entries.push(box(0x5a4630, 0.5, th, 0.5, x, th / 2, z));
      const crown = 2.6 + rng() * 1.8;
      entries.push(box(0x415f39, crown, crown * 0.9, crown, x, th + crown * 0.35, z));
    }
    for (const x of [-PARK_X - 2.4, PARK_X + 2.4]) {
      for (const z of [-16, 0, 16]) {
        entries.push(box(0x8b9099, 0.16, 6.4, 0.16, x, 3.2, z));
        entries.push(box(0xcfd4d8, 0.9, 0.16, 0.34, x - Math.sign(x) * 0.42, 6.3, z));
      }
    }

    const mesh = new THREE.Mesh(merge(entries, 0.4), this.material);
    disposeSources(entries);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _mid = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * A cylinder between two points. CylinderGeometry is built along +Y, so the
 * quaternion that takes +Y onto the segment's direction is the whole job —
 * cheaper to reason about than an Euler triple, and it cannot gimbal on a rail
 * that happens to be vertical.
 */
function tube(entries, color, ax, ay, az, bx, by, bz, radius) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length();
  _dir.multiplyScalar(1 / len);
  _q.setFromUnitVectors(_up, _dir);
  _mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  const geo = new THREE.CylinderGeometry(radius, radius, len, 9, 1);
  entries.push({ geo, color, matrix: new THREE.Matrix4().compose(_mid, _q, _one) });
}

// ===========================================================================
// the six maps
// ===========================================================================
// Each `build(p)` only ever calls p.add / p.rail / p.coping / p.ledge — the pad,
// the fence, the dirt and the mesh assembly above are common to all of them.
// `spawn` is where a run and a respawn put you; `patrol` is the loop the AI
// skaters tour, chosen by hand for each layout so it stays clear of the
// obstacles below rather than clipping through them; `logos` are the six
// collectible spots.

export const PARKS = [
  {
    id: 'home',
    name: 'Home Park',
    blurb: 'Funbox, a handrail and two transitions. Where every run starts.',
    seed: 0x51ed,
    spawn: { x: 0, y: 0, z: -14, yaw: 0 },
    patrol: [
      { x: 0, z: -16 }, { x: 9, z: -2 }, { x: 9, z: 12 }, { x: 0, z: 17 },
      { x: -9, z: 2 }, { x: -6, z: -12 },
    ],
    logos: [
      { x: 0, z: -8 }, { x: -8, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 12 },
      { x: 18, z: 11 }, { x: -19, z: -4 },
    ],
    build(p) {
      // --- north transition: the big quarterpipe ---------------------------
      const qpN = p.add(new Quarter(-13, 13, 20, 'z', 1, 2.4, 1.6, 3.0));
      p.add(new Slab(-13, 13, 20 + qpN.uTop, 29, 1.6, SMOOTH, CONCRETE, 1.7));
      p.coping(-13, 13, 20 + qpN.uTop, 1.6);

      // --- south transition: smaller, for pumping back the other way -------
      const qpS = p.add(new Quarter(-9, 9, -20, 'z', -1, 2.0, 1.2, 3.0));
      p.add(new Slab(-9, 9, -29, -20 - qpS.uTop, 1.2, SMOOTH, CONCRETE, 1.3));
      p.coping(-9, 9, -20 - qpS.uTop, 1.2);

      // --- west bank, with a ledge along its top ----------------------------
      p.add(new Bank(-24, -19, -9, 9, 'x', 1.25, 0));
      p.add(new Slab(-26, -24, -9, 9, 1.25, SMOOTH, CONCRETE, 1.35));
      p.ledge(-24, 1.25, -9, -24, 1.25, 9);

      // --- funbox: bank up, flat rail across the top, bank down -------------
      p.add(new Bank(-3.2, 3.2, -6, -3, 'z', 0, 0.5));
      p.add(new Slab(-3.2, 3.2, -3, 3, 0.5, SMOOTH, CONCRETE, 0.55));
      p.add(new Bank(-3.2, 3.2, 3, 6, 'z', 0.5, 0));
      p.rail(0, 0.82, -3.1, 0, 0.82, 3.1, 0.03);
      p.ledge(-3.2, 0.5, -3, -3.2, 0.5, 3);
      p.ledge(3.2, 0.5, -3, 3.2, 0.5, 3);

      // --- east manual pad ---------------------------------------------------
      p.add(new Bank(3.4, 6, -2.2, 2.2, 'x', 0, 0.42));
      p.add(new Slab(6, 14, -2.2, 2.2, 0.42, SMOOTH, CONCRETE, 0.47));
      p.ledge(6, 0.42, 2.2, 14, 0.42, 2.2);
      p.ledge(6, 0.42, -2.2, 14, 0.42, -2.2);

      // --- stair set and handrail --------------------------------------------
      p.add(new Bank(13, 23, 16, 20, 'z', 1.25, 0));
      p.add(new Slab(13, 23, 6, 16, 1.25, SMOOTH, CONCRETE, 1.35));
      p.add(new Stairs(13, 23, 6, 'z', -1, 5, 0.25, 0.56));
      p.rail(14.4, 1.36, 6.5, 14.4, 0.06, 2.4, 0.028);

      // --- flat bar out west --------------------------------------------------
      p.rail(-10, 0.4, -6, -10, 0.4, 8, 0.028);

      // --- kicker, for airs on the way to anywhere ----------------------------
      p.add(new Quarter(-17.4, -14.6, 5.6, 'z', -1, 1.5, 0.62));
    },
  },

  {
    id: 'bowl',
    name: 'The Bowl',
    blurb: 'A kidney bowl with coping on every wall. Pump it, never stop.',
    seed: 0x9c31,
    spawn: { x: 0, y: 0, z: -14, yaw: 0 },
    patrol: [
      { x: 0, z: -15 }, { x: 8, z: -8 }, { x: 8, z: 8 }, { x: 0, z: 15 },
      { x: -8, z: 8 }, { x: -8, z: -8 },
    ],
    logos: [
      { x: 0, z: -6 }, { x: 6, z: 0 }, { x: 0, z: 6 }, { x: -6, z: 0 },
      { x: 12, z: -13 }, { x: -12, z: 13 },
    ],
    build(p) {
      // Four walls of one bowl, each a quarterpipe tangent to a shared flat
      // floor at y = 0 — so a line can be carried from any wall to any other.
      const n = p.add(new Quarter(-9, 9, 9, 'z', 1, 2.6, 1.9, 2.2));
      p.add(new Slab(-9, 9, 9 + n.uTop, 9 + n.uTop + 2.2, 1.9, SMOOTH, CONCRETE, 1.9));
      p.coping(-9, 9, 9 + n.uTop, 1.9);

      const s = p.add(new Quarter(-9, 9, -9, 'z', -1, 2.6, 1.9, 2.2));
      p.add(new Slab(-9, 9, -9 - s.uTop - 2.2, -9 - s.uTop, 1.9, SMOOTH, CONCRETE, 1.9));
      p.coping(-9, 9, -9 - s.uTop, 1.9);

      const e = p.add(new Quarter(-9, 9, 9, 'x', 1, 2.4, 1.7, 1.8));
      p.add(new Slab(9 + e.uTop, 9 + e.uTop + 1.8, -9, 9, 1.7, SMOOTH, CONCRETE, 1.7));
      p.copingZ(9 + e.uTop, 1.7, -9, 9);

      const w = p.add(new Quarter(-9, 9, -9, 'x', -1, 2.4, 1.7, 1.8));
      p.add(new Slab(-9 - w.uTop - 1.8, -9 - w.uTop, -9, 9, 1.7, SMOOTH, CONCRETE, 1.7));
      p.copingZ(-9 - w.uTop, 1.7, -9, 9);

      // A hip in one corner, so a line can carry diagonally across the bowl
      // instead of only wall to wall.
      p.add(new Bank(-9, -5.5, -9, -5.5, 'x', 0, 1.1));

      // The shallow end and a flat bar down the middle, so there is somewhere
      // to grind between pumps.
      p.rail(0, 0.42, -4, 0, 0.42, 4, 0.03);
    },
  },

  {
    id: 'vert',
    name: 'Vert Alley',
    blurb: 'Two tall walls facing off, with a spine between them. Airs, mostly.',
    seed: 0x77a4,
    spawn: { x: 0, y: 0, z: -6, yaw: 0 },
    patrol: [
      { x: 0, z: -20 }, { x: 10, z: -6 }, { x: 10, z: 6 }, { x: 0, z: 20 },
      { x: -10, z: 6 }, { x: -10, z: -6 },
    ],
    logos: [
      { x: 0, z: -14 }, { x: 0, z: 14 }, { x: 14, z: 0 }, { x: -14, z: 0 },
      { x: 8, z: -18 }, { x: -8, z: 18 },
    ],
    build(p) {
      // A tall wall at each end of a long, narrow alley — the closest thing a
      // skateboard has to a halfpipe.
      const n = p.add(new Quarter(-11, 11, 24, 'z', 1, 3.2, 2.5, 2.6));
      p.add(new Slab(-11, 11, 24 + n.uTop, 29, 2.5, SMOOTH, CONCRETE, 2.5));
      p.coping(-11, 11, 24 + n.uTop, 2.5);

      const s = p.add(new Quarter(-11, 11, -24, 'z', -1, 3.2, 2.5, 2.6));
      p.add(new Slab(-11, 11, -29, -24 - s.uTop, 2.5, SMOOTH, CONCRETE, 2.5));
      p.coping(-11, 11, -24 - s.uTop, 2.5);

      // A spine down the middle: two small quarters back to back, sharing no
      // deck at all, so a transfer means clearing the whole width in the air.
      const spineR = 1.4, spineH = 1.0;
      const spN = p.add(new Quarter(-6, 6, 1.2, 'z', 1, spineR, spineH));
      const spS = p.add(new Quarter(-6, 6, -1.2, 'z', -1, spineR, spineH));
      p.coping(-6, 6, 1.2 + spN.uTop, spineH);
      p.coping(-6, 6, -1.2 - spS.uTop, spineH);

      // A rail either side of the alley for the runs that stay on the ground.
      p.rail(-9.5, 0.4, -10, -9.5, 0.4, 10, 0.028);
      p.rail(9.5, 0.4, -10, 9.5, 0.4, 10, 0.028);
    },
  },

  {
    id: 'plaza',
    name: 'Street Plaza',
    blurb: 'Ledges, a kinked double set and a long manual pad. Technical.',
    seed: 0x1e6d,
    spawn: { x: 0, y: 0, z: -18, yaw: 0 },
    patrol: [
      { x: 0, z: -20 }, { x: 12, z: -12 }, { x: 12, z: 4 }, { x: 0, z: 14 },
      { x: -12, z: 4 }, { x: -12, z: -12 },
    ],
    logos: [
      { x: 0, z: -10 }, { x: -10, z: -2 }, { x: 10, z: -2 }, { x: 0, z: 6 },
      { x: 15, z: 10 }, { x: -15, z: 10 },
    ],
    build(p) {
      // A long, low manual pad down the centre — the plaza's spine.
      p.add(new Bank(-2.5, 2.5, -10, -7, 'z', 0, 0.28));
      p.add(new Slab(-2.5, 2.5, -7, 9, 0.28, SMOOTH, CONCRETE, 0.32));
      p.add(new Bank(-2.5, 2.5, 9, 12, 'z', 0.28, 0));
      p.ledge(-2.5, 0.28, -7, -2.5, 0.28, 9);
      p.ledge(2.5, 0.28, -7, 2.5, 0.28, 9);

      // A three-block ledge run down one side, each a hair taller than the last.
      for (let i = 0; i < 3; i++) {
        const x0 = 6 + i * 4.2, x1 = x0 + 3.4, y = 0.34 + i * 0.08;
        p.add(new Bank(x0, x0 + 0.6, -4, 4, 'x', 0, y));
        p.add(new Slab(x0 + 0.6, x1, -4, 4, y, SMOOTH, CONCRETE, 0.3 + y));
        p.ledge(x0 + 0.6, y, -4, x1, y, -4);
        p.ledge(x0 + 0.6, y, 4, x1, y, 4);
      }

      // A kinked double set: two flights at an angle, one long rail running
      // over both, off a single flat landing at the top.
      p.add(new Slab(-20, -12, 10, 22, 1.4, SMOOTH, CONCRETE, 1.5));
      p.add(new Stairs(-20, -16, 10, 'z', -1, 4, 0.28, 0.58));
      p.add(new Stairs(-16, -12, 10, 'z', -1, 6, 0.19, 0.58));
      p.rail(-18, 1.5, 10.4, -14, 0.1, 2.9, 0.028);

      // Two picnic-table hips for wallride-style pop lines.
      p.add(new Bank(10, 14, 14, 18, 'x', 0, 0.5));
      p.add(new Bank(10, 14, 18, 22, 'x', 0.5, 0));
    },
  },

  {
    id: 'garden',
    name: 'Mini Ramp Garden',
    blurb: 'Four small ramps close together. Fast combos, forgiving pop.',
    seed: 0x4b2f,
    spawn: { x: 0, y: 0, z: -18, yaw: 0 },
    patrol: [
      { x: 0, z: -19 }, { x: 9, z: -7 }, { x: 9, z: 7 }, { x: 0, z: 17 },
      { x: -9, z: 7 }, { x: -9, z: -7 },
    ],
    logos: [
      { x: 0, z: -11 }, { x: -7, z: -2 }, { x: 7, z: -2 }, { x: 0, z: 8 },
      { x: 7, z: 14 }, { x: -7, z: 14 },
    ],
    build(p) {
      // Four small mini ramps, each just big enough for real air, spaced so a
      // roll-out of one feeds straight into the next.
      const specs = [
        { cx: -7, cz: -3, sign: 1 },
        { cx: 7, cz: -3, sign: -1 },
        { cx: -7, cz: 9, sign: 1 },
        { cx: 7, cz: 9, sign: -1 },
      ];
      for (const { cx, cz, sign } of specs) {
        const half = 3.2;
        const q = p.add(new Quarter(cx - half, cx + half, cz, 'z', sign, 1.5, 0.95, 1.4));
        const back = cz + sign * (q.uTop + 1.4);
        p.add(
          sign > 0
            ? new Slab(cx - half, cx + half, cz + q.uTop, back, 0.95, SMOOTH, CONCRETE, 1.0)
            : new Slab(cx - half, cx + half, back, cz - q.uTop, 0.95, SMOOTH, CONCRETE, 1.0)
        );
        p.coping(cx - half, cx + half, cz + sign * q.uTop, 0.95);
      }

      // A flat bar and a small funbox in the gap between all four, so there is
      // somewhere to link a trick between ramps.
      p.rail(-3, 0.4, 3, 3, 0.4, 3, 0.028);
      p.add(new Bank(-2.2, 2.2, -1, 0.5, 'z', 0, 0.32));
      p.add(new Bank(-2.2, 2.2, 0.5, 2, 'z', 0.32, 0));
    },
  },

  {
    id: 'bigair',
    name: 'Big Air',
    blurb: 'One mega ramp, and a gap only a rail or a real ollie gets you across.',
    seed: 0xd813,
    spawn: { x: 0, y: 0, z: -20, yaw: 0 },
    patrol: [
      { x: 0, z: -20 }, { x: 10, z: -8 }, { x: 10, z: 0 }, { x: 0, z: 10 },
      { x: -10, z: 0 }, { x: -10, z: -8 },
    ],
    logos: [
      { x: 0, z: -18 }, { x: -12, z: -8 }, { x: 12, z: -8 }, { x: 0, z: 4 },
      { x: 16, z: 6 }, { x: -16, z: 6 },
    ],
    build(p) {
      // The mega ramp: an elevated run-up (so a spawn can stand on it rather
      // than floating over a cliff), a bank down to the flat, then straight
      // into a tall quarter with a deep platform, so there is room to land
      // the air on top as well as to fly clean off the lip.
      p.add(new Slab(-8, 8, -24, -14, 3.0, SMOOTH, CONCRETE, 3.0));
      p.add(new Bank(-8, 8, -14, -8, 'z', 3.0, 0));
      const q = p.add(new Quarter(-8, 8, 6, 'z', 1, 3.4, 2.7, 3.4));
      p.add(new Slab(-8, 8, 6 + q.uTop, 6 + q.uTop + 3.4, 2.7, SMOOTH, CONCRETE, 2.7));
      p.coping(-8, 8, 6 + q.uTop, 2.7);

      // A real gap jump off to one side: bank up, a clean break, flat below,
      // bank back up on the far side. There is no way across it that is not
      // either an ollie or a grind on the rail that spans it.
      p.add(new Bank(-19, -14, -6, 0, 'x', 0, 1.3));
      p.add(new Bank(14, 19, -6, 0, 'x', 1.3, 0));
      p.rail(-14.2, 1.35, -3, 14.2, 1.35, -3, 0.028);
    },
  },
];

export const DEFAULT_PARK = PARKS[0];
