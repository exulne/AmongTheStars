// Explaining a particle galaxy: every star particle, star-forming knot, dust
// cloud, nebula and the core. Properties are derived from what makeGalaxy drew
// (its palette slot, brightness and position), so the card always agrees with
// the dot: a blue dot is a hot star, a brighter warm dot in the bulge is a
// giant, a dot further out is poorer in metals.

import * as THREE from 'three';
import { GALAXIES, type World } from '../sim/world.ts';
import { META, metaArm, metaComp, metaPal, type GalaxyData } from '../view/galaxyPoints.ts';
import { specColor } from '../view/textures.ts';
import { an, num, LUM_WORD, colourWord, fmtLy, fmtYears, galLB, galToEq, gName, habZone, jName, lifetime, mainSequence, sig, specName, specNum, type LumClass } from './astro.ts';
import { addCpuSet, addGpuSet, nearestPoint, pxPerUnit, toScreen, type Probe } from './picker.ts';
import { coin, h01, hGauss, hPoisson, pointWorld, registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';
import { calYear, humansFact, statusText, sysStatus } from './simInfo.ts';

export interface GalaxyFrame {
  key: string;                      // kind suffix, [a-z0-9]
  seed: number;                     // salt for per-particle hashes
  name: string;                     // which galaxy
  data: GalaxyData;
  obj: THREE.Object3D;              // the drawn galaxy group (its rotation matters)
  scaleLy: number;                  // light years per local unit
  centre: [number, number, number]; // galaxy centre, Sun-centred galactic ly
  starsPer: number;                 // real stars each particle stands for
  armNames: string[];
  feh: number;                      // mean metallicity offset of this galaxy, dex
  prefix: string;                   // catalogue prefix
  links: Map<number, number>;       // particle → sim star system
  /** pickable only when this returns true (e.g. galaxy large on screen) */
  enabled?: (p: Probe) => boolean;
}

const MW_ARMS = ['Perseus Arm', 'Norma Arm', 'Scutum–Centaurus Arm', 'Sagittarius–Carina Arm'];
const GAL_FACTS: Record<string, { feh: number; prefix: string; arms: string[] }> = {
  'Milky Way': { feh: 0, prefix: '2SN', arms: MW_ARMS },
  'Large Magellanic Cloud': { feh: -0.35, prefix: 'LMC', arms: ['bar'] },
  'Small Magellanic Cloud': { feh: -0.7, prefix: 'SMC', arms: ['wing'] },
  Andromeda: { feh: 0.05, prefix: 'M31', arms: ['north-east arm', 'south-west arm', 'ring arm', 'outer arm'] },
  Triangulum: { feh: -0.3, prefix: 'M33', arms: ['northern arm', 'southern arm'] },
};

/** Build a frame for a galaxy drawn by makeGalaxy, link the sim's star systems in it to their nearest particles, and register everything. */
export function explainGalaxy(world: World, f: Omit<GalaxyFrame, 'links' | 'armNames' | 'feh' | 'prefix'>): GalaxyFrame {
  const meta = GAL_FACTS[f.name] ?? { feh: 0, prefix: 'GX', arms: ['arm'] };
  const frame: GalaxyFrame = { ...f, links: new Map(), armNames: meta.arms, feh: meta.feh, prefix: meta.prefix };
  linkSystems(world, frame);
  const d = frame.data, k = frame.key;
  registerExplainer(`star${k}`, {
    obj: d.stars,
    explain: (i, c) => starCard(frame, i, c),
    name: (i, c) => starName(frame, i, c),
    locate: (i, out) => pointWorld(d.stars, i, out),
  });
  addGpuSet({ kind: `star${k}`, points: d.stars, prio: 1, minLum: 0.02, pickPx: 6, enabled: frame.enabled });
  registerExplainer(`dust${k}`, { obj: d.dust, explain: (i, c) => dustCard(frame, i, c), locate: (i, out) => pointWorld(d.dust, i, out) });
  addGpuSet({ kind: `dust${k}`, points: d.dust, prio: -3, minLum: 0, pickPx: 4, enabled: frame.enabled });
  registerExplainer(`neb${k}`, { obj: d.stars, explain: (i, c) => nebulaCard(frame, i, c), locate: (i, out) => d.nebulae[i].getWorldPosition(out) });
  addCpuSet({
    kind: `neb${k}`, obj: d.stars, prio: 2, enabled: frame.enabled,
    // a nebula is claimed at its heart: within a fifth of its drawn radius
    hit: (p) => nearestPoint(d.nebulae.length, (i, out) => d.nebulae[i].getWorldPosition(out), p, (i, _dp, cam) => Math.max(6, d.nebulae[i].scale.x * frame.obj.scale.x * 0.1 * pxPerUnit(p, cam))),
  });
  registerExplainer(`core${k}`, { obj: d.stars, explain: (_i, c) => coreCard(frame, c), locate: (_i, out) => d.core.getWorldPosition(out) });
  addCpuSet({
    kind: `core${k}`, obj: d.stars, prio: 4, enabled: frame.enabled,
    hit: (p) => {
      const at = d.core.getWorldPosition(new THREE.Vector3());
      const s = toScreen(at, p);
      if (!s) return null;
      const r = Math.max(8, d.R * 0.03 * pxPerUnit(p, p.camera.position.distanceTo(at)));
      const dd = Math.hypot(s.x - p.x, s.y - p.y);
      return dd <= r ? { i: 0, d: dd - r * 0.5 } : null;
    },
  });
  return frame;
}

// ---------------------------------------------------------------- geometry

const tv = new THREE.Vector3(), tq = new THREE.Quaternion();
/** Particle i in Sun-centred galactic light years, plus its galactocentric radius and height. */
function where(f: GalaxyFrame, i: number): { x: number; y: number; z: number; rGal: number; h: number } {
  const a = f.data.stars.geometry.attributes.position.array as Float32Array;
  const lx = a[i * 3], ly = a[i * 3 + 1], lz = a[i * 3 + 2];
  tv.set(lx, ly, lz).applyQuaternion(f.obj.quaternion).multiplyScalar(f.scaleLy);
  return { x: f.centre[0] + tv.x, y: f.centre[1] - tv.z, z: f.centre[2] + tv.y, rGal: Math.hypot(lx, lz) * f.scaleLy, h: ly * f.scaleLy };
}
function whereDust(f: GalaxyFrame, i: number) {
  const a = f.data.dust.geometry.attributes.position.array as Float32Array;
  const lx = a[i * 3], ly = a[i * 3 + 1], lz = a[i * 3 + 2];
  tv.set(lx, ly, lz).applyQuaternion(f.obj.quaternion).multiplyScalar(f.scaleLy);
  return { x: f.centre[0] + tv.x, y: f.centre[1] - tv.z, z: f.centre[2] + tv.y, rGal: Math.hypot(lx, lz) * f.scaleLy, h: ly * f.scaleLy };
}

/** Each sim star system in this galaxy becomes the particle nearest its catalogued position, recoloured to its real type. */
function linkSystems(world: World, f: GalaxyFrame): void {
  const sys = world.systems.filter((s) => s.galaxy === f.name && (s.region === 'galaxy' || s.region === 'extra'));
  if (!sys.length) return;
  const pos = f.data.stars.geometry.attributes.position.array as Float32Array;
  const col = f.data.stars.geometry.attributes.color.array as Float32Array;
  const n = pos.length / 3, R = f.data.R * 1.25, G = 160, cell = (2 * R) / G;
  const ci = (v: number) => Math.max(0, Math.min(G - 1, Math.floor((v + R) / cell)));
  const count = new Int32Array(G * G + 1);
  for (let i = 0; i < n; i++) count[ci(pos[i * 3]) * G + ci(pos[i * 3 + 2]) + 1]++;
  for (let k = 1; k <= G * G; k++) count[k] += count[k - 1];
  const fill = count.slice(0, G * G), idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[fill[ci(pos[i * 3]) * G + ci(pos[i * 3 + 2])]++] = i;
  const inv = tq.copy(f.obj.quaternion).invert();
  const taken = new Set<number>();
  for (const s of sys) {
    // galactic ly → scene axes → the galaxy's local frame
    tv.set(s.x - f.centre[0], s.z - f.centre[2], -(s.y - f.centre[1])).divideScalar(f.scaleLy).applyQuaternion(inv);
    const cx = ci(tv.x), cz = ci(tv.z);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring < G && best < 0; ring++) {
      for (let a = cx - ring; a <= cx + ring; a++) for (let b = cz - ring; b <= cz + ring; b++) {
        if (a < 0 || b < 0 || a >= G || b >= G || (Math.abs(a - cx) !== ring && Math.abs(b - cz) !== ring)) continue;
        for (let k = count[a * G + b]; k < count[a * G + b + 1]; k++) {
          const i = idx[k];
          if (taken.has(i) || f.data.meta[i] & META.HII) continue;
          const d = (pos[i * 3] - tv.x) ** 2 + (pos[i * 3 + 1] - tv.y) ** 2 + (pos[i * 3 + 2] - tv.z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best < 0) continue;
    taken.add(best);
    f.links.set(best, s.id);
    const m = f.data.bri[best] / 200 * f.data.bright;
    const c = specColor(s.spec).multiplyScalar(Math.max(0.6, m));
    col.set([c.r, c.g, c.b], best * 3);
    f.data.meta[best] = (f.data.meta[best] & 0xff) | (META.LINKED << 8);
  }
  f.data.stars.geometry.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- stars

// spectral range [from, to) each palette colour stands for
// (matched to specColor: in linear light CORE ffe2b0 is an early K, ffc488 a late K, ffb070 an M, ARM a8c4ff/d4e2ff/8fb0ff are B/A/O, fff2e0 and the halo's ffe8cc lie just warm of G)
const PAL_SPEC: [number, number][] = [[50, 55], [55, 62], [60, 66], [12, 20], [20, 30], [5, 12], [40, 48], [45, 52]];
// brightness range makeGalaxy draws for core, arm and halo particles
const BRI: Record<number, [number, number]> = { 0: [0.35, 0.8], 1: [0.35, 1.1], 2: [0.25, 0.55] };

interface Star { spec: number; lc: LumClass; teff: number; mass: number; lum: number; radius: number; age: number; feh: number; planets: number; giantPlanet: boolean; region: string }

function star(f: GalaxyFrame, i: number, rGal: number): Star {
  const m = f.data.meta[i], comp = metaComp(m), pal = metaPal(m);
  const H = (k: number) => h01(f.seed, i, k);
  const [lo, hi] = BRI[comp] ?? [0.35, 1.1];
  const q = Math.min(1, Math.max(0, (f.data.bri[i] / 200 - lo) / (hi - lo)));
  const [s0, s1] = PAL_SPEC[pal] ?? [40, 50];
  let spec = Math.floor(s0 + H(1) * (s1 - s0));
  const warm = pal <= 2 || pal === 7, blue = pal === 3 || pal === 5;
  let lc: LumClass = 'V';
  if (warm && q > 0.55 && H(2) < 0.8) lc = q > 0.93 && spec >= 50 && H(3) < 0.35 ? 'II' : 'III';
  else if (blue && q > 0.85) lc = q > 0.96 && H(3) < 0.4 ? 'Ia' : 'Ib';
  else if (pal === 6 && q > 0.8) lc = 'IV';
  if (m & META.HII) { spec = Math.min(spec, 15); }
  const kpc = rGal / 3262;
  // age by population: bulge and halo are old, the disc is every age
  const tAge = comp === 0 ? 8e9 + 4e9 * H(4) : comp === 2 ? 1.05e10 + 2.5e9 * H(4) : (m & META.INNER ? 3e9 + 7e9 * H(4) : 2e8 + 9.8e9 * Math.pow(H(4), 0.8));
  const g = hGauss(f.seed, i, 5);
  let feh = comp === 0 ? 0.0 + 0.3 * g : comp === 2 ? -1.5 + 0.4 * g : -0.06 * (kpc - 8.2) + 0.12 * g - 0.025 * (tAge / 1e9 - 4.6);
  feh += f.feh;
  let mass: number, lum: number, teff: number, age: number;
  const ms = mainSequence(spec);
  if (lc === 'III' || lc === 'II') {
    spec = Math.max(spec, 44);
    age = Math.min(1.3e10, tAge);
    mass = Math.max(0.85, Math.pow(age / 1e10, -0.4)) * (lc === 'II' ? 2.5 : 1);
    lum = Math.pow(10, lc === 'II' ? 3 + 0.6 * H(6) : 1.5 + 1.4 * q * H(6) + 0.3);
    teff = spec < 50 ? 5100 - (spec - 44) * 60 : spec < 60 ? 4750 - (spec - 50) * 85 : 3800 - (spec - 60) * 110;
  } else if (lc === 'Ib' || lc === 'Ia') {
    lum = Math.pow(10, (lc === 'Ia' ? 5 : 4.3) + 0.6 * H(6));
    mass = 12 + 25 * H(7) * (lc === 'Ia' ? 1.3 : 1);
    teff = ms.teff * 0.92;
    age = lifetime(mass, lum) * (0.9 + 0.1 * H(8));
  } else {
    mass = ms.mass * (1 + 0.04 * hGauss(f.seed, i, 9));
    lum = ms.lum * Math.pow(10, 0.2 * (q - 0.5)) * (lc === 'IV' ? 2.8 : 1);
    teff = ms.teff;
    const life = lifetime(mass, ms.lum);
    age = Math.min(tAge, life * 0.97);
    if (m & META.HII) age = 1e6 + 4e6 * H(8);
    else if (spec < 20) age = Math.min(life * 0.95, H(8) * life);
  }
  if (comp === 2) feh = Math.min(feh, -0.6);
  const radius = Math.sqrt(lum) / Math.pow(teff / 5772, 2);
  // planets: hot and giant stars keep few; metal-rich Sun-like stars more, and giant planets go as 10^(2[Fe/H]) (Fischer & Valenti 2005)
  const base = spec < 20 ? 0.3 : spec < 30 ? 1.2 : spec < 60 ? 2.6 : 3.1;
  const mean = base * Math.min(1.6, Math.max(0.15, 1 + 0.6 * feh)) * (lc === 'V' || lc === 'IV' ? 1 : 0.45);
  const planets = hPoisson(mean, f.seed, i, 10);
  const giantPlanet = planets > 0 && H(11) < Math.min(0.6, 0.06 * Math.pow(10, 2 * feh) * Math.min(2, mass));
  const region = comp === 0 ? (f.data.R > 0 && f.name === 'Milky Way' ? 'the bulge and bar' : 'the central bulge') : comp === 2 ? 'the stellar halo' : m & META.INNER ? 'the inner disc' : m & META.STRAY ? `the gap beside the ${f.armNames[metaArm(m) % f.armNames.length]}` : `the ${f.armNames[metaArm(m) % f.armNames.length]}`;
  return { spec, lc, teff, mass, lum, radius, age, feh, planets, giantPlanet, region };
}

const typeStr = (s: Star) => `${specName(s.spec)} ${s.lc}`;

function starName(f: GalaxyFrame, i: number, c: ExCtx): string {
  const sys = f.links.get(i);
  if (sys !== undefined) return `${c.world.systems[sys].name} · ${statusText(c.world, c.snap, sys).split(';')[0]}`;
  const w = where(f, i);
  if (f.data.meta[i] & META.HII) return `${nebName(f, i)} · star-forming nebula`;
  const s = star(f, i, w.rGal);
  return `${desig(f, w)} · ${typeStr(s)} ${s.lc === 'V' ? colourWord(s.spec, s.lc) + ' star' : LUM_WORD[s.lc]}`;
}

function desig(f: GalaxyFrame, w: { x: number; y: number; z: number }): string {
  const e = galToEq(w.x, w.y, w.z);
  return `${f.prefix} ${jName(e.ra, e.dec)}`;
}

function placeFacts(f: GalaxyFrame, w: { x: number; y: number; z: number; rGal: number; h: number }, c: ExCtx, region: string): Fact[] {
  const lb = galLB(w.x, w.y, w.z);
  const out: Fact[] = [{ k: 'Where', v: region, t: 'P' }];
  if (f.name === 'Milky Way') {
    out.push({ k: 'From the Sun', v: fmtLy(lb.d), t: 'P' });
    out.push({ k: 'From the galactic centre', v: fmtLy(w.rGal), t: 'P' });
    out.push({ k: 'Above the plane', v: Math.abs(w.h) < 1 ? 'in the plane' : `${w.h >= 0 ? '' : '−'}${fmtLy(Math.abs(w.h))}`, t: 'P' });
    out.push({ k: 'Galactic l, b', v: `${lb.l.toFixed(2)}°, ${lb.b >= 0 ? '+' : '−'}${Math.abs(lb.b).toFixed(2)}°`, t: 'P' });
  } else {
    out.push({ k: 'From the Sun', v: fmtLy(lb.d), t: 'E' });
    out.push({ k: `From ${f.name}'s centre`, v: fmtLy(w.rGal), t: 'P' });
  }
  out.push({ k: 'Light we see left it', v: calYear(2040 + c.year - lb.d), t: 'E' });
  return out;
}

function starCard(f: GalaxyFrame, i: number, c: ExCtx): Explanation {
  const w = where(f, i);
  if (f.data.meta[i] & META.HII) return hiiCard(f, i, c, w);
  const sysId = f.links.get(i);
  if (sysId !== undefined) return linkedCard(f, i, c, sysId, w);
  const s = star(f, i, w.rGal);
  const giant = s.lc !== 'V' && s.lc !== 'IV';
  const [hz0, hz1] = habZone(s.lum);
  const kind = s.lc === 'V' ? `${colourWord(s.spec, s.lc)} ${s.spec >= 50 ? 'dwarf' : 'main-sequence star'}` : `${colourWord(s.spec, s.lc)} ${LUM_WORD[s.lc]}`;
  const comp = metaComp(f.data.meta[i]);
  const facts: Fact[] = [
    { k: 'Type', v: typeStr(s), t: 'P' },
    { k: 'Colour as drawn', v: colourWord(s.spec, s.lc), t: 'P' },
    { k: 'Surface temperature', v: `${num(Math.round(s.teff / 10) * 10)} K`, t: 'E' },
    { k: 'Mass', v: `${s.mass.toPrecision(2)} M☉`, t: 'E' },
    { k: 'Luminosity', v: `${sig(s.lum)} L☉`, t: 'E' },
    { k: 'Radius', v: `${sig(s.radius)} R☉`, t: 'E' },
    { k: 'Age', v: fmtYears(s.age), t: 'P' },
    { k: 'Metallicity [Fe/H]', v: `${s.feh >= 0 ? '+' : '−'}${Math.abs(s.feh).toFixed(2)}`, t: 'P' },
    { k: 'Planets', v: s.planets ? `${s.planets}${s.giantPlanet ? ', one a gas giant' : ''}` : 'none', t: 'P' },
  ];
  if (!giant && s.spec >= 20) facts.push({ k: 'Habitable zone', v: `${hz0.toPrecision(2)}–${hz1.toPrecision(2)} AU`, t: 'E' });
  facts.push(...placeFacts(f, w, c, s.region));
  facts.push({ k: 'This dot stands for', v: `≈${sig(f.starsPer)} stars`, t: 'E' });
  facts.push(humansFact(c, w.x, w.y, w.z, f.name === 'Milky Way' ? 'not reached' : 'no human has crossed to this galaxy\'s stars yet'));
  let why: string;
  if (comp === 2) why = 'A survivor of the galaxy\'s first generations, poor in the heavy elements rocky planets are made of. Settlers pass it by; historians of the cosmos do not.';
  else if (giant) why = `A dying star, swollen to ${sig(s.radius)} times the Sun's width. Its inner worlds are cooked or swallowed, so any people here would live on outer moons for the star's last hundred million years.`;
  else if (s.spec < 20) why = 'Hot, short-lived and fierce in ultraviolet. It will explode within a few million years, so no one settles here; its light marks the arm for navigators instead.';
  else if (s.spec < 30) why = 'Bright and fast-burning. Planets here are scoured by ultraviolet and the star changes within a billion years, so settlers in this future favour cooler suns.';
  else if (s.spec < 50) why = 'A Sun-like star: the kind settlers in this future rank highest, with a long, steady life and a wide habitable zone.';
  else if (s.spec < 60) why = 'Orange dwarfs are the settlers\' favourite: steady for tens of billions of years and calmer than the red dwarfs.';
  else why = 'Red dwarfs are three stars in four. Their flares strip atmospheres, but there are so many that most settled systems in this future circle one.';
  if (comp === 0 && !giant) why = 'A star in the crowded bulge, where neighbours can be light-weeks apart and the radiation is harsh. ' + why;
  return {
    eyebrow: `Star in ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`,
    title: desig(f, w),
    lede: `${an(typeStr(s)).replace(/^a/, 'A')} ${kind} in ${s.region}, ${fmtLy(galLB(w.x, w.y, w.z).d)} from the Sun.`,
    facts, why,
  };
}

function linkedCard(f: GalaxyFrame, i: number, c: ExCtx, sysId: number, w: ReturnType<typeof where>): Explanation {
  const sys = c.world.systems[sysId];
  const st = sysStatus(c.world, c.snap, sysId);
  const ms = mainSequence(specNum(sys.spec));
  const worlds = sys.bodies.map((b) => c.world.bodies[b]);
  const region = (() => { const m = f.data.meta[i]; return metaComp(m) === 0 ? 'the bulge' : metaComp(m) === 2 ? 'the halo' : `the ${f.armNames[metaArm(m) % f.armNames.length]}`; })();
  const facts: Fact[] = [
    { k: 'Type', v: `${sys.spec} V`, t: 'P' },
    { k: 'Surface temperature', v: `${num(Math.round(ms.teff / 10) * 10)} K`, t: 'E' },
    { k: 'Mass', v: `${ms.mass.toPrecision(2)} M☉`, t: 'E' },
    { k: 'Luminosity', v: `${sig(sys.lum)} L☉`, t: 'P' },
    { k: 'Worlds in the catalogue', v: worlds.map((b) => `${b.name} (${b.kind})`).join(', '), t: 'P' },
    { k: 'Humans', v: statusText(c.world, c.snap, sysId), t: 'P' },
    ...placeFacts(f, w, c, region),
  ];
  return {
    eyebrow: `Star system in ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`,
    title: sys.name,
    lede: `This dot is ${sys.name}, one of the ${f.name === 'Milky Way' ? 'far' : 'other-galaxy'} star systems the simulation tracks. It is drawn in its own colour, ${an(sys.spec)} star.`,
    facts,
    why: st.n ? `People live here, ${fmtLy(sys.dist)} from Earth: news from home is ${num(sys.dist)} years old when it arrives, so they govern themselves.` : f.name === 'Milky Way' ? 'Out of reach without faster-than-light travel. If a future gets a warp or wormhole drive, worlds like this are where its ships go.' : 'Only a traversable wormhole could bring people here, and most futures never build one.',
    links: [{ label: `Open ${sys.name}`, act: 'system', id: sysId }, { label: 'Enter the system', act: 'dive-system', id: sysId }],
  };
}

// ---------------------------------------------------------------- star-forming knots, dust, nebulae, core

const NEB_WORDS = ['Heron', 'Lantern', 'Ember', 'Veil', 'Orchid', 'Kestrel', 'Harp', 'Thistle', 'Cinder', 'Moth', 'Anvil', 'Coral', 'Fox', 'Lyre', 'Torch', 'Willow', 'Comet', 'Bell', 'Owl', 'Rose', 'Crown', 'Saddle', 'Wren', 'Iris'];
function nebName(f: GalaxyFrame, i: number): string {
  const u = h01(f.seed, i, 40);
  return u < 0.6 ? `${NEB_WORDS[Math.floor(h01(f.seed, i, 41) * NEB_WORDS.length)]} Nebula` : `${coin(h01(f.seed, i, 42), h01(f.seed, i, 43), h01(f.seed, i, 44))} Nebula`;
}

function hiiCard(f: GalaxyFrame, i: number, c: ExCtx, w: ReturnType<typeof where>): Explanation {
  const H = (k: number) => h01(f.seed, i, k);
  const size = 30 + 370 * Math.pow(H(50), 1.6);              // ly across
  const oStars = Math.max(1, Math.round((size / 40) * (0.5 + H(51))));
  const mass = 400 * Math.pow(size / 3.26 / 2, 2) * (0.5 + H(52)); // Larson-like surface density
  const lb = galLB(w.x, w.y, w.z);
  const m = f.data.meta[i];
  const region = `the ${f.armNames[metaArm(m) % f.armNames.length]}`;
  return {
    eyebrow: `Star-forming nebula in ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`,
    title: `${nebName(f, i)}`,
    lede: `A cloud of hydrogen lit pink by the hot young stars born inside it. The pink is hydrogen-alpha light, 656 nanometres, given off as electrons fall back onto protons.`,
    facts: [
      { k: 'Designation', v: gName(lb.l, lb.b, 2), t: 'P' },
      { k: 'Size', v: `${num(size)} ly across`, t: 'P' },
      { k: 'Ionising O stars', v: String(oStars), t: 'P' },
      { k: 'Gas mass', v: `${sig(mass)} M☉`, t: 'E' },
      { k: 'Gas temperature', v: '≈10,000 K', t: 'R' },
      { k: 'Age of its stars', v: `${(1 + 4 * H(53)).toFixed(1)} million years`, t: 'P' },
      ...placeFacts(f, w, c, region),
      humansFact(c, w.x, w.y, w.z),
    ],
    why: 'Nurseries like this make the young, metal-rich systems settlers want, but for the next few million years everything inside is bathed in ultraviolet and supernova shocks.',
  };
}

function dustCard(f: GalaxyFrame, i: number, c: ExCtx): Explanation {
  const w = whereDust(f, i);
  const H = (k: number) => h01(f.seed + 7, i, k);
  const sz = (f.data.dust.geometry.attributes.size.array as Float32Array)[i];
  // drawn size in px is size × 300 / depth; on a ~900 px tall view that is a cloud size × 0.35 local units across
  const size = sz * 0.347 * f.scaleLy;
  const mass = 380 * Math.pow(size / 3.26 / 2, 2);
  const lb = galLB(w.x, w.y, w.z);
  const arm = Math.floor(H(1) * f.armNames.length);
  return {
    eyebrow: `Dark cloud in ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`,
    title: `DC ${gName(lb.l, lb.b, 1).slice(1)}`,
    lede: `A cold cloud of gas and soot along the inner edge of the ${f.armNames[arm]}, dark because it swallows the light of the stars behind it.`,
    facts: [
      { k: 'Size', v: `${num(Math.round(size / 10) * 10)} ly across`, t: 'P' },
      { k: 'Mass', v: `${sig(mass)} M☉`, t: 'E' },
      { k: 'Temperature', v: `${Math.round(10 + 10 * H(2))} K`, t: 'E' },
      { k: 'Made of', v: 'molecular hydrogen, helium, 1% dust (silicate and carbon grains)', t: 'R' },
      { k: 'Dimming of stars behind', v: `${(2 + 20 * H(3) ** 2).toFixed(1)} magnitudes`, t: 'P' },
      ...placeFacts(f, w, c, `dust lane of the ${f.armNames[arm]}`),
      humansFact(c, w.x, w.y, w.z),
    ],
    why: 'Clouds like this are the raw stuff of future stars and planets. They also hide what lies behind them, so astronomers in this future still map the far side of the galaxy in infrared and radio.',
  };
}

const NEB_KIND = [
  { word: 'Complex', eyebrow: 'Star-forming complex', lede: 'A giant complex of gas clouds where clusters of stars are being born, glowing pink with ionised hydrogen.', why: 'Every young cluster settlers might one day reach starts in a place like this; its supernovae also seed the metals rocky planets need.', made: 'hydrogen, helium, dust; dozens of young clusters' },
  { word: 'Association', eyebrow: 'OB association', lede: 'A loose group of hot blue stars and the dust they light. The blue is starlight scattered by dust grains, the same reason Earth\'s sky is blue.', why: 'Its stars will all explode within about ten million years, so the region is a hazard for anyone living within a few hundred light years.', made: 'dozens of O and B stars, reflection dust' },
  { word: 'Superbubble', eyebrow: 'Superbubble', lede: 'A cavity of million-degree gas blown by many supernovae, its rim glowing where it ploughs into the cold gas around it.', why: 'The Sun itself sits in one, the Local Bubble. Inside, gas is thin and hot; at the rim, new stars form where the shock compresses clouds.', made: 'hot ionised gas, X-ray bright' },
];
function nebulaCard(f: GalaxyFrame, i: number, c: ExCtx): Explanation {
  const sp = f.data.nebulae[i];
  const k = f.data.nebKind[i];
  const K = NEB_KIND[k];
  const p = sp.position; // local
  tv.set(p.x, p.y, p.z).applyQuaternion(f.obj.quaternion).multiplyScalar(f.scaleLy);
  const x = f.centre[0] + tv.x, y = f.centre[1] - tv.z, z = f.centre[2] + tv.y;
  const size = sp.scale.x * 0.55 * f.scaleLy;
  const lb = galLB(x, y, z);
  const name = `${coin(h01(f.seed, i, 60), h01(f.seed, i, 61), h01(f.seed, i, 62))} ${K.word}`;
  return {
    eyebrow: `${K.eyebrow} in ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`,
    title: name,
    lede: K.lede,
    facts: [
      { k: 'Designation', v: gName(lb.l, lb.b, 1), t: 'P' },
      { k: 'Size', v: `${num(Math.round(size / 100) * 100)} ly across`, t: 'P' },
      { k: 'Made of', v: K.made, t: 'R' },
      ...placeFacts(f, { x, y, z, rGal: Math.hypot(p.x, p.z) * f.scaleLy, h: p.y * f.scaleLy }, c, 'a spiral arm'),
      humansFact(c, x, y, z),
    ],
    why: K.why,
  };
}

const CORES: Record<string, { title: string; facts: Fact[]; lede: string; why: string }> = {
  'Milky Way': {
    title: 'Sagittarius A*', lede: 'The black hole at the centre of the Milky Way, inside the glow of the bulge\'s old stars.',
    facts: [
      { k: 'Mass', v: '4.3 million M☉', t: 'R' }, { k: 'From the Sun', v: '26,700 ly', t: 'R' },
      { k: 'Event horizon', v: '25 million km across', t: 'R' }, { k: 'First imaged', v: '2022, Event Horizon Telescope', t: 'R' },
      { k: 'Stars within 3 ly', v: '≈10 million', t: 'E' },
    ],
    why: 'The galaxy turns around it once every 230 million years. No human ship in this future goes near: the bulge is crowded, and the radiation is lethal.',
  },
  Andromeda: {
    title: 'M31*', lede: 'The black hole in Andromeda\'s double nucleus.',
    facts: [{ k: 'Mass', v: '≈140 million M☉', t: 'R' }, { k: 'From the Sun', v: '2.5 million ly', t: 'R' }, { k: 'Nucleus', v: 'double: an eccentric disc of old stars', t: 'R' }],
    why: 'Andromeda and the Milky Way will merge in about 4.5 billion years; the two black holes will then spiral into one.',
  },
};
function coreCard(f: GalaxyFrame, c: ExCtx): Explanation {
  const g = GALAXIES.find((x) => x.name === f.name)!;
  const k = CORES[f.name];
  void c;
  if (k) return { eyebrow: `Core of ${f.name === 'Milky Way' ? 'the Milky Way' : f.name}`, title: k.title, lede: k.lede, facts: k.facts, why: k.why };
  return {
    eyebrow: `Core of ${f.name}`, title: `Nucleus of ${f.name}`,
    lede: `The dense centre of ${f.name}, glowing with old stars.`,
    facts: [{ k: 'Central black hole', v: f.name === 'Triangulum' ? 'none found; under 1,500 M☉ if any' : 'none known', t: 'R' }, { k: 'From the Sun', v: fmtLy(g.dist), t: 'R' }],
    why: 'Small galaxies often lack a giant central black hole; their centres are just where the stars crowd most.',
  };
}
