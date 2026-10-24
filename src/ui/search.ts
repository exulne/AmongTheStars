// Find anything by name: a star system, a world, a galaxy, or "resident #N of <settlement>".

export interface Hit { kind: 'galaxy' | 'system' | 'body' | 'resident' | 'tech' | 'note'; id: number; name: string; sub: string; n?: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Search {
  el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private hits: Hit[] = [];
  private active = 0;
  onPick: (h: Hit) => void = () => {};

  constructor(private find: (q: string) => Hit[]) {
    this.el = document.createElement('div');
    this.el.className = 'search';
    this.el.innerHTML = `
      <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="Search stars, worlds, people"
        role="combobox" aria-label="Find a star, world or resident" aria-expanded="false" aria-controls="search-hits" aria-autocomplete="list">
      <ol id="search-hits" class="search-hits" role="listbox" hidden></ol>`;
    this.input = this.el.querySelector('input')!;
    this.list = this.el.querySelector('ol')!;
    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('focus', () => { if (this.input.value) this.update(); });
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.hits.length) return;
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.hits.length) % this.hits.length;
        this.paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.pick(this.active);
      } else if (e.key === 'Escape') {
        if (this.input.value) this.input.value = '';
        this.close();
        this.input.blur();
      }
    });
    this.list.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (li) { e.preventDefault(); this.pick(Number(li.dataset.i)); }
    });
  }

  /** Focus; with `seed`, start a fresh query with that character. */
  focus(seed?: string): void {
    this.input.focus();
    if (seed === undefined) { this.input.select(); return; }
    this.input.value = seed;
    this.update();
  }

  private update(): void {
    const q = this.input.value.trim();
    this.hits = q ? this.find(q) : [];
    this.active = 0;
    this.paint();
  }

  private paint(): void {
    const open = this.hits.length > 0 || this.input.value.trim().length > 1;
    this.list.hidden = !open;
    this.input.setAttribute('aria-expanded', String(open));
    this.list.innerHTML = this.hits.length
      ? this.hits.map((h, i) => `<li id="hit-${i}" role="option" data-i="${i}" aria-selected="${i === this.active}"><b>${esc(h.name)}</b><span>${esc(h.sub)}</span></li>`).join('')
      : '<li class="none">Nothing by that name.</li>';
    if (this.hits.length) this.input.setAttribute('aria-activedescendant', `hit-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private pick(i: number): void {
    const h = this.hits[i];
    if (!h) return;
    this.close();
    this.input.blur();
    this.onPick(h);
  }

  private close(): void {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
  }
}
