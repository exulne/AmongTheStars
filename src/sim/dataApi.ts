// The worker's data desk: answers analyst questions about the run without
// touching the engine. Tables come from the state at a step; anything "over
// time" replays the run from its first snapshot on a private engine.

import { STAGE } from './catalog.ts';
import type { Engine, SimState } from './engine.ts';
import { F, NF } from './metrics.ts';
import type { World } from './world.ts';

export type DataReq =
  | { type: 'table'; id: number; step: number };

export type DataRes =
  | { type: 'table'; id: number; step: number; year: number; bodies: Int32Array; rows: Float64Array };

export interface DataEnv {
  world: World;
  main: () => Engine | null;
  snaps: () => SimState[];
  stateAt: (step: number) => Engine;
  post: (m: DataRes, transfer?: Transferable[]) => void;
}

const DATA_TYPES = new Set(['table']);
export function isDataReq(m: { type: string }): m is DataReq { return DATA_TYPES.has(m.type); }

const living = (s: number) => s >= STAGE.OUTPOST && s <= STAGE.MEGA;

export function handleData(m: DataReq, env: DataEnv): void {
  if (m.type === 'table') {
    const e = env.stateAt(m.step), st = e.st;
    const ids: number[] = [];
    for (let n = 0; n < st.nSettled; n++) if (living(st.S[st.settled[n] * NF + F.stage])) ids.push(st.settled[n]);
    const rows = new Float64Array(ids.length * NF);
    ids.forEach((b, i) => rows.set(st.S.subarray(b * NF, b * NF + NF), i * NF));
    const bodies = Int32Array.from(ids);
    env.post({ type: 'table', id: m.id, step: st.step, year: e.years[st.step], bodies, rows }, [bodies.buffer, rows.buffer]);
  }
}
