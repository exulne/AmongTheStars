// Earth's simulated future satellite fleet as aggregate shells (tiered
// fidelity: thousands of future satellites are never integrated one by one).
// Each shell has a representative class (classes.ts); the drag at the shell's
// altitude under the step's solar conditions sets the stationkeeping
// propellant, the propellant sets the operating life, and the life sets the
// replacement rate. Replacements are paid for at the launch-economics model's
// Earth-to-orbit cost per kg plus the class's unit cost; storms take a share
// of the satellites still raising from a low insertion orbit (from a decay
// calculation, cached); availability falls with losses not yet replaced.
// MEO and GEO shells feel no meaningful drag: their life is the design life.
//
// Fleet size is a design assumption, labelled simulated: 40,000 active
// satellites in 2040 (range 20,000–80,000; FCC and ITU filings for LEO
// broadband alone exceed 50,000), growing with the square root of Earth's
// product.

import { ranged } from '../data/provenance.ts';
import { CLASSES } from './classes.ts';
import { G0, circularVelocity, meanDensity, smaOf, stationkeepingDv, dragDadt, ballistic, simulateLife, type Craft } from './decay.ts';
import { triangular } from './lifetime.ts';
import type { SolarActivity, SW } from './spaceWeather.ts';

export interface ShellDef { id: string; label: string; altKm: number; incDeg: number; cls: string; share: number; insertPerigeeKm: number | null; regime: 'VLEO' | 'LEO' | 'MEO' | 'GEO' }

export const SHELLS: ShellDef[] = [
  { id: 'vleo-350', label: 'Very low LEO, 350 km', altKm: 350, incDeg: 53, cls: 'starlink-v2mini', share: 0.12, insertPerigeeKm: 280, regime: 'VLEO' },
  { id: 'leo-550', label: 'Broadband LEO, 550 km', altKm: 550, incDeg: 53, cls: 'starlink-v2mini', share: 0.55, insertPerigeeKm: 280, regime: 'LEO' },
  { id: 'leo-630', label: 'Broadband LEO, 630 km', altKm: 630, incDeg: 51.9, cls: 'kuiper', share: 0.15, insertPerigeeKm: 450, regime: 'LEO' },
  { id: 'leo-1200', label: 'High LEO, 1,200 km', altKm: 1200, incDeg: 87.9, cls: 'oneweb', share: 0.1, insertPerigeeKm: null, regime: 'LEO' },
  { id: 'meo-20200', label: 'Navigation MEO, 20,200 km', altKm: 20200, incDeg: 55, cls: 'geo', share: 0.02, insertPerigeeKm: null, regime: 'MEO' },
  { id: 'geo', label: 'Geostationary, 35,786 km', altKm: 35786, incDeg: 0, cls: 'geo', share: 0.06, insertPerigeeKm: null, regime: 'GEO' },
];

export const FLEET_2040 = ranged(40000, 20000, 80000, 'satellites', 'simulated', 'Design assumption from LEO broadband filings (FCC/ITU); not a forecast');
export const RAISE_DAYS = 30;

export interface ShellState { id: string; sats: number; lifeYears: number; propKgPerSatYear: number; dvMsPerSatYear: number; replacementsPerYear: number; stormLost: number; spendPerYear: number; rhoKgM3: number }
export interface FleetStep { sats: number; replacementsPerYear: number; spendPerYear: number; stormLostSats: number; stormCost: number; availability: number; propellantTPerYear: number; f107a: number; apMean: number; stormDays: number; shells: ShellState[] }

/** Solar conditions over a step: mean F10.7, mean Ap, and storm days (Ap ≥ 50), sampled every ~15 days (deterministic). */
export function stepWeather(sa: SolarActivity, fromYear: number, years: number): { mean: SW; stormDays: number; severeDays: number } {
  const d0 = (Date.UTC(Math.floor(fromYear), 0, 1) - Date.UTC(2000, 0, 1)) / 86400e3 + (fromYear % 1) * 365.25;
  const n = Math.max(4, Math.round(years * 24)), span = years * 365.25;
  let f = 0, fa = 0, ap = 0, storm = 0, severe = 0;
  for (let k = 0; k < n; k++) {
    const sw = sa.day(d0 + ((k + 0.5) / n) * span);
    f += sw.f107; fa += sw.f107a; ap += sw.ap;
    if (sw.ap >= 50) storm++;
    if (sw.ap >= 100) severe++;
  }
  const scale = span / n;
  return { mean: { f107: f / n, f107a: fa / n, ap: ap / n }, stormDays: storm * scale, severeDays: severe * scale };
}

/** Representative craft (the class's nominal values). */
function nominalCraft(cls: string): Craft {
  const p = CLASSES[cls], mid = 0.5;
  const mass = triangular(p.massKg, mid), prop = p.propulsion ? triangular(p.propulsion.propellantKg, mid) : 0;
  return { dryMassKg: mass - prop, propellantKg: prop, areaM2: triangular(p.dragAreaM2, mid), lowDragFactor: triangular(p.lowDragFactor, mid), cd: p.cd.nominal, thrustN: p.propulsion ? p.propulsion.thrustN.nominal : 0, ispS: p.propulsion ? p.propulsion.ispS.nominal : 1, dutyCycle: p.propulsion?.dutyCycle ?? 0 };
}

const stormLossCache = new Map<string, number>();
/** Share of satellites lost if a storm of this Ap strikes while they raise from the shell's insertion orbit (decay model, cached). */
export function stormLossShare(shell: ShellDef, ap: number, f107a: number): number {
  if (shell.insertPerigeeKm === null) return 0;
  const apB = ap >= 200 ? 200 : ap >= 100 ? 100 : ap >= 50 ? 50 : 0, fB = Math.round(f107a / 40) * 40;
  const key = `${shell.id}:${apB}:${fB}`;
  let v = stormLossCache.get(key);
  if (v === undefined) {
    if (apB === 0) v = 0;
    else {
      const craft = nominalCraft(shell.cls);
      // two storm days at the start of raising, then quiet; the operator goes edge-on as in February 2022
      const weather = (d: number) => (d < 2 ? { f107: fB, f107a: fB, ap: apB } : { f107: fB, f107a: fB, ap: 7 });
      let lost = 0;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const f = 0.6 + (0.8 * i) / (n - 1); // spread the area across its range
        const r = simulateLife({ craft: { ...craft, areaM2: craft.areaM2 * f }, incDeg: shell.incDeg, insertAltKm: shell.insertPerigeeKm, targetAltKm: shell.altKm, commissioningDays: 1, designLifeYears: 5, safeModeAp: 20, startDay: 0, weather, maxYears: 0.3 });
        if (r.lostDuringRaising) lost++;
      }
      v = lost / n;
    }
    stormLossCache.set(key, v);
  }
  return v;
}

/**
 * One engine step of the fleet. `leoCostPerKg` comes from the launch-economics
 * model in the same context the engine prices missions in.
 */
export function fleetStep(sa: SolarActivity, fromYear: number, years: number, gdpRatio: number, leoCostPerKg: number, kessler: boolean): FleetStep {
  const w = stepWeather(sa, fromYear, years);
  const total = FLEET_2040.nominal * Math.sqrt(Math.max(0.05, gdpRatio));
  let repl = 0, spend = 0, stormLost = 0, stormCost = 0, prop = 0, outage = 0;
  const shells: ShellState[] = [];
  for (const s of SHELLS) {
    const p = CLASSES[s.cls], craft = nominalCraft(s.cls), sats = total * s.share;
    const design = p.designLifeYears.nominal;
    const rho = meanDensity(s.altKm, s.incDeg, w.mean);
    const a = smaOf(s.altKm), B = ballistic(craft);
    const dadt = dragDadt(a, rho, B, s.incDeg); // m/s
    const dvYear = stationkeepingDv(a, dadt * 3.15576e7);
    const mass = craft.dryMassKg + craft.propellantKg;
    const propYear = craft.ispS > 1 ? mass * (1 - Math.exp(-dvYear / (craft.ispS * G0))) : 0;
    // propellant-limited life (keeping 10% for disposal); MEO/GEO: design life (drag negligible)
    const propLife = propYear > 0 ? (craft.propellantKg * 0.9) / propYear : Infinity;
    const life = Math.max(0.5, Math.min(design, propLife));
    const r = sats / life;
    // storms during the raising window take a share of new satellites
    const raising = r * (RAISE_DAYS / 365.25);
    const lossShare = w.stormDays > 0 ? stormLossShare(s, w.severeDays > 0 ? 100 : 50, w.mean.f107a) : 0;
    const lostPerYear = raising * lossShare * Math.min(1, (w.stormDays / (365.25 * years)) * (365.25 / RAISE_DAYS));
    const unit = p.unitCostUsd.nominal + mass * leoCostPerKg * (s.regime === 'GEO' ? 4 : s.regime === 'MEO' ? 3 : 1);
    const kesslerLoss = kessler && s.regime !== 'GEO' && s.regime !== 'MEO' ? sats * 0.02 : 0; // a cascade destroys ≈2%/yr of LEO assets (design assumption)
    const cost = (r + lostPerYear + kesslerLoss) * unit;
    repl += r + lostPerYear + kesslerLoss; spend += cost; stormLost += lostPerYear * years; stormCost += lostPerYear * unit;
    prop += sats * propYear;
    outage += (lostPerYear + kesslerLoss) * (RAISE_DAYS / 365.25) * 2;
    shells.push({ id: s.id, sats, lifeYears: life, propKgPerSatYear: propYear, dvMsPerSatYear: dvYear, replacementsPerYear: r + lostPerYear + kesslerLoss, stormLost: lostPerYear * years, spendPerYear: cost, rhoKgM3: rho });
  }
  void circularVelocity;
  return { sats: total, replacementsPerYear: repl, spendPerYear: spend, stormLostSats: stormLost, stormCost, availability: Math.max(0, 1 - outage / total), propellantTPerYear: prop / 1000, f107a: w.mean.f107a, apMean: w.mean.ap, stormDays: w.stormDays, shells };
}

/** Altitude trade for one class under fixed conditions: life, propellant, and annualised cost per satellite slot. */
export function altitudeTrade(cls: string, incDeg: number, sw: SW, leoCostPerKg: number, alts = [300, 350, 400, 450, 500, 550, 600, 650, 700, 800, 1000, 1200]): { altKm: number; lifeYears: number; propKgPerYear: number; costPerSlotYear: number; naturalDecayYears: number }[] {
  const p = CLASSES[cls], craft = nominalCraft(cls), mass = craft.dryMassKg + craft.propellantKg;
  return alts.map((altKm) => {
    const rho = meanDensity(altKm, incDeg, sw), a = smaOf(altKm), B = ballistic(craft);
    const dvYear = stationkeepingDv(a, dragDadt(a, rho, B, incDeg) * 3.15576e7);
    const propYear = craft.ispS > 1 ? mass * (1 - Math.exp(-dvYear / (craft.ispS * G0))) : 0;
    const life = Math.max(0.2, Math.min(p.designLifeYears.nominal, propYear > 0 ? (craft.propellantKg * 0.9) / propYear : Infinity));
    // natural decay e-folding estimate: H / |da/dt| converted to years (order of magnitude, for the chart)
    const nat = rho > 0 ? (60e3 / Math.abs(dragDadt(a, rho, B, incDeg))) / 3.15576e7 : Infinity;
    return { altKm, lifeYears: life, propKgPerYear: propYear, costPerSlotYear: (p.unitCostUsd.nominal + mass * leoCostPerKg) / life, naturalDecayYears: nat };
  });
}
