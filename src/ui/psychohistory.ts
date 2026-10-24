// Turns transformer rollouts into what people read: quantile fans for the
// charts, and plain odds for the inspector.

import { ERAS } from '../sim/catalog.ts';
import { GLOBAL_METRICS, GM } from '../sim/metrics.ts';
import { NERA, NF_ML } from '../ml/features.ts';
import { FORECAST_KEYS, featureToMetric, type Forecast } from '../ml/forecaster.ts';
import { fmtUnit, fmtYear } from './format.ts';

export interface Fan { years: number[]; lo: number[]; mid: number[]; hi: number[] }

function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** p10 / p50 / p90 band for one metric key, in the metric's own units. */
// metrics the model doesn't predict directly but that follow from one it does
const DERIVED: Record<string, [string, (v: number) => number]> = {
  energy: ['kardashev', (k) => 10 ** (k * 10 + 6)],
};

export function fanFor(f: Forecast, key: string): Fan | null {
  if (DERIVED[key]) {
    const [src, fn] = DERIVED[key];
    const base = fanFor(f, src);
    return base && { years: base.years, lo: base.lo.map(fn), mid: base.mid.map(fn), hi: base.hi.map(fn) };
  }
  const k = FORECAST_KEYS.indexOf(key);
  if (k < 0) return null;
  const fan: Fan = { years: [], lo: [], mid: [], hi: [] };
  f.years.forEach((y, t) => {
    const vals = f.samples.map((s) => featureToMetric(key, s[t * NF_ML + k]));
    // counts, distances and amounts can't go below zero
    const floor = (v: number) => (key === 'stability' || key === 'happiness' ? v : Math.max(0, v));
    fan.years.push(y); fan.lo.push(floor(quantile(vals, 0.1))); fan.mid.push(floor(quantile(vals, 0.5))); fan.hi.push(floor(quantile(vals, 0.9)));
  });
  return fan;
}

/** Share of imagined futures that enter era e within the first n decades. */
function eraWithin(f: Forecast, e: number, n: number): number {
  return f.eraPaths.filter((p) => p.subarray(0, n).includes(e)).length / f.eraPaths.length;
}

export function oddsHtml(f: Forecast, now: (key: string) => number): string {
  const end = f.years.length - 1;
  const line = (key: string, t: number) => {
    const d = GLOBAL_METRICS[GM[key]];
    const fan = fanFor(f, key);
    if (!fan) return '';
    const v = { lo: fan.lo[t], mid: fan.mid[t], hi: fan.hi[t] };
    return `<dt>${d.label}, ${fmtYear(f.years[t])}</dt><dd class="num">${fmtUnit(v.mid, d.unit)}<span class="muted"> (${fmtUnit(v.lo, d.unit)} – ${fmtUnit(v.hi, d.unit)})</span></dd>`;
  };
  const growth = (key: string) => {
    const k = FORECAST_KEYS.indexOf(key);
    const up = f.samples.filter((s) => featureToMetric(key, s[end * NF_ML + k]) > now(key)).length;
    return Math.round((100 * up) / f.samples.length);
  };
  const lastEra = Array.from({ length: NERA }, (_, e) => f.eraProb[end * NERA + e]);
  const likely = lastEra.indexOf(Math.max(...lastEra));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `
    <p class="lede">A ${(f.meta.params / 1000).toFixed(0)}k-parameter transformer read ${f.fromYear >= 640 ? 'the last 640 years' : `all ${f.fromYear} years so far`} of this future and imagined ${f.samples.length} ways the next ${f.years.length * 10} could go. It learned from 360 other futures and has never seen this one's dice. Tested on 40 futures it never saw, it cut the error of a "nothing changes" guess by 71% for population 400 years out and 96% for energy, but it is no better than that guess at predicting stability.</p>
    <dl class="odds">
      ${end >= 9 ? `<dt>War within 100 years</dt><dd class="num">${pct(eraWithin(f, 4, 10))}</dd>` : ''}
      ${end >= 29 ? `<dt>Collapse within 300 years</dt><dd class="num">${pct(eraWithin(f, 6, 30))}</dd>` : ''}
      ${end >= 9 ? `<dt>Golden age within 100 years</dt><dd class="num">${pct(eraWithin(f, 2, 10))}</dd>` : ''}
      <dt>Most likely era in ${fmtYear(f.years[end])}</dt><dd>${ERAS[likely]}</dd>
      <dt>More people in ${fmtYear(f.years[end])} than now</dt><dd class="num">${growth('pop')}% of futures</dd>
      <dt>More star systems settled</dt><dd class="num">${growth('systems')}% of futures</dd>
      ${end > 9 ? line('pop', 9) : ''}
      ${line('pop', end)}
      ${line('energy', end)}
      ${line('reach', end)}
    </dl>
    <p class="muted">Ranges are the middle 80% of imagined futures. Drag the slider forward to see what actually happened.</p>`;
}
