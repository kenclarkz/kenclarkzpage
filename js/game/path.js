// The track's centreline, as pure math. No three.js import — this module runs
// unchanged in Node, which is what lets tools/path-test.mjs verify the sign
// conventions below before a single triangle is drawn.
//
// Conventions (all verified by tools/path-test.mjs, do not "fix" by eye):
//   - Local forward is -Z, so forward(yaw) = (-sin yaw, -cos yaw).
//   - Right is  right(yaw) = (cos yaw, -sin yaw).
//   - dir = +1 turns LEFT and increases yaw; dir = -1 turns RIGHT.
//   - Nodes store the pose at their START; poseOnNode walks t metres into them.

import { ARC_RADIUS, SEGMENT_LEN } from './config.js';

export const STRAIGHT = 0;
export const ARC = 1;

export const LEFT = 1;
export const RIGHT = -1;

export const ARC_LEN = (ARC_RADIUS * Math.PI) / 2;

/** Pose t metres into node n, written into `out` to avoid per-frame garbage. */
export function poseOnNode(n, t, out) {
  if (n.kind === STRAIGHT) {
    out.x = n.x - Math.sin(n.yaw) * t;
    out.z = n.z - Math.cos(n.yaw) * t;
    out.yaw = n.yaw;
    return out;
  }
  // The arc centre sits `radius` to the left of the entry pose for a left turn,
  // to the right for a right turn: centre = entry + left(yaw) * radius * dir.
  const theta = (t / n.radius) * n.dir;
  const cx = n.x - Math.cos(n.yaw) * n.radius * n.dir;
  const cz = n.z + Math.sin(n.yaw) * n.radius * n.dir;
  const vx = n.x - cx;
  const vz = n.z - cz;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out.x = cx + vx * c + vz * s;
  out.z = cz - vx * s + vz * c;
  out.yaw = n.yaw + theta;
  return out;
}

/** Transform a point given in a node's entry-local frame into track space. */
export function localToTrack(node, lx, lz, out) {
  const c = Math.cos(node.yaw);
  const s = Math.sin(node.yaw);
  out.x = node.x + lx * c + lz * s;
  out.z = node.z - lx * s + lz * c;
  return out;
}

export class Path {
  constructor(rng) {
    this.rng = rng;
    this.nodes = [];
    this.cursor = 0;      // memoised node index for the player's own queries
    this.end = 0;         // distance at which the last node finishes
    this._pose = { x: 0, z: 0, yaw: 0 };
    this._scan = { x: 0, z: 0, yaw: 0 };
    // Open with a straight run so the player is never cornered from a standstill.
    this._straightsLeft = 5;
    this.append();
  }

  get last() {
    return this.nodes[this.nodes.length - 1];
  }

  /** Append one node (a 20 m straight, or a 90-degree corner). */
  append() {
    const prev = this.last;
    let x = 0;
    let z = 0;
    let yaw = 0;
    let s0 = 0;
    if (prev) {
      poseOnNode(prev, prev.len, this._scan);
      x = this._scan.x;
      z = this._scan.z;
      yaw = this._scan.yaw;
      s0 = prev.s0 + prev.len;
    }

    let node;
    if (this._straightsLeft > 0) {
      this._straightsLeft--;
      node = { kind: STRAIGHT, x, z, yaw, s0, len: SEGMENT_LEN, dir: 0, radius: 0 };
    } else {
      // 3-7 straight segments between corners => 60-140 m, never two closer
      // together than 60 m.
      this._straightsLeft = 3 + Math.floor(this.rng() * 5);
      const dir = this.rng() < 0.5 ? LEFT : RIGHT;
      node = { kind: ARC, x, z, yaw, s0, len: ARC_LEN, dir, radius: ARC_RADIUS };
    }

    this.nodes.push(node);
    this.end = s0 + node.len;
    return node;
  }

  /** Pose at distance d. Uses a memoised cursor — call this for the player. */
  pose(d) {
    const nodes = this.nodes;
    let i = this.cursor;
    if (i >= nodes.length) i = nodes.length - 1;
    while (i > 0 && d < nodes[i].s0) i--;
    while (i < nodes.length - 1 && d >= nodes[i].s0 + nodes[i].len) i++;
    this.cursor = i;
    return poseOnNode(nodes[i], d - nodes[i].s0, this._pose);
  }

  /** Cursor-free pose lookup, for placing scenery without disturbing `pose`. */
  poseAt(d, out) {
    const nodes = this.nodes;
    let i = 0;
    while (i < nodes.length - 1 && d >= nodes[i].s0 + nodes[i].len) i++;
    return poseOnNode(nodes[i], d - nodes[i].s0, out);
  }

  /** Point at distance d, offset `lateral` metres to the right of centre. */
  pointAt(d, lateral, out) {
    this.poseAt(d, out);
    const c = Math.cos(out.yaw);
    const s = Math.sin(out.yaw);
    out.x += lateral * c;
    out.z -= lateral * s;
    return out;
  }

  /** The next corner at or after distance d, or null if none is generated yet. */
  nextArc(d) {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.kind === ARC && n.s0 + n.len > d) return n;
    }
    return null;
  }

  /** Drop the oldest node. Returns true if one was removed. */
  retireFirst() {
    if (this.nodes.length <= 1) return false;
    this.nodes.shift();
    this.cursor = Math.max(0, this.cursor - 1);
    return true;
  }

  /**
   * Re-express the whole path in the first node's frame. Coordinates and
   * distances would otherwise grow without bound and start visibly jittering
   * after a few kilometres. Because the world transform is recomputed from
   * scratch every frame, this is a pure change of reference frame — nothing
   * moves on screen. Returns the distance shift the caller must apply to
   * anything else holding a path distance.
   */
  rebase() {
    const ref = this.nodes[0];
    const rx = ref.x;
    const rz = ref.z;
    const ryaw = ref.yaw;
    const rs0 = ref.s0;
    const c = Math.cos(-ryaw);
    const s = Math.sin(-ryaw);
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const dx = n.x - rx;
      const dz = n.z - rz;
      n.x = dx * c + dz * s;
      n.z = -dx * s + dz * c;
      n.yaw -= ryaw;
      n.s0 -= rs0;
    }
    this.end -= rs0;
    return rs0;
  }
}
