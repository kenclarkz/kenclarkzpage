// Collectible logos: six spinning badges scattered through each park.
//
// A logo has no physics of its own — it is a distance check against the
// ride's position, run once a frame by main.js, which also owns the sound,
// the HUD counter and the save. This module only knows how to look like a
// badge and how to spin.

import * as THREE from '../game/three.js';

/** Drawn once and shared by every logo in the game: a canvas costs nothing
 * next to a whole texture file, and there is exactly one design to draw. */
let _texture = null;
function logoTexture() {
  if (_texture) return _texture;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffc93f';
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = '#17130a';
  g.stroke();
  g.fillStyle = '#17130a';
  g.font = '700 64px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('K', 65, 72);
  _texture = new THREE.CanvasTexture(c);
  _texture.colorSpace = THREE.SRGBColorSpace;
  return _texture;
}

const HOVER = 0.85;    // metres above the ground a logo floats
export const PICKUP_R = 0.85;

export class Logo {
  constructor(x, z, groundY) {
    const geo = new THREE.CircleGeometry(0.26, 20);
    const material = new THREE.MeshBasicMaterial({
      map: logoTexture(),
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.baseY = groundY + HOVER;
    this.mesh.position.set(x, this.baseY, z);
    this.x = x;
    this.z = z;
    this.spin = Math.random() * Math.PI * 2;
    this.bob = Math.random() * Math.PI * 2;
    this.collected = false;
  }

  update(dt, t) {
    if (this.collected) return;
    this.spin += dt * 1.3;
    this.mesh.rotation.y = this.spin;
    this.mesh.position.y = this.baseY + Math.sin(t * 1.6 + this.bob) * 0.08;
  }

  collect() {
    this.collected = true;
    this.mesh.visible = false;
  }
}

/** Every logo for one park, already parented to its group — so they are
 * removed and disposed for free whenever the park itself is. */
export function makeLogos(park) {
  const spots = park.logos || [];
  const logos = spots.map(({ x, z }) => new Logo(x, z, park.heightAt(x, z)));
  for (const l of logos) park.group.add(l.mesh);
  return logos;
}

/** The nearest uncollected logo within pickup range of `pos`, or null. */
export function checkPickup(logos, pos) {
  for (const l of logos) {
    if (l.collected) continue;
    const dx = pos.x - l.x;
    const dz = pos.z - l.z;
    if (dx * dx + dz * dz < PICKUP_R * PICKUP_R) {
      l.collect();
      return l;
    }
  }
  return null;
}
