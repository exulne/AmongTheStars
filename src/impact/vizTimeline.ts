// The impact visualization's clock: which phases a scenario plays, how long
// each lasts in compressed visual time, and the state of every element at a
// visual time t. Everything is a pure function of (scenario, t), so playing,
// pausing and scrubbing backward or forward land on exactly the same frame;
// the renderer only reads the state. The entry phase is driven by the entry
// integration's own trace, mapped linearly in physical time.

import { pathPointKm, slantOfAlt, type RenderFlags, type VisualScenario } from './visual.ts';

/** Controller states; the scrubbable ones are those a timeline span can carry. */
export type Phase =
  | 'idle' | 'loading' | 'focusing'
  | 'approach' | 'entry' | 'breakup' | 'airburst' | 'contact' | 'deep-deposition' | 'excavation' | 'plume' | 'effects' | 'aftermath'
  | 'closest-pass' | 'departure' | 'deflection' | 'miss'
  | 'paused' | 'complete' | 'exiting';

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Idle', loading: 'Loading', focusing: 'Focusing on the planet', approach: 'Approach', entry: 'Atmospheric entry', breakup: 'Break-up',
  airburst: 'Airburst', contact: 'Surface contact', 'deep-deposition': 'Deep atmospheric deposition', excavation: 'Crater excavation', plume: 'Plume formation',
  effects: 'Expanding effects', aftermath: 'Aftermath', 'closest-pass': 'Closest pass', departure: 'Departure', deflection: 'Deflection', miss: 'Miss trajectory',
  paused: 'Paused', complete: 'Complete', exiting: 'Exiting',
};

export interface Span { phase: Phase; t0: number; t1: number }
export interface VizTimeline { spans: Span[]; duration: number; contactT: number | null; entry: { t0: number; t1: number; breakT: number | null } | null }

/** Visual seconds at 1× for each phase (documented in research/orbits-and-impacts.md). */
export const DUR = { approach: 4, entry: 3.5, breakup: 2, entryNoBreak: 4.5, airburst: 2.5, deep: 2.5, plume: 4.5, contact: 1.2, excavation: 3.5, effects: 5, aftermath: 4, caApproach: 5, caPass: 2.5, caDepart: 4, deflection: 2.5, miss: 4.5 } as const;

export function buildTimeline(v: VisualScenario): VizTimeline {
  const f = v.render, spans: Span[] = [];
  let t = 0;
  const add = (phase: Phase, d: number) => { spans.push({ phase, t0: t, t1: t + d }); t += d; };
  if (v.kind === 'close-approach') {
    add('approach', DUR.caApproach); add('closest-pass', DUR.caPass); add('departure', DUR.caDepart);
    return { spans, duration: t, contactT: null, entry: null };
  }
  if (v.kind === 'deflection') {
    add('approach', DUR.approach); add('deflection', DUR.deflection); add('miss', DUR.miss);
    return { spans, duration: t, contactT: null, entry: null };
  }
  add('approach', DUR.approach);
  let entry: VizTimeline['entry'] = null;
  if (f.atmosphereTrail) {
    const t0 = t;
    if (f.breakup) { add('entry', DUR.entry); add('breakup', DUR.breakup); entry = { t0, t1: t, breakT: t0 + DUR.entry }; }
    else { add('entry', DUR.entryNoBreak); entry = { t0, t1: t, breakT: null }; }
  }
  let contactT: number | null = null;
  if (f.deepDeposition) { add('deep-deposition', DUR.deep); if (f.plume) add('plume', DUR.plume); }
  else {
    if (f.airburst) add('airburst', DUR.airburst);
    if (f.surfaceContact) { contactT = t; add('contact', DUR.contact); if (f.crater) add('excavation', DUR.excavation); }
  }
  if (hasEffects(f)) add('effects', DUR.effects);
  add('aftermath', DUR.aftermath);
  return { spans, duration: t, contactT, entry };
}

const hasEffects = (f: RenderFlags) => f.blastRings || f.thermalRing || f.ejecta || f.seismicRing || f.tsunami || f.settlementOverlay || f.scar || f.orbitalRisk;

export function spanAt(tl: VizTimeline, t: number): { i: number; span: Span; k: number } {
  const x = Math.max(0, Math.min(tl.duration, t));
  let i = tl.spans.findIndex((s) => x < s.t1);
  if (i < 0) i = tl.spans.length - 1;
  const s = tl.spans[i];
  return { i, span: s, k: s.t1 > s.t0 ? Math.min(1, (x - s.t0) / (s.t1 - s.t0)) : 1 };
}

export const smooth = (x: number) => { const k = Math.max(0, Math.min(1, x)); return k * k * (3 - 2 * k); };
const easeOut = (x: number) => 1 - (1 - Math.max(0, Math.min(1, x))) ** 3;

/** Everything drawn at one instant. Distances in km, positions in the body frame (km from the centre). */
export interface VizState {
  t: number; phase: Phase; k: number;
  obj: { visible: boolean; pos: [number, number, number]; altKm: number; speedKms: number; massFrac: number; spread: number; heat: number; broken: boolean };
  /** physical seconds since the top of the atmosphere (entry only) */
  physS: number;
  /** share of the trace drawn as the trail */
  trailK: number;
  flash: number; burst: number; shockKm: number; frontKm: number;
  craterKm: number; craterAmp: number; ejectaK: number;
  plumeKm: number; plumeSpread: number; scarK: number;
  tsunamiKm: number; seismicKm: number;
  /** close approach / deflection */
  caAlongKm: number; caDistKm: number; ghostK: number; missK: number;
}

export function emptyState(): VizState {
  return { t: 0, phase: 'approach', k: 0, obj: { visible: false, pos: [0, 0, 0], altKm: 0, speedKms: 0, massFrac: 1, spread: 1, heat: 0, broken: false }, physS: 0, trailK: 0, flash: 0, burst: 0, shockKm: 0, frontKm: 0, craterKm: 0, craterAmp: 0, ejectaK: 0, plumeKm: 0, plumeSpread: 0, scarK: 0, tsunamiKm: 0, seismicKm: 0, caAlongKm: 0, caDistKm: 0, ghostK: 0, missK: 0 };
}

/** How far out (km of slant path) the approach starts: a little over one body radius above the top of the air. */
export const approachKm = (v: VisualScenario) => v.body.radiusKm * 1.2;

/** Close approach: the half-length of the drawn pass (km), and where the closest point sits (km from the centre). */
export const caHalfKm = (v: VisualScenario) => Math.max(v.approach!.nominalKm * 2.5, v.body.radiusKm * 8);

/** Largest ground radius any shown effect reaches (km). */
export function maxEffectKm(v: VisualScenario): number {
  const fx = v.effects, f = v.render;
  return Math.max(0,
    f.blastRings ? fx.blastKm!.kPa7 : 0, f.thermalRing ? fx.thermalKm! : 0, f.ejecta ? (fx.ejecta10cmKm ?? fx.ejecta1mKm ?? 0) : 0,
    f.tsunami ? fx.tsunami!.radius1mKm : 0, f.seismicRing ? fx.seismicKm!.m65 : 0, f.crater ? fx.crater!.finalKm / 2 : 0,
    f.scar ? fx.plume!.scarDiameterKm[1] / 2 : 0);
}

/** The ground radius the expanding front reaches during the effects phase (km): every ring stops at its own reported radius. */
const frontAt = (v: VisualScenario, k: number) => maxEffectKm(v) * easeOut(k);

/** Trace sample at physical time s (linear interpolation between recorded points). */
function traceAt(v: VisualScenario, s: number, out: VizState): void {
  const tr = v.entry!.trace, o = out.obj;
  let i = 0;
  while (i < tr.length - 2 && tr[i + 1][0] < s) i++;
  const a = tr[i], b = tr[Math.min(tr.length - 1, i + 1)], f = b[0] > a[0] ? Math.max(0, Math.min(1, (s - a[0]) / (b[0] - a[0]))) : 1;
  const L = (j: number) => a[j] + (b[j] - a[j]) * f;
  o.altKm = L(1); o.speedKms = L(2); o.massFrac = L(3); o.spread = L(4);
  const peak = v.entry!.maxDepositionJPerKm || 1;
  o.heat = Math.min(1, Math.sqrt(Math.max(0, L(5)) / peak));
  o.broken = v.entry!.breakupAltKm !== null && o.altKm <= v.entry!.breakupAltKm;
}

/** Visual time → physical time along the trace: piecewise linear, break-up at its own span boundary. */
function physOf(v: VisualScenario, tl: VizTimeline, t: number): number {
  const e = tl.entry!, tr = v.entry!.trace, T = tr[tr.length - 1][0];
  if (e.breakT === null) return T * Math.max(0, Math.min(1, (t - e.t0) / (e.t1 - e.t0)));
  let tb = T;
  for (const p of tr) if (p[1] <= v.entry!.breakupAltKm!) { tb = p[0]; break; }
  if (t < e.breakT) return tb * Math.max(0, (t - e.t0) / (e.breakT - e.t0));
  return tb + (T - tb) * Math.min(1, (t - e.breakT) / (e.t1 - e.breakT));
}

/** The state at visual time t. Pure: the same (v, tl, t) always gives the same state. */
export function sampleAt(v: VisualScenario, tl: VizTimeline, t: number, out: VizState = emptyState()): VizState {
  const { span, k } = spanAt(tl, t), f = v.render, o = out.obj, R = v.body.radiusKm;
  const x = Math.max(0, Math.min(tl.duration, t));
  out.t = x; out.phase = span.phase; out.k = k;
  out.flash = 0; out.burst = 0; out.shockKm = 0; out.frontKm = 0; out.craterKm = 0; out.craterAmp = 0; out.ejectaK = 0;
  out.plumeKm = 0; out.plumeSpread = 0; out.scarK = 0; out.tsunamiKm = 0; out.seismicKm = 0; out.trailK = 0; out.physS = 0;
  out.caAlongKm = 0; out.caDistKm = 0; out.ghostK = 0; out.missK = 0;
  o.visible = false; o.heat = 0; o.broken = false; o.massFrac = 1; o.spread = 1; o.speedKms = v.trajectory.speedKms;
  const at = (p: Phase) => tl.spans.find((s) => s.phase === p);
  const prog = (p: Phase) => { const s = at(p); return s ? Math.max(0, Math.min(1, (x - s.t0) / (s.t1 - s.t0))) : 0; };

  if (v.kind === 'close-approach') {
    const L = caHalfKm(v), a = at('approach')!, c = at('closest-pass')!;
    const along = x < a.t1 ? -L + (L * 0.85) * prog('approach') : x < c.t1 ? -0.15 * L + 0.3 * L * prog('closest-pass') : 0.15 * L + 0.85 * L * prog('departure');
    out.caAlongKm = along; out.caDistKm = Math.hypot(v.approach!.nominalKm, along);
    const p = v.trajectory.point, d = v.trajectory.dir, D = v.approach!.nominalKm;
    o.visible = true; o.pos[0] = p[0] * D + d[0] * along; o.pos[1] = p[1] * D + d[1] * along; o.pos[2] = p[2] * D + d[2] * along;
    o.altKm = out.caDistKm - R; o.speedKms = v.approach!.vRelKms;
    return out;
  }

  const top = v.entry && v.entry.trace.length ? v.entry.topAltKm : 0;
  const s0 = slantOfAlt(v, Math.max(top, 0)) + approachKm(v), sTop = slantOfAlt(v, Math.max(top, 0));

  if (v.kind === 'deflection') {
    out.ghostK = Math.min(1, x / at('approach')!.t1);
    const sDef = sTop + approachKm(v) * 0.25;
    if (x < at('approach')!.t1) { pathPointKm(v, s0 - (s0 - sDef) * prog('approach'), o.pos); o.visible = true; }
    else {
      // illustrative: from the deflection point along a tangent that clears the body by half a radius
      const k2 = x < at('deflection')!.t1 ? 0.25 * prog('deflection') : 0.25 + 0.75 * prog('miss');
      missPoint(v, sDef, k2, o.pos); o.visible = true; out.missK = k2;
    }
    o.altKm = Math.hypot(o.pos[0], o.pos[1], o.pos[2]) - R;
    return out;
  }

  // ---- impact
  const ap = at('approach')!;
  if (x < ap.t1) {
    o.visible = true;
    pathPointKm(v, s0 - (s0 - sTop) * prog('approach'), o.pos);
    o.altKm = Math.hypot(o.pos[0], o.pos[1], o.pos[2]) - R;
    return finishImpact(v, tl, x, out);
  }
  if (tl.entry && x < tl.entry.t1) {
    out.physS = physOf(v, tl, x);
    traceAt(v, out.physS, out);
    pathPointKm(v, slantOfAlt(v, o.altKm), o.pos);
    o.visible = true;
    const tr = v.entry!.trace;
    out.trailK = tr.length > 1 ? Math.min(1, out.physS / tr[tr.length - 1][0]) : 0;
    return finishImpact(v, tl, x, out);
  }
  // after entry (or directly at contact on an airless body)
  out.trailK = tl.entry ? 1 : 0;
  if (v.entry && v.entry.trace.length) {
    const last = v.entry.trace[v.entry.trace.length - 1];
    o.altKm = last[1]; o.speedKms = last[2]; o.massFrac = last[3]; o.spread = last[4]; o.broken = v.entry.breakupAltKm !== null;
    out.physS = last[0];
  } else { o.altKm = 0; o.speedKms = v.trajectory.speedKms; }
  // a body braked to a slow fall settles to the ground with what survived; nothing else carries on past the burst
  if (f.survivingMass) {
    const k2 = Math.min(1, (x - (tl.entry?.t1 ?? ap.t1)) / DUR.aftermath);
    o.visible = k2 < 1; o.altKm = o.altKm * (1 - smooth(k2)); o.speedKms = Math.min(o.speedKms, 0.3); o.heat = 0;
  }
  pathPointKm(v, slantOfAlt(v, o.altKm), o.pos);
  return finishImpact(v, tl, x, out);
}

function finishImpact(v: VisualScenario, tl: VizTimeline, x: number, out: VizState): VizState {
  const f = v.render, fx = v.effects;
  const at = (p: Phase) => tl.spans.find((s) => s.phase === p);
  const prog = (p: Phase) => { const s = at(p); return s ? Math.max(0, Math.min(1, (x - s.t0) / (s.t1 - s.t0))) : 0; };
  const past = (p: Phase) => { const s = at(p); return !!s && x >= s.t0; };
  if (f.airburst && past('airburst')) {
    const k = prog('airburst');
    out.burst = k; out.flash = Math.max(out.flash, Math.exp(-k * 4) * (k > 0 ? 1 : 0));
    out.shockKm = (fx.blastKm?.kPa7 ?? 0) * easeOut(k) * 0.35;
  }
  if (f.deepDeposition && past('deep-deposition')) { const k = prog('deep-deposition'); out.flash = Math.max(out.flash, Math.exp(-k * 3)); out.burst = k; }
  if (f.surfaceContact && past('contact')) { const k = prog('contact'); out.flash = Math.max(out.flash, Math.exp(-k * 3.5)); }
  if (f.crater && past('contact')) {
    const c = fx.crater!, k = at('excavation') ? prog('excavation') : 1;
    // the transient bowl opens, then relaxes and widens to the final crater
    out.craterKm = k < 0.6 ? c.transientKm * easeOut(k / 0.6) : c.transientKm + (c.finalKm - c.transientKm) * smooth((k - 0.6) / 0.4);
    out.craterAmp = Math.min(1, 0.4 + k);
    out.ejectaK = Math.min(1, (x - at('contact')!.t0) / (DUR.contact + DUR.excavation + DUR.effects * 0.6));
  }
  if (f.plume && past('plume')) {
    const k = prog('plume'), H = fx.plume!.plumeHeightKm[1];
    out.plumeKm = k < 0.55 ? H * easeOut(k / 0.55) : H * (1 - 0.35 * smooth((k - 0.55) / 0.45));
    out.plumeSpread = smooth((k - 0.45) / 0.55);
    if (f.scar) out.scarK = smooth((k - 0.5) / 0.5);
  }
  if (at('effects') && past('effects')) {
    const k = prog('effects');
    out.frontKm = frontAt(v, k);
    if (f.airburst && fx.blastKm) out.shockKm = Math.max(out.shockKm, fx.blastKm.kPa7 * (0.35 + 0.65 * easeOut(k)));
    if (f.tsunami) out.tsunamiKm = fx.tsunami!.radius1mKm * smooth(k);
    if (f.seismicRing) out.seismicKm = fx.seismicKm!.m65 * easeOut(Math.min(1, k * 2.2));
  }
  if (past('aftermath')) {
    out.frontKm = maxEffectKm(v); out.shockKm = 0;
    if (f.tsunami) out.tsunamiKm = fx.tsunami!.radius1mKm;
    if (f.seismicRing) out.seismicKm = 0;
    if (f.scar) out.scarK = 1 - 0.55 * prog('aftermath'); // fading over its modelled duration, compressed
    if (f.crater) { out.craterKm = fx.crater!.finalKm; out.craterAmp = 1; }
  }
  return out;
}

/** Deflected path: from the deflection point, a tangent line clearing the body by half a radius (illustrative). k: 0..1 of its length. */
export function missPoint(v: VisualScenario, sDef: number, k: number, out: [number, number, number]): [number, number, number] {
  const R = v.body.radiusKm, P = pathPointKm(v, sDef, [0, 0, 0]), r = Math.hypot(P[0], P[1], P[2]);
  const d = v.trajectory.dir, Dm = Math.min(r * 0.95, R * 1.5);
  // w: the part of the travel direction perpendicular to P, unit
  const pu = [P[0] / r, P[1] / r, P[2] / r], dp = d[0] * pu[0] + d[1] * pu[1] + d[2] * pu[2];
  let w = [d[0] - dp * pu[0], d[1] - dp * pu[1], d[2] - dp * pu[2]];
  const wl = Math.hypot(w[0], w[1], w[2]) || 1; w = w.map((c) => c / wl);
  const sb = Dm / r, cb = Math.sqrt(1 - sb * sb), len = r * cb * 2.4;
  const dir = [-pu[0] * cb + w[0] * sb, -pu[1] * cb + w[1] * sb, -pu[2] * cb + w[2] * sb];
  out[0] = P[0] + dir[0] * len * k; out[1] = P[1] + dir[1] * len * k; out[2] = P[2] + dir[2] * len * k;
  return out;
}

export type CameraMode = 'auto' | 'overview' | 'follow' | 'side' | 'ground' | 'cutaway' | 'aftermath';
export const CAMERA_LABEL: Record<CameraMode, string> = { auto: 'Directed', overview: 'Planet overview', follow: 'Follow impactor', side: 'Side-on entry', ground: 'Ground-zero orbit', cutaway: 'Atmosphere cutaway', aftermath: 'Aftermath overview' };

/** The directed camera for a phase. Reduced motion never chases the impactor. */
export function autoCamera(v: VisualScenario, phase: Phase, reduced: boolean): Exclude<CameraMode, 'auto'> {
  if (v.kind === 'close-approach' || v.kind === 'deflection') return 'overview';
  if (phase === 'approach') return reduced ? 'side' : 'follow';
  if (phase === 'entry' || phase === 'breakup') return v.render.cloudCutaway || v.render.oneBarShell ? 'cutaway' : 'side';
  if (phase === 'deep-deposition' || phase === 'plume') return 'cutaway';
  if (phase === 'effects' || phase === 'aftermath') return 'aftermath';
  return 'ground';
}

/** Resolve a requested mode under reduced motion: no chase camera. */
export const safeCamera = (m: Exclude<CameraMode, 'auto'>, reduced: boolean): Exclude<CameraMode, 'auto'> => (reduced && m === 'follow' ? 'side' : m);

/** Light left at each simulated settlement once the expanding front has reached it (1 = untouched). Earth: none are touched. */
export function siteShade(v: VisualScenario, s: VizState, out: number[] = []): number[] {
  out.length = v.exposure.sites.length;
  v.exposure.sites.forEach((site, i) => {
    const hit = s.frontKm >= site.distanceKm - site.radiusKm;
    out[i] = hit ? 1 - Math.min(0.92, Math.max(site.fatality, site.capitalShare)) : 1;
  });
  return out;
}

/** Flash strength allowed on screen: reduced motion caps it and never flickers. */
export const flashLimit = (x: number, reduced: boolean) => (reduced ? Math.min(0.35, x * 0.35) : x);
/** Screen shake: only when asked for, never under reduced motion, and only for a solid-surface contact. */
export const shakeAmount = (v: VisualScenario, s: VizState, enabled: boolean, reduced: boolean) => (!enabled || reduced || !v.render.surfaceContact || s.phase !== 'contact' ? 0 : 0.02 * Math.exp(-s.k * 5));

/** The persistent-scar style marks this visualization adds for the moment (body frame; the shader's scar format). */
export function transientScars(v: VisualScenario, s: VizState): { x: number; y: number; z: number; rad: number; kind: number; amp: number }[] {
  const p = v.trajectory.point, R = v.body.radiusKm, out: { x: number; y: number; z: number; rad: number; kind: number; amp: number }[] = [];
  if (v.render.crater && s.craterKm > 0) out.push({ x: p[0], y: p[1], z: p[2], rad: s.craterKm / 2 / R, kind: 0, amp: s.craterAmp });
  if (v.render.scar && s.scarK > 0) out.push({ x: p[0], y: p[1], z: p[2], rad: v.effects.plume!.scarDiameterKm[1] / 2 / R, kind: 2, amp: s.scarK });
  return out;
}
