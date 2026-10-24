// Small-multiple time-series charts drawn on canvas. They share the timeline's
// warped time axis so the slider and every chart line up vertically.

import { ERAS } from '../sim/catalog.ts';
import { GLOBAL_METRICS, GM, type MetricDef } from '../sim/metrics.ts';
import { fmtUnit, fmtYear } from './format.ts';

export const HORIZON = 10000;
export const WARP = 2.4;
export const posToYear = (p: number) => HORIZON * Math.pow(Math.min(1, Math.max(0, p)), WARP);
export const yearToPos = (y: number) => Math.pow(Math.min(1, Math.max(0, y / HORIZON)), 1 / WARP);

// muted and earthy, so eras never read as settlement stages
export const ERA_COLORS = ['#7a9a4a', '#66708f', '#c9a24a', '#4a4844', '#8c2a2a', '#7b5ea7', '#2e2427', '#3f8fa0'];

export interface Series { years: number[]; values: (i: number) => number; n: number; def: MetricDef }

export class ChartStrip {
  el: HTMLElement;
  private charts: { wrap: HTMLElement; canvas: HTMLCanvasElement; select: HTMLSelectElement; value: HTMLElement; key: string; fill: () => void }[] = [];
  private getSeries: (key: string) => Series | null = () => null;
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
      select.addEventListener('change', () => { c.key = select.value; this.draw(); });
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
      for (let i = 0; i < s.n - 1; i++) {
        g.fillStyle = ERA_COLORS[s.values(i)];
        g.fillRect(X(s.years[i]), top + 6, Math.max(1, X(s.years[i + 1]) - X(s.years[i])), bottom - top - 12);
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

export function globalSeries(years: number[], series: Float64Array, frontier: number, key: string): Series | null {
  const col = GM[key];
  if (col === undefined) return null;
  const n = Math.min(years.length, frontier + 1);
  const NG = GLOBAL_METRICS.length;
  return { years, n, def: GLOBAL_METRICS[col], values: (i) => series[i * NG + col] };
}
