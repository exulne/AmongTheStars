// Catalogued small bodies near each world, from the snapshot, and the rule
// that separates close approaches from impact probabilities:
//   - A close approach (JPL CAD) is a nominal miss distance with 3-sigma bounds.
//     It is NOT an impact probability and is never converted into one here.
//   - Earth: official impact probabilities, Palermo and Torino values come from
//     JPL Sentry for this retrieval only. They change as observations arrive and
//     objects are routinely removed.
//   - Other bodies: "No official impact probability available", unless a named
//     authoritative source published one (OFFICIAL_NON_EARTH), shown with its date
//     and its current status.
// A derived probability for other worlds would need orbit covariance, virtual-
// impactor sampling and n-body propagation with planetary ephemerides; none of
// that is implemented, so none is shown.

import { CAD, SBDB, SENTRY } from '../data/snapshot.ts';
import type { CadRow, SentryRow } from '../data/adapters.ts';
import type { Classification, Provenance } from '../data/provenance.ts';

export const AU_KM = 149597870.7;

/** Diameter (km) from absolute magnitude and albedo: D = 1329/√p · 10^(−H/5) (Pravec & Harris 2007). */
export const diameterFromH = (H: number, albedo: number) => (1329 / Math.sqrt(albedo)) * 10 ** (-H / 5);

export interface Approach {
  body: string; des: string; name: string; jd: number; date: string;
  distKm: number; distMinKm: number; distMaxKm: number;
  vRelKms: number; vInfKms: number | null; tSigma: string;
  h: number | null;
  /** diameter in metres: measured if available, else from H with albedo 0.25–0.05 */
  diameterM: [number, number, number];
  diameterBasis: 'measured' | 'from H (albedo 0.05–0.25)' | 'unknown';
  past: boolean;
  classification: Classification;
}

export function approaches(body: string, nowJd = jdOf(Date.parse(CAD?.provenance.retrieved ?? '2026-10-25'))): Approach[] {
  const b = CAD?.bodies[body];
  if (!b) return [];
  return b.rows.map((r: CadRow) => {
    const [des, full, , jd, date, dist, lo, hi, vRel, vInf, tSig, h, dKm, dSig] = r;
    let diameterM: [number, number, number], basis: Approach['diameterBasis'];
    if (dKm) { const s = dSig ?? dKm * 0.1; diameterM = [Math.max(1, (dKm - s) * 1000), dKm * 1000, (dKm + s) * 1000]; basis = 'measured'; }
    else if (h !== null) { diameterM = [diameterFromH(h, 0.25) * 1000, diameterFromH(h, 0.14) * 1000, diameterFromH(h, 0.05) * 1000]; basis = 'from H (albedo 0.05–0.25)'; }
    else { diameterM = [NaN, NaN, NaN]; basis = 'unknown'; }
    const past = jd < nowJd;
    return { body, des, name: full || des, jd, date, distKm: dist * AU_KM, distMinKm: lo * AU_KM, distMaxKm: hi * AU_KM, vRelKms: vRel, vInfKms: vInf, tSigma: tSig, h, diameterM, diameterBasis: basis, past, classification: past ? 'historical' : 'scheduled' };
  });
}

export interface OfficialRisk {
  body: string; des: string; name: string;
  /** cumulative impact probability, Palermo (cumulative, max), Torino (max) */
  ip: number; psCum: number; psMax: number; tsMax: number | null;
  nImp: number; range: string; diameterM: number | null; vInfKms: number | null; lastObs: string;
  source: Provenance;
  status: 'current' | 'superseded';
  note: string;
}

export function sentryRisks(): OfficialRisk[] {
  if (!SENTRY) return [];
  const prov: Provenance = { organization: 'NASA/JPL CNEOS Sentry', url: 'https://cneos.jpl.nasa.gov/sentry/', retrieved: SENTRY.provenance.retrieved, version: SENTRY.provenance.sources[0]?.version, basis: 'reported', quality: 'high', note: 'Earth only; changes as new observations constrain the orbit.' };
  return SENTRY.rows.map((r: SentryRow) => ({
    body: 'Earth', des: r[0], name: r[1] || r[0], ip: r[4], psCum: r[5], psMax: r[6], tsMax: r[7], nImp: r[8], range: r[9], diameterM: r[3] !== null ? r[3] * 1000 : null, vInfKms: r[10], lastObs: r[11],
    source: prov, status: 'current', note: '',
  }));
}

/** Published non-Earth assessments by an authoritative source, with what has happened to them since. */
export const OFFICIAL_NON_EARTH: OfficialRisk[] = [
  {
    body: 'Moon', des: '2024 YR4', name: '2024 YR4', ip: 0.043, psCum: NaN, psMax: NaN, tsMax: null, nImp: 1, range: '2032-2032', diameterM: 60, vInfKms: null, lastObs: '2025-06',
    source: { organization: 'NASA Planetary Defense blog (CNEOS)', url: 'https://science.nasa.gov/blogs/planetary-defense/2025/06/05/nasas-webb-observations-update-asteroid-2024-yr4s-lunar-impact-odds/', retrieved: '2026-10-25T00:00:00Z', basis: 'reported', quality: 'high', note: 'Published 2025-06-05: lunar impact probability for 2032-12-22 raised from 3.8% to 4.3% after JWST observations.' },
    status: 'superseded',
    note: 'Superseded: JWST astrometry in February 2026 placed the 2032 pass about 22,900 km from the Moon’s centre (1σ ≈ 800 km), ruling out an impact; NASA said so on 2026-03-05. Shown as a historical official assessment, not a current risk.',
  },
];

export function officialFor(body: string, des: string): OfficialRisk | null {
  if (body === 'Earth') return sentryRisks().find((r) => r.des === des) ?? null;
  return OFFICIAL_NON_EARTH.find((r) => r.body === body && r.des === des) ?? null;
}

export const NO_OFFICIAL = 'No official impact probability available. This is a close approach (a nominal miss distance with 3-sigma bounds), not an impact prediction.';
export const SENTRY_NOTE = 'Sentry probabilities are Earth-only and change often: new observations usually shrink the uncertainty and remove an object from the risk list.';

export function jdOf(ms: number): number { return ms / 86400000 + 2440587.5; }
export function sbdbFor(des: string) { return SBDB?.objects[des] ?? null; }
