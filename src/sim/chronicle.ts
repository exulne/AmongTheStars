// Notables and the Chronicle. Every major event gets the people who were
// there: the inventor of a technology is an adult who lived in that lab's
// settlement that year; a captain is someone actually aboard that ship; a
// founder is a member of the founding crew. They are picked deterministically
// from the census, so the same future always names the same people, and their
// biographies mention what they did.

import { ERAS, EV, TECHS } from './catalog.ts';
import { periodMid, type Id } from './demography.ts';
import type { Engine, SimEvent } from './engine.ts';
import { FLOW, isShipBody, periodOf } from './ledger.ts';
import type { Lives } from './lives.ts';
import { hash01 } from './rng.ts';

export type Seg = string | { t: string; kind: 'person' | 'body'; id: string | number };
export interface Entry { year: number; type: number; segs: Seg[]; people: string[]; places: number[]; weight: number }

const MAJOR = new Set([
  EV.Technology, EV['Colony founded'], EV['Ship launched'], EV['Ship arrived'], EV['Ship lost'], EV.Independence, EV.War,
  EV['New faith'], EV.Speciation, EV['Megastructure complete'], EV['Era change'], EV['First contact'], EV['Dark forest strike'],
  EV['Gamma-ray burst'], EV.Supernova, EV.Plague, EV['Asteroid strike'], EV.Collapse, EV['Mutiny in transit'], EV['AI schism'], EV['Kessler cascade'],
]);
const WEIGHT: Partial<Record<number, number>> = {
  [EV['First contact']]: 10, [EV['Dark forest strike']]: 10, [EV['Gamma-ray burst']]: 8, [EV.Supernova]: 8, [EV.Technology]: 7,
  [EV.Speciation]: 6, [EV.Independence]: 6, [EV.War]: 5, [EV['Colony founded']]: 5, [EV['Megastructure complete']]: 5,
  [EV['Ship launched']]: 3, [EV['Ship arrived']]: 4, [EV['Ship lost']]: 4, [EV['New faith']]: 3, [EV['Era change']]: 2, [EV.Plague]: 2,
};
const FAITH_FORM = ['the {X} Way', 'the Church of {X}', 'the {X} Covenant', 'the Fellowship of {X}', 'the {X} Reckoning', 'the Quiet of {X}', 'the {X} Return'];

export class Chronicle {
  private e: Engine;
  private L: Lives;
  private cache = new Map<number, Entry | null>();
  private major: number[] = [];

  constructor(e: Engine, lives: Lives) {
    this.e = e; this.L = lives;
    e.events.forEach((ev, i) => {
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

  faithName(b: number, n: number): string {
    const root = this.L.coinedWord(b, n);
    return FAITH_FORM[Math.floor(hash01(b, n, 17) * FAITH_FORM.length)].replace('{X}', root);
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
        segs.push(who(prophet), ' of ', at(ev.body), ` begins preaching ${this.faithName(ev.body, ev.a)}.`);
        break;
      }
      case EV.Speciation: {
        const child = this.pick(ev.body, y, i, 0, 4);
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
