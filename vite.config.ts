import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The reproducibility stamp baked into the page: which commit built it, a hash
// of everything that decides what a future number unfolds into (the catalog,
// the world and the engine's rules), and when the forecaster was trained.
function stamp() {
  const git = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const sha = git('git rev-parse --short HEAD') || 'unknown';
  const dirty = git('git status --porcelain --untracked-files=no -- src') !== '';
  const RULES = ['catalog', 'engine', 'world', 'rng', 'metrics', 'demography', 'ledger', 'invent', 'ages', 'civ', 'polity', 'diffusion'].map((f) => `src/sim/${f}.ts`);
  const h = createHash('sha256');
  // the war minds decide wars, so they are rules too
  RULES.push('src/sim/warMind.ts', 'src/ml/netMind.ts', 'src/ml/warNet.ts', 'src/ml/warWeights.ts');
  for (const f of RULES) { try { h.update(readFileSync(f)); } catch { h.update(f); } }
  let trainedAt = '';
  try { trainedAt = /"trainedAt":"([^"]+)"/.exec(readFileSync('src/ml/weights.ts', 'utf8'))?.[1] ?? ''; } catch { /* no weights */ }
  return { sha: dirty ? `${sha}+` : sha, rules: h.digest('hex').slice(0, 8), trainedAt, built: new Date().toISOString().slice(0, 10) };
}

// Single-file build: the deploy target is one self-contained HTML page.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.ELEVENLABS_API_KEY;
  return {
    plugins: [viteSingleFile()],
    // __ELEVEN_PROXY__: whether the dev proxy holds a key; the key itself stays here
    define: { __BUILD__: JSON.stringify(stamp()), __ELEVEN_PROXY__: JSON.stringify(!!key) },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4000,
    },
    server: {
      // ElevenLabs goes through the dev server so the API key stays out of the page
      proxy: {
        '/eleven': {
          target: 'https://api.elevenlabs.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/eleven/, ''),
          headers: key ? { 'xi-api-key': key } : {},
        },
      },
    },
  };
});
