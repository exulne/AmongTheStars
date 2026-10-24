// What a settlement looks like at a moment in its history: the building
// style its technology allows, the palette its culture has drifted into, and
// the marks its fortunes have left (ruins, banners, monuments).

import * as THREE from 'three';
import { TECHS } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';

export type Arch = 'huts' | 'warrens' | 'towers' | 'spires' | 'light';

export const ARCH_NAME: Record<Arch, string> = {
  huts: 'buried regolith huts and inflatable domes', warrens: 'printed regolith warrens under glass domes',
  towers: 'fusion-lit towers and arcologies', spires: 'grown spires and skyways', light: 'light-farms under mirror canopies',
};

export interface Style {
  arch: Arch;
  quiet: boolean;         // minds uploaded: data-temples at the centre, emptier streets
  solar: boolean; glassDomes: boolean; arcology: boolean; skyways: boolean; mirrors: boolean; spinHabs: boolean;
  open: boolean;          // terraformed: parks, water, open-air streets
  height: number;         // multiplier on block heights
  grid: number;           // street every n cells
  twist: number;          // rotation of the street grid (culture)
  organic: number;        // 0..1 jitter of lots (grown cities)
  body: THREE.Color; roof: THREE.Color; glow: THREE.Color; cloth: THREE.Color;
  decay: number;          // share of ruined, dark blocks
  wealth: number;         // 0..1, lights and fill
  banners: boolean; monuments: number;
  figure: { tall: number; slim: number };
  sig: string;            // changes when anything visible changes
}

const has = (snap: StateMsg | null, id: string) => {
  const i = TECHS.findIndex((t) => t.id === id);
  return !!snap && i >= 0 && snap.techDone[i] >= 0;
};

/** Marks from the settlement's history, gathered by the app from events. */
export interface History { independence: boolean; speciation: boolean; collapse: boolean }

export function styleOf(world: World, snap: StateMsg | null, body: number, year: number, hist: History): Style {
  const b = world.bodies[body];
  const S = snap?.S, o = body * NF;
  const v = (f: keyof typeof F) => (S ? S[o + F[f]] : 0);
  const arch: Arch = has(snap, 'dyson1') ? 'light' : has(snap, 'nanofab') ? 'spires'
    : has(snap, 'fusion') ? 'towers' : has(snap, 'regolith') ? 'warrens' : 'huts';
  const pop = Math.max(1, v('pop'));
  const wealth = Math.min(1, Math.max(0, (Math.log10(1 + v('gdp') / pop) - 3.5) / 3));
  const terraform = v('terraform');

  // culture drifts with distance from Sol and with time; an independent faction picks its own way
  const sys = world.systems[b.system];
  const faction = v('faction');
  const century = Math.floor(year / 100);
  const drift = Math.min(1, sys.dist / 60 + year / 6000);
  const key = faction !== world.earth && faction !== body ? faction : b.system;
  const h0 = hash01(key, century >> 2, 17), h1 = hash01(key, 3), h2 = hash01(key, century >> 3, 5);
  const hue = (0.58 + (h0 - 0.5) * drift * 0.9 + 1) % 1;
  const body3 = new THREE.Color().setHSL(hue, 0.08 + 0.12 * drift, 0.13 + 0.04 * h1);
  const roof = new THREE.Color().setHSL((hue + 0.5 * h2) % 1, 0.3 + 0.3 * drift, 0.35);
  const glow = new THREE.Color().setHSL((0.09 + (h1 - 0.5) * drift * 0.25 + 1) % 1, 0.7, 0.62);
  const cloth = new THREE.Color().setHSL((hue + 0.33 + h2 * 0.3) % 1, 0.35 + 0.3 * drift, 0.6);

  const ruin = hist.collapse || v('stability') < 0.3;
  const adapted = has(snap, 'bioAdapt') || hist.speciation || v('divergence') > 0.5;
  const style: Style = {
    arch,
    quiet: has(snap, 'mindUpload'),
    solar: arch === 'huts' || arch === 'warrens',
    glassDomes: arch === 'warrens',
    arcology: arch === 'towers' || arch === 'spires',
    skyways: arch === 'spires',
    mirrors: arch === 'light',
    spinHabs: has(snap, 'bishopRings') || (has(snap, 'carbonNano') && v('stage') >= 6),
    open: terraform > 0.5,
    height: { huts: 0.2, warrens: 0.45, towers: 1, spires: 1.35, light: 1.2 }[arch] * (0.7 + 0.6 * wealth),
    grid: 3 + Math.floor(h1 * 3),
    twist: (h2 - 0.5) * drift * 0.9,
    organic: arch === 'spires' || arch === 'light' ? 0.35 : arch === 'huts' ? 0.25 : 0.05 * drift,
    body: body3, roof, glow, cloth,
    decay: ruin ? 0.35 : Math.max(0, 0.45 - v('stability')) * 0.4,
    wealth,
    banners: v('culture') > 0,
    monuments: (hist.independence ? 1 : 0) + (hist.speciation ? 1 : 0),
    figure: { tall: 1 + (1 - Math.min(1, b.g)) * 0.35 + (adapted ? 0.15 : 0), slim: adapted ? 0.75 : 1 },
    sig: '',
  };
  style.sig = [arch, style.quiet, style.spinHabs, style.open, Math.round(style.height * 4), style.grid, Math.round(style.twist * 20), body3.getHexString(), Math.round(style.decay * 10), style.banners, style.monuments, Math.round(wealth * 4)].join('|');
  return style;
}

/** One line on what is new since the last style, for the "what changed here" strip. */
export function changes(a: Style | null, b: Style): string {
  if (!a) return '';
  const out: string[] = [];
  if (a.arch !== b.arch) out.push(ARCH_NAME[b.arch]);
  if (!a.quiet && b.quiet) out.push('quiet data-temples; minds move into the machines');
  if (!a.open && b.open) out.push('the domes come down; open air, parks and water');
  if (!a.spinHabs && b.spinHabs) out.push('spin habitats overhead');
  if (a.decay < 0.2 && b.decay >= 0.2) out.push('blocks fall dark and empty');
  if (a.decay >= 0.2 && b.decay < 0.2) out.push('the ruins are rebuilt');
  if (b.monuments > a.monuments) out.push('a new monument in the plaza');
  if (!a.banners && b.banners) out.push('banners of a new faith');
  if (a.body.getHexString() !== b.body.getHexString() && a.arch === b.arch) out.push('the city takes on new colours');
  if (Math.round(b.height * 4) > Math.round(a.height * 4) && a.arch === b.arch) out.push('buildings grow taller');
  return out.join(' · ');
}
