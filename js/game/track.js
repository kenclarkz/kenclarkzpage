// Streaming track geometry.
//
// Every chunk type is authored once as a list of boxes in the chunk's
// *entry-local* frame (origin at the node's start, forward = -Z) and merged
// into two geometries: lit stonework, and self-lit gold. Those become two
// InstancedMeshes per chunk type, so the entire corridor — floors, walls,
// plinths, cornices, pilasters, arches, friezes and torches — costs six draw
// calls no matter how many sections are on screen.
//
// Placing a chunk is therefore just writing one instance matrix; retiring one
// is writing a zero-scale matrix.

import * as THREE from './three.js';
import { Path, STRAIGHT, ARC, LEFT, RIGHT } from './path.js';
import { box, merge } from './geo.js';
import { textures } from './textures.js';
import * as C from './config.js';

const HW = C.HALF_W;
const WT = C.WALL_T;
const WH = C.WALL_H;
const R = C.ARC_RADIUS;
const RI = R - HW; // inner corridor radius through a corner
const RO = R + HW; // outer corridor radius

// Surface palette. Kept close in value so the torchlight, not the albedo, is
// what shapes the scene.
const COL = {
  floor: 0xb5966d,
  floorInlay: 0x8a6f4e,
  floorEdge: 0x9c8058,
  wall: 0x9a8163,
  plinth: 0xab8f6c,
  cornice: 0x7d6650,
  pilaster: 0xa3886a,
  capital: 0xc0a077,
  arch: 0x8a7259,
  trim: 0x5d4a37,
  gold: 0xffc84e,
  goldDim: 0xd9a038,
  emberDeep: 0xd94a12,
  flame: 0xff8c22,
  flameHot: 0xffe08a,
};

/**
 * A wall torch: bracket, bowl, and a self-lit flame.
 *
 * The flame tapers through three saturated steps rather than being one pale
 * block — unlit geometry has no shading to give it form, so the silhouette and
 * the colour ramp are the only things making it read as fire.
 */
function torch(stone, glow, x, y, z, mx) {
  const fx = x - mx * 0.16;
  stone.push(box(COL.trim, 0.3, 0.24, 0.3, x, y, z));
  stone.push(box(COL.capital, 0.36, 0.3, 0.36, fx, y + 0.24, z));
  glow.push(box(COL.emberDeep, 0.26, 0.16, 0.26, fx, y + 0.44, z));
  glow.push(box(COL.flame, 0.19, 0.26, 0.19, fx, y + 0.63, z));
  glow.push(box(COL.flameHot, 0.1, 0.2, 0.1, fx, y + 0.84, z));
}

function buildStraight() {
  const stone = [];
  const glow = [];
  const L = C.SEGMENT_LEN;
  const cz = -L / 2;

  // --- ground ---
  stone.push(box(COL.floor, HW * 2, C.FLOOR_T, L, 0, -C.FLOOR_T / 2, cz));
  // A centre inlay reads as a processional path and quietly marks the lanes.
  stone.push(box(COL.floorInlay, 1.15, 0.07, L, 0, 0.025, cz));
  for (const side of [-1, 1]) {
    stone.push(box(COL.floorEdge, 0.4, 0.1, L, side * (HW - 0.2), 0.04, cz));
  }

  // --- walls, plinths and cornices ---
  for (const side of [-1, 1]) {
    const x = side * (HW + WT / 2);
    stone.push(box(COL.wall, WT, WH, L, x, WH / 2, cz));
    stone.push(box(COL.plinth, 0.36, 0.95, L, side * (HW - 0.12), 0.475, cz));
    stone.push(box(COL.cornice, 0.56, 0.34, L, side * (HW - 0.03), WH - 0.3, cz));
    // Gold inlay running the length of the wall, just under the cornice. Lit,
    // not self-lit: an unlit strip this large reads as a blank flat panel.
    stone.push(box(COL.goldDim, 0.12, 0.14, L, side * (HW - 0.1), WH - 0.74, cz));
  }

  // --- pilasters ---
  const shaftH = WH - 1.55;
  for (const side of [-1, 1]) {
    for (const z of [-2.5, -7.5, -12.5, -17.5]) {
      const x = side * (HW - 0.17);
      stone.push(box(COL.pilaster, 0.44, shaftH, 0.78, x, 0.95 + shaftH / 2, z));
      stone.push(box(COL.capital, 0.62, 0.3, 0.98, x, 0.95 + shaftH + 0.15, z));
    }
  }

  // --- overhead arches ---
  // These frame the corridor and give the fog something to reveal, which is
  // what sells forward speed. They sit above the sightline to the track.
  for (const z of [-5, -15]) {
    stone.push(box(COL.arch, HW * 2 + WT * 2, 0.58, 0.72, 0, WH - 0.29, z));
    for (const side of [-1, 1]) {
      stone.push(box(COL.arch, 0.72, 0.48, 0.92, side * (HW - 0.26), WH - 0.78, z));
    }
    // A carved boss at the crown. Broken into a bordered cluster rather than
    // one slab: the nearest arch passes directly overhead, where a single flat
    // gold rectangle fills a third of the frame.
    stone.push(box(COL.trim, 0.46, 0.34, 0.8, 0, WH - 0.29, z));
    stone.push(box(COL.gold, 0.3, 0.22, 0.82, 0, WH - 0.29, z));
  }

  // --- torches, alternating sides ---
  torch(stone, glow, -(HW - 0.3), 2.5, -6, -1);
  torch(stone, glow, HW - 0.3, 2.5, -16, 1);

  return { stone, glow };
}

/**
 * A 90-degree corner: a square plaza with an outer L of walls and a chamfered
 * inner corner.
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
  const stone = [];
  const glow = [];
  const mx = dir; // +1 keeps the left-hand build, -1 mirrors it
  const OVER = 0.6; // overhang back into the previous chunk, hides the seam

  // Plaza floor: spans the full quarter so the inner lane never runs off it.
  const fx = (-RO + HW) / 2;
  const fz = (OVER - RO) / 2;
  stone.push(box(COL.floor, RO + HW, C.FLOOR_T, RO + OVER, mx * fx, -C.FLOOR_T / 2, fz));
  // A darker inlay ring makes the turn's arc legible from the approach.
  stone.push(box(COL.floorInlay, RO + HW - 1.6, 0.07, RO + OVER - 1.6, mx * fx, 0.025, fz));

  // Outer wall along the entry corridor's outer side.
  stone.push(box(COL.wall, WT, WH, RO + OVER, mx * (HW + WT / 2), WH / 2, fz));
  stone.push(box(COL.plinth, 0.36, 0.95, RO + OVER, mx * (HW - 0.12), 0.475, fz));
  stone.push(box(COL.cornice, 0.56, 0.34, RO + OVER, mx * (HW - 0.03), WH - 0.3, fz));

  // The far wall — the one the corner turns you away from.
  const bx = (-RO + HW + WT) / 2;
  stone.push(box(COL.wall, RO + HW + WT, WH, WT, mx * bx, WH / 2, -(RO + WT / 2)));
  stone.push(box(COL.plinth, RO + HW + WT, 0.95, 0.36, mx * bx, 0.475, -(RO - 0.12)));
  stone.push(box(COL.cornice, RO + HW + WT, 0.34, 0.56, mx * bx, WH - 0.3, -(RO - 0.03)));

  // Inner chamfer, tangent to the inner corridor edge at 45 degrees, pushed out
  // by half a wall thickness so its visible face sits exactly on that edge.
  const k = Math.SQRT1_2;
  const px = -R + RI * k + (WT / 2) * k;
  const pz = -RI * k - (WT / 2) * k;
  // Endpoints where the chamfer meets each corridor's inner wall line.
  const tEntry = (-HW - px) / k; // where the chamfer crosses x = -HW
  const chamferLen = 2 * Math.abs(tEntry) + 0.2;
  stone.push(box(COL.wall, chamferLen, WH, WT, mx * px, WH / 2, pz, 0, mx * -Math.PI / 4));
  stone.push(box(COL.plinth, chamferLen, 0.95, 0.34, mx * px, 0.475, pz, 0, mx * -Math.PI / 4));

  // Inner wall stubs joining the chamfer to each corridor.
  const zJoin = pz + k * tEntry; // z where the chamfer reaches x = -HW
  const stubALen = OVER - zJoin;
  stone.push(box(COL.wall, WT, WH, stubALen, mx * -(HW + WT / 2), WH / 2, (OVER + zJoin) / 2));

  const xJoin = px - k * Math.abs(tEntry); // x where the chamfer reaches z = -RI
  const stubBLen = Math.abs(-RO - xJoin);
  stone.push(box(COL.wall, stubBLen, WH, WT, mx * ((xJoin - RO) / 2), WH / 2, -(RI - WT / 2)));

  // A big arrow on the far wall, pointing the way out.
  //
  // In portrait the horizontal field of view is only ~37 degrees, so the
  // corner's exit is off-screen until the player is almost on top of it — the
  // far wall is the only part of the corner visible from a distance, so the
  // direction cue has to live there.
  const az = -(RO - 0.16); // just proud of the far wall's face
  const ay = WH * 0.55;
  glow.push(box(COL.gold, 2.4, 0.34, 0.22, mx * 0.3, ay, az));
  const barb = 0.9;
  const tip = -1.0;
  glow.push(box(COL.gold, barb, 0.32, 0.22, mx * (tip + 0.32), ay + 0.32, az, 0, 0, mx * 0.62));
  glow.push(box(COL.gold, barb, 0.32, 0.22, mx * (tip + 0.32), ay - 0.32, az, 0, 0, mx * -0.62));

  // Torches flanking the arrow, so the far wall is the brightest thing ahead.
  torch(stone, glow, mx * -2.4, 2.4, az + 0.18, mx * -1);
  torch(stone, glow, mx * 2.0, 2.4, az + 0.18, mx * -1);

  return { stone, glow };
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

class Chunk {
  constructor(kind, poolIdx) {
    this.kind = kind; // STRAIGHT, or LEFT/RIGHT for a corner
    this.poolIdx = poolIdx;
    this.node = null;
    this.inUse = false;
  }
}

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

    const tex = textures(C.FOG_COLOR);
    this.stoneMat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      map: tex.stone,
      bumpMap: tex.stoneBump,
      bumpScale: 0.5,
      shininess: 4,
      specular: 0x1b1610,
    });
    // Unlit, so the gold inlay and the turn arrows stay legible through fog and
    // at the edge of the torchlight — which is exactly where they are needed.
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });

    const counts = {
      [STRAIGHT]: C.MAX_STRAIGHT_CHUNKS,
      [LEFT]: C.MAX_CORNER_CHUNKS,
      [RIGHT]: C.MAX_CORNER_CHUNKS,
    };
    const built = {
      [STRAIGHT]: buildStraight(),
      [LEFT]: buildCorner(LEFT),
      [RIGHT]: buildCorner(RIGHT),
    };

    this.pools = {};
    this.meshes = {};
    for (const kind of [STRAIGHT, LEFT, RIGHT]) {
      const n = counts[kind];
      const stone = new THREE.InstancedMesh(merge(built[kind].stone), this.stoneMat, n);
      const glow = new THREE.InstancedMesh(merge(built[kind].glow), this.glowMat, n);
      for (const m of [stone, glow]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Instances are spread down the corridor, so the geometry's own bounds
        // say nothing useful about what is on screen.
        m.frustumCulled = false;
        for (let i = 0; i < n; i++) m.setMatrixAt(i, ZERO);
        m.instanceMatrix.needsUpdate = true;
        this.root.add(m);
      }
      this.meshes[kind] = { stone, glow };

      const pool = [];
      for (let i = 0; i < n; i++) pool.push(new Chunk(kind, i));
      this.pools[kind] = pool;
    }

    this.reset(rng);
  }

  reset(rng) {
    for (const c of this.live || []) this.hide(c);
    this.live = [];
    this.path = new Path(rng);
    this.pending = 0; // index of the first node without a chunk
    for (const kind of [STRAIGHT, LEFT, RIGHT]) {
      for (const c of this.pools[kind]) c.inUse = false;
      this.hideAll(kind);
    }
  }

  hideAll(kind) {
    const { stone, glow } = this.meshes[kind];
    for (let i = 0; i < stone.count; i++) {
      stone.setMatrixAt(i, ZERO);
      glow.setMatrixAt(i, ZERO);
    }
    stone.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
  }

  hide(chunk) {
    const { stone, glow } = this.meshes[chunk.kind];
    stone.setMatrixAt(chunk.poolIdx, ZERO);
    glow.setMatrixAt(chunk.poolIdx, ZERO);
    stone.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
  }

  /** Write a chunk's instance matrix from its node's pose. */
  place(chunk, node) {
    chunk.node = node;
    _v.set(node.x, 0, node.z);
    _e.set(0, node.yaw, 0);
    _q.setFromEuler(_e);
    _m.compose(_v, _q, _one);
    const { stone, glow } = this.meshes[chunk.kind];
    stone.setMatrixAt(chunk.poolIdx, _m);
    glow.setMatrixAt(chunk.poolIdx, _m);
    stone.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
  }

  acquire(kind) {
    const pool = this.pools[kind];
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].inUse) {
        pool[i].inUse = true;
        return pool[i];
      }
    }
    return null; // pool exhausted; caller stops spawning this frame
  }

  /** Re-apply every live chunk's transform — used after a rebase. */
  replaceAll() {
    for (const c of this.live) this.place(c, c.node);
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
      this.place(chunk, node);
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
      this.hide(oldest);
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
