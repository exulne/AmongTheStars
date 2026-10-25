// "Trends": the run as an analyst's deck — the nine data sections of SECTIONS
// (market, workforce, moves, consumers, risk, costs, innovation, shocks,
// divergence), each with a signal line that follows the cursor year, a chart,
// and a list of the moments it turns. Belief and Ages stay narrative, from the
// annals. Every chart and every listed year seeks the timeline there (and
// focuses the world concerned), so a click shows the system changing.

import type { Annals } from '../sim/chronicle.ts';
import { NPERIODS, periodOf } from '../sim/ledger.ts';
import { GLOBAL_METRICS, GM } from '../sim/metrics.ts';
import { buildReport, marketsAt, REPORT_COLUMNS, reportTable, SECTIONS, seriesTable, shockSignal, signalAt, turningPoints, type Dir, type ReportRow, type Signal, type TrendSection } from '../sim/trendSignals.ts';
import { MARKET_WINDOW, type Trends } from '../sim/trends.ts';
import { AnalystChart, type AData, type ALine } from './analystChart.ts';
import { globalSeries } from './charts.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv } from './exporter.ts';
import { fmtNum, fmtUnit, fmtYear } from './format.ts';
import { PALETTE } from './miniChart.ts';

interface Sec {
  el: HTMLElement; list: HTMLElement; chart: AnalystChart | null; data: AData | null;
  signal: HTMLElement | null; live: HTMLElement | null; def: TrendSection | null;
}

const BELIEF_HOW = "Faith is kept out of the data channel: these are the record's milestones, not measurements.";
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
  private repHtml = '';
  private report: ReportRow[] | null = null;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    const rep = document.createElement('section');
    rep.className = 'tr-sec tr-report';
    rep.innerHTML = `<h3>End-of-run report</h3><div class="tr-rep-body"></div>`;
    this.repBody = rep.querySelector('.tr-rep-body')!;
    this.el.append(rep);
    for (const def of SECTIONS) {
      const el = document.createElement('section');
      el.className = 'tr-sec';
      el.innerHTML = `<h3>${esc(def.title)}</h3><p class="tr-q">${esc(def.question)}</p><p class="tr-signal"></p><p class="muted tr-how">${esc(def.how)}</p>`;
      const chart = new AnalystChart({ log: def.log, warp: true, label: def.title });
      chart.onPick = (y) => host.pickYear?.(y);
      el.append(chart.el);
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
    for (const [title, how] of [['Belief', BELIEF_HOW], ['Ages', '']] as const) {
      const el = document.createElement('section');
      el.className = 'tr-sec';
      el.innerHTML = `<h3>${esc(title)}</h3>${how ? `<p class="muted tr-how">${esc(how)}</p>` : ''}`;
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
          const { columns, rows } = seriesTable(sim.years, sim.series, Math.min(sim.years.length, sim.frontier + 1));
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
    this.fetch();
    if (this.dirty) { this.dirty = false; this.render(); }
    this.paintCursor();
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

  // ------------------------------------------------------------------ static render (data changed)

  private render(): void {
    const a = this.annals, S = this.secs, sim = this.host.sim;
    this.report = sim.done && this.trends ? buildReport(sim.years, sim.series, Math.min(sim.years.length, sim.frontier + 1), this.trends) : null;
    for (const s of S) if (s.def) this.renderData(s);

    // belief: narrative milestones only, no chart
    {
      const pts: string[] = [];
      if (a) {
        const faiths = [...a.faiths].sort((x, y) => x.founded - y.founded).slice(0, 12);
        for (const f of faiths) {
          pts.push(this.pt(f.founded, f.home, `${esc(f.name)} founded on ${esc(this.name(f.home) || '?')}`));
          if (f.ended !== null) pts.push(this.pt(f.ended, -1, `${esc(f.name)} dies out`));
        }
      }
      this.fill(S[S.length - 2], null, pts, !a);
    }

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
    switch (def.id) {
      case 'market': {
        const pop = this.vals('pop'), off = this.vals('offEarth'), inter = this.vals('interstellarPop'), g = this.vals('gdpPerCap');
        const tp = pop ? turningPoints(pop.xs, pop.ys, true) : null;
        const tg = g ? turningPoints(g.xs, g.ys, true) : null;
        const half = pop && off ? this.first(off.ys, (v, i) => v > 0 && v > pop.ys[i] / 2) : -1;
        const beyond = inter ? this.first(inter.ys, (v) => v > 0) : -1;
        pts = [
          this.at(pop, tp?.max ?? -1, 'peak population'),
          this.at(pop, tp?.fall ?? -1, 'the steepest fall'),
          this.at(off, half, 'most people now live off Earth'),
          this.at(inter, beyond, 'first people beyond Sol'),
          this.at(g, tg?.rise ?? -1, 'the steepest rise in product per person'),
          this.at(g, tg?.fall ?? -1, 'the steepest fall in product per person'),
        ];
        waiting = !pop;
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
      case 'moves': {
        const xs = t ? t.edges.slice(0, NPERIODS) : [];
        lines = t ? [
          { label: 'people setting out', color: '#f2f2f2', xs, ys: t.moved },
          { label: 'lost in transit', color: '#ff8f7a', xs, ys: t.lost, dash: true },
        ] : [];
        pts = t ? [...t.hot].sort((x, y) => y.n - x.n).slice(0, 12)
          .map((h) => this.pt(h.year, h.body, `${esc(this.name(h.body) || '?')} — ${fmtNum(h.n)} arrivals${h.from >= 0 && this.name(h.from) ? `, mostly from ${esc(this.name(h.from))}` : ''}`)) : [];
        waiting = !t;
        break;
      }
      case 'consumers': {
        const h = this.vals('happiness'), gini = this.vals('gini'), sh = this.vals('shortage');
        const th = h ? turningPoints(h.xs, h.ys, false) : null;
        const gi = gini ? turningPoints(gini.xs, gini.ys, false) : null;
        pts = [
          this.at(h, th?.min ?? -1, 'happiness at its lowest'),
          this.at(h, th?.fall ?? -1, 'happiness falls fastest'),
          this.at(gini, gi?.max ?? -1, `most unequal (Gini ${gini && gi ? gini.ys[gi.max].toFixed(2) : ''})`),
          this.at(gini, gi?.min ?? -1, `most equal (Gini ${gini && gi ? gini.ys[gi.min].toFixed(2) : ''})`),
          this.at(sh, sh ? turningPoints(sh.xs, sh.ys, false).max : -1, 'the worst shortages'),
        ];
        waiting = !h;
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
      case 'costs': {
        const f = this.vals('costPerKg'), leo = this.vals('leoCostPerKg'), en = this.vals('energyPerCap');
        const tf = f ? turningPoints(f.xs, f.ys, true) : null;
        pts = [
          this.at(f, tf?.min ?? -1, 'freight is cheapest'),
          this.at(f, tf?.fall ?? -1, 'freight costs fall fastest'),
          this.at(leo, leo ? turningPoints(leo.xs, leo.ys, true).min : -1, 'launch to orbit is cheapest'),
          this.at(en, en ? turningPoints(en.xs, en.ys, false).max : -1, 'most energy per person'),
        ];
        waiting = !f;
        break;
      }
      case 'innovation': {
        const tfp = this.vals('tfp'), res = this.vals('research');
        const tt = tfp ? turningPoints(tfp.xs, tfp.ys, true) : null;
        const tr = res ? turningPoints(res.xs, res.ys, true) : null;
        pts = [
          this.at(tfp, tt?.rise ?? -1, 'productivity jumps fastest'),
          this.at(res, tr?.max ?? -1, 'research peaks'),
          this.at(res, tr?.fall ?? -1, 'research falls fastest'),
        ];
        waiting = !tfp;
        break;
      }
      case 'shocks': {
        lines = t ? t.shocks.map((c, i) => ({ label: c.label, color: PALETTE[i % PALETTE.length], xs: t.edges.slice(0, NPERIODS), ys: c.counts })) : [];
        pts = t ? t.shocks.flatMap((c) => c.top).sort((x, y) => y.n - x.n).slice(0, 12)
          .map((p) => this.pt(p.year, p.body, `${esc(p.label)}${this.name(p.body) ? ` on ${esc(this.name(p.body))}` : ''} — ${p.n} that period`)) : [];
        waiting = !t;
        break;
      }
      case 'divergence': {
        const d = this.vals('divergence');
        const h1 = d ? this.first(d.ys, (v) => v >= 0.5) : -1;
        const h2 = d ? this.first(d.ys, (v) => v >= 1) : -1;
        pts = [
          this.at(d, h1, 'peoples drift measurably apart'),
          this.at(d, h2, 'peoples become separate species'),
        ];
        waiting = !d;
        break;
      }
    }
    this.fill(s, lines, pts, waiting);
  }

  // ------------------------------------------------------------------ cursor repaint (year changed)

  /** A signed change as text: rate as "+1.84 %/yr", delta as signed fmtNum plus its unit (yr or %). */
  private fmtChg(kind: 'rate' | 'delta', change: number, unit: string): string {
    if (kind === 'rate') return `${change >= 0 ? '+' : ''}${change.toFixed(2)} %/yr`;
    return `${change >= 0 ? '+' : ''}${fmtNum(change)}${unit === 'yr' || unit === '%' ? ` ${unit}` : ''}`;
  }

  /** A signal's change as text: "+1.84 %/yr", "from zero", or a signed delta with its unit. */
  private chg(s: Signal): string {
    if (s.kind === 'rate') {
      if (s.change === null) return s.to > s.from ? 'from zero' : s.to < s.from ? 'to zero' : 'unchanged';
      return this.fmtChg('rate', s.change, '');
    }
    return this.fmtChg('delta', s.change!, GLOBAL_METRICS[GM[s.key]].unit);
  }

  /** The signal line of a data section at cursor year y. */
  private signalLine(def: TrendSection, y: number): string {
    const sim = this.host.sim, t = this.trends;
    const n = Math.min(sim.years.length, sim.frontier + 1);
    if (def.id === 'shocks') {
      if (!t) return 'Waiting for the run…';
      const head = shockSignal(t, 'disaster', y);
      if (!head) return 'No data yet at this year.';
      let html = `<b>${CAP[head.dir]}</b> Disasters: ${head.recent} in the 50 years to ${fmtYear(y)}, against ${head.before} in the 50 before`;
      for (const c of t.shocks) {
        if (c.key === 'disaster') continue;
        const s = shockSignal(t, c.key, y)!;
        html += ` · ${esc(c.label)} ${s.recent} (was ${s.before}) ${ARROW[s.dir]}`;
      }
      return html;
    }
    const head = signalAt(sim.years, sim.series, n, def.metrics[0], y);
    if (!head) return 'No data yet at this year.';
    let html = `<b>${CAP[head.dir]}</b> ${esc(GLOBAL_METRICS[GM[def.metrics[0]]].label)} ${this.chg(head)} over the ${Math.round(head.toYear - head.fromYear)} years to ${fmtYear(head.toYear)}`;
    for (const key of def.metrics.slice(1)) {
      const s = signalAt(sim.years, sim.series, n, key, y);
      if (s) html += ` · ${esc(GLOBAL_METRICS[GM[key]].label)} ${this.chg(s)} ${ARROW[s.dir]}`;
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
    const r = this.report;
    if (!r) return '';
    const yb = (y: number) => `<button class="link num" type="button" data-y="${y}" data-b="-1">${fmtYear(y)}</button>`;
    const lis: string[] = [];
    for (const sec of SECTIONS) {
      const head = sec.id === 'shocks' ? 'shock:disaster' : sec.metrics[0];
      const row = r.find((x) => x.section === sec.title && x.key === head);
      if (!row) continue;
      if (row.kind === 'count') {
        const busiest = Number.isFinite(row.peakYear) ? ` Busiest period from ${yb(row.peakYear)} (${row.peak} events).` : '';
        lis.push(`<li><b>Shocks</b>: Disasters, ${row.runChange} over the run; last 50 years ${row.lastChange! >= 0 ? '+' : ''}${row.lastChange} against the 50 before (${row.lastDir}).${busiest}</li>`);
        continue;
      }
      const from = Number.isFinite(row.startYear) ? `${fmtUnit(row.start, row.unit)} in ${yb(row.startYear)} → ` : '';
      let s = `<b>${esc(row.section)}</b>: ${esc(row.label)} ${from}${fmtUnit(row.end, row.unit)} in ${yb(row.endYear)}`;
      if (row.runChange !== null) s += `, ${this.fmtChg(row.kind, row.runChange, row.unit)} over the run`;
      s += `. Last 50 years: ${CAP[row.lastDir]}`;
      if (row.lastChange !== null) s += ` (${this.fmtChg(row.kind, row.lastChange, row.unit)})`;
      const tps = ([['Peak', row.peakYear], ['low', row.troughYear], ['steepest rise', row.riseYear], ['steepest fall', row.fallYear]] as [string, number][])
        .filter(([, y]) => Number.isFinite(y));
      if (tps.length) s += `. ${tps.map(([w, y]) => `${w} ${yb(y)}`).join(', ')}.`;
      lis.push(`<li>${s}</li>`);
    }
    return `<ol class="tr-rep">${lis.join('')}</ol><p class="tr-rep-tools"><button class="link" type="button" data-act="report-csv">Copy report (CSV)</button> <button class="link" type="button" data-act="series-csv">Copy series (CSV)</button> <span class="copy-status muted" aria-live="polite"></span></p>`;
  }

  /** Signal lines, the live market list, faint future points and chart cursors — all at the cursor year. */
  private paintCursor(): void {
    const y = this.host.year();
    const sim = this.host.sim;
    const rep = !sim.done
      ? `<p class="muted">The report is ready when this future's run ends. The run has reached ${fmtYear(sim.years[sim.frontier] ?? 0)}.</p>`
      : !this.report ? '<p class="muted">Preparing the report…</p>' : this.reportHtml();
    if (rep !== this.repHtml) { this.repHtml = rep; this.repBody.innerHTML = rep; }
    for (const s of this.secs) {
      if (s.signal) s.signal.innerHTML = this.signalLine(s.def!, y);
      if (s.live) s.live.innerHTML = this.marketLive(y);
    }
    for (const li of this.el.querySelectorAll<HTMLElement>('.tr-pts li')) {
      const b = li.querySelector<HTMLElement>('button[data-y]');
      li.classList.toggle('future', !!b && Number(b.dataset.y) > y);
    }
    for (const s of this.secs) if (s.chart && s.data) s.chart.set({ ...s.data, cursor: y });
  }
}
