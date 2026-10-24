// The static board: star systems and the bodies a settlement can sit on.
// Real data near the Sun, procedural beyond it. Generated from a fixed seed
// so geography is identical across simulation seeds; only fate differs.

import { NEARBY_STARS, SOLAR_SYSTEM, type BodyKind, type Res5 } from './catalog.ts';
import { Rng } from './rng.ts';

export type Region = 'sol' | 'local' | 'galaxy' | 'extra';

export interface StarSystem {
  id: number;
  name: string;
  x: number; y: number; z: number; // light years, galactic frame, Sun at origin, +x toward galactic centre
  dist: number;                     // ly from the Sun
  spec: string;                     // O B A F G K M (+subclass)
  lum: number;                      // solar luminosities
  real: boolean;
  region: Region;
  galaxy: string;                   // 'Milky Way', 'Andromeda', ...
  bodies: number[];
}

export interface Body {
  id: number;
  name: string;
  system: number;
  parent: number;   // body id of the planet a moon orbits, else -1
  kind: BodyKind;
  a: number;        // AU from star (moons: thousand km from parent)
  period: number;   // years (moons: days)
  radius: number;   // km
  g: number;
  temp: number;     // K
  hab: number;
  res: Res5;
  flux: number;     // stellar flux relative to Earth
  settle: boolean;
  color: number;
}

export interface World {
  systems: StarSystem[];
  bodies: Body[];
  earth: number;
  mars: number;
}

export const GALACTIC_CENTRE: [number, number, number] = [26000, 0, 0];

export const GALAXIES = [
  { name: 'Milky Way', l: 0, b: 0, dist: 26000, radius: 50000, kind: 'spiral' },
  { name: 'Large Magellanic Cloud', l: 280.5, b: -32.9, dist: 163000, radius: 7000, kind: 'irregular' },
  { name: 'Small Magellanic Cloud', l: 302.8, b: -44.3, dist: 200000, radius: 3500, kind: 'irregular' },
  { name: 'Andromeda', l: 121.2, b: -21.6, dist: 2_537_000, radius: 110000, kind: 'spiral' },
  { name: 'Triangulum', l: 133.6, b: -31.3, dist: 2_730_000, radius: 30000, kind: 'spiral' },
] as const;

const SPEC_LUM: Record<string, number> = { O: 30000, B: 500, A: 15, F: 3, G: 1, K: 0.35, M: 0.02 };
const LETTERS = 'bcdefgh';

export function galToXYZ(l: number, b: number, d: number): [number, number, number] {
  const L = (l * Math.PI) / 180, B = (b * Math.PI) / 180;
  return [d * Math.cos(B) * Math.cos(L), d * Math.cos(B) * Math.sin(L), d * Math.sin(B)];
}

function eqToGal(ra: number, dec: number, d: number): [number, number, number] {
  const a = (ra * Math.PI) / 180, de = (dec * Math.PI) / 180;
  const ex = Math.cos(de) * Math.cos(a), ey = Math.cos(de) * Math.sin(a), ez = Math.sin(de);
  const gx = -0.0548755604 * ex - 0.8734370902 * ey - 0.4838350155 * ez;
  const gy = 0.4941094279 * ex - 0.44482963 * ey + 0.7469822445 * ez;
  const gz = -0.867666149 * ex - 0.1980763734 * ey + 0.4559837762 * ez;
  return [gx * d, gy * d, gz * d];
}

function specColorHab(spec: string): number {
  // how friendly the star is to life around it (flares, lifetime)
  return ({ O: 0.1, B: 0.2, A: 0.5, F: 0.85, G: 1, K: 1, M: 0.75 } as Record<string, number>)[spec[0]] ?? 0.6;
}

function randomSpec(r: Rng): string {
  const x = r.next();
  const cls = x < 0.6 ? 'M' : x < 0.8 ? 'K' : x < 0.92 ? 'G' : x < 0.97 ? 'F' : x < 0.99 ? 'A' : x < 0.998 ? 'B' : 'O';
  return cls + r.int(0, 9);
}

const NAME_PREFIX = ['HD', 'Gliese', 'LHS', 'Kepler', 'TOI', 'HIP', 'Ross', 'Wolf', 'LTT', 'GJ', 'TYC', 'K2', 'WISE', 'LP'];

function procName(r: Rng): string {
  const p = r.pick(NAME_PREFIX);
  const n = p === 'TYC' ? `${r.int(1000, 9999)}-${r.int(100, 2000)}-1` : p === 'WISE' ? `J${r.int(1000, 2359)}${r.next() < 0.5 ? '+' : '-'}${r.int(1000, 8959)}` : String(r.int(10, 99999));
  return `${p} ${n}`;
}

const KIND_RES: Record<BodyKind, Res5> = {
  rocky: [0.3, 0.6, 0.3, 0.4, 0.05], superearth: [0.4, 0.7, 0.5, 0.5, 0.05], ocean: [1, 0.3, 0.6, 0.2, 0.02],
  desert: [0.2, 0.6, 0.3, 0.5, 0.05], lava: [0, 0.9, 0.4, 0.8, 0], ice: [0.9, 0.2, 0.6, 0.1, 0.02],
  gas: [0.3, 0, 1, 0, 0.9], icegiant: [0.6, 0, 0.9, 0, 0.85], asteroid: [0.3, 0.8, 0.2, 0.6, 0.02],
  dwarf: [0.7, 0.3, 0.5, 0.2, 0.02], moon: [0.6, 0.4, 0.4, 0.3, 0.05], habitat: [0, 0, 0, 0, 0],
};

const KIND_COLOR: Record<BodyKind, number[]> = {
  rocky: [0x9b8a7a, 0x7f7468, 0xb09a84], superearth: [0x7d8f6a, 0x9a8263, 0x6b7f8a], ocean: [0x2f6fb8, 0x3a8cc4, 0x2c5c9a],
  desert: [0xc98b52, 0xd6a46a, 0xb5653a], lava: [0xc4441e, 0x8a2c18, 0xe06a2c], ice: [0xd8e6ee, 0xb8cfdc, 0xe9eef2],
  gas: [0xd8b07c, 0xc89a6a, 0xe2c79c], icegiant: [0x8fc8d8, 0x6aa0d8, 0x9fd0c8], asteroid: [0x8a8178, 0x6e675f, 0x9e958a],
  dwarf: [0xb8a896, 0xcbbca8, 0x9a8c7e], moon: [0xa8a29a, 0x8e877e, 0xbcb4a8], habitat: [0xdddddd],
};

function jitterRes(r: Rng, base: Res5, spread = 0.25): Res5 {
  return base.map((v) => Math.min(1, Math.max(0, v + (r.next() - 0.5) * 2 * spread))) as Res5;
}

function procBodyKind(r: Rng, spec: string): BodyKind {
  const x = r.next();
  if (spec[0] === 'M') return x < 0.45 ? 'rocky' : x < 0.65 ? 'superearth' : x < 0.75 ? 'ocean' : x < 0.85 ? 'ice' : x < 0.93 ? 'asteroid' : 'gas';
  return x < 0.22 ? 'rocky' : x < 0.4 ? 'superearth' : x < 0.5 ? 'ocean' : x < 0.6 ? 'desert' : x < 0.68 ? 'lava' : x < 0.76 ? 'ice' : x < 0.86 ? 'asteroid' : x < 0.94 ? 'gas' : 'icegiant';
}

const KIND_HAB: Record<BodyKind, [number, number]> = {
  rocky: [0.03, 0.45], superearth: [0.03, 0.4], ocean: [0.15, 0.65], desert: [0.05, 0.35], lava: [0, 0.05],
  ice: [0.04, 0.25], gas: [0, 0], icegiant: [0, 0], asteroid: [0.04, 0.14], dwarf: [0.04, 0.2], moon: [0.05, 0.35], habitat: [0, 0],
};

export function buildWorld(seed = 2040): World {
  const r = new Rng(seed);
  const systems: StarSystem[] = [];
  const bodies: Body[] = [];

  const addSystem = (s: Omit<StarSystem, 'id' | 'bodies' | 'dist'>): StarSystem => {
    const sys: StarSystem = { ...s, id: systems.length, bodies: [], dist: Math.hypot(s.x, s.y, s.z) };
    systems.push(sys);
    return sys;
  };
  const addBody = (sys: StarSystem, b: Omit<Body, 'id' | 'system'>): Body => {
    const body: Body = { ...b, id: bodies.length, system: sys.id };
    bodies.push(body);
    sys.bodies.push(body.id);
    return body;
  };

  // --- Sol
  const sol = addSystem({ name: 'Sol', x: 0, y: 0, z: 0, spec: 'G2', lum: 1, real: true, region: 'sol', galaxy: 'Milky Way' });
  const byName = new Map<string, Body>();
  for (const s of SOLAR_SYSTEM) {
    const parent = s.parent ? byName.get(s.parent)! : undefined;
    const a = parent ? parent.a : s.a;
    const b = addBody(sol, {
      name: s.name, parent: parent ? parent.id : -1, kind: s.kind, a: s.a,
      // moons: days, from GM = g * R^2 of the parent; planets: years
      period: parent ? (2 * Math.PI * Math.sqrt((s.a * 1e6) ** 3 / (parent.g * 9.81 * (parent.radius * 1000) ** 2))) / 86400 : Math.pow(s.a, 1.5),
      radius: s.radius, g: s.g, temp: s.temp, hab: s.hab, res: s.res, flux: 1 / (a * a),
      settle: s.settle !== false, color: s.color ?? 0x999999,
    });
    byName.set(s.name, b);
  }

  // --- Real nearby stars
  for (const st of NEARBY_STARS) {
    const [x, y, z] = eqToGal(st.ra, st.dec, st.dist);
    const lum = SPEC_LUM[st.spec[0]] * (st.spec[0] === 'M' ? Math.pow(0.6, Number(st.spec.slice(1)) / 2) : 1);
    const sys = addSystem({ name: st.name, x, y, z, spec: st.spec, lum, real: true, region: 'local', galaxy: 'Milky Way' });
    for (const p of st.planets) {
      const radius = 6371 * Math.pow(Math.max(p.mass, 0.001), p.mass > 10 ? 0.06 : 0.28) * (p.mass > 10 ? 5 : 1);
      addBody(sys, {
        name: p.name, parent: -1, kind: p.kind, a: p.a, period: Math.sqrt(p.a ** 3 / Math.max(lum, 0.01) ** 0.5),
        radius, g: p.kind === 'asteroid' ? 0.01 : Math.max(0.05, p.mass / (radius / 6371) ** 2), temp: p.temp,
        hab: p.hab * specColorHab(st.spec), res: p.res ?? jitterRes(r, KIND_RES[p.kind], 0.15),
        flux: Math.pow(p.temp / 278, 4), settle: p.kind !== 'gas' && p.kind !== 'icegiant',
        color: r.pick(KIND_COLOR[p.kind]),
      });
    }
  }

  // --- Procedural local neighbourhood: notable systems out to 900 ly
  const N_LOCAL = 6000;
  for (let i = 0; i < N_LOCAL; i++) {
    // N(<d) grows as d^1.5: a sample of the real ~0.004 stars/ly^3 that thins with
    // distance (the old d^0.6 law put 400 systems inside 20 ly; the sky has ~130)
    const d = 13 + Math.pow(r.next(), 2 / 3) * 887;
    const u = r.range(-1, 1), th = r.range(0, Math.PI * 2);
    const flat = Math.sqrt(1 - u * u);
    const x = d * flat * Math.cos(th), y = d * flat * Math.sin(th), z = d * u * 0.45;
    const spec = randomSpec(r);
    const lum = SPEC_LUM[spec[0]] * r.range(0.5, 1.6);
    const sys = addSystem({ name: procName(r), x, y, z, spec, lum, real: false, region: 'local', galaxy: 'Milky Way' });
    const n = r.next() < 0.45 ? 1 : r.next() < 0.7 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const kind = procBodyKind(r, spec);
      const [h0, h1] = KIND_HAB[kind];
      const hab = (h0 + Math.pow(r.next(), 2.2) * (h1 - h0)) * specColorHab(spec);
      const a = Math.sqrt(lum) * r.range(0.3, 2.5) * (kind === 'gas' || kind === 'icegiant' ? 4 : 1);
      const flux = lum / (a * a);
      const temp = 278 * Math.pow(flux, 0.25);
      const mass = kind === 'superearth' ? r.range(2, 9) : kind === 'gas' ? r.range(50, 900) : kind === 'icegiant' ? r.range(10, 40) : kind === 'asteroid' ? 0.001 : r.range(0.3, 1.8);
      const radius = kind === 'asteroid' ? r.range(50, 500) : 6371 * Math.pow(mass, 0.28) * (mass > 10 ? 3.5 : 1);
      addBody(sys, {
        name: `${sys.name} ${LETTERS[k]}`, parent: -1, kind, a, period: Math.sqrt(a ** 3),
        radius, g: kind === 'asteroid' ? 0.01 : Math.max(0.05, mass / (radius / 6371) ** 2), temp, hab,
        res: jitterRes(r, KIND_RES[kind]), flux, settle: kind !== 'gas' && kind !== 'icegiant',
        color: r.pick(KIND_COLOR[kind]),
      });
    }
  }

  // --- Far Milky Way: reachable only with faster-than-light tech
  const N_FAR = 1400;
  for (let i = 0; i < N_FAR; i++) {
    const R = 3000 + Math.pow(r.next(), 0.8) * 42000;
    const arm = r.int(0, 3);
    const theta = Math.log(R / 3000) / 0.22 + (arm * Math.PI) / 2 + r.gauss() * 0.25;
    const gx = R * Math.cos(theta), gy = R * Math.sin(theta), gz = r.gauss() * 300;
    const spec = randomSpec(r);
    const sys = addSystem({
      name: procName(r), x: gx + GALACTIC_CENTRE[0], y: gy, z: gz, spec, lum: SPEC_LUM[spec[0]],
      real: false, region: 'galaxy', galaxy: 'Milky Way',
    });
    const kind = r.pick<BodyKind>(['rocky', 'superearth', 'ocean', 'desert', 'ice', 'moon']);
    const [h0, h1] = KIND_HAB[kind];
    addBody(sys, {
      name: `${sys.name} b`, parent: -1, kind, a: 1, period: 1, radius: 6371 * r.range(0.6, 1.8), g: r.range(0.4, 1.6),
      temp: r.range(200, 320), hab: h0 + r.next() * (h1 - h0), res: jitterRes(r, KIND_RES[kind]), flux: 1, settle: true,
      color: r.pick(KIND_COLOR[kind]),
    });
  }

  // --- Other galaxies: reachable only through wormholes
  for (const gal of GALAXIES.slice(1)) {
    const [cx, cy, cz] = galToXYZ(gal.l, gal.b, gal.dist);
    for (let i = 0; i < 40; i++) {
      const rr = Math.pow(r.next(), 0.6) * gal.radius;
      const th = r.range(0, Math.PI * 2);
      const spec = randomSpec(r);
      const sys = addSystem({
        name: `${gal.name.split(' ').map((w) => w[0]).join('')}-${procName(r)}`, x: cx + rr * Math.cos(th), y: cy + rr * Math.sin(th), z: cz + r.gauss() * gal.radius * 0.05,
        spec, lum: SPEC_LUM[spec[0]], real: false, region: 'extra', galaxy: gal.name,
      });
      const kind = r.pick<BodyKind>(['rocky', 'superearth', 'ocean', 'desert']);
      addBody(sys, {
        name: `${sys.name} b`, parent: -1, kind, a: 1, period: 1, radius: 6371 * r.range(0.7, 1.6), g: r.range(0.5, 1.4),
        temp: r.range(220, 310), hab: r.range(0.2, 0.7), res: jitterRes(r, KIND_RES[kind]), flux: 1, settle: true,
        color: r.pick(KIND_COLOR[kind]),
      });
    }
  }

  return { systems, bodies, earth: byName.get('Earth')!.id, mars: byName.get('Mars')!.id };
}
