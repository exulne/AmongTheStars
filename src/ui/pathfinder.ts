// A small pool of futures-hunters: each worker plays one seed until the goal
// is reached or the future ends. Seeds are the same family the ensemble uses,
// so "future N" here is the same universe as everywhere else.

import PathWorker from '../sim/pathWorker.ts?worker&inline';
import type { FromPaths, ToPaths } from '../sim/pathWorker.ts';
import type { Chain, FutureResult } from '../sim/milestones.ts';

export class Pathfinder {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private token = 0;
  private goal: Chain | null = null;
  private next: () => number = () => 0;
  private want = 0;
  private limit = 0;
  private found = 0;
  private running = 0;
  private results: FutureResult[] = [];
  private doneSent = false;
  private onResult: (r: FutureResult) => void = () => {};
  private onDone: (results: FutureResult[], t: { found: number; simulated: number; capped: boolean }) => void = () => {};

  /**
   * Simulate futures until `want` reach the chain's goal (then cancel the rest),
   * or until `limit` futures have run. Seeds are drawn lazily from the lineage.
   * `onResult` fires for every verdict; `onDone` fires once with all results —
   * reached futures first by year, then the misses. A new run() cancels the old.
   */
  run(chain: Chain, next: () => number, want: number, limit: number, onResult: (r: FutureResult) => void, onDone: (results: FutureResult[], t: { found: number; simulated: number; capped: boolean }) => void): void {
    const t = ++this.token;
    this.goal = chain;
    this.onResult = onResult;
    this.onDone = onDone;
    this.results = [];
    this.doneSent = false;
    this.running = 0;
    this.found = 0;
    this.want = want;
    this.limit = limit;
    this.next = next;
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
    while (this.idle.length && this.found < this.want && this.results.length + this.running < this.limit) {
      const w = this.idle.pop()!;
      this.running++;
      w.postMessage({ type: 'find', chain: this.goal, seed: this.next(), token: this.token } satisfies ToPaths);
    }
    if (this.running === 0 && (this.found >= this.want || this.results.length >= this.limit)) this.finish();
  }

  private got(w: Worker, m: FromPaths): void {
    if (m.token !== this.token || this.doneSent) return; // a late answer to a search already over
    this.running--;
    if (!this.idle.includes(w)) this.idle.push(w);
    this.results.push(m.result);
    if (m.result.reached) this.found++;
    this.onResult(m.result);
    if (this.found >= this.want) { this.finish(); return; }
    this.pump();
  }

  private finish(): void {
    if (this.doneSent) return;
    this.doneSent = true;
    for (const w of this.workers) w.postMessage({ type: 'cancel', token: this.token } satisfies ToPaths);
    this.idle = [...this.workers];
    this.running = 0;
    const rs = [...this.results].sort((a, b) => (b.reached ? 1 : 0) - (a.reached ? 1 : 0) || (a.year ?? 1e9) - (b.year ?? 1e9));
    this.onDone(rs, { found: this.found, simulated: rs.length, capped: this.found < this.want });
  }

  stop(): void {
    this.token++;
    this.doneSent = true;
    for (const w of this.workers) w.postMessage({ type: 'cancel', token: this.token } satisfies ToPaths);
    this.idle = [...this.workers];
    this.running = 0;
  }
}
