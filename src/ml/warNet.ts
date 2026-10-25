// The war policy network, forward pass only (training is in ml/rl/ppo.py, which
// mirrors this layout exactly). One trunk reads a polity's own state; the pair
// head reads the trunk's summary plus one rival and answers press / strike /
// terms. Weights are one flat Float32Array, PyTorch Linear layout (out × in).
//
//   self (DS) → 128 tanh → 64 tanh = h ─┬→ value (1)
//                                       ├→ posture (4)
//   [h, pair (DP)] → 64 tanh ───────────┴→ pair logits (8): press 0-1, strike 2-3, terms 4-7

export const DS = 32;
export const DP = 22;
export const H1 = 128, H2 = 64, HQ = 64, NPOST = 4, NPAIR = 8;
export const PAIR_KIND = { PRESS: 0, STRIKE: 1, TERMS: 2 } as const;
export const PAIR_SLICE: [number, number][] = [[0, 2], [2, 4], [4, 8]];

const LAYERS: [string, number, number][] = [
  ['l1', H1, DS], ['l2', H2, H1], ['v', 1, H2], ['post', NPOST, H2], ['q1', HQ, H2 + DP], ['q2', NPAIR, HQ],
];
export const NPARAM = LAYERS.reduce((a, [, o, i]) => a + o * i + o, 0);

interface Lin { w: number; b: number; o: number; i: number }

export class WarNet {
  readonly p: Float32Array;
  private L: Record<string, Lin> = {};
  private h1 = new Float64Array(H1);
  private q = new Float64Array(HQ);
  private x = new Float64Array(H2 + DP);
  constructor(params: Float32Array) {
    if (params.length !== NPARAM) throw new Error(`war net wants ${NPARAM} params, got ${params.length}`);
    this.p = params;
    let k = 0;
    for (const [name, o, i] of LAYERS) { this.L[name] = { w: k, b: k + o * i, o, i }; k += o * i + o; }
  }

  private lin(l: Lin, x: ArrayLike<number>, out: Float64Array, act: boolean): void {
    const p = this.p;
    for (let r = 0; r < l.o; r++) {
      let s = p[l.b + r];
      const w = l.w + r * l.i;
      for (let c = 0; c < l.i; c++) s += p[w + c] * x[c];
      out[r] = act ? Math.tanh(s) : s;
    }
  }

  /** The trunk: h (length H2) for one polity's own state. */
  trunk(self: ArrayLike<number>, h: Float64Array): void {
    this.lin(this.L.l1, self, this.h1, true);
    this.lin(this.L.l2, this.h1, h, true);
  }
  value(h: Float64Array): number { const o = new Float64Array(1); this.lin(this.L.v, h, o, false); return o[0]; }
  posture(h: Float64Array, logits: Float64Array): void { this.lin(this.L.post, h, logits, false); }
  pair(h: Float64Array, pair: ArrayLike<number>, logits: Float64Array): void {
    this.x.set(h);
    for (let k = 0; k < DP; k++) this.x[H2 + k] = pair[k];
    this.lin(this.L.q1, this.x, this.q, true);
    this.lin(this.L.q2, this.q, logits, false);
  }
}

/** Sample from logits[lo..hi) with mask (true = allowed); returns [index - lo, log prob]. */
export function sample(logits: Float64Array, lo: number, hi: number, u: number, mask?: ArrayLike<boolean>): [number, number] {
  let m = -Infinity;
  for (let k = lo; k < hi; k++) if (!mask || mask[k - lo]) m = Math.max(m, logits[k]);
  let z = 0;
  for (let k = lo; k < hi; k++) if (!mask || mask[k - lo]) z += Math.exp(logits[k] - m);
  let acc = 0, pick = -1;
  for (let k = lo; k < hi; k++) {
    if (mask && !mask[k - lo]) continue;
    acc += Math.exp(logits[k] - m) / z;
    pick = k;
    if (u < acc) break;
  }
  return [pick - lo, logits[pick] - m - Math.log(z)];
}

/** A random network, for generation zero before any training. */
export function randomParams(seed: number): Float32Array {
  const p = new Float32Array(NPARAM);
  let s = seed >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  let k = 0;
  for (const [, o, i] of LAYERS) {
    const sc = 1 / Math.sqrt(i);
    for (let n = 0; n < o * i; n++) p[k++] = (r() * 2 - 1) * sc;
    k += o;
  }
  return p;
}
