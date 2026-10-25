// A worker that plays one seed until a goal is reached (or the future ends),
// with the same trained war minds as the main run so the future you are shown
// is the future the card describes. Answers in ~40 ms slices so a cancel, or a
// newer search, is honoured quickly.

import { Engine } from './engine.ts';
import { buildWorld } from './world.ts';
import { NetMind } from '../ml/netMind.ts';
import { loadWarGens, type WarGens } from '../ml/warGens.ts';
import { ChainTracker, resultOf, type Chain, type FutureResult } from './milestones.ts';

export type ToPaths = { type: 'find'; chain: Chain; seed: number; token: number } | { type: 'cancel'; token: number };
export type FromPaths = { type: 'result'; token: number; result: FutureResult };

const world = buildWorld();
let token = -1;

// the same trained war minds as the main run, so siblings are comparable
let gens: WarGens | null = null;
const ready = loadWarGens().catch(() => null).then((g) => { gens = g; });

self.onmessage = (ev: MessageEvent<ToPaths>) => { void ready.then(() => onMsg(ev.data)); };

function onMsg(m: ToPaths): void {
  if (m.type === 'cancel') { token = -1; return; } // whatever is running now is stale
  token = m.token;
  const e = new Engine(world, m.seed);
  e.ledger = null;
  if (gens) { const mind = new NetMind(e, gens.nets, () => 0, m.seed); mind.byYear = gens.genAt; e.civ.pol.mind = mind; }
  const tr = new ChainTracker(m.chain, e);
  const go = () => {
    if (m.token !== token) return; // cancelled or replaced by a newer search
    const until = performance.now() + 40;
    while (!e.done && !tr.done && performance.now() < until) tr.advance();
    if (!e.done && !tr.done) { setTimeout(go, 0); return; }
    const result = resultOf(m.chain, e, tr);
    (self as unknown as Worker).postMessage({ type: 'result', token: m.token, result } satisfies FromPaths, [result.spark.years.buffer, result.spark.pop.buffer]);
  };
  go();
}
