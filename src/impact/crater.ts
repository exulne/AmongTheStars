// Crater and solid-body effects, for bodies with a solid surface only. Gas and
// ice giants never reach this module.
//
// Transient crater: Holsapple's π-group scaling in the strength–gravity form
// used by Richardson (2009) and Cratermaker (Minton group; material constants
// from Holsapple 1993 and Kraus et al. 2011):
//   π_V = K1 [ π2 (ρ_t/ρ_i)^(−1/3) + π3^((2+μ)/2) ]^(−3μ/(2+μ)),
//   π2 = g a / U_⊥²,  π3 = Ȳ / (ρ_t U_⊥²),  V = π_V m / ρ_t,  D_tc = 2 (3V/π)^(1/3)
// with U_⊥ = U sin θ (vertical component) and a the impactor radius.
// Final crater: simple craters ×1/0.84 (Melosh 1989); above the gravity-dependent
// simple-to-complex transition D_sc = 10^(A log10 g + B) m (fits to Schenk et
// al. 2021, silicate A = −0.548, B = 4.201; ice A = −0.707, B = 3.523), the
// complex form D_f = 1.02 D_s (D_s/D_sc)^0.079 (Croft 1985, as in Cratermaker).
// Ejecta thickness t(r) = D_tc⁴ / (112 r³) (McGetchin et al. 1973, via Collins
// et al. 2005). Seismic magnitude M = 0.67 log10 E − 5.87 with seismic
// efficiency 1e-4 (Schultz & Gault 1975, via Collins et al. 2005).
// Ejecta faster than v: Housen & Holsapple (2011) point-source scaling.

import type { Material } from './bodies.ts';

export interface MaterialConst { K1: number; mu: number; Ybar: number; density: number; nu: number; ejectaC1: number; ejectaK: number; source: string }

export const MATERIALS: Record<Material, MaterialConst> = {
  water: { K1: 2.3, mu: 0.55, Ybar: 0, density: 1000, nu: 0.4, ejectaC1: 1.5, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker catalogue' },
  sand: { K1: 0.24, mu: 0.41, Ybar: 0, density: 1750, nu: 0.4, ejectaC1: 0.55, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker; ejecta: Housen & Holsapple 2011 (sand)' },
  'dry-soil': { K1: 0.24, mu: 0.41, Ybar: 0.18e6, density: 1500, nu: 0.4, ejectaC1: 0.55, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker' },
  'wet-soil': { K1: 0.2, mu: 0.55, Ybar: 1.14e6, density: 2000, nu: 0.4, ejectaC1: 1.5, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker' },
  'soft-rock': { K1: 0.2, mu: 0.55, Ybar: 7.6e6, density: 2250, nu: 0.4, ejectaC1: 1.5, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker' },
  'hard-rock': { K1: 0.2, mu: 0.55, Ybar: 18e6, density: 2500, nu: 0.4, ejectaC1: 1.5, ejectaK: 0.3, source: 'Holsapple 1993 / Cratermaker' },
  // cold outer-system ice behaves as a non-porous solid (Holsapple 1993: μ ≈ 0.55); strength of order 1 MPa. The Cratermaker 'Ice' constant (K1 = 15.6) gave implausibly large craters here and is not used.
  ice: { K1: 0.2, mu: 0.55, Ybar: 1e6, density: 920, nu: 0.4, ejectaC1: 1.5, ejectaK: 0.3, source: 'Non-porous competent-solid constants (Holsapple 1993) with ice density and ≈1 MPa strength: design choice' },
};

export interface CraterInput { diameterM: number; impactorDensity: number; speedKms: number; angleDeg: number; gravity: number; material: Material; transition: 'silicate' | 'ice' }

export interface Crater {
  transientM: number;
  finalM: number;
  depthM: number;
  morphology: 'simple' | 'complex';
  transitionM: number;
  material: Material;
}

export function transientDiameter(c: CraterInput): number {
  const t = MATERIALS[c.material];
  const a = c.diameterM / 2, m = (4 / 3) * Math.PI * a ** 3 * c.impactorDensity;
  const U = c.speedKms * 1e3 * Math.sin((Math.max(5, c.angleDeg) * Math.PI) / 180);
  const pi2 = (c.gravity * a) / (U * U), pi3 = t.Ybar / (t.density * U * U), pi4 = t.density / c.impactorDensity;
  const piV = t.K1 * (pi2 * pi4 ** (-1 / 3) + pi3 ** ((2 + t.mu) / 2)) ** ((-3 * t.mu) / (2 + t.mu));
  const V = (piV * m) / t.density;
  return Math.max(c.diameterM, 2 * ((3 * V) / Math.PI) ** (1 / 3));
}

export function transitionDiameter(gravity: number, kind: 'silicate' | 'ice'): number {
  const [A, B] = kind === 'ice' ? [-0.7066985617230864, 3.52268633631802] : [-0.5484575694575697, 4.201369948094472];
  return 10 ** (A * Math.log10(gravity) + B);
}

export function crater(c: CraterInput): Crater {
  const Dt = transientDiameter(c), Dsc = transitionDiameter(c.gravity, c.transition);
  const Ds = Dt / 0.84;
  const complex = Ds > Dsc;
  const Df = complex ? 1.02 * Ds * (Ds / Dsc) ** 0.079 : Ds;
  // depth: simple craters ≈ D/5; complex ones shallower (d ≈ 0.2 D_sc^0.7 D^0.3 is a common lunar-style fit)
  const depth = complex ? 0.2 * Dsc ** 0.7 * Df ** 0.3 : Df / 5;
  return { transientM: Dt, finalM: Df, depthM: depth, morphology: complex ? 'complex' : 'simple', transitionM: Dsc, material: c.material };
}

/** Ejecta blanket thickness (m) at distance r (m) from the crater centre; zero inside the rim. */
export function ejectaThickness(transientM: number, rM: number): number {
  if (rM <= transientM / 2) return 0;
  return transientM ** 4 / (112 * rM ** 3);
}

/** Richter-equivalent magnitude of the seismic shaking, and its effective value at a distance (Earth attenuation, Collins et al. 2005 eq. 41). */
export function seismicMagnitude(energyJ: number): number { return 0.67 * Math.log10(Math.max(energyJ, 1)) - 5.87; }
export function effectiveMagnitude(M: number, rKm: number, radiusKm: number): number {
  if (rKm < 60) return M - 0.0238 * rKm;
  if (rKm < 700) return M - 0.0048 * rKm - 1.1644;
  const deg = (rKm / radiusKm) * (180 / Math.PI);
  return M - 1.66 * Math.log10(deg) - 6.399;
}

/** Mass (kg) of ejecta launched faster than v (m/s), Housen & Holsapple 2011 point-source scaling. */
export function ejectaFasterThan(vMs: number, impactorMassKg: number, impactorDensity: number, speedKms: number, material: Material): number {
  const t = MATERIALS[material], U = speedKms * 1e3;
  if (vMs >= U) return 0;
  const f = ((3 * t.ejectaK) / (4 * Math.PI)) * (t.density / impactorDensity) ** (3 * t.nu - 1) * t.ejectaC1 ** (3 * t.mu) * (vMs / U) ** (-3 * t.mu);
  return Math.min(impactorMassKg * f, impactorMassKg * 1e3);
}
