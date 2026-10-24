// The five zoom levels. Each view owns a THREE.Group, knows how to place the
// camera, how to refresh itself when the simulation year changes, and what
// can be clicked or labelled.

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STAGE, STAGE_NAMES, TECHS, isAlive } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import { Rng, hash01 } from '../sim/rng.ts';
import { GALACTIC_CENTRE, GALAXIES, galToXYZ, type Body, type World } from '../sim/world.ts';
import { fmtNum } from '../ui/format.ts';
import { ageColor, factionColor, faithColor, heatColor, type ColorMode } from './colorModes.ts';
import { styleOf } from './epoch.ts';
import { makeGalaxy } from './galaxyPoints.ts';
import { atmosphereMaterial, planetMaterial, setCityLights } from './planetShader.ts';
import { Orbitals, StarWorks, tierRank } from './orbitals.ts';
import { BEAM, SCOOP, shipStyle } from './shipStyles.ts';
import { applyCultureLights, cultureLight, cultureSkin, lookKey, societyLook } from './societyLook.ts';
import { REDUCED_MOTION, applyPlanetLook } from './timeLook.ts';
import { STAGE_COLORS, flareTex, galaxySpriteTex, glowTex, pointsMaterial, specColor } from './textures.ts';
import { explainGalaxy } from '../explain/galaxy.ts';
import { addCpuSet, addGpuSet, nearestPoint, pxPerUnit } from '../explain/picker.ts';
import { pointWorld, registerExplainer } from '../explain/registry.ts';
import { explainShips, shipId } from '../explain/ships.ts';
import { explainSky, type Observer } from '../explain/sky.ts';
import { explainBackground } from '../explain/universe.ts';
import { explainBelt, type BeltInfo, explainElevators, explainOrbits, explainRings, explainSats, explainSwarm } from '../explain/worlds.ts';
import { explainLocalRings } from '../explain/local.ts';
import { explainWorks } from '../explain/orbitals.ts';

export type Level = 'universe' | 'galaxy' | 'local' | 'system' | 'planet' | 'street';
export const LEVELS: Level[] = ['universe', 'galaxy', 'local', 'system', 'planet', 'street'];

export interface Ctx {
  world: World;
  snap: StateMsg | null;
  year: number;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  system: number;   // focused star system
  body: number;     // focused body
  city: number;     // focused settlement on that body
  selected: Pickable | null;
  t: number;        // seconds since start
  tm: number;       // motion clock: orbits and spin; slows to a stop while hovering a thing so it can be clicked
  colorBy: ColorMode;
}

export type PickKind = 'galaxy' | 'system' | 'body' | 'city' | 'humanspace' | 'person' | 'thing';
/** `weight` (px) lets important things win near-ties when picking. A 'thing' is anything else drawn, explained by kind `ex` (src/explain). */
export interface Pickable { pos: THREE.Vector3; kind: PickKind; id: number; name: string; weight?: number; r?: number; ex?: string }
/** Enough to find a thing again in any view. */
export interface Ref { kind: PickKind; id: number; name?: string; ex?: string }
/** Higher `prio` labels win when two would overlap on screen. */
export interface Label { pos: THREE.Vector3; text: string; sub?: string; strong?: boolean; ref?: Ref; prio?: number }

export interface View {
  level: Level;
  group: THREE.Group;
  limits: [number, number];
  enter(ctx: Ctx): void;
  sync(ctx: Ctx): void;
  frame(ctx: Ctx, dt: number): void;
  pickables(ctx: Ctx): Pickable[];
  labels(ctx: Ctx): Label[];
  /** where a thing sits in this view, if it is shown here at all */
  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null;
  /** camera distance at which wheeling into `r` enters it; 0 = not enterable */
  diveDist(ctx: Ctx, r: Ref): number;
  /** world-space radius of the thing, for the selection ring; 0 = a point */
  size?(ctx: Ctx, r: Ref): number;
}

// ---------------------------------------------------------------- helpers

const tmpC = new THREE.Color(), cultC = new THREE.Color();

/** galactic (Sun-centred, ly) → scene axes with y up */
export function toScene(x: number, y: number, z: number, scale = 1, ox = 0): THREE.Vector3 {
  return new THREE.Vector3((x - ox) * scale, z * scale, -y * scale);
}

export function stageOf(snap: StateMsg | null, b: number): number {
  return snap ? snap.S[b * NF + F.stage] : -1;
}
export function popOf(snap: StateMsg | null, b: number): number {
  return snap ? snap.S[b * NF + F.pop] : 0;
}
export function alive(stage: number): boolean { return isAlive(stage); }

/** Settlements drawn on a world: one capital plus more as it grows. */
export function cityCount(stage: number, pop: number): number {
  if (!alive(stage)) return 0;
  return pop < 1000 ? 1 : Math.min(48, Math.ceil(Math.cbrt(pop / 1000)));
}

/** Night-side light coverage: dark below ~10k people, full at tens of billions. */
/** Unit direction of settlement i on body b's surface (the same everywhere it is drawn). */
export function cityDir(b: number, i: number): THREE.Vector3 {
  const u = hash01(b, i, 1) * 2 - 1, th = hash01(b, i, 2) * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(th), u * 0.85, s * Math.sin(th)).normalize();
}

export function cityLights(pop: number): number {
  return Math.min(0.95, Math.max(0, (Math.log10(1 + pop) - 4) / 6.5));
}
/** Head-count of city i of n and the index of its first resident in the world's list. Capital holds 30%. */
export function citySplit(pop: number, n: number, i: number): { count: number; offset: number } {
  if (n <= 1) return { count: Math.floor(pop), offset: 0 };
  const cap = Math.floor(pop * 0.3), rest = (pop - cap) / (n - 1);
  return i === 0 ? { count: cap, offset: 0 } : { count: Math.floor(cap + rest * i) - Math.floor(cap + rest * (i - 1)), offset: Math.floor(cap + rest * (i - 1)) };
}

/** Night lights of body b's settlements: where each one is and how big (0..1), for the planet shader. */
export function lightCities(mat: THREE.ShaderMaterial, b: number, stage: number, pop: number): void {
  const n = cityCount(stage, pop), dirs: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) dirs.push(cityDir(b, i));
  setCityLights(mat, dirs, (i) => (Math.log10(1 + citySplit(pop, n, i).count) - 3) / 7 + 0.15);
}

/** Where the star sits in the planet view: off to the side and a little behind, so the night side and its lights show. */
export const PLANET_SUN = new THREE.Vector3(380, 90, -120);

export interface SystemSum { stage: number; pop: number; n: number; faction: number; founded: number; culture: number }

/** Stage is the most developed settlement; faction and faith (culture) those of the most populous; founded the earliest. */
export function systemSummary(world: World, snap: StateMsg | null, sys: number): SystemSum {
  let stage = -1, pop = 0, n = 0, faction = -1, founded = Infinity, top = -1, culture = 0;
  for (const b of world.systems[sys].bodies) {
    const s = stageOf(snap, b);
    if (s < 0) continue;
    if (alive(s)) {
      n++;
      const p = popOf(snap, b);
      pop += p; stage = Math.max(stage, s);
      if (p > top) { top = p; faction = snap!.S[b * NF + F.faction]; culture = snap!.S[b * NF + F.culture]; }
      founded = Math.min(founded, snap!.S[b * NF + F.founded]);
    }
    else if (stage < 0) stage = s === STAGE.SURVEY ? STAGE.SURVEY : s;
    else if (s === STAGE.SURVEY && stage >= STAGE.ABANDONED) stage = STAGE.SURVEY;
  }
  return { stage, pop, n, faction, founded, culture };
}

/** Colour of a living system under the current colour mode. */
export function modeColor(ctx: Ctx, s: SystemSum, out: THREE.Color): THREE.Color {
  if (ctx.colorBy === 'faction') return factionColor(s.faction, ctx.world.earth, out);
  if (ctx.colorBy === 'faith') return faithColor(s.culture, out);
  if (ctx.colorBy === 'heat') return heatColor(s.pop, out);
  if (ctx.colorBy === 'founded') return ageColor(s.founded, ctx.year, out);
  return out.set(STAGE_COLORS[s.stage]);
}

function pointCloud(n: number, mat: THREE.ShaderMaterial): { pts: THREE.Points; pos: Float32Array; col: Float32Array; size: Float32Array } {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { pts, pos, col, size };
}

function dirty(p: THREE.Points): void {
  const g = p.geometry;
  g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.size.needsUpdate = true;
}

function glowSprite(color: number, scale: number, opacity = 1, tex = glowTex): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
  s.scale.setScalar(scale);
  return s;
}

/** Ship routes: additive line segments with per-vertex colour, plus glowing heads. */
class Trails {
  lines: THREE.LineSegments;
  heads: ReturnType<typeof pointCloud>;
  private pos: Float32Array; private col: Float32Array;
  private ns = 0; private nh = 0;
  // which ship each segment and head belongs to, and where each ship's head is, for picking
  private headIds: number[] = []; private segIds: number[] = [];
  private at = new Map<number, THREE.Vector3>(); private pool: THREE.Vector3[] = [];
  constructor(private maxSeg: number, private maxHeads: number, headPx = 2) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxSeg * 6); this.col = new Float32Array(maxSeg * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.heads = pointCloud(maxHeads, pointsMaterial({ minPx: headPx }));
  }
  addTo(g: THREE.Group): void { g.add(this.lines, this.heads.pts); }
  begin(): void { this.ns = 0; this.nh = 0; this.headIds.length = 0; this.segIds.length = 0; this.at.clear(); }
  /** make heads and routes pickable as ships under `kind` */
  explain(kind: string): void {
    explainShips(kind, { heads: this.heads.pts, headIds: this.headIds, lines: this.lines, segIds: this.segIds, segCount: () => this.ns, at: this.at });
  }
  seg(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Color, ka: number, kb: number, ship = -1): void {
    if (this.ns >= this.maxSeg) return;
    this.segIds[this.ns] = ship;
    this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], this.ns * 6);
    this.col.set([c.r * ka, c.g * ka, c.b * ka, c.r * kb, c.g * kb, c.b * kb], this.ns * 6);
    this.ns++;
  }
  head(p: THREE.Vector3, c: THREE.Color, size: number, ship = -1): void {
    if (this.nh >= this.maxHeads) return;
    this.headIds[this.nh] = ship;
    if (ship >= 0 && !this.at.has(ship)) this.at.set(ship, (this.pool[this.at.size] ??= new THREE.Vector3()).copy(p));
    this.heads.pos.set([p.x, p.y, p.z], this.nh * 3);
    this.heads.col.set([c.r, c.g, c.b], this.nh * 3);
    this.heads.size[this.nh++] = size;
  }
  end(): void {
    const g = this.lines.geometry;
    g.setDrawRange(0, this.ns * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    this.heads.pts.geometry.setDrawRange(0, this.nh);
    dirty(this.heads.pts);
  }
}
const ELEVATOR = TECHS.findIndex((t) => t.id === 'spaceElevator');
const TETHER = 17; // counterweight radius; short enough to stay clear of the side panel
const tv1 = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);
const tmpC2 = new THREE.Color();

/** Distant stars with a Milky Way band; follows the camera. */
export function makeSky(seed = 7, count = 9000, kind?: string, observer?: () => Observer | null): THREE.Group {
  const r = new Rng(seed);
  const { pts, pos, col, size } = pointCloud(count, pointsMaterial({ attenuate: false, minPx: 0.5 }));
  const cls = new Uint8Array(count), bri = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let lon = r.range(0, Math.PI * 2), lat: number;
    if (r.next() < 0.55) lat = r.gauss() * 0.12 * (1 + 0.6 * Math.cos(lon)); else lat = Math.asin(r.range(-1, 1));
    if (r.next() < 0.12) { lon = r.gauss() * 0.35; lat = r.gauss() * 0.15; } // galactic bulge toward +x
    const R = 1;
    pos[i * 3] = R * Math.cos(lat) * Math.cos(lon); pos[i * 3 + 1] = R * Math.sin(lat); pos[i * 3 + 2] = -R * Math.cos(lat) * Math.sin(lon);
    const letter = r.pick(['M', 'K', 'K', 'G', 'F', 'A', 'B']), b = 0.25 + Math.pow(r.next(), 4) * 0.9;
    tmpC.copy(specColor(letter)).multiplyScalar(b);
    cls[i] = 'OBAFGKM'.indexOf(letter); bri[i] = b;
    col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
    size[i] = 0.8 + Math.pow(r.next(), 6) * 2.6;
  }
  const g = new THREE.Group();
  pts.scale.setScalar(5e5);
  g.add(pts);
  if (kind) explainSky(kind, { pts, cls, bri, seed }, observer ?? (() => ({ name: 'the Sun', x: 0, y: 0, z: 0, sol: true })));
  return g;
}

// ---------------------------------------------------------------- Universe

export class UniverseView implements View {
  level: Level = 'universe';
  group = new THREE.Group();
  limits: [number, number] = [8, 4000];
  private centres: { name: string; pos: THREE.Vector3; glow: THREE.Sprite }[] = [];
  private colonies = new Map<string, number>();

  constructor(world?: World) {
    const U = 1 / 10000; // 1 unit = 10,000 ly
    const G = 3; // galaxies drawn at three times true size so the Local Group reads as a map
    for (const [gi, gal] of GALAXIES.entries()) {
      const [x, y, z] = gal.name === 'Milky Way' ? GALACTIC_CENTRE : galToXYZ(gal.l, gal.b, gal.dist);
      const pos = toScene(x, y, z, U, GALACTIC_CENTRE[0] * 0 + 0).sub(toScene(GALACTIC_CENTRE[0], 0, 0, U));
      let obj: THREE.Object3D;
      if (gal.kind === 'spiral') {
        const R = gal.radius * U * G;
        // seen whole, each galaxy's stars pile up into a few hundred pixels (Andromeda nearly edge-on): keep each one faint
        const bright = gal.name === 'Andromeda' ? 0.34 : gal.name === 'Milky Way' ? 0.45 : 0.6;
        obj = makeGalaxy({ seed: gal.name.length * 31, count: gal.name === 'Milky Way' ? 90000 : gal.name === 'Andromeda' ? 120000 : 30000, radius: R, arms: gal.name === 'Triangulum' ? 2 : 4, pitch: gal.name === 'Andromeda' ? 9 : 13, bar: gal.name === 'Milky Way' ? 0.25 : 0.1, thickness: 0.03, sizeScale: R * 0.006, brightness: bright, core: 0.36 });
        if (gal.name === 'Andromeda') obj.rotation.set(1.35, 0.6, 0.2);
        if (gal.name === 'Triangulum') obj.rotation.set(0.9, -0.4, 0);
      } else {
        const R = gal.radius * U * G;
        obj = makeGalaxy({ seed: gal.name.length * 7, count: 12000, radius: R, arms: 1, pitch: 30, bar: 0.4, thickness: 0.2, sizeScale: R * 0.012, brightness: 0.5, dust: 0.05 });
        obj.rotation.set(0.7, 0.3, 0.4);
      }
      obj.position.copy(pos);
      this.group.add(obj);
      if (world) {
        // every particle is a star of that galaxy; pickable once the galaxy fills a good part of the view
        const centre = gal.name === 'Milky Way' ? GALACTIC_CENTRE : galToXYZ(gal.l, gal.b, gal.dist);
        const R = gal.radius * U * G, at = pos.clone();
        const real = ({ 'Milky Way': 2.5e11, Andromeda: 1e12, Triangulum: 4e10, 'Large Magellanic Cloud': 3e10, 'Small Magellanic Cloud': 3e9 } as Record<string, number>)[gal.name] ?? 1e10;
        const data = obj.userData.galaxy;
        explainGalaxy(world, {
          key: `u${gi}`, seed: 100 + gi, name: gal.name, data, obj, scaleLy: 1 / (U * G), centre: [centre[0], centre[1], centre[2]],
          starsPer: real / data.stars.geometry.attributes.position.count,
          enabled: (p) => R * pxPerUnit(p, p.camera.position.distanceTo(at)) > 140,
        });
      }
      const glow = glowSprite(0x7fe3ff, gal.radius * U * G * 2.2, 0);
      glow.position.copy(pos);
      this.group.add(glow);
      this.centres.push({ name: gal.name, pos, glow });
    }
    // background galaxies along a few cosmic-web filaments
    const r = new Rng(99);
    const texes = Array.from({ length: 8 }, (_, i) => galaxySpriteTex(i + 1));
    const bg: THREE.Sprite[] = [], bgTex: number[] = [];
    const nodes = Array.from({ length: 14 }, () => new THREE.Vector3(r.gauss(), r.gauss() * 0.6, r.gauss()).multiplyScalar(1600));
    for (let i = 0; i < 520; i++) {
      const a = r.pick(nodes), b = r.pick(nodes), t = r.next();
      const p = a.clone().lerp(b, t).add(new THREE.Vector3(r.gauss(), r.gauss(), r.gauss()).multiplyScalar(90));
      if (p.length() < 400) p.setLength(400 + r.next() * 300);
      const tex = r.pick(texes);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 + r.next() * 0.45, rotation: r.range(0, 6.28) }));
      s.position.copy(p);
      s.scale.setScalar(6 + Math.pow(r.next(), 3) * 30);
      this.group.add(s);
      bg.push(s); bgTex.push(texes.indexOf(tex) + 1);
    }
    explainBackground(this.group, bg, bgTex);
  }

  enter(ctx: Ctx): void {
    // frame the Milky Way and Andromeda together
    const m31 = this.centres.find((c) => c.name === 'Andromeda')!.pos;
    const mid = m31.clone().multiplyScalar(0.5);
    ctx.controls.target.copy(mid);
    ctx.camera.position.copy(mid).add(new THREE.Vector3(-m31.z, 0, m31.x).normalize().multiplyScalar(200)).add(new THREE.Vector3(0, 40, 0));
  }

  sync(ctx: Ctx): void {
    this.colonies.clear();
    const snap = ctx.snap;
    if (!snap) return;
    for (const b of snap.settled) {
      if (!alive(stageOf(snap, b))) continue;
      const g = ctx.world.systems[ctx.world.bodies[b].system].galaxy;
      this.colonies.set(g, (this.colonies.get(g) ?? 0) + 1);
    }
    for (const c of this.centres) {
      const n = this.colonies.get(c.name) ?? 0;
      (c.glow.material as THREE.SpriteMaterial).opacity = c.name === 'Milky Way' ? Math.min(0.22, n / 4000) : n > 0 ? 0.3 : 0;
    }
  }

  frame(): void {}

  pickables(): Pickable[] {
    return this.centres.map((c, i) => ({ pos: c.pos, kind: 'galaxy', id: i, name: c.name, r: GALAXIES[i].radius / 10000 * 3 * 0.6 }));
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    const sys = r.kind === 'system' ? r.id : r.kind === 'body' ? ctx.world.bodies[r.id].system : r.kind === 'city' ? ctx.world.bodies[ctx.body].system : -1;
    const name = r.kind === 'galaxy' ? r.name ?? this.centres[r.id]?.name : sys >= 0 ? ctx.world.systems[sys].galaxy : 'Milky Way';
    return this.centres.find((c) => c.name === name)?.pos ?? null;
  }

  diveDist(_ctx: Ctx, r: Ref): number {
    return r.kind === 'galaxy' && (r.name ?? this.centres[r.id]?.name) === 'Milky Way' ? 30 : 0;
  }

  labels(): Label[] {
    return this.centres.map((c) => {
      const n = this.colonies.get(c.name) ?? 0;
      return { pos: c.pos, text: c.name, sub: n ? `${fmtNum(n)} settlements` : 'untouched', strong: n > 0, ref: { kind: 'galaxy' as const, id: GALAXIES.findIndex((g) => g.name === c.name), name: c.name }, prio: c.name === 'Milky Way' ? 10 : c.name === 'Andromeda' ? 8 : 5 - c.pos.length() / 1000 };
    });
  }
}

// ---------------------------------------------------------------- Milky Way

export class GalaxyView implements View {
  level: Level = 'galaxy';
  group = new THREE.Group();
  limits: [number, number] = [4, 1800];
  private U = 1 / 100; // 1 unit = 100 ly
  private sol: THREE.Vector3;
  private bubble: THREE.Sprite;
  private ring: THREE.Mesh;
  private far: ReturnType<typeof pointCloud>;
  private farIds: number[] = [];
  private reach = 0;
  private trails = new Trails(6000, 400, 1.6);
  private nearIds: number[] = [];
  private near: ReturnType<typeof pointCloud>;
  private glow: THREE.Sprite;

  constructor(world: World) {
    const mw = makeGalaxy({ seed: 2040, count: 420000, radius: 500, arms: 4, pitch: 12, bar: 0.22, thickness: 0.018, sizeScale: 2.1, brightness: 0.82, dust: 0.3, core: 0.4 });
    this.group.add(mw);
    explainGalaxy(world, { key: 'g', seed: 1, name: 'Milky Way', data: mw.userData.galaxy, obj: mw, scaleLy: 100, centre: [GALACTIC_CENTRE[0], 0, 0], starsPer: 2.5e11 / 420000 });
    this.sol = toScene(0, 0, 0, this.U, GALACTIC_CENTRE[0]);
    this.sol.y = 0;
    this.bubble = glowSprite(0x7fe3ff, 6, 0.5, glowTex);
    this.bubble.position.copy(this.sol);
    this.group.add(this.bubble);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.copy(this.sol);
    this.group.add(this.ring);
    this.farIds = world.systems.filter((s) => s.region === 'galaxy').map((s) => s.id);
    this.far = pointCloud(this.farIds.length, pointsMaterial({ minPx: 1.5 }));
    this.farIds.forEach((id, i) => {
      const s = world.systems[id];
      const p = toScene(s.x, s.y, s.z, this.U, GALACTIC_CENTRE[0]);
      this.far.pos.set([p.x, p.y, p.z], i * 3);
    });
    this.group.add(this.far.pts);
    // humanity: every settled nearby system as a point, under a glow that grows with reach
    this.nearIds = world.systems.filter((s) => s.region === 'local' || s.region === 'sol').map((s) => s.id);
    this.near = pointCloud(this.nearIds.length, pointsMaterial({ minPx: 1.1, maxPx: 5 }));
    this.nearIds.forEach((id, i) => {
      const s = world.systems[id];
      const p = toScene(s.x, s.y, s.z, this.U, GALACTIC_CENTRE[0]);
      this.near.pos.set([p.x, p.y, p.z], i * 3);
    });
    this.group.add(this.near.pts);
    // a settled nearby system drawn at galaxy scale is that system
    registerExplainer('neargal', {
      obj: this.near.pts, explain: () => ({ eyebrow: '', title: '', lede: '', facts: [] }),
      name: (i, c) => c.world.systems[this.nearIds[i]].name,
      locate: (i, out) => pointWorld(this.near.pts, i, out),
      selectAs: (i, c) => ({ kind: 'system', id: this.nearIds[i], name: c.world.systems[this.nearIds[i]].name }),
    });
    addGpuSet({ kind: 'neargal', points: this.near.pts, prio: 6, minLum: 0.02, pickPx: 6 });
    this.glow = glowSprite(0x7fe3ff, 8, 0);
    this.glow.position.copy(this.sol);
    this.group.add(this.glow);
    this.trails.addTo(this.group);
    this.trails.explain('shipg');
  }

  enter(ctx: Ctx): void {
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(this.sol.x * 0.6, 520, this.sol.z + 640);
  }

  sync(ctx: Ctx): void {
    const snap = ctx.snap;
    let reach = 0;
    if (snap) {
      for (const b of snap.settled) {
        const s = ctx.world.systems[ctx.world.bodies[b].system];
        if (s.region === 'local' && alive(stageOf(snap, b))) reach = Math.max(reach, s.dist);
      }
    }
    this.reach = reach;
    const r = Math.max(reach * this.U, 0.6);
    this.ring.scale.setScalar(r);
    this.bubble.scale.setScalar(Math.max(3, r * 4));
    this.farIds.forEach((id, i) => {
      const sum = systemSummary(ctx.world, snap, id);
      const on = alive(sum.stage);
      if (on) modeColor(ctx, sum, tmpC); else tmpC.set(0x000000);
      this.far.col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      this.far.size[i] = on ? 3 + Math.log10(1 + sum.pop) * 0.5 : 0;
    });
    dirty(this.far.pts);
    let n = 0;
    this.nearIds.forEach((id, i) => {
      const sum = systemSummary(ctx.world, snap, id);
      const on = alive(sum.stage);
      if (on) { n++; modeColor(ctx, sum, tmpC).lerp(WHITE, 0.25); } else tmpC.set(0x000000);
      this.near.col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      this.near.size[i] = on ? 1.5 + Math.log10(1 + sum.pop) * 0.35 : 0;
    });
    dirty(this.near.pts);
    this.glow.scale.setScalar(16 + reach * this.U * 14);
    (this.glow.material as THREE.SpriteMaterial).opacity = n ? Math.min(0.75, 0.2 + 0.15 * Math.log10(1 + n)) : 0;
  }

  frame(ctx: Ctx): void {
    this.group.rotation.y = 0;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.2 * Math.sin(ctx.t * 2);
    this.drawShips(ctx);
  }

  /** FTL voyages arc above the disc; slower-than-light ones are short hops inside the bubble. */
  private drawShips(ctx: Ctx): void {
    const t = this.trails, w = ctx.world;
    t.begin();
    for (const sh of ctx.snap?.ships ?? []) {
      const a = w.systems[w.bodies[sh.from].system], b = w.systems[w.bodies[sh.to].system];
      const pa = toScene(a.x, a.y, a.z, this.U, GALACTIC_CENTRE[0]), pb = toScene(b.x, b.y, b.z, this.U, GALACTIC_CENTRE[0]);
      const f = Math.min(1, Math.max(0, (ctx.year - sh.depart) / Math.max(0.1, sh.arrive - sh.depart)));
      const st = shipStyle(ctx.snap, sh), c = st.trail;
      const lift = sh.kind === 1 ? pa.distanceTo(pb) * 0.18 : 0;
      const N = sh.kind === 1 ? 32 : 1, id = shipId(sh);
      const at = (u: number, out: THREE.Vector3) => out.lerpVectors(pa, pb, u).setY(out.y + lift * 4 * u * (1 - u));
      for (let k = 0; k < N; k++) {
        const u0 = k / N, u1 = (k + 1) / N;
        // brighter just behind the ship, faint ahead of it
        const w0 = u0 <= f ? 0.15 + 0.6 * Math.pow(u0 / Math.max(f, 1e-3), 3) : 0.07, w1 = u1 <= f ? 0.15 + 0.6 * Math.pow(u1 / Math.max(f, 1e-3), 3) : 0.07;
        t.seg(at(u0, tv1), at(u1, tv2), c, w0, w1, id);
      }
      at(f, tv3);
      if (st.plume > 0 && sh.kind !== 1) t.seg(at(Math.max(0, f - 0.04), tv1), tv3, st.head, 0, st.plume, id);
      if (st.beam) t.seg(pa, tv3, BEAM, 0.35, 0.08, id);
      if (st.scoop) t.head(tv3, SCOOP, 6, id);
      t.head(tv3, st.head, sh.kind === 1 ? 5 + Math.sin(ctx.t * 5) : 2.5 * st.headSize, id);
    }
    t.end();
  }

  pickables(ctx: Ctx): Pickable[] {
    const out: Pickable[] = [{ pos: this.sol, kind: 'humanspace', id: 0, name: 'Human space' }];
    this.farIds.forEach((id, i) => {
      if (this.far.size[i] > 0) out.push({ pos: new THREE.Vector3(this.far.pos[i * 3], this.far.pos[i * 3 + 1], this.far.pos[i * 3 + 2]), kind: 'system', id, name: ctx.world.systems[id].name, weight: 4 });
    });
    return out;
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'humanspace') return this.sol;
    if (r.kind === 'galaxy') return (r.name ?? GALAXIES[r.id]?.name) === 'Milky Way' ? new THREE.Vector3() : null;
    const sys = r.kind === 'system' ? r.id : r.kind === 'body' ? ctx.world.bodies[r.id].system : ctx.world.bodies[ctx.body].system;
    const s = ctx.world.systems[sys];
    if (s.galaxy !== 'Milky Way') return null;
    const p = toScene(s.x, s.y, s.z, this.U, GALACTIC_CENTRE[0]);
    if (s.region !== 'galaxy') p.y = 0;
    return p;
  }

  diveDist(ctx: Ctx, r: Ref): number {
    return r.kind === 'humanspace' ? 30 : r.kind === 'system' && ctx.world.systems[r.id].region === 'galaxy' ? 5 : 0;
  }

  labels(): Label[] {
    return [
      { pos: this.sol, text: 'Human space', sub: this.reach > 0 ? `${fmtNum(this.reach)} ly across the dark` : 'one star system', strong: true, ref: { kind: 'humanspace', id: 0 }, prio: 10 },
      // lifted clear of the bulge so it reads against the dark, not the core
      { pos: new THREE.Vector3(0, 75, 0), text: 'Sagittarius A*', sub: '26,000 ly', ref: { kind: 'thing', id: 0, ex: 'coreg', name: 'Sagittarius A*' } },
    ];
  }
}

// ---------------------------------------------------------------- Local neighbourhood

export class LocalView implements View {
  level: Level = 'local';
  group = new THREE.Group();
  limits: [number, number] = [2, 1400];
  private ids: number[];
  private stars: ReturnType<typeof pointCloud>;
  private shipLines: THREE.LineSegments;
  private shipHeads: ReturnType<typeof pointCloud>;
  private base: Float32Array;
  private spec: Float32Array;
  private sums: SystemSum[] = [];
  private ranked: Label[] = [];
  private rankedFor: SystemSum[] | null = null;
  private shipIds: number[] = [];      // ship id per line segment
  private shipHeadIds: number[] = [];  // ship id per head point
  private shipAt = new Map<number, THREE.Vector3>();

  constructor(world: World) {
    this.ids = world.systems.filter((s) => s.region === 'local' || s.region === 'sol').map((s) => s.id);
    this.stars = pointCloud(this.ids.length, pointsMaterial({ minPx: 1.1 }));
    this.base = new Float32Array(this.ids.length * 3);
    this.spec = new Float32Array(this.ids.length * 3);
    this.ids.forEach((id, i) => {
      const s = world.systems[id];
      const p = toScene(s.x, s.y, s.z);
      this.stars.pos.set([p.x, p.y, p.z], i * 3);
      tmpC.copy(specColor(s.spec));
      this.spec.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      tmpC.multiplyScalar(s.real ? 0.9 : 0.55);
      this.base.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    });
    this.group.add(this.stars.pts);
    // distance rings in the galactic plane
    const rings = new THREE.Group();
    this.group.add(rings);
    explainLocalRings('lring', rings, [10, 50, 100, 250, 500, 900]);
    for (const R of [10, 50, 100, 250, 500, 900]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.998, R, 160), new THREE.MeshBasicMaterial({ color: 0x9aa4b4, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      rings.add(ring);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4096 * 6), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4096 * 6), 3));
    this.shipLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.shipLines.frustumCulled = false;
    this.group.add(this.shipLines);
    this.shipHeads = pointCloud(4096, pointsMaterial({ minPx: 2 }));
    this.group.add(this.shipHeads.pts);
    explainShips('shipl', { heads: this.shipHeads.pts, headIds: this.shipHeadIds, lines: this.shipLines, segIds: this.shipIds, segCount: () => this.shipIds.length, at: this.shipAt });
    const sun = glowSprite(0xfff1d6, 1.6, 1, flareTex);
    this.group.add(sun);
  }

  enter(ctx: Ctx): void {
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(14, 22, 48);
  }

  sync(ctx: Ctx): void {
    const snap = ctx.snap;
    this.sums = this.ids.map((id) => systemSummary(ctx.world, snap, id));
    this.ids.forEach((_, i) => {
      const s = this.sums[i];
      if (alive(s.stage)) {
        modeColor(ctx, s, tmpC).lerp(tmpC2.setRGB(this.spec[i * 3], this.spec[i * 3 + 1], this.spec[i * 3 + 2]), 0.55).multiplyScalar(1.1);
        this.stars.size[i] = 2.2 + Math.log10(1 + s.pop) * 0.55;
      } else if (s.stage === STAGE.SURVEY) {
        tmpC.set(STAGE_COLORS[0]).multiplyScalar(ctx.colorBy === 'stage' ? 1.6 : 0.9);
        this.stars.size[i] = 1.6;
      } else if (s.stage >= STAGE.ABANDONED) {
        tmpC.set(STAGE_COLORS[s.stage]);
        this.stars.size[i] = 1.4;
      } else {
        tmpC.setRGB(this.base[i * 3], this.base[i * 3 + 1], this.base[i * 3 + 2]);
        this.stars.size[i] = 0.9;
      }
      this.stars.col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    });
    dirty(this.stars.pts);
    this.frame(ctx);
  }

  frame(ctx: Ctx): void {
    const snap = ctx.snap;
    const pos = this.shipLines.geometry.attributes.position.array as Float32Array;
    const col = this.shipLines.geometry.attributes.color.array as Float32Array;
    let n = 0;
    this.shipIds.length = 0; this.shipHeadIds.length = 0;
    if (this.shipAt.size > 8192) this.shipAt.clear();
    if (snap) {
      let h = 0;
      for (const sh of snap.ships) {
        if (n >= 4093 || h >= 4094 || sh.kind === 1) continue;
        const id = shipId(sh);
        const a = ctx.world.systems[ctx.world.bodies[sh.from].system], b = ctx.world.systems[ctx.world.bodies[sh.to].system];
        const pa = toScene(a.x, a.y, a.z), pb = toScene(b.x, b.y, b.z);
        // route and ship look follow the drive known when it left; generation ships trail amber
        const st = shipStyle(snap, sh), tc = st.trail, hc = st.head;
        pos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], n * 6);
        col.set([tc.r * 0.15, tc.g * 0.15, tc.b * 0.15, tc.r * 0.6, tc.g * 0.6, tc.b * 0.6], n * 6);
        this.shipIds[n] = id;
        n++;
        const f = Math.min(1, Math.max(0, (ctx.year - sh.depart) / (sh.arrive - sh.depart)));
        const hp = tv3.lerpVectors(pa, pb, f);
        (this.shipAt.get(id) ?? this.shipAt.set(id, new THREE.Vector3()).get(id)!).copy(hp);
        if (st.plume > 0) {
          const tail = tv1.lerpVectors(pa, pb, Math.max(0, f - 0.12));
          pos.set([tail.x, tail.y, tail.z, hp.x, hp.y, hp.z], n * 6);
          col.set([0, 0, 0, hc.r * 1.3 * st.plume, hc.g * 1.3 * st.plume, hc.b * 1.3 * st.plume], n * 6);
          this.shipIds[n] = id;
          n++;
        }
        if (st.beam) {
          pos.set([pa.x, pa.y, pa.z, hp.x, hp.y, hp.z], n * 6);
          col.set([BEAM.r * 0.9, BEAM.g * 0.9, BEAM.b * 0.9, BEAM.r * 0.2, BEAM.g * 0.2, BEAM.b * 0.2], n * 6);
          this.shipIds[n] = id;
          n++;
        }
        if (st.scoop) {
          this.shipHeadIds[h] = id;
          this.shipHeads.pos.set([hp.x, hp.y, hp.z], h * 3);
          this.shipHeads.col.set([SCOOP.r * 0.5, SCOOP.g * 0.5, SCOOP.b * 0.5], h * 3);
          this.shipHeads.size[h++] = 5;
        }
        this.shipHeadIds[h] = id;
        this.shipHeads.pos.set([hp.x, hp.y, hp.z], h * 3);
        this.shipHeads.col.set([hc.r, hc.g, hc.b], h * 3);
        this.shipHeads.size[h++] = (1.6 + 0.4 * Math.sin(ctx.t * 4 + n)) * st.headSize;
      }
      this.shipHeads.pts.geometry.setDrawRange(0, h);
    } else this.shipHeads.pts.geometry.setDrawRange(0, 0);
    this.shipLines.geometry.setDrawRange(0, n * 2);
    this.shipLines.geometry.attributes.position.needsUpdate = true;
    this.shipLines.geometry.attributes.color.needsUpdate = true;
    dirty(this.shipHeads.pts);
  }

  private picks: Pickable[] | null = null;
  pickables(ctx: Ctx): Pickable[] {
    this.picks ??= this.ids.map((id, i) => ({ pos: new THREE.Vector3(this.stars.pos[i * 3], this.stars.pos[i * 3 + 1], this.stars.pos[i * 3 + 2]), kind: 'system' as const, id, name: ctx.world.systems[id].name }));
    this.picks.forEach((p, i) => { const s = this.sums[i]; p.weight = s && alive(s.stage) ? 8 : ctx.world.systems[p.id].real ? 5 : 0; });
    return this.picks;
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'humanspace' || r.kind === 'galaxy') return new THREE.Vector3();
    const sys = r.kind === 'system' ? r.id : r.kind === 'body' ? ctx.world.bodies[r.id].system : ctx.world.bodies[ctx.body].system;
    const s = ctx.world.systems[sys];
    return s.region === 'local' || s.region === 'sol' ? toScene(s.x, s.y, s.z) : null;
  }

  diveDist(_ctx: Ctx, r: Ref): number { return r.kind === 'system' ? 5 : 0; }

  labels(ctx: Ctx): Label[] {
    const out: Label[] = [];
    const cam = ctx.camera.position;
    // ranking only changes with the year; recompute on sync, not per frame
    if (this.rankedFor !== this.sums) {
      this.rankedFor = this.sums;
      this.ranked = this.ids
        .map((id, i) => ({ id, i, s: this.sums[i] }))
        .filter((x) => x.s && (alive(x.s.stage) || ctx.world.systems[x.id].real))
        .sort((a, b) => (b.s.pop - a.s.pop) || (ctx.world.systems[a.id].dist - ctx.world.systems[b.id].dist))
        .slice(0, 120)
        .map((r) => {
          const sys = ctx.world.systems[r.id], on = alive(r.s.stage);
          return {
            pos: new THREE.Vector3(this.stars.pos[r.i * 3], this.stars.pos[r.i * 3 + 1], this.stars.pos[r.i * 3 + 2]),
            text: sys.name, sub: on ? `${STAGE_NAMES[r.s.stage]} · ${fmtNum(r.s.pop)}` : `${sys.dist.toFixed(1)} ly`, strong: on,
            ref: { kind: 'system' as const, id: r.id }, prio: on ? 10 + Math.log10(1 + r.s.pop) : 6 - sys.dist / 10,
          };
        });
    }
    for (const l of this.ranked) if (l.pos.distanceTo(cam) < 900) out.push(l);
    return out;
  }
}

// ---------------------------------------------------------------- Star system

interface BodyVis { id: number; mesh: THREE.Mesh; orbitR: number; parent: number; phase: number; marker: THREE.Sprite; visR: number }

// real orbital ranges of the main-belt families the named asteroids belong to, AU
const SOL_FAMILY: Record<string, [number, number]> = { Vesta: [2.26, 2.48], Psyche: [2.85, 3.0], Hygiea: [3.06, 3.24] };

const hazeOf = (b: Body) => (b.name === 'Titan' || b.name === 'Venus' ? 1 : 0);

export function bodyVisRadius(b: Body): number {
  return Math.max(0.18, 0.35 + 0.6 * Math.log10(Math.max(b.radius, 20) / 400));
}

export class SystemView implements View {
  level: Level = 'system';
  group = new THREE.Group();
  limits: [number, number] = [1.5, 900];
  private vis: BodyVis[] = [];
  private builtFor = -1;
  private star!: THREE.Group;
  private starR = 1;
  private swarm: ReturnType<typeof pointCloud> | null = null;
  private works = new StarWorks();
  private trails = new Trails(512, 512, 1.8);
  private edge = 60;
  private rings: { mesh: THREE.Mesh; body: number }[] = [];
  private belts = 0;

  enter(ctx: Ctx): void {
    this.build(ctx);
    const far = Math.max(40, ...this.vis.filter((v) => v.parent < 0).map((v) => v.orbitR));
    this.limits = [1.5, far * 2.4];
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(far * 0.25, far * 0.55, far * 1.05);
  }

  private build(ctx: Ctx): void {
    if (this.builtFor === ctx.system) return;
    this.builtFor = ctx.system;
    this.group.clear();
    this.vis = []; this.rings = []; this.belts = 0;
    const sys = ctx.world.systems[ctx.system];
    // star
    this.star = new THREE.Group();
    const sc = specColor(sys.spec);
    const lumR = Math.min(3.2, 1.1 + 0.35 * Math.log10(sys.lum + 0.01));
    this.starR = Math.max(0.6, lumR);
    const core = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.6, lumR), 48, 24), new THREE.MeshBasicMaterial({ color: sc.clone().multiplyScalar(2.2) }));
    this.star.add(core);
    this.star.add(glowSprite(sc.getHex(), lumR * 9, 0.9));
    this.star.add(glowSprite(sc.getHex(), lumR * 26, 0.35, flareTex));
    this.group.add(this.star);
    this.works.reset();
    this.group.add(makeSky(sys.id + 3, 9000, 'skys', () => ({ name: sys.name, x: sys.x, y: sys.y, z: sys.z, sol: sys.id === 0 })));

    const planets = sys.bodies.map((id) => ctx.world.bodies[id]).filter((b) => b.parent < 0).sort((a, b) => a.a - b.a);
    const a0 = planets[0]?.a ?? 1;
    planets.forEach((b, i) => {
      const orbitR = 7 + lumR * 2 + i * 6.5 + 5 * Math.log2(b.a / a0 + 1);
      this.addBody(ctx, b, orbitR, -1, i);
      const orbit = new THREE.Mesh(new THREE.RingGeometry(orbitR - 0.02, orbitR + 0.02, 256), new THREE.MeshBasicMaterial({ color: 0x9aa4b4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      orbit.rotation.x = -Math.PI / 2;
      this.group.add(orbit);
      if (b.kind === 'asteroid' && b.a > 0) {
        const fam = SOL_FAMILY[b.name];
        this.addBelt(ctx.world, orbitR, b.id, { sys: sys.id, members: [b.id], label: sys.id === 0 ? `${b.name} family of the main belt` : `belt of ${b.name}`, au: fam ?? [+(b.a * 0.92).toFixed(2), +(b.a * 1.08).toFixed(2)], icy: b.temp < 120, count: sys.id === 0 ? 15000 : 1e5 });
      }
    });
    // moons
    const moonsOf = new Map<number, Body[]>();
    for (const id of sys.bodies) { const b = ctx.world.bodies[id]; if (b.parent >= 0) moonsOf.set(b.parent, [...(moonsOf.get(b.parent) ?? []), b]); }
    for (const [p, ms] of moonsOf) {
      const pv = this.vis.find((v) => v.id === p)!;
      ms.sort((a, b) => a.a - b.a).forEach((m, j) => this.addBody(ctx, m, pv.visR * 1.8 + 0.8 + j * 0.9, p, j));
    }
    if (sys.id === 0) {
      const id = (n: string) => ctx.world.bodies.findIndex((b) => b.name === n && b.system === 0);
      this.addBelt(ctx.world, this.vis.find((v) => ctx.world.bodies[v.id].name === 'Ceres')!.orbitR, 1, { sys: 0, members: ['Ceres', 'Vesta', 'Psyche', 'Hygiea'].map(id), label: 'main belt', au: [2.1, 3.3], icy: false, count: 1.2e6 }, 2600);
      this.addBelt(ctx.world, this.vis.find((v) => ctx.world.bodies[v.id].name === 'Pluto')!.orbitR, 2, { sys: 0, members: ['Pluto', 'Haumea', 'Eris'].map(id), label: 'Kuiper belt', au: [30, 50], icy: true, count: 1e5 }, 3500, 5);
    }
    explainOrbits('orbit', this.group, () => this.vis.filter((v) => v.parent < 0).map((v) => ({ body: v.id, r: v.orbitR })), () => this.builtFor);
    explainRings('pring', this.group, () => this.rings);
    this.swarm = null;
    this.edge = Math.max(40, ...this.vis.map((v) => v.orbitR)) * 1.35;
    this.trails.addTo(this.group);
    this.trails.explain('shipy');
    explainWorks('starw', this.group, () => this.star.children, () => ({ body: -1, sys: this.builtFor }), 1);
  }

  private addBelt(world: World, R: number, seed: number, info: Omit<BeltInfo, 'centreR' | 'width'>, n = 1600, width = 2.2): void {
    const r = new Rng(seed * 17);
    const { pts, pos, col, size } = pointCloud(n, pointsMaterial({ minPx: 0.6 }));
    for (let i = 0; i < n; i++) {
      const th = r.range(0, Math.PI * 2), rr = R + r.gauss() * width * 0.5;
      pos.set([Math.cos(th) * rr, r.gauss() * 0.25, Math.sin(th) * rr], i * 3);
      const v = 0.25 + r.next() * 0.35;
      col.set([v, v * 0.92, v * 0.85], i * 3);
      size[i] = 0.25 + r.next() * 0.4;
    }
    this.group.add(pts);
    explainBelt(`belt${this.belts++}`, pts, { ...info, centreR: R, width }, world);
  }

  private addBody(ctx: Ctx, b: Body, orbitR: number, parent: number, i: number): void {
    const visR = parent >= 0 ? bodyVisRadius(b) * 0.45 : bodyVisRadius(b);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(visR, 48, 32), planetMaterial(b.kind, b.color, b.id, hazeOf(b)));
    if (b.kind === 'asteroid') mesh.scale.set(1, 0.75, 0.85);
    this.group.add(mesh);
    if (b.kind === 'gas' && (b.name === 'Saturn' || hash01(b.id, 5) < 0.4)) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(visR * 1.35, visR * 2.3, 96), new THREE.MeshBasicMaterial({ color: 0xd8c39a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2 + 0.45;
      mesh.add(ring);
      this.rings.push({ mesh: ring, body: b.id });
    }
    if (b.kind === 'ocean' || b.kind === 'gas' || b.kind === 'icegiant' || b.name === 'Titan' || b.name === 'Venus') {
      const atm = new THREE.Mesh(new THREE.SphereGeometry(visR * 1.12, 48, 32), atmosphereMaterial(b.kind === 'ocean' ? 0x5aa0ff : b.color));
      mesh.add(atm);
    }
    const marker = glowSprite(0xffffff, visR * 5, 0);
    this.group.add(marker);
    this.vis.push({ id: b.id, mesh, orbitR, parent, phase: hash01(b.id, i) * Math.PI * 2, marker, visR });
    void ctx;
  }

  sync(ctx: Ctx): void {
    this.build(ctx);
    let mega = false, top = -1;
    for (const v of this.vis) {
      const st = stageOf(ctx.snap, v.id);
      const m = v.marker.material as THREE.SpriteMaterial;
      if (alive(st)) {
        m.color.set(STAGE_COLORS[st]); m.opacity = 0.55;
        v.marker.scale.setScalar(v.visR * (3 + st * 0.6));
        if (tierRank(st) >= 2) mega = true;
        if (tierRank(st) > tierRank(top)) top = st;
      } else m.opacity = st === STAGE.SURVEY ? 0.15 : 0;
      applyPlanetLook(v.mesh, ctx.snap, v.id, ctx.year, alive(st) ? cityLights(popOf(ctx.snap, v.id)) : 0);
      lightCities(v.mesh.material as THREE.ShaderMaterial, v.id, st, popOf(ctx.snap, v.id));
    }
    // Dyson swarm: shimmer of collectors around a star with a megastructure
    if (mega && !this.swarm) {
      const n = 9000, r = new Rng(ctx.system);
      this.swarm = pointCloud(n, pointsMaterial({ minPx: 0.7 }));
      for (let i = 0; i < n; i++) {
        const th = r.range(0, Math.PI * 2), ph = Math.acos(r.range(-1, 1)), R = 4.2 + r.next() * 1.4;
        this.swarm.pos.set([R * Math.sin(ph) * Math.cos(th), R * Math.cos(ph), R * Math.sin(ph) * Math.sin(th)], i * 3);
        this.swarm.col.set([1, 0.78, 0.4], i * 3);
        this.swarm.size[i] = 0.12 + r.next() * 0.2;
      }
      this.group.add(this.swarm.pts);
      explainSwarm('swarm', this.swarm.pts, ctx.system, ctx.world);
    } else if (!mega && this.swarm) { this.group.remove(this.swarm.pts); this.swarm = null; }
    this.works.sync(this.star, this.starR, top);
    if (this.swarm) this.swarm.pts.visible = !this.works.brain;
  }

  frame(ctx: Ctx): void {
    const yr = ctx.year + ctx.tm * 0.04;
    for (const v of this.vis) {
      const b = ctx.world.bodies[v.id];
      if (v.parent < 0) {
        const ang = v.phase + (2 * Math.PI * yr) / Math.max(b.period, 0.05);
        v.mesh.position.set(Math.cos(ang) * v.orbitR, 0, -Math.sin(ang) * v.orbitR);
      } else {
        const pv = this.vis.find((x) => x.id === v.parent)!;
        const ang = v.phase + (2 * Math.PI * yr * 365) / Math.max(b.period, 0.5) / 40;
        v.mesh.position.set(pv.mesh.position.x + Math.cos(ang) * v.orbitR, 0, pv.mesh.position.z - Math.sin(ang) * v.orbitR);
      }
      v.mesh.rotation.y = ctx.tm * 0.1;
      const sun = v.mesh.position.clone().negate().normalize();
      (v.mesh.material as THREE.ShaderMaterial).uniforms.uSun.value.copy(sun);
      for (const c of v.mesh.children) { const u = ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms; if (u?.uSun) u.uSun.value.copy(sun); }
      (v.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.t;
      v.marker.position.copy(v.mesh.position);
    }
    if (this.swarm) this.swarm.pts.rotation.y = ctx.tm * 0.03;
    this.works.frame(ctx.tm, REDUCED_MOTION);
    this.drawShips(ctx);
  }

  /** Interstellar ships leaving or reaching this system: a trail from the world to the edge, toward the other star, with motes flowing along it. */
  private drawShips(ctx: Ctx): void {
    const t = this.trails, w = ctx.world, here = w.systems[this.builtFor];
    t.begin();
    let i = 0;
    // the 48 most recent departures and nearest arrivals; more is a hairball
    const mine = (ctx.snap?.ships ?? []).filter((sh) => (w.bodies[sh.from].system === this.builtFor) !== (w.bodies[sh.to].system === this.builtFor));
    const near = (sh: (typeof mine)[number]) => (w.bodies[sh.from].system === this.builtFor ? ctx.year - sh.depart : sh.arrive - ctx.year);
    for (const sh of mine.sort((a, b) => near(a) - near(b)).slice(0, 48)) {
      const fs = w.bodies[sh.from].system, ts = w.bodies[sh.to].system;
      const out = fs === this.builtFor;
      const v = this.vis.find((x) => x.id === (out ? sh.from : sh.to));
      if (!v) continue;
      const o = w.systems[out ? ts : fs];
      const dir = toScene(o.x - here.x, o.y - here.y, o.z - here.z);
      dir.y *= 0.25; // keep routes near the orbital plane so they read against it
      dir.normalize();
      const body = v.mesh.position, far = tv1.copy(dir).multiplyScalar(Math.min(this.edge * 0.5, 22)).add(body);
      const a = out ? body : far, b = out ? far : body;
      const st = shipStyle(ctx.snap, sh), c = st.trail, id = shipId(sh);
      t.seg(a, b, c, out ? 0.22 : 0, out ? 0 : 0.22, id);
      if (st.beam && out) t.seg(a, b, BEAM, 0.5, 0.1, id);
      for (let k = 0; k < 3; k++) {
        const u = (ctx.t * 0.06 * st.speed + k / 3 + hash01(i, 3)) % 1;
        const fade = out ? 1 - u : u;
        t.head(tv2.lerpVectors(a, b, u), tmpC.copy(k === 0 ? st.head : c).multiplyScalar(0.2 + 0.6 * fade), (0.4 + 0.7 * fade) * st.headSize, id);
      }
      i++;
    }
    t.end();
  }

  pickables(ctx: Ctx): Pickable[] {
    const star: Pickable = { pos: new THREE.Vector3(), kind: 'system', id: this.builtFor, name: ctx.world.systems[this.builtFor].name, weight: 2, r: this.starR };
    return [star, ...this.vis.map((v) => ({ pos: v.mesh.position.clone(), kind: 'body' as const, id: v.id, name: ctx.world.bodies[v.id].name, weight: alive(stageOf(ctx.snap, v.id)) ? 6 : v.parent < 0 ? 3 : 0 }))];
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'system') return r.id === this.builtFor ? new THREE.Vector3() : null;
    const id = r.kind === 'body' ? r.id : r.kind === 'city' ? ctx.body : -1;
    return this.vis.find((v) => v.id === id)?.mesh.position ?? null;
  }

  size(_ctx: Ctx, r: Ref): number {
    if (r.kind === 'system') return this.starR * 1.3;
    return (this.vis.find((x) => x.id === r.id)?.visR ?? 0) * 1.5;
  }

  diveDist(_ctx: Ctx, r: Ref): number {
    const v = r.kind === 'body' ? this.vis.find((x) => x.id === r.id) : undefined;
    return v ? Math.max(1.6, v.visR * 7) : 0;
  }

  labels(ctx: Ctx): Label[] {
    return this.vis.filter((v) => v.parent < 0 || alive(stageOf(ctx.snap, v.id)) || v.visR > 0.3).map((v) => {
      const st = stageOf(ctx.snap, v.id);
      const b = ctx.world.bodies[v.id];
      return {
        pos: v.mesh.position.clone().add(new THREE.Vector3(0, v.visR + 0.2, 0)),
        text: b.name,
        sub: alive(st) ? `${STAGE_NAMES[st]} · ${fmtNum(popOf(ctx.snap, v.id))}` : st === STAGE.SURVEY ? 'surveyed' : st >= STAGE.ABANDONED ? STAGE_NAMES[st].toLowerCase() : undefined,
        strong: alive(st),
        ref: { kind: 'body' as const, id: v.id },
        prio: alive(st) ? 10 + Math.log10(1 + popOf(ctx.snap, v.id)) : v.parent < 0 ? 5 + v.visR : v.visR,
      };
    });
  }
}

// ---------------------------------------------------------------- Planet

export class PlanetView implements View {
  level: Level = 'planet';
  group = new THREE.Group();
  limits: [number, number] = [11.5, 160];
  private builtFor = -1;
  private planet!: THREE.Mesh;
  private cities: ReturnType<typeof pointCloud> | null = null;
  private cityPos: THREE.Vector3[] = [];
  private works = new Orbitals();
  private sun: THREE.Sprite | null = null;
  private starCol = new THREE.Color();
  private pivot = new THREE.Group();
  private orbit = new THREE.Group();
  private sats: ReturnType<typeof pointCloud> | null = null;
  private elevators: THREE.Group[] = [];
  private elevSince = -1;
  private cityKey = ''; private satKey = -1; private elevKey = -1; private archKey = '';
  private arch: THREE.InstancedMesh | null = null;
  private prings: { mesh: THREE.Mesh; body: number }[] = [];

  enter(ctx: Ctx): void {
    this.build(ctx);
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(12, 7, 26);
  }

  private build(ctx: Ctx): void {
    if (this.builtFor === ctx.body) return;
    this.builtFor = ctx.body;
    this.group.clear();
    this.pivot = new THREE.Group();
    const b = ctx.world.bodies[ctx.body];
    const R = 10;
    const mat = planetMaterial(b.kind, b.color, b.id, hazeOf(b));
    mat.uniforms.uDetail.value = 1.6;
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), mat);
    if (b.kind === 'asteroid') this.planet.scale.set(1, 0.72, 0.86);
    this.pivot.add(this.planet);
    if (b.kind !== 'asteroid' && b.kind !== 'dwarf') {
      // airless worlds get a black (invisible) shell that turns blue if they are ever terraformed
      const airless = b.kind === 'moon' || b.kind === 'rocky';
      this.planet.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.05, 96, 64), atmosphereMaterial(airless ? 0x000000 : b.kind === 'ocean' ? 0x5aa0ff : b.color)));
    }
    if (b.kind === 'gas' && (b.name === 'Saturn' || hash01(b.id, 5) < 0.4)) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.35, R * 2.3, 160), new THREE.MeshBasicMaterial({ color: 0xd8c39a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2 + 0.3;
      this.pivot.add(ring);
      this.prings = [{ mesh: ring, body: b.id }];
    } else this.prings = [];
    explainRings('pringp', this.group, () => this.prings);
    this.group.add(this.pivot);
    const home = ctx.world.systems[b.system];
    this.group.add(makeSky(b.id, 9000, 'skyp', () => ({ name: b.name, x: home.x, y: home.y, z: home.z, sol: home.id === 0 })));
    const sys = ctx.world.systems[b.system];
    const sun = (this.sun = glowSprite(specColor(sys.spec).getHex(), 60, 0.9, flareTex));
    this.starCol.copy(specColor(sys.spec));
    sun.position.copy(PLANET_SUN);
    this.group.add(sun);
    // the star in this world's sky is its system
    registerExplainer('sunp', {
      obj: sun, explain: () => ({ eyebrow: '', title: '', lede: '', facts: [] }),
      name: () => `${sys.name}, the star ${b.name} circles`,
      locate: (_i, out) => sun.getWorldPosition(out),
      selectAs: () => ({ kind: 'system', id: sys.id, name: sys.name }),
    });
    addCpuSet({ kind: 'sunp', obj: sun, prio: 3, hit: (p) => nearestPoint(1, (_i, out) => sun.getWorldPosition(out), p, () => 26) });
    mat.uniforms.uSun.value.copy(sun.position).normalize();
    for (const c of this.planet.children) { const u = ((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms; if (u?.uSun) u.uSun.value.copy(sun.position).normalize(); }
    // habitats and the ring world are lit by the star; the planet itself uses its own shader
    const light = new THREE.DirectionalLight(specColor(sys.spec), 2.0);
    light.position.copy(sun.position);
    this.group.add(light, new THREE.AmbientLight(0x404a5a, 0.35));
    this.orbit = new THREE.Group();
    this.group.add(this.orbit);
    explainElevators('elev', this.pivot, () => this.elevators, () => this.builtFor);
    explainWorks('work', this.group, () => this.works.works, () => ({ body: this.builtFor, sys: ctx.world.bodies[this.builtFor].system }));
    this.cities = null; this.works.reset(); this.sats = null; this.elevators = [];
    this.cityKey = ''; this.satKey = -1; this.elevKey = -1; this.archKey = ''; this.arch = null;
  }

  sync(ctx: Ctx): void {
    this.build(ctx);
    const b = ctx.body;
    const st = stageOf(ctx.snap, b), pop = popOf(ctx.snap, b);
    applyPlanetLook(this.planet, ctx.snap, b, ctx.year, alive(st) ? cityLights(pop) : 0);
    lightCities(this.planet.material as THREE.ShaderMaterial, b, st, pop);
    // the society's architecture (from the worker, when it has one): its colour, height, curves, crowding and glow
    const look = alive(st) ? societyLook(b) : null;
    applyCultureLights(this.planet, look);
    // cities: one marker per ~stage, positions stable per body
    const nCities = cityCount(st, pop);
    if (this.cityKey !== `${b}:${nCities}:${st}:${lookKey(look)}`) {
      this.cityKey = `${b}:${nCities}:${st}:${lookKey(look)}`;
      if (this.cities) { this.pivot.remove(this.cities.pts); this.cities.pts.geometry.dispose(); }
      this.cities = pointCloud(Math.max(nCities, 1), pointsMaterial({ minPx: 2 }));
      this.cityPos = [];
      for (let i = 0; i < nCities; i++) {
        const p = cityDir(b, i).multiplyScalar(10.05);
        this.cityPos.push(p);
        this.cities.pos.set([p.x, p.y, p.z], i * 3);
        tmpC.set(STAGE_COLORS[Math.max(1, st)]);
        if (look) tmpC.lerp(cultureLight(look, cultC), 0.6);
        tmpC.multiplyScalar(0.75);
        this.cities.col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
        // a pin to click, not a flare: the city's light is drawn by the planet's own night side
        this.cities.size[i] = (i === 0 ? 0.42 : 0.2 + hash01(b, i, 3) * 0.12) * (look ? 0.85 + 0.3 * look.glow : 1);
      }
      dirty(this.cities.pts);
      this.pivot.add(this.cities.pts);
    }
    const on = alive(st);
    // the cities' buildings, seen from orbit: domes early, towers and spires later, in the culture's colours
    const style = on ? styleOf(ctx.world, ctx.snap, b, ctx.year, { independence: false, speciation: false, collapse: false }) : null;
    const archKey = style ? `${this.cityKey}:${style.arch}:${style.body.getHexString()}:${Math.round(style.height * 4)}` : ''; // cityKey carries the society's look
    if (archKey !== this.archKey) {
      this.archKey = archKey;
      if (this.arch) { this.pivot.remove(this.arch); this.arch.geometry.dispose(); }
      this.arch = null;
      if (style && this.cityPos.length) {
        const domes = style.arch === 'huts' || style.arch === 'warrens';
        // a dense culture packs more, closer; a curved one builds rounder, tapering towers; a tall one, taller
        const dens = look ? look.density : 0.5, curve = look ? look.curvature : 0.4;
        const per = Math.min(64, Math.round((6 + Math.round(Math.log10(1 + pop / this.cityPos.length) * 4)) * (0.5 + dens)));
        const spread = 1.25 - 0.5 * dens, tall = look ? 0.6 + 0.8 * look.height : 1;
        const geo = domes ? new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
          : new THREE.CylinderGeometry(0.5 * (1 - 0.75 * curve), 0.5, 1, curve > 0.55 ? 10 : curve > 0.35 ? 6 : 4).translate(0, 0.5, 0);
        const skin = style.body.clone();
        if (look) skin.lerp(cultureSkin(look, cultC), 0.6);
        const mat = new THREE.MeshStandardMaterial({ color: skin.multiplyScalar(1.6), roughness: 0.55, metalness: 0.25, emissive: look ? cultureLight(look, cultC).clone() : style.glow, emissiveIntensity: look ? 0.01 + 0.03 * look.glow : 0.01 }); // the night side's own lights carry the glow
        const im = new THREE.InstancedMesh(geo, mat, this.cityPos.length * per);
        const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), p = new THREE.Vector3(), sc = new THREE.Vector3();
        let k = 0;
        this.cityPos.forEach((c, ci) => {
          n.copy(c).normalize();
          const t1 = new THREE.Vector3().crossVectors(n, up).normalize(), t2 = new THREE.Vector3().crossVectors(n, t1);
          for (let j = 0; j < per; j++) {
            const a = hash01(b, ci, j) * Math.PI * 2, r = Math.sqrt(hash01(b, ci, j, 2)) * (ci === 0 ? 0.45 : 0.25) * spread;
            p.copy(n).multiplyScalar(10).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize().multiplyScalar(10);
            qq.setFromUnitVectors(up, p.clone().normalize());
            const h = domes ? 0.025 + hash01(b, ci, j, 3) * 0.02 : (0.03 + Math.pow(hash01(b, ci, j, 3), 2) * 0.17) * style.height * tall;
            const wd = domes ? 0.03 : 0.018;
            m4.compose(p, qq, sc.set(wd, h, wd));
            im.setMatrixAt(k++, m4);
          }
        });
        im.count = k;
        this.arch = im;
        this.pivot.add(im);
      }
    }
    // orbital works by age and stage: tori, O'Neill pairs, Bishop rings, swarm panels, ring worlds
    this.works.sync(this.orbit, this.group, ctx.snap, ctx.year, b, st, on);
    if (this.sun) { (this.sun.material as THREE.SpriteMaterial).opacity = 0.9 * this.works.starLight; (this.sun.material as THREE.SpriteMaterial).color.copy(this.starCol).multiply(this.works.starTint); }
    // satellites on a few inclined shells, more as the place grows
    const nSat = on ? Math.min(900, 30 + st * st * 22) : 0;
    if (this.satKey !== nSat) {
      this.satKey = nSat;
      if (this.sats) { this.orbit.remove(this.sats.pts); this.sats.pts.geometry.dispose(); }
      this.sats = null;
      if (nSat) {
        const r = new Rng(b * 7 + 1);
        this.sats = pointCloud(nSat, pointsMaterial({ minPx: 0.8, maxPx: 3 }));
        for (let i = 0; i < nSat; i++) {
          const shell = i % 3, R = 10.6 + shell * 0.9 + r.next() * 0.25, inc = (shell - 1) * 0.6 + r.gauss() * 0.08, th = r.range(0, Math.PI * 2);
          tv1.set(Math.cos(th) * R, 0, Math.sin(th) * R).applyAxisAngle(tv2.set(1, 0, 0), inc);
          this.sats.pos.set([tv1.x, tv1.y, tv1.z], i * 3);
          this.sats.col.set([0.75, 0.85, 0.95], i * 3);
          this.sats.size[i] = 0.12 + r.next() * 0.1;
        }
        dirty(this.sats.pts);
        this.orbit.add(this.sats.pts);
        explainSats('sat', this.sats.pts, () => this.builtFor);
      }
    }
    // space elevators once the tech exists: tether from the equator to a counterweight past synchronous orbit
    const elev = ctx.snap && on && st >= STAGE.COLONY && ctx.snap.techDone[ELEVATOR] >= 0 ? (st >= STAGE.HUB ? 3 : 1) : 0;
    this.elevSince = elev ? ctx.snap!.techDone[ELEVATOR] : -1;
    if (this.elevKey !== elev) {
      this.elevKey = elev;
      this.pivot.remove(...this.elevators);
      this.elevators = [];
      for (let k = 0; k < elev; k++) {
        const th = hash01(b, k, 9) * Math.PI * 2 + k * 2.1;
        const dir = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
        const g = new THREE.Group();
        const tether = new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(10), dir.clone().multiplyScalar(TETHER)]);
        tether.setAttribute('color', new THREE.Float32BufferAttribute([0.62, 0.86, 1, 0.12, 0.17, 0.2], 3));
        g.add(new THREE.Line(tether, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })));
        const cw = glowSprite(0xbfe9ff, 0.6, 0.7);
        cw.position.copy(dir).multiplyScalar(TETHER);
        const climber = glowSprite(0xffffff, 0.5, 1);
        climber.userData.dir = dir;
        g.add(cw, climber);
        g.userData.climber = climber;
        this.elevators.push(g);
        this.pivot.add(g);
      }
    }
  }

  frame(ctx: Ctx): void {
    this.pivot.rotation.y = ctx.tm * 0.02;
    (this.planet.material as THREE.ShaderMaterial).uniforms.uTime.value = ctx.t;
    this.orbit.rotation.y = ctx.tm * 0.015;
    this.works.frame(ctx.tm);
    if (this.sats) this.sats.pts.rotation.y = ctx.tm * 0.05;
    for (const g of this.elevators) {
      const c = g.userData.climber as THREE.Sprite;
      const u = (ctx.t * 0.05 + g.id * 0.37) % 1;
      c.position.copy(c.userData.dir as THREE.Vector3).multiplyScalar(10.2 + (TETHER - 10.4) * (0.5 - 0.5 * Math.cos(u * Math.PI * 2)));
    }
    if (this.cities) (this.cities.pts.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.75 + 0.25 * Math.sin(ctx.t * 1.5);
  }

  pickables(ctx: Ctx): Pickable[] {
    const name = ctx.world.bodies[ctx.body].name;
    const out: Pickable[] = [];
    this.cityPos.forEach((p, i) => {
      const w = p.clone().applyMatrix4(this.pivot.matrixWorld);
      if (w.dot(tv1.copy(ctx.camera.position).sub(w)) <= 0) return; // facing away
      out.push({ pos: w, kind: 'city', id: i, name: i === 0 ? `${name} capital` : `${name} settlement ${i}` });
    });
    return out;
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'body') return r.id === ctx.body ? new THREE.Vector3() : null;
    if (r.kind === 'city') return this.cityPos[r.id]?.clone().applyMatrix4(this.pivot.matrixWorld) ?? null;
    return null;
  }

  diveDist(_ctx: Ctx, r: Ref): number { return r.kind === 'city' ? 16 : 0; }

  size(_ctx: Ctx, r: Ref): number { return r.kind === 'body' ? 10.9 : 0; }

  labels(ctx: Ctx): Label[] {
    const b = ctx.world.bodies[ctx.body];
    const st = stageOf(ctx.snap, ctx.body);
    const out: Label[] = [];
    if (this.elevators[0]) {
      const top = (this.elevators[0].children[1] as THREE.Sprite).position.clone().applyMatrix4(this.pivot.matrixWorld);
      out.push({ pos: top, text: this.elevators.length > 1 ? `${this.elevators.length} space elevators` : 'Space elevator', sub: `since ${Math.round(2040 + this.elevSince)}`, prio: 4, ref: { kind: 'thing', id: 0, ex: 'elev', name: 'Space elevator' } });
    }
    out.push({ pos: new THREE.Vector3(0, 11.5, 0), text: b.name, sub: alive(st) ? `${STAGE_NAMES[st]} · ${fmtNum(popOf(ctx.snap, ctx.body))} people` : st >= 0 ? STAGE_NAMES[st] : 'never settled', strong: true, ref: { kind: 'body', id: ctx.body }, prio: 10 });
    return out;
  }
}
