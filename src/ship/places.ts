// Everywhere the ship can go. Positions are in light years, equatorial frame,
// Sun at the origin, y = celestial north. Real data comes from the sim catalog;
// a few deep-sky landmarks are added here, and "random" systems are generated
// on demand from a seed.

import * as THREE from 'three';
import { NEARBY_STARS, SOLAR_SYSTEM, type BodyKind } from '../sim/catalog.ts';
import { Rng } from '../sim/rng.ts';

export type PlaceKind = 'star' | 'blackhole' | 'nebula' | 'galaxy';

export interface Planet {
  name: string;
  kind: BodyKind;
  a: number;            // AU, or thousand km from parent for moons
  radiusKm: number;
  color: number;
  parent?: string;
  rings?: boolean;
  belt?: boolean;       // asteroid belt drawn as a ring of rocks
  temp?: number;
  massE?: number;
  blurb?: string;
}

export interface System {
  id: string;
  name: string;
  kind: PlaceKind;
  pos: THREE.Vector3;      // ly
  view?: THREE.Vector3;    // ly offset of the observer from pos (galaxies, nebulae)
  spec: string;
  lum: number;             // solar luminosities
  starRadius: number;      // solar radii
  massSun: number;
  planets: Planet[];
  blurb?: string;
  nebula?: { colors: [number, number, number][]; stars: number; starColor: number; pulsar?: boolean };
  generated?: boolean;
}

export interface Destination {
  system: System;
  body?: string;           // planet name; undefined = the star / object itself
  label: string;
  names: string[];         // normalized match keys
}

export const NOW_YEAR = 2026;
export const BIG_BANG = -13.787e9;

export function radec(raDeg: number, decDeg: number, dist: number): THREE.Vector3 {
  const ra = (raDeg * Math.PI) / 180, dec = (decDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.sin(dec), -Math.cos(dec) * Math.sin(ra)).multiplyScalar(dist);
}

const LETTER_LUM: Record<string, number> = { O: 40000, B: 800, A: 20, F: 3, G: 1, K: 0.35, M: 0.012 };
const LETTER_RADIUS: Record<string, number> = { O: 10, B: 5, A: 1.8, F: 1.3, G: 1, K: 0.8, M: 0.3 };
const LETTER_MASS: Record<string, number> = { O: 30, B: 6, A: 2, F: 1.3, G: 1, K: 0.75, M: 0.25 };

function specScale(spec: string): number {
  const sub = Number(spec.slice(1)) || 0;
  return Math.pow(10, -sub * 0.08);
}
export function lumOf(spec: string): number { return (LETTER_LUM[spec[0]] ?? 1) * specScale(spec); }
function radiusOf(spec: string): number { return (LETTER_RADIUS[spec[0]] ?? 1) * Math.pow(specScale(spec), 0.35); }
function massOf(spec: string): number { return (LETTER_MASS[spec[0]] ?? 1) * Math.pow(specScale(spec), 0.3); }

const KIND_COLOR: Record<BodyKind, number> = {
  rocky: 0x9a8f86, superearth: 0x8c9a7e, ocean: 0x3d6fc8, desert: 0xc98a52, lava: 0x6a3a2a, ice: 0xcfe0ee,
  gas: 0xd2ad82, icegiant: 0x86c6d8, asteroid: 0x8d8478, dwarf: 0xbfb2a2, moon: 0xb5b0a8, habitat: 0xcccccc,
};

function exoRadius(kind: BodyKind, massE: number): number {
  if (kind === 'gas') return 50000 + Math.min(25000, massE * 30);
  if (kind === 'icegiant') return 24000 + massE * 200;
  return 6371 * Math.pow(Math.max(massE, 0.05), 0.28);
}

// ------------------------------------------------------------------ Sol

const SOL_BLURBS: Record<string, string> = {
  Earth: 'Home. Blue, wet, and the only place we know has pizza.',
  Moon: 'Twelve people have walked here. Nobody since 1972.',
  Mars: 'Rust-red desert, the tallest volcano in the solar system, and a lot of rovers.',
  Jupiter: 'More than twice the mass of every other planet combined. The Great Red Spot is bigger than Earth.',
  Saturn: 'The rings are mostly water ice, some of it house-sized.',
  Venus: 'Surface hot enough to melt lead, under clouds of sulfuric acid.',
  Mercury: 'Closest to the Sun. Days hotter than an oven, nights colder than Antarctica.',
  Europa: 'An ocean under the ice with more water than all of Earth\'s.',
  Titan: 'Thick orange haze and lakes of liquid methane.',
  Enceladus: 'It sprays its ocean into space through cracks at the south pole.',
  Pluto: 'Has a heart-shaped glacier. Still a planet in our hearts.',
  Neptune: 'The windiest place in the solar system: 2,000 km/h.',
  Uranus: 'Rolls around the Sun on its side.',
  Io: 'The most volcanic place we know of.',
};

export const SOL: System = {
  id: 'sol', name: 'Sun', kind: 'star', pos: new THREE.Vector3(), spec: 'G2', lum: 1, starRadius: 1, massSun: 1,
  blurb: 'Our star. 4.6 billion years old, about halfway through its life.',
  planets: SOLAR_SYSTEM.map((b) => ({
    name: b.name, kind: b.kind, a: b.a, radiusKm: b.radius, color: b.color ?? KIND_COLOR[b.kind], parent: b.parent,
    rings: b.name === 'Saturn' || b.name === 'Uranus', temp: b.temp, blurb: SOL_BLURBS[b.name],
  })),
};

// ------------------------------------------------------------------ nearby stars

const STAR_BLURBS: Record<string, string> = {
  'Proxima Centauri': 'The closest star to the Sun. A small red flare star.',
  'Alpha Centauri A': 'A near-twin of the Sun, 4.37 light years away.',
  Sirius: 'The brightest star in Earth\'s night sky, with a white dwarf companion.',
  'TRAPPIST-1': 'Seven Earth-sized planets packed closer than Mercury is to the Sun.',
  'Tau Ceti': 'A quiet Sun-like star with a crowd of super-Earths.',
  Vega: 'Spins so fast it bulges at the equator.',
};
const PLANET_BLURBS: Record<string, string> = {
  'Proxima b': 'Tidally locked: one side always day, one side always night.',
  'TRAPPIST-1 e': 'The best bet in the system for liquid water.',
  'Kepler-452 b': 'Called Earth\'s older cousin: a year of 385 days around a Sun-like star.',
  'K2-18 b': 'Possibly a water world under a hydrogen sky.',
  '55 Cancri e': 'A lava world so hot its dayside could melt iron.',
  Vulcan: 'Yes, that one. 40 Eridani, sixteen light years out.',
};

const NEARBY: System[] = NEARBY_STARS.map((s) => {
  const id = slug(s.name);
  return {
    id, name: s.name, kind: 'star', pos: radec(s.ra, s.dec, s.dist), spec: s.spec,
    lum: s.name === 'Sirius' ? 25 : s.name === 'Vega' ? 40 : s.name === 'Procyon' ? 7 : s.name === 'Altair' ? 10 : s.name === 'Fomalhaut' ? 16 : lumOf(s.spec),
    starRadius: s.name === 'Sirius' ? 1.7 : s.name === 'Vega' ? 2.4 : radiusOf(s.spec),
    massSun: massOf(s.spec),
    blurb: STAR_BLURBS[s.name],
    planets: s.planets.map((p) => ({
      name: p.name, kind: p.kind, a: p.a, radiusKm: exoRadius(p.kind, p.mass), color: KIND_COLOR[p.kind],
      belt: p.kind === 'asteroid', rings: p.kind === 'gas' && p.mass > 100, temp: p.temp, massE: p.mass, blurb: PLANET_BLURBS[p.name],
    })),
  };
});

// ------------------------------------------------------------------ bright naked-eye stars (sky + destinations)

// [name, ra, dec, ly, Lsun, spec]
export const BRIGHT: [string, number, number, number, number, string][] = [
  ['Canopus', 95.99, -52.7, 310, 10700, 'F0'], ['Arcturus', 213.92, 19.18, 36.7, 170, 'K1'],
  ['Capella', 79.17, 46.0, 42.9, 79, 'G3'], ['Rigel', 78.63, -8.2, 860, 120000, 'B8'],
  ['Achernar', 24.43, -57.24, 139, 3150, 'B6'], ['Betelgeuse', 88.79, 7.41, 548, 100000, 'M1'],
  ['Aldebaran', 68.98, 16.51, 65, 440, 'K5'], ['Antares', 247.35, -26.43, 550, 75000, 'M1'],
  ['Spica', 201.3, -11.16, 250, 20500, 'B1'], ['Pollux', 116.33, 28.03, 34, 33, 'K0'],
  ['Deneb', 310.36, 45.28, 2600, 196000, 'A2'], ['Regulus', 152.09, 11.97, 79, 316, 'B8'],
  ['Bellatrix', 81.28, 6.35, 250, 9200, 'B2'], ['Alnilam', 84.05, -1.2, 2000, 420000, 'B0'],
  ['Alnitak', 85.19, -1.94, 1260, 250000, 'O9'], ['Mintaka', 83.0, -0.3, 1200, 190000, 'O9'],
  ['Saiph', 86.94, -9.67, 650, 56000, 'B0'], ['Polaris', 37.95, 89.26, 433, 2500, 'F7'],
  ['Alcyone', 56.87, 24.11, 440, 2400, 'B7'], ['Dubhe', 165.93, 61.75, 123, 316, 'K0'],
  ['Merak', 165.46, 56.38, 79, 63, 'A1'], ['Phecda', 178.46, 53.69, 83, 71, 'A0'],
  ['Megrez', 183.86, 57.03, 58, 14, 'A3'], ['Alioth', 193.51, 55.96, 83, 102, 'A1'],
  ['Mizar', 200.98, 54.93, 86, 33, 'A2'], ['Alkaid', 206.89, 49.31, 104, 1350, 'B3'],
  ['Schedar', 10.13, 56.54, 228, 676, 'K0'], ['Caph', 2.29, 59.15, 54.7, 27, 'F2'],
  ['Gamma Cassiopeiae', 14.18, 60.72, 550, 34000, 'B0'], ['Ruchbah', 21.45, 60.24, 99, 74, 'A5'],
  ['Segin', 28.6, 63.67, 410, 2500, 'B3'], ['Castor', 113.65, 31.89, 51, 30, 'A1'],
  ['Hadar', 210.96, -60.37, 390, 41000, 'B1'], ['Acrux', 186.65, -63.1, 320, 25000, 'B0'],
  ['Mimosa', 191.93, -59.69, 280, 34000, 'B0'], ['Gacrux', 187.79, -57.11, 88, 820, 'M3'],
];

const BRIGHT_BLURBS: Record<string, string> = {
  Betelgeuse: 'A red supergiant. Drop it where the Sun is and it would swallow Jupiter. It will go supernova, maybe within 100,000 years.',
  Rigel: 'A blue supergiant, about 120,000 times brighter than the Sun.',
  Polaris: 'The North Star. Not the brightest, just in the right spot.',
  Antares: 'The red heart of Scorpius, about 700 times wider than the Sun.',
  Deneb: 'One of the most luminous stars you can see with the naked eye, 2,600 light years away.',
  Canopus: 'Second-brightest star in the sky. Spacecraft use it to navigate.',
  Arcturus: 'An old orange giant cruising through the galactic disk on its own path.',
};

const BRIGHT_SYSTEMS: System[] = BRIGHT.map(([name, ra, dec, ly, lum, spec]) => {
  const giant = lum > 50;
  const radius = name === 'Betelgeuse' ? 760 : name === 'Antares' ? 680 : name === 'Aldebaran' ? 44 : name === 'Arcturus' ? 25 : name === 'Pollux' ? 9 : giant ? Math.sqrt(lum) * 0.2 * (spec[0] === 'M' || spec[0] === 'K' ? 6 : 1) : radiusOf(spec);
  return { id: slug(name), name, kind: 'star', pos: radec(ra, dec, ly), spec, lum, starRadius: Math.max(radius, 0.5), massSun: giant ? 12 : massOf(spec), planets: [], blurb: BRIGHT_BLURBS[name] };
});

// ------------------------------------------------------------------ deep sky

export const GALACTIC_CENTER = radec(266.42, -29.01, 26700);
export const GALACTIC_POLE = radec(192.86, 27.13, 1).normalize();
export const ANDROMEDA = radec(10.68, 41.27, 2.537e6);

const DEEP: System[] = [
  {
    id: 'sgr-a', name: 'Sagittarius A*', kind: 'blackhole', pos: GALACTIC_CENTER.clone(), spec: 'X', lum: 0, starRadius: 17, massSun: 4.3e6, planets: [],
    blurb: 'The supermassive black hole at the center of the Milky Way. Four million Suns, squeezed into something smaller than Mercury\'s orbit.',
  },
  {
    id: 'andromeda', name: 'Andromeda Galaxy', kind: 'galaxy', pos: ANDROMEDA.clone(), view: radec(10.68 + 160, 41.27 - 38, 1).normalize().multiplyScalar(240000),
    spec: 'X', lum: 0, starRadius: 0, massSun: 1e12, planets: [],
    blurb: 'Our nearest big neighbour: a trillion stars. It\'s heading our way at 110 km/s and will hit the Milky Way in about 4.5 billion years.',
  },
  {
    id: 'orion-nebula', name: 'Orion Nebula', kind: 'nebula', pos: radec(83.82, -5.39, 1344), view: new THREE.Vector3(18, 6, 14), spec: 'O7', lum: 200000, starRadius: 8, massSun: 30, planets: [],
    nebula: { colors: [[255, 90, 120], [120, 170, 255], [255, 180, 120], [90, 230, 200]], stars: 40, starColor: 0xb8d0ff },
    blurb: 'A stellar nursery 1,344 light years out. The stars here are only a few million years old.',
  },
  {
    id: 'crab-nebula', name: 'Crab Nebula', kind: 'nebula', pos: radec(83.63, 22.01, 6500), view: new THREE.Vector3(9, 3, 7), spec: 'X', lum: 75000, starRadius: 0.2, massSun: 1.4, planets: [],
    nebula: { colors: [[255, 120, 80], [120, 200, 255], [255, 220, 150]], stars: 0, starColor: 0xffffff, pulsar: true },
    blurb: 'What\'s left of a star that exploded in 1054. Chinese astronomers saw it in daylight. A pulsar in the middle spins 30 times a second.',
  },
  {
    id: 'pleiades', name: 'Pleiades', kind: 'nebula', pos: radec(56.75, 24.12, 444), view: new THREE.Vector3(10, 4, 12), spec: 'B7', lum: 2400, starRadius: 6, massSun: 6, planets: [],
    nebula: { colors: [[110, 150, 255], [160, 190, 255]], stars: 14, starColor: 0xaac4ff },
    blurb: 'The Seven Sisters: a young cluster of hot blue stars flying through a dust cloud.',
  },
];

// ------------------------------------------------------------------ catalog

export const SYSTEMS: System[] = [SOL, ...NEARBY, ...BRIGHT_SYSTEMS, ...DEEP];

const ALIASES: Record<string, string[]> = {
  sol: ['sun', 'the sun', 'sol', 'solar system', 'home system'],
  'alpha-centauri-a': ['alpha centauri', 'alpha cen', 'rigil kentaurus', 'centauri'],
  'proxima-centauri': ['proxima', 'closest star', 'nearest star'],
  'trappist-1': ['trappist'],
  'sgr-a': ['galactic center', 'center of the galaxy', 'centre of the galaxy', 'middle of the galaxy', 'black hole', 'sagittarius a', 'sgr a', 'supermassive black hole'],
  andromeda: ['andromeda', 'm31', 'another galaxy', 'next galaxy', 'neighbor galaxy'],
  'orion-nebula': ['orion', 'm42', 'nebula', 'star nursery', 'stellar nursery'],
  'crab-nebula': ['crab', 'supernova', 'pulsar', 'm1'],
  pleiades: ['seven sisters', 'm45', 'subaru'],
  polaris: ['north star', 'pole star'],
  '40-eridani': ['vulcan system'],
  'barnard-s-star': ['barnards star', 'barnard'],
};
const BODY_ALIASES: Record<string, string[]> = {
  Earth: ['earth', 'home', 'terra', 'our planet'],
  Moon: ['the moon', 'moon', 'luna'],
  Mars: ['mars', 'the red planet', 'red planet'],
  Pluto: ['pluto'],
  'Proxima b': ['proxima b'],
  'TRAPPIST-1 e': ['trappist 1 e', 'trappist e'],
  'Kepler-452 b': ['earth 2', 'earths cousin', 'earth s cousin', 'kepler 452b'],
};

export function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
export function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, '').replace(/\*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export const DESTINATIONS: Destination[] = [];
function addDestinations(sys: System): void {
  const sysNames = [norm(sys.name), ...(ALIASES[sys.id] ?? [])];
  DESTINATIONS.push({ system: sys, label: sys.name, names: sysNames.map(norm) });
  for (const p of sys.planets) {
    if (p.belt) continue;
    const names = [norm(p.name), ...(BODY_ALIASES[p.name] ?? []).map(norm)];
    // "trappist 1 e" also matches "trappist 1e"
    const compact = norm(p.name).replace(/ ([a-z])$/, '$1');
    if (compact !== names[0]) names.push(compact);
    DESTINATIONS.push({ system: sys, body: p.name, label: p.name, names });
  }
}
SYSTEMS.forEach(addDestinations);

export function findSystem(id: string): System | undefined { return SYSTEMS.find((s) => s.id === id); }

/** Where the observer sits for a system, in ly. */
export function observerPos(sys: System): THREE.Vector3 {
  return sys.view ? sys.pos.clone().add(sys.view) : sys.pos.clone();
}

// ------------------------------------------------------------------ random systems

const SYL_A = ['Ka', 'Vel', 'Or', 'Zan', 'Mir', 'Tal', 'Xe', 'Qu', 'Ry', 'Sol', 'Ae', 'Dra', 'Ny', 'Bel', 'Cor', 'Ith', 'Lun', 'Vos', 'Ky', 'Ema'];
const SYL_B = ['ra', 'nis', 'thar', 'lo', 'vex', 'dun', 'ria', 'kos', 'mere', 'phae', 'tor', 'lune', 'qar', 'sel', 'vin', 'dra', 'xis', 'mar'];
const SUFFIX = ['Prime', 'Minor', 'Reach', 'Deep', 'Drift', 'Gate', ''];
const CATALOGS = ['Kepler', 'HD', 'TOI', 'KOI', 'Gliese', 'WISE', 'TYC', 'LHS'];

const RANDOM_KINDS: BodyKind[] = ['rocky', 'superearth', 'ocean', 'desert', 'lava', 'ice', 'gas', 'icegiant'];
const RANDOM_QUIPS = [
  'Nobody has ever been here. Including us, until now.',
  'Uncharted. Our sensors are making it up as they go.',
  'Not in any catalogue. You found it, you name it.',
  'Long-range scan says: weird, but probably fine.',
  'Gravity feels about right. Smell is undetermined.',
];

let randomCount = 0;

/** Generate a never-before-seen system somewhere in the galactic disk. */
export function randomSystem(seed: number, opts: { habitable?: boolean; kind?: BodyKind } = {}): { system: System; dest: Destination } {
  const r = new Rng(seed);
  const fantasy = r.next() < 0.55;
  const base = fantasy
    ? `${r.pick(SYL_A)}${r.pick(SYL_B)}${r.next() < 0.4 ? r.pick(SYL_B) : ''}`
    : `${r.pick(CATALOGS)}-${r.int(100, 9999)}`;
  const specRoll = r.next();
  const letter = specRoll < 0.45 ? 'M' : specRoll < 0.68 ? 'K' : specRoll < 0.86 ? 'G' : specRoll < 0.95 ? 'F' : specRoll < 0.99 ? 'A' : 'B';
  const spec = `${letter}${r.int(0, 9)}`;
  // random direction, flattened toward the galactic plane
  const dist = Math.pow(10, r.range(1.6, 3.6));
  const dir = new THREE.Vector3(r.gauss(), r.gauss(), r.gauss()).normalize();
  dir.addScaledVector(GALACTIC_POLE, -dir.dot(GALACTIC_POLE) * 0.75).normalize();
  const lum = lumOf(spec);
  const habA = Math.sqrt(lum);
  const n = r.int(2, 7);
  const planets: Planet[] = [];
  let a = habA * r.range(0.15, 0.4);
  for (let i = 0; i < n; i++) {
    const t = 278 * Math.pow(lum, 0.25) / Math.sqrt(a);
    let kind: BodyKind;
    if (t > 900) kind = 'lava';
    else if (a > habA * 3) kind = r.next() < 0.6 ? 'gas' : r.next() < 0.6 ? 'icegiant' : 'ice';
    else if (t > 240 && t < 330) kind = r.pick(['ocean', 'superearth', 'desert', 'rocky'] as BodyKind[]);
    else kind = r.pick(RANDOM_KINDS);
    const massE = kind === 'gas' ? r.range(40, 900) : kind === 'icegiant' ? r.range(8, 30) : r.range(0.2, 8);
    const name = `${base}${fantasy ? ' ' + 'I II III IV V VI VII'.split(' ')[i] : ' ' + 'bcdefgh'[i]}`;
    planets.push({
      name, kind, a, radiusKm: exoRadius(kind, massE), massE, temp: Math.round(t),
      color: new THREE.Color(KIND_COLOR[kind]).offsetHSL(r.range(-0.08, 0.08), r.range(-0.15, 0.15), r.range(-0.08, 0.08)).getHex(),
      rings: (kind === 'gas' || kind === 'icegiant') && r.next() < 0.55,
    });
    a *= r.range(1.5, 2.3);
  }
  const sysName = fantasy ? `${base} ${r.pick(SUFFIX)}`.trim() : base;
  const system: System = {
    id: `rnd-${seed}`, name: sysName, kind: 'star', pos: dir.multiplyScalar(dist), spec, lum,
    starRadius: radiusOf(spec), massSun: massOf(spec), planets, generated: true, blurb: r.pick(RANDOM_QUIPS),
  };
  // choose the most interesting planet as the target
  let pick = planets[0];
  let best = -1;
  for (const p of planets) {
    let score = r.next();
    if (opts.habitable && (p.kind === 'ocean' || p.kind === 'superearth')) score += 3;
    if (opts.kind && p.kind === opts.kind) score += 4;
    if (p.rings) score += 0.8;
    if (p.kind === 'ocean' || p.kind === 'lava') score += 0.5;
    if (score > best) { best = score; pick = p; }
  }
  randomCount++;
  SYSTEMS.push(system);
  addDestinations(system);
  const dest = DESTINATIONS.find((d) => d.system === system && d.body === pick.name)!;
  return { system, dest };
}
export function randomCountSoFar(): number { return randomCount; }

// ------------------------------------------------------------------ time

export function formatYear(y: number): string {
  const ago = NOW_YEAR - y;
  if (Math.abs(ago) >= 100000) {
    const v = Math.abs(ago);
    const s = v >= 1e12 ? `${trim(v / 1e12)} trillion` : v >= 1e9 ? `${trim(v / 1e9)} billion` : v >= 1e6 ? `${trim(v / 1e6)} million` : `${Math.round(v / 1000).toLocaleString()},000`;
    return ago > 0 ? `${s} years ago` : `${s} years from now`;
  }
  const yi = Math.round(y);
  return yi >= 1 ? `${yi} CE` : `${(1 - yi).toLocaleString()} BCE`;
}
function trim(v: number): string { return v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''); }

/** What the Sun is doing in a given year. */
export type SunPhase = 'void' | 'cloud' | 'proto' | 'main' | 'giant' | 'dwarf';
export function sunPhase(year: number): SunPhase {
  if (year < BIG_BANG + 2e8) return 'void';
  if (year < -4.6e9) return 'cloud';
  if (year < -4.5e9) return 'proto';
  if (year < 5.4e9) return 'main';
  if (year < 7.6e9) return 'giant';
  return 'dwarf';
}

/** Short line for what's going on in a year, from Earth's point of view. */
export function eraNote(year: number): string {
  const ago = NOW_YEAR - year;
  if (year <= BIG_BANG + 1e6) return 'The universe is a glowing fog of hydrogen. No stars yet. Nothing to see but heat.';
  if (year < BIG_BANG + 2e8) return 'The cosmic dark ages. The first stars haven\'t switched on yet.';
  if (year < -4.6e9) return 'The Sun doesn\'t exist yet. Just a cold cloud of gas and dust where it will be born.';
  if (year < -4.5e9) return 'The baby Sun has just ignited, wrapped in a disk of dust that will become the planets.';
  if (year < -3.8e9) return 'Earth is a ball of magma, getting pounded by asteroids. The Moon is way closer.';
  if (year < -2.4e9) return 'Earth has oceans and single-celled life, but no oxygen in the air.';
  if (year < -7.5e8) return 'The boring billion. Bacteria, slime, and slowly rising oxygen.';
  if (year < -5.4e8) return 'Snowball Earth. The planet is frozen almost pole to pole.';
  if (year < -2.52e8) return 'Life has exploded in the oceans and is crawling onto land.';
  if (year < -6.6e7) return 'Dinosaurs run the place. Don\'t land.';
  if (year < -6.5e7) return 'The asteroid just hit. Bad day to be a dinosaur.';
  if (year < -3e5) return 'Mammals are taking over. No humans yet.';
  if (year < -12000) return 'Ice age. Humans are hunting mammoths with spears.';
  if (year < -3000) return 'People have started farming. The first towns are going up.';
  if (year < 500) return 'The ancient world: pyramids, Rome, empires, philosophers.';
  if (year < 1500) return 'Middle Ages. No electric lights anywhere on the night side.';
  if (year < 1900) return 'Ships, then steam engines. The night side is still almost dark.';
  if (year < 1957) return 'The age of electricity and two world wars. Nothing human in orbit yet.';
  if (year < 2030) return ago >= 0 && ago < 1 ? 'Present day.' : 'The space age. Satellites everywhere, footprints on the Moon.';
  if (year < 3000) return 'Humans are spreading through the solar system. Mars has cities.';
  if (year < 1e6) return 'Mars has been terraformed. Earth is ringed with orbital habitats.';
  if (year < 1e9) return 'The constellations are unrecognizable. Every star has drifted.';
  if (year < 4.5e9) return 'The Sun is noticeably brighter. Earth\'s oceans are boiling away.';
  if (year < 5.4e9) return 'Andromeda and the Milky Way are colliding. The night sky is on fire with stars.';
  if (year < 7.6e9) return 'The Sun is a red giant. Mercury and Venus have been swallowed.';
  if (year < 1e12) return 'The Sun is a white dwarf, a cooling ember the size of Earth.';
  if (year < 1e14) return 'The last stars are being born. Red dwarfs are all that\'s left.';
  return 'Heat death. Every star has burned out. It\'s dark and it\'s staying dark.';
}
