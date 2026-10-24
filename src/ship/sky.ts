// The sky is drawn from real 3D positions (light years), not a painted dome.
// Every star and galaxy cloud is projected onto a camera-centred sphere from
// wherever the observer is, with brightness falling off with distance. Fly to
// Alpha Centauri and the Sun shows up as a star in Cassiopeia; fly to
// Andromeda and the Milky Way shrinks into a smudge.

import * as THREE from 'three';
import { Rng } from '../sim/rng.ts';
import { galaxySpriteTex, specColor } from '../view/textures.ts';
import { ANDROMEDA, BIG_BANG, BRIGHT, GALACTIC_CENTER, GALACTIC_POLE, NOW_YEAR, SYSTEMS, type System } from './places.ts';

const SKY_R = 4e5;

function skyMaterial(o: { gain: number; maxPx: number; minPx: number; limit: number; slope: number; pow: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uObs: { value: new THREE.Vector3() },
      uDt: { value: 0 },
      uShift: { value: new THREE.Vector3() },
      uGain: { value: o.gain },
      uPow: { value: o.pow },
      uMaxPx: { value: o.maxPx },
      uMinPx: { value: o.minPx },
      uLimit: { value: o.limit },
      uSlope: { value: o.slope },
      uFade: { value: 1 },
      uPR: { value: Math.min(window.devicePixelRatio, 2) },
      uHide: { value: 0.02 },
    },
    vertexShader: /* glsl */ `
      attribute float lum; attribute vec3 vel; attribute vec3 color;
      uniform vec3 uObs, uShift; uniform float uDt, uGain, uPow, uMaxPx, uMinPx, uLimit, uSlope, uPR, uFade, uHide;
      varying vec3 vColor; varying float vA;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vec3 p = position + uShift + vel * uDt;
        vec3 d = p - uObs;
        float dist = length(d);
        vec3 dir = d / max(dist, 1e-6);
        gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * ${SKY_R.toFixed(1)}, 1.0);
        #include <logdepthbuf_vertex>
        float flux = uGain * lum / pow(max(dist, 0.05), uPow);
        float m = -2.5 * log(max(flux, 1e-30)) / log(10.0);   // flux 1 = magnitude 0
        gl_PointSize = clamp(uMaxPx - m * uSlope, uMinPx, uMaxPx) * uPR;
        vA = clamp((uLimit - m) / 2.0, 0.0, 1.0) * uFade * step(uHide, dist);
        vColor = color;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vA;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0 || vA < 0.002) discard;
        float k = exp(-r * r * 7.0) + exp(-r * 3.0) * 0.25;
        gl_FragColor = vec4(vColor * k * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
}

function pointsFrom(pos: number[], col: number[], lum: number[], vel: number[], mat: THREE.ShaderMaterial): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('lum', new THREE.Float32BufferAttribute(lum, 1));
  g.setAttribute('vel', new THREE.Float32BufferAttribute(vel, 3));
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  p.renderOrder = -10;
  return p;
}

/** Orthonormal basis for a disk: u, w in-plane, n normal. */
function basis(n: THREE.Vector3, hint: THREE.Vector3): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  const u = hint.clone().addScaledVector(n, -hint.dot(n)).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  return [u, w, n];
}

/** Spiral galaxy as a cloud of luminous blobs, in ly, around `center`. */
function galaxyCloud(seed: number, count: number, R: number, center: THREE.Vector3, n: THREE.Vector3, hint: THREE.Vector3, hole?: THREE.Vector3) {
  const r = new Rng(seed);
  const [u, w] = basis(n, hint);
  const pos: number[] = [], col: number[] = [], lum: number[] = [], vel: number[] = [];
  const c = new THREE.Color();
  const p = new THREE.Vector3();
  const arms = 4, k = 1 / Math.tan((13 * Math.PI) / 180);
  for (let i = 0; i < count; i++) {
    const t = r.next();
    let x: number, y: number, z: number, L: number;
    if (t < 0.25) {
      const along = r.gauss() * R * 0.12, across = r.gauss() * R * 0.05;
      x = along * 0.9 - across * 0.43; y = along * 0.43 + across * 0.9; z = r.gauss() * R * 0.035;
      c.set(r.next() < 0.5 ? 0xffd9a8 : 0xffc58a); L = 3;
    } else {
      const rr = R * (0.08 + Math.min(1, -Math.log(1 - r.next() * 0.98) * 0.27));
      const arm = r.int(0, arms - 1);
      const th = Math.log(rr / (R * 0.08)) * k * 0.5 + (arm / arms) * Math.PI * 2 + r.gauss() * (0.2 + 0.35 * rr / R);
      x = Math.cos(th) * rr; y = Math.sin(th) * rr; z = r.gauss() * R * 0.012;
      const pick = r.next();
      c.set(pick < 0.55 ? 0xc8d6ff : pick < 0.9 ? 0xfff0e0 : pick < 0.97 ? 0xffd2a0 : 0xff6b9a); L = 1;
    }
    p.copy(center).addScaledVector(u, x).addScaledVector(w, y).addScaledVector(n, z);
    if (hole && p.distanceTo(hole) < 1800) continue;
    pos.push(p.x, p.y, p.z);
    const b = 0.5 + r.next() * 0.7;
    col.push(c.r * b, c.g * b, c.b * b);
    lum.push(L);
    vel.push(0, 0, 0);
  }
  return { pos, col, lum, vel };
}

export class Sky {
  group = new THREE.Group();
  private starMat = skyMaterial({ gain: 1 / 0.34, maxPx: 9, minPx: 1.1, limit: 7.2, slope: 1.05, pow: 2 });
  private mwMat = skyMaterial({ gain: 5e4, maxPx: 1.6, minPx: 1.2, limit: 10.5, slope: 0.25, pow: 1.75 });
  private m31Mat = skyMaterial({ gain: 1.2e5, maxPx: 1.6, minPx: 1.2, limit: 10.5, slope: 0.25, pow: 1.75 });
  private beacons: THREE.Points;
  private beaconCount = 0;
  private impostors: { sprite: THREE.Sprite; center: () => THREE.Vector3; R: number; base: number }[] = [];
  readonly obs = new THREE.Vector3();
  private m31Shift = new THREE.Vector3();
  private bg = new THREE.Color();

  constructor() {
    const rng = new Rng(4242);
    const pos: number[] = [], col: number[] = [], lum: number[] = [], vel: number[] = [];
    const push = (p: THREE.Vector3, L: number, spec: string, v?: THREE.Vector3) => {
      pos.push(p.x, p.y, p.z);
      const c = specColor(spec);
      col.push(c.r, c.g, c.b);
      lum.push(L);
      const vv = v ?? new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(6e-5);
      vel.push(vv.x, vv.y, vv.z);
    };
    const named = new Set<string>();
    for (const s of SYSTEMS) {
      if (s.kind !== 'star') continue;
      push(s.pos, s.lum, s.spec, s.id === 'sol' ? new THREE.Vector3() : undefined);
      named.add(s.name);
    }
    for (const [name] of BRIGHT) named.add(name);
    // background field: a thick disk of ordinary stars, a few giants
    for (let i = 0; i < 26000; i++) {
      const d = 20 + Math.pow(rng.next(), 0.6) * 4000;
      const v = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).normalize();
      v.addScaledVector(GALACTIC_POLE, -v.dot(GALACTIC_POLE) * Math.min(0.92, d / 1500)).normalize().multiplyScalar(d);
      const roll = rng.next();
      const L = roll < 0.002 ? rng.range(2000, 60000) : roll < 0.03 ? rng.range(50, 900) : roll < 0.3 ? rng.range(2, 40) : rng.range(0.05, 2);
      const spec = L > 1000 ? (rng.next() < 0.6 ? 'B2' : 'M1') : L > 40 ? (rng.next() < 0.5 ? 'K3' : 'A2') : rng.pick(['G2', 'K5', 'F5', 'M3', 'A5', 'G8']);
      push(v, L, spec);
    }
    this.group.add(pointsFrom(pos, col, lum, vel, this.starMat));

    // beacons: stars of systems generated at runtime
    const bpos = new Float32Array(64 * 3), bcol = new Float32Array(64 * 3), blum = new Float32Array(64), bvel = new Float32Array(64 * 3);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bg.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
    bg.setAttribute('lum', new THREE.BufferAttribute(blum, 1));
    bg.setAttribute('vel', new THREE.BufferAttribute(bvel, 3));
    this.beacons = new THREE.Points(bg, this.starMat);
    this.beacons.frustumCulled = false;
    this.beacons.renderOrder = -10;
    this.group.add(this.beacons);

    // Milky Way: the Sun sits ~26,700 ly from the centre, in the disk
    const toSun = GALACTIC_CENTER.clone().negate().normalize();
    const mw = galaxyCloud(77, 160000, 50000, GALACTIC_CENTER, GALACTIC_POLE, toSun, new THREE.Vector3());
    this.group.add(pointsFrom(mw.pos, mw.col, mw.lum, mw.vel, this.mwMat));

    // Andromeda: inclined 77 degrees to our line of sight
    const los = ANDROMEDA.clone().normalize();
    const perp = new THREE.Vector3().crossVectors(los, new THREE.Vector3(0, 1, 0)).normalize();
    const m31n = los.clone().multiplyScalar(Math.cos((77 * Math.PI) / 180)).addScaledVector(perp, Math.sin((77 * Math.PI) / 180)).normalize();
    const m31 = galaxyCloud(31, 60000, 90000, ANDROMEDA, m31n, new THREE.Vector3(0, 1, 0));
    this.group.add(pointsFrom(m31.pos, m31.col, m31.lum, m31.vel, this.m31Mat));

    // far-away impostors so galaxies stay visible as smudges at any distance
    this.addImpostor(() => ANDROMEDA.clone().add(this.m31Shift), 95000, 7, 0.55);
    this.addImpostor(() => GALACTIC_CENTER, 50000, 3, 0.7);
    // background galaxies
    for (let i = 0; i < 40; i++) {
      const dir = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).normalize().multiplyScalar(rng.range(2e7, 2e8));
      this.addImpostor(() => dir, rng.range(30000, 90000), 100 + i, rng.range(0.25, 0.6));
    }
  }

  private addImpostor(center: () => THREE.Vector3, R: number, seed: number, base: number): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: galaxySpriteTex(seed), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
    sprite.material.rotation = (seed * 1.7) % Math.PI;
    sprite.renderOrder = -11;
    this.group.add(sprite);
    this.impostors.push({ sprite, center, R, base });
  }

  addBeacon(sys: System): void {
    if (this.beaconCount >= 64) this.beaconCount = 0;
    const g = this.beacons.geometry;
    const i = this.beaconCount++;
    (g.attributes.position as THREE.BufferAttribute).setXYZ(i, sys.pos.x, sys.pos.y, sys.pos.z);
    const c = specColor(sys.spec);
    (g.attributes.color as THREE.BufferAttribute).setXYZ(i, c.r, c.g, c.b);
    (g.attributes.lum as THREE.BufferAttribute).setX(i, sys.lum);
    for (const k of ['position', 'color', 'lum']) g.attributes[k].needsUpdate = true;
  }

  /** Observer position (ly), year, camera. Also returns the background colour for the epoch. */
  update(obs: THREE.Vector3, year: number, camera: THREE.Camera, scene: THREE.Scene): void {
    this.obs.copy(obs);
    const dt = THREE.MathUtils.clamp(year - NOW_YEAR, -5e7, 5e7);
    // cosmic epochs: no stars right after the Big Bang, none after they all burn out
    const sinceBang = year - BIG_BANG;
    const lit = THREE.MathUtils.smoothstep(sinceBang, 1.5e8, 6e8) * (1 - THREE.MathUtils.smoothstep(Math.log10(Math.max(year, 1)), 12.5, 14));
    // Andromeda falls toward us over the next 4.5 billion years
    const fall = THREE.MathUtils.clamp((year - NOW_YEAR) / 4.5e9, 0, 1);
    this.m31Shift.copy(ANDROMEDA).multiplyScalar(-Math.pow(fall, 1.6) * 0.97);
    for (const m of [this.starMat, this.mwMat, this.m31Mat]) {
      m.uniforms.uObs.value.copy(obs);
      m.uniforms.uDt.value = dt;
      m.uniforms.uFade.value = lit;
    }
    this.m31Mat.uniforms.uShift.value.copy(this.m31Shift);
    this.mwMat.uniforms.uFade.value = lit * THREE.MathUtils.smoothstep(sinceBang, 1e9, 3e9);
    this.m31Mat.uniforms.uFade.value = this.mwMat.uniforms.uFade.value;

    const tmp = new THREE.Vector3();
    for (const im of this.impostors) {
      tmp.copy(im.center()).sub(obs);
      const d = tmp.length();
      const ang = Math.atan2(im.R, d) * 2;
      tmp.normalize();
      im.sprite.position.copy(camera.position).addScaledVector(tmp, SKY_R * 0.9);
      const size = Math.tan(Math.min(ang, 2.5) / 2) * SKY_R * 0.9 * 2.6;
      im.sprite.scale.set(size, size, 1);
      // fade out once the point cloud resolves the galaxy, and when we're inside it
      const resolved = 1 - THREE.MathUtils.smoothstep(d, im.R * 2, im.R * 6);
      im.sprite.material.opacity = im.base * (1 - resolved * 0.85) * this.mwMat.uniforms.uFade.value;
      im.sprite.visible = d > im.R * 0.7;
    }

    // background: the Big Bang glows, the dark ages are black
    if (sinceBang < 4e5) this.bg.setRGB(1.0, 0.55, 0.25);
    else if (sinceBang < 2e8) this.bg.setRGB(0.25, 0.08, 0.04).multiplyScalar(1 - THREE.MathUtils.smoothstep(sinceBang, 4e5, 2e8));
    else this.bg.setRGB(0.004, 0.004, 0.008);
    (scene.background as THREE.Color).copy(this.bg);
  }
}
