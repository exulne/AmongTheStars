// Earth's neutral atmosphere, 0–1,000 km, for drag. NASA/NRL's NRLMSIS 2.0
// (Emmert et al. 2021, doi:10.1029/2020EA001321) is the scientific reference;
// this is a compact physical model calibrated against it, not a port of it:
//
// - Above 120 km: diffusive equilibrium of N2, O2, O, He, Ar and H over the
//   Bates (1959) temperature profile T(ξ) = T∞ − (T∞ − T120)·e^(−sξ) in
//   geopotential height ξ, integrated analytically (Walker 1965). The exospheric
//   temperature T∞ follows Jacchia's (1971) form: a solar term in the 81-day and
//   daily F10.7, a day/night bulge peaking mid-afternoon, and a geomagnetic
//   heating term in Ap. The 120 km densities vary with solar activity, and
//   helium with season (winter bulge).
// - Below 120 km: the US Standard Atmosphere 1976 table, joined smoothly.
//
// The free coefficients (THERMO_FIT) are fitted to the NRLMSIS 2.0 reference
// outputs (scripts/msis-calibrate.ts, research/data/nrlmsis2.0_test_ref_dp.txt),
// which reach 500 km; above that the profile is a physical extrapolation,
// cross-checked against USSA76. Validation statistics are in THERMO_FIT.
// An atmosphere with zero density everywhere is available for tests.

import { THERMO_FIT } from './thermosphereFit.ts';

export const RE_KM = 6356.77; // effective Earth radius used for geopotential height (USSA76)
const G0 = 9.80665, KB = 1.380649e-23, AMU = 1.66053907e-27;

/** species: mass (amu), thermal diffusion factor α */
const SPECIES = [
  { id: 'N2', m: 28.0134, alpha: 0 },
  { id: 'O2', m: 31.9988, alpha: 0 },
  { id: 'O', m: 15.9994, alpha: 0 },
  { id: 'He', m: 4.0026, alpha: -0.38 },
  { id: 'Ar', m: 39.948, alpha: 0 },
  { id: 'H', m: 1.00794, alpha: -0.38 },
] as const;

/** US Standard Atmosphere 1976 mass density, kg/m³ (NOAA/NASA/USAF 1976, Table 1). */
const USSA76: [number, number][] = [
  [0, 1.225], [5, 7.364e-1], [10, 4.135e-1], [15, 1.948e-1], [20, 8.891e-2], [25, 4.008e-2], [30, 1.841e-2], [35, 8.463e-3],
  [40, 3.996e-3], [45, 1.966e-3], [50, 1.027e-3], [55, 5.681e-4], [60, 3.097e-4], [65, 1.632e-4], [70, 8.283e-5], [75, 3.992e-5],
  [80, 1.846e-5], [85, 8.220e-6], [90, 3.416e-6], [95, 1.393e-6], [100, 5.604e-7], [105, 2.325e-7], [110, 9.708e-8], [115, 4.289e-8],
  [120, 2.222e-8], [130, 8.152e-9], [140, 3.831e-9], [150, 2.076e-9], [160, 1.233e-9], [180, 5.194e-10], [200, 2.541e-10],
  [250, 6.073e-11], [300, 1.916e-11], [350, 7.014e-12], [400, 2.803e-12], [450, 1.184e-12], [500, 5.215e-13], [600, 1.137e-13],
  [700, 3.070e-14], [800, 1.136e-14], [900, 5.759e-15], [1000, 3.561e-15],
];
export const USSA76_TABLE: readonly (readonly [number, number])[] = USSA76;

export function ussa76(altKm: number): number {
  if (altKm <= 0) return USSA76[0][1];
  if (altKm >= 1000) return USSA76[USSA76.length - 1][1] * Math.exp(-(altKm - 1000) / 600);
  let i = 0;
  while (USSA76[i + 1][0] < altKm) i++;
  const [z0, r0] = USSA76[i], [z1, r1] = USSA76[i + 1];
  return Math.exp(Math.log(r0) + ((altKm - z0) / (z1 - z0)) * (Math.log(r1) - Math.log(r0)));
}

export interface AtmoInput {
  altKm: number;
  /** daily F10.7 (sfu) and its 81-day centred mean */
  f107: number; f107a: number;
  /** daily planetary Ap */
  ap: number;
  /** geodetic latitude (deg), local solar time (h), day of year */
  latDeg?: number; lstH?: number; doy?: number;
}

/** Coefficient vector order (see THERMO_FIT.names). */
export type ThermoCoeffs = readonly number[];

/** Exospheric temperature (K). */
export function exoTemp(c: ThermoCoeffs, q: AtmoInput): number {
  const [c0, c1, c2, dAmp, dPhase, gHeat] = c;
  const lat = ((q.latDeg ?? 0) * Math.PI) / 180;
  const lst = q.lstH ?? 14;
  const tc = c0 + c1 * q.f107a + c2 * (q.f107 - q.f107a);
  // day/night bulge: broad maximum mid-afternoon, weaker at high latitude
  const diurnal = 1 + dAmp * Math.cos(lat) * Math.cos(((lst - dPhase) / 24) * 2 * Math.PI);
  // geomagnetic heating: linear at high Ap, steeper at low Ap (Jacchia 1977 form)
  const geo = gHeat * (q.ap + 100 * (1 - Math.exp(-0.08 * q.ap)));
  return tc * diurnal + geo;
}

/** Number densities (m⁻³) of each species at altitude ≥ 120 km. */
export function speciesAt(c: ThermoCoeffs, q: AtmoInput, z: number): number[] {
  const [, , , , , , t120, sShape, n2b, n2f, o2b, ob, of, heb, hef, hes, arb, hb, apN] = c;
  const tInf = Math.max(t120 + 50, exoTemp(c, q));
  const xi = ((z - 120) * (RE_KM + 120)) / (RE_KM + z); // km of geopotential height above 120 km
  const s = sShape; // per km
  const a = (tInf - t120) / tInf;
  const g120 = G0 * (RE_KM / (RE_KM + 120)) ** 2;
  const lat = ((q.latDeg ?? 0) * Math.PI) / 180, doy = q.doy ?? 80;
  // helium winter bulge: more helium over the winter pole (northern winter near day 355)
  const season = Math.sin(lat) * Math.cos(((doy + 10) / 365.25) * 2 * Math.PI);
  const fs = (q.f107a - 150) / 100;
  const n120 = [
    10 ** (n2b + n2f * fs + apN * Math.log10(1 + q.ap / 10)),
    10 ** (o2b + n2f * fs),
    10 ** (ob + of * fs),
    10 ** (heb + hef * fs + hes * season),
    10 ** arb,
    10 ** hb,
  ];
  const ratio = (1 - a) / (1 - a * Math.exp(-s * xi)); // T120/T(ξ)
  return SPECIES.map((sp, i) => {
    const gamma = (sp.m * AMU * g120) / (s * 1e-3 * KB * tInf);
    return n120[i] * ratio ** (1 + sp.alpha + gamma) * Math.exp(-s * gamma * xi);
  });
}

/** Mass density (kg/m³) from the calibrated diffusive-equilibrium model, z ≥ 120 km. */
export function thermoDensity(c: ThermoCoeffs, q: AtmoInput, z = q.altKm): number {
  const n = speciesAt(c, q, z);
  let rho = 0;
  for (let i = 0; i < n.length; i++) rho += n[i] * SPECIES[i].m * AMU;
  return rho;
}

export type AtmoModel = 'msis-calibrated' | 'none';

/**
 * Total mass density (kg/m³) at a point. Below 100 km: USSA76. 100–120 km:
 * USSA76 scaled so it meets the thermosphere model at 120 km. Above: the
 * calibrated thermosphere. 'none' is the zero atmosphere.
 */
export function density(q: AtmoInput, model: AtmoModel = 'msis-calibrated'): number {
  if (model === 'none') return 0;
  const z = q.altKm;
  if (z < 100) return ussa76(z);
  if (z < 120) {
    const k = thermoDensity(THERMO_FIT.coeffs, q, 120) / ussa76(120);
    const w = (z - 100) / 20;
    return ussa76(z) * Math.exp(w * Math.log(k));
  }
  return thermoDensity(THERMO_FIT.coeffs, q, z);
}

/** Orbit-averaged density for a circular orbit: mean over local times and the latitudes the orbit visits. */
export function orbitMeanDensity(altKm: number, incDeg: number, f107: number, f107a: number, ap: number, doy = 80, model: AtmoModel = 'msis-calibrated'): number {
  if (model === 'none') return 0;
  const lats = [0, 0.5, 0.85].map((u) => u * Math.min(Math.abs(incDeg), 90));
  let s = 0, n = 0;
  for (const lat of lats) for (let k = 0; k < 8; k++) {
    s += density({ altKm, f107, f107a, ap, latDeg: lat, lstH: k * 3 + 1.5, doy }, model);
    s += lat ? density({ altKm, f107, f107a, ap, latDeg: -lat, lstH: k * 3 + 1.5, doy }, model) : 0;
    n += lat ? 2 : 1;
  }
  return s / n;
}

/** Density scale height (km) at an altitude, from the local logarithmic gradient. */
export function scaleHeight(q: AtmoInput): number {
  const d = 2;
  return (2 * d) / Math.log(density({ ...q, altKm: q.altKm - d }) / density({ ...q, altKm: q.altKm + d }));
}

export const THERMO_SPECIES = SPECIES.map((s) => s.id);
