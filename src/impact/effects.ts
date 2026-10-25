// What an impact does, by body class. Each effect returns a distance-dependent
// damage curve so exposure can be computed spatially (exposure.ts). The
// vulnerability numbers are simplified, documented step curves after
// Glasstone & Dolan (1977) and Rumpf, Lewis & Atkinson (2017, GRL 44:3433);
// they rank outcomes, they are not casualty forecasts.
//
// Rocky bodies with atmospheres (Venus, Earth, Mars, Titan): entry and break-up
//   (entry.ts), airburst or ground impact, crater if material survives, blast
//   (Collins et al. 2005 eqs. 54–57, Sachs-scaled to the body's surface
//   pressure), thermal radiation (Earth only: the fireball model is calibrated
//   for Earth air), ejecta, seismic shaking, dust; tsunami only on Earth's ocean.
// Airless bodies (Mercury, the Moon, small moons): direct impact, crater, ejecta
//   blanket, seismic shaking, ejecta to orbit or escape. No blast, no tsunami.
// Gas and ice giants: energy deposition depth, plume height and scar size scaled
//   from Shoemaker–Levy 9 (NASA: G fragment ≈ 6 million Mt, plumes ≈ 3,000 km,
//   dark scars larger than Earth for weeks to months). No crater, no ground.

import type { BodyProfile, Material } from './bodies.ts';
import { crater, ejectaFasterThan, ejectaThickness, effectiveMagnitude, seismicMagnitude, type Crater } from './crater.ts';
import { entry, KT_TNT, type EntryResult, type Impactor } from './entry.ts';

export const MT = 1e3 * KT_TNT;

export interface Plume { depositionAltKm: number; plumeHeightKm: [number, number, number]; scarDiameterKm: [number, number, number]; durationDays: [number, number, number]; chemistry: string }
export interface Tsunami { sourceAmplitudeM: number; radius3mKm: number; radius1mKm: number }

export interface Effects {
  body: string;
  cls: BodyProfile['cls'];
  entry: EntryResult;
  energyMt: number;
  groundEnergyMt: number;
  crater: Crater | null;
  material: Material | null;
  oceanImpact: boolean;
  /** radii (km) where each effect crosses its thresholds */
  blastKm: { kPa138: number; kPa69: number; kPa21: number; kPa7: number } | null;
  thermalKm: number | null;
  ejecta1mKm: number | null;
  ejecta10cmKm: number | null;
  seismicMagnitude: number | null;
  tsunami: Tsunami | null;
  plume: Plume | null;
  /** ejecta faster than circular orbital speed and than escape speed, kg (airless and thin-atmosphere bodies) */
  orbitalEjectaKg: number; escapingEjectaKg: number;
  /** fraction of the world's people lost to global effects (dust, climate), Earth only */
  globalFatality: number;
  /** combined damage at a ground distance (km): fatality and capital-loss fractions */
  damageAt: (rKm: number) => { fatality: number; capital: number };
  /** the largest distance at which damageAt is non-zero */
  maxRadiusKm: number;
  /** every radius (km) where damageAt changes value, ascending: damage is constant between them */
  breaksKm: number[];
  notes: string[];
}

/** Collins et al. 2005 eq. 54 (surface burst) for Earth air: overpressure (Pa) at scaled distance r1 (m/kt^1/3). */
function pSurface(r1: number): number {
  const px = 75000, rx = 290;
  return ((px * rx) / (4 * r1)) * (1 + 3 * (rx / r1) ** 1.3);
}

/** Overpressure (Pa) at ground distance r (m) for yield E (kt) burst at height z (m), Sachs-scaled to ambient pressure P0. */
export function overpressure(rM: number, eKt: number, zM: number, p0Pa: number): number {
  if (p0Pa <= 0 || eKt <= 0) return 0;
  const k = p0Pa / 101325, s = Math.sqrt(rM * rM + zM * zM) * Math.cbrt(k);
  return k * pSurface(Math.max(s, 1) / Math.cbrt(eKt));
}

/**
 * Ground distance (km) where the overpressure falls to `threshold` (Pa). Overpressure depends on yield only
 * through the cube-root distance scaling, so the scaled distance where pSurface = threshold/k is solved once
 * per (threshold, k) and reused: s = x*·E^(1/3)/k^(1/3), r = √(s² − z²).
 */
const invCache = new Map<number, number>();
export function blastRadiusKm(eKt: number, zM: number, p0Pa: number, threshold: number): number {
  if (p0Pa <= 0 || eKt <= 0) return 0;
  const k = p0Pa / 101325, target = threshold / k, key = Math.round(Math.log(target) * 1e4);
  let x = invCache.get(key);
  if (x === undefined) {
    let lo = 1e-3, hi = 1e9;
    if (pSurface(lo) < target) x = 0;
    else { for (let i = 0; i < 100; i++) { const m = Math.sqrt(lo * hi); if (pSurface(m) >= target) lo = m; else hi = m; } x = lo; }
    invCache.set(key, x);
  }
  const sM = (x * Math.cbrt(eKt)) / Math.cbrt(k);
  return sM > zM ? Math.sqrt(sM * sM - zM * zM) / 1000 : 0;
}

function radiusWhere(f: (rM: number) => number, threshold: number, maxM = 2e7): number {
  if (f(1) < threshold) return 0;
  let lo = 1, hi = maxM;
  if (f(hi) >= threshold) return hi / 1000;
  for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (f(m) >= threshold) lo = m; else hi = m; }
  return lo / 1000;
}

const step = (r: number, zones: [number, number, number][]): [number, number] => {
  for (const [R, f, c] of zones) if (r <= R) return [f, c];
  return [0, 0];
};

export function effects(body: BodyProfile, imp: Impactor, opts: { material?: Material; ocean?: boolean; season?: number; densityScale?: number; lite?: boolean; upperBound?: boolean; trace?: boolean } = {}): Effects {
  const notes: string[] = [];
  // upperBound: skip the atmosphere (everything arrives at full speed) but keep a surface blast from the full energy; used only to rule events out cheaply
  const e = opts.upperBound ? entry({ ...body, atmosphere: { ...body.atmosphere, kind: 'none' } }, imp) : entry(body, imp, { season: opts.season, densityScale: opts.densityScale, lite: opts.lite, trace: opts.trace });
  const energyMt = e.initialEnergyJ / MT, groundMt = e.groundEnergyJ / MT;
  const base = { body: body.name, cls: body.cls, entry: e, energyMt, groundEnergyMt: groundMt, plume: null as Plume | null, tsunami: null as Tsunami | null, orbitalEjectaKg: 0, escapingEjectaKg: 0, globalFatality: 0 };

  // ---------------------------------------------------------------- giants: no surface
  if (!body.solidSurface) {
    const x = energyMt / 6e6; // relative to SL9 fragment G
    const sc = 12000 * Math.cbrt(x), ph = 3000 * x ** 0.1, dur = 30 * Math.cbrt(x);
    const plume: Plume = {
      depositionAltKm: e.burstAltKm ?? 0,
      plumeHeightKm: [ph * 0.6, ph, ph * 1.4],
      scarDiameterKm: energyMt > 1e3 ? [sc * 0.5, sc, sc * 2] : [0, 0, 0],
      durationDays: energyMt > 1e3 ? [dur * 0.3, dur, dur * 3] : [0, 0, 0],
      chemistry: 'Shock chemistry in a hydrogen atmosphere: CO, H₂O, HCN, CS, S₂, NH₃ and dark aerosol debris (SL9 observations)',
    };
    notes.push('No solid surface: energy is deposited in the atmosphere. No crater and no ground effects are computed.');
    notes.push('Plume height and scar size are scaled from Shoemaker–Levy 9 (cube-root of energy for the scar, weak dependence for the plume): ×0.5–×2 uncertain.');
    return { ...base, plume, crater: null, material: null, oceanImpact: false, blastKm: null, thermalKm: null, ejecta1mKm: null, ejecta10cmKm: null, seismicMagnitude: null, damageAt: () => ({ fatality: 0, capital: 0 }), maxRadiusKm: 0, breaksKm: [], notes };
  }

  const atm = body.atmosphere, p0 = atm.kind === 'none' ? 0 : atm.p0Pa;
  const material: Material = opts.material ?? body.materials[0]?.m ?? 'dry-soil';
  const ocean = !!opts.ocean && body.name === 'Earth';
  const hit = e.outcome === 'ground-impact' || e.outcome === 'no-atmosphere' || (e.outcome === 'airburst' && groundMt > 0.01 * energyMt);
  const cr = hit && e.groundSpeedKms > 1 && body.transition
    ? crater({ diameterM: Math.max(0.1, 2 * Math.cbrt((3 * e.groundMassKg) / (4 * Math.PI * imp.densityKgM3))), impactorDensity: imp.densityKgM3, speedKms: e.groundSpeedKms, angleDeg: imp.angleDeg, gravity: body.gravity, material: ocean ? 'water' : material, transition: body.transition })
    : null;
  if (e.outcome === 'airburst') notes.push(`Airburst at ≈ ${(e.burstAltKm ?? 0).toFixed(0)} km: the body broke up and its energy went into the ${body.name === 'Earth' ? 'air' : 'atmosphere'}.`);
  if (e.outcome === 'decelerated') notes.push('Braked to a slow fall by the atmosphere: no crater.');
  if (atm.kind === 'none') notes.push(`${body.name} has no atmosphere to slow or break the impactor: it strikes at full speed.`);

  // blast (only with an atmosphere)
  const burstM = (e.outcome === 'airburst' ? (e.burstAltKm ?? 0) : 0) * 1000;
  const eKtBlast = (e.outcome === 'airburst' ? e.atmosphereEnergyJ : e.initialEnergyJ) / KT_TNT;
  const blastKm = p0 > 0 ? {
    kPa138: blastRadiusKm(eKtBlast, burstM, p0, 138e3),
    kPa69: blastRadiusKm(eKtBlast, burstM, p0, 69e3),
    kPa21: blastRadiusKm(eKtBlast, burstM, p0, 21e3),
    kPa7: blastRadiusKm(eKtBlast, burstM, p0, 7e3),
  } : null;
  if (blastKm && body.name === 'Mars') notes.push('Mars’s thin air carries only a weak blast wave (overpressure scales with ambient pressure).');

  // thermal: Earth only, fireball when fast enough (Collins et al. 2005)
  let thermalKm: number | null = null;
  if (body.name === 'Earth' && imp.speedKms >= 15 && energyMt > 0.1) {
    const E = (e.outcome === 'airburst' ? e.atmosphereEnergyJ : e.initialEnergyJ), eta = 3e-3;
    const phi3 = 0.84e6 * (E / MT) ** (1 / 6); // third-degree burns, J/m²
    thermalKm = radiusWhere((r) => (eta * E) / (2 * Math.PI * (r * r + burstM * burstM)), phi3);
    // the fireball can only reach what is above the horizon
    thermalKm = Math.min(thermalKm, Math.sqrt(2 * body.radiusKm * Math.max(0.1, burstM / 1000 + 1)) * 30);
  }

  // ejecta and seismic shaking from a crater
  let ejecta1mKm: number | null = null, ejecta10cmKm: number | null = null, ejecta1cmKm: number | null = null, seismic: number | null = null;
  if (cr) {
    const t = cr.transientM;
    const at = (h: number) => Math.max(cr.finalM / 2, (t ** 4 / (112 * h)) ** (1 / 3)) / 1000;
    ejecta1mKm = at(1); ejecta10cmKm = at(0.1); ejecta1cmKm = at(0.01);
    void ejectaThickness;
    seismic = seismicMagnitude(e.groundEnergyJ);
    if (atm.kind === 'none' || p0 < 1e4) {
      const vOrb = Math.sqrt(body.gm / (body.radiusKm * 1e3)), vEsc = body.escapeKms * 1e3;
      base.orbitalEjectaKg = Math.max(0, ejectaFasterThan(vOrb, e.groundMassKg, imp.densityKgM3, e.groundSpeedKms, material) - ejectaFasterThan(vEsc, e.groundMassKg, imp.densityKgM3, e.groundSpeedKms, material));
      base.escapingEjectaKg = ejectaFasterThan(vEsc, e.groundMassKg, imp.densityKgM3, e.groundSpeedKms, material);
    }
  }

  // tsunami: Earth's ocean only (Ward & Asphaug 2000 1/r decay of the leading wave from a water cavity)
  if (ocean && cr) {
    const cavityDepth = cr.transientM / 2.83, a0 = Math.min(cavityDepth / 2, 4000), rc = cr.transientM / 2000;
    base.tsunami = { sourceAmplitudeM: a0, radius3mKm: a0 > 3 ? (rc * a0) / 3 : 0, radius1mKm: a0 > 1 ? rc * a0 : 0 };
    notes.push('Ocean impact: tsunami amplitudes are uncertain by about ×10 (Ward & Asphaug 2000; later work finds smaller waves).');
  }

  // global effects on Earth: dust and soot above ≈ 1e5 Mt (Toon et al. 1997)
  if (body.name === 'Earth' && energyMt > 1e4) {
    base.globalFatality = Math.min(0.5, 0.25 * Math.max(0, Math.min(1, (Math.log10(energyMt) - 5) / 2)) + (energyMt > 1e5 ? 0.01 : 0));
    if (base.globalFatality > 0) notes.push('Global dust and climate effects (Toon et al. 1997): crop failure and famine dominate the toll above ≈ 1 km impactors.');
  }

  // combine every curve into one damage function of ground distance
  const zones: { R: number; zones: [number, number, number][] }[] = [];
  if (cr) zones.push({ R: 0, zones: [[cr.finalM / 2000 * 1.2, 1, 1], [ejecta1mKm ?? 0, 0.9, 0.9], [ejecta10cmKm ?? 0, 0.3, 0.5], [ejecta1cmKm ?? 0, 0.02, 0.1]] });
  if (blastKm) zones.push({ R: 0, zones: [[blastKm.kPa138, 0.95, 1], [blastKm.kPa69, 0.5, 0.8], [blastKm.kPa21, 0.05, 0.3], [blastKm.kPa7, 0.005, 0.05]] });
  if (thermalKm) zones.push({ R: 0, zones: [[thermalKm, 0.3, 0.1]] });
  if (seismic !== null) {
    const M = seismic, rad = body.radiusKm;
    const rWhere = (m: number) => { let lo = 0, hi = Math.PI * rad; if (effectiveMagnitude(M, 0, rad) < m) return 0; for (let i = 0; i < 50; i++) { const x = (lo + hi) / 2; if (effectiveMagnitude(M, x, rad) >= m) lo = x; else hi = x; } return lo; };
    zones.push({ R: 0, zones: [[rWhere(7.5), 0.1, 0.4], [rWhere(6.5), 0.01, 0.1]] });
    if (atm.kind === 'none') notes.push('Seismic attenuation uses Earth’s relation; airless worlds such as the Moon ring for longer.');
  }
  const coastal = base.tsunami;
  const damageAt = (r: number) => {
    let live = 1, keep = 1;
    for (const z of zones) { const [f, c] = step(r, z.zones); live *= 1 - f; keep *= 1 - c; }
    return { fatality: 1 - live, capital: 1 - keep };
  };
  const breaksKm = [...new Set(zones.flatMap((z) => z.zones.map((x) => x[0])).filter((r) => r > 0))].sort((a, b) => a - b);
  const maxRadiusKm = Math.max(0, breaksKm[breaksKm.length - 1] ?? 0, coastal?.radius3mKm ?? 0);
  return { ...base, crater: cr, material: cr ? (ocean ? 'water' : material) : null, oceanImpact: ocean, blastKm, thermalKm, ejecta1mKm, ejecta10cmKm, seismicMagnitude: seismic, damageAt, maxRadiusKm, breaksKm, notes };
}

/** A fast, conservative bound on the damage radius (km) from energy alone, used to skip the full pipeline when nothing is near. */
export function damageBoundKm(body: BodyProfile, energyJ: number): number {
  const eKt = energyJ / KT_TNT, p0 = body.atmosphere.kind === 'none' ? 0 : body.atmosphere.p0Pa;
  const blast = p0 > 0 ? blastRadiusKm(eKt, 0, Math.max(p0, 1e4), 7e3) : 0;
  // ejecta 1 cm from a generous crater (×40 the impactor's energy-equivalent size), seismic M ≥ 6.5
  const craterKm = 0.05 * Math.cbrt(eKt) * Math.cbrt(9.81 / body.gravity);
  const ejecta = craterKm * 3.6;
  const M = seismicMagnitude(energyJ), seis = M > 6.5 ? (M - 6.5) / 0.0048 + 60 : 0;
  return Math.max(blast, ejecta, seis, 1) * 1.5;
}
