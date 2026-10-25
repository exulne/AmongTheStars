// The simulation. One step advances every settlement by dt years.
// All mutable state lives in typed arrays inside `SimState` so that a snapshot
// is a handful of array copies, and replaying from a snapshot is exact.

import { techAt } from './diffusion.ts';
import { ERA_FX, ERA_MATRIX, ERAS, EV, STAGE, STAGE_CAP, STAGE_TECH, TECHS, isAlive, type Tech } from './catalog.ts';
import { F, GM, HIST_FIELDS, NF, NGM } from './metrics.ts';
import { AGE_W, A_MIN, CREW_AGES, FERT_SHARE, GM_A0, GM_B0, GM_b0, MIGRANT_AGES, WORK_SHARE, deployed, NAGE, binHazard, earthBins, infantHazard, lifeExpectancyBins, medianAge, tfrTransition } from './ages.ts';
import { EFFECTS, compat, effectFor, effectSize, isAdd, isDown, spineField, FIELDS, type Field } from './invent.ts';
import { FLOW, GENERATION, Ledger, NPERIODS, isPeriodBoundary, periodOf } from './ledger.ts';
import { next, seedRng, type RngState } from './rng.ts';
import type { World } from './world.ts';
import { Civ, H, HG, cloneCiv, type CivState } from './civ.ts';
import { CF, EnvelopeCache, MissionLog, baseline, evaluate, interstellarAllowance, leoCostPerKg, packMission, routeFor, stepBudget, type Assumptions, type Economics, type MissionContext, type MissionSpec, type Route } from './launchEconomics.ts';

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
  tfp: 21,     // total factor productivity index A (Jones semi-endogenous growth), 1 in 2040
  researchers: 22, // effective research effort S behind TFP: people × research multipliers (last step)
  // launch economics: launches flown so far (Starship-class learning curve) and all transport spending
  cumLaunches: 24, transportCum: 25,
  // this step's transport accounts, reset when a step begins (fully burdened 2024 USD; counts)
  tSpend: 26, tProp: 27, tHw: 28, tOps: 29, tRisk: 30, tInfra: 31, tMhw: 32, tService: 33,
  tTankers: 34, tCampaigns: 35, tLaunches: 36, tPayloadKg: 37, tPeople: 38,
} as const;
const NG = 40;

export interface SimState {
  step: number;
  S: Float64Array;         // bodies × NF
  g: Float64Array;         // globals
  techProg: Float64Array;  // knowledge spent per tech
  techDone: Float64Array;  // year unlocked, or -1
  techWhere: Float64Array; // body where it was invented, or -1 (known from the start)
  ships: Float64Array;     // MAX_SHIPS × NSH
  settled: Int32Array;     // body ids with a settlement, in founding order
  shipRetry: Float64Array; // per system: year before which a failed ship search is not retried
  gen: Float64Array;       // generated inventions, MAX_GEN × GC (see GC)
  /** people per age bin (ages.ts), NAGE per settlement in founding order (settled[n] owns ages[n·NAGE..]) */
  ages: Float64Array;
  hx: CivState;            // faiths, polities, wars, languages... (civ.ts)
  /** per system: [year its Dyson swarm phase I began, year phase II began], -1 if not (yet) */
  swarm: Float64Array;
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
const MULT_KEYS = new Set(['extract', 'habitat', 'lifeSupport', 'energy', 'launch', 'research', 'productivity', 'death', 'growth', 'war', 'secession', 'voyage', 'divergence']);
/** techs that move the ageing curve, phased in along their S-curve every step (see `longevity`) */
const AGEING = TECHS.flatMap((t, i) => (t.fx.gompB !== undefined || t.fx.gompb !== undefined ? [i] : []));

const RESEARCH = 14; // calibrates knowledge output to the tech tree's milestone years
const SIGMA = 5.670374e-8, L_SUN = 3.828e26; // Stefan–Boltzmann (W m⁻² K⁻⁴), nominal solar luminosity (W, IAU 2015)
// TFP growth (see step): g0 at 2040's research effort S0 (Earth's people), λ = 0.75 (invention-model
// §5.3). β/λ ≈ 3.3 from Bloom et al. 2020: US research effort grew ≈ 4.3%/yr while TFP grew ≈ 1.3%/yr,
// and in Jones's steady state g_A = λ·g_S/β. So per-head growth slows as the frontier advances unless
// ever more minds work on it.
const TFP_G0 = 0.006, TFP_S0 = 9.2e9, TFP_LAMBDA = 0.75, TFP_BETA = 2;
// Production scale: Earth 2040 makes $160T a year from K = $552T, 23 TW and its working-age people
const Y_SCALE = 1.6e14 / (Math.pow(9.2e9 * 60000, 0.3) * Math.pow(2.3e13 + 6e5, 0.08) * Math.pow(earthBins(9.2e9).reduce((a, n, k) => a + n * WORK_SHARE[k], 0), 0.62));
const SHIP_MIN_HAB = 0.15;
const MIGRATE = 0.001; // share of a town's people per year who move to younger settlements in the same system
const REACH_OUTER = 1, REACH_RAD = 2, REACH_DEEP = 4;
const MINOR = new Set([EV.Famine, EV['Rich deposit found'], EV['Baby boom'], EV.Revolt, EV['Habitat breach'], EV['Probe survey']]);
const TECH_INDEX = new Map(TECHS.map((t, i) => [t.id, i]));
const TECH_REQ: number[][] = TECHS.map((t) => t.req.map((r) => TECH_INDEX.get(r)!));
// shortest an age lasts, in years (Expansion, Consolidation, Golden Age, Stagnation, War, Pandemic, Collapse, Renaissance)
const ERA_MIN = [50, 50, 40, 50, 12, 8, 30, 30];
const TECH_FLOOR = TECHS.map((t) => t.earliest - 0.25 * (t.earliest - 2040));
/** passengers in the reference shipload a scheduled service is priced for (cost is linear in passengers) */
const SERVICE_LOAD = 100;

/** Options a run is built with; the same seed and options give the same run. */
export interface EngineOpts { econ?: Assumptions }

export class Engine {
  world: World;
  seed: number;
  st: SimState;
  techCostMult: Float64Array;
  /** per tech: 1 if this universe's physics allows it (rolled once per seed) */
  feasible: Uint8Array;
  wanderlust: number;
  fx!: Fx;
  /** faiths, polities, wars and the rest of remembered history (civ.ts) */
  civ: Civ;
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
  private sysLum: Float64Array;
  /** per body: waste heat its surface can shed, W (see constructor) */
  private bHeat: Float64Array;
  /** per-system scratch, rebuilt every step: people, people in hubs, swarm power in use (W) */
  private sysPop: Float64Array; private hubPop: Float64Array; private swarmW: Float64Array;
  private sysList: number[] = []; private sysMark: Int32Array; private markGen = 0;
  /** body → index in st.settled (and its age bins), -1 if never settled; derived, rebuilt on restore */
  private pos: Int32Array;
  private mu = new Float64Array(NAGE);
  /** mean Gompertz factor per bin for the current ageing rate b: μ_k = A + B·gk[k] (+ under-5) */
  private gk = new Float64Array(NAGE); private gkB = -1;
  /** per body: this step's mortality law [A, B, b, under-5] for the people ledger (main run only) */
  private mort: Float64Array;
  /** launch-economics assumptions this run prices transport with (constant for the run) */
  econ: Assumptions;
  private env: EnvelopeCache;
  /** one record per crewed or interstellar mission, launch order (main run; replays log too when logEvents) */
  missions = new MissionLog();
  /** per body: transport money its polity spent this step (scratch); product of the polity it seats (scratch) */
  private spent: Float64Array; private polGdp: Float64Array; private offer: Float64Array;
  private routes = new Map<number, Route>();
  private serviceCache = new Map<string, Economics>();
  private fxStamp = 0;
  /** generated inventions' share of fx.launch (the named techs are priced explicitly) */
  private genLaunch = 1;
  private refShip = { step: -1, cost: 0 };

  constructor(world: World, seed: number, opts: EngineOpts = {}) {
    this.world = world;
    this.seed = seed;
    this.econ = opts.econ ?? baseline();
    this.env = new EnvelopeCache(this.econ);
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
    this.sysLum = Float64Array.from(world.systems, (s) => s.lum);
    this.sysPop = new Float64Array(ns); this.hubPop = new Float64Array(ns); this.swarmW = new Float64Array(ns); this.sysMark = new Int32Array(ns);
    // Waste heat: a planet sheds extra power P only by warming until it radiates it,
    // P ≤ σ·4πR²·(T_max⁴ − T_eq⁴). A living world tolerates T_max = T_eq + 3 K (Earth: ≈ 6 PW,
    // against 0.02 PW used in 2024 and 120 PW of absorbed sunlight); a dead one can be paved
    // with radiators running 30 K above its surface, and never colder than 250 K.
    this.bHeat = Float64Array.from(world.bodies, (b) => {
      const R = b.radius * 1e3, T = Math.max(b.temp, 3), Tmax = b.hab >= 0.3 ? T + 3 : Math.max(T + 30, 250);
      return SIGMA * 4 * Math.PI * R * R * (Tmax ** 4 - T ** 4);
    });
    world.systems.forEach((s, i) => {
      this.sysX[i] = s.x; this.sysY[i] = s.y; this.sysZ[i] = s.z;
      this.sysRegion[i] = ({ sol: 0, local: 1, galaxy: 2, extra: 3 } as const)[s.region];
    });
    this.pos = new Int32Array(nb).fill(-1);
    this.mort = new Float64Array(nb * 4);
    this.spent = new Float64Array(nb); this.polGdp = new Float64Array(nb); this.offer = new Float64Array(nb);
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
    this.civ = new Civ(this, (t, b, a = 0, bb = 0) => this.log(t, b, a, bb));
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
      techDone: new Float64Array(TECHS.length).fill(-1), techWhere: new Float64Array(TECHS.length).fill(-1), ships: new Float64Array(MAX_SHIPS * NSH),
      settled: new Int32Array(nb), nSettled: 0, rng, shipRetry: new Float64Array(this.world.systems.length),
      gen: new Float64Array(MAX_GEN * NGC), ages: new Float64Array(nb * NAGE), hx: this.civ.init(nb),
      swarm: new Float64Array(this.world.systems.length * 2).fill(-1),
    };
    this.st = st;
    st.g[G.era] = 0;
    st.g[G.launchCap] = 5000;
    st.g[G.faiths] = 6;
    st.g[G.tfp] = 1; st.g[G.researchers] = TFP_S0;
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
    this.civ.onFound(st.hx, body, parent, stage);
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
        if (k === 'gompB' || k === 'gompb') continue; // deployed gradually, see longevity()
        if (k === 'shipSpeed') fx.shipSpeed = Math.max(fx.shipSpeed, v);
        else if (MULT_KEYS.has(k)) fx[k] *= v;
        else fx[k] += v;
      }
    });
    fx.orbital = this.has('orbitalHabitats') ? 1 : 0;
    let spineLaunch = 1;
    TECHS.forEach((t, i) => { if (this.st.techDone[i] >= 0 && t.fx.launch !== undefined) spineLaunch *= t.fx.launch; });
    const gen = this.st.gen;
    for (let k = 0; k < this.st.g[G.nGen]; k++) {
      const key = EFFECTS[gen[k * NGC + GC.key]], size = gen[k * NGC + GC.size];
      if (key === 'shipSpeed') { if (fx.shipSpeed > 0) fx.shipSpeed += size; }
      else if (isAdd(key)) fx[key] += size;
      else if (isDown(key)) fx[key] /= size;
      else fx[key] *= size;
    }
    this.fx = fx;
    this.genLaunch = fx.launch / spineLaunch;
    this.fxStamp++;
    this.gkB = -1;
  }

  /** The ageing curve this year: each longevity gate mixes treated and untreated people
   *  by its deployment share, so B and b move smoothly from invention to full use. */
  private longevity(year: number): void {
    const fx = this.fx, d = this.st.techDone;
    let B = 1, b = GM_b0;
    for (const i of AGEING) {
      if (d[i] < 0) continue;
      const x = deployed(year - d[i], TECHS[i].tau ?? 5), f = TECHS[i].fx;
      if (f.gompB !== undefined) B *= 1 + x * (f.gompB - 1);
      if (f.gompb !== undefined) b = Math.min(b, GM_b0 + x * (f.gompb - GM_b0));
    }
    fx.gompB = B; fx.gompb = b;
    if (b !== this.gkB) {
      this.gkB = b;
      for (let k = 0; k < NAGE; k++) this.gk[k] = binHazard(k, { A: 0, B: 1, b, inf: 0 });
    }
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
    // hysteresis: an age lasts at least a few decades (longer as civilisation grows), so moods do not flicker
    const settled = year - g[G.eraSince] >= ERA_MIN[era] * (1 + Math.min(1.5, year / 2000));
    if (settled && this.rand() > pStay) {
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
    this.longevity(year);
    this.systemsPass(year);
    // total factor productivity: Jones (1995) semi-endogenous growth, d ln A/dt = g0 (R/R0)^λ A^(−β):
    // research effort R raises A, but ideas get harder to find as A grows (Bloom, Jones, Van Reenen
    // & Webb 2020 find research productivity falling ≈ 5%/yr). Level shifts from named technologies
    // (robotics, AGI, nanofabrication) come on top through fx.productivity.
    g[G.tfp] *= Math.exp(dt * TFP_G0 * Math.pow(Math.max(g[G.researchers], 1) / TFP_S0, TFP_LAMBDA) * Math.pow(g[G.tfp], -TFP_BETA));
    const tfp = fx.productivity * g[G.tfp];
    let research = 0, researchers = 0;
    // migration inside a system: Earth (launch-limited) and every town or bigger send
    // people to the young settlements around the same star, weighted by free room
    const migW = this.migW.fill(0), migD = this.migD.fill(0), offer = this.offer;
    const earthWant = Math.min(g[G.launchCap] / 8, S[eo + F.pop] * 0.002) * (S[eo + F.stage] === STAGE.HUB ? 1 : 0.2);
    // transport accounts start afresh; budgets are per funding polity
    for (let k = G.tSpend; k <= G.tPeople; k++) g[k] = 0;
    this.polityGdp();
    const receivers = new Map<number, number[]>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (b === earth || !isAlive(stg) || stg > STAGE.CITY) continue;
      const room = Math.max(0, S[o + F.capacity] - S[o + F.pop]);
      migW[this.bSys[b]] += room ** 0.5;
      if (room > 0) push(receivers, this.bSys[b], b);
    }
    // what each sender offers: Earth (launch-limited) and every colony or bigger, no more than its
    // polity's transport budget pays for at the dearest reachable destination in its system
    const senders = new Map<number, number[]>(), left = new Map<number, number>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage], sy = this.bSys[b];
      offer[b] = 0;
      if (!isAlive(stg) || (b !== earth && stg < STAGE.COLONY)) continue;
      const rs = receivers.get(sy);
      const want = b === earth ? earthWant : S[o + F.pop] * MIGRATE;
      if (!rs || want <= 0) continue;
      let worst = 0;
      for (const r of rs) { const e = this.service(b, r); if (e) worst = Math.max(worst, e.costPerPassenger); }
      if (worst <= 0) continue;
      const f = this.funder(b);
      const budget = left.get(f) ?? this.budgetLeft(f, dt) * this.econ.budget.serviceShare.base;
      offer[b] = Math.min(want, budget / (worst * dt));
      left.set(f, budget - offer[b] * worst * dt);
      migD[sy] += offer[b];
      push(senders, sy, b);
    }
    // People are conserved: each receiver's intake is shared among the senders that can reach it in
    // proportion to their offers; senders lose exactly what they sent, and the ledger records who went where.
    const recv = this.recv.fill(0), sent = this.sent.fill(0);
    for (const [sy, list] of senders) {
      for (const r of receivers.get(sy) ?? []) {
        const room = Math.max(0, S[r * NF + F.capacity] - S[r * NF + F.pop]);
        const take = Math.min(migD[sy] * room ** 0.5 / migW[sy], room / dt);
        if (!(take > 0)) continue;
        for (const b of list) {
          const e = this.service(b, r);
          if (!e) continue;
          const flow = take * offer[b] / migD[sy];
          recv[r] += flow; sent[b] += flow;
          this.ledger?.migrate(b, r, flow * dt);
          this.book(this.funder(b), e, flow * dt, flow * dt / SERVICE_LOAD, true);
        }
      }
    }

    const sysNet = new Map<number, Float64Array>(); // per-system resource pooling
    let kRef = 60000; // Earth's capital per head, set when Earth (settled[0]) is processed
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
      // share of the room that is in orbit (cylinders, rings): those people radiate their own heat
      const fOrb = isEarth || room <= 0 ? 0 : 1 - Math.min(1, (1e10 * this.bArea[b] * hf) / room);

      // energy (W per person)
      const flux = this.bFlux[b];
      // richer people use more energy: income elasticity ≈ 0.5 (Csereklyei, Rubio-Varas & Stern
      // 2016 find 0.6–0.7 across countries 1971–2010), on top of what the technology makes cheap
      const eTech = Math.pow(fx.energy, 0.3) * Math.sqrt(Math.min(30, Math.max(1, S[o + F.gdp] / Math.max(pop, 1) / 17400)));
      const perCap = isEarth
        ? 2600 * eTech
        : 14000 * Math.max(Math.pow(Math.min(flux, 4), 0.5), fx.fission > 0 ? 1 : 0) * eTech;
      const need = isEarth ? 2000 : 9000 * (1.5 - 0.5 * h);
      // the surface can only shed so much waste heat; orbital habitats and the system's Dyson
      // swarm radiate into space, so the swarm is booked to the hubs that run it, not to the ground
      const sy = this.bSys[b];
      const surface = Math.min(pop * (1 - fOrb) * perCap, this.bHeat[b]);
      const orbital = pop * fOrb * perCap + (stg >= STAGE.HUB && this.hubPop[sy] > 0 ? this.swarmW[sy] * pop / this.hubPop[sy] : 0);
      const eRatio = pop > 0 ? (surface + orbital) / pop / need : perCap / need;
      S[o + F.energyRatio] = eRatio;
      S[o + F.energy] = surface + orbital + stg * 1e5;
      S[o + F.orbitalPower] = orbital; S[o + F.heatLoad] = surface / this.bHeat[b];

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
      const mA = Math.max(A_MIN, GM_A0 * fx.death) + 0.003 * (1 - h) + 0.04 * short * short + (crowd > 1 ? 0.02 * (crowd - 1) : 0);
      const mB = GM_B0 * fx.gompB * Math.max(0.5, fx.death), mb = fx.gompb, mInf = infantHazard(gdppc);
      const mu = this.mu, gk = this.gk;
      for (let k = 0; k < NAGE; k++) mu[k] = (mA + mB * gk[k] + (k === 0 ? mInf : 0)) * E.death;
      this.mort[b * 4] = mA * E.death; this.mort[b * 4 + 1] = mB * E.death; this.mort[b * 4 + 2] = mb; this.mort[b * 4 + 3] = mInf * E.death;
      // fertility: the transition (ages.ts) plus colonists who want children while there is room
      // (colonial America TFR ≈ 7; bible §7.3 frontier growth ≈ 2.7%/yr; at TFR 1.6 + 2.5·(1 − N/K)
      // a colony levels off near 80% of its room), pronatalism on an Earth that has emptied below
      // 70% of its room (settles near half full), and fewer children past capacity
      let tfr = tfrTransition(gdppc);
      if (!isEarth) tfr += 2.5 * fx.growth * Math.max(0, 1 - crowd);
      // a shrinking Earth pays for children (family policy) once it falls below ≈ 10 billion
      else tfr += 2 * Math.max(0, 1 - pop / 0.9 / 1.15e10);
      if (crowd > 1) tfr *= Math.max(0, (1.3 - crowd) / 0.3);
      tfr *= E.growth * this.civ.mul(b, H.mGrowth) * (1 - short) * (0.87 + 0.2 * S[o + F.happiness]); // ≈ 1 at a typical happiness of 0.65
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
      // life expectancy is smooth: every 4th step is plenty
      S[o + F.tfr] = tfr; S[o + F.medianAge] = medianAge(N, ao);
      if (st.step % 4 === 0 || S[o + F.lifeExp] === 0) S[o + F.lifeExp] = lifeExpectancyBins(mu);

      // economy: Y = A·K^0.3·E^0.08·L^0.62 (capital share 0.3; energy's cost share ≈ 5–8% of world
      // product, IEA/World Bank; constant returns). L counts people of working age. Capital beyond
      // 3× Earth's per head is habitat and life support, not productive capital. Small markets are
      // less productive: urban output per head scales as N^0.13 (Bettencourt et al. 2007, PNAS 104:7301),
      // with N the local population plus 5% of the rest of the system (in-system trade).
      let L = 0;
      for (let k = 0; k < NAGE; k++) L += N[ao + k] * WORK_SHARE[k];
      if (isEarth) kRef = Math.max(60000, S[o + F.capital] / Math.max(pop, 1));
      const Keff = Math.min(S[o + F.capital], 3 * kRef * pop);
      const market = Math.min(1.5, Math.pow((pop + 0.05 * Math.max(0, this.sysPop[sy] - pop)) / 9.2e9, 0.13));
      const gdp = L > 0 ? Y_SCALE * tfp * Math.pow(Keff, 0.3) * Math.pow(S[o + F.energy], 0.08) * Math.pow(L, 0.62) * market * (1 - 0.6 * short) : 0;
      S[o + F.gdp] = gdp;
      // saving 22% of output, capital wearing out at 5%/yr: K/Y ≈ s/(δ + g) ≈ 3, Earth's ≈ 3.45 in 2040
      S[o + F.capital] = Math.max(0, S[o + F.capital] + (0.22 * gdp - 0.05 * S[o + F.capital]) * dt);
      S[o + F.military] = gdp * (0.015 + (g[G.era] === 4 ? 0.08 : 0) + (S[o + F.faction] !== b || isEarth ? 0 : 0.03)) * this.civ.mul(b, H.mMil);
      // a war mind's posture: spending above (or below) the usual share comes out of (or back into) capital
      const post = this.civ.mul(S[o + F.faction], H.posture);
      if (post !== 0) {
        const base = S[o + F.military];
        S[o + F.military] = base * (1 + post);
        S[o + F.capital] = Math.max(0, S[o + F.capital] - post * base * dt);
      }
      S[o + F.robots] = S[o + F.capital] / 2e6 * (fx.productivity > 1.4 ? 3 : 1);

      // research
      const r = Math.pow(pop / 1e9, 0.7) * Math.pow(Math.min(1000, Math.max(gdp / Math.max(pop, 1), 1) / 17400), 0.6) * 9 * RESEARCH * fx.research * E.research * this.civ.mul(b, H.mResearch) + S[o + F.robots] * 1e-9 * fx.research;
      S[o + F.research] = r;
      research += r;
      // research effort: people × the share in research (rising with income, as R&D intensity
      // did from ~1% to ~3% of GDP in rich countries) × what AI and better tools add per researcher
      researchers += pop * fx.research * E.research * Math.min(10, Math.sqrt(Math.max(gdp / Math.max(pop, 1), 1) / 17400));

      // society
      const lag = this.lagToCapital(b);
      const stabTarget = 0.72 - 0.55 * short - 0.3 * Math.max(0, S[o + F.gini] - 0.35) + fx.stability + E.stab * 12 - (crowd > 1 ? 0.2 : 0) - Math.min(0.15, lag / 200);
      S[o + F.stability] = clamp01(S[o + F.stability] + (stabTarget - S[o + F.stability]) * Math.min(1, 0.08 * dt) + (this.rand() - 0.5) * 0.03 * Math.sqrt(dt));
      S[o + F.happiness] = clamp01(0.25 + 0.4 * S[o + F.stability] + 0.25 * Math.min(1, gdp / Math.max(pop, 1) / 60000) - 0.4 * short + (this.rand() - 0.5) * 0.02);
      const giniT = 0.28 + (stg >= STAGE.CITY ? 0.12 : 0) + 0.15 * short + (isEarth ? 0.25 : 0) - fx.stability + this.civ.mul(b, H.dGini);
      S[o + F.gini] = clamp01(S[o + F.gini] + (giniT - S[o + F.gini]) * Math.min(1, 0.03 * dt));
      const div0 = S[o + F.divergence];
      S[o + F.divergence] += dt * 0.0006 * fx.divergence * this.civ.mul(b, H.mDiv) * Math.pow(Math.abs(1 - this.bG[b]), 1.5) * (this.bSys[b] === 0 ? 0.4 : 1) * (isEarth ? 0 : 1);
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
    g[G.researchers] = researchers;
    g[G.knowledge] += research * dt;
    this.research(research * dt, year);

    // ---- expansion, ships, politics, rare global events
    this.expand(dt, year, E.launch);
    this.ships(year);
    this.politics(dt, year, E.war);
    this.globalEvents(dt, year);
    this.civ.step(dt, year);
    g[G.faiths] = 6 + st.hx.hg[HG.living]; // Earth's old faiths plus the living new ones
    // what each polity spent on transport this step, per year, on its seat
    // (scratch is left at zero between steps: a place founded mid-step must not inherit a replay's leftovers)
    for (let n = 0; n < st.nSettled; n++) { const b = st.settled[n]; S[b * NF + F.transport] = this.spent[b] / dt; this.spent[b] = 0; }

    // series row k always describes the state at years[k], the same state a snapshot at step k holds
    st.step++;
    g[G.year] = this.years[st.step];
    this.record(st.step);
    if (this.ledger && (isPeriodBoundary(g[G.year]) || this.done)) {
      const p = this.done ? NPERIODS - 1 : periodOf(g[G.year]) - 1;
      this.civ.record(p);
      this.ledger.close(p, (fn) => {
        for (let n = 0; n < st.nSettled; n++) {
          const b = st.settled[n];
          fn(b, Math.max(0, Math.round(S[b * NF + F.pop])));
          // the period's mortality law, so the census's deaths fall by age as the engine's did
          if (S[b * NF + F.pop] > 0 && this.mort[b * 4 + 1] > 0) this.ledger!.setMortality(b, p, this.mort[b * 4], this.mort[b * 4 + 1], this.mort[b * 4 + 2], this.mort[b * 4 + 3]);
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

  /** Per-system totals for this step, and each system's own Dyson swarm. A swarm starts
   *  around a star once its people know how (dyson1) and have an industrial hub there.
   *  Phase I captures ~2.6e-11 of the star within ~50 years (1e16 W at the Sun, bible M15);
   *  phase II grows e-fold every 60 years from 2.6e-7 to half the star (0.9 with star lifting).
   *  Only what the system's hubs can use is captured: ×min(1, hub people / 1e9). */
  private systemsPass(year: number): void {
    const st = this.st, S = st.S, list = this.sysList;
    const mark = ++this.markGen;
    list.length = 0;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (!isAlive(stg)) continue;
      const sy = this.bSys[b];
      if (this.sysMark[sy] !== mark) { this.sysMark[sy] = mark; list.push(sy); this.sysPop[sy] = 0; this.hubPop[sy] = 0; this.swarmW[sy] = 0; }
      this.sysPop[sy] += S[o + F.pop];
      if (stg >= STAGE.HUB) this.hubPop[sy] += S[o + F.pop];
    }
    const has1 = this.has('dyson1'), has2 = this.has('dyson2'), lift = this.has('starLifting') ? 0.9 : 0.5;
    for (const sy of list) {
      const sw = st.swarm;
      if (this.hubPop[sy] <= 0) continue;
      if (has1 && sw[sy * 2] < 0) sw[sy * 2] = year;
      if (has2 && sw[sy * 2] >= 0 && sw[sy * 2 + 1] < 0) sw[sy * 2 + 1] = year;
      if (sw[sy * 2] < 0) continue;
      let cov = 2.6e-11 * Math.min(1, (year - sw[sy * 2]) / 50 + 0.1);
      if (sw[sy * 2 + 1] >= 0) cov = Math.max(cov, Math.min(lift, 2.6e-7 * Math.exp((year - sw[sy * 2 + 1]) / 60)));
      this.swarmW[sy] = cov * L_SUN * this.sysLum[sy] * Math.min(1, this.hubPop[sy] / 1e9);
    }
  }

  // ---- launch economics (launchEconomics.ts): who pays, what they may spend, what the world charges

  /** The polity that pays for a place's transport: its faction seat while that lives, else itself. */
  private funder(b: number): number {
    const f = this.st.S[b * NF + F.faction] | 0;
    return f >= 0 && isAlive(this.st.S[f * NF + F.stage]) ? f : b;
  }

  /** Product of every polity, booked to its seat; and this step's spending starts at zero. */
  private polityGdp(): void {
    const st = this.st, S = st.S;
    for (let n = 0; n < st.nSettled; n++) this.polGdp[st.settled[n]] = 0;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n];
      if (isAlive(S[b * NF + F.stage])) this.polGdp[this.funder(b)] += S[b * NF + F.gdp];
    }
  }

  /** What a polity may still spend on in-system transport this step. */
  private budgetLeft(f: number, dt: number): number {
    const S = this.st.S;
    return Math.max(0, stepBudget(this.econ, this.st.g[G.era], this.polGdp[f], S[f * NF + F.capital], dt) - this.spent[f]);
  }

  private route(from: number, to: number): Route {
    const k = from * this.world.bodies.length + to;
    let r = this.routes.get(k);
    if (!r) { r = routeFor(this.world, from, to, this.econ.mission.atmosphereLandingDvKmS.base); this.routes.set(k, r); }
    return r;
  }

  /** The world a mission from `from` to `to` launches into. Smooth quantities are rounded to a few
   *  steps per e-fold so prices can be cached; the record keeps exactly what was priced. */
  private missionCtx(from: number, to: number, shortage: number): MissionContext {
    const S = this.st.S, g = this.st.g, fx = this.fx, year = g[G.year];
    const has = (id: string) => this.has(id);
    const q = (x: number) => Math.exp(Math.round(Math.log(Math.max(x, 1e-9)) * 20) / 20);
    const isruAt = (b: number) => b >= 0 && S[b * NF + F.stage] >= STAGE.BASE && isAlive(S[b * NF + F.stage]) && has('isru');
    let flags = 0;
    if (has('reusable')) flags |= CF.reusable;
    if (isruAt(to)) flags |= CF.isruDest;
    if (isruAt(from) || (S[from * NF + F.stage] >= STAGE.OUTPOST && from !== this.world.earth && has('isru'))) flags |= CF.isruOrigin;
    if (has('asteroidMining')) flags |= CF.asteroidDepot;
    if (has('spaceElevator')) flags |= CF.elevator;
    // no catalogue tech is a mass driver: building one takes regolith construction and fusion power (a design mapping)
    if (has('regolith') && has('fusion')) flags |= CF.massDriver;
    if (has('ntp')) flags |= CF.ntp;
    if (has('fusionDrive')) flags |= CF.fusion;
    // orbital shipyards: metal from the belt and the know-how to build cities in orbit
    if (has('asteroidMining') && has('orbitalHabitats')) flags |= CF.shipyards;
    if (year < g[G.kesslerUntil]) flags |= CF.kessler;
    if (has('seedShips')) flags |= CF.seedShips;
    if (has('genShip')) flags |= CF.genShip;
    return {
      era: g[G.era], flags, shortage: Math.round(Math.max(0, Math.min(1, shortage)) * 20) / 20,
      productivity: q(fx.productivity), energyFx: q(fx.energy), launchGen: q(this.genLaunch), cumLaunches: g[G.cumLaunches],
      pLossTransit: 0, shipSpeedC: fx.shipSpeed,
    };
  }

  /** A scheduled passenger service, priced per reference shipload (null: no vehicle can fly it). Cached per route and price context. */
  private service(from: number, to: number): Economics | null {
    const ctx = this.missionCtx(from, to, 0);
    const S0 = this.econ.starship;
    const bucket = Math.floor(Math.log2(1 + ctx.cumLaunches / S0.learningRefLaunches.base) * 8);
    const key = `${from},${to},${ctx.era},${ctx.flags},${bucket},${ctx.productivity},${ctx.energyFx},${ctx.launchGen}`;
    let e = this.serviceCache.get(key);
    if (e === undefined) {
      const spec: MissionSpec = { kind: 'service', crew: SERVICE_LOAD, cargoKg: 0, route: this.route(from, to) };
      e = evaluate(spec, ctx, this.econ);
      if (this.serviceCache.size > 50000) this.serviceCache.clear();
      this.serviceCache.set(key, e);
    }
    return e.feasible && e.total > 0 ? e : null;
  }

  /** Book transport spending: out of the funder's capital, into this step's accounts. */
  private book(funder: number, e: Economics, people: number, scale: number, service: boolean): void {
    const g = this.st.g, c = e.cost, S = this.st.S;
    const total = e.total * scale;
    g[G.tSpend] += total; g[G.transportCum] += total;
    g[G.tProp] += (c.propellantEarth + c.propellantOffEarth) * scale;
    g[G.tHw] += c.hardware * scale;
    g[G.tOps] += (c.refurbishment + c.groundOps + c.missionOps + c.rangeRegulatory + c.payloadIntegration + c.inSpaceOps) * scale;
    g[G.tRisk] += (c.insurance + c.expectedLoss) * scale;
    g[G.tInfra] += c.infrastructure * scale;
    g[G.tMhw] += c.missionHardware * scale;
    if (service) g[G.tService] += total;
    g[G.tTankers] += e.tankerFlights * scale;
    g[G.tLaunches] += e.totalLaunches * scale;
    g[G.tCampaigns] += service ? e.ships * scale : 1;
    g[G.tPayloadKg] += e.payloadKg * scale;
    g[G.tPeople] += people;
    // only rocket launches teach the rocket factories
    if (e.vehicle === 'starship' || e.vehicle === 'ntp' || e.vehicle === 'fusion') g[G.cumLaunches] += e.totalLaunches * scale;
    this.spent[funder] += total;
    S[funder * NF + F.capital] = Math.max(0, S[funder * NF + F.capital] - total);
  }

  /** Log a mission's economics (main run). */
  private logMission(id: number, from: number, to: number, funder: number, spec: MissionSpec, ctx: MissionContext, e: Economics): void {
    if (!this.logEvents) return;
    const lo = evaluate(spec, ctx, this.env.lo), hi = evaluate(spec, ctx, this.env.hi);
    const o = this.missions.add(id);
    packMission(this.missions.rows, o, { id, year: this.st.g[G.year], from, to, funder }, spec, ctx, e, lo, hi);
  }

  /** What a reference interstellar ship (2,000 colonists, 10 ly) costs this step: the scale ambition is measured against. */
  private refShipCost(): number {
    if (this.refShip.step === this.st.step) return this.refShip.cost;
    const earth = this.world.earth, ctx = this.missionCtx(earth, -1, 0);
    ctx.pLossTransit = 0.2;
    const e = evaluate({ kind: 'interstellar', crew: 2000, cargoKg: 0, route: { origin: 0, ascentKmS: 0, outKmS: 0, backKmS: 0, transitYears: 300, distanceLy: 10 } }, ctx, this.econ);
    this.refShip = { step: this.st.step, cost: e.total };
    return e.total;
  }

  private lagToCapital(b: number): number {
    const cap = this.st.S[b * NF + F.faction] | 0;
    if (cap === b) return 0;
    const s1 = this.bSys[b], s2 = this.bSys[cap];
    return Math.hypot(this.sysX[s1] - this.sysX[s2], this.sysY[s1] - this.sysY[s2], this.sysZ[s1] - this.sysZ[s2]);
  }

  private stageUp(b: number, o: number, stg: number, pop: number, cap: number, short: number, dt: number): void {
    const S = this.st.S, fx = this.fx, st = this.st, year = st.g[G.year];
    // a place builds only with what it has heard of: news of an invention crosses space at light speed
    const has = (id: string) => techAt(this.world, st.techDone, st.techWhere, TECH_INDEX.get(id)!, b, year);
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
    const Lstar = this.sysLum[this.bSys[b]] * L_SUN, E = S[o + F.energy];
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
      if (r() < dt * 0.003 * ERA_FX[this.st.g[G.era]].death) { S[o + F.pop] *= 0.97; this.log(EV.Plague, b, 0.03); this.civ.onDisaster(b, EV.Plague, 0.03, this.year); }
      return;
    }
    const rel = Math.min(0.9, fx.reliability);
    if (stg <= STAGE.COLONY && r() < dt * 0.012 * (1 - rel)) {
      // a lost module: a few people, or up to 2% of a bigger place
      const k = Math.min(0.5, r() * 0.02 + (2 + r() * 8) / Math.max(pop, 1)); S[o + F.pop] *= 1 - k; S[o + F.stability] -= 0.03; this.log(EV['Habitat breach'], b, k); this.civ.onDisaster(b, EV['Habitat breach'], k, this.year);
    }
    if (this.bSys[b] === 0 && this.bFlux[b] > 0.2 && stg <= STAGE.TOWN && r() < dt * 0.01) {
      const k = 0.001 + r() * 0.01; S[o + F.pop] *= 1 - k; this.log(EV['Solar storm'], b, k);
    }
    if (r() < dt * 0.00015) {
      const k = 0.1 + r() * 0.6; S[o + F.pop] *= 1 - k; S[o + F.capital] *= 1 - k; this.log(EV['Asteroid strike'], b, k); this.civ.onDisaster(b, EV['Asteroid strike'], k, this.year);
      if (k > 0.65 && stg <= STAGE.COLONY) { S[o + F.stage] = STAGE.DEAD; S[o + F.pop] = 0; this.st.g[G.dead]++; return; }
    }
    if (pop > 1e5 && r() < dt * 0.0015 * ERA_FX[this.st.g[G.era]].death) {
      const k = 0.02 + r() * 0.15; S[o + F.pop] *= 1 - k; this.log(EV.Plague, b, k); this.civ.onDisaster(b, EV.Plague, k, this.year);
    }
    if (short > 0.3 && r() < dt * 0.1) { S[o + F.pop] *= 1 - short * 0.1; this.log(EV.Famine, b, short); this.civ.onDisaster(b, EV.Famine, short, this.year); }
    if (S[o + F.stability] < 0.3 && r() < dt * 0.05) { S[o + F.capital] *= 0.9; S[o + F.stability] += 0.1; this.log(EV.Revolt, b); }
    if (r() < this.civ.faithChance(b, dt, this.year)) this.civ.newFaith(b, this.year);
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
      st.techWhere[i] = where;
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
      const pLocal = dt * 0.03 * eraLaunch * this.civ.mul(b, H.mLaunch) * Math.min(3, Math.pow(gdp / 5e10, 0.25)) * (isEarth ? 2 : 1);
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
        if (best >= 0 && crew >= 4) this.crewMission(b, best, crew, year, dt);
      }
      // interstellar: needs a drive, a colony with money, and a stable home
      if (fx.shipSpeed <= 0 || stg < STAGE.CITY) continue;
      // ambition is measured against what a reference ship costs now (launchEconomics.ts)
      const shipCost = this.refShipCost();
      const pShip = dt * 0.0008 * this.wanderlust * eraLaunch * this.civ.mul(b, H.mLaunch) * Math.min(4, Math.sqrt(gdp / shipCost)) * (isEarth ? 3 : 1);
      if (this.rand() < pShip && S[o + F.capital] > 0.25 * shipCost) {
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
        // the ship's own price: built for these colonists, this voyage, this drive; the hub pays, within its means
        const spec: MissionSpec = { kind: ftlTrip ? 'warp' : 'interstellar', crew: colonists, cargoKg: 0, route: { origin: isEarth ? 0 : 1, ascentKmS: 0, outKmS: 0, backKmS: 0, transitYears: travel, distanceLy: d } };
        const ctx = this.missionCtx(b, -1, S[o + F.shortage]);
        ctx.pLossTransit = 1 - shipSurvival(fx.reliability, travel);
        const e = evaluate(spec, ctx, this.econ);
        if (e.total > interstellarAllowance(this.econ, st.g[G.era], gdp, S[o + F.capital])) continue;
        const id = this.launch(b, target, year, year + travel, colonists, ftlTrip ? 1 : 0);
        if (id < 0) continue;
        this.book(b, e, colonists, 1, false);
        this.logMission(id, b, target, b, spec, ctx, e);
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

  /** A crew sent to found an outpost elsewhere in the same system: priced, paid for, and flown (or lost). */
  private crewMission(b: number, to: number, crew: number, year: number, dt: number): void {
    const st = this.st, S = st.S, o = b * NF;
    const spec: MissionSpec = { kind: 'crew', crew, cargoKg: crew * this.econ.mission.cargoPerCrewKg.base, route: this.route(b, to) };
    const ctx = this.missionCtx(b, to, S[o + F.shortage]);
    const e = evaluate(spec, ctx, this.econ);
    const f = this.funder(b);
    // only when some vehicle can fly the route and the polity can pay for the whole campaign
    if (!e.feasible || e.total > this.budgetLeft(f, dt)) return;
    const lost = this.rand() < e.pMissionLoss;
    if (!lost) this.found(st, to, STAGE.OUTPOST, crew, b, year);
    S[o + F.pop] = Math.max(0, S[o + F.pop] - crew);
    const id = this.travel(st, b, to, crew, year, year, FLOW.CREW);
    this.book(f, e, crew, 1, false);
    this.logMission(id, b, to, f, spec, ctx, e);
    this.missions.setOutcome(id, lost ? 2 : 1);
    this.log(EV['Mission launched'], b, to, id);
    if (lost) {
      const fi = this.flowIndex.get(id);
      if (this.ledger && fi !== undefined) this.ledger.flows[fi].lost = true;
      this.log(EV['Mission lost'], to, b, id);
    } else this.log(EV['Colony founded'], to, b, 0);
  }

  /** Returns the ship's mission id, or -1 when no slot is free. */
  private launch(from: number, to: number, depart: number, arrive: number, colonists: number, kind: number): number {
    const st = this.st;
    const n = st.g[G.nShips];
    if (n >= MAX_SHIPS) return -1;
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
    return st.ships[o + SH.flow];
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
      const pOk = shipSurvival(fx.reliability, voyage);
      const ok = this.rand() < pOk;
      this.missions.setOutcome(seq, ok ? 1 : 2);
      if (ok) {
        const ts = st.S[to * NF + F.stage];
        // someone got there first (a local crew): the ship just adds people
        const joined = isAlive(ts);
        if (joined) {
          st.S[to * NF + F.pop] += colonists;
          this.civ.onArrive(from, to, colonists);
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
    // independence, wars with causes and outcomes, grudges, effects at light speed (polity.ts)
    const r = this.civ.pol.step(dt, year, eraWar);
    this.st.g[G.rivals] = r.rivals; this.st.g[G.wars] += r.wars; this.st.g[G.dead] += r.dead;
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
      row[GM.heatLoad] = Math.max(row[GM.heatLoad], S[o + F.heatLoad]);
      reach = Math.max(reach, this.world.systems[this.bSys[b]].dist);
    }
    const P = Math.max(row[GM.pop], 1);
    row[GM.systems] = systems.size; row[GM.factions] = facs.size; row[GM.reach] = reach;
    row[GM.stability] = stabW / P; row[GM.happiness] = happW / P; row[GM.gini] = giniW / P; row[GM.medianAge] = ageW / P;
    row[GM.lifeExp] = leW / P; row[GM.tfr] = tfrW / P;
    row[GM.shortage] = (100 * shortP) / P;
    row[GM.kardashev] = row[GM.energy] > 0 ? (Math.log10(row[GM.energy]) - 6) / 10 : 0;
    row[GM.energyPerCap] = row[GM.energy] / P; row[GM.gdpPerCap] = row[GM.gdp] / P;
    row[GM.tfp] = g[G.tfp];
    for (let sy = 0; sy < this.world.systems.length; sy++) if (st.swarm[sy * 2] >= 0) row[GM.swarms]++;
    for (const sy of this.sysList) row[GM.swarmPower] += this.swarmW[sy];
    row[GM.launchCap] = g[G.launchCap]; row[GM.knowledge] = g[G.knowledge]; row[GM.research] = g[G.researchRate];
    row[GM.techs] = st.techDone.reduce((a, d) => a + (d >= 0 ? 1 : 0), 0);
    row[GM.shipsInTransit] = g[G.nShips]; row[GM.shipsLaunched] = g[G.shipsLaunched]; row[GM.shipsLost] = g[G.shipsLost];
    row[GM.dead] = g[G.dead]; row[GM.wars] = g[G.wars]; row[GM.faiths] = g[G.faiths]; row[GM.era] = g[G.era];
    g[G.prevShortage] = row[GM.shortage]; g[G.prevFactions] = row[GM.factions]; g[G.prevStability] = row[GM.stability];
    // transport: the step that led here, per year
    const dtr = step > 0 ? this.years[step] - this.years[step - 1] : 1;
    row[GM.transportSpend] = g[G.tSpend] / dtr; row[GM.transportCum] = g[G.transportCum];
    row[GM.transportShare] = row[GM.gdp] > 0 ? (100 * row[GM.transportSpend]) / row[GM.gdp] : 0;
    row[GM.propellantSpend] = g[G.tProp] / dtr; row[GM.hardwareSpend] = g[G.tHw] / dtr; row[GM.operationsSpend] = g[G.tOps] / dtr;
    row[GM.riskSpend] = g[G.tRisk] / dtr; row[GM.infraSpend] = g[G.tInfra] / dtr; row[GM.missionHwSpend] = g[G.tMhw] / dtr; row[GM.serviceSpend] = g[G.tService] / dtr;
    row[GM.launches] = g[G.tLaunches] / dtr; row[GM.tankerFlights] = g[G.tTankers] / dtr; row[GM.campaigns] = g[G.tCampaigns] / dtr;
    row[GM.payloadDispatched] = g[G.tPayloadKg] / 1000 / dtr; row[GM.peopleTransported] = g[G.tPeople] / dtr;
    row[GM.costPerKg] = g[G.tPayloadKg] > 0 ? g[G.tSpend] / g[G.tPayloadKg] : 0;
    row[GM.leoCostPerKg] = leoCostPerKg(this.missionCtx(earth, -1, 0), this.econ);

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
      step: st.step, S: st.S.slice(), g: st.g.slice(), techProg: st.techProg.slice(), techDone: st.techDone.slice(), techWhere: st.techWhere.slice(),
      ships: st.ships.slice(0, st.g[G.nShips] * NSH), settled: st.settled.slice(0, st.nSettled), nSettled: st.nSettled, rng: st.rng.slice(),
      shipRetry: st.shipRetry.slice(), gen: st.gen.slice(0, st.g[G.nGen] * NGC), ages: st.ages.slice(0, st.nSettled * NAGE), hx: cloneCiv(st.hx),
      swarm: st.swarm.slice(),
    };
  }

  restore(s: SimState): void {
    const nb = this.world.bodies.length;
    const ships = new Float64Array(MAX_SHIPS * NSH); ships.set(s.ships);
    const settled = new Int32Array(nb); settled.set(s.settled);
    this.st = {
      step: s.step, S: s.S.slice(), g: s.g.slice(), techProg: s.techProg.slice(), techDone: s.techDone.slice(), techWhere: s.techWhere.slice(),
      ships, settled, nSettled: s.nSettled, rng: s.rng.slice(), shipRetry: s.shipRetry.slice(),
      gen: (() => { const g = new Float64Array(MAX_GEN * NGC); g.set(s.gen); return g; })(),
      ages: (() => { const a = new Float64Array(nb * NAGE); a.set(s.ages); return a; })(),
      hx: cloneCiv(s.hx),
      swarm: s.swarm.slice(),
    };
    this.pos.fill(-1);
    for (let n = 0; n < s.nSettled; n++) this.pos[s.settled[n]] = n;
    // missions launched from here on will be flown again; ships still in flight have no outcome yet
    this.missions.truncateFrom(this.years[s.step]);
    for (let i = 0; i < s.ships.length / NSH; i++) this.missions.setOutcome(s.ships[i * NSH + SH.flow], 0);
    this.refShip.step = -1;
    this.rebuildPairs();
    this.surveyCursor = this.nbr.start.slice();
    this.recomputeFx();
  }

  /** ships in transit; `mission` is the id their launch event and economics record carry */
  shipList(): { from: number; to: number; depart: number; arrive: number; colonists: number; kind: number; mission: number }[] {
    const out = [];
    const sh = this.st.ships;
    for (let i = 0; i < this.st.g[G.nShips]; i++) {
      const o = i * NSH;
      out.push({ from: sh[o], to: sh[o + 1], depart: sh[o + 2], arrive: sh[o + 3], colonists: sh[o + 4], kind: sh[o + 5], mission: sh[o + SH.flow] });
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

/** Chance an interstellar ship arrives: better engineering helps, long voyages hurt. */
function shipSurvival(reliability: number, voyage: number): number { return Math.max(0.2, Math.min(0.97, 0.82 + reliability - 0.12 * (voyage / 200))); }
