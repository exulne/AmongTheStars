// Street level: one settlement on one world, alive and of its time. The
// buildings follow the technology of the year (regolith huts, printed
// warrens, fusion towers, grown spires, light-farms, data-temples), the
// palette and street grid drift with the culture, and the settlement's
// fortunes show as ruins, banners and monuments. Up to ~1,600 real residents
// live a sped-up day (a minute per day) along the streets: little figures
// close up, streams of light from afar.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STAGE } from '../sim/catalog.ts';
import { infraOf, type Infra } from '../sim/infra.ts';
import type { PersonBrief } from '../sim/lives.ts';
import { Rng, hash01 } from '../sim/rng.ts';
import { ARCH_NAME, changes, styleOf, type History, type Style } from './epoch.ts';
import { CALM, makeAgent, place, type Agent, type Dest, type Mood, type Places } from './life.ts';
import { StreetWar } from './streetWar.ts';
import { glowTex, pointsMaterial, specColor } from './textures.ts';
import { cultureLight, societyLook } from './societyLook.ts';
import { StreetInfra, infraSig, peopleTech } from './streetInfra.ts';
import { alive, cityCount, citySplit, makeSky, popOf, stageOf, type Ctx, type Label, type Level, type Pickable, type Ref, type View } from './views.ts';

export type ResidentsFetch = (body: number, year: number, offset: number, count: number) => Promise<{ pending?: boolean; people: PersonBrief[]; total: number }>;

type District = 'centre' | 'homes' | 'farms' | 'industry' | 'port';
const DISTRICT_NAMES: Record<District, string> = { centre: 'Civic centre', homes: 'Homes', farms: 'Farms', industry: 'Works', port: 'Port' };

function groundOf(kind: string, open: boolean): { ground: number; dome: boolean; water: boolean } {
  const g: Record<string, number> = { desert: 0x2e1d14, ice: 0x1f262c, ocean: 0x05121d, lava: 0x170b07, gas: 0x1a1612, icegiant: 0x111a1f };
  return { ground: open ? 0x16241b : g[kind] ?? 0x1b1b1e, dome: !open && kind !== 'ocean', water: kind === 'ocean' };
}

// phones get fewer residents: smaller screens, smaller GPUs
const MAX_AGENTS = matchMedia('(max-width: 40rem)').matches ? 700 : 1600, BATCH = 400;
/** Seconds of real time per day in the street. */
export const DAY_SECONDS = 60;

/** Shared by every block material of a settlement: how many windows are lit, how dark it is, the windows' colour. */
interface BlockUniforms { lit: { value: number }; night: { value: number }; warm: { value: THREE.Color } }

/**
 * Block material with a facade: floors and columns come from world position,
 * so every building gets the same panes whatever its scale. By day the panes
 * are dark glass in lighter frames over floor slabs; after dusk a share of
 * them light up in the society's colour (a few cold blue screens among them),
 * and the shopfronts along the street glow. Instance colour codes: a red cast
 * marks works (sodium light, fewer windows); a green channel near zero marks a
 * ruin (dark, unlit).
 */
function blockMaterial(u: BlockUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.15 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = u.lit;
    sh.uniforms.uNight = u.night;
    sh.uniforms.uWarm = u.warm;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld; varying vec3 vWN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        mat3 nm = mat3(modelMatrix);
        vec3 on4 = objectNormal;
        #ifdef USE_INSTANCING
          // tall, thin instances: scale the normal by the inverse scale, or a tapered spire's walls read as roofs
          mat3 im4 = mat3(instanceMatrix);
          on4 = im4 * (on4 / vec3(dot(im4[0], im4[0]), dot(im4[1], im4[1]), dot(im4[2], im4[2])));
          wp4 = instanceMatrix * wp4;
        #endif
        vWorld = (modelMatrix * wp4).xyz; vWN = normalize(nm * on4);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorld; varying vec3 vWN; uniform float uLit, uNight; uniform vec3 uWarm;
        float fHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #if defined(USE_INSTANCING_COLOR) || defined(USE_COLOR)
          vec3 tag = vColor.rgb;
        #else
          vec3 tag = vec3(0.2);
        #endif
        float works = step(0.2, tag.r) * step(tag.b * 3.0, tag.r);
        float ruin = 1.0 - step(0.004, tag.g);
        float side = 1.0 - step(0.5, abs(vWN.y));
        float along = abs(vWN.x) > abs(vWN.z) ? vWorld.z : vWorld.x;
        vec2 g = vec2(along * 7.0, vWorld.y * 9.0);
        vec2 f = fract(g);
        float pane = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.86) * step(0.12, vWorld.y) * (1.0 - works * 0.6);
        float slab = (1.0 - step(0.1, f.y)) * side;
        float wh = fHash(vec3(floor(g), floor(vWorld.x * 0.37 + vWorld.z * 0.53)));
        // the street's own albedo: skins are dark in the style palette, so lift them; ruins stay soot-black
        diffuseColor.rgb *= mix(2.3, 1.0, ruin);
        diffuseColor.rgb *= 0.93 + 0.14 * fract(wh * 13.1);              // weathering, pane by pane
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.32 + vec3(0.012, 0.016, 0.022), pane * side * (1.0 - ruin)); // glass
        diffuseColor.rgb *= 1.0 + slab * 0.35;                            // floor slabs
        diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.0, 0.4, vWorld.y)); // street-level grime and shade
        float roof = step(0.5, vWN.y);
        diffuseColor.rgb *= 1.0 - roof * 0.25;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, pane * side * (1.0 - ruin));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float on = step(1.0 - uLit * (1.0 - works * 0.6), wh) * (1.0 - ruin);
          // most windows the society's warm colour, some cooler, a few blue with a screen
          float k = fract(wh * 7.0);
          vec3 wc = mix(uWarm, vec3(0.75, 0.86, 1.0), step(0.8, k));
          wc = mix(wc, vec3(0.35, 0.55, 1.0), step(0.95, k));
          wc = mix(wc, vec3(1.0, 0.55, 0.2), works);
          float bright = (0.1 + 0.55 * uNight) * (0.6 + 0.8 * fract(wh * 31.0));
          totalEmissiveRadiance += wc * pane * on * side * bright;
          // shopfronts: a lit band along the ground floor after dusk
          float shop = step(0.025, vWorld.y) * (1.0 - step(0.1, vWorld.y)) * side * (1.0 - ruin) * (1.0 - works);
          totalEmissiveRadiance += uWarm * shop * uNight * 0.55 * step(0.35, fract(wh * 3.7 + floor(along * 2.0) * 0.37));
        }`);
  };
  return m;
}

/** Paving inside the settlement: lots, the street grid (asphalt, kerbs, dashed centre lines), ring roads and a tiled plaza. */
function pavingMaterial(color: THREE.Color, cell: number, G: number, R: number, night: { value: number }, warm: { value: THREE.Color }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCell = { value: cell }; sh.uniforms.uG = { value: G }; sh.uniforms.uR = { value: R };
    sh.uniforms.uNight = night; sh.uniforms.uWarm = warm;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = vec2(position.x, -position.y);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vLocal; uniform float uCell, uG, uR, uNight; uniform vec3 uWarm;
        float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(pHash(i), pHash(i + vec2(1, 0)), f.x), mix(pHash(i + vec2(0, 1)), pHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 x = vLocal;
          float rr = length(x), span = uCell * uG;
          vec2 dg = abs(x - floor(x / span + 0.5) * span);
          float dRoad = min(dg.x, dg.y);
          float dRing = min(min(abs(rr - uR * 0.2), abs(rr - uR * 0.62)), abs(rr - uR));
          float d = min(dRoad, dRing);
          float half_ = uCell * 0.5;
          float road = 1.0 - smoothstep(half_ * 0.72, half_ * 0.78, d);
          float kerb = (1.0 - smoothstep(half_ * 0.9, half_ * 1.0, d)) - road;
          // centre line, dashed along the street
          float along = dg.x < dg.y ? x.y : x.x;
          float dash = (1.0 - smoothstep(0.012, 0.02, dRoad)) * step(0.5, fract(along * 2.5)) * step(dRing, dRoad + 1.0) * (1.0 - step(dRing, half_));
          float grime = pNoise(x * 3.0) * 0.6 + pNoise(x * 11.0) * 0.4;
          vec3 c = diffuseColor.rgb * (0.85 + 0.3 * grime);
          // lots: slabs with joints
          vec2 lot = abs(fract(x / (uCell * 0.5)) - 0.5);
          c *= 1.0 - (1.0 - smoothstep(0.0, 0.03, min(lot.x, lot.y))) * 0.18;
          // the plaza: light tiles
          float plaza = 1.0 - smoothstep(uR * 0.17, uR * 0.19, rr);
          vec2 tile = abs(fract(x * 3.0) - 0.5);
          vec3 pl = vec3(0.16, 0.155, 0.15) * (0.9 + 0.2 * pHash(floor(x * 3.0))) * (1.0 - (1.0 - smoothstep(0.0, 0.04, min(tile.x, tile.y))) * 0.3);
          c = mix(c, pl, plaza);
          c = mix(c, vec3(0.022, 0.024, 0.028) * (0.85 + 0.3 * grime), road);
          c = mix(c, vec3(0.12, 0.12, 0.125), kerb);
          c = mix(c, vec3(0.32, 0.3, 0.24), dash * road);
          diffuseColor.rgb = c;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // pools of lamplight at the crossings after dark
          float span = uCell * uG;
          vec2 cr = abs(vLocal - floor(vLocal / span + 0.5) * span);
          float pool = exp(-dot(cr, cr) / (uCell * uCell * 0.35));
          totalEmissiveRadiance += uWarm * pool * uNight * 0.06;
        }`);
  };
  return m;
}

/** Ground outside the settlement: patchy regolith, soil or sea, never one flat colour. */
function groundMaterial(color: number, water: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: water ? 0.25 : 0.95, metalness: water ? 0.4 : 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = position.xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vGround;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float n = gNoise(vGround * 0.15) * 0.5 + gNoise(vGround * 0.6) * 0.3 + gNoise(vGround * 2.7) * 0.2;
          float rocks = step(0.93, gHash(floor(vGround * 4.0))) * 0.4;
          diffuseColor.rgb *= ${water ? '0.8 + 0.4 * n' : '0.6 + 0.8 * n + rocks'};
        }`);
  };
  return m;
}

/** A ribbed regolith hut with an airlock, base at y = 0, radius 1. */
function hutGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)];
  for (let k = 0; k < 4; k++) parts.push(new THREE.TorusGeometry(1.01, 0.045, 4, 18, Math.PI).rotateY((k * Math.PI) / 4));
  parts.push(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 12).rotateZ(Math.PI / 2).translate(1.0, 0.22, 0));
  parts.push(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 12).rotateZ(Math.PI / 2).translate(1.26, 0.22, 0));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

/**
 * A person: legs, torso, arms, head, feet at y = 0, facing +z. `part` tags
 * vertices (±1 legs, ±2 arms, 3 head) so the shader can swing limbs.
 */
function personGeometry(): THREE.BufferGeometry {
  const tag = (g: THREE.BufferGeometry, v: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('part', new THREE.Float32BufferAttribute(new Array(n).fill(v), 1));
    return g.toNonIndexed();
  };
  const parts = [
    tag(new THREE.BoxGeometry(0.013, 0.055, 0.016).translate(-0.0105, 0.0275, 0), 1),
    tag(new THREE.BoxGeometry(0.013, 0.055, 0.016).translate(0.0105, 0.0275, 0), -1),
    tag(new THREE.CapsuleGeometry(0.017, 0.03, 2, 8).scale(1.15, 1, 0.75).translate(0, 0.081, 0), 0),
    tag(new THREE.BoxGeometry(0.009, 0.044, 0.011).translate(-0.027, 0.083, 0), 2),
    tag(new THREE.BoxGeometry(0.009, 0.044, 0.011).translate(0.027, 0.083, 0), -2),
    tag(new THREE.SphereGeometry(0.0125, 10, 8).translate(0, 0.121, 0), 3),
  ];
  return mergeGeometries(parts)!;
}

/** Instanced people that walk: limbs swing by a per-instance phase and pace; heads get a skin tone. */
function personMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, emissive: 0x2a231a });
  m.userData.time = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = m.userData.time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part; attribute vec2 aWalk; uniform float uTime; varying float vHead; varying float vSkin;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float sw = sin(uTime * 9.0 + aWalk.x * 6.283) * 0.6 * aWalk.y;
        float ap = abs(part);
        if (ap > 0.5 && ap < 1.5) {
          float a = sw * sign(part); vec3 p = transformed - vec3(0.0, 0.055, 0.0);
          transformed = vec3(p.x, p.y * cos(a) - p.z * sin(a), p.y * sin(a) + p.z * cos(a)) + vec3(0.0, 0.055, 0.0);
        } else if (ap > 1.5 && ap < 2.5) {
          float a = -sw * sign(part) * 0.8; vec3 p = transformed - vec3(0.0, 0.103, 0.0);
          transformed = vec3(p.x, p.y * cos(a) - p.z * sin(a), p.y * sin(a) + p.z * cos(a)) + vec3(0.0, 0.103, 0.0);
        }
        transformed.y += abs(sw) * 0.004;
        vHead = step(2.5, part); vSkin = fract(aWalk.x * 3.7);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHead; varying float vSkin;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.28, 0.17, 0.11), vec3(0.92, 0.76, 0.64), vSkin), vHead);`);
  };
  return m;
}

/** A building that moves from an old height to a new one when the city changes. */
interface Grow { mesh: THREE.InstancedMesh; x: Float32Array; z: Float32Array; sx: Float32Array; sz: Float32Array; from: Float32Array; to: Float32Array; delay: Float32Array; q: THREE.Quaternion[]; centred: boolean }

interface Vehicle { ring: number; phase: number; speed: number; hop: number; path?: [THREE.Vector3, THREE.Vector3] }

export class StreetView implements View {
  level: Level = 'street';
  group = new THREE.Group();
  limits: [number, number] = [1.2, 120];
  private city = new THREE.Group(); // the settlement, turned to its culture's grid
  private key = '';
  private placeKey = '';
  private R = 10;
  private districts: { d: District; a0: number; a1: number }[] = [];
  private places: Places = { node: [], at: {}, homes: [], ring: 1, R: 1 };
  private topH = 2;
  private cityName = '';
  private style: Style | null = null;
  private hist: History = { independence: false, speciation: false, collapse: false };
  private changed = '';
  private changedAt = -1e9;
  private heights = new Map<string, number>();
  private growers: Grow[] = [];
  private growT = 0;
  private walk: THREE.InstancedBufferAttribute | null = null;
  private prevX = new Float32Array(0);
  private prevZ = new Float32Array(0);
  private heading = new Float32Array(0);
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
  private hemiBase = new THREE.Color();
  private war = new StreetWar(personGeometry(), personMaterial());
  private star: THREE.Sprite | null = null;
  private blockMats: THREE.MeshStandardMaterial[] = [];
  private blockU: BlockUniforms = { lit: { value: 0.5 }, night: { value: 0 }, warm: { value: new THREE.Color() } };
  private body = -1;
  private lampMat: THREE.ShaderMaterial | null = null;
  private vehicles: Vehicle[] = [];
  private cars: THREE.InstancedMesh | null = null;
  private carLights: ReturnType<typeof dotCloud> | null = null;
  private hour = 7;
  private sunCol = new THREE.Color();
  // what the place has built around it: skyline, transit, traffic, and what is overhead (streetInfra.ts)
  private infra = new StreetInfra();
  private tech = { robots: 0, neon: 0 };
  focus = -1;  // resident whose biography is open
  follow = -1; // resident the camera is following
  /** a person the app wants shadowed wherever they live — injected as an agent if the census didn't draw them */
  followPid: string | null = null;
  private followKey = '';
  private fetchPerson: ((pid: string, year: number) => Promise<{ pending?: boolean; bio: (PersonBrief & { where?: { body: number; name: string } | null }) | null }>) | null = null;
  setPersonFetch(f: StreetView['fetchPerson']): void { this.fetchPerson = f; }

  constructor(private fetchResidents: ResidentsFetch) {}

  enter(ctx: Ctx): void {
    this.build(ctx);
    this.frameCamera(ctx);
  }

  private framedR = 0;
  private framedLow = -1;
  private framedAt = 0;
  private frameCamera(ctx: Ctx): void {
    const R = (this.framedR = this.R);
    this.framedAt = performance.now();
    ctx.controls.target.set(0, 0, 0);
    // low and close enough that the residents read as people, with the skyline behind them
    const d = Math.max(7, R * 0.62) / R;
    // a city with a skyline beyond it is framed lower, so the towers and what is overhead stand against the sky
    const low = (this.framedLow = this.infra.topH > R * 0.3 ? 0.3 : 0);
    const back = 1 + low * 1.4;
    ctx.camera.position.set(R * 0.36 * d * back, R * (0.58 - low * 0.6) * d * back, R * 0.72 * d * back);
    this.limits = [0.6, R * 3.2];
    ctx.controls.minDistance = this.limits[0];
    ctx.controls.maxDistance = this.limits[1];
  }

  private where(ctx: Ctx): { body: number; city: number; st: number; pop: number; count: number; offset: number } {
    const body = ctx.body, st = stageOf(ctx.snap, body), pop = popOf(ctx.snap, body);
    const n = Math.max(1, cityCount(st, pop));
    const city = Math.min(ctx.city, n - 1);
    const { count, offset } = citySplit(pop, n, city);
    return { body, city, st, pop, count, offset };
  }

  /** The settlement's mood, from the engine state and recent events (set by the app). */
  setMood(m: Mood): void {
    // minds that have moved into the machines leave the streets quiet
    const q = this.style?.quiet ? { ...m, activity: m.activity * 0.45, leisure: m.leisure * 0.5 } : m;
    const k = JSON.stringify(q);
    if (k === this.moodKey) return;
    this.moodKey = k;
    this.mood = q;
    this.agents = this.agents.map((a, i) => makeAgent(a.p, i, this.places, q));
  }

  /** Marks from this place's past (set by the app from events). */
  setHistory(h: History): void { this.hist = h; }

  get time(): string {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private w(v: THREE.Vector3): THREE.Vector3 { return v.applyMatrix4(this.city.matrixWorld); }

  private build(ctx: Ctx): void {
    const pl = this.where(ctx);
    const st = styleOf(ctx.world, ctx.snap, pl.body, ctx.year, this.hist);
    const scale = Math.round(Math.log10(1 + pl.count) * 2);
    const placeKey = `${pl.body}:${pl.city}`;
    const I: Infra | null = ctx.snap ? infraOf(ctx.world, ctx.snap, pl.body, ctx.year) : null;
    const key = `${placeKey}:${pl.st}:${scale}:${st.sig}:${infraSig(I)}`;
    if (key === this.key) return;
    // same place, new look: say what changed and let the city rise into its new form
    if (placeKey === this.placeKey && this.style) {
      this.changed = changes(this.style, st);
      if (this.changed) this.changedAt = performance.now();
    } else { this.changed = ''; this.heights.clear(); }
    const morph = placeKey === this.placeKey && this.heights.size > 0;
    const prevHeights = this.heights;
    this.heights = new Map();
    this.growers = []; this.growT = 0;
    this.key = key; this.placeKey = placeKey; this.style = st;
    this.group.clear();
    this.city = new THREE.Group();
    this.city.rotation.y = st.twist;
    this.group.add(this.city);
    this.blockMats = []; this.lampMat = null;
    this.body = pl.body;
    this.blockU = { lit: { value: 0.5 }, night: { value: 0 }, warm: { value: windowColour(st, pl.body) } };
    const keepPeople = this.agents.length > 0 && this.fetchedFor.startsWith(placeKey + ':');
    if (!keepPeople) { this.agents = []; this.pool = []; this.fetchedFor = ''; this.focus = -1; this.follow = -1; }
    this.figures = null; this.glows = null; this.cars = null; this.carLights = null; this.vehicles = [];
    const b = ctx.world.bodies[pl.body];
    this.cityName = pl.city === 0 ? `${b.name} capital` : `${b.name} settlement ${pl.city}`;
    const r = new Rng(pl.body * 131 + pl.city * 7 + 1);
    const gnd = groundOf(b.kind, st.open);
    const outpost = pl.count < 300;
    const R = (this.R = outpost ? 3.2 : Math.min(36, Math.max(5, 3.4 * Math.log10(pl.count) - 3)));
    this.war.attach(this.city, R);
    const big = pl.st >= STAGE.CITY;
    const small = pl.st <= STAGE.BASE || pl.count < 3000;

    const sys = ctx.world.systems[b.system];
    this.sunCol.copy(specColor(sys.spec));
    this.sun = new THREE.DirectionalLight(this.sunCol, 2.4);
    this.hemi = new THREE.HemisphereLight(st.open ? 0x7a96b8 : 0x5a6a88, 0x101014, 1.1);
    this.hemiBase.copy(this.hemi.color);
    this.star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: specColor(sys.spec), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
    this.star.scale.setScalar(R * 0.9);
    this.group.add(this.sun, this.hemi, this.star, makeSky(pl.body + 11, 9000, 'skyst', () => ({ name: this.cityName, x: sys.x, y: sys.y, z: sys.z, sol: sys.id === 0 })));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 6, 96), groundMaterial(gnd.ground, gnd.water));
    ground.rotation.x = -Math.PI / 2;
    this.group.add(ground);
    if (gnd.water) {
      const deck = new THREE.Mesh(new THREE.CircleGeometry(R * 1.06, 96), new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.8 }));
      deck.rotation.x = -Math.PI / 2; deck.position.y = 0.02;
      this.city.add(deck);
    }

    this.tech = peopleTech(I);
    const addInfra = () => {
      if (!I) return;
      const facade = blockMaterial(this.blockU);
      this.blockMats.push(facade);
      // the skyline stands across the settlement from where the camera first looks
      this.infra.build({ infra: I, R, body: pl.body, city: pl.city, style: st, facade, domed: gnd.dome, outpost, camAz: Math.atan2(0.72, 0.36) });
      this.group.add(this.infra.group);
    };
    if (outpost) { this.buildOutpost(pl.body, gnd.dome, st); addInfra(); this.buildPeople(); this.city.updateMatrixWorld(true); return; }

    const shares: [District, number][] = [['homes', 0.55], ['farms', small ? 0.2 : 0.14], ['industry', big ? 0.2 : 0.12], ['port', big ? 0.12 : 0.08]];
    const total = shares.reduce((a, [, wt]) => a + wt, 0);
    let a0 = r.range(0, Math.PI * 2);
    this.districts = shares.map(([d, wt]) => { const a = a0; a0 += (wt / total) * Math.PI * 2; return { d, a0: a, a1: a0 }; });
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

    // lots on a grid; the culture sets how often a street cuts through, the era how regular it is
    const cell = small ? 0.7 : 1.1;
    const G = st.grid;
    this.war.attach(this.city, R, cell * G, cell * 0.3);
    const lots = Math.PI * (R / cell) ** 2 * (1 - 1 / G) ** 2;
    const fill = Math.min(1, pl.count / 40 / lots) * (0.75 + 0.25 * st.wealth);
    const n = Math.ceil(R / cell);
    const boxes: THREE.Matrix4[] = [], boxCol: THREE.Color[] = [], domes: THREE.Matrix4[] = [], domeCol: THREE.Color[] = [], spires: THREE.Matrix4[] = [], spireCol: THREE.Color[] = [];
    const boxKey: string[] = [], domeKey: string[] = [], spireKey: string[] = [];
    const glass: THREE.Matrix4[] = [], parks: THREE.Matrix4[] = [];
    const beacons: number[] = [], lampPos: number[] = [], tall: THREE.Vector3[] = [], bannerAt: THREE.Vector3[] = [];
    const byDistrict: Record<District, THREE.Vector3[]> = { centre: [], homes: [], farms: [], industry: [], port: [] };
    const q = new THREE.Quaternion(), tmp = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    let topH = 1;
    const density = Math.min(1, Math.log10(1 + pl.count) / 9);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = i * cell, z = j * cell, rr = Math.hypot(x, z);
      if (rr > R) continue;
      const ring = Math.abs(rr - R * 0.2) < cell * 0.5 || Math.abs(rr - R * 0.62) < cell * 0.5;
      if (i % G === 0 && j % G === 0 && rr < R * 0.95) byDistrict[districtAt(x, z)].push(new THREE.Vector3(x, 0, z));
      if (i % G === 0 || j % G === 0 || ring) {
        if ((i + j) % 3 === 0) lampPos.push(x, 0.14, z);
        continue;
      }
      const d = districtAt(x, z);
      const h0 = hash01(pl.body, i * 977 + j, pl.city);
      const empty = h0 > fill * 0.9 + 0.02 || hash01(i, j, pl.city, 7) < 0.1;
      // open-air worlds turn empty lots into parks
      if (empty) { if (st.open && d !== 'industry' && d !== 'port') parks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.02, z), q, new THREE.Vector3(cell * 0.9, 0.04, cell * 0.9))); continue; }
      const fall = 1 - rr / R;
      const jx = (hash01(i, j, 31) - 0.5) * cell * st.organic, jz = (hash01(i, j, 32) - 0.5) * cell * st.organic;
      q.setFromAxisAngle(up, (hash01(i, j, 33) - 0.5) * st.organic * 1.5);
      let wd = cell * (0.62 + 0.25 * hash01(i, j, 3)), dd = cell * (0.62 + 0.25 * hash01(i, j, 4)), h: number;
      if (d === 'farms') {
        h = 0.12;
        glass.push(new THREE.Matrix4().compose(new THREE.Vector3(x + jx, h / 2, z + jz), q, new THREE.Vector3(wd, h, dd)));
        continue;
      }
      const hv = hash01(i, j, 9);
      if (d === 'industry') { h = 0.25 + hv * 0.6; wd *= 1.1; tmp.setRGB(0.9, 0.3, 0.2).multiplyScalar(0.3); }
      else if (d === 'port') { h = hv < 0.3 ? 1.5 + hv * 4 : 0.06; tmp.copy(st.body).multiplyScalar(1.1); }
      else if (d === 'centre') { h = Math.min(R * 0.28, (0.8 + hv * 2.5) * (1 + density * 2) * (0.5 + fall)); tmp.copy(st.body).multiplyScalar(1.25); }
      else { h = Math.min(R * 0.16, (0.25 + Math.pow(hv, 2) * (big ? 4 : 1.2)) * (0.4 + fall * density * 2.2)); tmp.copy(st.body); }
      if (d !== 'port' || h > 1) h *= st.height;
      // ruins: short, dark, unlit
      const ruined = hash01(i, j, 41) < st.decay;
      if (ruined) { h *= 0.35; tmp.setRGB(0.07, 0.0, 0.06); }
      else tmp.offsetHSL(0, 0, (hash01(i, j, 5) - 0.5) * 0.03);
      topH = Math.max(topH, h);
      const pos = new THREE.Vector3(x + jx, h / 2, z + jz);
      // the era decides the building's shape
      if (st.arch === 'huts' && d !== 'industry') {
        domes.push(new THREE.Matrix4().compose(pos.setY(0), q, new THREE.Vector3(wd * 0.42, Math.max(0.12, h * 1.2), wd * 0.42)));
        domeCol.push(tmp.clone()); domeKey.push(`${i},${j}`);
      } else if ((st.arch === 'spires' || st.arch === 'light') && h > 1.2 && d !== 'industry') {
        spires.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(wd * 1.05, h, wd * 1.05)));
        spireCol.push(ruined ? tmp.clone() : tmp.clone().multiplyScalar(1.7)); spireKey.push(`${i},${j}`);
        if (!ruined) beacons.push(x + jx, h + 0.06, z + jz);
        if (!ruined && h > 2.2) tall.push(new THREE.Vector3(x + jx, h * 0.62, z + jz));
      } else if (st.quiet && d === 'centre' && h > 1 && hash01(i, j, 81) < 0.5) {
        // data-temples: dark monoliths
        boxes.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(wd * 0.5, h, dd * 1.1)));
        boxCol.push(new THREE.Color(0.03, 0.035, 0.05)); boxKey.push(`${i},${j}`);
      } else {
        boxes.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(wd, h, dd)));
        boxCol.push(tmp.clone()); boxKey.push(`${i},${j}`);
      }
      if (d === 'port' && h > 1) beacons.push(x + jx, h + 0.05, z + jz);
      if (st.banners && d === 'centre' && h > 1 && hash01(i, j, 51) < 0.4) bannerAt.push(new THREE.Vector3(x + jx + wd * 0.52, h * 0.7, z + jz));
    }
    this.topH = topH;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    // each lot remembers its height; on a change, buildings move from old to new height, the centre first
    const instanced = (geo: THREE.BufferGeometry, ms: THREE.Matrix4[], cs: THREE.Color[], keys: string[], centred: boolean) => {
      if (!ms.length) return;
      const mat = blockMaterial(this.blockU);
      this.blockMats.push(mat);
      const im = new THREE.InstancedMesh(geo, mat, ms.length);
      const n = ms.length, gr: Grow = { mesh: im, x: new Float32Array(n), z: new Float32Array(n), sx: new Float32Array(n), sz: new Float32Array(n), from: new Float32Array(n), to: new Float32Array(n), delay: new Float32Array(n), q: [], centred };
      const pp = new THREE.Vector3(), qq = new THREE.Quaternion(), ss = new THREE.Vector3();
      ms.forEach((mm, k) => {
        im.setColorAt(k, cs[k]);
        mm.decompose(pp, qq, ss);
        this.heights.set(keys[k], ss.y);
        gr.x[k] = pp.x; gr.z[k] = pp.z; gr.sx[k] = ss.x; gr.sz[k] = ss.z; gr.to[k] = ss.y; gr.q.push(qq.clone());
        gr.from[k] = morph ? prevHeights.get(keys[k]) ?? 0 : ss.y;
        gr.delay[k] = Math.hypot(pp.x, pp.z) / R * 1.1 + hash01(k, 91) * 0.35;
      });
      this.growers.push(gr);
      applyGrow(gr, morph ? 0 : 99);
      this.city.add(im);
    };
    instanced(boxGeo, boxes, boxCol, boxKey, true);
    instanced(hutGeometry(), domes, domeCol, domeKey, false);
    // grown spires: tapered
    instanced(new THREE.CylinderGeometry(0.28, 0.5, 1, 10), spires, spireCol, spireKey, true);
    if (glass.length) {
      const farmMat = st.mirrors
        ? new THREE.MeshStandardMaterial({ color: 0x5a4a20, emissive: 0xffd27a, emissiveIntensity: 0.1, roughness: 0.3, metalness: 0.6 })
        : new THREE.MeshStandardMaterial({ color: 0x1e3a28, emissive: 0x2c6a3c, emissiveIntensity: 0.22, roughness: 0.3, transparent: true, opacity: 0.85 });
      const farms = new THREE.InstancedMesh(boxGeo, farmMat, glass.length);
      glass.forEach((mm, k) => farms.setMatrixAt(k, mm));
      this.city.add(farms);
    }
    if (parks.length) {
      const pm = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x24402a, roughness: 1 }), parks.length);
      parks.forEach((mm, k) => pm.setMatrixAt(k, mm));
      this.city.add(pm);
    }
    // the civic heart: a dome, an arcology, or a data-temple
    if (st.arcology && big) {
      // a stepped arcology: each tier narrower, its roof a green terrace
      const arc = new THREE.Group(), mat = blockMaterial(this.blockU);
      this.blockMats.push(mat);
      const terrace = new THREE.MeshStandardMaterial({ color: 0x2c4a30, emissive: 0x1d3a22, emissiveIntensity: 0.4, roughness: 0.9 });
      let y = 0;
      for (let k = 0; k < 5; k++) {
        const wd = R * (0.19 - k * 0.032), h = R * (0.05 + k * 0.012);
        const m = new THREE.Mesh(boxGeo, mat);
        m.scale.set(wd, h, wd); m.position.y = y + h / 2;
        const t = new THREE.Mesh(boxGeo, terrace);
        t.scale.set(wd * 1.02, 0.03, wd * 1.02); t.position.y = y + h + 0.015;
        arc.add(m, t);
        y += h;
      }
      arc.rotation.y = Math.PI / 4;
      this.city.add(arc);
      this.topH = Math.max(this.topH, y);
    } else {
      this.city.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.06 + 0.3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: st.roof, roughness: 0.6, metalness: 0.1 })));
    }
    if (st.glassDomes) for (const v of byDistrict.homes.filter((_, k) => k % 7 === 0).slice(0, 8)) {
      // glass over a neighbourhood: faint ribs, no glare
      const gd = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(cell * G * 0.7, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)), new THREE.LineBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
      gd.position.copy(v);
      this.city.add(gd);
    }
    // skyways between tall spires
    if (st.skyways && tall.length > 1) {
      const seg: number[] = [];
      tall.forEach((p, k) => {
        let best = -1, bd = Infinity;
        tall.forEach((o, m) => { const d = p.distanceTo(o); if (m !== k && d < bd && d < cell * G * 2.2) { bd = d; best = m; } });
        if (best > k) seg.push(p.x, p.y, p.z, tall[best].x, tall[best].y, tall[best].z);
      });
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      this.city.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: st.glow, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })));
    }
    // light-farms: mirror canopies tilted to the star above the outer districts
    if (st.mirrors && glass.length) {
      const spots = glass.filter((_, k) => k % 2 === 0).slice(0, 300);
      const mm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.04), new THREE.MeshStandardMaterial({ color: 0xeadcb8, metalness: 1, roughness: 0.06, emissive: 0x2a1e08 }), spots.length);
      const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 4), new THREE.MeshStandardMaterial({ color: 0x55504a, metalness: 0.6, roughness: 0.5 }), spots.length);
      const face = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.88, -0.47).normalize());
      const pp = new THREE.Vector3(), qq = new THREE.Quaternion(), ss = new THREE.Vector3();
      spots.forEach((mm4, k) => {
        mm4.decompose(pp, qq, ss);
        const hgt = 0.55 + hash01(k, 63) * 0.15;
        mm.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(pp.x, hgt, pp.z), face, new THREE.Vector3(ss.x * 0.9, ss.z * 0.6, 1)));
        posts.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(pp.x, hgt / 2, pp.z), new THREE.Quaternion(), new THREE.Vector3(1, hgt, 1)));
      });
      this.city.add(mm, posts);
    }
    // solar fields outside the ring in the early years
    if (st.solar) {
      const nS = 120, sm = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x14233a, metalness: 0.7, roughness: 0.25, emissive: 0x0a1420 }), nS);
      q.setFromEuler(new THREE.Euler(-0.5, 0, 0));
      for (let k = 0; k < nS; k++) {
        const ang = (k / nS) * Math.PI * 1.2 + 2.2, rr = R * 1.12 + (k % 3) * 0.45;
        sm.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(ang) * rr, 0.1, Math.sin(ang) * rr), q, new THREE.Vector3(0.35, 0.02, 0.22)));
      }
      this.city.add(sm);
    }
    // water: a canal ring on open worlds
    if (st.open) {
      const canal = new THREE.Mesh(new THREE.RingGeometry(R * 0.38, R * 0.41, 160), new THREE.MeshStandardMaterial({ color: 0x0c2a44, metalness: 0.6, roughness: 0.15 }));
      canal.rotation.x = -Math.PI / 2; canal.position.y = 0.025;
      this.city.add(canal);
    }
    // banners of the faith, monuments to what happened here
    if (bannerAt.length) {
      const bm = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: st.roof, emissive: st.roof, emissiveIntensity: 0.5 }), bannerAt.length);
      bannerAt.forEach((v, k) => bm.setMatrixAt(k, new THREE.Matrix4().compose(v, new THREE.Quaternion(), new THREE.Vector3(0.02, 0.5, 0.16))));
      this.city.add(bm);
    }
    for (let k = 0; k < st.monuments; k++) {
      const ob = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.12, 2.2, 4), new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.4, emissive: 0x222018 }));
      ob.position.set(R * 0.1 * (k ? -1 : 1), 1.1, R * 0.12);
      const crown = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: st.glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      crown.position.set(ob.position.x, 2.25, ob.position.z); crown.scale.setScalar(0.6);
      this.city.add(ob, crown);
    }
    if (beacons.length) this.city.add(pointsFrom(beacons, beacons.map((_, k) => [0.4, 0.85, 1][k % 3]), 0.4, 5));
    if (lampPos.length) {
      const lamps = pointsFrom(lampPos, Array.from({ length: lampPos.length }, (_, k) => [st.glow.r, st.glow.g, st.glow.b][k % 3]), 0.18, 3);
      this.lampMat = lamps.material as THREE.ShaderMaterial;
      this.city.add(lamps);
    }
    // paved streets, kerbs and a tiled plaza, turned with the culture's grid
    const pave = new THREE.Mesh(new THREE.CircleGeometry(R * 1.04, 160), pavingMaterial(new THREE.Color(gnd.ground).lerp(new THREE.Color(0x4c4a48), 0.6), cell, G, R, this.blockU.night, this.blockU.warm));
    pave.rotation.x = -Math.PI / 2; pave.position.y = gnd.water ? 0.026 : 0.006;
    this.city.add(pave);

    if (gnd.dome) {
      this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 1.04, 36, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
        new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })));
    }
    if ((pl.st >= STAGE.MEGA && alive(pl.st)) || st.spinHabs) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 2.8, R * 0.05, 10, 240), new THREE.MeshStandardMaterial({ color: 0x8b909a, roughness: 0.5, metalness: 0.5, emissive: 0x1a2230 }));
      ring.position.set(0, R * 0.4, -R * 1.2);
      ring.rotation.set(1.15, 0.2, 0);
      this.group.add(ring);
    }

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
    addInfra();
    this.buildVehicles(pl.st, b.g, gnd.dome, at);
    this.buildPeople();
    if (keepPeople) this.agents = this.agents.map((a, i) => makeAgent(a.p, i, this.places, this.mood));
    this.city.updateMatrixWorld(true);
  }

  /** Under ~300 people: a ring of habitat modules round a small dome, and a landing pad. */
  private buildOutpost(body: number, dome: boolean, st: Style): void {
    const mat = new THREE.MeshStandardMaterial({ color: st.body.clone().multiplyScalar(2.6), roughness: 0.6, metalness: 0.3 });
    const geo = st.arch === 'huts' ? hutGeometry().scale(0.32, 0.32, 0.32) : new THREE.CylinderGeometry(0.22, 0.22, 0.75, 16);
    const mods: THREE.Vector3[] = [];
    const win: number[] = [], col: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + hash01(body, i) * 0.3, rr = 1 + (i % 2) * 0.55;
      const m = new THREE.Mesh(geo, mat);
      if (st.arch !== 'huts') { m.rotation.z = Math.PI / 2; m.position.y = 0.22; }
      m.rotation.y = -a;
      m.position.x = Math.cos(a) * rr; m.position.z = Math.sin(a) * rr;
      this.city.add(m);
      win.push(m.position.x, 0.3, m.position.z);
      col.push(st.glow.r, st.glow.g, st.glow.b);
      mods.push(new THREE.Vector3(Math.cos(a) * (rr - 0.45), 0, Math.sin(a) * (rr - 0.45)));
    }
    this.city.add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8d97a6, roughness: 0.5, metalness: 0.2 })));
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32), new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(2.4, 0.02, 0.6);
    this.city.add(pad);
    if (st.solar) {
      const sm = new THREE.MeshStandardMaterial({ color: 0x14233a, metalness: 0.7, roughness: 0.25 });
      for (let k = 0; k < 10; k++) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), sm); p.position.set(-2.3 + (k % 5) * 0.34, 0.1, -1.2 - Math.floor(k / 5) * 0.3); p.rotation.x = -0.5; this.city.add(p); }
    }
    win.push(2.4, 0.08, 0.6, 2.95, 0.05, 0.6, 1.85, 0.05, 0.6);
    col.push(0.4, 0.85, 1, 0.4, 0.85, 1, 0.4, 0.85, 1);
    this.city.add(pointsFrom(win, col, 0.5, 5));
    if (dome) this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(this.R * 0.7, 28, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false })));
    this.topH = 0.8;
    const hub = [new THREE.Vector3(0.7, 0, 0)], padV = [new THREE.Vector3(2.2, 0, 0.6)];
    this.places = { node: mods, homes: mods, ring: 1.3, R: 3, at: { works: hub, reactor: hub, mine: padV, farms: hub, port: padV, labs: hub, hall: hub, hospital: hub, school: hub, plaza: hub, market: hub, temple: hub, depot: hub } };
    this.districts = [];
  }

  /** Trams on the ring roads (sealed tube-ways under a dome, hoppers on low-gravity moons), cargo crawlers between the works and the port. */
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
    this.cars = new THREE.InstancedMesh(new THREE.BoxGeometry(hopper ? 0.26 : 0.46, 0.13, 0.15), new THREE.MeshStandardMaterial({ color: 0x5a6676, roughness: 0.35, metalness: 0.4, emissive: 0x6a8cae, emissiveIntensity: 0.18 }), this.vehicles.length);
    this.cars.frustumCulled = false;
    this.carLights = dotCloud(this.vehicles.length, 1.6, 8);
    this.city.add(this.cars, this.carLights.pts);
    if (tubes) for (const rr of [R * 0.2, R * 0.62]) {
      const tube = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.11, 8, 160), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
      tube.rotation.x = Math.PI / 2; tube.position.y = 0.08;
      this.city.add(tube);
    }
  }

  private buildPeople(): void {
    const geo = personGeometry();
    this.walk = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AGENTS * 2), 2);
    this.walk.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aWalk', this.walk);
    this.figures = new THREE.InstancedMesh(geo, personMaterial(), MAX_AGENTS);
    this.figures.castShadow = false;
    this.prevX = new Float32Array(MAX_AGENTS); this.prevZ = new Float32Array(MAX_AGENTS); this.heading = new Float32Array(MAX_AGENTS);
    this.figures.count = 0;
    this.figures.frustumCulled = false;
    this.glows = dotCloud(MAX_AGENTS, 2, 9);
    this.city.add(this.figures, this.glows.pts);
  }

  sync(ctx: Ctx): void {
    this.build(ctx);
    if (this.style && this.body >= 0) this.blockU.warm.value.copy(windowColour(this.style, this.body));
    // reframe when the place grows or shrinks a lot, or when its skyline arrives just after we got here (the run caught up)
    const low = this.infra.topH > this.R * 0.3 ? 0.3 : 0;
    if (Math.abs(this.R - this.framedR) > this.framedR * 0.3 || (low !== this.framedLow && performance.now() - this.framedAt < 6000)) this.frameCamera(ctx);
    const pl = this.where(ctx);
    if (!alive(pl.st)) return;
    const want = `${pl.body}:${pl.city}:${Math.floor(ctx.year / 10)}`;
    if (want !== this.fetchedFor) { this.fetchedFor = want; this.agents = []; this.pool = []; this.nextOffset = 0; }
    this.fill(ctx);
    this.keepFollow(ctx);
  }

  /** If the app follows someone who lives here, make them an agent the camera shadows. */
  private keepFollow(ctx: Ctx): void {
    if (!this.followPid || !this.fetchPerson) return;
    const key = `${this.fetchedFor}:${this.followPid}`;
    if (this.followKey === key) return;
    const k = this.agents.findIndex((a) => a.p.id === this.followPid);
    if (k >= 0) { this.followKey = key; this.focus = this.follow = k; return; }
    this.followKey = key;
    const pid = this.followPid, year = ctx.year;
    this.fetchPerson(pid, year).then((m) => {
      if (this.followPid !== pid || this.followKey !== key) return;
      if (m.pending) { window.setTimeout(() => { if (this.followKey === key) this.followKey = ''; }, 900); return; }
      const b = m.bio;
      // they're not (or no longer) here: unborn, dead, moved away, or mid-voyage
      if (!b || !b.alive || b.where?.body !== this.where(ctx).body) { this.dropAgent(pid); return; }
      this.inject(b);
    });
  }

  private inject(p: PersonBrief): void {
    let k = this.agents.findIndex((a) => a.p.id === p.id);
    if (k < 0) k = Math.min(this.agents.length, MAX_AGENTS - 1);
    this.agents[k] = makeAgent(p, k, this.places, this.mood);
    this.focus = this.follow = k;
  }

  private dropAgent(pid: string): void {
    const k = this.agents.findIndex((a) => a.p.id === pid);
    if (k < 0) return;
    this.agents.splice(k, 1);
    if (this.follow === k) this.follow = -1; else if (this.follow > k) this.follow--;
    if (this.focus === k) this.focus = -1; else if (this.focus > k) this.focus--;
  }

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

  frame(ctx: Ctx, dt: number): void {
    // a city that has just changed grows into its new form, building by building
    if (this.growers.length && this.growT < 2.4) { this.growT += dt; for (const g of this.growers) applyGrow(g, this.growT); }
    this.hour = ((ctx.t / DAY_SECONDS) * 24 + 7) % 24;
    const sunUp = Math.sin(((this.hour - 6) / 12) * Math.PI);
    const day = Math.max(0, sunUp), night = Math.min(1, Math.max(0, 0.35 - sunUp * 1.6));
    if (this.sun) {
      const az = ((this.hour - 6) / 12) * Math.PI;
      this.sun.position.set(Math.cos(az) * this.R * 2, Math.max(0.05, sunUp) * this.R * 2, -this.R * 0.8);
      this.sun.intensity = 0.08 + day * 1.6;
      // the light warms toward dawn and dusk
      this.sun.color.copy(this.sunCol).lerp(DUSK, Math.max(0, 1 - sunUp * 2.2) * 0.7);
      this.hemi!.intensity = 0.25 + day * 0.6;
      this.star!.position.copy(this.sun.position).setLength(this.R * 9);
      this.star!.visible = sunUp > -0.1;
    }
    const lit = (0.12 + 0.45 * night) * (this.style?.quiet ? 0.6 : 1) * (0.6 + 0.4 * (this.style?.wealth ?? 0.5));
    this.blockU.lit.value = lit;
    this.blockU.night.value = Math.min(1, night * 2.2);
    if (this.lampMat) this.lampMat.uniforms.uOpacity.value = 0.15 + 0.85 * night;
    this.infra.frame(ctx.t, night);

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

    if (this.figures && this.glows) {
      const near = ctx.camera.position.distanceTo(ctx.controls.target) < Math.max(14, this.R * 1.05);
      const st = this.style;
      // drawn nearly twice life size against the blocks, so a resident reads as a person from the street view
      const tall = (st?.figure.tall ?? 1) * FIGURE, slim = (st?.figure.slim ?? 1) * FIGURE;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(slim, tall, slim), kidS = new THREE.Vector3(slim * 0.75, tall * 0.7, slim * 0.75), zero = new THREE.Vector3(0, 0, 0), p = new THREE.Vector3(), c = new THREE.Color(), upv = new THREE.Vector3(0, 1, 0);
      (this.figures.material as THREE.MeshStandardMaterial).userData.time.value = ctx.t;
      const walk = this.walk!.array as Float32Array;
      // a world at war: the battle, the rockets, the sky lit by fires
      this.war.material.userData.time.value = ctx.t;
      this.war.update(ctx.world, ctx.snap, this.body, ctx.year, ctx.t, Math.min(1, night * 2.2), near, tall);
      if (this.hemi) {
        this.hemi.color.copy(this.hemiBase).lerp(RAID_SKY, this.war.raid * 0.7);
        this.hemi.intensity += this.war.raid * 0.35;
      }
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
        if (!a.patrol) this.war.shelter(a, k);
        const kid = a.p.age < 16;
        if (a.patrol) c.setRGB(1, 0.42, 0.35);
        else if (this.mood.plague) c.setRGB(0.8, 0.95, 0.85);
        else if (kid) c.setRGB(0.75, 0.9, 1);
        else c.setRGB(1, 0.86, 0.68);
        // clothes in the culture's colours, each person their own shade
        if (st && !a.patrol) c.copy(st.cloth).offsetHSL((hash01(k, 71) - 0.5) * 0.3, (hash01(k, 72) - 0.5) * 0.3, (hash01(k, 73) - 0.5) * 0.35);
        if (this.mood.plague && !a.patrol) c.lerp(new THREE.Color(0.85, 0.95, 0.88), 0.5);
        // in a high-tech age some of the walkers are machines (brushed steel, a cyan eye), and clothes carry light
        const robot = !kid && !a.patrol && hash01(k, 79) < this.tech.robots;
        if (robot) c.setRGB(0.62, 0.68, 0.78);
        else if (this.tech.neon > 0 && !a.patrol) c.lerp(NEON[k % NEON.length], 0.25 * this.tech.neon);
        if (k === this.focus) c.setRGB(0.5, 0.92, 1);
        // face the way they're going; swing limbs when walking
        const dx = a.x - this.prevX[k], dz = a.z - this.prevZ[k], moved = Math.hypot(dx, dz);
        if (moved > 1e-4 && moved < 0.5) this.heading[k] = Math.atan2(dx, dz);
        this.prevX[k] = a.x; this.prevZ[k] = a.z;
        q.setFromAxisAngle(upv, this.heading[k]);
        walk[k * 2] = hash01(k, 74); walk[k * 2 + 1] = moved > 1e-4 && moved < 0.5 ? 1 : 0;
        m.compose(p.set(a.x, 0, a.z), q, a.vis && near ? (kid ? kidS : s) : zero);
        this.figures.setMatrixAt(k, m);
        this.figures.setColorAt(k, c);
        this.glows.pos.set([a.x, robot ? 0.2 : 0.09, a.z], k * 3);
        if (robot) this.glows.col.set([0.3, 0.9, 1], k * 3);
        else if (this.tech.neon > 0) this.glows.col.set([c.r * 1.3, c.g * 1.3, c.b * 1.3], k * 3);
        else this.glows.col.set([c.r, c.g, c.b], k * 3);
        this.glows.size[k] = a.vis ? (k === this.focus ? 2.6 + 0.6 * Math.sin(ctx.t * 4) : near ? (robot ? 0.45 : 0.3 + 0.25 * this.tech.neon) : 0.9) : 0;
      }
      this.figures.count = n;
      this.walk!.needsUpdate = true;
      this.figures.instanceMatrix.needsUpdate = true;
      if (this.figures.instanceColor) this.figures.instanceColor.needsUpdate = true;
      this.glows.pts.geometry.setDrawRange(0, n);
      flag(this.glows);

      const f = this.agents[this.follow];
      if (f) {
        const goal = this.w(new THREE.Vector3(f.x, 0.1, f.z));
        const d = goal.sub(ctx.controls.target).multiplyScalar(0.08);
        ctx.controls.target.add(d);
        ctx.camera.position.add(d);
      }
    }
  }

  personId(k: number): string | null { return this.agents[k]?.p.id ?? null; }

  pickables(): Pickable[] {
    const out: Pickable[] = [];
    this.agents.forEach((a, k) => {
      if (!a.vis) return;
      out.push({ pos: this.w(new THREE.Vector3(a.x, 0.08, a.z)), kind: 'person', id: k, name: `${a.p.name}, ${Math.floor(a.p.age)}, ${a.p.job} · ${a.doing}`, weight: k === this.focus ? 4 : 0 });
    });
    return out;
  }

  locate(ctx: Ctx, r: Ref): THREE.Vector3 | null {
    const a = r.kind === 'person' ? this.agents[r.id] : undefined;
    if (a) return this.w(new THREE.Vector3(a.x, 0.08, a.z));
    if (r.kind === 'city' && r.id === ctx.city) return new THREE.Vector3();
    return null;
  }

  diveDist(): number { return 0; }

  labels(ctx: Ctx): Label[] {
    const pl = this.where(ctx);
    const top = this.w(new THREE.Vector3(0, this.topH + 0.8, 0));
    const out: Label[] = [{ pos: top, text: this.cityName, sub: alive(pl.st) ? `${pl.count.toLocaleString('en-US')} people · ${this.time} · ${this.style ? ARCH_NAME[this.style.arch] : ''}` : 'no one lives here now', strong: true, prio: 10 }];
    // what changed here, for a few seconds after the city morphs
    if (this.changed && performance.now() - this.changedAt < 9000) out.push({ pos: top.clone().setY(top.y + this.R * 0.25 + 2), text: `${Math.round(2040 + ctx.year)}: what changed here`, sub: this.changed, strong: true, prio: 11 });
    for (const s of this.districts) {
      const th = (s.a0 + s.a1) / 2;
      out.push({ pos: this.w(new THREE.Vector3(Math.cos(th) * this.R * 0.8, 0.4, Math.sin(th) * this.R * 0.8)), text: DISTRICT_NAMES[s.d], prio: 2 });
    }
    const wl = this.war.label();
    if (wl) out.push({ pos: this.w(wl.pos), text: wl.text, sub: wl.sub, strong: true, prio: 13 });
    const f = this.agents[this.follow];
    if (f) out.push({ pos: this.w(new THREE.Vector3(f.x, 0.35, f.z)), text: f.p.name, sub: f.doing, strong: true, prio: 12 });
    return out;
  }
}

const FIGURE = 1.8;
const NEON = [new THREE.Color(0.3, 0.85, 1), new THREE.Color(1, 0.35, 0.85), new THREE.Color(0.55, 1, 0.6), new THREE.Color(1, 0.75, 0.3)];
const DUSK = new THREE.Color(1, 0.55, 0.3);
const RAID_SKY = new THREE.Color(1, 0.36, 0.14);
const cultC = new THREE.Color();
/** Lit-window colour: the era's lamp colour, pulled toward the society's own light once the worker has sent its look. */
function windowColour(st: Style, body: number): THREE.Color {
  const out = st.glow.clone();
  const look = societyLook(body);
  if (look) out.lerp(cultureLight(look, cultC), 0.55);
  return out;
}

const gm = new THREE.Matrix4(), gp = new THREE.Vector3(), gs = new THREE.Vector3();
/** Set each instance's height for `t` seconds into a change. */
function applyGrow(g: Grow, t: number): void {
  for (let k = 0; k < g.to.length; k++) {
    const u = Math.min(1, Math.max(0, (t - g.delay[k]) / 0.7)), e = 1 - (1 - u) ** 3;
    const h = g.from[k] + (g.to[k] - g.from[k]) * e;
    gp.set(g.x[k], g.centred ? h / 2 : 0, g.z[k]);
    gs.set(h > 1e-3 ? g.sx[k] : 0, Math.max(h, 1e-4), h > 1e-3 ? g.sz[k] : 0);
    g.mesh.setMatrixAt(k, gm.compose(gp, g.q[k], gs));
  }
  g.mesh.instanceMatrix.needsUpdate = true;
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
