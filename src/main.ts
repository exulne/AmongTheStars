import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import './style.css';
import { STAGE_NAMES } from './sim/catalog.ts';
import { SimClient, type HistoryMsg, type SimEvent, type StateMsg } from './sim/client.ts';
import { GM, HIST_FIELDS, NGM, SETTLEMENT_LABELS } from './sim/metrics.ts';
import { buildWorld } from './sim/world.ts';
import { ChartStrip, globalSeries, type Series } from './ui/charts.ts';
import { Inspector } from './ui/inspector.ts';
import { Timeline } from './ui/timeline.ts';
import { STAGE_CSS } from './view/textures.ts';
import { GalaxyView, LocalView, LEVELS, PlanetView, SystemView, UniverseView, makeSky, type Ctx, type Level, type Pickable, type Ref, type View } from './view/views.ts';

// ------------------------------------------------------------------ DOM

const app = document.getElementById('app')!;
app.innerHTML = `
  <canvas class="scene" aria-label="3D view of human space"></canvas>
  <div class="labels" aria-hidden="true"></div>
  <canvas class="xfade" aria-hidden="true"></canvas>
  <header class="top">
    <div class="intro">
      <h1>2SOON2026</h1>
      <p>Humanity lands on Mars in 2040. This is one possible next ten thousand years, simulated settlement by settlement. Drag time. Click anything. Double-click, or scroll into it, to go closer.</p>
      <nav class="crumbs" aria-label="Zoom level"></nav>
    </div>
    <div class="run">
      <label for="seed">Future #</label><input id="seed" inputmode="numeric" value="1" size="6">
      <button id="reroll" class="link" type="button">Another future</button>
      <span class="status num" aria-live="polite"></span>
    </div>
  </header>
  <div class="legend" aria-label="Settlement stages">${STAGE_NAMES.map((n, i) => `<span><i style="background:${STAGE_CSS[i]}"></i>${n}</span>`).join('')}</div>
  <div class="tooltip" hidden></div>
  <footer class="bottom">
    <button class="charts-toggle link" type="button" aria-expanded="true">Hide charts</button>
  </footer>`;

const canvas = app.querySelector<HTMLCanvasElement>('canvas.scene')!;
const labelsEl = app.querySelector<HTMLElement>('.labels')!;
const xfade = app.querySelector<HTMLCanvasElement>('canvas.xfade')!;
const crumbsEl = app.querySelector<HTMLElement>('.crumbs')!;
const statusEl = app.querySelector<HTMLElement>('.status')!;
const tooltip = app.querySelector<HTMLElement>('.tooltip')!;
const seedInput = app.querySelector<HTMLInputElement>('#seed')!;
const bottom = app.querySelector<HTMLElement>('.bottom')!;

const timeline = new Timeline();
const inspector = new Inspector();
app.append(inspector.el);
const charts = new ChartStrip(['pop', 'energy', 'gdp', 'systems', 'era'], () =>
  ctx.selected?.kind === 'body' ? HIST_FIELDS.map((f) => ({ key: `s:${f}`, label: `${ctx.world.bodies[ctx.selected!.id].name}: ${SETTLEMENT_LABELS[f]![0]}` })) : []);
bottom.prepend(timeline.el);
bottom.append(charts.el);
new ResizeObserver(() => app.style.setProperty('--bottom-h', `${bottom.offsetHeight}px`)).observe(bottom);
const chartsToggle = app.querySelector<HTMLButtonElement>('.charts-toggle')!;
chartsToggle.addEventListener('click', () => {
  const hide = !charts.el.hidden;
  charts.el.hidden = hide;
  chartsToggle.textContent = hide ? 'Show charts' : 'Hide charts';
  chartsToggle.setAttribute('aria-expanded', String(!hide));
});

// ------------------------------------------------------------------ 3D

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020204);
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1e7);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 1.3;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.15, 0.65, 0.12);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ------------------------------------------------------------------ state

const world = buildWorld();
const sim = new SimClient();
const ctx: Ctx = { world, snap: null, year: 0, camera, controls, system: 0, body: world.mars, selected: null, t: 0 };
let events: SimEvent[] = [];
let history: HistoryMsg | null = null;

const views: Record<Level, View> = {
  universe: new UniverseView(),
  galaxy: new GalaxyView(world),
  local: new LocalView(world),
  system: new SystemView(),
  planet: new PlanetView(),
};
const sky = makeSky(1, 7000);
scene.add(sky);
for (const v of Object.values(views)) { v.group.visible = false; scene.add(v.group); }
let level: Level = 'system';

function enterLevel(next: Level): void {
  views[level].group.visible = false;
  level = next;
  const v = views[level];
  v.group.visible = true;
  sky.visible = level === 'galaxy' || level === 'local';
  v.enter(ctx);
  v.sync(ctx);
  controls.minDistance = v.limits[0];
  controls.maxDistance = v.limits[1];
  renderCrumbs();
}

// ------------------------------------------------------------------ camera flights

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
interface Flight { t0: THREE.Vector3; t1: THREE.Vector3; d0: THREE.Vector3; q: THREE.Quaternion; l0: number; l1: number; t: number; dur: number; ease: (x: number) => number; done?: () => void }
let flight: Flight | null = null;
const qI = new THREE.Quaternion(), qK = new THREE.Quaternion();

/** Ease the camera to a new pose: target moves straight, distance changes in log space, direction slerps. */
function fly(pos: THREE.Vector3, target: THREE.Vector3, dur: number, ease: (x: number) => number, done?: () => void): void {
  const o0 = camera.position.clone().sub(controls.target), o1 = pos.clone().sub(target);
  const l0 = Math.max(o0.length(), 1e-6), l1 = Math.max(o1.length(), 1e-6);
  const d0 = o0.divideScalar(l0);
  flight = { t0: controls.target.clone(), t1: target.clone(), d0, q: new THREE.Quaternion().setFromUnitVectors(d0, o1.divideScalar(l1)), l0, l1, t: 0, dur, ease, done };
  controls.enabled = false;
}

function stepFlight(dt: number): void {
  const f = flight!;
  f.t += dt;
  const k = f.ease(Math.min(1, f.t / f.dur));
  controls.target.lerpVectors(f.t0, f.t1, k);
  qK.slerpQuaternions(qI, f.q, k);
  camera.position.copy(f.d0).applyQuaternion(qK).multiplyScalar(Math.exp(Math.log(f.l0) + (Math.log(f.l1) - Math.log(f.l0)) * k)).add(controls.target);
  camera.lookAt(controls.target);
  if (f.t < f.dur) return;
  flight = null;
  controls.enabled = true;
  // drop any damping momentum from before the flight
  const c = controls as unknown as { _sphericalDelta: THREE.Spherical; _panOffset: THREE.Vector3; _scale: number };
  c._sphericalDelta.set(0, 0, 0); c._panOffset.set(0, 0, 0); c._scale = 1;
  f.done?.();
}

/** The outgoing frame, drawn into a 2D canvas that scales and fades over the new view. */
function crossfade(deeper: boolean): void {
  composer.render();
  if (xfade.width !== canvas.width || xfade.height !== canvas.height) { xfade.width = canvas.width; xfade.height = canvas.height; }
  const g = xfade.getContext('2d')!;
  g.clearRect(0, 0, xfade.width, xfade.height);
  g.drawImage(canvas, 0, 0);
  xfade.style.transition = 'none';
  xfade.style.opacity = '1';
  xfade.style.transform = 'scale(1)';
  void xfade.offsetWidth;
  xfade.style.transition = '';
  xfade.style.opacity = '0';
  xfade.style.transform = `scale(${deeper ? 1.7 : 0.62})`;
}

/** What the current level is "about", so the next level up can start the camera there. */
function levelRef(l: Level): Ref {
  return l === 'planet' ? { kind: 'body', id: ctx.body } : l === 'system' ? { kind: 'system', id: ctx.system } : l === 'local' ? { kind: 'humanspace', id: 0 } : { kind: 'galaxy', id: 0, name: 'Milky Way' };
}

let busy = false;
let queued: (() => void) | null = null;
/**
 * Go to a level. Deeper: fly into `focus`, swap, then settle in from far out.
 * Up: swap and pull back from where we were. `prep` retargets ctx at the swap.
 */
function setLevel(next: Level, focus: Ref | null = null, prep?: () => void, animate = true): void {
  if (busy) { queued = () => setLevel(next, focus, prep, animate); return; }
  if (!animate || reducedMotion) { prep?.(); enterLevel(next); controls.update(); return; }
  busy = true;
  const from = level;
  const deeper = LEVELS.indexOf(next) >= LEVELS.indexOf(from);
  const was = levelRef(from);
  const swap = () => {
    crossfade(deeper);
    prep?.();
    enterLevel(next);
    const endPos = camera.position.clone(), endT = controls.target.clone();
    const off = endPos.clone().sub(endT);
    if (deeper) {
      camera.position.copy(endT).addScaledVector(off, 4.5);
    } else {
      const at = views[next].locate(ctx, was) ?? endT;
      controls.target.copy(at);
      camera.position.copy(at).addScaledVector(off, 0.035);
    }
    camera.lookAt(controls.target);
    fly(endPos, endT, deeper ? 1.15 : 1.3, deeper ? easeOut : easeInOut, () => {
      busy = false;
      const q = queued; queued = null; q?.();
    });
  };
  const here = deeper && focus ? views[from].locate(ctx, focus) : null;
  if (here) {
    const p = here.clone();
    fly(p.clone().add(camera.position.clone().sub(p).multiplyScalar(0.07)), p, 0.6, easeInOut, swap);
  } else swap();
}

function renderCrumbs(): void {
  const names: Record<Level, string> = {
    universe: 'Local Group', galaxy: 'Milky Way', local: 'Nearby stars',
    system: world.systems[ctx.system].name, planet: world.bodies[ctx.body].name,
  };
  const idx = LEVELS.indexOf(level);
  crumbsEl.innerHTML = LEVELS.slice(0, idx + 1)
    .map((l, i) => i === idx ? `<span aria-current="page">${names[l]}</span>` : `<button class="link" type="button" data-level="${l}">${names[l]}</button>`)
    .join('<span class="sep" aria-hidden="true">/</span>');
}
crumbsEl.addEventListener('click', (e) => {
  const l = (e.target as HTMLElement).dataset.level as Level | undefined;
  if (l) { pull = null; setLevel(l); }
});

function dive(p: Ref): void {
  if (p.kind === 'galaxy' && (p.name ?? '') === 'Milky Way') setLevel('galaxy', p);
  else if (p.kind === 'humanspace') setLevel('local', p);
  else if (p.kind === 'system') setLevel('system', p, () => { ctx.system = p.id; });
  else if (p.kind === 'body') setLevel('planet', p, () => { ctx.body = p.id; ctx.system = world.bodies[p.id].system; });
}

function select(p: Pickable | null): void {
  ctx.selected = p;
  history = null;
  if (p?.kind === 'body' || p?.kind === 'city') {
    const id = p.kind === 'body' ? p.id : ctx.body;
    sim.history(id).then((h) => { history = h; refreshPanels(); });
  }
  refreshEvents();
  refreshPanels();
}
inspector.onSelect = (p) => select(p);
inspector.onDive = (p) => { select(p); dive(p); };

// Wheel out past the outer limit goes up a level. Wheel in over a thing pulls
// it to the centre of the view, and once close enough enters it.
let pull: Ref | null = null, lastWheel = 0;
canvas.addEventListener('wheel', (e) => {
  if (busy) return;
  const gesture = e.timeStamp - lastWheel < 700;
  lastWheel = e.timeStamp;
  const v = views[level];
  if (e.deltaY > 0) {
    pull = null;
    const i = LEVELS.indexOf(level);
    if (i > 0 && camera.position.distanceTo(controls.target) >= v.limits[1] * 0.97) setLevel(LEVELS[i - 1]);
    return;
  }
  // within one gesture keep pulling the same thing even as it slides out from under the cursor
  const keep = pull && v.locate(ctx, pull) ? pull : null;
  const sel = ctx.selected && v.locate(ctx, ctx.selected) ? ctx.selected : null;
  const p: Ref | null = (gesture && keep) || pickAt(e.clientX, e.clientY) || keep || sel;
  if (!p || level === 'planet') return;
  pull = p;
  const at = v.locate(ctx, p);
  const dd = v.diveDist(ctx, p);
  if (at && dd > 0 && camera.position.distanceTo(at) < Math.max(dd, v.limits[0] * 1.4)) { pull = null; select(asPick(p)); dive(p); }
}, { passive: true });
canvas.addEventListener('pointerdown', () => { pull = null; });

function asPick(r: Ref): Pickable {
  const name = r.kind === 'system' ? world.systems[r.id].name : r.kind === 'body' ? world.bodies[r.id].name : r.kind === 'humanspace' ? 'Human space' : r.name ?? '';
  return { kind: r.kind, id: r.id, name, pos: new THREE.Vector3() };
}

// ------------------------------------------------------------------ picking

const proj = new THREE.Vector3();
function pickAt(x: number, y: number): Pickable | null {
  const r = canvas.getBoundingClientRect();
  let best: Pickable | null = null, bestD = 16;
  for (const p of views[level].pickables(ctx)) {
    proj.copy(p.pos).project(camera);
    if (proj.z > 1) continue;
    const sx = (proj.x * 0.5 + 0.5) * r.width, sy = (-proj.y * 0.5 + 0.5) * r.height;
    const d = Math.hypot(sx - (x - r.left), sy - (y - r.top));
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
let downAt = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', (e) => {
  const p = pickAt(e.clientX, e.clientY);
  tooltip.hidden = !p;
  if (p) { tooltip.textContent = p.name; tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`; }
  canvas.style.cursor = p ? 'pointer' : '';
});
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const p = pickAt(e.clientX, e.clientY);
  if (p) select(p);
});
canvas.addEventListener('dblclick', (e) => {
  if (busy) return;
  const p = pickAt(e.clientX, e.clientY);
  if (p) { select(p); dive(p); }
});

// ------------------------------------------------------------------ labels

const labelPool: HTMLElement[] = [];
function drawLabels(): void {
  const list = views[level].labels(ctx);
  const r = canvas.getBoundingClientRect();
  let n = 0;
  for (const l of list) {
    proj.copy(l.pos).project(camera);
    if (proj.z > 1 || Math.abs(proj.x) > 1.05 || Math.abs(proj.y) > 1.05) continue;
    let el = labelPool[n];
    if (!el) { el = document.createElement('div'); el.className = 'label'; labelsEl.append(el); labelPool.push(el); }
    const html = `<b>${l.text}</b>${l.sub ? `<span>${l.sub}</span>` : ''}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('strong', !!l.strong);
    el.style.transform = `translate(${((proj.x * 0.5 + 0.5) * r.width).toFixed(1)}px, ${((-proj.y * 0.5 + 0.5) * r.height).toFixed(1)}px)`;
    el.hidden = false;
    n++;
  }
  for (let i = n; i < labelPool.length; i++) labelPool[i].hidden = true;
}

// ------------------------------------------------------------------ sim wiring

let inFlight = false, wanted = -1, lastStep = -1;
function requestState(year: number): void {
  if (!sim.years.length) return;
  const step = sim.stepAt(year);
  if (step === lastStep && !inFlight) return;
  wanted = step;
  if (inFlight) return;
  inFlight = true;
  const ask = wanted;
  sim.state(ask).then((m: StateMsg) => {
    inFlight = false;
    lastStep = m.step;
    ctx.snap = m;
    views[level].sync(ctx);
    timeline.setEra(m.globals.era);
    refreshPanels();
    if (wanted !== ask) requestState(sim.years[wanted]);
    else refreshEvents();
  });
}

let evTimer = 0;
function refreshEvents(): void {
  clearTimeout(evTimer);
  evTimer = window.setTimeout(() => {
    const p = ctx.selected;
    const body = p?.kind === 'body' ? p.id : p?.kind === 'city' ? ctx.body : undefined;
    sim.events(body === undefined ? ctx.year - 300 : 0, ctx.year, body, 40).then((e) => { events = e; refreshPanels(); });
  }, 120);
}

function refreshPanels(): void {
  const step = Math.max(0, sim.stepAt(ctx.year));
  inspector.render({
    world, snap: ctx.snap, year: ctx.year, selected: ctx.selected, body: ctx.body, events, history,
    globalRow: (col) => sim.series[step * NGM + col],
  });
  charts.setYear(ctx.year);
}

charts.setSource((key): Series | null => {
  if (key.startsWith('s:')) {
    if (!history) return null;
    const f = key.slice(2) as (typeof HIST_FIELDS)[number];
    const ys = history.steps.map((s) => sim.years[s]);
    const lab = SETTLEMENT_LABELS[f]!;
    return { years: ys, n: ys.length, def: { key, label: lab[0], unit: lab[1], log: ['pop', 'energy', 'gdp', 'research', 'water', 'metals'].includes(f), group: '' }, values: (i) => history!.cols[f][i] };
  }
  return globalSeries(sim.years, sim.series, sim.frontier, key);
});
charts.onPickYear = (y) => timeline.set(y, true);

timeline.onChange = (y) => {
  ctx.year = y;
  requestState(y);
  charts.setYear(y);
};

sim.onProgress = () => {
  const era = GM.era;
  timeline.setData(sim.done ? 10000 : sim.years[sim.frontier], { years: sim.years, n: sim.frontier + 1, era: (i) => sim.series[i * NGM + era] });
  statusEl.textContent = sim.done ? `simulated in ${(sim.ms / 1000).toFixed(1)}s` : `simulating… year ${Math.round(sim.years[sim.frontier]).toLocaleString('en-US')}`;
  charts.draw();
  if (!ctx.snap) requestState(0);
};

function startRun(seed: number): void {
  ctx.snap = null; lastStep = -1; events = []; history = null;
  sim.run(seed);
  timeline.set(0);
  ctx.year = 0;
  try { location.hash = `future${seed}`; } catch { /* sandboxed frames may refuse */ }
}
seedInput.addEventListener('change', () => startRun(Math.max(1, Math.floor(Number(seedInput.value)) || 1)));
app.querySelector('#reroll')!.addEventListener('click', () => {
  const s = 1 + Math.floor(Math.random() * 99999);
  seedInput.value = String(s);
  startRun(s);
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') { e.preventDefault(); timeline.toggle(); }
  if (e.key === 'Escape') select(null);
});

// ------------------------------------------------------------------ go

const fromHash = Number(location.hash.match(/future(\d+)/)?.[1]);
if (fromHash) seedInput.value = String(fromHash);
startRun(fromHash || 1);
setLevel('system', null, undefined, false);

let last = performance.now(), frame = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  ctx.t += dt;
  timeline.tick(dt);
  if (flight) stepFlight(dt);
  else {
    // wheel-in target drifts to the thing under the cursor
    const at = pull ? views[level].locate(ctx, pull) : null;
    if (at) controls.target.lerp(at, 1 - Math.exp(-dt * 6));
    controls.update();
  }
  views[level].frame(ctx, dt);
  sky.position.copy(camera.position);
  composer.render();
  if (frame++ % 2 === 0) drawLabels();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (import.meta.env.DEV) Object.assign(window, { __app: { ctx, views, setLevel, dive, select, timeline, camera, controls, get level() { return level; } } });
