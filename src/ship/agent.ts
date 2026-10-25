// The Oracle: an ElevenLabs Conversational AI agent that answers "what leads
// to…?" out loud — the user names a moment, its client tools find_futures and
// watch_future (scripts/eleven-agent.ts installs them from agentSpec.ts) run in
// this page, and the screen flies into the futures it talks about. Plain
// WebSocket + WebAudio, no SDK.
//
// Key handling (same pattern as voice.ts): in dev, put ELEVENLABS_API_KEY in
// .env.local and the Vite proxy at /eleven adds it server-side, so it never
// reaches the page — ELEVEN_PROXY tells us the proxy holds one, and with no key
// the proxy is never called at all. Otherwise a key typed into Settings lives
// in this browser's localStorage only and rides on the signed-url request as
// xi-api-key — it is never put on the WebSocket URL. With neither, a public
// agent works keyless.

import type { AgentToolName } from './agentSpec.ts';
import { ELEVEN_PROXY } from './voice.ts';

const LS_KEY = 'starship.elevenlabs.key';   // must match voice.ts

function ls(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }

/** Mic capture, inlined into a Blob module: ship each input block to the page. */
const WORKLET = `class P extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0][0]; if (c && c.length) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor('oracle-mic', P);`;

const rateOf = (fmt: unknown): number | null => (typeof fmt === 'string' && /^pcm_\d+$/.test(fmt)) ? Number(fmt.slice(4)) : null;

const b64 = (pcm: Int16Array): string => {
  const u8 = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
  return btoa(s);
};

export interface AgentHooks { transcript(who: 'you' | 'agent', text: string): void; mode(m: string): void; status(s: string): void }
export interface OracleTools {
  find_futures(p: { goal: string }): Promise<string>;
  watch_future(p: { future: number; year?: number }): Promise<string>;
}

export class OracleAgent {
  readonly available: boolean;
  private dispatch: Record<AgentToolName, (p: any) => Promise<string>>;
  private hooks: AgentHooks | null = null;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playHead = 0;
  private inRate = 16000;
  private outRate = 16000;
  private micAcc = new Int16Array(0);
  private session = 0;   // bumped by every start/stop: stale continuations and stale sockets bow out
  private live = false;
  private readyTimer = 0;
  private ready: (() => void) | null = null;
  private fail: ((e: Error) => void) | null = null;

  constructor(private agentId: string | null, tools: OracleTools) {
    this.available = !!agentId;
    this.dispatch = { find_futures: (p) => tools.find_futures(p), watch_future: (p) => tools.watch_future(p) };
  }

  get active(): boolean { return this.live; }

  /** The AudioContext is created inside the click so the browser lets it play; then mic, url, worklet, socket. */
  async start(h: AgentHooks): Promise<void> {
    if (this.live) return;
    if (!this.agentId) throw new Error('No Oracle agent is configured.');
    const s = ++this.session;
    const ctx = this.ctx = new AudioContext();
    ctx.resume().catch(() => {});   // a context closed before it resumed rejects: nothing to report
    this.live = true;
    this.hooks = h;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (s !== this.session) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      const url = await this.signedUrl();
      if (s !== this.session) return;
      const mod = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(mod); } finally { URL.revokeObjectURL(mod); }
      if (s !== this.session) return;
      await new Promise<void>((resolve, reject) => {
        this.ready = resolve; this.fail = reject;
        this.readyTimer = window.setTimeout(() => this.settle(new Error('The Oracle did not answer.')), 15000);
        const ws = this.ws = new WebSocket(url);
        ws.onopen = () => { if (this.ws !== ws) return; ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' })); };
        ws.onmessage = (e) => { if (this.ws !== ws) return; this.onMessage(e); };
        ws.onerror = () => { if (this.ws !== ws) return; this.settle(new Error('The Oracle connection failed.')); };
        ws.onclose = (ev) => { if (this.ws !== ws) return; this.onClose(ev); };
      });
      if (s !== this.session) return;
      this.micSrc = ctx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(ctx, 'oracle-mic');
      this.worklet.port.onmessage = (e) => this.onMic(e.data as Float32Array);
      this.micSrc.connect(this.worklet);
      this.worklet.connect(ctx.destination);   // the processor emits silence; this only keeps it running
    } catch (e) {
      if (s !== this.session) return;   // the user hung up while we connected
      this.cleanup();
      throw e;
    }
  }

  /** User-initiated hang-up: quiet, no status line. */
  stop(): void {
    this.session++;
    this.settle();
    this.cleanup();
  }

  private settle(err?: Error): void {
    const ok = this.ready, no = this.fail;
    this.ready = this.fail = null;
    clearTimeout(this.readyTimer);
    err ? no?.(err) : ok?.();
  }

  private send(o: object): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }

  /** Dev proxy first, then a browser-held key, then the keyless public-agent URL. */
  private async signedUrl(): Promise<string> {
    const id = encodeURIComponent(this.agentId!);
    if (import.meta.env.DEV && ELEVEN_PROXY) {
      try {
        const r = await fetch(`/eleven/v1/convai/conversation/get-signed-url?agent_id=${id}`);
        if (r.ok) { const u = (await r.json()).signed_url; if (u) return u; }
      } catch { /* no proxy */ }
    }
    const key = ls(LS_KEY);
    if (key) {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${id}`, { headers: { 'xi-api-key': key } });
        if (r.ok) { const u = (await r.json()).signed_url; if (u) return u; }
      } catch { /* unreachable */ }
    }
    return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${id}`;
  }

  private onMessage(e: MessageEvent): void {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m?.type) {
      case 'conversation_initiation_metadata': {
        const ev = m.conversation_initiation_metadata_event ?? {};
        const inp = rateOf(ev.user_input_audio_format), out = rateOf(ev.agent_output_audio_format);
        if (!inp || !out) return this.settle(new Error('The Oracle agent must use PCM audio; rerun npm run eleven:agent.'));
        this.inRate = inp; this.outRate = out;
        this.settle();
        break;
      }
      case 'audio': this.play(m.audio_event?.audio_base_64); break;
      case 'interruption': {
        for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* already done */ } }
        this.sources.clear();
        if (this.ctx) this.playHead = this.ctx.currentTime;
        this.hooks?.mode('listening');
        break;
      }
      case 'ping': this.send({ type: 'pong', event_id: m.ping_event?.event_id }); break;
      case 'user_transcript': { const t = m.user_transcription_event?.user_transcript; if (t) this.hooks?.transcript('you', t); break; }
      case 'agent_response': { const t = m.agent_response_event?.agent_response; if (t) this.hooks?.transcript('agent', t); break; }
      case 'client_tool_call': void this.toolCall(m.client_tool_call); break;
    }
  }

  /** Resample the mic block down to the agent's input rate, ship ~100 ms chunks. */
  private onMic(input: Float32Array): void {
    const k = this.ctx ? this.ctx.sampleRate / this.inRate : 1;
    const n = Math.floor(input.length / k);
    const joined = new Int16Array(this.micAcc.length + n);
    joined.set(this.micAcc);
    for (let i = 0; i < n; i++) {
      const p = i * k, i0 = Math.floor(p), i1 = Math.min(input.length - 1, i0 + 1), t = p - i0;
      joined[this.micAcc.length + i] = Math.max(-32768, Math.min(32767, Math.round((input[i0] + (input[i1] - input[i0]) * t) * 32767)));
    }
    this.micAcc = joined;
    const want = Math.round(this.inRate * 0.1);
    while (this.micAcc.length >= want) {
      const chunk = this.micAcc.slice(0, want);
      this.micAcc = this.micAcc.slice(want);
      this.send({ user_audio_chunk: b64(chunk) });
    }
  }

  /** Queue one reply chunk of Int16 PCM after whatever is still playing. */
  private play(a: string | undefined): void {
    if (!a || !this.ctx) return;
    const bin = atob(a), n = bin.length >> 1;
    if (n === 0) return;
    const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: this.outRate });
    const f = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { const lo = bin.charCodeAt(2 * i), hi = bin.charCodeAt(2 * i + 1); f[i] = ((((hi << 8) | lo) << 16) >> 16) / 32768; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime, this.playHead);
    src.start(t);
    this.playHead = t + buf.duration;
    this.sources.add(src);
    this.hooks?.mode('speaking');
    src.onended = () => { this.sources.delete(src); if (!this.sources.size) this.hooks?.mode('listening'); };
  }

  private async toolCall(call: any): Promise<void> {
    const name = call?.tool_name as string;
    this.hooks?.mode(name === 'find_futures' ? 'searching the futures…' : name === 'watch_future' ? 'flying there…' : 'working…');
    const s = this.session;
    let result: string, isErr: boolean;
    try {
      const fn = Object.hasOwn(this.dispatch, name) ? this.dispatch[name as AgentToolName] : undefined;
      if (fn) { result = await fn(call?.parameters ?? {}); isErr = false; }
      else { result = `Unknown tool ${name}`; isErr = true; }
    } catch (e) { result = (e as Error).message ?? String(e); isErr = true; }
    if (s !== this.session) return;   // a new session owns the wire now
    this.send({ type: 'client_tool_result', tool_call_id: call?.tool_call_id, result, is_error: isErr });
    if (!this.sources.size) this.hooks?.mode('listening');
  }

  private onClose(ev: CloseEvent): void {
    if (this.ready || this.fail) { this.settle(new Error('The Oracle connection failed.')); return; }
    this.cleanup();
    this.hooks?.mode('');
    this.hooks?.status(`The Oracle has gone quiet${ev.reason ? `: ${ev.reason}` : '.'}`);
  }

  private cleanup(): void {
    this.live = false;
    clearTimeout(this.readyTimer);
    this.micAcc = new Int16Array(0);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.micSrc?.disconnect(); this.micSrc = null;
    this.worklet?.disconnect(); this.worklet = null;
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* already done */ } }
    this.sources.clear();
    this.playHead = 0;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000);
  }
}
