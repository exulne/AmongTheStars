// Visual scenarios from the pipeline's own results (runs in the worker or in
// the checks, never on the page's frame): the three representative draws of a
// lab scenario, the observed historical cases evaluated once from their
// published values, exact replays of logged engine impacts, and the fixed
// debug cases. Each re-evaluation uses the same inputs as the result it shows,
// with only the display trace switched on.

import type { World } from '../sim/world.ts';
import { BODIES, type BodyProfile, type Material } from './bodies.ts';
import { COMPOSITION, strengthLaw, type Impactor } from './entry.ts';
import { IF, NIC, logRow, replayDraw } from './engineImpacts.ts';
import { arcKm, siteDir, spherePoint, type Site } from './exposure.ts';
import { OBSERVED_IMPACTS } from './history.ts';
import { evaluateDraw, limitationsFor, runScenario, sampleInputs, type Composition, type DrawInputs, type ScenarioResult, type ScenarioSpec } from './scenario.ts';
import { hash01 } from '../sim/rng.ts';
import { asDeflection, fromLatLon, TEXT, visualFromDraw, type Representative, type VisualScenario } from './visual.ts';

export type LocationMode = 'random' | 'near' | 'over' | 'far' | 'latlon';
export interface LocationReq { mode: LocationMode; site?: number; latDeg?: number; lonDeg?: number }

/** An impact point for a location choice, in the body's frame. Null: drawn uniformly by the Monte Carlo. */
export function pointFor(loc: LocationReq | undefined, b: number, sites: Site[], radiusKm: number, seed: number): [number, number, number] | undefined {
  if (!loc || loc.mode === 'random') return undefined;
  if (loc.mode === 'latlon') return fromLatLon(loc.latDeg ?? 0, loc.lonDeg ?? 0);
  if (!sites.length) throw new Error('No simulated settlement on this body at this year: choose a seeded random location or coordinates.');
  const s = sites[Math.max(0, Math.min(sites.length - 1, loc.site ?? 0))];
  if (loc.mode === 'over') return siteDir(b, s.i);
  if (loc.mode === 'near') {
    // a seeded direction, a few footprints plus 50 km from the site's centre
    const ang = (s.capitalRadiusKm * 3 + 50) / radiusKm, th = hash01(seed, 31) * Math.PI * 2;
    const p = s.dir, e = norm(cross([0, 1, 0], p)), n = cross(p, e);
    return norm([p[0] * Math.cos(ang) + (e[0] * Math.cos(th) + n[0] * Math.sin(th)) * Math.sin(ang), p[1] * Math.cos(ang) + (e[1] * Math.cos(th) + n[1] * Math.sin(th)) * Math.sin(ang), p[2] * Math.cos(ang) + (e[2] * Math.cos(th) + n[2] * Math.sin(th)) * Math.sin(ang)]);
  }
  // far: of 256 seeded candidates, the one farthest from every site
  let best: [number, number, number] = [0, 1, 0], bestD = -1;
  for (let i = 0; i < 256; i++) {
    const c = spherePoint(hash01(seed, 41, i), hash01(seed, 42, i));
    const d = Math.min(...sites.map((x) => arcKm(c, x.dir, radiusKm)));
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}
type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export interface LabVisualMeta { snapshotId: string; world: number; year: number; label?: string; banners?: string[]; objectName?: string; popBefore?: number; capitalBefore?: number }

const REP_NOTE: Record<Exclude<Representative, 'single'>, string> = {
  low: 'Low representative: the whole draw at the 10th percentile of impact energy.',
  nominal: 'Nominal representative: the median-energy draw among those with the most likely outcome.',
  high: 'High representative: the whole draw at the 90th percentile of impact energy.',
};

/** The low, nominal and high representative draws of a lab run, each one whole draw re-evaluated with its display trace. */
export function labVisuals(r: ScenarioResult, m: LabVisualMeta): Record<'low' | 'nominal' | 'high', VisualScenario> {
  const spec: ScenarioSpec = { ...r.spec, trace: true };
  const out = {} as Record<'low' | 'nominal' | 'high', VisualScenario>;
  for (const k of ['low', 'nominal', 'high'] as const) {
    const i = r.representatives[k], d = evaluateDraw(spec, sampleInputs(spec, r.seed, i));
    out[k] = visualFromDraw(d, {
      id: `lab:${r.body.name}:${r.seed}:${i}`, classification: 'hypothetical',
      source: { label: 'Hypothetical scenario (Impact Lab)', note: m.label ? `Scenario “${m.label}”.` : 'Custom impactor.' },
      snapshotId: m.snapshotId, seed: r.seed, draw: i, representative: k, representativeNote: `${REP_NOTE[k]} Draw #${i} of ${r.n}; most likely outcome: ${r.representatives.modal}.`,
      body: r.body, world: m.world, when: { year: m.year, date: null, label: `settlements as in ${Math.round(2040 + m.year)}` },
      objectName: m.objectName ?? m.label ?? 'Hypothetical impactor', sites: r.spec.sites, orbitalShare: r.spec.orbitalShare,
      popBefore: m.popBefore, capitalBefore: m.capitalBefore, limitations: r.limitations, banners: m.banners,
      vInfKms: r.spec.vInfKms ?? null,
    });
  }
  return out;
}

const KIND_OF = (rho: number): Impactor['kind'] => (rho >= 5000 ? 'iron' : rho < 1000 ? 'cometary' : rho < 2200 ? 'carbonaceous' : 'stony');

/** One deterministic evaluation of given impactor values on a body: no Monte Carlo, assumptions listed. */
export function singleVisual(o: {
  id: string; body: BodyProfile; world: number; imp: Impactor; material?: Material; ocean?: boolean; point?: V3; seed: number;
  classification: VisualScenario['classification']; source: VisualScenario['source']; when: VisualScenario['when']; objectName: string; snapshotId: string;
  sites?: Site[]; orbitalShare?: number; banners?: string[]; trajectoryLabel?: string;
}): VisualScenario {
  const p = o.body, ocean = !!o.ocean && p.name === 'Earth';
  const point = o.point ?? spherePoint(hash01(o.seed, 8), hash01(o.seed, 9));
  const spec: ScenarioSpec = { body: p, classification: o.classification, diameterM: [o.imp.diameterM, o.imp.diameterM, o.imp.diameterM], point, sites: o.sites ?? [], orbitalShare: o.orbitalShare ?? 0, trace: true };
  const inputs: DrawInputs = { impactor: o.imp, point, material: ocean ? 'water' : o.material ?? p.materials[0]?.m ?? 'dry-soil', ocean, season: 0, vImpKms: o.imp.speedKms, earthU: [ocean ? 0.99 : 0.1, 0.5, 0.5] };
  return visualFromDraw(evaluateDraw(spec, inputs), {
    id: o.id, classification: o.classification, source: o.source, snapshotId: o.snapshotId, seed: o.seed, draw: null, representative: 'single',
    representativeNote: 'A single evaluation of the stated values.', body: p, world: o.world, when: o.when, objectName: o.objectName,
    sites: o.sites, orbitalShare: o.orbitalShare, limitations: limitationsFor(p), banners: o.banners, trajectoryLabel: o.trajectoryLabel,
  });
}

/** An observed historical impact, reconstructed from its published estimates through the same pipeline. */
export function historicalVisual(id: string, world: World, snapshotId: string): VisualScenario | null {
  const c = OBSERVED_IMPACTS.find((x) => x.id === id), p = c ? BODIES[c.body] : null;
  if (!c || !p) return null;
  const assumed: string[] = [];
  const speed = c.speedKms ?? (assumed.push('speed: the body’s typical encounter speed'), Math.hypot(p.vInf.median, p.escapeKms));
  const angle = c.angleDeg ?? (assumed.push('entry angle: 45°, the most probable'), 45);
  const rho = c.densityKgM3 ?? (assumed.push('density: cometary for a giant, stony elsewhere'), p.solidSurface ? COMPOSITION.stony.density[1] : COMPOSITION.cometary.density[1]);
  const seed = [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7) >>> 0;
  if (c.strengthPa) assumed.push(`bulk strength ${(c.strengthPa / 1e6).toFixed(0)} MPa, as the validation case uses`);
  const banners = [`Historical event reconstructed by this model from published estimates (${c.sources.map((s) => s.organization).join('; ')}). Shown at a representative synthetic location: the globe is not a map.`];
  if (assumed.length) banners.push(`Model assumptions: ${assumed.join('; ')}.`);
  if (c.body === 'Jupiter') banners.push(TEXT.sl9);
  return singleVisual({
    id: `hist:${id}`, body: p, world: world.bodies.findIndex((b) => b.name === c.body && b.system === 0), seed,
    imp: { diameterM: c.diameterM[1], densityKgM3: rho, speedKms: speed, angleDeg: angle, kind: KIND_OF(rho), strengthPa: c.strengthPa ?? strengthLaw(rho) },
    material: c.material, classification: 'historical',
    source: { label: c.name, organization: c.sources[0]?.organization, url: c.sources[0]?.url, note: c.observed },
    when: { year: null, date: c.date, label: c.date }, objectName: c.name, snapshotId, banners,
    trajectoryLabel: 'Published speed and angle where known; heading illustrative; straight-line flight.',
  });
}

/** A logged engine impact, exactly as it was drawn (replayDraw), or its deflection. Never re-rolled. */
export function replayVisual(world: World, rows: Float64Array, impactId: number, seed: number, snapshotId: string): VisualScenario | null {
  let at = -1;
  for (let i = 0; i < rows.length / NIC; i++) if (rows[i * NIC] === impactId) { at = i; break; }
  if (at < 0) return null;
  const row = logRow(rows, at), r = replayDraw(world, row);
  if (!r) return null;
  const fl = row.flags, deflected = !!(fl & IF.deflected);
  const b = world.bodies[row.body];
  const defense: VisualScenario['defense'] = {
    detected: !!(fl & IF.detected), warningYears: row.warningYears, deflected, evacuated: !!(fl & IF.evacuated),
    note: deflected ? `Detected ≈ ${row.warningYears.toFixed(0)} years ahead and deflected.` : fl & IF.detected ? `Detected ≈ ${row.warningYears.toFixed(0)} years ahead; not deflected; the area was evacuated.` : 'Not detected before impact: no warning.',
  };
  const raw = Math.min(row.popBefore, r.draw.exposure.deaths);
  const v = visualFromDraw(r.draw, {
    id: `sim:${seed}:${impactId}`, classification: 'simulated',
    source: { label: row.source >= 0 ? 'Catalogued object in this future (Sentry virtual impactor, official probability)' : 'Background impact in this future (seeded)', note: `Replay of logged impact #${impactId}: rebuilt from the logged draw, not re-rolled.` },
    snapshotId, seed, draw: null, representative: null, representativeNote: 'The exact draw the simulation logged.',
    body: r.info.profile, world: row.body, when: { year: row.year, date: null, label: `${Math.round(2040 + row.year)}` },
    objectName: `${Math.round(row.diameterM)} m ${['stony', 'carbonaceous', 'iron', 'cometary'][row.kind] ?? ''} impactor`.trim(),
    sites: r.spec.sites, orbitalShare: row.orbitalShare, popBefore: row.popBefore, capitalBefore: row.capitalBefore,
    applied: { deaths: row.deaths, capitalLost: row.capitalLost, siteFactor: deflected ? 0 : raw > 0 ? (row.deaths / raw) : 1, capitalFactor: deflected ? 0 : 1 },
    defense, limitations: limitationsFor(r.info.profile),
    banners: [`Simulated event on ${b.name} in this future: not a forecast.`],
  });
  return deflected ? asDeflection(v) : v;
}

/** The fixed debug cases (Impact Lab "Known cases" and scripts/impact-viz-check.ts). */
export const DEMO_CASES = ['chelyabinsk', 'barringer', 'moon-100m', 'mars-surface', 'venus-airburst', 'sl9', 'deflection'] as const;
export type DemoCase = (typeof DEMO_CASES)[number] | 'close-approach';

export function demoVisual(name: DemoCase, world: World, snapshotId: string): VisualScenario | null {
  const wi = (n: string) => world.bodies.findIndex((b) => b.name === n && b.system === 0);
  const hyp = (id: string, body: string, D: number, rho: number, v: number, angle: number, seed: number, material?: Material) => singleVisual({
    id: `demo:${id}`, body: BODIES[body], world: wi(body), seed, imp: { diameterM: D, densityKgM3: rho, speedKms: v, angleDeg: angle, kind: KIND_OF(rho), strengthPa: strengthLaw(rho) },
    material, classification: 'hypothetical', source: { label: 'Known test case', note: `${D} m, ${rho} kg/m³, ${v} km/s, ${angle}°.` },
    when: { year: null, date: null, label: 'test case' }, objectName: `${D} m test impactor`, snapshotId,
  });
  if (name === 'chelyabinsk') return historicalVisual('chelyabinsk-2013', world, snapshotId);
  if (name === 'barringer') return historicalVisual('meteor-crater', world, snapshotId);
  if (name === 'sl9') return historicalVisual('sl9-1994', world, snapshotId);
  if (name === 'moon-100m') return hyp('moon-100m', 'Moon', 100, 3000, 20, 45, 101, 'hard-rock');
  if (name === 'mars-surface') return hyp('mars-surface', 'Mars', 30, 3000, 10, 45, 102);
  if (name === 'venus-airburst') return hyp('venus-airburst', 'Venus', 100, 3000, 20, 45, 103);
  if (name === 'deflection') {
    const v = hyp('deflection', 'Earth', 150, 3000, 18, 45, 104);
    return asDeflection({ ...v, defense: { detected: true, warningYears: 12, deflected: true, evacuated: false, note: 'Test case: detected 12 years ahead and deflected (illustrative).' } });
  }
  return null;
}

/** A lab scenario run (worker side): the Monte Carlo bands plus its three representative visual scenarios. */
export function runLab(spec: ScenarioSpec, seed: number, n: number, m: LabVisualMeta): { result: ScenarioResult; visual: ReturnType<typeof labVisuals> } {
  const result = runScenario(spec, seed, n);
  return { result, visual: labVisuals(result, m) };
}

export type { Composition };
