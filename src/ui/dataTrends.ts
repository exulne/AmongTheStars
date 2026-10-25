// "Trends": the run's big curves and the moments they turn — population,
// lifespan, migration, wealth, order, war, shocks, divergence, belief and the
// ages. Every chart and every listed year seeks the timeline there (and
// focuses the world concerned), so a click shows the system changing.
// Faith is narrative here, not data: its milestones come from the annals.

import type { Annals } from '../sim/chronicle.ts';
import { NPERIODS, periodOf } from '../sim/ledger.ts';
import type { Trends } from '../sim/trends.ts';
import { AnalystChart, type AData, type ALine } from './analystChart.ts';
import { globalSeries } from './charts.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { fmtNum, fmtYear } from './format.ts';
import { PALETTE } from './miniChart.ts';

interface Sec { el: HTMLElement; list: HTMLElement; chart: AnalystChart | null; data: AData | null }

/** The indices where a series peaks, bottoms and turns sharpest (rise/fall over lag = n/50 steps). */
function turningPoints(xs: ArrayLike<number>, ys: ArrayLike<number>, log: boolean): { max: number; min: number; rise: number; fall: number } {
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

const HOW = {
  pop: 'Censuses and population registers: head-counts by place, refreshed every few years.',
  vital: 'Vital statistics: births, deaths and causes registered at the event; life tables built from them.',
  migration: 'Border crossings, visas, address changes and phone/location data: origin–destination flows.',
  wealth: 'Tax records, household surveys and credit data: income, wealth and their spread (Gini).',
  wellbeing: 'Polling and sentiment tracking; unrest and protest event counts.',
  war: 'Conflict databases (battle deaths), election and regime records, secession movements.',
  shocks: "Disaster and incident registries; insurers' loss records.",
  divergence: 'Genomic and linguistic surveys: how far populations have drifted apart.',
  belief: "Faith is kept out of the data channel: these are the record's milestones, not measurements.",
  ages: '',
};

export class TrendsTab implements DataTab {
  id = 'trends';
  label = 'Trends';
  el: HTMLElement;
  private host: DataHost;
  private secs: Sec[] = [];
  private trends: Trends | null = null;
  private annals: Annals | null = null;
  private dataKey = '';
  private lastAt = 0;
  private busy = false;
  private dirty = true;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    const defs: [string, string, { log?: boolean } | null][] = [
      ['Population', HOW.pop, { log: true }],
      ['Lifespan and age', HOW.vital, {}],
      ['Migration and hotspots', HOW.migration, { log: true }],
      ['Wealth and inequality', HOW.wealth, { log: true }],
      ['Wellbeing and order', HOW.wellbeing, {}],
      ['War and governance', HOW.war, { log: true }],
      ['Shocks', HOW.shocks, {}],
      ['Divergence', HOW.divergence, {}],
      ['Belief', HOW.belief, null],
      ['Ages', HOW.ages, null],
    ];
    for (const [title, how, chartOpts] of defs) {
      const el = document.createElement('section');
      el.className = 'tr-sec';
      el.innerHTML = `<h3>${esc(title)}</h3>${how ? `<p class="muted tr-how">${esc(how)}</p>` : ''}`;
      let chart: AnalystChart | null = null;
      if (chartOpts) {
        chart = new AnalystChart({ log: !!chartOpts.log, warp: true, label: title });
        chart.onPick = (y) => host.pickYear?.(y);
        el.append(chart.el);
      }
      const list = document.createElement('div');
      el.append(list);
      this.el.append(el);
      this.secs.push({ el, list, chart, data: null });
    }
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-y]');
      if (!b) return;
      this.host.pickYear?.(Number(b.dataset.y));
      const body = Number(b.dataset.b ?? -1);
      if (body >= 0) this.host.selectBody(body);
    });
  }

  refresh(): void {
    if (this.el.hidden) return;
    this.fetch();
    if (this.dirty) { this.dirty = false; this.render(); }
    for (const s of this.secs) if (s.chart && s.data) s.chart.set({ ...s.data, cursor: this.host.year() });
  }

  /** Trends and annals, cached per run state; refetch while the run is live, at most every 5 s. */
  private fetch(): void {
    const sim = this.host.sim, key = `${sim.seed}:${sim.done}`;
    if (key === this.dataKey || this.busy || !sim.years.length) return;
    const now = performance.now();
    if (this.dataKey && !sim.done && now - this.lastAt < 5000) return;
    this.busy = true;
    this.lastAt = now;
    const seed = sim.seed;
    Promise.all([sim.trends(), sim.annals()]).then(([t, a]) => {
      this.busy = false;
      if (seed !== this.host.sim.seed) return;
      this.trends = t.trends;
      this.annals = a.annals;
      this.dataKey = `${this.host.sim.seed}:${this.host.sim.done}`;
      this.dirty = true;
      if (!this.el.hidden) this.refresh();
    });
  }

  // ------------------------------------------------------------------ series and points

  private vals(key: string): { xs: number[]; ys: number[] } | null {
    const sim = this.host.sim;
    if (!sim.years.length) return null;
    const s = globalSeries(sim.years, sim.series, sim.frontier, key);
    if (!s) return null;
    const xs = s.years.slice(0, s.n);
    return { xs, ys: xs.map((_, i) => s.values(i)) };
  }

  private line(key: string, color: string): ALine | null {
    const s = this.vals(key);
    return s ? { label: key, color, xs: s.xs, ys: s.ys } : null;
  }

  private name(b: number): string {
    return b >= 0 && b < this.host.world.bodies.length ? this.host.world.bodies[b].name : '';
  }

  private pt(year: number, body: number, text: string): string {
    if (!Number.isFinite(year)) return '';
    return `<li><button class="link num" type="button" data-y="${year}" data-b="${body}">${fmtYear(year)}</button> ${text}</li>`;
  }

  /** idx → a point li at that sample's year (drops -1). */
  private at(s: { xs: number[] } | null, idx: number, text: string, body = -1): string {
    if (!s || idx < 0 || idx >= s.xs.length) return '';
    return this.pt(s.xs[idx], body, text);
  }

  private fill(s: Sec, lines: ALine[] | null, pts: (string | '')[], waiting: boolean): void {
    if (s.chart) {
      s.data = { lines: lines ?? [] };
      s.chart.set({ ...s.data, cursor: this.host.year() });
    }
    s.list.innerHTML = pts.some(Boolean)
      ? `<ol class="tr-pts">${pts.join('')}</ol>`
      : waiting ? '<p class="muted">Waiting for the run…</p>' : '';
  }

  /** first index where pred holds */
  private first(ys: ArrayLike<number>, pred: (v: number, i: number) => boolean): number {
    for (let i = 0; i < ys.length; i++) if (Number.isFinite(ys[i]) && pred(ys[i], i)) return i;
    return -1;
  }

  private render(): void {
    const t = this.trends, a = this.annals, S = this.secs;

    // population
    {
      const pop = this.vals('pop'), off = this.vals('offEarth'), inter = this.vals('interstellarPop');
      const tp = pop ? turningPoints(pop.xs, pop.ys, true) : null;
      const half = pop && off ? this.first(off.ys, (v, i) => v > 0 && v > pop.ys[i] / 2) : -1;
      const beyond = inter ? this.first(inter.ys, (v) => v > 0) : -1;
      const lines = [this.line('pop', '#f2f2f2'), this.line('offEarth', PALETTE[0]), this.line('interstellarPop', PALETTE[1])].filter((l): l is ALine => !!l);
      if (lines[0]) lines[0].label = 'Population';
      if (lines[1]) lines[1].label = 'Off Earth';
      if (lines[2]) lines[2].label = 'Beyond Sol';
      this.fill(S[0], lines, [
        this.at(pop, tp?.max ?? -1, 'peak population'),
        this.at(pop, tp?.fall ?? -1, 'the steepest fall'),
        this.at(off, half, 'most people now live off Earth'),
        this.at(inter, beyond, 'first people beyond Sol'),
      ], !pop);
    }

    // lifespan and age
    {
      const le = this.vals('lifeExp'), ma = this.vals('medianAge'), tfr = this.vals('tfr');
      const below = tfr ? this.first(tfr.ys, (v) => v > 0 && v < 2.1) : -1;
      const lines = [this.line('lifeExp', PALETTE[0]), this.line('medianAge', PALETTE[1])].filter((l): l is ALine => !!l);
      if (lines[0]) lines[0].label = 'Life expectancy';
      if (lines[1]) lines[1].label = 'Median age';
      this.fill(S[1], lines, [
        this.at(le, le ? turningPoints(le.xs, le.ys, false).max : -1, 'peak life expectancy'),
        this.at(ma, ma ? turningPoints(ma.xs, ma.ys, false).max : -1, 'oldest median age'),
        this.at(tfr, below, 'families fall below replacement'),
      ], !le);
    }

    // migration and hotspots
    {
      const xs = t ? t.edges.slice(0, NPERIODS) : [];
      const lines: ALine[] = t ? [
        { label: 'people setting out', color: '#f2f2f2', xs, ys: t.moved },
        { label: 'lost in transit', color: '#ff8f7a', xs, ys: t.lost, dash: true },
      ] : [];
      const pts = t ? [...t.hot].sort((x, y) => y.n - x.n).slice(0, 12)
        .map((h) => this.pt(h.year, h.body, `${esc(this.name(h.body) || '?')} — ${fmtNum(h.n)} arrivals${h.from >= 0 && this.name(h.from) ? `, mostly from ${esc(this.name(h.from))}` : ''}`)) : [];
      this.fill(S[2], lines, pts, !t);
    }

    // wealth and inequality
    {
      const g = this.vals('gdpPerCap'), gini = this.vals('gini'), sh = this.vals('shortage');
      const tp = g ? turningPoints(g.xs, g.ys, true) : null;
      const gi = gini ? turningPoints(gini.xs, gini.ys, false) : null;
      this.fill(S[3], [this.line('gdpPerCap', '#f2f2f2')].filter((l): l is ALine => !!l).map((l) => ({ ...l, label: 'Product per person' })), [
        this.at(g, tp?.rise ?? -1, 'the steepest rise in product per person'),
        this.at(g, tp?.fall ?? -1, 'the steepest fall in product per person'),
        this.at(gini, gi?.max ?? -1, `most unequal (Gini ${gini && gi ? gini.ys[gi.max].toFixed(2) : ''})`),
        this.at(gini, gi?.min ?? -1, `most equal (Gini ${gini && gi ? gini.ys[gi.min].toFixed(2) : ''})`),
        this.at(sh, sh ? turningPoints(sh.xs, sh.ys, false).max : -1, 'the worst shortages'),
      ], !g);
    }

    // wellbeing and order
    {
      const h = this.vals('happiness'), st = this.vals('stability');
      const th = h ? turningPoints(h.xs, h.ys, false) : null;
      const ts = st ? turningPoints(st.xs, st.ys, false) : null;
      const lines = [this.line('happiness', PALETTE[0]), this.line('stability', PALETTE[1])].filter((l): l is ALine => !!l);
      if (lines[0]) lines[0].label = 'Happiness';
      if (lines[1]) lines[1].label = 'Stability';
      this.fill(S[4], lines, [
        this.at(h, th?.min ?? -1, 'happiness at its lowest'),
        this.at(h, th?.fall ?? -1, 'happiness falls fastest'),
        this.at(st, ts?.min ?? -1, 'order at its lowest'),
        this.at(st, ts?.fall ?? -1, 'order breaks fastest'),
      ], !h);
    }

    // war and governance
    {
      let lines: ALine[] = [];
      const pts: string[] = [];
      if (t && a) {
        const killed = new Array<number>(NPERIODS).fill(0);
        for (const w of a.wars) killed[Math.max(0, Math.min(NPERIODS - 1, periodOf(w.start)))] += w.killed;
        lines = [{ label: 'war deaths per period', color: '#ff8f7a', xs: t.edges.slice(0, NPERIODS), ys: killed }];
        for (const w of [...a.wars].sort((x, y) => y.killed - x.killed).slice(0, 8)) {
          const cap = a.polities[w.polityA]?.capital ?? -1;
          pts.push(this.pt(w.start, cap, `${esc(w.name)} — ${fmtNum(w.killed)} dead`));
        }
        for (const p of [...a.polities].sort((x, y) => y.peakPop - x.peakPop).slice(0, 4)) {
          pts.push(this.pt(p.founded, p.capital, `${esc(p.name)} ${p.from >= 0 ? 'breaks away' : 'founded'}`));
        }
      }
      this.fill(S[5], lines, pts, !(t && a));
    }

    // shocks
    {
      const lines: ALine[] = t ? t.shocks.map((c, i) => ({ label: c.label, color: PALETTE[i % PALETTE.length], xs: t.edges.slice(0, NPERIODS), ys: c.counts })) : [];
      const pts = t ? t.shocks.flatMap((c) => c.top).sort((x, y) => y.n - x.n).slice(0, 12)
        .map((p) => this.pt(p.year, p.body, `${esc(p.label)}${this.name(p.body) ? ` on ${esc(this.name(p.body))}` : ''} — ${p.n} that period`)) : [];
      this.fill(S[6], lines, pts, !t);
    }

    // divergence
    {
      const d = this.vals('divergence');
      const h1 = d ? this.first(d.ys, (v) => v >= 0.5) : -1;
      const h2 = d ? this.first(d.ys, (v) => v >= 1) : -1;
      this.fill(S[7], [this.line('divergence', '#f2f2f2')].filter((l): l is ALine => !!l).map((l) => ({ ...l, label: 'Max genetic divergence' })), [
        this.at(d, h1, 'peoples drift measurably apart'),
        this.at(d, h2, 'peoples become separate species'),
      ], !d);
    }

    // belief: narrative milestones only, no chart
    {
      const pts: string[] = [];
      if (a) {
        const faiths = [...a.faiths].sort((x, y) => y.peakWorlds - x.peakWorlds).slice(0, 12).sort((x, y) => x.founded - y.founded);
        for (const f of faiths) {
          pts.push(this.pt(f.founded, f.home, `${esc(f.name)} founded on ${esc(this.name(f.home) || '?')}`));
          if (f.ended !== null) pts.push(this.pt(f.ended, -1, `${esc(f.name)} dies out`));
        }
      }
      this.fill(S[8], null, pts, !a);
    }

    // ages
    {
      const pts: string[] = a ? a.ages.map((ag) => this.pt(ag.from, -1, `${esc(ag.name)} begins`)) : [];
      this.fill(S[9], null, pts, !a);
    }
  }
}
