// The assistant's tools: what it can look up in this future and what it can do
// in the app. Every answer it gives about the simulation comes from one of
// these, so the results are compact, already formatted, and in calendar years.
// The same definitions serve the Realtime voice session and the text fallback.

import { ERAS, EVENT_NAMES, STAGE_NAMES, TECHS, isAlive } from '../sim/catalog.ts';
import type { SimClient, StateMsg } from '../sim/client.ts';
import type { Seg } from '../sim/chronicle.ts';
import { F, GLOBAL_METRICS, GM, NF, NGM, SETTLEMENT_FIELDS, SETTLEMENT_LABELS } from '../sim/metrics.ts';
import { placeBinder, tryCompile, type PlaceRow } from '../sim/query.ts';
import type { World } from '../sim/world.ts';
import { climateHtml } from '../ui/climate.ts';
import { fmtNum, fmtUnit } from '../ui/format.ts';
import type { Hit } from '../ui/search.ts';
import type { Level } from '../view/views.ts';

/** What the assistant needs from the app (main.ts builds it). Years here are sim years (after 2040). */
export interface AssistantHost {
  world: World;
  sim: SimClient;
  year(): number;
  snap(): StateMsg | null;
  level(): Level;
  /** what is selected, in words ("Titan (moon in Sol)"), or "" */
  selection(): string;
  /** the inspector's current card as plain text */
  card(): string;
  /** the timeline's line: era and named age */
  eraLine(): string;
  boarded(): boolean;
  find(q: string): Hit[];
  place(b: number): string;
  // actions
  goto(h: Hit): void;
  openPerson(pid: string): void;
  setYear(simYear: number): Promise<number>;
  setLevel(l: Level): boolean;
  openData(tab: string): boolean;
  openChronicle(): void;
  starship(action: 'board' | 'leave' | 'cockpit' | 'chase'): void;
}

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const YEAR = num('Calendar year, 2040 to 12040. Omit for the year on screen.');

const DATA_TABS = ['places', 'charts', 'groups', 'history', 'time', 'econ', 'orbits', 'impact', 'run'];
const ZOOMS: Level[] = ['multiverse', 'universe', 'galaxy', 'local', 'system', 'planet', 'street'];

export const TOOLS: ToolDef[] = [
  { name: 'get_context', description: 'What is on screen now: year, era and age, zoom level, selection, and the text of the open inspector card. Call when the user says "this", "here", "what am I looking at".', parameters: obj({}) },
  { name: 'global_metrics', description: 'Humanity-wide numbers at a year: population, off-Earth population, settlements, star systems, energy, Kardashev, product, technologies, wars, factions, faiths, stability, era, Earth climate. Pass keys for others (e.g. "launches", "costPerKg", "impactDeaths").', parameters: obj({ year: YEAR, keys: { type: 'array', items: { type: 'string' }, description: 'Optional metric keys' } }) },
  { name: 'find', description: 'Search this future for places (stars, worlds, moons, galaxies), technologies, or named people (from the Chronicle). Returns names and ids.', parameters: obj({ query: str('Name or part of a name'), kind: { type: 'string', enum: ['any', 'place', 'person', 'tech'] } }, ['query']) },
  { name: 'place', description: "A world's or moon's state at a year: stage, population, founded, who it answers to and its polity, government, faith, economy, stability, life expectancy, recent events.", parameters: obj({ name: str('World name, e.g. "Mars", "Titan", "Proxima b"'), year: YEAR }, ['name']) },
  { name: 'place_history', description: "One measure of a world over its whole history (sampled). Measures: pop, energy, gdp, stability, research, water, metals, happiness, tempAnom.", parameters: obj({ name: str('World name'), measure: str('Measure key, default pop') }, ['name']) },
  { name: 'residents', description: 'A few residents of a world at a year (names, ages, jobs, person ids) and the total count.', parameters: obj({ name: str('World name'), year: YEAR, count: num('How many, max 8') }, ['name']) },
  { name: 'person', description: "A person's life story by person id (from find or residents): birth, family, where they lived, how they died.", parameters: obj({ id: str('Person id'), year: YEAR }, ['id']) },
  { name: 'chronicle', description: "The Chronicle: this future's major events in a span of calendar years, newest first, optionally about one world or matching text.", parameters: obj({ from: num('First calendar year'), to: num('Last calendar year'), place: str('Optional world name'), query: str('Optional text to match'), limit: num('Max entries, default 8') }, ['from', 'to']) },
  { name: 'annals', description: 'The named history of this future up to a year: polities (who rules where, regimes), wars (who fought, cause, outcome, deaths, with counts), faiths, named ages, natural upheavals.', parameters: obj({ section: { type: 'string', enum: ['summary', 'polities', 'wars', 'faiths', 'ages', 'nature'] }, year: YEAR, query: str('Optional name filter') }, ['section']) },
  { name: 'society', description: "A world's society: government and why, polity, language, faiths, art, architecture, daily life, mood.", parameters: obj({ name: str('World name'), year: YEAR }, ['name']) },
  { name: 'climate', description: "A world's climate and geology now: temperature, sea level, ice, air pressure, haze, dust, volcanism, terraforming, sky clocks, recent upheavals.", parameters: obj({ name: str('World name'), year: YEAR }, ['name']) },
  { name: 'launch_economics', description: 'Transport and launch economics at a year: spending and its parts, launches, tanker flights, payload, people moved, cost per kg to orbit and overall, satellites.', parameters: obj({ year: YEAR }) },
  { name: 'technologies', description: 'Technologies invented by a year (with the year each was invented) and the next ones not yet invented.', parameters: obj({ year: YEAR }) },
  { name: 'data_query', description: 'Filter and rank every living settlement at a year with the data desk query language, e.g. where "pop > 1M && stability < 0.4", sort "pop". Fields: ' + SETTLEMENT_FIELDS.join(' ') + ' name system allegiance stageName kind dist hab g temp age independent.', parameters: obj({ where: str('Filter expression, or "" for all'), sort: str('Field or expression to sort by, descending'), year: YEAR, limit: num('Max rows, default 8') }, ['where']) },
  { name: 'data_scan', description: 'A settlement query over the whole run: count/sum/mean/min/max of a field across the settlements matching an expression, sampled through time. e.g. expr "kind == \\"ocean\\"", agg "count".', parameters: obj({ expr: str('Filter expression'), agg: { type: 'string', enum: ['count', 'sum', 'mean', 'min', 'max'] }, of: str('Field to aggregate (not for count)') }, ['expr', 'agg']) },
  { name: 'way_of_war', description: 'How this future fights around a year: wars, deaths and outcomes in the last 500 years against the 500 before, and which trained war-mind generation is in charge.', parameters: obj({ year: YEAR }) },
  { name: 'go_to', description: 'Fly the view to a place (star, world, moon, galaxy), a technology, "resident 12 of Titan", or a person by id. Optionally also set the year.', parameters: obj({ name: str('Place name, "resident N of World", or a person id'), year: YEAR }, ['name']) },
  { name: 'set_year', description: 'Move the time slider to a calendar year (a chrono trip when aboard the Starship). Returns once the year is loaded.', parameters: obj({ year: num('Calendar year 2040 to 12040') }, ['year']) },
  { name: 'zoom', description: 'Change zoom level: multiverse (every future), universe (Local Group), galaxy, local (nearby stars), system, planet, street (a city).', parameters: obj({ level: { type: 'string', enum: ZOOMS } }, ['level']) },
  { name: 'open_panel', description: 'Open a panel: the Chronicle, or a data desk tab (places, charts, groups, history, time, econ = launch economics, orbits = orbits & missions, impact = impact lab, run).', parameters: obj({ panel: { type: 'string', enum: ['chronicle', ...DATA_TABS] } }, ['panel']) },
  { name: 'starship', description: 'Board or leave the Starship, or switch its camera.', parameters: obj({ action: { type: 'string', enum: ['board', 'leave', 'cockpit', 'chase'] } }, ['action']) },
  { name: 'end_session', description: 'Disconnect the voice assistant when the user says goodbye or asks you to stop listening.', parameters: obj({}) },
];

// ---------------------------------------------------------------- helpers

const CAL0 = 2040;
const cal = (simYear: number) => Math.round(CAL0 + simYear);
const segText = (segs: Seg[]) => segs.map((s) => (typeof s === 'string' ? s : s.t)).join('');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const metricDef = (k: string) => GLOBAL_METRICS[GM[k]];

class ToolError extends Error {}

/** Wait out a worker reply that says the people of the run aren't ready yet. */
async function settle<T extends { pending?: boolean }>(ask: () => Promise<T>, tries = 16): Promise<T> {
  let r = await ask();
  for (let i = 0; r.pending && i < tries; i++) { await new Promise((ok) => setTimeout(ok, 500)); r = await ask(); }
  if (r.pending) throw new ToolError('The simulation is still running this future; people, the Chronicle and the annals arrive when it finishes. Try again in a few seconds.');
  return r;
}

export class AssistantTools {
  /** called by end_session */
  onEnd: () => void = () => {};
  constructor(private h: AssistantHost) {}

  /** The sim year a tool asked about, clamped to what has been simulated. */
  private simYear(calYear: unknown): number {
    const h = this.h;
    const last = h.sim.done ? 10000 : h.sim.years[h.sim.frontier] ?? 0;
    if (typeof calYear !== 'number' || !isFinite(calYear)) return h.year();
    const y = calYear > 1000 ? calYear - CAL0 : calYear; // tolerate "year 300 after Mars"
    return Math.max(0, Math.min(last, y));
  }

  private bodyId(name: unknown): number {
    const q = String(name ?? '').trim();
    if (!q) throw new ToolError('No world named.');
    const h = this.h;
    const lower = q.toLowerCase();
    // the name its people use counts too
    for (const b of h.world.bodies) if (h.place(b.id).toLowerCase() === lower || b.name.toLowerCase() === lower) return b.id;
    const hit = h.find(q).find((x) => x.kind === 'body');
    if (hit) return hit.id;
    const sys = h.find(q).find((x) => x.kind === 'system');
    if (sys) {
      // a star: its most populous world
      const snap = h.snap();
      const ws = h.world.bodies.filter((b) => b.system === sys.id);
      ws.sort((a, b) => (snap ? snap.S[b.id * NF + F.pop] - snap.S[a.id * NF + F.pop] : 0));
      if (ws.length) return ws[0].id;
    }
    throw new ToolError(`No world called "${q}" in this future. Try find.`);
  }

  private async stateAt(simYear: number): Promise<StateMsg> {
    const h = this.h, snap = h.snap();
    const step = h.sim.stepAt(simYear);
    if (snap && snap.step === step) return snap;
    return h.sim.state(step);
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const f = (this as unknown as Record<string, (a: Record<string, unknown>) => Promise<unknown> | unknown>)[`t_${name}`];
      if (typeof f !== 'function') return { error: `Unknown tool ${name}` };
      return await f.call(this, args ?? {});
    } catch (e) {
      return { error: e instanceof ToolError ? e.message : `Tool failed: ${(e as Error).message}` };
    }
  }

  // ---------------------------------------------------------------- context

  t_get_context(): unknown {
    const h = this.h;
    return {
      year: cal(h.year()), future: h.sim.seed, level: h.level(), era: h.eraLine(), selection: h.selection() || 'nothing (all of humanity)',
      aboardStarship: h.boarded(), simulatedThrough: h.sim.done ? 12040 : cal(h.sim.years[h.sim.frontier] ?? 0),
      card: clip(h.card().replace(/^×\s*/, ''), 1400),
    };
  }

  t_global_metrics(a: Record<string, unknown>): unknown {
    const h = this.h, y = this.simYear(a.year), step = h.sim.stepAt(y);
    if (!h.sim.years.length) throw new ToolError('Nothing simulated yet.');
    const keys = Array.isArray(a.keys) && a.keys.length ? (a.keys as string[]) : ['pop', 'offEarth', 'interstellarPop', 'settlements', 'systems', 'reach', 'energy', 'kardashev', 'gdp', 'gdpPerCap', 'techs', 'wars', 'factions', 'faiths', 'stability', 'happiness', 'lifeExp', 'earthTemp', 'seaLevel'];
    const out: Record<string, string> = {};
    const unknown: string[] = [];
    for (const k of keys) {
      const d = metricDef(k);
      if (!d) { unknown.push(k); continue; }
      const v = h.sim.series[step * NGM + GM[k]];
      out[d.label] = fmtUnit(v, d.unit);
    }
    const era = ERAS[h.sim.series[step * NGM + GM.era]] ?? '';
    return { year: cal(h.sim.years[step]), era, metrics: out, ...(unknown.length ? { unknownKeys: unknown, validKeys: GLOBAL_METRICS.map((m) => m.key).join(' ') } : {}) };
  }

  async t_find(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, q = String(a.query ?? '').trim(), kind = String(a.kind ?? 'any');
    if (!q) throw new ToolError('Empty query.');
    const out: unknown[] = [];
    if (kind !== 'person') {
      for (const x of h.find(q)) {
        if (x.kind === 'note') continue;
        if (kind === 'tech' && x.kind !== 'tech') continue;
        if (kind === 'place' && x.kind === 'tech') continue;
        out.push({ kind: x.kind === 'body' ? 'world' : x.kind, name: x.kind === 'body' ? h.place(x.id) : x.name, ...(x.kind === 'body' && h.place(x.id) !== x.name ? { catalogue: x.name } : {}), about: x.sub });
      }
    }
    if (kind === 'person' || kind === 'any') {
      // named people live in the Chronicle (captains, founders, prophets, rulers)
      const r = await settle(() => h.sim.chronicle(0, 10000, { query: q, limit: 30 }));
      const seen = new Set<string>();
      const ql = q.toLowerCase();
      for (const en of r.entries) for (const s of en.segs) {
        if (typeof s === 'string' || s.kind !== 'person' || seen.has(String(s.id))) continue;
        if (!s.t.toLowerCase().includes(ql)) continue;
        seen.add(String(s.id));
        out.push({ kind: 'person', name: s.t, id: s.id, mentioned: `${cal(en.year)}: ${clip(segText(en.segs), 140)}` });
        if (seen.size >= 6) break;
      }
    }
    return out.length ? { results: out.slice(0, 10) } : { results: [], note: `Nothing called "${q}" in this future.` };
  }

  // ---------------------------------------------------------------- places

  async t_place(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, b = this.bodyId(a.name), y = this.simYear(a.year);
    const st = await this.stateAt(y), w = h.world, body = w.bodies[b], sys = w.systems[body.system];
    const o = b * NF, S = st.S, stage = S[o + F.stage];
    const base = {
      name: h.place(b), ...(h.place(b) !== body.name ? { catalogue: body.name } : {}),
      kind: body.kind, star: sys.name, distanceLy: sys.dist < 0.01 ? 0 : Number(sys.dist.toPrecision(3)), gravity: `${body.g.toFixed(2)} g`, habitability: body.hab.toFixed(2),
      year: cal(st.globals.year),
    };
    if (!st.settled.includes(b) || stage < 0) return { ...base, settled: false, note: 'Nobody has settled here by this year.' };
    const row = (f: (typeof SETTLEMENT_FIELDS)[number]) => S[o + F[f]];
    const fmt = (f: (typeof SETTLEMENT_FIELDS)[number]) => { const l = SETTLEMENT_LABELS[f]; return l ? fmtUnit(row(f), l[1]) : fmtNum(row(f)); };
    const cap = row('faction');
    const out: Record<string, unknown> = {
      ...base, stage: STAGE_NAMES[stage] ?? String(stage), alive: isAlive(stage),
      founded: cal(row('founded')), population: fmtNum(row('pop')),
      answersTo: cap === b ? 'itself (independent capital)' : h.place(cap) || 'Earth',
      energy: fmt('energy'), product: fmt('gdp'), stability: row('stability').toFixed(2), happiness: row('happiness').toFixed(2),
      lifeExpectancy: `${row('lifeExp').toFixed(0)} yr`, medianAge: `${row('medianAge').toFixed(0)} yr`, research: fmt('research'),
      shortage: row('shortage').toFixed(2), terraformed: `${Math.round(row('terraform') * 100)}%`,
    };
    const soc = await h.sim.society(b, st.step);
    if (soc.society) {
      const s = soc.society;
      out.government = s.government;
      if (s.polity) out.polity = `${s.polity.name} (${s.polity.regime}, governed from ${h.place(s.polity.capital)}, since ${cal(s.polity.since)})`;
      out.faith = s.faith ?? 'none dominant';
      out.language = s.language;
      out.mood = s.mood;
    } else if (soc.pending) out.society = 'not ready until the run finishes';
    const evs = await h.sim.events(Math.max(0, st.globals.year - 200), st.globals.year, b, 6);
    if (evs.length) out.recentEvents = evs.slice(0, 6).map((e) => `${cal(e.year)} ${EVENT_NAMES[e.type]}`);
    return out;
  }

  async t_place_history(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, b = this.bodyId(a.name), m = String(a.measure ?? 'pop');
    const r = await h.sim.history(b);
    const col = r.cols[m];
    if (!col) throw new ToolError(`No measure "${m}". Use one of ${Object.keys(r.cols).join(', ')}.`);
    if (!r.steps.length) return { name: h.place(b), note: 'Never settled in this run.' };
    const lab = SETTLEMENT_LABELS[m as (typeof SETTLEMENT_FIELDS)[number]] ?? [m, ''];
    const n = r.steps.length, k = Math.max(1, Math.ceil(n / 14));
    const pts: string[] = [];
    let peak = 0;
    for (let i = 0; i < n; i++) if (col[i] > col[peak]) peak = i;
    for (let i = 0; i < n; i += k) pts.push(`${cal(h.sim.years[r.steps[i]])}: ${fmtUnit(col[i], lab[1])}`);
    if ((n - 1) % k) pts.push(`${cal(h.sim.years[r.steps[n - 1]])}: ${fmtUnit(col[n - 1], lab[1])}`);
    return { name: h.place(b), measure: lab[0], points: pts, peak: `${fmtUnit(col[peak], lab[1])} in ${cal(h.sim.years[r.steps[peak]])}` };
  }

  async t_residents(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, b = this.bodyId(a.name), y = this.simYear(a.year);
    const n = Math.max(1, Math.min(8, Number(a.count) || 5));
    const r = await settle(() => h.sim.residents(b, y, 0, n));
    if (!r.total) return { name: h.place(b), year: cal(y), total: 0, note: 'Nobody lives there in that year.' };
    return { name: h.place(b), year: cal(y), total: fmtNum(r.total), people: r.people.map((p) => ({ id: p.id, name: p.name, sex: p.sex, age: Math.floor(p.age), job: p.job, born: cal(p.born) })) };
  }

  async t_person(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, id = String(a.id ?? '').trim(), y = this.simYear(a.year);
    if (!id) throw new ToolError('No person id. Use find or residents first.');
    const r = await settle(() => h.sim.person(id, y));
    const p = r.bio;
    if (!p) throw new ToolError(`No person with id ${id}.`);
    const brief = (q: { name: string; id: string } | null) => (q ? `${q.name} (${q.id})` : null);
    return {
      id: p.id, name: p.name, sex: p.sex, status: p.status, born: `${cal(p.born)} on ${p.bornAtName}`, job: p.job, faith: p.faith ?? undefined,
      livesAt: p.where?.name, died: p.died ? `${p.died.year > y ? 'will die ' : ''}${cal(p.died.year)} at ${Math.floor(p.died.age)} on ${p.died.place}, ${p.died.cause}` : null,
      mother: brief(p.mother), father: brief(p.father), partners: p.partners.slice(0, 3).map(brief), children: p.children.length,
      descendants: p.descendants.total, story: p.story.slice(0, 10).map((s) => `${cal(s.year)}: ${clip(s.text, 160)}`),
    };
  }

  async t_chronicle(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h;
    const from = this.simYear(a.from), to = this.simYear(a.to ?? cal(h.year()));
    const body = a.place ? this.bodyId(a.place) : undefined;
    const limit = Math.max(1, Math.min(15, Number(a.limit) || 8));
    const r = await settle(() => h.sim.chronicle(Math.min(from, to), Math.max(from, to), { body, query: a.query ? String(a.query) : undefined, limit, minWeight: a.query || body !== undefined ? 0 : 3 }));
    return { from: cal(Math.min(from, to)), to: cal(Math.max(from, to)), entries: r.entries.map((e) => `${cal(e.year)}: ${clip(segText(e.segs), 220)}`) };
  }

  async t_annals(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, y = this.simYear(a.year), sec = String(a.section ?? 'summary');
    const q = a.query ? String(a.query).toLowerCase() : '';
    const r = await settle(() => h.sim.annals());
    const A = r.annals!;
    const match = (n: string) => !q || n.toLowerCase().includes(q);
    const polName = (id: number) => A.polities.find((p) => p.id === id)?.name ?? (id < 0 ? 'Earth' : `polity ${id}`);
    const wars = A.wars.filter((w) => w.start <= y);
    const polities = A.polities.filter((p) => p.founded <= y);
    const standing = polities.filter((p) => p.ended === null || p.ended > y);
    const faiths = A.faiths.filter((f) => f.founded <= y);
    const ageNow = A.ages.find((g) => g.from <= y && g.to > y);
    const head = { year: cal(y) };
    if (sec === 'summary') {
      return {
        ...head, ageNow: ageNow?.name ?? null, warsSoFar: wars.length, warDeathsSoFar: fmtNum(wars.reduce((s, w) => s + w.killed, 0)), warsOngoing: wars.filter((w) => w.end > y || w.outcome === 'ongoing').map((w) => w.name),
        politiesStanding: standing.length, largestPolities: standing.slice().sort((p, q2) => q2.peakPop - p.peakPop).slice(0, 5).map((p) => `${p.name}, governed from ${h.place(p.capital)}`),
        livingFaiths: faiths.filter((f) => f.ended === null || f.ended > y).length, namedAgesSoFar: A.ages.filter((g) => g.from <= y).length,
        totalWarsInWholeRun: A.wars.length,
      };
    }
    if (sec === 'wars') {
      const list = wars.filter((w) => match(w.name)).slice(-10).map((w) => ({
        name: w.name, years: `${cal(w.start)}–${w.end > y ? 'ongoing' : cal(w.end)}`, sides: `${polName(w.polityA)} vs ${polName(w.polityB)}`,
        cause: w.cause, outcome: w.end > y || w.outcome === 'ongoing' ? 'not over yet' : w.outcome,
        winner: w.end > y || w.winner < 0 ? undefined : polName(w.winner === w.a ? w.polityA : w.polityB), killed: fmtNum(w.killed), kinetic: w.kinetic || undefined,
      }));
      return { ...head, warsSoFar: wars.length, warsInWholeRun: A.wars.length, showing: q ? 'matching' : 'latest 10', wars: list };
    }
    if (sec === 'polities') {
      const list = (q ? polities.filter((p) => match(p.name) || match(h.place(p.capital))) : standing).slice(0, 12).map((p) => {
        const reg = p.regimes.filter((g) => g.year <= y).pop()?.regime ?? p.regime;
        return { name: p.name, capital: h.place(p.capital), founded: cal(p.founded), ended: p.ended !== null && p.ended <= y ? cal(p.ended) : undefined, regime: reg, brokeAwayFrom: p.from >= 0 ? polName(p.from) : undefined, grievance: p.grievance || undefined, wars: p.wars, peakPopulation: fmtNum(p.peakPop), peakWorlds: p.peakWorlds };
      });
      return { ...head, standing: standing.length, everFounded: polities.length, polities: list };
    }
    if (sec === 'faiths') {
      return { ...head, faiths: faiths.filter((f) => match(f.name)).slice(0, 12).map((f) => ({ name: f.name, tenets: clip(f.tenets, 160), home: f.home >= 0 ? h.place(f.home) : 'Earth', founded: cal(f.founded), ended: f.ended !== null && f.ended <= y ? cal(f.ended) : undefined, peakWorlds: f.peakWorlds })) };
    }
    if (sec === 'ages') {
      return { ...head, now: ageNow?.name ?? null, ages: A.ages.filter((g) => g.from <= y && match(g.name)).slice(-12).map((g) => `${cal(g.from)}–${g.to > y ? 'now' : cal(g.to)}: ${g.name}`) };
    }
    if (sec === 'nature') return { ...head, upheavals: A.nature.filter((n) => n.year <= y && match(n.text)).slice(-10).map((n) => `${cal(n.year)}: ${clip(n.text, 180)}`) };
    throw new ToolError(`Unknown section ${sec}.`);
  }

  async t_society(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, b = this.bodyId(a.name), y = this.simYear(a.year);
    const r = await settle(() => h.sim.society(b, h.sim.stepAt(y)));
    const s = r.society;
    if (!s) return { name: h.place(b), year: cal(y), note: 'No society there in that year (not settled).' };
    return {
      name: h.place(b), year: cal(y), government: s.government, why: s.governmentWhy,
      polity: s.polity ? `${s.polity.name} (${s.polity.regime}, governed from ${h.place(s.polity.capital)})` : null,
      people: `${Math.round(s.bodies.baseline * 100)}% baseline, ${Math.round(s.bodies.adapted * 100)}% adapted, ${Math.round(s.bodies.uploaded * 100)}% uploaded`,
      language: s.language, faiths: s.faiths.map((f) => `${f.name} ${Math.round(f.share * 100)}%`), art: s.art, architecture: `${s.architecture.name}: ${s.architecture.materials}`,
      daily: s.daily, mood: s.mood, portrait: clip(s.sentences.join(' '), 600),
    };
  }

  async t_climate(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, b = this.bodyId(a.name), y = this.simYear(a.year);
    const st = await this.stateAt(y);
    const events = await h.sim.events(Math.max(0, y - 300), y, b, 30);
    const div = document.createElement('div');
    div.innerHTML = climateHtml({ world: h.world, snap: st, year: y, events, history: null }, b);
    // dt/dd pairs read as "key: value"
    div.querySelectorAll('dt').forEach((dt) => dt.append(': '));
    div.querySelectorAll('dd, p, li, h3, h4').forEach((el) => el.append('\n'));
    div.querySelectorAll('.ex-tag').forEach((el) => { el.textContent = ` [${el.textContent?.trim()}]`; });
    const text = (div.textContent ?? '').replace(/\n\s*\n+/g, '\n').trim();
    return { name: h.place(b), year: cal(y), note: 'Tags: R real data, E estimate from real data, P this future\'s draw.', climate: clip(text, 1600) };
  }

  t_launch_economics(a: Record<string, unknown>): unknown {
    return this.t_global_metrics({ year: a.year, keys: ['transportSpend', 'transportShare', 'propellantSpend', 'hardwareSpend', 'operationsSpend', 'riskSpend', 'infraSpend', 'launches', 'tankerFlights', 'campaigns', 'payloadDispatched', 'peopleTransported', 'costPerKg', 'leoCostPerKg', 'launchCap', 'transportCum', 'orbitSats', 'orbitSpend'] });
  }

  async t_technologies(a: Record<string, unknown>): Promise<unknown> {
    const y = this.simYear(a.year), st = await this.stateAt(y);
    const done = TECHS.map((t, i) => ({ t, y: st.techDone[i] })).filter((x) => x.y >= 0 && x.y <= y).sort((p, q) => p.y - q.y);
    const next = TECHS.filter((_, i) => !(st.techDone[i] >= 0 && st.techDone[i] <= y)).slice(0, 6).map((t) => t.name);
    return { year: cal(y), invented: done.length, of: TECHS.length, latest: done.slice(-12).map((x) => `${cal(x.y)} ${x.t.name}`), notYet: next };
  }

  async t_data_query(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, y = this.simYear(a.year), where = String(a.where ?? '').trim();
    const bind = placeBinder(h.world);
    const test = where ? tryCompile<PlaceRow>(where, bind) : null;
    if (test && 'pos' in test) throw new ToolError(`Query error at ${test.pos}: ${test.message}`);
    const sortSrc = String(a.sort ?? 'pop').trim() || 'pop';
    const sort = tryCompile<PlaceRow>(sortSrc, bind);
    if ('pos' in sort) throw new ToolError(`Sort error at ${sort.pos}: ${sort.message}`);
    const t = await h.sim.table(h.sim.stepAt(y));
    const row: PlaceRow = { S: t.rows, b: 0, o: 0, year: t.year };
    const hits: { b: number; v: number }[] = [];
    for (let i = 0; i < t.bodies.length; i++) {
      row.b = t.bodies[i]; row.o = i * NF;
      if (test && !('pos' in test) && !test.test(row)) continue;
      hits.push({ b: row.b, v: sort.value(row) });
    }
    hits.sort((p, q) => q.v - p.v);
    const limit = Math.max(1, Math.min(15, Number(a.limit) || 8));
    const idx = new Map(Array.from(t.bodies, (b, i) => [b, i]));
    return {
      year: cal(t.year), matched: hits.length, livingSettlements: t.bodies.length,
      rows: hits.slice(0, limit).map((x) => { const o = idx.get(x.b)! * NF; return { name: h.place(x.b), star: h.world.systems[h.world.bodies[x.b].system].name, stage: STAGE_NAMES[t.rows[o + F.stage]], pop: fmtNum(t.rows[o + F.pop]), [sortSrc]: fmtNum(x.v) }; }),
    };
  }

  async t_data_scan(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, agg = String(a.agg ?? 'count') as 'count';
    if (!h.sim.done) throw new ToolError('Scans need the whole run; the simulation is still running.');
    const r = await settle(() => h.sim.scan(String(a.expr ?? ''), agg, String(a.of ?? 'pop'), 20));
    if (r.error) throw new ToolError(r.error);
    const n = r.steps.length, k = Math.max(1, Math.ceil(n / 16)), pts: string[] = [];
    for (let i = 0; i < n; i += k) pts.push(`${cal(h.sim.years[r.steps[i]])}: ${fmtNum(r.values[i])}`);
    if (n && (n - 1) % k) pts.push(`${cal(h.sim.years[r.steps[n - 1]])}: ${fmtNum(r.values[n - 1])}`);
    return { expr: a.expr, agg, of: agg === 'count' ? undefined : a.of, points: pts };
  }

  async t_way_of_war(a: Record<string, unknown>): Promise<unknown> {
    const y = this.simYear(a.year);
    const m = await this.h.sim.wayOfWar(y);
    const w = m.way, span = (s: typeof w.now) => ({ wars: s.wars, kinetic: s.kinetic, killed: fmtNum(s.killed), annexations: s.annex, reparations: s.rep, peace: s.peace });
    return { year: cal(y), warMinds: w.gens ? `trained generation ${w.gen + 1} of ${w.gens}` : 'rule-based', last500Years: span(w.now), the500Before: span(w.before) };
  }

  // ---------------------------------------------------------------- actions

  async t_go_to(a: Record<string, unknown>): Promise<unknown> {
    const h = this.h, name = String(a.name ?? '').trim();
    if (!name) throw new ToolError('Where to?');
    let went = '', body = -1, about = '';
    if (/^\d+[-.]\d/.test(name) && !/\s/.test(name)) {
      // a person id
      const r = await settle(() => h.sim.person(name, h.year()));
      if (!r.bio) throw new ToolError(`No person with id ${name}.`);
      if (r.bio.where) h.goto({ kind: 'body', id: r.bio.where.body, name: r.bio.where.name, sub: '' });
      h.openPerson(name);
      went = `${r.bio.name}'s life is open${r.bio.where ? `, over ${r.bio.where.name}` : ''}`;
    } else {
      const hit = h.find(name).find((x) => x.kind !== 'note') ?? null;
      const note = h.find(name).find((x) => x.kind === 'note');
      if (!hit) throw new ToolError(note ? `${note.name} (${note.sub})` : `Nothing called "${name}" in this future.`);
      h.goto(hit);
      went = hit.kind === 'body' || hit.kind === 'resident' ? h.place(hit.id) : hit.name;
      if (hit.kind === 'body') body = hit.id; else about = hit.sub;
    }
    let year: number | undefined;
    if (typeof a.year === 'number') year = cal(await h.setYear(this.simYear(a.year)));
    // what is there, so the answer needs no second lookup
    if (body >= 0) {
      const p = await this.t_place({ name: h.world.bodies[body].name }) as Record<string, unknown>;
      const keep = ['stage', 'population', 'founded', 'answersTo', 'polity', 'government', 'faith', 'note'];
      return { ok: true, now: went, year: year ?? cal(h.year()), about: Object.fromEntries(keep.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) };
    }
    return { ok: true, now: went, ...(about ? { about } : {}), ...(year ? { year } : {}) };
  }

  async t_set_year(a: Record<string, unknown>): Promise<unknown> {
    const want = Number(a.year);
    if (!isFinite(want)) throw new ToolError('Which year?');
    const y = this.simYear(want);
    const got = await this.h.setYear(y);
    const clamped = Math.abs(cal(got) - want) > 1;
    return { ok: true, year: cal(got), ...(clamped ? { note: `This future's record covers ${CAL0} to ${this.h.sim.done ? 12040 : cal(this.h.sim.years[this.h.sim.frontier])} so far.` } : {}), era: this.h.eraLine() };
  }

  t_zoom(a: Record<string, unknown>): unknown {
    const l = String(a.level) as Level;
    if (!ZOOMS.includes(l)) throw new ToolError(`Zoom levels: ${ZOOMS.join(', ')}.`);
    return this.h.setLevel(l) ? { ok: true, level: l } : { error: 'Could not change level right now.' };
  }

  t_open_panel(a: Record<string, unknown>): unknown {
    const p = String(a.panel);
    if (p === 'chronicle') { this.h.openChronicle(); return { ok: true }; }
    return this.h.openData(p) ? { ok: true, panel: p } : { error: `No panel ${p}.` };
  }

  t_starship(a: Record<string, unknown>): unknown {
    const act = String(a.action) as 'board';
    if (!['board', 'leave', 'cockpit', 'chase'].includes(act)) throw new ToolError('board, leave, cockpit or chase.');
    this.h.starship(act);
    return { ok: true, aboard: this.h.boarded() };
  }

  t_end_session(): unknown { setTimeout(() => this.onEnd(), 2500); return { ok: true, note: 'Say a short goodbye; the line closes in a moment.' }; }
}
