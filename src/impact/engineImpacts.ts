// The deep-future impact events the engine rolls, replacing the old fixed
// "asteroid strike" (a flat 0.015%/yr chance that took 10–70% of people and
// capital anywhere). Three systems are kept apart:
//   1. observed historical impacts: history.ts (never rolled; before 2040);
//   2. catalogued objects with official risk: the snapshot's Sentry virtual
//      impactors, each drawn once with its official probability, within the
//      catalogue horizon;
//   3. seeded background impacts at the body's own rate (flux.ts). On Earth,
//      before the catalogue horizon, the share of each size class that is already
//      catalogued is excluded from the background, so a known object is never
//      counted twice.
// Damage follows from the body, the impactor, the place it lands relative to
// each settlement's sites, the warning, and the era's detection and deflection.

import { SENTRY } from '../data/snapshotCore.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';
import { BODIES, genericProfile, type BodyProfile, type Material } from './bodies.ts';
import { damageBoundKm } from './effects.ts';
import { capability, defend, type DefenseOutcome } from './defense.ts';
import { arcKm, sitesOf, spherePoint, type Site } from './exposure.ts';
import { CATALOG_HORIZON_YEAR, completeness2026, impactRate } from './flux.ts';
import { evaluateDraw, sampleInputs, type Draw, type DrawInputs, type ScenarioSpec } from './scenario.ts';

export const D_MIN = 10; // m: smaller bodies cannot harm a settlement
export const D_MAX = 20000;

/**
 * Impact log columns (one row per logged impact or averted impact). The columns from `strength` on are the
 * rest of the draw's inputs and the settlement as it stood, so a replay rebuilds the exact draw (replayDraw)
 * instead of rolling a new one; `stream` is the deterministic key the roll was drawn from.
 */
export const IC = {
  id: 0, year: 1, body: 2, diameterM: 3, density: 4, speedKms: 5, angleDeg: 6, outcome: 7, burstAltKm: 8, craterKm: 9, energyMt: 10,
  deaths: 11, capitalLost: 12, warningYears: 13, flags: 14, source: 15, px: 16, py: 17, pz: 18, kind: 19, popBefore: 20, globalFatality: 21,
  strength: 22, season: 23, material: 24, stage: 25, capitalBefore: 26, orbitalShare: 27, earthU0: 28, earthU1: 29, earthU2: 30, stream: 31,
} as const;
export const NIC = 32;
export const IF = { detected: 1, deflected: 2, evacuated: 4, catalogued: 8, ocean: 16 } as const;
export const OUTCOMES = ['no-atmosphere', 'ground-impact', 'airburst', 'deep-deposition', 'decelerated'] as const;
export const KINDS = ['stony', 'carbonaceous', 'iron', 'cometary'] as const;
export const MATERIAL_LIST: readonly Material[] = ['water', 'sand', 'dry-soil', 'wet-soil', 'soft-rock', 'hard-rock', 'ice'];

export class ImpactLog {
  rows = new Float64Array(NIC * 64);
  n = 0;
  add(): number {
    if ((this.n + 1) * NIC > this.rows.length) { const b = new Float64Array(this.rows.length * 2); b.set(this.rows); this.rows = b; }
    const o = this.n++ * NIC;
    this.rows.fill(0, o, o + NIC);
    return o;
  }
  truncateFrom(year: number): void { while (this.n > 0 && this.rows[(this.n - 1) * NIC + IC.year] >= year) this.n--; }
  upTo(year: number): Float64Array {
    let k = this.n;
    while (k > 0 && this.rows[(k - 1) * NIC + IC.year] > year) k--;
    return this.rows.slice(0, k * NIC);
  }
}

export interface CatalogImpactor { des: string; index: number; year: number; ip: number; diameterM: number; vImpKms: number; energyMt: number | null }

/** Sentry virtual impactors falling inside the simulation (2040 onwards). Each is rolled once with its official probability. */
export function catalogImpactors(fromYear = 2040): CatalogImpactor[] {
  if (!SENTRY) return [];
  const out: CatalogImpactor[] = [];
  let index = 0;
  for (const [des, v] of Object.entries(SENTRY.vi)) {
    const d = Number(v.summary.diameter) * 1000 || 30, vImp = Number(v.summary.v_imp) || Math.hypot(Number(v.summary.v_inf) || 15, 11.19);
    for (const [date, ip, , , energy] of v.vi) {
      const y = Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) - 0.5) / 12;
      if (y >= fromYear) out.push({ des, index: index, year: y, ip, diameterM: d, vImpKms: vImp, energyMt: energy });
      index++;
    }
  }
  return out.sort((a, b) => a.year - b.year);
}

export interface BodyImpactInfo { profile: BodyProfile; rate: number; region: number; opts: Parameters<typeof impactRate>[2]; name: string; sample: (u: number) => number }

/** Inverse of the body's cumulative size distribution on [D_MIN, D_MAX], from a log-spaced table (exact at the nodes, log-linear between). */
function sizeSampler(name: string, opts: Parameters<typeof impactRate>[2]): (u: number) => number {
  const K = 96, lnD: number[] = [], lnN: number[] = [];
  for (let k = 0; k <= K; k++) { const D = D_MIN * (D_MAX / D_MIN) ** (k / K); lnD.push(Math.log(D)); lnN.push(Math.log(impactRate(name, D, opts).perYear)); }
  const nMin = Math.exp(lnN[0]), nMax = Math.exp(lnN[K]);
  return (u) => {
    const t = Math.log(nMin - u * (nMin - nMax));
    let k = 0;
    while (k < K - 1 && lnN[k + 1] > t) k++;
    const f = (t - lnN[k]) / (lnN[k + 1] - lnN[k]);
    return Math.exp(lnD[k] + f * (lnD[k + 1] - lnD[k]));
  };
}

export function bodyImpactInfo(world: World, b: number): BodyImpactInfo {
  const body = world.bodies[b], sys = world.systems[body.system];
  const parent = body.parent >= 0 ? world.bodies[body.parent] : null;
  const opts: NonNullable<Parameters<typeof impactRate>[2]> = { radiusKm: body.radius, gEarth: body.g, kind: body.kind, parent: parent?.name, aKm: parent ? body.a * 1000 : undefined, system: body.system };
  let profile = BODIES[body.name];
  if (!profile || body.system !== 0) {
    const analogue = body.system === 0 ? 'airless'
      : body.kind === 'gas' ? 'jupiter' : body.kind === 'icegiant' ? 'neptune' : body.kind === 'lava' ? 'venus' : body.kind === 'desert' ? 'mars'
        : body.kind === 'ocean' || ((body.kind === 'rocky' || body.kind === 'superearth') && body.hab >= 0.3) ? 'earth'
          : body.kind === 'rocky' || body.kind === 'superearth' ? 'mars' : 'airless';
    profile = genericProfile(body.name, body.radius, body.g, body.kind, analogue);
  }
  (opts as { profile?: BodyProfile }).profile = profile;
  const region = body.system !== 0 ? 3 : body.name === 'Earth' || body.name === 'Moon' ? 0 : body.flux > 0.2 ? 1 : 2;
  void sys;
  return { profile, rate: impactRate(body.name, D_MIN, opts).perYear, region, opts, name: body.name, sample: sizeSampler(body.name, opts) };
}

/**
 * Earth before the catalogue horizon: a background impactor of this size belongs to the already
 * catalogued population with probability equal to the 2026 completeness; those are handled by the
 * Sentry system (each virtual impactor rolled with its official probability), so the background
 * drops them. After the horizon the catalogue predicts nothing and the background keeps everything.
 */
export function belongsToCatalogue(D: number, year: number, u: number): boolean {
  return year < CATALOG_HORIZON_YEAR && u < completeness2026(D);
}

export interface ImpactRoll {
  draw: Draw | null;
  defense: DefenseOutcome;
  diameterM: number;
  deaths: number; capitalLost: number;
  logged: boolean;
  point: [number, number, number];
  /** what the draw was made of, and the settlement it was judged against (logged for exact replay) */
  inputs: DrawInputs | null;
  stage: number; capital: number; orbitalShare: number; stream: number;
}

/**
 * One background impact on body b (the engine has already decided one happens).
 * Uniforms come from hash01(seed, step, body, k) so the engine's own random
 * stream advances by exactly one draw per settlement per step, as before.
 */
export function rollImpact(info: BodyImpactInfo, b: number, seed: number, step: number, year: number, stage: number, pop: number, capital: number, orbitalShare: number, has: (t: string) => boolean, catalogued: { diameterM: number; vImpKms: number } | null = null): ImpactRoll | null {
  const u = (k: number) => hash01(seed, step, b, k);
  const D = catalogued ? catalogued.diameterM : info.sample(u(1));
  if (!catalogued && info.name === 'Earth' && belongsToCatalogue(D, year, u(2))) return null;
  const point = spherePoint(u(3), u(4));
  const p = info.profile;
  // decametre bodies burst high in a substantial atmosphere and do no harm at the ground (Chelyabinsk, 20 m, broke windows)
  if (D < 20 && !catalogued && (p.atmosphere.kind === 'substantial' || p.atmosphere.kind === 'dense')) return null;
  const sites: Site[] = info.name === 'Earth' ? [] : sitesOf(b, stage, pop, capital, p.radiusKm);
  // fast skip: a conservative energy bound (iron density, twice the median speed) against the nearest site
  const vGuess = 2 * (catalogued?.vImpKms ?? Math.hypot(p.vInf.median, p.escapeKms));
  const eGuess = 0.5 * ((4 / 3) * Math.PI * (D / 2) ** 3 * 7800) * (vGuess * 1e3) ** 2;
  if (info.name !== 'Earth' && eGuess < 4.184e19) {
    const bound = damageBoundKm(p, eGuess);
    let near = Infinity;
    for (const s of sites) near = Math.min(near, arcKm(point, s.dir, p.radiusKm) - s.capitalRadiusKm);
    if (near > bound && orbitalShare === 0) return null;
  }
  const spec: ScenarioSpec = {
    body: p, classification: catalogued ? 'hypothetical' : 'simulated', diameterM: [D, D, D], vInfKms: catalogued ? Math.sqrt(Math.max(1, catalogued.vImpKms ** 2 - p.escapeKms ** 2)) : undefined,
    point, sites, orbitalShare, earth: info.name === 'Earth' ? { pop, capital } : undefined, lite: true,
  };
  const inputs = sampleInputs(spec, Math.floor(hash01(seed, step, b, 99) * 2 ** 31), 0);
  // a strict upper bound on the harm from the same draw (no atmosphere, full-energy surface blast) rules out what cannot be notable
  if (!catalogued && info.name !== 'Earth') {
    const x = evaluateDraw(spec, inputs, true).exposure;
    const im = inputs.impactor, e0Mt = (0.5 * ((4 / 3) * Math.PI * (im.diameterM / 2) ** 3 * im.densityKgM3) * (im.speedKms * 1e3) ** 2) / 4.184e15;
    if (x.deaths < 1e-5 * pop && x.capitalLost < 1e-5 * capital && !(pop < 1e6 && x.deaths >= 1) && e0Mt < 1000) return null;
  }
  const draw = evaluateDraw(spec, inputs);
  const kept = { inputs, stage, capital, orbitalShare, stream: step };
  let deaths = Math.min(pop, draw.exposure.deaths), capitalLost = Math.min(capital, draw.exposure.capitalLost);
  // what is worth a record (and worth deflecting): real harm, or a very large event even if it hurt no one.
  // Losses below 0.001% of a large settlement are treated as negligible and not applied.
  const notable = deaths >= 1e-5 * pop || capitalLost >= 1e-5 * capital || draw.fx.energyMt >= 1000 || (pop < 1e6 && deaths >= 1);
  const noDefense: DefenseOutcome = { detected: false, warningYears: 0, deflected: false, evacuated: false, note: '' };
  if (!notable) return { draw, defense: noDefense, diameterM: D, deaths, capitalLost, logged: false, point, ...kept };
  // defenders act on what their surveys predict would do harm
  const defense = defend(D, year, info.region, capability(has), [u(5), u(6), u(7)], !!catalogued);
  if (defense.deflected) return { draw, defense, diameterM: D, deaths: 0, capitalLost: 0, logged: true, point, ...kept };
  if (defense.evacuated && defense.warningYears >= 1) deaths *= 0.05;
  return { draw, defense, diameterM: D, deaths, capitalLost, logged: true, point, ...kept };
}

export function packImpact(log: ImpactLog, id: number, year: number, b: number, r: ImpactRoll, pop: number, source: number): void {
  const o = log.add(), R = log.rows, d = r.draw;
  R[o + IC.id] = id; R[o + IC.year] = year; R[o + IC.body] = b; R[o + IC.diameterM] = r.diameterM;
  R[o + IC.density] = d?.impactor.densityKgM3 ?? NaN; R[o + IC.speedKms] = d?.impactor.speedKms ?? NaN; R[o + IC.angleDeg] = d?.impactor.angleDeg ?? NaN;
  R[o + IC.outcome] = d ? OUTCOMES.indexOf(d.fx.entry.outcome) : -1;
  R[o + IC.burstAltKm] = d?.fx.entry.burstAltKm ?? NaN; R[o + IC.craterKm] = d?.fx.crater ? d.fx.crater.finalM / 1000 : NaN; R[o + IC.energyMt] = d?.fx.energyMt ?? NaN;
  R[o + IC.deaths] = r.deaths; R[o + IC.capitalLost] = r.capitalLost; R[o + IC.warningYears] = r.defense.warningYears;
  R[o + IC.flags] = (r.defense.detected ? IF.detected : 0) | (r.defense.deflected ? IF.deflected : 0) | (r.defense.evacuated ? IF.evacuated : 0) | (source >= 0 ? IF.catalogued : 0) | (d?.ocean ? IF.ocean : 0);
  R[o + IC.source] = source; R[o + IC.px] = r.point[0]; R[o + IC.py] = r.point[1]; R[o + IC.pz] = r.point[2];
  R[o + IC.kind] = d ? KINDS.indexOf(d.impactor.kind) : -1; R[o + IC.popBefore] = pop; R[o + IC.globalFatality] = d?.fx.globalFatality ?? 0;
  const inp = r.inputs;
  R[o + IC.strength] = inp?.impactor.strengthPa ?? NaN; R[o + IC.season] = inp?.season ?? NaN; R[o + IC.material] = inp ? MATERIAL_LIST.indexOf(inp.material) : -1;
  R[o + IC.stage] = r.stage; R[o + IC.capitalBefore] = r.capital; R[o + IC.orbitalShare] = r.orbitalShare;
  R[o + IC.earthU0] = inp?.earthU[0] ?? NaN; R[o + IC.earthU1] = inp?.earthU[1] ?? NaN; R[o + IC.earthU2] = inp?.earthU[2] ?? NaN; R[o + IC.stream] = r.stream;
}

/** One logged row, as the fields a replay needs. */
export function logRow(rows: Float64Array, i: number): Record<keyof typeof IC, number> {
  const out = {} as Record<keyof typeof IC, number>;
  for (const k of Object.keys(IC) as (keyof typeof IC)[]) out[k] = rows[i * NIC + IC[k]];
  return out;
}

/**
 * The exact draw behind a logged impact, rebuilt from its logged inputs and the settlement as it stood:
 * the same evaluation the engine ran (lite integration), so outcome, burst, crater, energy and site losses
 * come out identical. Nothing is drawn again. `trace` adds the display record of the same integration.
 */
export function replayDraw(world: World, row: Record<keyof typeof IC, number>, trace = true): { draw: Draw; spec: ScenarioSpec; info: BodyImpactInfo } | null {
  const b = row.body;
  if (!(b >= 0) || !world.bodies[b] || !(row.material >= 0) || !Number.isFinite(row.density)) return null;
  const info = bodyImpactInfo(world, b), p = info.profile, D = row.diameterM, pop = row.popBefore, capital = row.capitalBefore;
  const point: [number, number, number] = [row.px, row.py, row.pz];
  const earth = info.name === 'Earth';
  const spec: ScenarioSpec = {
    body: p, classification: row.source >= 0 ? 'hypothetical' : 'simulated', diameterM: [D, D, D], point,
    sites: earth ? [] : sitesOf(b, row.stage, pop, capital, p.radiusKm), orbitalShare: row.orbitalShare,
    earth: earth ? { pop, capital } : undefined, lite: true, trace,
  };
  const inputs: DrawInputs = {
    impactor: { diameterM: D, densityKgM3: row.density, speedKms: row.speedKms, angleDeg: row.angleDeg, strengthPa: row.strength, kind: KINDS[row.kind] ?? 'stony' },
    point, material: MATERIAL_LIST[row.material], ocean: !!(row.flags & IF.ocean), season: row.season, vImpKms: row.speedKms,
    earthU: [row.earthU0, row.earthU1, row.earthU2],
  };
  return { draw: evaluateDraw(spec, inputs), spec, info };
}
