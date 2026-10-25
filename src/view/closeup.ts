// Close-ups of what is in orbit. From the planet view everything up there is a
// dot or a coarse shape; double-click one (or scroll into it) and the camera
// flies in, follows it round its orbit, and this swaps in a detailed model:
// a satellite with its solar wings and dish, a station with a spinning
// habitat ring, a power satellite's hexagonal mirror field and its beam, a
// shipyard welding a hull, a defence platform tracking with its turrets, a tug
// pushing an asteroid, a stretch of the orbital ring with cars running on it.
// Models are built at unit size (+z faces the planet) and scaled per kind.

import * as THREE from 'three';
import { hash01 } from '../sim/rng.ts';
import { REDUCED_MOTION } from './timeLook.ts';

/** Which picked kinds can be zoomed into: the model, its size in the view, and the viewing distance. */
export const CLOSEUP: Record<string, { model: Model; size: number; dist: number; name: string }> = {
  sat: { model: 'sat', size: 0.05, dist: 0.13, name: 'satellite' },
  simfleet: { model: 'sat', size: 0.05, dist: 0.13, name: 'satellite' },
  obssat: { model: 'sat', size: 0.05, dist: 0.13, name: 'satellite' },
  ostat: { model: 'station', size: 0.75, dist: 1.6, name: 'station' },
  opower: { model: 'power', size: 1.1, dist: 2.2, name: 'power satellite' },
  oyard: { model: 'yard', size: 0.9, dist: 1.9, name: 'shipyard' },
  odef: { model: 'defence', size: 0.24, dist: 0.6, name: 'defence platform' },
  omine: { model: 'miner', size: 0.4, dist: 0.95, name: 'asteroid tug' },
  oringl: { model: 'ring', size: 0.5, dist: 0.9, name: 'orbital ring' },
};
export type Model = 'sat' | 'station' | 'power' | 'yard' | 'defence' | 'miner' | 'ring';

// ---------------------------------------------------------------- materials

const cellTex = (() => {
  // solar cells: a dark blue grid with bright bus lines, drawn once
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e2350'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    g.fillStyle = (i + j) % 2 ? '#16336f' : '#132d63';
    g.fillRect(i * 16 + 1, j * 16 + 1, 14, 14);
  }
  g.strokeStyle = 'rgba(190,210,255,0.55)'; g.lineWidth = 1;
  for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 16, 0); g.lineTo(i * 16, 128); g.stroke(); g.beginPath(); g.moveTo(0, i * 16); g.lineTo(128, i * 16); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();
const std = (color: number, metalness: number, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
const M = {
  white: std(0xe9ecef, 0.25, 0.45),
  hull: std(0xc5ccd6, 0.6, 0.32),
  dark: std(0x2b3038, 0.8, 0.45),
  gold: std(0xd7a63d, 0.95, 0.32, { emissive: 0x2a1a00, emissiveIntensity: 0.4 }),
  cells: new THREE.MeshStandardMaterial({ map: cellTex, metalness: 0.55, roughness: 0.25, side: THREE.DoubleSide, emissive: 0x08143a, emissiveIntensity: 0.6 }),
  mirror: new THREE.MeshStandardMaterial({ color: 0x5f86d8, metalness: 1, roughness: 0.08, side: THREE.DoubleSide, emissive: 0x13306a, emissiveIntensity: 0.5 }),
  radiator: std(0xf2f2ea, 0.1, 0.7, { side: THREE.DoubleSide }),
  rock: std(0x6f6358, 0.05, 0.95, { flatShading: true }),
  glass: std(0x9fd8ff, 0.2, 0.1, { emissive: 0x4aa8ff, emissiveIntensity: 1.2 }),
  warm: new THREE.MeshBasicMaterial({ color: 0xffd38a }),
};
const glow = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

/** Blinking marker lights: [position, colour, period, phase]. */
type Blink = { mesh: THREE.Mesh; period: number; phase: number };

interface Built { root: THREE.Group; tick: (t: number) => void }

// ---------------------------------------------------------------- the models

function lightBulb(g: THREE.Group, blinks: Blink[], x: number, y: number, z: number, color: number, r: number, period: number, phase: number): void {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), glow(color, 1));
  m.position.set(x, y, z);
  g.add(m);
  blinks.push({ mesh: m, period, phase });
}
const blinkAll = (blinks: Blink[], t: number) => { for (const b of blinks) b.mesh.visible = REDUCED_MOTION || ((t / b.period + b.phase) % 1) < 0.18; };

/** A solar wing: a boom and `n` framed cell panels along x. */
function wing(n: number, w: number, h: number, dir: 1 | -1): THREE.Group {
  const g = new THREE.Group();
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, w * 0.35, 6), M.dark);
  boom.rotation.z = Math.PI / 2; boom.position.x = dir * w * 0.175;
  g.add(boom);
  for (let k = 0; k < n; k++) {
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 1.5);
    const p = new THREE.Mesh(geo, M.cells);
    p.position.x = dir * (w * 0.35 + w * (k + 0.5) * 1.03);
    g.add(p);
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xaab8c8 }));
    frame.position.copy(p.position);
    g.add(frame);
  }
  return g;
}

function satModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  const job = Math.floor(hash01(seed, 1) * 3); // 0 comms, 1 navigation, 2 observation
  const bus = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.18), M.gold);
  g.add(bus);
  // foil seams
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.201, 0.161, 0.181, 2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x7a5a18 })));
  const wl = wing(3, 0.16, 0.12, 1), wr = wing(3, 0.16, 0.12, -1);
  wl.position.x = 0.1; wr.position.x = -0.1;
  g.add(wl, wr);
  if (job === 0) {
    // a dish and a phased array, both looking down at the planet (+z), and laser terminals fore and aft
    const dish = new THREE.Mesh(new THREE.LatheGeometry(Array.from({ length: 10 }, (_, i) => new THREE.Vector2((i / 9) * 0.09, ((i / 9) ** 2) * 0.04)), 28), M.white);
    dish.rotation.x = -Math.PI / 2; dish.position.set(0.03, 0.04, 0.13);
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), M.dark);
    feed.rotation.x = Math.PI / 2; feed.position.set(0.03, 0.04, 0.16);
    const array = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.01), std(0x2c3440, 0.7, 0.3, { emissive: 0x1b2a40, emissiveIntensity: 0.6 }));
    array.position.set(-0.04, -0.045, 0.095);
    g.add(dish, feed, array);
    for (const y of [0.09, -0.09]) {
      const term = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.03, 12), M.hull);
      term.position.set(0, y, 0);
      g.add(term);
      lightBulb(g, blinks, 0, y * 1.25, 0, 0x7fe8ff, 0.007, 0.9, hash01(seed, y > 0 ? 2 : 3));
    }
  } else if (job === 1) {
    // navigation: a ring of helical antennas pointing down, an atomic-clock box
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const helix = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), M.white);
      helix.rotation.x = Math.PI / 2; helix.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.115);
      g.add(helix);
    }
    const clock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), M.white);
    clock.position.set(0, 0.105, 0);
    g.add(clock);
  } else {
    // observation: a telescope barrel looking down, a sunshade over it
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.2, 24, 1, true), M.white);
    tube.rotation.x = Math.PI / 2; tube.position.z = 0.18;
    const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.05, 24), M.mirror);
    mirror.position.z = 0.09;
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.004, 24, 1, false, 0, Math.PI), M.radiator);
    shade.rotation.x = Math.PI / 2; shade.position.z = 0.29;
    g.add(tube, mirror, shade);
  }
  lightBulb(g, blinks, 0.1, 0.085, -0.09, 0xff3b30, 0.008, 1.6, hash01(seed, 4));
  lightBulb(g, blinks, -0.1, 0.085, -0.09, 0x34ff6a, 0.008, 1.6, hash01(seed, 5));
  return { root: g, tick: (t) => blinkAll(blinks, t) };
}

function stationModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  // the spine: pressurised modules end to end, nodes between
  const spine = new THREE.Group();
  for (let k = -2; k <= 2; k++) {
    const mod = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 18), k % 2 ? M.white : M.hull);
    mod.rotation.z = Math.PI / 2; mod.position.x = k * 0.16;
    spine.add(mod);
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), M.hull);
    node.position.x = k * 0.16 + 0.08;
    spine.add(node);
    // windows along each module
    for (let w = 0; w < 5; w++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.008), M.warm);
      win.position.set(k * 0.16 - 0.05 + w * 0.025, 0.0, 0.0455);
      spine.add(win);
    }
  }
  g.add(spine);
  // the truss across, with four big solar wings and two radiators
  const truss = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.9), M.dark);
  g.add(truss);
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.03, 0.03, 0.9, 1, 1, 12)), new THREE.LineBasicMaterial({ color: 0x8a96a6 })));
  for (const z of [-0.42, 0.42]) for (const s of [1, -1] as const) {
    const w = wing(2, 0.13, 0.09, s);
    w.rotation.y = Math.PI / 2; w.position.z = z;
    w.rotation.x = 0.4;
    g.add(w);
  }
  for (const z of [-0.2, 0.2]) {
    const rad = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.06), M.radiator);
    rad.position.set(0, -0.06, z); rad.rotation.x = Math.PI / 2;
    g.add(rad);
  }
  // a habitat ring spinning about the spine for gravity, joined by spokes
  const ring = new THREE.Group();
  ring.add(new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.022, 12, 64), M.white));
  for (let k = 0; k < 6; k++) {
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.26, 6), M.hull);
    sp.rotation.z = (k / 6) * Math.PI * 2; sp.position.set(Math.sin(-(k / 6) * Math.PI * 2) * 0.13, Math.cos((k / 6) * Math.PI * 2) * 0.13, 0);
    ring.add(sp);
  }
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const win = new THREE.Mesh(new THREE.SphereGeometry(0.005, 4, 3), M.warm);
    win.position.set(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.02);
    ring.add(win);
  }
  ring.rotation.y = Math.PI / 2; ring.position.x = -0.42;
  g.add(ring);
  // a docked shuttle with its wings
  const sh = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 4, 10), M.white);
  body.rotation.z = Math.PI / 2;
  const wings = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.04, 0, 0), new THREE.Vector3(0.03, 0, 0.05), new THREE.Vector3(0.03, 0, -0.05)]), M.dark);
  wings.geometry.setIndex([0, 1, 2]); wings.geometry.computeVertexNormals();
  (wings.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  sh.add(body, wings);
  sh.position.set(0.43, 0.0, 0.0);
  g.add(sh);
  lightBulb(g, blinks, 0.4, 0.06, 0, 0xff3b30, 0.008, 1.5, hash01(seed, 1));
  lightBulb(g, blinks, 0, 0.02, 0.46, 0xffffff, 0.009, 1.1, hash01(seed, 2));
  lightBulb(g, blinks, 0, 0.02, -0.46, 0xffffff, 0.009, 1.1, hash01(seed, 3));
  return { root: g, tick: (t) => { ring.rotation.x = REDUCED_MOTION ? 0 : t * 0.35; blinkAll(blinks, t); } };
}

function powerModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  // a field of hexagonal thin-film mirrors, facing the sun (-z), a few tilted off true for sparkle
  const hex = new THREE.CircleGeometry(0.052, 6);
  const rows = 9, field = new THREE.InstancedMesh(hex, M.mirror, rows * rows);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  let n = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < rows; j++) {
    const x = (i - (rows - 1) / 2) * 0.092 + (j % 2) * 0.046, y = (j - (rows - 1) / 2) * 0.08;
    if (Math.hypot(x, y) > 0.42) continue;
    e.set((hash01(seed, i, j) - 0.5) * 0.08, (hash01(seed, j, i) - 0.5) * 0.08, Math.PI / 6);
    m4.compose(new THREE.Vector3(x, y, -0.06), q.setFromEuler(e), new THREE.Vector3(1, 1, 1));
    field.setMatrixAt(n++, m4);
  }
  field.count = n;
  g.add(field);
  // the frame behind the mirrors
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.008, 6, 6), M.hull);
  frame.rotation.z = Math.PI / 6; frame.position.z = -0.06;
  g.add(frame);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.44, 5), M.hull);
    strut.position.set(Math.cos(a) * 0.22, Math.sin(a) * 0.22, -0.065);
    strut.rotation.z = a - Math.PI / 2;
    g.add(strut);
  }
  // the mast down to the transmitter, which faces the planet (+z), and its microwave beam
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), M.dark);
  mast.rotation.x = Math.PI / 2; mast.position.z = 0.09;
  const tx = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, 0.025, 32), M.hull);
  tx.rotation.x = Math.PI / 2; tx.position.z = 0.24;
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.11, 32), std(0x334466, 0.7, 0.3, { emissive: 0xff7a3a, emissiveIntensity: 0.6 }));
  face.position.z = 0.254;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.22, 6, 32, 1, true), glow(0xff8a50, 0.03));
  beam.rotation.x = -Math.PI / 2; beam.position.z = 0.25 + 3;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 6, 16, 1, true), glow(0xffc090, 0.08));
  core.rotation.x = -Math.PI / 2; core.position.z = 0.25 + 3;
  g.add(mast, tx, face, beam, core);
  lightBulb(g, blinks, 0.44, 0, -0.06, 0xff3b30, 0.01, 2, hash01(seed, 1));
  lightBulb(g, blinks, -0.44, 0, -0.06, 0xff3b30, 0.01, 2, hash01(seed, 2));
  return {
    root: g,
    tick: (t) => {
      const k = REDUCED_MOTION ? 0.8 : 0.7 + 0.3 * Math.sin(t * 3.1);
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.02 + 0.02 * k;
      (core.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.06 * k;
      blinkAll(blinks, t);
    },
  };
}

function yardModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  const L = 0.8, W = 0.26;
  // the open lattice dock
  const lat = new THREE.LineBasicMaterial({ color: 0x9fb2c6 });
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, W, L, 2, 2, 10)), lat));
  for (let k = 0; k <= 10; k++) {
    const z = -L / 2 + (k / 10) * L;
    const pts = [[-1, -1, 1, 1], [1, -1, -1, 1]].map(([a, b, c, d]) => [new THREE.Vector3(a * W / 2, b * W / 2, z), new THREE.Vector3(c * W / 2, d * W / 2, z)]).flat();
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lat));
  }
  // the hull on the slip: finished plating aft, bare ribs forward, growing over a loop of time
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.55, 8, 20).rotateX(Math.PI / 2), M.hull);
  const ribs = new THREE.Group();
  for (let k = 0; k < 14; k++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.004, 4, 20), M.dark);
    r.position.z = -0.32 + k * 0.05;
    ribs.add(r);
  }
  const drive = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.08, 16, 1, true), M.dark);
  drive.rotation.x = Math.PI / 2; drive.position.z = -0.38;
  g.add(ribs, hull, drive);
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  (hull.material as THREE.MeshStandardMaterial) = M.hull.clone();
  (hull.material as THREE.MeshStandardMaterial).clippingPlanes = [clip];
  // gantry arms with welders, and floodlights
  const arms: THREE.Group[] = [];
  for (let k = 0; k < 4; k++) {
    const arm = new THREE.Group();
    const a1 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 6), std(0xe0b030, 0.6, 0.4));
    a1.position.y = 0.045;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), glow(0xbfe4ff, 1));
    tip.position.y = 0.09;
    arm.add(a1, tip);
    arm.position.set((k % 2 ? 1 : -1) * W / 2, (k < 2 ? 1 : -1) * W / 2, 0);
    arm.rotation.z = (k % 2 ? 1 : -1) * 2.2 * (k < 2 ? 1 : -1);
    arms.push(arm);
    g.add(arm);
  }
  const sparks = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(60 * 3), 3)), new THREE.PointsMaterial({ color: 0xfff0b0, size: 0.008, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  g.add(sparks);
  for (const z of [-L / 2, L / 2]) for (const x of [-W / 2, W / 2]) lightBulb(g, blinks, x, W / 2, z, 0xffe2a8, 0.01, 3, hash01(seed, x, z));
  return {
    root: g,
    tick: (t) => {
      // the build front sweeps from aft to bow over 30 seconds, then a new hull is laid down
      const u = ((t / 30 + hash01(seed, 9)) % 1);
      const front = -0.36 + u * 0.72;
      clip.constant = front;
      clip.normal.set(0, 0, -1);
      // clipping planes are in world space: carry the plane with the yard
      clip.applyMatrix4(g.matrixWorld);
      const P = sparks.geometry.attributes.position as THREE.BufferAttribute;
      arms.forEach((arm, k) => { arm.position.z = front; arm.rotation.x = REDUCED_MOTION ? 0 : Math.sin(t * 2 + k) * 0.3; });
      for (let i = 0; i < 60; i++) {
        const life = ((t * 1.7 + hash01(seed, i, 1)) % 1), a = hash01(seed, i, 2) * Math.PI * 2, s = hash01(seed, i, 3);
        const ox = Math.cos(a) * 0.078, oy = Math.sin(a) * 0.078;
        P.setXYZ(i, ox + Math.cos(a) * life * 0.06 * s, oy + Math.sin(a) * life * 0.06 * s - life * life * 0.02, front + (s - 0.5) * 0.02);
      }
      P.needsUpdate = true;
      (sparks.material as THREE.PointsMaterial).opacity = REDUCED_MOTION ? 0.5 : 0.6 + 0.4 * Math.sin(t * 20);
      blinkAll(blinks, t);
    },
  };
}

function defenceModel(seed: number, faction: THREE.Color): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  const armour = std(0x3b414a, 0.85, 0.4);
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.12, 6), armour);
  hull.rotation.x = Math.PI / 2;
  g.add(hull);
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.321, 0.361, 0.121, 6, 2)).rotateX(Math.PI / 2), new THREE.LineBasicMaterial({ color: 0x6b7480 })));
  // a faction stripe round the rim
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.345, 0.345, 0.02, 6, 1, true), new THREE.MeshBasicMaterial({ color: faction }));
  stripe.rotation.x = Math.PI / 2;
  g.add(stripe);
  // three turrets with twin barrels, slewing to track
  const turrets: THREE.Group[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const tur = new THREE.Group();
    tur.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), armour));
    for (const s of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.16, 8), M.dark);
      bar.rotation.x = Math.PI / 2; bar.position.set(s * 0.02, 0, -0.1);
      tur.add(bar);
    }
    tur.position.set(Math.cos(a) * 0.2, Math.sin(a) * 0.2, -0.06);
    turrets.push(tur);
    g.add(tur);
  }
  // a radar dish turning on the planet side and a shield bubble that shimmers
  const radar = new THREE.Mesh(new THREE.LatheGeometry(Array.from({ length: 8 }, (_, i) => new THREE.Vector2((i / 7) * 0.08, ((i / 7) ** 2) * 0.03)), 20), M.white);
  radar.rotation.x = Math.PI / 2; radar.position.z = 0.08;
  g.add(radar);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 20), glow(faction.getHex(), 0.02));
  (shield.material as THREE.MeshBasicMaterial).side = THREE.FrontSide;
  g.add(shield);
  const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.6, 6), glow(faction.clone().lerp(new THREE.Color(1, 1, 1), 0.5).getHex(), 0.9));
  bolt.rotation.x = Math.PI / 2;
  g.add(bolt);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; lightBulb(g, blinks, Math.cos(a) * 0.35, Math.sin(a) * 0.35, -0.065, k % 2 ? 0xff3b30 : faction.getHex(), 0.012, 1.2, k / 6); }
  return {
    root: g,
    tick: (t) => {
      const slow = REDUCED_MOTION ? 0.2 : 1;
      turrets.forEach((tu, k) => { tu.rotation.z = Math.sin(t * 0.4 * slow + k * 2) * 0.8; tu.rotation.x = Math.sin(t * 0.3 * slow + k) * 0.3; });
      radar.rotation.z = t * 1.2 * slow;
      (shield.material as THREE.MeshBasicMaterial).opacity = 0.02 + (REDUCED_MOTION ? 0 : 0.012 * Math.sin(t * 2.3));
      // every few seconds one turret fires: a bolt leaves its barrels
      const shot = (t / 2.6) % 1, k = Math.floor(t / 2.6) % 3;
      bolt.visible = !REDUCED_MOTION && shot < 0.12;
      if (bolt.visible) {
        const tu = turrets[k];
        bolt.position.set(tu.position.x, tu.position.y, -0.2 - shot * 6);
      }
      blinkAll(blinks, t);
    },
  };
}

function minerModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  // a lumpy asteroid
  const rockGeo = new THREE.IcosahedronGeometry(0.22, 3);
  const P = rockGeo.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const n = v.clone().normalize();
    const bump = 1 + 0.18 * Math.sin(n.x * 5 + seed) * Math.cos(n.y * 4) + 0.1 * Math.sin(n.z * 9 + n.x * 3) + (hash01(seed, Math.round(n.x * 20), Math.round(n.y * 20)) - 0.5) * 0.06;
    v.copy(n).multiplyScalar(0.22 * bump * (n.x > 0 ? 1.15 : 1));
    P.setXYZ(i, v.x, v.y, v.z);
  }
  rockGeo.computeVertexNormals();
  const rock = new THREE.Mesh(rockGeo, M.rock);
  g.add(rock);
  // the tug clamped on, its drive pushing (exhaust out along -x), and a drill rig on the rock
  const tug = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.16, 12), M.hull);
  body.rotation.z = Math.PI / 2;
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), M.white);
  tank.position.x = -0.07;
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.05, 0.06, 14, 1, true), M.dark);
  bell.rotation.z = Math.PI / 2; bell.position.x = -0.15;
  const plume = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.4, 16, 1, true), glow(0x8fd0ff, 0.35));
  plume.rotation.z = Math.PI / 2; plume.position.x = -0.38;
  tug.add(body, tank, bell, plume);
  for (const s of [-1, 1]) {
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.012), M.dark);
    clamp.position.set(0.1, s * 0.035, 0);
    tug.add(clamp);
  }
  tug.position.x = -0.33;
  g.add(tug);
  const drill = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.002, 0.12, 8), std(0xe0b030, 0.6, 0.4));
  drill.position.set(0.08, 0.24, 0.05);
  g.add(drill);
  const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(40 * 3), 3)), new THREE.PointsMaterial({ color: 0xc9b8a0, size: 0.01, transparent: true, opacity: 0.7, depthWrite: false }));
  g.add(dust);
  lightBulb(g, blinks, -0.33, 0.05, 0, 0xffffff, 0.008, 1.3, hash01(seed, 1));
  return {
    root: g,
    tick: (t) => {
      rock.rotation.y = t * 0.05; rock.rotation.x = t * 0.03;
      plume.scale.y = REDUCED_MOTION ? 1 : 0.85 + 0.25 * Math.sin(t * 23) * Math.sin(t * 7);
      drill.rotation.y = t * 9;
      const D = dust.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < 40; i++) {
        const life = (t * 0.6 + hash01(seed, i, 1)) % 1, a = hash01(seed, i, 2) * Math.PI * 2;
        D.setXYZ(i, 0.08 + Math.cos(a) * life * 0.1, 0.3 + life * 0.12, 0.05 + Math.sin(a) * life * 0.1);
      }
      D.needsUpdate = true;
      blinkAll(blinks, t);
    },
  };
}

function ringModel(seed: number): Built {
  const g = new THREE.Group(), blinks: Blink[] = [];
  // a stretch of the ring: the shell, a pair of maglev rails on top, cars running both ways, a tether down
  const len = 1.6;
  const shell = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.12), std(0xb9c2cc, 0.7, 0.35, { emissive: 0x223344, emissiveIntensity: 0.5 }));
  g.add(shell);
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(len, 0.08, 0.12, 16, 1, 1)), new THREE.LineBasicMaterial({ color: 0x7e8a98 })));
  for (const z of [-0.03, 0.03]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.008, 0.01), glow(0x5fb6ff, 0.9));
    rail.position.set(0, 0.044, z);
    g.add(rail);
  }
  const cars: THREE.Mesh[] = [];
  for (let k = 0; k < 6; k++) {
    const car = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.08, 4, 10).rotateZ(Math.PI / 2), M.white);
    car.userData = { dir: k % 2 ? 1 : -1, off: hash01(seed, k) };
    cars.push(car);
    g.add(car);
  }
  // the spoke to the ground: a tether hanging from the ring toward the planet (+z), with a climber
  const tether = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 4, 6), glow(0x9fd4ff, 0.6));
  tether.rotation.x = Math.PI / 2; tether.position.z = 2;
  const climber = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.04), M.hull);
  g.add(tether, climber);
  for (let k = -3; k <= 3; k++) lightBulb(g, blinks, k * 0.25, 0.05, 0.065, 0x5fb6ff, 0.008, 1.5, (k + 3) / 7);
  return {
    root: g,
    tick: (t) => {
      cars.forEach((c, k) => {
        const u = ((t * 0.12 * c.userData.dir + c.userData.off) % 1 + 1) % 1;
        c.position.set((u - 0.5) * len, 0.06, k % 2 ? 0.03 : -0.03);
      });
      climber.position.z = 0.1 + ((t * 0.05 + hash01(seed, 9)) % 1) * 1.5;
      blinkAll(blinks, t);
    },
  };
}

// ---------------------------------------------------------------- the close-up in the scene

/** One detailed model at a time, placed each frame where its thing is, facing the planet. */
export class CloseUp {
  readonly group = new THREE.Group();
  private built: Built | null = null;
  private key = '';
  private aim = new THREE.Object3D();
  private light = new THREE.PointLight(0xfff4e6, 0.5, 0, 0);

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.group.add(this.light);
    scene.add(this.group);
  }

  /** Show `kind`'s model (seeded by the thing's id) in the faction's colour. */
  show(kind: string, id: number, faction: THREE.Color): void {
    const spec = CLOSEUP[kind];
    if (!spec) return;
    const key = `${kind}:${id}:${faction.getHexString()}`;
    if (key !== this.key) {
      this.clear();
      const seed = id * 7919 + kind.length;
      const b = spec.model === 'sat' ? satModel(seed) : spec.model === 'station' ? stationModel(seed) : spec.model === 'power' ? powerModel(seed)
        : spec.model === 'yard' ? yardModel(seed) : spec.model === 'defence' ? defenceModel(seed, faction) : spec.model === 'miner' ? minerModel(seed) : ringModel(seed);
      b.root.scale.setScalar(spec.size);
      this.group.add(b.root);
      this.built = b;
      this.key = key;
    }
    this.group.visible = true;
  }

  hide(): void { this.group.visible = false; this.clear(); }

  private clear(): void {
    if (this.built) {
      this.group.remove(this.built.root);
      this.built.root.traverse((c) => { (c as THREE.Mesh).geometry?.dispose(); });
    }
    this.built = null; this.key = '';
  }

  /** Each frame: stand at `at`, +z toward `centre`, up along `up` (the planet's axis). */
  frame(at: THREE.Vector3, centre: THREE.Vector3, up: THREE.Vector3, t: number): void {
    if (!this.built || !this.group.visible) return;
    this.aim.position.copy(at);
    this.aim.up.copy(up);
    this.aim.lookAt(centre);
    this.built.root.position.copy(at);
    this.built.root.quaternion.copy(this.aim.quaternion);
    // a work light just off the model so its detail reads on the night side too
    this.light.position.copy(at).add(this.aim.position.clone().sub(centre).normalize().multiplyScalar(this.built.root.scale.x * 3));
    this.built.root.updateMatrixWorld(true);
    this.built.tick(t);
  }
}
