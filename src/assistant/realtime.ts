// A speech-to-speech session with the OpenAI Realtime API over WebRTC.
//
// The API key never reaches the page: the dev server mints a short-lived client
// secret (POST /openai/session, see scripts/openaiDev.ts), and the browser uses
// that secret once, to exchange SDP with api.openai.com. Audio then flows both
// ways on the peer connection; events (tool calls, transcripts) on the
// "oai-events" data channel.

import type { ToolDef } from './tools.ts';

export type VoiceState = 'off' | 'connecting' | 'live';
export type MicMode = 'ptt' | 'handsfree';

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
/** hands-free turn taking: the model decides when a sentence is finished; speaking over it interrupts */
const VAD = { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true };

interface ServerEvent { type: string; [k: string]: any }

export interface VoiceHooks {
  state(s: VoiceState, why?: string): void;
  /** the user's words, once transcribed (key: conversation item id) */
  heard(id: string, text: string, final: boolean): void;
  /** the assistant's words as they are spoken (key: response item id) */
  said(id: string, text: string, final: boolean): void;
  speaking(on: boolean): void;
  listening(on: boolean): void;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
  error(msg: string): void;
  activity(): void;
}

/** What the session endpoint said, as an Error the panel can show. */
export class SessionError extends Error { constructor(msg: string, readonly code: string) { super(msg); } }

export async function mintSession(): Promise<{ value: string; expires_at: number; model: string; voice: string }> {
  let r: Response;
  try {
    r = await fetch('/openai/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch {
    throw new SessionError('Voice assistant needs the local dev server (npm run dev).', 'noserver');
  }
  const j = await r.json().catch(() => null) as { error?: string; code?: string; value?: string; expires_at?: number; model?: string; voice?: string } | null;
  if (!r.ok || !j?.value) throw new SessionError(j?.error ?? `Session request failed (${r.status}).`, j?.code ?? (r.status === 404 ? 'noserver' : 'error'));
  return { value: j.value, expires_at: j.expires_at ?? 0, model: j.model ?? '', voice: j.voice ?? '' };
}

export class RealtimeVoice {
  state: VoiceState = 'off';
  mode: MicMode = 'ptt';
  model = '';
  voice = '';
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private calls = new Map<string, Promise<unknown>>();
  private responding = false;
  private talking = false;
  private said = new Map<string, string>();
  private gen = 0;
  private epoch = 0;

  constructor(private hooks: VoiceHooks) {}

  get live(): boolean { return this.state === 'live'; }

  private set(s: VoiceState, why?: string): void { this.state = s; this.hooks.state(s, why); }

  /** Connect: needs a user gesture (the mic prompt and audio playback both do). */
  async connect(instructions: string, tools: ToolDef[], mode: MicMode): Promise<void> {
    if (this.state !== 'off') return;
    const g = ++this.gen;
    this.mode = mode;
    this.set('connecting');
    try {
      // the mic prompt and the secret in parallel (an unused secret costs nothing and expires in two minutes)
      const minting = mintSession();
      minting.catch(() => {});
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        throw new SessionError('Microphone blocked. Allow it for this page, or type your question.', 'mic');
      }
      this.mic = mic;
      const s = await minting;
      if (g !== this.gen) { mic.getTracks().forEach((t) => t.stop()); return; }
      this.model = s.model; this.voice = s.voice;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = document.createElement('audio');
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; void audio.play().catch(() => {}); };
      const track = mic.getAudioTracks()[0];
      track.enabled = mode === 'handsfree';
      pc.addTrack(track, mic);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (e) => { try { this.onEvent(JSON.parse(e.data)); } catch { /* not ours */ } };
      const opened = new Promise<void>((ok, bad) => { dc.onopen = () => ok(); setTimeout(() => bad(new SessionError('The voice line did not open in time.', 'network')), 15000); });
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.disconnect('The voice line dropped.');
      };
      await pc.setLocalDescription(await pc.createOffer());
      let r: Response;
      try {
        r = await fetch(CALLS_URL, { method: 'POST', body: pc.localDescription!.sdp, headers: { Authorization: `Bearer ${s.value}`, 'Content-Type': 'application/sdp' } });
      } catch { throw new SessionError('Could not reach OpenAI. Check the network.', 'network'); }
      if (!r.ok) throw new SessionError(`OpenAI refused the call (${r.status}): ${(await r.text()).slice(0, 160)}`, 'error');
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
      await opened;
      if (g !== this.gen) return;
      this.send({ type: 'session.update', session: { type: 'realtime', instructions, tools: tools.map((t) => ({ type: 'function', ...t })), tool_choice: 'auto', audio: { input: { turn_detection: mode === 'handsfree' ? VAD : null } } } });
      this.set('live');
      this.hooks.activity();
    } catch (e) {
      const msg = e instanceof SessionError ? e.message : `Voice failed: ${(e as Error).message}`;
      this.teardown();
      this.set('off', msg);
      throw e instanceof SessionError ? e : new SessionError(msg, 'error');
    }
  }

  disconnect(why?: string): void {
    if (this.state === 'off') return;
    this.gen++;
    this.teardown();
    this.set('off', why);
  }

  private teardown(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.dc?.close();
    this.pc?.close();
    if (this.audio) { this.audio.srcObject = null; this.audio = null; }
    this.mic = null; this.dc = null; this.pc = null;
    this.calls.clear(); this.said.clear();
    this.responding = false; this.talking = false;
    this.hooks.speaking(false); this.hooks.listening(false);
  }

  private send(ev: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  updateInstructions(instructions: string): void { if (this.live) this.send({ type: 'session.update', session: { type: 'realtime', instructions } }); }

  setMode(mode: MicMode): void {
    this.mode = mode;
    const t = this.mic?.getAudioTracks()[0];
    if (t) t.enabled = mode === 'handsfree';
    this.hooks.listening(mode === 'handsfree' && this.live);
    this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: mode === 'handsfree' ? VAD : null } } } });
  }

  /** Stop the answer being spoken (barge-in by button, key or a new question). */
  interrupt(): void {
    this.epoch++;
    if (this.responding) this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  /** A typed question, answered aloud. */
  ask(text: string): void {
    this.interrupt();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
    this.hooks.activity();
  }

  /** Push to talk: open the mic and cut off whatever is being said. */
  pttDown(): void {
    if (!this.live || this.talking) return;
    this.talking = true;
    this.interrupt();
    this.send({ type: 'input_audio_buffer.clear' });
    const t = this.mic?.getAudioTracks()[0];
    if (t) t.enabled = true;
    this.hooks.listening(true);
    this.hooks.activity();
  }

  /** Release: a short tail so the last word isn't clipped, then answer. */
  pttUp(): void {
    if (!this.talking) return;
    this.talking = false;
    setTimeout(() => {
      if (this.mode === 'ptt') { const t = this.mic?.getAudioTracks()[0]; if (t) t.enabled = false; }
      this.hooks.listening(this.mode === 'handsfree');
      if (this.mode === 'ptt') { this.send({ type: 'input_audio_buffer.commit' }); this.send({ type: 'response.create' }); }
    }, 280);
  }

  /** Bytes of audio received so far (the model's voice), from WebRTC stats. */
  async audioBytesIn(): Promise<number> {
    if (!this.pc) return 0;
    let n = 0;
    (await this.pc.getStats()).forEach((s: any) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived ?? 0; });
    return n;
  }

  private onEvent(e: ServerEvent): void {
    const h = this.hooks;
    switch (e.type) {
      case 'input_audio_buffer.speech_started': this.epoch++; h.activity(); h.listening(true); break;
      case 'input_audio_buffer.speech_stopped': if (this.mode === 'handsfree') h.listening(true); break;
      case 'input_audio_buffer.committed': h.heard(e.item_id, '…', false); break;
      case 'conversation.item.input_audio_transcription.delta': break;
      case 'conversation.item.input_audio_transcription.completed': h.heard(e.item_id, String(e.transcript ?? '').trim(), true); break;
      case 'response.created': this.responding = true; break;
      case 'output_audio_buffer.started': h.speaking(true); break;
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': h.speaking(false); break;
      case 'response.output_audio_transcript.delta': case 'response.output_text.delta': {
        const t = (this.said.get(e.item_id) ?? '') + e.delta;
        this.said.set(e.item_id, t);
        h.said(e.item_id, t, false);
        break;
      }
      case 'response.output_audio_transcript.done': case 'response.output_text.done':
        h.said(e.item_id, String(e.transcript ?? e.text ?? this.said.get(e.item_id) ?? ''), true);
        this.said.delete(e.item_id);
        break;
      case 'response.function_call_arguments.done': {
        // start the tool as soon as its arguments are complete; answer when the response ends
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(e.arguments || '{}'); } catch { /* empty */ }
        this.calls.set(e.call_id, h.tool(e.name, args));
        break;
      }
      case 'response.done': {
        this.responding = false;
        const r = e.response ?? {};
        if (r.status === 'failed') {
          const err = r.status_details?.error;
          h.error(errorText(err?.code, err?.message ?? 'The answer failed.'));
        }
        const calls = (r.output ?? []).filter((o: any) => o.type === 'function_call');
        if (calls.length) void this.answerCalls(calls);
        break;
      }
      case 'error': {
        const code = e.error?.code ?? '';
        // harmless races: nothing to cancel, nothing said yet
        if (/response_cancel_not_active|input_audio_buffer_commit_empty|conversation_already_has_active_response/.test(code)) break;
        h.error(errorText(code, e.error?.message ?? 'Realtime error'));
        break;
      }
    }
  }

  private async answerCalls(calls: { call_id: string; name: string; arguments: string }[]): Promise<void> {
    const g = this.gen, epoch = this.epoch;
    const outs = await Promise.all(calls.map((c) => {
      const p = this.calls.get(c.call_id) ?? (() => { let a = {}; try { a = JSON.parse(c.arguments || '{}'); } catch { /* empty */ } return this.hooks.tool(c.name, a); })();
      this.calls.delete(c.call_id);
      return p;
    }));
    if (g !== this.gen) return;
    calls.forEach((c, i) => this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(outs[i] ?? null) } }));
    // interrupted while the tools ran: the results stay in the conversation, but the user has moved on
    if (epoch === this.epoch) this.send({ type: 'response.create' });
  }
}

export function errorText(code: string | undefined, msg: string): string {
  if (code === 'insufficient_quota' || /quota|billing/i.test(msg)) return 'OpenAI says the account is out of credits or over quota.';
  if (code === 'rate_limit_exceeded') return 'OpenAI rate limit hit. Wait a moment and try again.';
  if (code === 'invalid_api_key') return 'OpenAI rejected the API key in .env.local.';
  return msg.slice(0, 200);
}
