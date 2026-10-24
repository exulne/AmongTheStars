// Right-hand panel: every number about whatever is selected, at the current year.

import { ERAS, EVENT_NAMES, RES_NAMES, STAGE, STAGE_NAMES, TECHS } from '../sim/catalog.ts';
import type { HistoryMsg, SimEvent, StateMsg } from '../sim/client.ts';
import { F, GLOBAL_METRICS, GM, NF, SETTLEMENT_LABELS, type SField } from '../sim/metrics.ts';
import type { World } from '../sim/world.ts';
import { STAGE_CSS } from '../view/textures.ts';
import { alive, systemSummary, type Pickable } from '../view/views.ts';
import { fmtNum, fmtUnit, fmtYear } from './format.ts';
import { personAt } from './people.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface InspectorCtx {
  world: World;
  snap: StateMsg | null;
  year: number;
  globalRow: (col: number) => number;
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
  private openPerson = -1;
  onSelect: (p: Pickable) => void = () => {};
  onDive: (p: Pickable) => void = () => {};
  private last: InspectorCtx | null = null;
  private revealPerson = false;

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
      if (act === 'body') this.onSelect({ kind: 'body', id, name: this.last.world.bodies[id].name, pos: null! });
      if (act === 'dive-body') this.onDive({ kind: 'body', id, name: this.last.world.bodies[id].name, pos: null! });
      if (act === 'dive-system') this.onDive({ kind: 'system', id, name: this.last.world.systems[id].name, pos: null! });
      if (act === 'page') { this.peoplePage = Math.max(0, this.peoplePage + id); this.openPerson = -1; this.render(this.last); }
      if (act === 'person') { this.openPerson = this.openPerson === id ? -1 : id; this.render(this.last); }
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'person-jump' && this.last) {
        const n = Math.max(1, Math.floor(Number(t.value.replace(/[^0-9]/g, '')) || 1));
        this.peoplePage = Math.floor((n - 1) / 12);
        this.openPerson = n - 1;
        this.render(this.last);
      }
    });
  }

  /** Open resident #n (1-based) of a settlement on the next render. */
  showResident(body: number, n: number): void {
    this.peopleBody = body;
    this.peoplePage = Math.floor((n - 1) / 12);
    this.openPerson = n - 1;
    this.revealPerson = true;
  }

  render(c: InspectorCtx): void {
    this.last = c;
    const s = c.selected;
    let html = '';
    if (!s || s.kind === 'humanspace') html = this.global(c);
    else if (s.kind === 'galaxy') html = this.galaxy(c, s);
    else if (s.kind === 'system') html = this.system(c, s.id);
    else if (s.kind === 'body') html = this.bodyView(c, s.id);
    else if (s.kind === 'city') html = this.bodyView(c, c.body, s.id);
    const scroll = this.el.scrollTop;
    this.body.innerHTML = html;
    this.el.scrollTop = scroll;
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
    const next = c.snap ? TECHS.filter((t, i) => c.snap!.techDone[i] < 0 && t.req.every((r) => c.snap!.techDone[TECHS.findIndex((x) => x.id === r)] >= 0)) : [];
    return `
      <h2>Humanity in ${fmtYear(c.year)}</h2>
      <p class="lede">${esc(c.snap?.globals.era ?? '')} era. ${fmtNum(g('pop'))} people in ${fmtNum(g('settlements'))} settlements across ${fmtNum(g('systems'))} star system${g('systems') === 1 ? '' : 's'}.</p>
      ${this.kv(['pop', 'offEarth', 'interstellarPop', 'energy', 'kardashev', 'gdp', 'knowledge', 'research', 'stability', 'factions', 'wars', 'shipsInTransit', 'reach', 'shortage'].map(row))}
      <h3>Technology <span class="muted num">${done.length} / ${TECHS.length}</span></h3>
      <ul class="techs">${done.slice(0, 8).map((x) => `<li><span class="num">${fmtYear(x.y)}</span> ${esc(x.t.name)}</li>`).join('')}</ul>
      ${next.length ? `<p class="muted">Researching: ${next.map((t) => esc(t.name)).join(', ')}</p>` : ''}
      <h3>Recent events</h3>
      ${this.eventsList(c)}`;
  }

  private galaxy(c: InspectorCtx, s: Pickable): string {
    let n = 0, pop = 0;
    if (c.snap) for (const b of c.snap.settled) {
      const st = c.snap.S[b * NF + F.stage];
      if (alive(st) && c.world.systems[c.world.bodies[b].system].galaxy === s.name) { n++; pop += c.snap.S[b * NF + F.pop]; }
    }
    return `<h2>${esc(s.name)}</h2>${this.kv([['Settlements', fmtNum(n)], ['Population', fmtNum(pop)]])}
      <p class="muted">${n ? 'Humans live here.' : s.name === 'Milky Way' ? '' : 'No human has arrived. Reaching another galaxy needs traversable wormholes, which most futures never get.'}</p>
      ${s.name === 'Milky Way' ? '<p><button class="link" data-act="dive-system" data-id="0" type="button">Go to the Sun</button></p>' : ''}`;
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
      ${this.kv([['People', fmtNum(sum.pop)], ['Settlements', String(sum.n)], ['Luminosity', `${sys.lum.toPrecision(2)} L☉`], ['Light delay to Earth', sys.dist < 0.01 ? 'minutes' : `${sys.dist.toFixed(1)} yr`]])}
      <div class="tbl-wrap"><table class="bodies"><tbody>${rows}</tbody></table></div>
      <p><button class="link" data-act="dive-system" data-id="${id}" type="button">Enter system</button></p>`;
  }

  private bodyView(c: InspectorCtx, id: number, city?: number): string {
    const b = c.world.bodies[id];
    const sys = c.world.systems[b.system];
    const S = c.snap?.S;
    const v = (f: SField) => (S ? S[id * NF + F[f]] : 0);
    const st = S ? v('stage') : -1;
    const pop = v('pop');
    const header = `<h2>${esc(city === undefined ? b.name : city === 0 ? `${b.name} capital` : `${b.name} settlement ${city}`)}</h2>
      <p class="lede">${st >= 0 ? `<span class="pill" style="--c:${STAGE_CSS[st]}">${STAGE_NAMES[st]}</span> ` : ''}${b.kind} world in ${esc(sys.name)}${st >= 0 && v('founded') >= 0 && st !== STAGE.SURVEY ? `, settled ${fmtYear(v('founded'))}` : ''}${v('parent') >= 0 && st > STAGE.SURVEY ? ` from ${esc(c.world.bodies[v('parent')]?.name ?? '')}` : ''}.</p>`;
    const phys = this.kv([
      ['Gravity', `${b.g.toFixed(2)} g`], ['Temperature', `${Math.round(b.temp)} K`], ['Radius', `${fmtNum(b.radius)} km`],
      ['Habitability', b.hab.toFixed(2)], ['Starlight', `${b.flux.toPrecision(2)}× Earth`],
    ]);
    const res = `<div class="bars">${RES_NAMES.map((r, k) => `<div class="bar"><span>${r === 'he3' ? 'helium-3' : r}</span><i style="--v:${b.res[k]}"></i></div>`).join('')}</div>`;
    if (!alive(st)) {
      return `${header}<h3>World</h3>${phys}<h3>Resources</h3>${res}<h3>Events here</h3>${this.eventsList(c, 8)}`;
    }
    const factionId = v('faction');
    const faction = factionId === id ? 'Independent' : `Loyal to ${c.world.bodies[factionId]?.name ?? '?'}`;
    const metrics = (Object.keys(SETTLEMENT_LABELS) as SField[]).map((f) => {
      const [label, unit] = SETTLEMENT_LABELS[f]!;
      return [label, fmtUnit(v(f), unit)] as [string, string];
    });
    const share = city === undefined ? 1 : city === 0 ? 0.3 : 0.7 / Math.max(1, 12);
    const cityPop = Math.floor(pop * share);
    const offset = city === undefined || city === 0 ? 0 : Math.floor(pop * 0.3 + (city - 1) * pop * 0.7 / 12);
    return `${header}
      ${this.kv([['Population', fmtNum(pop)], ['Allegiance', esc(faction)], ['Faith', `#${v('culture')}`]])}
      ${this.historyChart(c)}
      <h3>Residents</h3>${this.people(c, id, cityPop, offset)}
      <h3>All metrics</h3>${this.kv(metrics)}
      <h3>World</h3>${phys}
      <h3>Resources</h3>${res}
      <h3>Events here</h3>${this.eventsList(c, 10)}
      <p><button class="link" data-act="dive-body" data-id="${id}" type="button">Fly to ${esc(b.name)}</button></p>`;
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
    if (this.peopleBody !== body) { this.peopleBody = body; this.peoplePage = 0; this.openPerson = -1; }
    if (count < 1) return '<p class="muted">Robots only.</p>';
    const S = c.snap!.S;
    const ctx = { founded: S[body * NF + F.founded], gravity: c.world.bodies[body].g, divergence: S[body * NF + F.divergence], culture: S[body * NF + F.culture], medianAge: S[body * NF + F.medianAge] || 30 };
    const per = 12;
    if (this.revealPerson && this.openPerson >= count) { this.openPerson = count - 1; this.peoplePage = Math.floor(this.openPerson / per); }
    const pages = Math.ceil(count / per);
    const page = Math.min(this.peoplePage, pages - 1);
    const items: string[] = [];
    for (let i = page * per; i < Math.min(count, page * per + per); i++) {
      const p = personAt(body, offset + i, c.year, ctx);
      const open = this.openPerson === i;
      items.push(`<li><button class="person${open ? ' open' : ''}" data-act="person" data-id="${i}" type="button" aria-expanded="${open}">
        <span class="num muted">#${(i + 1).toLocaleString('en-US')}</span> ${esc(p.name)} <span class="muted">${p.age}, ${esc(p.job)}</span></button>
        ${open ? `<div class="bio">${this.kv([['Born', `${p.born}`], ['Generation here', String(p.generation)], ['Height', `${p.height} cm`], ['Health', `${p.health}/100`], ['Years of school', String(p.education)], ['Divergence from Earth genome', `${p.divergence}%`], ['Faith', `#${p.faith}`], ['Mood', p.mood]])}</div>` : ''}
      </li>`);
    }
    return `<p class="muted">${fmtNum(count)} people. Each is generated from the seed when you look.</p>
      <ol class="people">${items.join('')}</ol>
      <div class="pager"><button class="link" data-act="page" data-id="-1" type="button" ${page === 0 ? 'disabled' : ''}>Previous</button>
      <span class="num muted">page ${(page + 1).toLocaleString('en-US')} of ${pages.toLocaleString('en-US')}</span>
      <button class="link" data-act="page" data-id="1" type="button" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></div>
      <label class="jump">Find resident # <input id="person-jump" inputmode="numeric" placeholder="${fmtNum(Math.floor(count / 2))}"></label>`;
  }
}
