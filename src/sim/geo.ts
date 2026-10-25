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

import { isAlive, STAGE, TECHS, type BodyKind } from './catalog.ts';
import { techAt } from './diffusion.ts';
import { F, NF } from './metrics.ts';
import { hash01 } from './rng.ts';
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
export const SC = { body: 0, x: 1, y: 2, z: 3, rad: 4, year: 5, kind: 6, amp: 7 } as const;
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

export interface GeoHost {
  world: World;
  log(type: number, body: number, a?: number, b?: number): void;
  disaster(b: number, type: number, k: number): void;
}

/** Physical state, rates and the step for every world. One per engine (static tables, scratch); the state lives in SimState. */
export class Geo {
  readonly world: World;
  readonly seed: number;
  readonly nSol: number;
  readonly earth: number;
  readonly mars: number;
  /** static per body */
  readonly baseP: Float64Array; readonly baseCloud: Float64Array; readonly baseIce: Float64Array; readonly baseVol: Float64Array; readonly baseField: Float64Array;
  readonly ocean: Uint8Array; readonly heatSpan: Float64Array; readonly area: Float64Array;
  /** scratch, rebuilt every step before the settlements are processed */
  foodMul: Float64Array; energyMul: Float64Array; capMul: Float64Array; habAdd: Float64Array;
  private touched: number[] = [];
  /** per system: share of the star's light its swarm intercepts (written by the engine's systems pass) */
  sysCov: Float64Array;

  constructor(world: World, seed: number) {
    this.world = world; this.seed = seed;
    const nb = world.bodies.length;
    this.nSol = world.systems[0].bodies.length;
    this.earth = world.earth; this.mars = world.mars;
    this.baseP = new Float64Array(nb); this.baseCloud = new Float64Array(nb); this.baseIce = new Float64Array(nb);
    this.baseVol = new Float64Array(nb); this.baseField = new Float64Array(nb); this.ocean = new Uint8Array(nb);
    this.heatSpan = new Float64Array(nb); this.area = new Float64Array(nb);
    world.bodies.forEach((b, i) => {
      const base = b.system === 0 ? SOL_BASE[b.name] ?? procBase(b.kind, b.hab, b.temp, i) : procBase(b.kind, b.hab, b.temp, i);
      this.baseP[i] = base.p; this.baseCloud[i] = base.cloud; this.baseIce[i] = base.ice; this.baseVol[i] = base.vol; this.baseField[i] = base.field;
      this.ocean[i] = base.ocean ? 1 : 0;
      // the engine's waste-heat limit: a living world tolerates +3 K, a dead one radiators 30 K above its surface (never below 250 K)
      const T = Math.max(b.temp, 3);
      this.heatSpan[i] = (b.hab >= 0.3 ? T + 3 : Math.max(T + 30, 250)) - T;
      this.area[i] = Math.min(4, (b.radius / 3390) ** 2);
    });
    this.foodMul = new Float64Array(nb).fill(1); this.energyMul = new Float64Array(nb).fill(1);
    this.capMul = new Float64Array(nb).fill(1); this.habAdd = new Float64Array(nb);
    this.sysCov = new Float64Array(world.systems.length);
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
    else { const c = this.baseIce[b] >= 0.9 ? 90 : Math.min(90, 8 + 60 * this.baseIce[b]); geo[o + GF.capN] = c; geo[o + GF.capS] = c; }
  }

  /** Geo row of body b (pos: index in st.settled, -1 if never settled; -1: no row). */
  row(b: number, pos: Int32Array): number { return b < this.nSol ? b : pos[b] >= 0 ? this.nSol + pos[b] : -1; }

  /** Advance every Solar System world and every living settlement elsewhere over [year, year + dt), and set this step's
   *  coupling to the settlements: food, energy, capacity and habitability multipliers. */
  step(h: GeoHost, st: GeoState, fx: { lifeSupport: number; fission: number }, pos: Int32Array, year: number, dt: number): void {
    for (const b of this.touched) { this.foodMul[b] = 1; this.energyMul[b] = 1; this.capMul[b] = 1; this.habAdd[b] = 0; }
    this.touched.length = 0;
    const G = st.geoG;
    this.earthCarbon(st, year, dt);
    for (let b = 0; b < this.nSol; b++) this.world_(h, st, fx, b, b, year, dt);
    for (let n = 0; n < st.nSettled; n++) {
      const b = st.settled[n];
      if (b < this.nSol || !isAlive(st.S[b * NF + F.stage])) continue;
      this.world_(h, st, fx, b, this.nSol + n, year, dt);
    }
    void G;
  }

  /** Earth's carbon: emissions fall ≈ 2% a year until clean energy (fusion) reaches Earth, then with an e-fold of 15 years;
   *  the warming they leave persists for millennia. */
  private earthCarbon(st: GeoState, year: number, dt: number): void {
    const G = st.geoG, e = this.earth;
    const clean = techAt(this.world, st.techDone, st.techWhere, TX('fusion'), e, year);
    const k = 0.02 + (clean ? 1 / 15 : 0);
    const emitted = G[GG.emis] * (1 - Math.exp(-k * dt)) / k;
    G[GG.emis] *= Math.exp(-k * dt);
    G[GG.cEff] = G[GG.cEff] * Math.exp(-dt / C_DRAWDOWN) + emitted;
  }

  /** Earth's sea level and ice from its slow warming T (K over pre-industrial): four reservoirs relaxing to their commitment. */
  private earthIce(st: GeoState, o: number, T: number, dt: number): void {
    const G = st.geoG, geo = st.geo;
    const relax = (k: number, eq: number, tau: number, slowGrow = 1) => { const t = G[k] > eq ? tau : tau * slowGrow; G[k] += (eq - G[k]) * (1 - Math.exp(-dt / t)); };
    relax(GG.sTh, SEA.th * T, SEA.tauTh);
    relax(GG.sGl, T > 0 ? SEA.gl * (1 - Math.exp(-T / 2)) : 0.3 * T, SEA.tauGl);
    // ice sheets melt faster than they regrow
    relax(GG.sGr, SEA.gr * sstep(0.8, 4, T), G[GG.sGr] > SEA.gr * sstep(0.8, 4, T) ? SEA.tauGr * 2 : SEA.tauGr);
    relax(GG.sAn, T > 0 ? SEA.an * T : 0.5 * T, G[GG.sAn] > SEA.an * T ? SEA.tauAn * 2 : SEA.tauAn);
    geo[o + GF.sea] = G[GG.sTh] + G[GG.sGl] + G[GG.sGr] + G[GG.sAn] - SEA0;
    // sea ice answers in decades: the Arctic loses its summer ice near +2 K and most of its winter ice by +6 K
    const seaIce = Math.min(1.5, Math.max(0, 1 - (T - 1) / 5));
    const land = 1 - 0.6 * Math.max(0, G[GG.sGr]) / SEA.gr - 0.25 * Math.max(0, G[GG.sAn]) / 20;
    geo[o + GF.ice] = 0.1 * (0.5 * seaIce + 0.5 * land);
    geo[o + GF.capN] = 6 + 10 * seaIce + 4 * (1 - Math.max(0, G[GG.sGr]) / SEA.gr);
    geo[o + GF.capS] = 20 + 5 * seaIce + 3 * (1 - Math.max(0, G[GG.sAn]) / 20);
  }

  /** One world over the step: human forcing, terraforming, the slow climate and the coupling. */
  private world_(h: GeoHost, st: GeoState, fx: { lifeSupport: number; fission: number }, b: number, r: number, year: number, dt: number): void {
    const geo = st.geo, S = st.S, o = r * NGEO, so = b * NF, body = this.world.bodies[b];
    const stg = S[so + F.stage], alive = isAlive(stg);
    const T0 = Math.max(body.temp, 3);
    // waste heat (the engine's surface load against what the world can shed) and the swarm's shade
    geo[o + GF.heatK] = alive ? this.heatSpan[b] * Math.min(1, Math.max(0, S[so + F.heatLoad])) : 0;
    geo[o + GF.dimK] = T0 * (Math.pow(1 - SWARM_SHADE * Math.min(1, this.sysCov[body.system]), 0.25) - 1);
    // terraforming: paid for in energy, it thickens the air, warms (or cools) the world, melts its caps and fills its seas
    const terra0 = geo[o + GF.terra];
    let terra = terra0;
    if (alive && stg >= STAGE.CITY && body.hab < 0.8 && body.g >= 0.1 && this.baseP[b] >= 0 && body.kind !== 'asteroid' && S[so + F.stability] > 0.35) {
      const para = techAt(this.world, st.techDone, st.techWhere, T_PARA, b, year), full = techAt(this.world, st.techDone, st.techWhere, T_TERRA, b, year);
      if (para || full) {
        const mag = techAt(this.world, st.techDone, st.techWhere, T_MAG, b, year);
        const eff = (full ? 1 : 0.25) * (mag || this.baseField[b] >= 0.3 ? 1 : 0.5);
        terra = Math.min(1, terra + TERRA_SHARE * S[so + F.energy] * 3.156e7 * dt * eff / (E_TERRA * this.area[b]));
        if (mag) geo[o + GF.field] = Math.max(geo[o + GF.field], 1);
      }
    } else if (!alive && terra > 0) terra *= Math.exp(-dt / 2000); // abandoned, the new air slowly leaks and freezes out
    geo[o + GF.terra] = terra;
    const P0 = this.baseP[b];
    if (P0 >= 0) {
      geo[o + GF.pAtm] = P0 + (1 - P0) * sstep(0, 0.6, terra);
      geo[o + GF.cloud] = this.baseCloud[b] + (0.5 - this.baseCloud[b]) * sstep(0.3, 0.9, terra);
      if (b !== this.earth) geo[o + GF.ice] = this.baseIce[b] * (1 - sstep(0.2, 0.7, terra));
    }
    const tTerra = P0 >= 0 ? (288 - T0) * sstep(0.1, 0.9, terra) : 0;
    if (b === this.earth) {
      const gw = TCRE * st.geoG[GG.cEff];
      const T = gw + geo[o + GF.heatK] + geo[o + GF.dimK] + geo[o + GF.shade];
      this.earthIce(st, o, T, dt);
      geo[o + GF.tAnom] = T;
      // the coasts: a few per cent of the room lost to the sea and to heat (Earth stays habitable)
      this.capMul[b] = Math.max(0.85, 1 - 0.004 * Math.max(0, geo[o + GF.sea]) - 0.01 * Math.max(0, T - 3));
      this.touched.push(b);
    } else {
      geo[o + GF.tAnom] = tTerra + geo[o + GF.heatK] + geo[o + GF.dimK];
      if (b === this.mars || terra > 0) {
        const perm = 1 - sstep(0.15, 0.6, terra);
        geo[o + GF.capN] = 10 * perm; geo[o + GF.capS] = 4 * perm;
      }
    }
    if (alive) {
      // climate pushed away from what the place was built for costs habitability (terraforming's own warming does not)
      const dev = b === this.earth ? geo[o + GF.tAnom] - GW_2040 : geo[o + GF.heatK] + geo[o + GF.dimK];
      this.habAdd[b] = -Math.min(0.3, 0.02 * Math.max(0, Math.abs(dev) - 1));
      S[so + F.terraform] = 0.5 * terra;
      this.touched.push(b);
      void fx; void h;
    }
    // what the data desk and the query language see
    S[so + F.tempAnom] = geo[o + GF.tAnom] - geo[o + GF.avgCool];
    S[so + F.seaLevel] = geo[o + GF.sea];
    S[so + F.aerosol] = geo[o + GF.avgAero];
    S[so + F.pressure] = geo[o + GF.pAtm];
  }
}

/** The parts of SimState the geo step reads and writes. */
export interface GeoState {
  S: Float64Array; settled: Int32Array; nSettled: number; techDone: Float64Array; techWhere: Float64Array;
  geo: Float64Array; geoG: Float64Array; scars: Float64Array;
}

/** Earth's warming over pre-industrial from carbon alone, K. */
export function co2Warming(geoG: Float64Array): number { return TCRE * geoG[GG.cEff]; }
