// Politics with memory: independence, wars with causes and outcomes, grudges
// that outlast them, and effects that travel no faster than light (or the
// ships that carry them). All state is in st.hx (civ.ts).

import { EV, STAGE, isAlive } from './catalog.ts';
import { F, NF } from './metrics.ts';
import {
  H, HG, MAX_GRUDGE, MAX_PEND, MAX_WAR, NH, NWC, OUTCOME, PEND, WAR_CAUSE, WAR_KIND, WC, FC, NFC,
  GRIEV, MAX_POL, NPC, PC, REGIME, type Civ,
} from './civ.ts';
import { MAX_ROUNDS, TERMS, type PressCand, type StrikeCand, type WarMind } from './warMind.ts';

const LIVING = isAlive;
const C = 299_792_458;          // m/s
const MT = 4.184e15;            // J per megaton of TNT
/** Kinetic energy of m kg at beta = v/c: (γ−1)mc², which is ½mv²·γ-ish at these speeds. */
export function kineticJ(kg: number, beta: number): number { return (1 / Math.sqrt(1 - beta * beta) - 1) * kg * C * C; }
export const megatons = (J: number) => J / MT;

/** What each kind of government does to its people: war appetite, secession, research, inequality, military spending. */
export interface RegimeFx { war: number; secede: number; research: number; gini: number; mil: number }
export const REGIME_FX: RegimeFx[] = [
  /* CHARTER     */ { war: 1, secede: 1, research: 1, gini: 0, mil: 1 },
  /* ASSEMBLY    */ { war: 0.6, secede: 0.8, research: 1.05, gini: -0.05, mil: 0.8 },
  /* JUNTA       */ { war: 2.0, secede: 1.6, research: 0.85, gini: 0.06, mil: 2.2 },
  /* THEOCRACY   */ { war: 1.4, secede: 0.9, research: 0.85, gini: 0, mil: 1.2 },
  /* CORPORATE   */ { war: 0.9, secede: 1.2, research: 1.1, gini: 0.08, mil: 1 },
  /* TECHNOCRACY */ { war: 0.7, secede: 0.9, research: 1.2, gini: -0.02, mil: 0.9 },
  /* MACHINE     */ { war: 0.5, secede: 0.7, research: 1.35, gini: -0.06, mil: 0.7 },
  /* COMMITTEE   */ { war: 1.3, secede: 1.5, research: 0.7, gini: 0, mil: 1.3 },
];
const NEUTRAL: RegimeFx = REGIME_FX[0];
/** the order regimes are considered in: emergencies first, the plain charter last */
const PRIORITY = [7, 2, 6, 3, 1, 5, 4, 0];
export const REGIME_NAMES = ['Charter republic', 'Citizens\' assembly', 'Military junta', 'Theocracy', 'Corporate republic', 'Forecast technocracy', 'Machine trust', 'Emergency committee'];
/** forms of a polity's name: {B} is the capital's name, {X} a word in its own tongue */
export const POLITY_FORMS = ['Free {B}', 'the {X} Compact', 'the {B} Hegemony', 'the Republic of {B}', 'the {X} Commonwealth', 'the {B} Concord', 'the {X} Directorate', 'the {X} Concord', 'the Covenant of {X}', 'the {X} League'];
const X_FORMS = [1, 4, 6, 7, 9];

/** per-faction aggregates for choosing a regime */
interface PAgg { pop: number; gdp: number; gini: number; stab: number; worlds: number; hub: boolean; lastWar: number; faith: number; upl: number; res: number }

interface Agg { f: number; pop: number; mil: number; short: number; res: number; faith: Map<number, number>; bodies: number[] }

export class Politics {
  private c: Civ;
  /** who decides war and peace; null: the random rules below */
  mind: WarMind | null = null;
  /** with a mind: people each faction lost to war since the mind last cleared it */
  losses = new Map<number, number>();
  private firstFac: Float64Array; private contested: Uint8Array;
  constructor(c: Civ) {
    this.c = c;
    const ns = c.e.world.systems.length;
    this.firstFac = new Float64Array(ns); this.contested = new Uint8Array(ns);
  }
  private get e() { return this.c.e; }
  private get X() { return this.c.X; }

  step(dt: number, year: number, eraWar: number): { rivals: number; wars: number; dead: number } {
    this.regimes(dt, year, eraWar);
    this.independence(dt, year);
    this.mind?.begin(year, dt);
    const out = this.localWars(dt, year, eraWar);
    out.wars += this.kineticWars(dt, year, eraWar);
    out.dead += this.effects(year);
    out.dead += this.resolve(year);
    this.decayGrudges(dt);
    return out;
  }

  // ---------------------------------------------------------------- helpers

  private lagToCapital(b: number): number {
    const cap = this.e.st.S[b * NF + F.faction] | 0;
    return cap === b ? 0 : this.c.sysDistLy(b, cap);
  }
  private isDescendant(c: number, root: number): boolean {
    const S = this.e.st.S;
    for (let k = 0; k < 64 && c >= 0; k++) { if (c === root) return true; c = S[c * NF + F.parent]; }
    return false;
  }
  /** Light-lag in years (zero once ships or signals beat light). */
  lag(a: number, b: number): number { return this.e.fx.ftl > 0 ? 0 : this.c.sysDistLy(a, b); }

  grudge(a: number, b: number): number {
    const G = this.X.grudge, n = this.X.hg[HG.nGrudge];
    const x = Math.min(a, b), y = Math.max(a, b);
    for (let i = 0; i < n; i++) if (G[i * 3] === x && G[i * 3 + 1] === y) return G[i * 3 + 2];
    return 0;
  }
  addGrudge(a: number, b: number, v: number): void {
    if (a === b) return;
    const X = this.X, G = X.grudge, n = X.hg[HG.nGrudge];
    const x = Math.min(a, b), y = Math.max(a, b);
    for (let i = 0; i < n; i++) if (G[i * 3] === x && G[i * 3 + 1] === y) { G[i * 3 + 2] += v; return; }
    if (n >= MAX_GRUDGE) return;
    G[n * 3] = x; G[n * 3 + 1] = y; G[n * 3 + 2] = v;
    X.hg[HG.nGrudge] = n + 1;
  }
  private decayGrudges(dt: number): void {
    const X = this.X, G = X.grudge;
    let n = X.hg[HG.nGrudge];
    const k = Math.exp(-dt / 150);
    for (let i = 0; i < n; i++) {
      G[i * 3 + 2] *= k;
      if (G[i * 3 + 2] < 0.05) { n--; G.copyWithin(i * 3, n * 3, n * 3 + 3); i--; }
    }
    X.hg[HG.nGrudge] = n;
  }
  atWar(a: number, b: number): boolean {
    const W = this.X.war, n = this.X.hg[HG.nWar];
    for (let i = n - 1; i >= 0; i--) {
      const o = i * NWC;
      if (W[o + WC.outcome] !== OUTCOME.ONGOING) continue;
      if ((W[o + WC.a] === a && W[o + WC.b] === b) || (W[o + WC.a] === b && W[o + WC.b] === a)) return true;
    }
    return false;
  }
  private schedule(year: number, body: number, kind: number, mag: number, war: number): void {
    const X = this.X, n = X.hg[HG.nPend];
    if (n >= MAX_PEND) return;
    const P = X.pend, o = n * 5;
    P[o] = year; P[o + 1] = body; P[o + 2] = kind; P[o + 3] = mag; P[o + 4] = war;
    X.hg[HG.nPend] = n + 1;
  }
  /** Military a faction can bring to bear on a place: forces further away count for less. */
  reach(f: number, at: number): { mil: number; systems: number; pop: number } {
    const st = this.e.st, S = st.S;
    let mil = 0, pop = 0;
    const sys = new Set<number>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (S[o + F.faction] !== f || !LIVING(S[o + F.stage])) continue;
      mil += S[o + F.military] * Math.exp(-this.lag(b, at) / 20);
      pop += S[o + F.pop];
      sys.add(this.c.bSys[b]);
    }
    return { mil, systems: sys.size, pop };
  }
  private topFaith(a: Agg): number {
    let bf = -1, bv = 0;
    for (const [f, v] of a.faith) if (v > bv) { bv = v; bf = f; }
    return bf;
  }

  // ---------------------------------------------------------------- polities and their regimes

  /** The polity row governing faction f, or -1. */
  polityOf(f: number): number { return f >= 0 ? this.X.H[f * NH + H.pol] : -1; }
  /** What faction f's government does (neutral for a faction without one). */
  fx(f: number): RegimeFx {
    const p = this.polityOf(f);
    const r = p >= 0 ? this.X.pol[p * NPC + PC.regime] : -1;
    return r >= 0 ? REGIME_FX[r] : NEUTRAL;
  }
  private lost(f: number, n: number): void { this.losses.set(f, (this.losses.get(f) ?? 0) + n); }
  private markWar(o: number, a: number, b: number): void {
    const X = this.X, pa = this.polityOf(a), pb = this.polityOf(b);
    X.war[o + WC.pA] = pa; X.war[o + WC.pB] = pb;
    if (pa >= 0) X.pol[pa * NPC + PC.wars]++;
    if (pb >= 0) X.pol[pb * NPC + PC.wars]++;
  }

  /** A new government with capital `cap`, leaving faction `from` (-1: founded free). */
  private create(cap: number, from: number, year: number, griev: number, gval: number, nWorlds = -1): number {
    const X = this.X, n = X.hg[HG.nPol];
    if (n >= MAX_POL) return -1;
    const o = n * NPC, P = X.pol, S = this.e.st.S;
    P.fill(0, o, o + NPC);
    P[o + PC.cap] = cap; P[o + PC.from] = from; P[o + PC.year] = year; P[o + PC.alive] = 1; P[o + PC.griev] = griev; P[o + PC.gval] = gval;
    P[o + PC.fromPol] = this.polityOf(from);
    let worlds = nWorlds;
    if (worlds < 0) { worlds = 0; for (let m = 0; m < this.e.st.nSettled; m++) { const c = this.e.st.settled[m]; if (S[c * NF + F.faction] === cap && LIVING(S[c * NF + F.stage])) worlds++; } }
    // the name's form follows from why and how it began; catalogue numbers make poor flags
    const h = (k: number) => (Math.imul(cap + 1, 2654435761) ^ Math.imul(n + k, 40503)) >>> 0;
    const choice = worlds >= 5 ? [2] : ({ [GRIEV.TAXES]: [0, 9], [GRIEV.LAG]: [1, 7, 5], [GRIEV.STABILITY]: [6, 3], [GRIEV.FAITH]: [8], [GRIEV.SIZE]: [3, 2], [GRIEV.FAR]: [4, 7, 1], [GRIEV.IDENTITY]: [3, 4], [GRIEV.RESTORE]: [0, 3] } as Record<number, number[]>)[griev] ?? [4];
    let form = choice[h(1) % choice.length];
    if (POLITY_FORMS[form].includes('{B}') && /\d/.test(this.e.world.bodies[cap].name)) form = X_FORMS[h(2) % X_FORMS.length];
    P[o + PC.form] = form;
    P[o + PC.regime] = -1; // set from the state on its first step, without ceremony
    P[o + PC.since] = year; P[o + PC.target] = -1; P[o + PC.peakWorlds] = worlds;
    X.H[cap * NH + H.pol] = n;
    X.hg[HG.nPol] = n + 1;
    return n;
  }

  /** Give every independent faction a government, end the ones that fell, and let regimes follow the state. */
  private regimes(dt: number, year: number, eraWar: number): void {
    const X = this.X, st = this.e.st, S = st.S, Hh = X.H, P = X.pol;
    const agg = new Map<number, PAgg>();
    let tRes = 0, tPop = 0;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage])) continue;
      const f = S[o + F.faction];
      let a = agg.get(f);
      if (!a) agg.set(f, (a = { pop: 0, gdp: 0, gini: 0, stab: 0, worlds: 0, hub: false, lastWar: -1e9, faith: 0, upl: 0, res: 0 }));
      const pop = S[o + F.pop];
      a.upl += Hh[b * NH + H.upl] * pop; a.res += S[o + F.research]; tRes += S[o + F.research]; tPop += pop;
      a.pop += pop; a.gdp += S[o + F.gdp]; a.gini += S[o + F.gini] * pop; a.stab += S[o + F.stability] * pop; a.worlds++;
      if (S[o + F.stage] >= STAGE.HUB) a.hub = true;
      a.lastWar = Math.max(a.lastWar, Hh[b * NH + H.lastWar]);
      // the share holding the capital's faith
      const fc = Hh[f * NH + H.fa0];
      if (fc >= 0) for (let k = 0; k < 3; k++) if (Hh[b * NH + 2 * k] === fc) a.faith += pop * Hh[b * NH + 2 * k + 1];
    }
    // governments end when their capital falls, is annexed, or is ruled from elsewhere
    for (let p = 0; p < X.hg[HG.nPol]; p++) {
      const o = p * NPC;
      if (!P[o + PC.alive]) continue;
      const cap = P[o + PC.cap];
      if (!LIVING(S[cap * NF + F.stage]) || S[cap * NF + F.faction] !== cap || Hh[cap * NH + H.pol] !== p) {
        P[o + PC.alive] = 0; P[o + PC.end] = year;
        if (Hh[cap * NH + H.pol] === p) Hh[cap * NH + H.pol] = -1;
      }
    }
    const forecast = this.c.has('psychohistory') || this.c.has('agi');
    const rpcAll = tPop > 0 ? tRes / tPop : 0;
    for (const [f, a] of agg) {
      if (S[f * NF + F.faction] !== f || !LIVING(S[f * NF + F.stage])) continue;
      let p = Hh[f * NH + H.pol];
      if (p < 0) p = this.create(f, -1, year, f === this.e.world.earth ? GRIEV.NONE : GRIEV.FAR, this.c.sysDistLy(f, this.e.world.earth), a.worlds);
      if (p < 0) continue;
      const o = p * NPC;
      if (a.pop > P[o + PC.peakPop]) P[o + PC.peakPop] = a.pop;
      if (a.worlds > P[o + PC.peakWorlds]) P[o + PC.peakWorlds] = a.worlds;
      if (a.pop <= 0) continue;
      const gini = a.gini / a.pop, stab = a.stab / a.pop, upl = a.upl / a.pop, rpc = a.res / a.pop;
      const top = a.faith / a.pop;
      const fighting = year - a.lastWar < 25 || eraWar > 3;
      // what the state of the polity calls for; the regime in power holds on past the point that brought it
      const cur = P[o + PC.regime];
      const holds = (r: number): boolean => {
        const k = r === cur ? 1 : 0;
        switch (r) {
          case REGIME.COMMITTEE: return stab < 0.25 + 0.15 * k;
          case REGIME.JUNTA: return gini > 0.42 - 0.04 * k && (fighting || (k === 1 && year - a.lastWar < 60)) && stab < 0.6 + 0.1 * k;
          case REGIME.MACHINE: return upl > 0.4 - 0.1 * k;
          case REGIME.THEOCRACY: return top > 0.45 - 0.12 * k;
          case REGIME.ASSEMBLY: return a.pop < 2e7 * (1 + 2 * k) && a.worlds <= 2 + 2 * k && stab > 0.62 - 0.12 * k;
          case REGIME.TECHNOCRACY: return forecast && stab > 0.66 - 0.1 * k && rpc > (1.4 - 0.5 * k) * rpcAll;
          case REGIME.CORPORATE: return gini > 0.5 - 0.06 * k;
          default: return true;
        }
      };
      let target: number = REGIME.CHARTER;
      for (const r of PRIORITY) if (holds(r)) { target = r; break; }
      if (cur < 0) { P[o + PC.regime] = P[o + PC.target] = target; P[o + PC.since] = year; continue; }
      if (target === cur) { P[o + PC.pressure] = 0; P[o + PC.target] = cur; continue; }
      if (target !== P[o + PC.target]) { P[o + PC.target] = target; P[o + PC.pressure] = 0; }
      P[o + PC.pressure] += dt;
      // coups and emergencies come fast; reforms take a generation of pressure, and no regime falls in its first decades
      const need = target === REGIME.JUNTA || target === REGIME.COMMITTEE ? 4 : 25;
      if (P[o + PC.pressure] >= need && year - P[o + PC.since] >= 20) {
        P[o + PC.regime] = target; P[o + PC.since] = year; P[o + PC.pressure] = 0;
        this.c.log(EV['Regime change'], f, p, cur * 16 + target);
      }
    }
  }

  // ---------------------------------------------------------------- independence

  /** The strongest reason b has to leave faction `old`, scored from the numbers: [kind, value]. */
  private grievance(b: number, old: number, lag: number): [number, number] {
    const S = this.e.st.S, o = b * NF, Hh = this.X.H;
    const fb = Hh[b * NH + H.fa0], fo = Hh[old * NH + H.fa0];
    const ratio = S[o + F.pop] / Math.max(1, S[old * NF + F.pop]);
    const c: [number, number, number][] = [
      [GRIEV.LAG, lag / 3, lag],
      [GRIEV.TAXES, (S[o + F.gini] - 0.36) * 6, S[o + F.gini]],
      [GRIEV.IDENTITY, Math.min(0.5, (this.e.year - S[o + F.founded]) / 300), (this.e.year - S[o + F.founded]) / 28],
      [GRIEV.RESTORE, Hh[b * NH + H.indep] > -1e8 ? 1.3 : 0, Hh[b * NH + H.indep]],
      [GRIEV.STABILITY, (0.65 - S[o + F.stability]) * 4, S[o + F.stability]],
      [GRIEV.FAITH, fb >= 0 && fb !== fo ? 2 * Hh[b * NH + H.sh0] : 0, fb],
      [GRIEV.SIZE, Math.min(1.2, 3 * ratio), ratio],
    ];
    // every declaration mixes motives; the loudest one, give or take, is the one remembered
    for (const x of c) x[1] += (this.e.rand() - 0.5) * 0.5;
    c.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    return [c[0][0], c[0][2]];
  }

  private independence(dt: number, year: number): void {
    const st = this.e.st, S = st.S, fx = this.e.fx, Hh = this.X.H;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (stg < STAGE.COLONY || !isAlive(stg) || S[o + F.faction] === b) continue;
      const lag = this.lagToCapital(b);
      const sol = this.c.bSys[b] === 0;
      const p = dt * fx.secession * this.c.mul(b, H.mSecede) * (1 - S[o + F.stability]) * (sol ? (S[o + F.pop] > 1e6 ? 0.008 : 0) : 0.012 * Math.sqrt(lag / 5));
      if (this.e.rand() < p) {
        const old = S[o + F.faction];
        // what they say they are leaving over: the light-lag, the bill, or the disorder
        const [griev, gval] = this.grievance(b, old, lag);
        // the colony and everything it founded leave together
        for (let m = 0; m < st.nSettled; m++) {
          const c = st.settled[m];
          if (c === b || (S[c * NF + F.faction] === old && this.isDescendant(c, b))) S[c * NF + F.faction] = b;
        }
        Hh[b * NH + H.indep] = year; Hh[b * NH + H.indepFrom] = old;
        this.addGrudge(b, old, 0.6);
        const row = this.create(b, old, year, griev, gval);
        this.c.log(EV.Independence, b, old, row);
      }
    }
  }

  // ---------------------------------------------------------------- wars inside a star system

  private localWars(dt: number, year: number, eraWar: number): { rivals: number; wars: number; dead: number } {
    const st = this.e.st, S = st.S, fx = this.e.fx, Hh = this.X.H;
    // only systems held by more than one faction can have a war: find them cheaply first
    const firstFac = this.firstFac, contested = this.contested;
    firstFac.fill(-1); contested.fill(0);
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage])) continue;
      const sy = this.c.bSys[b], f = S[o + F.faction];
      if (firstFac[sy] < 0) firstFac[sy] = f; else if (firstFac[sy] !== f) contested[sy] = 1;
    }
    const bySys = new Map<number, Map<number, Agg>>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage]) || !contested[this.c.bSys[b]]) continue;
      const f = S[o + F.faction], sy = this.c.bSys[b];
      let m = bySys.get(sy);
      if (!m) bySys.set(sy, (m = new Map()));
      let a = m.get(f);
      if (!a) m.set(f, (a = { f, pop: 0, mil: 0, short: 0, res: 0, faith: new Map(), bodies: [] }));
      const pop = S[o + F.pop];
      a.pop += pop; a.mil += S[o + F.military]; a.short += S[o + F.shortage] * pop;
      a.res += S[o + F.water] + S[o + F.metals] + S[o + F.volatiles];
      a.bodies.push(b);
      for (let k = 0; k < 3; k++) {
        const fa = Hh[b * NH + 2 * k];
        if (fa >= 0) a.faith.set(fa, (a.faith.get(fa) ?? 0) + pop * Hh[b * NH + 2 * k + 1]);
      }
    }
    let rivals = 0;
    const pairs: { sy: number; A: Agg; B: Agg; w: number; cause: number; terms: number[] }[] = [];
    let W = 0;
    for (const [sy, m] of bySys) {
      if (m.size < 2) continue;
      rivals += m.size - 1;
      const L = [...m.values()];
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const A = L[i], B = L[j];
        if (this.atWar(A.f, B.f)) continue;
        const sA = A.pop > 0 ? A.short / A.pop : 0, sB = B.pop > 0 ? B.short / B.pop : 0;
        const resT = 3 * Math.max(sA, sB) + 0.3 * Math.min(2, Math.abs(Math.log10((A.res / Math.max(A.pop, 1) + 1) / (B.res / Math.max(B.pop, 1) + 1))));
        const fA = this.topFaith(A), fB = this.topFaith(B);
        let faithT = 0;
        if (fA !== fB && fA >= 0 && fB >= 0) {
          let d = 0;
          for (let a = 0; a < 5; a++) d += Math.abs(this.c.tenet(fA, a) - this.c.tenet(fB, a));
          faithT = 0.1 * d;
        }
        const ia = Hh[A.f * NH + H.indepFrom] === B.f ? Hh[A.f * NH + H.indep] : Hh[B.f * NH + H.indepFrom] === A.f ? Hh[B.f * NH + H.indep] : -1e9;
        const indepT = 1.5 * Math.exp(-(year - ia) / 80);
        const grudgeT = 0.5 * this.grudge(A.f, B.f);
        const terms = [resT, faithT, indepT, grudgeT];
        let cause = 0;
        for (let k = 1; k < 4; k++) if (terms[k] > terms[cause]) cause = k;
        const w = (0.3 + resT + faithT + indepT + grudgeT) * Math.sqrt(this.c.warMul(A.f) * this.c.warMul(B.f));
        pairs.push({ sy, A, B, w, cause, terms });
        W += w;
      }
    }
    const out = { rivals, wars: 0, dead: 0 };
    if (!pairs.length) return out;
    if (this.mind) {
      const cands: PressCand[] = pairs.map((p) => ({ sy: p.sy, a: p.A.f, b: p.B.f, cause: p.cause, res: p.terms[0], faith: p.terms[1], indep: p.terms[2], grudge: p.terms[3] }));
      const first = this.mind.press(cands, year);
      const busy = new Set<number>();
      for (let k = 0; k < pairs.length && out.wars < 4; k++) {
        const p = pairs[k];
        if (first[k] < 0 || busy.has(p.A.f) || busy.has(p.B.f)) continue;
        busy.add(p.A.f); busy.add(p.B.f);
        out.dead += this.startLocal(year, p.sy, p.A, p.B, p.cause, first[k]);
        out.wars++;
      }
      return out;
    }
    const R = dt * 0.004 * eraWar * fx.war * Math.sqrt(Math.min(pairs.length, 16));
    if (this.e.rand() < R * Math.min(3, W / pairs.length / 0.8)) {
      let x = this.e.rand() * W, k = 0;
      while (k < pairs.length - 1 && (x -= pairs[k].w) > 0) k++;
      const p = pairs[k];
      out.dead += this.startLocal(year, p.sy, p.A, p.B, p.cause);
      out.wars++;
    }
    return out;
  }

  private startLocal(year: number, sy: number, A0: Agg, B0: Agg, cause: number, first = -1): number {
    const X = this.X, st = this.e.st, S = st.S, Hh = X.H;
    const n = X.hg[HG.nWar];
    if (n >= MAX_WAR) return 0;
    // who strikes first: the hungry side in a resource war, the old master against a rebel, else the stronger
    let A = A0, B = B0;
    const sh = (a: Agg) => (a.pop > 0 ? a.short / a.pop : 0);
    if (first >= 0 ? first === B.f : cause === WAR_CAUSE.RESOURCES ? sh(B) > sh(A) : cause === WAR_CAUSE.INDEPENDENCE ? Hh[A.f * NH + H.indepFrom] === B.f : B.mil > A.mil) { A = B0; B = A0; }
    const front = A.bodies.reduce((x, y) => (S[y * NF + F.pop] > S[x * NF + F.pop] ? y : x));
    const target = B.bodies.reduce((x, y) => (S[y * NF + F.pop] > S[x * NF + F.pop] ? y : x));
    const ra = this.reach(A.f, front).mil, rb = this.reach(B.f, front).mil;
    const R = ra / Math.max(rb, 1);
    const sev = 0.02 + this.e.rand() * 0.2;
    const close = 1 - Math.abs(R - 1) / (R + 1);
    const o = n * NWC, Wt = X.war;
    Wt.fill(0, o, o + NWC);
    Wt[o + WC.a] = A.f; Wt[o + WC.b] = B.f; Wt[o + WC.sys] = sy; Wt[o + WC.start] = year;
    Wt[o + WC.end] = year + 1 + this.e.rand() * 12 * close; Wt[o + WC.cause] = cause; Wt[o + WC.kind] = WAR_KIND.LOCAL;
    Wt[o + WC.outcome] = OUTCOME.ONGOING; Wt[o + WC.winner] = -1; Wt[o + WC.front] = front; Wt[o + WC.target] = target; Wt[o + WC.sev] = sev;
    Wt[o + WC.fA] = this.topFaith(A); Wt[o + WC.fB] = this.topFaith(B);
    this.markWar(o, A.f, B.f);
    Wt[o + WC.indep] = Hh[A.f * NH + H.indepFrom] === B.f ? Hh[A.f * NH + H.indep] : Hh[B.f * NH + H.indepFrom] === A.f ? Hh[B.f * NH + H.indep] : -1;
    X.hg[HG.nWar] = n + 1;
    // fighting happens where both sides are: the theatre system, within light-seconds
    const [killed, dead] = this.battle(year, A.bodies, B.bodies, R, sev);
    Wt[o + WC.killed] = killed;
    // everyone else in both factions hears of it at light speed and mobilises then
    for (let m = 0; m < st.nSettled; m++) {
      const c = st.settled[m], oc = c * NF;
      const f = S[oc + F.faction];
      if ((f !== A.f && f !== B.f) || this.c.bSys[c] === sy || !LIVING(S[oc + F.stage])) continue;
      const d = this.lag(c, front);
      if (d < 300) this.schedule(year + d, c, PEND.MOBILIZE, 0.03, n);
    }
    this.addGrudge(A.f, B.f, 1);
    this.c.log(EV.War, front, target, n);
    return dead;
  }

  /** One round of fighting in a system: each side loses in proportion to the other's force (R = A's over B's). */
  private battle(year: number, aBodies: number[], bBodies: number[], R: number, sev: number): [killed: number, dead: number] {
    const S = this.e.st.S, Hh = this.X.H;
    let killed = 0, dead = 0;
    const lossA = Math.min(1.7, Math.max(0.3, 2 / (1 + R))), lossB = Math.min(1.7, Math.max(0.3, (2 * R) / (1 + R)));
    for (const [bodies, loss] of [[aBodies, lossA], [bBodies, lossB]] as const) {
      for (const c of bodies) {
        const oc = c * NF;
        const k = Math.min(0.6, sev * (0.5 + this.e.rand()) * loss);
        killed += S[oc + F.pop] * k;
        if (this.mind) this.lost(S[oc + F.faction], S[oc + F.pop] * k);
        S[oc + F.pop] *= 1 - k; S[oc + F.capital] *= 1 - k; S[oc + F.stability] = Math.max(0, S[oc + F.stability] - 0.15);
        Hh[c * NH + H.lastWar] = year;
        if (S[oc + F.stage] <= STAGE.BASE && this.e.rand() < sev) { S[oc + F.stage] = STAGE.DEAD; S[oc + F.pop] = 0; dead++; }
      }
    }
    return [killed, dead];
  }

  // ---------------------------------------------------------------- relativistic kinetic war between stars

  private kineticWars(dt: number, year: number, eraWar: number): number {
    const fx = this.e.fx, X = this.X, S = this.e.st.S, G = X.grudge;
    const beta = Math.min(0.5, fx.shipSpeed);
    if (beta < 0.05) return 0;
    let wars = 0;
    const cands: StrikeCand[] = [];
    for (let i = 0; i < X.hg[HG.nGrudge]; i++) {
      const v = G[i * 3 + 2];
      if (v < 0.4) continue;
      let a = G[i * 3], b = G[i * 3 + 1];
      if (!LIVING(S[a * NF + F.stage]) || !LIVING(S[b * NF + F.stage]) || S[a * NF + F.faction] !== a || S[b * NF + F.faction] !== b) continue;
      if (this.c.bSys[a] === this.c.bSys[b]) continue;
      const d = this.c.sysDistLy(a, b);
      if (d > 60 || this.atWar(a, b)) continue;
      if (this.mind) { cands.push({ a, b, d, grudge: v, beta }); continue; }
      const pMax = dt * 0.006 * eraWar * fx.war * (v - 0.4) * Math.sqrt(Math.max(this.c.warMul(a), this.c.warMul(b)));
      const u = this.e.rand();
      if (u >= pMax) continue;
      let ra = this.reach(a, a), rb = this.reach(b, b);
      if (rb.mil > ra.mil) { [a, b] = [b, a]; [ra, rb] = [rb, ra]; }
      // second strike: every system the target holds is one more place a reply can come from
      const deter = 1 + 0.8 * Math.pow(Math.max(0, rb.systems - 1), 1.3);
      if (u >= pMax * Math.sqrt(this.c.warMul(a) / Math.max(this.c.warMul(a), this.c.warMul(b))) / deter) continue;
      wars += this.launchStrike(year, a, b, ra, rb, d, beta);
    }
    if (this.mind && cands.length) {
      const who = this.mind.strike(cands, year);
      for (let k = 0; k < cands.length; k++) {
        if (who[k] < 0) continue;
        const c = cands[k], a = who[k], b = a === c.a ? c.b : c.a;
        if (this.atWar(a, b)) continue;
        wars += this.launchStrike(year, a, b, this.reach(a, a), this.reach(b, b), c.d, beta);
      }
    }
    return wars;
  }

  private launchStrike(year: number, a: number, b: number, ra: { mil: number; systems: number }, rb: { mil: number; systems: number }, d: number, beta: number): number {
    const X = this.X, n = X.hg[HG.nWar];
    if (n >= MAX_WAR) return 0;
    const tonnes = Math.min(1e6, Math.max(1, ra.mil / 1e12));
    const E = kineticJ(tonnes * 1000, beta);
    const arrive = year + d / beta;
    const o = n * NWC, Wt = X.war;
    Wt.fill(0, o, o + NWC);
    Wt[o + WC.a] = a; Wt[o + WC.b] = b; Wt[o + WC.sys] = this.c.bSys[b]; Wt[o + WC.start] = year; Wt[o + WC.cause] = WAR_CAUSE.GRUDGE;
    Wt[o + WC.kind] = WAR_KIND.KINETIC; Wt[o + WC.outcome] = OUTCOME.ONGOING; Wt[o + WC.winner] = -1; Wt[o + WC.front] = a; Wt[o + WC.target] = b;
    Wt[o + WC.energy] = E; Wt[o + WC.from] = this.c.bSys[a]; Wt[o + WC.speed] = beta; Wt[o + WC.mass] = tonnes;
    this.markWar(o, a, b);
    let end = arrive;
    this.schedule(arrive, b, PEND.STRIKE, E, n);
    // the target sees nothing coming until the light of the launch arrives, d years later, barely ahead of the strike;
    // if it holds other systems, they reply from there
    if (rb.systems >= 2) {
      const tB = Math.min(1e6, Math.max(1, rb.mil / 1e12));
      const reply = arrive + d / beta;
      this.schedule(reply, a, PEND.STRIKE, kineticJ(tB * 1000, beta), n);
      end = reply;
    }
    Wt[o + WC.end] = end;
    X.hg[HG.nWar] = n + 1;
    this.addGrudge(a, b, 1.5);
    this.c.log(EV.War, a, b, n);
    return 1;
  }

  // ---------------------------------------------------------------- effects in flight, and the peace

  private effects(year: number): number {
    const X = this.X, P = X.pend, st = this.e.st, S = st.S, Hh = X.H;
    let n = X.hg[HG.nPend], dead = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      if (P[o] > year) continue;
      const b = P[o + 1], kind = P[o + 2], mag = P[o + 3], w = P[o + 4], ob = b * NF;
      if (LIVING(S[ob + F.stage])) {
        if (kind === PEND.MOBILIZE) { S[ob + F.capital] *= 1 - mag; S[ob + F.stability] = Math.max(0, S[ob + F.stability] - 0.03); }
        else if (kind === PEND.STRIKE) {
          const k = Math.min(0.7, mag / (Math.max(S[ob + F.pop], 1) * 2e13));
          X.war[w * NWC + WC.killed] += S[ob + F.pop] * k;
          if (this.mind) this.lost(S[ob + F.faction], S[ob + F.pop] * k);
          S[ob + F.pop] *= 1 - k; S[ob + F.capital] *= 1 - k; S[ob + F.stability] = Math.max(0, S[ob + F.stability] - 0.2);
          Hh[b * NH + H.lastWar] = year;
          this.c.onDisaster(b, EV['Kinetic strike'], k, year);
          if (k > 0.5 && S[ob + F.stage] <= STAGE.COLONY) { S[ob + F.stage] = STAGE.DEAD; S[ob + F.pop] = 0; dead++; }
          this.c.log(EV['Kinetic strike'], b, k, w);
        }
      }
      n--; P.copyWithin(o, n * 5, n * 5 + 5); i--;
    }
    X.hg[HG.nPend] = n;
    return dead;
  }

  private resolve(year: number): number {
    const X = this.X, Wt = X.war, st = this.e.st, S = st.S;
    let fallen = 0;
    for (let i = 0; i < X.hg[HG.nWar]; i++) {
      const o = i * NWC;
      if (Wt[o + WC.outcome] !== OUTCOME.ONGOING || Wt[o + WC.end] > year) continue;
      const a = Wt[o + WC.a], b = Wt[o + WC.b], sy = Wt[o + WC.sys];
      let outcome: number = OUTCOME.PEACE, winner = -1;
      if (Wt[o + WC.kind] === WAR_KIND.LOCAL) {
        const front = Wt[o + WC.front];
        const ra = this.reach(a, front), rb = this.reach(b, front);
        const R = ra.mil / Math.max(rb.mil, 1), ratio = Math.max(R, 1 / Math.max(R, 1e-9));
        winner = R >= 1 ? a : b;
        const loser = winner === a ? b : a;
        let wPop = 0, lPop = 0, lCap = 0, wCap = 0, lTot = 0;
        const lBodies: number[] = [], wBodies: number[] = [];
        for (let n = 0; n < st.nSettled; n++) {
          const c = st.settled[n], oc = c * NF;
          if (!LIVING(S[oc + F.stage])) continue;
          const f = S[oc + F.faction];
          if (f === loser) lTot += S[oc + F.pop];
          if (this.c.bSys[c] !== sy) continue;
          if (f === winner) { wPop += S[oc + F.pop]; wCap += S[oc + F.capital]; wBodies.push(c); }
          else if (f === loser) { lPop += S[oc + F.pop]; lCap += S[oc + F.capital]; lBodies.push(c); }
        }
        let choice = -1;
        if (this.mind) {
          const canAnnex = ratio > 3 && lBodies.length > 0 && lPop < 0.3 * wPop, canRep = ratio > 1.5 && lCap > 0 && wBodies.length > 0;
          const canFight = Wt[o + WC.rounds] < MAX_ROUNDS && lBodies.length > 0 && wBodies.length > 0;
          choice = this.mind.terms({ war: i, winner, loser, ratio, can: [true, canRep, canAnnex, canFight] }, year);
          if (choice === TERMS.FIGHT_ON && canFight) {
            // another round where the war is: the end moves out, nothing is signed yet
            const [killed, dead] = winner === a ? this.battle(year, wBodies, lBodies, R, Wt[o + WC.sev]) : this.battle(year, lBodies, wBodies, 1 / Math.max(R, 1e-9), Wt[o + WC.sev]);
            Wt[o + WC.killed] += killed; Wt[o + WC.rounds]++;
            Wt[o + WC.end] = year + 2 + this.e.rand() * 6;
            fallen += dead;
            continue;
          }
          if (!(choice === TERMS.ANNEX && canAnnex) && !(choice === TERMS.REPARATIONS && canRep)) choice = TERMS.PEACE;
        }
        if (choice < 0 ? ratio > 3 && lBodies.length && lPop < 0.3 * wPop : choice === TERMS.ANNEX) {
          // annexation: the small settlements of the loser in this system change flags
          outcome = OUTCOME.ANNEX;
          const whole = this.c.bSys[loser] === sy && lTot < 0.3 * wPop;
          for (let n = 0; n < st.nSettled; n++) {
            const c = st.settled[n], oc = c * NF;
            if (S[oc + F.faction] !== loser) continue;
            if (whole || (this.c.bSys[c] === sy && c !== loser)) S[oc + F.faction] = winner;
          }
          this.addGrudge(a, b, 1);
        } else if (choice < 0 ? ratio > 1.5 && lCap > 0 && wBodies.length : choice === TERMS.REPARATIONS) {
          // reparations: a tenth of the loser's capital here, paid to the winner's settlements here
          outcome = OUTCOME.REPARATIONS;
          const pay = 0.1 * lCap;
          for (const c of lBodies) S[c * NF + F.capital] *= 0.9;
          for (const c of wBodies) S[c * NF + F.capital] += pay * (wCap > 0 ? S[c * NF + F.capital] / wCap : 1 / wBodies.length);
          Wt[o + WC.energy] = pay;
          this.addGrudge(a, b, 0.5);
        } else winner = -1;
      }
      Wt[o + WC.outcome] = outcome; Wt[o + WC.winner] = winner;
      const at = Wt[o + WC.kind] === WAR_KIND.LOCAL ? Wt[o + WC.front] : b;
      this.c.log(EV.Treaty, at, i, outcome);
    }
    return fallen;
  }
}

export { FC, NFC };
