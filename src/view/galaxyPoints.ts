// Particle spiral galaxy: warm bar and bulge, blue-white arms, pink HII knots,
// dark dust lanes, nebula haze. Used for the Milky Way and for Andromeda and
// Triangulum in the universe view.

import * as THREE from 'three';
import { Rng } from '../sim/rng.ts';
import { glowTex, nebulaTex, pointsMaterial } from './textures.ts';

export interface GalaxyParams {
  seed: number;
  count: number;
  radius: number;      // scene units
  arms: number;
  pitch: number;       // degrees
  bar: number;         // bar half-length as fraction of radius (0 = none)
  thickness: number;   // fraction of radius
  sizeScale: number;
  brightness?: number;
  maxPx?: number;      // stars stay points, not discs, when the camera dives in
  dust?: number;       // dust particles per star
}

const CORE = [new THREE.Color(0xffe2b0), new THREE.Color(0xffc488), new THREE.Color(0xffb070)];
const ARM = [new THREE.Color(0xa8c4ff), new THREE.Color(0xd4e2ff), new THREE.Color(0x8fb0ff), new THREE.Color(0xfff2e0)];
const HII = new THREE.Color(0xff5c8a);
/** Palette slot of each particle (meta bits 8–11): 0–2 core, 3–6 arm, 7 halo, 15 a sim star system recoloured to its own type. */
export const PALETTE = [...CORE, ...ARM, new THREE.Color(0xffe8cc)];
export const META = { BULGE: 0, ARM: 1, HALO: 2, HII: 1 << 5, STRAY: 1 << 6, INNER: 1 << 7, LINKED: 15 } as const;
export const metaComp = (m: number) => m & 3;
export const metaArm = (m: number) => (m >> 2) & 7;
export const metaPal = (m: number) => (m >> 8) & 15;

/** What makeGalaxy records so every particle can be explained later. */
export interface GalaxyData {
  stars: THREE.Points;
  meta: Uint16Array;     // component, arm, flags, palette
  bri: Uint8Array;       // brightness multiplier × 200, before the global brightness
  dust: THREE.Points;
  nebulae: THREE.Sprite[];
  nebKind: number[];     // 0 pink emission, 1 blue reflection, 2 orange superbubble
  core: THREE.Sprite;
  R: number;
  arms: number;
  bright: number;
}

export function makeGalaxy(p: GalaxyParams): THREE.Group {
  const r = new Rng(p.seed);
  const group = new THREE.Group();
  const n = p.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  const k = 1 / Math.tan((p.pitch * Math.PI) / 180);
  const R = p.radius;
  const bright = p.brightness ?? 1;
  const c = new THREE.Color();
  const meta = new Uint16Array(n), bri = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const u = r.next();
    let x: number, y: number, z: number;
    if (u < 0.22) {
      // bulge + bar
      // compact: most bulge light within a tenth of the radius
      const along = r.gauss() * R * Math.max(p.bar, 0.08) * 0.6;
      const across = r.gauss() * R * 0.045;
      const ang = 0.45;
      x = along * Math.cos(ang) - across * Math.sin(ang);
      y = along * Math.sin(ang) + across * Math.cos(ang);
      z = r.gauss() * R * 0.035;
      const pi = r.int(0, 2), m = 0.35 + r.next() * 0.45;
      c.copy(CORE[pi]).multiplyScalar(m);
      meta[i] = META.BULGE | (pi << 8); bri[i] = Math.round(m * 200);
      size[i] = (0.7 + r.next() * 1.2) * p.sizeScale;
    } else if (u < 0.96) {
      // spiral arms: log spiral with scatter that grows outward
      const rr = R * (0.1 + Math.min(1, -Math.log(1 - r.next() * 0.985) * 0.28));
      const arm = r.int(0, p.arms - 1);
      const base = Math.log(rr / (R * 0.1)) * k * 0.5 + (arm / p.arms) * Math.PI * 2;
      const spread = 0.18 + 0.3 * (rr / R);
      // most stars hug the arm; a few stray into the gaps
      const gz = r.gauss(), stray = r.next() < 0.1;
      const th = base + gz * spread * (stray ? 1.9 : 0.75);
      x = Math.cos(th) * rr; y = Math.sin(th) * rr;
      z = r.gauss() * R * p.thickness * (1 - 0.5 * rr / R);
      const inner = rr < R * 0.25;
      const pi = inner ? r.int(0, 2) : 3 + r.int(0, 3), m = 0.35 + r.next() * 0.75;
      c.copy(PALETTE[pi]).multiplyScalar(m);
      meta[i] = META.ARM | (arm << 2) | (stray ? META.STRAY : 0) | (inner ? META.INNER : 0) | (pi << 8); bri[i] = Math.round(m * 200);
      size[i] = (0.6 + Math.pow(r.next(), 3) * 3) * p.sizeScale;
      // star-forming knots sit on the arm's spine and tint rather than dot it
      if (!inner && !stray && Math.abs(gz) < 0.35 && r.next() < 0.012) { c.lerp(HII, 0.55).multiplyScalar(0.8); size[i] *= 1.6; meta[i] |= META.HII; }
    } else {
      // halo
      const rr = R * Math.pow(r.next(), 0.5) * 1.2;
      const th = r.range(0, Math.PI * 2), ph = Math.acos(r.range(-1, 1));
      x = rr * Math.sin(ph) * Math.cos(th); y = rr * Math.sin(ph) * Math.sin(th); z = rr * Math.cos(ph) * 0.6;
      const m = 0.25 + r.next() * 0.3;
      c.set(0xffe8cc).multiplyScalar(m);
      meta[i] = META.HALO | (7 << 8); bri[i] = Math.round(m * 200);
      size[i] = 0.6 * p.sizeScale;
    }
    // scene is y-up: galaxy plane is x-z
    pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = y;
    col[i * 3] = c.r * bright; col[i * 3 + 1] = c.g * bright; col[i * 3 + 2] = c.b * bright;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const stars = new THREE.Points(geo, pointsMaterial({ sizeScale: 1, minPx: 0.6, maxPx: p.maxPx ?? 7 }));
  stars.frustumCulled = false;
  group.add(stars);

  // dust lanes: dark, normal-blended particles trailing the arms
  const nd = Math.floor(n * (p.dust ?? 0.2));
  const dpos = new Float32Array(nd * 3), dcol = new Float32Array(nd * 3), dsize = new Float32Array(nd);
  for (let i = 0; i < nd; i++) {
    const rr = R * (0.15 + Math.pow(r.next(), 0.8) * 0.75);
    const arm = r.int(0, p.arms - 1);
    // thin lanes on the inner edge of each arm
    const th = Math.log(rr / (R * 0.1)) * k * 0.5 + (arm / p.arms) * Math.PI * 2 - 0.2 + r.gauss() * 0.045;
    dpos[i * 3] = Math.cos(th) * rr; dpos[i * 3 + 1] = r.gauss() * R * p.thickness * 0.3; dpos[i * 3 + 2] = Math.sin(th) * rr;
    dcol[i * 3] = 0.008; dcol[i * 3 + 1] = 0.005; dcol[i * 3 + 2] = 0.004;
    dsize[i] = (2.5 + r.next() * 3.5) * p.sizeScale;
  }
  const dgeo = new THREE.BufferGeometry();
  dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  dgeo.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
  dgeo.setAttribute('size', new THREE.BufferAttribute(dsize, 1));
  const dust = new THREE.Points(dgeo, pointsMaterial({ opacity: 0.55, blending: THREE.NormalBlending, maxPx: (p.maxPx ?? 7) * 6 }));
  dust.renderOrder = 2;
  dust.frustumCulled = false;
  group.add(dust);

  // haze: big soft sprites, core glow and arm nebulae
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffc98a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 * bright }));
  core.scale.setScalar(R * 0.32);
  group.add(core);
  const nebulae: THREE.Sprite[] = [], nebKind: number[] = [];
  const neb = [nebulaTex(p.seed + 1, [255, 90, 130]), nebulaTex(p.seed + 2, [120, 160, 255]), nebulaTex(p.seed + 3, [255, 190, 140])];
  for (let i = 0; i < 70; i++) {
    const rr = R * r.range(0.15, 0.8);
    const arm = r.int(0, p.arms - 1);
    const th = Math.log(rr / (R * 0.1)) * k * 0.5 + (arm / p.arms) * Math.PI * 2 + r.gauss() * 0.15;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: neb[i % 3], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.11 * bright }));
    sp.position.set(Math.cos(th) * rr, 0, Math.sin(th) * rr);
    sp.scale.setScalar(R * r.range(0.04, 0.11));
    group.add(sp);
    nebulae.push(sp); nebKind.push(i % 3);
  }
  const data: GalaxyData = { stars, meta, bri, dust, nebulae, nebKind, core, R, arms: p.arms, bright };
  group.userData.galaxy = data;
  return group;
}
