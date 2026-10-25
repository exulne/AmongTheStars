// Statistics of observed solar and geomagnetic activity, computed at ingest
// time from the GFZ Potsdam daily record (Kp/Ap since 1932, F10.7 since 1947;
// Matzka et al. 2021) and NOAA SWPC's monthly solar-cycle indices (since 1749).
// The deep-future generator (spaceWeather.ts) draws from these distributions,
// so the storms of year 7,000 are statistically like the storms of the record,
// not a replay of this week's forecast.

export interface CycleRecord { n: number; startYear: number; maxYear: number; lengthYears: number; riseYears: number; maxSsn: number }

export interface SpaceWeatherStats {
  /** daily records used */
  days: number; firstDate: string; lastDate: string;
  /** monthly smoothed relation: F10.7 (sfu) = f107Intercept + f107Slope × smoothed SSN (v2), with residual sd */
  f107Intercept: number; f107Slope: number; f107ResidualSd: number;
  /** daily F10.7 over its 81-day centred mean: log-normal sd */
  f107DailyLogSd: number;
  /** activity bins on the 81-day mean sunspot number, edges (upper bounds; last is open) */
  ssnBins: number[];
  /** per phase (0 rising, 1 declining) × bin: Ap quantiles at QUANTILES and storm-day probabilities */
  quantiles: number[];
  apQuantiles: number[][][];
  /** P(Ap ≥ 30), P(Ap ≥ 50), P(Ap ≥ 100), P(Ap ≥ 200) per phase × bin */
  stormThresholds: number[];
  stormProb: number[][][];
  /** P(Ap ≥ 30 tomorrow | Ap ≥ 30 today): storms come in runs */
  stormPersistence: number;
  /** complete cycles found in the monthly smoothed SSN */
  cycles: CycleRecord[];
  /** the cycle in progress at retrieval (cycle 25 began December 2019 per the NOAA/NASA prediction panel): its start, highest smoothed SSN so far and when */
  currentCycle: { n: number; startYear: number; maxSsn: number; maxYear: number; lastSmoothed: number; lastYear: number };
  /** daily Ap and F10.7 (observed) around the February 2022 Starlink loss */
  starlink2022: [string, number, number][];
  /** last two years of daily [date, Ap, F10.7obs] for "conditions now" */
  recent: [string, number, number][];
}

export const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999];
const SSN_BINS = [25, 60, 110, 170, Infinity];
const STORM = [30, 50, 100, 200];

interface Day { date: string; ap: number; sn: number; f107: number }

export function parseGfz(text: string): Day[] {
  const out: Day[] = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const c = line.trim().split(/\s+/);
    if (c.length < 28) continue;
    const date = `${c[0]}-${c[1]}-${c[2]}`;
    const ap = Number(c[23]), sn = Number(c[24]), f107 = Number(c[25]);
    if (ap < 0) continue;
    out.push({ date, ap, sn, f107 });
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const x = q * (sorted.length - 1), i = Math.floor(x), f = x - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/** Find cycle minima and maxima in a monthly smoothed series (month index → value). */
export function findCycles(months: { t: number; ssn: number }[]): CycleRecord[] {
  const s = months.filter((m) => m.ssn >= 0);
  // minima: lowest point in each window between maxima; use a ±48-month local extreme test
  const W = 48, mins: number[] = [], maxs: number[] = [];
  for (let i = W; i < s.length - W; i++) {
    let isMin = true, isMax = true;
    for (let k = i - W; k <= i + W; k++) { if (s[k].ssn < s[i].ssn) isMin = false; if (s[k].ssn > s[i].ssn) isMax = false; }
    if (isMin && (!mins.length || i - mins[mins.length - 1] > W)) mins.push(i);
    if (isMax && (!maxs.length || i - maxs[maxs.length - 1] > W)) maxs.push(i);
  }
  const cycles: CycleRecord[] = [];
  for (let k = 0; k + 1 < mins.length; k++) {
    const a = mins[k], b = mins[k + 1], m = maxs.find((x) => x > a && x < b);
    if (m === undefined) continue;
    cycles.push({ n: k + 1, startYear: s[a].t, maxYear: s[m].t, lengthYears: s[b].t - s[a].t, riseYears: s[m].t - s[a].t, maxSsn: s[m].ssn });
  }
  return cycles;
}

export function spaceWeatherStats(gfzText: string, monthly: Record<string, number | string>[]): SpaceWeatherStats {
  const days = parseGfz(gfzText);
  // 81-day centred means of SN and F10.7, and a phase from the 13-month change of the smoothed SN
  const n = days.length, snA = new Float64Array(n), fA = new Float64Array(n);
  {
    let sSn = 0, cSn = 0, sF = 0, cF = 0;
    const add = (i: number, w: number) => { if (days[i].sn >= 0) { sSn += w * days[i].sn; cSn += w; } if (days[i].f107 > 0) { sF += w * days[i].f107; cF += w; } };
    for (let i = 0; i < Math.min(41, n); i++) add(i, 1);
    for (let i = 0; i < n; i++) {
      if (i + 41 < n) add(i + 41, 1);
      if (i - 41 >= 0) add(i - 41, -1);
      snA[i] = cSn > 0 ? sSn / cSn : -1; fA[i] = cF > 0 ? sF / cF : -1;
    }
  }
  const phase = (i: number) => (i >= 200 && i + 200 < n ? (snA[i + 200] - snA[i - 200] >= 0 ? 0 : 1) : snA[i] - snA[Math.max(0, i - 400)] >= 0 ? 0 : 1);
  const binOf = (sn: number) => SSN_BINS.findIndex((e) => sn < e);
  const buckets: number[][][] = [0, 1].map(() => SSN_BINS.map(() => []));
  let logSum = 0, logSq = 0, logN = 0, stormDays = 0, stormRuns = 0;
  for (let i = 0; i < n; i++) {
    if (snA[i] < 0) continue;
    buckets[phase(i)][binOf(snA[i])].push(days[i].ap);
    if (days[i].f107 > 0 && fA[i] > 0) { const l = Math.log(days[i].f107 / fA[i]); logSum += l; logSq += l * l; logN++; }
    if (i > 0 && days[i - 1].ap >= 30) { stormDays++; if (days[i].ap >= 30) stormRuns++; }
  }
  for (const ph of buckets) for (const b of ph) b.sort((x, y) => x - y);
  const logMean = logSum / logN;

  // monthly relation F10.7 ~ SSN (smoothed), least squares where both exist
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  const pts: [number, number][] = [];
  for (const r of monthly) {
    const x = Number(r.smoothed_ssn), y = Number(r['smoothed_f10.7']);
    if (x >= 0 && y > 0) { pts.push([x, y]); sx += x; sy += y; sxx += x * x; sxy += x * y; m++; }
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), icpt = (sy - slope * sx) / m;
  const resid = Math.sqrt(pts.reduce((a, [x, y]) => a + (y - icpt - slope * x) ** 2, 0) / Math.max(1, m - 2));

  const months = monthly.map((r) => { const [y, mo] = String(r['time-tag']).split('-').map(Number); return { t: y + (mo - 0.5) / 12, ssn: Number(r.smoothed_ssn) }; });
  const cycles = findCycles(months);

  const since = months.filter((mm) => mm.t >= 2019.9 && mm.ssn >= 0);
  const peak = since.reduce((a, b) => (b.ssn > a.ssn ? b : a), since[0] ?? { t: 2019.96, ssn: 0 });
  const lastS = since[since.length - 1] ?? peak;
  const currentCycle = { n: 25, startYear: 2019.96, maxSsn: peak.ssn, maxYear: peak.t, lastSmoothed: lastS.ssn, lastYear: lastS.t };
  const pick = (from: string, to: string): [string, number, number][] => days.filter((d) => d.date >= from && d.date <= to).map((d) => [d.date, d.ap, d.f107]);
  const last = days[n - 1].date, y2 = `${Number(last.slice(0, 4)) - 2}${last.slice(4)}`;
  return {
    days: n, firstDate: days[0].date, lastDate: last,
    f107Intercept: icpt, f107Slope: slope, f107ResidualSd: resid,
    f107DailyLogSd: Math.sqrt(Math.max(0, logSq / logN - logMean * logMean)),
    ssnBins: SSN_BINS.map((e) => (Number.isFinite(e) ? e : 1e9)),
    quantiles: QUANTILES,
    apQuantiles: buckets.map((ph) => ph.map((b) => QUANTILES.map((q) => quantile(b, q)))),
    stormThresholds: STORM,
    stormProb: buckets.map((ph) => ph.map((b) => STORM.map((t) => (b.length ? b.filter((x) => x >= t).length / b.length : 0)))),
    stormPersistence: stormDays ? stormRuns / stormDays : 0,
    cycles,
    currentCycle,
    starlink2022: pick('2022-01-25', '2022-02-15'),
    recent: pick(y2, last),
  };
}
