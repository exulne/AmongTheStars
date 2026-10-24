// The reproducibility stamp: which build made this page, a hash of the rules
// that decide what a future number unfolds into, and when the forecaster was
// trained. It heads every export and rides in the URL, and a link made by a
// build with other rules says so when it is opened.

import { setExportHeader } from './exporter.ts';

declare const __BUILD__: { sha: string; rules: string; trainedAt: string; built: string } | undefined;

export const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : { sha: 'dev', rules: '00000000', trainedAt: '', built: '' };

/** The URL part: r<sha>.<rules> (a trailing x on the sha: built from uncommitted changes). */
export const STAMP_CODE = `r${BUILD.sha.replace('+', 'x')}.${BUILD.rules}`;

/** What the link this page was opened with says about its build, read before the app rewrites the hash. */
const fromLink = /(?:^|-)r([0-9a-z]+)\.([0-9a-f]{8})(?=-|$)/.exec(location.hash.slice(1));
export const LINK_STAMP = fromLink ? { sha: fromLink[1].replace(/x$/, '+'), rules: fromLink[2] } : null;

export function stampLine(): string {
  return `2SOON2026 build ${BUILD.sha} · rules ${BUILD.rules}${BUILD.trainedAt ? ` · forecaster trained ${BUILD.trainedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${BUILD.built ? ` · built ${BUILD.built}` : ''}`;
}

export interface StampOpts { app: HTMLElement; seed: () => number; year: () => number }

/** Provenance on every export, and a warning when the link came from another build. */
export function installStamp(o: StampOpts): void {
  setExportHeader(() => {
    let link = '';
    try { link = location.href; } catch { /* sandboxed */ }
    return [stampLine(), `future #${o.seed()} · viewed at year ${Math.round(2040 + o.year())}`, ...(link ? [`link: ${link}`] : [])];
  });
  const s = LINK_STAMP;
  if (!s || (s.sha === BUILD.sha && s.rules === BUILD.rules)) return;
  const same = s.rules === BUILD.rules;
  const note = document.createElement('div');
  note.className = 'stamp-warn';
  note.setAttribute('role', 'status');
  note.innerHTML = `<p>${same
    ? `This link was made by build ${esc(s.sha)}; this is build ${esc(BUILD.sha)}. The rules hash is the same (${BUILD.rules}), so future #${o.seed()} should unfold exactly as it did.`
    : `This link was made by build ${esc(s.sha)} with rules ${esc(s.rules)}; this page runs rules ${BUILD.rules}. Future #${o.seed()} may unfold differently here, so numbers from that link need not match.`}
    <button class="link" type="button">Dismiss</button></p>`;
  note.querySelector('button')!.addEventListener('click', () => note.remove());
  o.app.append(note);
  if (same) setTimeout(() => note.remove(), 9000);
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
