// A thousand years after the Landing nobody out there counts in Earth's
// years. Next to AD the timeline shows the local reckoning: years after
// Landing (AL), and, where the place you are looking at belongs to a free
// polity, the years since it declared itself ("year 412 of the Kepler Compact").

import { EV } from '../sim/catalog.ts';
import type { SimEvent, StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';

/** Years after the Landing before the local reckoning appears. */
export const LOCAL_FROM = 1000;
const FORMS = ['Compact', 'Accord', 'Concord', 'Commonwealth', 'Free State', 'Charter', 'Union', 'Covenant'];

type Events = (fromYear: number, toYear: number, body?: number, limit?: number) => Promise<SimEvent[]>;

export class LocalCalendar {
  /** Name of a place; swapped for the worker's own-language names when they exist. */
  nameOf: (b: number) => string;
  /** Called when a fetched founding year changes the text. */
  onChange: () => void = () => {};
  private faction = -1;
  private since = new Map<number, { asOf: number; years: number[] }>();
  private asking = new Set<number>();
  private gen = 0;

  constructor(private world: World, private events: Events) {
    this.nameOf = (b) => world.bodies[b]?.name ?? '';
  }

  /** A new future: forget every founding. */
  reset(): void { this.gen++; this.since.clear(); this.asking.clear(); this.faction = -1; }

  /** The place being looked at (or -1), at the state now shown; `upTo` is how far the run has simulated. */
  place(snap: StateMsg | null, body: number, year: number, upTo: number): void {
    const w = this.world;
    const f = snap && body >= 0 ? snap.S[body * NF + F.faction] : -1;
    this.faction = f >= 0 && f !== w.earth && w.bodies[f] ? f : -1;
    if (year < LOCAL_FROM || this.faction < 0) return;
    const got = this.since.get(this.faction);
    if ((got && got.asOf >= year) || this.asking.has(this.faction)) return;
    const fac = this.faction, g = this.gen;
    this.asking.add(fac);
    this.events(0, Math.max(year, upTo), fac, 3000).then((evs) => {
      if (g !== this.gen) return;
      this.asking.delete(fac);
      const years = evs.filter((e) => e.type === EV.Independence && e.body === fac).map((e) => e.year).sort((a, b) => a - b);
      this.since.set(fac, { asOf: Math.max(year, upTo), years });
      this.onChange();
    });
  }

  /** "AL 2960 · year 412 of the Kepler Compact", or "" before the local reckoning starts. */
  text(year: number): string {
    if (year < LOCAL_FROM) return '';
    const al = `AL ${Math.floor(year)}`;
    const f = this.faction;
    if (f < 0) return al;
    const ys = this.since.get(f)?.years ?? [];
    let y0 = -1;
    for (const y of ys) if (y <= year) y0 = y;
    if (y0 < 0) return al;
    const form = FORMS[Math.floor(hash01(f, 41) * FORMS.length)];
    return `${al} · year ${(Math.floor(year - y0) + 1).toLocaleString('en-US')} of the ${this.nameOf(f)} ${form}`;
  }
}
