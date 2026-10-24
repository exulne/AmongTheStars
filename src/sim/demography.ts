// Exact, lazily computed demography on top of the people ledger.
//
// Every settlement's people are a set of pools: native birth cohorts and
// arrival segments (the slice of one source pool that came on one flow). Each
// period, emigrants leave from the top ranks of their pools, then deaths take
// the next ranks down, so a pool's survivors are always ranks [0, alive).
// A member's rank comes from a seeded invertible permutation of their birth
// index, which makes every individual derivable from their identity and every
// identity recoverable from where they sit. Families use the same trick: a
// period's newborns are split into blocks per mother pool, and inside a block
// child slot o belongs to the woman of rank 2·(o mod F).

import { FLOW, NPERIODS, periodOf, periodStart, type Flow, type Ledger } from './ledger.ts';
import { hash01 } from './rng.ts';

// ---------------------------------------------------------------- invertible permutation

export class Perm {
  private h: number; private half: number; private n: number; private seed: number;
  constructor(n: number, seed: number) {
    this.n = Math.max(1, n);
    const bits = Math.max(2, Math.ceil(Math.log2(this.n)));
    this.h = Math.ceil(bits / 2);
    this.half = 2 ** this.h;
    this.seed = seed;
  }
  private F(x: number, k: number): number { return Math.floor(hash01(this.seed, k, x) * this.half); }
  private enc(i: number): number {
    let L = Math.floor(i / this.half), R = i % this.half;
    for (let k = 0; k < 4; k++) { const t = R; R = (L ^ this.F(R, k)) >>> 0; L = t; }
    return L * this.half + R;
  }
  private dec(r: number): number {
    let L = Math.floor(r / this.half), R = r % this.half;
    for (let k = 3; k >= 0; k--) { const t = L; L = (R ^ this.F(L, k)) >>> 0; R = t; }
    return L * this.half + R;
  }
  fwd(i: number): number { let r = this.enc(i); while (r >= this.n) r = this.enc(r); return r; }
  inv(r: number): number { let i = this.dec(r); while (i >= this.n) i = this.dec(i); return i; }
}

// ---------------------------------------------------------------- pools

export interface Pool {
  uid: string;          // body:index
  body: number;
  idx: number;
  native: boolean;
  q: number;            // birth period of the members
  n: number;
  p0: number;           // first period present here
  bornAt: number;       // birthplace of the members
  src?: Pool; srcStart?: number; flow?: number; // arrival segments
  aStart: number[];     // per period from p0: alive at start
  em: number[]; dd: number[];
  out: Map<number, { flow: number; start: number; count: number }[]>;
  alive: number;
  perm?: Perm;
}

export interface Block { pool: Pool; start: number; count: number; F: number }

/** Sex is the parity of a member's rank in their birth pool. An arrival segment's
 *  rank r is native rank srcStart + r (chained), so its women sit at ranks with
 *  r ≡ parity(pool) (mod 2): 0 for natives and even-offset segments, 1 otherwise. */
export function parity(x: Pool): number {
  let off = 0;
  while (!x.native) { off += x.srcStart!; x = x.src!; }
  return off % 2;
}

const AGE_ADULT: [number, number] = [16, 65];
const MOTHER: [number, number] = [16, 49];
const FATHER: [number, number] = [18, 64];

export function periodMid(p: number): number { return (periodStart(p) + periodStart(p + 1)) / 2; }
export function periodLen(p: number): number { return periodStart(p + 1) - periodStart(p); }

/** Earth's 2040 age pyramid in 5-year cohorts born 1920–2040 (periods −24..−1). */
function earthPyramid(total: number): number[] {
  const w: number[] = [];
  for (let k = -24; k < 0; k++) {
    const age = -k * 5 - 2.5;
    w.push(Math.exp(-age / 70) * (age < 60 ? 1 : Math.exp(-((age - 60) ** 2) / 380)));
  }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => Math.round((x / s) * total));
}

function gompertz(age: number, longevity: number): number {
  return 0.0004 + 0.00002 * Math.exp((0.088 / longevity) * Math.max(0, age)) + (age < 1 ? 0.004 : 0);
}
function fert(age: number): number { return Math.exp(-(((age - 29) / 7) ** 2)); }

/** Split n by weights with cumulative rounding (one pass, exact total), capped by caps. */
function split(n: number, w: number[], cap: number[]): number[] {
  const out = new Array<number>(w.length).fill(0);
  let left = n;
  for (let iter = 0; iter < 8 && left > 0; iter++) {
    let W = 0;
    for (let i = 0; i < w.length; i++) if (out[i] < cap[i]) W += w[i];
    if (W <= 0) break;
    let acc = 0, prev = 0, given = 0;
    for (let i = 0; i < w.length; i++) {
      if (out[i] >= cap[i] || w[i] <= 0) continue;
      acc += (w[i] / W) * left;
      const c = Math.min(Math.round(acc) - prev, cap[i] - out[i]);
      prev = Math.round(acc);
      out[i] += c; given += c;
    }
    left -= given;
  }
  return out;
}

/** Like split, but a group of travellers comes from at most `parts` pools (systematic draws), so arrivals stay few. */
function draw(n: number, w: number[], cap: number[], parts: number, u: number): number[] {
  const nz = w.reduce((a, x) => a + (x > 0 ? 1 : 0), 0);
  if (nz <= parts) return split(n, w, cap);
  const W = w.reduce((a, b) => a + b, 0);
  const hits = new Array<number>(w.length).fill(0);
  let i = 0, acc = w[0];
  for (let j = 0; j < parts; j++) {
    const x = ((j + u) / parts) * W;
    while (acc < x && i < w.length - 1) acc += w[++i];
    hits[i]++;
  }
  const got = split(n, hits, cap);
  const short = n - got.reduce((a, b) => a + b, 0);
  if (short <= 0) return got;
  const more = split(short, w, cap.map((c, k) => c - got[k]));
  return got.map((g, k) => g + more[k]);
}

// ---------------------------------------------------------------- per-settlement model

class Settlement {
  body: number;
  pools: Pool[] = [];
  active: Pool[] = [];
  built = -1;
  first: number;
  outMemo = new Map<number, true>();
  segByFlow = new Map<string, Pool>();          // flowId:srcUid → arrival segment here
  nativeByPeriod = new Map<number, Pool>();
  mothers = new Map<number, Block[]>();
  fathers = new Map<number, Block[]>();
  carry = 0;
  constructor(body: number, first: number) { this.body = body; this.first = first; }
}

export interface Stay { body: number; pool: Pool; rank: number; from: number; to: number; end: 'alive' | 'died' | 'left' | 'lost'; flow?: Flow; diedYear?: number }

export class Demography {
  private L: Ledger;
  private seed: number;
  private earth: number;
  private longevity: (year: number) => number;
  private towns = new Map<number, Settlement>();
  private outIdx = new Map<number, Map<number, number[]>>(); // body → departure period → flow ids
  private inIdx = new Map<number, Map<number, number[]>>();  // body → arrival period → flow ids
  private byFlow = new Map<number, { pool: Pool; start: number; count: number }[]>();

  private index(m: Map<number, Map<number, number[]>>, src: Map<number, number[]>, b: number, key: (f: Flow) => number): Map<number, number[]> {
    let ix = m.get(b);
    if (ix) return ix;
    ix = new Map();
    for (const id of src.get(b) ?? []) {
      const k = key(this.L.flows[id]);
      const a = ix.get(k);
      if (a) a.push(id); else ix.set(k, [id]);
    }
    m.set(b, ix);
    return ix;
  }

  constructor(ledger: Ledger, seed: number, earth: number, longevity: (year: number) => number) {
    this.L = ledger; this.seed = seed; this.earth = earth; this.longevity = longevity;
  }

  get lastPeriod(): number { return this.L.closed; }

  private town(b: number): Settlement {
    let t = this.towns.get(b);
    if (t) return t;
    let first = b === this.earth ? 0 : NPERIODS;
    for (const id of this.L.inBy.get(b) ?? []) first = Math.min(first, this.L.flows[id].pArrive);
    const br = this.L.births.get(b);
    if (br) for (let p = 0; p < NPERIODS; p++) if (br[p] > 0) { first = Math.min(first, p); break; }
    t = new Settlement(b, first);
    this.towns.set(b, t);
    if (b === this.earth) {
      const sizes = earthPyramid(9.2e9);
      sizes.forEach((n, k) => this.addPool(t!, { native: true, q: k - 24, n, p0: 0, bornAt: b }));
    }
    return t;
  }

  private addPool(t: Settlement, p: Omit<Pool, 'uid' | 'body' | 'idx' | 'aStart' | 'em' | 'dd' | 'out' | 'alive'>): Pool {
    const pool: Pool = { ...p, uid: `${t.body}:${t.pools.length}`, body: t.body, idx: t.pools.length, aStart: [], em: [], dd: [], out: new Map(), alive: p.n };
    if (pool.native) pool.perm = new Perm(pool.n, Math.floor(hash01(this.seed, t.body, pool.q, 77) * 2 ** 31));
    t.pools.push(pool);
    if (pool.n > 0) t.active.push(pool);
    if (pool.native) t.nativeByPeriod.set(pool.q, pool);
    return pool;
  }

  /** Build settlement b through period p (inclusive). */
  ensure(b: number, p: number): Settlement {
    const t = this.town(b);
    p = Math.min(p, this.L.closed);
    for (let k = Math.max(t.built + 1, t.first); k <= p; k++) this.buildPeriod(t, k);
    if (t.built < p) t.built = p;
    return t;
  }

  /** Allocate settlement b's outflows of period p to its pools (start-of-period state). */
  private allocOut(b: number, p: number): void {
    const t = this.town(b);
    if (t.outMemo.has(p)) return;
    if (t.built < p - 1) this.ensure(b, p - 1);
    if (t.outMemo.has(p)) return;
    t.outMemo.set(p, true);
    const flows = (this.index(this.outIdx, this.L.outBy, b, (f) => f.p).get(p) ?? []).map((id) => this.L.flows[id]);
    if (!flows.length) return;
    const pool = t.active.filter((x) => x.alive > 0);
    const age = (x: Pool) => periodMid(p) - periodMid(x.q);
    const remain = pool.map((x) => x.alive);
    for (const f of flows) {
      const adult = pool.map((x, i) => (age(x) >= AGE_ADULT[0] && age(x) <= AGE_ADULT[1] ? remain[i] : 0));
      const useAdults = adult.reduce((a, c) => a + c, 0) >= f.n;
      const w = useAdults ? adult : remain.slice();
      const c = draw(f.n, w, useAdults ? adult : remain, 8, hash01(this.seed, f.id, 41));
      c.forEach((cnt, i) => {
        if (cnt <= 0) return;
        const x = pool[i];
        remain[i] -= cnt;
        const ranges = x.out.get(p) ?? [];
        ranges.push({ flow: f.id, start: remain[i], count: cnt });
        x.out.set(p, ranges);
        const bf = this.byFlow.get(f.id);
        if (bf) bf.push({ pool: x, start: remain[i], count: cnt }); else this.byFlow.set(f.id, [{ pool: x, start: remain[i], count: cnt }]);
      });
    }
  }

  private buildPeriod(t: Settlement, p: number): void {
    this.allocOut(t.body, p);
    const before = t.active.filter((x) => x.alive > 0);
    const start = new Map<Pool, number>();
    for (const x of before) {
      start.set(x, x.alive);
      const E = (x.out.get(p) ?? []).reduce((a, r) => a + r.count, 0);
      x.alive -= E;
    }
    // arrivals: one segment per (flow, source pool)
    const arrivals: Pool[] = [];
    for (const id of this.index(this.inIdx, this.L.inBy, t.body, (f) => f.pArrive).get(p) ?? []) {
      const f = this.L.flows[id];
      if (f.lost) continue;
      this.allocOut(f.src, f.p);
      for (const r of this.byFlow.get(f.id) ?? []) {
        const x = r.pool;
        const seg = this.addPool(t, { native: false, q: x.q, n: r.count, p0: p, bornAt: x.bornAt, src: x, srcStart: r.start, flow: f.id });
        t.segByFlow.set(`${f.id}:${x.uid}`, seg);
        arrivals.push(seg);
      }
    }
    // births, then deaths as the residual against the engine's head-count
    let births = 0;
    const br = this.L.births.get(t.body);
    if (br && br[p] > 0) { const v = br[p] + t.carry; births = Math.floor(v); t.carry = v - births; }
    const target = Math.max(0, this.L.popEnd.get(t.body)?.[p] ?? 0);
    const now = before.reduce((a, x) => a + x.alive, 0) + arrivals.reduce((a, x) => a + x.alive, 0);
    let D = now + births - target;
    if (D < 0) { births -= D; D = 0; }
    // a settlement that empties in this period: nobody is left to die beyond everyone,
    // so the excess comes off the births (else newborns outlive an abandoned town)
    if (D > now) { births -= D - now; D = now; }
    const lon = this.longevity(periodStart(p));
    const pool = [...before, ...arrivals].filter((x) => x.alive > 0);
    const w = pool.map((x) => x.alive * gompertz(periodMid(p) - periodMid(x.q), lon));
    const dead = split(D, w, pool.map((x) => x.alive));
    pool.forEach((x, i) => { x.alive -= dead[i]; });
    const deadOf = new Map(pool.map((x, i) => [x, dead[i]] as const));
    for (const x of before) {
      const k = p - x.p0;
      x.aStart[k] = start.get(x)!;
      x.em[k] = (x.out.get(p) ?? []).reduce((a, r) => a + r.count, 0);
      x.dd[k] = deadOf.get(x) ?? 0;
    }
    for (const x of arrivals) { x.aStart[0] = x.n; x.em[0] = 0; x.dd[0] = deadOf.get(x) ?? 0; }
    if (births > 0) {
      const nb = this.addPool(t, { native: true, q: p, n: births, p0: p, bornAt: t.body });
      nb.aStart[0] = births; nb.em[0] = 0; nb.dd[0] = 0;
    }
    t.active = t.active.filter((x) => x.alive > 0);
    t.built = p;
  }

  // ---------------------------------------------------------------- families

  private parentBlocks(t: Settlement, p: number, sex: 0 | 1): Block[] {
    const memo = sex === 0 ? t.mothers : t.fathers;
    const got = memo.get(p);
    if (got) return got;
    this.ensure(t.body, p);
    const born = t.nativeByPeriod.get(p);
    const blocks: Block[] = [];
    memo.set(p, blocks);
    if (!born) return blocks;
    const [lo, hi] = sex === 0 ? MOTHER : FATHER;
    const cands: Pool[] = [], w: number[] = [], caps: number[] = [], Fs: number[] = [];
    for (const x of t.pools) {
      if (x === born || x.p0 > p) continue;
      const k = p - x.p0;
      if (k >= x.aStart.length) continue;
      const aliveEnd = x.aStart[k] - x.em[k] - x.dd[k];
      const women = parity(x) ? Math.floor(aliveEnd / 2) : Math.ceil(aliveEnd / 2);
      const F = sex === 0 ? women : aliveEnd - women;
      const age = periodMid(p) - periodMid(x.q);
      if (F <= 0 || age < lo || age > hi) continue;
      cands.push(x); Fs.push(F); w.push(F * (sex === 0 ? fert(age) : fert(age - 3))); caps.push(Number.MAX_SAFE_INTEGER);
    }
    const c = split(born.n, w, caps);
    let s = 0;
    cands.forEach((x, i) => {
      if (c[i] > 0) blocks.push({ pool: x, start: s, count: c[i], F: Fs[i] });
      s += c[i];
    });
    return blocks;
  }

  private childPerm(b: number, p: number, n: number, sex: 0 | 1): Perm {
    return new Perm(n, Math.floor(hash01(this.seed, b, p, 91 + sex) * 2 ** 31));
  }

  // ---------------------------------------------------------------- identities

  /** Birth identity of the member at `rank` of pool x. */
  origin(x: Pool, rank: number): Id {
    let pool = x, r = rank;
    while (!pool.native) { r = pool.srcStart! + r; pool = pool.src!; }
    return { b: pool.body, q: pool.q, i: pool.perm!.inv(r) };
  }

  /** Native pool and rank for an identity. */
  birthPool(id: Id): { pool: Pool; rank: number } | null {
    const t = this.ensure(id.b, Math.max(id.q, 0));
    const pool = t.nativeByPeriod.get(id.q);
    if (!pool || id.i < 0 || id.i >= pool.n) return null;
    return { pool, rank: pool.perm!.fwd(id.i) };
  }

  /** Where this person was, period by period, until death or the present. */
  life(id: Id, upto = this.L.closed): Stay[] | null {
    const start = this.birthPool(id);
    if (!start) return null;
    const stays: Stay[] = [];
    let pool = start.pool, rank = start.rank, from = Math.max(pool.p0, pool.q);
    for (let hop = 0; hop < 32; hop++) {
      this.ensure(pool.body, upto);
      const last = pool.p0 + pool.aStart.length - 1;
      let end: Stay['end'] = 'alive', at = Math.min(last, upto);
      for (let p = Math.max(from, pool.p0); p <= Math.min(last, upto); p++) {
        const k = p - pool.p0;
        const s0 = pool.aStart[k], E = pool.em[k], D = pool.dd[k];
        if (rank < s0 - E - D) continue;
        at = p;
        if (rank >= s0 - E) end = 'left'; else end = 'died';
        break;
      }
      const stay: Stay = { body: pool.body, pool, rank, from, to: at, end };
      stays.push(stay);
      if (end !== 'left') {
        if (end === 'died') stay.diedYear = periodStart(at) + hash01(this.seed, id.b, id.q, id.i, 5) * periodLen(at);
        break;
      }
      // which flow took them, and where it landed
      const r = (pool.out.get(at) ?? []).find((x) => rank >= x.start && rank < x.start + x.count);
      if (!r) break;
      const f = this.L.flows[r.flow];
      stay.flow = f;
      if (f.lost) { stays.push({ body: f.dst, pool, rank, from: at, to: f.pArrive, end: 'lost', flow: f, diedYear: f.arrive }); break; }
      const dest = this.ensure(f.dst, f.pArrive);
      const seg = dest.segByFlow.get(`${f.id}:${pool.uid}`);
      if (!seg) break;
      rank = rank - r.start; pool = seg; from = f.pArrive;
    }
    return stays;
  }

  mother(id: Id): Id | null { const m = this.motherSlot(id); return m && this.origin(m.pool, m.rank); }

  /** Couples: a woman of rank 2k and the man of rank 2k+1 in the same pool share a life,
   *  migrate together (adjacent ranks leave together) and are widowed when one rank falls away.
   *  A child's father is the mother's partner if he was alive and present at the birth. */
  father(id: Id): Id | null {
    const m = this.motherSlot(id);
    if (!m) return null;
    const k = id.q - m.pool.p0;
    const aliveEnd = m.pool.aStart[k] - m.pool.em[k] - m.pool.dd[k];
    return m.rank + 1 < aliveEnd ? this.origin(m.pool, m.rank + 1) : null;
  }

  private motherSlot(id: Id): { pool: Pool; rank: number } | null {
    if (id.q < 0) return null;
    const t = this.ensure(id.b, id.q);
    const born = t.nativeByPeriod.get(id.q);
    if (!born) return null;
    const blocks = this.parentBlocks(t, id.q, 0);
    const slot = this.childPerm(id.b, id.q, born.n, 0).fwd(id.i);
    const bl = blocks.find((x) => slot >= x.start && slot < x.start + x.count);
    if (!bl) return null;
    return { pool: bl.pool, rank: parity(bl.pool) + 2 * ((slot - bl.start) % bl.F) };
  }

  /** The partner rank of this person in their pool (alive or not). */
  partnerRank(rank: number): number { return rank % 2 === 0 ? rank + 1 : rank - 1; }

  children(id: Id, upto = this.L.closed): Id[] {
    const stays = this.life(id, upto);
    const bp = this.birthPool(id);
    if (!stays || !bp) return [];
    const out: Id[] = [];
    for (const s of stays) {
      if (s.end === 'lost') continue;
      const par = parity(s.pool), male = (par + s.rank) % 2 === 1;
      const t = this.town(s.body);
      for (let p = s.from; p <= s.to; p++) {
        // present and alive at the end of p (someone who died or left in p has no child then)
        if (p === s.to && s.end !== 'alive') continue;
        const blocks = this.parentBlocks(t, p, 0);
        const bl = blocks.find((x) => x.pool === s.pool);
        if (!bl) continue;
        // a father's children are his partner's, born while both were alive here
        const k = ((male ? s.rank - 1 : s.rank) - par) / 2;
        if (k < 0) continue;
        const born = t.nativeByPeriod.get(p)!;
        const perm = this.childPerm(s.body, p, born.n, 0);
        for (let o = k; o < bl.count; o += bl.F) out.push({ b: s.body, q: p, i: perm.inv(bl.start + o) });
      }
    }
    return out;
  }

  /** Residents present at the end of period p, in a stable shuffled order. */
  census(b: number, p: number): { total: number; at: (k: number) => Id; pools: { pool: Pool; alive: number }[] } {
    const t = this.ensure(b, p);
    const pools: { pool: Pool; alive: number }[] = [];
    for (const x of t.pools) {
      if (x.p0 > p) continue;
      const k = p - x.p0;
      if (k >= x.aStart.length) continue;
      const a = x.aStart[k] - x.em[k] - x.dd[k];
      if (a > 0) pools.push({ pool: x, alive: a });
    }
    const total = pools.reduce((s, x) => s + x.alive, 0);
    const pre: number[] = [];
    let s = 0;
    for (const x of pools) { pre.push(s); s += x.alive; }
    const tau = new Perm(total, Math.floor(hash01(this.seed, b, p, 13) * 2 ** 31));
    return {
      total, pools,
      at: (k: number) => {
        const r = tau.fwd(k);
        let lo = 0, hi = pools.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pre[m] <= r) lo = m; else hi = m - 1; }
        return this.origin(pools[lo].pool, r - pre[lo]);
      },
    };
  }

  /** Age × sex table (10-year bands) at the end of period p: the T1 view. */
  pyramid(b: number, p: number): { band: number; women: number; men: number }[] {
    const { pools } = this.census(b, p);
    const bands = new Map<number, { women: number; men: number }>();
    for (const { pool, alive } of pools) {
      const band = Math.max(0, Math.floor((periodStart(p + 1) - periodMid(pool.q)) / 10));
      const e = bands.get(band) ?? { women: 0, men: 0 };
      const w = parity(pool) ? Math.floor(alive / 2) : Math.ceil(alive / 2);
      e.women += w; e.men += alive - w;
      bands.set(band, e);
    }
    return [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([band, v]) => ({ band, ...v }));
  }

  birthYear(id: Id): number {
    const n = this.birthPool(id)?.pool.n ?? 1;
    return periodStart(id.q) + ((id.i + hash01(this.seed, id.b, id.q, id.i, 3)) / n) * periodLen(id.q);
  }

  flow(id: number): Flow { return this.L.flows[id]; }
  isCrew(f: Flow): boolean { return f.kind === FLOW.CREW; }
}

export interface Id { b: number; q: number; i: number }
export const idStr = (id: Id) => `${id.b}.${id.q}.${id.i}`;
export function parseId(s: string): Id | null {
  const m = s.match(/^(\d+)\.(-?\d+)\.(\d+)$/);
  return m ? { b: Number(m[1]), q: Number(m[2]), i: Number(m[3]) } : null;
}
export { periodOf };
