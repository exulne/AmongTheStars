// Drawing helpers shared by the micro levels (body, cell, molecule, atom).

import * as THREE from 'three';

// ---------------------------------------------------------------- shared drawing helpers

/**
 * A see-through skin with a bright rim where it turns away from the eye: for
 * membranes, bodies and shells. Modest by design: the rim stays well under
 * the bloom threshold unless `rim` is raised.
 */
export function rimMaterial(color: number, opacity: number, rim: number, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 0.6, metalness: 0, depthWrite: false, side });
  const rimCol = new THREE.Color(color);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: rim };
    sh.uniforms.uRimCol = { value: rimCol };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRim; uniform vec3 uRimCol;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.5);
        totalEmissiveRadiance += uRimCol * fres * uRim;
        diffuseColor.a *= mix(0.3, 1.0, fres);`);
  };
  return m;
}

/** A solid with a gentle glow of its own colour. */
export function solid(color: number, glow = 0.12, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({ color: c, emissive: c.clone().multiplyScalar(glow), roughness: 0.55, metalness: 0.05, ...opts });
}

/** Soft key and fill lights for a micro scene (only lit while its group is shown). */
export function addLights(g: THREE.Group, scale: number): void {
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x1a1410, 0.9);
  const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
  key.position.set(scale * 2, scale * 3, scale * 2.5);
  const rimL = new THREE.DirectionalLight(0x88b8ff, 0.7);
  rimL.position.set(-scale * 3, scale, -scale * 2);
  g.add(hemi, key, rimL);
}

/** Geometry for a capsule running from a to b. */
export function capsule(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 12): THREE.BufferGeometry {
  const d = b.clone().sub(a), L = Math.max(1e-6, d.length());
  const g = new THREE.CapsuleGeometry(r, L, 4, radial);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Points along a curve, every `step` world units, for picking long thin things. */
export function along(curve: THREE.Curve<THREE.Vector3>, step: number): THREE.Vector3[] {
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  return Array.from({ length: n + 1 }, (_, k) => curve.getPointAt(k / n));
}

/** Deterministic random numbers for drawing. */
export function rng(seed: number): () => number {
  let s = (Math.floor(seed * 1e6) * 2654435761) >>> 0 || 7;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A pickable piece of a micro scene: where it can be grabbed, how far the grab reaches, where its middle is. */
export interface Grab { id: number; at: THREE.Vector3[]; r: number; centre: THREE.Vector3; name: string; weight?: number }
