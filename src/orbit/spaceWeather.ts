// Solar and geomagnetic activity as drag inputs, from three sources kept apart:
//
// 1. Observed: the snapshot's daily Ap and F10.7 (GFZ, NOAA SWPC), used for
//    "conditions now" and for validation (the February 2022 Starlink storm).
// 2. Atmosphere modes for scenario studies: quiet, nominal, disturbed.
// 3. Seeded deep-future activity: solar cycles bootstrapped from the 24
//    complete cycles in the record (amplitude, length and rise kept together,
//    so the Waldmeier relation survives), shaped with Hathaway et al.'s (1994)
//    cycle function, with occasional grand minima at the long-run rate
//    reconstructed by Usoskin et al. (2007); daily Ap drawn from the observed
//    distribution for the same activity level and cycle phase, with storms as
//    runs at the observed persistence. A present-day forecast is never
//    extended centuries ahead.
//
// Everything is a pure function of (seed, day): any day can be asked for
// directly, so the engine and the inspector agree without shared state.

import { hash01 } from '../sim/rng.ts';
import type { SpaceWeatherStats } from './spaceWeatherStats.ts';

export interface SW { f107: number; f107a: number; ap: number }
export type WeatherFn = (day: number) => SW;
export type AtmoMode = 'quiet' | 'nominal' | 'storm';

export const MODE_LABEL: Record<AtmoMode, string> = {
  quiet: 'Quiet sun (solar-minimum flux, Ap ≈ 4)',
  nominal: 'Nominal solar cycle (seeded, observed statistics)',
  storm: 'Disturbed (high-activity cycle phase, frequent storms)',
};

/** Days since 2000-01-01 00:00 UTC. */
export const dayOf = (ms: number) => (ms - Date.UTC(2000, 0, 1)) / 86400e3;
export const dayOfYear = (calendarYear: number) => (Date.UTC(Math.floor(calendarYear), 0, 1) - Date.UTC(2000, 0, 1)) / 86400e3 + (calendarYear % 1) * 365.25;
export const yearOfDay = (d: number) => 2000 + d / 365.25;

export function constantWeather(sw: SW): WeatherFn { return () => sw; }

// ---------------------------------------------------------------- solar cycles

interface Cycle { start: number; amp: number; length: number; rise: number; b: number; grand: boolean }

/** Hathaway, Wilson & Reichmann (1994) cycle shape: f(x) = x³ / (exp(x²) − c), c = 0.71, normalised to peak 1 at x = 1. */
const C = 0.71;
const shape = (x: number) => (x <= 0 ? 0 : x ** 3 / (Math.exp(x * x) - C));
const XPEAK = (() => { let best = 0, xb = 0; for (let x = 0.01; x < 3; x += 0.0005) { const v = shape(x); if (v > best) { best = v; xb = x; } } return xb; })();
const PEAK = shape(XPEAK);

/** Usoskin et al. (2007): ≈ 27 grand minima in 11,400 years, ≈ 17% of the time. */
const GRAND_START_PER_CYCLE = 27 / (11400 / 11);
const GRAND_CYCLES: [number, number] = [3, 8];
const GRAND_AMP = 0.12; // a grand minimum keeps a weak residual cycle

export class SolarActivity {
  readonly seed: number;
  private stats: SpaceWeatherStats;
  private cycles: Cycle[] = [];
  constructor(stats: SpaceWeatherStats, seed: number, untilYear = 12200) {
    this.stats = stats; this.seed = seed;
    const cur = stats.currentCycle;
    // cycle 25 as observed so far; its length and decline are not yet known, so they are drawn like any other's
    const proto = (k: number) => stats.cycles[Math.floor(hash01(seed, k, 101) * stats.cycles.length)];
    const p25 = proto(25);
    // its width is fitted so the curve passes through the latest observed smoothed value on the decline
    const c25: Cycle = { start: cur.startYear, amp: cur.maxSsn, length: p25.lengthYears, rise: cur.maxYear - cur.startYear, b: 0, grand: false };
    this.push(c25);
    if (cur.lastYear > cur.maxYear && cur.lastSmoothed > 0) {
      let lo = 0.3, hi = 6;
      for (let it = 0; it < 60; it++) { const b = (lo + hi) / 2; if ((cur.maxSsn * shape((cur.lastYear - cur.startYear) / b)) / PEAK > cur.lastSmoothed) hi = b; else lo = b; }
      c25.b = (lo + hi) / 2; c25.rise = c25.b * XPEAK;
    }
    let t = cur.startYear + Math.max(p25.lengthYears, cur.lastYear - cur.startYear + 1), k = 26, grandLeft = 0;
    while (t < untilYear) {
      const p = proto(k), j = (s: number) => 1 + 0.1 * (2 * hash01(seed, k, s) - 1);
      if (grandLeft === 0 && hash01(seed, k, 107) < GRAND_START_PER_CYCLE) grandLeft = GRAND_CYCLES[0] + Math.floor(hash01(seed, k, 108) * (GRAND_CYCLES[1] - GRAND_CYCLES[0] + 1));
      const grand = grandLeft > 0;
      if (grand) grandLeft--;
      const length = p.lengthYears * j(102);
      this.push({ start: t, amp: p.maxSsn * j(103) * (grand ? GRAND_AMP : 1), length, rise: Math.min(length * 0.7, p.riseYears * j(104)), b: 0, grand });
      t += length; k++;
    }
  }

  private push(c: Cycle): void { c.b = c.rise / XPEAK; this.cycles.push(c); }

  private cycleIndex(year: number): number {
    let lo = 0, hi = this.cycles.length - 1;
    if (year <= this.cycles[0].start) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cycles[m].start <= year) lo = m; else hi = m - 1; }
    return lo;
  }

  /** Smoothed (13-month) sunspot number at a calendar year: this cycle plus the tail of the last one. */
  ssn(year: number): number {
    const i = this.cycleIndex(year);
    let s = 0;
    for (const j of [i - 1, i]) {
      const c = this.cycles[j];
      if (c) s += (c.amp * shape((year - c.start) / c.b)) / PEAK;
    }
    return Math.max(0, s);
  }

  /** 0 rising, 1 declining */
  phase(year: number): 0 | 1 { const c = this.cycles[this.cycleIndex(year)]; return year - c.start < c.rise ? 0 : 1; }
  inGrandMinimum(year: number): boolean { return this.cycles[this.cycleIndex(year)].grand; }
  cycleNumber(year: number): number { return 25 + this.cycleIndex(year); }
  cycleAt(year: number): { n: number; start: number; amp: number; length: number; grand: boolean } {
    const i = this.cycleIndex(year), c = this.cycles[i];
    return { n: 25 + i, start: c.start, amp: c.amp, length: c.length, grand: c.grand };
  }

  /** 81-day-mean F10.7 (sfu) from the observed monthly F10.7–SSN relation. */
  f107a(year: number): number { return Math.max(65, this.stats.f107Intercept + this.stats.f107Slope * this.ssn(year)); }

  /** Daily values for day index d (days since 2000-01-01). */
  day(d: number, mode: AtmoMode = 'nominal'): SW {
    if (mode === 'quiet') return { f107: 70, f107a: 70, ap: 4 };
    const year = yearOfDay(d), fa = this.f107a(year), sd = this.stats.f107DailyLogSd;
    // 27-day rotational modulation plus day-to-day noise, lognormal around the 81-day mean
    const rot = Math.sin((2 * Math.PI * d) / 27 + 2 * Math.PI * hash01(this.seed, Math.floor(d / 27), 211));
    const f107 = fa * Math.exp(sd * (0.8 * rot + 0.6 * gauss(this.seed, d, 212)));
    const ap = this.apOn(d, year, mode);
    return { f107, f107a: fa, ap };
  }

  weather(mode: AtmoMode): WeatherFn { return (d) => this.day(d, mode); }

  private apOn(d: number, year: number, mode: AtmoMode): number {
    const st = this.stats, ssn = this.ssn(year);
    const ph = mode === 'storm' ? 1 : this.phase(year);
    const bin = mode === 'storm' ? st.ssnBins.length - 1 : st.ssnBins.findIndex((e) => ssn < e);
    const q = st.apQuantiles[ph][bin], ps = st.stormProb[ph][bin];
    // quiet-time draw from the observed quantiles below the storm threshold
    const pStorm = ps[0];
    const u = hash01(this.seed, Math.floor(d), 301) * (1 - pStorm);
    let ap = invQuantile(st.quantiles, q, u);
    if (mode === 'storm') ap = Math.max(ap, invQuantile(st.quantiles, q, 0.75 + 0.2 * hash01(this.seed, Math.floor(d), 302)));
    // storms: onsets at the observed rate, runs at the observed persistence; looked up in this and the previous 30-day block
    const rateMult = mode === 'storm' ? 4 : 1;
    for (const blk of [Math.floor(d / 30) - 1, Math.floor(d / 30)]) {
      const onsetsPerDay = pStorm * (1 - st.stormPersistence) * rateMult;
      const n = poisson(onsetsPerDay * 30, hash01(this.seed, blk, 303));
      for (let s = 0; s < n; s++) {
        const start = blk * 30 + Math.floor(hash01(this.seed, blk, 310 + s) * 30);
        const len = 1 + Math.floor(Math.log(Math.max(1e-9, hash01(this.seed, blk, 330 + s))) / Math.log(Math.max(1e-6, st.stormPersistence)));
        if (Math.floor(d) >= start && Math.floor(d) < start + len) ap = Math.max(ap, stormAp(st, ph, bin, hash01(this.seed, blk, 350 + s), Math.floor(d) - start));
      }
    }
    return ap;
  }
}

/** Ap on a storm day: from the observed tail P(Ap ≥ x | storm) between the 30/50/100/200 thresholds (log-linear). */
function stormAp(st: SpaceWeatherStats, ph: number, bin: number, u: number, dayInStorm: number): number {
  const p = st.stormProb[ph][bin], t = st.stormThresholds;
  const surv = p.map((x) => x / Math.max(p[0], 1e-9)); // P(Ap ≥ t_k | Ap ≥ 30)
  const target = 1 - u * 0.999;
  for (let k = 0; k + 1 < t.length; k++) {
    if (surv[k + 1] <= target && surv[k] >= target) {
      const f = Math.log(surv[k] / target) / Math.log(surv[k] / Math.max(surv[k + 1], 1e-9));
      return t[k] * (t[k + 1] / t[k]) ** f * (dayInStorm ? 0.8 : 1);
    }
  }
  return surv[t.length - 1] > target ? t[t.length - 1] * 1.3 : t[0];
}

function invQuantile(qs: number[], vals: number[], u: number): number {
  if (u <= qs[0]) return vals[0] * (u / qs[0]) ** 0.5;
  for (let i = 0; i + 1 < qs.length; i++) if (u <= qs[i + 1]) return vals[i] + ((u - qs[i]) / (qs[i + 1] - qs[i])) * (vals[i + 1] - vals[i]);
  return vals[vals.length - 1];
}

function gauss(seed: number, d: number, salt: number): number {
  const u = Math.max(1e-12, hash01(seed, Math.floor(d), salt)), v = hash01(seed, Math.floor(d), salt + 1);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poisson(lambda: number, u: number): number {
  let k = 0, p = Math.exp(-lambda), c = p;
  while (u > c && k < 50) { k++; p *= lambda / k; c += p; }
  return k;
}

/** Observed daily weather from the snapshot's recent record, or null outside it. */
export function observedWeather(stats: SpaceWeatherStats): WeatherFn & { has: (d: number) => boolean } {
  const m = new Map<number, SW>();
  const rows = [...stats.starlink2022, ...stats.recent];
  for (const [date, ap, f] of rows) {
    const d = Math.floor(dayOf(Date.parse(`${date}T00:00:00Z`)));
    m.set(d, { ap, f107: f > 0 ? f : NaN, f107a: NaN });
  }
  // 81-day means where the record allows
  for (const [d, v] of m) {
    let s = 0, n = 0;
    for (let k = -40; k <= 40; k++) { const x = m.get(d + k); if (x && x.f107 > 0) { s += x.f107; n++; } }
    v.f107a = n ? s / n : v.f107;
  }
  const fn = ((d: number) => m.get(Math.floor(d)) ?? { f107: 120, f107a: 120, ap: 7 }) as WeatherFn & { has: (d: number) => boolean };
  fn.has = (d) => m.has(Math.floor(d));
  return fn;
}
