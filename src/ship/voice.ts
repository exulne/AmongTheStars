// Voice in and out. ElevenLabs when a key is available (text-to-speech for the
// ship's replies, Scribe speech-to-text for the mic); the browser's built-in
// speech engines otherwise, so everything still works with no key and no credits.
//
// Key handling: in dev, put ELEVENLABS_API_KEY in .env.local and the Vite proxy
// adds it server-side, so it never reaches the page. A key typed into Settings
// is kept in this browser's localStorage only.

const LS_KEY = 'starship.elevenlabs.key';
const LS_VOICE = 'starship.elevenlabs.voice';
const LS_SPEAK = 'starship.speak';
const LS_STT = 'starship.stt';

export const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';   // "Sarah", a stock ElevenLabs voice (the ship computer is a woman's voice)
const TTS_MODEL = 'eleven_flash_v2_5';                // cheapest and fastest model

function ls(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string | null): void { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

export interface Credits { used: number; limit: number; tier: string; resets?: number }

export class Voice {
  /** 'proxy' = dev server holds the key; 'browser' = key typed in settings; null = no ElevenLabs. */
  mode: 'proxy' | 'browser' | null = null;
  speak = ls(LS_SPEAK) !== 'off';
  useElevenStt = ls(LS_STT) !== 'browser';
  voiceId = ls(LS_VOICE) || DEFAULT_VOICE;
  charsThisSession = 0;
  credits: Credits | null = null;
  lastError = '';
  onStatus: (s: string) => void = () => {};

  private audio: HTMLAudioElement | null = null;
  private cache = new Map<string, string>();
  private rec: MediaRecorder | null = null;
  private recognition: any = null;

  get key(): string | null { return ls(LS_KEY); }
  setKey(k: string | null): void { lsSet(LS_KEY, k && k.trim() ? k.trim() : null); }
  setVoice(id: string): void { this.voiceId = id.trim() || DEFAULT_VOICE; lsSet(LS_VOICE, this.voiceId); this.cache.clear(); }
  setSpeak(on: boolean): void { this.speak = on; lsSet(LS_SPEAK, on ? 'on' : 'off'); if (!on) this.stopSpeaking(); }
  setElevenStt(on: boolean): void { this.useElevenStt = on; lsSet(LS_STT, on ? 'eleven' : 'browser'); }

  private base(): string { return this.mode === 'proxy' ? '/eleven' : 'https://api.elevenlabs.io'; }
  private headers(): Record<string, string> { return this.mode === 'browser' && this.key ? { 'xi-api-key': this.key } : {}; }

  /** Figure out whether ElevenLabs is usable and how many credits are left. */
  async connect(): Promise<void> {
    this.mode = null;
    this.credits = null;
    const tries: ('proxy' | 'browser')[] = [];
    if (import.meta.env.DEV) tries.push('proxy');
    if (this.key) tries.push('browser');
    for (const m of tries) {
      this.mode = m;
      try {
        const r = await fetch(`${this.base()}/v1/user/subscription`, { headers: this.headers() });
        if (r.ok) {
          const j = await r.json();
          this.credits = { used: j.character_count ?? 0, limit: j.character_limit ?? 0, tier: j.tier ?? '', resets: j.next_character_count_reset_unix };
          this.lastError = '';
          return;
        }
        // a key with restricted scopes may not read the subscription but can still speak
        if (r.status === 401 || r.status === 403) {
          const body = await r.text();
          if (/missing_permissions|permission/i.test(body)) { this.lastError = 'Key works, but it can\'t read the credit balance.'; return; }
          this.lastError = m === 'proxy' ? '' : 'ElevenLabs rejected that key.';
        }
      } catch {
        this.lastError = m === 'browser' ? 'Could not reach ElevenLabs from the browser.' : '';
      }
    }
    this.mode = null;
  }

  get elevenReady(): boolean { return this.mode !== null; }

  stopSpeaking(): void {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  async say(text: string): Promise<void> {
    if (!this.speak) return;
    this.stopSpeaking();
    if (this.elevenReady) {
      try {
        let url = this.cache.get(text);
        if (!url) {
          const r = await fetch(`${this.base()}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=mp3_44100_64`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', ...this.headers() },
            body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
          });
          if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 160)}`);
          url = URL.createObjectURL(await r.blob());
          this.cache.set(text, url);
          this.charsThisSession += text.length;
          if (this.credits) this.credits.used += text.length;
        }
        const a = new Audio(url);
        this.audio = a;
        await a.play();
        return;
      } catch (e) {
        this.lastError = String((e as Error).message ?? e);
        this.onStatus(`ElevenLabs voice failed, using the browser voice. (${this.lastError.slice(0, 80)})`);
      }
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      // the ship computer is a woman's voice (the GPT assistant speaks as Marin)
      const v = speechSynthesis.getVoices().find((x) => /Samantha|Google UK English Female|Karen|Moira|Serena|Zira|Victoria/.test(x.name));
      if (v) u.voice = v;
      u.rate = 1.05;
      speechSynthesis.speak(u);
    }
  }

  // ---------------------------------------------------------------- listening

  get listening(): boolean { return !!this.rec || !!this.recognition; }

  /**
   * Start listening. Resolves with the transcript once the user stops talking
   * (or presses the mic again). ElevenLabs Scribe if available and enabled,
   * else the browser's speech recognition.
   */
  async listen(onLevel: (v: number) => void): Promise<string> {
    if (this.elevenReady && this.useElevenStt && 'MediaRecorder' in window) return this.listenEleven(onLevel);
    return this.listenBrowser();
  }

  stopListening(): void {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    if (this.recognition) this.recognition.stop();
  }

  private async listenEleven(onLevel: (v: number) => void): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.rec = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    // stop automatically after ~1.3 s of silence once speech has started, or 12 s max
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let heard = false, quietSince = performance.now();
    const started = performance.now();
    const tick = () => {
      if (rec.state === 'inactive') return;
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const x of buf) s += x * x;
      const rms = Math.sqrt(s / buf.length);
      onLevel(Math.min(1, rms * 12));
      const now = performance.now();
      if (rms > 0.025) { heard = true; quietSince = now; }
      if ((heard && now - quietSince > 1300) || now - started > 12000) { rec.stop(); return; }
      requestAnimationFrame(tick);
    };
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    rec.start(250);
    tick();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    ac.close();
    onLevel(0);
    this.rec = null;
    if (!heard || !chunks.length) return '';

    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    this.onStatus('Transcribing…');
    for (const model of ['scribe_v2', 'scribe_v1']) {
      const fd = new FormData();
      fd.append('model_id', model);
      fd.append('file', blob, blob.type.includes('mp4') ? 'speech.mp4' : 'speech.webm');
      fd.append('tag_audio_events', 'false');
      const r = await fetch(`${this.base()}/v1/speech-to-text`, { method: 'POST', headers: this.headers(), body: fd });
      if (r.ok) return ((await r.json()).text ?? '').trim();
      if (r.status !== 400 && r.status !== 422) throw new Error(`Speech-to-text ${r.status}: ${(await r.text()).slice(0, 120)}`);
    }
    throw new Error('Speech-to-text failed.');
  }

  private listenBrowser(): Promise<string> {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return Promise.reject(new Error('This browser has no speech recognition. Add an ElevenLabs key in Settings, or type instead.'));
    return new Promise((resolve, reject) => {
      const r = new SR();
      this.recognition = r;
      r.lang = 'en-US';
      r.interimResults = false;
      r.maxAlternatives = 1;
      let text = '';
      r.onresult = (e: any) => { text = e.results[0][0].transcript; };
      r.onerror = (e: any) => { this.recognition = null; e.error === 'no-speech' ? resolve('') : reject(new Error(`Mic: ${e.error}`)); };
      r.onend = () => { this.recognition = null; resolve(text); };
      r.start();
    });
  }
}
