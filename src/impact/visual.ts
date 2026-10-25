// The one contract between the impact physics and the 3D visualization. A
// VisualScenario is plain, serializable data built from a result the pipeline
// already computed (a Draw from scenario.ts, a logged engine impact rebuilt by
// replayDraw, or a JPL close approach): the renderer never re-derives physics
// from report text and never runs a second model. What it may draw is decided
// here, once, in `render`, from the body class and the outcome:
//   airless bodies   no trail, no breakup, no airburst, no blast ring
//   giants           entry, deep deposition, plume, scar; never a crater or ground
//   airburst         stops at the burst altitude; a crater only if the result has one
//   decelerated      no high-speed contact, no crater
//   deflection       a miss: no effects at all
//   close approach   a miss at the sourced nominal distance; never an impact
// Visual randomness (approach azimuth, particle seeds) comes from `seed`.

import type { Classification } from '../data/provenance.ts';
import type { BodyProfile } from './bodies.ts';
import { effectiveMagnitude } from './crater.ts';
import type { TracePoint } from './entry.ts';
import type { Site } from './exposure.ts';
import type { Draw } from './scenario.ts';
import { hash01 } from '../sim/rng.ts';

export const VISUAL_VERSION = '1.0.0';

export const TEXT = {
  hypotheticalFromApproach: 'Hypothetical collision using this object’s properties. This is not its predicted JPL trajectory.',
  closeApproach: 'Close approach: the object passes at the JPL nominal miss distance. The 3-sigma band is a distance interval, not an impact probability.',
  schematic: 'Schematic encounter geometry: the approach direction is illustrative; the miss distance and speed are from JPL CAD.',
  earthGeography: 'Statistical Earth exposure; geography is not mapped.',
  earthLocation: 'Representative synthetic location: not a real country or city. The globe’s coastlines are decorative.',
  marker: 'Impactor marker enlarged for visibility. Distances and effect radii use the reported values.',
  particles: 'Fragments, ejecta and plume particles are a visual representation: not a literal count or size.',
  time: 'Visual time is compressed and not real time: entry lasts seconds, effects spread over minutes to hours, scars persist for weeks.',
  tsunami: 'Simplified radial visualization: the simulation does not model real bathymetry or coastlines.',
  deflection: 'Conceptual course change, illustrative only: the model records whether a deflection succeeded, not the manoeuvre.',
  giant: 'No solid surface: the grey shell is the 1-bar reference level, not ground. No crater forms.',
  venus: 'Venus’s clouds hide the lower atmosphere: the cutaway view makes them transparent as a visualization aid.',
  sl9: 'Gas-giant reference: Shoemaker–Levy 9 (1994): luminous entry, plumes ≈ 2,000–3,000 km high, dark scars lasting weeks (NASA).',
  notAtap: 'A one-dimensional model that ranks outcomes; it does not have NASA ATAP fidelity.',
} as const;

export type VisualKind = 'impact' | 'close-approach' | 'deflection';
export type Representative = 'low' | 'nominal' | 'high' | 'single';

export interface SiteViz {
  i: number; dir: [number, number, number]; distanceKm: number; radiusKm: number;
  pop: number; capital: number; deaths: number; capitalLost: number;
  /** shares of the site's people and property lost */
  fatality: number; capitalShare: number;
}

export interface RenderFlags {
  atmosphereTrail: boolean; breakup: boolean; airburst: boolean; deepDeposition: boolean;
  surfaceContact: boolean; survivingMass: boolean; crater: boolean; ejecta: boolean;
  blastRings: boolean; thermalRing: boolean; seismicRing: boolean; tsunami: boolean;
  plume: boolean; scar: boolean; haze: boolean; settlementOverlay: boolean; orbitalRisk: boolean;
  statisticalEarth: boolean; oneBarShell: boolean; cloudCutaway: boolean;
  ghostPath: boolean; missPath: boolean; uncertaintyBand: boolean;
}

export interface VisualScenario {
  version: string;
  id: string;
  kind: VisualKind;
  classification: Classification;
  source: { label: string; organization?: string; url?: string; note: string };
  snapshotId: string;
  seed: number;
  /** Monte Carlo draw index (null: a single evaluation, a log replay or a close approach) */
  draw: number | null;
  representative: Representative | null;
  representativeNote: string;
  body: { name: string; world: number; cls: BodyProfile['cls']; radiusKm: number; solidSurface: boolean; atmosphere: BodyProfile['atmosphere']['kind']; p0Pa: number; scaleHeightKm: number; rotationHours: number };
  when: { year: number | null; date: string | null; label: string };
  object: { name: string; composition: string; diameterM: number; densityKgM3: number; strengthPa: number | null };
  trajectory: {
    sourced: boolean; label: string;
    /** speed at the top of the atmosphere (or the surface), km/s */
    speedKms: number; vInfKms: number | null;
    /** from horizontal, and the compass heading of travel (seeded unless sourced) */
    angleDeg: number; azimuthDeg: number;
    /** impact (or closest-approach) direction from the body centre, unit vector in the body's frame */
    point: [number, number, number];
    /** direction of travel at the point, unit vector in the body's frame */
    dir: [number, number, number];
    latDeg: number; lonDeg: number;
  };
  entry: null | {
    outcome: string; topAltKm: number; durationS: number;
    /** [t s, altitude km, speed km/s, mass share, spread ×r0, J per km] from the entry integration itself */
    trace: TracePoint[];
    /** the body profile's density at each trace altitude (kg/m³, mean season), for the telemetry */
    density: number[];
    breakupAltKm: number | null; burstAltKm: number | null; peakDepositionAltKm: number | null;
    initialEnergyJ: number; atmosphereEnergyJ: number; groundEnergyJ: number; groundSpeedKms: number; groundMassKg: number; spreadAtGround: number;
    maxDepositionJPerKm: number;
  };
  effects: {
    outcome: string; energyMt: number; groundEnergyMt: number;
    crater: { transientKm: number; finalKm: number; depthKm: number; morphology: string; material: string } | null;
    material: string | null; oceanImpact: boolean;
    blastKm: { kPa138: number; kPa69: number; kPa21: number; kPa7: number } | null;
    thermalKm: number | null; ejecta1mKm: number | null; ejecta10cmKm: number | null;
    seismicMagnitude: number | null; seismicKm: { m75: number; m65: number } | null;
    tsunami: { sourceAmplitudeM: number; radius3mKm: number; radius1mKm: number } | null;
    plume: { depositionAltKm: number; plumeHeightKm: [number, number, number]; scarDiameterKm: [number, number, number]; durationDays: [number, number, number]; chemistry: string } | null;
    globalFatality: number; orbitalEjectaKg: number; escapingEjectaKg: number;
    maxRadiusKm: number; notes: string[];
  };
  exposure: {
    mode: 'spatial' | 'statistical-earth' | 'none';
    deaths: number; capitalLost: number; popBefore: number; capitalBefore: number;
    sites: SiteViz[]; orbitalShare: number; orbitalLossFraction: number;
    earth: { land: boolean; urban: boolean; ocean: boolean } | null;
    note: string;
  };
  defense: { detected: boolean; warningYears: number; deflected: boolean; evacuated: boolean; note: string } | null;
  approach: null | { nominalKm: number; minKm: number; maxKm: number; vRelKms: number; vInfKms: number | null; timeSigma: string; date: string; horizons: boolean };
  /** a deflected impactor's would-be event, for the telemetry only (nothing of it is drawn) */
  averted: { outcome: string; energyMt: number } | null;
  render: RenderFlags;
  scale: { sceneRadius: number; kmPerUnit: number; legend: string };
  limitations: string[];
  uncertainty: string[];
  banners: string[];
}

// ---------------------------------------------------------------- geometry (pure)

type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** East and north at a point on the unit sphere (y is the spin axis), as the view's cityDir uses. */
export function tangentFrame(p: V3): { east: V3; north: V3 } {
  let east = cross([0, 1, 0], p);
  if (Math.hypot(...east) < 1e-6) east = [1, 0, 0];
  east = norm(east);
  return { east, north: norm(cross(p, east)) };
}

/** Direction of travel at point p for an entry angle (from horizontal) and heading (degrees from north toward east). */
export function travelDir(p: V3, angleDeg: number, azimuthDeg: number): V3 {
  const { east, north } = tangentFrame(p), a = (azimuthDeg * Math.PI) / 180, th = (angleDeg * Math.PI) / 180;
  const h: V3 = [north[0] * Math.cos(a) + east[0] * Math.sin(a), north[1] * Math.cos(a) + east[1] * Math.sin(a), north[2] * Math.cos(a) + east[2] * Math.sin(a)];
  return norm([h[0] * Math.cos(th) - p[0] * Math.sin(th), h[1] * Math.cos(th) - p[1] * Math.sin(th), h[2] * Math.cos(th) - p[2] * Math.sin(th)]);
}

export const latLon = (p: V3) => ({ latDeg: (Math.asin(Math.max(-1, Math.min(1, p[1]))) * 180) / Math.PI, lonDeg: (Math.atan2(p[2], p[0]) * 180) / Math.PI });
export const fromLatLon = (latDeg: number, lonDeg: number): V3 => { const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180; return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)]; };

/** A ground distance (km) as an angle on the sphere (radians): geodesic radius / body radius. */
export const geodesicAngle = (km: number, radiusKm: number) => km / radiusKm;

// ---------------------------------------------------------------- what may be drawn

export function renderFlags(v: Omit<VisualScenario, 'render'>): RenderFlags {
  const fx = v.effects, e = v.entry, impact = v.kind === 'impact', air = v.body.atmosphere !== 'none';
  const giant = !v.body.solidSurface;
  const trail = impact && air && !!e && e.trace.length > 1;
  const crater = impact && !!fx.crater && v.body.solidSurface;
  const contact = impact && v.body.solidSurface && !!e && e.groundSpeedKms > 1 && (fx.outcome === 'ground-impact' || fx.outcome === 'no-atmosphere' || crater);
  return {
    atmosphereTrail: trail,
    breakup: trail && e!.breakupAltKm !== null,
    airburst: impact && !giant && fx.outcome === 'airburst',
    deepDeposition: impact && giant && fx.outcome === 'deep-deposition',
    surfaceContact: contact,
    survivingMass: impact && v.body.solidSurface && !crater && !!e && e.groundMassKg > 0 && fx.outcome !== 'no-atmosphere',
    crater,
    ejecta: crater && (fx.ejecta1mKm ?? 0) > 0,
    blastRings: impact && air && !giant && !!fx.blastKm && fx.blastKm.kPa7 > 0,
    thermalRing: impact && (fx.thermalKm ?? 0) > 0,
    seismicRing: crater && !!fx.seismicKm && fx.seismicKm.m65 > 0,
    tsunami: impact && fx.oceanImpact && !!fx.tsunami && fx.tsunami.radius1mKm > 0,
    plume: impact && giant && !!fx.plume,
    scar: impact && giant && !!fx.plume && fx.plume.scarDiameterKm[1] > 0,
    haze: impact && fx.globalFatality > 0,
    settlementOverlay: impact && v.exposure.mode === 'spatial' && v.exposure.sites.length > 0,
    orbitalRisk: impact && fx.orbitalEjectaKg + fx.escapingEjectaKg > 0,
    statisticalEarth: v.body.name === 'Earth' && v.kind !== 'close-approach',
    oneBarShell: giant,
    cloudCutaway: v.body.name === 'Venus',
    ghostPath: v.kind === 'deflection',
    missPath: v.kind !== 'impact',
    uncertaintyBand: v.kind === 'close-approach' && !!v.approach && v.approach.maxKm > v.approach.minKm,
  };
}

function seismicRadii(M: number | null, radiusKm: number): { m75: number; m65: number } | null {
  if (M === null) return null;
  const at = (m: number) => {
    if (effectiveMagnitude(M, 0, radiusKm) < m) return 0;
    let lo = 0, hi = Math.PI * radiusKm;
    for (let i = 0; i < 50; i++) { const x = (lo + hi) / 2; if (effectiveMagnitude(M, x, radiusKm) >= m) lo = x; else hi = x; }
    return lo;
  };
  return { m75: at(7.5), m65: at(6.5) };
}

function finish(v: Omit<VisualScenario, 'render'>): VisualScenario {
  const out = { ...v, render: renderFlags(v) } as VisualScenario;
  const b: string[] = [...v.banners];
  if (out.render.statisticalEarth) b.push(TEXT.earthGeography, TEXT.earthLocation);
  if (out.render.oneBarShell) b.push(TEXT.giant);
  if (out.render.tsunami) b.push(TEXT.tsunami);
  out.banners = [...new Set(b)];
  return out;
}

// ---------------------------------------------------------------- builders

export interface DrawMeta {
  id: string;
  classification: Classification;
  source: VisualScenario['source'];
  snapshotId: string;
  seed: number;
  draw: number | null;
  representative: Representative | null;
  representativeNote?: string;
  body: BodyProfile;
  world: number;
  when: VisualScenario['when'];
  objectName: string;
  sites?: Site[];
  orbitalShare?: number;
  popBefore?: number; capitalBefore?: number;
  /** losses actually applied (a log replay: after warning and evacuation); default: the draw's own */
  applied?: { deaths: number; capitalLost: number; siteFactor: number; capitalFactor: number };
  defense?: VisualScenario['defense'];
  trajectoryLabel?: string;
  limitations?: string[];
  banners?: string[];
  vInfKms?: number | null;
}

/** The visual scenario of one whole draw: everything it shows comes from this draw's own result. */
export function visualFromDraw(d: Draw, m: DrawMeta): VisualScenario {
  const fx = d.fx, e = fx.entry, p = m.body, imp = d.impactor;
  const az = hash01(m.seed, m.draw ?? 0, 7707) * 360;
  const dir = travelDir(d.point, imp.angleDeg, az);
  const topAlt = e.trace.length ? e.trace[0][1] : 0;
  const maxDep = e.trace.reduce((a, t) => Math.max(a, t[5]), 0);
  const peakDep = e.deposition.length ? e.deposition.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : e.burstAltKm;
  const ex = d.exposure as Draw['exposure'] & { land?: boolean; urban?: boolean };
  const earth = p.name === 'Earth';
  const factor = m.applied?.siteFactor ?? 1, capFactor = m.applied?.capitalFactor ?? 1;
  const lost = new Map(ex.sites.map((s) => [s.site, s]));
  const sites: SiteViz[] = (m.sites ?? []).map((s) => {
    const l = lost.get(s.i), dist = Math.acos(Math.max(-1, Math.min(1, s.dir[0] * d.point[0] + s.dir[1] * d.point[1] + s.dir[2] * d.point[2]))) * p.radiusKm;
    const deaths = (l?.deaths ?? 0) * factor, cap = (l?.capitalLost ?? 0) * capFactor;
    return { i: s.i, dir: s.dir, distanceKm: l?.distanceKm ?? dist, radiusKm: s.radiusKm, pop: s.pop, capital: s.capital, deaths, capitalLost: cap, fatality: s.pop > 0 ? Math.min(1, deaths / s.pop) : 0, capitalShare: s.capital > 0 ? Math.min(1, cap / s.capital) : 0 };
  });
  const v: Omit<VisualScenario, 'render'> = {
    version: VISUAL_VERSION, id: m.id, kind: 'impact', classification: m.classification, source: m.source, snapshotId: m.snapshotId,
    seed: m.seed, draw: m.draw, representative: m.representative, representativeNote: m.representativeNote ?? '',
    body: { name: p.name, world: m.world, cls: p.cls, radiusKm: p.radiusKm, solidSurface: p.solidSurface, atmosphere: p.atmosphere.kind, p0Pa: p.atmosphere.p0Pa, scaleHeightKm: p.atmosphere.scaleHeightKm, rotationHours: p.rotationHours },
    when: m.when,
    object: { name: m.objectName, composition: imp.kind, diameterM: imp.diameterM, densityKgM3: imp.densityKgM3, strengthPa: imp.strengthPa ?? null },
    trajectory: { sourced: false, label: m.trajectoryLabel ?? 'Synthetic trajectory: entry angle from the draw, heading seeded (straight-line flight, as the entry model).', speedKms: imp.speedKms, vInfKms: m.vInfKms ?? Math.sqrt(Math.max(0, imp.speedKms ** 2 - p.escapeKms ** 2)), angleDeg: imp.angleDeg, azimuthDeg: az, point: d.point, dir, ...latLon(d.point) },
    entry: {
      outcome: e.outcome, topAltKm: topAlt, durationS: e.durationS, trace: e.trace, density: e.trace.map((t) => p.atmosphere.density(t[1])),
      breakupAltKm: e.breakupAltKm, burstAltKm: e.burstAltKm, peakDepositionAltKm: peakDep ?? null,
      initialEnergyJ: e.initialEnergyJ, atmosphereEnergyJ: e.atmosphereEnergyJ, groundEnergyJ: e.groundEnergyJ, groundSpeedKms: e.groundSpeedKms, groundMassKg: e.groundMassKg, spreadAtGround: e.spreadAtGround,
      maxDepositionJPerKm: maxDep,
    },
    effects: {
      outcome: e.outcome, energyMt: fx.energyMt, groundEnergyMt: fx.groundEnergyMt,
      crater: fx.crater ? { transientKm: fx.crater.transientM / 1000, finalKm: fx.crater.finalM / 1000, depthKm: fx.crater.depthM / 1000, morphology: fx.crater.morphology, material: fx.crater.material } : null,
      material: fx.material, oceanImpact: fx.oceanImpact, blastKm: fx.blastKm, thermalKm: fx.thermalKm, ejecta1mKm: fx.ejecta1mKm, ejecta10cmKm: fx.ejecta10cmKm,
      seismicMagnitude: fx.seismicMagnitude, seismicKm: seismicRadii(fx.seismicMagnitude, p.radiusKm), tsunami: fx.tsunami, plume: fx.plume,
      globalFatality: fx.globalFatality, orbitalEjectaKg: fx.orbitalEjectaKg, escapingEjectaKg: fx.escapingEjectaKg, maxRadiusKm: fx.maxRadiusKm, notes: fx.notes,
    },
    exposure: {
      mode: earth ? 'statistical-earth' : sites.length ? 'spatial' : 'none',
      deaths: m.applied?.deaths ?? ex.deaths, capitalLost: m.applied?.capitalLost ?? ex.capitalLost,
      popBefore: m.popBefore ?? 0, capitalBefore: m.capitalBefore ?? 0,
      sites, orbitalShare: m.orbitalShare ?? 0, orbitalLossFraction: ex.orbitalLossFraction,
      earth: earth ? { land: !!ex.land, urban: !!ex.urban, ocean: d.ocean } : null,
      note: earth ? TEXT.earthGeography : ex.note,
    },
    defense: m.defense ?? null, approach: null, averted: null,
    scale: { sceneRadius: 10, kmPerUnit: p.radiusKm / 10, legend: TEXT.marker },
    limitations: m.limitations ?? [],
    uncertainty: [
      m.representative && m.representative !== 'single' ? `One whole Monte Carlo draw (${m.representative}), not a set of confidence bounds: other draws differ in size, speed, angle and place.` : '',
      fx.tsunami ? 'Tsunami amplitudes are uncertain by about ×10.' : '',
      fx.plume ? 'Plume height and scar size are scaled from Shoemaker–Levy 9, uncertain by ×0.5–×2.' : '',
    ].filter(Boolean),
    banners: [...(m.banners ?? []), TEXT.notAtap],
  };
  return finish(v);
}

/** A deflected impactor: its original path, shown as a ghost, and a miss. Nothing of the would-be impact is drawn. */
export function asDeflection(v: VisualScenario): VisualScenario {
  const base: Omit<VisualScenario, 'render'> = {
    ...v, kind: 'deflection', id: `${v.id}:deflected`,
    averted: { outcome: v.effects.outcome, energyMt: v.effects.energyMt },
    exposure: { ...v.exposure, deaths: 0, capitalLost: 0, sites: v.exposure.sites.map((s) => ({ ...s, deaths: 0, capitalLost: 0, fatality: 0, capitalShare: 0 })), orbitalLossFraction: 0 },
    banners: [...v.banners, TEXT.deflection],
  };
  return finish(base);
}

export interface ApproachInput {
  body: BodyProfile; world: number; des: string; name: string; date: string; jd: number;
  distKm: number; distMinKm: number; distMaxKm: number; vRelKms: number; vInfKms: number | null; tSigma: string;
  diameterM: [number, number, number]; classification: Classification; snapshotId: string; horizons: boolean;
}

/** A catalogued close approach: a miss at the sourced nominal distance. Never an impact. */
export function visualCloseApproach(a: ApproachInput): VisualScenario {
  const seed = Math.floor(a.jd * 100) % 2147483647;
  // the closest point: seeded direction, sourced distance
  const u = hash01(seed, 1), w = hash01(seed, 2), z = 0.6 * (2 * u - 1), s = Math.sqrt(1 - z * z);
  const point: V3 = [s * Math.cos(2 * Math.PI * w), z, s * Math.sin(2 * Math.PI * w)];
  const { east, north } = tangentFrame(point), az = hash01(seed, 3) * Math.PI * 2;
  const dir = norm([north[0] * Math.cos(az) + east[0] * Math.sin(az), north[1] * Math.cos(az) + east[1] * Math.sin(az), north[2] * Math.cos(az) + east[2] * Math.sin(az)]);
  const p = a.body, D = Number.isFinite(a.diameterM[1]) ? a.diameterM[1] : NaN;
  const v: Omit<VisualScenario, 'render'> = {
    version: VISUAL_VERSION, id: `ca:${a.body.name}:${a.des}:${a.jd}`, kind: 'close-approach', classification: a.classification,
    source: { label: 'NASA/JPL Close Approach Data', organization: 'NASA/JPL SSD CAD API', url: 'https://ssd-api.jpl.nasa.gov/doc/cad.html', note: 'Nominal distance with minimum and maximum 3-sigma distances, relative velocity and time uncertainty.' },
    snapshotId: a.snapshotId, seed, draw: null, representative: null, representativeNote: '',
    body: { name: p.name, world: a.world, cls: p.cls, radiusKm: p.radiusKm, solidSurface: p.solidSurface, atmosphere: p.atmosphere.kind, p0Pa: p.atmosphere.p0Pa, scaleHeightKm: p.atmosphere.scaleHeightKm, rotationHours: p.rotationHours },
    when: { year: null, date: a.date, label: `${a.date} (TDB)` },
    object: { name: a.name, composition: 'unknown', diameterM: D, densityKgM3: NaN, strengthPa: null },
    trajectory: { sourced: false, label: a.horizons ? `${TEXT.schematic} (JPL Horizons vectors exist in the snapshot for this object, but the view keeps the CAD distance and a schematic plane.)` : TEXT.schematic, speedKms: a.vRelKms, vInfKms: a.vInfKms, angleDeg: 0, azimuthDeg: (az * 180) / Math.PI, point, dir, ...latLon(point) },
    entry: null,
    effects: { outcome: 'miss', energyMt: 0, groundEnergyMt: 0, crater: null, material: null, oceanImpact: false, blastKm: null, thermalKm: null, ejecta1mKm: null, ejecta10cmKm: null, seismicMagnitude: null, seismicKm: null, tsunami: null, plume: null, globalFatality: 0, orbitalEjectaKg: 0, escapingEjectaKg: 0, maxRadiusKm: 0, notes: [] },
    exposure: { mode: 'none', deaths: 0, capitalLost: 0, popBefore: 0, capitalBefore: 0, sites: [], orbitalShare: 0, orbitalLossFraction: 0, earth: null, note: 'A close approach does no damage.' },
    defense: null,
    approach: { nominalKm: a.distKm, minKm: a.distMinKm, maxKm: a.distMaxKm, vRelKms: a.vRelKms, vInfKms: a.vInfKms, timeSigma: a.tSigma, date: a.date, horizons: a.horizons },
    averted: null,
    scale: { sceneRadius: 10, kmPerUnit: p.radiusKm / 10, legend: TEXT.marker },
    limitations: ['Close-approach geometry is drawn in a schematic plane through the body’s centre; only the distance and speed are sourced.'],
    uncertainty: [`Nominal ${Math.round(a.distKm).toLocaleString('en-US')} km; 3-sigma ${Math.round(a.distMinKm).toLocaleString('en-US')}–${Math.round(a.distMaxKm).toLocaleString('en-US')} km.`],
    banners: [TEXT.closeApproach],
  };
  return finish(v);
}

/** The impact path: position (body frame, km from the centre) at slant distance s (km) before the contact point. */
export function pathPointKm(v: VisualScenario, sKm: number, out: V3 = [0, 0, 0]): V3 {
  const R = v.body.radiusKm, p = v.trajectory.point, d = v.trajectory.dir;
  out[0] = p[0] * R - d[0] * sKm; out[1] = p[1] * R - d[1] * sKm; out[2] = p[2] * R - d[2] * sKm;
  return out;
}

/** Slant distance (km) along the path for an altitude (km above the surface or 1-bar level): straight-line flight. */
export function slantOfAlt(v: VisualScenario, altKm: number): number {
  return altKm / Math.sin((Math.max(5, Math.min(90, v.trajectory.angleDeg)) * Math.PI) / 180);
}
