// Ranges, not point values: lifetimes, stationkeeping demand and survival for a
// spacecraft whose mass, area, drag coefficient and propulsion are uncertain,
// by seeded Monte Carlo over its class prior (classes.ts). Same seed, same
// samples, same answer. Also the February 2022 Starlink validation case.

import type { Ranged } from '../data/provenance.ts';
import { hash01 } from '../sim/rng.ts';
import { CLASSES, type ClassPrior } from './classes.ts';
import { ballistic, circularEquivalentAltKm, meanDensity, simulateLife, type Craft, type LifeResult } from './decay.ts';
import { constantWeather, dayOf, type AtmoMode, type SW, type WeatherFn } from './spaceWeather.ts';
import type { AtmoModel } from './thermosphere.ts';

/** Triangular draw on [low, high] with mode at nominal; u in [0, 1). */
export function triangular(r: Ranged, u: number): number {
  const { low: a, nominal: c, high: b } = r;
  if (b <= a) return c;
  const f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

export function sampleCraft(p: ClassPrior, seed: number, i: number): Craft {
  const u = (k: number) => hash01(seed, i, k);
  const mass = triangular(p.massKg, u(1));
  const prop = p.propulsion ? Math.min(mass * 0.4, triangular(p.propulsion.propellantKg, u(2))) : 0;
  return {
    dryMassKg: mass - prop, propellantKg: prop,
    areaM2: triangular(p.dragAreaM2, u(3)), lowDragFactor: triangular(p.lowDragFactor, u(4)), cd: triangular(p.cd, u(5)),
    thrustN: p.propulsion ? triangular(p.propulsion.thrustN, u(6)) : 0,
    ispS: p.propulsion ? triangular(p.propulsion.ispS, u(7)) : 1, dutyCycle: p.propulsion?.dutyCycle ?? 0,
  };
}

export interface Spread { p10: number; p50: number; p90: number; n: number }
export function spread(xs: number[]): Spread {
  const s = [...xs].sort((a, b) => a - b), q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))];
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), n: s.length };
}

/** Ballistic-coefficient range (kg/m²) for a class in a given attitude, from its prior's extremes. */
export function ballisticRange(p: ClassPrior): { low: number; nominal: number; high: number } {
  const c = (m: number, a: number, cd: number): Craft => ({ dryMassKg: m, propellantKg: 0, areaM2: a, lowDragFactor: 1, cd, thrustN: 0, ispS: 1, dutyCycle: 0 });
  return { low: ballistic(c(p.massKg.low, p.dragAreaM2.high, p.cd.high)), nominal: ballistic(c(p.massKg.nominal, p.dragAreaM2.nominal, p.cd.nominal)), high: ballistic(c(p.massKg.high, p.dragAreaM2.low, p.cd.low)) };
}

export interface LifetimeQuery {
  cls: string; altKm: number; incDeg: number; startDay: number;
  weather: WeatherFn; atmosphere?: AtmoModel; seed: number; n?: number; maxYears?: number;
  /** powered life with stationkeeping (true) or natural decay from altKm (false) */
  powered: boolean;
}

export interface LifetimeAnswer {
  /** years to reentry (Infinity: beyond maxYears) */
  reentryYears: Spread;
  operationalYears: Spread;
  stationkeepingDvPerYear: Spread;
  propellantPerYearKg: Spread;
  samples: LifeResult[];
}

export function lifetimeRange(q: LifetimeQuery): LifetimeAnswer {
  const p = CLASSES[q.cls] ?? CLASSES['generic-leo'];
  const n = q.n ?? 24, out: LifeResult[] = [];
  for (let i = 0; i < n; i++) {
    const craft = sampleCraft(p, q.seed, i);
    const design = triangular(p.designLifeYears, hash01(q.seed, i, 8));
    out.push(simulateLife({
      craft: q.powered ? craft : { ...craft, thrustN: 0, propellantKg: 0 },
      incDeg: q.incDeg, insertAltKm: q.altKm, targetAltKm: q.altKm, designLifeYears: q.powered ? design : 0,
      disposalDvMs: q.powered && craft.thrustN > 0 ? 30 : 0, disposalSucceeds: hash01(q.seed, i, 9) < triangular(p.disposalSuccess, hash01(q.seed, i, 10)),
      startDay: q.startDay, weather: q.weather, atmosphere: q.atmosphere, maxYears: q.maxYears ?? 500,
    }));
  }
  const yrs = (d: number) => d / 365.25;
  return {
    reentryYears: spread(out.map((r) => yrs(r.reentryDay))),
    operationalYears: spread(out.map((r) => yrs(r.operationalDays))),
    stationkeepingDvPerYear: spread(out.map((r) => (r.operationalDays > 1 ? r.stationkeepingDvMs / yrs(r.operationalDays) : 0))),
    propellantPerYearKg: spread(out.map((r) => (r.operationalDays > 1 ? r.propellantUsedKg / Math.max(yrs(r.operationalDays), 1e-3) : 0))),
    samples: out,
  };
}

/** Drag regime label for an altitude and density. */
export function dragRegime(altKm: number, rho: number): string {
  if (altKm > 1500 || rho <= 0) return 'negligible (MEO/GEO: other perturbations dominate, not modelled)';
  if (rho > 1e-10) return 'severe (decays in days to weeks without thrust)';
  if (rho > 1e-12) return 'strong (months to a few years without thrust)';
  if (rho > 1e-14) return 'moderate (years to decades)';
  return 'weak (decades to centuries)';
}

// ---------------------------------------------------------------- validation: Starlink, February 2022

export interface StarlinkCase { lostFraction: number; n: number; meanReentryDays: number; weather: string; insertAltKm: number; perigeeKm: number; apogeeKm: number }

/**
 * 49 satellites deployed on 2022-02-03 into a low insertion orbit (perigee ≈ 210 km),
 * safe mode (edge-on, no thrust) while the storm lasted, then orbit raising to 550 km.
 * Fang et al. (2022): 38 of 49 lost. The model is run on the observed daily Ap/F10.7
 * (GFZ) and on a quiet counterfactual. The 210 × 320 km insertion orbit (perigee and
 * apogee as reported for the launch; the apogee is approximate) is treated at its
 * circular-equivalent drag altitude. What must come out right is the comparison:
 * storm versus quiet, and low versus higher insertion.
 */
export type StormEnhancement = 'model' | 'fang-low' | 'fang-high';
export const ENHANCEMENT_LABEL: Record<StormEnhancement, string> = {
  model: 'calibrated empirical model driven by observed daily Ap',
  'fang-low': 'storm days raised to +50% over pre-storm (Fang et al. 2022, WAM-IPE, low end)',
  'fang-high': 'storm days raised to +125% over pre-storm (Fang et al. 2022, WAM-IPE, high end)',
};

export function starlink2022(observed: WeatherFn, opts: { perigeeKm?: number; apogeeKm?: number; quiet?: boolean; seed?: number; n?: number; atmosphere?: AtmoModel; enhancement?: StormEnhancement } = {}): StarlinkCase {
  const p = CLASSES['starlink-v1.5'];
  const start = Math.floor(dayOf(Date.parse('2022-02-03T18:13:00Z')));
  const weather: WeatherFn = opts.quiet ? constantWeather({ f107: 100, f107a: 100, ap: 5 }) : observed;
  const n = opts.n ?? 49, perigee = opts.perigeeKm ?? 210, apogee = opts.apogeeKm ?? Math.max(perigee, 320);
  const alt = circularEquivalentAltKm(perigee, apogee, 53.2, weather(start), opts.atmosphere);
  // a published enhancement replaces the model's own on the storm days (3–4 Feb) and half of it remains on the 5th, the recovery day
  const target = opts.enhancement === 'fang-low' ? 1.5 : opts.enhancement === 'fang-high' ? 2.25 : 0;
  const pre = meanDensity(alt, 53.2, weather(start - 1));
  const scale = target && !opts.quiet ? (d: number) => {
    const k = Math.floor(d) - start;
    if (k < 0 || k > 2) return 1;
    const own = meanDensity(alt, 53.2, weather(d)) / pre, want = k < 2 ? target : 1 + (target - 1) / 2;
    return Math.max(1, want / own);
  } : undefined;
  let lost = 0, sumDays = 0;
  for (let i = 0; i < n; i++) {
    const craft = sampleCraft(p, opts.seed ?? 2022, i);
    const r = simulateLife({
      craft, incDeg: 53.2, insertAltKm: alt, targetAltKm: 550, commissioningDays: 1, designLifeYears: 5, safeModeAp: 20,
      startDay: start, weather, atmosphere: opts.atmosphere, maxYears: 0.25, densityScale: scale,
    });
    if (r.lostDuringRaising) { lost++; sumDays += r.reentryDay; }
  }
  return { lostFraction: lost / n, n, meanReentryDays: lost ? sumDays / lost : NaN, weather: opts.quiet ? 'quiet counterfactual (Ap 5, F10.7 100)' : `observed (GFZ daily Ap, F10.7); ${ENHANCEMENT_LABEL[opts.enhancement ?? 'model']}`, insertAltKm: alt, perigeeKm: perigee, apogeeKm: apogee };
}

/** Density at a satellite's altitude in each atmosphere mode, for the inspector. */
export function densityByMode(altKm: number, incDeg: number, sw: Record<AtmoMode, SW>): Record<AtmoMode, number> {
  return { quiet: meanDensity(altKm, incDeg, sw.quiet), nominal: meanDensity(altKm, incDeg, sw.nominal), storm: meanDensity(altKm, incDeg, sw.storm) };
}
