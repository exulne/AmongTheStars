// Which wars touch a world at a year, and who it fights. Every war view (the
// star map and system layer in warLayer.ts, the fleets in battle.ts, the
// planet and the street) reads the same answer from the state message, so the
// fighting agrees at every zoom level. Nothing here changes the simulation.

import * as THREE from 'three';
import { OUTCOME } from '../sim/civ.ts';
import type { Annals } from '../sim/chronicle.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import type { WarVis } from '../sim/worker.ts';
import type { World } from '../sim/world.ts';
import { factionColor } from './colorModes.ts';

let annals: Annals | null = null;
/** The Chronicle's names for wars and polities, once the run is done (set by the app). */
export function setWarAnnals(a: Annals | null): void { annals = a; }
export function warAnnals(): Annals | null { return annals; }

export const warName = (w: WarVis) => annals?.wars[w.id]?.name ?? (w.kinetic ? 'Kinetic strike' : 'War');
/** A side's name: its polity from the Chronicle, else its capital (or, for a strike, its star). */
export function sideName(w: WarVis, side: 'a' | 'b', world: World): string {
  const A = annals?.wars[w.id];
  const pol = A ? annals!.polities[side === 'a' ? A.polityA : A.polityB] : undefined;
  if (pol) return pol.name;
  if (w.kinetic) return world.systems[side === 'a' ? w.from : w.sys].name;
  return world.bodies[w[side]]?.name ?? '?';
}

/** Under way at this year: not yet due to end, or due but not yet settled by the sim. */
export const warActive = (w: WarVis, year: number) => year >= w.start && (year < w.end || (!w.kinetic && w.outcome === OUTCOME.ONGOING));

/** Where faction f fights from in system `sys`: its most populous world there, else its capital if that is there. */
export function sideWorld(f: number, world: World, snap: StateMsg, sys: number): number {
  let best = -1, top = -1;
  for (const b of world.systems[sys].bodies) {
    if (snap.S[b * NF + F.faction] !== f) continue;
    const p = snap.S[b * NF + F.pop];
    if (p > top) { top = p; best = b; }
  }
  return best >= 0 ? best : world.bodies[f]?.system === sys ? f : -1;
}
/** The attacker's world and the defender's world of a local war (-1 if none is in the theatre). */
export function frontOf(w: WarVis, world: World, snap: StateMsg): number { return sideWorld(w.a, world, snap, w.sys); }
export function targetOf(w: WarVis, world: World, snap: StateMsg): number {
  const t = sideWorld(w.b, world, snap, w.sys);
  // annexed: the loser's worlds here now fly the winner's flag, so fall back to the loser's capital
  return t >= 0 ? t : world.bodies[w.b]?.system === w.sys ? w.b : -1;
}

/** One war as one world lives it. */
export interface BodyWar {
  war: WarVis;
  name: string;
  /** this world's faction, and the enemy's */
  us: number; them: number;
  usName: string; themName: string;
  usColor: THREE.Color; themColor: THREE.Color;
  /** this world's side started it */
  attacking: boolean;
  /** this world is the main world of its side here (the front or the target), not one sending forces in */
  main: boolean;
  /** the enemy's main world in the theatre (-1 for a kinetic strike from another star) */
  enemyWorld: number;
  /** 0..1, from the dead so far (1 is ten billion or more) */
  intensity: number;
  /** years since it began */
  age: number;
}

/**
 * The wars this world is in at `year`: local wars in its system that its faction fights,
 * and kinetic strikes in flight at it or launched from it. Biggest first.
 */
export function bodyWars(world: World, snap: StateMsg | null, body: number, year: number): BodyWar[] {
  if (!snap || body < 0) return [];
  const out: BodyWar[] = [];
  const sys = world.bodies[body].system, f = snap.S[body * NF + F.faction], earth = world.earth;
  for (const w of snap.wars ?? []) {
    if (!warActive(w, year)) continue;
    let us: number, them: number, attacking: boolean, main: boolean, enemyWorld: number;
    if (w.kinetic) {
      if (w.b === body) { us = f; them = snap.S[w.a * NF + F.faction]; attacking = false; }
      else if (w.a === body) { us = f; them = snap.S[w.b * NF + F.faction]; attacking = true; }
      else continue;
      main = true; enemyWorld = -1;
    } else {
      if (w.sys !== sys || (f !== w.a && f !== w.b)) continue;
      attacking = f === w.a; us = f; them = attacking ? w.b : w.a;
      const fr = frontOf(w, world, snap), tg = targetOf(w, world, snap);
      main = body === (attacking ? fr : tg);
      enemyWorld = attacking ? tg : fr;
    }
    out.push({
      war: w, name: warName(w), us, them,
      usName: sideName(w, attacking ? 'a' : 'b', world), themName: sideName(w, attacking ? 'b' : 'a', world),
      usColor: factionColor(us, earth, new THREE.Color()), themColor: factionColor(them, earth, new THREE.Color()),
      attacking, main, enemyWorld,
      intensity: Math.min(1, Math.log10(1 + w.killed) / 10), age: year - w.start,
    });
  }
  return out.sort((a, b) => b.war.killed - a.war.killed);
}

/** A small deterministic hash in [0, 1), so a war looks the same every time it is watched. */
export function whash(...k: number[]): number {
  let h = 2166136261 >>> 0;
  for (const x of k) { h ^= Math.floor(x * 1000003) >>> 0; h = Math.imul(h, 16777619) >>> 0; h ^= h >>> 13; }
  return (h >>> 0) / 4294967296;
}
