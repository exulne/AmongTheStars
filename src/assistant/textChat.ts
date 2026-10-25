// Typed questions without a voice line: the Responses API through the dev
// server's proxy (POST /openai/responses), which adds the key server-side and
// pins the model. The tool loop runs here in the page, against the same tools.

import { SessionError, errorText } from './realtime.ts';
import type { ToolDef } from './tools.ts';

interface OutItem { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }

const FORGET_MS = 20 * 60 * 1000; // a stale thread starts afresh

export class TextChat {
  private prev: string | null = null;
  private at = 0;
  model = '';

  reset(): void { this.prev = null; }

  async ask(text: string, instructions: string, tools: ToolDef[], run: (name: string, args: Record<string, unknown>) => Promise<unknown>, signal?: AbortSignal): Promise<string> {
    if (Date.now() - this.at > FORGET_MS) this.prev = null;
    let input: unknown[] = [{ role: 'user', content: text }];
    const defs = tools.map((t) => ({ type: 'function', strict: false, ...t }));
    for (let round = 0; round < 6; round++) {
      const r = await this.post({ instructions, input, tools: defs, previous_response_id: this.prev ?? undefined }, signal);
      this.prev = r.id; this.at = Date.now();
      if (r.model) this.model = r.model;
      const out: OutItem[] = r.output ?? [];
      const calls = out.filter((o) => o.type === 'function_call');
      if (!calls.length) {
        const said = out.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('').trim();
        return said || '(no answer)';
      }
      const results = await Promise.all(calls.map((c) => { let a = {}; try { a = JSON.parse(c.arguments || '{}'); } catch { /* empty */ } return run(c.name!, a); }));
      input = calls.map((c, i) => ({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(results[i] ?? null) }));
    }
    return 'That took too many lookups; try asking more narrowly.';
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ id: string; model?: string; output?: OutItem[] }> {
    let r: Response;
    try {
      r = await fetch('/openai/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new SessionError('The assistant needs the local dev server (npm run dev).', 'noserver');
    }
    const j = await r.json().catch(() => null) as { error?: string | { code?: string; message?: string }; code?: string; id?: string } | null;
    if (!r.ok || !j?.id) {
      // a stale thread id (expired, or from another key) starts a new thread once
      const err = typeof j?.error === 'object' ? j.error : { code: j?.code, message: j?.error };
      if (this.prev && /previous_response/i.test(err?.message ?? '')) { this.prev = null; return this.post({ ...body, previous_response_id: undefined }, signal); }
      throw new SessionError(errorText(err?.code, err?.message ?? `Request failed (${r.status}).`), err?.code ?? (r.status === 404 ? 'noserver' : 'error'));
    }
    return j as { id: string; model?: string; output?: OutItem[] };
  }
}
