// Residents and biographies in the inspector. Everyone shown is a persistent
// person from the demography model: same identity at every year, real parents.

import type { Biography, PersonBrief } from '../sim/lives.ts';
import { fmtNum, fmtYear } from './format.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const yr = (y: number) => fmtYear(y);

export function personLink(p: PersonBrief | null, extra = ''): string {
  if (!p) return '<span class="muted">unknown</span>';
  return `<button class="link" data-act="open-person" data-pid="${p.id}" type="button">${esc(p.name)}</button>${extra}`;
}

function briefLine(p: PersonBrief, year: number): string {
  const life = year < p.born ? `born ${yr(p.born)}` : p.alive ? `${Math.floor(p.age)}` : `${yr(p.born)}–${yr(p.born + p.age)}`;
  return `${personLink(p)} <span class="muted">${life}${p.alive && year >= p.born ? `, ${esc(p.job)}` : ''}${p.place ? ` · ${esc(p.place)}` : ''}</span>`;
}

export function residentsHtml(r: { total: number; asOf: number; offset: number; people: PersonBrief[]; pyramid: { band: number; women: number; men: number }[] } | null, page: number, pages: number, year: number): string {
  if (!r) return '<p class="muted">Taking the census…</p>';
  const items = r.people.map((p, k) => `<li><span class="num muted">#${(r.offset + k + 1).toLocaleString('en-US')}</span> ${personLink(p)} <span class="muted">${Math.floor(p.age)}, ${esc(p.job)}</span></li>`).join('');
  return `${pyramidSvg(r.pyramid)}
    <p class="muted">${fmtNum(r.total)} people as of ${yr(r.asOf)}. Every one of them is a real person in this future, with parents, a past and an end.</p>
    <ol class="people">${items}</ol>
    <div class="pager"><button class="link" data-act="page" data-id="-1" type="button" ${page === 0 ? 'disabled' : ''}>Previous</button>
    <span class="num muted">page ${(page + 1).toLocaleString('en-US')} of ${pages.toLocaleString('en-US')}</span>
    <button class="link" data-act="page" data-id="1" type="button" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></div>
    <label class="jump">Find resident # <input id="person-jump" inputmode="numeric" placeholder="${fmtNum(Math.floor(r.total / 2))}"></label>`;
  void year;
}

/** Age × sex pyramid (10-year bands). */
function pyramidSvg(rows: { band: number; women: number; men: number }[]): string {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => Math.max(r.women, r.men)), 1);
  const top = Math.max(...rows.map((r) => r.band));
  const h = 4, H = (top + 1) * h;
  const bars = rows.map((r) => {
    const y = H - (r.band + 1) * h;
    const wW = (r.women / max) * 48, wM = (r.men / max) * 48;
    return `<rect x="${50 - wM}" y="${y}" width="${wM}" height="${h - 0.6}" class="py-m"/><rect x="50" y="${y}" width="${wW}" height="${h - 0.6}" class="py-f"/>`;
  }).join('');
  return `<figure class="pyramid"><svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="Age and sex of the population">${bars}</svg>
    <figcaption class="muted"><span>men</span><span>age, 10-year bands, oldest at top</span><span>women</span></figcaption></figure>`;
}

export function biographyHtml(b: Biography | null, year: number, loading: boolean): string {
  if (!b) return `<h2>${loading ? 'Finding them…' : 'Nobody by that identity'}</h2>`;
  const status = b.status === 'unborn' ? `Not yet born. Born ${yr(b.born)} on ${esc(b.bornAtName)}.`
    : b.status === 'dead' ? `Died ${yr(b.died!.year)}${b.died!.place ? ` on ${esc(b.died!.place)}` : ''}, aged ${Math.floor(b.died!.age)}: ${esc(b.died!.cause)}.`
    : b.status === 'travelling' ? `${Math.floor(b.age)}, between the stars.`
    : `${Math.floor(b.age)}, ${esc(b.job)}${b.where ? ` on ${esc(b.where.name)}` : ''}.`;
  const where = b.where && b.status !== 'unborn' && b.where.body < 1_000_000
    ? `<p class="act"><button class="link" data-act="goto-body" data-id="${b.where.body}" type="button">${b.status === 'dead' ? 'Go to where they died' : 'Go to where they live'}: ${esc(b.where.name)}</button></p>` : '';
  const story = b.story.filter((s) => s.year <= year || b.status === 'dead').map((s) => {
    const t = esc(s.text);
    const linked = s.link?.kind === 'person' ? `<button class="link" data-act="open-person" data-pid="${s.link.id}" type="button">${t}</button>` : t;
    return `<li><span class="num ev-year">${yr(s.year)}</span> ${linked}</li>`;
  }).join('');
  // people who only enter this life later are listed faintly, so a teenager's future family reads as future
  const later = (label: string, list: PersonBrief[], note: (p: PersonBrief, i: number) => string, future: (p: PersonBrief, i: number) => boolean) => list.length
    ? `<dt>${label}</dt><dd>${list.map((p, i) => `<span class="${future(p, i) ? 'future' : ''}">${briefLine(p, year)}${note(p, i)}</span>`).join('<br>')}</dd>` : '';
  const fam = (label: string, list: PersonBrief[], more = 0) => list.length ? `<dt>${label}</dt><dd>${list.map((p) => briefLine(p, year)).join('<br>')}${more > list.length ? `<br><span class="muted">and ${more - list.length} more</span>` : ''}</dd>` : '';
  const anc = b.ancestors.length
    ? `<ol class="lineage">${b.ancestors.slice(0, 12).map((a) => `<li><span class="muted num">${a.gen === 1 ? 'parent' : a.gen === 2 ? 'grandparent' : `${a.gen - 2}× great`}</span> ${briefLine(a.who, year)}</li>`).join('')}</ol>
      ${b.ancestors.length > 12 ? `<p class="muted">…the line goes back ${b.ancestors.length} generations, to ${personLink(b.ancestors[b.ancestors.length - 1].who)}, born ${yr(b.ancestors[b.ancestors.length - 1].who.born)}.</p>` : ''}`
    : '<p class="muted">No known parents: one of the people already on Earth at the Landing.</p>';
  const d = b.descendants;
  const blood = d.total
    ? `<p>${fmtNum(d.total)} descendant${d.total === 1 ? '' : 's'} over ${d.generations} generation${d.generations === 1 ? '' : 's'} by ${yr(year)}${d.total >= 1500 ? ' (counting stops at 1,500)' : ''}; ${fmtNum(d.alive)} alive.</p>
      ${d.places.length ? `<p class="muted">Living in ${d.places.map((p) => `<button class="link" data-act="goto-body" data-id="${p.body}" type="button">${esc(p.name)}</button> (${fmtNum(p.n)})`).join(', ')}.</p>` : ''}`
    : '<p class="muted">No descendants yet.</p>';
  const traits = ['Openness', 'Conscientiousness', 'Extraversion', 'Agreeableness', 'Steadiness'];
  return `
    <p class="eyebrow muted">Person · ${esc(b.id)}</p>
    <h2>${esc(b.name)}</h2>
    <p class="lede">${status}</p>
    ${where}
    ${b.status !== 'unborn' ? `<p class="act"><button class="link" data-act="look-closer" data-pid="${b.id}" type="button">Look closer: ${b.body === 'uploaded' ? 'the substrate their mind runs on' : 'their body'}, its cells, molecules and atoms</button></p>` : ''}
    <p class="muted">This person stays open as you move through time. Drag the slider to see them younger, older, or not yet born.</p>
    <h3>Life</h3><ol class="events story">${story || '<li class="muted">Nothing yet.</li>'}</ol>
    <h3>Family</h3>
    <dl class="family">
      <dt>Mother</dt><dd>${b.mother ? briefLine(b.mother, year) : '<span class="muted">unknown</span>'}</dd>
      <dt>Father</dt><dd>${b.father ? briefLine(b.father, year) : '<span class="muted">unknown</span>'}</dd>
      ${later('Partners', b.partners, (p, i) => (b.partnerSince?.[i] ?? -Infinity) > year ? ` <span class="muted">(together from about ${yr(b.partnerSince![i] - 1)})</span>` : '', (p, i) => (b.partnerSince?.[i] ?? -Infinity) > year)}
      ${later('Children', b.children, () => '', (p) => p.born > year)}
      ${fam('Siblings', b.siblings)}
    </dl>
    <h3>Ancestry</h3>${anc}
    <h3>Bloodline</h3>${blood}
    <h3>Body and character</h3>
    <dl class="kv">${b.body ? `<dt>Body</dt><dd>${esc(b.body)}</dd>` : ''}<dt>Height</dt><dd class="num">${b.height} cm</dd><dt>Born</dt><dd>${yr(b.born)}, ${esc(b.bornAtName)}</dd><dt>Generations on ${esc(b.bornAtName)}</dt><dd class="num">${b.generationsHere}</dd></dl>
    <div class="bars">${b.personality.map((v, k) => `<div class="bar"><span>${traits[k]}</span><i style="--v:${v}"></i></div>`).join('')}</div>`;
}
