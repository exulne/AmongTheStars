// The time slider: years 0 to 10,000 after the Mars landing, on a warped axis
// so the first centuries get room. Era band and simulated frontier underneath.

import { ERAS } from '../sim/catalog.ts';
import { ERA_COLORS, HORIZON, eraRuns, posToYear, yearToPos } from './charts.ts';
import { fmtYear } from './format.ts';

// playback gears, cycled by the speed button — weighted slow; fastest is just past 1×
const SPEEDS = [0.15, 0.3, 0.5, 0.75, 1, 1.25];

export class Timeline {
  el: HTMLElement;
  private input: HTMLInputElement;
  private band: HTMLCanvasElement;
  private yearEl: HTMLInputElement;
  private progressEl: HTMLElement;
  private subEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private speedIdx = 4;
  speed = 1;
  year = 0;
  frontier = 0;
  playing = false;
  onChange: (year: number) => void = () => {};
  onToggle: (playing: boolean) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'timeline';
    this.el.innerHTML = `
      <div class="tl-row">
        <button class="tl-play" type="button" aria-label="Play">Play</button>
        <button class="tl-speed num link" type="button" aria-label="Playback speed" title="Playback speed">1×</button>
        <div class="tl-year"><input class="tl-big num" id="year-input" inputmode="numeric" value="2040" size="5" aria-label="Go to year" title="Type a year and press Enter"><span class="tl-sub"></span></div>
      </div>
      <div class="tl-track">
        <canvas class="tl-band" aria-hidden="true"></canvas>
        <i class="tl-progress" aria-hidden="true"></i>
        <input id="timeline-year" type="range" min="0" max="10000" step="1" value="0" aria-label="Year">
        <div class="tl-ticks" aria-hidden="true"></div>
      </div>
      <div class="tl-ages" aria-label="Ages of this future"></div>
      <div class="tl-eras" aria-label="Era colours">${eraLegend()}</div>`;
    this.input = this.el.querySelector<HTMLInputElement>('input[type=range]')!;
    this.band = this.el.querySelector('canvas')!;
    this.yearEl = this.el.querySelector('.tl-big')!;
    this.subEl = this.el.querySelector('.tl-sub')!;
    this.playBtn = this.el.querySelector('.tl-play')!;
    this.speedBtn = this.el.querySelector('.tl-speed')!;
    this.progressEl = this.el.querySelector('.tl-progress')!;
    // typed years: 3400 means AD 3400; anything under 2040 is years after landing
    // calendar years only: 1999 is before the landing, not "year 1999 after it"
    const commit = () => {
      const raw = this.yearEl.value.trim().replace(/[,\s]/g, '');
      if (!/^\d+(\.\d+)?$/.test(raw)) { this.yearEl.value = fmtYear(this.year); if (raw) this.flash('Type a year, like 3400'); return; }
      const cal = Math.round(Number(raw));
      if (cal < 2040) this.flash('The story starts with the landing in 2040');
      else if (cal > 2040 + HORIZON) this.flash(`The simulation ends in ${2040 + HORIZON}`);
      else if (cal - 2040 > this.frontier) this.flash(`Simulated so far: up to ${fmtYear(this.frontier)}`);
      this.set(Math.max(0, cal - 2040), true);
      this.yearEl.value = fmtYear(this.year);
    };
    this.yearEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); this.yearEl.blur(); }
      if (e.key === 'Escape') { this.yearEl.value = fmtYear(this.year); this.yearEl.blur(); }
    });
    this.yearEl.addEventListener('focus', () => this.yearEl.select());
    this.yearEl.addEventListener('blur', () => { this.yearEl.value = fmtYear(this.year); });
    const ticks = this.el.querySelector('.tl-ticks')!;
    for (const y of [0, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
      const t = document.createElement('span');
      t.style.left = `${yearToPos(y) * 100}%`;
      t.textContent = fmtYear(y);
      // dropped on narrow screens, where they would collide with their neighbours
      if (y === 10 || y === 50 || y === 250) t.className = 'minor';
      ticks.append(t);
    }
    this.input.addEventListener('input', () => {
      this.set(Math.round(posToYear(Number(this.input.value) / 10000)), true);
    });
    this.playBtn.addEventListener('click', () => this.toggle());
    this.speedBtn.addEventListener('click', () => {
      this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
      this.speed = SPEEDS[this.speedIdx];
      this.speedBtn.textContent = `${this.speed}×`;
      this.speedBtn.setAttribute('aria-label', `Playback speed ${this.speed}×`);
    });
    this.el.querySelector('.tl-ages')!.addEventListener('click', (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-age]')?.dataset.age;
      if (i !== undefined) this.set(this.ages[Number(i)].from + 0.5, true);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); this.step(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey); }
    });
    new ResizeObserver(() => { this.drawBand(); this.fitAges(); }).observe(this.band);
  }

  /** One sim step (1, 4 or 10 years depending on the epoch), or ten with `big`. */
  step(dir: number, big = false): void {
    this.set(this.year + dir * (this.year < 200 ? 1 : this.year < 1000 ? 4 : 10) * (big ? 10 : 1), true);
  }

  toggle(): void {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    if (this.playing && this.year >= Math.min(HORIZON, this.frontier) - 1) this.set(0, true);
    this.onToggle(this.playing);
  }

  /** Called every frame while playing: constant speed in slider space. */
  tick(dt: number): void {
    if (!this.playing) return;
    const p = yearToPos(this.year) + (dt / 90) * this.speed;
    const y = posToYear(p);
    if (y >= this.frontier) { this.set(this.frontier, true); if (this.frontier >= HORIZON) this.toggle(); return; }
    this.set(Math.max(this.year + (this.year < 200 ? 0.25 : 0), y), true);
  }

  set(year: number, emit = false): void {
    year = Math.max(0, Math.min(year, this.frontier, HORIZON));
    this.year = year;
    this.input.value = String(Math.round(yearToPos(year) * 10000));
    if (document.activeElement !== this.yearEl) this.yearEl.value = fmtYear(year);
    this.renderSub();
    if (emit) this.onChange(year);
  }

  private flashUntil = 0;
  /** A short note in place of the era line. */
  flash(msg: string): void {
    this.subEl.textContent = msg;
    this.flashUntil = performance.now() + 2600;
    setTimeout(() => this.renderSub(), 2700);
  }

  private eraName = '';
  setEra(name: string): void { this.eraName = name; this.renderSub(); }
  /** The local reckoning for a year ("AL 2960 · year 412 of the Kepler Compact"), or "" to count from Mars. */
  local: (year: number) => string = () => '';
  refresh(): void { this.renderSub(); }
  private renderSub(): void {
    if (performance.now() < this.flashUntil) return;
    const local = this.local(this.year);
    const head = local ? `AD · ${local}` : `year ${Math.round(this.year).toLocaleString('en-US')} after Mars`;
    const age = this.ageName(this.year);
    const text = `${head}${this.eraName ? ` · ${this.eraName}` : ''}${age ? ` · ${age}` : ''}`;
    if (this.subEl.textContent !== text) this.subEl.textContent = text;
  }

  private ages: { from: number; to: number; name: string }[] = [];
  /** The named ages of this future, as a band of labels under the slider; click one to go there. */
  setAges(ages: { from: number; to: number; name: string }[]): void {
    this.ages = ages;
    const el = this.el.querySelector<HTMLElement>('.tl-ages')!;
    el.innerHTML = ages.map((a, i) => {
      const x0 = yearToPos(a.from), x1 = yearToPos(Math.min(a.to, HORIZON));
      return `<button type="button" data-age="${i}" style="left:${(x0 * 100).toFixed(2)}%;width:${((x1 - x0) * 100).toFixed(2)}%" title="${a.name.replace(/"/g, '&quot;')}, ${fmtYear(a.from)}–${fmtYear(Math.min(a.to, HORIZON))}">${a.name.replace(/^the /i, '').replace(/[&<>]/g, '')}</button>`;
    }).join('');
    this.fitAges();
    this.renderSub();
  }
  /** Label only the ages wide enough to read; the rest stay as hoverable, clickable spans. */
  private fitAges(): void {
    const el = this.el.querySelector<HTMLElement>('.tl-ages')!, W = el.clientWidth;
    for (const b of el.querySelectorAll<HTMLElement>('button')) b.classList.toggle('mute', (parseFloat(b.style.width) / 100) * W < 70);
  }
  private ageName(y: number): string {
    for (const a of this.ages) if (a.from <= y && y < a.to) return a.name;
    return '';
  }

  private eras: { years: number[]; era: (i: number) => number; n: number } | null = null;
  setData(frontier: number, eras: { years: number[]; era: (i: number) => number; n: number }): void {
    this.frontier = frontier;
    this.eras = eras;
    this.progressEl.style.width = `${yearToPos(frontier) * 100}%`;
    this.progressEl.hidden = frontier >= HORIZON;
    this.drawBand();
  }

  private drawBand(): void {
    const c = this.band, dpr = Math.min(window.devicePixelRatio, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const e = this.eras;
    if (e) {
      g.globalAlpha = 0.75;
      for (const r of eraRuns(e.years, e.n, e.era, W)) {
        g.fillStyle = ERA_COLORS[r.e];
        g.fillRect(r.x0, 0, Math.max(0.6, r.x1 - r.x0), H);
      }
      g.globalAlpha = 1;
    }
    // not yet simulated
    const fx = yearToPos(this.frontier) * W;
    g.fillStyle = 'rgba(242,242,242,0.06)';
    g.fillRect(fx, 0, W - fx, H);
  }
}

export function eraLegend(): string {
  return ERAS.map((n, i) => `<span class="era-key"><i style="background:${ERA_COLORS[i]}"></i>${n}</span>`).join('');
}
