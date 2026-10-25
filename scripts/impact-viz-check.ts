// Checks the impact visualization: the visual-scenario contract (src/impact/visual.ts),
// the timeline and state machine (vizTimeline.ts, src/view/impactDirector.ts), the
// Three.js layer on the real PlanetView (src/view/impactLayer.ts), exact replay of
// logged engine impacts, and the scientific boundaries the 3D view must keep.
// Bundled like explain-check (the views draw textures at startup); exit code 1 on any failure.
//   npm run check:impactviz

// ---- browser stubs
const ctx2d: any = new Proxy({}, {
  get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop() {} })
    : (k === 'createImageData' || k === 'getImageData') ? (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w, height: h })
    : () => {},
  set: () => true,
});
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) };
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).matchMedia = () => ({ matches: false, addEventListener() {} });

const THREE = await import('three');
const { BODIES } = await import('../src/impact/bodies.ts');
const { approaches } = await import('../src/impact/catalog.ts');
const { effects } = await import('../src/impact/effects.ts');
const { entry, strengthLaw } = await import('../src/impact/entry.ts');
const { IC, IF, NIC, logRow } = await import('../src/impact/engineImpacts.ts');
const { siteDir } = await import('../src/impact/exposure.ts');
const { drawOne, evaluateDraw, sampleInputs, runScenario } = await import('../src/impact/scenario.ts');
const { TEXT, asDeflection, geodesicAngle, visualFromDraw } = await import('../src/impact/visual.ts');
const { approachVisual } = await import('../src/impact/vizApproach.ts');
const { DEMO_CASES, demoVisual, historicalVisual, labVisuals, replayVisual, singleVisual } = await import('../src/impact/vizBuild.ts');
const TL = await import('../src/impact/vizTimeline.ts');
const { handleLab } = await import('../src/sim/labData.ts');
const { Engine } = await import('../src/sim/engine.ts');
const { F, NF } = await import('../src/sim/metrics.ts');
const { buildWorld } = await import('../src/sim/world.ts');
const views = await import('../src/view/views.ts');
const { ImpactLayer } = await import('../src/view/impactLayer.ts');
const { ImpactDirector } = await import('../src/view/impactDirector.ts');
const { CameraRig } = await import('../src/view/camRig.ts');
type VS = import('../src/impact/visual.ts').VisualScenario;

let bad = 0, n = 0;
const ok = (cond: boolean, what: string) => { n++; if (!cond) { bad++; console.log(`FAIL ${what}`); } else if (process.env.VERBOSE) console.log(`  ok ${what}`); };
const section = (s: string) => console.log(`— ${s}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const world = buildWorld(), SNAP = 'check';
const ts = (v: VS, k = 400) => { const tl = TL.buildTimeline(v); return Array.from({ length: k + 1 }, (_, i) => TL.sampleAt(v, tl, (tl.duration * i) / k, TL.emptyState())); };

// ---- one future, as the worker sees it
const e = new Engine(world, 9);
while (e.st.step < 700) e.step();
const year = e.years[e.st.step];
const labEnv = (post: (r: any) => void) => ({ world, main: () => e, stateAt: () => e, post });
const lab = (req: any): any => { let out: any = null; handleLab({ id: 1, type: 'impactLab', year, seed: 7, n: 60, composition: 'unknown', ...req }, labEnv((r) => { out = r; })); return out; };
const vizReq = (req: any): any => { let out: any = null; handleLab({ id: 1, type: 'impactViz', ...req }, labEnv((r) => { out = r; })); return out; };

section('the physics is the source of truth: the display trace changes nothing');
for (const [b, D, v, a] of [['Earth', 20, 19, 18], ['Earth', 50, 13, 45], ['Venus', 100, 20, 45], ['Mars', 30, 10, 45], ['Jupiter', 1000, 60, 45]] as const) {
  const imp = { diameterM: D, densityKgM3: 3000, speedKms: v, angleDeg: a, kind: 'stony' as const };
  for (const lite of [false, true]) {
    const x = entry(BODIES[b], imp, { lite }), y = entry(BODIES[b], imp, { lite, trace: true });
    ok(x.outcome === y.outcome && Object.is(x.burstAltKm, y.burstAltKm) && Object.is(x.groundEnergyJ, y.groundEnergyJ) && Object.is(x.atmosphereEnergyJ, y.atmosphereEnergyJ) && Object.is(x.breakupAltKm, y.breakupAltKm), `${b} ${D} m${lite ? ' (lite)' : ''}: identical with the trace on`);
    ok(y.trace.length > 2 && y.trace.every((t, i) => i === 0 || t[0] >= y.trace[i - 1][0]), `${b} ${D} m${lite ? ' (lite)' : ''}: trace recorded in time order (${y.trace.length} points)`);
  }
}

section('one contract: coherent representative draws, same seed same scenario');
{
  const spec = { body: 'Earth', classification: 'hypothetical' as const, diameterM: [60, 120, 250] as [number, number, number], earth: { pop: 9e9, capital: 5e14 } };
  const r = runScenario(spec, 21, 80), v = labVisuals(r, { snapshotId: SNAP, world: world.earth, year: 0 });
  ok(same(v, labVisuals(runScenario(spec, 21, 80), { snapshotId: SNAP, world: world.earth, year: 0 })), 'same seed: identical visual scenarios');
  ok(!same(v.nominal, labVisuals(runScenario(spec, 22, 80), { snapshotId: SNAP, world: world.earth, year: 0 }).nominal), 'another seed draws another scenario');
  for (const k of ['low', 'nominal', 'high'] as const) {
    const i = r.representatives[k], d = drawOne(spec, 21, i), x = v[k];
    ok(x.draw === i && Object.is(x.effects.energyMt, d.fx.energyMt) && Object.is(x.object.diameterM, d.impactor.diameterM) && Object.is(x.trajectory.angleDeg, d.impactor.angleDeg) && same(x.trajectory.point, d.point) && x.effects.outcome === d.fx.entry.outcome && Object.is(x.exposure.deaths, d.exposure.deaths),
      `${k}: one whole draw (#${i}), every field from that draw`);
  }
  ok(v.nominal.effects.outcome === r.representatives.modal, `nominal has the most likely outcome (${r.representatives.modal})`);
  ok(v.low.effects.energyMt <= v.high.effects.energyMt, 'low ≤ high in energy');
  ok(same(JSON.parse(JSON.stringify(v.nominal)), v.nominal), 'serializable: survives JSON unchanged');
  const lr = lab({ body: 'Earth', diameterM: [60, 120, 250] });
  ok(!!lr?.result?.visual?.nominal && lr.result.visual.nominal.kind === 'impact', 'the worker returns the representatives with the bands');
  ok(same(lab({ body: 'Earth', diameterM: [60, 120, 250] }).result.visual, lr.result.visual), 'the worker: same seed, same visuals');
}

section('close approaches stay misses; "what if it hit" is a separate branch');
for (const body of ['Earth', 'Moon', 'Mars', 'Venus', 'Jupiter']) {
  const list = approaches(body).slice(0, 6);
  for (const a of list) {
    const v = approachVisual(a, world), states = ts(v, 600);
    const minD = Math.min(...states.map((s) => s.caDistKm)), R = BODIES[body].radiusKm;
    ok(v.kind === 'close-approach' && !v.render.surfaceContact && !v.render.crater && !v.render.airburst && !v.entry, `${body} ${a.des}: a close approach, nothing that hits`);
    ok(minD >= a.distKm * (1 - 1e-9) && minD >= R && Math.abs(minD - a.distKm) / a.distKm < 1e-6, `${body} ${a.des}: passes at the nominal ${Math.round(a.distKm)} km (min ${Math.round(minD)})`);
  }
  if (list[0]) {
    const a = list[0], before = JSON.stringify(approachVisual(a, world));
    const hyp = lab({ body, diameterM: Number.isFinite(a.diameterM[1]) ? a.diameterM : [50, 100, 200], vInfKms: a.vInfKms ?? undefined, banner: TEXT.hypotheticalFromApproach, objectName: a.name });
    const hv: VS = hyp.result.visual.nominal;
    ok(hv.classification === 'hypothetical' && hv.kind === 'impact' && !hv.id.startsWith('ca:') && hv.banners.includes(TEXT.hypotheticalFromApproach), `${body}: "what if it hit" is hypothetical, labelled, its own id`);
    ok(JSON.stringify(approachVisual(a, world)) === before, `${body}: the close approach itself is unchanged by the what-if`);
  }
}

section('airless worlds: no trail, no break-up, no airburst, no blast ring');
for (const body of ['Mercury', 'Moon']) {
  const r = lab({ body, diameterM: [30, 100, 400] }).result;
  for (const k of ['low', 'nominal', 'high'] as const) {
    const v: VS = r.visual[k], tl = TL.buildTimeline(v);
    ok(!v.render.atmosphereTrail && !v.render.breakup && !v.render.airburst && !v.render.blastRings && !tl.spans.some((s) => s.phase === 'entry' || s.phase === 'breakup' || s.phase === 'airburst'), `${body} ${k}: none of them`);
    ok(v.render.surfaceContact && v.render.crater, `${body} ${k}: strikes at full speed and leaves a crater`);
  }
}
{
  const v = demoVisual('moon-100m', world, SNAP)!;
  ok(v.render.crater && v.effects.crater!.finalKm > 0.5 && TL.buildTimeline(v).spans.map((s) => s.phase).join('>') === 'approach>contact>excavation>effects>aftermath', `100 m lunar impact: focus → approach → contact → crater/ejecta → aftermath (crater ${v.effects.crater!.finalKm.toFixed(2)} km)`);
}

section('Earth airburst stops above the ground; Mars reaches it; Venus is more atmospheric');
{
  const v = demoVisual('chelyabinsk', world, SNAP)!, st = ts(v, 800);
  ok(v.render.airburst && !v.render.crater && !v.render.surfaceContact, 'Chelyabinsk: an airburst, no crater, no contact');
  ok(st.every((s) => !s.obj.visible || s.obj.altKm > 15), `Chelyabinsk: the object never goes below the burst region (lowest shown ${Math.min(...st.filter((s) => s.obj.visible).map((s) => s.obj.altKm)).toFixed(1)} km)`);
  ok(st.every((s) => TL.transientScars(v, s).every((x) => x.kind !== 0)), 'Chelyabinsk: no crater mark at any instant');
  ok(v.entry!.burstAltKm! > 20 && v.entry!.burstAltKm! < 45, `Chelyabinsk: bursts at ${v.entry!.burstAltKm!.toFixed(0)} km (observed ≈ 30 km)`);
  const m = demoVisual('mars-surface', world, SNAP)!, last = m.entry!.trace[m.entry!.trace.length - 1];
  ok(m.render.surfaceContact && m.render.crater && last[1] <= 0.5 && TL.buildTimeline(m).contactT !== null, `Mars: reaches the surface at ${last[2].toFixed(1)} km/s and makes a ${m.effects.crater!.finalKm.toFixed(2)} km crater`);
  const imp = { diameterM: 100, densityKgM3: 3000, speedKms: 20, angleDeg: 45, kind: 'stony' as const, strengthPa: strengthLaw(3000) };
  const vv = effects(BODIES.Venus, imp), mm = effects(BODIES.Mars, imp);
  const share = (f: typeof vv) => f.entry.atmosphereEnergyJ / f.entry.initialEnergyJ;
  ok(share(vv) > share(mm) && (vv.entry.breakupAltKm ?? 0) > (mm.entry.breakupAltKm ?? 0), `the same 100 m stone: Venus's air takes ${(share(vv) * 100).toFixed(0)}% of its energy, Mars's ${(share(mm) * 100).toFixed(0)}%; break-up ${vv.entry.breakupAltKm?.toFixed(0)} vs ${mm.entry.breakupAltKm?.toFixed(0)} km`);
  const venus = demoVisual('venus-airburst', world, SNAP)!;
  ok(venus.render.airburst && venus.render.cloudCutaway && !venus.render.crater, 'Venus 100 m: airburst, with the cloud cutaway aid');
}

section('giants: plume and scar, never a crater or ground');
for (const body of ['Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
  const r = lab({ body, diameterM: [500, 1000, 2000], composition: 'cometary' }).result;
  for (const k of ['low', 'nominal', 'high'] as const) {
    const v: VS = r.visual[k], st = ts(v, 300);
    ok(v.render.plume && v.render.deepDeposition && v.render.oneBarShell && !v.render.crater && !v.render.surfaceContact && !v.render.ejecta && !v.render.settlementOverlay && v.exposure.deaths === 0, `${body} ${k}: plume, deep deposition, 1-bar overlay; no crater, ground or casualties`);
    ok(st.every((s) => TL.transientScars(v, s).every((x) => x.kind === 2)), `${body} ${k}: only atmospheric scars`);
  }
}
{
  const v = demoVisual('sl9', world, SNAP)!;
  ok(v.render.scar && v.effects.plume!.plumeHeightKm[1] > 1500 && v.effects.plume!.plumeHeightKm[1] < 4500 && TL.buildTimeline(v).spans.map((s) => s.phase).join('>').includes('deep-deposition>plume'), `Shoemaker–Levy 9: entry → deep deposition → plume ${Math.round(v.effects.plume!.plumeHeightKm[1])} km → scar`);
}

section('deflection misses; deceleration makes no high-speed impact');
{
  const v = demoVisual('deflection', world, SNAP)!, st = ts(v, 600), R = v.body.radiusKm;
  const flags = v.render;
  ok(v.kind === 'deflection' && flags.ghostPath && flags.missPath && !flags.crater && !flags.airburst && !flags.blastRings && !flags.surfaceContact && !flags.plume && !flags.scar && v.exposure.deaths === 0, 'deflection: ghost path, a miss, no effects, no losses');
  ok(st.every((s) => Math.hypot(...s.obj.pos) >= R * 1.0), `deflection: the object never enters the body (closest ${Math.round(Math.min(...st.map((s) => Math.hypot(...s.obj.pos) - R)))} km above)`);
  ok(st.every((s) => TL.transientScars(v, s).length === 0 && s.flash === 0 && s.frontKm === 0), 'deflection: no scar, flash or spreading damage at any instant');
  let dec: VS | null = null;
  outer: for (const D of [0.5, 1, 2, 4]) for (const sp of [2.7, 3, 3.5]) for (const a of [20, 45]) {
    const x = singleVisual({ id: 'dec', body: BODIES.Titan, world: world.bodies.findIndex((b) => b.name === 'Titan'), imp: { diameterM: D, densityKgM3: 3000, speedKms: sp, angleDeg: a, kind: 'stony', strengthPa: 1e8 }, seed: 3, classification: 'hypothetical', source: { label: 't', note: '' }, when: { year: null, date: null, label: '' }, objectName: 't', snapshotId: SNAP });
    if (x.effects.outcome === 'decelerated') { dec = x; break outer; }
  }
  ok(!!dec, 'a decelerated case exists (Titan, slow stony body)');
  if (dec) {
    const st2 = ts(dec, 400);
    ok(!dec.render.surfaceContact && !dec.render.crater && st2.every((s) => s.flash === 0 && s.craterKm === 0), 'decelerated: no contact flash, no crater');
    ok(dec.render.survivingMass && st2.filter((s) => s.phase === 'aftermath').every((s) => s.obj.speedKms <= 0.3 + 1e-9), 'decelerated: surviving mass falls slowly');
  }
}

section('Earth geography stays statistical; settlement sites are the simulation\'s own');
{
  const r = lab({ body: 'Earth', diameterM: [100, 200, 400] }).result;
  for (const k of ['low', 'nominal', 'high'] as const) {
    const v: VS = r.visual[k];
    ok(v.banners.includes(TEXT.earthGeography) && v.banners.includes(TEXT.earthLocation) && v.exposure.mode === 'statistical-earth' && v.exposure.sites.length === 0 && !v.render.settlementOverlay && !!v.exposure.earth, `Earth ${k}: statistical exposure, synthetic location, no city association`);
    ok(v.exposure.earth!.land === !v.exposure.earth!.ocean && (!v.effects.crater || (v.effects.crater.material === 'water') === v.exposure.earth!.ocean), `Earth ${k}: land/ocean sample consistent across exposure and crater (${v.exposure.earth!.ocean ? 'ocean' : 'land'})`);
  }
  const oc = lab({ body: 'Earth', diameterM: [300, 400, 500], earthSurface: 'ocean' }).result, ld = lab({ body: 'Earth', diameterM: [300, 400, 500], earthSurface: 'land' }).result;
  ok((['low', 'nominal', 'high'] as const).every((k) => oc.visual[k].exposure.earth.ocean) && (['low', 'nominal', 'high'] as const).every((k) => !ld.visual[k].exposure.earth.ocean), 'Earth ocean / land: a statistical category the draw keeps');
  const mars = world.mars, st = e.st.S[mars * NF + F.stage];
  const mr = lab({ body: 'Mars', diameterM: [200, 300, 500], location: { mode: 'over', site: 0 } }).result;
  ok(st >= 0 && mr.visual.nominal.exposure.sites.length > 0, `Mars has simulated settlements in this future (${mr.visual.nominal.exposure.sites.length} sites)`);
  ok(mr.visual.nominal.exposure.sites.every((s: any) => { const c = views.cityDir(mars, s.i); return Math.abs(c.x - s.dir[0]) + Math.abs(c.y - s.dir[1]) + Math.abs(c.z - s.dir[2]) < 1e-12; }), 'Mars: every site sits exactly where the view draws that city (cityDir)');
  ok((['low', 'nominal', 'high'] as const).every((k) => same(mr.visual[k].trajectory.point, siteDir(mars, 0))), 'directly over a settlement: the point is that site\'s direction');
  const far = lab({ body: 'Mars', diameterM: [200, 300, 500], location: { mode: 'far' } }).result.visual.nominal;
  ok(far.exposure.sites.every((s: any) => s.deaths === 0) || far.exposure.sites.length === 0, 'far from settlements: no site loses anyone');
}

section('exact replay of simulated impacts');
{
  const R = e.impacts.rows.subarray(0, e.impacts.n * NIC);
  let checked = 0;
  for (let i = 0; i < e.impacts.n; i++) {
    const row = logRow(R, i), v = replayVisual(world, R, row.id, e.seed, SNAP)!;
    const again = replayVisual(world, R, row.id, e.seed, SNAP)!;
    const out = ['no-atmosphere', 'ground-impact', 'airburst', 'deep-deposition', 'decelerated'][row.outcome];
    const deflected = !!(row.flags & IF.deflected);
    ok(same(v, again), `#${row.id}: replaying twice gives the same scenario`);
    ok(same(v.trajectory.point, [row.px, row.py, row.pz]) && Object.is(v.trajectory.angleDeg, row.angleDeg) && Object.is(v.object.diameterM, row.diameterM), `#${row.id}: same point, angle and size as logged`);
    if (!deflected) {
      ok(v.effects.outcome === out && Object.is(v.effects.energyMt, row.energyMt) && Object.is(v.entry!.burstAltKm ?? NaN, row.burstAltKm) && Object.is(v.effects.crater ? v.effects.crater.finalKm : NaN, row.craterKm), `#${row.id} ${world.bodies[row.body].name}: same outcome (${out}), energy, burst and crater as the engine logged`);
      ok(Object.is(v.exposure.deaths, row.deaths) && Object.is(v.exposure.capitalLost, row.capitalLost), `#${row.id}: same losses as applied`);
      const sum = v.exposure.sites.reduce((a, s) => a + s.deaths, 0);
      ok(v.exposure.sites.length === 0 || Math.abs(sum - row.deaths) <= 1e-6 * Math.max(1, row.deaths) + (v.exposure.orbitalLossFraction ? row.deaths : 0), `#${row.id}: site losses add up to the logged toll`);
    }
    ok(v.defense!.detected === !!(row.flags & IF.detected) && v.defense!.deflected === deflected && Object.is(v.defense!.warningYears, row.warningYears), `#${row.id}: same warning and defence`);
    checked++;
  }
  ok(checked > 3, `${checked} logged impacts replayed exactly`);
  // a deflected row: the same draw, shown as a miss
  if (e.impacts.n) {
    const copy = R.slice(), o = 0;
    copy[o + IC.flags] = IF.detected | IF.deflected; copy[o + IC.deaths] = 0; copy[o + IC.capitalLost] = 0; copy[o + IC.warningYears] = 9;
    const v = replayVisual(world, copy, copy[o + IC.id], e.seed, SNAP)!;
    ok(v.kind === 'deflection' && !v.render.crater && !v.render.airburst && !v.render.blastRings && v.exposure.deaths === 0 && v.averted !== null, 'a deflected row replays as a miss with no aftermath');
  }
  const r = vizReq({ case: 'replay', impactId: logRow(R, 0).id });
  ok(!!r.visual && r.visual.classification === 'simulated', 'the worker replays a logged impact');
}

section('previews never change the simulation');
{
  const S0 = Float64Array.from(e.st.S), g0 = Float64Array.from(e.st.g), I0 = e.impacts.rows.slice(0, e.impacts.n * NIC), sc0 = e.st.scars.slice(), geo0 = e.st.geo.slice();
  lab({ body: 'Mars', diameterM: [500, 1000, 2000], location: { mode: 'over', site: 0 } });
  lab({ body: 'Earth', diameterM: [500, 1000, 2000] });
  vizReq({ case: 'replay', impactId: logRow(e.impacts.rows, 0).id });
  for (const c of DEMO_CASES) vizReq({ case: 'demo', key: c });
  const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (x: number, i: number) => Object.is(x, b[i]));
  ok(eq(S0, e.st.S) && eq(g0, e.st.g) && eq(I0, e.impacts.rows.slice(0, e.impacts.n * NIC)) && eq(sc0, e.st.scars) && eq(geo0, e.st.geo), 'population, capital, globals, impact log, scars and atmosphere are untouched');
}

section('the known cases (debug harness)');
const PHASES: Record<string, string> = {
  chelyabinsk: 'approach>entry>breakup>airburst>aftermath', barringer: 'approach>entry>contact>excavation>effects>aftermath',
  'moon-100m': 'approach>contact>excavation>effects>aftermath', 'venus-airburst': 'approach>entry>breakup>airburst>effects>aftermath',
  sl9: 'approach>entry>breakup>deep-deposition>plume>effects>aftermath', deflection: 'approach>deflection>miss',
};
for (const c of DEMO_CASES) {
  const v = demoVisual(c, world, SNAP)!, ph = TL.buildTimeline(v).spans.map((s) => s.phase).join('>');
  ok(!!v && (!PHASES[c] || ph === PHASES[c]), `${c}: ${ph}`);
  ok(!/NaN|undefined|Infinity/.test(JSON.stringify(v)), `${c}: no bad values in the scenario`);
}
{
  const b = historicalVisual('meteor-crater', world, SNAP)!;
  ok(b.effects.crater !== null && b.effects.crater.finalKm > 0.8 && b.effects.crater.finalKm < 1.5 && b.classification === 'historical', `Barringer: a ${b.effects.crater!.finalKm.toFixed(2)} km crater (observed 1.2 km)`);
  const ca = approachVisual(approaches('Earth')[0], world), ph = TL.buildTimeline(ca).spans.map((s) => s.phase).join('>');
  ok(ph === 'approach>closest-pass>departure', `a real close approach: ${ph}`);
}

section('scrubbing is deterministic');
for (const c of ['chelyabinsk', 'sl9', 'barringer'] as const) {
  const v = demoVisual(c, world, SNAP)!, tl = TL.buildTimeline(v), N = 300, times = Array.from({ length: N }, (_, i) => (tl.duration * i) / (N - 1));
  const fwd = times.map((t) => JSON.stringify(TL.sampleAt(v, tl, t, TL.emptyState())));
  const shared = TL.emptyState(), back = [...times].reverse().map((t) => JSON.stringify(TL.sampleAt(v, tl, t, shared))).reverse();
  const order = times.map((_, i) => (i * 7919) % N), rnd: string[] = []; for (const i of order) rnd[i] = JSON.stringify(TL.sampleAt(v, tl, times[i], shared));
  ok(fwd.every((x, i) => x === back[i] && x === rnd[i]), `${c}: forward, backward and shuffled scrubs land on the same states`);
}

section('reduced motion');
for (const c of DEMO_CASES) {
  const v = demoVisual(c, world, SNAP)!, phases = TL.buildTimeline(v).spans.map((s) => s.phase);
  ok(phases.every((p) => TL.autoCamera(v, p, true) !== 'follow') && TL.safeCamera('follow', true) === 'side', `${c}: no chase camera`);
  ok(ts(v, 100).every((s) => TL.shakeAmount(v, s, true, true) === 0 && TL.flashLimit(s.flash, true) <= 0.35), `${c}: no shake, flashes capped`);
}

// ---------------------------------------------------------------- the 3D layer on the real planet view
const r2 = new Engine(world, 9);
r2.logEvents = false;
while (r2.st.step < 700) r2.step();
const { NGEO } = await import('../src/sim/geo.ts');
const settled = Int32Array.from(r2.st.settled.slice(0, r2.st.nSettled));
const snap: any = { type: 'state', id: 0, step: 700, S: Float64Array.from(r2.st.S), techDone: Float64Array.from(r2.st.techDone), techWhere: Float64Array.from(r2.st.techWhere), ships: r2.shipList(), globals: r2.globals(), settled, geo: { seed: 9, rows: r2.st.geo.slice(0, (r2.geo.nSol + r2.st.nSettled) * NGEO), g: r2.st.geoG.slice(), scars: r2.st.scars.slice() } };
const camera = new THREE.PerspectiveCamera(55, 1.6, 0.01, 1e7);
const pv = new views.PlanetView(), scene = new THREE.Scene();
scene.add(pv.group);
const pctx: any = { world, snap, year: r2.years[700], camera, controls: { target: new THREE.Vector3(), update() {} }, system: 0, body: world.mars, city: 0, selected: null, t: 1, tm: 1, colorBy: 'stage' };
pv.enter(pctx); pv.sync(pctx); pv.frame(pctx);
const planetHost = (): any => ({ frame: pv.impactFrame(), setTransientScars: (x: any) => pv.setTransientScars(x), setCityShade: (x: any) => pv.setCityShade(x), setCutaway: (on: boolean) => pv.setCutaway(on), holdSpin: (on: boolean) => pv.holdSpin(on), get extraLabels() { return pv.extraLabels; }, set extraLabels(f) { pv.extraLabels = f; } });
const opts = { overlays: true, uncertainty: true, enhanced: false, cutaway: false, reduced: false, quality: 'high' as const, pixelRatio: 1, viewportH: 800 };
const mat = (pv as any).planet.material as import('three').ShaderMaterial;

section('rings on the rotating globe');
{
  const v: VS = lab({ body: 'Mars', diameterM: [500, 700, 900], location: { mode: 'near', site: 0 } }).result.visual.nominal;
  const L = new ImpactLayer(v, planetHost()), tl = TL.buildTimeline(v), s = TL.sampleAt(v, tl, tl.duration, TL.emptyState());
  camera.position.set(0, 0, 40); camera.lookAt(0, 0, 0);
  L.update(s, camera, opts);
  const gz = new THREE.Vector3(), p = v.trajectory.point;
  let attached = true;
  for (const tm of [1, 50, 400, 3000]) {
    pctx.tm = tm; pv.frame(pctx); scene.updateMatrixWorld(true);
    L.groundZero(gz);
    const want = new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(10).applyMatrix4(pv.impactFrame().matrixWorld);
    if (gz.distanceTo(want) > 1e-9) attached = false;
    // a ring vertex, as the ring shader places it, stays at its geodesic distance from ground zero
    const ring = (L as any).rings.find((r: any) => r.key === 'blast:kPa7') ?? (L as any).rings.find((r: any) => r.key === 'ej1m');
    if (ring) {
      const u = ring.mat.uniforms, a = u.uA1.value, phi = 1.234;
      const t = new THREE.Vector3().copy(u.uE.value).multiplyScalar(Math.cos(phi)).addScaledVector(u.uN.value, Math.sin(phi));
      const dV = new THREE.Vector3().copy(u.uC.value).multiplyScalar(Math.cos(a)).addScaledVector(t, Math.sin(a)).multiplyScalar(u.uR.value).applyMatrix4(ring.mesh.matrixWorld);
      const ang = dV.clone().normalize().angleTo(gz.clone().normalize());
      if (Math.abs(ang - a) > 1e-6 || !(ring.mesh.parent && ring.mesh.parent.parent === pv.impactFrame())) attached = false;
    }
  }
  ok(attached, 'ground zero and every ring stay on the same body-frame point as the globe turns');
  const kpa = (L as any).rings.find((r: any) => r.key === 'blast:kPa7');
  if (kpa) ok(Math.abs(kpa.mat.uniforms.uA1.value - geodesicAngle(v.effects.blastKm!.kPa7, v.body.radiusKm)) < 1e-12, `the 7 kPa ring's angle is its radius over the body radius (${v.effects.blastKm!.kPa7.toFixed(1)} km / ${v.body.radiusKm} km)`);
  const ej = (L as any).rings.find((r: any) => r.key === 'ej1m');
  ok(!!ej && Math.abs(ej.mat.uniforms.uA1.value - v.effects.ejecta1mKm! / v.body.radiusKm) < 1e-12, 'the ejecta ring too, at the scientific scale');
  pv.holdSpin(true);
  const before = pv.impactFrame().rotation.y; pctx.tm += 500; pv.frame(pctx);
  ok(pv.impactFrame().rotation.y === before, 'held (paused): the globe does not turn, ground zero does not drift');
  pv.holdSpin(false);
  // transient marks merge with the world's own scars and leave them as they were
  L.dispose();
  // two lasting scars as the geo state would hand them over (the merge must keep them, whatever the year shows)
  (pv as any).persistScars = [{ x: 1, y: 0, z: 0, rad: 0.05, kind: 0, amp: 0.8 }, { x: 0, y: 0, z: 1, rad: 0.02, kind: 1, amp: 0.5 }];
  pv.setTransientScars([]);
  const n0 = mat.uniforms.uScarN.value, first = (mat.uniforms.uScars.value as any[]).slice(0, n0).map((x) => x.toArray());
  pv.setTransientScars([{ x: 0, y: 1, z: 0, rad: 0.01, kind: 0, amp: 1 }]);
  ok(n0 === 2 && mat.uniforms.uScarN.value === 3, `a transient crater is drawn alongside the ${n0} lasting scars`);
  pv.setTransientScars([]);
  ok(mat.uniforms.uScarN.value === n0 && same((mat.uniforms.uScars.value as any[]).slice(0, n0).map((x) => x.toArray()), first), 'cleared: the lasting scars are exactly as before');
}

section('settlement lights follow the damage, and come back');
{
  const v: VS = lab({ body: 'Mars', diameterM: [2000, 3000, 4000], location: { mode: 'over', site: 0 } }).result.visual.nominal;
  const cities = () => (mat.uniforms.uCities.value as any[]).slice(0, mat.uniforms.uCityN.value).map((c) => c.w);
  const w0 = cities(), L = new ImpactLayer(v, planetHost()), tl = TL.buildTimeline(v);
  L.update(TL.sampleAt(v, tl, tl.duration, TL.emptyState()), camera, opts);
  const w1 = cities(), hit = v.exposure.sites.filter((s) => s.fatality > 0 || s.capitalShare > 0).length;
  ok(hit > 0 && w1.some((x, i) => x < w0[i]), `${hit} affected sites dim`);
  ok(w1.every((x, i) => (v.exposure.sites[i] && (v.exposure.sites[i].fatality > 0 || v.exposure.sites[i].capitalShare > 0)) || x === w0[i]), 'unaffected sites keep their light');
  L.dispose();
  ok(same(cities(), w0), 'exit: every light as the simulation has it');
}

section('the director: save, play, scrub, exit, restore; no leaks');
{
  class FakeControls { target = new THREE.Vector3(); enabled = true; minDistance = 0; maxDistance = Infinity; rotateSpeed = 0.5; update() { camera.lookAt(this.target); } }
  const controls = new FakeControls(), rig = new CameraRig(camera, controls as any);
  let level = 'system', body = world.earth, playing = true, yearNow = 12, reduced = false;
  const restored: any[] = [];
  const host: any = {
    rig, camera,
    save: () => ({ level, body, system: 0, selected: null, cam: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, playing, year: yearNow }),
    restore: (s: any) => { restored.push(s); level = s.level; body = s.body; yearNow = s.year; playing = s.playing; camera.position.copy(s.cam); controls.target.copy(s.target); },
    goToBody: (b: number) => { level = 'planet'; body = b; pctx.body = b; pv.sync(pctx); },
    planet: (b: number) => (level === 'planet' && body === b ? planetHost() : null),
    playing: () => playing, togglePlay: () => { playing = !playing; }, seekYear: (y: number) => { yearNow = y; },
    setLimits: (lo: number, hi: number) => rig.setLimits(lo, hi), reduced: () => reduced, pixelRatio: () => 1, viewportH: () => 800,
  };
  const d = new ImpactDirector(host);
  const run = (sec: number) => { for (let t = 0; t < sec; t += 1 / 30) { pv.frame(pctx); d.frame(1 / 30); rig.frame(1 / 30); d.afterRig(); } };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  camera.position.set(3, 4, 50); controls.target.set(0, 0, 0);
  const cam0 = camera.position.clone(), live0 = ImpactLayer.live;
  const mars = demoVisual('mars-surface', world, SNAP)!;
  d.start(mars); await flush();
  ok(!playing, 'starting pauses the timeline');
  run(0.2);
  ok(d.status === 'playing' && level === 'planet' && body === world.mars && d.layerOf !== null, 'travels to the planet and plays');
  run(3);
  ok(rig.flying || rig.following, 'the camera is directed through the rig');
  d.pause(); const t0 = d.t; run(1);
  ok(d.t === t0 && d.status === 'paused', 'paused: the clock holds');
  d.seek(d.duration * 0.6); run(0.05); const a = JSON.stringify(d.state);
  d.seek(d.duration * 0.1); run(0.05); d.seek(d.duration * 0.6); run(0.05);
  ok(JSON.stringify(d.state) === a, 'scrubbing back and forth through the director lands on the same state');
  d.userInput();
  ok(d.free, 'a drag or wheel hands the camera to the reader (free camera)');
  d.play(); run(2); d.directed();
  ok(!d.free, 'and "directed camera" takes it back');
  // a second visualization replaces the first, keeping the original saved view
  const live1 = ImpactLayer.live;
  d.start(demoVisual('chelyabinsk', world, SNAP)!); await flush(); run(0.3);
  ok(d.v!.id === 'hist:chelyabinsk-2013' && d.status === 'playing', 'a second start plays the new one');
  ok(ImpactLayer.live <= live1 + 20 && pv.impactFrame().children.filter((c) => c.name === 'impact-layer').length === 1, 'and cleans up the first (one layer on the globe)');
  d.skipToAftermath(); run(5);
  ok(d.status === 'complete', 'plays to completion');
  d.exit();
  ok(restored.length === 1 && restored[0].level === 'system' && restored[0].body === world.earth && restored[0].playing === true && restored[0].year === 12 && restored[0].cam.distanceTo(cam0) < 1e-12, 'exit restores the view, body, camera and timeline as before the first start');
  ok(ImpactLayer.live === live0 && !d.active && pv.extraLabels === null, 'nothing left behind: no GPU resources, no labels');
  // reduced motion: never the chase camera
  reduced = true; level = 'system';
  d.start(demoVisual('barringer', world, SNAP)!); await flush(); run(0.3);
  d.setCamera('follow'); run(0.1);
  ok((d as any).shot === 'side', 'reduced motion: "follow impactor" becomes the side-on view');
  d.setToggle('shake', true); run(0.5);
  ok((d as any).shakeOff.lengthSq() === 0, 'reduced motion: no shake even when asked');
  d.exit(); reduced = false;
  // repeated cycles
  const kinds: VS[] = [demoVisual('sl9', world, SNAP)!, demoVisual('moon-100m', world, SNAP)!, demoVisual('deflection', world, SNAP)!, approachVisual(approaches('Earth')[0], world), demoVisual('venus-airburst', world, SNAP)!];
  for (let i = 0; i < 20; i++) { level = 'system'; d.start(kinds[i % kinds.length]); await flush(); run(0.4); if (i % 3 === 0) { d.skipToAftermath(); run(0.5); } d.exit(); }
  ok(ImpactLayer.live === live0 && (ImpactLayer as any).ringGeo === null, `20 replay/exit cycles: every geometry and material released (${ImpactLayer.live - live0} left)`);
  ok(pv.impactFrame().children.every((c) => c.name !== 'impact-layer'), 'and nothing left on the globe');
}

console.log(`\n${n - bad}/${n} impact visualization checks passed`);
process.exit(bad ? 1 : 0);
