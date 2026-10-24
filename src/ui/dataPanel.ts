// The Data tab: every number of every living settlement at the current year,
// as a sortable table you can copy out. Clicking a row selects the place.

import { EVENT_NAMES, STAGE_NAMES } from '../sim/catalog.ts';
import type { SimClient, TableMsg } from '../sim/client.ts';
import { F, GLOBAL_METRICS, NF, NGM, SETTLEMENT_FIELDS, SETTLEMENT_LABELS, type SField } from '../sim/metrics.ts';
import type { World } from '../sim/world.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';

export interface DataHost {
  world: World;
  sim: SimClient;
  year(): number;
  selectBody(b: number): void;
  selectedBody(): number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Compact cell text: 3 significant figures, words for big numbers. */
export function cell(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15) return v.toExponential(2);
  if (a >= 1000) return fmtNum(v);
  if (Number.isInteger(v)) return String(v);
  return a >= 1 ? v.toFixed(2) : v.toPrecision(2);
}

interface Col { key: string; head: string; title: string; text: boolean; value(b: number, r: number): number | string; show(b: number, r: number): string }

export class DataPanel {
  el: HTMLElement;
  private host: DataHost;
  private table: TableMsg | null = null;
  private tableKey = '';
  private cols: Col[];
  private sortKey = 'pop';
  private sortDir = -1;
  private limit = 200;
  private timer = 0;
  private inflight = false;
  private status: HTMLElement;
  private sub: HTMLElement;
  private tbl: HTMLElement;
  private more: HTMLElement;

  constructor(host: DataHost) {
    this.host = host;
    this.cols = this.columns();
    this.el = document.createElement('section');
    this.el.className = 'data';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Data');
    this.el.innerHTML = `
      <header class="data-head">
        <h2>Data</h2><span class="data-sub muted num"></span>
        <span class="grow"></span>
        <button class="link" type="button" data-act="fold" aria-expanded="true">Fold</button>
        <button class="link" type="button" data-act="close">Close</button>
      </header>
      <div class="data-pane">
        <div class="data-actions">
          <button class="link" type="button" data-act="csv">Copy CSV</button>
          <button class="link" type="button" data-act="json">Copy JSON</button>
          <button class="link" type="button" data-act="series">Copy global series (year × all metrics)</button>
          <span class="copy-status muted" aria-live="polite"></span>
        </div>
        <div class="tbl-scroll"><table class="dtable"></table></div>
        <p class="data-more"></p>
      </div>`;
    this.status = this.el.querySelector('.copy-status')!;
    this.sub = this.el.querySelector('.data-sub')!;
    this.tbl = this.el.querySelector('.dtable')!;
    this.more = this.el.querySelector('.data-more')!;
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  get open(): boolean { return !this.el.hidden; }
  onClose: () => void = () => {};
  toggle(on = !this.open): void {
    this.el.hidden = !on;
    if (!on) this.onClose();
    this.el.classList.remove('folded');
    if (on) this.refresh(true);
  }

  /** The year, the run or the selection changed. Cheap; fetches at most every 200ms. */
  refresh(now = false): void {
    if (!this.open) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fetch(), now ? 0 : 200);
  }

  private fetch(): void {
    const sim = this.host.sim;
    if (!sim.years.length) return;
    const step = sim.stepAt(this.host.year());
    const key = `${sim.seed}:${step}`;
    if (key === this.tableKey && this.table) { this.render(); return; }
    if (this.inflight) { this.refresh(); return; }
    this.inflight = true;
    sim.table(step).then((t) => {
      this.inflight = false;
      if (sim.seed !== this.host.sim.seed) return;
      this.table = t;
      this.tableKey = `${sim.seed}:${t.step}`;
      this.render();
    });
  }

  private columns(): Col[] {
    const { bodies: B, systems: Sy } = this.host.world;
    const v = (r: number, f: SField) => this.table!.rows[r * NF + F[f]];
    const name = (b: number) => (b >= 0 ? B[b]?.name ?? '' : '');
    const cols: Col[] = [
      { key: 'name', head: 'name', title: 'World', text: true, value: (b) => B[b].name, show: (b) => esc(B[b].name) },
      { key: 'system', head: 'system', title: 'Star system', text: true, value: (b) => Sy[B[b].system].name, show: (b) => esc(Sy[B[b].system].name) },
      { key: 'dist', head: 'dist', title: 'Light years from the Sun', text: false, value: (b) => Sy[B[b].system].dist, show: (b) => Sy[B[b].system].dist.toFixed(1) },
      { key: 'capital', head: 'faction', title: 'Faction, named for its capital', text: true, value: (_b, r) => name(v(r, 'faction')), show: (_b, r) => esc(name(v(r, 'faction'))) },
      { key: 'faith', head: 'faith', title: 'Faith (culture) number', text: false, value: (_b, r) => v(r, 'culture'), show: (_b, r) => `#${v(r, 'culture')}` },
    ];
    for (const f of SETTLEMENT_FIELDS) {
      if (f === 'faction' || f === 'culture') continue;
      const lab = SETTLEMENT_LABELS[f];
      const title = lab ? `${lab[0]}${lab[1] ? ` (${lab[1]})` : ''}` : f;
      if (f === 'stage') cols.push({ key: f, head: f, title: 'Stage', text: false, value: (_b, r) => v(r, f), show: (_b, r) => STAGE_NAMES[v(r, f)] ?? '' });
      else if (f === 'parent') cols.push({ key: f, head: 'from', title: 'Founded from', text: true, value: (_b, r) => name(v(r, f)), show: (_b, r) => esc(name(v(r, f))) });
      else if (f === 'founded') cols.push({ key: f, head: f, title: 'Year founded', text: false, value: (_b, r) => v(r, f), show: (_b, r) => fmtYear(v(r, f)) });
      else if (f === 'lastEvent') cols.push({ key: f, head: f, title: 'Last thing that happened here', text: true, value: (_b, r) => EVENT_NAMES[v(r, f)] ?? '', show: (_b, r) => esc(EVENT_NAMES[v(r, f)] ?? '') });
      else cols.push({ key: f, head: f, title, text: false, value: (_b, r) => v(r, f), show: (_b, r) => cell(v(r, f)) });
    }
    return cols;
  }

  /** Row indices in display order. */
  private order(): number[] {
    const t = this.table!;
    const col = this.cols.find((c) => c.key === this.sortKey) ?? this.cols[0];
    const idx = Array.from(t.bodies, (_, i) => i);
    const vals = idx.map((i) => col.value(t.bodies[i], i));
    const d = this.sortDir;
    return idx.sort((a, b) => {
      const x = vals[a], y = vals[b];
      return (typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number)) * d || a - b;
    });
  }

  private render(): void {
    const t = this.table;
    if (!t) return;
    const rows = this.order();
    this.sub.textContent = `${fmtYear(t.year)} · ${rows.length.toLocaleString('en-US')} living places · future #${this.host.sim.seed}`;
    const sel = this.host.selectedBody();
    const head = `<thead><tr>${this.cols.map((c) => `<th scope="col" title="${esc(c.title)}" class="${c.text ? 'txt' : ''}"><button type="button" data-sort="${c.key}" class="${c.key === this.sortKey ? 'on' : ''}">${esc(c.head)}${c.key === this.sortKey ? (this.sortDir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>`;
    const body = rows.slice(0, this.limit).map((r) => {
      const b = t.bodies[r];
      return `<tr data-b="${b}"${b === sel ? ' class="sel"' : ''}>${this.cols.map((c, k) => (k === 0 ? `<th scope="row"><button class="link" type="button" data-body="${b}">${c.show(b, r)}</button></th>` : `<td class="${c.text ? 'txt' : 'num'}">${c.show(b, r)}</td>`)).join('')}</tr>`;
    }).join('');
    this.tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    this.more.innerHTML = rows.length > this.limit ? `Showing ${this.limit} of ${rows.length.toLocaleString('en-US')}. <button class="link" type="button" data-act="more">Show all</button>` : '';
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>('[data-sort]');
    if (sort) {
      const k = sort.dataset.sort!;
      if (k === this.sortKey) this.sortDir = -this.sortDir;
      else { this.sortKey = k; this.sortDir = this.cols.find((c) => c.key === k)?.text ? 1 : -1; }
      this.render();
      return;
    }
    const row = t.closest<HTMLElement>('tr[data-b]');
    if (row && !t.closest('[data-act]')) {
      this.host.selectBody(Number(row.dataset.b));
      for (const r of this.tbl.querySelectorAll('tr.sel')) r.classList.remove('sel');
      row.classList.add('sel');
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') this.toggle(false);
    else if (act === 'fold') {
      const f = this.el.classList.toggle('folded');
      t.textContent = f ? 'Unfold' : 'Fold';
      t.setAttribute('aria-expanded', String(!f));
    } else if (act === 'more') { this.limit = Infinity; this.render(); }
    else if (act === 'csv') this.copyTable('csv');
    else if (act === 'json') this.copyTable('json');
    else if (act === 'series') this.copySeries();
  }

  /** Raw values: names as text, everything else as full-precision numbers. */
  private exportRows(): { columns: string[]; rows: (number | string)[][] } {
    const t = this.table!;
    const columns = ['body', 'name', 'system', 'dist_ly', 'faction_capital', ...SETTLEMENT_FIELDS];
    const { bodies: B, systems: Sy } = this.host.world;
    const rows = this.order().map((r) => {
      const b = t.bodies[r];
      const fac = t.rows[r * NF + F.faction];
      return [b, B[b].name, Sy[B[b].system].name, Sy[B[b].system].dist, B[fac]?.name ?? '', ...Array.from(t.rows.subarray(r * NF, r * NF + NF))];
    });
    return { columns, rows };
  }

  private copyTable(kind: 'csv' | 'json'): void {
    if (!this.table) return;
    const { columns, rows } = this.exportRows();
    const title = `Every living settlement in ${fmtYear(this.table.year)} (${rows.length} rows)`;
    const text = kind === 'csv' ? toCsv(columns, rows, title)
      : toJson({ year: fmtYear(this.table.year), columns, rows }, title);
    void copyText(text, kind === 'csv' ? 'Table as CSV' : 'Table as JSON', this.status);
  }

  private copySeries(): void {
    const sim = this.host.sim;
    const n = Math.min(sim.years.length, sim.frontier + 1);
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) rows.push([2040 + sim.years[i], ...Array.from(sim.series.subarray(i * NGM, i * NGM + NGM))]);
    const text = toCsv(['year', ...GLOBAL_METRICS.map((m) => m.key)], rows, `Global series: every metric at every simulated step (${n} steps; ${GLOBAL_METRICS.map((m) => `${m.key}=${m.label}${m.unit ? ` [${m.unit}]` : ''}`).join('; ')})`);
    void copyText(text, 'Global series as CSV', this.status);
  }
}
