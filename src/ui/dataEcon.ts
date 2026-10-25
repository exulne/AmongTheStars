// "Launch economics": what moving people and cargo cost in this future, from the
// mission records the engine priced (launchEconomics.ts). Summary cards and the
// year's cost breakdown come from the global series; the mission table, its
// inspector (envelope, Monte Carlo, sensitivity, provenance) and the exports
// come from the records. Scenario controls reprice the same missions under other
// assumptions without touching the simulated history.

import {
  ASSUMPTIONS_VERSION, COST_GROUP, COST_KEYS, COST_LABELS, CURRENCY, KIND, MC, MC_NAMES, MODEL_VERSION, NMC, OUTCOME_NAMES, RETURN_MODES, STARSHIP_CONFIGS, VEHICLES,
  assumptionsTable, envelope, evaluate, getRange, monteCarlo, scenario, sensitivity, unpackMission,
  type Assumptions, type CostKey, type ScenarioId, type VehicleId,
} from '../sim/launchEconomics.ts';
import { GM } from '../sim/metrics.ts';
import { AnalystChart, type ALine } from './analystChart.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtNum, fmtYear } from './format.ts';
import { names } from './names.ts';

type Group = 'hardware' | 'propellant' | 'operations' | 'risk' | 'infrastructure' | 'missionHardware';
// validated categorical slots (dataviz reference dark steps, on the desk's near-black ground)
const GROUPS: { id: Group; label: string; metric: string; color: string }[] = [
  { id: 'hardware', label: 'Vehicle hardware', metric: 'hardwareSpend', color: '#3987e5' },
  { id: 'propellant', label: 'Propellant', metric: 'propellantSpend', color: '#d95926' },
  { id: 'operations', label: 'Operations', metric: 'operationsSpend', color: '#199e70' },
  { id: 'risk', label: 'Insurance and risk', metric: 'riskSpend', color: '#c98500' },
  { id: 'infrastructure', label: 'Infrastructure', metric: 'infraSpend', color: '#d55181' },
  { id: 'missionHardware', label: 'Mission hardware', metric: 'missionHwSpend', color: '#9085e9' },
];
const GROUP_COLOR = Object.fromEntries(GROUPS.map((g) => [g.id, g.color])) as Record<Group, string>;
const KIND_LABEL: Record<string, string> = { crew: 'crewed outpost', service: 'passenger service', interstellar: 'interstellar colony ship', warp: 'warp ship' };
const VEHICLE_LABEL: Record<VehicleId, string> = { starship: 'Starship / Super Heavy', ntp: 'Nuclear thermal transport', fusion: 'Fusion torch transport', fusionArk: 'Fusion colony ship', generation: 'Generation ship', seed: 'Embryo seed ship', warp: 'Warp ship' };
/** the major unknowns an analyst may set by hand */
const KNOBS: { path: string; scale: number; unit: string }[] = [
  { path: 'starship.shipBuildCost', scale: 1e6, unit: '$M' },
  { path: 'starship.boosterBuildCost', scale: 1e6, unit: '$M' },
  { path: 'starship.shipDesignLifeFlights', scale: 1, unit: 'flights' },
  { path: 'starship.boosterDesignLifeFlights', scale: 1, unit: 'flights' },
  { path: 'starship.refurbishmentPerFlight', scale: 1e6, unit: '$M/flight' },
  { path: 'starship.annualInfrastructureFlights', scale: 1, unit: 'launches/site/yr' },
  { path: 'starship.transferEfficiency', scale: 1, unit: '' },
  { path: 'starship.tankerPayloadKg', scale: 1000, unit: 't' },
  { path: 'starship.missionFailureProbability', scale: 1, unit: '/launch' },
  { path: 'commodities.methaneFeedstock', scale: 1, unit: '$/kg' },
];

/** trailing window of the over-time chart, years */
const SMOOTH = 100;
const TREND = [{ label: 'All transport', metric: 'transportSpend', color: '#3987e5' }, { label: 'Scheduled passenger services', metric: 'serviceSpend', color: '#d95926' }];
const money = (v: number) => (Number.isFinite(v) ? `$${fmtNum(v)}` : '—');
const share = (v: number) => (v === 0 ? '0%' : v < 0.01 ? `${v.toPrecision(2)}%` : `${v.toFixed(2)}%`);
const kg = (v: number) => (v >= 1000 ? `${fmtNum(v / 1000)} t` : `${fmtNum(v)} kg`);

export class EconTab implements DataTab {
  id = 'econ';
  label = 'Launch economics';
  el: HTMLElement;
  private host: DataHost;
  private rows: Float64Array = new Float64Array(0);
  private rowsKey = '';
  private asking = false;
  private simScenario = 'baseline';
  private sel = -1;
  private selRow: Float64Array | null = null;
  private scen: ScenarioId = 'baseline';
  private config = 'starship-2040';
  private knobs = new Map<string, number>();
  private kindFilter = 'all';
  private limit = 200;
  private repriced = new Map<number, number>();
  private repricedKey = '';
  private mc = new Map<number, { p10: number; p50: number; p90: number; n: number }>();
  /** the tornado for the open mission, under the assumptions it was ranked with */
  private sens: { key: string; html: string } | null = null;
  private inspKey = '';
  private chart = new AnalystChart({ label: 'Transport spending over time', log: true });
  private chartKey = '';

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'econ';
    this.el.innerHTML = `
      <p class="ec-note muted">A transparent scenario model built from public evidence (SpaceX vehicle figures, FAA launch-site filings, NASA cost-estimating practice, EIA prices). It does not know or predict any company's confidential costs: every input is a range with its source, and every figure below is a <strong>fully burdened economic cost</strong> in ${esc(CURRENCY)}, never a customer price. Model ${MODEL_VERSION}, assumptions ${ASSUMPTIONS_VERSION}.</p>
      <div class="ec-cards"></div>
      <h3 class="data-h ec-year-h">Where the money went</h3>
      <div class="ec-break"></div>
      <p class="muted ec-chart-h">Transport spending over the whole future, ${'$'}/yr, averaged over the trailing ${SMOOTH} years: single colony ships are lumpy, so the cards above show the step itself. Drag to zoom; click to move the year.</p>
      <div class="ec-chart"></div>
      <p class="g-legend">${TREND.map((x) => `<span class="g-key"><i style="background:${x.color}"></i>${esc(x.label)}</span>`).join(' ')}</p>
      <h3 class="data-h">Assumptions</h3>
      <div class="ec-scen"></div>
      <h3 class="data-h">Missions</h3>
      <div class="data-tools ec-tools"></div>
      <div class="ec-insp" hidden></div>
      <div class="tbl-scroll short ec-tbl"></div>
      <div class="data-actions">
        <button class="link" type="button" data-act="csv">Copy missions (CSV)</button>
        <button class="link" type="button" data-act="json">Copy missions and assumptions (JSON)</button>
        <button class="link" type="button" data-act="ass">Copy the assumption table (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>`;
    this.$('.ec-chart').append(this.chart.el);
    this.chart.onPick = (y) => this.host.pickYear?.(y);
    this.el.addEventListener('click', (e) => this.click(e));
    this.el.addEventListener('change', (e) => this.change(e));
  }

  private $<T extends HTMLElement = HTMLElement>(s: string): T { return this.el.querySelector<T>(s)!; }

  /** Open one mission's economics (from a ship card or a launch event). */
  open(mission: number): void {
    this.sel = mission;
    this.selRow = null;
    this.host.sim.data<'mission'>({ type: 'mission', mission }).then((m) => { if (this.sel === mission) { this.selRow = m.row; this.render(); this.$('.ec-insp').scrollIntoView?.({ block: 'nearest' }); } });
    this.render();
  }

  refresh(): void {
    const sim = this.host.sim;
    if (!sim.years.length) { this.$('.ec-cards').innerHTML = '<p class="muted">Waiting for the run…</p>'; return; }
    const step = sim.stepAt(this.host.year()), key = `${sim.seed}:${step}:${sim.frontier}`;
    if (key !== this.rowsKey && !this.asking) {
      this.asking = true;
      const year = sim.years[step];
      sim.data<'missions'>({ type: 'missions', year }).then((m) => {
        this.asking = false;
        this.rows = m.rows; this.simScenario = m.scenario; this.rowsKey = key;
        this.render();
      });
    }
    this.render();
  }

  // ---------------------------------------------------------------- assumptions

  private assumptions(): Assumptions {
    const a = scenario(this.scen === 'custom' ? 'baseline' : this.scen, this.config);
    for (const [p, v] of this.knobs) { const r = getRange(a, p); if (r) r.base = v; }
    if (this.knobs.size) a.scenario = 'custom';
    return a;
  }
  private repricing(): boolean { return this.scen !== 'baseline' || this.config !== 'starship-2040' || this.knobs.size > 0; }
  private assKey(): string { return `${this.scen}|${this.config}|${[...this.knobs].map(([k, v]) => `${k}=${v}`).join(',')}`; }

  private reprice(id: number, o: number, rows: ArrayLike<number>, a: Assumptions): number {
    const key = this.assKey();
    if (key !== this.repricedKey) { this.repriced.clear(); this.repricedKey = key; }
    let v = this.repriced.get(id);
    if (v === undefined) { const { spec, ctx } = unpackMission(rows, o); const e = evaluate(spec, ctx, a); v = e.feasible ? e.total : NaN; this.repriced.set(id, v); }
    return v;
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const sim = this.host.sim;
    if (!sim.years.length) return;
    const step = sim.stepAt(this.host.year());
    const g = (k: string) => sim.metric(step, GM[k]);
    const yearTxt = fmtYear(sim.years[step]);
    const cards: [string, string, string][] = [
      ['Spending this year', money(g('transportSpend')) + '/yr', `${money(g('serviceSpend'))}/yr of it on scheduled passenger services`],
      ['Cumulative since 2040', money(g('transportCum')), 'every mission and service so far'],
      ['Average cost per kg', g('costPerKg') > 0 ? `${money(g('costPerKg'))}/kg` : 'nothing flew', `Earth to orbit: ${money(g('leoCostPerKg'))}/kg`],
      ['Payload dispatched', `${fmtNum(g('payloadDispatched'))} t/yr`, `${fmtNum(g('peopleTransported'))} people a year`],
      ['Campaigns and launches', `${fmtNum(g('campaigns'))} / ${fmtNum(g('launches'))} a year`, `${fmtNum(g('tankerFlights'))} of the launches are tankers`],
      ['Share of product', share(g('transportShare')), 'of all of humanity\'s product'],
    ];
    this.$('.ec-cards').innerHTML = cards.map(([k, v, s]) => `<div class="ec-card"><p class="muted">${esc(k)}</p><p class="ec-v num">${esc(v)}</p><p class="muted ec-s">${esc(s)}</p></div>`).join('');
    this.$('.ec-year-h').textContent = `Where the money went in ${yearTxt}`;
    this.renderBreak(GROUPS.map((x) => ({ ...x, v: g(x.metric) })), 'transport spending this year, by cost group');
    this.renderChart();
    this.renderScen();
    this.renderTable();
    this.renderInspector();
  }

  /** One stacked bar (2px gaps), a legend that is also the table view: value and share per group. */
  private renderBreak(parts: { id: Group; label: string; color: string; v: number }[], what: string, into = this.$('.ec-break')): void {
    const tot = parts.reduce((s, p) => s + Math.max(0, p.v), 0);
    if (!(tot > 0)) { into.innerHTML = '<p class="muted">Nothing was spent on transport in this step.</p>'; return; }
    const seg = parts.filter((p) => p.v > 0).map((p) => `<span class="ec-seg" style="flex-grow:${p.v / tot};background:${p.color}" title="${esc(p.label)}: ${money(p.v)} (${share(100 * p.v / tot)})"></span>`).join('');
    const legend = parts.map((p) => `<li><i style="background:${p.color}"></i>${esc(p.label)}<span class="num">${money(p.v)}</span><span class="num muted">${share(100 * p.v / tot)}</span></li>`).join('');
    into.innerHTML = `<div class="ec-bar" role="img" aria-label="${esc(what)}">${seg}</div><ul class="ec-legend">${legend}</ul>`;
  }

  private renderChart(): void {
    const sim = this.host.sim, key = `${sim.seed}:${sim.frontier}`;
    if (key === this.chartKey) { this.chart.set({ ...this.chartData(), cursor: this.host.year() }); return; }
    this.chartKey = key;
    this.chart.set({ ...this.chartData(), cursor: this.host.year() });
  }
  private chartData(): { lines: ALine[]; empty: string } {
    const sim = this.host.sim, n = sim.frontier + 1;
    const xs = sim.years.slice(0, n);
    // trailing average of each rate: (spent since year − SMOOTH) / years, from the running sum
    const lines = TREND.map((x) => {
      const cum = new Float64Array(n), ys = new Float64Array(n);
      for (let s = 1; s < n; s++) cum[s] = cum[s - 1] + sim.metric(s, GM[x.metric]) * (xs[s] - xs[s - 1]);
      for (let s = 1, j = 0; s < n; s++) {
        while (xs[j + 1] <= xs[s] - SMOOTH) j++;
        ys[s] = (cum[s] - cum[j]) / Math.max(1e-9, xs[s] - xs[j]);
      }
      return { label: x.label, color: x.color, xs, ys, unit: '$/yr' };
    });
    return { lines, empty: 'Waiting for the run…' };
  }

  private renderScen(): void {
    const a = this.assumptions(), el = this.$('.ec-scen');
    if (el.dataset.key === this.assKey()) return;
    el.dataset.key = this.assKey();
    const knob = (k: typeof KNOBS[number]) => {
      const r = getRange(a, k.path)!, set = this.knobs.has(k.path);
      return `<label class="ec-knob" title="${esc(`${r.label}. ${r.classification} · ${r.confidence} confidence · ${r.sourceTitle}${r.note ? ` · ${r.note}` : ''}`)}"><span>${esc(r.label)} <span class="muted">[${r.classification}]</span></span>
        <input type="number" step="any" data-knob="${k.path}" value="${+(r.base / k.scale).toPrecision(4)}"${set ? ' class="on"' : ''} aria-label="${esc(r.label)}"> <span class="muted">${esc(k.unit)} · range ${+(r.low / k.scale).toPrecision(3)}–${+(r.high / k.scale).toPrecision(3)}</span></label>`;
    };
    el.innerHTML = `
      <div class="data-tools">
        <label>Scenario <select data-ctl="scen">${(['baseline', 'conservative', 'optimistic'] as const).map((s) => `<option value="${s}"${this.scen === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label>
        <label>Starship configuration <select data-ctl="config">${STARSHIP_CONFIGS.map((c) => `<option value="${c.id}"${this.config === c.id ? ' selected' : ''}>${esc(c.version)}</option>`).join('')}</select></label>
        ${this.knobs.size ? '<button class="link" type="button" data-act="reset">Reset hand-set values</button>' : ''}
      </div>
      <p class="muted">The run was simulated (and paid for) under <strong>${esc(this.simScenario)}</strong> with the mature-fleet configuration. Choosing another scenario reprices the same missions: who launched where and when stays as it happened. Conservative and optimistic move every uncertain input halfway from its base to its costlier or cheaper end. ${esc(STARSHIP_CONFIGS.find((c) => c.id === this.config)!.note)}</p>
      <details class="ec-adv"${this.knobs.size ? ' open' : ''}><summary>Set the major unknowns by hand</summary><div class="ec-knobs">${KNOBS.map(knob).join('')}</div></details>`;
  }

  private visible(): number[] {
    const R = this.rows, out: number[] = [];
    for (let i = R.length / NMC - 1; i >= 0; i--) {
      const kind = KIND[R[i * NMC + MC.kind]];
      if (this.kindFilter !== 'all' && kind !== this.kindFilter) continue;
      out.push(i);
    }
    return out;
  }

  private renderTable(): void {
    const R = this.rows, W = this.host.world, rep = this.repricing(), a = rep ? this.assumptions() : null;
    const vis = this.visible(), shown = vis.slice(0, this.limit);
    let sim = 0, re = 0, reSim = 0, none = 0;
    for (const i of vis) {
      sim += R[i * NMC + MC.total];
      if (!a) continue;
      const v = this.reprice(R[i * NMC + MC.id], i * NMC, R, a);
      // a mission no vehicle could fly under these assumptions is counted, not summed
      if (Number.isFinite(v)) { re += v; reSim += R[i * NMC + MC.total]; } else none++;
    }
    this.$('.ec-tools').innerHTML = `
      <label>Show <select data-ctl="kind">${['all', 'crew', 'interstellar', 'warp'].map((k) => `<option value="${k}"${this.kindFilter === k ? ' selected' : ''}>${k === 'all' ? 'every mission' : KIND_LABEL[k] + 's'}</option>`).join('')}</select></label>
      <span class="muted">${fmtNum(vis.length)} missions up to ${fmtYear(this.host.year())}, ${money(sim)} in all${a ? `; repriced under ${esc(a.scenario)}: <strong>${money(re)}</strong> (×${(re / (reSim || 1)).toFixed(2)}${none ? `; ${none} could not be flown at all under these assumptions` : ''})` : ''}. Scheduled passenger services are continuous and appear in the totals above, not as rows.</span>`;
    if (!vis.length) { this.$('.ec-tbl').innerHTML = `<p class="muted">${R.length ? 'No missions of this kind yet.' : 'No missions yet in this future.'}</p>`; return; }
    const tr = shown.map((i) => {
      const o = i * NMC, id = R[o + MC.id], f = (k: keyof typeof MC) => R[o + MC[k]];
      const route = `${names.place(W, f('from'))} → ${names.place(W, f('to'))}`;
      const pax = f('crew'), out = OUTCOME_NAMES[f('outcome')] ?? '';
      return `<tr data-m="${id}"${id === this.sel ? ' class="sel"' : ''}><th scope="row" class="txt"><button class="link num" type="button" data-act="pick" data-m="${id}">${fmtYear(f('year'))}</button></th>
        <td class="txt">${esc(route)}</td><td class="txt">${esc(VEHICLE_LABEL[VEHICLES[f('vehicle')]])}</td><td class="txt">${esc(KIND_LABEL[KIND[f('kind')]])}</td>
        <td>${kg(f('payloadKg'))}</td><td>${fmtNum(pax)}</td><td>${fmtNum(f('tankerFlights'))}</td>
        <td>${money(f('total'))}</td><td class="muted">${money(f('low'))}–${money(f('high'))}${f('envFlags') ? '*' : ''}</td>${a ? `<td>${money(this.reprice(id, o, R, a))}</td>` : ''}
        <td>${money(f('costPerKg'))}</td><td class="txt">${esc(out)}</td></tr>`;
    }).join('');
    this.$('.ec-tbl').innerHTML = `<table class="dtable"><thead><tr><th scope="col">year</th><th scope="col" class="txt">route</th><th scope="col" class="txt">vehicle</th><th scope="col" class="txt">mission</th>
      <th scope="col">payload</th><th scope="col">people</th><th scope="col">tankers</th><th scope="col">cost (base)</th><th scope="col">envelope</th>${a ? '<th scope="col">repriced</th>' : ''}<th scope="col">per kg</th><th scope="col" class="txt">outcome</th></tr></thead><tbody>${tr}</tbody></table>
      ${vis.length > shown.length ? `<p class="data-more"><button class="link" type="button" data-act="more">Show ${fmtNum(Math.min(200, vis.length - shown.length))} more</button></p>` : ''}
      <p class="muted">Envelope: every input at the end that lowers or raises cost, all at once; a bound on the assumptions, not a confidence interval (open a mission for p10–p90). * no campaign is feasible at the costly end, so the bound repeats the base.</p>`;
  }

  private rowOf(id: number): { rows: ArrayLike<number>; o: number } | null {
    const R = this.rows;
    for (let i = R.length / NMC - 1; i >= 0; i--) if (R[i * NMC + MC.id] === id) return { rows: R, o: i * NMC };
    return this.selRow ? { rows: this.selRow, o: 0 } : null;
  }

  private renderInspector(): void {
    const el = this.$('.ec-insp');
    if (this.sel < 0) { el.hidden = true; return; }
    el.hidden = false;
    const at = this.rowOf(this.sel);
    if (!at) { el.innerHTML = '<p class="muted">Reading the mission record…</p>'; this.inspKey = ''; return; }
    // the run keeps streaming: rebuild only when something shown here changed
    const key = `${this.sel}|${this.assKey()}|${this.mc.has(this.sel)}|${this.sens?.key ?? ''}|${at.rows[at.o + MC.outcome]}`;
    if (key === this.inspKey) return;
    this.inspKey = key;
    const { rows, o } = at, W = this.host.world, f = (k: keyof typeof MC) => rows[o + MC[k]];
    const { spec, ctx } = unpackMission(rows, o);
    const a = this.assumptions(), env = envelope(spec, ctx, a), base = env.base;
    const simA = scenario('baseline'), again = evaluate(spec, ctx, simA);
    const same = Math.abs(again.total - f('total')) <= 1e-9 * Math.max(1, f('total'));
    const kind = KIND[f('kind')], veh = VEHICLES[f('vehicle')];
    const fromN = names.place(W, f('from')), toN = names.place(W, f('to'));
    const comp = (k: CostKey) => `<tr><th scope="row" class="txt"><i class="ec-dot" style="background:${GROUP_COLOR[COST_GROUP[k]]}"></i>${esc(COST_LABELS[k])}</th><td class="muted">${money(env.low.feasible ? env.low.cost[k] : NaN)}</td><td>${money(base.cost[k])}</td><td class="muted">${money(env.high.feasible ? env.high.cost[k] : NaN)}</td><td class="muted">${share(100 * base.cost[k] / (base.total || 1))}</td></tr>`;
    const groups = GROUPS.map((x) => ({ ...x, v: COST_KEYS.filter((k) => COST_GROUP[k] === x.id).reduce((s, k) => s + base.cost[k], 0) }));
    const mc = this.mc.get(this.sel);
    const p = base.prop;
    el.innerHTML = `
      <button class="insp-close" type="button" data-act="close-m" aria-label="Close this mission">×</button>
      <h4 class="ec-ttl">${esc(fromN)} → ${esc(toN)}, ${fmtYear(f('year'))}</h4>
      <p class="muted">${esc(KIND_LABEL[kind])} · ${esc(VEHICLE_LABEL[veh])} (${esc(base.version)}) · return: ${esc(RETURN_MODES[f('returnMode')])} · ${esc(OUTCOME_NAMES[f('outcome')] ?? '')} · mission #${this.sel}${f('funder') >= 0 ? ` · paid for by ${esc(names.place(W, f('funder')))}` : ''}</p>
      <dl class="run-stamp">
        <dt>Total, ${esc(a.scenario)}</dt><dd class="num"><strong>${money(base.total)}</strong> <span class="muted">envelope ${money(env.low.feasible ? env.low.total : NaN)} to ${env.high.feasible ? money(env.high.total) : 'infeasible'}</span></dd>
        <dt>Monte Carlo</dt><dd class="num">${mc ? `p10 ${money(mc.p10)} · p50 ${money(mc.p50)} · p90 ${money(mc.p90)} <span class="muted">(${mc.n} seeded draws, triangular low/base/high${mc.p50 > base.total * 1.05 ? '; most ranges reach further above their base than below it, so the base case sits low in this distribution' : ''})</span>` : '<button class="link" type="button" data-act="mc">Run 400 seeded draws</button>'}</dd>
        <dt>Internal marginal cost</dt><dd class="num">${money(base.marginal)} <span class="muted">cash spent because this mission flies: propellant, refurbishment, operations, insurance, expended hardware</span></dd>
        <dt>Fully burdened cost</dt><dd class="num">${money(base.total)} <span class="muted">adds amortised hardware, infrastructure, expected loss and mission hardware; what the simulation spends</span></dd>
        <dt>Customer price (illustrative)</dt><dd class="num">${money(base.customerPrice)} <span class="muted">transport cost × (1 + ${a.mission.customerMargin.base} margin) [D]; a price, never a cost</span></dd>
        <dt>Per kg, per person</dt><dd class="num">${money(base.costPerKg)}/kg · ${spec.crew > 0 ? `${money(base.costPerPassenger)} per person` : '—'} <span class="muted">${kg(base.payloadKg)} useful payload${spec.crew ? `, ${fmtNum(spec.crew)} people` : ''}</span></dd>
        <dt>Campaign</dt><dd class="num">${fmtNum(base.ships)} mission vehicle${base.ships === 1 ? '' : 's'} · ${fmtNum(base.tankersPerShip)} tankers each (${fmtNum(base.tankerFlights)} in all) · ${fmtNum(base.depotLaunches)} depot · ${fmtNum(base.totalLaunches)} launches · tanker campaign ${money(base.tankerCost)}</dd>
        <dt>Propellant</dt><dd class="num">${kg(base.methaneKg)} methane + ${kg(base.oxygenKg)} oxygen from Earth${base.otherPropKg ? ` · ${kg(base.otherPropKg)} other (hydrogen, fusion fuel)` : ''}${base.offEarthPropKg ? ` · ${kg(base.offEarthPropKg)} made off Earth` : ''} · ${kg(base.earthLaunchedKg)} lifted off Earth</dd>
        <dt>Earth propellant lines</dt><dd class="num">gas ${money(p.feedstock)} · purification ${money(p.purification)} · liquefaction ${money(p.liquefaction)} · oxygen ${money(p.oxygenEnergy)} · storage ${money(p.conditioning)} · boil-off ${money(p.boiloff)} · margin ${money(p.margin)}</dd>
        <dt>Route</dt><dd class="num">Δv ${spec.route.outKmS.toFixed(2)} km/s out (+${a.mission.transferMarginKmS.base} margin), ${spec.route.backKmS.toFixed(2)} km/s home${spec.route.ascentKmS ? `, ${spec.route.ascentKmS.toFixed(2)} km/s ascent` : ''}${spec.route.distanceLy ? ` · ${fmtNum(spec.route.distanceLy)} ly` : ''} · ${spec.route.transitYears < 0.25 ? `${(spec.route.transitYears * 365.25).toFixed(1)} days` : `${spec.route.transitYears.toFixed(spec.route.transitYears < 10 ? 2 : 0)} yr`} (Hohmann)</dd>
        <dt>Context</dt><dd class="num">era ${ctx.era} · ISRU at destination ${ctx.flags & 2 ? 'yes' : 'no'} · loss probability ${(base.pMissionLoss * 100).toFixed(2)}% · productivity ×${ctx.productivity.toFixed(2)} · ${fmtNum(ctx.cumLaunches)} launches flown before</dd>
        <dt>Reproducible</dt><dd class="num">${same ? 'recomputed from the stored inputs under the simulated assumptions: matches the record exactly' : `recomputed ${money(again.total)} vs recorded ${money(f('total'))}: the build's assumptions differ from the run's`}</dd>
      </dl>
      <div class="ec-break-m"></div>
      <div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col" class="txt">component</th><th scope="col">all-cheap</th><th scope="col">base</th><th scope="col">all-costly</th><th scope="col">share</th></tr></thead><tbody>${COST_KEYS.map(comp).join('')}
        <tr><th scope="row" class="txt">Total (adds exactly)</th><td class="muted">${money(env.low.total)}</td><td><strong>${money(base.total)}</strong></td><td class="muted">${env.high.feasible ? money(env.high.total) : 'infeasible'}</td><td></td></tr></tbody></table></div>
      <h4 class="ec-sub">What drives this mission's cost</h4>
      <div class="ec-tornado">${this.sens?.key === `${this.sel}|${this.assKey()}` ? this.sens.html : '<button class="link" type="button" data-act="sens">Rank every uncertain input (one at a time, low to high)</button>'}</div>`;
    this.renderBreak(groups, 'this mission by cost group', this.$('.ec-break-m'));
  }

  private renderTornado(): void {
    const at = this.rowOf(this.sel);
    if (!at) return;
    const { spec, ctx } = unpackMission(at.rows, at.o), a = this.assumptions();
    const base = evaluate(spec, ctx, a).total;
    const s = sensitivity(spec, ctx, a).slice(0, 12);
    const key = `${this.sel}|${this.assKey()}`;
    if (!s.length) { this.sens = { key, html: '<p class="muted">No input moves this mission\'s cost.</p>' }; this.render(); return; }
    const lo = Math.min(base, ...s.map((x) => Math.min(x.atLow, x.atHigh))), hi = Math.max(base, ...s.map((x) => Math.max(x.atLow, x.atHigh)));
    const pct = (v: number) => (100 * (v - lo)) / (hi - lo || 1);
    const rows = s.map((x) => {
      const a0 = Math.min(x.atLow, x.atHigh), a1 = Math.max(x.atLow, x.atHigh);
      const cheap = Math.min(a0, base), dear = Math.max(a1, base);
      return `<li title="${esc(`${x.label} from ${x.low} to ${x.high} ${x.unit}: ${money(x.atLow)} to ${money(x.atHigh)}`)}"><span class="ec-tl">${esc(x.label)} <span class="muted">[${x.classification}]</span></span>
        <span class="ec-tb"><i class="ec-tlo" style="left:${pct(cheap)}%;width:${pct(base) - pct(cheap)}%"></i><i class="ec-thi" style="left:${pct(base)}%;width:${pct(dear) - pct(base)}%"></i><b style="left:${pct(base)}%"></b></span>
        <span class="num ec-tv">${money(a0)}–${money(a1)}</span></li>`;
    }).join('');
    this.sens = { key, html: `<ul class="ec-tlist">${rows}</ul><p class="muted">Each bar moves one input from its low to its high value with every other input at base (${money(base)}, the line). Green: cheaper than base; orange: dearer. [R] reported, [E] estimate, [D] design assumption.</p>` };
    this.render();
  }

  // ---------------------------------------------------------------- events

  private click(e: Event): void {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const tr = t.closest<HTMLElement>('tr[data-m]');
    const status = this.el.querySelector<HTMLElement>('.copy-status');
    if (act === 'pick' || (!act && tr)) { const id = Number((t.closest<HTMLElement>('[data-m]'))!.dataset.m); this.sel = this.sel === id && !act ? -1 : id; this.selRow = null; this.render(); return; }
    if (act === 'close-m') { this.sel = -1; this.render(); }
    else if (act === 'more') { this.limit += 200; this.render(); }
    else if (act === 'reset') { this.knobs.clear(); this.render(); }
    else if (act === 'mc') {
      const at = this.rowOf(this.sel);
      if (!at) return;
      const { spec, ctx } = unpackMission(at.rows, at.o);
      this.mc.set(this.sel, monteCarlo(spec, ctx, this.assumptions(), 400, (this.host.sim.seed * 7919 + this.sel) >>> 0));
      this.render();
    } else if (act === 'sens') this.renderTornado();
    else if (act === 'csv') void copyText(this.csv(), 'Missions as CSV', status);
    else if (act === 'json') void copyText(this.json(), 'Missions and assumptions as JSON', status);
    else if (act === 'ass') {
      const t2 = assumptionsTable(this.assumptions());
      const cols = ['path', 'label', 'value', 'low', 'high', 'unit', 'confidence', 'classification', 'sourceTitle', 'sourceUrl', 'sourceDate', 'note'];
      void copyText(toCsv(cols, t2.map((r) => cols.map((c) => r[c])), this.title()), 'Assumptions as CSV', status);
    }
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset.ctl === 'scen') { this.scen = t.value as ScenarioId; this.knobs.clear(); this.mc.clear(); }
    else if (t.dataset.ctl === 'config') { this.config = t.value; this.knobs.clear(); this.mc.clear(); }
    else if (t.dataset.ctl === 'kind') { this.kindFilter = t.value; this.limit = 200; }
    else if (t.dataset.knob) {
      const k = KNOBS.find((x) => x.path === t.dataset.knob)!, v = Number(t.value) * k.scale;
      if (Number.isFinite(v) && v >= 0) this.knobs.set(k.path, v); else this.knobs.delete(k.path);
      this.mc.clear();
    } else return;
    this.render();
  }

  // ---------------------------------------------------------------- exports

  private title(): string {
    const a = this.assumptions();
    return `Launch economics · model ${MODEL_VERSION} · assumptions ${ASSUMPTIONS_VERSION} · simulated under ${this.simScenario} · shown under ${a.scenario} (${a.starship.id}) · ${CURRENCY} · future #${this.host.sim.seed} · up to ${fmtYear(this.host.year())}`;
  }

  /** Every mission as a self-describing record: names, units, low/base/high, components, inputs. */
  private records(): Record<string, unknown>[] {
    const R = this.rows, W = this.host.world, a = this.assumptions(), rep = this.repricing(), simA = scenario('baseline');
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < R.length / NMC; i++) {
      const o = i * NMC, f = (k: keyof typeof MC) => R[o + MC[k]], id = f('id');
      const veh = VEHICLES[f('vehicle')];
      const version = veh === 'starship' ? simA.starship.version : veh === 'ntp' ? simA.ntp.version : veh === 'fusion' ? simA.fusion.version : simA.interstellar.classes[veh as 'seed'].version;
      const rec: Record<string, unknown> = {
        missionId: id, departureYear: 2040 + f('year'), origin: names.place(W, f('from')), destination: names.place(W, f('to')), originBody: f('from'), destinationBody: f('to'),
        fundingPolity: f('funder') >= 0 ? names.place(W, f('funder')) : '', missionType: KIND[f('kind')], vehicleClass: veh, vehicleVersion: version,
        returnMode: RETURN_MODES[f('returnMode')], outcome: OUTCOME_NAMES[f('outcome')], isruAvailable: !!f('isru'),
        crewOrColonists: f('crew'), payload_kg: f('payloadKg'), missionVehicles: f('ships'), tankerFlights: f('tankerFlights'), tankersPerVehicle: f('tankersPerShip'),
        depotLaunches: f('depotLaunches'), totalLaunches: f('totalLaunches'),
        propellant_kg: { methane: f('methaneKg'), oxygen: f('oxygenKg'), other: f('otherPropKg'), offEarth: f('offEarthPropKg') }, earthLaunched_kg: f('earthLaunchedKg'),
        cost_usd2024: { low: f('low'), base: f('total'), high: f('high'), highIsInfeasible: !!f('envFlags') },
        breakdown_usd2024: Object.fromEntries(COST_KEYS.map((k) => [k, R[o + MC[`c_${k}` as keyof typeof MC]]])),
        tankerCampaign_usd2024: f('tankerCost'), internalMarginal_usd2024: f('marginal'), illustrativeCustomerPrice_usd2024: f('customerPrice'),
        costPerKg_usd2024: f('costPerKg'), costPerPerson_usd2024: f('costPerPassenger'), missionLossProbability: f('pMissionLoss'),
        inputs: Object.fromEntries(MC_NAMES.filter((n) => n.startsWith('in_') || n.startsWith('ctx_')).map((n) => [n, R[o + MC[n]]])),
      };
      if (rep) rec.repriced_usd2024 = this.reprice(id, o, R, a);
      out.push(rec);
    }
    return out;
  }

  private csv(): string {
    const recs = this.records();
    const flat = (r: Record<string, unknown>, p = ''): [string, unknown][] => Object.entries(r).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, v] as [string, unknown]]));
    const cols = recs.length ? flat(recs[0]).map(([k]) => k) : ['missionId'];
    return toCsv(cols, recs.map((r) => flat(r).map(([, v]) => v)), this.title());
  }

  private json(): string {
    const a = this.assumptions();
    return toJson({
      modelVersion: MODEL_VERSION, assumptionsVersion: ASSUMPTIONS_VERSION, currency: CURRENCY, seed: this.host.sim.seed, simulationYear: 2040 + this.host.year(),
      simulatedScenario: this.simScenario, shownScenario: a.scenario, starshipConfiguration: a.starship.id,
      units: { cost: 'USD 2024', mass: 'kg', year: 'calendar year', probability: 'per mission', deltaV: 'km/s' },
      notes: [
        'Fully burdened economic cost; internal marginal cost and an illustrative customer price are given separately and are never treated as production cost.',
        'Low/high are the all-cheap and all-costly envelopes (every input at its cost-lowering or cost-raising end), not confidence intervals.',
        'Reproduce any record: launchEconomics.evaluate(spec, ctx, assumptions) with the inputs stored on it, under the simulated assumptions.',
        'Scheduled passenger services are continuous flows booked in the global metrics, not mission records.',
      ],
      assumptions: assumptionsTable(a), eraBudget: a.budget.eraBudget,
      missions: this.records(),
    }, this.title());
  }
}
