import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { EngineAudio } from './audio.ts';
import { parse, type Action } from './commands.ts';
import {
  BIG_BANG, DESTINATIONS, NOW_YEAR, SOL, eraNote, formatYear, observerPos, randomSystem, type Destination, type System,
} from './places.ts';
import { Ship, type ModelSpec } from './ship.ts';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from './sky.ts';
import { LocalSystem } from './system.ts';
import { Voice } from './voice.ts';
import './ship.css';

// ------------------------------------------------------------------ DOM

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas class="scene"></canvas>
  <div class="labels"></div>
  <div class="tint"></div>
  <div class="flash"></div>
  <div class="reticle" aria-hidden="true"></div>
  <div class="target" hidden><span class="target-box"></span><span class="target-name"></span></div>
  <div class="yearbig" hidden><small></small><b></b></div>

  <header class="hud-top">
    <div class="where"><b class="place">Earth</b><span class="year num">2026 CE</span></div>
  </header>

  <div class="hud-br">
    <div class="readout num"><span class="r-mode">PARKED</span><span class="r-speed"></span><span class="r-dist"></span></div>
    <div class="views" role="group" aria-label="Camera">
      <button data-view="first">Cockpit</button><button data-view="third">Chase cam</button>
    </div>
  </div>

  <aside class="chat" aria-label="Ship computer">
    <header>
      <span class="dot"></span><b>SHIP COMPUTER</b>
      <button class="icon gear" title="Voice settings" aria-label="Voice settings">⚙</button>
      <button class="icon collapse" title="Hide chat" aria-label="Hide chat">‹</button>
    </header>
    <div class="log" role="log" aria-live="polite"></div>
    <div class="chips"></div>
    <form class="composer">
      <button type="button" class="mic" title="Talk" aria-label="Talk"><span class="lvl"></span>🎙</button>
      <input class="say" type="text" placeholder="Where to? Or when?" autocomplete="off" enterkeyhint="send" />
      <button type="submit" class="send" aria-label="Send">➤</button>
    </form>
  </aside>
  <button class="chat-open" hidden aria-label="Show chat">›</button>

  <dialog class="settings">
    <form method="dialog">
      <h2>Voice</h2>
      <p class="eleven-status"></p>
      <div class="credits"><div class="bar"><i></i></div><span class="num"></span></div>
      <label>ElevenLabs API key<input class="key" type="password" placeholder="xi-…" autocomplete="off" /></label>
      <p class="hint">A key typed here stays in this browser only. Running locally, you can instead put <code>ELEVENLABS_API_KEY=…</code> in <code>.env.local</code> and the dev server adds it, so the page never sees it.</p>
      <label>Voice ID<input class="voice-id" type="text" /></label>
      <label class="row"><input class="speak" type="checkbox" /> Ship talks back</label>
      <label class="row"><input class="stt" type="checkbox" /> Use ElevenLabs for the mic (off = free browser speech recognition)</label>
      <label class="row"><input class="engine" type="checkbox" /> Engine sound</label>
      <div class="actions"><button type="button" class="save">Save &amp; test</button><button type="button" class="clear">Forget key</button><button value="close">Close</button></div>
    </form>
  </dialog>
`;
const $ = <T extends Element = HTMLElement>(s: string) => app.querySelector<T>(s)!;
const canvas = $<HTMLCanvasElement>('canvas.scene');
const logEl = $('.log'), inputEl = $<HTMLInputElement>('.say'), micBtn = $<HTMLButtonElement>('.mic');
const labelsEl = $('.labels'), flashEl = $('.flash'), tintEl = $('.tint'), targetEl = $('.target');
const yearBig = $('.yearbig');

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010102);
const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 2e7);
scene.add(new THREE.HemisphereLight(0x8899bb, 0x0a0a10, 0.35));
// soft studio reflections so metal hulls aren't black away from the star
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.12;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.45, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());
function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ------------------------------------------------------------------ world state

const sky = new Sky();
scene.add(sky.group);
const ship = new Ship();
scene.add(ship.root);
// Optional: drop a .glb into public/models/ and open ship.html?model=<file>.glb
// (add &rot=x,y,z in degrees if its nose doesn't point forward). Default is the
// built-in Starship.
const params = new URLSearchParams(location.search);
const modelFile = params.get('model');
if (modelFile) {
  const spec: ModelSpec = { url: `models/${modelFile}`, rot: [0, 0, 0], length: 5, engines: [[0, 0]], plume: 0.3 };
  const r = params.get('rot');
  if (r) spec.rot = r.split(',').map((x) => (Number(x) * Math.PI) / 180) as [number, number, number];
  ship.useModel(spec).catch((e) => console.warn('model failed, keeping the built-in hull', e));
}
const voice = new Voice();
const engine = new EngineAudio();

let here: { system: System; body?: string } = { system: SOL, body: 'Earth' };
let local = new LocalSystem(SOL);
scene.add(local.group);
let year = NOW_YEAR;
let orbitT = 0;               // animation clock (years)
const obs = observerPos(SOL); // ly
const parkOff = new THREE.Vector3();
let view: 'first' | 'third' = 'third';

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const UP = new THREE.Vector3(0, 1, 0);

/** Pick where to park next to a body: off to the side so it's half-lit. */
function parkOffset(sysLocal: LocalSystem, body: string | undefined, from?: THREE.Vector3): THREE.Vector3 {
  const a = sysLocal.anchor(body);
  let toStar = sysLocal.starPos.clone().sub(a.pos);
  if (toStar.lengthSq() < 1e-6) toStar = from ? from.clone().negate() : new THREE.Vector3(0.3, 0.2, 1);
  toStar.normalize();
  const side = new THREE.Vector3().crossVectors(toStar, UP).normalize();
  const n = toStar.multiplyScalar(0.55).add(side.multiplyScalar(0.75)).addScaledVector(UP, 0.28);
  if (from) n.addScaledVector(from, -0.6);
  return n.normalize().multiplyScalar(a.park);
}
function faceQuat(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(to, from, UP); // Object3D convention: +Z toward target
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function settle(): void {
  local.update(orbitT, year, camera, 0);
  parkOff.copy(parkOffset(local, here.body));
  const a = local.anchor(here.body);
  ship.root.position.copy(a.pos).add(parkOff);
  ship.root.quaternion.copy(faceQuat(ship.root.position, a.pos));
}
settle();

// ------------------------------------------------------------------ flight

type Phase =
  | { k: 'idle' }
  | { k: 'cruise'; t: number; T: number; p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Quaternion; dest: Destination; dist: number }
  | { k: 'warp'; t: number; A: number; B: number; W: number; E: number; F: number; dest: Destination; dir: THREE.Vector3; q0: THREE.Quaternion; qDir: THREE.Quaternion;
      obs0: THREE.Vector3; obs1: THREE.Vector3; ly: number; v: number; swapped: boolean; exited: boolean; approach: THREE.Vector3; exitFrom: THREE.Vector3; enterFlash: boolean }
  | { k: 'time'; t: number; T: number; y0: number; y1: number; label?: string };

let phase: Phase = { k: 'idle' };
const queue: Action[] = [];
let hudMode = 'PARKED', hudSpeed = '', hudDist = '';
let shake = 0;
let snapCamera = true;

function startTravel(dest: Destination): void {
  if (dest.system === here.system) {
    if (dest.body === here.body) { reply(`We're already at ${dest.label}.`); return; }
    const a = local.anchor(dest.body);
    const off = parkOffset(local, dest.body, ship.root.position.clone().sub(a.pos).normalize().negate());
    const p1 = a.pos.clone().add(off);
    const dist = p1.distanceTo(ship.root.position);
    const T = THREE.MathUtils.clamp(3 + 1.3 * Math.log10(Math.max(dist, 100) / 100), 3.5, 9);
    phase = { k: 'cruise', t: 0, T, p0: ship.root.position.clone(), p1, q0: ship.root.quaternion.clone(), dest, dist };
    reply(`Setting course for ${dest.label}. Short hop, ${Math.round(T)} seconds.`);
    return;
  }
  const obs1 = observerPos(dest.system);
  const ly = obs1.distanceTo(obs);
  const dir = obs1.clone().sub(obs).normalize();
  const W = THREE.MathUtils.clamp(4 + 1.8 * Math.log10(1 + ly), 5, 15);
  const qDir = faceQuat(ship.root.position, ship.root.position.clone().add(dir));
  phase = {
    k: 'warp', t: 0, A: 1.8, B: 1.6, W, E: 2.6, F: 1.2, dest, dir, q0: ship.root.quaternion.clone(), qDir,
    obs0: obs.clone(), obs1, ly, v: 0, swapped: false, exited: false, approach: new THREE.Vector3(), exitFrom: new THREE.Vector3(), enterFlash: false,
  };
  reply(`Course set: ${dest.label}, ${fmtLy(ly)} away. Spinning up the warp drive.`);
}

function startTime(y1: number, label?: string): void {
  let note = '';
  if (y1 < BIG_BANG + 3.8e5) { y1 = BIG_BANG + 3.8e5; note = 'There\'s no "before" the Big Bang, so this is as far back as I can go. '; }
  if (y1 > 1e15) { y1 = 1e15; note = 'The engine tops out at a quadrillion years. '; }
  const d = Math.abs(y1 - year);
  if (d < 0.5) { reply(`We're already in ${formatYear(year)}.`); return; }
  const T = THREE.MathUtils.clamp(5 + 0.75 * Math.log10(d + 1), 5, 12);
  phase = { k: 'time', t: 0, T, y0: year, y1, label };
  const where = label ? label : formatYear(y1);
  reply(`${note}Chrono drive engaged. Heading ${y1 > year ? 'forward' : 'back'} to ${where}.`);
}

function tick(dt: number, time: number): void {
  if (phase.k === 'idle') {
    ship.throttle += (0 - ship.throttle) * Math.min(1, dt * 3);
    ship.warp = 0; ship.chrono += (0 - ship.chrono) * Math.min(1, dt * 4);
    orbitT += dt * 0.0014;   // half a day per second
    local.update(orbitT, year, camera, time);
    const a = local.anchor(here.body);
    if (local.bodyVisible(here.body)) {
      ship.root.position.copy(a.pos).add(parkOff);
      ship.root.position.y += Math.sin(time * 0.8) * 0.15;
    }
    hudMode = 'PARKED'; hudSpeed = ''; hudDist = here.system.id === 'sol' ? '' : `${fmtLy(obs.length())} from the Sun`;
    const next = queue.shift();
    if (next) run(next);
    return;
  }

  if (phase.k === 'cruise') {
    const p = phase;
    p.t += dt;
    const u = clamp01(p.t / p.T), s = ease(u);
    orbitT += dt * 0.0014;
    local.update(orbitT, year, camera, time);
    // the target keeps orbiting; re-aim at it
    const a = local.anchor(p.dest.body);
    p.p1.copy(a.pos).add(parkOffset(local, p.dest.body, p.p0.clone().sub(a.pos).normalize().negate()));
    const fwd0 = new THREE.Vector3(0, 0, 1).applyQuaternion(p.q0);
    const c1 = p.p0.clone().addScaledVector(fwd0, p.dist * 0.3).addScaledVector(UP, p.dist * 0.18);
    const c2 = p.p1.clone().addScaledVector(UP, p.dist * 0.18);
    const pos = bezier(p.p0, c1, c2, p.p1, s);
    const ahead = bezier(p.p0, c1, c2, p.p1, Math.min(1, s + 0.01));
    ship.root.position.copy(pos);
    const qPath = ahead.distanceTo(pos) > 1e-4 ? faceQuat(pos, ahead) : ship.root.quaternion.clone();
    const qFace = faceQuat(pos, a.pos);
    const q = p.q0.clone().slerp(qPath, clamp01(u * 5)).slerp(qFace, clamp01((u - 0.8) / 0.2));
    ship.root.quaternion.copy(q);
    ship.throttle = Math.sin(Math.PI * u);
    ship.speed = 60 + 500 * ship.throttle;
    shake = ship.throttle * 0.004;
    hudMode = 'CRUISE'; hudSpeed = `${Math.round(ship.throttle * 0.3 * 100)}% c`; hudDist = `→ ${p.dest.label}`;
    if (u >= 1) arrive(p.dest);
    return;
  }

  if (phase.k === 'warp') {
    const p = phase;
    p.t += dt;
    const { A, B, W, E, F } = p;
    orbitT += dt * 0.0014;
    local.update(orbitT, year, camera, time);
    if (p.t < A) {
      // turn toward the destination's spot in the sky
      ship.root.quaternion.copy(p.q0).slerp(p.qDir, ease(p.t / A));
      ship.throttle = 0.15;
      hudMode = 'ALIGNING';
      showTarget(p.dir, p.dest.label, p.ly);
    } else if (p.t < A + B) {
      const u = (p.t - A) / B;
      ship.root.quaternion.copy(p.qDir);
      ship.throttle = Math.min(1, u * 1.5);
      p.v = 40 + u * u * 900;
      ship.root.position.addScaledVector(p.dir, p.v * dt);
      ship.speed = 100 + u * 900;
      shake = 0.003 + u * 0.012;
      hudMode = 'BURN'; hudSpeed = `${(u * 0.9).toFixed(2)} c`;
      showTarget(p.dir, p.dest.label, p.ly);
    } else if (p.t < A + B + W) {
      const u = (p.t - A - B) / W;
      if (!p.enterFlash) { p.enterFlash = true; flash('#cfe0ff'); local.group.visible = false; }
      ship.warp = Math.min(1, u * 6, (1 - u) * 6);
      ship.throttle = 1;
      ship.speed = 2500;
      shake = 0.008 * ship.warp;
      const prev = obs.clone();
      obs.lerpVectors(p.obs0, p.obs1, ease(u));
      const lyPerSec = prev.distanceTo(obs) / Math.max(dt, 1e-3);
      hudMode = 'WARP'; hudSpeed = `${fmtBig(lyPerSec * 3.156e7)} c`; hudDist = `${fmtLy(obs.distanceTo(p.obs1))} to go`;
      targetEl.hidden = true;
      if (!p.swapped && u > 0.5) {
        p.swapped = true;
        swapSystem(p.dest);
        local.group.visible = false;
        const a = local.anchor(p.dest.body);
        const park = a.pos.clone().add(parkOffset(local, p.dest.body, p.dir));
        p.approach.copy(park);
        ship.root.position.copy(park).addScaledVector(p.dir, -Math.max(a.park * 10, 2500));
        ship.root.quaternion.copy(p.qDir);
        snapCamera = true;
      }
    } else if (p.t < A + B + W + E) {
      const u = (p.t - A - B - W) / E;
      if (!p.exited) {
        p.exited = true; flash('#ffffff'); local.group.visible = true;
        obs.copy(p.obs1);
        p.exitFrom.copy(ship.root.position);
      }
      ship.warp = 0;
      const a = local.anchor(p.dest.body);
      const park = a.pos.clone().add(parkOffset(local, p.dest.body, p.dir));
      ship.root.position.lerpVectors(p.exitFrom, park, easeOut(u));
      ship.throttle = 0.6 * (1 - u);
      ship.speed = 600 * (1 - u);
      shake = 0.006 * (1 - u);
      hudMode = 'ARRIVING'; hudSpeed = ''; hudDist = p.dest.label;
    } else {
      const u = (p.t - A - B - W - E) / F;
      const a = local.anchor(p.dest.body);
      const qFace = faceQuat(ship.root.position, a.pos);
      ship.root.quaternion.copy(p.qDir).slerp(qFace, ease(clamp01(u)));
      if (u >= 1) arrive(p.dest, p.ly);
    }
    return;
  }

  if (phase.k === 'time') {
    const p = phase;
    p.t += dt;
    const T = p.T;
    const spin = clamp01(p.t / 1.0), down = clamp01((T - p.t) / 1.2);
    ship.chrono = Math.min(spin, down);
    ship.chronoDir = p.y1 > p.y0 ? 1 : -1;
    ship.warp = ship.chrono * 0.4;
    ship.speed = 300 * ship.chrono * ship.chronoDir;
    ship.setTunnelColors(ship.chronoDir > 0 ? 0x2bc4ff : 0xff8a2a, ship.chronoDir > 0 ? 0x9a6bff : 0xffd060, 2);
    const u = clamp01((p.t - 1.0) / (T - 2.2));
    const span = Math.abs(p.y1 - p.y0);
    const prev = year;
    year = p.y0 + Math.sign(p.y1 - p.y0) * (Math.pow(10, ease(u) * Math.log10(span + 1)) - 1);
    const rate = Math.abs(year - prev) / Math.max(dt, 1e-3);
    orbitT += Math.sign(p.y1 - p.y0) * Math.min(rate, 2.5) * dt + dt * 0.0014;
    local.update(orbitT, year, camera, time);
    if (local.bodyVisible(here.body)) {
      const a = local.anchor(here.body);
      ship.root.position.copy(a.pos).add(parkOff);
      ship.root.quaternion.slerp(faceQuat(ship.root.position, a.pos), Math.min(1, dt * 2));
    }
    shake = 0.006 * ship.chrono;
    hudMode = 'CHRONO'; hudSpeed = `${fmtBig(rate)} yr/s`; hudDist = p.label ?? formatYear(p.y1);
    yearBig.hidden = false;
    yearBig.querySelector('b')!.textContent = formatYear(year);
    yearBig.querySelector('small')!.textContent = p.y1 > p.y0 ? 'FORWARD IN TIME' : 'BACK IN TIME';
    tintEl.className = `tint ${p.y1 > p.y0 ? 'future' : 'past'}`;
    tintEl.style.opacity = String(ship.chrono * 0.55);
    if (p.t >= T) {
      year = p.y1;
      yearBig.hidden = true;
      tintEl.style.opacity = '0';
      ship.setTunnelColors(0x3a5cff, 0xb46bff, 1);
      flash(p.y1 > p.y0 ? '#bff4ff' : '#ffe2b0');
      phase = { k: 'idle' };
      local.update(orbitT, year, camera, time);
      reply(timeArrivalLine());
    }
  }
}

function swapSystem(dest: Destination): void {
  scene.remove(local.group);
  local.dispose();
  local = new LocalSystem(dest.system);
  scene.add(local.group);
  here = { system: dest.system, body: dest.body };
  local.update(orbitT, year, camera, 0);
}

function arrive(dest: Destination, ly?: number): void {
  here = { system: dest.system, body: dest.body };
  const a = local.anchor(dest.body);
  parkOff.copy(ship.root.position).sub(a.pos);
  phase = { k: 'idle' };
  ship.throttle = 0; ship.speed = 0;
  targetEl.hidden = true;
  const planet = dest.body ? dest.system.planets.find((p) => p.name === dest.body) : undefined;
  const parts = [`Arrived: ${dest.label}.`];
  if (!local.bodyVisible(dest.body)) parts.push(dest.body ? `Except it isn't here in ${formatYear(year)}.` : 'The star isn\'t shining in this era.');
  if (planet?.blurb) parts.push(planet.blurb);
  else if (!dest.body && dest.system.blurb) parts.push(dest.system.blurb);
  else if (planet) parts.push(planetFact(planet.kind, planet.temp));
  if (dest.system.generated && dest.body) parts.push(dest.system.blurb ?? '');
  if (ly && ly > 0.5) parts.push(`By Voyager, that trip would have taken ${fmtBig(ly * 17600)} years.`);
  reply(parts.filter(Boolean).join(' '));
}

function planetFact(kind: string, temp?: number): string {
  const c = temp ? Math.round(temp - 273) : null;
  const t = c === null ? '' : ` Surface around ${c}°C.`;
  const k: Record<string, string> = {
    ocean: 'Looks like a water world.', lava: 'A lava world. Do not touch.', ice: 'Frozen solid.', gas: 'A gas giant: no ground to land on.',
    icegiant: 'An ice giant, cold and blue.', desert: 'Dry and dusty.', superearth: 'A super-Earth, heavier than home.', rocky: 'Bare rock.',
  };
  return `${k[kind] ?? ''}${t}`.trim();
}

function timeArrivalLine(): string {
  const y = formatYear(year);
  if (here.system.id === 'sol') return `Welcome to ${y}. ${eraNote(year)}`;
  if (year < BIG_BANG + 2e8) return `Welcome to ${y}. ${eraNote(year)}`;
  const visible = local.bodyVisible(undefined);
  if (!visible) return `Welcome to ${y}. ${here.system.name} isn't shining right now: either it hasn't formed yet or it already died.`;
  if (Math.abs(year - NOW_YEAR) > 1e5) return `Welcome to ${y}. ${here.system.name} is still here, but every star in the sky has drifted.`;
  return `Welcome to ${y}. Out here, ${here.system.name} looks about the same.`;
}

function bezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  return new THREE.Vector3()
    .addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * t).addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
}

// ------------------------------------------------------------------ commands

function run(a: Action): void {
  switch (a.type) {
    case 'travel': startTravel(a.dest); break;
    case 'random': {
      const { system, dest } = randomSystem((Math.random() * 1e9) | 0, { habitable: a.habitable, kind: a.kind });
      sky.addBeacon(system);
      startTravel(dest);
      break;
    }
    case 'time': startTime(a.year, a.label); break;
    case 'view': setView(a.mode === 'toggle' ? (view === 'first' ? 'third' : 'first') : a.mode); reply(view === 'first' ? 'Cockpit view.' : 'Chase cam.'); break;
    case 'status': {
      const at = here.body ?? here.system.name;
      const far = here.system.id === 'sol' ? '' : ` ${fmtLy(obs.length())} from the Sun.`;
      reply(`We're at ${at}, in ${formatYear(year)}.${far}`);
      break;
    }
    case 'help':
      reply('Tell me where or when. "Take me to Alpha Centauri." "Random planet." "Go back 66 million years." "Mars in the year 3000." "Cockpit view."');
      break;
    case 'stop':
      queue.length = 0;
      reply(phase.k === 'idle' ? 'Holding position.' : 'Can\'t bail mid-jump, but I cleared everything after this one.');
      break;
    case 'unknown':
      reply('Didn\'t catch a place or a time in that. Try "Alpha Centauri", "random planet", "the year 3000", or "dinosaurs".');
      break;
  }
}

function command(text: string): void {
  text = text.trim();
  if (!text) return;
  engine.start();
  addMsg('you', text);
  const actions = parse(text);
  const busy = phase.k !== 'idle' || queue.length > 0;
  // view changes and status apply right away even mid-flight
  for (const a of actions) {
    if (a.type === 'view' || a.type === 'status' || a.type === 'help' || a.type === 'stop' || a.type === 'unknown') run(a);
    else queue.push(a);
  }
  if (busy && actions.some((a) => a.type === 'travel' || a.type === 'random' || a.type === 'time')) reply('Queued. Next stop after this one.');
}

// ------------------------------------------------------------------ chat UI

function addMsg(who: 'you' | 'ship' | 'sys', text: string): void {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  logEl.append(el);
  logEl.scrollTop = logEl.scrollHeight;
}
function reply(text: string): void {
  addMsg('ship', text);
  if (interacted) voice.say(text);
}
voice.onStatus = (s) => addMsg('sys', s);

const CHIPS = ['Alpha Centauri', 'Random planet', 'Saturn', 'Dinosaurs', 'Year 3000', 'Black hole', 'Andromeda', 'Big Bang', 'Sun dies', 'Switch view'];
const chipsEl = $('.chips');
for (const c of CHIPS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = c;
  b.addEventListener('click', () => { b.blur(); command(c === 'Year 3000' ? 'go to the year 3000' : c === 'Sun dies' ? 'take me to when the sun dies' : c); });
  chipsEl.append(b);
}

$('.composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = inputEl.value;
  inputEl.value = '';
  command(t);
});

let interacted = false;
window.addEventListener('pointerdown', () => { interacted = true; engine.start(); }, { once: true });
window.addEventListener('keydown', () => { interacted = true; }, { once: true });

async function toggleMic(): Promise<void> {
  interacted = true;
  engine.start();
  if (voice.listening) { voice.stopListening(); return; }
  voice.stopSpeaking();
  micBtn.classList.add('on');
  const lvl = micBtn.querySelector<HTMLElement>('.lvl')!;
  try {
    const text = await voice.listen((v) => (lvl.style.transform = `scale(${1 + v * 1.4})`));
    if (text) command(text);
    else addMsg('sys', 'Didn\'t hear anything.');
  } catch (e) {
    addMsg('sys', (e as Error).message);
  } finally {
    micBtn.classList.remove('on');
    lvl.style.transform = '';
  }
}
micBtn.addEventListener('click', toggleMic);

// chat collapse
const chat = $('.chat'), chatOpen = $<HTMLButtonElement>('.chat-open');
$('.collapse').addEventListener('click', () => { chat.hidden = true; chatOpen.hidden = false; });
chatOpen.addEventListener('click', () => { chat.hidden = false; chatOpen.hidden = true; });

// ------------------------------------------------------------------ settings

const dlg = $<HTMLDialogElement>('dialog.settings');
const keyIn = $<HTMLInputElement>('.settings .key'), voiceIn = $<HTMLInputElement>('.settings .voice-id');
const speakIn = $<HTMLInputElement>('.settings .speak'), sttIn = $<HTMLInputElement>('.settings .stt'), engIn = $<HTMLInputElement>('.settings .engine');
function renderSettings(): void {
  const st = $('.eleven-status');
  st.textContent = voice.mode === 'proxy' ? 'ElevenLabs: connected through the dev server.'
    : voice.mode === 'browser' ? 'ElevenLabs: connected with your key.'
    : `ElevenLabs: not connected. Using the browser's free voices.${voice.lastError ? ' ' + voice.lastError : ''}`;
  const cr = $('.credits');
  cr.hidden = !voice.credits;
  if (voice.credits) {
    const { used, limit, tier } = voice.credits;
    const left = Math.max(0, limit - used);
    cr.querySelector<HTMLElement>('i')!.style.width = `${limit ? (100 * used) / limit : 0}%`;
    cr.querySelector('span')!.textContent = `${left.toLocaleString()} of ${limit.toLocaleString()} credits left${tier ? ` (${tier})` : ''} · this session used ~${voice.charsThisSession.toLocaleString()}`;
  }
  keyIn.value = voice.key ?? '';
  voiceIn.value = voice.voiceId;
  speakIn.checked = voice.speak;
  sttIn.checked = voice.useElevenStt;
  engIn.checked = !engine.muted;
  $('.dot').className = `dot ${voice.elevenReady ? 'live' : ''}`;
}
$('.gear').addEventListener('click', () => { renderSettings(); dlg.showModal(); });
$('.settings .save').addEventListener('click', async () => {
  voice.setKey(keyIn.value);
  voice.setVoice(voiceIn.value);
  await voice.connect();
  renderSettings();
  if (voice.elevenReady) { interacted = true; voice.say('Voice link established.'); }
});
$('.settings .clear').addEventListener('click', async () => { voice.setKey(null); await voice.connect(); renderSettings(); });
speakIn.addEventListener('change', () => voice.setSpeak(speakIn.checked));
sttIn.addEventListener('change', () => voice.setElevenStt(sttIn.checked));
engIn.addEventListener('change', () => (engine.muted = !engIn.checked));
voice.connect().then(() => {
  renderSettings();
  if (voice.elevenReady && voice.credits) {
    const left = voice.credits.limit - voice.credits.used;
    addMsg('sys', `ElevenLabs connected: ${left.toLocaleString()} credits left.`);
  }
});

// ------------------------------------------------------------------ camera

const look = { yaw: 0, pitch: 0 };            // first-person head
const orbit = { yaw: 0, pitch: 0.12, dist: 11 }; // third-person chase cam
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = (e.clientX - lastX) * 0.005, dy = (e.clientY - lastY) * 0.005;
  lastX = e.clientX; lastY = e.clientY;
  if (view === 'first') {
    look.yaw = THREE.MathUtils.clamp(look.yaw - dx, -1.9, 1.9);
    look.pitch = THREE.MathUtils.clamp(look.pitch - dy, -1.0, 1.1);
  } else {
    orbit.yaw -= dx * 1.2;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy, -1.3, 1.3);
  }
});
canvas.addEventListener('dblclick', () => { look.yaw = look.pitch = 0; orbit.yaw = 0; orbit.pitch = 0.12; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (view === 'third') orbit.dist = THREE.MathUtils.clamp(orbit.dist * Math.exp(e.deltaY * 0.001), 6, 400);
}, { passive: false });

function setView(v: 'first' | 'third'): void {
  view = v;
  ship.setFirstPerson(v === 'first');
  app.classList.toggle('fp', v === 'first');
  app.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  snapCamera = true;
}
app.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as 'first' | 'third')));
setView('third');

window.addEventListener('keydown', (e) => {
  if (dlg.open) return;
  if (e.key === 'Escape' && document.activeElement === inputEl) { inputEl.blur(); return; }
  if (document.activeElement === inputEl) return;
  // typing anywhere goes to the chat box
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    inputEl.focus();
  } else if (e.key === 'Enter') { e.preventDefault(); inputEl.focus(); }
});

const camPos = new THREE.Vector3();
const camQ = new THREE.Quaternion();
function updateCamera(dt: number): void {
  const sq = ship.root.quaternion;
  const shk = new THREE.Euler((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  if (view === 'first') {
    camera.position.copy(ship.cockpitEye).applyQuaternion(sq).add(ship.root.position);
    const q = sq.clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI + look.yaw))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), look.pitch))
      .multiply(new THREE.Quaternion().setFromEuler(shk));
    camera.quaternion.copy(q);
    snapCamera = false;
  } else {
    const off = new THREE.Vector3(0, 0, -orbit.dist)
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), -orbit.pitch)
      .applyAxisAngle(UP, orbit.yaw)
      .add(new THREE.Vector3(0, orbit.dist * 0.16, 0))
      .applyQuaternion(sq);
    const want = ship.root.position.clone().add(off);
    // lag behind a little so speed changes read on screen
    const k = snapCamera ? 1 : 1 - Math.exp(-dt * (phase.k === 'warp' ? 3 : 5));
    camPos.lerp(want, k);
    if (snapCamera) camPos.copy(want);
    camera.position.copy(camPos);
    const lookAt = ship.root.position.clone().add(new THREE.Vector3(0, 0.6, 3).applyQuaternion(sq));
    camera.up.copy(UP).applyQuaternion(sq);
    camera.lookAt(lookAt);
    camQ.setFromEuler(shk);
    camera.quaternion.multiply(camQ);
    snapCamera = false;
  }
  const fov = 70 + ship.warp * 32 + ship.throttle * 6 + ship.chrono * 10;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix(); }
}

// ------------------------------------------------------------------ HUD

const placeEl = $('.place'), yearEl = $('.hud-top .year');
const rMode = $('.r-mode'), rSpeed = $('.r-speed'), rDist = $('.r-dist');
const labelPool: HTMLDivElement[] = [];
const v3 = new THREE.Vector3();

function updateHud(): void {
  placeEl.textContent = phase.k === 'warp' && phase.t > phase.A + phase.B && !phase.exited ? 'In warp' : (here.body ?? here.system.name);
  yearEl.textContent = formatYear(year);
  rMode.textContent = hudMode; rSpeed.textContent = hudSpeed; rDist.textContent = hudDist;

  // labels on bodies
  const items = phase.k === 'warp' && !phase.exited && phase.t > phase.A ? [] : local.labels();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  let used = 0;
  for (const it of items) {
    v3.copy(it.pos).project(camera);
    if (v3.z > 1 || v3.z < -1) continue;
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
    if (x < -50 || x > w + 50 || y < -20 || y > h + 20) continue;
    const d = camera.position.distanceTo(it.pos);
    if (!it.star && d > 60000 && it.radius < 20) continue;
    if (it.moon && d > 2500 && it.name !== here.body) continue;
    let el = labelPool[used];
    if (!el) { el = document.createElement('div'); el.className = 'label'; labelsEl.append(el); labelPool.push(el); }
    el.hidden = false;
    el.textContent = it.name;
    el.classList.toggle('star', !!it.star);
    el.classList.toggle('here', it.name === here.body);
    const pxR = (it.radius / d) * (h / 2) / Math.tan((camera.fov * Math.PI) / 360);
    el.style.transform = `translate(${x + Math.min(pxR, 200) * 0.75 + 8}px, ${y - 8}px)`;
    used++;
  }
  for (let i = used; i < labelPool.length; i++) labelPool[i].hidden = true;
}

function showTarget(dir: THREE.Vector3, name: string, ly: number): void {
  v3.copy(camera.position).addScaledVector(dir, 1000).project(camera);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  let x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
  const behind = v3.z > 1;
  if (behind) { x = w - x; y = h - y; }
  x = THREE.MathUtils.clamp(x, 40, w - 40); y = THREE.MathUtils.clamp(y, 40, h - 40);
  targetEl.hidden = false;
  targetEl.style.transform = `translate(${x}px, ${y}px)`;
  targetEl.querySelector('.target-name')!.textContent = `${name} · ${fmtLy(ly)}`;
}

function flash(color: string): void {
  flashEl.style.background = color;
  flashEl.classList.remove('go');
  void flashEl.offsetWidth;
  flashEl.classList.add('go');
}

function fmtLy(ly: number): string {
  if (ly < 0.02) return `${(ly * 63241).toFixed(0)} AU`;
  if (ly >= 1e6) return `${(ly / 1e6).toFixed(2)} million light years`;
  if (ly >= 1000) return `${Math.round(ly).toLocaleString()} light years`;
  return `${ly < 10 ? ly.toFixed(2) : ly.toFixed(1)} light years`;
}
function fmtBig(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(1)} trillion`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (a >= 1000) return Math.round(n).toLocaleString();
  return n < 10 ? n.toFixed(2) : Math.round(n).toString();
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
let time = 0;
function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;
  tick(dt, time);
  ship.update(dt, time);
  updateCamera(dt);
  sky.update(obs, year, camera, scene);
  engine.update(ship.throttle, ship.warp, ship.chrono, ship.chronoDir, phase.k === 'time' ? clamp01(phase.t / phase.T) : 0);
  updateHud();
  composer.render();
  requestAnimationFrame(frame);
}
resize();
frame();

addMsg('ship', 'Systems online. We\'re parked over Earth. Tell me where to go, or when. Type, or hit the mic.');

// Arriving from the simulation: the hash carries a spoken-style order, words joined by
// dashes (e.g. #take-me-to-mars-in-the-year-3000), so the trip starts on its own.
const order = decodeURIComponent(location.hash.slice(1)).replace(/-/g, ' ').trim();
if (order) setTimeout(() => command(order), 1500);

// handy for poking at things from the console
Object.assign(window as any, { starship: { command, DESTINATIONS, camera, ship, sky, get local() { return local; }, scene, renderer, get year() { return year; }, get here() { return here; } } });
