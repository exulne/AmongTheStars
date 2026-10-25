// Earth's orbital population in the planet view, as two layers that never
// look alike:
// - Simulated fleet (this future's model, after 2040): faint orange dots on the
//   model's shells at their true altitudes; each dot stands for many satellites.
// - Observed objects (CelesTrak GP snapshot, SGP4 at a time near the element-set
//   epochs, computed in the worker): solid dots coloured by operator, altitude
//   or element age, in an inertial frame. Shown only when the Orbits tab turns
//   them on, and always labelled with their epoch, never as the simulated year.

import * as THREE from 'three';
import { CLASS_STYLE } from '../data/provenance.ts';
import { FLEET_2040, SHELLS } from '../orbit/shells.ts';
import { F, NF } from '../sim/metrics.ts';
import { Rng } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';
import { addGpuSet } from '../explain/picker.ts';
import { pointWorld, registerExplainer } from '../explain/registry.ts';
import { pointsMaterial } from './textures.ts';
import { observedLayer } from './observedLayer.ts';
import type { StateMsg } from '../sim/client.ts';

const R = 10; // view units per Earth radius
const RE = 6378.137;
const SIM = new THREE.Color(CLASS_STYLE.simulated.color);
/** satellites one simulated dot stands for */
export const DOT_SATS = 20;

function cloud(n: number, minPx: number, maxPx: number) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(geo, pointsMaterial({ minPx, maxPx }));
  pts.frustumCulled = false;
  return { pts, pos, col, size };
}

export class EarthOrbitLayers {
  private sim: ReturnType<typeof cloud> | null = null;
  private simKey = '';
  private simShell: Int16Array = new Int16Array(0);
  private obs: ReturnType<typeof cloud> | null = null;
  private obsVersion = -1;
  private obsNorads: Int32Array = new Int32Array(0);
  private simCount = 0;

  /** `orbit`: the slowly turning group (simulated shells); `inertial`: a fixed group (observed objects). */
  sync(orbit: THREE.Group, inertial: THREE.Group, world: World, snap: StateMsg | null, on: boolean): void {
    const S = snap?.S, eo = world.earth * NF;
    const gdp = S ? S[eo + F.gdp] : 0;
    const total = on && observedLayer.simulated && gdp > 0 ? FLEET_2040.nominal * Math.sqrt(Math.max(0.05, gdp / 1.6e14)) : 0;
    const dots = Math.min(4000, Math.round(total / DOT_SATS));
    const key = String(Math.round(dots / 50));
    if (key !== this.simKey) {
      this.simKey = key;
      if (this.sim) { orbit.remove(this.sim.pts); this.sim.pts.geometry.dispose(); }
      this.sim = null;
      if (dots > 0) {
        const c = (this.sim = cloud(dots, 0.8, 2.5)), r = new Rng(9001), shell = (this.simShell = new Int16Array(dots));
        const v = new THREE.Vector3(), ax = new THREE.Vector3(1, 0, 0);
        for (let i = 0; i < dots; i++) {
          let x = r.next(), k = 0;
          while (k < SHELLS.length - 1 && x > SHELLS[k].share) { x -= SHELLS[k].share; k++; }
          const s = SHELLS[k], rad = R * (1 + s.altKm / RE), th = r.range(0, Math.PI * 2), node = r.range(0, Math.PI * 2);
          v.set(Math.cos(th) * rad, 0, Math.sin(th) * rad).applyAxisAngle(ax, (s.incDeg * Math.PI) / 180).applyAxisAngle(new THREE.Vector3(0, 1, 0), node);
          c.pos.set([v.x, v.y, v.z], i * 3);
          c.col.set([SIM.r * 0.8, SIM.g * 0.8, SIM.b * 0.8], i * 3);
          c.size[i] = 0.09;
          shell[i] = k;
        }
        const g = c.pts.geometry;
        g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.size.needsUpdate = true;
        orbit.add(c.pts);
        this.simCount = total;
        const pts = c.pts;
        registerExplainer('simfleet', {
          obj: pts,
          explain: (i) => {
            const s = SHELLS[this.simShell[i] ?? 0];
            return {
              eyebrow: 'Simulated satellite shell (this future’s model)', title: s.label,
              lede: `A dot standing for about ${DOT_SATS} simulated satellites. Not an observed object: this is the model’s fleet after 2040.`,
              facts: [
                { k: 'Altitude', v: `${s.altKm.toLocaleString()} km`, t: 'P' }, { k: 'Inclination', v: `${s.incDeg}°`, t: 'P' },
                { k: 'Class', v: s.cls, t: 'P' }, { k: 'Fleet now', v: `${Math.round(this.simCount).toLocaleString()} satellites`, t: 'P' },
                { k: 'Classification', v: CLASS_STYLE.simulated.label, t: 'P' },
              ],
              why: 'Drag at this height, under this future’s seeded Sun, sets how much propellant and how many replacements the shell costs (Data → Orbits & missions).',
            };
          },
          name: (i) => `Simulated shell · ${SHELLS[this.simShell[i] ?? 0].label}`,
          locate: (i, out) => pointWorld(pts, i, out),
        });
        addGpuSet({ kind: 'simfleet', points: pts, prio: 1, minLum: 0.03, pickPx: 5 });
      }
    }
    // observed layer
    if (observedLayer.version !== this.obsVersion) {
      this.obsVersion = observedLayer.version;
      if (this.obs) { inertial.remove(this.obs.pts); this.obs.pts.geometry.dispose(); }
      this.obs = null;
      const P = observedLayer.positions, C = observedLayer.colors;
      if (observedLayer.on && P && C && P.length) {
        const n = P.length / 3, c = (this.obs = cloud(n, 1.2, 4));
        for (let i = 0; i < n * 3; i++) c.pos[i] = P[i] * R;
        c.col.set(C);
        c.size.fill(0.12);
        this.obsNorads = observedLayer.norads ?? new Int32Array(0);
        const g = c.pts.geometry;
        g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.size.needsUpdate = true;
        inertial.add(c.pts);
        const pts = c.pts, at = new Date(observedLayer.tMs).toISOString().slice(0, 16).replace('T', ' ');
        registerExplainer('obssat', {
          obj: pts,
          explain: (i) => {
            const norad = this.obsNorads[i] ?? -1, d = observedLayer.describe(norad);
            return {
              eyebrow: `Observed object · ${CLASS_STYLE.active.label}`, title: d?.title ?? `NORAD ${norad}`,
              lede: d?.lede ?? `Tracked object from the CelesTrak GP snapshot, drawn by SGP4 at ${at} UTC: the real sky near the snapshot, not the simulated year.`,
              facts: [{ k: 'NORAD', v: String(norad), t: 'R' }, { k: 'Shown at', v: `${at} UTC`, t: 'R' }, ...(d?.facts ?? []).map((f) => ({ k: f.k, v: f.v, t: f.t ?? ('R' as const) }))],
              links: [{ label: 'Drag, lifetime and mission (Data → Orbits)', act: 'orbitsat', id: norad }],
            };
          },
          name: (i) => `Observed · NORAD ${this.obsNorads[i] ?? ''}`,
          locate: (i, out) => pointWorld(pts, i, out),
        });
        addGpuSet({ kind: 'obssat', points: pts, prio: 3, minLum: 0.05, pickPx: 6 });
      }
    }
  }

  frame(t: number): void {
    if (this.sim) this.sim.pts.rotation.y = t * 0.05;
  }

  dispose(orbit: THREE.Group, inertial: THREE.Group): void {
    if (this.sim) { orbit.remove(this.sim.pts); this.sim.pts.geometry.dispose(); }
    if (this.obs) { inertial.remove(this.obs.pts); this.obs.pts.geometry.dispose(); }
    this.sim = null; this.obs = null; this.simKey = ''; this.obsVersion = -1;
  }
}
