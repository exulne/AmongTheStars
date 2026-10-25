// A small pool of futures-hunters: each worker plays one seed until the goal
// is reached or the future ends. Seeds are the same family the ensemble uses,
// so "future N" here is the same universe as everywhere else.

import PathWorker from '../sim/pathWorker.ts?worker&inline';
import type { FromPaths, ToPaths } from '../sim/pathWorker.ts';
import type { FutureResult, Goal } from '../sim/milestones.ts';

export const PATHS_MAX_SEEDS = 16;
export const PATHS_WANT = 6;

export class Pathfinder {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private token = 0;
  private goal: Goal | null = null;
  private seeds: number[] = [];
  private nextSeed = 0;
  private running = 0;
  private results: FutureResult[] = [];
  private doneSent = false;
  private onResult: (r: FutureResult) => void = () => {};
  private onDone: (results: FutureResult[], tried: number) => void = () => {};

  /**
   * Play up to PATHS_MAX_SEEDS seeds, stopping once PATHS_WANT reach the goal.
   * `onResult` fires for every finished run (reached or not); `onDone` fires
   * once at the end with all results and how many seeds ran. A new find()
   * cancels whatever was still going.
   */
  find(goal: Goal, firstSeed: number, onResult: (r: FutureResult) => void, onDone: (results: FutureResult[], tried: number) => void): void {
    const t = ++this.token;
    this.goal = goal;
    this.onResult = onResult;
    this.onDone = onDone;
    this.results = [];
    this.doneSent = false;
    this.running = 0;
    this.seeds = [firstSeed];
    for (let k = 1; this.seeds.length < PATHS_MAX_SEEDS; k++) {
      const s = ((firstSeed + k * 7919) % 99991) + 1;
      if (s !== firstSeed) this.seeds.push(s);
    }
    this.nextSeed = 0;
    // any job still running is the old search's: cancel it and take the worker back
    for (const w of this.workers) w.postMessage({ type: 'cancel', token: t } satisfies ToPaths);
    const nWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    while (this.workers.length < nWorkers) {
      const w = new PathWorker();
      w.onmessage = (ev: MessageEvent<FromPaths>) => this.got(w, ev.data);
      this.workers.push(w);
    }
    this.idle = [...this.workers];
    this.pump();
  }

  private pump(): void {
    if (this.doneSent || !this.goal) return;
    if (this.results.filter((r) => r.reached).length >= PATHS_WANT) return this.finish();
    while (this.idle.length && this.nextSeed < this.seeds.length) {
      const w = this.idle.pop()!;
      const seed = this.seeds[this.nextSeed++];
      this.running++;
      w.postMessage({ type: 'find', goal: this.goal, seed, token: this.token } satisfies ToPaths);
    }
    if (this.nextSeed >= this.seeds.length && this.running === 0) this.finish();
  }

  private got(w: Worker, m: FromPaths): void {
    if (m.token !== this.token || this.doneSent) return; // a late answer to a search already over
    this.running--;
    if (!this.idle.includes(w)) this.idle.push(w);
    this.results.push(m.result);
    this.onResult(m.result);
    this.pump();
  }

  private finish(): void {
    if (this.doneSent) return;
    this.doneSent = true;
    for (const w of this.workers) w.postMessage({ type: 'cancel', token: this.token } satisfies ToPaths);
    this.idle = [...this.workers];
    this.running = 0;
    const rs = [...this.results].sort((a, b) => (b.reached ? 1 : 0) - (a.reached ? 1 : 0) || (a.year ?? 1e9) - (b.year ?? 1e9));
    this.onDone(rs, rs.length);
  }

  stop(): void {
    this.token++;
    this.doneSent = true;
    for (const w of this.workers) w.postMessage({ type: 'cancel', token: this.token } satisfies ToPaths);
    this.idle = [...this.workers];
    this.running = 0;
  }
}
