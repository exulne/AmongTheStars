// Right-hand panel: every number about whatever is selected, at the current year.

import { ERAS, EVENT_NAMES, RES_NAMES, STAGE, STAGE_NAMES, TECHS } from '../sim/catalog.ts';
import type { HistoryMsg, SimEvent, StateMsg } from '../sim/client.ts';
import { F, GLOBAL_METRICS, GM, NF, SETTLEMENT_LABELS, type SField } from '../sim/metrics.ts';
import type { World } from '../sim/world.ts';
import { STAGE_CSS } from '../view/textures.ts';
import { alive, cityCount, citySplit, systemSummary, type Pickable } from '../view/views.ts';
import { fmtNum, fmtUnit, fmtYear, parseCount } from './format.ts';
import { periodOf } from '../sim/ledger.ts';
import { techArrival } from '../sim/diffusion.ts';
import { names } from './names.ts';
import type { Biography, PersonBrief } from '../sim/lives.ts';
import { biographyHtml, residentsHtml } from './peoplePanel.ts';
import { explainHtml, galaxyFactsHtml, starFactsHtml } from '../explain/card.ts';
import { explain } from '../explain/registry.ts';
import type { Annals } from '../sim/chronicle.ts';
import { ageAt, humanityAnnalsHtml, polityAt, polityCardHtml, polityLink } from './annals.ts';

type Residents = { total: number; asOf: number; offset: number; people: PersonBrief[]; pyramid: { band: number; women: number; men: number }[] };
type SocietyView = { polity: { id: number; name: string; regime: string; since: number } | null; government: string; governmentWhy: string; language: string; faith: string | null; art: string; architecture: { name: string; materials: string }; daily: Record<string, string>; mood: string; sentences: string[] };
type Seg = string | { t: string; kind: 'person' | 'body'; id: string | number };
type Entry = { year: number; type: number; segs: Seg[]; weight: number };
export function segsHtml(segs: Seg[]): string {
  return segs.map((x) => typeof x === 'string' ? esc(x)
    : x.kind === 'person' ? `<button class="link" data-act="open-person" data-pid="${x.id}" type="button">${esc(x.t)}</button>`
    : `<button class="link" data-act="body" data-id="${x.id}" type="button">${esc(x.t)}</button>`).join('');
}
export interface PeopleApi {
  chronicle(from: number, to: number, opts: { body?: number; query?: string; limit?: number; minWeight?: number }): Promise<{ entries: Entry[]; pending?: boolean }>;
  inventions(): Promise<{ list: { tech: number; year: number; entry: Entry | null }[]; pending?: boolean }>;
  society(body: number, year: number): Promise<{ society: SocietyView | null; pending?: boolean }>;
  residents(body: number, year: number, offset: number, count: number): Promise<Residents & { pending?: boolean }>;
  person(id: string, year: number): Promise<{ bio: Biography | null; pending?: boolean }>;
  residentAt(body: number, year: number, k: number): Promise<{ person: string | null; pending?: boolean }>;
  annals(): Promise<{ annals: Annals | null; pending?: boolean }>;
}
const PER_PAGE = 12;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface InspectorCtx {
  world: World;
  snap: StateMsg | null;
  year: number;
  globalRow: (col: number) => number;
  forecast?: string;
  selected: Pickable | null;
  body: number;
  events: SimEvent[];
  history: HistoryMsg | null;
}

export class Inspector {
  el: HTMLElement;
  private body: HTMLElement;
  private peoplePage = 0;
  private peopleBody = -1;

  onSelect: (p: Pickable) => void = () => {};
  onDive: (p: Pickable) => void = () => {};
  onClose: () => void = () => {};
  private last: InspectorCtx | null = null;
  private revealPerson = false;
  api: PeopleApi | null = null;
  /** the open person, if any: they stay open as the year changes */
  personId: string | null = null;
  onPerson: (id: string | null) => void = () => {};
  private residentsCache = new Map<string, Residents>();
  private bioCache = new Map<string, Biography | null>();
  private lastBio: Biography | null = null;
  private inflight = new Set<string>();
  /** drop everything cached for the previous future */
  resetPeople(): void { this.socCache.clear(); this.residentsCache.clear(); this.bioCache.clear(); this.chronCache.clear(); this.inv = null; this.ann = null; this.polityOpen = null; this.lastBio = null; this.personId = null; }
  chronicleOpen = false;
  private chronQuery = '';
  private chronBig = true;
  private chronCache = new Map<string, Entry[]>();
  private inv: Map<number, Entry | null> | null = null;
  private socCache = new Map<string, SocietyView | null>();
  private ann: Annals | null = null;
  /** the open polity card, if any */
  polityOpen: number | null = null;

  /** The ages, peoples, wars and faiths of this future (once the run is done). */
  annals(): Annals | null {
    if (!this.ann) this.fetch('annals', () => this.api!.annals(), (v: { annals: Annals | null }) => { this.ann = v.annals; this.onAnnals(this.ann); });
    return this.ann;
  }
  onAnnals: (a: Annals | null) => void = () => {};

  private society(c: InspectorCtx, body: number): string {
    const key = `${body}:${Math.floor(c.year / 4)}`;
    const soc = this.socCache.get(key);
    if (soc === undefined) this.fetch(key, () => this.api!.society(body, c.year), (v: { society: SocietyView | null }) => {
      if (this.socCache.size > 100) this.socCache.clear();
      this.socCache.set(key, v.society);
    });
    if (!soc) return '<p class="muted">Asking around…</p>';
    return `<p class="society-portrait">${soc.sentences.map(esc).join(' ')}</p>
      <dl class="kv">${soc.polity && this.ann?.polities[soc.polity.id] ? `<dt>Ruled by</dt><dd>${polityLink(this.ann, soc.polity.id, true)}</dd>` : ''}<dt>Government</dt><dd>${esc(soc.government)}</dd><dt>Language</dt><dd>${esc(soc.language)}</dd>${soc.faith ? `<dt>Faith</dt><dd>${esc(soc.faith)}</dd>` : ''}<dt>Art</dt><dd>${esc(soc.art)}</dd><dt>Buildings</dt><dd>${esc(soc.architecture.materials)}</dd><dt>Mood</dt><dd>${esc(soc.mood)}</dd></dl>`;
  }
  onYear: (y: number) => void = () => {};

  private inventions(): Map<number, Entry | null> | null {
    if (!this.inv) this.fetch('inventions', () => this.api!.inventions(), (v: { list: { tech: number; entry: Entry | null }[] }) => { this.inv = new Map(v.list.map((x) => [x.tech, x.entry])); });
    return this.inv;
  }

  private chronicle(c: InspectorCtx, body?: number): string {
    const all = body !== undefined;
    const from = all ? -1 : Math.max(-1, c.year - 400), minW = all ? 3 : this.chronBig ? 4 : 0;
    const key = `${body ?? 'all'}:${Math.floor(c.year / 4)}:${this.chronQuery}:${minW}`;
    const list = this.chronCache.get(key);
    if (!list) this.fetch(key, () => this.api!.chronicle(from, c.year, { body, query: this.chronQuery || undefined, limit: all ? 14 : 90, minWeight: minW }), (v: { entries: Entry[] }) => {
      if (this.chronCache.size > 60) this.chronCache.clear();
      this.chronCache.set(key, v.entries);
    });
    const items = list ? list.map((e) => `<li><button class="link num ev-year" data-act="year" data-id="${e.year}" type="button">${fmtYear(e.year)}</button> ${segsHtml(e.segs)}</li>`).join('') : '';
    const head = all ? '' : `<p class="eyebrow muted">Chronicle</p><h2>The last four centuries, to ${fmtYear(c.year)}</h2>
      <p class="muted">Everything here happened in this future, to people who lived in it. Click a name to read their life, a year to go there.</p>
      <div class="chron-tools"><input id="chron-q" type="search" placeholder="Search: a name, a ship, a world" value="${esc(this.chronQuery)}" aria-label="Search the chronicle">
      <label><input id="chron-big" type="checkbox" ${this.chronBig ? 'checked' : ''}> turning points only</label></div>`;
    return `${head}${list ? (items ? `<ol class="events chron">${items}</ol>` : `<p class="muted">${all ? 'Nothing here has made history yet.' : 'Nothing matches.'}</p>`) : '<p class="muted">Reading the record…</p>'}`;
  }

  private fetch<T>(key: string, get: () => Promise<T & { pending?: boolean }>, put: (v: T) => void): void {
    if (this.inflight.has(key) || !this.api) return;
    this.inflight.add(key);
    get().then((v) => {
      this.inflight.delete(key);
      if (v.pending) { setTimeout(() => this.last && this.render(this.last), 600); return; }
      put(v);
      if (this.last) this.render(this.last);
    });
  }

  openPerson(id: string | null): void {
    this.personId = id;
    this.onPerson(id);
    this.toTop();
    if (this.last) this.render(this.last);
  }

  constructor() {
    this.el = document.createElement('aside');
    this.el.className = 'inspector';
    this.el.setAttribute('aria-label', 'Inspector');
    this.body = document.createElement('div');
    this.body.className = 'insp-body';
    this.el.append(this.body);
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!t || !this.last) return;
      const act = t.dataset.act!, id = Number(t.dataset.id);
      if (/^(body|system|dive-body|dive-system|goto-body|close)$/.test(act)) this.polityOpen = null;
      if (act === 'close') this.onClose();
      if (act === 'techs') { this.allTechs = !this.allTechs; this.render(this.last); }
      if (act === 'system') this.onSelect({ kind: 'system', id, name: this.last.world.systems[id].name, pos: null! });
      if (act === 'body') this.onSelect({ kind: 'body', id, name: this.last.world.bodies[id].name, pos: null! });
      if (act === 'dive-body') this.onDive({ kind: 'body', id, name: this.last.world.bodies[id].name, pos: null! });
      if (act === 'dive-city') this.onDive({ kind: 'city', id, name: this.last.selected?.name ?? '', pos: null! });
      if (act === 'dive-system') this.onDive({ kind: 'system', id, name: this.last.world.systems[id].name, pos: null! });
      if (act === 'page') { this.peoplePage = Math.max(0, this.peoplePage + id); this.render(this.last); }
      if (act === 'open-person') this.openPerson(t.dataset.pid!);
      if (act === 'close-person') this.openPerson(null);
      if (act === 'close-chronicle') { this.chronicleOpen = false; this.render(this.last); }
      if (act === 'polity') { this.polityOpen = id; this.personId = null; this.toTop(); this.render(this.last); }
      if (act === 'close-polity') { this.polityOpen = null; this.render(this.last); }
      if (act === 'year') this.onYear(Number(t.dataset.id));
      if (act === 'goto-body') { this.openPerson(null); this.onSelect({ kind: 'body', id, name: this.last.world.bodies[id].name, pos: null! }); }
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'chron-big' && this.last) { this.chronBig = t.checked; this.render(this.last); }
      if (t.id === 'chron-q' && this.last) { this.chronQuery = t.value; this.render(this.last); }
      if (t.id === 'person-jump' && this.last && this.api) {
        const n = Math.max(1, parseCount(t.value) || 1);
        const raw = t.value.trim();
        this.api.residentAt(this.peopleBody, this.last.year, n - 1).then((r) => {
          if (r.person) this.openPerson(r.person);
          else t.setCustomValidity(r.pending ? 'Still simulating; try again in a moment.' : `There is no resident #${raw} here.`), t.reportValidity();
        });
      }
    });
  }

  /** Open resident #n (1-based) of a settlement on the next render. */
  showResident(body: number, n: number): void {
    this.peopleBody = body;
    this.peoplePage = Math.floor((n - 1) / PER_PAGE);
    this.api?.residentAt(body, this.last?.year ?? 0, n - 1).then((r) => { if (r.person) this.openPerson(r.person); });
  }

  toTop(): void { this.el.scrollTop = 0; }

  private allTechs = false;
  private techMark = -1;
  private revealTech = false;
  /** Show the full technology list with one entry marked. */
  showTech(i: number): void { this.allTechs = true; this.techMark = i; this.revealTech = true; }

  render(c: InspectorCtx): void {
    this.last = c;
    const s = c.selected;
    let html = '';
    if (this.personId) html = `<button class="insp-close" type="button" data-act="close-person" aria-label="Close this person">×</button>${this.person(c, this.personId)}`;
    else if (this.chronicleOpen) html = `<button class="insp-close" type="button" data-act="close-chronicle" aria-label="Close the chronicle">×</button>${this.chronicle(c)}`;
    else if (this.polityOpen !== null) {
      const A = this.annals();
      html = `<button class="insp-close" type="button" data-act="close-polity" aria-label="Close this polity">×</button>${A ? polityCardHtml(A, this.polityOpen, c.world, c.year, (b) => names.place(c.world, b)) : '<p class="muted">Reading the record…</p>'}`;
    }
    else if (!s || s.kind === 'humanspace') html = this.global(c);
    else if (s.kind === 'galaxy') html = this.galaxy(c, s);
    else if (s.kind === 'system') html = this.system(c, s.id);
    else if (s.kind === 'body') html = this.bodyView(c, s.id);
    else if (s.kind === 'city') html = this.bodyView(c, c.body, s.id);
    else if (s.kind === 'thing') {
      const e = s.ex ? explain(s.ex, s.id, { world: c.world, snap: c.snap, year: c.year }) : null;
      html = e ? explainHtml(e, segsHtml) : `<h2>${esc(s.name)}</h2><p class="muted">Not drawn in this view.</p>`;
    }
    if (s && !this.personId && !this.chronicleOpen && this.polityOpen === null) html = `<button class="insp-close" type="button" data-act="close" aria-label="Close and show all of humanity">×</button>${html}`;
    const scroll = this.el.scrollTop;
    this.body.innerHTML = html;
    this.el.scrollTop = scroll;
    const mark = this.revealTech ? this.body.querySelector<HTMLElement>('.techs .mark') : null;
    if (mark) { this.revealTech = false; mark.scrollIntoView({ block: 'center' }); }
    const open = this.revealPerson && c.snap ? this.body.querySelector<HTMLElement>('.person.open') : null;
    if (open) { this.revealPerson = false; open.scrollIntoView({ block: 'center' }); }
  }

  private kv(rows: [string, string][]): string {
    return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${v}</dd>`).join('')}</dl>`;
  }

  private eventsList(c: InspectorCtx, max = 14): string {
    if (!c.events.length) return '<p class="muted">Nothing recorded yet.</p>';
    return `<ol class="events">${c.events.slice(0, max).map((e) => {
      const name = EVENT_NAMES[e.type];
      let what = e.body >= 0 ? c.world.bodies[e.body]?.name ?? '' : '';
      if (name === 'Technology') what = TECHS[e.a]?.name ?? '';
      if (name === 'Era change') what = `${ERAS[e.b]} → ${ERAS[e.a]}`;
      if (name === 'Colony founded' && e.b === 1) what += ' (interstellar)';
      if (name === 'Stage up') what += ` → ${STAGE_NAMES[e.a]}`;
      return `<li><span class="num ev-year">${fmtYear(e.year)}</span> <span class="ev-name">${esc(name)}</span> <span class="muted">${esc(what)}</span></li>`;
    }).join('')}</ol>`;
  }

  private global(c: InspectorCtx): string {
    const g = (k: string) => c.globalRow(GM[k]);
    const def = (k: string) => GLOBAL_METRICS[GM[k]];
    const row = (k: string): [string, string] => [def(k).label, fmtUnit(g(k), def(k).unit)];
    const done = c.snap ? TECHS.map((t, i) => ({ t, y: c.snap!.techDone[i] })).filter((x) => x.y >= 0).sort((a, b) => b.y - a.y) : [];
    const A = this.annals(), age = A ? ageAt(A, c.year) : null;
    const next = c.snap ? TECHS.filter((t, i) => c.snap!.techDone[i] < 0 && t.req.every((r) => c.snap!.techDone[TECHS.findIndex((x) => x.id === r)] >= 0)) : [];
    return `
      <h2>Humanity in ${fmtYear(c.year)}</h2>
      <p class="lede">${esc(c.snap?.globals.era ?? '')} era${age ? `, ${esc(age.name)}` : ''}. ${fmtNum(g('pop'))} people in ${fmtNum(g('settlements'))} settlements across ${fmtNum(g('systems'))} star system${g('systems') === 1 ? '' : 's'}.</p>
      ${this.kv(['pop', 'offEarth', 'interstellarPop', 'energy', 'kardashev', 'gdp', 'knowledge', 'research', 'stability', 'factions', 'wars', 'shipsInTransit', 'reach', 'shortage'].map(row))}
      ${c.forecast ? `<h3>Psychohistory forecast</h3>${c.forecast}` : ''}
      <h3>Largest places</h3>${this.largest(c)}
      ${A ? humanityAnnalsHtml(A, c.world, c.year, (b) => names.place(c.world, b)) : ''}
      <h3>Technology <span class="muted num">${done.length} / ${TECHS.length}</span></h3>
      ${this.techList(c, done, next)}
      <h3>Recent events</h3>
      ${this.eventsList(c)}`;
  }

  /** Biggest settlements and star systems right now, clickable. */
  private largest(c: InspectorCtx): string {
    const S = c.snap?.S;
    if (!S) return '';
    const bodies: [number, number][] = [], systems = new Map<number, number>();
    for (const b of c.snap!.settled) {
      if (!alive(S[b * NF + F.stage])) continue;
      const p = S[b * NF + F.pop];
      bodies.push([b, p]);
      const sy = c.world.bodies[b].system;
      systems.set(sy, (systems.get(sy) ?? 0) + p);
    }
    const top = bodies.sort((a, b) => b[1] - a[1]).slice(0, 6);
    const topS = [...systems].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const li = (act: string, id: number, name: string, sub: string, p: number) => `<li><button class="link" data-act="${act}" data-id="${id}" type="button">${esc(name)}</button> <span class="muted">${esc(sub)}</span><span class="num">${fmtNum(p)}</span></li>`;
    return `<ol class="largest">${top.map(([b, p]) => li('body', b, c.world.bodies[b].name, STAGE_NAMES[S[b * NF + F.stage]], p)).join('')}</ol>
      <ol class="largest">${topS.map(([sy, p]) => li('system', sy, c.world.systems[sy].name, 'system', p)).join('')}</ol>`;
  }

  private techList(c: InspectorCtx, done: { t: (typeof TECHS)[number]; y: number }[], next: (typeof TECHS)[number][]): string {
    if (!c.snap) return '';
    if (!this.allTechs) {
      const inv = this.inventions();
      const by = (i: number) => { const e = inv?.get(i); return e ? `<span class="blurb">${segsHtml(e.segs.slice(0, 3))}</span>` : ''; };
      return `<ul class="techs">${done.slice(0, 8).map((x) => `<li><span class="num">${fmtYear(x.y)}</span> ${esc(x.t.name)}${by(TECHS.indexOf(x.t))}</li>`).join('')}</ul>
        ${next.length ? `<p class="muted">Researching: ${next.map((t) => esc(t.name)).join(', ')}</p>` : ''}
        <p><button class="link" data-act="techs" type="button">All ${TECHS.length} technologies</button></p>`;
    }
    // every tech: invented ones in order, then those still to come
    const rows = TECHS.map((t, i) => ({ t, i, y: c.snap!.techDone[i] })).sort((a, b) => (a.y < 0 ? 1e9 : a.y) - (b.y < 0 ? 1e9 : b.y) || a.t.cost - b.t.cost);
    const inv = this.inventions();
    return `<ul class="techs all">${rows.map((r) => {
      const e = r.y >= 0 ? inv?.get(r.i) : null;
      return `<li class="${r.y < 0 ? 'future' : ''}${r.i === this.techMark ? ' mark' : ''}"><span class="num">${r.y >= 0 ? fmtYear(r.y) : next.includes(r.t) ? 'now' : '—'}</span> ${esc(r.t.name)}<span class="blurb">${e ? segsHtml(e.segs.slice(0, 3)) + '. ' : ''}${esc(r.t.blurb)}</span></li>`;
    }).join('')}</ul>
      <p><button class="link" data-act="techs" type="button">Fewer</button></p>`;
  }

  private galaxy(c: InspectorCtx, s: Pickable): string {
    let n = 0, pop = 0;
    if (c.snap) for (const b of c.snap.settled) {
      const st = c.snap.S[b * NF + F.stage];
      if (alive(st) && c.world.systems[c.world.bodies[b].system].galaxy === s.name) { n++; pop += c.snap.S[b * NF + F.pop]; }
    }
    return `<h2>${esc(s.name)}</h2>${this.kv([['Settlements', fmtNum(n)], ['Population', fmtNum(pop)]])}
      <p class="muted">${n ? 'Humans live here.' : s.name === 'Milky Way' ? '' : 'No human has arrived. Reaching another galaxy needs traversable wormholes, which most futures never get.'}</p>
      ${s.name === 'Milky Way' ? '<p><button class="link" data-act="dive-system" data-id="0" type="button">Go to the Sun</button></p>' : ''}
      <h3>The galaxy</h3>${galaxyFactsHtml(s.name)}`;
  }

  private system(c: InspectorCtx, id: number): string {
    const sys = c.world.systems[id];
    const sum = systemSummary(c.world, c.snap, id);
    const rows = sys.bodies.map((b) => {
      const body = c.world.bodies[b];
      const st = c.snap ? c.snap.S[b * NF + F.stage] : -1;
      const pop = c.snap ? c.snap.S[b * NF + F.pop] : 0;
      return `<tr><td><button class="link" data-act="body" data-id="${b}" type="button">${esc(body.name)}</button></td><td class="muted">${body.kind}</td><td>${st >= 0 ? `<span class="pill" style="--c:${STAGE_CSS[st]}">${STAGE_NAMES[st]}</span>` : ''}</td><td class="num">${alive(st) ? fmtNum(pop) : ''}</td></tr>`;
    }).join('');
    return `
      <h2>${esc(sys.name)}</h2>
      <p class="lede">${sys.spec}-type star, ${sys.dist < 0.01 ? 'home' : `${sys.dist.toFixed(1)} light years from the Sun`}. ${sys.real ? 'Real star.' : 'Procedural star.'}</p>
      <p class="act"><button class="link" data-act="dive-system" data-id="${id}" type="button">Enter system</button></p>
      ${this.kv([...(alive(sum.stage) ? [['Most developed', STAGE_NAMES[sum.stage]] as [string, string]] : []), ['People', fmtNum(sum.pop)], ['Settlements', String(sum.n)], ...this.systemTotals(c, id), ['Luminosity', `${sys.lum.toPrecision(2)} L☉`], ['Light delay to Earth', sys.dist < 0.01 ? 'minutes' : `${sys.dist.toFixed(1)} yr`]])}
      <div class="tbl-wrap"><table class="bodies"><tbody>${rows}</tbody></table></div>
      ${starFactsHtml(c.world, id)}`;
  }

  /** Whole-system sums at this year; averages are weighted by head-count. */
  private systemTotals(c: InspectorCtx, id: number): [string, string][] {
    const S = c.snap?.S;
    if (!S) return [];
    const add = { energy: 0, gdp: 0, research: 0, capital: 0, military: 0 }, avg = { stability: 0, happiness: 0 };
    let pop = 0;
    for (const b of c.world.systems[id].bodies) {
      if (!alive(S[b * NF + F.stage])) continue;
      const p = S[b * NF + F.pop];
      pop += p;
      for (const k of Object.keys(add) as (keyof typeof add)[]) add[k] += S[b * NF + F[k]];
      for (const k of Object.keys(avg) as (keyof typeof avg)[]) avg[k] += S[b * NF + F[k]] * p;
    }
    if (!pop) return [];
    return [
      ['Energy use', fmtUnit(add.energy, 'W')], ['Gross product', fmtUnit(add.gdp, '$/yr')], ['Research', fmtUnit(add.research, 'pts/yr')],
      ['Capital', fmtUnit(add.capital, '$')], ['Military', fmtUnit(add.military, '$/yr')],
      ['Stability', (avg.stability / pop).toFixed(2)], ['Happiness', (avg.happiness / pop).toFixed(2)],
    ];
  }

  private bodyView(c: InspectorCtx, id: number, city?: number): string {
    const b = c.world.bodies[id];
    const sys = c.world.systems[b.system];
    const S = c.snap?.S;
    const v = (f: SField) => (S ? S[id * NF + F[f]] : 0);
    const st = S ? v('stage') : -1;
    const pop = v('pop');
    const fly = `<p class="act">${city === undefined ? '' : `<button class="link" data-act="dive-city" data-id="${city}" type="button">Walk its streets</button> · `}<button class="link" data-act="dive-body" data-id="${id}" type="button">Fly to ${esc(b.name)}</button></p>`;
    const own = names.local(id), shown = own ?? b.name; // a world by its own name, the catalogue's underneath
    const header = `<h2>${esc(city === undefined ? shown : city === 0 ? `${shown} capital` : `${shown} settlement ${city}`)}</h2>${own ? `<p class="muted catalogue-id">${esc(b.name)} in the catalogue</p>` : ''}
      <p class="lede">${st >= 0 ? `<span class="pill" style="--c:${STAGE_CSS[st]}">${STAGE_NAMES[st]}</span> ` : ''}${b.kind} world in ${esc(sys.name)}${st >= 0 && v('founded') >= 0 && st !== STAGE.SURVEY ? `, settled ${fmtYear(v('founded'))}` : ''}${v('parent') >= 0 && st > STAGE.SURVEY ? ` from ${esc(c.world.bodies[v('parent')]?.name ?? '')}` : ''}.</p>`;
    const phys = this.kv([
      ['Gravity', `${b.g.toFixed(2)} g`], ['Temperature', `${Math.round(b.temp)} K`], ['Radius', `${fmtNum(b.radius)} km`],
      ['Habitability', b.hab.toFixed(2)], ['Starlight', `${b.flux.toPrecision(2)}× Earth`],
    ]);
    const res = `<div class="bars">${RES_NAMES.map((r, k) => `<div class="bar"><span>${r === 'he3' ? 'helium-3' : r}</span><i style="--v:${b.res[k]}"></i></div>`).join('')}</div>`;
    if (!alive(st)) {
      return `${header}${fly}<h3>History</h3>${this.chronicle(c, id)}<h3>World</h3>${phys}<h3>Resources</h3>${res}<h3>Events here</h3>${this.eventsList(c, 8)}`;
    }
    const factionId = v('faction');
    const faction = factionId === id ? 'Independent' : `Loyal to ${c.world.bodies[factionId] ? names.place(c.world, factionId) : '?'}`;
    const A = this.ann, pol = A ? polityAt(A, factionId, c.year) : null;
    const allegiance = pol && A ? polityLink(A, pol.id, true) + (factionId === id ? ' <span class="muted">(its capital)</span>' : '') : esc(faction);
    const metrics = (Object.keys(SETTLEMENT_LABELS) as SField[]).map((f) => {
      const [label, unit] = SETTLEMENT_LABELS[f]!;
      return [label, fmtUnit(v(f), unit)] as [string, string];
    });
    const split = city === undefined ? { count: Math.floor(pop), offset: 0 } : citySplit(pop, cityCount(st, pop), city);
    const cityPop = split.count, offset = split.offset;
    return `${header}${fly}
      ${this.kv([...(city === undefined ? [] : [['People in this settlement', fmtNum(cityPop)] as [string, string]]), [city === undefined ? 'Population' : 'Whole world', fmtNum(pop)], ['Allegiance', allegiance], ['Faith', esc(names.faith(v('culture')))]])}
      ${this.historyChart(c)}
      <h3>Society in ${fmtYear(c.year)}</h3>${this.society(c, id)}
      ${this.news(c, id)}
      <h3>Residents</h3>${this.people(c, id, cityPop, offset)}
      <h3>All metrics</h3>${this.kv(metrics)}
      <h3>World</h3>${phys}
      <h3>Resources</h3>${res}
      <h3>History</h3>${this.chronicle(c, id)}
      <h3>Events here</h3>${this.eventsList(c, 10)}`;
  }

  /** Inventions already made elsewhere whose news is still crossing space toward this place. */
  private news(c: InspectorCtx, b: number): string {
    const snap = c.snap;
    if (!snap?.techWhere) return '';
    const rows = TECHS.map((t, i) => ({ t, i, at: techArrival(c.world, snap.techDone, snap.techWhere, i, b) }))
      .filter((r) => r.at > c.year && snap.techDone[r.i] <= c.year).sort((a, z) => a.at - z.at);
    if (!rows.length) return '';
    return `<h3>News on its way</h3><p class="muted">Invented elsewhere, but word travels at the speed of light. Until it arrives, nobody here can build with it.</p>
      <ul class="techs">${rows.slice(0, 8).map((r) => {
        const from = snap.techWhere[r.i];
        return `<li><span class="num">${fmtYear(r.at)}</span> ${esc(r.t.name)}<span class="blurb">invented ${fmtYear(snap.techDone[r.i])}${from >= 0 ? ` on <button class="link" data-act="body" data-id="${from}" type="button">${esc(names.place(c.world, from))}</button>, ${Math.round(r.at - snap.techDone[r.i])} light years away` : ''}</span></li>`;
      }).join('')}</ul>${rows.length > 8 ? `<p class="muted">and ${rows.length - 8} more</p>` : ''}`;
  }

  private historyChart(c: InspectorCtx): string {
    const h = c.history;
    if (!h || h.steps.length < 2) return '';
    const pops = h.cols.pop;
    const max = Math.max(...pops.map((p) => Math.log10(1 + p)));
    const pts = pops.map((p, i) => `${((i / (pops.length - 1)) * 100).toFixed(2)},${(30 - (Math.log10(1 + p) / (max || 1)) * 28).toFixed(2)}`).join(' ');
    return `<figure class="spark"><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Population history"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="0.8" vector-effect="non-scaling-stroke"/></svg><figcaption class="muted">Population over its whole history, log scale</figcaption></figure>`;
  }

  private people(c: InspectorCtx, body: number, count: number, offset: number): string {
    if (this.peopleBody !== body) { this.peopleBody = body; this.peoplePage = 0; }
    if (count < 1) return '<p class="muted">Robots only.</p>';
    const pages = Math.max(1, Math.ceil(count / PER_PAGE));
    const page = Math.min(this.peoplePage, pages - 1);
    const key = `${body}:${periodOf(c.year)}:${offset + page * PER_PAGE}`;
    const r = this.residentsCache.get(key) ?? null;
    if (!r) this.fetch(key, () => this.api!.residents(body, c.year, offset + page * PER_PAGE, Math.min(PER_PAGE, count - page * PER_PAGE)), (v) => {
      if (this.residentsCache.size > 200) this.residentsCache.clear();
      this.residentsCache.set(key, v);
    });
    return residentsHtml(r, page, pages, c.year);
  }

  private person(c: InspectorCtx, id: string): string {
    const key = `${id}@${Math.floor(c.year)}`;
    const b = this.bioCache.get(key);
    if (b === undefined) this.fetch(key, () => this.api!.person(id, c.year).then((m) => ({ ...m, v: m.bio })), (m: { v: Biography | null }) => {
      if (this.bioCache.size > 300) this.bioCache.clear();
      this.bioCache.set(key, m.v);
      this.lastBio = m.v;
    });
    const show = b === undefined ? (this.lastBio?.id === id ? this.lastBio : null) : b;
    return biographyHtml(show, c.year, b === undefined);
  }
}
