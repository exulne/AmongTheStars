// Train the psychohistory forecaster on simulated futures.
// node ml/train.ts [data=ml/data/futures.bin] [steps=2500]   (node ml/train.ts --gradcheck to verify backprop)
//
// Each token is one decade of one future: standardized features, era one-hot,
// and absolute time. The model predicts the next decade: a Gaussian over the
// change in every feature (mean and log-variance) and a distribution over eras.

import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { NERA } from '../src/ml/features.ts';
import { Transformer, initParams, paramShapes, type Config, type Params } from '../src/ml/transformer.ts';
import { Rng } from '../src/sim/rng.ts';

const VAL_RUNS = 40;

interface Data { count: number; T: number; F: number; x: Float32Array; era: Uint8Array }

function load(path: string): Data {
  const buf = readFileSync(path);
  const [count, T, F] = new Int32Array(buf.buffer, buf.byteOffset, 3);
  const x = new Float32Array(count * T * F), era = new Uint8Array(count * T);
  let o = buf.byteOffset + 12;
  for (let r = 0; r < count; r++) {
    x.set(new Float32Array(buf.buffer.slice(o, o + T * F * 4)), r * T * F); o += T * F * 4;
    era.set(new Uint8Array(buf.buffer, o, T), r * T); o += T;
  }
  return { count, T, F, x, era };
}

export interface Norms { fmean: number[]; fstd: number[]; dmean: number[]; dstd: number[] }

function norms(D: Data): Norms {
  const { T, F } = D;
  const fm = new Float64Array(F), fs = new Float64Array(F), dm = new Float64Array(F), ds = new Float64Array(F);
  let n = 0;
  for (let r = VAL_RUNS; r < D.count; r++) for (let t = 0; t < T - 1; t++) {
    n++;
    for (let f = 0; f < F; f++) {
      const a = D.x[(r * T + t) * F + f], b = D.x[(r * T + t + 1) * F + f];
      fm[f] += a; fs[f] += a * a; dm[f] += b - a; ds[f] += (b - a) ** 2;
    }
  }
  const out: Norms = { fmean: [], fstd: [], dmean: [], dstd: [] };
  for (let f = 0; f < F; f++) {
    const m = fm[f] / n, dmu = dm[f] / n;
    out.fmean.push(m); out.fstd.push(Math.sqrt(Math.max(fs[f] / n - m * m, 1e-8)) || 1);
    out.dmean.push(dmu); out.dstd.push(Math.sqrt(Math.max(ds[f] / n - dmu * dmu, 1e-10)) || 1);
  }
  return out;
}

/** inputs [ctx × fin] and targets for one window */
function window(D: Data, N: Norms, run: number, s: number, ctx: number) {
  const { T, F } = D, fin = F + NERA + 1;
  const inp = new Float32Array(ctx * fin), tgt = new Float32Array(ctx * F), tEra = new Uint8Array(ctx);
  for (let i = 0; i < ctx; i++) {
    const t = s + i, o = (run * T + t) * F;
    for (let f = 0; f < F; f++) {
      inp[i * fin + f] = (D.x[o + f] - N.fmean[f]) / N.fstd[f];
      tgt[i * F + f] = (D.x[o + F + f] - D.x[o + f] - N.dmean[f]) / N.dstd[f];
    }
    inp[i * fin + F + D.era[run * T + t]] = 1;
    inp[i * fin + F + NERA] = t / 1000;
    tEra[i] = D.era[run * T + t + 1];
  }
  return { inp, tgt, tEra };
}

/** Loss and dOut for a window. */
function lossGrad(out: Float32Array, tgt: Float32Array, tEra: Uint8Array, ctx: number, F: number, fout: number, scale: number) {
  const dOut = new Float32Array(out.length);
  let nll = 0, ce = 0;
  for (let i = 0; i < ctx; i++) {
    const o = i * fout;
    for (let f = 0; f < F; f++) {
      const mu = out[o + f], raw = out[o + F + f], lv = Math.max(-7, Math.min(5, raw));
      const e = Math.exp(-lv), r = tgt[i * F + f] - mu;
      nll += 0.5 * (lv + r * r * e);
      dOut[o + f] = -r * e * scale;
      dOut[o + F + f] = raw === lv ? 0.5 * (1 - r * r * e) * scale : 0;
    }
    let mx = -Infinity;
    for (let k = 0; k < NERA; k++) mx = Math.max(mx, out[o + 2 * F + k]);
    let z = 0;
    for (let k = 0; k < NERA; k++) z += Math.exp(out[o + 2 * F + k] - mx);
    for (let k = 0; k < NERA; k++) {
      const pk = Math.exp(out[o + 2 * F + k] - mx) / z;
      dOut[o + 2 * F + k] = (pk - (k === tEra[i] ? 1 : 0)) * scale * 0.5;
      if (k === tEra[i]) ce -= Math.log(Math.max(pk, 1e-9));
    }
  }
  return { nll: nll / (ctx * F), ce: ce / ctx, dOut };
}

const CONFIG = (F: number): Config => ({ fin: F + NERA + 1, fout: 2 * F + NERA, d: 64, heads: 4, layers: 3, ctx: 64, maxPos: 1001 });

// ---------------------------------------------------------------- worker: gradients for a slice of the batch

if (!isMainThread) {
  const { path, cfg, pBufs, gBufs, N } = workerData as { path: string; cfg: Config; pBufs: Record<string, SharedArrayBuffer>; gBufs: Record<string, SharedArrayBuffer>; N: Norms };
  const D = load(path);
  const p: Params = Object.fromEntries(Object.entries(pBufs).map(([k, b]) => [k, new Float32Array(b)]));
  const g: Params = Object.fromEntries(Object.entries(gBufs).map(([k, b]) => [k, new Float32Array(b)]));
  const model = new Transformer(cfg, p);
  parentPort!.on('message', (m: { windows: [number, number][]; scale: number; eval?: boolean }) => {
    if (!m.eval) for (const a of Object.values(g)) a.fill(0);
    let nll = 0, ce = 0;
    for (const [run, s] of m.windows) {
      const w = window(D, N, run, s, cfg.ctx);
      const { out, cache } = model.forward(w.inp, cfg.ctx, s, !m.eval);
      const L = lossGrad(out, w.tgt, w.tEra, cfg.ctx, D.F, cfg.fout, m.scale);
      nll += L.nll; ce += L.ce;
      if (!m.eval) model.backward(cache!, L.dOut, cfg.ctx, g);
    }
    parentPort!.postMessage({ nll, ce });
  });
} else {
  main();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--gradcheck') return gradcheck();
  const path = args[0] ?? 'ml/data/futures.bin';
  const steps = Number(args[1] ?? 2500);
  const D = load(path);
  const N = norms(D);
  const cfg = CONFIG(D.F);
  const shapes = paramShapes(cfg);
  const nParams = Object.values(shapes).reduce((a, b) => a + b, 0);
  console.log(`${D.count} futures (${VAL_RUNS} held out), ${nParams.toLocaleString()} parameters`);
  const rng = new Rng(7);
  const pBufs: Record<string, SharedArrayBuffer> = {};
  const p = initParams(cfg, () => rng.next(), (n) => new Float32Array(new SharedArrayBuffer(n * 4)));
  for (const [k, a] of Object.entries(p)) pBufs[k] = a.buffer as SharedArrayBuffer;
  const nW = Math.max(1, availableParallelism() - 2);
  const workers = Array.from({ length: nW }, () => {
    const gBufs = Object.fromEntries(Object.entries(shapes).map(([k, n]) => [k, new SharedArrayBuffer(n * 4)]));
    const w = new Worker(new URL(import.meta.url), { workerData: { path, cfg, pBufs, gBufs, N } });
    return { w, g: Object.fromEntries(Object.entries(gBufs).map(([k, b]) => [k, new Float32Array(b)])) as Params };
  });
  const call = (wk: (typeof workers)[number], msg: object) => new Promise<{ nll: number; ce: number }>((res) => { wk.w.once('message', res); wk.w.postMessage(msg); });

  const B = 48;
  const m1: Params = {}, m2: Params = {};
  for (const [k, n] of Object.entries(shapes)) { m1[k] = new Float32Array(n); m2[k] = new Float32Array(n); }
  const lrMax = 2e-3, warm = 100, wd = 0.01, b1 = 0.9, b2 = 0.98;
  const sample = (lo: number, hi: number): [number, number] => [lo + Math.floor(rng.next() * (hi - lo)), Math.floor(rng.next() * (D.T - cfg.ctx - 1))];
  const valWindows = Array.from({ length: 96 }, () => sample(0, VAL_RUNS));

  const evaluate = async () => {
    const per = Math.ceil(valWindows.length / nW);
    const rs = await Promise.all(workers.map((wk, i) => call(wk, { windows: valWindows.slice(i * per, (i + 1) * per), scale: 0, eval: true })));
    return { nll: rs.reduce((a, r) => a + r.nll, 0) / valWindows.length, ce: rs.reduce((a, r) => a + r.ce, 0) / valWindows.length };
  };
  const t0 = performance.now();
  let v = await evaluate();
  console.log(`step 0  val nll ${v.nll.toFixed(3)}  era ce ${v.ce.toFixed(3)}  (untrained)`);
  for (let step = 1; step <= steps; step++) {
    const windows = Array.from({ length: B }, () => sample(VAL_RUNS, D.count));
    const per = Math.ceil(B / nW);
    const rs = await Promise.all(workers.map((wk, i) => call(wk, { windows: windows.slice(i * per, (i + 1) * per), scale: 1 / (B * cfg.ctx) })));
    // sum worker grads, clip, AdamW
    let norm = 0;
    const g: Params = {};
    for (const [k, n] of Object.entries(shapes)) {
      const a = new Float32Array(n);
      for (const wk of workers) { const s = wk.g[k]; for (let i = 0; i < n; i++) a[i] += s[i]; }
      for (let i = 0; i < n; i++) norm += a[i] * a[i];
      g[k] = a;
    }
    norm = Math.sqrt(norm);
    const clip = norm > 1 ? 1 / norm : 1;
    const lr = step < warm ? (lrMax * step) / warm : 1e-4 + 0.5 * (lrMax - 1e-4) * (1 + Math.cos((Math.PI * (step - warm)) / (steps - warm)));
    const c1 = 1 - b1 ** step, c2 = 1 - b2 ** step;
    for (const k of Object.keys(shapes)) {
      const P = p[k], G = g[k], M = m1[k], V = m2[k];
      const decay = k.startsWith('W') ? wd : 0;
      for (let i = 0; i < P.length; i++) {
        const gi = G[i] * clip;
        M[i] = b1 * M[i] + (1 - b1) * gi;
        V[i] = b2 * V[i] + (1 - b2) * gi * gi;
        P[i] -= lr * ((M[i] / c1) / (Math.sqrt(V[i] / c2) + 1e-8) + decay * P[i]);
      }
    }
    if (step % 50 === 0) {
      const tr = rs.reduce((a, r) => a + r.nll, 0) / B, tc = rs.reduce((a, r) => a + r.ce, 0) / B;
      let line = `step ${step}  train nll ${tr.toFixed(3)} ce ${tc.toFixed(3)}  |g| ${norm.toFixed(2)}  lr ${lr.toExponential(1)}  ${((performance.now() - t0) / 1000).toFixed(0)}s`;
      if (step % 250 === 0 || step === steps) { v = await evaluate(); line += `  ·  val nll ${v.nll.toFixed(3)} ce ${v.ce.toFixed(3)}`; }
      console.log(line);
    }
  }
  for (const wk of workers) wk.w.terminate();
  exportWeights(cfg, N, p, v);
}

function exportWeights(cfg: Config, N: Norms, p: Params, v: { nll: number; ce: number }): void {
  const params = Object.fromEntries(Object.entries(p).map(([k, a]) => [k, Buffer.from(new Float32Array(a).buffer).toString('base64')]));
  const body = JSON.stringify({ cfg, norms: N, val: v, trainedAt: new Date().toISOString(), params });
  writeFileSync('src/ml/weights.ts', `// Generated by ml/train.ts. Do not edit.\nexport default ${body};\n`);
  console.log(`wrote src/ml/weights.ts (${(body.length / 1024).toFixed(0)} KB)`);
}

function gradcheck(): void {
  const cfg: Config = { fin: 5, fout: 2 * 2 + NERA, d: 8, heads: 2, layers: 2, ctx: 6, maxPos: 20 };
  const rng = new Rng(3);
  const p = initParams(cfg, () => rng.next());
  for (const a of Object.values(p)) for (let i = 0; i < a.length; i++) a[i] += (rng.next() - 0.5) * 0.3;
  const m = new Transformer(cfg, p);
  const inp = new Float32Array(cfg.ctx * cfg.fin).map(() => rng.next() - 0.5);
  const tgt = new Float32Array(cfg.ctx * 2).map(() => rng.next() - 0.5);
  const tEra = new Uint8Array(cfg.ctx).map(() => Math.floor(rng.next() * NERA));
  const loss = () => { const L = lossGrad(m.forward(inp, cfg.ctx, 3).out, tgt, tEra, cfg.ctx, 2, cfg.fout, 1); return L.nll * cfg.ctx * 2 + L.ce * cfg.ctx * 0.5; };
  const g = initParams(cfg, () => 0);
  for (const a of Object.values(g)) a.fill(0);
  const { out, cache } = m.forward(inp, cfg.ctx, 3, true);
  m.backward(cache!, lossGrad(out, tgt, tEra, cfg.ctx, 2, cfg.fout, 1).dOut, cfg.ctx, g);
  let worst = 0;
  for (const k of Object.keys(p)) {
    for (let t = 0; t < 3; t++) {
      const i = Math.floor(rng.next() * p[k].length), h = 1e-2, o = p[k][i];
      p[k][i] = o + h; const lp = loss(); p[k][i] = o - h; const lm = loss(); p[k][i] = o;
      const num = (lp - lm) / (2 * h), ana = g[k][i];
      const rel = Math.abs(num - ana) / Math.max(1e-3, Math.abs(num) + Math.abs(ana));
      worst = Math.max(worst, rel);
      if (rel > 0.05) console.log(`MISMATCH ${k}[${i}] numeric ${num.toFixed(5)} analytic ${ana.toFixed(5)}`);
    }
  }
  console.log(`gradcheck worst relative error ${worst.toExponential(2)}`);
}
