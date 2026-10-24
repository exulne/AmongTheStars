// The trained generations of war minds, and which one a polity fights with in
// a given year: generation k from year k·10000/N on, so a future learns war as
// it goes. Only the sim worker imports this, so the weights stay out of the page's
// main bundle; the import is static so the single-file build inlines it.

import W from './warWeights.ts';
import { NPARAM, WarNet } from './warNet.ts';

const LAYER_SIZES = [128 * 32 + 128, 64 * 128 + 64, 64 + 1, 4 * 64 + 4, 64 * 86 + 64, 8 * 64 + 8];
const SPAN = 10000;

export interface WarGens { run: string; nets: WarNet[]; genAt(year: number): number }

let cached: Promise<WarGens | null> | null = null;

export function loadWarGens(): Promise<WarGens | null> {
  return (cached ??= Promise.resolve().then(() => {
    if (!W.gens) return null;
    const bin = atob(W.q), nets: WarNet[] = [];
    let k = 0, s = 0;
    for (let g = 0; g < W.gens; g++) {
      const p = new Float32Array(NPARAM);
      let o = 0;
      for (const n of LAYER_SIZES) {
        const sc = W.scales[s++];
        for (let i = 0; i < n; i++) { const b = bin.charCodeAt(k++); p[o++] = (b > 127 ? b - 256 : b) * sc; }
      }
      nets.push(new WarNet(p));
    }
    const per = SPAN / nets.length;
    return { run: W.run, nets, genAt: (year: number) => Math.min(nets.length - 1, Math.max(0, Math.floor(year / per))) };
  }));
}
