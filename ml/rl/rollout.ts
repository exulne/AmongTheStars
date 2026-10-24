// Rollout server for war-mind training. ml/rl/ppo.py starts it and sends one
// JSON line per iteration on stdin; it runs whole futures on every core and
// answers with one JSON line (stats) after writing the batch file.
//
//   {"seeds":[...], "learner":"ckpt/x.bin", "league":["ckpt/a.bin",...], "leagueShare":0.3, "out":"/dev/shm/b.bin", "record":true}
//
// Batch file (little-endian): Int32 [nAgent, nDec, DS, DP], then
//   agent steps: self f32[nAgent·DS], reward f32, next i32 (-1: trajectory ends), postAction u8, pad to 4, postLogp f32
//   pair decisions: agent i32, kind u8 (1 press, 2 strike, 3 terms), action u8, mask u8, pad, logp f32, pair f32[nDec·DP]

import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Engine } from '../../src/sim/engine.ts';
import { buildWorld } from '../../src/sim/world.ts';
import { HG, NWC, OUTCOME, WAR_KIND, WC } from '../../src/sim/civ.ts';
import { F, NF } from '../../src/sim/metrics.ts';
import { NetMind, type Decision, type PolityAgg, type Recorder } from '../../src/ml/netMind.ts';
import { DP, DS, WarNet } from '../../src/ml/warNet.ts';
import { seedRng, next } from '../../src/sim/rng.ts';

/** Realpolitik: prosper, hold ground, survive; casualties hurt but don't rule. */
export const DOCTRINE = { grow: 1, land: 0.5, alive: 0.01, death: -2, blood: 0.5 };

interface Open { agent: number; lgdp: number; lworlds: number; pop: number; acc: number }

/** Turns the mind's decisions into agent steps with rewards (doctrine above). */
class Batch implements Recorder {
  self: number[] = []; reward: number[] = []; nxt: number[] = []; pAct: number[] = []; pLogp: number[] = [];
  dAgent: number[] = []; dKind: number[] = []; dAct: number[] = []; dMask: number[] = []; dLogp: number[] = []; dPair: number[] = [];
  private open = new Map<number, Open>();
  private cur = new Map<number, number>();   // f → agent step opened this politics step
  private e: Engine;
  constructor(e: Engine) { this.e = e; }

  private close(f: number, o: Open, a: PolityAgg | undefined, end: boolean, dead: boolean): void {
    let r = o.acc;
    if (dead) r += DOCTRINE.death;
    else if (a) r += DOCTRINE.grow * (Math.log(a.gdp + 1) - o.lgdp) + DOCTRINE.land * (Math.log(a.worlds + 1) - o.lworlds) + DOCTRINE.alive;
    this.reward[o.agent] = r;
    if (end || dead) { this.nxt[o.agent] = -1; this.open.delete(f); }
  }

  observe(_step: number, _year: number, aggs: Map<number, PolityAgg>, losses: Map<number, number>, active: Set<number>): void {
    const S = this.e.st.S;
    this.cur.clear();
    for (const [f, o] of this.open) {
      o.acc -= DOCTRINE.blood * (losses.get(f) ?? 0) / Math.max(o.pop, 1);
      const a = aggs.get(f);
      if (!a || S[f * NF + F.faction] !== f) this.close(f, o, undefined, true, true);
      else if (active.has(f)) this.close(f, o, a, false, false);   // the next decision continues it
    }
    this.aggs = aggs;
  }
  private aggs = new Map<number, PolityAgg>();

  decide(d: Decision): void {
    if (d.kind === 0) {
      const i = this.reward.length, a = this.aggs.get(d.f)!;
      const prev = this.open.get(d.f);
      if (prev) this.nxt[prev.agent] = i;
      for (let k = 0; k < DS; k++) this.self.push(d.self[k]);
      this.reward.push(0); this.nxt.push(-1); this.pAct.push(d.action); this.pLogp.push(d.logp);
      this.open.set(d.f, { agent: i, lgdp: Math.log(a.gdp + 1), lworlds: Math.log(a.worlds + 1), pop: a.pop, acc: 0 });
      this.cur.set(d.f, i);
      return;
    }
    const i = this.cur.get(d.f) ?? this.open.get(d.f)?.agent;
    if (i === undefined) return;
    this.dAgent.push(i); this.dKind.push(d.kind); this.dAct.push(d.action); this.dMask.push(d.mask); this.dLogp.push(d.logp);
    for (let k = 0; k < DP; k++) this.dPair.push(d.pair![k]);
  }

  finish(): void {
    const S = this.e.st.S, aggs = new Map<number, PolityAgg>();
    // final state, summed the way the mind does it (only gdp and worlds matter here)
    for (let n = 0; n < this.e.st.nSettled; n++) {
      const b = this.e.st.settled[n], f = S[b * NF + F.faction];
      let a = aggs.get(f);
      if (!a) aggs.set(f, (a = { pop: 0, gdp: 0, mil: 0, short: 0, stab: 0, gini: 0, worlds: 0, systems: 0, lastWar: 0, capital: 0 }));
      if (S[b * NF + F.stage] < 0) continue;
      a.gdp += S[b * NF + F.gdp]; a.worlds++; a.pop += S[b * NF + F.pop];
    }
    for (const [f, o] of [...this.open]) this.close(f, o, aggs.get(f), true, false);
  }
}

/** The way of war in one future: what the player would see. */
function wayOfWar(e: Engine) {
  const X = e.st.hx, W = X.war, n = X.hg[HG.nWar];
  let kinetic = 0, killed = 0, dur = 0, annex = 0, rep = 0, peace = 0, rounds = 0;
  const byK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let w = 0; w < n; w++) {
    const o = w * NWC;
    if (W[o + WC.kind] === WAR_KIND.KINETIC) kinetic++;
    killed += W[o + WC.killed]; dur += W[o + WC.end] - W[o + WC.start]; rounds += W[o + WC.rounds];
    const out = W[o + WC.outcome];
    if (out === OUTCOME.ANNEX) annex++; else if (out === OUTCOME.REPARATIONS) rep++; else if (out === OUTCOME.PEACE) peace++;
    byK[Math.min(9, Math.floor(W[o + WC.start] / 1000))]++;
  }
  return { wars: n, kinetic, killed, meanDur: n ? dur / n : 0, annex, rep, peace, rounds, byK };
}

if (!isMainThread) {
  const world = buildWorld();
  parentPort!.on('message', (m: { seeds: number[]; nets: Float32Array[]; leagueShare: number; record: boolean }) => {
    const nets = m.nets.map((p) => new WarNet(p));
    for (const seed of m.seeds) {
      const e = new Engine(world, seed);
      e.logEvents = false;
      const batch = m.record ? new Batch(e) : null;
      const r = seedRng(seed ^ 0xa55);
      const assign = (_f: number, parent: number): number => {
        if (parent >= 0 && next(r) < 0.75) return parent;
        return nets.length > 1 && next(r) < m.leagueShare ? 1 + Math.floor(next(r) * (nets.length - 1)) : 0;
      };
      e.civ.pol.mind = new NetMind(e, nets, assign, seed, batch, (c) => c === 0);
      while (!e.done) e.step();
      batch?.finish();
      const pop = e.series[(e.years.length - 1) * (e.series.length / e.years.length)];
      const stats = { seed, pop, ...wayOfWar(e) };
      if (!batch) { parentPort!.postMessage({ stats }); continue; }
      const B = batch;
      const out = {
        stats,
        self: Float32Array.from(B.self), reward: Float32Array.from(B.reward), nxt: Int32Array.from(B.nxt),
        pAct: Uint8Array.from(B.pAct), pLogp: Float32Array.from(B.pLogp),
        dAgent: Int32Array.from(B.dAgent), dKind: Uint8Array.from(B.dKind), dAct: Uint8Array.from(B.dAct), dMask: Uint8Array.from(B.dMask),
        dLogp: Float32Array.from(B.dLogp), dPair: Float32Array.from(B.dPair),
      };
      parentPort!.postMessage(out, [out.self.buffer, out.reward.buffer, out.nxt.buffer, out.pAct.buffer, out.pLogp.buffer, out.dAgent.buffer, out.dKind.buffer, out.dAct.buffer, out.dMask.buffer, out.dLogp.buffer, out.dPair.buffer]);
    }
    parentPort!.postMessage({ idle: true });
  });
} else {
  const threads = Number(process.env.ROLLOUT_THREADS) || Math.max(1, availableParallelism() - 2);
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
  const load = (p: string) => { const b = readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const pad4 = (n: number) => (4 - (n % 4)) % 4;

  async function rollout(cmd: { seeds: number[]; learner: string; league: string[]; leagueShare: number; out?: string; record?: boolean }) {
    const t0 = performance.now();
    const nets = [cmd.learner, ...cmd.league].map(load);
    const record = cmd.record !== false;
    const parts: any[] = [], stats: any[] = [];
    await Promise.all(workers.map((wk, w) => new Promise<void>((res, rej) => {
      const seeds = cmd.seeds.filter((_, i) => i % threads === w);
      if (!seeds.length) return res();
      const onMsg = (m: any) => {
        if (m.idle) { wk.off('message', onMsg); wk.off('error', rej); return res(); }
        stats.push(m.stats);
        if (m.self) parts.push(m);
      };
      wk.on('message', onMsg); wk.on('error', rej);
      wk.postMessage({ seeds, nets, leagueShare: cmd.leagueShare ?? 0.3, record });
    })));
    let nA = 0, nD = 0;
    for (const p of parts) { nA += p.reward.length; nD += p.dAgent.length; }
    if (record && cmd.out) {
      // agent indices are per future; shift them into one batch
      const self = new Float32Array(nA * DS), reward = new Float32Array(nA), nxt = new Int32Array(nA), pAct = new Uint8Array(nA + pad4(nA)), pLogp = new Float32Array(nA);
      const dAgent = new Int32Array(nD), dKind = new Uint8Array(nD), dAct = new Uint8Array(nD), dMask = new Uint8Array(nD + pad4(3 * nD)), dLogp = new Float32Array(nD), dPair = new Float32Array(nD * DP);
      let a = 0, d = 0;
      for (const p of parts) {
        const na = p.reward.length, nd = p.dAgent.length;
        self.set(p.self, a * DS); reward.set(p.reward, a); pAct.set(p.pAct, a); pLogp.set(p.pLogp, a);
        for (let i = 0; i < na; i++) nxt[a + i] = p.nxt[i] < 0 ? -1 : p.nxt[i] + a;
        for (let i = 0; i < nd; i++) dAgent[d + i] = p.dAgent[i] + a;
        dKind.set(p.dKind, d); dAct.set(p.dAct, d); dMask.set(p.dMask, d); dLogp.set(p.dLogp, d); dPair.set(p.dPair, d * DP);
        a += na; d += nd;
      }
      const head = new Int32Array([nA, nD, DS, DP]);
      const u8 = (x: ArrayBufferView) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      // dKind, dAct, dMask are written back to back, then padding to 4
      const dBytes = new Uint8Array(3 * nD + pad4(3 * nD));
      dBytes.set(dKind, 0); dBytes.set(dAct, nD); dBytes.set(dMask.subarray(0, nD), 2 * nD);
      writeFileSync(cmd.out, Buffer.concat([u8(head), u8(self), u8(reward), u8(nxt), u8(pAct), u8(pLogp), u8(dAgent), dBytes, u8(dLogp), u8(dPair)].map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
    }
    stats.sort((x, y) => x.seed - y.seed);
    return { ms: performance.now() - t0, agents: nA, decisions: nD, stats };
  }

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const res = await rollout(JSON.parse(line));
    process.stdout.write(JSON.stringify(res) + '\n');
  }
  for (const w of workers) await w.terminate();
}
