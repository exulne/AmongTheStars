// Runs the simulation off the main thread. Streams the global series while it
// runs, keeps full snapshots every SNAP_EVERY steps, and answers "what did the
// universe look like at year Y" by replaying from the nearest snapshot.

import { EV } from './catalog.ts';
import { Engine, type SimState } from './engine.ts';
import { HIST_FIELDS, NGM } from './metrics.ts';
import { Chronicle, type Entry } from './chronicle.ts';
import { Lives, type Biography, type PersonBrief } from './lives.ts';
import { SocietyModel, type Society } from './society.ts';
import { buildWorld } from './world.ts';
import { periodOf } from './ledger.ts';

const SNAP_EVERY = 20;
// event types whose `a` is a second body (source, opponent, old capital); elsewhere it is a stage, tech or era index
const A_IS_BODY = new Set([EV['Colony founded'], EV.War, EV.Independence, EV['Mutiny in transit'], EV['Ship lost'], EV['Ship launched'], EV['Ship arrived']]);

export type ToWorker =
  | { type: 'run'; seed: number }
  | { type: 'state'; id: number; step: number }
  | { type: 'history'; id: number; body: number }
  | { type: 'events'; id: number; fromYear: number; toYear: number; body?: number; limit?: number }
  | { type: 'residents'; id: number; body: number; year: number; offset: number; count: number }
  | { type: 'person'; id: number; person: string; year: number }
  | { type: 'residentAt'; id: number; body: number; year: number; k: number }
  | { type: 'chronicle'; id: number; from: number; to: number; body?: number; query?: string; limit?: number; minWeight?: number }
  | { type: 'inventions'; id: number }
  | { type: 'society'; id: number; body: number; step: number };

export type FromWorker =
  | { type: 'progress'; seed: number; step: number; years: number[]; series: Float64Array; done: boolean; ms: number }
  | { type: 'state'; id: number; step: number; S: Float64Array; techDone: Float64Array; ships: ReturnType<Engine['shipList']>; globals: ReturnType<Engine['globals']>; settled: Int32Array }
  | { type: 'history'; id: number; body: number; steps: number[]; cols: Record<string, number[]> }
  | { type: 'events'; id: number; events: Engine['events'] }
  | { type: 'residents'; id: number; pending?: boolean; total: number; asOf: number; offset: number; people: PersonBrief[]; pyramid: { band: number; women: number; men: number }[] }
  | { type: 'person'; id: number; pending?: boolean; bio: Biography | null }
  | { type: 'residentAt'; id: number; pending?: boolean; person: string | null }
  | { type: 'chronicle'; id: number; pending?: boolean; entries: Entry[] }
  | { type: 'inventions'; id: number; pending?: boolean; list: { tech: number; year: number; entry: Entry | null }[] }
  | { type: 'society'; id: number; pending?: boolean; society: Society | null };

const world = buildWorld();
let main: Engine | null = null;
let replay: Engine | null = null;
let snaps: SimState[] = [];
let runToken = 0;
let lives: Lives | null = null;
let chron: Chronicle | null = null;
let society: SocietyModel | null = null;
/** People need the whole ledger (and every event) of the run, so they wait for it to finish. */
function people(): Lives | null {
  if (!main || !main.done) return null;
  if (!lives) {
    lives = new Lives(main);
    const c = (chron = new Chronicle(main, lives));
    society = new SocietyModel(main, (b, n) => lives!.coinedWord(b, n));
    society.faithInfo = (f) => ({ name: c.faithName(f), tenets: c.tenetsOf(f) });
    const civ = main.civ;
    lives.faithAt = (b, year, u) => {
      for (const [f, sh] of civ.faithsAt(b, periodOf(year))) { if (u < sh) return c.faithName(f); u -= sh; }
      return null;
    };
    lives.deeds = (pid, stays) => c.deedsOf(pid, stays).map((en) => ({ year: en.year, text: en.segs.map((s) => (typeof s === 'string' ? s : s.t)).join('') }));
  }
  return lives;
}

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function run(seed: number): void {
  const token = ++runToken;
  main = new Engine(world, seed);
  lives = null; chron = null; society = null;
  replay = new Engine(world, seed);
  replay.logEvents = false;
  snaps = [main.snapshot()];
  const t0 = performance.now();
  let sent = 0;
  const chunk = () => {
    if (token !== runToken || !main) return;
    const tEnd = performance.now() + 30;
    while (!main.done && performance.now() < tEnd) {
      main.step();
      if (main.st.step % SNAP_EVERY === 0) snaps.push(main.snapshot());
    }
    // row k is written when the engine reaches step k, so rows 0..step are complete
    const complete = main.st.step + 1;
    const series = main.series.slice(sent * NGM, complete * NGM);
    post({ type: 'progress', seed, step: complete - 1, years: main.years, series, done: main.done, ms: performance.now() - t0 }, [series.buffer]);
    sent = complete;
    if (!main.done) setTimeout(chunk, 0);
  };
  chunk();
}

function stateAt(step: number): Engine {
  if (!main || !replay) throw new Error('not running');
  step = Math.min(step, main.st.step);
  if (step === main.st.step) return main;
  if (replay.st.step !== step) {
    const snap = snaps[Math.floor(step / SNAP_EVERY)];
    if (replay.st.step > step || replay.st.step < snap.step) replay.restore(snap);
    while (replay.st.step < step) replay.step();
  }
  return replay;
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'run') run(m.seed);
  else if (m.type === 'state') {
    const e = stateAt(m.step);
    const S = e.st.S.slice();
    const techDone = e.st.techDone.slice();
    const settled = e.st.settled.slice(0, e.st.nSettled);
    post({ type: 'state', id: m.id, step: e.st.step, S, techDone, ships: e.shipList(), globals: e.globals(), settled }, [S.buffer, techDone.buffer, settled.buffer]);
  } else if (m.type === 'history' && main) {
    const w = 2 + HIST_FIELDS.length;
    const steps: number[] = [];
    const cols: Record<string, number[]> = Object.fromEntries(HIST_FIELDS.map((f) => [f, [] as number[]]));
    for (let i = 0; i < main.histLen; i++) {
      if (main.hist[i * w + 1] !== m.body) continue;
      steps.push(main.hist[i * w]);
      HIST_FIELDS.forEach((f, k) => cols[f].push(main!.hist[i * w + 2 + k]));
    }
    post({ type: 'history', id: m.id, body: m.body, steps, cols });
  } else if (m.type === 'residents') {
    const L = people();
    if (!L) post({ type: 'residents', id: m.id, pending: true, total: 0, asOf: m.year, offset: 0, people: [], pyramid: [] });
    else post({ type: 'residents', id: m.id, ...L.residents(m.body, m.year, m.offset, m.count) });
  } else if (m.type === 'person') {
    const L = people();
    post({ type: 'person', id: m.id, pending: !L, bio: L ? L.biography(m.person, m.year) : null });
  } else if (m.type === 'residentAt') {
    const L = people();
    post({ type: 'residentAt', id: m.id, pending: !L, person: L ? L.residentAt(m.body, m.year, m.k) : null });
  } else if (m.type === 'chronicle') {
    const ok = people() && chron;
    post({ type: 'chronicle', id: m.id, pending: !ok, entries: ok ? chron!.list(m.from, m.to, { body: m.body, query: m.query, limit: m.limit, minWeight: m.minWeight }) : [] });
  } else if (m.type === 'society') {
    const ok = people() && society;
    if (!ok) post({ type: 'society', id: m.id, pending: true, society: null });
    else {
      const e = stateAt(m.step);
      post({ type: 'society', id: m.id, society: society!.at(m.body, e.years[e.st.step], e.st.S, e.st.techDone, e.st.g[1], e.st.hx) });
    }
  } else if (m.type === 'inventions') {
    const ok = people() && chron;
    post({ type: 'inventions', id: m.id, pending: !ok, list: ok ? chron!.inventions() : [] });
  } else if (m.type === 'events' && main) {
    const out: Engine['events'] = [];
    const limit = m.limit ?? 200;
    for (let i = main.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = main.events[i];
      if (e.year > m.toYear || e.year < m.fromYear) continue;
      if (m.body !== undefined && e.body !== m.body && !(e.a === m.body && A_IS_BODY.has(e.type))) continue;
      out.push(e);
    }
    post({ type: 'events', id: m.id, events: out });
  }
};
