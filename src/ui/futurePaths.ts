// The "What leads to…?" panel: ask for a moment in the timeline and watch the
// futures that reach it stream in as cards — the road each took, a sparkline of
// its population, and buttons to watch, hear or enter that future.

import './paths.css';
import { Pathfinder } from './pathfinder.ts';
import { compareFutures, countLine, narrateFuture, narrateOverview, parseGoal, type FutureResult, type Goal, type Step } from '../sim/milestones.ts';
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

export type AskResult = { goal: Goal; results: FutureResult[]; tried: number } | { error: string; suggestions: string[] };

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
  private speakBox: HTMLInputElement;
  private oracleBtn: HTMLButtonElement;
  private agent: OracleAgent | null = null;
  private goal: Goal | null = null;
  private results: FutureResult[] = [];
  private seq = 0;
  private tried = 0;
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
        <input type="text" autocomplete="off" placeholder="A moment in time: colonisation of Mars…" aria-label="Name a moment in the timeline">
        <button class="link pf-go" type="submit">Ask</button>
        <button class="link pf-mic" type="button" aria-label="Ask out loud">Speak</button>
      </form>
      <div class="pf-chips">${CHIPS.map((c) => `<button class="link" type="button">${esc(c)}</button>`).join('')}</div>
      <p class="pf-aux">
        <label><input class="pf-speak" type="checkbox"${opts.voice.speak ? ' checked' : ''}> Speak answers</label>
        <button class="link pf-oracle" type="button" hidden>Talk to the Oracle</button>
      </p>
      <div class="pf-mode" role="status" hidden></div>
      <div class="pf-transcript" hidden></div>
      <p class="pf-status" aria-live="polite"></p>
      <div class="pf-cards"></div>
      <p class="pf-footer muted"></p>`;
    this.input = this.el.querySelector('.pf-ask input')!;
    this.statusEl = this.el.querySelector('.pf-status')!;
    this.footerEl = this.el.querySelector('.pf-footer')!;
    this.cardsEl = this.el.querySelector('.pf-cards')!;
    this.transcriptEl = this.el.querySelector('.pf-transcript')!;
    this.modeEl = this.el.querySelector('.pf-mode')!;
    this.micBtn = this.el.querySelector('.pf-mic')!;
    this.speakBox = this.el.querySelector('.pf-speak')!;
    this.oracleBtn = this.el.querySelector('.pf-oracle')!;

    this.el.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value; this.input.value = ''; void this.ask(t); });
    this.el.querySelectorAll<HTMLButtonElement>('.pf-chips button').forEach((b) => b.addEventListener('click', () => void this.ask(b.textContent!)));
    this.el.querySelector('.pf-x')!.addEventListener('click', () => this.hide());
    this.micBtn.addEventListener('click', () => void this.listen());
    this.speakBox.addEventListener('change', () => opts.voice.setSpeak(this.speakBox.checked));
    this.oracleBtn.addEventListener('click', () => this.toggleOracle());
    // typed keys inside the panel are its own, not the sim's shortcuts
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.opts.voice.onStatus = (s) => this.status(s);
  }

  /** The conversational agent becomes available once an agent id is configured. */
  setAgent(agent: OracleAgent | null): void {
    this.agent = agent;
    this.oracleBtn.hidden = !agent?.available;
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
    v.stopSpeaking();
    this.micBtn.classList.add('on');
    try {
      const text = await v.listen(() => {});
      if (text) { this.input.value = text; void this.ask(text); }
      else this.status('Didn\'t hear anything.');
    } catch (e) { this.status((e as Error).message); }
    finally { this.micBtn.classList.remove('on'); }
  }

  /**
   * Ask "what leads to X": parses the goal, simulates futures until six reach
   * it, streams the cards in. Resolves for the console/agent with the outcome.
   */
  ask(text: string): Promise<AskResult> {
    const seq = ++this.seq;
    const pr = parseGoal(text, this.opts.world);
    this.results = [];
    this.tried = 0;
    // a live Oracle conversation keeps its transcript; only cold asks clear it
    if (!this.agent?.active) { this.transcriptEl.hidden = true; this.transcriptEl.innerHTML = ''; }
    if ('error' in pr) {
      this.goal = null;
      this.status(pr.error);
      this.footerEl.innerHTML = `Try: ${pr.suggestions.map((s) => `<button class="link pf-sug" type="button">${esc(s)}</button>`).join(' ')}`;
      this.cardsEl.innerHTML = '';
      this.footerEl.querySelectorAll<HTMLButtonElement>('.pf-sug').forEach((b) => b.addEventListener('click', () => void this.ask(b.textContent!)));
      return Promise.resolve(pr);
    }
    this.goal = pr.goal;
    this.cardsEl.innerHTML = '';
    this.footerEl.textContent = '';
    this.status(`Simulating futures toward ${pr.goal.label}…`);
    return new Promise((resolve) => {
      this.pathfinder.find(pr.goal, this.opts.seed(), (r) => {
        if (seq !== this.seq) return;
        this.results.push(r);
        this.tried++;
        const got = this.results.filter((x) => x.reached).length;
        this.status(countLine(got, this.tried, pr.goal.label, { live: true }));
        this.render();
      }, (results, tried) => {
        if (seq !== this.seq) return resolve({ goal: pr.goal, results: [], tried });
        this.results = results;
        this.tried = tried;
        const got = results.filter((r) => r.reached);
        const near = results.filter((r) => !r.reached).map((r) => r.progress).filter(Boolean)[0];
        this.status(countLine(got.length, tried, pr.goal.label, { near }));
        this.render(true);
        if (this.opts.voice.speak && !this.agent?.active) void this.opts.voice.say(narrateOverview(pr.goal, results, tried));
        resolve({ goal: pr.goal, results, tried });
      });
    });
  }

  /** Fly the screen into a future: goal year, or a clicked step's year. */
  watch(seed: number, year?: number): void {
    const r = this.results.find((x) => x.seed === seed && x.reached);
    const g = this.goal;
    if (!r || !g) { this.opts.show(seed, year ?? 2040, {}); return; }
    this.opts.show(seed, year ?? r.year!, { body: g.body !== undefined && g.body >= 0 ? g.body : r.steps[r.steps.length - 1]?.body, system: g.system, play: year === undefined });
  }

  private seekStep(r: FutureResult, s: Step): void {
    this.opts.show(r.seed, s.year, { body: s.body, system: this.goal?.system });
  }

  private render(final = false): void {
    const g = this.goal;
    if (!g) return;
    const got = this.results.filter((r) => r.reached).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
    const { medianYear, highlights } = compareFutures(g, this.results);
    this.cardsEl.innerHTML = '';
    for (const r of got) {
      const card = document.createElement('div');
      card.className = 'pf-card';
      const delta = got.length >= 2 && r.year !== undefined
        ? (r.year === medianYear ? 'the middle future' : `${Math.abs(r.year - medianYear)} years ${r.year < medianYear ? 'before' : 'after'} the median`)
        : '';
      const hl = highlights.get(r.seed);
      card.innerHTML = `
        <div class="pf-card-head"><b>Future #${r.seed} — ${r.year}</b><span class="pf-delta">${esc(delta)}</span></div>
        ${hl ? `<p class="pf-hl">${esc(hl)}</p>` : ''}
        <canvas class="pf-spark" aria-hidden="true"></canvas>
        <div class="pf-steps">${r.steps.map((s, i) => `<div class="pf-step${s.kind === 'goal' ? ' goal' : ''}" role="button" tabindex="0" data-i="${i}"><span class="y num">${s.year}</span><span>${esc(s.text)}</span></div>`).join('')}</div>
        <div class="pf-actions">
          <button class="link pf-watch" type="button">Watch</button>
          <button class="link pf-hear" type="button">Hear</button>
          <button class="link pf-enter" type="button">Enter</button>
        </div>`;
      card.querySelectorAll<HTMLElement>('.pf-step').forEach((el) => el.addEventListener('click', () => this.seekStep(r, r.steps[Number(el.dataset.i)])));
      card.querySelector('.pf-watch')!.addEventListener('click', () => this.watch(r.seed));
      card.querySelector('.pf-hear')!.addEventListener('click', () => { if (!this.agent?.active) void this.opts.voice.say(narrateFuture(g, r, highlights.get(r.seed))); });
      card.querySelector('.pf-enter')!.addEventListener('click', () => this.opts.show(r.seed, r.year!, { body: g.body !== undefined && g.body >= 0 ? g.body : r.steps[r.steps.length - 1]?.body, system: g.system }));
      this.cardsEl.append(card);
      this.spark(card.querySelector('canvas')!, r);
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
    this.opts.voice.stopSpeaking();
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
