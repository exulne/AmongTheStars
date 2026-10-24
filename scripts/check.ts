// World checker: runs many seeds headless, asserts invariants, prints the
// spread of milestones across seeds. Exit code 1 on any invariant failure.
//   node scripts/check.ts [seeds=30] [firstSeed=1] [--det=3] [--serial]
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Engine, YEAR0, type SimState } from '../src/sim/engine.ts';
import { ERAS, EVENT_NAMES, STAGE, TECHS, isAlive } from '../src/sim/catalog.ts';
import { F, GM, NF, NGM } from '../src/sim/metrics.ts';
import { buildWorld, type World } from '../src/sim/world.ts';
import { civParts } from '../src/sim/civ.ts';

const SNAP_EVERY = 20; // same as the worker
const LIVING = isAlive;
const techAt = (id: string) => TECHS.findIndex((t) => t.id === id);

interface SeedResult {
  seed: number; ms: number; fails: string[];
  tech: Record<string, number>;            // calendar year or NaN
  firstStar: number; firstStarColony: number;
  popAt: Record<number, number>; offAt: Record<number, number>;
  marsAt2100: number; marsBiggest2140: boolean; earthMin: number; earthMinYear: number;
  reach: number; systems: number; kardashev: number; k1: number; k2: number; wars: number; factions: number;
  eraYears: number[]; longestDark: number; longestWar: number; events: Record<string, number>; finalPop: number;
  churn: number; maxPopGrowth: number;
  earthPeak: number; earthPeakYear: number; le: Record<number, number>; medAge2100: number; growth2100: number; growth2300: number;
}

function eq(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

function sameState(a: SimState, b: SimState): string | null {
  if (a.step !== b.step) return `step ${a.step} vs ${b.step}`;
  if (a.nSettled !== b.nSettled) return `nSettled ${a.nSettled} vs ${b.nSettled}`;
  const parts: [string, ArrayLike<number>, ArrayLike<number>][] = [
    ['S', a.S, b.S], ['g', a.g, b.g], ['techProg', a.techProg, b.techProg], ['techDone', a.techDone, b.techDone],
    ['ships', a.ships, b.ships], ['shipRetry', a.shipRetry, b.shipRetry], ['ages', a.ages, b.ages], ['swarm', a.swarm, b.swarm], ['settled', a.settled.subarray(0, a.nSettled), b.settled.subarray(0, b.nSettled)], ['rng', a.rng, b.rng],
  ];
  const ca = civParts(a.hx), cb = civParts(b.hx);
  ca.forEach(([name, x], k) => parts.push([name, x, cb[k][1]]));
  for (const [name, x, y] of parts) {
    const i = eq(x, y);
    if (i !== -1) return name === 'S' && i >= 0 ? `S[body ${Math.floor(i / NF)} field ${i % NF}] ${x[i]} vs ${y[i]}` : `${name}[${i}] ${x[i]} vs ${y[i]}`;
  }
  return null;
}

function runSeed(world: World, seed: number, det: boolean): SeedResult {
  const fails: string[] = [];
  const fail = (m: string) => { if (fails.length < 12) fails.push(m); };
  let simMs = 0;
  const e = new Engine(world, seed);
  const earth = world.earth, mars = world.mars;
  const nT = TECHS.length;
  const prevTech = new Float64Array(nT).fill(-1);
  const prevShip = new Map<string, number>();
  let earthPeak = 0, earthPeakYear = 0;
  let earthMin = Infinity, earthMinYear = 0, firstStarColony = NaN, marsAt2100 = NaN, marsBiggest2140 = false;
  // replay checkpoints: snapshot at a multiple of SNAP_EVERY, compare a few steps later
  const checkFrom = [2, 17, 43, 61].map((k) => k * SNAP_EVERY).filter((s) => s < e.years.length - 30);
  const pending = new Map<number, SimState>();
  const targets = new Map<number, { from: number; snap: SimState }>();
  let lastLiving = new Uint8Array(world.bodies.length);
  const everLived = new Uint8Array(world.bodies.length);
  let churn = 0;

  while (!e.done) {
    const step = e.st.step;
    if (checkFrom.includes(step)) {
      const snap = e.snapshot();
      const to = step + 1 + ((seed * 7 + step) % (SNAP_EVERY - 1));
      targets.set(to, { from: step, snap });
    }
    const tg = targets.get(step);
    if (tg) pending.set(step, e.snapshot());
    const ts = performance.now();
    e.step();
    simMs += performance.now() - ts;
    const st = e.st, S = st.S, y = e.years[st.step - 1];

    // techs never un-research, and never date from the future
    for (let i = 0; i < nT; i++) {
      const d = st.techDone[i];
      if (prevTech[i] >= 0 && d !== prevTech[i]) fail(`tech ${TECHS[i].id} changed ${prevTech[i]} -> ${d} at ${y}`);
      if (d > y) fail(`tech ${TECHS[i].id} done in future ${d} > ${y}`);
      if (d >= 0 && YEAR0 + d < TECHS[i].earliest - 0.25 * (TECHS[i].earliest - YEAR0)) fail(`tech ${TECHS[i].id} landed in ${YEAR0 + d}, before its floor`);
      if (d >= 0) for (const r of TECHS[i].req) if (st.techDone[techAt(r)] < 0 || st.techDone[techAt(r)] > d) fail(`tech ${TECHS[i].id} before prerequisite ${r}`);
      prevTech[i] = d;
    }
    // settlements
    let living = 0, survey = 0, nonNone = 0, earthPop = 0;
    const seen = new Set<number>();
    const nowLiving = new Uint8Array(world.bodies.length);
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (seen.has(b)) fail(`body ${b} listed twice in settled`);
      seen.add(b);
      if (!Number.isInteger(stg) || stg < STAGE.SURVEY || stg > STAGE.DEAD) fail(`body ${b} bad stage ${stg} at ${y}`);
      if (stg !== STAGE.NONE) nonNone++;
      if (LIVING(stg)) {
        living++; nowLiving[b] = 1;
        if (!lastLiving[b] && everLived[b]) churn++;
        everLived[b] = 1;
        if (stg >= STAGE.COLONY && Number.isNaN(firstStarColony) && world.bodies[b].system !== 0) firstStarColony = YEAR0 + y;
      }
      if (stg === STAGE.SURVEY) survey++;
      for (let k = 0; k < NF; k++) {
        const v = S[o + k];
        if (!Number.isFinite(v)) { fail(`body ${b} field ${k} = ${v} at ${y}`); break; }
      }
      for (const k of [F.pop, F.water, F.metals, F.volatiles, F.rare, F.he3, F.capital, F.energy, F.gdp]) {
        if (S[o + k] < 0) fail(`body ${b} field ${k} negative ${S[o + k]} at ${y}`);
      }
      if (!LIVING(stg) && S[o + F.pop] > 0) fail(`body ${b} stage ${stg} has pop ${S[o + F.pop]} at ${y}`);
      if (b === earth) earthPop = S[o + F.pop];
    }
    lastLiving = nowLiving;
    if (nonNone !== st.nSettled) fail(`nSettled ${st.nSettled} but ${nonNone} non-NONE`);
    if (step % 50 === 0) {
      for (let i = 0; i < S.length; i++) if (!Number.isFinite(S[i])) { fail(`S[${i}] = ${S[i]} at ${y}`); break; }
      for (let b = 0; b < world.bodies.length; b++) if (S[b * NF + F.stage] !== STAGE.NONE && !seen.has(b)) { fail(`body ${b} has stage but is not in settled`); break; }
    }
    for (let i = 0; i < st.g.length; i++) if (!Number.isFinite(st.g[i])) fail(`g[${i}] = ${st.g[i]} at ${y}`);
    const row = e.series.subarray(st.step * NGM, (st.step + 1) * NGM);
    for (let k = 0; k < NGM; k++) if (!Number.isFinite(row[k])) fail(`series col ${k} = ${row[k]} at ${y}`);
    if (row[GM.settlements] !== living) fail(`series settlements ${row[GM.settlements]} vs ${living} living at ${y}`);
    if (row[GM.surveyed] !== survey) fail(`series surveyed ${row[GM.surveyed]} vs ${survey} at ${y}`);
    if (row[GM.pop] < 0 || row[GM.offEarth] > row[GM.pop] * (1 + 1e-9) || row[GM.interstellarPop] > row[GM.offEarth] * (1 + 1e-9)) fail(`population nesting broken at ${y}`);
    if (row[GM.era] !== e.globals().eraIndex) fail(`series era ${row[GM.era]} vs state era ${e.globals().eraIndex} at step ${st.step}`);
    if (!Number.isInteger(row[GM.era]) || row[GM.era] < 0 || row[GM.era] >= ERAS.length) fail(`bad era ${row[GM.era]} at ${y}`);
    // ships
    for (const s of e.shipList()) {
      if (!(s.arrive > s.depart)) fail(`ship ${s.from}->${s.to} arrives ${s.arrive} before departing ${s.depart}`);
      if (s.depart > y) fail(`ship departs in the future ${s.depart} > ${y}`);
      if (s.arrive < y) fail(`ship ${s.from}->${s.to} overdue: arrive ${s.arrive} < ${y}`);
      if (!(s.colonists > 0)) fail(`ship with ${s.colonists} colonists`);
      const key = `${s.from}:${s.to}:${s.depart}`;
      const pa = prevShip.get(key);
      if (pa !== undefined && pa !== s.arrive) fail(`ship ${key} arrival moved ${pa} -> ${s.arrive}`);
      prevShip.set(key, s.arrive);
    }
    if (y >= 1 && earthPop < earthMin) { earthMin = earthPop; earthMinYear = YEAR0 + y; }
    if (y < 300 && earthPop > earthPeak) { earthPeak = earthPop; earthPeakYear = YEAR0 + e.years[st.step]; }
    if (e.years[st.step] === 60) marsAt2100 = S[mars * NF + F.pop];
    if (e.years[st.step] === 100) {
      let best = -1, bp = 0;
      for (let n = 0; n < st.nSettled; n++) {
        const b = st.settled[n];
        if (b !== earth && S[b * NF + F.pop] > bp) { bp = S[b * NF + F.pop]; best = b; }
      }
      marsBiggest2140 = best === mars;
    }
  }

  // exact replay from snapshots (what the worker relies on). One replay engine is
  // reused, latest checkpoint first, so stale scratch from a later step would show.
  const r = new Engine(world, seed);
  r.logEvents = false;
  for (const [to, { from, snap }] of [...targets].sort((a, b) => b[0] - a[0])) {
    r.restore(snap);
    while (r.st.step < to) r.step();
    const want = pending.get(to)!;
    const diff = sameState(r.snapshot(), want);
    if (diff) fail(`replay ${from}->${to} diverged: ${diff}`);
    const i = eq(r.series.subarray((from + 1) * NGM, (to + 1) * NGM), e.series.subarray((from + 1) * NGM, (to + 1) * NGM));
    if (i !== -1) fail(`replay ${from}->${to} series differs at row ${from + 1 + Math.floor(i / NGM)} col ${i % NGM}`);
  }
  // same seed twice
  if (det) {
    const e2 = new Engine(world, seed);
    while (!e2.done) e2.step();
    const i = eq(e.series, e2.series);
    if (i !== -1) fail(`second run differs at step ${Math.floor(i / NGM)} col ${i % NGM}`);
    if (e.events.length !== e2.events.length) fail(`second run logged ${e2.events.length} events vs ${e.events.length}`);
  }

  const col = (k: number, step: number) => e.series[step * NGM + k];
  const stepOf = (yr: number) => { let i = 0; while (i < e.years.length - 1 && e.years[i + 1] <= yr) i++; return i; };
  const firstYear = (pred: (s: number) => boolean) => { for (let s = 0; s < e.years.length; s++) if (pred(s)) return YEAR0 + e.years[s]; return NaN; };
  const last = e.years.length - 1;
  const eraYears = new Array(ERAS.length).fill(0);
  let dark = 0, longestDark = 0, war = 0, longestWar = 0;
  for (let s = 0; s < last; s++) {
    const dt = e.years[s + 1] - e.years[s], era = col(GM.era, s);
    eraYears[era] += dt;
    dark = era === 6 ? dark + dt : 0; longestDark = Math.max(longestDark, dark);
    war = era === 4 ? war + dt : 0; longestWar = Math.max(longestWar, war);
  }
  let maxPopGrowth = 0;
  for (let s = 1; s <= last; s++) {
    const p0 = col(GM.pop, s - 1), p1 = col(GM.pop, s), dt = e.years[s] - e.years[s - 1];
    if (p0 > 1e6) maxPopGrowth = Math.max(maxPopGrowth, Math.log(p1 / p0) / dt);
  }
  const events: Record<string, number> = {};
  for (const ev of e.events) events[EVENT_NAMES[ev.type]] = (events[EVENT_NAMES[ev.type]] ?? 0) + 1;
  const tech: Record<string, number> = {};
  for (const id of ['fusion', 'agi', 'genShip', 'dyson1', 'dyson2', 'warp', 'wormholes', 'orbitalHabitats', 'starshot']) {
    const d = e.st.techDone[techAt(id)];
    tech[id] = d >= 0 ? YEAR0 + d : NaN;
  }
  const popAt: Record<number, number> = {}, offAt: Record<number, number> = {};
  for (const yr of [2100, 2140, 2200, 2540, 3040, 5040, 12040]) { popAt[yr] = col(GM.pop, stepOf(yr - YEAR0)); offAt[yr] = col(GM.offEarth, stepOf(yr - YEAR0)); }
  const le: Record<number, number> = {};
  for (const yr of [2050, 2100, 2500, 5040]) le[yr] = col(GM.lifeExp, stepOf(yr - YEAR0));
  const gpc = (yr: number) => col(GM.gdpPerCap, stepOf(yr - YEAR0));
  return {
    earthPeak, earthPeakYear, le, medAge2100: col(GM.medianAge, stepOf(60)),
    growth2100: Math.log(gpc(2100) / gpc(2040)) / 60, growth2300: Math.log(gpc(2300) / gpc(2100)) / 200,
    seed, ms: simMs, fails, tech,
    firstStar: firstYear((s) => col(GM.interstellarPop, s) > 0), firstStarColony,
    popAt, offAt, marsAt2100, marsBiggest2140, earthMin, earthMinYear,
    reach: col(GM.reach, last), systems: col(GM.systems, last), kardashev: col(GM.kardashev, last),
    k1: firstYear((s) => col(GM.kardashev, s) >= 1), k2: firstYear((s) => col(GM.kardashev, s) >= 2),
    wars: col(GM.wars, last), factions: col(GM.factions, last), eraYears, longestDark, longestWar, events, finalPop: col(GM.pop, last), churn, maxPopGrowth,
  };
}

// ---- reporting

function q(xs: number[], p: number): number {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}
const fmt = (x: number) => Number.isNaN(x) ? '—' : !Number.isFinite(x) ? String(x) : Math.abs(x) >= 1e5 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(1) : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2);

function report(rs: SeedResult[]): void {
  const n = rs.length;
  const row = (label: string, xs: number[], target = '') => {
    const have = xs.filter((x) => !Number.isNaN(x)).length;
    console.log(`${label.padEnd(30)} ${fmt(q(xs, 0.1)).padStart(9)} ${fmt(q(xs, 0.5)).padStart(9)} ${fmt(q(xs, 0.9)).padStart(9)}  ${String(Math.round((100 * have) / n)).padStart(3)}%  ${target}`);
  };
  console.log(`\n${'metric'.padEnd(30)} ${'p10'.padStart(9)} ${'median'.padStart(9)} ${'p90'.padStart(9)}  seen  target (median)`);
  row('fusion (year)', rs.map((r) => r.tech.fusion), '2060–2100');
  row('AGI (year)', rs.map((r) => r.tech.agi), '2045–2080');
  row('starshot probes (year)', rs.map((r) => r.tech.starshot), '~2080');
  row("O'Neill cylinders (year)", rs.map((r) => r.tech.orbitalHabitats), '~2180');
  row('generation ships (year)', rs.map((r) => r.tech.genShip), '~2300');
  row('first people at another star', rs.map((r) => r.firstStar));
  row('first interstellar colony', rs.map((r) => r.firstStarColony), '2250–2700');
  row('Dyson swarm I (year)', rs.map((r) => r.tech.dyson1), '2500–3500');
  row('Kardashev 1.0 (year)', rs.map((r) => r.k1), '2300–2600 (needs a swarm)');
  row('Kardashev 2.0 (year)', rs.map((r) => r.k2), '~3500, never in ~40%');
  row('FTL / warp (year)', rs.map((r) => r.tech.warp), '5–10% of seeds');
  row('wormholes (year)', rs.map((r) => r.tech.wormholes));
  row('Mars pop 2100', rs.map((r) => r.marsAt2100), '~2e4');
  row('off-Earth pop 2100', rs.map((r) => r.offAt[2100]), '~1e5');
  row('off-Earth pop 2140', rs.map((r) => r.offAt[2140]), '~1e6 by 2120');
  row('off-Earth pop 2200', rs.map((r) => r.offAt[2200]), '~1e7');
  for (const yr of [2140, 2540, 3040, 5040, 12040]) row(`population ${yr}`, rs.map((r) => r.popAt[yr]), yr === 12040 ? '1e11–1e13' : '');
  row('Earth minimum pop', rs.map((r) => r.earthMin), '>4e9 unless Collapse');
  row('Earth peak pop (before 2340)', rs.map((r) => r.earthPeak), '1.0e10–1.2e10 (UN WPP 2024: 10.3e9)');
  row('Earth peak year', rs.map((r) => r.earthPeakYear), '2080–2130 (UN: 2084)');
  row('life expectancy 2050', rs.map((r) => r.le[2050]), '77–80 (UN WPP 2024 ≈ 77)');
  row('life expectancy 2100', rs.map((r) => r.le[2100]), '85–100 (genetic medicine)');
  row('life expectancy 2500', rs.map((r) => r.le[2500]), '100–250');
  row('life expectancy 5040', rs.map((r) => r.le[5040]), '150–250 (life extension)');
  row('median age 2100', rs.map((r) => r.medAge2100), '40–50 (UN 2100 ≈ 42)');
  row('product/person growth 2040–2100 (%/yr)', rs.map((r) => 100 * r.growth2100), '1.5–3');
  row('product/person growth 2100–2300 (%/yr)', rs.map((r) => 100 * r.growth2300), '0.5–2');
  row('reach at end (ly)', rs.map((r) => r.reach), '60–300 (bible 40–200)');
  row('systems settled at end', rs.map((r) => r.systems), '~50 (0–2000)');
  row('Kardashev at end', rs.map((r) => r.kardashev));
  row('wars per millennium', rs.map((r) => r.wars / 10));
  row('factions at end', rs.map((r) => r.factions));
  row('longest dark age (yr)', rs.map((r) => r.longestDark));
  row('longest war era (yr)', rs.map((r) => r.longestWar), '< ~200');
  row('settlements re-founded', rs.map((r) => r.churn), 'few');
  row('max pop growth (/yr)', rs.map((r) => r.maxPopGrowth));
  row('engine time (ms, contended)', rs.map((r) => r.ms), '<3000');
  console.log(`\nMars biggest colony at 2140: ${rs.filter((r) => r.marsBiggest2140).length}/${n} seeds`);
  console.log(`Earth below 4e9 at some point: ${rs.filter((r) => r.earthMin < 4e9).length}/${n} seeds`);
  console.log(`dark age >= 200 yr: ${rs.filter((r) => r.longestDark >= 200).length}/${n} seeds`);
  console.log(`FTL: ${rs.filter((r) => !Number.isNaN(r.tech.warp)).length}/${n} seeds`);
  const tot = rs.reduce((a, r) => a + r.eraYears.reduce((x, y) => x + y, 0), 0);
  console.log('time in era: ' + ERAS.map((name, k) => `${name} ${((100 * rs.reduce((a, r) => a + r.eraYears[k], 0)) / tot).toFixed(1)}%`).join(', '));
  const evNames = new Set(rs.flatMap((r) => Object.keys(r.events)));
  const ev = [...evNames].map((k) => [k, q(rs.map((r) => r.events[k] ?? 0), 0.5)] as const).sort((a, b) => b[1] - a[1]);
  console.log('median events per run: ' + ev.map(([k, v]) => `${k} ${fmt(v)}`).join(', '));
}

// ---- driver

if (isMainThread) {
  const args = process.argv.slice(2);
  const flag = (name: string, d: number) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : d; };
  const pos = args.filter((a) => !a.startsWith('--')).map(Number);
  const nSeeds = pos[0] ?? 30, first = pos[1] ?? 1, nDet = flag('det', 3);
  const seeds = Array.from({ length: nSeeds }, (_, i) => first + i);
  const serial = args.includes('--serial');
  const t0 = performance.now();
  const results: SeedResult[] = [];
  const done = (r: SeedResult) => {
    results.push(r);
    process.stdout.write(r.fails.length ? `\nseed ${r.seed} FAILED:\n  ${r.fails.join('\n  ')}\n` : '.');
  };
  if (serial) {
    const world = buildWorld();
    for (const s of seeds) done(runSeed(world, s, s < first + nDet));
  } else {
    const nw = Math.min(seeds.length, Math.max(1, availableParallelism() - 1));
    const queue = [...seeds];
    await Promise.all(Array.from({ length: nw }, () => new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { first, nDet } });
      const feed = () => { const s = queue.shift(); if (s === undefined) { w.terminate(); resolve(); } else w.postMessage(s); };
      w.on('message', (r: SeedResult) => { done(r); feed(); });
      w.on('error', reject);
      feed();
    })));
  }
  results.sort((a, b) => a.seed - b.seed);
  report(results);
  const bad = results.filter((r) => r.fails.length);
  console.log(`\n${results.length} seeds in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${bad.length ? `${bad.length} FAILED (${bad.map((r) => r.seed).join(', ')})` : 'all invariants hold'}`);
  process.exit(bad.length ? 1 : 0);
} else {
  const world = buildWorld();
  const { first, nDet } = workerData as { first: number; nDet: number };
  parentPort!.on('message', (seed: number) => parentPort!.postMessage(runSeed(world, seed, seed < first + nDet)));
}
