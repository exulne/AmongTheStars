// Age structure shared by the engine (12 bins per settlement) and the people
// model (5-year birth cohorts). One mortality law and one fertility law, so the
// engine's deaths and the census's deaths come from the same curve.
//
// Mortality: Gompertz–Makeham hazard μ(x) = A + B·e^{b·x} (Gompertz 1825,
// Makeham 1860), plus an under-5 term. A is extrinsic risk (accidents, hostile
// worlds, famine, war), B the level and b the rate of ageing. Calibration
// (continuous life table, see `lifeExpectancy`):
//   A = 4e-4, B = 3e-5, b = 0.090, under-5 0.005/yr → e0 ≈ 79 (UN WPP 2024: world
//     e0 73.3 in 2024, ≈ 77 by 2040; rich countries ≈ 83)
//   genetic medicine B × 0.13 (the curve shifts ≈ 23 yr right)  → e0 ≈ 100
//   radical life extension b → 0.045 (ageing at half speed)     → e0 ≈ 190
// Ageing is a gate on b, not an endless multiplier: no stack of small inventions
// moves b; they only trim A (down to the accident floor A_MIN) and B (to half).
// A gate is not switched on the day it is invented: it is deployed along a
// logistic S-curve (invention-model §6.3), x(t) = 1 / (1 + 99·e^{−t/τ}), 1% at
// invention, 50% after τ·ln 99 ≈ 4.6τ. The hazard is the mixture of treated and
// untreated people, so B and b move linearly with x. With τ = 6 yr genetic
// medicine lifts e0 by ≈ 0.45 yr per year at its fastest, a little above the
// best-practice record of +0.25 yr/yr since 1840 (Oeppen & Vaupel 2002, Science 296:1029).
//
// Fertility: total fertility follows the demographic transition,
//   TFR = 1.6 + 2.5·exp(−y_ppp / 20,000)
// with y_ppp the product per person at purchasing-power parity. The sim's $ are
// market-exchange-rate dollars; world GDP at PPP is ≈ 1.75× GDP at market rates
// (World Bank WDI 2023: $185T PPP vs $105T), so y_ppp = 1.75·y. Earth 2040
// ($17.4k MER, $30k PPP) gives 2.15 (UN WPP 2024 medium: 2.1 around 2040).

/** Lower edges of the 12 engine age bins, years. The last bin is open. */
export const AGE_EDGES = [0, 5, 15, 25, 35, 45, 60, 75, 90, 110, 140, 200] as const;
export const NAGE = AGE_EDGES.length;
export const AGE_W: number[] = AGE_EDGES.map((x, i) => (i + 1 < NAGE ? AGE_EDGES[i + 1] - x : 100));
/** Share of a woman's lifetime births falling in each bin (peak 25–35). */
export const FERT_SHARE: number[] = [0, 0, 0.33, 0.45, 0.2, 0.02, 0, 0, 0, 0, 0, 0];
/** Share of each bin that is of working age (15–65). */
export const WORK_SHARE: number[] = [0, 0, 1, 1, 1, 1, 1 / 3, 0, 0, 0, 0, 0];

export const GM_A0 = 4e-4, GM_B0 = 3e-5, GM_b0 = 0.09, GM_INFANT = 0.005;
/** Extrinsic-risk floor: accidents and violence never vanish. WHO GHE 2019: injuries kill
 *  ≈ 4.4M a year (≈ 5.6e-4/person-yr); the safest rich countries ≈ 2e-4. */
export const A_MIN = 1e-4;

/** Logistic deployment of a technology t years after invention with time constant tau. */
export function deployed(t: number, tau: number): number {
  return t < 0 ? 0 : 1 / (1 + 99 * Math.exp(-t / Math.max(0.1, tau)));
}
export const PPP = 1.75;

export interface Mortality { A: number; B: number; b: number; inf: number }

/** Hazard at exact age x. */
export function hazard(x: number, m: Mortality): number {
  return m.A + m.B * Math.exp(m.b * Math.max(0, x)) + (x < 5 ? m.inf : 0);
}

/** Mean hazard over bin k (exact integral of the Gompertz term over the bin). */
export function binHazard(k: number, m: Mortality): number {
  const x0 = AGE_EDGES[k], w = AGE_W[k];
  const g = k + 1 < NAGE ? (m.B * (Math.exp(m.b * (x0 + w)) - Math.exp(m.b * x0))) / (m.b * w) : m.B * Math.exp(m.b * (x0 + 30));
  return m.A + g + (k === 0 ? m.inf : 0);
}

/** Total fertility rate from product per person (market $), before policy and crowding. */
export function tfrTransition(gdpPerCap: number): number {
  return 1.6 + 2.5 * Math.exp(-(PPP * Math.max(0, gdpPerCap)) / 20000);
}

/** Under-5 hazard falls with income (UN IGME: under-5 mortality ≈ 3.7% in 2022, ≈ 0.4% in rich countries). */
export function infantHazard(gdpPerCap: number): number {
  return 0.05 * Math.exp(-(PPP * Math.max(0, gdpPerCap)) / 12000) + 0.0008;
}

/** Period life expectancy at birth from bin hazards (piecewise-constant life table). */
export function lifeExpectancyBins(mu: ArrayLike<number>): number {
  let l = 1, L = 0;
  for (let k = 0; k < NAGE; k++) {
    const m = Math.max(1e-9, mu[k]);
    if (k + 1 === NAGE) { L += l / m; break; }
    const s = Math.exp(-m * AGE_W[k]);
    L += (l * (1 - s)) / m;
    l *= s;
  }
  return L;
}

/** Median age of a binned population (linear inside a bin). */
export function medianAge(N: ArrayLike<number>, off = 0): number {
  let tot = 0;
  for (let k = 0; k < NAGE; k++) tot += N[off + k];
  if (tot <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < NAGE; k++) {
    const n = N[off + k];
    if (acc + n >= tot / 2) return AGE_EDGES[k] + (n > 0 ? ((tot / 2 - acc) / n) * AGE_W[k] : 0);
    acc += n;
  }
  return AGE_EDGES[NAGE - 1];
}

/** Earth's 2040 population by 5-year age group, millions (UN WPP 2024 medium variant,
 *  rounded): ages 0–4 … 95–99. Median age ≈ 34. */
const UN2040 = [650, 660, 670, 680, 680, 670, 660, 640, 620, 580, 550, 500, 450, 390, 320, 230, 140, 70, 25, 8];

/** Earth's 2040 age pyramid in 5-year cohorts born 1920–2040 (oldest first), summing to `total`. */
export function earthPyramid(total: number): number[] {
  const w: number[] = [];
  for (let k = -24; k < 0; k++) w.push(UN2040[-k - 1] ?? 0);
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => Math.round((x / s) * total));
}

/** The same pyramid in engine bins. */
export function earthBins(total: number): number[] {
  const out = new Array<number>(NAGE).fill(0);
  const coh = earthPyramid(total);
  coh.forEach((n, i) => {
    const age = (24 - i) * 5 - 2.5;
    let k = NAGE - 1;
    while (k > 0 && AGE_EDGES[k] > age) k--;
    out[k] += n;
  });
  return out;
}

/** A founding crew or a ship's colonists: working-age adults. */
export const CREW_AGES: number[] = [0, 0, 0.25, 0.4, 0.25, 0.1, 0, 0, 0, 0, 0, 0];
/** Migrants are mostly young adults (bible §7.3: 80% aged 20–44). */
export const MIGRANT_AGES: number[] = [0.05, 0.05, 0.4, 0.35, 0.15, 0, 0, 0, 0, 0, 0, 0];
