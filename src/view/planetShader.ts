// Procedural planet surface: noise-driven terrain per body kind (craters,
// ridges, dunes, coasts, bands), bump-lit relief, domain-warped weather, a day
// side lit in linear light (so it never clips), sunset-tinted terminator and
// limb scattering, and night lights that grow out of the sim's own settlements
// as networks of cores, suburbs and the roads between them.

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
float fbm4(vec3 p){float f=0.0,a=0.5;for(int i=0;i<4;i++){f+=a*snoise(p);p*=2.07;a*=0.5;}return f;}
// sharp crests: mountain chains, canyons, ice cracks, roads
float ridged(vec3 p){float f=0.0,a=0.5;for(int i=0;i<4;i++){float r=1.0-abs(snoise(p));f+=a*r*r;p*=2.11;a*=0.5;}return f;}
vec3 hash33(vec3 p){p=fract(p*vec3(0.1031,0.1030,0.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
// one crater per cell at most: a bowl, a raised rim, bright ejecta; .x height, .y albedo
vec2 crater(vec3 x, float keep){
  vec3 i=floor(x); vec3 f=fract(x); vec3 r=hash33(i);
  float rad=0.1+0.2*r.x;
  float d=length(f-(0.3+0.4*r))/rad;
  float on=step(1.0-keep, r.y);
  float bowl=d<1.0?(d*d-1.0):0.0;
  float rim=exp(-(d-1.0)*(d-1.0)*14.0);
  float ejecta=exp(-max(d-1.0,0.0)*2.5)*step(1.0,d);
  return on*vec2(bowl*0.7+rim*0.45, rim*0.12+ejecta*0.08-(d<1.0?0.1:0.0));
}
`;

// kind → style id used in the shader
const STYLE: Record<BodyKind, number> = {
  rocky: 0, superearth: 0, moon: 0, asteroid: 0, dwarf: 4, desert: 1, ocean: 2, lava: 3, ice: 4, gas: 5, icegiant: 6, habitat: 0,
};

/** Most settlements a world's night lights grow from (one per city marker the planet view draws). */
export const MAX_CITY_LIGHTS = 48;
/** Most scars (craters, lava fields, impact scars) drawn on one world. */
export const MAX_SCARS_DRAWN = 16;

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
      // the settlements themselves: unit directions in the body's frame, w = how big each one is (0..1)
      uCities: { value: Array.from({ length: MAX_CITY_LIGHTS }, () => new THREE.Vector4()) },
      uCityN: { value: 0 },
      // living worlds (geoLook.ts): the world's physical state now
      uIceN: { value: kind === 'desert' ? 0.82 : 0.81 }, // sine of the latitude where the northern cap begins
      uIceS: { value: kind === 'desert' ? 0.82 : 0.81 },
      uSeaShift: { value: 0 },    // sea level: coastlines creep inland (Earth)
      uCloud: { value: 1 },       // cloud cover against normal
      uDust: { value: 0 },        // 0..1 dust haze (a global dust storm)
      uAero: { value: 0 },        // 0..1 stratospheric haze (volcanic and impact winters)
      uAurora: { value: 0 },      // 0..1 polar lights on the night side
      uVolc: { value: 0 },        // 0..1 Io-like volcanism: sulfur plains, hot spots on the night side
      uSpot: { value: 1 },        // a giant's great storm, relative size (0: gone)
      uWhite: { value: 0 }, uWhiteLat: { value: 0.6 }, // Saturn's Great White Spot: strength, sine of its latitude
      uLakes: { value: 0 }, uSeason: { value: 0 },     // Titan's polar lakes; +1 northern summer
      uScars: { value: Array.from({ length: MAX_SCARS_DRAWN }, () => new THREE.Vector4()) }, // direction, angular radius
      uScarK: { value: Array.from({ length: MAX_SCARS_DRAWN }, () => new THREE.Vector2()) }, // kind (0 crater, 1 lava, 2 dark scar), strength
      uScarN: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vNormal; varying vec3 vView; varying vec3 vWorld; varying float vR;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vPos = position;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vWorld = wp.xyz;
        vR = length(mat3(modelMatrix) * position);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uSun, uCulture; uniform float uStyle, uSeed, uLights, uGreen, uTime, uDetail, uHaze, uTerra, uEpoch, uDim, uFlicker, uCultureMix, uGlow;
      uniform vec4 uCities[${MAX_CITY_LIGHTS}]; uniform int uCityN;
      uniform float uIceN, uIceS, uSeaShift, uCloud, uDust, uAero, uAurora, uVolc, uSpot, uWhite, uWhiteLat, uLakes, uSeason;
      uniform vec4 uScars[${MAX_SCARS_DRAWN}]; uniform vec2 uScarK[${MAX_SCARS_DRAWN}]; uniform int uScarN;
      varying vec3 vPos; varying vec3 vNormal; varying vec3 vView; varying vec3 vWorld; varying float vR;
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      // tilt the normal by the screen-space slope of a height field (world units)
      vec3 bumpN(vec3 N, float h){
        vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
        float dhx = dFdx(h), dhy = dFdy(h);
        vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
        float det = dot(dpx, r1);
        vec3 g = sign(det) * (dhx * r1 + dhy * r2);
        return normalize(abs(det) * N - g);
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 p = normalize(vPos);
        vec3 q = p * 2.2 + uSeed;
        float n = fbm(q * uDetail);
        float lat = p.y;
        vec3 base = uColor;
        vec3 col;
        float spec = 0.0, h = 0.0, land = 1.0;
        vec3 emit = vec3(0.0);
        // fine grain that fades out before it can shimmer
        float grainF = 9.0 * uDetail;
        float aa = 1.0 - smoothstep(0.25, 0.9, (fwidth(p.x) + fwidth(p.y) + fwidth(p.z)) * grainF * 2.0);
        float grain = snoise(q * grainF) * aa;
        if (uStyle < 0.5) {            // rocky: maria, highlands, craters on craters
          float m = smoothstep(-0.12, 0.22, n);
          col = mix(base * 0.42, base * 1.05, m);
          vec2 c1 = crater(q * 3.0 * uDetail, 0.55), c2 = crater(q * 9.0 * uDetail + 4.0, 0.5) * aa, c3 = crater(q * 23.0 * uDetail + 9.0, 0.45) * aa;
          h = n * 0.5 + c1.x * 0.9 + c2.x * 0.45 + c3.x * 0.2 + grain * 0.06;
          col *= 1.0 + c1.y + c2.y * 0.7 + c3.y * 0.5 + grain * 0.06;
          if (uVolc > 0.0) {
            // Io: sulfur plains in yellows and whites, red ring deposits, black paterae; its lava renews the surface, so no craters
            float sulf = fbm4(q * 2.3 + 3.0), ring = fbm4(q * 5.0 + 1.0);
            vec3 io = mix(vec3(0.62, 0.55, 0.22), vec3(0.72, 0.68, 0.48), smoothstep(-0.2, 0.3, sulf));
            io = mix(io, vec3(0.5, 0.2, 0.08), smoothstep(0.25, 0.45, ring) * 0.6);
            vec3 cell = hash33(floor(q * 6.0));
            float pat = smoothstep(0.16, 0.08, length(fract(q * 6.0) - 0.5 - (cell - 0.5) * 0.5)) * step(0.55, cell.x);
            io = mix(io, vec3(0.03, 0.025, 0.02), pat);
            col = mix(col, io, uVolc);
            h = mix(h, n * 0.2 + grain * 0.03, uVolc);
            // the hot ones glow on the night side
            emit += vec3(1.0, 0.35, 0.08) * pat * step(0.8, cell.y) * uVolc * 0.6;
          }
        } else if (uStyle < 1.5) {     // desert (Mars-like): dark basalt plains, canyons, dunes, polar ice
          float m = smoothstep(-0.25, 0.3, n);
          float albedo = smoothstep(-0.1, 0.25, fbm4(q * 1.3 + 5.0));
          col = mix(base * 0.42, base * 1.0, m) * mix(0.62, 1.05, albedo);
          float canyon = smoothstep(0.82, 0.97, ridged(q * 1.1 + 2.0)) * smoothstep(0.5, 0.1, abs(lat));
          vec2 c1 = crater(q * 4.0 * uDetail, 0.45), c2 = crater(q * 12.0 * uDetail + 2.0, 0.4) * aa;
          float dunes = sin(dot(q, vec3(31.0, 7.0, 13.0)) + snoise(q * 4.0) * 3.0) * aa * smoothstep(0.1, -0.3, n);
          h = n * 0.6 - canyon * 0.9 + c1.x * 0.6 + c2.x * 0.3 + dunes * 0.04 + grain * 0.05;
          col *= (1.0 - canyon * 0.35) * (1.0 + c1.y + c2.y * 0.6 + grain * 0.07);
          // the polar caps follow the seasons (CO₂ frost over each winter pole) and shrink as the planet warms; frost lingers in craters
          float capLo = lat > 0.0 ? uIceN : uIceS;
          float cap = smoothstep(capLo, capLo + 0.04, abs(lat) + n * 0.04 + c1.x * 0.02);
          col = mix(col, vec3(0.74, 0.72, 0.7), cap);
        } else if (uStyle < 2.5) {     // ocean world / Earth: coasts, mountains, forest, desert, ice
          land = smoothstep(0.02 + uSeaShift, 0.06 + uSeaShift, n);
          float mtn = ridged(q * 2.4 + 3.0) * smoothstep(0.06, 0.3, n);
          float depth = clamp(-n * 2.5, 0.0, 1.0);
          vec3 sea = mix(mix(vec3(0.012, 0.06, 0.09), base * 0.35, 0.3), vec3(0.004, 0.014, 0.05), smoothstep(0.0, 0.6, depth));
          sea = mix(vec3(0.03, 0.12, 0.14), sea, smoothstep(0.0, 0.08, depth)); // shallow shelves
          float wetN = fbm4(q * 1.7 + 11.0) - abs(lat) * 0.35;
          vec3 forest = vec3(0.03, 0.075, 0.03), grass = vec3(0.09, 0.13, 0.05), sand = vec3(0.34, 0.26, 0.15), rock = vec3(0.17, 0.14, 0.12);
          vec3 ground = mix(sand, mix(grass, forest, smoothstep(0.0, 0.3, wetN)), smoothstep(-0.25, 0.0, wetN));
          ground = mix(ground, rock, smoothstep(0.35, 0.75, mtn));
          ground *= 0.9 + grain * 0.12;
          col = mix(sea, ground, land);
          h = land * (n * 0.4 + mtn * 0.8 + grain * 0.05);
          spec = 1.0 - land;
          float iceLo = lat > 0.0 ? uIceN : uIceS;
          col = mix(col, vec3(0.62, 0.65, 0.68), smoothstep(iceLo - 0.05, iceLo + 0.05, abs(lat) + n * 0.1 + mtn * 0.05));
        } else if (uStyle < 3.5) {     // lava: dark crust over glowing rivers
          float c = abs(snoise(q * 3.0)) + 0.35 * abs(snoise(q * 9.0 + 2.0)) * aa;
          col = mix(base * 0.18, vec3(0.05, 0.035, 0.03), smoothstep(0.0, 0.2, c));
          float hot = smoothstep(0.14, 0.0, c);
          emit = vec3(1.0, 0.32, 0.06) * hot * 1.4 + vec3(1.0, 0.6, 0.2) * smoothstep(0.05, 0.0, c) * 0.8;
          h = smoothstep(0.0, 0.3, c) * 0.6 + grain * 0.05;
        } else if (uStyle < 4.5) {     // ice: bright plains crossed by stained cracks
          float m = smoothstep(-0.3, 0.4, n);
          col = mix(base * 0.7, vec3(0.74, 0.76, 0.78), m);
          float cracks = smoothstep(0.86, 0.97, ridged(q * 2.2 + 1.0)) + 0.6 * smoothstep(0.9, 0.98, ridged(q * 6.0 + 8.0)) * aa;
          col = mix(col, vec3(0.42, 0.26, 0.17), clamp(cracks, 0.0, 1.0) * 0.75);
          vec2 c1 = crater(q * 5.0 * uDetail, 0.25);
          h = n * 0.3 + cracks * 0.35 + c1.x * 0.4 + grain * 0.04;
          col *= 0.94 + grain * 0.06 + c1.y * 0.5;
          spec = 0.25;
        } else {                       // gas / ice giants: turbulent belts and zones, storms
          float giant = uStyle < 5.5 ? 1.0 : 0.0;
          vec3 wq = q + vec3(fbm4(q * 1.5 + 2.0), 0.0, fbm4(q * 1.5 + 6.0)) * 0.35;
          float turb = fbm4(vec3(wq.x * 3.0, lat * 12.0, wq.z * 3.0) + uTime * 0.002);
          float bands = sin(lat * mix(9.0, 22.0, giant) + n * 2.0 + turb * 1.6);
          float fine = sin(lat * mix(30.0, 70.0, giant) + turb * 3.0) * aa;
          col = mix(base * 0.62, base * 1.08, 0.5 + 0.5 * bands);
          col *= 0.94 + 0.06 * fine;
          col = mix(col, col * vec3(1.06, 0.92, 0.8), smoothstep(0.3, 0.9, bands) * giant * 0.5);
          // one great storm per giant, and a scatter of small white ovals
          float sp = max(uSpot, 0.001);
          float storm = (1.0 - smoothstep(0.06 * sp, 0.1 * sp, length(vec2((atan(p.z, p.x) * 0.25 - 0.4) / mix(1.0, 1.25, step(1.0, sp)), (lat + 0.3) * 0.7)))) * step(0.01, uSpot);
          col = mix(col, base * vec3(1.1, 0.68, 0.52), storm * (giant > 0.5 ? 0.8 : 0.4));
          // a great white spot: a storm erupting from below, smeared along its band by the winds
          float wb = exp(-pow((lat - uWhiteLat) / 0.05, 2.0)) * smoothstep(0.1, 0.6, fbm4(vec3(wq.x * 4.0, lat * 30.0, wq.z * 4.0) + 5.0) + 0.3);
          col = mix(col, vec3(0.86, 0.84, 0.78), wb * uWhite);
          vec3 ov = q * vec3(5.0, 14.0, 5.0);
          float oval = smoothstep(0.45, 0.2, length(fract(ov) - 0.5)) * step(0.88, hash33(floor(ov)).x);
          col = mix(col, vec3(0.82, 0.8, 0.76), oval * 0.5);
          h = turb * 0.1;
        }
        // thick haze hides the terrain, leaving soft banding
        col = mix(col, base * (0.78 + 0.1 * n + 0.06 * sin(lat * 6.0)), uHaze * 0.85);
        h *= 1.0 - uHaze * 0.9;
        if (uLakes > 0.0) {
          // Titan: methane seas near the poles (most in the north: Kraken, Ligeia, Punga Mare), seen through the haze; summer clouds
          float north = step(0.0, lat);
          float lakes = smoothstep(0.74, 0.86, abs(lat) + fbm4(q * 3.0 + 4.0) * 0.18) * mix(0.35, 1.0, north);
          col = mix(col, vec3(0.06, 0.055, 0.05), lakes * uLakes * 0.75);
          spec = max(spec, lakes * uLakes * 0.6);
          float summer = smoothstep(0.4, 0.9, lat * uSeason) * smoothstep(0.1, 0.5, fbm4(q * 4.0 + uTime * 0.003));
          col = mix(col, vec3(0.9, 0.82, 0.62), summer * 0.35 * uLakes);
        }
        // a dust storm: the surface vanishes under a warm, flat haze
        if (uDust > 0.0) {
          vec3 dustCol = vec3(0.6, 0.38, 0.22) * (0.9 + 0.2 * fbm4(q * 2.0 + uTime * 0.01));
          col = mix(col, dustCol, uDust * 0.88);
          h *= 1.0 - uDust * 0.85;
        }
        // scars: fresh craters (dark floors, bright rims and rays), lava fields (glowing while fresh), dark impact scars on giants
        for (int i = 0; i < ${MAX_SCARS_DRAWN}; i++) {
          if (i >= uScarN) break;
          vec4 sc = uScars[i]; vec2 sk = uScarK[i];
          float d = acos(clamp(dot(p, sc.xyz), -1.0, 1.0)) / max(sc.w, 1e-4);
          if (d > 3.0) continue;
          float amp = sk.y;
          if (sk.x < 0.5) {
            float rays = pow(max(0.0, snoise(vec3(atan(dot(p, cross(sc.xyz, vec3(0.0, 1.0, 0.0))), dot(p, vec3(0.0, 1.0, 0.0))) * 9.0, d, sc.w * 50.0))), 2.0);
            float floor_ = 1.0 - smoothstep(0.7, 1.0, d), rim = exp(-pow((d - 1.0) * 5.0, 2.0)), ejecta = (1.0 - smoothstep(1.0, 3.0, d)) * step(1.0, d) * (0.4 + rays);
            col = mix(col, col * 0.45, floor_ * amp);
            col = mix(col, min(col * 1.9 + 0.06, vec3(0.85)), (rim * 0.7 + ejecta * 0.35) * amp);
            h += (rim * 0.5 - floor_ * 0.4) * amp;
          } else if (sk.x < 1.5) {
            float flow = (1.0 - smoothstep(0.6, 1.0, d + fbm4(p * 40.0 + sc.xyz * 9.0) * 0.35));
            col = mix(col, vec3(0.05, 0.035, 0.03), flow * min(1.0, amp * 1.5));
            float cracks = smoothstep(0.7, 0.95, 1.0 - abs(snoise(p * 90.0 + sc.xyz * 7.0)));
            emit += vec3(1.0, 0.3, 0.05) * flow * (0.25 + 0.75 * cracks) * smoothstep(0.3, 1.0, amp) * 0.7;
          } else {
            float blot = 1.0 - smoothstep(0.55, 1.0, d + snoise(p * 25.0 + sc.xyz * 3.0) * 0.2);
            float halo = exp(-pow((d - 1.2) * 3.0, 2.0)) * 0.5;
            col = mix(col, vec3(0.09, 0.06, 0.05), (blot + halo) * amp * 0.85);
          }
        }
        // terraforming, on solid worlds only: seas fill the low ground, then plants, then weather
        float tf = (uStyle < 1.5 || (uStyle > 3.5 && uStyle < 4.5)) ? uTerra : 0.0;
        float wet = 0.0;
        if (tf > 0.0) {
          float seaLevel = mix(-0.75, 0.06, smoothstep(0.2, 1.0, tf));
          wet = smoothstep(seaLevel + 0.025, seaLevel - 0.025, n) * smoothstep(0.18, 0.32, tf);
          vec3 water = mix(vec3(0.03, 0.12, 0.16), vec3(0.006, 0.03, 0.08), clamp((seaLevel - n) * 3.0, 0.0, 1.0));
          // wet soil darkens and browns, then plants spread up from the coasts
          col = mix(col, vec3(0.3, 0.22, 0.15) * (0.8 + 0.5 * n), smoothstep(0.25, 0.9, tf) * 0.65);
          float veg = smoothstep(0.3, 0.9, tf) * smoothstep(seaLevel - 0.01, seaLevel + 0.05, n) * (1.0 - smoothstep(0.6, 0.85, abs(lat))) * (1.0 - smoothstep(0.4, 0.62, n));
          col = mix(col, vec3(0.06, 0.12, 0.04) * (0.8 + 0.4 * snoise(q * 5.0)), veg * 0.85);
          col = mix(col, water, wet);
          spec = max(spec, wet);
          h *= 1.0 - wet;
          land = min(land, 1.0 - wet);
        }

        // weather: domain-warped cloud decks with storm tracks, on Earth and on terraformed worlds
        float cloudAmt = uStyle > 1.5 && uStyle < 2.5 ? 1.0 : smoothstep(0.3, 0.85, tf);
        float cl = 0.0;
        if (cloudAmt > 0.0) {
          vec3 cq = q * 1.25 + vec3(uTime * 0.006, 0.0, uTime * 0.002);
          vec3 w = vec3(fbm4(cq * 1.6 + 3.1), fbm4(cq * 1.6 + 7.7), fbm4(cq * 1.6 + 1.3));
          float c0 = fbm(cq + w * 0.9);
          float tracks = 0.16 * cos(lat * 9.5) + 0.08 * cos(lat * 3.0); // tropics, storm belts, dry subtropics
          cl = smoothstep(0.02, 0.5, c0 + tracks - 0.06);
          cl *= 0.7 + 0.3 * smoothstep(-0.4, 0.5, snoise(cq * 9.0 + w * 2.0) * aa + 0.3);
          cl *= cloudAmt * 0.92 * uCloud;
        }

        vec3 Ng = normalize(vNormal);
        float mu0 = max(dot(Ng, vView), 0.0);
        vec3 N = bumpN(Ng, h * vR * 0.004 * (0.6 + 0.4 * uDetail) * smoothstep(0.02, 0.3, mu0));
        float dG = dot(Ng, uSun);
        float lightOn = smoothstep(-0.06, 0.12, dG);
        float diff = max(dot(N, uSun), 0.0) * lightOn;
        float mu = max(dot(Ng, vView), 0.0);
        // air reddens the light near the terminator on worlds that have it
        float airy = uStyle > 0.5 && uStyle < 2.5 ? 1.0 : uStyle > 4.5 ? 0.7 : 0.0;
        airy = max(max(airy, uHaze), smoothstep(0.03, 0.45, tf));
        vec3 sunCol = mix(vec3(1.0), mix(vec3(1.0, 0.5, 0.28), vec3(1.0), smoothstep(0.02, 0.38, dG)), airy * (uStyle > 1.5 && uStyle < 2.5 ? 1.0 : 0.6));
        // a volcanic or impact winter: the sunlight comes through dimmer and redder
        sunCol *= mix(vec3(1.0), vec3(0.95, 0.74, 0.55), uAero) * (1.0 - 0.3 * uAero);
        // linear light: a sunlit white surface lands near 0.8, so the tone curve keeps its colour
        vec3 lit = col * sunCol * (0.008 + 0.8 * diff);
        vec3 H = normalize(uSun + vView);
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, vView), 0.0), 5.0);
        float glint = pow(max(dot(N, H), 0.0), 140.0) * 0.9 + pow(max(dot(N, H), 0.0), 14.0) * 0.05;
        lit += vec3(1.0, 0.93, 0.82) * sunCol * glint * spec * (0.5 + fres) * lightOn;
        // clouds over the top, lit by the smooth sphere, a little brighter at the edge of the day
        vec3 cloudLit = vec3(0.82) * sunCol * (0.01 + 0.82 * max(dG, 0.0) * lightOn + 0.06 * lightOn * (1.0 - mu));
        lit = mix(lit, cloudLit, cl);
        // the haze itself: a pale veil over the day side
        lit = mix(lit, vec3(0.55, 0.5, 0.45) * sunCol * (0.02 + 0.6 * max(dG, 0.0)) * lightOn, uAero * 0.4);

        // night lights: they grow from the settlements the sim placed (cores, suburbs, roads between neighbours)
        float night = smoothstep(0.04, -0.16, dG);
        float settled = 0.0;
        for (int i = 0; i < ${MAX_CITY_LIGHTS}; i++) {
          if (i >= uCityN) break;
          vec4 cty = uCities[i];
          float a2 = max(0.0, 2.0 - 2.0 * dot(p, cty.xyz));
          float s = 0.0016 + 0.012 * cty.w * (0.4 + uLights);
          settled += (0.35 + 0.65 * cty.w) * exp(-a2 / s);
        }
        float cityN = snoise(q * 6.0) * 0.5 + 0.5 + snoise(q * 24.0) * 0.25 * aa;
        // with no settlement list (the small spheres of the system view) fall back to a noise field; a crowded world fills in either way
        float sprawl = smoothstep(1.0 - uLights * 0.3, 1.25 - uLights * 0.3, cityN + 0.3);
        float region = uCityN > 0 ? clamp(settled * 1.2, 0.0, 1.0) : sprawl;
        region = max(region, sprawl * 0.45 * smoothstep(0.4, 0.9, uLights));
        // lights stand on land (and never in a new sea)
        float landMask = mix(1.0, land, step(1.5, uStyle) * step(uStyle, 2.5)) * (1.0 - wet);
        region *= landMask;
        float on = smoothstep(0.0, 0.05, uLights);
        // the network: bright cores, suburbs of scattered towns, the roads that join them
        float roads = pow(1.0 - abs(snoise(q * 5.5 + 1.7)), 16.0) + 0.55 * pow(1.0 - abs(snoise(q * 15.0 + 4.1)), 22.0) * aa;
        float cores = smoothstep(0.55, 1.0, region);
        float suburb = smoothstep(0.08, 0.55, region);
        float towns = smoothstep(0.62, 0.95, snoise(q * 30.0 + 2.0) * 0.5 + 0.5) * aa;
        float net = cores * (0.5 + 0.5 * towns) + suburb * (roads * 0.8 + towns * 0.35) * (1.0 - cores * 0.5);
        float cell = fract(sin(dot(floor(p * 60.0), vec3(12.9898,78.233,37.719))) * 43758.5453);
        float e = clamp(uEpoch, 0.0, 4.0);
        vec3 lights = vec3(0.0);
        // 0: sodium-orange sprawl along the roads
        float w0 = max(0.0, 1.0 - abs(e));
        if (w0 > 0.0) lights += w0 * vec3(1.0, 0.62, 0.3) * net;
        // 1: white LED street grids spreading out of the old cores
        float w1 = max(0.0, 1.0 - abs(e - 1.0));
        vec2 sp = vec2(atan(p.z, p.x) / 6.2832, asin(clamp(p.y, -1.0, 1.0)) / 3.1416);
        vec2 gf = abs(fract(sp * vec2(220.0, 110.0)) - 0.5);
        float grid = (1.0 - smoothstep(0.0, 0.14, min(gf.x, gf.y))) * aa;
        if (w1 > 0.0) lights += w1 * vec3(0.86, 0.92, 1.0) * (net * 0.8 + smoothstep(0.1, 0.6, region) * grid * 0.5);
        // 2: a few blue arcology clusters, very bright, dark country between, linked by maglev lines
        float w2 = max(0.0, 1.0 - abs(e - 2.0));
        float arc = smoothstep(0.55, 1.0, region) * (0.55 + 0.45 * smoothstep(0.6, 1.0, cell));
        if (w2 > 0.0) lights += w2 * (vec3(0.38, 0.62, 1.0) * arc * 1.1 + vec3(0.85, 0.95, 1.0) * smoothstep(0.85, 1.0, region) * 0.8 + vec3(0.5, 0.75, 1.0) * roads * smoothstep(0.02, 0.3, region) * 0.35);
        // 3: lace: grown cities as fine filaments over the whole land
        float w3 = max(0.0, 1.0 - abs(e - 3.0));
        float lace = pow(1.0 - abs(snoise(q * 7.0)), 14.0) + 0.7 * pow(1.0 - abs(snoise(q * 19.0 + 3.0)), 20.0) * aa;
        if (w3 > 0.0) lights += w3 * vec3(0.78, 0.7, 1.0) * (lace * suburb * 0.8 + cores * 0.35);
        // 4: the bodies are gone; a few beacons pulse on a dark world
        float w4 = max(0.0, 1.0 - abs(e - 4.0));
        if (w4 > 0.0) {
          vec3 bp = p * 20.0;
          float bh = fract(sin(dot(floor(bp), vec3(41.3, 289.1, 17.7))) * 24634.63);
          float r0 = length(fract(bp) - 0.5);
          float pulse = 0.6 + 0.4 * sin(uTime * 1.3 * uFlicker + bh * 40.0);
          float beacon = step(0.92, bh) * ((1.0 - smoothstep(0.05, 0.12, r0)) * 2.0 + (1.0 - smoothstep(0.08, 0.45, r0)) * 0.3);
          // the old cities as faint ghosts under the beacons
          lights += w4 * (vec3(0.55, 1.0, 0.86) * beacon * pulse + vec3(0.5, 0.45, 0.8) * lace * suburb * 0.06);
        }
        // each society lights itself in its own colour, keeping the brightness of the age's style
        float lum = dot(lights, vec3(0.2126, 0.7152, 0.0722));
        lights = mix(lights, uCulture * lum * 1.6, uCultureMix) * uGlow;
        // blackouts: whole regions go dark, the rest stutter
        float patchN = snoise(q * 1.25 + 7.0) * 0.5 + 0.5;
        float dark = smoothstep(1.0 - uDim, 1.0 - uDim + 0.18, patchN) * step(0.001, uDim);
        float stutter = 1.0 - uDim * 0.35 * uFlicker * (0.5 + 0.5 * sin(uTime * 9.0 + cell * 50.0));
        // cloud decks soften and dim the lights beneath them
        lit += lights * 0.85 * (1.0 - dark) * stutter * night * on * (1.0 - cl * 0.7);
        lit += emit * (1.0 - cl);
        // aurora: ovals around the magnetic poles, on the night side
        if (uAurora > 0.0) {
          float giantA = uStyle > 4.5 ? 1.0 : 0.0;
          float ring = exp(-pow((abs(lat) - mix(0.91, 0.96, giantA)) / 0.035, 2.0));
          float curtain = 0.55 + 0.45 * snoise(vec3(atan(p.z, p.x) * 6.0, lat * 20.0, uTime * 0.25 * uFlicker));
          lit += mix(vec3(0.18, 0.95, 0.45), vec3(0.65, 0.4, 1.0), giantA) * ring * curtain * uAurora * 0.32 * (0.25 + 0.75 * night);
        }

        // limb: sunlit air scatters blue (or the world's own tint) and goes rose at the terminator
        float rim = pow(1.0 - mu, 3.0);
        vec3 atm = uStyle == 2.0 ? vec3(0.3, 0.55, 1.0) : (uStyle == 1.0 ? vec3(0.85, 0.55, 0.42) : base);
        atm = mix(atm, vec3(0.9, 0.55, 0.3), uDust);
        atm = mix(atm, mix(base, vec3(0.55, 0.68, 0.9), 0.4), uHaze); // a hazy moon's high haze scatters blue at the limb
        float thick = smoothstep(0.03, 0.45, tf);
        atm = mix(atm, vec3(0.32, 0.58, 1.0), thick);
        float dayAir = smoothstep(-0.25, 0.35, dG);
        vec3 atmLit = mix(vec3(1.0, 0.45, 0.25) * 0.8, atm, smoothstep(-0.05, 0.4, dG));
        float airAmt = uStyle == 2.0 ? 0.45 : uStyle == 1.0 ? 0.16 : uStyle > 4.5 ? 0.3 : (uHaze > 0.0 ? 0.32 : 0.0);
        airAmt = mix(airAmt, 0.5, thick);
        airAmt = max(airAmt, 0.4 * uDust + 0.25 * uAero);
        // aerial perspective: the far edge of the disc fades into its own sky
        lit = mix(lit, atmLit * dayAir * 0.55, rim * airAmt * 0.8);
        lit += atmLit * rim * dayAir * airAmt * 0.35;
        // a thick new sky scatters blue light across the whole day side
        lit += vec3(0.12, 0.22, 0.45) * pow(1.0 - mu, 1.6) * dayAir * thick * 0.25;
        gl_FragColor = vec4(lit, 1.0);
      }`,
  });
}

/** Draw up to MAX_SCARS_DRAWN scars: unit directions in the body's frame, angular radius (radians), kind and strength. */
export function setScars(mat: THREE.ShaderMaterial, scars: { x: number; y: number; z: number; rad: number; kind: number; amp: number }[]): void {
  const u = mat.uniforms;
  if (!u.uScars) return;
  const S = u.uScars.value as THREE.Vector4[], K = u.uScarK.value as THREE.Vector2[];
  const n = Math.min(scars.length, MAX_SCARS_DRAWN);
  for (let i = 0; i < n; i++) { const s = scars[i]; S[i].set(s.x, s.y, s.z, s.rad); K[i].set(s.kind, s.amp); }
  u.uScarN.value = n;
}

/** Point a planet's night lights at its settlements: unit directions in the body's frame, sizes 0..1. */
export function setCityLights(mat: THREE.ShaderMaterial, dirs: THREE.Vector3[], size: (i: number) => number): void {
  const u = mat.uniforms;
  if (!u.uCities) return;
  const arr = u.uCities.value as THREE.Vector4[];
  const n = Math.min(dirs.length, MAX_CITY_LIGHTS);
  for (let i = 0; i < n; i++) { const d = dirs[i]; arr[i].set(d.x, d.y, d.z, Math.min(1, Math.max(0, size(i)))); }
  u.uCityN.value = n;
}

/** Additive halo shell around a planet: a thin bright limb on the day side, fading into space. */
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
        // back faces: brightest just outside the limb, falling off fast into space
        float a = abs(dot(vN, vV));
        float glow = smoothstep(0.0, 0.3, a) * (1.0 - smoothstep(0.3, 0.62, a) * 0.7);
        float d = dot(vN, uSun);
        float day = smoothstep(-0.35, 0.45, d);
        // the twilight band glows warm
        vec3 c = mix(uColor, vec3(1.0, 0.5, 0.3) * max(max(uColor.r, uColor.g), uColor.b), smoothstep(0.25, 0.0, abs(d + 0.05)) * 0.5);
        gl_FragColor = vec4(c * glow * glow * glow * (0.04 + 0.5 * day), 1.0);
      }`,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}
