// Display propagation of observed satellites: SGP4 on CelesTrak GP mean
// elements (OMM keywords), via satellite.js (MIT; Vallado et al. 2006 SGP4).
// Nothing else touches these positions. In particular no custom drag is added:
// the fitted elements (mean motion and its derivatives, B*) already carry the
// drag each object actually felt, and adding a second drag force would count
// it twice. This module must not import the decay or thermosphere models
// (scripts/orbit-check.ts checks that).
//
// GP elements are only good near their epoch. Every position is returned with
// its element-set age and a validity level, and a position far from the epoch
// is labelled illustrative, never "current".

import { json2satrec, propagate, type OMMJsonObject, type SatRec } from 'satellite.js';
import type { GpRow } from '../data/adapters.ts';

export const EARTH_RADIUS_KM = 6378.137;
const MU_KM = 398600.4418;

export function toOmm(r: GpRow): OMMJsonObject {
  return {
    OBJECT_NAME: r[1], OBJECT_ID: r[2], EPOCH: new Date(r[3] * 1000).toISOString().replace('Z', ''), MEAN_MOTION: r[4], ECCENTRICITY: r[5], INCLINATION: r[6],
    RA_OF_ASC_NODE: r[7], ARG_OF_PERICENTER: r[8], MEAN_ANOMALY: r[9], EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: r[0], ELEMENT_SET_NO: 999,
    BSTAR: r[10], MEAN_MOTION_DOT: r[11], MEAN_MOTION_DDOT: r[12],
  };
}

export function satrecOf(r: GpRow): SatRec | null {
  try { return json2satrec(toOmm(r)); } catch { return null; }
}

/** TEME position (km) at a time, or null if SGP4 reports an error (decayed, bad elements). */
export function positionKm(rec: SatRec, at: Date): [number, number, number] | null {
  const pv = propagate(rec, at);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const p = pv.position as { x: number; y: number; z: number };
  return Number.isFinite(p.x) ? [p.x, p.y, p.z] : null;
}

export type AgeLevel = 'fresh' | 'aging' | 'stale' | 'invalid';
export const AGE_LABEL: Record<AgeLevel, string> = {
  fresh: 'Within 3 days of the element-set epoch: SGP4 positions good to a few km in LEO.',
  aging: '3–14 days from epoch: LEO errors grow to tens of km; position approximate.',
  stale: '14–60 days from epoch: position illustrative only.',
  invalid: 'More than 60 days from epoch: not shown as a position. Elements this old say nothing about where the object is now.',
};

/** How trustworthy a GP-propagated position is, from the time since epoch (days). LEO degrades fastest; this uses the LEO thresholds for all. */
export function ageLevel(ageDays: number): AgeLevel {
  const a = Math.abs(ageDays);
  return a <= 3 ? 'fresh' : a <= 14 ? 'aging' : a <= 60 ? 'stale' : 'invalid';
}

/** Mean-element orbit summary: semi-major axis, perigee and apogee altitudes, period. */
export function orbitOf(r: GpRow): { smaKm: number; perigeeKm: number; apogeeKm: number; periodMin: number; incDeg: number } {
  const n = (r[4] * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU_KM / (n * n));
  return { smaKm: a, perigeeKm: a * (1 - r[5]) - EARTH_RADIUS_KM, apogeeKm: a * (1 + r[5]) - EARTH_RADIUS_KM, periodMin: 1440 / r[4], incDeg: r[6] };
}
