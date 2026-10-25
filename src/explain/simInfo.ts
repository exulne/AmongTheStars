// Small read-only questions explainers ask of the simulation state.

import { STAGE, STAGE_NAMES, isAlive } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import type { World } from '../sim/world.ts';
import { fmtNum } from '../ui/format.ts';
import type { ExCtx, Fact } from './registry.ts';

export { isAlive };
export const stageAt = (snap: StateMsg | null, b: number) => (snap ? snap.S[b * NF + F.stage] : -1);
export const popAt = (snap: StateMsg | null, b: number) => (snap ? snap.S[b * NF + F.pop] : 0);
export const fieldAt = (snap: StateMsg | null, b: number, f: keyof typeof F) => (snap ? snap.S[b * NF + F[f]] : 0);

export interface SysStatus { pop: number; n: number; stage: number; top: number; surveyed: boolean; founded: number }
/** People, living settlements, best stage, biggest settlement and first founding year in one system. */
export function sysStatus(world: World, snap: StateMsg | null, sys: number): SysStatus {
  const out: SysStatus = { pop: 0, n: 0, stage: -1, top: -1, surveyed: false, founded: Infinity };
  let best = -1;
  for (const b of world.systems[sys].bodies) {
    const st = stageAt(snap, b);
    if (st === STAGE.SURVEY) out.surveyed = true;
    if (!isAlive(st)) { if (st >= 0 && out.stage < 0) out.stage = st; continue; }
    const p = popAt(snap, b);
    out.pop += p; out.n++;
    out.stage = Math.max(out.stage, st);
    out.founded = Math.min(out.founded, fieldAt(snap, b, 'founded'));
    if (p > best) { best = p; out.top = b; }
  }
  return out;
}

/** Plain words for a system's human status. */
export function statusText(world: World, snap: StateMsg | null, sys: number): string {
  const s = sysStatus(world, snap, sys);
  if (s.n) return `${fmtNum(s.pop)} people in ${s.n} settlement${s.n > 1 ? 's' : ''} (${STAGE_NAMES[s.stage].toLowerCase()}), since ${Math.round(2040 + s.founded)}`;
  if (s.surveyed) return 'surveyed by robots, nobody lives here';
  if (s.stage >= STAGE.ABANDONED) return `${STAGE_NAMES[s.stage].toLowerCase()}`;
  return 'never reached';
}

let nearCache: { snap: StateMsg | null; list: { sys: number; x: number; y: number; z: number; pop: number }[] } | null = null;
/** Nearest system with living people to a point in Sun-centred galactic light years. */
export function nearestSettled(world: World, snap: StateMsg | null, x: number, y: number, z: number): { sys: number; d: number } | null {
  if (!snap) return null;
  if (nearCache?.snap !== snap) {
    const seen = new Map<number, number>();
    for (const b of snap.settled) {
      if (!isAlive(stageAt(snap, b))) continue;
      const s = world.bodies[b].system;
      seen.set(s, (seen.get(s) ?? 0) + popAt(snap, b));
    }
    nearCache = { snap, list: [...seen].map(([sys, pop]) => ({ sys, pop, x: world.systems[sys].x, y: world.systems[sys].y, z: world.systems[sys].z })) };
  }
  let best: { sys: number; d: number } | null = null;
  for (const s of nearCache.list) {
    const d = Math.hypot(s.x - x, s.y - y, s.z - z);
    if (!best || d < best.d) best = { sys: s.sys, d };
  }
  return best;
}

/** "Humans" fact for something at a point: here, or how far the nearest people are. */
export function humansFact(c: ExCtx, x: number, y: number, z: number, here = 'not reached'): Fact {
  const n = nearestSettled(c.world, c.snap, x, y, z);
  if (!n) return { k: 'Humans', v: here, t: 'P' };
  const d = n.d < 100 ? n.d.toFixed(1) : Math.round(n.d).toLocaleString('en-US');
  return { k: 'Humans', v: `${here}; nearest people ${d} ly away, at ${c.world.systems[n.sys].name}`, t: 'P' };
}

/** Year in plain calendar words, e.g. "29,160 BCE". */
export function calYear(y: number): string {
  const r = Math.round(y);
  return r < 1 ? `${(1 - r).toLocaleString('en-US')} BCE` : `${r.toLocaleString('en-US').replace(/,/g, r < 10000 ? '' : ',')} CE`;
}
