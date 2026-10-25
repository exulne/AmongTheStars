// The named things of a future (ages, peoples, wars, faiths) as the inspector
// shows them. The worker's Chronicle names and dates them once the run is
// done; everything here is a view of that record at the year on the slider,
// with what is still to come shown faintly so the whole arc is readable.

import type { Annals } from '../sim/chronicle.ts';
import type { World } from '../sim/world.ts';
import { fmtNum, fmtYear } from './format.ts';

type Polity = Annals['polities'][number];
type War = Annals['wars'][number];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const standing = (p: Polity, y: number) => p.founded <= y && (p.ended === null || p.ended > y);
const ongoing = (w: War, y: number) => w.start <= y && (w.outcome === 'ongoing' || w.end > y);
const faithLive = (f: Annals['faiths'][number], y: number) => f.founded <= y && (f.ended === null || f.ended > y);

/** The polity that held faction f (its capital) in a year, or null. */
export function polityAt(A: Annals, f: number, year: number): Polity | null {
  let best: Polity | null = null;
  for (const p of A.polities) if (p.capital === f && p.founded <= year && (p.ended === null || p.ended >= year)) best = p;
  return best;
}

/** The age a year falls in. */
export function ageAt(A: Annals, year: number): Annals['ages'][number] | null {
  for (const a of A.ages) if (a.from <= year && year < a.to) return a;
  return A.ages.length && year >= A.ages[A.ages.length - 1].from ? A.ages[A.ages.length - 1] : null;
}

/** The regime a polity had in a year: its last recorded change, or what it was founded as. */
function regimeAt(p: Polity, y: number): string {
  let r: string | null = null;
  for (const c of p.regimes) if (c.year <= y) r = c.regime;
  return r ?? p.regime;
}

export const polityLink = (A: Annals, id: number, upper = false) => {
  const p = A.polities[id];
  return p ? `<button class="link" data-act="polity" data-id="${id}" type="button">${esc(upper ? cap(p.name) : p.name)}</button>` : 'unaligned worlds';
};
const bodyLink = (w: World, b: number, name: (b: number) => string) =>
  w.bodies[b] ? `<button class="link" data-act="body" data-id="${b}" type="button">${esc(name(b))}</button>` : '';

const span = (a: number, b: number | null) => `${fmtYear(a)}–${b === null ? '' : fmtYear(b)}`;

function warLine(A: Annals, w: War, y: number): string {
  const later = w.start > y;
  const won = w.winner < 0 ? '' : w.winner === w.a ? w.polityA : w.polityB;
  const result = ongoing(w, y) ? 'still being fought' : `${w.outcome}${typeof won === 'number' && won >= 0 ? `, won by ${polityLink(A, won)}` : ''}`;
  return `<li class="${later ? 'future' : ''}"><button class="link num ev-year" data-act="year" data-id="${w.start}" type="button">${span(w.start, w.outcome === 'ongoing' ? null : w.end)}</button> <span class="ev-name">${esc(cap(w.name))}</span>
    <span class="muted">${polityLink(A, w.polityA, true)} against ${polityLink(A, w.polityB)}, over ${esc(w.cause)}; ${result}${w.killed >= 1 ? `; ${fmtNum(w.killed)} dead` : ''}${w.kinetic ? '; fought with kinetic strikes' : ''}${later ? ' (later)' : ''}</span></li>`;
}

/** Peoples, wars and faiths of humanity at year y, for the global inspector. */
export function humanityAnnalsHtml(A: Annals, w: World, y: number, name: (b: number) => string): string {
  const pols = A.polities.filter((p) => standing(p, y)).sort((a, b) => b.peakPop - a.peakPop);
  const fallen = A.polities.filter((p) => p.ended !== null && p.ended <= y).length;
  const peoples = pols.slice(0, 8).map((p) => `<li>${polityLink(A, p.id, true)} <span class="muted">${esc(regimeAt(p, y).toLowerCase())}, from ${bodyLink(w, p.capital, name)}, since ${fmtYear(p.founded)}</span></li>`).join('');
  const now = A.wars.filter((x) => ongoing(x, y));
  const past = A.wars.filter((x) => !ongoing(x, y) && x.start <= y).sort((a, b) => b.end - a.end).slice(0, Math.max(0, 6 - now.length));
  const faiths = A.faiths.filter((f) => faithLive(f, y)).sort((a, b) => b.peakWorlds - a.peakWorlds).slice(0, 6);
  return `<h3>Peoples <span class="muted num">${pols.length} standing${fallen ? `, ${fallen} fallen` : ''}</span></h3>
    ${peoples ? `<ul class="annals">${peoples}</ul>${pols.length > 8 ? `<p class="muted">and ${pols.length - 8} more</p>` : ''}` : '<p class="muted">One people, still governed from Earth.</p>'}
    <h3>Wars <span class="muted num">${now.length} now, ${A.wars.filter((x) => x.start <= y).length} so far</span></h3>
    ${now.length || past.length ? `<ol class="events annals">${[...now, ...past].map((x) => warLine(A, x, y)).join('')}</ol>` : '<p class="muted">No war yet.</p>'}
    <h3>Faiths</h3>
    ${faiths.length ? `<ul class="annals">${faiths.map((f) => `<li><span class="ev-name">${esc(cap(f.name))}</span> <span class="muted">born on ${bodyLink(w, f.home, name)} in ${fmtYear(f.founded)}. ${esc(f.tenets)}</span></li>`).join('')}</ul>` : '<p class="muted">No new faith yet: the old religions of Earth.</p>'}
    ${natureHtml(A, w, y, name)}`;
}

/** The worlds' own upheavals so far: long winters, great impacts, a sunshade, new seas (living worlds). */
function natureHtml(A: Annals, w: World, y: number, name: (b: number) => string): string {
  const past = (A.nature ?? []).filter((x) => x.year <= y);
  if (!past.length) return '';
  const recent = past.slice(-6).reverse();
  return `<h3>The worlds <span class="muted num">${past.length} upheaval${past.length === 1 ? '' : 's'} so far</span></h3>
    <ol class="events annals">${recent.map((x) => `<li><button class="link num ev-year" data-act="year" data-id="${x.year}" type="button">${fmtYear(x.year)}</button> ${x.body >= 0 && w.bodies[x.body] ? `${bodyLink(w, x.body, name)} ` : ''}<span class="muted">${esc(x.text)}</span></li>`).join('')}</ol>`;
}

const GRIEVANCE: Record<string, string> = {
  founded: 'It was there from the start.',
  'light-lag': 'It broke away because orders took years to arrive at the speed of light.',
  taxes: 'It broke away over what it was made to send home.',
  disorder: 'It rose out of disorder at home.',
  'founded beyond reach': 'Its founders settled too far away to be governed.',
  faith: 'It broke away over faith.',
  size: 'It grew too big to be anyone’s colony.',
  identity: 'Its people stopped feeling they belonged to anyone else.',
  restoration: 'It was restored after a fall.',
};

/** Everything the record holds about one polity, as of year y. */
export function polityCardHtml(A: Annals, id: number, w: World, y: number, name: (b: number) => string): string {
  const p = A.polities[id];
  if (!p) return '<p class="muted">No such polity.</p>';
  const status = p.founded > y ? `founded ${fmtYear(p.founded)}, ${Math.round(p.founded - y)} years from now` : p.ended !== null && p.ended <= y ? `fell in ${fmtYear(p.ended)}` : `standing, ${Math.round(y - p.founded)} years old`;
  const parent = p.from >= 0 && p.from !== p.capital ? polityAt(A, p.from, p.founded) : null;
  const regimes = p.regimes.length ? p.regimes : [{ year: p.founded, regime: p.regime }];
  const wars = A.wars.filter((x) => x.polityA === id || x.polityB === id).sort((a, b) => a.start - b.start);
  const heirs = A.polities.filter((q) => q.id !== id && q.from === p.capital && q.founded >= p.founded);
  return `<p class="eyebrow muted">Polity</p><h2>${esc(cap(p.name))}</h2>
    <p class="lede">Governed from ${bodyLink(w, p.capital, name)} since ${fmtYear(p.founded)}${parent ? `, when it left ${polityLink(A, parent.id)}` : ''}. ${GRIEVANCE[p.grievance] ?? ''}</p>
    <dl class="kv"><dt>Now</dt><dd>${esc(status)}</dd><dt>Government</dt><dd>${esc(regimeAt(p, y))}</dd><dt>Wars</dt><dd class="num">${p.wars}</dd><dt>Peak</dt><dd class="num">${fmtNum(p.peakPop)} people on ${fmtNum(p.peakWorlds)} world${p.peakWorlds === 1 ? '' : 's'}</dd><dt>Lasted</dt><dd class="num">${span(p.founded, p.ended)}${p.ended === null ? ' (still standing at the end of the record)' : ''}</dd></dl>
    <h3>Governments</h3><ol class="events">${regimes.map((r) => `<li class="${r.year > y ? 'future' : ''}"><button class="link num ev-year" data-act="year" data-id="${r.year}" type="button">${fmtYear(r.year)}</button> ${esc(r.regime)}</li>`).join('')}</ol>
    <h3>Wars</h3>${wars.length ? `<ol class="events annals">${wars.map((x) => warLine(A, x, y)).join('')}</ol>` : '<p class="muted">It never went to war.</p>'}
    ${heirs.length ? `<h3>Broke away from it</h3><ul class="annals">${heirs.map((q) => `<li class="${q.founded > y ? 'future' : ''}">${polityLink(A, q.id, true)} <span class="muted num">${fmtYear(q.founded)}</span></li>`).join('')}</ul>` : ''}
    <p class="muted">Faint lines are still to come at this year.</p>`;
}
