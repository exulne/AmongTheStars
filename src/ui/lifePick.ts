// Pick one person out of this future and follow their whole life. Filters:
// the world they were born on (or anywhere that saw a birth), their number
// among its births (or a random draw), their kind of human, and any of the
// derived standing stats — wealth percentile, age, height, mood, health,
// education, devotion. Choosing them opens their biography.

import type { Biography, PersonBrief, PickWant } from '../sim/lives.ts';
import { MOODS_BAD, MOODS_GOOD } from '../sim/lives.ts';
import { fmtNum, fmtYear, parseCount } from './format.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FindResult {
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
  /** open the chosen person's biography */
  open: (pid: string) => void;
}

const HEALTH_OPTS: [string, string][] = [
  ['healthy', 'healthy'], ['scarred', 'scarred by an event'], ['frail', 'frail'],
  ['chronic', 'a chronic condition'], ['uploaded', 'a mind on a substrate'], ['engineered', 'engineered for their world'],
];
const EDU_OPTS = ['the universities', 'the technical colleges', 'service training', 'apprenticed into administration', 'learned the work', 'in school'];
const DEVOTION_OPTS = ['devout', 'observant', 'nominal', 'lapsed', 'none'];

const sel = (cls: string, label: string, opts: [string, string][]) =>
  `<label>${label} <select class="${cls}" aria-label="${label}">${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const range = (cls: string, label: string, lo: string, hi: string) =>
  `<label>${label} <span class="lp-range"><input class="${cls}-lo" inputmode="numeric" placeholder="${lo}" aria-label="${label} from"><span>–</span><input class="${cls}-hi" inputmode="numeric" placeholder="${hi}" aria-label="${label} to"></span></label>`;

export class LifePick {
  el: HTMLElement;
  private opts: LifePickOpts;
  private bodySel: HTMLSelectElement;
  private nInput: HTMLInputElement;
  private result: HTMLElement;
  private seq = 0;
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
      ${sel('lp-faith', 'Faith', [['', 'any'], ...DEVOTION_OPTS.map((d) => [d, d] as [string, string])])}
      <p class="lp-row"><button class="link lp-go" type="button">Follow their life</button><button class="link lp-rand" type="button">someone at random</button><button class="link lp-clear" type="button">clear</button></p>
      <p class="lp-result muted" aria-live="polite"></p>`;
    this.bodySel = this.el.querySelector('.lp-body')!;
    this.nInput = this.el.querySelector('.lp-n')!;
    this.result = this.el.querySelector('.lp-result')!;
    this.el.querySelector('.lp-x')!.addEventListener('click', () => this.hide());
    this.el.querySelector('.lp-go')!.addEventListener('click', () => this.go(false));
    this.el.querySelector('.lp-rand')!.addEventListener('click', () => { this.clear(); this.go(true); });
    this.el.querySelector('.lp-clear')!.addEventListener('click', () => this.clear());
  }

  onToggle: (open: boolean) => void = () => {};

  toggle(): void { this.el.hidden ? this.show() : this.hide(); }
  hide(): void { this.el.hidden = true; this.onToggle(false); }
  show(): void {
    this.populate();
    this.el.hidden = false;
    this.onToggle(true);
  }

  private get<T extends HTMLElement>(cls: string): T { return this.el.querySelector<T>(cls)!; }
  private val(cls: string): string { return this.get<HTMLSelectElement>(cls).value; }

  private clear(): void {
    this.el.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; });
    this.el.querySelectorAll('input').forEach((i) => { i.value = ''; });
    this.result.textContent = '';
  }

  /** Refill the birthplace list as settlements appear over time. Only worlds that saw a birth. */
  private populate(): void {
    const keep = this.bodySel.value;
    void this.opts.bodies().then((r) => {
      if (r.pending || this.el.hidden) return;
      this.bodiesReady = r.bodies;
      const bodies = [...new Set(r.bodies)]
        .map((id) => ({ id, name: this.opts.nameOf(id) }))
        .sort((a, b) => (a.id === this.opts.home ? -1 : b.id === this.opts.home ? 1 : a.name.localeCompare(b.name)));
      this.bodySel.innerHTML = `<option value="-1">anywhere at random</option>` + bodies.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
      if (keep && [...this.bodySel.options].some((o) => o.value === keep)) this.bodySel.value = keep;
    });
  }

  /** The filters the form asks for; undefined fields mean "anyone". */
  private want(): PickWant {
    const num = (cls: string) => { const v = parseCount(this.get<HTMLInputElement>(cls).value); return Number.isFinite(v) ? v : undefined; };
    /** a year the user typed: calendar years (>2040) convert to sim years, small numbers are sim years */
    const yr = (v: number | undefined) => (v === undefined ? undefined : v > 2040 ? v - 2040 : v);
    const loW = num('.lp-wealth-lo'), hiW = num('.lp-wealth-hi');
    const loA = num('.lp-age-lo'), hiA = num('.lp-age-hi');
    const loH = num('.lp-height-lo'), hiH = num('.lp-height-hi');
    const loM = num('.lp-moves-lo'), hiM = num('.lp-moves-hi');
    const loB = yr(num('.lp-born-lo')), hiB = yr(num('.lp-born-hi'));
    const w: PickWant = {};
    if (loW !== undefined || hiW !== undefined) w.wealth = [Math.max(0, Math.min(100, 100 - (hiW ?? 100))), Math.max(0, Math.min(100, 100 - (loW ?? 0)))];
    if (loA !== undefined || hiA !== undefined) w.age = [loA ?? 0, hiA ?? 1e6];
    if (loH !== undefined || hiH !== undefined) w.height = [loH ?? 0, hiH ?? 1e6];
    if (loM !== undefined || hiM !== undefined) w.moves = [loM ?? 0, hiM ?? 1e6];
    if (loB !== undefined || hiB !== undefined) w.born = [loB ?? -1e6, hiB ?? 1e6];
    if (this.val('.lp-sex')) w.sex = this.val('.lp-sex') as 'f' | 'm';
    if (this.val('.lp-mood')) w.mood = this.val('.lp-mood');
    if (this.val('.lp-health')) w.health = this.val('.lp-health');
    if (this.val('.lp-edu')) w.education = this.val('.lp-edu');
    if (this.val('.lp-faith')) w.devotion = this.val('.lp-faith');
    return w;
  }

  private say(html: string, seq: number): void { if (seq === this.seq) this.result.innerHTML = html; }

  private async go(random: boolean): Promise<void> {
    const seq = ++this.seq;
    const b = Number(this.bodySel.value);
    // 'anyone' means the user didn't choose — roll a kind per draw rather than fixing one
    const kind = this.val('.lp-kind') === 'any' ? 'random' : this.val('.lp-kind');
    const where = b >= 0 ? this.opts.nameOf(b) : null;
    const want = this.want();
    const n = random ? 0 : Math.max(0, Math.floor(parseCount(this.nInput.value) || 0));
    this.say('Finding them…', seq);
    if (!this.bodiesReady) {
      const r = await this.opts.bodies();
      if (seq !== this.seq) return;
      if (r.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
      this.bodiesReady = r.bodies;
    }
    if (b >= 0 && !this.bodiesReady.includes(b)) { this.say(`Nobody has ever been born on ${esc(where!)}.`, seq); return; }
    const filtered = Object.values(want).some((v) => v !== undefined);
    const r = await this.opts.find(b, n, kind, this.opts.year(), filtered ? want : undefined);
    if (seq !== this.seq) return;
    if (r.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
    if (!r.person) {
      this.say(b < 0 ? `Nobody anywhere matches that${filtered ? ' — loosen a filter or two.' : '.'}`
        : !r.total ? `Nobody has ever been born on ${esc(where!)}.`
        : kind === 'random' && n === 0 && !filtered ? `${esc(where!)} has seen ${fmtNum(r.total)} birth${r.total === 1 ? '' : 's'} — pick a number up to that.`
        : `No match on ${esc(where!)} among ${fmtNum(Math.max(r.scanned, n))} scanned${filtered ? ' — loosen a filter or two' : ''}.`, seq);
      return;
    }
    this.opts.open(r.person);
    const p = r.brief, st = r.standing;
    if (p || st) this.showRoll(p ?? undefined, st ?? null);   // blank fields get filled by whoever was found
    const stats = st ? ` ${esc(st.class)}${st.devotion ? `, ${st.devotion}` : ''}, ${esc(st.mood)}.` : '';
    this.say(p ? `Following <b>${esc(p.name)}</b> — born on ${esc(where ?? p.place)} in ${fmtYear(p.born)}${p.born > this.opts.year() ? ', not yet born.' : p.alive ? `; ${Math.floor(p.age)}, ${esc(p.job)}${p.place && p.place !== where ? ` on ${esc(p.place)}` : ''}.${stats}` : ', now gone.'}` : 'Following them.', seq);
  }

  /** Writes the found person's traits into any control the user left blank — blank
   *  means "rolled", so the dice's answer is shown, never a default value. */
  private showRoll(p: PersonBrief | undefined, st: Biography['standing']): void {
    const set = (cls: string, v: string | number) => { const el = this.get<HTMLInputElement | HTMLSelectElement>(cls); if (!el.value) el.value = String(v); };
    const setSel = (cls: string, v: string) => { const el = this.get<HTMLSelectElement>(cls); if (el.selectedIndex <= 0 && [...el.options].some((o) => o.value === v)) el.value = v; };
    const pbody = { 'baseline human': 'baseline', 'adapted to this world': 'adapted', uploaded: 'uploaded' }[p?.body ?? ''] as string | undefined;
    if (pbody) setSel('.lp-kind', pbody);
    if (p?.sex) setSel('.lp-sex', p.sex);
    if (st) {
      if (st.mood && [...MOODS_GOOD, ...MOODS_BAD].includes(st.mood)) setSel('.lp-mood', st.mood);
      const hcat = st.health.includes('scarred') ? 'scarred' : st.health.startsWith('a mind') ? 'uploaded' : st.health.startsWith('engineered') ? 'engineered' : st.health === 'a chronic condition' ? 'chronic' : st.health;
      setSel('.lp-health', hcat);
      setSel('.lp-edu', st.education);
      setSel('.lp-faith', st.devotion ?? 'none');
      set('.lp-wealth-lo', Math.round(100 - st.wealthPct * 100));
      set('.lp-wealth-hi', Math.round(100 - st.wealthPct * 100));
      set('.lp-moves-lo', st.moves);
      set('.lp-moves-hi', st.moves);
    }
    if (p) {
      set('.lp-age-lo', Math.floor(p.age));
      set('.lp-age-hi', Math.floor(p.age));
      set('.lp-born-lo', 2040 + p.born);
      set('.lp-born-hi', 2040 + p.born);
    }
  }
}
