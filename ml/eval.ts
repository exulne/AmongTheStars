// Score the forecaster on held-out futures (seeds 1-40, never trained on).
// node ml/eval.ts [data=ml/data/futures.bin]
// Reports error vs a "nothing changes" baseline and calibration of the 80% band.

import { readFileSync } from 'node:fs';
import { FEATURES, GRID, NF_ML } from '../src/ml/features.ts';
import { forecast } from '../src/ml/forecaster.ts';
import { GM, NGM } from '../src/sim/metrics.ts';
import { Rng } from '../src/sim/rng.ts';

const path = process.argv[2] ?? 'ml/data/futures.bin';
const buf = readFileSync(path);
const [, T, F] = new Int32Array(buf.buffer, buf.byteOffset, 3);
const runAt = (r: number) => new Float32Array(buf.buffer.slice(buf.byteOffset + 12 + r * (T * F * 4 + T), buf.byteOffset + 12 + r * (T * F * 4 + T) + T * F * 4));
const eraAt = (r: number) => new Uint8Array(buf.buffer, buf.byteOffset + 12 + r * (T * F * 4 + T) + T * F * 4, T);

// The forecaster consumes raw metric series; rebuild a fake one on the decade grid whose
// features round-trip exactly (features are monotone transforms of single metrics).
const inv: Record<string, (v: number) => number> = {};
for (const [name] of FEATURES) inv[name] = ['kardashev', 'techs', 'stability', 'happiness', 'divergence'].includes(name) ? (v) => v : name === 'shortage' ? (v) => v * 100 : (v) => 10 ** v - 1;

const HORIZONS = [5, 10, 20, 40];
const keys = ['pop', 'energy', 'systems', 'techs', 'stability', 'reach'];
const err: Record<string, Record<number, { model: number[]; base: number[]; inBand: number[] }>> = {};
for (const k of keys) { err[k] = {}; for (const h of HORIZONS) err[k][h] = { model: [], base: [], inBand: [] }; }
let eraHit = 0, eraBase = 0, eraN = 0;

const rng = new Rng(11);
const t0 = performance.now();
for (let r = 0; r < 40; r++) {
  const x = runAt(r), era = eraAt(r);
  const years = Array.from({ length: T }, (_, t) => t * GRID);
  const series = new Float64Array(T * NGM);
  for (let t = 0; t < T; t++) {
    FEATURES.forEach(([name], f) => { series[t * NGM + GM[name]] = inv[name](x[t * F + f]); });
    series[t * NGM + GM.era] = era[t];
  }
  for (let rep = 0; rep < 4; rep++) {
    const cur = 20 + Math.floor(rng.next() * (T - 60));
    const fc = await forecast(years, series, cur * GRID, { steps: 40, samples: 16, seed: r * 100 + rep });
    for (const k of keys) {
      const f = FEATURES.findIndex(([n]) => n === k);
      for (const h of HORIZONS) {
        const truth = x[(cur + h) * F + f], now = x[cur * F + f];
        const vals = fc.samples.map((s) => s[(h - 1) * NF_ML + f]).sort((a, b) => a - b);
        const med = vals[vals.length >> 1];
        const lo = vals[Math.floor(vals.length * 0.1)], hi = vals[Math.ceil(vals.length * 0.9) - 1];
        err[k][h].model.push(Math.abs(med - truth));
        err[k][h].base.push(Math.abs(now - truth));
        err[k][h].inBand.push(truth >= lo && truth <= hi ? 1 : 0);
      }
    }
    // next-decade era: model's most likely vs "same era continues"
    const p = Array.from({ length: 8 }, (_, e) => fc.eraProb[e]);
    eraHit += p.indexOf(Math.max(...p)) === era[cur + 1] ? 1 : 0;
    eraBase += era[cur] === era[cur + 1] ? 1 : 0;
    eraN++;
  }
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`held-out futures: 40 × 4 starting points, 16 samples each, ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
console.log('metric      horizon  model err  baseline err  improvement  truth inside 80% band');
for (const k of keys) for (const h of HORIZONS) {
  const e = err[k][h], m = mean(e.model), b = mean(e.base);
  console.log(`${k.padEnd(11)} ${String(h * GRID).padStart(5)}y  ${m.toFixed(3).padStart(9)}  ${b.toFixed(3).padStart(12)}  ${(((b - m) / b) * 100).toFixed(0).padStart(10)}%  ${(mean(e.inBand) * 100).toFixed(0).padStart(10)}%`);
}
console.log(`\nnext-decade era: model ${(100 * eraHit / eraN).toFixed(0)}% correct, "same era continues" ${(100 * eraBase / eraN).toFixed(0)}%`);
console.log('(errors are in feature units: log10 for counts and amounts, raw for kardashev/techs/stability)');
