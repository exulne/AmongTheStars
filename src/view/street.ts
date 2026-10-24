// Street level: one settlement on one world, alive. Districts and lit blocks
// sized from head-count and stage, styled by the world; trams or hoppers on
// the ring roads; and up to ~1,600 real residents living a sped-up day (one
// minute per day) along the street grid. Close up they are little figures,
// pulled back they are streams of light.

import * as THREE from 'three';
import { STAGE } from '../sim/catalog.ts';
import type { PersonBrief } from '../sim/lives.ts';
import { F, NF } from '../sim/metrics.ts';
import { Rng, hash01 } from '../sim/rng.ts';
import { CALM, makeAgent, place, type Agent, type Dest, type Mood, type Places } from './life.ts';
import { glowTex, pointsMaterial, specColor } from './textures.ts';
import { alive, cityCount, citySplit, makeSky, popOf, stageOf, type Ctx, type Label, type Level, type Pickable, type Ref, type View } from './views.ts';

export type ResidentsFetch = (body: number, year: number, offset: number, count: number) => Promise<{ pending?: boolean; people: PersonBrief[]; total: number }>;

type District = 'centre' | 'homes' | 'farms' | 'industry' | 'port';
const DISTRICT_NAMES: Record<District, string> = { centre: 'Civic centre', homes: 'Homes', farms: 'Farms', industry: 'Works', port: 'Port' };

interface Ground { ground: number; dome: boolean; water: boolean }
function groundOf(kind: string, terraformed: boolean): Ground {
  const g: Record<string, number> = { desert: 0x2e1d14, ice: 0x1f262c, ocean: 0x05121d, lava: 0x170b07, gas: 0x1a1612, icegiant: 0x111a1f };
  return { ground: terraformed ? 0x14201a : g[kind] ?? 0x1b1b1e, dome: !terraformed && kind !== 'ocean', water: kind === 'ocean' };
}

const MAX_AGENTS = 1600, BATCH = 400;
/** Seconds of real time per day in the street. */
export const DAY_SECONDS = 60;

/**
 * Block material with lit windows: floors and columns come from world position,
 * so every building gets the same window size whatever its scale. The instance
 * colour's red cast marks works (sodium light, fewer windows). uLit is driven by
 * the time of day.
 */
function blockMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.2 });
  m.userData.lit = { value: 0.5 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = m.userData.lit;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld; varying vec3 vWN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        mat3 nm = mat3(modelMatrix);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4; nm = nm * mat3(instanceMatrix);
        #endif
        vWorld = (modelMatrix * wp4).xyz; vWN = normalize(nm * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld; varying vec3 vWN; uniform float uLit;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float side = 1.0 - step(0.5, abs(vWN.y));
          float along = abs(vWN.x) > 0.5 ? vWorld.z : vWorld.x;
          vec2 g = vec2(along * 7.0, vWorld.y * 9.0);
          vec2 f = fract(g);
          float pane = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.8);
          float h = fract(sin(dot(floor(vec3(g, vWorld.x * 0.37 + vWorld.z * 0.53)), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float works = step(0.5, vColor.r - vColor.b);
          float on = step(1.0 - uLit * (1.0 - works * 0.6), h) * step(0.12, vWorld.y);
          vec3 warm = mix(vec3(1.0, 0.78, 0.5), vec3(0.75, 0.88, 1.0), step(0.85, fract(h * 7.0)));
          totalEmissiveRadiance += mix(warm, vec3(1.0, 0.55, 0.2), works) * pane * on * side * 0.45;
        }`);
  };
  return m;
}

interface Vehicle { ring: number; phase: number; speed: number; hop: number; path?: [THREE.Vector3, THREE.Vector3] }

export class StreetView implements View {
  level: Level = 'street';
  group = new THREE.Group();
  limits: [number, number] = [1.2, 120];
  private key = '';
  private R = 10;
  private districts: { d: District; a0: number; a1: number }[] = [];
  private places: Places = { node: [], at: {}, homes: [], ring: 1, R: 1 };
  private topH = 2;
  private cityName = '';
  // people
  private agents: Agent[] = [];
  private pool: PersonBrief[] = [];
  private nextOffset = 0;
  private fetchedFor = '';
  private asking = false;
  private retry = 0;
  private lastCycle = 0;
  private mood: Mood = CALM;
  private moodKey = '';
  private figures: THREE.InstancedMesh | null = null;
  private glows: ReturnType<typeof dotCloud> | null = null;
  // light and motion
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private star: THREE.Sprite | null = null;
  private blockMat: THREE.MeshStandardMaterial | null = null;
  private lampMat: THREE.ShaderMaterial | null = null;
  private vehicles: Vehicle[] = [];
  private cars: THREE.InstancedMesh | null = null;
  private carLights: ReturnType<typeof dotCloud> | null = null;
  private hour = 7;
  focus = -1;  // resident whose biography is open
  follow = -1; // resident the camera is following

  constructor(private fetchResidents: ResidentsFetch) {}

  enter(ctx: Ctx): void {
    this.build(ctx);
    this.frameCamera(ctx);
  }

  private framedR = 0;
  private frameCamera(ctx: Ctx): void {
    const R = (this.framedR = this.R);
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(R * 0.5, R * 0.95, R * 1.1);
    this.limits = [0.6, R * 3.2];
    ctx.controls.minDistance = this.limits[0];
    ctx.controls.maxDistance = this.limits[1];
  }

  /** Who and where the settlement is, at this year. */
  private where(ctx: Ctx): { body: number; city: number; st: number; pop: number; count: number; offset: number } {
    const body = ctx.body, st = stageOf(ctx.snap, body), pop = popOf(ctx.snap, body);
    const n = Math.max(1, cityCount(st, pop));
    const city = Math.min(ctx.city, n - 1);
    const { count, offset } = citySplit(pop, n, city);
    return { body, city, st, pop, count, offset };
  }

  /** The settlement's mood, from the engine state and recent events (set by the app). */
  setMood(m: Mood): void {
    const k = JSON.stringify(m);
    if (k === this.moodKey) return;
    this.moodKey = k;
    this.mood = m;
    // new routines for everyone, same people
    this.agents = this.agents.map((a, i) => makeAgent(a.p, i, this.places, m));
  }

  get time(): string {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private build(ctx: Ctx): void {
    const pl = this.where(ctx);
    const scale = Math.round(Math.log10(1 + pl.count) * 2);
    const key = `${pl.body}:${pl.city}:${pl.st}:${scale}`;
    if (key === this.key) return;
    this.key = key;
    this.group.clear();
    this.agents = []; this.pool = []; this.fetchedFor = ''; this.focus = -1; this.follow = -1;
    this.figures = null; this.glows = null; this.cars = null; this.carLights = null; this.vehicles = [];
    const b = ctx.world.bodies[pl.body];
    this.cityName = pl.city === 0 ? `${b.name} capital` : `${b.name} settlement ${pl.city}`;
    const r = new Rng(pl.body * 131 + pl.city * 7 + 1);
    const terra = ctx.snap ? ctx.snap.S[pl.body * NF + F.terraform] > 0.5 : false;
    const gnd = groundOf(b.kind, terra);
    const outpost = pl.count < 300;
    const R = (this.R = outpost ? 3.2 : Math.min(36, Math.max(5, 3.4 * Math.log10(pl.count) - 3)));
    const big = pl.st >= STAGE.CITY;
    const small = pl.st <= STAGE.BASE || pl.count < 3000;

    // light: the star crosses the sky once a day; a cold sky fill
    const sys = ctx.world.systems[b.system];
    this.sun = new THREE.DirectionalLight(specColor(sys.spec), 2.4);
    this.hemi = new THREE.HemisphereLight(0x5a6a88, 0x101014, 1.1);
    this.star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: specColor(sys.spec), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
    this.star.scale.setScalar(R * 1.6);
    this.group.add(this.sun, this.hemi, this.star, makeSky(pl.body + 11));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 6, 96), new THREE.MeshStandardMaterial({ color: gnd.ground, roughness: gnd.water ? 0.25 : 0.95, metalness: gnd.water ? 0.4 : 0 }));
    ground.rotation.x = -Math.PI / 2;
    this.group.add(ground);
    if (gnd.water) {
      const deck = new THREE.Mesh(new THREE.CircleGeometry(R * 1.06, 96), new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.8 }));
      deck.rotation.x = -Math.PI / 2; deck.position.y = 0.02;
      this.group.add(deck);
    }

    if (outpost) { this.buildOutpost(pl.body, gnd.dome); this.buildPeople(); return; }

    // districts as sectors around a civic centre; industry and port grow with the stage
    const shares: [District, number][] = [['homes', 0.55], ['farms', small ? 0.2 : 0.14], ['industry', big ? 0.2 : 0.12], ['port', big ? 0.12 : 0.08]];
    const total = shares.reduce((a, [, w]) => a + w, 0);
    let a0 = r.range(0, Math.PI * 2);
    this.districts = shares.map(([d, w]) => { const a = a0; a0 += (w / total) * Math.PI * 2; return { d, a0: a, a1: a0 }; });
    const districtAt = (x: number, z: number): District => {
      if (Math.hypot(x, z) < R * 0.2) return 'centre';
      const th = Math.atan2(z, x);
      for (const s of this.districts) {
        let t = th;
        while (t < s.a0) t += Math.PI * 2;
        if (t < s.a1) return s.d;
      }
      return 'homes';
    };

    // blocks on a grid: every fourth row and column is a street, plus two ring roads
    const cell = small ? 0.7 : 1.1;
    const lots = Math.PI * (R / cell) ** 2 * 0.56;
    const fill = Math.min(1, pl.count / 40 / lots);
    const n = Math.ceil(R / cell);
    const boxes: THREE.Matrix4[] = [], boxCol: THREE.Color[] = [], glass: THREE.Matrix4[] = [];
    const beacons: number[] = [], lampPos: number[] = [];
    const byDistrict: Record<District, THREE.Vector3[]> = { centre: [], homes: [], farms: [], industry: [], port: [] };
    const q = new THREE.Quaternion(), tmp = new THREE.Color();
    let topH = 1;
    const density = Math.min(1, Math.log10(1 + pl.count) / 9);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = i * cell, z = j * cell, rr = Math.hypot(x, z);
      if (rr > R) continue;
      const ring = Math.abs(rr - R * 0.2) < cell * 0.5 || Math.abs(rr - R * 0.62) < cell * 0.5;
      if (i % 4 === 0 && j % 4 === 0 && rr < R * 0.95) byDistrict[districtAt(x, z)].push(new THREE.Vector3(x, 0, z));
      if (i % 4 === 0 || j % 4 === 0 || ring) {
        if ((i + j) % 3 === 0) lampPos.push(x, 0.14, z);
        continue;
      }
      const d = districtAt(x, z);
      const h0 = hash01(pl.body, i * 977 + j, pl.city);
      if (h0 > fill * 0.9 + 0.02 || hash01(i, j, pl.city, 7) < 0.1) continue; // empty lots, yards, plazas
      const fall = 1 - rr / R;
      let w = cell * (0.62 + 0.25 * hash01(i, j, 3)), dd = cell * (0.62 + 0.25 * hash01(i, j, 4)), h: number;
      if (d === 'farms') {
        h = 0.12;
        glass.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h / 2, z), q, new THREE.Vector3(w, h, dd)));
        continue;
      }
      const hv = hash01(i, j, 9);
      if (d === 'industry') { h = 0.25 + hv * 0.6; w *= 1.1; tmp.setRGB(0.9, 0.3, 0.2).multiplyScalar(0.3); }
      else if (d === 'port') { h = hv < 0.3 ? 1.5 + hv * 4 : 0.06; tmp.set(0x2a313b); }
      else if (d === 'centre') { h = Math.min(R * 0.28, (0.8 + hv * 2.5) * (1 + density * 2) * (0.5 + fall)); tmp.set(0x2c323d); }
      else { h = Math.min(R * 0.16, (0.25 + Math.pow(hv, 2) * (big ? 4 : 1.2)) * (0.4 + fall * density * 2.2)); tmp.set(0x232831); }
      topH = Math.max(topH, h);
      boxes.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h / 2, z), q, new THREE.Vector3(w, h, dd)));
      boxCol.push(tmp.clone().offsetHSL(0, 0, (hash01(i, j, 5) - 0.5) * 0.03));
      if (d === 'port' && h > 1) beacons.push(x, h + 0.05, z);
    }
    this.topH = topH;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.blockMat = blockMaterial();
    const blocks = new THREE.InstancedMesh(boxGeo, this.blockMat, Math.max(1, boxes.length));
    blocks.count = boxes.length;
    boxes.forEach((mm, k) => { blocks.setMatrixAt(k, mm); blocks.setColorAt(k, boxCol[k]); });
    this.group.add(blocks);
    if (glass.length) {
      const farms = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x1e3a28, emissive: 0x2c6a3c, emissiveIntensity: 0.22, roughness: 0.3, transparent: true, opacity: 0.85 }), glass.length);
      glass.forEach((mm, k) => farms.setMatrixAt(k, mm));
      this.group.add(farms);
    }
    const civic = new THREE.Mesh(new THREE.SphereGeometry(R * 0.06 + 0.3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8d97a6, roughness: 0.6, metalness: 0.1 }));
    this.group.add(civic);
    if (beacons.length) this.group.add(pointsFrom(beacons, beacons.map((_, k) => [0.4, 0.85, 1][k % 3]), 0.4, 5));
    if (lampPos.length) {
      const lamps = pointsFrom(lampPos, Array.from({ length: lampPos.length }, (_, k) => [1, 0.86, 0.66][k % 3]), 0.18, 3);
      this.lampMat = lamps.material as THREE.ShaderMaterial;
      this.group.add(lamps);
    }
    // street grid as faint hairlines
    const roads: number[] = [];
    for (let i = -n; i <= n; i += 4) {
      const L = Math.sqrt(Math.max(0, R * R - (i * cell) ** 2));
      roads.push(i * cell, 0.03, -L, i * cell, 0.03, L, -L, 0.03, i * cell, L, 0.03, i * cell);
    }
    for (const rr of [R * 0.2, R * 0.62, R]) for (let k = 0; k < 96; k++) {
      const t0 = (k / 96) * Math.PI * 2, t1 = ((k + 1) / 96) * Math.PI * 2;
      roads.push(Math.cos(t0) * rr, 0.03, Math.sin(t0) * rr, Math.cos(t1) * rr, 0.03, Math.sin(t1) * rr);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(roads, 3));
    this.group.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x4a6078, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));

    if (gnd.dome) {
      this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 1.04, 36, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
        new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })));
    }
    // a megastructure's habitat ring arcs across the sky
    if (pl.st === STAGE.MEGA) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 2.8, R * 0.05, 10, 240), new THREE.MeshStandardMaterial({ color: 0x8b909a, roughness: 0.5, metalness: 0.5, emissive: 0x1a2230 }));
      ring.position.set(0, R * 0.4, -R * 1.2);
      ring.rotation.set(1.15, 0.2, 0);
      this.group.add(ring);
    }

    // places people go
    const pickOne = (xs: THREE.Vector3[], h: number) => xs[Math.floor(h * xs.length) % Math.max(1, xs.length)];
    const centre = byDistrict.centre.length ? byDistrict.centre : [new THREE.Vector3()];
    const near = (xs: THREE.Vector3[]) => xs.slice().sort((p, q2) => p.length() - q2.length());
    const homes = byDistrict.homes.length ? byDistrict.homes : centre;
    const works = byDistrict.industry.length ? byDistrict.industry : centre;
    const at: Partial<Record<Dest, THREE.Vector3[]>> = {
      farms: byDistrict.farms.length ? byDistrict.farms : works, works, port: byDistrict.port.length ? byDistrict.port : works,
      reactor: [pickOne(works, 0.3)], mine: near(works).slice(-3),
      labs: [pickOne(centre, 0.2)], hall: [near(centre)[0]], hospital: [pickOne(centre, 0.7)],
      school: near(homes).slice(0, 2), plaza: near(centre).slice(0, 2), market: [pickOne(homes, 0.5)], temple: [pickOne(homes, 0.8)],
      depot: [pickOne(byDistrict.port.length ? byDistrict.port : works, 0.6)],
    };
    this.places = { node: [...homes, ...centre], at, homes, ring: R * 0.62, R };
    this.buildVehicles(pl.st, b.g, gnd.dome && !terra, at);
    this.buildPeople();
  }

  /** Under ~300 people: a ring of habitat modules round a small dome, and a landing pad. */
  private buildOutpost(body: number, dome: boolean): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x59606c, roughness: 0.6, metalness: 0.3 });
    const geo = new THREE.CylinderGeometry(0.22, 0.22, 0.75, 16);
    const mods: THREE.Vector3[] = [];
    const win: number[] = [], col: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + hash01(body, i) * 0.3, rr = 1 + (i % 2) * 0.55;
      const m = new THREE.Mesh(geo, mat);
      m.rotation.z = Math.PI / 2; m.rotation.y = -a;
      m.position.set(Math.cos(a) * rr, 0.22, Math.sin(a) * rr);
      this.group.add(m);
      win.push(m.position.x, 0.3, m.position.z);
      col.push(1, 0.82, 0.6);
      mods.push(new THREE.Vector3(Math.cos(a) * (rr - 0.45), 0, Math.sin(a) * (rr - 0.45)));
    }
    this.group.add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8d97a6, roughness: 0.5, metalness: 0.2 })));
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32), new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(2.4, 0.02, 0.6);
    this.group.add(pad);
    win.push(2.4, 0.08, 0.6, 2.95, 0.05, 0.6, 1.85, 0.05, 0.6);
    col.push(0.4, 0.85, 1, 0.4, 0.85, 1, 0.4, 0.85, 1);
    this.group.add(pointsFrom(win, col, 0.5, 5));
    if (dome) this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(this.R * 0.7, 28, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false })));
    this.topH = 0.8;
    const hub = [new THREE.Vector3(0.7, 0, 0)], padV = [new THREE.Vector3(2.2, 0, 0.6)];
    this.places = { node: mods, homes: mods, ring: 1.3, R: 3, at: { works: hub, reactor: hub, mine: padV, farms: hub, port: padV, labs: hub, hall: hub, hospital: hub, school: hub, plaza: hub, market: hub, temple: hub, depot: hub } };
    this.districts = [];
  }

  /** Trams on the ring roads (in sealed tubes under a dome, hoppers on small moons), cargo crawlers between the works and the port. */
  private buildVehicles(st: number, g: number, tubes: boolean, at: Partial<Record<Dest, THREE.Vector3[]>>): void {
    const R = this.R;
    const nTram = st >= STAGE.TOWN ? 4 + st * 2 : 2;
    const hopper = g < 0.3;
    for (let k = 0; k < nTram; k++) this.vehicles.push({ ring: k % 2 ? R * 0.62 : R * 0.2, phase: hash01(k, 21) * Math.PI * 2, speed: (k % 2 ? 0.05 : 0.09) * (k % 3 ? 1 : -1), hop: hopper ? 1 : 0 });
    const from = at.works ?? [], to = at.port ?? [];
    for (let k = 0; k < Math.min(8, 2 + st); k++) {
      const a = from[k % Math.max(1, from.length)], b = to[(k * 3) % Math.max(1, to.length)];
      if (a && b) this.vehicles.push({ ring: 0, phase: hash01(k, 22), speed: 0.012 + hash01(k, 23) * 0.01, hop: 0, path: [a, b] });
    }
    if (!this.vehicles.length) return;
    this.cars = new THREE.InstancedMesh(new THREE.BoxGeometry(hopper ? 0.22 : 0.4, 0.11, 0.13), new THREE.MeshStandardMaterial({ color: 0x3a4554, roughness: 0.5, metalness: 0.5, emissive: 0x6a8cae, emissiveIntensity: 0.35 }), this.vehicles.length);
    this.cars.frustumCulled = false;
    this.carLights = dotCloud(this.vehicles.length, 1.6, 8);
    this.group.add(this.cars, this.carLights.pts);
    if (tubes) for (const rr of [R * 0.2, R * 0.62]) {
      const tube = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.11, 8, 160), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
      tube.rotation.x = Math.PI / 2; tube.position.y = 0.08;
      this.group.add(tube);
    }
  }

  private buildPeople(): void {
    this.figures = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.028, 0.07, 3, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x332a20 }), MAX_AGENTS);
    this.figures.count = 0;
    this.figures.frustumCulled = false;
    this.glows = dotCloud(MAX_AGENTS, 2, 9);
    this.group.add(this.figures, this.glows.pts);
  }

  sync(ctx: Ctx): void {
    this.build(ctx);
    if (Math.abs(this.R - this.framedR) > this.framedR * 0.3) this.frameCamera(ctx);
    const pl = this.where(ctx);
    if (!alive(pl.st)) return;
    // new people when the decade turns or the place changes
    const want = `${pl.body}:${pl.city}:${Math.floor(ctx.year / 10)}`;
    if (want !== this.fetchedFor) { this.fetchedFor = want; this.agents = []; this.pool = []; this.nextOffset = 0; }
    this.fill(ctx);
  }

  /** Fetch residents in batches until the street is full, then keep a small pool of fresh faces. */
  private fill(ctx: Ctx): void {
    const pl = this.where(ctx);
    const target = Math.min(MAX_AGENTS, pl.count);
    if (this.asking || (this.agents.length >= target && this.pool.length >= BATCH / 2) || pl.count < 1) return;
    const key = this.fetchedFor;
    const off = pl.offset + (this.nextOffset % Math.max(1, pl.count));
    const n = Math.min(BATCH, pl.count - (this.nextOffset % Math.max(1, pl.count)));
    this.asking = true;
    this.fetchResidents(pl.body, ctx.year, off, n).then((res) => {
      this.asking = false;
      if (key !== this.fetchedFor) return this.fill(ctx);
      if (res.pending) { clearTimeout(this.retry); this.retry = window.setTimeout(() => this.fill(ctx), 700); return; }
      this.nextOffset += res.people.length || BATCH;
      for (const p of res.people) {
        if (this.agents.length < target) this.agents.push(makeAgent(p, this.agents.length, this.places, this.mood));
        else this.pool.push(p);
      }
      if (res.people.length) this.fill(ctx);
    });
  }

  frame(ctx: Ctx): void {
    // the day: one minute of real time
    this.hour = ((ctx.t / DAY_SECONDS) * 24 + 7) % 24;
    const sunUp = Math.sin(((this.hour - 6) / 12) * Math.PI);
    const day = Math.max(0, sunUp), night = Math.min(1, Math.max(0, 0.35 - sunUp * 1.6));
    if (this.sun) {
      const az = ((this.hour - 6) / 12) * Math.PI;
      this.sun.position.set(Math.cos(az) * this.R * 2, Math.max(0.05, sunUp) * this.R * 2, -this.R * 0.8);
      this.sun.intensity = 0.1 + day * 2.4;
      this.hemi!.intensity = 0.25 + day * 0.9;
      this.star!.position.copy(this.sun.position).setLength(this.R * 9);
      this.star!.visible = sunUp > -0.1;
    }
    if (this.blockMat) this.blockMat.userData.lit.value = 0.15 + 0.6 * night;
    if (this.lampMat) this.lampMat.uniforms.uOpacity.value = 0.15 + 0.85 * night;

    // vehicles: fewer at night
    if (this.cars && this.carLights) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      this.vehicles.forEach((v, k) => {
        const on = night < 0.6 || k % 2 === 0;
        if (v.path) {
          const u = (ctx.t * v.speed + v.phase) % 2, f = u < 1 ? u : 2 - u;
          p.lerpVectors(v.path[0], v.path[1], f); p.y = 0.07;
          q.setFromAxisAngle(up, Math.atan2(v.path[1].x - v.path[0].x, v.path[1].z - v.path[0].z) + Math.PI / 2);
        } else {
          const ang = v.phase + ctx.t * v.speed;
          p.set(Math.cos(ang) * v.ring, 0.08 + (v.hop ? Math.abs(Math.sin(ctx.t * 1.4 + v.phase * 5)) * 0.8 : 0), Math.sin(ang) * v.ring);
          q.setFromAxisAngle(up, -ang + (v.speed > 0 ? 0 : Math.PI));
        }
        m.compose(p, q, on ? s : s.clone().setScalar(0));
        this.cars!.setMatrixAt(k, m);
        this.carLights!.pos.set([p.x, p.y + 0.03, p.z], k * 3);
        this.carLights!.col.set(v.path ? [1, 0.6, 0.25] : [0.75, 0.9, 1], k * 3);
        this.carLights!.size[k] = on ? 1 : 0;
      });
      this.cars.instanceMatrix.needsUpdate = true;
      flag(this.carLights);
    }

    // people
    if (this.figures && this.glows) {
      const near = ctx.camera.position.distanceTo(ctx.controls.target) < Math.max(10, this.R * 0.6);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), zero = new THREE.Vector3(0, 0, 0), p = new THREE.Vector3(), c = new THREE.Color();
      // swap a few people who are indoors for fresh faces, so the street cycles through the population
      if (ctx.t - this.lastCycle > 1.5 && this.pool.length) {
        this.lastCycle = ctx.t;
        for (let tries = 0; tries < 12 && this.pool.length; tries++) {
          const k = Math.floor(Math.random() * this.agents.length);
          if (k !== this.focus && k !== this.follow && !this.agents[k].vis) this.agents[k] = makeAgent(this.pool.pop()!, k, this.places, this.mood);
        }
        if (this.pool.length < BATCH / 2) this.fill(ctx);
      }
      const n = this.agents.length;
      for (let k = 0; k < n; k++) {
        const a = this.agents[k];
        place(a, this.hour, ctx.t, this.places);
        p.set(a.x, a.y, a.z);
        const kid = a.p.age < 16;
        if (a.patrol) c.setRGB(1, 0.42, 0.35);
        else if (this.mood.plague) c.setRGB(0.8, 0.95, 0.85);
        else if (kid) c.setRGB(0.75, 0.9, 1);
        else c.setRGB(1, 0.86, 0.68);
        if (k === this.focus) c.setRGB(0.5, 0.92, 1);
        m.compose(p.setY(kid ? 0.05 : 0.065), q, a.vis && near ? (kid ? s.clone().setScalar(0.75) : s) : zero);
        this.figures.setMatrixAt(k, m);
        this.figures.setColorAt(k, c);
        this.glows.pos.set([a.x, 0.09, a.z], k * 3);
        this.glows.col.set([c.r, c.g, c.b], k * 3);
        this.glows.size[k] = a.vis ? (k === this.focus ? 2.6 + 0.6 * Math.sin(ctx.t * 4) : near ? 0.45 : 0.9) : 0;
      }
      this.figures.count = n;
      this.figures.instanceMatrix.needsUpdate = true;
      if (this.figures.instanceColor) this.figures.instanceColor.needsUpdate = true;
      this.glows.pts.geometry.setDrawRange(0, n);
      flag(this.glows);

      // follow: the camera rides along with someone through their day
      const f = this.agents[this.follow];
      if (f) {
        const goal = new THREE.Vector3(f.x, 0.1, f.z);
        const d = goal.sub(ctx.controls.target).multiplyScalar(0.08);
        ctx.controls.target.add(d);
        ctx.camera.position.add(d);
      }
    }
  }

  personId(k: number): string | null { return this.agents[k]?.p.id ?? null; }
  personName(k: number): string { return this.agents[k]?.p.name ?? ''; }

  pickables(): Pickable[] {
    const out: Pickable[] = [];
    this.agents.forEach((a, k) => {
      if (!a.vis) return;
      out.push({ pos: new THREE.Vector3(a.x, 0.08, a.z), kind: 'person', id: k, name: `${a.p.name}, ${a.p.age}, ${a.p.job} · ${a.doing}`, weight: k === this.focus ? 4 : 0 });
    });
    return out;
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    const a = r.kind === 'person' ? this.agents[r.id] : undefined;
    if (a) return new THREE.Vector3(a.x, 0.08, a.z);
    if (r.kind === 'city' && r.id === ctx.city) return new THREE.Vector3();
    return null;
  }

  diveDist(): number { return 0; }

  labels(ctx: Ctx): Label[] {
    const pl = this.where(ctx);
    const out: Label[] = [{ pos: new THREE.Vector3(0, this.topH + 0.8, 0), text: this.cityName, sub: alive(pl.st) ? `${pl.count.toLocaleString('en-US')} people · ${this.time}` : 'no one lives here now', strong: true, prio: 10 }];
    for (const s of this.districts) {
      const th = (s.a0 + s.a1) / 2;
      out.push({ pos: new THREE.Vector3(Math.cos(th) * this.R * 0.8, 0.4, Math.sin(th) * this.R * 0.8), text: DISTRICT_NAMES[s.d], prio: 2 });
    }
    const f = this.agents[this.follow];
    if (f) out.push({ pos: new THREE.Vector3(f.x, 0.35, f.z), text: f.p.name, sub: f.doing, strong: true, prio: 12 });
    return out;
  }
}

function dotCloud(n: number, minPx = 2, maxPx = 9) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(geo, pointsMaterial({ minPx, maxPx, sizeScale: 0.6 }));
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  return { pts, pos, col, size };
}

function flag(d: ReturnType<typeof dotCloud>): void {
  const g = d.pts.geometry;
  g.attributes.position.needsUpdate = true; g.attributes.size.needsUpdate = true; g.attributes.color.needsUpdate = true;
}

/** Static glowing points; `col` is rgb triples. */
function pointsFrom(pos: number[], col: number[], size: number, maxPx: number): THREE.Points {
  const n = pos.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(new Array(n).fill(size), 1));
  const pts = new THREE.Points(geo, pointsMaterial({ minPx: 0.9, maxPx, sizeScale: 1 }));
  pts.frustumCulled = false;
  return pts;
}
