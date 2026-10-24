// Hand-entered real data (Solar System, nearby stars) plus the rule tables the
// engine reads: technologies, global eras, stages. Numbers are approximate but
// real; see research/simulation-bible.md for sources and reasoning.

export type Res5 = [water: number, metals: number, volatiles: number, rare: number, he3: number];
export const RES_NAMES = ['water', 'metals', 'volatiles', 'rare', 'he3'] as const;

export type BodyKind =
  | 'rocky' | 'superearth' | 'ocean' | 'desert' | 'lava' | 'ice' | 'gas' | 'icegiant'
  | 'asteroid' | 'dwarf' | 'moon' | 'habitat';

export interface BodySpec {
  name: string;
  kind: BodyKind;
  parent?: string;       // moons orbit a named body
  a: number;             // semi-major axis, AU (for moons: thousand km from parent)
  radius: number;        // km
  g: number;             // surface gravity, Earth = 1
  temp: number;          // mean surface/equilibrium temperature, K
  hab: number;           // 0 = lethal, 1 = Earth
  res: Res5;             // endowment 0-1
  settle?: boolean;      // false = can't host a settlement surface (gas giants host orbital ones later)
  color?: number;
}

export const SOLAR_SYSTEM: BodySpec[] = [
  { name: 'Mercury', kind: 'rocky', a: 0.387, radius: 2440, g: 0.38, temp: 440, hab: 0.08, res: [0.2, 0.9, 0.1, 0.6, 0.3], color: 0x9a9089 },
  { name: 'Venus', kind: 'lava', a: 0.723, radius: 6052, g: 0.9, temp: 737, hab: 0.04, res: [0.05, 0.5, 0.85, 0.3, 0], color: 0xe3c58e },
  { name: 'Earth', kind: 'ocean', a: 1.0, radius: 6371, g: 1, temp: 288, hab: 1, res: [1, 0.8, 0.8, 0.6, 0.05], color: 0x3a6fd0 },
  { name: 'Moon', kind: 'moon', parent: 'Earth', a: 384, radius: 1737, g: 0.165, temp: 250, hab: 0.2, res: [0.3, 0.5, 0.1, 0.4, 0.7], color: 0xb8b5b0 },
  { name: 'Mars', kind: 'desert', a: 1.524, radius: 3390, g: 0.38, temp: 210, hab: 0.42, res: [0.6, 0.6, 0.5, 0.4, 0.1], color: 0xc1562e },
  { name: 'Phobos', kind: 'asteroid', parent: 'Mars', a: 9.4, radius: 11, g: 0.0006, temp: 233, hab: 0.1, res: [0.2, 0.3, 0.3, 0.1, 0.05], color: 0x7d7268 },
  { name: 'Vesta', kind: 'asteroid', a: 2.36, radius: 263, g: 0.025, temp: 180, hab: 0.12, res: [0.1, 0.75, 0.1, 0.4, 0.05], color: 0xa29a8d },
  { name: 'Ceres', kind: 'dwarf', a: 2.77, radius: 473, g: 0.029, temp: 168, hab: 0.22, res: [0.9, 0.3, 0.5, 0.3, 0.05], color: 0x8c8780 },
  { name: 'Psyche', kind: 'asteroid', a: 2.92, radius: 113, g: 0.006, temp: 160, hab: 0.08, res: [0.02, 1, 0.05, 0.85, 0.02], color: 0x9b9184 },
  { name: 'Hygiea', kind: 'asteroid', a: 3.14, radius: 217, g: 0.009, temp: 160, hab: 0.1, res: [0.6, 0.35, 0.4, 0.25, 0.02], color: 0x6f6a64 },
  { name: 'Jupiter', kind: 'gas', a: 5.2, radius: 69911, g: 2.53, temp: 165, hab: 0, res: [0.3, 0, 1, 0, 0.95], settle: false, color: 0xd4a77a },
  { name: 'Io', kind: 'moon', parent: 'Jupiter', a: 422, radius: 1822, g: 0.183, temp: 110, hab: 0.03, res: [0, 0.6, 0.5, 0.5, 0.1], color: 0xe2d063 },
  { name: 'Europa', kind: 'moon', parent: 'Jupiter', a: 671, radius: 1561, g: 0.134, temp: 102, hab: 0.16, res: [1, 0.2, 0.4, 0.2, 0.05], color: 0xd9cbb4 },
  { name: 'Ganymede', kind: 'moon', parent: 'Jupiter', a: 1070, radius: 2634, g: 0.146, temp: 110, hab: 0.26, res: [0.9, 0.35, 0.35, 0.25, 0.05], color: 0x8e8478 },
  { name: 'Callisto', kind: 'moon', parent: 'Jupiter', a: 1883, radius: 2410, g: 0.126, temp: 134, hab: 0.32, res: [0.8, 0.3, 0.3, 0.2, 0.05], color: 0x5d564d },
  { name: 'Saturn', kind: 'gas', a: 9.58, radius: 58232, g: 1.07, temp: 134, hab: 0, res: [0.4, 0, 1, 0, 0.85], settle: false, color: 0xe5cf98 },
  { name: 'Enceladus', kind: 'moon', parent: 'Saturn', a: 238, radius: 252, g: 0.011, temp: 75, hab: 0.12, res: [1, 0.1, 0.5, 0.1, 0.05], color: 0xf2f4f7 },
  { name: 'Rhea', kind: 'moon', parent: 'Saturn', a: 527, radius: 764, g: 0.027, temp: 76, hab: 0.14, res: [0.8, 0.15, 0.2, 0.1, 0.05], color: 0xc9c6c0 },
  { name: 'Titan', kind: 'moon', parent: 'Saturn', a: 1222, radius: 2575, g: 0.138, temp: 94, hab: 0.34, res: [0.7, 0.2, 1, 0.2, 0.1], color: 0xd8a24a },
  { name: 'Iapetus', kind: 'moon', parent: 'Saturn', a: 3561, radius: 735, g: 0.023, temp: 90, hab: 0.1, res: [0.7, 0.15, 0.2, 0.1, 0.05], color: 0x8a7f72 },
  { name: 'Uranus', kind: 'icegiant', a: 19.2, radius: 25362, g: 0.9, temp: 76, hab: 0, res: [0.6, 0, 0.9, 0, 0.9], settle: false, color: 0x9fd8de },
  { name: 'Titania', kind: 'moon', parent: 'Uranus', a: 436, radius: 789, g: 0.039, temp: 70, hab: 0.12, res: [0.7, 0.2, 0.25, 0.15, 0.05], color: 0xa79f99 },
  { name: 'Oberon', kind: 'moon', parent: 'Uranus', a: 584, radius: 761, g: 0.035, temp: 70, hab: 0.1, res: [0.7, 0.2, 0.2, 0.15, 0.05], color: 0x8d837b },
  { name: 'Neptune', kind: 'icegiant', a: 30.07, radius: 24622, g: 1.14, temp: 72, hab: 0, res: [0.6, 0, 0.9, 0, 0.9], settle: false, color: 0x4b70dd },
  { name: 'Triton', kind: 'moon', parent: 'Neptune', a: 355, radius: 1353, g: 0.08, temp: 38, hab: 0.1, res: [0.7, 0.2, 0.8, 0.15, 0.05], color: 0xc7b9b2 },
  { name: 'Pluto', kind: 'dwarf', a: 39.5, radius: 1188, g: 0.063, temp: 44, hab: 0.08, res: [0.7, 0.2, 0.7, 0.1, 0.05], color: 0xcdb79e },
  { name: 'Haumea', kind: 'dwarf', a: 43.1, radius: 816, g: 0.045, temp: 50, hab: 0.06, res: [0.8, 0.2, 0.3, 0.1, 0.02], color: 0xe8e4df },
  { name: 'Eris', kind: 'dwarf', a: 67.8, radius: 1163, g: 0.084, temp: 42, hab: 0.06, res: [0.7, 0.25, 0.6, 0.1, 0.02], color: 0xe9e6e1 },
  { name: 'Sedna', kind: 'dwarf', a: 506, radius: 498, g: 0.03, temp: 12, hab: 0.04, res: [0.6, 0.2, 0.6, 0.1, 0.02], color: 0xa3523c },
];

export interface StarSpec {
  name: string;
  ra: number;   // deg
  dec: number;  // deg
  dist: number; // light years
  spec: string; // spectral class letter + subclass
  /** bolometric luminosity, L_sun (primary star). Published values: Mamajek's dwarf table,
   *  Boyajian et al. 2012/2013 interferometry, Ribas et al. 2017 (Proxima), Van Grootel et al.
   *  2018 (TRAPPIST-1); Tau Ceti 0.52 (Teixeira et al. 2009). */
  lum: number;
  planets: { name: string; kind: BodyKind; a: number; mass: number; temp: number; hab: number; res?: Res5 }[];
}

// Real stars within ~50 ly that matter, plus a few famous far ones.
// Planet masses in Earth masses; hab is our own judgement of settle-ability.
export const NEARBY_STARS: StarSpec[] = [
  { name: 'Alpha Centauri A', ra: 219.9, dec: -60.83, dist: 4.37, spec: 'G2', lum: 1.52, planets: [{ name: 'Alpha Cen A b', kind: 'superearth', a: 1.1, mass: 3, temp: 270, hab: 0.3 }] },
  { name: 'Alpha Centauri B', ra: 219.9, dec: -60.84, dist: 4.37, spec: 'K1', lum: 0.5, planets: [{ name: 'Alpha Cen B belt', kind: 'asteroid', a: 1.5, mass: 0.001, temp: 200, hab: 0.1, res: [0.3, 0.8, 0.2, 0.5, 0] }] },
  { name: 'Proxima Centauri', ra: 217.43, dec: -62.68, dist: 4.24, spec: 'M5', lum: 0.00155, planets: [
    { name: 'Proxima b', kind: 'rocky', a: 0.0485, mass: 1.07, temp: 234, hab: 0.32 },
    { name: 'Proxima d', kind: 'rocky', a: 0.029, mass: 0.26, temp: 360, hab: 0.06 },
  ] },
  { name: "Barnard's Star", ra: 269.45, dec: 4.69, dist: 5.96, spec: 'M4', lum: 0.0035, planets: [
    { name: 'Barnard b', kind: 'lava', a: 0.023, mass: 0.37, temp: 400, hab: 0.05 },
    { name: 'Barnard c', kind: 'rocky', a: 0.027, mass: 0.34, temp: 370, hab: 0.06 },
  ] },
  { name: 'Wolf 359', ra: 164.12, dec: 7.01, dist: 7.86, spec: 'M6', lum: 0.0014, planets: [{ name: 'Wolf 359 c', kind: 'rocky', a: 0.018, mass: 1.9, temp: 330, hab: 0.08 }] },
  { name: 'Lalande 21185', ra: 165.83, dec: 35.97, dist: 8.31, spec: 'M2', lum: 0.021, planets: [
    { name: 'Lalande b', kind: 'superearth', a: 0.079, mass: 2.7, temp: 370, hab: 0.08 },
    { name: 'Lalande c', kind: 'icegiant', a: 2.9, mass: 13.6, temp: 60, hab: 0, res: [0.6, 0, 0.9, 0, 0.8] },
  ] },
  { name: 'Sirius', ra: 101.29, dec: -16.72, dist: 8.6, spec: 'A1', lum: 25.4, planets: [{ name: 'Sirius debris', kind: 'asteroid', a: 20, mass: 0.001, temp: 120, hab: 0.06, res: [0.4, 0.6, 0.3, 0.6, 0] }] },
  { name: 'Ross 154', ra: 282.46, dec: -23.84, dist: 9.7, spec: 'M3', lum: 0.0038, planets: [] },
  { name: 'Ross 248', ra: 355.48, dec: 44.18, dist: 10.3, spec: 'M6', lum: 0.0018, planets: [] },
  { name: 'Epsilon Eridani', ra: 53.23, dec: -9.46, dist: 10.5, spec: 'K2', lum: 0.34, planets: [
    { name: 'Epsilon Eridani b', kind: 'gas', a: 3.5, mass: 210, temp: 110, hab: 0, res: [0.3, 0, 1, 0, 0.9] },
    { name: 'Eps Eridani belt', kind: 'asteroid', a: 3, mass: 0.001, temp: 120, hab: 0.12, res: [0.6, 0.7, 0.4, 0.5, 0] },
  ] },
  { name: 'Lacaille 9352', ra: 346.47, dec: -35.85, dist: 10.7, spec: 'M0', lum: 0.033, planets: [
    { name: 'Lacaille 9352 b', kind: 'superearth', a: 0.068, mass: 4.2, temp: 340, hab: 0.08 },
    { name: 'Lacaille 9352 c', kind: 'superearth', a: 0.12, mass: 7.6, temp: 260, hab: 0.2 },
  ] },
  { name: 'Ross 128', ra: 176.94, dec: 0.8, dist: 11.0, spec: 'M4', lum: 0.0036, planets: [{ name: 'Ross 128 b', kind: 'rocky', a: 0.0496, mass: 1.35, temp: 280, hab: 0.42 }] },
  { name: '61 Cygni', ra: 316.73, dec: 38.75, dist: 11.4, spec: 'K5', lum: 0.15, planets: [] },
  { name: 'Procyon', ra: 114.83, dec: 5.22, dist: 11.5, spec: 'F5', lum: 6.9, planets: [] },
  { name: 'Groombridge 34', ra: 4.6, dec: 44.02, dist: 11.6, spec: 'M1', lum: 0.022, planets: [{ name: 'Groombridge 34 Ab', kind: 'superearth', a: 0.072, mass: 3, temp: 370, hab: 0.06 }] },
  { name: 'Epsilon Indi', ra: 330.84, dec: -56.79, dist: 11.9, spec: 'K5', lum: 0.22, planets: [{ name: 'Epsilon Indi Ab', kind: 'gas', a: 11.5, mass: 2000, temp: 60, hab: 0, res: [0.3, 0, 1, 0, 0.9] }] },
  { name: 'Tau Ceti', ra: 26.02, dec: -15.94, dist: 11.9, spec: 'G8', lum: 0.52, planets: [
    { name: 'Tau Ceti g', kind: 'superearth', a: 0.133, mass: 1.75, temp: 560, hab: 0.04 },
    { name: 'Tau Ceti h', kind: 'superearth', a: 0.243, mass: 1.83, temp: 400, hab: 0.08 },
    { name: 'Tau Ceti e', kind: 'superearth', a: 0.538, mass: 3.9, temp: 300, hab: 0.38 },
    { name: 'Tau Ceti f', kind: 'superearth', a: 1.33, mass: 3.9, temp: 190, hab: 0.3 },
  ] },
  { name: 'GJ 1061', ra: 53.99, dec: -44.51, dist: 12.0, spec: 'M5', lum: 0.0017, planets: [
    { name: 'GJ 1061 c', kind: 'rocky', a: 0.035, mass: 1.74, temp: 275, hab: 0.4 },
    { name: 'GJ 1061 d', kind: 'rocky', a: 0.054, mass: 1.64, temp: 218, hab: 0.34 },
  ] },
  { name: 'YZ Ceti', ra: 18.13, dec: -16.99, dist: 12.1, spec: 'M4', lum: 0.0022, planets: [{ name: 'YZ Ceti d', kind: 'rocky', a: 0.028, mass: 1.1, temp: 400, hab: 0.06 }] },
  { name: "Luyten's Star", ra: 111.85, dec: 5.23, dist: 12.4, spec: 'M3', lum: 0.0088, planets: [{ name: 'GJ 273 b', kind: 'superearth', a: 0.091, mass: 2.9, temp: 259, hab: 0.44 }] },
  { name: "Teegarden's Star", ra: 43.25, dec: 16.88, dist: 12.5, spec: 'M7', lum: 0.00073, planets: [
    { name: 'Teegarden b', kind: 'rocky', a: 0.0252, mass: 1.05, temp: 264, hab: 0.5 },
    { name: 'Teegarden c', kind: 'rocky', a: 0.0443, mass: 1.11, temp: 199, hab: 0.3 },
  ] },
  { name: "Kapteyn's Star", ra: 77.92, dec: -45.02, dist: 12.8, spec: 'M1', lum: 0.012, planets: [] },
  { name: 'Wolf 1061', ra: 247.58, dec: -12.66, dist: 14.0, spec: 'M3', lum: 0.0094, planets: [{ name: 'Wolf 1061 c', kind: 'superearth', a: 0.089, mass: 3.4, temp: 275, hab: 0.38 }] },
  { name: 'Gliese 876', ra: 343.32, dec: -14.26, dist: 15.2, spec: 'M4', lum: 0.0122, planets: [
    { name: 'Gliese 876 b', kind: 'gas', a: 0.208, mass: 720, temp: 200, hab: 0, res: [0.3, 0, 1, 0, 0.9] },
    { name: 'Gliese 876 b I', kind: 'moon', a: 0.208, mass: 0.5, temp: 220, hab: 0.25 },
  ] },
  { name: '40 Eridani', ra: 63.82, dec: -7.65, dist: 16.3, spec: 'K0', lum: 0.46, planets: [{ name: 'Vulcan', kind: 'desert', a: 0.22, mass: 8.5, temp: 330, hab: 0.15 }] },
  { name: 'Altair', ra: 297.7, dec: 8.87, dist: 16.7, spec: 'A7', lum: 10.6, planets: [] },
  { name: 'Gliese 581', ra: 229.86, dec: -7.72, dist: 20.5, spec: 'M3', lum: 0.012, planets: [
    { name: 'Gliese 581 e', kind: 'rocky', a: 0.028, mass: 1.7, temp: 400, hab: 0.05 },
    { name: 'Gliese 581 c', kind: 'superearth', a: 0.073, mass: 5.5, temp: 300, hab: 0.22 },
  ] },
  { name: 'Gliese 667 C', ra: 259.75, dec: -34.99, dist: 23.6, spec: 'M1', lum: 0.0137, planets: [{ name: 'Gliese 667 Cc', kind: 'superearth', a: 0.125, mass: 3.8, temp: 277, hab: 0.45 }] },
  { name: 'Fomalhaut', ra: 344.41, dec: -29.62, dist: 25.1, spec: 'A3', lum: 16.6, planets: [{ name: 'Fomalhaut belt', kind: 'asteroid', a: 133, mass: 0.01, temp: 50, hab: 0.06, res: [0.8, 0.5, 0.6, 0.4, 0] }] },
  { name: 'Vega', ra: 279.23, dec: 38.78, dist: 25.0, spec: 'A0', lum: 40.1, planets: [] },
  { name: 'TRAPPIST-1', ra: 346.62, dec: -5.04, dist: 40.7, spec: 'M8', lum: 0.00055, planets: [
    { name: 'TRAPPIST-1 b', kind: 'lava', a: 0.0115, mass: 1.37, temp: 400, hab: 0.03 },
    { name: 'TRAPPIST-1 c', kind: 'rocky', a: 0.0158, mass: 1.31, temp: 340, hab: 0.06 },
    { name: 'TRAPPIST-1 d', kind: 'ocean', a: 0.0223, mass: 0.39, temp: 288, hab: 0.42 },
    { name: 'TRAPPIST-1 e', kind: 'ocean', a: 0.0293, mass: 0.69, temp: 251, hab: 0.55 },
    { name: 'TRAPPIST-1 f', kind: 'ocean', a: 0.0385, mass: 1.04, temp: 219, hab: 0.42 },
    { name: 'TRAPPIST-1 g', kind: 'ice', a: 0.0469, mass: 1.32, temp: 198, hab: 0.3 },
    { name: 'TRAPPIST-1 h', kind: 'ice', a: 0.0619, mass: 0.33, temp: 173, hab: 0.14 },
  ] },
  { name: '55 Cancri', ra: 133.15, dec: 28.33, dist: 41, spec: 'G8', lum: 0.59, planets: [
    { name: '55 Cancri e', kind: 'lava', a: 0.0154, mass: 8, temp: 2000, hab: 0, res: [0, 1, 0.2, 1, 0] },
    { name: '55 Cancri f', kind: 'gas', a: 0.77, mass: 47, temp: 250, hab: 0, res: [0.3, 0, 1, 0, 0.85] },
  ] },
  { name: 'HD 40307', ra: 88.52, dec: -60.02, dist: 42, spec: 'K2', lum: 0.23, planets: [{ name: 'HD 40307 g', kind: 'superearth', a: 0.6, mass: 7.1, temp: 230, hab: 0.3 }] },
  { name: 'LHS 1140', ra: 11.25, dec: -15.27, dist: 48.8, spec: 'M4', lum: 0.0038, planets: [{ name: 'LHS 1140 b', kind: 'ocean', a: 0.0957, mass: 5.6, temp: 226, hab: 0.48 }] },
  { name: 'K2-18', ra: 172.56, dec: 7.59, dist: 124, spec: 'M2', lum: 0.023, planets: [{ name: 'K2-18 b', kind: 'ocean', a: 0.143, mass: 8.6, temp: 255, hab: 0.36 }] },
  { name: 'Kepler-186', ra: 298.65, dec: 43.95, dist: 580, spec: 'M1', lum: 0.055, planets: [{ name: 'Kepler-186 f', kind: 'rocky', a: 0.43, mass: 1.7, temp: 188, hab: 0.4 }] },
  { name: 'Kepler-62', ra: 283.21, dec: 45.35, dist: 990, spec: 'K2', lum: 0.21, planets: [
    { name: 'Kepler-62 e', kind: 'ocean', a: 0.43, mass: 4.5, temp: 270, hab: 0.48 },
    { name: 'Kepler-62 f', kind: 'ocean', a: 0.72, mass: 2.8, temp: 208, hab: 0.4 },
  ] },
  { name: 'Kepler-442', ra: 285.37, dec: 39.28, dist: 1206, spec: 'K5', lum: 0.117, planets: [{ name: 'Kepler-442 b', kind: 'superearth', a: 0.41, mass: 2.4, temp: 233, hab: 0.55 }] },
  { name: 'Kepler-452', ra: 295.97, dec: 44.28, dist: 1800, spec: 'G2', lum: 1.2, planets: [{ name: 'Kepler-452 b', kind: 'superearth', a: 1.05, mass: 5, temp: 265, hab: 0.5 }] },
];

// ---------------------------------------------------------------------------
// Settlement lifecycle (Markov states)

export const STAGE = {
  NONE: -1,
  SURVEY: 0,     // probes in orbit, nobody home
  OUTPOST: 1,    // robots plus a rotating crew
  BASE: 2,       // permanent crew, imported everything
  COLONY: 3,     // families, local food and water
  TOWN: 4,
  CITY: 5,
  HUB: 6,        // industrial / trade hub, exports ships
  MEGA: 7,       // megastructure: swarm, ring, world-city
  // the far-future ladder (each gated by its technology plus people and power)
  RING: 8,       // Ring world: Bishop rings spun up around the planet
  SWARM: 9,      // Swarm-world: the system's Dyson swarm is mostly its habitats
  BRAIN: 10,     // Brain-star: a Matrioshka shell around the star does the thinking
  LIFTED: 11,    // Lifted star: the star itself is being mined
  UPLOADED: 12,  // Uploaded: most of the people live as minds
  ABANDONED: 13,
  DEAD: 14,
} as const;

/** A settlement with people in it (Outpost through Uploaded). */
export function isAlive(stage: number): boolean { return stage >= STAGE.OUTPOST && stage <= STAGE.UPLOADED; }

export const STAGE_NAMES = ['Survey', 'Outpost', 'Base', 'Colony', 'Town', 'City', 'Hub', 'Megastructure', 'Ring world', 'Swarm-world', 'Brain-star', 'Lifted star', 'Uploaded', 'Abandoned', 'Dead'];
/** Base population capacity per stage before habitability and tech. */
export const STAGE_CAP = [0, 60, 2_000, 150_000, 3_000_000, 80_000_000, 1_000_000_000, 10_000_000_000, 11_000_000_000, 12_000_000_000, 13_000_000_000, 14_000_000_000, 15_000_000_000, 0, 0];
/** Technology that unlocks each stage above Megastructure. */
export const STAGE_TECH: Partial<Record<number, string>> = { 8: 'bishopRings', 9: 'dyson2', 10: 'matrioshka', 11: 'starLifting', 12: 'mindUpload' };

// ---------------------------------------------------------------------------
// Technologies. cost = knowledge points. Effects compose multiplicatively
// (mult keys) or additively (add keys). The engine reads these fields directly.

export interface Tech {
  id: string;
  name: string;
  cost: number;
  req: string[];
  /** Earliest plausible calendar year (bible §3.4); the tech cannot land before
   *  earliest - 0.25 * (earliest - 2040), however rich the run. */
  earliest: number;
  /** chance this universe's physics allows it at all, rolled once per seed */
  feasible?: number;
  /** adoption time constant, years (invention-model §6.3): deployment x = 1/(1 + 99 e^{-t/tau}) */
  tau?: number;
  era: 1 | 2 | 3 | 4;
  fx: Partial<{
    extract: number; habitat: number; lifeSupport: number; energy: number; launch: number;
    research: number; productivity: number; death: number; growth: number; stability: number;
    hab: number; habHostile: number; reliability: number; war: number; secession: number;
    shipSpeed: number; voyage: number; fission: number; fusion: number; dyson: number;
    ftl: number; ftl2: number; probes: number; divergence: number;
    /** Gompertz level B multiplier (ages.ts), phased in over the tech's tau: genetic medicine shifts the ageing curve */
    gompB: number;
    /** Gompertz rate b (ages.ts): a gate, the slowest ageing rate any deployed tech allows */
    gompb: number;
  }>;
  blurb: string;
}

export const TECHS: Tech[] = [
  // Era 1: what the first Mars generation builds on
  { id: 'isru', name: 'In-situ resource use', cost: 90, req: [], earliest: 2045, era: 1, fx: { extract: 1.5 }, blurb: 'Make fuel, air and water from local rock and ice.' },
  { id: 'closedLoop', name: 'Closed-loop life support', cost: 135, req: [], earliest: 2045, era: 1, fx: { lifeSupport: 1.5, reliability: 0.05 }, blurb: '98% of water and air recycled.' },
  { id: 'kilopower', name: 'Surface fission reactors', cost: 120, req: [], earliest: 2045, era: 1, fx: { fission: 1 }, blurb: 'Power that does not care how far the Sun is.' },
  { id: 'reusable', name: 'Fully reusable heavy lift', cost: 105, req: [], earliest: 2042, era: 1, fx: { launch: 0.6 }, blurb: 'Rockets land and refly within days.' },
  { id: 'synthBio', name: 'Synthetic biology farming', cost: 360, req: ['closedLoop'], earliest: 2055, era: 1, fx: { growth: 1.15, lifeSupport: 1.2 }, blurb: 'Engineered crops and microbes for thin light and bad soil.' },
  { id: 'regolith', name: 'Regolith construction', cost: 330, req: ['isru'], earliest: 2050, era: 1, fx: { habitat: 1.5 }, blurb: 'Print habitats from local dirt.' },
  { id: 'ntp', name: 'Nuclear thermal propulsion', cost: 480, req: ['kilopower'], earliest: 2050, era: 1, fx: { launch: 0.8, voyage: 1.2 }, blurb: 'Mars in 90 days, Jupiter in under two years.' },
  { id: 'robotics', name: 'Autonomous robotics', cost: 420, req: [], earliest: 2045, era: 1, fx: { extract: 1.3, productivity: 1.15 }, blurb: 'Mines and factories that run unattended.' },
  { id: 'radShield', name: 'Active radiation shielding', cost: 780, req: ['closedLoop'], earliest: 2065, era: 1, fx: { habHostile: 0.06, death: 0.92 }, blurb: 'Makes Jupiter\'s moons survivable.' },
  { id: 'quantumComp', name: 'Fault-tolerant quantum computing', cost: 900, req: [], earliest: 2045, era: 1, fx: { research: 1.25 }, blurb: 'Chemistry and materials solved by simulation.' },
  { id: 'genMed', name: 'Genetic medicine', cost: 1020, req: [], earliest: 2060, era: 1, tau: 6, fx: { gompB: 0.13 }, blurb: 'Most hereditary disease and many cancers become curable.' },
  { id: 'asteroidMining', name: 'Asteroid mining', cost: 1260, req: ['isru', 'ntp'], earliest: 2060, era: 1, fx: { extract: 1.4 }, blurb: 'Metal-rich asteroids carved in place.' },
  { id: 'cloudCities', name: 'Venus aerostat cities', cost: 1560, req: ['closedLoop', 'regolith'], earliest: 2130, era: 1, fx: { hab: 0.02 }, blurb: 'Breathable air is a lifting gas 55 km above Venus.' },
  { id: 'starshot', name: 'Gram-scale starshot probes', cost: 1800, req: ['quantumComp'], earliest: 2075, era: 1, fx: { probes: 12 }, blurb: 'Laser-pushed chips survey the nearest stars at 0.2c.' },
  { id: 'agi', name: 'Artificial general intelligence', cost: 2700, req: ['robotics', 'quantumComp'], earliest: 2045, era: 1, fx: { research: 1.9, productivity: 1.5 }, blurb: 'Machine minds do research around the clock.' },

  // Era 2: the Solar System economy
  { id: 'fusion', name: 'Fusion power', cost: 9000, req: ['kilopower', 'quantumComp'], earliest: 2060, era: 2, fx: { fusion: 1, energy: 3 }, blurb: 'Deuterium from any ice becomes power.' },
  { id: 'subIce', name: 'Sub-ice ocean habitats', cost: 23400, req: ['radShield', 'regolith'], earliest: 2120, era: 2, fx: { habHostile: 0.06 }, blurb: 'Cities inside the oceans of Europa and Enceladus.' },
  { id: 'carbonNano', name: 'Bulk carbon nanomaterials', cost: 32400, req: ['quantumComp'], earliest: 2090, era: 2, fx: { habitat: 1.3, productivity: 1.1 }, blurb: 'Cables a hundred times stronger than steel.' },
  { id: 'orbitalHabitats', name: "O'Neill cylinders", cost: 57600, req: ['regolith', 'asteroidMining', 'carbonNano'], earliest: 2150, era: 2, fx: { habitat: 3, habHostile: 0.08 }, blurb: 'Spinning cities with full gravity anywhere there is metal.' },
  { id: 'neuralLace', name: 'Brain-computer interfaces', cost: 54000, req: ['agi', 'genMed'], earliest: 2080, era: 2, fx: { research: 1.35 }, blurb: 'Thought-speed access to knowledge.' },
  { id: 'magShield', name: 'Planetary magnetic shield', cost: 75600, req: ['fusion'], earliest: 2100, era: 2, fx: { hab: 0.05 }, blurb: 'A magnet at Mars L1 lets the atmosphere thicken.' },
  { id: 'he3Fusion', name: 'Helium-3 aneutronic fusion', cost: 93600, req: ['fusion'], earliest: 2095, era: 2, fx: { energy: 2 }, blurb: 'Clean fusion fed from gas-giant skimmers.' },
  { id: 'spaceElevator', name: 'Space elevators', cost: 108000, req: ['carbonNano', 'fusion'], earliest: 2200, era: 2, fx: { launch: 0.15 }, blurb: 'Orbit by elevator for the cost of electricity.' },
  { id: 'fusionDrive', name: 'Fusion torch drive', cost: 135000, req: ['fusion'], earliest: 2110, era: 2, fx: { shipSpeed: 0.03, voyage: 1.5 }, blurb: 'Constant thrust: Saturn in weeks, stars in centuries.' },
  { id: 'bioAdapt', name: 'Human genetic adaptation', cost: 162000, req: ['genMed', 'synthBio'], earliest: 2100, era: 2, fx: { habHostile: 0.08, divergence: 2 }, blurb: 'Children built for low gravity and thin air.' },
  { id: 'genShip', name: 'Generation ships', cost: 198000, req: ['orbitalHabitats', 'fusionDrive', 'synthBio'], earliest: 2250, era: 2, fx: { shipSpeed: 0.02, voyage: 1 }, blurb: 'Whole towns that cross the dark over many lifetimes.' },
  { id: 'paraterraform', name: 'Paraterraforming', cost: 216000, req: ['magShield', 'regolith'], earliest: 2095, era: 2, fx: { hab: 0.06 }, blurb: 'Roofed craters the size of countries.' },
  { id: 'psychohistory', name: 'Predictive social science', cost: 252000, req: ['agi', 'neuralLace'], earliest: 2400, era: 2, fx: { stability: 0.05, war: 0.7 }, blurb: 'Seldon\'s dream: crises seen decades ahead.' },
  { id: 'laserComms', name: 'Interstellar laser network', cost: 288000, req: ['starshot', 'fusion'], earliest: 2150, era: 2, fx: { secession: 0.7 }, blurb: 'News still travels at light speed, but it travels.' },
  { id: 'cryo', name: 'Cryogenic suspension', cost: 360000, req: ['genMed', 'neuralLace'], earliest: 2100, era: 2, fx: { voyage: 2, reliability: 0.08 }, blurb: 'Sleep through the voyage.' },
  { id: 'nanofab', name: 'Molecular nanofabrication', cost: 468000, req: ['agi', 'carbonNano'], earliest: 2150, era: 2, fx: { extract: 1.8, productivity: 1.6 }, blurb: 'Build anything atom by atom.' },
  { id: 'lifeExt', name: 'Radical life extension', cost: 540000, req: ['genMed', 'nanofab'], earliest: 2090, era: 2, tau: 8, fx: { gompb: 0.045 }, blurb: 'Ageing runs at half speed: lives of two centuries.' },

  // Era 3: interstellar
  { id: 'terraform', name: 'Planetary terraforming', cost: 1.08e+06, req: ['paraterraform', 'he3Fusion', 'nanofab'], earliest: 2300, era: 3, fx: { hab: 0.18 }, blurb: 'Whole worlds made breathable over centuries.' },
  { id: 'dyson1', name: 'Dyson swarm, phase I', cost: 1.26e+06, req: ['orbitalHabitats', 'nanofab'], earliest: 2200, era: 3, fx: { dyson: 1, energy: 12 }, blurb: 'A million collectors around the Sun.' },
  { id: 'seedShips', name: 'Embryo seed ships', cost: 1.44e+06, req: ['genShip', 'agi', 'bioAdapt'], earliest: 2250, era: 3, fx: { reliability: 0.1, voyage: 2 }, blurb: 'Robots carry frozen embryos and raise the first generation.' },
  { id: 'laserSail', name: 'Beamed laser sails', cost: 1.5e+06, req: ['dyson1', 'starshot'], earliest: 2500, era: 3, fx: { shipSpeed: 0.1 }, blurb: 'Crewed sails pushed to a tenth of light speed.' },
  { id: 'vonNeumann', name: 'Self-replicating probes', cost: 3e+06, req: ['nanofab', 'agi', 'fusionDrive'], earliest: 2300, era: 3, fx: { probes: 60 }, blurb: 'Probes that build more probes. Surveys outrun ships.' },
  { id: 'bishopRings', name: 'Bishop rings', cost: 4.5e+06, req: ['orbitalHabitats', 'carbonNano', 'dyson1'], earliest: 2400, era: 3, fx: { habitat: 3 }, blurb: 'Habitat rings a thousand kilometres across.' },
  { id: 'antimatter', name: 'Antimatter catalysis', cost: 6e+06, req: ['he3Fusion', 'dyson1'], earliest: 2300, era: 3, fx: { shipSpeed: 0.15 }, blurb: 'The densest fuel there is, made with sunlight.' },
  { id: 'mindUpload', name: 'Mind uploading', cost: 9e+06, req: ['neuralLace', 'nanofab'], earliest: 2500, era: 3, fx: { research: 2.5, death: 0.7, divergence: 3 }, blurb: 'Some people stop needing bodies.' },
  { id: 'dyson2', name: 'Dyson swarm, phase II', cost: 1.5e+07, req: ['dyson1', 'bishopRings'], earliest: 2350, era: 3, fx: { dyson: 1, energy: 25 }, blurb: 'A third of the Sun\'s light captured.' },
  { id: 'bussard', name: 'Bussard ramjet', cost: 3e+07, req: ['antimatter', 'fusionDrive'], earliest: 2800, era: 3, fx: { shipSpeed: 0.2, voyage: 3 }, blurb: 'Scoop interstellar hydrogen for fuel.' },

  // Era 4: speculative. Costs carry very wide random multipliers, so most futures never get here.
  { id: 'starLifting', name: 'Star lifting', cost: 2e8, req: ['dyson2'], earliest: 5000, feasible: 0.9, era: 4, fx: { extract: 3, dyson: 1 }, blurb: 'Mine the star itself.' },
  { id: 'matrioshka', name: 'Matrioshka brains', cost: 8e8, req: ['dyson2', 'mindUpload'], earliest: 4000, feasible: 0.9, era: 4, fx: { research: 6 }, blurb: 'A star\'s whole output spent on thinking.' },
  { id: 'warp', name: 'Alcubierre metric engineering', cost: 8e9, req: ['antimatter', 'matrioshka'], earliest: 8000, feasible: 0.08, era: 4, fx: { ftl: 1 }, blurb: 'Space folds in front, unfolds behind.' },
  { id: 'wormholes', name: 'Traversable wormholes', cost: 1e11, req: ['warp', 'starLifting'], earliest: 9000, feasible: 0.35, era: 4, fx: { ftl2: 1 }, blurb: 'Andromeda becomes a commute.' },
];

// ---------------------------------------------------------------------------
// Global eras: the mood of human civilization. A Markov chain with per-decade
// transition probabilities, reweighted every step by the actual state.

export const ERAS = ['Expansion', 'Consolidation', 'Golden Age', 'Stagnation', 'War', 'Pandemic', 'Collapse', 'Renaissance'] as const;

// rows: from, cols: to. Per decade. The bible's §5.2 matrix with its secession
// crisis folded into Consolidation and its AI transition into Golden Age;
// Renaissance is ours (the way out of a long dark age).
export const ERA_MATRIX: number[][] = [
  /* Expansion     */[0.55, 0.24, 0.09, 0.04, 0.05, 0.02, 0.01, 0.0],
  /* Consolidation */[0.2, 0.5, 0.13, 0.1, 0.04, 0.02, 0.01, 0.0],
  /* Golden Age    */[0.2, 0.17, 0.47, 0.1, 0.03, 0.02, 0.01, 0.0],
  /* Stagnation    */[0.08, 0.23, 0.04, 0.5, 0.08, 0.03, 0.04, 0.0],
  /* War           */[0.05, 0.32, 0.02, 0.15, 0.35, 0.04, 0.07, 0.0],
  /* Pandemic      */[0.03, 0.33, 0.01, 0.25, 0.06, 0.25, 0.07, 0.0],
  /* Collapse      */[0.01, 0.05, 0.0, 0.12, 0.05, 0.01, 0.7, 0.06],
  /* Renaissance   */[0.3, 0.15, 0.2, 0.05, 0.03, 0.02, 0.0, 0.25],
];

// growth, research, launch, stability drift/yr, death, war-prob multiplier (bible §5.1)
export const ERA_FX: { growth: number; research: number; launch: number; stab: number; death: number; war: number }[] = [
  { growth: 1.05, research: 1.1, launch: 1.5, stab: 0.002, death: 1, war: 1 },
  { growth: 1.0, research: 1.0, launch: 0.9, stab: 0.006, death: 1, war: 0.6 },
  { growth: 0.95, research: 1.3, launch: 1.3, stab: 0.008, death: 0.95, war: 0.3 },
  { growth: 0.9, research: 0.7, launch: 0.5, stab: -0.003, death: 1.05, war: 1.2 },
  { growth: 0.9, research: 0.6, launch: 0.6, stab: -0.012, death: 1.1, war: 6 },
  { growth: 0.95, research: 0.7, launch: 0.4, stab: -0.008, death: 1.3, war: 0.8 },
  { growth: 0.8, research: 0.1, launch: 0.05, stab: -0.02, death: 1.5, war: 2 },
  { growth: 1.05, research: 1.8, launch: 1.0, stab: 0.01, death: 0.95, war: 0.5 },
];

export const EVENT_NAMES = [
  'Habitat breach', 'Solar storm', 'Asteroid strike', 'Plague', 'Famine', 'Revolt',
  'Independence', 'Breakthrough', 'New faith', 'Rich deposit found', 'Mutiny in transit',
  'Ship lost', 'Colony founded', 'Stage up', 'Collapse', 'War', 'Speciation',
  'Kessler cascade', 'Supernova', 'Gamma-ray burst', 'First contact', 'Dark forest strike',
  'Technology', 'Era change', 'Probe survey', 'Abandoned', 'Reactor accident', 'Baby boom',
  'AI schism', 'Megastructure complete', 'Ship launched', 'Ship arrived', 'Invention', 'No-go theorem',
] as const;
export type EventName = typeof EVENT_NAMES[number];
export const EV = Object.fromEntries(EVENT_NAMES.map((n, i) => [n, i])) as Record<EventName, number>;
