// Plain canvas charts for the data desk: lines (one or many) and stacked
// shares, with labelled axes. Years are years after 2040 on the x axis.

import { fmtNum } from './format.ts';

export interface Line { label: string; color: string; xs: ArrayLike<number>; ys: ArrayLike<number> }
export interface ChartOpts { log?: boolean; cursor?: number; x0?: number; x1?: number; percent?: boolean }

export const PALETTE = ['#7fe3ff', '#ffc45c', '#c9a0ff', '#8fd18f', '#ff8f7a', '#e6e6e6', '#5fb3b3', '#d4b483', '#9aa4ff', '#ff9ccf'];
const PAD = { l: 52, r: 10, t: 8, b: 18 };

function setup(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; W: number; H: number } | null {
  const dpr = Math.min(window.devicePixelRatio, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return null;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '10px Georgia, serif';
  return { g, W, H };
}

/** "Nice" tick values between lo and hi. */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function tickLabel(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e15 || a < 1e-3) return v.toExponential(0).replace('e+', 'e');
  if (a >= 1000) return fmtNum(v, 2);
  return String(Number(v.toPrecision(3)));
}

function xAxis(g: CanvasRenderingContext2D, W: number, H: number, x0: number, x1: number, X: (x: number) => number): void {
  g.fillStyle = '#9a9da3'; g.strokeStyle = 'rgba(242,242,242,0.08)';
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const t of niceTicks(x0 + 2040, x1 + 2040, Math.max(2, Math.floor((W - PAD.l) / 90)))) {
    const x = X(t - 2040);
    g.beginPath(); g.moveTo(x + 0.5, PAD.t); g.lineTo(x + 0.5, H - PAD.b); g.stroke();
    g.fillText(String(Math.round(t)), x, H - PAD.b + 3);
  }
}

/** One or more lines over time, linear or log y. */
export function drawLines(c: HTMLCanvasElement, lines: Line[], o: ChartOpts = {}): void {
  const s = setup(c);
  if (!s) return;
  const { g, W, H } = s;
  let x0 = o.x0 ?? Infinity, x1 = o.x1 ?? -Infinity, lo = Infinity, hi = -Infinity;
  const tf = (v: number) => (o.log ? Math.log10(v) : v);
  for (const l of lines) for (let i = 0; i < l.xs.length; i++) {
    if (o.x0 === undefined) x0 = Math.min(x0, l.xs[i]);
    if (o.x1 === undefined) x1 = Math.max(x1, l.xs[i]);
    const v = l.ys[i];
    if (!Number.isFinite(v) || (o.log && v <= 0)) continue;
    if (l.xs[i] < x0 || l.xs[i] > x1) continue;
    lo = Math.min(lo, tf(v)); hi = Math.max(hi, tf(v));
  }
  if (!Number.isFinite(lo)) { g.fillStyle = '#9a9da3'; g.fillText('No data', PAD.l, PAD.t + 10); return; }
  if (hi - lo < 1e-12) { hi = lo + 1; lo -= o.log ? 1 : 0; }
  if (!o.log && lo > 0 && lo < hi * 0.4) lo = 0;
  if (x1 <= x0) x1 = x0 + 1;
  const X = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => H - PAD.b - ((tf(v) - lo) / (hi - lo)) * (H - PAD.b - PAD.t);
  xAxis(g, W, H, x0, x1, X);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  const yt = o.log ? niceTicks(Math.ceil(lo), Math.floor(hi), 4).filter(Number.isInteger).map((e) => 10 ** e) : niceTicks(lo, hi, 4);
  for (const t of yt) {
    const y = Y(t);
    g.strokeStyle = 'rgba(242,242,242,0.08)'; g.beginPath(); g.moveTo(PAD.l, y + 0.5); g.lineTo(W - PAD.r, y + 0.5); g.stroke();
    g.fillStyle = '#9a9da3'; g.fillText(o.percent ? `${Math.round(t * 100)}%` : tickLabel(t), PAD.l - 5, y);
  }
  g.save();
  g.beginPath(); g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b); g.clip();
  for (const l of lines) {
    g.beginPath();
    let pen = false;
    for (let i = 0; i < l.xs.length; i++) {
      const v = l.ys[i];
      if (!Number.isFinite(v) || (o.log && v <= 0)) { pen = false; continue; }
      const x = X(l.xs[i]), y = Y(v);
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.strokeStyle = l.color; g.lineWidth = 1.3; g.stroke();
  }
  g.restore();
  cursor(g, H, o.cursor, x0, x1, X);
}

function cursor(g: CanvasRenderingContext2D, H: number, at: number | undefined, x0: number, x1: number, X: (x: number) => number): void {
  if (at === undefined || at < x0 || at > x1) return;
  g.strokeStyle = 'rgba(127,227,255,0.7)';
  g.beginPath(); g.moveTo(X(at) + 0.5, PAD.t); g.lineTo(X(at) + 0.5, H - PAD.b); g.stroke();
}

/** Shares (0–1) stacked bottom-up, one layer per group. */
export function drawStacked(c: HTMLCanvasElement, xs: ArrayLike<number>, layers: Line[], o: ChartOpts = {}): void {
  const s = setup(c);
  if (!s || xs.length < 2) return;
  const { g, W, H } = s;
  const x0 = o.x0 ?? xs[0], x1 = o.x1 ?? xs[xs.length - 1];
  const X = (x: number) => PAD.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => H - PAD.b - v * (H - PAD.b - PAD.t);
  xAxis(g, W, H, x0, x1, X);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const t of [0, 0.25, 0.5, 0.75, 1]) { g.fillStyle = '#9a9da3'; g.fillText(`${t * 100}%`, PAD.l - 5, Y(t)); }
  const base = new Float64Array(xs.length);
  g.save();
  g.beginPath(); g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b); g.clip();
  for (const l of layers) {
    g.beginPath();
    for (let i = 0; i < xs.length; i++) g.lineTo(X(xs[i]), Y(base[i] + (l.ys[i] || 0)));
    for (let i = xs.length - 1; i >= 0; i--) g.lineTo(X(xs[i]), Y(base[i]));
    g.closePath();
    g.globalAlpha = 0.75; g.fillStyle = l.color; g.fill(); g.globalAlpha = 1;
    for (let i = 0; i < xs.length; i++) base[i] += l.ys[i] || 0;
  }
  g.restore();
  cursor(g, H, o.cursor, x0, x1, X);
}
