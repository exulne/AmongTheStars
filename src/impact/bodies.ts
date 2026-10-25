// Body environment profiles for the impact laboratory, versioned. Bulk values
// are from the NASA Planetary Fact Sheet (NSSDCA, D. R. Williams; metric
// tables and the atmospheric notes for each planet); profiles are body-specific,
// never one generic exponential:
//   Earth   US Standard Atmosphere 1976 (0–1,000 km).
//   Venus   VIRA mean profile (Seiff et al. 1985, Adv. Space Res. 5:3), approximate tabulation.
//   Mars    Fact-sheet surface density and scale height near the surface, a colder,
//           shorter-scale middle atmosphere above 40 km, and the ±12% seasonal pressure
//           cycle of CO₂ condensation seen by Viking (Hess et al. 1980); NASA's Mars-GRAM
//           is the engineering reference for anything finer.
//   Giants  No solid surface. Altitude is measured from the 1-bar level; above it an
//           isothermal stratosphere at the fact-sheet scale height, below it a dry adiabat
//           (T rises at g/c_p, ρ ∝ T^(1/(γ−1))), which matches the Galileo probe's ≈ 22 bar
//           near 130 km depth at Jupiter to within a factor of two.
//   Titan   Huygens HASI surface values (Fulchignoni et al. 2005, Nature 438:785), extension.
//   Mercury, the Moon, Io, Europa, Pluto…: surface-bounded exospheres. No aerodynamic
//           shielding, no airburst.
// Deeper data: the NASA PDS Atmospheres Node; engineering atmospheres: NASA GRAM.

import type { Quality } from '../data/provenance.ts';
import { USSA76_TABLE } from '../orbit/thermosphere.ts';

export const PROFILE_VERSION = '1.0.0';
export const FACT_SHEET = 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/';

export type BodyClass = 'rocky-atmosphere' | 'airless' | 'gas-giant' | 'ice-giant';
export type Material = 'water' | 'sand' | 'dry-soil' | 'wet-soil' | 'soft-rock' | 'hard-rock' | 'ice';

export interface Atmosphere {
  kind: 'none' | 'thin' | 'substantial' | 'dense' | 'deep';
  /** reference pressure at h = 0 (Pa): the surface, or 1 bar for the giants */
  p0Pa: number;
  rho0: number;
  scaleHeightKm: number;
  tempK: number;
  composition: string;
  /** mean molar mass, kg/mol */
  molarMass: number;
  gamma: number;
  /** density (kg/m³) at altitude h km above the reference level (negative: below 1 bar, giants only) */
  density: (hKm: number, season?: number) => number;
  /** relative 1-sigma variability used by the Monte Carlo (season, weather) */
  variability: number;
  source: string;
}

export interface BodyProfile {
  id: string;
  name: string;
  version: string;
  cls: BodyClass;
  radiusKm: number;
  massKg: number;
  gm: number; // m³/s²
  gravity: number; // m/s² at the surface or 1-bar level
  escapeKms: number;
  rotationHours: number;
  solidSurface: boolean;
  atmosphere: Atmosphere;
  /** target materials and the share of the surface each covers */
  materials: { m: Material; share: number }[];
  /** surface water or volatile coverage */
  ocean: number;
  /** simple-to-complex crater transition scaling (Schenk et al. 2021) */
  transition: 'silicate' | 'ice' | null;
  /** typical encounter speed at infinity, km/s: [median, log sd], and the source */
  vInf: { median: number; logSd: number; source: string };
  source: string;
  quality: Quality;
  note?: string;
}

const G = 6.674e-11;

function table(rows: readonly (readonly [number, number])[]): (h: number) => number {
  return (h) => {
    if (h <= rows[0][0]) return rows[0][1];
    const last = rows[rows.length - 1];
    if (h >= last[0]) { const prev = rows[rows.length - 2]; const H = (last[0] - prev[0]) / Math.log(prev[1] / last[1]); return last[1] * Math.exp(-(h - last[0]) / H); }
    let i = 0;
    while (rows[i + 1][0] < h) i++;
    const [z0, r0] = rows[i], [z1, r1] = rows[i + 1];
    return Math.exp(Math.log(r0) + ((h - z0) / (z1 - z0)) * (Math.log(r1) - Math.log(r0)));
  };
}

/** Venus, VIRA mean (approximate tabulation, kg/m³). */
const VIRA: [number, number][] = [[0, 64.79], [10, 37.72], [20, 20.39], [30, 10.42], [40, 4.404], [50, 1.594], [60, 0.4694], [70, 0.08393], [80, 0.01252], [90, 1.4e-3], [100, 7.9e-5], [120, 3e-7]];

/** giant planet: isothermal above 1 bar, dry adiabat below */
function giant(rho1: number, H: number, T1: number, g: number, cp: number, gamma: number): (h: number) => number {
  return (h) => {
    if (h >= 0) return rho1 * Math.exp(-h / H);
    const T = T1 + (g / cp) * (-h * 1000);
    return rho1 * (T / T1) ** (1 / (gamma - 1));
  };
}

const mk = (p: Omit<BodyProfile, 'gm' | 'escapeKms' | 'version'> & { escapeKms?: number }): BodyProfile => {
  const gm = G * p.massKg;
  return { ...p, gm, escapeKms: p.escapeKms ?? Math.sqrt((2 * gm) / (p.radiusKm * 1e3)) / 1e3, version: PROFILE_VERSION };
};

const NONE = (note: string, p0 = 0): Atmosphere => ({ kind: 'none', p0Pa: p0, rho0: 0, scaleHeightKm: 0, tempK: 0, composition: note, molarMass: 0, gamma: 1.4, density: () => 0, variability: 0, source: FACT_SHEET });

export const BODIES: Record<string, BodyProfile> = {
  Mercury: mk({
    id: 'Mercury', name: 'Mercury', cls: 'airless', radiusKm: 2439.7, massKg: 0.330e24, gravity: 3.7, escapeKms: 4.3, rotationHours: 1407.6, solidSurface: true,
    atmosphere: NONE('surface-bounded exosphere (O, Na, H, He, K); total pressure below 5e-15 bar'),
    materials: [{ m: 'dry-soil', share: 0.7 }, { m: 'soft-rock', share: 0.3 }], ocean: 0, transition: 'silicate',
    vInf: { median: 30, logSd: 0.3, source: 'High heliocentric speeds near the Sun (Marchi et al. 2005, A&A 431:1123); estimated' },
    source: FACT_SHEET, quality: 'high',
  }),
  Venus: mk({
    id: 'Venus', name: 'Venus', cls: 'rocky-atmosphere', radiusKm: 6051.8, massKg: 4.87e24, gravity: 8.87, escapeKms: 10.36, rotationHours: -5832.5, solidSurface: true,
    atmosphere: { kind: 'dense', p0Pa: 9.2e6, rho0: 65, scaleHeightKm: 15.9, tempK: 737, composition: 'CO₂ 96.5%, N₂ 3.5%', molarMass: 0.0434, gamma: 1.2, density: table(VIRA), variability: 0.03, source: 'VIRA (Seiff et al. 1985); NASA fact sheet surface density 65 kg/m³, 92 bar' },
    materials: [{ m: 'hard-rock', share: 1 }], ocean: 0, transition: 'silicate',
    vInf: { median: 20, logSd: 0.3, source: 'NEO-like population at 0.72 au; estimated' },
    source: FACT_SHEET, quality: 'high', note: 'Small impactors are crushed and dispersed high in the atmosphere; Venus has no craters smaller than about 1.5–2 km.',
  }),
  Earth: mk({
    id: 'Earth', name: 'Earth', cls: 'rocky-atmosphere', radiusKm: 6371, massKg: 5.97e24, gravity: 9.81, escapeKms: 11.19, rotationHours: 23.93, solidSurface: true,
    atmosphere: { kind: 'substantial', p0Pa: 101325, rho0: 1.225, scaleHeightKm: 8.5, tempK: 288, composition: 'N₂ 78.08%, O₂ 20.95%, Ar 0.93%', molarMass: 0.02897, gamma: 1.4, density: table(USSA76_TABLE), variability: 0.02, source: 'US Standard Atmosphere 1976' },
    materials: [{ m: 'water', share: 0.71 }, { m: 'wet-soil', share: 0.15 }, { m: 'soft-rock', share: 0.1 }, { m: 'hard-rock', share: 0.04 }], ocean: 0.71, transition: 'silicate',
    vInf: { median: 17, logSd: 0.3, source: 'NEO encounter speeds (median v∞ ≈ 17 km/s; mean impact ≈ 20 km/s), e.g. Chyba 1993, Harris & Chodas 2021' },
    source: FACT_SHEET, quality: 'high',
  }),
  Moon: mk({
    id: 'Moon', name: 'Moon', cls: 'airless', radiusKm: 1737.4, massKg: 0.0735e24, gravity: 1.62, escapeKms: 2.38, rotationHours: 655.7, solidSurface: true,
    atmosphere: NONE('surface-bounded exosphere (He, Ar, Na); ≈ 3e-15 bar'),
    materials: [{ m: 'sand', share: 0.6 }, { m: 'dry-soil', share: 0.25 }, { m: 'hard-rock', share: 0.15 }], ocean: 0, transition: 'silicate',
    vInf: { median: 17, logSd: 0.3, source: 'As Earth (same heliocentric population)' },
    source: FACT_SHEET, quality: 'high', note: 'Regolith over megaregolith and bedrock; small craters form in regolith (sand-like), large ones in rock.',
  }),
  Mars: mk({
    id: 'Mars', name: 'Mars', cls: 'rocky-atmosphere', radiusKm: 3389.5, massKg: 0.642e24, gravity: 3.71, escapeKms: 5.03, rotationHours: 24.62, solidSurface: true,
    atmosphere: {
      kind: 'thin', p0Pa: 636, rho0: 0.020, scaleHeightKm: 11.1, tempK: 210, composition: 'CO₂ 95%, N₂ 2.8%, Ar 2%', molarMass: 0.0434, gamma: 1.29,
      // season ∈ [−1, 1]: the CO₂ cycle swings surface pressure by about ±12%
      density: (h, season = 0) => {
        const s = 1 + 0.12 * season;
        return h <= 40 ? 0.02 * s * Math.exp(-h / 11.1) : 0.02 * s * Math.exp(-40 / 11.1) * Math.exp(-(h - 40) / 8);
      },
      variability: 0.12, source: 'NASA fact sheet (0.020 kg/m³, H = 11.1 km); seasonal cycle from Viking landers; Mars-GRAM for detail',
    },
    materials: [{ m: 'dry-soil', share: 0.7 }, { m: 'soft-rock', share: 0.25 }, { m: 'ice', share: 0.05 }], ocean: 0, transition: 'silicate',
    vInf: { median: 9.5, logSd: 0.3, source: 'Mars-crossing asteroids (e.g. Ivanov 2001; JeongAhn & Malhotra 2015)' },
    source: FACT_SHEET, quality: 'high',
  }),
  Jupiter: mk({
    id: 'Jupiter', name: 'Jupiter', cls: 'gas-giant', radiusKm: 69911, massKg: 1898e24, gravity: 24.79, escapeKms: 59.5, rotationHours: 9.93, solidSurface: false,
    atmosphere: { kind: 'deep', p0Pa: 1e5, rho0: 0.16, scaleHeightKm: 27, tempK: 165, composition: 'H₂ 89.8%, He 10.2% (CH₄, NH₃ traces)', molarMass: 0.00227, gamma: 1.43, density: giant(0.16, 27, 165, 24.79, 12000, 1.43), variability: 0.05, source: 'NASA fact sheet (1-bar density 0.16 kg/m³, H = 27 km, 165 K); dry adiabat below' },
    materials: [], ocean: 0, transition: null,
    vInf: { median: 3.2, logSd: 0.35, source: 'Ecliptic comets: mean v∞ ≈ 3.2 km/s (Brasser et al. 2025)' },
    source: FACT_SHEET, quality: 'high', note: 'No solid surface in this model. Altitudes are relative to the 1-bar level.',
  }),
  Saturn: mk({
    id: 'Saturn', name: 'Saturn', cls: 'gas-giant', radiusKm: 58232, massKg: 568e24, gravity: 10.44, escapeKms: 35.5, rotationHours: 10.66, solidSurface: false,
    atmosphere: { kind: 'deep', p0Pa: 1e5, rho0: 0.19, scaleHeightKm: 59.5, tempK: 134, composition: 'H₂ 96.3%, He 3.25%', molarMass: 0.00207, gamma: 1.43, density: giant(0.19, 59.5, 134, 10.44, 12500, 1.43), variability: 0.05, source: 'NASA fact sheet (0.19 kg/m³, H = 59.5 km, 134 K)' },
    materials: [], ocean: 0, transition: null,
    vInf: { median: 3.7, logSd: 0.35, source: 'Brasser et al. 2025' },
    source: FACT_SHEET, quality: 'high',
  }),
  Uranus: mk({
    id: 'Uranus', name: 'Uranus', cls: 'ice-giant', radiusKm: 25362, massKg: 86.8e24, gravity: 8.87, escapeKms: 21.3, rotationHours: -17.24, solidSurface: false,
    atmosphere: { kind: 'deep', p0Pa: 1e5, rho0: 0.42, scaleHeightKm: 27.7, tempK: 76, composition: 'H₂ 82.5%, He 15.2%, CH₄ 2.3%', molarMass: 0.00264, gamma: 1.43, density: giant(0.42, 27.7, 76, 8.87, 10000, 1.43), variability: 0.05, source: 'NASA fact sheet (0.42 kg/m³, H = 27.7 km, 76 K)' },
    materials: [], ocean: 0, transition: null,
    vInf: { median: 2.4, logSd: 0.35, source: 'Brasser et al. 2025' },
    source: FACT_SHEET, quality: 'high', note: 'Deep atmosphere over a water-rich interior; no accessible surface.',
  }),
  Neptune: mk({
    id: 'Neptune', name: 'Neptune', cls: 'ice-giant', radiusKm: 24622, massKg: 102e24, gravity: 11.15, escapeKms: 23.5, rotationHours: 16.11, solidSurface: false,
    atmosphere: { kind: 'deep', p0Pa: 1e5, rho0: 0.45, scaleHeightKm: 19.7, tempK: 72, composition: 'H₂ 80%, He 19%, CH₄ 1.5%', molarMass: 0.00269, gamma: 1.43, density: giant(0.45, 19.7, 72, 11.15, 10000, 1.43), variability: 0.05, source: 'NASA fact sheet (0.45 kg/m³, H = 19.1–20.3 km, 72 K)' },
    materials: [], ocean: 0, transition: null,
    vInf: { median: 2.5, logSd: 0.4, source: 'Analogue to Uranus (Brasser et al. 2025 report no Neptune value): estimated' },
    source: FACT_SHEET, quality: 'medium',
  }),
  // ---------------------------------------------------------------- documented extensions
  Pluto: mk({
    id: 'Pluto', name: 'Pluto', cls: 'airless', radiusKm: 1188, massKg: 0.0130e24, gravity: 0.62, escapeKms: 1.21, rotationHours: -153.3, solidSurface: true,
    atmosphere: NONE('tenuous N₂ atmosphere ≈ 1 Pa: negligible for entry', 1),
    materials: [{ m: 'ice', share: 1 }], ocean: 0, transition: 'ice',
    vInf: { median: 1.9, logSd: 0.4, source: 'Kuiper-belt encounter speeds ≈ 2 km/s (e.g. Greenstein et al. 2017); estimated' },
    source: FACT_SHEET, quality: 'medium', note: 'Extension: dwarf planet.',
  }),
  Titan: mk({
    id: 'Titan', name: 'Titan', cls: 'rocky-atmosphere', radiusKm: 2574.7, massKg: 0.1345e24, gravity: 1.352, rotationHours: 382.7, solidSurface: true,
    atmosphere: { kind: 'dense', p0Pa: 146700, rho0: 5.43, scaleHeightKm: 20, tempK: 93.7, composition: 'N₂ ≈ 95%, CH₄ ≈ 5% near the surface', molarMass: 0.0276, gamma: 1.4, density: (h) => (h <= 40 ? 5.43 * Math.exp(-h / 17) : 5.43 * Math.exp(-40 / 17) * Math.exp(-(h - 40) / 40)), variability: 0.05, source: 'Huygens HASI (Fulchignoni et al. 2005): 1.467 bar, 93.7 K, ρ ≈ 5.4 kg/m³; two-layer fit (estimated above 40 km)' },
    materials: [{ m: 'ice', share: 0.9 }, { m: 'water', share: 0.1 }], ocean: 0.02, transition: 'ice',
    vInf: { median: 10.8, logSd: 0.3, source: 'Mean impact speed on Titan ≈ 10.8 km/s (Brasser et al. 2025)' },
    source: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/saturniansatfact.html', quality: 'medium', note: 'Extension: settled moon with a thick atmosphere. "Ocean" is the methane–ethane lakes.',
  }),
};

export const REQUIRED_BODIES = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Moon'] as const;

/** An airless analogue for small moons and asteroids, derived from the sim catalogue's radius and gravity. */
const generic = new Map<string, BodyProfile>();
export function genericProfile(name: string, radiusKm: number, gEarth: number, kind: string, analogue: 'airless' | 'earth' | 'venus' | 'mars' | 'jupiter' | 'neptune' = 'airless'): BodyProfile {
  const key = `${name}:${radiusKm}:${gEarth}:${kind}:${analogue}`;
  let p = generic.get(key);
  if (!p) { p = makeGeneric(name, radiusKm, gEarth, kind, analogue); generic.set(key, p); }
  return p;
}
function makeGeneric(name: string, radiusKm: number, gEarth: number, kind: string, analogue: 'airless' | 'earth' | 'venus' | 'mars' | 'jupiter' | 'neptune'): BodyProfile {
  const gravity = gEarth * 9.80665, mass = (gravity * (radiusKm * 1e3) ** 2) / G;
  if (analogue !== 'airless') {
    const a = analogue === 'earth' ? BODIES.Earth : analogue === 'venus' ? BODIES.Venus : analogue === 'mars' ? BODIES.Mars : analogue === 'jupiter' ? BODIES.Jupiter : BODIES.Neptune;
    return { ...a, id: name, name, radiusKm, massKg: mass, gm: G * mass, gravity, escapeKms: Math.sqrt((2 * G * mass) / (radiusKm * 1e3)) / 1e3, quality: 'low', note: `Analogue profile (${a.name}): nothing is measured about this world's atmosphere.` };
  }
  const icy = kind === 'ice' || kind === 'dwarf';
  return mk({
    id: name, name, cls: 'airless', radiusKm, massKg: mass, gravity, rotationHours: 24, solidSurface: true,
    atmosphere: NONE('no significant atmosphere (analogue)'),
    materials: [{ m: icy ? 'ice' : 'dry-soil', share: 1 }], ocean: 0, transition: icy ? 'ice' : 'silicate',
    vInf: { median: 5, logSd: 0.4, source: 'Analogue' }, source: 'sim catalogue (radius, gravity)', quality: 'low',
    note: 'Analogue profile: airless body from the simulation catalogue.',
  });
}
