// Biographies on top of the demography: names that drift with lineage and
// distance, ship names, causes of death taken from what actually happened
// where and when someone died, careers, families and bloodlines.

import { EV, EVENT_NAMES, STAGE_NAMES, TECHS } from './catalog.ts';
import { Demography, idStr, periodMid, type Id, type Stay } from './demography.ts';
import { Engine } from './engine.ts';
import { FLOW, SHIP_BODY, isShipBody, periodOf, periodStart, type Flow } from './ledger.ts';
import { F, GM, NF, NGM } from './metrics.ts';
import { hash01 } from './rng.ts';

const GIVEN_F = ['Amara', 'Mei', 'Priya', 'Sofia', 'Fatima', 'Yuki', 'Elena', 'Zara', 'Nia', 'Lin', 'Hana', 'Ana', 'Lea', 'Aisha', 'Ingrid', 'Mariam', 'Chiara', 'Ife', 'Noor', 'Valentina', 'Saoirse', 'Thandiwe', 'Keiko', 'Rosa'];
const GIVEN_M = ['Wei', 'Lucas', 'Mateo', 'Noah', 'Kofi', 'Arjun', 'Omar', 'Kenji', 'Ivan', 'Tariq', 'Diego', 'Kwame', 'Emre', 'Rafael', 'Sipho', 'Anders', 'Joon', 'Tomás', 'Ravi', 'Yusuf', 'Bao', 'Felix', 'Malik', 'Oisín'];
const SURNAMES = ['Okafor', 'Chen', 'Silva', 'Nakamura', 'Patel', 'Müller', 'Haddad', 'Kim', 'Mensah', 'Novak', 'García', 'Ivanova', 'Wang', 'Kowalski', 'Ramos', 'Sato', 'Diallo', 'Singh', 'Rossi', 'Nguyen', 'Lindqvist', 'Abara', 'Moreau', 'Tanaka', 'Osei', 'Reyes', 'Lin', 'Khan', 'Petrov', 'Adeyemi'];
const ONSET = ['k', 't', 's', 'v', 'r', 'l', 'm', 'n', 'd', 'th', 'sh', 'z', 'h', 'j', 'q', 'y', 'br', 'tr', 'kh', 'vel'];
const NUCLEUS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ou', 'y', 'ei', 'aa', 'uu'];
const CODA = ['', '', 'n', 'r', 's', 'th', 'l', 'k', 'sh', 'm', 'x', 'nd'];
const SHIP_A = ['Long', 'Quiet', 'Far', 'Second', 'Patient', 'Bright', 'Last', 'Iron', 'Slow', 'Open', 'Silent', 'Red', 'Morning', 'Deep', 'Faithful', 'Hungry', 'Unbroken', 'Distant', 'Gentle', 'Old'];
const SHIP_B = ['Patience', 'Promise', 'Harvest', 'Covenant', 'Lantern', 'Tide', 'Ark', 'Seed', 'Shore', 'Wager', 'Hymn', 'Errand', 'Horizon', 'Return', 'Mercy', 'Venture', 'Compass', 'Vigil', 'Ember', 'Fathom'];
const JOBS_ALWAYS = ['teacher', 'medic', 'cook', 'artist', 'administrator', 'trader', 'engineer', 'carer'];
const JOBS_BY_TECH: [string, string[]][] = [
  ['kilopower', ['reactor operator']], ['robotics', ['robot wrangler']], ['fusion', ['fusion engineer', 'ice hauler', 'orbital welder']],
  ['agi', ['AI auditor', 'machine ethicist']], ['orbitalHabitats', ['habitat architect', 'spin-gravity engineer']],
  ['genMed', ['gene counsellor']], ['bioAdapt', ['body sculptor']], ['terraform', ['terraformer', 'ecologist']],
  ['dyson1', ['swarm tender', 'mirror pilot']], ['laserComms', ['light-lag diplomat']], ['nanofab', ['matter designer']],
  ['genShip', ['ark pilot']], ['mindUpload', ['mind-host', 'upload archivist']], ['lifeExt', ['third-career counsellor']],
  ['psychohistory', ['forecaster']], ['matrioshka', ['dream architect']],
];
// by era index (Expansion, Consolidation, Golden Age, Stagnation, War, Pandemic, Collapse, Renaissance)
const JOBS_BY_ERA: Record<number, string[]> = {
  0: ['surveyor', 'outfitter'], 2: ['philosopher', 'composer'], 3: ['clerk'], 4: ['soldier', 'drone pilot', 'medic'],
  5: ['quarantine warden', 'epidemiologist'], 6: ['scavenger', 'salvager'], 7: ['historian', 'teacher'],
};
const JOBS_EARLY = ['hydroponics technician', 'life-support engineer', 'regolith miner', 'teacher', 'medic', 'fabricator', 'pilot', 'geologist', 'robot wrangler', 'reactor operator', 'trader', 'administrator', 'cook', 'artist'];
const MOODS_GOOD = ['content', 'hopeful', 'proud', 'curious', 'in love'];
const MOODS_BAD = ['restless', 'homesick', 'tired', 'grieving', 'angry'];

const MORTAL: Record<number, string> = {
  [EV.Plague]: 'the plague', [EV['Habitat breach']]: 'a habitat breach', [EV['Asteroid strike']]: 'the asteroid strike',
  [EV.Famine]: 'the famine', [EV.War]: 'the war', [EV['Gamma-ray burst']]: 'the gamma-ray burst', [EV.Supernova]: 'the supernova',
  [EV['Dark forest strike']]: 'the strike from the dark', [EV['Reactor accident']]: 'a reactor accident', [EV.Collapse]: 'the collapse',
  [EV['Solar storm']]: 'a solar storm',
  [EV['Kinetic strike']]: 'the kinetic strike',
};

export interface PersonBrief { id: string; name: string; sex: 'f' | 'm'; born: number; age: number; place: string; job: string; alive: boolean; body?: string }

export interface Biography extends PersonBrief {
  bornAt: number; bornAtName: string;
  died: { year: number; place: string; cause: string; age: number } | null;
  where: { body: number; name: string } | null;       // at the asked year
  status: 'unborn' | 'alive' | 'dead' | 'travelling';
  mother: PersonBrief | null; father: PersonBrief | null;
  partners: PersonBrief[]; children: PersonBrief[]; siblings: PersonBrief[];
  /** year each partner's first child together was born (when the couple is known to be together) */
  partnerSince: number[];
  ancestors: { gen: number; who: PersonBrief }[];
  story: { year: number; text: string; link?: { kind: 'body' | 'person'; id: string | number } }[];
  height: number; personality: [number, number, number, number, number]; generationsHere: number;
  descendants: { total: number; alive: number; places: { body: number; name: string; n: number }[]; generations: number };
  faith?: string | null;  // raised in, from the birthplace's faith shares at birth
  /** every place they ever were, in order: the pathway of a life, birth to death */
  path: { body: number | null; name: string; from: number; to: number | null }[];
}

export class Lives {
  private e: Engine;
  D: Demography;
  private surnameMemo = new Map<string, string>();
  private eventsBy = new Map<number, { year: number; type: number; a: number }[]>();

  constructor(e: Engine) {
    this.e = e;
    const ext = TECHS.findIndex((t) => t.id === 'lifeExt'), gm = TECHS.findIndex((t) => t.id === 'genMed'), up = TECHS.findIndex((t) => t.id === 'mindUpload');
    const done = (i: number, y: number) => i >= 0 && e.st.techDone[i] >= 0 && e.st.techDone[i] <= y;
    this.D = new Demography(e.ledger!, e.seed, e.world.earth, (y) => 1 + (done(gm, y) ? 0.12 : 0) + (done(ext, y) ? 1 : 0) + (done(up, y) ? 0.5 : 0));
    for (const ev of e.events) {
      if (ev.body < 0 || !(ev.type in MORTAL)) continue;
      const a = this.eventsBy.get(ev.body);
      if (a) a.push({ year: ev.year, type: ev.type, a: ev.a }); else this.eventsBy.set(ev.body, [{ year: ev.year, type: ev.type, a: ev.a }]);
    }
  }

  /** The boarding flow of a generation ship body. */
  private boarding(ship: number): Flow | null {
    const id = this.e.ledger!.inBy.get(ship)?.[0];
    return id === undefined ? null : this.e.ledger!.flows[id];
  }
  private landing(ship: number): Flow | null {
    const id = this.e.ledger!.outBy.get(ship)?.[0];
    return id === undefined ? null : this.e.ledger!.flows[id];
  }
  /** Where a place really is: a ship counts as its home port. */
  private home(b: number): number { return isShipBody(b) ? this.boarding(b)?.src ?? this.e.world.earth : b; }
  private bodyName(b: number): string {
    if (isShipBody(b)) return `the ${this.shipName(b)}`;
    return this.e.world.bodies[b]?.name ?? '?';
  }

  // ---------------------------------------------------------------- names

  /** Language of a place drifts with distance from Sol and with time. */
  private coined(seed: number, b: number, year: number, syl: number): string {
    const sys = this.e.world.bodies[this.home(b)].system;
    const era = Math.floor(year / 400);
    let s = '';
    for (let k = 0; k < syl; k++) {
      const h = (j: number) => hash01(sys, era, seed, k, j);
      s += ONSET[Math.floor(h(1) * ONSET.length)] + NUCLEUS[Math.floor(h(2) * NUCLEUS.length)] + (k === syl - 1 ? CODA[Math.floor(h(3) * CODA.length)] : '');
    }
    return s[0].toUpperCase() + s.slice(1);
  }
  /** How far a place's naming has drifted from Earth's (0 = Earth names). */
  private drift(b: number, year: number): number {
    const sys = this.e.world.systems[this.e.world.bodies[this.home(b)].system];
    return Math.min(1, Math.max(0, (year - 60) / 700 + Math.log10(1 + sys.dist) / 3));
  }

  givenName(id: Id, sex: 0 | 1): string {
    const y = this.D.birthYear(id);
    const h = hash01(id.b, id.q, id.i, 21);
    if (h > this.drift(id.b, y)) return (sex === 0 ? GIVEN_F : GIVEN_M)[Math.floor(hash01(id.b, id.q, id.i, 22) * GIVEN_F.length)];
    return this.coined(Math.floor(hash01(id.b, id.q, id.i, 23) * 997), id.b, y, 2 + (hash01(id.b, id.q, id.i, 24) < 0.3 ? 1 : 0)) + (sex === 0 && hash01(id.b, id.q, id.i, 25) < 0.5 ? 'a' : '');
  }

  /** Surnames pass from father to child, with occasional changes, back to the first settlers or Earth. */
  surname(id: Id, depth = 0): string {
    const key = idStr(id);
    const got = this.surnameMemo.get(key);
    if (got) return got;
    let s: string;
    const y = this.D.birthYear(id);
    const fresh = () => (hash01(id.b, id.q, id.i, 31) > this.drift(id.b, y) ? SURNAMES[Math.floor(hash01(id.b, id.q, id.i, 32) * SURNAMES.length)] : this.coined(Math.floor(hash01(id.b, id.q, id.i, 33) * 997), id.b, y, 2));
    const r = hash01(id.b, id.q, id.i, 34);
    if (depth > 60 || r < 0.03) s = fresh();
    else {
      const f = this.D.father(id), m = this.D.mother(id);
      if (f && r > 0.07) s = this.surname(f, depth + 1);
      else if (m) s = this.surname(m, depth + 1);
      else s = fresh();
      if (r > 0.07 && r < 0.085 && m && f) s = `${this.surname(f, depth + 1)}-${this.surname(m, depth + 1)}`.split('-').slice(0, 2).join('-');
    }
    if (this.surnameMemo.size > 200000) this.surnameMemo.clear();
    this.surnameMemo.set(key, s);
    return s;
  }

  /** A ship's name, from its ship body or from a direct (short) voyage's flow. */
  shipName(x: Flow | number): string {
    const key = typeof x === 'number' ? x : isShipBody(x.dst) ? x.dst : isShipBody(x.src) ? x.src : SHIP_BODY * 3 + x.id;
    const port = typeof x === 'number' ? this.home(x) : isShipBody(x.src) ? this.home(x.src) : x.src;
    const year = typeof x === 'number' ? this.boarding(x)?.depart ?? 0 : x.depart;
    const h = (k: number) => hash01(key, 7, k);
    if (h(1) < 0.25) return `${this.coined(Math.floor(h(2) * 997), port, year, 2)}`;
    return `${SHIP_A[Math.floor(h(3) * SHIP_A.length)]} ${SHIP_B[Math.floor(h(4) * SHIP_B.length)]}`;
  }

  // ---------------------------------------------------------------- helpers for the Chronicle

  placeName(b: number): string { return this.bodyName(b); }
  coinedWord(b: number, n: number): string { return this.coined(n, b, 0, 2); }
  /** set by the worker once the Chronicle exists, so biographies can mention what people did */
  deeds: ((pid: string, stays: { body: number; from: number; to: number }[]) => { year: number; text: string }[]) | null = null;
  /** set by the worker: the faith someone born at b in `year` is raised in (u picks among the shares) */
  faithAt: ((b: number, year: number, u: number) => string | null) | null = null;
  distanceLy(a: number, b: number): number {
    const s1 = this.e.world.systems[this.e.world.bodies[this.home(a)].system], s2 = this.e.world.systems[this.e.world.bodies[this.home(b)].system];
    return Math.hypot(s1.x - s2.x, s1.y - s2.y, s1.z - s2.z);
  }
  biggestLab(year: number): number { void year; return this.e.world.earth; }
  voyage(seq: number) { return this.e.ledger!.ships.get(seq) ?? null; }
  shipFlow(seq: number): number | null { return this.voyage(seq)?.flow ?? null; }
  landingFlow(seq: number): number | null { return this.e.ledger!.outBy.get(SHIP_BODY + seq)?.[0] ?? null; }
  crewFlow(src: number, dst: number, year: number): number | null {
    for (const id of this.e.ledger!.outBy.get(src) ?? []) {
      const f = this.e.ledger!.flows[id];
      if (f.kind === FLOW.CREW && f.dst === dst && Math.abs(f.depart - year) < 1) return id;
    }
    return null;
  }

  /** A resident of b in that year whose age fits, chosen by hash; null if none found. */
  pickResident(b: number, year: number, salt: number, minAge: number, maxAge: number): Id | null {
    const p = Math.max(0, Math.min(this.D.lastPeriod, periodOf(year) - (year >= 5 ? 1 : 0)));
    const c = this.D.census(b, p);
    if (!c.total) return null;
    for (let t = 0; t < 48; t++) {
      const id = c.at(Math.floor(hash01(this.e.seed, b, salt, t) * c.total));
      const age = year - this.D.birthYear(id);
      if (age >= minAge && age <= maxAge) return id;
    }
    return null;
  }

  /** Someone who travelled on ledger flow `flow`, an adult if possible. */
  pickTraveller(flow: number, salt: number): Id | null {
    const ranges = this.D.flowMembers(flow);
    const total = ranges.reduce((a, r) => a + r.count, 0);
    if (!total) return null;
    const year = this.e.ledger!.flows[flow].depart;
    let fallback: Id | null = null;
    for (let t = 0; t < 32; t++) {
      let j = Math.floor(hash01(this.e.seed, flow, salt, t) * total);
      const r = ranges.find((x) => (j < x.count ? true : ((j -= x.count), false)))!;
      const id = this.D.origin(r.pool, r.start + j);
      fallback ??= id;
      const age = year - this.D.birthYear(id);
      if (age >= 25 && age <= 65) return id;
    }
    return fallback;
  }

  // ---------------------------------------------------------------- people

  private sexOf(id: Id): 0 | 1 { const bp = this.D.birthPool(id); return bp ? ((bp.rank % 2) as 0 | 1) : 0; }

  name(id: Id): string { return `${this.givenName(id, this.sexOf(id))} ${this.surname(id)}`; }

  private techBy(tech: string, year: number): boolean {
    const i = TECHS.findIndex((t) => t.id === tech);
    return i >= 0 && this.e.st.techDone[i] >= 0 && this.e.st.techDone[i] <= year;
  }
  private eraAt(year: number): number {
    const ys = this.e.years;
    let lo = 0, hi = ys.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ys[m] <= year) lo = m; else hi = m - 1; }
    return this.e.series[lo * NGM + GM.era];
  }
  /** Working lives stretch with medicine: retirement comes at ~80% of what people expect to live. */
  private expectedLife(year: number): number {
    return this.techBy('mindUpload', year) ? 320 : this.techBy('lifeExt', year) ? 220 : this.techBy('genMed', year) ? 105 : 85;
  }

  /** Jobs exist when the technology and the times call for them. */
  private job(id: Id, age: number, year: number): string {
    if (age < 6) return 'child';
    if (age < 20) return 'student';
    const life = this.expectedLife(year);
    if (age > life * 0.8 && hash01(id.b, id.q, id.i, 41) < 0.75) return 'retired';
    const pool = [...JOBS_ALWAYS];
    for (const [tech, jobs] of JOBS_BY_TECH) if (this.techBy(tech, year)) pool.push(...jobs);
    if (!this.techBy('fusion', year)) pool.push(...JOBS_EARLY);
    const era = this.eraAt(year);
    const eraJobs = JOBS_BY_ERA[era] ?? [];
    // a career changes every couple of decades, longer when lives are long
    const career = Math.floor((age - 20) / Math.max(15, life / 6));
    const h = hash01(id.b, id.q, id.i, 42, career);
    if (eraJobs.length && hash01(id.b, id.q, id.i, 43, Math.floor(year / 10)) < 0.18) return eraJobs[Math.floor(h * eraJobs.length)];
    return pool[Math.floor(h * pool.length)];
  }

  /** baseline, adapted (engineered for their world) or uploaded */
  private bodyKind(id: Id, age: number, year: number): string {
    const born = year - age;
    if (this.bodyShares && !isShipBody(id.b)) {
      // the shares the sim keeps per settlement: uploads among the old where they live, adaptation from birth
      const here = this.bodyShares(id.b, year), atBirth = this.bodyShares(id.b, born);
      if (age > 40 && hash01(id.b, id.q, id.i, 71) < Math.min(1, here.uploaded * 1.6)) return 'uploaded';
      if (hash01(id.b, id.q, id.i, 72) < atBirth.adapted) return 'adapted to this world';
      return 'baseline human';
    }
    if (this.techBy('mindUpload', year) && age > 60 && hash01(id.b, id.q, id.i, 71) < Math.min(0.6, (year - this.e.st.techDone[TECHS.findIndex((t) => t.id === 'mindUpload')]) / 800)) return 'uploaded';
    if (this.techBy('bioAdapt', born) && !isShipBody(id.b) && this.e.world.bodies[id.b] && Math.abs(1 - this.e.world.bodies[id.b].g) > 0.3) return 'adapted to this world';
    return 'baseline human';
  }
  /** set by the worker: shares of a settlement's people adapted and uploaded in a year */
  bodyShares: ((b: number, year: number) => { adapted: number; uploaded: number }) | null = null;

  brief(id: Id, year: number): PersonBrief {
    const born = this.D.birthYear(id);
    const life = this.D.life(id, this.D.lastPeriod)!;
    const last = life[life.length - 1];
    const deathYear = last.end === 'died' || last.end === 'lost' ? last.diedYear! : Infinity;
    const age = Math.max(0, Math.min(year, deathYear) - born);
    const stay = this.stayAt(life, year);
    return {
      id: idStr(id), name: this.name(id), sex: this.sexOf(id) === 0 ? 'f' : 'm', born, age,
      place: this.bodyName(stay?.body ?? id.b), job: this.job(id, age, year), alive: year >= born && year < deathYear, body: this.bodyKind(id, age, year),
    };
  }

  private stayAt(life: Stay[], year: number): Stay | null {
    const p = periodOf(year);
    for (const s of life) if (s.from <= p && p <= s.to) return s;
    return life[life.length - 1] ?? null;
  }

  residents(body: number, year: number, offset: number, count: number) {
    const p = Math.max(0, Math.min(this.D.lastPeriod, periodOf(year) - (year >= 5 ? 1 : 0)));
    const c = this.D.census(body, p);
    const asOf = periodStart(p + 1);
    const out: PersonBrief[] = [];
    // membership as of the census; ages and jobs at the year being looked at
    for (let k = offset; k < Math.min(c.total, offset + count); k++) out.push({ ...this.brief(c.at(k), Math.max(year, asOf)), place: this.bodyName(body) });
    return { total: c.total, asOf, offset, people: out, pyramid: this.D.pyramid(body, p) };
  }

  /** The n-th person (1-based) ever born on `body` — with `kind`, the n-th of that
   *  kind at `year`. `total` is everyone born there; `scanned` how many candidates
   *  were tried before the kind filter found them or gave up. */
  bornAt(body: number, n: number, kind: string, year: number): { person: Id | null; total: number; scanned: number } {
    const t = this.D.ensure(body, this.D.lastPeriod);
    const pools = t.pools.filter((x) => x.native).sort((a, b) => a.q - b.q);
    const total = pools.reduce((a, x) => a + x.n, 0);
    if (n < 1 || n > total) return { person: null, total, scanned: 0 };
    if (kind === 'any') {
      let left = n;
      for (const x of pools) {
        if (left <= x.n) return { person: { b: body, q: x.q, i: left - 1 }, total, scanned: n };
        left -= x.n;
      }
      return { person: null, total, scanned: total };
    }
    const want = kind === 'adapted' ? 'adapted to this world' : kind === 'uploaded' ? 'uploaded' : 'baseline human';
    const BUDGET = 40000;
    let seen = 0, scanned = 0;
    for (const x of pools) {
      for (let i = 0; i < x.n && scanned < BUDGET; i++) {
        scanned++;
        const id = { b: body, q: x.q, i };
        if (this.bodyKind(id, Math.max(0, year - this.D.birthYear(id)), year) === want && ++seen === n) return { person: id, total, scanned };
      }
      if (scanned >= BUDGET) break;
    }
    return { person: null, total, scanned };
  }

  residentAt(body: number, year: number, k: number): string | null {
    const p = Math.max(0, Math.min(this.D.lastPeriod, periodOf(year) - (year >= 5 ? 1 : 0)));
    const c = this.D.census(body, p);
    return k >= 0 && k < c.total ? idStr(c.at(k)) : null;
  }

  private deathCause(id: Id, s: Stay, age: number): string {
    if (s.end === 'lost') return `lost with the ${this.shipName(s.flow!)} in deep space`;
    if (isShipBody(s.body)) return age > 70 ? 'old age, aboard ship' : ['a hull breach', 'a fever that ran through the decks', 'an accident in the drive section', 'heart failure'][Math.floor(hash01(id.b, id.q, id.i, 54) * 4)];
    const y0 = periodStart(s.to), y1 = periodStart(s.to + 1);
    const evs = (this.eventsBy.get(s.body) ?? []).filter((e) => e.year >= y0 && e.year < y1);
    const h = hash01(id.b, id.q, id.i, 51);
    for (const ev of evs) {
      const share = ev.type === EV.War ? 0.35 : Math.min(0.85, Math.max(0.1, ev.a * 4));
      if (h < share) return `${MORTAL[ev.type]} of ${Math.round(2040 + ev.year)}`;
    }
    if (age < 1) return 'complications at birth';
    if (age < 30) return ['a construction accident', 'decompression', 'a climbing fall', 'a fever', 'radiation sickness'][Math.floor(hash01(id.b, id.q, id.i, 52) * 5)];
    if (age < 70) return ['heart failure', 'cancer', 'an accident', 'a stroke', 'an infection'][Math.floor(hash01(id.b, id.q, id.i, 53) * 5)];
    return age > 140 ? 'chose to stop, after a very long life' : 'old age';
  }

  biography(idS: string, year: number): Biography | null {
    const m = idS.match(/^(\d+)\.(-?\d+)\.(\d+)$/);
    if (!m) return null;
    const id: Id = { b: Number(m[1]), q: Number(m[2]), i: Number(m[3]) };
    const life = this.D.life(id, this.D.lastPeriod);
    if (!life) return null;
    const born = this.D.birthYear(id);
    const last = life[life.length - 1];
    const dead = last.end === 'died' || last.end === 'lost';
    const deathYear = dead ? last.diedYear! : Infinity;
    const age = Math.max(0, Math.min(year, deathYear) - born);
    const brief = this.brief(id, year);
    const stay = this.stayAt(life, year);
    const mother = this.D.mother(id), father = this.D.father(id);
    const kids = this.D.children(id);
    const partners = new Map<string, Id>(), since = new Map<string, number>();
    for (const k of kids) {
      const other = this.sexOf(id) === 0 ? this.D.father(k) : this.D.mother(k);
      if (!other) continue;
      const key = idStr(other), kb = this.brief(k, year).born;
      partners.set(key, other);
      since.set(key, Math.min(since.get(key) ?? Infinity, kb));
    }
    const siblings = mother ? this.D.children(mother).filter((x) => idStr(x) !== idStr(id)).slice(0, 16) : [];
    const ancestors: Biography['ancestors'] = [];
    let line: Id | null = father ?? mother, gen = 1;
    while (line && gen <= 40) {
      ancestors.push({ gen, who: this.brief(line, year) });
      const next: Id | null = this.D.father(line) ?? this.D.mother(line);
      line = next; gen++;
    }

    // the story, in order
    const story: Biography['story'] = [];
    const parents = [mother, father].filter(Boolean).map((x) => this.name(x!));
    const bornAboard = isShipBody(id.b) ? (() => {
      const bf = this.boarding(id.b), lf = this.landing(id.b);
      return bf ? `, ${Math.round(born - bf.depart)} years into its voyage from ${this.bodyName(bf.src)}${lf ? ` to ${this.bodyName(lf.dst)}` : ''}` : '';
    })() : '';
    const faith = this.faithAt?.(this.home(id.b), born, hash01(id.b, id.q, id.i, 71)) ?? null;
    if (faith) story.push({ year: born + 1, text: `Raised in ${faith}.` });
    story.push({ year: born, text: `Born ${isShipBody(id.b) ? 'aboard' : 'on'} ${this.bodyName(id.b)}${bornAboard}${parents.length ? `, to ${parents.join(' and ')}` : id.q < 0 ? ', on Earth before the Landing' : ''}.`, link: isShipBody(id.b) ? undefined : { kind: 'body', id: id.b } });
    life.forEach((s, k) => {
      if (k > 0 && s.end !== 'lost') {
        const f = life[k - 1].flow!;
        const voyage = f.kind === FLOW.SHIP || f.kind === FLOW.FTL;
        const how = isShipBody(f.dst) ? `Boarded the ${this.shipName(f.dst)} at ${this.bodyName(f.src)}`
          : f.kind === FLOW.LANDING ? `Stepped off the ${this.shipName(f.src)} onto ${this.bodyName(f.dst)}, ${Math.round(f.depart - (this.boarding(f.src)?.depart ?? f.depart))} years after it left ${this.bodyName(this.home(f.src))}`
          : f.kind === FLOW.CREW ? `Joined the founding crew of ${this.bodyName(f.dst)}`
          : voyage ? `Arrived at ${this.bodyName(f.dst)} aboard the ${this.shipName(f)}, ${Math.round(f.arrive - f.depart)} years after leaving ${this.bodyName(f.src)}`
          : `Moved from ${this.bodyName(f.src)} to ${this.bodyName(f.dst)}`;
        story.push({ year: voyage ? f.arrive : f.kind === FLOW.LANDING || isShipBody(f.dst) ? f.depart : periodMid(f.p), text: `${how}.`, link: isShipBody(f.dst) ? undefined : { kind: 'body', id: f.dst } });
      }
      if (s.end === 'left' && s.flow && (s.flow.kind === FLOW.SHIP || s.flow.kind === FLOW.FTL) && !isShipBody(s.flow.dst)) {
        story.push({ year: s.flow.depart, text: `Boarded the ${this.shipName(s.flow)} at ${this.bodyName(s.flow.src)}, bound for ${this.bodyName(s.flow.dst)} (${(this.e.world.systems[this.e.world.bodies[s.flow.dst].system].name)}).`, link: { kind: 'body', id: s.flow.dst } });
      }
      // events lived through here
      const y0 = periodStart(s.from), y1 = s.end === 'alive' ? year : periodStart(s.to + 1);
      for (const ev of this.eventsBy.get(s.body) ?? []) {
        if (ev.year >= Math.max(y0, born) && ev.year < Math.min(y1, deathYear) && ev.year <= year && story.length < 40) {
          story.push({ year: ev.year, text: `Lived through ${MORTAL[ev.type]} on ${this.bodyName(s.body)}${ev.a > 0 && ev.a < 1 ? `, which killed ${Math.round(ev.a * 100)}%` : ''}.` });
        }
      }
    });
    for (const k of kids.slice(0, 12)) {
      const by = this.D.birthYear(k);
      story.push({ year: by, text: `${this.sexOf(k) === 0 ? 'A daughter' : 'A son'}, ${this.givenName(k, this.sexOf(k))}, was born.`, link: { kind: 'person', id: idStr(k) } });
    }
    if (this.deeds) for (const d of this.deeds(idStr(id), life.map((x) => ({ body: x.body, from: x.from, to: x.to })))) story.push({ year: d.year, text: d.text });
    let died: Biography['died'] = null;
    if (dead) {
      const dAge = deathYear - born;
      died = { year: deathYear, place: last.end === 'lost' ? 'deep space' : this.bodyName(last.body), cause: this.deathCause(id, last, dAge), age: dAge };
      story.push({ year: deathYear, text: `Died ${last.end === 'lost' ? 'in deep space' : `on ${this.bodyName(last.body)}`}, aged ${Math.floor(dAge)}: ${died.cause}.` });
    }
    story.sort((a, b) => a.year - b.year);

    // bloodline: breadth-first, capped
    const desc = { total: 0, alive: 0, places: new Map<number, number>(), generations: 0 };
    let frontier = kids, g = 0;
    while (frontier.length && g < 6 && desc.total < 1500) {
      g++;
      const nextGen: Id[] = [];
      for (const k of frontier) {
        if (this.D.birthYear(k) > year) continue;
        desc.total++;
        const b = this.brief(k, year);
        if (b.alive) {
          desc.alive++;
          const kl = this.D.life(k, periodOf(year));
          const at = kl ? this.stayAt(kl, year) : null;
          if (at) desc.places.set(at.body, (desc.places.get(at.body) ?? 0) + 1);
        }
        if (nextGen.length < 1500) nextGen.push(...this.D.children(k, periodOf(year)));
      }
      desc.generations = g;
      frontier = nextGen;
    }

    // the pathway: every stay in order, with voyages between them
    const path: Biography['path'] = [];
    life.forEach((s, k) => {
      const f = k > 0 ? life[k - 1].flow : undefined;
      const voyageF = f && !isShipBody(s.body) && (f.kind === FLOW.SHIP || f.kind === FLOW.FTL) ? f : undefined;
      if (voyageF) path.push({ body: null, name: s.end === 'lost' ? `lost aboard the ${this.shipName(voyageF)}, never reaching ${this.bodyName(voyageF.dst)}` : `aboard the ${this.shipName(voyageF)}, bound for ${this.bodyName(voyageF.dst)}`, from: voyageF.depart, to: voyageF.arrive });
      if (s.end === 'lost') { if (!voyageF) path.push({ body: null, name: `lost aboard the ${s.flow ? this.shipName(s.flow) : 'ship'} in deep space`, from: s.flow?.depart ?? periodStart(s.from), to: s.diedYear ?? null }); return; }
      path.push({ body: isShipBody(s.body) ? null : s.body, name: this.bodyName(s.body), from: k === 0 ? born : f ? f.arrive : periodStart(s.from), to: s.end === 'alive' ? null : s.end === 'left' ? s.flow?.depart ?? null : s.diedYear ?? null });
    });

    const bodyG = isShipBody(id.b) ? 0.9 : this.e.world.bodies[id.b].g;
    const S = this.e.st.S;
    const status: Biography['status'] = year < born ? 'unborn' : dead && year >= deathYear ? 'dead'
      : stay && stay.end === 'left' && stay.flow && year > stay.flow.depart && year < stay.flow.arrive ? 'travelling' : 'alive';
    return {
      ...brief, age, bornAt: id.b, bornAtName: this.bodyName(id.b), died, status,
      where: stay ? { body: stay.body, name: this.bodyName(stay.body) } : null,
      mother: mother && this.brief(mother, year), father: father && this.brief(father, year),
      partners: [...partners.values()].slice(0, 6).map((x) => this.brief(x, year)),
      partnerSince: [...partners.keys()].slice(0, 6).map((k) => since.get(k)!),
      children: kids.slice(0, 24).map((x) => this.brief(x, year)),
      siblings: siblings.map((x) => this.brief(x, year)),
      ancestors, story,
      height: Math.round(172 + (1 - Math.min(bodyG, 1.5)) * 24 * Math.min(1, (born - (isShipBody(id.b) ? born - 100 : S[id.b * NF + F.founded])) / 300) + (hash01(id.b, id.q, id.i, 61) - 0.5) * 22),
      personality: [62, 63, 64, 65, 66].map((k) => Math.round(hash01(id.b, id.q, id.i, k) * 100) / 100) as Biography['personality'],
      generationsHere: ancestors.filter((a) => a.who.place === this.bodyName(id.b)).length + 1,
      faith,
      descendants: { total: desc.total, alive: desc.alive, generations: desc.generations, places: [...desc.places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b, n]) => ({ body: b, name: this.bodyName(b), n })) },
      path,
    };
  }
}

export { STAGE_NAMES, EVENT_NAMES, MOODS_BAD, MOODS_GOOD };
