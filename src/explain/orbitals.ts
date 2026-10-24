// The works built around a world and around its star (view/orbitals.ts):
// Stanford tori, O'Neill cylinder pairs, Bishop rings, swarm panels, the
// orbital ring, the ring world, an uploaded world's lattice; and in the system
// view a brain-star's Matrioshka shells and the jets of a lifted star.
// Each object view/orbitals.ts builds carries `userData.work`; a pick id is
// object slot × 10,000 + instance, so it names one habitat, ring or panel.

import * as THREE from 'three';
import { STAGE_NAMES } from '../sim/catalog.ts';
import type { Body } from '../sim/world.ts';
import { fmtNum } from '../ui/format.ts';
import { techYear } from '../view/timeLook.ts';
import { tierRank } from '../view/orbitals.ts';
import { L_SUN_W, fmtKm, fmtW, mainSequence, num, sig, specNum } from './astro.ts';
import { addCpuSet, nearestPoint, pxPerUnit, segDist, type CpuHit, type Probe } from './picker.ts';
import { h01, registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';
import { popAt, stageAt } from './simInfo.ts';

const SLOT = 10000;
const yr = (y: number) => String(Math.round(2040 + y));

type Work = 'torus' | 'oneill' | 'bishop' | 'panel' | 'oring' | 'ringworld' | 'lattice' | 'shell' | 'jet';
const workOf = (o: THREE.Object3D | undefined) => o?.userData.work as Work | undefined;

const m4 = new THREE.Matrix4(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
const rc = new THREE.Raycaster();

/** Where instance k of an instanced work is, in world space. */
function instAt(o: THREE.InstancedMesh, k: number, out: THREE.Vector3): THREE.Vector3 | null {
  if (k >= o.count) return null;
  o.getMatrixAt(k, m4);
  return out.setFromMatrixPosition(m4).applyMatrix4(o.matrixWorld);
}

/** Screen distance from the cursor to a torus' centre line (TorusGeometry lies in its local xy plane). */
function circleDist(o: THREE.Mesh, p: Probe, steps = 64): number {
  const R = (o.geometry as THREE.TorusGeometry).parameters.radius;
  let d = Infinity;
  for (let k = 0; k < steps; k++) {
    const t0 = (k / steps) * Math.PI * 2, t1 = ((k + 1) / steps) * Math.PI * 2;
    A.set(Math.cos(t0) * R, Math.sin(t0) * R, 0).applyMatrix4(o.matrixWorld);
    B.set(Math.cos(t1) * R, Math.sin(t1) * R, 0).applyMatrix4(o.matrixWorld);
    d = Math.min(d, segDist(A, B, p));
  }
  return d;
}

function hitWork(works: readonly THREE.Object3D[], p: Probe): CpuHit | null {
  let best: CpuHit | null = null;
  const take = (i: number, d: number) => { if (!best || d < best.d) best = { i, d }; };
  works.forEach((o, s) => {
    const w = workOf(o);
    if (!w || !o.visible) return;
    if (w === 'torus' || w === 'oneill' || w === 'panel') {
      const im = o as THREE.InstancedMesh;
      const size = w === 'panel' ? 0.1 : 0.15;
      const h = nearestPoint(im.count, (k, out) => instAt(im, k, out), p, (_k, _d, cam) => Math.max(6, size * pxPerUnit(p, cam)));
      if (h) take(s * SLOT + h.i, h.d + (w === 'panel' ? 2 : 0));
    } else if (w === 'bishop' || w === 'oring') {
      const d = circleDist(o as THREE.Mesh, p);
      if (d < 7) take(s * SLOT, d);
    } else if (w === 'ringworld' || w === 'jet') {
      rc.ray.copy(p.ray);
      if (rc.intersectObject(o, false).length) take(s * SLOT, 5);
    } else if (w === 'lattice' || w === 'shell') {
      // a shell is claimed where the cursor's line of sight grazes it: the innermost sphere it passes inside
      const R = (((o as THREE.Mesh).geometry as THREE.IcosahedronGeometry | undefined)?.parameters?.radius) ?? 10.6;
      o.getWorldPosition(C);
      const along = A.copy(C).sub(p.ray.origin).dot(p.ray.direction);
      if (along <= 0) return;
      const miss = B.copy(p.ray.direction).multiplyScalar(along).add(p.ray.origin).distanceTo(C);
      if (miss <= R) take(s * SLOT, w === 'lattice' ? 9 : 6 + (miss / R) * 2);
    }
  });
  return best;
}

/**
 * Register the works around a world (planet view: `works` from Orbitals, `body` the world shown)
 * or around a star (system view: the star group's children, `body` -1 and `sys` the system).
 */
export function explainWorks(kind: string, obj: THREE.Object3D, works: () => readonly THREE.Object3D[], where: () => { body: number; sys: number }, prio = 2): void {
  registerExplainer(kind, {
    obj,
    explain: (id, c) => workCard(works(), id, where(), c),
    name: (id, c) => workName(works(), id, where(), c),
    locate: (id, out) => {
      const o = works()[Math.floor(id / SLOT)];
      if (!o) return null;
      return o instanceof THREE.InstancedMesh ? instAt(o, id % SLOT, out) : o.getWorldPosition(out);
    },
  });
  addCpuSet({ kind, obj, prio, hit: (p) => hitWork(works(), p) });
}

// ---------------------------------------------------------------- names

const HAB_NAMES = ['Island', 'Haven', 'Meridian', 'Concord', 'Halcyon', 'Arbor', 'Lantern', 'Cradle', 'Bastion', 'Orchard', 'Vesper', 'Kepler', 'Tsiolkovsky', 'Bernal', 'Stanford', 'Gate', 'New Hope', 'Arcadia', 'Solace', 'Tamarind', 'Pavonis', 'Juniper', 'Lagrange', 'Shackleton'];
const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
/** Unique within a world: a stem per index, a numeral for each further round of building. */
function habName(b: number, salt: number, i: number): string {
  const off = Math.floor(h01(b, salt, 3) * HAB_NAMES.length);
  const round = Math.floor(i / HAB_NAMES.length);
  return `${HAB_NAMES[(i * 7 + off) % HAB_NAMES.length]}${round ? ` ${ROMAN[round] ?? round + 1}` : ''}`;
}
const tag3 = (b: Body) => b.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

function workName(works: readonly THREE.Object3D[], id: number, at: { body: number; sys: number }, c: ExCtx): string {
  const o = works[Math.floor(id / SLOT)], k = id % SLOT, w = workOf(o);
  const b = at.body >= 0 ? c.world.bodies[at.body] : null;
  const s = c.world.systems[at.sys];
  switch (w) {
    case 'torus': return `${habName(at.body, 1, k)} · Stanford torus`;
    case 'oneill': return `${habName(at.body, 2, k >> 1)} ${k % 2 ? 'B' : 'A'} · O'Neill cylinder`;
    case 'bishop': return `${habName(at.body, 3, Math.floor(id / SLOT))} Ring · Bishop ring`;
    case 'panel': return `${b ? tag3(b) : 'SWM'}-S${String(k + 1).padStart(4, '0')} · swarm collector`;
    case 'oring': return `${b?.name} orbital ring`;
    case 'ringworld': return `${b?.name} ring world`;
    case 'lattice': return `The lattice of ${b?.name} · uploaded minds`;
    case 'shell': return `Shell ${['I', 'II', 'III', 'IV'][o!.userData.k] ?? ''} of the ${s.name} brain`;
    case 'jet': return `Star-lifting jet of ${s.name}`;
    default: return 'Orbital work';
  }
}

// ---------------------------------------------------------------- who lives up there

/** Share of a world's people living in its orbital works, by how developed it is. */
function orbitShare(rank: number): number { return [0.03, 0.1, 0.3, 0.5, 0.55, 0.5, 0.5, 0.2][rank] ?? 0; }
const WEIGHT: Partial<Record<Work, number>> = { torus: 1, oneill: 400, bishop: 60000, ringworld: 0, oring: 0 };
const CAP: Partial<Record<Work, number>> = { torus: 10_000, oneill: 5_000_000, bishop: 3e9 };

function residents(works: readonly THREE.Object3D[], id: number, body: number, c: ExCtx): number {
  const o = works[Math.floor(id / SLOT)], w = workOf(o)!;
  const st = stageAt(c.snap, body), pop = popAt(c.snap, body), rank = tierRank(st);
  let sum = 0;
  for (const x of works) { const wx = workOf(x)!; sum += (WEIGHT[wx] ?? 0) * (x instanceof THREE.InstancedMesh ? x.count : 1); }
  const each = (pop * orbitShare(rank) * (WEIGHT[w] ?? 0)) / Math.max(1, sum);
  return Math.round(Math.min((CAP[w] ?? Infinity) * (0.55 + 0.4 * h01(body, id, 6)), each * (0.7 + 0.6 * h01(body, id, 7))));
}

// ---------------------------------------------------------------- cards

function workCard(works: readonly THREE.Object3D[], id: number, at: { body: number; sys: number }, c: ExCtx): Explanation {
  const o = works[Math.floor(id / SLOT)], w = workOf(o);
  const title = workName(works, id, at, c).split(' · ')[0];
  if (w === 'shell' || w === 'jet') return starWorkCard(w, o!, title, at.sys, c);
  const b = c.world.bodies[at.body];
  const st = stageAt(c.snap, at.body), pop = popAt(c.snap, at.body);
  const links = [{ label: b.name, act: 'body' as const, id: at.body }];
  const tech = (id: string, what: string): Fact => { const y = techYear(c.snap, id); return { k: what, v: y >= 0 ? yr(y) : 'not yet', t: 'P' }; };
  const count = (wk: Work) => works.filter((x) => workOf(x) === wk).reduce((s, x) => s + (x instanceof THREE.InstancedMesh ? x.count : 1), 0);
  const people = residents(works, id, at.body, c);
  const lives: Fact = { k: 'People aboard', v: `${fmtNum(people)}, counted in ${b.name}'s ${fmtNum(pop)}`, t: 'E' };
  switch (w) {
    case 'torus': {
      const relic = count('oneill') > 0;
      return {
        eyebrow: `Orbital habitat of ${b.name}`, title,
        lede: 'A Stanford torus: a wheel of air and farmland 1.8 km across, spinning once a minute so the rim has Earth gravity.',
        facts: [
          { k: 'Design', v: 'Stanford torus (NASA–Stanford study, 1975)', t: 'R' },
          { k: 'Size', v: '1.8 km across, tube 130 m wide', t: 'R' },
          { k: 'Spin', v: '1 turn a minute, 1 g at the rim', t: 'R' },
          { k: 'Built to hold', v: '10,000 people', t: 'R' },
          lives,
          { k: 'Shielding', v: '10 million tonnes of lunar or asteroid slag', t: 'R' },
          { k: 'Tori round here', v: String(count('torus')), t: 'P' },
        ],
        why: relic ? 'The first design anyone built; newer cylinders dwarf it now, but the old wheels are kept on as heritage towns.' : 'The first way out of the gravity well for good: a town that makes its own gravity, air and food.',
        links,
      };
    }
    case 'oneill': return {
      eyebrow: `Orbital habitat of ${b.name}`, title,
      lede: 'One of a counter-rotating pair of O\'Neill cylinders: three land strips inside, three windows between, and mirrors that open and close to make the day.',
      facts: [
        { k: 'Design', v: 'Island Three (Gerard O\'Neill, 1976)', t: 'R' },
        { k: 'Size', v: '8 km across, 32 km long', t: 'R' },
        { k: 'Land inside', v: '≈ 500 km² on three strips', t: 'R' },
        { k: 'Spin', v: 'once every 2 minutes for 1 g; its twin turns the other way to cancel the gyroscope', t: 'R' },
        { k: 'Built to hold', v: 'a few million people', t: 'E' },
        lives,
        tech('orbitalHabitats', 'Technology since'),
        { k: 'Cylinders round here', v: String(count('oneill')), t: 'P' },
      ],
      why: 'Cylinders make land wherever there is sunlight and rock: with them a civilisation stops needing good planets.',
      links,
    };
    case 'bishop': {
      const R = ((o as THREE.Mesh).geometry as THREE.TorusGeometry).parameters.radius;
      const rKm = Math.round(1000 * (R / 1.8) / 50) * 50;
      return {
        eyebrow: `Bishop ring of ${b.name}`, title,
        lede: 'A ring a thousand kilometres across with its land on the inside, held in by walls two hundred kilometres high. It needs no roof: the air stays in by spin gravity.',
        facts: [
          { k: 'Design', v: 'Bishop ring (Forrest Bishop, 1997)', t: 'R' },
          { k: 'Radius', v: `${num(rKm)} km`, t: 'P' },
          { k: 'Land', v: `500 km wide, ${sig(2 * Math.PI * rKm * 500)} km², ${(2 * Math.PI * rKm * 500 / 3.287e6).toFixed(1)}× India`, t: 'E' },
          { k: 'Rim walls', v: '200 km high, open to space', t: 'R' },
          { k: 'Made of', v: 'carbon nanotube cable and asteroid slag', t: 'E' },
          lives,
          tech('bishopRings', 'Technology since'),
        ],
        why: 'A Bishop ring has the land of a country and no planet under it; a world ringed by a few of them has room for billions more.',
        links,
      };
    }
    case 'panel': {
      const s = c.world.systems[b.system];
      const au = b.parent >= 0 ? c.world.bodies[b.parent].a : b.a;
      const flux = 1361 * s.lum / Math.max(1e-3, au * au);
      const n = count('panel');
      return {
        eyebrow: `Swarm collector over ${b.name}`, title,
        lede: 'A thin-film collector catching sunlight in orbit and beaming it down as microwaves or laser light. Hundreds fly round a swarm-age world; around a swarm-world they close into a shell.',
        facts: [
          { k: 'Size', v: 'a square kilometre of film, a few microns thick', t: 'E' },
          { k: 'Sunlight it catches', v: `${fmtW(flux * 1e6)}, at ${au.toPrecision(2)} AU`, t: 'E' },
          { k: 'Power sent down', v: `${fmtW(flux * 1e6 * 0.3)} at 30% efficiency`, t: 'E' },
          { k: 'Panels round here', v: num(n), t: 'P' },
          { k: 'Stage', v: STAGE_NAMES[st] ?? '—', t: 'P' },
          tech(n > 900 ? 'dyson2' : 'dyson1', 'Swarm technology since'),
        ],
        why: 'Energy from orbit is what lets a world run its industry, its sails and its thinking machines without burning anything.',
        links,
      };
    }
    case 'oring': case 'ringworld': {
      const ringworld = w === 'ringworld';
      const r = b.radius * (ringworld ? 1.9 : 1.7);
      const width = ringworld ? b.radius * 0.16 : Math.max(50, b.radius * 0.01);
      const area = 2 * Math.PI * r * width;
      const share = ringworld ? 0.45 : 0.2;
      return {
        eyebrow: ringworld ? `Ring world of ${b.name}` : `Orbital ring of ${b.name}`, title,
        lede: ringworld ? `A broad band of land spun round ${b.name}, its inner face farmed and lived on: the work that gives this stage its name.` : `A continuous band circling ${b.name} above the air, carrying docks, cities and the tops of every elevator.`,
        facts: [
          { k: 'Design', v: ringworld ? 'Bishop rings joined into one band' : 'orbital ring (Paul Birch, 1982)', t: ringworld ? 'P' : 'R' },
          { k: 'Radius', v: fmtKm(r), t: 'P' },
          { k: 'Circumference', v: fmtKm(2 * Math.PI * r), t: 'P' },
          { k: 'Width', v: fmtKm(width), t: 'P' },
          { k: 'Living area', v: `${sig(area)} km², ${sig(area / 510e6)}× Earth's surface`, t: 'E' },
          { k: 'People on it', v: `≈${fmtNum(pop * share)}, part of ${b.name}'s total`, t: 'E' },
          { k: 'Stage', v: STAGE_NAMES[st] ?? '—', t: 'P' },
        ],
        why: ringworld ? 'More land than the planet beneath it, all of it built: the world below becomes a park and a quarry.' : 'Once a world is ringed, launching from it costs almost nothing: the ring is a harbour as much as a home.',
        links,
      };
    }
    case 'lattice': {
      const minds = pop * 0.8;
      return {
        eyebrow: `Uploaded world`, title,
        lede: `A lattice of computing wrapped round ${b.name}. Most of its people no longer have bodies: they live here as running minds.`,
        facts: [
          { k: 'Minds running', v: `≈${fmtNum(minds)}`, t: 'E' },
          { k: 'Power, at 20 W a human-speed mind', v: fmtW(minds * 20), t: 'E' },
          { k: 'Thinking speed', v: 'from human pace to thousands of times faster', t: 'E' },
          { k: 'Stage', v: STAGE_NAMES[st] ?? '—', t: 'P' },
          tech('mindUpload', 'Mind uploading since'),
        ],
        why: 'A mind that runs a thousand times faster lives a thousand subjective years in one: to the people here, the rest of this future crawls.',
        links,
      };
    }
    default:
      return { eyebrow: `In orbit of ${b.name}`, title, lede: 'Something built in orbit.', facts: [{ k: 'Stage', v: STAGE_NAMES[st] ?? '—', t: 'P' }], links };
  }
}

const K_B = 1.380649e-23;
function starWorkCard(w: 'shell' | 'jet', o: THREE.Object3D, title: string, sys: number, c: ExCtx): Explanation {
  const s = c.world.systems[sys];
  const L = s.lum * L_SUN_W;
  const mass = mainSequence(specNum(s.spec)).mass;
  const ops = s.bodies.filter((b) => stageAt(c.snap, b) === (w === 'shell' ? 10 : 11));
  const links = [{ label: s.name, act: 'system' as const, id: sys }, ...ops.slice(0, 2).map((b) => ({ label: c.world.bodies[b].name, act: 'body' as const, id: b }))];
  if (w === 'shell') {
    const k = o.userData.k as number;
    const au = 0.25 * Math.pow(2.5, k) * Math.sqrt(s.lum);
    // every shell passes the star's whole output outward as heat: T = (L / 16πσr²)^¼
    const T = 278 * Math.pow(s.lum, 0.25) / Math.sqrt(au);
    const bits = L / (K_B * T * Math.LN2);
    return {
      eyebrow: `Matrioshka brain around ${s.name}`, title,
      lede: `One of a nested set of shells of computers around ${s.name}. Each runs on the waste heat of the shell inside it and glows cooler and redder than the last.`,
      facts: [
        { k: 'Shell', v: `${['first', 'second', 'third', 'fourth'][k] ?? k + 1} from the star`, t: 'P' },
        { k: 'Radius', v: `${au.toPrecision(2)} AU`, t: 'E' },
        { k: 'Running temperature', v: `${num(T)} K`, t: 'E' },
        { k: 'Power through it', v: fmtW(L), t: 'E' },
        { k: 'Landauer limit at that heat', v: `${sig(bits)} bit operations a second`, t: 'E' },
        { k: 'Built by', v: ops.length ? ops.map((b) => c.world.bodies[b].name).slice(0, 4).join(', ') : 'nobody now', t: 'P' },
        { k: 'Technology since', v: techYear(c.snap, 'matrioshka') >= 0 ? yr(techYear(c.snap, 'matrioshka')) : 'not yet', t: 'P' },
      ],
      why: 'Nearly all of the star\'s light now goes into thought; seen from the next star, it is only a dull infrared ember.',
      links,
    };
  }
  const rate = 1e16; // kg/s, at the top of published star-lifting estimates
  const years = (0.01 * mass * 1.989e30) / rate / 3.156e7;
  return {
    eyebrow: `Lifted star`, title,
    lede: `Plasma drawn off ${s.name}'s poles by magnetic fields and the star's own heat, to be mined for hydrogen, helium and metals.`,
    facts: [
      { k: 'Method', v: 'star lifting: heating a pole and channelling the outflow (Criswell, 1985)', t: 'R' },
      { k: 'Mass drawn off', v: `≈${sig(rate)} kg a second`, t: 'E' },
      { k: 'One per cent of the star in', v: `${num(Math.round(years / 1000) * 1000)} years`, t: 'E' },
      { k: 'Star mass', v: `${mass.toPrecision(2)} M☉`, t: 'E' },
      { k: 'Worked by', v: ops.length ? ops.map((b) => c.world.bodies[b].name).slice(0, 4).join(', ') : 'nobody now', t: 'P' },
      { k: 'Technology since', v: techYear(c.snap, 'starLifting') >= 0 ? yr(techYear(c.snap, 'starLifting')) : 'not yet', t: 'P' },
    ],
    why: 'A lighter star burns slower: lifting stretches its life by billions of years while supplying more metal than every planet in the system.',
    links,
  };
}
