// Inside a star system and around a planet: asteroids, Dyson collectors,
// orbits, rings, habitats, satellites, space elevators and orbital rings.
// Everything is derived from the drawn geometry plus the sim's numbers for the
// body and settlement it belongs to, so the card matches what is on screen and
// changes when the settlement does.

import * as THREE from 'three';
import { STAGE, STAGE_NAMES, TECHS } from '../sim/catalog.ts';
import type { Body, World } from '../sim/world.ts';
import { fmtNum } from '../ui/format.ts';
import { an, AU_M, G_SI, L_SUN_W, fmtKm, fmtW, mainSequence, sig, specNum } from './astro.ts';
import { addCpuSet, addGpuSet, nearestPoint, segDist, type Probe } from './picker.ts';
import { h01, pick, pointWorld, registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';
import { fieldAt, isAlive, popAt, stageAt } from './simInfo.ts';

const yr = (y: number) => String(Math.round(2040 + y));
const starMass = (w: World, sys: number) => mainSequence(specNum(w.systems[sys].spec)).mass;
const bodyMassKg = (b: Body) => (b.g * 9.81 * (b.radius * 1000) ** 2) / G_SI;

// ---------------------------------------------------------------- asteroid belts

export interface BeltInfo {
  sys: number;
  label: string;          // "main belt", "Kuiper belt", "Vesta's belt"
  members: number[];      // bodies that belong to it (their settlements mine it)
  centreR: number;        // drawn radius of the belt
  width: number;          // drawn width
  au: [number, number];   // real inner/outer edge, AU
  icy: boolean;
  count: number;          // real bodies over 1 km (or 100 km for Kuiper) it stands for
}

const CLASS = {
  C: { name: 'C-type, carbonaceous', made: 'clay and hydrated silicates, carbon, 10–20% water', rho: 1.4, metal: 0.05, water: 0.15 },
  S: { name: 'S-type, stony', made: 'olivine and pyroxene rock, 10–20% iron-nickel', rho: 2.7, metal: 0.15, water: 0.01 },
  M: { name: 'M-type, metallic', made: 'iron-nickel, with platinum-group metals', rho: 5.3, metal: 0.85, water: 0 },
  K: { name: 'icy Kuiper object', made: 'water ice, frozen methane, nitrogen and carbon monoxide over rock', rho: 1.0, metal: 0.03, water: 0.5 },
} as const;
const HALF = 'ABCDEFGHJKLMNOPQRSTUVWXY', ORD = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

export function explainBelt(kind: string, pts: THREE.Points, b: BeltInfo, world: World): void {
  registerExplainer(kind, {
    obj: pts,
    explain: (i, c) => asteroidCard(pts, b, i, c),
    name: (i, c) => { const a = asteroid(pts, b, i, world); return `${a.name} · ${a.D < 1 ? `${Math.round(a.D * 1000)} m` : `${a.D.toFixed(a.D < 10 ? 1 : 0)} km`} ${a.cls === 'K' ? 'icy body' : `${a.cls}-type asteroid`}${mining(b, i, c).on ? ', mined' : ''}`; },
    locate: (i, out) => pointWorld(pts, i, out),
  });
  addGpuSet({ kind, points: pts, prio: 1, minLum: 0.05, pickPx: 6 });
}

function asteroid(pts: THREE.Points, b: BeltInfo, i: number, world: World) {
  const a = pts.geometry.attributes.position.array as Float32Array;
  const size = (pts.geometry.attributes.size.array as Float32Array)[i];
  const rr = Math.hypot(a[i * 3], a[i * 3 + 2]);
  const H = (k: number) => h01(b.sys, b.members[0] ?? 0, i, k);
  // radial place in the drawn belt → real semi-major axis
  const u = Math.min(1, Math.max(0, 0.5 + (rr - b.centreR) / (b.width * 1.6)));
  const au = b.au[0] + u * (b.au[1] - b.au[0]);
  // a bigger dot is a bigger rock: drawn size quantile through a D^-2.5 size distribution
  const q = Math.min(0.99999, Math.max(0, (size - 0.25) / 0.4));
  const D = (b.icy ? 30 : 1) * Math.pow(1 - q, -0.4) * (0.8 + 0.4 * H(1));
  // composition from what the parent bodies are rich in
  let cls: keyof typeof CLASS = 'K';
  if (!b.icy) {
    const res = [0, 0, 0, 0, 0];
    for (const m of b.members) world.bodies[m].res.forEach((v, k) => { res[k] += v / b.members.length; });
    const wC = res[0] + 0.5 * res[2] + 0.2, wS = res[3] + 0.4, wM = res[1] * res[1] * 0.6;
    const x = H(2) * (wC + wS + wM);
    cls = x < wC ? 'C' : x < wC + wS ? 'S' : 'M';
  }
  const sol = b.sys === 0;
  const discYear = sol ? (D > 4 ? 1990 + Math.floor(H(3) * 50) : 2040 + Math.floor(H(3) * 160)) : 0;
  const name = sol
    ? `${D > 4 ? `(${(780000 + i * 37 + Math.floor(H(4) * 37)).toLocaleString('en-US')}) ` : ''}${discYear} ${HALF[Math.floor(H(5) * HALF.length)]}${ORD[Math.floor(H(6) * ORD.length)]}${1 + Math.floor(H(7) * 140)}`
    : `${world.systems[b.sys].name.split(' ').slice(0, 2).join(' ')} ${b.icy ? 'K' : 'A'}-${(i + 1).toString().padStart(4, '0')}`;
  return { name, D, cls, au, discYear };
}

function mining(b: BeltInfo, i: number, c: ExCtx): { on: boolean; by: number } {
  let best = -1, bestPop = -1, stage = -1;
  for (const m of b.members) {
    const st = stageAt(c.snap, m);
    if (!isAlive(st)) continue;
    const p = popAt(c.snap, m);
    if (p > bestPop) { bestPop = p; best = m; stage = st; }
  }
  if (best < 0) return { on: false, by: -1 };
  // the share of the belt being worked grows with the settlement; a rock once claimed stays claimed as it grows
  const share = Math.min(0.85, 0.02 * stage * stage * Math.max(0.3, Math.log10(1 + bestPop) / 6));
  return { on: h01(b.sys, i, 99) < share, by: best };
}

function asteroidCard(pts: THREE.Points, b: BeltInfo, i: number, c: ExCtx): Explanation {
  const w = c.world;
  const a = asteroid(pts, b, i, w);
  const K = CLASS[a.cls];
  const H = (k: number) => h01(b.sys, i, k, 5);
  const vol = (4 / 3) * Math.PI * Math.pow((a.D * 1000) / 2, 3);
  const mass = vol * K.rho * 1000 * (a.cls === 'K' ? 1 : 0.85 + 0.3 * H(1)); // rubble piles are porous
  const mstar = starMass(w, b.sys);
  const mine = mining(b, i, c);
  const facts: Fact[] = [
    { k: 'Diameter', v: a.D < 1 ? `${Math.round(a.D * 1000)} m` : `${a.D.toFixed(a.D < 10 ? 1 : 0)} km`, t: 'P' },
    { k: 'Class', v: K.name, t: 'P' },
    { k: 'Made of', v: K.made, t: 'R' },
    { k: 'Mass', v: `${sig(mass)} kg`, t: 'E' },
    { k: 'Metal content', v: `${sig(mass * K.metal / 1000)} t`, t: 'E' },
    { k: 'Water content', v: K.water ? `${sig(mass * K.water / 1000)} t` : 'none', t: 'E' },
    { k: 'Orbit', v: `${a.au.toFixed(2)} AU, ${(Math.pow(a.au, 1.5) / Math.sqrt(mstar)).toFixed(a.au > 20 ? 0 : 2)} years round`, t: 'P' },
    { k: 'Spins once in', v: `${(a.D > 0.2 ? 2.3 + 18 * H(2) : 0.1 + 2 * H(2)).toFixed(1)} hours`, t: 'P' },
  ];
  if (a.discYear) facts.push({ k: 'Found', v: a.discYear < 2040 ? `${a.discYear}, by survey telescopes` : `${a.discYear}, by prospecting probes`, t: 'P' });
  facts.push({ k: 'Belt', v: `${b.label}, ${b.au[0]}–${b.au[1]} AU`, t: b.sys === 0 ? 'R' : 'P' });
  facts.push({ k: 'Status', v: mine.on ? `being mined by ${w.bodies[mine.by].name} (${STAGE_NAMES[stageAt(c.snap, mine.by)].toLowerCase()})` : mine.by >= 0 ? `unclaimed; ${w.bodies[mine.by].name} works other rocks here` : 'untouched', t: 'P' });
  facts.push({ k: 'This dot stands for', v: `≈${sig(b.count / Math.max(1, pts.geometry.attributes.position.count))} bodies like it`, t: 'E' });
  const why = a.cls === 'M' ? 'A metal asteroid holds more iron, nickel and platinum than all the mines of pre-space Earth; this is what a belt economy is built on.' : a.cls === 'C' ? 'Water and carbon: the cheapest source of drinking water, air and rocket fuel outside a gravity well.' : a.cls === 'K' ? 'Ice and volatiles at the edge of the system: fuel and air for ships leaving it, a long way from the Sun\'s warmth.' : 'Ordinary stone with some metal: building material for habitats and shielding, already in orbit.';
  return {
    eyebrow: `Asteroid in the ${b.label}`,
    title: a.name,
    lede: `${an(`${a.D < 1 ? 'small' : a.D > 20 ? 'large' : ''} ${K.name.split(',')[0]}`.trim()).replace(/^a/, 'A')} ${a.cls === 'K' ? '' : 'asteroid '}${a.au.toFixed(1)} AU from ${w.systems[b.sys].name === 'Sol' ? 'the Sun' : w.systems[b.sys].name}.`.replace(/\s+/g, ' '),
    facts, why,
    links: mine.by >= 0 ? [{ label: w.bodies[mine.by].name, act: 'body', id: mine.by }] : undefined,
  };
}

// ---------------------------------------------------------------- Dyson swarm

export function explainSwarm(kind: string, pts: THREE.Points, sys: number, world: World): void {
  registerExplainer(kind, {
    obj: pts,
    explain: (i, c) => collectorCard(pts, sys, i, c),
    name: (i) => `Collector ${String.fromCharCode(65 + (i % 26))}-${(i + 1).toString().padStart(4, '0')} · Dyson swarm of ${world.systems[sys].name}`,
    locate: (i, out) => pointWorld(pts, i, out),
  });
  addGpuSet({ kind, points: pts, prio: 1, minLum: 0.05, pickPx: 5 });
}

function collectorCard(pts: THREE.Points, sys: number, i: number, c: ExCtx): Explanation {
  const w = c.world, s = w.systems[sys];
  const a = pts.geometry.attributes.position.array as Float32Array;
  const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
  const R = Math.hypot(x, y, z);
  const incl = Math.abs(Math.asin(y / R)) * 180 / Math.PI;
  // the drawn shell 4.2–5.6 maps to 0.3–0.7 of the distance where Earth-like sunlight falls
  const au = (0.3 + 0.4 * (R - 4.2) / 1.4) * Math.sqrt(s.lum);
  const mstar = mainSequence(specNum(s.spec)).mass;
  let energy = 0, ops: number[] = [];
  for (const b of s.bodies) if (isAlive(stageAt(c.snap, b))) { energy += fieldAt(c.snap, b, 'energy'); if (stageAt(c.snap, b) === STAGE.MEGA) ops.push(b); }
  ops = ops.sort((p, q) => popAt(c.snap, q) - popAt(c.snap, p));
  const star = s.lum * L_SUN_W;
  const total = Math.min(star, Math.max(energy, star * 1e-6));
  const per = total / pts.geometry.attributes.position.count;
  // one collector: a square kilometre of thin-film at that distance, 30% efficient
  const flux = 1361 * s.lum / (au * au);
  const unit = flux * 1e6 * 0.3;
  const temp = 278 * Math.pow(s.lum, 0.25) / Math.sqrt(au);
  const name = `Collector ${String.fromCharCode(65 + (i % 26))}-${(i + 1).toString().padStart(4, '0')}`;
  return {
    eyebrow: `Dyson swarm of ${s.name}`,
    title: name,
    lede: `One of the mirrors and solar collectors orbiting ${s.name}, beaming the power they catch to the worlds that built them.`,
    facts: [
      { k: 'Power this dot catches', v: fmtW(per), t: 'P' },
      { k: 'Whole swarm', v: `${fmtW(total)}, ${(100 * total / star).toPrecision(2)}% of the star`, t: 'P' },
      { k: 'Collectors this dot stands for', v: `≈${sig(per / unit)}, each a square kilometre`, t: 'E' },
      { k: 'Orbit', v: `${au.toFixed(2)} AU, ${(365.25 * Math.pow(au, 1.5) / Math.sqrt(mstar)).toFixed(0)} days round, tilted ${incl.toFixed(0)}°`, t: 'P' },
      { k: 'Sunlight there', v: `${sig(flux / 1361)}× Earth's`, t: 'E' },
      { k: 'Running temperature', v: `${Math.round(temp)} K`, t: 'E' },
      { k: 'Operated by', v: ops.length ? ops.slice(0, 4).map((b) => w.bodies[b].name).join(', ') + (ops.length > 4 ? ` and ${ops.length - 4} more worlds` : '') : 'nobody: abandoned', t: 'P' },
    ],
    why: 'A Kardashev Type II step: power on this scale runs whole planets of computers, sails between stars and the terraforming of worlds.',
    links: ops.slice(0, 3).map((b) => ({ label: w.bodies[b].name, act: 'body' as const, id: b })),
  };
}

// ---------------------------------------------------------------- orbits and rings

export interface OrbitInfo { body: number; r: number }
/** Orbit lines in the system view: the cursor's distance from each drawn circle, where the ray meets the plane. */
export function explainOrbits(kind: string, obj: THREE.Object3D, orbits: () => OrbitInfo[], sys: () => number): void {
  registerExplainer(kind, {
    obj,
    explain: (b, c) => orbitCard(b, sys(), c),
    name: (b, c) => `Orbit of ${c.world.bodies[b].name}`,
    locate: (b, out) => { const o = orbits().find((x) => x.body === b); return o ? out.set(o.r, 0, 0) : null; },
  });
  const P = new THREE.Vector3(), Q = new THREE.Vector3();
  addCpuSet({
    kind, obj, prio: -4,
    hit: (p) => {
      const r = p.ray, t = Math.abs(r.direction.y) > 1e-6 ? -r.origin.y / r.direction.y : -1;
      if (t <= 0) return null;
      P.copy(r.direction).multiplyScalar(t).add(r.origin);
      const rho = Math.hypot(P.x, P.z);
      let best: { i: number; d: number } | null = null;
      for (const o of orbits()) {
        Q.copy(P).multiplyScalar(o.r / Math.max(rho, 1e-9));
        const d = segDist(P, Q, p);
        if (d < 6 && (!best || d < best.d)) best = { i: o.body, d };
      }
      return best;
    },
  });
}

function orbitCard(id: number, sys: number, c: ExCtx): Explanation {
  const w = c.world, b = w.bodies[id], s = w.systems[sys];
  const ms = starMass(w, sys);
  const v = 29.78 * Math.sqrt(ms / Math.max(b.a, 1e-3));
  return {
    eyebrow: `Orbit in ${s.name}`,
    title: `Orbit of ${b.name}`,
    lede: `The path ${b.name} follows around ${s.name === 'Sol' ? 'the Sun' : s.name}. Drawn on a squeezed scale so every world fits on screen; the numbers are true.`,
    facts: [
      { k: 'Distance from the star', v: `${b.a.toPrecision(3)} AU, ${fmtKm(b.a * AU_M / 1000)}`, t: s.real ? 'R' : 'P' },
      { k: 'One orbit takes', v: b.period >= 1 ? `${b.period.toPrecision(3)} years` : `${Math.round(b.period * 365.25)} days`, t: s.real ? 'R' : 'P' },
      { k: 'Orbital speed', v: `${v.toFixed(1)} km/s`, t: 'E' },
      { k: 'Starlight there', v: `${sig(b.flux)}× Earth's`, t: 'E' },
      { k: 'Light from the star takes', v: `${(b.a * 8.317).toFixed(b.a < 10 ? 1 : 0)} minutes`, t: 'E' },
    ],
    why: 'Distance from the star sets how much sunlight a settlement can farm and how much power a solar array gives: halving the distance quadruples both.',
    links: [{ label: b.name, act: 'body', id }],
  };
}

const SATURN_RINGS: Fact[] = [
  { k: 'Span', v: '7,000–80,000 km above the cloud tops', t: 'R' }, { k: 'Thickness', v: '10 m to 1 km', t: 'R' },
  { k: 'Mass', v: '1.5×10¹⁹ kg', t: 'R' }, { k: 'Made of', v: '99% water ice, grains to house-sized chunks', t: 'R' },
  { k: 'Age', v: 'perhaps 100–400 million years', t: 'R' },
];
/** Ring meshes around giant planets, picked by casting the cursor ray at them. */
export function explainRings(kind: string, obj: THREE.Object3D, rings: () => { mesh: THREE.Mesh; body: number }[]): void {
  const rc = new THREE.Raycaster();
  registerExplainer(kind, {
    obj,
    explain: (b, c) => ringCard(b, c),
    name: (b, c) => `Rings of ${c.world.bodies[b].name}`,
    locate: (b, out) => { const r = rings().find((x) => x.body === b); return r ? r.mesh.getWorldPosition(out) : null; },
  });
  addCpuSet({
    kind, obj, prio: -3,
    hit: (p) => {
      rc.ray.copy(p.ray);
      for (const r of rings()) if (rc.intersectObject(r.mesh, false).length) return { i: r.body, d: 4 };
      return null;
    },
  });
}

function ringCard(id: number, c: ExCtx): Explanation {
  const b = c.world.bodies[id];
  const sat = b.name === 'Saturn';
  const cold = b.temp < 150;
  return {
    eyebrow: 'Planetary rings',
    title: `Rings of ${b.name}`,
    lede: sat ? 'Saturn\'s rings: billions of pieces of ice, each on its own orbit, spread into a sheet thinner, for its width, than a sheet of paper.' : `A ring of ${cold ? 'ice' : 'rock and dust'} around ${b.name}, the debris of a moon torn apart inside the planet's Roche limit.`,
    facts: sat ? SATURN_RINGS : [
      { k: 'Span', v: `${fmtKm(b.radius * 0.35)}–${fmtKm(b.radius * 1.3)} above the cloud tops`, t: 'P' },
      { k: 'Made of', v: cold ? 'water ice with some rock' : 'rock and dust; the ice boiled away', t: 'E' },
      { k: 'Mass', v: `${sig(bodyMassKg(b) * 1e-8)} kg`, t: 'E' },
    ],
    why: 'Ring ice is water already in orbit, with no planet to climb out of: a fuel depot for every ship that passes.',
    links: [{ label: b.name, act: 'body', id }],
  };
}

// ---------------------------------------------------------------- around a planet

/** smallest stage at which a growing count first included index i */
function stageFor(i: number, count: (st: number) => number): number {
  for (let st = STAGE.OUTPOST; st <= STAGE.MEGA; st++) if (count(st) > i) return st;
  return STAGE.MEGA;
}
export const satCount = (st: number) => Math.min(900, 30 + st * st * 22);
export const habCount = (st: number) => (st >= STAGE.CITY ? Math.min(400, Math.floor(Math.pow(st - 4, 2) * 18)) : 0);

const SAT_JOBS = [
  ['communications relay', 'weather and surface watch', 'traffic control beacon', 'mapping'],
  ['navigation and timing', 'communications relay', 'space-weather watch'],
  ['beamed-power relay', 'deep-space antenna', 'debris tug', 'telescope'],
];
export function explainSats(kind: string, pts: THREE.Points, body: () => number): void {
  registerExplainer(kind, {
    obj: pts,
    explain: (i, c) => satCard(pts, body(), i, c),
    name: (i, c) => { const b = c.world.bodies[body()]; return `${b.name.slice(0, 3).toUpperCase()}-${(i + 1).toString().padStart(3, '0')} · ${pick(SAT_JOBS[i % 3], h01(body(), i, 1))}`; },
    locate: (i, out) => pointWorld(pts, i, out),
  });
  addGpuSet({ kind, points: pts, prio: 2, minLum: 0.05, pickPx: 6 });
}

function satCard(pts: THREE.Points, id: number, i: number, c: ExCtx): Explanation {
  const b = c.world.bodies[id];
  const a = pts.geometry.attributes.position.array as Float32Array;
  const Rv = Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
  const alt = (Rv / 10 - 1) * b.radius;
  const r = (b.radius + alt) * 1000, M = bodyMassKg(b);
  const period = 2 * Math.PI * Math.sqrt(r ** 3 / (G_SI * M)) / 60;
  const shell = i % 3;
  const job = pick(SAT_JOBS[shell], h01(id, i, 1));
  const since = stageFor(i, satCount);
  const incl = Math.abs(Math.asin(a[i * 3 + 1] / Rv)) * 180 / Math.PI;
  return {
    eyebrow: `Satellite of ${b.name}`,
    title: `${b.name.slice(0, 3).toUpperCase()}-${(i + 1).toString().padStart(3, '0')}`,
    lede: `${an(job).replace(/^a/, 'A')} satellite in ${shell === 0 ? 'low' : shell === 1 ? 'middle' : 'high'} orbit, operated from ${b.name}.`,
    facts: [
      { k: 'Job', v: job, t: 'P' },
      { k: 'Height', v: fmtKm(alt), t: 'P' },
      { k: 'Goes round in', v: period > 120 ? `${(period / 60).toFixed(1)} hours` : `${Math.round(period)} minutes`, t: 'E' },
      { k: 'Tilt to the equator', v: `${Math.round(incl)}°`, t: 'P' },
      { k: 'Launched', v: `once ${b.name} grew to ${an(STAGE_NAMES[since].toLowerCase())}`, t: 'P' },
      { k: 'Satellites here now', v: fmtNum(satCount(stageAt(c.snap, id))), t: 'P' },
    ],
    why: 'Nothing on a new world works without them: no maps, no clocks, no talking past the horizon.',
    links: [{ label: b.name, act: 'body', id }],
  };
}

const HAB_NAMES = ['Island', 'Haven', 'Meridian', 'Concord', 'Halcyon', 'Arbor', 'Lantern', 'Cradle', 'Bastion', 'Orchard', 'Vesper', 'Kepler', 'Tsiolkovsky', 'O\'Neill', 'Bernal', 'Stanford', 'Ceres Gate', 'New Hope', 'Arcadia', 'Solace'];
export function explainHabitats(kind: string, obj: THREE.Object3D, list: () => { meshes: THREE.InstancedMesh[]; nTor: number }, body: () => number): void {
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  const at = (i: number, out: THREE.Vector3) => {
    const { meshes, nTor } = list();
    const [cyl, tor] = meshes;
    if (!cyl) return null;
    const mesh = i < nTor ? tor : cyl, k = i < nTor ? i : i - nTor;
    if (k >= mesh.count) return null;
    mesh.getMatrixAt(k, m4);
    return out.setFromMatrixPosition(m4).applyMatrix4(mesh.matrixWorld);
  };
  registerExplainer(kind, {
    obj,
    explain: (i, c) => habCard(i, body(), list().nTor, c),
    name: (i) => habName(body(), i, list().nTor),
    locate: at,
  });
  addCpuSet({
    kind, obj, prio: 2,
    hit: (p) => { const { meshes } = list(); const n = meshes.reduce((s, m) => s + m.count, 0); return nearestPoint(n, (i, out) => at(i, out), p); },
  });
  void v;
}
function habName(b: number, i: number, nTor: number): string {
  // every habitat round one world has its own name: a stem per index, a numeral for each further round of building
  const off = Math.floor(h01(b, 3) * HAB_NAMES.length), stem = HAB_NAMES[(i * 7 + off) % HAB_NAMES.length];
  const round = Math.floor(i / HAB_NAMES.length);
  return `${stem}${round ? ` ${ROMAN[round] ?? round + 1}` : ''}` + (i < nTor ? ' (torus)' : ' (cylinder)');
}
const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];

function habCard(i: number, id: number, nTor: number, c: ExCtx): Explanation {
  const b = c.world.bodies[id];
  const st = stageAt(c.snap, id), pop = popAt(c.snap, id);
  const torus = i < nTor;
  const n = habCount(st);
  // people living in orbit: a few percent of a city's, a third of a megastructure civilisation's
  const share = st >= STAGE.MEGA ? 0.3 : st >= STAGE.HUB ? 0.1 : 0.03;
  const wSum = nTor * 1 + (n - nTor) * 40;
  const cap = torus ? 140000 : 10_000_000;
  const people = Math.min(cap * (0.55 + 0.4 * h01(id, i, 6)), Math.round(pop * share * (torus ? 1 : 40) / Math.max(1, wSum) * (0.7 + 0.6 * h01(id, i, 7))));
  return {
    eyebrow: `Orbital habitat of ${b.name}`,
    title: habName(id, i, nTor).replace(/ \((torus|cylinder)\)$/, ''),
    lede: torus ? 'A Stanford torus: a wheel of air and farmland spinning once a minute so the rim has Earth gravity.' : 'An O\'Neill cylinder: two counter-rotating cylinders with land strips inside and mirrors to let the sunlight in.',
    facts: [
      { k: 'Design', v: torus ? 'Stanford torus, 1.8 km across' : 'O\'Neill cylinder, 8 km wide, 32 km long', t: 'R' },
      { k: 'Spin gravity', v: '1 g at the rim', t: 'R' },
      { k: 'People', v: `${fmtNum(people)} (counted in ${b.name}'s total)`, t: 'E' },
      { k: 'Built to hold', v: fmtNum(cap), t: 'R' },
      { k: 'Habitats round here', v: `${n} (${nTor} tori, ${n - nTor} cylinders)`, t: 'P' },
      { k: 'Built', v: `after ${b.name} grew to ${an(STAGE_NAMES[stageFor(i, habCount)].toLowerCase())}`, t: 'P' },
    ],
    why: 'Habitats make their own gravity and climate, so a civilisation that builds them no longer needs good planets: this is how a few worlds become trillions of people.',
    links: [{ label: b.name, act: 'body', id }],
  };
}

// Rotation periods (hours) for the bodies an elevator might stand on; others are drawn from a hash.
const SPIN_H: Record<string, number> = { Earth: 23.93, Mars: 24.62, Moon: 655.7, Venus: 5832.5, Mercury: 1407.6, Ceres: 9.07, Vesta: 5.34, Io: 42.46, Europa: 85.2, Ganymede: 171.7, Callisto: 400.5, Titan: 382.7, Enceladus: 32.9, Pluto: 153.3, Triton: 141.0, Titania: 208.9, Oberon: 323.1 };
const ELEV = TECHS.findIndex((t) => t.id === 'spaceElevator');

export function explainElevators(kind: string, obj: THREE.Object3D, list: () => THREE.Group[], body: () => number): void {
  const A = new THREE.Vector3(), B = new THREE.Vector3();
  registerExplainer(kind, {
    obj,
    explain: (i, c) => elevatorCard(i, body(), list().length, c),
    name: (i, c) => `${c.world.bodies[body()].name} space elevator ${['Alpha', 'Beta', 'Gamma'][i] ?? i + 1}`,
    locate: (i, out) => { const g = list()[i]; return g ? (g.children[1] as THREE.Object3D).getWorldPosition(out) : null; },
  });
  addCpuSet({
    kind, obj, prio: 1,
    hit: (p: Probe) => {
      let best: { i: number; d: number } | null = null;
      list().forEach((g, i) => {
        const line = g.children[0] as THREE.Line;
        const pos = line.geometry.attributes.position.array as Float32Array;
        A.set(pos[0], pos[1], pos[2]).applyMatrix4(line.matrixWorld);
        B.set(pos[3], pos[4], pos[5]).applyMatrix4(line.matrixWorld);
        const d = segDist(A, B, p);
        if (d < 8 && (!best || d < best.d)) best = { i, d };
      });
      return best;
    },
  });
}

function elevatorCard(i: number, id: number, n: number, c: ExCtx): Explanation {
  const b = c.world.bodies[id];
  const M = bodyMassKg(b), R = b.radius * 1000;
  const T = (SPIN_H[b.name] ?? 10 + 30 * h01(id, 77)) * 3600;
  let rSync = Math.cbrt((G_SI * M * T * T) / (4 * Math.PI * Math.PI));
  let anchor = 'synchronous orbit';
  if (b.parent >= 0) {
    // a slow-turning moon: the ribbon hangs toward its planet through the L1 point instead
    const P = c.world.bodies[b.parent];
    const rL1 = b.a * 1e6 * Math.cbrt(M / (3 * bodyMassKg(P)));
    if (rL1 < rSync) { rSync = rL1; anchor = `the L1 point toward ${P.name}`; }
  }
  const len = Math.max(rSync * 1.45 - R, 2 * R) / 1000;
  const built = c.snap ? c.snap.techDone[ELEV] : -1;
  const climb = len / 200; // hours at 200 km/h
  const names = ['Alpha', 'Beta', 'Gamma'];
  return {
    eyebrow: `Space elevator on ${b.name}`,
    title: `${b.name} elevator ${names[i] ?? i + 1}`,
    lede: `A ribbon from the equator to a counterweight beyond ${anchor}, held taut by ${b.name}'s spin. Climbers ride it to orbit on electricity instead of rockets.`,
    facts: [
      { k: 'Length', v: fmtKm(len), t: 'E' },
      { k: 'Anchor point', v: `${anchor}, ${fmtKm(rSync / 1000 - b.radius)} up`, t: 'E' },
      { k: `${b.name} turns once in`, v: SPIN_H[b.name] ? `${SPIN_H[b.name]} hours` : `${(T / 3600).toFixed(1)} hours`, t: SPIN_H[b.name] ? 'R' : 'P' },
      { k: 'Ribbon', v: 'carbon nanotube or graphene composite', t: 'E' },
      { k: 'Climb to the top', v: climb > 48 ? `${(climb / 24).toFixed(0)} days at 200 km/h` : `${climb.toFixed(0)} hours at 200 km/h`, t: 'E' },
      { k: 'Technology since', v: built >= 0 ? yr(built) : '—', t: 'P' },
      { k: 'Elevators here', v: `${n}${n > 1 ? `; the second and third added once ${b.name} became a hub` : ''}`, t: 'P' },
    ],
    why: 'Lifting a kilogram to orbit drops from thousands of dollars by rocket to a few dollars of electricity: the whole economy of the world above changes.',
    links: [{ label: b.name, act: 'body', id }],
  };
}

export function explainRingWorld(kind: string, mesh: () => THREE.Mesh | null, obj: THREE.Object3D, body: () => number): void {
  const A = new THREE.Vector3(), B = new THREE.Vector3();
  registerExplainer(kind, {
    obj,
    explain: (_i, c) => ringWorldCard(body(), c),
    name: (_i, c) => `${c.world.bodies[body()].name} orbital ring`,
    locate: (_i, out) => { const m = mesh(); return m ? m.getWorldPosition(out) : null; },
  });
  addCpuSet({
    kind, obj, prio: 0,
    hit: (p) => {
      const m = mesh();
      if (!m) return null;
      const R = (m.geometry as THREE.TorusGeometry).parameters.radius;
      let d = Infinity;
      for (let k = 0; k < 96; k++) {
        const t0 = (k / 96) * Math.PI * 2, t1 = ((k + 1) / 96) * Math.PI * 2;
        A.set(Math.cos(t0) * R, Math.sin(t0) * R, 0).applyMatrix4(m.matrixWorld);
        B.set(Math.cos(t1) * R, Math.sin(t1) * R, 0).applyMatrix4(m.matrixWorld);
        d = Math.min(d, segDist(A, B, p));
      }
      return d < 7 ? { i: 0, d } : null;
    },
  });
}

function ringWorldCard(id: number, c: ExCtx): Explanation {
  const b = c.world.bodies[id];
  const r = b.radius * 1.7;
  const width = Math.max(50, b.radius * 0.01);
  const area = 2 * Math.PI * r * width;
  const pop = popAt(c.snap, id);
  return {
    eyebrow: `Megastructure at ${b.name}`,
    title: `${b.name} orbital ring`,
    lede: `A continuous band of habitat circling ${b.name}, built once the world became a megastructure civilisation. It carries cities, docks and the tethers of every elevator.`,
    facts: [
      { k: 'Radius', v: fmtKm(r), t: 'P' },
      { k: 'Circumference', v: fmtKm(2 * Math.PI * r), t: 'P' },
      { k: 'Width', v: fmtKm(width), t: 'P' },
      { k: 'Living area', v: `${sig(area)} km², ${sig(area / 510e6)}× Earth's surface`, t: 'E' },
      { k: 'People on it', v: `≈${fmtNum(pop * 0.2)} (part of ${b.name}'s total)`, t: 'E' },
      { k: 'Stage', v: STAGE_NAMES[stageAt(c.snap, id)] ?? '—', t: 'P' },
    ],
    why: 'Once a world is ringed, launching from it costs almost nothing: the ring is a harbour as much as a home.',
    links: [{ label: b.name, act: 'body', id }],
  };
}
