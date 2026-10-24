// Turning a cursor into (kind, index), for every point, sprite and line drawn.
//
// Point clouds (up to the Milky Way's 420,000 stars) use GPU colour-ID picking:
// on demand only, each pickable cloud is drawn once more with an ID-encoding
// copy of its own material into a tiny render target around the cursor, and
// the few hundred pixels are read back. Index = gl_VertexID, so no extra
// buffers. Within the window the most prominent point at each pixel wins (the
// visual pass is additive, so depth means nothing there); then the candidate
// nearest the cursor, nudged by brightness, is chosen on the CPU.
//
// Sprites, lines, rings and instanced meshes are few, so they use a CPU path:
// each registers a `hit` that measures screen distance itself.

import * as THREE from 'three';
import { shown } from './registry.ts';

export interface GpuSet {
  kind: string;
  points: THREE.Points;
  /** px bonus when ranking against other things under the cursor */
  prio?: number;
  /** points dimmer than this (max channel × fade) can't be picked: hidden slots, black placeholders */
  minLum?: number;
  /** smallest hit disc, css px */
  pickPx?: number;
  enabled?: (p: Probe) => boolean;
}

export interface Probe { x: number; y: number; w: number; h: number; camera: THREE.PerspectiveCamera; ray: THREE.Ray }
export interface CpuHit { i: number; d: number }
export interface CpuSet {
  kind: string;
  obj: THREE.Object3D;
  prio?: number;
  enabled?: (p: Probe) => boolean;
  /** best hit: screen distance in css px (may be negative to claim the cursor) */
  hit(p: Probe): CpuHit | null;
}

export interface Picked { kind: string; i: number; score: number }

const gpuSets = new Map<string, GpuSet>();
const cpuSets = new Map<string, CpuSet>();
export function addGpuSet(s: GpuSet): void { gpuSets.set(s.kind, s); }
export function addCpuSet(s: CpuSet): void { cpuSets.set(s.kind, s); }

// ---------------------------------------------------------------- CPU helpers

const pv = new THREE.Vector3();
/** Screen position (css px, canvas-relative) of a world point; null when behind the camera. */
export function toScreen(p: THREE.Vector3, probe: Probe, out = { x: 0, y: 0 }): { x: number; y: number } | null {
  pv.copy(p).project(probe.camera);
  if (pv.z > 1 || pv.z < -1) return null;
  out.x = (pv.x * 0.5 + 0.5) * probe.w; out.y = (-pv.y * 0.5 + 0.5) * probe.h;
  return out;
}

/** Pixels per world unit at distance d from the camera. */
export function pxPerUnit(probe: Probe, d: number): number {
  return probe.h / 2 / (Math.max(d, 1e-9) * Math.tan((probe.camera.fov * Math.PI) / 360));
}

const s0 = { x: 0, y: 0 }, s1 = { x: 0, y: 0 };
/** Distance from the cursor to the screen segment a–b. */
export function segDist(a: THREE.Vector3, b: THREE.Vector3, probe: Probe): number {
  const A = toScreen(a, probe, s0), B = A && toScreen(b, probe, s1);
  if (!A || !B) return Infinity;
  const dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((probe.x - A.x) * dx + (probe.y - A.y) * dy) / L)) : 0;
  return Math.hypot(A.x + dx * t - probe.x, A.y + dy * t - probe.y);
}

/** Nearest of n world points to the cursor, within an optional per-point radius (px). */
export function nearestPoint(n: number, at: (i: number, out: THREE.Vector3) => THREE.Vector3 | null, probe: Probe, radiusPx?: (i: number, distPx: number, camDist: number) => number): CpuHit | null {
  let best: CpuHit | null = null;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = at(i, v);
    if (!p) continue;
    const s = toScreen(p, probe, s0);
    if (!s) continue;
    let d = Math.hypot(s.x - probe.x, s.y - probe.y);
    if (radiusPx) {
      const r = radiusPx(i, d, probe.camera.position.distanceTo(p));
      if (d > r) continue;
      d = d - r * 0.25;
    }
    if (!best || d < best.d) best = { i, d };
  }
  return best;
}

/** Where the cursor ray crosses the horizontal plane y = h, in world space. */
export function rayPlane(probe: Probe, h = 0, out = new THREE.Vector3()): THREE.Vector3 | null {
  const r = probe.ray;
  if (Math.abs(r.direction.y) < 1e-9) return null;
  const t = (h - r.origin.y) / r.direction.y;
  return t > 0 ? out.copy(r.direction).multiplyScalar(t).add(r.origin) : null;
}

// ---------------------------------------------------------------- GPU path

const VS = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  uniform float uScale, uPixelRatio, uMinPx, uMaxPx, uSlot, uPickPx, uMinLum, uBias;
  varying vec4 vId;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = ATTEN;
    float fade = clamp(px / uMinPx, 0.0, 1.0);
    float lum = max(color.r, max(color.g, color.b)) * fade;
    float shownPx = clamp(px, uMinPx, uMaxPx);
    gl_PointSize = max(shownPx, uPickPx) * uPixelRatio;
    if (lum < uMinLum || size <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
    // brighter, bigger points win a pixel: depth encodes prominence, not distance
    float prom = clamp(uBias + 0.5 * clamp(lum * shownPx / 6.0, 0.0, 1.0), 0.0, 0.999);
    gl_Position.z = (1.0 - 2.0 * prom) * gl_Position.w;
    float id = float(gl_VertexID) + 1.0;
    vId = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), uSlot) / 255.0;
  }`;
const FS = /* glsl */ `
  varying vec4 vId;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vId;
  }`;

const pickMats = new WeakMap<THREE.Material, THREE.ShaderMaterial>();
function pickMaterial(src: THREE.ShaderMaterial): THREE.ShaderMaterial {
  let m = pickMats.get(src);
  if (m) return m;
  const u = src.uniforms;
  const atten = src.userData.attenuate === false ? 'size * uScale' : 'size * uScale * (300.0 / -mv.z)';
  m = new THREE.ShaderMaterial({
    uniforms: {
      uScale: u.uScale, uPixelRatio: u.uPixelRatio, uMinPx: u.uMinPx, uMaxPx: u.uMaxPx,
      uSlot: { value: 0 }, uPickPx: { value: 5 }, uMinLum: { value: 0.004 }, uBias: { value: 0 },
    },
    vertexShader: VS.replace('ATTEN', atten),
    fragmentShader: FS,
    blending: THREE.NoBlending, transparent: false, depthTest: true, depthWrite: true,
  });
  pickMats.set(src, m);
  return m;
}

const REACH = 11; // css px around the cursor

export class Picker {
  private rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
  private buf = new Uint8Array(4);
  private raycaster = new THREE.Raycaster();
  private clear = new THREE.Color();
  constructor(private renderer: THREE.WebGLRenderer, private camera: THREE.PerspectiveCamera) {
    this.rt.texture.generateMipmaps = false;
  }

  /** Best thing under (x, y) css px relative to the canvas, or null. */
  pick(x: number, y: number, w: number, h: number): Picked | null {
    const probe = this.probe(x, y, w, h);
    let best: Picked | null = null;
    const consider = (p: Picked) => { if (p.score <= REACH && (!best || p.score < best.score)) best = p; };
    for (const s of cpuSets.values()) {
      if (s.enabled && !s.enabled(probe)) continue;
      if (!shown(s.obj)) continue;
      const hit = s.hit(probe);
      if (hit) consider({ kind: s.kind, i: hit.i, score: hit.d - (s.prio ?? 0) });
    }
    const g = this.gpu(probe);
    if (g) consider(g);
    return best;
  }

  private probe(x: number, y: number, w: number, h: number): Probe {
    const ndc = new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return { x, y, w, h, camera: this.camera, ray: this.raycaster.ray.clone() };
  }

  private gpu(probe: Probe): Picked | null {
    const sets = [...gpuSets.values()].filter((s) => (!s.enabled || s.enabled(probe)) && shown(s.points)).slice(0, 255);
    if (!sets.length) return null;
    const r = this.renderer, cam = this.camera;
    const pr = r.getPixelRatio();
    const S = Math.ceil((2 * REACH + 1) * pr), W = S / pr;
    if (this.rt.width !== S) { this.rt.setSize(S, S); this.buf = new Uint8Array(S * S * 4); }
    // render only the little window around the cursor, inside whatever offset the view already has
    const v = cam.view ? { ...cam.view } : null;
    const sx = v?.enabled ? v.width / probe.w : 1, sy = v?.enabled ? v.height / probe.h : 1;
    const fullW = v?.enabled ? v.fullWidth : probe.w, fullH = v?.enabled ? v.fullHeight : probe.h;
    const ox = v?.enabled ? v.offsetX : 0, oy = v?.enabled ? v.offsetY : 0;
    cam.setViewOffset(fullW, fullH, ox + (probe.x - W / 2) * sx, oy + (probe.y - W / 2) * sy, W * sx, W * sy);
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear, prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.autoClear = false;
    sets.forEach((s, k) => {
      const src = s.points.material as THREE.ShaderMaterial;
      const pm = pickMaterial(src);
      pm.uniforms.uSlot.value = k + 1;
      pm.uniforms.uPickPx.value = s.pickPx ?? 5;
      pm.uniforms.uMinLum.value = s.minLum ?? 0.004;
      pm.uniforms.uBias.value = Math.max(0, Math.min(0.49, (s.prio ?? 0) / 20));
      s.points.material = pm;
      r.render(s.points, cam);
      s.points.material = src;
    });
    r.readRenderTargetPixels(this.rt, 0, 0, S, S, this.buf);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.setClearColor(this.clear, prevAlpha);
    if (v?.enabled) cam.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();

    // nearest pixel per candidate, then rank by distance less a brightness bonus
    const near = new Map<number, number>();
    const c = (S - 1) / 2;
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      const o = (py * S + px) * 4, slot = this.buf[o + 3];
      if (!slot) continue;
      const id = this.buf[o] + this.buf[o + 1] * 256 + this.buf[o + 2] * 65536 - 1;
      const key = slot * 16777216 + id;
      const d = Math.hypot(px - c, py - c) / pr;
      const was = near.get(key);
      if (was === undefined || d < was) near.set(key, d);
    }
    let best: Picked | null = null;
    for (const [key, d] of near) {
      const slot = Math.floor(key / 16777216), i = key - slot * 16777216;
      const s = sets[slot - 1];
      if (!s) continue;
      const col = s.points.geometry.attributes.color?.array as Float32Array | undefined;
      const lum = col ? Math.min(1, Math.max(col[i * 3], col[i * 3 + 1], col[i * 3 + 2])) : 0;
      const score = d - (s.prio ?? 0) - 3 * lum;
      if (!best || score < best.score) best = { kind: s.kind, i, score };
    }
    return best;
  }
}
