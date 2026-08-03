// Streaming track geometry: a pool of chunk Groups recycled along the path.
//
// Every chunk's children are authored in the chunk's *entry-local* frame
// (origin at the node's start, forward = -Z). Placing a chunk is then just
// group.position = node position, group.rotation.y = node yaw. All the fiddly
// corner geometry gets written once, in one frame of reference.

import * as THREE from './three.js';
import { Path, STRAIGHT, ARC, LEFT, RIGHT, localToTrack } from './path.js';
import * as C from './config.js';

// One geometry, scaled per mesh — every wall, floor and pillar in the game.
const BOX = new THREE.BoxGeometry(1, 1, 1);

const MAT = {
  floor: new THREE.MeshLambertMaterial({ color: 0x7a6549 }),
  wall: new THREE.MeshLambertMaterial({ color: 0x4a3f31 }),
  trim: new THREE.MeshLambertMaterial({ color: 0x2b2620 }),
  // Emissive so the turn marker stays readable through the fog at range.
  sign: new THREE.MeshLambertMaterial({ color: 0xe0a83a, emissive: 0x8a5f14 }),
};

function box(mat, sx, sy, sz, px, py, pz, ry, rz) {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(px, py, pz);
  if (ry) m.rotation.y = ry;
  if (rz) m.rotation.z = rz;
  // These never move relative to their chunk, so skip the per-frame recompose.
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

const HW = C.HALF_W;
const WT = C.WALL_T;
const WH = C.WALL_H;
const R = C.ARC_RADIUS;
const RI = R - HW; // inner corridor radius through a corner
const RO = R + HW; // outer corridor radius

/** Local Z of a straight chunk's four buttresses. */
const BUTTRESS_Z = [-C.SEGMENT_LEN * 0.25, -C.SEGMENT_LEN * 0.75];

function buildStraight() {
  const g = new THREE.Group();
  const L = C.SEGMENT_LEN;
  const cz = -L / 2;
  g.add(box(MAT.floor, HW * 2, C.FLOOR_T, L, 0, -C.FLOOR_T / 2, cz));
  g.add(box(MAT.wall, WT, WH, L, -(HW + WT / 2), WH / 2, cz));
  g.add(box(MAT.wall, WT, WH, L, HW + WT / 2, WH / 2, cz));
  return g;
}

/**
 * A 90-degree corner, built as a square plaza with an outer L of walls and a
 * chamfered inner corner.
 *
 * The chamfer matters: the inner lane sweeps a radius of only R - LANE_W, which
 * cuts well inside where two straight walls would meet. A 45-degree wall placed
 * tangent to the inner corridor edge is both the cheapest fix and the one that
 * reads as deliberate temple architecture.
 *
 * Authored for a LEFT turn; `dir` mirrors it in X for a right turn (and negates
 * Y rotations with it), which avoids a negative scale and its flipped winding.
 */
function buildCorner(dir) {
  const g = new THREE.Group();
  const mx = dir; // +1 keeps the left-hand build, -1 mirrors it
  const OVER = 0.6; // overhang back into the previous chunk, hides the seam

  // Plaza floor: spans the full quarter so the inner lane never runs off it.
  const fx = (-RO + HW) / 2;
  const fz = (OVER - RO) / 2;
  g.add(box(MAT.floor, RO + HW, C.FLOOR_T, RO + OVER, mx * fx, -C.FLOOR_T / 2, fz));

  // Outer wall along the entry corridor's outer side.
  g.add(box(MAT.wall, WT, WH, RO + OVER, mx * (HW + WT / 2), WH / 2, fz));

  // The far wall — this is what you hit when you miss the turn.
  const bx = (-RO + HW + WT) / 2;
  g.add(box(MAT.wall, RO + HW + WT, WH, WT, mx * bx, WH / 2, -(RO + WT / 2)));

  // Inner chamfer, tangent to the inner corridor edge at 45 degrees, pushed out
  // by half a wall thickness so its visible face sits exactly on that edge.
  const k = Math.SQRT1_2;
  const px = -R + RI * k + (WT / 2) * k;
  const pz = -RI * k - (WT / 2) * k;
  // Endpoints where the chamfer meets each corridor's inner wall line.
  const tEntry = (-HW - px) / k; // where the chamfer crosses x = -HW
  const chamferLen = 2 * Math.abs(tEntry) + 0.2;
  g.add(box(MAT.wall, chamferLen, WH, WT, mx * px, WH / 2, pz, mx * -Math.PI / 4));

  // Inner wall stubs joining the chamfer to each corridor.
  const zJoin = pz + k * tEntry; // z where the chamfer reaches x = -HW
  const stubALen = OVER - zJoin;
  g.add(box(MAT.wall, WT, WH, stubALen, mx * -(HW + WT / 2), WH / 2, (OVER + zJoin) / 2));

  const xJoin = px - k * Math.abs(tEntry); // x where the chamfer reaches z = -RI
  const stubBLen = Math.abs(-RO - xJoin);
  g.add(box(MAT.wall, stubBLen, WH, WT, mx * ((xJoin - RO) / 2), WH / 2, -(RI - WT / 2)));

  // A big arrow on the far wall, pointing the way out.
  //
  // This is not decoration. In portrait the horizontal field of view is only
  // ~37 degrees, so the corner's exit is off-screen until the player is almost
  // on top of it — the far wall is the only part of the corner they can see
  // from a distance, so the direction cue has to live there.
  const az = -(RO - 0.16); // just proud of the far wall's face
  const ay = WH * 0.55;
  g.add(box(MAT.sign, 2.4, 0.34, 0.22, mx * 0.3, ay, az));
  const barb = 0.9;
  const tip = -1.0;
  g.add(box(MAT.sign, barb, 0.32, 0.22, mx * (tip + 0.32), ay + 0.32, az, 0, mx * 0.62));
  g.add(box(MAT.sign, barb, 0.32, 0.22, mx * (tip + 0.32), ay - 0.32, az, 0, mx * -0.62));

  return g;
}

class Chunk {
  constructor(group, kind, poolIdx) {
    this.group = group;
    this.kind = kind; // STRAIGHT, or LEFT/RIGHT for a corner
    this.poolIdx = poolIdx;
    this.node = null;
    this.inUse = false;
  }

  place(node) {
    this.node = node;
    this.group.position.set(node.x, 0, node.z);
    this.group.rotation.y = node.yaw;
  }
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _pose = { x: 0, z: 0, yaw: 0 };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Track {
  /**
   * @param {() => number} rng
   * @param {(node: object) => void} onChunkSpawn  populate a node with entities
   * @param {(node: object) => void} onChunkRetire
   */
  constructor(rng, onChunkSpawn, onChunkRetire) {
    this.root = new THREE.Group();
    this.onChunkSpawn = onChunkSpawn;
    this.onChunkRetire = onChunkRetire;

    this.pools = {
      [STRAIGHT]: [],
      [LEFT]: [],
      [RIGHT]: [],
    };
    for (let i = 0; i < C.MAX_STRAIGHT_CHUNKS; i++) {
      const g = buildStraight();
      g.visible = false;
      this.root.add(g);
      this.pools[STRAIGHT].push(new Chunk(g, STRAIGHT, i));
    }
    for (const dir of [LEFT, RIGHT]) {
      for (let i = 0; i < C.MAX_CORNER_CHUNKS; i++) {
        const g = buildCorner(dir);
        g.visible = false;
        this.root.add(g);
        this.pools[dir].push(new Chunk(g, dir, i));
      }
    }

    // All buttresses in one draw call. Chunk i owns instances [i*4, i*4+4).
    this.pillars = new THREE.InstancedMesh(
      BOX,
      MAT.trim,
      C.MAX_STRAIGHT_CHUNKS * 4
    );
    this.pillars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pillars.frustumCulled = false;
    for (let i = 0; i < this.pillars.count; i++) this.pillars.setMatrixAt(i, ZERO);
    this.pillars.instanceMatrix.needsUpdate = true;
    this.root.add(this.pillars);

    this.reset(rng);
  }

  reset(rng) {
    for (const c of this.live || []) {
      c.inUse = false;
      c.group.visible = false;
    }
    this.live = [];
    this.path = new Path(rng);
    this.pending = 0; // index of the first node without a chunk
    for (let i = 0; i < this.pillars.count; i++) this.pillars.setMatrixAt(i, ZERO);
    this.pillars.instanceMatrix.needsUpdate = true;
  }

  acquire(kind) {
    const pool = this.pools[kind];
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].inUse) {
        pool[i].inUse = true;
        pool[i].group.visible = true;
        return pool[i];
      }
    }
    return null; // pool exhausted; caller stops spawning this frame
  }

  /** Write a straight chunk's four buttress instances from its node pose. */
  writePillars(chunk) {
    if (chunk.kind !== STRAIGHT) return;
    const base = chunk.poolIdx * 4;
    const node = chunk.node;
    const h = WH + 0.4;
    let n = 0;
    for (const lz of BUTTRESS_Z) {
      for (const side of [-1, 1]) {
        localToTrack(node, side * (HW - 0.15), lz, _pose);
        _v.set(_pose.x, h / 2, _pose.z);
        _e.set(0, node.yaw, 0);
        _q.setFromEuler(_e);
        _s.set(0.4, h, 0.7);
        _m.compose(_v, _q, _s);
        this.pillars.setMatrixAt(base + n, _m);
        n++;
      }
    }
    this.pillars.instanceMatrix.needsUpdate = true;
  }

  clearPillars(chunk) {
    if (chunk.kind !== STRAIGHT) return;
    const base = chunk.poolIdx * 4;
    for (let i = 0; i < 4; i++) this.pillars.setMatrixAt(base + i, ZERO);
    this.pillars.instanceMatrix.needsUpdate = true;
  }

  /** Re-apply every live chunk's transform — used after a rebase. */
  replaceAll() {
    for (const c of this.live) {
      c.place(c.node);
      this.writePillars(c);
    }
  }

  /**
   * Extend the path, spawn chunks ahead, retire chunks behind. Returns the
   * total distance shift applied by rebasing, which the caller must subtract
   * from anything else holding a path distance (player, entities).
   */
  update(distance) {
    const path = this.path;

    while (path.end < distance + C.SPAWN_AHEAD) path.append();

    while (this.pending < path.nodes.length) {
      const node = path.nodes[this.pending];
      if (node.s0 > distance + C.SPAWN_AHEAD) break;
      const kind = node.kind === ARC ? node.dir : STRAIGHT;
      const chunk = this.acquire(kind);
      if (!chunk) break;
      chunk.place(node);
      this.writePillars(chunk);
      this.live.push(chunk);
      this.pending++;
      this.onChunkSpawn(node);
    }

    let shift = 0;
    while (this.live.length > 1) {
      const oldest = this.live[0];
      if (oldest.node.s0 + oldest.node.len >= distance - C.RETIRE_BEHIND) break;
      this.live.shift();
      oldest.inUse = false;
      oldest.group.visible = false;
      this.clearPillars(oldest);
      this.onChunkRetire(oldest.node);
      if (!path.retireFirst()) break;
      this.pending--;
      const ds = path.rebase();
      shift += ds;
      distance -= ds;
      this.replaceAll();
    }
    return shift;
  }
}

export { BOX, MAT };
