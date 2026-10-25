import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { openaiDev } from './scripts/openaiDev.ts';

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
  // so do transport prices, the seeded Sun, the fleet, the impact physics and the observed data the engine reads
  RULES.push('src/sim/launchEconomics.ts', 'src/orbit/spaceWeather.ts', 'src/orbit/shells.ts', 'src/orbit/decay.ts', 'src/orbit/thermosphere.ts', 'src/orbit/thermosphereFit.ts', 'src/orbit/classes.ts',
    'src/impact/bodies.ts', 'src/impact/flux.ts', 'src/impact/entry.ts', 'src/impact/crater.ts', 'src/impact/effects.ts', 'src/impact/exposure.ts', 'src/impact/scenario.ts', 'src/impact/defense.ts', 'src/impact/engineImpacts.ts',
    'src/data/snapshots/spaceweather.json', 'src/data/snapshots/sentry.json');
  for (const f of RULES) { try { h.update(readFileSync(f)); } catch { h.update(f); } }
  let trainedAt = '';
  try { trainedAt = /"trainedAt":"([^"]+)"/.exec(readFileSync('src/ml/weights.ts', 'utf8'))?.[1] ?? ''; } catch { /* no weights */ }
  return { sha: dirty ? `${sha}+` : sha, rules: h.digest('hex').slice(0, 8), trainedAt, built: new Date().toISOString().slice(0, 10) };
}

// Single-file build: the deploy target is one self-contained HTML page.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.ELEVENLABS_API_KEY;
  // the GPT assistant's key stays in the dev server (scripts/openaiDev.ts): never VITE_-prefixed, never in the page
  return {
    plugins: [viteSingleFile(), openaiDev(env.OPENAI_API_KEY)],
    define: { __BUILD__: JSON.stringify(stamp()) },
    worker: { format: 'es' },
    // satellite.js ships a top-level await, which the dev pre-bundle's default target rejects
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
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
