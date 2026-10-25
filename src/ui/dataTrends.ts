// "Trends": the run as an analyst's deck — the nine data sections of SECTIONS
// (market, costs, pipeline, risk, hotspots, logistics, workforce, shocks,
// climate), each with a signal line that follows the cursor year, a chart, and
// a list of the moments it turns. Ages stays narrative, from the annals.
// Every chart and every listed year seeks the timeline there (and focuses the
// world concerned), so a click shows the system changing.

import type { Annals } from '../sim/chronicle.ts';
import { NPERIODS, periodOf } from '../sim/ledger.ts';
import { GLOBAL_METRICS, GM } from '../sim/metrics.ts';
import { buildReport, countSignal, crossAt, crossMetric, marketsAt, metricInfo, metricSeries, metricSignal, REPORT_COLUMNS, reportTable, SECTIONS, seriesTable, topDestinationAt, turningPoints, type Ctx, type Dir, type MetricSignal, type ReportRow, type TrendSection } from '../sim/trendSignals.ts';
import { MARKET_WINDOW, type Trends } from '../sim/trends.ts';
import { AnalystChart, type ABand, type AData, type ALine } from './analystChart.ts';
import { globalSeries } from './charts.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { ENSEMBLE_SIZE } from './ensemble.ts';
import { copyText, toCsv } from './exporter.ts';
import { fmtNum, fmtUnit, fmtYear } from './format.ts';
import { PALETTE } from './miniChart.ts';

interface Sec {
  el: HTMLElement; list: HTMLElement; chart: AnalystChart | null; data: AData | null;
  signal: HTMLElement | null; live: HTMLElement | null; def: TrendSection | null;
}

const ARROW: Record<Dir, string> = { rising: '↑', falling: '↓', flat: '→' };
const CAP: Record<Dir, string> = { rising: 'Rising', falling: 'Falling', flat: 'Flat' };

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
  private repBody: HTMLElement;
  private ensLine: HTMLElement;
  private painted = new WeakMap<HTMLElement, string>();
  private report: ReportRow[] | null = null;
  private sib: ArrayLike<number>[] = [];
  private lastEnsCount = -1;
  private ensTimer = 0;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.ensLine = document.createElement('p');
    this.ensLine.className = 'muted tr-ens';
    this.ensLine.hidden = true;
    this.el.append(this.ensLine);
    const rep = document.createElement('section');
    rep.className = 'tr-sec tr-report';
    rep.innerHTML = `<h3>End-of-run report</h3><div class="tr-rep-body"></div>`;
    this.repBody = rep.querySelector('.tr-rep-body')!;
    this.el.append(rep);
    for (const def of SECTIONS) {
      const el = document.createElement('section');
      el.className = 'tr-sec';
      el.innerHTML = `<h3>${esc(def.title)}</h3><p class="tr-q">${esc(def.question)}</p><p class="tr-signal"></p><p class="muted tr-how">${esc(def.how)}</p>`;
      let chart: AnalystChart | null = null;
      if (def.chart !== 'none') {
        chart = new AnalystChart({ log: def.log, warp: true, label: def.title });
        chart.onPick = (y) => host.pickYear?.(y);
        el.append(chart.el);
      }
      let live: HTMLElement | null = null;
      if (def.id === 'market') {
        live = document.createElement('div');
        live.className = 'tr-live';
        el.append(live);
      }
      const list = document.createElement('div');
      el.append(list);
      this.el.append(el);
      this.secs.push({ el, list, chart, data: null, signal: el.querySelector('.tr-signal'), live, def });
    }
    {
      const el = document.createElement('section');
      el.className = 'tr-sec';
      el.innerHTML = `<h3>Ages</h3>`;
      const list = document.createElement('div');
      el.append(list);
      this.el.append(el);
      this.secs.push({ el, list, chart: null, data: null, signal: null, live: null, def: null });
    }
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'report-csv' || act === 'series-csv') {
        const sim = this.host.sim, status = this.repBody.querySelector<HTMLElement>('.copy-status');
        if (act === 'report-csv' && this.report) void copyText(toCsv(REPORT_COLUMNS, reportTable(this.report), `Trends report, future #${sim.seed}`), 'Report as CSV', status);
        if (act === 'series-csv') {
          const { columns, rows } = seriesTable(sim.years, sim.series, Math.min(sim.years.length, sim.frontier + 1), this.trends);
          void copyText(toCsv(columns, rows, `Trends series, future #${sim.seed}`), 'Series as CSV', status);
        }
        return;
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-y]');
      if (!b) return;
      this.host.pickYear?.(Number(b.dataset.y));
      const body = Number(b.dataset.b ?? -1);
      if (body >= 0) this.host.selectBody(body);
    });
  }

  refresh(): void {
    if (this.el.hidden) return;
    const ens = this.host.ensemble?.() ?? null;
    const ec = ens?.count ?? 0;
    if (ec !== this.lastEnsCount) { this.lastEnsCount = ec; this.dirty = true; }
    this.fetch();
    if (this.dirty) { this.dirty = false; this.render(); }
    this.paintCursor();
    if (this.host.sim.done && ec < ENSEMBLE_SIZE && !this.ensTimer) {
      this.ensTimer = setTimeout(() => { this.ensTimer = 0; if (!this.el.hidden) this.refresh(); }, 2000) as unknown as number;
    }
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

  private fill(s: Sec, lines: ALine[] | null, pts: (string | '')[], waiting: boolean, bands?: ABand[]): void {
    if (s.chart) {
      s.data = { lines: lines ?? [], bands };
      s.chart.set({ ...s.data, cursor: this.host.year() });
    }
    this.paint(s.list, pts.some(Boolean)
      ? `<ol class="tr-pts">${pts.join('')}</ol>`
      : waiting ? '<p class="muted">Waiting for the run…</p>' : '');
  }

  /** first index where pred holds */
  private first(ys: ArrayLike<number>, pred: (v: number, i: number) => boolean): number {
    for (let i = 0; i < ys.length; i++) if (Number.isFinite(ys[i]) && pred(ys[i], i)) return i;
    return -1;
  }

  // ------------------------------------------------------------------ static render (data changed)

  private render(): void {
    const a = this.annals, S = this.secs, sim = this.host.sim;
    const ens = this.host.ensemble?.() ?? null;
    this.sib = ens ? ens.futures().map((f) => f.series) : [];
    this.report = sim.done && this.trends
      ? buildReport(sim.years, sim.series, Math.min(sim.years.length, sim.frontier + 1), this.trends, this.sib.length >= 5 ? this.sib : undefined) : null;
    for (const s of S) if (s.def) this.renderData(s);

    // ages
    {
      const pts: string[] = a ? a.ages.map((ag) => this.pt(ag.from, -1, `${esc(ag.name)} begins`)) : [];
      this.fill(S[S.length - 1], null, pts, !a);
    }
  }

  private renderData(s: Sec): void {
    const def = s.def!, t = this.trends, a = this.annals;
    let lines: ALine[] = [];
    let pts: string[] = [];
    let waiting = false;
    if (Array.isArray(def.chart)) {
      lines = def.chart.map((k, i) => {
        const l = this.line(k, i ? PALETTE[(i - 1) % PALETTE.length] : '#f2f2f2');
        return l ? { ...l, label: GLOBAL_METRICS[GM[k]].label } : null;
      }).filter((l): l is ALine => !!l);
    }
    // the sibling-futures band rides on the section's crossMetric line (series metrics only)
    let bands: ABand[] | undefined;
    const cm = crossMetric(def);
    if (cm && cm.src === 'series' && Array.isArray(def.chart) && this.sib.length >= 5) {
      const i = def.chart.indexOf(cm.key), s2 = this.vals(cm.key);
      const b = i >= 0 && s2 ? this.host.ensemble?.()?.band(cm.key, s2.xs.length) : null;
      if (b && s2) bands = [{ label: 'other futures, 10–90%', color: i ? PALETTE[(i - 1) % PALETTE.length] : '#f2f2f2', xs: s2.xs, lo: b.lo, hi: b.hi }];
    }
    switch (def.id) {
      case 'market': {
        const pop = this.vals('pop'), off = this.vals('offEarth'), inter = this.vals('interstellarPop'), g = this.vals('gdpPerCap');
        const tp = pop ? turningPoints(pop.xs, pop.ys, true) : null;
        const tg = g ? turningPoints(g.xs, g.ys, true) : null;
        const half = pop && off ? this.first(off.ys, (v, i) => v > 0 && v > pop.ys[i] / 2) : -1;
        const beyond = inter ? this.first(inter.ys, (v) => v > 0) : -1;
        const sh = t?.shares;
        const iE = sh ? sh.earthGdp.findIndex((v) => v < 50) : -1;
        const iT = sh ? sh.top5Gdp.findIndex((v) => v < 50) : -1;
        pts = [
          this.at(pop, tp?.max ?? -1, 'peak population'),
          this.at(pop, tp?.fall ?? -1, 'the steepest fall'),
          this.at(off, half, 'most people now live off Earth'),
          this.at(inter, beyond, 'first people beyond Sol'),
          this.at(g, tg?.rise ?? -1, 'the steepest rise in product per person'),
          this.at(g, tg?.fall ?? -1, 'the steepest fall in product per person'),
          iE >= 0 ? this.pt(sh!.year[iE], -1, 'most product is now made off Earth') : '',
          iT >= 0 ? this.pt(sh!.year[iT], -1, 'the top 5 worlds hold under half of product') : '',
        ];
        waiting = !pop;
        break;
      }
      case 'costs': {
        const f = this.vals('costPerKg'), en = this.vals('energyPerCap');
        const tf = f ? turningPoints(f.xs, f.ys, true) : null;
        pts = [
          this.at(f, tf?.min ?? -1, 'freight is cheapest'),
          this.at(f, tf?.fall ?? -1, 'freight costs fall fastest'),
          this.at(en, en ? turningPoints(en.xs, en.ys, false).max : -1, 'most energy per person'),
        ];
        waiting = !f;
        break;
      }
      case 'pipeline': {
        const st = this.vals('settlements'), rc = this.vals('reach');
        pts = [
          this.at(st, st ? this.first(st.ys, (v) => v >= 100) : -1, 'settlements pass 100'),
          this.at(rc, rc ? this.first(rc.ys, (v) => v >= 100) : -1, 'the frontier passes 100 light years'),
        ];
        if (t) {
          let best = -1, by = NaN;
          for (const y of st?.xs ?? []) {
            const n = countSignal(t.founded, y, 100).recent;
            if (n > best) { best = n; by = y; }
          }
          pts.push(this.pt(by, -1, 'the busiest century for new colonies'));
        }
        waiting = !st;
        break;
      }
      case 'risk': {
        const st = this.vals('stability');
        const ts = st ? turningPoints(st.xs, st.ys, false) : null;
        if (st) pts = [
          this.at(st, ts?.min ?? -1, 'order at its lowest'),
          this.at(st, ts?.fall ?? -1, 'order breaks fastest'),
        ];
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
        waiting = !(t && a);
        break;
      }
      case 'hotspots': {
        pts = t ? [...t.hot].sort((x, y) => y.n - x.n).slice(0, 12)
          .map((h) => this.pt(h.year, h.body, `${esc(this.name(h.body) || '?')} — ${fmtNum(h.n)} arrivals${h.from >= 0 && this.name(h.from) ? `, mostly from ${esc(this.name(h.from))}` : ''}`)) : [];
        waiting = !t;
        break;
      }
      case 'logistics': {
        const f = this.vals('payloadDispatched'), sl = this.vals('shipsLost');
        const tf = f ? turningPoints(f.xs, f.ys, true) : null;
        pts = [
          this.at(f, tf?.max ?? -1, 'the most freight shipped'),
          this.at(f, tf?.fall ?? -1, 'freight falls fastest'),
          this.at(sl, sl ? this.first(sl.ys, (v) => v >= 1) : -1, 'the first ship lost'),
        ];
        waiting = !f;
        break;
      }
      case 'workforce': {
        const le = this.vals('lifeExp'), ma = this.vals('medianAge'), tfr = this.vals('tfr');
        const below = tfr ? this.first(tfr.ys, (v) => v > 0 && v < 2.1) : -1;
        pts = [
          this.at(le, le ? turningPoints(le.xs, le.ys, false).max : -1, 'peak life expectancy'),
          this.at(ma, ma ? turningPoints(ma.xs, ma.ys, false).max : -1, 'oldest median age'),
          this.at(tfr, below, 'families fall below replacement'),
        ];
        waiting = !le;
        break;
      }
      case 'shocks': {
        lines = t ? t.shocks.map((c, i) => ({ label: c.label, color: PALETTE[i % PALETTE.length], xs: t.edges.slice(0, NPERIODS), ys: c.counts })) : [];
        pts = t ? t.shocks.flatMap((c) => c.top).sort((x, y) => y.n - x.n).slice(0, 12)
          .map((p) => this.pt(p.year, p.body, `${esc(p.label)}${this.name(p.body) ? ` on ${esc(this.name(p.body))}` : ''} — ${p.n} that period`)) : [];
        waiting = !t;
        break;
      }
      case 'adoption': {
        const sim = this.host.sim;
        const lag = def.metrics.find((m) => m.src === 'lag')!;
        const ser = t ? metricSeries(lag, { years: sim.years, series: sim.series, n: Math.min(sim.years.length, sim.frontier + 1), t }) : null;
        if (ser) lines = [{ label: 'News lag, 100-year mean (years)', color: '#f2f2f2', xs: ser.xs, ys: ser.ys }];
        const tp = ser ? turningPoints(ser.xs, ser.ys, false) : null;
        pts = [
          this.at(ser, ser ? this.first(ser.ys, (v) => v >= 1) : -1, 'news first takes a year to arrive'),
          this.at(ser, ser ? this.first(ser.ys, (v) => v >= 10) : -1, 'news takes a decade'),
          this.at(ser, ser ? this.first(ser.ys, (v) => v >= 100) : -1, 'news takes a century'),
          this.at(ser, tp?.max ?? -1, 'the longest news lag'),
        ];
        waiting = !t;
        break;
      }
      case 'climate': {
        const et = this.vals('earthTemp'), sl = this.vals('seaLevel'), tf = this.vals('terraformed');
        const te = et ? turningPoints(et.xs, et.ys, false) : null;
        pts = [
          this.at(et, te?.max ?? -1, 'Earth at its warmest'),
          this.at(et, te?.min ?? -1, 'Earth at its coolest'),
          this.at(sl, sl ? turningPoints(sl.xs, sl.ys, false).max : -1, 'the highest sea level'),
          this.at(tf, tf ? this.first(tf.ys, (v) => v >= 1) : -1, 'the first world terraformed past half'),
        ];
        waiting = !et;
        break;
      }
    }
    this.fill(s, lines, pts, waiting, bands);
  }

  // ------------------------------------------------------------------ cursor repaint (year changed)

  /** A signed change as text: rate as "+1.84 %/yr", delta as signed fmtNum plus a unit suffix. */
  private fmtChg(kind: 'rate' | 'delta', change: number, unit: string): string {
    if (kind === 'rate') return `${change >= 0 ? '+' : ''}${change.toFixed(2)} %/yr`;
    return `${change >= 0 ? '+' : ''}${fmtNum(change)}${unit === 'yr' || unit === '%' ? ` ${unit}` : ''}`;
  }

  /** A signal's change as text: "+1.84 %/yr", "from zero", or a signed delta with its suffix. */
  private chg(s: MetricSignal): string {
    if (s.kind === 'rate') {
      if (s.change === null) return s.to > s.from ? 'from zero' : s.to < s.from ? 'to zero' : 'unchanged';
      return `${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)} %/yr`;
    }
    if (s.kind === 'count') return `${s.change! >= 0 ? '+' : ''}${s.change}`;
    if (s.unit === 'yr' && Math.abs(s.change!) < 1) return `${s.change! >= 0 ? '+' : '-'}${this.val(Math.abs(s.change!), 'yr')}`;
    const suffix = s.unit === '%' ? ' pts' : s.unit === 'yr' || s.unit === 'K' || s.unit === 'm' || s.unit === 'ly' ? ` ${s.unit}` : '';
    return `${s.change! >= 0 ? '+' : ''}${fmtNum(s.change!)}${suffix}`;
  }

  /** A signal's level as text. */
  private level(s: MetricSignal): string { return this.val(s.to, s.unit); }

  /** A value with its unit; 'K' reads "1.07 K" (kelvin, not fmtUnit's Kardashev rating), and a sub-year 'yr' reads "36 days" or "8 min". */
  private val(v: number, unit: string): string {
    if (unit === 'K') return `${v.toFixed(2)} K`;
    if (unit === 'yr' && Math.abs(v) < 1) return v * 365.25 < 1 ? `${Math.max(1, Math.round(v * 525960))} min` : `${Math.round(v * 365.25)} days`;
    return fmtUnit(v, unit);
  }

  /** The signal line of a data section at cursor year y. */
  private signalLine(def: TrendSection, y: number): string {
    const sim = this.host.sim, t = this.trends;
    const ctx: Ctx = { years: sim.years, series: sim.series, n: Math.min(sim.years.length, sim.frontier + 1), t };
    if (def.id === 'hotspots') {
      if (!t) return 'Waiting for the run…';
      const top = topDestinationAt(t, y);
      if (!top) return 'No arrivals yet.';
      let s = `Top destination, ${fmtYear(top.from)}–${fmtYear(top.to)}: ${esc(this.name(top.body) || '?')} — ${fmtNum(top.n)} arrivals`;
      if (top.src >= 0 && this.name(top.src)) s += `, mostly from ${esc(this.name(top.src))}`;
      const prev = topDestinationAt(t, y - 50);
      if (prev) s += prev.body === top.body ? '; the same as 50 years earlier' : `; 50 years earlier it was ${esc(this.name(prev.body) || '?')}`;
      return s;
    }
    const headM = def.metrics[0];
    const head = headM ? metricSignal(headM, ctx, y) : null;
    if (!head) return headM && headM.src !== 'series' && !t ? 'Waiting for the run…' : 'No data yet at this year.';
    if (head.kind === 'count') {
      let html = `<b>${CAP[head.dir]}</b> ${esc(head.label)}: ${head.to} in the ${head.span} years to ${fmtYear(y)}, against ${head.from} in the ${head.span} before`;
      for (const m of def.metrics.slice(1)) {
        const s = metricSignal(m, ctx, y);
        if (s) html += ` · ${esc(s.label)} ${s.to} (was ${s.from}) ${ARROW[s.dir]}`;
      }
      return html;
    }
    let html = `<b>${CAP[head.dir]}</b> ${esc(head.label)} ${headM.src !== 'count' && headM.level ? `${this.level(head)}, ` : ''}${this.chg(head)} over the ${Math.round(head.toYear - head.fromYear)} years to ${fmtYear(head.toYear)}`;
    const cm = crossMetric(def);
    if (cm && this.sib.length >= 5) {
      const ms = metricSignal(cm, ctx, y), cs = ms ? crossAt(cm, ctx, this.sib, y) : null;
      if (ms && cs) {
        html += ` · ${CAP[ms.dir]} here and in ${cs.sameDir} of ${cs.dirKnown} other futures over the same ${metricInfo(cm).span} years`;
        if (cs.percentile !== null) html += ` · higher than ${Math.round(100 * cs.percentile)}% of them`;
      }
    }
    for (const m of def.metrics.slice(1)) {
      const s = metricSignal(m, ctx, y);
      if (!s) continue;
      html += s.kind === 'count'
        ? ` · ${esc(s.label)} ${s.to} (was ${s.from}) ${ARROW[s.dir]}`
        : ` · ${esc(s.label)} ${m.src !== 'count' && m.level ? `${this.level(s)} (${this.chg(s)})` : this.chg(s)} ${ARROW[s.dir]}`;
    }
    return html;
  }

  /** The market section's fastest-growing markets at the cursor year. */
  private marketLive(y: number): string {
    const t = this.trends;
    if (!t) return '';
    const ms = marketsAt(t, y);
    if (!ms.length) return `<p class="muted">${t.edges[periodOf(y)] < t.growthFrom ? 'No growth data yet.' : 'No growing markets yet.'}</p>`;
    const Y = ms[0].year, since = ms[0].since, short = Y - since < MARKET_WINDOW;
    const lis = ms.map((m) => this.pt(m.year, m.body, m.then === 0
      ? `${esc(this.name(m.body) || '?')} — new market, product ${fmtUnit(m.now, '$/yr')}`
      : `${esc(this.name(m.body) || '?')} — product ${fmtUnit(m.now, '$/yr')}, up ${fmtUnit(m.now - m.then, '$/yr')} ${short ? `since ${fmtYear(since)}` : 'in a century'}`));
    return `<p class="muted">Fastest-growing markets, ${short ? `since ${fmtYear(since)}, as of ${fmtYear(Y)}` : `the century to ${fmtYear(Y)}`}</p><ol class="tr-pts">${lis.join('')}</ol>`;
  }

  /** The end-of-run report: one line per section's headline row. */
  private reportHtml(): string {
    const r = this.report, t = this.trends;
    if (!r) return '';
    const yb = (y: number) => `<button class="link num" type="button" data-y="${y}" data-b="-1">${fmtYear(y)}</button>`;
    const lis: string[] = [];
    for (const sec of SECTIONS) {
      if (sec.id === 'hotspots') {
        const top = t?.hot.reduce<Trends['hot'][number] | null>((a, h) => (!a || h.n > a.n ? h : a), null);
        if (top) lis.push(`<li><b>Migration hotspots</b>: the busiest destination of the run was ${esc(this.name(top.body) || '?')}, ${fmtNum(top.n)} arrivals in the period from ${yb(top.year)}</li>`);
        continue;
      }
      const head = sec.id === 'shocks' ? 'shock:disaster' : sec.metrics[0]?.key;
      const row = r.find((x) => x.section === sec.title && x.key === head);
      if (!row) continue;
      if (row.kind === 'count') {
        const busiest = Number.isFinite(row.peakYear) ? ` Busiest period from ${yb(row.peakYear)} (${row.peak} events).` : '';
        lis.push(`<li><b>Shocks</b>: ${esc(row.label)}, ${row.runChange} over the run; last ${row.span} years ${row.lastChange! >= 0 ? '+' : ''}${row.lastChange} against the ${row.span} before (${row.lastDir}).${busiest}</li>`);
        continue;
      }
      const from = Number.isFinite(row.startYear) ? `${this.val(row.start, row.unit)} in ${yb(row.startYear)} → ` : '';
      let s = `<b>${esc(row.section)}</b>: ${esc(row.label)} ${from}${this.val(row.end, row.unit)} in ${yb(row.endYear)}`;
      if (row.runChange !== null) s += `, ${this.fmtChg(row.kind, row.runChange, row.unit)} over the run`;
      s += `. Last ${row.span} years: ${CAP[row.lastDir]}`;
      if (row.lastChange !== null) s += ` (${this.fmtChg(row.kind, row.lastChange, row.unit)})`;
      const tps = ([['Peak', row.peakYear], ['low', row.troughYear], ['steepest rise', row.riseYear], ['steepest fall', row.fallYear]] as [string, number][])
        .filter(([, y]) => Number.isFinite(y));
      if (tps.length) s += `. ${tps.map(([w, y]) => `${w} ${yb(y)}`).join(', ')}.`;
      if (Number.isFinite(row.endPct)) {
        s += ` · end of run: higher than ${Math.round(row.endPct * 100)}% of other futures`;
        if (Number.isFinite(row.medianRunChange)) s += `; their median change ${this.fmtChg(row.kind, row.medianRunChange, row.unit)}`;
      }
      lis.push(`<li>${s}</li>`);
    }
    return `<ol class="tr-rep">${lis.join('')}</ol><p class="tr-rep-tools"><button class="link" type="button" data-act="report-csv">Copy report (CSV)</button> <button class="link" type="button" data-act="series-csv">Copy series (CSV)</button> <span class="copy-status muted" aria-live="polite"></span></p>`;
  }

  /** Replace an element's HTML only when it changed, so a link under the pointer survives the repaint. */
  private paint(el: HTMLElement, html: string): void {
    if (this.painted.get(el) === html) return;
    this.painted.set(el, html);
    el.innerHTML = html;
  }

  /** Signal lines, the live market list, faint future points and chart cursors — all at the cursor year. */
  private paintCursor(): void {
    const y = this.host.year();
    const sim = this.host.sim;
    const rep = !sim.done
      ? `<p class="muted">The report is ready when this future's run ends. The run has reached ${fmtYear(sim.years[sim.frontier] ?? 0)}.</p>`
      : !this.report ? '<p class="muted">Preparing the report…</p>' : this.reportHtml();
    this.paint(this.repBody, rep);
    const ens = this.host.ensemble?.() ?? null;
    const ec = ens?.count ?? 0;
    this.ensLine.hidden = !sim.done;
    if (sim.done) this.paint(this.ensLine, ec >= ENSEMBLE_SIZE ? `Compared with ${ec} other futures` : `Comparing with other futures: ${ec} of ${ENSEMBLE_SIZE} played`);
    for (const s of this.secs) {
      if (s.signal) this.paint(s.signal, this.signalLine(s.def!, y));
      if (s.live) this.paint(s.live, this.marketLive(y));
    }
    for (const li of this.el.querySelectorAll<HTMLElement>('.tr-pts li')) {
      const b = li.querySelector<HTMLElement>('button[data-y]');
      li.classList.toggle('future', !!b && Number(b.dataset.y) > y);
    }
    for (const s of this.secs) if (s.chart && s.data) s.chart.set({ ...s.data, cursor: y });
  }
}
