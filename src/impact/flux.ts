// Body-specific impact rates for deep-future background events. Every rate is
// a documented, sourced number with a range; no single "asteroid probability"
// is shared across worlds.
//
// Earth: cumulative impact frequency N(>D) per year, from Brown et al. (2002,
//   Nature 420:294; bolide energies, metre to ~50 m) and Harris & Chodas (2021,
//   Icarus 365:114452; ≈ 940 NEAs above 1 km, ≈ 25,000 above 140 m, impact
//   probability ≈ 1.5e-9 per object per year). Log-log interpolation between
//   anchors; factor-of-two range.
// Moon, Mercury, Venus, Mars: the same heliocentric population's unfocused flux
//   per area at 1 au, scaled per body (Mars/Moon flux per area 2.6, range 1.6–4.8:
//   Ivanov 2001 as discussed by JeongAhn & Malhotra 2015; Mercury and Venus
//   ≈ 1, wide ranges), times πR² and the body's gravitational focusing
//   1 + v_esc²/v∞².
// Main belt (Ceres, Vesta, Psyche, Hygiea): intrinsic collision probability
//   2.86e-18 km⁻² yr⁻¹ (Bottke et al. 1994, Icarus 107:255) × R² × N_MB(>D),
//   N_MB(>1 km) ≈ 1.2e6 (Bottke et al. 2005), cumulative slope −2.2 below 1 km.
// Jupiter: Zahnle et al. (2003, Icarus 163:263) 0.005 /yr above 1.5 km
//   (+0.006/−0.003), Hueso et al. (2018, A&A 617:A68) 10–65 /yr above 5–20 m and
//   2.8 /yr at 45 m, 0.43 at 170 m, 0.15 at 380 m. Saturn and Uranus: Zahnle's
//   ratios to Jupiter (0.42, 0.25), Neptune: Uranus analogue.
// Moons of the giants: the planet's flux focused at the moon's orbit,
//   rate_s = rate_P · (R_s/R_P)² · (1 + v_esc,P(a)²/v∞²) / (1 + v_esc,P(R_P)²/v∞²),
//   after Zahnle et al. 2003; gives Enceladus/Saturn ≈ 5e-6 against Zahnle's
//   2.2e-6 and Brasser et al.'s (2025) 5.6e-6.
// Worlds of other stars: no measurement exists. A Solar-System analogue by world
//   type with a ×0.1–×10 range, labelled as an analogue.

import { BODIES, genericProfile, type BodyProfile } from './bodies.ts';

export interface FluxBasis { label: string; source: string; quality: 'high' | 'medium' | 'low'; rangeFactor: number }

/** Earth anchors: [D (m), impacts per year with D ≥ that]. */
export const EARTH_ANCHORS: [number, number][] = [
  [1, 42], [4, 1.0], [10, 0.084], [20, 0.0128], [50, 1.07e-3], [140, 3.75e-5], [1000, 1.4e-6], [10000, 1e-8],
];
/** Jupiter anchors (Hueso et al. 2018 for 10–380 m; Zahnle et al. 2003 Case A for 1 and 1.5 km, as tabulated by Brasser et al. 2025; ≈1e-4 above 10 km). */
export const JUPITER_ANCHORS: [number, number][] = [
  [10, 30], [45, 2.8], [170, 0.43], [380, 0.15], [1000, 7.5e-3], [1500, 0.005], [10000, 1e-4],
];

function loglog(anchors: [number, number][], D: number): number {
  // power-law segments between anchors; beyond either end, the end segment's slope continues
  let i = 0;
  while (i < anchors.length - 2 && D > anchors[i + 1][0]) i++;
  const [d0, n0] = anchors[i], [d1, n1] = anchors[i + 1];
  return n0 * (D / d0) ** (Math.log(n1 / n0) / Math.log(d1 / d0));
}

const focusing = (p: BodyProfile, vInf: number) => 1 + (p.escapeKms / vInf) ** 2;
const EARTH_FOCUS = focusing(BODIES.Earth, BODIES.Earth.vInf.median);
/** unfocused flux at 1 au per km² per year of impactors ≥ D */
const flux1au = (D: number) => loglog(EARTH_ANCHORS, D) / (Math.PI * BODIES.Earth.radiusKm ** 2 * EARTH_FOCUS);

const INNER_SCALE: Record<string, [number, number, number, string]> = {
  Mercury: [1.0, 0.5, 2.0, 'Mercury flux per area relative to 1 au: ≈ 1 (Marchi et al. 2005 find a rate comparable to the Moon’s); wide range'],
  Venus: [1.0, 0.6, 1.6, 'Venus flux per area relative to 1 au: ≈ 1 (no direct measurement); wide range'],
  Earth: [1, 1, 1, ''],
  Moon: [1, 1, 1, 'Same heliocentric population as Earth; Earth’s focusing at the Moon’s distance is negligible'],
  Mars: [2.6, 1.6, 4.8, 'Mars/Moon flux per area 2.6 (range 1.6–4.8: Ivanov 2001; JeongAhn & Malhotra 2015)'],
  Phobos: [2.6, 1.6, 4.8, 'As Mars'],
};
const MAIN_BELT = new Set(['Ceres', 'Vesta', 'Psyche', 'Hygiea']);
const GIANT_RATIO: Record<string, [number, number, number, string]> = {
  Jupiter: [1, 1, 1, 'Zahnle et al. 2003; Hueso et al. 2018'],
  Saturn: [0.42, 0.2, 0.7, 'Zahnle et al. 2003 ratio to Jupiter (Brasser et al. 2025, Table 6)'],
  Uranus: [0.25, 0.1, 0.5, 'Zahnle et al. 2003 ratio to Jupiter (Brasser et al. 2025, Table 6)'],
  Neptune: [0.25, 0.1, 0.6, 'Analogue to Uranus: no published ratio checked'],
};

export interface Rate { perYear: number; low: number; high: number; basis: FluxBasis; vImpKms: number }

/**
 * Impacts per year of objects with diameter ≥ D (m) on a body.
 * `parent`: the planet a moon orbits (with `aKm` its orbital radius), for focusing.
 */
const KUIPER = new Set(['Pluto', 'Haumea', 'Eris', 'Sedna', 'Triton']);

export function impactRate(body: string, D: number, opts: { radiusKm?: number; gEarth?: number; kind?: string; parent?: string; aKm?: number; system?: number; profile?: BodyProfile } = {}): Rate {
  const p = opts.profile ?? BODIES[body] ?? genericProfile(body, opts.radiusKm ?? 1000, opts.gEarth ?? 0.1, opts.kind ?? 'rocky');
  // 1. another star: nothing is measured; a Solar-System analogue by world type, with an honest range
  if ((opts.system ?? 0) !== 0) {
    const giant = opts.kind === 'gas' || opts.kind === 'icegiant';
    const r = giant ? loglog(JUPITER_ANCHORS, D) * (p.radiusKm / BODIES.Jupiter.radiusKm) ** 2 : impactRateSurface(p, D, 1, BODIES.Earth.vInf.median).perYear;
    return { perYear: r, low: r / 10, high: r * 10, vImpKms: giant ? Math.hypot(3, p.escapeKms) : Math.hypot(17, p.escapeKms), basis: { label: 'Analogue (no measurement exists for other stars)', source: 'Solar-System analogue by world type, ×0.1–×10', quality: 'low', rangeFactor: 10 } };
  }
  // 2. the main belt
  if (MAIN_BELT.has(body)) {
    const PI = 2.86e-18, N1 = 1.2e6, slope = D < 1000 ? -2.2 : -2.0;
    const r = PI * p.radiusKm ** 2 * N1 * (D / 1000) ** slope;
    return { perYear: r, low: r / 3, high: r * 3, vImpKms: 5.3, basis: { label: 'Main-belt collisions', source: 'Bottke et al. 1994 (P_i = 2.86e-18 km⁻² yr⁻¹, ⟨v⟩ ≈ 5.3 km/s); Bottke et al. 2005 (N > 1 km ≈ 1.2e6)', quality: 'medium', rangeFactor: 3 } };
  }
  // 3. the giant planets themselves
  if (GIANT_RATIO[body]) {
    const [k, lo, hi, src] = GIANT_RATIO[body];
    const r = loglog(JUPITER_ANCHORS, D) * k;
    return { perYear: r, low: (r * lo) / k / 2.5, high: ((r * hi) / k) * 2.5, vImpKms: Math.hypot(p.escapeKms, p.vInf.median), basis: { label: 'Comet impact rate on a giant planet', source: src, quality: body === 'Neptune' ? 'low' : 'medium', rangeFactor: 2.5 } };
  }
  // 4. moons of the giants: the planet's comets, focused at the moon's orbit
  if (opts.parent && GIANT_RATIO[opts.parent]) {
    const P = BODIES[opts.parent], planet = impactRate(opts.parent, D);
    const vInf = P.vInf.median, a = (opts.aKm ?? 1e6) * 1e3;
    const vEscA = Math.sqrt((2 * P.gm) / a) / 1e3, vOrb = Math.sqrt(P.gm / a) / 1e3;
    const ratio = ((p.radiusKm / P.radiusKm) ** 2 * (1 + (vEscA / vInf) ** 2)) / (1 + (P.escapeKms / vInf) ** 2);
    const r = planet.perYear * ratio;
    return { perYear: r, low: (planet.low * ratio) / 2, high: planet.high * ratio * 2, vImpKms: Math.sqrt(vInf ** 2 + vEscA ** 2 + vOrb ** 2 + p.escapeKms ** 2), basis: { label: `Comets focused by ${opts.parent}`, source: 'Planet rate × geometric and focusing ratio, after Zahnle et al. 2003', quality: 'low', rangeFactor: 5 } };
  }
  // 5. the Kuiper belt and beyond
  if (KUIPER.has(body)) {
    const r = loglog(JUPITER_ANCHORS, D) * 1e-4 * (p.radiusKm / 1188) ** 2;
    return { perYear: r, low: r / 10, high: r * 10, vImpKms: Math.hypot(p.vInf.median, p.escapeKms), basis: { label: 'Kuiper-belt analogue', source: 'Order of magnitude only (Greenstein et al. 2017 discuss Pluto\u2019s cratering rate); ×0.1–×10', quality: 'low', rangeFactor: 10 } };
  }
  // 6. the inner Solar System: NEO flux per area, scaled per body, with the body's own focusing
  const [k, lo, hi, src] = INNER_SCALE[body] ?? [1, 0.5, 2, 'Inner Solar System analogue'];
  const r = impactRateSurface(p, D, k, p.vInf.median);
  const earth = body === 'Earth';
  return { ...r, low: (r.perYear * (lo / k)) / 2, high: r.perYear * (hi / k) * 2, basis: { label: earth ? 'NEO impact frequency' : 'NEO flux scaled to this body', source: earth ? 'Brown et al. 2002; Harris & Chodas 2021' : src, quality: earth ? 'high' : 'medium', rangeFactor: 2 * Math.sqrt(hi / lo) } };
}

function impactRateSurface(p: BodyProfile, D: number, k: number, vInf: number): Rate {
  const r = flux1au(D) * k * Math.PI * p.radiusKm ** 2 * focusing(p, vInf);
  return { perYear: r, low: r / 2, high: r * 2, vImpKms: Math.hypot(vInf, p.escapeKms), basis: { label: '', source: '', quality: 'medium', rangeFactor: 2 } };
}

/** Draw a diameter (m) on [Dmin, Dmax] from the body's cumulative distribution, u ∈ [0, 1). */
export function sampleDiameter(body: string, Dmin: number, Dmax: number, u: number, opts: Parameters<typeof impactRate>[2] = {}): number {
  const nMin = impactRate(body, Dmin, opts).perYear, nMax = impactRate(body, Dmax, opts).perYear;
  const target = nMin - u * (nMin - nMax);
  let lo = Math.log(Dmin), hi = Math.log(Dmax);
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (impactRate(body, Math.exp(m), opts).perYear > target) lo = m; else hi = m; }
  return Math.exp((lo + hi) / 2);
}

// ---------------------------------------------------------------- detection and the known/unknown split

/**
 * Fraction of Earth-approaching objects of diameter D already discovered at the snapshot (2026):
 * ≈ 95% above 1 km and ≈ 38–45% above 140 m (Harris & Chodas 2021; NEO Surveyor
 * known-object model 2023), falling steeply for smaller bodies. Log-linear in D.
 */
const COMPLETENESS: [number, number][] = [[1, 0], [10, 0.002], [20, 0.01], [50, 0.06], [140, 0.4], [300, 0.7], [1000, 0.95], [10000, 0.99]];
export function completeness2026(D: number): number {
  if (D <= COMPLETENESS[0][0]) return 0;
  for (let i = 0; i + 1 < COMPLETENESS.length; i++) {
    const [d0, c0] = COMPLETENESS[i], [d1, c1] = COMPLETENESS[i + 1];
    if (D <= d1) return c0 + ((Math.log(D) - Math.log(d0)) / (Math.log(d1) - Math.log(d0))) * (c1 - c0);
  }
  return 0.99;
}

/**
 * Survey completeness at a calendar year: improves from the 2026 value as surveys continue
 * (NEO Surveyor, Rubin). Design assumption: the undiscovered fraction halves every 15 years
 * for objects ≥ 140 m and every 40 years for 20 m; capability `boost` (0–1) from technology
 * shortens that further. Labelled an assumption in the documentation.
 */
export function completenessAt(D: number, year: number, boost = 0): number {
  const c0 = completeness2026(D), t = Math.max(0, year - 2026);
  const half = (D >= 140 ? 15 : D >= 20 ? 40 : 100) * (1 - 0.8 * boost);
  return 1 - (1 - c0) * 0.5 ** (t / half);
}

/** The catalogue horizon: Sentry looks about 100 years ahead of its retrieval. */
export const CATALOG_HORIZON_YEAR = 2126;
