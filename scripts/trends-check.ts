// Checks buildTrends in Node: edges, hotspot sanity, shares, founded, shocks —
// with faith events never entering the payload — plus the metric signals,
// report and CSVs of trendSignals.ts.
//   node scripts/trends-check.ts [seed]
import { EV } from '../src/sim/catalog.ts';
import { Engine } from '../src/sim/engine.ts';
import { FLOW, NPERIODS, isShipBody, periodOf, periodStart } from '../src/sim/ledger.ts';
import { GLOBAL_METRICS, GM, HIST_FIELDS, NGM } from '../src/sim/metrics.ts';
import { MARKET_WINDOW, buildTrends, type Trends } from '../src/sim/trends.ts';
import { REPORT_COLUMNS, SECTIONS, buildReport, countSignal, marketsAt, metricInfo, metricSignal, reportTable, rowAt, seriesTable, signalAt, topDestinationAt, type Ctx, type TrendMetric } from '../src/sim/trendSignals.ts';
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

// the history samples, indexed the way buildTrends does
const w = 2 + HIST_FIELDS.length;
const gdpCol = 2 + HIST_FIELDS.indexOf('gdp');
const popCol = 2 + HIST_FIELDS.indexOf('pop');
const sYear: number[] = [], sStart: number[] = [], sEnd: number[] = [];
for (let r = 0; r < main.histLen;) {
  const q = r;
  const step = main.hist[r * w];
  while (r < main.histLen && main.hist[r * w] === step) r++;
  sStart.push(q); sEnd.push(r); sYear.push(main.years[step]);
}
const sampleAt = (y: number): number => { let k = -1; for (let i = 0; i < sYear.length; i++) if (sYear[i] <= y) k = i; return k; };

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
  ok(c.top.every((p) => p.from === t.edges[Math.max(0, Math.min(NPERIODS - 1, periodOf(p.year)))] && p.from <= p.year), `${c.key}: top periods start on a period boundary`);
}

ok(!/faith|belief/i.test(JSON.stringify(t)), 'payload mentions no faith or belief');

// ---- shares and founded ----
{
  const sh = t.shares;
  ok(sh.year.length === sh.earthGdp.length && sh.year.length === sh.earthPop.length && sh.year.length === sh.top5Gdp.length, 'shares: equal lengths');
  let asc = true, range = true, within = true;
  for (let i = 0; i < sh.year.length; i++) {
    if (i && sh.year[i] <= sh.year[i - 1]) asc = false;
    if (sh.year[i] > t.upTo) within = false;
    for (const v of [sh.earthGdp[i], sh.earthPop[i], sh.top5Gdp[i]]) if (!(Number.isNaN(v) || (v >= 0 && v <= 100))) range = false;
  }
  ok(asc, 'shares: years ascending');
  ok(within, 'shares: years <= upTo');
  ok(range, 'shares: values in [0,100] or NaN');
  const k = sh.year.length - 1;
  if (k >= 0) {
    let g = 0, p = 0, eG = 0, eP = 0, hasE = false;
    const tops: number[] = [];
    const ki = sYear.indexOf(sh.year[k]);
    for (let r = sStart[ki]; r < sEnd[ki]; r++) {
      const b = main.hist[r * w + 1], pop = main.hist[r * w + popCol], gdp = main.hist[r * w + gdpCol];
      if (isShipBody(b) || !(pop > 0)) continue;
      g += gdp; p += pop;
      if (b === main.world.earth) { hasE = true; eG = gdp; eP = pop; }
      tops.push(gdp);
    }
    tops.sort((a, b) => b - a);
    const eq = (a: number, b: number) => Number.isNaN(a) && Number.isNaN(b) || Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
    ok(eq(sh.earthGdp[k], hasE && g > 0 ? 100 * eG / g : NaN), `shares earthGdp ${sh.earthGdp[k]} vs ${100 * eG / g}`);
    ok(eq(sh.earthPop[k], hasE && p > 0 ? 100 * eP / p : NaN), `shares earthPop ${sh.earthPop[k]} vs ${100 * eP / p}`);
    ok(eq(sh.top5Gdp[k], g > 0 ? 100 * tops.slice(0, 5).reduce((a, x) => a + x, 0) / g : NaN), `shares top5Gdp ${sh.top5Gdp[k]}`);
  }
  let asc2 = true, fCnt = 0;
  for (const ev of main.events) if (ev.type === EV['Colony founded'] && ev.year <= t.upTo) fCnt++;
  for (let i = 1; i < t.founded.length; i++) if (t.founded[i] < t.founded[i - 1]) asc2 = false;
  ok(asc2 && t.founded.length === fCnt, `founded: sorted, ${t.founded.length} vs ${fCnt} events`);
}

// ---- section lineup ----
{
  ok(JSON.stringify(SECTIONS.map((s) => s.id)) === JSON.stringify(['market', 'costs', 'pipeline', 'risk', 'hotspots', 'logistics', 'workforce', 'shocks', 'climate']),
    `SECTIONS order: ${SECTIONS.map((s) => s.id)}`);
  const banned = new Set(['leoCostPerKg', 'shortage', 'peopleTransported', 'happiness', 'gini', 'tfp', 'research', 'techs', 'divergence']);
  for (const sec of SECTIONS) for (const m of sec.metrics) {
    ok(!banned.has(m.key), `banned key ${m.key} in ${sec.id}`);
    if (m.src === 'series' || m.src === 'ratio') {
      for (const k of m.src === 'series' ? [m.key] : [m.num, m.den]) {
        const g = GM[k];
        ok(g !== undefined && !GLOBAL_METRICS[g].internal, `${sec.id}: ${k} is a public global metric`);
      }
    }
  }
  ok(!/faith|belief/i.test(JSON.stringify(SECTIONS)), 'SECTIONS mentions no faith or belief');
}

// ---- synthetic metricSignal ----
{
  const ny = 201;
  const years = Array.from({ length: ny }, (_, i) => i);
  const series = new Float64Array(ny * NGM);
  for (let i = 0; i < ny; i++) {
    series[i * NGM + GM.shipsLaunched] = 10;
    series[i * NGM + GM.shipsLost] = i * 0.1;
    series[i * NGM + GM.settlements] = i * 3;
  }
  const ctx: Ctx = { years, series, n: ny, t: null };
  // ratio: 100 * shipsLost / shipsLaunched
  const rm: TrendMetric = { src: 'ratio', key: 'shipLoss', label: 'r', unit: '%', num: 'shipsLost', den: 'shipsLaunched', scale: 100, flat: 0.5 };
  const rs = metricSignal(rm, ctx, 150)!;
  const rwant = 100 * (150 * 0.1 / 10 - 100 * 0.1 / 10);
  ok(rs && Math.abs(rs.change! - rwant) < 1e-9 && rs.dir === 'rising', `ratio @150: ${rs.change} vs ${rwant}`);
  // kind override: settlements as delta
  const dm: TrendMetric = { src: 'series', key: 'settlements', kind: 'delta', flat: 0.5 };
  const ds = metricSignal(dm, ctx, 150)!;
  ok(ds && ds.kind === 'delta' && ds.change === 450 - 300, `settlements-as-delta @150: ${ds.change}`);
  // sample: irregular share years
  const fakeT = {
    shares: { year: [0, 60, 120, 200], earthGdp: [90, 80, 70, 50], earthPop: [95, 90, 85, 80], top5Gdp: [99, 98, 97, 96] },
    founded: [10, 55, 60, 110, 120, 160], edges: [], upTo: 0, hot: [], markets: [], growthFrom: 0, shocks: [],
  } as unknown as Trends;
  const sm: TrendMetric = { src: 'sample', key: 'earthGdpShare', label: 's', unit: '%', flat: 1 };
  const ss = metricSignal(sm, { ...ctx, t: fakeT }, 150)!;
  ok(ss && ss.fromYear === 60 && ss.toYear === 120 && ss.from === 80 && ss.to === 70 && ss.change === -10 && ss.dir === 'falling', `sample @150: ${JSON.stringify(ss)}`);
  // count: (lo,hi] window edges
  const cm: TrendMetric = { src: 'count', key: 'founded', label: 'c', unit: 'events' };
  const cs = metricSignal(cm, { ...ctx, t: fakeT }, 160)!;
  ok(cs && cs.to === 2 && cs.from === 1, `count @160: recent ${cs.to} (want 2: 120,160), before ${cs.from} (want 1: 110)`);
  const cs2 = metricSignal(cm, { ...ctx, t: fakeT }, 60)!;
  ok(cs2 && cs2.to === 2 && cs2.from === 1, `count @60: recent ${cs2.to} (want 2: 55,60), before ${cs2.from} (want 1: 10)`);
}

// ---- signalAt basics on a synthetic series (kept) ----
{
  const ny = 201;
  const years = Array.from({ length: ny }, (_, i) => i);
  const series = new Float64Array(ny * NGM);
  for (let i = 0; i < ny; i++) {
    const o = i * NGM;
    series[o + GM.pop] = 1e6 * Math.pow(1.02, i);
    series[o + GM.gdp] = 5;
    series[o + GM.stability] = 0.5 + 0.001 * i;
    series[o + GM.interstellarPop] = i < 120 ? 0 : 100;
  }
  const sig = (k: string, y: number) => signalAt(years, series, ny, k, y);
  const pop = sig('pop', 150)!;
  ok(pop.kind === 'rate' && pop.fromYear === 100 && pop.toYear === 150 && Math.abs(pop.change! - 2) < 1e-9 && pop.dir === 'rising', `pop @150: ${JSON.stringify(pop)}`);
  const gdp = sig('gdp', 150)!;
  ok(gdp.change === 0 && gdp.dir === 'flat', `gdp @150: ${gdp.change} ${gdp.dir}`);
  const stab = sig('stability', 150)!;
  ok(stab.kind === 'delta' && Math.abs(stab.change! - 0.05) < 1e-12 && stab.dir === 'rising', `stability @150: ${stab.change} ${stab.dir}`);
  const isp = sig('interstellarPop', 150)!;
  ok(isp.change === null && isp.dir === 'rising', `interstellarPop @150: ${isp.change} ${isp.dir}`);
  ok(sig('faiths', 150) === null && sig('nope', 150) === null, 'internal/unknown keys are null');
  ok(rowAt(years, ny, -1) === -1, 'rowAt before the first row');
}

// ---- no look-ahead on the real run, every metric ----
{
  const n = main.st.step + 1;
  for (const Y of [137, 1500, 6000]) {
    const copy = main.series.slice();
    for (let i = 0; i < n; i++) if (main.years[i] > Y) for (let k = 0; k < NGM; k++) copy[i * NGM + k] = copy[i * NGM + k] * 3 + 1;
    const tc = structuredClone(t);
    tc.shares.year.push(t.upTo + 1);
    tc.shares.earthGdp.push(42); tc.shares.earthPop.push(42); tc.shares.top5Gdp.push(42);
    tc.founded.push(t.upTo + 1);
    for (const c of tc.shocks) c.years.push(t.upTo + 1);
    const before: Ctx = { years: main.years, series: main.series, n, t };
    const after: Ctx = { years: main.years, series: copy, n, t: tc };
    for (const sec of SECTIONS) for (const m of sec.metrics) {
      const a = JSON.stringify(metricSignal(m, before, Y));
      const b = JSON.stringify(metricSignal(m, after, Y));
      ok(a === b, `look-ahead: metricSignal(${m.key}, ${Y}) changes when data after ${Y} does`);
    }
    let anyDiff = false;
    for (const sec of SECTIONS) for (const m of sec.metrics) {
      if (JSON.stringify(metricSignal(m, before, Y + 300)) !== JSON.stringify(metricSignal(m, after, Y + 300))) anyDiff = true;
    }
    ok(anyDiff, `sanity: some signal at ${Y + 300} must differ on the altered copy`);
  }
  const dis = t.shocks.find((c) => c.key === 'disaster')!;
  const dwant = new Set(dis.types);
  let recent = 0;
  for (const ev of main.events) if (dwant.has(ev.type) && ev.year > 3000 - 50 && ev.year <= 3000) recent++;
  ok(countSignal(dis.years, 3000, 50).recent === recent, `countSignal disaster recent ${countSignal(dis.years, 3000, 50).recent} vs events ${recent}`);
}

// ---- markets (kept) ----
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

  const samples = sYear.map((year, k) => ({ year, rows: new Map<number, number>() }));
  for (let k = 0; k < sYear.length; k++) for (let r = sStart[k]; r < sEnd[k]; r++) samples[k].rows.set(main.hist[r * w + 1], main.hist[r * w + gdpCol]);
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

// ---- topDestinationAt ----
{
  const top = topDestinationAt(t, 3000);
  const p = periodOf(3000) - 1;
  ok(!!top && t.edges[p + 1] <= 3000, `topDestinationAt(3000): period ${p} complete`);
  if (top) {
    let want = 0;
    for (const h of t.hot) if (h.p === p && h.n > want) want = h.n;
    ok(top.n === want && top.p === p && top.from === t.edges[p] && top.to === t.edges[p + 1], `topDestinationAt(3000): ${main.world.bodies[top.body].name} n=${top.n} vs ${want}`);
  }
  ok(topDestinationAt(t, 0) === null, 'topDestinationAt(0): no completed period');
}

// ---- end-of-run report (buildReport) ----
{
  const n = main.st.step + 1;
  const rows = buildReport(main.years, main.series, n, t);
  const wantRows = SECTIONS.reduce((a, s) => a + s.metrics.length, 0);
  ok(rows.length === wantRows, `report rows ${rows.length} vs ${wantRows}`);
  const spanOf = new Map<string, number>();
  for (const sec of SECTIONS) for (const m of sec.metrics) spanOf.set(`${sec.title}|${metricInfo(m).key}`, metricInfo(m).span);
  let badR = 0;
  for (const r of rows) {
    if (r.span !== spanOf.get(`${r.section}|${r.key}`)) badR++;
    if (r.kind === 'count') {
      if (!Number.isFinite(r.peakYear) || periodStart(periodOf(r.peakYear)) !== r.peakYear) badR++;
    } else {
      if (r.endYear !== main.years[n - 1] && !(r.section === 'Market' && r.key.endsWith('Share'))) badR++;
      if (!Number.isFinite(r.end)) badR++;
      if (r.kind === 'delta' && (!Number.isFinite(r.start) || !Number.isFinite(r.runChange))) badR++;
      if (r.kind === 'rate' && (r.runChange !== null) !== (r.start > 0 && r.end > 0)) badR++;
      if (r.lastDir !== 'rising' && r.lastDir !== 'falling' && r.lastDir !== 'flat') badR++;
    }
  }
  ok(badR === 0, `report row sanity (${badR} bad)`);
  const sl = rows.find((r) => r.key === 'shipLoss')!;
  const wantSl = 100 * main.series[(n - 1) * NGM + GM.shipsLost] / main.series[(n - 1) * NGM + GM.shipsLaunched];
  ok(Math.abs(sl.end - wantSl) < 1e-9 * Math.max(1, Math.abs(wantSl)), `shipLoss end ${sl.end} vs ${wantSl}`);
  const es = rows.find((r) => r.key === 'earthGdpShare')!;
  ok(es.end === t.shares.earthGdp[t.shares.earthGdp.length - 1] && es.endYear === t.shares.year[t.shares.year.length - 1], `earthGdpShare end ${es.end} vs last sample`);
  ok(!/faith|belief/i.test(JSON.stringify(rows)), 'report mentions no faith or belief');

  // CSV copies
  const repCsv = toCsv(REPORT_COLUMNS, reportTable(rows), `Trends report, future #${seed}`);
  const repLines = repCsv.split('\n').filter((l) => l && !l.startsWith('#'));
  ok(repLines[0] === REPORT_COLUMNS.join(','), 'report CSV header');
  ok(repLines.length - 1 === rows.length, `report CSV ${repLines.length - 1} lines vs ${rows.length} rows`);
  ok(!/faith|belief/i.test(repCsv), 'report CSV mentions no faith or belief');

  const { columns, rows: srows } = seriesTable(main.years, main.series, n, t);
  const uniq = new Set<string>();
  for (const sec of SECTIONS) for (const m of sec.metrics) if (m.src !== 'count') uniq.add(m.key);
  ok(columns.length === 1 + uniq.size, `series columns ${columns.length} vs ${1 + uniq.size}`);
  ok(srows.length === n, `series rows ${srows.length} vs ${n}`);
  const serCsv = toCsv(columns, srows, `Trends series, future #${seed}`);
  const serLines = serCsv.split('\n').filter((l) => l && !l.startsWith('#'));
  ok(serLines.length - 1 === n, `series CSV ${serLines.length - 1} lines vs ${n}`);
  const numCell = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  ok(serLines.slice(1).every((l) => l.split(',').every((c) => c === '' || numCell.test(c))), 'series CSV cells are numbers or empty');
  ok(!/faith|belief/i.test(serCsv), 'series CSV mentions no faith or belief');
}

console.log(`  ${t.hot.length} hot entries; top 3: ${[...t.hot].sort((a, b) => b.n - a.n).slice(0, 3).map((h) => `${main.world.bodies[h.body].name} ${Math.round(h.n)}`).join('; ')}`);
for (const c of t.shocks) console.log(`  ${c.key}: top ${c.top.slice(0, 2).map((p) => `${p.label} ×${p.n} @${Math.round(2040 + p.year)}`).join('; ') || 'none'}`);
console.log(`  buildTrends ${btMs.toFixed(1)} ms; ${t.shocks.reduce((a, c) => a + c.years.length, 0)} shock-years; ${t.markets.length} market entries; ${t.founded.length} founded; ${t.shares.year.length} share samples`);
console.log(`  markets @${Math.round(2040 + 3000)}: ${marketsAt(t, 3000).slice(0, 3).map((m) => `${main.world.bodies[m.body].name} +${(m.now - m.then).toExponential(2)}$/yr`).join('; ') || 'none'}`);
console.log(bad ? `${bad} trends checks failed` : 'trends: all checks ok');
process.exit(bad ? 1 : 0);
