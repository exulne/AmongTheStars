// Other futures, run in the background: the same rules with different dice,
// global series only (no people, no event log), so every chart can show where
// this future sits among its siblings.

import { Engine } from './engine.ts';
import { buildWorld } from './world.ts';

export type ToEnsemble = { type: 'run'; seeds: number[]; token: number };
export type FromEnsemble = { type: 'future'; token: number; seed: number; series: Float64Array };

const world = buildWorld();
let token = 0;

self.onmessage = (ev: MessageEvent<ToEnsemble>) => {
  const m = ev.data;
  token = m.token;
  const queue = [...m.seeds];
  const next = () => {
    if (m.token !== token || !queue.length) return;
    const seed = queue.shift()!;
    const e = new Engine(world, seed);
    e.ledger = null;
    e.logEvents = false;
    const go = () => {
      if (m.token !== token) return;
      const until = performance.now() + 40;
      while (!e.done && performance.now() < until) e.step();
      if (!e.done) { setTimeout(go, 0); return; }
      const series = e.series.slice();
      (self as unknown as Worker).postMessage({ type: 'future', token: m.token, seed, series } satisfies FromEnsemble, [series.buffer]);
      setTimeout(next, 0);
    };
    go();
  };
  next();
};
