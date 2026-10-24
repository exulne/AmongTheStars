// Procedural textures and the shared point shader. Nothing is loaded from the
// network: every glow, flare and nebula is drawn into a canvas at startup.

import * as THREE from 'three';
import { hash01 } from '../sim/rng.ts';

function canvasTex(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round glow, white, alpha falloff. */
export const glowTex = canvasTex(128, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.25)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});

/** Bright star with diffraction spikes. */
export const flareTex = canvasTex(256, (c, s) => {
  const m = s / 2;
  const g = c.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.04, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.08)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.015)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
  // faint hairline spikes that die off well before the edge
  c.globalCompositeOperation = 'lighter';
  for (const rot of [0, Math.PI / 2]) {
    c.save();
    c.translate(m, m);
    c.rotate(rot);
    const lg = c.createLinearGradient(-m, 0, m, 0);
    lg.addColorStop(0.15, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    lg.addColorStop(0.85, 'rgba(255,255,255,0)');
    c.fillStyle = lg;
    c.fillRect(-m, -0.5, s, 1);
    c.restore();
  }
});

/** Wispy nebula cloud; seed varies the shape. */
export function nebulaTex(seed: number, rgb: [number, number, number]): THREE.CanvasTexture {
  return canvasTex(256, (c, s) => {
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 70; i++) {
      const r = hash01(seed, i, 1);
      const ang = hash01(seed, i, 2) * Math.PI * 2;
      const rad = Math.pow(hash01(seed, i, 3), 0.7) * s * 0.3;
      const x = s / 2 + Math.cos(ang) * rad, y = s / 2 + Math.sin(ang) * rad * 0.7;
      const R = s * (0.06 + 0.16 * r);
      const g = c.createRadialGradient(x, y, 0, x, y, R);
      const a = 0.05 + 0.08 * hash01(seed, i, 4);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
  });
}

/** Tiny galaxy sprite for the deep-universe background. */
export function galaxySpriteTex(seed: number): THREE.CanvasTexture {
  return canvasTex(128, (c, s) => {
    const m = s / 2;
    c.globalCompositeOperation = 'lighter';
    const elliptical = hash01(seed, 9) < 0.35;
    const arms = 2 + Math.floor(hash01(seed, 8) * 2);
    for (let i = 0; i < 900; i++) {
      const r = Math.pow(hash01(seed, i, 1), 1.8) * m * 0.9;
      let th = hash01(seed, i, 2) * Math.PI * 2;
      if (!elliptical) th = Math.floor(hash01(seed, i, 5) * arms) * ((Math.PI * 2) / arms) + Math.log(1 + r) * 1.6 + (hash01(seed, i, 3) - 0.5) * 0.7;
      const x = m + Math.cos(th) * r, y = m + Math.sin(th) * r * (elliptical ? 0.7 : 1);
      const warm = r < m * 0.2 || elliptical;
      c.fillStyle = warm ? 'rgba(255,214,160,0.18)' : 'rgba(170,200,255,0.16)';
      const z = 0.6 + hash01(seed, i, 4) * 1.4;
      c.fillRect(x, y, z, z);
    }
    const g = c.createRadialGradient(m, m, 0, m, m, m * 0.25);
    g.addColorStop(0, 'rgba(255,230,190,0.7)');
    g.addColorStop(1, 'rgba(255,230,190,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  });
}

/**
 * Shared point material: per-vertex color and size, soft round falloff,
 * additive. `sizeScale` lets one geometry serve many zoom levels.
 */
export function pointsMaterial(opts: { sizeScale?: number; attenuate?: boolean; opacity?: number; blending?: THREE.Blending; minPx?: number; maxPx?: number } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: opts.sizeScale ?? 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uOpacity: { value: opts.opacity ?? 1 },
      uMinPx: { value: opts.minPx ?? 0.8 },
      uMaxPx: { value: opts.maxPx ?? 256 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vFade;
      uniform float uScale, uPixelRatio, uMinPx, uMaxPx;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = ${opts.attenuate === false ? 'size * uScale' : 'size * uScale * (300.0 / -mv.z)'};
        vFade = clamp(px / uMinPx, 0.0, 1.0);
        gl_PointSize = clamp(px, uMinPx, uMaxPx) * uPixelRatio;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vFade;
      uniform float uOpacity;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float core = exp(-r * r * 9.0);
        float halo = exp(-r * 3.2) * 0.35;
        gl_FragColor = vec4(vColor * (core + halo), (core + halo) * uOpacity * vFade);
      }`,
    transparent: true,
    depthWrite: false,
    blending: opts.blending ?? THREE.AdditiveBlending,
  });
}

/** Colour of a star from its spectral class. */
export function specColor(spec: string): THREE.Color {
  const t: Record<string, number> = { O: 0x9bb0ff, B: 0xaabfff, A: 0xcad7ff, F: 0xf8f7ff, G: 0xfff4ea, K: 0xffd2a1, M: 0xffb56c };
  return new THREE.Color(t[spec[0]] ?? 0xffffff);
}

export const STAGE_COLORS = [0x56606e, 0x6f9bd8, 0x79c3e6, 0x8fe0c8, 0xd8e6a0, 0xf3d27a, 0xf6a35c, 0xff6fa8, 0x4b4440, 0xa33b2f];
export const STAGE_CSS = STAGE_COLORS.map((c) => '#' + c.toString(16).padStart(6, '0'));
