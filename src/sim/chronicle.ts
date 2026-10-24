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
import { FAITH_CAUSE, FC, NFC, TENET_TEXT } from './civ.ts';

export type Seg = string | { t: string; kind: 'person' | 'body'; id: string | number };
export interface Entry { year: number; type: number; segs: Seg[]; people: string[]; places: number[]; weight: number }

const MAJOR = new Set([
  EV.Technology, EV['Colony founded'], EV['Ship launched'], EV['Ship arrived'], EV['Ship lost'], EV.Independence, EV.War,
  EV['New faith'], EV.Speciation, EV['Megastructure complete'], EV['Era change'], EV['First contact'], EV['Dark forest strike'],
  EV['Gamma-ray burst'], EV.Supernova, EV.Plague, EV['Asteroid strike'], EV.Collapse, EV['Mutiny in transit'], EV['AI schism'], EV['Kessler cascade'],
  EV.Invention, EV['No-go theorem'], EV.Schism, EV['Faith extinct'], EV['Faith spreads'],
]);
const WEIGHT: Partial<Record<number, number>> = {
  [EV['First contact']]: 10, [EV['Dark forest strike']]: 10, [EV['Gamma-ray burst']]: 8, [EV.Supernova]: 8, [EV.Technology]: 7,
  [EV.Speciation]: 6, [EV.Independence]: 6, [EV.War]: 5, [EV['Colony founded']]: 5, [EV['Megastructure complete']]: 5,
  [EV['No-go theorem']]: 6, [EV.Invention]: 2, [EV['Ship launched']]: 3, [EV['Ship arrived']]: 4, [EV['Ship lost']]: 4, [EV['New faith']]: 3, [EV.Schism]: 3, [EV['Faith extinct']]: 3, [EV['Faith spreads']]: 2, [EV['Era change']]: 2, [EV.Plague]: 2,
};
const FAITH_FORM = ['the {X} Way', 'the Church of {X}', 'the {X} Covenant', 'the Fellowship of {X}', 'the {X} Reckoning', 'the Quiet of {X}', 'the {X} Return'];
const SCHISM_FORM = ['the {X} Reform', 'the {X} Dissent', 'the Remnant of {X}', 'the {X} Awakening', 'the True {X}'];

/** "that the body is a draft, that Earth is a myth, and that machines are kin" */
export function tenetClause(t: (axis: number) => number, only?: number): string {
  const parts: string[] = [];
  for (let a = 0; a < 5; a++) { if (only !== undefined && a !== only) continue; const v = t(a); if (v) parts.push(`that ${TENET_TEXT[a][v > 0 ? 0 : 1]}`); }
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
}

export class Chronicle {
  private e: Engine;
  private L: Lives;
  private cache = new Map<number, Entry | null>();
  private major: number[] = [];
  private genEvent = new Map<number, number>(); // generated invention → its event index
  private genNames = new Map<number, string>();
  private faithEvent = new Map<number, number>(); // faith id → its founding (or schism) event index

  constructor(e: Engine, lives: Lives) {
    this.e = e; this.L = lives;
    e.events.forEach((ev, i) => {
      if (ev.type === EV.Invention) this.genEvent.set(ev.a, i);
      if (ev.type === EV['New faith'] || ev.type === EV.Schism) this.faithEvent.set(ev.a, i);
      if (!MAJOR.has(ev.type)) return;
      if (ev.type === EV.Plague && ev.a < 0.08) return;
      this.major.push(i);
    });
  }

  private name(b: number): string { return this.L.placeName(b); }
  private place(b: number): Seg { return isShipBody(b) || b < 0 ? this.name(b) : { t: this.name(b), kind: 'body', id: b }; }
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
        segs.push(at(ev.body), ' declares independence from ', at(ev.a), '. The declaration is read by ', who(lead), '.');
        break;
      }
      case EV.War: {
        const a = this.pick(ev.body, y, i, 30, 70), b = this.pick(ev.a, y, i + 1, 30, 70);
        segs.push('War between ', at(ev.body), ' and ', at(ev.a), `${ev.b > 0 ? `, costing up to ${Math.round(ev.b * 100)}% of their people` : ''}. `, who(a), ' commands one side, ', who(b), ' the other.');
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
      case EV['Era change']:
        segs.push(`The ${ERAS[ev.b]} gives way to ${/^[AEIOU]/.test(ERAS[ev.a]) ? 'an' : 'a'} ${ERAS[ev.a]}.`);
        break;
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
