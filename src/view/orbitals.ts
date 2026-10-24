// What hangs in orbit, and what is built around the star, at a given age.
// Habitats evolve with technology (Stanford tori, then O'Neill cylinder pairs,
// then Bishop rings, then swarm collectors), and the stages above
// Megastructure each get a look of their own: a ring world, a swarm-wrapped
// world, Matrioshka shells around a brain-star, a lifted (dimmed) star, and
// an uploaded world under a quiet lattice.

import * as THREE from 'three';
import { STAGE, STAGE_NAMES } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { Rng } from '../sim/rng.ts';
import { stageIndex, techAge } from './timeLook.ts';

/** The developed tiers, lowest first. Stages a build doesn't have are simply never matched. */
export const TIERS = ['City', 'Hub', 'Megastructure', 'Ring world', 'Swarm-world', 'Brain-star', 'Lifted star', 'Uploaded'] as const;
export type Tier = (typeof TIERS)[number];
const TIER_IX = TIERS.map((n) => stageIndex(n));

/** Rank of a stage among TIERS (0 = City), -1 below City or not a living stage. Unknown stages above Megastructure count as one past it. */
export function tierRank(st: number): number {
  const i = TIER_IX.indexOf(st);
  if (i >= 0) return i;
  if (st > STAGE.MEGA && st !== STAGE.ABANDONED && st !== STAGE.DEAD && st < STAGE_NAMES.length) return 3;
  return -1;
}
export function isTier(st: number, t: Tier): boolean { return st >= 0 && TIER_IX[TIERS.indexOf(t)] === st; }

const HULL = new THREE.MeshStandardMaterial({ color: 0x8a919b, metalness: 0.6, roughness: 0.55 });
const RING_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.55, roughness: 0.45, emissive: 0x16302a, emissiveIntensity: 0.6 });
const PANEL_MAT = new THREE.MeshStandardMaterial({ color: 0xd8b060, metalness: 0.9, roughness: 0.28, emissive: 0x6a4a10, emissiveIntensity: 0.9, side: THREE.DoubleSide });

/** A band of land on the inside of a ring world: green and blue stripes under a dark rim. */
function ringLandTex(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 32;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#2b3a2c'; g.fillRect(0, 0, 512, 32);
  const r = new Rng(77);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = r.next() < 0.35 ? '#1d4f7a' : r.next() < 0.5 ? '#3f6b35' : '#6b6a45';
    g.fillRect(r.next() * 512, 6 + r.next() * 18, 4 + r.next() * 30, 3 + r.next() * 8);
  }
  g.fillStyle = '#5b636d'; g.fillRect(0, 0, 512, 4); g.fillRect(0, 28, 512, 4);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(8, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let landTex: THREE.CanvasTexture | null = null;

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, place: (i: number, m: THREE.Matrix4) => void): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { place(i, m); im.setMatrixAt(i, m); }
  im.count = n;
  return im;
}

/** Orbital works around one world in the planet view. */
export class Orbitals {
  private key = '';
  private held: THREE.Object3D[] = [];      // in the rotating orbit group
  private fixed: THREE.Object3D[] = [];     // in the view's group (ring world, lattice)
  private spin: THREE.Object3D[] = [];
  /** 0..1 how much of the star's light still reaches the planet (brain-star, lifted star) */
  starLight = 1;
  starTint = new THREE.Color(1, 1, 1);
  /** what is up there, for a label */
  summary = '';

  reset(): void { this.key = ''; this.held = []; this.fixed = []; this.spin = []; this.starLight = 1; this.summary = ''; }
  /** everything built, each tagged `userData.work` (torus, oneill, bishop, panel, oring, ringworld, lattice) for src/explain */
  get works(): readonly THREE.Object3D[] { return [...this.held, ...this.fixed]; }

  sync(orbit: THREE.Group, group: THREE.Group, snap: StateMsg | null, year: number, b: number, st: number, on: boolean): void {
    const rank = on ? tierRank(st) : -1;
    const has = (id: string) => techAge(snap, id, year) >= 0;
    const tech = { oneill: has('orbitalHabitats'), bishop: has('bishopRings'), d1: has('dyson1'), d2: has('dyson2') };
    const key = `${b}:${rank}:${tech.oneill}:${tech.bishop}:${tech.d1}:${tech.d2}`;
    if (key === this.key) return;
    this.key = key;
    for (const o of this.held) { orbit.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    for (const o of this.fixed) { group.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    this.held = []; this.fixed = []; this.spin = [];
    this.starLight = 1; this.starTint.setRGB(1, 1, 1);
    if (rank < 0) { this.summary = ''; return; }

    const r = new Rng(b * 13 + 5), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    const place = (Rmin: number, Rmax: number, flat = 0.15) => {
      const R = Rmin + r.next() * (Rmax - Rmin), th = r.range(0, Math.PI * 2), inc = r.gauss() * flat;
      return p.set(Math.cos(th) * R, Math.sin(inc) * R, Math.sin(th) * R);
    };
    const n = [18, 72, 160, 220, 260, 260, 240, 160][rank];
    const parts: string[] = [];
    // Stanford tori: wheels with a hub; the early settlers' design, kept on as relics later
    const nTor = Math.round(n * (tech.oneill ? 0.18 : 1));
    if (nTor) {
      this.held.push(instanced(new THREE.TorusGeometry(0.1, 0.022, 8, 24), HULL, nTor, (_i, m) => {
        q.setFromEuler(e.set(r.next() * 3, r.next() * 3, 0));
        m.compose(place(14, 23), q, s);
      }));
      this.held[this.held.length - 1].userData.work = 'torus';
      parts.push(tech.oneill ? 'old Stanford tori' : 'Stanford tori');
    }
    // O'Neill cylinders fly in counter-rotating pairs
    const nCyl = tech.oneill ? Math.round((n - nTor) / 2) : 0;
    if (nCyl) {
      const geo = new THREE.CylinderGeometry(0.035, 0.035, 0.26, 12, 1);
      const off = new THREE.Vector3();
      this.held.push(instanced(geo, HULL, nCyl * 2, (i, m) => {
        if (i % 2 === 0) { q.setFromEuler(e.set(r.next() * 3, r.next() * 3, 0)); place(14, 24); off.set(0.06, 0, 0).applyQuaternion(q); }
        m.compose(p.clone().addScaledVector(off, i % 2 ? 1 : -1), q, s);
      }));
      this.held[this.held.length - 1].userData.work = 'oneill';
      parts.push("O'Neill cylinder pairs");
    }
    // Bishop rings: a few huge thin rings, land on the inside
    if (tech.bishop) {
      const nb = Math.min(9, 2 + rank * 1);
      for (let i = 0; i < nb; i++) {
        const R = 1.1 + r.next() * 1.4;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.04, 6, 96), RING_MAT);
        ring.position.copy(place(15, 26, 0.25));
        ring.rotation.set(r.next() * 3, r.next() * 3, 0);
        ring.userData.work = 'bishop';
        this.held.push(ring); this.spin.push(ring);
      }
      parts.push('Bishop rings');
    }
    // swarm collectors: flat golden panels further out, a dense shell around a swarm-world
    const swarmWorld = isTier(st, 'Swarm-world');
    const nPanels = swarmWorld ? 3200 : tech.d2 ? 900 : tech.d1 ? 300 : 0;
    if (nPanels) {
      const geo = new THREE.CircleGeometry(swarmWorld ? 0.11 : 0.08, 6);
      this.held.push(instanced(geo, PANEL_MAT, nPanels, (_i, m) => {
        if (swarmWorld) { p.set(r.gauss(), r.gauss(), r.gauss()).setLength(12.5 + r.next() * 3.5); }
        else place(25, 31, 0.08);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.clone().normalize());
        m.compose(p, q, s);
      }));
      this.held[this.held.length - 1].userData.work = 'panel';
      parts.push(swarmWorld ? 'a swarm closing round the world' : 'swarm collectors');
    }
    for (const o of this.held) orbit.add(o);

    // Megastructure and up: an orbital ring; a ring world is a broad band of land
    if (rank === 2) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(17, 0.1, 12, 256), new THREE.MeshStandardMaterial({ color: 0xb8ad9e, metalness: 0.5, roughness: 0.5, transparent: true, opacity: 0.4, depthWrite: false }));
      ring.rotation.x = Math.PI / 2 + 0.2;
      ring.userData.work = 'oring';
      this.fixed.push(ring);
      parts.push('an orbital ring');
    }
    if (rank >= 3) {
      landTex ??= ringLandTex();
      const band = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 1.6, 256, 1, true), new THREE.MeshStandardMaterial({ map: landTex, color: 0xffffff, metalness: 0.2, roughness: 0.8, side: THREE.DoubleSide, emissive: 0x0b1a10, emissiveIntensity: 0.5 }));
      band.rotation.set(0.22, 0, 0.12);
      band.userData.work = 'ringworld';
      this.fixed.push(band); this.spin.push(band);
      parts.unshift('a ring world');
    }
    // an uploaded world: a faint lattice of thought wrapped round a dark planet
    if (isTier(st, 'Uploaded')) {
      const lat = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(10.6, 3)), new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
      lat.userData.work = 'lattice';
      this.fixed.push(lat); this.spin.push(lat);
      parts.unshift('a lattice of uploaded minds');
    }
    if (isTier(st, 'Brain-star')) { this.starLight = 0.3; this.starTint.setRGB(1, 0.45, 0.3); parts.push('the star wrapped in thinking shells'); }
    if (isTier(st, 'Lifted star')) { this.starLight = 0.55; this.starTint.setRGB(1, 0.85, 0.75); parts.push('a star being mined'); }
    for (const o of this.fixed) group.add(o);
    this.summary = parts.join(', ');
  }

  frame(t: number): void {
    for (let i = 0; i < this.spin.length; i++) this.spin[i].rotation.y = t * (0.02 + 0.01 * (i % 3));
  }
}

/** Works around the star in the system view: Matrioshka shells, star lifting. */
export class StarWorks {
  private key = '';
  private parts: THREE.Object3D[] = [];
  private jets: THREE.Object3D[] = [];
  private shells: THREE.Object3D[] = [];
  /** a brain-star's shells replace the plain Dyson swarm */
  brain = false;

  reset(): void { this.key = ''; this.parts = []; this.jets = []; this.shells = []; this.brain = false; }

  /** `top`: highest living stage in the system. `star`: the star group (core mesh first, then glow sprites). */
  sync(star: THREE.Group, starR: number, top: number): void {
    const brain = isTier(top, 'Brain-star'), lifted = isTier(top, 'Lifted star');
    const key = `${brain}:${lifted}`;
    if (key === this.key) return;
    this.key = key;
    for (const o of this.parts) { star.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    this.parts = []; this.jets = []; this.shells = [];
    // dim what escapes: a brain-star keeps nearly all its light, a lifted star is smaller and paler
    const dim = brain ? 0.28 : lifted ? 0.55 : 1;
    this.brain = brain;
    star.children.forEach((c, i) => {
      if (i === 0) {
        c.scale.setScalar(lifted ? 0.7 : 1);
        // seen from outside, a brain-star is a dull red ember
        const mm = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
        const base = (c.userData.baseColor ??= mm.color.clone()) as THREE.Color;
        mm.color.copy(base);
        if (brain) mm.color.setRGB(0.55, 0.14, 0.07);
        if (lifted) mm.color.multiplyScalar(0.75);
      }
      const m = (c as THREE.Sprite).material as THREE.SpriteMaterial;
      if (c instanceof THREE.Sprite) {
        const base = (c.userData.baseOpacity ??= m.opacity) as number;
        m.opacity = base * dim;
      }
    });
    if (brain) {
      // nested shells, each cooler (redder) than the one inside it, radiating the waste heat
      const cols = [0xffb070, 0xff7a48, 0xd2462e, 0x8a2a24];
      cols.forEach((c, k) => {
        const R = starR * (1.8 + k * 0.9);
        const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(R, 3), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.16 - k * 0.025, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(R, 2)), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.55 - k * 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
        shell.add(wire);
        shell.userData.work = 'shell'; shell.userData.k = k;
        this.parts.push(shell); this.shells.push(shell);
      });
    }
    if (lifted) {
      // plasma drawn off both poles
      for (const sgn of [1, -1]) {
        const geo = new THREE.ConeGeometry(starR * 0.35, starR * 7, 16, 1, true);
        geo.translate(0, starR * 3.5, 0);
        const jet = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        jet.rotation.z = sgn > 0 ? 0 : Math.PI;
        jet.userData.work = 'jet';
        this.parts.push(jet); this.jets.push(jet);
      }
    }
    for (const o of this.parts) star.add(o);
  }

  frame(t: number, reduced: boolean): void {
    this.shells.forEach((s, k) => { s.rotation.y = t * 0.03 * (k % 2 ? -1 : 1); });
    for (const j of this.jets) ((j as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = reduced ? 0.3 : 0.25 + 0.1 * Math.sin(t * 3);
  }
}
