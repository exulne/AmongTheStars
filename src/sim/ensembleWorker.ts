// Other futures, run in the background: the same rules with different dice,
// global series only (no people, no event log), so every chart can show where
// this future sits among its siblings.

import { Engine } from './engine.ts';
import { buildWorld } from './world.ts';
import { NetMind } from '../ml/netMind.ts';
import { loadWarGens, type WarGens } from '../ml/warGens.ts';

export type ToEnsemble = { type: 'run'; seeds: number[]; token: number };
export type FromEnsemble = { type: 'future'; token: number; seed: number; series: Float64Array };

const world = buildWorld();
let token = 0;

// the same trained war minds as the main run, so siblings are comparable
let gens: WarGens | null = null;
const ready = loadWarGens().catch(() => null).then((g) => { gens = g; });

self.onmessage = (ev: MessageEvent<ToEnsemble>) => { void ready.then(() => play(ev.data)); };

function play(m: ToEnsemble): void {
  token = m.token;
  const queue = [...m.seeds];
  const next = () => {
    if (m.token !== token || !queue.length) return;
    const seed = queue.shift()!;
    const e = new Engine(world, seed);
    e.ledger = null;
    e.logEvents = false;
    if (gens) { const mind = new NetMind(e, gens.nets, () => 0, seed); mind.byYear = gens.genAt; e.civ.pol.mind = mind; }
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
}
