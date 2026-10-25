// The ship: a procedural hull (nose along +Z), an interior cockpit used in
// first person, and the drive effects: exhaust, warp streaks, the warp tunnel,
// and the chrono bubble with rings for time jumps.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glowTex } from '../view/textures.ts';
import { STARSHIP_LEN, buildStarship } from './starship.ts';

export interface ModelSpec {
  url: string;
  rot: [number, number, number];   // euler that turns the model nose to +Z, top to +Y
  length: number;                  // scene units, nose to tail
  engines: [number, number][];     // nozzle x,y as fractions of half-width/half-height
  plume: number;                   // plume radius
}


function hullMat(color: number, rough = 0.45, metal = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Exhaust plume: additive cone with flickering noise, length set by throttle. */
function plumeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uColor: { value: new THREE.Color(0x7fc8ff) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uPower; uniform vec3 uColor; varying vec2 vUv;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        float along = vUv.y;                       // 1 at nozzle, 0 at tip
        float flick = 0.75 + 0.25 * sin(uTime * 60.0 + along * 30.0) * sin(uTime * 37.0);
        float core = pow(along, 2.2);
        vec3 c = mix(uColor, vec3(1.0), core * 0.6) * (core * 1.3 + 0.18) * flick * uPower;
        gl_FragColor = vec4(c, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

function tunnelMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAmt: { value: 0 }, uA: { value: new THREE.Color(0x3a5cff) }, uB: { value: new THREE.Color(0xb46bff) }, uSpeed: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAmt, uSpeed; uniform vec3 uA, uB; varying vec2 vUv;
      #include <logdepthbuf_pars_fragment>
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = vec2(vUv.x * 24.0, vUv.y * 6.0 - uTime * uSpeed);
        float n = n2(p) * 0.55 + n2(p * 2.3 + 7.0) * 0.3 + n2(p * 5.1) * 0.15;
        float streak = pow(n2(vec2(vUv.x * 90.0, vUv.y * 1.5 - uTime * uSpeed * 2.0)), 6.0);
        vec3 c = mix(uA, uB, n) * (0.12 + n * 0.45) * smoothstep(0.25, 0.75, n) + vec3(0.7, 0.82, 1.0) * streak * 0.45;
        float ends = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        gl_FragColor = vec4(c * uAmt * ends, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });
}

function bubbleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAmt: { value: 0 }, uColor: { value: new THREE.Color(0x66e0ff) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position,1.0); vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAmt; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        float rim = pow(1.0 - abs(dot(normalize(vN), vV)), 2.0);
        float hex = abs(sin(vP.x * 2.0 + uTime * 3.0) * sin(vP.y * 2.0 - uTime * 2.0) * sin(vP.z * 2.0 + uTime));
        float i = (rim * 0.7 + smoothstep(0.85, 1.0, hex) * 0.3) * uAmt;
        gl_FragColor = vec4(uColor * i, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

const STREAKS = 900;

export class Ship {
  readonly root = new THREE.Group();          // world transform of the ship
  readonly hull = new THREE.Group();          // exterior model (hidden in first person)
  readonly cockpit = new THREE.Group();       // interior (shown in first person)
  readonly cockpitEye = new THREE.Vector3(0, 0.42, 1.05);
  private plumes: THREE.Mesh[] = [];
  private plumeMat = plumeMaterial();
  private nozzleGlow: THREE.Sprite[] = [];
  private engineLight = new THREE.PointLight(0x7fc8ff, 0, 30, 2);
  private nav: THREE.Sprite[] = [];
  private screens: THREE.MeshBasicMaterial[] = [];

  private streakGeo = new THREE.BufferGeometry();
  private streakSeed = new Float32Array(STREAKS * 3);
  private streakMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  private tunnelMat = tunnelMaterial();
  private tunnel: THREE.Mesh;
  private bubbleMat = bubbleMaterial();
  private bubble: THREE.Mesh;
  private rings: THREE.Mesh[] = [];
  private ringMat = new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });

  throttle = 0;   // 0..1 exhaust
  warp = 0;       // 0..1 tunnel + streaks
  speed = 0;      // streak speed (units/s in ship space)
  chrono = 0;     // 0..1 bubble + rings
  chronoDir = 1;  // +1 future, -1 past

  constructor() {
    this.buildHull();
    this.buildCockpit();
    this.root.add(this.hull, this.cockpit);
    this.cockpit.visible = false;

    // streaks live in ship space and rush past along -Z
    const pos = new Float32Array(STREAKS * 6), col = new Float32Array(STREAKS * 6);
    for (let i = 0; i < STREAKS; i++) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.pow(Math.random(), 0.6) * 70;
      this.streakSeed.set([Math.cos(a) * r, Math.sin(a) * r, (Math.random() - 0.5) * 600], i * 3);
      const c = new THREE.Color().setHSL(0.58 + Math.random() * 0.12, 0.6, 0.38 + Math.random() * 0.25);
      col.set([c.r, c.g, c.b, c.r * 0.1, c.g * 0.1, c.b * 0.1], i * 6);
    }
    this.streakGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.streakGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const streaks = new THREE.LineSegments(this.streakGeo, this.streakMat);
    streaks.frustumCulled = false;
    this.root.add(streaks);

    this.tunnel = new THREE.Mesh(new THREE.CylinderGeometry(55, 55, 900, 48, 1, true), this.tunnelMat);
    this.tunnel.rotation.x = Math.PI / 2;
    this.tunnel.visible = false;
    this.root.add(this.tunnel);

    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(5.5, 48, 32), this.bubbleMat);
    this.bubble.visible = false;
    this.root.add(this.bubble);
    for (let i = 0; i < 14; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.08, 6, 96), this.ringMat);
      ring.position.z = (i - 7) * 12;
      ring.visible = false;
      this.rings.push(ring);
      this.root.add(ring);
      // clock ticks on every ring
      for (let k = 0; k < 12; k++) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.12, k % 3 ? 0.7 : 1.5, 0.12), this.ringMat);
        const a = (k / 12) * Math.PI * 2;
        tick.position.set(Math.cos(a) * 9, Math.sin(a) * 9, 0);
        tick.rotation.z = a - Math.PI / 2;
        ring.add(tick);
      }
    }
  }

  private proc = new THREE.Group();     // procedural hull, replaced when a model loads
  private plumeRig = new THREE.Group();

  /** Swap the procedural hull for a glTF model. */
  async useModel(spec: ModelSpec): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(spec.url);
    const model = gltf.scene;
    model.rotation.set(...spec.rot);
    const pivot = new THREE.Group();
    pivot.add(model);
    pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(pivot);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const k = spec.length / size.z;
    pivot.scale.setScalar(k);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) {
        if (mat.metalness !== undefined && mat.metalness > 0.6 && !mat.metalnessMap) mat.metalness = 0.6;
        mat.envMapIntensity = 0.8;
      }
    });
    this.proc.visible = false;
    this.hull.add(pivot);
    // engines at the tail
    const hw = (size.x * k) / 2, hh = (size.y * k) / 2, tail = -spec.length / 2;
    this.plumeRig.children.slice().forEach((c) => this.plumeRig.remove(c));
    this.plumes.length = 0;
    this.nozzleGlow.length = 0;
    for (const [ex, ey] of spec.engines) {
      const plume = new THREE.Mesh(new THREE.ConeGeometry(spec.plume, 1, 24, 1, true), this.plumeMat);
      plume.geometry.translate(0, -0.5, 0);
      plume.rotation.x = Math.PI / 2;
      plume.position.set(ex * hw, ey * hh, tail - 0.05);
      this.plumes.push(plume);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7fc8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.position.set(ex * hw, ey * hh, tail - 0.1);
      this.nozzleGlow.push(glow);
      this.plumeRig.add(plume, glow);
    }
    this.engineLight.position.set(0, 0, tail - 1);
    this.nav.forEach((n) => (n.visible = false));
  }

  private buildHull(): void {
    this.hull.add(this.proc, this.plumeRig);
    buildStarship(this.proc);
    // six Raptors: three sea-level in the middle, three big vacuum bells outside
    const tail = -STARSHIP_LEN / 2;
    const engines: [number, number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      engines.push([Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.085]);
      const b = a + Math.PI / 3;
      engines.push([Math.cos(b) * 0.31, Math.sin(b) * 0.31, 0.14]);
    }
    for (const [x, y, r] of engines) {
      const plume = new THREE.Mesh(new THREE.ConeGeometry(r * 1.05, 1, 24, 1, true), this.plumeMat);
      plume.geometry.translate(0, -0.5, 0);
      plume.rotation.x = Math.PI / 2;
      plume.position.set(x, y, tail - (r > 0.1 ? 0.36 : 0.24));
      this.plumes.push(plume);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x9fd0ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      glow.position.copy(plume.position).z -= 0.04;
      this.nozzleGlow.push(glow);
      this.plumeRig.add(plume, glow);
    }
    this.engineLight.position.set(0, 0, tail - 1.2);
    this.hull.add(this.engineLight);
    // a little hull light so the ship never goes fully black on the night side
    const fill = new THREE.PointLight(0x9fb8d8, 0.6, 12, 2);
    fill.position.set(0, 3, 2);
    this.hull.add(fill);
  }

  private buildCockpit(): void {
    const c = this.cockpit;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1d23, roughness: 0.6, metalness: 0.5 });
    const eye = this.cockpitEye;
    // canopy frame: arches around the view
    const arch = (z: number, w: number, hgt: number) => {
      const curve = new THREE.EllipseCurve(0, 0, w, hgt, 0, Math.PI, false, 0);
      const pts = curve.getPoints(40).map((p) => new THREE.Vector3(p.x, p.y, 0));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.012, 6, false), frameMat);
      tube.position.set(eye.x, eye.y - 0.25, eye.z + z);
      c.add(tube);
    };
    arch(0.55, 0.62, 0.55);
    arch(0.05, 0.75, 0.6);
    // center spine
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.6), frameMat);
    spine.position.set(eye.x, eye.y + 0.3, eye.z + 0.3);
    c.add(spine);
    // side rails
    for (const s of [1, -1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.8), frameMat);
      rail.position.set(eye.x + s * 0.66, eye.y - 0.24, eye.z + 0.25);
      c.add(rail);
    }
    // dashboard
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.3, 0.45), new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.8, metalness: 0.3 }));
    dash.position.set(eye.x, eye.y - 0.5, eye.z + 0.5);
    dash.rotation.x = -0.35;
    c.add(dash);
    const colors = [0x3fd0ff, 0xff8a3a, 0x58ffa0, 0x3fd0ff, 0xb67bff];
    colors.forEach((col, i) => {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(0.55), transparent: true, opacity: 0.6 });
      this.screens.push(m);
      const w = i === 2 ? 0.16 : 0.08;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.05), m);
      const x = [-0.3, -0.18, 0, 0.18, 0.3][i];
      scr.position.set(eye.x + x, eye.y - 0.37, eye.z + 0.4);
      scr.rotation.x = -0.35 - Math.PI / 2 + Math.PI / 2;
      scr.rotation.y = Math.PI;
      c.add(scr);
    });
    // nose visible below the glass
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 24), hullMat(0x6f737a, 0.5, 0.8));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, eye.y - 0.62, eye.z + 1.15);
    c.add(nose);
    const glow = new THREE.PointLight(0x3fbfff, 0.4, 1.5, 2);
    glow.position.set(eye.x, eye.y - 0.25, eye.z + 0.3);
    c.add(glow);
  }

  setFirstPerson(fp: boolean): void {
    this.hull.visible = !fp;
    this.cockpit.visible = fp;
  }

  update(dt: number, time: number): void {
    // exhaust
    this.plumeMat.uniforms.uTime.value = time;
    // seen from the chase camera the plumes point back at us: bright enough to read, never a white wall over the hull
    this.plumeMat.uniforms.uPower.value = this.throttle * 0.7;
    for (const p of this.plumes) { p.visible = this.throttle > 0.04; p.scale.set(1, 0.3 + this.throttle * 2.2 + this.warp * 0.5, 1); }
    for (const g of this.nozzleGlow) { g.scale.setScalar(0.25 + this.throttle * 1.2); g.material.opacity = 0.1 + this.throttle * 0.5; }
    this.engineLight.intensity = this.throttle * 5;
    const blink = (Math.sin(time * 4) > 0.6 ? 1 : 0.15);
    this.nav.forEach((n) => (n.material.opacity = blink));
    this.screens.forEach((s, i) => (s.opacity = 0.45 + 0.2 * Math.sin(time * (1.3 + i * 0.7) + i)));

    // streaks
    const show = Math.max(this.warp, this.throttle * 0.35);
    // streaks rush past the camera: keep them a thin sparkle, not a white-out under bloom
    this.streakMat.opacity = show * 0.45;
    if (show > 0.01) {
      const pos = this.streakGeo.attributes.position as THREE.BufferAttribute;
      const len = 2 + this.speed * 0.06;
      for (let i = 0; i < STREAKS; i++) {
        let z = this.streakSeed[i * 3 + 2] - this.speed * dt;
        if (z < -300) z += 600;
        this.streakSeed[i * 3 + 2] = z;
        const x = this.streakSeed[i * 3], y = this.streakSeed[i * 3 + 1];
        pos.setXYZ(i * 2, x, y, z);
        pos.setXYZ(i * 2 + 1, x, y, z + len);
      }
      pos.needsUpdate = true;
    }

    // warp tunnel
    this.tunnel.visible = this.warp > 0.01;
    this.tunnelMat.uniforms.uTime.value = time;
    this.tunnelMat.uniforms.uAmt.value = this.warp * 0.24;

    // chrono bubble + rings
    const on = this.chrono > 0.01;
    this.bubble.visible = on;
    this.bubbleMat.uniforms.uTime.value = time;
    this.bubbleMat.uniforms.uAmt.value = this.chrono;
    const col = this.chronoDir > 0 ? 0x66e0ff : 0xffa040;
    this.bubbleMat.uniforms.uColor.value.set(col);
    this.ringMat.color.set(col);
    this.ringMat.opacity = this.chrono * 0.5;
    const ringSpeed = 25 + this.chrono * 90;
    this.rings.forEach((r, i) => {
      r.visible = on;
      r.position.z -= ringSpeed * dt * this.chronoDir;
      if (r.position.z < -84) r.position.z += 168;
      if (r.position.z > 84) r.position.z -= 168;
      const near = 1 - Math.min(1, Math.abs(r.position.z) / 84);
      r.scale.setScalar(0.6 + near * 0.8);
      r.rotation.z = time * (i % 2 ? 0.6 : -0.6) * this.chronoDir;
    });
  }

  setTunnelColors(a: number, b: number, speed: number): void {
    this.tunnelMat.uniforms.uA.value.set(a);
    this.tunnelMat.uniforms.uB.value.set(b);
    this.tunnelMat.uniforms.uSpeed.value = speed;
  }
}
