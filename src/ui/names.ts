// What people call things: each faith by its own name rather than a number,
// and worlds by the names their people gave them, in their own language.
// Both come from the worker once the run (and its Chronicle) is complete;
// until then faiths read "a faith" and worlds keep their catalogue names.

import type { SimClient } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import './names.css';

const EARTH_FAITHS = "Earth's old faiths";

class Names {
  private faiths = new Map<number, string>();
  private places = new Map<number, string>();
  private gen = 0;
  private timer = 0;
  /** Called whenever names arrive, so panels and labels can redraw. */
  onChange: () => void = () => {};

  /** Faith by culture value: 0 is Earth's old faiths, n is row n-1 of the faith table. */
  faith(n: number): string {
    if (!(n > 0)) return EARTH_FAITHS;
    return this.faiths.get(n) ?? 'a local faith';
  }
  hasFaiths(): boolean { return this.faiths.size > 0; }

  /** The name its people use, or null if that is still the catalogue name. */
  local(b: number): string | null { return this.places.get(b) ?? null; }
  /** The name to show: the local one when there is one. */
  place(world: World, b: number): string { return this.places.get(b) ?? world.bodies[b]?.name ?? ''; }

  /** A new future: drop the old names and ask again until the run is complete. */
  load(sim: SimClient): void {
    const g = ++this.gen;
    clearTimeout(this.timer);
    this.faiths.clear(); this.places.clear();
    let gotF = false, gotP = false;
    const ask = () => {
      if (g !== this.gen) return;
      const wait: Promise<void>[] = [];
      if (!gotF) wait.push(sim.faithNames().then((m) => {
        if (g !== this.gen || m.pending) return;
        gotF = true;
        for (const [n, name] of m.names) this.faiths.set(n, name);
      }));
      if (!gotP) wait.push(sim.placeNames().then((m) => {
        if (g !== this.gen || m.pending) return;
        gotP = true;
        for (const [b, n] of m.names) this.places.set(b, n);
      }));
      Promise.all(wait).then(() => {
        if (g !== this.gen) return;
        if (gotF && gotP) this.onChange();
        else this.timer = window.setTimeout(ask, 1500);
      });
    };
    this.timer = window.setTimeout(ask, 800);
  }
}

export const names = new Names();
