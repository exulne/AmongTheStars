// Dev-server routes for the GPT assistant (src/assistant). The OpenAI key is read
// here, server-side, from .env.local (OPENAI_API_KEY, never VITE_-prefixed) and
// is never sent to the page, logged, or written into the build:
//
//   GET  /openai/status     whether a key is configured, and which model and voice
//   POST /openai/session    mints a short-lived Realtime client secret (ek_…) the
//                           browser uses once to open its WebRTC call to OpenAI
//   POST /openai/responses  the text fallback: a pinned-model Responses API call
//
// Requests from other origins are refused (and the JSON content type forces a
// CORS preflight this server never grants), so another site open in the same
// browser can't spend the key.

import type { Plugin } from 'vite';

export const REALTIME_MODEL = 'gpt-realtime-2.1';
export const TEXT_MODEL = 'gpt-5.4-mini';
export const VOICE = 'marin';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const SECRET_TTL_S = 120; // the secret only has to last until the SDP exchange
const API = 'https://api.openai.com/v1';
const MAX_BODY = 512 * 1024;

type Req = { url?: string; method?: string; headers: Record<string, string | string[] | undefined>; on(ev: string, f: (x?: unknown) => void): void };
type Res = { statusCode: number; setHeader(k: string, v: string): void; end(s?: string): void };

function json(res: Res, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: Req): Promise<string> {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c) => { s += String(c); if (s.length > MAX_BODY) bad(new Error('too large')); });
    req.on('end', () => ok(s));
    req.on('error', (e) => bad(e));
  });
}

/** Same-origin only: a page on another site can't make the dev server spend the key. */
function sameOrigin(req: Req): boolean {
  const origin = req.headers.origin, host = req.headers.host;
  if (typeof origin !== 'string') return true; // curl, or a same-origin GET
  try { return new URL(origin).host === host; } catch { return false; }
}

/** OpenAI's error, without anything secret in it, as { error, code }. */
async function upstreamError(r: Response): Promise<{ error: string; code: string }> {
  const j = await r.json().catch(() => null) as { error?: { message?: string; code?: string; type?: string } } | null;
  const code = j?.error?.code ?? j?.error?.type ?? String(r.status);
  let msg = j?.error?.message ?? `OpenAI returned ${r.status}`;
  if (r.status === 401) msg = 'OpenAI rejected the API key in .env.local (OPENAI_API_KEY).';
  if (code === 'insufficient_quota') msg = 'OpenAI says the account is out of credits or over quota.';
  return { error: msg.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…'), code };
}

export function openaiDev(key: string | undefined): Plugin {
  const handle = async (req: Req, res: Res, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/openai/')) return next();
    if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are refused.', code: 'origin' });
    if (path === '/openai/status' && req.method === 'GET') return json(res, 200, { configured: !!key, model: REALTIME_MODEL, textModel: TEXT_MODEL, voice: VOICE });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only', code: 'method' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'JSON only', code: 'type' });
    if (!key) return json(res, 503, { error: 'No OpenAI key: add OPENAI_API_KEY to .env.local and restart the dev server.', code: 'nokey' });
    const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    try {
      if (path === '/openai/session') {
        await readBody(req);
        const r = await fetch(`${API}/realtime/client_secrets`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({
            expires_after: { anchor: 'created_at', seconds: SECRET_TTL_S },
            session: {
              type: 'realtime', model: REALTIME_MODEL, output_modalities: ['audio'], max_output_tokens: 1200,
              audio: {
                input: { transcription: { model: TRANSCRIBE_MODEL }, noise_reduction: { type: 'near_field' }, turn_detection: null },
                output: { voice: VOICE, speed: 1.05 },
              },
            },
          }),
        });
        if (!r.ok) return json(res, r.status === 401 ? 401 : r.status === 429 ? 429 : 502, await upstreamError(r));
        const j = await r.json() as { value: string; expires_at: number };
        console.log(`[openai] realtime session minted (${REALTIME_MODEL}, ${VOICE}), secret expires in ${SECRET_TTL_S}s`);
        return json(res, 200, { value: j.value, expires_at: j.expires_at, model: REALTIME_MODEL, voice: VOICE });
      }
      if (path === '/openai/responses') {
        const b = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
        // only the fields the assistant uses; the model and limits are pinned here
        const body = {
          model: TEXT_MODEL, instructions: b.instructions, input: b.input, tools: b.tools, previous_response_id: b.previous_response_id,
          max_output_tokens: 1500, reasoning: { effort: 'low' }, parallel_tool_calls: true, store: true,
        };
        const r = await fetch(`${API}/responses`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
        if (!r.ok) return json(res, r.status === 401 ? 401 : r.status === 429 ? 429 : r.status === 400 ? 400 : 502, await upstreamError(r));
        return json(res, 200, await r.json());
      }
      return json(res, 404, { error: 'Unknown route', code: 'route' });
    } catch (e) {
      return json(res, 502, { error: `Could not reach OpenAI: ${(e as Error).message}`, code: 'network' });
    }
  };
  return {
    name: 'openai-dev',
    configureServer(s) { s.middlewares.use((req, res, next) => { void handle(req as unknown as Req, res as unknown as Res, next); }); },
    configurePreviewServer(s) { s.middlewares.use((req, res, next) => { void handle(req as unknown as Req, res as unknown as Res, next); }); },
  };
}
