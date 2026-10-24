// Daily life in one settlement. Every agent is a real resident; where they go
// and when comes from their age and job, the hour of a sped-up day, and the
// settlement's mood (war, plague, shortage, a golden age). Routes run along the
// street grid as L-shaped walks between intersections.

import * as THREE from 'three';
import type { PersonBrief } from '../sim/lives.ts';
import { hash01 } from '../sim/rng.ts';

export type Dest = 'farms' | 'works' | 'reactor' | 'mine' | 'port' | 'labs' | 'hall' | 'hospital' | 'school' | 'plaza' | 'market' | 'temple' | 'depot' | 'home';

export const DEST_NAME: Record<Dest, string> = {
  farms: 'the greenhouses', works: 'the works', reactor: 'the reactor', mine: 'the mine', port: 'the spaceport', labs: 'the labs',
  hall: 'the council hall', hospital: 'the hospital', school: 'school', plaza: 'the plaza', market: 'the market', temple: 'the temple',
  depot: 'the ration depot', home: 'home',
};

const JOB_DEST: [RegExp, Dest][] = [
  [/reactor|fusion|stellar|swarm/, 'reactor'], [/miner|regolith/, 'mine'],
  [/hydroponic|farmer|gene/, 'farms'], [/fabricat|welder|robot|haul|ringwright|terraform|engineer/, 'works'],
  [/pilot|ship|trader|diplomat/, 'port'], [/administrat|magistrate|lineage/, 'hall'], [/medic|surgeon|counsel/, 'hospital'],
  [/teacher|student|child|apprentice/, 'school'], [/cook|artist|composer/, 'market'], [/priest/, 'temple'],
  [/geolog|research|auditor|archiv|histor|chronicl|mind|dream|architect|translator/, 'labs'],
];

export function jobDest(p: PersonBrief): Dest {
  if (p.age < 18) return 'school';
  if (/retired/.test(p.job) || p.age >= 75) return 'plaza';
  for (const [re, d] of JOB_DEST) if (re.test(p.job)) return d;
  return 'works';
}

export interface Mood { activity: number; leisure: number; war: boolean; plague: boolean; queue: boolean; faith: boolean }
export const CALM: Mood = { activity: 0.85, leisure: 0.35, war: false, plague: false, queue: false, faith: true };

export interface Places { node: THREE.Vector3[]; at: Partial<Record<Dest, THREE.Vector3[]>>; homes: THREE.Vector3[]; ring: number; R: number }

export interface Agent {
  p: PersonBrief;
  home: THREE.Vector3; work: THREE.Vector3; dest: Dest;
  leis: THREE.Vector3 | null; leisDest: Dest;
  out: number; back: number; until: number; // hours: leave home, leave work, leave leisure
  speed: number; side: number; seed: number;
  stays: boolean; patrol: boolean; queue: number;
  // per frame
  x: number; y: number; z: number; vis: boolean; doing: string;
}

const pick = <T>(xs: T[] | undefined, h: number): T | undefined => (xs && xs.length ? xs[Math.floor(h * xs.length) % xs.length] : undefined);

export function makeAgent(p: PersonBrief, k: number, pl: Places, mood: Mood): Agent {
  const s = hash01(k, p.born, p.age);
  const h = (n: number) => hash01(k, p.born, n);
  let dest = jobDest(p);
  if (dest === 'temple' && !mood.faith) dest = 'hall';
  const home = pick(pl.homes, h(1)) ?? new THREE.Vector3();
  const work = pick(pl.at[dest], h(2)) ?? pick(pl.at.works, h(2)) ?? home;
  const fun: Dest[] = mood.faith ? ['plaza', 'market', 'temple', 'plaza'] : ['plaza', 'market', 'plaza'];
  const leisDest = pick(fun, h(3))!;
  const goesOut = h(4) < (dest === 'plaza' ? 0.9 : mood.leisure);
  const child = dest === 'school' && p.age < 18;
  const a: Agent = {
    p, home, work, dest, leis: goesOut ? pick(pl.at[leisDest], h(5)) ?? null : null, leisDest,
    out: child ? 7.5 + h(6) * 0.8 : dest === 'plaza' ? 9.5 + h(6) * 2 : 6.2 + h(6) * 2.6,
    back: child ? 15 + h(7) : dest === 'plaza' ? 15.5 + h(7) * 2 : 16 + h(7) * 2.5,
    until: 19.5 + h(8) * 3,
    speed: 9 + h(9) * 6, side: h(10) < 0.5 ? -1 : 1, seed: s,
    stays: s > mood.activity, patrol: mood.war && h(11) < 0.08 && p.age >= 20 && p.age < 60,
    queue: mood.queue && h(12) < 0.25 ? Math.floor(h(13) * 40) : -1,
    x: 0, y: 0, z: 0, vis: false, doing: '',
  };
  return a;
}

const c = new THREE.Vector3();
/** Point `u` (0..1) along an L-shaped walk from a to b on the street grid, pushed to one side of the street. */
function along(a: THREE.Vector3, b: THREE.Vector3, u: number, side: number, R: number, out: THREE.Vector3): number {
  c.set(a.x, 0, b.z);
  if (Math.hypot(c.x, c.z) > R) c.set(b.x, 0, a.z);
  const l1 = Math.abs(a.x - c.x) + Math.abs(a.z - c.z), l2 = Math.abs(b.x - c.x) + Math.abs(b.z - c.z), L = l1 + l2 || 1;
  const s = u * L;
  let dx: number, dz: number;
  if (s < l1) { const f = s / (l1 || 1); out.lerpVectors(a, c, f); dx = c.x - a.x; dz = c.z - a.z; }
  else { const f = (s - l1) / (l2 || 1); out.lerpVectors(c, b, f); dx = b.x - c.x; dz = b.z - c.z; }
  const n = Math.hypot(dx, dz) || 1;
  out.x += (-dz / n) * 0.09 * side; out.z += (dx / n) * 0.09 * side;
  return L;
}

const tv = new THREE.Vector3();
const walkHours = (a: THREE.Vector3, b: THREE.Vector3, speed: number) => Math.min(1.6, (Math.abs(a.x - b.x) + Math.abs(a.z - b.z)) / speed + 0.15);

/** Where the agent is at hour `hr` (0..24); sets x, y, z, vis and doing. */
export function place(a: Agent, hr: number, t: number, pl: Places): void {
  a.vis = false; a.y = 0.1;
  const set = (v: THREE.Vector3, doing: string, vis = true) => { a.x = v.x; a.z = v.z; a.vis = vis; a.doing = doing; };
  if (a.patrol) {
    const ang = a.seed * 6.283 + t * 0.05 * (a.side);
    set(tv.set(Math.cos(ang) * pl.ring, 0, Math.sin(ang) * pl.ring), 'on patrol');
    return;
  }
  if (a.stays) { set(a.home, 'staying in', false); return; }
  const w1 = walkHours(a.home, a.work, a.speed);
  if (hr < a.out) { set(a.home, hr < 5 ? 'asleep' : 'at home', false); return; }
  if (hr < a.out + w1) { along(a.home, a.work, (hr - a.out) / w1, a.side, pl.R, tv); set(tv, `on the way to ${DEST_NAME[a.dest]}`); return; }
  // a queue at the depot around midday when supplies are short
  if (a.queue >= 0 && hr > 11 && hr < 13.5) {
    const d = pl.at.depot?.[0] ?? a.work;
    set(tv.set(d.x + 0.15 + a.queue * 0.11, 0, d.z + 0.12), 'queueing at the ration depot');
    return;
  }
  if (hr < a.back) {
    if (a.dest === 'plaza' || a.dest === 'market') {
      const ang = a.seed * 40 + t * 0.07, r = 0.25 + (a.seed * 7 % 1) * 0.9;
      set(tv.set(a.work.x + Math.cos(ang) * r, 0, a.work.z + Math.sin(ang) * r), `at ${DEST_NAME[a.dest]}`);
    } else set(a.work, `at ${DEST_NAME[a.dest]}`, false);
    return;
  }
  const to = a.leis ?? a.home;
  const w2 = walkHours(a.work, to, a.speed);
  if (hr < a.back + w2) { along(a.work, to, (hr - a.back) / w2, a.side, pl.R, tv); set(tv, a.leis ? `on the way to ${DEST_NAME[a.leisDest]}` : 'heading home'); return; }
  if (a.leis) {
    if (hr < a.until) {
      const ang = a.seed * 31 + t * 0.06, r = 0.2 + (a.seed * 13 % 1) * 1.1;
      set(tv.set(a.leis.x + Math.cos(ang) * r, 0, a.leis.z + Math.sin(ang) * r), `at ${DEST_NAME[a.leisDest]}`);
      return;
    }
    const w3 = walkHours(a.leis, a.home, a.speed);
    if (hr < a.until + w3) { along(a.leis, a.home, (hr - a.until) / w3, a.side, pl.R, tv); set(tv, 'heading home'); return; }
  }
  set(a.home, 'at home', false);
}
