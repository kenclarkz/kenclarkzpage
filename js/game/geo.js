// Geometry authoring helpers.
//
// The whole art budget rests on one idea: a piece of architecture is described
// as a list of transformed boxes, then merged into a *single* BufferGeometry
// with the surface colour baked into a vertex-colour attribute. One merged
// geometry plus one material is one draw call, so a corridor section can carry
// forty pieces of trim for the same cost as a bare floor slab.
//
// three's mergeGeometries lives in examples/jsm, which this project does not
// vendor, so the merge is done here. Sources are converted to non-indexed
// first: at 36 vertices per box the memory is irrelevant and it removes all
// index-offset arithmetic, which is where a hand-rolled merge usually breaks.

import * as THREE from './three.js';

const UNIT = new THREE.BoxGeometry(1, 1, 1);

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/**
 * One box in a merge list. Rotations are applied in the same order the old
 * per-mesh code used (Euler XYZ), so ported geometry keeps its exact shape.
 */
export function box(color, sx, sy, sz, px, py, pz, rx, ry, rz) {
  _p.set(px, py, pz);
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return { geo: UNIT, color, matrix: new THREE.Matrix4().compose(_p, _q, _s) };
}

/** As `box`, but for an arbitrary source geometry (cylinders, cones, ...). */
export function piece(geo, color, sx, sy, sz, px, py, pz, rx, ry, rz) {
  _p.set(px, py, pz);
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return { geo, color, matrix: new THREE.Matrix4().compose(_p, _q, _s) };
}

/**
 * Replace UVs with a planar projection along each face's dominant axis, scaled
 * in metres.
 *
 * Box UVs run 0..1 per face regardless of the box's size, so a 20 m floor slab
 * and a 0.3 m trim block would each get exactly one copy of the stone texture —
 * the floor smeared, the trim microscopic. Projecting from world position
 * instead gives every surface in the game the same texel density, which is what
 * makes the masonry read as one material rather than a collage.
 */
function planarUv(geo, scale) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const uv = new Float32Array((pos.length / 3) * 2);

  // Step a triangle at a time and pick the axis pair from its first normal, so
  // all three vertices of a face agree and the projection never seams mid-face.
  for (let t = 0; t < pos.length; t += 9) {
    const nx = Math.abs(nor[t]);
    const ny = Math.abs(nor[t + 1]);
    const nz = Math.abs(nor[t + 2]);
    let a;
    let b;
    if (ny >= nx && ny >= nz) {
      a = 0; b = 2;          // floors and ceilings: project x,z
    } else if (nx >= nz) {
      a = 2; b = 1;          // walls facing along x: project z,y
    } else {
      a = 0; b = 1;          // walls facing along z: project x,y
    }
    for (let k = 0; k < 3; k++) {
      const i = t + k * 3;
      const v = t / 3 + k;
      uv[v * 2] = pos[i + a] * scale;
      uv[v * 2 + 1] = pos[i + b] * scale;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Merge a list of `box`/`piece` entries into one geometry carrying position,
 * normal, uv and colour.
 *
 * @param {Array} entries
 * @param {number} uvScale texture repeats per metre
 */
export function merge(entries, uvScale = 0.3) {
  const parts = [];
  let total = 0;
  for (const e of entries) {
    const g = e.geo.index ? e.geo.toNonIndexed() : e.geo.clone();
    g.applyMatrix4(e.matrix); // transforms normals correctly too
    parts.push({ g, color: new THREE.Color(e.color) });
    total += g.attributes.position.count;
  }

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  let o = 0;
  for (const part of parts) {
    const n = part.g.attributes.position.count;
    position.set(part.g.attributes.position.array, o * 3);
    normal.set(part.g.attributes.normal.array, o * 3);
    // THREE.Color converts the hex from sRGB into the renderer's linear working
    // space, which is what a vertex-colour attribute is expected to hold.
    const { r, g: cg, b } = part.color;
    for (let i = 0; i < n; i++) {
      color[(o + i) * 3] = r;
      color[(o + i) * 3 + 1] = cg;
      color[(o + i) * 3 + 2] = b;
    }
    o += n;
    part.g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  planarUv(geo, uvScale);
  geo.computeBoundingSphere();
  return geo;
}
