// How a ship looks depends on the best drive known when it left: chemical
// rockets, nuclear thermal, a fusion torch with a bright plume, a laser sail
// riding a beam from home, a Bussard ramjet with its glowing scoop, or a warp
// bubble. Generation ships crawl along slow amber trails.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import { techYear } from './timeLook.ts';

export type Drive = 'chemical' | 'ntp' | 'torch' | 'antimatter' | 'sail' | 'bussard' | 'warp';

export interface ShipStyle {
  drive: Drive;
  generation: boolean;   // a voyage of more than one lifetime: people are born and die aboard
  trail: THREE.Color;    // route colour
  head: THREE.Color;     // the ship itself
  headSize: number;      // multiplier on the view's usual head size
  plume: number;         // 0..1 brightness of the exhaust just behind the ship
  beam: boolean;         // a laser beam from home pushing the sail
  scoop: boolean;        // a wide faint glow ahead: the magnetic scoop
  speed: number;         // multiplier on how fast motes flow along the route (looks only)
}

const GENERATION = 25;   // years; matches the ledger's idea of a voyage that is a place of its own
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const LOOK: Record<Drive, Omit<ShipStyle, 'drive' | 'generation'>> = {
  chemical: { trail: C(0.75, 0.62, 0.5), head: C(1, 0.85, 0.7), headSize: 0.8, plume: 0.2, beam: false, scoop: false, speed: 0.8 },
  ntp: { trail: C(0.55, 0.8, 0.95), head: C(0.8, 0.95, 1), headSize: 0.9, plume: 0.35, beam: false, scoop: false, speed: 1 },
  torch: { trail: C(0.7, 0.75, 1), head: C(1, 0.97, 1), headSize: 1.25, plume: 1, beam: false, scoop: false, speed: 1.3 },
  antimatter: { trail: C(0.85, 0.7, 1), head: C(1, 0.95, 1), headSize: 1.35, plume: 1, beam: false, scoop: false, speed: 1.5 },
  sail: { trail: C(0.45, 1, 0.75), head: C(0.85, 1, 0.9), headSize: 1, plume: 0, beam: true, scoop: false, speed: 1.4 },
  bussard: { trail: C(0.55, 0.6, 1), head: C(0.75, 0.85, 1), headSize: 1.1, plume: 0.7, beam: false, scoop: true, speed: 1.6 },
  warp: { trail: C(0.8, 0.6, 1), head: C(0.9, 0.75, 1), headSize: 1.6, plume: 0, beam: false, scoop: false, speed: 2.4 },
};
export const AMBER = C(1, 0.62, 0.22);
export const BEAM = C(0.35, 1, 0.65);
export const SCOOP = C(0.5, 0.65, 1);

// drives from newest to oldest; a ship uses the best one known when it left
const ORDER: [Drive, string][] = [['bussard', 'bussard'], ['sail', 'laserSail'], ['antimatter', 'antimatter'], ['torch', 'fusionDrive'], ['ntp', 'ntp']];

const cache = new WeakMap<StateMsg, [Drive, number][]>();
function drives(snap: StateMsg): [Drive, number][] {
  let d = cache.get(snap);
  if (!d) { d = ORDER.map(([k, id]) => [k, techYear(snap, id)] as [Drive, number]).filter(([, y]) => y >= 0); cache.set(snap, d); }
  return d;
}

export function driveAt(snap: StateMsg | null, depart: number, ftl: boolean): Drive {
  if (ftl) return 'warp';
  if (!snap) return 'chemical';
  for (const [k, y] of drives(snap)) if (y <= depart) return k;
  return 'chemical';
}

const out: ShipStyle = { drive: 'chemical', generation: false, ...LOOK.chemical, trail: C(1, 1, 1), head: C(1, 1, 1) };
/** Style of one ship. Returns a shared object: copy what you keep. */
export function shipStyle(snap: StateMsg | null, sh: { depart: number; arrive: number; kind: number }): ShipStyle {
  const drive = driveAt(snap, sh.depart, sh.kind === 1);
  const L = LOOK[drive];
  out.drive = drive;
  out.generation = sh.kind !== 1 && sh.arrive - sh.depart > GENERATION;
  out.trail.copy(out.generation ? AMBER : L.trail);
  out.head.copy(L.head);
  out.headSize = L.headSize * (out.generation ? 1.2 : 1);
  out.plume = L.plume; out.beam = L.beam; out.scoop = L.scoop;
  out.speed = out.generation ? 0.35 : L.speed;
  return out;
}

export const DRIVE_NAMES: Record<Drive, string> = {
  chemical: 'chemical rocket', ntp: 'nuclear thermal', torch: 'fusion torch', antimatter: 'antimatter torch',
  sail: 'laser sail', bussard: 'Bussard ramjet', warp: 'warp bubble',
};
