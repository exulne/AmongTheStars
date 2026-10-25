// Ships in transit. The heads drawn in the galaxy, local and system views are
// the engine's own ship list; the worker adds the ship's name, how many people
// boarded and its captain from the Chronicle.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import type { ShipInfo } from '../sim/worker.ts';
import { GENERATION, periodOf } from '../sim/ledger.ts';
import type { PersonBrief } from '../sim/lives.ts';
import type { Seg } from '../sim/chronicle.ts';
import { fmtNum } from '../ui/format.ts';
import { MC } from '../sim/launchEconomics.ts';
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
type Aboard = { total: number; people: PersonBrief[] };
type FetchAboard = (body: number, year: number) => Promise<Aboard & { pending?: boolean }>;
let fetcher: Fetch | null = null, aboardFetch: FetchAboard | null = null;
const aboard = new Map<string, Aboard>();
let onUpdate: () => void = () => {};
const info = new Map<string, ShipInfo | null>();
const inflight = new Set<string>();
/** Wire the worker query and a re-render callback; call `resetShips` when the future changes. */
export function setShipApi(f: Fetch, update: () => void, a?: FetchAboard): void { fetcher = f; onUpdate = update; aboardFetch = a ?? null; }
export function resetShips(): void { info.clear(); aboard.clear(); ids.clear(); recs.length = 0; econ.clear(); }

// each ship's launch economics record (launchEconomics.ts), fetched once
type FetchMission = (id: number) => Promise<{ row: Float64Array | null }>;
let missionFetch: FetchMission | null = null;
const econ = new Map<number, Float64Array | null>();
const econAsk = new Set<number>();
export function setMissionApi(f: FetchMission): void { missionFetch = f; }
function econFor(id: number): Float64Array | null | undefined {
  if (econ.has(id)) return econ.get(id);
  if (missionFetch && !econAsk.has(id)) {
    econAsk.add(id);
    missionFetch(id).then((r) => { econAsk.delete(id); econ.set(id, r.row); onUpdate(); });
  }
  return undefined;
}

/** Who is aboard a generation ship this period (fetched once per ship and period). */
function aboardAt(body: number, year: number): Aboard | undefined {
  const k = `${body}:${periodOf(year)}`;
  const got = aboard.get(k);
  if (got || !aboardFetch || inflight.has(k)) return got;
  inflight.add(k);
  aboardFetch(body, year).then((r) => {
    inflight.delete(k);
    if (r.pending) return;
    if (aboard.size > 200) aboard.clear();
    aboard.set(k, r);
    onUpdate();
  });
  return undefined;
}

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
    { k: 'Distance', v: `${dist < 10 ? dist.toFixed(2) : Math.round(dist).toLocaleString('en-US')} ly`, t: 'P' },
    { k: 'Drive', v: ftl ? 'warp: Alcubierre metric engineering' : v > 0.1 ? 'antimatter or beamed sail' : 'fusion', t: 'E' },
    { k: ftl ? 'Effective speed' : 'Cruise speed', v: ftl ? `${fmtNum(Math.round(v))}× light` : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}% of light`, t: 'P' },
    { k: 'Voyage so far', v: c.year >= s.arrive ? 'over' : `${Math.round(f * 100)}%, ${Math.max(0, Math.round(s.arrive - c.year))} years to go`, t: 'P' },
  ];
  if (gen) facts.push({ k: 'Generations aboard', v: `about ${Math.max(1, Math.round(years / 28))}`, t: 'E' });
  // the ship's log: children born aboard so far, and the people living aboard now
  const sailing = c.year >= s.depart && c.year < s.arrive;
  const crew = i && i.body >= 0 && sailing ? aboardAt(i.body, c.year) : undefined;
  if (i && i.born.length && c.year >= s.depart) {
    let born = 0;
    for (const [y, n] of i.born) { if (y > c.year) break; born = n; }
    facts.push({ k: 'Born aboard so far', v: fmtNum(born), t: 'P' });
  }
  if (crew) facts.push({ k: 'Living aboard now', v: fmtNum(crew.total), t: 'P' });
  const m = econFor(s.mission);
  if (m) {
    facts.push({ k: 'Mission cost (fully burdened, 2024 $)', v: `$${fmtNum(m[MC.total])} (envelope $${fmtNum(m[MC.low])}–$${fmtNum(m[MC.high])})`, t: 'E' });
    facts.push({ k: 'Cost per colonist', v: `$${fmtNum(m[MC.costPerPassenger])}`, t: 'E' });
  }
  const story: Seg[] = [...(i?.launch?.segs ?? [])];
  if (crew?.people.length) {
    story.push(`${story.length ? ' ' : ''}Aboard in ${yr(c.year)}: `);
    crew.people.slice(0, 6).forEach((p, k) => {
      if (k) story.push(k === Math.min(6, crew.people.length) - 1 ? ' and ' : ', ');
      story.push({ t: p.name, kind: 'person', id: p.id }, ` (${Math.floor(p.age)}, ${p.job})`);
    });
    story.push(crew.total > 6 ? `, among ${fmtNum(crew.total)}.` : '.');
  }
  return {
    eyebrow: ftl ? 'Warp ship in transit' : gen ? 'Generation ship in transit' : 'Colony ship in transit',
    title: i ? `The ${i.name}` : ftl ? 'Warp ship' : 'Colony ship',
    lede: `Carrying ${fmtNum(i?.n ?? s.colonists)} people from ${A.name} to ${B.name}, ${dist < 10 ? dist.toFixed(1) : Math.round(dist).toLocaleString('en-US')} light years, launched in ${yr(s.depart)}.`,
    facts,
    why: gen ? `A voyage of ${Math.round(years)} years: the people who step off at ${B.name} will be the grandchildren of those who boarded.` : ftl ? 'Folded space makes the galaxy a few years wide; ships like this are how a warp-capable future fills it.' : 'Every settlement beyond its home world began as a ship like this one.',
    story: story.length ? story : undefined,
    links: [{ label: A.name, act: 'body', id: A.id }, { label: B.name, act: 'body', id: B.id }, ...(m ? [{ label: 'Launch economics', act: 'mission' as const, id: s.mission }] : [])],
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
