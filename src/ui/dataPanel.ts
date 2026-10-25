// The data desk: a sheet of tabs over the 3D view. "Places" is every number
// of every living settlement at the current year, filterable with the query
// language, sortable, and copyable. Clicking a row selects the place.

import { EVENT_NAMES, STAGE_NAMES } from '../sim/catalog.ts';
import type { SimClient, TableMsg } from '../sim/client.ts';
import { DATA_FIELDS, DATA_FIELD_IDX, DATA_METRICS, F, GM, NF, NGM, SETTLEMENT_LABELS, type SField } from '../sim/metrics.ts';
import { PLACE_EXTRAS, placeBinder, tryCompile, type PlaceRow } from '../sim/query.ts';
import type { World } from '../sim/world.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';

export interface DataHost {
  world: World;
  sim: SimClient;
  year(): number;
  selectBody(b: number): void;
  selectedBody(): number;
  /** mark these bodies in the 3D view (null: none) */
  setHighlight(ids: Iterable<number> | null): void;
  /** show a series key in the bottom charts */
  showSeries(key: string): void;
  /** move the timeline to a year */
  pickYear?(y: number): void;
  /** the state shown at the current year (settlements, globals), if loaded */
  snap?(): import('../sim/client.ts').StateMsg | null;
}

/** One tab of the desk. `refresh` runs when the year, run or selection changes while it shows. */
export interface DataTab { id: string; label: string; el: HTMLElement; refresh(): void; hide?(): void }

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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

/** The field reference shown under every query box. */
export function queryHelp(): string {
  const fields = DATA_FIELDS.map((f) => `<code title="${esc(SETTLEMENT_LABELS[f]?.join(' ') ?? f)}">${f}</code>`).join(' ');
  const extra = PLACE_EXTRAS.map(([k, d]) => `<code title="${esc(d)}">${k}</code>`).join(' ');
  return `<details class="q-help"><summary>How to write a query</summary>
    <p>Compare fields with <code>&lt; &lt;= &gt; &gt;= == !=</code>, combine with <code>&amp;&amp; || !</code> (or <code>and or not</code>), do arithmetic with <code>+ - * / ^</code>. Numbers can be <code>1e6</code>, <code>2.5M</code>, <code>3B</code>. Text compares with <code>==</code> or <code>~</code> (contains): <code>system ~ "ceti"</code>. Functions: <code>abs sqrt log ln exp min max floor ceil round pow if(c,a,b)</code>.</p>
    <p>Examples: <code>stability &lt; 0.3 &amp;&amp; pop &gt; 1M</code> · <code>dist &gt; 10 and stage &gt;= 5</code> · <code>gdp / pop &gt; 1e5</code> · <code>allegiance == "Mars"</code></p>
    <p>Fields: ${fields}</p><p>Also: ${extra}</p></details>`;
}

/** Show a parse error under its query, with a caret at the spot. */
export function showError(el: HTMLElement, src: string, e: { message: string; pos: number } | null): void {
  el.hidden = !e;
  if (e) el.textContent = `${src}\n${' '.repeat(e.pos)}^ ${e.message}`;
}

export class DataPanel {
  el: HTMLElement;
  private host: DataHost;
  private tabs: DataTab[] = [];
  private active: DataTab | null = null;
  private timer = 0;
  private nav: HTMLElement;
  private sub: HTMLElement;
  onClose: () => void = () => {};
  /** open one mission in the launch-economics tab (set by installDataDesk) */
  openMission: (id: number) => void = () => {};
  /** open one observed object in Orbits, or one simulated impact in the Impact Lab (set by installDataDesk) */
  openSat: (norad: number) => void = () => {};
  openImpact: (id: number) => void = () => {};
  get hostApi(): DataHost { return this.host; }
  /** the shared filter: Places and Over time start from it */
  query = '';

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('section');
    this.el.className = 'data';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Data');
    this.el.innerHTML = `
      <header class="data-head">
        <h2>Data</h2><span class="data-sub muted num"></span>
        <nav class="data-tabs" role="tablist" aria-label="Data views"></nav>
        <span class="grow"></span>
        <button class="link" type="button" data-act="fold" aria-expanded="true" title="Fold the sheet to its first lines, to see the map">Fold</button>
        <button class="link" type="button" data-act="close">Close</button>
      </header>
      <footer class="data-foot muted"></footer>`;
    this.nav = this.el.querySelector('.data-tabs')!;
    this.sub = this.el.querySelector('.data-sub')!;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (tab) { this.show(tab); return; }
      const act = t.closest<HTMLElement>('.data-head [data-act]')?.dataset.act;
      if (act === 'close') this.toggle(false);
      else if (act === 'fold') {
        const f = this.el.classList.toggle('folded');
        t.textContent = f ? 'Unfold' : 'Fold';
        t.setAttribute('aria-expanded', String(!f));
      }
    });
    this.add(new PlacesTab(host, this));
  }

  add(tab: DataTab): void {
    this.tabs.push(tab);
    tab.el.classList.add('data-pane');
    tab.el.hidden = true;
    this.el.querySelector('.data-foot')!.before(tab.el);
    this.nav.insertAdjacentHTML('beforeend', `<button class="link" type="button" role="tab" data-tab="${tab.id}" aria-selected="false">${esc(tab.label)}</button>`);
    if (!this.active) this.show(tab.id);
  }

  show(id: string): void {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    if (this.active && this.active !== t) this.active.hide?.();
    this.active = t;
    for (const x of this.tabs) x.el.hidden = x !== t;
    for (const b of this.nav.querySelectorAll<HTMLElement>('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    this.refresh(true);
  }

  get open(): boolean { return !this.el.hidden; }
  toggle(on = !this.open): void {
    this.el.hidden = !on;
    this.el.classList.remove('folded');
    if (!on) { this.active?.hide?.(); this.onClose(); }
    if (on) this.refresh(true);
  }

  /** The year, the run or the selection changed. Cheap: the active tab updates at most every 200ms, and at least that often while changes keep coming (playback included). */
  refresh(now = false): void {
    if (!this.open || (this.timer && !now)) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const sim = this.host.sim;
      this.sub.textContent = sim.years.length ? `${fmtYear(this.host.year())} · future #${sim.seed}` : '';
      this.active?.refresh();
    }, now ? 0 : 200);
  }

  footer(html: string): void { this.el.querySelector('.data-foot')!.innerHTML = html; }

  private tbl: TableMsg | null = null;
  private tblKey = '';
  private tblBusy = false;
  /** Every living place at the current year, shared by the tabs: null while it is fetched (the tab refreshes when it lands). */
  table(): TableMsg | null {
    const sim = this.host.sim;
    if (!sim.years.length) return null;
    const step = sim.stepAt(this.host.year());
    if (this.tbl && this.tblKey === `${sim.seed}:${step}`) return this.tbl;
    if (!this.tblBusy) {
      this.tblBusy = true;
      const seed = sim.seed;
      sim.table(step).then((t) => {
        this.tblBusy = false;
        if (seed !== this.host.sim.seed) return;
        this.tbl = t;
        this.tblKey = `${seed}:${step}`;
        this.refresh(true);
      });
    }
    // keep showing the last table (if it is this run's) until the new one lands
    return this.tbl && this.tblKey.startsWith(`${sim.seed}:`) ? this.tbl : null;
  }
}

interface Col { key: string; head: string; title: string; text: boolean; value(b: number, r: number): number | string; show(b: number, r: number): string }

/** Every living settlement at the current year. */
class PlacesTab implements DataTab {
  id = 'places';
  label = 'Places';
  el: HTMLElement;
  private host: DataHost;
  private desk: DataPanel;
  private table: TableMsg | null = null;
  private cols: Col[];
  private sortKey = 'pop';
  private sortDir = -1;
  private limit = 200;
  private status: HTMLElement;
  private tbl: HTMLElement;
  private more: HTMLElement;
  private count: HTMLElement;
  private err: HTMLElement;
  private input: HTMLInputElement;
  private hl: HTMLInputElement;
  private match: ((r: PlaceRow) => boolean) | null = null;
  private qTimer = 0;

  constructor(host: DataHost, desk: DataPanel) {
    this.host = host;
    this.desk = desk;
    this.cols = this.columns();
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="data-tools">
        <label class="q">Filter <input type="search" spellcheck="false" autocomplete="off" placeholder="e.g. stability < 0.3 && pop > 1M" aria-label="Filter places with a query"></label>
        <span class="q-count num" aria-live="polite"></span>
        <label><input type="checkbox" checked> mark matches on the map</label>
      </div>
      <p class="q-err" hidden></p>
      ${queryHelp()}
      <div class="data-actions">
        <button class="link" type="button" data-act="csv">Copy CSV</button>
        <button class="link" type="button" data-act="json">Copy JSON</button>
        <button class="link" type="button" data-act="series">Copy global series (year × all metrics)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <div class="tbl-scroll"><table class="dtable"></table></div>
      <p class="data-more"></p>`;
    this.status = this.el.querySelector('.copy-status')!;
    this.tbl = this.el.querySelector('.dtable')!;
    this.more = this.el.querySelector('.data-more')!;
    this.count = this.el.querySelector('.q-count')!;
    this.err = this.el.querySelector('.q-err')!;
    this.input = this.el.querySelector('input[type=search]')!;
    this.hl = this.el.querySelector('input[type=checkbox]')!;
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.input.addEventListener('input', () => { clearTimeout(this.qTimer); this.qTimer = window.setTimeout(() => this.setQuery(this.input.value), 180); });
    this.hl.addEventListener('change', () => this.render());
  }

  hide(): void { this.host.setHighlight(null); }

  private setQuery(q: string): void {
    this.desk.query = q;
    this.match = null;
    const r = q.trim() ? tryCompile<PlaceRow>(q, placeBinder(this.host.world)) : null;
    showError(this.err, q, r instanceof Error ? r : null);
    if (r && !(r instanceof Error)) this.match = r.test;
    this.limit = 200;
    this.render();
  }

  refresh(): void {
    if (this.input.value !== this.desk.query) { this.input.value = this.desk.query; this.setQuery(this.desk.query); }
    const t = this.desk.table();
    if (!t) return;
    this.table = t;
    this.render();
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
    ];
    for (const f of DATA_FIELDS) {
      if (f === 'faction') continue;
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

  /** Row indices that pass the filter, in display order. */
  private order(): number[] {
    const t = this.table!;
    const col = this.cols.find((c) => c.key === this.sortKey) ?? this.cols[0];
    let idx = Array.from(t.bodies, (_, i) => i);
    const m = this.match;
    if (m) {
      const row: PlaceRow = { S: t.rows, b: 0, o: 0, year: t.year };
      idx = idx.filter((i) => { row.b = t.bodies[i]; row.o = i * NF; return m(row); });
    }
    const vals = new Map(idx.map((i) => [i, col.value(t.bodies[i], i)]));
    const d = this.sortDir;
    return idx.sort((a, b) => {
      const x = vals.get(a)!, y = vals.get(b)!;
      return (typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number)) * d || a - b;
    });
  }

  private render(): void {
    const t = this.table;
    if (!t) return;
    const rows = this.order();
    const total = t.bodies.length;
    this.count.textContent = this.match ? `${rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} places match in ${fmtYear(t.year)}` : `${total.toLocaleString('en-US')} living places in ${fmtYear(t.year)}`;
    if (!this.el.hidden) this.host.setHighlight(this.match && this.hl.checked ? rows.map((r) => t.bodies[r]) : null);
    const sel = this.host.selectedBody();
    const head = `<thead><tr>${this.cols.map((c) => `<th scope="col" title="${esc(c.title)}" class="${c.text ? 'txt' : ''}"><button type="button" data-sort="${c.key}" class="${c.key === this.sortKey ? 'on' : ''}">${esc(c.head)}${c.key === this.sortKey ? (this.sortDir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>`;
    const body = rows.slice(0, this.limit).map((r) => {
      const b = t.bodies[r];
      return `<tr data-b="${b}"${b === sel ? ' class="sel"' : ''}>${this.cols.map((c, k) => (k === 0 ? `<th scope="row"><button class="link" type="button">${c.show(b, r)}</button></th>` : `<td class="${c.text ? 'txt' : 'num'}">${c.show(b, r)}</td>`)).join('')}</tr>`;
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
    if (row) {
      this.host.selectBody(Number(row.dataset.b));
      for (const r of this.tbl.querySelectorAll('tr.sel')) r.classList.remove('sel');
      row.classList.add('sel');
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'more') { this.limit = Infinity; this.render(); }
    else if (act === 'csv') this.copyTable('csv');
    else if (act === 'json') this.copyTable('json');
    else if (act === 'series') this.copySeries();
  }

  /** Raw values: names as text, everything else as full-precision numbers. */
  private exportRows(): { columns: string[]; rows: (number | string)[][] } {
    const t = this.table!;
    const columns = ['body', 'name', 'system', 'dist_ly', 'faction_capital', ...DATA_FIELDS];
    const { bodies: B, systems: Sy } = this.host.world;
    const rows = this.order().map((r) => {
      const b = t.bodies[r];
      const fac = t.rows[r * NF + F.faction];
      return [b, B[b].name, Sy[B[b].system].name, Sy[B[b].system].dist, B[fac]?.name ?? '', ...DATA_FIELD_IDX.map((k) => t.rows[r * NF + k])];
    });
    return { columns, rows };
  }

  private copyTable(kind: 'csv' | 'json'): void {
    if (!this.table) return;
    const { columns, rows } = this.exportRows();
    const what = this.match ? `Settlements matching ${this.desk.query}` : 'Every living settlement';
    const title = `${what} in ${fmtYear(this.table.year)} (${rows.length} rows)`;
    const text = kind === 'csv' ? toCsv(columns, rows, title) : toJson({ year: fmtYear(this.table.year), query: this.match ? this.desk.query : null, columns, rows }, title);
    void copyText(text, kind === 'csv' ? 'Table as CSV' : 'Table as JSON', this.status);
  }

  private copySeries(): void {
    const sim = this.host.sim;
    const n = Math.min(sim.years.length, sim.frontier + 1);
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) rows.push([2040 + sim.years[i], ...DATA_METRICS.map((m) => sim.series[i * NGM + GM[m.key]])]);
    const text = toCsv(['year', ...DATA_METRICS.map((m) => m.key)], rows, `Global series: every metric at every simulated step (${n} steps; ${DATA_METRICS.map((m) => `${m.key}=${m.label}${m.unit ? ` [${m.unit}]` : ''}`).join('; ')})`);
    void copyText(text, 'Global series as CSV', this.status);
  }
}
