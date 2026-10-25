// Society-level trends over the whole run, computed once from the ledger and
// the event log: who moved where and when, what shocks fell in each period.
// Pure — runs in the worker and in Node. Faith stays out of the data channel:
// nothing here counts or names a faith.

import { EVENT_NAMES, EV } from './catalog.ts';
import type { Engine } from './engine.ts';
import { FLOW, NPERIODS, isShipBody, periodOf, periodStart } from './ledger.ts';

export interface TrendPoint { year: number; body: number; n: number; label: string }
export interface Trends {
  edges: number[];           // periodStart(p) for p = 0..NPERIODS; bucket p = [edges[p], edges[p+1])
  upTo: number;              // year the run has reached
  moved: number[];           // per departure period: people who set out (all flows but landings)
  lost: number[];            // same, only the flows that were lost
  hot: { p: number; year: number; body: number; n: number; from: number }[]; // up to 3 busiest destinations per arrival period
  shocks: { key: string; label: string; types: number[]; counts: number[]; top: TrendPoint[] }[];
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

  const shocks: Trends['shocks'] = [];
  for (const cat of SHOCKS) {
    const counts = new Array<number>(NPERIODS).fill(0);
    const first = new Map<number, { year: number; body: number; type: number }>();
    const want = new Set(cat.types);
    for (const ev of e.events) {
      if (!want.has(ev.type) || ev.year > upTo) continue;
      const p = Math.max(0, Math.min(NPERIODS - 1, periodOf(ev.year)));
      counts[p]++;
      if (!first.has(p)) first.set(p, { year: ev.year, body: ev.body, type: ev.type });
    }
    const top: TrendPoint[] = [...counts.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p, n]) => {
        const ev = first.get(p)!;
        return { year: ev.year, body: ev.body, n, label: EVENT_NAMES[ev.type] };
      });
    shocks.push({ key: cat.key, label: cat.label, types: cat.types, counts, top });
  }
  return { edges, upTo, moved, lost, hot, shocks };
}
