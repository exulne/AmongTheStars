// A small decoder-only transformer with hand-written backprop. No libraries:
// the same file trains in Node (ml/train.ts) and runs in the browser.
//
// token → Linear → + sinusoidal position → L × [x + Attn(LN(x)), x + MLP(LN(x))] → LN → Linear

export interface Config { fin: number; fout: number; d: number; heads: number; layers: number; ctx: number; maxPos: number }

export type Params = Record<string, Float32Array>;

export function paramShapes(c: Config): Record<string, number> {
  const s: Record<string, number> = { Win: c.fin * c.d, bin: c.d, lnfg: c.d, lnfb: c.d, Wout: c.d * c.fout, bout: c.fout };
  for (let l = 0; l < c.layers; l++) {
    Object.assign(s, {
      [`ln1g${l}`]: c.d, [`ln1b${l}`]: c.d, [`Wqkv${l}`]: c.d * 3 * c.d, [`bqkv${l}`]: 3 * c.d,
      [`Wo${l}`]: c.d * c.d, [`bo${l}`]: c.d, [`ln2g${l}`]: c.d, [`ln2b${l}`]: c.d,
      [`W1${l}`]: c.d * 4 * c.d, [`b1${l}`]: 4 * c.d, [`W2${l}`]: 4 * c.d * c.d, [`b2${l}`]: c.d,
    });
  }
  return s;
}

export function initParams(c: Config, rand: () => number, alloc: (n: number) => Float32Array = (n) => new Float32Array(n)): Params {
  const p: Params = {};
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  for (const [k, n] of Object.entries(paramShapes(c))) {
    const a = alloc(n);
    if (k.startsWith('ln') && k.includes('g')) a.fill(1);
    else if (k.startsWith('W')) {
      const std = k.startsWith('Wo') || k.startsWith('W2') ? 0.02 / Math.sqrt(2 * c.layers) : 0.02 * (k === 'Win' ? 4 : 1);
      for (let i = 0; i < n; i++) a[i] = gauss() * std;
    }
    p[k] = a;
  }
  return p;
}

export function posEnc(c: Config): Float32Array {
  const pe = new Float32Array(c.maxPos * c.d);
  for (let p = 0; p < c.maxPos; p++) for (let i = 0; i < c.d; i += 2) {
    const w = 1 / Math.pow(2000, i / c.d);
    pe[p * c.d + i] = Math.sin(p * w);
    if (i + 1 < c.d) pe[p * c.d + i + 1] = Math.cos(p * w);
  }
  return pe;
}

// ---------------------------------------------------------------- kernels

/** C[m×n] (+)= A[m×k] · B[k×n] */
export function mm(A: Float32Array, B: Float32Array, m: number, k: number, n: number, C = new Float32Array(m * n), acc = false): Float32Array {
  if (!acc) C.fill(0);
  for (let i = 0; i < m; i++) {
    const ci = i * n;
    for (let p = 0; p < k; p++) {
      const a = A[i * k + p];
      if (a === 0) continue;
      const bp = p * n;
      for (let j = 0; j < n; j++) C[ci + j] += a * B[bp + j];
    }
  }
  return C;
}
/** C[m×n] += Aᵀ · B, A[k×m], B[k×n] (weight gradients) */
function mmTA(A: Float32Array, B: Float32Array, k: number, m: number, n: number, C: Float32Array): void {
  for (let p = 0; p < k; p++) {
    const ap = p * m, bp = p * n;
    for (let i = 0; i < m; i++) {
      const a = A[ap + i];
      if (a === 0) continue;
      const ci = i * n;
      for (let j = 0; j < n; j++) C[ci + j] += a * B[bp + j];
    }
  }
}
/** C[m×n] = A · Bᵀ, A[m×k], B[n×k] (input gradients) */
function mmTB(A: Float32Array, B: Float32Array, m: number, k: number, n: number, C = new Float32Array(m * n)): Float32Array {
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    const ai = i * k, bj = j * k;
    for (let p = 0; p < k; p++) s += A[ai + p] * B[bj + p];
    C[i * n + j] = s;
  }
  return C;
}
function addBias(X: Float32Array, b: Float32Array, rows: number): void {
  const n = b.length;
  for (let i = 0; i < rows; i++) for (let j = 0; j < n; j++) X[i * n + j] += b[j];
}
function sumRows(dY: Float32Array, rows: number, db: Float32Array): void {
  const n = db.length;
  for (let i = 0; i < rows; i++) for (let j = 0; j < n; j++) db[j] += dY[i * n + j];
}

function layerNorm(X: Float32Array, g: Float32Array, b: Float32Array, T: number, d: number) {
  const Y = new Float32Array(T * d), xhat = new Float32Array(T * d), rstd = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    let mu = 0;
    for (let i = 0; i < d; i++) mu += X[t * d + i];
    mu /= d;
    let v = 0;
    for (let i = 0; i < d; i++) { const z = X[t * d + i] - mu; v += z * z; }
    const r = 1 / Math.sqrt(v / d + 1e-5);
    rstd[t] = r;
    for (let i = 0; i < d; i++) {
      const h = (X[t * d + i] - mu) * r;
      xhat[t * d + i] = h;
      Y[t * d + i] = h * g[i] + b[i];
    }
  }
  return { Y, xhat, rstd };
}
function layerNormBack(dY: Float32Array, xhat: Float32Array, rstd: Float32Array, g: Float32Array, dg: Float32Array, db: Float32Array, T: number, d: number): Float32Array {
  const dX = new Float32Array(T * d);
  for (let t = 0; t < T; t++) {
    let m1 = 0, m2 = 0;
    for (let i = 0; i < d; i++) {
      const dy = dY[t * d + i], h = xhat[t * d + i];
      dg[i] += dy * h; db[i] += dy;
      const dh = dy * g[i];
      m1 += dh; m2 += dh * h;
    }
    m1 /= d; m2 /= d;
    for (let i = 0; i < d; i++) {
      const dh = dY[t * d + i] * g[i];
      dX[t * d + i] = rstd[t] * (dh - m1 - xhat[t * d + i] * m2);
    }
  }
  return dX;
}

const GC = Math.sqrt(2 / Math.PI);
function gelu(x: number): number { return 0.5 * x * (1 + Math.tanh(GC * (x + 0.044715 * x * x * x))); }
function geluGrad(x: number): number {
  const t = Math.tanh(GC * (x + 0.044715 * x * x * x));
  return 0.5 * (1 + t) + 0.5 * x * (1 - t * t) * GC * (1 + 3 * 0.044715 * x * x);
}

// ---------------------------------------------------------------- model

interface LayerCache {
  xIn: Float32Array; ln1: ReturnType<typeof layerNorm>; qkv: Float32Array; P: Float32Array[]; O: Float32Array;
  xMid: Float32Array; ln2: ReturnType<typeof layerNorm>; h1: Float32Array; g: Float32Array;
}

export class Transformer {
  c: Config;
  p: Params;
  pe: Float32Array;
  constructor(c: Config, p: Params) { this.c = c; this.p = p; this.pe = posEnc(c); }

  /** Full-sequence forward. inp [T×fin], positions are absolute token indices start..start+T-1. */
  forward(inp: Float32Array, T: number, start: number, keep = false): { out: Float32Array; cache?: { layers: LayerCache[]; lnf: ReturnType<typeof layerNorm>; xf: Float32Array; inp: Float32Array } } {
    const { d, heads, layers, fout, fin } = this.c, p = this.p, dh = d / heads, scale = 1 / Math.sqrt(dh);
    let x = mm(inp, p.Win, T, fin, d);
    addBias(x, p.bin, T);
    for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) x[t * d + i] += this.pe[(start + t) * d + i];
    const caches: LayerCache[] = [];
    for (let l = 0; l < layers; l++) {
      const xIn = x;
      const ln1 = layerNorm(x, p[`ln1g${l}`], p[`ln1b${l}`], T, d);
      const qkv = mm(ln1.Y, p[`Wqkv${l}`], T, d, 3 * d);
      addBias(qkv, p[`bqkv${l}`], T);
      const O = new Float32Array(T * d);
      const Ps: Float32Array[] = [];
      for (let h = 0; h < heads; h++) {
        const P = new Float32Array(T * T);
        for (let i = 0; i < T; i++) {
          let mx = -Infinity;
          for (let j = 0; j <= i; j++) {
            let s = 0;
            for (let e = 0; e < dh; e++) s += qkv[i * 3 * d + h * dh + e] * qkv[j * 3 * d + d + h * dh + e];
            s *= scale;
            P[i * T + j] = s;
            if (s > mx) mx = s;
          }
          let z = 0;
          for (let j = 0; j <= i; j++) { const e = Math.exp(P[i * T + j] - mx); P[i * T + j] = e; z += e; }
          for (let j = 0; j <= i; j++) P[i * T + j] /= z;
          for (let j = 0; j <= i; j++) {
            const w = P[i * T + j];
            for (let e = 0; e < dh; e++) O[i * d + h * dh + e] += w * qkv[j * 3 * d + 2 * d + h * dh + e];
          }
        }
        Ps.push(P);
      }
      const att = mm(O, p[`Wo${l}`], T, d, d);
      addBias(att, p[`bo${l}`], T);
      const xMid = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) xMid[i] = xIn[i] + att[i];
      const ln2 = layerNorm(xMid, p[`ln2g${l}`], p[`ln2b${l}`], T, d);
      const h1 = mm(ln2.Y, p[`W1${l}`], T, d, 4 * d);
      addBias(h1, p[`b1${l}`], T);
      const g = new Float32Array(T * 4 * d);
      for (let i = 0; i < g.length; i++) g[i] = gelu(h1[i]);
      const mlp = mm(g, p[`W2${l}`], T, 4 * d, d);
      addBias(mlp, p[`b2${l}`], T);
      x = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) x[i] = xMid[i] + mlp[i];
      if (keep) caches.push({ xIn, ln1, qkv, P: Ps, O, xMid, ln2, h1, g });
    }
    const lnf = layerNorm(x, p.lnfg, p.lnfb, T, d);
    const out = mm(lnf.Y, p.Wout, T, d, fout);
    addBias(out, p.bout, T);
    return { out, cache: keep ? { layers: caches, lnf, xf: x, inp } : undefined };
  }

  /** Backprop dOut [T×fout] into grads (accumulated). */
  backward(cache: NonNullable<ReturnType<Transformer['forward']>['cache']>, dOut: Float32Array, T: number, grads: Params): void {
    const { d, heads, layers, fout, fin } = this.c, p = this.p, dh = d / heads, scale = 1 / Math.sqrt(dh);
    mmTA(cache.lnf.Y, dOut, T, d, fout, grads.Wout);
    sumRows(dOut, T, grads.bout);
    let dx = layerNormBack(mmTB(dOut, p.Wout, T, fout, d), cache.lnf.xhat, cache.lnf.rstd, p.lnfg, grads.lnfg, grads.lnfb, T, d);
    for (let l = layers - 1; l >= 0; l--) {
      const c = cache.layers[l];
      // MLP branch
      mmTA(c.g, dx, T, 4 * d, d, grads[`W2${l}`]);
      sumRows(dx, T, grads[`b2${l}`]);
      const dg = mmTB(dx, p[`W2${l}`], T, d, 4 * d);
      for (let i = 0; i < dg.length; i++) dg[i] *= geluGrad(c.h1[i]);
      mmTA(c.ln2.Y, dg, T, d, 4 * d, grads[`W1${l}`]);
      sumRows(dg, T, grads[`b1${l}`]);
      const dln2 = layerNormBack(mmTB(dg, p[`W1${l}`], T, 4 * d, d), c.ln2.xhat, c.ln2.rstd, p[`ln2g${l}`], grads[`ln2g${l}`], grads[`ln2b${l}`], T, d);
      const dMid = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) dMid[i] = dx[i] + dln2[i];
      // attention branch
      mmTA(c.O, dMid, T, d, d, grads[`Wo${l}`]);
      sumRows(dMid, T, grads[`bo${l}`]);
      const dO = mmTB(dMid, p[`Wo${l}`], T, d, d);
      const dqkv = new Float32Array(T * 3 * d);
      for (let h = 0; h < heads; h++) {
        const P = c.P[h];
        for (let i = 0; i < T; i++) {
          // dP_ij = dO_i · V_j ; dS = P ⊙ (dP − Σ dP⊙P)
          const dP = new Float32Array(i + 1);
          let dot = 0;
          for (let j = 0; j <= i; j++) {
            let s = 0;
            for (let e = 0; e < dh; e++) s += dO[i * d + h * dh + e] * c.qkv[j * 3 * d + 2 * d + h * dh + e];
            dP[j] = s;
            dot += s * P[i * T + j];
          }
          for (let j = 0; j <= i; j++) {
            const w = P[i * T + j];
            const dS = w * (dP[j] - dot) * scale;
            for (let e = 0; e < dh; e++) {
              const vi = j * 3 * d + 2 * d + h * dh + e;
              dqkv[vi] += w * dO[i * d + h * dh + e];                                   // dV
              dqkv[i * 3 * d + h * dh + e] += dS * c.qkv[j * 3 * d + d + h * dh + e];   // dQ
              dqkv[j * 3 * d + d + h * dh + e] += dS * c.qkv[i * 3 * d + h * dh + e];   // dK
            }
          }
        }
      }
      mmTA(c.ln1.Y, dqkv, T, d, 3 * d, grads[`Wqkv${l}`]);
      sumRows(dqkv, T, grads[`bqkv${l}`]);
      const dln1 = layerNormBack(mmTB(dqkv, p[`Wqkv${l}`], T, 3 * d, d), c.ln1.xhat, c.ln1.rstd, p[`ln1g${l}`], grads[`ln1g${l}`], grads[`ln1b${l}`], T, d);
      dx = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) dx[i] = dMid[i] + dln1[i];
    }
    mmTA(cache.inp, dx, T, fin, d, grads.Win);
    sumRows(dx, T, grads.bin);
  }

  /** Incremental decoding with a key/value cache over a sliding window of ctx tokens. */
  runner(): Runner { return new Runner(this); }
}

export class Runner {
  private m: Transformer;
  private K: Float32Array[][] = []; // [layer][t] → d
  private V: Float32Array[][] = [];
  constructor(m: Transformer) {
    this.m = m;
    for (let l = 0; l < m.c.layers; l++) { this.K.push([]); this.V.push([]); }
  }

  clone(): Runner {
    const r = new Runner(this.m);
    r.K = this.K.map((ks) => ks.slice());
    r.V = this.V.map((vs) => vs.slice());
    return r;
  }

  /** Feed one token at absolute position `pos`; returns the output vector. */
  push(tok: Float32Array, pos: number): Float32Array {
    const { d, heads, layers, fout, fin, ctx } = this.m.c, p = this.m.p, dh = d / heads, scale = 1 / Math.sqrt(dh);
    let x = mm(tok, p.Win, 1, fin, d);
    for (let i = 0; i < d; i++) x[i] += p.bin[i] + this.m.pe[pos * d + i];
    for (let l = 0; l < layers; l++) {
      const a = layerNorm(x, p[`ln1g${l}`], p[`ln1b${l}`], 1, d).Y;
      const qkv = mm(a, p[`Wqkv${l}`], 1, d, 3 * d);
      for (let i = 0; i < 3 * d; i++) qkv[i] += p[`bqkv${l}`][i];
      this.K[l].push(qkv.slice(d, 2 * d)); this.V[l].push(qkv.slice(2 * d));
      if (this.K[l].length > ctx) { this.K[l].shift(); this.V[l].shift(); }
      const Ks = this.K[l], Vs = this.V[l], n = Ks.length;
      const O = new Float32Array(d);
      for (let h = 0; h < heads; h++) {
        const s = new Float32Array(n);
        let mx = -Infinity;
        for (let j = 0; j < n; j++) {
          let v = 0;
          for (let e = 0; e < dh; e++) v += qkv[h * dh + e] * Ks[j][h * dh + e];
          s[j] = v * scale;
          if (s[j] > mx) mx = s[j];
        }
        let z = 0;
        for (let j = 0; j < n; j++) { s[j] = Math.exp(s[j] - mx); z += s[j]; }
        for (let j = 0; j < n; j++) for (let e = 0; e < dh; e++) O[h * dh + e] += (s[j] / z) * Vs[j][h * dh + e];
      }
      const att = mm(O, p[`Wo${l}`], 1, d, d);
      for (let i = 0; i < d; i++) x[i] += att[i] + p[`bo${l}`][i];
      const m2 = layerNorm(x, p[`ln2g${l}`], p[`ln2b${l}`], 1, d).Y;
      const h1 = mm(m2, p[`W1${l}`], 1, d, 4 * d);
      for (let i = 0; i < 4 * d; i++) h1[i] = gelu(h1[i] + p[`b1${l}`][i]);
      const mlp = mm(h1, p[`W2${l}`], 1, 4 * d, d);
      x = x.map((v, i) => v + mlp[i] + p[`b2${l}`][i]);
    }
    const z = layerNorm(x, p.lnfg, p.lnfb, 1, d).Y;
    const out = mm(z, p.Wout, 1, d, fout);
    for (let i = 0; i < fout; i++) out[i] += p.bout[i];
    return out;
  }
}
