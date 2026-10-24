// Ships in transit. The heads drawn in the galaxy, local and system views are
// the engine's own ship list; the worker adds the ship's name, how many people
// boarded and its captain from the Chronicle.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import type { ShipInfo } from '../sim/worker.ts';
import { GENERATION } from '../sim/ledger.ts';
import { fmtNum } from '../ui/format.ts';
import { addCpuSet, addGpuSet, segDist } from './picker.ts';
import { registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';

export type ShipRec = StateMsg['ships'][number];

// a ship keeps one id for the whole session, whatever its slot in the engine's list
const ids = new Map<string, number>();
const recs: ShipRec[] = [];
const keyOf = (s: ShipRec) => `${s.from}:${s.to}:${s.depart.toFixed(4)}`;
export function shipId(s: ShipRec): number {
  const k = keyOf(s);
  let id = ids.get(k);
  if (id === undefined) { id = recs.length; ids.set(k, id); recs.push(s); }
  else recs[id] = s;
  return id;
}
export function shipRec(id: number): ShipRec | undefined { return recs[id]; }

type Fetch = (from: number, to: number, depart: number) => Promise<{ pending?: boolean; ship: ShipInfo | null }>;
let fetcher: Fetch | null = null;
let onUpdate: () => void = () => {};
const info = new Map<string, ShipInfo | null>();
const inflight = new Set<string>();
/** Wire the worker query and a re-render callback; call `resetShips` when the future changes. */
export function setShipApi(f: Fetch, update: () => void): void { fetcher = f; onUpdate = update; }
export function resetShips(): void { info.clear(); ids.clear(); recs.length = 0; }

function infoFor(s: ShipRec): ShipInfo | null | undefined {
  const k = keyOf(s);
  if (info.has(k)) return info.get(k);
  if (fetcher && !inflight.has(k)) {
    inflight.add(k);
    fetcher(s.from, s.to, s.depart).then((r) => {
      inflight.delete(k);
      if (r.pending) { setTimeout(() => onUpdate(), 800); return; }
      info.set(k, r.ship);
      onUpdate();
    });
  }
  return undefined;
}

export function shipName(id: number, c: ExCtx): string {
  const s = recs[id];
  if (!s) return 'Ship';
  const i = infoFor(s);
  const w = c.world;
  return `${i ? `The ${i.name}` : s.kind === 1 ? 'Warp ship' : 'Colony ship'} · ${w.bodies[s.from].name} → ${w.bodies[s.to].name}`;
}

const yr = (y: number) => Math.round(2040 + y).toString();

export function shipCard(id: number, c: ExCtx): Explanation {
  const s = recs[id];
  if (!s) return { eyebrow: 'Ship', title: 'Ship', lede: 'This ship is no longer in this future.', facts: [] };
  const w = c.world;
  const A = w.bodies[s.from], B = w.bodies[s.to];
  const sa = w.systems[A.system], sb = w.systems[B.system];
  const dist = Math.hypot(sa.x - sb.x, sa.y - sb.y, sa.z - sb.z);
  const years = Math.max(0.01, s.arrive - s.depart);
  const f = Math.min(1, Math.max(0, (c.year - s.depart) / years));
  const i = infoFor(s);
  const ftl = s.kind === 1;
  const v = dist / years;
  const gen = !ftl && years > GENERATION;
  const facts: Fact[] = [
    { k: 'Name', v: i ? `The ${i.name}` : i === null ? 'not recorded' : 'reading the record…', t: 'P' },
    { k: 'From', v: `${A.name}, ${sa.name}`, t: 'P' },
    { k: 'To', v: `${B.name}, ${sb.name}`, t: 'P' },
    { k: 'People aboard at launch', v: fmtNum(i?.n ?? s.colonists), t: 'P' },
    { k: 'Departed', v: yr(s.depart), t: 'P' },
    { k: 'Due to arrive', v: yr(s.arrive), t: 'P' },
    { k: 'Distance', v: `${dist < 10 ? dist.toFixed(2) : fmtNum(Math.round(dist))} ly`, t: 'P' },
    { k: 'Drive', v: ftl ? 'warp: Alcubierre metric engineering' : v > 0.1 ? 'antimatter or beamed sail' : 'fusion', t: 'E' },
    { k: ftl ? 'Effective speed' : 'Cruise speed', v: ftl ? `${fmtNum(Math.round(v))}× light` : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}% of light`, t: 'P' },
    { k: 'Voyage so far', v: c.year >= s.arrive ? 'over' : `${Math.round(f * 100)}%, ${Math.max(0, Math.round(s.arrive - c.year))} years to go`, t: 'P' },
  ];
  if (gen) facts.push({ k: 'Generations aboard', v: `about ${Math.max(1, Math.round(years / 28))}`, t: 'E' });
  return {
    eyebrow: ftl ? 'Warp ship in transit' : gen ? 'Generation ship in transit' : 'Colony ship in transit',
    title: i ? `The ${i.name}` : ftl ? 'Warp ship' : 'Colony ship',
    lede: `Carrying ${fmtNum(i?.n ?? s.colonists)} people from ${A.name} to ${B.name}, ${dist < 10 ? dist.toFixed(1) : fmtNum(Math.round(dist))} light years, launched in ${yr(s.depart)}.`,
    facts,
    why: gen ? `A voyage of ${Math.round(years)} years: the people who step off at ${B.name} will be the grandchildren of those who boarded.` : ftl ? 'Folded space makes the galaxy a few years wide; ships like this are how a warp-capable future fills it.' : 'Every settlement beyond its home world began as a ship like this one.',
    story: i?.launch?.segs,
    links: [{ label: A.name, act: 'body', id: A.id }, { label: B.name, act: 'body', id: B.id }],
    pending: i === undefined,
  };
}

/** What a view draws for ships: head points and route lines, each slot tagged with a ship id; and where each head is now. */
export interface ShipDraw {
  heads: THREE.Points;
  headIds: number[];
  lines: THREE.LineSegments;
  segIds: number[];
  segCount: () => number;
  at: Map<number, THREE.Vector3>;
}

/** Register a view's ship heads (GPU picked) and route lines (CPU picked) under `kind` and `kind`+"l". */
export function explainShips(kind: string, d: ShipDraw): void {
  const base = {
    explain: (id: number, c: ExCtx) => shipCard(id, c),
    name: (id: number, c: ExCtx) => shipName(id, c),
    locate: (id: number, out: THREE.Vector3) => { const p = d.at.get(id); return p ? out.copy(p).applyMatrix4(d.heads.matrixWorld) : null; },
  };
  registerExplainer(kind, { ...base, obj: d.heads, idOf: (i) => d.headIds[i] ?? -1 });
  addGpuSet({ kind, points: d.heads, prio: 5, minLum: 0.02, pickPx: 7 });
  registerExplainer(`${kind}l`, { ...base, obj: d.lines });
  const A = new THREE.Vector3(), B = new THREE.Vector3();
  addCpuSet({
    kind: `${kind}l`, obj: d.lines, prio: 0,
    hit: (p) => {
      const pos = d.lines.geometry.attributes.position.array as Float32Array;
      const m = d.lines.matrixWorld;
      let best: { i: number; d: number } | null = null;
      for (let k = 0, n = d.segCount(); k < n; k++) {
        A.set(pos[k * 6], pos[k * 6 + 1], pos[k * 6 + 2]).applyMatrix4(m);
        B.set(pos[k * 6 + 3], pos[k * 6 + 4], pos[k * 6 + 5]).applyMatrix4(m);
        const dd = segDist(A, B, p);
        if (dd < 5 && (!best || dd < best.d)) best = { i: d.segIds[k], d: dd };
      }
      return best;
    },
  });
}
