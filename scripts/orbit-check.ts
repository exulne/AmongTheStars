// Checks the atmosphere, drag, lifecycle and SGP4 display models (src/orbit)
// and the mission registry (src/data/registry). Exit code 1 on any failure.
//   node scripts/orbit-check.ts

import { readFileSync } from 'node:fs';
import { propagate } from 'satellite.js';
import { GP } from '../src/data/gpSnapshot.ts';
import { MISSIONS, mergeMissions, isFlown, withRole, type Mission } from '../src/data/registry/missions.ts';
import { FACILITIES } from '../src/data/registry/facilities.ts';
import { CLASSIFICATIONS } from '../src/data/provenance.ts';
import { SATCAT, SPACE_WEATHER, SNAPSHOT_CHECKS } from '../src/data/snapshot.ts';
import { CLASSES } from '../src/orbit/classes.ts';
import { ballistic, dragDadt, meanDensity, naturalLifetimeDays, simulateLife, smaOf, type Craft } from '../src/orbit/decay.ts';
import { ballisticRange, lifetimeRange, starlink2022 } from '../src/orbit/lifetime.ts';
import { SHELLS, fleetStep, stormLossShare } from '../src/orbit/shells.ts';
import { positionKm, satrecOf } from '../src/orbit/sgp4.ts';
import { SolarActivity, constantWeather, dayOfYear, observedWeather } from '../src/orbit/spaceWeather.ts';
import { THERMO_FIT } from '../src/orbit/thermosphereFit.ts';
import { density, ussa76 } from '../src/orbit/thermosphere.ts';
import { Engine } from '../src/sim/engine.ts';
import { GM, NGM } from '../src/sim/metrics.ts';
import { buildWorld } from '../src/sim/world.ts';

let bad = 0, n = 0;
const ok = (cond: boolean, what: string) => { n++; if (!cond) { bad++; console.log(`FAIL ${what}`); } };
const section = (s: string) => console.log(`— ${s}`);

const stats = SPACE_WEATHER!.stats;
const QUIET = constantWeather({ f107: 70, f107a: 70, ap: 4 });
const NOMINAL = constantWeather({ f107: 150, f107a: 150, ap: 10 });
const STORM = constantWeather({ f107: 200, f107a: 190, ap: 100 });
const D0 = dayOfYear(2040);
const craft = (mass: number, area: number, cd = 2.2, extra: Partial<Craft> = {}): Craft => ({ dryMassKg: mass, propellantKg: 0, areaM2: area, lowDragFactor: 1, cd, thrustN: 0, ispS: 1, dutyCycle: 0, ...extra });
const life = (c: Craft, alt: number, w = NOMINAL, model: 'msis-calibrated' | 'none' = 'msis-calibrated', scale?: number) =>
  simulateLife({ craft: c, incDeg: 53, insertAltKm: alt, targetAltKm: alt, designLifeYears: 0, startDay: D0, weather: w, atmosphere: model, maxYears: 400, densityScale: scale ? () => scale : undefined }).reentryDay;

section('snapshot');
for (const c of SNAPSHOT_CHECKS) ok(c.ok, `snapshot file ${c.file}: ${c.message}`);
{
  const m = JSON.parse(readFileSync('src/data/snapshots/manifest.json', 'utf8')) as { files: Record<string, { sha256: string }> };
  const { createHash } = await import('node:crypto');
  for (const [f, e] of Object.entries(m.files)) ok(createHash('sha256').update(readFileSync(`src/data/snapshots/${f}`, 'utf8')).digest('hex') === e.sha256, `${f} matches its manifest hash`);
}

section('thermosphere');
ok(THERMO_FIT.holdout.n >= 20 && THERMO_FIT.holdout.rmsLog10 < 0.12, `calibrated against NRLMSIS 2.0: held-out rms ${THERMO_FIT.holdout.rmsLog10} dex over ${THERMO_FIT.holdout.n} rows`);
ok(THERMO_FIT.ussa76.filter((u) => u.altKm <= 700).every((u) => u.ratio > 0.7 && u.ratio < 1.4), 'within 30% of USSA76 at moderate activity up to 700 km');
ok(density({ altKm: 400, f107: 200, f107a: 200, ap: 15 }) > density({ altKm: 400, f107: 70, f107a: 70, ap: 15 }) * 3, 'solar maximum thickens the thermosphere at 400 km several-fold');
ok(density({ altKm: 400, f107: 150, f107a: 150, ap: 150 }) > density({ altKm: 400, f107: 150, f107a: 150, ap: 4 }), 'geomagnetic activity raises density');
ok(density({ altKm: 400, f107: 150, f107a: 150, ap: 4, lstH: 14 }) > density({ altKm: 400, f107: 150, f107a: 150, ap: 4, lstH: 3 }), 'day side denser than night side');
ok(Math.abs(Math.log(density({ altKm: 50, f107: 150, f107a: 150, ap: 4 }) / ussa76(50))) < 1e-9, 'below 100 km the model is USSA76');

section('drag physics');
const a400 = smaOf(400);
ok(dragDadt(a400, meanDensity(400, 53, { f107: 150, f107a: 150, ap: 10 }, 'none'), 50, 53) === 0, 'zero atmosphere: zero aerodynamic drag');
ok(life(craft(100, 1), 300, NOMINAL, 'none') === Infinity, 'zero atmosphere: nothing decays');
ok(life(craft(100, 1), 400, NOMINAL, 'msis-calibrated', 2) < life(craft(100, 1), 400), 'doubling density shortens the life');
ok(life(craft(100, 2), 400) < life(craft(100, 1), 400), 'larger area-to-mass ratio decays faster');
ok(life(craft(100, 1, 2.6), 400) < life(craft(100, 1, 2.0), 400), 'larger drag coefficient decays faster');
ok(life(craft(100, 1), 400, STORM) < life(craft(100, 1), 400, QUIET), 'storm conditions decay faster than quiet');
ok(life(craft(100, 1), 600) > life(craft(100, 1), 400), 'higher LEO survives longer under the same conditions');
ok(ballistic(craft(100, 1, 2)) === 50, 'ballistic coefficient B = m / (C_D A)');
{
  const sa = new SolarActivity(stats, 1), w = sa.weather('nominal');
  const y400 = naturalLifetimeDays(400, 53, 50, w, D0) / 365.25, y800 = naturalLifetimeDays(800, 53, 50, w, D0) / 365.25;
  ok(y400 < 5, `NASA broad check: ~400 km decays within years (B = 50: ${y400.toFixed(2)} yr)`);
  ok(y800 > 50, `NASA broad check: ~800 km persists for decades to centuries (B = 50: ${y800.toFixed(0)} yr)`);
  console.log(`  natural lifetime, B = 50 kg/m², seeded nominal Sun: 400 km ${y400.toFixed(2)} yr, 800 km ${y800.toFixed(0)} yr`);
}

section('propulsion and lifecycle');
{
  const c = craft(800, 30, 2.2, { propellantKg: 15, thrustN: 0.17, ispS: 2500, dutyCycle: 0.5, lowDragFactor: 0.2 });
  const powered = simulateLife({ craft: c, incDeg: 53, insertAltKm: 350, targetAltKm: 350, designLifeYears: 100, startDay: D0, weather: STORM, maxYears: 60, traceEvery: 20 });
  const unpowered = life({ ...c, thrustN: 0, propellantKg: 0 }, 350, STORM);
  const fuelOut = powered.phaseLog.find((p) => p.phase === 'decaying' || p.phase === 'degraded' || p.phase === 'disposal');
  const heldAlt = powered.trace.filter((t) => t.propKg > 0.5).every((t) => t.altKm > 345);
  ok(heldAlt, 'stationkeeping holds altitude while propellant lasts');
  ok(!!fuelOut && powered.reentryDay > unpowered && powered.reentryDay < Infinity, `propulsion delays reentry until the fuel is gone (powered ${(powered.reentryDay / 365.25).toFixed(2)} yr vs unpowered ${(unpowered / 365.25).toFixed(2)} yr)`);
  ok(powered.propellantUsedKg > 14, 'the propellant is spent');
  const phases = powered.phaseLog.map((p) => p.phase);
  ok(phases[0] === 'deployed' && phases.includes('operational') && phases.at(-1) === 'reentered', `lifecycle runs deployment → operations → reentry (${phases.join(' → ')})`);
  const raise = simulateLife({ craft: { ...c, propellantKg: 30 }, incDeg: 53, insertAltKm: 300, targetAltKm: 550, commissioningDays: 3, designLifeYears: 5, startDay: D0, weather: QUIET, maxYears: 1 });
  ok(raise.reachedTarget && raise.phaseLog.some((p) => p.phase === 'commissioning') && raise.phaseLog.some((p) => p.phase === 'raising'), 'commissioning and orbit raising reach the operational shell');
}

section('uncertainty ranges');
{
  const q = { cls: 'generic-leo', altKm: 450, incDeg: 53, startDay: D0, weather: NOMINAL, seed: 7, n: 16, powered: false };
  const r = lifetimeRange(q).reentryYears;
  ok(r.p10 < r.p50 && r.p50 < r.p90, `unknown spacecraft properties give a range, not one value (${r.p10.toFixed(2)}–${r.p90.toFixed(2)} yr)`);
  const b = ballisticRange(CLASSES['generic-leo']);
  ok(b.low < b.nominal && b.nominal < b.high, 'ballistic coefficient is a low–nominal–high range');
  ok(JSON.stringify(lifetimeRange(q).reentryYears) === JSON.stringify(r), 'same seed, same lifetime range');
}

section('Starlink, February 2022');
{
  const obs = observedWeather(stats);
  const storm = starlink2022(obs, { enhancement: 'fang-high' }), model = starlink2022(obs), quiet = starlink2022(obs, { quiet: true }), high = starlink2022(obs, { perigeeKm: 300, apogeeKm: 400, enhancement: 'fang-high' });
  console.log(`  lost: observed 78%; model ${(model.lostFraction * 100).toFixed(0)}%, with Fang et al. high-end enhancement ${(storm.lostFraction * 100).toFixed(0)}%, quiet ${(quiet.lostFraction * 100).toFixed(0)}%, 300 km perigee ${(high.lostFraction * 100).toFixed(0)}%`);
  ok(storm.lostFraction >= 0.4, 'low insertion + storm-enhanced density: major loss');
  ok(quiet.lostFraction <= 0.1, 'same launch in quiet conditions: little or no loss');
  ok(model.lostFraction > quiet.lostFraction, 'the observed storm alone already raises the loss');
  ok(high.lostFraction < storm.lostFraction, 'a higher insertion survives the same storm better');
}

section('SGP4 display propagation');
{
  const src = readFileSync('src/orbit/sgp4.ts', 'utf8');
  ok(!/from '\.\/(decay|thermosphere|lifetime|shells)/.test(src), 'sgp4.ts imports no drag or atmosphere model (no double-counted drag)');
  const rows = GP?.rows ?? [];
  ok(rows.length > 1000, `GP snapshot holds thousands of objects (${rows.length})`);
  const iss = rows.find((r) => r[0] === 25544);
  if (iss) {
    const rec = satrecOf(iss)!, at = new Date(iss[3] * 1000 + 3600e3);
    const ours = positionKm(rec, at), lib = propagate(satrecOf(iss)!, at)!.position as { x: number; y: number; z: number };
    ok(!!ours && ours[0] === lib.x && ours[1] === lib.y && ours[2] === lib.z, 'display positions are exactly satellite.js SGP4 output');
    const alt = Math.hypot(...ours!) - 6378.137;
    ok(alt > 350 && alt < 450, `ISS altitude at epoch + 1 h is plausible (${alt.toFixed(0)} km)`);
  } else ok(false, 'ISS (25544) present in the GP snapshot');
}

section('mission registry');
{
  const tess = MISSIONS.find((m) => m.id === 'tess')!;
  ok(tess.launchProvider === 'spacex' && tess.payloads.every((p) => p.owner === 'nasa') && withRole(tess, 'launch-services-manager').includes('nasa'), 'TESS: NASA owns the payload and manages the launch service; SpaceX provides the launch');
  const kf = MISSIONS.find((m) => m.id === 'kuiper-kf01')!;
  ok(kf.launchProvider === 'spacex' && kf.payloads.every((p) => p.owner === 'amazon'), 'a payload launched by SpaceX does not belong to SpaceX (Amazon on Falcon 9)');
  ok(!MISSIONS.some((m) => m.payloads.some((p) => p.owner === 'blueOrigin' && /kuiper|amazon|leo/i.test(p.name))), 'Amazon Leo satellites are never Blue Origin satellites');
  ok(MISSIONS.filter((m) => m.payloads.some((p) => p.owner === 'blueOrigin')).every((m) => /new shepard|blue ring|blue moon|capsule|pathfinder/i.test(m.name + m.payloads.map((p) => p.name).join())), 'Blue Origin-owned payloads are its own vehicles and demonstrators only');
  ok(MISSIONS.every((m) => m.orgs.length > 0 && m.orgs.every((o) => o.roles.length > 0)), 'every organisation on a mission has an explicit role');
  for (const m of MISSIONS) if (!['historical', 'active'].includes(m.status)) ok(!m.launched && m.outcome === 'pending' && !isFlown(m), `${m.name}: a ${m.status} plan is not shown as flown`);
  ok(MISSIONS.every((m) => CLASSIFICATIONS.includes(m.status)), 'every mission has one classification');
  ok(MISSIONS.every((m) => m.sources.length > 0 && m.sources.every((s) => /^https?:\/\//.test(s.url) && !Number.isNaN(Date.parse(s.retrieved)))), 'every mission keeps sources with URLs and retrieval timestamps');
  ok(MISSIONS.every((m) => !m.contract || (/nasa\.gov/.test(m.contract.source.url) && m.contract.scope.length > 10)), 'every contract value is NASA-published, with its scope');
  ok(!MISSIONS.find((m) => m.id === 'dart')!.contract, 'no unsourced cost: DART has no contract value');
  ok(MISSIONS.every((m) => !('price' in m) && !('cost' in m)), 'no mission carries a bare "price" or "cost" field');
  // duplicates merge on designators and dates, never on names alone
  const dup: Mission = { ...tess, name: 'Transiting Exoplanet Survey Satellite (second source)', confidence: 'medium', sources: [{ organization: 'Second catalogue', url: 'https://example.org/tess', retrieved: '2026-10-25T00:00:00Z', basis: 'reported', quality: 'medium' }] };
  const sameName: Mission = { ...MISSIONS.find((m) => m.id === 'psyche')!, id: 'psyche-x', cospar: '2099-001A', launched: '2099-01-01T00:00:00Z', payloads: [{ name: 'x', owner: 'nasa', cospar: '2099-001A' }] };
  const merged = mergeMissions([...MISSIONS, dup, sameName]);
  ok(merged.length === MISSIONS.length + 1, 'a second record of TESS merges; a record that only shares a name does not');
  const mt = merged.find((m) => m.id === 'tess')!;
  ok(mt.sources.length === tess.sources.length + 1 && mt.name === tess.name, 'the merged record keeps every source and the higher-confidence fields');
  // SATCAT cross-check of flown designators and dates
  let checked = 0, mismatch: string[] = [];
  for (const m of MISSIONS) {
    if (!m.cospar || !m.launched || !SATCAT) continue;
    const recs = SATCAT.records[m.cospar.slice(0, 8)] ?? [];
    const hit = recs.find((r) => r.objectId.startsWith(m.cospar!));
    if (!hit) { mismatch.push(`${m.id}: not in SATCAT`); continue; }
    checked++;
    if (hit.launch !== m.launched.slice(0, 10)) mismatch.push(`${m.id}: ${hit.launch} vs ${m.launched.slice(0, 10)}`);
  }
  ok(mismatch.length === 0, `flown designators and launch dates match CelesTrak SATCAT (${checked} checked${mismatch.length ? `; ${mismatch.join('; ')}` : ''})`);
  ok(FACILITIES.every((f) => f.events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.source)), 'facility dates are sourced and exact (unknown dates are left out)');
  ok(FACILITIES.every((f) => (f.lat === null) === (f.operational === 'mobile')), 'only mobile assets lack coordinates');
}

section('determinism and the fleet');
{
  const a = new SolarActivity(stats, 42), b = new SolarActivity(stats, 42), c = new SolarActivity(stats, 43);
  const seq = (s: SolarActivity) => Array.from({ length: 400 }, (_, k) => s.day(D0 + k * 9.3).ap + s.f107a(2040 + k * 3)).join();
  ok(seq(a) === seq(b) && seq(a) !== seq(c), 'the seeded Sun is a pure function of the seed');
  const w = buildWorld(), e1 = new Engine(w, 5), e2 = new Engine(w, 5);
  for (let k = 0; k < 120; k++) { e1.step(); e2.step(); }
  const cols = ['orbitSats', 'orbitSpend', 'orbitStormLoss', 'solarF107', 'stormDays'];
  ok(cols.every((k) => { for (let s = 0; s <= e1.st.step; s++) if (!Object.is(e1.series[s * NGM + GM[k]], e2.series[s * NGM + GM[k]])) return false; return true; }), 'same seed, same fleet and space-weather series');
  // stepWeather only asks the Sun for days: a constant Sun is enough to compare conditions
  const quietFleet = fleetStep({ day: () => ({ f107: 70, f107a: 70, ap: 4 }) } as unknown as SolarActivity, 2045, 1, 1, 200, false);
  const stormFleet = fleetStep({ day: () => ({ f107: 220, f107a: 210, ap: 120 }) } as unknown as SolarActivity, 2045, 1, 1, 200, false);
  ok(stormFleet.spendPerYear > quietFleet.spendPerYear && stormFleet.propellantTPerYear > quietFleet.propellantTPerYear, `an active Sun costs the fleet more (${(stormFleet.spendPerYear / 1e9).toFixed(1)} vs ${(quietFleet.spendPerYear / 1e9).toFixed(1)} $B/yr) and burns more propellant`);
  // the storm-loss table: a v1-class shell inserted at 210 km loses satellites to a storm, none in quiet conditions (v2 mini at 280 km rides it out)
  const low = { ...SHELLS[1], id: 'test-low', cls: 'starlink-v1.5', insertPerigeeKm: 210 };
  ok(stormLossShare(low, 100, 150) > 0 && stormLossShare(low, 0, 150) === 0, `storms take satellites that are still raising from a low insertion (${(stormLossShare(low, 100, 150) * 100).toFixed(0)}% at Ap 100)`);
}

console.log(`\n${n - bad}/${n} orbit and mission checks passed`);
process.exit(bad ? 1 : 0);
