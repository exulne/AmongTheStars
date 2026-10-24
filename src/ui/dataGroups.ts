// "Groups": humanity broken down by faction, faith, star system or stage at
// the current year, a card for any one group (a faction's capital, reach,
// faiths and members), and the share each of the biggest groups held over the
// whole run as a stacked area.

import { STAGE_NAMES } from '../sim/catalog.ts';
import type { TableMsg } from '../sim/client.ts';
import { groupKey, type DataRes, type GroupBy } from '../sim/dataApi.ts';
import { F, NF, SETTLEMENT_FIELDS } from '../sim/metrics.ts';
import { placeBinder, tryCompile, type PlaceRow } from '../sim/query.ts';
import { cell, esc, type DataHost, type DataPanel, type DataTab } from './dataPanel.ts';
import { copyText, toCsv } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';
import { PALETTE, drawLines, drawStacked } from './miniChart.ts';

type GroupsMsg = Extract<DataRes, { type: 'groups' }>;
const BY_LABEL: Record<GroupBy, [string, string]> = { faction: ['faction', 'factions'], culture: ['majority faith', 'faiths'], system: ['star system', 'star systems'], stage: ['stage', 'stages'] };
const OTHER = 'rgba(154, 157, 163, 0.45)';

/** One group at the current year. */
interface Agg {
  key: number; places: number; pop: number; gdp: number; energy: number; research: number; military: number; capital: number;
  stab: number; happy: number; systems: Set<number>; faiths: Map<number, number>; factions: Map<number, number>; members: number[]; oldest: number;
}

const COLS: { key: keyof Agg | 'share' | 'name' | 'nsys'; head: string; title: string }[] = [
  { key: 'name', head: 'group', title: 'The group' }, { key: 'places', head: 'places', title: 'Living settlements' },
  { key: 'pop', head: 'people', title: 'Population' }, { key: 'share', head: 'share', title: 'Share of everyone alive (in the rows shown)' },
  { key: 'gdp', head: 'product', title: 'Gross product, $/yr' }, { key: 'energy', head: 'energy', title: 'Energy use, W' },
  { key: 'research', head: 'research', title: 'Research, pts/yr' }, { key: 'military', head: 'military', title: 'Military spending, $/yr' },
  { key: 'stab', head: 'stability', title: 'Stability, population-weighted' }, { key: 'happy', head: 'happiness', title: 'Happiness, population-weighted' },
  { key: 'nsys', head: 'systems', title: 'Star systems with a member' },
];

export class GroupsTab implements DataTab {
  id = 'groups';
  label = 'Groups';
  el: HTMLElement;
  private host: DataHost;
  private desk: DataPanel;
  private by: GroupBy = 'faction';
  private sortKey: string = 'pop';
  private sortDir = -1;
  private focus: number | null = null;
  private aggs: Agg[] = [];
  private total = 0;
  private year = 0;
  private faithNames = new Map<number, string>();
  private faithSeed = -1;
  private over: GroupsMsg | null = null;
  private overKey = '';
  private overBusy = '';
  private $ = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;

  constructor(host: DataHost, desk: DataPanel) {
    this.host = host;
    this.desk = desk;
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="data-tools">
        <label>Group by <select class="g-by">${(Object.keys(BY_LABEL) as GroupBy[]).map((b) => `<option value="${b}">${BY_LABEL[b][0]}</option>`).join('')}</select></label>
        <label class="g-filter-wrap"><input type="checkbox" class="g-filter" checked> only places matching the filter <code class="g-q"></code></label>
        <span class="q-count num g-count" aria-live="polite"></span>
      </div>
      <div class="data-actions">
        <button class="link" type="button" data-act="csv">Copy groups (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <div class="tbl-scroll short"><table class="dtable g-table"></table></div>
      <section class="g-card" hidden aria-live="polite"></section>
      <h3 class="data-h g-over-h"></h3>
      <div class="data-tools">
        <label>Measure <select class="g-of"><option value="pop">people</option><option value="count">places</option><option value="gdp">product</option><option value="energy">energy</option><option value="military">military</option></select></label>
        <label>every <select class="g-stride"><option value="20" selected>20th step (instant)</option><option value="4">4th step</option><option value="1">step</option></select></label>
        <button class="link" type="button" data-act="ocsv" disabled>Copy shares over time (CSV)</button>
        <span class="muted g-note"></span>
      </div>
      <canvas class="data-chart g-stack" aria-label="Shares of the biggest groups over time"></canvas>
      <p class="g-legend"></p>`;
    this.$<HTMLSelectElement>('.g-by').addEventListener('change', (e) => { this.by = (e.target as HTMLSelectElement).value as GroupBy; this.focus = null; this.refresh(); });
    this.$<HTMLInputElement>('.g-filter').addEventListener('change', () => this.refresh());
    for (const s of ['.g-of', '.g-stride']) this.$(s).addEventListener('change', () => this.refresh());
    this.el.addEventListener('click', (e) => this.onClick(e));
    new ResizeObserver(() => this.drawOver()).observe(this.$('.g-stack'));
  }

  private name(k: number, by = this.by): string {
    const { bodies: B, systems: Sy } = this.host.world;
    if (by === 'faction') return B[k]?.name ?? `#${k}`;
    if (by === 'culture') return this.faithNames.get(k) ?? `faith #${k}`;
    if (by === 'system') return Sy[k]?.name ?? `#${k}`;
    return STAGE_NAMES[k] ?? `#${k}`;
  }

  refresh(): void {
    const sim = this.host.sim;
    if (sim.done && this.faithSeed !== sim.seed) {
      this.faithSeed = sim.seed;
      const seed = sim.seed;
      sim.data<'faiths'>({ type: 'faiths' }).then((m) => {
        if (seed !== sim.seed) return;
        if (m.pending) { this.faithSeed = -1; return; }
        this.faithNames = new Map(m.faiths.map((f) => [f.n, f.name]));
        this.render();
      });
    }
    const t = this.desk.table();
    if (t) this.aggregate(t);
    this.render();
    this.fetchOver();
  }

  // ------------------------------------------------------------ now

  private aggregate(t: TableMsg): void {
    const q = this.desk.query.trim(), useQ = !!q && this.$<HTMLInputElement>('.g-filter').checked;
    this.$('.g-filter-wrap').hidden = !q;
    this.$('.g-q').textContent = q;
    const c = useQ ? tryCompile<PlaceRow>(q, placeBinder(this.host.world)) : null;
    const test = c && !(c instanceof Error) ? c.test : null;
    const B = this.host.world.bodies, R = t.rows;
    const by = new Map<number, Agg>();
    const row: PlaceRow = { S: R, b: 0, o: 0, year: t.year };
    let total = 0;
    for (let i = 0; i < t.bodies.length; i++) {
      const b = t.bodies[i], o = i * NF;
      if (test) { row.b = b; row.o = o; if (!test(row)) continue; }
      const k = groupKey(this.by, R, o, B[b].system);
      let a = by.get(k);
      if (!a) by.set(k, (a = { key: k, places: 0, pop: 0, gdp: 0, energy: 0, research: 0, military: 0, capital: 0, stab: 0, happy: 0, systems: new Set(), faiths: new Map(), factions: new Map(), members: [], oldest: Infinity }));
      const p = R[o + F.pop];
      a.places++; a.pop += p; total += p;
      a.gdp += R[o + F.gdp]; a.energy += R[o + F.energy]; a.research += R[o + F.research]; a.military += R[o + F.military]; a.capital += R[o + F.capital];
      a.stab += R[o + F.stability] * p; a.happy += R[o + F.happiness] * p;
      a.systems.add(B[b].system);
      a.faiths.set(R[o + F.culture], (a.faiths.get(R[o + F.culture]) ?? 0) + p);
      a.factions.set(R[o + F.faction], (a.factions.get(R[o + F.faction]) ?? 0) + p);
      a.members.push(i);
      a.oldest = Math.min(a.oldest, R[o + F.founded]);
    }
    for (const a of by.values()) { a.stab /= a.pop || 1; a.happy /= a.pop || 1; a.members.sort((x, y) => R[y * NF + F.pop] - R[x * NF + F.pop]); }
    this.aggs = [...by.values()];
    this.total = total;
    this.year = t.year;
  }

  private val(a: Agg, k: string): number | string {
    if (k === 'name') return this.name(a.key);
    if (k === 'share') return a.pop / (this.total || 1);
    if (k === 'nsys') return a.systems.size;
    return a[k as keyof Agg] as number;
  }

  private sorted(): Agg[] {
    const k = this.sortKey, d = this.sortDir;
    return [...this.aggs].sort((a, b) => {
      const x = this.val(a, k), y = this.val(b, k);
      return (typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number)) * d || a.key - b.key;
    });
  }

  private render(): void {
    const [one, many] = BY_LABEL[this.by];
    this.$('.g-count').textContent = this.aggs.length ? `${this.aggs.length.toLocaleString('en-US')} ${this.aggs.length === 1 ? one : many} in ${fmtYear(this.year)}` : '';
    const rows = this.sorted().slice(0, 300);
    const head = `<thead><tr>${COLS.map((c) => `<th scope="col" title="${esc(c.title)}" class="${c.key === 'name' ? 'txt' : ''}"><button type="button" data-sort="${c.key}" class="${c.key === this.sortKey ? 'on' : ''}">${c.key === 'name' ? one : c.head}${c.key === this.sortKey ? (this.sortDir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>`;
    const body = rows.map((a) => `<tr data-g="${a.key}"${a.key === this.focus ? ' class="sel"' : ''}>${COLS.map((c, i) => {
      const v = this.val(a, c.key);
      if (i === 0) return `<th scope="row"><button class="link" type="button">${esc(String(v))}</button></th>`;
      return `<td class="num">${c.key === 'share' ? `${((v as number) * 100).toFixed((v as number) < 0.01 ? 2 : 1)}%` : c.key === 'stab' || c.key === 'happy' ? (v as number).toFixed(2) : cell(v as number)}</td>`;
    }).join('')}</tr>`).join('');
    this.$('.g-table').innerHTML = head + `<tbody>${body}</tbody>`;
    this.renderCard();
    this.$('.g-over-h').textContent = `Share held by the biggest ${many} over time`;
  }

  /** The inspector card for one group: who leads it, how far it reaches, what it believes, who is in it. */
  private renderCard(): void {
    const card = this.$('.g-card');
    const a = this.focus === null ? undefined : this.aggs.find((x) => x.key === this.focus);
    card.hidden = this.focus === null;
    if (this.focus === null) return;
    const { bodies: B, systems: Sy } = this.host.world;
    const t = this.desk.table();
    const title = this.by === 'faction' ? `The faction of ${esc(this.name(this.focus))}` : this.by === 'culture' ? esc(this.name(this.focus)) : this.by === 'system' ? `The ${esc(this.name(this.focus))} system` : `Every ${esc(this.name(this.focus))}`;
    if (!a || !t) {
      card.innerHTML = `<h3 class="data-h">${title} <button class="link" type="button" data-act="unfocus">Close</button></h3><p class="muted">Not present in ${fmtYear(this.year)}.</p><canvas class="data-chart g-line"></canvas>`;
      this.drawFocus();
      return;
    }
    const top = (m: Map<number, number>, by: GroupBy) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, p]) => `${esc(this.name(k, by))} ${Math.round((p / (a.pop || 1)) * 100)}%`).join(', ');
    const kv: [string, string][] = [];
    if (this.by === 'faction') {
      const cap = this.focus, capRow = t.bodies.indexOf(cap);
      kv.push(['Capital', `<button class="link" type="button" data-b="${cap}">${esc(B[cap]?.name ?? '?')}</button>${B[cap] ? `, ${esc(Sy[B[cap].system].name)}` : ''}${capRow < 0 ? ' (not living)' : ''}`]);
      if (capRow >= 0) kv.push(['Capital founded', fmtYear(t.rows[capRow * NF + F.founded])]);
    }
    kv.push(['Places', a.places.toLocaleString('en-US')], ['People', `${fmtNum(a.pop)} (${((a.pop / (this.total || 1)) * 100).toFixed(2)}% of those shown)`],
      ['Product', `$${fmtNum(a.gdp)}/yr · $${fmtNum(a.gdp / (a.pop || 1))} per person`], ['Energy', `${fmtNum(a.energy)} W`], ['Military', `$${fmtNum(a.military)}/yr`],
      ['Stability · happiness', `${a.stab.toFixed(2)} · ${a.happy.toFixed(2)}`], ['Oldest member founded', fmtYear(a.oldest)],
      ['Star systems', `${a.systems.size} · farthest ${Math.max(...[...a.systems].map((s) => Sy[s].dist)).toFixed(1)} ly from the Sun`]);
    if (this.by !== 'culture') kv.push(['Faiths', top(a.faiths, 'culture')]);
    if (this.by !== 'faction') kv.push(['Allegiance', top(a.factions, 'faction')]);
    const members = a.members.slice(0, 12).map((i) => {
      const b = t.bodies[i];
      return `<li><button class="link" type="button" data-b="${b}">${esc(B[b].name)}</button> <span class="muted num">${fmtNum(t.rows[i * NF + F.pop])} · ${esc(STAGE_NAMES[t.rows[i * NF + F.stage]] ?? '')}</span></li>`;
    }).join('');
    card.innerHTML = `<h3 class="data-h">${title} <span class="muted">in ${fmtYear(this.year)}</span> <button class="link" type="button" data-act="unfocus">Close</button> <button class="link" type="button" data-act="members">Copy members (CSV)</button> <button class="link" type="button" data-act="mark">Mark members on the map</button></h3>
      <dl class="run-stamp">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <p class="muted">Biggest members${a.members.length > 12 ? ` (12 of ${a.members.length})` : ''}:</p><ul class="g-members">${members}</ul>
      <canvas class="data-chart g-line" aria-label="This group's share over time"></canvas>`;
    this.drawFocus();
  }

  // ------------------------------------------------------------ over time

  private fetchOver(): void {
    const sim = this.host.sim;
    const of = this.$<HTMLSelectElement>('.g-of').value, stride = Number(this.$<HTMLSelectElement>('.g-stride').value);
    const key = `${sim.seed}:${this.by}:${of}:${stride}:${this.focus ?? ''}`;
    const note = this.$('.g-note');
    if (!sim.done) { note.textContent = 'Waiting for the simulation to finish.'; return; }
    if (key === this.overKey || key === this.overBusy) { this.drawOver(); return; }
    this.overBusy = key;
    note.textContent = stride % 20 ? 'Replaying the whole future…' : 'Reading the saved states…';
    const t0 = performance.now();
    sim.data<'groups'>({ type: 'groups', by: this.by, of, stride, top: 8, focus: this.focus ?? undefined }).then((m) => {
      if (this.overBusy !== key) return;
      this.overBusy = '';
      if (m.pending || m.error) { note.textContent = m.error ?? 'Waiting for the simulation to finish.'; return; }
      this.over = m;
      this.overKey = key;
      note.textContent = `${m.steps.length} points in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      this.$<HTMLButtonElement>('[data-act=ocsv]').disabled = false;
      this.drawOver();
      this.drawFocus();
    });
  }

  private drawOver(): void {
    const m = this.over;
    if (this.el.hidden || !m || m.by !== this.by) return;
    const sim = this.host.sim, xs = Array.from(m.steps, (s) => sim.years[s]), K = m.keys.length;
    const top = m.keys.slice(0, 8);
    const layers = top.map((k, j) => ({ label: this.name(k), color: PALETTE[j % PALETTE.length], xs, ys: xs.map((_, i) => m.values[i * K + j] / (m.total[i] || 1)) }));
    // the focused group, when it is not one of the eight, is still counted in "everyone else"
    const rest = xs.map((_, i) => { let s = 0; for (let j = 0; j < top.length; j++) s += m.values[i * K + j]; return (m.total[i] - s) / (m.total[i] || 1); });
    layers.push({ label: 'everyone else', color: OTHER, xs, ys: rest });
    drawStacked(this.$('.g-stack'), xs, layers, { cursor: this.host.year(), x0: 0, x1: 10000 });
    this.$('.g-legend').innerHTML = layers.map((l, j) => `<span class="g-key"><i style="background:${l.color}"></i>${j < top.length ? `<button class="link" type="button" data-g="${top[j]}">${esc(l.label)}</button>` : esc(l.label)}</span>`).join(' ');
  }

  private drawFocus(): void {
    const c = this.el.querySelector<HTMLCanvasElement>('.g-line'), m = this.over;
    if (!c || this.focus === null || !m || m.by !== this.by) return;
    const j = m.keys.indexOf(this.focus);
    if (j < 0) return;
    const sim = this.host.sim, xs = Array.from(m.steps, (s) => sim.years[s]), K = m.keys.length;
    drawLines(c, [{ label: this.name(this.focus), color: PALETTE[j % PALETTE.length], xs, ys: xs.map((_, i) => m.values[i * K + j] / (m.total[i] || 1)) }], { percent: true, cursor: this.host.year(), x0: 0, x1: 10000 });
  }

  // ------------------------------------------------------------ actions

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>('[data-sort]');
    if (sort) {
      const k = sort.dataset.sort!;
      if (k === this.sortKey) this.sortDir = -this.sortDir; else { this.sortKey = k; this.sortDir = k === 'name' ? 1 : -1; }
      this.render();
      return;
    }
    const b = t.closest<HTMLElement>('[data-b]');
    if (b) { this.host.selectBody(Number(b.dataset.b)); return; }
    const g = t.closest<HTMLElement>('[data-g]');
    if (g) { const k = Number(g.dataset.g); this.focus = this.focus === k ? null : k; this.render(); this.fetchOver(); this.$('.g-card').scrollIntoView({ block: 'nearest' }); return; }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const status = this.$('.copy-status');
    if (act === 'unfocus') { this.focus = null; this.host.setHighlight(null); this.render(); }
    else if (act === 'mark') {
      const a = this.aggs.find((x) => x.key === this.focus), tb = this.desk.table();
      if (a && tb) this.host.setHighlight(a.members.map((i) => tb.bodies[i]));
    } else if (act === 'csv') {
      const rows = this.sorted().map((a) => [a.key, this.name(a.key), a.places, a.pop, a.pop / (this.total || 1), a.gdp, a.energy, a.research, a.military, a.capital, a.stab, a.happy, a.systems.size, a.oldest + 2040]);
      void copyText(toCsv([`${this.by}_id`, this.by, 'places', 'pop', 'share', 'gdp', 'energy', 'research', 'military', 'capital', 'stability', 'happiness', 'systems', 'oldest_founded'], rows, `Breakdown by ${BY_LABEL[this.by][0]} in ${fmtYear(this.year)}`), 'Groups as CSV', status);
    } else if (act === 'members') {
      const a = this.aggs.find((x) => x.key === this.focus), tb = this.desk.table();
      if (!a || !tb) return;
      const { bodies: B, systems: Sy } = this.host.world;
      const rows = a.members.map((i) => { const bb = tb.bodies[i]; return [bb, B[bb].name, Sy[B[bb].system].name, ...Array.from(tb.rows.subarray(i * NF, i * NF + NF))]; });
      void copyText(toCsv(['body', 'name', 'system', ...SETTLEMENT_FIELDS], rows, `Members of ${this.name(a.key)} (${BY_LABEL[this.by][0]}) in ${fmtYear(this.year)}`), 'Members as CSV', status);
    } else if (act === 'ocsv' && this.over) {
      const m = this.over, sim = this.host.sim, K = m.keys.length;
      const rows = Array.from(m.steps, (s, i) => [2040 + sim.years[s], m.total[i], m.nGroups[i], ...m.keys.map((_, j) => m.values[i * K + j]), m.other[i]]);
      void copyText(toCsv(['year', 'total', `n_${this.by}`, ...m.keys.map((k) => this.name(k)), 'other'], rows, `${this.$<HTMLSelectElement>('.g-of').value} by ${BY_LABEL[this.by][0]} over time, biggest by peak share`), 'Shares over time as CSV', status);
    }
  }

  hide(): void { this.host.setHighlight(null); }
}
