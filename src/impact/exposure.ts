// Who and what is in the way. Settlements are spatial: each one is a set of
// sites at fixed places on its world (the same places the 3D view draws its
// cities: cityDir/cityCount/citySplit in src/view/views.ts), each with a
// footprint sized from its people and stage. An impact point is drawn on the
// sphere and damage is integrated over each footprint, so a strike far from
// every site costs nothing and one on the capital costs a great deal. No
// planet-wide percentage is applied anywhere.
//
// Earth is different: its geography is not mapped in this simulation, so its
// exposure is statistical and still area-based: the impact lands on land (29%)
// or ocean; on land the local density is urban (≈1% of land holds ≈57% of
// people; UN DESA 2018, GHSL) or rural; tsunami losses use the coastline
// density (≈356,000 km of coast, CIA World Factbook) and a 1 km inundation band.

import { hash01 } from '../sim/rng.ts';
import type { Effects } from './effects.ts';

export interface Site { i: number; dir: [number, number, number]; pop: number; capital: number; radiusKm: number; capitalRadiusKm: number }

/** people per km² of built footprint by stage (OUTPOST…UPLOADED); infrastructure (power, mines) spreads capital over 3× the area. Design assumption. */
const DENSITY = [0, 0, 1500, 2500, 4000, 5000, 6000, 8000, 10000, 12000, 12000, 12000, 12000, 12000];

export function siteCount(pop: number): number { return pop < 1000 ? 1 : Math.min(48, Math.ceil(Math.cbrt(pop / 1000))); }

// cached per body in a flat list (a Map lookup per site was a hot spot in whole runs)
const dirs: ([number, number, number] | undefined)[] = [];
/** Same formula as the view's cityDir: unit vector of site i on body b. */
export function siteDir(b: number, i: number): [number, number, number] {
  const k = b * 64 + i;
  return dirs[k] ?? (dirs[k] = siteDirOf(b, i));
}
function siteDirOf(b: number, i: number): [number, number, number] {
  const u = hash01(b, i, 1) * 2 - 1, th = hash01(b, i, 2) * Math.PI * 2, s = Math.sqrt(1 - u * u);
  const x = s * Math.cos(th), y = u * 0.85, z = s * Math.sin(th), n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

export function sitesOf(b: number, stage: number, pop: number, capital: number, bodyRadiusKm: number): Site[] {
  if (!(pop > 0)) return [];
  const n = siteCount(pop), out: Site[] = [];
  const dens = DENSITY[Math.max(0, Math.min(DENSITY.length - 1, stage))] || 3000;
  for (let i = 0; i < n; i++) {
    // the capital holds 30% (as citySplit), the rest share evenly
    const share = n <= 1 ? 1 : i === 0 ? 0.3 : 0.7 / (n - 1);
    const p = pop * share, area = Math.max(0.01, p / dens);
    const r = Math.min(bodyRadiusKm * 0.5, Math.sqrt(area / Math.PI));
    out.push({ i, dir: siteDir(b, i), pop: p, capital: capital * share, radiusKm: r, capitalRadiusKm: Math.min(bodyRadiusKm * 0.5, r * Math.sqrt(3)) });
  }
  return out;
}

/** Great-circle distance (km) between unit vectors on a sphere. */
export function arcKm(a: [number, number, number], b: [number, number, number], radiusKm: number): number {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) * radiusKm;
}

/** Uniform point on the unit sphere from two uniforms. */
export function spherePoint(u: number, v: number): [number, number, number] {
  const z = 2 * u - 1, th = 2 * Math.PI * v, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(th), z, s * Math.sin(th)];
}

/** Area of the intersection of two discs (radii R and r, centres d apart), planar. */
export function overlapArea(d: number, R: number, r: number): number {
  if (R <= 0 || r <= 0) return 0;
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) return Math.PI * Math.min(R, r) ** 2;
  const a = r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r)), b = R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R));
  const c = 0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return a + b - c;
}

/**
 * Exact mean of a piecewise-constant radial damage curve over a footprint disc of
 * radius r whose centre is d km from ground zero: each band between consecutive
 * break radii contributes its value times the share of the footprint inside it.
 */
function discMean(f: (r: number) => number, breaks: number[], d: number, r: number): number {
  if (r <= 0) return f(d);
  const area = Math.PI * r * r;
  let prevR = 0, prevA = 0, s = 0;
  for (const R of breaks) {
    const A = overlapArea(d, R, r);
    if (A > prevA) s += f((prevR + R) / 2) * (A - prevA);
    prevR = R; prevA = A;
  }
  return Math.min(1, s / area);
}

export interface SiteLoss { site: number; distanceKm: number; deaths: number; capitalLost: number }
export interface Exposure { deaths: number; capitalLost: number; sites: SiteLoss[]; orbitalLossFraction: number; note: string }

/**
 * Losses at the sites of one settlement from an impact at `point`. Orbital
 * habitats (share `orbitalShare` of the people) are not hit by surface effects;
 * on airless worlds they face the ejecta thrown into orbit (one-crossing fluence
 * of 1 cm fragments, each lethal to what it hits).
 */
export function siteExposure(fx: Effects, sites: Site[], point: [number, number, number], radiusKm: number, orbitalShare = 0, orbitAltKm = 500): Exposure {
  const out: SiteLoss[] = [];
  let deaths = 0, capital = 0;
  for (const s of sites) {
    const d = arcKm(point, s.dir, radiusKm);
    if (d - Math.max(s.radiusKm, s.capitalRadiusKm) > fx.maxRadiusKm) continue;
    const fat = discMean((r) => fx.damageAt(r).fatality, fx.breaksKm, d, s.radiusKm);
    const cap = discMean((r) => fx.damageAt(r).capital, fx.breaksKm, d, s.capitalRadiusKm);
    const dd = s.pop * (1 - orbitalShare) * fat, cc = s.capital * (1 - orbitalShare) * cap;
    if (dd > 0 || cc > 0) out.push({ site: s.i, distanceKm: d, deaths: dd, capitalLost: cc });
    deaths += dd; capital += cc;
  }
  // ejecta crossing the habitats' altitude. Design assumptions: habitats of this era are shielded (O'Neill-class
  // slag shielding), so only fragments ≥ 10 cm matter and a hit kills 10% of a habitat's people; events lofting less
  // than 1e9 kg above the habitats are stopped by shielding. Fragments spread over the sphere and cross it twice.
  let orbitalLoss = 0;
  if (fx.orbitalEjectaKg + fx.escapingEjectaKg > 1e9 && orbitalShare > 0) {
    const frag = (4 / 3) * Math.PI * 0.05 ** 3 * 2500, n = (fx.orbitalEjectaKg + fx.escapingEjectaKg) / frag;
    const R = (radiusKm + orbitAltKm) * 1e3, fluence = (2 * n) / (4 * Math.PI * R * R);
    const habitatArea = 1e4; // m² cross-section of one habitat
    orbitalLoss = 1 - Math.exp(-fluence * habitatArea);
    const p = sites.reduce((a, s) => a + s.pop, 0), k = sites.reduce((a, s) => a + s.capital, 0);
    deaths += p * orbitalShare * orbitalLoss * 0.1; capital += k * orbitalShare * orbitalLoss * 0.3;
  }
  return { deaths, capitalLost: capital, sites: out, orbitalLossFraction: orbitalLoss, note: 'Spatial: damage integrated over each site footprint.' };
}

const EARTH_LAND_KM2 = 1.49e8, URBAN_LAND_SHARE = 0.01, URBAN_POP_SHARE = 0.57, COAST_KM_PER_KM2 = 356000 / 5.1e8;

/** Earth: area-based statistical exposure (geography not mapped). u: uniforms for land/ocean, urban hit, local density spread. */
export function earthExposure(fx: Effects, pop: number, capital: number, u: [number, number, number]): Exposure & { land: boolean; urban: boolean } {
  const land = u[0] < 0.29;
  const urbanDensity = (pop * URBAN_POP_SHARE) / (EARTH_LAND_KM2 * URBAN_LAND_SHARE);
  const ruralDensity = (pop * (1 - URBAN_POP_SHARE)) / (EARTH_LAND_KM2 * (1 - URBAN_LAND_SHARE));
  const capPerPerson = capital / Math.max(pop, 1);
  // a metropolitan core (≈ 10 km) around ground zero if the point is urban; the region beyond at the land mean, lognormal spread
  const urban = land && u[1] < URBAN_LAND_SHARE * 3; // ×3: cities cluster, ground zero is often near one
  const regional = (ruralDensity + (urbanDensity * URBAN_LAND_SHARE)) * Math.exp(0.8 * (Math.sqrt(-2 * Math.log(Math.max(1e-9, u[2]))) * Math.cos(2 * Math.PI * u[1]) - 0.32));
  let deaths = 0, cap = 0;
  const rings = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
  let prev = 0;
  for (const r of rings) {
    if (prev > fx.maxRadiusKm) break;
    const mid = (prev + r) / 2, area = Math.PI * (r * r - prev * prev);
    const dens = urban && mid < 10 ? urbanDensity : regional;
    const landShare = land ? (mid < 50 ? 1 : 0.5) : mid < 50 ? 0 : 0.3;
    const d = fx.damageAt(mid);
    deaths += area * landShare * dens * d.fatality;
    cap += area * landShare * dens * capPerPerson * d.capital;
    prev = r;
  }
  if (fx.tsunami && !land) {
    const R = fx.tsunami.radius3mKm, coast = COAST_KM_PER_KM2 * Math.PI * R * R, coastalDensity = ruralDensity * 1.6 + urbanDensity * URBAN_LAND_SHARE * 2;
    deaths += coast * 1 * coastalDensity * 0.2; cap += coast * 1 * coastalDensity * capPerPerson * 0.3;
  }
  deaths += pop * fx.globalFatality; cap += capital * fx.globalFatality * 0.5;
  return { deaths: Math.min(pop, deaths), capitalLost: Math.min(capital, cap), sites: [], orbitalLossFraction: 0, land, urban, note: 'Earth: statistical area-based exposure (land/ocean, urban/rural density, coastline); geography is not mapped.' };
}
