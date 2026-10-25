// Signals "as of" a cursor year: each metric's change over a look-back window
// and its direction, the period's fastest-growing markets and top migration
// destination, and event counts now against the window before. Everything
// reads only up to the year asked — no look-ahead — and is pure: it runs in
// Node, the worker and the page.

import { GLOBAL_METRICS, GM, NGM } from './metrics.ts';
import { periodOf, periodStart } from './ledger.ts';
import type { Trends } from './trends.ts';

export type Dir = 'rising' | 'falling' | 'flat';
export const WINDOW = 50;      // years a signal looks back
export const RATE_FLAT = 0.1;  // %/yr: a CAGR within ±this is flat
/** absolute change over a window below which an index counts as flat */
export const DELTA_FLAT: Record<string, number> = {
  stability: 0.02, happiness: 0.02, gini: 0.01, medianAge: 0.5, lifeExp: 0.5, tfr: 0.05, shortage: 0.5,
  factions: 0.5, wars: 0.5, techs: 0.5, divergence: 0.01,
  earthTemp: 0.1, seaLevel: 0.05, aerosol: 0.01,
  impacts: 0.5, eruptions: 0.5, stellarStorms: 0.5, terraformed: 0.5, transportShare: 0.01,
};

export interface Signal {
  key: string;
  kind: 'rate' | 'delta';           // 'rate' iff GLOBAL_METRICS[GM[key]].log, unless overridden
  fromYear: number; from: number;   // the latest row at or before y - span (row 0 if none)
  toYear: number; to: number;       // the latest row at or before y
  change: number | null;            // rate: CAGR in %/yr between the two rows; delta: to - from
  dir: Dir;
}

/** The index of the last of the first n rows with years[i] <= y (-1 if there is none). years is ascending. */
export function rowAt(years: ArrayLike<number>, n: number, y: number): number {
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (years[m] <= y) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/** A metric's change over the span before y, from the series rows already simulated then.
 *  kind/flat override the metric's defaults (its log flag and RATE_FLAT / DELTA_FLAT[key]). */
export function signalAt(years: ArrayLike<number>, series: ArrayLike<number>, n: number, key: string, y: number, span = WINDOW, kind?: 'rate' | 'delta', flat?: number): Signal | null {
  const g = GM[key];
  if (g === undefined || GLOBAL_METRICS[g].internal) return null;
  const i1 = rowAt(years, n, y);
  if (i1 < 0) return null;
  let i0 = rowAt(years, n, y - span);
  if (i0 < 0) i0 = 0;
  if (i0 >= i1) return null;
  const from = series[i0 * NGM + g], to = series[i1 * NGM + g];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const t = years[i1] - years[i0];
  const rate = kind ? kind === 'rate' : !!GLOBAL_METRICS[g].log;
  let change: number | null, dir: Dir;
  if (rate) {
    const eps = flat ?? RATE_FLAT;
    if (from > 0 && to > 0) {
      change = 100 * (Math.pow(to / from, 1 / t) - 1);
      dir = change > eps ? 'rising' : change < -eps ? 'falling' : 'flat';
    } else {
      change = null;
      dir = to > from ? 'rising' : to < from ? 'falling' : 'flat';
    }
  } else {
    change = to - from;
    const eps = flat ?? DELTA_FLAT[key] ?? 0;
    dir = change > eps ? 'rising' : change < -eps ? 'falling' : 'flat';
  }
  return { key, kind: rate ? 'rate' : 'delta', fromYear: years[i0], from, toYear: years[i1], to, change, dir };
}

/** The indices where a series peaks, bottoms and turns sharpest (rise/fall over lag = n/50 steps). */
export function turningPoints(xs: ArrayLike<number>, ys: ArrayLike<number>, log: boolean): { max: number; min: number; rise: number; fall: number } {
  const n = Math.min(xs.length, ys.length), out = { max: -1, min: -1, rise: -1, fall: -1 };
  const lag = Math.max(1, Math.round(n / 50));
  let mx = -Infinity, mn = Infinity, up = log ? 1 : 0, dn = log ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (Number.isFinite(v)) {
      if (v > mx) { mx = v; out.max = i; }
      if (v < mn) { mn = v; out.min = i; }
    }
    const j = i + lag;
    if (j >= n || !Number.isFinite(v) || !Number.isFinite(ys[j])) continue;
    const w = ys[j];
    if (log) {
      if (v <= 0 || w <= 0) continue;
      const r = w / v;
      if (r > up) { up = r; out.rise = j; }
      if (r < dn) { dn = r; out.fall = j; }
    } else {
      const d = w - v;
      if (d > up) { up = d; out.rise = j; }
      if (d < dn) { dn = d; out.fall = j; }
    }
  }
  return out;
}

/** The period's fastest-growing markets, as of y. */
export function marketsAt(t: Trends, y: number): Trends['markets'] {
  const p = periodOf(y);
  return t.markets.filter((m) => m.p === p);
}

/** Events of a sorted year list in (y - span, y] against (y - 2·span, y - span]. */
export function countSignal(years: ArrayLike<number>, y: number, span: number): { recent: number; before: number; dir: Dir } {
  const upper = (v: number) => { // first index with years[i] > v
    let lo = 0, hi = years.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (years[m] <= v) lo = m + 1; else hi = m; }
    return lo;
  };
  const count = (lo: number, hi: number) => upper(hi) - upper(lo);
  const recent = count(y - span, y), before = count(y - 2 * span, y - span);
  return { recent, before, dir: recent > before ? 'rising' : recent < before ? 'falling' : 'flat' };
}

/** A shock category's count over the last span years against the span before that. */
export function shockSignal(t: Trends, key: string, y: number, span = WINDOW): { key: string; recent: number; before: number; dir: Dir } | null {
  const c = t.shocks.find((s) => s.key === key);
  return c ? { key, ...countSignal(c.years, y, span) } : null;
}

/** The busiest destination of the last completed arrival period at y (from/to are its period bounds). */
export function topDestinationAt(t: Trends, y: number): { p: number; from: number; to: number; body: number; n: number; src: number } | null {
  const p = periodOf(y) - 1;
  if (p < 0 || t.edges[p + 1] > y) return null;
  let top: Trends['hot'][number] | null = null;
  for (const h of t.hot) if (h.p === p && (!top || h.n > top.n)) top = h;
  return top ? { p, from: t.edges[p], to: t.edges[p + 1], body: top.body, n: top.n, src: top.from } : null;
}

export type MetricKind = 'rate' | 'delta' | 'count';
/** One measured quantity of a section; span = its signal window in years (default WINDOW = 50). level: show its current value in the signal line. */
export type TrendMetric =
  | { src: 'series'; key: string; kind?: 'rate' | 'delta'; flat?: number; span?: number; level?: true }     // a GLOBAL_METRICS column; kind defaults to its log flag, flat to RATE_FLAT / DELTA_FLAT
  | { src: 'ratio'; key: string; label: string; unit: string; num: string; den: string; scale: number; flat: number; span?: number; level?: true } // scale·num/den of two columns per row (NaN when den <= 0), a delta
  | { src: 'sample'; key: 'earthGdpShare' | 'earthPopShare' | 'top5GdpShare'; label: string; unit: string; flat: number; span?: number; level?: true } // a share series from the trends payload, a delta
  | { src: 'lag'; key: 'newsLag'; label: string; unit: 'yr'; flat: number; span?: number; level?: true }          // mean lag of the innovations in a window
  | { src: 'count'; key: string; label: string; unit: string; span?: number };                                // event years from the payload: the window against the one before
export interface TrendSection { id: string; title: string; question: string; how: string; metrics: TrendMetric[]; chart: string[] | 'bespoke' | 'none'; log: boolean }
export interface Ctx { years: ArrayLike<number>; series: ArrayLike<number>; n: number; t: Trends | null }
export interface MetricSignal { key: string; label: string; unit: string; kind: MetricKind; span: number; fromYear: number; from: number; toYear: number; to: number; change: number | null; dir: Dir }

/** A metric's display facts: key, label, unit, kind (log → rate) and its window. */
export function metricInfo(m: TrendMetric): { key: string; label: string; unit: string; kind: MetricKind; span: number } {
  const span = m.span ?? WINDOW;
  if (m.src === 'series') {
    const g = GLOBAL_METRICS[GM[m.key]];
    return { key: m.key, label: g.label, unit: g.unit, kind: m.kind ?? (g.log ? 'rate' : 'delta'), span };
  }
  if (m.src === 'count') return { key: m.key, label: m.label, unit: m.unit, kind: 'count', span };
  return { key: m.key, label: m.label, unit: m.unit, kind: 'delta', span };
}

/** The mean innovation lag with year in (lo, hi] — NaN when the window is empty. */
function lagMean(inn: Trends['innovations'], lo: number, hi: number): number {
  const ys = inn.year;
  const upper = (v: number) => {
    let a = 0, b = ys.length;
    while (a < b) { const m = (a + b) >> 1; if (ys[m] <= v) a = m + 1; else b = m; }
    return a;
  };
  let s = 0, n = 0;
  for (let i = upper(lo); i < upper(hi); i++) { s += inn.lag[i]; n++; }
  return n ? s / n : NaN;
}

const SHARE_KEY = { earthGdpShare: 'earthGdp', earthPopShare: 'earthPop', top5GdpShare: 'top5Gdp' } as const;

/** The event years a count metric reads: 'founded' or `shock:<category>`. */
function countYears(m: TrendMetric & { src: 'count' }, t: Trends): number[] | null {
  if (m.key === 'founded') return t.founded;
  if (m.key === 'innovations') return t.innovations.year;
  if (m.key.startsWith('shock:')) return t.shocks.find((c) => c.key === m.key.slice(6))?.years ?? null;
  return null;
}

/** A metric's per-row values over the run (null for count metrics, which have no series). */
export function metricSeries(m: TrendMetric, c: Ctx): { xs: number[]; ys: number[] } | null {
  const xs = Array.from({ length: c.n }, (_, i) => c.years[i]);
  if (m.src === 'series') return { xs, ys: xs.map((_, i) => c.series[i * NGM + GM[m.key]]) };
  if (m.src === 'ratio') {
    const num = GM[m.num], den = GM[m.den];
    return { xs, ys: xs.map((_, i) => { const d = c.series[i * NGM + den]; return d > 0 ? m.scale * c.series[i * NGM + num] / d : NaN; }) };
  }
  if (m.src === 'sample') return c.t ? { xs: c.t.shares.year, ys: c.t.shares[SHARE_KEY[m.key]] } : null;
  if (m.src === 'lag') {
    const span = m.span ?? WINDOW;
    return c.t ? { xs, ys: xs.map((y) => lagMean(c.t!.innovations, y - span, y)) } : null;
  }
  return null;
}

/** A metric's signal at cursor year y, reading only rows, samples and events at or before y. */
export function metricSignal(m: TrendMetric, c: Ctx, y: number): MetricSignal | null {
  const info = metricInfo(m);
  if (m.src === 'count') {
    const ys = c.t ? countYears(m, c.t) : null;
    if (!ys) return null;
    const s = countSignal(ys, y, info.span);
    return { ...info, fromYear: y - 2 * info.span, from: s.before, toYear: y, to: s.recent, change: s.recent - s.before, dir: s.dir };
  }
  if (m.src === 'series') {
    const s = signalAt(c.years, c.series, c.n, m.key, y, info.span, info.kind as 'rate' | 'delta', m.flat);
    return s ? { ...info, fromYear: s.fromYear, from: s.from, toYear: s.toYear, to: s.to, change: s.change, dir: s.dir } : null;
  }
  if (m.src === 'lag') {
    if (!c.t) return null;
    const to = lagMean(c.t.innovations, y - info.span, y), from = lagMean(c.t.innovations, y - 2 * info.span, y - info.span);
    if (!Number.isFinite(to) || !Number.isFinite(from)) return null;
    const change = to - from;
    return { ...info, fromYear: y - info.span, from, toYear: y, to, change, dir: change > m.flat ? 'rising' : change < -m.flat ? 'falling' : 'flat' };
  }
  const xs = m.src === 'ratio' ? c.years : c.t?.shares.year;
  if (!xs) return null;
  const n = m.src === 'ratio' ? c.n : xs.length;
  const i1 = rowAt(xs, n, y);
  if (i1 < 0) return null;
  let i0 = rowAt(xs, n, y - info.span);
  if (i0 < 0) i0 = 0;
  if (i0 >= i1) return null;
  const val = (i: number): number => {
    if (m.src === 'ratio') {
      const d = c.series[i * NGM + GM[m.den]];
      return d > 0 ? m.scale * c.series[i * NGM + GM[m.num]] / d : NaN;
    }
    return c.t!.shares[SHARE_KEY[(m as TrendMetric & { src: 'sample' }).key]][i];
  };
  const from = val(i0), to = val(i1);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const change = to - from;
  return { ...info, fromYear: xs[i0], from, toYear: xs[i1], to, change, dir: change > m.flat ? 'rising' : change < -m.flat ? 'falling' : 'flat' };
}

/** The data sections of the Trends tab, in order. Ages stays narrative-only in the UI. */
export const SECTIONS: TrendSection[] = [
  {
    id: 'market', title: 'Market',
    question: 'How big is the market, how concentrated is it, and where is it growing?',
    how: 'National accounts and censuses: gross product, head-counts and product per head, and each region\'s share of them.',
    metrics: [
      { src: 'sample', key: 'earthGdpShare', label: "Earth's share of product", unit: '%', flat: 1, level: true },
      { src: 'sample', key: 'earthPopShare', label: "Earth's share of people", unit: '%', flat: 1, level: true },
      { src: 'sample', key: 'top5GdpShare', label: "Top 5 worlds' share of product", unit: '%', flat: 1, level: true },
      { src: 'series', key: 'gdp' }, { src: 'series', key: 'pop' }, { src: 'series', key: 'gdpPerCap' },
    ],
    chart: ['gdp', 'pop', 'gdpPerCap'], log: true,
  },
  {
    id: 'costs', title: 'Costs and supply',
    question: 'What do freight, energy, insurance and materials cost?',
    how: "Freight price indices, insurers' premiums, utility statistics and commodity stock reports.",
    metrics: [
      { src: 'series', key: 'costPerKg' }, { src: 'series', key: 'energyPerCap' }, { src: 'series', key: 'riskSpend' },
      { src: 'series', key: 'water' }, { src: 'series', key: 'metals' },
    ],
    chart: ['costPerKg', 'energyPerCap'], log: true,
  },
  {
    id: 'pipeline', title: 'New-market pipeline',
    question: 'Where will the next markets come from, and how fast are they opening?',
    how: 'Registries of new settlements and incorporations, and surveys of how far the frontier reaches.',
    metrics: [
      { src: 'series', key: 'settlements', kind: 'delta', flat: 0.5, level: true },
      { src: 'count', key: 'founded', label: 'Colonies founded', unit: 'colonies', span: 100 },
      { src: 'series', key: 'systems', kind: 'delta', flat: 0.5, level: true },
      { src: 'series', key: 'reach', kind: 'delta', flat: 0.5, level: true },
    ],
    chart: ['settlements', 'systems'], log: true,
  },
  {
    id: 'risk', title: 'Political and operating risk',
    question: 'How fragmented is power, and how safe is it to operate?',
    how: 'Conflict databases (battle deaths), election and regime records, secession movements. Stability indices from polling and unrest counts.',
    metrics: [
      { src: 'series', key: 'factions', level: true }, { src: 'series', key: 'stability' },
      { src: 'series', key: 'wars' }, { src: 'series', key: 'military' },
    ],
    chart: 'bespoke', log: true,
  },
  {
    id: 'hotspots', title: 'Migration hotspots',
    question: 'Where are people arriving?',
    how: 'Border crossings, visas, address changes and phone/location data: origin–destination flows.',
    metrics: [], chart: 'none', log: false,
  },
  {
    id: 'logistics', title: 'Logistics capacity and reliability',
    question: 'How much can be shipped, and how much of it arrives?',
    how: 'Port and carrier statistics: tonnage dispatched, sailings, losses and the share of output spent on transport.',
    metrics: [
      { src: 'series', key: 'payloadDispatched', span: 100 },
      { src: 'series', key: 'launches', span: 100 },
      { src: 'ratio', key: 'shipLoss', label: 'Ships lost, of all launched', unit: '%', num: 'shipsLost', den: 'shipsLaunched', scale: 100, flat: 0.5, span: 100, level: true },
      { src: 'series', key: 'transportShare', span: 100, level: true },
    ],
    chart: ['payloadDispatched', 'launches'], log: true,
  },
  {
    id: 'workforce', title: 'Workforce and ageing',
    question: 'Will there be workers, and how old will the customers be?',
    how: 'Vital statistics: births, deaths and causes registered at the event; life tables built from them.',
    metrics: [
      { src: 'series', key: 'medianAge' }, { src: 'series', key: 'lifeExp' }, { src: 'series', key: 'tfr' },
      { src: 'series', key: 'births' }, { src: 'series', key: 'deaths' },
    ],
    chart: ['lifeExp', 'medianAge'], log: false,
  },
  {
    id: 'shocks', title: 'Shocks',
    question: 'What could hit operations, and how often? Disaster and insurance risk.',
    how: "Disaster and incident registries; insurers' loss records.",
    metrics: [
      { src: 'count', key: 'shock:disaster', label: 'Disasters', unit: 'events', span: 100 },
      { src: 'count', key: 'shock:conflict', label: 'War and strikes', unit: 'events', span: 100 },
      { src: 'count', key: 'shock:unrest', label: 'Unrest and breakaways', unit: 'events', span: 100 },
      { src: 'count', key: 'shock:growth', label: 'Growth', unit: 'events', span: 100 },
      { src: 'count', key: 'shock:innovation', label: 'Innovation', unit: 'events', span: 100 },
    ],
    chart: 'bespoke', log: false,
  },
  {
    id: 'adoption', title: 'Technology adoption lag',
    question: 'How long until new technology reaches customers?',
    how: 'News travels at light speed: an innovation made on one world reaches people as many years later as they are light years away. Averaged over the innovations of each window and weighted by where people live.',
    metrics: [
      { src: 'lag', key: 'newsLag', label: 'News lag', unit: 'yr', flat: 1, span: 100, level: true },
      { src: 'count', key: 'innovations', label: 'Innovations', unit: 'events', span: 100 },
    ],
    chart: 'bespoke', log: false,
  },
  {
    id: 'climate', title: 'Climate and physical risk',
    question: 'What physical risks do worlds and the assets on them face?',
    how: 'Weather and geological surveys, sea-level gauges, impact and eruption registries, and terraforming surveys.',
    metrics: [
      { src: 'series', key: 'earthTemp', level: true }, { src: 'series', key: 'seaLevel', level: true },
      { src: 'series', key: 'aerosol' }, { src: 'series', key: 'impacts' }, { src: 'series', key: 'eruptions' },
      { src: 'series', key: 'stellarStorms' }, { src: 'series', key: 'terraformed', level: true },
    ],
    chart: ['earthTemp'], log: false,
  },
];

export interface ReportRow {
  section: string;              // SECTIONS title
  key: string;                  // metric key, or `shock:${category key}` for the shocks section
  label: string;                // metric label, or the shock category label
  unit: string;                 // metric unit; 'events'/'colonies' for count rows
  kind: MetricKind;
  span: number;                 // the metric's signal window, years
  startYear: number; start: number;   // first usable row (NaN for count rows)
  endYear: number; end: number;       // last row, n - 1 (NaN for count rows)
  runChange: number | null;     // rate: CAGR %/yr start→end; delta: end - start; count: events over the whole run
  lastChange: number | null;    // the end-of-run signal's change; count: recent - before
  lastDir: Dir;
  peakYear: number; peak: number;      // turningPoints max; count: the busiest period's start and count
  troughYear: number; trough: number;  // turningPoints min (NaN for count)
  riseYear: number; fallYear: number;  // steepest rise / fall (NaN for count)
}

/** The end-of-run report: one row per metric of every section (hotspots contributes none). */
export function buildReport(years: ArrayLike<number>, series: ArrayLike<number>, n: number, t: Trends): ReportRow[] {
  const rows: ReportRow[] = [];
  const ctx: Ctx = { years, series, n, t };
  const at = (xs: number[], ys: number[], i: number) => i >= 0 && i < xs.length ? { y: xs[i], v: ys[i] } : { y: NaN, v: NaN };
  for (const sec of SECTIONS) {
    for (const m of sec.metrics) {
      const info = metricInfo(m);
      if (m.src === 'count') {
        const ys = countYears(m, t) ?? [];
        const s = countSignal(ys, years[n - 1], info.span);
        const perP = new Map<number, number>();
        for (const yr of ys) perP.set(periodOf(yr), (perP.get(periodOf(yr)) ?? 0) + 1);
        let pk = -1, pn = 0;
        for (const [p, c] of perP) if (c > pn) { pk = p; pn = c; }   // first max wins: lowest p, per Map order
        rows.push({
          section: sec.title, key: info.key, label: info.label, unit: info.unit, kind: 'count', span: info.span,
          startYear: NaN, start: NaN, endYear: NaN, end: NaN,
          runChange: ys.length, lastChange: s.recent - s.before, lastDir: s.dir,
          peakYear: pk >= 0 ? periodStart(pk) : NaN, peak: pn || NaN,
          troughYear: NaN, trough: NaN, riseYear: NaN, fallYear: NaN,
        });
        continue;
      }
      const ser = metricSeries(m, ctx);
      const rate = info.kind === 'rate';
      let i0 = -1;
      if (ser) for (let i = 0; i < ser.ys.length; i++) if (Number.isFinite(ser.ys[i]) && (!rate || ser.ys[i] > 0)) { i0 = i; break; }
      const end = ser ? ser.ys[ser.ys.length - 1] : NaN, endYear = ser ? ser.xs[ser.xs.length - 1] : NaN;
      const start = i0 >= 0 ? ser!.ys[i0] : NaN, startYear = i0 >= 0 ? ser!.xs[i0] : NaN;
      let runChange: number | null = null;
      if (i0 >= 0) runChange = rate
        ? (start > 0 && end > 0 && endYear > startYear ? 100 * (Math.pow(end / start, 1 / (endYear - startYear)) - 1) : null)
        : end - start;
      const s = metricSignal(m, ctx, years[n - 1]);
      const tp = ser ? turningPoints(ser.xs, ser.ys, rate) : { max: -1, min: -1, rise: -1, fall: -1 };
      const xs = ser?.xs ?? [], ys2 = ser?.ys ?? [];
      const pk2 = at(xs, ys2, tp.max), tr = at(xs, ys2, tp.min);
      rows.push({
        section: sec.title, key: info.key, label: info.label, unit: info.unit, kind: info.kind, span: info.span,
        startYear, start, endYear, end,
        runChange, lastChange: s ? s.change : null, lastDir: s?.dir ?? 'flat',
        peakYear: pk2.y, peak: pk2.v, troughYear: tr.y, trough: tr.v,
        riseYear: at(xs, ys2, tp.rise).y, fallYear: at(xs, ys2, tp.fall).y,
      });
    }
  }
  return rows;
}

export const REPORT_COLUMNS = ['section', 'key', 'label', 'unit', 'kind', 'window_years', 'start_year', 'start_value', 'end_year', 'end_value', 'run_change', 'run_change_kind', 'last_window_change', 'last_window_direction', 'peak_year', 'peak_value', 'trough_year', 'trough_value', 'steepest_rise_year', 'steepest_fall_year'];
/** Report rows as table rows, in REPORT_COLUMNS order: years as calendar years (2040 + year), null as NaN (exported as an empty cell), run_change_kind 'CAGR %/yr' | 'absolute' | 'events'. */
export function reportTable(rows: ReportRow[]): (string | number)[][] {
  const cal = (y: number) => 2040 + y;
  return rows.map((r) => [
    r.section, r.key, r.label, r.unit, r.kind, r.span,
    cal(r.startYear), r.start, cal(r.endYear), r.end,
    r.runChange ?? NaN, r.kind === 'rate' ? 'CAGR %/yr' : r.kind === 'delta' ? 'absolute' : 'events',
    r.lastChange ?? NaN, r.lastDir,
    cal(r.peakYear), r.peak, cal(r.troughYear), r.trough, cal(r.riseYear), cal(r.fallYear),
  ]);
}

/** Every non-count SECTIONS metric over the run: columns ['year', ...unique metric keys in SECTIONS order],
 *  one row per simulated step (year as 2040 + year). Sample values are the latest share sample at or before the row's year. */
export function seriesTable(years: ArrayLike<number>, series: ArrayLike<number>, n: number, t: Trends | null): { columns: string[]; rows: number[][] } {
  const keys: string[] = [];
  for (const sec of SECTIONS) for (const m of sec.metrics) if (m.src !== 'count' && !keys.includes(m.key)) keys.push(m.key);
  const ctx: Ctx = { years, series, n, t };
  const cols = new Map<string, { xs: number[]; ys: number[] } | null>();
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = [2040 + years[i]];
    for (const k of keys) {
      const m = SECTIONS.flatMap((s) => s.metrics).find((x) => x.key === k)!;
      if (m.src === 'sample') {
        let s = cols.get(k);
        if (s === undefined) { s = metricSeries(m, ctx); cols.set(k, s); }
        const j = s ? rowAt(s.xs, s.xs.length, years[i]) : -1;
        row.push(j >= 0 ? s!.ys[j] : NaN);
      } else {
        row.push(m.src === 'ratio'
          ? (ctx.series[i * NGM + GM[m.den]] > 0 ? m.scale * ctx.series[i * NGM + GM[m.num]] / ctx.series[i * NGM + GM[m.den]] : NaN)
          : ctx.series[i * NGM + GM[m.key]]);
      }
    }
    rows.push(row);
  }
  return { columns: ['year', ...keys], rows };
}
