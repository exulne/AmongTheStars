// The impact visualization's playback overlay on the 3D view: play, pause,
// replay, exit, a deterministic scrubber, speed, camera mode, overlay toggles,
// the phase, scientific telemetry, an altitude gauge and a compact consequence
// summary, with every label that says what is sourced, hypothetical, simulated,
// statistical or enlarged. It drives the ImpactDirector and reads it back.

import { classBadge } from '../data/provenance.ts';
import type { TracePoint } from '../impact/entry.ts';
import { TEXT, type Representative, type VisualScenario } from '../impact/visual.ts';
import { CAMERA_LABEL, PHASE_LABEL, type CameraMode } from '../impact/vizTimeline.ts';
import type { ImpactDirector, Toggles } from '../view/impactDirector.ts';
import { esc } from './dataPanel.ts';
import { fmtNum } from './format.ts';
import './impactPlayer.css';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const km = (x: number) => (!Number.isFinite(x) ? '—' : Math.abs(x) >= 1e6 ? `${(x / 1e6).toPrecision(3)} million km` : Math.abs(x) >= 100 ? `${fmtNum(Math.round(x))} km` : Math.abs(x) >= 1 ? `${x.toFixed(1)} km` : `${Math.round(x * 1000)} m`);
const mt = (x: number) => (!Number.isFinite(x) ? '—' : x >= 1 ? `${fmtNum(x)} Mt` : `${fmtNum(x * 1000)} kt`);

export class ImpactPlayer {
  el: HTMLElement;
  private d: ImpactDirector;
  private alts: Partial<Record<Representative, VisualScenario>> | null = null;
  private key = '';
  private tick = 0;
  private reduced: () => boolean;

  constructor(d: ImpactDirector, reduced: () => boolean) {
    this.d = d; this.reduced = reduced;
    this.el = document.createElement('section');
    this.el.className = 'ivz';
    this.el.hidden = true;
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Impact visualization');
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('change', (e) => this.change(e));
    this.el.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.dataset.ctl === 'scrub') this.d.seek((Number(t.value) / 1000) * this.d.duration); });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.d.exit(); }
      else if (e.key === 'k' || (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON')) { e.preventDefault(); this.d.toggle(); }
    });
  }

  /** Lab representatives the reader can switch between (one whole draw each). */
  setAlternates(a: Partial<Record<Representative, VisualScenario>> | null): void { this.alts = a; this.key = ''; }

  /** Rebuild when the scenario, status or a setting changes; cheap per-frame values come from frame(). */
  render(): void {
    const d = this.d, v = d.v;
    this.el.hidden = !d.active;
    if (!d.active) { this.key = ''; return; }
    const key = `${d.status}|${v?.id}|${d.camera}|${d.free}|${d.speed}|${JSON.stringify(d.toggles)}|${d.phase}|${d.quality}|${d.error}`;
    if (key === this.key) return;
    this.key = key;
    if (!v) { this.el.innerHTML = `<p class="ivz-status" aria-live="polite">${d.status === 'loading' ? 'Computing the scenario…' : esc(d.error || 'Preparing…')}</p><div class="ivz-row"><button class="link" type="button" data-act="exit">Exit visualization</button></div>`; return; }
    const playing = d.status === 'playing', reduced = this.reduced();
    const rep = v.representative && v.representative !== 'single' && this.alts ? `<label>Representative draw <select data-ctl="rep">${(['low', 'nominal', 'high'] as const).filter((r) => this.alts![r]).map((r) => `<option value="${r}"${r === v.representative ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` : '';
    const tog = (k: keyof Toggles, label: string, dis = false, title = '') => `<label${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" data-tog="${k}"${d.toggles[k] ? ' checked' : ''}${dis ? ' disabled' : ''}> ${esc(label)}</label>`;
    const cams = (Object.keys(CAMERA_LABEL) as CameraMode[]).filter((c) => !(reduced && c === 'follow') && (v.kind === 'impact' || c === 'auto' || c === 'overview'));
    this.el.innerHTML = `
      <header class="ivz-head">
        <div><strong>${esc(v.object.name)}</strong> · ${esc(v.body.name)} ${classBadge(v.classification)}<br><span class="muted">${esc(v.kind === 'close-approach' ? 'Close approach (a miss)' : v.kind === 'deflection' ? 'Averted impact' : v.source.label)} · ${esc(v.when.label)}</span></div>
        <p class="ivz-phase" aria-live="polite">${esc(d.status === 'focusing' ? PHASE_LABEL.focusing : d.status === 'complete' ? PHASE_LABEL.complete : d.status === 'paused' ? `${PHASE_LABEL.paused}: ${PHASE_LABEL[d.state.phase]}` : PHASE_LABEL[d.state.phase])}</p>
      </header>
      <ul class="ivz-banners">${v.banners.map((b) => `<li>${esc(b)}</li>`).join('')}${v.representativeNote ? `<li>${esc(v.representativeNote)}</li>` : ''}</ul>
      <div class="ivz-row ivz-ctl">
        <button class="link" type="button" data-act="toggle" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? 'Pause' : 'Play'}</button>
        <button class="link" type="button" data-act="replay">${v.classification === 'simulated' ? (v.kind === 'deflection' ? 'Replay deflection' : 'Replay event') : 'Replay'}</button>
        <button class="link" type="button" data-act="skip">Skip to aftermath</button>
        <button class="link" type="button" data-act="exit">Exit visualization</button>
      </div>
      <div class="ivz-row"><input type="range" min="0" max="1000" step="1" data-ctl="scrub" aria-label="Visualization time" value="0"><span class="ivz-time num"></span></div>
      <div class="ivz-row">
        <label>Speed <select data-ctl="speed">${SPEEDS.map((s) => `<option value="${s}"${s === d.speed ? ' selected' : ''}>${s}×</option>`).join('')}</select></label>
        <label>Camera <select data-ctl="cam">${cams.map((c) => `<option value="${c}"${c === d.camera ? ' selected' : ''}>${esc(CAMERA_LABEL[c])}</option>`).join('')}</select></label>
        ${d.free ? '<button class="link" type="button" data-act="directed" title="You moved the view: the directed camera is paused">Directed camera</button>' : ''}
        ${rep}
      </div>
      <div class="ivz-row ivz-tog">
        ${tog('overlays', 'Effect overlays')}${tog('uncertainty', 'Uncertainty')}${tog('telemetry', 'Telemetry')}
        ${tog('enhanced', 'Visibility-enhanced scale', false, 'Draw features too small to see at a minimum size, dashed and labelled. Off: every ring and crater at its reported radius.')}
        ${v.render.cloudCutaway || v.render.oneBarShell ? tog('cutaway', 'Atmosphere cutaway', false, 'A visualization aid: see beneath the clouds') : ''}
        ${tog('shake', 'Screen shake', reduced, reduced ? 'Off under reduced motion' : 'A little shake at surface contact')}
      </div>
      ${d.toggles.telemetry ? `<div class="ivz-tele"><dl class="ivz-dl"></dl><svg class="ivz-gauge" viewBox="0 0 70 150" role="img" aria-label="Altitude gauge"></svg></div>` : ''}
      <div class="ivz-cons">${this.consequences(v)}</div>
      <p class="ivz-legend muted">${esc(TEXT.marker)} ${v.kind === 'impact' ? esc(TEXT.particles) : ''} ${esc(TEXT.time)}${d.toggles.enhanced ? ' Visibility-enhanced scale is on: dashed rings are drawn larger than reported.' : ' Scientific scale: rings and craters at the reported radii.'}${d.quality === 'low' ? ' Simplified mode: fewer symbolic particles.' : ''}</p>`;
    this.frame(true);
  }

  private consequences(v: VisualScenario): string {
    const fx = v.effects, ex = v.exposure, out: string[] = [];
    if (v.kind === 'close-approach') {
      const a = v.approach!;
      return `<dl class="ivz-dl"><dt>Nominal miss</dt><dd>${km(a.nominalKm)} (${fmtNum(a.nominalKm / v.body.radiusKm)} ${esc(v.body.name)} radii)</dd><dt>3σ distance</dt><dd>${km(a.minKm)} – ${km(a.maxKm)}</dd><dt>v_rel</dt><dd>${a.vRelKms.toFixed(2)} km/s</dd><dt>Time 3σ</dt><dd>${esc(a.timeSigma || '—')}</dd></dl><p class="muted">${esc(v.trajectory.label)}</p>`;
    }
    if (v.kind === 'deflection') {
      const df = v.defense;
      return `<dl class="ivz-dl"><dt>Status</dt><dd>Deflected: no impact, no damage</dd>${df ? `<dt>Warning</dt><dd>${df.warningYears.toFixed(0)} years</dd>` : ''}${v.averted ? `<dt>Would have been</dt><dd>${esc(v.averted.outcome)}, ${mt(v.averted.energyMt)}</dd>` : ''}</dl>`;
    }
    out.push(`<dt>Outcome</dt><dd>${esc(fx.outcome)} · ${mt(fx.energyMt)}</dd>`);
    if (fx.crater) out.push(`<dt>Crater</dt><dd>${km(fx.crater.finalKm)} final (${esc(fx.crater.morphology)}, ${esc(fx.crater.material)}), transient ${km(fx.crater.transientKm)}</dd>`);
    if (v.entry?.burstAltKm != null && fx.outcome !== 'ground-impact') out.push(`<dt>${v.body.solidSurface ? 'Burst altitude' : 'Peak deposition'}</dt><dd>${km(v.entry.burstAltKm)}${v.body.solidSurface ? '' : ' (rel. 1 bar)'}</dd>`);
    if (fx.blastKm && fx.blastKm.kPa7 > 0) out.push(`<dt>Blast</dt><dd>7 kPa ${km(fx.blastKm.kPa7)} · 21 kPa ${km(fx.blastKm.kPa21)} · 69 kPa ${km(fx.blastKm.kPa69)}</dd>`);
    if (fx.thermalKm) out.push(`<dt>Thermal</dt><dd>${km(fx.thermalKm)}</dd>`);
    if (fx.tsunami) out.push(`<dt>Tsunami</dt><dd>≥ 3 m to ${km(fx.tsunami.radius3mKm)}, ≥ 1 m to ${km(fx.tsunami.radius1mKm)} (×10 uncertain)</dd>`);
    if (fx.seismicMagnitude !== null) out.push(`<dt>Seismic</dt><dd>magnitude ${fx.seismicMagnitude.toFixed(1)} equivalent</dd>`);
    if (fx.plume) out.push(`<dt>Plume · scar</dt><dd>${km(fx.plume.plumeHeightKm[1])} · ${km(fx.plume.scarDiameterKm[1])} across, ≈ ${fmtNum(fx.plume.durationDays[1])} days</dd>`);
    if (fx.orbitalEjectaKg + fx.escapingEjectaKg > 0) out.push(`<dt>Orbital risk</dt><dd>${(fx.orbitalEjectaKg + fx.escapingEjectaKg).toExponential(1)} kg ejecta above orbital speed${ex.orbitalLossFraction ? `; ${(ex.orbitalLossFraction * 100).toFixed(2)}% of habitats hit` : ''}</dd>`);
    if (ex.mode === 'statistical-earth') {
      const e = ex.earth!;
      out.push(`<dt>Statistical exposure</dt><dd>${fmtNum(ex.deaths)} deaths · $${fmtNum(ex.capitalLost)} <span class="muted">(sample: ${e.ocean ? 'ocean' : e.urban ? 'land, urban' : 'land, rural'})</span></dd>`);
    } else if (ex.mode === 'spatial') {
      const hit = ex.sites.filter((s) => s.deaths > 0 || s.capitalLost > 0).length;
      out.push(`<dt>Settlements</dt><dd>${fmtNum(ex.deaths)} deaths · $${fmtNum(ex.capitalLost)} · ${hit} of ${ex.sites.length} sites affected</dd>`);
    } else if (!v.body.solidSurface) out.push('<dt>Ground casualties</dt><dd>none computed: no surface</dd>');
    else out.push(`<dt>People</dt><dd>${v.classification === 'historical' ? 'historical losses are in the observed record, not modelled here' : 'no simulated settlement in range'}</dd>`);
    if (v.defense) out.push(`<dt>Warning</dt><dd>${esc(v.defense.note)}</dd>`);
    if (fx.globalFatality > 0) out.push(`<dt>Global</dt><dd>dust and climate: ${(fx.globalFatality * 100).toFixed(1)}% of people</dd>`);
    return `<dl class="ivz-dl">${out.join('')}</dl>${v.uncertainty.length && this.d.toggles.uncertainty ? `<p class="muted">${esc(v.uncertainty.join(' '))}</p>` : ''}`;
  }

  /** Per-frame values: time, scrubber, telemetry, gauge. */
  frame(force = false): void {
    const d = this.d, v = d.v;
    if (!d.active || !v || this.el.hidden) return;
    if (!force && this.tick++ % 3) return;
    const s = d.state;
    const scrub = this.el.querySelector<HTMLInputElement>('[data-ctl="scrub"]');
    if (scrub && document.activeElement !== scrub) scrub.value = String(Math.round((d.t / Math.max(1e-6, d.duration)) * 1000));
    const time = this.el.querySelector('.ivz-time');
    if (time) time.textContent = `${d.t.toFixed(1)} / ${d.duration.toFixed(1)} s visual${s.physS > 0 ? ` · ${s.physS.toFixed(1)} s after entry` : ''}`;
    const dl = this.el.querySelector('.ivz-tele .ivz-dl');
    if (!dl) return;
    const rows: [string, string][] = [];
    const giant = !v.body.solidSurface;
    if (v.kind === 'close-approach') rows.push(['Distance', km(s.caDistKm)], ['Nominal', km(v.approach!.nominalKm)], ['Speed', `${v.approach!.vRelKms.toFixed(2)} km/s`]);
    else {
      // once the impactor is consumed (burst, contact, deposition) there is nothing left to report a position for
      if (s.obj.visible) rows.push([giant ? 'Altitude (rel. 1 bar)' : 'Altitude', km(s.obj.altKm)], ['Speed', `${s.obj.speedKms.toFixed(2)} km/s`]);
      else rows.push(['Impactor', v.kind === 'deflection' ? 'past the body' : 'consumed']);
      const e = v.entry;
      if (e && e.trace.length && (s.phase === 'entry' || s.phase === 'breakup')) {
        const i = traceIndex(e.trace, s.physS), rho = e.density[i] ?? 0, dep = e.trace[i]?.[5] ?? 0;
        rows.push(['Air density', `${rho.toExponential(2)} kg/m³`], ['Energy deposited', `${(dep / 4.184e12).toPrecision(3)} kt/km`], ['Mass left', `${(s.obj.massFrac * 100).toFixed(1)}%`], ['Fragment cloud', s.obj.broken ? `${s.obj.spread.toFixed(1)}× initial radius` : 'intact'], ['Heating', s.obj.heat > 0.66 ? 'intense' : s.obj.heat > 0.25 ? 'strong' : s.obj.heat > 0.02 ? 'rising' : 'none yet']);
      } else if (s.phase === 'approach' && v.body.atmosphere === 'none') rows.push(['Atmosphere', 'none: no trail, no airburst']);
      if (s.craterKm > 0) rows.push(['Crater now', km(s.craterKm)]);
      if (s.frontKm > 0 && s.phase === 'effects') rows.push(['Effects front', km(s.frontKm)]);
      if (s.shockKm > 0) rows.push(['Shock', km(s.shockKm)]);
      if (s.tsunamiKm > 0) rows.push(['Wavefront', km(s.tsunamiKm)]);
      if (s.plumeKm > 0) rows.push(['Plume', km(s.plumeKm)]);
      if (v.kind === 'deflection') rows.push(['Course', s.missK > 0 ? 'deflected (illustrative)' : 'original']);
    }
    rows.push(['Visual angle', v.kind === 'impact' ? `${v.trajectory.angleDeg.toFixed(0)}° from horizontal` : '—']);
    dl.innerHTML = rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd class="num">${esc(b)}</dd>`).join('');
    this.gauge(v, s.obj.altKm);
  }

  private gauge(v: VisualScenario, alt: number): void {
    const g = this.el.querySelector('.ivz-gauge');
    if (!g || v.kind === 'close-approach') { if (g) g.innerHTML = ''; return; }
    const e = v.entry, top = Math.max(e?.topAltKm ?? 100, 50), bottom = v.body.solidSurface ? 0 : Math.min(0, (v.effects.plume?.depositionAltKm ?? 0) * 1.3, ...(e?.trace.map((t) => t[1]) ?? [0]));
    const y = (h: number) => 10 + ((top - h) / (top - bottom || 1)) * 130;
    const tick = (h: number | null | undefined, label: string, col: string) => (h == null ? '' : `<line x1="18" x2="30" y1="${y(h)}" y2="${y(h)}" stroke="${col}"/><text x="32" y="${y(h) + 3}" fill="${col}">${esc(label)}</text>`);
    g.innerHTML = `<line x1="24" x2="24" y1="10" y2="140" stroke="var(--rule)"/>
      ${tick(0, v.body.solidSurface ? 'surface' : '1 bar', '#9aa4b2')}
      ${tick(e?.breakupAltKm, 'break-up', '#ffc58a')}
      ${tick(e?.burstAltKm, v.body.solidSurface ? 'burst' : 'peak', '#ff8a5c')}
      <circle cx="24" cy="${Math.max(10, Math.min(140, y(alt)))}" r="3.5" fill="#f2efe8"/>
      <text x="2" y="8" fill="var(--quiet)">${Math.round(top)} km</text>`;
  }

  private click(e: Event): void {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act, d = this.d;
    if (act === 'toggle') d.toggle();
    else if (act === 'replay') d.replayFromStart();
    else if (act === 'skip') d.skipToAftermath();
    else if (act === 'exit') d.exit();
    else if (act === 'directed') d.directed();
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement, d = this.d;
    if (t.dataset.tog) d.setToggle(t.dataset.tog as keyof Toggles, t.checked);
    else if (t.dataset.ctl === 'speed') d.setSpeed(Number(t.value));
    else if (t.dataset.ctl === 'cam') d.setCamera(t.value as CameraMode);
    else if (t.dataset.ctl === 'rep') { const alt = this.alts?.[t.value as Representative]; if (alt) d.start(alt); }
  }
}

function traceIndex(tr: TracePoint[], s: number): number {
  let i = 0;
  while (i < tr.length - 1 && tr[i + 1][0] <= s) i++;
  return i;
}
