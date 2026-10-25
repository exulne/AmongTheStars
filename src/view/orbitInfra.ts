// Orbital infrastructure around one world in the planet view, from the
// infrastructure model (src/sim/infra.ts): what this world has built in orbit
// given its people, product, military and the technologies that have reached
// it. Constellations on Walker shells (laser-linked once laserComms arrives),
// polar survey satellites, crewed stations, space solar power satellites
// beaming down, asteroid tugs bringing rocks in, shipyards with a hull on the
// slips, defence platforms in the faction's colours, a low orbital ring with
// its spokes, and shuttles running between the spaceports and the stations.
// Habitats, Bishop rings and the swarm stay with Orbitals (orbitals.ts); Earth's
// simulated fleet stays with EarthOrbitLayers (orbitLayers.ts).
//
// View only. Geometry is rebuilt when the counts change; motion is per frame.

import * as THREE from 'three';
import { TECHS } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { infraOf, type Infra } from '../sim/infra.ts';
import { F, NF } from '../sim/metrics.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';
import { addCpuSet, addGpuSet, nearestPoint } from '../explain/picker.ts';
import { explainSats } from '../explain/worlds.ts';
import { pointWorld, registerExplainer, type ExCtx, type Explanation } from '../explain/registry.ts';
import { factionColor } from './colorModes.ts';
import { pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';

const R0 = 10; // the planet's radius in the view
const RING_R = 11.6; // the orbital ring's radius
const techName = (id: string) => TECHS.find((t) => t.id === id)?.name ?? id;

const METAL = new THREE.MeshStandardMaterial({ color: 0xd4dae2, metalness: 0.5, roughness: 0.35, emissive: 0x2a3038, emissiveIntensity: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.8, roughness: 0.45 });
const SOLAR = new THREE.MeshStandardMaterial({ color: 0x1d3f7a, metalness: 0.4, roughness: 0.3, emissive: 0x0a1a3a, emissiveIntensity: 0.6, side: THREE.DoubleSide });
const POWER = new THREE.MeshStandardMaterial({ color: 0x2a3d6e, metalness: 0.9, roughness: 0.2, emissive: 0x2a4c9a, emissiveIntensity: 0.7, side: THREE.DoubleSide });
const ROCK = new THREE.MeshStandardMaterial({ color: 0x6d6258, roughness: 0.95, metalness: 0.05 });
const HULL = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.55, roughness: 0.35, emissive: 0x111418, emissiveIntensity: 0.4 });
const LATTICE = new THREE.LineBasicMaterial({ color: 0x8fa4b8, transparent: true, opacity: 0.55, depthWrite: false });

interface Sat { R: number; inc: number; node: number; phase: number; w: number; shell: number }
interface Miner { R0: number; th: number; inc: number; period: number; off: number }

/** Lines with per-vertex colour, drawn additively, filled each frame. */
function lineBuf(n: number, opacity = 1): { lines: THREE.LineSegments; pos: Float32Array; col: Float32Array } {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false;
  g.setDrawRange(0, 0);
  return { lines, pos, col };
}
function points(n: number, minPx = 1, maxPx = 6): { pts: THREE.Points; pos: Float32Array; col: Float32Array; size: Float32Array } {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(g, pointsMaterial({ minPx, maxPx }));
  pts.frustumCulled = false;
  return { pts, pos, col, size };
}
function touch(o: THREE.LineSegments | THREE.Points, n: number, verts: number): void {
  const g = o.geometry;
  g.setDrawRange(0, n * verts);
  for (const k of ['position', 'color', 'size']) if (g.attributes[k]) g.attributes[k].needsUpdate = true;
}

/** A satellite's place on its orbit at time t. */
function satAt(s: Sat, t: number, out: THREE.Vector3): THREE.Vector3 {
  const th = s.phase + s.w * t;
  out.set(Math.cos(th) * s.R, 0, Math.sin(th) * s.R);
  const y = out.z * Math.sin(s.inc), z = out.z * Math.cos(s.inc);
  out.z = z; out.y = y;
  const c = Math.cos(s.node), sn = Math.sin(s.node), x = out.x;
  out.x = x * c + out.z * sn; out.z = -x * sn + out.z * c;
  return out;
}

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tq = new THREE.Quaternion(), tm4 = new THREE.Matrix4(), ts = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

export interface InfraLabel { pos: THREE.Vector3; text: string; sub?: string; ex: string }

export class OrbitInfra {
  private key = '';
  private body = -1;
  private infra: Infra | null = null;
  /** what was added where, to remove on rebuild */
  private inOrbit: THREE.Object3D[] = []; private onPivot: THREE.Object3D[] = []; private inGroup: THREE.Object3D[] = [];
  private orbit: THREE.Group | null = null; private pivot: THREE.Group | null = null; private group: THREE.Group | null = null;
  private faction = new THREE.Color();
  // constellation
  private sats: Sat[] = [];
  private satPts: ReturnType<typeof points> | null = null;
  private links: [number, number, number][] = []; // a, b, 1 = along the plane
  private linkBuf: ReturnType<typeof lineBuf> | null = null;
  // stations, power, defence, yards
  private stations: THREE.Group[] = [];
  private power: { mesh: THREE.Group; R: number; th: number }[] = [];
  private beams: ReturnType<typeof lineBuf> | null = null;
  private defence: THREE.InstancedMesh | null = null;
  private defSlots: { R: number; th: number; inc: number; w: number }[] = [];
  private defLights: ReturnType<typeof points> | null = null;
  private yards: { g: THREE.Group; hull: THREE.Mesh }[] = [];
  private sparks: ReturnType<typeof points> | null = null;
  // miners
  private miners: Miner[] = [];
  private rocks: THREE.InstancedMesh | null = null;
  private tugs: ReturnType<typeof points> | null = null;
  private tugTrails: ReturnType<typeof lineBuf> | null = null;
  // orbital ring
  private ring: THREE.Group | null = null;
  private ringLights: ReturnType<typeof points> | null = null;
  // traffic
  private ports: () => THREE.Vector3[] = () => [];
  private traffic: ReturnType<typeof points> | null = null;
  private trafficTrails: ReturnType<typeof lineBuf> | null = null;

  /** Rebuild when what this world has in orbit changes. `ports()`: spaceport (city) positions on the pivot. */
  sync(orbit: THREE.Group, pivot: THREE.Group, group: THREE.Group, world: World, snap: StateMsg | null, body: number, year: number, on: boolean, ports: () => THREE.Vector3[]): void {
    this.ports = ports;
    const I = snap && on ? infraOf(world, snap, body, year) : null;
    const f = snap ? snap.S[body * NF + F.faction] : -1;
    const isEarth = body === world.earth;
    const key = I ? `${body}:${f}:${isEarth}:${JSON.stringify(I.orbit)}:${I.surface.spaceports}` : `${body}:none`;
    if (key === this.key && orbit === this.orbit) return;
    this.clear();
    this.key = key; this.body = body; this.infra = I;
    this.orbit = orbit; this.pivot = pivot; this.group = group;
    if (!I) return;
    factionColor(f, world.earth, this.faction);
    const O = I.orbit;
    // Earth's own fleet is simulated shell by shell (orbitLayers.ts); elsewhere the model's constellations
    if (!isEarth) this.buildConstellation(O.comms, O.laserLinks, O.observation);
    else if (O.laserLinks) this.buildConstellation(Math.min(240, O.comms), true, 0, true);
    if (O.stations) this.buildStations(O.stations);
    if (O.power) this.buildPower(O.power);
    if (O.defence) this.buildDefence(O.defence);
    if (O.shipyards) this.buildYards(O.shipyards);
    if (O.miners) this.buildMiners(O.miners);
    if (O.orbitalRing) this.buildRing();
    if (I.surface.spaceports) this.buildTraffic(Math.min(72, I.surface.spaceports * 5 + O.stations * 2 + O.shipyards * 4));
    this.register();
  }

  private clear(): void {
    for (const o of this.inOrbit) this.orbit?.remove(o);
    for (const o of this.onPivot) this.pivot?.remove(o);
    for (const o of this.inGroup) this.group?.remove(o);
    for (const o of [...this.inOrbit, ...this.onPivot, ...this.inGroup]) o.traverse((c) => { (c as THREE.Mesh).geometry?.dispose(); });
    this.inOrbit = []; this.onPivot = []; this.inGroup = [];
    this.sats = []; this.satPts = null; this.links = []; this.linkBuf = null;
    this.stations = []; this.power = []; this.beams = null; this.defence = null; this.defSlots = []; this.defLights = null;
    this.yards = []; this.sparks = null; this.miners = []; this.rocks = null; this.tugs = null; this.tugTrails = null;
    this.ring = null; this.ringLights = null; this.traffic = null; this.trafficTrails = null;
    this.infra = null;
  }

  // ---------------------------------------------------------------- builders

  /** Walker constellations: several shells, each of evenly spaced planes of evenly spaced satellites. */
  private buildConstellation(comms: number, laser: boolean, obs: number, linksOnly = false): void {
    const b = this.body;
    const shells = [
      { R: 10.5, inc: 0.93, share: 0.45, col: [0.78, 0.88, 1] },
      { R: 10.75, inc: 1.22, share: 0.2, col: [0.78, 0.88, 1] },
      { R: 11.4, inc: 0.6, share: 0.2, col: [0.7, 0.95, 1] },
      { R: 12.7, inc: 0.96, share: 0.15, col: [0.6, 1, 0.7] }, // navigation, higher up
    ];
    const cols: number[][] = [];
    shells.forEach((sh, si) => {
      const n = Math.max(4, Math.round(comms * sh.share));
      const planes = Math.max(3, Math.round(Math.sqrt(n) / 1.4)), per = Math.ceil(n / planes);
      const w = 0.35 * Math.pow(R0 / sh.R, 1.5);
      const start = this.sats.length;
      for (let p = 0; p < planes; p++) for (let k = 0; k < per && this.sats.length - start < n; k++) {
        this.sats.push({ R: sh.R + (hash01(b, si, p, 1) - 0.5) * 0.05, inc: sh.inc, node: (p / planes) * Math.PI * 2 + si, phase: (k / per) * Math.PI * 2 + (p * Math.PI) / (planes * per), w, shell: si });
        cols.push(sh.col);
        if (laser) {
          const i = this.sats.length - 1;
          // along the plane to the next satellite, and across to the same slot in the next plane
          this.links.push([i, k === per - 1 || this.sats.length - start >= n ? i - k : i + 1, 1]);
          if (p < planes - 1 && k + per < n) this.links.push([i, i + per, 0]);
        }
      }
    });
    // polar survey and science satellites
    for (let i = 0; i < obs; i++) {
      this.sats.push({ R: 10.62 + hash01(b, i, 2) * 0.15, inc: Math.PI / 2 - 0.08, node: hash01(b, i, 3) * Math.PI * 2, phase: hash01(b, i, 4) * Math.PI * 2, w: 0.33, shell: 4 });
      cols.push([1, 0.82, 0.45]);
    }
    if (!linksOnly || laser) {
      const P = points(this.sats.length, 1.4, 4);
      this.sats.forEach((s, i) => { P.col.set(cols[i], i * 3); P.size[i] = s.shell === 4 ? 0.3 : s.shell === 3 ? 0.26 : 0.22; });
      if (linksOnly) (P.pts.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.6;
      this.satPts = P;
      this.add(this.inOrbit, P.pts);
      if (!linksOnly) explainSats('sat', P.pts, () => this.body);
    }
    if (this.links.length) {
      this.linkBuf = lineBuf(this.links.length);
      this.add(this.inOrbit, this.linkBuf.lines);
    }
  }

  /** Crewed stations: a spine of modules, a truss, two pairs of solar wings, a radiator. */
  private buildStations(n: number): void {
    const b = this.body;
    for (let i = 0; i < Math.min(n, 12); i++) {
      const g = new THREE.Group();
      const big = i === 0 ? 1.6 : 1;
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 10), METAL);
      core.rotation.z = Math.PI / 2;
      const mod = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), METAL);
      const truss = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.5), DARK);
      g.add(core, mod, truss);
      for (const z of [-0.2, 0.2]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), SOLAR);
        wing.position.set(0, 0, z); wing.rotation.x = Math.PI / 2;
        g.add(wing);
      }
      const rad = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.05), new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.6, side: THREE.DoubleSide }));
      rad.position.set(0.06, 0.05, 0);
      g.add(rad);
      g.scale.setScalar(big);
      const R = 11.2 + hash01(b, i, 11) * 0.9, th = hash01(b, i, 12) * Math.PI * 2, inc = (hash01(b, i, 13) - 0.5) * 0.7;
      g.position.set(Math.cos(th) * R, Math.sin(inc) * R * 0.5, Math.sin(th) * R);
      g.userData = { R, th, inc, w: 0.3 * Math.pow(R0 / R, 1.5), spin: hash01(b, i, 14) };
      this.stations.push(g);
      this.add(this.inOrbit, g);
    }
  }

  /** Space solar power: kilometre-scale panels high up, each beaming microwaves to a rectenna below. */
  private buildPower(n: number): void {
    const b = this.body;
    const shown = Math.min(n, 18);
    for (let i = 0; i < shown; i++) {
      const g = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4, 4, 2), POWER);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.8, 0.4, 4, 2)), new THREE.LineBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.5 }));
      const emitter = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 12), METAL);
      emitter.rotation.x = Math.PI / 2; emitter.position.z = 0.08;
      g.add(panel, edge, emitter);
      const R = 16 + hash01(b, i, 21) * 2.5, th = (i / shown) * Math.PI * 2 + hash01(b, i, 22) * 0.3;
      g.position.set(Math.cos(th) * R, (hash01(b, i, 23) - 0.5) * 0.6, Math.sin(th) * R);
      // the emitter faces the planet; the panel stands broadside to the sun
      g.lookAt(0, 0, 0);
      this.power.push({ mesh: g, R, th });
      this.add(this.inOrbit, g);
    }
    this.beams = lineBuf(shown * 6);
    this.add(this.inOrbit, this.beams.lines);
  }

  /** Defence platforms: armoured hexagonal hulls with turrets, in a guarded band; faction lights blink on them. */
  private buildDefence(n: number): void {
    const b = this.body, m = Math.min(n, 36);
    const hull = new THREE.CylinderGeometry(0.07, 0.08, 0.04, 6);
    const turret = new THREE.ConeGeometry(0.015, 0.09, 6).rotateZ(Math.PI / 2).translate(0.07, 0.03, 0);
    const geo = mergeGeo([hull, turret, turret.clone().rotateY(Math.PI * 2 / 3), turret.clone().rotateY(-Math.PI * 2 / 3)]);
    this.defence = new THREE.InstancedMesh(geo, DARK, m);
    this.defence.frustumCulled = false;
    for (let i = 0; i < m; i++) this.defSlots.push({ R: 12.5 + hash01(b, i, 31) * 0.7, th: (i / m) * Math.PI * 2, inc: 0.35 + (i % 2) * -0.7, w: 0.22 });
    this.defLights = points(m * 2, 1.2, 5);
    this.add(this.inOrbit, this.defence, this.defLights.pts);
  }

  /** Shipyards: an open lattice dock with a hull under construction and welding sparks. */
  private buildYards(n: number): void {
    const b = this.body;
    for (let i = 0; i < Math.min(n, 8); i++) {
      const g = new THREE.Group();
      const L = 0.7, W = 0.22;
      const box = new THREE.BoxGeometry(W, W, L, 1, 1, 5);
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), LATTICE));
      for (let k = 0; k <= 5; k++) {
        const rib = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, W)), LATTICE);
        rib.position.z = -L / 2 + (k / 5) * L;
        g.add(rib);
      }
      // the hull grows along the dock; a bridge and drive on a finished one
      const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.5, 6, 12).rotateX(Math.PI / 2), HULL);
      g.add(hull);
      const lamp = new THREE.PointLight(0xffd9a0, 0.6, 1.5);
      g.add(lamp);
      const R = 13.8 + hash01(b, i, 41) * 0.8, th = hash01(b, i, 42) * Math.PI * 2;
      g.position.set(Math.cos(th) * R, (hash01(b, i, 43) - 0.5) * 0.8, Math.sin(th) * R);
      g.lookAt(0, g.position.y, 0);
      g.rotateY(Math.PI / 2);
      g.userData = { R, th, phase: hash01(b, i, 44) };
      this.yards.push({ g, hull });
      this.add(this.inOrbit, g);
    }
    this.sparks = points(this.yards.length * 10, 1, 6);
    this.add(this.inOrbit, this.sparks.pts);
  }

  /** Asteroid tugs: rocks pushed in from far out to the smelters, exhaust behind. */
  private buildMiners(n: number): void {
    const b = this.body, m = Math.min(n, 14);
    for (let i = 0; i < m; i++) this.miners.push({ R0: 34 + hash01(b, i, 51) * 14, th: hash01(b, i, 52) * Math.PI * 2, inc: (hash01(b, i, 53) - 0.5) * 0.5, period: 40 + hash01(b, i, 54) * 30, off: hash01(b, i, 55) });
    const geo = new THREE.DodecahedronGeometry(0.12, 0);
    this.rocks = new THREE.InstancedMesh(geo, ROCK, m);
    this.rocks.frustumCulled = false;
    this.tugs = points(m, 1.2, 6);
    this.tugTrails = lineBuf(m);
    this.add(this.inOrbit, this.rocks, this.tugs.pts, this.tugTrails.lines);
  }

  /** A low orbital ring round the equator, its spokes down to the ground, cars running along it. */
  private buildRing(): void {
    const g = new THREE.Group();
    const R = RING_R;
    const band = new THREE.Mesh(new THREE.TorusGeometry(R, 0.05, 10, 320), new THREE.MeshStandardMaterial({ color: 0xb9c2cc, metalness: 0.7, roughness: 0.35, emissive: 0x335577, emissiveIntensity: 0.5 }));
    band.rotation.x = Math.PI / 2;
    const glow = new THREE.Mesh(new THREE.TorusGeometry(R, 0.14, 8, 320), new THREE.MeshBasicMaterial({ color: 0x5fb6ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = Math.PI / 2;
    g.add(band, glow);
    const spokes: number[] = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      spokes.push(c * R0, 0, s * R0, c * R, 0, s * R);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));
    g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })));
    g.userData.work = 'oringlow';
    this.ring = g;
    this.ringLights = points(48, 1, 4);
    g.add(this.ringLights.pts);
    this.add(this.onPivot, g);
  }

  /** Shuttles between the spaceports and what is in orbit. */
  private buildTraffic(n: number): void {
    this.traffic = points(n, 1, 4);
    this.trafficTrails = lineBuf(n);
    this.add(this.inGroup, this.traffic.pts, this.trafficTrails.lines);
  }

  private add(into: THREE.Object3D[], ...objs: THREE.Object3D[]): void {
    for (const o of objs) {
      into.push(o);
      (into === this.inOrbit ? this.orbit : into === this.onPivot ? this.pivot : this.group)!.add(o);
    }
  }

  // ---------------------------------------------------------------- motion

  frame(t: number, tm: number): void {
    if (!this.infra) return;
    const T = REDUCED_MOTION ? tm * 0.35 : tm, flick = REDUCED_MOTION ? 0 : 1;
    // constellations and their laser links
    if (this.satPts) {
      const P = this.satPts;
      for (let i = 0; i < this.sats.length; i++) { satAt(this.sats[i], T, tv); P.pos[i * 3] = tv.x; P.pos[i * 3 + 1] = tv.y; P.pos[i * 3 + 2] = tv.z; }
      touch(P.pts, this.sats.length, 1);
    }
    if (this.linkBuf) {
      const L = this.linkBuf;
      this.links.forEach(([a, c, along], k) => {
        satAt(this.sats[a], T, tv); satAt(this.sats[c], T, tv2);
        L.pos.set([tv.x, tv.y, tv.z, tv2.x, tv2.y, tv2.z], k * 6);
        // a laser only reaches a neighbour in sight: long chords (planes far apart, sparse planes) stay dark
        const d = tv.distanceTo(tv2), near = along ? 1 : d < 1.6 ? 1 - d / 1.6 : 0;
        // each link pulses as traffic crosses it
        const p = near * (0.022 + 0.4 * flick * Math.pow(0.5 + 0.5 * Math.sin(t * 1.9 + k * 2.39), 16));
        L.col.set([0.35 * p, 0.85 * p, 1.4 * p, 0.35 * p, 0.85 * p, 1.4 * p], k * 6);
      });
      touch(L.lines, this.links.length, 2);
    }
    // stations drift on their orbits and turn slowly
    for (const g of this.stations) {
      const u = g.userData, th = u.th + u.w * T;
      g.position.set(Math.cos(th) * u.R, Math.sin(u.inc) * u.R * 0.5, Math.sin(th) * u.R);
      g.rotation.set(0.3, T * 0.05 + u.spin * 6, 0.2);
    }
    // power satellites hold station; their beams shimmer down to the rectennas
    if (this.beams) {
      const B = this.beams;
      let k = 0;
      this.power.forEach((p, i) => {
        const e = p.mesh.position;
        tv2.copy(e).setY(0).setLength(R0 * 1.004);
        for (let j = 0; j < 6; j++) {
          const u0 = j / 6, u1 = (j + 1) / 6;
          tv.lerpVectors(e, tv2, u0); tv3.lerpVectors(e, tv2, u1);
          const s = 0.22 + 0.14 * flick * Math.sin(t * 6 - j * 1.3 + i);
          B.pos.set([tv.x, tv.y, tv.z, tv3.x, tv3.y, tv3.z], k * 6);
          B.col.set([1 * s, 0.55 * s, 0.25 * s, 1 * s, 0.55 * s, 0.25 * s], k * 6);
          k++;
        }
      });
      touch(B.lines, k, 2);
    }
    // defence platforms patrol their band; faction lights blink
    if (this.defence && this.defLights) {
      const D = this.defLights;
      this.defSlots.forEach((d, i) => {
        const th = d.th + d.w * T;
        tv.set(Math.cos(th) * d.R, 0, Math.sin(th) * d.R).applyAxisAngle(Z, d.inc * 0.4);
        tq.setFromAxisAngle(UP, -th + T * 0.2);
        tm4.compose(tv, tq, ts.setScalar(1));
        this.defence!.setMatrixAt(i, tm4);
        const blink = flick ? (Math.sin(t * 3 + i * 2.1) > 0.6 ? 1 : 0.25) : 0.6;
        D.pos.set([tv.x, tv.y + 0.03, tv.z], i * 3);
        D.col.set([this.faction.r * blink, this.faction.g * blink, this.faction.b * blink], i * 3);
        D.size[i] = 0.16;
        // a red warning lamp under each
        const j = i + this.defSlots.length;
        D.pos.set([tv.x, tv.y - 0.03, tv.z], j * 3);
        const w = flick ? (Math.sin(t * 5 + i) > 0.8 ? 1 : 0.15) : 0.5;
        D.col.set([w, 0.1 * w, 0.08 * w], j * 3);
        D.size[j] = 0.1;
      });
      this.defence.instanceMatrix.needsUpdate = true;
      touch(D.pts, this.defSlots.length * 2, 1);
    }
    // shipyards: a hull grows on the slips, is launched, and the next is begun; sparks fly where it is being welded
    if (this.sparks) {
      const S = this.sparks;
      let k = 0;
      this.yards.forEach(({ g, hull }, i) => {
        const cyc = 30, u = ((t / cyc + g.userData.phase) % 1);
        const built = Math.min(1, u / 0.85);
        hull.scale.set(1, 1, Math.max(0.05, built));
        hull.position.z = -0.25 * (1 - built);
        g.updateMatrixWorld();
        for (let j = 0; j < 10; j++) {
          const on = flick ? hash01(i, j, Math.floor(t * 12)) < 0.55 : j % 2 === 0;
          tv.set((hash01(i, j, Math.floor(t * 8), 1) - 0.5) * 0.14, (hash01(i, j, Math.floor(t * 8), 2) - 0.5) * 0.14, -0.25 + 0.5 * built + (hash01(i, j, 3) - 0.5) * 0.05);
          tv.applyMatrix4(g.matrix);
          S.pos.set([tv.x, tv.y, tv.z], k * 3);
          const c = on && built < 1 ? 1 : 0;
          S.col.set([c, 0.85 * c, 0.55 * c], k * 3);
          S.size[k++] = 0.05 + 0.05 * hash01(i, j, Math.floor(t * 10));
        }
      });
      touch(S.pts, k, 1);
    }
    // tugs bring rocks in from far out, then turn back for the next
    if (this.rocks && this.tugs && this.tugTrails) {
      const P = this.tugs, L = this.tugTrails;
      this.miners.forEach((m, i) => {
        const u = ((T / m.period + m.off) % 1);
        const r = m.R0 + (14 - m.R0) * (0.5 - 0.5 * Math.cos(Math.min(1, u * 1.1) * Math.PI));
        const th = m.th + u * 1.2;
        tv.set(Math.cos(th) * r, Math.sin(m.inc) * r * 0.3, Math.sin(th) * r);
        tq.setFromEuler(new THREE.Euler(T * 0.3 + i, T * 0.2, 0));
        tm4.compose(tv, tq, ts.setScalar(u > 0.9 ? Math.max(0.01, (1 - u) * 10) : 1));
        this.rocks!.setMatrixAt(i, tm4);
        // the tug pushes from behind: outward of the rock, exhaust trailing outward
        tv2.copy(tv).setLength(r + 0.18);
        P.pos.set([tv2.x, tv2.y, tv2.z], i * 3);
        P.col.set([0.6, 0.85, 1], i * 3);
        P.size[i] = u > 0.9 ? 0 : 0.12;
        tv3.copy(tv).setLength(r + 1.4);
        L.pos.set([tv2.x, tv2.y, tv2.z, tv3.x, tv3.y, tv3.z], i * 6);
        const e = u > 0.9 ? 0 : 0.7;
        L.col.set([0.5 * e, 0.8 * e, 1 * e, 0, 0, 0], i * 6);
      });
      this.rocks.instanceMatrix.needsUpdate = true;
      touch(P.pts, this.miners.length, 1);
      touch(L.lines, this.miners.length, 2);
    }
    // cars along the orbital ring
    if (this.ringLights) {
      const P = this.ringLights;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2 + T * (i % 2 ? 0.25 : -0.18);
        P.pos.set([Math.cos(a) * 11.6, 0, Math.sin(a) * 11.6], i * 3);
        P.col.set(i % 2 ? [1, 0.9, 0.6] : [0.6, 0.9, 1], i * 3);
        P.size[i] = 0.12;
      }
      touch(P.pts, 48, 1);
    }
    // shuttles up from the spaceports to the stations and yards, and back down
    if (this.traffic && this.trafficTrails && this.pivot && this.orbit) {
      const ports = this.ports();
      const dests: THREE.Object3D[] = [...this.stations, ...this.yards.map((y) => y.g)];
      if (ports.length) {
        const P = this.traffic, L = this.trafficTrails, n = P.size.length;
        this.pivot.updateMatrixWorld(); this.orbit.updateMatrixWorld();
        for (let i = 0; i < n; i++) {
          const cyc = 14 + hash01(this.body, i, 61) * 10, u = ((t / cyc + hash01(this.body, i, 62)) % 1);
          const up = u < 0.5, f = up ? u * 2 : (1 - u) * 2; // 0 at the port, 1 in orbit
          const port = ports[i % ports.length];
          const a = tv.copy(port).applyMatrix4(this.pivot.matrixWorld);
          const dest = dests.length ? dests[(i * 7) % dests.length].getWorldPosition(tv3) : tv3.copy(a).setLength(11.4);
          const ctrl = tv2.copy(a).setLength(11.2).lerp(dest, 0.3);
          const at = bez(a, ctrl, dest, smooth(f), new THREE.Vector3());
          const prev = bez(a, ctrl, dest, smooth(Math.max(0, f - (up ? 0.05 : -0.05))), new THREE.Vector3());
          P.pos.set([at.x, at.y, at.z], i * 3);
          P.col.set(up ? [1, 0.85, 0.6] : [0.7, 0.9, 1], i * 3);
          P.size[i] = 0.09;
          L.pos.set([prev.x, prev.y, prev.z, at.x, at.y, at.z], i * 6);
          L.col.set([0, 0, 0, 0.9, 0.6, 0.3], i * 6);
        }
        touch(P.pts, n, 1);
        touch(L.lines, n, 2);
      }
    }
  }

  // ---------------------------------------------------------------- labels and cards

  labels(): InfraLabel[] {
    const out: InfraLabel[] = [];
    const I = this.infra;
    if (!I) return out;
    const w = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.35, 0));
    if (this.yards[0]) out.push({ pos: w(this.yards[0].g), text: I.orbit.shipyards > 1 ? `${I.orbit.shipyards} shipyards` : 'Shipyard', sub: 'hulls on the slips', ex: 'oyard' });
    if (this.power[0]) out.push({ pos: w(this.power[0].mesh), text: `${I.orbit.power} power satellites`, sub: 'beaming sunlight down', ex: 'opower' });
    if (this.ring) out.push({ pos: new THREE.Vector3(11.6, 0.4, 0).applyMatrix4(this.ring.matrixWorld), text: 'Orbital ring', sub: '24 spokes to the ground', ex: 'oringl' });
    return out;
  }

  private register(): void {
    const body = () => this.body;
    const objs = {
      oyard: () => this.yards.map((y) => y.g),
      opower: () => this.power.map((p) => p.mesh),
      ostat: () => this.stations,
      oringl: () => (this.ring ? [this.ring] : []),
    } as const;
    for (const [kind, list] of Object.entries(objs) as [keyof typeof objs, () => THREE.Object3D[]][]) {
      const host = kind === 'oringl' ? this.pivot! : this.orbit!;
      registerExplainer(kind, {
        obj: host,
        explain: (i, c) => this.card(kind, i, body(), c),
        name: (i, c) => this.card(kind, i, body(), c).title,
        locate: (i, out) => list()[i]?.getWorldPosition(out) ?? null,
        objectOf: (i) => (kind === 'oringl' ? null : list()[i] ?? null),
        // the ring is a whole circle: zoom into the stretch of it nearest the camera, and stay on it as the planet turns
        anchor: kind === 'oringl' ? (_i, from) => {
          const ring = this.ring;
          if (!ring) return null;
          const local = ring.worldToLocal(from.clone()).setY(0).setLength(RING_R);
          return (out) => (this.ring === ring ? out.copy(local).applyMatrix4(ring.matrixWorld) : null);
        } : undefined,
      });
      addCpuSet({ kind, obj: host, prio: 4, enabled: () => list().length > 0, hit: (p) => nearestPoint(list().length, (i, out) => list()[i].getWorldPosition(out), p, () => 16) });
    }
    if (this.defLights) {
      const pts = this.defLights.pts, n = this.defSlots.length;
      registerExplainer('odef', {
        obj: pts,
        explain: (i, c) => this.card('odef', i % n, body(), c),
        name: (i, c) => this.card('odef', i % n, body(), c).title,
        locate: (i, out) => pointWorld(pts, i, out),
        objectOf: () => this.defence, // the coarse hulls give way to the close-up's
      });
      addGpuSet({ kind: 'odef', points: pts, prio: 3, minLum: 0.05, pickPx: 7 });
    }
    if (this.tugs) {
      const pts = this.tugs.pts;
      registerExplainer('omine', {
        obj: pts,
        explain: (i, c) => this.card('omine', i, body(), c),
        name: (i, c) => this.card('omine', i, body(), c).title,
        locate: (i, out) => pointWorld(pts, i, out),
        objectOf: () => this.rocks, // the coarse rocks give way to the close-up's
      });
      addGpuSet({ kind: 'omine', points: pts, prio: 3, minLum: 0.05, pickPx: 7 });
    }
  }

  private card(kind: string, i: number, b: number, c: ExCtx): Explanation {
    const body = c.world.bodies[b];
    const I = c.snap ? infraOf(c.world, c.snap, b, c.year) : this.infra;
    const O = I?.orbit;
    const tag = body.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    const facts = (count: number | undefined, label: string, ...techs: string[]) => [
      { k: label, v: String(count ?? 0), t: 'E' as const },
      { k: 'Made possible by', v: techs.map(techName).join(', '), t: 'R' as const },
      { k: 'Age of this world', v: I?.tierName ?? '—', t: 'E' as const },
    ];
    switch (kind) {
      case 'oyard': return {
        eyebrow: `Shipyard over ${body.name}`, title: `${tag} Yard ${i + 1}`,
        lede: 'An open lattice dock in orbit where hulls are built in weightlessness from metal smelted out of asteroids, then pushed off the slips.',
        facts: facts(O?.shipyards, 'Yards over this world', 'asteroidMining', 'orbitalHabitats'),
        why: 'Ships built in orbit never fight their way up a gravity well, so a world with yards can send out far more than its launch pads alone could lift.',
      };
      case 'opower': return {
        eyebrow: `Space solar power over ${body.name}`, title: `${tag}-SPS ${i + 1}`,
        lede: 'A panel kilometres across, in sunlight all day, turning it into a microwave beam aimed at a rectenna field on the ground.',
        facts: facts(O?.power, 'Power satellites', 'robotics', ...(I?.has('dyson1') ? ['dyson1'] : [])),
        why: 'Sunlight in orbit never sets and never clouds over; beaming it down feeds cities without burning anything.',
      };
      case 'ostat': return {
        eyebrow: `Station over ${body.name}`, title: i === 0 ? `${body.name} Station` : `${tag} Station ${i + 1}`,
        lede: 'A crewed orbital station: modules on a truss, solar wings and radiators. Shuttles come up from the spaceports and dock here.',
        facts: facts(O?.stations, 'Crewed stations', 'reusable'),
      };
      case 'odef': return {
        eyebrow: `Defence platform over ${body.name}`, title: `${tag}-D${String(i + 1).padStart(2, '0')}`,
        lede: 'An armoured platform with turrets, part of a guarded band that watches for missiles, kinetic slugs and stray rocks.',
        facts: facts(O?.defence, 'Platforms in the band', ...(I?.has('fusionDrive') ? ['fusionDrive'] : ['reusable'])),
        why: 'How many there are follows how much this world spends on its military.',
      };
      case 'omine': return {
        eyebrow: `Asteroid tug of ${body.name}`, title: `${tag} Tug ${i + 1}`,
        lede: 'A tug pushing a captured rock in from far out to the smelters in orbit, where its metal and ice are worked.',
        facts: facts(O?.miners, 'Tugs at work', 'asteroidMining'),
      };
      default: return {
        eyebrow: `Orbital ring of ${body.name}`, title: `${body.name} orbital ring`,
        lede: 'A ring around the whole world in low orbit, held up by a fast-moving inner band, with spokes down to the ground: launch is a lift ride, and cars run around the planet in an hour.',
        facts: facts(1, 'Rings', 'nanofab', 'carbonNano'),
      };
    }
  }
}

const smooth = (x: number) => x * x * (3 - 2 * x);
function bez(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, f: number, out: THREE.Vector3): THREE.Vector3 {
  const g = 1 - f;
  return out.set(g * g * a.x + 2 * g * f * b.x + f * f * c.x, g * g * a.y + 2 * g * f * b.y + f * f * c.y, g * g * a.z + 2 * g * f * b.z + f * f * c.z);
}

/** Merge non-indexed copies of simple geometries (for one instanced hull). */
function mergeGeo(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = gs.map((g) => (g.index ? g.toNonIndexed() : g));
  const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let k = 0;
  for (const g of parts) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, k * 3);
    nor.set(g.attributes.normal.array as Float32Array, k * 3);
    k += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
