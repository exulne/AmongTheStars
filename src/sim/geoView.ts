// What a world looks like right now, for the views, the inspector and the
// explain cards: the geo state of the step the slider is in, carried forward
// to the exact moment with the same pure functions the engine uses (seasons,
// storms, the eruptions and impacts of the geophysics stream since that step).
// Nothing here changes the simulation.

import {
  GEV, GF, GG, Geo, MAX_SCARS, NGEO, NSC, SC, SCAR, aeroCooling, ensoK, grsWidth, marsCaps, marsDust, marsLs, marsYear, saturnGWS, solarCycle, titanSeason,
  type GeoEvent, type GeoSnap,
} from './geo.ts';
import { F, NF } from './metrics.ts';
import type { World } from './world.ts';

export interface GeoStateLike { S: Float64Array; techDone: Float64Array; techWhere: Float64Array; settled: Int32Array; globals: { year: number }; geo?: GeoSnap }

const geos = new Map<number, Geo>();
let geosWorld: World | null = null;
/** The geophysics tables for a run (rates, baselines, comets), shared per seed. */
export function geoFor(world: World, seed: number): Geo {
  if (geosWorld !== world) { geos.clear(); geosWorld = world; }
  let g = geos.get(seed);
  if (!g) { g = new Geo(world, seed); geos.set(seed, g); if (geos.size > 8) geos.delete(geos.keys().next().value!); }
  return g;
}

const rowMaps = new WeakMap<Int32Array, Map<number, number>>();
/** Geo row of body b in a state (Solar System bodies first, then settlements in founding order), -1 if it has none. */
export function geoRow(world: World, snap: GeoStateLike | null, b: number): number {
  const nSol = world.systems[0].bodies.length;
  if (b < nSol) return b;
  if (!snap) return -1;
  let m = rowMaps.get(snap.settled);
  if (!m) { m = new Map(); snap.settled.forEach((x, i) => m!.set(x, i)); rowMaps.set(snap.settled, m); }
  const i = m.get(b);
  return i === undefined || !snap.geo || (nSol + i + 1) * NGEO > snap.geo.rows.length ? -1 : nSol + i;
}

/** A mark on a surface: unit direction (y up), angular radius (radians, drawn larger than life), kind, strength 0..1. */
export interface Scar { x: number; y: number; z: number; rad: number; kind: number; amp: number; year: number; what: string }

export interface WorldNow {
  body: number;
  /** true when the numbers come from this future's state (else the catalogue baseline) */
  live: boolean;
  /** slow temperature anomaly (K), and now with the haze and El Niño on top */
  tSlow: number; tNow: number;
  aero: number; cool: number;
  ice: number; capN: number; capS: number; sea: number; pAtm: number;
  dust: number; storm: boolean; cloud: number; vol: number; field: number; terra: number;
  heatK: number; dimK: number; shade: number;
  /** Mars: solar longitude and Mars Year; Titan: season (+1 northern summer) */
  ls: number; marsYear: number; season: number;
  /** Jupiter's Great Red Spot width (km, 0 gone); Saturn's Great White Spot */
  grs: number; gws: number; gwsLat: number;
  aurora: number;
  /** recent outbursts on Io (0..1) */
  outburst: number;
  scars: Scar[];
  hazards: string[];
  lastEv: number; lastEvT: number; impacts: number;
}

const sol = (world: World, b: number) => world.bodies[b]?.system === 0;
const named = (world: World, b: number, n: string) => sol(world, b) && world.bodies[b].name === n;
const evBuf: GeoEvent[] = [];

/** World b at sim year `year` (years after 2040), from the state the slider is in. */
export function worldNow(world: World, snap: GeoStateLike | null, b: number, year: number): WorldNow {
  const seed = snap?.geo?.seed ?? 1;
  const g = geoFor(world, seed), body = world.bodies[b], Y = 2040 + year;
  const r = geoRow(world, snap, b), rows = snap?.geo?.rows, live = !!rows && r >= 0;
  const o = r * NGEO;
  const v = (k: number, d: number) => (live ? rows![o + k] : d);
  const stateYear = snap?.globals.year ?? year;
  // aerosol: the state's pulse decayed to now, plus eruptions and impacts since the state's step
  let a0 = v(GF.aero0, 0), aT = v(GF.aeroT, 0), aTau = v(GF.aeroTau, 1);
  const pending = live && year > stateYear ? g.eventsIn(b, stateYear, year, evBuf).map((e) => ({ ...e })) : [];
  const air = g.baseP[b] > 0.05 || v(GF.pAtm, g.baseP[b]) > 0.05;
  for (const ev of pending) {
    if (!air) break;
    const tau = AERO[ev.cls];
    if (!tau || (ev.cls <= GEV.KM10 && snap && g.deflected(snap, b, ev.cls, ev.t, ev.d))) continue;
    const now = a0 > 0 && ev.t >= aT ? a0 * Math.exp(-(ev.t - aT) / aTau) : 0, amp = tau[0] + (tau[1] - tau[0]) * ev.m;
    aTau = now > amp ? (aTau * now + tau[2] * amp) / (now + amp) : tau[2]; a0 = now + amp; aT = ev.t;
  }
  const aero = a0 > 0 && year >= aT ? a0 * Math.exp(-(year - aT) / aTau) : 0, cool = aeroCooling(aero);
  const terra = v(GF.terra, 0);
  const tSlow = v(GF.tAnom, b === world.earth ? 1.7 : 0);
  const tNow = tSlow - cool + (b === world.earth ? ensoK(seed, Y) : 0);
  // seasons
  let capN = v(GF.capN, 0), capS = v(GF.capS, 0), dust = v(GF.dust, 0), storm = false, ls = 0, my = 0;
  if (b === world.mars) {
    const perm = Math.max(0, Math.min(1, capN / 10));
    [capN, capS] = marsCaps(seed, Y, live ? perm : 1);
    const d = marsDust(seed, Y);
    dust = d.tau * (1 - Math.min(1, terra * 1.5)); storm = d.storm && terra < 0.6; ls = d.ls; my = marsYear(Y);
  } else if (g.rate[b * 16 + GEV.DUST] > 0) {
    for (const ev of g.eventsIn(b, year - 0.6, year, evBuf)) if (ev.cls === GEV.DUST && year - ev.t < 0.2 + 0.3 * ev.m) { storm = true; dust = Math.max(dust, 2 + 4 * ev.j); }
  }
  if (!live && b !== world.mars) { const c = g.baseIce[b] < 0.005 ? 0 : g.baseIce[b] >= 0.9 ? 90 : Math.min(90, 8 + 60 * g.baseIce[b]); capN = b === world.earth ? 18 : c; capS = b === world.earth ? 26 : c; }
  const season = named(world, b, 'Titan') ? titanSeason(Y) : 0;
  const grs = named(world, b, 'Jupiter') ? grsWidth(seed, Y) : 0;
  const gw = named(world, b, 'Saturn') ? saturnGWS(seed, Y) : { amp: 0, lat: 35 };
  // aurora: a magnetic field and air to glow in, brighter at solar maximum and after a storm
  const field = v(GF.field, g.baseField[b]);
  let aurora = 0;
  if (field >= 0.3 && (air || g.baseP[b] < 0)) {
    aurora = sol(world, b) ? 0.12 + 0.3 * solarCycle(Y) : 0.3;
    for (const s of g.stormsIn(body.system, year - 1, year)) aurora += (s.big ? 1 : 0.5) * Math.exp(-(year - s.t) / 0.15);
    aurora = Math.min(1, aurora);
  }
  // scars: lasting ones from the state, passing ones from the stream
  const scars: Scar[] = [];
  const S = snap?.geo?.scars, nScar = snap?.geo ? Math.min(MAX_SCARS, snap.geo.g[GG.nScar]) : 0;
  for (let i = 0; i < nScar; i++) {
    const so = i * NSC;
    if (S![so + SC.body] !== b || S![so + SC.year] > year) continue;
    const amp = Math.exp(-(year - S![so + SC.year]) / S![so + SC.fade]);
    if (amp < 0.03) continue;
    scars.push({ x: S![so + SC.x], y: S![so + SC.y], z: S![so + SC.z], rad: S![so + SC.rad], kind: S![so + SC.kind], amp, year: S![so + SC.year], what: S![so + SC.kind] === SCAR.LAVA ? 'supervolcano caldera' : 'impact crater' });
  }
  for (const ev of pending) {
    if ((ev.cls === GEV.R140 || ev.cls === GEV.KM1 || ev.cls === GEV.KM10 || ev.cls === GEV.VEI8) && !(snap && ev.cls !== GEV.VEI8 && g.deflected(snap, b, ev.cls, ev.t, ev.d)))
      scars.push({ x: ev.x, y: ev.y, z: ev.z, rad: ev.cls === GEV.R140 ? 0.012 : ev.cls === GEV.KM1 ? 0.03 : ev.cls === GEV.KM10 ? 0.08 : 0.04, kind: ev.cls === GEV.VEI8 ? SCAR.LAVA : SCAR.CRATER, amp: 1, year: ev.t, what: ev.cls === GEV.VEI8 ? 'supervolcano caldera' : 'impact crater' });
  }
  let outburst = 0;
  const passing = (cls: number[], window: number, fade: number, rad: number, kind: number, what: string) => {
    for (const ev of g.eventsIn(b, Math.max(0, year - window), year, evBuf)) {
      if (!cls.includes(ev.cls)) continue;
      const amp = Math.exp(-(year - ev.t) / fade);
      if (amp < 0.04) continue;
      if (ev.cls === GEV.JSL9) {
        // a string of fragments along one latitude, as Shoemaker–Levy 9's were at 44° S
        const n = Math.min(10, 5 + Math.floor(ev.m * 17)), lat = -0.7 + 0.2 * ev.y, lon0 = Math.atan2(ev.z, ev.x);
        for (let k = 0; k < n; k++) { const lon = lon0 + k * 0.22, c = Math.cos(lat); scars.push({ x: c * Math.cos(lon), y: Math.sin(lat), z: c * Math.sin(lon), rad: 0.09 + 0.05 * ((k * 7) % 3) / 2, kind, amp, year: ev.t, what }); }
      } else scars.push({ x: ev.x, y: ev.y, z: ev.z, rad: rad * (0.7 + 0.6 * ev.m), kind, amp, year: ev.t, what });
      if (ev.cls === GEV.IO) outburst = Math.max(outburst, Math.exp(-(year - ev.t) / 0.4));
    }
  };
  if (named(world, b, 'Jupiter')) passing([GEV.JSCAR, GEV.JSL9], 3, 0.35, 0.08, SCAR.DARK, 'impact scar');
  if (named(world, b, 'Io')) passing([GEV.IO], 60, 15, 0.12, SCAR.LAVA, 'fresh lava flow');
  if (named(world, b, 'Venus')) passing([GEV.VENUS], 90, 25, 0.1, SCAR.LAVA, 'fresh lava flow');
  if (!sol(world, b) && g.rate[b * 16 + GEV.LAVA] > 0) passing([GEV.LAVA], 40, 10, 0.12, SCAR.LAVA, 'lava flood');
  // what is going on
  const hazards: string[] = [];
  if (storm) hazards.push(b === world.mars ? `a global dust storm (optical depth ${dust.toFixed(1)})` : 'a global dust storm');
  if (aero > 0.03) hazards.push(`volcanic or impact haze (optical depth ${aero.toFixed(2)}, ${cool.toFixed(1)} K colder)`);
  if (outburst > 0.2) hazards.push('a lava outburst');
  if (sol(world, b) && body.flux > 0.03 && solarCycle(Y) > 0.85) hazards.push('solar maximum: more storms');
  if (terra > 0 && terra < 1 && live && snap!.S[b * NF + F.stage] >= 5) hazards.push(`terraforming under way (${Math.round(terra * 100)}%)`);
  return {
    body: b, live, tSlow, tNow, aero, cool,
    ice: v(GF.ice, g.baseIce[b]), capN, capS, sea: v(GF.sea, 0), pAtm: v(GF.pAtm, g.baseP[b]),
    dust, storm, cloud: v(GF.cloud, g.baseCloud[b]), vol: v(GF.vol, g.baseVol[b]), field, terra,
    heatK: v(GF.heatK, 0), dimK: v(GF.dimK, 0), shade: v(GF.shade, 0),
    ls, marsYear: my, season, grs, gws: gw.amp, gwsLat: gw.lat, aurora, outburst, scars, hazards,
    lastEv: v(GF.lastEv, -1), lastEvT: v(GF.lastEvT, -1), impacts: v(GF.nImp, 0),
  };
}

/** Aerosol of each class that makes some: [τ min, τ max, e-fold years] (as geo.ts FX). */
const AERO: ([number, number, number] | undefined)[] = [];
AERO[GEV.R140] = [0.01, 0.03, 1]; AERO[GEV.KM1] = [2, 4, 1.5]; AERO[GEV.KM10] = [25, 40, 3];
AERO[GEV.VEI6] = [0.08, 0.15, 1]; AERO[GEV.VEI7] = [0.2, 0.5, 1.2]; AERO[GEV.VEI8] = [2, 5, 2];

/** Mars's season in words. */
export function marsSeason(ls: number): string {
  const n = ls < 90 ? 'northern spring' : ls < 180 ? 'northern summer' : ls < 270 ? 'northern autumn' : 'northern winter';
  return `${n} (Ls ${Math.round(ls)}°)${ls >= 180 && ls <= 310 ? ', dust-storm season' : ''}`;
}
export { marsLs };
