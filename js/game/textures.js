// Procedural textures, drawn into canvases at boot.
//
// No image files: the PWA precaches everything it needs, and a few hundred
// milliseconds of canvas work at startup is cheaper to ship (and to cache) than
// megabytes of PNG. Everything here runs once.

import * as THREE from './three.js';

/** Deterministic RNG so the masonry looks the same on every device and run. */
function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * Weathered block masonry, as a colour map and a matching height map.
 *
 * Both are drawn in the same pass from the same random numbers, so the bump
 * lines up exactly with the mortar courses in the colour map — which is the
 * whole reason the stone reads as three-dimensional under a moving torch
 * instead of as a flat photograph of bricks.
 */
function stone(size = 512) {
  const rng = rand(0x5eed);
  const cc = canvas(size);
  const hc = canvas(size);
  const g = cc.getContext('2d');
  const h = hc.getContext('2d');

  // Deliberately near-white. This map is multiplied by a per-surface vertex
  // colour, so anything darker than this would multiply *twice* into mud — the
  // texture's job is grain and mortar, and the vertex colour's job is hue and
  // value. Keeping those two responsibilities apart is what stops the whole
  // corridor collapsing into one brown.
  g.fillStyle = '#ded7ca';
  g.fillRect(0, 0, size, size);
  h.fillStyle = '#8a8a8a';
  h.fillRect(0, 0, size, size);

  // Block courses. Widths divide the canvas so the pattern tiles horizontally,
  // and alternate rows are offset by half a block like real coursed masonry.
  const rows = 8;
  const rh = size / rows;
  const cols = 4;
  const cw = size / cols;

  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (cw / 2);
    for (let c = -1; c < cols + 1; c++) {
      const x = c * cw + offset + 2;
      const y = r * rh + 2;
      const w = cw - 4;
      const bh = rh - 4;

      // Per-block tonal drift keeps a large wall from looking stamped.
      const v = 0.88 + rng() * 0.16;
      const rr = Math.min(255, Math.round(226 * v));
      const gg = Math.min(255, Math.round(218 * v));
      const bb = Math.min(255, Math.round(202 * v));
      g.fillStyle = `rgb(${rr},${gg},${bb})`;
      g.fillRect(x, y, w, bh);

      const hv = Math.round(150 + rng() * 55);
      h.fillStyle = `rgb(${hv},${hv},${hv})`;
      h.fillRect(x, y, w, bh);

      // A lit top edge and a shadowed bottom edge give each block relief even
      // on surfaces the bump map barely catches.
      g.fillStyle = 'rgba(255,240,214,0.10)';
      g.fillRect(x, y, w, 2);
      g.fillStyle = 'rgba(20,14,8,0.22)';
      g.fillRect(x, y + bh - 3, w, 3);
    }
  }

  // Grain: fine speckle over everything. Edge seams from non-tiling specks are
  // a pixel or two wide and vanish under minification.
  for (let i = 0; i < 9000; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const a = rng() * 0.14;
    g.fillStyle = rng() < 0.5 ? `rgba(255,246,222,${a})` : `rgba(26,18,10,${a})`;
    g.fillRect(x, y, 1 + rng() * 1.6, 1 + rng() * 1.6);

    const hv = rng() < 0.5 ? 255 : 0;
    h.fillStyle = `rgba(${hv},${hv},${hv},${rng() * 0.1})`;
    h.fillRect(x, y, 1 + rng() * 1.6, 1 + rng() * 1.6);
  }

  // Cracks and chips, kept clear of the edges so they never straddle a seam.
  // Faint on purpose: the floor projects roughly one tile every three metres,
  // so anything bolder than this reads as scribble rather than as weathering.
  for (let i = 0; i < 18; i++) {
    let x = 40 + rng() * (size - 80);
    let y = 40 + rng() * (size - 80);
    g.strokeStyle = `rgba(64,48,30,${0.08 + rng() * 0.12})`;
    h.strokeStyle = `rgba(70,70,70,${0.3 + rng() * 0.3})`;
    g.lineWidth = 0.8 + rng() * 1.0;
    h.lineWidth = g.lineWidth;
    g.beginPath();
    h.beginPath();
    g.moveTo(x, y);
    h.moveTo(x, y);
    const steps = 3 + Math.floor(rng() * 4);
    for (let s = 0; s < steps; s++) {
      x += (rng() - 0.5) * 46;
      y += (rng() - 0.5) * 46;
      g.lineTo(x, y);
      h.lineTo(x, y);
    }
    g.stroke();
    h.stroke();
  }

  const map = new THREE.CanvasTexture(cc);
  const bump = new THREE.CanvasTexture(hc);
  for (const t of [map, bump]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  // Only the colour map carries sRGB values; a height map is raw data.
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, bump };
}

/**
 * A vertical sky gradient. The bottom band is the fog colour exactly, so the
 * horizon has no visible join: geometry fades into fog, fog matches sky.
 */
function sky(fogColor) {
  const c = canvas(2);
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d');
  const horizon = `#${new THREE.Color(fogColor).getHexString()}`;
  // Dusk: deep blue overhead falling through violet into the warm haze the
  // corridor disappears into.
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#16243f');
  grad.addColorStop(0.38, '#33405f');
  grad.addColorStop(0.66, '#6d5566');
  grad.addColorStop(0.86, '#a8724c');
  grad.addColorStop(1.0, horizon);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round mote, for the dust particles. */
function mote() {
  const c = canvas(64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,226,178,1)');
  grad.addColorStop(0.35, 'rgba(255,196,120,0.55)');
  grad.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let cached = null;

/** Build (once) and return every texture the game uses. */
export function textures(fogColor) {
  if (!cached) {
    const s = stone();
    cached = { stone: s.map, stoneBump: s.bump, sky: sky(fogColor), mote: mote() };
  }
  return cached;
}
