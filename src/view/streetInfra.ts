// What a settlement has built around its streets, read from the infrastructure
// model (src/sim/infra.ts): a frontier camp of berms, masts and rovers; then a
// skyline of arcologies with setbacks, running light strips, sky-bridges,
// rooftop pads, hanging gardens and holographic signs; maglev trains on an
// elevated ring; air traffic in lanes and drone swarms; and, overhead, what is
// in orbit: a space elevator's tether, an orbital ring arching across the sky,
// stations glinting, launches climbing from the spaceports, power beams and a
// Dyson swarm's glitter at night. Domed worlds get structural ribs; worlds
// being terraformed get processors venting on the horizon.
//
// Everything is placed from hashes of the body and settlement, so a place looks
// the same every visit; it rebuilds only when the infrastructure changes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Infra } from '../sim/infra.ts';
import { hash01 } from '../sim/rng.ts';
import type { Style } from './epoch.ts';
import { glowTex, pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';

/** What changes the look; the street rebuilds when this does. */
export function infraSig(I: Infra | null): string {
  if (!I) return '-';
  const s = I.surface, o = I.orbit;
  return [I.tier, s.arcologies, s.maglev > 0, s.vacTrain, s.compute, s.farms > 0, s.domes > 0, s.terraformers > 0, s.spaceports,
    o.elevators, o.orbitalRing, o.swarm > 0, o.power > 0, Math.min(30, o.stations + o.habitats + o.rings)].join(':');
}

/** People of a high-tech settlement: a share are machines walking among them; clothes carry light. */
export function peopleTech(I: Infra | null): { robots: number; neon: number } {
  if (!I) return { robots: 0, neon: 0 };
  return { robots: I.has('agi') ? Math.min(0.3, 0.04 + 0.045 * Math.max(0, I.tier - 1)) : 0, neon: Math.max(0, Math.min(1, (I.tier - 2) / 3)) };
}

export interface StreetInfraOpts {
  infra: Infra;
  R: number;
  body: number;
  city: number;
  style: Style;
  /** a facade material (lit windows) from the street, for towers */
  facade: THREE.Material;
  /** the street draws a pressure dome over this place */
  domed: boolean;
  outpost: boolean;
  /** azimuth (radians, atan2(z, x)) the camera looks from; the skyline stands on the far side */
  camAz: number;
}

const up = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion(), tm = new THREE.Matrix4(), tp = new THREE.Vector3(), ts = new THREE.Vector3();

interface Dots { pts: THREE.Points; pos: Float32Array; col: Float32Array; size: Float32Array; n: number }
function dots(n: number, minPx: number, maxPx: number, sizeScale = 0.6): Dots {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const pts = new THREE.Points(geo, pointsMaterial({ minPx, maxPx, sizeScale }));
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  return { pts, pos, col, size, n };
}
function flag(d: Dots): void {
  const g = d.pts.geometry;
  g.attributes.position.needsUpdate = true; g.attributes.size.needsUpdate = true; g.attributes.color.needsUpdate = true;
}

/**
 * Emissive light strips that pulse upward (running lights on tower edges) or
 * flicker as signs. `mode` 0: strips (bands run up with world height),
 * 1: holographic signs (blocks of glyphs that change, scan lines). Instance colour tints.
 */
function lightMaterial(time: { value: number }, mode: 0 | 1): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: mode ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vW; varying vec2 vU; varying vec3 vI;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 w4 = vec4(transformed, 1.0);
        vec4 o4 = vec4(0.0, 0.0, 0.0, 1.0);
        #ifdef USE_INSTANCING
          w4 = instanceMatrix * w4; o4 = instanceMatrix * o4;
        #endif
        vW = (modelMatrix * w4).xyz; vI = (modelMatrix * o4).xyz; vU = uv;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vW; varying vec2 vU; varying vec3 vI; uniform float uTime;
        float lH(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float seed = lH(floor(vI * 3.1));
          ${mode === 0 ? `
          // pulses climbing the strip, each tower its own rhythm, over a steady glow
          float run = pow(0.5 + 0.5 * sin(vW.y * 1.7 - uTime * (1.5 + 2.0 * seed) + seed * 40.0), 10.0);
          diffuseColor.rgb *= 0.16 + 1.3 * run;
          diffuseColor.a *= 0.9;` : `
          // a sign: rows of glyph blocks that change every second or so, scan lines, an occasional flicker
          vec2 g = floor(vU * vec2(9.0, 4.0));
          float t = floor(uTime * (0.6 + seed) + seed * 9.0);
          float glyph = step(0.42, lH(vec3(g, t + seed * 17.0)));
          float frame = 1.0 - step(0.06, min(min(vU.x, 1.0 - vU.x), min(vU.y, 1.0 - vU.y)));
          float scan = 0.75 + 0.25 * sin(vU.y * 120.0 + uTime * 6.0);
          float flick = 0.85 + 0.15 * step(0.12, fract(uTime * 3.0 + seed * 5.0));
          diffuseColor.rgb *= (glyph * 0.9 + frame * 1.2 + 0.12) * scan * flick;
          diffuseColor.a *= 0.85;`}
        }`);
  };
  return m;
}

export class StreetInfra {
  readonly group = new THREE.Group();
  /** height of the tallest thing built, for labels */
  topH = 0;
  private time = { value: 0 };
  private R = 10;
  private camAz = 0;
  // moving things
  private flyers: { lane: number; phase: number; speed: number; alt: number; rx: number; rz: number; tilt: number; straight: boolean }[] = [];
  private flyerMesh: THREE.InstancedMesh | null = null;
  private flyerLen = 0.4;
  private flyerLights: Dots | null = null;
  private drones: Dots | null = null;
  private droneHomes: THREE.Vector3[] = [];
  private trains: { phase: number; cars: number }[] = [];
  private trainMesh: THREE.InstancedMesh | null = null;
  private trainLights: Dots | null = null;
  private trackR = 0; private trackY = 0; private trainSpeed = 0;
  private beacons: Dots | null = null;
  private beaconPhase: number[] = [];
  private climbers: Dots | null = null;
  private tethers: { x: number; z: number; top: number }[] = [];
  private launches: { a: number; d: number; period: number; phase: number }[] = [];
  private launchTrail: THREE.LineSegments | null = null;
  private launchHeads: Dots | null = null;
  private sky: Dots | null = null;
  private skyBase: Float32Array | null = null;
  private swarm: THREE.Points | null = null;
  private swarmLevel = 0;
  private plumes: Dots | null = null;
  private stacks: THREE.Vector3[] = [];
  private beams: THREE.Mesh[] = [];
  private rovers: { r: number; phase: number; speed: number }[] = [];
  private roverMesh: THREE.InstancedMesh | null = null;
  private roverLights: Dots | null = null;
  private cores: THREE.Sprite[] = [];

  build(o: StreetInfraOpts): void {
    this.dispose();
    const I = o.infra, tier = I.tier;
    this.R = o.R;
    this.camAz = o.camAz;
    const h = (k: number, n: number) => hash01(o.body * 7919 + o.city * 131 + k, n, 4242);
    const far = o.camAz + Math.PI;
    // neon palette: the society's glow at first, joined by cyan and magenta as the age advances
    const neon = [o.style.glow.clone(), new THREE.Color(0.3, 0.85, 1), new THREE.Color(1, 0.35, 0.85), new THREE.Color(0.55, 1, 0.6), new THREE.Color(1, 0.75, 0.3)];
    const neonAt = (k: number) => neon[tier >= 3 ? Math.floor(h(k, 77) * neon.length) : 0];

    // frontier kit only where people live behind berms and seals, not on an open, breathable world
    if ((tier <= 1 || o.outpost) && (o.domed || o.outpost)) this.buildFrontier(o, h);
    if (!o.outpost) {
      this.buildSkyline(o, h, far, neonAt);
      if (I.surface.maglev > 0) this.buildMaglev(o, h);
      if (tier >= 2) this.buildTraffic(o, h);
    }
    if (o.domed && I.surface.domes > 0 && tier >= 1) this.buildDome(o);
    this.buildSky(o, h, far);
    if (I.surface.terraformers > 0) this.buildTerraformers(o, h, far);
  }

  // ---------------------------------------------------------------- frontier

  /** Early ages: regolith berms round the edge, a comms mast with a dish, rovers on the tracks outside. */
  private buildFrontier(o: StreetInfraOpts, h: (k: number, n: number) => number): void {
    const R = this.R, s = o.outpost ? 1 : Math.max(1, R / 8);
    const berm = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.style.body).multiplyScalar(1.6).lerp(new THREE.Color(0x5a4636), 0.6), roughness: 1 });
    const bermGeo = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const nB = o.outpost ? 7 : 12;
    const bm = new THREE.InstancedMesh(bermGeo, berm, nB);
    for (let k = 0; k < nB; k++) {
      const a = (k / nB) * Math.PI * 2 + h(k, 1) * 0.4, rr = (o.outpost ? 3.3 : R * 1.15) + h(k, 2) * s * 0.4;
      tq.setFromAxisAngle(up, -a);
      bm.setMatrixAt(k, tm.compose(tp.set(Math.cos(a) * rr, 0, Math.sin(a) * rr), tq, ts.set(s * (0.26 + h(k, 3) * 0.12), s * 0.09, s * 0.22)));
    }
    this.group.add(bm);
    // a lattice mast with a dish and a red light
    const mx = Math.cos(this.camAz + Math.PI * 0.8) * (o.outpost ? 2.6 : R * 1.2), mz = Math.sin(this.camAz + Math.PI * 0.8) * (o.outpost ? 2.6 : R * 1.2);
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a9098, metalness: 0.7, roughness: 0.4 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.05 * s, 2.2 * s, 5), steel);
    mast.position.set(mx, 1.1 * s, mz);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.32 * s, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshStandardMaterial({ color: 0xd8dce2, metalness: 0.4, roughness: 0.35, side: THREE.DoubleSide }));
    dish.position.set(mx, 1.75 * s, mz); dish.rotation.set(-0.9, 0.4, 0);
    this.group.add(mast, dish);
    this.beacons = dots(64, 1.5, 7);
    this.beaconPhase = [];
    this.addBeacon(mx, 2.25 * s, mz, 0);
    // rovers on loops outside
    const nR = o.outpost ? 3 : 5;
    for (let k = 0; k < nR; k++) this.rovers.push({ r: (o.outpost ? 3.4 : R * 1.35) + h(k, 9) * s * 1.5, phase: h(k, 10) * Math.PI * 2, speed: (0.03 + h(k, 11) * 0.03) * (k % 2 ? 1 : -1) / (o.outpost ? 1 : R / 8) });
    const rg = new THREE.BoxGeometry(0.34 * s, 0.12 * s, 0.2 * s);
    this.roverMesh = new THREE.InstancedMesh(rg, new THREE.MeshStandardMaterial({ color: 0xc9b48a, roughness: 0.6, metalness: 0.3, emissive: 0x2a2010 }), nR);
    this.roverMesh.frustumCulled = false;
    this.roverLights = dots(nR * 2, 1.2, 6);
    this.group.add(this.roverMesh, this.roverLights.pts);
  }

  private addBeacon(x: number, y: number, z: number, phase: number): void {
    const b = this.beacons!;
    const k = this.beaconPhase.length;
    if (k >= b.n) return;
    b.pos.set([x, y, z], k * 3);
    b.col.set([1, 0.2, 0.15], k * 3);
    this.beaconPhase.push(phase);
  }

  // ---------------------------------------------------------------- skyline

  /** Arcologies on the far side of the settlement: stacked setbacks with lit windows, edge light strips, crowns, pads, gardens, bridges and signs. */
  private buildSkyline(o: StreetInfraOpts, h: (k: number, n: number) => number, far: number, neonAt: (k: number) => THREE.Color): void {
    const I = o.infra, R = this.R, tier = I.tier;
    // towers: the arcologies, plus a few tall ones in any fusion-age city
    const n = Math.min(34, I.surface.arcologies + (tier >= 2 ? 3 : 0));
    if (!this.beacons) { this.beacons = dots(96, 1.5, 7); this.beaconPhase = []; }
    if (!n) return;
    const grow = 0.55 + 0.2 * tier;
    const towers: { x: number; z: number; w: number; H: number; a: number }[] = [];
    for (let k = 0; k < n; k++) {
      const a = far + (h(k, 1) - 0.5) * 3.3;
      const rr = R * (1.12 + 0.95 * h(k, 2));
      const H = R * (0.32 + 0.95 * Math.pow(h(k, 3), 0.7)) * grow * (rr < R * 1.5 ? 1 : 0.9);
      const w = Math.min(R * 0.16, R * (0.055 + 0.04 * h(k, 4)) * (1 + 0.35 * H / R));
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (towers.some((t) => Math.hypot(t.x - x, t.z - z) < (t.w + w) * 0.9)) continue;
      towers.push({ x, z, w, H, a });
    }
    const segs: THREE.Matrix4[] = [], segCol: THREE.Color[] = [], strips: THREE.Matrix4[] = [], stripCol: THREE.Color[] = [];
    const crowns: THREE.Matrix4[] = [], pads: THREE.Matrix4[] = [], gardens: THREE.Matrix4[] = [];
    const padLights: number[] = [];
    let top = 0;
    towers.forEach((t, k) => {
      const nSeg = 3 + Math.floor(h(k, 5) * 3);
      let y = 0, w = t.w;
      tq.setFromAxisAngle(up, h(k, 6) * Math.PI);
      const body = new THREE.Color(o.style.body).multiplyScalar(1.15 + 0.25 * h(k, 12)).offsetHSL((h(k, 13) - 0.5) * 0.06, 0, 0);
      for (let s = 0; s < nSeg; s++) {
        const sh = (t.H / nSeg) * (s === 0 ? 1.3 : 1) * (0.8 + 0.3 * h(k * 7 + s, 7));
        segs.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, y + sh / 2, t.z), tq.clone(), new THREE.Vector3(w, sh, w)));
        segCol.push(body.clone());
        // light strips on the four corners of the segment
        for (let c = 0; c < 4; c++) {
          const ca = (c / 4) * Math.PI * 2 + Math.PI / 4 + h(k, 6) * Math.PI;
          const off = new THREE.Vector3(Math.cos(ca), 0, -Math.sin(ca)).multiplyScalar(w * 0.71);
          strips.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x + off.x, y + sh / 2, t.z + off.z), tq.clone(), new THREE.Vector3(w * 0.022 + 0.012, sh * 0.98, w * 0.022 + 0.012)));
          stripCol.push(neonAt(k).clone().multiplyScalar(tier >= 3 ? 1 : 0.6));
        }
        // hanging gardens on the setbacks
        if (I.surface.farms > 0 && s > 0 && h(k * 5 + s, 8) < 0.6) gardens.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, y + 0.03, t.z), tq.clone(), new THREE.Vector3(w * 1.08, 0.06, w * 1.08)));
        y += sh;
        w *= 0.8 - 0.06 * h(k * 3 + s, 9);
      }
      // a crown: a needle, a pad, or both
      const needle = t.H * (0.08 + 0.12 * h(k, 10));
      crowns.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, y + needle / 2, t.z), tq.clone(), new THREE.Vector3(1, needle, 1)));
      this.addBeacon(t.x, y + needle, t.z, h(k, 11) * 6.28);
      if (tier >= 2 && h(k, 14) < 0.45) {
        const pw = w * 1.6;
        pads.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, y + 0.02, t.z), new THREE.Quaternion(), new THREE.Vector3(pw, 0.04, pw)));
        for (let c = 0; c < 6; c++) { const ca = (c / 6) * Math.PI * 2; padLights.push(t.x + Math.cos(ca) * pw * 0.5, y + 0.06, t.z + Math.sin(ca) * pw * 0.5); }
      }
      top = Math.max(top, y + needle);
    });
    this.topH = top;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const seg = new THREE.InstancedMesh(boxGeo, o.facade, segs.length);
    segs.forEach((m, k) => { seg.setMatrixAt(k, m); seg.setColorAt(k, segCol[k]); });
    this.group.add(seg);
    const strip = new THREE.InstancedMesh(boxGeo, lightMaterial(this.time, 0), strips.length);
    strips.forEach((m, k) => { strip.setMatrixAt(k, m); strip.setColorAt(k, stripCol[k]); });
    this.group.add(strip);
    const crown = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.01, R * 0.008 + 0.03, 1, 6), new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 0.8, roughness: 0.25 }), crowns.length);
    crowns.forEach((m, k) => crown.setMatrixAt(k, m));
    this.group.add(crown);
    if (pads.length) {
      const pad = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 24), new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.5, roughness: 0.5, emissive: 0x0c1a24 }), pads.length);
      pads.forEach((m, k) => pad.setMatrixAt(k, m));
      this.group.add(pad);
      const pl = dots(padLights.length / 3, 1, 5, 0.5);
      pl.pos.set(padLights);
      for (let k = 0; k < pl.n; k++) { pl.col.set([0.35, 0.95, 0.6], k * 3); pl.size[k] = 0.25; }
      flag(pl);
      this.group.add(pl.pts);
    }
    if (gardens.length) {
      const gm = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x2f5a30, emissive: 0x2a6a34, emissiveIntensity: 0.45, roughness: 0.9 }), gardens.length);
      gardens.forEach((m, k) => gm.setMatrixAt(k, m));
      this.group.add(gm);
    }
    // sky-bridges: neighbouring towers linked at a few heights, lit underneath
    if (tier >= 2 && towers.length > 1) {
      const bridges: THREE.Matrix4[] = [];
      const dir = new THREE.Vector3();
      towers.forEach((t, k) => {
        let best = -1, bd = Infinity;
        towers.forEach((u, m) => { const d = Math.hypot(t.x - u.x, t.z - u.z); if (m !== k && d < bd && d < R * 0.75) { bd = d; best = m; } });
        if (best < 0 || best < k) return;
        const u = towers[best];
        const levels = tier >= 4 ? 3 : tier >= 3 ? 2 : 1;
        for (let l = 0; l < levels; l++) {
          const y = Math.min(t.H, u.H) * (0.3 + 0.22 * l + 0.1 * h(k * 3 + l, 15));
          dir.set(u.x - t.x, 0, u.z - t.z);
          tq.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
          bridges.push(new THREE.Matrix4().compose(new THREE.Vector3((t.x + u.x) / 2, y, (t.z + u.z) / 2), tq.clone(), new THREE.Vector3(dir.length(), 0.06 + R * 0.004, 0.1 + R * 0.006)));
        }
      });
      if (bridges.length) {
        const bm = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.6, roughness: 0.3, emissive: o.style.glow, emissiveIntensity: 0.35 }), bridges.length);
        bridges.forEach((m, k) => bm.setMatrixAt(k, m));
        this.group.add(bm);
      }
    }
    // holographic signs on the faces that look toward the streets
    if (tier >= 3) {
      const nSign = Math.min(28, towers.length * 2);
      const sg = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), lightMaterial(this.time, 1), nSign);
      for (let k = 0; k < nSign; k++) {
        const t = towers[k % towers.length];
        const toC = new THREE.Vector3(-t.x, 0, -t.z).normalize();
        const y = t.H * (0.25 + 0.5 * h(k, 16));
        const pos = new THREE.Vector3(t.x, y, t.z).addScaledVector(toC, t.w * 0.62);
        tq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toC);
        const wide = h(k, 17) < 0.5;
        sg.setMatrixAt(k, tm.compose(pos, tq, ts.set(t.w * (wide ? 1.3 : 0.45), t.w * (wide ? 0.5 : 1.4), 1)));
        sg.setColorAt(k, neonAt(k + 3));
      }
      this.group.add(sg);
    }
    // data cores: dark monoliths whose seams breathe cyan (AGI onward; brain-scale late)
    const nCore = Math.min(6, I.surface.compute >> 1);
    for (let k = 0; k < nCore; k++) {
      const a = far + (h(k, 18) - 0.5) * 2.4, rr = R * (1.05 + 0.25 * h(k, 19));
      const H = R * (0.12 + 0.12 * h(k, 20)) * (I.has('matrioshka') ? 1.8 : 1);
      const m = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x07080b, metalness: 0.9, roughness: 0.2, emissive: 0x0a2a40, emissiveIntensity: 0.6 }));
      m.scale.set(R * 0.03 + 0.1, H, R * 0.08 + 0.2); m.position.set(Math.cos(a) * rr, H / 2, Math.sin(a) * rr); m.rotation.y = -a;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x4fd8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
      glow.position.set(m.position.x, H * 0.5, m.position.z); glow.scale.setScalar(H * 0.7);
      this.cores.push(glow);
      this.group.add(m, glow);
    }
  }

  // ---------------------------------------------------------------- transit

  /** An elevated maglev ring just outside the settlement, on pylons, with trains gliding round; a sealed vacuum tube once fusion pays for it. */
  private buildMaglev(o: StreetInfraOpts, h: (k: number, n: number) => number): void {
    const R = this.R, I = o.infra;
    this.trackR = R * 1.06; this.trackY = 0.35 + R * 0.025;
    const steel = new THREE.MeshStandardMaterial({ color: 0xa8b0bc, metalness: 0.75, roughness: 0.3 });
    const track = new THREE.Mesh(new THREE.TorusGeometry(this.trackR, 0.045 + R * 0.002, 6, 320), steel);
    track.rotation.x = Math.PI / 2; track.position.y = this.trackY;
    const guide = new THREE.Mesh(new THREE.TorusGeometry(this.trackR, 0.012 + R * 0.0006, 4, 320), new THREE.MeshBasicMaterial({ color: o.style.glow, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    guide.rotation.x = Math.PI / 2; guide.position.y = this.trackY + 0.05;
    this.group.add(track, guide);
    const nP = 48;
    const pylon = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.05, 1, 6), steel, nP);
    for (let k = 0; k < nP; k++) {
      const a = (k / nP) * Math.PI * 2;
      pylon.setMatrixAt(k, tm.compose(tp.set(Math.cos(a) * this.trackR, this.trackY / 2, Math.sin(a) * this.trackR), tq.identity(), ts.set(1, this.trackY, 1)));
    }
    this.group.add(pylon);
    if (I.surface.vacTrain) {
      const tube = new THREE.Mesh(new THREE.TorusGeometry(this.trackR, 0.12 + R * 0.003, 10, 320), new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.13, roughness: 0.05, metalness: 0.2, depthWrite: false }));
      tube.rotation.x = Math.PI / 2; tube.position.y = this.trackY + 0.1;
      this.group.add(tube);
    }
    const nT = 2 + Math.round(I.surface.maglev * 4);
    for (let k = 0; k < nT; k++) this.trains.push({ phase: (k / nT) * Math.PI * 2 + h(k, 30) * 0.4, cars: 4 + Math.floor(h(k, 31) * 4) });
    const total = this.trains.reduce((a, t) => a + t.cars, 0);
    const carLen = 0.42 + R * 0.006;
    this.trainMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.075 + R * 0.0015, carLen, 4, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8ecf2, metalness: 0.5, roughness: 0.2, emissive: o.style.glow, emissiveIntensity: 0.25 }), total);
    this.trainMesh.frustumCulled = false;
    this.trainLights = dots(total, 1.2, 6);
    this.trainSpeed = (I.surface.vacTrain ? 3.2 : 1.4) / this.trackR;
    this.group.add(this.trainMesh, this.trainLights.pts);
  }

  /** Air traffic in lanes at several heights and straight corridors across, plus drone swarms working round the towers. */
  private buildTraffic(o: StreetInfraOpts, h: (k: number, n: number) => number): void {
    const R = this.R, tier = o.infra.tier;
    const n = [0, 0, 36, 110, 180, 240, 280][tier] ?? 280;
    const lanes = [0.22, 0.38, 0.58, 0.85];
    for (let k = 0; k < n; k++) {
      const straight = k % 5 === 0;
      const lane = k % lanes.length;
      this.flyers.push({
        lane, phase: h(k, 40) * Math.PI * 2, speed: (0.6 + 0.6 * h(k, 41)) * (lane % 2 ? 1 : -1) * (tier >= 4 ? 1.4 : 1),
        alt: R * lanes[lane] * (0.9 + 0.2 * h(k, 42)), rx: R * (0.45 + 0.35 * lane + 0.1 * h(k, 43)), rz: R * (0.4 + 0.3 * lane + 0.1 * h(k, 44)),
        tilt: h(k, 45) * Math.PI, straight,
      });
    }
    const len = (0.4 + R * 0.008) * 1.6; // big enough for the Roadster shape to read
    this.flyerLen = len;
    this.flyerMesh = new THREE.InstancedMesh(roadster(len), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.28, emissive: 0x0a0d12 }), n);
    for (let k = 0; k < n; k++) this.flyerMesh.setColorAt(k, PAINT[Math.floor(h(k, 46) * PAINT.length)]);
    this.flyerMesh.frustumCulled = false;
    this.flyerLights = dots(n * 2, 1.2, 6);
    this.group.add(this.flyerMesh, this.flyerLights.pts);
    if (tier >= 3) {
      const nd = Math.min(420, 70 * (tier - 2));
      this.drones = dots(nd, 0.9, 4, 0.5);
      const homes = 8;
      for (let k = 0; k < homes; k++) {
        const a = this.camAz + Math.PI + (h(k, 46) - 0.5) * 3, rr = R * (0.4 + 0.8 * h(k, 47));
        this.droneHomes.push(new THREE.Vector3(Math.cos(a) * rr, R * (0.15 + 0.4 * h(k, 48)), Math.sin(a) * rr));
      }
      this.group.add(this.drones.pts);
    }
  }

  // ---------------------------------------------------------------- domes

  /** A pressure dome with real structure: meridian ribs, hoop rings and a faint glass skin. */
  private buildDome(o: StreetInfraOpts): void {
    const R = this.R * (o.outpost ? 0.7 : 1.06), tier = o.infra.tier;
    const ribs = 10 + tier * 4;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, metalness: 0.8, roughness: 0.3, emissive: 0x0e1822 });
    const rib = new THREE.InstancedMesh(new THREE.TorusGeometry(R, 0.03 + R * 0.002, 4, 64, Math.PI), mat, ribs);
    for (let k = 0; k < ribs; k++) rib.setMatrixAt(k, tm.makeRotationY((k / ribs) * Math.PI));
    this.group.add(rib);
    for (const lat of [0.35, 0.65, 0.88]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(R * Math.cos(Math.asin(lat)), 0.025 + R * 0.0015, 4, 128), mat);
      hoop.rotation.x = Math.PI / 2; hoop.position.y = R * lat;
      this.group.add(hoop);
    }
    const skin = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.05, roughness: 0.05, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide }));
    this.group.add(skin);
  }

  // ---------------------------------------------------------------- the sky

  /** What is in orbit, seen from the ground. */
  private buildSky(o: StreetInfraOpts, h: (k: number, n: number) => number, far: number): void {
    const I = o.infra, R = Math.max(this.R, 5), orb = I.orbit;
    // space elevators: a tether rising out of sight, climbers riding it
    for (let k = 0; k < orb.elevators; k++) {
      const a = far + (k - (orb.elevators - 1) / 2) * 0.9 + 0.35, d = R * (4 + 3 * k);
      const x = Math.cos(a) * d, z = Math.sin(a) * d, top = R * 90;
      this.tethers.push({ x, z, top });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([x, 0, z, x, top, z], 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute([0.9, 0.95, 1, 0.15, 0.2, 0.3], 3));
      this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.08, R * 0.16, R * 0.18, 8), new THREE.MeshStandardMaterial({ color: 0x8e96a2, metalness: 0.6, roughness: 0.4, emissive: 0x101820 }));
      base.position.set(x, R * 0.09, z);
      this.group.add(base);
    }
    if (this.tethers.length) { this.climbers = dots(this.tethers.length * 6, 1.4, 6); this.group.add(this.climbers.pts); }
    // an orbital ring: a bright band arching across the sky, studded with lights
    if (orb.orbitalRing) {
      const RR = R * 60, cx = Math.cos(far) * R * 10, cz = Math.sin(far) * R * 10;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(RR, R * 0.35, 8, 400), new THREE.MeshBasicMaterial({ color: 0xc8d4e4, transparent: true, opacity: 0.55, depthWrite: false }));
      ring.position.set(cx, -RR * 0.55, cz);
      ring.rotation.set(0, -far + Math.PI / 2, 0);
      ring.rotateX(0.35);
      this.group.add(ring);
      const nL = 260, lights = dots(nL, 1, 4, 0.6);
      const p = new THREE.Vector3();
      for (let k = 0; k < nL; k++) {
        const t = (k / nL) * Math.PI * 2;
        p.set(Math.cos(t) * RR, Math.sin(t) * RR, R * 0.36).applyEuler(ring.rotation).add(ring.position);
        lights.pos.set([p.x, p.y, p.z], k * 3); lights.col.set(k % 4 ? [0.8, 0.9, 1] : [1, 0.6, 0.3], k * 3); lights.size[k] = 2.4;
      }
      flag(lights);
      this.group.add(lights.pts);
    }
    // stations, habitats and rings: points crossing the sky
    const nSky = Math.min(40, orb.stations + orb.habitats * 2 + orb.rings * 3 + (orb.comms > 100 ? 8 : 0));
    if (nSky) {
      this.sky = dots(nSky, 1.2, 7, 0.8);
      this.skyBase = new Float32Array(nSky * 3);
      for (let k = 0; k < nSky; k++) {
        this.skyBase.set([h(k, 50) * Math.PI * 2, 0.3 + 0.9 * h(k, 51), 0.004 + 0.01 * h(k, 52)], k * 3);
        const big = k < orb.habitats * 2 + orb.rings * 3;
        this.sky.col.set(big ? [1, 0.95, 0.85] : [0.8, 0.9, 1], k * 3);
        this.sky.size[k] = big ? 7 : 3.5;
      }
      this.group.add(this.sky.pts);
    }
    // launches from the spaceports, climbing and pitching over beyond the horizon
    const nLaunch = Math.min(4, I.surface.spaceports);
    for (let k = 0; k < nLaunch; k++) this.launches.push({ a: far + (h(k, 60) - 0.5) * 2.6, d: R * (6 + 6 * h(k, 61)), period: 16 + 18 * h(k, 62) - Math.min(8, I.surface.spaceports), phase: h(k, 63) });
    if (this.launches.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.launches.length * 24 * 6), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.launches.length * 24 * 6), 3));
      this.launchTrail = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.launchTrail.frustumCulled = false;
      this.launchHeads = dots(this.launches.length * 2, 2, 22, 1);
      this.group.add(this.launchTrail, this.launchHeads.pts);
    }
    // power satellites beaming down to rectennas on the horizon
    const nBeam = Math.min(3, Math.ceil(orb.power / 12));
    for (let k = 0; k < nBeam; k++) {
      const a = far + (h(k, 70) - 0.5) * 2.2, d = R * (5 + 5 * h(k, 71)), H = R * 70;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.025, R * 0.08, H, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0.03, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.position.set(Math.cos(a) * d, H / 2, Math.sin(a) * d);
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.35, R * 0.35, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x3a3a40, emissive: 0x5a3010, emissiveIntensity: 0.5, metalness: 0.6 }));
      dish.position.set(beam.position.x, 0.03, beam.position.z);
      this.beams.push(beam);
      this.group.add(beam, dish);
    }
    // a Dyson swarm: a glittering band across the night sky
    if (orb.swarm > 0) {
      const nS = 4200, pos = new Float32Array(nS * 3), col = new Float32Array(nS * 3), size = new Float32Array(nS);
      const D = R * 80, tilt = 0.5;
      for (let k = 0; k < nS; k++) {
        const t = hash01(k, 1, o.body) * Math.PI, spread = (hash01(k, 2, o.body) - 0.5) * 0.12;
        const v = new THREE.Vector3(Math.cos(t), Math.sin(t) * Math.cos(tilt) + spread, Math.sin(t) * Math.sin(tilt)).normalize().multiplyScalar(D);
        v.applyAxisAngle(up, far);
        pos.set([v.x, Math.abs(v.y), v.z], k * 3);
        const warm = hash01(k, 3, o.body);
        col.set([1, 0.8 + 0.2 * warm, 0.55 + 0.4 * warm], k * 3);
        size[k] = 1 + 2.2 * hash01(k, 4, o.body) ** 3;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('size', new THREE.BufferAttribute(size, 1));
      this.swarm = new THREE.Points(g, pointsMaterial({ minPx: 1, maxPx: 4, sizeScale: 1.5, attenuate: false }));
      this.swarm.frustumCulled = false;
      this.swarmLevel = orb.swarm;
      this.group.add(this.swarm);
    }
  }

  /** Atmosphere processors on the horizon, venting plumes while terraforming runs. */
  private buildTerraformers(o: StreetInfraOpts, h: (k: number, n: number) => number, far: number): void {
    const R = Math.max(this.R, 5), n = Math.min(6, o.infra.surface.terraformers);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4744, metalness: 0.3, roughness: 0.8, emissive: 0x2a1206, emissiveIntensity: 0.4, side: THREE.DoubleSide });
    for (let k = 0; k < n; k++) {
      const a = far + (h(k, 80) - 0.5) * 3, d = R * (3.2 + 2.4 * h(k, 81)), H = R * (0.22 + 0.16 * h(k, 82));
      // a cooling-tower stack: waisted, venting from the lip
      const prof = [0, 0.15, 0.5, 0.8, 1].map((y) => new THREE.Vector2(R * (0.16 - 0.07 * Math.sin(y * Math.PI * 0.85)), y * H - H / 2));
      const stack = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), mat);
      stack.position.set(Math.cos(a) * d, H / 2, Math.sin(a) * d);
      this.group.add(stack);
      this.stacks.push(new THREE.Vector3(stack.position.x, H, stack.position.z));
    }
    this.plumes = dots(n * 40, 2, 40, 1.4);
    this.group.add(this.plumes.pts);
  }

  // ---------------------------------------------------------------- per frame

  /** `t` real seconds, `night` 0..1. */
  frame(t: number, night: number): void {
    const T = REDUCED_MOTION ? t * 0.3 : t, R = this.R;
    this.time.value = T;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), d = new THREE.Vector3();
    // beacons blink
    if (this.beacons) {
      const b = this.beacons;
      for (let k = 0; k < this.beaconPhase.length; k++) b.size[k] = REDUCED_MOTION ? 0.5 : (Math.sin(T * 2.4 + this.beaconPhase[k]) > 0.6 ? 0.9 : 0.12) * (0.5 + night);
      b.pts.geometry.setDrawRange(0, this.beaconPhase.length);
      flag(b);
      if (!b.pts.parent) this.group.add(b.pts);
    }
    if (this.roverMesh && this.roverLights) {
      this.rovers.forEach((r, k) => {
        const a = r.phase + T * r.speed;
        p.set(Math.cos(a) * r.r, 0.06, Math.sin(a) * r.r);
        q.setFromAxisAngle(up, -a + (r.speed > 0 ? 0 : Math.PI));
        this.roverMesh!.setMatrixAt(k, m.compose(p, q, s));
        d.set(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(Math.sign(r.speed) * 0.2);
        this.roverLights!.pos.set([p.x + d.x, 0.1, p.z + d.z], k * 6); this.roverLights!.col.set([1, 0.95, 0.8], k * 6); this.roverLights!.size[k * 2] = 0.6;
        this.roverLights!.pos.set([p.x - d.x, 0.12, p.z - d.z], k * 6 + 3); this.roverLights!.col.set([1, 0.7, 0.2], k * 6 + 3); this.roverLights!.size[k * 2 + 1] = Math.sin(T * 5 + k) > 0 ? 0.5 : 0.05;
      });
      this.roverMesh.instanceMatrix.needsUpdate = true;
      flag(this.roverLights);
    }
    if (this.trainMesh && this.trainLights) {
      let i = 0;
      const gap = (0.5 + R * 0.006) / this.trackR;
      for (const tr of this.trains) for (let c = 0; c < tr.cars; c++) {
        const a = tr.phase + T * this.trainSpeed - c * gap;
        p.set(Math.cos(a) * this.trackR, this.trackY + 0.1, Math.sin(a) * this.trackR);
        q.setFromAxisAngle(up, -a - Math.PI / 2);
        this.trainMesh.setMatrixAt(i, m.compose(p, q, s));
        this.trainLights.pos.set([p.x, p.y + 0.02, p.z], i * 3);
        this.trainLights.col.set(c === 0 ? [1, 1, 0.9] : [0.55, 0.85, 1], i * 3);
        this.trainLights.size[i] = c === 0 ? 1 : 0.35 * (0.3 + night);
        i++;
      }
      this.trainMesh.instanceMatrix.needsUpdate = true;
      flag(this.trainLights);
    }
    if (this.flyerMesh && this.flyerLights) {
      this.flyers.forEach((f, k) => {
        if (f.straight) {
          // a corridor across the city: fly in from beyond the edge, out the other side
          const u = ((T * f.speed * 0.06 + f.phase) % 2 + 2) % 2 - 1;
          d.set(Math.cos(f.tilt), 0, Math.sin(f.tilt));
          p.copy(d).multiplyScalar(u * R * 1.8).setY(f.alt);
          q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().multiplyScalar(Math.sign(f.speed)));
        } else {
          const a = f.phase + T * f.speed * 0.25 / Math.max(1, f.rx / 4);
          p.set(Math.cos(a) * f.rx, f.alt + Math.sin(a * 3 + f.phase) * R * 0.01, Math.sin(a) * f.rz);
          d.set(-Math.sin(a) * f.rx, 0, Math.cos(a) * f.rz).normalize().multiplyScalar(Math.sign(f.speed));
          q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
        }
        this.flyerMesh!.setMatrixAt(k, m.compose(p, q, s));
        const L = this.flyerLights!;
        const e = this.flyerLen * 0.5; // head and tail lights at the nose and the ducktail
        L.pos.set([p.x + d.x * e, p.y, p.z + d.z * e], k * 6); L.col.set([1, 0.97, 0.9], k * 6); L.size[k * 2] = 0.8 + 0.6 * night;
        L.pos.set([p.x - d.x * e, p.y, p.z - d.z * e], k * 6 + 3); L.col.set(k % 7 ? [1, 0.22, 0.18] : [0.3, 0.9, 1], k * 6 + 3);
        L.size[k * 2 + 1] = (k % 7 ? 0.7 : Math.sin(T * 6 + k) > 0.5 ? 1.3 : 0.1) * (0.6 + night);
      });
      this.flyerMesh.instanceMatrix.needsUpdate = true;
      flag(this.flyerLights);
    }
    if (this.drones) {
      const D = this.drones, nh = this.droneHomes.length;
      for (let k = 0; k < D.n; k++) {
        const c = this.droneHomes[k % nh], w1 = 0.4 + hash01(k, 91) * 0.8, ph = hash01(k, 92) * 6.28, r = R * (0.04 + 0.08 * hash01(k, 93));
        D.pos.set([c.x + Math.sin(T * w1 + ph) * r, c.y + Math.sin(T * w1 * 1.7 + ph * 2) * r * 0.5, c.z + Math.cos(T * w1 * 0.9 + ph) * r], k * 3);
        D.col.set(k % 3 ? [0.4, 0.9, 1] : [1, 0.45, 0.8], k * 3);
        D.size[k] = 0.18 + 0.25 * night;
      }
      flag(D);
    }
    if (this.climbers) {
      const C = this.climbers;
      this.tethers.forEach((te, k) => {
        for (let j = 0; j < 6; j++) {
          const u = ((T * 0.012 * (j % 2 ? 1 : -1) + j / 6) % 1 + 1) % 1;
          C.pos.set([te.x, u * te.top * 0.6, te.z], (k * 6 + j) * 3);
          C.col.set(j % 2 ? [1, 0.85, 0.5] : [0.6, 0.9, 1], (k * 6 + j) * 3);
          C.size[k * 6 + j] = 2.5;
        }
      });
      flag(C);
    }
    if (this.sky && this.skyBase) {
      const S = this.sky, D = R * 70;
      for (let k = 0; k < S.n; k++) {
        const az = this.skyBase[k * 3] + T * this.skyBase[k * 3 + 2], el = this.skyBase[k * 3 + 1];
        S.pos.set([Math.cos(az) * Math.cos(el) * D, Math.sin(el) * D, Math.sin(az) * Math.cos(el) * D], k * 3);
      }
      flag(S);
    }
    if (this.launchTrail && this.launchHeads) {
      const pos = this.launchTrail.geometry.attributes.position.array as Float32Array, col = this.launchTrail.geometry.attributes.color.array as Float32Array;
      const H = this.launchHeads, N = 24;
      pos.fill(0); col.fill(0);
      this.launches.forEach((l, k) => {
        const u = ((T / l.period + l.phase) % 1);
        const fly = Math.min(1, u / 0.45);
        const base = new THREE.Vector3(Math.cos(l.a) * l.d, 0, Math.sin(l.a) * l.d);
        const away = new THREE.Vector3(Math.cos(l.a), 0, Math.sin(l.a));
        // climb, then pitch over downrange
        const at = (f: number, out: THREE.Vector3) => out.copy(base).addScaledVector(away, R * 18 * f * f).setY(R * 30 * (1 - (1 - f) ** 2));
        const fade = u < 0.45 ? 1 : Math.max(0, 1 - (u - 0.45) / 0.35);
        for (let j = 0; j < N; j++) {
          const f0 = (j / N) * fly, f1 = ((j + 1) / N) * fly;
          at(f0, p); at(f1, d);
          const o = (k * N + j) * 6;
          pos.set([p.x, p.y, p.z, d.x, d.y, d.z], o);
          const w0 = (0.15 + 0.85 * (j / N) ** 2) * fade, w1 = (0.15 + 0.85 * ((j + 1) / N) ** 2) * fade;
          col.set([w0 * 0.9, w0 * 0.85, w0 * 0.8, w1, w1 * 0.8, w1 * 0.55], o);
        }
        at(fly, p);
        H.pos.set([p.x, p.y, p.z], k * 6); H.col.set([1, 0.85, 0.55], k * 6); H.size[k * 2] = u < 0.45 ? 9 : 0;
        // the pad flashes at lift-off
        H.pos.set([base.x, 0.2, base.z], k * 6 + 3); H.col.set([1, 0.7, 0.35], k * 6 + 3); H.size[k * 2 + 1] = u < 0.06 ? 30 * (1 - u / 0.06) : 0;
      });
      this.launchTrail.geometry.attributes.position.needsUpdate = true; this.launchTrail.geometry.attributes.color.needsUpdate = true;
      flag(H);
    }
    if (this.swarm) (this.swarm.material as THREE.ShaderMaterial).uniforms.uOpacity.value = night * (0.4 + 0.6 * this.swarmLevel);
    for (const b of this.beams) (b.material as THREE.MeshBasicMaterial).opacity = 0.02 + 0.025 * (REDUCED_MOTION ? 0.5 : 0.5 + 0.5 * Math.sin(T * 1.3)) + 0.03 * night;
    for (const [k, c] of this.cores.entries()) (c.material as THREE.SpriteMaterial).opacity = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(T * 0.8 + k));
    if (this.plumes) {
      const P = this.plumes, per = 40;
      this.stacks.forEach((st, k) => {
        for (let j = 0; j < per; j++) {
          const u = ((T * 0.05 + j / per + hash01(k, j, 95) * 0.1) % 1);
          const drift = u * u * R * 0.8;
          P.pos.set([st.x + drift * 0.7 + (hash01(k, j, 96) - 0.5) * R * 0.1 * u, st.y + u * R * 0.9, st.z + drift * 0.3], (k * per + j) * 3);
          const g = 0.55 + 0.25 * hash01(k, j, 97);
          P.col.set([g * (1 - u * 0.4), g * (1 - u * 0.45), g * (1 - u * 0.5)], (k * per + j) * 3);
          P.size[k * per + j] = (6 + 30 * u) * (1 - u) * 0.6;
        }
      });
      flag(P);
    }
  }

  dispose(): void {
    this.group.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) g.dispose(); });
    this.group.clear();
    this.topH = 0;
    this.flyers = []; this.flyerMesh = null; this.flyerLights = null; this.drones = null; this.droneHomes = [];
    this.trains = []; this.trainMesh = null; this.trainLights = null;
    this.beacons = null; this.beaconPhase = []; this.climbers = null; this.tethers = [];
    this.launches = []; this.launchTrail = null; this.launchHeads = null; this.sky = null; this.skyBase = null; this.swarm = null;
    this.plumes = null; this.stacks = []; this.beams = []; this.rovers = []; this.roverMesh = null; this.roverLights = null; this.cores = [];
  }
}

// Flying cars are Roadsters: a long, low two-seat wedge with a fastback canopy, nose along +x.
// Paint comes from the instance colour (body vertices are white); glass, wheels and trim are dark.
const PAINT = [0xb3121c, 0xb3121c, 0xb3121c, 0xe9ecef, 0x15171a, 0xa7adb5, 0x1f4fa8].map((c) => new THREE.Color(c));
function roadster(len: number): THREE.BufferGeometry {
  const tint = (g: THREE.BufferGeometry, f: (x: number, y: number, z: number) => number) => {
    const P = g.attributes.position, c = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { const k = f(P.getX(i), P.getY(i), P.getZ(i)); c.set([k, k, k], i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  // side profile, rear (-0.5) to nose (+0.5): low nose, long hood, raked windscreen, short fastback roof, ducktail
  const sp = new THREE.Shape();
  sp.moveTo(-0.5, 0.07);
  sp.lineTo(0.47, 0.07);
  sp.quadraticCurveTo(0.53, 0.09, 0.5, 0.14);
  sp.quadraticCurveTo(0.36, 0.19, 0.16, 0.21);
  sp.quadraticCurveTo(0.02, 0.31, -0.1, 0.31);
  sp.quadraticCurveTo(-0.3, 0.29, -0.44, 0.22);
  sp.lineTo(-0.5, 0.21);
  sp.lineTo(-0.5, 0.07);
  const body = new THREE.ExtrudeGeometry(sp, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2, curveSegments: 8 });
  body.translate(0, 0, -0.18);
  // the cabin glass: everything above the beltline between windscreen and tail reads as dark glass
  tint(body, (x, y) => (y > 0.235 && x < 0.13 && x > -0.36 ? 0.08 : 1));
  const parts: THREE.BufferGeometry[] = [body.toNonIndexed()];
  for (const [x, z] of [[0.31, 0.2], [0.31, -0.2], [-0.32, 0.2], [-0.32, -0.2]]) {
    const w = new THREE.CylinderGeometry(0.078, 0.078, 0.07, 14);
    w.rotateX(Math.PI / 2);
    w.translate(x, 0.075, z);
    parts.push(tint(w, (_x, _y, zz) => (Math.abs(Math.abs(zz) - 0.2) < 0.03 ? 0.3 : 0.06)).toNonIndexed());
  }
  for (const g of parts) { g.deleteAttribute('uv'); if (!g.attributes.color) tint(g, () => 1); }
  const car = mergeGeometries(parts)!;
  car.translate(0, -0.15, 0);
  car.scale(len, len, len);
  car.computeVertexNormals();
  return car;
}
