// The inspector's "explain" card: what a thing is, its facts with their
// provenance, and why it matters to the people of this future.

import type { Seg } from '../sim/chronicle.ts';
import type { Explanation, Tag } from './registry.ts';
import type { World } from '../sim/world.ts';
import { an, colourWord, fmtYears, galLB, galToEq, fmtRa, fmtDec, habZone, lifetime, mainSequence, num, sig, specNum } from './astro.ts';
import { LOCAL_GROUP } from './universe.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const TAG_TITLE: Record<Tag, string> = { R: 'real data', E: 'estimate from real data', P: 'procedural: drawn by this future\'s generator' };
const tag = (t: Tag) => `<abbr class="ex-tag ex-${t}" title="${TAG_TITLE[t]}">${t}</abbr>`;

export function explainHtml(e: Explanation, segs: (s: Seg[]) => string): string {
  const facts = e.facts.map((f) => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}${tag(f.t)}</dd>`).join('');
  const links = e.links?.length ? `<p class="act">${e.links.map((l) => `<button class="link" data-act="${l.act}" data-id="${l.id}" type="button">${esc(l.label)}</button>`).join(' · ')}</p>` : '';
  return `<article class="ex-card">
    <p class="eyebrow muted">${esc(e.eyebrow)}</p>
    <h2>${esc(e.title)}</h2>
    <p class="lede">${esc(e.lede)}</p>
    ${links}
    <dl class="kv ex-facts">${facts}</dl>
    ${e.story ? `<p class="ex-story">${segs(e.story)}</p>` : e.pending ? '<p class="muted ex-story">Reading the record…</p>' : ''}
    ${e.why ? `<p class="ex-why">${esc(e.why)}</p>` : ''}
    <p class="ex-key muted">${(['R', 'E', 'P'] as Tag[]).map((t) => `${tag(t)} ${TAG_TITLE[t].split(':')[0]}`).join('<span aria-hidden="true"> · </span>')}</p>
  </article>`;
}

/** Real facts for a Local Group galaxy, for the inspector's galaxy page. */
export function galaxyFactsHtml(name: string): string {
  const g = LOCAL_GROUP[name];
  if (!g) return '';
  return `<p class="lede">${esc(g.lede)}</p><dl class="kv ex-facts">${g.facts.map((f) => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}${tag(f.t)}</dd>`).join('')}</dl><p class="ex-why">${esc(g.why)}</p>`;
}

/** The star at the heart of a sim system, with provenance: real catalogue values or the generator's, and what follows from them. */
export function starFactsHtml(world: World, id: number): string {
  const sys = world.systems[id];
  const ms = mainSequence(specNum(sys.spec));
  const T: Tag = sys.real ? 'R' : 'P';
  const [h0, h1] = habZone(sys.lum);
  const life = lifetime(ms.mass, sys.lum);
  const facts: [string, string, Tag][] = [
    ['Type', `${sys.spec} V, ${colourWord(specNum(sys.spec), 'V')}`, T],
    ['Luminosity', `${sig(sys.lum)} L☉`, T],
    ['Surface temperature', `${num(Math.round(ms.teff / 10) * 10)} K`, 'E'],
    ['Mass', `${ms.mass.toPrecision(2)} M☉`, 'E'],
    ['Habitable zone', `${h0.toPrecision(2)}–${h1.toPrecision(2)} AU`, 'E'],
    ['Lifetime on the main sequence', fmtYears(life), 'E'],
  ];
  if (id !== 0) {
    const lb = galLB(sys.x, sys.y, sys.z), eq = galToEq(sys.x, sys.y, sys.z);
    facts.push(['Galactic l, b', `${lb.l.toFixed(1)}°, ${lb.b >= 0 ? '+' : '−'}${Math.abs(lb.b).toFixed(1)}°`, T]);
    facts.push(['Right ascension, declination', `${fmtRa(eq.ra)}, ${fmtDec(eq.dec)}`, T]);
  }
  const kind = specNum(sys.spec) >= 60 ? 'red dwarf' : specNum(sys.spec) >= 50 ? 'orange dwarf' : specNum(sys.spec) >= 40 ? 'Sun-like star' : 'hot, bright star';
  return `<h3>The star</h3><p class="lede">${esc(`${an(kind)[0].toUpperCase()}${an(kind).slice(1)}${sys.real ? ' from the real star catalogues' : ', drawn by this future\'s generator where the catalogues run out'}.`)}</p>
    <dl class="kv ex-facts">${facts.map(([k, v, t]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${tag(t)}</dd>`).join('')}</dl>`;
}
