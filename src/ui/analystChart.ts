// The analyst's chart: several lines over the years with labelled axes, a
// linear or warped (the timeline's) year axis, linear or log values, drag to
// zoom into a span of years (double-click to zoom out), and a hover readout.
// Grey bands (all futures) and dashed lines can ride along.

import { HORIZON, WARP } from './charts.ts';
import { esc } from './dataPanel.ts';
import { fmtYear } from './format.ts';
import { niceTicks, tickLabel } from './miniChart.ts';

export interface ALine { label: string; color: string; xs: ArrayLike<number>; ys: ArrayLike<number>; dash?: boolean; unit?: string }
export interface ABand { label: string; color: string; xs: ArrayLike<number>; lo: ArrayLike<number>; hi: ArrayLike<number> }
export interface AData { lines: ALine[]; bands?: ABand[]; cursor?: number; percent?: boolean; empty?: string }

const PAD = { l: 58, r: 12, t: 10, b: 20 };
const WARP_TICKS = [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Index of the last x <= at (xs ascending), or -1. */
export function idxAt(xs: ArrayLike<number>, at: number): number {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0 || xs[0] > at) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= at) lo = m; else hi = m - 1; }
  return lo;
}

export class AnalystChart {
  el: HTMLElement;
  log = false;
  warp = false;
  /** zoomed span of years after 2040, or null for everything */
  range: [number, number] | null = null;
  /** HTML for the hover readout at a year; the default lists each line's value */
  tooltip: ((year: number, lines: ALine[]) => string) | null = null;
  onPick: (year: number) => void = () => {};
  /** the zoom or an axis toggle changed (to keep sibling charts in step) */
  onView: () => void = () => {};
  /** the pointer moved to a year, or left (null) */
  onHover: (year: number | null) => void = () => {};
  private data: AData = { lines: [] };
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private hover: number | null = null;
  private drag: { x0: number; x1: number } | null = null;
  private dom: [number, number] = [0, HORIZON];

  constructor(opts: { log?: boolean; warp?: boolean; label?: string } = {}) {
    this.log = !!opts.log; this.warp = !!opts.warp;
    this.el = document.createElement('div');
    this.el.className = 'ac';
    this.el.innerHTML = `
      <div class="ac-tools">
        <span>values <button class="link" type="button" data-ac="lin">linear</button> <button class="link" type="button" data-ac="log">log</button></span>
        <span>years <button class="link" type="button" data-ac="xlin">linear</button> <button class="link" type="button" data-ac="xwarp">warped</button></span>
        <button class="link" type="button" data-ac="reset" hidden>Zoom out</button>
        <span class="muted ac-hint">Drag across the chart to zoom into those years.</span>
      </div>
      <div class="ac-plot"><canvas aria-label="${esc(opts.label ?? 'Chart')}"></canvas><div class="ac-tip" hidden></div></div>`;
    this.canvas = this.el.querySelector('canvas')!;
    this.tip = this.el.querySelector('.ac-tip')!;
    this.el.querySelector('.ac-tools')!.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-ac]')?.dataset.ac;
      if (!a) return;
      if (a === 'lin' || a === 'log') this.log = a === 'log';
      else if (a === 'xlin' || a === 'xwarp') this.warp = a === 'xwarp';
      else if (a === 'reset') this.range = null;
      this.draw();
      this.onView();
    });
    const c = this.canvas;
    const yearOf = (e: PointerEvent | MouseEvent) => { const r = c.getBoundingClientRect(); return this.inv(e.clientX - r.left, r.width); };
    const px = (e: PointerEvent) => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; c.setPointerCapture(e.pointerId); this.drag = { x0: px(e), x1: px(e) }; });
    c.addEventListener('pointermove', (e) => {
      if (this.drag) this.drag.x1 = px(e);
      this.hover = yearOf(e);
      this.draw();
      this.onHover(this.hover);
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const w = c.getBoundingClientRect().width;
      if (Math.abs(d.x1 - d.x0) > 6) {
        const a = this.inv(Math.min(d.x0, d.x1), w), b = this.inv(Math.max(d.x0, d.x1), w);
        if (b - a > 0.5) { this.range = [a, b]; this.onView(); }
      } else this.onPick(yearOf(e));
      this.draw();
    });
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.draw(); this.onHover(null); } });
    c.addEventListener('dblclick', () => { this.range = null; this.draw(); this.onView(); });
    new ResizeObserver(() => this.draw()).observe(c);
  }

  set(d: AData): void { this.data = d; this.draw(); }

  // ------------------------------------------------------------ axes

  private u(y: number): number { const t = Math.min(1, Math.max(0, y / HORIZON)); return this.warp ? Math.pow(t, 1 / WARP) : t; }
  private uInv(u: number): number { const t = Math.min(1, Math.max(0, u)); return HORIZON * (this.warp ? Math.pow(t, WARP) : t); }
  private X(y: number, W: number): number { const [a, b] = this.dom; return PAD.l + ((this.u(y) - this.u(a)) / Math.max(1e-12, this.u(b) - this.u(a))) * (W - PAD.l - PAD.r); }
  private inv(px: number, W: number): number { const [a, b] = this.dom; return this.uInv(this.u(a) + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (this.u(b) - this.u(a))); }

  draw(): void {
    for (const [k, on] of [['lin', !this.log], ['log', this.log], ['xlin', !this.warp], ['xwarp', this.warp]] as const) this.el.querySelector(`[data-ac=${k}]`)!.setAttribute('aria-pressed', String(on));
    (this.el.querySelector('[data-ac=reset]') as HTMLElement).hidden = !this.range;
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio, 2), W = c.clientWidth, H = c.clientHeight;
    if (!W || !H || this.el.offsetParent === null) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = '10px Georgia, serif';
    const { lines, bands = [] } = this.data;
    // the year span: the zoom, or everything there is
    let x0 = Infinity, x1 = -Infinity;
    for (const l of lines) if (l.xs.length) { x0 = Math.min(x0, l.xs[0]); x1 = Math.max(x1, l.xs[l.xs.length - 1]); }
    for (const b of bands) if (b.xs.length) { x0 = Math.min(x0, b.xs[0]); x1 = Math.max(x1, b.xs[b.xs.length - 1]); }
    if (!Number.isFinite(x0)) { g.fillStyle = '#9a9da3'; g.fillText(this.data.empty ?? 'No data yet', PAD.l, PAD.t + 12); this.tip.hidden = true; return; }
    x0 = Math.min(0, x0); x1 = Math.max(x1, Math.min(HORIZON, x0 + 1));
    this.dom = this.range ?? [x0, x1];
    const [z0, z1] = this.dom;
    const log = this.log, tf = (v: number) => (log ? Math.log10(v) : v);
    const okv = (v: number) => Number.isFinite(v) && (!log || v > 0);
    let lo = Infinity, hi = -Infinity;
    const span = (xs: ArrayLike<number>, ys: ArrayLike<number>) => {
      for (let i = 0; i < xs.length; i++) { if (xs[i] < z0 || xs[i] > z1 || !okv(ys[i])) continue; const t = tf(ys[i]); if (t < lo) lo = t; if (t > hi) hi = t; }
    };
    for (const l of lines) span(l.xs, l.ys);
    for (const b of bands) { span(b.xs, b.lo); span(b.xs, b.hi); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12) { hi = lo + (log ? 1 : Math.abs(lo) * 0.1 || 1); lo -= log ? 1 : 0; }
    if (!log && lo > 0 && lo < hi * 0.4) lo = 0;
    const padY = (hi - lo) * 0.04; hi += padY; if (!(lo === 0 && !log)) lo -= padY;
    const Y = (v: number) => H - PAD.b - ((tf(v) - lo) / (hi - lo)) * (H - PAD.b - PAD.t);
    const X = (y: number) => this.X(y, W);

    // year ticks
    g.textBaseline = 'top'; g.textAlign = 'center';
    const cand = this.warp ? [...WARP_TICKS.map((t) => t + 2040), ...niceTicks(z0 + 2040, z1 + 2040, 6)] : niceTicks(z0 + 2040, z1 + 2040, Math.max(2, Math.floor((W - PAD.l) / 80)));
    const xt = [...new Set(cand.map((t) => Math.round(t)))].filter((t) => t - 2040 >= z0 - 1e-6 && t - 2040 <= z1 + 1e-6).sort((a, b) => a - b);
    let lastX = -1e9;
    for (const t of xt) {
      const x = X(t - 2040);
      if (x - lastX < 46) continue;
      lastX = x;
      g.strokeStyle = 'rgba(242,242,242,0.07)'; g.beginPath(); g.moveTo(Math.round(x) + 0.5, PAD.t); g.lineTo(Math.round(x) + 0.5, H - PAD.b); g.stroke();
      g.fillStyle = '#9a9da3'; g.fillText(String(t), x, H - PAD.b + 4);
    }
    // value ticks
    g.textAlign = 'right'; g.textBaseline = 'middle';
    let yt: number[];
    if (log && hi - lo >= 1) { const step = Math.max(1, Math.ceil((hi - lo) / 5)); yt = []; for (let e = Math.ceil(lo); e <= hi; e += step) yt.push(10 ** e); }
    else yt = niceTicks(log ? 10 ** lo : lo, log ? 10 ** hi : hi, 4);
    for (const t of yt) {
      if (!okv(t)) continue;
      const y = Y(t);
      if (y < PAD.t - 1 || y > H - PAD.b + 1) continue;
      g.strokeStyle = 'rgba(242,242,242,0.07)'; g.beginPath(); g.moveTo(PAD.l, Math.round(y) + 0.5); g.lineTo(W - PAD.r, Math.round(y) + 0.5); g.stroke();
      g.fillStyle = '#9a9da3'; g.fillText(this.data.percent ? `${+(t * 100).toPrecision(3)}%` : tickLabel(t), PAD.l - 6, y);
    }
    g.strokeStyle = 'rgba(242,242,242,0.3)'; g.beginPath(); g.moveTo(PAD.l + 0.5, PAD.t); g.lineTo(PAD.l + 0.5, H - PAD.b + 0.5); g.lineTo(W - PAD.r, H - PAD.b + 0.5); g.stroke();

    g.save();
    g.beginPath(); g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b); g.clip();
    for (const b of bands) {
      g.beginPath();
      let n = 0;
      for (let i = 0; i < b.xs.length; i++) if (okv(b.hi[i])) { g.lineTo(X(b.xs[i]), Y(b.hi[i])); n++; }
      for (let i = b.xs.length - 1; i >= 0; i--) if (okv(b.lo[i])) g.lineTo(X(b.xs[i]), Y(b.lo[i]));
      if (n) { g.closePath(); g.fillStyle = b.color; g.fill(); }
    }
    for (const l of lines) {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < l.xs.length; i++) {
        if (!okv(l.ys[i])) { pen = false; continue; }
        const x = X(l.xs[i]), y = Y(l.ys[i]);
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.setLineDash(l.dash ? [4, 3] : []);
      g.strokeStyle = l.color; g.lineWidth = 1.3; g.stroke();
    }
    g.setLineDash([]);
    const cur = this.data.cursor;
    if (cur !== undefined && cur >= z0 && cur <= z1) { g.strokeStyle = 'rgba(127,227,255,0.75)'; g.beginPath(); g.moveTo(Math.round(X(cur)) + 0.5, PAD.t); g.lineTo(Math.round(X(cur)) + 0.5, H - PAD.b); g.stroke(); }
    if (this.drag && Math.abs(this.drag.x1 - this.drag.x0) > 2) {
      g.fillStyle = 'rgba(127,227,255,0.1)';
      g.fillRect(Math.min(this.drag.x0, this.drag.x1), PAD.t, Math.abs(this.drag.x1 - this.drag.x0), H - PAD.t - PAD.b);
    }
    // hover: a hairline, a dot on each line, and the readout
    const hv = this.hover;
    if (hv !== null && hv >= z0 && hv <= z1) {
      const hx = X(hv);
      g.strokeStyle = 'rgba(242,242,242,0.35)'; g.beginPath(); g.moveTo(Math.round(hx) + 0.5, PAD.t); g.lineTo(Math.round(hx) + 0.5, H - PAD.b); g.stroke();
      for (const l of lines) {
        const i = idxAt(l.xs, hv);
        if (i < 0 || !okv(l.ys[i])) continue;
        g.fillStyle = l.color; g.beginPath(); g.arc(X(l.xs[i]), Y(l.ys[i]), 2.6, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
    this.showTip(hv !== null && hv >= z0 && hv <= z1 ? hv : null, W);
  }

  private showTip(year: number | null, W: number): void {
    const t = this.tip;
    if (year === null || this.drag) { t.hidden = true; return; }
    t.innerHTML = this.tooltip ? this.tooltip(year, this.data.lines) : defaultTip(year, this.data.lines, !!this.data.percent);
    t.hidden = false;
    const x = this.X(year, W), tw = t.offsetWidth;
    t.style.left = `${x + 12 + tw > W ? Math.max(0, x - 12 - tw) : x + 12}px`;
  }
}

/** The year, then each line's latest value at or before it. */
export function defaultTip(year: number, lines: ALine[], percent = false): string {
  const rows = lines.map((l) => {
    const i = idxAt(l.xs, year);
    const v = i < 0 ? NaN : l.ys[i];
    const s = !Number.isFinite(v) ? '–' : percent ? `${+(v * 100).toPrecision(3)}%` : tickLabel(v);
    return `<tr><th scope="row"><i style="background:${l.color}"></i>${esc(l.label)}</th><td class="num">${s}${l.unit && Number.isFinite(v) ? ` ${esc(l.unit)}` : ''}</td></tr>`;
  }).join('');
  return `<p class="ac-tip-y">${fmtYear(year)}</p><table>${rows}</table>`;
}
