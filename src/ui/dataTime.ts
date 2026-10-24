// "Over time": a settlement query evaluated across the whole run. The worker
// replays the run from its first snapshot and counts (or sums, or averages)
// the matching places at every n-th step.

import type { Agg } from '../sim/dataApi.ts';
import { placeBinder, tryCompile, type PlaceRow } from '../sim/query.ts';
import { registerSeries } from './charts.ts';
import { esc, queryHelp, showError, type DataHost, type DataPanel, type DataTab } from './dataPanel.ts';
import { copyText, toCsv } from './exporter.ts';
import { AnalystChart } from './analystChart.ts';

const AGG_LABEL: Record<Agg, string> = { count: 'number of places', sum: 'sum of', mean: 'population-weighted mean of', min: 'smallest', max: 'largest' };

export class TimeTab implements DataTab {
  id = 'time';
  label = 'Over time';
  el: HTMLElement;
  private host: DataHost;
  private desk: DataPanel;
  private q: HTMLInputElement;
  private of: HTMLInputElement;
  private agg: HTMLSelectElement;
  private stride: HTMLSelectElement;
  private err: HTMLElement;
  private note: HTMLElement;
  private chart = new AnalystChart({ label: 'Query result over time' });
  private result: { title: string; key: string; years: number[]; values: Float64Array; seed: number } | null = null;
  private waiting = false;
  private n = 0;

  constructor(host: DataHost, desk: DataPanel) {
    this.host = host;
    this.desk = desk;
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="data-tools">
        <label class="q">Places where <input type="search" class="tq" spellcheck="false" autocomplete="off" placeholder="all living places, or e.g. stage >= 5" aria-label="Which places"></label>
      </div>
      <div class="data-tools">
        <label>Measure <select class="tagg">${(Object.keys(AGG_LABEL) as Agg[]).map((a) => `<option value="${a}">${AGG_LABEL[a]}</option>`).join('')}</select></label>
        <label class="q tof-wrap">field <input type="text" class="tof" spellcheck="false" value="pop" aria-label="Field or expression to sum or average"></label>
        <label>every <select class="tstride"><option value="1">step</option><option value="4">4th step</option><option value="20" selected>20th step (instant)</option></select></label>
        <button class="link" type="button" data-act="run">Run over the whole future</button>
      </div>
      <p class="q-err" hidden></p>
      ${queryHelp()}
      <div class="data-actions">
        <button class="link" type="button" data-act="chart" disabled>Show in the charts below</button>
        <button class="link" type="button" data-act="csv" disabled>Copy CSV</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <p class="t-note muted"></p>`;
    this.el.append(this.chart.el);
    this.chart.onPick = (y) => this.host.pickYear?.(y);
    const $ = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
    this.q = $('.tq'); this.of = $('.tof'); this.agg = $('.tagg'); this.stride = $('.tstride');
    this.err = $('.q-err'); this.note = $('.t-note');
    const ofWrap = $('.tof-wrap');
    const sync = () => { ofWrap.hidden = this.agg.value === 'count'; };
    sync();
    this.agg.addEventListener('change', sync);
    this.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    this.of.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'run') this.run();
      else if (act === 'chart' && this.result) { this.host.showSeries(this.result.key); }
      else if (act === 'csv' && this.result) {
        const r = this.result;
        void copyText(toCsv(['year', 'value'], r.years.map((y, i) => [2040 + y, r.values[i]]), r.title), 'Series as CSV', this.el.querySelector<HTMLElement>('.copy-status'));
      }
    });
  }

  refresh(): void {
    if (!this.q.value && this.desk.query && !this.result) this.q.value = this.desk.query;
    if (this.result && this.result.seed !== this.host.sim.seed) { this.result = null; this.note.textContent = 'A new future: run the query again.'; this.buttons(); }
    if (this.waiting && this.host.sim.done) this.run();
    this.draw();
  }

  private buttons(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-act=chart], [data-act=csv]')) b.disabled = !this.result;
  }

  private run(): void {
    const bind = placeBinder(this.host.world);
    const expr = this.q.value.trim(), agg = this.agg.value as Agg, of = this.of.value.trim() || 'pop';
    for (const [src, el] of [[expr, this.q], [agg === 'count' ? '' : of, this.of]] as const) {
      const r = src ? tryCompile<PlaceRow>(src, bind) : null;
      showError(this.err, src, r instanceof Error ? r : null);
      if (r instanceof Error) { el.focus(); return; }
    }
    const sim = this.host.sim, seed = sim.seed, stride = Number(this.stride.value);
    if (!sim.done) { this.waiting = true; this.note.textContent = 'The future is still being simulated; the query runs as soon as it is done.'; return; }
    this.waiting = false;
    const id = ++this.n;
    const t0 = performance.now();
    this.note.textContent = stride % 20 ? 'Replaying the whole future…' : 'Reading the saved states…';
    sim.scan(expr, agg, of, stride).then((m) => {
      if (id !== this.n || seed !== sim.seed) return;
      if (m.error) { this.note.textContent = m.error; return; }
      if (m.pending) { this.waiting = true; this.note.textContent = 'Waiting for the simulation to finish.'; return; }
      const what = agg === 'count' ? 'count' : `${agg}(${of})`;
      const title = `${what} of places where ${expr || 'alive'} · future #${seed} · every ${stride === 1 ? '' : `${stride}th `}step`;
      const key = `q:${what} where ${expr || 'alive'}`;
      const years = Array.from(m.steps, (s) => sim.years[s]);
      this.result = { title, key, years, values: m.values, seed };
      const fin = Array.from(m.values).filter(Number.isFinite), lo = Math.min(...fin), hi = Math.max(...fin);
      this.chart.log = lo > 0 && hi / lo > 1000;
      registerSeries(key, { years, n: years.length, values: (i) => m.values[i], def: { key, label: `${what} where ${expr || 'alive'}`, unit: '', log: this.chart.log, group: 'Query' } });
      this.note.innerHTML = `${esc(title)} — ${years.length} points in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
      this.buttons();
      this.draw();
    });
  }

  private draw(): void {
    if (this.el.hidden) return;
    const r = this.result;
    this.chart.set({ lines: r ? [{ label: r.title, color: '#ffc45c', xs: r.years, ys: r.values }] : [], cursor: this.host.year(), empty: 'Run a query to see it over the whole future.' });
  }
}
