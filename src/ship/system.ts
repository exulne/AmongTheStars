// The 3D neighbourhood around wherever the ship is: one star system (or black
// hole, or nebula) in scene units. Distances are compressed (a^0.6) and bodies
// are oversized so a whole system fits on screen, but order and look are real.

import * as THREE from 'three';
import { Rng } from '../sim/rng.ts';
import { atmosphereMaterial, planetMaterial } from '../view/planetShader.ts';
import { glowTex, nebulaTex, specColor } from '../view/textures.ts';
import { NOW_YEAR, sunPhase, type Planet, type System } from './places.ts';

export const EARTH_R = 40;           // scene units per Earth radius (before compression)
const SUN_R = 600;
const AU_MIN = 4000;

const STYLE = { rocky: 0, desert: 1, ocean: 2, lava: 3, ice: 4 } as const;
const SOL_MASS: Record<string, number> = { Earth: 1, Mars: 0.107, Jupiter: 318, Saturn: 95, Uranus: 14.5, Neptune: 17.1, Pluto: 0.0022 };

export function planetRadius(km: number): number { return Math.max(0.8, EARTH_R * Math.pow(km / 6371, 0.6)); }

function hashName(s: string): number { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

function starMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position,1.0); vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      #include <logdepthbuf_pars_fragment>
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
      float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 p = normalize(vP);
        float g = n3(p * 18.0 + uTime * 0.15) * 0.6 + n3(p * 47.0 - uTime * 0.3) * 0.4;
        float mu = max(dot(normalize(vN), vV), 0.0);
        float limb = 0.35 + 0.65 * pow(mu, 0.45);
        vec3 c = uColor * (1.6 + 0.9 * g) * limb;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function ringMaterial(color: THREE.Color, inner: number, outer: number, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uIn: { value: inner }, uOut: { value: outer }, uSeed: { value: seed % 13 }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: /* glsl */ `
      varying vec3 vL; varying vec3 vW;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vL = position; vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uIn, uOut, uSeed;
      varying vec3 vL; varying vec3 vW;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        float r = (length(vL.xy) - uIn) / (uOut - uIn);
        float b = 0.55 + 0.25 * sin(r * 90.0 + uSeed) + 0.2 * sin(r * 230.0 + uSeed * 3.0);
        b *= smoothstep(0.0, 0.05, r) * smoothstep(1.0, 0.9, r) * (1.0 - 0.85 * smoothstep(0.62, 0.64, r) * smoothstep(0.69, 0.67, r));
        gl_FragColor = vec4(uColor * b, b * 0.85);
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
  });
}

interface BodyObj {
  p: Planet;
  root: THREE.Object3D;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  atm?: THREE.Mesh;
  ringMat?: THREE.ShaderMaterial;
  orbit: number;
  period: number;
  phase: number;
  radius: number;
  parent?: BodyObj;
  orbitLine?: THREE.LineLoop;
  extra?: THREE.Object3D;
}

export interface Anchor { pos: THREE.Vector3; radius: number; park: number }

export class LocalSystem {
  readonly group = new THREE.Group();
  readonly bodies = new Map<string, BodyObj>();
  readonly starPos = new THREE.Vector3();
  starRadius = 0;
  private starMesh?: THREE.Mesh;
  private starMat?: THREE.ShaderMaterial;
  private starGlow: THREE.Sprite[] = [];
  private light?: THREE.PointLight;
  private baseColor = new THREE.Color();
  private birthCloud?: THREE.Group;
  private remnant?: THREE.Group;
  private disk?: THREE.Points;
  private belts: THREE.Points[] = [];
  private spinners: { obj: THREE.Object3D; rate: number }[] = [];
  private facers: THREE.Object3D[] = [];
  private shaderTime: THREE.ShaderMaterial[] = [];
  private born = -5e9;
  private dies = 1e10;
  private massive = false;
  private auScale = AU_MIN;

  constructor(readonly sys: System) {
    const r = new Rng(hashName(sys.id));
    if (sys.kind === 'star') this.buildStar(r);
    else if (sys.kind === 'blackhole') this.buildBlackHole();
    else if (sys.kind === 'nebula') this.buildNebula(r);
    // galaxies: the sky does all the work
  }

  // ------------------------------------------------------------ builders

  private buildStar(r: Rng): void {
    const sys = this.sys;
    const tops = sys.planets.filter((p) => !p.parent);
    const innermost = tops.length ? Math.min(...tops.map((p) => p.a)) : 1;
    this.auScale = Math.max(AU_MIN, 1300 / Math.pow(innermost, 0.6));
    let R = SUN_R * Math.pow(sys.starRadius, 0.6);
    if (tops.length) R = Math.min(R, this.auScale * Math.pow(innermost, 0.6) * 0.4);
    this.starRadius = R;
    this.baseColor.copy(specColor(sys.spec));
    this.starMat = starMaterial(this.baseColor);
    this.shaderTime.push(this.starMat);
    this.starMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.starMat);
    this.starMesh.scale.setScalar(R);
    this.group.add(this.starMesh);
    for (const [k, o] of [[3.2, 0.8], [7, 0.22]] as const) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: this.baseColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: o }));
      s.scale.setScalar(R * k);
      this.starGlow.push(s);
      this.group.add(s);
    }
    this.light = new THREE.PointLight(this.baseColor, 2.2, 0, 0);
    this.group.add(this.light);
    this.group.add(new THREE.AmbientLight(0x223044, 0.35));

    const lum = sys.lum;
    this.massive = lum > 5000 || sys.starRadius > 100;
    if (sys.id === 'sol') { this.born = -4.6e9; this.dies = 5.4e9; }
    else if (sys.id === 'betelgeuse') { this.born = -1e7; this.dies = NOW_YEAR + 1e5; }
    else if (this.massive) { this.born = -2e7; this.dies = NOW_YEAR + 2e6; }
    else if (sys.spec[0] === 'A') { this.born = -4e8; this.dies = 1e9; }
    else if (sys.spec[0] === 'M') { this.born = -8e9; this.dies = 1e12; }
    else if (sys.generated) { this.born = -r.range(1e9, 1e10); this.dies = r.range(1e9, 2e10); }

    for (const p of sys.planets) {
      if (p.belt) { this.buildBelt(p, r); continue; }
      const parent = p.parent ? this.bodies.get(p.parent) : undefined;
      const radius = planetRadius(p.radiusKm);
      const mat = planetMaterial(p.kind, p.color, hashName(p.name));
      const root = new THREE.Object3D();
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), mat);
      mesh.scale.setScalar(radius);
      mesh.rotation.z = r.range(-0.4, 0.4);
      root.add(mesh);
      let atm: THREE.Mesh | undefined;
      if (['ocean', 'desert', 'superearth', 'gas', 'icegiant'].includes(p.kind) || p.name === 'Venus' || p.name === 'Titan') {
        const tint = p.kind === 'ocean' || p.kind === 'superearth' ? 0x5a9cff : p.name === 'Titan' ? 0xe0a050 : p.color;
        atm = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), atmosphereMaterial(tint));
        atm.scale.setScalar(radius * 1.045);
        root.add(atm);
      }
      let ringMat: THREE.ShaderMaterial | undefined;
      if (p.rings) {
        const inner = radius * 1.25, outer = radius * (p.name === 'Uranus' ? 1.7 : 2.3);
        ringMat = ringMaterial(new THREE.Color(p.name === 'Uranus' ? 0x556070 : p.color).lerp(new THREE.Color(0xe8dcc0), 0.4), inner, outer, hashName(p.name));
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 1), ringMat);
        ring.rotation.x = -Math.PI / 2 + (p.name === 'Uranus' ? 1.4 : r.range(0.2, 0.5));
        root.add(ring);
      }
      let orbit: number, period: number;
      if (parent) {
        orbit = parent.radius * 2.2 + 30 * Math.pow(p.a / 100, 0.6);
        const pm = SOL_MASS[parent.p.name] ?? parent.p.massE ?? 1;
        period = (27.3 * Math.pow(p.a / 384, 1.5)) / Math.sqrt(pm) / 365.25;
      } else {
        orbit = this.auScale * Math.pow(p.a, 0.6);
        period = Math.pow(p.a, 1.5) / Math.sqrt(sys.massSun);
      }
      const b: BodyObj = { p, root, mesh, mat, atm, ringMat, orbit, period, phase: r.range(0, Math.PI * 2), radius, parent };
      if (!parent) {
        const line = new THREE.LineLoop(circle(orbit), new THREE.LineBasicMaterial({ color: 0x6a8fb8, transparent: true, opacity: 0.1, depthWrite: false }));
        b.orbitLine = line;
        this.group.add(line);
      }
      if (sys.id === 'sol' && p.name === 'Earth') {
        // orbital ring habitat, shown in the far future
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.7, radius * 0.025, 8, 160), new THREE.MeshStandardMaterial({ color: 0xc8d0dc, metalness: 0.7, roughness: 0.35, emissive: 0x6688aa, emissiveIntensity: 0.3 }));
        ring.rotation.x = Math.PI / 2 + 0.2;
        ring.visible = false;
        root.add(ring);
        b.extra = ring;
      }
      this.bodies.set(p.name, b);
      this.group.add(root);
    }
  }

  private buildBelt(p: Planet, r: Rng): void {
    const n = 5000, pos = new Float32Array(n * 3);
    const R = this.auScale * Math.pow(p.a, 0.6);
    for (let i = 0; i < n; i++) {
      const th = r.range(0, Math.PI * 2), rr = R * (1 + r.gauss() * 0.06);
      pos[i * 3] = Math.cos(th) * rr; pos[i * 3 + 1] = r.gauss() * R * 0.015; pos[i * 3 + 2] = Math.sin(th) * rr;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9a8f80, size: 3, sizeAttenuation: true, transparent: true, opacity: 0.8 }));
    this.belts.push(pts);
    this.spinners.push({ obj: pts, rate: 0.6 / Math.pow(p.a, 1.5) });
    this.group.add(pts);
    // a big rock to park next to
    const radius = 14;
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), planetMaterial('asteroid', 0x8a8076, hashName(p.name)));
    mesh.scale.set(radius, radius * 0.7, radius * 0.85);
    const root = new THREE.Object3D();
    root.add(mesh);
    this.group.add(root);
    const b: BodyObj = { p, root, mesh, mat: mesh.material as THREE.ShaderMaterial, orbit: R, period: Math.pow(p.a, 1.5), phase: r.range(0, 6.28), radius };
    this.bodies.set(p.name, b);
  }

  private buildBlackHole(): void {
    const R = 500;
    this.starRadius = R;
    const hole = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    hole.renderOrder = 5;
    this.group.add(hole);
    const diskMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIn: { value: R * 1.6 }, uOut: { value: R * 7 } },
      vertexShader: /* glsl */ `
        varying vec3 vL;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uIn, uOut; varying vec3 vL;
        #include <logdepthbuf_pars_fragment>
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
        void main(){
          #include <logdepthbuf_fragment>
          float r = length(vL.xy); float t = (r - uIn) / (uOut - uIn);
          float a = atan(vL.y, vL.x);
          float swirl = a + 6.0 / (t + 0.15) * 0.25 - uTime * (1.2 / (t + 0.2));
          float s = n2(vec2(swirl * 3.0, t * 30.0)) * 0.6 + n2(vec2(swirl * 9.0, t * 80.0)) * 0.4;
          vec3 hot = vec3(1.0, 0.95, 0.85), warm = vec3(1.0, 0.55, 0.15), cool = vec3(0.6, 0.12, 0.04);
          vec3 c = mix(hot, warm, smoothstep(0.0, 0.35, t)); c = mix(c, cool, smoothstep(0.35, 1.0, t));
          float dop = 0.55 + 0.45 * sin(a);              // one side comes at us, brighter
          float i = (0.35 + 0.9 * s) * smoothstep(0.0, 0.04, t) * smoothstep(1.0, 0.5, t) * dop * 1.1;
          gl_FragColor = vec4(c * i, 1.0);
        }`,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.shaderTime.push(diskMat);
    const disk = new THREE.Mesh(new THREE.RingGeometry(R * 1.6, R * 7, 256, 4), diskMat);
    disk.rotation.x = -Math.PI / 2 + 0.12;
    this.group.add(disk);
    // the lensed back of the disk, bent over the top: always faces the camera
    const halo = new THREE.Mesh(new THREE.RingGeometry(R * 1.05, R * 1.9, 256, 2), diskMat);
    this.facers.push(halo);
    this.group.add(halo);
    const photon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffb070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
    photon.scale.setScalar(R * 6);
    this.group.add(photon);
    this.group.add(new THREE.PointLight(0xffa060, 2.5, 0, 0));
    this.group.add(new THREE.AmbientLight(0x221a14, 0.4));
  }

  private buildNebula(r: Rng): void {
    const neb = this.sys.nebula!;
    const S = 9000;
    this.starRadius = S * 0.15;
    const texes = neb.colors.map((c, i) => nebulaTex(hashName(this.sys.id) + i, c));
    for (let i = 0; i < 46; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texes[i % texes.length], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: r.range(0.35, 0.8) }));
      const v = new THREE.Vector3(r.gauss(), r.gauss() * 0.6, r.gauss()).multiplyScalar(S * (neb.pulsar ? 0.45 : 0.8));
      sp.position.copy(v);
      sp.scale.setScalar(S * r.range(0.6, 1.6));
      sp.material.rotation = r.range(0, 6.28);
      this.group.add(sp);
    }
    for (let i = 0; i < neb.stars; i++) {
      const v = new THREE.Vector3(r.gauss(), r.gauss() * 0.7, r.gauss()).multiplyScalar(S * 0.35);
      const R = r.range(25, 90);
      const m = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(neb.starColor).multiplyScalar(2.2) }));
      m.position.copy(v);
      const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: neb.starColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
      g.scale.setScalar(R * 14);
      g.position.copy(v);
      this.group.add(m, g);
    }
    if (neb.pulsar) {
      const core = new THREE.Mesh(new THREE.SphereGeometry(30, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xddeeff).multiplyScalar(3) }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xaaccff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.scale.setScalar(900);
      const beams = new THREE.Group();
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      for (const s of [1, -1]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(260, 5000, 32, 1, true), beamMat);
        cone.position.y = s * 2500;
        cone.rotation.x = s > 0 ? Math.PI : 0;
        beams.add(cone);
      }
      beams.rotation.z = 0.5;
      const spin = new THREE.Group();
      spin.add(beams);
      this.spinners.push({ obj: spin, rate: 2 * Math.PI * 0.5 });
      this.group.add(core, glow, spin);
    }
    this.group.add(new THREE.AmbientLight(0x334466, 0.6));
    this.group.add(new THREE.PointLight(0xbfd4ff, 2, 0, 0));
  }

  private makeCloud(colors: [number, number, number][], seed: number, spread: number, count: number, ring = false): THREE.Group {
    const r = new Rng(seed);
    const g = new THREE.Group();
    const texes = colors.map((c, i) => nebulaTex(seed + i, c));
    for (let i = 0; i < count; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texes[i % texes.length], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: r.range(0.3, 0.7) }));
      if (ring) {
        const th = r.range(0, 6.28);
        sp.position.set(Math.cos(th) * spread, r.gauss() * spread * 0.15, Math.sin(th) * spread);
      } else sp.position.set(r.gauss() * spread, r.gauss() * spread * 0.5, r.gauss() * spread);
      sp.scale.setScalar(spread * r.range(0.6, 1.4));
      sp.material.rotation = r.range(0, 6.28);
      g.add(sp);
    }
    this.group.add(g);
    return g;
  }

  // ------------------------------------------------------------ per frame

  /** orbitT: animation clock in years. year: calendar year (eras). */
  update(orbitT: number, year: number, camera: THREE.Camera, time: number): void {
    for (const m of this.shaderTime) m.uniforms.uTime.value = time;
    for (const s of this.spinners) s.obj.rotation.y = orbitT * s.rate * 365 * 0.02 + time * (s.rate > 2 ? s.rate : 0);
    for (const f of this.facers) f.lookAt(camera.position);

    if (this.sys.kind === 'star') this.applyEra(year);

    // bodies: parents first (insertion order guarantees it)
    for (const b of this.bodies.values()) {
      const ang = b.phase + (2 * Math.PI * orbitT) / Math.max(b.period, 1e-4);
      const c = b.parent ? b.parent.root.position : this.starPos;
      b.root.position.set(c.x + Math.cos(ang) * b.orbit, c.y + Math.sin(ang) * b.orbit * (b.parent ? 0.12 : 0.02), c.z - Math.sin(ang) * b.orbit);
      b.mesh.rotation.y = orbitT * 40 + b.phase;
      const sun = this.starPos.clone().sub(b.root.position).normalize();
      b.mat.uniforms.uSun.value.copy(sun);
      if (b.atm) (b.atm.material as THREE.ShaderMaterial).uniforms.uSun.value.copy(sun);
    }
  }

  private era = '';
  private applyEra(year: number): void {
    const sol = this.sys.id === 'sol';
    let phase: string;
    if (sol) phase = sunPhase(year);
    else phase = year < this.born ? 'cloud' : year < this.dies ? 'main' : this.massive ? 'supernova' : this.sys.spec[0] === 'M' ? 'main' : 'dwarf';
    if (year < -13.6e9) phase = 'void';

    const key = phase + (sol ? Math.floor(eraBucket(year)) : '');
    if (key === this.era) return;
    this.era = key;

    const show = (o: THREE.Object3D | undefined, v: boolean) => { if (o) o.visible = v; };
    const R = this.starRadius;
    const starOn = phase === 'main' || phase === 'giant' || phase === 'dwarf' || phase === 'proto';
    show(this.starMesh, starOn);
    this.starGlow.forEach((g) => (g.visible = starOn));
    show(this.light, starOn);

    let scale = 1;
    const col = this.baseColor.clone();
    if (phase === 'giant') { scale = sol ? 6.5 : 8; col.set(0xff6a2a); }
    if (phase === 'dwarf') { scale = 0.06; col.set(0xcfe0ff); }
    if (phase === 'proto') { scale = 1.4; col.set(0xff9a50); }
    this.starMesh?.scale.setScalar(R * scale);
    this.starGlow.forEach((g, i) => g.scale.setScalar(R * scale * (i ? 7 : 3.2) * (phase === 'dwarf' ? 6 : 1)));
    this.starGlow.forEach((g) => g.material.color.copy(col));
    this.starMat?.uniforms.uColor.value.copy(col);
    this.light?.color.copy(col);
    if (this.light) this.light.intensity = phase === "dwarf" ? 0.6 : 2.2;

    // birth cloud / remnant
    if (phase === 'cloud' && !this.birthCloud) this.birthCloud = this.makeCloud([[200, 120, 90], [120, 100, 160], [90, 60, 50]], 11, R * 12, 30);
    show(this.birthCloud, phase === 'cloud');
    if ((phase === 'dwarf' || phase === 'supernova') && !this.remnant) {
      this.remnant = phase === 'supernova'
        ? this.makeCloud([[255, 110, 70], [110, 190, 255], [255, 220, 150]], 12, R * 30, 40)
        : this.makeCloud([[90, 220, 200], [255, 100, 120], [140, 160, 255]], 13, R * 14, 36, true);
    }
    show(this.remnant, phase === 'dwarf' || phase === 'supernova');
    if (phase === 'proto' && !this.disk) {
      const r = new Rng(5), n = 9000, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const th = r.range(0, 6.28), rr = R * 2 + Math.pow(r.next(), 0.7) * this.auScale * 6;
        pos[i * 3] = Math.cos(th) * rr; pos[i * 3 + 1] = r.gauss() * rr * 0.03; pos[i * 3 + 2] = Math.sin(th) * rr;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.disk = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc89a70, size: 30, sizeAttenuation: true, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.group.add(this.disk);
      this.spinners.push({ obj: this.disk, rate: 0.05 });
    }
    show(this.disk, phase === 'proto');

    // planets exist only after formation, inner ones vanish in the giant phase
    const planetsOn = phase === 'main' || phase === 'giant' || phase === 'dwarf' || phase === 'supernova';
    for (const b of this.bodies.values()) {
      const top = b.parent ?? b;
      let on = planetsOn;
      if (phase === 'giant' && top.orbit < R * scale * 1.1) on = false;
      if (phase === 'supernova' && top.orbit < R * 40) on = false;
      b.root.visible = on;
      show(b.orbitLine, on);
    }
    for (const belt of this.belts) belt.visible = planetsOn;

    if (sol) this.solLooks(year, phase);
  }

  private solLooks(year: number, phase: string): void {
    const earth = this.bodies.get('Earth'), mars = this.bodies.get('Mars');
    if (earth) {
      let style: number = STYLE.ocean;
      if (year < -3.8e9 || phase === 'giant') style = STYLE.lava;
      else if (year > -7.5e8 && year < -5.4e8) style = STYLE.ice;
      else if (year > 1.5e9 || phase === 'dwarf') style = phase === 'dwarf' ? STYLE.rocky : STYLE.desert;
      earth.mat.uniforms.uStyle.value = style;
      const lights = year < 1880 ? 0 : year > 1e7 ? 0 : year > 3000 ? 0.6 : THREE.MathUtils.clamp((year - 1880) / 300, 0, 0.35);
      earth.mat.uniforms.uLights.value = lights;
      if (earth.extra) earth.extra.visible = year > 2800 && year < 1e8;
      if (earth.atm) earth.atm.visible = style === STYLE.ocean || style === STYLE.ice;
    }
    if (mars) {
      const terra = year > 2600 && year < 1e8;
      mars.mat.uniforms.uGreen.value = terra ? 0.75 : 0;
      mars.mat.uniforms.uLights.value = year > 2300 && year < 1e8 ? 0.5 : 0;
    }
  }

  // ------------------------------------------------------------ queries

  anchor(body?: string): Anchor {
    if (body) {
      const b = this.bodies.get(body);
      if (b) return { pos: b.root.getWorldPosition(new THREE.Vector3()), radius: b.radius, park: b.radius * 3.4 };
    }
    if (this.sys.kind === 'galaxy') return { pos: new THREE.Vector3(), radius: 1, park: 0.01 };
    if (this.sys.kind === 'nebula') return { pos: new THREE.Vector3(), radius: this.starRadius, park: this.starRadius * 6 };
    const R = this.starMesh ? this.starMesh.scale.x : this.starRadius;
    return { pos: this.starPos.clone(), radius: R, park: R * (this.sys.kind === 'blackhole' ? 9 : 4.5) };
  }

  bodyVisible(body?: string): boolean {
    if (!body) return this.starMesh ? this.starMesh.visible : true;
    return this.bodies.get(body)?.root.visible ?? false;
  }

  labels(): { name: string; pos: THREE.Vector3; radius: number; star?: boolean; moon?: boolean }[] {
    const out: { name: string; pos: THREE.Vector3; radius: number; star?: boolean; moon?: boolean }[] = [];
    if (this.starMesh?.visible) out.push({ name: this.sys.name, pos: this.starPos, radius: this.starMesh.scale.x, star: true });
    else if (this.sys.kind !== 'star' && this.sys.kind !== 'galaxy') out.push({ name: this.sys.name, pos: this.starPos, radius: this.starRadius, star: true });
    for (const b of this.bodies.values()) if (b.root.visible) out.push({ name: b.p.name, pos: b.root.position, radius: b.radius, moon: !!b.parent });
    return out;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
  }
}

function eraBucket(year: number): number {
  // distinct look buckets for Earth/Mars; changes only at these boundaries
  const edges = [-3.8e9, -7.5e8, -5.4e8, 1880, 1950, 2000, 2050, 2300, 2600, 2800, 3000, 1e7, 1e8, 1.5e9];
  let i = 0;
  while (i < edges.length && year >= edges[i]) i++;
  return i;
}

function circle(r: number, n = 256): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(Math.cos(a) * r, 0, -Math.sin(a) * r); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
