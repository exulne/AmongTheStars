// Small SVG charts for the Orbits desk and the Impact Lab: one axis per chart
// (never two scales), thin 2px lines, a crosshair readout on hover, a legend
// for two or more series, and a table view of the same numbers.

import { esc } from './dataPanel.ts';
import { fmtNum } from './format.ts';

export interface Series { label: string; color: string; xs: number[]; ys: number[]; dash?: string }
export interface ChartOpts { w?: number; h?: number; xLog?: boolean; yLog?: boolean; xLabel: string; yLabel: string; fmtX?: (x: number) => string; fmtY?: (y: number) => string; swap?: boolean; points?: boolean }

const ticks = (lo: number, hi: number, log: boolean): number[] => {
  if (log) {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(10 ** e);
    return out.filter((t) => t >= lo * 0.999 && t <= hi * 1.001);
  }
  const span = hi - lo || 1, step = 10 ** Math.floor(Math.log10(span / 4)), m = span / step > 20 ? 5 : span / step > 8 ? 2 : 1;
  const out: number[] = [];
  for (let t = Math.ceil(lo / (step * m)) * step * m; t <= hi + 1e-9; t += step * m) out.push(+t.toPrecision(10));
  return out;
};

/** A line (or point) chart as SVG markup with a hover readout and a table view. Call `wire` on its container afterwards. */
export function lineChart(series: Series[], o: ChartOpts): string {
  const W = o.w ?? 560, H = o.h ?? 200, L = 56, R = 12, T = 10, B = 30;
  const all = series.flatMap((s) => s.xs.map((x, i) => [x, s.ys[i]] as const)).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!o.xLog || x > 0) && (!o.yLog || y > 0));
  if (!all.length) return '<p class="muted">No data.</p>';
  let [x0, x1] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  let [y0, y1] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  if (y0 === y1) { y0 = o.yLog ? y0 / 2 : y0 - 1; y1 = o.yLog ? y1 * 2 : y1 + 1; }
  if (!o.yLog && y0 > 0 && y0 < (y1 - y0) * 0.5) y0 = 0;
  const fx = (x: number) => L + ((o.xLog ? Math.log10(x / x0) / Math.log10(x1 / x0) : (x - x0) / (x1 - x0)) * (W - L - R));
  const fy = (y: number) => H - B - ((o.yLog ? Math.log10(y / y0) / Math.log10(y1 / y0) : (y - y0) / (y1 - y0)) * (H - T - B));
  const fX = o.fmtX ?? ((x) => fmtNum(x)), fY = o.fmtY ?? ((y) => fmtNum(y));
  const xt = ticks(x0, x1, !!o.xLog), yt = ticks(y0, y1, !!o.yLog);
  const grid = yt.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${fy(t)}" y2="${fy(t)}"/><text x="${L - 4}" y="${fy(t) + 3}" text-anchor="end">${esc(fY(t))}</text>`).join('')
    + xt.map((t) => `<text x="${fx(t)}" y="${H - B + 13}" text-anchor="middle">${esc(fX(t))}</text>`).join('');
  const lines = series.map((s) => {
    const pts = s.xs.map((x, i) => [x, s.ys[i]] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!o.xLog || x > 0) && (!o.yLog || y > 0));
    if (o.points) return pts.map(([x, y]) => `<circle cx="${fx(x).toFixed(1)}" cy="${fy(y).toFixed(1)}" r="4" fill="${s.color}" stroke="#08080a" stroke-width="2"/>`).join('');
    return `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${pts.map(([x, y]) => `${fx(x).toFixed(1)},${fy(y).toFixed(1)}`).join(' ')}"/>`;
  }).join('');
  const legend = series.length > 1 ? `<p class="g-legend">${series.map((s) => `<span class="g-key"><svg width="18" height="8" aria-hidden="true"><line x1="0" x2="18" y1="4" y2="4" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/></svg> ${esc(s.label)}</span>`).join(' ')}</p>` : '';
  const xsU = [...new Set(series.flatMap((s) => s.xs))].sort((a, b) => a - b);
  const table = `<details><summary>Table view</summary><div class="tbl-scroll short"><table class="dtable"><thead><tr><th scope="col">${esc(o.xLabel)}</th>${series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${xsU.slice(0, 400).map((x) => `<tr><th scope="row">${esc(fX(x))}</th>${series.map((s) => { const i = s.xs.indexOf(x); return `<td>${i >= 0 ? esc(fY(s.ys[i])) : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  const data = esc(JSON.stringify({ L, R, W, x0, x1, xLog: !!o.xLog, s: series.map((s) => ({ l: s.label, c: s.color, x: s.xs, y: s.ys })) }));
  return `<div class="lab-chart" data-chart="${data}"><svg class="lab-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${o.yLabel} against ${o.xLabel}`)}">
    ${grid}<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle">${esc(o.xLabel)}</text>
    <text x="10" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 10 ${(T + H - B) / 2})">${esc(o.yLabel)}</text>
    ${lines}<line class="hair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg><div class="lab-tip" hidden></div>${legend}${table}</div>`;
}

/** Crosshair and readout for every chart under `root` (call once per render). */
export function wireCharts(root: HTMLElement, fmtX: (x: number) => string = (x) => fmtNum(x), fmtY: (y: number) => string = (y) => fmtNum(y)): void {
  root.querySelectorAll<HTMLElement>('.lab-chart').forEach((c) => {
    if (c.dataset.wired) return;
    c.dataset.wired = '1';
    const d = JSON.parse(c.dataset.chart!) as { L: number; R: number; W: number; x0: number; x1: number; xLog: boolean; s: { l: string; c: string; x: number[]; y: number[] }[] };
    const svg = c.querySelector('svg')!, hair = svg.querySelector<SVGLineElement>('.hair')!, tip = c.querySelector<HTMLElement>('.lab-tip')!;
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(), u = ((e.clientX - r.left) / r.width) * d.W;
      const f = Math.max(0, Math.min(1, (u - d.L) / (d.W - d.L - d.R)));
      const x = d.xLog ? d.x0 * (d.x1 / d.x0) ** f : d.x0 + f * (d.x1 - d.x0);
      const rows = d.s.map((s) => {
        let best = -1, bd = Infinity;
        s.x.forEach((xx, i) => { const dd = Math.abs(d.xLog ? Math.log(xx / x) : xx - x); if (dd < bd) { bd = dd; best = i; } });
        return best >= 0 ? `<tr><th><i style="background:${s.c}"></i>${esc(s.l)}</th><td>${esc(fmtY(s.y[best]))}</td></tr>` : '';
      }).join('');
      hair.setAttribute('x1', String(u)); hair.setAttribute('x2', String(u)); hair.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<p>${esc(fmtX(x))}</p><table>${rows}</table>`;
      tip.style.left = `${Math.min(r.width - 160, Math.max(0, e.clientX - r.left + 12))}px`;
    });
    svg.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  });
}

/** Legend of the seven classifications: badge, line style, meaning. */
export function classLegend(styles: Record<string, { label: string; meaning: string; color: string; dash: string; badge: string }>, only?: string[]): string {
  return `<ul class="cls-legend">${Object.entries(styles).filter(([k]) => !only || only.includes(k)).map(([, s]) => `<li><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/></svg><span class="cls-badge" style="--cls:${s.color}">${s.badge}</span><span><strong>${esc(s.label)}</strong>: ${esc(s.meaning)}</span></li>`).join('')}</ul>`;
}
