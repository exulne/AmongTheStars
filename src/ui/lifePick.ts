// Pick one person out of this future and follow their whole life. Filters:
// the world they were born on, their number among its births, and their kind
// of human. Choosing them opens their biography — the catalog of what exists.

import type { PersonBrief } from '../sim/lives.ts';
import { fmtNum, fmtYear, parseCount } from './format.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FindResult { person: string | null; brief: PersonBrief | null; total: number; scanned: number; pending?: boolean }
export interface LifePickOpts {
  /** bodies anyone was ever born on, for the birthplace list */
  bodies: () => number[];
  nameOf: (b: number) => string;
  year: () => number;
  find: (body: number, n: number, kind: string, year: number) => Promise<FindResult>;
  /** open the chosen person's biography */
  open: (pid: string) => void;
}

const KIND_WORD: Record<string, string> = { baseline: 'baseline human', adapted: 'adapted to their world', uploaded: 'uploaded' };

export class LifePick {
  el: HTMLElement;
  private opts: LifePickOpts;
  private bodySel: HTMLSelectElement;
  private nInput: HTMLInputElement;
  private kindSel: HTMLSelectElement;
  private result: HTMLElement;
  private seq = 0;

  constructor(opts: LifePickOpts) {
    this.opts = opts;
    this.el = document.createElement('div');
    this.el.className = 'lifepick';
    this.el.hidden = true;
    this.el.innerHTML = `
      <button class="lp-x link" type="button" aria-label="Close">×</button>
      <p class="lp-title">Follow one life</p>
      <label>Born on <select class="lp-body" aria-label="World they were born on"></select></label>
      <label>Person # <input class="lp-n" inputmode="numeric" placeholder="1" aria-label="Their number among its births"></label>
      <label>Kind <select class="lp-kind" aria-label="Kind of human">
        <option value="any">anyone</option>
        <option value="baseline">baseline human</option>
        <option value="adapted">adapted to their world</option>
        <option value="uploaded">uploaded</option>
      </select></label>
      <p class="lp-row"><button class="link lp-go" type="button">Follow their life</button><button class="link lp-rand" type="button">someone at random</button></p>
      <p class="lp-result muted" aria-live="polite"></p>`;
    this.bodySel = this.el.querySelector('.lp-body')!;
    this.nInput = this.el.querySelector('.lp-n')!;
    this.kindSel = this.el.querySelector('.lp-kind')!;
    this.result = this.el.querySelector('.lp-result')!;
    this.el.querySelector('.lp-x')!.addEventListener('click', () => this.hide());
    this.el.querySelector('.lp-go')!.addEventListener('click', () => this.go(false));
    this.el.querySelector('.lp-rand')!.addEventListener('click', () => this.go(true));
  }

  onToggle: (open: boolean) => void = () => {};

  toggle(): void { this.el.hidden ? this.show() : this.hide(); }
  hide(): void { this.el.hidden = true; this.onToggle(false); }
  show(): void {
    this.populate();
    this.el.hidden = false;
    this.onToggle(true);
  }

  /** Refill the birthplace list as settlements appear over time. */
  private populate(): void {
    const keep = this.bodySel.value;
    const bodies = [...new Set(this.opts.bodies())]
      .map((id) => ({ id, name: this.opts.nameOf(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.bodySel.innerHTML = bodies.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    if (keep && bodies.some((b) => String(b.id) === keep)) this.bodySel.value = keep;
  }

  private say(html: string, seq: number): void { if (seq === this.seq) this.result.innerHTML = html; }

  private async go(random: boolean): Promise<void> {
    const seq = ++this.seq;
    const b = Number(this.bodySel.value), kind = this.kindSel.value, where = this.opts.nameOf(b);
    if (this.bodySel.value === '') { this.say('Pick a world first.', seq); return; }
    let n = Math.max(1, Math.floor(parseCount(this.nInput.value) || 1));
    this.say('Finding them…', seq);
    if (random) {
      const first = await this.opts.find(b, 1, 'any', this.opts.year());
      if (seq !== this.seq) return;
      if (first.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
      if (!first.total) { this.say(`Nobody has ever been born on ${esc(where)}.`, seq); return; }
      n = 1 + Math.floor(Math.random() * Math.min(first.total, kind === 'any' ? first.total : 40));
    }
    const r = await this.opts.find(b, n, kind, this.opts.year());
    if (seq !== this.seq) return;
    if (r.pending) { this.say('This future is still simulating; its people appear when it finishes.', seq); return; }
    if (!r.person) {
      this.say(!r.total ? `Nobody has ever been born on ${esc(where)}.`
        : kind === 'any' ? `${esc(where)} has seen ${fmtNum(r.total)} birth${r.total === 1 ? '' : 's'} — pick a number up to that.`
        : `No ${KIND_WORD[kind] ?? kind} among the first ${fmtNum(Math.max(r.scanned, n))} of ${fmtNum(r.total)} births on ${esc(where)}.`, seq);
      return;
    }
    this.opts.open(r.person);
    const p = r.brief;
    this.say(p ? `Following <b>${esc(p.name)}</b> — born on ${esc(where)} in ${fmtYear(p.born)}${p.born > this.opts.year() ? ', not yet born.' : p.alive ? `; ${Math.floor(p.age)}, ${esc(p.job)}${p.place && p.place !== where ? ` on ${esc(p.place)}` : ''}.` : ', now gone.'}` : 'Following them.', seq);
  }
}
