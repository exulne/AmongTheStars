// Run the whole simulation in Node and print a summary. Used for tuning.
import { Engine, YEAR0 } from '../src/sim/engine.ts';
import { ERAS, EVENT_NAMES, STAGE_NAMES, TECHS } from '../src/sim/catalog.ts';
import { GM, NGM, F, NF } from '../src/sim/metrics.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 1);
const t0 = performance.now();
const world = buildWorld();
const t1 = performance.now();
const e = new Engine(world, seed);
while (!e.done) e.step();
const t2 = performance.now();
console.log(`world ${world.systems.length} systems ${world.bodies.length} bodies in ${(t1 - t0).toFixed(0)}ms; sim ${e.years.length} steps in ${(t2 - t1).toFixed(0)}ms; events ${e.events.length}; hist rows ${e.histLen}`);
const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : x.toFixed(2));
const cols = ['pop', 'offEarth', 'interstellarPop', 'settlements', 'systems', 'surveyed', 'reach', 'energy', 'kardashev', 'gdp', 'research', 'techs', 'stability', 'factions', 'wars', 'shipsInTransit', 'shortage', 'era'];
console.log(['year', ...cols].join('\t'));
for (const y of [0, 10, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000]) {
  const i = e.years.findIndex((x) => x >= y);
  const row = e.series.subarray(i * NGM, i * NGM + NGM);
  console.log([YEAR0 + e.years[i], ...cols.map((c) => c === 'era' ? ERAS[row[GM.era]] : fmt(row[GM[c]]))].join('\t'));
}
const tech = TECHS.map((t, i) => [t.name, e.st.techDone[i]] as const).filter(([, y]) => y >= 0).map(([n, y]) => `${YEAR0 + y} ${n}`);
console.log('\nTECH:', tech.join(' | '));
const counts: Record<string, number> = {};
for (const ev of e.events) counts[EVENT_NAMES[ev.type]] = (counts[EVENT_NAMES[ev.type]] ?? 0) + 1;
console.log('\nEVENTS:', JSON.stringify(counts));
const stages: Record<string, number> = {};
for (let n = 0; n < e.st.nSettled; n++) { const s = e.st.S[e.st.settled[n] * NF + F.stage]; stages[STAGE_NAMES[s]] = (stages[STAGE_NAMES[s]] ?? 0) + 1; }
console.log('STAGES at end:', JSON.stringify(stages));
const top = [...e.st.settled.slice(0, e.st.nSettled)].sort((a, b) => e.st.S[b * NF + F.pop] - e.st.S[a * NF + F.pop]).slice(0, 12);
console.log('TOP:', top.map((b) => `${world.bodies[b].name}=${fmt(e.st.S[b * NF + F.pop])}`).join(', '));
