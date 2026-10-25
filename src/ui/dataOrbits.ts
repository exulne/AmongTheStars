// "Orbits & missions": observed satellites (CelesTrak GP snapshot, SGP4 at
// their epoch), one object's drag and lifetime analysis, this future's
// simulated fleet and what the atmosphere costs it, the Starlink 2022
// validation, the mission registry and the launch and mission-control
// facilities. Every row carries its classification; observed, planned and
// simulated things never share a style.

import { CLASS_STYLE, DISCLAIMER, classBadge, type Classification } from '../data/provenance.ts';
import { FACILITIES } from '../data/registry/facilities.ts';
import { CATEGORY_LABEL, CONSTELLATION_PLANS, MISSIONS, isFlown, mergeMissions, withRole, type Mission } from '../data/registry/missions.ts';
import { ORGS, type OrgId } from '../data/registry/orgs.ts';
import { SATCAT, SNAPSHOT_CHECKS, SNAPSHOT_ID, SPACE_WEATHER, snapshotLine } from '../data/snapshot.ts';
import { MODE_LABEL, type AtmoMode } from '../orbit/spaceWeather.ts';
import { AGE_LABEL } from '../orbit/sgp4.ts';
import { FLEET_2040, SHELLS } from '../orbit/shells.ts';
import { THERMO_FIT } from '../orbit/thermosphereFit.ts';
import type { OrbitSummary, SatInfo } from '../sim/labData.ts';
import { GM } from '../sim/metrics.ts';
import { observedLayer } from '../view/observedLayer.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';
import { classLegend, lineChart, wireCharts } from './labCharts.ts';
import './lab.css';

const MODES: AtmoMode[] = ['quiet', 'nominal', 'storm'];
const MODE_COLOR: Record<AtmoMode, string> = { quiet: '#3987e5', nominal: '#199e70', storm: '#d95926' };
const money = (v: number) => (Number.isFinite(v) ? `$${fmtNum(v)}` : '—');
const yrs = (v: number) => (!Number.isFinite(v) ? '> horizon' : v < 1 / 12 ? `${(v * 365.25).toFixed(1)} days` : v < 2 ? `${(v * 12).toFixed(1)} months` : `${fmtNum(v)} yr`);
const sci = (v: number) => (v > 0 ? v.toExponential(2) : '0');
const orgName = (o: OrgId | string) => (o in ORGS ? ORGS[o as OrgId].name : String(o));
const isoDay = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

export class OrbitTab implements DataTab {
  id = 'orbits';
  label = 'Orbits & missions';
  el: HTMLElement;
  private host: DataHost;
  private summary: OrbitSummary | null = null;
  private info: SatInfo | null = null;
  private infoFor = -1;
  private colorBy: 'operator' | 'altitude' | 'age' = 'operator';
  private offsetH = 0;
  private mode: AtmoMode = 'nominal';
  private statusFilter: Classification | 'all' = 'all';
  private orgFilter: OrgId | 'all' = 'all';
  private fleetKey = '';
  private asking = false;
  private missions: Mission[] = mergeMissions(MISSIONS);

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'orbits';
    this.el.innerHTML = `
      <p class="lab-disclaimer">${esc(DISCLAIMER)}</p>
      <p class="lab-note muted">Observed objects are general-perturbation elements from CelesTrak, propagated with SGP4 near their element-set epochs: positions far from an epoch are not shown as current. The simulated fleet after 2040 is this future's model, drawn and labelled separately. Drag uses a thermosphere calibrated against NRLMSIS 2.0 (held-out error ${(THERMO_FIT.holdout.rmsLog10 * 100 / 0.4343).toFixed(0)}% rms), solar cycles generated from the observed record. ${esc(snapshotLine())}.</p>
      ${classLegend(CLASS_STYLE)}
      <h3 class="data-h">Observed now: the GP snapshot</h3><div class="ob-now"></div>
      <h3 class="data-h">One object</h3><div class="ob-search lab-row"></div><div class="ob-info"></div>
      <h3 class="data-h">Atmosphere mode</h3><div class="ob-mode lab-row"></div>
      <h3 class="data-h">This future's fleet <span class="cls-badge" style="--cls:${CLASS_STYLE.simulated.color}">SIM</span></h3><div class="ob-fleet"></div>
      <h3 class="data-h">Validation: the February 2022 Starlink loss</h3><div class="ob-starlink"></div>
      <h3 class="data-h">Missions: NASA, SpaceX, Blue Origin and the payloads they carry</h3><div class="ob-mtools lab-row"></div><div class="tbl-scroll short ob-missions"></div>
      <h3 class="data-h">Licensed constellation plans <span class="cls-badge" style="--cls:${CLASS_STYLE.contracted.color}">CONTRACT</span></h3><div class="ob-plans"></div>
      <h3 class="data-h">Facilities</h3><div class="ob-fac"></div>
      <div class="data-actions">
        <button class="link" type="button" data-act="csv-m">Copy missions (CSV)</button>
        <button class="link" type="button" data-act="json-m">Copy missions, facilities and plans (JSON)</button>
        <button class="link" type="button" data-act="json-sat">Copy this object's analysis (JSON)</button>
        <button class="link" type="button" data-act="csv-fleet">Copy the fleet (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <p class="lab-checks">${SNAPSHOT_CHECKS.map((c) => `${esc(c.file)}: ${c.ok ? 'ok' : `<strong>failed</strong> (${esc(c.message)})`}`).join(' · ')}</p>`;
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('change', (e) => this.change(e));
    this.el.addEventListener('input', (e) => this.input(e));
    observedLayer.onPick = (n) => this.openSat(n);
    observedLayer.describe = (n) => (this.info && this.info.norad === n ? this.cardFacts(this.info) : null);
  }

  private $<T extends HTMLElement = HTMLElement>(s: string): T { return this.el.querySelector<T>(s)!; }

  refresh(): void {
    if (!this.summary && !this.asking) {
      this.asking = true;
      this.host.sim.data<'orbitSummary'>({ type: 'orbitSummary' }).then((m) => { this.summary = m.summary; this.asking = false; this.render(); });
    }
    this.render();
    this.loadFleet();
  }

  hide(): void { /* the observed layer stays as the user left it */ }

  /** Open one observed object (from the 3D view or a search). */
  openSat(norad: number): void {
    this.infoFor = norad; this.info = null;
    this.renderInfo();
    this.host.sim.data<'satInfo'>({ type: 'satInfo', norad, tMs: this.viewTime() }).then((m) => { if (this.infoFor === norad) { this.info = m.info; this.renderInfo(); } });
  }

  private viewTime(): number { return (this.summary?.medianEpochMs ?? Date.now()) + this.offsetH * 3600e3; }

  private render(): void {
    this.renderNow();
    this.renderMode();
    this.renderStarlink();
    this.renderMissions();
    this.renderPlans();
    this.renderFacilities();
    if (!this.$('.ob-search').innerHTML) this.$('.ob-search').innerHTML = `<label>Find by name, NORAD number or COSPAR <input type="search" data-ctl="q" placeholder="ISS, HST, 25544, 2024-182A" aria-label="Find an observed object"></label><span class="ob-hits"></span>`;
  }

  private renderNow(): void {
    const s = this.summary, el = this.$('.ob-now');
    if (!s) { el.innerHTML = '<p class="muted">Reading the snapshot…</p>'; return; }
    if (!s.count) { el.innerHTML = '<p class="lab-warn">The GP snapshot is empty in this build: no observed objects can be shown. Run <code>node scripts/ingest.ts --only gp</code>.</p>'; return; }
    const ops = Object.entries(s.byOperator).sort((a, b) => b[1] - a[1]);
    const COL: Record<string, string> = { SpaceX: '#3987e5', Amazon: '#c98500', 'Eutelsat OneWeb': '#199e70', 'NASA or NOAA': '#d55181', 'ISS partnership': '#e8e8e8', Other: '#7f8a99' };
    const t = this.viewTime(), off = this.offsetH;
    const ageWarn = Math.abs(off) > 14 * 24 ? AGE_LABEL.stale : Math.abs(off) > 3 * 24 ? AGE_LABEL.aging : '';
    const bins = s.bins.map((b) => ({ x: (b.lo + b.hi) / 2, label: `${fmtNum(b.lo)}–${fmtNum(b.hi)} km`, n: Object.values(b.counts).reduce((a, c) => a + c, 0), b }));
    el.innerHTML = `
      <div class="ec-cards">
        <div class="ec-card"><p class="muted">Tracked active objects</p><p class="ec-v num">${fmtNum(s.count)}</p><p class="muted ec-s">${classBadge('active')} CelesTrak group "active"</p></div>
        <div class="ec-card"><p class="muted">Element-set epochs</p><p class="ec-v num">${esc(isoDay(s.medianEpochMs).slice(0, 10))}</p><p class="muted ec-s">median; range ${esc(isoDay(s.epochMinMs).slice(0, 10))} to ${esc(isoDay(s.epochMaxMs).slice(0, 10))}</p></div>
        <div class="ec-card"><p class="muted">Retrieved</p><p class="ec-v num">${esc(s.retrieved.slice(0, 10))}</p><p class="muted ec-s">snapshot ${esc(s.snapshotId)}</p></div>
      </div>
      <div class="lab-bar" role="img" aria-label="objects by operator">${ops.map(([k, v]) => `<span style="flex-grow:${v};background:${COL[k] ?? '#7f8a99'}" title="${esc(k)}: ${fmtNum(v)}"></span>`).join('')}</div>
      <ul class="ec-legend">${ops.map(([k, v]) => `<li><i style="background:${COL[k] ?? '#7f8a99'}"></i>${esc(k)}<span class="num">${fmtNum(v)}</span><span class="num muted">${((100 * v) / s.count).toFixed(1)}%</span></li>`).join('')}</ul>
      <p class="muted lab-note">Operators are inferred from object names and the mission registry; "Other" includes every operator not classified here (most of the world's satellites).</p>
      <table class="dtable"><thead><tr><th scope="col" class="txt">mean altitude</th><th scope="col">objects</th><th scope="col" class="txt">largest operators</th></tr></thead><tbody>${bins.map((b) => `<tr><th scope="row" class="txt">${esc(b.label)}</th><td>${fmtNum(b.n)}</td><td class="txt">${Object.entries(b.b.counts).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${fmtNum(v)}`).join(' · ')}</td></tr>`).join('')}</tbody></table>
      <div class="lab-row">
        <label><input type="checkbox" data-ctl="show"${observedLayer.on ? ' checked' : ''}> Draw observed objects around Earth</label>
        <label>Colour by <select data-ctl="color">${(['operator', 'altitude', 'age'] as const).map((c) => `<option value="${c}"${this.colorBy === c ? ' selected' : ''}>${c === 'age' ? 'element-set age' : c}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-ctl="sim"${observedLayer.simulated ? ' checked' : ''}> also the simulated fleet</label>
        <button class="link" type="button" data-act="earth">Go to Earth</button>
      </div>
      <div class="lab-row"><label>Time shown <input type="range" min="-336" max="336" step="1" value="${off}" data-ctl="offset" aria-label="Hours from the median epoch"></label><span class="num">${esc(isoDay(t))} (${off >= 0 ? '+' : ''}${off} h from the median epoch)</span></div>
      ${ageWarn ? `<p class="lab-warn">${esc(ageWarn)}</p>` : ''}
      <p class="muted lab-note">The observed layer shows the real sky near ${esc(isoDay(s.medianEpochMs).slice(0, 10))}, not the simulated year ${esc(fmtYear(this.host.year()))}. Objects whose elements are more than 60 days from the time shown are left out.</p>`;
  }

  private loadObserved(): void {
    if (!observedLayer.on) { observedLayer.positions = null; observedLayer.version++; return; }
    const tMs = this.viewTime();
    this.host.sim.data<'orbits'>({ type: 'orbits', tMs, colorBy: this.colorBy }).then((m) => {
      observedLayer.positions = m.positions; observedLayer.colors = m.colors; observedLayer.norads = m.norads; observedLayer.age = m.age; observedLayer.tMs = m.tMs; observedLayer.version++;
    });
  }

  private renderInfo(): void {
    const el = this.$('.ob-info'), i = this.info;
    if (this.infoFor < 0) { el.innerHTML = '<p class="muted">Search above, or pick an observed object in the 3D view around Earth.</p>'; return; }
    if (!i) { el.innerHTML = '<p class="muted">Propagating and running the decay ranges…</p>'; return; }
    const o = i.orbit, mode = this.mode;
    const dec = i.decay, pw = i.powered;
    const rng = (s: { p10: number; p50: number; p90: number }) => `${yrs(s.p10)} – ${yrs(s.p90)} <span class="muted">(median ${yrs(s.p50)})</span>`;
    el.innerHTML = `<div class="lab-grid"><div class="lab-card">
      <h4>${esc(i.name)} ${classBadge('active')}</h4>
      <dl class="run-stamp">
        <dt>NORAD / COSPAR</dt><dd class="num">${i.norad} · ${esc(i.objectId)}</dd>
        <dt>Operator</dt><dd>${esc(i.operator)} <span class="muted">(${esc(i.operatorBasis)})</span></dd>
        <dt>Mission</dt><dd>${i.mission ? `${esc(i.mission.name)} ${classBadge(i.mission.status as Classification)}` : '<span class="muted">not in the registry</span>'}</dd>
        <dt>Element-set epoch</dt><dd class="num">${esc(isoDay(Date.parse(i.epochIso)))} · age at the time shown ${i.ageDays.toFixed(1)} days</dd>
        <dt>Position quality</dt><dd>${esc(AGE_LABEL[i.age])}</dd>
        <dt>Orbit</dt><dd class="num">${fmtNum(o.perigeeKm)} × ${fmtNum(o.apogeeKm)} km, ${o.incDeg.toFixed(1)}°, ${o.periodMin.toFixed(1)} min</dd>
        <dt>Class (for drag)</dt><dd>${esc(i.clsLabel)} <span class="muted">(${esc(i.clsBasis)})</span></dd>
        <dt>Mass · drag area · C<sub>D</sub></dt><dd class="num">${i.massKg.map((x) => fmtNum(x)).join('–')} kg · ${i.areaM2.map((x) => fmtNum(x)).join('–')} m² · ${i.cd.join('–')} <span class="muted">(low–nominal–high priors, not measurements)</span></dd>
        <dt>Ballistic coefficient</dt><dd class="num">${fmtNum(i.ballistic.low)} – ${fmtNum(i.ballistic.high)} kg/m² <span class="muted">(nominal ${fmtNum(i.ballistic.nominal)}; B = m / (C<sub>D</sub>A))</span></dd>
        <dt>Density at perigee</dt><dd class="num">${i.rhoNow === null ? 'negligible (above the drag ceiling)' : `${sci(i.rhoByMode[mode])} kg/m³ in ${mode} conditions <span class="muted">(quiet ${sci(i.rhoByMode.quiet)} · storm ${sci(i.rhoByMode.storm)})</span>`}</dd>
        <dt>Drag regime</dt><dd>${esc(i.regime)}</dd>
        <dt>If it stopped manoeuvring</dt><dd>${dec ? MODES.map((m) => `<span style="color:${m === mode ? 'var(--ink)' : 'var(--quiet)'}">${m}: ${rng(dec[m])}</span>`).join('<br>') : 'stays up for centuries or more (MEO/GEO: drag not modelled)'}</dd>
        <dt>Stationkeeping</dt><dd>${pw ? MODES.map((m) => `<span style="color:${m === mode ? 'var(--ink)' : 'var(--quiet)'}">${m}: Δv ${fmtNum(pw[m].dv.p50)} m/s/yr (${fmtNum(pw[m].dv.p10)}–${fmtNum(pw[m].dv.p90)}), propellant ${fmtNum(pw[m].prop.p50)} kg/yr, powered life ${yrs(pw[m].life.p10)}–${yrs(pw[m].life.p90)}</span>`).join('<br>') + ' <span class="muted">fuel state simulated from the class prior</span>' : '<span class="muted">no propulsion in this class</span>'}</dd>
        <dt>Replacement exposure</dt><dd class="num">${money(i.replacementUsd[0])} – ${money(i.replacementUsd[2])} <span class="muted">unit cost (design assumption) plus launch at the published Falcon 9 list price per kg; an estimate, not an official price</span></dd>
      </dl>
      <p class="muted lab-note">${esc(i.weatherNote)} Snapshot ${esc(i.snapshotId)}.</p>
      <p class="lab-src">Elements: <a href="https://celestrak.org/NORAD/elements/gp.php?CATNR=${i.norad}&FORMAT=json" target="_blank" rel="noopener">CelesTrak GP</a> (retrieved ${esc(this.summary?.retrieved.slice(0, 16) ?? '')})</p>
    </div></div>`;
  }

  private cardFacts(i: SatInfo) {
    return { title: i.name, lede: `${i.operator}, observed (${i.age} elements).`, facts: [{ k: 'Epoch', v: isoDay(Date.parse(i.epochIso)), t: 'R' as const }, { k: 'Orbit', v: `${fmtNum(i.orbit.perigeeKm)} × ${fmtNum(i.orbit.apogeeKm)} km`, t: 'R' as const }, { k: 'Ballistic coefficient', v: `${fmtNum(i.ballistic.low)}–${fmtNum(i.ballistic.high)} kg/m²`, t: 'E' as const }] };
  }

  private renderMode(): void {
    const el = this.$('.ob-mode');
    if (el.dataset.mode === this.mode) return;
    el.dataset.mode = this.mode;
    el.innerHTML = MODES.map((m) => `<label><input type="radio" name="ob-mode" value="${m}" data-ctl="mode"${m === this.mode ? ' checked' : ''}> ${esc(MODE_LABEL[m])}</label>`).join('') + `<span class="muted">Observed now: 81-day F10.7 ${SPACE_WEATHER ? fmtNum(SPACE_WEATHER.stats.recent.slice(-81).reduce((a, r) => a + r[2], 0) / Math.min(81, SPACE_WEATHER.stats.recent.length)) : '—'} sfu, latest daily Ap ${SPACE_WEATHER?.stats.recent.at(-1)?.[1] ?? '—'} (GFZ, ${esc(SPACE_WEATHER?.stats.lastDate ?? '')})</span>`;
  }

  private loadFleet(): void {
    const year = this.host.year(), sim = this.host.sim, key = `${sim.seed}:${sim.stepAt(year)}:${this.mode}`;
    if (key === this.fleetKey) return;
    this.fleetKey = key;
    sim.data<'fleet'>({ type: 'fleet', year }).then((m) => this.renderFleet(m));
  }

  private lastFleet: Awaited<ReturnType<DataHost['sim']['data']>> | null = null;
  private renderFleet(m: Extract<Awaited<ReturnType<DataHost['sim']['data']>>, { type: 'fleet' }>): void {
    this.lastFleet = m;
    const el = this.$('.ob-fleet'), sim = this.host.sim, step = sim.stepAt(this.host.year()), g = (k: string) => sim.metric(step, GM[k]);
    const f = m.fleet;
    const n = sim.frontier + 1, xs = sim.years.slice(0, n).map((y) => 2040 + y);
    const series = (k: string) => Array.from({ length: n }, (_, s) => sim.metric(s, GM[k]));
    const tradeCost = MODES.map((md) => ({ label: md, color: MODE_COLOR[md], xs: m.trade[md].map((r) => r.altKm), ys: m.trade[md].map((r) => r.costPerSlotYear), dash: md === 'storm' ? '6 3' : '' }));
    const tradeLife = MODES.map((md) => ({ label: md, color: MODE_COLOR[md], xs: m.trade[md].map((r) => r.altKm), ys: m.trade[md].map((r) => r.lifeYears), dash: md === 'storm' ? '6 3' : '' }));
    el.innerHTML = !f ? '<p class="muted">Earth has no living civilisation at this year, so there is no fleet.</p>' : `
      <p class="lab-note muted">Simulated: ${esc(FLEET_2040.source)}, ${fmtNum(FLEET_2040.low)}–${fmtNum(FLEET_2040.high)} in 2040, growing with √(Earth product). Solar cycle ${m.cycle?.n ?? '—'}${m.cycle?.grand ? ' (a grand minimum)' : ''}: smoothed sunspot number ${fmtNum(m.cycle?.ssn ?? NaN)}, F10.7 ${fmtNum(m.cycle?.f107a ?? NaN)} sfu, seeded from the 24 recorded cycles.</p>
      <div class="ec-cards">
        <div class="ec-card"><p class="muted">Satellites in service</p><p class="ec-v num">${fmtNum(g('orbitSats'))}</p><p class="muted ec-s">${classBadge('simulated')} aggregate shells</p></div>
        <div class="ec-card"><p class="muted">Replacements</p><p class="ec-v num">${fmtNum(g('orbitReplacements'))}/yr</p><p class="muted ec-s">${fmtNum(g('orbitPropellant'))} t/yr stationkeeping propellant</p></div>
        <div class="ec-card"><p class="muted">Replacement and launch spending</p><p class="ec-v num">${money(g('orbitSpend'))}/yr</p><p class="muted ec-s">at ${money(m.leoCostPerKg)}/kg to orbit (launch economics)</p></div>
        <div class="ec-card"><p class="muted">Lost to storms</p><p class="ec-v num">${fmtNum(g('orbitStormLoss'))}/yr</p><p class="muted ec-s">${fmtNum(g('stormDays'))} storm days/yr (Ap ≥ 50)</p></div>
        <div class="ec-card"><p class="muted">Availability</p><p class="ec-v num">${g('orbitAvailability').toFixed(3)}%</p><p class="muted ec-s">losses not yet replaced</p></div>
      </div>
      <table class="dtable"><thead><tr><th scope="col" class="txt">shell</th><th scope="col" class="txt">class</th><th scope="col">satellites</th><th scope="col">density</th><th scope="col">Δv / sat / yr</th><th scope="col">propellant / sat / yr</th><th scope="col">operating life</th><th scope="col">replacements / yr</th><th scope="col">spend / yr</th></tr></thead><tbody>${f.shells.map((s) => {
        const d = SHELLS.find((x) => x.id === s.id)!;
        return `<tr class="cls-sim"><th scope="row" class="txt">${esc(d.label)}</th><td class="txt">${esc(d.cls)}</td><td>${fmtNum(s.sats)}</td><td>${sci(s.rhoKgM3)}</td><td>${fmtNum(s.dvMsPerSatYear)} m/s</td><td>${s.propKgPerSatYear.toFixed(2)} kg</td><td>${yrs(s.lifeYears)}</td><td>${fmtNum(s.replacementsPerYear)}</td><td>${money(s.spendPerYear)}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="muted lab-note">MEO and GEO feel no meaningful drag; their stationkeeping fights lunisolar and radiation-pressure perturbations, which are acknowledged here, not modelled.</p>
      <div class="lab-grid">
        <div class="lab-card"><h4>Cost of holding one satellite slot, by altitude</h4>${lineChart(tradeCost, { xLabel: 'altitude (km)', yLabel: '$ per slot-year', yLog: true, fmtX: (x) => fmtNum(x), fmtY: (y) => money(y) })}<p class="muted lab-note">Starlink v2 mini class, nominal values: lower shells pay in propellant and shorter lives, more so when the Sun is active.</p></div>
        <div class="lab-card"><h4>Operating life, by altitude</h4>${lineChart(tradeLife, { xLabel: 'altitude (km)', yLabel: 'operating life (yr)', fmtX: (x) => fmtNum(x), fmtY: (y) => yrs(y) })}</div>
        <div class="lab-card"><h4>The seeded Sun over this future</h4>${lineChart([{ label: 'F10.7 (81-day)', color: '#c98500', xs, ys: series('solarF107') }], { xLabel: 'year', yLabel: 'F10.7 (sfu)', fmtX: (x) => String(Math.round(x)) })}</div>
        <div class="lab-card"><h4>Fleet spending over this future</h4>${lineChart([{ label: 'replacement and launch', color: '#3987e5', xs, ys: series('orbitSpend') }], { xLabel: 'year', yLabel: '$/yr', yLog: true, fmtX: (x) => String(Math.round(x)), fmtY: (y) => money(y) })}</div>
      </div>`;
    wireCharts(el);
  }

  private renderStarlink(): void {
    const el = this.$('.ob-starlink'), s = this.summary?.starlink;
    if (!s) { el.innerHTML = '<p class="muted">Running the validation…</p>'; return; }
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const LBL: Record<string, string> = { model: 'calibrated model, observed daily Ap', 'fang-low': 'storm density +50% (Fang et al., low end)', 'fang-high': 'storm density +125% (Fang et al., high end)' };
    const w = SPACE_WEATHER?.stats.starlink2022 ?? [];
    el.innerHTML = `<div class="lab-grid"><div class="lab-card">
      <p class="lab-note">On 3 February 2022, 49 Starlink satellites were deployed into a low insertion orbit (perigee ≈ 210 km). A minor-to-moderate geomagnetic storm (daily Ap ${w.filter((r) => r[0] >= '2022-02-03' && r[0] <= '2022-02-04').map((r) => r[1]).join(' and ')} on 3–4 February) raised thermospheric density, and <strong>38 of 49 (78%)</strong> reentered (Fang et al. 2022, <a href="https://doi.org/10.1029/2022SW003193" target="_blank" rel="noopener">Space Weather 20, e2022SW003193</a>).</p>
      <table class="dtable"><thead><tr><th scope="col" class="txt">model run (49 sampled satellites)</th><th scope="col">lost</th></tr></thead><tbody>
        <tr><th scope="row" class="txt">Observed</th><td><strong>78%</strong></td></tr>
        ${s.model.map((r) => `<tr><th scope="row" class="txt">${esc(LBL[r.label] ?? r.label)}</th><td>${(r.lost * 100).toFixed(0)}%</td></tr>`).join('')}
        <tr><th scope="row" class="txt">Same launch, quiet conditions (counterfactual)</th><td>${(s.quiet * 100).toFixed(0)}%</td></tr>
        ${s.higher.map((r) => `<tr><th scope="row" class="txt">Storm (+125%), ${esc(r.label)}</th><td>${(r.lost * 100).toFixed(0)}%</td></tr>`).join('')}
      </tbody></table>
      <p class="muted lab-note">The qualitative result is reproduced: a low insertion orbit plus storm-time density means heavy losses, while a quiet thermosphere or a higher insertion means none. The empirical model alone underestimates the size of the loss, as Fang et al. found for NRLMSISE-00 in the operator's pre-launch analysis; the physics-based enhancement they report closes most of the gap. Satellite properties are class priors, not SpaceX data.</p>
    </div></div>`;
  }

  private renderMissions(): void {
    const el = this.$('.ob-missions'), tools = this.$('.ob-mtools');
    const key = `${this.statusFilter}|${this.orgFilter}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const orgs: OrgId[] = ['nasa', 'spacex', 'blueOrigin', 'amazon', 'ula', 'arianespace', 'esa'];
    tools.innerHTML = `<label>Status <select data-ctl="mstatus"><option value="all">all</option>${(['historical', 'active', 'scheduled', 'contracted', 'announced'] as Classification[]).map((c) => `<option value="${c}"${this.statusFilter === c ? ' selected' : ''}>${esc(CLASS_STYLE[c].label)}</option>`).join('')}</select></label>
      <label>Organisation <select data-ctl="morg"><option value="all">any role</option>${orgs.map((o) => `<option value="${o}"${this.orgFilter === o ? ' selected' : ''}>${esc(ORGS[o].name)}</option>`).join('')}</select></label>
      <span class="muted">${this.missions.length} curated records, merged by designator, launch id and date (never by name alone). Simulated missions after 2040 are in Launch economics.</span>`;
    const list = this.missions.filter((m) => (this.statusFilter === 'all' || m.status === this.statusFilter) && (this.orgFilter === 'all' || m.orgs.some((o) => o.org === this.orgFilter)))
      .sort((a, b) => (a.launched ?? a.window?.start ?? '').localeCompare(b.launched ?? b.window?.start ?? ''));
    const satcatOk = (m: Mission) => {
      if (!m.cospar || !SATCAT) return '';
      const recs = SATCAT.records[m.cospar.slice(0, 8)] ?? [];
      const hit = recs.find((r) => r.objectId.startsWith(m.cospar!.length > 8 ? m.cospar! : m.cospar!.slice(0, 8)));
      const ok = hit && m.launched && hit.launch === m.launched.slice(0, 10);
      return hit ? (ok ? ' <span title="Designator and launch date match the CelesTrak SATCAT snapshot">✓</span>' : ' <span class="lab-warn" title="SATCAT launch date differs">≠</span>') : '';
    };
    el.innerHTML = `<table class="dtable"><thead><tr><th scope="col" class="txt">date (UTC)</th><th scope="col" class="txt">mission</th><th scope="col" class="txt">status</th><th scope="col" class="txt">launch provider · vehicle</th><th scope="col" class="txt">payload owner</th><th scope="col" class="txt">customer</th><th scope="col" class="txt">site</th><th scope="col" class="txt">category</th><th scope="col" class="txt">outcome</th><th scope="col" class="txt">COSPAR</th><th scope="col" class="txt">official contract value</th><th scope="col" class="txt">sources</th></tr></thead><tbody>${list.map((m) => {
      const date = m.launched ? m.launched.slice(0, 16).replace('T', ' ') : m.window ? `window ${m.window.start}${m.window.end ? ` – ${m.window.end}` : ''}` : '—';
      const owners = [...new Set(m.payloads.map((p) => orgName(p.owner)))].join(', ');
      const fac = FACILITIES.find((f) => f.id === m.launchSite);
      const rec = m.recovery ? ` · recovery: ${m.recovery.kind}, ${m.recovery.outcome}` : '';
      return `<tr${isFlown(m) ? '' : ' class="cls-sim"'}><th scope="row" class="txt num">${esc(date)}</th><td class="txt" title="${esc(m.note ?? m.target)}">${esc(m.name)}</td><td class="txt">${classBadge(m.status)}</td>
        <td class="txt">${esc(m.launchProvider ? orgName(m.launchProvider) : '—')} · ${esc(m.vehicle)}${m.variant ? ` ${esc(m.variant)}` : ''}</td><td class="txt">${esc(owners)}</td><td class="txt">${esc(m.customers.map(orgName).join(', ') || '—')}</td>
        <td class="txt">${esc(fac?.name ?? '—')}</td><td class="txt">${esc(m.categories.map((c) => CATEGORY_LABEL[c]).join(', '))}</td><td class="txt">${esc(m.outcome)}${esc(rec)}</td>
        <td class="txt num">${esc(m.cospar ?? '—')}${satcatOk(m)}</td>
        <td class="txt">${m.contract ? `<a href="${esc(m.contract.source.url)}" target="_blank" rel="noopener" title="${esc(m.contract.scope)}">${money(m.contract.usd)} (${m.contract.year})</a>` : '<span class="muted">none published here</span>'}</td>
        <td class="txt lab-src">${m.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.organization)}</a>`).join('; ')}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted lab-note">Roles stay separate: on TESS, NASA is programme owner, payload owner and launch-services manager, SpaceX the launch provider. Contract values are NASA-published totals for a launch service, never a provider's internal cost. Plans show their target window and never an outcome.</p>`;
    void withRole;
  }

  private renderPlans(): void {
    const el = this.$('.ob-plans');
    if (el.innerHTML) return;
    el.innerHTML = `<table class="dtable"><thead><tr><th scope="col" class="txt">plan</th><th scope="col" class="txt">owner</th><th scope="col" class="txt">shells (altitude, inclination, satellites)</th><th scope="col">authorised</th><th scope="col" class="txt">source</th></tr></thead><tbody>${CONSTELLATION_PLANS.map((p) => `<tr><th scope="row" class="txt">${esc(p.name)} ${classBadge(p.status)}</th><td class="txt">${esc(orgName(p.owner))}</td><td class="txt">${p.shells.map((s) => `${s.altKm} km · ${s.incDeg}° · ${fmtNum(s.count)}`).join('; ')}</td><td>${fmtNum(p.authorizedTotal)}</td><td class="txt lab-src"><a href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(p.source.organization)}</a>${p.note ? ` · ${esc(p.note)}` : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  private renderFacilities(): void {
    const el = this.$('.ob-fac');
    if (el.innerHTML) return;
    const y0 = 1960, y1 = 2030, W = 560, rowH = 16, L = 210;
    const fx = (d: string) => L + ((Number(d.slice(0, 4)) + (Number(d.slice(5, 7)) - 1) / 12 - y0) / (y1 - y0)) * (W - L - 10);
    const rows = FACILITIES.map((f, i) => `<text x="${L - 6}" y="${i * rowH + 12}" text-anchor="end">${esc(f.name.length > 34 ? f.name.slice(0, 33) + '…' : f.name)}</text><line class="grid" x1="${L}" x2="${W - 10}" y1="${i * rowH + 8}" y2="${i * rowH + 8}"/>${f.events.map((e) => `<circle cx="${fx(e.date).toFixed(1)}" cy="${i * rowH + 8}" r="4" fill="${CLASS_STYLE[f.status].color}" stroke="#08080a" stroke-width="2"><title>${esc(`${e.date}: ${e.what} (${e.source})`)}</title></circle>`).join('')}`).join('');
    const axis = [1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030].map((y) => `<text x="${fx(`${y}-01`)}" y="${FACILITIES.length * rowH + 14}" text-anchor="middle">${y}</text>`).join('');
    el.innerHTML = `<svg class="lab-svg" viewBox="0 0 ${W} ${FACILITIES.length * rowH + 20}" role="img" aria-label="Sourced facility events over time">${rows}${axis}</svg>
      <p class="muted lab-note">Only sourced dates are drawn; a facility without one has no dots. Hover a dot for the event.</p>
      <div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col" class="txt">facility</th><th scope="col" class="txt">type</th><th scope="col" class="txt">owner</th><th scope="col" class="txt">operator</th><th scope="col" class="txt">status</th><th scope="col" class="txt">coordinates</th><th scope="col" class="txt">vehicles</th><th scope="col" class="txt">source</th></tr></thead><tbody>${FACILITIES.map((f) => `<tr><th scope="row" class="txt">${esc(f.name)}</th><td class="txt">${esc(f.type)}</td><td class="txt">${esc(orgName(f.owner))}</td><td class="txt">${esc(orgName(f.operator))}</td><td class="txt">${classBadge(f.status)} ${esc(f.operational)}</td><td class="txt num">${f.lat === null ? 'mobile' : `${f.lat.toFixed(3)}, ${f.lon!.toFixed(3)} ±${f.coordPrecisionDeg}°`}</td><td class="txt">${esc(f.vehicles.join(', '))}</td><td class="txt lab-src"><a href="${esc(f.provenance.url)}" target="_blank" rel="noopener">${esc(f.provenance.organization)}</a>${f.provenance.note ? ` · ${esc(f.provenance.note)}` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- events

  private click(e: Event): void {
    const t = e.target as HTMLElement, act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const hit = t.closest<HTMLElement>('[data-norad]');
    if (hit) { this.openSat(Number(hit.dataset.norad)); return; }
    if (act === 'earth') { this.host.selectBody(this.host.world.earth); return; }
    const status = this.$('.copy-status');
        if (act === 'csv-m') void copyText(toCsv(['id', 'name', 'status', 'cospar', 'launched_utc', 'window_start', 'window_end', 'launch_provider', 'vehicle', 'payload_owners', 'customers', 'site', 'categories', 'outcome', 'contract_usd', 'contract_source', 'sources', 'retrieved'], this.missions.map((m) => [m.id, m.name, m.status, m.cospar ?? '', m.launched ?? '', m.window?.start ?? '', m.window?.end ?? '', m.launchProvider ?? '', m.vehicle, [...new Set(m.payloads.map((p) => p.owner))].join(' '), m.customers.join(' '), m.launchSite ?? '', m.categories.join(' '), m.outcome, m.contract?.usd ?? '', m.contract?.source.url ?? '', m.sources.map((s) => s.url).join(' '), m.sources[0]?.retrieved ?? '']), `Mission registry · snapshot ${SNAPSHOT_ID}`), 'The mission registry', status);
    if (act === 'json-m') void copyText(toJson({ snapshotId: SNAPSHOT_ID, missions: this.missions, facilities: FACILITIES, constellationPlans: CONSTELLATION_PLANS }, 'Missions, facilities and plans'), 'The registry', status);
    if (act === 'json-sat' && this.info) void copyText(toJson({ snapshotId: SNAPSHOT_ID, seed: this.host.sim.seed, object: this.info }, `Observed object ${this.info.name}`), 'The analysis', status);
    if (act === 'csv-fleet') {
      const m = this.lastFleet as Extract<Awaited<ReturnType<DataHost['sim']['data']>>, { type: 'fleet' }> | null;
      if (m?.fleet) void copyText(toCsv(['shell', 'class', 'satellites', 'density_kg_m3', 'dv_m_s_per_sat_yr', 'propellant_kg_per_sat_yr', 'life_yr', 'replacements_per_yr', 'spend_usd_per_yr'], m.fleet.shells.map((s) => [s.id, SHELLS.find((x) => x.id === s.id)!.cls, s.sats, s.rhoKgM3, s.dvMsPerSatYear, s.propKgPerSatYear, s.lifeYears, s.replacementsPerYear, s.spendPerYear]), `Simulated fleet at ${fmtYear(this.host.year())} · seed ${this.host.sim.seed} · snapshot ${SNAPSHOT_ID}`), 'The fleet', status);
    }
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement, c = t.dataset.ctl;
    if (c === 'show') { observedLayer.on = t.checked; this.loadObserved(); }
    if (c === 'sim') { observedLayer.simulated = t.checked; observedLayer.version++; }
    if (c === 'color') { this.colorBy = t.value as typeof this.colorBy; this.loadObserved(); }
    if (c === 'offset') { this.offsetH = Number(t.value); this.renderNow(); this.loadObserved(); if (this.infoFor >= 0) this.openSat(this.infoFor); }
    if (c === 'mode') { this.mode = t.value as AtmoMode; this.renderMode(); this.renderInfo(); }
    if (c === 'mstatus') { this.statusFilter = t.value as typeof this.statusFilter; this.renderMissions(); }
    if (c === 'morg') { this.orgFilter = t.value as typeof this.orgFilter; this.renderMissions(); }
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.ctl !== 'q') return;
    const q = t.value;
    this.host.sim.data<'satSearch'>({ type: 'satSearch', q }).then((m) => {
      if (t.value !== q) return;
      this.$('.ob-hits').innerHTML = m.hits.map((h) => `<button class="link" type="button" data-norad="${h.norad}">${esc(h.name)} <span class="muted num">${h.norad} · ${fmtNum(h.altKm)} km</span></button>`).join(' · ') || (q ? '<span class="muted">no match</span>' : '');
    });
  }
}
