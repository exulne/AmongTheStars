// The people ledger: births, end-of-period head-counts and every flow of
// people between settlements, per demography period. Written by the main
// engine run only (never part of snapshots); read by the demography model.

/** Period p starts at periodStart(p). 5-year periods until 200, 8 until 1000, then 20. */
export const NPERIODS = 590;
export function periodStart(p: number): number {
  if (p < 0) return 5 * p;               // Earth before the Landing: 1920–2040 in 5-year cohorts
  return p < 40 ? 5 * p : p < 140 ? 200 + 8 * (p - 40) : 1000 + 20 * (p - 140);
}
export function periodOf(year: number): number {
  if (year < 0) return Math.floor(year / 5);
  const p = year < 200 ? Math.floor(year / 5) : year < 1000 ? 40 + Math.floor((year - 200) / 8) : 140 + Math.floor((year - 1000) / 20);
  return Math.min(p, NPERIODS - 1);
}
export function isPeriodBoundary(year: number): boolean {
  return year > 0 && periodStart(periodOf(year)) === year;
}

export const FLOW = { MIGRATION: 0, CREW: 1, SHIP: 2, FTL: 3, LANDING: 4 } as const;

/** Long voyages are places of their own: a generation ship is body SHIP_BODY + its travel id. */
export const SHIP_BODY = 1_000_000;
export const GENERATION = 25; // years; longer voyages carry generations, not the original crew
export const isShipBody = (b: number) => b >= SHIP_BODY;

export interface Flow {
  id: number;
  src: number; dst: number;
  n: number;          // whole people
  p: number;          // period of departure
  depart: number; arrive: number;
  pArrive: number;    // period of arrival
  kind: number;
  lost: boolean;
}

export class Ledger {
  births = new Map<number, Float64Array>();
  popEnd = new Map<number, Float64Array>();
  flows: Flow[] = [];
  outBy = new Map<number, number[]>();       // body → flow ids leaving it
  inBy = new Map<number, number[]>();        // body → flow ids arriving
  private acc = new Map<number, number>();   // in-period migration, keyed src*2^20+dst
  private carry = new Map<number, number>();
  private birthAcc = new Map<number, number>();
  closed = -1;                               // last period closed
  /** every ship by travel id: where from and to, when, how many, and its ledger flow */
  ships = new Map<number, { src: number; dst: number; n: number; depart: number; arrive: number; flow: number; generation: boolean }>();

  private arr(m: Map<number, Float64Array>, b: number): Float64Array {
    let a = m.get(b);
    if (!a) m.set(b, (a = new Float64Array(NPERIODS).fill(-1)));
    return a;
  }

  addBirths(body: number, n: number): void { this.birthAcc.set(body, (this.birthAcc.get(body) ?? 0) + n); }

  migrate(src: number, dst: number, n: number): void {
    if (src === dst || n <= 0) return;
    const k = src * 1048576 + dst;
    this.acc.set(k, (this.acc.get(k) ?? 0) + n);
  }

  /** A discrete group (crew or ship) leaving now. Returns the flow id. */
  depart(src: number, dst: number, n: number, year: number, arrive: number, kind: number): number {
    const f: Flow = { id: this.flows.length, src, dst, n: Math.max(0, Math.round(n)), p: periodOf(year), depart: year, arrive, pArrive: periodOf(arrive), kind, lost: false };
    this.flows.push(f);
    push(this.outBy, src, f.id);
    push(this.inBy, dst, f.id);
    return f.id;
  }

  /** A generation ship: everyone boards a ship-body, lives there for the voyage
   *  with births replacing deaths, and the people aboard at the end land (or are lost). */
  voyage(seq: number, src: number, dst: number, n: number, depart: number, arrive: number, kind: number): number {
    const ship = SHIP_BODY + seq;
    const board = this.depart(src, ship, n, depart, depart, kind);
    this.aboard(ship, n, depart, periodOf(depart), arrive);
    return board;
  }

  /** Fill a ship's births (replacing deaths) and head-count from period p0 up to `until`. */
  private aboard(ship: number, n: number, depart: number, p0: number, until: number): void {
    const br = this.arr(this.births, ship), pe = this.arr(this.popEnd, ship);
    for (let p = p0; p <= periodOf(until); p++) {
      const len = Math.min(periodStart(p + 1), until) - Math.max(periodStart(p), depart);
      br[p] = Math.max(0, n * len / 55);
      pe[p] = Math.round(n);
    }
  }

  /** The people aboard ship `seq` reach (or never reach) dst. The engine notices an
   *  arrival at its next step, which can fall in a later period than the planned
   *  arrival, so the ship stays inhabited until the period it actually lands in. */
  land(seq: number, dst: number, n: number, year: number, lost: boolean): void {
    const ship = SHIP_BODY + seq;
    const pe = this.arr(this.popEnd, ship), br = this.arr(this.births, ship);
    let last = periodOf(year);
    while (last > 0 && pe[last] < 0) last--;
    if (last < periodOf(year)) this.aboard(ship, n, periodStart(last + 1), last + 1, year);
    pe[periodOf(year)] = 0; br[periodOf(year)] = 0;
    const id = this.depart(ship, dst, n, year, year, FLOW.LANDING);
    this.flows[id].lost = lost;
  }

  /** Close period p (just ended): settle migration, births, head-counts. */
  close(p: number, pops: (fn: (body: number, pop: number) => void) => void): void {
    for (const [k, v] of this.acc) {
      const total = v + (this.carry.get(k) ?? 0);
      const n = Math.floor(total);
      this.carry.set(k, total - n);
      if (n <= 0) continue;
      const src = Math.floor(k / 1048576), dst = k % 1048576;
      const f: Flow = { id: this.flows.length, src, dst, n, p, depart: periodStart(p), arrive: periodStart(p), pArrive: p, kind: FLOW.MIGRATION, lost: false };
      this.flows.push(f);
      push(this.outBy, src, f.id);
      push(this.inBy, dst, f.id);
    }
    this.acc.clear();
    for (const [b, n] of this.birthAcc) this.arr(this.births, b)[p] = n;
    this.birthAcc.clear();
    pops((b, pop) => { this.arr(this.popEnd, b)[p] = pop; });
    this.closed = p;
  }
}

function push(m: Map<number, number[]>, k: number, v: number): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}
