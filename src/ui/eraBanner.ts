// When the age turns, say so: a quiet title across the top of the sky,
// "The Third Expansion", with when it began and what it feels like. Eras
// that come back are counted, so a future reads as a history.

import { ERAS } from '../sim/catalog.ts';
import { fmtYear } from './format.ts';
import './eraBanner.css';

const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth',
  'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth'];
function ordinal(n: number): string {
  if (n <= ORD.length) return ORD[n - 1];
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

const BLURB: Record<string, string> = {
  Expansion: 'Ships leave faster than they can be named.',
  Consolidation: 'The frontier slows; the settled worlds fill in.',
  'Golden Age': 'Plenty, and the lights burn warm.',
  Stagnation: 'Nothing new for a long while.',
  War: 'Settlements turn their fleets on each other.',
  Pandemic: 'A sickness moves along the shipping lanes.',
  Collapse: 'The grids fail. Whole worlds go dark.',
  Renaissance: 'Out of the ruins, a flowering.',
};

export interface EraRun { era: number; count: number; startYear: number }

/**
 * Which era holds at `step`, how many times it has come round (counting this one),
 * and the year this spell of it began. Spells shorter than `minYears` don't count
 * as a return, so a brief flicker doesn't turn the Expansion into the Ninth.
 */
export function eraRun(years: number[], era: (i: number) => number, step: number, minYears = 8): EraRun {
  const cur = era(step);
  let start = step;
  while (start > 0 && era(start - 1) === cur) start--;
  let count = 1;
  for (let i = start - 1; i >= 0;) {
    const e = era(i);
    let j = i;
    while (j > 0 && era(j - 1) === e) j--;
    const len = (years[i + 1] ?? years[i]) - years[j];
    if (e === cur && len >= minYears) count++;
    i = j - 1;
  }
  return { era: cur, count, startYear: years[start] ?? 0 };
}

/** "Expansion" the first time, "Third Expansion" after. */
export function eraTitle(r: EraRun): string {
  const name = ERAS[r.era] ?? '';
  return r.count > 1 ? `${ordinal(r.count)} ${name}` : name;
}

export class EraBanner {
  el: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private shown = '';
  private hideTimer = 0;
  private showTimer = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'era-banner';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.el.innerHTML = '<b></b><span></span>';
    this.title = this.el.querySelector('b')!;
    this.sub = this.el.querySelector('span')!;
  }

  private primed = false;
  /** A new future: its first era is taken as given, not announced. */
  reset(): void { this.shown = ''; this.primed = false; this.el.classList.remove('on'); clearTimeout(this.showTimer); }

  /** Announce the era if it differs from the last one shown. Scrubbing fast only shows where it lands. */
  show(r: EraRun): void {
    const t = eraTitle(r);
    const key = `${r.era}:${r.count}`;
    if (key === this.shown) return;
    this.shown = key;
    if (!this.primed) { this.primed = true; return; }
    clearTimeout(this.showTimer);
    this.showTimer = window.setTimeout(() => {
      this.title.textContent = `The ${t}`;
      this.sub.textContent = `from ${fmtYear(r.startYear)} · ${BLURB[ERAS[r.era]] ?? ''}`;
      this.el.dataset.era = ERAS[r.era]?.toLowerCase().replace(/\s+/g, '-') ?? '';
      this.el.classList.remove('on');
      void this.el.offsetWidth;
      this.el.classList.add('on');
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.el.classList.remove('on'), 4200);
    }, 260);
  }
}
