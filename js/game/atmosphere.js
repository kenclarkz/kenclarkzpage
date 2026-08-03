// Sky, airborne embers, and the torchlight that travels with the runner.
//
// All of it lives in scene space rather than in the world group, which the
// world-moves-instead-of-the-player architecture makes unusually convenient:
// the player never leaves the origin, so a light parked a few metres ahead of
// them stays parked there for the whole run while the corridor sweeps through
// it. That single static light is what animates the masonry.

import * as THREE from './three.js';
import { textures } from './textures.js';
import * as C from './config.js';

const DUST = 260;
const DUST_X = 9;
const DUST_Y = 5.0; // kept below the wall tops, so motes read as embers in the
                    // corridor rather than as stars in the sky
const DUST_BACK = -74; // furthest a mote sits ahead of the player
const DUST_FRONT = 13; // past the camera, where a mote recycles

export class Atmosphere {
  constructor(scene) {
    const tex = textures(C.FOG_COLOR);

    // --- sky -------------------------------------------------------------
    // depthTest off plus renderOrder -1 makes this a true backdrop: it fills
    // every pixel nothing else covers, so its radius never has to be reconciled
    // with camera.far.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(60, 16, 12),
      new THREE.MeshBasicMaterial({
        map: tex.sky,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
      })
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    scene.add(sky);
    this.sky = sky;

    // --- embers ----------------------------------------------------------
    const pos = new Float32Array(DUST * 3);
    this.speeds = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) this.respawn(pos, i, true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: tex.mote,
        size: 0.13,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.6,
      })
    );
    dust.frustumCulled = false;
    scene.add(dust);
    this.dust = dust;
    this.pos = pos;

    // --- lights ----------------------------------------------------------
    // Three lights, deliberately. Every light is evaluated per fragment for
    // every surface on screen, so a fourth costs real frame time on a phone for
    // a scene this simple.
    //
    // Sky fill and a low warm sun do the heavy lifting: between them the
    // corridor stays readable all the way out to the fog. A torch strong enough
    // to light the middle distance on its own would have to be so bright up
    // close that the near walls blow out to flat orange.
    scene.add(new THREE.HemisphereLight(0x9dbbe8, 0x6a5138, 2.6));
    const sun = new THREE.DirectionalLight(0xffd9a0, 2.3);
    // Low and off to one side, so the pilasters and cornices cast their shape
    // across the walls instead of being lit flat-on.
    sun.position.set(5, 6, 2);
    scene.add(sun);

    // The torch is for warmth and flicker, not for exposure. Sitting ahead of
    // the runner with a gentle falloff, it rakes across the block courses as
    // they approach, which is what makes the bump map visible.
    this.torch = new THREE.PointLight(0xff9a45, 34, 46, 1.6);
    this.torch.position.set(0, 3.4, -6);
    scene.add(this.torch);

    this.t = 0;
  }

  respawn(pos, i, anywhere) {
    pos[i * 3] = (Math.random() * 2 - 1) * DUST_X;
    pos[i * 3 + 1] = 0.25 + Math.random() * DUST_Y;
    pos[i * 3 + 2] = anywhere
      ? DUST_BACK + Math.random() * (DUST_FRONT - DUST_BACK)
      : DUST_BACK + Math.random() * 8;
    // Slight per-mote speed spread reads as depth even without parallax.
    this.speeds[i] = 0.72 + Math.random() * 0.5;
  }

  /** @param {number} speed the runner's current speed, in m/s */
  update(dt, speed) {
    this.t += dt;

    const pos = this.pos;
    for (let i = 0; i < DUST; i++) {
      pos[i * 3 + 2] += speed * this.speeds[i] * dt;
      pos[i * 3 + 1] += Math.sin(this.t * 1.7 + i) * 0.12 * dt;
      if (pos[i * 3 + 2] > DUST_FRONT) this.respawn(pos, i, false);
    }
    this.dust.geometry.attributes.position.needsUpdate = true;

    // Layered sines beat a random walk here: the flicker stays continuous
    // across frames, so it never strobes when the frame rate dips.
    const f =
      0.86 +
      0.09 * Math.sin(this.t * 11.3) +
      0.05 * Math.sin(this.t * 26.7 + 1.3);
    this.torch.intensity = 34 * f;
  }
}
