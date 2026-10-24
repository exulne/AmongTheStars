// Knowledge travels at the speed of light. An invention happens at one place
// in one year; a world 40 light years away hears of it 40 years later and only
// then can build with it. (The engine's global effects stand for humanity's
// average; what each place can build, and how its people live, waits for the news.)

import type { World } from './world.ts';

/** The year technology i reaches body b, or -1 if it has not been invented. */
export function techArrival(w: World, techDone: Float64Array, techWhere: Float64Array, i: number, b: number): number {
  const d = techDone[i];
  if (d < 0) return -1;
  const from = techWhere[i];
  if (from < 0 || from === b || !w.bodies[from] || !w.bodies[b]) return d;
  const s1 = w.systems[w.bodies[from].system], s2 = w.systems[w.bodies[b].system];
  return d + Math.hypot(s1.x - s2.x, s1.y - s2.y, s1.z - s2.z);
}

/** Whether body b can use technology i in `year`. */
export function techAt(w: World, techDone: Float64Array, techWhere: Float64Array, i: number, b: number, year: number): boolean {
  const y = techArrival(w, techDone, techWhere, i, b);
  return y >= 0 && y <= year;
}
