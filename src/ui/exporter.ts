// Getting numbers out: CSV and JSON text, copied to the clipboard. Downloads
// are blocked in the artifact sandbox, and so is the clipboard sometimes, so
// the fallback is a sheet with the text already selected.

/** Provenance lines that head every export (build, rules, future, year). */
let headerFn: () => string[] = () => [];
export function setExportHeader(fn: () => string[]): void { headerFn = fn; }
export function exportHeader(): string[] { return headerFn(); }

const csvCell = (v: unknown): string => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with the provenance as leading `#` comment lines. */
export function toCsv(columns: string[], rows: unknown[][], title = ''): string {
  const head = [...(title ? [title] : []), ...exportHeader()].map((l) => `# ${l}`);
  return [...head, columns.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}

export function toJson(body: Record<string, unknown>, title = ''): string {
  return JSON.stringify({ meta: { title, provenance: exportHeader() }, ...body }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));
}

let sheet: HTMLElement | null = null;
function fallback(text: string, what: string): void {
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.className = 'copy-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = `<p><span class="copy-what"></span> The browser would not let this page use the clipboard, so the text is selected below: press <kbd>⌘C</kbd> or <kbd>Ctrl+C</kbd>.</p><textarea readonly spellcheck="false" aria-label="Exported text"></textarea><p><button class="link" type="button">Close</button></p>`;
    sheet.querySelector('button')!.addEventListener('click', () => { sheet!.hidden = true; });
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet!.hidden = true; });
    document.getElementById('app')!.append(sheet);
  }
  sheet.hidden = false;
  sheet.querySelector('.copy-what')!.textContent = what;
  const ta = sheet.querySelector('textarea')!;
  ta.value = text;
  ta.focus();
  ta.select();
}

/** Copy to the clipboard; say so on `status`. Falls back to a select-all sheet. */
export async function copyText(text: string, what: string, status?: HTMLElement | null): Promise<void> {
  const kb = (text.length / 1024).toFixed(text.length < 10240 ? 1 : 0);
  try {
    if (!navigator.clipboard || !document.hasFocus()) throw new Error('no clipboard');
    // a sandboxed frame can leave the promise hanging, so give up after a moment
    await Promise.race([navigator.clipboard.writeText(text), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 1500))]);
    if (status) { status.textContent = `${what} copied (${kb} KB).`; }
  } catch {
    fallback(text, `${what} (${kb} KB).`);
    if (status) status.textContent = '';
  }
}
