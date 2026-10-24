// A SpaceX-Starship-style vehicle built in code: stainless hull with weld rings
// and patchwork panels, black hex heat-shield tiles on the belly, forward and
// aft flaps, crew windows, and six Raptor bells. Nose along +Z, belly toward -Y.
// Real proportions: 9 m wide, 50 m tall, so radius 0.45 and length 5 here.

import * as THREE from 'three';
import { Rng } from '../sim/rng.ts';

export const STARSHIP_LEN = 5;
const R = 0.45;
const NOSE = 1.15;
const BODY = STARSHIP_LEN - NOSE;
const TAIL = -STARSHIP_LEN / 2;

/**
 * Hull skin for one lathe/cylinder piece. u wraps around the hull (u = 0 is the
 * belly), v runs along it. `pxPerUnitV` keeps hex tiles round on the stretched UVs.
 */
function hullTextures(w: number, h: number, lengthUnits: number, seed: number, ringEvery: number) {
  const r = new Rng(seed);
  const color = document.createElement('canvas'), rm = document.createElement('canvas'), bump = document.createElement('canvas');
  for (const c of [color, rm, bump]) { c.width = w; c.height = h; }
  const cc = color.getContext('2d')!, rc = rm.getContext('2d')!, bc = bump.getContext('2d')!;
  const pxU = w / (Math.PI * 2 * R), pxV = h / lengthUnits;

  // steel: rings of slightly different panels, brushed streaks, weld seams
  const ringPx = ringEvery * pxV;
  for (let y = 0; y < h; y += ringPx) {
    const panels = 6;
    for (let p = 0; p < panels; p++) {
      const x0 = ((p + (Math.floor(y / ringPx) % 2) * 0.5) / panels) * w;
      const tone = 178 + r.range(-14, 12);
      cc.fillStyle = `rgb(${tone},${tone + 3},${tone + 7})`;
      cc.fillRect(x0, y, w / panels + 1, ringPx + 1);
      cc.fillRect(x0 - w, y, w / panels + 1, ringPx + 1);
      const rough = 70 + r.range(-15, 25);
      rc.fillStyle = `rgb(0,${rough},255)`;
      rc.fillRect(x0, y, w / panels + 1, ringPx + 1);
      rc.fillRect(x0 - w, y, w / panels + 1, ringPx + 1);
      // vertical seam between panels
      cc.fillStyle = 'rgba(60,60,64,0.5)';
      cc.fillRect(x0, y, 1.5, ringPx);
    }
    // horizontal weld: dark line with a bright heat-tint fringe
    cc.fillStyle = 'rgba(70,64,58,0.8)'; cc.fillRect(0, y, w, 2);
    cc.fillStyle = 'rgba(210,190,150,0.25)'; cc.fillRect(0, y + 2, w, 2);
    bc.fillStyle = '#000'; bc.fillRect(0, y, w, 2);
  }
  bc.globalCompositeOperation = 'source-over';
  bc.fillStyle = '#808080';
  // brushed streaks
  cc.globalAlpha = 0.06;
  for (let i = 0; i < w * 0.6; i++) {
    const x = r.range(0, w), len = r.range(h * 0.05, h * 0.4), y = r.range(-len, h);
    cc.fillStyle = r.next() < 0.5 ? '#fff' : '#000';
    cc.fillRect(x, y, 1, len);
  }
  cc.globalAlpha = 1;

  // bump base: flat mid grey, seams were drawn dark above
  const bimg = bc.getImageData(0, 0, w, h);
  for (let i = 0; i < bimg.data.length; i += 4) if (bimg.data[i + 3] === 0) { bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = 128; bimg.data[i + 3] = 255; }
  bc.putImageData(bimg, 0, 0);

  // heat shield: hex tiles over the belly half (u in [0.75, 1] and [0, 0.25])
  const tile = 0.026;                    // hull units across a tile
  const sx = tile * pxU, sy = tile * pxV * 0.87;
  const edgeJitter = (row: number) => Math.sin(row * 0.7) * sx * 0.6;
  for (let row = -1, y = 0; y < h + sy; row++, y = row * sy) {
    const off = (row & 1) * sx * 0.5;
    for (let x = -sx + off; x < w + sx; x += sx) {
      const u = (x / w + 1) % 1;
      const inTiles = u < 0.25 + edgeJitter(row) / w || u > 0.75 - edgeJitter(row) / w;
      if (!inTiles) continue;
      const shade = 16 + r.range(-5, 9);
      hex(cc, x, y, sx * 0.47, sy * 0.62, `rgb(${shade},${shade + 1},${shade + 3})`, 'rgb(48,47,46)');
      hex(rc, x, y, sx * 0.47, sy * 0.62, `rgb(0,${200 + r.range(-20, 20)},0)`, 'rgb(0,220,0)');
      hex(bc, x, y, sx * 0.47, sy * 0.62, '#9a9a9a', '#3a3a3a');
    }
  }
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  };
  return { map: tex(color, true), rough: tex(rm, false), bump: tex(bump, false) };
}

function hex(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string, gap: string): void {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const px = x + Math.cos(a) * rx * 1.12, py = y + Math.sin(a) * ry * 1.12;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath();
  c.fillStyle = gap; c.fill();
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const px = x + Math.cos(a) * rx, py = y + Math.sin(a) * ry;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath();
  c.fillStyle = fill; c.fill();
}

function skin(w: number, h: number, len: number, seed: number, ring: number): THREE.MeshStandardMaterial {
  const t = hullTextures(w, h, len, seed, ring);
  return new THREE.MeshStandardMaterial({
    map: t.map, roughnessMap: t.rough, metalnessMap: t.rough, bumpMap: t.bump, bumpScale: 1.2,
    metalness: 0.85, roughness: 1, envMapIntensity: 1,
  });
}

/** Flap: steel on top, tiles underneath. Shape is drawn in the x (span) / y (chord) plane. */
function flap(shape: THREE.Shape, steel: THREE.Material, tiles: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 });
  const top = new THREE.Mesh(geo, steel);
  const bottom = new THREE.Mesh(geo, tiles);
  bottom.position.z = 0.022;     // extruded along +z, which becomes -y (down) after rotation
  g.add(top, bottom);
  g.rotation.x = Math.PI / 2;    // shape y → hull +Z, extrude depth → -Y
  return g;
}

export function buildStarship(root: THREE.Group): void {
  const bodyMat = skin(2048, 2048, BODY, 9, 0.2);
  const noseMat = skin(2048, 1024, NOSE * 1.25, 10, 0.2);

  // body: open cylinder, axis along Z, belly (u = 0) facing -Y
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, BODY, 96, 1, true), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.position.z = TAIL + BODY / 2;
  root.add(body);

  // nose: tangent ogive
  const rho = (R * R + NOSE * NOSE) / (2 * R);
  const prof: THREE.Vector2[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const d = (i / n) * NOSE;
    const r = Math.max(0.004, Math.sqrt(Math.max(0, rho * rho - d * d)) + R - rho);
    prof.push(new THREE.Vector2(r, d));
  }
  const nose = new THREE.Mesh(new THREE.LatheGeometry(prof, 96), noseMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = TAIL + BODY;
  root.add(nose);

  const steel = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 1, roughness: 0.3, envMapIntensity: 1.1 });
  const tiles = new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2826, metalness: 0.7, roughness: 0.45, side: THREE.DoubleSide });

  // aft flaps: big, swept leading edge
  const aft = new THREE.Shape();
  aft.moveTo(0, 0); aft.lineTo(0, 1.05); aft.lineTo(0.46, 0.72); aft.lineTo(0.5, 0.12); aft.closePath();
  // forward flaps: small, hugging the nose
  const fwd = new THREE.Shape();
  fwd.moveTo(0, 0); fwd.lineTo(0, 0.55); fwd.lineTo(0.26, 0.22); fwd.lineTo(0.27, 0.05); fwd.closePath();
  for (const s of [1, -1]) {
    const a = flap(aft, steel, tiles);
    a.scale.x = s;
    a.position.set(s * (R - 0.03), -0.06, TAIL + 0.08);
    a.rotation.z = s * -0.05;
    root.add(a);
    const f = flap(fwd, steel, tiles);
    f.scale.x = s;
    f.position.set(s * (R - 0.08), -0.05, TAIL + BODY + 0.02);
    f.rotation.y = s * -0.12;
    root.add(f);
    // hinge fairings
    const fair = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 12), steel);
    fair.rotation.x = Math.PI / 2;
    fair.position.set(s * (R - 0.01), -0.05, TAIL + 0.55);
    root.add(fair);
  }

  // crew windows on the leeward (top) side below the nose
  const glass = new THREE.MeshStandardMaterial({ color: 0x05080c, metalness: 0.9, roughness: 0.05, emissive: 0x1a3550, emissiveIntensity: 0.6, envMapIntensity: 1.5 });
  for (let row = 0; row < 2; row++) {
    for (let i = -3; i <= 3; i++) {
      const ang = Math.PI / 2 + i * 0.13;   // around the top
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 0.03), glass);
      win.position.set(Math.cos(ang) * (R + 0.002), Math.sin(ang) * (R + 0.002), TAIL + BODY - 0.25 - row * 0.065);
      win.rotation.z = ang - Math.PI / 2;
      root.add(win);
    }
  }

  // aft end: heat shield plate and engine bay
  const plate = new THREE.Mesh(new THREE.CircleGeometry(R, 64), tiles);
  plate.rotation.y = Math.PI;
  plate.position.z = TAIL;
  root.add(plate);
  const skirt = new THREE.Mesh(new THREE.TorusGeometry(R - 0.01, 0.012, 8, 96), steel);
  skirt.position.z = TAIL;
  root.add(skirt);

  const bell = (exit: number, len: number) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(new THREE.Vector2(exit * 0.35 + (exit - exit * 0.35) * Math.pow(t, 0.6), -t * len));
    }
    const g = new THREE.LatheGeometry(pts, 32);
    g.rotateX(Math.PI / 2);   // bell opens toward -Z
    return g;
  };
  const hot = new THREE.MeshStandardMaterial({ color: 0x3a2a20, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide, emissive: 0x401a08, emissiveIntensity: 0.4 });
  const rng = new Rng(3);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const sl = new THREE.Mesh(bell(0.085, 0.2), hot);
    sl.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, TAIL - 0.02);
    sl.rotation.z = rng.range(0, 1);
    root.add(sl);
    const b = a + Math.PI / 3;
    const vac = new THREE.Mesh(bell(0.14, 0.33), dark);
    vac.position.set(Math.cos(b) * 0.31, Math.sin(b) * 0.31, TAIL - 0.02);
    root.add(vac);
  }
}
