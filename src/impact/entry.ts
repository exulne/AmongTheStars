// Atmospheric entry of an impactor through any of the body profiles: a
// numerical, one-dimensional fragmentation ("pancake") model in the style of
// Chyba, Thomas & Zahnle (1993, Nature 361:40) and Hills & Goda (1993, AJ
// 105:1114), with the strength law and dispersion criterion of Collins,
// Melosh & Marcus (2005, MAPS 40:817):
//   dv/dt = −C_D ρ_a A v² / (2m) + g sin θ
//   dm/dt = −σ C_D ρ_a A v³ / 2                      (ablation; σ = C_H/(C_D Q))
//   intact until ρ_a v² ≥ Y_i,  Y_i = 10^(2.107 + 0.0624 √ρ_i) Pa
//   then the debris spreads: d²r/dt² = C_D ρ_a v² / (2 ρ_i r)
//   airburst when r ≥ f_p r₀ (f_p ≈ 7)
// Straight-line path at entry angle θ, flat-planet geometry. It does not
// reproduce NASA's Asteroid Threat Assessment Project physics (fragment
// cascades, radiative ablation, 3-D hydrocodes); it is meant to rank outcomes
// and show where energy goes. Airless bodies skip it entirely.

import type { BodyProfile } from './bodies.ts';

export interface Impactor {
  diameterM: number;
  densityKgM3: number;
  /** speed at the top of the atmosphere (or surface, if airless), km/s */
  speedKms: number;
  /** from horizontal, degrees */
  angleDeg: number;
  /** bulk strength override (Pa); default from the Collins et al. 2005 law */
  strengthPa?: number;
  kind: 'stony' | 'carbonaceous' | 'iron' | 'cometary';
}

export interface EntryResult {
  outcome: 'no-atmosphere' | 'ground-impact' | 'airburst' | 'deep-deposition' | 'decelerated';
  /** altitude (km above the reference level) of the burst or of peak energy deposition; null if it reached the ground intact */
  burstAltKm: number | null;
  /** altitude of break-up, km (null: never broke up) */
  breakupAltKm: number | null;
  initialEnergyJ: number;
  /** energy deposited in the atmosphere, J */
  atmosphereEnergyJ: number;
  /** what reaches the surface */
  groundSpeedKms: number;
  groundMassKg: number;
  groundEnergyJ: number;
  /** fragment cloud radius relative to the initial radius when it hit the ground */
  spreadAtGround: number;
  /** energy deposited per altitude bin: [altKm, J per km] */
  deposition: [number, number][];
  /** altitude–speed track: [altKm, km/s] */
  track: [number, number][];
  /** the same integration sampled for display (opts.trace): time, altitude, speed, mass and spread along the path; empty unless asked */
  trace: TracePoint[];
  /** seconds from the top of the atmosphere to the end of the integration */
  durationS: number;
}

/** [seconds since the top of the atmosphere, altitude km, speed km/s, mass / initial mass, cloud radius / initial radius, energy deposited J per km of altitude since the last point] */
export type TracePoint = [number, number, number, number, number, number];

export const KT_TNT = 4.184e12; // J
export const CD = 2;
export const SIGMA_ABL = 1.4e-8; // s²/m² (0.014 s²/km²), a typical stony value
export const FP = 7;

export const strengthLaw = (rho: number) => 10 ** (2.107 + 0.0624 * Math.sqrt(rho));

export function entry(body: BodyProfile, imp: Impactor, opts: { season?: number; densityScale?: number; floorKm?: number; lite?: boolean; trace?: boolean } = {}): EntryResult {
  const r0 = imp.diameterM / 2, rhoI = imp.densityKgM3;
  const m0 = (4 / 3) * Math.PI * r0 ** 3 * rhoI, v0 = imp.speedKms * 1e3;
  const E0 = 0.5 * m0 * v0 * v0;
  const theta = (Math.max(5, Math.min(90, imp.angleDeg)) * Math.PI) / 180;
  const atm = body.atmosphere;
  if (atm.kind === 'none') {
    return { outcome: 'no-atmosphere', burstAltKm: null, breakupAltKm: null, initialEnergyJ: E0, atmosphereEnergyJ: 0, groundSpeedKms: imp.speedKms, groundMassKg: m0, groundEnergyJ: E0, spreadAtGround: 1, deposition: [], track: [], trace: [], durationS: 0 };
  }
  const Y = imp.strengthPa ?? strengthLaw(rhoI);
  const scale = opts.densityScale ?? 1;
  const rhoA = (hKm: number) => atm.density(hKm, opts.season) * scale;
  // start where the air is thin enough to be negligible for this body
  let hTop = 0;
  while (rhoA(hTop) > 1e-9 && hTop < 1000) hTop += 10;
  const giant = !body.solidSurface;
  const floor = opts.floorKm ?? (giant ? -3000 : 0);
  let h = hTop * 1000, v = v0, m = m0, r = r0, rdot = 0, broken = false, breakupAlt: number | null = null, burstAlt: number | null = null;
  const g = body.gravity;
  const binKm = giant ? 10 : 1;
  const dep = new Map<number, number>();
  const track: [number, number][] = [];
  let lastTrack = Infinity;
  let deposited = 0, peakE = 0, peakAlt = 0;
  // the display trace only reads the state after each step: it never changes the integration
  const trace: TracePoint[] = [], traceKm = giant ? 5 : 1;
  let time = 0, lastTraceH = h, sinceTrace = 0;
  if (opts.trace) trace.push([0, h / 1000, v / 1000, 1, 1, 0]);
  for (let it = 0; it < 400000; it++) {
    const ra = rhoA(h / 1000);
    const A = Math.PI * r * r;
    const decel = (CD * ra * A * v * v) / (2 * m);
    const dmdt = (-SIGMA_ABL * CD * ra * A * v ** 3) / 2;
    // step: limit the fractional change of speed, mass and radius, and the height step
    const rate = Math.max(decel / Math.max(v, 1), Math.abs(dmdt) / m, broken ? Math.abs(rdot) / r : 0, 1e-6);
    let dt = Math.min((opts.lite ? 0.12 : 0.02) / rate, Math.max(10, (opts.lite ? 0.008 : 0.002) * Math.max(h - floor * 1000, 1000)) / (v * Math.sin(theta)));
    dt = Math.max(dt, 1e-5);
    const ke0 = 0.5 * m * v * v;
    // integrate (semi-implicit Euler is enough at these step sizes)
    v = Math.max(0, v + (-decel + g * Math.sin(theta)) * dt);
    m = Math.max(m * 1e-6, m + dmdt * dt);
    const breaking = !broken && ra * v * v >= Y;
    if (breaking) { broken = true; breakupAlt = h / 1000; }
    if (broken) {
      const rdd = (CD * ra * v * v) / (2 * rhoI * r);
      rdot += rdd * dt; r += rdot * dt;
    }
    h -= v * Math.sin(theta) * dt;
    const ke1 = 0.5 * m * v * v;
    const dE = Math.max(0, ke0 - ke1);
    deposited += dE;
    time += dt;
    if (opts.trace) {
      sinceTrace += dE;
      if (breaking || lastTraceH - h >= traceKm * 1000) { trace.push([time, h / 1000, v / 1000, m / m0, r / r0, sinceTrace / Math.max(1e-3, (lastTraceH - h) / 1000)]); lastTraceH = h; sinceTrace = 0; }
    }
    if (!opts.lite) {
      const bin = Math.floor(h / 1000 / binKm) * binKm;
      dep.set(bin, (dep.get(bin) ?? 0) + dE / binKm);
      if (lastTrack - h > (giant ? 5000 : 1000)) { track.push([h / 1000, v / 1000]); lastTrack = h; }
    } else if (dE > peakE) { peakE = dE; peakAlt = h / 1000; }
    if (burstAlt === null && broken && r >= FP * r0) burstAlt = h / 1000;
    // the dispersed cloud has given up nearly all its energy: an airburst (or, in a giant, deep deposition)
    if (ke1 < 0.005 * E0 || v < 300) break;
    if (h <= floor * 1000) break;
  }
  if (opts.trace && lastTraceH !== h) trace.push([time, h / 1000, v / 1000, m / m0, r / r0, sinceTrace / Math.max(1e-3, (lastTraceH - h) / 1000)]);
  const deposition = [...dep.entries()].sort((a, b) => b[0] - a[0]) as [number, number][];
  const peak = opts.lite ? [peakAlt, peakE] as [number, number] : deposition.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0] as [number, number]);
  const groundE = 0.5 * m * v * v;
  const reached = !giant && h <= 0 && v >= 300;
  let outcome: EntryResult['outcome'];
  if (giant) outcome = 'deep-deposition';
  else if (reached) outcome = burstAlt !== null && groundE < 0.1 * E0 ? 'airburst' : 'ground-impact';
  // stopped high: either the dispersed cloud burned out (airburst) or an intact body was braked to a slow fall
  else outcome = !broken && v < 300 ? 'decelerated' : 'airburst';
  return {
    outcome,
    burstAltKm: outcome === 'ground-impact' || outcome === 'decelerated' ? null : giant ? peak[0] : burstAlt ?? peak[0],
    breakupAltKm: breakupAlt,
    initialEnergyJ: E0,
    atmosphereEnergyJ: reached ? deposited : E0 - (outcome === 'decelerated' ? groundE : 0),
    groundSpeedKms: reached ? v / 1000 : 0,
    groundMassKg: reached ? m : outcome === 'decelerated' ? m : 0,
    groundEnergyJ: reached ? groundE : 0,
    spreadAtGround: r / r0,
    deposition, track, trace, durationS: time,
  };
}

/** Bulk density and strength priors by composition (meteorite and NEO data; ranges for the Monte Carlo). */
export const COMPOSITION = {
  stony: { density: [2200, 3000, 3500], share: 0.6, source: 'Ordinary-chondrite-like NEOs, macroporosity included (Carry 2012)' },
  carbonaceous: { density: [1200, 1600, 2200], share: 0.3, source: 'Carbonaceous NEOs (Bennu 1.19, Ryugu 1.19 g/cm³; C-complex 1.3–2)' },
  iron: { density: [5000, 7000, 7800], share: 0.05, source: 'Iron meteorites ≈ 7.8 g/cm³; M-type bulk lower' },
  cometary: { density: [300, 500, 800], share: 0.05, source: 'Cometary nuclei (67P ≈ 0.53 g/cm³)' },
} as const;
