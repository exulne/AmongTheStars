// The encounter-to-consequence pipeline for one body:
//  1. object properties with their uncertainty (diameter, density, composition, strength)
//  2. target body and its profile
//  3. body-relative speed: v_imp = √(v∞² + v_esc²) (gravitational focusing also raises
//     the encounter rate by 1 + v_esc²/v∞², used in flux.ts)
//  4. entry angle from the isotropic distribution, P(θ) ∝ sin 2θ (Shoemaker 1962)
//  5. the body's atmosphere (entry.ts) or none
//  6. break-up, airburst, deep deposition or ground impact
//  7. effects by body class (effects.ts)
//  8. spatial exposure of settlements and orbital habitats (exposure.ts)
//  9. low / nominal / high from a seeded Monte Carlo (10th, 50th, 90th percentiles)
// Same seed, same draws, same answer.

import type { Classification } from '../data/provenance.ts';
import { hash01 } from '../sim/rng.ts';
import { BODIES, type BodyProfile, type Material } from './bodies.ts';
import { effects, type Effects } from './effects.ts';
import { COMPOSITION, strengthLaw, type Impactor } from './entry.ts';
import { earthExposure, siteExposure, spherePoint, type Exposure, type Site } from './exposure.ts';

export type Composition = keyof typeof COMPOSITION;

export interface ScenarioSpec {
  body: string | BodyProfile;
  classification: Classification;
  /** diameter (m): nominal, with a low–high range (e.g. from H and the albedo range) */
  diameterM: [number, number, number];
  composition?: Composition | 'unknown';
  /** v∞ relative to the body, km/s (from the close-approach data) or undefined for the body's distribution */
  vInfKms?: number;
  /** fixed entry angle (deg), else drawn */
  angleDeg?: number;
  /** fixed impact point (unit vector), else drawn uniformly */
  point?: [number, number, number];
  /** settlement sites on the body, and the share of its people in orbit */
  sites?: Site[];
  orbitalShare?: number;
  /** Earth only: people and capital for the statistical exposure */
  earth?: { pop: number; capital: number };
  label?: string;
  /** engine use: skip the deposition profile and track */
  lite?: boolean;
}

export interface Draw { impactor: Impactor; point: [number, number, number]; material: Material; ocean: boolean; fx: Effects; exposure: Exposure; vImpKms: number }

export function profileOf(b: string | BodyProfile): BodyProfile {
  if (typeof b !== 'string') return b;
  const p = BODIES[b];
  if (!p) throw new Error(`no profile for ${b}`);
  return p;
}

function logTri([lo, mid, hi]: [number, number, number], u: number): number {
  // triangular in log space: diameter ranges are multiplicative
  const a = Math.log(lo), c = Math.log(mid), b = Math.log(hi);
  if (b <= a) return mid;
  const f = (c - a) / (b - a);
  return Math.exp(u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)));
}

export interface DrawInputs { impactor: Impactor; point: [number, number, number]; material: Material; ocean: boolean; season: number; vImpKms: number; earthU: [number, number, number] }

/** The random inputs of draw i: everything uncertain about the impactor and where it lands. */
export function sampleInputs(spec: ScenarioSpec, seed: number, i: number): DrawInputs {
  const p = profileOf(spec.body);
  const u = (k: number) => hash01(seed, i, k);
  const D = logTri(spec.diameterM, u(1));
  // composition: given, or drawn from the NEO mix (comets for the giants and their moons)
  const giantSide = p.cls === 'gas-giant' || p.cls === 'ice-giant' || p.vInf.median < 6;
  let kind: Composition;
  if (spec.composition && spec.composition !== 'unknown') kind = spec.composition;
  else if (giantSide) kind = 'cometary';
  else { const x = u(2); kind = x < 0.6 ? 'stony' : x < 0.9 ? 'carbonaceous' : x < 0.95 ? 'iron' : 'cometary'; }
  const [dl, dm, dh] = COMPOSITION[kind].density;
  const rho = logTri([dl, dm, dh], u(3));
  // bulk strength: the Collins et al. law with an order-of-magnitude spread each way (Popova et al. 2011 find 0.1–1 MPa for fireballs; some bodies are far stronger)
  const strength = strengthLaw(rho) * 10 ** (2 * u(4) - 1);
  const vInf = spec.vInfKms ?? p.vInf.median * Math.exp(p.vInf.logSd * gaussian(u(5), u(6)));
  const vImp = Math.hypot(vInf, p.escapeKms);
  const angle = spec.angleDeg ?? (Math.asin(Math.sqrt(u(7))) * 180) / Math.PI;
  const point = spec.point ?? spherePoint(u(8), u(9));
  // what it lands on: by surface share
  let x = u(10), material: Material = p.materials[0]?.m ?? 'dry-soil';
  for (const m of p.materials) { if (x < m.share) { material = m.m; break; } x -= m.share; }
  const ocean = p.name === 'Earth' && material === 'water';
  return { impactor: { diameterM: D, densityKgM3: rho, speedKms: vImp, angleDeg: angle, strengthPa: strength, kind }, point, material, ocean, season: 2 * u(11) - 1, vImpKms: vImp, earthU: [ocean ? 0.99 : u(12) * 0.29, u(13), u(14)] };
}

/** Effects and exposure for given inputs. `upperBound`: no atmosphere, surface blast at full energy (rules events out cheaply, never in). */
export function evaluateDraw(spec: ScenarioSpec, inp: DrawInputs, upperBound = false): Draw {
  const p = profileOf(spec.body);
  const fx = effects(p, inp.impactor, { material: inp.material, ocean: inp.ocean, season: inp.season, lite: spec.lite, upperBound });
  const exposure = spec.earth ? earthExposure(fx, spec.earth.pop, spec.earth.capital, inp.earthU)
    : siteExposure(fx, spec.sites ?? [], inp.point, p.radiusKm, spec.orbitalShare ?? 0);
  return { impactor: inp.impactor, point: inp.point, material: inp.material, ocean: inp.ocean, fx, exposure, vImpKms: inp.vImpKms };
}

export function drawOne(spec: ScenarioSpec, seed: number, i: number): Draw {
  return evaluateDraw(spec, sampleInputs(spec, seed, i));
}

function gaussian(u: number, v: number): number { return Math.sqrt(-2 * Math.log(Math.max(1e-12, u))) * Math.cos(2 * Math.PI * v); }

export interface Band { p10: number; p50: number; p90: number }
const band = (xs: number[]): Band => {
  const s = [...xs].sort((a, b) => a - b), q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))] ?? NaN;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
};

export interface ScenarioResult {
  spec: ScenarioSpec;
  body: BodyProfile;
  n: number; seed: number;
  energyMt: Band;
  outcomes: Record<string, number>;
  burstAltKm: Band | null;
  craterKm: Band | null;
  plumeKm: Band | null;
  scarKm: Band | null;
  deaths: Band;
  capitalLost: Band;
  /** the median draw, kept whole for display (energy deposition profile, notes) */
  median: Draw;
  limitations: string[];
}

export function runScenario(spec: ScenarioSpec, seed: number, n = 120): ScenarioResult {
  const body = profileOf(spec.body);
  const draws: Draw[] = [];
  for (let i = 0; i < n; i++) draws.push(drawOne(spec, seed, i));
  const outcomes: Record<string, number> = {};
  for (const d of draws) outcomes[d.fx.entry.outcome] = (outcomes[d.fx.entry.outcome] ?? 0) + 1 / n;
  const bursts = draws.filter((d) => d.fx.entry.burstAltKm !== null).map((d) => d.fx.entry.burstAltKm!);
  const craters = draws.filter((d) => d.fx.crater).map((d) => d.fx.crater!.finalM / 1000);
  const plumes = draws.filter((d) => d.fx.plume).map((d) => d.fx.plume!.plumeHeightKm[1]);
  const scars = draws.filter((d) => d.fx.plume && d.fx.plume.scarDiameterKm[1] > 0).map((d) => d.fx.plume!.scarDiameterKm[1]);
  const byE = [...draws].sort((a, b) => a.fx.energyMt - b.fx.energyMt);
  return {
    spec, body, n, seed,
    energyMt: band(draws.map((d) => d.fx.energyMt)),
    outcomes,
    burstAltKm: bursts.length ? band(bursts) : null,
    craterKm: craters.length ? band(craters) : null,
    plumeKm: plumes.length ? band(plumes) : null,
    scarKm: scars.length ? band(scars) : null,
    deaths: band(draws.map((d) => d.exposure.deaths)),
    capitalLost: band(draws.map((d) => d.exposure.capitalLost)),
    median: byE[Math.floor(n / 2)],
    limitations: limitationsFor(body),
  };
}

export function limitationsFor(b: BodyProfile): string[] {
  const l = [
    'A one-dimensional break-up ("pancake") model with straight-line flight; it ranks outcomes and shows where energy goes, but is not NASA ATAP-grade physics.',
    'Vulnerability curves are simplified steps after Glasstone & Dolan (1977) and Rumpf et al. (2017).',
  ];
  if (b.name === 'Earth') l.push('Earth exposure is statistical (land/ocean, urban/rural density, coastline): this simulation does not map Earth’s geography.');
  if (b.cls === 'gas-giant' || b.cls === 'ice-giant') l.push('Giants: plume and scar sizes are scaled from Shoemaker–Levy 9; deep-atmosphere structure below 1 bar is a dry adiabat.');
  if (b.cls === 'airless') l.push('Seismic attenuation uses Earth’s relation; ejecta-in-orbit risk is a one-crossing fluence estimate.');
  if (b.name === 'Mars') l.push('Mars atmosphere: fact-sheet mean with a ±12% seasonal swing; dust storms and Mars-GRAM variability are not modelled.');
  if (b.name === 'Venus') l.push('Venus profile: approximate VIRA mean; thermal and chemical effects in the deep atmosphere are not modelled.');
  return l;
}
