// Coins and obstacles.
//
// Nothing here stores a world position. Every item knows only its distance
// along the path (`s`) and its lane, and world transforms are derived from the
// path on demand. That makes rebasing free (subtract a scalar) and makes
// collision a handful of float compares instead of box intersections.

import * as THREE from './three.js';
import { ARC, STRAIGHT } from './path.js';
import * as C from './config.js';

export const COIN = 0;
export const BARRIER = 1;
export const BEAM = 2;
export const BLOCK = 3;
export const KINDS = [COIN, BARRIER, BEAM, BLOCK];

// halfDepth: how far along the track the item reaches from its centre.
// wide: spans the whole corridor, so the lane test is skipped.
const SPEC = {
  [COIN]: { half: 0.45, wide: false, y: 0.95, cap: C.MAX_COINS },
  [BARRIER]: { half: 0.35, wide: true, y: 0.35, cap: C.MAX_OBSTACLES },
  [BEAM]: { half: 0.35, wide: true, y: 2.05, cap: C.MAX_OBSTACLES },
  [BLOCK]: { half: 0.55, wide: false, y: 0.95, cap: C.MAX_OBSTACLES },
};

// Clearing a BARRIER needs this much air; the jump apex is ~1.23 m.
const BARRIER_CLEAR_Y = 0.8;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p = { x: 0, z: 0, yaw: 0 };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function buildMeshes() {
  const coinGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.09, 8);
  coinGeo.rotateX(Math.PI / 2); // face down the track rather than lie flat
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);

  const mk = (geo, mat, count) => {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    for (let i = 0; i < count; i++) m.setMatrixAt(i, ZERO);
    m.instanceMatrix.needsUpdate = true;
    return m;
  };

  return {
    [COIN]: mk(coinGeo, new THREE.MeshLambertMaterial({ color: 0xe0a83a, emissive: 0x4a3208 }), C.MAX_COINS),
    [BARRIER]: mk(boxGeo, new THREE.MeshLambertMaterial({ color: 0x8c4a2f }), C.MAX_OBSTACLES),
    [BEAM]: mk(boxGeo, new THREE.MeshLambertMaterial({ color: 0x6a4b7a }), C.MAX_OBSTACLES),
    [BLOCK]: mk(boxGeo, new THREE.MeshLambertMaterial({ color: 0x3d4f5c }), C.MAX_OBSTACLES),
  };
}

/** Per-kind instance scale. */
const SCALE = {
  [COIN]: [1, 1, 1],
  [BARRIER]: [C.HALF_W * 2, 0.7, 0.5],
  [BEAM]: [C.HALF_W * 2, 1.0, 0.5],
  [BLOCK]: [1.3, 1.9, 1.0],
};

export class Entities {
  constructor(rng) {
    this.meshes = buildMeshes();
    this.group = new THREE.Group();
    for (const k of KINDS) this.group.add(this.meshes[k]);
    this.reset(rng);
  }

  reset(rng) {
    this.rng = rng;
    this.items = []; // always sorted by s
    this.cursor = 0; // collision scan cursor, monotone in s
    this.dirty = true;
  }

  /** Populate one path node with obstacles and coins. */
  spawnForNode(node) {
    const rng = this.rng;
    const items = this.items;

    if (node.kind === ARC) {
      // Corners stay clean — the turn itself is the challenge. A line of coins
      // through the middle rewards taking it tight.
      const n = 4;
      for (let i = 0; i < n; i++) {
        const s = node.s0 + (node.len * (i + 0.5)) / n;
        items.push({ s, lane: 0, kind: COIN, alive: true });
      }
      this.dirty = true;
      return;
    }

    // A quiet opening so the first few seconds are never unfair.
    if (node.s0 < 60) {
      this.dirty = true;
      return;
    }

    const free = [-1, 0, 1];
    let blockedLanes = null;

    if (rng() < 0.68) {
      const s = node.s0 + 5 + rng() * (node.len - 10);
      const roll = rng();
      if (roll < 0.34) {
        items.push({ s, lane: 0, kind: BARRIER, alive: true });
      } else if (roll < 0.62) {
        items.push({ s, lane: 0, kind: BEAM, alive: true });
      } else {
        // Block one or two lanes, never all three.
        const count = rng() < 0.35 ? 2 : 1;
        const lanes = [-1, 0, 1];
        for (let i = lanes.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
        }
        blockedLanes = lanes.slice(0, count);
        for (const lane of blockedLanes) {
          items.push({ s, lane, kind: BLOCK, alive: true });
        }
      }
    }

    // A run of coins in a lane that stays clear.
    if (rng() < 0.8) {
      let lane = free[Math.floor(rng() * 3)];
      if (blockedLanes && blockedLanes.includes(lane)) {
        lane = free.find((l) => !blockedLanes.includes(l));
      }
      const count = 4 + Math.floor(rng() * 5);
      const start = node.s0 + 2 + rng() * (node.len - count * 1.7 - 4);
      for (let i = 0; i < count; i++) {
        items.push({ s: start + i * 1.7, lane, kind: COIN, alive: true });
      }
    }

    items.sort((a, b) => a.s - b.s);
    this.dirty = true;
  }

  /** Drop everything behind the player. */
  retireBefore(s) {
    let n = 0;
    while (n < this.items.length && this.items[n].s < s) n++;
    if (n > 0) {
      this.items.splice(0, n);
      this.cursor = Math.max(0, this.cursor - n);
      this.dirty = true;
    }
  }

  /** Apply a path rebase. */
  shift(ds) {
    if (!ds) return;
    for (let i = 0; i < this.items.length; i++) this.items[i].s -= ds;
    this.dirty = true;
  }

  /** Rewrite instance matrices. Only runs when the item set actually changed. */
  refresh(path) {
    const counts = { [COIN]: 0, [BARRIER]: 0, [BEAM]: 0, [BLOCK]: 0 };
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.alive) continue;
      const spec = SPEC[it.kind];
      const n = counts[it.kind];
      if (n >= spec.cap) continue;
      path.pointAt(it.s, it.lane * C.LANE_W, _p);
      _v.set(_p.x, spec.y, _p.z);
      _e.set(0, _p.yaw, 0);
      _q.setFromEuler(_e);
      const sc = SCALE[it.kind];
      _s.set(sc[0], sc[1], sc[2]);
      _m.compose(_v, _q, _s);
      this.meshes[it.kind].setMatrixAt(n, _m);
      counts[it.kind] = n + 1;
    }
    for (const k of KINDS) {
      const mesh = this.meshes[k];
      for (let i = counts[k]; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.dirty = false;
  }

  /**
   * Cheap 1D scan. Returns the number of coins collected; calls onDeath(reason)
   * if the player hit something.
   */
  collide(player, onDeath) {
    const items = this.items;
    let collected = 0;

    while (this.cursor < items.length && items[this.cursor].s < player.distance - 1.5) {
      this.cursor++;
    }

    for (let i = this.cursor; i < items.length; i++) {
      const it = items[i];
      if (it.s > player.distance + 1.5) break;
      if (!it.alive) continue;

      const spec = SPEC[it.kind];
      if (Math.abs(it.s - player.distance) > spec.half + C.PLAYER_HALF_W) continue;
      if (!spec.wide) {
        const tol = it.kind === COIN ? 0.9 : 0.62;
        if (Math.abs(it.lane * C.LANE_W - player.lateral) > tol) continue;
      }

      if (it.kind === COIN) {
        it.alive = false;
        this.dirty = true;
        collected++;
        continue;
      }

      const fatal =
        (it.kind === BARRIER && player.y < BARRIER_CLEAR_Y) ||
        (it.kind === BEAM && !player.isSliding) ||
        it.kind === BLOCK;
      if (fatal) {
        onDeath('hit');
        break;
      }
    }
    return collected;
  }
}
