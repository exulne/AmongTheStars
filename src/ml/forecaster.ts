// The psychohistory engine: the trained transformer reads the last 640 years
// of this future and samples possible continuations. It has only seen other
// futures from the same simulator, never this one's dice.

import { FEATURES, GRID, NERA, NF_ML, toTokens } from './features.ts';
import { Transformer, type Config, type Params } from './transformer.ts';
import { Rng } from '../sim/rng.ts';

interface Weights {
  cfg: Config;
  norms: { fmean: number[]; fstd: number[]; dmean: number[]; dstd: number[] };
  val: { nll: number; ce: number };
  trainedAt: string;
  params: Record<string, string>;
}

export interface Forecast {
  fromYear: number;
  years: number[];                      // forecast years (decades after fromYear)
  samples: Float32Array[];              // per sample: [steps × NF_ML] raw feature values
  eraProb: Float32Array;                // [steps × NERA] fraction of samples in each era
  eraPaths: Uint8Array[];               // per sample: era at each step
  meta: { valNll: number; trainedAt: string; params: number };
}

let model: Transformer | null = null;
let W: Weights | null = null;

async function load(): Promise<Transformer> {
  if (model) return model;
  W = (await import('./weights.ts')).default as Weights;
  const p: Params = {};
  for (const [k, b64] of Object.entries(W.params)) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    p[k] = new Float32Array(u8.buffer);
  }
  model = new Transformer(W.cfg, p);
  return model;
}

export async function forecast(years: ArrayLike<number>, series: Float64Array, year: number, opts: { steps?: number; samples?: number; seed?: number } = {}): Promise<Forecast> {
  const m = await load();
  const N = W!.norms, c = m.c;
  const steps = opts.steps ?? 40, nS = opts.samples ?? 12;
  const cur = Math.floor(year / GRID);
  const { x, era } = toTokens(years, series, cur);
  const runner = m.runner();
  const tok = (feat: ArrayLike<number>, e: number, t: number) => {
    const v = new Float32Array(c.fin);
    for (let f = 0; f < NF_ML; f++) v[f] = (feat[f] - N.fmean[f]) / N.fstd[f];
    v[NF_ML + e] = 1;
    v[NF_ML + NERA] = t / 1000;
    return v;
  };
  let out: Float32Array = new Float32Array(0);
  for (let t = Math.max(0, cur - c.ctx + 1); t <= cur; t++) out = runner.push(tok(x.subarray(t * NF_ML, (t + 1) * NF_ML), era[t], t), t);

  const rng = new Rng(opts.seed ?? cur * 7919 + 1);
  const samples: Float32Array[] = [];
  const eraPaths: Uint8Array[] = [];
  const eraProb = new Float32Array(steps * NERA);
  const lastT = Math.min(1000, cur + steps);
  for (let s = 0; s < nS; s++) {
    const r = runner.clone();
    const traj = new Float32Array(steps * NF_ML);
    const path = new Uint8Array(steps);
    let feat: Float32Array = Float32Array.from(x.subarray(cur * NF_ML, (cur + 1) * NF_ML));
    let o: Float32Array = out;
    for (let k = 0; k < steps && cur + k < lastT; k++) {
      const nextF = new Float32Array(NF_ML);
      for (let f = 0; f < NF_ML; f++) {
        const lv = Math.max(-7, Math.min(5, o[NF_ML + f]));
        const d = o[f] + Math.exp(lv / 2) * rng.gauss();
        nextF[f] = feat[f] + d * N.dstd[f] + N.dmean[f];
      }
      // eras: sample from the softmax
      let mx = -Infinity;
      for (let e = 0; e < NERA; e++) mx = Math.max(mx, o[2 * NF_ML + e]);
      let z = 0;
      const pr = new Float32Array(NERA);
      for (let e = 0; e < NERA; e++) { pr[e] = Math.exp(o[2 * NF_ML + e] - mx); z += pr[e]; }
      let u = rng.next() * z, nextEra = 0;
      for (let e = 0; e < NERA; e++) { u -= pr[e]; if (u <= 0) { nextEra = e; break; } }
      eraProb[k * NERA + nextEra] += 1 / nS;
      path[k] = nextEra;
      traj.set(nextF, k * NF_ML);
      feat = nextF;
      if (k + 1 < steps) o = r.push(tok(nextF, nextEra, cur + k + 1), cur + k + 1);
    }
    samples.push(traj);
    eraPaths.push(path);
  }
  const nParams = Object.values(m.p).reduce((a, b) => a + b.length, 0);
  return {
    fromYear: cur * GRID, years: Array.from({ length: steps }, (_, k) => (cur + k + 1) * GRID), samples, eraProb, eraPaths,
    meta: { valNll: W!.val.nll, trainedAt: W!.trainedAt, params: nParams },
  };
}

/** Feature value back to the metric's own units. */
export function featureToMetric(name: string, v: number): number {
  if (['kardashev', 'techs', 'stability', 'happiness', 'divergence'].includes(name)) return v;
  if (name === 'shortage') return v * 100;
  return Math.pow(10, v) - 1;
}
export const FORECAST_KEYS = FEATURES.map(([n]) => n);
