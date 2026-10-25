// "What leads to…?" — the grammar that turns "colonisation of Mars" into a
// goal, a cheap check that watches a running future for it, and the reading of
// a finished run's event log into the road that got there. Pure: no DOM, no
// timers — it runs the same in the page, in a worker, and in node.

import { YEAR0, type Engine, type SimEvent } from './engine.ts';
import { ERAS, EV, STAGE, STAGE_NAMES, TECHS, isAlive } from './catalog.ts';
import { F, GM, NF, NGM } from './metrics.ts';
import { GF, Geo, NGEO } from './geo.ts';
import type { World } from './world.ts';
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
}

export type ParseResult = { goal: Goal } | { error: string; suggestions: string[] };

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

interface Place { body?: number; system?: number }

function normName(s: string): string { return s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim(); }

/** The longest body or system name found in the text; bodies win over their own system ("Tau Ceti e" > "Tau Ceti"). */
function findPlace(t: string, world: World): Place | null {
  let best: Place | null = null, bestLen = 0;
  const test = (name: string, p: Place) => {
    const n = normName(name);
    if (n.length > bestLen && t.includes(` ${n} `)) { best = p; bestLen = n.length; }
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
  [/\bcoloni[sz]|\bcolon(y|ies|ists?)\b|\bsettl/, STAGE.COLONY],
  [/\boutposts?\b|\bland(ing|ed|s)?\b|\bboots on\b|\bfoot( |)print|first (foot|steps?)\b/, STAGE.OUTPOST],
];

export function parseGoal(text: string, world: World): ParseResult {
  const fail = (error: string): ParseResult => ({ error, suggestions: [...SUGGESTIONS] });
  const pre = text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.,\s]/g, ' ');
  const t = ` ${wordsToNumbers(pre).replace(/\s+/g, ' ').trim()} `;
  const place = findPlace(t, world);
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
  if (stage >= 0) {
    if (place) {
      const label = stageLabel(world, place, stage);
      const who = place.body !== undefined ? bName(place.body) : `a world in ${sName(place.system!)}`;
      return { goal: { id: `stage:${stage}:${place.body ?? 'sys' + place.system}`, label, detail: `${who} becomes ${article(STAGE_NAMES[stage])} ${STAGE_NAMES[stage]}: ${STAGE_DETAIL[stage] ?? ''}`, kind: 'stage', body: place.body, system: place.system, stage } };
    }
    // "colonise another star" means leaving the Solar System
    if (stage === STAGE.COLONY && /another star|interstellar|exoplanet|beyond (the )?solar system|other stars|extrasolar|alien (world|planet)/.test(t)) {
      return { goal: { id: 'metric:systems:2', label: 'the first settlement around another star', detail: 'settlements in two star systems (Sol plus one more)', kind: 'metric', metric: 'systems', threshold: 2 } };
    }
    return { goal: { id: `stage:${stage}:any`, label: stageLabel(world, null, stage), detail: `any settlement becomes ${article(STAGE_NAMES[stage])} ${STAGE_NAMES[stage]}: ${STAGE_DETAIL[stage] ?? ''}`, kind: 'stage', body: -1, stage } };
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

// ------------------------------------------------------------------ watching a run

/** The bodies a stage/pop goal can land on. */
function goalBodies(goal: Goal, world: World): number[] {
  if (goal.body !== undefined && goal.body >= 0) return [goal.body];
  if (goal.body === -1) return world.bodies.map((b) => b.id);
  if (goal.system !== undefined) return world.systems[goal.system].bodies;
  return [];
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

const evMark = new WeakMap<Engine, number>();
/** Scan only events logged since the last check on this engine. */
function eventArrived(e: Engine, match: (ev: SimEvent) => boolean): boolean {
  const evs = e.events;
  const from = evMark.get(e) ?? 0;
  for (let i = from; i < evs.length; i++) {
    if (match(evs[i])) { evMark.set(e, i + 1); return true; }
  }
  evMark.set(e, evs.length);
  return false;
}

function eventMatch(goal: Goal, ev: SimEvent): boolean {
  if (ev.type !== goal.event) return false;
  return goal.body === undefined || ev.body === goal.body;
}

/** Called after every step: has this future reached the goal yet? */
export function reached(goal: Goal, e: Engine): boolean {
  trackPeaks(e);
  const st = e.st, S = st.S;
  switch (goal.kind) {
    case 'stage': {
      for (const b of goalBodies(goal, e.world)) {
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
    case 'event': return eventArrived(e, (ev) => eventMatch(goal, ev));
  }
}

// ------------------------------------------------------------------ reading the road

const byName = (e: Engine, b: number) => e.world.bodies[b]?.name ?? 'somewhere';
const sysOf = (e: Engine, b: number) => e.world.systems[e.world.bodies[b]?.system ?? 0]?.name ?? 'somewhere';

/** The sim year the goal was hit (as close as the record allows). */
function goalYear(goal: Goal, e: Engine): number {
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
    case 'stage': return goal.stage === STAGE.UPLOADED ? `${bn} is uploaded` : `${bn} becomes ${article(STAGE_NAMES[goal.stage!])} ${STAGE_NAMES[goal.stage!]}`;
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

/** The steps that led to the goal, sorted by year, the goal itself last. At most 12. */
export function pathOf(goal: Goal, e: Engine): Step[] {
  const st = e.st, goalSim = goalYear(goal, e), goalCal = YEAR0 + goalSim;
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
  year?: number;          // calendar year the goal was hit
  step: number;           // engine step at that moment
  steps: Step[];
  progress?: string;      // how close a miss came
  stats: { pop: number; systems: number; kardashev: number; era: string };
  techYears: Record<number, number>;
  spark: { years: Float64Array; pop: Float64Array };
}

/** Wrap up a finished (or stopped-at-the-goal) engine into a FutureResult. */
export function resultOf(goal: Goal, e: Engine, hit: boolean): FutureResult {
  const st = e.st, row = st.step * NGM;
  const n = st.step + 1;
  const years = new Float64Array(n), pop = new Float64Array(n);
  for (let i = 0; i < n; i++) { years[i] = YEAR0 + e.years[i]; pop[i] = e.series[i * NGM + GM.pop]; }
  const goalSim = hit ? goalYear(goal, e) : 0;
  const R = relevantTechs(goal, e, hit ? goalSim : e.year);
  const techYears: Record<number, number> = {};
  for (const i of R) if (st.techDone[i] >= 0 && (!hit || st.techDone[i] <= goalSim)) techYears[i] = YEAR0 + st.techDone[i];
  return {
    seed: e.seed,
    reached: hit,
    year: hit ? YEAR0 + goalSim : undefined,
    step: st.step,
    steps: hit ? pathOf(goal, e) : [],
    progress: hit ? undefined : progress(goal, e),
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

export function compareFutures(goal: Goal, rs: FutureResult[]): { medianYear: number; minYear: number; maxYear: number; highlights: Map<number, string> } {
  const got = rs.filter((r) => r.reached && r.year !== undefined);
  const years = got.map((r) => r.year!).sort((a, b) => a - b);
  const medianYear = years.length ? years[Math.floor((years.length - 1) / 2)] : 0;
  const highlights = new Map<number, string>();
  if (!got.length) return { medianYear, minYear: 0, maxYear: 0, highlights };

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

  for (const r of got) {
    let best: Cand | null = null, bestDev = 0;
    for (const c of candOf(r)) {
      const m = medians.get(c.key);
      if (m === undefined) continue;
      const dev = c.year - m;
      if (Math.abs(dev) > Math.abs(bestDev)) { best = c; bestDev = dev; }
    }
    let h = best && Math.abs(bestDev) >= 10 ? `${best.name} came ${Math.abs(bestDev)} years ${bestDev < 0 ? 'early' : 'late'} (${best.year})` : '';
    const trouble = r.steps.filter((s) => s.kind === 'era' || s.kind === 'war').filter((s) => /collapse|war|pandemic/i.test(s.text) && s.year >= (r.year ?? 0) - 100 && s.year <= (r.year ?? 0));
    const last = trouble[trouble.length - 1];
    if (last) {
      const eraM = /the (.*?) era begins/.exec(last.text);
      h += `${h ? ' — ' : ''}despite ${eraM ? `${article(eraM[1])} ${eraM[1]} era` : last.text} in ${last.year}`;
    }
    if (h) highlights.set(r.seed, h);
  }
  return { medianYear, minYear: years[0], maxYear: years[years.length - 1], highlights };
}

// ------------------------------------------------------------------ narration

/** Two or three sentences on the whole set of futures, for speech. */
export function narrateOverview(goal: Goal, rs: FutureResult[], tried: number): string {
  const got = rs.filter((r) => r.reached && r.year !== undefined);
  if (!got.length) {
    const near = rs.map((r) => r.progress).filter(Boolean)[0];
    return `None of the ${tried} futures I ran reached ${goal.label}.${near ? ` The closest: ${near}.` : ''}`;
  }
  const { medianYear, minYear, maxYear, highlights } = compareFutures(goal, rs);
  const spread = minYear === maxYear ? `all of them in ${minYear}` : `between ${minYear} and ${maxYear}, the middle future in ${medianYear}`;
  let s = `${got.length} of ${tried} futures reach ${goal.label}, ${spread}.`;
  const withH = got.find((r) => highlights.get(r.seed));
  if (withH) s += ` One stands out: future ${withH.seed}, where ${highlights.get(withH.seed)!}.`;
  const missed = tried - got.length;
  if (missed > 0) {
    const near = rs.filter((r) => !r.reached).map((r) => r.progress).filter(Boolean)[0];
    s += ` ${missed} never got there${near ? ` — the closest: ${near}` : ''}.`;
  }
  return s;
}

/** Two to four sentences on one future's road. */
export function narrateFuture(goal: Goal, r: FutureResult, highlight?: string): string {
  if (!r.reached || r.year === undefined) return `Future ${r.seed} never reaches ${goal.label}.${r.progress ? ` ${r.progress}.` : ''}`;
  let s = `Future ${r.seed} reaches ${goal.label} in ${r.year}.`;
  const gotMedian = r.steps.filter((x) => x.kind !== 'goal');
  if (highlight) s += ` ${highlight.charAt(0).toUpperCase()}${highlight.slice(1)}.`;
  if (gotMedian.length) {
    const first = gotMedian[0], last = gotMedian[gotMedian.length - 1];
    s += ` The road runs from "${first.text}" in ${first.year} to "${last.text}" in ${last.year}.`;
  }
  return s;
}

/** The plain-text answer handed back to the conversational agent. */
export function toolSummary(goal: Goal, rs: FutureResult[], tried: number): string {
  const got = rs.filter((r) => r.reached && r.year !== undefined).sort((a, b) => a.year! - b.year!);
  const lines: string[] = [`Goal: ${goal.label} (${goal.detail}).`];
  const { medianYear, minYear, maxYear, highlights } = compareFutures(goal, rs);
  if (got.length) {
    let l = `${got.length} of ${tried} futures reached it, ${minYear === maxYear ? `in ${minYear}` : `between ${minYear} and ${maxYear}`} (median ${medianYear}).`;
    const missed = rs.filter((r) => !r.reached);
    if (missed.length) {
      const near = missed.map((r) => r.progress).filter(Boolean)[0];
      l += ` ${missed.length} never did by 12040${near ? `; the closest: ${near}` : ''}.`;
    }
    lines.push(l);
    for (const r of got) {
      const d = r.year! - medianYear;
      const delta = d === 0 ? 'at the median' : `${Math.abs(d)} years ${d < 0 ? 'before' : 'after'} the median`;
      const list = r.steps.length > 3
        ? `${r.steps[0].year} ${shortStep(r.steps[0])}; …; ${r.steps[r.steps.length - 1].year} ${shortStep(r.steps[r.steps.length - 1])}`
        : r.steps.map((s) => `${s.year} ${shortStep(s)}`).join('; ');
      const h = highlights.get(r.seed);
      lines.push(`Future ${r.seed}: ${r.year} (${delta}). Steps: ${list}.` + (h ? ` What set it apart: ${h}.` : ''));
    }
  } else {
    const near = rs.map((r) => r.progress).filter(Boolean);
    lines.push(`None of the ${tried} futures tried reached it by 12040.${near.length ? ` The closest: ${near[0]}.` : ''}`);
  }
  return lines.join('\n');
}

/** A step trimmed for the agent's summary: techs read as their name alone. */
function shortStep(s: Step): string {
  return s.tech !== undefined ? TECHS[s.tech].name : s.text;
}
