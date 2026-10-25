// The distance circles of the nearby-stars view.

import * as THREE from 'three';
import { fmtNum } from '../ui/format.ts';
import { sig } from './astro.ts';
import { addCpuSet, rayPlane, segDist } from './picker.ts';
import { registerExplainer, type ExCtx, type Explanation } from './registry.ts';
import { isAlive, popAt, stageAt } from './simInfo.ts';

export function explainLocalRings(kind: string, obj: THREE.Object3D, radii: number[]): void {
  registerExplainer(kind, {
    obj,
    explain: (i, c) => ringCard(radii[i], c),
    name: (i) => `${radii[i]} light-year circle`,
    locate: (i, out) => out.set(radii[i], 0, 0),
  });
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  addCpuSet({
    kind, obj, prio: -4,
    hit: (p) => {
      if (!rayPlane(p, 0, P)) return null;
      const rho = Math.hypot(P.x, P.z);
      let best: { i: number; d: number } | null = null;
      radii.forEach((R, i) => {
        Q.copy(P).multiplyScalar(R / Math.max(rho, 1e-9));
        const d = segDist(P, Q, p);
        if (d < 6 && (!best || d < best.d)) best = { i, d };
      });
      return best;
    },
  });
}

function ringCard(R: number, c: ExCtx): Explanation {
  let cat = 0, settled = 0, people = 0;
  const seen = new Set<number>();
  for (const s of c.world.systems) {
    if ((s.region !== 'local' && s.region !== 'sol') || s.dist > R) continue;
    cat++;
    for (const b of s.bodies) {
      if (!isAlive(stageAt(c.snap, b))) continue;
      people += popAt(c.snap, b);
      if (!seen.has(s.id)) { seen.add(s.id); settled++; }
    }
  }
  // stars per cubic light year near the Sun ≈ 0.004; beyond a few hundred ly the disc's thickness (~1,000 ly) caps the volume
  const real = R < 300 ? 0.004 * (4 / 3) * Math.PI * R ** 3 : 0.004 * Math.PI * R * R * 1000;
  return {
    eyebrow: 'Distance circle around the Sun',
    title: `${R} light years`,
    lede: `Everything inside this circle is within ${R} light years of the Sun, drawn flat in the plane of the galaxy.`,
    facts: [
      { k: 'Real stars inside', v: R === 10 ? '≈12 systems, 20 stars' : `≈${sig(real)}`, t: R === 10 ? 'R' : 'E' },
      { k: 'Systems the simulation tracks', v: fmtNum(cat), t: 'P' },
      { k: 'Settled systems now', v: fmtNum(settled), t: 'P' },
      { k: 'People inside', v: fmtNum(people), t: 'P' },
      { k: 'A message to the rim takes', v: `${R} years`, t: 'R' },
      { k: 'At 10% of light speed', v: `${R * 10} years`, t: 'E' },
    ],
    why: R <= 10 ? 'Within a human lifetime by the fastest ships: the first ring of colonies.' : R <= 100 ? 'Generation-ship country: colonies out here hear from Earth decades late and govern themselves.' : 'Beyond this circle, a colony\'s news of Earth is centuries old when it arrives, and it is a civilisation of its own.',
  };
}
