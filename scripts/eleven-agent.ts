// Create or update the "2SOON2026 Oracle" ElevenLabs Conversational AI agent —
// prompt, voice, PCM audio formats — and its two client tools, all from
// src/ship/agentSpec.ts so the page (src/ship/agent.ts) and this never drift.
// Prints the agent id to put in .env.local as VITE_ELEVEN_AGENT_ID.
//   ELEVENLABS_API_KEY=sk_… node scripts/eleven-agent.ts [agent_id]
// REAL SIDE EFFECTS: every run writes to your ElevenLabs workspace.

import { readFileSync } from 'node:fs';
import { AGENT_FIRST_MESSAGE, AGENT_LLM, AGENT_NAME, AGENT_PROMPT, AGENT_TOOLS, AGENT_TTS_MODEL, AGENT_VOICE } from '../src/ship/agentSpec.ts';

const BASE = 'https://api.elevenlabs.io';

/** KEY=VALUE lines of .env.local in the cwd (quotes optional, # comments ignored). */
function dotenv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*"?([^"\n]*)"?/.exec(line);
      if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch { /* no .env.local */ }
  return env;
}

const env = dotenv();
const key = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('No ElevenLabs key.\n  export ELEVENLABS_API_KEY=sk_…        # or\n  echo "ELEVENLABS_API_KEY=sk_…" >> .env.local');
  process.exit(1);
}
let agentId = process.argv[2] || process.env.ELEVEN_AGENT_ID || process.env.VITE_ELEVEN_AGENT_ID || env.ELEVEN_AGENT_ID || env.VITE_ELEVEN_AGENT_ID || '';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'xi-api-key': key!, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`${method} ${path} -> ${r.status}\n${(await r.text()).slice(0, 2000)}`);
    process.exit(1);
  }
  return r.json();
}

// upsert the client tools by name (their tool_config.name must match the page's handlers)
const existing: { id: string; tool_config?: { name?: string } }[] = [];
for (let cursor: string | null = ''; cursor !== null;) {
  const page = await api('GET', `/v1/convai/tools?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  existing.push(...(page.tools ?? []));
  cursor = page.has_more ? (page.next_cursor ?? null) : null;
}
const toolIds: string[] = [];
for (const tool_config of AGENT_TOOLS) {
  const have = existing.filter((t) => t.tool_config?.name === tool_config.name);
  if (have.length) {
    for (const t of have) await api('PATCH', `/v1/convai/tools/${t.id}`, { tool_config });
    toolIds.push(have[0].id);
    console.log(`tool ${tool_config.name}: updated ${have.map((t) => t.id).join(', ')}`);
  } else {
    const made = await api('POST', '/v1/convai/tools', { tool_config });
    toolIds.push(made.id);
    console.log(`tool ${tool_config.name}: created ${made.id}`);
  }
}

const body = {
  name: AGENT_NAME,
  conversation_config: {
    agent: { first_message: AGENT_FIRST_MESSAGE, language: 'en', prompt: { prompt: AGENT_PROMPT, llm: AGENT_LLM, tool_ids: toolIds } },
    tts: { voice_id: AGENT_VOICE, model_id: AGENT_TTS_MODEL, agent_output_audio_format: 'pcm_16000' },
    asr: { user_input_audio_format: 'pcm_16000' },
  },
};

if (agentId) {
  const r = await api('PATCH', `/v1/convai/agents/${agentId}`, body);
  agentId = r.agent_id ?? agentId;
  console.log(`updated agent ${agentId}`);
} else {
  const r = await api('POST', '/v1/convai/agents/create', body);
  agentId = r.agent_id;
  console.log(`created agent ${agentId}`);
}
console.log(`\nPut this in .env.local, then restart the dev server:\nVITE_ELEVEN_AGENT_ID=${agentId}`);
