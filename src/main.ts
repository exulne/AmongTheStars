import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import './style.css';
import { EVENT_NAMES, STAGE_NAMES, TECHS } from './sim/catalog.ts';
import { forecast, type Forecast } from './ml/forecaster.ts';
import { fanFor, oddsHtml } from './ui/psychohistory.ts';
import { SimClient, type HistoryMsg, type SimEvent, type StateMsg } from './sim/client.ts';
import { F, GM, HIST_FIELDS, NF, NGM, SETTLEMENT_LABELS } from './sim/metrics.ts';
import { GALAXIES, buildWorld } from './sim/world.ts';
import { ChartStrip, globalSeries, type Series } from './ui/charts.ts';
import { fmtNum, fmtYear, parseCount } from './ui/format.ts';
import { Inspector } from './ui/inspector.ts';
import { DataPanel } from './ui/dataPanel.ts';
import { Search, type Hit } from './ui/search.ts';
import { NOTABLE, Ticker, describe } from './ui/ticker.ts';
import { Timeline } from './ui/timeline.ts';
import { AGE_CSS, COLOR_MODES, HEAT_CSS, factionCss, stageLegend, type ColorMode } from './view/colorModes.ts';
import { StreetView } from './view/street.ts';
import { GalaxyView, LocalView, LEVELS, PlanetView, SystemView, UniverseView, alive, makeSky, popOf, stageOf, systemSummary, type Ctx, type Level, type Pickable, type Ref, type View } from './view/views.ts';

// ------------------------------------------------------------------ DOM

const app = document.getElementById('app')!;
app.innerHTML = `
  <canvas class="scene" aria-label="3D view of human space"></canvas>
  <div class="labels" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>
  <canvas class="xfade" aria-hidden="true"></canvas>
  <header class="top">
    <div class="intro">
      <h1>2SOON2026</h1>
      <p>Humanity lands on Mars in 2040. This is one possible next ten thousand years, simulated settlement by settlement. Drag time. Click anything. Double-click, or scroll into it, to go closer. Press ? for keys.</p>
      <nav class="crumbs" aria-label="Zoom level"></nav>
    </div>
    <div class="run">
      <div class="search-slot"></div>
      <label for="seed">Future #</label><input id="seed" inputmode="numeric" value="1" size="6">
      <button id="reroll" class="link" type="button">Another future</button>
      <button id="chronicle" class="link" type="button">Chronicle</button>
      <button id="data" class="link" type="button" aria-pressed="false">Data</button>
      <span class="status num" aria-live="polite"></span>
    </div>
  </header>
  <div class="legend">
    <div class="legend-modes" role="group" aria-label="Colour settled stars by">Colour by ${COLOR_MODES.map((m) => `<button class="link" type="button" data-mode="${m.id}" aria-pressed="${m.id === 'stage'}">${m.label}</button>`).join(' ')}</div>
    <div class="legend-keys"></div>
  </div>
  <div class="sel-ring" aria-hidden="true" hidden><i></i><i></i></div>
  <div class="tooltip" hidden></div>
  <footer class="bottom">
    <div class="charts-toggles"><button class="forecast-toggle link" type="button" aria-pressed="true" title="A transformer trained on 360 other futures guesses the next 400 years">Forecast on</button><button class="charts-toggle link" type="button" aria-expanded="true">Hide charts</button></div>
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
const ticker = new Ticker();
timeline.el.querySelector('.tl-row')!.append(ticker.el);
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
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.55);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  camera.aspect = w / h;
  frameOffset();
}

/**
 * Shift the projection so the middle of every view sits in the open area, left
 * of the inspector and above the bottom panel. The orbit pivot doesn't move.
 */
function frameOffset(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || !inspectorEl || !bottomEl) { camera.updateProjectionMatrix(); return; }
  const ir = inspectorEl.getBoundingClientRect();
  const side = ir.height > h * 0.5 ? ir.width : 0; // a bottom sheet on phones takes no side room
  const below = bottomEl.offsetHeight + (side ? 0 : Math.max(0, h - bottomEl.offsetHeight - ir.top));
  camera.setViewOffset(w, h, side / 2, Math.max(0, below - 70) / 2, w, h);
  camera.updateProjectionMatrix();
}
let inspectorEl: HTMLElement | null = null, bottomEl: HTMLElement | null = null;
new ResizeObserver(resize).observe(canvas);

// If frames stay slow (under ~40 fps for two seconds), render fewer pixels. Only ever steps down:
// on a 60 Hz screen frame times can't show spare headroom, so stepping back up would oscillate.
let pixelRatio = Math.min(window.devicePixelRatio, 2), frameEma = 1 / 60, slowFor = 0;
function govern(dt: number): void {
  if (document.hidden || flight || pixelRatio <= 1) return;
  frameEma += (dt - frameEma) * 0.05;
  slowFor = frameEma > 1 / 40 ? slowFor + dt : 0;
  if (slowFor < 2) return;
  pixelRatio = Math.max(1, pixelRatio - 0.5);
  renderer.setPixelRatio(pixelRatio);
  composer.setPixelRatio(pixelRatio);
  resize();
  slowFor = 0; frameEma = 1 / 60;
}

// ------------------------------------------------------------------ state

const world = buildWorld();
const sim = new SimClient();
const ctx: Ctx = { world, snap: null, year: 0, camera, controls, system: 0, body: world.mars, selected: null, t: 0, tm: 0, colorBy: 'stage', city: 0 };
let events: SimEvent[] = [];
let history: HistoryMsg | null = null;
const dataPanel = new DataPanel({
  world, sim, year: () => ctx.year,
  selectBody: (b) => select(asPick({ kind: 'body', id: b })),
  selectedBody: () => (ctx.selected?.kind === 'body' ? ctx.selected.id : -1),
});
app.append(dataPanel.el);
const dataBtn = app.querySelector<HTMLButtonElement>('#data')!;
dataBtn.addEventListener('click', () => { dataPanel.toggle(); dataBtn.setAttribute('aria-pressed', String(dataPanel.open)); });
dataPanel.onClose = () => dataBtn.setAttribute('aria-pressed', 'false');

const views: Record<Level, View> = {
  universe: new UniverseView(),
  galaxy: new GalaxyView(world),
  local: new LocalView(world),
  system: new SystemView(),
  planet: new PlanetView(),
  street: new StreetView((b, y, o, n) => sim.residents(b, y, o, n)),
};
const street = views.street as StreetView;
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
  renderLegend();
  writeHash();
  streetMood();
}

// ------------------------------------------------------------------ legend and colour modes

const legendEl = app.querySelector<HTMLElement>('.legend')!;
const legendModes = legendEl.querySelector<HTMLElement>('.legend-modes')!;
const legendKeys = legendEl.querySelector<HTMLElement>('.legend-keys')!;

function legendHtml(mode: ColorMode): string {
  if (mode === 'heat') return `<span class="ramp" style="--g:${HEAT_CSS}"></span><span class="ramp-ends num"><span>1</span><span>people per system</span><span>40B</span></span>`;
  if (mode === 'founded') return `<span class="ramp" style="--g:${AGE_CSS}"></span><span class="ramp-ends num"><span>2040</span><span>first settled</span><span>${Math.round(2040 + ctx.year)}</span></span>`;
  if (mode === 'faction') {
    const facs = new Map<number, number>();
    const snap = ctx.snap;
    if (snap) for (const b of snap.settled) if (alive(stageOf(snap, b))) { const f = snap.S[b * NF + F.faction]; facs.set(f, (facs.get(f) ?? 0) + popOf(snap, b)); }
    const top = [...facs].sort((a, b) => b[1] - a[1]);
    const name = (f: number) => (f === world.earth ? 'Earth' : world.bodies[f].name);
    return top.slice(0, 8).map(([f, pop]) => `<span><i style="background:${factionCss(f, world.earth)}"></i>${name(f)} <span class="num">${fmtNum(pop)}</span></span>`).join('')
      + (top.length > 8 ? `<span class="more">and ${top.length - 8} more</span>` : '');
  }
  return stageLegend();
}

function renderLegend(): void {
  const modal = level === 'local' || level === 'galaxy';
  legendModes.hidden = !modal;
  const html = legendHtml(modal ? ctx.colorBy : 'stage');
  if (legendKeys.innerHTML !== html) legendKeys.innerHTML = html;
}

legendModes.addEventListener('click', (e) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as ColorMode | undefined;
  if (!m) return;
  ctx.colorBy = m;
  for (const b of legendModes.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  views[level].sync(ctx);
  renderLegend();
});

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
  if (l === 'street') return { kind: 'city', id: ctx.city };
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
    street: ctx.city === 0 ? 'Capital' : `Settlement ${ctx.city}`,
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
  if (p.kind === 'galaxy' && (p.name ?? GALAXIES[p.id]?.name) !== 'Milky Way') {
    // no deeper level for other galaxies yet: frame it in the Local Group
    const at = level === 'universe' ? views.universe.locate(ctx, p) : null;
    if (at && !busy) fly(at.clone().add(camera.position.clone().sub(at).setLength(GALAXIES[p.id].radius / 10000 * 3 * 4)), at, 1.1, easeInOut);
    else if (level !== 'universe') setLevel('universe');
    return;
  }
  if (p.kind === 'galaxy') setLevel('galaxy', p);
  else if (p.kind === 'humanspace') setLevel('local', p);
  else if (p.kind === 'system') setLevel('system', p, () => { ctx.system = p.id; });
  else if (p.kind === 'body') setLevel('planet', p, () => { ctx.body = p.id; ctx.system = world.bodies[p.id].system; });
  else if (p.kind === 'city' && level === 'planet') setLevel('street', p, () => { ctx.city = p.id; });
}

function fetchHistory(): void {
  const p = ctx.selected;
  if (p?.kind !== 'body' && p?.kind !== 'city') return;
  const id = p.kind === 'body' ? p.id : ctx.body, g = runGen;
  sim.history(id).then((h) => { if (g !== runGen || ctx.selected !== p) return; history = h; charts.draw(); refreshPanels(); });
}

function select(p: Pickable | null): void {
  const changed = p?.kind !== ctx.selected?.kind || p?.id !== ctx.selected?.id;
  ctx.selected = p;
  history = null;
  fetchHistory();
  charts.refreshOptions();
  refreshEvents();
  refreshPanels();
  if (changed) inspector.toTop();
  if (changed) inspector.el.classList.toggle('open', !!p);
  writeHash();
}
inspector.api = {
  chronicle: (f, t, o) => sim.chronicle(f, t, o),
  inventions: () => sim.inventions(),
  society: (b, y) => sim.society(b, sim.stepAt(y)),
  residents: (b, y, o, n) => sim.residents(b, y, o, n),
  person: (id, y) => sim.person(id, y),
  residentAt: (b, y, k) => sim.residentAt(b, y, k),
};
inspector.onSelect = (p) => select(p);
inspector.onYear = (y) => timeline.set(y, true);
app.querySelector('#chronicle')!.addEventListener('click', () => {
  inspector.chronicleOpen = !inspector.chronicleOpen;
  if (inspector.chronicleOpen) inspector.openPerson(null);
  inspector.el.classList.add('open');
  inspector.toTop();
  refreshPanels();
});
inspector.onClose = () => select(null);
// on phones the inspector is a bottom sheet: the grab bar folds it down to its title
const grab = document.createElement('button');
grab.className = 'insp-grab';
grab.type = 'button';
grab.setAttribute('aria-label', 'Show or hide details');
grab.addEventListener('click', () => inspector.el.classList.toggle('open'));
inspector.el.prepend(grab);
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
  if (!p || level === 'street' || (level === 'planet' && p.kind !== 'city')) return;
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
    const reach = p.r ? Math.max(16, (p.r / (camera.position.distanceTo(p.pos) * Math.tan((camera.fov * Math.PI) / 360))) * (r.height / 2)) : 16;
    if (d > reach) continue;
    const score = d - (p.weight ?? 0);
    if (score < bestD) { bestD = score; best = p; }
  }
  return best;
}
let downAt = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
let hovering = false, motion = 1;
canvas.addEventListener('pointerleave', () => { hovering = false; tooltip.hidden = true; });
canvas.addEventListener('pointermove', (e) => {
  const p = pickAt(e.clientX, e.clientY);
  hovering = !!p;
  tooltip.hidden = !p;
  if (p) { tooltip.textContent = p.name; tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`; }
  canvas.style.cursor = p ? 'pointer' : '';
});
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const p = pickAt(e.clientX, e.clientY);
  if (p?.kind === 'person') openResident(p.id);
  else if (p) select(p);
  else if (level === 'street') street.follow = -1;
});

/** A resident dot in the street view: their biography opens in the inspector. */
function openResident(k: number): void {
  const id = street.personId(k);
  if (!id) return;
  street.focus = k;
  street.follow = k;
  inspector.openPerson(id);
  inspector.el.classList.add('open');
}
canvas.addEventListener('dblclick', (e) => {
  if (busy) return;
  const p = pickAt(e.clientX, e.clientY);
  if (p?.kind === 'person') openResident(p.id);
  else if (p) { select(p); dive(p); }
});

// ------------------------------------------------------------------ labels

// Keyed by what they name so an element keeps its text as the set changes.
// Greedy by priority: a label is drawn only if its box hits no higher-priority
// label and no panel. Labels shown last time get a bonus so they don't flicker.
interface LabelEl { el: HTMLElement; html: string; w: number; h: number; ref?: Ref; shown: boolean }
const labelEls = new Map<string, LabelEl>();
const occluders: DOMRect[] = [];
function measureOccluders(): void {
  occluders.length = 0;
  for (const el of [inspector.el, bottom, app.querySelector<HTMLElement>('.intro')!, app.querySelector<HTMLElement>('.run')!, legendEl]) {
    if (el.offsetParent !== null || el === bottom) occluders.push(el.getBoundingClientRect());
  }
}
const occRO = new ResizeObserver(measureOccluders);
occRO.observe(document.body); occRO.observe(inspector.el); occRO.observe(bottom); occRO.observe(legendEl);
inspectorEl = inspector.el; bottomEl = bottom;
new ResizeObserver(frameOffset).observe(inspector.el);
new ResizeObserver(frameOffset).observe(bottom);
const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
function drawLabels(): void {
  const list = views[level].labels(ctx);
  const r = canvas.getBoundingClientRect();
  if (!occluders.length) measureOccluders();
  const cand: { l: (typeof list)[number]; key: string; x: number; y: number; p: number }[] = [];
  for (const l of list) {
    proj.copy(l.pos).project(camera);
    if (proj.z > 1 || Math.abs(proj.x) > 1.05 || Math.abs(proj.y) > 1.05) continue;
    const key = l.ref ? `${l.ref.kind}:${l.ref.id}` : l.text;
    cand.push({ l, key, x: (proj.x * 0.5 + 0.5) * r.width, y: (-proj.y * 0.5 + 0.5) * r.height, p: (l.prio ?? (l.strong ? 10 : 0)) + (labelEls.get(key)?.shown ? 1.5 : 0) });
  }
  cand.sort((a, b) => b.p - a.p);
  placed.length = 0;
  const used = new Set<string>();
  for (const c of cand) {
    let e = labelEls.get(c.key);
    const html = `<b>${c.l.text}</b>${c.l.sub ? `<span>${c.l.sub}</span>` : ''}`;
    if (!e) {
      const el = document.createElement('div');
      el.className = 'label';
      labelsEl.append(el);
      e = { el, html: '', w: 0, h: 0, shown: false };
      labelEls.set(c.key, e);
    }
    e.ref = c.l.ref;
    if (e.html !== html) {
      e.el.innerHTML = html; e.html = html;
      // estimated from glyph counts so placement never forces a layout
      e.w = 10 + Math.max(c.l.text.length * 6, (c.l.sub?.length ?? 0) * 6); e.h = c.l.sub ? 26 : 15;
    }
    // try the label to the right of its point, then to the left
    const fits = (x0: number, x1: number) => {
      const b = { x0, y0: c.y - e!.h * 0.45, x1, y1: c.y + e!.h * 0.6 };
      if (b.y0 < 4 || b.x0 < 4 || b.x1 > r.width - 4) return null;
      if (occluders.some((o) => r.left + b.x1 > o.left && r.left + b.x0 < o.right && r.top + b.y1 > o.top && r.top + b.y0 < o.bottom)) return null;
      for (const q of placed) if (b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0) return null;
      return b;
    };
    const right = fits(c.x - 4, c.x + e.w);
    const box = right ?? fits(c.x - e.w, c.x + 4);
    if (!box) continue;
    e.el.classList.toggle('left', !right);
    placed.push(box);
    used.add(c.key);
    e.el.classList.toggle('strong', !!c.l.strong);
    e.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
  }
  for (const [k, e] of labelEls) {
    const on = used.has(k);
    if (on !== e.shown || e.el.hidden === on) { e.el.hidden = !on; e.shown = on; }
  }
  if (labelEls.size > 400) for (const [k, e] of labelEls) if (!e.shown) { e.el.remove(); labelEls.delete(k); }
}

function labelRef(t: EventTarget | null): Ref | undefined {
  const el = (t as HTMLElement).closest<HTMLElement>('.label');
  for (const e of labelEls.values()) if (e.el === el) return e.ref;
  return undefined;
}
labelsEl.addEventListener('click', (e) => { const ref = labelRef(e.target); if (ref) select(asPick(ref)); });
labelsEl.addEventListener('dblclick', (e) => { const ref = labelRef(e.target); if (ref && !busy) { select(asPick(ref)); dive(ref); } });

// ------------------------------------------------------------------ street mood

/** War, plague, shortage or a golden age, read from the settlement and recent events, sets how busy the streets are. */
function streetMood(): void {
  if (level !== 'street' || !ctx.snap) return;
  const b = ctx.body, S = ctx.snap.S, o = b * NF, era = ctx.snap.globals.era, g = runGen;
  sim.events(ctx.year - 15, ctx.year, b, 40).then((evs) => {
    if (g !== runGen || !ctx.snap) return;
    const has = (n: string) => evs.some((e) => EVENT_NAMES[e.type] === n);
    const war = era === 'War' || has('War');
    const plague = era === 'Pandemic' || has('Plague');
    const short = S[o + F.shortage] > 0.15 || has('Famine');
    const happy = S[o + F.happiness], stab = S[o + F.stability];
    let activity = 0.55 + 0.4 * Math.min(1, happy * stab * 1.6);
    if (war) activity *= 0.55;
    if (plague) activity *= 0.45;
    if (era === 'Collapse') activity *= 0.5;
    if (short) activity *= 0.8;
    const leisure = era === 'Golden Age' || era === 'Renaissance' ? 0.7 : 0.2 + 0.3 * happy;
    street.setMood({ activity, leisure, war, plague, queue: short, faith: S[o + F.culture] > 0 });
  });
  // the place's whole past, for monuments and ruins
  sim.events(0, ctx.year, b, 400).then((evs) => {
    if (g !== runGen) return;
    const ever = (n: string) => evs.some((e) => EVENT_NAMES[e.type] === n && e.body === b);
    const recent = (n: string) => evs.some((e) => EVENT_NAMES[e.type] === n && e.body === b && e.year > ctx.year - 80);
    street.setHistory({ independence: ever('Independence'), speciation: ever('Speciation'), collapse: recent('Collapse') || era === 'Collapse' });
    street.sync(ctx);
  });
}

// ------------------------------------------------------------------ selection ring

const ringEl = app.querySelector<HTMLElement>('.sel-ring')!;
function drawRing(): void {
  const v = views[level];
  // in its own view the planet is the subject; a ring around it is just noise
  const own = level === 'planet' && ctx.selected?.kind === 'body';
  const at = ctx.selected && !own ? v.locate(ctx, ctx.selected) : null;
  if (!at) { ringEl.hidden = true; return; }
  proj.copy(at).project(camera);
  if (proj.z > 1) { ringEl.hidden = true; return; }
  const r = canvas.getBoundingClientRect();
  const worldR = v.size?.(ctx, ctx.selected!) ?? 0;
  const d = camera.position.distanceTo(at);
  const px = worldR ? (worldR / (d * Math.tan((camera.fov * Math.PI) / 360))) * (r.height / 2) : 0;
  const R = Math.min(Math.max(px + 6, 13), Math.max(r.width, r.height));
  ringEl.hidden = false;
  ringEl.style.transform = `translate(${((proj.x * 0.5 + 0.5) * r.width).toFixed(1)}px, ${((-proj.y * 0.5 + 0.5) * r.height).toFixed(1)}px)`;
  ringEl.style.setProperty('--r', `${R.toFixed(1)}px`);
}

// ------------------------------------------------------------------ sim wiring

// runGen tags every request so replies from a previous future are dropped
let inFlight = false, wanted = -1, lastStep = -1, runGen = 0;
function requestState(year: number): void {
  if (!sim.years.length) return;
  const step = sim.stepAt(year);
  if (step === lastStep && !inFlight) return;
  wanted = step;
  if (inFlight) return;
  inFlight = true;
  const ask = wanted, g = runGen;
  sim.state(ask).then((m: StateMsg) => {
    if (g !== runGen) return;
    inFlight = false;
    lastStep = m.step;
    ctx.snap = m;
    views[level].sync(ctx);
    timeline.setEra(m.globals.era);
    streetMood();
    refreshPanels();
    renderLegend();
    if (wanted !== ask) requestState(sim.years[wanted]);
    else refreshEvents();
  });
}

let evTimer = 0;
function refreshEvents(): void {
  clearTimeout(evTimer);
  evTimer = window.setTimeout(() => {
    const p = ctx.selected;
    const body = p?.kind === 'body' ? p.id : p?.kind === 'city' ? ctx.body : undefined, g = runGen;
    sim.events(body === undefined ? ctx.year - 300 : 0, ctx.year, body, 40).then((e) => { if (g !== runGen) return; events = e; refreshPanels(); });
  }, 120);
}

// ------------------------------------------------------------------ psychohistory forecast

let fc: Forecast | null = null, fcOn = true, fcTimer = 0, fcGen = 0;
const forecastToggle = app.querySelector<HTMLButtonElement>('.forecast-toggle')!;
forecastToggle.addEventListener('click', () => {
  fcOn = !fcOn;
  forecastToggle.textContent = fcOn ? 'Forecast on' : 'Forecast off';
  forecastToggle.setAttribute('aria-pressed', String(fcOn));
  if (fcOn) refreshForecast(); else { charts.draw(); refreshPanels(); }
});
function refreshForecast(): void {
  clearTimeout(fcTimer);
  if (fc && Math.abs(fc.fromYear - ctx.year) >= 10) fc = null;
  if (!fcOn || timeline.playing || !sim.years.length) return;
  const gen = ++fcGen, run = runGen;
  fcTimer = window.setTimeout(() => {
    const steps = Math.min(40, Math.floor((10000 - ctx.year) / 10));
    if (steps < 2 || ctx.year > (sim.done ? 10000 : sim.years[sim.frontier])) return;
    forecast(sim.years, sim.series, ctx.year, { steps, samples: 16 }).then((f) => {
      if (gen !== fcGen || run !== runGen) return;
      fc = f;
      charts.draw();
      refreshPanels();
    });
  }, 300);
}
timeline.onToggle = (playing) => { if (!playing) refreshForecast(); };
charts.setFan((key) => (fcOn && fc ? fanFor(fc, key) : null));

function refreshPanels(): void {
  const step = Math.max(0, sim.stepAt(ctx.year));
  const row = (col: number) => sim.series[step * NGM + col];
  inspector.render({
    world, snap: ctx.snap, year: ctx.year, selected: ctx.selected, body: ctx.body, events, history,
    globalRow: row,
    forecast: fcOn && fc ? oddsHtml(fc, (k) => row(GM[k])) : undefined,
  });
  charts.setYear(ctx.year);
  dataPanel.refresh();
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

// ticker: during playback, ask for what happened since the last look
let tickFrom = 0, tickAsk = 0, tickBusy = false;
function pollTicker(y: number): void {
  if (!timeline.playing || y < tickFrom) { tickFrom = y; return; }
  const now = performance.now();
  if (tickBusy || now - tickAsk < 350) return;
  tickAsk = now; tickBusy = true;
  const from = tickFrom, g = runGen;
  tickFrom = y;
  sim.events(from, y, undefined, 60).then((evs) => {
    tickBusy = false;
    if (!timeline.playing || g !== runGen) return;
    ticker.push(evs.filter((e) => NOTABLE.has(e.type)).reverse().map((e) => describe(world, e)));
  });
}
setInterval(() => ticker.prune(), 250);
ticker.onPick = (it) => {
  const r = it.ref;
  if (!r || r.kind !== 'body') { select(null); return; }
  select(asPick(r));
  const sys = world.bodies[r.id].system;
  if (level !== 'system' || ctx.system !== sys) setLevel('system', { kind: 'system', id: sys }, () => { ctx.system = sys; });
};

let panelsAt = 0, panelsTrail = 0;
timeline.onChange = (y) => {
  ctx.year = y;
  if (!timeline.playing) writeHash();
  refreshForecast();
  pollTicker(y);
  const now = performance.now();
  clearTimeout(panelsTrail);
  if (!timeline.playing || now - panelsAt > 120) { panelsAt = now; refreshPanels(); }
  else panelsTrail = window.setTimeout(refreshPanels, 130);
  requestState(y);
  charts.setYear(y);
};

sim.onProgress = () => {
  const era = GM.era;
  timeline.setData(sim.done ? 10000 : sim.years[sim.frontier], { years: sim.years, n: sim.frontier + 1, era: (i) => sim.series[i * NGM + era] });
  statusEl.textContent = sim.done ? `simulated in ${(sim.ms / 1000).toFixed(1)}s` : `simulating… year ${Math.round(sim.years[sim.frontier]).toLocaleString('en-US')}`;
  charts.draw();
  if (!ctx.snap) requestState(ctx.year);
  if (sim.done) refreshForecast();
  // a reseed drops the place history; ask again as the new run fills in
  if (!history && (sim.done || sim.frontier % 40 === 0)) fetchHistory();
  // a year from the URL waits until the run has reached it
  if (pendingYear !== null && (sim.done || sim.years[sim.frontier] >= pendingYear)) { const y = pendingYear; pendingYear = null; timeline.set(y, true); }
};

// ------------------------------------------------------------------ URL: #future3-y1360-b123-lplanet

let pendingYear: number | null = null, hashTimer = 0;
const REF_CODE: Record<string, string> = { body: 'b', system: 's', galaxy: 'g', humanspace: 'h', city: 'c' };
function writeHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const sel = ctx.selected;
    const parts = [`future${sim.seed}`, `y${Math.round(ctx.year)}`];
    if (sel) parts.push(sel.kind === 'city' ? `c${ctx.body}.${sel.id}` : `${REF_CODE[sel.kind]}${sel.id}`);
    parts.push(`l${level}`);
    // replaceState so scrubbing doesn't flood the back button
    try { window.history.replaceState(null, '', `#${parts.join('-')}`); } catch { /* sandboxed frames may refuse */ }
  }, 400);
}

function readHash(): { seed: number; year: number | null; sel: Pickable | null; level: Level | null } {
  const h = location.hash.slice(1);
  const seed = Number(h.match(/future(\d+)/)?.[1]) || 0;
  const y = h.match(/(?:^|-)y(\d+)/);
  const lv = h.match(/(?:^|-)l(universe|galaxy|local|system|planet|street)/)?.[1] as Level | undefined;
  const r = h.match(/(?:^|-)([bsghc])(\d+)(?:\.(\d+))?(?=-|$)/);
  let sel: Pickable | null = null;
  if (r) {
    const id = Number(r[2]);
    if (r[1] === 'b' && world.bodies[id]) sel = asPick({ kind: 'body', id });
    else if (r[1] === 's' && world.systems[id]) sel = asPick({ kind: 'system', id });
    else if (r[1] === 'g' && GALAXIES[id]) sel = { kind: 'galaxy', id, name: GALAXIES[id].name, pos: new THREE.Vector3() };
    else if (r[1] === 'h') sel = asPick({ kind: 'humanspace', id: 0 });
    else if (r[1] === 'c' && world.bodies[id] && r[3]) { ctx.body = id; ctx.city = Number(r[3]); sel = { kind: 'city', id: Number(r[3]), name: `${world.bodies[id].name} settlement ${r[3]}`, pos: new THREE.Vector3() }; }
  }
  return { seed, year: y ? Math.min(10000, Number(y[1])) : null, sel, level: lv ?? null };
}

function startRun(seed: number): void {
  runGen++;
  inspector.resetPeople();
  ctx.snap = null; lastStep = -1; wanted = -1; inFlight = false; events = []; history = null; fc = null;
  ticker.clear(); tickFrom = 0;
  sim.run(seed);
  timeline.set(0);
  ctx.year = 0;
  writeHash();
}
seedInput.addEventListener('change', () => startRun(Math.max(1, Math.floor(Number(seedInput.value)) || 1)));
app.querySelector('#reroll')!.addEventListener('click', () => {
  const s = 1 + Math.floor(Math.random() * 99999);
  seedInput.value = String(s);
  startRun(s);
});
const help = document.createElement('div');
help.className = 'help';
help.setAttribute('role', 'dialog');
help.setAttribute('aria-label', 'Keyboard shortcuts');
help.hidden = true;
help.innerHTML = `<h2>Keys</h2><dl>${([
  ['Space', 'play or pause'], ['← →', 'step through time (Shift: ten steps)'], ['/', 'search'], ['Enter', 'go into the selected thing'],
  ['Backspace', 'up a level'], ['Esc', 'clear the selection'], ['?', 'this list'],
] as const).map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join('')}</dl><p class="muted">Scroll into anything to enter it; scroll out past the edge to go up. Type a year into the year to jump there.</p><button class="link" type="button">Close</button>`;
app.append(help);
help.querySelector('button')!.addEventListener('click', () => { help.hidden = true; });

window.addEventListener('keydown', (e) => {
  // the slider keeps arrows for itself but lets Space through
  if (e.target instanceof HTMLInputElement && e.target.type === 'range' && e.code === 'Space') { e.preventDefault(); timeline.toggle(); return; }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // typing a name anywhere goes to search, so letters never fire shortcuts
  if (e.key.length === 1 && /[\p{L}\p{N}#]/u.test(e.key)) { e.preventDefault(); search.focus(e.key); return; }
  if (e.code === 'Space') { e.preventDefault(); timeline.toggle(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); timeline.step(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey); }
  else if (e.key === 'Escape') { if (!help.hidden) help.hidden = true; else if (level === 'street' && street.follow >= 0) street.follow = -1; else select(null); }
  else if (e.key === '/') { e.preventDefault(); search.focus(); }
  else if (e.key === '?') help.hidden = !help.hidden;
  else if (e.key === 'Enter' && ctx.selected && !(e.target instanceof HTMLButtonElement)) dive(ctx.selected);
  else if (e.key === 'Backspace') { const i = LEVELS.indexOf(level); if (i > 0) setLevel(LEVELS[i - 1]); }
});

// ------------------------------------------------------------------ search

const sysLower = world.systems.map((s) => s.name.toLowerCase());
const bodyLower = world.bodies.map((b) => b.name.toLowerCase());

function matchScore(name: string, q: string): number {
  if (name === q) return 4;
  if (name.startsWith(q)) return 3;
  const i = name.indexOf(q);
  return i < 0 ? 0 : name[i - 1] === ' ' || name[i - 1] === '-' ? 2 : 1;
}

function bodySub(id: number): string {
  const b = world.bodies[id], st = stageOf(ctx.snap, id);
  const place = `${b.kind} in ${world.systems[b.system].name}`;
  return alive(st) ? `${place} · ${STAGE_NAMES[st]} · ${fmtNum(popOf(ctx.snap, id))}` : st >= 0 ? `${place} · ${STAGE_NAMES[st].toLowerCase()}` : place;
}

function findBodies(q: string, limit: number): Hit[] {
  return scoreBodies(q).slice(0, limit).map((x) => x.h);
}

function scoreBodies(q: string): { h: Hit; s: number }[] {
  const out: { h: Hit; s: number }[] = [];
  bodyLower.forEach((n, id) => {
    const m = matchScore(n, q);
    if (!m) return;
    const st = stageOf(ctx.snap, id);
    out.push({ h: { kind: 'body', id, name: world.bodies[id].name, sub: '' }, s: m * 10 + (alive(st) ? 5 + 0.3 * Math.log10(1 + popOf(ctx.snap, id)) : st >= 0 ? 1 : 0) });
  });
  return out.sort((a, b) => b.s - a.s).slice(0, 12).map((x) => ({ h: { ...x.h, sub: bodySub(x.h.id) }, s: x.s }));
}

function find(raw: string): Hit[] {
  const q = raw.toLowerCase().replace(/\s+/g, ' ');
  const res = q.match(/^(?:resident|person|citizen)?\s*#\s*([\d.,_]+\s*[kmbt]?)\s*(?:(?:of|on|in|at|from)\s+(.*))?$/) ?? q.match(/^(?:resident|person|citizen)\s+#?\s*([\d.,_]+\s*[kmbt]?)\s*(?:(?:of|on|in|at|from)\s+(.*))?$/);
  if (res) {
    const n = Math.max(1, parseCount(res[1]) || 1);
    const where = res[2]?.trim();
    const bodies = where ? findBodies(where, 6) : ctx.selected?.kind === 'body' ? [{ kind: 'body' as const, id: ctx.selected.id, name: '', sub: '' }] : [];
    const living = bodies.filter((b) => alive(stageOf(ctx.snap, b.id)));
    const fits = living.filter((b) => n <= popOf(ctx.snap, b.id));
    if (!fits.length && living.length) {
      const b = living[0].id;
      return [{ kind: 'note', id: b, name: `${world.bodies[b].name} has ${fmtNum(popOf(ctx.snap, b))} people in ${Math.round(2040 + ctx.year)}`, sub: 'try a number up to that' }];
    }
    return fits.map((b) => ({
      kind: 'resident', id: b.id, n, name: `Resident #${n.toLocaleString('en-US')} of ${world.bodies[b.id].name}`,
      sub: `${fmtNum(popOf(ctx.snap, b.id))} people live there in ${Math.round(2040 + ctx.year)}`,
    }));
  }
  if (q.length < 2 && !/\d/.test(q)) return [];
  const hits: { h: Hit; s: number }[] = [];
  GALAXIES.forEach((g, i) => {
    const m = matchScore(g.name.toLowerCase(), q);
    if (m) hits.push({ h: { kind: 'galaxy', id: i, name: g.name, sub: g.name === 'Milky Way' ? 'our galaxy' : `galaxy · ${fmtNum(g.dist)} ly` }, s: m * 10 + 6 });
  });
  sysLower.forEach((n, id) => {
    const m = matchScore(n, q);
    if (!m) return;
    const s = world.systems[id], sum = systemSummary(world, ctx.snap, id);
    hits.push({
      h: { kind: 'system', id, name: s.name, sub: `${s.spec} star · ${s.dist < 0.01 ? 'home' : `${fmtNum(s.dist)} ly`}${sum.n ? ` · ${sum.n} settlement${sum.n > 1 ? 's' : ''}, ${fmtNum(sum.pop)}` : ''}` },
      s: m * 10 + (sum.n ? 6 + 0.3 * Math.log10(1 + sum.pop) : 0) + (s.real ? 3 : 0),
    });
  });
  TECHS.forEach((t, i) => {
    const m = Math.max(matchScore(t.name.toLowerCase(), q), matchScore(t.id.toLowerCase(), q));
    if (!m) return;
    const y = ctx.snap?.techDone[i] ?? -1;
    hits.push({ h: { kind: 'tech', id: i, name: t.name, sub: y >= 0 ? `technology · invented ${fmtYear(y)}` : 'technology · not yet invented' }, s: m * 10 + 2 });
  });
  // a system ranks just above its own worlds
  for (const h of hits) h.s += 1;
  return hits.concat(scoreBodies(q)).sort((a, b) => b.s - a.s).slice(0, 9).map((x) => x.h);
}

const search = new Search(find);
app.querySelector('.search-slot')!.replaceWith(search.el);
search.onPick = (h) => {
  pull = null;
  if (h.kind === 'note') return;
  if (h.kind === 'tech') { inspector.showTech(h.id); select(null); refreshPanels(); return; }
  if (h.kind === 'galaxy') {
    const name = GALAXIES[h.id].name;
    select({ kind: 'galaxy', id: h.id, name, pos: new THREE.Vector3() });
    setLevel(name === 'Milky Way' ? 'galaxy' : 'universe');
  } else if (h.kind === 'system') {
    select(asPick({ kind: 'system', id: h.id }));
    if (level !== 'system' || ctx.system !== h.id) setLevel('system', { kind: 'system', id: h.id }, () => { ctx.system = h.id; });
  } else {
    if (h.kind === 'resident') inspector.showResident(h.id, h.n!);
    select(asPick({ kind: 'body', id: h.id }));
    if (level !== 'planet' || ctx.body !== h.id) setLevel('planet', { kind: 'body', id: h.id }, () => { ctx.body = h.id; ctx.system = world.bodies[h.id].system; });
  }
};

// ------------------------------------------------------------------ go

const fromHash = readHash();
if (fromHash.seed) seedInput.value = String(fromHash.seed);
startRun(fromHash.seed || 1);
if (fromHash.sel) {
  const b = fromHash.sel.kind === 'body' ? fromHash.sel.id : fromHash.sel.kind === 'city' ? ctx.body : -1;
  if (b >= 0) { ctx.body = b; ctx.system = world.bodies[b].system; }
  if (fromHash.sel.kind === 'system') ctx.system = fromHash.sel.id;
  select(fromHash.sel);
}
setLevel(fromHash.level ?? 'system', null, undefined, false);
pendingYear = fromHash.year;

let last = performance.now(), frame = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  govern(dt);
  ctx.t += dt;
  motion += ((hovering ? 0 : 1) - motion) * (1 - Math.exp(-dt * 5));
  ctx.tm += dt * motion;
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
  drawRing();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (import.meta.env.DEV) Object.assign(window, { __app: { ctx, views, setLevel, dive, select, timeline, camera, controls, get level() { return level; } } });
