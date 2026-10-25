// A catalogued close approach as a visual scenario (page side: CAD is in the
// snapshot, no physics runs). Shared by the Impact Lab and the debug harness.

import { HORIZONS, SNAPSHOT_ID } from '../data/snapshot.ts';
import type { World } from '../sim/world.ts';
import { BODIES } from './bodies.ts';
import { approaches, type Approach } from './catalog.ts';
import { visualCloseApproach, type VisualScenario } from './visual.ts';

export function approachVisual(a: Approach, world: World): VisualScenario {
  const hz = !!HORIZONS?.series.find((s) => s.target === a.body && (s.id.startsWith('apophis') ? a.des.includes('99942') || a.name.includes('Apophis') : a.des.includes('2024 YR4')));
  return visualCloseApproach({
    body: BODIES[a.body], world: world.bodies.findIndex((b) => b.name === a.body && b.system === 0), des: a.des, name: a.name, date: a.date, jd: a.jd,
    distKm: a.distKm, distMinKm: a.distMinKm, distMaxKm: a.distMaxKm, vRelKms: a.vRelKms, vInfKms: a.vInfKms, tSigma: a.tSigma, diameterM: a.diameterM,
    classification: a.classification, snapshotId: SNAPSHOT_ID, horizons: hz,
  });
}

/** The debug harness's real close approach: the nearest upcoming Earth approach in the snapshot (else the nearest past one). */
export function demoApproach(world: World): VisualScenario | null {
  const list = approaches('Earth'), a = list.filter((x) => !x.past).sort((p, q) => p.distKm - q.distKm)[0] ?? list[0];
  return a ? approachVisual(a, world) : null;
}
