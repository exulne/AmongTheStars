// "Impact Lab": Solar System Close Approach & Impact Scenario Lab. Per body:
// its environment profile, observed historical impacts, catalogued close
// approaches (JPL CAD) kept apart from official impact probabilities (Earth:
// JPL Sentry; elsewhere only a named published assessment), hypothetical
// scenarios through the body-specific pipeline, and the impacts this future
// simulated. A close approach is never turned into a probability here.

import { CLASS_STYLE, DISCLAIMER, classBadge } from '../data/provenance.ts';
import { HORIZONS, SNAPSHOT_ID, SENTRY } from '../data/snapshot.ts';
import { BODIES, REQUIRED_BODIES, PROFILE_VERSION, FACT_SHEET } from '../impact/bodies.ts';
import { AU_KM, NO_OFFICIAL, OFFICIAL_NON_EARTH, SENTRY_NOTE, approaches, officialFor, sentryRisks, type Approach } from '../impact/catalog.ts';
import { IC, IF, KINDS, NIC, OUTCOMES } from '../impact/engineImpacts.ts';
import { NO_OBSERVED, OBSERVED_IMPACTS } from '../impact/history.ts';
import { impactRate } from '../impact/flux.ts';
import type { LabScenario } from '../sim/labData.ts';
import { F, NF } from '../sim/metrics.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';
import { classLegend, lineChart, wireCharts } from './labCharts.ts';
import { names } from './names.ts';
import './lab.css';

const LAB_BODIES = [...REQUIRED_BODIES.slice(0, 3), 'Moon', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Titan'];
const LAYERS = ['observed', 'official', 'approach', 'hypothetical', 'simulated'] as const;
type Layer = (typeof LAYERS)[number];
const LAYER_LABEL: Record<Layer, string> = { observed: 'Observed historical impacts', official: 'Official risk assessments', approach: 'Catalogued close approaches', hypothetical: 'Hypothetical scenario', simulated: 'Simulated impacts in this future' };
const mt = (v: number) => (!Number.isFinite(v) ? '—' : v >= 1 ? `${fmtNum(v)} Mt` : `${fmtNum(v * 1000)} kt`);
const km = (v: number) => (!Number.isFinite(v) ? '—' : v >= 1e6 ? `${(v / 1e6).toPrecision(3)} million km` : `${fmtNum(v)} km`);
const m = (v: number) => (!Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toPrecision(3)} km` : `${v.toPrecision(3)} m`);
const pct = (v: number) => (v === 0 ? '0' : v < 1e-4 ? v.toExponential(1) : v < 0.01 ? `${(v * 100).toFixed(3)}%` : `${(v * 100).toFixed(1)}%`);

export class ImpactTab implements DataTab {
  id = 'impact';
  label = 'Impact Lab';
  el: HTMLElement;
  private host: DataHost;
  private body = 'Earth';
  private layers = new Set<Layer>(LAYERS);
  private sel: Approach | null = null;
  private custom = { d: 100, comp: 'unknown' as string, v: NaN };
  private result: LabScenario | null = null;
  private running = false;
  private simRows: Float64Array = new Float64Array(0);
  private simKey = '';
  private seed = 1;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'impactlab';
    this.el.innerHTML = `
      <p class="lab-disclaimer">${esc(DISCLAIMER)}</p>
      <h3 class="data-h">Solar System Close Approach &amp; Impact Scenario Lab</h3>
      <p class="lab-note muted">In space an object is an asteroid, comet, small body or impactor; a meteor is the light it makes in an atmosphere; a meteorite is what survives to the ground. A <strong>close approach</strong> is a nominal miss distance with 3-sigma bounds, not an impact prediction. Official impact probabilities exist for Earth (NASA/JPL Sentry); for other worlds only where a named authority published one.</p>
      ${classLegend(CLASS_STYLE, ['historical', 'active', 'scheduled', 'hypothetical', 'simulated'])}
      <div class="lab-row il-tools"></div>
      <div class="il-profile"></div>
      <div class="il-observed"></div>
      <div class="il-official"></div>
      <div class="il-approach"></div>
      <div class="il-scenario"></div>
      <div class="il-sim"></div>
      <div class="data-actions">
        <button class="link" type="button" data-act="csv-ca">Copy close approaches (CSV)</button>
        <button class="link" type="button" data-act="json-sc">Copy the scenario (JSON)</button>
        <button class="link" type="button" data-act="csv-sim">Copy this future's impacts (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>`;
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('change', (e) => this.change(e));
  }

  private $<T extends HTMLElement = HTMLElement>(s: string): T { return this.el.querySelector<T>(s)!; }

  refresh(): void {
    this.seed = this.host.sim.seed;
    this.renderTools(); this.renderProfile(); this.renderObserved(); this.renderOfficial(); this.renderApproaches(); this.renderScenario();
    this.loadSim();
  }

  /** Open one simulated impact (from an event or the inspector). */
  openImpact(id: number): void {
    const R = this.simRows;
    for (let i = 0; i < R.length / NIC; i++) if (R[i * NIC + IC.id] === id) { this.body = this.host.world.bodies[R[i * NIC + IC.body]].name; break; }
    if (!BODIES[this.body]) this.body = 'Earth';
    this.refresh();
    this.$('.il-sim').scrollIntoView?.({ block: 'nearest' });
  }

  private renderTools(): void {
    const el = this.$('.il-tools'), key = `${this.body}|${[...this.layers].join()}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = `<label>Target body <select data-ctl="body">${LAB_BODIES.map((b) => `<option value="${b}"${b === this.body ? ' selected' : ''}>${b}${b === 'Pluto' || b === 'Titan' ? ' (extension)' : ''}</option>`).join('')}</select></label>
      ${LAYERS.map((l) => `<label><input type="checkbox" data-layer="${l}"${this.layers.has(l) ? ' checked' : ''}> ${esc(LAYER_LABEL[l])}</label>`).join('')}`;
  }

  private settlementAt(name: string): { pop: number; stage: number } | null {
    const snap = this.host.snap?.();
    const id = this.host.world.bodies.findIndex((b) => b.name === name && b.system === 0);
    if (!snap || id < 0) return null;
    const S = snap.S;
    return S[id * NF + F.stage] >= 0 ? { pop: S[id * NF + F.pop], stage: S[id * NF + F.stage] } : null;
  }

  private renderProfile(): void {
    const el = this.$('.il-profile'), p = BODIES[this.body];
    const key = `${this.body}|${this.host.sim.stepAt(this.host.year())}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const a = p.atmosphere, here = this.settlementAt(this.body);
    const hs = p.solidSurface ? [0, 2, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200] : [-300, -200, -150, -100, -50, -25, 0, 25, 50, 100, 150, 200, 300];
    const prof = a.kind === 'none' ? '<p class="lab-none">No atmosphere to slow or break an impactor: everything strikes at full speed. No airburst, no blast wave.</p>'
      : lineChart([{ label: `${p.name} density`, color: '#3987e5', xs: hs.map((h) => a.density(h)), ys: hs }], { xLabel: 'density (kg/m³)', yLabel: p.solidSurface ? 'altitude (km)' : 'km above the 1-bar level', xLog: true, fmtX: (x) => x.toExponential(0), fmtY: (y) => String(Math.round(y)) });
    const r10 = impactRate(this.body, 10), r140 = impactRate(this.body, 140), r1k = impactRate(this.body, 1000);
    el.innerHTML = `<div class="lab-grid"><div class="lab-card">
      <h4>${esc(p.name)} <span class="muted">profile ${esc(PROFILE_VERSION)} · ${esc(p.cls.replace('-', ' '))}</span></h4>
      <dl class="run-stamp">
        <dt>Radius · mass</dt><dd class="num">${fmtNum(p.radiusKm)} km · ${p.massKg.toExponential(3)} kg</dd>
        <dt>GM · gravity</dt><dd class="num">${p.gm.toExponential(4)} m³/s² · ${p.gravity} m/s²${p.solidSurface ? '' : ' (at 1 bar)'}</dd>
        <dt>Escape velocity · rotation</dt><dd class="num">${p.escapeKms.toFixed(2)} km/s · ${fmtNum(Math.abs(p.rotationHours))} h${p.rotationHours < 0 ? ' (retrograde)' : ''}</dd>
        <dt>Atmosphere</dt><dd>${esc(a.kind)}${a.kind !== 'none' ? `: ${fmtNum(a.p0Pa)} Pa ${p.solidSurface ? 'at the surface' : 'reference (1 bar)'}, ${a.rho0} kg/m³, scale height ${a.scaleHeightKm} km, ${a.tempK} K` : ''}<br><span class="muted">${esc(a.composition)}</span></dd>
        <dt>Surface</dt><dd>${p.solidSurface ? esc(p.materials.map((x) => `${x.m} ${(x.share * 100).toFixed(0)}%`).join(', ')) : '<strong>none in this model</strong>: no crater and no ground casualties are ever computed'}${p.ocean ? ` · ${(p.ocean * 100).toFixed(0)}% ${p.name === 'Titan' ? 'hydrocarbon lakes' : 'ocean'}` : ''}</dd>
        <dt>Encounter speeds</dt><dd class="num">v∞ ≈ ${p.vInf.median} km/s → impact ≈ ${Math.hypot(p.vInf.median, p.escapeKms).toFixed(1)} km/s (√(v∞² + v_esc²)) <span class="muted">${esc(p.vInf.source)}</span></dd>
        <dt>Background impact rate</dt><dd class="num">≥ 10 m: every ${fmtNum(1 / r10.perYear)} yr · ≥ 140 m: every ${fmtNum(1 / r140.perYear)} yr · ≥ 1 km: every ${fmtNum(1 / r1k.perYear)} yr <span class="muted">(${esc(r1k.basis.source)}; ×${r1k.basis.rangeFactor.toFixed(1)} uncertainty)</span></dd>
        <dt>Settlement now</dt><dd>${here ? `${fmtNum(here.pop)} people in this future at ${esc(fmtYear(this.host.year()))} ${classBadge('simulated')}` : '<span class="muted">none in this future at this year</span>'}</dd>
      </dl>
      ${p.note ? `<p class="muted lab-note">${esc(p.note)}</p>` : ''}
      <p class="lab-src">Sources: <a href="${esc(FACT_SHEET)}" target="_blank" rel="noopener">NASA Planetary Fact Sheet</a>; ${esc(a.source)}; deeper data: <a href="https://pds-atmospheres.nmsu.edu/" target="_blank" rel="noopener">PDS Atmospheres Node</a>; engineering atmospheres: <a href="https://software.nasa.gov/software/MFS-33888-1" target="_blank" rel="noopener">NASA GRAM</a>.</p>
    </div><div class="lab-card"><h4>Atmosphere profile</h4>${prof}</div></div>`;
    wireCharts(el);
  }

  private renderObserved(): void {
    const el = this.$('.il-observed');
    if (!this.layers.has('observed')) { el.innerHTML = ''; return; }
    if (el.dataset.key === this.body) return;
    el.dataset.key = this.body;
    const list = OBSERVED_IMPACTS.filter((o) => o.body === this.body);
    el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.observed)} ${classBadge('historical')}</h3>` + (list.length ? `<table class="dtable"><thead><tr><th scope="col" class="txt">date</th><th scope="col" class="txt">event</th><th scope="col">impactor</th><th scope="col">energy</th><th scope="col" class="txt">what was observed</th><th scope="col" class="txt">source</th></tr></thead><tbody>${list.map((o) => `<tr><th scope="row" class="txt num">${esc(o.date)}</th><td class="txt">${esc(o.name)}</td><td>${m(o.diameterM[0])}–${m(o.diameterM[2])}</td><td>${o.energyMt ? `${mt(o.energyMt[0])}–${mt(o.energyMt[2])}` : '—'}</td><td class="txt">${esc(o.observed)}</td><td class="txt lab-src">${o.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.organization)}</a>`).join('; ')}</td></tr>`).join('')}</tbody></table>
      <p class="muted lab-note">These are the model's validation cases (scripts/impact-check.ts): Chelyabinsk must burst high, Meteor Crater and the 2021 Mars crater must come out near their measured sizes, Shoemaker–Levy 9 must deposit its energy in Jupiter's atmosphere with no crater.</p>` : `<p class="muted">${esc(NO_OBSERVED[this.body] ?? 'No observed impacts in this record.')}</p>`);
  }

  private renderOfficial(): void {
    const el = this.$('.il-official');
    if (!this.layers.has('official')) { el.innerHTML = ''; return; }
    if (el.dataset.key === this.body) return;
    el.dataset.key = this.body;
    if (this.body === 'Earth') {
      const top = sentryRisks().sort((a, b) => b.psCum - a.psCum).slice(0, 25);
      el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.official)}: NASA/JPL Sentry ${classBadge('active')}</h3>
        <p class="lab-official">${esc(SENTRY_NOTE)} Retrieved ${esc(SENTRY?.provenance.retrieved.slice(0, 16) ?? '')} UTC; ${fmtNum(SENTRY?.rows.length ?? 0)} objects listed.</p>
        <div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col" class="txt">object</th><th scope="col">cumulative probability</th><th scope="col">Palermo (cum.)</th><th scope="col">Torino (max)</th><th scope="col">possible impacts</th><th scope="col" class="txt">years</th><th scope="col">diameter</th><th scope="col">v∞</th><th scope="col" class="txt">last observed</th></tr></thead><tbody>${top.map((r) => `<tr><th scope="row" class="txt"><a href="https://cneos.jpl.nasa.gov/sentry/details.html#?des=${encodeURIComponent(r.des)}" target="_blank" rel="noopener">${esc(r.name)}</a></th><td>${r.ip.toExponential(2)}</td><td>${r.psCum.toFixed(2)}</td><td>${r.tsMax ?? '—'}</td><td>${r.nImp}</td><td class="txt">${esc(r.range)}</td><td>${r.diameterM ? m(r.diameterM) : '—'}</td><td>${r.vInfKms ? `${r.vInfKms.toFixed(1)} km/s` : '—'}</td><td class="txt">${esc(r.lastObs)}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted lab-note">Each virtual impactor inside this future (2040 onwards) is rolled once with its official probability; the background rate excludes the share of each size already catalogued, so no object is counted twice.</p>`;
      return;
    }
    const pub = OFFICIAL_NON_EARTH.filter((r) => r.body === this.body);
    el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.official)}</h3>` + (pub.length ? pub.map((r) => `<p class="lab-official"><strong>${esc(r.name)}</strong>: ${(r.ip * 100).toFixed(1)}% published by <a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(r.source.organization)}</a> (${esc(r.source.note ?? '')}). <strong>Status: ${esc(r.status)}.</strong> ${esc(r.note)}</p>`).join('') : '') + `<p class="lab-none">No official impact probability is available for ${esc(this.body)} beyond what is listed here. Sentry monitors Earth only; a close approach below is a miss distance, not a probability.</p>`;
  }

  private renderApproaches(): void {
    const el = this.$('.il-approach');
    if (!this.layers.has('approach')) { el.innerHTML = ''; return; }
    const key = `${this.body}|${this.sel?.des ?? ''}|${this.sel?.jd ?? ''}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const list = approaches(this.body), p = BODIES[this.body];
    if (!list.length) { el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.approach)}</h3><p class="muted">No catalogued close approaches to ${esc(this.body)} in this snapshot's query.</p>`; return; }
    const pts = (past: boolean) => ({ label: past ? 'past (observed orbit)' : 'future (predicted)', color: past ? '#9aa4b2' : '#199e70', xs: list.filter((a) => a.past === past).map((a) => 2000 + (a.jd - 2451545) / 365.25), ys: list.filter((a) => a.past === past).map((a) => a.distKm / p.radiusKm) });
    el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.approach)}: NASA/JPL CAD</h3>
      <p class="lab-none">${esc(NO_OFFICIAL)}</p>
      ${lineChart([pts(true), pts(false)], { xLabel: 'year', yLabel: `nominal distance (${p.name} radii)`, yLog: true, points: true, fmtX: (x) => String(Math.round(x)), fmtY: (y) => fmtNum(y) })}
      <div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col" class="txt">date (TDB)</th><th scope="col" class="txt">object</th><th scope="col" class="txt">class</th><th scope="col">nominal distance</th><th scope="col">3σ range</th><th scope="col">body radii</th><th scope="col">v_rel / v∞</th><th scope="col">diameter</th><th scope="col" class="txt">official probability</th><th scope="col" class="txt">time 3σ</th></tr></thead><tbody>${list.slice(0, 150).map((a) => {
        const off = officialFor(this.body, a.des);
        const sel = this.sel?.des === a.des && this.sel?.jd === a.jd;
        return `<tr${sel ? ' class="sel"' : ''}><th scope="row" class="txt"><button class="link num" type="button" data-ca="${esc(a.des)}|${a.jd}">${esc(a.date)}</button></th><td class="txt">${esc(a.name)}</td><td class="txt">${classBadge(a.classification)}</td><td>${km(a.distKm)}</td><td class="muted">${km(a.distMinKm)} – ${km(a.distMaxKm)}</td><td>${fmtNum(a.distKm / p.radiusKm)}</td><td>${a.vRelKms.toFixed(1)} / ${a.vInfKms?.toFixed(1) ?? '—'} km/s</td><td title="${esc(a.diameterBasis)}">${Number.isFinite(a.diameterM[1]) ? `${m(a.diameterM[0])}–${m(a.diameterM[2])}` : '—'}</td><td class="txt">${off ? `${off.ip.toExponential(1)} <span class="muted">(${esc(off.source.organization)}, ${esc(off.status)})</span>` : '<span class="muted">none available</span>'}</td><td class="txt muted">${esc(a.tSigma)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted lab-note">Sorted by distance; ${list.length} approaches in this snapshot's query (${esc(this.body === 'Earth' || this.body === 'Moon' ? 'H ≤ 22, within 0.05 au' : 'see the snapshot manifest for the query')}). Distances are nominal with the 3-sigma bounds JPL supplies; diameters are measured where JPL has one, otherwise from H with albedo 0.05–0.25. Pick a date to explore it.</p>
      ${this.sel ? this.encounter(this.sel) : ''}`;
    wireCharts(el);
  }

  private encounter(a: Approach): string {
    const p = BODIES[a.body], R = p.radiusKm, W = 560, H = 150, cx = 90, cy = H / 2;
    const scale = Math.min(60 / R, 400 / a.distMaxKm), r = Math.max(2, R * scale);
    const d = a.distKm * scale, lo = a.distMinKm * scale, hi = a.distMaxKm * scale;
    const hz = HORIZONS?.series.find((s) => (s.target === a.body) && (s.id.startsWith('apophis') ? a.des.includes('99942') || a.name.includes('Apophis') : a.des.includes('2024 YR4')));
    const off = officialFor(a.body, a.des);
    return `<div class="lab-grid"><div class="lab-card"><h4>${esc(a.name)}, ${esc(a.date)}</h4>
      <svg class="lab-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Encounter geometry to scale"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#3987e5" opacity="0.6"/><text x="${cx}" y="${cy + r + 12}" text-anchor="middle">${esc(a.body)}</text>
        <line x1="${cx + lo}" x2="${cx + hi}" y1="${cy}" y2="${cy}" stroke="#199e70" stroke-width="6" opacity="0.4"><title>3-sigma range</title></line>
        <circle cx="${cx + d}" cy="${cy}" r="4" fill="#199e70" stroke="#08080a" stroke-width="2"><title>nominal closest approach</title></circle>
        <text x="${cx + d}" y="${cy - 10}" text-anchor="middle">${esc(km(a.distKm))}</text></svg>
      <p class="muted lab-note">To scale: the body and the miss distance with its 3-sigma range. ${a.distMinKm < R ? '<strong>The 3-sigma range reaches the body’s radius.</strong> That still does not give a probability without the orbit covariance.' : ''} ${off ? `Official assessment: ${off.ip.toExponential(2)} (${esc(off.source.organization)}, ${esc(off.status)}).` : esc(NO_OFFICIAL)}</p>
      ${hz ? `<p class="lab-src">Nominal trajectory: JPL Horizons, ${hz.rows.length} vectors ${esc(hz.start)}–${esc(hz.stop)} (${esc(hz.note)}).</p>` : ''}
      <div class="lab-row"><button class="link" type="button" data-act="run-ca">Run a hypothetical impact of this object on ${esc(a.body)}</button><span class="muted">${classBadge('hypothetical')} a "what if", not a prediction</span></div>
    </div></div>`;
  }

  private renderScenario(): void {
    const el = this.$('.il-scenario');
    if (!this.layers.has('hypothetical')) { el.innerHTML = ''; return; }
    const r = this.result, p = BODIES[this.body];
    const key = `${this.body}|${this.running}|${r ? `${r.body}:${r.seed}:${r.energyMt.p50}` : ''}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const form = `<div class="lab-row"><label>Diameter (m) <input type="number" min="1" step="any" value="${this.custom.d}" data-ctl="d"></label>
      <label>Composition <select data-ctl="comp">${['unknown', ...KINDS].map((k) => `<option value="${k}"${this.custom.comp === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>v∞ (km/s, blank for the body's distribution) <input type="number" min="0" step="any" value="${Number.isFinite(this.custom.v) ? this.custom.v : ''}" data-ctl="v"></label>
      <button class="link" type="button" data-act="run">Run ${esc(p.name)} scenario (120 seeded draws)</button></div>`;
    if (this.running) { el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.hypothetical)} ${classBadge('hypothetical')}</h3>${form}<p class="muted">Running…</p>`; return; }
    if (!r || r.body !== this.body) { el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.hypothetical)} ${classBadge('hypothetical')}</h3>${form}<p class="muted">Set an impactor and run it, or pick a close approach above.</p>`; return; }
    const band = (b: { p10: number; p50: number; p90: number } | null, f: (x: number) => string) => (b ? `${f(b.p10)} · <strong>${f(b.p50)}</strong> · ${f(b.p90)}` : '—');
    const md = r.median, giant = !p.solidSurface;
    const dep = md.deposition.filter((x) => x[1] > 0);
    const depChart = dep.length ? lineChart([{ label: 'energy deposited', color: '#d95926', xs: dep.map((x) => x[1]), ys: dep.map((x) => x[0]) }], { xLabel: 'J per km', yLabel: giant ? 'km above 1 bar' : 'altitude (km)', xLog: true, fmtX: (x) => x.toExponential(0), fmtY: (y) => String(Math.round(y)) }) : '<p class="lab-none">No atmosphere: no energy is deposited before the surface.</p>';
    const out = Object.entries(r.outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${(v * 100).toFixed(0)}%`).join(' · ');
    el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.hypothetical)} ${classBadge('hypothetical')}</h3>${form}
      <div class="lab-grid"><div class="lab-card"><h4>Low · nominal · high (10th, 50th, 90th percentile of ${r.n} seeded draws, seed ${r.seed})</h4>
      <dl class="run-stamp">
        <dt>Outcome</dt><dd>${out}</dd>
        <dt>Impact energy</dt><dd class="num">${band(r.energyMt, mt)}</dd>
        <dt>${giant ? 'Energy deposition (rel. 1 bar)' : 'Airburst altitude'}</dt><dd class="num">${band(r.burstAltKm, (x) => `${x.toFixed(0)} km`)}</dd>
        ${giant ? `<dt>Plume height</dt><dd class="num">${band(r.plumeKm, (x) => km(x))}</dd><dt>Atmospheric scar</dt><dd class="num">${band(r.scarKm, (x) => km(x))}</dd><dt>No crater</dt><dd>${esc(p.name)} has no solid surface: no crater and no ground casualties are computed.</dd>`
          : `<dt>Crater (final diameter)</dt><dd class="num">${r.craterKm ? band(r.craterKm, (x) => km(x)) : 'none (nothing reached the ground with speed)'}</dd>`}
        <dt>Deaths</dt><dd class="num">${band(r.deaths, (x) => fmtNum(x))} ${r.settlement ? `<span class="muted">of ${fmtNum(r.settlement.pop)} here in ${esc(fmtYear(r.year))}${r.settlement.sites ? `, across ${r.settlement.sites} sites` : ''}</span>` : '<span class="muted">(no settlement on this body at this year)</span>'}</dd>
        <dt>Property lost</dt><dd class="num">${band(r.capitalLost, (x) => `$${fmtNum(x)}`)}</dd>
      </dl>
      <p class="muted lab-note">Median draw: ${esc(md.notes.join(' '))}${md.crater ? ` Crater ${m(md.crater.finalM)} (${esc(md.crater.morphology)}, in ${esc(md.crater.material)}).` : ''}${md.ejecta1mKm ? ` Ejecta 1 m deep out to ${km(md.ejecta1mKm)}.` : ''}${md.thermalKm ? ` Burns out to ${km(md.thermalKm)}.` : ''}${md.seismic !== null ? ` Shaking equivalent to magnitude ${md.seismic.toFixed(1)}.` : ''}${md.orbitalLoss ? ` Orbital habitats: ${pct(md.orbitalLoss)} hit by ejecta.` : ''}</p>
      ${md.sites.length ? `<table class="dtable"><thead><tr><th scope="col">site</th><th scope="col">distance</th><th scope="col">deaths</th><th scope="col">property lost</th></tr></thead><tbody>${md.sites.map((s) => `<tr><th scope="row">${s.site === 0 ? 'capital' : `#${s.site}`}</th><td>${km(s.distanceKm)}</td><td>${fmtNum(s.deaths)}</td><td>$${fmtNum(s.capitalLost)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="lab-src">Limitations: ${esc(r.limitations.join(' '))}</p></div>
      <div class="lab-card"><h4>Where the energy went (median draw)</h4>${depChart}</div></div>`;
    wireCharts(el);
  }

  private loadSim(): void {
    const el = this.$('.il-sim');
    if (!this.layers.has('simulated')) { el.innerHTML = ''; return; }
    const sim = this.host.sim, key = `${sim.seed}:${sim.stepAt(this.host.year())}:${sim.frontier}:${this.body}`;
    if (key === this.simKey) return;
    this.simKey = key;
    sim.data<'impacts'>({ type: 'impacts', year: sim.years[sim.stepAt(this.host.year())] }).then((res) => { this.simRows = res.rows; this.renderSim(); });
  }

  private renderSim(): void {
    const el = this.$('.il-sim'), R = this.simRows, W = this.host.world, n = R.length / NIC;
    const rows: number[] = [];
    for (let i = n - 1; i >= 0; i--) rows.push(i);
    const here = rows.filter((i) => W.bodies[R[i * NIC + IC.body]].name === this.body || this.body === 'all');
    const f = (i: number, k: keyof typeof IC) => R[i * NIC + IC[k]];
    el.innerHTML = `<h3 class="data-h">${esc(LAYER_LABEL.simulated)} ${classBadge('simulated')}</h3>
      <p class="muted lab-note">${fmtNum(n)} impacts worth recording in this future up to ${esc(fmtYear(this.host.year()))} (all worlds), ${here.length} on ${esc(this.body)}. Rates are body-specific (${esc(impactRate(this.body, 140).basis.source)}); damage depends on where each one lands relative to each settlement's sites, the warning and the era's deflection. Not a forecast.</p>
      ${here.length ? `<div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col" class="txt">year</th><th scope="col" class="txt">world</th><th scope="col">diameter</th><th scope="col" class="txt">composition</th><th scope="col">energy</th><th scope="col" class="txt">outcome</th><th scope="col">burst / crater</th><th scope="col">deaths</th><th scope="col">property</th><th scope="col" class="txt">warning and defence</th><th scope="col" class="txt">source</th></tr></thead><tbody>${here.slice(0, 200).map((i) => {
        const fl = f(i, 'flags'), out = OUTCOMES[f(i, 'outcome')] ?? '—';
        const def = fl & IF.deflected ? `deflected (${f(i, 'warningYears').toFixed(0)} yr warning)` : fl & IF.detected ? `detected ${f(i, 'warningYears').toFixed(0)} yr ahead, evacuated` : 'no warning';
        return `<tr class="cls-sim"><th scope="row" class="txt num">${esc(fmtYear(f(i, 'year')))}</th><td class="txt">${esc(names.place(W, f(i, 'body')))}</td><td>${m(f(i, 'diameterM'))}</td><td class="txt">${esc(KINDS[f(i, 'kind')] ?? '—')}</td><td>${mt(f(i, 'energyMt'))}</td><td class="txt">${esc(fl & IF.deflected ? 'averted' : out)}${fl & IF.ocean ? ', ocean' : ''}</td><td>${Number.isFinite(f(i, 'craterKm')) ? `crater ${km(f(i, 'craterKm'))}` : Number.isFinite(f(i, 'burstAltKm')) ? `burst ${f(i, 'burstAltKm').toFixed(0)} km` : '—'}</td><td>${fmtNum(f(i, 'deaths'))}</td><td>$${fmtNum(f(i, 'capitalLost'))}</td><td class="txt">${esc(def)}</td><td class="txt">${fl & IF.catalogued ? 'catalogued object (Sentry, official probability)' : 'background (seeded)'}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}`;
  }

  // ---------------------------------------------------------------- events

  private run(d: [number, number, number], comp: string, vInf: number | undefined, label: string): void {
    this.running = true; this.renderScenario();
    this.host.sim.data<'impactLab'>({ type: 'impactLab', body: this.body, diameterM: d, composition: comp as never, vInfKms: vInf, year: this.host.sim.years[this.host.sim.stepAt(this.host.year())], seed: this.seed, label }).then((res) => {
      this.running = false; this.result = res.result;
      if (!res.result) this.$('.il-scenario').insertAdjacentHTML('beforeend', `<p class="lab-warn">${esc(res.error ?? 'Scenario failed')}</p>`);
      this.renderScenario();
    });
  }

  private click(e: Event): void {
    const t = e.target as HTMLElement, act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const ca = t.closest<HTMLElement>('[data-ca]')?.dataset.ca;
    if (ca) { const [des, jd] = ca.split('|'); this.sel = approaches(this.body).find((a) => a.des === des && String(a.jd) === jd) ?? null; this.renderApproaches(); return; }
    if (act === 'run') this.run([this.custom.d / 1.5, this.custom.d, this.custom.d * 1.5], this.custom.comp, Number.isFinite(this.custom.v) ? this.custom.v : undefined, 'custom');
    if (act === 'run-ca' && this.sel) {
      const d = this.sel.diameterM;
      this.run(Number.isFinite(d[1]) ? d : [50, 100, 200], 'unknown', this.sel.vInfKms ?? undefined, `${this.sel.name} ${this.sel.date}`);
      this.$('.il-scenario').scrollIntoView?.({ block: 'nearest' });
    }
    const status = this.$('.copy-status');
    if (act === 'csv-ca') void copyText(toCsv(['body', 'des', 'name', 'date_tdb', 'jd', 'dist_km', 'dist_min_km', 'dist_max_km', 'v_rel_kms', 'v_inf_kms', 'h', 'd_low_m', 'd_nom_m', 'd_high_m', 'diameter_basis', 'official_probability', 'official_source'], approaches(this.body).map((a) => { const o = officialFor(this.body, a.des); return [a.body, a.des, a.name, a.date, a.jd, a.distKm, a.distMinKm, a.distMaxKm, a.vRelKms, a.vInfKms ?? '', a.h ?? '', ...a.diameterM, a.diameterBasis, o ? o.ip : 'none available', o ? o.source.url : '']; }), `Close approaches to ${this.body} (JPL CAD) · snapshot ${SNAPSHOT_ID} · AU ${AU_KM} km`), 'The close approaches', status);
    if (act === 'json-sc' && this.result) void copyText(toJson({ snapshotId: SNAPSHOT_ID, seed: this.result.seed, classification: 'hypothetical', scenario: this.result }, `Impact scenario on ${this.result.body}`), 'The scenario', status);
    if (act === 'csv-sim') {
      const R = this.simRows, keys = Object.keys(IC) as (keyof typeof IC)[];
      void copyText(toCsv(['classification', ...keys, 'world'], Array.from({ length: R.length / NIC }, (_, i) => ['simulated', ...keys.map((k) => R[i * NIC + IC[k]]), this.host.world.bodies[R[i * NIC + IC.body]].name]), `Simulated impacts · seed ${this.host.sim.seed} · snapshot ${SNAPSHOT_ID}`), "This future's impacts", status);
    }
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement;
    const layer = t.dataset.layer as Layer | undefined;
    if (layer) { if (t.checked) this.layers.add(layer); else this.layers.delete(layer); this.el.querySelectorAll<HTMLElement>('[data-key]').forEach((x) => delete x.dataset.key); this.simKey = ''; this.refresh(); return; }
    const c = t.dataset.ctl;
    if (c === 'body') { this.body = t.value; this.sel = null; this.simKey = ''; this.refresh(); }
    if (c === 'd') this.custom.d = Math.max(1, Number(t.value) || 100);
    if (c === 'comp') this.custom.comp = t.value;
    if (c === 'v') this.custom.v = t.value === '' ? NaN : Number(t.value);
  }
}
