// A scripted 60-second tour of the real app (#demo or ?demo). One virtual clock drives everything,
// so the same tour plays live in a presentation and renders frame by frame for a video:
// window.__demo = { start(), seek(t), frame(t) }.
import * as THREE from 'three';
import type { Level } from '../view/views.ts';

export interface DemoHost {
  app: HTMLElement;
  level: () => Level;
  go: (l: Level, prep?: () => void) => void;
  locateGalaxy: (name: string) => { pos: THREE.Vector3; radius: number } | null;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  setYear: (y: number) => void;
  ready: () => boolean;
  simDone: () => boolean;
  earth: number;
  setPlace: (body: number, city: number) => void;
  personId: () => string | null;
  setPerson: (pid: string) => void;
  desk: (tab: string | null) => void;
  board: (on: boolean) => void;
  step: (dt: number) => void;
  setManual: (on: boolean) => void;
  setCamHook: (f: (() => void) | null) => void;
}

export const DURATION = 60;

type Pose = { pos: THREE.Vector3; target: THREE.Vector3 };
interface Beat {
  t0: number; t1: number; level: Level; caption: string;
  year?: number | [number, number];
  ui?: string[]; // body classes: chrome to show in this beat
  desk?: string | null;
  board?: boolean;
  prep?: (h: DemoHost) => void;
  cam?: (base: Pose, k: number, h: DemoHost) => Pose | null;
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const sine = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Orbit the level's resting pose: scale the distance, turn about the vertical, lift a little. */
function orbit(base: Pose, scale: number, az: number, lift = 0): Pose {
  const off = base.pos.clone().sub(base.target);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  const len = off.length();
  off.y += lift * len;
  off.setLength(len * scale);
  return { pos: base.target.clone().add(off), target: base.target.clone() };
}
const around = (centre: THREE.Vector3, dist: number, az: number, el: number): THREE.Vector3 =>
  centre.clone().add(new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(dist));

const BEATS: Beat[] = [
  { t0: 0, t1: 10, level: 'universe', year: 9000, caption: 'The Local Group. Andromeda, 2.5 million light years out.',
    cam: (_b, k, h) => {
      const a = h.locateGalaxy('Andromeda'); if (!a) return null;
      const e = sine(k);
      return { pos: around(a.pos, a.radius * lerp(1.7, 0.95, e), lerp(-0.9, 0.5, e), lerp(0.55, 0.25, e)), target: a.pos.clone() };
    } },
  { t0: 10, t1: 17, level: 'universe', year: 9000, caption: 'One possible future. 10,000 years.',
    cam: (_b, k, h) => {
      const a = h.locateGalaxy('Andromeda'), m = h.locateGalaxy('Milky Way'); if (!a || !m) return null;
      const e = ease(k);
      const tgt = a.pos.clone().lerp(m.pos, e);
      const d = lerp(a.radius * 0.95, m.radius * 1.15, e) * (1 + 1.8 * Math.sin(Math.PI * e));
      return { pos: around(tgt, d, lerp(0.5, 1.6, e), lerp(0.25, 0.7, e)), target: tgt };
    } },
  { t0: 17, t1: 20, level: 'galaxy', year: 9000, caption: 'One possible future. 10,000 years.',
    cam: (b, k) => orbit(b, lerp(2.4, 1.0, ease(k)), lerp(-0.5, 0, ease(k)), 0.1) },
  { t0: 20, t1: 25, level: 'multiverse', caption: 'Every future is a different history. Here are hundreds of them.',
    cam: (b, k) => orbit(b, lerp(0.45, 0.75, sine(k)), lerp(0, 0.6, k)) },
  { t0: 25, t1: 28, level: 'local', year: 600, caption: 'Back home: the stars within a few dozen light years.',
    cam: (b, k) => orbit(b, lerp(1.7, 0.9, ease(k)), lerp(0.4, 0, k), 0.15) },
  { t0: 28, t1: 31, level: 'system', year: 600, caption: 'The Solar System, settled world by world.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, lerp(1.5, 0.85, ease(k)), lerp(-0.3, 0.2, k), 0.1) },
  { t0: 31, t1: 37, level: 'planet', year: [0, 2400], ui: ['demo-tl'], caption: 'Earth: real climate, real night lights. Centuries race by.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, lerp(1.25, 0.95, sine(k)), lerp(0, 0.7, k)) },
  { t0: 37, t1: 41, level: 'street', year: 300, caption: 'A street in the capital. Every person here has a life story.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, lerp(1.15, 0.8, sine(k)), lerp(-0.25, 0.25, k)) },
  { t0: 41, t1: 42.5, level: 'person', year: 300, caption: 'Into one of them…', cam: (b, k) => orbit(b, lerp(1.2, 0.8, k), 0.3 * k) },
  { t0: 42.5, t1: 44, level: 'cell', year: 300, caption: '…a cell…', cam: (b, k) => orbit(b, lerp(1.2, 0.8, k), 0.3 * k) },
  { t0: 44, t1: 45, level: 'molecule', year: 300, caption: '…a molecule…', cam: (b, k) => orbit(b, lerp(1.2, 0.85, k), 0.3 * k) },
  { t0: 45, t1: 46, level: 'atom', year: 300, caption: '…an atom.', cam: (b, k) => orbit(b, lerp(1.2, 0.85, k), 0.3 * k) },
  { t0: 46, t1: 50, level: 'system', year: 1200, desk: 'trends', ui: ['demo-desk'], caption: 'The data desk: trends, and a transformer forecasting the next 400 years.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, 1.2, 0.3 * k, 0.1) },
  { t0: 50, t1: 53, level: 'system', year: 1200, desk: 'econ', ui: ['demo-desk'], caption: 'Launch economics: what it costs to reach every world.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, 1.2, 0.3 + 0.2 * k, 0.1) },
  { t0: 53, t1: 55.5, level: 'galaxy', year: 6500, ui: ['demo-legend'], caption: 'The way of war: whose minds fight, and how.',
    cam: (b, k) => orbit(b, lerp(0.9, 0.75, k), lerp(0.2, 0.45, k), 0.25) },
  { t0: 55.5, t1: 58, level: 'system', year: [6500, 9600], board: true, caption: 'Board the Starship. Jump through time.', prep: (h) => h.setPlace(h.earth, 0),
    cam: (b, k) => orbit(b, 1.1, 0.4 * k, 0.1) },
  { t0: 58, t1: 60.01, level: 'galaxy', year: 10000, ui: ['demo-title'], caption: '2SOON2026. One possible next ten thousand years.',
    cam: (b, k) => orbit(b, lerp(1.0, 1.7, sine(k)), lerp(0, 0.35, k), 0.35) },
];

export function installDemo(h: DemoHost): { start(): void; seek(t: number): void; frame(t: number): Promise<void>; t: number } {
  document.body.classList.add('demo');
  const cap = document.createElement('div');
  cap.className = 'demo-cap';
  h.app.append(cap);
  let beat: Beat | null = null, base: Pose | null = null, pose: Pose | null = null, lastT = -1, playing = false, t0 = 0;

  h.setCamHook(() => {
    if (!pose) return;
    h.camera.position.copy(pose.pos);
    h.target.copy(pose.target);
    h.camera.lookAt(pose.target);
  });

  function apply(t: number): boolean {
    const b = BEATS.find((x) => t >= x.t0 && t < x.t1) ?? BEATS[BEATS.length - 1];
    const k = Math.max(0, Math.min(1, (t - b.t0) / (b.t1 - b.t0)));
    let changed = false;
    if (b !== beat) {
      changed = true;
      const prev = beat;
      beat = b;
      if (b.level === 'person') { const pid = h.personId(); if (pid) h.setPerson(pid); }
      if (h.level() !== b.level || b.prep) { pose = null; h.go(b.level, () => b.prep?.(h)); }
      base = { pos: h.camera.position.clone(), target: h.target.clone() };
      if (prev && prev.level === b.level && prev.cam && pose) base = { pos: pose.pos.clone(), target: pose.target.clone() };
      if ((b.desk ?? null) !== (prev?.desk ?? null)) h.desk(b.desk ?? null);
      if (!!b.board !== !!prev?.board) h.board(!!b.board);
      for (const c of [...document.body.classList]) if (c.startsWith('demo-')) document.body.classList.remove(c);
      for (const c of b.ui ?? []) document.body.classList.add(c);
      if (cap.textContent !== b.caption) {
        cap.classList.remove('on'); void cap.offsetWidth; cap.textContent = b.caption; cap.classList.add('on');
      }
    }
    if (b.year !== undefined) h.setYear(Array.isArray(b.year) ? lerp(b.year[0], b.year[1], ease(k)) : b.year);
    pose = base && b.cam ? b.cam(base, k, h) : null;
    // caption fades in and out within its beat (unless the next beat says the same)
    const fade = Math.min(1, (t - b.t0) / 0.5, (b.t1 - t) / 0.4);
    cap.style.opacity = String(Math.max(0, Math.min(1, fade)));
    return changed;
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const api = {
    t: 0,
    start() {
      h.setManual(false);
      playing = true; t0 = performance.now(); beat = null;
      const tick = () => {
        if (!playing) return;
        const t = (performance.now() - t0) / 1000;
        api.t = t;
        if (t > DURATION) { playing = false; return; }
        apply(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    seek(t: number) { t0 = performance.now() - t * 1000; api.t = t; apply(t); },
    /** Deterministic: put the app in the state for time t and render it (resolves once drawn). */
    async frame(t: number) {
      playing = false;
      h.setManual(true);
      const changed = apply(t);
      if (changed) {
        // a new level: let it load what it needs (residents, a life, a state) before drawing
        for (let i = 0; i < 40; i++) { h.step(1 / 30); await wait(25); if (h.ready() && i > 6) break; }
        apply(t);
      } else {
        for (let i = 0; i < 20 && !h.ready(); i++) await wait(15);
      }
      const dt = lastT >= 0 && t > lastT ? Math.min(0.1, t - lastT) : 1 / 30;
      lastT = t; api.t = t;
      h.step(dt);
    },
  };
  return api;
}
