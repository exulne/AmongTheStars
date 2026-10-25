// Signals "as of" a cursor year: each metric's rate of change over a look-back
// window and its direction, the period's fastest-growing markets, and a shock
// category's count now against the window before. Everything reads only up to
// the year asked — no look-ahead — and is pure: it runs in Node, the worker
// and the page.

import { GLOBAL_METRICS, GM, NGM } from './metrics.ts';
import { periodOf } from './ledger.ts';
import type { Trends } from './trends.ts';

export type Dir = 'rising' | 'falling' | 'flat';
export const WINDOW = 50;      // years a signal looks back
export const RATE_FLAT = 0.1;  // %/yr: a CAGR within ±this is flat
/** absolute change over a window below which an index counts as flat */
export const DELTA_FLAT: Record<string, number> = { stability: 0.02, happiness: 0.02, gini: 0.01, medianAge: 0.5, lifeExp: 0.5, tfr: 0.05, shortage: 0.5, factions: 0.5, wars: 0.5, techs: 0.5, divergence: 0.01 };

export interface Signal {
  key: string;
  kind: 'rate' | 'delta';           // 'rate' iff GLOBAL_METRICS[GM[key]].log
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

/** A metric's change over the span before y, from the series rows already simulated then. */
export function signalAt(years: ArrayLike<number>, series: ArrayLike<number>, n: number, key: string, y: number, span = WINDOW): Signal | null {
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
  const rate = !!GLOBAL_METRICS[g].log;
  let change: number | null, dir: Dir;
  if (rate) {
    if (from > 0 && to > 0) {
      change = 100 * (Math.pow(to / from, 1 / t) - 1);
      dir = change > RATE_FLAT ? 'rising' : change < -RATE_FLAT ? 'falling' : 'flat';
    } else {
      change = null;
      dir = to > from ? 'rising' : to < from ? 'falling' : 'flat';
    }
  } else {
    change = to - from;
    const eps = DELTA_FLAT[key] ?? 0;
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

/** A shock category's count over the last span years against the span before that. */
export function shockSignal(t: Trends, key: string, y: number, span = WINDOW): { key: string; recent: number; before: number; dir: Dir } | null {
  const c = t.shocks.find((s) => s.key === key);
  if (!c) return null;
  const ys = c.years;
  const upper = (v: number) => { // first index with ys[i] > v
    let lo = 0, hi = ys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ys[m] <= v) lo = m + 1; else hi = m; }
    return lo;
  };
  const count = (lo: number, hi: number) => upper(hi) - upper(lo);
  const recent = count(y - span, y), before = count(y - 2 * span, y - span);
  return { key, recent, before, dir: recent > before ? 'rising' : recent < before ? 'falling' : 'flat' };
}

export interface TrendSection { id: string; title: string; question: string; how: string; metrics: string[]; chart: string[] | 'bespoke'; log: boolean }

/** The data sections of the Trends tab, in order. Belief and Ages stay narrative-only in the UI. */
export const SECTIONS: TrendSection[] = [
  {
    id: 'market', title: 'Market size and growth',
    question: 'How big is the market, how fast is it growing, and where?',
    how: 'National accounts and censuses: gross product, head-counts and product per head, by country and region.',
    metrics: ['gdp', 'pop', 'gdpPerCap'], chart: ['gdp', 'pop', 'gdpPerCap'], log: true,
  },
  {
    id: 'workforce', title: 'Workforce and ageing',
    question: 'Will there be workers, and how old will the customers be?',
    how: 'Vital statistics: births, deaths and causes registered at the event; life tables built from them.',
    metrics: ['medianAge', 'lifeExp', 'tfr', 'births', 'deaths'], chart: ['lifeExp', 'medianAge'], log: false,
  },
  {
    id: 'moves', title: 'Where people move',
    question: 'Where are customers and workers heading?',
    how: 'Border crossings, visas, address changes and phone/location data: origin–destination flows.',
    metrics: ['peopleTransported'], chart: 'bespoke', log: true,
  },
  {
    id: 'consumers', title: 'Consumers',
    question: 'How well off and how content are consumers, and who goes without?',
    how: 'Household surveys, sentiment polling and tax records: wellbeing, inequality (Gini) and shortages.',
    metrics: ['happiness', 'gini', 'shortage'], chart: ['happiness', 'gini'], log: false,
  },
  {
    id: 'risk', title: 'Political and operating risk',
    question: 'How safe is it to operate: stable rule, or breakaways and war?',
    how: 'Conflict databases (battle deaths), election and regime records, secession movements. Stability indices from polling and unrest counts.',
    metrics: ['stability', 'factions', 'wars', 'military'], chart: 'bespoke', log: true,
  },
  {
    id: 'costs', title: 'Costs and supply',
    question: 'What do energy, transport, insurance and materials cost, and is supply tight?',
    how: "Freight and launch price indices, insurers' premiums, utility statistics and commodity stock reports.",
    metrics: ['costPerKg', 'leoCostPerKg', 'energyPerCap', 'riskSpend', 'shortage', 'water', 'metals'], chart: ['costPerKg', 'leoCostPerKg'], log: true,
  },
  {
    id: 'innovation', title: 'Innovation and productivity',
    question: 'Is technology still paying off in output?',
    how: 'R&D and patent statistics, productivity accounts (total factor productivity).',
    metrics: ['tfp', 'research', 'techs'], chart: ['tfp'], log: true,
  },
  {
    id: 'shocks', title: 'Shocks',
    question: 'What could hit operations, and how often? Disaster and insurance risk.',
    how: "Disaster and incident registries; insurers' loss records.",
    metrics: [], chart: 'bespoke', log: false,
  },
  {
    id: 'divergence', title: 'Divergence',
    question: 'How fragmented are markets becoming?',
    how: 'Genomic and linguistic surveys: how far populations have drifted apart. Peoples that drift apart become separate markets, with different bodies, needs and products.',
    metrics: ['divergence'], chart: ['divergence'], log: false,
  },
];

export interface ReportRow {
  section: string;              // SECTIONS title
  key: string;                  // metric key, or `shock:${category key}` for the shocks section
  label: string;                // GLOBAL_METRICS label, or the shock category label
  unit: string;                 // metric unit; 'events' for shock rows
  kind: 'rate' | 'delta' | 'count';
  startYear: number; start: number;   // first usable row (NaN for count rows)
  endYear: number; end: number;       // last row, n - 1 (NaN for count rows)
  runChange: number | null;     // rate: CAGR %/yr start→end; delta: end - start; count: events over the whole run
  lastChange: number | null;    // the end-of-run signal: signalAt(…, years[n-1]).change; count: recent - before
  lastDir: Dir;
  peakYear: number; peak: number;      // turningPoints max; count: the busiest period (top[0].year, top[0].n)
  troughYear: number; trough: number;  // turningPoints min (NaN for count)
  riseYear: number; fallYear: number;  // steepest rise / fall (NaN for count)
}

/** The end-of-run report: one row per SECTIONS metric, plus one count row per shock category. */
export function buildReport(years: ArrayLike<number>, series: ArrayLike<number>, n: number, t: Trends): ReportRow[] {
  const rows: ReportRow[] = [];
  const at = (xs: number[], ys: number[], i: number) => i >= 0 && i < n ? { y: xs[i], v: ys[i] } : { y: NaN, v: NaN };
  for (const sec of SECTIONS) {
    if (sec.id === 'shocks') {
      for (const c of t.shocks) {
        const s = shockSignal(t, c.key, years[n - 1]);
        const top = c.top[0];
        rows.push({
          section: sec.title, key: `shock:${c.key}`, label: c.label, unit: 'events', kind: 'count',
          startYear: NaN, start: NaN, endYear: NaN, end: NaN,
          runChange: c.years.length, lastChange: s ? s.recent - s.before : null, lastDir: s?.dir ?? 'flat',
          peakYear: top ? top.year : NaN, peak: top ? top.n : NaN,
          troughYear: NaN, trough: NaN, riseYear: NaN, fallYear: NaN,
        });
      }
      continue;
    }
    for (const key of sec.metrics) {
      const g = GM[key], m = GLOBAL_METRICS[g], rate = !!m.log;
      let i0 = -1;
      for (let i = 0; i < n; i++) {
        const v = series[i * NGM + g];
        if (Number.isFinite(v) && (!rate || v > 0)) { i0 = i; break; }
      }
      const end = series[(n - 1) * NGM + g], endYear = years[n - 1];
      const start = i0 >= 0 ? series[i0 * NGM + g] : NaN, startYear = i0 >= 0 ? years[i0] : NaN;
      let runChange: number | null = null;
      if (i0 >= 0) runChange = rate
        ? (start > 0 && end > 0 && endYear > startYear ? 100 * (Math.pow(end / start, 1 / (endYear - startYear)) - 1) : null)
        : end - start;
      const s = signalAt(years, series, n, key, years[n - 1]);
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < n; i++) { xs.push(years[i]); ys.push(series[i * NGM + g]); }
      const tp = turningPoints(xs, ys, rate);
      const pk = at(xs, ys, tp.max), tr = at(xs, ys, tp.min);
      rows.push({
        section: sec.title, key, label: m.label, unit: m.unit, kind: rate ? 'rate' : 'delta',
        startYear, start, endYear, end,
        runChange, lastChange: s ? s.change : null, lastDir: s?.dir ?? 'flat',
        peakYear: pk.y, peak: pk.v, troughYear: tr.y, trough: tr.v,
        riseYear: at(xs, ys, tp.rise).y, fallYear: at(xs, ys, tp.fall).y,
      });
    }
  }
  return rows;
}
