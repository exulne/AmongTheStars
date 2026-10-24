// Ways to colour settled stars: by stage, allegiance, faith, head-count or age.

import * as THREE from 'three';
import { STAGE_NAMES } from '../sim/catalog.ts';
import { hash01 } from '../sim/rng.ts';
import { STAGE_CSS } from './textures.ts';

export type ColorMode = 'stage' | 'faction' | 'faith' | 'heat' | 'founded';
export const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'stage', label: 'stage' }, { id: 'faction', label: 'allegiance' }, { id: 'faith', label: 'faith' }, { id: 'heat', label: 'people' }, { id: 'founded', label: 'founded' },
];

// sequential ramps, dark-to-light so brightness still reads as "more" under bloom
const HEAT = ['#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'];
const AGE = ['#6f9bd8', '#4fb0c6', '#5ec98a', '#c9d86a', '#ffd58a'];
export const HEAT_CSS = `linear-gradient(90deg, ${HEAT.join(', ')})`;
export const AGE_CSS = `linear-gradient(90deg, ${AGE.join(', ')})`;
const heatC = HEAT.map((c) => new THREE.Color(c));
const ageC = AGE.map((c) => new THREE.Color(c));

function ramp(stops: THREE.Color[], t: number, out: THREE.Color): THREE.Color {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return out.copy(stops[i]).lerp(stops[i + 1], x - i);
}

export const HEAT_MAX = 10.6; // log10 of the biggest head-count we expect in one system
export function heatColor(pop: number, out: THREE.Color): THREE.Color { return ramp(heatC, Math.log10(1 + pop) / HEAT_MAX, out); }
export function ageColor(founded: number, now: number, out: THREE.Color): THREE.Color { return ramp(ageC, founded / Math.max(1, now), out); }

const EARTH_HUE = 0x9fd8ff;
/** Distinct, stable hue per faction (faction id = body id of its capital). Golden-angle spacing on a hash. */
export function factionColor(f: number, earth: number, out: THREE.Color): THREE.Color {
  if (f === earth) return out.set(EARTH_HUE);
  const h = (hash01(f, 77) * 0.618034 * 7) % 1;
  return out.setHSL(h, 0.75, 0.6);
}
export function factionCss(f: number, earth: number): string { return '#' + factionColor(f, earth, new THREE.Color()).getHexString(); }

const OLD_FAITHS = 0xb9ae98;
/** Colour of a faith by culture value (0: Earth's old faiths, a muted parchment; others their own hue). */
export function faithColor(n: number, out: THREE.Color): THREE.Color {
  if (!(n > 0)) return out.set(OLD_FAITHS);
  const h = (0.12 + n * 0.618034) % 1;
  return out.setHSL(h, 0.7, 0.62);
}
export function faithCss(n: number): string { return '#' + faithColor(n, new THREE.Color()).getHexString(); }

export function stageLegend(): string {
  return STAGE_NAMES.map((n, i) => `<span><i style="background:${STAGE_CSS[i]}"></i>${n}</span>`).join('');
}
