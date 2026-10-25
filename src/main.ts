import { ENSEMBLE_SIZE, Ensemble } from './ui/ensemble.ts';
import { MICRO_KIND, Micro, isMicro } from './view/micro.ts';
import { MultiverseView } from './view/multiverse.ts';
import { foamSeed } from './explain/multiverse.ts';
import type { Biography } from './sim/lives.ts';
import { clearSocietyLooks, setSocietyLook } from './view/societyLook.ts';
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
import { installDataDesk } from './ui/dataDesk.ts';
import { DISCLAIMER } from './data/provenance.ts';
import { STAMP_CODE } from './ui/stamp.ts';
import { Search, type Hit } from './ui/search.ts';
import { NOTABLE, Ticker, describe } from './ui/ticker.ts';
import { Timeline } from './ui/timeline.ts';
import { LocalCalendar } from './ui/calendar.ts';
import { EraBanner, eraRun, eraTitle } from './ui/eraBanner.ts';
import { wayOfWarHtml } from './ui/wayOfWar.ts';
import { EraMood } from './view/eraMood.ts';
import { CameraRig, PRESETS, easeInOutCubic, easeInOutSine, easeOutCubic, type MotionPreset } from './view/camRig.ts';
import { ShipConsole } from './ship/console.ts';
import { Assistant } from './assistant/assistant.ts';
import { Voyage } from './ship/voyage.ts';
import { installPaths } from './features/paths.ts';
import { installTimelineHand } from './features/timelineHand.ts';
import { AGE_CSS, COLOR_MODES, HEAT_CSS, factionCss, faithCss, stageLegend, type ColorMode } from './view/colorModes.ts';
import { names as naming } from './ui/names.ts';
import { StreetView } from './view/street.ts';
import { Picker } from './explain/picker.ts';
import { explainLocate, explainName, explainerFor } from './explain/registry.ts';
import { resetShips, setMissionApi, setShipApi, shipId } from './explain/ships.ts';
import { ImpactDirector, type PlanetHost, type SavedView } from './view/impactDirector.ts';
import { ImpactPlayer } from './ui/impactPlayer.ts';
import type { VisualScenario } from './impact/visual.ts';
import { demoApproach } from './impact/vizApproach.ts';
import { GalaxyView, LocalView, LEVELS, PLANET_SUN, PlanetView, SystemView, UniverseView, alive, cityCount, cityDir, makeSky, popOf, stageOf, systemSummary, type Ctx, type Level, type Pickable, type Ref, type View } from './view/views.ts';
import type { AppApi } from './app/api.ts';
import { applyUrlParts, setHashWriter, urlPartTokens } from './app/urlState.ts';
import { installFollow } from './features/follow.ts';

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
      <div class="here" hidden><canvas width="64" height="64" aria-hidden="true"></canvas><span></span></div>
    </div>
    <div class="run">
      <div class="search-slot"></div>
      <label for="seed">Future #</label><input id="seed" inputmode="numeric" value="1" size="6">
      <button id="reroll" class="link" type="button">Another future</button>
      <button id="chronicle" class="link" type="button">Chronicle</button>
      <button id="lifepick" class="link" type="button" aria-expanded="false" title="Pick one person and follow their whole life">Follow a life</button>
      <button id="data" class="link" type="button" aria-pressed="false">Data</button>
      <button id="ask" class="link" type="button" aria-pressed="false" title="Ask the ship computer anything, by voice or typing (backquote key: tap to type, hold to talk)">Ask</button>
      <button id="board" class="link" type="button" aria-pressed="false" title="Fly this future yourself: tell the ship where and when">Board the Starship</button>
      <label for="motion">Motion</label><select id="motion" title="How the camera moves between places">${(Object.keys(PRESETS) as MotionPreset[]).map((k) => `<option value="${k}">${PRESETS[k].label}</option>`).join('')}</select>
      <span class="status num" aria-live="polite"></span>
    </div>
  </header>
  <div class="legend">
    <div class="legend-modes" role="group" aria-label="Colour settled stars by">Colour by ${COLOR_MODES.map((m) => `<button class="link" type="button" data-mode="${m.id}" aria-pressed="${m.id === 'stage'}">${m.label}</button>`).join(' ')}</div>
    <div class="legend-keys"></div>
    <div class="legend-war" aria-label="The way of war"></div>
  </div>
  <div class="sel-ring" aria-hidden="true" hidden><i></i><i></i></div>
  <div class="zoom-ctl" role="group" aria-label="Zoom"><button type="button" data-zoom="-1" aria-label="Zoom in" title="Zoom in (+)">+</button><button type="button" data-zoom="1" aria-label="Zoom out" title="Zoom out (−)">−</button></div>
  <div class="travel" hidden><span class="travel-to"></span><i class="travel-bar" aria-hidden="true"><b></b></i><button class="link" type="button" title="Get there now (Esc). Hold Shift to hurry.">Skip</button></div>
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
// a phone has room for the scene or the charts, not both with a card open: start with the charts folded
const phone = matchMedia('(max-width: 40rem)');
if (phone.matches) chartsToggle.click();

// ------------------------------------------------------------------ 3D

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92; // each level sets its own (view/eraMood.ts LEVEL_LOOKS)
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020204);
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1e7);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 1.3;
// every automatic camera move goes through the rig, and every zoom (wheel, trackpad, pinch, keys,
// buttons) lands in its goal and eases there instead of OrbitControls jumping a step (src/view/camRig.ts)
const rig = new CameraRig(camera, controls);
{
  const c = controls as unknown as { _dollyIn: (s: number) => void; _dollyOut: (s: number) => void };
  c._dollyIn = (s) => rig.zoomBy(s);
  c._dollyOut = (s) => rig.zoomBy(1 / s);
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.48, 0.45, 0.7);
composer.addPass(bloom);
// the Starship rides in its own layer over the sim, after bloom: star-field levels bloom from low
// brightness, and a sunlit steel hull would melt into a white disc (its engines glow on their own)
const voyage = new Voyage(renderer);
composer.addPass(voyage.pass);
// the era tints the whole picture: grey and stuttering in a collapse, warm in a golden age
const eraMood = new EraMood(bloom, renderer);
composer.addPass(eraMood.pass);
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
  if (document.hidden || rig.flying || pixelRatio <= 1) return;
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
const eraBanner = new EraBanner();
app.append(eraBanner.el);
const calendar = new LocalCalendar(world, (a, b, c, d) => sim.events(a, b, c, d));
timeline.local = (y) => calendar.text(y);
calendar.nameOf = (b) => naming.place(world, b);
naming.onChange = () => { refreshPanels(); renderLegend(); renderCrumbs(); timeline.refresh(); };
calendar.onChange = () => timeline.refresh();
const ctx: Ctx = { world, snap: null, year: 0, camera, controls, system: 0, body: world.mars, selected: null, t: 0, tm: 0, colorBy: 'stage', city: 0 };
let events: SimEvent[] = [];
let history: HistoryMsg | null = null;
let assistant: Assistant | null = null; // the GPT assistant, made once the ship console exists (below)
const dataPanel = installDataDesk({
  app, scene: canvas, world, sim, ctx, view: () => views[level],
  selectBody: (b) => select(asPick({ kind: 'body', id: b })),
  showSeries: (key) => { if (charts.el.hidden) chartsToggle.click(); charts.show(key); },
  pickYear: (y) => seekTo(y),
  visualize: (src, opts) => visualize(src, opts),
});
// a permanent notice: what this is not
{
  const note = document.createElement('p');
  note.className = 'app-disclaimer';
  note.textContent = DISCLAIMER;
  app.append(note);
}

// below the street: one person's body, cells, molecules, atoms; above the Local Group: every future
const micro = new Micro((id, y) => sim.person(id, y));
const multiverse = new MultiverseView();
const views: Record<Level, View> = {
  multiverse,
  ...micro.views,
  universe: new UniverseView(world),
  galaxy: new GalaxyView(world),
  local: new LocalView(world),
  system: new SystemView(),
  planet: new PlanetView(),
  street: new StreetView((b, y, o, n) => sim.residents(b, y, o, n)),
};
const street = views.street as StreetView;
street.setPersonFetch((pid, y) => sim.person(pid, y));
// seen from the Sun in the local view; behind the whole galaxy it is only a backdrop
const sky = makeSky(1, 7000, 'sky', () => (level === 'local' ? { name: 'the Sun', x: 0, y: 0, z: 0, sol: true } : null));
scene.add(sky);
for (const v of Object.values(views)) { v.group.visible = false; scene.add(v.group); }
let level: Level = 'system';
let lookAsked = ''; // body:step of the last society look asked for

function enterLevel(next: Level): void {
  views[level].group.visible = false;
  const up = LEVELS.indexOf(next) < LEVELS.indexOf(level);
  level = next;
  tooltip.hidden = true; // the thing it named is in the level we left
  const v = views[level];
  v.group.visible = true;
  sky.visible = level === 'galaxy' || level === 'local';
  eraMood.setLevel(level);
  v.enter(ctx);
  v.sync(ctx);
  controls.minDistance = v.limits[0];
  controls.maxDistance = v.limits[1];
  rig.resetMotion();
  rig.setLimits(v.limits[0], v.limits[1]);
  focusKey = '';
  renderCrumbs();
  renderLegend();
  writeHash();
  streetMood();
  if (ctx.snap) refreshLook(ctx.snap.step);
  // on a phone the street needs the screen: keep the sheet folded until someone is tapped
  if (level === 'street' && matchMedia('(max-width: 40rem)').matches) inspector.el.classList.remove('open');
  // things inside a body mean nothing once we've left it; above the Local Group, this future is the subject
  if (!isMicro(level) && ctx.selected?.kind === 'thing' && MICRO_KIND.test(ctx.selected.ex ?? '')) select(level === 'multiverse' ? { kind: 'thing', ex: 'futu', id: sim.seed, name: '', pos: new THREE.Vector3() } : null);
  // back up inside a body (from an atom to the cell, say): the card is this level's, not the deeper thing's
  if (up && isMicro(level) && ctx.selected?.kind === 'thing' && MICRO_KIND.test(ctx.selected.ex ?? '')) {
    const ex = MICRO_SELECT[level];
    if (ex) select({ kind: 'thing', ex, id: 0, name: '', pos: new THREE.Vector3() });
    else { select(null); if (micro.pid) { inspector.openPerson(micro.pid); inspector.el.classList.add('open'); } }
  }
  if (isMicro(level) || level === 'multiverse') refreshPanels();
}
// a deep link into a person: the levels above them become where they live, once their life is read
let placeFromBio = false;
micro.onChange = () => {
  const w = micro.bio?.where;
  if (placeFromBio && w && world.bodies[w.body]) { placeFromBio = false; ctx.body = w.body; ctx.system = world.bodies[w.body].system; ctx.city = 0; writeHash(); }
  if (!isMicro(level)) return; views[level].sync(ctx); renderCrumbs(); refreshPanels(); };

// ------------------------------------------------------------------ impact visualization

// Plays one impact, close approach or deflection on the planet view (src/view/impactDirector.ts): the
// director saves where we are, pauses the timeline, travels to the world with the app's own moves and
// directs the camera through the rig; exiting puts everything back.
const planetView = views.planet as PlanetView;
let planetAdapter: { pivot: THREE.Object3D; host: PlanetHost } | null = null;
let restoreAfter: SavedView | null = null;
const director = new ImpactDirector({
  rig, camera,
  save: () => ({ level, body: ctx.body, system: ctx.system, selected: ctx.selected, cam: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, playing: timeline.playing, year: ctx.year, extra: { city: ctx.city } }),
  restore: (sv) => {
    if (Math.abs(ctx.year - sv.year) > 1e-6) timeline.set(sv.year, true);
    const back = sv.level as Level, ex = sv.extra as { city: number };
    if (back !== level || sv.body !== ctx.body) setLevel(back, null, () => { ctx.body = sv.body; ctx.system = sv.system; ctx.city = ex.city; });
    restoreAfter = sv; // the camera pose, selection and clock once the level has settled (loop)
  },
  goToBody: (b) => goToBody(b),
  planet: (b) => {
    if (level !== 'planet' || ctx.body !== b || busy) return null;
    const pivot = planetView.impactFrame();
    if (planetAdapter?.pivot !== pivot) planetAdapter = { pivot, host: {
      frame: pivot,
      setTransientScars: (x) => planetView.setTransientScars(x), setCityShade: (x) => planetView.setCityShade(x), setCutaway: (on) => planetView.setCutaway(on),
      holdSpin: (on) => planetView.holdSpin(on), faceSun: (d) => planetView.faceSun(d),
      get extraLabels() { return planetView.extraLabels; }, set extraLabels(f) { planetView.extraLabels = f; },
    } };
    return planetAdapter.host;
  },
  playing: () => timeline.playing, togglePlay: () => timeline.toggle(), seekYear: (y) => seekTo(y),
  setLimits: (lo, hi) => rig.setLimits(lo, hi),
  reduced: () => reducedMotion || rig.reduced,
  pixelRatio: () => renderer.getPixelRatio(),
  viewportH: () => canvas.clientHeight || 800,
});
const player = new ImpactPlayer(director, () => reducedMotion || rig.reduced);
app.append(player.el);
director.onChange = () => player.render();

/** Start a visualization from the Impact Lab (or the debug harness): the desk folds away and comes back on exit. */
function visualize(src: VisualScenario | Promise<VisualScenario | null>, opts: { alternates?: Parameters<ImpactPlayer['setAlternates']>[0]; replayYear?: number; persistentScar?: boolean } = {}): void {
  const reopen = !director.active && dataPanel.open;
  if (reopen) { dataPanel.toggle(); app.querySelector('#data')?.setAttribute('aria-pressed', 'false'); }
  if (follow.following()) follow.stopFollow();
  player.setAlternates(opts.alternates ?? null);
  director.start(src, { replayYear: opts.replayYear, persistentScar: opts.persistentScar, onExit: reopen ? () => { if (!dataPanel.open) { dataPanel.toggle(); app.querySelector('#data')?.setAttribute('aria-pressed', 'true'); } } : undefined });
}

// debug harness: ?impact=chelyabinsk (or barringer, moon-100m, mars-surface, venus-airburst, sl9, deflection, close-approach)
{
  const demo = new URLSearchParams(location.search).get('impact');
  if (demo) setTimeout(() => visualize(demo === 'close-approach' ? Promise.resolve(demoApproach(world)) : sim.data<'impactViz'>({ type: 'impactViz', case: 'demo', key: demo as never }).then((r) => r.visual)), 1200);
}

/** After an exit: once any level change has landed, the camera goes back to where it was, the selection and the clock too. */
function finishRestore(): void {
  const sv = restoreAfter;
  if (!sv || busy || level !== sv.level || ctx.body !== sv.body) return;
  restoreAfter = null;
  const l = views[level].limits;
  rig.setLimits(l[0], l[1]);
  fly(sv.cam, sv.target, 1, easeInOut, undefined, true);
  select(sv.selected as Pickable | null);
  if (sv.playing && !timeline.playing) timeline.toggle();
}

// ------------------------------------------------------------------ legend and colour modes

const legendEl = app.querySelector<HTMLElement>('.legend')!;
const legendModes = legendEl.querySelector<HTMLElement>('.legend-modes')!;
const legendKeys = legendEl.querySelector<HTMLElement>('.legend-keys')!;

function legendHtml(mode: ColorMode): string {
  if (mode === 'heat') return `<span class="ramp" style="--g:${HEAT_CSS}"></span><span class="ramp-ends num"><span>1</span><span>people per system</span><span>40B</span></span>`;
  if (mode === 'founded') return `<span class="ramp" style="--g:${AGE_CSS}"></span><span class="ramp-ends num"><span>2040</span><span>first settled</span><span>${Math.round(2040 + ctx.year)}</span></span>`;
  if (mode === 'faith') {
    // the biggest faith of each settlement, weighted by its people
    const fs = new Map<number, number>();
    const snap = ctx.snap;
    if (snap) for (const b of snap.settled) if (alive(stageOf(snap, b))) { const n = snap.S[b * NF + F.culture]; fs.set(n, (fs.get(n) ?? 0) + popOf(snap, b)); }
    const top = [...fs].sort((a, b) => b[1] - a[1]);
    return top.slice(0, 8).map(([n, pop]) => `<span><i style="background:${faithCss(n)}"></i>${naming.faith(n)} <span class="num">${fmtNum(pop)}</span></span>`).join('')
      + (top.length > 8 ? `<span class="more">and ${top.length - 8} more</span>` : '');
  }
  if (mode === 'faction') {
    const facs = new Map<number, number>();
    const snap = ctx.snap;
    if (snap) for (const b of snap.settled) if (alive(stageOf(snap, b))) { const f = snap.S[b * NF + F.faction]; facs.set(f, (facs.get(f) ?? 0) + popOf(snap, b)); }
    const top = [...facs].sort((a, b) => b[1] - a[1]);
    const name = (f: number) => (f === world.earth ? 'Earth' : naming.place(world, f));
    return top.slice(0, 8).map(([f, pop]) => `<span><i style="background:${factionCss(f, world.earth)}"></i>${name(f)} <span class="num">${fmtNum(pop)}</span></span>`).join('')
      + (top.length > 8 ? `<span class="more">and ${top.length - 8} more</span>` : '');
  }
  return stageLegend();
}

function renderLegend(): void {
  legendEl.hidden = isMicro(level) || level === 'multiverse';
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
const easeInOut = easeInOutCubic, easeOut = easeOutCubic;
// how the camera moves is the reader's choice, remembered; reduced motion starts at Instant and never arcs or widens the view
rig.reduced = reducedMotion;
rig.preset = reducedMotion ? 'instant' : 'balanced';
try { const m = localStorage.getItem('motion'); if (m && m in PRESETS) rig.preset = m as MotionPreset; } catch { /* storage may be blocked */ }
const motionSelect = app.querySelector<HTMLSelectElement>('#motion')!;
motionSelect.value = rig.preset;
motionSelect.addEventListener('change', () => {
  rig.preset = motionSelect.value as MotionPreset;
  try { localStorage.setItem('motion', rig.preset); } catch { /* then it just isn't remembered */ }
});

/** Ease the camera to a pose (CameraRig.orbitTo); the motion preset stretches or shortens it. */
function fly(pos: THREE.Vector3, target: THREE.Vector3, dur: number, ease: (x: number) => number, done?: () => void, interruptible = false): void {
  rig.orbitTo(pos, target, dur * rig.spec.level, ease, done, interruptible);
}

// the camera never ends up inside a planet or a star: each view lists its solid spheres
let clearOf: THREE.Vector3 | null = null;
const tvClear = new THREE.Vector3();
function pushOut(c: THREE.Vector3, r: number): void {
  const p = clearOf!, d = tvClear.subVectors(p, c).length();
  if (d < r && d > 1e-9) p.copy(c).addScaledVector(tvClear, r / d);
}
rig.keepClear = (p) => { clearOf = p; views[level].obstacles?.(ctx, pushOut); };

/**
 * Where the camera settles when it travels to a thing in this view, the zoom limits while that thing is
 * the focus, and the side to arrive on (lit by the star, or with the planet behind). Null: not travelled to.
 */
function framing(r: Ref): { dist: number; limits: [number, number]; side: 'star' | 'out' | null } | null {
  const v = views[level], [lo, hi] = v.limits;
  if (level === 'system' && r.kind === 'body') { const s = v.size?.(ctx, r) || 0.5; return { dist: Math.max(v.diveDist(ctx, r) * 1.8, s * 6), limits: [s * 1.2, hi], side: 'star' }; }
  if (level === 'system' && r.kind === 'system') return { dist: (v.size?.(ctx, r) || 1) * 9, limits: [lo, hi], side: null };
  if (level === 'local' && r.kind === 'system') return { dist: v.diveDist(ctx, r) * 1.8, limits: [lo, hi], side: null };
  // craft, stations, facilities, comets: close in (backdrop stars are not destinations)
  if (r.kind === 'thing' && (level === 'system' || level === 'planet') && !/^(sky|bgal|dust)/.test(r.ex ?? '')) return { dist: level === 'planet' ? 5 : 3, limits: [0.35, hi], side: level === 'planet' ? 'out' : 'star' };
  return null;
}

let focusKey = ''; // what the camera travelled to and now follows
const refKey = (r: Ref) => `${r.kind}:${r.ex ?? ''}:${r.id}`;
function unfocus(): void { focusKey = ''; rig.follow(null); const l = views[level].limits; rig.setLimits(l[0], l[1]); }
const sideV = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);

/** Travel to a thing in this view and keep it centred as it moves. False if it isn't somewhere to travel. */
function travelTo(r: Ref, done?: () => void): boolean {
  if (busy || (director.active && director.status !== 'focusing')) return false; // the impact visualization directs the camera once it plays
  const lv = level;
  if (lv === 'planet' && r.kind === 'city') {
    // a settlement: turn the globe under us until it faces the camera, at a distance that shows its region
    const at = locateRef(views.planet, r);
    if (!at || (refKey(r) === focusKey && !rig.flying && !done)) return false;
    const d = Math.max(camera.position.distanceTo(controls.target), 24);
    fly(at.clone().normalize().addScaledVector(UPV, 0.25).setLength(d), new THREE.Vector3(), 1.1, easeInOut, done, true);
    focusKey = refKey(r);
    return true;
  }
  const f = framing(r);
  if (!f) return false;
  const dest = () => (level === lv ? locateRef(views[lv], r) : null);
  const at = dest();
  if (!at) return false;
  const key = refKey(r);
  // clicking again what we're already looking at changes nothing
  if (key === focusKey && !rig.flying && !done) return false;
  focusKey = key;
  pull = null;
  if (f.side === 'star') sideV.copy(at).negate(); else if (f.side === 'out') sideV.copy(at); else sideV.set(0, 0, 0);
  const name = r.kind === 'body' ? naming.place(world, r.id) : r.kind === 'system' ? world.systems[r.id].name : ctx.selected && refKey(ctx.selected) === key ? ctx.selected.name : r.name ?? '';
  rig.travel({ dest, dist: f.dist, side: sideV, limits: f.limits, label: name, yearRate, done });
  return true;
}

/** Search, the ship's console and links go to a world. In the system in view, that is a journey: across to it, then down. */
function goToBody(id: number): void {
  const b = world.bodies[id], ref: Ref = { kind: 'body', id };
  const prep = () => { ctx.body = id; ctx.system = b.system; };
  const journey = !busy && !reducedMotion && rig.preset !== 'instant' && ctx.system === b.system;
  if (journey && level === 'system' && travelTo(ref, () => { if (level === 'system') setLevel('planet', ref, prep); })) return;
  if (journey && level === 'planet' && ctx.body !== id) { hop(id, prep); return; }
  if (level !== 'planet' || ctx.body !== id) setLevel('planet', ref, prep);
}

/**
 * Planet to planet in one system: pull back from this world, cut to the system with it where it was on
 * screen, travel across (the turn, the speed-up, the long slow-down), then go down to the other world.
 */
function hop(to: number, prep: () => void): void {
  busy = true;
  const from = ctx.body, back = camera.position.clone().sub(controls.target);
  fly(controls.target.clone().addScaledVector(back, 1.7), controls.target.clone(), 0.75, easeInOutSine, () => {
    crossfade(false);
    enterLevel('system');
    const ref: Ref = { kind: 'body', id: from }, at = views.system.locate(ctx, ref), f = framing(ref);
    if (at && f) { controls.target.copy(at); camera.position.copy(at).addScaledVector(back.normalize(), f.dist * 1.6); camera.lookAt(at); }
    busy = false;
    const dest: Ref = { kind: 'body', id: to };
    if (!travelTo(dest, () => { if (level === 'system') setLevel('planet', dest, prep); })) setLevel('planet', dest, prep);
    const q = queued; queued = null; q?.();
  });
}

/** The zoom buttons and keys: like a wheel notch, so out past the edge goes up a level and in close enough enters. */
function zoomStep(dir: 1 | -1): void {
  rig.interrupt();
  if (busy) return;
  const v = views[level], i = LEVELS.indexOf(level);
  if (dir > 0 && i > 0 && camera.position.distanceTo(controls.target) >= v.limits[1] * 0.97) { pull = null; setLevel(LEVELS[i - 1]); return; }
  const r = dir < 0 && ctx.selected ? enterableRef(ctx.selected) : null;
  if (r && !(level === 'street' && r.kind !== 'person') && !(level === 'planet' && r.kind !== 'city')) {
    const at = locateRef(v, r), dd = level === 'street' ? 1.1 : v.diveDist(ctx, r);
    if (at && dd > 0 && camera.position.distanceTo(at) < Math.max(dd, v.limits[0] * 1.4)) { dive(r); return; }
  }
  rig.zoomBy(dir > 0 ? 1.5 : 1 / 1.5);
}
app.querySelector('.zoom-ctl')!.addEventListener('click', (e) => {
  const z = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
  if (z) zoomStep(z === '1' ? 1 : -1);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') rig.hurry(true); });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') rig.hurry(false); });
window.addEventListener('blur', () => rig.hurry(false));

// where a long travel is going and how far along it is, with a way to get there now
const hudEl = app.querySelector<HTMLElement>('.travel')!, hudName = hudEl.querySelector<HTMLElement>('.travel-to')!, hudBar = hudEl.querySelector<HTMLElement>('.travel-bar b')!;
hudEl.querySelector('button')!.addEventListener('click', () => rig.skip());
function drawHud(): void {
  const on = rig.travelling && rig.duration >= 1.2 && !!rig.label;
  if (hudEl.hidden === on) hudEl.hidden = !on;
  if (!on) return;
  const text = `To ${rig.label}`;
  if (hudName.textContent !== text) hudName.textContent = text;
  hudBar.style.transform = `scaleX(${rig.progress.toFixed(3)})`;
  hudEl.style.setProperty('--v', rig.speed.toFixed(2));
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
  if (l === 'multiverse') return { kind: 'thing', ex: 'futu', id: sim.seed };
  if (l === 'person') return { kind: 'person', id: street.focus };
  if (l === 'cell') return { kind: 'thing', ex: 'mpart', id: micro.part };
  if (l === 'molecule') return { kind: 'thing', ex: 'morg', id: micro.orgl };
  if (l === 'atom') return { kind: 'thing', ex: 'matm', id: micro.atom };
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
      const at = locateRef(views[next], was) ?? endT;
      controls.target.copy(at);
      camera.position.copy(at).addScaledVector(off, 0.035);
    }
    camera.lookAt(controls.target);
    fly(endPos, endT, deeper ? 1.15 : 1.3, deeper ? easeOut : easeInOut, () => {
      busy = false;
      const q = queued; queued = null; q?.();
    });
  };
  const here = deeper && focus ? locateRef(views[from], focus) : null;
  if (here) {
    const p = here.clone();
    fly(p.clone().add(camera.position.clone().sub(p).multiplyScalar(0.07)), p, 0.6, easeInOut, swap);
  } else swap();
}

function renderCrumbs(): void {
  const names: Record<Level, string> = {
    multiverse: 'Futures', person: micro.crumb('person', ctx), cell: micro.crumb('cell', ctx), molecule: micro.crumb('molecule', ctx), atom: micro.crumb('atom', ctx),
    universe: 'Local Group', galaxy: 'Milky Way', local: 'Nearby stars',
    system: world.systems[ctx.system].name, planet: naming.place(world, ctx.body),
    street: ctx.city === 0 ? 'Capital' : `Settlement ${ctx.city}`,
  };
  const idx = LEVELS.indexOf(level);
  crumbsEl.innerHTML = LEVELS.slice(0, idx + 1)
    .map((l, i) => i === idx ? `<span aria-current="page">${names[l]}</span>` : `<button class="link" type="button" data-level="${l}">${names[l]}</button>`)
    .join('<span class="sep" aria-hidden="true">/</span>');
  renderHere();
}
// you are here: on a world or in one of its settlements, a small globe turned to face it
const hereEl = app.querySelector<HTMLElement>('.here')!;
const hereCanvas = hereEl.querySelector('canvas')!, hereText = hereEl.querySelector('span')!;
function renderHere(): void {
  const on = level === 'planet' || level === 'street';
  hereEl.hidden = !on;
  if (!on) return;
  const b = world.bodies[ctx.body], st = stageOf(ctx.snap, ctx.body), pop = popOf(ctx.snap, ctx.body);
  const n = cityCount(st, pop), city = Math.min(ctx.city, Math.max(0, n - 1));
  hereText.textContent = level === 'street'
    ? `${city === 0 ? 'The capital' : `Settlement ${city}`} of ${n} on ${naming.place(world, ctx.body)}, ${world.systems[b.system].name}`
    : `${n ? `${n} settlement${n > 1 ? 's' : ''}` : 'No settlements'} on ${naming.place(world, ctx.body)}, ${world.systems[b.system].name}`;
  const g = hereCanvas.getContext('2d')!, dpr = Math.min(devicePixelRatio, 2), S = 64;
  if (hereCanvas.width !== S * dpr) { hereCanvas.width = hereCanvas.height = S * dpr; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, S, S);
  const R = 26, cx = S / 2, cy = S / 2;
  const col = new THREE.Color(b.color);
  const grad = g.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, R);
  grad.addColorStop(0, `#${col.clone().multiplyScalar(0.8).getHexString()}`);
  grad.addColorStop(1, `#${col.clone().multiplyScalar(0.18).getHexString()}`);
  g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(242,242,242,0.25)'; g.lineWidth = 1; g.stroke();
  // turn the globe so the settlement we're in faces us
  const f = n ? cityDir(ctx.body, city) : new THREE.Vector3(0, 0, 1);
  const e1 = new THREE.Vector3(0, 1, 0).cross(f).normalize(), e2 = f.clone().cross(e1);
  for (let i = 0; i < n; i++) {
    const d = cityDir(ctx.body, i), z = d.dot(f);
    if (z < 0) continue;
    const x = cx + d.dot(e1) * R, y = cy - d.dot(e2) * R;
    const here = level === 'street' && i === city;
    g.fillStyle = here ? '#7fe3ff' : `rgba(255,214,160,${0.35 + 0.5 * z})`;
    g.beginPath(); g.arc(x, y, here ? 2.6 : 1.4, 0, Math.PI * 2); g.fill();
    if (here) { g.strokeStyle = 'rgba(127,227,255,0.6)'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); }
  }
}

crumbsEl.addEventListener('click', (e) => {
  const l = (e.target as HTMLElement).dataset.level as Level | undefined;
  if (l) { pull = null; setLevel(l); }
});

/** Switch the simulation to another future and go into its Local Group. */
function enterFuture(seed: number, focus: Ref | null): void {
  pull = null;
  if (seed !== sim.seed) { seedInput.value = String(seed); startRun(seed); }
  select(null);
  setLevel('universe', focus);
}

/** Go inside someone: their body, then cells, molecules and atoms. */
function enterPerson(pid: string, focus: Ref | null, bio?: Biography | null): void {
  micro.setPerson(pid, bio);
  inspector.openPerson(pid);
  inspector.el.classList.add('open');
  setLevel('person', focus, () => {
    // opened from a biography elsewhere: the levels above become where they live
    if (level !== 'street' && bio?.where && world.bodies[bio.where.body]) { ctx.body = bio.where.body; ctx.system = world.bodies[ctx.body].system; ctx.city = 0; }
  });
}

/** The selection a micro level opens with: the cell, the molecule, the atom as a whole. */
const MICRO_SELECT: Partial<Record<Level, string>> = { cell: 'mcell', molecule: 'mmol', atom: 'matom' };

function dive(p: Ref): void {
  if (p.kind === 'thing' && (p.ex === 'futu' || p.ex === 'futx')) { enterFuture(p.ex === 'futu' ? p.id : foamSeed(p.id), p); return; }
  if (p.kind === 'person' && level === 'street') { const id = street.personId(p.id); if (id) { street.focus = p.id; enterPerson(id, p); } return; }
  if (p.kind === 'thing' && level === 'atom' && p.ex === 'mnuc' && !busy) { const v = micro.views.atom.nucleusView(); fly(v.pos, v.target, 1.4, easeInOut, undefined, true); return; }
  if (p.kind === 'thing' && isMicro(level)) {
    const e = micro.enterRef(level, p, ctx);
    if (e) setLevel(e.next, p, () => {
      e.prep();
      inspector.openPerson(null);
      const ex = MICRO_SELECT[e.next];
      if (ex) select({ kind: 'thing', ex, id: 0, name: '', pos: new THREE.Vector3() });
    });
    return;
  }
  // whatever we go into becomes the selection, so a stale one (from the URL, say) can't linger
  if (p.kind === 'city' && level === 'planet') {
    const b = world.bodies[ctx.body].name;
    if (ctx.selected?.kind !== 'city' || ctx.selected.id !== p.id) select({ kind: 'city', id: p.id, name: p.id === 0 ? `${b} capital` : `${b} settlement ${p.id}`, pos: new THREE.Vector3() });
  } else if ((p.kind === 'body' || p.kind === 'system') && (ctx.selected?.kind !== p.kind || ctx.selected.id !== p.id)) select(asPick(p));
  if (p.kind === 'galaxy' && (p.name ?? GALAXIES[p.id]?.name) !== 'Milky Way') {
    // no deeper level for other galaxies yet: frame it in the Local Group
    const at = level === 'universe' ? views.universe.locate(ctx, p) : null;
    if (at && !busy) fly(at.clone().add(camera.position.clone().sub(at).setLength(GALAXIES[p.id].radius / 10000 * 3 * 4)), at, 1.1, easeInOut, undefined, true);
    else if (level !== 'universe') setLevel('universe');
    return;
  }
  if (p.kind === 'galaxy') setLevel('galaxy', p);
  else if (p.kind === 'humanspace') setLevel('local', p);
  else if (p.kind === 'system') setLevel('system', p, () => { ctx.system = p.id; });
  else if (p.kind === 'body') setLevel('planet', p, () => { ctx.body = p.id; ctx.system = world.bodies[p.id].system; });
  else if (p.kind === 'city' && !(level === 'street' && ctx.city === p.id)) setLevel('street', p, () => { ctx.city = p.id; ctx.system = world.bodies[ctx.body].system; });
}

function fetchHistory(): void {
  const p = ctx.selected;
  if (p?.kind !== 'body' && p?.kind !== 'city') return;
  const id = p.kind === 'body' ? p.id : ctx.body, g = runGen;
  sim.history(id).then((h) => { if (g !== runGen || ctx.selected !== p) return; history = h; charts.draw(); refreshPanels(); });
}

function select(p: Pickable | null): void {
  const changed = p?.kind !== ctx.selected?.kind || p?.id !== ctx.selected?.id;
  // picking something new shows its card, not the polity, chronicle or life that was open over it
  if (changed && p) { inspector.polityOpen = null; inspector.chronicleOpen = false; if (inspector.personId) inspector.openPerson(null); }
  ctx.selected = p;
  if (focusKey && (!p || refKey(p) !== focusKey)) unfocus();
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
  annals: () => sim.annals(),
};
inspector.onAnnals = (a) => { timeline.setAges(a?.ages ?? []); calendar.annals = a; timeline.refresh(); };
inspector.onSelect = (p) => { select(p); if (p) travelTo(p); };
setShipApi((f, t, d) => sim.ship(f, t, d), () => refreshPanels(), (b, y) => sim.residents(b, y, 0, 6));
setMissionApi((id) => sim.data<'mission'>({ type: 'mission', mission: id }));
inspector.onYear = (y) => timeline.set(y, true);
inspector.onMission = (id) => dataPanel.openMission(id);
inspector.onSat = (n) => dataPanel.openSat(n);
inspector.onImpact = (id) => dataPanel.openImpact(id);
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
inspector.onLookCloser = (pid, bio) => enterPerson(pid, null, bio);
inspector.onEnter = () => { if (ctx.selected) dive(ctx.selected); };
inspector.onBio = () => { if (micro.pid) { inspector.openPerson(micro.pid); inspector.el.classList.add('open'); } };

/** Seek to a year (and a world): a click may name a year not yet simulated. */
function seekTo(y: number, b?: number): void {
  // events past the simulated frontier can't be shown yet: park the year, go as far
  // as we can, and the loop lands on the real year once it's simulated
  const front = sim.done ? 10000 : (sim.years[sim.frontier] ?? 0);
  pendingYear = y > front ? y : null;
  timeline.set(Math.min(y, front), true);
  if (b != null) select(asPick({ kind: 'body', id: b }));
}

// the shared surface the feature modules install against; declared before the
// first install call, with mutable state read lazily so nothing goes stale
export const api: AppApi = {
  app, world, sim, ctx, timeline, inspector, street, naming, seedInput,
  get search() { return search; },
  level: () => level,
  runGen: () => runGen,
  pendingYear: () => pendingYear,
  setPendingYear: (y) => { pendingYear = y; },
  pull: () => pull,
  setPull: (r) => { pull = r; },
  seekTo, select, asPick, setLevel, startRun, shipId,
};

// pick one person and follow their whole life: a quiet panel off the header
const follow = installFollow(api);

// Wheel out past the outer limit goes up a level. Wheel in over a thing pulls
// it to the centre of the view, and once close enough enters it.
let pull: Ref | null = null, lastWheel = 0;
canvas.addEventListener('wheel', (e) => {
  rig.interrupt(); // a travel hands over to the wheel; a flight between levels hurries
  if (director.active) { director.userInput(); return; } // zoom only: no diving into a city mid-impact
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
  const keep = pull && locateRef(v, pull) ? pull : null;
  const sel = ctx.selected && locateRef(v, ctx.selected) ? enterableRef(ctx.selected) : null;
  const p: Ref | null = (gesture && keep) || pickAt(e.clientX, e.clientY) || keep || sel;
  if (!p || (level === 'street' && p.kind !== 'person') || (level === 'planet' && p.kind !== 'city')) return;
  pull = p;
  if (focusKey && refKey(p) !== focusKey) unfocus();
  const at = locateRef(v, p);
  const dd = level === 'street' ? 1.1 : v.diveDist(ctx, p);
  if (at && dd > 0 && camera.position.distanceTo(at) < Math.max(dd, v.limits[0] * 1.4)) { pull = null; if (p.kind !== 'person') select(asPick(p)); dive(p); }
  // capture, so the pick sees the view before OrbitControls zooms it and slides the thing out from under the cursor
}, { passive: true, capture: true });
// a label sits over its own point: scrolling on it scrolls the scene
labelsEl.addEventListener('wheel', (e) => { e.preventDefault(); canvas.dispatchEvent(new WheelEvent('wheel', e)); }, { passive: false });

/**
 * A selection made deeper down (a city, a world) seen from higher up: wheeling into it enters
 * whatever holds it at this level, so the Milky Way from the Local Group, human space from the galaxy.
 */
function enterableRef(r: Ref): Ref {
  if (r.kind !== 'system' && r.kind !== 'body' && r.kind !== 'city') return r;
  const sys = r.kind === 'system' ? r.id : r.kind === 'body' ? world.bodies[r.id].system : world.bodies[ctx.body].system;
  if (level === 'universe') { const name = world.systems[sys].galaxy; return { kind: 'galaxy', id: GALAXIES.findIndex((g) => g.name === name), name }; }
  if (level === 'galaxy') return world.systems[sys].region === 'galaxy' ? { kind: 'system', id: sys } : { kind: 'humanspace', id: 0 };
  if (level === 'local' && r.kind !== 'system') return { kind: 'system', id: sys };
  if (level === 'system' && r.kind === 'city') return { kind: 'body', id: ctx.body };
  return r;
}
canvas.addEventListener('pointerdown', () => { pull = null; });
// grabbing the view stops a travel where it is (capture: before OrbitControls sees the press, so the drag starts at once)
canvas.addEventListener('pointerdown', () => { rig.interrupt(); director.userInput(); }, { capture: true });
labelsEl.addEventListener('pointerdown', () => { rig.interrupt(); }); // a press on a label is a hand on the view too

/** Where a selected thing sits in a view: explained things (stars, asteroids, ships…) know their own place. */
function locateRef(v: View, r: Ref): THREE.Vector3 | null {
  return r.kind === 'thing' ? (r.ex ? explainLocate(r.ex, r.id) : null) : v.locate(ctx, r);
}

function asPick(r: Ref): Pickable {
  if (r.kind === 'thing') return { kind: 'thing', id: r.id, ex: r.ex, name: r.name ?? '', pos: new THREE.Vector3() };
  const name = r.kind === 'system' ? world.systems[r.id].name : r.kind === 'body' ? world.bodies[r.id].name : r.kind === 'humanspace' ? 'Human space' : r.name ?? '';
  return { kind: r.kind, id: r.id, name, pos: new THREE.Vector3() };
}

// ------------------------------------------------------------------ picking

const proj = new THREE.Vector3();
let pickScore = Infinity;
function pickAt(x: number, y: number): Pickable | null {
  const r = canvas.getBoundingClientRect();
  let best: Pickable | null = null, bestD = 16;
  pickScore = Infinity;
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
  if (best) pickScore = bestD;
  return best;
}

// Everything else drawn (every star particle, asteroid, ship, satellite…) is picked by src/explain:
// GPU colour-ID picking for point clouds, a CPU path for sprites and lines. The sim's own things win ties.
const picker = new Picker(renderer, camera);
const exCtx = () => ({ world, snap: ctx.snap, year: ctx.year });
function pickAny(x: number, y: number): Pickable | null {
  const p = pickAt(x, y), ps = pickScore;
  const r = canvas.getBoundingClientRect();
  const t = picker.pick(x - r.left, y - r.top, r.width, r.height);
  if (!t || (p && ps <= t.score + 2)) return p;
  const e = explainerFor(t.kind);
  const id = e?.idOf ? e.idOf(t.i) : t.i;
  if (!e || id < 0) return p;
  const as = e.selectAs?.(id, exCtx());
  if (as) return { ...asPick({ kind: as.kind, id: as.id, name: as.name }), name: e.name ? e.name(id, exCtx()) : as.name };
  return { kind: 'thing', id, ex: t.kind, name: explainName(t.kind, id, exCtx()), pos: new THREE.Vector3() };
}
// hover picks run in the frame loop, at most ~25 times a second, never per pointer event
let hoverAt: { x: number; y: number } | null = null, hoverT = 0;
function hover(now: number): void {
  if (!hoverAt || rig.flying || now - hoverT < 40) return;
  hoverT = now;
  const { x, y } = hoverAt;
  hoverAt = null;
  const p = pickAny(x, y);
  // backdrop stars don't stop the orbits; anything else does, so it can be clicked
  hovering = !!p && !(p.kind === 'thing' && /^(sky|bgal|dust)/.test(p.ex ?? ''));
  tooltip.hidden = !p;
  if (p) { tooltip.textContent = p.kind === 'body' ? naming.place(world, p.id) : p.name; tooltip.style.transform = `translate(${x + 14}px, ${y + 10}px)`; }
  canvas.style.cursor = p ? 'pointer' : '';
}
let downAt = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
let hovering = false, motion = 1;
canvas.addEventListener('pointerleave', () => { hovering = false; hoverAt = null; tooltip.hidden = true; });
canvas.addEventListener('pointermove', (e) => { hoverAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const p = pickAny(e.clientX, e.clientY);
  if (p?.kind === 'person') openResident(p.id);
  else if (p) { if (isMicro(level) && inspector.personId) inspector.openPerson(null); select(p); travelTo(p); }
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
  if (busy || director.active) return;
  const p = pickAny(e.clientX, e.clientY);
  if (p?.kind === 'person') { openResident(p.id); dive(p); }
  else if (p) { if (isMicro(level) && inspector.personId) inspector.openPerson(null); select(p); dive(p); }
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
    const own = c.l.ref?.kind === 'body' ? naming.local(c.l.ref.id) : null; // a world by its own name, the catalogue's underneath
    const text = own ?? c.l.text, sub = own ? (c.l.sub ? `${c.l.text} · ${c.l.sub}` : c.l.text) : c.l.sub;
    const html = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
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
      e.w = 10 + Math.max(text.length * 6, (sub?.length ?? 0) * 6); e.h = sub ? 26 : 15;
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
labelsEl.addEventListener('click', (e) => { const ref = labelRef(e.target); if (ref) { select(asPick(ref)); travelTo(ref); } });
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
  const at = ctx.selected && !own ? locateRef(v, ctx.selected) : null;
  if (!at) { ringEl.hidden = true; return; }
  proj.copy(at).project(camera);
  if (proj.z > 1) { ringEl.hidden = true; return; }
  const r = canvas.getBoundingClientRect();
  const worldR = ctx.selected!.kind === 'thing' ? 0 : v.size?.(ctx, ctx.selected!) ?? 0;
  const d = camera.position.distanceTo(at);
  const px = worldR ? (worldR / (d * Math.tan((camera.fov * Math.PI) / 360))) * (r.height / 2) : 0;
  const R = Math.min(Math.max(px + 6, 13), Math.max(r.width, r.height));
  ringEl.hidden = false;
  ringEl.style.transform = `translate(${((proj.x * 0.5 + 0.5) * r.width).toFixed(1)}px, ${((-proj.y * 0.5 + 0.5) * r.height).toFixed(1)}px)`;
  ringEl.style.setProperty('--r', `${R.toFixed(1)}px`);
}

// ------------------------------------------------------------------ sim wiring

/** The viewed world's society shapes how it looks from orbit; fetch it and redraw if its look has changed. */
function refreshLook(step: number): void {
  if (level !== 'planet' && level !== 'street') return;
  const b = ctx.body, key = `${b}:${step}`, g = runGen;
  if (key === lookAsked) return;
  lookAsked = key;
  sim.society(b, step).then((r) => {
    if (g !== runGen || !r.society) { if (r.pending) lookAsked = ''; return; }
    if (setSocietyLook(b, sim.years[step], r.society.architecture) && ctx.body === b) views[level].sync(ctx);
  });
}

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
    showEra(m);
    streetMood();
    renderHere();
    refreshPanels();
    renderLegend();
    refreshLook(m.step);
    if (wanted !== ask) requestState(sim.years[wanted]);
    else refreshEvents();
  });
}

/** The era now: its name (counted, "Third Expansion") on the timeline, its grade on the picture, a banner when it turns. */
function showEra(m: StateMsg): void {
  const r = eraRun(sim.years, (i) => sim.series[i * NGM + GM.era], m.step);
  timeline.setEra(eraTitle(r));
  eraMood.setEra(m.globals.era);
  eraBanner.show(r);
  showWar(m.globals.year);
}

const warEl = app.querySelector<HTMLElement>('.legend-war')!;
let warTimer = 0;
/** The way of war at this year, a moment after time stops moving. */
function showWar(year: number): void {
  clearTimeout(warTimer);
  warTimer = window.setTimeout(() => sim.wayOfWar(year).then((m) => { warEl.innerHTML = wayOfWarHtml(m.way); }), 250);
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
// other futures behind every chart, played in the background once this one is done
const ensemble = new Ensemble();
let ensembleFor = -1;
ensemble.onUpdate = () => {
  charts.draw();
  for (const f of ensemble.futures()) multiverse.add(f.seed, sim.years, f.series, f.series.length, true);
  multiverse.progress = { done: ensemble.count, of: ENSEMBLE_SIZE };
  if (level === 'multiverse') multiverse.sync(ctx);
};
charts.setBand((k, n) => ensemble.band(k, n), (k, i, v) => ensemble.rank(k, i, v));

function refreshPanels(): void {
  if (!sim.years.length) return; // nothing simulated yet (a level entered from the URL before the first rows)
  const step = Math.max(0, sim.stepAt(ctx.year));
  const row = (col: number) => sim.series[step * NGM + col];
  inspector.render({
    world, snap: ctx.snap, year: ctx.year, selected: ctx.selected, body: ctx.body, events, history,
    globalRow: row,
    forecast: fcOn && fc ? oddsHtml(fc, (k) => row(GM[k])) : undefined,
  });
  charts.setYear(ctx.year);
  const sel = ctx.selected, place = sel?.kind === 'body' ? sel.id : sel?.kind === 'city' || level === 'planet' || level === 'street' ? ctx.body : -1;
  calendar.place(ctx.snap, place, ctx.year, sim.years[sim.frontier] ?? 0);
  dataPanel.refresh();
  assistant?.contextChanged();
  follow.followYear(ctx.year);
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
  else travelTo(r);
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

// a hand on the timeline (the slider and its keys, a typed year, an age, Play, the Space and arrow
// shortcuts) drops a year parked by a link, the URL or Watch; seeks made in code keep it
installTimelineHand(api);

sim.onProgress = () => {
  const era = GM.era;
  timeline.setData(sim.done ? 10000 : sim.years[sim.frontier], { years: sim.years, n: sim.frontier + 1, era: (i) => sim.series[i * NGM + era] });
  statusEl.textContent = sim.done ? `simulated in ${(sim.ms / 1000).toFixed(1)}s` : `simulating… year ${Math.round(sim.years[sim.frontier]).toLocaleString('en-US')}`;
  charts.draw();
  if (!ctx.snap) requestState(ctx.year);
  if (sim.done) { refreshForecast(); inspector.annals(); if (ensembleFor !== sim.seed) { ensembleFor = sim.seed; ensemble.start(sim.seed); multiverse.progress = { done: 0, of: ENSEMBLE_SIZE }; } }
  // this future in the multiverse, as far as it has been played
  if (sim.done || sim.frontier % 25 === 0) { multiverse.add(sim.seed, sim.years, sim.series, sim.frontier + 1, sim.done); if (level === 'multiverse') multiverse.sync(ctx); }
  // a reseed drops the place history; ask again as the new run fills in
  if (!history && (sim.done || sim.frontier % 40 === 0)) fetchHistory();
  // a year from the URL waits until the run has reached it
  if (pendingYear !== null && (sim.done || sim.years[sim.frontier] >= pendingYear)) { const y = pendingYear; pendingYear = null; timeline.set(y, true); }
};

// ------------------------------------------------------------------ URL: #future3-y1360-b123-lplanet

let pendingYear: number | null = null, hashTimer = 0, leaving = false;
const REF_CODE: Record<string, string> = { body: 'b', system: 's', galaxy: 'g', humanspace: 'h', city: 'c' };
function writeHash(): void {
  clearTimeout(hashTimer);
  if (leaving) return;
  hashTimer = window.setTimeout(() => {
    const sel = ctx.selected;
    // a linked year still waiting for the run to reach it stays in the link
    const yy = pendingYear ?? ctx.year;
    const parts = [`future${sim.seed}`, `y${Math.abs(yy - Math.round(yy)) < 0.005 ? Math.round(yy) : yy.toFixed(2)}`];
    if (sel) parts.push(sel.kind === 'city' ? `c${ctx.body}.${sel.id}` : sel.kind === 'thing' ? `x${sel.ex}.${sel.id}` : `${REF_CODE[sel.kind]}${sel.id}`);
    if (isMicro(level) && micro.pid) parts.push(`p${micro.pid.replace(/-/g, '~')}`, micro.hash());
    parts.push(...urlPartTokens(), `l${level}`, STAMP_CODE);
    // replaceState so scrubbing doesn't flood the back button
    try { window.history.replaceState(null, '', `#${parts.join('-')}`); } catch { /* sandboxed frames may refuse */ }
  }, 400);
}
setHashWriter(writeHash);

function readHash(): { seed: number; year: number | null; sel: Pickable | null; level: Level | null; pid: string | null } {
  const h = location.hash.slice(1);
  const seed = Number(h.match(/future(\d+)/)?.[1]) || 0;
  // a year may carry a fraction (y63.78): Mars's seasons, a storm's month
  const y = h.match(/(?:^|-)y(\d+(?:\.\d+)?)/);
  const lv = h.match(/(?:^|-)l(multiverse|universe|galaxy|local|system|planet|street|person|cell|molecule|atom)(?=-|$)/)?.[1] as Level | undefined;
  const pid = h.match(/(?:^|-)p([0-9.~]+)(?=-|$)/)?.[1]?.replace(/~/g, '-') ?? null;
  micro.readHash(h);
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
  const x = h.match(/(?:^|-)x([a-z0-9]+)\.(\d+)(?=-|$)/);
  // kinds inside a system or around a world register when that view is built, so accept any well-formed one
  if (x) sel = { kind: "thing", id: Number(x[2]), ex: x[1], name: "", pos: new THREE.Vector3() };
  return { seed, year: y ? Math.min(10000, Number(y[1])) : null, sel, level: lv && (!isMicro(lv) || pid) ? lv : null, pid };
}

function startRun(seed: number): void {
  runGen++;
  clearSocietyLooks();
  inspector.resetPeople();
  follow.lifePick.hide();
  follow.stopFollow();
  resetShips();
  ctx.snap = null; lastStep = -1; wanted = -1; inFlight = false; events = []; history = null; fc = null;
  ticker.clear(); tickFrom = 0;
  eraBanner.reset(); calendar.reset(); naming.load(sim); timeline.setAges([]);
  ensemble.stop(); ensembleFor = -1;
  multiverse.current = seed; multiverse.progress = { done: 0, of: 0 };
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
  ['Backspace', 'up a level'], ['+ −', 'zoom in or out'], ['Esc', 'skip a flight, or clear the selection'], ['Shift', 'hold to hurry a flight'], ['`', 'ask the ship computer (hold to talk)'], ['?', 'this list'],
] as const).map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join('')}</dl><p class="muted">Click a world to travel to it; scroll into anything to enter it; scroll out past the edge to go up. Drag, scroll or tap during a flight to take over. Type a year into the year to jump there.</p><button class="link" type="button">Close</button>`;
app.append(help);
help.querySelector('button')!.addEventListener('click', () => { help.hidden = true; });

window.addEventListener('keydown', (e) => {
  // the slider keeps arrows for itself but lets Space through
  if (e.target instanceof HTMLInputElement && e.target.type === 'range' && e.code === 'Space') { e.preventDefault(); timeline.toggle(); return; }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // while an impact plays, Space plays and pauses it, the arrows scrub it and Esc leaves it
  if (director.active) {
    if (e.code === 'Space') { e.preventDefault(); director.toggle(); return; }
    if (e.key === 'Escape') { director.exit(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); director.seek(director.t + (e.key === 'ArrowRight' ? 1 : -1)); return; }
    if (e.key === 'Backspace' || e.key === 'Enter') return;
  }
  // typing a name anywhere goes to search, so letters never fire shortcuts
  if (e.key.length === 1 && /[\p{L}\p{N}#]/u.test(e.key)) { e.preventDefault(); search.focus(e.key); return; }
  if (e.code === 'Space') { e.preventDefault(); timeline.toggle(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); timeline.step(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey); }
  else if (e.key === '+' || e.key === '=') zoomStep(-1);
  else if (e.key === '-' || e.key === '_') zoomStep(1);
  else if (e.key === 'Escape') { if (rig.flying) rig.skip(); else if (!help.hidden) help.hidden = true; else if (!follow.lifePick.el.hidden) follow.lifePick.hide(); else if (follow.following()) follow.stopFollow(); else if (level === 'street' && street.follow >= 0) street.follow = -1; else select(null); }
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
  // "resident 12 of Titan", "#12 on Titan", "#12 titan"
  const res = q.match(/^(?:resident|person|citizen)?\s*#\s*([\d.,_]+\s*[kmbt]?)(?:\s+(?:(?:of|on|in|at|from)\s+)?(.*))?$/) ?? q.match(/^(?:resident|person|citizen)\s+#?\s*([\d.,_]+\s*[kmbt]?)(?:\s+(?:(?:of|on|in|at|from)\s+)?(.*))?$/);
  if (res) {
    const n = Math.max(1, parseCount(res[1]) || 1);
    const where = res[2]?.trim();
    const bodies = where ? findBodies(where, 6) : ctx.selected?.kind === 'body' ? [{ kind: 'body' as const, id: ctx.selected.id, name: '', sub: '' }] : [];
    if (!where && !bodies.length) return [{ kind: 'note', id: -1, name: `Resident #${n.toLocaleString('en-US')} of which world?`, sub: 'try "resident 12 of Titan", or select a world first' }];
    const living = bodies.filter((b) => alive(stageOf(ctx.snap, b.id)));
    if (!living.length && bodies.length) return [{ kind: 'note', id: bodies[0].id, name: `Nobody lives on ${world.bodies[bodies[0].id].name} in ${Math.round(2040 + ctx.year)}`, sub: 'try a later year' }];
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
    else travelTo({ kind: 'system', id: h.id });
  } else {
    if (h.kind === 'resident') inspector.showResident(h.id, h.n!);
    select(asPick({ kind: 'body', id: h.id }));
    goToBody(h.id);
  }
};

// ------------------------------------------------------------------ what leads to…?

installPaths(api, follow);

// ------------------------------------------------------------------ the Starship

/** A run of the timeline to a target year: the chrono bubble follows how fast the year moves. */
let chronoTrip: { from: number; to: number; t: number; dur: number; done: (y: number) => void } | null = null;

function placeLine(): string {
  const yr = Math.round(2040 + ctx.year), era = ctx.snap?.globals.era ?? '';
  const sel = ctx.selected;
  const where = isMicro(level) ? `inside ${micro.bio?.name ?? 'someone'}, at the scale of ${level === 'person' ? 'their body' : level === 'cell' ? 'a cell' : level === 'molecule' ? 'a molecule' : 'an atom'}`
    : level === 'multiverse' ? 'outside every future, among the others'
    : level === 'street' ? `in ${world.bodies[ctx.body].name} settlement ${ctx.city}`
    : level === 'planet' ? `over ${world.bodies[ctx.body].name}`
    : sel?.kind === 'body' ? `near ${world.bodies[sel.id].name}`
    : level === 'system' ? `in the ${world.systems[ctx.system].name} system`
    : level === 'local' ? 'among the stars around the Sun' : level === 'galaxy' ? 'above the Milky Way' : 'out in the Local Group';
  const b = level === 'planet' || level === 'street' ? ctx.body : sel?.kind === 'body' ? sel.id : -1;
  const people = b >= 0 && alive(stageOf(ctx.snap, b)) ? ` ${fmtNum(popOf(ctx.snap, b))} people live there.` : '';
  return `We're ${where}, in ${yr}${era ? `, during ${/^[AEIOU]/.test(era) ? 'an' : 'a'} ${era.toLowerCase()}` : ''}.${people}`;
}

const shipConsole = new ShipConsole({
  first: 2040, last: 2040 + 10000,
  year: () => Math.round(2040 + ctx.year),
  lookup: (name) => find(name).find((x) => x.kind !== 'note' && x.kind !== 'tech')?.name ?? null,
  goto(name) {
    const h = find(name).find((x) => x.kind !== 'note' && x.kind !== 'tech');
    if (!h) return null;
    search.onPick(h);
    return h.name;
  },
  random({ habitable, kind }) {
    const kinds: Record<string, string[]> = { ocean: ['ocean'], ice: ['ice', 'dwarf'], lava: ['lava'], gas: ['gas', 'icegiant'] };
    const pool = (ctx.snap ? [...ctx.snap.settled] : []).filter((b) => {
      const body = world.bodies[b];
      if (kind && !kinds[kind]?.includes(body.kind)) return false;
      if (habitable && body.hab < 0.3) return false;
      return kind === 'gas' || alive(stageOf(ctx.snap, b));
    });
    if (kind === 'gas' && !pool.length) world.bodies.forEach((b) => { if (b.kind === 'gas' || b.kind === 'icegiant') pool.push(b.id); });
    if (!pool.length) return null;
    const b = pool[Math.floor(Math.random() * pool.length)];
    search.onPick({ kind: 'body', id: b, name: world.bodies[b].name, sub: '' });
    return `${world.bodies[b].name}, ${world.systems[world.bodies[b].system].name}`;
  },
  timeTravel: (cal) => timeTravel(cal - 2040).then((y) => Math.round(2040 + y)),
  status: placeLine,
  setView: (v) => voyage.setView(v),
  leave: () => board(false),
});
app.append(shipConsole.el);
const boardBtn = app.querySelector<HTMLButtonElement>('#board')!;
function board(on: boolean): void {
  voyage.board(on);
  boardBtn.textContent = on ? 'Leave the Starship' : 'Board the Starship';
  boardBtn.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('aboard', on);
  // on a phone the console and the bottom sheet share the same strip: fold the sheet to show the console
  if (on && phone.matches) inspector.el.classList.remove('open');
  if (on) shipConsole.open(); else shipConsole.close();
}
boardBtn.addEventListener('click', () => board(!voyage.boarded));

/** Run the timeline to a sim year as a chrono trip; resolves with the year reached once its state has loaded. */
function timeTravel(simYear: number): Promise<number> {
  const to = Math.max(0, Math.min(simYear, sim.done ? 10000 : sim.years[sim.frontier]));
  return new Promise((done) => {
    const d = Math.abs(to - ctx.year);
    chronoTrip = { from: ctx.year, to, t: 0, dur: reducedMotion ? 0.01 : 1.8 + 1.1 * Math.log10(1 + d), done };
  });
}

// ------------------------------------------------------------------ the GPT assistant (src/assistant)

/** The selection in words, for the assistant's context. */
function selectionLine(): string {
  const p = ctx.selected;
  const who = inspector.personId ? `the life of ${(inspector.el.querySelector('h2')?.textContent ?? 'a person').trim()} is open` : '';
  if (!p) return who;
  const what = p.kind === 'body' ? `${naming.place(world, p.id)} (${world.bodies[p.id].kind} in the ${world.systems[world.bodies[p.id].system].name} system)`
    : p.kind === 'system' ? `the ${world.systems[p.id].name} star system`
    : p.kind === 'city' ? `${p.id === 0 ? 'the capital' : `settlement ${p.id}`} of ${naming.place(world, ctx.body)}`
    : p.name || (p.kind === 'thing' && p.ex ? explainName(p.ex, p.id, exCtx()) : p.kind);
  return who ? `${what}; ${who}` : what;
}
const askBtn = app.querySelector<HTMLButtonElement>('#ask')!;
const tlSub = timeline.el.querySelector<HTMLElement>('.tl-sub');
assistant = new Assistant({
  world, sim,
  year: () => ctx.year,
  snap: () => ctx.snap,
  level: () => level,
  selection: selectionLine,
  card: () => [...inspector.el.querySelectorAll<HTMLElement>(':scope > :not(.insp-grab):not(.insp-close)')].map((e) => e.innerText).join('\n').trim(),
  eraLine: () => tlSub?.textContent ?? '',
  boarded: () => voyage.boarded,
  find,
  place: (b) => naming.place(world, b),
  goto: (h) => search.onPick(h),
  openPerson: (pid) => { inspector.openPerson(pid); inspector.el.classList.add('open'); },
  setYear: (y) => voyage.boarded ? timeTravel(y) : new Promise((done) => { timeline.set(Math.max(0, Math.min(y, sim.done ? 10000 : sim.years[sim.frontier])), true); arrived(ctx.year, done); }),
  setLevel: (l) => { pull = null; if (l !== level) setLevel(l); return true; },
  openData: (tab) => { if (!dataPanel.open) app.querySelector<HTMLButtonElement>('#data')!.click(); dataPanel.show(tab); return true; },
  openChronicle: () => { if (!inspector.chronicleOpen) app.querySelector<HTMLButtonElement>('#chronicle')!.click(); },
  starship: (a) => {
    if (a === 'board' || a === 'leave') { if (voyage.boarded !== (a === 'board')) board(a === 'board'); return; }
    if (!voyage.boarded) board(true);
    shipConsole.setView(a);
  },
});
{
  const ai = assistant;
  app.append(ai.el);
  askBtn.addEventListener('click', () => ai.toggle());
  new MutationObserver(() => askBtn.setAttribute('aria-pressed', String(ai.open))).observe(ai.el, { attributes: true, attributeFilter: ['hidden'] });
  // aboard, the ship computer is the assistant's face: its log mirrors the conversation and its Talk opens the voice line
  ai.redirect = () => { if (!voyage.boarded) return false; shipConsole.focus(); return true; };
  ai.mirror = { line: (who, text, key) => { if (who === 'you' && !key) return; shipConsole.hear(who, text, key); }, live: (on) => shipConsole.setLive(on) };
  ai.onTextAnswer = (t) => { if (voyage.boarded) shipConsole.speak(t); };
  shipConsole.brain = {
    ready: () => ai.available === 'ready',
    live: () => ai.voice.live,
    ask: (t) => ai.ask(t, false),
    talk: () => { if (ai.voice.state === 'off') void ai.startVoice('handsfree'); else ai.voice.disconnect('Voice off.'); },
  };
}

/** Light the hull from the star of the system or planet we're at, as the sim's camera sees it. */
const lightDir = new THREE.Vector3();
function shipLight(): void {
  if (level === 'system' || level === 'planet' || level === 'street') {
    lightDir.set(0, 0, 0).sub(camera.position);
    if (level === 'planet') lightDir.copy(PLANET_SUN).sub(camera.position);
    lightDir.applyQuaternion(camera.quaternion.clone().invert());
    voyage.lightFrom(lightDir.set(-lightDir.x, lightDir.y, -lightDir.z));
  } else voyage.lightFrom(lightDir.set(0.4, 0.8, 0.5));
}

// ------------------------------------------------------------------ go

// the app only ever replaces the hash, so a change here is someone pasting or editing a link: go there
// (and stop writing our own hash first, or the reload would land back where we were)
window.addEventListener('hashchange', () => { leaving = true; clearTimeout(hashTimer); setTimeout(() => location.reload(), 0); });
const fromHash = readHash();
if (fromHash.seed) seedInput.value = String(fromHash.seed);
if (fromHash.pid) { micro.setPerson(fromHash.pid); micro.readHash(location.hash.slice(1)); }
startRun(fromHash.seed || 1);
// (after startRun, which forgets the people of any previous future)
if (fromHash.pid && fromHash.level && isMicro(fromHash.level)) { placeFromBio = true; inspector.openPerson(fromHash.pid); inspector.el.classList.add('open'); }
if (fromHash.sel) {
  const b = fromHash.sel.kind === 'body' ? fromHash.sel.id : fromHash.sel.kind === 'city' ? ctx.body : -1;
  if (b >= 0) { ctx.body = b; ctx.system = world.bodies[b].system; }
  if (fromHash.sel.kind === 'system') ctx.system = fromHash.sel.id;
  select(fromHash.sel);
}
setLevel(fromHash.level ?? 'system', null, undefined, false);
pendingYear = fromHash.year;
applyUrlParts(location.hash.slice(1));

/** Report a time trip once the state for its year has arrived, so "where are we" reads that year's numbers. */
function arrived(y: number, done: (y: number) => void, tries = 0): void {
  if (tries > 100 || (!inFlight && lastStep === sim.stepAt(y))) done(y);
  else setTimeout(() => arrived(y, done, tries + 1), 50);
}

let last = performance.now(), frame = 0, lastYear = 0, yearRate = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000), wall = Math.min(1, (now - last) / 1000); // trips run on the clock, even on a slow machine
  last = now;
  if (chronoTrip) {
    const c = chronoTrip;
    c.t += wall;
    const k = Math.min(1, c.t / c.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    timeline.set(c.from + (c.to - c.from) * e, true);
    if (k >= 1) { chronoTrip = null; arrived(ctx.year, c.done); }
  }
  govern(dt);
  ctx.t += dt;
  motion += ((hovering ? 0 : 1) - motion) * (1 - Math.exp(-dt * 5));
  ctx.tm += dt * motion;
  timeline.tick(dt);
  // the world moves first, so the camera follows where things are this frame, not where they were
  views[level].frame(ctx, dt);
  director.frame(dt);
  if (!director.active) finishRestore();
  if (!rig.flying && !director.active) {
    // wheel-in target drifts to the thing under the cursor
    const at = pull ? locateRef(views[level], pull) : null;
    if (at) controls.target.lerp(at, 1 - Math.exp(-dt * 6));
  }
  rig.frame(dt);
  director.afterRig();
  player.frame();
  drawHud();
  sky.position.copy(camera.position);
  yearRate = dt > 0 ? (ctx.year - lastYear) / dt : 0;
  if (voyage.boarded) {
    shipLight();
    const fx = voyage.frame(dt, ctx.t, { camera, orbit: rig.pivot, jumping: busy, travel: rig.travelling ? rig.speed : 0, yearRate });
    shipConsole.engine.update(fx.throttle, fx.warp, fx.chrono, fx.chronoDir, chronoTrip ? Math.min(1, chronoTrip.t / chronoTrip.dur) : 0);
  }
  lastYear = ctx.year;
  eraMood.frame(dt, ctx.t, camera.aspect);
  composer.render();
  hover(now);
  if (frame++ % 2 === 0) drawLabels();
  drawRing();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (import.meta.env.DEV) Object.assign(window, { __app: { assistant, ctx, views, setLevel, dive, select, timeline, camera, controls, micro, multiverse, enterPerson, street, inspector, sim, get level() { return level; }, get busy() { return busy; }, get flying() { return rig.flying; }, rig, travelTo, goToBody, zoomStep, get following() { return follow.following(); }, get pull() { return pull; }, director, visualize } });
