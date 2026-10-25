// Checks the Solar System impact pipeline (src/impact): official probabilities
// versus close approaches, body-class physics, crater scaling, the separation of
// catalogued and background events, spatial exposure, determinism, and the
// observed validation cases. Exit code 1 on any failure.
//   node scripts/impact-check.ts

import { SENTRY } from '../src/data/snapshot.ts';
import { BODIES, REQUIRED_BODIES } from '../src/impact/bodies.ts';
import { NO_OFFICIAL, OFFICIAL_NON_EARTH, approaches, officialFor, sentryRisks } from '../src/impact/catalog.ts';
import { crater } from '../src/impact/crater.ts';
import { effects } from '../src/impact/effects.ts';
import { entry, type Impactor } from '../src/impact/entry.ts';
import { belongsToCatalogue, catalogImpactors, IC, NIC } from '../src/impact/engineImpacts.ts';
import { siteExposure, sitesOf, siteDir } from '../src/impact/exposure.ts';
import { completeness2026, impactRate, CATALOG_HORIZON_YEAR } from '../src/impact/flux.ts';
import { OBSERVED_IMPACTS } from '../src/impact/history.ts';
import { runScenario } from '../src/impact/scenario.ts';
import { Engine } from '../src/sim/engine.ts';
import { buildWorld } from '../src/sim/world.ts';

let bad = 0, n = 0;
const ok = (cond: boolean, what: string) => { n++; if (!cond) { bad++; console.log(`FAIL ${what}`); } };
const section = (s: string) => console.log(`— ${s}`);
const stony = (D: number, v: number, angle = 45, strength?: number): Impactor => ({ diameterM: D, densityKgM3: 3000, speedKms: v, angleDeg: angle, kind: 'stony', strengthPa: strength });

section('profiles');
for (const b of REQUIRED_BODIES) ok(!!BODIES[b] && BODIES[b].version && BODIES[b].source.length > 0, `${b} has a versioned, sourced profile`);
ok(BODIES.Mars.atmosphere.rho0 !== BODIES.Earth.atmosphere.rho0 && BODIES.Venus.atmosphere.scaleHeightKm !== BODIES.Earth.atmosphere.scaleHeightKm, 'no body reuses Earth’s atmosphere');
ok(['Jupiter', 'Saturn', 'Uranus', 'Neptune'].every((b) => !BODIES[b].solidSurface && BODIES[b].atmosphere.p0Pa === 1e5), 'giants: no solid surface, altitude from the 1-bar level');
ok(BODIES.Mercury.atmosphere.kind === 'none' && BODIES.Moon.atmosphere.kind === 'none', 'Mercury and the Moon: exospheres only');

section('official probabilities versus close approaches');
ok(sentryRisks().length > 100 && sentryRisks().every((r) => r.body === 'Earth'), `Sentry probabilities are Earth-only (${sentryRisks().length} objects)`);
ok(!!SENTRY?.provenance.sources[0].version?.includes('"version":"2.'), 'Sentry signature version recorded');
for (const b of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Moon']) {
  const ca = approaches(b);
  const official = ca.map((a) => officialFor(b, a.des)).filter(Boolean);
  const allowed = OFFICIAL_NON_EARTH.filter((o) => o.body === b).map((o) => o.des);
  ok(official.every((o) => allowed.includes(o!.des)), `${b}: no probability invented for ${ca.length} close approaches (only named published assessments)`);
  ok(ca.every((a) => !('ip' in a) && a.distMinKm <= a.distKm && a.distKm <= a.distMaxKm), `${b}: approaches carry distances with 3-sigma bounds, never a probability field`);
}
ok(OFFICIAL_NON_EARTH.every((o) => o.status === 'superseded' || o.source.url.startsWith('https://')), 'published non-Earth assessments carry their source and status');
ok(OFFICIAL_NON_EARTH.find((o) => o.des === '2024 YR4')!.status === 'superseded', '2024 YR4 lunar probability is shown as superseded (ruled out in 2026)');
ok(NO_OFFICIAL.includes('not an impact prediction'), 'the no-probability notice says what a close approach is');

section('body-class physics');
for (const b of ['Mercury', 'Moon']) {
  const r = runScenario({ body: b, classification: 'hypothetical', diameterM: [20, 50, 200] }, 3, 40);
  ok(Math.abs((r.outcomes['no-atmosphere'] ?? 0) - 1) < 1e-9 && !r.burstAltKm, `${b}: no airburst, every draw strikes the surface`);
  ok(effects(BODIES[b], stony(100, 20)).blastKm === null, `${b}: no blast wave`);
}
{
  const imp = stony(60, 15, 45);
  const v = entry(BODIES.Venus, imp), m = entry(BODIES.Mars, imp);
  ok(v.atmosphereEnergyJ / v.initialEnergyJ > m.atmosphereEnergyJ / m.initialEnergyJ, `Venus takes more of the energy than Mars (${(v.atmosphereEnergyJ / v.initialEnergyJ).toFixed(2)} vs ${(m.atmosphereEnergyJ / m.initialEnergyJ).toFixed(2)})`);
  ok(v.outcome === 'airburst' && m.outcome === 'ground-impact', 'the same 60 m body bursts over Venus and strikes Mars');
}
for (const b of ['Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
  const fx = effects(BODIES[b], { diameterM: 1000, densityKgM3: 500, speedKms: Math.hypot(BODIES[b].vInf.median, BODIES[b].escapeKms), angleDeg: 45, kind: 'cometary' });
  ok(fx.crater === null && fx.damageAt(0).fatality === 0 && fx.maxRadiusKm === 0 && !!fx.plume, `${b}: no surface crater or ground casualties; a plume instead`);
}
{
  const vImp = (b: string, vinf: number) => Math.hypot(vinf, BODIES[b].escapeKms);
  ok(vImp('Jupiter', 3) > 59.5 && vImp('Earth', 17) > vImp('Moon', 17) && vImp('Earth', 25) > vImp('Earth', 15), 'impact speed rises with the target’s gravity and the encounter speed');
  ok(impactRate('Earth', 100).perYear / (Math.PI * 6371 ** 2) > impactRate('Moon', 100).perYear / (Math.PI * 1737 ** 2), 'gravitational focusing: Earth gets more impacts per area than the Moon');
}

section('craters');
{
  const base = { diameterM: 100, impactorDensity: 3000, speedKms: 18, angleDeg: 45, material: 'dry-soil' as const, transition: 'silicate' as const };
  ok(crater({ ...base, gravity: 1.62 }).finalM > crater({ ...base, gravity: 9.81 }).finalM, 'lower gravity, bigger crater');
  ok(crater({ ...base, gravity: 3.71, material: 'sand' }).finalM !== crater({ ...base, gravity: 3.71, material: 'hard-rock' }).finalM, 'target material changes the crater');
  ok(crater({ ...base, diameterM: 3000, gravity: 9.81 }).morphology === 'complex' && crater({ ...base, gravity: 1.62 }).morphology === 'simple', 'simple-to-complex transition depends on size and gravity');
}

section('validation against observed impacts');
for (const o of OBSERVED_IMPACTS.filter((x) => x.check)) {
  const b = BODIES[o.body];
  const imp: Impactor = { diameterM: o.diameterM[1], densityKgM3: o.densityKgM3 ?? 3000, speedKms: o.speedKms ?? Math.hypot(b.vInf.median, b.escapeKms), angleDeg: o.angleDeg ?? 45, kind: (o.densityKgM3 ?? 3000) < 1000 ? 'cometary' : (o.densityKgM3 ?? 0) > 6000 ? 'iron' : 'stony', strengthPa: o.id === 'mars-2021' ? 5e6 : o.id === 'meteor-crater' ? 2e8 : undefined }; // strong bodies: the Mars 2021 crater needs > 2 MPa; a monolithic iron is 0.1–0.5 GPa
  const fx = effects(b, imp, { material: o.id === 'meteor-crater' ? 'soft-rock' : o.id === 'moon-2013' ? 'sand' : undefined });
  const c = o.check!;
  if (c.burstAltKm) ok(fx.entry.burstAltKm !== null && fx.entry.burstAltKm >= c.burstAltKm[0] && fx.entry.burstAltKm <= c.burstAltKm[1], `${o.name}: burst at ${fx.entry.burstAltKm?.toFixed(1)} km (expected ${c.burstAltKm.join('–')})`);
  if (c.craterM) ok(!!fx.crater && fx.crater.finalM >= c.craterM[0] && fx.crater.finalM <= c.craterM[1], `${o.name}: crater ${fx.crater?.finalM.toFixed(0)} m (observed range ${c.craterM.join('–')})`);
  if (c.depositionAltKm) ok(fx.crater === null && fx.entry.burstAltKm !== null && fx.entry.burstAltKm >= c.depositionAltKm[0] && fx.entry.burstAltKm <= c.depositionAltKm[1], `${o.name}: energy deposited at ${fx.entry.burstAltKm} km relative to 1 bar, no crater`);
  console.log(`  ${o.name}: ${fx.entry.outcome}${fx.entry.burstAltKm !== null ? `, burst ${fx.entry.burstAltKm.toFixed(1)} km` : ''}${fx.crater ? `, crater ${fx.crater.finalM.toFixed(0)} m` : ''}, ${fx.energyMt.toPrecision(3)} Mt`);
}

section('catalogued and background events');
{
  const D = 1000, N = 20000;
  let excluded = 0, after = 0;
  for (let i = 0; i < N; i++) { const u = (i + 0.5) / N; if (belongsToCatalogue(D, 2050, u)) excluded++; if (belongsToCatalogue(D, CATALOG_HORIZON_YEAR + 1, u)) after++; }
  ok(Math.abs(excluded / N - completeness2026(D)) < 1e-3, `before the horizon the background drops the catalogued share (${(excluded / N).toFixed(3)} of 1 km impactors)`);
  ok(after === 0, 'after the horizon the background keeps every size');
  const cat = catalogImpactors(2040);
  ok(cat.length > 0 && new Set(cat.map((c) => c.index)).size === cat.length, `each Sentry virtual impactor is a separate, single roll (${cat.length} inside the run)`);
  ok(cat.every((c) => c.year >= 2040 && c.ip > 0 && c.ip <= 1), 'only virtual impactors inside the simulation, each with its official probability');
}

section('spatial exposure');
{
  const sites = sitesOf(4, 5, 2e6, 2e12, BODIES.Mars.radiusKm);
  const fx = effects(BODIES.Mars, stony(200, 12, 60, 1e7), { material: 'dry-soil' });
  const at = siteExposure(fx, sites, siteDir(4, 0), BODIES.Mars.radiusKm);
  const far = siteExposure(fx, sites, [-siteDir(4, 0)[0], -siteDir(4, 0)[1], -siteDir(4, 0)[2]], BODIES.Mars.radiusKm);
  ok(at.deaths > 0 && at.capitalLost > 0, `an impact on the capital kills (${at.deaths.toFixed(0)}) and destroys property`);
  ok(far.deaths < at.deaths * 1e-3, 'the same impact on the far side harms almost no one: damage is spatial, not a planet-wide percentage');
}

section('determinism');
{
  const spec = { body: 'Earth', classification: 'hypothetical' as const, diameterM: [80, 140, 250] as [number, number, number], earth: { pop: 9e9, capital: 5e14 } };
  const a = JSON.stringify(runScenario(spec, 11, 60).deaths), b = JSON.stringify(runScenario(spec, 11, 60).deaths), c = JSON.stringify(runScenario(spec, 12, 60).deaths);
  ok(a === b, 'consequence Monte Carlo: same seed, same result');
  ok(a !== c, 'a different seed draws differently');
  const w = buildWorld(), e1 = new Engine(w, 9), e2 = new Engine(w, 9);
  while (e1.st.step < 700) { e1.step(); e2.step(); }
  const r1 = e1.impacts.rows.subarray(0, e1.impacts.n * NIC), r2 = e2.impacts.rows.subarray(0, e2.impacts.n * NIC);
  ok(r1.length === r2.length && r1.every((x, i) => Object.is(x, r2[i])), `same seed, same impact record (${e1.impacts.n} impacts by ${2040 + e1.years[e1.st.step]})`);
  const bodies = new Set(Array.from({ length: e1.impacts.n }, (_, i) => r1[i * NIC + IC.body]));
  console.log(`  seed 9 to ${2040 + e1.years[e1.st.step]}: ${e1.impacts.n} recorded impacts on ${bodies.size} worlds`);
}

console.log(`\n${n - bad}/${n} impact checks passed`);
process.exit(bad ? 1 : 0);
