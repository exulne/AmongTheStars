// A war mind run by networks: every polity is spoken for by one controller (a
// WarNet), chosen when it first appears. Rollouts give most polities the
// network being trained and the rest earlier generations; the browser gives
// each the generation for its year. Every draw is a hash of (seed, step, who,
// against whom, what), so the mind keeps no state of its own: a replay from any
// snapshot decides exactly as the first run did.

import type { Engine } from '../sim/engine.ts';
import { isAlive } from '../sim/catalog.ts';
import { F, NF } from '../sim/metrics.ts';
import { H, HG, NH, NPC, NWC, OUTCOME, PC, WC } from '../sim/civ.ts';
import { REGIME_FX } from '../sim/polity.ts';
import { hash01 } from '../sim/rng.ts';
import { POSTURES, TERMS, type PressCand, type StrikeCand, type TermsCand, type WarMind } from '../sim/warMind.ts';
import { DP, DS, H2, NPAIR, NPOST, PAIR_KIND, PAIR_SLICE, WarNet, sample } from './warNet.ts';

/** What a polity is this step, summed over its worlds. */
export interface PolityAgg {
  pop: number; gdp: number; mil: number; short: number; stab: number; gini: number;
  worlds: number; systems: number; lastWar: number; capital: number;
}

/** One sampled decision of a polity whose controller is learning. kind: 0 posture, 1 press, 2 strike, 3 terms. */
export interface Decision {
  step: number; f: number; kind: number;
  self: Float32Array; pair: Float32Array | null;
  action: number; logp: number; mask: number;   // mask: bit k set = terms option k allowed
}

export interface Recorder {
  /** start of a politics step, before anything is decided: every living polity's state and its war losses since last time */
  observe(step: number, year: number, aggs: Map<number, PolityAgg>, losses: Map<number, number>, active: Set<number>): void;
  decide(d: Decision): void;
}

export class NetMind implements WarMind {
  private seed: number;
  /** browser: the generation for a year; when set, it speaks for everyone */
  byYear: ((year: number) => number) | null = null;
  private ctrl = new Map<number, number>();
  private aggs = new Map<number, PolityAgg>();
  private active = new Set<number>();
  private wars = new Map<number, number>();
  private hCache = new Map<number, Float64Array>();
  private selfCache = new Map<number, Float32Array>();
  private logits = new Float64Array(Math.max(NPOST, NPAIR));
  private step = 0;

  /**
   * @param nets   the controllers
   * @param assign which controller a new polity gets (parent: its parent's controller, or -1)
   * @param learn  which controllers' decisions are recorded
   */
  private e: Engine;
  private nets: WarNet[];
  private assign: (f: number, parent: number, year: number) => number;
  private rec: Recorder | null;
  private learn: (c: number) => boolean;
  constructor(e: Engine, nets: WarNet[], assign: (f: number, parent: number, year: number) => number,
    seed: number, rec: Recorder | null = null, learn: (c: number) => boolean = () => false) {
    this.e = e; this.nets = nets; this.assign = assign; this.rec = rec; this.learn = learn;
    this.seed = seed;
  }

  private get pol() { return this.e.civ.pol; }
  private u(f: number, g: number, kind: number): number { return hash01(this.seed, this.step, f, g, kind); }
  controllerOf(f: number): number { return this.byYear ? this.byYear(this.e.year) : this.ctrl.get(f) ?? -1; }

  begin(year: number, _dt: number): void {
    const st = this.e.st, S = st.S, X = st.hx, Hh = X.H, bSys = this.e.civ.bSys;
    this.step = st.step;
    this.hCache.clear(); this.selfCache.clear();
    // every living polity, summed
    const aggs = this.aggs; aggs.clear();
    const sysSets = new Map<number, Set<number>>();
    const firstFac = new Map<number, number>(), contested = new Set<number>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!isAlive(S[o + F.stage])) continue;
      const f = S[o + F.faction];
      let a = aggs.get(f);
      if (!a) { aggs.set(f, (a = { pop: 0, gdp: 0, mil: 0, short: 0, stab: 0, gini: 0, worlds: 0, systems: 0, lastWar: -1e9, capital: 0 })); sysSets.set(f, new Set()); }
      const pop = S[o + F.pop];
      a.pop += pop; a.gdp += S[o + F.gdp]; a.mil += S[o + F.military]; a.capital += S[o + F.capital];
      a.short += S[o + F.shortage] * pop; a.stab += S[o + F.stability] * pop; a.gini += S[o + F.gini] * pop;
      a.worlds++; a.lastWar = Math.max(a.lastWar, Hh[b * NH + H.lastWar]);
      const sy = bSys[b];
      sysSets.get(f)!.add(sy);
      const ff = firstFac.get(sy);
      if (ff === undefined) firstFac.set(sy, f); else if (ff !== f) contested.add(sy);
    }
    for (const [f, a] of aggs) {
      a.systems = sysSets.get(f)!.size;
      if (a.pop > 0) { a.short /= a.pop; a.stab /= a.pop; a.gini /= a.pop; }
    }
    // who has anything to decide: a contested system, a grudge across the stars, or a war on
    const act = this.active; act.clear();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n];
      if (contested.has(bSys[b]) && isAlive(S[b * NF + F.stage])) act.add(S[b * NF + F.faction]);
    }
    if (this.e.fx.shipSpeed >= 0.05) {
      const G = X.grudge;
      for (let i = 0; i < X.hg[HG.nGrudge]; i++) if (G[i * 3 + 2] >= 0.4) { act.add(G[i * 3]); act.add(G[i * 3 + 1]); }
    }
    this.wars.clear();
    const W = X.war;
    for (let w = 0; w < X.hg[HG.nWar]; w++) {
      const o = w * NWC;
      if (W[o + WC.outcome] !== OUTCOME.ONGOING) continue;
      for (const f of [W[o + WC.a], W[o + WC.b]]) { this.wars.set(f, (this.wars.get(f) ?? 0) + 1); act.add(f); }
    }
    for (const f of act) if (!aggs.has(f) || S[f * NF + F.faction] !== f) act.delete(f);
    // controllers for polities new since last step
    if (!this.byYear) for (const f of aggs.keys()) {
      if (this.ctrl.has(f) || S[f * NF + F.faction] !== f) continue;
      const parent = Hh[f * NH + H.indepFrom];
      this.ctrl.set(f, this.assign(f, parent >= 0 ? this.controllerOf(parent) : -1, year));
    }
    this.rec?.observe(this.step, year, aggs, this.pol.losses, act);
    this.pol.losses.clear();
    // postures: the active choose, the rest stand down
    for (const f of aggs.keys()) if (!act.has(f) && S[f * NF + F.faction] === f) Hh[f * NH + H.posture] = 0;
    for (const f of act) {
      const c = this.controllerOf(f), h = this.h(f);
      this.nets[c].posture(h, this.logits);
      const [k, lp] = sample(this.logits, 0, NPOST, this.u(f, -1, 0));
      Hh[f * NH + H.posture] = POSTURES[k];
      this.record(f, 0, null, k, lp, 0);
    }
  }

  press(cands: PressCand[], year: number): number[] {
    const pair = new Float32Array(DP);
    return cands.map((c) => {
      let first = -1;
      for (const [f, g] of [[c.a, c.b], [c.b, c.a]]) {
        this.pairObs(f, g, PAIR_KIND.PRESS, pair, year, c);
        const k = this.decide(f, g, 1, pair, PAIR_SLICE[0]);
        if (k === 1 && first < 0) first = f;
      }
      return first;
    });
  }

  strike(cands: StrikeCand[], year: number): number[] {
    const pair = new Float32Array(DP);
    return cands.map((c) => {
      let who = -1;
      for (const [f, g] of [[c.a, c.b], [c.b, c.a]]) {
        if (!this.active.has(f)) continue;
        this.pairObs(f, g, PAIR_KIND.STRIKE, pair, year);
        const k = this.decide(f, g, 2, pair, PAIR_SLICE[1]);
        if (k === 1 && who < 0) who = f;
      }
      return who;
    });
  }

  terms(c: TermsCand, year: number): number {
    if (this.controllerOf(c.winner) < 0 || !this.aggs.has(c.winner)) return TERMS.PEACE;
    const pair = new Float32Array(DP);
    this.pairObs(c.winner, c.loser, PAIR_KIND.TERMS, pair, year, undefined, c);
    let mask = 0;
    for (let k = 0; k < 4; k++) if (c.can[k]) mask |= 1 << k;
    return this.decide(c.winner, c.loser, 3, pair, PAIR_SLICE[2], c.can, mask);
  }

  // ---------------------------------------------------------------- inference

  private decide(f: number, g: number, kind: number, pair: Float32Array, [lo, hi]: [number, number], can?: boolean[], mask = 0): number {
    const c = this.controllerOf(f);
    if (c < 0) return 0;
    this.nets[c].pair(this.h(f), pair, this.logits);
    const [k, lp] = sample(this.logits, lo, hi, this.u(f, g, kind), can);
    this.record(f, kind, pair, k, lp, mask);
    return k;
  }

  private record(f: number, kind: number, pair: Float32Array | null, action: number, logp: number, mask: number): void {
    if (!this.rec || !this.learn(this.controllerOf(f))) return;
    this.rec.decide({ step: this.step, f, kind, self: this.selfObs(f), pair: pair ? pair.slice() : null, action, logp, mask });
  }

  private h(f: number): Float64Array {
    let h = this.hCache.get(f);
    if (!h) { h = new Float64Array(H2); this.nets[this.controllerOf(f)].trunk(this.selfObs(f), h); this.hCache.set(f, h); }
    return h;
  }

  // ---------------------------------------------------------------- what a polity sees

  selfObs(f: number): Float32Array {
    let x = this.selfCache.get(f);
    if (x) return x;
    x = new Float32Array(DS);
    const e = this.e, a = this.aggs.get(f)!, X = e.st.hx, year = e.year;
    const p = this.pol.polityOf(f), regime = p >= 0 ? X.pol[p * NPC + PC.regime] : 0;
    x[0] = Math.log10(a.pop + 1) / 10; x[1] = Math.log10(a.gdp + 1) / 13; x[2] = Math.log10(a.mil + 1) / 12;
    x[3] = a.short; x[4] = a.stab; x[5] = a.gini;
    x[6] = Math.log2(a.worlds + 1) / 8; x[7] = Math.log2(a.systems + 1) / 6;
    x[8] = Math.exp(-(year - a.lastWar) / 50);
    x[9] = X.H[f * NH + H.posture] / 2.5;
    x[10] = f === e.world.earth ? 1 : 0;
    x[11 + Math.max(0, regime)] = 1;
    x[19 + e.st.g[1]] = 1; // era
    x[27] = Math.min(0.5, e.fx.shipSpeed) * 2; x[28] = e.fx.ftl > 0 ? 1 : 0;
    let techs = 0; for (const d of e.st.techDone) if (d >= 0) techs++;
    x[29] = techs / 69; x[30] = year / 10000;
    x[31] = Math.min(3, this.wars.get(f) ?? 0) / 3;
    this.selfCache.set(f, x);
    return x;
  }

  private pairObs(f: number, g: number, kind: number, x: Float32Array, _year: number, pc?: PressCand, tc?: TermsCand): void {
    x.fill(0);
    const A = this.aggs.get(f), B = this.aggs.get(g), Hh = this.e.st.hx.H, pol = this.pol;
    const lr = (u: number, v: number) => Math.max(-3, Math.min(3, Math.log10((u + 1) / (v + 1)))) / 3;
    if (A && B) { x[0] = lr(A.mil, B.mil); x[1] = lr(A.pop, B.pop); x[2] = lr(A.gdp, B.gdp); x[12] = Math.log2(B.systems + 1) / 6; x[13] = Math.log2(A.systems + 1) / 6; }
    x[3] = Math.min(2, this.e.civ.sysDistLy(f, g) / 60);
    x[4] = Math.min(3, pol.grudge(f, g)) / 3;
    if (pc) { x[5] = Math.min(3, pc.res) / 3; x[6] = Math.min(2, pc.faith) / 2; x[7] = pc.indep / 1.5; }
    x[8] = Hh[f * NH + H.indepFrom] === g ? 1 : 0;
    x[9] = Hh[g * NH + H.indepFrom] === f ? 1 : 0;
    x[10] = REGIME_FX[Math.max(0, this.regimeOf(g))].war / 2;
    x[11] = Hh[g * NH + H.posture] / 2.5;
    x[14] = kind / 2;
    x[15] = Math.min(0.5, this.e.fx.shipSpeed) * 2;
    if (tc) {
      x[16] = Math.min(2, Math.log10(tc.ratio)) / 2;
      x[17] = tc.can[1] ? 1 : 0; x[18] = tc.can[2] ? 1 : 0; x[19] = tc.can[3] ? 1 : 0;
      x[20] = this.e.st.hx.war[tc.war * NWC + WC.rounds] / 3;
    }
    x[21] = Math.min(3, this.wars.get(g) ?? 0) / 3;
  }

  private regimeOf(f: number): number {
    const p = this.pol.polityOf(f);
    return p >= 0 ? this.e.st.hx.pol[p * NPC + PC.regime] : 0;
  }
}

