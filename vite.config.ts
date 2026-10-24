import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The reproducibility stamp baked into the page: which commit built it, a hash
// of everything that decides what a future number unfolds into (the catalog,
// the world and the engine's rules), and when the forecaster was trained.
function stamp() {
  const git = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const sha = git('git rev-parse --short HEAD') || 'unknown';
  const dirty = git('git status --porcelain --untracked-files=no -- src') !== '';
  const RULES = ['catalog', 'engine', 'world', 'rng', 'metrics', 'demography', 'ledger', 'invent'].map((f) => `src/sim/${f}.ts`);
  const h = createHash('sha256');
  for (const f of RULES) { try { h.update(readFileSync(f)); } catch { h.update(f); } }
  let trainedAt = '';
  try { trainedAt = /"trainedAt":"([^"]+)"/.exec(readFileSync('src/ml/weights.ts', 'utf8'))?.[1] ?? ''; } catch { /* no weights */ }
  return { sha: dirty ? `${sha}+` : sha, rules: h.digest('hex').slice(0, 8), trainedAt, built: new Date().toISOString().slice(0, 10) };
}

// Single-file build: the deploy target is one self-contained HTML page.
export default defineConfig({
  plugins: [viteSingleFile()],
  define: { __BUILD__: JSON.stringify(stamp()) },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
