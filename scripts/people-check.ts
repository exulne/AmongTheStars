// People checker: the persistent-people model (ledger → demography → lives)
// against the engine, on several seeds. Exit code 1 on any failure.
//   node scripts/people-check.ts [seeds=4] [firstSeed=1] [--samples=300] [--serial] [--perf]
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Engine } from '../src/sim/engine.ts';
import { idStr, periodMid, type Demography, type Id, type Pool } from '../src/sim/demography.ts';
import { FLOW, NPERIODS, SHIP_BODY, isPeriodBoundary, periodOf, periodStart } from '../src/sim/ledger.ts';
import { Lives } from '../src/sim/lives.ts';
import { F, NF } from '../src/sim/metrics.ts';
import { hash01 } from '../src/sim/rng.ts';
import { buildWorld, type World } from '../src/sim/world.ts';

interface Result {
  seed: number; fails: string[];
  census: { checked: number; ships: number; shipPeriods: number };
  family: { people: number; links: number }; migrants: number;
  chi: { label: string; chi2: number; dof: number; p: number; exact: number }[];
  det: boolean | null;
  stats: {
    childrenPerWoman: number; knownFather: number; eventDeaths: number; longestLine: number; bornAboard: number;
    ageAtDeath: Record<number, number>; phantomBirths: number; births: number; shortFlows: number; shortPeople: number; shortCrew: number; landed: number; oldest: number; medianAge: number;
  };
  perf: { censusCold: number; censusWarm: number; bio: number; bigBody: number; bigPop: number; buildAll: number };
}

// internals the checker needs to see (TS privacy is compile-time only)
// the timing budgets only bite under --perf: timings are still measured and
// printed on every run, but a loaded machine shouldn't turn them into failures
const PERF = process.argv.includes('--perf');
interface Town { pools: Pool[]; built: number; nativeByPeriod: Map<number, Pool> }
const towns = (D: Demography) => (D as unknown as { towns: Map<number, Town> }).towns;
const byFlow = (D: Demography) => (D as unknown as { byFlow: Map<number, { pool: Pool; count: number }[]> }).byFlow;
const birthplace = (x: Pool) => { while (!x.native) x = x.src!; return x.bornAt; };

const sexOf = (D: Demography, id: Id) => (D.birthPool(id)!.rank % 2) as 0 | 1;
const same = (a: Id | null, b: Id) => !!a && a.b === b.b && a.q === b.q && a.i === b.i;

function run(world: World, seed: number): Engine & { heads: Map<number, Float64Array> } {
  const e = new Engine(world, seed) as Engine & { heads: Map<number, Float64Array> };
  // the engine's own head-count at every period close, captured independently of the ledger
  e.heads = new Map();
  while (!e.done) {
    e.step();
    const y = e.years[e.st.step];
    if (!isPeriodBoundary(y) && !e.done) continue;
    const p = e.done ? NPERIODS - 1 : periodOf(y) - 1;
    for (let n = 0; n < e.st.nSettled; n++) {
      const b = e.st.settled[n];
      let a = e.heads.get(b);
      if (!a) e.heads.set(b, (a = new Float64Array(NPERIODS).fill(-1)));
      a[p] = Math.max(0, Math.round(e.st.S[b * NF + F.pop]));
    }
  }
  return e;
}

// regularized upper incomplete gamma Q(a, x), for chi-square p-values
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lg = lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum;
    for (let n = 1; n < 500; n++) { del *= x / (a + n); sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - lg) * h;
}
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

function checkSeed(world: World, seed: number, samples: number, det: boolean): Result {
  const fails: string[] = [];
  const fail = (m: string) => { if (fails.length < 20) fails.push(m); };
  const e = run(world, seed);
  const led = e.ledger!;
  const last = led.closed;
  const rnd = (k: number) => hash01(seed, 9001, k);

  // (g) performance, on a cold model
  const L = new Lives(e), D = L.D;
  let big = world.earth, bigPop = 0;
  for (const [b, a] of e.heads) if (b !== world.earth && a[last] > bigPop) { bigPop = a[last]; big = b; }
  const earthPop = e.heads.get(world.earth)![last];
  if (earthPop > bigPop) { big = world.earth; bigPop = earthPop; }
  let t = performance.now();
  D.census(big, last);
  const censusCold = performance.now() - t;
  t = performance.now();
  const cBig = D.census(big, last);
  for (let k = 0; k < 100; k++) cBig.at(k);
  const censusWarm = performance.now() - t;
  let bio = 0;
  for (let k = 0; k < 5; k++) {
    const id = idStr(cBig.at(Math.floor(rnd(k) * cBig.total)));
    t = performance.now();
    L.biography(id, periodStart(last));
    bio = Math.max(bio, performance.now() - t);
  }
  const perf = { censusCold, censusWarm, bio, bigBody: big, bigPop, buildAll: 0 };
  if (PERF) {
    if (censusCold > 2000) fail(`cold census of body ${big} (${bigPop} people) took ${censusCold.toFixed(0)} ms (budget 2000)`);
    if (censusWarm > 50) fail(`warm census of body ${big} took ${censusWarm.toFixed(1)} ms (budget 50)`);
    if (bio > 100) fail(`a biography took ${bio.toFixed(0)} ms (budget 100)`);
  }

  // (a) census == engine head-count, every settlement, every period (ships: == ledger)
  t = performance.now();
  let checked = 0, ships = 0, shipPeriods = 0;
  const live: { b: number; p: number; n: number }[] = [];
  for (const [b, heads] of e.heads) {
    for (let p = 0; p <= last; p++) {
      if (heads[p] < 0) continue;
      const n = D.census(b, p).total;
      checked++;
      if (n !== heads[p]) fail(`census of body ${b} at period ${p} is ${n}, engine has ${heads[p]}`);
      if (n > 0) live.push({ b, p, n });
    }
  }
  for (const [b, pe] of led.popEnd) {
    if (b < SHIP_BODY) continue;
    ships++;
    for (let p = 0; p <= last; p++) {
      if (pe[p] < 0) continue;
      const n = D.census(b, p).total;
      shipPeriods++; checked++;
      if (n !== pe[p]) fail(`census of ship ${b} at period ${p} is ${n}, ledger has ${pe[p]}`);
      if (n > 0) live.push({ b, p, n });
    }
  }
  perf.buildAll = performance.now() - t;

  // conservation inside the model: flows that found fewer people than they carry,
  // and births the model had to invent to meet the head-count
  let shortFlows = 0, shortPeople = 0, shortCrew = 0, phantomBirths = 0, allBirths = 0, landed = 0, aboard = 0;
  const bf = byFlow(D);
  for (const f of led.flows) {
    const segs = bf.get(f.id) ?? [];
    const got = segs.reduce((a, r) => a + r.count, 0);
    if (got < f.n) { shortFlows++; shortPeople += f.n - got; if (f.kind === FLOW.CREW) shortCrew += f.n - got; }
    // who steps off generation ships: the share born on the way
    if (f.kind === FLOW.LANDING && !f.lost) for (const r of segs) { landed += r.count; if (birthplace(r.pool) >= SHIP_BODY) aboard += r.count; }
  }
  for (const [b, tw] of towns(D)) {
    const br = led.births.get(b);
    let carry = 0;
    for (let p = 0; p <= tw.built; p++) {
      const want = br && br[p] > 0 ? Math.floor(br[p] + carry) : 0;
      if (br && br[p] > 0) carry = br[p] + carry - want;
      const got = tw.nativeByPeriod.get(p)?.n ?? 0;
      if (got > want) phantomBirths += got - want;
      allBirths += got;
    }
  }

  // sample residents: (place, period, person)
  const sample: { b: number; p: number; id: Id }[] = [];
  for (let k = 0; k < samples; k++) {
    const s = live[Math.floor(rnd(1000 + k) * live.length)];
    const c = D.census(s.b, s.p);
    sample.push({ b: s.b, p: s.p, id: c.at(Math.floor(rnd(2000 + k) * c.total)) });
  }

  // (b) family inverses
  let links = 0;
  const kidsOf = new Map<string, Id[]>();
  const kids = (x: Id) => { const k = idStr(x); let v = kidsOf.get(k); if (!v) kidsOf.set(k, (v = D.children(x))); return v; };
  for (const { id } of sample.slice(0, Math.min(samples, 200))) {
    const m = D.mother(id), f = D.father(id);
    if (m) { links++; if (!kids(m).some((c) => same(c, id))) fail(`${idStr(id)}: mother ${idStr(m)} does not list them`); if (sexOf(D, m) !== 0) fail(`${idStr(id)}: mother ${idStr(m)} is male`); }
    if (f) { links++; if (!kids(f).some((c) => same(c, id))) fail(`${idStr(id)}: father ${idStr(f)} does not list them`); if (sexOf(D, f) !== 1) fail(`${idStr(id)}: father ${idStr(f)} is female`); }
    // both parents were alive and living at the birthplace at the end of the birth period
    for (const par of [m, f]) {
      if (!par) continue;
      const here = D.life(par)?.some((s) => s.body === id.b && s.from <= id.q && id.q <= s.to && (id.q < s.to || s.end === 'alive'));
      if (!here) fail(`${idStr(id)}: parent ${idStr(par)} was not alive on ${id.b} in period ${id.q}`);
    }
    for (const c of kids(id)) {
      links++;
      if (!same(D.mother(c), id) && !same(D.father(c), id)) fail(`${idStr(id)}: child ${idStr(c)} names other parents`);
      if (D.birthYear(c) <= D.birthYear(id)) fail(`${idStr(id)}: child ${idStr(c)} born before parent`);
    }
  }

  // (c) residents' lives pass through where the census found them, alive at the period's end
  let migrants = 0;
  for (const { b, p, id } of sample) {
    if (id.b !== b) migrants++;
    const life = D.life(id);
    const at = life?.find((s) => s.body === b && s.from <= p && p <= s.to && (p < s.to || s.end === 'alive'));
    const by = D.birthYear(id), end = life?.[life.length - 1];
    if (by < periodStart(id.q) || by >= periodStart(id.q + 1)) fail(`${idStr(id)}: birth year ${by} outside its period ${id.q}`);
    if (end?.diedYear !== undefined && end.diedYear < by) fail(`${idStr(id)}: dies (${end.diedYear}) before birth (${by})`);
    if (!at) fail(`${idStr(id)} is in the census of ${b} at period ${p} but their life says ${JSON.stringify(life?.map((s) => [s.body, s.from, s.to, s.end]))}`);
  }

  // (d) age x sex: 10k census draws against pyramid(), plus an exact sex count per pool
  const chi: Result['chi'] = [];
  const nonEarth = live.filter((x) => x.b !== world.earth && x.b < SHIP_BODY && x.n > 5000);
  const picks = [{ b: world.earth, p: Math.floor(last / 2) }, ...(nonEarth.length ? [nonEarth[Math.floor(rnd(7) * nonEarth.length)]] : [])];
  for (const { b, p } of picks) {
    const c = D.census(b, p), pyr = D.pyramid(b, p);
    const N = 10000, obs = new Map<string, number>();
    for (let k = 0; k < N; k++) {
      const id = c.at(Math.floor(rnd(50000 + k) * c.total));
      const band = Math.max(0, Math.floor((periodStart(p + 1) - periodMid(id.q)) / 10));
      const key = `${band}:${sexOf(D, id)}`;
      obs.set(key, (obs.get(key) ?? 0) + 1);
    }
    // merge sparse cells so every expected count is at least 5
    let chi2 = 0, dof = -1, accE = 0, accO = 0, exact = 0;
    const cells = pyr.flatMap((r) => [[`${r.band}:0`, r.women], [`${r.band}:1`, r.men]] as const);
    const merged: [number, number][] = [];
    for (const [key, n] of cells) {
      accE += (n / c.total) * N; accO += obs.get(key) ?? 0; obs.delete(key);
      if (accE >= 5) { merged.push([accE, accO]); accE = 0; accO = 0; }
    }
    // a sparse tail joins the last full cell (alone it would be a cell with expectation < 5)
    if (accE > 0 || accO > 0) { if (merged.length) { merged[merged.length - 1][0] += accE; merged[merged.length - 1][1] += accO; } else merged.push([accE, accO]); }
    for (const [E, O] of merged) { chi2 += (O - E) ** 2 / Math.max(E, 1e-9); dof++; }
    if (obs.size) fail(`census draws at ${b}/${p} landed in cells the pyramid lacks: ${[...obs.keys()].join(',')}`);
    const pv = gammaQ(Math.max(1, dof) / 2, chi2 / 2);
    // exact: the pyramid's women per band against a count of even native ranks among each pool's alive ranks
    const want = new Map<number, number>();
    for (const { pool, alive } of c.pools) {
      let off = 0, x = pool;
      while (!x.native) { off += x.srcStart!; x = x.src!; }
      const band = Math.max(0, Math.floor((periodStart(p + 1) - periodMid(pool.q)) / 10));
      want.set(band, (want.get(band) ?? 0) + (off % 2 ? Math.floor(alive / 2) : Math.ceil(alive / 2)));
    }
    for (const r of pyr) if (r.women !== want.get(r.band)) exact++;
    chi.push({ label: `${b === world.earth ? 'Earth' : world.bodies[b]?.name ?? b}@${2040 + periodStart(p + 1)}`, chi2, dof, p: pv, exact });
    // two tests a seed, four seeds: at p < 0.01 an exact model would still fail one run in twelve
    if (pv < 0.001) fail(`age x sex chi-square at ${b}/${p}: chi2 ${chi2.toFixed(1)} on ${dof} dof, p = ${pv.toExponential(2)}`);
    if (exact) fail(`pyramid miscounts women in ${exact} age bands at ${b}/${p}`);
  }

  // (e) determinism: a fresh engine and model give the same people and the same lives
  let detOk: boolean | null = null;
  if (det) {
    const e2 = run(world, seed), L2 = new Lives(e2);
    detOk = true;
    for (const { b, p } of [{ b: world.earth, p: 10 }, { b: world.mars, p: 60 }, ...picks]) {
      if (!e.heads.get(b) || e.heads.get(b)![p] <= 0) continue;
      const c1 = D.census(b, p), c2 = L2.D.census(b, p);
      for (let k = 0; k < Math.min(100, c1.total); k++) {
        if (idStr(c1.at(k)) !== idStr(c2.at(k))) { detOk = false; fail(`determinism: resident #${k} of ${b}/${p} differs`); break; }
      }
      for (const yr of [100, 1000, periodStart(last)]) {
        const id = idStr(c1.at(0));
        if (JSON.stringify(L.biography(id, yr)) !== JSON.stringify(L2.biography(id, yr))) { detOk = false; fail(`determinism: biography of ${id} at ${yr} differs`); }
      }
    }
  }

  // (f) plausibility. Birth cohorts sampled directly (identities, not residents):
  let women = 0, kidsTot = 0, born = 0, withFather = 0, deaths = 0, eventDeaths = 0, longestLine = 0;
  const natives: Pool[] = [];
  for (const tw of towns(D).values()) for (const x of tw.pools) if (x.native && x.q >= 0 && x.q <= last - 12 && x.n > 0) natives.push(x);
  for (let k = 0; k < samples && natives.length; k++) {
    const x = natives[Math.floor(rnd(70000 + k) * natives.length)];
    const id: Id = { b: x.body, q: x.q, i: Math.floor(rnd(80000 + k) * x.n) };
    born++;
    if (D.father(id)) withFather++;
    const life = D.life(id)!;
    const end = life[life.length - 1];
    if (end.end === 'died' || end.end === 'lost') {
      const age = end.diedYear! - D.birthYear(id);
      if (sexOf(D, id) === 0 && age >= 50) { women++; kidsTot += D.children(id).length; }
      if (k < 150) {
        deaths++;
        const cause = L.biography(idStr(id), end.diedYear! + 1)!.died?.cause ?? '';
        if (/ of \d{4}$/.test(cause) || cause.startsWith('lost with')) eventDeaths++;
      }
    }
    let line = 0, cur: Id | null = id;
    while (cur && line < 400) { cur = D.father(cur) ?? D.mother(cur); if (cur) line++; }
    longestLine = Math.max(longestLine, line);
  }
  // exact, from the pools: mean age at death per century
  const ageSum = new Map<number, number>(), ageN = new Map<number, number>();
  for (const tw of towns(D).values()) {
    for (const x of tw.pools) {
      for (let k = 0; k < x.dd.length; k++) {
        if (!x.dd[k]) continue;
        const p = x.p0 + k, cent = Math.floor(periodStart(p) / 100) * 100;
        ageSum.set(cent, (ageSum.get(cent) ?? 0) + x.dd[k] * (periodMid(p) - periodMid(x.q)));
        ageN.set(cent, (ageN.get(cent) ?? 0) + x.dd[k]);
      }
    }
  }
  // the age structure of the biggest place at the end
  const pyr = D.pyramid(big, last), tot = pyr.reduce((a, r) => a + r.women + r.men, 0);
  let acc = 0, medianAge = NaN;
  for (const r of pyr) { acc += r.women + r.men; if (Number.isNaN(medianAge) && acc >= tot / 2) medianAge = r.band * 10 + 5; }
  const oldest = pyr.length ? pyr[pyr.length - 1].band * 10 : NaN;
  const ageAtDeath: Record<number, number> = {};
  for (const [c, s] of ageSum) ageAtDeath[2040 + c] = s / ageN.get(c)!;

  return {
    seed, fails, census: { checked, ships, shipPeriods }, family: { people: Math.min(samples, 200), links }, migrants, chi, det: detOk,
    stats: {
      childrenPerWoman: women ? kidsTot / women : NaN, knownFather: born ? withFather / born : NaN, eventDeaths: deaths ? eventDeaths / deaths : NaN,
      longestLine, bornAboard: landed ? aboard / landed : NaN, ageAtDeath, phantomBirths, births: allBirths, shortFlows, shortPeople, shortCrew, landed, oldest, medianAge,
    },
    perf,
  };
}

// ---- reporting

const fmt = (x: number, d = 2) => (Number.isNaN(x) ? '—' : Math.abs(x) >= 1e5 ? x.toExponential(1) : x.toFixed(d));
function report(rs: Result[]): void {
  console.log('\nseed  census-checks  ships  family-links  migrants  chi2 (p)                         det   cold/warm census ms  bio ms  build-all s');
  for (const r of rs) {
    console.log(`${String(r.seed).padEnd(5)} ${String(r.census.checked).padStart(13)} ${String(r.census.ships).padStart(6)} ${String(r.family.links).padStart(13)} ${String(r.migrants).padStart(9)}  ${r.chi.map((c) => `${c.label} ${fmt(c.chi2, 1)}/${c.dof} (${fmt(c.p, 3)})`).join('; ').padEnd(32)} ${String(r.det ?? '-').padEnd(5)} ${fmt(r.perf.censusCold, 0).padStart(9)}/${fmt(r.perf.censusWarm, 1).padEnd(8)} ${fmt(r.perf.bio, 0).padStart(7)} ${fmt(r.perf.buildAll / 1000, 1).padStart(11)}`);
  }
  const med = (xs: number[]) => { const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN; };
  const span = (f: (r: Result) => number, d = 2) => `${fmt(med(rs.map(f)), d)}  (${fmt(Math.min(...rs.map(f)), d)}–${fmt(Math.max(...rs.map(f)), d)})`;
  console.log('\nplausibility, median (min–max) across seeds');
  console.log(`  children per woman (completed, died 50+)   ${span((r) => r.stats.childrenPerWoman)}`);
  console.log(`  share born with a known father             ${span((r) => r.stats.knownFather)}`);
  console.log(`  share of deaths attributed to events       ${span((r) => r.stats.eventDeaths)}`);
  console.log(`  longest ancestry chain (generations)       ${span((r) => r.stats.longestLine, 0)}`);
  console.log(`  biggest place at the end: median age band ${span((r) => r.stats.medianAge, 0)}, oldest band ${span((r) => r.stats.oldest, 0)}`);
  console.log(`  share of ship arrivals born aboard          ${span((r) => r.stats.bornAboard, 3)}   of ${span((r) => r.stats.landed, 0)} landed`);
  console.log(`  WARN travellers the sender didn't have      ${span((r) => r.stats.shortPeople, 0)} in ${span((r) => r.stats.shortFlows, 0)} flows (crews: ${span((r) => r.stats.shortCrew, 0)})`);
  console.log(`  WARN births invented to meet head-counts    ${span((r) => r.stats.phantomBirths / r.stats.births, 5)} of all births`);
  const cents = [...new Set(rs.flatMap((r) => Object.keys(r.stats.ageAtDeath).map(Number)))].sort((a, b) => a - b);
  const pick = cents.filter((c) => c <= 2400 || c % 1000 === 40);
  console.log('  mean age at death by century: ' + pick.map((c) => `${c}s ${fmt(med(rs.map((r) => r.stats.ageAtDeath[c] ?? NaN)), 0)}`).join(', '));
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const flag = (name: string, d: number) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : d; };
  const pos = args.filter((a) => !a.startsWith('--')).map(Number);
  const nSeeds = pos[0] ?? 4, first = pos[1] ?? 1, samples = flag('samples', 300);
  const seeds = Array.from({ length: nSeeds }, (_, i) => first + i);
  const t0 = performance.now();
  const results: Result[] = [];
  const done = (r: Result) => { results.push(r); process.stdout.write(r.fails.length ? `\nseed ${r.seed} FAILED:\n  ${r.fails.join('\n  ')}\n` : '.'); };
  if (args.includes('--serial')) {
    const world = buildWorld();
    for (const s of seeds) done(checkSeed(world, s, samples, s === first));
  } else {
    const queue = [...seeds];
    const nw = Math.min(seeds.length, Math.max(1, availableParallelism() - 1));
    await Promise.all(Array.from({ length: nw }, () => new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { first, samples } });
      const feed = () => { const s = queue.shift(); if (s === undefined) { w.terminate(); resolve(); } else w.postMessage(s); };
      w.on('message', (r: Result) => { done(r); feed(); });
      w.on('error', reject);
      feed();
    })));
  }
  results.sort((a, b) => a.seed - b.seed);
  report(results);
  const bad = results.filter((r) => r.fails.length);
  console.log(`\n${results.length} seeds in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${bad.length ? `${bad.length} FAILED (${bad.map((r) => r.seed).join(', ')})` : 'all people checks hold'}`);
  process.exit(bad.length ? 1 : 0);
} else {
  const world = buildWorld();
  const { first, samples } = workerData as { first: number; samples: number };
  parentPort!.on('message', (seed: number) => parentPort!.postMessage(checkSeed(world, seed, samples, seed === first)));
}
