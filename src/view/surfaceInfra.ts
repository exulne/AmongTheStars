// What a world has built on its surface, seen from orbit (src/sim/infra.ts
// says how much of each; this places and draws it). Arcologies rise out of the
// biggest cities with beacons on top; maglev and vacuum-train lines run along
// great circles between cities with trains on them; spaceports launch to orbit;
// mass drivers fling payloads off the end of their tracks; fusion plants burn
// blue-white, fission plants steam, solar farms glint when the sun catches
// them; domes cover cities on hostile worlds; terraformers vent; farms glow
// green, compute cores cyan; defence emplacements test their beams.
//
// Everything sits on the planet's pivot, so it turns with the world, and is
// depth-tested against it, so the far side is hidden. Placement is hashed from
// the body and city index, so a world looks the same every visit; the scene is
// rebuilt only when what the world has changes.

import * as THREE from 'three';
import { TECHS } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { infraOf, type Infra } from '../sim/infra.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';
import { addCpuSet, nearestPoint } from '../explain/picker.ts';
import { registerExplainer, type ExCtx, type Explanation, type Fact } from '../explain/registry.ts';
import { pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';

const R = 10;                    // planet radius in PlanetView
const MAX_PTS = 5000, MAX_SEG = 7000;
/** the dot sizes below are relative (1 ≈ a few pixels from the default orbit); this scales them to scene units */
const SZ = 0.3;
const UP = new THREE.Vector3(0, 1, 0);
const techName = (id: string) => TECHS.find((t) => t.id === id)?.name ?? id;

/** A place on the surface: where, its up, and two tangents (t1 points "east"). */
interface Site { p: THREE.Vector3; n: THREE.Vector3; t1: THREE.Vector3; t2: THREE.Vector3; city: number; seed: number }
interface Link { pts: THREE.Vector3[]; len: number; fast: boolean; seed: number }
interface Driver { site: Site; track: THREE.Vector3[]; end: THREE.Vector3; out: THREE.Vector3; seed: number }

function frameAt(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const t1 = new THREE.Vector3().crossVectors(Math.abs(n.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : UP, n).normalize();
  return [t1, new THREE.Vector3().crossVectors(n, t1)];
}

/** Great-circle points between two surface directions, lifted to radius r. */
function arc(a: THREE.Vector3, b: THREE.Vector3, r: number, nSeg: number): THREE.Vector3[] {
  const A = a.clone().normalize(), B = b.clone().normalize();
  const om = Math.acos(Math.min(1, Math.max(-1, A.dot(B))));
  const out: THREE.Vector3[] = [];
  for (let k = 0; k <= nSeg; k++) {
    const f = k / nSeg;
    if (om < 1e-4) { out.push(A.clone().multiplyScalar(r)); continue; }
    const s = Math.sin(om);
    out.push(A.clone().multiplyScalar(Math.sin((1 - f) * om) / s).addScaledVector(B, Math.sin(f * om) / s).normalize().multiplyScalar(r));
  }
  return out;
}

/** Point at fraction u along a polyline (equal segments). */
function along(pts: THREE.Vector3[], u: number, out: THREE.Vector3): THREE.Vector3 {
  const x = Math.min(0.9999, Math.max(0, u)) * (pts.length - 1), i = Math.floor(x);
  return out.lerpVectors(pts[i], pts[i + 1], x - i);
}

const C = {
  arcoSkin: new THREE.Color(0xc9d6e4), arcoGlow: new THREE.Color(0x8fd8ff),
  maglev: new THREE.Color(0.2, 0.55, 1), vac: new THREE.Color(0.3, 0.9, 1), train: new THREE.Color(1, 0.95, 0.85),
  plume: new THREE.Color(1, 0.7, 0.35), flame: new THREE.Color(1, 0.9, 0.7), smoke: new THREE.Color(0.55, 0.5, 0.45),
  coil: new THREE.Color(0.75, 0.55, 1), payload: new THREE.Color(0.95, 0.85, 1),
  fusion: new THREE.Color(0.65, 0.85, 1), fission: new THREE.Color(1, 0.62, 0.3), steam: new THREE.Color(0.7, 0.72, 0.75),
  glint: new THREE.Color(1, 0.95, 0.8), rect: new THREE.Color(0.4, 0.95, 1), farm: new THREE.Color(0.35, 1, 0.45),
  compute: new THREE.Color(0.35, 0.95, 1), shield: new THREE.Color(1, 0.3, 0.25), beacon: new THREE.Color(1, 0.25, 0.2),
  vent: new THREE.Color(0.85, 0.7, 0.55),
};

export class SurfaceInfra {
  readonly group = new THREE.Group();
  private key = '';
  private body = -1;
  private I: Infra | null = null;
  private statics = new THREE.Group();
  // what is placed
  private hubs: { p: THREE.Vector3; n: number }[] = [];
  private arcos: { base: THREE.Vector3; top: THREE.Vector3; n: THREE.Vector3; h: number; seed: number }[] = [];
  private ports: Site[] = [];
  private drivers: Driver[] = [];
  private links: Link[] = [];
  private fusion: Site[] = []; private fission: Site[] = []; private solar: Site[] = []; private rect: Site[] = [];
  private stacks: { top: THREE.Vector3; site: Site }[] = [];
  private farms: Site[] = []; private cores: Site[] = []; private shields: Site[] = [];
  // drawn every frame
  private pts: THREE.Points; private pPos: Float32Array; private pCol: Float32Array; private pSize: Float32Array; private np = 0;
  private lines: THREE.LineSegments; private lPos: Float32Array; private lCol: Float32Array; private ns = 0;

  constructor() {
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PTS * 3); this.pCol = new Float32Array(MAX_PTS * 3); this.pSize = new Float32Array(MAX_PTS);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    this.pts = new THREE.Points(pg, pointsMaterial({ minPx: 1, maxPx: 40 }));
    this.pts.frustumCulled = false;
    const lg = new THREE.BufferGeometry();
    this.lPos = new Float32Array(MAX_SEG * 6); this.lCol = new Float32Array(MAX_SEG * 6);
    lg.setAttribute('position', new THREE.BufferAttribute(this.lPos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lCol, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.group.add(this.statics, this.lines, this.pts);
    this.explainers();
  }

  /** Re-read what the world has; rebuild the placed things only when that changed. */
  sync(world: World, snap: StateMsg | null, body: number, year: number, cityPos: THREE.Vector3[]): Infra | null {
    const I = snap && cityPos.length ? infraOf(world, snap, body, year) : null;
    const key = I ? `${body}:${cityPos.length}:${I.tier}:${JSON.stringify(I.surface)}:${I.orbit.power > 0}` : `${body}:none`;
    this.I = I;
    if (key === this.key) return I;
    this.key = key; this.body = body;
    this.build(I, body, cityPos);
    return I;
  }

  private clearStatics(): void {
    for (const o of [...this.statics.children]) {
      this.statics.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    }
    this.arcos = []; this.hubs = []; this.ports = []; this.drivers = []; this.links = [];
    this.fusion = []; this.fission = []; this.solar = []; this.rect = []; this.stacks = []; this.farms = []; this.cores = []; this.shields = [];
  }

  private build(I: Infra | null, b: number, cityPos: THREE.Vector3[]): void {
    this.clearStatics();
    if (!I) return;
    const S = I.surface, nC = cityPos.length, tier = I.tier;
    const dirs = cityPos.map((c) => c.clone().normalize());
    // bigger cities (lower index: the capital first) get more of everything
    const pickCity = (k: number, salt: number) => Math.min(nC - 1, Math.floor(nC * Math.pow(hash01(b, k, salt, 71), 2.2)));
    const site = (ci: number, k: number, salt: number, rMin: number, rMax: number): Site => {
      const n0 = dirs[ci], [t1, t2] = frameAt(n0);
      const a = hash01(b, ci, k, salt) * Math.PI * 2, r = rMin + (rMax - rMin) * hash01(b, ci, k, salt + 1);
      const n = n0.clone().multiplyScalar(R).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
      const [u1, u2] = frameAt(n);
      return { p: n.clone().multiplyScalar(R), n, t1: u1, t2: u2, city: ci, seed: hash01(b, ci, k, salt + 2) };
    };
    const place = (count: number, salt: number, rMin: number, rMax: number) => Array.from({ length: count }, (_, k) => site(pickCity(k, salt), k, salt, rMin, rMax));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: { p: THREE.Vector3; n: THREE.Vector3; s: THREE.Vector3; spin?: number }[]) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        q.setFromUnitVectors(UP, it.n);
        if (it.spin) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, it.spin));
        m4.compose(it.p, q, sc.copy(it.s));
        im.setMatrixAt(i, m4);
      });
      this.statics.add(im);
      return im;
    };

    // arcologies: super-tall tapering spires with sky platforms, a third of them in the capital
    const nA = S.arcologies;
    for (let k = 0; k < nA; k++) {
      const ci = k < Math.ceil(nA / 3) ? 0 : pickCity(k, 11);
      const s = site(ci, k, 13, 0, ci === 0 ? 0.32 : 0.2);
      const h = (0.32 + 0.6 * hash01(b, k, 17)) * (0.7 + 0.12 * tier);
      this.arcos.push({ base: s.p, n: s.n, h, seed: s.seed, top: s.p.clone().addScaledVector(s.n, h) });
    }
    {
      const byCity = new Map<number, number>();
      for (let k = 0; k < this.arcos.length; k++) { const ci = k < Math.ceil(nA / 3) ? 0 : pickCity(k, 11); byCity.set(ci, (byCity.get(ci) ?? 0) + 1); }
      for (const [ci, n] of byCity) this.hubs.push({ p: dirs[ci].clone().multiplyScalar(R + 0.15), n });
    }
    if (this.arcos.length) {
      const skin = new THREE.MeshStandardMaterial({ color: C.arcoSkin, metalness: 0.65, roughness: 0.28, emissive: C.arcoGlow, emissiveIntensity: 0.7 });
      inst(new THREE.CylinderGeometry(0.28, 1, 1, 6).translate(0, 0.5, 0), skin, this.arcos.map((a) => ({ p: a.base, n: a.n, s: new THREE.Vector3(0.05, a.h, 0.05), spin: a.seed * 6 })));
      // sky platforms at two heights: the city above the city
      const decks = this.arcos.flatMap((a) => [0.42, 0.74].map((f) => ({ p: a.base.clone().addScaledVector(a.n, a.h * f), n: a.n, s: new THREE.Vector3(0.075 * (1.15 - f * 0.6), 1, 0.075 * (1.15 - f * 0.6)) })));
      // a column of light up each tower, so the skyline reads from orbit as needles of light
      {
        const pos: number[] = [], col: number[] = [];
        for (const a of this.arcos) {
          const top = a.base.clone().addScaledVector(a.n, a.h * 1.04);
          pos.push(a.base.x, a.base.y, a.base.z, top.x, top.y, top.z);
          col.push(C.arcoGlow.r * 0.9, C.arcoGlow.g * 0.9, C.arcoGlow.b * 0.9, 1, 1, 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        this.statics.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      }
      inst(new THREE.CylinderGeometry(1, 1, 0.006, 14), new THREE.MeshStandardMaterial({ color: 0xdde8f2, metalness: 0.5, roughness: 0.35, emissive: C.arcoGlow, emissiveIntensity: 0.55 }), decks);
    }

    // transit: each city joined to its nearest earlier neighbour (a tree), then cross-links once vacuum trains run
    if (nC > 1 && S.maglev > 0) {
      const edges: [number, number][] = [];
      for (let i = 1; i < nC; i++) {
        let best = 0, bd = -2;
        for (let j = 0; j < i; j++) { const d = dirs[i].dot(dirs[j]); if (d > bd) { bd = d; best = j; } }
        edges.push([i, best]);
      }
      const keep = Math.max(1, Math.round(edges.length * S.maglev));
      const chosen = edges.slice(0, keep);
      if (S.vacTrain) for (let i = 2; i < nC && chosen.length < keep + Math.ceil(nC / 2); i += 2) chosen.push([i, (i * 7 + 3) % i]);
      for (const [i, j] of chosen) {
        const om = Math.acos(Math.min(1, dirs[i].dot(dirs[j])));
        if (om < 1e-3) continue;
        const pts = arc(dirs[i], dirs[j], R * 1.004, Math.max(8, Math.ceil(om * 40)));
        this.links.push({ pts, len: om * R, fast: S.vacTrain, seed: hash01(b, i, j, 23) });
      }
      const pos: number[] = [], col: number[] = [];
      for (const L of this.links) {
        const c = L.fast ? C.vac : C.maglev, k = L.fast ? 0.55 : 0.4;
        for (let s = 0; s + 1 < L.pts.length; s++) {
          const a = L.pts[s], z = L.pts[s + 1];
          pos.push(a.x, a.y, a.z, z.x, z.y, z.z);
          col.push(c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.statics.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    }

    // spaceports: pads and service towers just outside a city
    this.ports = place(S.spaceports, 31, 0.36, 0.62);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9, metalness: 0.05, emissive: 0x30404c, emissiveIntensity: 0.3 });
    inst(new THREE.CylinderGeometry(1, 1, 0.004, 16), concrete, this.ports.flatMap((s) => [-1, 1].map((d) => ({ p: s.p.clone().addScaledVector(s.t1, d * 0.06), n: s.n, s: new THREE.Vector3(0.045, 1, 0.045) }))));
    inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0xb04030, roughness: 0.6, emissive: 0x401010, emissiveIntensity: 0.4 }), this.ports.flatMap((s) => [-1, 1].map((d) => ({ p: s.p.clone().addScaledVector(s.t1, d * 0.06).addScaledVector(s.t2, 0.04), n: s.n, s: new THREE.Vector3(0.008, 0.07, 0.008) }))));

    // mass drivers: a straight electromagnetic track, a ramp to the sky at its end
    for (let k = 0; k < S.massDrivers; k++) {
      const s = site(pickCity(k, 41), k, 41, 0.55, 0.85);
      const ang = hash01(b, k, 43) * Math.PI * 2;
      const dir = s.t1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(s.t2, Math.sin(ang));
      const endDir = s.p.clone().addScaledVector(dir, 1.5).normalize();
      const track = arc(s.n, endDir, R * 1.006, 18);
      const end = track[track.length - 1].clone();
      const out = end.clone().sub(track[track.length - 2]).normalize();
      this.drivers.push({ site: s, track, end, out, seed: hash01(b, k, 47) });
    }
    if (this.drivers.length) {
      const pos: number[] = [], col: number[] = [];
      for (const d of this.drivers) for (let s = 0; s + 1 < d.track.length; s++) {
        const a = d.track[s], z = d.track[s + 1];
        pos.push(a.x, a.y, a.z, z.x, z.y, z.z);
        col.push(C.coil.r * 0.7, C.coil.g * 0.7, C.coil.b * 0.7, C.coil.r * 0.7, C.coil.g * 0.7, C.coil.b * 0.7);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.statics.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      // the coils: rings along the track
      inst(new THREE.TorusGeometry(1, 0.25, 4, 10), new THREE.MeshStandardMaterial({ color: 0x9c8cff, metalness: 0.7, roughness: 0.3, emissive: 0x5a3cff, emissiveIntensity: 0.6 }),
        this.drivers.flatMap((d) => d.track.filter((_, i) => i % 2 === 0).map((p, i, arr) => {
          const nxt = arr[Math.min(arr.length - 1, i + 1)], dir = nxt.clone().sub(p);
          if (dir.lengthSq() < 1e-8) dir.copy(d.out);
          return { p, n: dir.normalize(), s: new THREE.Vector3(0.018, 0.018, 0.018) };
        })));
    }

    // power: fusion halls, fission plants with cooling towers, solar farms that glint, rectennas under power satellites
    this.fusion = place(S.fusion, 51, 0.4, 0.75);
    inst(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8f2ff, metalness: 0.5, roughness: 0.25, emissive: 0x6fb8ff, emissiveIntensity: 0.45 }), this.fusion.map((s) => ({ p: s.p, n: s.n, s: new THREE.Vector3(0.05, 0.035, 0.05) })));
    this.fission = place(S.fission, 53, 0.4, 0.75);
    inst(new THREE.CylinderGeometry(0.62, 1, 1, 12, 1, true).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0xa8a29a, roughness: 0.85, side: THREE.DoubleSide }), this.fission.flatMap((s) => [-1, 1].map((d) => ({ p: s.p.clone().addScaledVector(s.t1, d * 0.03), n: s.n, s: new THREE.Vector3(0.022, 0.06, 0.022) }))));
    this.solar = place(S.solarFarms, 57, 0.5, 0.95);
    inst(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x14243c, metalness: 0.9, roughness: 0.18, emissive: 0x0a1830, emissiveIntensity: 0.4 }), this.solar.map((s) => ({ p: s.p, n: s.n, s: new THREE.Vector3(0.48, 0.003, 0.3), spin: s.seed * 3 })));
    if (I.orbit.power > 0) {
      this.rect = place(Math.min(8, Math.ceil(I.orbit.power / 5)), 59, 0.6, 1.0);
      inst(new THREE.RingGeometry(0.6, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.rect, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }), this.rect.map((s) => ({ p: s.p.clone().addScaledVector(s.n, 0.003), n: s.n, s: new THREE.Vector3(0.11, 1, 0.11) })));
    }

    // domes over the cities of a hostile world
    if (S.domes) {
      const list = dirs.slice(0, Math.min(nC, S.domes)).map((n, ci) => ({ p: n.clone().multiplyScalar(R), n, s: new THREE.Vector3(1, 0.55, 1).multiplyScalar(ci === 0 ? 0.52 : 0.32) }));
      inst(new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xcfe9ff, transparent: true, opacity: 0.2, metalness: 0.2, roughness: 0.08, emissive: 0x1f3a55, emissiveIntensity: 0.5, depthWrite: false, side: THREE.DoubleSide }), list);
    }

    // terraformers: processor stacks venting into the sky
    const tf = place(S.terraformers, 61, 0.9, 1.6);
    inst(new THREE.CylinderGeometry(0.7, 1, 1, 8).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x4a4440, roughness: 0.7, metalness: 0.3, emissive: 0xff7a30, emissiveIntensity: 0.25 }), tf.map((s) => ({ p: s.p, n: s.n, s: new THREE.Vector3(0.03, 0.32, 0.03) })));
    this.stacks = tf.map((s) => ({ site: s, top: s.p.clone().addScaledVector(s.n, 0.32) }));

    // farms (green-lit fields), compute cores (cyan grids), defence emplacements
    this.farms = place(S.farms, 67, 0.3, 0.7);
    inst(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x1e4a22, roughness: 0.6, emissive: 0x2fd84a, emissiveIntensity: 0.35 }),
      this.farms.flatMap((s) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => ({ p: s.p.clone().addScaledVector(s.t1, x * 0.035).addScaledVector(s.t2, z * 0.035), n: s.n, s: new THREE.Vector3(0.03, 0.004, 0.03) }))));
    this.cores = place(S.compute, 71, 0.15, 0.4);
    inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x0c1c24, metalness: 0.8, roughness: 0.25, emissive: C.compute, emissiveIntensity: 0.35 }), this.cores.map((s) => ({ p: s.p, n: s.n, s: new THREE.Vector3(0.07, 0.025, 0.07), spin: s.seed * 2 })));
    this.shields = place(S.shields, 73, 0.6, 1.1);
    inst(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a2a2a, metalness: 0.6, roughness: 0.4, emissive: 0x801818, emissiveIntensity: 0.4 }), this.shields.map((s) => ({ p: s.p, n: s.n, s: new THREE.Vector3(0.04, 0.03, 0.04) })));
  }

  private dot(p: THREE.Vector3, c: THREE.Color, k: number, size: number): void {
    if (this.np >= MAX_PTS || k <= 0.002 || size <= 0) return;
    this.pPos.set([p.x, p.y, p.z], this.np * 3);
    this.pCol.set([c.r * k, c.g * k, c.b * k], this.np * 3);
    this.pSize[this.np++] = size;
  }
  private seg(a: THREE.Vector3, z: THREE.Vector3, ca: THREE.Color, ka: number, cz: THREE.Color, kz: number): void {
    if (this.ns >= MAX_SEG) return;
    this.lPos.set([a.x, a.y, a.z, z.x, z.y, z.z], this.ns * 6);
    this.lCol.set([ca.r * ka, ca.g * ka, ca.b * ka, cz.r * kz, cz.g * kz, cz.b * kz], this.ns * 6);
    this.ns++;
  }

  /** Animate: trains, launches, mass-driver shots, plant glow, glints, vents, beams. `sun` and `cam` in the pivot's own space. */
  frame(t0: number, sun: THREE.Vector3, cam: THREE.Vector3): void {
    this.np = 0; this.ns = 0;
    const t = REDUCED_MOTION ? t0 * 0.35 : t0;
    const flick = (a: number) => (REDUCED_MOTION ? 0.5 : a);
    const v = new THREE.Vector3(), w = new THREE.Vector3(), x = new THREE.Vector3();

    // a gleam over each city with arcologies: the skyline reads from orbit even looking straight down
    for (const h of this.hubs) this.dot(h.p, C.arcoGlow, 0.22 + 0.04 * flick(Math.sin(t * 0.7 + h.n)), (6 + 3 * Math.min(4, h.n)) * SZ);
    // arcology beacons and window bands
    for (const a of this.arcos) {
      const blink = (t * 0.8 + a.seed * 7) % 2 < 0.25 ? 1 : 0.25;
      this.dot(v.copy(a.top).addScaledVector(a.n, 0.02), C.beacon, REDUCED_MOTION ? 0.7 : blink, (2.2) * SZ);
      for (const f of [0.2, 0.42, 0.6, 0.74, 0.9]) this.dot(v.copy(a.base).addScaledVector(a.n, a.h * f), C.arcoGlow, 0.6, (1.5) * SZ);
    }

    // trains: light pulses running the lines, quicker in vacuum tubes
    for (const L of this.links) {
      const nT = Math.max(1, Math.min(4, Math.round(L.len / 2)));
      const speed = (L.fast ? 1.6 : 0.5) / Math.max(0.5, L.len);
      for (let k = 0; k < nT; k++) {
        const dirn = k % 2 ? -1 : 1;
        let u = (t * speed + L.seed + k / nT) % 1;
        if (dirn < 0) u = 1 - u;
        along(L.pts, u, v);
        this.dot(v, C.train, 0.95, (L.fast ? 1.6 : 1.2) * SZ);
        along(L.pts, u - dirn * 0.03, w);
        this.seg(w, v, L.fast ? C.vac : C.maglev, 0, C.train, 0.9);
      }
    }

    // launches: ignition flash, a climbing plume that turns east, the trail cooling behind it
    for (const s of this.ports) {
      const period = 9 + 9 * s.seed, D = 5.5;
      const local = (t + s.seed * 31) % period;
      this.dot(v.copy(s.p).addScaledVector(s.n, 0.012), C.beacon, (t * 2 + s.seed * 5) % 1 < 0.5 ? 0.6 : 0.15, (1.1) * SZ);
      if (local > D + 3) continue;
      const pad = padAt.copy(s.p).addScaledVector(s.t1, (s.seed > 0.5 ? 1 : -1) * 0.06);
      const at = (f: number, out: THREE.Vector3) => out.copy(pad).addScaledVector(s.n, 4.2 * Math.pow(f, 1.7)).addScaledVector(s.t1, 1.6 * f * f);
      if (local < D) {
        const f = local / D;
        at(f, v);
        this.dot(v, C.flame, 1, (2.6 + 1.2 * flick(Math.sin(t * 40))) * SZ);
        this.dot(v, C.plume, 0.6, (5) * SZ);
        const N = 14;
        for (let k = 0; k < N; k++) {
          const f0 = f * k / N, f1 = f * (k + 1) / N;
          this.seg(at(f0, w), at(f1, x), C.smoke, 0.08 + 0.3 * (k / N), C.plume, 0.12 + 0.6 * ((k + 1) / N));
        }
        if (f < 0.12) this.dot(pad, C.flame, 1 - f / 0.12, (9) * SZ);
      }
      // the exhaust cloud spreading over the pad
      const since = local;
      if (since < D + 3) for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2 + s.seed;
        const r = 0.02 + since * 0.025;
        this.dot(v.copy(pad).addScaledVector(s.t1, Math.cos(a) * r).addScaledVector(s.t2, Math.sin(a) * r).addScaledVector(s.n, 0.01), C.smoke, 0.35 * Math.max(0, 1 - since / (D + 3)), (2.2) * SZ);
      }
    }

    // mass drivers: the coils light in sequence, a payload accelerates, flashes at the muzzle and is gone up the ramp
    for (const d of this.drivers) {
      const period = 4 + 3 * d.seed, local = (t + d.seed * 17) % period, run = 1.1;
      for (let k = 0; k < d.track.length; k += 2) this.dot(d.track[k], C.coil, 0.25, (0.9) * SZ);
      if (local < run) {
        const u = Math.pow(local / run, 2);
        along(d.track, u, v);
        this.dot(v, C.payload, 1, (1.8) * SZ);
        along(d.track, Math.max(0, u - 0.12), w);
        this.seg(w, v, C.coil, 0, C.payload, 1);
        // the coils just passed glow
        const ci = Math.floor(u * (d.track.length - 1));
        for (let k = Math.max(0, ci - 3); k <= ci; k++) this.dot(d.track[k], C.coil, 0.9 - (ci - k) * 0.2, (1.6) * SZ);
      } else if (local < run + 1.4) {
        const f = (local - run) / 1.4;
        if (f < 0.15) this.dot(d.end, C.payload, 1 - f / 0.15, (7) * SZ);
        v.copy(d.end).addScaledVector(d.out, f * 3).addScaledVector(d.site.n, f * f * 2.2 + f * 0.6);
        w.copy(d.end).addScaledVector(d.out, Math.max(0, f - 0.12) * 3).addScaledVector(d.site.n, Math.pow(Math.max(0, f - 0.12), 2) * 2.2 + Math.max(0, f - 0.12) * 0.6);
        this.seg(w, v, C.coil, 0.1, C.payload, 0.9 * (1 - f));
        this.dot(v, C.payload, 1 - f, (1.6) * SZ);
      }
    }

    // fusion plants pulse; fission plants steam
    for (const s of this.fusion) {
      const pulse = 0.75 + 0.25 * flick(Math.sin(t * 2.2 + s.seed * 9));
      this.dot(v.copy(s.p).addScaledVector(s.n, 0.03), C.fusion, pulse, (3.2) * SZ);
      this.dot(v, C.fusion, 0.25 * pulse, (12 + 4 * pulse) * SZ);
    }
    for (const s of this.fission) {
      this.dot(v.copy(s.p).addScaledVector(s.n, 0.02), C.fission, 0.75, (2) * SZ);
      for (let k = 0; k < 4; k++) {
        const u = (t * 0.12 + k / 4 + s.seed) % 1;
        this.dot(v.copy(s.p).addScaledVector(s.n, 0.07 + u * 0.25).addScaledVector(s.t1, u * u * 0.12), C.steam, 0.22 * (1 - u), (1.5 + 3 * u) * SZ);
      }
    }

    // solar farms glint where the sun's reflection meets the eye
    const S = sun.clone().normalize(), r = new THREE.Vector3(), toCam = new THREE.Vector3();
    for (const s of this.solar) {
      r.copy(s.n).multiplyScalar(2 * s.n.dot(S)).sub(S);
      toCam.copy(cam).sub(s.p).normalize();
      const g = Math.pow(Math.max(0, r.dot(toCam)), 60) * Math.max(0, s.n.dot(S));
      if (g > 0.01) this.dot(v.copy(s.p).addScaledVector(s.n, 0.01), C.glint, Math.min(1, g * 1.5), (2 + 10 * g) * SZ);
    }
    // rectennas: the beam coming down from the power satellites
    for (const s of this.rect) {
      const k = 0.18 + 0.08 * flick(Math.sin(t * 3 + s.seed * 5));
      this.seg(s.p, v.copy(s.p).addScaledVector(s.n, 3.2), C.rect, k, C.rect, 0);
      this.dot(s.p, C.rect, 0.5, (2.4) * SZ);
    }

    // terraformers vent plumes that drift downwind
    for (const st of this.stacks) {
      this.dot(st.top, C.fission, 0.8, (1.4) * SZ);
      for (let k = 0; k < 8; k++) {
        const u = (t * 0.09 + k / 8 + st.site.seed) % 1;
        this.dot(v.copy(st.top).addScaledVector(st.site.n, u * 1.1).addScaledVector(st.site.t1, u * u * 0.9), C.vent, 0.32 * (1 - u), (2.5 + 7 * u) * SZ);
      }
    }

    // farms glow; compute cores flicker with work; emplacements blink and now and then test a beam
    for (const s of this.farms) this.dot(v.copy(s.p).addScaledVector(s.n, 0.01), C.farm, 0.35, (2.2) * SZ);
    for (const s of this.cores) for (let k = 0; k < 4; k++) {
      const on = REDUCED_MOTION ? 0.5 : (Math.sin(t * (5 + k * 3) + s.seed * 30 + k) > 0.3 ? 1 : 0.2);
      this.dot(v.copy(s.p).addScaledVector(s.n, 0.028).addScaledVector(s.t1, (k % 2 - 0.5) * 0.04).addScaledVector(s.t2, (k >> 1) * 0.04 - 0.02), C.compute, 0.7 * on, (1.2) * SZ);
    }
    for (const s of this.shields) {
      this.dot(v.copy(s.p).addScaledVector(s.n, 0.032), C.shield, (t + s.seed * 3) % 1.4 < 0.3 ? 1 : 0.3, (1.4) * SZ);
      const period = 7 + 6 * s.seed, local = (t + s.seed * 13) % period;
      if (local < 0.7 && !REDUCED_MOTION) {
        const k = 1 - local / 0.7;
        this.seg(v.copy(s.p).addScaledVector(s.n, 0.03), w.copy(s.p).addScaledVector(s.n, 5).addScaledVector(s.t1, (s.seed - 0.5) * 2), C.shield, k, C.shield, 0.1 * k);
        this.dot(v, C.shield, k, (4) * SZ);
      }
    }

    const pg = this.pts.geometry;
    pg.setDrawRange(0, this.np);
    pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true; pg.attributes.size.needsUpdate = true;
    const lg = this.lines.geometry;
    lg.setDrawRange(0, this.ns * 2);
    lg.attributes.position.needsUpdate = true; lg.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------ cards

  private explainers(): void {
    const facing = (local: THREE.Vector3 | undefined, out: THREE.Vector3, probeCam: THREE.Vector3 | null): THREE.Vector3 | null => {
      if (!local) return null;
      out.copy(local).applyMatrix4(this.group.matrixWorld);
      if (probeCam) {
        const n = new THREE.Vector3().setFromMatrixPosition(this.group.matrixWorld);
        if (out.clone().sub(n).dot(tmpV.copy(probeCam).sub(out)) <= 0) return null; // far side
      }
      return out;
    };
    let lastCam: THREE.Vector3 | null = null;
    const kinds: { kind: string; list: () => THREE.Vector3[]; card: (i: number, c: ExCtx) => Explanation; name: (i: number) => string }[] = [
      { kind: 'arco', list: () => this.arcos.map((a) => a.top), name: (i) => `Arcology ${i + 1}`, card: (i, c) => this.card(c, 'Arcology', `Arcology ${i + 1}`,
        'A single structure several kilometres tall that houses a city: homes, farms, factories and parks stacked inside one tower, with sky decks for the docks and gardens.',
        [{ k: 'On this world', v: `${this.arcos.length}`, t: 'E' }, { k: 'Height (drawn exaggerated)', v: `${(this.arcos[i]?.h ?? 0).toFixed(2)} of the planet's radius ÷ 10`, t: 'P' }], ['carbonNano', 'nanofab']) },
      { kind: 'port', list: () => this.ports.map((s) => s.p), name: (i) => `Spaceport ${i + 1}`, card: (_i, c) => this.card(c, 'Spaceport', 'Spaceport',
        'A launch complex: twin pads, service towers and a fuel farm. Launches climb straight up, then pitch east to borrow the world\'s spin.',
        [{ k: 'On this world', v: `${this.ports.length}`, t: 'E' }], ['reusable']) },
      { kind: 'mdrv', list: () => this.drivers.map((d) => d.end), name: (i) => `Mass driver ${i + 1}`, card: (_i, c) => this.card(c, 'Mass driver', 'Mass driver',
        'An electromagnetic track that throws cargo to orbit without rockets: coils fire in sequence, the payload leaves the ramp at orbital speed. Cheap for anything that can take the acceleration.',
        [{ k: 'On this world', v: `${this.drivers.length}`, t: 'E' }], ['regolith', 'fusion']) },
      { kind: 'fusn', list: () => this.fusion.map((s) => s.p), name: (i) => `Fusion plant ${i + 1}`, card: (_i, c) => this.card(c, 'Power plant', 'Fusion plant',
        'A fusion power station: a magnetically confined plasma hotter than the Sun\'s core, made to give more energy than it takes.',
        [{ k: 'On this world', v: `${this.fusion.length}`, t: 'E' }], this.I?.has('he3Fusion') ? ['fusion', 'he3Fusion'] : ['fusion']) },
    ];
    for (const K of kinds) {
      registerExplainer(K.kind, {
        obj: this.pts,
        explain: (i, c) => K.card(i, c),
        name: (i) => K.name(i),
        locate: (i, out) => facing(K.list()[i], out, lastCam),
      });
      addCpuSet({
        kind: K.kind, obj: this.pts, prio: 2,
        hit: (p) => { lastCam = p.camera.position; return nearestPoint(K.list().length, (i, out) => facing(K.list()[i], out, p.camera.position), p, () => 10); },
      });
    }
  }

  private card(c: ExCtx, eyebrow: string, title: string, lede: string, facts: Fact[], techs: string[]): Explanation {
    const b = c.world.bodies[this.body];
    const I = this.I;
    const out: Fact[] = [...facts, { k: 'Built with', v: techs.map(techName).join(', '), t: 'R' }];
    if (I) out.push({ k: 'Age', v: I.tierName, t: 'E' });
    return { eyebrow: `${eyebrow} on ${b?.name ?? 'this world'}`, title, lede, facts: out, why: 'What a world builds follows its people, its wealth and the technologies that have reached it at light speed.' };
  }
}

const tmpV = new THREE.Vector3(), padAt = new THREE.Vector3();
