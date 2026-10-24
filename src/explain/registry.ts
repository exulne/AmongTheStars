// Every visible thing can say what it is. Views register their point sets,
// sprites and lines here under a short kind name; picking turns a cursor into
// (kind, index), and `explain(kind, index)` turns that into a card of facts.

import * as THREE from 'three';
import type { Seg } from '../sim/chronicle.ts';
import type { StateMsg } from '../sim/client.ts';
import type { World } from '../sim/world.ts';

/** R: real data. E: estimate from real data. P: procedural (drawn by this future's generator). */
export type Tag = 'R' | 'E' | 'P';
export interface Fact { k: string; v: string; t: Tag }
export type ExAct = 'system' | 'body' | 'dive-system' | 'dive-body' | 'year' | 'enter' | 'bio';
export interface ExLink { label: string; act: ExAct; id: number }
export interface Explanation {
  eyebrow: string;      // what kind of thing, e.g. "Star in the Perseus Arm"
  title: string;        // its name
  lede: string;         // one plain sentence: what it is
  facts: Fact[];
  why?: string;         // one sentence: why it matters to the people of this future
  links?: ExLink[];
  story?: Seg[];        // a Chronicle entry, with links to the people in it
  pending?: boolean;    // more is on its way from the simulation
}
export interface ExCtx { world: World; snap: StateMsg | null; year: number }

/** A pick that is really something the sim already models: select that instead. */
export interface SelectAs { kind: 'system' | 'body' | 'galaxy' | 'humanspace'; id: number; name: string }

export interface ExEntry {
  /** only pickable, and only locatable, while this is in the scene and visible */
  obj: THREE.Object3D;
  explain(i: number, c: ExCtx): Explanation;
  /** hover text; defaults to the explanation's title */
  name?(i: number, c: ExCtx): string;
  /** world-space position, for the selection ring */
  locate?(i: number, out: THREE.Vector3): THREE.Vector3 | null;
  /** clicking resolves to a sim thing (a settled star, a world) */
  selectAs?(i: number, c: ExCtx): SelectAs | null;
  /** turn a raw pick index (a slot in a buffer) into the stable id explain/locate use */
  idOf?(i: number): number;
}

const reg = new Map<string, ExEntry>();

/** Register (or replace, when a view rebuilds) the explainer for one kind. Kinds are [a-z0-9]+ so they fit in the URL. */
export function registerExplainer(kind: string, e: ExEntry): void { reg.set(kind, e); }
export function explainerFor(kind: string): ExEntry | undefined { return reg.get(kind); }

/** In the scene graph and visible all the way up. */
export function shown(o: THREE.Object3D): boolean {
  let x: THREE.Object3D | null = o;
  while (x) {
    if (!x.visible) return false;
    if ((x as THREE.Scene).isScene) return true;
    x = x.parent;
  }
  return false;
}

export function explain(kind: string, i: number, c: ExCtx): Explanation | null {
  const e = reg.get(kind);
  if (!e) return null;
  try { return e.explain(i, c); } catch { return null; }
}

export function explainName(kind: string, i: number, c: ExCtx): string {
  const e = reg.get(kind);
  if (!e) return '';
  return e.name ? e.name(i, c) : e.explain(i, c).title;
}

const tmp = new THREE.Vector3();
export function explainLocate(kind: string, i: number): THREE.Vector3 | null {
  const e = reg.get(kind);
  if (!e?.locate || !shown(e.obj)) return null;
  const p = e.locate(i, tmp);
  return p ? p.clone() : null;
}

/** Position of point i of a Points cloud, in world space. */
export function pointWorld(p: THREE.Points, i: number, out: THREE.Vector3): THREE.Vector3 {
  const a = p.geometry.attributes.position.array as Float32Array;
  return out.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(p.matrixWorld);
}

// ---------------------------------------------------------------- deterministic helpers shared by explainers

/** A stable hash in [0,1) from integers; independent of the sim seed so the sky is the same in every future. */
export function h01(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}
/** Standard normal from two hashes. */
export function hGauss(...xs: number[]): number {
  const u = Math.max(1e-9, h01(...xs, 101)), v = h01(...xs, 202);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Poisson draw by inversion from a hash. */
export function hPoisson(mean: number, ...xs: number[]): number {
  const u = h01(...xs, 303);
  let k = 0, p = Math.exp(-mean), s = p;
  while (u > s && k < 40) { k++; p *= mean / k; s += p; }
  return k;
}
export function pick<T>(xs: readonly T[], u: number): T { return xs[Math.min(xs.length - 1, Math.floor(u * xs.length))]; }

const SYL_A = ['ka', 'lo', 've', 'mi', 'ra', 'sel', 'tor', 'an', 'is', 'cor', 'mae', 'dun', 'el', 'fa', 'gar', 'hel', 'ior', 'ju', 'ny', 'os', 'pel', 'qua', 'ru', 'sa', 'tiv', 'ul', 'var', 'wen', 'xa', 'yr', 'zel'];
const SYL_B = ['n', 'th', 'r', 's', 'l', 'x', 'ra', 'na', 'ris', 'don', 'mar', 'ven', 'lis', 'tor', 'via', 'ce', 'ne', 'lo'];
/** A short pronounceable coined name. */
export function coin(u1: number, u2: number, u3: number): string {
  const w = pick(SYL_A, u1) + (u3 < 0.5 ? pick(SYL_A, u2) : '') + pick(SYL_B, (u1 * 7.3 + u2 * 3.1) % 1);
  return w[0].toUpperCase() + w.slice(1);
}
