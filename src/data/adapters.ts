// Versioned source adapters: raw API payloads in, validated compact rows out.
// Network code lives in scripts/ingest.ts; parsing lives here so the same
// checks run at build time and in the tests. Units are normalised on the way in
// (au and km/s from JPL, rev/day and degrees from OMM) and recorded in the
// field lists.

import { arr, num, numStr, obj, opt, str, type Check } from './schema.ts';

export const ADAPTER_VERSION = '1.0.0';

// ---------------------------------------------------------------- CelesTrak GP (OMM)

/** Compact OMM row: everything SGP4 needs plus identity. Epoch is Unix seconds (UTC). */
export const GP_FIELDS = ['norad', 'name', 'objectId', 'epoch', 'meanMotion', 'ecc', 'inc', 'raan', 'argp', 'meanAnomaly', 'bstar', 'ndot', 'nddot'] as const;
export const GP_UNITS = ['', '', 'COSPAR', 's (Unix, UTC)', 'rev/day', '', 'deg', 'deg', 'deg', 'deg', '1/earth radii', 'rev/day²/2', 'rev/day³/6'];
export type GpRow = [number, string, string, number, number, number, number, number, number, number, number, number, number];

const ommCheck = obj({
  OBJECT_NAME: str, OBJECT_ID: str, NORAD_CAT_ID: num, EPOCH: str, MEAN_MOTION: num, ECCENTRICITY: num, INCLINATION: num,
  RA_OF_ASC_NODE: num, ARG_OF_PERICENTER: num, MEAN_ANOMALY: num, BSTAR: num, MEAN_MOTION_DOT: num, MEAN_MOTION_DDOT: num,
  EPHEMERIS_TYPE: opt(num),
});

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
/** OMM epochs are UTC without a zone suffix. */
export const ommEpochSeconds = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) / 1000;

export function adaptGp(raw: unknown): { fields: readonly string[]; units: string[]; rows: GpRow[]; rejected: number } {
  if (!Array.isArray(raw)) throw new Error('GP: expected a JSON array of OMM records');
  const rows: GpRow[] = [];
  let rejected = 0;
  for (let i = 0; i < raw.length; i++) {
    try {
      const o = ommCheck(raw[i], `gp[${i}]`);
      if ((o.EPHEMERIS_TYPE ?? 0) !== 0) { rejected++; continue; } // SGP4 elements only
      if (!(o.MEAN_MOTION > 0) || o.ECCENTRICITY < 0 || o.ECCENTRICITY >= 1) { rejected++; continue; }
      const ep = ommEpochSeconds(o.EPOCH);
      if (!Number.isFinite(ep)) { rejected++; continue; }
      rows.push([o.NORAD_CAT_ID, o.OBJECT_NAME.trim(), o.OBJECT_ID, round(ep, 3), round(o.MEAN_MOTION, 8), round(o.ECCENTRICITY, 7), round(o.INCLINATION, 4), round(o.RA_OF_ASC_NODE, 4), round(o.ARG_OF_PERICENTER, 4), round(o.MEAN_ANOMALY, 4), Number(o.BSTAR.toPrecision(5)), Number(o.MEAN_MOTION_DOT.toPrecision(5)), Number(o.MEAN_MOTION_DDOT.toPrecision(5))]);
    } catch { rejected++; }
  }
  return { fields: GP_FIELDS, units: GP_UNITS, rows, rejected };
}

// ---------------------------------------------------------------- CelesTrak SATCAT

export interface SatcatRecord { name: string; objectId: string; norad: number; type: string; ops: string; owner: string; launch: string; site: string; decay: string | null }
const satcatCheck = obj({ OBJECT_NAME: str, OBJECT_ID: str, NORAD_CAT_ID: num, OBJECT_TYPE: opt(str), OPS_STATUS_CODE: opt(str), OWNER: opt(str), LAUNCH_DATE: str, LAUNCH_SITE: opt(str), DECAY_DATE: opt(str) });
export function adaptSatcat(raw: unknown): SatcatRecord[] {
  return arr(satcatCheck)(raw, 'satcat').map((o) => ({ name: o.OBJECT_NAME, objectId: o.OBJECT_ID, norad: o.NORAD_CAT_ID, type: o.OBJECT_TYPE ?? '', ops: o.OPS_STATUS_CODE ?? '', owner: o.OWNER ?? '', launch: o.LAUNCH_DATE, site: o.LAUNCH_SITE ?? '', decay: o.DECAY_DATE || null }));
}

// ---------------------------------------------------------------- JPL CAD

export interface CadQuery { url: string; [k: string]: string }

/** Bodies the CAD API serves, with progressively wider queries (outer planets see few small bodies). */
export const CAD_BODIES: { name: string; code: string; attempts: Record<string, string>[] }[] = [
  { name: 'Mercury', code: 'Merc', attempts: [{ 'dist-max': '0.05', 'h-max': '20', neo: 'false' }] },
  { name: 'Venus', code: 'Venus', attempts: [{ 'dist-max': '0.05', 'h-max': '20', neo: 'false' }] },
  { name: 'Earth', code: 'Earth', attempts: [{ 'dist-max': '0.05', 'h-max': '22' }] },
  { name: 'Moon', code: 'Moon', attempts: [{ 'dist-max': '0.05', 'h-max': '22' }] },
  { name: 'Mars', code: 'Mars', attempts: [{ 'dist-max': '0.05', 'h-max': '20', neo: 'false' }] },
  { name: 'Jupiter', code: 'Juptr', attempts: [{ 'dist-max': '0.1', 'h-max': '18', neo: 'false' }, { 'dist-max': '0.3', neo: 'false' }] },
  { name: 'Saturn', code: 'Satrn', attempts: [{ 'dist-max': '0.3', neo: 'false' }, { 'dist-max': '1', neo: 'false' }] },
  { name: 'Uranus', code: 'Urnus', attempts: [{ 'dist-max': '0.5', neo: 'false' }, { 'dist-max': '2', neo: 'false' }] },
  { name: 'Neptune', code: 'Neptn', attempts: [{ 'dist-max': '0.5', neo: 'false' }, { 'dist-max': '2', neo: 'false' }] },
  { name: 'Pluto', code: 'Pluto', attempts: [{ 'dist-max': '0.5', neo: 'false' }, { 'dist-max': '2', neo: 'false' }] },
];

/** jd (TDB), dist/dist_min/dist_max (au), v_rel/v_inf (km/s), h (mag), diameter/diameter_sigma (km) */
export const CAD_FIELDS = ['des', 'fullname', 'orbitId', 'jd', 'date', 'dist', 'distMin', 'distMax', 'vRel', 'vInf', 'tSigma', 'h', 'diameter', 'diameterSigma'] as const;
export type CadRow = [string, string, string, number, string, number, number, number, number, number | null, string, number | null, number | null, number | null];

export function adaptCad(raw: unknown, body: string): { fields: readonly string[]; rows: CadRow[] } {
  const r = obj({ fields: opt(arr(str)), data: opt(arr(arr((v) => v as string | null))) })(raw, `cad.${body}`);
  if (!r.fields || !r.data) return { fields: CAD_FIELDS, rows: [] };
  const ix = (k: string) => { const i = r.fields!.indexOf(k); return i; };
  const need = ['des', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel'];
  for (const k of need) if (ix(k) < 0) throw new Error(`cad.${body}: missing field ${k}`);
  const g = (row: (string | null)[], k: string) => (ix(k) >= 0 ? row[ix(k)] : null);
  const rows = r.data.map((row, i): CadRow => {
    const p = `cad.${body}[${i}]`, n = (k: string) => numStr(g(row, k), `${p}.${k}`);
    const dist = n('dist')!, lo = n('dist_min')!, hi = n('dist_max')!;
    if (!(lo <= dist && dist <= hi)) throw new Error(`${p}: 3-sigma bounds out of order`);
    return [str(g(row, 'des'), p), (g(row, 'fullname') ?? '').trim(), g(row, 'orbit_id') ?? '', n('jd')!, str(g(row, 'cd'), p), dist, lo, hi, n('v_rel')!, n('v_inf'), g(row, 't_sigma_f') ?? '', n('h'), n('diameter'), n('diameter_sigma')];
  });
  return { fields: CAD_FIELDS, rows };
}

// ---------------------------------------------------------------- JPL Sentry

/** ip: cumulative impact probability; ps: Palermo scale; ts: Torino scale; diameter km; v_inf km/s */
export const SENTRY_FIELDS = ['des', 'fullname', 'h', 'diameter', 'ip', 'psCum', 'psMax', 'tsMax', 'nImp', 'range', 'vInf', 'lastObs'] as const;
export type SentryRow = [string, string, number | null, number | null, number, number, number, number | null, number, string, number | null, string];

export function adaptSentry(raw: unknown): { fields: string[]; rows: SentryRow[] } {
  const r = obj({ data: arr((v) => v as Record<string, unknown>) })(raw, 'sentry');
  const rows = r.data.map((o, i): SentryRow => {
    const p = `sentry[${i}]`, n = (k: string) => numStr(o[k], `${p}.${k}`);
    return [str(o.des, p), String(o.fullname ?? '').trim(), n('h'), n('diameter'), n('ip')!, n('ps_cum')!, n('ps_max')!, n('ts_max'), Number(o.n_imp ?? 0), String(o.range ?? ''), n('v_inf'), String(o.last_obs ?? '')];
  });
  return { fields: [...SENTRY_FIELDS], rows };
}

export interface SentryVi { summary: Record<string, string | number | null>; vi: [string, number, number, number | null, number | null][] }
/** One object's virtual impactors: [date (TDB), ip, Palermo, Torino, energy (Mt)] */
export function adaptSentryVi(raw: unknown): SentryVi {
  const r = obj({ data: opt(arr((v) => v as Record<string, unknown>)), summary: opt((v) => v as Record<string, unknown>) })(raw, 'sentry-vi');
  const s = r.summary ?? {};
  const keep = ['des', 'fullname', 'h', 'diameter', 'mass', 'v_inf', 'v_imp', 'energy', 'ip', 'ps_cum', 'ts_max', 'n_imp', 'method', 'first_obs', 'last_obs', 'cdate', 'pdate'];
  return {
    summary: Object.fromEntries(keep.map((k) => [k, (s[k] ?? null) as string | number | null])),
    vi: (r.data ?? []).map((o, i) => [str(o.date, `vi[${i}]`), numStr(o.ip, `vi[${i}].ip`)!, numStr(o.ps, `vi[${i}].ps`) ?? NaN, numStr(o.ts, `vi[${i}].ts`), numStr(o.energy, `vi[${i}].energy`)]),
  };
}

/** Small typed accessor for snapshot tables stored as {fields, rows}. */
export function column<T>(t: { fields: readonly string[] }, name: string): (row: unknown[]) => T {
  const i = t.fields.indexOf(name);
  if (i < 0) throw new Error(`no field ${name} (have ${t.fields.join(', ')})`);
  return (row) => row[i] as T;
}

export type { Check };
