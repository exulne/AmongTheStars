// Runs the simulation off the main thread. Streams the global series while it
// runs, keeps full snapshots every SNAP_EVERY steps, and answers "what did the
// universe look like at year Y" by replaying from the nearest snapshot.

import { EV } from './catalog.ts';
import { Engine, type SimState } from './engine.ts';
import { HIST_FIELDS, NGM } from './metrics.ts';
import { buildWorld } from './world.ts';

const SNAP_EVERY = 20;
// event types whose `a` is a second body (source, opponent, old capital); elsewhere it is a stage, tech or era index
const A_IS_BODY = new Set([EV['Colony founded'], EV.War, EV.Independence, EV['Mutiny in transit'], EV['Ship lost']]);

export type ToWorker =
  | { type: 'run'; seed: number }
  | { type: 'state'; id: number; step: number }
  | { type: 'history'; id: number; body: number }
  | { type: 'events'; id: number; fromYear: number; toYear: number; body?: number; limit?: number };

export type FromWorker =
  | { type: 'progress'; seed: number; step: number; years: number[]; series: Float64Array; done: boolean; ms: number }
  | { type: 'state'; id: number; step: number; S: Float64Array; techDone: Float64Array; ships: ReturnType<Engine['shipList']>; globals: ReturnType<Engine['globals']>; settled: Int32Array }
  | { type: 'history'; id: number; body: number; steps: number[]; cols: Record<string, number[]> }
  | { type: 'events'; id: number; events: Engine['events'] };

const world = buildWorld();
let main: Engine | null = null;
let replay: Engine | null = null;
let snaps: SimState[] = [];
let runToken = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function run(seed: number): void {
  const token = ++runToken;
  main = new Engine(world, seed);
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
