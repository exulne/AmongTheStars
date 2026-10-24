// Turns a run's global series into a sequence of feature vectors on a fixed
// 10-year grid: the "tokens" the forecaster reads. Shared by the dataset
// builder (Node) and the browser.

import { GM, NGM } from '../sim/metrics.ts';

export const GRID = 10;                 // years per token
export const TOKENS = 10000 / GRID + 1; // 1001
export const NERA = 8;

const l10 = (x: number) => Math.log10(Math.max(x, 0) + 1);

/** name, transform from a metrics row */
export const FEATURES: [string, (r: (k: string) => number) => number][] = [
  ['pop', (r) => l10(r('pop'))],
  ['offEarth', (r) => l10(r('offEarth'))],
  ['interstellarPop', (r) => l10(r('interstellarPop'))],
  ['settlements', (r) => l10(r('settlements'))],
  ['systems', (r) => l10(r('systems'))],
  ['reach', (r) => l10(r('reach'))],
  ['kardashev', (r) => r('kardashev')],
  ['gdp', (r) => l10(r('gdp'))],
  ['research', (r) => l10(r('research'))],
  ['techs', (r) => r('techs')],
  ['stability', (r) => r('stability')],
  ['happiness', (r) => r('happiness')],
  ['factions', (r) => l10(r('factions'))],
  ['wars', (r) => l10(r('wars'))],
  ['shipsInTransit', (r) => l10(r('shipsInTransit'))],
  ['shortage', (r) => r('shortage') / 100],
  ['divergence', (r) => r('divergence')],
];
export const NF_ML = FEATURES.length;

/** Resample a run onto the decade grid. Returns features [T×F] and eras [T]. */
export function toTokens(years: ArrayLike<number>, series: Float64Array, upto = TOKENS - 1): { x: Float32Array; era: Uint8Array; n: number } {
  const n = Math.min(TOKENS, upto + 1);
  const x = new Float32Array(n * NF_ML), era = new Uint8Array(n);
  let s = 0;
  for (let t = 0; t < n; t++) {
    const y = t * GRID;
    while (s + 1 < years.length && years[s + 1] <= y) s++;
    const row = (k: string) => series[s * NGM + GM[k]];
    for (let f = 0; f < NF_ML; f++) x[t * NF_ML + f] = FEATURES[f][1](row);
    era[t] = row('era');
  }
  return { x, era, n };
}
