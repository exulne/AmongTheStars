// Checks buildTrends in Node: edges, the migration tallies against the raw
// ledger, hotspot sanity, and that shocks count every event of their types —
// with faith events never entering the payload.
//   node scripts/trends-check.ts [seed]
import { EV } from '../src/sim/catalog.ts';
import { Engine } from '../src/sim/engine.ts';
import { FLOW, NPERIODS, isShipBody, periodOf, periodStart } from '../src/sim/ledger.ts';
import { GLOBAL_METRICS, GM, HIST_FIELDS, NGM } from '../src/sim/metrics.ts';
import { MARKET_WINDOW, buildTrends } from '../src/sim/trends.ts';
import { REPORT_COLUMNS, SECTIONS, buildReport, marketsAt, reportTable, rowAt, seriesTable, shockSignal, signalAt } from '../src/sim/trendSignals.ts';
import { toCsv } from '../src/ui/exporter.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 7);
const main = new Engine(buildWorld(), seed);
const t0 = performance.now();
while (!main.done) main.step();
console.log(`seed ${seed}: ${main.st.step} steps in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const bt0 = performance.now();
const t = buildTrends(main);
const btMs = performance.now() - bt0;
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

// ---- signals at a cursor year (trendSignals.ts): synthetic series first ----
{
  const ny = 201;
  const years = Array.from({ length: ny }, (_, i) => i);
  const series = new Float64Array(ny * NGM);
  for (let i = 0; i < ny; i++) {
    const o = i * NGM;
    series[o + GM.pop] = 1e6 * Math.pow(1.02, i);
    series[o + GM.births] = 1e6 * Math.pow(0.99, i);
    series[o + GM.gdp] = 5;
    series[o + GM.stability] = 0.5 + 0.001 * i;
    series[o + GM.happiness] = 0.5 + 0.0002 * i;
    series[o + GM.interstellarPop] = i < 120 ? 0 : 100;
  }
  const sig = (k: string, y: number) => signalAt(years, series, ny, k, y);
  const pop = sig('pop', 150)!;
  ok(pop.kind === 'rate' && pop.fromYear === 100 && pop.toYear === 150 && Math.abs(pop.change! - 2) < 1e-9 && pop.dir === 'rising', `pop @150: ${JSON.stringify(pop)}`);
  const births = sig('births', 150)!;
  ok(Math.abs(births.change! + 1) < 1e-9 && births.dir === 'falling', `births @150: ${births.change} ${births.dir}`);
  const gdp = sig('gdp', 150)!;
  ok(gdp.change === 0 && gdp.dir === 'flat', `gdp @150: ${gdp.change} ${gdp.dir}`);
  const stab = sig('stability', 150)!;
  ok(stab.kind === 'delta' && Math.abs(stab.change! - 0.05) < 1e-12 && stab.dir === 'rising', `stability @150: ${stab.change} ${stab.dir}`);
  const hap = sig('happiness', 150)!;
  ok(Math.abs(hap.change! - 0.01) < 1e-12 && hap.dir === 'flat', `happiness @150: ${hap.change} ${hap.dir}`);
  const isp = sig('interstellarPop', 150)!;
  ok(isp.change === null && isp.dir === 'rising', `interstellarPop @150: ${isp.change} ${isp.dir}`);
  const pop20 = sig('pop', 20)!;
  ok(pop20.fromYear === 0 && pop20.toYear === 20 && Math.abs(pop20.change! - 2) < 1e-9, `pop @20: ${JSON.stringify(pop20)}`);
  ok(sig('pop', 150.7)!.toYear === 150, 'pop @150.7 toYear');
  ok(sig('faiths', 150) === null && sig('nope', 150) === null, 'internal/unknown keys are null');
  ok(rowAt(years, ny, -1) === -1, 'rowAt before the first row');
}

// ---- no look-ahead on the real run ----
{
  const n = main.st.step + 1;
  for (const Y of [137, 1500, 6000]) {
    const copy = main.series.slice();
    for (let i = 0; i < n; i++) if (main.years[i] > Y) for (let k = 0; k < NGM; k++) copy[i * NGM + k] = copy[i * NGM + k] * 3 + 1;
    for (const sec of SECTIONS) for (const key of sec.metrics) {
      const a = JSON.stringify(signalAt(main.years, main.series, n, key, Y));
      const b = JSON.stringify(signalAt(main.years, copy, n, key, Y));
      ok(a === b, `look-ahead: signalAt(${key}, ${Y}) changes when rows after ${Y} do`);
    }
    let anyDiff = false;
    for (const sec of SECTIONS) for (const key of sec.metrics) {
      if (JSON.stringify(signalAt(main.years, main.series, n, key, Y + 300)) !== JSON.stringify(signalAt(main.years, copy, n, key, Y + 300))) anyDiff = true;
    }
    ok(anyDiff, `sanity: some signal at ${Y + 300} must differ on the altered copy`);
    const tc = structuredClone(t);
    for (const c of tc.shocks) { c.years.push(Y + 0.5, Y + 10); c.years.sort((a, b) => a - b); }
    for (const c of t.shocks) {
      ok(JSON.stringify(shockSignal(t, c.key, Y)) === JSON.stringify(shockSignal(tc, c.key, Y)), `look-ahead: shockSignal(${c.key}, ${Y}) changes when later years do`);
    }
  }
  const dis = t.shocks.find((c) => c.key === 'disaster')!;
  const dwant = new Set(dis.types);
  let recent = 0;
  for (const ev of main.events) if (dwant.has(ev.type) && ev.year > 3000 - 50 && ev.year <= 3000) recent++;
  ok(shockSignal(t, 'disaster', 3000)?.recent === recent, `shockSignal recent ${shockSignal(t, 'disaster', 3000)?.recent} vs events ${recent}`);
}

// ---- markets ----
{
  const perP = new Map<number, number>();
  let badM = 0;
  for (let i = 0; i < t.markets.length; i++) {
    const m = t.markets[i];
    perP.set(m.p, (perP.get(m.p) ?? 0) + 1);
    if (!(m.now - m.then > 0)) badM++;
    if (m.body < 0 || isShipBody(m.body) || m.body >= main.world.bodies.length) badM++;
    if (m.year !== t.edges[m.p] || m.year > t.upTo || m.year < t.growthFrom || !(m.since < m.year)) badM++;
    const q = t.markets[i - 1];
    if (q && (q.p > m.p || (q.p === m.p && q.now - q.then < m.now - m.then))) badM++;
  }
  ok(badM === 0, `markets sanity (${badM} bad)`);
  ok([...perP.values()].every((v) => v <= 5), 'at most 5 markets per period');
  ok(marketsAt(t, 3000).every((m) => m.p === periodOf(3000) && m.year <= 3000), 'marketsAt(3000) only its period, year <= y');

  // brute force a period's top 5 straight from the history rows: against the sample MARKET_WINDOW back,
  // or the first sample when the window starts before the history; no list at the first sample itself
  const w = 2 + HIST_FIELDS.length;
  const gc = 2 + HIST_FIELDS.indexOf('gdp');
  const samples: { year: number; rows: Map<number, number> }[] = [];
  for (let r = 0; r < main.histLen;) {
    const step = main.hist[r * w];
    const rows = new Map<number, number>();
    while (r < main.histLen && main.hist[r * w] === step) { rows.set(main.hist[r * w + 1], main.hist[r * w + gc]); r++; }
    samples.push({ year: main.years[step], rows });
  }
  const at = (y: number) => { let k = -1; for (let i = 0; i < samples.length; i++) if (samples[i].year <= y) k = i; return k; };
  const brute = (P: number) => {
    const Y = periodStart(P), kY = at(Y), k0 = Math.max(0, at(Y - MARKET_WINDOW));
    const want: typeof t.markets = [];
    if (kY > 0) {
      const then = samples[k0].rows;
      for (const [b, now] of samples[kY].rows) {
        const bef = then.get(b) ?? 0;
        if (!isShipBody(b) && now - bef > 0) want.push({ p: P, year: Y, since: samples[k0].year, body: b, now, then: bef });
      }
      want.sort((a, b) => b.now - b.then - (a.now - a.then));
      want.length = Math.min(want.length, 5);
    }
    return want;
  };
  for (const y of [0, 60, 3000]) {
    const P = periodOf(y);
    ok(JSON.stringify(t.markets.filter((m) => m.p === P)) === JSON.stringify(brute(P)), `markets p=${P} (year ${y}) vs brute force`);
  }
  ok(t.growthFrom === (samples.length > 1 ? samples[1].year : Infinity), `growthFrom ${t.growthFrom}`);
  ok(marketsAt(t, samples[0].year).length === 0, 'no market list at the first history sample');
  const early = marketsAt(t, 60), earth = main.world.bodies.findIndex((b) => b.name === 'Earth');
  ok(early.length > 0 && early.every((m) => m.since === samples[0].year && m.year - m.since < MARKET_WINDOW), 'first-century markets count since the first sample');
  ok(!early.some((m) => m.body === earth && m.then === 0), 'Earth is not a new market in the first century');
  console.log(`  markets @${Math.round(2040 + 60)}: ${early.slice(0, 3).map((m) => `${main.world.bodies[m.body].name} ${m.then === 0 ? 'new' : `+${(m.now - m.then).toExponential(2)}$/yr`}`).join('; ')}`);

  // truncation: a run cut off at 3000 must produce the same markets for the periods it has
  const e2 = new Engine(buildWorld(), seed);
  while (!e2.done && e2.years[e2.st.step] < 3000) e2.step();
  const t2 = buildTrends(e2);
  ok(!!t2, 'truncated run: buildTrends null');
  if (t2) {
    ok(t2.markets.every((m) => m.year <= t2.upTo), 'truncated run: markets within upTo');
    let diff = 0;
    for (let p = 0; p < NPERIODS && t2.edges[p] <= t2.upTo; p++) {
      if (JSON.stringify(t.markets.filter((m) => m.p === p)) !== JSON.stringify(t2.markets.filter((m) => m.p === p))) diff++;
    }
    ok(diff === 0, `truncated run: ${diff} periods differ from the full run`);
  }
}

// ---- end-of-run report (buildReport) ----
{
  const n = main.st.step + 1;
  const rows = buildReport(main.years, main.series, n, t);
  const wantRows = SECTIONS.reduce((a, s) => a + s.metrics.length, 0) + t.shocks.length;
  ok(rows.length === wantRows, `report rows ${rows.length} vs ${wantRows}`);
  let badR = 0;
  for (const r of rows) {
    if (r.kind === 'count') {
      const c = t.shocks.find((x) => `shock:${x.key}` === r.key)!;
      if (r.runChange !== c.years.length) badR++;
      const top = c.top[0];
      if (!(top ? r.peakYear === top.year : Number.isNaN(r.peakYear))) badR++;
    } else {
      if (r.endYear !== main.years[n - 1] || !Number.isFinite(r.end) || !Number.isFinite(r.peakYear) || !Number.isFinite(r.troughYear)) badR++;
      if (r.kind === 'delta' && (!Number.isFinite(r.start) || !Number.isFinite(r.runChange))) badR++;
      if (r.kind === 'rate' && (r.runChange !== null) !== (r.start > 0 && r.end > 0)) badR++;
      if (r.lastDir !== 'rising' && r.lastDir !== 'falling' && r.lastDir !== 'flat') badR++;
    }
  }
  ok(badR === 0, `report row sanity (${badR} bad)`);
  const g = GM.gdp;
  let i0 = -1;
  for (let i = 0; i < n; i++) if (Number.isFinite(main.series[i * NGM + g]) && main.series[i * NGM + g] > 0) { i0 = i; break; }
  const cagr = 100 * (Math.pow(main.series[(n - 1) * NGM + g] / main.series[i0 * NGM + g], 1 / (main.years[n - 1] - main.years[i0])) - 1);
  const gr = rows.find((r) => r.section === 'Market size and growth' && r.key === 'gdp')!;
  ok(Math.abs(gr.runChange! - cagr) < 1e-9, `gdp run CAGR ${gr.runChange} vs ${cagr}`);
  ok(!/faith/i.test(JSON.stringify(rows)), 'report mentions no faith');

  // CSV copies
  const repCsv = toCsv(REPORT_COLUMNS, reportTable(rows), `Trends report, future #${seed}`);
  const repLines = repCsv.split('\n').filter((l) => l && !l.startsWith('#'));
  ok(repLines[0] === REPORT_COLUMNS.join(','), 'report CSV header');
  ok(repLines.length - 1 === rows.length, `report CSV ${repLines.length - 1} lines vs ${rows.length} rows`);
  ok(!/faith/i.test(repCsv), 'report CSV mentions no faith');

  const { columns, rows: srows } = seriesTable(main.years, main.series, n);
  const uniq = new Set<string>();
  for (const sec of SECTIONS) for (const k of sec.metrics) uniq.add(k);
  ok(columns.length === 1 + uniq.size, `series columns ${columns.length} vs ${1 + uniq.size}`);
  ok(srows.length === n, `series rows ${srows.length} vs ${n}`);
  const serCsv = toCsv(columns, srows, `Trends series, future #${seed}`);
  const serLines = serCsv.split('\n').filter((l) => l && !l.startsWith('#'));
  ok(serLines.length - 1 === n, `series CSV ${serLines.length - 1} lines vs ${n}`);
  const numCell = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  ok(serLines.slice(1).every((l) => l.split(',').every((c) => c === '' || numCell.test(c))), 'series CSV cells are numbers or empty');
  ok(!/faith/i.test(serCsv), 'series CSV mentions no faith');
}

// ---- faith stays out ----
for (const sec of SECTIONS) for (const key of sec.metrics) {
  const g = GM[key];
  ok(g !== undefined && !GLOBAL_METRICS[g].internal, `SECTIONS metric ${key} is a public global metric`);
}
ok(!/faith/i.test(JSON.stringify(SECTIONS)), 'SECTIONS mentions no faith');

console.log(`  ${t.hot.length} hot entries; top 3: ${[...t.hot].sort((a, b) => b.n - a.n).slice(0, 3).map((h) => `${main.world.bodies[h.body].name} ${Math.round(h.n)}`).join('; ')}`);
for (const c of t.shocks) console.log(`  ${c.key}: top ${c.top.slice(0, 2).map((p) => `${p.label} ×${p.n} @${Math.round(2040 + p.year)}`).join('; ') || 'none'}`);
console.log(`  buildTrends ${btMs.toFixed(1)} ms; ${t.shocks.reduce((a, c) => a + c.years.length, 0)} shock-years; ${t.markets.length} market entries`);
console.log(`  markets @${Math.round(2040 + 3000)}: ${marketsAt(t, 3000).slice(0, 3).map((m) => `${main.world.bodies[m.body].name} +${(m.now - m.then).toExponential(2)}$/yr`).join('; ') || 'none'}`);
console.log(bad ? `${bad} trends checks failed` : 'trends: all checks ok');
process.exit(bad ? 1 : 0);
