// Verifies the track centreline's sign conventions and arc-length
// parameterisation. Run: node tools/path-test.mjs
//
// This exists because pathPose sign errors are silent — the world just rotates
// the wrong way, or drifts off the arc — and are miserable to debug through a
// renderer. Everything here is plain math, so it runs in a fraction of a second.

import { Path, poseOnNode, localToTrack, STRAIGHT, ARC, LEFT, RIGHT, ARC_LEN } from '../js/game/path.js';
import { ARC_RADIUS, SEGMENT_LEN, makeRng } from '../js/game/config.js';

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}

function near(a, b, eps, msg) {
  checks++;
  if (!(Math.abs(a - b) <= eps)) {
    failures++;
    console.error(`  FAIL: ${msg} (got ${a}, want ${b} +/- ${eps})`);
  }
}

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function section(name) {
  console.log(name);
}

// Build an explicit path rather than a random one, so the assertions below can
// name the exact geometry they expect.
function buildFixture() {
  const nodes = [];
  let x = 0;
  let z = 0;
  let yaw = 0;
  let s0 = 0;
  const out = { x: 0, z: 0, yaw: 0 };
  const push = (kind, dir) => {
    const len = kind === STRAIGHT ? SEGMENT_LEN : ARC_LEN;
    const n = { kind, x, z, yaw, s0, len, dir: dir || 0, radius: kind === ARC ? ARC_RADIUS : 0 };
    nodes.push(n);
    poseOnNode(n, len, out);
    x = out.x;
    z = out.z;
    yaw = out.yaw;
    s0 += len;
    return n;
  };
  push(STRAIGHT);
  push(STRAIGHT);
  push(ARC, LEFT);
  push(STRAIGHT);
  push(ARC, RIGHT);
  push(STRAIGHT);
  push(ARC, RIGHT);
  push(STRAIGHT);
  return { nodes, total: s0 };
}

function poseOfFixture(fx, d, out) {
  let i = 0;
  while (i < fx.nodes.length - 1 && d >= fx.nodes[i].s0 + fx.nodes[i].len) i++;
  return poseOnNode(fx.nodes[i], d - fx.nodes[i].s0, out);
}

// --------------------------------------------------------------------------
section('1. Heading convention');
{
  // forward(yaw) = (-sin yaw, -cos yaw); at yaw 0 that is -Z.
  const n = { kind: STRAIGHT, x: 0, z: 0, yaw: 0, s0: 0, len: 10, dir: 0, radius: 0 };
  const p = poseOnNode(n, 10, { x: 0, z: 0, yaw: 0 });
  near(p.x, 0, 1e-9, 'straight at yaw 0 does not drift in x');
  near(p.z, -10, 1e-9, 'straight at yaw 0 advances toward -Z');
}

// --------------------------------------------------------------------------
section('2. A left arc turns left, a right arc turns right');
{
  const l = { kind: ARC, x: 0, z: 0, yaw: 0, s0: 0, len: ARC_LEN, dir: LEFT, radius: ARC_RADIUS };
  const p = poseOnNode(l, ARC_LEN, { x: 0, z: 0, yaw: 0 });
  near(p.yaw, Math.PI / 2, 1e-9, 'left arc ends at yaw +90 degrees');
  near(p.x, -ARC_RADIUS, 1e-9, 'left arc exits to -X');
  near(p.z, -ARC_RADIUS, 1e-9, 'left arc exits to -Z');
  // Facing -X after a left turn from -Z is what "left" means here.
  near(-Math.sin(p.yaw), -1, 1e-9, 'post-left-turn forward is -X');

  const r = { kind: ARC, x: 0, z: 0, yaw: 0, s0: 0, len: ARC_LEN, dir: RIGHT, radius: ARC_RADIUS };
  const q = poseOnNode(r, ARC_LEN, { x: 0, z: 0, yaw: 0 });
  near(q.yaw, -Math.PI / 2, 1e-9, 'right arc ends at yaw -90 degrees');
  near(q.x, ARC_RADIUS, 1e-9, 'right arc exits to +X');
  near(q.z, -ARC_RADIUS, 1e-9, 'right arc exits to -Z');
  near(-Math.sin(q.yaw), 1, 1e-9, 'post-right-turn forward is +X');
}

// --------------------------------------------------------------------------
section('3. Arc-length parameterisation and heading continuity');
{
  const fx = buildFixture();
  const a = { x: 0, z: 0, yaw: 0 };
  const b = { x: 0, z: 0, yaw: 0 };
  const STEP = 0.01;
  let worstStep = 0;
  let worstYaw = 0;
  for (let d = 0; d < fx.total - STEP; d += STEP) {
    poseOfFixture(fx, d, a);
    const ax = a.x;
    const az = a.z;
    const ayaw = a.yaw;
    poseOfFixture(fx, d + STEP, b);
    const moved = Math.hypot(b.x - ax, b.z - az);
    worstStep = Math.max(worstStep, Math.abs(moved - STEP));
    worstYaw = Math.max(worstYaw, Math.abs(wrapPi(b.yaw - ayaw)));
  }
  // A 0.01 m step along a 6 m radius arc chords slightly under 0.01 m; the
  // error is O(step^3/radius^2), which is ~1e-8 here.
  ok(worstStep < 1e-6, `every 0.01 m step moves 0.01 m (worst error ${worstStep.toExponential(2)})`);
  ok(worstYaw < 0.01, `heading is continuous across node seams (worst jump ${worstYaw.toExponential(2)} rad)`);
}

// --------------------------------------------------------------------------
section('4. Position is continuous across node seams');
{
  const fx = buildFixture();
  const a = { x: 0, z: 0, yaw: 0 };
  const b = { x: 0, z: 0, yaw: 0 };
  for (let i = 0; i < fx.nodes.length - 1; i++) {
    const seam = fx.nodes[i].s0 + fx.nodes[i].len;
    poseOfFixture(fx, seam - 1e-6, a);
    const ax = a.x;
    const az = a.z;
    poseOfFixture(fx, seam + 1e-6, b);
    ok(Math.hypot(b.x - ax, b.z - az) < 1e-5, `no position jump at seam ${i} -> ${i + 1}`);
  }
}

// --------------------------------------------------------------------------
section('5. Every corner is exactly 90 degrees');
{
  const fx = buildFixture();
  const a = { x: 0, z: 0, yaw: 0 };
  const b = { x: 0, z: 0, yaw: 0 };
  for (const n of fx.nodes) {
    if (n.kind !== ARC) continue;
    poseOnNode(n, 0, a);
    const before = a.yaw;
    poseOnNode(n, n.len, b);
    near(Math.abs(wrapPi(b.yaw - before)), Math.PI / 2, 1e-9, 'corner sweeps exactly 90 degrees');
    ok(Math.sign(wrapPi(b.yaw - before)) === n.dir, 'corner sweeps in the direction of node.dir');
  }
}

// --------------------------------------------------------------------------
section('6. Every point on an arc is exactly `radius` from its centre');
{
  const n = { kind: ARC, x: 3, z: -11, yaw: 0.9, s0: 0, len: ARC_LEN, dir: LEFT, radius: ARC_RADIUS };
  const cx = n.x - Math.cos(n.yaw) * n.radius * n.dir;
  const cz = n.z + Math.sin(n.yaw) * n.radius * n.dir;
  const p = { x: 0, z: 0, yaw: 0 };
  let worst = 0;
  for (let t = 0; t <= n.len; t += 0.05) {
    poseOnNode(n, t, p);
    worst = Math.max(worst, Math.abs(Math.hypot(p.x - cx, p.z - cz) - n.radius));
  }
  ok(worst < 1e-9, `arc stays on its circle from an arbitrary entry pose (worst ${worst.toExponential(2)})`);
}

// --------------------------------------------------------------------------
section('7. rebase() is a pure change of reference frame');
{
  const path = new Path(makeRng(7));
  while (path.end < 400) path.append();

  // Sample world-space *relationships* that must survive a rebase: distances
  // between pairs of points, and headings relative to each other.
  const probes = [];
  const tmp = { x: 0, z: 0, yaw: 0 };
  for (let d = 30; d < 300; d += 7.3) {
    path.poseAt(d, tmp);
    probes.push({ d, x: tmp.x, z: tmp.z, yaw: tmp.yaw });
  }

  // Retire a few nodes and rebase, exactly as the streaming loop does.
  let shift = 0;
  for (let k = 0; k < 3; k++) {
    path.retireFirst();
    shift += path.rebase();
  }
  ok(shift > 0, 'rebase reports a positive distance shift');

  let worstDist = 0;
  let worstYaw = 0;
  for (let i = 1; i < probes.length; i++) {
    const p0 = probes[i - 1];
    const p1 = probes[i];
    if (p0.d - shift < 0) continue; // retired, no longer representable
    path.poseAt(p0.d - shift, tmp);
    const ax = tmp.x;
    const az = tmp.z;
    const ayaw = tmp.yaw;
    path.poseAt(p1.d - shift, tmp);
    const before = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const after = Math.hypot(tmp.x - ax, tmp.z - az);
    worstDist = Math.max(worstDist, Math.abs(before - after));
    worstYaw = Math.max(
      worstYaw,
      Math.abs(wrapPi(wrapPi(p1.yaw - p0.yaw) - wrapPi(tmp.yaw - ayaw)))
    );
  }
  ok(worstDist < 1e-9, `rebase preserves distances between points (worst ${worstDist.toExponential(2)})`);
  ok(worstYaw < 1e-9, `rebase preserves relative headings (worst ${worstYaw.toExponential(2)})`);

  // And the new origin really is the first node.
  ok(Math.abs(path.nodes[0].x) < 1e-9 && Math.abs(path.nodes[0].z) < 1e-9, 'rebase puts node 0 at the origin');
  ok(Math.abs(path.nodes[0].yaw) < 1e-9, 'rebase puts node 0 at yaw 0');
  ok(Math.abs(path.nodes[0].s0) < 1e-9, 'rebase puts node 0 at distance 0');
}

// --------------------------------------------------------------------------
section('8. Cursor-based pose() agrees with cursor-free poseAt()');
{
  const path = new Path(makeRng(21));
  while (path.end < 500) path.append();
  const scratch = { x: 0, z: 0, yaw: 0 };
  let worst = 0;
  for (let d = 0; d < 480; d += 0.37) {
    const a = path.pose(d);
    const ax = a.x;
    const az = a.z;
    path.poseAt(d, scratch);
    worst = Math.max(worst, Math.hypot(scratch.x - ax, scratch.z - az));
  }
  ok(worst < 1e-12, 'forward scan matches');

  // ...including when distance moves backwards, which teleportTo and restart do.
  worst = 0;
  for (let d = 480; d > 0; d -= 0.37) {
    const a = path.pose(d);
    const ax = a.x;
    const az = a.z;
    path.poseAt(d, scratch);
    worst = Math.max(worst, Math.hypot(scratch.x - ax, scratch.z - az));
  }
  ok(worst < 1e-12, 'backward scan matches (cursor rewinds correctly)');
}

// --------------------------------------------------------------------------
section('9. localToTrack agrees with a lateral offset on the centreline');
{
  const path = new Path(makeRng(3));
  while (path.end < 200) path.append();
  const a = { x: 0, z: 0, yaw: 0 };
  const b = { x: 0, z: 0, yaw: 0 };
  const node = path.nodes[2];
  // A point 1.6 m right of the node's entry, expressed both ways.
  localToTrack(node, 1.6, 0, a);
  path.pointAt(node.s0, 1.6, b);
  near(a.x, b.x, 1e-9, 'localToTrack x matches pointAt x');
  near(a.z, b.z, 1e-9, 'localToTrack z matches pointAt z');
}

// --------------------------------------------------------------------------
section('10. Generated paths space their corners sensibly');
{
  for (let seed = 1; seed <= 20; seed++) {
    const path = new Path(makeRng(seed));
    while (path.end < 3000) path.append();
    const arcs = path.nodes.filter((n) => n.kind === ARC);
    ok(arcs.length > 5, `seed ${seed} generates corners`);
    for (let i = 1; i < arcs.length; i++) {
      const gap = arcs[i].s0 - (arcs[i - 1].s0 + arcs[i - 1].len);
      ok(gap >= 60 - 1e-9, `seed ${seed}: corners at least 60 m apart (got ${gap.toFixed(1)})`);
      ok(gap <= 140 + 1e-9, `seed ${seed}: corners at most 140 m apart (got ${gap.toFixed(1)})`);
    }
    ok(path.nodes[0].kind === STRAIGHT, `seed ${seed} opens on a straight`);
    ok(path.nextArc(0).s0 >= 100 - 1e-9, `seed ${seed} gives a 100 m run-up to the first corner`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
