// The "What leads to…?" panel: ask for a moment in the timeline and watch the
// futures that reach it stream in as cards — the road each took, a sparkline of
// its population, and buttons to watch, hear or enter that future.

import './paths.css';
import { Pathfinder } from './pathfinder.ts';
import { chainFrom, chainLabel, compareFutures, countLine, huntLine, isExtension, lineageSeeds, narrowPlan, parseEvent, searchLimit, shownFutures, tagLabel, type Chain, type FutureResult, type Goal, type Joint, type Step } from '../sim/milestones.ts';
import type { World } from '../sim/world.ts';
import type { Voice } from '../ship/voice.ts';
import type { OracleAgent } from '../ship/agent.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const CHIPS = ['Colonisation of Mars', 'Terraforming Venus', 'First Dyson swarm', 'Mind uploading', 'First contact', 'A trillion people'];

export interface PathsOpts {
  world: World;
  /** the future currently on screen: searches start from it */
  seed: () => number;
  voice: Voice;
  /** hook ElevenLabs up once per page, on first open */
  connect: () => void;
  /** fly the screen into a future: calendar year, optional body/system focus, play through it */
  show: (seed: number, calYear: number, opts?: { body?: number; system?: number; play?: boolean }) => void;
}

export type AskResult = { chain: Chain; results: FutureResult[]; tried: number; narrowed?: { x: number; y: number }; hunt?: { found: number; simulated: number; capped: boolean } } | { error: string; suggestions: string[] };

export class FuturePaths {
  el: HTMLElement;
  private opts: PathsOpts;
  private pathfinder = new Pathfinder();
  private input: HTMLInputElement;
  private statusEl: HTMLElement;
  private footerEl: HTMLElement;
  private cardsEl: HTMLElement;
  private transcriptEl: HTMLElement;
  private modeEl: HTMLElement;
  private micBtn: HTMLButtonElement;
  private oracleBtn: HTMLButtonElement;
  private auxEl: HTMLElement;
  private agent: OracleAgent | null = null;
  private chain: Chain | null = null;
  private tags: { goal: Goal; typed: string; notes?: string[] }[] = [];
  private joints: Joint[] = [];
  private tagsEl: HTMLElement;
  /** the last searched row (goal ids + joints) — E5's extension check reads it */
  lastRun: { ids: string[]; joints: Joint[] } | null = null;
  private results: FutureResult[] = [];
  private seq = 0;
  private tried = 0;
  private showAll = false;
  private newFind: number | null = null;   // seed of the most recently found future this search
  private lineage = { first: 1, k: 0, used: new Set<number>() };
  private pool = new Map<number, FutureResult>();
  private checking = new Set<number>();    // extension: seeds being re-played against the longer chain
  private newSeeds = new Set<number>();    // extension hunt: seeds found in the hunt
  private huntEl: HTMLElement;
  private futuresEl: HTMLInputElement;
  onToggle: (open: boolean) => void = () => {};

  constructor(opts: PathsOpts) {
    this.opts = opts;
    this.el = document.createElement('div');
    this.el.className = 'paths';
    this.el.hidden = true;
    this.el.innerHTML = `
      <button class="pf-x link" type="button" aria-label="Close">×</button>
      <p class="pf-title">What leads to…?</p>
      <form class="pf-ask">
        <div class="pf-tags" aria-label="Events, read left to right"><input type="text" autocomplete="off" placeholder="A moment in time: colonisation of Mars…" aria-label="Name a moment in the timeline"></div>
        <button class="link pf-go" type="button">Ask</button>
        <button class="link pf-mic" type="button" aria-label="Ask out loud">Speak</button>
        <label class="pf-n">Futures to find <input type="number" min="1" max="100" step="1" aria-label="Futures to find"></label>
      </form>
      <div class="pf-chips">${CHIPS.map((c) => `<button class="link" type="button">${esc(c)}</button>`).join('')}</div>
      <p class="pf-aux" hidden>
        <button class="link pf-oracle" type="button" hidden>Talk to the Oracle</button>
      </p>
      <div class="pf-mode" role="status" hidden></div>
      <div class="pf-transcript" hidden></div>
      <p class="pf-status" aria-live="polite"></p>
      <p class="pf-hunt muted" aria-live="polite"></p>
      <div class="pf-cards"></div>
      <p class="pf-footer muted"></p>`;
    this.input = this.el.querySelector('.pf-tags input')!;
    this.tagsEl = this.el.querySelector('.pf-tags')!;
    this.statusEl = this.el.querySelector('.pf-status')!;
    this.footerEl = this.el.querySelector('.pf-footer')!;
    this.cardsEl = this.el.querySelector('.pf-cards')!;
    this.transcriptEl = this.el.querySelector('.pf-transcript')!;
    this.modeEl = this.el.querySelector('.pf-mode')!;
    this.micBtn = this.el.querySelector('.pf-mic')!;
    this.oracleBtn = this.el.querySelector('.pf-oracle')!;
    this.auxEl = this.el.querySelector('.pf-aux')!;
    this.futuresEl = this.el.querySelector('.pf-n input')!;
    this.huntEl = this.el.querySelector('.pf-hunt')!;
    this.futuresEl.value = String(this.futures());
    this.futuresEl.addEventListener('change', () => this.readFutures());

    // Enter adds the box's text as a tag (or runs the row when the box is empty); Ask does both
    this.el.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); if (this.input.value.trim()) this.addTag(this.input.value); else void this.run(); });
    this.el.querySelector('.pf-go')!.addEventListener('click', () => { if (this.input.value.trim() && !this.addTag(this.input.value)) return; void this.run(); });
    this.el.querySelectorAll<HTMLButtonElement>('.pf-chips button').forEach((b) => b.addEventListener('click', () => this.addTag(b.textContent!)));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !this.input.value && this.tags.length) { e.preventDefault(); this.removeTag(this.tags.length - 1); }
    });
    this.el.querySelector('.pf-x')!.addEventListener('click', () => this.hide());
    this.micBtn.addEventListener('click', () => void this.listen());
    this.oracleBtn.addEventListener('click', () => this.toggleOracle());
    // typed keys inside the panel are its own, not the sim's shortcuts
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.opts.voice.onStatus = (s) => this.status(s);
  }

  /** The conversational agent becomes available once an agent id is configured. */
  setAgent(agent: OracleAgent | null): void {
    this.agent = agent;
    this.oracleBtn.hidden = !agent?.available;
    this.auxEl.hidden = !agent?.available;
  }

  /** A transcript line from the Oracle session ("you"/"agent"). */
  transcript(who: 'you' | 'agent', text: string): void {
    this.transcriptEl.hidden = false;
    const p = document.createElement('p');
    p.className = who;
    p.textContent = text;
    this.transcriptEl.append(p);
    while (this.transcriptEl.childElementCount > 40) this.transcriptEl.firstElementChild!.remove();
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  /** The agent's mode, shown above the cards while it runs. */
  agentMode(mode: string): void {
    this.modeEl.hidden = !mode;
    this.modeEl.textContent = mode;
  }

  status(text: string): void { this.statusEl.textContent = text; }

  /** How many futures a hunt plays, kept across visits. */
  private futures(): number {
    try {
      const n = Number(localStorage.getItem('paths.futures'));
      return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.max(1, Math.round(n))) : 16;
    } catch { return 16; }
  }

  /** The field's current value, clamped 1–100; an empty/garbled field reverts to the last good one. */
  private readFutures(): number {
    const n = Number(this.futuresEl.value);
    const v = Number.isFinite(n) && this.futuresEl.value.trim() !== '' ? Math.min(100, Math.max(1, Math.round(n))) : this.futures();
    this.futuresEl.value = String(v);
    try { localStorage.setItem('paths.futures', String(v)); } catch { /* private mode */ }
    return v;
  }

  toggle(): void { this.el.hidden ? this.open() : this.hide(); }
  hide(): void { this.el.hidden = true; this.onToggle(false); }
  open(): void {
    this.opts.connect();
    this.el.hidden = false;
    this.onToggle(true);
    this.input.focus();
  }

  /** The mic: ElevenLabs Scribe when connected, browser speech otherwise. */
  private async listen(): Promise<void> {
    const v = this.opts.voice;
    if (v.listening) { v.stopListening(); return; }
    this.micBtn.classList.add('on');
    try {
      const text = await v.listen(() => {});
      if (text && this.addTag(text)) void this.run();
      else this.status('Didn\'t hear anything.');
    } catch (e) { this.status((e as Error).message); }
    finally { this.micBtn.classList.remove('on'); }
  }

  /** Parse the box text as one event; on success append it, clear the box and any message. */
  private addTag(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    const pr = parseEvent(t, this.opts.world);
    if ('error' in pr) {
      this.status(pr.error);
      this.footerEl.innerHTML = pr.suggestions.length ? `Try: ${pr.suggestions.map((s) => `<button class="link pf-sug" type="button">${esc(s)}</button>`).join(' ')}` : '';
      this.footerEl.querySelectorAll<HTMLButtonElement>('.pf-sug').forEach((b) => b.addEventListener('click', () => { this.input.value = b.textContent!; this.addTag(b.textContent!); }));
      return false;
    }
    if (this.tags.length) this.joints.push('then');
    this.tags.push({ goal: pr.goal, typed: t, notes: pr.notes });
    this.input.value = '';
    this.status('');
    this.footerEl.textContent = '';
    this.renderTags();
    return true;
  }

  /** × (or Backspace) removes a tag and the joint on its left (on its right for the first). */
  private removeTag(i: number): void {
    this.tags.splice(i, 1);
    this.joints.splice(i > 0 ? i - 1 : 0, 1);
    this.renderTags();
    this.input.focus();
  }

  /** Rebuild the tag row: pills and toggleable joints, left to right. */
  private renderTags(): void {
    this.tagsEl.querySelectorAll('.pf-tag, .pf-joint').forEach((el) => el.remove());
    this.tags.forEach((tag, i) => {
      if (i > 0) {
        const j = document.createElement('button');
        j.type = 'button';
        j.className = 'pf-joint';
        const and = this.joints[i - 1] === 'and';
        j.textContent = and ? '&' : '→';
        j.setAttribute('aria-label', and ? 'and (any order) — click for then' : 'then — click for and');
        j.addEventListener('click', () => { this.joints[i - 1] = and ? 'then' : 'and'; this.renderTags(); });
        this.tagsEl.insertBefore(j, this.input);
      }
      const span = document.createElement('span');
      span.className = 'pf-tag';
      const label = tagLabel(tag.goal);
      span.title = [tag.goal.detail, `Typed: "${tag.typed}"`, ...(tag.notes ?? [])].join('\n');
      span.innerHTML = `${esc(label)} <button type="button" class="pf-tag-x" aria-label="Remove ${esc(label)}">×</button>`;
      span.querySelector('button')!.addEventListener('click', () => this.removeTag(i));
      this.tagsEl.insertBefore(span, this.input);
    });
  }

  /**
   * Ask "what leads to X" through the console/Oracle: replaces the row with that
   * one event and runs it. The typed row runs through run().
   */
  ask(text: string): Promise<AskResult> {
    const pr = parseEvent(text, this.opts.world);
    if ('error' in pr) {
      this.chain = null;
      this.status(pr.error);
      this.footerEl.innerHTML = `Try: ${pr.suggestions.map((s) => `<button class="link pf-sug" type="button">${esc(s)}</button>`).join(' ')}`;
      this.cardsEl.innerHTML = '';
      this.footerEl.querySelectorAll<HTMLButtonElement>('.pf-sug').forEach((b) => b.addEventListener('click', () => { this.input.value = b.textContent!; this.addTag(b.textContent!); }));
      return Promise.resolve(pr);
    }
    this.tags = [{ goal: pr.goal, typed: text.trim(), notes: pr.notes }];
    this.joints = [];
    this.input.value = '';
    this.renderTags();
    return this.run();
  }

  /** The next seed in this lineage — never a seed already used (so never a pool seed). */
  private nextSeed(): number {
    const b = lineageSeeds(this.lineage.first, this.lineage.k, 1, this.lineage.used);
    this.lineage.k = b.nextK;
    this.lineage.used.add(b.seeds[0]);
    return b.seeds[0];
  }

  /** Run the whole tag row as one chain, left to right — a fresh hunt, or an extension of the last row. */
  run(): Promise<AskResult> {
    if (!this.tags.length) { this.status('Type an event and press Enter.'); return Promise.resolve({ error: 'Type an event and press Enter.', suggestions: [] }); }
    const seq = ++this.seq;
    const chain = this.chain = chainFrom(this.tags.map((t) => t.goal), [...this.joints]);
    const row = { ids: this.tags.map((t) => t.goal.id), joints: [...this.joints] };
    const ext = isExtension(this.lastRun, row) && this.pool.size > 0;
    this.lastRun = row;
    const label = chainLabel(chain);
    this.results = [];
    this.tried = 0;
    this.newFind = null;
    this.checking.clear();
    this.newSeeds.clear();
    // a live Oracle conversation keeps its transcript; only cold asks clear it
    if (!this.agent?.active) { this.transcriptEl.hidden = true; this.transcriptEl.innerHTML = ''; }
    this.showAll = false;
    this.cardsEl.innerHTML = '';
    this.footerEl.textContent = '';
    this.huntEl.textContent = '';
    if (ext) return this.extend(chain, label, seq);

    // a fresh hunt: new lineage, new pool, until `want` are found or the limit
    this.pool.clear();
    this.lineage = { first: this.opts.seed(), k: 0, used: new Set() };
    const want = this.readFutures(), limit = searchLimit(want);
    this.status(`Searching: ${label}… (until ${want} are found, at most ${limit} futures)`);
    return new Promise((resolve) => {
      this.pathfinder.run(chain, () => this.nextSeed(), want, limit, (r) => {
        if (seq !== this.seq) return;
        this.pool.set(r.seed, r);
        this.results.push(r);
        this.tried++;
        if (r.reached) this.newFind = r.seed;
        const got = this.results.filter((x) => x.reached).length;
        this.status(countLine(got, this.tried, label, { live: true }));
        this.render();
      }, (results, t) => {
        if (seq !== this.seq) return resolve({ chain, results: [], tried: results.length });
        this.results = results;
        this.tried = t.simulated;
        this.newFind = null;
        const near = results.filter((r) => !r.reached).map((r) => r.progress).filter(Boolean)[0];
        this.status(countLine(t.found, t.simulated, label, { near }) + (t.capped ? ` Stopped at the limit of ${limit} futures.` : ''));
        this.render(true);
        resolve({ chain, results, tried: this.tried });
      });
    });
  }

  /** An extension: narrow the pool to the futures that reached the old chain, re-check
   *  them against the longer one, then hunt the lineage for new futures. */
  private extend(chain: Chain, label: string, seq: number): Promise<AskResult> {
    return new Promise((resolve) => {
      const plan = narrowPlan([...this.pool.values()]);
      const y = this.pool.size;
      let x = 0;
      const near = [...this.pool.values()].filter((r) => !r.reached).map((r) => r.progress).filter(Boolean)[0];
      for (const s of plan.check) this.checking.add(s);
      this.results = [...this.pool.values()];
      this.status(countLine(0, y, label, { live: true, near }));
      this.render();
      let ci = 0;
      this.pathfinder.run(chain, () => plan.check[ci++], Infinity, plan.check.length, (r) => {
        if (seq !== this.seq) return;
        this.checking.delete(r.seed);
        this.pool.set(r.seed, r);
        this.results = [...this.pool.values()];
        if (r.reached) x++;
        this.status(countLine(x, y, label, { live: this.checking.size > 0, near }));
        this.render();
      }, (checkResults) => {
        if (seq !== this.seq) return resolve({ chain, results: [], tried: checkResults.length });
        // every check resolved — hunt the lineage for new futures
        const want = this.readFutures(), limit = searchLimit(want);
        this.status(countLine(x, y, label, { near }));
        let z = 0, m = 0;
        this.huntEl.textContent = huntLine(0, 0, { live: true });
        this.pathfinder.run(chain, () => this.nextSeed(), want, limit, (r) => {
          if (seq !== this.seq) return;
          m++;
          this.pool.set(r.seed, r);
          this.results = [...this.pool.values()];
          if (r.reached) { z++; this.newSeeds.add(r.seed); this.newFind = r.seed; }
          this.huntEl.textContent = huntLine(z, m, { live: true });
          this.render();
        }, (huntResults, t) => {
          if (seq !== this.seq) return resolve({ chain, results: [], tried: huntResults.length });
          this.newFind = null;
          this.huntEl.textContent = huntLine(t.found, t.simulated) + (t.capped ? ` Stopped at the limit of ${limit} futures.` : '');
          this.render(true);
          resolve({ chain, results: [...this.pool.values()], tried: this.pool.size, narrowed: { x, y }, hunt: t });
        });
      });
    });
  }

  /** The chain's last goal — whose body/system a full-chain Watch or Enter focuses. */
  private lastGoal(): { body?: number; system?: number } {
    return this.chain?.stages[this.chain.stages.length - 1][0] ?? {};
  }

  /** Fly the screen into a future: goal year, or a clicked step's year. */
  watch(seed: number, year?: number): void {
    const r = this.results.find((x) => x.seed === seed && x.reached);
    const g = this.lastGoal();
    if (!r || !this.chain) { this.opts.show(seed, year ?? 2040, {}); return; }
    this.opts.show(seed, year ?? r.year!, { body: g.body !== undefined && g.body >= 0 ? g.body : r.steps[r.steps.length - 1]?.body, system: g.system, play: year === undefined });
  }

  private seekStep(r: FutureResult, s: Step): void {
    this.opts.show(r.seed, s.year, { body: s.body, system: this.lastGoal().system });
  }

  private render(final = false): void {
    const c = this.chain;
    if (!c) return;
    const g = this.lastGoal();
    const got = this.results.filter((r) => r.reached).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
    const { medianYear, highlights, standouts } = compareFutures(c, this.results);
    const medianCard = got.find((r) => r.year === medianYear);
    const shown = this.showAll ? got : shownFutures(got, medianYear, standouts);
    if (!this.showAll && !final && this.newFind !== null) {
      const nf = got.find((r) => r.seed === this.newFind);
      if (nf && !shown.includes(nf)) { shown.push(nf); shown.sort((a, b) => (a.year ?? 0) - (b.year ?? 0)); }
    }
    this.cardsEl.innerHTML = '';
    for (const r of shown) {
      const card = document.createElement('div');
      card.className = `pf-card${this.checking.has(r.seed) ? ' pf-is-checking' : ''}`;
      const delta = got.length < 2 || r.year === undefined ? ''
        : r === got[0] ? 'the earliest'
        : r === got[got.length - 1] ? 'the latest'
        : r === medianCard ? 'the middle future'
        : `${Math.abs(r.year - medianYear)} years ${r.year < medianYear ? 'before' : 'after'} the median`;
      const hl = highlights.get(r.seed);
      const parts = r.parts.length > 1 ? r.parts.filter((p) => p.year !== undefined) : [];
      card.innerHTML = `
        <div class="pf-card-head"><b>Future #${r.seed} — ${r.year}</b>${this.checking.has(r.seed) ? '<span class="pf-checking">checking…</span>' : ''}${this.newSeeds.has(r.seed) ? '<span class="pf-card-new">new</span>' : ''}${r.seed === this.newFind && !final ? '<span class="pf-new-find">just found</span>' : ''}<span class="pf-delta">${esc(delta)}</span></div>
        ${hl ? `<p class="pf-hl">${esc(hl)}</p>` : ''}
        ${parts.length ? `<div class="pf-parts">${parts.map((p, i) => `<div class="pf-part" role="button" tabindex="0" data-i="${i}"><span class="y num">${p.year}</span><span>${esc(p.label)}${p.already ? ' (already true)' : ''}</span></div>`).join('')}</div>` : ''}
        <canvas class="pf-spark" aria-hidden="true"></canvas>
        <div class="pf-steps">${r.steps.map((s, i) => `<div class="pf-step${s.kind === 'goal' ? ' goal' : ''}" role="button" tabindex="0" data-i="${i}"><span class="y num">${s.year}</span><span>${esc(s.text)}</span></div>`).join('')}</div>
        <div class="pf-actions">
          <button class="link pf-watch" type="button">Watch</button>
          <button class="link pf-enter" type="button">Enter</button>
        </div>`;
      card.querySelectorAll<HTMLElement>('.pf-step').forEach((el) => el.addEventListener('click', () => this.seekStep(r, r.steps[Number(el.dataset.i)])));
      card.querySelectorAll<HTMLElement>('.pf-part').forEach((el) => { const p = parts[Number(el.dataset.i)]; el.addEventListener('click', () => this.opts.show(r.seed, p.year!, { body: p.body })); });
      card.querySelector('.pf-watch')!.addEventListener('click', () => this.watch(r.seed));
      card.querySelector('.pf-enter')!.addEventListener('click', () => this.opts.show(r.seed, r.year!, { body: g.body !== undefined && g.body >= 0 ? g.body : r.steps[r.steps.length - 1]?.body, system: g.system }));
      this.cardsEl.append(card);
      this.spark(card.querySelector('canvas')!, r);
    }
    if (!this.showAll && shown.length < got.length) {
      const b = document.createElement('button');
      b.className = 'link pf-all';
      b.type = 'button';
      b.textContent = `Show all ${got.length}`;
      b.addEventListener('click', () => { this.showAll = true; this.render(final); });
      this.cardsEl.append(b);
    }
    const missed = this.results.filter((r) => !r.reached);
    if (final && got.length && missed.length) {
      const near = [...new Set(missed.map((r) => r.progress).filter(Boolean))].slice(0, 2);
      this.footerEl.textContent = `The others never got there by 12040.${near.length ? ` Closest: ${near.join('; ')}.` : ''}`;
    }
  }

  /** Log-population sparkline: the road in miniature, a tick per step, a line at the goal. */
  private spark(c: HTMLCanvasElement, r: FutureResult): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { years, pop } = r.spark;
    const n = years.length;
    if (n < 2) return;
    const x0 = years[0], x1 = years[n - 1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (pop[i] > 0) { lo = Math.min(lo, pop[i]); hi = Math.max(hi, pop[i]); }
    if (!Number.isFinite(lo)) return;
    lo = Math.log10(lo); hi = Math.log10(hi);
    if (hi - lo < 0.1) { hi += 0.05; lo -= 0.05; }
    const X = (y: number) => 2 + ((y - x0) / Math.max(1e-9, x1 - x0)) * (W - 4);
    const Y = (v: number) => H - 3 - ((Math.log10(Math.max(v, 1)) - lo) / (hi - lo)) * (H - 8);
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = X(years[i]), y = Y(pop[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = 'rgba(127,227,255,0.85)';
    g.lineWidth = 1.2;
    g.stroke();
    for (const s of r.steps) {
      const i = Math.min(n - 1, Math.max(0, years.findIndex((y) => y >= s.year)));
      const x = X(s.year), y = Y(pop[i]);
      g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fillStyle = s.kind === 'goal' ? '#ffc45c' : 'rgba(242,242,242,0.55)';
      g.fill();
    }
    if (r.year !== undefined) {
      g.strokeStyle = 'rgba(255,196,92,0.8)';
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(r.year) + 0.5, 0); g.lineTo(X(r.year) + 0.5, H); g.stroke();
    }
  }

  // ------------------------------------------------------------------ the Oracle

  private async toggleOracle(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    if (agent.active) { agent.stop(); this.agentMode(''); return; }
    this.status('Summoning the Oracle…');
    try {
      await agent.start({
        transcript: (who, text) => this.transcript(who, text),
        mode: (m) => this.agentMode(m),
        status: (s) => this.status(s),
      });
      this.status('');
      this.agentMode(agent.active ? 'listening' : '');
    } catch (e) {
      this.status(`The Oracle could not speak: ${(e as Error).message ?? e}`);
    }
  }
}
