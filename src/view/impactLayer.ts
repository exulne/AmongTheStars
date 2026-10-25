// The impact visualization's Three.js layer: everything it draws, fixed to the
// rotating body frame PlanetView lends it (impactFrame: radius 10 = the body's
// radius). It reads a VisualScenario and the pure per-instant VizState from
// src/impact/vizTimeline.ts and holds no clock of its own, so scrubbing is
// exact. Effect boundaries are geodesic rings on the sphere (angular radius =
// ground radius / body radius), never flat discs. The impactor, fragments,
// ejecta and plume are symbolic markers with a minimum screen size, labelled as
// such; rings and craters use the reported radii unless the reader turns on the
// visibility-enhanced scale, which draws what is too small to see at a minimum
// size, dashed and labelled. Geometry and materials are made once per scenario,
// pooled, and released in dispose().

import * as THREE from 'three';
import { pathPointKm, slantOfAlt, tangentFrame, type VisualScenario } from '../impact/visual.ts';
import { approachKm, caHalfKm, missPoint, siteShade, transientScars, type VizState } from '../impact/vizTimeline.ts';
import { hash01 } from '../sim/rng.ts';
import type { Label } from './views.ts';

export type Scar = { x: number; y: number; z: number; rad: number; kind: number; amp: number };

/** What PlanetView lends the layer (views.ts: impactFrame and the setters beside it). */
export interface ImpactHost {
  frame: THREE.Object3D;
  setTransientScars(s: Scar[]): void;
  setCityShade(s: readonly number[] | null): void;
  setCutaway(on: boolean): void;
}

export interface LayerOpts {
  overlays: boolean; uncertainty: boolean; enhanced: boolean; cutaway: boolean; reduced: boolean;
  quality: 'high' | 'low'; pixelRatio: number; viewportH: number;
  /** a replay whose lasting scar the engine already drew: hand the crater over to it */
  persistentScar?: boolean;
}

const SR = 10; // scene radius of the body
const POOL = { high: { frag: 48, ejecta: 480, plume: 360 }, low: { frag: 16, ejecta: 140, plume: 110 } };

// ---------------------------------------------------------------- shaders

const LOG_V = `#include <common>
#include <logdepthbuf_pars_vertex>`;

/** A soft round glow; size from a world radius (uWorld > 0) or fixed pixels, never below uMinPx. */
function glowMaterial(color: number, xray = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uI: { value: 1 }, uWorld: { value: 0 }, uPx: { value: 6 }, uMinPx: { value: 3 }, uMaxPx: { value: 512 }, uProj: { value: 500 }, uPR: { value: 1 } },
    vertexShader: `${LOG_V}
      uniform float uWorld, uPx, uMinPx, uMaxPx, uProj, uPR;
      attribute float aSize;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = uWorld > 0.0 ? 2.0 * uWorld * uProj / max(1e-6, -mv.z) : uPx;
        gl_PointSize = clamp(px * aSize, uMinPx, uMaxPx) * uPR;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform vec3 uColor; uniform float uI;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float a = exp(-r * r * 4.0) + 0.35 * exp(-r * r * 40.0);
        gl_FragColor = vec4(uColor * a * uI, a * uI);
      }`,
    transparent: true, depthWrite: false, depthTest: !xray, blending: THREE.AdditiveBlending,
  });
}

/** Per-particle colour and size, round, additive. */
function particleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 3 }, uPR: { value: 1 }, uI: { value: 1 } },
    vertexShader: `${LOG_V}
      attribute vec3 color; attribute float aSize; varying vec3 vC; uniform float uPx, uPR;
      void main() { vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = max(1.0, uPx * aSize) * uPR;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      varying vec3 vC; uniform float uI;
      void main() {
        #include <logdepthbuf_fragment>
        float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float a = (1.0 - r * r) * uI; gl_FragColor = vec4(vC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

/** A band on the sphere between two angular radii around a centre: a geodesic ring, or a filled zone when the inner radius is 0. */
function ringMaterial(color: number, opacity: number, style: 0 | 1 | 2 = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Vector3(0, 1, 0) }, uE: { value: new THREE.Vector3(1, 0, 0) }, uN: { value: new THREE.Vector3(0, 0, 1) }, uA0: { value: 0 }, uA1: { value: 0 }, uR: { value: SR * 1.0015 }, uColor: { value: new THREE.Color(color) }, uO: { value: opacity }, uStyle: { value: style }, uDash: { value: 0 }, uT: { value: 0 }, uFill: { value: 0 } },
    vertexShader: `${LOG_V}
      attribute float aPhi; attribute float aSide; varying float vPhi; varying float vSide;
      uniform vec3 uC, uE, uN; uniform float uA0, uA1, uR;
      void main() {
        float a = mix(uA0, uA1, aSide);
        vec3 t = cos(aPhi) * uE + sin(aPhi) * uN;
        vec3 d = cos(a) * uC + sin(a) * t;
        vPhi = aPhi; vSide = aSide;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(d * uR, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      varying float vPhi; varying float vSide; uniform vec3 uColor; uniform float uO, uStyle, uDash, uT, uFill;
      void main() {
        #include <logdepthbuf_fragment>
        float a = uO;
        if (uFill > 0.5) a *= mix(0.25, 1.0, vSide * vSide);
        if (uDash > 0.0 && fract(vPhi * uDash / 6.2831853) > 0.55) discard;
        if (uStyle > 1.5) a *= 0.55 + 0.45 * sin(vPhi * 29.0 + uT * 3.0) * sin(vPhi * 7.0 - uT); // tsunami: an uneven front, not a uniform wall
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

function ringGeometry(seg = 192): THREE.BufferGeometry {
  const phi = new Float32Array((seg + 1) * 2), side = new Float32Array((seg + 1) * 2), idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const p = (i / seg) * Math.PI * 2;
    phi[i * 2] = p; phi[i * 2 + 1] = p; side[i * 2] = 0; side[i * 2 + 1] = 1;
    if (i < seg) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((seg + 1) * 6), 3));
  g.setAttribute('aPhi', new THREE.BufferAttribute(phi, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

/** Camera-facing ribbon along the entry trace, width and brightness from the energy deposited there. */
function trailMaterial(xray: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uK: { value: 0 }, uW: { value: 3 }, uRes: { value: new THREE.Vector2(1000, 800) }, uFade: { value: 1 }, uColor: { value: new THREE.Color(0xffb36b) } },
    vertexShader: `${LOG_V}
      attribute vec3 aNext; attribute float aSide; attribute float aT; attribute float aI;
      uniform float uW; uniform vec2 uRes; varying float vT; varying float vI; varying float vS;
      void main() {
        vec4 c0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 c1 = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
        vec2 s0 = c0.xy / c0.w, s1 = c1.xy / c1.w;
        vec2 d = (s1 - s0) * uRes; float l = length(d); d = l > 1e-6 ? d / l : vec2(1.0, 0.0);
        vec2 n = vec2(-d.y, d.x);
        float w = uW * (0.3 + 1.7 * aI);
        c0.xy += n * aSide * w / uRes * c0.w;
        gl_Position = c0; vT = aT; vI = aI; vS = aSide;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform float uK, uFade; uniform vec3 uColor; varying float vT; varying float vI; varying float vS;
      void main() {
        #include <logdepthbuf_fragment>
        if (vT > uK) discard;
        float edge = 1.0 - vS * vS;
        float age = clamp(1.0 - (uK - vT) * 1.6, 0.25, 1.0);
        vec3 hot = mix(uColor, vec3(1.0, 0.95, 0.85), vI);
        float a = edge * (0.15 + 0.85 * vI) * age * uFade;
        gl_FragColor = vec4(hot * a, a);
      }`,
    transparent: true, depthWrite: false, depthTest: !xray, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

/** A latitude–longitude grid on a sphere: the giants' 1-bar reference level, drawn so it never reads as ground. */
function shellMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0.3 } },
    vertexShader: `${LOG_V}
      varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      varying vec3 vP; uniform float uO;
      void main() {
        #include <logdepthbuf_fragment>
        float lat = asin(clamp(vP.y, -1.0, 1.0)) * 18.0 / 3.14159, lon = atan(vP.z, vP.x) * 36.0 / 3.14159;
        // thin lines only, at every 10 degrees: a reference level, never a surface
        float g = max(smoothstep(0.46, 0.5, abs(fract(lat) - 0.5)), smoothstep(0.46, 0.5, abs(fract(lon) - 0.5)));
        if (g < 0.05) discard;
        gl_FragColor = vec4(vec3(0.6, 0.75, 0.85) * g * uO, g * uO);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------- the layer

interface Ring { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; km: number; inner?: number; key: string; label?: string; enlarged: boolean }

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
const P3: [number, number, number] = [0, 0, 0];

export class ImpactLayer {
  /** GPU resources made and not yet released, across every layer (the checks read it) */
  static live = 0;
  readonly group = new THREE.Group();
  readonly v: VisualScenario;
  private host: ImpactHost;
  private k: number; // scene units per km
  private res: { dispose(): void }[] = [];
  private gz = new THREE.Vector3();
  private marker: THREE.Points; private markerMat: THREE.ShaderMaterial; private markerPos: THREE.BufferAttribute;
  private flash: THREE.Points; private flashMat: THREE.ShaderMaterial; private flashPos: THREE.BufferAttribute;
  private fire: THREE.Points | null = null; private fireMat: THREE.ShaderMaterial | null = null; private firePos: THREE.BufferAttribute | null = null;
  private shock: THREE.Mesh | null = null; private shockMat: THREE.MeshBasicMaterial | null = null;
  private trail: THREE.Mesh | null = null; private trailMat: THREE.ShaderMaterial | null = null;
  private frags: THREE.InstancedMesh | null = null; private fragDirs: Float32Array = new Float32Array(0);
  private ejecta: THREE.Points | null = null; private ejectaMat: THREE.ShaderMaterial | null = null; private ejSeed = new Float32Array(0);
  private plume: THREE.Points | null = null; private plumeMat: THREE.ShaderMaterial | null = null; private plSeed = new Float32Array(0);
  private rings: Ring[] = [];
  private shell: THREE.Mesh | null = null;
  private depth: THREE.Line | null = null;
  private sites: THREE.Points | null = null;
  private guide: THREE.Line | null = null;
  private caBand: THREE.Line | null = null; private caScale = 1;
  private missLine: THREE.Line | null = null; private missPos: THREE.BufferAttribute | null = null;
  private shade: number[] = [];
  private state: VizState | null = null;
  private opts: LayerOpts | null = null;
  private quality: 'high' | 'low';
  private lastScarKey = '';
  private disposed = false;

  constructor(v: VisualScenario, host: ImpactHost, quality: 'high' | 'low' = 'high') {
    this.v = v; this.host = host; this.quality = quality;
    this.k = SR / v.body.radiusKm;
    const p = v.trajectory.point;
    this.gz.set(p[0], p[1], p[2]).multiplyScalar(SR);
    const f = v.render, xray = f.oneBarShell;
    this.group.name = 'impact-layer';
    host.frame.add(this.group);
    // the impactor: a marker enlarged for visibility (TEXT.marker), white when cold, plasma-hot in the air
    this.markerMat = this.mat(glowMaterial(0xf2efe8, xray));
    this.markerPos = new THREE.BufferAttribute(new Float32Array(3), 3);
    this.marker = this.points(this.markerPos, this.markerMat, 1);
    this.flashMat = this.mat(glowMaterial(0xfff4e0, true));
    this.flashPos = new THREE.BufferAttribute(new Float32Array(3), 3);
    this.flash = this.points(this.flashPos, this.flashMat, 1);
    if (v.kind === 'impact') this.buildImpact(xray);
    else if (v.kind === 'close-approach') this.buildApproach();
    else this.buildDeflection();
  }

  // ---------------------------------------------------------------- construction

  private geo<T extends THREE.BufferGeometry>(g: T): T { this.res.push(g); ImpactLayer.live++; return g; }
  private mat<T extends THREE.Material>(m: T): T { this.res.push(m); ImpactLayer.live++; return m; }
  private points(pos: THREE.BufferAttribute, mat: THREE.Material, n: number, extra?: (g: THREE.BufferGeometry) => void): THREE.Points {
    const g = this.geo(new THREE.BufferGeometry());
    g.setAttribute('position', pos);
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    extra?.(g);
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    this.group.add(p);
    return p;
  }
  private line(pts: number[], color: number, opacity: number, dashed = false, xray = false): THREE.Line {
    const g = this.geo(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const m = this.mat(dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.15, gapSize: 0.12, depthWrite: false, depthTest: !xray }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: !xray }));
    const l = new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    l.frustumCulled = false;
    this.group.add(l);
    return l;
  }

  private buildImpact(xray: boolean): void {
    const v = this.v, f = v.render, fx = v.effects, k = this.k;
    // the path guide: from where the approach starts down to ground zero (dashed, an overlay)
    const top = v.entry?.trace.length ? v.entry.topAltKm : 0;
    const s0 = slantOfAlt(v, Math.max(0, top)) + v.body.radiusKm * 1.2, g: number[] = [];
    for (const s of [s0, 0]) { pathPointKm(v, s, P3); g.push(P3[0] * k, P3[1] * k, P3[2] * k); }
    this.guide = this.line(g, 0x9aa4b2, 0.45, true, xray);
    if (f.atmosphereTrail) this.buildTrail(xray);
    if (f.breakup) {
      const n = POOL[this.quality].frag;
      const gm = this.geo(new THREE.IcosahedronGeometry(1, 0)), mm = this.mat(new THREE.MeshBasicMaterial({ color: 0xffc58a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: !xray }));
      this.frags = new THREE.InstancedMesh(gm, mm, n);
      this.frags.frustumCulled = false;
      this.fragDirs = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { const u = hash01(v.seed, i, 11) * 2 - 1, th = hash01(v.seed, i, 12) * Math.PI * 2, s = Math.sqrt(1 - u * u); this.fragDirs.set([s * Math.cos(th), u, s * Math.sin(th), 0.4 + hash01(v.seed, i, 13)], i * 4); }
      this.group.add(this.frags);
    }
    if (f.airburst || f.deepDeposition) {
      this.fireMat = this.mat(glowMaterial(f.deepDeposition ? 0xffe2b8 : 0xffd2a0, xray));
      this.firePos = new THREE.BufferAttribute(new Float32Array(3), 3);
      this.fire = this.points(this.firePos, this.fireMat, 1);
    }
    if (f.airburst && fx.blastKm) {
      this.shockMat = this.mat(new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, wireframe: false }));
      this.shock = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1, 48, 24)), this.shockMat);
      this.group.add(this.shock);
    }
    // rings: reported radii, geodesic on the sphere
    const blast = fx.blastKm;
    if (f.blastRings && blast) {
      const lv: [keyof typeof blast, number, string][] = [['kPa7', 0xf2c14e, '7 kPa: windows break'], ['kPa21', 0xf28c28, '21 kPa: houses collapse'], ['kPa69', 0xe0522f, '69 kPa: heavy damage'], ['kPa138', 0xc4203a, '138 kPa: nearly total destruction']];
      for (const [key, col, label] of lv) if (blast[key] > 0) { this.ring(`blastFill:${key}`, col, 0.1, blast[key], 0, 0, true); this.ring(`blast:${key}`, col, 0.85, blast[key], 0, 0, false, label); }
    }
    if (f.thermalRing) this.ring('thermal', 0xff6a3d, 0.8, fx.thermalKm!, 0, 0, false, 'Thermal: third-degree burns');
    if (f.ejecta) {
      this.ring('ej1m', 0xc8a77a, 0.75, fx.ejecta1mKm!, 0, 0, false, 'Ejecta 1 m deep');
      if ((fx.ejecta10cmKm ?? 0) > (fx.ejecta1mKm ?? 0)) this.ring('ej10', 0xa58a66, 0.55, fx.ejecta10cmKm!, 0, 0, false, 'Ejecta 10 cm deep');
    }
    if (f.seismicRing) this.ring('seis', 0xb38cff, 0.7, fx.seismicKm!.m65, 0, 24, false, 'Shaking ≥ magnitude 6.5 equivalent');
    if (f.tsunami) this.ring('tsu', 0x6fd3ff, 0.8, fx.tsunami!.radius1mKm, 2, 0, false, 'Wave ≥ 1 m (simplified radial)');
    if (f.tsunami && fx.tsunami!.radius3mKm > 0) this.ring('tsu3', 0x3fb6f2, 0.6, fx.tsunami!.radius3mKm, 2, 0, false, 'Wave ≥ 3 m');
    if (f.blastRings || f.thermalRing || f.ejecta || f.tsunami || f.seismicRing) this.ring('front', 0xffffff, 0.5, 0, 0, 0);
    if (f.ejecta) {
      const n = POOL[this.quality].ejecta;
      this.ejectaMat = this.mat(particleMaterial());
      this.ejSeed = new Float32Array(n * 4);
      const col = new Float32Array(n * 3), size = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        // rays: most particles in a few seeded directions, the rest scattered
        const ray = hash01(v.seed, i, 21) < 0.6, r0 = Math.floor(hash01(v.seed, i, 22) * 7);
        const az = ray ? hash01(v.seed, r0, 23) * Math.PI * 2 + (hash01(v.seed, i, 24) - 0.5) * 0.08 : hash01(v.seed, i, 25) * Math.PI * 2;
        this.ejSeed.set([az, Math.pow(hash01(v.seed, i, 26), 0.7), 0.5 + hash01(v.seed, i, 27), hash01(v.seed, i, 28)], i * 4);
        const c = 0.55 + 0.3 * hash01(v.seed, i, 29); col.set([c, c * 0.88, c * 0.72], i * 3); size[i] = 0.6 + hash01(v.seed, i, 30);
      }
      this.ejecta = this.points(new THREE.BufferAttribute(new Float32Array(n * 3), 3), this.ejectaMat, n, (gg) => { gg.setAttribute('color', new THREE.BufferAttribute(col, 3)); gg.setAttribute('aSize', new THREE.BufferAttribute(size, 1)); });
    }
    if (f.plume) {
      const n = POOL[this.quality].plume;
      this.plumeMat = this.mat(particleMaterial());
      this.plSeed = new Float32Array(n * 4);
      const col = new Float32Array(n * 3), size = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this.plSeed.set([hash01(v.seed, i, 41), hash01(v.seed, i, 42) * Math.PI * 2, hash01(v.seed, i, 43), hash01(v.seed, i, 44)], i * 4);
        const hot = hash01(v.seed, i, 45); col.set([0.9 - 0.5 * hot, 0.75 - 0.45 * hot, 0.6 - 0.4 * hot], i * 3); size[i] = 0.7 + hash01(v.seed, i, 46);
      }
      this.plume = this.points(new THREE.BufferAttribute(new Float32Array(n * 3), 3), this.plumeMat, n, (gg) => { gg.setAttribute('color', new THREE.BufferAttribute(col, 3)); gg.setAttribute('aSize', new THREE.BufferAttribute(size, 1)); });
    }
    if (f.oneBarShell) {
      this.shell = new THREE.Mesh(this.geo(new THREE.SphereGeometry(SR * 1.0008, 72, 36)), this.mat(shellMaterial()));
      this.group.add(this.shell);
      const dep = fx.plume?.depositionAltKm ?? v.entry?.peakDepositionAltKm ?? 0, n = this.gz.clone().normalize();
      const a = n.clone().multiplyScalar(SR + 0.02), b = n.clone().multiplyScalar(SR + dep * k);
      this.depth = this.line([a.x, a.y, a.z, b.x, b.y, b.z], 0xffd27a, 0.9, false, true);
    }
    if (f.settlementOverlay) {
      const s = v.exposure.sites, pos = new Float32Array(s.length * 3), col = new Float32Array(s.length * 3), size = new Float32Array(s.length);
      s.forEach((x, i) => { pos.set([x.dir[0] * SR * 1.004, x.dir[1] * SR * 1.004, x.dir[2] * SR * 1.004], i * 3); size[i] = i === 0 ? 1.6 : 1; });
      const m = this.mat(particleMaterial());
      this.sites = this.points(new THREE.BufferAttribute(pos, 3), m, s.length, (gg) => { gg.setAttribute('color', new THREE.BufferAttribute(col, 3)); gg.setAttribute('aSize', new THREE.BufferAttribute(size, 1)); });
    }
  }

  private buildTrail(xray: boolean): void {
    const v = this.v, tr = v.entry!.trace, k = this.k, n = tr.length;
    const pos = new Float32Array(n * 6), next = new Float32Array(n * 6), side = new Float32Array(n * 2), tt = new Float32Array(n * 2), ii = new Float32Array(n * 2), idx: number[] = [];
    const T = tr[n - 1][0] || 1, peak = v.entry!.maxDepositionJPerKm || 1;
    const at = (j: number, out: number[]) => { pathPointKm(v, slantOfAlt(v, tr[j][1]), P3); out[0] = P3[0] * k; out[1] = P3[1] * k; out[2] = P3[2] * k; };
    const a: number[] = [0, 0, 0], b: number[] = [0, 0, 0];
    for (let j = 0; j < n; j++) {
      at(j, a); at(Math.min(n - 1, j + 1), b);
      if (j === n - 1) { at(j - 1, b); b[0] = 2 * a[0] - b[0]; b[1] = 2 * a[1] - b[1]; b[2] = 2 * a[2] - b[2]; }
      const inten = Math.min(1, Math.sqrt(Math.max(0, tr[j][5]) / peak));
      for (let s = 0; s < 2; s++) {
        pos.set(a, (j * 2 + s) * 3); next.set(b, (j * 2 + s) * 3);
        side[j * 2 + s] = s ? 1 : -1; tt[j * 2 + s] = tr[j][0] / T; ii[j * 2 + s] = inten;
      }
      if (j < n - 1) { const q = j * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    const g = this.geo(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aNext', new THREE.BufferAttribute(next, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    g.setAttribute('aI', new THREE.BufferAttribute(ii, 1));
    g.setIndex(idx);
    // a thin atmosphere (Mars) glows less: brightness follows the deposition, the colour the air
    this.trailMat = this.mat(trailMaterial(xray));
    if (v.body.name === 'Venus') this.trailMat.uniforms.uColor.value.set(0xffc27a);
    if (!v.body.solidSurface) this.trailMat.uniforms.uColor.value.set(0xffe0b0);
    this.trail = new THREE.Mesh(g, this.trailMat);
    this.trail.frustumCulled = false;
    this.group.add(this.trail);
  }

  private ring(key: string, color: number, opacity: number, km: number, style: 0 | 1 | 2, dash: number, fill = false, label?: string): void {
    if (!(km >= 0)) return;
    const mat = this.mat(ringMaterial(color, opacity, style));
    const c = this.gz.clone().normalize(), { east, north } = tangentFrame([c.x, c.y, c.z]);
    mat.uniforms.uC.value.copy(c); mat.uniforms.uE.value.set(...east); mat.uniforms.uN.value.set(...north);
    mat.uniforms.uDash.value = dash; mat.uniforms.uFill.value = fill ? 1 : 0;
    if (!ImpactLayer.ringGeo) { ImpactLayer.ringGeo = ringGeometry(); ImpactLayer.ringUsers = 0; }
    ImpactLayer.ringUsers++;
    const mesh = new THREE.Mesh(ImpactLayer.ringGeo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = fill ? 1 : 2;
    this.group.add(mesh);
    this.rings.push({ mesh, mat, km, inner: fill ? 0 : undefined, key, label, enlarged: false });
  }
  /** one ring strip shared by every ring of every layer; released when the last layer goes */
  private static ringGeo: THREE.BufferGeometry | null = null;
  private static ringUsers = 0;

  private buildApproach(): void {
    const v = this.v, a = v.approach!, k = this.k, p = v.trajectory.point, d = v.trajectory.dir, L = caHalfKm(v);
    // to scale unless the miss is farther than the view's sky allows: then compressed, and labelled so
    const far = a.nominalKm * k;
    this.caScale = far > 3000 ? 3000 / far : 1;
    const s = this.caScale * k, pts: number[] = [];
    for (const x of [-L, L]) pts.push((p[0] * a.nominalKm + d[0] * x) * s, (p[1] * a.nominalKm + d[1] * x) * s, (p[2] * a.nominalKm + d[2] * x) * s);
    this.line(pts, 0x199e70, 0.7);
    this.caBand = this.line([p[0] * a.minKm * s, p[1] * a.minKm * s, p[2] * a.minKm * s, p[0] * a.maxKm * s, p[1] * a.maxKm * s, p[2] * a.maxKm * s], 0x7fe3a8, 0.9);
    this.line([0, 0, 0, p[0] * a.nominalKm * s, p[1] * a.nominalKm * s, p[2] * a.nominalKm * s], 0x9aa4b2, 0.35, true);
  }

  private buildDeflection(): void {
    const v = this.v, k = this.k, top = v.entry?.trace.length ? v.entry.topAltKm : 0, pts: number[] = [];
    const s0 = slantOfAlt(v, Math.max(0, top)) + v.body.radiusKm * 1.2;
    for (const s of [s0, 0]) { pathPointKm(v, s, P3); pts.push(P3[0] * k, P3[1] * k, P3[2] * k); }
    this.line(pts, 0xc98500, 0.45, true); // the original collision course, as a ghost
    this.missPos = new THREE.BufferAttribute(new Float32Array(64 * 3), 3);
    const g = this.geo(new THREE.BufferGeometry());
    g.setAttribute('position', this.missPos);
    g.setDrawRange(0, 0);
    this.missLine = new THREE.Line(g, this.mat(new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.85, depthWrite: false })));
    this.missLine.frustumCulled = false;
    this.group.add(this.missLine);
  }

  // ---------------------------------------------------------------- per frame

  /** Draw the state at one instant. No allocation; everything is a function of `s`. */
  update(s: VizState, camera: THREE.PerspectiveCamera, o: LayerOpts): void {
    if (this.disposed) return;
    this.state = s; this.opts = o;
    const v = this.v, f = v.render, k = this.k;
    this.group.updateMatrixWorld();
    const proj = o.viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    // world size of a pixel at ground zero, for minimum sizes and ring widths
    tv.copy(this.gz).applyMatrix4(this.group.matrixWorld);
    const pxAtGz = Math.max(1e-6, camera.position.distanceTo(tv) / proj);
    for (const m of [this.markerMat, this.flashMat, this.fireMat]) if (m) { m.uniforms.uProj.value = proj; m.uniforms.uPR.value = o.pixelRatio; }
    for (const m of [this.ejectaMat, this.plumeMat]) if (m) m.uniforms.uPR.value = o.pixelRatio;

    // the impactor marker
    const sc = v.kind === 'close-approach' ? this.caScale * k : k;
    this.markerPos.setXYZ(0, s.obj.pos[0] * sc, s.obj.pos[1] * sc, s.obj.pos[2] * sc); this.markerPos.needsUpdate = true;
    this.marker.visible = s.obj.visible;
    const heat = s.obj.heat;
    this.markerMat.uniforms.uPx.value = 7 + 6 * heat;
    this.markerMat.uniforms.uColor.value.setRGB(0.95, 0.93 - 0.25 * heat, 0.9 - 0.6 * heat);
    this.markerMat.uniforms.uI.value = 0.85 + 0.6 * heat;
    if (this.trailMat) {
      this.trailMat.uniforms.uK.value = s.trailK;
      this.trailMat.uniforms.uRes.value.set(o.viewportH * camera.aspect, o.viewportH);
      this.trailMat.uniforms.uFade.value = s.phase === 'aftermath' ? 1 - 0.7 * s.k : 1;
      this.trailMat.uniforms.uW.value = 2.2 * o.pixelRatio;
    }
    if (this.guide) this.guide.visible = o.overlays && (s.phase === 'approach' || s.phase === 'entry' || s.phase === 'breakup');
    // fragments: a symbolic cloud that spreads as the entry model's cloud radius grows
    if (this.frags) {
      const on = s.obj.broken && s.obj.visible;
      this.frags.visible = on;
      if (on) {
        const n = this.frags.count, base = pxAtGz * 4, spread = Math.min(12, Math.max(0, s.obj.spread - 1)) * base * 0.8 + base;
        const d = v.trajectory.dir;
        tv2.set(s.obj.pos[0] * k, s.obj.pos[1] * k, s.obj.pos[2] * k);
        for (let i = 0; i < n; i++) {
          const fd = this.fragDirs, j = i * 4, back = fd[j + 3] * spread * 2.5;
          ts.set(tv2.x + fd[j] * spread - d[0] * back, tv2.y + fd[j + 1] * spread - d[1] * back, tv2.z + fd[j + 2] * spread - d[2] * back);
          tm.compose(ts, tq, tv.setScalar(pxAtGz * (0.8 + fd[j + 3])));
          this.frags.setMatrixAt(i, tm);
        }
        this.frags.instanceMatrix.needsUpdate = true;
        (this.frags.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.75 + 0.2 * (1 - heat), 0.5 + 0.3 * (1 - heat));
      }
    }
    // the flash at contact, burst or deposition (capped and slow under reduced motion)
    const flash = o.reduced ? Math.min(0.35, s.flash * 0.35) : s.flash;
    this.flash.visible = flash > 0.01;
    if (this.flash.visible) {
      const alt = s.phase === 'contact' || s.phase === 'excavation' ? 0 : s.obj.altKm;
      pathPointKm(v, slantOfAlt(v, alt), P3);
      this.flashPos.setXYZ(0, P3[0] * k, P3[1] * k, P3[2] * k); this.flashPos.needsUpdate = true;
      this.flashMat.uniforms.uPx.value = 40 + 260 * flash;
      this.flashMat.uniforms.uI.value = flash;
      this.flashMat.uniforms.uMaxPx.value = 320;
    }
    if (this.fire && this.fireMat && this.firePos) {
      const on = s.burst > 0 && s.phase !== 'aftermath';
      this.fire.visible = on || (s.phase === 'aftermath' && s.k < 0.3);
      if (this.fire.visible) {
        const alt = f.deepDeposition ? (v.effects.plume?.depositionAltKm ?? s.obj.altKm) : (v.entry?.burstAltKm ?? s.obj.altKm);
        pathPointKm(v, slantOfAlt(v, alt), P3);
        this.firePos.setXYZ(0, P3[0] * k, P3[1] * k, P3[2] * k); this.firePos.needsUpdate = true;
        // symbolic luminous region: the model has no fireball radius; scaled to a share of the blast reach
        const reach = (v.effects.blastKm?.kPa21 ?? v.effects.plume?.plumeHeightKm[1] ?? 50) * 0.25 * k;
        this.fireMat.uniforms.uWorld.value = Math.max(pxAtGz * 6, reach * (0.3 + 0.7 * s.burst));
        this.fireMat.uniforms.uI.value = (o.reduced ? 0.4 : 0.9) * (1 - 0.7 * s.burst) * (s.phase === 'aftermath' ? 1 - s.k / 0.3 : 1);
        this.fireMat.uniforms.uMinPx.value = 6;
      }
    }
    if (this.shock && this.shockMat) {
      this.shock.visible = s.shockKm > 0 && o.overlays;
      if (this.shock.visible) {
        pathPointKm(v, slantOfAlt(v, v.entry?.burstAltKm ?? 0), P3);
        this.shock.position.set(P3[0] * k, P3[1] * k, P3[2] * k);
        this.shock.scale.setScalar(Math.max(pxAtGz, s.shockKm * k));
        this.shockMat.opacity = 0.16 * (1 - Math.min(1, s.shockKm / Math.max(1e-6, v.effects.blastKm!.kPa7)) * 0.7);
      }
    }
    // rings grow with the front, each stopping at its own reported radius
    const minAng = (5 * pxAtGz) / SR;
    for (const r of this.rings) {
      let km = r.km;
      if (r.key === 'front') km = s.frontKm;
      else if (r.key === 'seis') km = s.seismicKm;
      else if (r.key.startsWith('tsu')) km = Math.min(r.km, s.tsunamiKm);
      else km = Math.min(r.km, s.frontKm);
      let ang = km / v.body.radiusKm;
      r.enlarged = o.enhanced && ang > 0 && ang < minAng;
      if (r.enlarged) ang = minAng;
      const fill = r.inner === 0;
      const w = Math.max(1.2 * pxAtGz / SR, ang * 0.004);
      r.mat.uniforms.uA1.value = ang;
      r.mat.uniforms.uA0.value = fill ? 0 : Math.max(0, ang - w);
      r.mat.uniforms.uT.value = s.t;
      if (r.enlarged && !fill) r.mat.uniforms.uDash.value = 32;
      r.mesh.visible = o.overlays && ang > 0 && (r.key !== 'front' || (s.phase === 'effects'));
    }
    // ejecta: ballistic arcs from ground zero out to the blanket's reach, symbolic
    if (this.ejecta && this.ejectaMat) {
      const on = s.ejectaK > 0 && s.ejectaK < 1;
      this.ejecta.visible = on;
      if (on) {
        const pos = this.ejecta.geometry.getAttribute('position') as THREE.BufferAttribute, arr = pos.array as Float32Array, n = pos.count;
        const reach = (v.effects.ejecta10cmKm ?? v.effects.ejecta1mKm ?? 1) / v.body.radiusKm;
        const c = this.gz.clone().normalize(), { east, north } = tangentFrame([c.x, c.y, c.z]);
        for (let i = 0; i < n; i++) {
          const j = i * 4, az = this.ejSeed[j], dist = this.ejSeed[j + 1], speed = this.ejSeed[j + 2], delay = this.ejSeed[j + 3] * 0.25;
          const tau = Math.max(0, Math.min(1, (s.ejectaK - delay) / (0.75 * speed)));
          const a = reach * dist * tau, h = 4 * tau * (1 - tau) * reach * dist * 0.35 * SR;
          const tx = Math.cos(az) * east[0] + Math.sin(az) * north[0], ty = Math.cos(az) * east[1] + Math.sin(az) * north[1], tz = Math.cos(az) * east[2] + Math.sin(az) * north[2];
          const ca = Math.cos(a), sa = Math.sin(a), R = SR * 1.002 + h;
          arr[i * 3] = (ca * c.x + sa * tx) * R; arr[i * 3 + 1] = (ca * c.y + sa * ty) * R; arr[i * 3 + 2] = (ca * c.z + sa * tz) * R;
        }
        pos.needsUpdate = true;
        this.ejectaMat.uniforms.uPx.value = 2.2;
        this.ejectaMat.uniforms.uI.value = 0.9 * (1 - Math.max(0, s.ejectaK - 0.8) / 0.2);
      }
    }
    // the plume: up along the local vertical to the reported height, then spreading and falling back
    if (this.plume && this.plumeMat) {
      const on = s.plumeKm > 0;
      this.plume.visible = on;
      if (on) {
        const pos = this.plume.geometry.getAttribute('position') as THREE.BufferAttribute, arr = pos.array as Float32Array, n = pos.count;
        const c = this.gz.clone().normalize(), { east, north } = tangentFrame([c.x, c.y, c.z]), H = s.plumeKm * k;
        const d = v.trajectory.dir; // fallback spreads mostly downrange, as SL9's crescents did
        for (let i = 0; i < n; i++) {
          const j = i * 4, hh = this.plSeed[j], az = this.plSeed[j + 1], rr = this.plSeed[j + 2];
          const up = H * Math.pow(hh, 0.6) * (1 - 0.6 * s.plumeSpread * hh);
          const lateral = H * (0.12 * rr + s.plumeSpread * 1.6 * rr * hh);
          const ex = Math.cos(az) * lateral, ny = Math.sin(az) * lateral, down = s.plumeSpread * lateral * 0.6;
          arr[i * 3] = c.x * (SR + up) + east[0] * ex + north[0] * ny + d[0] * down;
          arr[i * 3 + 1] = c.y * (SR + up) + east[1] * ex + north[1] * ny + d[1] * down;
          arr[i * 3 + 2] = c.z * (SR + up) + east[2] * ex + north[2] * ny + d[2] * down;
        }
        pos.needsUpdate = true;
        this.plumeMat.uniforms.uPx.value = 2.6;
        this.plumeMat.uniforms.uI.value = 0.75;
      }
    }
    if (this.shell) this.shell.visible = o.overlays || o.cutaway;
    if (this.depth) this.depth.visible = o.cutaway && (s.phase === 'entry' || s.phase === 'breakup' || s.phase === 'deep-deposition' || s.phase === 'plume');
    // settlements: affected ones turn amber to red as the front reaches them; their night lights dim
    if (this.sites) {
      siteShade(v, s, this.shade);
      const col = this.sites.geometry.getAttribute('color') as THREE.BufferAttribute;
      v.exposure.sites.forEach((x, i) => {
        const hit = this.shade[i] < 1, loss = Math.max(x.fatality, x.capitalShare);
        if (hit) col.setXYZ(i, 1, 0.75 - 0.6 * loss, 0.35 - 0.3 * loss); else col.setXYZ(i, 0.5, 0.89, 1);
      });
      col.needsUpdate = true;
      this.sites.visible = o.overlays;
      (this.sites.material as THREE.ShaderMaterial).uniforms.uPx.value = 5;
      this.host.setCityShade(this.shade);
    }
    if (this.caBand) this.caBand.visible = o.uncertainty;
    if (this.missLine && this.missPos) {
      // the deflected path drawn so far
      const n = 64, sDef = slantOfAlt(v, Math.max(0, v.entry?.topAltKm ?? 0)) + approachKm(v) * 0.25; // as vizTimeline's deflection point
      if (s.missK > 0) {
        for (let i = 0; i < n; i++) { missPoint(v, sDef, (s.missK * i) / (n - 1), P3); this.missPos.setXYZ(i, P3[0] * k, P3[1] * k, P3[2] * k); }
        this.missPos.needsUpdate = true;
        this.missLine.geometry.setDrawRange(0, n);
      } else this.missLine.geometry.setDrawRange(0, 0);
    }
    this.applyScars(s, minAng, o);
    this.host.setCutaway(o.cutaway && f.cloudCutaway);
  }

  private applyScars(s: VizState, minAng: number, o: LayerOpts): void {
    const list = transientScars(this.v, s).filter((x) => !(o.persistentScar && this.v.body.solidSurface && x.kind === 0 && this.v.object.diameterM >= 100));
    if (o.enhanced) for (const x of list) if (x.kind === 0 && x.rad > 0 && x.rad < minAng) x.rad = minAng;
    const key = list.map((x) => `${x.rad.toPrecision(4)}:${x.amp.toFixed(3)}`).join('|');
    if (key === this.lastScarKey) return;
    this.lastScarKey = key;
    this.host.setTransientScars(list);
  }

  // ---------------------------------------------------------------- where things are

  /** Ground zero (or the closest point of a pass) in world space. */
  groundZero(out: THREE.Vector3): THREE.Vector3 {
    if (this.v.kind === 'close-approach') { const p = this.v.trajectory.point, d = this.v.approach!.nominalKm * this.k * this.caScale; out.set(p[0] * d, p[1] * d, p[2] * d); }
    else out.copy(this.gz);
    return out.applyMatrix4(this.group.matrixWorld);
  }
  /** The impactor now, in world space. */
  object(out: THREE.Vector3): THREE.Vector3 {
    const s = this.state, sc = this.v.kind === 'close-approach' ? this.caScale * this.k : this.k;
    if (!s) return this.groundZero(out);
    return out.set(s.obj.pos[0] * sc, s.obj.pos[1] * sc, s.obj.pos[2] * sc).applyMatrix4(this.group.matrixWorld);
  }
  /** A point on the impact path (slant km before contact), world space. */
  path(sKm: number, out: THREE.Vector3): THREE.Vector3 {
    pathPointKm(this.v, sKm, P3);
    return out.set(P3[0] * this.k, P3[1] * this.k, P3[2] * this.k).applyMatrix4(this.group.matrixWorld);
  }
  /** The surface normal at ground zero, world space. */
  normal(out: THREE.Vector3): THREE.Vector3 { return out.copy(this.gz).normalize().transformDirection(this.group.matrixWorld); }
  get compressed(): number { return this.caScale; }
  get enlargedRings(): string[] { return this.rings.filter((r) => r.enlarged && r.label).map((r) => r.label!); }

  labels(): Label[] {
    const s = this.state, o = this.opts, v = this.v;
    if (!s || !o || this.disposed) return [];
    const out: Label[] = [], w = (x: THREE.Vector3) => x.applyMatrix4(this.group.matrixWorld);
    const km = (x: number) => (x >= 1000 ? `${Math.round(x).toLocaleString('en-US')} km` : x >= 10 ? `${x.toFixed(0)} km` : x >= 1 ? `${x.toFixed(1)} km` : `${Math.round(x * 1000)} m`);
    if (v.kind === 'close-approach') {
      const a = v.approach!, p = v.trajectory.point, d = a.nominalKm * this.k * this.caScale;
      out.push({ pos: w(new THREE.Vector3(p[0] * d, p[1] * d, p[2] * d)), text: `Closest: ${km(a.nominalKm)} nominal`, sub: o.uncertainty ? `3σ ${km(a.minKm)} – ${km(a.maxKm)}${this.caScale < 1 ? ` · shown compressed ×${(1 / this.caScale).toFixed(0)}` : ''}` : undefined, prio: 8 });
      return out;
    }
    if (!o.overlays) return out;
    const gzText = v.render.statisticalEarth ? 'Representative synthetic location' : v.render.oneBarShell ? 'Entry point (1-bar level)' : 'Ground zero';
    if (v.kind === 'deflection') { out.push({ pos: w(this.gz.clone()), text: 'Original collision course', sub: 'averted', prio: 6 }); return out; }
    out.push({ pos: w(this.gz.clone().multiplyScalar(1.001)), text: gzText, sub: `${v.trajectory.latDeg.toFixed(1)}°, ${v.trajectory.lonDeg.toFixed(1)}° (simulation coordinates)`, prio: 7 });
    if (v.entry?.breakupAltKm != null && (s.phase === 'breakup' || s.phase === 'airburst')) {
      pathPointKm(v, slantOfAlt(v, v.entry.breakupAltKm), P3);
      out.push({ pos: w(new THREE.Vector3(P3[0] * this.k, P3[1] * this.k, P3[2] * this.k)), text: `Break-up at ${km(v.entry.breakupAltKm)}`, prio: 5 });
    }
    if (v.render.airburst && v.entry?.burstAltKm != null && (s.phase === 'airburst' || s.phase === 'effects')) {
      pathPointKm(v, slantOfAlt(v, v.entry.burstAltKm), P3);
      out.push({ pos: w(new THREE.Vector3(P3[0] * this.k, P3[1] * this.k, P3[2] * this.k)), text: `Airburst at ${km(v.entry.burstAltKm)}`, prio: 6 });
    }
    if (v.render.plume && s.plumeKm > 0) {
      const n = this.gz.clone().normalize().multiplyScalar(SR + s.plumeKm * this.k);
      out.push({ pos: w(n), text: `Plume ${km(s.plumeKm)}`, sub: `reported ${km(v.effects.plume!.plumeHeightKm[0])}–${km(v.effects.plume!.plumeHeightKm[2])}`, prio: 5 });
    }
    if (v.render.oneBarShell && o.cutaway) out.push({ pos: w(this.gz.clone().normalize().multiplyScalar(SR + (v.effects.plume?.depositionAltKm ?? 0) * this.k)), text: `Peak deposition ${(v.effects.plume?.depositionAltKm ?? 0).toFixed(0)} km`, sub: 'relative to 1 bar', prio: 5 });
    // the largest affected sites
    if (v.render.settlementOverlay) {
      const hit = v.exposure.sites.map((x, i) => ({ x, i })).filter(({ i }) => this.shade[i] < 1).sort((a, b) => b.x.deaths - a.x.deaths).slice(0, 3);
      for (const { x } of hit) out.push({ pos: w(new THREE.Vector3(x.dir[0], x.dir[1], x.dir[2]).multiplyScalar(SR * 1.004)), text: x.i === 0 ? 'Capital' : `Settlement ${x.i}`, sub: `${Math.round(x.deaths).toLocaleString('en-US')} lost · ${km(x.distanceKm)} away`, prio: 4 });
    }
    return out;
  }

  /** Release every geometry and material; leaves the planet as it was (no transient marks, lights restored). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.parent?.remove(this.group);
    for (const r of this.res) r.dispose();
    ImpactLayer.live -= this.res.length;
    this.res = [];
    ImpactLayer.ringUsers -= this.rings.length;
    if (ImpactLayer.ringGeo && ImpactLayer.ringUsers <= 0) { ImpactLayer.ringGeo.dispose(); ImpactLayer.ringGeo = null; ImpactLayer.ringUsers = 0; }
    this.rings = [];
    this.frags?.dispose();
    this.host.setTransientScars([]);
    this.host.setCityShade(null);
    this.host.setCutaway(false);
  }
}
