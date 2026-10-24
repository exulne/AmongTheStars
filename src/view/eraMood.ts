// The era colours the whole picture, lightly: a Collapse drains the colour
// and makes the lights stutter, a War casts the edges red, a Pandemic turns
// the tones sickly, a Golden Age glows warm. One full-screen pass between
// bloom and the output, easing from one mood to the next over a second or two.
// It also owns the exposure of each zoom level: how much light the picture
// takes in and what is bright enough to bloom, so a galaxy of additive stars
// and a sunlit planet each keep deep blacks and only their true highlights glow.

import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { REDUCED_MOTION } from './timeLook.ts';

interface Grade {
  desat: number;          // 0 = as rendered, 1 = grey; negative = richer colour
  tint: [number, number, number]; // multiplies the picture
  edge: [number, number, number]; // faint light added toward the corners (linear, before tone mapping)
  vignette: number;       // how much the corners darken
  flicker: number;        // 0..1 stutter of the lights
  bloom: number;          // added to the bloom strength
}

/** Exposure and bloom for one zoom level. Bloom works on linear light before tone mapping. */
export interface LevelLook { exposure: number; strength: number; radius: number; threshold: number }

// Particles and glows (universe to nearby stars) bloom from a lower threshold so star fields keep
// their soft glow; lit surfaces (planets, streets) only bloom where something emits light.
export const LEVEL_LOOKS: Record<string, LevelLook> = {
  universe: { exposure: 0.9, strength: 0.5, radius: 0.55, threshold: 0.62 },
  galaxy: { exposure: 0.88, strength: 0.48, radius: 0.5, threshold: 0.66 },
  local: { exposure: 0.92, strength: 0.5, radius: 0.45, threshold: 0.6 },
  system: { exposure: 0.92, strength: 0.5, radius: 0.45, threshold: 0.7 },
  planet: { exposure: 0.95, strength: 0.42, radius: 0.35, threshold: 0.95 },
  street: { exposure: 1.0, strength: 0.45, radius: 0.4, threshold: 0.9 },
};
const DEFAULT_LOOK: LevelLook = { exposure: 0.92, strength: 0.48, radius: 0.45, threshold: 0.7 };
/** Era bloom offsets are written against this strength; they scale with each level's own. */
const ERA_BLOOM_REF = 0.7;

const NEUTRAL: Grade = { desat: 0, tint: [1, 1, 1], edge: [0, 0, 0], vignette: 0.12, flicker: 0, bloom: 0 };
const GRADES: Record<string, Grade> = {
  Expansion: NEUTRAL,
  Consolidation: { ...NEUTRAL, desat: 0.04 },
  'Golden Age': { desat: -0.1, tint: [1.07, 1.0, 0.86], edge: [0.007, 0.0045, 0.001], vignette: 0.04, flicker: 0, bloom: 0.28 },
  Stagnation: { desat: 0.22, tint: [0.98, 0.98, 0.96], edge: [0, 0, 0], vignette: 0.16, flicker: 0, bloom: -0.08 },
  War: { desat: 0.12, tint: [1.08, 0.92, 0.88], edge: [0.013, 0.0012, 0.0008], vignette: 0.2, flicker: 0, bloom: 0.05 },
  Pandemic: { desat: 0.28, tint: [0.95, 1.03, 0.8], edge: [0.004, 0.006, 0.0005], vignette: 0.18, flicker: 0, bloom: -0.05 },
  Collapse: { desat: 0.62, tint: [0.93, 0.95, 1.0], edge: [0, 0, 0], vignette: 0.34, flicker: 1, bloom: -0.15 },
  Renaissance: { desat: -0.14, tint: [1.02, 1.0, 1.04], edge: [0.003, 0.002, 0.005], vignette: 0.06, flicker: 0, bloom: 0.12 },
};

const SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uDesat: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uEdge: { value: new THREE.Vector3() },
    uVignette: { value: 0.12 },
    uFlicker: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uDesat, uVignette, uFlicker, uTime, uAspect;
    uniform vec3 uTint, uEdge;
    varying vec2 vUv;
    float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // desaturate (or, below zero, push colour away from grey), never past black
      c.rgb = max(mix(c.rgb, vec3(l), uDesat), 0.0);
      c.rgb *= uTint;
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      float r = smoothstep(0.35, 1.05, length(q) * 1.25);
      c.rgb *= 1.0 - uVignette * r;
      c.rgb += uEdge * r;
      // collapse: the grid browns out now and then, a frame or two at a time
      if (uFlicker > 0.0) {
        float t = floor(uTime * 14.0);
        float dip = step(0.93, h1(t)) * (0.5 + 0.5 * h1(t + 7.0));
        c.rgb *= 1.0 - uFlicker * (0.07 * dip + 0.015 * sin(uTime * 3.1) * sin(uTime * 7.7));
      }
      gl_FragColor = c;
    }`,
};

export class EraMood {
  readonly pass = new ShaderPass(SHADER);
  private cur: Grade = structuredClone(NEUTRAL);
  private target: Grade = NEUTRAL;
  private look: LevelLook = DEFAULT_LOOK;
  era = '';

  constructor(private bloom: UnrealBloomPass, private renderer?: THREE.WebGLRenderer) {}

  /** The zoom level in view sets exposure and bloom. Changes at once: the level swap hides it behind a crossfade. */
  setLevel(level: string): void {
    this.look = LEVEL_LOOKS[level] ?? DEFAULT_LOOK;
  }

  setEra(name: string): void {
    if (name === this.era) return;
    this.era = name;
    this.target = GRADES[name] ?? NEUTRAL;
    // no easing for those who asked for less motion: the grade simply changes
    if (REDUCED_MOTION) this.cur = structuredClone(this.target);
  }

  frame(dt: number, t: number, aspect: number): void {
    const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt * 1.6);
    const a = this.cur, b = this.target;
    a.desat += (b.desat - a.desat) * k;
    a.vignette += (b.vignette - a.vignette) * k;
    a.flicker += (b.flicker - a.flicker) * k;
    a.bloom += (b.bloom - a.bloom) * k;
    for (let i = 0; i < 3; i++) { a.tint[i] += (b.tint[i] - a.tint[i]) * k; a.edge[i] += (b.edge[i] - a.edge[i]) * k; }
    const u = this.pass.uniforms;
    u.uDesat.value = a.desat;
    (u.uTint.value as THREE.Vector3).set(a.tint[0], a.tint[1], a.tint[2]);
    (u.uEdge.value as THREE.Vector3).set(a.edge[0], a.edge[1], a.edge[2]);
    u.uVignette.value = a.vignette;
    u.uFlicker.value = REDUCED_MOTION ? 0 : a.flicker;
    u.uTime.value = t;
    u.uAspect.value = aspect;
    const L = this.look;
    this.bloom.strength = Math.max(0, L.strength * (1 + a.bloom / ERA_BLOOM_REF));
    this.bloom.radius = L.radius;
    this.bloom.threshold = L.threshold;
    if (this.renderer) this.renderer.toneMappingExposure = L.exposure;
  }
}
