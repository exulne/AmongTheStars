// Checks the worker's data desk in Node: tables, query scans by replay (they
// must agree with the saved snapshots), and the analyst summaries.
//   node scripts/data-check.ts [seed]
import { handleData, type DataEnv, type DataReq, type DataRes } from '../src/sim/dataApi.ts';
import { Engine, type SimState } from '../src/sim/engine.ts';
import { F, NF } from '../src/sim/metrics.ts';
import { MC, NMC } from '../src/sim/launchEconomics.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 7);
const world = buildWorld();
const main = new Engine(world, seed);
const snaps: SimState[] = [main.snapshot()];
const t0 = performance.now();
while (!main.done) { main.step(); if (main.st.step % 20 === 0) snaps.push(main.snapshot()); }
console.log(`seed ${seed}: ${main.st.step} steps in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const replay = new Engine(world, seed);
replay.logEvents = false;
const stateAt = (step: number): Engine => {
  if (step >= main.st.step) return main;
  replay.restore(snaps[Math.floor(step / 20)]);
  while (replay.st.step < step) replay.step();
  return replay;
};
let wait: ((m: DataRes) => void) | null = null;
const env: DataEnv = { world, main: () => main, snaps: () => snaps, stateAt, post: (m) => wait?.(m) };
let nextId = 1;
function ask<T extends DataRes['type']>(req: Omit<Extract<DataReq, { type: T }>, 'id'>): Promise<Extract<DataRes, { type: T }>> {
  return new Promise((res) => {
    const id = nextId++;
    wait = (m) => { if (m.id === id) res(m as Extract<DataRes, { type: T }>); };
    handleData({ ...req, id } as DataReq, env);
  });
}

let bad = 0;
const ok = (cond: boolean, what: string) => { if (!cond) { bad++; console.log(`FAIL ${what}`); } };

// table: every living place, full rows
const last = main.st.step;
const tbl = await ask<'table'>({ type: 'table', step: last });
ok(tbl.bodies.length > 10 && tbl.rows.length === tbl.bodies.length * NF, 'table shape');
let popSum = 0;
for (let i = 0; i < tbl.bodies.length; i++) popSum += tbl.rows[i * NF + F.pop];
ok(popSum > 1e9, `table population ${popSum.toExponential(2)}`);
let cult = 0;
for (let i = 0; i < tbl.bodies.length; i++) if (!Number.isNaN(tbl.rows[i * NF + F.culture])) cult++;
ok(cult === 0, `table: culture column is NaN in every row (${cult} non-NaN)`);

// scans: the snapshot fast path and the replay path must agree where they overlap
const fast = await ask<'scan'>({ type: 'scan', expr: 'stage >= 4', agg: 'count', stride: 20 });
const slow = await ask<'scan'>({ type: 'scan', expr: 'stage >= 4', agg: 'count', stride: 5 });
ok(!fast.error && !slow.error && fast.steps.length > 50, `scan shapes ${fast.steps.length} ${slow.steps.length} ${fast.error ?? ''}${slow.error ?? ''}`);
const at = new Map(Array.from(slow.steps, (s, i) => [s, slow.values[i]]));
let mismatch = 0;
fast.steps.forEach((s, i) => { if (at.has(s) && at.get(s) !== fast.values[i]) mismatch++; });
ok(mismatch === 0, `replay disagrees with snapshots at ${mismatch} steps`);
const sum = await ask<'scan'>({ type: 'scan', expr: '', agg: 'sum', of: 'pop', stride: 20 });
ok(Math.abs(sum.values[sum.values.length - 1] - popSum) / popSum < 1e-9, 'sum(pop) at the end matches the table');
const err = await ask<'scan'>({ type: 'scan', expr: 'pop >', agg: 'count', stride: 20 });
ok(!!err.error, 'a bad query reports an error');

// groups: the top groups plus everyone else add up to the total, which is sum(pop)
for (const by of ['faction', 'system', 'stage'] as const) {
  const g = await ask<'groups'>({ type: 'groups', by, stride: 20, top: 8 });
  const K = g.keys.length, T = g.steps.length;
  let worst = 0;
  for (let i = 0; i < T; i++) {
    let s = g.other[i];
    for (let j = 0; j < K; j++) s += g.values[i * K + j];
    worst = Math.max(worst, Math.abs(s - g.total[i]) / (g.total[i] || 1));
  }
  ok(T === sum.steps.length && worst < 1e-9 && Math.abs(g.total[T - 1] - popSum) / popSum < 1e-9, `groups by ${by}: ${K} keys, closure ${worst}`);
  if (by === 'faction') console.log(`  ${g.nGroups[T - 1]} factions at the end; top shares: ${g.keys.slice(0, 4).map((k, j) => `${world.bodies[k].name} ${(g.values[(T - 1) * K + j] / g.total[T - 1] * 100).toFixed(1)}%`).join(', ')}`);
}
const gf = await ask<'groups'>({ type: 'groups', by: 'faction', stride: 20, top: 2, focus: world.mars });
ok(gf.keys.includes(world.mars), 'groups focus key is included');
const gx = await ask<'groups'>({ type: 'groups', by: 'stage', of: 'gdp / pop', stride: 20, top: 3 });
ok(!gx.error && gx.keys.length === 3, `groups over an expression ${gx.error ?? ''}`);

// place history: every field of a few places; the end matches the table
const ph = await ask<'place'>({ type: 'place', bodies: [world.mars, world.earth, tbl.bodies[tbl.bodies.length - 1]], stride: 20 });
const lastRow = (ph.steps.length - 1) * ph.bodies.length;
const j = tbl.bodies.indexOf(world.mars);
ok(!ph.pending && ph.steps.length === sum.steps.length && ph.rows[(lastRow + 0) * NF + F.pop] === tbl.rows[j * NF + F.pop], 'place history: Mars at the end matches the table');
ok(Number.isNaN(ph.rows[(0 * 3 + 2) * NF + F.pop]), 'place history: NaN before a place is settled');
const ph4 = await ask<'place'>({ type: 'place', bodies: [world.mars], stride: 4 });
ok(ph4.steps.length > ph.steps.length * 4, `place history by replay: ${ph4.steps.length} points`);

// launch economics: the records come back as copies, and asking leaves the engine as it was
const nBefore = main.missions.n, firstBefore = main.missions.rows[MC.total];
const ms = await ask<'missions'>({ type: 'missions', year: 10000 });
ok(ms.rows.length === nBefore * NMC && ms.scenario === 'baseline' && ms.done, `missions: ${ms.rows.length / NMC} records`);
const mid = await ask<'missions'>({ type: 'missions', year: 200 });
ok(mid.rows.length < ms.rows.length && Array.from({ length: mid.rows.length / NMC }, (_, i) => mid.rows[i * NMC + MC.year]).every((y) => y <= 200), 'missions up to a year stop at that year');
const one = await ask<'mission'>({ type: 'mission', mission: ms.rows[MC.id] });
ok(!!one.row && one.row[MC.total] === ms.rows[MC.total], 'one mission by id matches the list');
ms.rows.fill(-1);
ok(main.missions.n === nBefore && main.missions.rows[MC.total] === firstBefore, 'asking for missions does not touch the engine');

console.log(bad ? `${bad} data checks failed` : 'data: all checks ok');
process.exit(bad ? 1 : 0);
