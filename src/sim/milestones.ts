// "What leads to…?" — the grammar that turns "colonisation of Mars" into a
// goal, a cheap check that watches a running future for it, and the reading of
// a finished run's event log into the road that got there. Pure: no DOM, no
// timers — it runs the same in the page, in a worker, and in node.

import { Engine, YEAR0, type SimEvent } from './engine.ts';
import { ERAS, EV, STAGE, STAGE_NAMES, TECHS, isAlive } from './catalog.ts';
import { F, GM, NF, NGM } from './metrics.ts';
import { GF, Geo, NGEO } from './geo.ts';
import { GALAXIES, type World } from './world.ts';
import { wordsToNumbers } from '../ship/commands.ts';

export interface Goal {
  id: string;
  label: string;
  detail: string;
  kind: 'stage' | 'terraform' | 'swarm' | 'tech' | 'metric' | 'event' | 'pop';
  body?: number;      // -1 = any body
  system?: number;
  stage?: number;
  level?: 1 | 2 | 3;  // terraforming milestone: air holds / open seas / breathable
  phase?: 1 | 2;      // Dyson swarm phase
  tech?: number;      // TECHS index
  metric?: string;    // GM key
  threshold?: number;
  event?: number;     // EV index
  galaxy?: string;    // a GALAXIES name, or '*' = any galaxy except the Milky Way
}

export type ParseResult = { goal: Goal; notes?: string[] } | { error: string; suggestions: string[] };

export interface Chain { stages: Goal[][] }      // stages in order ("then"); goals within a stage in any order ("and")
export type Joint = 'then' | 'and';
export const chainOf = (g: Goal): Chain => ({ stages: [[g]] });

/** "the first Dyson swarm and a trillion people, and then a breathable Venus" */
export function chainLabel(c: Chain): string {
  return c.stages.map((s) => s.map((g) => g.label).join(' and ')).join(' and then ');
}

/** joints[i] joins goals[i] and goals[i+1]; 'then' starts a new stage. */
export function chainFrom(goals: Goal[], joints: Joint[]): Chain {
  const stages: Goal[][] = [[goals[0]]];
  for (let i = 1; i < goals.length; i++) {
    if (joints[i - 1] === 'then') stages.push([goals[i]]);
    else stages[stages.length - 1].push(goals[i]);
  }
  return { stages };
}

/** The inverse of chainFrom. */
export function chainParts(c: Chain): { goals: Goal[]; joints: Joint[] } {
  const goals: Goal[] = [], joints: Joint[] = [];
  for (const s of c.stages) for (const g of s) {
    if (goals.length) joints.push(g === s[0] ? 'then' : 'and');
    goals.push(g);
  }
  return { goals, joints };
}

const SUGGESTIONS = ['colonisation of Mars', 'terraforming Venus', 'the first Dyson swarm', 'mind uploading'];

const TECH_INDEX = new Map(TECHS.map((t, i) => [t.id, i]));
const TECH_REQ = TECHS.map((t) => t.req.map((r) => TECH_INDEX.get(r)!));

// geo.ts keeps its terraforming thresholds private; these are its TERRA_MILES.
const TERRA_X = [0.25, 0.5, 0.9];
const TERRA_TEXT = ['the air holds', 'open seas spread', 'the air turns breathable'];

const terraOKCache = new WeakMap<World, Uint8Array>();
/** Which worlds can be terraformed at all, read from a spare Geo (the field is private). */
function terraOK(world: World): Uint8Array {
  let t = terraOKCache.get(world);
  if (!t) { t = new Geo(world, 1)['terraOK' as keyof Geo] as unknown as Uint8Array; terraOKCache.set(world, t); }
  return t;
}

// ------------------------------------------------------------------ parsing

interface Place { body?: number; system?: number; words?: string[] }

function normName(s: string): string { return s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim(); }

/** The longest body or system name found in the text; bodies win over their own system ("Tau Ceti e" > "Tau Ceti"). */
function findPlace(t: string, world: World): Place | null {
  let best: Place | null = null, bestLen = 0;
  const test = (name: string, p: Place) => {
    const n = normName(name);
    if (n.length > bestLen && t.includes(` ${n} `)) { best = { ...p, words: n.split(' ') }; bestLen = n.length; }
  };
  for (const b of world.bodies) test(b.name, { body: b.id });
  for (const s of world.systems) test(s.name, { system: s.id });
  if (!best && / (the |our )?(sun|sol|solar system) /.test(t)) best = { system: 0 };
  return best;
}

const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');
const STAGE_DETAIL: Partial<Record<number, string>> = {
  [STAGE.OUTPOST]: 'robots and a rotating crew',
  [STAGE.BASE]: 'a permanent crew, everything imported',
  [STAGE.COLONY]: 'families, local food and water',
  [STAGE.TOWN]: 'a town that grows its own people',
  [STAGE.CITY]: 'a city: tens of millions, local industry',
  [STAGE.HUB]: 'a hub that exports ships and goods',
  [STAGE.MEGA]: 'a megastructure takes shape',
  [STAGE.RING]: 'Bishop rings spun up around it',
  [STAGE.SWARM]: "the system's swarm is mostly its habitats",
  [STAGE.BRAIN]: 'a Matrioshka shell does the thinking',
  [STAGE.LIFTED]: 'the star itself is mined',
  [STAGE.UPLOADED]: 'most of its people live as minds',
};

function stageLabel(world: World, place: Place | null, stage: number): string {
  const s = STAGE_NAMES[stage].toLowerCase();
  if (place?.body !== undefined) {
    const n = world.bodies[place.body].name;
    if (stage === STAGE.COLONY) return `the colonisation of ${n}`;
    if (stage === STAGE.OUTPOST) return `the first landing on ${n}`;
    return `${article(s)} ${s} on ${n}`;
  }
  if (place?.system !== undefined) return `${article(s)} ${s} in the ${world.systems[place.system].name} system`;
  return `the first ${s} anywhere`;
}

function fmtPeople(n: number): string {
  const named: [number, string][] = [[1e12, 'a trillion'], [1e9, 'a billion'], [1e6, 'a million'], [1e3, 'a thousand']];
  for (const [v, w] of named) if (n === v) return w;
  if (n >= 1e12) return `${+(n / 1e12).toPrecision(3)} trillion`;
  if (n >= 1e9) return `${+(n / 1e9).toPrecision(3)} billion`;
  if (n >= 1e6) return `${+(n / 1e6).toPrecision(3)} million`;
  if (n >= 1e3) return `${+(n / 1e3).toPrecision(3)} thousand`;
  return String(Math.round(n));
}

const TECH_ALIAS: [RegExp, string][] = [
  [/\bwarp\b|\balcubierre\b|\bftl\b|faster than light/, 'warp'],
  [/\bwormholes?\b/, 'wormholes'],
  [/\bhe ?3\b|helium ?3|aneutronic/, 'he3Fusion'],
  [/fusion (torch|drive)|torch drive/, 'fusionDrive'],
  [/\bfusion\b/, 'fusion'],
  [/space elevators?/, 'spaceElevator'],
  [/generation ships?/, 'genShip'],
  [/\bagi\b|artificial general intelligence|\bgeneral ai\b|\bai\b/, 'agi'],
  [/mind upload|uploading|\buploads?\b/, 'mindUpload'],
  [/matrioshka/, 'matrioshka'],
  [/star ?lifting|star lifting|lift the star|mine the star/, 'starLifting'],
  [/o ?neill|o'neill|space habitats?|orbital habitats?|rotating habitats?|space colonies/, 'orbitalHabitats'],
  [/antimatter/, 'antimatter'],
  [/nanotech|nanofab|molecular (assembler|nano)|nano ?fabrication/, 'nanofab'],
  [/life extension|immortal|anti ?aging|anti ?ageing|longevity/, 'lifeExt'],
  [/laser sails?|beamed sails?|light sails?/, 'laserSail'],
  [/bishop rings?/, 'bishopRings'],
  [/cloud (city|cities)|aerostat/, 'cloudCities'],
  [/von ?neumann|self.?replicat/, 'vonNeumann'],
  [/cryo|cryosleep|hibernat/, 'cryo'],
  [/quantum (comp|comput)/, 'quantumComp'],
  [/brain.?computer|neural (lace|interface)/, 'neuralLace'],
  [/space ?elevator/, 'spaceElevator'],
  [/asteroid mining|mine asteroids/, 'asteroidMining'],
  [/genetic (medicine|adaptation)|gene therapy/, 'genMed'],
  [/seed ships?|embryo/, 'seedShips'],
  [/ramjet|bussard/, 'bussard'],
  [/terraforming\b/, 'terraform'],
  [/paraterraform/, 'paraterraform'],
  [/magnetic shield/, 'magShield'],
  [/nuclear thermal/, 'ntp'],
  [/synth(etic)? bio|engineered crops/, 'synthBio'],
  [/psychohistory|predictive social/, 'psychohistory'],
  [/laser (comms|network)|interstellar laser/, 'laserComms'],
  [/starshot/, 'starshot'],
  [/sub.?ice/, 'subIce'],
  [/carbon nano|nanotube/, 'carbonNano'],
  [/radiation shield/, 'radShield'],
  [/regolith/, 'regolith'],
  [/robot/, 'robotics'],
  [/in.?situ|isru/, 'isru'],
  [/life support|closed.?loop/, 'closedLoop'],
  [/fission/, 'kilopower'],
  [/reusable|heavy lift/, 'reusable'],
];

const STAGE_WORDS: [RegExp, number][] = [
  [/\bring ?worlds?\b/, STAGE.RING],
  [/\bswarm.?worlds?\b/, STAGE.SWARM],
  [/\bbrain.?stars?\b/, STAGE.BRAIN],
  [/\blifted stars?\b|lifted star\b/, STAGE.LIFTED],
  [/\buploaded\b/, STAGE.UPLOADED],
  [/\bmegastructures?\b/, STAGE.MEGA],
  [/\bcit(y|ies)\b|metropol/, STAGE.CITY],
  [/\btowns?\b/, STAGE.TOWN],
  [/\bhubs?\b/, STAGE.HUB],
  [/\bbases?\b/, STAGE.BASE],
  [/\bsettlements?\b/, STAGE.OUTPOST],
  [/\bcoloni[sz]|\bcolon(y|ies|ists?)\b|\bsettl/, STAGE.COLONY],
  [/\boutposts?\b|\bland(s|ed|ing)? on\b|\breach(es|ed|ing)?\b|\bget(s|ting)? to\b|\b(humans|people) (in|on|at)\b|\bboots on\b|\bfoot( |)print|first (foot|steps?)\b/, STAGE.OUTPOST],
];

const GAL_ANY = /\b(another|a different|other) galax\w*|beyond the milky way|outside the milky way|intergalactic\b/;
const GAL_ALIAS: [RegExp, string][] = [
  [/\bm31\b/, 'Andromeda'], [/\bm33\b/, 'Triangulum'],
  [/\blmc\b/, 'Large Magellanic Cloud'], [/\bsmc\b/, 'Small Magellanic Cloud'],
];

/** "Andromeda" | "the Large Magellanic Cloud" | "another galaxy" */
function galName(gal: string): string {
  return gal === '*' ? 'another galaxy' : /Magellanic/.test(gal) ? `the ${gal}` : gal;
}

/** A galaxy named in the text: a GALAXIES name or alias, or an any-galaxy phrase. */
function findGalaxy(t: string): { gal: string; words: string[] } | null {
  const any = t.match(GAL_ANY);
  if (any) return { gal: '*', words: any[0].trim().split(/\s+/) };
  let best: { gal: string; words: string[] } | null = null, bestLen = 0;
  for (const g of GALAXIES.slice(1)) {
    const n = normName(g.name);
    if (n.length > bestLen && t.includes(` ${n} `)) { best = { gal: g.name, words: n.split(' ') }; bestLen = n.length; }
  }
  for (const [re, gal] of GAL_ALIAS) {
    const w = re.source.replace(/\\b/g, '');
    if (w.length > bestLen && re.test(t)) { best = { gal, words: [w] }; bestLen = w.length; }
  }
  return best;
}

/** The short capitalised tag form: "the first colony in Andromeda" → "First colony in Andromeda". */
export function tagLabel(g: Goal): string {
  const l = g.label.replace(/^the /, '');
  return l[0].toUpperCase() + l.slice(1);
}

export function parseGoal(text: string, world: World): ParseResult {
  const fail = (error: string): ParseResult => ({ error, suggestions: [...SUGGESTIONS] });
  const pre = text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.,\s]/g, ' ');
  const t = ` ${wordsToNumbers(pre).replace(/\s+/g, ' ').trim()} `;
  const place = findPlace(t, world);
  const gal = findGalaxy(t);
  if (!gal && /\bmilky way\b/.test(t)) return fail(`The Milky Way isn't an endpoint: every future starts there.`);
  const body = place?.body;
  const bName = (b: number) => world.bodies[b].name;
  const sName = (s: number) => world.systems[s].name;

  // --- terraforming a named world (default Mars)
  const terraWord = /\bterraform|greening|\bbreathable\b|\bopen seas?\b|\boceans?\b|\b(air|atmosphere)\w* (hold|holds|thickens?|thicken|return)|\bmake\b.*\b(habitable|liveable|livable|green)\b/.test(t);
  if (terraWord) {
    const level: 1 | 2 | 3 = /\bopen seas?\b|\boceans?\b/.test(t) ? 2 : /\b(air|atmosphere)\w* (hold|holds|thickens?|return)/.test(t) ? 1 : 3;
    let b = body;
    if (b === undefined && place?.system !== undefined) b = world.systems[place.system].bodies.find((x) => terraOK(world)[x]);
    if (b === undefined) b = world.mars;
    if (!terraOK(world)[b]) {
      const n = bName(b);
      return fail(`${n} can't be terraformed in this simulation — it has no surface to work, or it already breathes.`);
    }
    const label = level === 3 ? `a breathable ${bName(b)}` : level === 2 ? `open seas on ${bName(b)}` : `air that holds on ${bName(b)}`;
    return { goal: { id: `terraform:${level}:${b}`, label, detail: `${bName(b)}'s terraforming reaches "${TERRA_TEXT[level - 1]}" (progress ${TERRA_X[level - 1]})`, kind: 'terraform', body: b, level } };
  }

  // --- Dyson swarms
  if (/\bdyson\b|\bsphere\b|\bswarm\b(?![\w-]*\s*world)|\bmegastructure around\b|\bcapture the (sun|star)/.test(t)) {
    const phase: 1 | 2 = /phase (ii|2|two)|\bcomplete|\bfinished|\bfull\b|third of/.test(t) ? 2 : 1;
    const sys = place ? place.system ?? world.bodies[place.body!].system : undefined;
    const star = sys === undefined ? 'the first star to get one' : sName(sys) === 'Sol' ? 'the Sun' : sName(sys);
    return { goal: { id: `swarm:${phase}:${sys ?? 'any'}`, label: sys === undefined ? (phase === 2 ? 'a complete Dyson swarm' : 'the first Dyson swarm') : `a Dyson swarm around ${star}`, detail: `phase ${phase === 1 ? 'I' : 'II'} of a Dyson swarm begins around ${star}`, kind: 'swarm', system: sys, phase } };
  }

  // --- named technologies
  let tech = -1;
  for (const [re, id] of TECH_ALIAS) {
    if (re.test(t)) { const i = TECH_INDEX.get(id); if (i !== undefined) { tech = i; break; } }
  }
  if (tech < 0) {
    let bestLen = 0;
    TECHS.forEach((tt, i) => {
      const n = normName(tt.name);
      if (n.length > bestLen && t.includes(` ${n} `)) { tech = i; bestLen = n.length; }
      const d = normName(tt.id);
      if (d.length > bestLen && t.includes(` ${d} `)) { tech = i; bestLen = d.length; }
    });
  }
  if (tech >= 0) return { goal: { id: `tech:${tech}`, label: TECHS[tech].name, detail: `${TECHS[tech].name} invented — ${TECHS[tech].blurb}`, kind: 'tech', tech } };

  // --- events
  if (/\bfirst contact\b|contact with (aliens|extraterrestrial|another)/.test(t)) {
    return { goal: { id: 'event:contact', label: 'first contact', detail: 'the first contact event: a signal, or ruins', kind: 'event', event: EV['First contact'] } };
  }
  if (/\bindependence\b|\bsecede|\bbreaks? away|\bfree (of|from)\b/.test(t)) {
    const label = body !== undefined ? `the independence of ${bName(body)}` : 'the first independence';
    const detail = body !== undefined ? `${bName(body)} declares independence` : 'any settlement declares independence';
    return { goal: { id: `event:indep:${body ?? 'any'}`, label, detail, kind: 'event', event: EV.Independence, body } };
  }
  if (/\b(first )?wars?\b|\bwar breaks out\b/.test(t)) {
    return { goal: { id: 'event:war', label: 'the first war', detail: 'the first war between settlements', kind: 'event', event: EV.War } };
  }

  // --- "a million people on Mars"
  const onBody = t.match(/([\d.,]+)\s*(people|persons|humans|souls|inhabitants|colonists|residents)\b/);
  if (onBody && body !== undefined) {
    const n = Math.round(parseFloat(onBody[1].replace(/,/g, '')));
    if (n > 0) return { goal: { id: `pop:${n}:${body}`, label: `${fmtPeople(n)} people on ${bName(body)}`, detail: `${bName(body)}'s population passes ${fmtPeople(n)}`, kind: 'pop', body, threshold: n } };
  }

  // --- a settlement stage on a world
  let stage = -1;
  for (const [re, s] of STAGE_WORDS) if (re.test(t)) { stage = s; break; }
  if (stage < 0 && (place || gal)) stage = STAGE.OUTPOST;  // a bare place means the first settlement there
  if (stage >= 0) {
    if (gal) {
      const G = galName(gal.gal);
      const label = stage === STAGE.OUTPOST ? `the first settlement in ${G}` : `the first ${stage === STAGE.UPLOADED ? 'uploaded world' : STAGE_NAMES[stage].toLowerCase()} in ${G}`;
      return { goal: { id: `stage:${stage}:gal:${gal.gal}`, label, detail: `a world in ${G} becomes ${article(STAGE_NAMES[stage])} ${STAGE_NAMES[stage]}: ${STAGE_DETAIL[stage] ?? ''} — reachable only through traversable wormholes`, kind: 'stage', galaxy: gal.gal, stage } };
    }
    if (place) {
      const label = stageLabel(world, place, stage);
      const who = place.body !== undefined ? bName(place.body) : `a world in ${sName(place.system!)}`;
      return { goal: { id: `stage:${stage}:${place.body ?? 'sys' + place.system}`, label, detail: `${who} becomes ${article(STAGE_NAMES[stage])} ${STAGE_NAMES[stage]}: ${STAGE_DETAIL[stage] ?? ''}`, kind: 'stage', body: place.body, system: place.system, stage } };
    }
    // "colonise another star" means leaving the Solar System
    if (stage === STAGE.COLONY && /another star|interstellar|exoplanet|beyond (the )?solar system|other stars|extrasolar|alien (world|planet)/.test(t)) {
      return { goal: { id: 'metric:systems:2', label: 'the first settlement around another star', detail: 'settlements in two star systems (Sol plus one more)', kind: 'metric', metric: 'systems', threshold: 2 } };
    }
    const lbl = stage === STAGE.OUTPOST ? 'the first settlement beyond Earth' : `the first ${stage === STAGE.UPLOADED ? 'uploaded world' : STAGE_NAMES[stage].toLowerCase()} beyond Earth`;
    return { goal: { id: `stage:${stage}:any`, label: lbl, detail: `any world but Earth becomes ${article(STAGE_NAMES[stage])} ${STAGE_NAMES[stage]}: ${STAGE_DETAIL[stage] ?? ''}`, kind: 'stage', body: -1, stage } };
  }

  // --- bare metrics
  if (onBody) {
    const n = Math.round(parseFloat(onBody[1].replace(/,/g, '')));
    if (n > 0) return { goal: { id: `metric:pop:${n}`, label: `${fmtPeople(n)} people`, detail: `humanity's total population passes ${fmtPeople(n)}`, kind: 'metric', metric: 'pop', threshold: n } };
  }
  const kar = t.match(/\bkardashev\b[^.]*?(\d+(\.\d+)?)/) ?? t.match(/\btype\s+(i{1,3}|iv|v|[123](\.\d+)?)\b[^.]*?\b(civil|empire|species)\b/) ?? t.match(/\btype\s+(i{1,3}|[123])\s*(civil|empire)/);
  if (kar) {
    const raw = kar[1];
    const n = /^i+$/.test(raw) ? raw.length : raw === 'iv' ? 4 : raw === 'v' ? 5 : parseFloat(raw);
    return { goal: { id: `metric:kardashev:${n}`, label: `a Kardashev ${n} civilisation`, detail: `the Kardashev rating passes ${n}`, kind: 'metric', metric: 'kardashev', threshold: n } };
  }
  const sysN = t.match(/(\d+)\s*(star\s+)?systems?\b/) ?? t.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+stars?\b/);
  if (sysN) {
    const n = parseFloat(sysN[1]);
    if (n > 0) return { goal: { id: `metric:systems:${n}`, label: `${fmtPeople(n)} star systems`, detail: `settlements in ${n} star systems`, kind: 'metric', metric: 'systems', threshold: n } };
  }

  return fail(`I can't read a moment in time out of that.`);
}

// ------------------------------------------------------------------ one event, strictly

/** A fresh engine at step 0, for the "already true in 2040" check — one per world. */
const zero = new WeakMap<World, Engine>();
function engine0(world: World): Engine {
  let e = zero.get(world);
  if (!e) { e = new Engine(world, 1); e.ledger = null; zero.set(world, e); }
  return e;
}

/** What already holds at step 0, for the already-true message. */
function whyTrue(goal: Goal, e: Engine): string {
  const bName = (b: number) => e.world.bodies[b].name;
  switch (goal.kind) {
    case 'stage': {
      for (const b of goalBodies(goal, e.world)) {
        const v = e.st.S[b * NF + F.stage];
        if (isAlive(v) && v >= goal.stage!) return `${bName(b)} is already ${article(STAGE_NAMES[v])} ${STAGE_NAMES[v]}`;
      }
      return 'it already holds at the start';
    }
    case 'pop': return `${bName(goal.body!)} already has ${fmtPeople(Math.round(e.st.S[goal.body! * NF + F.pop]))} people`;
    case 'metric': {
      const v = e.series[GM[goal.metric!]];
      if (goal.metric === 'pop') return `humanity already numbers ${fmtPeople(Math.round(v))}`;
      if (goal.metric === 'systems') return `${Math.round(v)} star systems already hold settlements`;
      return `the Kardashev rating is already ${v.toFixed(2)}`;
    }
    case 'tech': return `${TECHS[goal.tech!].name} is already known`;
    default: return 'it already holds at the start';
  }
}

// ------------------------------------------------------------------ strict words

/** Words that never carry meaning in a tag: articles, prepositions, pronouns, auxiliaries, filler. */
const STOP = new Set(('the a an of on in to at for by with from into onto around near its it our my some any ' +
  'anywhere there here be is are was were becomes become begin begins start starts new whole all more than over up out ' +
  'until about when what which that this these those do does can will would should let lets see show me us we you i ' +
  'time moment day year years happen happens happened earliest soonest ever').split(' '));

/** Every word the goal vocabulary owns — pattern words, stage words, galaxy words, tech words. */
const VOCAB = new Set(('terraform terraforming greening green breathable open sea seas ocean oceans air atmosphere hold holds ' +
  'thickens thicken return make makes made habitable liveable livable ' +
  'dyson sphere swarm megastructure megastructures capture phase ii two complete completed finished full third begins ' +
  'construction construct build built ' +
  'warp alcubierre ftl faster than light wormholes wormhole he3 helium aneutronic fusion torch drive space elevator elevators ' +
  'generation agi artificial general intelligence ai mind upload uploading uploads matrioshka lifting lift neill oneill orbital ' +
  'rotating habitats habitat antimatter nanotech nanofab molecular assembler assemblers nano fabrication ' +
  'extension immortal anti aging ageing longevity laser sails sail beamed bishop rings ring cloud aerostat ' +
  'von neumann self replicating cryo cryosleep hibernate quantum computer computing neural lace interface ' +
  'asteroid asteroids genetic medicine adaptation gene therapy seed embryo ramjet bussard paraterraform magnetic nuclear thermal ' +
  'synthetic bio engineered crops psychohistory predictive social comms network starshot sub carbon nanotube nanotubes ' +
  'radiation regolith robot robots robotics isru support closed loop fission reusable heavy interstellar ' +
  'first contact aliens extraterrestrial independence secede break breaks away free war wars out ' +
  'world worlds lifted metropolis city cities town towns hub hubs base bases ' +
  'colony colonies colonist colonists colonise colonize colonisation colonization settle settles settled settling ' +
  'settlement settlements outpost outposts land lands landed landing boots foot footprint steps step ' +
  'reach reaches reached reaching get gets getting ' +
  'people persons humans souls inhabitants colonists residents kardashev type civil civilisation civilization empire ' +
  'species systems population humanity total passes brain way ' +
  'sol solar system another other exoplanet stars extrasolar alien planet ' +
  'galaxy galaxies andromeda triangulum magellanic cloud large small m31 m33 lmc smc milky different outside intergalactic ' +
  'star sun anywhere ').split(/\s+/));
for (const tt of TECHS) {
  for (const w of normName(tt.name).split(' ')) VOCAB.add(w);
  for (const w of tt.id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')) VOCAB.add(w);
}
VOCAB.delete('on'); VOCAB.delete('in'); VOCAB.delete('at'); VOCAB.delete('to'); // stage-verb particles stay stopwords-adjacent but count for nothing

/** Optimal-string-alignment (Damerau) edit distance. */
function osa(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) ? d[i - 2][j - 2] + 1 : Infinity);
  }
  return d[a.length][b.length];
}

/** The words typo candidates are drawn from: the vocabulary plus every real place name's words. */
function typoCands(world: World): Set<string> {
  const c = new Set(VOCAB);
  for (const sys of world.systems) if (sys.real) {
    for (const w of normName(sys.name).split(' ')) c.add(w);
    for (const b of sys.bodies) for (const w of normName(world.bodies[b].name).split(' ')) c.add(w);
  }
  for (const g of GALAXIES) for (const w of normName(g.name).split(' ')) c.add(w);
  for (const w of ['m31', 'm33', 'lmc', 'smc']) c.add(w);
  return c;
}
const TYPO_CANDS = new WeakMap<World, Set<string>>();

/** Words the parser's own stems accept even when they're not whole vocabulary words ("uploaded", "hibernation"). */
const STEM_RES = [...STAGE_WORDS.map(([re]) => re), ...TECH_ALIAS.map(([re]) => re)];
const accounted = (w: string, placeWords: Set<string>): boolean =>
  /\d/.test(w) || STOP.has(w) || VOCAB.has(w) || placeWords.has(w) ||
  STEM_RES.some((re) => re.test(` ${w} `)) ||
  (w.length > 1 && (VOCAB.has(w.replace(/es$/, '')) || VOCAB.has(w.replace(/s$/, ''))));

/** What a tag (and later the mic and the Oracle) is made from: connectors, words, the parse, the 2040 check. */
export function parseEvent(text: string, world: World): ParseResult {
  const t = ` ${wordsToNumbers(text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.,\s]/g, ' ')).replace(/\s+/g, ' ').trim()} `;
  const placeWords = new Set([...(findPlace(t, world)?.words ?? []), ...(findGalaxy(t)?.words ?? [])]);
  const masked = ` ${t.trim().split(/\s+/).filter((w) => !placeWords.has(w)).join(' ')} `;
  if (/\b(and then|followed by|after that|then|and)\b|&/.test(masked)) {
    return { error: 'One event per tag: press Enter after each event.', suggestions: [] };
  }
  const tokens = t.trim().split(/\s+/);
  const unaccounted = tokens.filter((w) => !accounted(w, placeWords));
  const notes: string[] = [];
  let corrected = text;
  if (unaccounted.length) {
    let cands = TYPO_CANDS.get(world);
    if (!cands) { cands = typoCands(world); TYPO_CANDS.set(world, cands); }
    const picks: [string, string][] = [], noCand: string[] = [];
    for (const w of unaccounted) {
      if (w.length < 4) { noCand.push(w); continue; }
      const lim = w.length <= 6 ? 1 : 2;
      let best = Infinity, found: string[] = [];
      for (const c of cands) {
        const d = osa(w, c);
        if (d > 0 && d <= lim && d < best) { best = d; found = [c]; }
        else if (d > 0 && d === best) { if (!found.includes(c)) found.push(c); }
      }
      if (found.length === 1) picks.push([w, found[0]]);
      else if (found.length > 1) {
        const list = found.slice(0, 3);
        const offer = list.length === 2 ? `${list[0]} or ${list[1]}` : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
        return { error: `Did you mean ${offer}?`, suggestions: list.map((c) => tokens.map((w2) => (w2 === w ? c : w2)).join(' ')) };
      } else noCand.push(w);
    }
    if (noCand.length) {
      const pick = new Map(picks);
      const rest = tokens.map((w) => pick.get(w) ?? (noCand.includes(w) ? '' : w)).filter(Boolean).join(' ');
      const rr = parseGoal(rest, world);
      if ('goal' in rr) return { error: `I understood "${rr.goal.label}" but not "${noCand.join(' ')}".`, suggestions: [] };
      return { error: `I can't read a moment in time out of "${text}".`, suggestions: [...SUGGESTIONS] };
    }
    const pick = new Map(picks);
    corrected = tokens.map((w) => pick.get(w) ?? w).join(' ');
    for (const [w, c] of picks) notes.push(`read "${w}" as "${c}"`);
    // one re-accounting on the corrected text: anything still unread is named
    const t2 = ` ${wordsToNumbers(corrected.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.,\s]/g, ' ')).replace(/\s+/g, ' ').trim()} `;
    const pw2 = new Set([...(findPlace(t2, world)?.words ?? []), ...(findGalaxy(t2)?.words ?? [])]);
    const left = t2.trim().split(/\s+/).filter((w) => !accounted(w, pw2));
    if (left.length) {
      const rest = t2.trim().split(/\s+/).filter((w) => !left.includes(w)).join(' ');
      const rr = parseGoal(rest, world);
      if ('goal' in rr) return { error: `I understood "${rr.goal.label}" but not "${left.join(' ')}".`, suggestions: [] };
      return { error: `I can't read a moment in time out of "${text}".`, suggestions: [...SUGGESTIONS] };
    }
  }
  const r = parseGoal(corrected, world);
  if ('error' in r) return r;
  const e0 = engine0(world);
  if (reached(r.goal, e0)) {
    return { error: `That's already true in 2040: ${whyTrue(r.goal, e0)}.`, suggestions: [...SUGGESTIONS] };
  }
  return notes.length ? { goal: r.goal, notes } : r;
}


// ------------------------------------------------------------------ watching a run

/** The bodies a stage/pop goal can land on. */
function goalBodies(goal: Goal, world: World): number[] {
  if (goal.body !== undefined && goal.body >= 0) return [goal.body];
  if (goal.body === -1) return world.bodies.filter((b) => b.id !== world.earth).map((b) => b.id);
  if (goal.system !== undefined) return world.systems[goal.system].bodies;
  if (goal.galaxy) return world.systems.filter((s) => goal.galaxy === '*' ? s.galaxy !== 'Milky Way' : s.galaxy === goal.galaxy).flatMap((s) => s.bodies);
  return [];
}

/** The bodies a stage goal scans, as a mask over body ids — built once per goal+world. */
const scopeMasks = new WeakMap<Goal, Uint8Array>();
function scopeMask(goal: Goal, world: World): Uint8Array {
  let m = scopeMasks.get(goal);
  if (!m) {
    m = new Uint8Array(world.bodies.length);
    for (const b of goalBodies(goal, world)) m[b] = 1;
    scopeMasks.set(goal, m);
  }
  return m;
}

/** Peak stage and population ever seen per body, kept by reached() so progress() can say how close a miss came. */
const peaks = new WeakMap<Engine, { stage: Int16Array; pop: Float64Array }>();
function trackPeaks(e: Engine): { stage: Int16Array; pop: Float64Array } {
  let p = peaks.get(e);
  if (!p) {
    p = { stage: new Int16Array(e.world.bodies.length).fill(-1), pop: new Float64Array(e.world.bodies.length) };
    peaks.set(e, p);
  }
  const st = e.st;
  for (let n = 0; n < st.nSettled; n++) {
    const b = st.settled[n], s = st.S[b * NF + F.stage], pop = st.S[b * NF + F.pop];
    if (s > p.stage[b]) p.stage[b] = s;
    if (pop > p.pop[b]) p.pop[b] = pop;
  }
  return p;
}

/** The geo row a world's terraform progress lives in (solar bodies row = id; elsewhere nSol + founding order). */
function geoRow(e: Engine, b: number): number {
  const geo = e.geo;
  if (b < geo.nSol) return b;
  for (let n = 0; n < e.st.nSettled; n++) if (e.st.settled[n] === b) return geo.nSol + n;
  return -1;
}

function eventMatch(goal: Goal, ev: SimEvent): boolean {
  if (ev.type !== goal.event) return false;
  return goal.body === undefined || ev.body === goal.body;
}

/** The goal's truth at the current state — no peak tracking; the tracker calls this inside its own loop. */
function truthNow(goal: Goal, e: Engine): boolean {
  const st = e.st, S = st.S;
  switch (goal.kind) {
    case 'stage': {
      const mask = scopeMask(goal, e.world);
      for (let i = 0, n = st.nSettled; i < n; i++) {
        const b = st.settled[i];
        if (!mask[b]) continue;
        const s = S[b * NF + F.stage];
        if (s >= goal.stage! && isAlive(s)) return true;
      }
      return false;
    }
    case 'terraform': {
      const r = geoRow(e, goal.body!);
      return r >= 0 && st.geo[r * NGEO + GF.terra] >= TERRA_X[goal.level! - 1];
    }
    case 'swarm': {
      const w = st.swarm, k = goal.phase! - 1;
      if (goal.system !== undefined) return w[goal.system * 2 + k] >= 0;
      for (let s = 0; s < e.world.systems.length; s++) if (w[s * 2 + k] >= 0) return true;
      return false;
    }
    case 'tech': return st.techDone[goal.tech!] >= 0;
    case 'metric': return e.series[st.step * NGM + GM[goal.metric!]] >= goal.threshold!;
    case 'pop': return S[goal.body! * NF + F.pop] >= goal.threshold!;
    case 'event': return e.events.some((ev) => eventMatch(goal, ev));
  }
}

/** Called after every step: has this future reached the goal yet? */
export function reached(goal: Goal, e: Engine): boolean {
  trackPeaks(e);
  return truthNow(goal, e);
}

// ------------------------------------------------------------------ reading the road

const byName = (e: Engine, b: number) => e.world.bodies[b]?.name ?? 'somewhere';
const sysOf = (e: Engine, b: number) => e.world.systems[e.world.bodies[b]?.system ?? 0]?.name ?? 'somewhere';

/** The sim year the goal was hit (as close as the record allows). */
export function goalYear(goal: Goal, e: Engine): number {
  switch (goal.kind) {
    case 'terraform': {
      for (let i = e.events.length - 1; i >= 0; i--) {
        const ev = e.events[i];
        if (ev.type === EV['Terraforming milestone'] && ev.body === goal.body && ev.a >= goal.level!) return ev.year;
      }
      return e.year;
    }
    case 'swarm': {
      const w = e.st.swarm, k = goal.phase! - 1;
      if (goal.system !== undefined) return w[goal.system * 2 + k];
      let m = Infinity;
      for (let s = 0; s < e.world.systems.length; s++) { const v = w[s * 2 + k]; if (v >= 0 && v < m) m = v; }
      return m;
    }
    case 'tech': return e.st.techDone[goal.tech!];
    case 'event': {
      for (let i = e.events.length - 1; i >= 0; i--) if (eventMatch(goal, e.events[i])) return e.events[i].year;
      return e.year;
    }
    default: return e.year;
  }
}

/** The body the goal came true on (for goals that name no single body). */
function goalBodyNow(goal: Goal, e: Engine): number | undefined {
  if (goal.body !== undefined && goal.body >= 0) return goal.body;
  const bodies = goalBodies(goal, e.world);
  if (goal.kind === 'stage') {
    let best = -1, bs = -1;
    for (const b of bodies) { const s = e.st.S[b * NF + F.stage]; if (isAlive(s) && s >= goal.stage! && s > bs) { bs = s; best = b; } }
    return best >= 0 ? best : undefined;
  }
  return undefined;
}

/** The techs a road to this goal runs through (goal techs plus what they require). */
function relevantTechs(goal: Goal, e: Engine, goalSim: number): number[] {
  const own = new Set<number>();
  const grab = (id: string) => { const i = TECH_INDEX.get(id); if (i !== undefined) own.add(i); };
  if (goal.kind === 'terraform') { grab('terraform'); grab('paraterraform'); grab('magShield'); }
  else if (goal.kind === 'swarm') { grab('dyson1'); if (goal.phase === 2) { grab('dyson2'); grab('bishopRings'); } }
  else if (goal.kind === 'tech') own.add(goal.tech!);
  const R = new Set<number>();
  const close = (i: number) => { if (R.has(i)) return; R.add(i); for (const r of TECH_REQ[i]) close(r); };
  for (const i of own) close(i);
  if (!own.size) {
    // growth-and-travel techs: the last three invented before the goal
    const KEYS: (keyof (typeof TECHS)[number]['fx'])[] = ['hab', 'habHostile', 'habitat', 'lifeSupport', 'launch', 'voyage', 'shipSpeed'];
    const cand = TECHS.map((_, i) => i)
      .filter((i) => e.st.techDone[i] >= 0 && e.st.techDone[i] <= goalSim && KEYS.some((k) => TECHS[i].fx[k] !== undefined))
      .sort((a, b) => e.st.techDone[b] - e.st.techDone[a]);
    for (const i of cand.slice(0, 3)) R.add(i);
  }
  return [...R];
}

export interface Step {
  year: number; // calendar
  text: string;
  kind: 'tech' | 'stage' | 'terraform' | 'ship' | 'era' | 'war' | 'disaster' | 'contact' | 'goal';
  body?: number;
  tech?: number;
}

function goalStepText(goal: Goal, e: Engine): string {
  const B = goalBodyNow(goal, e), bn = B !== undefined ? byName(e, B) : '';
  switch (goal.kind) {
    case 'stage': return goal.galaxy ? `${bn} in ${galName(goal.galaxy)} becomes ${article(STAGE_NAMES[goal.stage!])} ${STAGE_NAMES[goal.stage!]}` : goal.stage === STAGE.UPLOADED ? `${bn} is uploaded` : `${bn} becomes ${article(STAGE_NAMES[goal.stage!])} ${STAGE_NAMES[goal.stage!]}`;
    case 'terraform': return `${bn}: ${TERRA_TEXT[goal.level! - 1]}`;
    case 'swarm': {
      const w = e.st.swarm, k = goal.phase! - 1, gs = goalYear(goal, e);
      let sys = goal.system;
      if (sys === undefined) for (let s = 0; s < e.world.systems.length; s++) if (w[s * 2 + k] === gs) { sys = s; break; }
      const star = sys === 0 || sys === undefined ? 'the Sun' : e.world.systems[sys].name;
      return goal.phase === 2 ? `the swarm around ${star} thickens to phase II` : `a Dyson swarm begins around ${star}`;
    }
    case 'tech': {
      const w = e.st.techWhere[goal.tech!];
      return `${TECHS[goal.tech!].name} invented${w >= 0 ? ` on ${byName(e, w)}` : ''}`;
    }
    case 'pop': return `${bn} passes ${fmtPeople(goal.threshold!)} people`;
    case 'metric': {
      if (goal.metric === 'pop') return `humanity passes ${fmtPeople(goal.threshold!)} people`;
      if (goal.metric === 'systems') return `${fmtPeople(goal.threshold!)} star systems hold settlements`;
      return `a Kardashev ${goal.threshold} civilisation`;
    }
    case 'event': {
      if (goal.event === EV['First contact']) return 'first contact';
      if (goal.event === EV.Independence) return `${bn || 'a settlement'} declares independence`;
      return 'the first war';
    }
  }
}

/** The steps that led to the goal, sorted by year, the goal itself last. At most 12. endCal overrides the end year (chains). */
export function pathOf(goal: Goal, e: Engine, endCal?: number): Step[] {
  const st = e.st, goalSim = endCal !== undefined ? endCal - YEAR0 : goalYear(goal, e), goalCal = YEAR0 + goalSim;
  const B = goalBodyNow(goal, e);
  const R = relevantTechs(goal, e, goalSim);
  // the goal's own techs plus their direct requirements come first in priority
  const own = new Set<number>();
  const grab = (id: string) => { const i = TECH_INDEX.get(id); if (i !== undefined) own.add(i); };
  if (goal.kind === 'terraform') { grab('terraform'); grab('paraterraform'); grab('magShield'); }
  else if (goal.kind === 'swarm') { grab('dyson1'); if (goal.phase === 2) { grab('dyson2'); grab('bishopRings'); } }
  else if (goal.kind === 'tech') own.add(goal.tech!);
  const firstTier = new Set<number>(own);
  for (const i of own) for (const r of TECH_REQ[i]) firstTier.add(r);

  const steps: Step[] = [];
  const seen = new Set<string>();
  const push = (year: number, text: string, kind: Step['kind'], body?: number, tech?: number): void => {
    const y = Math.round(year);
    if (y > goalCal || y < YEAR0 - 1) return;
    const key = `${kind}:${y}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (steps.length < 11) steps.push({ year: y, text, kind, body, tech });
  };
  const techStep = (i: number) => {
    const d = st.techDone[i];
    if (d < 0 || d > goalSim) return;
    const w = st.techWhere[i];
    push(YEAR0 + d, `${TECHS[i].name} invented${w >= 0 ? ` on ${byName(e, w)}` : ''}`, 'tech', w >= 0 ? w : undefined, i);
  };

  for (const i of R) if (firstTier.has(i)) techStep(i);

  if (B !== undefined) {
    // the founding of the place: a ship, a mission, or the premise itself
    const evs = e.events;
    const founding = evs.find((ev) => (ev.type === EV['Ship arrived'] || ev.type === EV['Colony founded']) && ev.body === B);
    if (founding) {
      push(YEAR0 + founding.year, founding.type === EV['Ship arrived']
        ? `a ship from ${byName(e, founding.a)} reaches ${byName(e, B)}`
        : `${byName(e, B)} is settled${founding.a >= 0 ? ` from ${byName(e, founding.a)}` : ''}`, 'ship', B);
    } else {
      const f = st.S[B * NF + F.founded];
      push(YEAR0 + f, f <= 0 ? `the first crews land on ${byName(e, B)}` : `${byName(e, B)} is first settled`, 'stage', B);
    }
    // its rise and its falls
    for (const ev of evs) {
      if (ev.body !== B || ev.year > goalSim) continue;
      if (ev.type === EV['Stage up']) {
        if (goal.kind === 'stage' && B === goal.body && ev.a === goal.stage) continue; // that one is the goal itself
        push(YEAR0 + ev.year, `${byName(e, B)} becomes ${article(STAGE_NAMES[ev.a])} ${STAGE_NAMES[ev.a]}`, 'stage', B);
      } else if (ev.type === EV['Megastructure complete']) push(YEAR0 + ev.year, `${byName(e, B)} completes a megastructure`, 'stage', B);
      else if (ev.type === EV.Collapse) push(YEAR0 + ev.year, `${byName(e, B)} falls back to ${article(STAGE_NAMES[ev.a])} ${STAGE_NAMES[ev.a]}`, 'disaster', B);
      else if (ev.type === EV.Abandoned) push(YEAR0 + ev.year, `${byName(e, B)} is abandoned`, 'disaster', B);
    }
    // terraforming on it, same-year milestones collapsed into the highest
    const terraByYear = new Map<number, number>();
    for (const ev of evs) if (ev.type === EV['Terraforming milestone'] && ev.body === B && ev.year <= goalSim) terraByYear.set(ev.year, Math.max(terraByYear.get(ev.year) ?? 0, ev.a));
    for (const [y, a] of terraByYear) {
      if (goal.kind === 'terraform' && a >= goal.level!) continue; // the goal step says this
      push(YEAR0 + y, `${byName(e, B)}: ${TERRA_TEXT[a - 1] ?? `terraforming milestone ${a}`}`, 'terraform', B);
    }
  }

  // context: what the world was going through
  interface Ctx { year: number; text: string; kind: Step['kind']; body?: number }
  const ctx: Ctx[] = [];
  const CONTEXT_ERAS = new Set([2, 4, 5, 6, 7]); // Golden Age, War, Pandemic, Collapse, Renaissance
  for (const ev of e.events) {
    if (ev.year > goalSim) continue;
    const y = YEAR0 + ev.year;
    if (ev.type === EV['Era change'] && CONTEXT_ERAS.has(ev.a)) ctx.push({ year: y, text: `the ${ERAS[ev.a]} era begins`, kind: 'era' });
    else if (ev.type === EV.War && (ev.body === B || ev.a === B)) ctx.push({ year: y, text: `war between ${byName(e, ev.body)} and ${byName(e, ev.a)}`, kind: 'war', body: B });
    else if (ev.type === EV['First contact']) ctx.push({ year: y, text: ev.a === 1 ? 'first contact: a signal from another mind' : 'first contact: ruins of someone else', kind: 'contact' });
    else if (ev.type === EV['AI schism']) ctx.push({ year: y, text: 'the AI schism', kind: 'disaster' });
    else if (ev.type === EV['Kessler cascade']) ctx.push({ year: y, text: 'a Kessler cascade grounds Earth', kind: 'disaster', body: ev.body });
    else if (ev.type === EV['Dark forest strike']) ctx.push({ year: y, text: `a dark forest strike erases the ${sysOf(e, ev.body)} system`, kind: 'disaster', body: ev.body });
    else if (B !== undefined && ev.body === B) {
      if (ev.type === EV['Asteroid strike']) ctx.push({ year: y, text: `an asteroid strikes ${byName(e, B)}`, kind: 'disaster', body: B });
      else if (ev.type === EV.Supereruption) ctx.push({ year: y, text: `a supereruption on ${byName(e, B)}`, kind: 'disaster', body: B });
      else if (ev.type === EV.Plague && ev.a >= 0.1) ctx.push({ year: y, text: `a plague on ${byName(e, B)} kills ${Math.round(ev.a * 100)}%`, kind: 'disaster', body: B });
    }
  }
  ctx.sort((a, b) => b.year - a.year);
  for (const c of ctx.slice(0, 3)) push(c.year, c.text, c.kind, c.body);

  // the rest of the relevant techs, most recent first
  const rest = R.filter((i) => !firstTier.has(i)).sort((a, b) => st.techDone[b] - st.techDone[a]);
  for (const i of rest) techStep(i);

  steps.sort((a, b) => a.year - b.year);
  const goalStep: Step = { year: goalCal, text: goalStepText(goal, e), kind: 'goal', body: B };
  return [...steps.filter((s) => s.year <= goalCal), goalStep];
}

// ------------------------------------------------------------------ results and comparison

export interface FutureResult {
  seed: number;
  reached: boolean;
  year?: number;          // calendar year the goal (or chain's end) was hit
  step: number;           // engine step at that moment
  steps: Step[];
  parts: { label: string; stage: number; year?: number; already?: boolean; body?: number }[];
  progress?: string;      // how close a miss came
  stats: { pop: number; systems: number; kardashev: number; era: string };
  techYears: Record<number, number>;
  spark: { years: Float64Array; pop: Float64Array };
}

/** A goal hit in a chain evaluation: the year it counted, the step, whether it was already true. */
export interface PartHit { year: number; step: number; already: boolean; body?: number }

/** Drives a chain through an engine's life: each stage's parts must all be seen;
 *  'then' stages open only once the previous stage is complete. */
export class ChainTracker {
  readonly chain: Chain;
  stage = 0;
  done = false;
  completedStep = 0;
  hits: (PartHit | null)[][];
  private e: Engine;
  private openStep: number[] = [0];
  private openYear: number[];
  private scan: number[][];                 // per-part event-log mark, per stage
  private truth: boolean[][];               // last check's truth of every non-event part

  constructor(chain: Chain, e: Engine) {
    this.chain = chain;
    this.e = e;
    this.hits = chain.stages.map((s) => s.map(() => null));
    this.scan = chain.stages.map((s) => s.map(() => 0));
    this.openYear = [YEAR0 + e.years[0]];
    this.truth = chain.stages.map((s) => s.map((g) => g.kind === 'event' ? false : reached(g, e)));
  }

  /** One engine step, then evaluate at the new state. */
  advance(): boolean {
    const before = this.e.events.length;
    this.e.step();
    return this.check(before);
  }

  /** Evaluate the open stage at the current state (events of the just-run step are e.events[before..]). */
  check(before: number): boolean {
    if (this.done) return true;
    const e = this.e, t = e.st.step;
    trackPeaks(e);
    const nowTruth = this.chain.stages.map((s, si) => s.map((g) => si < this.stage || g.kind === 'event' ? false : truthNow(g, e)));
    while (this.stage < this.chain.stages.length) {
      const s = this.stage, stage = this.chain.stages[s];
      let all = true;
      for (let i = 0; i < stage.length; i++) {
        if (this.hits[s][i]) continue;
        const g = stage[i];
        if (g.kind === 'event') {
          const evs = e.events;
          for (let j = Math.max(0, this.scan[s][i]); j < evs.length; j++) {
            if (eventMatch(g, evs[j])) {
              this.hits[s][i] = { year: YEAR0 + evs[j].year, step: t, already: false, body: goalBodyNow(g, e) };
              this.scan[s][i] = j + 1;
              break;
            }
          }
          if (!this.hits[s][i]) { this.scan[s][i] = evs.length; all = false; }
        } else if (nowTruth[s][i]) {
          const already = s > 0 && t === this.openStep[s] && this.truth[s][i];
          const year = already ? this.openYear[s] : Math.max(YEAR0 + goalYear(g, e), this.openYear[s]);
          this.hits[s][i] = { year, step: t, already, body: goalBodyNow(g, e) };
        } else all = false;
      }
      if (!all) break;
      if (s + 1 < this.chain.stages.length) {
        this.stage = s + 1;
        this.openStep[s + 1] = t;
        this.openYear[s + 1] = Math.max(...this.hits[s].map((h) => h!.year));
        for (let i = 0; i < this.chain.stages[s + 1].length; i++) {
          if (this.chain.stages[s + 1][i].kind === 'event') this.scan[s + 1][i] = before;
        }
      } else {
        this.done = true;
        this.completedStep = t;
        break;
      }
    }
    this.truth = nowTruth;
    return this.done;
  }

  /** The calendar year the last stage completed. Only meaningful when done. */
  completionYear(): number {
    return Math.max(...this.hits.flat().map((h) => h?.year ?? 0));
  }
}

/** Wrap up a finished (or stopped-at-the-goal) engine into a FutureResult. */
export function resultOf(chain: Chain, e: Engine, tr: ChainTracker): FutureResult {
  const st = e.st, row = st.step * NGM;
  const n = st.step + 1;
  const years = new Float64Array(n), pop = new Float64Array(n);
  for (let i = 0; i < n; i++) { years[i] = YEAR0 + e.years[i]; pop[i] = e.series[i * NGM + GM.pop]; }
  const parts = chain.stages.flatMap((s, si) => s.map((g, gi) => {
    const h = tr.hits[si][gi];
    return { label: g.label, stage: si, year: h?.year, already: h?.already, body: h?.body };
  }));
  const hit = tr.done, endCal = hit ? tr.completionYear() : 0;
  const goals = chain.stages.flat();
  const last = parts.reduce((m, p, i) => (p.year !== undefined && (m < 0 || p.year >= parts[m].year!)) ? i : m, -1);
  const lastGoal = goals[last >= 0 ? last : goals.length - 1];
  const goalSim = hit ? endCal - YEAR0 : 0;
  const R = relevantTechs(lastGoal, e, hit ? goalSim : e.year);
  const techYears: Record<number, number> = {};
  for (const i of R) if (st.techDone[i] >= 0 && (!hit || st.techDone[i] <= goalSim)) techYears[i] = YEAR0 + st.techDone[i];
  let prog: string | undefined;
  if (!hit) {
    const open = Math.min(tr.stage, chain.stages.length - 1);
    const firstUnmet = chain.stages[open].find((_, gi) => !tr.hits[open][gi]) ?? chain.stages[open][0];
    const seen = parts.filter((p) => p.year !== undefined);
    prog = !seen.length ? progress(firstUnmet, e)
      : `reached ${seen.map((p) => `${p.label} in ${p.year}`).join(', ')}, never ${firstUnmet.label} — ${progress(firstUnmet, e)}`;
  }
  return {
    seed: e.seed,
    reached: hit,
    year: hit ? endCal : undefined,
    step: st.step,
    steps: hit ? pathOf(lastGoal, e, endCal) : [],
    parts,
    progress: hit ? undefined : prog,
    stats: {
      pop: e.series[row + GM.pop],
      systems: e.series[row + GM.systems],
      kardashev: e.series[row + GM.kardashev],
      era: ERAS[Math.round(e.series[row + GM.era])] ?? 'Expansion',
    },
    techYears,
    spark: { years, pop },
  };
}

/** How close a future that never reached the goal came. */
export function progress(goal: Goal, e: Engine): string {
  const p = trackPeaks(e), st = e.st;
  const bName = (b: number) => e.world.bodies[b].name;
  switch (goal.kind) {
    case 'stage': {
      const bodies = goalBodies(goal, e.world);
      let best = -2;
      for (const b of bodies) best = Math.max(best, p.stage[b]);
      if (goal.galaxy) {
        const wi = TECH_INDEX.get('wormholes')!;
        if (st.techDone[wi] < 0) return st.techProg[wi] < 0 ? 'traversable wormholes proved impossible in this future' : 'traversable wormholes were never invented';
        const G = galName(goal.galaxy);
        const got = best < 0 ? (G === 'another galaxy' ? 'no other galaxy was ever settled' : `${G} was never settled`) : `nowhere in ${G} passed ${article(STAGE_NAMES[best])} ${STAGE_NAMES[best]}`;
        return `traversable wormholes came in ${YEAR0 + st.techDone[wi]}, but ${got}`;
      }
      const where = goal.body !== undefined && goal.body >= 0 ? bName(goal.body) : goal.system !== undefined ? `the ${e.world.systems[goal.system].name} system` : 'anywhere';
      if (best < 0) return `${where} was never settled`;
      if (best < STAGE.OUTPOST) return `${where} was surveyed but never settled`;
      return goal.body === -1 || goal.system !== undefined ? `nowhere there passed ${article(STAGE_NAMES[best])} ${STAGE_NAMES[best]}` : `${where} peaked as ${article(STAGE_NAMES[best])} ${STAGE_NAMES[best]}`;
    }
    case 'terraform': {
      const r = geoRow(e, goal.body!);
      const x = r >= 0 ? st.geo[r * NGEO + GF.terra] : 0;
      const pct = Math.round((x / TERRA_X[goal.level! - 1]) * 100);
      if (x <= 0) {
        const stg = p.stage[goal.body!] ?? -1;
        return stg < STAGE.CITY ? `${bName(goal.body!)} never grew a city big enough to begin` : `terraforming never began on ${bName(goal.body!)}`;
      }
      return `${bName(goal.body!)} got ${pct}% of the way to ${TERRA_TEXT[goal.level! - 1].replace(/^the /, 'the ')}`;
    }
    case 'swarm': {
      const techId = goal.phase === 2 ? 'dyson2' : 'dyson1';
      const ti = TECH_INDEX.get(techId)!;
      if (st.techDone[ti] < 0) return `the ${TECHS[ti].name} technology was never invented`;
      const where = goal.system !== undefined ? `around ${goal.system === 0 ? 'the Sun' : e.world.systems[goal.system].name}` : 'anywhere';
      return `nobody began a swarm ${where}`;
    }
    case 'tech': {
      const i = goal.tech!;
      if (st.techProg[i] < 0) return `${TECHS[i].name} proved impossible in this future`;
      if (st.techProg[i] > 0) return `${TECHS[i].name} research got ${Math.min(99, Math.round((st.techProg[i] / (TECHS[i].cost * e.techCostMult[i])) * 100))}% of the way there`;
      return `${TECHS[i].name} was never invented`;
    }
    case 'metric': {
      const col = GM[goal.metric!];
      let m = 0;
      for (let i = 0; i <= st.step; i++) m = Math.max(m, e.series[i * NGM + col]);
      if (goal.metric === 'kardashev') return `civilisation peaked at Kardashev ${m.toFixed(2)}`;
      if (goal.metric === 'systems') return `settlement peaked at ${Math.round(m)} star systems`;
      return `population peaked at ${fmtPeople(Math.round(m))} people`;
    }
    case 'pop': return `${bName(goal.body!)} peaked at ${fmtPeople(Math.round(p.pop[goal.body!]))} people`;
    case 'event': return 'it never happened';
  }
}

export function compareFutures(chain: Chain, rs: FutureResult[]): { medianYear: number; minYear: number; maxYear: number; highlights: Map<number, string>; standouts: number[] } {
  const goal = chain.stages[chain.stages.length - 1][0];
  const got = rs.filter((r) => r.reached && r.year !== undefined);
  const years = got.map((r) => r.year!).sort((a, b) => a - b);
  const medianYear = years.length ? years[Math.floor((years.length - 1) / 2)] : 0;
  const highlights = new Map<number, string>();
  if (!got.length) return { medianYear, minYear: 0, maxYear: 0, highlights, standouts: [] };

  // candidate "how it differed" keys: each relevant tech's year, the goal body's founding, its city year
  interface Cand { key: string; name: string; year: number }
  const candOf = (r: FutureResult): Cand[] => {
    const out: Cand[] = Object.entries(r.techYears).map(([i, y]) => ({ key: `t${i}`, name: TECHS[Number(i)]?.name ?? 'a technology', year: y }));
    if (goal.body !== undefined && goal.body >= 0) {
      const mine = r.steps.filter((s) => s.body === goal.body);
      if (mine.length) out.push({ key: 'founded', name: 'the founding of the colony', year: mine[0].year });
      const city = mine.find((s) => /becomes a City/i.test(s.text));
      if (city) out.push({ key: 'city', name: 'the first city there', year: city.year });
    }
    return out;
  };
  const medians = new Map<string, number>();
  const lists = new Map<string, number[]>();
  for (const r of got) for (const c of candOf(r)) { const l = lists.get(c.key) ?? []; l.push(c.year); lists.set(c.key, l); }
  for (const [k, l] of lists) if (l.length >= 2) { l.sort((a, b) => a - b); medians.set(k, l[Math.floor((l.length - 1) / 2)]); }

  const devs: { seed: number; year: number; dev: number }[] = [];
  for (const r of got) {
    let best: Cand | null = null, bestDev = 0;
    for (const c of candOf(r)) {
      const m = medians.get(c.key);
      if (m === undefined) continue;
      const dev = c.year - m;
      if (Math.abs(dev) > Math.abs(bestDev)) { best = c; bestDev = dev; }
    }
    if (best && Math.abs(bestDev) >= 10) devs.push({ seed: r.seed, year: r.year!, dev: bestDev });
    let h = best && Math.abs(bestDev) >= 10 ? `${best.name} came ${Math.abs(bestDev)} years ${bestDev < 0 ? 'early' : 'late'} (${best.year})` : '';
    const trouble = r.steps.filter((s) => s.kind === 'era' || s.kind === 'war').filter((s) => /collapse|war|pandemic/i.test(s.text) && s.year >= (r.year ?? 0) - 100 && s.year <= (r.year ?? 0));
    const last = trouble[trouble.length - 1];
    if (last) {
      const eraM = /the (.*?) era begins/.exec(last.text);
      h += `${h ? ' — ' : ''}despite ${eraM ? `${article(eraM[1])} ${eraM[1]} era` : last.text} in ${last.year}`;
    }
    if (h) highlights.set(r.seed, h);
  }
  const standouts = devs.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev) || a.year - b.year).slice(0, 2).map((d) => d.seed);
  return { medianYear, minYear: years[0], maxYear: years[years.length - 1], highlights, standouts };
}

/** The futures a search plays: the first seed, then ((first + k·7919) mod 99991) + 1 for k = 1, 2, …
 *  A batch carries on from k0; seeds already used in the lineage (or repeated) are skipped. */
export function lineageSeeds(first: number, k0: number, n: number, used: ReadonlySet<number> = new Set()): { seeds: number[]; nextK: number } {
  const seeds: number[] = [];
  let k = k0;
  while (seeds.length < n) {
    const s = k === 0 ? first : ((first + k * 7919) % 99991) + 1;
    if (!used.has(s) && !seeds.includes(s)) seeds.push(s);
    k++;
  }
  return { seeds, nextK: k };
}

/** The futures the cards and the summary show when there are many: the first twelve,
 *  the middle one, the latest and the standouts — in year order. */
export function shownFutures(got: FutureResult[], medianYear: number, standouts: number[]): FutureResult[] {
  const keep = new Set<number>(got.slice(0, 12).map((r) => r.seed));
  const med = got.find((r) => r.year === medianYear);
  if (med) keep.add(med.seed);
  if (got.length) keep.add(got[got.length - 1].seed);
  for (const r of got) if (standouts.includes(r.seed)) keep.add(r.seed);
  return got.filter((r) => keep.has(r.seed));
}

// ------------------------------------------------------------------ narration

/** The one way a count is said, everywhere (panel, speech, Oracle): "6 futures from 16 simulated lead to …". */
export function countLine(x: number, y: number, label: string, o: { live?: boolean; near?: string } = {}): string {
  const one = x === 1;
  let s = `${x} ${one ? 'future' : 'futures'} from ${y} simulated${o.live ? ' so far' : ''} ${one ? 'leads' : 'lead'} to ${label}.`;
  if (x === 0 && !o.live && o.near) s += ` The closest: ${o.near}.`;
  return s;
}

/** The most futures a search simulates before giving up on finding n. */
export function searchLimit(n: number): number {
  return Math.min(400, Math.max(100, 10 * n));
}

/** An extension's hunt: "Found 3 other futures (from 16 more simulated)." */
/** An extension's hunt: "Found 3 other futures (from 16 more simulated)." */
export function huntLine(z: number, n: number, o: { live?: boolean } = {}): string {
  return `Found ${z} other ${z === 1 ? 'future' : 'futures'} (from ${n} more simulated${o.live ? ' so far' : ''}).`;
}

/** The row continues the last search: same tags and joints on the left, more on the right. */
export function isExtension(last: { ids: string[]; joints: Joint[] } | null, now: { ids: string[]; joints: Joint[] }): boolean {
  if (!last || now.ids.length <= last.ids.length) return false;
  for (let i = 0; i < last.ids.length; i++) if (now.ids[i] !== last.ids[i]) return false;
  for (let i = 0; i < last.joints.length; i++) if (now.joints[i] !== last.joints[i]) return false;
  return true;
}

/** Extending a chain: only futures that completed the old chain can complete the longer one — the rest drop as misses. */
export function narrowPlan(pool: FutureResult[]): { check: number[]; drop: number[] } {
  const check: number[] = [], drop: number[] = [];
  for (const r of pool) (r.reached ? check : drop).push(r.seed);
  return { check, drop };
}

/** The plain-text answer handed back to the conversational agent. */
export function toolSummary(chain: Chain, rs: FutureResult[], tried: number): string {
  const got = rs.filter((r) => r.reached && r.year !== undefined).sort((a, b) => a.year! - b.year!);
  const missed = rs.filter((r) => !r.reached);
  const near = missed.map((r) => r.progress).filter(Boolean)[0];
  const lines: string[] = [`Goal: ${chainLabel(chain)} (${chain.stages.flat().map((g) => g.detail).join('; ')}).`];
  const { medianYear, minYear, maxYear, highlights, standouts } = compareFutures(chain, rs);
  lines.push(countLine(got.length, tried, chainLabel(chain), { near }));
  if (got.length) {
    lines.push(`${minYear === maxYear ? `They got there in ${minYear}` : `They got there between ${minYear} and ${maxYear}`} (median ${medianYear}).${missed.length ? ` The others never did by 12040${near ? `; the closest: ${near}` : ''}.` : ''}`);
    for (const r of shownFutures(got, medianYear, standouts)) {
      const d = r.year! - medianYear;
      const delta = d === 0 ? 'at the median' : `${Math.abs(d)} years ${d < 0 ? 'before' : 'after'} the median`;
      const list = r.steps.length > 3
        ? `${r.steps[0].year} ${shortStep(r.steps[0])}; …; ${r.steps[r.steps.length - 1].year} ${shortStep(r.steps[r.steps.length - 1])}`
        : r.steps.map((s) => `${s.year} ${shortStep(s)}`).join('; ');
      const h = highlights.get(r.seed);
      lines.push(`Future ${r.seed}: ${r.year} (${delta}). Steps: ${list}.` + (h ? ` What set it apart: ${h}.` : ''));
    }
  }
  return lines.join('\n');
}

/** A step trimmed for the agent's summary: techs read as their name alone. */
function shortStep(s: Step): string {
  return s.tech !== undefined ? TECHS[s.tech].name : s.text;
}
