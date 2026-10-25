// The ship computer, docked in the simulation: type or say where (and when) to go.
// Plain-English orders are parsed by commands.ts and become simulation actions: a
// trip is a flight through the sim's own zoom levels, a date is a run of the
// timeline, and the ship answers in text and voice.

import { parse, type Action } from './commands.ts';
import { EngineAudio } from './audio.ts';
import { Voice } from './voice.ts';
import type { ShipView } from './voyage.ts';

/** What the console needs from the simulation. */
export interface Helm {
  /** Fly to a named place (any star, world, galaxy or resident the sim can find). Returns its display name, or null. */
  goto(name: string): string | null;
  /** The same lookup without flying anywhere. */
  lookup(name: string): string | null;
  /** The calendar year on screen. */
  year(): number;
  /** Fly to a random settled world, optionally habitable or of a kind. */
  random(opts: { habitable?: boolean; kind?: string }): string | null;
  /** Run the timeline to a calendar year; resolves with the year actually reached. */
  timeTravel(calendarYear: number): Promise<number>;
  /** One line on where and when we are. */
  status(): string;
  setView(v: ShipView): void;
  leave(): void;
  first: number; last: number; // calendar years the record covers
}

/** The GPT assistant (src/assistant), when there is one: it becomes the ship computer's mind and voice. */
export interface ShipBrain {
  /** a dev server with a key is there */
  ready(): boolean;
  /** the voice line is open: everything said or typed goes to it */
  live(): boolean;
  ask(text: string): void;
  /** the Talk button: open or close the voice line */
  talk(): void;
}

/** Questions (rather than orders) go to the assistant when it is there. */
const QUESTION = /\?\s*$|^(what|who|whom|whose|why|how|when|which|is|are|was|were|do|does|did|can|could|should|would|will|tell|explain|describe|compare|list|show me (the|a|all)|give me)\b/i;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const CHIPS = ['Mars', 'Tau Ceti in 3400', 'Random planet', 'Year 2500', 'Proxima b', 'Andromeda', 'Cockpit view', 'Where are we?'];
// words that wrap a place name in an order: "take me to", "fly to", "visit"…
const FILLER = /\b(take|send|bring|fly|go|head|jump|warp|travel|set course|course|me|us|to|for|towards?|the|please|now|visit|show|let's|lets|i want|wanna|can we|could we)\b/g;

export class ShipConsole {
  el: HTMLElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private mic: HTMLButtonElement;
  private voice = new Voice();
  readonly engine = new EngineAudio();
  private heard = false;
  private queue: Action[] = [];
  private busy = false;
  view: ShipView = 'chase';
  brain: ShipBrain | null = null;
  private lastText = '';
  private keyed = new Map<string, HTMLElement>();

  constructor(private helm: Helm) {
    this.el = document.createElement('aside');
    this.el.className = 'ship-console';
    this.el.setAttribute('aria-label', 'Ship computer');
    this.el.hidden = true;
    this.el.innerHTML = `
      <header><b>Ship computer</b>
        <span class="views" role="group" aria-label="Camera"><button type="button" data-view="chase" class="link" aria-pressed="true">Chase</button><button type="button" data-view="cockpit" class="link" aria-pressed="false">Cockpit</button></span>
        <button type="button" class="link leave">Leave ship</button></header>
      <div class="ship-log" role="log" aria-live="polite"></div>
      <div class="ship-chips">${CHIPS.map((c) => `<button type="button" class="link">${esc(c)}</button>`).join('')}</div>
      <form class="ship-say"><button type="button" class="mic link" aria-label="Talk">Talk</button>
        <input id="ship-say" type="text" autocomplete="off" enterkeyhint="send" placeholder="Where to? Or when?" aria-label="Tell the ship where or when to go">
        <button type="submit" class="link">Go</button></form>`;
    this.log = this.el.querySelector('.ship-log')!;
    this.input = this.el.querySelector('#ship-say')!;
    this.mic = this.el.querySelector('.mic')!;
    this.el.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value; this.input.value = ''; this.command(t); });
    this.el.querySelectorAll<HTMLButtonElement>('.ship-chips button').forEach((b) => b.addEventListener('click', () => this.command(b.textContent!)));
    this.el.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as ShipView)));
    this.el.querySelector('.leave')!.addEventListener('click', () => this.helm.leave());
    this.mic.addEventListener('click', () => this.listen());
    this.voice.onStatus = (s) => this.add('sys', s);
    // keys typed here are the ship's, not the sim's shortcuts
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  open(): void {
    this.el.hidden = false;
    this.heard = true;
    this.engine.start();
    if (!this.log.childElementCount) {
      this.reply(`Systems online. Tell me where to go in this future, or when: anywhere from ${this.helm.first} to ${this.helm.last}.`);
    }
    this.input.focus();
  }
  close(): void { this.el.hidden = true; this.voice.stopSpeaking(); }

  setView(v: ShipView): void {
    this.view = v;
    this.helm.setView(v);
    this.el.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  }

  private add(who: 'you' | 'ship' | 'sys', text: string, key?: string): void {
    let d = key ? this.keyed.get(key) : undefined;
    if (!d) {
      d = document.createElement('p');
      d.className = `msg ${who}`;
      this.log.append(d);
      if (key) this.keyed.set(key, d);
    }
    d.textContent = text;
    while (this.log.childElementCount > 60) { const f = this.log.firstElementChild!; for (const [k, v] of this.keyed) if (v === f) this.keyed.delete(k); f.remove(); }
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** A line of the assistant's conversation (streamed lines update in place by key). */
  hear(who: 'you' | 'ship' | 'sys', text: string, key?: string): void { this.add(who, text, key); }
  /** Say something in the ship's own (browser) voice: the assistant's text answers while the voice line is closed. */
  speak(text: string): void { if (this.heard && !this.el.hidden) void this.voice.say(text); }
  /** The assistant's voice line opened or closed. */
  setLive(on: boolean): void {
    this.mic.classList.toggle('on', on);
    this.mic.textContent = on ? 'End talk' : 'Talk';
    this.input.placeholder = on ? 'Talk, or type: where, when, or anything' : 'Where to? Or when? Or ask anything';
  }
  focus(): void { this.input.focus(); }
  private reply(text: string): void { this.add('ship', text); if (this.heard) void this.voice.say(text); }

  private async listen(): Promise<void> {
    if (this.brain?.ready()) { this.voice.stopSpeaking(); this.brain.talk(); return; }
    if (this.voice.listening) { this.voice.stopListening(); return; }
    this.voice.stopSpeaking();
    this.mic.classList.add('on');
    try {
      const text = await this.voice.listen(() => {});
      if (text) this.command(text); else this.add('sys', 'Didn\'t hear anything.');
    } catch (e) { this.add('sys', (e as Error).message); }
    finally { this.mic.classList.remove('on'); }
  }

  command(text: string): void {
    text = text.trim();
    if (!text) return;
    const b = this.brain;
    // with the voice line open the assistant hears everything; otherwise it takes the questions
    if (b?.live() || (b?.ready() && QUESTION.test(text))) { this.add('you', text); b.ask(text); return; }
    this.add('you', text);
    this.lastText = text;
    const h = this.helm;
    // a resident is found by the sim's own search ("resident 12 of Titan", "#2.5B of Mars")
    if (/^(resident|person|citizen)\b/i.test(text) || /#\s*\d/.test(text)) {
      const got = h.goto(text);
      this.reply(got ? `${got}. Opening their life.` : 'Nobody by that number lives there.');
      return;
    }
    // "go back 300 years" counts from the year on screen, not from today
    const relative = /\b(back|forward|ahead|ago|later|earlier|from now)\b/i.test(text);
    const actions = parse(text.replace(/^year (\d+)$/i, 'go to the year $1'))
      .map((a) => (a.type === 'time' && relative ? { ...a, year: h.year() + (a.year - 2026) } : a));
    // a place the ship's star charts don't know, or whose catalogue number reads like a year
    // ("TOI 98077 b"), may still be somewhere in this future
    const name = text.toLowerCase().replace(/\bin (the year )?\d+.*$/, '').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    const offChart = actions.some((a) => a.type === 'unknown') || (!relative && actions.some((a) => a.type === 'time' && (a.year < h.first || a.year > h.last)));
    if (offChart && name && !/^(year )?\d+$/.test(name) && h.lookup(name)) {
      const got = h.goto(name)!;
      this.reply(`Course laid in for ${got}.`);
      const year = text.match(/\bin (?:the year )?(\d{4,5})\b/);
      if (year) this.enqueue({ type: 'time', year: Number(year[1]) });
      return;
    }
    for (const a of actions) {
      if (a.type === 'view' || a.type === 'status' || a.type === 'help' || a.type === 'stop' || a.type === 'unknown') this.run(a);
      else this.enqueue(a);
    }
  }

  private enqueue(a: Action): void { this.queue.push(a); if (!this.busy) void this.next(); }

  private async next(): Promise<void> {
    const a = this.queue.shift();
    if (!a) { this.busy = false; return; }
    this.busy = true;
    await this.run(a);
    // let a flight settle before the next leg
    setTimeout(() => void this.next(), a.type === 'time' ? 200 : 1600);
  }

  private async run(a: Action): Promise<void> {
    const h = this.helm;
    switch (a.type) {
      case 'travel': {
        const k = a.dest.system.kind;
        const name = a.dest.body ?? (k === 'blackhole' || k === 'nebula' ? 'Milky Way' : k === 'galaxy' ? a.dest.system.name.replace(/ galaxy$/i, '') : a.dest.system.name);
        const got = h.goto(name) ?? h.goto(a.dest.label);
        this.reply(got ? (a.dest.system.kind === 'blackhole' ? 'Heading in toward Sagittarius A*, the black hole at the centre.' : `Course laid in for ${got}.`) : `${a.dest.label} isn't in this future's charts.`);
        break;
      }
      case 'random': {
        const got = h.random({ habitable: a.habitable, kind: a.kind });
        this.reply(got ? `Picked one: ${got}.` : 'Nothing like that is settled yet.');
        break;
      }
      case 'time': {
        const want = Math.round(a.year);
        if (want < h.first || want > h.last) this.reply(`This future's record runs from ${h.first} to ${h.last}, so the nearest I can take you is ${want < h.first ? h.first : h.last}.`);
        else this.reply(`Spinning up the chrono field for ${want}.`);
        const got = await h.timeTravel(Math.max(h.first, Math.min(h.last, want)));
        this.reply(`It's ${got}. ${h.status()}`);
        break;
      }
      case 'view': this.setView(a.mode === 'toggle' ? (this.view === 'chase' ? 'cockpit' : 'chase') : a.mode === 'first' ? 'cockpit' : 'chase'); this.reply(this.view === 'cockpit' ? 'Cockpit view.' : 'Chase cam.'); break;
      case 'status': this.reply(h.status()); break;
      case 'help': this.reply('Tell me where or when. "Take me to Tau Ceti." "Mars in the year 3000." "Random planet." "Resident 12 of Titan." "Cockpit view."'); break;
      case 'stop': this.queue.length = 0; this.reply('Holding here.'); break;
      case 'unknown': if (this.brain?.ready()) { this.brain.ask(this.lastText); break; } this.reply('I didn\'t find a place or a year in that. Try a star, a world, a year between ' + `${h.first} and ${h.last}, or "random planet".`); break;
    }
  }
}
