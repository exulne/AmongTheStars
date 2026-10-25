// sfc32: small, fast, and its whole state fits in a Uint32Array, so it can be
// snapshotted with the rest of the simulation and replayed exactly.

export type RngState = Uint32Array; // length 4

export function seedRng(seed: number): RngState {
  const s = new Uint32Array(4);
  let h = 1779033703 ^ seed;
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    s[i] = h + i * 0x9e3779b9;
  }
  const r = { s };
  for (let i = 0; i < 12; i++) next(r.s);
  return s;
}

export function next(s: RngState): number {
  const a = s[0], b = s[1], c = s[2], d = s[3];
  const t = (((a + b) >>> 0) + d) >>> 0;
  s[3] = (d + 1) >>> 0;
  s[0] = b ^ (b >>> 9);
  s[1] = (c + (c << 3)) >>> 0;
  const c2 = ((c << 21) | (c >>> 11)) >>> 0;
  s[2] = (c2 + t) >>> 0;
  return t / 4294967296;
}

/** Stateless hash → [0,1). Used for lazily generated detail (people, planet looks). */
export function hash01(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h = Math.imul(h ^ ((x * 4096) | 0), 0x5bd1e995);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Mutable PRNG object for one-off generation (world building). */
export class Rng {
  s: RngState;
  constructor(seed: number) { this.s = seedRng(seed); }
  next(): number { return next(this.s); }
  range(a: number, b: number): number { return a + (b - a) * next(this.s); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(next(this.s) * xs.length)]; }
  gauss(): number {
    const u = Math.max(1e-12, next(this.s)), v = next(this.s);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
