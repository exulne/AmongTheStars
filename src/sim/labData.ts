// The worker's half of the Orbits desk and the Impact Lab: SGP4 positions of
// observed objects at a chosen time, one object's detail (orbit, element age,
// drag regime, decay and lifetime ranges under each atmosphere mode, linked
// mission), the observed shells, the simulated fleet at a year, the Starlink
// 2022 validation, the impact record, and impact scenarios run against the
// settlements standing at a year. Expensive work runs here, not on the page.

import { GP } from '../data/gpSnapshot.ts';
import { GP_FIELDS, type GpRow } from '../data/adapters.ts';
import { MISSIONS } from '../data/registry/missions.ts';
import { SNAPSHOT_ID, SPACE_WEATHER } from '../data/snapshotCore.ts';
import { CLASSES, classOf } from '../orbit/classes.ts';
import { DRAG_CEILING_KM, meanDensity } from '../orbit/decay.ts';
import { ballisticRange, dragRegime, lifetimeRange, starlink2022, type Spread } from '../orbit/lifetime.ts';
import { altitudeTrade, fleetStep, SHELLS } from '../orbit/shells.ts';
import { ageLevel, orbitOf, positionKm, satrecOf, EARTH_RADIUS_KM, type AgeLevel } from '../orbit/sgp4.ts';
import { constantWeather, dayOf, observedWeather, type AtmoMode, type SW } from '../orbit/spaceWeather.ts';
import { IC, NIC } from '../impact/engineImpacts.ts';
import { sitesOf } from '../impact/exposure.ts';
import { type Composition, type ScenarioResult } from '../impact/scenario.ts';
import { demoVisual, historicalVisual, pointFor, replayVisual, runLab, type DemoCase, type LocationReq } from '../impact/vizBuild.ts';
import type { VisualScenario } from '../impact/visual.ts';
import { BODIES } from '../impact/bodies.ts';
import { isAlive } from './catalog.ts';
import type { Engine } from './engine.ts';
import { F, GM, NF, NGM } from './metrics.ts';
import type { World } from './world.ts';
import type { SatRec } from 'satellite.js';

export type LabReq =
  | { type: 'orbits'; id: number; tMs: number; colorBy: 'operator' | 'altitude' | 'age' }
  | { type: 'satSearch'; id: number; q: string; limit?: number }
  | { type: 'satInfo'; id: number; norad: number; tMs: number }
  | { type: 'orbitSummary'; id: number }
  | { type: 'fleet'; id: number; year: number }
  | { type: 'impacts'; id: number; year: number }
  | { type: 'impactLab'; id: number; body: string; diameterM: [number, number, number]; composition: Composition | 'unknown'; vInfKms?: number; year: number; seed: number; n?: number; label?: string; location?: LocationReq; earthSurface?: 'ocean' | 'land'; banner?: string; objectName?: string }
  /** a visual scenario: an observed case, an exact replay of a logged impact, or a fixed test case */
  | { type: 'impactViz'; id: number; case: 'historical'; key: string }
  | { type: 'impactViz'; id: number; case: 'replay'; impactId: number }
  | { type: 'impactViz'; id: number; case: 'demo'; key: DemoCase };

export interface SatInfo {
  norad: number; name: string; objectId: string; epochIso: string; ageDays: number; age: AgeLevel;
  orbit: ReturnType<typeof orbitOf>; operator: string; operatorBasis: string; cls: string; clsLabel: string; clsBasis: string;
  ballistic: { low: number; nominal: number; high: number };
  massKg: [number, number, number]; areaM2: [number, number, number]; cd: [number, number, number];
  rhoNow: number | null; rhoByMode: Record<AtmoMode, number>; regime: string;
  /** natural decay from the current perigee (years), low/nominal/high spread per mode; null above the drag ceiling */
  decay: Record<AtmoMode, Spread> | null;
  /** powered life and stationkeeping demand per mode, if the class has propulsion */
  powered: Record<AtmoMode, { life: Spread; dv: Spread; prop: Spread }> | null;
  replacementUsd: [number, number, number];
  mission: { id: string; name: string; status: string } | null;
  snapshotId: string; weatherNote: string;
}

export type LabRes =
  | { type: 'orbits'; id: number; tMs: number; snapshotId: string; count: number; positions: Float32Array; colors: Float32Array; age: Uint8Array; norads: Int32Array; epochMinMs: number; epochMaxMs: number; legend: [string, string][] }
  | { type: 'satSearch'; id: number; hits: { norad: number; name: string; objectId: string; altKm: number }[] }
  | { type: 'satInfo'; id: number; info: SatInfo | null }
  | { type: 'orbitSummary'; id: number; summary: OrbitSummary }
  | { type: 'fleet'; id: number; fleet: ReturnType<typeof fleetStep> | null; trade: Record<AtmoMode, ReturnType<typeof altitudeTrade>>; leoCostPerKg: number; cycle: { n: number; ssn: number; f107a: number; grand: boolean } | null }
  | { type: 'impacts'; id: number; rows: Float64Array; seed: number }
  | { type: 'impactLab'; id: number; result: LabScenario | null; error?: string }
  | { type: 'impactViz'; id: number; visual: VisualScenario | null; error?: string };

export interface OrbitSummary {
  snapshotId: string; retrieved: string; count: number; epochMinMs: number; epochMaxMs: number; medianEpochMs: number;
  byOperator: Record<string, number>; byClass: Record<string, number>;
  /** observed shells: altitude bins (km) × operator */
  bins: { lo: number; hi: number; counts: Record<string, number> }[];
  starlink: { observedLossFraction: number; model: { label: string; lost: number }[]; higher: { label: string; lost: number }[]; quiet: number };
}

export interface LabScenario {
  body: string; n: number; seed: number; year: number;
  energyMt: ScenarioResult['energyMt']; outcomes: Record<string, number>;
  burstAltKm: ScenarioResult['burstAltKm']; craterKm: ScenarioResult['craterKm']; plumeKm: ScenarioResult['plumeKm']; scarKm: ScenarioResult['scarKm'];
  deaths: ScenarioResult['deaths']; capitalLost: ScenarioResult['capitalLost'];
  median: { outcome: string; deposition: [number, number][]; track: [number, number][]; notes: string[]; crater: { finalM: number; transientM: number; morphology: string; material: string } | null; plume: unknown; blastKm: unknown; thermalKm: number | null; ejecta1mKm: number | null; seismic: number | null; tsunami: unknown; sites: { site: number; distanceKm: number; deaths: number; capitalLost: number }[]; impactor: unknown; orbitalLoss: number };
  settlement: { pop: number; capital: number; sites: number } | null;
  limitations: string[];
  /** three whole representative draws (scenario.ts representatives), ready for the 3D view */
  visual: Record<'low' | 'nominal' | 'high', VisualScenario>;
  representatives: { low: number; nominal: number; high: number; modal: string };
  location: LocationReq | null;
}

// ---------------------------------------------------------------- observed objects

const rows: GpRow[] = GP?.rows ?? [];
const recs = new Map<number, SatRec | null>();
const rec = (i: number) => { let r = recs.get(i); if (r === undefined) { r = satrecOf(rows[i]); recs.set(i, r); } return r; };

const NASA_NAMES = new Set(['HST', 'AQUA', 'TERRA', 'AURA', 'ICESAT-2', 'GPM-CORE', 'SMAP', 'OCO-2', 'TESS', 'SWOT', 'PACE', 'CALIPSO', 'LANDSAT 8', 'LANDSAT 9', 'NUSTAR', 'SWIFT', 'FERMI', 'IXPE', 'TIMED', 'GOES 16', 'GOES 18', 'GOES 19']);
const COSPAR_MISSION = new Map<string, (typeof MISSIONS)[number]>();
for (const m of MISSIONS) for (const c of [m.cospar, ...m.payloads.map((p) => p.cospar)]) if (c) COSPAR_MISSION.set(c.length > 8 ? c : c, m);

export const OPERATOR_COLOR: Record<string, string> = { SpaceX: '#3987e5', Amazon: '#c98500', 'Eutelsat OneWeb': '#199e70', 'NASA or NOAA': '#d55181', 'ISS partnership': '#e8e8e8', Other: '#7f8a99' };

function operatorOf(r: GpRow): [string, string] {
  const n = r[1].toUpperCase();
  if (n.startsWith('STARLINK')) return ['SpaceX', 'by name'];
  if (n.startsWith('KUIPER') || n.startsWith('AMAZON')) return ['Amazon', 'by name'];
  if (n.startsWith('ONEWEB')) return ['Eutelsat OneWeb', 'by name'];
  if (n.startsWith('ISS (')) return ['ISS partnership', 'by name'];
  const m = COSPAR_MISSION.get(r[2]) ?? COSPAR_MISSION.get(r[2].slice(0, 8));
  if (m && m.payloads.some((p) => p.owner === 'nasa')) return ['NASA or NOAA', `mission registry (${m.name})`];
  if (NASA_NAMES.has(n)) return ['NASA or NOAA', 'by name (inferred)'];
  return ['Other', 'not classified'];
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
const altColor = (km: number): [number, number, number] => {
  // sequential: low (warm, strong drag) to high (cool)
  const t = Math.max(0, Math.min(1, Math.log10(Math.max(km, 150) / 150) / Math.log10(36000 / 150)));
  return [0.95 - 0.7 * t, 0.45 + 0.25 * Math.sin(Math.PI * t), 0.25 + 0.7 * t];
};

function orbits(m: Extract<LabReq, { type: 'orbits' }>): LabRes {
  const n = rows.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), age = new Uint8Array(n), nor = new Int32Array(n);
  const at = new Date(m.tMs);
  let k = 0, eMin = Infinity, eMax = -Infinity;
  const levels: AgeLevel[] = ['fresh', 'aging', 'stale', 'invalid'];
  for (let i = 0; i < n; i++) {
    const r = rows[i], ageDays = (m.tMs / 1000 - r[3]) / 86400, lvl = ageLevel(ageDays);
    eMin = Math.min(eMin, r[3] * 1000); eMax = Math.max(eMax, r[3] * 1000);
    if (lvl === 'invalid') continue; // never drawn as a position
    const s = rec(i);
    const p = s ? positionKm(s, at) : null;
    if (!p) continue;
    pos[k * 3] = p[0] / EARTH_RADIUS_KM; pos[k * 3 + 1] = p[2] / EARTH_RADIUS_KM; pos[k * 3 + 2] = -p[1] / EARTH_RADIUS_KM; // TEME z is up in the view
    const c = m.colorBy === 'operator' ? hex(OPERATOR_COLOR[operatorOf(r)[0]]) : m.colorBy === 'altitude' ? altColor(Math.hypot(...p) - EARTH_RADIUS_KM) : hex(['#3987e5', '#c98500', '#d95926', '#666666'][levels.indexOf(lvl)]);
    col.set(c, k * 3);
    age[k] = levels.indexOf(lvl); nor[k] = r[0];
    k++;
  }
  const legend: [string, string][] = m.colorBy === 'operator' ? Object.entries(OPERATOR_COLOR) : m.colorBy === 'age' ? [['fresh (≤ 3 d)', '#3987e5'], ['aging (3–14 d)', '#c98500'], ['stale (14–60 d)', '#d95926']] : [['low LEO (strong drag)', '#f27340'], ['high LEO', '#a6b38a'], ['GEO', '#40a6f2']];
  return { type: 'orbits', id: m.id, tMs: m.tMs, snapshotId: SNAPSHOT_ID, count: k, positions: pos.slice(0, k * 3), colors: col.slice(0, k * 3), age: age.slice(0, k), norads: nor.slice(0, k), epochMinMs: eMin, epochMaxMs: eMax, legend };
}

function search(q: string, limit = 12): Extract<LabRes, { type: 'satSearch' }>['hits'] {
  const s = q.trim().toUpperCase();
  if (!s) return [];
  const asNum = Number(s), out: Extract<LabRes, { type: 'satSearch' }>['hits'] = [];
  for (const r of rows) {
    if ((Number.isFinite(asNum) && r[0] === asNum) || r[1].toUpperCase().includes(s) || r[2].toUpperCase().startsWith(s)) {
      out.push({ norad: r[0], name: r[1], objectId: r[2], altKm: Math.round(orbitOf(r).perigeeKm) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const modeWeather = (main: Engine | null): Record<AtmoMode, SW> => {
  const now = SPACE_WEATHER ? observedWeather(SPACE_WEATHER.stats) : null;
  const d = Math.floor(dayOf(Date.parse(SPACE_WEATHER?.stats.lastDate ?? '2026-10-24')));
  const obs = now?.(d) ?? { f107: 130, f107a: 130, ap: 8 };
  void main;
  return { quiet: { f107: 70, f107a: 70, ap: 4 }, nominal: { f107: obs.f107a, f107a: obs.f107a, ap: Math.max(7, obs.ap) }, storm: { f107: 200, f107a: 180, ap: 80 } };
};

function satInfo(norad: number, tMs: number, main: Engine | null): SatInfo | null {
  const i = rows.findIndex((r) => r[0] === norad);
  if (i < 0) return null;
  const r = rows[i], o = orbitOf(r), [op, opBasis] = operatorOf(r), { cls, inferred } = classOf(r[1], r[0], o.perigeeKm), p = CLASSES[cls];
  const ageDays = (tMs / 1000 - r[3]) / 86400;
  const sw = modeWeather(main);
  const lowAlt = Math.max(150, o.perigeeKm);
  const rho = (s: SW) => (lowAlt > DRAG_CEILING_KM ? 0 : meanDensity(lowAlt, o.incDeg, s));
  const start = Math.floor(dayOf(tMs));
  const sa = main?.sun ?? null;
  const decay: Record<AtmoMode, Spread> | null = lowAlt > DRAG_CEILING_KM ? null : {
    quiet: lifetimeRange({ cls, altKm: lowAlt, incDeg: o.incDeg, startDay: start, weather: constantWeather(sw.quiet), seed: norad, n: 12, powered: false, maxYears: 300 }).reentryYears,
    nominal: lifetimeRange({ cls, altKm: lowAlt, incDeg: o.incDeg, startDay: start, weather: sa ? sa.weather('nominal') : constantWeather(sw.nominal), seed: norad, n: 12, powered: false, maxYears: 300 }).reentryYears,
    storm: lifetimeRange({ cls, altKm: lowAlt, incDeg: o.incDeg, startDay: start, weather: sa ? sa.weather('storm') : constantWeather(sw.storm), seed: norad, n: 12, powered: false, maxYears: 300 }).reentryYears,
  };
  let powered: SatInfo['powered'] = null;
  if (p.propulsion && lowAlt <= DRAG_CEILING_KM) {
    powered = {} as NonNullable<SatInfo['powered']>;
    for (const mode of ['quiet', 'nominal', 'storm'] as AtmoMode[]) {
      const w = mode === 'quiet' ? constantWeather(sw.quiet) : sa ? sa.weather(mode) : constantWeather(sw[mode]);
      const a = lifetimeRange({ cls, altKm: lowAlt, incDeg: o.incDeg, startDay: start, weather: w, seed: norad + 1, n: 12, powered: true, maxYears: 60 });
      powered[mode] = { life: a.operationalYears, dv: a.stationkeepingDvPerYear, prop: a.propellantPerYearKg };
    }
  }
  const m = COSPAR_MISSION.get(r[2]) ?? COSPAR_MISSION.get(r[2].slice(0, 8)) ?? null;
  const tri = (x: { low: number; nominal: number; high: number }): [number, number, number] => [x.low, x.nominal, x.high];
  // today's launch share at the published Falcon 9 list price ($69.75M per launch over 15–22.8 t to LEO): a list price, not a cost
  const listLo = 69.75e6 / 22800, listHi = 69.75e6 / 15000;
  return {
    norad, name: r[1], objectId: r[2], epochIso: new Date(r[3] * 1000).toISOString(), ageDays, age: ageLevel(ageDays), orbit: o,
    operator: op, operatorBasis: opBasis, cls, clsLabel: p.label, clsBasis: inferred,
    ballistic: ballisticRange(p), massKg: tri(p.massKg), areaM2: tri(p.dragAreaM2), cd: tri(p.cd),
    rhoNow: lowAlt > DRAG_CEILING_KM ? null : rho(sw.nominal), rhoByMode: { quiet: rho(sw.quiet), nominal: rho(sw.nominal), storm: rho(sw.storm) },
    regime: dragRegime(lowAlt, rho(sw.nominal)), decay, powered,
    replacementUsd: [p.unitCostUsd.low + p.massKg.low * listLo, p.unitCostUsd.nominal + p.massKg.nominal * (listLo + listHi) / 2, p.unitCostUsd.high + p.massKg.high * listHi],
    mission: m ? { id: m.id, name: m.name, status: m.status } : null,
    snapshotId: SNAPSHOT_ID,
    weatherNote: `Nominal mode uses the observed 81-day F10.7 (${sw.nominal.f107a.toFixed(0)} sfu) for density now and this future's seeded Sun for decay; quiet is solar minimum; storm is a disturbed thermosphere. Decay assumes the object stops manoeuvring today.`,
  };
}

let summaryCache: OrbitSummary | null = null;
function summary(): OrbitSummary {
  if (summaryCache) return summaryCache;
  const byOperator: Record<string, number> = {}, byClass: Record<string, number> = {};
  const edges = [0, 300, 400, 450, 500, 550, 600, 700, 800, 1000, 1500, 2000, 10000, 30000, 40000, 1e6];
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], counts: {} as Record<string, number> }));
  const eps: number[] = [];
  for (const r of rows) {
    const [op] = operatorOf(r), o = orbitOf(r), { cls } = classOf(r[1], r[0], o.perigeeKm);
    byOperator[op] = (byOperator[op] ?? 0) + 1; byClass[cls] = (byClass[cls] ?? 0) + 1;
    const alt = (o.perigeeKm + o.apogeeKm) / 2, b = bins.find((x) => alt >= x.lo && alt < x.hi);
    if (b) b.counts[op] = (b.counts[op] ?? 0) + 1;
    eps.push(r[3] * 1000);
  }
  eps.sort((a, b) => a - b);
  const obs = SPACE_WEATHER ? observedWeather(SPACE_WEATHER.stats) : constantWeather({ f107: 127, f107a: 120, ap: 30 });
  const model = (['model', 'fang-low', 'fang-high'] as const).map((e) => ({ label: e, lost: starlink2022(obs, { enhancement: e }).lostFraction }));
  const higher = [250, 300].map((p) => ({ label: `perigee ${p} km`, lost: starlink2022(obs, { perigeeKm: p, apogeeKm: p + 100, enhancement: 'fang-high' }).lostFraction }));
  summaryCache = {
    snapshotId: SNAPSHOT_ID, retrieved: GP?.provenance.retrieved ?? '', count: rows.length, epochMinMs: eps[0] ?? NaN, epochMaxMs: eps[eps.length - 1] ?? NaN, medianEpochMs: eps[Math.floor(eps.length / 2)] ?? NaN,
    byOperator, byClass, bins: bins.filter((b) => Object.keys(b.counts).length),
    starlink: { observedLossFraction: 38 / 49, model, higher, quiet: starlink2022(obs, { quiet: true }).lostFraction },
  };
  return summaryCache;
}

// ---------------------------------------------------------------- the simulated fleet at a year

function fleet(year: number, main: Engine | null, stateAt: (step: number) => Engine): Extract<LabRes, { type: 'fleet' }> & { id: number } {
  const trade = { quiet: [], nominal: [], storm: [] } as Record<AtmoMode, ReturnType<typeof altitudeTrade>>;
  if (!main || !main.sun) return { type: 'fleet', id: 0, fleet: null, trade, leoCostPerKg: NaN, cycle: null };
  const e = stateAt(stepOf(main, year));
  const S = e.st.S, eo = e.world.earth * NF;
  const leo = e.series[e.st.step * NGM + GM.leoCostPerKg] || main.series[main.st.step * NGM + GM.leoCostPerKg];
  const cal = 2040 + year, w = { quiet: { f107: 70, f107a: 70, ap: 4 }, nominal: { f107: main.sun.f107a(cal), f107a: main.sun.f107a(cal), ap: 10 }, storm: { f107: 200, f107a: 180, ap: 80 } };
  for (const m of ['quiet', 'nominal', 'storm'] as AtmoMode[]) trade[m] = altitudeTrade('starlink-v2mini', 53, w[m], leo);
  const c = main.sun.cycleAt(cal);
  return {
    type: 'fleet', id: 0, fleet: isAlive(S[eo + F.stage]) ? fleetStep(main.sun, cal, 1, S[eo + F.gdp] / 1.6e14, leo, false) : null, trade, leoCostPerKg: leo,
    cycle: { n: c.n, ssn: main.sun.ssn(cal), f107a: main.sun.f107a(cal), grand: c.grand },
  };
}

/** The last step at or before `year`, no further than the run has got. */
function stepOf(main: Engine, year: number): number {
  let k = 0;
  while (k + 1 <= main.st.step && main.years[k + 1] <= year) k++;
  return k;
}

// ---------------------------------------------------------------- impact lab

function impactLab(m: Extract<LabReq, { type: 'impactLab' }>, main: Engine | null, stateAt: (step: number) => Engine, world: World): LabScenario | null {
  const prof = BODIES[m.body];
  if (!prof) return null;
  let sites: ReturnType<typeof sitesOf> = [], earth: { pop: number; capital: number } | undefined, settlement: LabScenario['settlement'] = null, orbitalShare = 0;
  const bodyId = world.bodies.findIndex((b) => b.name === m.body && b.system === 0);
  if (main && bodyId >= 0) {
    const e = stateAt(stepOf(main, m.year)), S = e.st.S, o = bodyId * NF, stg = S[o + F.stage];
    if (isAlive(stg)) {
      const pop = S[o + F.pop], cap = S[o + F.capital];
      orbitalShare = S[o + F.energy] > 0 ? Math.min(0.9, S[o + F.orbitalPower] / S[o + F.energy]) : 0;
      if (m.body === 'Earth') earth = { pop, capital: cap };
      else sites = sitesOf(bodyId, stg, pop, cap, prof.radiusKm);
      settlement = { pop, capital: cap, sites: sites.length };
    }
  }
  const point = m.body === 'Earth' && m.location?.mode !== 'latlon' ? undefined : pointFor(m.location, bodyId, sites, prof.radiusKm, m.seed);
  const settled = settlement;
  const { result: r, visual } = runLab({ body: m.body, classification: 'hypothetical', diameterM: m.diameterM, composition: m.composition, vInfKms: m.vInfKms, sites, earth, orbitalShare, label: m.label, point, earthSurface: m.body === 'Earth' ? m.earthSurface : undefined }, m.seed, m.n ?? 120,
    { snapshotId: SNAPSHOT_ID, world: bodyId, year: m.year, label: m.label, objectName: m.objectName, banners: m.banner ? [m.banner] : [], popBefore: settled?.pop, capitalBefore: settled?.capital });
  const d = r.median, fx = d.fx;
  return {
    body: m.body, n: r.n, seed: m.seed, year: m.year, energyMt: r.energyMt, outcomes: r.outcomes, burstAltKm: r.burstAltKm, craterKm: r.craterKm, plumeKm: r.plumeKm, scarKm: r.scarKm,
    deaths: r.deaths, capitalLost: r.capitalLost,
    median: {
      outcome: fx.entry.outcome, deposition: fx.entry.deposition.slice(0, 400), track: fx.entry.track, notes: fx.notes,
      crater: fx.crater ? { finalM: fx.crater.finalM, transientM: fx.crater.transientM, morphology: fx.crater.morphology, material: fx.crater.material } : null,
      plume: fx.plume, blastKm: fx.blastKm, thermalKm: fx.thermalKm, ejecta1mKm: fx.ejecta1mKm, seismic: fx.seismicMagnitude, tsunami: fx.tsunami,
      sites: d.exposure.sites, impactor: d.impactor, orbitalLoss: d.exposure.orbitalLossFraction,
    },
    settlement, limitations: r.limitations,
    visual, representatives: r.representatives, location: m.location ?? null,
  };
}

function impactViz(m: Extract<LabReq, { type: 'impactViz' }>, main: Engine | null, world: World): VisualScenario | null {
  if (m.case === 'historical') return historicalVisual(m.key, world, SNAPSHOT_ID);
  if (m.case === 'demo') return demoVisual(m.key, world, SNAPSHOT_ID);
  if (!main) return null;
  return replayVisual(world, main.impacts.rows.subarray(0, main.impacts.n * NIC), m.impactId, main.seed, SNAPSHOT_ID);
}

// ---------------------------------------------------------------- dispatch

export const LAB_TYPES = new Set(['orbits', 'satSearch', 'satInfo', 'orbitSummary', 'fleet', 'impacts', 'impactLab', 'impactViz']);

export function handleLab(m: LabReq, env: { world: World; main: () => Engine | null; stateAt: (step: number) => Engine; post: (r: LabRes, transfer?: Transferable[]) => void }): void {
  const main = env.main();
  if (m.type === 'orbits') { const r = orbits(m) as Extract<LabRes, { type: 'orbits' }>; env.post(r, [r.positions.buffer, r.colors.buffer, r.age.buffer, r.norads.buffer]); }
  else if (m.type === 'satSearch') env.post({ type: 'satSearch', id: m.id, hits: search(m.q, m.limit) });
  else if (m.type === 'satInfo') env.post({ type: 'satInfo', id: m.id, info: satInfo(m.norad, m.tMs, main) });
  else if (m.type === 'orbitSummary') env.post({ type: 'orbitSummary', id: m.id, summary: summary() });
  else if (m.type === 'fleet') env.post({ ...fleet(m.year, main, env.stateAt), id: m.id });
  else if (m.type === 'impacts') { const rows = main ? main.impacts.upTo(m.year) : new Float64Array(0); env.post({ type: 'impacts', id: m.id, rows, seed: main?.seed ?? 0 }, [rows.buffer]); }
  else if (m.type === 'impactLab') {
    try { env.post({ type: 'impactLab', id: m.id, result: impactLab(m, main, env.stateAt, env.world) }); }
    catch (e) { env.post({ type: 'impactLab', id: m.id, result: null, error: (e as Error).message }); }
  }
  else if (m.type === 'impactViz') {
    try { const v = impactViz(m, main, env.world); env.post({ type: 'impactViz', id: m.id, visual: v, error: v ? undefined : 'Nothing to visualize for this request.' }); }
    catch (e) { env.post({ type: 'impactViz', id: m.id, visual: null, error: (e as Error).message }); }
  }
}

export { GP_FIELDS, IC, NIC, SHELLS };
