// Notables and the Chronicle. Every major event gets the people who were
// there: the inventor of a technology is an adult who lived in that lab's
// settlement that year; a captain is someone actually aboard that ship; a
// founder is a member of the founding crew. They are picked deterministically
// from the census, so the same future always names the same people, and their
// biographies mention what they did.

import { ERAS, EV, TECHS } from './catalog.ts';
import { GC, NGC } from './engine.ts';
import { EFFECTS, FIELDS, effectText, inventionName } from './invent.ts';
import { periodMid, type Id } from './demography.ts';
import type { Engine, SimEvent } from './engine.ts';
import { FLOW, isShipBody, periodOf } from './ledger.ts';
import type { Lives } from './lives.ts';
import { hash01 } from './rng.ts';
import { FAITH_CAUSE, FC, GRIEV, HG, NFC, NPC, NWC, OUTCOME, PC, REGIME, TENET_TEXT, WAR_CAUSE, WAR_KIND, WC } from './civ.ts';
import { POLITY_FORMS, REGIME_NAMES, megatons } from './polity.ts';

export type Seg = string | { t: string; kind: 'person' | 'body'; id: string | number };
export interface Entry { year: number; type: number; segs: Seg[]; people: string[]; places: number[]; weight: number }

const MAJOR = new Set([
  EV.Technology, EV['Colony founded'], EV['Ship launched'], EV['Ship arrived'], EV['Ship lost'], EV.Independence, EV.War,
  EV['New faith'], EV.Speciation, EV['Megastructure complete'], EV['Era change'], EV['First contact'], EV['Dark forest strike'],
  EV['Gamma-ray burst'], EV.Supernova, EV.Plague, EV['Asteroid strike'], EV.Collapse, EV['Mutiny in transit'], EV['AI schism'], EV['Kessler cascade'],
  EV.Invention, EV['No-go theorem'], EV.Schism, EV['Faith extinct'], EV['Faith spreads'], EV.Treaty, EV['Kinetic strike'], EV['Regime change'],
]);
const WEIGHT: Partial<Record<number, number>> = {
  [EV['First contact']]: 10, [EV['Dark forest strike']]: 10, [EV['Gamma-ray burst']]: 8, [EV.Supernova]: 8, [EV.Technology]: 7,
  [EV.Speciation]: 6, [EV.Independence]: 6, [EV.War]: 5, [EV['Colony founded']]: 5, [EV['Megastructure complete']]: 5,
  [EV['No-go theorem']]: 6, [EV.Invention]: 2, [EV['Ship launched']]: 3, [EV['Ship arrived']]: 4, [EV['Ship lost']]: 4, [EV['New faith']]: 3, [EV.Schism]: 3, [EV.Treaty]: 4, [EV['Kinetic strike']]: 8, [EV['Regime change']]: 3, [EV['Faith extinct']]: 3, [EV['Faith spreads']]: 2, [EV['Era change']]: 4, [EV.Plague]: 2,
};
const FAITH_FORM = ['the {X} Way', 'the Church of {X}', 'the {X} Covenant', 'the Fellowship of {X}', 'the {X} Reckoning', 'the Quiet of {X}', 'the {X} Return'];
const SCHISM_FORM = ['the {X} Reform', 'the {X} Dissent', 'the Remnant of {X}', 'the {X} Awakening', 'the True {X}'];

const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth'];
export const ordinal = (n: number) => ORD[n - 1] ?? `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const money = (x: number) => x >= 1e15 ? `$${(x / 1e15).toFixed(1)} quadrillion` : x >= 1e12 ? `$${(x / 1e12).toFixed(1)} trillion` : `$${(x / 1e9).toFixed(1)} billion`;
const headcount = (x: number) => x >= 1e9 ? `${(x / 1e9).toFixed(1)} billion` : x >= 1e6 ? `${(x / 1e6).toFixed(1)} million` : x >= 1e4 ? `${Math.round(x / 1e3)} thousand` : `${Math.round(x)}`;

/** "that the body is a draft, that Earth is a myth, and that machines are kin" */
export function tenetClause(t: (axis: number) => number, only?: number): string {
  const parts: string[] = [];
  for (let a = 0; a < 5; a++) { if (only !== undefined && a !== only) continue; const v = t(a); if (v) parts.push(`that ${TENET_TEXT[a][v > 0 ? 0 : 1]}`); }
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** what a regime's leader is called */
const TITLE = ['First Minister', 'Speaker', 'General', 'High Elder', 'Chair', 'Chief Forecaster', 'Steward', 'Chair of the Emergency Committee'];
/** why a regime came, in the words of the numbers that called for it */
const REGIME_WHY = [
  'the old emergency powers lapse and elections return',
  'the place is small and calm enough for every citizen to vote on everything',
  'inequality is high, the guns are out, and order is promised',
  'one faith now holds most hearts, and its elders take the chair',
  'a few families own most of the habitat, and now they own the government',
  'the predictive models have been right too often to ignore',
  'most of its minds now run on machines, and they vote continuously',
  'stability has collapsed and nothing else is left standing',
];
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** which kinds of event can give each era its name */
const AGE_FITS: Set<number>[] = [
  new Set([EV.Technology, EV['Megastructure complete'], EV.Independence, EV['Faith spreads'], EV.Speciation, EV['First contact']]),
  new Set([EV.Independence, EV['Regime change'], EV.Technology, EV['Faith spreads'], EV['Megastructure complete']]),
  new Set([EV.Technology, EV['Megastructure complete'], EV['Faith spreads'], EV['First contact'], EV.Speciation, EV['New faith']]),
  new Set([EV['Regime change'], EV.Schism, EV['No-go theorem'], EV['Faith spreads']]),
  new Set([EV.War, EV['Kinetic strike'], EV.Independence, EV['Regime change']]),
  new Set([EV.Plague]),
  new Set([EV.Collapse, EV.War, EV.Plague, EV['Kinetic strike'], EV['Gamma-ray burst'], EV.Supernova, EV['Dark forest strike'], EV['AI schism']]),
  new Set([EV.Technology, EV['Megastructure complete'], EV['New faith'], EV['Faith spreads'], EV['First contact']]),
];

export interface Age { from: number; to: number; era: number; name: string; event: number }
export interface Annals {
  ages: Age[];
  faiths: { id: number; name: string; tenets: string; home: number; founded: number; ended: number | null; peakWorlds: number; parent: number }[];
  polities: { id: number; name: string; capital: number; founded: number; ended: number | null; from: number; grievance: string; regime: string; regimes: { year: number; regime: string }[]; wars: number; peakPop: number; peakWorlds: number }[];
  wars: { id: number; name: string; a: number; b: number; polityA: number; polityB: number; start: number; end: number; cause: string; outcome: string; winner: number; killed: number; kinetic: boolean }[];
}

export class Chronicle {
  private e: Engine;
  private L: Lives;
  private cache = new Map<number, Entry | null>();
  private major: number[] = [];
  private genEvent = new Map<number, number>(); // generated invention → its event index
  private genNames = new Map<number, string>();
  private faithEvent = new Map<number, number>(); // faith id → its founding (or schism) event index
  private warNames: string[] = [];
  private warEvent = new Map<number, number>();                 // war log row → "the Third TRAPPIST War"

  constructor(e: Engine, lives: Lives) {
    this.e = e; this.L = lives;
    // wars are named after where they were fought, and numbered: the Third TRAPPIST War
    const X = e.st.hx, count = new Map<string, number>();
    for (let w = 0; w < X.hg[HG.nWar]; w++) {
      const o = w * NWC, kin = X.war[o + WC.kind] === WAR_KIND.KINETIC;
      const sys = e.world.systems[X.war[o + WC.sys]];
      const short = (n: string) => n.replace(/[- ]?(\d+|[A-C])$/, '').replace(/^Sol$/, 'Solar');
      const base = kin ? `${short(e.world.systems[X.war[o + WC.from]].name)}–${short(sys.name)} Kinetic War`
        : sys.id === 0 ? `${e.world.bodies[X.war[o + WC.target]].name} War` : `${short(sys.name)} War`;
      const k = (count.get(base) ?? 0) + 1;
      count.set(base, k);
      this.warNames.push(`the ${ordinal(k)} ${base}`);
    }
    e.events.forEach((ev, i) => {
      if (ev.type === EV.Invention) this.genEvent.set(ev.a, i);
      if (ev.type === EV['New faith'] || ev.type === EV.Schism) this.faithEvent.set(ev.a, i);
      if (ev.type === EV.War) this.warEvent.set(ev.b, i);
      if (!MAJOR.has(ev.type)) return;
      if (ev.type === EV.Plague && ev.a < 0.08) return;
      this.major.push(i);
    });
  }

  private name(b: number): string { return this.L.placeName(b); }
  private place(b: number): Seg { return isShipBody(b) || b < 0 ? this.name(b) : { t: this.name(b), kind: 'body', id: b }; }
  /** A side in a war: its polity's name, linked to its capital. */
  private side(f: number, p: number, places: number[]): Seg {
    places.push(f);
    return { t: p >= 0 ? this.polityName(p) : this.name(f), kind: 'body', id: f };
  }
  private person(id: Id | null): Seg { return id ? { t: this.L.name(id), kind: 'person', id: `${id.b}.${id.q}.${id.i}` } : 'someone whose name was lost'; }

  /** An adult living at b in that year, chosen by hash; null if nobody fits. */
  pick(b: number, year: number, salt: number, minAge = 22, maxAge = 75): Id | null {
    if (b < 0 || isShipBody(b)) return null;
    return this.L.pickResident(b, year, salt, minAge, maxAge);
  }

  /** Someone aboard ledger flow `flow` (crew, ship, landing party), adult if possible. */
  private aboard(flow: number, salt: number): Id | null { return this.L.pickTraveller(flow, salt); }

  /** The name of faith f from the faith table: a word in its founding world's tongue. */
  faithName(f: number): string {
    const T = this.e.st.hx.faith, o = f * NFC;
    const home = T[o + FC.home];
    // a schism keeps its mother faith's word, so a family of faiths reads as one
    let r = f;
    for (let k = 0; k < 40 && T[r * NFC + FC.parent] >= 0; k++) r = T[r * NFC + FC.parent];
    const root = this.L.coinedWord(T[r * NFC + FC.home], r + 7);
    if (T[o + FC.parent] >= 0) return SCHISM_FORM[Math.floor(hash01(home, f, 19) * SCHISM_FORM.length)].replace('{X}', root);
    return FAITH_FORM[Math.floor(hash01(home, f, 17) * FAITH_FORM.length)].replace('{X}', root);
  }
  tenetsOf(f: number): string { const T = this.e.st.hx.faith; return tenetClause((a) => T[f * NFC + FC.t + a]); }
  /** The prophet who founded faith f (or led its schism), as the Chronicle names them. */
  faithFounder(f: number): Id | null {
    const i = this.faithEvent.get(f);
    if (i === undefined) return null;
    const ev = this.e.events[i];
    return this.pick(ev.body, ev.year, i, 18, 60);
  }

  warName(w: number): string { return this.warNames[w] ?? 'the war'; }

  // ---------------------------------------------------------------- ages

  private agesMemo: Age[] | null = null;
  /** A noun phrase for what event i is remembered as, or null if it does not name an age. */
  private subject(i: number): string | null {
    const ev = this.e.events[i], W = this.e.st.hx.war;
    switch (ev.type) {
      case EV.War: return this.warName(ev.b);
      case EV['Kinetic strike']: return `the strike on ${this.name(ev.body)}`;
      case EV.Technology: return TECHS[ev.a].name;
      case EV.Independence: return ev.b >= 0 && ev.b < this.e.st.hx.hg[HG.nPol] ? this.polityName(ev.b) : `the ${this.name(ev.body)} secession`;
      case EV['Regime change']: return `the ${this.name(ev.body)} ${REGIME_NAMES[ev.b % 16].toLowerCase()}`;
      case EV['New faith']: case EV.Schism: return this.faithName(ev.a);
      case EV['Faith spreads']: return this.faithName(ev.a);
      case EV.Plague: return `the plague on ${this.name(ev.body)}`;
      case EV.Speciation: return `the ${this.name(ev.body)} divergence`;
      case EV['Megastructure complete']: return `the ${this.name(ev.body)} megastructure`;
      case EV['First contact']: return 'the Signal';
      case EV['Dark forest strike']: return `the erasure of ${this.e.world.systems[this.e.world.bodies[ev.body].system].name}`;
      case EV['Gamma-ray burst']: case EV.Supernova: return `the burst over ${this.name(ev.body)}`;
      case EV.Collapse: return `the fall of ${this.name(ev.body)}`;
      case EV['No-go theorem']: return `the ${TECHS[ev.a].name} theorem`;
      default: void W; return null;
    }
  }
  /** How much event i matters for naming an age: its weight, raised by how many it killed or reached. */
  private gravity(i: number): number {
    const ev = this.e.events[i];
    if (ev.type === EV['Era change'] || ev.type === EV.Invention || ev.type === EV['Colony founded'] || ev.type === EV['Ship launched'] || ev.type === EV['Ship arrived'] || ev.type === EV['Ship lost'] || ev.type === EV.Treaty || ev.type === EV['Faith extinct'] || ev.type === EV['Mutiny in transit']) return 0;
    let g = WEIGHT[ev.type] ?? 1;
    const sol = ev.body >= 0 && this.e.world.bodies[ev.body]?.system === 0;
    const pop = (p: number) => Math.max(0, Math.log10(1 + this.e.st.hx.pol[p * NPC + PC.peakPop]) - 6);
    if (ev.type === EV.War) g += Math.log10(1 + this.e.st.hx.war[ev.b * NWC + WC.killed]) / 2;
    if (ev.type === EV.Plague) g += ev.a * 10;
    if (ev.type === EV['Faith spreads']) g += ev.b / 10;
    if (ev.type === EV.Speciation || ev.type === EV['Megastructure complete']) g = sol ? 4 : 3;
    if (ev.type === EV.Independence && ev.b >= 0) g += pop(ev.b) / 1.5;
    if (ev.type === EV['Regime change']) g += pop(ev.a) / 2;
    if (ev.body === this.e.world.earth) g += 0.5;
    return g;
  }
  /** The ages of this future: each era span, named after the biggest thing in it (or in the one before). */
  ages(): Age[] {
    if (this.agesMemo) return this.agesMemo;
    const ev = this.e.events, spans: { from: number; era: number; start: number }[] = [{ from: 0, era: 0, start: 0 }];
    ev.forEach((x, i) => { if (x.type === EV['Era change']) spans.push({ from: x.year, era: x.a, start: i }); });
    const out: Age[] = [];
    let prev: string | null = null, k = 0;
    for (let s = 0; s < spans.length; s++) {
      const to = s + 1 < spans.length ? spans[s + 1].from : this.e.years[this.e.years.length - 1];
      const end = s + 1 < spans.length ? spans[s + 1].start : ev.length;
      let best = -1, bg = 0;
      const wars = new Map<string, number>();
      const fits = AGE_FITS[spans[s].era];
      for (k = spans[s].start; k < end; k++) {
        if (!MAJOR.has(ev[k].type)) continue;
        const g = this.gravity(k) * (fits.has(ev[k].type) ? 1 : 0.25);
        if (ev[k].type === EV.War) { const base = this.warName(ev[k].b).replace(/^the \S+ /, ''); wars.set(base, (wars.get(base) ?? 0) + 1); }
        if (g > bg) { bg = g; best = k; }
      }
      const subj = best >= 0 ? this.subject(best) : null;
      const era = spans[s].era;
      let name: string;
      const many = [...wars.entries()].sort((a, b) => b[1] - a[1])[0];
      if (era === 4 && many && many[1] > 1) name = `the ${many[0].replace(/War$/, 'Wars')}`;
      else if (era === 4 && subj && best >= 0 && fits.has(ev[best].type)) name = `the years of ${subj}`;
      else if (era === 4) name = prev ? `the War Scare after ${prev}` : 'the War Scare';
      else if (era === 3) name = prev ? `the Long Quiet after ${prev}` : 'the Long Quiet';
      else if (era === 1) name = prev ? `the Settling after ${prev}` : 'the Settling';
      else if (era === 6) name = subj && best >= 0 && (ev[best].type === EV.Collapse || ev[best].type === EV.War) ? `the Dark of ${subj}` : prev ? `the Dark after ${prev}` : 'the Dark';
      else if (era === 5) name = best >= 0 && ev[best].type === EV.Plague ? `the Sickness of ${this.name(ev[best].body)}` : prev ? `the Sickness after ${prev}` : 'the Sickness';
      else if (era === 2) name = subj && fits.has(ev[best].type) ? `the Golden Age of ${subj}` : prev ? `the Golden Age after ${prev}` : 'the Golden Age';
      else if (era === 7) name = best >= 0 && ev[best].body >= 0 ? `the ${this.name(ev[best].body)} Renaissance` : 'the Renaissance';
      else name = subj && fits.has(ev[best].type) ? `the Age of ${subj}` : prev ? `the Expansion after ${prev}` : 'the Expansion';
      out.push({ from: spans[s].from, to, era, name, event: best });
      if (subj && bg >= 3) prev = subj;
    }
    return (this.agesMemo = out);
  }
  /** The age a year falls in. */
  ageAt(year: number): Age | null {
    const A = this.ages();
    let lo = 0, hi = A.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (A[m].from <= year) lo = m; else hi = m - 1; }
    return A[lo] ?? null;
  }

  /** "Free Ceres", "the Ysolei Compact", "the Federated States of Earth". */
  polityName(p: number): string {
    const P = this.e.st.hx.pol, o = p * NPC;
    if (p < 0) return 'nobody';
    const capB = P[o + PC.cap];
    if (capB === this.e.world.earth && P[o + PC.griev] === GRIEV.NONE) return 'the Federated States of Earth';
    return POLITY_FORMS[P[o + PC.form]].replace('{B}', this.name(capB)).replace('{X}', this.L.coinedWord(capB, p + 11));
  }
  /** The polity that held faction f in a year (the row its capital had then). */
  polityAt(f: number, year: number): number {
    const P = this.e.st.hx.pol;
    let best = -1;
    for (let p = 0; p < this.e.st.hx.hg[HG.nPol]; p++) if (P[p * NPC + PC.cap] === f && P[p * NPC + PC.year] <= year && (!P[p * NPC + PC.end] || P[p * NPC + PC.end] >= year || P[p * NPC + PC.alive])) best = p;
    return best;
  }

  /** Name of a technology: spine techs by catalog, generated ones after their inventor and place. */
  techName(t: number): string {
    if (t < TECHS.length) return TECHS[t].name;
    const k = t - TECHS.length;
    const got = this.genNames.get(k);
    if (got) return got;
    const i = this.genEvent.get(k);
    const ev = i !== undefined ? this.e.events[i] : null;
    const g = this.e.st.gen, o = k * NGC;
    const inv = ev ? this.pick(ev.body, ev.year, i! * 7 + 5, 24, 85) : null;
    const name = inventionName(k * 31 + this.e.seed, FIELDS[g[o + GC.field]], FIELDS[g[o + GC.other]], inv ? this.L.surname(inv) : this.L.coinedWord(Math.max(0, ev?.body ?? 0), k), ev ? this.name(ev.body) : 'Earth');
    this.genNames.set(k, name);
    return name;
  }

  entry(i: number): Entry | null {
    if (this.cache.has(i)) return this.cache.get(i)!;
    const ev = this.e.events[i];
    const out = this.build(i, ev);
    this.cache.set(i, out);
    return out;
  }

  private build(i: number, ev: SimEvent): Entry | null {
    const y = ev.year, segs: Seg[] = [], people: string[] = [], places: number[] = [];
    const who = (id: Id | null) => { if (id) people.push(`${id.b}.${id.q}.${id.i}`); return this.person(id); };
    const at = (b: number) => { if (b >= 0) places.push(b); return this.place(b); };
    switch (ev.type) {
      case EV.Technology: {
        const t = TECHS[ev.a];
        const inv = this.pick(ev.body, y, i * 7 + 1, 24, 80);
        segs.push(who(inv), ' of ', at(ev.body), ` invents ${t.name.toLowerCase()}. ${t.blurb}`);
        if (ev.b >= 0) {
          const twin = this.pick(ev.b, y, i * 7 + 2, 24, 80);
          const dispute = hash01(i, 3) < 0.33;
          segs.push(' The same year, working independently on ', at(ev.b), ', ', who(twin), dispute ? ' gets there too, and the argument over who was first outlives them both.' : ' arrives at the same result.');
        }
        break;
      }
      case EV.Invention: {
        const k = ev.a, g = this.e.st.gen, o = k * NGC;
        const inv = this.pick(ev.body, y, i * 7 + 5, 24, 85);
        const big = ev.b > 3.2;
        segs.push(big ? 'A breakthrough: ' : '', who(inv), ' of ', at(ev.body), ` builds the ${this.techName(TECHS.length + k)}, crossing ${this.techName(g[o + GC.a])} with ${this.techName(g[o + GC.b])}: ${effectText(EFFECTS[g[o + GC.key]], g[o + GC.size])}.`);
        const en = { year: y, type: ev.type, segs, people, places, weight: big ? 4 : 2 };
        return en;
      }
      case EV['No-go theorem']: {
        const prover = this.pick(ev.body, y, i, 25, 90);
        segs.push(who(prover), ' of ', at(ev.body), ` proves that ${TECHS[ev.a].name.toLowerCase()} is impossible in this universe. Generations of effort end in a theorem.`);
        break;
      }
      case EV['Colony founded']: {
        if (ev.b === 1) return null; // the ship's arrival tells this one
        const f = this.L.crewFlow(ev.a, ev.body, y);
        const lead = f !== null ? this.aboard(f, i) : null;
        const n = f !== null ? this.e.ledger!.flows[f].n : 0;
        segs.push(who(lead), ` leads ${n ? `a crew of ${n}` : 'a crew'} from `, at(ev.a), ' to found the first outpost on ', at(ev.body), '.');
        break;
      }
      case EV['Ship launched']: {
        const f = this.L.shipFlow(ev.b), v = this.L.voyage(ev.b);
        if (f === null || !v) return null;
        const fl = this.e.ledger!.flows[f];
        const captain = this.aboard(f, i);
        const dist = this.L.distanceLy(ev.body, ev.a);
        segs.push(`The ${this.L.shipName(fl)} leaves `, at(ev.body), ' for ', at(ev.a), `, ${dist.toFixed(1)} light years away, with ${v.n.toLocaleString('en-US')} aboard. Captain: `, who(captain), `. Expected voyage: ${Math.round(v.arrive - v.depart)} years${v.generation ? '; those who arrive will be their grandchildren' : ''}.`);
        break;
      }
      case EV['Ship arrived']: {
        const f = this.L.shipFlow(ev.b), v = this.L.voyage(ev.b);
        if (f === null || !v) return null;
        const fl = this.e.ledger!.flows[f];
        const land = this.L.landingFlow(ev.b);
        const first = land !== null ? this.aboard(land, i) : this.aboard(f, i + 1);
        const gens = Math.max(0, Math.round((v.arrive - v.depart) / 28));
        segs.push(`The ${this.L.shipName(fl)} reaches `, at(ev.body), ` after ${Math.round(v.arrive - v.depart)} years${gens > 1 ? `, ${gens} generations after leaving ` : ' out of '}`, at(ev.a), '. First to step off: ', who(first), '.');
        break;
      }
      case EV['Ship lost']: {
        const f = this.L.shipFlow(ev.b), v = this.L.voyage(ev.b);
        if (f === null || !v) return null;
        const fl = this.e.ledger!.flows[f];
        segs.push(`The ${this.L.shipName(fl)}, bound from `, at(ev.a), ' to ', at(ev.body), `, is never heard from again. ${v.n.toLocaleString('en-US')} people had boarded, under captain `, who(this.aboard(f, i)), '.');
        break;
      }
      case EV.Independence: {
        const lead = this.pick(ev.body, y, i, 25, 70);
        const P = this.e.st.hx.pol, p = ev.b, o = p * NPC;
        if (p === undefined || p < 0 || !(p < this.e.st.hx.hg[HG.nPol])) {
          segs.push(at(ev.body), ' declares independence from ', at(ev.a), '. The declaration is read by ', who(lead), '.');
          break;
        }
        const g = P[o + PC.griev], v = P[o + PC.gval];
        const why = g === GRIEV.LAG ? `A question sent to ${this.name(ev.a)} takes ${(2 * v).toFixed(1)} years to be answered, and nobody there has ever seen ${this.name(ev.body)}'s sky.`
          : g === GRIEV.TAXES ? `The grievance is money: the richest tenth hold far more than their share (inequality ${pct(v)}), and the tithe to ${this.name(ev.a)} is paid by everyone else.`
          : g === GRIEV.FAITH && v >= 0 ? `Most here follow ${this.faithName(v)}, and ${this.name(ev.a)} does not.`
          : g === GRIEV.SIZE ? `It has outgrown being ruled from elsewhere: ${v >= 1 ? `it now has ${v.toFixed(1)} times as many people as ${this.name(ev.a)}` : `it has ${pct(v)} as many people as ${this.name(ev.a)}`}.`
          : `After years of disorder (stability ${pct(v)}), people stop believing ${this.name(ev.a)} can keep them safe.`;
        segs.push(at(ev.body), ' declares independence from ', at(ev.a), ` and becomes ${this.polityName(p)}. ${why} The declaration is read by `, who(lead), '.');
        break;
      }
      case EV['Regime change']: {
        const p = ev.a, from = Math.floor(ev.b / 16), to = ev.b % 16;
        const lead = this.pick(ev.body, y, i * 3 + 1, 35, 85);
        const name = this.polityName(p);
        const art = /^[AEIOU]/.test(REGIME_NAMES[to]) ? 'an' : 'a';
        segs.push(`${cap(name)} ${from === REGIME.CHARTER && to !== REGIME.CHARTER ? 'gives up its charter and becomes' : `ends its ${REGIME_NAMES[from].toLowerCase()} and becomes`} ${art} ${REGIME_NAMES[to].toLowerCase()}: ${REGIME_WHY[to]}. ${TITLE[to]} `, who(lead), ' rules from ', at(ev.body), '.');
        const big = this.e.st.hx.pol[p * NPC + PC.peakPop];
        return { year: y, type: ev.type, segs, people, places, weight: big > 1e9 ? 4 : big > 1e7 ? 3 : 1 };
      }
      case EV.War: {
        const W = this.e.st.hx.war, o = ev.b * NWC;
        const name = this.warName(ev.b);
        if (W[o + WC.kind] === WAR_KIND.KINETIC) {
          const d = this.L.distanceLy(ev.body, ev.a), beta = W[o + WC.speed], E = W[o + WC.energy];
          const lead = this.pick(ev.body, y, i, 30, 80);
          const replies = W[o + WC.end] > W[o + WC.start] + d / beta + 0.5;
          segs.push(`${cap(name)}. `, at(ev.body), ' launches a relativistic kinetic strike at ', at(ev.a), `, ${d.toFixed(1)} light years away: ${Math.round(W[o + WC.mass]).toLocaleString('en-US')} tonnes at ${beta.toFixed(2)}c, ${E.toExponential(1)} joules, ${Math.round(megatons(E)).toLocaleString('en-US')} megatons. The order is given by `, who(lead),
            `. It will land in ${Math.round(2040 + y + d / beta)}, and the light of the launch will reach `, at(ev.a), ` only ${(d / beta - d).toFixed(1)} years ahead of it. `,
            replies ? 'The target holds other systems, and they can reply.' : 'The target holds no other system to reply from.');
          break;
        }
        const a = this.pick(ev.body, y, i, 30, 70), b = this.pick(ev.a, y, i + 1, 30, 70);
        const cause = W[o + WC.cause];
        const why = cause === WAR_CAUSE.FAITH && W[o + WC.fA] >= 0 && W[o + WC.fB] >= 0 ? `over faith: ${this.faithName(W[o + WC.fA])} against ${this.faithName(W[o + WC.fB])}`
          : cause === WAR_CAUSE.INDEPENDENCE && W[o + WC.indep] > -1e8 ? `over an independence declared in ${Math.round(2040 + W[o + WC.indep])}`
          : cause === WAR_CAUSE.GRUDGE ? 'over grudges older than anyone fighting' : 'over water, metal and air';
        const sideA = this.side(W[o + WC.a], W[o + WC.pA], places), sideB = this.side(W[o + WC.b], W[o + WC.pB], places);
        segs.push(`${cap(name)} begins: `, sideA, ' against ', sideB, `, ${why}. The fighting is around `, at(ev.a), '. ', who(a), ' commands one side, ', who(b), ' the other.');
        break;
      }
      case EV.Treaty: {
        const W = this.e.st.hx.war, w = ev.a, o = w * NWC;
        const name = this.warName(w), out = ev.b, yrs = Math.max(1, Math.round(y - W[o + WC.start]));
        const win = W[o + WC.winner], lose = win === W[o + WC.a] ? W[o + WC.b] : W[o + WC.a];
        const signer = this.pick(ev.body, y, i, 30, 85);
        const killed = W[o + WC.killed];
        segs.push(`${cap(name)} ends after ${yrs} year${yrs > 1 ? 's' : ''}${killed >= 1 ? `, having killed ${headcount(killed)}` : ''}. `);
        const pw = win === W[o + WC.a] ? W[o + WC.pA] : W[o + WC.pB], pl = win === W[o + WC.a] ? W[o + WC.pB] : W[o + WC.pA];
        if (out === OUTCOME.ANNEX) segs.push(this.side(lose, pl, places), `'s settlements around ${this.e.world.systems[W[o + WC.sys]].name} now fly the flag of `, this.side(win, pw, places), '.');
        else if (out === OUTCOME.REPARATIONS) segs.push(this.side(lose, pl, places), ` pays ${money(W[o + WC.energy])} in reparations to `, this.side(win, pw, places), '.');
        else segs.push(W[o + WC.kind] === WAR_KIND.KINETIC ? 'The strikes have landed; there is nothing left to fight over.' : 'Neither side can win; the old borders stand.');
        segs.push(' The treaty is signed by ', who(signer), '.');
        break;
      }
      case EV['Kinetic strike']: {
        const W = this.e.st.hx.war, w = ev.b, o = w * NWC;
        const from = W[o + WC.a] === ev.body ? W[o + WC.b] : W[o + WC.a];
        const d = this.L.distanceLy(from, ev.body), beta = W[o + WC.speed];
        segs.push(`A projectile launched from `, at(from), ` ${Math.round(d / beta)} years ago at ${beta.toFixed(2)} times the speed of light strikes `, at(ev.body), `. ${Math.round(ev.a * 100)}% of its people die in an instant (${this.warName(w)}).`);
        break;
      }
      case EV['New faith']: {
        const prophet = this.pick(ev.body, y, i, 18, 60);
        const T = this.e.st.hx.faith, cause = T[ev.a * NFC + FC.cause];
        const far = Math.round(this.L.distanceLy(ev.body, this.e.world.earth));
        const lead = cause === FAITH_CAUSE.PLAGUE ? 'In the years after the plague, ' : cause === FAITH_CAUSE.HUNGER ? 'In a hungry year, '
          : cause === FAITH_CAUSE.FAR ? `${far} light years from Earth, ` : cause === FAITH_CAUSE.BODY ? 'Among people whose bodies have drifted far from Earth\'s, ' : '';
        segs.push(lead, who(prophet), ' of ', at(ev.body), ` begins preaching ${this.faithName(ev.a)}: ${this.tenetsOf(ev.a)}.`);
        break;
      }
      case EV.Schism: {
        const T = this.e.st.hx.faith, n = ev.a, p = ev.b;
        let changed = -1;
        for (let a = 0; a < 5; a++) if (T[n * NFC + FC.t + a] !== T[p * NFC + FC.t + a] && T[n * NFC + FC.t + a] !== 0) changed = a;
        const leader = this.pick(ev.body, y, i, 20, 70);
        segs.push('Schism on ', at(ev.body), ': ', who(leader), ` breaks with ${this.faithName(p)} and founds ${this.faithName(n)}`, changed >= 0 ? `, holding ${tenetClause((a) => T[n * NFC + FC.t + a], changed)}.` : '.');
        break;
      }
      case EV['Faith extinct']: {
        const T = this.e.st.hx.faith, f = ev.a;
        const name = this.faithName(f);
        segs.push(`The last followers of ${name}, first preached on `, at(ev.body), ` in ${Math.round(2040 + T[f * NFC + FC.year])}, are gone. ${ev.b > 1 ? `At its height it was held on ${ev.b} worlds.` : 'It never spread beyond its first world.'}`);
        break;
      }
      case EV['Faith spreads']: {
        const name = this.faithName(ev.a);
        segs.push(`${name[0].toUpperCase()}${name.slice(1)}, born on `, at(ev.body), `, is now held on ${ev.b} worlds. It teaches ${this.tenetsOf(ev.a)}.`);
        return { year: y, type: ev.type, segs, people, places, weight: ev.b >= 10 ? 4 : 2 };
      }
      case EV.Speciation: {
        const child = this.pick(ev.body, y, i, 0, 15);
        segs.push('The people of ', at(ev.body), ' have drifted far enough to become a new species. Among the first born who could not have a child with someone from Earth: ', who(child), '.');
        break;
      }
      case EV['Megastructure complete']: {
        const eng = this.pick(ev.body, y, i, 35, 90);
        segs.push(at(ev.body), ' completes its megastructure. Chief engineer: ', who(eng), '.');
        break;
      }
      case EV['Mutiny in transit']: {
        const lead = this.pick(ev.body, y, i, 18, 60);
        segs.push('Mutiny aboard the ship bound for ', at(ev.body), '. It is led by ', who(lead), ', and the colony begins life divided.');
        break;
      }
      case EV.Plague:
        segs.push('Plague on ', at(ev.body), ` kills ${Math.round(ev.a * 100)}% of the population.`);
        break;
      case EV['Asteroid strike']:
        segs.push('An asteroid strikes ', at(ev.body), ` and kills ${Math.round(ev.a * 100)}%.`);
        break;
      case EV.Collapse:
        segs.push(at(ev.body), ' collapses and loses more than half its people.');
        break;
      case EV['Era change']: {
        const now = this.ageAt(y), was = this.ageAt(y - 0.5);
        if (!now) { segs.push(`The ${ERAS[ev.b]} gives way to ${/^[AEIOU]/.test(ERAS[ev.a]) ? 'an' : 'a'} ${ERAS[ev.a]}.`); break; }
        const span = (a: Age) => `${Math.round(2040 + a.from)}–${Math.round(2040 + a.to)}`;
        segs.push(`A new age: ${now.name} (${span(now)}), ${/^[AEIOU]/.test(ERAS[ev.a]) ? 'an' : 'a'} ${ERAS[ev.a].toLowerCase()}.${was && was !== now ? ` It ends ${was.name} (${span(was)}).` : ''}`);
        break;
      }
      case EV['First contact']: {
        const lab = this.L.biggestLab(y);
        const listener = lab >= 0 ? this.pick(lab, y, i, 25, 90) : null;
        segs.push(ev.a === 1 ? 'First contact. A signal that is not natural, answered. ' : 'A signal from another civilization, heard and never answered. ', 'It is first understood by ', who(listener), lab >= 0 ? ' on ' : '', lab >= 0 ? at(lab) : '', '.');
        break;
      }
      case EV['Dark forest strike']:
        segs.push('Something out in the dark noticed. The whole system around ', at(ev.body), ' is erased in an instant.');
        break;
      case EV['Gamma-ray burst']: case EV.Supernova:
        segs.push(ev.type === EV.Supernova ? 'A nearby star explodes. ' : 'A gamma-ray burst sweeps the region around ', ev.type === EV.Supernova ? 'Radiation sweeps ' : '', at(ev.body), ev.type === EV.Supernova ? '' : '', `: ${ev.a} settlements within ${Math.round(ev.b)} ly lose nine in ten of their people.`);
        break;
      case EV['AI schism']:
        segs.push('The machine minds split into factions, and a share of everything humanity knows is lost in the quarrel.');
        break;
      case EV['Kessler cascade']:
        segs.push("Debris cascades through Earth orbit. For decades every launch is a gamble.");
        break;
      default: return null;
    }
    return { year: y, type: ev.type, segs, people, places, weight: WEIGHT[ev.type] ?? 1 };
  }

  /** Entries in a year range, newest first, optionally about a place or matching text. */
  list(from: number, to: number, opts: { body?: number; query?: string; limit?: number; minWeight?: number } = {}): Entry[] {
    const out: Entry[] = [];
    const q = opts.query?.toLowerCase().trim();
    const limit = opts.limit ?? 60;
    for (let k = this.major.length - 1; k >= 0 && out.length < limit; k--) {
      const i = this.major[k], ev = this.e.events[i];
      if (ev.year > to || ev.year < from) continue;
      if ((WEIGHT[ev.type] ?? 1) < (opts.minWeight ?? 0)) continue;
      if (opts.body !== undefined && ev.body !== opts.body && ev.a !== opts.body && ev.b !== opts.body) continue;
      const en = this.entry(i);
      if (!en) continue;
      if (q && !en.segs.map((s) => (typeof s === 'string' ? s : s.t)).join('').toLowerCase().includes(q)) continue;
      out.push(en);
    }
    return out;
  }

  /** The named things of this future, for the UI: ages, faiths, polities and wars, with their dates. */
  annals(): Annals {
    const X = this.e.st.hx, T = X.faith, P = X.pol, W = X.war;
    const GR = ['founded', 'light-lag', 'taxes', 'disorder', 'founded beyond reach', 'faith', 'size'];
    const CAUSE = ['resources', 'faith', 'independence', 'grudges'];
    const OUT = ['stalemate', 'annexation', 'reparations'];
    const history = new Map<number, { year: number; regime: string }[]>();
    for (const ev of this.e.events) if (ev.type === EV['Regime change']) {
      const h = history.get(ev.a) ?? []; h.push({ year: ev.year, regime: REGIME_NAMES[ev.b % 16] }); history.set(ev.a, h);
    }
    const faiths: Annals['faiths'] = [];
    for (let f = 0; f < X.hg[HG.nFaith]; f++) {
      const o = f * NFC;
      faiths.push({ id: f, name: this.faithName(f), tenets: this.tenetsOf(f), home: T[o + FC.home], founded: T[o + FC.year], ended: T[o + FC.alive] ? null : T[o + FC.end], peakWorlds: T[o + FC.peak], parent: T[o + FC.parent] });
    }
    const polities: Annals['polities'] = [];
    for (let p = 0; p < X.hg[HG.nPol]; p++) {
      const o = p * NPC;
      polities.push({ id: p, name: this.polityName(p), capital: P[o + PC.cap], founded: P[o + PC.year], ended: P[o + PC.alive] ? null : P[o + PC.end], from: P[o + PC.from], grievance: GR[P[o + PC.griev]],
        regime: P[o + PC.regime] >= 0 ? REGIME_NAMES[P[o + PC.regime]] : REGIME_NAMES[0], regimes: history.get(p) ?? [], wars: P[o + PC.wars], peakPop: P[o + PC.peakPop], peakWorlds: P[o + PC.peakWorlds] });
    }
    const wars: Annals['wars'] = [];
    for (let w = 0; w < X.hg[HG.nWar]; w++) {
      const o = w * NWC;
      wars.push({ id: w, name: this.warName(w), a: W[o + WC.a], b: W[o + WC.b], polityA: W[o + WC.pA], polityB: W[o + WC.pB], start: W[o + WC.start], end: W[o + WC.end],
        cause: CAUSE[W[o + WC.cause]], outcome: W[o + WC.outcome] < 0 ? 'ongoing' : OUT[W[o + WC.outcome]], winner: W[o + WC.winner], killed: W[o + WC.killed], kinetic: W[o + WC.kind] === WAR_KIND.KINETIC });
    }
    return { ages: this.ages(), faiths, polities, wars };
  }

  /** Every technology this future has, where and by whom. */
  inventions(): { tech: number; year: number; entry: Entry | null }[] {
    const out: { tech: number; year: number; entry: Entry | null }[] = [];
    this.e.events.forEach((ev, i) => { if (ev.type === EV.Technology) out.push({ tech: ev.a, year: ev.year, entry: this.entry(i) }); });
    return out;
  }

  /** What this person did that made the Chronicle (only events at places and times they were). */
  deedsOf(pid: string, stays: { body: number; from: number; to: number }[]): Entry[] {
    const out: Entry[] = [];
    for (const i of this.major) {
      const ev = this.e.events[i];
      const p = periodOf(ev.year);
      const here = stays.some((s) => p >= s.from && p <= s.to && (s.body === ev.body || s.body === ev.a || s.body === ev.b));
      const aboard = ev.type === EV['Ship launched'] || ev.type === EV['Ship arrived'] || ev.type === EV['Ship lost'] || ev.type === EV['Colony founded'];
      if (!here && !aboard) continue;
      if (aboard && !here && !stays.some((s) => p >= s.from - 1 && p <= s.to + 1)) continue;
      const en = this.entry(i);
      if (en?.people.includes(pid)) out.push(en);
    }
    return out;
  }
}

export { FLOW, periodMid };
