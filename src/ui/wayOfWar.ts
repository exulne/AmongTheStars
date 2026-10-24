// "The way of war" under the legend: who decides war in this future (the
// generation of trained war minds fighting now, or the old dice), and how the
// last five centuries of war compare with the five before.

import type { WarSpan, WayOfWar } from '../sim/worker.ts';
import { fmtNum } from './format.ts';

const pct = (a: number, n: number) => (n ? `${Math.round((100 * a) / n)}%` : '—');

/** ▲/▼ when a count moved by more than a fifth, else nothing. */
function trend(now: number, before: number): string {
  if (before === 0) return now > 0 ? ' <span class="up" title="none in the span before">▲</span>' : '';
  const r = now / before;
  return r > 1.2 ? ` <span class="up" title="${fmtNum(before)} in the span before">▲</span>` : r < 0.8 ? ` <span class="down" title="${fmtNum(before)} in the span before">▼</span>` : '';
}

function line(s: WarSpan, b: WarSpan): string {
  if (!s.wars) return 'No wars began in the last five centuries.';
  const settled = s.annex + s.rep + s.peace;
  const perWar = s.killed / s.wars, perWarB = b.wars ? b.killed / b.wars : 0;
  return [
    `<b class="num">${s.wars}</b> wars in ${Math.round(s.years)} years${trend(s.wars, b.wars)}`,
    settled ? `${pct(s.annex, settled)} ended in annexation${trend(s.annex / settled, b.annex / Math.max(1, b.annex + b.rep + b.peace))}` : '',
    `<span class="num">${fmtNum(perWar)}</span> dead a war${trend(perWar, perWarB)}`,
    s.kinetic ? `${s.kinetic} kinetic` : '',
  ].filter(Boolean).join(' · ');
}

export function wayOfWarHtml(w: WayOfWar): string {
  const who = w.gens
    ? `War minds, generation <b class="num">${w.gen + 1}</b> of ${w.gens}`
    : 'War by the old odds';
  const title = w.gens
    ? `Polities here decide war with a network trained on thousands of futures; each later age fights with a later, more practised generation (doctrine: ${w.run || 'realpolitik'}).`
    : 'No trained war minds are loaded; wars start and end by the hand-written odds.';
  return `<div class="war-who" title="${title}">${who}</div><div class="war-line">${line(w.now, w.before)}</div>`;
}
