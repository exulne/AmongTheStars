// Quick look at one run's demography, energy and economy: Earth, Mars and the world.
//   node scripts/demo-check.ts [seed=1]
import { Engine, YEAR0 } from '../src/sim/engine.ts';
import { F, GM, NF, NGM } from '../src/sim/metrics.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 1);
const world = buildWorld();
const e = new Engine(world, seed);
const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : x.toFixed(2));
const marks = [0, 5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 750, 1000, 2000, 5000, 9990];
const cols = ['pop', 'births', 'deaths', 'tfr', 'lifeExp', 'medianAge', 'gdp', 'energy', 'capacity'] as const;
const show = (name: string, b: number) => console.log(name.padEnd(6), ...cols.map((c) => `${c}=${fmt(e.st.S[b * NF + F[c]])}`), `gdppc=${fmt(e.st.S[b * NF + F.gdp] / Math.max(1, e.st.S[b * NF + F.pop]))}`);
const extra = process.argv.slice(3);
while (!e.done) {
  const y = e.years[e.st.step];
  if (marks.includes(y)) {
    const r = e.series.subarray(e.st.step * NGM, e.st.step * NGM + NGM);
    console.log(`--- ${YEAR0 + y}  world pop ${fmt(r[GM.pop])} LE ${fmt(r[GM.lifeExp])} TFR ${fmt(r[GM.tfr])} median ${fmt(r[GM.medianAge])} gdp ${fmt(r[GM.gdp])} energy ${fmt(r[GM.energy])} K ${fmt(r[GM.kardashev])}` + extra.map((k) => ` ${k} ${fmt(r[GM[k]])}`).join(''));
    show('Earth', world.earth); show('Mars', world.mars);
  }
  e.step();
}
