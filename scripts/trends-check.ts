// Checks buildTrends in Node: edges, the migration tallies against the raw
// ledger, hotspot sanity, and that shocks count every event of their types —
// with faith events never entering the payload.
//   node scripts/trends-check.ts [seed]
import { EV } from '../src/sim/catalog.ts';
import { Engine } from '../src/sim/engine.ts';
import { FLOW, NPERIODS, isShipBody } from '../src/sim/ledger.ts';
import { buildTrends } from '../src/sim/trends.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 7);
const main = new Engine(buildWorld(), seed);
const t0 = performance.now();
while (!main.done) main.step();
console.log(`seed ${seed}: ${main.st.step} steps in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const t = buildTrends(main);
let bad = 0;
const ok = (cond: boolean, what: string) => { if (!cond) { bad++; console.log(`FAIL ${what}`); } };
ok(!!t, 'buildTrends returned null');
if (!t) process.exit(1);

ok(t.edges.length === NPERIODS + 1, `edges length ${t.edges.length}`);
let incr = true;
for (let i = 1; i < t.edges.length; i++) if (t.edges[i] <= t.edges[i - 1]) incr = false;
ok(incr, 'edges strictly increasing');

let want = 0;
for (const f of main.ledger!.flows) if (f.kind !== FLOW.LANDING) want += f.n;
const got = t.moved.reduce((a, b) => a + b, 0);
ok(Math.abs(got - want) / Math.max(1, want) < 1e-6, `sum(moved) ${got} vs ledger ${want}`);
ok(t.lost.every((v, p) => v <= t.moved[p]), 'lost[p] <= moved[p]');

const perP = new Map<number, number>();
let badHot = 0;
for (const h of t.hot) {
  perP.set(h.p, (perP.get(h.p) ?? 0) + 1);
  if (h.body < 0 || isShipBody(h.body) || h.body >= main.world.bodies.length || !(h.n > 0)) badHot++;
}
ok(badHot === 0, `hot bodies valid, non-ship, n > 0 (${badHot} bad)`);
ok([...perP.values()].every((n) => n <= 3), 'at most 3 hot per period');

const FAITH = new Set([EV['New faith'], EV.Schism, EV['AI schism']]);
for (const c of t.shocks) {
  ok(!c.types.some((x) => FAITH.has(x)), `${c.key}: no faith types`);
  const want = new Set(c.types);
  let cnt = 0;
  for (const ev of main.events) if (want.has(ev.type) && ev.year <= t.upTo) cnt++;
  const sum = c.counts.reduce((a, b) => a + b, 0);
  ok(sum === cnt, `${c.key}: counts sum ${sum} vs ${cnt} events`);
  ok(c.top.length <= 8 && c.top.every((p, i) => i === 0 || c.top[i - 1].n >= p.n), `${c.key}: top sorted, <= 8`);
}

ok(!/faith/i.test(JSON.stringify(t)), 'payload mentions no faith');

console.log(`  ${t.hot.length} hot entries; top 3: ${[...t.hot].sort((a, b) => b.n - a.n).slice(0, 3).map((h) => `${main.world.bodies[h.body].name} ${Math.round(h.n)}`).join('; ')}`);
for (const c of t.shocks) console.log(`  ${c.key}: top ${c.top.slice(0, 2).map((p) => `${p.label} ×${p.n} @${Math.round(2040 + p.year)}`).join('; ') || 'none'}`);
console.log(bad ? `${bad} trends checks failed` : 'trends: all checks ok');
process.exit(bad ? 1 : 0);
