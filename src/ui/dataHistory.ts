// "Place history": every field of a place over the whole run. Pin up to five
// places, chart any field or expression for all of them on one chart, and copy
// a place's full history (every field at every step) as CSV.

import type { PlaceRes } from '../sim/dataApi.ts';
import { DATA_FIELDS, DATA_FIELD_IDX, NF, SETTLEMENT_LABELS, type SField } from '../sim/metrics.ts';
import { PLACE_NAMES, placeBinder, tryCompile, type PlaceRow } from '../sim/query.ts';
import { AnalystChart, type ALine } from './analystChart.ts';
import { esc, showError, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv } from './exporter.ts';
import { PALETTE } from './miniChart.ts';

const MAX_PINS = 5;

export class HistoryTab implements DataTab {
  id = 'history';
  label = 'Place history';
  el: HTMLElement;
  private host: DataHost;
  private pins: number[] = [];
  private autoPinned = false;
  private data: PlaceRes | null = null;
  private dataKey = '';
  private busy = '';
  private chart = new AnalystChart({ log: true, label: 'Pinned places over time' });
  private $ = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="data-tools">
        <button class="link" type="button" data-act="pin">Pin the selected place</button>
        <span class="h-pins"></span>
      </div>
      <div class="data-tools">
        <label class="q">Chart <input type="text" class="h-expr" list="h-fields" spellcheck="false" autocomplete="off" value="pop" aria-label="Field or expression to chart for each pinned place"></label>
        <datalist id="h-fields">${PLACE_NAMES.map((f) => `<option value="${f}">${esc(SETTLEMENT_LABELS[f as SField]?.[0] ?? '')}</option>`).join('')}</datalist>
        <label>every <select class="h-stride"><option value="20">20th step (instant)</option><option value="4" selected>4th step</option><option value="1">step</option></select></label>
      </div>
      <p class="q-err" hidden></p>
      <div class="data-actions">
        <button class="link" type="button" data-act="chartcsv" disabled>Copy the chart (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
        <span class="muted h-note"></span>
      </div>`;
    this.el.append(this.chart.el);
    this.chart.onPick = () => {};
    this.$('.h-expr').addEventListener('input', () => this.draw());
    this.$('.h-stride').addEventListener('change', () => this.fetch());
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  /** Pin a place (from anywhere); the oldest pin goes when there are too many. */
  pin(b: number): void {
    if (b < 0 || this.pins.includes(b)) return;
    this.pins.push(b);
    if (this.pins.length > MAX_PINS) this.pins.shift();
    this.refresh();
  }

  refresh(): void {
    const sel = this.host.selectedBody();
    if (!this.autoPinned && !this.pins.length && sel >= 0) { this.pins.push(sel); this.autoPinned = true; }
    const B = this.host.world.bodies;
    this.$('.h-pins').innerHTML = this.pins.length
      ? this.pins.map((b, j) => `<span class="h-pin"><i style="background:${PALETTE[j]}"></i><button class="link" type="button" data-b="${b}">${esc(B[b].name)}</button> <button class="link muted" type="button" data-csv="${b}" title="Every field of ${esc(B[b].name)} at every step">history CSV</button> <button class="link muted" type="button" data-unpin="${b}" aria-label="Unpin ${esc(B[b].name)}">×</button></span>`).join('')
      : '<span class="muted">Select a place on the map or in the Places table, then pin it. Up to five.</span>';
    (this.$('[data-act=pin]') as HTMLButtonElement).disabled = sel < 0 || this.pins.includes(sel) || this.pins.length >= MAX_PINS;
    this.fetch();
  }

  private fetch(): void {
    const sim = this.host.sim, stride = Number(this.$<HTMLSelectElement>('.h-stride').value);
    const key = `${sim.seed}:${stride}:${this.pins.join(',')}`;
    const note = this.$('.h-note');
    if (!this.pins.length) { this.data = null; this.draw(); return; }
    if (!sim.done) { note.textContent = 'Waiting for the simulation to finish.'; this.draw(); return; }
    if (key === this.dataKey || key === this.busy) { this.draw(); return; }
    this.busy = key;
    note.textContent = stride % 20 ? 'Replaying the whole future…' : '';
    const t0 = performance.now();
    sim.data<'place'>({ type: 'place', bodies: this.pins, stride }).then((m) => {
      if (this.busy !== key) return;
      this.busy = '';
      if (m.pending) { note.textContent = 'Waiting for the simulation to finish.'; return; }
      this.data = m; this.dataKey = key;
      note.textContent = `${m.steps.length} points each, in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      (this.$('[data-act=chartcsv]') as HTMLButtonElement).disabled = false;
      this.draw();
    });
  }

  /** One line per pinned place: the expression evaluated at every step. */
  private lines(): ALine[] | null {
    const m = this.data, src = this.$<HTMLInputElement>('.h-expr').value.trim() || 'pop';
    const c = tryCompile<PlaceRow>(src, placeBinder(this.host.world));
    showError(this.$('.q-err'), src, c instanceof Error ? c : null);
    if (c instanceof Error || !m) return null;
    const sim = this.host.sim, nb = m.bodies.length, xs = Array.from(m.steps, (s) => sim.years[s]);
    const lab = SETTLEMENT_LABELS[src as SField];
    return m.bodies.map((b, j) => {
      const row: PlaceRow = { S: m.rows, b, o: 0, year: 0 };
      const ys = xs.map((y, i) => { row.o = (i * nb + j) * NF; row.year = y; return Number.isNaN(m.rows[row.o]) ? NaN : c.value(row); });
      return { label: this.host.world.bodies[b].name, color: PALETTE[this.pins.indexOf(b)] ?? PALETTE[j], xs, ys, unit: lab?.[1] };
    });
  }

  private draw(): void {
    if (this.el.hidden) return;
    const lines = this.lines();
    this.chart.set({ lines: lines ?? [], cursor: this.host.year(), empty: this.pins.length ? 'Waiting for the run…' : 'Pin a place to see its history.' });
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const status = this.$('.copy-status');
    const d = t.closest<HTMLElement>('[data-b],[data-unpin],[data-csv],[data-act]');
    if (!d) return;
    if (d.dataset.b) this.host.selectBody(Number(d.dataset.b));
    else if (d.dataset.unpin) { this.pins = this.pins.filter((b) => b !== Number(d.dataset.unpin)); this.refresh(); }
    else if (d.dataset.csv) {
      const b = Number(d.dataset.csv), m = this.data;
      const j = m ? m.bodies.indexOf(b) : -1;
      if (!m || j < 0) return;
      const sim = this.host.sim, nb = m.bodies.length, rows: number[][] = [];
      m.steps.forEach((s, i) => { const o = (i * nb + j) * NF; if (!Number.isNaN(m.rows[o])) rows.push([2040 + sim.years[s], ...DATA_FIELD_IDX.map((k) => m.rows[o + k])]); });
      void copyText(toCsv(['year', ...DATA_FIELDS], rows, `History of ${this.host.world.bodies[b].name} (body ${b}): every field, ${rows.length} steps`), `History of ${this.host.world.bodies[b].name}`, status);
    } else if (d.dataset.act === 'pin') this.pin(this.host.selectedBody());
    else if (d.dataset.act === 'chartcsv') {
      const lines = this.lines();
      if (!lines?.length) return;
      const rows = Array.from(lines[0].xs, (y, i) => [2040 + y, ...lines.map((l) => l.ys[i])]);
      const src = this.$<HTMLInputElement>('.h-expr').value.trim() || 'pop';
      void copyText(toCsv(['year', ...lines.map((l) => l.label)], rows, `${src} for ${lines.map((l) => l.label).join(', ')}`), 'Chart as CSV', status);
    }
  }
}
