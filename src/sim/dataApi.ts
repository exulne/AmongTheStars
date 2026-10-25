// The worker's data desk: answers analyst questions about the run without
// touching the engine. Tables come from the state at a step; anything "over
// time" replays the run from its first snapshot on a private engine, in
// slices, so the worker keeps answering while it scans.

import { isAlive } from './catalog.ts';
import { Engine, type SimState } from './engine.ts';
import { F, NF } from './metrics.ts';
import { NMC } from './launchEconomics.ts';
import { compile, placeBinder, QueryError, type PlaceRow } from './query.ts';
import type { World } from './world.ts';

export type Agg = 'count' | 'sum' | 'mean' | 'min' | 'max';

export type DataReq =
  | { type: 'table'; id: number; step: number }
  | { type: 'scan'; id: number; expr: string; agg: Agg; of?: string; stride: number }
  | { type: 'runinfo'; id: number }
  /** a place field or expression summed per group (faction, system or stage) at every stride-th step */
  | { type: 'groups'; id: number; by: GroupBy; of?: string; stride: number; top: number; focus?: number }
  /** every field of up to a few places at every stride-th step */
  | { type: 'place'; id: number; bodies: number[]; stride: number }
  /** mission economics records launched up to a year (launchEconomics.ts MC columns) */
  | { type: 'missions'; id: number; year: number }
  /** one mission's record by its id (the ship's flow id, or a crewed mission's) */
  | { type: 'mission'; id: number; mission: number };

export type DataRes =
  | { type: 'table'; id: number; step: number; year: number; bodies: Int32Array; rows: Float64Array }
  | { type: 'scan'; id: number; pending?: boolean; error?: string; steps: Int32Array; values: Float64Array }
  /** what this seed rolled: which techs its physics allows, their cost luck, its wanderlust; techDone so far */
  | { type: 'runinfo'; id: number; seed: number; done: boolean; feasible: number[]; costMult: number[]; wanderlust: number; techDone: number[] }
  /** values[i * keys.length + k]: group keys[k] at steps[i]; other: the rest; total: every living place */
  | { type: 'groups'; id: number; pending?: boolean; error?: string; by: GroupBy; steps: Int32Array; keys: number[]; values: Float64Array; other: Float64Array; total: Float64Array; nGroups: Int32Array }
  /** rows[(i * bodies.length + j) * NF + f]: field f of bodies[j] at steps[i] (NaN before it was settled) */
  | { type: 'place'; id: number; pending?: boolean; bodies: number[]; steps: Int32Array; rows: Float64Array }
  /** rows[i * NMC + c]: column c of mission i, launch order; the run's seed and the assumption scenario it was priced with */
  | { type: 'missions'; id: number; seed: number; scenario: string; done: boolean; rows: Float64Array }
  | { type: 'mission'; id: number; row: Float64Array | null };

export type PlaceRes = Extract<DataRes, { type: 'place' }>;
export type GroupBy = 'faction' | 'system' | 'stage';

export interface DataEnv {
  world: World;
  main: () => Engine | null;
  snaps: () => SimState[];
  stateAt: (step: number) => Engine;
  post: (m: DataRes, transfer?: Transferable[]) => void;
  /** give a replaying engine the same war minds as the main run */
  minds?: (e: Engine) => void;
}

const DATA_TYPES = new Set(['table', 'scan', 'runinfo', 'groups', 'place', 'missions', 'mission']);
export function isDataReq(m: { type: string }): m is DataReq { return DATA_TYPES.has(m.type); }

export const living = isAlive;
const SNAP_EVERY = 20; // the worker's snapshot spacing

// ---------------------------------------------------------------- replay scans

type Visit = (st: SimState, step: number, year: number) => void;
interface Job { stride: number; visit: Visit; done: (ok: boolean) => void }

let scanner: Engine | null = null;
const queue: Job[] = [];
let running = false;

/** Visit the state at every `stride`-th step (and the last). Needs a finished run. */
function scan(env: DataEnv, stride: number, visit: Visit): Promise<boolean> {
  return new Promise((res) => { queue.push({ stride: Math.max(1, Math.floor(stride)), visit, done: res }); pump(env); });
}

function pump(env: DataEnv): void {
  if (running || !queue.length) return;
  const job = queue.shift()!, main = env.main();
  if (!main || !main.done) { job.done(false); pump(env); return; }
  const snaps = env.snaps(), last = main.st.step, years = main.years;
  // on the snapshot grid the saved states are the answer: no replay needed
  if (job.stride % SNAP_EVERY === 0) {
    for (const s of snaps) if (s.step % job.stride === 0) job.visit(s, s.step, years[s.step]);
    if (last % job.stride !== 0) job.visit(main.st, last, years[last]);
    job.done(true);
    pump(env);
    return;
  }
  if (!scanner || scanner.seed !== main.seed) {
    scanner = new Engine(env.world, main.seed);
    scanner.ledger = null;
    scanner.logEvents = false;
    env.minds?.(scanner);
  }
  const e = scanner;
  e.restore(snaps[0]);
  running = true;
  const slice = () => {
    if (env.main() !== main) { running = false; job.done(false); pump(env); return; }
    const until = performance.now() + 25;
    while (performance.now() < until) {
      const k = e.st.step;
      if (k % job.stride === 0 || k === last) job.visit(e.st, k, years[k]);
      if (k >= last) { running = false; job.done(true); pump(env); return; }
      e.step();
    }
    setTimeout(slice, 0);
  };
  slice();
}

// ---------------------------------------------------------------- handlers

export function handleData(m: DataReq, env: DataEnv): void {
  if (m.type === 'runinfo') {
    const e = env.main();
    if (!e) { env.post({ type: 'runinfo', id: m.id, seed: 0, done: false, feasible: [], costMult: [], wanderlust: 1, techDone: [] }); return; }
    env.post({ type: 'runinfo', id: m.id, seed: e.seed, done: e.done, feasible: Array.from(e.feasible), costMult: Array.from(e.techCostMult), wanderlust: e.wanderlust, techDone: Array.from(e.st.techDone) });
  } else if (m.type === 'groups') groups(m, env);
  else if (m.type === 'missions') {
    // a copy: asking never touches the engine's own log
    const e = env.main(), rows = e ? e.missions.upTo(m.year) : new Float64Array(0);
    env.post({ type: 'missions', id: m.id, seed: e?.seed ?? 0, scenario: e?.econ.scenario ?? 'baseline', done: !!e?.done, rows }, [rows.buffer]);
  } else if (m.type === 'mission') {
    const e = env.main(), i = e ? e.missions.row(m.mission) : -1;
    env.post({ type: 'mission', id: m.id, row: i >= 0 ? e!.missions.rows.slice(i * NMC, i * NMC + NMC) : null });
  }
  else if (m.type === 'place') {
    const bodies = m.bodies.slice(0, 8).filter((b) => b >= 0 && b < env.world.bodies.length), nb = bodies.length;
    const steps: number[] = [], chunks: Float64Array[] = [];
    scan(env, m.stride, (st, step) => {
      const r = new Float64Array(nb * NF).fill(NaN);
      bodies.forEach((b, j) => { if (st.S[b * NF + F.stage] >= 0) { r.set(st.S.subarray(b * NF, b * NF + NF), j * NF); r[j * NF + F.culture] = NaN; } });
      steps.push(step); chunks.push(r);
    }).then((ok) => {
      const rows = new Float64Array(chunks.length * nb * NF);
      chunks.forEach((c, i) => rows.set(c, i * nb * NF));
      const st = Int32Array.from(steps);
      env.post({ type: 'place', id: m.id, pending: !ok, bodies, steps: st, rows }, [st.buffer, rows.buffer]);
    });
  } else if (m.type === 'table') {
    const e = env.stateAt(m.step), st = e.st;
    const ids: number[] = [];
    for (let n = 0; n < st.nSettled; n++) if (living(st.S[st.settled[n] * NF + F.stage])) ids.push(st.settled[n]);
    const rows = new Float64Array(ids.length * NF);
    ids.forEach((b, i) => { rows.set(st.S.subarray(b * NF, b * NF + NF), i * NF); rows[i * NF + F.culture] = NaN; });
    const bodies = Int32Array.from(ids);
    env.post({ type: 'table', id: m.id, step: st.step, year: e.years[st.step], bodies, rows }, [bodies.buffer, rows.buffer]);
  } else if (m.type === 'scan') {
    const empty = { type: 'scan' as const, id: m.id, steps: new Int32Array(0), values: new Float64Array(0) };
    const bind = placeBinder(env.world);
    let test: ((r: PlaceRow) => boolean) | null = null, val: ((r: PlaceRow) => number) | null = null;
    try {
      if (m.expr.trim()) test = compile(m.expr, bind).test;
      if (m.agg !== 'count') val = compile(m.of || 'pop', bind).value;
    } catch (err) {
      env.post({ ...empty, error: err instanceof QueryError ? `${err.message} (at ${err.pos + 1})` : String(err) });
      return;
    }
    const steps: number[] = [], values: number[] = [];
    const row: PlaceRow = { S: new Float64Array(0), b: 0, o: 0, year: 0 };
    scan(env, m.stride, (st, step, year) => {
      row.S = st.S; row.year = year;
      let acc = m.agg === 'min' ? Infinity : m.agg === 'max' ? -Infinity : 0, w = 0;
      for (let n = 0; n < st.nSettled; n++) {
        const b = st.settled[n];
        if (!living(st.S[b * NF + F.stage])) continue;
        row.b = b; row.o = b * NF;
        if (test && !test(row)) continue;
        if (m.agg === 'count') { acc++; continue; }
        const v = val!(row);
        if (!Number.isFinite(v)) continue;
        if (m.agg === 'sum') acc += v;
        else if (m.agg === 'min') acc = Math.min(acc, v);
        else if (m.agg === 'max') acc = Math.max(acc, v);
        else { const p = st.S[b * NF + F.pop]; acc += v * p; w += p; }
      }
      if (m.agg === 'mean') acc = w > 0 ? acc / w : NaN;
      if (!Number.isFinite(acc)) acc = NaN;
      steps.push(step); values.push(acc);
    }).then((ok) => {
      if (!ok) { env.post({ ...empty, pending: true }); return; }
      const s = Int32Array.from(steps), v = Float64Array.from(values);
      env.post({ type: 'scan', id: m.id, steps: s, values: v }, [s.buffer, v.buffer]);
    });
  }
}

// ---------------------------------------------------------------- group breakdowns over time

/** The group a settlement belongs to. */
export function groupKey(by: GroupBy, S: Float64Array, o: number, sys: number): number {
  return by === 'faction' ? S[o + F.faction] : by === 'stage' ? S[o + F.stage] : sys;
}

function groups(m: Extract<DataReq, { type: 'groups' }>, env: DataEnv): void {
  const empty = { type: 'groups' as const, id: m.id, by: m.by, steps: new Int32Array(0), keys: [], values: new Float64Array(0), other: new Float64Array(0), total: new Float64Array(0), nGroups: new Int32Array(0) };
  let val: ((r: PlaceRow) => number) | null = null;
  const of = (m.of ?? 'pop').trim() || 'pop';
  if (of !== 'pop' && of !== 'count') {
    try { val = compile(of, placeBinder(env.world)).value; } catch (err) {
      env.post({ ...empty, error: err instanceof QueryError ? `${err.message} (at ${err.pos + 1})` : String(err) });
      return;
    }
  }
  const B = env.world.bodies;
  const steps: number[] = [], per: Map<number, number>[] = [];
  const row: PlaceRow = { S: new Float64Array(0), b: 0, o: 0, year: 0 };
  scan(env, m.stride, (st, step, year) => {
    const acc = new Map<number, number>();
    row.S = st.S; row.year = year;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!living(st.S[o + F.stage])) continue;
      let v: number;
      if (of === 'pop') v = st.S[o + F.pop];
      else if (of === 'count') v = 1;
      else { row.b = b; row.o = o; v = val!(row); if (!Number.isFinite(v)) continue; }
      const k = groupKey(m.by, st.S, o, B[b].system);
      acc.set(k, (acc.get(k) ?? 0) + v);
    }
    steps.push(step); per.push(acc);
  }).then((ok) => {
    if (!ok) { env.post({ ...empty, pending: true }); return; }
    const T = steps.length, total = new Float64Array(T), nGroups = new Int32Array(T);
    const best = new Map<number, number>();
    per.forEach((acc, i) => {
      let t = 0;
      for (const v of acc.values()) t += v;
      total[i] = t; nGroups[i] = acc.size;
      if (t > 0) for (const [k, v] of acc) best.set(k, Math.max(best.get(k) ?? 0, v / t));
    });
    // half the slots for today's biggest, the rest for the biggest ever (the early empires)
    const top = Math.max(1, m.top), lastAcc = per[T - 1] ?? new Map<number, number>();
    const keys = [...lastAcc.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, Math.ceil(top / 2)).map(([k]) => k);
    for (const [k] of [...best.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])) { if (keys.length >= top) break; if (!keys.includes(k)) keys.push(k); }
    if (m.focus !== undefined && best.has(m.focus) && !keys.includes(m.focus)) keys.push(m.focus);
    const K = keys.length, values = new Float64Array(T * K), other = new Float64Array(T);
    per.forEach((acc, i) => {
      let s = 0;
      keys.forEach((k, j) => { const v = acc.get(k) ?? 0; values[i * K + j] = v; s += v; });
      other[i] = total[i] - s;
    });
    const st = Int32Array.from(steps);
    env.post({ type: 'groups', id: m.id, by: m.by, steps: st, keys, values, other, total, nGroups }, [st.buffer, values.buffer, other.buffer, total.buffer, nGroups.buffer]);
  });
}
