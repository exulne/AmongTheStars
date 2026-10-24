// Main-thread handle on the simulation worker.

import SimWorker from './worker.ts?worker&inline';
import type { FromWorker, ToWorker } from './worker.ts';
import { NGM } from './metrics.ts';
import type { DataReq, DataRes } from './dataApi.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Msg<T extends FromWorker['type']> = Extract<FromWorker, { type: T }>;
export type StateMsg = Msg<'state'>;
export type HistoryMsg = Msg<'history'>;
export type SimEvent = Msg<'events'>['events'][number];
export type TableMsg = Msg<'table'>;

export class SimClient {
  private w: Worker = new SimWorker();
  private nextId = 1;
  private pending = new Map<number, (m: FromWorker) => void>();
  seed = 1;
  years: number[] = [];
  series = new Float64Array(0);
  frontier = 0; // last simulated step
  done = false;
  ms = 0;
  onProgress: () => void = () => {};

  constructor() {
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'progress') {
        if (m.seed !== this.seed) return;
        if (!this.years.length) { this.years = m.years; this.series = new Float64Array(m.years.length * NGM); }
        this.series.set(m.series, (m.step + 1) * NGM - m.series.length);
        this.frontier = m.step; this.done = m.done; this.ms = m.ms;
        this.onProgress();
        return;
      }
      const cb = this.pending.get(m.id);
      if (cb) { this.pending.delete(m.id); cb(m); }
    };
  }

  run(seed: number): void {
    this.seed = seed; this.years = []; this.frontier = 0; this.done = false;
    this.send({ type: 'run', seed });
  }

  private send(m: ToWorker): void { this.w.postMessage(m); }

  private ask<T extends FromWorker>(m: DistributiveOmit<Extract<ToWorker, { id: number }>, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.pending.set(id, res as (m: FromWorker) => void);
      this.send({ ...m, id } as ToWorker);
    });
  }

  residents(body: number, year: number, offset: number, count: number) { return this.ask<Msg<'residents'>>({ type: 'residents', body, year, offset, count }); }
  person(person: string, year: number) { return this.ask<Msg<'person'>>({ type: 'person', person, year }); }
  residentAt(body: number, year: number, k: number) { return this.ask<Msg<'residentAt'>>({ type: 'residentAt', body, year, k }); }
  /** the n-th person ever born on `body`, optionally of a kind (baseline, adapted, uploaded) at `year` */
  findPerson(body: number, n: number, kind: string, year: number) { return this.ask<Msg<'findPerson'>>({ type: 'findPerson', body, n, kind, year }); }
  chronicle(from: number, to: number, opts: { body?: number; query?: string; limit?: number; minWeight?: number } = {}) { return this.ask<Msg<'chronicle'>>({ type: 'chronicle', from, to, ...opts }); }
  society(body: number, step: number) { return this.ask<Msg<'society'>>({ type: 'society', body, step }); }
  ship(from: number, to: number, depart: number) { return this.ask<Msg<'ship'>>({ type: 'ship', from, to, depart }); }
  placeNames() { return this.ask<Msg<'placeNames'>>({ type: 'placeNames' }); }
  inventions() { return this.ask<Msg<'inventions'>>({ type: 'inventions' }); }
  /** ages, faiths, polities and wars of this future, with their names */
  annals() { return this.ask<Msg<'annals'>>({ type: 'annals' }); }
  /** how this future fights at a year: the generation of war minds, and wars in the last `span` years against the span before */
  wayOfWar(year: number, span = 500) { return this.ask<Msg<'wayOfWar'>>({ type: 'wayOfWar', year, span }); }
  state(step: number) { return this.ask<StateMsg>({ type: 'state', step }); }
  /** every living settlement's full row at a step */
  table(step: number) { return this.ask<Msg<'table'>>({ type: 'table', step }); }
  /** A settlement query evaluated across the run (count, sum, pop-weighted mean, min or max). */
  scan(expr: string, agg: 'count' | 'sum' | 'mean' | 'min' | 'max', of: string, stride: number) { return this.ask<Msg<'scan'>>({ type: 'scan', expr, agg, of, stride }); }
  /** Any data-desk request (see dataApi.ts), so new ones need no method here. */
  data<T extends DataReq['type']>(req: DistributiveOmit<Extract<DataReq, { type: T }>, 'id'>): Promise<Extract<DataRes, { type: T }>> {
    return this.ask(req as DistributiveOmit<Extract<ToWorker, { id: number }>, 'id'>);
  }
  history(body: number) { return this.ask<HistoryMsg>({ type: 'history', body }); }
  events(fromYear: number, toYear: number, body?: number, limit?: number) {
    return this.ask<Msg<'events'>>({ type: 'events', fromYear, toYear, body, limit }).then((m) => m.events);
  }

  /** index of the last step whose year is <= year */
  stepAt(year: number): number {
    const ys = this.years;
    let lo = 0, hi = Math.min(ys.length - 1, this.frontier);
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ys[mid] <= year) lo = mid; else hi = mid - 1; }
    return lo;
  }

  metric(step: number, col: number): number { return this.series[step * NGM + col]; }
}
