// The inspector's "explain" card: what a thing is, its facts with their
// provenance, and why it matters to the people of this future.

import type { Seg } from '../sim/chronicle.ts';
import type { Explanation, Tag } from './registry.ts';
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
