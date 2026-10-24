// Small-multiple time-series charts drawn on canvas. They share the timeline's
// warped time axis so the slider and every chart line up vertically.

import { ERAS } from '../sim/catalog.ts';
import { GLOBAL_METRICS, GM, type MetricDef } from '../sim/metrics.ts';
import { globalBinder, tryCompile, type GlobalRow } from '../sim/query.ts';
import { fmtUnit, fmtYear } from './format.ts';

export const HORIZON = 10000;
export const WARP = 2.4;
export const posToYear = (p: number) => HORIZON * Math.pow(Math.min(1, Math.max(0, p)), WARP);
export const yearToPos = (y: number) => Math.pow(Math.min(1, Math.max(0, y / HORIZON)), 1 / WARP);

// muted and earthy, so eras never read as settlement stages
export const ERA_COLORS = ['#7d9460', '#6b7088', '#bfa060', '#4d4b48', '#8a3a3a', '#76648f', '#332a2c', '#4f8a96'];

/**
 * Era spans in pixels, smoothed: each `minPx` bucket takes the era that held
 * longest inside it, so the band shows lasting regimes rather than flicker.
 */
export function eraRuns(years: number[], n: number, era: (i: number) => number, W: number, minPx = 8): { e: number; x0: number; x1: number }[] {
  const nb = Math.max(1, Math.ceil(W / minPx));
  const acc = new Float64Array(nb * 8);
  for (let i = 0; i < n - 1; i++) {
    const x0 = yearToPos(years[i]) * W, x1 = yearToPos(years[i + 1]) * W, e = era(i);
    for (let b = Math.floor(x0 / minPx); b <= Math.min(nb - 1, Math.floor(x1 / minPx)); b++) {
      const w = Math.min(x1, (b + 1) * minPx) - Math.max(x0, b * minPx);
      if (w > 0) acc[b * 8 + e] += w;
    }
  }
  const out: { e: number; x0: number; x1: number }[] = [];
  for (let b = 0; b < nb; b++) {
    let best = -1, bw = 0;
    for (let e = 0; e < 8; e++) if (acc[b * 8 + e] > bw) { bw = acc[b * 8 + e]; best = e; }
    if (best < 0) continue;
    const last = out[out.length - 1];
    if (last && last.e === best && last.x1 >= b * minPx - 0.01) last.x1 = Math.min(W, (b + 1) * minPx);
    else out.push({ e: best, x0: b * minPx, x1: Math.min(W, (b + 1) * minPx) });
  }
  // the last bucket only covers what has been simulated
  if (out.length && n > 1) out[out.length - 1].x1 = Math.min(out[out.length - 1].x1, yearToPos(years[n - 1]) * W);
  return out;
}

export interface Series { years: number[]; values: (i: number) => number; n: number; def: MetricDef }

export class ChartStrip {
  el: HTMLElement;
  private charts: { wrap: HTMLElement; canvas: HTMLCanvasElement; select: HTMLSelectElement; value: HTMLElement; key: string; fill: () => void }[] = [];
  private getSeries: (key: string) => Series | null = () => null;
  private getFan: (key: string) => { years: number[]; lo: number[]; mid: number[]; hi: number[] } | null = () => null;
  private year = 0;
  private hoverPos: number | null = null;
  onHoverYear: (y: number | null) => void = () => {};
  onPickYear: (y: number) => void = () => {};

  constructor(defaults: string[], extraOptions: () => { key: string; label: string }[] = () => []) {
    this.el = document.createElement('div');
    this.el.className = 'charts';
    defaults.forEach((key, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'chart';
      const head = document.createElement('div');
      head.className = 'chart-head';
      const select = document.createElement('select');
      select.id = `chart-metric-${i}`;
      select.setAttribute('aria-label', `Chart ${i + 1} metric`);
      const fill = (withExtra = true) => {
        const cur = select.value || key;
        select.innerHTML = '';
        let group = '';
        let og: HTMLOptGroupElement | null = null;
        for (const m of GLOBAL_METRICS) {
          if (m.group !== group) { og = document.createElement('optgroup'); og.label = m.group; select.append(og); group = m.group; }
          og!.append(new Option(m.label, m.key));
        }
        og = document.createElement('optgroup'); og.label = 'Derived'; select.append(og);
        for (const [k, r] of registry) og.append(new Option(r.def.label, k));
        for (const x of exprHistory) og.append(new Option(x, `x:${x}`));
        if (cur.startsWith('x:') && !exprHistory.includes(cur.slice(2))) og.append(new Option(cur.slice(2), cur));
        og.append(new Option('Expression… (e.g. gdp/pop)', '__expr'));
        const extra = withExtra ? extraOptions() : [];
        if (extra.length) {
          og = document.createElement('optgroup'); og.label = 'Selected place'; select.append(og);
          for (const e of extra) og.append(new Option(e.label, e.key));
        }
        select.value = [...select.options].some((o) => o.value === cur) ? cur : key;
      };
      fill(false);
      select.addEventListener('focus', () => fill());
      const value = document.createElement('span');
      value.className = 'chart-value num';
      head.append(select, value);
      const canvas = document.createElement('canvas');
      wrap.append(head, canvas);
      this.el.append(wrap);
      const c = { wrap, canvas, select, value, key, fill: () => { fill(); c.key = select.value; } };
      select.addEventListener('change', () => {
        if (select.value === '__expr') { this.askExpr(c); return; }
        c.key = select.value; this.draw();
      });
      canvas.addEventListener('pointermove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.hoverPos = (e.clientX - r.left) / r.width;
        this.onHoverYear(posToYear(this.hoverPos));
        this.draw();
      });
      canvas.addEventListener('pointerleave', () => { this.hoverPos = null; this.onHoverYear(null); this.draw(); });
      canvas.addEventListener('click', (e) => {
        const r = canvas.getBoundingClientRect();
        this.onPickYear(posToYear((e.clientX - r.left) / r.width));
      });
      this.charts.push(c);
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setSource(fn: (key: string) => Series | null): void { this.getSeries = fn; }

  /** Inline editor for a derived series: any expression over the global metrics. */
  private askExpr(c: (typeof this.charts)[number]): void {
    const head = c.select.parentElement!;
    const input = document.createElement('input');
    input.className = 'chart-expr';
    input.placeholder = 'gdp / pop';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Expression over global metrics');
    input.value = c.key.startsWith('x:') ? c.key.slice(2) : '';
    c.select.hidden = true;
    head.prepend(input);
    input.focus();
    const done = (ok: boolean) => {
      if (ok) {
        const r = tryCompile<GlobalRow>(input.value, globalBinder());
        if (r instanceof Error) { input.setCustomValidity(`${r.message} (at ${r.pos + 1})`); input.reportValidity(); return; }
        const x = input.value.trim();
        if (!exprHistory.includes(x)) exprHistory.unshift(x);
        exprHistory.length = Math.min(exprHistory.length, 8);
        c.key = `x:${x}`;
      }
      input.remove();
      c.select.hidden = false;
      c.fill();
      c.select.value = c.key;
      this.draw();
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); e.stopPropagation(); });
    input.addEventListener('blur', () => { if (input.isConnected) done(!!input.value.trim()); });
  }

  /** Show a series in the first chart (e.g. a query result). */
  show(key: string, slot = 0): void {
    const c = this.charts[Math.min(slot, this.charts.length - 1)];
    c.key = key;
    c.fill();
    c.select.value = key;
    this.draw();
  }
  /** Forecast band drawn ahead of the cursor (transformer rollouts). */
  setFan(fn: ChartStrip['getFan']): void { this.getFan = fn; }

  /** Selection changed: relabel per-place options, and fall back to the default where they no longer apply. */
  refreshOptions(): void {
    for (const c of this.charts) c.fill();
    this.draw();
  }
  setYear(y: number): void { this.year = y; this.draw(); }

  draw(): void {
    for (const c of this.charts) this.drawOne(c);
  }

  private drawOne(c: (typeof this.charts)[number]): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = c.canvas.clientWidth, H = c.canvas.clientHeight;
    if (!W || !H) return;
    if (c.canvas.width !== W * dpr) { c.canvas.width = W * dpr; c.canvas.height = H * dpr; }
    const g = c.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const s = this.getSeries(c.key);
    if (!s || s.n < 2) { c.value.textContent = ''; return; }
    const isEra = c.key === 'era';
    const log = !!s.def.log;
    const tf = (v: number) => (log ? Math.log10(Math.max(v, 1e-9)) : v);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < s.n; i++) {
      const v = s.values(i);
      if (log && v <= 0) continue;
      const t = tf(v);
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    const fan = isEra ? null : this.getFan(c.key);
    if (fan) for (const arr of [fan.lo, fan.hi]) for (const v of arr) {
      if (log && v <= 0) continue;
      const t = tf(v);
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { hi = lo + 1; }
    if (!log && lo > 0 && lo < hi * 0.5) lo = 0;
    const pad = 4, top = 4, bottom = H - 2;
    const X = (y: number) => yearToPos(y) * W;
    const Y = (v: number) => bottom - ((tf(v) - lo) / (hi - lo)) * (bottom - top - pad);

    // faint grid: century-ish ticks on warped axis
    g.strokeStyle = 'rgba(242,242,242,0.06)';
    g.lineWidth = 1;
    for (const y of [10, 50, 100, 250, 500, 1000, 2500, 5000]) { const x = Math.round(X(y)) + 0.5; g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); }

    if (isEra) {
      for (const r of eraRuns(s.years, s.n, s.values, W)) {
        g.fillStyle = ERA_COLORS[r.e];
        g.fillRect(r.x0, top + 6, Math.max(1, r.x1 - r.x0), bottom - top - 12);
      }
    } else {
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, 'rgba(242,242,242,0.16)');
      grad.addColorStop(1, 'rgba(242,242,242,0)');
      g.beginPath();
      let started = false, lastX = 0;
      for (let i = 0; i < s.n; i++) {
        const v = s.values(i);
        if (log && v <= 0) continue;
        const x = X(s.years[i]), y = Y(v);
        if (!started) { g.moveTo(x, bottom); g.lineTo(x, y); started = true; } else g.lineTo(x, y);
        lastX = x;
      }
      g.lineTo(lastX, bottom);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      g.beginPath();
      started = false;
      for (let i = 0; i < s.n; i++) {
        const v = s.values(i);
        if (log && v <= 0) continue;
        const x = X(s.years[i]), y = Y(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(242,242,242,0.85)';
      g.lineWidth = 1.2;
      g.stroke();
    }

    if (fan && fan.years.length > 1) {
      const ok = (v: number) => !log || v > 0;
      g.beginPath();
      fan.years.forEach((y, i) => { if (ok(fan.hi[i])) g.lineTo(X(y), Y(fan.hi[i])); });
      for (let i = fan.years.length - 1; i >= 0; i--) if (ok(fan.lo[i])) g.lineTo(X(fan.years[i]), Y(fan.lo[i]));
      g.closePath();
      g.fillStyle = 'rgba(127,227,255,0.14)';
      g.fill();
      g.beginPath();
      fan.years.forEach((y, i) => { if (ok(fan.mid[i])) g.lineTo(X(y), Y(fan.mid[i])); });
      g.setLineDash([3, 3]);
      g.strokeStyle = 'rgba(127,227,255,0.9)';
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
    }

    // cursor: current year, and hover
    const at = (yr: number) => {
      let lo2 = 0, hi2 = s.n - 1;
      while (lo2 < hi2) { const m = (lo2 + hi2 + 1) >> 1; if (s.years[m] <= yr) lo2 = m; else hi2 = m - 1; }
      return lo2;
    };
    const cur = at(this.year);
    const cx = X(this.year);
    g.strokeStyle = 'rgba(127,227,255,0.8)';
    g.beginPath(); g.moveTo(cx + 0.5, top); g.lineTo(cx + 0.5, bottom); g.stroke();
    if (!isEra && s.years[cur] <= this.year) {
      const v = s.values(cur);
      if (!log || v > 0) { g.fillStyle = '#7fe3ff'; g.beginPath(); g.arc(cx, Y(v), 2.5, 0, Math.PI * 2); g.fill(); }
    }
    let shownYear = this.year, shownIdx = cur;
    if (this.hoverPos !== null) {
      shownYear = posToYear(this.hoverPos); shownIdx = at(shownYear);
      const hx = this.hoverPos * W;
      g.strokeStyle = 'rgba(242,242,242,0.35)';
      g.beginPath(); g.moveTo(hx + 0.5, top); g.lineTo(hx + 0.5, bottom); g.stroke();
    }
    const v = s.values(shownIdx);
    c.value.textContent = `${isEra ? ERAS[v] : fmtUnit(v, s.def.unit)} · ${fmtYear(shownYear)}`;
  }
}

// derived series: expressions typed into a chart, and series other panels register (query scans)
const exprHistory: string[] = [];
const registry = new Map<string, Series>();
export function registerSeries(key: string, s: Series | null): void { if (s) registry.set(key, s); else registry.delete(key); }

const exprCache = new Map<string, { n: number; series: Float64Array; out: Series | null }>();
function exprSeries(years: number[], series: Float64Array, n: number, src: string): Series | null {
  const hit = exprCache.get(src);
  if (hit && hit.n === n && hit.series === series) return hit.out;
  const out = computeExpr(years, series, n, src);
  if (exprCache.size > 16) exprCache.clear();
  exprCache.set(src, { n, series, out });
  return out;
}
function computeExpr(years: number[], series: Float64Array, n: number, src: string): Series | null {
  const r = tryCompile<GlobalRow>(src, globalBinder());
  if (r instanceof Error) return null;
  const vals = new Float64Array(n);
  const row: GlobalRow = { series, i: 0, year: 0 };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    row.i = i; row.year = years[i];
    const v = r.value(row);
    vals[i] = v;
    if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  // positive and spanning three orders of magnitude: read it on a log scale
  const log = lo > 0 && hi / lo > 1000;
  return { years, n, def: { key: `x:${src}`, label: src, unit: '', log, group: 'Derived' }, values: (i) => vals[i] };
}

export function globalSeries(years: number[], series: Float64Array, frontier: number, key: string): Series | null {
  if (key.startsWith('x:')) return exprSeries(years, series, Math.min(years.length, frontier + 1), key.slice(2));
  const reg = registry.get(key);
  if (reg) return reg;
  const col = GM[key];
  if (col === undefined) return null;
  const n = Math.min(years.length, frontier + 1);
  const NG = GLOBAL_METRICS.length;
  return { years, n, def: GLOBAL_METRICS[col], values: (i) => series[i * NG + col] };
}
