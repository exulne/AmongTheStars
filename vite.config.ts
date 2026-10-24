import { defineConfig, loadEnv } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the deploy target is one self-contained HTML page.
// ENTRY=ship builds the starship game (ship.html) instead of the sim (index.html).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.ELEVENLABS_API_KEY;
  return {
    plugins: [viteSingleFile()],
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4000,
      rollupOptions: { input: process.env.ENTRY === 'ship' ? 'ship.html' : 'index.html' },
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
