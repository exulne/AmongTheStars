// Society-level trends over the whole run, computed once from the ledger and
// the event log: who moved where and when, what shocks fell in each period.
// Pure — runs in the worker and in Node. Faith stays out of the data channel:
// nothing here counts or names a faith.

import { EVENT_NAMES, EV } from './catalog.ts';
import type { Engine } from './engine.ts';
import { FLOW, NPERIODS, isShipBody, periodOf, periodStart } from './ledger.ts';
import { HIST_FIELDS } from './metrics.ts';

export const MARKET_WINDOW = 100;
export interface TrendPoint { year: number; body: number; n: number; label: string }
export interface Trends {
  edges: number[];           // periodStart(p) for p = 0..NPERIODS; bucket p = [edges[p], edges[p+1])
  upTo: number;              // year the run has reached
  moved: number[];           // per departure period: people who set out (all flows but landings)
  lost: number[];            // same, only the flows that were lost
  hot: { p: number; year: number; body: number; n: number; from: number }[]; // up to 3 busiest destinations per arrival period
  /** for each period p with edges[p] <= upTo, up to 5 worlds with the largest gain in product
   *  (gdp, $/yr) over the MARKET_WINDOW years before edges[p]. Only gain > 0.
   *  Sorted by p, then by gain descending. year = edges[p]. */
  markets: { p: number; year: number; body: number; now: number; then: number }[];
  shocks: { key: string; label: string; types: number[]; counts: number[]; years: number[]; top: TrendPoint[] }[];
}

const SHOCKS: { key: string; label: string; types: number[] }[] = [
  {
    key: 'disaster', label: 'Disasters', types: [
      EV.Plague, EV['Habitat breach'], EV['Asteroid strike'], EV.Famine, EV['Gamma-ray burst'], EV.Supernova,
      EV['Dark forest strike'], EV['Reactor accident'], EV['Solar storm'], EV.Airburst, EV['Impact winter'],
      EV.Eruption, EV.Supereruption, EV['Great earthquake'], EV['Io outburst'], EV['Kessler cascade'],
    ],
  },
  { key: 'conflict', label: 'War and strikes', types: [EV.War, EV['Kinetic strike']] },
  { key: 'unrest', label: 'Unrest and breakaways', types: [EV.Revolt, EV.Independence, EV.Collapse, EV['Mutiny in transit'], EV.Abandoned] },
  { key: 'growth', label: 'Growth', types: [EV['Colony founded'], EV['Stage up'], EV['Baby boom']] },
  { key: 'innovation', label: 'Innovation', types: [EV.Invention, EV.Technology, EV.Breakthrough] },
];
// faith events never enter the data channel (see the annals for their story)
const FAITH_EVENTS = new Set([EV['New faith'], EV.Schism, EV['AI schism']]);
for (const s of SHOCKS) for (const t of s.types) if (FAITH_EVENTS.has(t)) throw new Error('faith event in the data channel');

export function buildTrends(e: Engine): Trends | null {
  if (!e.ledger) return null;
  const edges = Array.from({ length: NPERIODS + 1 }, (_, p) => periodStart(p));
  const upTo = e.years[e.st.step];
  const moved = new Array<number>(NPERIODS).fill(0);
  const lost = new Array<number>(NPERIODS).fill(0);
  const hotBy = new Map<number, Map<number, number>>();      // pArrive → dst → arrivals
  const srcBy = new Map<number, Map<number, Map<number, number>>>(); // pArrive → dst → src → n
  for (const f of e.ledger.flows) {
    if (f.kind === FLOW.LANDING) continue;
    if (f.p >= 0 && f.p < NPERIODS) {
      moved[f.p] += f.n;
      if (f.lost) lost[f.p] += f.n;
    }
    if (f.lost || isShipBody(f.dst) || f.pArrive < 0 || f.pArrive >= NPERIODS) continue;
    if (periodStart(f.pArrive) > upTo) continue;
    const dsts = hotBy.get(f.pArrive) ?? new Map<number, number>();
    if (!hotBy.has(f.pArrive)) hotBy.set(f.pArrive, dsts);
    dsts.set(f.dst, (dsts.get(f.dst) ?? 0) + f.n);
    const srcs = srcBy.get(f.pArrive) ?? new Map<number, Map<number, number>>();
    if (!srcBy.has(f.pArrive)) srcBy.set(f.pArrive, srcs);
    const ss = srcs.get(f.dst) ?? new Map<number, number>();
    if (!srcs.has(f.dst)) srcs.set(f.dst, ss);
    ss.set(f.src, (ss.get(f.src) ?? 0) + f.n);
  }
  const hot: Trends['hot'] = [];
  for (const [p, dsts] of hotBy) {
    const top = [...dsts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [dst, n] of top) {
      let from = -1, best = 0;
      for (const [s, m] of srcBy.get(p)?.get(dst) ?? []) if (!isShipBody(s) && m > best) { best = m; from = s; }
      hot.push({ p, year: edges[p], body: dst, n, from });
    }
  }
  hot.sort((a, b) => a.p - b.p || b.n - a.n);

  // markets: index the settlement-history samples once (a run of rows sharing a
  // step), then per period compare each living world's product to the sample a
  // MARKET_WINDOW earlier. A world missing from a sample is dead or not yet
  // settled, so it has no market there — no falling back to an older sample.
  const w = 2 + HIST_FIELDS.length;
  const gdpCol = 2 + HIST_FIELDS.indexOf('gdp');
  const sYear: number[] = [], sStart: number[] = [], sEnd: number[] = [];
  for (let r = 0; r < e.histLen;) {
    const q = r;
    const step = e.hist[r * w];
    while (r < e.histLen && e.hist[r * w] === step) r++;
    sStart.push(q); sEnd.push(r); sYear.push(e.years[step]);
  }
  const sampleAt = (y: number): number => {
    let lo = 0, hi = sYear.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (sYear[m] <= y) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  };
  const memo = new Map<number, Map<number, number>>();
  const gdpAt = (k: number) => {
    let m = memo.get(k);
    if (!m) {
      m = new Map<number, number>();
      if (k >= 0) for (let r = sStart[k]; r < sEnd[k]; r++) m.set(e.hist[r * w + 1], e.hist[r * w + gdpCol]);
      memo.set(k, m);
    }
    return m;
  };
  const markets: Trends['markets'] = [];
  for (let p = 0; p < NPERIODS; p++) {
    const Y = edges[p];
    if (Y > upTo) break;
    const kY = sampleAt(Y);
    if (kY < 0) continue;
    const then = gdpAt(sampleAt(Y - MARKET_WINDOW));
    // bounded top-5, stable in sample-row order on equal gains
    const top: { body: number; now: number; then: number; gain: number }[] = [];
    for (let r = sStart[kY]; r < sEnd[kY]; r++) {
      const body = e.hist[r * w + 1];
      if (isShipBody(body)) continue;
      const now = e.hist[r * w + gdpCol], before = then.get(body) ?? 0, gain = now - before;
      if (!(gain > 0)) continue;
      let i = top.length;
      for (let j = 0; j < top.length; j++) if (top[j].gain < gain) { i = j; break; }
      if (i < 5) { top.splice(i, 0, { body, now, then: before, gain }); if (top.length > 5) top.pop(); }
    }
    for (const g of top) markets.push({ p, year: Y, body: g.body, now: g.now, then: g.then });
  }

  const shocks: Trends['shocks'] = [];
  for (const cat of SHOCKS) {
    const counts = new Array<number>(NPERIODS).fill(0);
    const years: number[] = [];
    const first = new Map<number, { year: number; body: number; type: number }>();
    const want = new Set(cat.types);
    for (const ev of e.events) {
      if (!want.has(ev.type) || ev.year > upTo) continue;
      const p = Math.max(0, Math.min(NPERIODS - 1, periodOf(ev.year)));
      counts[p]++;
      years.push(ev.year);
      if (!first.has(p)) first.set(p, { year: ev.year, body: ev.body, type: ev.type });
    }
    years.sort((a, b) => a - b);
    const top: TrendPoint[] = [...counts.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p, n]) => {
        const ev = first.get(p)!;
        return { year: ev.year, body: ev.body, n, label: EVENT_NAMES[ev.type] };
      });
    shocks.push({ key: cat.key, label: cat.label, types: cat.types, counts, years, top });
  }
  return { edges, upTo, moved, lost, hot, markets, shocks };
}
