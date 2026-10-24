// Politics with memory: independence, wars with causes and outcomes, grudges
// that outlast them, and effects that travel no faster than light (or the
// ships that carry them). All state is in st.hx (civ.ts).

import { EV, STAGE } from './catalog.ts';
import { F, NF } from './metrics.ts';
import {
  H, HG, MAX_GRUDGE, MAX_PEND, MAX_WAR, NH, NWC, OUTCOME, PEND, WAR_CAUSE, WAR_KIND, WC, FC, NFC,
  type Civ,
} from './civ.ts';

const LIVING = (s: number) => s >= STAGE.OUTPOST && s <= STAGE.MEGA;
const C = 299_792_458;          // m/s
const MT = 4.184e15;            // J per megaton of TNT
/** Kinetic energy of m kg at beta = v/c: (γ−1)mc², which is ½mv²·γ-ish at these speeds. */
export function kineticJ(kg: number, beta: number): number { return (1 / Math.sqrt(1 - beta * beta) - 1) * kg * C * C; }
export const megatons = (J: number) => J / MT;

interface Agg { f: number; pop: number; mil: number; short: number; res: number; faith: Map<number, number>; bodies: number[] }

export class Politics {
  private c: Civ;
  constructor(c: Civ) { this.c = c; }
  private get e() { return this.c.e; }
  private get X() { return this.c.X; }

  step(dt: number, year: number, eraWar: number): { rivals: number; wars: number; dead: number } {
    this.independence(dt, year);
    const out = this.localWars(dt, year, eraWar);
    out.wars += this.kineticWars(dt, year, eraWar);
    out.dead += this.effects(year);
    this.resolve(year);
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
  private atWar(a: number, b: number): boolean {
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
  private reach(f: number, at: number): { mil: number; systems: number; pop: number } {
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

  // ---------------------------------------------------------------- independence

  private independence(dt: number, year: number): void {
    const st = this.e.st, S = st.S, fx = this.e.fx, Hh = this.X.H;
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF, stg = S[o + F.stage];
      if (stg < STAGE.COLONY || stg > STAGE.MEGA || S[o + F.faction] === b) continue;
      const lag = this.lagToCapital(b);
      const sol = this.c.bSys[b] === 0;
      const p = dt * fx.secession * this.c.mul(b, H.mSecede) * (1 - S[o + F.stability]) * (sol ? (S[o + F.pop] > 1e6 ? 0.008 : 0) : 0.012 * Math.sqrt(lag / 5));
      if (this.e.rand() < p) {
        const old = S[o + F.faction];
        // the colony and everything it founded leave together
        for (let m = 0; m < st.nSettled; m++) {
          const c = st.settled[m];
          if (c === b || (S[c * NF + F.faction] === old && this.isDescendant(c, b))) S[c * NF + F.faction] = b;
        }
        Hh[b * NH + H.indep] = year; Hh[b * NH + H.indepFrom] = old;
        this.addGrudge(b, old, 0.6);
        this.c.log(EV.Independence, b, old);
      }
    }
  }

  // ---------------------------------------------------------------- wars inside a star system

  private localWars(dt: number, year: number, eraWar: number): { rivals: number; wars: number; dead: number } {
    const st = this.e.st, S = st.S, fx = this.e.fx, Hh = this.X.H;
    const bySys = new Map<number, Map<number, Agg>>();
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], o = b * NF;
      if (!LIVING(S[o + F.stage])) continue;
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
    const pairs: { sy: number; A: Agg; B: Agg; w: number; cause: number }[] = [];
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
        pairs.push({ sy, A, B, w, cause });
        W += w;
      }
    }
    const out = { rivals, wars: 0, dead: 0 };
    if (!pairs.length) return out;
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

  private startLocal(year: number, sy: number, A0: Agg, B0: Agg, cause: number): number {
    const X = this.X, st = this.e.st, S = st.S, Hh = X.H;
    const n = X.hg[HG.nWar];
    if (n >= MAX_WAR) return 0;
    // who strikes first: the hungry side in a resource war, the old master against a rebel, else the stronger
    let A = A0, B = B0;
    const sh = (a: Agg) => (a.pop > 0 ? a.short / a.pop : 0);
    if (cause === WAR_CAUSE.RESOURCES ? sh(B) > sh(A) : cause === WAR_CAUSE.INDEPENDENCE ? Hh[A.f * NH + H.indepFrom] === B.f : B.mil > A.mil) { A = B0; B = A0; }
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
    Wt[o + WC.indep] = Hh[A.f * NH + H.indepFrom] === B.f ? Hh[A.f * NH + H.indep] : Hh[B.f * NH + H.indepFrom] === A.f ? Hh[B.f * NH + H.indep] : -1;
    X.hg[HG.nWar] = n + 1;
    // fighting happens where both sides are: the theatre system, within light-seconds
    let killed = 0, dead = 0;
    const lossA = Math.min(1.7, Math.max(0.3, 2 / (1 + R))), lossB = Math.min(1.7, Math.max(0.3, (2 * R) / (1 + R)));
    for (const [side, loss] of [[A, lossA], [B, lossB]] as const) {
      for (const c of side.bodies) {
        const oc = c * NF;
        const k = Math.min(0.6, sev * (0.5 + this.e.rand()) * loss);
        killed += S[oc + F.pop] * k;
        S[oc + F.pop] *= 1 - k; S[oc + F.capital] *= 1 - k; S[oc + F.stability] = Math.max(0, S[oc + F.stability] - 0.15);
        Hh[c * NH + H.lastWar] = year;
        if (S[oc + F.stage] <= STAGE.BASE && this.e.rand() < sev) { S[oc + F.stage] = STAGE.DEAD; S[oc + F.pop] = 0; dead++; }
      }
    }
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

  // ---------------------------------------------------------------- relativistic kinetic war between stars

  private kineticWars(dt: number, year: number, eraWar: number): number {
    const fx = this.e.fx, X = this.X, S = this.e.st.S, G = X.grudge;
    const beta = Math.min(0.5, fx.shipSpeed);
    if (beta < 0.05) return 0;
    let wars = 0;
    for (let i = 0; i < X.hg[HG.nGrudge]; i++) {
      const v = G[i * 3 + 2];
      if (v < 0.4) continue;
      let a = G[i * 3], b = G[i * 3 + 1];
      if (!LIVING(S[a * NF + F.stage]) || !LIVING(S[b * NF + F.stage]) || S[a * NF + F.faction] !== a || S[b * NF + F.faction] !== b) continue;
      if (this.c.bSys[a] === this.c.bSys[b]) continue;
      const d = this.c.sysDistLy(a, b);
      if (d > 60 || this.atWar(a, b)) continue;
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

  private resolve(year: number): void {
    const X = this.X, Wt = X.war, st = this.e.st, S = st.S;
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
        if (ratio > 3 && lBodies.length && lPop < 0.3 * wPop) {
          // annexation: the small settlements of the loser in this system change flags
          outcome = OUTCOME.ANNEX;
          const whole = this.c.bSys[loser] === sy && lTot < 0.3 * wPop;
          for (let n = 0; n < st.nSettled; n++) {
            const c = st.settled[n], oc = c * NF;
            if (S[oc + F.faction] !== loser) continue;
            if (whole || (this.c.bSys[c] === sy && c !== loser)) S[oc + F.faction] = winner;
          }
          this.addGrudge(a, b, 1);
        } else if (ratio > 1.5 && lCap > 0 && wBodies.length) {
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
  }
}

export { FC, NFC };
