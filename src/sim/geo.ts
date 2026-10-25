// Living worlds: the physical state of every world, and how it changes.
//
// Every world carries a small block of physical state (temperature anomaly,
// ice, sea level, air, aerosol, dust, cloud, volcanism, magnetic field,
// terraforming) in SimState, cloned by snapshot/restore like everything else.
// Slow variables are integrated at the engine's step. Orbital and seasonal
// cycles (Earth's obliquity and precession, the Moon's retreat, the Martian
// year) are deterministic functions of the calendar year, with no randomness.
// Human activity (industrial carbon until clean energy, waste heat, Dyson
// swarms, terraforming paid for in energy) pushes the same variables.
// Sources: research/geophysics-plan.md.

import { EV, isAlive, STAGE, TECHS, type BodyKind } from './catalog.ts';
import { techArrival } from './diffusion.ts';
import { F, NF } from './metrics.ts';
import { hash01, next, type RngState } from './rng.ts';
import type { World } from './world.ts';

export const Y0 = 2040;

// ---------------------------------------------------------------- state layout

/** Per-world geo state columns. Rows: one per Solar System body (row = body id), then one per settlement elsewhere (row = nSol + its index in st.settled). */
export const GF = {
  tAnom: 0,    // slow surface temperature anomaly, K (Earth: against pre-industrial 1850–1900; elsewhere against the catalogue temperature)
  ice: 1,      // ice cover, share of the surface 0..1
  capN: 2,     // northern polar cap edge, degrees from the pole (Mars: the permanent cap; the seasonal frost is a function of the date)
  capS: 3,     // southern polar cap edge, degrees from the pole
  sea: 4,      // sea level against 2040, m (worlds with oceans)
  pAtm: 5,     // surface pressure, bar (-1: no surface)
  aero0: 6,    // stratospheric aerosol optical depth at time aeroT (volcanic and impact winters)
  aeroT: 7,    // years after 2040
  aeroTau: 8,  // e-folding time of the aerosol, years
  dust: 9,     // background dust optical depth
  cloud: 10,   // cloud cover, share 0..1
  vol: 11,     // volcanic activity index (Earth 0.3, Io 1)
  field: 12,   // magnetic field, Earth = 1
  terra: 13,   // terraforming progress 0..1
  heatK: 14,   // warming from waste heat, K
  dimK: 15,    // cooling from the star's own Dyson swarm, K
  lastEv: 16,  // last notable geophysical event type here (EV index), -1 none
  lastEvT: 17, // its year (years after 2040)
  nImp: 18,    // notable impacts here so far
  avgCool: 19, // mean aerosol cooling over the step that led here, K
  avgAero: 20, // mean aerosol optical depth over the step that led here
  shade: 21,   // cooling from a sunshade, K (negative)
} as const;
export const NGEO = 22;

/** Global geo slots (Earth's carbon and ice sheets, counters). */
export const GG = {
  cEff: 0,     // effective excess carbon, GtC (sets Earth's CO2 warming; drawn down over tens of millennia)
  emis: 1,     // fossil carbon emissions now, GtC/yr
  sTh: 2,      // sea-level contributions against pre-industrial, m: thermal expansion
  sGl: 3,      // mountain glaciers
  sGr: 4,      // Greenland
  sAn: 5,      // Antarctica
  impacts: 6,  // notable impacts so far, all worlds
  eruptions: 7,// eruptions of VEI 7 or more so far, all worlds
  solar: 8,    // Miyake-class solar storms so far
  seaMile: 9,  // sea-level milestones already written up
  nScar: 10,   // scars recorded so far (the table is a ring)
  terraformed: 11, // worlds whose terraforming has passed one half
  shadeOn: 12, // year Earth's sunshade went up, -1 not yet
  grsGone: 13, // 1 once the Great Red Spot's end has been written up
  stellar: 14, // stellar flares and storms so far
  sn: 15,      // supernovae seen so far
} as const;
export const NGG = 24;

/** Scars: craters, lava fields and dark impact scars, drawn on the surface. A ring buffer. */
/** fade: e-folding time of the scar, years (1e9: permanent, as on airless worlds) */
export const SC = { body: 0, x: 1, y: 2, z: 3, rad: 4, year: 5, kind: 6, fade: 7 } as const;
export const NSC = 8;
export const MAX_SCARS = 256;
export const SCAR = { CRATER: 0, LAVA: 1, DARK: 2 } as const;

// ---------------------------------------------------------------- orbits and seasons (deterministic)

/** Earth's obliquity in degrees: Laskar (1986), as in Meeus, Astronomical Algorithms eq. 22.3; good to a few arcseconds within ±10,000 years of 2000. */
export function earthObliquity(Y: number): number {
  const U = (Y - 2000) / 10000;
  const c = [84381.448, -4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45];
  let s = 0, p = 1;
  for (const k of c) { s += k * p; p *= U; }
  return s / 3600;
}
/** Earth's orbital eccentricity (Meeus 25.4). */
export function earthEccentricity(Y: number): number { const T = (Y - 2000) / 100; return 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T; }
/** Longitude of Earth's perihelion against the moving equinox, degrees (Meeus, table 31.A). */
export function earthPerihelionLon(Y: number): number { const T = (Y - 2000) / 100; return 102.937348 + 1.7195366 * T + 0.00045688 * T * T; }
/** Day of the year (1 = 1 January) on which Earth passes perihelion: precession walks it through the calendar. */
export function perihelionDay(Y: number): number {
  const lam = ((earthPerihelionLon(Y) + 180) % 360 + 360) % 360; // the Sun's longitude at perihelion
  return ((79.5 + lam / 360 * 365.2422) % 365.2422) + 1;           // 0° (the March equinox) falls on day ≈ 80
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
export function dayToDate(day: number): string {
  const d = Math.max(0, Math.min(364.99, day - 1));
  let m = 0;
  while (m < 11 && MONTH_START[m + 1] <= d) m++;
  return `${Math.floor(d - MONTH_START[m]) + 1} ${MONTHS[m]}`;
}
/** Sunlight at the June solstice against 2040's, from the changing Earth–Sun distance then: >1 means stronger northern summers. */
export function juneSunVs2040(Y: number): number {
  const f = (y: number) => { const e = earthEccentricity(y), lp = (earthPerihelionLon(y) + 180) * Math.PI / 180; return (1 + e * Math.cos(Math.PI / 2 - lp)) ** 2; };
  return f(Y) / f(Y0);
}
/** The Moon's mean distance, km: it recedes 3.82 cm a year (lunar laser ranging). */
export function moonDistanceKm(Y: number): number { return 384400 + 3.82e-5 * (Y - Y0); }
/** How much longer the day is than in 2040, milliseconds (tidal braking, ≈ 1.7 ms per century observed). */
export function dayLengthGainMs(Y: number): number { return 1.7 * (Y - Y0) / 100; }

/** Mars: orbital period (yr), eccentricity, a perihelion passage (3 August 2020) and the solar longitude of perihelion. */
export const MARS = { P: 1.88085, e: 0.0934, tPeri: 2020.588, lsPeri: 251 } as const;
const D2R = Math.PI / 180;
function kepler(M: number, e: number): number { let E = M + e * Math.sin(M); for (let i = 0; i < 4; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); return E; }
/** Mars's season: solar longitude Ls in degrees (0 = northern spring equinox, 90 northern summer, 180 autumn, 270 winter). */
export function marsLs(Y: number): number {
  const M = 2 * Math.PI * (((Y - MARS.tPeri) / MARS.P) % 1);
  const E = kepler(M, MARS.e);
  const nu = 2 * Math.atan(Math.sqrt((1 + MARS.e) / (1 - MARS.e)) * Math.tan(E / 2));
  return ((nu / D2R + MARS.lsPeri) % 360 + 720) % 360;
}
/** Mean anomaly (as a fraction of the year after perihelion) at which Mars reaches solar longitude Ls. */
function marsFracAt(Ls: number): number {
  const nu = (Ls - MARS.lsPeri) * D2R;
  const E = 2 * Math.atan(Math.sqrt((1 - MARS.e) / (1 + MARS.e)) * Math.tan(nu / 2));
  return (((E - MARS.e * Math.sin(E)) / (2 * Math.PI)) % 1 + 1) % 1;
}
const MY_LS0_36 = MARS.tPeri + marsFracAt(0) * MARS.P; // Mars Year 36 began 7 February 2021
/** Mars Year number (Clancy et al. 2000: MY 1 began 11 April 1955). */
export function marsYear(Y: number): number { return 36 + Math.floor((Y - MY_LS0_36) / MARS.P); }
/** Calendar year at which Mars Year n reaches solar longitude Ls. */
export function marsTimeAt(n: number, Ls: number): number {
  const start = MY_LS0_36 + (n - 36) * MARS.P;
  return start + (((marsFracAt(Ls) - marsFracAt(0)) % 1 + 1) % 1) * MARS.P;
}
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Mars's polar caps now: the edge of each cap in degrees from its pole. The seasonal CO₂ frost grows over each winter
 *  hemisphere (north to ≈ 55° N near Ls 330–0, south to ≈ 50° S near Ls 150–180) and sublimes in spring, leaving the
 *  permanent caps (≈ 10° and 4° across); the southern cap varies more from year to year. `perm` scales the permanent caps
 *  (terraforming melts them). */
export function marsCaps(seed: number, Y: number, perm = 1): [number, number] {
  const Ls = marsLs(Y), n = marsYear(Y);
  const wN = Ls >= 160 && Ls < 330 ? sstep(160, 330, Ls) : Ls >= 330 ? 1 : 1 - sstep(0, 90, Ls);
  const wS = Ls < 150 ? sstep(-10, 150, Ls) : Ls < 300 ? 1 - sstep(170, 300, Ls) : sstep(350, 370, Ls);
  const jitN = 0.95 + 0.1 * hash01(seed, n, 71), jitS = 0.82 + 0.36 * hash01(seed, n, 72);
  return [10 * perm + 25 * wN * jitN * (0.4 + 0.6 * perm), 4 * perm + 34 * wS * jitS * (0.4 + 0.6 * perm)];
}

// ---------------------------------------------------------------- per-world baselines

interface Base { p: number; cloud: number; ice: number; vol: number; field: number; ocean?: boolean }
/** The Solar System as observed: surface pressure (bar), cloud cover, ice cover, volcanic activity, magnetic field (Earth = 1). */
const SOL_BASE: Record<string, Base> = {
  Mercury: { p: 0, cloud: 0, ice: 0.002, vol: 0, field: 0.011 },
  Venus: { p: 92, cloud: 1, ice: 0, vol: 0.15, field: 0 },
  Earth: { p: 1.013, cloud: 0.67, ice: 0.1, vol: 0.3, field: 1, ocean: true },
  Moon: { p: 0, cloud: 0, ice: 0.001, vol: 0, field: 0 },
  Mars: { p: 0.006, cloud: 0.05, ice: 0.015, vol: 0.01, field: 0 },
  Phobos: { p: 0, cloud: 0, ice: 0, vol: 0, field: 0 },
  Vesta: { p: 0, cloud: 0, ice: 0, vol: 0, field: 0 },
  Ceres: { p: 0, cloud: 0, ice: 0.05, vol: 0.02, field: 0 },
  Psyche: { p: 0, cloud: 0, ice: 0, vol: 0, field: 0 },
  Hygiea: { p: 0, cloud: 0, ice: 0.02, vol: 0, field: 0 },
  Jupiter: { p: -1, cloud: 1, ice: 0, vol: 0, field: 20000 },
  Io: { p: 0, cloud: 0, ice: 0, vol: 1, field: 0 },
  Europa: { p: 0, cloud: 0, ice: 1, vol: 0.1, field: 0 },
  Ganymede: { p: 0, cloud: 0, ice: 0.5, vol: 0, field: 0.025 },
  Callisto: { p: 0, cloud: 0, ice: 0.3, vol: 0, field: 0 },
  Saturn: { p: -1, cloud: 1, ice: 0, vol: 0, field: 580 },
  Enceladus: { p: 0, cloud: 0, ice: 1, vol: 0.4, field: 0 },
  Rhea: { p: 0, cloud: 0, ice: 1, vol: 0, field: 0 },
  Titan: { p: 1.47, cloud: 1, ice: 0, vol: 0.05, field: 0 },
  Iapetus: { p: 0, cloud: 0, ice: 0.5, vol: 0, field: 0 },
  Uranus: { p: -1, cloud: 1, ice: 0, vol: 0, field: 48 },
  Titania: { p: 0, cloud: 0, ice: 0.6, vol: 0, field: 0 },
  Oberon: { p: 0, cloud: 0, ice: 0.6, vol: 0, field: 0 },
  Neptune: { p: -1, cloud: 1, ice: 0, vol: 0, field: 27 },
  Triton: { p: 1.4e-5, cloud: 0, ice: 1, vol: 0.2, field: 0 },
  Pluto: { p: 1e-5, cloud: 0, ice: 0.9, vol: 0.05, field: 0 },
  Haumea: { p: 0, cloud: 0, ice: 1, vol: 0, field: 0 },
  Eris: { p: 0, cloud: 0, ice: 1, vol: 0, field: 0 },
  Sedna: { p: 0, cloud: 0, ice: 0.5, vol: 0, field: 0 },
};
/** A world elsewhere, drawn from its kind (P): procedural, but within what its kind allows. */
function procBase(kind: BodyKind, hab: number, temp: number, id: number): Base {
  const u = (k: number) => hash01(id, k, 917);
  switch (kind) {
    case 'ocean': return { p: 0.8 + 2.5 * u(1), cloud: 0.5 + 0.3 * u(2), ice: temp < 260 ? 0.2 + 0.5 * u(3) : 0.03 + 0.1 * u(3), vol: 0.15 + 0.4 * u(4), field: 0.3 + 1.5 * u(5), ocean: true };
    case 'superearth': return { p: 0.5 + 8 * u(1), cloud: 0.3 + 0.5 * u(2), ice: temp < 240 ? 0.3 * u(3) : 0.02, vol: 0.2 + 0.6 * u(4), field: 0.2 + 2 * u(5), ocean: hab > 0.3 && u(6) < 0.5 };
    case 'rocky': return { p: hab > 0.25 ? 0.3 + 1.5 * u(1) : 0.05 * u(1), cloud: hab > 0.25 ? 0.2 + 0.4 * u(2) : 0, ice: temp < 230 ? 0.2 * u(3) : 0.01, vol: 0.05 + 0.4 * u(4), field: 0.1 + 1.2 * u(5), ocean: hab > 0.35 && u(6) < 0.4 };
    case 'desert': return { p: 0.01 + 0.6 * u(1), cloud: 0.05 + 0.1 * u(2), ice: 0.01 + 0.03 * u(3), vol: 0.02 + 0.2 * u(4), field: 0.4 * u(5) };
    case 'lava': return { p: 5 * u(1), cloud: 0.2 * u(2), ice: 0, vol: 0.8 + 0.2 * u(4), field: 0.5 * u(5) };
    case 'ice': return { p: 0.3 * u(1), cloud: 0.1 * u(2), ice: 0.7 + 0.3 * u(3), vol: 0.05 + 0.2 * u(4), field: 0.2 * u(5) };
    case 'gas': case 'icegiant': return { p: -1, cloud: 1, ice: 0, vol: 0, field: 10 + 2000 * u(5) };
    case 'moon': return { p: hab > 0.2 ? 0.5 * u(1) : 0, cloud: 0, ice: 0.1 + 0.6 * u(3), vol: 0.1 * u(4), field: 0 };
    default: return { p: 0, cloud: 0, ice: kind === 'dwarf' ? 0.6 : 0.02, vol: 0, field: 0 };
  }
}

const TECH_IX = new Map(TECHS.map((t, i) => [t.id, i]));
const TX = (id: string) => TECH_IX.get(id)!;
const T_PARA = TX('paraterraform'), T_TERRA = TX('terraform'), T_MAG = TX('magShield');

/** Effective carbon and its warming: TCRE ≈ 1.65 K per 1000 GtC (IPCC AR6 WG1 SPM D.1.1: 0.45 K per 1000 GtCO₂). */
const TCRE = 0.00165;
/** Earth in 2040: +1.7 K over pre-industrial, ≈ 9 GtC a year of fossil carbon (IPCC AR6; Global Carbon Budget 2023 ≈ 10 GtC in 2023). */
const GW_2040 = 1.7, EMIS_2040 = 9;
/** Excess carbon is drawn down by the oceans and rock weathering over tens of millennia (Archer et al. 2009); an e-fold of 20,000 years leaves ≈ 60% after 10,000. */
const C_DRAWDOWN = 20000;
/** Multi-millennial sea-level commitment per kelvin, after Levermann et al. 2013 (PNAS 110:13745): thermal expansion 0.42 m/K, mountain glaciers up to 0.6 m,
 *  Greenland up to 7.2 m past a threshold near +1.6 K, Antarctica 1.2 m/K; e-folding response times (years). */
const SEA = { th: 0.42, tauTh: 500, gl: 0.6, tauGl: 100, gr: 7.2, tauGr: 3000, an: 1.2, tauAn: 2500 };
const SEA_2040 = { th: 0.14, gl: 0.11, gr: 0.04, an: 0.03 }; // ≈ 0.32 m risen since pre-industrial by 2040
const SEA0 = SEA_2040.th + SEA_2040.gl + SEA_2040.gr + SEA_2040.an;
/** Energy to terraform a Mars-sized world, J (order of the estimates for releasing and warming a thick CO₂ atmosphere, McKay, Toon & Kasting 1991); scales with area. */
const E_TERRA = 5e23;
/** Share of a world's energy a terraforming project may spend. */
const TERRA_SHARE = 0.1;
/** Share of a Dyson swarm's coverage that crosses the line of sight from the star's own planets (swarms are built off the ecliptic where they can be). */
const SWARM_SHADE = 0.04;

/** Stratospheric aerosol optical depth → global surface cooling, K: −0.5 K for Pinatubo (τ ≈ 0.15), ≈ −0.8 K for Tambora (τ ≈ 0.25), saturating near −8 K. */
export function aeroCooling(tau: number): number { return tau > 0 ? 8 * (1 - Math.exp(-tau / 2.4)) : 0; }
/** Share of a harvest lost to a cold year c K below normal (open-field farming): ≈ 10% at −1 K, most of it at −5 K. */
export function harvestLoss(c: number): number { return Math.min(0.95, Math.max(0, 0.1 * c + 0.02 * c * c)); }
/** Aerosol optical depth of a pulse at year t. */
export function aeroAt(geo: Float64Array, o: number, t: number): number {
  const a0 = geo[o + GF.aero0];
  return a0 > 0 && t >= geo[o + GF.aeroT] ? a0 * Math.exp(-(t - geo[o + GF.aeroT]) / geo[o + GF.aeroTau]) : 0;
}

// ---------------------------------------------------------------- the geophysics stream
// Natural events do not depend on what people do, so their times, sizes and places are a pure function of
// (seed, world, year): a counter-based stream separate from the engine's. The engine applies their effects as
// steps cross them; the views can draw an eruption the moment the slider passes it, between steps.

/** Hash of the run seed and three integers → [0, 1). */
export function gh(seed: number, a: number, b: number, c: number): number {
  let h = Math.imul(seed ^ 0x6e0, 0x9e3779b1) ^ 0x27d4eb2f;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35); h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f); h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function poissonInv(u: number, m: number): number {
  if (m <= 0) return 0;
  let k = 0, p = Math.exp(-m), s = p;
  while (u > s && k < 60) { k++; p *= m / k; s += p; }
  return k;
}

/** Event classes on a world. */
export const GEV = {
  AIR20: 0, TUNG: 1, R140: 2, KM1: 3, KM10: 4, VEI6: 5, VEI7: 6, VEI8: 7, QUAKE: 8,
  IO: 9, PLUME: 10, JSCAR: 11, JSL9: 12, VENUS: 13, LAVA: 14, DUST: 15,
} as const;
export const NGEV = 16;

/** The catalogue: rates on Earth (per year) unless noted, what each does, and where the rate comes from. Tag: R real data, E estimate from real data. */
export const GEO_CATALOGUE: { cls: number; name: string; rate: string; perYear: number; where: string; source: string; tag: 'R' | 'E' }[] = [
  { cls: GEV.AIR20, name: 'Chelyabinsk-class airburst (~20 m)', rate: 'once per ~60 years', perYear: 1 / 60, where: 'Earth (harmless elsewhere, not simulated)', source: 'Brown et al. 2013 (Nature 503:238); Catalina Sky Survey FAQ', tag: 'E' },
  { cls: GEV.TUNG, name: 'Tunguska-class airburst (~50 m)', rate: 'once per ~500 years', perYear: 1 / 500, where: 'Earth; other worlds by cross-section', source: 'NASA, "Tunguska revisited" (2019); Catalina Sky Survey FAQ', tag: 'E' },
  { cls: GEV.R140, name: 'Regional impact (~140 m)', rate: 'once per ~20,000 years', perYear: 1 / 20000, where: 'Earth; other worlds by cross-section', source: 'Catalina Sky Survey FAQ; NASA planetary defense', tag: 'E' },
  { cls: GEV.KM1, name: 'Global impact (~1 km)', rate: 'once per ~600,000 years', perYear: 1 / 600000, where: 'Earth; other worlds by cross-section', source: 'Chodas, "Protecting Earth" (KISS); Catalina Sky Survey FAQ', tag: 'E' },
  { cls: GEV.KM10, name: 'Extinction-class impact (~10 km)', rate: 'once per ~100 million years', perYear: 1e-8, where: 'Earth; other worlds by cross-section', source: 'Chodas (KISS); Chicxulub as the last', tag: 'E' },
  { cls: GEV.VEI6, name: 'VEI 6 eruption (Pinatubo, Krakatoa)', rate: 'once per ~80 years', perYear: 1 / 80, where: 'Earth; active exoplanets', source: 'Wikipedia, "Volcanic explosivity index" (50–100 yr)', tag: 'E' },
  { cls: GEV.VEI7, name: 'VEI 7 eruption (Tambora 1815)', rate: 'once per ~700 years', perYear: 1 / 700, where: 'Earth; active exoplanets', source: 'Wikipedia VEI; Toohey & Sigl 2017 / Rutgers VEI 7 paper (1–2 per 1,000 yr)', tag: 'E' },
  { cls: GEV.VEI8, name: 'VEI 8 supereruption (Toba, Yellowstone)', rate: 'once per ~50,000 years', perYear: 1 / 50000, where: 'Earth; active exoplanets', source: 'Recurrence estimates 30–130 kyr (Rougier et al. 2018; Mason et al. 2004)', tag: 'E' },
  { cls: GEV.QUAKE, name: 'Great earthquake, Mw 9+ (and tsunami)', rate: 'once per ~30 years', perYear: 1 / 30, where: 'Earth', source: 'USGS catalogue: Mw ≥ 9 in 1952, 1960, 1964, 2004, 2011', tag: 'R' },
  { cls: GEV.IO, name: 'Great outburst on Io', rate: 'once per ~10 years', perYear: 1 / 10, where: 'Io', source: 'de Kleer & de Pater 2016 (Icarus 280:405): outbursts several per year, great ones rarer', tag: 'E' },
  { cls: GEV.PLUME, name: 'Plume surge', rate: 'Enceladus every ~5 yr, Triton ~10, Europa ~30', perYear: 1 / 5, where: 'Enceladus, Europa, Triton', source: 'Cassini plume variability (Hedman et al. 2013); Voyager 2 Triton geysers; Europa plume candidates', tag: 'E' },
  { cls: GEV.JSCAR, name: 'Jupiter impact leaving a dark scar', rate: 'once per ~15 years', perYear: 1 / 15, where: 'Jupiter', source: 'The 2009 scar; Hueso et al. 2018 (flash rates)', tag: 'E' },
  { cls: GEV.JSL9, name: 'Shoemaker–Levy 9-class impact on Jupiter', rate: 'once per ~500 years', perYear: 1 / 500, where: 'Jupiter', source: 'Zahnle, Schenk, Levison & Dones 2003 (Icarus 163:263)', tag: 'E' },
  { cls: GEV.VENUS, name: 'Lava eruption on Venus', rate: 'once per ~20 years', perYear: 1 / 20, where: 'Venus', source: 'Herrick & Hensley 2023 (Science 379:1205): a vent changed 1990–91', tag: 'E' },
  { cls: GEV.LAVA, name: 'Lava flood on a lava world', rate: 'once per ~5 years', perYear: 1 / 5, where: 'lava exoplanets', source: 'procedural, scaled from Io', tag: 'E' },
  { cls: GEV.DUST, name: 'Global dust storm on a desert world', rate: 'once per ~6 years', perYear: 1 / 6, where: 'desert exoplanets', source: 'procedural, scaled from Mars', tag: 'E' },
];

/** Per-class physics: damage radius (km) and severity for people inside it, stratospheric aerosol (τ, e-fold years). */
const FX: { dev: number; sev: number; aero: [number, number]; aeroTau: number }[] = [];
FX[GEV.AIR20] = { dev: 25, sev: 0.002, aero: [0, 0], aeroTau: 1 };
FX[GEV.TUNG] = { dev: 30, sev: 0.08, aero: [0, 0], aeroTau: 1 };
FX[GEV.R140] = { dev: 150, sev: 0.4, aero: [0.01, 0.03], aeroTau: 1 };
FX[GEV.KM1] = { dev: 800, sev: 0.9, aero: [2, 4], aeroTau: 1.5 };
FX[GEV.KM10] = { dev: 5000, sev: 1, aero: [25, 40], aeroTau: 3 };
FX[GEV.VEI6] = { dev: 40, sev: 0.02, aero: [0.08, 0.15], aeroTau: 1 };
FX[GEV.VEI7] = { dev: 120, sev: 0.15, aero: [0.2, 0.5], aeroTau: 1.2 };
FX[GEV.VEI8] = { dev: 700, sev: 0.5, aero: [2, 5], aeroTau: 2 };
FX[GEV.QUAKE] = { dev: 600, sev: 0.002, aero: [0, 0], aeroTau: 1 };
FX[GEV.IO] = { dev: 300, sev: 0.05, aero: [0, 0], aeroTau: 1 };
FX[GEV.PLUME] = { dev: 0, sev: 0, aero: [0, 0], aeroTau: 1 };
FX[GEV.JSCAR] = { dev: 0, sev: 0, aero: [0, 0], aeroTau: 1 };
FX[GEV.JSL9] = { dev: 0, sev: 0, aero: [0, 0], aeroTau: 1 };
FX[GEV.VENUS] = { dev: 150, sev: 0.1, aero: [0, 0], aeroTau: 1 };
FX[GEV.LAVA] = { dev: 200, sev: 0.1, aero: [0, 0], aeroTau: 1 };
FX[GEV.DUST] = { dev: 0, sev: 0, aero: [0, 0], aeroTau: 1 };
/** impactor size, m, per impact class */
const IMPACT_M = [20, 50, 140, 1000, 10000];
const isImpact = (c: number) => c <= GEV.KM10;

/** One natural event: class, year (after 2040), unit direction on the world (y up, as the views draw it), magnitude draw, deflection draw. */
export interface GeoEvent { cls: number; t: number; x: number; y: number; z: number; m: number; d: number; j: number }

// ---------------------------------------------------------------- weather, cycles and comets (pure functions of the date)

const KEY_MARS = 1 << 20, KEY_JUP = KEY_MARS + 1, KEY_SAT = KEY_MARS + 2, KEY_HALLEY = KEY_MARS + 3, KEY_SKY = KEY_MARS + 4, KEY_STAR = 1 << 21;

/** Mars's global dust storm in Mars Year n, if it has one: about one every 3–5 Mars years, always starting between Ls 180° and 310°
 *  (Wolkenberg et al. 2020; MSL navcams on MY 34). Calendar years. */
export function marsStorm(seed: number, n: number): { start: number; end: number; tau: number; ls: number } | null {
  if (gh(seed, KEY_MARS, n, 1) >= 0.3) return null;
  const ls = 180 + 130 * gh(seed, KEY_MARS, n, 2);
  const start = marsTimeAt(n, ls), dur = 0.25 + 0.25 * gh(seed, KEY_MARS, n, 3);
  return { start, end: start + dur, tau: 4 + 5 * gh(seed, KEY_MARS, n, 4), ls };
}
/** Dust optical depth over Mars on a calendar date: a seasonal background, higher near perihelion, plus a global storm if one is on. */
export function marsDust(seed: number, Y: number): { tau: number; storm: boolean; ls: number } {
  const ls = marsLs(Y), n = marsYear(Y);
  let tau = 0.45 + 0.35 * Math.exp(-(((ls - 250 + 540) % 360 - 180) ** 2) / (2 * 50 * 50));
  let storm = false;
  for (const k of [n - 1, n]) {
    const s = marsStorm(seed, k);
    if (!s || Y < s.start || Y > s.end + 0.3) continue;
    const rise = Math.min(1, (Y - s.start) / 0.04), fall = Y > s.end ? Math.exp(-(Y - s.end) / 0.08) : 1;
    tau = Math.max(tau, s.tau * rise * fall);
    storm = storm || Y <= s.end;
  }
  return { tau, storm, ls };
}
/** Width of Jupiter's Great Red Spot, km (0: gone). It was ≈ 16,000 km in 2017 and shrinking (Simon et al. 2018); in each future it either
 *  settles at 7,000–11,000 km or dissolves within a few centuries. */
export function grsWidth(seed: number, Y: number): number {
  const u = gh(seed, KEY_JUP, 0, 1), v = gh(seed, KEY_JUP, 0, 2), t = Math.max(0, Y - Y0);
  if (u < 0.55) { const w = 7000 + 4000 * v; return w + (12000 - w) * Math.exp(-t / 300); }
  const end = grsEnd(seed)!;
  return Y >= end ? 0 : 12000 - 9000 * t / (end - Y0);
}
/** Calendar year the Great Red Spot dissolves in this future, or null if it lasts. */
export function grsEnd(seed: number): number | null { return gh(seed, KEY_JUP, 0, 1) < 0.55 ? null : 2080 + 1400 * gh(seed, KEY_JUP, 0, 2); }
/** Saturn's Great White Spot: ≈ one per Saturn year near northern summer (1876, 1903, 1933, 1960, 1990; 2010). 0..1 strength and latitude (deg). */
export function saturnGWS(seed: number, Y: number): { amp: number; lat: number } {
  const P = 29.457, k = Math.round((Y - 2017.4) / P);
  let best = { amp: 0, lat: 35 };
  for (const j of [k - 1, k, k + 1]) {
    if (gh(seed, KEY_SAT, j, 1) > 0.85) continue;
    const t0 = 2017.4 + j * P - 6 + 12 * gh(seed, KEY_SAT, j, 2), dt = Y - t0;
    const amp = dt < 0 ? 0 : dt < 0.1 ? dt / 0.1 : Math.exp(-(dt - 0.1) / 0.5);
    if (amp > best.amp) best = { amp, lat: 5 + 40 * gh(seed, KEY_SAT, j, 3) };
  }
  return best;
}
/** Titan's season: +1 at northern summer solstice (May 2017), −1 at southern; Saturn's year is 29.46 Earth years. */
export function titanSeason(Y: number): number { return Math.cos(2 * Math.PI * (Y - 2017.4) / 29.457); }
/** The Sun's 11-year cycle, 0 at minimum and 1 at maximum (Cycle 25 peaked about 2024.8). */
export function solarCycle(Y: number): number { return 0.5 + 0.5 * Math.cos(2 * Math.PI * (Y - 2024.8) / 11.0); }
/** El Niño and La Niña: ±0.2 K of interannual swing in Earth's mean temperature (procedural, anchored to ENSO's 2–7 year band). */
export function ensoK(seed: number, Y: number): number {
  const p1 = gh(seed, KEY_SKY, 1, 1) * 6.283, p2 = gh(seed, KEY_SKY, 2, 1) * 6.283;
  return 0.13 * Math.sin(2 * Math.PI * Y / 3.7 + p1) + 0.08 * Math.sin(2 * Math.PI * Y / 5.3 + p2);
}

/** Halley's comet: perihelion 28 July 2061 and 27 March 2134 (JPL), then about every 76 years (planetary tugs move each return by a year or two). */
export const HALLEY = { a: 17.834, e: 0.96714, i: 162.26, node: 58.42, peri: 111.33 } as const;
export function halleyReturns(seed: number): { t: number; miss: number }[] {
  const out = [{ t: 2061.57, miss: 0.48 }, { t: 2134.24, miss: 0.09 }];
  for (let k = 2; ; k++) {
    const t = out[k - 1].t + 75.3 + 2.4 * (gh(seed, KEY_HALLEY, k, 1) - 0.5);
    if (t > Y0 + 10000) break;
    out.push({ t, miss: Math.round((0.1 + 0.5 * gh(seed, KEY_HALLEY, k, 2)) * 100) / 100 });
  }
  return out;
}
/** Comet Swift–Tuttle: perihelion 12 July 2126 (0.15 AU from Earth in August), and its close pass of 4479 (≈ 0.03 AU) (Yau, Yeomans & Weissman 1994). */
export const SWIFT_TUTTLE = [{ t: 2126.53, miss: 0.153 }, { t: 4479.7, miss: 0.03 }];
/** Halley's heliocentric ecliptic position (AU) on a calendar date. */
export function halleyPos(seed: number, Y: number): [number, number, number] {
  const ret = halleyReturns(seed);
  let tp = ret[0].t - 75.3; // the 1986 return, near enough
  for (const r of ret) if (Math.abs(Y - r.t) < Math.abs(Y - tp)) tp = r.t;
  const { a, e } = HALLEY, n = 2 * Math.PI / Math.pow(a, 1.5);
  const M = n * (Y - tp), E = kepler(M, e);
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = HALLEY.peri * D2R, O = HALLEY.node * D2R, inc = HALLEY.i * D2R;
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(inc), si = Math.sin(inc);
  const x = xv * (cw * cO - sw * sO * ci) - yv * (sw * cO + cw * sO * ci);
  const y = xv * (cw * sO + sw * cO * ci) - yv * (sw * sO - cw * cO * ci);
  const z = xv * (sw * si) + yv * (cw * si);
  return [x, y, z];
}
/** Betelgeuse (≈ 550 ly, Joyce et al. 2020) is expected to explode within ~100,000 years: harmless at that distance, as bright as a half Moon for months. Calendar year, or null. */
export function betelgeuseYear(seed: number): number | null {
  const t = -Math.log(Math.max(1e-12, gh(seed, KEY_SKY, 3, 1))) / 1e-5;
  return t <= 10000 ? Y0 + t : null;
}

/** Stellar storms: Carrington-class geomagnetic storms and Miyake-class particle events (774/775 CE, 993 CE, 660 BCE in tree rings),
 *  per year by spectral class. Red dwarfs flare far more often (Howard et al. 2018). */
const STELLAR: Record<string, [number, number]> = { O: [1 / 200, 1 / 4000], B: [1 / 200, 1 / 4000], A: [1 / 200, 1 / 4000], F: [1 / 150, 1 / 3000], G: [1 / 100, 1 / 2000], K: [1 / 60, 1 / 1500], M: [1 / 5, 1 / 300] };
export function stellarRates(spec: string): [number, number] { return STELLAR[spec[0]] ?? STELLAR.G; }

// ---------------------------------------------------------------- settlements as targets

/** Settlements drawn on a world: one capital plus more as it grows (the views draw the same). */
export function cityCount(stage: number, pop: number): number { return !isAlive(stage) ? 0 : pop < 1000 ? 1 : Math.min(48, Math.ceil(Math.cbrt(pop / 1000))); }
/** Head-count of settlement i of n: the capital holds 30%. */
export function cityShare(n: number, i: number): number { return n <= 1 ? 1 : i === 0 ? 0.3 : 0.7 / (n - 1); }
/** Unit direction of settlement i on body b (y up). */
export function cityUnit(b: number, i: number): [number, number, number] {
  const u = hash01(b, i, 1) * 2 - 1, th = hash01(b, i, 2) * Math.PI * 2, s = Math.sqrt(1 - u * u);
  const x = s * Math.cos(th), y = u * 0.85, z = s * Math.sin(th), l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

export interface GeoHost {
  world: World;
  log(type: number, body: number, a?: number, b?: number): void;
  disaster(b: number, type: number, k: number): void;
  /** a settlement wiped out (asteroid strike on a small colony) */
  kill(b: number): void;
}
type Fx = { lifeSupport: number; fission: number };

/** Physical state, rates and the step for every world. One per engine (static tables, scratch); the state lives in SimState. */
export class Geo {
  readonly world: World;
  readonly seed: number;
  readonly nSol: number;
  readonly earth: number;
  readonly mars: number;
  readonly jupiter: number;
  /** static per body */
  readonly baseP: Float64Array; readonly baseCloud: Float64Array; readonly baseIce: Float64Array; readonly baseVol: Float64Array; readonly baseField: Float64Array;
  readonly ocean: Uint8Array; readonly heatSpan: Float64Array; readonly area: Float64Array;
  /** event rates per body and class (per year), and their sum */
  readonly rate: Float64Array; readonly rateSum: Float64Array;
  /** per body: chance a bin of its event stream is empty */
  private readonly p0: Float64Array;
  readonly halley: { t: number; miss: number }[];
  /** scratch, rebuilt every step before the settlements are processed */
  foodMul: Float64Array; energyMul: Float64Array; capMul: Float64Array; habAdd: Float64Array;
  private touched: number[] = [];
  /** per system: share of the star's light its swarm intercepts (written by the engine's systems pass) */
  sysCov: Float64Array;
  private evs: GeoEvent[] = [];
  /** reused event records (eventsIn's results are valid until its next call) */
  private pool: GeoEvent[] = [];
  /** static: worlds that could be terraformed at all */
  private terraOK: Uint8Array;
  /** per system this step: (1 − shade)^¼ − 1, the swarm's cooling as a share of the temperature */
  private sysDim: Float64Array;
  /** per system: chance a bin of its stellar storms is empty */
  private starP0: Float64Array;
  /** the engine's body → settlement index, for the step in progress */
  private pos: Int32Array = new Int32Array(0);
  private sysMark: Int32Array; private markGen = 0; private sysList: number[] = [];

  constructor(world: World, seed: number) {
    this.world = world; this.seed = seed;
    const nb = world.bodies.length;
    this.nSol = world.systems[0].bodies.length;
    this.earth = world.earth; this.mars = world.mars;
    this.jupiter = world.bodies.findIndex((b) => b.name === 'Jupiter' && b.system === 0);
    this.baseP = new Float64Array(nb); this.baseCloud = new Float64Array(nb); this.baseIce = new Float64Array(nb);
    this.baseVol = new Float64Array(nb); this.baseField = new Float64Array(nb); this.ocean = new Uint8Array(nb);
    this.heatSpan = new Float64Array(nb); this.area = new Float64Array(nb);
    this.rate = new Float64Array(nb * NGEV); this.rateSum = new Float64Array(nb); this.p0 = new Float64Array(nb);
    world.bodies.forEach((b, i) => {
      const base = b.system === 0 ? SOL_BASE[b.name] ?? procBase(b.kind, b.hab, b.temp, i) : procBase(b.kind, b.hab, b.temp, i);
      this.baseP[i] = base.p; this.baseCloud[i] = base.cloud; this.baseIce[i] = base.ice; this.baseVol[i] = base.vol; this.baseField[i] = base.field;
      this.ocean[i] = base.ocean ? 1 : 0;
      // the engine's waste-heat limit: a living world tolerates +3 K, a dead one radiators 30 K above its surface (never below 250 K)
      const T = Math.max(b.temp, 3);
      this.heatSpan[i] = (b.hab >= 0.3 ? T + 3 : Math.max(T + 30, 250)) - T;
      this.area[i] = Math.min(4, (b.radius / 3390) ** 2);
      this.rates(i);
    });
    this.foodMul = new Float64Array(nb).fill(1); this.energyMul = new Float64Array(nb).fill(1);
    this.capMul = new Float64Array(nb).fill(1); this.habAdd = new Float64Array(nb);
    this.sysCov = new Float64Array(world.systems.length);
    this.sysMark = new Int32Array(world.systems.length);
    this.sysDim = new Float64Array(world.systems.length);
    this.starP0 = Float64Array.from(world.systems, (s) => { const [a, b] = stellarRates(s.spec); return Math.exp(-(a + b) * (s.id === 0 ? 1 : 10)); });
    // (not a world whose surface its volcanoes renew every century, as Io's)
    this.terraOK = Uint8Array.from(world.bodies, (b, i) => (b.hab < 0.8 && b.g >= 0.1 && this.baseP[i] >= 0 && this.baseVol[i] < 0.9 && b.kind !== 'asteroid' && b.kind !== 'habitat' ? 1 : 0));
    this.halley = halleyReturns(seed);
  }

  /** Event rates on body i: Earth's catalogue scaled by cross-section and neighbourhood (impacts), by activity (volcanism), or the world's own. */
  private rates(i: number): void {
    const b = this.world.bodies[i], R = this.rate, o = i * NGEV, w = this.world;
    const cat = (c: number) => GEO_CATALOGUE[c].perYear;
    const parent = b.parent >= 0 ? w.bodies[b.parent].name : '';
    if (b.kind === 'gas' || b.kind === 'icegiant') {
      if (i === this.jupiter) { R[o + GEV.JSCAR] = 1 / 15; R[o + GEV.JSL9] = 1 / 500; }
    } else if (b.kind !== 'habitat') {
      // impacts: per area, with gravitational focusing (Earth ×1.4 against a small body) and the local flux of impactors.
      // Mars sits near the main belt (≈ 2× Earth per area; Le Feuvre & Wieczorek 2011), belt asteroids see hundreds of times
      // Earth's rate per area (Bottke et al. 1994), giant-planet moons more from focused comets (Zahnle et al. 2003)
      const area = (b.radius / 6371) ** 2;
      let loc = b.system !== 0 ? 0.3 + 2.7 * hash01(b.system, 0, 913) : i === this.earth ? 1 : b.name === 'Mars' || parent === 'Mars' ? 2 : b.name === 'Mercury' ? 1.5 : b.name === 'Moon' ? 0.7 : b.name === 'Venus' ? 1 : parent === 'Jupiter' ? 3 : parent === 'Saturn' ? 1.5 : parent === 'Uranus' || parent === 'Neptune' ? 1 : b.a >= 2 && b.a <= 3.6 ? 300 : 0.3;
      if (b.system !== 0 && b.kind === 'asteroid') loc *= 100;
      // Impacts on settled worlds are rolled by the impact model (src/impact/engineImpacts.ts) at body-specific rates, with entry,
      // crater and blast physics and spatial exposure; it hands each one back here (impactAftermath) for the haze, scar and tallies.
      // The catalogue rows stay as the Earth reference. Rolling them here too would count every impact twice.
      void area; void loc;
      if (i === this.earth) for (const c of [GEV.VEI6, GEV.VEI7, GEV.VEI8, GEV.QUAKE]) R[o + c] = cat(c);
      else if (b.system !== 0 && (b.kind === 'rocky' || b.kind === 'superearth' || b.kind === 'ocean')) {
        const act = area * (0.3 + 2 * this.baseVol[i]);
        for (const c of [GEV.VEI6, GEV.VEI7, GEV.VEI8]) R[o + c] = cat(c) * act;
      }
      if (b.name === 'Io' && b.system === 0) R[o + GEV.IO] = 1 / 10;
      if (b.system === 0 && (b.name === 'Enceladus' || b.name === 'Europa' || b.name === 'Triton')) R[o + GEV.PLUME] = b.name === 'Enceladus' ? 1 / 5 : b.name === 'Triton' ? 1 / 10 : 1 / 30;
      if (b.name === 'Venus' && b.system === 0) R[o + GEV.VENUS] = 1 / 20;
      if (b.system !== 0 && b.kind === 'lava') R[o + GEV.LAVA] = 1 / 5;
      if (b.system !== 0 && b.kind === 'desert') R[o + GEV.DUST] = 1 / 6;
    }
    let s = 0;
    for (let c = 0; c < NGEV; c++) s += R[o + c];
    this.rateSum[i] = s;
    this.p0[i] = Math.exp(-s * this.binLen(i));
  }

  /** Running integrals over the step of the aerosol pulse: optical depth, cooling, harvest loss; and the time reached. */
  private integ = new Float64Array(4);
  /** Simpson's rule on the aerosol pulse from the time reached to `to`. */
  private segment(geo: Float64Array, o: number, to: number): void {
    const I = this.integ, from = I[3];
    if (to <= from) return;
    I[3] = to;
    if (geo[o + GF.aero0] <= 0 || to <= geo[o + GF.aeroT]) return;
    const a = aeroAt(geo, o, from), m = aeroAt(geo, o, (from + to) / 2), z = aeroAt(geo, o, to), w = (to - from) / 6;
    if (a + m + z < 1e-6) return;
    const ca = aeroCooling(a), cm = aeroCooling(m), cz = aeroCooling(z);
    I[0] += w * (a + 4 * m + z);
    I[1] += w * (ca + 4 * cm + cz);
    I[2] += w * (harvestLoss(ca) + 4 * harvestLoss(cm) + harvestLoss(cz));
  }
  /** True when an exoplanet settlement needs no more than its human forcing updated this step: no event, no haze, no terraforming under way. */
  private steady(st: GeoState, b: number, r: number, stg: number, year: number, dt: number): boolean {
    const geo = st.geo, o = r * NGEO;
    if (geo[o + GF.aero0] > 0 && aeroAt(geo, o, year) > 1e-4) return false;
    if (stg >= STAGE.CITY && this.terraOK[b] && geo[o + GF.terra] < 1 && (st.techDone[T_PARA] >= 0 || st.techDone[T_TERRA] >= 0)) return false;
    if (this.rateSum[b] > 0 && this.mayHave(b, year, year + dt)) return false;
    return true;
  }
  /** Quick test before generating: false when no bin overlapping [t0, t1) has an event (most body-steps). */
  private mayHave(b: number, t0: number, t1: number): boolean {
    const L = this.binLen(b), p0 = this.p0[b];
    for (let bin = Math.floor(t0 / L), last = Math.floor((t1 - 1e-9) / L); bin <= last; bin++) if (gh(this.seed, b, bin, 0) > p0) return true;
    return false;
  }

  /** Arrival years of a few technologies at every world, cached while their invention stays the same (a restore may change it). */
  private arrival: ({ done: number; where: number; at: Float64Array } | undefined)[] = [];
  /** Whether technology ti is known at body b in year t (news travels at light speed: diffusion.ts). */
  knows(st: { techDone: Float64Array; techWhere: Float64Array }, ti: number, b: number, t: number): boolean {
    const d = st.techDone[ti];
    if (d < 0 || d > t) return false;
    let c = this.arrival[ti];
    if (!c || c.done !== d || c.where !== st.techWhere[ti]) this.arrival[ti] = c = { done: d, where: st.techWhere[ti], at: new Float64Array(this.world.bodies.length).fill(NaN) };
    let y = c.at[b];
    if (y !== y) c.at[b] = y = techArrival(this.world, st.techDone, st.techWhere, ti, b);
    return y <= t;
  }

  /** Years per bin of the event stream: a year in the Solar System, a decade elsewhere. */
  binLen(b: number): number { return b < this.nSol ? 1 : 10; }

  /** Natural events on body b with t in [t0, t1) (years after 2040), in time order. */
  eventsIn(b: number, t0: number, t1: number, out: GeoEvent[] = []): GeoEvent[] {
    out.length = 0;
    const tot = this.rateSum[b];
    if (tot <= 0 || t1 <= t0) return out;
    const pool = this.pool;
    let used = 0;
    const L = this.binLen(b), seed = this.seed, R = this.rate, o = b * NGEV;
    for (let bin = Math.floor(t0 / L), last = Math.floor((t1 - 1e-9) / L); bin <= last; bin++) {
      const k = poissonInv(gh(seed, b, bin, 0), tot * L);
      for (let j = 0; j < k; j++) {
        const t = bin * L + L * gh(seed, b, bin, j * 8 + 2);
        if (t < t0 || t >= t1) continue;
        let x = gh(seed, b, bin, j * 8 + 1) * tot, cls = 0;
        while (cls < NGEV - 1 && x >= R[o + cls]) { x -= R[o + cls]; cls++; }
        const zz = 2 * gh(seed, b, bin, j * 8 + 3) - 1, ph = 2 * Math.PI * gh(seed, b, bin, j * 8 + 4), s = Math.sqrt(1 - zz * zz);
        const ev = pool[used] ?? (pool[used] = { cls: 0, t: 0, x: 0, y: 0, z: 0, m: 0, d: 0, j: 0 });
        used++;
        ev.cls = cls; ev.t = t; ev.x = s * Math.cos(ph); ev.y = zz; ev.z = s * Math.sin(ph);
        ev.m = gh(seed, b, bin, j * 8 + 5); ev.d = gh(seed, b, bin, j * 8 + 6); ev.j = gh(seed, b, bin, j * 8 + 7);
        // insertion in time order (a handful at most)
        let i = out.length;
        out.push(ev);
        while (i > 0 && out[i - 1].t > t) { out[i] = out[i - 1]; i--; }
        out[i] = ev;
      }
    }
    return out;
  }

  /** Whether an impact of class c on body b is deflected: a planetary defence needs asteroid mining and nuclear propulsion known there,
   *  and someone to defend (Earth, or a colony or bigger). Big impactors are found decades ahead; small ones often are not. */
  deflected(st: { S: Float64Array; techDone: Float64Array; techWhere: Float64Array }, b: number, c: number, t: number, d: number): boolean {
    if (!isImpact(c) || c === GEV.AIR20) return false;
    if (b !== this.earth && st.S[b * NF + F.stage] < STAGE.COLONY) return false;
    if (!isAlive(st.S[b * NF + F.stage])) return false;
    if (!this.knows(st, T_MINE, b, t) || !this.knows(st, T_NTP, b, t)) return false;
    return d < (c === GEV.TUNG ? 0.6 : c === GEV.R140 ? 0.95 : 0.99);
  }

  /** A fresh geo block: every Solar System world at its observed state, Earth in 2040. */
  init(rows: number): { geo: Float64Array; geoG: Float64Array; scars: Float64Array } {
    const geo = new Float64Array(rows * NGEO), geoG = new Float64Array(NGG), scars = new Float64Array(MAX_SCARS * NSC);
    for (let b = 0; b < this.nSol; b++) this.initRow(geo, b, b);
    geoG[GG.cEff] = GW_2040 / TCRE; geoG[GG.emis] = EMIS_2040;
    geoG[GG.sTh] = SEA_2040.th; geoG[GG.sGl] = SEA_2040.gl; geoG[GG.sGr] = SEA_2040.gr; geoG[GG.sAn] = SEA_2040.an;
    geoG[GG.shadeOn] = -1;
    return { geo, geoG, scars };
  }

  /** Row r takes body b's baseline. */
  initRow(geo: Float64Array, r: number, b: number): void {
    const o = r * NGEO;
    geo.fill(0, o, o + NGEO);
    geo[o + GF.tAnom] = b === this.earth ? GW_2040 : 0;
    geo[o + GF.ice] = this.baseIce[b];
    geo[o + GF.pAtm] = this.baseP[b];
    geo[o + GF.cloud] = this.baseCloud[b];
    geo[o + GF.vol] = this.baseVol[b];
    geo[o + GF.field] = this.baseField[b];
    geo[o + GF.lastEv] = -1; geo[o + GF.lastEvT] = -1;
    geo[o + GF.aeroTau] = 1;
    if (b === this.earth) { geo[o + GF.capN] = 18; geo[o + GF.capS] = 26; }
    else if (b === this.mars) { geo[o + GF.capN] = 10; geo[o + GF.capS] = 4; }
    else { const c = this.baseIce[b] < 0.005 ? 0 : this.baseIce[b] >= 0.9 ? 90 : Math.min(90, 8 + 60 * this.baseIce[b]); geo[o + GF.capN] = c; geo[o + GF.capS] = c; }
  }

  /** Geo row of body b (pos: index in st.settled, -1 if never settled; -1: no row). */
  row(b: number, pos: Int32Array): number { return b < this.nSol ? b : pos[b] >= 0 ? this.nSol + pos[b] : -1; }

  /** Advance every Solar System world and every living settlement elsewhere over [year, year + dt), and set this step's
   *  coupling to the settlements: food, energy, capacity and habitability multipliers. */
  step(h: GeoHost, st: GeoState, fx: Fx, pos: Int32Array, year: number, dt: number): void {
    for (const b of this.touched) { this.foodMul[b] = 1; this.energyMul[b] = 1; this.capMul[b] = 1; this.habAdd[b] = 0; }
    this.touched.length = 0;
    this.pos = pos;
    this.earthCarbon(st, year, dt);
    // star systems with living settlements, Sol first, in founding order (for stellar storms and the sky)
    const mark = ++this.markGen, sys = this.sysList, bodies = this.world.bodies, S = st.S;
    sys.length = 0; sys.push(0); this.sysMark[0] = mark;
    this.sysDim[0] = Math.pow(1 - SWARM_SHADE * Math.min(1, this.sysCov[0]), 0.25) - 1;
    for (let b = 0; b < this.nSol; b++) this.world_(h, st, fx, b, b, year, dt);
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n], stg = S[b * NF + F.stage];
      if (stg < STAGE.OUTPOST || stg > STAGE.UPLOADED) continue;
      const s = bodies[b].system;
      if (this.sysMark[s] !== mark) { this.sysMark[s] = mark; sys.push(s); this.sysDim[s] = Math.pow(1 - SWARM_SHADE * Math.min(1, this.sysCov[s]), 0.25) - 1; }
      if (b < this.nSol) continue;
      const r = this.nSol + n, o = r * NGEO;
      // most settlements, most steps: nothing happens to the world itself, only the human forcing moves
      if (this.steady(st, b, r, stg, year, dt)) {
        const heat = this.heatSpan[b] * Math.min(1, Math.max(0, S[b * NF + F.heatLoad])), dim = Math.max(bodies[b].temp, 3) * this.sysDim[s], geo = st.geo;
        geo[o + GF.tAnom] += heat - geo[o + GF.heatK] + dim - geo[o + GF.dimK];
        geo[o + GF.heatK] = heat; geo[o + GF.dimK] = dim; geo[o + GF.avgAero] = 0; geo[o + GF.avgCool] = 0;
        S[b * NF + F.tempAnom] = geo[o + GF.tAnom]; S[b * NF + F.aerosol] = 0;
        const dev = Math.abs(heat + dim);
        if (dev > 1) { this.habAdd[b] = -Math.min(0.3, 0.02 * (dev - 1)); this.touched.push(b); }
      } else this.world_(h, st, fx, b, r, year, dt);
    }
    this.stars(h, st, year, dt);
    this.sky(h, st, year, dt);
  }

  /** Earth's carbon: emissions fall ≈ 2% a year until clean energy (fusion) reaches Earth, then with an e-fold of 15 years;
   *  the warming they leave persists for millennia. */
  private earthCarbon(st: GeoState, year: number, dt: number): void {
    const G = st.geoG, e = this.earth;
    const clean = this.knows(st, TX('fusion'), e, year);
    const k = 0.02 + (clean ? 1 / 15 : 0);
    const emitted = G[GG.emis] * (1 - Math.exp(-k * dt)) / k;
    G[GG.emis] *= Math.exp(-k * dt);
    G[GG.cEff] = G[GG.cEff] * Math.exp(-dt / C_DRAWDOWN) + emitted;
  }

  /** Earth's sea level and ice from its slow warming T (K over pre-industrial): four reservoirs relaxing to their commitment. */
  private earthIce(st: GeoState, o: number, T: number, dt: number): void {
    const G = st.geoG, geo = st.geo;
    const relax = (k: number, eq: number, tau: number) => { G[k] += (eq - G[k]) * (1 - Math.exp(-dt / tau)); };
    relax(GG.sTh, SEA.th * T, SEA.tauTh);
    relax(GG.sGl, T > 0 ? SEA.gl * (1 - Math.exp(-T / 2)) : 0.3 * T, SEA.tauGl);
    // ice sheets melt faster than they regrow
    const eqGr = SEA.gr * sstep(0.8, 4, T), eqAn = T > 0 ? SEA.an * T : 0.5 * T;
    relax(GG.sGr, eqGr, G[GG.sGr] > eqGr ? SEA.tauGr * 2 : SEA.tauGr);
    relax(GG.sAn, eqAn, G[GG.sAn] > eqAn ? SEA.tauAn * 2 : SEA.tauAn);
    geo[o + GF.sea] = G[GG.sTh] + G[GG.sGl] + G[GG.sGr] + G[GG.sAn] - SEA0;
    // sea ice answers in decades: the Arctic loses its summer ice near +2 K and most of its winter ice by +6 K
    const seaIce = Math.min(1.5, Math.max(0, 1 - (T - 1) / 5));
    const land = 1 - 0.6 * Math.max(0, G[GG.sGr]) / SEA.gr - 0.25 * Math.max(0, G[GG.sAn]) / 20;
    geo[o + GF.ice] = 0.1 * (0.5 * seaIce + 0.5 * land);
    geo[o + GF.capN] = 6 + 10 * seaIce + 4 * (1 - Math.max(0, G[GG.sGr]) / SEA.gr);
    geo[o + GF.capS] = 20 + 5 * seaIce + 3 * (1 - Math.max(0, G[GG.sAn]) / 20);
  }

  /** One world over the step: its natural events, human forcing, terraforming, the slow climate and the coupling. */
  private world_(h: GeoHost, st: GeoState, fx: Fx, b: number, r: number, year: number, dt: number): void {
    const geo = st.geo, S = st.S, o = r * NGEO, so = b * NF, body = this.world.bodies[b];
    const T0 = Math.max(body.temp, 3);
    const t1 = year + dt;
    // ---- natural events, in time order; the aerosol is integrated between them so the step's mean cooling is exact
    const air = this.baseP[b] > 0.05 || geo[o + GF.pAtm] > 0.05;
    const I = this.integ;
    I[0] = 0; I[1] = 0; I[2] = 0; I[3] = year;
    let stormFrac = 0;
    if (this.rateSum[b] > 0 && this.mayHave(b, year, t1)) {
      for (const ev of this.eventsIn(b, year, t1, this.evs)) {
        if (!isAlive(S[so + F.stage]) && b >= this.nSol) break;
        this.segment(geo, o, ev.t);
        stormFrac += this.apply(h, st, b, r, ev, air, t1) / dt;
      }
    }
    this.segment(geo, o, t1);
    const aeroSum = I[0], coolSum = I[1], lossSum = I[2];
    // Mars: global dust storms in the perihelion season (until terraforming has given it thick, wet air)
    if (b === this.mars && geo[o + GF.terra] < 0.6) {
      for (let n = marsYear(Y0 + year) - 1; marsTimeAt(n, 0) < Y0 + t1; n++) {
        const s = marsStorm(this.seed, n);
        if (!s) continue;
        const a = Math.max(Y0 + year, s.start), z = Math.min(Y0 + t1, s.end);
        if (z > a) stormFrac += (z - a) / dt;
        if (s.start >= Y0 + year && s.start < Y0 + t1) {
          h.log(EV['Dust storm'], b, Math.round(s.tau * 10) / 10, Math.round((s.end - s.start) * 100) / 100);
          geo[o + GF.lastEv] = EV['Dust storm']; geo[o + GF.lastEvT] = s.start - Y0;
        }
      }
    }
    geo[o + GF.avgAero] = aeroSum / dt;
    geo[o + GF.avgCool] = coolSum / dt;
    const stg = S[so + F.stage], alive = isAlive(stg);
    // ---- human forcing: waste heat (the engine's surface load against what the world can shed) and the swarm's shade
    geo[o + GF.heatK] = alive ? this.heatSpan[b] * Math.min(1, Math.max(0, S[so + F.heatLoad])) : 0;
    geo[o + GF.dimK] = T0 * this.sysDim[body.system];
    // ---- terraforming: paid for in energy, it thickens the air, warms (or cools) the world, melts its caps and fills its seas
    const terra0 = geo[o + GF.terra];
    let terra = terra0;
    if (alive && stg >= STAGE.CITY && this.terraOK[b] && S[so + F.stability] > 0.35) {
      const para = this.knows(st, T_PARA, b, year), full = this.knows(st, T_TERRA, b, year);
      if (para || full) {
        const mag = this.knows(st, T_MAG, b, year);
        const eff = (full ? 1 : 0.25) * (mag || this.baseField[b] >= 0.3 ? 1 : 0.5);
        terra = Math.min(1, terra + TERRA_SHARE * S[so + F.energy] * 3.156e7 * dt * eff / (E_TERRA * this.area[b]));
        if (mag) geo[o + GF.field] = Math.max(geo[o + GF.field], 1);
      }
    } else if (!alive && terra > 0) terra *= Math.exp(-dt / 2000); // abandoned, the new air slowly leaks and freezes out
    geo[o + GF.terra] = terra;
    if (alive && terra !== terra0) for (let k = 1; k <= 3; k++) {
      const x = TERRA_MILES[k - 1];
      if (terra0 < x && terra >= x) { h.log(EV['Terraforming milestone'], b, k); if (k === 2) st.geoG[GG.terraformed]++; }
    }
    const P0 = this.baseP[b];
    if (P0 >= 0) {
      geo[o + GF.pAtm] = P0 + (1 - P0) * sstep(0, 0.6, terra);
      geo[o + GF.cloud] = this.baseCloud[b] + (0.5 - this.baseCloud[b]) * sstep(0.3, 0.9, terra);
      if (b !== this.earth) geo[o + GF.ice] = this.baseIce[b] * (1 - sstep(0.2, 0.7, terra));
    }
    const tTerra = P0 >= 0 ? (288 - T0) * sstep(0.1, 0.9, terra) : 0;
    // ---- the slow climate
    if (b === this.earth) {
      const gw = TCRE * st.geoG[GG.cEff];
      this.sunshade(h, st, o, gw + geo[o + GF.heatK] + geo[o + GF.dimK], year, dt);
      const T = gw + geo[o + GF.heatK] + geo[o + GF.dimK] + geo[o + GF.shade];
      this.earthIce(st, o, T, dt);
      geo[o + GF.tAnom] = T;
      // the coasts: a few per cent of the room lost to the sea and to heat (Earth stays habitable)
      this.capMul[b] = Math.max(0.85, 1 - 0.004 * Math.max(0, geo[o + GF.sea]) - 0.01 * Math.max(0, T - 3));
      const sea = geo[o + GF.sea], mile = [1, 2, 5, 10, 20, 50], k = st.geoG[GG.seaMile];
      if (k < mile.length && sea >= mile[k]) { h.log(EV['Seas rise'], b, mile[k]); st.geoG[GG.seaMile]++; }
    } else {
      geo[o + GF.tAnom] = tTerra + geo[o + GF.heatK] + geo[o + GF.dimK];
      if (b === this.mars || terra > 0) {
        const perm = 1 - sstep(0.15, 0.6, terra);
        geo[o + GF.capN] = 10 * perm; geo[o + GF.capS] = 4 * perm;
      }
    }
    // ---- what it costs the people here this step
    if (alive) {
      // a cold year fails the open fields; indoor farms (synthetic biology, then nanofabrication) barely notice
      const fields = b === this.earth ? 1 : air && (terra > 0.3 || body.hab > 0.6) ? Math.max(0.1, terra) : 0.1;
      const shelter = (fx.lifeSupport >= 1.5 ? 0.5 : 1) * (this.knows(st, T_NANO, b, year) ? 0.4 : 1);
      this.foodMul[b] = 1 - (lossSum / dt) * fields * shelter;
      // solar power under dust and haze; fission (where the starlight is weak, the main source) does not care
      const solar = fx.fission > 0 ? (body.flux >= 1 ? 0.6 : 0.3) : 1, haze = geo[o + GF.avgAero] > 0 ? 1 - Math.exp(-geo[o + GF.avgAero]) : 0;
      this.energyMul[b] = Math.max(0.1, 1 - Math.min(1, stormFrac) * solar * 0.85 - haze * solar * 0.3);
      // climate pushed away from what the place was built for costs habitability (terraforming's own warming does not); so does a dark sky
      const dev = b === this.earth ? geo[o + GF.tAnom] - GW_2040 - geo[o + GF.avgCool] : geo[o + GF.heatK] + geo[o + GF.dimK] - geo[o + GF.avgCool];
      this.habAdd[b] = -Math.min(0.3, 0.02 * Math.max(0, Math.abs(dev) - 1) + 0.1 * haze);
      S[so + F.terraform] = 0.5 * terra;
      this.touched.push(b);
    }
    // what the data desk and the query language see
    S[so + F.tempAnom] = geo[o + GF.tAnom] - geo[o + GF.avgCool];
    S[so + F.seaLevel] = geo[o + GF.sea];
    S[so + F.aerosol] = geo[o + GF.avgAero];
    S[so + F.pressure] = geo[o + GF.pAtm];
  }

  /** Earth's sunshade: once nanofabrication reaches Earth and a stable Earth is still well above +1.5 K, a shade at L1 is raised
   *  and pulls the warming back toward +1 K over a few decades; in disorder it is neglected and the warming returns. */
  private sunshade(h: GeoHost, st: GeoState, o: number, T: number, year: number, dt: number): void {
    const G = st.geoG, geo = st.geo, stab = st.S[this.earth * NF + F.stability];
    if (G[GG.shadeOn] < 0) {
      if (T > 1.5 && stab > 0.45 && this.knows(st, T_NANO, this.earth, year)) {
        G[GG.shadeOn] = year;
        h.log(EV['Sunshade raised'], this.earth, 0, Math.round(T * 100) / 100);
      }
      return;
    }
    const target = stab > 0.3 ? -Math.max(0, T - 1) : 0;
    geo[o + GF.shade] += (target - geo[o + GF.shade]) * (1 - Math.exp(-dt / 40));
  }

  /**
   * The aftermath of an impact the impact model rolled on body b (row r): stratospheric haze on a world with air (the
   * impact-winter pulse of the nearest size class), a lasting crater scar for 100 m and up, and the tallies.
   * Returns the peak cooling (K).
   */
  impactAftermath(st: GeoState, b: number, r: number, dir: [number, number, number], diameterM: number, t: number): number {
    const c = diameterM >= 5000 ? GEV.KM10 : diameterM >= 500 ? GEV.KM1 : diameterM >= 100 ? GEV.R140 : -1;
    if (c < 0) return 0;
    const geo = st.geo, o = r * NGEO, f = FX[c], air = this.baseP[b] > 0.05 || geo[o + GF.pAtm] > 0.05;
    const ev: GeoEvent = { cls: c, t, x: dir[0], y: dir[1], z: dir[2], m: 0.5, d: 1, j: 0.5 };
    let tau = 0;
    if (air && f.aero[1] > 0) {
      tau = f.aero[0] + (f.aero[1] - f.aero[0]) * ev.m;
      const now = aeroAt(geo, o, t);
      geo[o + GF.aeroTau] = now > tau ? (geo[o + GF.aeroTau] * now + f.aeroTau * tau) / (now + tau) : f.aeroTau;
      geo[o + GF.aero0] = now + tau; geo[o + GF.aeroT] = t;
    }
    const rad = c === GEV.R140 ? 0.012 : c === GEV.KM1 ? 0.03 : 0.08;
    this.scar(st, b, ev, rad, SCAR.CRATER, b === this.earth ? 400 : air ? 3000 : 1e9);
    st.geoG[GG.impacts]++; geo[o + GF.nImp]++;
    return Math.round(aeroCooling(tau) * 10) / 10;
  }

  /** Apply one natural event on body b (row r). Returns the years of this step a dust storm darkened the sky. */
  private apply(h: GeoHost, st: GeoState, b: number, r: number, ev: GeoEvent, air: boolean, t1: number): number {
    const S = st.S, so = b * NF, geo = st.geo, o = r * NGEO, G = st.geoG, c = ev.cls, f = FX[c];
    const stg = S[so + F.stage], alive = isAlive(stg), pop = S[so + F.pop];
    if (isImpact(c) && this.deflected(st, b, c, ev.t, ev.d)) {
      // written up on Earth, and elsewhere when the rock was big enough to matter
      if (b === this.earth || c >= GEV.R140) h.log(EV['Impact averted'], b, IMPACT_M[c]);
      return 0;
    }
    // the stratosphere: volcanic and impact winters on worlds with air
    let tau = 0;
    if (air && f.aero[1] > 0) {
      tau = f.aero[0] + (f.aero[1] - f.aero[0]) * ev.m;
      const now = aeroAt(geo, o, ev.t);
      geo[o + GF.aeroTau] = now > tau ? (geo[o + GF.aeroTau] * now + f.aeroTau * tau) / (now + tau) : f.aeroTau;
      geo[o + GF.aero0] = now + tau; geo[o + GF.aeroT] = ev.t;
    }
    const cool = Math.round(aeroCooling(tau) * 10) / 10;
    // lasting scars: impact craters (drawn larger than life), supervolcano calderas
    if ((c === GEV.R140 || c === GEV.KM1 || c === GEV.KM10 || c === GEV.VEI8) && (b < this.nSol || alive)) {
      const rad = c === GEV.R140 ? 0.012 : c === GEV.KM1 ? 0.03 : c === GEV.KM10 ? 0.08 : 0.04;
      this.scar(st, b, ev, rad, c === GEV.VEI8 ? SCAR.LAVA : SCAR.CRATER, b === this.earth ? 400 : air ? 3000 : 1e9);
    }
    if (isImpact(c) && c >= GEV.R140) { G[GG.impacts]++; geo[o + GF.nImp]++; }
    if (c === GEV.VEI7 || c === GEV.VEI8) G[GG.eruptions]++;
    // people: those near the event, by distance to each settlement (the same places the views draw)
    let k = 0;
    // (a Chelyabinsk-class airburst only matters over Earth's crowded cities)
    if (alive && pop > 0 && f.sev > 0 && (c !== GEV.AIR20 || b === this.earth)) {
      const R = this.world.bodies[b].radius, n = cityCount(stg, pop), cu = this.cityUnits(b);
      // no settlement can reach further than the damage plus the biggest city's radius: reject on the dot product first
      const cosMax = Math.cos(Math.min(Math.PI, (f.dev + 400) / R));
      let dead = 0;
      for (let i = 0; i < n; i++) {
        const dot = cu[i * 3] * ev.x + cu[i * 3 + 1] * ev.y + cu[i * 3 + 2] * ev.z;
        if (dot < cosMax) continue;
        const share = cityShare(n, i), d = R * Math.acos(Math.min(1, dot));
        // the settlement as a disc of radius rc (km); the damage as a disc of radius f.dev; deaths by the share of the city inside it
        const rc = Math.min(400, 0.6 * Math.sqrt(pop * share / 1000)), reach = f.dev + rc;
        if (d < reach) dead += pop * share * f.sev * Math.min(1, (f.dev * f.dev) / (rc * rc)) * (d < rc ? 1 : 1 - (d - rc) / f.dev) * (0.5 + ev.j);
      }
      // global killers: the blast, fires and tsunamis of a kilometre-class impact; the ashfall of a supereruption
      if (c === GEV.KM1) dead += pop * (0.02 + 0.08 * ev.j);
      if (c === GEV.KM10) dead += pop * (0.3 + 0.4 * ev.j);
      if (c === GEV.VEI8) dead += pop * 0.001;
      k = Math.min(0.95, dead / pop);
    }
    // news: on Earth anything that touched a city; elsewhere a disaster that killed a thousand people
    const earth = b === this.earth, near = k > 1e-7, news = earth ? near : k * pop >= 1000;
    // the event log, for the Chronicle, the ticker and the people who lived through it
    let type = -1, a = 0, bb = 0;
    switch (c) {
      case GEV.AIR20: if (news) { type = EV.Airburst; a = 20; bb = k; } break;
      case GEV.TUNG: if (earth || k * pop >= 100) { type = EV.Airburst; a = 50; bb = k; } break;
      case GEV.R140: if (alive) { type = EV['Asteroid strike']; a = k; bb = 140; } break;
      case GEV.KM1: case GEV.KM10: if (air) { type = EV['Impact winter']; a = IMPACT_M[c] / 1000; bb = cool; } else if (alive) { type = EV['Asteroid strike']; a = k; bb = IMPACT_M[c]; } break;
      case GEV.VEI6: if (news) { type = EV.Eruption; a = 6; bb = cool; } break;
      case GEV.VEI7: if (earth || news) { type = EV.Eruption; a = 7; bb = cool; } break;
      case GEV.VEI8: type = EV.Supereruption; a = 8; bb = cool; break;
      case GEV.QUAKE: if (news) { type = EV['Great earthquake']; a = Math.round((9 + 0.5 * ev.m) * 10) / 10; bb = k; } break;
      case GEV.IO: if (news) { type = EV['Io outburst']; a = k; } break;
      // fresh water from a plume matters to a small colony; a big one barely notices
      case GEV.PLUME: if (alive) { const w = pop * 20 + 1e4; S[so + F.water] += w; if (pop < 1e6) { type = EV['Plume surge']; a = Math.round(w); } } break;
      case GEV.JSL9: type = EV['Jupiter impact']; a = 5 + Math.floor(ev.m * 17); break;
      case GEV.VENUS: case GEV.LAVA: if (news) { type = EV.Eruption; a = 0; bb = k; } break;
      case GEV.DUST: break;
    }
    if (k > 0) {
      S[so + F.pop] *= 1 - k;
      if (isImpact(c) || c === GEV.VEI8 || c === GEV.QUAKE) S[so + F.capital] *= 1 - Math.min(0.5, k * 0.6);
      h.disaster(b, type >= 0 ? type : EV.Eruption, k);
      // a small colony that took the full blow of an impact is gone
      if (isImpact(c) && k > 0.65 && stg <= STAGE.COLONY) h.kill(b);
    }
    if (type >= 0) {
      if (b < this.nSol || alive) h.log(type, b, a, bb);
      geo[o + GF.lastEv] = type; geo[o + GF.lastEvT] = ev.t;
    }
    if (c === GEV.DUST) {
      const dur = 0.2 + 0.3 * ev.m;
      if (alive) { geo[o + GF.lastEv] = EV['Dust storm']; geo[o + GF.lastEvT] = ev.t; }
      return Math.max(0, Math.min(t1, ev.t + dur) - ev.t);
    }
    return 0;
  }

  private cities = new Map<number, Float64Array>();
  /** Unit directions of every settlement a world can have (cached: they never move). */
  private cityUnits(b: number): Float64Array {
    let c = this.cities.get(b);
    if (!c) { c = new Float64Array(48 * 3); for (let i = 0; i < 48; i++) c.set(cityUnit(b, i), i * 3); this.cities.set(b, c); }
    return c;
  }

  private scar(st: GeoState, b: number, ev: GeoEvent, rad: number, kind: number, fade: number): void {
    const G = st.geoG, i = G[GG.nScar] % MAX_SCARS, o = i * NSC, s = st.scars;
    s[o + SC.body] = b; s[o + SC.x] = ev.x; s[o + SC.y] = ev.y; s[o + SC.z] = ev.z;
    s[o + SC.rad] = rad; s[o + SC.year] = ev.t; s[o + SC.kind] = kind; s[o + SC.fade] = fade;
    G[GG.nScar]++;
  }

  /** Stellar storms on every star with living settlements (and the Sun): Carrington-class storms hurt small unshielded outposts close in;
   *  Miyake-class events also knock out grids and orbital infrastructure, in proportion to how much a civilisation depends on them. */
  private stars(h: GeoHost, st: GeoState, year: number, dt: number): void {
    const w = this.world, t1 = year + dt;
    for (const s of this.sysList) {
      const [carr, miy] = stellarRates(w.systems[s].spec), tot = carr + miy, L = s === 0 ? 1 : 10, p0 = this.starP0[s];
      for (let bin = Math.floor(year / L), last = Math.floor((t1 - 1e-9) / L); bin <= last; bin++) {
        const u0 = gh(this.seed, KEY_STAR + s, bin, 0);
        if (u0 <= p0) continue;
        const nk = poissonInv(u0, tot * L);
        for (let j = 0; j < nk; j++) {
          const t = bin * L + L * gh(this.seed, KEY_STAR + s, bin, j * 4 + 1);
          if (t < year || t >= t1) continue;
          const big = gh(this.seed, KEY_STAR + s, bin, j * 4 + 2) * tot >= carr, u = gh(this.seed, KEY_STAR + s, bin, j * 4 + 3);
          this.storm(h, st, s, big, u, t);
        }
      }
    }
  }

  /** Stellar storms of system s with t in [t0, t1): the same stream the step applies. */
  stormsIn(s: number, t0: number, t1: number): { t: number; big: boolean }[] {
    const out: { t: number; big: boolean }[] = [];
    const [carr, miy] = stellarRates(this.world.systems[s].spec), tot = carr + miy, L = s === 0 ? 1 : 10;
    for (let bin = Math.floor(t0 / L), last = Math.floor((t1 - 1e-9) / L); bin <= last; bin++) {
      const nk = poissonInv(gh(this.seed, KEY_STAR + s, bin, 0), tot * L);
      for (let j = 0; j < nk; j++) {
        const t = bin * L + L * gh(this.seed, KEY_STAR + s, bin, j * 4 + 1);
        if (t >= t0 && t < t1) out.push({ t, big: gh(this.seed, KEY_STAR + s, bin, j * 4 + 2) * tot >= carr });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  private storm(h: GeoHost, st: GeoState, s: number, big: boolean, u: number, t: number): void {
    const S = st.S, w = this.world;
    st.geoG[GG.stellar]++;
    let hit = 0, top = -1, topPop = -1, dead = 0;
    let known = 0;
    if (big) for (let i = 0; i < st.techDone.length; i++) if (st.techDone[i] >= 0) known++;
    const share = big ? (0.004 + 0.012 * u) * Math.min(1, known / TECHS.length + 0.3) : 0.0005 + 0.0015 * u;
    for (const b of w.systems[s].bodies) {
      const so = b * NF, stg = S[so + F.stage];
      if (!isAlive(stg)) continue;
      const body = w.bodies[b];
      if (S[so + F.pop] > topPop) { topPop = S[so + F.pop]; top = b; }
      if (body.flux < 0.03) continue;
      const r = this.row(b, this.pos);
      const field = r >= 0 ? st.geo[r * NGEO + GF.field] : this.baseField[b];
      // shielded by a magnetic field, by shielding known here, or brought along by the founders (a place founded after it was invented)
      const rad = st.techDone[T_RAD];
      const shielded = field >= 0.3 || this.knows(st, T_RAD, b, t) || (rad >= 0 && S[so + F.founded] >= rad);
      // grids and satellites: every settlement pays, those that rely on orbit most
      if (big) { S[so + F.capital] *= 1 - share * (b === this.earth ? 1 : 2); hit++; }
      else if (b === this.earth) S[so + F.capital] *= 1 - share;
      // unshielded crews on the surface of a small place take the dose
      if (!shielded && stg <= STAGE.TOWN) {
        const k = big ? 0.003 + 0.02 * u : 0.001 + 0.01 * u;
        S[so + F.pop] *= 1 - k;
        h.disaster(b, EV['Solar storm'], k); dead++;
        if (!big && s === 0) h.log(EV['Solar storm'], b, k); // around other stars small storms are weather
        if (big) hit++;
      }
    }
    // written up around the Sun, and elsewhere when it killed someone
    if (big) { st.geoG[GG.solar]++; if (s === 0 || dead) h.log(EV['Solar superstorm'], top >= 0 ? top : this.earth, hit, Math.round(share * 10000) / 10000); }
  }

  /** Comets, the Red Spot, a naked-eye supernova, and the nearby stellar explosions that could actually hurt someone. */
  private sky(h: GeoHost, st: GeoState, year: number, dt: number): void {
    const Y = Y0 + year, Y1 = Y + dt, G = st.geoG, S = st.S;
    for (const r of this.halley) if (r.t >= Y && r.t < Y1) h.log(EV['Comet return'], this.earth, 0, r.miss);
    for (const r of SWIFT_TUTTLE) if (r.t >= Y && r.t < Y1) h.log(EV['Comet return'], this.earth, 1, r.miss);
    const ge = grsEnd(this.seed);
    if (ge !== null && ge >= Y && ge < Y1 && !G[GG.grsGone]) { G[GG.grsGone] = 1; h.log(EV['Red Spot fades'], this.jupiter); }
    const bg = betelgeuseYear(this.seed);
    if (bg !== null && bg >= Y && bg < Y1) { G[GG.sn]++; h.log(EV['Naked-eye supernova'], this.earth, 550); }
    // a supernova within ~30 ly of a settled system (ozone stripped, sterilising radiation): the galaxy makes ≈ 2 a century in
    // ≈ 8e12 cubic light years of disc, so the chance scales with the volume within 30 ly of humanity's systems. Gamma-ray bursts
    // beamed at a settled region: ≈ 1e-8 a year. Both use the geophysics stream, so they never reshuffle the engine's.
    const systems = this.sysList;
    const lamSN = 0.02 * systems.length * (4 / 3 * Math.PI * 30 ** 3) / 7.85e12, lamGRB = 1e-8;
    const rng = st.geoRng;
    const u = next(rng), v = next(rng);
    for (const [lam, type] of [[lamSN, EV.Supernova], [lamGRB, EV['Gamma-ray burst']]] as const) {
      if ((type === EV.Supernova ? u : v) >= 1 - Math.exp(-lam * dt)) continue;
      const centre = systems[Math.floor(next(rng) * systems.length)];
      const radius = type === EV.Supernova ? 25 + 25 * next(rng) : 200 + 1800 * next(rng);
      const c = this.world.systems[centre];
      let killed = 0, at = -1;
      for (let n = 0; n < st.nSettled; n++) {
        const b = st.settled[n], s = this.world.systems[this.world.bodies[b].system];
        if (b === this.earth || !isAlive(S[b * NF + F.stage]) || Math.hypot(s.x - c.x, s.y - c.y, s.z - c.z) > radius) continue;
        S[b * NF + F.pop] *= 0.1; killed++; if (at < 0) at = b;
        h.disaster(b, type, 0.9);
      }
      if (killed) { G[GG.sn]++; h.log(type, at, killed, Math.round(radius)); }
    }
  }
}

const TERRA_MILES = [0.25, 0.5, 0.9];
const T_MINE = TX('asteroidMining'), T_NTP = TX('ntp'), T_NANO = TX('nanofab'), T_RAD = TX('radShield');

/** What the views get with a state: the run's seed, the geo rows (Solar System bodies, then settlements in st.settled order), globals and scars. */
export interface GeoSnap { seed: number; rows: Float64Array; g: Float64Array; scars: Float64Array }

/** The parts of SimState the geo step reads and writes. */
export interface GeoState {
  S: Float64Array; settled: Int32Array; nSettled: number; techDone: Float64Array; techWhere: Float64Array;
  geo: Float64Array; geoG: Float64Array; scars: Float64Array; geoRng: RngState;
}

/** Earth's warming over pre-industrial from carbon alone, K. */
export function co2Warming(geoG: Float64Array): number { return TCRE * geoG[GG.cEff]; }
