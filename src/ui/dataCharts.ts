// "Charts": the global series for the analyst. Up to four charts that zoom
// together, any metric or expression (gdp / pop), query results from "Over
// time", and every metric at the year under the pointer.

import { ERAS } from '../sim/catalog.ts';
import { DATA_METRICS, GLOBAL_METRICS, GM, NGM } from '../sim/metrics.ts';
import { globalBinder, tryCompile, type GlobalRow } from '../sim/query.ts';
import { AnalystChart, idxAt, type ABand, type ALine } from './analystChart.ts';
import { globalSeries, registeredSeries, type Series } from './charts.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv } from './exporter.ts';
import { fmtUnit, fmtYear } from './format.ts';

interface Row { key: string; chart: AnalystChart; el: HTMLElement; select: HTMLSelectElement; expr: HTMLInputElement }

/** Optional extras drawn on each chart: the band across all futures and where this run sits in it. */
export interface ChartExtras { band(key: string): ABand | null; badge(key: string, year: number): string }

export class ChartsTab implements DataTab {
  id = 'charts';
  label = 'Charts';
  el: HTMLElement;
  private host: DataHost;
  private rows: Row[] = [];
  private readout: HTMLElement;
  private hoverYear: number | null = null;
  extras: ChartExtras | null = null;
  private $ = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="data-actions">
        <button class="link" type="button" data-act="add">Add a chart</button>
        <button class="link" type="button" data-act="csv">Copy the charted series (CSV)</button>
        <button class="link" type="button" data-act="year">Copy every metric at this year (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <div class="dc-grid"><div class="dc-rows"></div><aside class="dc-readout" aria-live="off"></aside></div>`;
    this.readout = this.$('.dc-readout');
    for (const k of ['pop', 'gdpPerCap', 'kardashev', 'stability']) this.addRow(k);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement, act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      const status = this.$('.copy-status');
      if (act === 'add' && this.rows.length < 6) { this.addRow('energy'); this.refresh(); }
      else if (act === 'csv') this.copySeries(status);
      else if (act === 'year') this.copyYear(status);
      const rm = t.closest<HTMLElement>('[data-rm]');
      if (rm) { const r = this.rows.find((x) => x.el === rm.closest('.dc-row')); if (r && this.rows.length > 1) { r.el.remove(); this.rows = this.rows.filter((x) => x !== r); } }
    });
  }

  private options(cur: string): string {
    let html = '', group = '';
    for (const m of DATA_METRICS) {
      if (m.group !== group) { html += `${group ? '</optgroup>' : ''}<optgroup label="${esc(m.group)}">`; group = m.group; }
      html += `<option value="${m.key}"${m.key === cur ? ' selected' : ''}>${esc(m.label)}</option>`;
    }
    html += '</optgroup><optgroup label="Derived">';
    for (const [k, s] of registeredSeries()) html += `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(s.def.label)}</option>`;
    if (cur.startsWith('x:')) html += `<option value="${esc(cur)}" selected>${esc(cur.slice(2))}</option>`;
    return `${html}<option value="__expr">Expression… (e.g. gdp / pop)</option></optgroup>`;
  }

  private addRow(key: string): void {
    const el = document.createElement('div');
    el.className = 'dc-row';
    el.innerHTML = `<div class="dc-head"><select aria-label="Metric"></select><input type="text" class="chart-expr" placeholder="gdp / pop" spellcheck="false" hidden aria-label="Expression over the global metrics"><span class="dc-badge muted"></span><span class="grow"></span><button class="link muted" type="button" data-rm aria-label="Remove this chart">×</button></div>`;
    const select = el.querySelector('select')!, expr = el.querySelector('input')!;
    const def = GLOBAL_METRICS[GM[key]];
    const chart = new AnalystChart({ log: !!def?.log, warp: true, label: def?.label });
    el.append(chart.el);
    const row: Row = { key, chart, el, select, expr };
    select.innerHTML = this.options(key);
    select.addEventListener('focus', () => { select.innerHTML = this.options(row.key); });
    select.addEventListener('change', () => {
      if (select.value === '__expr') { expr.hidden = false; expr.value = row.key.startsWith('x:') ? row.key.slice(2) : ''; expr.focus(); return; }
      row.key = select.value;
      chart.log = !!GLOBAL_METRICS[GM[row.key]]?.log || !!registeredSeries().get(row.key)?.def.log;
      this.drawRow(row);
    });
    const setExpr = () => {
      const src = expr.value.trim();
      const c = src ? tryCompile<GlobalRow>(src, globalBinder()) : null;
      if (c instanceof Error) { expr.setCustomValidity(`${c.message} (at ${c.pos + 1})`); expr.reportValidity(); return; }
      if (src) row.key = `x:${src}`;
      expr.hidden = true;
      select.innerHTML = this.options(row.key);
      const s = this.series(row.key);
      chart.log = !!s?.def.log;
      this.drawRow(row);
    };
    expr.addEventListener('input', () => expr.setCustomValidity(''));
    expr.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') setExpr(); else if (e.key === 'Escape') { expr.hidden = true; select.value = row.key; } });
    chart.onView = () => { for (const r of this.rows) if (r !== row) { r.chart.range = chart.range; r.chart.warp = chart.warp; r.chart.draw(); } };
    chart.onHover = (y) => { this.hoverYear = y; this.renderReadout(); };
    chart.onPick = (y) => this.host.pickYear?.(y);
    chart.tooltip = null;
    this.rows.push(row);
    this.$('.dc-rows').append(el);
  }

  private series(key: string): Series | null {
    const sim = this.host.sim;
    return sim.years.length ? globalSeries(sim.years, sim.series, sim.frontier, key) : null;
  }

  private lineOf(key: string): ALine | null {
    const s = this.series(key);
    if (!s) return null;
    const xs = s.years.slice(0, s.n), ys = xs.map((_, i) => s.values(i));
    return { label: s.def.label, color: '#f2f2f2', xs, ys, unit: s.def.unit };
  }

  private drawRow(r: Row): void {
    const line = this.lineOf(r.key);
    const band = this.extras?.band(r.key) ?? null;
    r.chart.set({ lines: line ? [line] : [], bands: band ? [band] : [], cursor: this.host.year() });
    const badge = this.extras?.badge(r.key, this.host.year()) ?? '';
    r.el.querySelector('.dc-badge')!.innerHTML = badge;
  }

  refresh(): void {
    if (this.el.hidden) return;
    for (const r of this.rows) this.drawRow(r);
    this.renderReadout();
  }

  /** Every global metric at the year under the pointer (or the current year). */
  private renderReadout(): void {
    const sim = this.host.sim;
    if (!sim.years.length) { this.readout.innerHTML = ''; return; }
    const year = this.hoverYear ?? this.host.year();
    const i = Math.max(0, Math.min(sim.frontier, idxAt(sim.years, year)));
    let html = `<p class="dc-y">${fmtYear(sim.years[i])}${this.hoverYear === null ? ' <span class="muted">(now)</span>' : ''}</p><dl>`, group = '';
    for (const m of DATA_METRICS) {
      if (m.group !== group) { html += `<dt class="dc-g">${esc(m.group)}</dt><dd></dd>`; group = m.group; }
      const v = sim.series[i * NGM + GM[m.key]];
      html += `<dt>${esc(m.label)}</dt><dd class="num">${m.key === 'era' ? esc(ERAS[v] ?? '') : esc(fmtUnit(v, m.unit))}</dd>`;
    }
    this.readout.innerHTML = `${html}</dl>`;
  }

  private copySeries(status: HTMLElement): void {
    const lines = this.rows.map((r) => ({ key: r.key, l: this.lineOf(r.key) })).filter((x) => x.l);
    if (!lines.length) return;
    const xs = lines[0].l!.xs;
    const rows = Array.from(xs, (y, i) => [2040 + y, ...lines.map((x) => x.l!.ys[i])]);
    void copyText(toCsv(['year', ...lines.map((x) => x.key)], rows, `Charted series: ${lines.map((x) => x.l!.label).join('; ')}`), 'Series as CSV', status);
  }

  private copyYear(status: HTMLElement): void {
    const sim = this.host.sim;
    if (!sim.years.length) return;
    const i = Math.max(0, Math.min(sim.frontier, idxAt(sim.years, this.hoverYear ?? this.host.year())));
    const rows = DATA_METRICS.map((m) => [m.key, m.label, m.unit, sim.series[i * NGM + GM[m.key]]]);
    void copyText(toCsv(['metric', 'label', 'unit', 'value'], rows, `Every global metric in ${fmtYear(sim.years[i])}`), 'Metrics as CSV', status);
  }
}
