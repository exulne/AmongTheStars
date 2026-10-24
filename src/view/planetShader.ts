// Procedural planet surface: noise-driven terrain per body kind, day/night
// terminator, city lights that scale with population, fresnel atmosphere.

import * as THREE from 'three';
import type { BodyKind } from '../sim/catalog.ts';

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<6;i++){f+=a*snoise(p);p*=2.03;a*=0.5;}return f;}
`;

// kind → style id used in the shader
const STYLE: Record<BodyKind, number> = {
  rocky: 0, superearth: 0, moon: 0, asteroid: 0, dwarf: 4, desert: 1, ocean: 2, lava: 3, ice: 4, gas: 5, icegiant: 6, habitat: 0,
};

/** `haze` (0..1) smooths the surface under a thick atmosphere, as on Titan or Venus. */
export function planetMaterial(kind: BodyKind, color: number, seed: number, haze = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStyle: { value: STYLE[kind] },
      uSeed: { value: (seed % 97) * 1.37 },
      uSun: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
      uLights: { value: 0 },      // 0..1 city light coverage
      uGreen: { value: 0 },       // legacy, unused: terraforming now reads uTerra
      uTerra: { value: 0 },       // 0..1 terraforming: air, then seas, then green land and clouds
      uEpoch: { value: 0 },       // 0..4 night-light style: sodium, LED grid, arcologies, lace, beacons
      uDim: { value: 0 },         // 0..1 blackouts: collapse, unrest, shortage
      uFlicker: { value: 1 },     // 0 when the viewer prefers reduced motion
      uTime: { value: 0 },
      uDetail: { value: 1 },
      uHaze: { value: haze },
      uCulture: { value: new THREE.Color(1, 1, 1) }, // the society's own light colour (society.architecture.hue)
      uCultureMix: { value: 0 },  // 0..1 how far the night lights take it
      uGlow: { value: 1 },        // brightness of the night lights (society.architecture.glow)
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vNormal; varying vec3 vView;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vPos = position;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uSun, uCulture; uniform float uStyle, uSeed, uLights, uGreen, uTime, uDetail, uHaze, uTerra, uEpoch, uDim, uFlicker, uCultureMix, uGlow;
      varying vec3 vPos; varying vec3 vNormal; varying vec3 vView;
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      void main(){
        #include <logdepthbuf_fragment>
        vec3 p = normalize(vPos);
        vec3 q = p * 2.2 + uSeed;
        float n = fbm(q * uDetail);
        float lat = p.y;
        vec3 base = uColor;
        vec3 col;
        float spec = 0.0;
        if (uStyle < 0.5) {            // rocky: craters and maria
          float m = smoothstep(-0.1, 0.25, n);
          col = mix(base * 0.55, base * 1.15, m);
          col *= 0.93 + 0.14 * snoise(q * 9.0);
        } else if (uStyle < 1.5) {     // desert (Mars-like)
          float m = smoothstep(-0.2, 0.35, n);
          col = mix(base * 0.6, base * 1.2, m);
          // the polar cap shrinks as the planet warms
          float capLo = 0.82 + 0.15 * smoothstep(0.08, 0.7, uTerra);
          col = mix(col, vec3(0.82), smoothstep(capLo, capLo + 0.08, abs(lat)) );
        } else if (uStyle < 2.5) {     // ocean world / Earth
          float land = smoothstep(0.02, 0.08, n);
          vec3 sea = mix(vec3(0.02,0.08,0.22), base * 0.8, 0.4);
          vec3 ground = mix(vec3(0.16,0.32,0.12), vec3(0.55,0.45,0.3), smoothstep(0.1, 0.45, n));
          col = mix(sea, ground, land);
          spec = (1.0 - land) * 0.6;
          col = mix(col, vec3(0.85), smoothstep(0.75, 0.85, abs(lat) + n * 0.1));
          float cl = smoothstep(0.1, 0.5, fbm(q * 1.6 + vec3(uTime * 0.01, 0.0, 0.0)));
          col = mix(col, vec3(0.9), cl * 0.6);
        } else if (uStyle < 3.5) {     // lava
          float c = abs(snoise(q * 3.0));
          col = mix(base * 0.25, vec3(0.08,0.05,0.04), smoothstep(0.0, 0.2, c));
          col += vec3(1.0,0.35,0.08) * smoothstep(0.12, 0.0, c) * 1.6;
        } else if (uStyle < 4.5) {     // ice
          float m = smoothstep(-0.3, 0.4, n);
          col = mix(base * 0.75, vec3(0.86,0.88,0.9), m);
          col *= 0.9 + 0.1 * abs(snoise(q * 14.0));
          spec = 0.3;
        } else {                       // gas / ice giants: bands
          float b = sin(lat * (uStyle < 5.5 ? 22.0 : 9.0) + n * 2.5);
          col = mix(base * 0.7, base * 1.2, 0.5 + 0.5 * b);
          // one great storm per giant
          float storm = 1.0 - smoothstep(0.06, 0.1, length(vec2(atan(p.z, p.x) * 0.25 - 0.4, (lat + 0.3) * 0.7)));
          col = mix(col, base * vec3(1.15, 0.7, 0.55), storm * (uStyle < 5.5 ? 0.8 : 0.4));
        }
        // thick haze hides the terrain, leaving soft banding
        col = mix(col, base * (0.82 + 0.12 * n + 0.06 * sin(lat * 6.0)), uHaze * 0.85);
        // terraforming, on solid worlds only: seas fill the low ground, then plants, then weather
        float tf = (uStyle < 1.5 || (uStyle > 3.5 && uStyle < 4.5)) ? uTerra : 0.0;
        if (tf > 0.0) {
          float seaLevel = mix(-0.75, 0.06, smoothstep(0.2, 1.0, tf));
          float wet = smoothstep(seaLevel + 0.025, seaLevel - 0.025, n) * smoothstep(0.18, 0.32, tf);
          vec3 water = mix(vec3(0.06, 0.24, 0.40), vec3(0.01, 0.07, 0.22), clamp((seaLevel - n) * 3.0, 0.0, 1.0));
          // wet soil darkens and browns, then plants spread up from the coasts
          col = mix(col, vec3(0.4, 0.31, 0.22) * (0.8 + 0.5 * n), smoothstep(0.25, 0.9, tf) * 0.65);
          float veg = smoothstep(0.3, 0.9, tf) * smoothstep(seaLevel - 0.01, seaLevel + 0.05, n) * (1.0 - smoothstep(0.6, 0.85, abs(lat))) * (1.0 - smoothstep(0.4, 0.62, n));
          col = mix(col, vec3(0.2, 0.36, 0.16) * (0.8 + 0.4 * snoise(q * 5.0)), veg * 0.8);
          col = mix(col, water, wet);
          spec = max(spec, wet * 0.3);
          float cl = smoothstep(0.2, 0.6, fbm(q * 1.4 + vec3(uTime * 0.008, 0.0, 0.0)) + 0.22 * sin(lat * 9.0 + n * 2.0));
          col = mix(col, vec3(0.93), cl * smoothstep(0.3, 0.85, tf) * 0.55);
        }

        vec3 N = normalize(vNormal);
        float d = dot(N, uSun);
        float day = smoothstep(-0.08, 0.25, d);
        vec3 lit = col * (0.03 + 0.92 * max(d, 0.0));
        vec3 H = normalize(uSun + vView);
        lit += vec3(1.0, 0.95, 0.85) * pow(max(dot(N, H), 0.0), 40.0) * spec * day;
        // city lights only past the terminator; their look follows the technology of the age
        float night = smoothstep(0.02, -0.14, d);
        float cityN = snoise(q * 6.0) * 0.5 + 0.5 + snoise(q * 24.0) * 0.25;
        float cityMask = smoothstep(0.55, 0.9, cityN);
        float cell = fract(sin(dot(floor(p * 60.0), vec3(12.9898,78.233,37.719))) * 43758.5453);
        float on = smoothstep(0.0, 0.05, uLights);
        float e = clamp(uEpoch, 0.0, 4.0);
        vec3 lights = vec3(0.0);
        // 0: sodium-orange blotches
        float w0 = max(0.0, 1.0 - abs(e));
        if (w0 > 0.0) lights += w0 * vec3(1.0, 0.72, 0.38) * cityMask * step(1.0 - uLights, cell) * 1.15;
        // 1: white LED street grids spreading out of the old cores
        float w1 = max(0.0, 1.0 - abs(e - 1.0));
        vec2 sp = vec2(atan(p.z, p.x) / 6.2832, asin(clamp(p.y, -1.0, 1.0)) / 3.1416);
        vec2 gf = abs(fract(sp * vec2(220.0, 110.0)) - 0.5);
        float grid = 1.0 - smoothstep(0.0, 0.14, min(gf.x, gf.y));
        float gridMask = smoothstep(0.5 - uLights * 0.15, 0.8, cityN);
        if (w1 > 0.0) lights += w1 * vec3(0.9, 0.95, 1.0) * gridMask * (grid * 0.9 + 0.12) * 1.1;
        // 2: a few blue arcology clusters, very bright, dark country between
        float w2 = max(0.0, 1.0 - abs(e - 2.0));
        float arcN = snoise(q * 2.6 + 11.0) * 0.5 + 0.5;
        float arc = smoothstep(0.7, 0.9, arcN) * (0.55 + 0.45 * smoothstep(0.6, 1.0, cell));
        float arcCore = smoothstep(0.86, 0.95, arcN);
        if (w2 > 0.0) lights += w2 * (vec3(0.38, 0.66, 1.0) * arc * 1.3 + vec3(0.85, 0.95, 1.0) * arcCore * 1.4 + vec3(0.9, 0.95, 1.0) * gridMask * grid * 0.12);
        // 3: lace: grown cities as fine filaments over the whole land
        float w3 = max(0.0, 1.0 - abs(e - 3.0));
        float lace = pow(1.0 - abs(snoise(q * 7.0)), 14.0) + 0.7 * pow(1.0 - abs(snoise(q * 19.0 + 3.0)), 20.0);
        if (w3 > 0.0) lights += w3 * vec3(0.78, 0.7, 1.0) * lace * smoothstep(0.35, 0.7, cityN + uLights * 0.2) * 0.95;
        // 4: the bodies are gone; a few beacons pulse on a dark world
        float w4 = max(0.0, 1.0 - abs(e - 4.0));
        if (w4 > 0.0) {
          vec3 bp = p * 20.0;
          float bh = fract(sin(dot(floor(bp), vec3(41.3, 289.1, 17.7))) * 24634.63);
          float r0 = length(fract(bp) - 0.5);
          float pulse = 0.6 + 0.4 * sin(uTime * 1.3 * uFlicker + bh * 40.0);
          float beacon = step(0.92, bh) * ((1.0 - smoothstep(0.05, 0.12, r0)) * 3.0 + (1.0 - smoothstep(0.08, 0.45, r0)) * 0.5);
          // the old cities as faint ghosts under the beacons
          lights += w4 * (vec3(0.55, 1.0, 0.86) * beacon * pulse + vec3(0.5, 0.45, 0.8) * lace * smoothstep(0.45, 0.8, cityN) * 0.06);
        }
        // each society lights itself in its own colour, keeping the brightness of the age's style
        float lum = dot(lights, vec3(0.2126, 0.7152, 0.0722));
        lights = mix(lights, uCulture * lum * 1.6, uCultureMix) * uGlow;
        // blackouts: whole regions go dark, the rest stutter
        float patchN = snoise(q * 1.25 + 7.0) * 0.5 + 0.5;
        float dark = smoothstep(1.0 - uDim, 1.0 - uDim + 0.18, patchN) * step(0.001, uDim);
        float stutter = 1.0 - uDim * 0.35 * uFlicker * (0.5 + 0.5 * sin(uTime * 9.0 + cell * 50.0));
        lit += lights * (1.0 - dark) * stutter * night * on;
        // a soft limb glow on the day side, not a stroke
        float rim = pow(1.0 - max(dot(N, vView), 0.0), 4.0);
        vec3 atm = uStyle == 2.0 ? vec3(0.35,0.6,1.0) : (uStyle == 1.0 ? vec3(0.9,0.55,0.4) : base);
        float thick = smoothstep(0.03, 0.45, tf);
        atm = mix(atm, vec3(0.38, 0.64, 1.0), thick);
        lit += atm * rim * day * mix(uStyle == 0.0 && uHaze == 0.0 ? 0.1 : 0.35, 0.6, thick);
        // a thick new sky scatters blue light across the whole day side
        lit += vec3(0.16, 0.28, 0.55) * pow(1.0 - max(dot(N, vView), 0.0), 1.6) * day * thick * 0.35;
        gl_FragColor = vec4(lit, 1.0);
      }`,
  });
}

/** Additive halo shell around a planet. */
export function atmosphereMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uSun: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position,1.0); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uSun; varying vec3 vN; varying vec3 vV;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        // back faces: brightest just outside the limb, fading to nothing at the shell's edge
        float a = abs(dot(vN, vV));
        float glow = smoothstep(0.0, 0.32, a) * (1.0 - smoothstep(0.32, 0.6, a) * 0.6);
        float day = smoothstep(-0.3, 0.5, dot(vN, uSun));
        gl_FragColor = vec4(uColor * glow * glow * (0.08 + 0.55 * day), 1.0);
      }`,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}
