// Each future (one seed of the same rules) as one universe of the multiverse:
// what it came to, read from its global series, and a card for it.

import { ERAS } from '../sim/catalog.ts';
import { GM, NGM } from '../sim/metrics.ts';
import { fmtNum } from '../ui/format.ts';
import type { Explanation, Fact } from './registry.ts';

export type Outcome = 'died' | 'fell' | 'stars' | 'spread' | 'home';
export const OUTCOME_NAME: Record<Outcome, string> = { died: 'Died out', fell: 'Rose and fell', stars: 'Spread across the stars', spread: 'Reached a few stars', home: 'Stayed in the Solar System' };
export const OUTCOME_COLOR: Record<Outcome, number> = { died: 0x6a6a72, fell: 0xc07a5e, stars: 0xf0cf86, spread: 0x8fc8ff, home: 0xb4a4dc };

export interface FutureSum {
  seed: number;
  done: boolean;          // played to year 10,000 (else: still being simulated)
  lastYear: number;       // years after 2040 reached so far
  peakPop: number; peakPopYear: number; finalPop: number;
  peakK: number; finalK: number;
  peakSystems: number; firstStarYear: number | null;
  reach: number; wars: number; techs: number;
  warShare: number; collapseShare: number; goldenShare: number;
  outcome: Outcome;
}

/** Read a future's global series (NGM numbers per step) into what it came to. */
export function summarise(seed: number, years: ArrayLike<number>, series: Float64Array, nSteps: number, done: boolean): FutureSum {
  const n = Math.min(nSteps, Math.floor(series.length / NGM), years.length);
  const at = (i: number, k: string) => series[i * NGM + GM[k]];
  let peakPop = 0, peakPopYear = 0, peakK = 0, peakSystems = 0, reach = 0, firstStarYear: number | null = null;
  let war = 0, col = 0, gold = 0, span = 0;
  const W = ERAS.indexOf('War'), Cc = ERAS.indexOf('Collapse'), G = ERAS.indexOf('Golden Age');
  for (let i = 0; i < n; i++) {
    const p = at(i, 'pop');
    if (p > peakPop) { peakPop = p; peakPopYear = years[i]; }
    peakK = Math.max(peakK, at(i, 'kardashev'));
    const s = at(i, 'systems');
    peakSystems = Math.max(peakSystems, s);
    if (firstStarYear === null && s > 1) firstStarYear = years[i];
    reach = Math.max(reach, at(i, 'reach'));
    const dt = i + 1 < n ? years[i + 1] - years[i] : 0, e = at(i, 'era');
    span += dt;
    if (e === W) war += dt; else if (e === Cc) col += dt; else if (e === G) gold += dt;
  }
  const last = Math.max(0, n - 1);
  const finalPop = at(last, 'pop');
  const outcome: Outcome = finalPop < 1000 ? 'died' : finalPop < 0.2 * peakPop ? 'fell' : peakSystems >= 50 ? 'stars' : peakSystems > 1 ? 'spread' : 'home';
  return {
    seed, done, lastYear: years[last] ?? 0, peakPop, peakPopYear, finalPop, peakK, finalK: at(last, 'kardashev'), peakSystems, firstStarYear, reach,
    wars: at(last, 'wars'), techs: at(last, 'techs'),
    warShare: span ? war / span : 0, collapseShare: span ? col / span : 0, goldenShare: span ? gold / span : 0, outcome,
  };
}

const f = (k: string, v: string, t: Fact['t']): Fact => ({ k, v, t });
const yr = (y: number) => String(Math.round(2040 + y));

export function futureCard(s: FutureSum, current: boolean, rankOf: (s: FutureSum) => number, count: number): Explanation {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const facts: Fact[] = [
    f('Outcome', OUTCOME_NAME[s.outcome], 'P'),
    f('Peak population', `${fmtNum(s.peakPop)} in ${yr(s.peakPopYear)}`, 'P'),
    f(s.done ? 'Population in 12040' : `Population in ${yr(s.lastYear)}`, fmtNum(s.finalPop), 'P'),
    f('Kardashev rating reached', s.peakK.toFixed(3), 'P'),
    f('Star systems settled, at most', fmtNum(s.peakSystems), 'P'),
    f('First settlement beyond the Sun', s.firstStarYear === null ? 'never' : yr(s.firstStarYear), 'P'),
    f('Farthest settlement', `${fmtNum(s.reach)} light years`, 'P'),
    f('Wars fought', fmtNum(s.wars), 'P'),
    f('Time spent at war, in collapse, in golden ages', `${pct(s.warShare)}, ${pct(s.collapseShare)}, ${pct(s.goldenShare)}`, 'P'),
    f('Technologies invented', fmtNum(s.techs), 'P'),
  ];
  if (count > 1) facts.push(f('Rank by peak population among the futures shown', `${rankOf(s)} of ${count}`, 'E'));
  return {
    eyebrow: current ? 'This future · a universe of the multiverse' : 'Another future · a universe of the multiverse',
    title: `Future #${s.seed}`,
    lede: `${s.done ? '' : `Still being played (year ${yr(s.lastYear)}). `}The same rules and the same starting Solar System as every other future here, with different dice. ${OUTCOME_NAME[s.outcome]}${s.outcome === 'stars' ? `: ${fmtNum(s.peakSystems)} star systems at its height` : ''}.`,
    facts,
    why: current ? 'You are in this one. Enter another bubble to switch the simulation to that future.' : 'Enter it to play this future from 2040: everything else in the app (worlds, people, charts) will be that future\'s.',
    links: [{ label: current ? 'Go back into this future' : 'Enter this future', act: 'enter', id: 0 }],
  };
}

export function unplayedCard(seed: number): Explanation {
  return {
    eyebrow: 'A future not yet played', title: `Future #${seed}`,
    lede: 'One of the 99,999 futures this simulation can roll. Nobody has played it yet: entering it runs it from the Mars landing in 2040.',
    facts: [f('Seed', String(seed), 'P'), f('Rules', 'the same as every other future', 'P'), f('Outcome', 'unknown until played', 'P')],
    links: [{ label: 'Play this future', act: 'enter', id: 0 }],
  };
}

/** The seed of foam particle i: spread over the whole range, never 0. */
export const foamSeed = (i: number) => 1 + ((i * 7919 + 104729) % 99991);
