// The simulation. One step advances every settlement by dt years.
// All mutable state lives in typed arrays inside `SimState` so that a snapshot
// is a handful of array copies, and replaying from a snapshot is exact.

import { ERA_FX, ERA_MATRIX, ERAS, EV, STAGE, STAGE_CAP, STAGE_TECH, TECHS, isAlive, type Tech } from './catalog.ts';
import { F, GM, HIST_FIELDS, NF, NGM } from './metrics.ts';
import { AGE_W, CREW_AGES, FERT_SHARE, GM_A0, GM_B0, GM_b0, MIGRANT_AGES, NAGE, binHazard, earthBins, infantHazard, lifeExpectancyBins, medianAge, tfrTransition } from './ages.ts';
import { EFFECTS, compat, effectFor, effectSize, isAdd, isDown, spineField, FIELDS, type Field } from './invent.ts';
import { FLOW, GENERATION, Ledger, NPERIODS, isPeriodBoundary, periodOf } from './ledger.ts';
import { next, seedRng, type RngState } from './rng.ts';
import type { World } from './world.ts';

export const YEAR0 = 2040;
export const HORIZON = 10000;

export function dtAt(year: number): number {
  return year < 200 ? 1 : year < 1000 ? 4 : 10;
}
export function stepYears(): number[] {
  const ys: number[] = [];
  for (let y = 0; y <= HORIZON; y += dtAt(y)) ys.push(y);
  return ys;
}

// Ship table columns
const SH = { from: 0, to: 1, depart: 2, arrive: 3, colonists: 4, kind: 5, flow: 6 } as const;
const NSH = 7;
const MAX_SHIPS = 4096;

// Generated invention columns: parents (spine index, or TECHS.length + k), effect key, size, year, place, depth, field, other field, draw
export const GC = { a: 0, b: 1, key: 2, size: 3, year: 4, place: 5, depth: 6, field: 7, other: 8, r: 9 } as const;
export const NGC = 10;
export const MAX_GEN = 4096;

// Global scalar slots
const G = {
  year: 0, era: 1, eraSince: 2, knowledge: 3, shipsLaunched: 4, shipsLost: 5, dead: 6, wars: 7,
  kesslerUntil: 8, contact: 9, faiths: 10, nShips: 11, launchCap: 12, researchRate: 13, warUntil: 14,
  // last step's aggregates that feed the era chain; kept here (not read back from
  // the series) so a restored snapshot replays exactly
  prevShortage: 15, prevFactions: 16, prevStability: 17, rivals: 18,
  flowSeq: 19, // id of the next discrete group of travellers (crew or ship), same in replays
  nGen: 20,    // generated inventions so far
} as const;
const NG = 24;

export interface SimState {
  step: number;
  S: Float64Array;         // bodies × NF
  g: Float64Array;         // globals
  techProg: Float64Array;  // knowledge spent per tech
  techDone: Float64Array;  // year unlocked, or -1
  ships: Float64Array;     // MAX_SHIPS × NSH
  settled: Int32Array;     // body ids with a settlement, in founding order
  shipRetry: Float64Array; // per system: year before which a failed ship search is not retried
  gen: Float64Array;       // generated inventions, MAX_GEN × GC (see GC)
  /** people per age bin (ages.ts), NAGE per settlement in founding order (settled[n] owns ages[n·NAGE..]) */
  ages: Float64Array;
  nSettled: number;
  rng: RngState;
}

export interface SimEvent { year: number; type: number; body: number; a: number; b: number }

interface Fx {
  extract: number; habitat: number; lifeSupport: number; energy: number; launch: number; research: number;
  productivity: number; death: number; growth: number; stability: number; hab: number; habHostile: number;
  reliability: number; war: number; secession: number; shipSpeed: number; voyage: number; fission: number;
  fusion: number; dyson: number; ftl: number; ftl2: number; probes: number; divergence: number; orbital: number;
  gompB: number; gompb: number;
}
const MULT_KEYS = new Set(['extract', 'habitat', 'lifeSupport', 'energy', 'launch', 'research', 'productivity', 'death', 'growth', 'war', 'secession', 'voyage', 'divergence', 'gompB']);

const RESEARCH = 10; // calibrates knowledge output to the tech tree's milestone years
const SHIP_MIN_HAB = 0.15;
const MIGRATE = 0.001; // share of a town's people per year who move to younger settlements in the same system
const REACH_OUTER = 1, REACH_RAD = 2, REACH_DEEP = 4;
const MINOR = new Set([EV.Famine, EV['Rich deposit found'], EV['Baby boom'], EV.Revolt, EV['Habitat breach'], EV['Probe survey']]);
const TECH_INDEX = new Map(TECHS.map((t, i) => [t.id, i]));
const TECH_REQ: number[][] = TECHS.map((t) => t.req.map((r) => TECH_INDEX.get(r)!));
const TECH_FLOOR = TECHS.map((t) => t.earliest - 0.25 * (t.earliest - 2040));

export class Engine {
  world: World;
  seed: number;
  st: SimState;
  techCostMult: Float64Array;
  /** per tech: 1 if this universe's physics allows it (rolled once per seed) */
  feasible: Uint8Array;
  wanderlust: number;
  fx!: Fx;
  logEvents = true;
  events: SimEvent[] = [];
  /** who moved where, per demography period; main run only (null on replay engines) */
  ledger: Ledger | null = new Ledger();
  /** discrete flows: G.flowSeq id → ledger flow index */
  flowIndex = new Map<number, number>();
  private generationShips = new Set<number>();
  /** global metric rows, one per step */
  series: Float64Array;
  years: number[];
  /** settlement history: rows of [step, body, ...HIST_FIELDS] every HIST_EVERY steps */
  hist: Float32Array;
  histLen = 0;
  static HIST_EVERY = 4;

  // static per-body lookups
  private bSys: Int32Array; private bHab: Float64Array; private bFlux: Float64Array; private bG: Float64Array;
  private bRes: Float64Array; private bSettle: Uint8Array; private bReach: Uint8Array; private bArea: Float64Array; private sysX: Float64Array; private sysY: Float64Array;
  private sysZ: Float64Array; private sysRegion: Uint8Array; private nbr: Neighbours;
  /** per system: neighbours before this index have nothing left to survey (a cache, rebuilt after restore) */
  private surveyCursor: Int32Array;
  private sysBodies: number[][];
  private migW: Float64Array; private migD: Float64Array;
  private recv: Float64Array; private sent: Float64Array; // per-body migration scratch, rebuilt every step // per-system scratch, rebuilt every step
  private swarmStamp: Int32Array; private sysLum: Float64Array; private tick = 0;
  /** body → index in st.settled (and its age bins), -1 if never settled; derived, rebuilt on restore */
  private pos: Int32Array;
  private mu = new Float64Array(NAGE);
  /** per body: this step's mortality law [A, B, b, under-5] for the people ledger (main run only) */
  private mort: Float64Array;

  constructor(world: World, seed: number) {
    this.world = world;
    this.seed = seed;
    const nb = world.bodies.length, ns = world.systems.length;
    this.bSys = new Int32Array(nb); this.bHab = new Float64Array(nb); this.bFlux = new Float64Array(nb);
    this.bG = new Float64Array(nb); this.bRes = new Float64Array(nb * 5); this.bSettle = new Uint8Array(nb);
    this.bReach = new Uint8Array(nb); this.bArea = new Float64Array(nb);
    world.bodies.forEach((b, i) => {
      this.bSys[i] = b.system; this.bHab[i] = b.hab; this.bFlux[i] = b.flux; this.bG[i] = b.g;
      this.bSettle[i] = b.settle ? 1 : 0;
      this.bArea[i] = Math.min(4, (b.radius / 3390) ** 2); // surface area, Mars = 1
      // crewed reach: the belt and beyond need nuclear propulsion, the Kuiper belt a fusion
      // drive, and Jupiter's radiation belts shielding
      this.bReach[i] = (b.flux < 0.3 ? REACH_OUTER : 0) | (b.flux < 1e-3 ? REACH_DEEP : 0) |
        (b.parent >= 0 && world.bodies[b.parent].name === 'Jupiter' ? REACH_RAD : 0);
      for (let k = 0; k < 5; k++) this.bRes[i * 5 + k] = b.res[k];
    });
    this.sysX = new Float64Array(ns); this.sysY = new Float64Array(ns); this.sysZ = new Float64Array(ns);
    this.sysRegion = new Uint8Array(ns);
    this.sysBodies = world.systems.map((s) => s.bodies);
    this.migW = new Float64Array(ns); this.migD = new Float64Array(ns);
    this.recv = new Float64Array(nb); this.sent = new Float64Array(nb);
    this.swarmStamp = new Int32Array(ns); this.sysLum = Float64Array.from(world.systems, (s) => s.lum);
    world.systems.forEach((s, i) => {
      this.sysX[i] = s.x; this.sysY[i] = s.y; this.sysZ[i] = s.z;
      this.sysRegion[i] = ({ sol: 0, local: 1, galaxy: 2, extra: 3 } as const)[s.region];
    });
    this.pos = new Int32Array(nb).fill(-1);
    this.mort = new Float64Array(nb * 4);
    this.nbr = neighbours(world);
    this.surveyCursor = this.nbr.start.slice();

    this.years = stepYears();
    this.series = new Float64Array(this.years.length * NGM);
    this.hist = new Float32Array(1 << 20);

    const rng = seedRng(seed);
    this.techCostMult = new Float64Array(TECHS.length);
    for (let i = 0; i < TECHS.length; i++) {
      // log-normal luck on every tech; speculative tech has fat tails
      const u = Math.max(1e-9, next(rng)), v = next(rng);
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const sigma = TECHS[i].era === 4 ? 1.4 : TECHS[i].era === 3 ? 0.7 : 0.5;
      this.techCostMult[i] = Math.exp(sigma * z);
    }
    this.feasible = Uint8Array.from(TECHS, (t) => (next(rng) < (t.feasible ?? 1) ? 1 : 0));
    // how keen this civilization is on colony ships: the main source of spread in reach
    this.wanderlust = Math.exp(0.6 * Math.sqrt(-2 * Math.log(Math.max(1e-9, next(rng)))) * Math.cos(2 * Math.PI * next(rng)));
    this.st = this.initialState(rng);
    this.recomputeFx();
    this.record(0);
  }


  private initialState(rng: RngState): SimState {
    const nb = this.world.bodies.length;
    const S = new Float64Array(nb * NF);
    for (let i = 0; i < nb; i++) S[i * NF + F.stage] = STAGE.NONE;
    const st: SimState = {
      step: 0, S, g: new Float64Array(NG), techProg: new Float64Array(TECHS.length),
      techDone: new Float64Array(TECHS.length).fill(-1), ships: new Float64Array(MAX_SHIPS * NSH),
      settled: new Int32Array(nb), nSettled: 0, rng, shipRetry: new Float64Array(this.world.systems.length),
      gen: new Float64Array(MAX_GEN * NGC), ages: new Float64Array(nb * NAGE),
    };
    this.st = st;
    st.g[G.era] = 0;
    st.g[G.launchCap] = 5000;
    st.g[G.faiths] = 6;
    const W = this.world;
    // Earth: 9.2 billion people, $160T/yr, 23 TW
    this.found(st, W.earth, STAGE.HUB, 9.2e9, -1, 0);
    const e = W.earth * NF;
    S[e + F.capital] = 9.2e9 * 60000; S[e + F.stability] = 0.62; S[e + F.medianAge] = 34;
    S[e + F.gini] = 0.62; S[e + F.water] = 1e12; S[e + F.metals] = 1e10; S[e + F.volatiles] = 1e10; S[e + F.rare] = 1e7;
    S[e + F.he3] = 0; S[e + F.gdp] = 1.6e14; S[e + F.energy] = 2.3e13; S[e + F.capacity] = 1.15e10; S[e + F.food] = 1;
    st.ages.set(earthBins(9.2e9), this.pos[W.earth] * NAGE);
    // the premise: first crew on Mars, an Artemis-era base on the Moon
    const moon = W.bodies.find((b) => b.name === 'Moon')!.id;
    this.found(st, W.mars, STAGE.OUTPOST, 12, W.earth, 0);
    this.found(st, moon, STAGE.OUTPOST, 40, W.earth, 0);
    S[e + F.pop] -= 52;
    this.travel(st, W.earth, W.mars, 12, 0, 0, FLOW.CREW);
    this.travel(st, W.earth, moon, 40, 0, 0, FLOW.CREW);
    // robotic probes have already visited most of the Solar System
    for (const b of this.sysBodies[0]) {
      if (b !== W.earth && b !== moon && b !== W.mars && this.bSettle[b]) this.found(st, b, STAGE.SURVEY, 0, W.earth, 0);
    }
    return st;
  }

  private found(st: SimState, body: number, stage: number, pop: number, parent: number, year: number): void {
    const S = st.S, o = body * NF;
    if (S[o + F.stage] === STAGE.NONE) { this.pos[body] = st.nSettled; st.settled[st.nSettled++] = body; }
    const ao = this.pos[body] * NAGE;
    for (let k = 0; k < NAGE; k++) st.ages[ao + k] = pop * CREW_AGES[k];
    S[o + F.stage] = stage;
    S[o + F.pop] = pop;
    S[o + F.founded] = year;
    S[o + F.parent] = parent;
    S[o + F.faction] = parent >= 0 ? S[parent * NF + F.faction] : body;
    S[o + F.culture] = parent >= 0 ? S[parent * NF + F.culture] : 0;
    S[o + F.stability] = 0.7;
    S[o + F.happiness] = 0.6;
    S[o + F.gini] = 0.25;
    S[o + F.medianAge] = medianAge(st.ages, ao);
    S[o + F.capital] = Math.max(S[o + F.capital], pop * 4e5 + (stage >= STAGE.OUTPOST ? 2e9 : 1e8));
    S[o + F.water] = pop * 5; S[o + F.metals] = pop * 2; S[o + F.volatiles] = pop * 2;
    S[o + F.energyRatio] = 1;
  }

  recomputeFx(): void {
    const fx: Fx = {
      extract: 1, habitat: 1, lifeSupport: 1, energy: 1, launch: 1, research: 1, productivity: 1, death: 1, growth: 1,
      stability: 0, hab: 0, habHostile: 0, reliability: 0, war: 1, secession: 1, shipSpeed: 0, voyage: 1, fission: 0,
      fusion: 0, dyson: 0, ftl: 0, ftl2: 0, probes: 0, divergence: 1, orbital: 0, gompB: 1, gompb: GM_b0,
    };
    TECHS.forEach((t: Tech, i) => {
      if (this.st.techDone[i] < 0) return;
      for (const [k, v] of Object.entries(t.fx) as [keyof Fx, number][]) {
        if (k === 'shipSpeed') fx.shipSpeed = Math.max(fx.shipSpeed, v);
        else if (k === 'gompb') fx.gompb = Math.min(fx.gompb, v);
        else if (MULT_KEYS.has(k)) fx[k] *= v;
        else fx[k] += v;
      }
    });
    fx.orbital = this.has('orbitalHabitats') ? 1 : 0;
    const gen = this.st.gen;
    for (let k = 0; k < this.st.g[G.nGen]; k++) {
      const key = EFFECTS[gen[k * NGC + GC.key]], size = gen[k * NGC + GC.size];
      if (key === 'shipSpeed') { if (fx.shipSpeed > 0) fx.shipSpeed += size; }
      else if (isAdd(key)) fx[key] += size;
      else if (isDown(key)) fx[key] /= size;
      else fx[key] *= size;
    }
    this.fx = fx;
  }

  rand(): number { return next(this.st.rng); }
  private has(id: string): boolean { return this.st.techDone[TECH_INDEX.get(id)!] >= 0; }

  private log(type: number, body: number, a = 0, b = 0): void {
    // routine local trouble is only worth a log line for big places
    if (MINOR.has(type) && body >= 0 && this.st.S[body * NF + F.pop] < 1e6) { this.st.S[body * NF + F.lastEvent] = type; return; }
    if (this.logEvents) this.events.push({ year: this.st.g[G.year], type, body, a, b });
    if (body >= 0) this.st.S[body * NF + F.lastEvent] = type;
  }

  get year(): number { return this.st.g[G.year]; }
  get done(): boolean { return this.st.step >= this.years.length - 1; }

  /** Advance one step. */
  step(): void {
    const st = this.st, S = st.S, g = st.g, fx = this.fx;
    const year = this.years[st.step];
    const dt = this.years[st.step + 1] - year;
    g[G.year] = year;

    // ---- era Markov chain. The state of the world reweights the ways out of the
    // current era (bible §0.2: modifiers touch off-diagonals only, each capped),
    // so a bad decade makes War likelier to start but never makes it last forever.
    const era = g[G.era];
    const shortage = g[G.prevShortage] / 100, stab = g[G.prevStability];
    const mod = [1, 1, stab > 0.65 ? 2 : 1, 1,
      (1 + 4 * shortage) * (1 + 0.2 * Math.min(g[G.rivals], 10)) * fx.war,  // war (bible §5.3)
      1,
      (1 + 6 * shortage) * (stab < 0.4 ? 3 : 1),                            // collapse
      era === 6 ? 1 + (year - g[G.eraSince]) / 50 : 1];                     // renaissance after a long dark
    const row = ERA_MATRIX[era].map((p, k) => (k === era ? 0 : p * Math.min(mod[k], 4)));
    let leave = row.reduce((a, b) => a + b, 0);
    if (leave > 0.95) { for (let k = 0; k < row.length; k++) row[k] *= 0.95 / leave; leave = 0.95; }
    const pStay = Math.pow(1 - leave, dt / 10);
    if (this.rand() > pStay) {
      let x = this.rand() * leave;
      for (let k = 0; k < row.length; k++) {
        if (k === era) continue;
        x -= row[k];
        if (x <= 0) { g[G.era] = k; g[G.eraSince] = year; this.log(EV['Era change'], -1, k, era); break; }
      }
    }
    const E = ERA_FX[g[G.era]];

    // ---- launch capacity from Earth (tonnes/year to orbit)
    const earth = this.world.earth, eo = earth * NF;
    const kessler = year < g[G.kesslerUntil] ? 0.3 : 1;
    g[G.launchCap] = 5000 * (1 / fx.launch) * E.launch * kessler * Math.pow(Math.max(S[eo + F.gdp], 1e13) / 1.6e14, 0.8) * (1 + year / 40);

    // ---- per settlement
    const swarm = this.swarmPower(year);
    this.tick++; // never repeats, even after a restore to an earlier step
    const tfp = fx.productivity * Math.pow(1 + g[G.knowledge] / 2000, 0.22);
    let research = 0;
    // migration inside a system: Earth (launch-limited) and every town or bigger send
    // people to the young settlements around the same star, weighted by free room
    const migW = this.migW.fill(0), migD = this.migD.fill(0);
    migD[0] = Math.min(g[G.launchCap] / 8, S[eo + F.pop] * 0.002) * (S[eo + F.stage] === STAGE.HUB ? 1 : 0.2);
    const earthOffer = migD[0];
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (b === earth || !isAlive(stg)) continue;
      if (stg <= STAGE.CITY) migW[this.bSys[b]] += Math.max(0, S[o + F.capacity] - S[o + F.pop]) ** 0.5;
      if (stg >= STAGE.COLONY) migD[this.bSys[b]] += S[o + F.pop] * MIGRATE;
    }
    // People are conserved: receivers take what fits, senders lose exactly that
    // much in proportion to what they offered, and the ledger records who went where.
    const recv = this.recv, sent = this.sent;
    const senders = new Map<number, number[]>(), receivers = new Map<number, number[]>(), got = new Map<number, number>();
    const contrib = (b: number) => (b === earth ? earthOffer : S[b * NF + F.pop] * MIGRATE);
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage], sy = this.bSys[b];
      recv[b] = 0; sent[b] = 0;
      if (!isAlive(stg) || migW[sy] <= 0 || migD[sy] <= 0) continue;
      if (b === earth || stg >= STAGE.COLONY) push(senders, sy, b);
      if (b !== earth && stg <= STAGE.CITY) {
        const room = Math.max(0, S[o + F.capacity] - S[o + F.pop]);
        recv[b] = Math.min(migD[sy] * room ** 0.5 / migW[sy], room / dt);
        if (recv[b] > 0) { push(receivers, sy, b); got.set(sy, (got.get(sy) ?? 0) + recv[b]); }
      }
    }
    for (const [sy, list] of senders) {
      const k = (got.get(sy) ?? 0) / migD[sy];
      for (const b of list) sent[b] = contrib(b) * k;
      if (!this.ledger) continue;
      for (const r of receivers.get(sy) ?? []) for (const b of list) this.ledger.migrate(b, r, recv[r] * contrib(b) / migD[sy] * dt);
    }

    const sysNet = new Map<number, Float64Array>(); // per-system resource pooling
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      const stg = S[o + F.stage];
      if (!isAlive(stg)) {
        S[o + F.births] = 0; S[o + F.deaths] = 0; S[o + F.gdp] = 0; S[o + F.energy] = stg === STAGE.SURVEY ? 2e3 : 0; S[o + F.research] = 0;
        continue;
      }
      const isEarth = b === earth;
      let pop = S[o + F.pop];
      const hab0 = this.bHab[b];
      const planetLike = hab0 >= 0.25 ? 1 : 0.3;
      const h = Math.min(1, hab0 + fx.hab * planetLike + fx.habHostile * (hab0 < 0.3 ? 1 : 0.4) + S[o + F.terraform]);

      // capacity
      // capacity: the stage sets what is built; land (radius^2) and, once O'Neill
      // cylinders exist, orbital habitats built from local metal set the room for it
      // cylinders exist, orbital habitats built from local metal (at most ~100 Island Threes)
      const dense = 1 + 0.25 * Math.log(fx.habitat);
      const hf = (0.15 + 0.85 * h) * dense;
      // the tiers above Megastructure add orbital room: rings, then swarm habitats (Bishop rings
      // ~3e12 m² each, so 1e9 people per tier is a handful of rings at Earth density)
      const room = 1e10 * this.bArea[b] * hf + (fx.orbital ? Math.min(1e9, STAGE_CAP[stg] * (0.1 + 0.2 * this.bRes[b * 5 + 1])) : 0) +
        (stg > STAGE.MEGA ? 1e9 * (stg - STAGE.MEGA) * (0.5 + this.bRes[b * 5 + 1]) : 0);
      const cap = isEarth ? 1.15e10 * dense : Math.min(STAGE_CAP[stg] * hf * Math.pow(fx.lifeSupport, 0.25), room);
      S[o + F.capacity] = cap;

      // energy (W per person)
      const flux = this.bFlux[b];
      const eTech = Math.pow(fx.energy, 0.3);
      const perCap = isEarth
        ? 2600 * eTech
        : 14000 * Math.max(Math.pow(Math.min(flux, 4), 0.5), fx.fission > 0 ? 1 : 0) * eTech;
      const need = isEarth ? 2000 : 9000 * (1.5 - 0.5 * h);
      const eRatio = perCap / need;
      S[o + F.energyRatio] = eRatio;
      S[o + F.energy] = pop * perCap + stg * 1e5;
      // the system's Dyson swarm is counted once, at its first hub, and grows with it
      if (swarm > 0 && stg >= STAGE.HUB && this.swarmStamp[this.bSys[b]] !== this.tick) {
        this.swarmStamp[this.bSys[b]] = this.tick;
        S[o + F.energy] += swarm * this.sysLum[this.bSys[b]] * Math.min(1, pop / 1e9);
      }

      // resources: self-sufficiency per resource, then stock dynamics
      const stageEff = isEarth ? 1 : 0.55 + 0.1 * Math.min(stg, 5);
      const ext = Math.sqrt(fx.extract) * stageEff;
      // recycling cuts water and air make-up; even a dry rock yields some of everything
      // (hydrated minerals, oxides), so production never falls below 20% of the richest
      const demand = [2 / fx.lifeSupport, 0.6, 0.5 / fx.lifeSupport, 0.01, fx.fusion ? 0.002 : 0];
      let net = sysNet.get(this.bSys[b]);
      if (!net) sysNet.set(this.bSys[b], (net = new Float64Array(5 + 1)));
      let worst = 1;
      for (let k = 0; k < 5; k++) {
        const D = pop * demand[k] + (k === 1 ? S[o + F.gdp] * 1e-6 : 0);
        const P = (D + (k === 4 ? 0.5 * pop * 0.002 : 0)) * (0.2 + this.bRes[b * 5 + k]) * 2.2 * ext * (isEarth ? 1.4 : 1);
        const stock = S[o + F.water + k] + (P - D) * dt;
        S[o + F.water + k] = Math.max(0, stock);
        net[k] += (P - D);
        if (k < 3 && D > 0) worst = Math.min(worst, (P + Math.max(0, stock) / dt) / D);
      }
      const energyOk = Math.min(1, eRatio);
      const food = Math.min(1, worst, energyOk * 1.2) * (fx.lifeSupport >= 1.5 ? 1 : 0.85 + 0.15 * h);
      S[o + F.food] = food;
      const short = Math.max(0, 1 - Math.min(food, energyOk));
      S[o + F.shortage] = short;

      // people: 12 age bins (ages.ts). Deaths are Σ N_x·μ_x from a Gompertz–Makeham law,
      // births come from a total fertility rate that follows the demographic transition.
      const crowd = cap > 0 ? pop / cap : 2;
      const N = st.ages, ao = this.pos[b] * NAGE;
      {
        // events, crews and ship arrivals change the head-count directly: keep the bins in step
        let sum = 0;
        for (let k = 0; k < NAGE; k++) sum += N[ao + k];
        if (sum > 0 && Math.abs(sum - pop) > 1e-9 * pop) { const f = pop / sum; for (let k = 0; k < NAGE; k++) N[ao + k] *= f; }
        else if (sum <= 0 && pop > 0) for (let k = 0; k < NAGE; k++) N[ao + k] = pop * CREW_AGES[k];
      }
      const gdppc = pop > 0 ? S[o + F.gdp] / pop : 0;
      // mortality law: extrinsic risk A rises on hostile worlds (bible §1.14 radiation, ~0.003/yr
      // unshielded), in famine and when overcrowded; medicine lowers B; only life extension moves b
      const mA = GM_A0 * fx.death + 0.003 * (1 - h) + 0.04 * short * short + (crowd > 1 ? 0.02 * (crowd - 1) : 0);
      const mB = GM_B0 * fx.gompB * Math.max(0.5, fx.death), mb = fx.gompb, mInf = infantHazard(gdppc);
      const law = { A: mA, B: mB, b: mb, inf: mInf };
      const mu = this.mu;
      for (let k = 0; k < NAGE; k++) mu[k] = binHazard(k, law) * E.death;
      this.mort[b * 4] = mA * E.death; this.mort[b * 4 + 1] = mB * E.death; this.mort[b * 4 + 2] = mb; this.mort[b * 4 + 3] = mInf * E.death;
      // fertility: the transition (ages.ts) plus colonists who want children while there is room
      // (colonial America TFR ≈ 7; bible §7.3 frontier growth ≈ 2.7%/yr; at TFR 1.6 + 2.5·(1 − N/K)
      // a colony levels off near 80% of its room), pronatalism on an Earth that has emptied below
      // 70% of its room (settles near half full), and fewer children past capacity
      let tfr = tfrTransition(gdppc);
      if (!isEarth) tfr += 2.5 * fx.growth * Math.max(0, 1 - crowd);
      else tfr += 1.5 * Math.max(0, 1 - crowd / 0.7);
      if (crowd > 1) tfr *= Math.max(0, (1.3 - crowd) / 0.3);
      tfr *= E.growth * (1 - short) * (0.8 + 0.4 * S[o + F.happiness]);
      if (stg === STAGE.OUTPOST) tfr *= 0.3; // rotating crews don't raise families
      let births = 0;
      for (let k = 2; k < 6; k++) births += 0.5 * N[ao + k] * tfr * FERT_SHARE[k] / AGE_W[k];
      // implicit step, youngest bin first: N' (1 + dt (1/w + μ)) = N + dt·inflow. Exact
      // bookkeeping (what leaves a bin enters the next), positive and stable for any dt.
      const pop0 = pop;
      let inflow = births, deathsDt = 0;
      for (let k = 0; k < NAGE; k++) {
        const out = k + 1 < NAGE ? 1 / AGE_W[k] : 0;
        const n1 = (N[ao + k] + dt * inflow) / (1 + dt * (out + mu[k]));
        deathsDt += dt * mu[k] * n1;
        inflow = n1 * out;
        N[ao + k] = n1;
      }
      // migrants arrive young, and leave from the working ages
      const immig = (recv[b] - sent[b]) * dt;
      if (immig > 0) for (let k = 0; k < NAGE; k++) N[ao + k] += immig * MIGRANT_AGES[k];
      else if (immig < 0) {
        let adults = 0;
        for (let k = 2; k < 6; k++) adults += N[ao + k];
        const f = adults > 0 ? Math.max(0, 1 + immig / adults) : 1;
        for (let k = 2; k < 6; k++) N[ao + k] *= f;
      }
      pop = 0;
      for (let k = 0; k < NAGE; k++) pop += N[ao + k];
      this.ledger?.addBirths(b, births * dt);
      if (pop > cap * 1.5) { const f = (cap * 1.5) / pop; for (let k = 0; k < NAGE; k++) N[ao + k] *= f; pop = cap * 1.5; }
      const deaths = deathsDt / dt;
      void pop0;
      S[o + F.births] = births; S[o + F.deaths] = deaths; S[o + F.imports] = Math.max(0, immig / dt) * 10;
      S[o + F.tfr] = tfr; S[o + F.lifeExp] = lifeExpectancyBins(mu); S[o + F.medianAge] = medianAge(N, ao);

      // economy
      const kpc = pop > 0 ? S[o + F.capital] / pop : 0;
      const y0 = isEarth ? 17400 : 30000;
      const gdp = pop * y0 * tfp * Math.sqrt(energyOk) * Math.pow(Math.max(kpc, 1000) / 60000, 0.3) * (1 - 0.6 * short) * (stg >= STAGE.HUB ? 1.3 : 1);
      S[o + F.gdp] = gdp;
      S[o + F.capital] = Math.max(0, S[o + F.capital] + (0.22 * gdp - 0.04 * S[o + F.capital]) * dt);
      S[o + F.military] = gdp * (0.015 + (g[G.era] === 4 ? 0.08 : 0) + (S[o + F.faction] !== b || isEarth ? 0 : 0.03));
      S[o + F.robots] = S[o + F.capital] / 2e6 * (fx.productivity > 1.4 ? 3 : 1);

      // research
      const r = Math.pow(pop / 1e9, 0.7) * Math.pow(Math.max(gdp / Math.max(pop, 1), 1) / 17400, 0.6) * 9 * RESEARCH * fx.research * E.research + S[o + F.robots] * 1e-9 * fx.research;
      S[o + F.research] = r;
      research += r;

      // society
      const lag = this.lagToCapital(b);
      const stabTarget = 0.72 - 0.55 * short - 0.3 * Math.max(0, S[o + F.gini] - 0.35) + fx.stability + E.stab * 12 - (crowd > 1 ? 0.2 : 0) - Math.min(0.15, lag / 200);
      S[o + F.stability] = clamp01(S[o + F.stability] + (stabTarget - S[o + F.stability]) * Math.min(1, 0.08 * dt) + (this.rand() - 0.5) * 0.03 * Math.sqrt(dt));
      S[o + F.happiness] = clamp01(0.25 + 0.4 * S[o + F.stability] + 0.25 * Math.min(1, gdp / Math.max(pop, 1) / 60000) - 0.4 * short + (this.rand() - 0.5) * 0.02);
      const giniT = 0.28 + (stg >= STAGE.CITY ? 0.12 : 0) + 0.15 * short + (isEarth ? 0.25 : 0) - fx.stability;
      S[o + F.gini] = clamp01(S[o + F.gini] + (giniT - S[o + F.gini]) * Math.min(1, 0.03 * dt));
      const div0 = S[o + F.divergence];
      S[o + F.divergence] += dt * 0.0006 * fx.divergence * Math.pow(Math.abs(1 - this.bG[b]), 1.5) * (this.bSys[b] === 0 ? 0.4 : 1) * (isEarth ? 0 : 1);
      if (div0 < 1 && S[o + F.divergence] >= 1) this.log(EV.Speciation, b);
      if (fx.hab > 0.1 && h < 0.8 && stg >= STAGE.CITY) S[o + F.terraform] = Math.min(0.5, S[o + F.terraform] + dt * 0.0008 * fx.hab);

      S[o + F.pop] = pop;

      // ---- stage transitions (Markov)
      if (pop < 1 && stg >= STAGE.OUTPOST) {
        S[o + F.stage] = STAGE.ABANDONED; S[o + F.pop] = 0; this.log(EV.Abandoned, b); continue;
      }
      if (!isEarth) this.stageUp(b, o, stg, pop, cap, short, dt);
      this.localEvents(b, o, stg, dt, short);
    }

    // ---- pool resources inside each system (trade by freighter)
    const tradeEff = fx.extract > 1.6 ? 0.85 : 0.6;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (!isAlive(stg)) continue;
      const net = sysNet.get(this.bSys[b])!;
      let exp = 0, imp = 0;
      for (let k = 0; k < 3; k++) {
        if (S[o + F.water + k] < S[o + F.pop] * 1 && net[k] > 0) {
          const give = Math.min(net[k] * tradeEff * 0.5, S[o + F.pop] * 3) * dt;
          S[o + F.water + k] += give; imp += give / dt;
        } else if (net[k] > 0) exp += net[k] * 0.01;
      }
      S[o + F.imports] += imp; S[o + F.exports] = exp;
    }

    // ---- research and technology
    research *= 1 + (g[G.contact] === 1 ? 2 : 0);
    g[G.researchRate] = research;
    g[G.knowledge] += research * dt;
    this.research(research * dt, year);

    // ---- expansion, ships, politics, rare global events
    this.expand(dt, year, E.launch);
    this.ships(year);
    this.politics(dt, year, E.war);
    this.globalEvents(dt, year);

    // series row k always describes the state at years[k], the same state a snapshot at step k holds
    st.step++;
    g[G.year] = this.years[st.step];
    this.record(st.step);
    if (this.ledger && (isPeriodBoundary(g[G.year]) || this.done)) {
      const p = this.done ? NPERIODS - 1 : periodOf(g[G.year]) - 1;
      this.ledger.close(p, (fn) => {
        for (let n = 0; n < st.nSettled; n++) {
          const b = st.settled[n];
          fn(b, Math.max(0, Math.round(S[b * NF + F.pop])));
          // the period's mortality law, so the census's deaths fall by age as the engine's did
          if (S[b * NF + F.pop] > 0) this.ledger!.setMortality(b, p, this.mort[b * 4], this.mort[b * 4 + 1], this.mort[b * 4 + 2], this.mort[b * 4 + 3]);
        }
      });
    }
  }

  /** A discrete group of travellers (founding crew or ship). Returns its id. */
  private travel(st: SimState, src: number, dst: number, n: number, depart: number, arrive: number, kind: number): number {
    const id = st.g[G.flowSeq]++;
    if (!this.ledger) return id;
    const long = (kind === FLOW.SHIP || kind === FLOW.FTL) && arrive - depart > GENERATION;
    const fi = long ? this.ledger.voyage(id, src, dst, n, depart, arrive, kind) : this.ledger.depart(src, dst, n, depart, arrive, kind);
    this.flowIndex.set(id, fi);
    if (kind === FLOW.SHIP || kind === FLOW.FTL) this.ledger.ships.set(id, { src, dst, n: Math.round(n), depart, arrive, flow: fi, generation: long });
    if (long) this.generationShips.add(id);
    return id;
  }

  /** Watts a Dyson swarm around a 1 L_sun star captures by now. Phase I is ~1e16 W
   *  (bible M15); phase II then grows e-fold every 60 years to half the star. */
  private swarmPower(year: number): number {
    const d = this.st.techDone, t1 = d[TECH_INDEX.get('dyson1')!], t2 = d[TECH_INDEX.get('dyson2')!];
    if (t1 < 0) return 0;
    let cov = 2.6e-11 * Math.min(1, (year - t1) / 50 + 0.1);
    if (t2 >= 0) cov = Math.max(cov, Math.min(this.has('starLifting') ? 0.9 : 0.5, 2.6e-7 * Math.exp((year - t2) / 60)));
    return cov * 3.846e26;
  }

  private lagToCapital(b: number): number {
    const cap = this.st.S[b * NF + F.faction] | 0;
    if (cap === b) return 0;
    const s1 = this.bSys[b], s2 = this.bSys[cap];
    return Math.hypot(this.sysX[s1] - this.sysX[s2], this.sysY[s1] - this.sysY[s2], this.sysZ[s1] - this.sysZ[s2]);
  }

  private stageUp(b: number, o: number, stg: number, pop: number, cap: number, short: number, dt: number): void {
    const S = this.st.S, fx = this.fx, done = this.st.techDone;
    const has = (id: string) => done[TECH_INDEX.get(id)!] >= 0;
    if (short > 0.25 || S[o + F.stability] < 0.35) {
      // collapse: a bad stage can fall
      const pc = dt * (0.0008 + 0.04 * short * short + (S[o + F.stability] < 0.2 ? 0.02 : 0)) * (1 - fx.reliability);
      if (stg > STAGE.OUTPOST && this.rand() < pc) {
        S[o + F.stage] = stg - 1; S[o + F.pop] = pop * 0.45; S[o + F.capital] *= 0.5;
        this.log(EV.Collapse, b, stg - 1);
      }
      return;
    }
    if (stg >= STAGE.UPLOADED || pop < cap * 0.65 || pop < STAGE_CAP[stg] * 0.2) return;
    // the far-future ladder: each tier needs its technology, and the star-scale ones a share
    // of the star's light actually captured (W, against L* in watts)
    const Lstar = this.sysLum[this.bSys[b]] * 3.846e26, E = S[o + F.energy];
    const gate =
      stg === STAGE.OUTPOST ? has('closedLoop') :
      stg === STAGE.BASE ? has('isru') :
      stg === STAGE.COLONY ? has('synthBio') :
      stg === STAGE.TOWN ? has('regolith') && (has('fusion') || this.bFlux[b] > 0.3) :
      stg === STAGE.CITY ? has('asteroidMining') && has('orbitalHabitats') :
      stg === STAGE.HUB ? has('dyson1') || has('bishopRings') :
      stg === STAGE.MEGA ? has(STAGE_TECH[STAGE.RING]!) && E >= pop * 1e4 :
      stg === STAGE.RING ? has(STAGE_TECH[STAGE.SWARM]!) && E >= 1e-4 * Lstar :
      stg === STAGE.SWARM ? has(STAGE_TECH[STAGE.BRAIN]!) && E >= 1e-2 * Lstar :
      stg === STAGE.BRAIN ? has(STAGE_TECH[STAGE.LIFTED]!) && E >= 0.1 * Lstar :
      stg === STAGE.LIFTED ? has(STAGE_TECH[STAGE.UPLOADED]!) && E >= pop * 1e6 : false;
    if (!gate) return;
    const p = dt * (stg < STAGE.MEGA ? [0, 0.12, 0.06, 0.04, 0.025, 0.015, 0.006][stg] : 0.004);
    if (this.rand() < p) {
      S[o + F.stage] = stg + 1;
      this.log(stg + 1 === STAGE.MEGA ? EV['Megastructure complete'] : EV['Stage up'], b, stg + 1);
    }
  }

  private localEvents(b: number, o: number, stg: number, dt: number, short: number): void {
    const S = this.st.S, fx = this.fx;
    const r = () => this.rand();
    const pop = S[o + F.pop];
    if (b === this.world.earth) {
      if (r() < dt * 0.003 * ERA_FX[this.st.g[G.era]].death) { S[o + F.pop] *= 0.97; this.log(EV.Plague, b, 0.03); }
      return;
    }
    const rel = Math.min(0.9, fx.reliability);
    if (stg <= STAGE.COLONY && r() < dt * 0.012 * (1 - rel)) {
      // a lost module: a few people, or up to 2% of a bigger place
      const k = Math.min(0.5, r() * 0.02 + (2 + r() * 8) / Math.max(pop, 1)); S[o + F.pop] *= 1 - k; S[o + F.stability] -= 0.03; this.log(EV['Habitat breach'], b, k);
    }
    if (this.bSys[b] === 0 && this.bFlux[b] > 0.2 && stg <= STAGE.TOWN && r() < dt * 0.01) {
      const k = 0.001 + r() * 0.01; S[o + F.pop] *= 1 - k; this.log(EV['Solar storm'], b, k);
    }
    if (r() < dt * 0.00015) {
      const k = 0.1 + r() * 0.6; S[o + F.pop] *= 1 - k; S[o + F.capital] *= 1 - k; this.log(EV['Asteroid strike'], b, k);
      if (k > 0.65 && stg <= STAGE.COLONY) { S[o + F.stage] = STAGE.DEAD; S[o + F.pop] = 0; this.st.g[G.dead]++; return; }
    }
    if (pop > 1e5 && r() < dt * 0.0015 * ERA_FX[this.st.g[G.era]].death) {
      const k = 0.02 + r() * 0.15; S[o + F.pop] *= 1 - k; this.log(EV.Plague, b, k);
    }
    if (short > 0.3 && r() < dt * 0.1) { S[o + F.pop] *= 1 - short * 0.1; this.log(EV.Famine, b, short); }
    if (S[o + F.stability] < 0.3 && r() < dt * 0.05) { S[o + F.capital] *= 0.9; S[o + F.stability] += 0.1; this.log(EV.Revolt, b); }
    if (pop > 1e6 && r() < dt * 0.0006) { this.st.g[G.faiths]++; S[o + F.culture] = this.st.g[G.faiths]; this.log(EV['New faith'], b, this.st.g[G.faiths]); }
    if (stg <= STAGE.TOWN && r() < dt * 0.003) {
      const k = Math.floor(r() * 5); S[o + F.water + k] += pop * 40 + 1e4; this.log(EV['Rich deposit found'], b, k);
    }
    if (fx.fission && !fx.fusion && r() < dt * 0.0008) { S[o + F.pop] *= 0.98; this.log(EV['Reactor accident'], b); }
    if (S[o + F.happiness] > 0.7 && S[o + F.pop] < S[o + F.capacity] && r() < dt * 0.001) { this.ledger?.addBirths(b, S[o + F.pop] * 0.03); S[o + F.pop] *= 1.03; this.log(EV['Baby boom'], b); }
    if (pop > 1e7 && S[o + F.research] > 0 && r() < dt * 0.0012) { this.st.g[G.knowledge] += S[o + F.research] * 30; this.log(EV.Breakthrough, b); }
  }

  private research(amount: number, year: number): void {
    const st = this.st;
    const frontier: number[] = [];
    let w = 0;
    for (let i = 0; i < TECHS.length; i++) {
      // progress < 0 marks a tech proven impossible in this universe
      if (st.techDone[i] >= 0 || st.techProg[i] < 0) continue;
      if (TECH_REQ[i].every((j) => st.techDone[j] >= 0)) { frontier.push(i); w += 1 / TECHS[i].cost; }
    }
    if (!frontier.length) return;
    let changed = false;
    for (const i of frontier) {
      st.techProg[i] += amount * (1 / TECHS[i].cost) / w;
      if (st.techProg[i] < TECHS[i].cost * this.techCostMult[i] || year + YEAR0 < TECH_FLOOR[i]) continue;
      if (!this.feasible[i]) { st.techProg[i] = -1; this.log(EV['No-go theorem'], this.pickLab(-1), i); continue; }
      st.techDone[i] = year; changed = true;
      // an invention happens somewhere: a lab picked in proportion to its research,
      // and now and then a second, independent one at the same time (Merton's multiples)
      const where = this.pickLab(-1), twin = this.rand() < 0.12 ? this.pickLab(where) : -1;
      this.log(EV.Technology, where, i, twin);
    }
    if (this.invent(amount, year)) changed = true;
    if (changed) this.recomputeFx();
  }

  private pairs = new Set<number>();
  private keyCount = new Float64Array(EFFECTS.length);
  private rebuildPairs(): void {
    this.pairs.clear(); this.keyCount.fill(0);
    const gen = this.st.gen;
    for (let k = 0; k < this.st.g[G.nGen]; k++) {
      this.pairs.add(pairKey(gen[k * NGC + GC.a], gen[k * NGC + GC.b]));
      this.keyCount[gen[k * NGC + GC.key]]++;
    }
  }

  /** Recombination: two known technologies become a new, named invention (invention-model §4). */
  private invent(amount: number, year: number): boolean {
    const st = this.st, g = st.g, gen = st.gen;
    if (g[G.nGen] >= MAX_GEN || amount <= 0) return false;
    const known: number[] = [];
    for (let i = 0; i < TECHS.length; i++) if (st.techDone[i] >= 0) known.push(i);
    const nG = g[G.nGen];
    if (known.length + nG < 2) return false;
    const dt = this.years[st.step + 1] - this.years[st.step];
    const lambda = dt * 0.14 * Math.log10(1 + g[G.researchRate]) * Math.exp(-nG / 900);
    let n = Math.floor(lambda) + (this.rand() < lambda % 1 ? 1 : 0);
    n = Math.min(n, 6);
    let made = false;
    const pick = () => { const j = Math.floor(this.rand() * (known.length + nG)); return j < known.length ? known[j] : TECHS.length + (j - known.length); };
    const fieldOf = (t: number): Field => (t < TECHS.length ? spineField(t) : FIELDS[gen[(t - TECHS.length) * NGC + GC.field]]);
    const depthOf = (t: number) => (t < TECHS.length ? 0 : gen[(t - TECHS.length) * NGC + GC.depth]);
    for (let tries = 0; n > 0 && tries < n * 6; tries++) {
      const a = pick(), b = pick();
      if (a === b || this.pairs.has(pairKey(a, b))) continue;
      const fa = fieldOf(a), fb = fieldOf(b), depth = 1 + Math.max(depthOf(a), depthOf(b));
      if (depth > 3 || this.rand() > compat(fa, fb)) continue;
      const key = effectFor(fa, fb, this.rand());
      const ki = EFFECTS.indexOf(key);
      // heavy-tailed value: most inventions are refinements, a few change everything
      const u = Math.max(1e-9, this.rand()), v = this.rand();
      const r = Math.min(5, Math.exp(0.8 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) - 0.32));
      const o = g[G.nGen] * NGC;
      gen[o + GC.a] = a; gen[o + GC.b] = b; gen[o + GC.key] = ki; gen[o + GC.size] = effectSize(key, r, depth, this.keyCount[ki]);
      gen[o + GC.year] = year; gen[o + GC.place] = this.pickLab(-1); gen[o + GC.depth] = depth;
      gen[o + GC.field] = FIELDS.indexOf(fa); gen[o + GC.other] = FIELDS.indexOf(fb); gen[o + GC.r] = r;
      this.pairs.add(pairKey(a, b)); this.keyCount[ki]++;
      this.log(EV.Invention, gen[o + GC.place], g[G.nGen], r);
      g[G.nGen]++;
      n--; made = true;
    }
    return made;
  }

  private pickLab(not: number): number {
    const S = this.st.S;
    let total = 0;
    for (let n = 0; n < this.st.nSettled; n++) { const b = this.st.settled[n]; if (b !== not) total += Math.max(0, S[b * NF + F.research]); }
    let x = this.rand() * total;
    for (let n = 0; n < this.st.nSettled; n++) {
      const b = this.st.settled[n];
      if (b === not) continue;
      x -= Math.max(0, S[b * NF + F.research]);
      if (x <= 0 && S[b * NF + F.research] > 0) return b;
    }
    return not === this.world.earth ? -1 : this.world.earth;
  }

  private expand(dt: number, year: number, eraLaunch: number): void {
    const st = this.st, S = st.S, fx = this.fx;
    const earth = this.world.earth;
    // probes survey nearby systems
    if (fx.probes > 0) {
      const n = Math.floor(fx.probes * dt * 0.05 + this.rand());
      for (let k = 0; k < n; k++) {
        const src = st.settled[Math.floor(this.rand() * st.nSettled)];
        const t = this.pickTarget(src, 6 + fx.probes * 1.5 + year * 0.02, true);
        if (t >= 0) { this.found(st, t, STAGE.SURVEY, 0, src, year); this.log(EV['Probe survey'], t); }
      }
    }
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (stg < STAGE.BASE || !isAlive(stg) || S[o + F.stability] < 0.35) continue;
      const isEarth = b === earth;
      const gdp = S[o + F.gdp];
      // in-system: send a crew to a surveyed or empty body in the same system
      const pLocal = dt * 0.03 * eraLaunch * Math.min(3, Math.pow(gdp / 5e10, 0.25)) * (isEarth ? 2 : 1);
      if (this.rand() < pLocal) {
        const sysB = this.sysBodies[this.bSys[b]];
        let best = -1, bestS = 0;
        for (const t of sysB) {
          const ts = S[t * NF + F.stage];
          if (!this.bSettle[t] || (ts !== STAGE.NONE && ts !== STAGE.SURVEY && ts !== STAGE.ABANDONED)) continue;
          if (this.bHab[t] < 0.1 && fx.habHostile < 0.06) continue;
          const rq = this.bReach[t];
          if ((rq & REACH_OUTER && !this.has('ntp')) || (rq & REACH_DEEP && !this.has('fusionDrive')) || (rq & REACH_RAD && !this.has('radShield'))) continue;
          const sc = (this.bHab[t] + 0.15 * (this.bRes[t * 5] + this.bRes[t * 5 + 1])) * (0.5 + this.rand());
          if (sc > bestS) { bestS = sc; best = t; }
        }
        // nobody can send more people than they have
        const crew = best >= 0 ? Math.min(Math.floor(S[o + F.pop]) - 1, isEarth ? 8 + Math.floor(this.rand() * 30) : 20 + Math.floor(this.rand() * 200)) : 0;
        if (best >= 0 && crew >= 4) {
          this.found(st, best, STAGE.OUTPOST, crew, b, year);
          S[o + F.pop] = Math.max(0, S[o + F.pop] - crew);
          this.travel(st, b, best, crew, year, year, FLOW.CREW);
          this.log(EV['Colony founded'], best, b, 0);
        }
      }
      // interstellar: needs a drive, a colony with money, and a stable home
      if (fx.shipSpeed <= 0 || stg < STAGE.CITY) continue;
      const shipCost = 4e12 / Math.sqrt(fx.productivity);
      const pShip = dt * 0.0008 * this.wanderlust * eraLaunch * Math.min(4, Math.sqrt(gdp / shipCost)) * (isEarth ? 3 : 1);
      if (this.rand() < pShip && S[o + F.capital] > shipCost) {
        let target = -1, ftlTrip = false;
        if (fx.ftl > 0 && stg >= STAGE.HUB && this.rand() < 0.25 * fx.ftl) {
          target = this.pickRemote(fx.ftl2 > 0 && this.rand() < 0.3 ? 3 : 2); ftlTrip = true;
        } else {
          // a home with nothing left in range stops looking for a while
          if (year < st.shipRetry[this.bSys[b]]) continue;
          target = this.pickTarget(b, fx.shipSpeed * 200 * Math.sqrt(fx.voyage), false);
          if (target < 0) st.shipRetry[this.bSys[b]] = year + 50;
        }
        if (target < 0) continue;
        const d = this.dist(b, target);
        const travel = ftlTrip ? 3 + this.rand() * 10 : d / fx.shipSpeed + 4;
        const colonists = fx.reliability > 0.25 ? 300 + this.rand() * 2000 : 1000 + this.rand() * 5000;
        if (!this.launch(b, target, year, year + travel, colonists, ftlTrip ? 1 : 0)) continue;
        S[o + F.capital] -= shipCost;
        S[o + F.pop] -= colonists;
      }
    }
  }

  private dist(a: number, b: number): number {
    const s1 = this.bSys[a], s2 = this.bSys[b];
    return Math.hypot(this.sysX[s1] - this.sysX[s2], this.sysY[s1] - this.sysY[s2], this.sysZ[s1] - this.sysZ[s2]);
  }

  /** Best unsettled body in another system within range of `from`. Looks at the nearest candidates only. */
  private pickTarget(from: number, range: number, survey: boolean): number {
    const S = this.st.S, s0 = this.bSys[from], N = this.nbr;
    const R = Math.min(range, MAX_HOP);
    let best = -1, bestScore = 0, seen = 0, prefix = survey;
    for (let i = survey ? this.surveyCursor[s0] : N.start[s0], end = N.start[s0 + 1]; i < end && seen < 40; i++) {
      const d = N.d[i];
      if (d > R) break;
      const seen0 = seen;
      for (const t of this.sysBodies[N.sys[i]]) {
        const ts = S[t * NF + F.stage];
        if (!this.bSettle[t]) continue;
        if (survey ? ts !== STAGE.NONE : ts !== STAGE.NONE && ts !== STAGE.SURVEY && ts !== STAGE.ABANDONED) continue;
        // colony ships only go where people can live off the land; the rest of a system fills in locally
        if (!survey && (this.bHab[t] < SHIP_MIN_HAB || S[t * NF + F.inbound] > 0)) continue;
        seen++;
        const sc = (this.bHab[t] + 0.1 * (this.bRes[t * 5] + this.bRes[t * 5 + 1]) + (ts === STAGE.SURVEY ? 0.15 : 0)) / Math.pow(d + 3, 1.3) * (0.6 + 0.8 * this.rand());
        if (sc > bestScore) { bestScore = sc; best = t; }
      }
      // surveyed systems never become unsurveyed, so skip them next time
      if (prefix && seen === seen0) this.surveyCursor[s0] = i + 1;
      else prefix = false;
    }
    return best;
  }

  private pickRemote(region: number): number {
    const sys = this.world.systems;
    for (let tries = 0; tries < 20; tries++) {
      const s = Math.floor(this.rand() * sys.length);
      if (this.sysRegion[s] !== region) continue;
      const t = this.sysBodies[s][0];
      if (t !== undefined && this.st.S[t * NF + F.stage] === STAGE.NONE) return t;
    }
    return -1;
  }

  private launch(from: number, to: number, depart: number, arrive: number, colonists: number, kind: number): boolean {
    const st = this.st;
    const n = st.g[G.nShips];
    if (n >= MAX_SHIPS) return false;
    const o = n * NSH;
    st.ships[o + SH.from] = from; st.ships[o + SH.to] = to; st.ships[o + SH.depart] = depart;
    st.ships[o + SH.arrive] = arrive; st.ships[o + SH.colonists] = colonists; st.ships[o + SH.kind] = kind;
    st.ships[o + SH.flow] = this.travel(st, from, to, colonists, depart, arrive, kind === 1 ? FLOW.FTL : FLOW.SHIP);
    this.log(EV['Ship launched'], from, to, st.ships[o + SH.flow]);
    st.g[G.nShips] = n + 1;
    st.g[G.shipsLaunched]++;
    // reserve the target so two ships don't race for it
    if (st.S[to * NF + F.stage] === STAGE.NONE) this.found(st, to, STAGE.SURVEY, 0, from, depart);
    st.S[to * NF + F.inbound]++;
    return true;
  }

  private ships(year: number): void {
    const st = this.st, sh = st.ships, fx = this.fx;
    let n = st.g[G.nShips];
    for (let i = 0; i < n; i++) {
      const o = i * NSH;
      if (sh[o + SH.arrive] > year) continue;
      const from = sh[o + SH.from], to = sh[o + SH.to], colonists = sh[o + SH.colonists];
      const voyage = sh[o + SH.arrive] - sh[o + SH.depart];
      st.S[to * NF + F.inbound]--;
      const seq = sh[o + SH.flow], gen = this.generationShips.has(seq);
      const pOk = Math.max(0.2, Math.min(0.97, 0.82 + fx.reliability - 0.12 * (voyage / 200)));
      if (this.rand() < pOk) {
        const ts = st.S[to * NF + F.stage];
        // someone got there first (a local crew): the ship just adds people
        const joined = isAlive(ts);
        if (joined) {
          st.S[to * NF + F.pop] += colonists;
          st.S[to * NF + F.stage] = Math.max(ts, colonists > 2000 ? STAGE.COLONY : STAGE.BASE);
        }
        else {
          this.found(st, to, colonists > 2000 ? STAGE.COLONY : STAGE.BASE, colonists, from, year);
          st.S[to * NF + F.capital] = colonists * 3e5;
          // years of light-lag from home: de facto independent from the day they land
          if (this.bSys[to] !== this.bSys[from]) st.S[to * NF + F.faction] = to;
        }
        if (gen) this.ledger?.land(seq, to, colonists, year, false);
        if (this.rand() < 0.08) { st.S[to * NF + F.stability] = 0.4; this.log(EV['Mutiny in transit'], to, from); }
        if (!joined) this.log(EV['Colony founded'], to, from, 1);
        this.log(EV['Ship arrived'], to, from, seq);
      } else {
        st.g[G.shipsLost]++;
        const fi = this.flowIndex.get(seq);
        if (gen) this.ledger?.land(seq, to, colonists, year, true);
        else if (this.ledger && fi !== undefined) this.ledger.flows[fi].lost = true;
        if (st.S[to * NF + F.stage] === STAGE.SURVEY && st.S[to * NF + F.pop] === 0) st.S[to * NF + F.parent] = -1;
        this.log(EV['Ship lost'], to, from, seq);
      }
      // swap-remove
      n--;
      sh.copyWithin(o, n * NSH, n * NSH + NSH);
      i--;
    }
    st.g[G.nShips] = n;
  }

  private politics(dt: number, year: number, eraWar: number): void {
    const st = this.st, S = st.S, fx = this.fx;
    // independence
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (stg < STAGE.COLONY || !isAlive(stg) || S[o + F.faction] === b) continue;
      const lag = this.lagToCapital(b);
      const sol = this.bSys[b] === 0;
      const p = dt * fx.secession * (1 - S[o + F.stability]) * (sol ? (S[o + F.pop] > 1e6 ? 0.008 : 0) : 0.012 * Math.sqrt(lag / 5));
      if (this.rand() < p) {
        const old = S[o + F.faction];
        // the colony and everything it founded leave together
        for (let m = 0; m < st.nSettled; m++) {
          const c = st.settled[m];
          if (c === b || (S[c * NF + F.faction] === old && this.isDescendant(c, b))) S[c * NF + F.faction] = b;
        }
        this.log(EV.Independence, b, old);
      }
    }
    // war: only between factions that share a star system (light-lag under a day)
    const sysFac = new Map<number, number[]>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!isAlive(S[o + F.stage])) continue;
      const f = S[o + F.faction], s = this.bSys[b];
      const l = sysFac.get(s);
      if (!l) sysFac.set(s, [f]);
      else if (!l.includes(f)) l.push(f);
    }
    const contested: number[][] = [];
    let rivals = 0;
    for (const l of sysFac.values()) if (l.length > 1) { contested.push(l); rivals += l.length - 1; }
    st.g[G.rivals] = rivals;
    if (!rivals) return;
    const pWar = dt * 0.004 * eraWar * fx.war * Math.sqrt(Math.min(rivals, 16));
    if (this.rand() < pWar) {
      const l = contested[Math.floor(this.rand() * contested.length)];
      const i = Math.floor(this.rand() * l.length);
      const a = l[i], bF = l[(i + 1 + Math.floor(this.rand() * (l.length - 1))) % l.length];
      st.g[G.wars]++;
      const sev = 0.02 + this.rand() * 0.2;
      for (let n = 0; n < st.nSettled; n++) {
        const c = st.settled[n], o = c * NF;
        const f = S[o + F.faction];
        if ((f !== a && f !== bF) || !isAlive(S[o + F.stage])) continue;
        if (this.dist(c, a) > 25 && fx.ftl === 0) continue;
        const k = sev * (0.5 + this.rand());
        S[o + F.pop] *= 1 - k; S[o + F.capital] *= 1 - k; S[o + F.stability] = Math.max(0, S[o + F.stability] - 0.15);
        if (S[o + F.stage] <= STAGE.BASE && this.rand() < sev) {
          S[o + F.stage] = STAGE.DEAD; S[o + F.pop] = 0; st.g[G.dead]++;
        }
      }
      this.log(EV.War, a, bF, sev);
    }
  }

  private isDescendant(c: number, root: number): boolean {
    const S = this.st.S;
    for (let k = 0; k < 64 && c >= 0; k++) {
      if (c === root) return true;
      c = S[c * NF + F.parent];
    }
    return false;
  }

  private globalEvents(dt: number, year: number): void {
    const st = this.st, S = st.S, g = st.g;
    if (year < 300 && year > g[G.kesslerUntil] && this.rand() < dt * 0.003) {
      g[G.kesslerUntil] = year + 15 + this.rand() * 25; this.log(EV['Kessler cascade'], this.world.earth);
    }
    // first contact: very rare, only once
    if (year > 400 && g[G.contact] === 0 && this.rand() < dt * 1.5e-5 * Math.log10(10 + st.nSettled)) {
      const x = this.rand();
      if (x < 0.6) { g[G.contact] = 1; this.log(EV['First contact'], -1, 1); }
      else if (x < 0.8) { g[G.contact] = 2; this.log(EV['First contact'], -1, 0); }
      else {
        g[G.contact] = 3;
        // dark forest: the most visible system is erased
        let best = -1, bestE = 0;
        for (let n = 0; n < st.nSettled; n++) {
          const b = st.settled[n];
          if (this.bSys[b] !== 0 && S[b * NF + F.energy] > bestE) { bestE = S[b * NF + F.energy]; best = b; }
        }
        if (best >= 0) {
          for (const t of this.sysBodies[this.bSys[best]]) if (S[t * NF + F.stage] >= 0) { S[t * NF + F.stage] = STAGE.DEAD; S[t * NF + F.pop] = 0; g[G.dead]++; }
          this.log(EV['Dark forest strike'], best);
        }
      }
    }
    // gamma-ray burst or nearby supernova sterilises a region
    if (this.rand() < dt * 4e-6 && st.nSettled > 30) {
      const centre = st.settled[Math.floor(this.rand() * st.nSettled)];
      const radius = 5 + this.rand() * 40;
      let killed = 0;
      for (let n = 0; n < st.nSettled; n++) {
        const b = st.settled[n];
        if (b === this.world.earth || this.dist(b, centre) > radius) continue;
        const o = b * NF;
        if (isAlive(S[o + F.stage])) { S[o + F.pop] *= 0.1; killed++; }
      }
      if (killed) this.log(this.rand() < 0.5 ? EV.Supernova : EV['Gamma-ray burst'], centre, killed, radius);
    }
    if (st.techDone[TECH_INDEX.get('agi')!] >= 0 && this.rand() < dt * 0.0006) {
      g[G.knowledge] *= 0.98; this.log(EV['AI schism'], -1);
    }
  }

  private record(step: number): void {
    const st = this.st, S = st.S, g = st.g, row = this.series.subarray(step * NGM, step * NGM + NGM);
    row.fill(0);
    const earth = this.world.earth;
    let stabW = 0, happW = 0, giniW = 0, ageW = 0, shortP = 0, reach = 0, leW = 0, tfrW = 0;
    const systems = new Set<number>(), facs = new Set<number>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (stg === STAGE.SURVEY) { row[GM.surveyed]++; continue; }
      if (!isAlive(stg)) continue;
      const pop = S[o + F.pop];
      row[GM.pop] += pop;
      if (b !== earth) row[GM.offEarth] += pop;
      if (this.bSys[b] !== 0) row[GM.interstellarPop] += pop;
      row[GM.births] += S[o + F.births]; row[GM.deaths] += S[o + F.deaths];
      row[GM.settlements]++; systems.add(this.bSys[b]); facs.add(S[o + F.faction]);
      row[GM.energy] += S[o + F.energy]; row[GM.gdp] += S[o + F.gdp]; row[GM.capital] += S[o + F.capital];
      row[GM.water] += S[o + F.water]; row[GM.metals] += S[o + F.metals]; row[GM.volatiles] += S[o + F.volatiles];
      row[GM.rare] += S[o + F.rare]; row[GM.he3] += S[o + F.he3]; row[GM.military] += S[o + F.military];
      row[GM.divergence] = Math.max(row[GM.divergence], S[o + F.divergence]);
      stabW += S[o + F.stability] * pop; happW += S[o + F.happiness] * pop; giniW += S[o + F.gini] * pop; ageW += S[o + F.medianAge] * pop;
      leW += S[o + F.lifeExp] * pop; tfrW += S[o + F.tfr] * pop;
      shortP += S[o + F.shortage] * pop;
      reach = Math.max(reach, this.world.systems[this.bSys[b]].dist);
    }
    const P = Math.max(row[GM.pop], 1);
    row[GM.systems] = systems.size; row[GM.factions] = facs.size; row[GM.reach] = reach;
    row[GM.stability] = stabW / P; row[GM.happiness] = happW / P; row[GM.gini] = giniW / P; row[GM.medianAge] = ageW / P;
    row[GM.lifeExp] = leW / P; row[GM.tfr] = tfrW / P;
    row[GM.shortage] = (100 * shortP) / P;
    row[GM.kardashev] = row[GM.energy] > 0 ? (Math.log10(row[GM.energy]) - 6) / 10 : 0;
    row[GM.energyPerCap] = row[GM.energy] / P; row[GM.gdpPerCap] = row[GM.gdp] / P;
    row[GM.launchCap] = g[G.launchCap]; row[GM.knowledge] = g[G.knowledge]; row[GM.research] = g[G.researchRate];
    row[GM.techs] = st.techDone.reduce((a, d) => a + (d >= 0 ? 1 : 0), 0);
    row[GM.shipsInTransit] = g[G.nShips]; row[GM.shipsLaunched] = g[G.shipsLaunched]; row[GM.shipsLost] = g[G.shipsLost];
    row[GM.dead] = g[G.dead]; row[GM.wars] = g[G.wars]; row[GM.faiths] = g[G.faiths]; row[GM.era] = g[G.era];
    g[G.prevShortage] = row[GM.shortage]; g[G.prevFactions] = row[GM.factions]; g[G.prevStability] = row[GM.stability];

    if (this.logEvents && step % Engine.HIST_EVERY === 0) {
      const w = 2 + HIST_FIELDS.length;
      for (let n = 0; n < st.nSettled; n++) {
        const b = st.settled[n], o = b * NF;
        if (S[o + F.stage] < STAGE.OUTPOST) continue;
        if ((this.histLen + 1) * w > this.hist.length) {
          const bigger = new Float32Array(this.hist.length * 2); bigger.set(this.hist); this.hist = bigger;
        }
        const h = this.histLen * w;
        this.hist[h] = step; this.hist[h + 1] = b;
        for (let k = 0; k < HIST_FIELDS.length; k++) this.hist[h + 2 + k] = S[o + F[HIST_FIELDS[k]]];
        this.histLen++;
      }
    }
  }

  // ---- snapshots

  snapshot(): SimState {
    const st = this.st;
    return {
      step: st.step, S: st.S.slice(), g: st.g.slice(), techProg: st.techProg.slice(), techDone: st.techDone.slice(),
      ships: st.ships.slice(0, st.g[G.nShips] * NSH), settled: st.settled.slice(0, st.nSettled), nSettled: st.nSettled, rng: st.rng.slice(),
      shipRetry: st.shipRetry.slice(), gen: st.gen.slice(0, st.g[G.nGen] * NGC), ages: st.ages.slice(0, st.nSettled * NAGE),
    };
  }

  restore(s: SimState): void {
    const nb = this.world.bodies.length;
    const ships = new Float64Array(MAX_SHIPS * NSH); ships.set(s.ships);
    const settled = new Int32Array(nb); settled.set(s.settled);
    this.st = {
      step: s.step, S: s.S.slice(), g: s.g.slice(), techProg: s.techProg.slice(), techDone: s.techDone.slice(),
      ships, settled, nSettled: s.nSettled, rng: s.rng.slice(), shipRetry: s.shipRetry.slice(),
      gen: (() => { const g = new Float64Array(MAX_GEN * NGC); g.set(s.gen); return g; })(),
      ages: (() => { const a = new Float64Array(nb * NAGE); a.set(s.ages); return a; })(),
    };
    this.pos.fill(-1);
    for (let n = 0; n < s.nSettled; n++) this.pos[s.settled[n]] = n;
    this.rebuildPairs();
    this.surveyCursor = this.nbr.start.slice();
    this.recomputeFx();
  }

  shipList(): { from: number; to: number; depart: number; arrive: number; colonists: number; kind: number }[] {
    const out = [];
    const sh = this.st.ships;
    for (let i = 0; i < this.st.g[G.nShips]; i++) {
      const o = i * NSH;
      out.push({ from: sh[o], to: sh[o + 1], depart: sh[o + 2], arrive: sh[o + 3], colonists: sh[o + 4], kind: sh[o + 5] });
    }
    return out;
  }

  globals() {
    const g = this.st.g;
    return { year: g[G.year], era: ERAS[g[G.era]], eraIndex: g[G.era], knowledge: g[G.knowledge], contact: g[G.contact], launchCap: g[G.launchCap] };
  }
}

function cellId(i: number, j: number, k: number): number {
  return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
}

// Static per-world neighbour lists (CSR, sorted by distance) for systems a ship
// can reach in one hop. Built once per world and shared by every engine.
const MAX_HOP = 50;
interface Neighbours { start: Int32Array; sys: Int32Array; d: Float32Array }
const NBR_CACHE = new WeakMap<World, Neighbours>();
function neighbours(world: World): Neighbours {
  const hit = NBR_CACHE.get(world);
  if (hit) return hit;
  const sys = world.systems, C = MAX_HOP;
  const grid = new Map<number, number[]>();
  const cell = (v: number) => Math.floor(v / C);
  for (const s of sys) {
    if (s.region !== 'local' && s.region !== 'sol') continue;
    const k = cellId(cell(s.x), cell(s.y), cell(s.z));
    let c = grid.get(k);
    if (!c) grid.set(k, (c = []));
    c.push(s.id);
  }
  const start = new Int32Array(sys.length + 1), ids: number[] = [], ds: number[] = [];
  const near: [number, number][] = [];
  for (const s of sys) {
    start[s.id] = ids.length;
    if (s.region !== 'local' && s.region !== 'sol') continue;
    near.length = 0;
    const cx = cell(s.x), cy = cell(s.y), cz = cell(s.z);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      for (const o of grid.get(cellId(cx + i, cy + j, cz + l)) ?? []) {
        if (o === s.id) continue;
        const d = Math.hypot(sys[o].x - s.x, sys[o].y - s.y, sys[o].z - s.z);
        if (d <= C) near.push([d, o]);
      }
    }
    near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [d, o] of near) { ids.push(o); ds.push(d); }
  }
  start[sys.length] = ids.length;
  const out = { start, sys: Int32Array.from(ids), d: Float32Array.from(ds) };
  NBR_CACHE.set(world, out);
  return out;
}

function pairKey(a: number, b: number): number { return a < b ? a * 65536 + b : b * 65536 + a; }

function push(m: Map<number, number[]>, k: number, v: number): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
