// How a society shows from orbit. The worker's society model gives each
// place an architecture (hue, height, curvature, density, glow); the app
// fetches it for the world in view and the planet view reads it here, so a
// grown-spire culture in violet and a squat amber warren look different from
// space, and both change as the place does.

import * as THREE from 'three';

export interface ArchLook { hue: number; height: number; curvature: number; density: number; glow: number }

const looks = new Map<number, { year: number; a: ArchLook }>();

/** Remember body b's architecture as of `year`; true if what shows has changed. */
export function setSocietyLook(b: number, year: number, a: ArchLook | null): boolean {
  const old = looks.get(b)?.a;
  if (!a) { looks.delete(b); return !!old; }
  looks.set(b, { year, a });
  return !old || lookKey(old) !== lookKey(a);
}
export function societyLook(b: number): ArchLook | null { return looks.get(b)?.a ?? null; }
export function clearSocietyLooks(): void { looks.clear(); }

/** Changes whenever anything visible changes (coarse, so small drifts don't rebuild buildings). */
export function lookKey(a: ArchLook | null): string {
  return a ? [Math.round(a.hue / 10), Math.round(a.height * 8), Math.round(a.curvature * 4), Math.round(a.density * 6), Math.round(a.glow * 6)].join(',') : '';
}

/** The society's own colour: its building skin (dark) and its light (bright). */
export function cultureSkin(a: ArchLook, out: THREE.Color): THREE.Color { return out.setHSL(a.hue / 360, 0.32, 0.3); }
export function cultureLight(a: ArchLook, out: THREE.Color): THREE.Color { return out.setHSL(a.hue / 360, 0.65, 0.6); }

/** Tint a planet's night lights with its society's colour and glow (or reset to the age's own look). */
export function applyCultureLights(mesh: THREE.Mesh, a: ArchLook | null): void {
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  if (!u.uCulture) return;
  if (!a) { u.uCultureMix.value = 0; u.uGlow.value = 1; return; }
  cultureLight(a, u.uCulture.value as THREE.Color);
  u.uCultureMix.value = 0.45;
  u.uGlow.value = 0.65 + 0.7 * a.glow;
}
