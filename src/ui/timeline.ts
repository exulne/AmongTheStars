// The time slider: years 0 to 10,000 after the Mars landing, on a warped axis
// so the first centuries get room. Era band and simulated frontier underneath.

import { ERAS } from '../sim/catalog.ts';
import { ERA_COLORS, HORIZON, posToYear, yearToPos } from './charts.ts';
import { fmtYear } from './format.ts';

export class Timeline {
  el: HTMLElement;
  private input: HTMLInputElement;
  private band: HTMLCanvasElement;
  private yearEl: HTMLElement;
  private subEl: HTMLElement;
  private playBtn: HTMLButtonElement;
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
        <div class="tl-year"><span class="tl-big num">2040</span><span class="tl-sub"></span></div>
      </div>
      <div class="tl-track">
        <canvas class="tl-band" aria-hidden="true"></canvas>
        <input id="timeline-year" type="range" min="0" max="10000" step="1" value="0" aria-label="Year">
        <div class="tl-ticks" aria-hidden="true"></div>
      </div>`;
    this.input = this.el.querySelector('input')!;
    this.band = this.el.querySelector('canvas')!;
    this.yearEl = this.el.querySelector('.tl-big')!;
    this.subEl = this.el.querySelector('.tl-sub')!;
    this.playBtn = this.el.querySelector('.tl-play')!;
    const ticks = this.el.querySelector('.tl-ticks')!;
    for (const y of [0, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
      const t = document.createElement('span');
      t.style.left = `${yearToPos(y) * 100}%`;
      t.textContent = fmtYear(y);
      if (y === 10 || y === 2500) t.className = 'minor';
      ticks.append(t);
    }
    this.input.addEventListener('input', () => {
      this.set(Math.round(posToYear(Number(this.input.value) / 10000)), true);
    });
    this.playBtn.addEventListener('click', () => this.toggle());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * (this.year < 200 ? 1 : this.year < 1000 ? 4 : 10) * (e.shiftKey ? 10 : 1);
        this.set(this.year + d, true);
      }
    });
    new ResizeObserver(() => this.drawBand()).observe(this.band);
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
    const p = yearToPos(this.year) + dt / 90;
    const y = posToYear(p);
    if (y >= this.frontier) { this.set(this.frontier, true); if (this.frontier >= HORIZON) this.toggle(); return; }
    this.set(Math.max(this.year + (this.year < 200 ? 0.25 : 0), y), true);
  }

  set(year: number, emit = false): void {
    year = Math.max(0, Math.min(year, this.frontier, HORIZON));
    this.year = year;
    this.input.value = String(Math.round(yearToPos(year) * 10000));
    this.yearEl.textContent = fmtYear(year);
    this.renderSub();
    if (emit) this.onChange(year);
  }

  private eraName = '';
  setEra(name: string): void { this.eraName = name; this.renderSub(); }
  private renderSub(): void {
    this.subEl.textContent = `year ${Math.round(this.year).toLocaleString('en-US')} after Mars${this.eraName ? ` · ${this.eraName}` : ''}`;
  }

  private eras: { years: number[]; era: (i: number) => number; n: number } | null = null;
  setData(frontier: number, eras: { years: number[]; era: (i: number) => number; n: number }): void {
    this.frontier = frontier;
    this.eras = eras;
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
      for (let i = 0; i < e.n - 1; i++) {
        const x0 = yearToPos(e.years[i]) * W, x1 = yearToPos(e.years[i + 1]) * W;
        g.fillStyle = ERA_COLORS[e.era(i)];
        g.globalAlpha = 0.75;
        g.fillRect(x0, 0, Math.max(0.6, x1 - x0), H);
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
