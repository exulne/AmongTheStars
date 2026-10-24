// Where this future sits among others. Once the run is done, a background
// worker plays N other futures (same rules, different dice) and every chart
// draws the middle 80% of them as a faint band behind this future's line.

import EnsembleWorker from '../sim/ensembleWorker.ts?worker&inline';
import type { FromEnsemble } from '../sim/ensembleWorker.ts';
import { GLOBAL_METRICS, GM } from '../sim/metrics.ts';

export const ENSEMBLE_SIZE = 24;

export class Ensemble {
  private w: Worker | null = null;
  private token = 0;
  private runs: Float64Array[] = [];
  private cache = new Map<string, { n: number; lo: Float64Array; hi: Float64Array; mid: Float64Array }>();
  onUpdate: () => void = () => {};
  get count(): number { return this.runs.length; }

  /** Play ENSEMBLE_SIZE other futures than `seed` (seeds chosen from it, so the same future always gets the same siblings). */
  start(seed: number): void {
    this.stop();
    this.w ??= new EnsembleWorker();
    const t = ++this.token;
    const seeds: number[] = [];
    for (let k = 1; seeds.length < ENSEMBLE_SIZE; k++) { const s = ((seed + k * 7919) % 99991) + 1; if (s !== seed) seeds.push(s); }
    this.w.onmessage = (ev: MessageEvent<FromEnsemble>) => {
      if (ev.data.token !== this.token) return;
      this.runs.push(ev.data.series);
      this.cache.clear();
      this.onUpdate();
    };
    this.w.postMessage({ type: 'run', seeds, token: t });
  }

  stop(): void {
    this.token++;
    this.runs = [];
    this.cache.clear();
    this.w?.postMessage({ type: 'run', seeds: [], token: this.token });
  }

  /** 10th, 50th and 90th percentile of a global metric at every step, across the other futures (needs at least 5). */
  band(key: string, nSteps: number): { lo: Float64Array; mid: Float64Array; hi: Float64Array } | null {
    const col = GM[key];
    if (col === undefined || this.runs.length < 5) return null;
    const hit = this.cache.get(key);
    if (hit && hit.n === this.runs.length) return hit;
    const NG = GLOBAL_METRICS.length, R = this.runs.length;
    const lo = new Float64Array(nSteps), mid = new Float64Array(nSteps), hi = new Float64Array(nSteps), col_ = new Float64Array(R);
    for (let i = 0; i < nSteps; i++) {
      for (let r = 0; r < R; r++) col_[r] = this.runs[r][i * NG + col];
      col_.sort();
      const q = (p: number) => { const x = p * (R - 1), a = Math.floor(x); return col_[a] + (col_[Math.min(R - 1, a + 1)] - col_[a]) * (x - a); };
      lo[i] = q(0.1); mid[i] = q(0.5); hi[i] = q(0.9);
    }
    const out = { n: R, lo, mid, hi };
    this.cache.set(key, out);
    return out;
  }

  /** Share of the other futures below this value at step i: "more people than 83% of futures". */
  rank(key: string, i: number, v: number): number | null {
    const col = GM[key];
    if (col === undefined || this.runs.length < 5) return null;
    const NG = GLOBAL_METRICS.length;
    let below = 0;
    for (const r of this.runs) if (r[i * NG + col] < v) below++;
    return below / this.runs.length;
  }
}
