// A quiet line next to the year: notable events surface briefly as playback passes them.

import { ERAS, EV, TECHS } from '../sim/catalog.ts';
import type { SimEvent } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import type { Ref } from '../view/views.ts';
import { fmtYear } from './format.ts';

export const NOTABLE = new Set([
  EV.Technology, EV['Era change'], EV.Independence, EV.War, EV['First contact'], EV['Megastructure complete'],
  EV.Speciation, EV['Dark forest strike'], EV.Supernova, EV['Gamma-ray burst'],
]);

export interface TickItem { key: string; year: number; text: string; ref: Ref | null; rank: number }

// what wins when several things happen at once
const RANK: Record<number, number> = {
  [EV['First contact']]: 9, [EV['Dark forest strike']]: 9, [EV['Era change']]: 5, [EV.Speciation]: 7, [EV['Megastructure complete']]: 6,
  [EV.Supernova]: 6, [EV['Gamma-ray burst']]: 6, [EV.Technology]: 5, [EV.Independence]: 4, [EV.War]: 3,
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function describe(world: World, e: SimEvent): TickItem {
  const name = (b: number) => world.bodies[b]?.name ?? 'somewhere';
  const ref: Ref | null = e.body >= 0 ? { kind: 'body', id: e.body } : null;
  let text = '';
  switch (e.type) {
    case EV.Technology: text = `${TECHS[e.a]?.name ?? 'A breakthrough'} is invented`; break;
    case EV['Era change']: text = `${ERAS[e.a]} era begins`; break;
    case EV.Independence: text = `${name(e.body)} declares independence`; break;
    case EV.War: text = `War between ${name(e.body)} and ${name(e.a)}`; break;
    case EV['First contact']: text = e.a === 1 ? 'First contact: a signal from another mind' : 'First contact: ruins of someone else'; break;
    case EV['Megastructure complete']: text = `${name(e.body)} completes a megastructure`; break;
    case EV.Speciation: text = `The people of ${name(e.body)} become a new species`; break;
    case EV['Dark forest strike']: text = `${world.systems[world.bodies[e.body]?.system]?.name ?? 'A system'} is erased from the dark`; break;
    case EV.Supernova: text = `Supernova near ${name(e.body)}`; break;
    case EV['Gamma-ray burst']: text = `Gamma-ray burst sweeps ${name(e.body)}`; break;
    default: text = name(e.body);
  }
  return { key: `${e.year}:${e.type}:${e.body}:${e.a}`, year: e.year, text, ref, rank: RANK[e.type] ?? 1 };
}

export class Ticker {
  el: HTMLElement;
  private items: (TickItem & { born: number })[] = [];
  private seen = new Set<string>();
  private pending: (TickItem & { at: number })[] = [];
  private lastShown = 0;
  onPick: (it: TickItem) => void = () => {};

  constructor(private life = 6000, private max = 3) {
    this.el = document.createElement('div');
    this.el.className = 'ticker';
    this.el.setAttribute('aria-live', 'polite');
    this.el.setAttribute('aria-label', 'Events as they happen');
    this.el.addEventListener('click', (e) => {
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-k]')?.dataset.k;
      const it = this.items.find((x) => x.key === k);
      if (it) this.onPick(it);
    });
  }

  /** Queue events; at most one surfaces per `gap` ms, the most important first. */
  push(list: TickItem[]): void {
    const now = performance.now();
    for (const it of list) {
      if (this.seen.has(it.key)) continue;
      this.seen.add(it.key);
      this.pending.push({ ...it, at: now });
    }
    if (this.seen.size > 4000) this.seen.clear();
    this.prune(now);
  }

  clear(): void { this.items = []; this.pending = []; this.seen.clear(); this.paint(); }

  /** call every so often: surfaces queued lines and lets stale ones leave */
  prune(now = performance.now(), gap = 1200): void {
    this.pending = this.pending.filter((x) => now - x.at < 2500);
    if (this.pending.length && now - this.lastShown > gap) {
      let best = 0;
      this.pending.forEach((x, i) => { if (x.rank > this.pending[best].rank || (x.rank === this.pending[best].rank && x.year > this.pending[best].year)) best = i; });
      const [it] = this.pending.splice(best, 1);
      this.items.push({ ...it, born: now });
      this.lastShown = now;
    }
    const before = this.items.length;
    this.items = this.items.filter((x) => now - x.born < this.life).slice(-this.max);
    if (before || this.items.length) this.paint();
  }

  private nodes = new Map<string, HTMLButtonElement>();
  private paint(): void {
    const now = performance.now();
    const keep = new Set(this.items.map((x) => x.key));
    for (const [k, n] of this.nodes) if (!keep.has(k)) { n.remove(); this.nodes.delete(k); }
    // newest first
    this.items.slice().reverse().forEach((x, i) => {
      let n = this.nodes.get(x.key);
      if (!n) {
        n = document.createElement('button');
        n.type = 'button';
        n.dataset.k = x.key;
        n.innerHTML = `<span class="num">${fmtYear(x.year)}</span> ${esc(x.text)}`;
        this.nodes.set(x.key, n);
      }
      n.className = `tick${i ? ' older' : ''}${now - x.born > this.life - 900 ? ' leaving' : ''}`;
      if (this.el.children[i] !== n) this.el.insertBefore(n, this.el.children[i] ?? null);
    });
  }
}
