// Coins and obstacles.
//
// Nothing here stores a world position. Every item knows only its distance
// along the path (`s`) and its lane, and world transforms are derived from the
// path on demand. That makes rebasing free (subtract a scalar) and makes
// collision a handful of float compares instead of box intersections.
//
// Each kind is one merged geometry in one InstancedMesh, so the carved detail
// below costs exactly four draw calls in total.

import * as THREE from './three.js';
import { ARC } from './path.js';
import { box, piece, merge } from './geo.js';
import { textures } from './textures.js';
import * as C from './config.js';

export const COIN = 0;
export const BARRIER = 1;
export const BEAM = 2;
export const BLOCK = 3;
export const KINDS = [COIN, BARRIER, BEAM, BLOCK];

// halfDepth: how far along the track the item reaches from its centre.
// wide: spans the whole corridor, so the lane test is skipped.
// y: render height; the collision rules below do not read it.
const SPEC = {
  [COIN]: { half: 0.45, wide: false, y: 1.0, cap: C.MAX_COINS },
  [BARRIER]: { half: 0.35, wide: true, y: 0, cap: C.MAX_OBSTACLES },
  [BEAM]: { half: 0.35, wide: true, y: 0, cap: C.MAX_OBSTACLES },
  [BLOCK]: { half: 0.55, wide: false, y: 0, cap: C.MAX_OBSTACLES },
};

// Clearing a BARRIER needs this much air; the jump apex is ~1.36 m.
const BARRIER_CLEAR_Y = 0.8;

const HW = C.HALF_W;

// Obstacles sit a step cooler and darker than the corridor they stand in, so
// they read as objects against the architecture rather than part of it.
const COL = {
  stone: 0x8c7a5e,
  stoneDark: 0x5f5140,
  stoneLight: 0xb0a084,
  gold: 0xffc84e,
  jade: 0x5fc0a2,
  wood: 0xa2653a,
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _p = { x: 0, z: 0, yaw: 0 };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** A coin: a thin disc standing upright, facing back down the track. */
function buildCoin() {
  const disc = new THREE.CylinderGeometry(0.34, 0.34, 0.07, 14);
  const face = new THREE.CylinderGeometry(0.23, 0.23, 0.09, 12);
  return merge(
    [
      piece(disc, COL.gold, 1, 1, 1, 0, 0, 0, Math.PI / 2),
      piece(face, 0xffd86a, 1, 1, 1, 0, 0, 0, Math.PI / 2),
    ],
    0.5
  );
}

/** A low parapet spanning the corridor: jump it. */
function buildBarrier() {
  const e = [
    box(COL.stoneDark, HW * 2, 0.18, 0.66, 0, 0.09, 0),
    box(COL.stone, HW * 2 - 0.22, 0.46, 0.48, 0, 0.41, 0),
    box(COL.gold, HW * 2 - 0.3, 0.1, 0.54, 0, 0.6, 0),
  ];
  for (const x of [-1.75, 0, 1.75]) {
    e.push(box(COL.stoneLight, 0.34, 0.16, 0.44, x, 0.73, 0));
  }
  return merge(e, 0.4);
}

/** A heavy lintel hung across the corridor: slide under it. */
function buildBeam() {
  const e = [
    box(COL.wood, HW * 2, 0.6, 0.46, 0, 2.05, 0),
    box(COL.stoneDark, HW * 2 - 0.4, 0.16, 0.54, 0, 1.79, 0),
  ];
  for (const side of [-1, 1]) {
    // Gold end caps and posts up to the arches, so the eye reads it as hanging
    // rather than floating.
    e.push(box(COL.gold, 0.34, 0.72, 0.56, side * (HW - 0.15), 2.05, 0));
    e.push(box(COL.stoneDark, 0.18, 2.0, 0.18, side * (HW - 0.15), 3.35, 0));
  }
  for (const x of [-1.2, 0, 1.2]) {
    e.push(box(COL.gold, 0.1, 0.26, 0.1, x, 1.62, 0));
  }
  return merge(e, 0.4);
}

/** A carved idol filling one lane: go around it. */
function buildBlock() {
  return merge(
    [
      box(COL.stoneDark, 1.34, 0.22, 1.04, 0, 0.11, 0),
      box(COL.stone, 1.12, 1.42, 0.86, 0, 0.93, 0),
      box(COL.stoneLight, 1.34, 0.28, 1.04, 0, 1.78, 0),
      box(COL.jade, 0.66, 0.66, 0.08, 0, 1.06, 0.45),
      box(COL.gold, 0.66, 0.12, 0.1, 0, 1.44, 0.46),
    ],
    0.4
  );
}

export class Entities {
  constructor(rng) {
    const tex = textures(C.FOG_COLOR);
    // A dim emissive floor keeps obstacles legible at the edge of the
    // torchlight — at speed, spotting them late is the difference between a
    // fair death and a cheap one.
    // No bump map here, unlike the corridor: obstacles are small on screen and
    // the extra texture fetches per fragment are not worth it on a phone.
    const stoneMat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      map: tex.stone,
      shininess: 10,
      specular: 0x2a2218,
      emissive: 0x1a120a,
    });
    const coinMat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 90,
      specular: 0xffe1a0,
      emissive: 0x6b4410,
    });

    const geos = {
      [COIN]: buildCoin(),
      [BARRIER]: buildBarrier(),
      [BEAM]: buildBeam(),
      [BLOCK]: buildBlock(),
    };

    this.meshes = {};
    this.group = new THREE.Group();
    for (const k of KINDS) {
      const count = SPEC[k].cap;
      const m = new THREE.InstancedMesh(geos[k], k === COIN ? coinMat : stoneMat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      for (let i = 0; i < count; i++) m.setMatrixAt(i, ZERO);
      m.instanceMatrix.needsUpdate = true;
      this.meshes[k] = m;
      this.group.add(m);
    }

    // Coin poses, cached at refresh time so the spin below never has to walk
    // the path again.
    this.coinSlots = [];
    this.reset(rng);
  }

  reset(rng) {
    this.rng = rng;
    this.items = []; // always sorted by s
    this.cursor = 0; // collision scan cursor, monotone in s
    this.coinSlots.length = 0;
    this.dirty = true;
  }

  /** Populate one path node with obstacles and coins. */
  spawnForNode(node) {
    const rng = this.rng;
    const items = this.items;

    if (node.kind === ARC) {
      // Corners stay clean — a line of coins through the middle rewards
      // taking the turn tight.
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
    this.coinSlots.length = 0;

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.alive) continue;
      const spec = SPEC[it.kind];
      const n = counts[it.kind];
      if (n >= spec.cap) continue;
      path.pointAt(it.s, it.lane * C.LANE_W, _p);

      if (it.kind === COIN) {
        // Deferred to spin(); only the pose is needed here.
        this.coinSlots.push({ x: _p.x, y: spec.y, z: _p.z, yaw: _p.yaw, phase: it.s * 0.7 });
      } else {
        _v.set(_p.x, spec.y, _p.z);
        _e.set(0, _p.yaw, 0);
        _q.setFromEuler(_e);
        _m.compose(_v, _q, _one);
        this.meshes[it.kind].setMatrixAt(n, _m);
      }
      counts[it.kind] = n + 1;
    }

    for (const k of KINDS) {
      if (k === COIN) continue;
      const mesh = this.meshes[k];
      for (let i = counts[k]; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.dirty = false;
    this.spin(0);
  }

  /** Spin the coins in place. Cheap: cached poses, no path lookups. */
  spin(t) {
    const mesh = this.meshes[COIN];
    const slots = this.coinSlots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      _v.set(s.x, s.y, s.z);
      _e.set(0, s.yaw + t * 2.6 + s.phase, 0);
      _q.setFromEuler(_e);
      _m.compose(_v, _q, _one);
      mesh.setMatrixAt(i, _m);
    }
    for (let i = slots.length; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Cheap 1D scan. Returns the number of coins collected; calls onHit(kind)
   * when the player runs into something.
   *
   * Whether a hit ends the run is not decided here — that depends on the chase
   * — so the obstacle is consumed on contact either way. Leaving it in place
   * would re-trigger the collision every frame the player overlapped it, which
   * would turn a single stumble into an instant catch.
   */
  collide(player, onHit) {
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

      const struck =
        (it.kind === BARRIER && player.y < BARRIER_CLEAR_Y) ||
        (it.kind === BEAM && !player.isSliding) ||
        it.kind === BLOCK;
      if (struck) {
        it.alive = false;
        this.dirty = true;
        onHit(it.kind);
        break;
      }
    }
    return collected;
  }
}
