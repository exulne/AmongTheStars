// Pick one person out of this future and follow their whole life. Filters:
// the world they were born on (or anywhere that saw a birth), their number
// among its births (or a random draw), their kind of human, and any of the
// derived standing stats — wealth percentile, age, height, mood, health,
// education. Choosing them opens their biography.

import type { Biography, PersonBrief, PickWant } from '../sim/lives.ts';
import { MOODS_BAD, MOODS_GOOD } from '../sim/lives.ts';
import { isShipBody } from '../sim/ledger.ts';
import { fmtNum, fmtYear, parseCount } from './format.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FindResult {
  life?: { year: number; text: string; body?: number }[];
  person: string | null; brief: PersonBrief | null; total: number; scanned: number; pending?: boolean;
  standing?: Biography['standing'];
}
export interface LifePickOpts {
  /** worlds anyone was ever born on; pending while the future still simulates */
  bodies: () => Promise<{ bodies: number[]; pending?: boolean }>;
  /** the default birthplace (Earth), pinned to the top of the list */
  home: number;
  nameOf: (b: number) => string;
  year: () => number;
  find: (body: number, n: number, kind: string, year: number, want?: PickWant) => Promise<FindResult>;
  /** jump the simulation clock to a year and focus a body, when one is given */
  seek: (year: number, body?: number) => void;
  /** open the chosen person's biography */
  open: (pid: string) => void;
}

const HEALTH_OPTS: [string, string][] = [
  ['healthy', 'healthy'], ['scarred', 'scarred by an event'], ['frail', 'frail'],
  ['chronic', 'a chronic condition'], ['uploaded', 'a mind on a substrate'], ['engineered', 'engineered for their world'],
];
const EDU_OPTS = ['the universities', 'the technical colleges', 'service training', 'apprenticed into administration', 'learned the work', 'in school'];

const sel = (cls: string, label: string, opts: [string, string][]) =>
  `<label>${label} <select class="${cls}" aria-label="${label}">${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const range = (cls: string, label: string, lo: string, hi: string) =>
  `<label>${label} <span class="lp-range"><input class="${cls}-lo" inputmode="numeric" placeholder="${lo}" aria-label="${label} from"><span>–</span><input class="${cls}-hi" inputmode="numeric" placeholder="${hi}" aria-label="${label} to"></span></label>`;

/** The filters the form asks for, built from raw control values: `v(key)` returns a
 *  control's value ('' for blank or rolled), keyed by its class suffix without `.lp-`
 *  ('wealth-lo', 'born-hi', 'sex', 'mood', 'health', 'edu'). Pure, so it can run in Node. */
export function buildWant(v: (key: string) => string): PickWant {
  const num = (key: string) => { const x = parseCount(v(key)); return Number.isFinite(x) ? x : undefined; };
  /** a year the user typed: calendar years (>= 1900) convert to sim years, small numbers are sim years */
  const yr = (x: number | undefined) => (x === undefined ? undefined : x >= 1900 ? x - 2040 : x);
  const loW = num('wealth-lo'), hiW = num('wealth-hi');
  const loA = num('age-lo'), hiA = num('age-hi');
  const loH = num('height-lo'), hiH = num('height-hi');
  const loM = num('moves-lo'), hiM = num('moves-hi');
  const loB = yr(num('born-lo')), hiB = yr(num('born-hi'));
  const w: PickWant = {};
  if (loW !== undefined || hiW !== undefined) w.wealth = [Math.max(0, Math.min(100, 100 - (hiW ?? 100))), Math.max(0, Math.min(100, 100 - (loW ?? 0)))];
  if (loA !== undefined || hiA !== undefined) w.age = [loA ?? 0, hiA === undefined ? 1e6 : hiA + 1];       // a whole year: [y, y+1)
  if (loH !== undefined || hiH !== undefined) w.height = [loH ?? 0, hiH ?? 1e6];
  if (loM !== undefined || hiM !== undefined) w.moves = [loM ?? 0, hiM ?? 1e6];
  if (loB !== undefined || hiB !== undefined) w.born = [loB ?? -1e6, hiB === undefined ? 1e6 : hiB + 1];   // a whole year: [y, y+1)
  if (v('sex')) w.sex = v('sex') as 'f' | 'm';
  if (v('mood')) w.mood = v('mood');
  if (v('health')) w.health = v('health');
  if (v('edu')) w.education = v('edu');
  return w;
}

const RUN_END = 10000;   // the last sim year (calendar 12040)

/** The year a search looks at. A born range that starts at or after the viewed year is searched once
 *  everyone in it has been born (born-hi + 1); an open-ended one, or one running past the run's end, at a
 *  uniformly random whole year in (born-lo, end], drawn from r in [0, 1). Otherwise the viewed year. */
export function searchYear(want: PickWant | undefined, viewed: number, end: number, r: number): number {
  const b = want?.born;
  if (!b || b[0] < viewed) return viewed;
  if (b[1] <= end) return b[1];
  return b[0] >= end ? end : Math.max(Math.floor(b[0]) + 1, Math.ceil(end - r * (end - b[0])));
}

/** Why a search found nobody, as plain text (the caller escapes it): where and when it looked,
 *  and how many people it sampled from how many. */
export function noMatchText(m: { where: string | null; n: number; total: number; sampled: number; year: number; want?: PickWant }): string {
  const place = m.where ? `on ${m.where}` : 'on any world', yr = fmtYear(m.year);
  if (m.where && m.n > 0) {   // a numbered person on a named world: an exact lookup, not a sample
    if (!m.total) return `Nobody has ever been born on ${m.where}.`;
    if (m.n > m.total) return `${m.where} has seen ${fmtNum(m.total)} birth${m.total === 1 ? '' : 's'} — pick a number up to that.`;
    return `No match for person #${m.n.toLocaleString('en-US')} ${place} in ${yr} — try another number, or loosen a filter.`;
  }
  if (!m.total) return m.want && !m.want.born ? `Nobody lived ${m.where ? place : 'anywhere'} in ${yr}.`
    : `Nobody${m.want?.born ? ' in that birth range' : ''} had been born ${m.where ? place : 'anywhere'} by ${yr}.`;
  return `No match among ${fmtNum(m.sampled)} ${m.sampled === 1 ? 'person' : 'people'} sampled from ${fmtNum(m.total)} ${place}, in ${yr} — loosen a filter, or press Follow again for a new sample.`;
}

/** The world someone was born on, read from their id ("body.pool.index"); null when born aboard a ship. */
export function birthWorld(pid: string): number | null {
  const b = Number(pid.split('.')[0]);
  return Number.isInteger(b) && b >= 0 && !isShipBody(b) ? b : null;
}

export class LifePick {
  el: HTMLElement;
  private opts: LifePickOpts;
  private bodySel: HTMLSelectElement;
  private nInput: HTMLInputElement;
  private result: HTMLElement;
  private seq = 0;
  private popTimer = 0;
  private bodiesReady: number[] | null = null;

  constructor(opts: LifePickOpts) {
    this.opts = opts;
    this.el = document.createElement('div');
    this.el.className = 'lifepick';
    this.el.hidden = true;
    this.el.innerHTML = `
      <button class="lp-x link" type="button" aria-label="Close">×</button>
      <p class="lp-title">Follow one life</p>
      <p class="lp-sec">who</p>
      <label>Born on <select class="lp-body" aria-label="World they were born on"><option value="-1">anywhere at random</option></select></label>
      <label>Person # <input class="lp-n" inputmode="numeric" placeholder="random" aria-label="Their number among its births"></label>
      ${sel('lp-kind', 'Kind', [['any', 'anyone'], ['random', 'at random'], ['baseline', 'baseline human'], ['adapted', 'adapted to their world'], ['uploaded', 'uploaded']])}
      ${sel('lp-sex', 'Sex', [['', 'anyone'], ['f', 'a woman'], ['m', 'a man']])}
      <p class="lp-sec">their life</p>
      ${range('lp-born', 'Born, year', '2040', 'any')}
      ${range('lp-age', 'Age', '0', 'any')}
      ${range('lp-moves', 'Moves', '0', 'any')}
      ${range('lp-height', 'Height, cm', 'short', 'tall')}
      <p class="lp-sec">their standing</p>
      ${range('lp-wealth', 'Wealth, top %', '0', '100')}
      ${sel('lp-mood', 'Mood', [['', 'any'], ...[...MOODS_GOOD, ...MOODS_BAD].map((m) => [m, m] as [string, string])])}
      ${sel('lp-health', 'Health', [['', 'any'], ...HEALTH_OPTS])}
      ${sel('lp-edu', 'Education', [['', 'any'], ...EDU_OPTS.map((e) => [e, e] as [string, string])])}
      <p class="lp-row"><button class="link lp-go" type="button">Follow their life</button><button class="link lp-rand" type="button">someone at random</button><button class="link lp-clear" type="button">clear</button></p>
      <p class="lp-result muted" aria-live="polite"></p>
      <div class="lp-life" role="list"></div>`;
    this.bodySel = this.el.querySelector('.lp-body')!;
    this.nInput = this.el.querySelector('.lp-n')!;
    this.result = this.el.querySelector('.lp-result')!;
    this.el.querySelector('.lp-x')!.addEventListener('click', () => this.hide());
    this.el.querySelector('.lp-go')!.addEventListener('click', () => this.go(false));
    this.el.querySelector('.lp-rand')!.addEventListener('click', () => { this.clear(); this.go(true); });
    this.el.querySelector('.lp-clear')!.addEventListener('click', () => this.clear());
    this.el.addEventListener('click', (e) => {
      const ev = (e.target as HTMLElement).closest<HTMLElement>('.lp-ev');
      if (ev?.dataset.y) this.opts.seek(Number(ev.dataset.y), ev.dataset.b === undefined ? undefined : Number(ev.dataset.b));
    });
    // typing over a rolled value makes it a real filter again
    for (const ev of ['input', 'change']) this.el.addEventListener(ev, (e) => {
      const c = e.target as HTMLElement;
      if (c.dataset.rolled) { delete c.dataset.rolled; c.classList.remove('lp-rolled'); }
    });
  }

  onToggle: (open: boolean) => void = () => {};

  toggle(): void { this.el.hidden ? this.show() : this.hide(); }
  hide(): void {
    this.bodiesReady = null;
    clearTimeout(this.popTimer);
    this.el.hidden = true;
    this.onToggle(false);
  }
  show(): void {
    this.populate();
    this.el.hidden = false;
    this.onToggle(true);
  }

  private get<T extends HTMLElement>(cls: string): T { return this.el.querySelector<T>(cls)!; }

  private clear(): void {
    this.el.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; });
    this.el.querySelectorAll('input').forEach((i) => { i.value = ''; });
    this.el.querySelectorAll<HTMLElement>('[data-rolled]').forEach((c) => { delete c.dataset.rolled; c.classList.remove('lp-rolled'); });
    this.result.textContent = '';
  }

  /** Refill the birthplace list as settlements appear over time. Only worlds that saw a birth.
   *  While the run is pending it shows just "anywhere at random" and asks again every second. */
  private populate(): void {
    clearTimeout(this.popTimer);
    void this.opts.bodies().then((r) => {
      if (this.el.hidden) return;
      this.bodiesReady = r.pending ? null : r.bodies;
      this.fillBodies(r.pending ? null : r.bodies);
      if (r.pending) this.popTimer = window.setTimeout(() => this.populate(), 1000);
    });
  }

  /** Fill the birthplace select: `bodies` null lists only "anywhere at random" (the run is
   *  still simulating); otherwise Earth first, then by name, keeping a selection that survives. */
  private fillBodies(bodies: number[] | null): void {
    const keep = this.bodySel.value;
    const list = bodies === null ? [] : [...new Set(bodies)]
      .map((id) => ({ id, name: this.opts.nameOf(id) }))
      .sort((a, b) => (a.id === this.opts.home ? -1 : b.id === this.opts.home ? 1 : a.name.localeCompare(b.name)));
    this.bodySel.innerHTML = `<option value="-1">anywhere at random</option>` + list.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    if (keep && [...this.bodySel.options].some((o) => o.value === keep)) this.bodySel.value = keep;
  }

  /** A control's submitted value; rolled values (shown but not chosen) read as blank. */
  private submitted(key: string): string {
    const el = this.get<HTMLInputElement | HTMLSelectElement>(`.lp-${key}`);
    return el.dataset.rolled ? '' : el.value;
  }

  /** The filters the form asks for; undefined fields mean "anyone". */
  private want(): PickWant {
    return buildWant((k) => this.submitted(k));
  }

  private say(html: string, seq: number): void { if (seq === this.seq) this.result.innerHTML = html; }

  private async go(random: boolean): Promise<void> {
    const seq = ++this.seq;
    const b = Number(this.bodySel.value);
    const kind = this.submitted('kind') || 'any';
    const where = b >= 0 ? this.opts.nameOf(b) : null;
    const want = this.want();
    const n = random ? 0 : Math.max(0, Math.floor(parseCount(this.nInput.value) || 0));
    this.el.querySelector<HTMLElement>('.lp-life')!.innerHTML = '';
    this.say('Finding them…', seq);
    if (!this.bodiesReady) {
      const r = await this.opts.bodies();
      if (seq !== this.seq) return;
      if (r.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
      this.bodiesReady = r.bodies;
    }
    if (b >= 0 && !this.bodiesReady.includes(b)) { this.say(`Nobody has ever been born on ${esc(where!)}.`, seq); return; }
    const filtered = Object.values(want).some((v) => v !== undefined);
    const shown = this.opts.year(), year = searchYear(filtered ? want : undefined, shown, RUN_END, Math.random());
    const r = await this.opts.find(b, n, kind, year, filtered ? want : undefined);
    if (seq !== this.seq) return;
    if (r.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
    if (!r.person) { this.say(esc(noMatchText({ where, n, total: r.total, sampled: r.scanned, year, want: filtered ? want : undefined })), seq); return; }
    this.opts.open(r.person);
    if (year !== shown) this.opts.seek(year);   // after open on purpose: open() replaces any follow in progress, so the seek can't steer the camera to the previously followed person
    const p = r.brief, st = r.standing;
    if (p || st) this.showRoll(p ?? undefined, st ?? null);   // blank fields get filled by whoever was found
    const stats = st ? ` ${esc(st.class)}, ${esc(st.mood)}.` : '';
    const moved = year !== shown ? `Moved to ${fmtYear(year)}${p?.alive ? " so they're alive" : ''}. ` : '';
    const bw = birthWorld(r.person), born = where ?? (bw === null ? null : this.opts.nameOf(bw) || null);
    this.say(p ? `${moved}Following <b>${esc(p.name)}</b> — born ${born ? `on ${esc(born)}` : 'aboard ship'} in ${fmtYear(p.born)}${p.born > year ? ', not yet born.' : p.alive ? `; ${Math.floor(p.age)}, ${esc(p.job)}${p.place && p.place !== born ? ` on ${esc(p.place)}` : ''}.${stats}` : ', now gone.'}` : `${moved}Following them.`, seq);
    // the whole life laid out — including everything after the year being shown;
    // click a beat to be taken to it
    if (r.life?.length) {
      this.el.querySelector<HTMLElement>('.lp-life')!.innerHTML =
        `<p class="lp-sec">their life, in full</p>` +
        r.life.map((ev) => `<div class="lp-ev" role="listitem" data-y="${Math.round(ev.year)}"${ev.body != null ? ` data-b="${ev.body}"` : ''}><span class="y num">${fmtYear(ev.year)}</span><span>${esc(ev.text)}</span></div>`).join('');
    }
  }

  /** Writes the found person's traits into any control the user left blank — blank
   *  means "rolled", so the dice's answer is shown, never a default value. */
  private showRoll(p: PersonBrief | undefined, st: Biography['standing']): void {
    const mark = (el: HTMLElement) => { el.dataset.rolled = '1'; el.classList.add('lp-rolled'); };
    const set = (cls: string, v: string | number) => { const el = this.get<HTMLInputElement>(cls); if (!el.value) { el.value = String(v); mark(el); } };
    const setSel = (cls: string, v: string) => { const el = this.get<HTMLSelectElement>(cls); if (el.selectedIndex <= 0 && [...el.options].some((o) => o.value === v)) { el.value = v; mark(el); } };
    const pbody = { 'baseline human': 'baseline', 'adapted to this world': 'adapted', uploaded: 'uploaded' }[p?.body ?? ''] as string | undefined;
    if (pbody) setSel('.lp-kind', pbody);
    if (p?.sex) setSel('.lp-sex', p.sex);
    if (st) {
      if (st.mood && [...MOODS_GOOD, ...MOODS_BAD].includes(st.mood)) setSel('.lp-mood', st.mood);
      const hcat = st.health.includes('scarred') ? 'scarred' : st.health.startsWith('a mind') ? 'uploaded' : st.health.startsWith('engineered') ? 'engineered' : st.health === 'a chronic condition' ? 'chronic' : st.health;
      setSel('.lp-health', hcat);
      setSel('.lp-edu', st.education);
      set('.lp-wealth-lo', Math.round(100 - st.wealthPct * 100));
      set('.lp-wealth-hi', Math.round(100 - st.wealthPct * 100));
      set('.lp-moves-lo', st.moves);
      set('.lp-moves-hi', st.moves);
    }
    if (p) {
      set('.lp-age-lo', Math.floor(p.age));
      set('.lp-age-hi', Math.floor(p.age));
      set('.lp-born-lo', Math.floor(2040 + p.born));
      set('.lp-born-hi', Math.floor(2040 + p.born));
    }
  }
}
