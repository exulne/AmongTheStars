// How the age shows on a world: the style of its night lights follows the
// technology of the time, blackouts follow collapse and shortage, and a
// terraformed planet gains air, seas, plants and weather. Everything here
// reads the state snapshot; nothing is stored.

import * as THREE from 'three';
import { ERAS, STAGE_NAMES, TECHS } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';

export const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const techIx = new Map(TECHS.map((t, i) => [t.id, i]));
/** Year (since the landing) a technology was invented in this future, or -1. */
export function techYear(snap: StateMsg | null, id: string): number {
  const i = techIx.get(id);
  return snap && i !== undefined ? snap.techDone[i] : -1;
}
/** Years since a technology arrived, or -1 if it has not (yet) by `year`. */
export function techAge(snap: StateMsg | null, id: string, year: number): number {
  const t = techYear(snap, id);
  return t >= 0 && t <= year ? year - t : -1;
}

/** Index of a stage by name, tolerant of spelling ("Ring world", "Ringworld"); -1 if this build has no such stage. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
export function stageIndex(name: string): number {
  const k = norm(name);
  return STAGE_NAMES.findIndex((n) => norm(n) === k);
}
export function stageName(i: number): string { return STAGE_NAMES[i] ?? ''; }
export function isStage(i: number, name: string): boolean { return i >= 0 && norm(STAGE_NAMES[i] ?? '') === norm(name); }

// The ages of night light, each blending in over `ramp` years after its technology.
// A later age never starts before the previous one is under way.
const LIGHT_AGES: { tech: string; ramp: number }[] = [
  { tech: 'fusion', ramp: 80 },          // white LED grids
  { tech: 'orbitalHabitats', ramp: 120 },// blue arcology clusters
  { tech: 'nanofab', ramp: 160 },        // lace
  { tech: 'mindUpload', ramp: 450 },     // dark worlds, a few beacons
];
export const LIGHT_AGE_NAMES = ['sodium', 'LED grid', 'arcology', 'lace', 'beacons'];

/** 0..4: which age of night light this year belongs to, fractional while one gives way to the next. */
export function lightEpoch(snap: StateMsg | null, year: number): number {
  let e = 0, start = -Infinity;
  for (const a of LIGHT_AGES) {
    const t = techYear(snap, a.tech);
    if (t < 0 || t > year) break;
    start = Math.max(t, start + 40);
    const p = Math.min(1, Math.max(0, (year - start) / a.ramp));
    e += p;
    if (p < 1) break;
  }
  return e;
}

const ERA_COLLAPSE = ERAS.indexOf('Collapse'), ERA_WAR = ERAS.indexOf('War');

/** 0..1 share of a world's lights that go out: collapse, war, unrest, shortage. */
export function blackout(snap: StateMsg | null, b: number): number {
  if (!snap) return 0;
  const S = snap.S, o = b * NF;
  const era = snap.globals.eraIndex;
  const stab = S[o + F.stability], short = S[o + F.shortage];
  let d = Math.max(0, 0.5 - stab) * 1.3 + Math.min(1, Math.max(0, short)) * 0.8;
  if (era === ERA_COLLAPSE) d += 0.45;
  if (era === ERA_WAR) d += 0.12;
  return Math.min(0.85, d);
}

/** 0..1 terraforming progress, read straight from the engine. */
export function terraform(snap: StateMsg | null, b: number): number {
  return snap ? Math.min(1, Math.max(0, snap.S[b * NF + F.terraform])) : 0;
}

const SKY_BLUE = new THREE.Color(0x5aa0ff);

/** Set a planet material's age uniforms (and its atmosphere shell, if it has one) for body b now. */
export function applyPlanetLook(mesh: THREE.Mesh, snap: StateMsg | null, b: number, year: number, lights: number): void {
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  const tf = terraform(snap, b);
  let epoch = lightEpoch(snap, year);
  if (isStage(snap ? snap.S[b * NF + F.stage] : -1, 'Uploaded')) epoch = 4;
  u.uLights.value = lights;
  u.uTerra.value = tf;
  u.uEpoch.value = epoch;
  u.uDim.value = blackout(snap, b);
  u.uFlicker.value = REDUCED_MOTION ? 0 : 1;
  // the halo thickens and turns blue as the air does
  for (const c of mesh.children) {
    const m = (c as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!m?.uniforms?.uColor || m.side !== THREE.BackSide) continue;
    const base = (c.userData.baseColor ??= (m.uniforms.uColor.value as THREE.Color).clone()) as THREE.Color;
    (m.uniforms.uColor.value as THREE.Color).copy(base).lerp(SKY_BLUE, Math.min(1, tf * 2.2)).multiplyScalar(1 + tf * 0.6);
  }
}
