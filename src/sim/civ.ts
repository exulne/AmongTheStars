// Civilisation state that remembers: faiths that spread, split and die.
// Everything here lives in typed arrays inside SimState (st.hx), so a
// snapshot carries it and a replay reproduces it exactly. The engine calls in
// at a few points (founding, arrivals, local events, politics) and reads back
// per-settlement multipliers that nudge growth, launches, research,
// divergence and secession.

import { EV, STAGE, TECHS, isAlive } from './catalog.ts';
import { F, NF } from './metrics.ts';
import { NPERIODS } from './ledger.ts';
import type { Engine } from './engine.ts';
import { Politics } from './polity.ts';

// ---------------------------------------------------------------- per-settlement columns

export const H = {
  fa0: 0, sh0: 1, fa1: 2, sh1: 3, fa2: 4, sh2: 5, // top three faiths and their shares (the rest keep Earth's old faiths)
  plague: 6,      // year of the last plague that killed more than 5%
  disaster: 7,    // year of the last disaster of any kind
  // nudges read by the engine next step (1 = no effect)
  mGrowth: 8, mLaunch: 9, mResearch: 10, mDiv: 11, mSecede: 12,
  indep: 13,      // on a faction's capital: year it declared independence
  indepFrom: 14,  // ... and the faction it left
  lastWar: 15,    // year this settlement last saw fighting
  pol: 16,        // on a faction's capital: its row in the polity table (-1 none)
  dGini: 17,      // added to the settlement's inequality target (regime)
  mMil: 18,       // multiplies its military spending (regime)
  adapt: 19,      // share of its people engineered for their world
  upl: 20,        // share of its minds running on machines
  posture: 21,    // on a faction's capital: extra military spending its war mind chose (0 = none; multiplier is 1 + this)
} as const;
export const NH = 40;

// ---------------------------------------------------------------- faith table

/** Tenet axes: +1 is the first pole, -1 the second. */
export const AXES = ['body', 'earth', 'machines', 'children', 'expansion'] as const;
export const POLES: [string, string][] = [
  ['augmented', 'pure'], ['forget', 'return'], ['kin', 'tool'], ['engineered', 'natural'], ['sow', 'stay'],
];
export const TENET_TEXT: [string, string][] = [
  ['the body is a draft', 'the flesh is holy and nothing is to be added to it'],
  ['Earth is a myth', 'one day we go home to Earth'],
  ['machines are kin', 'machines are tools and nothing more'],
  ['children are designed with love', 'children come as they come'],
  ['every world is a field to sow', 'the world beneath us is enough'],
];

export const FC = { home: 0, year: 1, t: 2, parent: 7, alive: 8, worlds: 9, peak: 10, mile: 11, adherents: 12, end: 13, cause: 14 } as const;
export const NFC = 16;
export const MAX_FAITH = 1024;
/** why a faith was founded (FC.cause) */
export const FAITH_CAUSE = { DRIFT: 0, PLAGUE: 1, FAR: 2, BODY: 3, HUNGER: 4, SCHISM: 5 } as const;
const MILESTONES = [3, 10, 30, 100, 300];

// global slots
export const HG = { nFaith: 0, living: 1, nWar: 2, nGrudge: 3, nPend: 4, nPol: 5 } as const;
const NHG = 64;

// ---------------------------------------------------------------- wars, grudges, effects in flight

/** The war log: every war ever, one row each (outcome -1 while it lasts). */
export const WC = {
  a: 0, b: 1, sys: 2, start: 3, end: 4, cause: 5, kind: 6, outcome: 7, winner: 8, front: 9, target: 10,
  sev: 11, killed: 12, energy: 13, from: 14, speed: 15, mass: 16, fA: 17, fB: 18, indep: 19,
  pA: 20, pB: 21, // polity rows of the two sides when it began
  rounds: 22,     // extra rounds fought after the first resolution came due (war minds only)
} as const;
export const NWC = 24;
export const MAX_WAR = 4096;
export const WAR_CAUSE = { RESOURCES: 0, FAITH: 1, INDEPENDENCE: 2, GRUDGE: 3 } as const;
export const WAR_KIND = { LOCAL: 0, KINETIC: 1 } as const;
export const OUTCOME = { ONGOING: -1, PEACE: 0, ANNEX: 1, REPARATIONS: 2 } as const;
export const MAX_GRUDGE = 1024; // rows of (factionA < factionB, value)
export const MAX_PEND = 2048;   // rows of (year, body, kind, magnitude, war)
export const PEND = { MOBILIZE: 0, STRIKE: 1 } as const;

// ---------------------------------------------------------------- polities

/** The polity table: one row per government that ever was (an independence, a colony beyond reach, Earth). */
export const PC = {
  cap: 0, from: 1, year: 2, end: 3, alive: 4, griev: 5, gval: 6, form: 7, regime: 8, since: 9,
  target: 10, pressure: 11, peakPop: 12, peakWorlds: 13, wars: 14, fromPol: 15,
} as const;
export const NPC = 16;
export const MAX_POL = 2048;
/** why it left (PC.griev) */
export const GRIEV = { NONE: 0, LAG: 1, TAXES: 2, STABILITY: 3, FAR: 4, FAITH: 5, SIZE: 6, IDENTITY: 7, RESTORE: 8 } as const;
export const REGIME = { CHARTER: 0, ASSEMBLY: 1, JUNTA: 2, THEOCRACY: 3, CORPORATE: 4, TECHNOCRACY: 5, MACHINE: 6, COMMITTEE: 7 } as const;

export interface CivState {
  H: Float64Array;
  faith: Float64Array;
  hg: Float64Array;
  war: Float64Array;
  grudge: Float64Array;
  pend: Float64Array;
  pol: Float64Array;
}

export function cloneCiv(s: CivState): CivState {
  return { H: s.H.slice(), faith: s.faith.slice(), hg: s.hg.slice(), war: s.war.slice(), grudge: s.grudge.slice(), pend: s.pend.slice(), pol: s.pol.slice() };
}
export function civParts(s: CivState): [string, ArrayLike<number>][] {
  return [['hx.H', s.H], ['hx.faith', s.faith.subarray(0, s.hg[HG.nFaith] * NFC)], ['hx.hg', s.hg],
    ['hx.war', s.war.subarray(0, s.hg[HG.nWar] * NWC)], ['hx.grudge', s.grudge.subarray(0, s.hg[HG.nGrudge] * 3)], ['hx.pend', s.pend.subarray(0, s.hg[HG.nPend] * 5)], ['hx.pol', s.pol.subarray(0, s.hg[HG.nPol] * NPC)]];
}

const TECH_INDEX = new Map(TECHS.map((t, i) => [t.id, i]));
const LIVING = isAlive;

export class Civ {
  e: Engine;
  log: (type: number, body: number, a?: number, b?: number) => void;
  bSys: Int32Array;
  bG: Float64Array;
  sysDist: Float64Array;
  pol: Politics;
  private sx: Float64Array; private sy: Float64Array; private sz: Float64Array;
  private P = new Float64Array(5);
  private worlds = new Float64Array(MAX_FAITH);
  private adher = new Float64Array(MAX_FAITH);
  /** main run only: per body, the faith slots at the end of every demography period */
  faithHist = new Map<number, { f: Int16Array; s: Uint8Array; a: Uint8Array; u: Uint8Array }>();

  constructor(e: Engine, log: (type: number, body: number, a?: number, b?: number) => void) {
    this.e = e; this.log = log;
    const w = e.world;
    this.bSys = Int32Array.from(w.bodies, (b) => b.system);
    this.bG = Float64Array.from(w.bodies, (b) => b.g);
    this.sysDist = Float64Array.from(w.systems, (s) => s.dist);
    this.sx = Float64Array.from(w.systems, (s) => s.x); this.sy = Float64Array.from(w.systems, (s) => s.y); this.sz = Float64Array.from(w.systems, (s) => s.z);
    this.pol = new Politics(this);
  }

  init(nb: number): CivState {
    const H0 = new Float64Array(nb * NH);
    for (let b = 0; b < nb; b++) this.blank(H0, b);
    return { H: H0, faith: new Float64Array(MAX_FAITH * NFC), hg: new Float64Array(NHG), war: new Float64Array(MAX_WAR * NWC), grudge: new Float64Array(MAX_GRUDGE * 3), pend: new Float64Array(MAX_PEND * 5), pol: new Float64Array(MAX_POL * NPC) };
  }

  private blank(Hh: Float64Array, b: number): void {
    const o = b * NH;
    Hh.fill(0, o, o + NH);
    Hh[o + H.fa0] = Hh[o + H.fa1] = Hh[o + H.fa2] = -1;
    Hh[o + H.plague] = Hh[o + H.disaster] = Hh[o + H.indep] = Hh[o + H.lastWar] = -1e9;
    Hh[o + H.indepFrom] = Hh[o + H.pol] = -1;
    Hh[o + H.mMil] = 1;
    Hh[o + H.mGrowth] = Hh[o + H.mLaunch] = Hh[o + H.mResearch] = Hh[o + H.mDiv] = Hh[o + H.mSecede] = 1;
  }

  get X(): CivState { return this.e.st.hx; }
  has(id: string, year = Infinity): boolean { const d = this.e.st.techDone[TECH_INDEX.get(id)!]; return d >= 0 && d <= year; }
  sysDistLy(a: number, b: number): number {
    const s1 = this.bSys[a], s2 = this.bSys[b];
    return Math.hypot(this.sx[s1] - this.sx[s2], this.sy[s1] - this.sy[s2], this.sz[s1] - this.sz[s2]);
  }
  /** how warlike a faction's government makes it (1 = neutral) */
  warMul(f: number): number { return this.pol.fx(f).war; }
  /** a per-settlement multiplier (column of H) for the engine */
  mul(b: number, col: number): number { return this.X.H[b * NH + col]; }

  // ---------------------------------------------------------------- hooks from the engine

  /** A settlement is (re)founded from `parent`: the founders bring their faiths. */
  onFound(X: CivState, body: number, parent: number, stage: number): void {
    const Hh = X.H;
    if (stage === STAGE.SURVEY) return;
    this.blank(Hh, body);
    if (parent < 0) return;
    const o = body * NH, p = parent * NH;
    for (let k = 0; k < 6; k++) Hh[o + k] = Hh[p + k];
    Hh[o + H.upl] = Hh[p + H.upl]; // minds travel as they are; bodies are remade for each world
  }

  /** A ship's people join an existing settlement: their faiths mix in by head-count. */
  onArrive(from: number, to: number, n: number): void {
    const S = this.e.st.S, pop = S[to * NF + F.pop];
    if (pop <= 0) return;
    this.mixInto(to, this.slots(from), Math.min(1, n / pop));
  }

  /** Local trouble that shapes what people believe next. */
  onDisaster(b: number, type: number, k: number, year: number): void {
    const Hh = this.X.H;
    Hh[b * NH + H.disaster] = year;
    if (type === EV.Plague && k > 0.05) Hh[b * NH + H.plague] = year;
  }

  // ---------------------------------------------------------------- faiths

  slots(b: number): [number, number][] {
    const Hh = this.X.H, o = b * NH, out: [number, number][] = [];
    for (let k = 0; k < 3; k++) if (Hh[o + 2 * k] >= 0) out.push([Hh[o + 2 * k], Hh[o + 2 * k + 1]]);
    return out;
  }
  private setSlots(b: number, sl: [number, number][]): void {
    const Hh = this.X.H, o = b * NH;
    sl.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    let tot = 0;
    for (let k = 0; k < 3; k++) {
      const s = sl[k] && sl[k][1] >= 0.02 ? sl[k] : null;
      Hh[o + 2 * k] = s ? s[0] : -1;
      Hh[o + 2 * k + 1] = s ? Math.min(1 - tot, s[1]) : 0;
      if (s) tot += Hh[o + 2 * k + 1];
    }
  }
  /** Blend a settlement's faith mix toward another mix by fraction k. */
  private mixInto(b: number, mix: [number, number][], k: number): void {
    if (k <= 0) return;
    const m = new Map<number, number>();
    for (const [f, s] of this.slots(b)) m.set(f, s * (1 - k));
    for (const [f, s] of mix) m.set(f, (m.get(f) ?? 0) + s * k);
    this.setSlots(b, [...m.entries()]);
  }

  tenet(f: number, axis: number): number { return this.X.faith[f * NFC + FC.t + axis]; }

  /** What local life pushes people to believe, per axis (+ = first pole). */
  private pressure(b: number, year: number): Float64Array {
    const S = this.e.st.S, o = b * NF, Hh = this.X.H, P = this.P;
    const div = S[o + F.divergence], plague = year - Hh[b * NH + H.plague] < 60;
    const crowd = S[o + F.capacity] > 0 ? S[o + F.pop] / S[o + F.capacity] : 1;
    const d = this.sysDist[this.bSys[b]];
    P[0] = 2 * div - 0.4 + (plague ? -1.5 : 0) + (this.has('bioAdapt') ? 0.3 : 0);
    P[1] = d > 20 ? 1.5 : d > 0 ? (d / 20) * 1.5 - 0.6 : -0.8;
    P[2] = (this.has('agi') ? 0.4 : -0.4) + (this.has('mindUpload') ? 0.6 : 0);
    P[3] = (this.has('bioAdapt') ? 0.5 : -0.3) + (plague ? -0.8 : 0) + (div > 0.5 ? 0.5 : 0);
    P[4] = 2 * (crowd - 0.7) - 3 * S[o + F.shortage] + (S[o + F.stage] >= STAGE.CITY ? 0.2 : 0);
    return P;
  }
  private fit(f: number, P: Float64Array): number {
    let s = 0;
    for (let a = 0; a < 5; a++) s += this.tenet(f, a) * Math.max(-1.5, Math.min(1.5, P[a]));
    return s / 3;
  }

  /** A prophet appears at b: tenets come from the settlement's own state. */
  newFaith(b: number, year: number): void {
    const X = this.X;
    const n = X.hg[HG.nFaith];
    if (n >= MAX_FAITH) return;
    const P = this.pressure(b, year);
    const score = Array.from(P, (p) => p + (this.e.rand() - 0.5) * 0.8);
    const order = [0, 1, 2, 3, 4].sort((x, y) => Math.abs(score[y]) - Math.abs(score[x]) || x - y);
    const o = n * NFC, Hh = X.H;
    X.faith.fill(0, o, o + NFC);
    X.faith[o + FC.home] = b; X.faith[o + FC.year] = year; X.faith[o + FC.parent] = -1; X.faith[o + FC.alive] = 1;
    for (let k = 0; k < 3; k++) X.faith[o + FC.t + order[k]] = score[order[k]] >= 0 ? 1 : -1;
    const plague = year - Hh[b * NH + H.plague] < 60;
    X.faith[o + FC.cause] = plague ? FAITH_CAUSE.PLAGUE : this.e.st.S[b * NF + F.shortage] > 0.2 ? FAITH_CAUSE.HUNGER
      : order.slice(0, 3).includes(1) && P[1] > 1 ? FAITH_CAUSE.FAR : order[0] === 0 && P[0] > 0.5 ? FAITH_CAUSE.BODY : FAITH_CAUSE.DRIFT;
    X.hg[HG.nFaith] = n + 1;
    const happy = this.e.st.S[b * NF + F.happiness];
    const sl = this.slots(b).map(([f, s]) => [f, s * 0.8] as [number, number]);
    sl.push([n, 0.04 + 0.25 * (1 - happy)]);
    this.setSlots(b, sl);
    this.e.st.S[b * NF + F.culture] = n + 1;
    this.log(EV['New faith'], b, n, 0);
  }

  /** Founding rate: unhappy, crowded or recently struck places make prophets; a crowded field of faiths makes fewer. */
  faithChance(b: number, dt: number, year: number): number {
    const S = this.e.st.S, o = b * NF, X = this.X;
    if (S[o + F.pop] < 1e6) return 0;
    const struck = year - X.H[b * NH + H.disaster] < 30 ? 2 : 1;
    return dt * 5e-4 * (0.4 + 2 * (1 - S[o + F.happiness])) * struck / (1 + X.hg[HG.living] / 20);
  }

  private schism(b: number, f: number, year: number, P: Float64Array): boolean {
    const X = this.X, n = X.hg[HG.nFaith];
    if (n >= MAX_FAITH) return false;
    // the axis where local life most disagrees with the faith
    let worst = -1, wv = 0.6;
    for (let a = 0; a < 5; a++) {
      const t = this.tenet(f, a), d = t === 0 ? Math.abs(P[a]) * 0.8 : -t * P[a];
      if (d > wv) { wv = d; worst = a; }
    }
    if (worst < 0) return false;
    const o = n * NFC, src = f * NFC;
    X.faith.fill(0, o, o + NFC);
    for (let a = 0; a < 5; a++) X.faith[o + FC.t + a] = X.faith[src + FC.t + a];
    const was = X.faith[o + FC.t + worst];
    X.faith[o + FC.t + worst] = P[worst] >= 0 ? 1 : -1;
    if (was === 0) {
      // keep three tenets: drop the one the place cares least about
      let drop = -1, dv = Infinity;
      for (let a = 0; a < 5; a++) if (a !== worst && X.faith[o + FC.t + a] !== 0 && X.faith[o + FC.t + a] * P[a] < dv) { dv = X.faith[o + FC.t + a] * P[a]; drop = a; }
      if (drop >= 0) X.faith[o + FC.t + drop] = 0;
    }
    X.faith[o + FC.home] = b; X.faith[o + FC.year] = year; X.faith[o + FC.parent] = f; X.faith[o + FC.alive] = 1; X.faith[o + FC.cause] = FAITH_CAUSE.SCHISM;
    X.hg[HG.nFaith] = n + 1;
    const sl = this.slots(b);
    const i = sl.findIndex((x) => x[0] === f);
    const half = sl[i][1] / 2;
    sl[i][1] -= half;
    sl.push([n, half]);
    this.setSlots(b, sl);
    // a split across a border is a grievance between the two governments
    const S = this.e.st.S, fb = S[b * NF + F.faction], fh = S[X.faith[src + FC.home] * NF + F.faction];
    if (fb !== fh) this.pol.addGrudge(fb, fh, 0.7);
    this.log(EV.Schism, b, n, f);
    return true;
  }

  /** Shares move with people, conversion grows with unhappiness, misfits fade, schisms split. */
  private stepFaiths(dt: number, year: number): void {
    const st = this.e.st, S = st.S, X = this.X, Hh = X.H;
    const recv = (this.e as unknown as { recv: Float64Array }).recv, sent = (this.e as unknown as { sent: Float64Array }).sent;
    // per system: what the senders believe, and the biggest faith around
    const sendMix = new Map<number, Map<number, number>>(), sendTot = new Map<number, number>();
    const sysMix = new Map<number, Map<number, number>>();
    const add = (m: Map<number, Map<number, number>>, s: number, f: number, v: number) => {
      let x = m.get(s); if (!x) m.set(s, (x = new Map()));
      x.set(f, (x.get(f) ?? 0) + v);
    };
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage]) || S[o + F.pop] <= 0) continue;
      const sy = this.bSys[b], pop = S[o + F.pop], snd = sent[b] > 0 ? sent[b] : 0;
      if (snd > 0) sendTot.set(sy, (sendTot.get(sy) ?? 0) + snd);
      for (let k = 0; k < 3; k++) {
        const f = Hh[b * NH + 2 * k];
        if (f < 0) continue;
        add(sysMix, sy, f, pop * Hh[b * NH + 2 * k + 1]);
        if (snd > 0) add(sendMix, sy, f, snd * Hh[b * NH + 2 * k + 1]);
      }
    }
    const top = new Map<number, number>();
    for (const [sy, m] of sysMix) { let bf = -1, bv = 0; for (const [f, v] of m) if (v > bv) { bv = v; bf = f; } top.set(sy, bf); }

    const worlds = this.worlds.fill(0), adher = this.adher.fill(0); // whole arrays: a restore can rewind nFaith
    const bioAdapt = this.has('bioAdapt'), upload = this.has('mindUpload');
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage]) || S[o + F.pop] <= 0) continue;
      const pop = S[o + F.pop], sy = this.bSys[b], happy = S[o + F.happiness];
      const P = this.pressure(b, year);
      // 1. migrants bring their faiths
      const tot = sendTot.get(sy) ?? 0;
      if (recv[b] > 0 && tot > 0) {
        const mix = [...(sendMix.get(sy) ?? new Map()).entries()].map(([f, v]) => [f, v / tot] as [number, number]);
        this.mixInto(b, mix, Math.min(1, (recv[b] * dt) / pop));
      }
      let sl = this.slots(b);
      // 2. faiths that do not fit local life fade
      for (const x of sl) x[1] *= Math.exp(-dt * 0.006 * (1 + 3 * Math.max(0, -this.fit(x[0], P))));
      // 3. conversion: unhappy people turn to the best-fitting faith they can hear preached
      const cands = sl.map((x) => x[0]);
      const t = top.get(sy) ?? -1;
      if (t >= 0 && !cands.includes(t)) cands.push(t);
      if (cands.length) {
        let best = -1, bv = -Infinity;
        for (const f of cands) { const v = this.fit(f, P) + 0.5 * (sl.find((x) => x[0] === f)?.[1] ?? 0); if (v > bv) { bv = v; best = f; } }
        const c = 1 - Math.exp(-dt * 0.04 * (1 - happy) * (1 - happy) * Math.max(0.2, 1 + this.fit(best, P)));
        let held = 0;
        for (const x of sl) held += x[1];
        let gain = c * (1 - held);
        for (const x of sl) if (x[0] !== best) { const m = x[1] * c * 0.5; x[1] -= m; gain += m; }
        const bx = sl.find((x) => x[0] === best);
        if (bx) bx[1] += gain; else sl.push([best, gain]);
      }
      this.setSlots(b, sl);
      sl = this.slots(b);
      // 4. schism: far from the faith's home, unhappy, and local life disagrees with a tenet
      for (const [f, s] of sl) {
        if (s < 0.3 || X.faith[f * NFC + FC.worlds] < 3) continue;
        const far = this.sysDistLy(b, X.faith[f * NFC + FC.home]);
        if (far < 4 && S[o + F.faction] === S[X.faith[f * NFC + FC.home] * NF + F.faction]) continue;
        if (this.e.rand() < dt * 1e-4 * (1 - happy) * (1 + Math.min(far, 40) / 10) && this.schism(b, f, year, P)) break;
      }
      // 5. what people believe nudges what they do
      let tb = 0, te = 0, tm = 0, tc = 0, tx = 0, top1 = -1, ts = 0;
      for (let k = 0; k < 3; k++) {
        const f = Hh[b * NH + 2 * k], s = Hh[b * NH + 2 * k + 1];
        if (f < 0) continue;
        if (s > ts) { ts = s; top1 = f; }
        if (s >= 0.05) worlds[f]++;
        adher[f] += s * pop;
        tb += s * this.tenet(f, 0); te += s * this.tenet(f, 1); tm += s * this.tenet(f, 2); tc += s * this.tenet(f, 3); tx += s * this.tenet(f, 4);
      }
      S[o + F.culture] = top1 + 1;
      const h = b * NH, rf = this.pol.fx(S[o + F.faction]);
      Hh[h + H.mGrowth] = (1 - 0.12 * tc) * (1 + 0.06 * tx);
      Hh[h + H.mLaunch] = Math.max(0.3, 1 + 0.6 * tx);
      Hh[h + H.mSecede] = Math.max(0.3, 1 + 0.6 * te) * rf.secede;
      Hh[h + H.mResearch] = (1 + 0.1 * tm) * rf.research;
      Hh[h + H.dGini] = rf.gini; Hh[h + H.mMil] = rf.mil;
      // 6. bodies and minds: adaptation and uploading spread where the technology exists and the faith allows
      if (bioAdapt) {
        const tgt = Math.max(0, Math.min(0.95, 0.1 + 0.6 * Math.min(1, Math.abs(1 - this.bG[b])) + 0.3 * tb + 0.2 * tc));
        Hh[h + H.adapt] += (tgt - Hh[h + H.adapt]) * Math.min(1, 0.01 * dt);
      }
      if (upload) {
        const tgt = Math.max(0, Math.min(0.9, 0.05 + 0.35 * tm + 0.25 * tb + (S[o + F.stage] >= STAGE.HUB ? 0.2 : 0)));
        Hh[h + H.upl] += (tgt - Hh[h + H.upl]) * Math.min(1, 0.006 * dt);
      }
      Hh[h + H.mDiv] = Math.max(0.2, 1 + 0.6 * tb + 0.3 * tc);
    }
    // 6. the faith table: spread milestones and extinctions
    let living = 0;
    for (let f = 0; f < X.hg[HG.nFaith]; f++) {
      const o = f * NFC;
      if (!X.faith[o + FC.alive]) continue;
      X.faith[o + FC.worlds] = worlds[f]; X.faith[o + FC.adherents] = adher[f];
      if (worlds[f] > X.faith[o + FC.peak]) X.faith[o + FC.peak] = worlds[f];
      const m = X.faith[o + FC.mile];
      if (m < MILESTONES.length && worlds[f] >= MILESTONES[m]) { X.faith[o + FC.mile] = m + 1; this.log(EV['Faith spreads'], X.faith[o + FC.home], f, MILESTONES[m]); }
      if (adher[f] <= 0) { X.faith[o + FC.alive] = 0; X.faith[o + FC.end] = year; this.log(EV['Faith extinct'], X.faith[o + FC.home], f, X.faith[o + FC.peak]); }
      else living++;
    }
    X.hg[HG.living] = living;
  }

  // ---------------------------------------------------------------- the step

  step(dt: number, year: number): void {
    this.stepFaiths(dt, year);
  }

  /** Main run: remember each settlement's faith slots at the end of period p. */
  record(p: number): void {
    const st = this.e.st, Hh = this.X.H;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n];
      if (!LIVING(st.S[b * NF + F.stage])) continue;
      let r = this.faithHist.get(b);
      if (!r) this.faithHist.set(b, (r = { f: new Int16Array(NPERIODS * 3).fill(-1), s: new Uint8Array(NPERIODS * 3), a: new Uint8Array(NPERIODS), u: new Uint8Array(NPERIODS) }));
      r.a[p] = Math.round(Hh[b * NH + H.adapt] * 255); r.u[p] = Math.round(Hh[b * NH + H.upl] * 255);
      for (let k = 0; k < 3; k++) { r.f[p * 3 + k] = Hh[b * NH + 2 * k]; r.s[p * 3 + k] = Math.round(Hh[b * NH + 2 * k + 1] * 255); }
    }
  }

  /** Shares of b's people adapted to their world and uploaded, at the end of period p (main run history). */
  bodiesAt(b: number, p: number): { adapted: number; uploaded: number } {
    const r = this.faithHist.get(b);
    if (!r || p < 0) return { adapted: 0, uploaded: 0 };
    p = Math.min(p, NPERIODS - 1);
    return { adapted: r.a[p] / 255, uploaded: r.u[p] / 255 };
  }

  /** Faith slots of b at the end of period p (main run history). */
  faithsAt(b: number, p: number): [number, number][] {
    const r = this.faithHist.get(b);
    const out: [number, number][] = [];
    if (!r || p < 0) return out;
    p = Math.min(p, NPERIODS - 1);
    for (let k = 0; k < 3; k++) if (r.f[p * 3 + k] >= 0) out.push([r.f[p * 3 + k], r.s[p * 3 + k] / 255]);
    return out;
  }
}
