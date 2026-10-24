// Engine sound, synthesized: filtered brown noise for the rumble, a low hum,
// and a shimmering tone that bends up or down during time jumps.

export class EngineAudio {
  private ac: AudioContext | null = null;
  private rumble!: GainNode;
  private filter!: BiquadFilterNode;
  private hum!: GainNode;
  private humOsc!: OscillatorNode;
  private chronoGain!: GainNode;
  private chronoOsc!: OscillatorNode;
  muted = false;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    const ac = new AudioContext();
    this.ac = ac;
    const master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);

    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const noise = ac.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.filter = ac.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 180;
    this.rumble = ac.createGain();
    this.rumble.gain.value = 0.15;
    noise.connect(this.filter).connect(this.rumble).connect(master);
    noise.start();

    this.humOsc = ac.createOscillator();
    this.humOsc.type = 'sawtooth';
    this.humOsc.frequency.value = 42;
    const humF = ac.createBiquadFilter();
    humF.type = 'lowpass';
    humF.frequency.value = 120;
    this.hum = ac.createGain();
    this.hum.gain.value = 0.04;
    this.humOsc.connect(humF).connect(this.hum).connect(master);
    this.humOsc.start();

    this.chronoOsc = ac.createOscillator();
    this.chronoOsc.type = 'sine';
    this.chronoOsc.frequency.value = 220;
    const trem = ac.createOscillator();
    trem.frequency.value = 7;
    const tremG = ac.createGain();
    tremG.gain.value = 30;
    trem.connect(tremG).connect(this.chronoOsc.frequency);
    trem.start();
    this.chronoGain = ac.createGain();
    this.chronoGain.gain.value = 0;
    this.chronoOsc.connect(this.chronoGain).connect(master);
    this.chronoOsc.start();
  }

  update(throttle: number, warp: number, chrono: number, chronoDir: number, chronoProgress: number): void {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    const m = this.muted ? 0 : 1;
    this.rumble.gain.setTargetAtTime(m * (0.12 + throttle * 0.5 + warp * 0.6), t, 0.15);
    this.filter.frequency.setTargetAtTime(160 + throttle * 500 + warp * 1400, t, 0.2);
    this.hum.gain.setTargetAtTime(m * (0.03 + throttle * 0.05), t, 0.2);
    this.humOsc.frequency.setTargetAtTime(40 + throttle * 30 + warp * 50, t, 0.3);
    this.chronoGain.gain.setTargetAtTime(m * chrono * 0.07, t, 0.1);
    const f = chronoDir > 0 ? 180 + chronoProgress * 700 : 700 - chronoProgress * 560;
    this.chronoOsc.frequency.setTargetAtTime(f, t, 0.1);
  }
}
