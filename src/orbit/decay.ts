// Orbital decay and the satellite lifecycle under drag, for scenario
// propagation over days to centuries. This is NOT the display propagator:
// observed satellites are drawn with SGP4 (sgp4.ts), whose fitted elements
// already contain the drag the object actually felt; adding this model on top
// would count drag twice.
//
// Physics (near-circular orbits, semi-major axis a):
//   drag deceleration  D = ½ ρ v_rel² · C_D A / m = ½ ρ v_rel² / B,  B = m / (C_D A)  [kg/m²]
//   v_rel: velocity relative to the co-rotating atmosphere, v_rel ≈ v (1 − ω_E r cos i / v)
//   da/dt = −√(μ a) · ρ · F / B,  F = (1 − ω_E r cos i / v)²      (King-Hele 1987)
//   continuous tangential thrust T: da/dt = 2 √(a³/μ) · T/m;  propellant ṁ = T / (I_sp g₀)
//   stationkeeping Δv for a small Δa: Δv = (v / 2a) Δa
// The ballistic coefficient B is carried explicitly everywhere, with the
// attitude (normal, low-drag, tumbling) changing the area that enters it.
// Lifecycle: deployment → commissioning → orbit raising → operations with
// stationkeeping → degraded or fuel exhausted → disposal → natural decay →
// reentry interface (120 km) → demise (surviving fraction from the class).
// Limitations: circular orbits only (an eccentric insertion orbit is treated at
// its perigee, which is conservative); no lunisolar, radiation-pressure or
// zonal-harmonic perturbations; breakup is a single surviving-mass fraction,
// not an ORSAT or DAS analysis.

import { density, orbitMeanDensity, type AtmoModel } from './thermosphere.ts';
import { THERMO_FIT } from './thermosphereFit.ts';
import type { SW, WeatherFn } from './spaceWeather.ts';

export const MU = 3.986004418e14; // m³/s²
export const R_EARTH = 6378137; // m (WGS 84 equatorial)
export const OMEGA_E = 7.2921159e-5; // rad/s
export const G0 = 9.80665;
export const REENTRY_KM = 120;
/** above this, drag is negligible over the simulation's horizon and is not applied (MEO, GEO) */
export const DRAG_CEILING_KM = 1500;

export type Attitude = 'normal' | 'low-drag' | 'tumbling';

export interface Craft {
  dryMassKg: number;
  propellantKg: number;
  /** drag area in the normal attitude, m² */
  areaM2: number;
  lowDragFactor: number;
  cd: number;
  thrustN: number;
  ispS: number;
  /** fraction of time the thruster can fire */
  dutyCycle: number;
}

/** B = m / (C_D A), kg/m². Higher B decays more slowly. */
export function ballistic(c: Craft, attitude: Attitude = 'normal'): number {
  const a = c.areaM2 * (attitude === 'low-drag' ? c.lowDragFactor : attitude === 'tumbling' ? 0.6 + 0.4 * c.lowDragFactor : 1);
  return (c.dryMassKg + c.propellantKg) / (c.cd * a);
}

export const altOf = (aM: number) => (aM - R_EARTH) / 1000;
export const smaOf = (altKm: number) => R_EARTH + altKm * 1000;
export const circularVelocity = (aM: number) => Math.sqrt(MU / aM);

/** Co-rotation factor F: the atmosphere turns with the Earth, so a prograde orbit meets slower air. */
export function windFactor(aM: number, incDeg: number): number {
  const v = circularVelocity(aM);
  return (1 - (OMEGA_E * aM * Math.cos((incDeg * Math.PI) / 180)) / v) ** 2;
}

/** Drag decay rate da/dt (m/s, negative) at a density. */
export function dragDadt(aM: number, rho: number, B: number, incDeg: number): number {
  if (rho <= 0) return 0;
  return (-Math.sqrt(MU * aM) * rho * windFactor(aM, incDeg)) / B;
}

/** Drag acceleration (m/s²) along the velocity. Zero when ρ = 0. */
export function dragAccel(aM: number, rho: number, B: number, incDeg: number): number {
  const vRel = circularVelocity(aM) * Math.sqrt(windFactor(aM, incDeg));
  return (0.5 * rho * vRel * vRel) / B;
}

/** Raising rate (m/s) from continuous tangential thrust. */
export const thrustDadt = (aM: number, thrustN: number, massKg: number) => 2 * Math.sqrt(aM ** 3 / MU) * (thrustN / massKg);

/** Δv (m/s) to restore Δa (m) of semi-major axis on a circular orbit. */
export const stationkeepingDv = (aM: number, dA: number) => (circularVelocity(aM) / (2 * aM)) * Math.abs(dA);

// ---------------------------------------------------------------- cached orbit-mean density

const ALT0 = 100, ALT_STEP = 10, ALT_N = 91; // 100..1000 km
const FA = [65, 80, 100, 125, 150, 180, 220, 270, 330];
const APS = [0, 4, 7, 15, 30, 50, 100, 200, 400];
const INC_BANDS = [15, 45, 75, 98];
const tables = new Map<string, Float64Array>();

function tableFor(incDeg: number, model: AtmoModel): { t: Float64Array; band: number } {
  const band = INC_BANDS.reduce((b, x, i) => (Math.abs(x - Math.abs(incDeg)) < Math.abs(INC_BANDS[b] - Math.abs(incDeg)) ? i : b), 0);
  const key = `${band}:${model}:${THERMO_FIT.version}`;
  let t = tables.get(key);
  if (!t) {
    t = new Float64Array(ALT_N * FA.length * APS.length);
    for (let i = 0; i < ALT_N; i++) for (let j = 0; j < FA.length; j++) for (let k = 0; k < APS.length; k++)
      t[(i * FA.length + j) * APS.length + k] = Math.log(Math.max(1e-30, orbitMeanDensity(ALT0 + i * ALT_STEP, INC_BANDS[band], FA[j], FA[j], APS[k], 80, model)));
    tables.set(key, t);
  }
  return { t, band };
}

function bracket(xs: number[], x: number): [number, number] {
  if (x <= xs[0]) return [0, 0];
  for (let i = 0; i + 1 < xs.length; i++) if (x <= xs[i + 1]) return [i, (x - xs[i]) / (xs[i + 1] - xs[i])];
  return [xs.length - 2, 1];
}

/**
 * Orbit-mean density (kg/m³) for a circular orbit, from a cached grid of the
 * calibrated thermosphere (trilinear in log ρ). The daily F10.7's departure
 * from its 81-day mean is folded in through the exospheric-temperature weights.
 */
export function meanDensity(altKm: number, incDeg: number, sw: SW, model: AtmoModel = 'msis-calibrated'): number {
  if (model === 'none' || altKm > DRAG_CEILING_KM) return 0;
  if (altKm < ALT0) return density({ altKm, f107: sw.f107, f107a: sw.f107a, ap: sw.ap }, model);
  if (altKm > 1000) return meanDensity(1000, incDeg, sw, model) * Math.exp(-(altKm - 1000) / 250);
  const [c1, c2] = [THERMO_FIT.coeffs[1], THERMO_FIT.coeffs[2]];
  const fEff = sw.f107a + (c2 / c1) * (sw.f107 - sw.f107a);
  const { t } = tableFor(incDeg, model);
  const fi = (altKm - ALT0) / ALT_STEP, i = Math.min(ALT_N - 2, Math.floor(fi)), u = fi - i;
  const [j, v] = bracket(FA, fEff), [k, w] = bracket(APS, sw.ap);
  const at = (a: number, b: number, c: number) => t[(a * FA.length + b) * APS.length + c];
  let s = 0;
  for (const [di, wi] of [[0, 1 - u], [1, u]]) for (const [dj, wj] of [[0, 1 - v], [1, v]]) for (const [dk, wk] of [[0, 1 - w], [1, w]])
    s += wi * wj * wk * at(i + di, Math.min(FA.length - 1, j + dj), Math.min(APS.length - 1, k + dk));
  // outside the F10.7 grid, extrapolate gently in log ρ
  return Math.exp(s);
}

// ---------------------------------------------------------------- lifecycle

export type Phase = 'deployed' | 'commissioning' | 'raising' | 'operational' | 'safe-mode' | 'degraded' | 'disposal' | 'decaying' | 'reentered';

export interface LifeSpec {
  craft: Craft;
  incDeg: number;
  insertAltKm: number;
  /** operational altitude; equal to insertion for no raising */
  targetAltKm: number;
  /** stationkeeping deadband, km */
  deadbandKm?: number;
  commissioningDays?: number;
  designLifeYears: number;
  /** propellant kept back for disposal, as Δv (m/s) */
  disposalDvMs?: number;
  disposalSucceeds?: boolean;
  /** propulsion fails at this many days after deployment (Infinity: never) */
  propulsionFailsDay?: number;
  /** go edge-on and stop thrusting while Ap ≥ this (the February 2022 response); Infinity: never */
  safeModeAp?: number;
  /** day index (days since 2000-01-01) of deployment */
  startDay: number;
  weather: WeatherFn;
  atmosphere?: AtmoModel;
  maxYears?: number;
  /** scenario multiplier on density by day index (e.g. a published storm-time enhancement); default 1 */
  densityScale?: (day: number) => number;
  /** record a trace point every n steps (0: no trace) */
  traceEvery?: number;
}

export interface LifeResult {
  /** days from deployment to reentry interface, or Infinity if still in orbit at maxYears */
  reentryDay: number;
  /** days spent operational */
  operationalDays: number;
  propellantUsedKg: number;
  stationkeepingDvMs: number;
  phaseLog: { day: number; phase: Phase }[];
  trace: { day: number; altKm: number; phase: Phase; propKg: number; rho: number }[];
  /** reached the operational orbit */
  reachedTarget: boolean;
  lostDuringRaising: boolean;
}

export function simulateLife(s: LifeSpec): LifeResult {
  const c = { ...s.craft };
  const model = s.atmosphere ?? 'msis-calibrated';
  const maxDays = (s.maxYears ?? 200) * 365.25;
  const band = (s.deadbandKm ?? 2) * 1000;
  const commission = s.commissioningDays ?? 0;
  const disposalDv = s.disposalDvMs ?? 0;
  const failDay = s.propulsionFailsDay ?? Infinity;
  const safeAp = s.safeModeAp ?? Infinity;
  const target = smaOf(s.targetAltKm);
  let a = smaOf(s.insertAltKm), day = 0;
  let phase = (commission > 0 ? 'commissioning' : s.targetAltKm > s.insertAltKm ? 'raising' : 'operational') as Phase;
  const log: LifeResult['phaseLog'] = [{ day: 0, phase: 'deployed' }, { day: 0, phase }];
  const trace: LifeResult['trace'] = [];
  let used = 0, dvSk = 0, opDays = 0, reached = phase === 'operational', thrusting = false, steps = 0;
  const set = (p: Phase) => { if (p !== phase) { phase = p; log.push({ day, phase: p }); } };
  const reserveKg = () => c.dryMassKg * (Math.exp(disposalDv / (c.ispS * G0)) - 1);

  while (day < maxDays) {
    const alt = altOf(a);
    if (alt <= REENTRY_KM) { set('reentered'); break; }
    const sw = s.weather(s.startDay + day);
    const rho = alt > DRAG_CEILING_KM ? 0 : meanDensity(alt, s.incDeg, sw, model) * (s.densityScale ? s.densityScale(s.startDay + day) : 1);
    const storm = sw.ap >= safeAp && (phase === 'commissioning' || phase === 'raising' || phase === 'safe-mode');
    if (storm && phase !== 'safe-mode') set('safe-mode');
    else if (!storm && phase === 'safe-mode') set(day < commission ? 'commissioning' : reached ? 'operational' : 'raising');
    const attitude: Attitude = phase === 'safe-mode' || phase === 'raising' || phase === 'commissioning' ? 'low-drag' : phase === 'decaying' || phase === 'degraded' ? 'tumbling' : 'normal';
    const B = ballistic(c, attitude);
    const mass = c.dryMassKg + c.propellantKg;
    const drag = dragDadt(a, rho, B, s.incDeg);
    const canThrust = c.thrustN > 0 && day < failDay && c.propellantKg > 0;
    if (phase === 'commissioning' && day >= commission) set(s.targetAltKm > altOf(a) + 1 ? 'raising' : 'operational');
    // how the thruster is used this step
    let thrust = 0;
    if (canThrust) {
      if (phase === 'raising') thrust = c.thrustN * c.dutyCycle;
      else if (phase === 'operational') {
        if (a < target - band) thrusting = true;
        if (a > target) thrusting = false;
        thrust = thrusting ? c.thrustN * c.dutyCycle : 0;
        if (c.propellantKg <= reserveKg()) {
          set('disposal');
        }
      } else if (phase === 'disposal') thrust = s.disposalSucceeds === false ? 0 : -c.thrustN * c.dutyCycle; // retrograde
    } else if (phase === 'operational' || phase === 'raising' || phase === 'disposal') set(c.propellantKg <= 0 ? 'decaying' : 'degraded');
    const up = thrust !== 0 ? thrustDadt(a, thrust, mass) : 0;
    const dadt = drag + up;
    // step: at most 1 day, and no more than ~0.5 km or 2% of the height above reentry per step
    const rate = Math.abs(dadt) || 1e-9;
    let dt = Math.min(86400, (0.5e3 / rate), (0.02 * Math.max(1, alt - REENTRY_KM) * 1e3) / rate);
    dt = Math.max(dt, 60);
    if (phase === 'operational' && !thrusting && day + dt / 86400 > s.designLifeYears * 365.25 && day < s.designLifeYears * 365.25) set('disposal');
    a += dadt * dt;
    if (thrust !== 0) {
      const dm = (Math.abs(thrust) / (c.ispS * G0)) * dt;
      c.propellantKg = Math.max(0, c.propellantKg - dm); used += dm;
      if (phase === 'operational') dvSk += (Math.abs(thrust) / mass) * dt;
    }
    if (phase === 'raising' && a >= target) { a = target; reached = true; set('operational'); }
    if (phase === 'operational') {
      opDays += dt / 86400;
      if (day >= s.designLifeYears * 365.25) set('disposal');
    }
    if (phase === 'disposal' && (s.disposalSucceeds === false || !canThrust)) set('decaying');
    day += dt / 86400;
    steps++;
    if (s.traceEvery && steps % s.traceEvery === 0) trace.push({ day, altKm: altOf(a), phase, propKg: c.propellantKg, rho });
    if (rho === 0 && thrust === 0 && phase === 'decaying') { day = Infinity; break; } // nothing will change: it stays up
  }
  if (s.traceEvery) trace.push({ day: Math.min(day, maxDays), altKm: altOf(a), phase, propKg: c.propellantKg, rho: 0 });
  return {
    reentryDay: phase === 'reentered' ? day : Infinity,
    operationalDays: opDays, propellantUsedKg: used, stationkeepingDvMs: dvSk, phaseLog: log, trace,
    reachedTarget: reached, lostDuringRaising: !reached && phase === 'reentered',
  };
}

/** Modified Bessel function I0 (Abramowitz & Stegun 9.8.1–2). */
function besselI0(x: number): number {
  const t = x / 3.75;
  if (x < 3.75) return 1 + t ** 2 * (3.5156229 + t ** 2 * (3.0899424 + t ** 2 * (1.2067492 + t ** 2 * (0.2659732 + t ** 2 * (0.0360768 + t ** 2 * 0.0045813)))));
  return (Math.exp(x) / Math.sqrt(x)) * (0.39894228 + (0.01328592 + (0.00225319 + (-0.00157565 + (0.00916281 + (-0.02057706 + (0.02635537 + (-0.01647633 + 0.00392377 / t) / t) / t) / t) / t) / t) / t) / t);
}

/**
 * Circular-equivalent altitude of an eccentric orbit for drag: the altitude whose
 * density equals the orbit-averaged density ρ̄ = ρ_p e^(−x) I0(x), x = ae/H
 * (King-Hele 1987, exponential atmosphere about perigee). Used for low
 * insertion orbits, which the circular model would otherwise treat at perigee.
 */
export function circularEquivalentAltKm(perigeeKm: number, apogeeKm: number, incDeg: number, sw: SW, model: AtmoModel = 'msis-calibrated'): number {
  if (apogeeKm <= perigeeKm + 1) return perigeeKm;
  const a = R_EARTH / 1000 + (perigeeKm + apogeeKm) / 2, e = (apogeeKm - perigeeKm) / (2 * a);
  const r1 = meanDensity(perigeeKm, incDeg, sw, model), r2 = meanDensity(perigeeKm + 10, incDeg, sw, model);
  const H = 10 / Math.log(r1 / r2), x = (a * e) / H;
  const target = r1 * Math.exp(-x) * besselI0(x);
  let lo = perigeeKm, hi = apogeeKm;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (meanDensity(m, incDeg, sw, model) > target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** Natural (unpowered) decay time from an altitude, in days. */
export function naturalLifetimeDays(altKm: number, incDeg: number, B: number, weather: WeatherFn, startDay: number, model: AtmoModel = 'msis-calibrated', maxYears = 3000): number {
  const craft: Craft = { dryMassKg: B, propellantKg: 0, areaM2: 1, lowDragFactor: 1, cd: 1, thrustN: 0, ispS: 1, dutyCycle: 0 };
  return simulateLife({ craft, incDeg, insertAltKm: altKm, targetAltKm: altKm, designLifeYears: 0, startDay, weather, atmosphere: model, maxYears }).reentryDay;
}
