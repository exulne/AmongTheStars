// War minds keep no state outside the snapshot: a replay from any snapshot
// must decide exactly as the first run did. Exit 1 if not.
//   node scripts/war-mind-check.ts
import { Engine, type SimState } from '../src/sim/engine.ts';
import { buildWorld } from '../src/sim/world.ts';
import { civParts, HG } from '../src/sim/civ.ts';
import { NetMind } from '../src/ml/netMind.ts';
import { WarNet, randomParams } from '../src/ml/warNet.ts';

const world = buildWorld();
const nets = [1, 2, 3].map((s) => new WarNet(randomParams(s)));
const withMind = (e: Engine, seed: number) => { const m = new NetMind(e, nets, () => 0, seed); m.byYear = (y) => Math.min(2, Math.floor(y / 3400)); e.civ.pol.mind = m; return e; };
let bad = 0;
for (const seed of [1, 2]) {
  const a = withMind(new Engine(world, seed), seed);
  a.logEvents = false;
  let snap: SimState | null = null;
  while (!a.done) { a.step(); if (a.st.step === 640) snap = a.snapshot(); }
  const b = withMind(new Engine(world, seed), seed);
  b.logEvents = false;
  b.restore(snap!);
  while (!b.done) b.step();
  const same = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.prototype.every.call(x, (v: number, i: number) => Object.is(v, y[i]));
  const parts = [['S', a.st.S, b.st.S] as const, ...civParts(a.st.hx).map(([k, v], i) => [k, v, civParts(b.st.hx)[i][1]] as const)];
  const diff = parts.filter(([, x, y]) => !same(x, y)).map(([k]) => k);
  console.log(`seed ${seed}: ${a.st.hx.hg[HG.nWar]} wars; replay from step 640 ${diff.length ? 'DIFFERS in ' + diff.join(', ') : 'identical'}`);
  if (diff.length) bad++;
}
process.exit(bad ? 1 : 0);
