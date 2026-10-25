// The "Ask" panel and the brain behind it: one assistant for the whole app,
// reachable from every level (the header's Ask link, or the backquote key:
// tap to type, hold to talk). Voice runs over the Realtime API; typed questions
// go over the voice line when it is open (and are answered aloud), else
// through the text fallback. The Starship console borrows the same brain.

import './assistant.css';
import { PERSONA_NAME, instructions } from './prompt.ts';
import { RealtimeVoice, SessionError, type MicMode, type VoiceState } from './realtime.ts';
import { TextChat } from './textChat.ts';
import { AssistantTools, TOOLS, type AssistantHost } from './tools.ts';

const IDLE_MS = 2 * 60 * 1000;   // a voice line nobody uses closes itself
const HOLD_MS = 260;              // longer than this, the backquote key is push-to-talk
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type Availability = 'unknown' | 'ready' | 'nokey' | 'noserver';

/** Someone else showing the conversation (the Starship console). */
export interface Mirror { line(who: 'you' | 'ship' | 'sys', text: string, key?: string): void; live(on: boolean): void }

export class Assistant {
  el: HTMLElement;
  readonly tools: AssistantTools;
  readonly voice: RealtimeVoice;
  readonly text = new TextChat();
  available: Availability = 'unknown';
  mirror: Mirror | null = null;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private stateEl: HTMLElement;
  private connectBtn: HTMLButtonElement;
  private pttBtn: HTMLButtonElement;
  private handsBtn: HTMLButtonElement;
  private lines = new Map<string, HTMLElement>();
  private lastActive = 0;
  private ctxTimer = 0;
  private lastCtx = '';
  private busy = 0;
  private waiting = '';
  private abort: AbortController | null = null;
  private keyDown = 0;
  private keyHold = 0;
  private holding = false;
  private liveSince = 0;
  /** tool calls made, for the status line and tests */
  calls: { name: string; args: Record<string, unknown>; ms: number }[] = [];

  constructor(private host: AssistantHost) {
    this.tools = new AssistantTools(host);
    this.tools.onEnd = () => this.voice.disconnect('Voice off. Say hello any time.');
    this.voice = new RealtimeVoice({
      state: (s, why) => this.onState(s, why),
      heard: (id, t, final) => { if (final && !t) { this.drop(`u:${id}`); return; } this.line('you', t, `u:${id}`); },
      said: (id, t) => this.line('ship', t, `a:${id}`),
      speaking: (on) => this.el.classList.toggle('speaking', on),
      listening: (on) => this.el.classList.toggle('listening', on),
      tool: (name, args) => this.runTool(name, args),
      error: (m) => this.line('sys', m),
      activity: () => { this.lastActive = performance.now(); },
    });
    this.el = document.createElement('aside');
    this.el.className = 'ask';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', `Ask ${PERSONA_NAME}`);
    this.el.innerHTML = `
      <header><b>Ask ${PERSONA_NAME}</b><span class="ask-state muted" aria-live="polite">voice off</span>
        <button type="button" class="link ask-connect">Start voice</button><button type="button" class="link ask-close">Close</button></header>
      <div class="ask-log" role="log" aria-live="polite"></div>
      <form class="ask-form">
        <button type="button" class="link ask-ptt" title="Hold to talk (or hold the \` key)">Hold to talk</button>
        <button type="button" class="link ask-hands" aria-pressed="false" title="Always listening: just talk, and talk over her to interrupt">Hands-free</button>
        <input type="text" autocomplete="off" enterkeyhint="send" placeholder="Ask anything about this future…" aria-label="Ask ${PERSONA_NAME}">
        <button type="submit" class="link">Ask</button>
      </form>
      <p class="ask-foot muted">\` to open, hold \` to talk. Voice closes after 2 minutes idle.</p>`;
    this.log = this.el.querySelector('.ask-log')!;
    this.input = this.el.querySelector('input')!;
    this.stateEl = this.el.querySelector('.ask-state')!;
    this.connectBtn = this.el.querySelector('.ask-connect')!;
    this.pttBtn = this.el.querySelector('.ask-ptt')!;
    this.handsBtn = this.el.querySelector('.ask-hands')!;
    this.el.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value; this.input.value = ''; this.ask(t); });
    this.el.querySelector('.ask-close')!.addEventListener('click', () => this.close());
    this.connectBtn.addEventListener('click', () => { if (this.voice.state === 'off') void this.startVoice(this.voice.mode); else this.voice.disconnect('Voice off.'); });
    this.handsBtn.addEventListener('click', () => this.setMode(this.voice.mode === 'handsfree' ? 'ptt' : 'handsfree'));
    // push to talk: press and hold (pointer or keyboard)
    this.pttBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.pttBtn.setPointerCapture(e.pointerId); void this.pttDown(); });
    this.pttBtn.addEventListener('pointerup', () => this.pttUp());
    this.pttBtn.addEventListener('pointercancel', () => this.pttUp());
    this.pttBtn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); void this.pttDown(); } });
    this.pttBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') this.pttUp(); });
    // keys typed here are the assistant's, not the sim's shortcuts (but the backquote still toggles)
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.close(); return; } if (e.key !== '`') e.stopPropagation(); });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.setInterval(() => this.tick(), 1000);
    void this.probe();
  }

  /** Is there a dev server with a key? The single-file build has neither. */
  async probe(): Promise<Availability> {
    const local = import.meta.env.DEV || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (!local) { this.available = 'noserver'; this.renderState(); return this.available; }
    try {
      const r = await fetch('/openai/status');
      const j = await r.json() as { configured: boolean };
      this.available = j.configured ? 'ready' : 'nokey';
    } catch { this.available = 'noserver'; }
    this.renderState();
    return this.available;
  }

  private unavailableText(): string {
    return this.available === 'nokey' ? 'No OpenAI key: add OPENAI_API_KEY to .env.local and restart the dev server.'
      : 'Voice assistant needs the local dev server (npm run dev); this page has no server to keep the API key on.';
  }

  get open(): boolean { return !this.el.hidden; }
  show(focus = true): void {
    this.el.hidden = false;
    if (!this.log.childElementCount) {
      if (this.available === 'nokey' || this.available === 'noserver') this.line('sys', this.unavailableText());
      else this.line('ship', `Hi, I'm ${PERSONA_NAME}. Ask me anything about this future, or tell me where to take you. Type, hold to talk, or turn on hands-free.`);
    }
    if (focus) this.input.focus();
  }
  close(): void { this.el.hidden = true; }
  /** Somewhere else to type instead (the Starship console while aboard): returns true if it took over. */
  redirect: () => boolean = () => false;
  toggle(): void { if (this.open) this.close(); else if (!this.redirect()) this.show(); }

  // ---------------------------------------------------------------- context

  /** The live context the model starts every answer with. */
  context(): string {
    const h = this.host;
    const card = h.card().replace(/^×\s*/, '').replace(/\s+/g, ' ').slice(0, 700);
    return [
      `Year on screen: ${Math.round(2040 + h.year())}. Future #${h.sim.seed}${h.sim.done ? '' : ` (still simulating, through ${Math.round(2040 + (h.sim.years[h.sim.frontier] ?? 0))})`}.`,
      `Era and age: ${h.eraLine() || 'unknown'}.`,
      `Zoom level: ${h.level()}. Selected: ${h.selection() || 'nothing (all of humanity)'}.${h.boarded() ? ' The user is aboard the Starship.' : ''}`,
      card ? `Inspector card (start): ${card}` : '',
    ].filter(Boolean).join('\n');
  }

  /** The app moved (year, place, selection): refresh the voice line's context, at most every 2 s. */
  contextChanged(): void {
    if (!this.voice.live) return;
    clearTimeout(this.ctxTimer);
    this.ctxTimer = window.setTimeout(() => {
      const c = this.context();
      if (c === this.lastCtx) return;
      this.lastCtx = c;
      this.voice.updateInstructions(instructions(c));
    }, 2000);
  }

  // ---------------------------------------------------------------- asking

  /** A typed question (from this panel or the Starship console). */
  ask(raw: string, show = true): void {
    const text = raw.trim();
    if (!text) return;
    if (show) this.show(false);
    this.line('you', text);
    this.lastActive = performance.now();
    if (this.available === 'nokey' || this.available === 'noserver') { this.line('sys', this.unavailableText()); return; }
    if (this.voice.live) { this.voice.ask(text); return; }
    void this.askText(text);
  }

  private async askText(text: string): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.busy++;
    this.renderState();
    const key = `t:${performance.now()}`;
    this.line('ship', '…', key);
    this.waiting = key;
    try {
      const said = await this.text.ask(text, instructions(this.context()), TOOLS, (n, a) => this.runTool(n, a), ac.signal);
      if (ac.signal.aborted) return;
      this.line('ship', said, key);
      this.mirrorSay(said);
    } catch (e) {
      if ((e as Error).name === 'AbortError') { this.drop(key); return; }
      this.drop(key);
      if (e instanceof SessionError && e.code === 'noserver') { this.available = 'noserver'; this.line('sys', this.unavailableText()); }
      else if (e instanceof SessionError && e.code === 'nokey') { this.available = 'nokey'; this.line('sys', this.unavailableText()); }
      else this.line('sys', (e as Error).message);
    } finally { this.busy--; if (this.waiting === key) this.waiting = ''; this.renderState(); }
  }

  /** Spoken aloud by the Starship's own voice, for text answers while aboard. */
  onTextAnswer: (text: string) => void = () => {};
  private mirrorSay(text: string): void { this.onTextAnswer(text); }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const t0 = performance.now();
    const note = this.toolNote(name, args);
    const key = `tool:${t0}`;
    if (note) this.line('sys', note, key);
    const r = await this.tools.run(name, args);
    this.calls.push({ name, args, ms: Math.round(performance.now() - t0) });
    if (this.calls.length > 50) this.calls.shift();
    this.lastActive = performance.now();
    return r;
  }

  private toolNote(name: string, a: Record<string, unknown>): string {
    const s = (k: string) => (a[k] !== undefined ? String(a[k]) : '');
    switch (name) {
      case 'go_to': return `Flying to ${s('name')}${a.year ? ` in ${s('year')}` : ''}.`;
      case 'set_year': return `Moving to ${s('year')}.`;
      case 'zoom': return `Zooming to ${s('level')}.`;
      case 'open_panel': return `Opening ${s('panel')}.`;
      case 'starship': return `Starship: ${s('action')}.`;
      case 'end_session': return '';
      default: return `Looking up ${name.replace(/_/g, ' ')}${a.name ? `: ${s('name')}` : a.query ? `: ${s('query')}` : a.section ? `: ${s('section')}` : ''}.`;
    }
  }

  // ---------------------------------------------------------------- voice

  async startVoice(mode: MicMode = 'ptt'): Promise<boolean> {
    if (this.voice.state !== 'off') return this.voice.live;
    if (this.available === 'unknown') await this.probe();
    if (this.available !== 'ready') { if (!this.host.boarded()) this.show(false); this.line('sys', this.unavailableText()); return false; }
    if (!this.host.boarded()) this.show(false);
    try {
      this.lastCtx = this.context();
      await this.voice.connect(instructions(this.lastCtx), TOOLS, mode);
      this.text.reset();
      return true;
    } catch (e) {
      const code = e instanceof SessionError ? e.code : '';
      if (code === 'noserver' || code === 'nokey') this.available = code;
      this.renderState();
      return false;
    }
  }

  setMode(mode: MicMode): void {
    if (!this.voice.live) { this.voice.mode = mode; void this.startVoice(mode); this.renderState(); return; }
    this.voice.setMode(mode);
    this.renderState();
  }

  private async pttDown(): Promise<void> {
    this.holding = true;
    if (this.voice.mode === 'handsfree' && this.voice.live) { this.voice.interrupt(); return; }
    if (!this.voice.live) {
      const ok = await this.startVoice('ptt');
      if (!ok || !this.holding) return;
    }
    this.voice.pttDown();
  }
  private pttUp(): void { this.holding = false; this.voice.pttUp(); }

  /** Backquote: tap to open the panel and type, hold to talk. Other keys are the sim's. */
  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.key !== '`' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (down && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t !== this.input) return;
    e.preventDefault();
    if (down) {
      if (e.repeat || this.keyDown) return;
      this.keyDown = performance.now();
      this.keyHold = window.setTimeout(() => { this.keyHold = 0; void this.pttDown(); }, HOLD_MS);
    } else if (this.keyDown) {
      this.keyDown = 0;
      if (this.keyHold) { clearTimeout(this.keyHold); this.keyHold = 0; this.toggle(); } else this.pttUp();
    }
  }

  private onState(s: VoiceState, why?: string): void {
    if (s === 'live') this.liveSince = performance.now();
    if (why) this.line('sys', why);
    this.mirror?.live(s === 'live');
    this.renderState();
  }

  private tick(): void {
    if (!this.voice.live) { if (this.busy === 0 && this.stateEl.textContent?.startsWith('voice live')) this.renderState(); return; }
    if (performance.now() - this.lastActive > IDLE_MS && !this.holding) { this.voice.disconnect('Voice closed after two quiet minutes, to save credits.'); return; }
    this.renderState();
  }

  private renderState(): void {
    const v = this.voice, live = v.live;
    const secs = live ? Math.round((performance.now() - this.liveSince) / 1000) : 0;
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.stateEl.textContent = v.state === 'connecting' ? 'connecting…'
      : live ? `voice live ${clock} · ${v.mode === 'handsfree' ? 'listening' : 'hold to talk'}`
      : this.busy ? 'thinking…'
      : this.available === 'ready' ? 'voice off' : this.available === 'unknown' ? '' : 'unavailable';
    this.connectBtn.textContent = v.state === 'off' ? 'Start voice' : 'Stop voice';
    this.connectBtn.disabled = this.available === 'noserver' || this.available === 'nokey';
    this.handsBtn.setAttribute('aria-pressed', String(live && v.mode === 'handsfree'));
    this.el.classList.toggle('live', live);
    this.el.classList.toggle('connecting', v.state === 'connecting');
  }

  // ---------------------------------------------------------------- transcript

  private line(who: 'you' | 'ship' | 'sys', text: string, key?: string): void {
    let p = key ? this.lines.get(key) : undefined;
    if (!p) {
      p = document.createElement('p');
      p.className = `msg ${who}`;
      // lookups show above the answer they are for
      const wait = this.waiting && this.lines.get(this.waiting);
      if (wait && key?.startsWith('tool:')) wait.before(p); else this.log.append(p);
      if (key) this.lines.set(key, p);
      while (this.log.childElementCount > 80) { const f = this.log.firstElementChild!; for (const [k, v] of this.lines) if (v === f) this.lines.delete(k); f.remove(); }
    }
    p.innerHTML = esc(text);
    this.log.scrollTop = this.log.scrollHeight;
    if (who !== 'sys' || !key?.startsWith('tool:')) this.mirror?.line(who, text, key);
  }
  private drop(key: string): void { this.lines.get(key)?.remove(); this.lines.delete(key); }
}
