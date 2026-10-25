// The impact visualization's controller: a state machine stepped by the main
// animation loop's dt (no clock of its own), and the only thing that moves the
// camera while a visualization runs, always through the shared CameraRig.
//   idle → loading → focusing → playing ⇄ paused → complete → exiting → idle
// While playing, the phase is a pure function of the visual time t
// (vizTimeline.ts); scrubbing sets t. Starting saves the view, the selection,
// the camera and the timeline; the timeline is paused; exiting (or a second
// start) tears the layer down and puts everything back.
// Manual input: a drag, pinch or wheel while the sequence runs hands the camera
// to the reader ("free camera"); the sequence keeps its own clock, and
// "Directed camera" glides back to the directed shot. Paused, the reader orbits
// freely. Reduced motion: no chase camera, no shake, capped flashes, short cuts.

import * as THREE from 'three';
import { slantOfAlt, type VisualScenario } from '../impact/visual.ts';
import { autoCamera, buildTimeline, emptyState, safeCamera, sampleAt, shakeAmount, type CameraMode, type Phase, type VizState, type VizTimeline } from '../impact/vizTimeline.ts';
import { easeInOutCubic, type CameraRig } from './camRig.ts';
import { ImpactLayer, type ImpactHost } from './impactLayer.ts';
import type { Label } from './views.ts';

export type DirectorStatus = 'idle' | 'loading' | 'focusing' | 'playing' | 'paused' | 'complete' | 'exiting';

/** The globe the layer draws on (PlanetView), as the director needs it. */
export interface PlanetHost extends ImpactHost { holdSpin(on: boolean): void; faceSun?(dir: [number, number, number]): void; extraLabels: (() => Label[]) | null }

export interface SavedView { level: string; body: number; system: number; selected: unknown; cam: THREE.Vector3; target: THREE.Vector3; fov: number; playing: boolean; year: number; extra?: unknown }

/** What the app lends the director (main.ts). */
export interface DirectorHost {
  rig: CameraRig;
  camera: THREE.PerspectiveCamera;
  /** where we are now, as a whole: level, body, selection, camera, timeline */
  save(): SavedView;
  /** put it all back (level change through the app's own transitions); `done` when settled */
  restore(s: SavedView): void;
  /** go to body b's planet view through the app's own travel */
  goToBody(b: number): void;
  /** the planet view's globe, if it is showing body b and nothing is in flight */
  planet(b: number): PlanetHost | null;
  /** timeline */
  playing(): boolean; togglePlay(): void; seekYear(y: number): void;
  /** zoom limits while the visualization owns the view, and the view's own afterwards */
  setLimits(lo: number, hi: number): void;
  reduced(): boolean;
  pixelRatio(): number;
  viewportH(): number;
}

export interface Toggles { overlays: boolean; uncertainty: boolean; telemetry: boolean; enhanced: boolean; shake: boolean; cutaway: boolean }

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tv4 = new THREE.Vector3();

export class ImpactDirector {
  status: DirectorStatus = 'idle';
  v: VisualScenario | null = null;
  tl: VizTimeline | null = null;
  t = 0;
  speed = 1;
  camera: CameraMode = 'auto';
  /** the reader has the camera (a drag or wheel during the sequence) */
  free = false;
  toggles: Toggles = { overlays: true, uncertainty: true, telemetry: true, enhanced: false, shake: false, cutaway: false };
  state: VizState = emptyState();
  error = '';
  quality: 'high' | 'low' = 'high';
  /** called on every status, phase or setting change (the playback overlay redraws) */
  onChange: () => void = () => {};
  private host: DirectorHost;
  private layer: ImpactLayer | null = null;
  private planetHost: PlanetHost | null = null;
  private saved: SavedView | null = null;
  private onExit: (() => void) | null = null;
  private shot: Exclude<CameraMode, 'auto'> | '' = '';
  private lastPhase: Phase | '' = '';
  private shakeOff = new THREE.Vector3();
  private gen = 0;
  private slow = 0; private frameEma = 1 / 60;
  private replay: { before: number; after: number; persistent: boolean; seeked: boolean } | null = null;
  private waited = 0;

  constructor(host: DirectorHost) { this.host = host; }

  get active(): boolean { return this.status !== 'idle'; }
  get phase(): Phase { return this.status === 'playing' || this.status === 'paused' ? this.state.phase : this.status === 'complete' ? 'complete' : (this.status as Phase); }
  get duration(): number { return this.tl?.duration ?? 0; }
  get layerOf(): ImpactLayer | null { return this.layer; }
  get compressed(): number { return this.layer?.compressed ?? 1; }

  /**
   * Begin a visualization. `src` may still be computing (a worker request). A second start cleans the first
   * up and keeps the original saved view, so exiting always returns to where the reader was before any of them.
   */
  start(src: VisualScenario | Promise<VisualScenario | null>, opts: { onExit?: () => void; replayYear?: number; persistentScar?: boolean } = {}): void {
    const g = ++this.gen;
    if (this.active) this.teardown(); else { this.saved = this.host.save(); if (this.host.playing()) this.host.togglePlay(); }
    if (opts.onExit) this.onExit = opts.onExit;
    this.error = '';
    this.status = 'loading';
    this.replay = opts.replayYear !== undefined ? { before: opts.replayYear - 0.02, after: opts.replayYear + 0.02, persistent: !!opts.persistentScar, seeked: false } : null;
    this.onChange();
    Promise.resolve(src).then((v) => {
      if (g !== this.gen) return;
      if (!v) { this.error = 'Nothing to visualize.'; this.exit(); return; }
      this.begin(v);
    }, (e) => { if (g === this.gen) { this.error = String((e as Error)?.message ?? e); this.exit(); } });
  }

  private begin(v: VisualScenario): void {
    this.v = v; this.tl = buildTimeline(v); this.t = 0; this.free = false; this.camera = 'auto'; this.shot = ''; this.lastPhase = '';
    this.state = sampleAt(v, this.tl, 0, this.state);
    this.status = 'focusing'; this.waited = 0;
    if (this.replay) { this.host.seekYear(this.replay.before); this.replay.seeked = true; }
    if (!this.host.planet(v.body.world)) this.host.goToBody(v.body.world);
    this.onChange();
  }

  /** Called once per frame by the app, after the views have moved and before the rig. */
  frame(dt: number): void {
    if (this.shakeOff.lengthSq()) { this.host.camera.position.sub(this.shakeOff); this.shakeOff.set(0, 0, 0); }
    if (!this.active || !this.v || !this.tl) return;
    if (this.status === 'focusing') {
      this.waited += dt;
      const ph = this.host.planet(this.v.body.world);
      if (!ph) { if (this.waited > 20) { this.error = 'Could not reach the planet view.'; this.exit(); } return; }
      this.attach(ph);
      this.status = 'playing';
      this.onChange();
    }
    if (!this.layer || !this.planetHost) return;
    // if the planet view went away under us (the reader navigated off), stop cleanly
    if (!this.host.planet(this.v.body.world)) { this.exit(); return; }
    if (this.status === 'playing') {
      this.t = Math.min(this.tl.duration, this.t + dt * this.speed);
      if (this.t >= this.tl.duration) { this.status = 'complete'; this.onChange(); }
    }
    this.govern(dt);
    this.render();
  }

  /** After the rig has placed the camera: the optional shake, undone at the start of the next frame. */
  afterRig(): void {
    if (!this.v || this.status !== 'playing') return;
    const a = shakeAmount(this.v, this.state, this.toggles.shake, this.host.reduced());
    if (a <= 0) return;
    const s = this.t * 61.7;
    this.shakeOff.set(Math.sin(s * 1.3), Math.sin(s * 1.7 + 1), Math.sin(s * 2.1 + 2)).multiplyScalar(a);
    this.host.camera.position.add(this.shakeOff);
  }

  private attach(ph: PlanetHost): void {
    this.planetHost = ph;
    this.layer = new ImpactLayer(this.v!, ph, this.quality);
    ph.extraLabels = () => this.layer?.labels() ?? [];
    ph.holdSpin(false);
    if (this.v!.kind !== 'close-approach') ph.faceSun?.(this.v!.trajectory.point);
    const far = this.v!.kind === 'close-approach' ? 9000 : 600;
    this.host.setLimits(0.15, far);
  }

  private render(): void {
    const v = this.v!, tl = this.tl!, L = this.layer!;
    sampleAt(v, tl, this.t, this.state);
    if (this.replay?.persistent && this.state.phase === 'aftermath' && this.replay.seeked) { this.host.seekYear(this.replay.after); this.replay.seeked = false; }
    const reduced = this.host.reduced();
    L.update(this.state, this.host.camera, {
      overlays: this.toggles.overlays, uncertainty: this.toggles.uncertainty, enhanced: this.toggles.enhanced, reduced, quality: this.quality,
      cutaway: this.toggles.cutaway || this.currentShot() === 'cutaway', pixelRatio: this.host.pixelRatio(), viewportH: this.host.viewportH(),
      persistentScar: !!this.replay?.persistent && this.state.phase === 'aftermath',
    });
    this.planetHost!.holdSpin(this.status === 'paused');
    if (this.state.phase !== this.lastPhase) { this.lastPhase = this.state.phase; this.onChange(); }
    if (!this.free && this.status !== 'paused') {
      const want = this.currentShot();
      if (want !== this.shot) this.moveTo(want);
    }
  }

  private currentShot(): Exclude<CameraMode, 'auto'> {
    const reduced = this.host.reduced();
    return safeCamera(this.camera === 'auto' ? autoCamera(this.v!, this.state.phase, reduced) : this.camera, reduced);
  }

  /** Fly to a shot through the rig, then follow what it frames (the point turns with the planet; the impactor moves). */
  private moveTo(mode: Exclude<CameraMode, 'auto'>): void {
    const L = this.layer!, v = this.v!, rig = this.host.rig, k = 10 / v.body.radiusKm;
    this.shot = mode;
    const gz = L.groundZero(new THREE.Vector3()), n = L.normal(new THREE.Vector3());
    const east = tv.set(0, 1, 0).cross(n); if (east.lengthSq() < 1e-8) east.set(1, 0, 0); east.normalize();
    const pos = new THREE.Vector3(), target = new THREE.Vector3();
    let follow: (() => THREE.Vector3 | null) | null = () => L.groundZero(new THREE.Vector3());
    const top = v.entry?.trace.length ? v.entry.topAltKm : 0, effects = Math.max(10, maxEffect(v)) * k;
    if (v.kind === 'close-approach') {
      // the planet and the closest point both in frame
      const d = Math.max(34, gz.length() * 2.2);
      target.copy(gz).multiplyScalar(0.5);
      pos.copy(target).addScaledVector(n, d * 0.35).addScaledVector(tv2.set(0, 1, 0), d * 0.45).addScaledVector(east, d * 0.8);
      follow = null;
    } else if (mode === 'overview' || v.kind === 'deflection') {
      target.set(0, 0, 0);
      pos.copy(n).multiplyScalar(30).addScaledVector(east, 16).addScaledVector(tv2.set(0, 1, 0), 8);
      follow = null;
    } else if (mode === 'follow') {
      const o = L.object(new THREE.Vector3()), d = tv2.set(...v.trajectory.dir).transformDirection(L.group.matrixWorld);
      target.copy(o);
      pos.copy(o).addScaledVector(d, -2.4).addScaledVector(n, 1.1).addScaledVector(east, 0.9);
      follow = () => L.object(new THREE.Vector3());
    } else if (mode === 'side') {
      const a = L.path(slantOfAlt(v, Math.max(top, 1)), tv3), mid = tv4.copy(a).add(gz).multiplyScalar(0.5), d = tv2.set(...v.trajectory.dir).transformDirection(L.group.matrixWorld);
      const side = new THREE.Vector3().crossVectors(d, n).normalize(), len = Math.max(1.4, a.distanceTo(gz) * 1.3);
      target.copy(mid);
      pos.copy(mid).addScaledVector(side, len).addScaledVector(n, len * 0.25);
    } else if (mode === 'cutaway') {
      // grazing, along the limb: the altitude column seen edge-on against space
      // along the limb: the line of sight grazes the globe at ground zero, so the column stands against space
      const d = Math.max(5, (v.effects.plume?.plumeHeightKm[1] ?? 0) * k * 6, Math.max(top, 50) * k * 8);
      target.copy(gz).addScaledVector(n, Math.max(top, v.effects.plume?.plumeHeightKm[1] ?? 0, 30) * k * 0.4);
      pos.copy(gz).addScaledVector(east, d).addScaledVector(n, d * 0.03);
    } else if (mode === 'ground') {
      const d = Math.max(1.2, effects * 2.2);
      target.copy(gz);
      pos.copy(gz).addScaledVector(n, d).addScaledVector(east, d * 0.7);
    } else {
      const d = Math.max(2, effects * 3.2);
      target.copy(gz);
      pos.copy(gz).addScaledVector(n, d * 1.1).addScaledVector(east, d * 0.45);
    }
    // stay outside the atmosphere's halo shell (radius 10.5): from inside it the shell's facets fill the view
    if (v.kind !== 'close-approach' && pos.length() < 11.2) pos.setLength(11.2);
    const dur = (this.host.reduced() ? 0.5 : 1.3) * rig.spec.level;
    rig.orbitTo(pos, target, dur, easeInOutCubic, () => { if (this.active && follow) rig.follow(follow); }, true);
  }

  private govern(dt: number): void {
    // frames slow for two seconds: fewer symbolic particles, never less physics
    if (this.quality === 'low' || this.status !== 'playing') return;
    this.frameEma += (dt - this.frameEma) * 0.05;
    this.slow = this.frameEma > 1 / 32 ? this.slow + dt : 0;
    if (this.slow < 2) return;
    this.quality = 'low';
    if (this.layer && this.planetHost) { this.layer.dispose(); this.layer = new ImpactLayer(this.v!, this.planetHost, 'low'); }
    this.onChange();
  }

  // ---------------------------------------------------------------- controls

  play(): void { if (!this.v) return; if (this.status === 'complete') this.t = 0; if (this.status === 'paused' || this.status === 'complete') { this.status = 'playing'; this.onChange(); } }
  pause(): void { if (this.status === 'playing') { this.status = 'paused'; this.host.rig.follow(null); this.onChange(); } }
  toggle(): void { if (this.status === 'playing') this.pause(); else this.play(); }
  replayFromStart(): void { if (!this.v) return; this.t = 0; this.free = false; this.shot = ''; if (this.status !== 'focusing' && this.status !== 'loading') this.status = 'playing'; this.onChange(); }
  seek(t: number): void { if (!this.tl) return; this.t = Math.max(0, Math.min(this.tl.duration, t)); if (this.status === 'complete' && this.t < this.tl.duration) this.status = 'paused'; this.onChange(); }
  skipToAftermath(): void { const s = this.tl?.spans.find((x) => x.phase === 'aftermath' || x.phase === 'miss' || x.phase === 'departure'); if (s) this.seek(s.t0); }
  setSpeed(x: number): void { this.speed = x; this.onChange(); }
  setCamera(m: CameraMode): void { this.camera = m; this.free = false; this.shot = ''; this.onChange(); }
  setToggle(k: keyof Toggles, on: boolean): void { this.toggles[k] = on; this.onChange(); }
  /** The reader took the camera: stop directing it until asked again. */
  userInput(): void { if ((this.status === 'playing' || this.status === 'paused' || this.status === 'complete') && !this.free) { this.free = true; this.shot = ''; this.onChange(); } }
  directed(): void { this.free = false; this.shot = ''; this.onChange(); }

  /** End the visualization and put back the view, the camera and the timeline as they were before it started. */
  exit(): void {
    if (this.status === 'idle') return;
    this.gen++;
    this.status = 'exiting';
    this.onChange();
    this.teardown();
    const s = this.saved;
    this.saved = null; this.v = null; this.tl = null; this.replay = null;
    this.status = 'idle';
    if (s) this.host.restore(s);
    const cb = this.onExit; this.onExit = null;
    this.onChange();
    cb?.();
  }

  private teardown(): void {
    this.layer?.dispose();
    this.layer = null;
    if (this.planetHost) { this.planetHost.extraLabels = null; this.planetHost.holdSpin(false); }
    this.planetHost = null;
    this.host.rig.follow(null);
    if (this.shakeOff.lengthSq()) { this.host.camera.position.sub(this.shakeOff); this.shakeOff.set(0, 0, 0); }
    this.quality = 'high'; this.slow = 0;
  }
}

function maxEffect(v: VisualScenario): number {
  const f = v.effects;
  return Math.max(f.blastKm?.kPa7 ?? 0, f.thermalKm ?? 0, f.ejecta1mKm ?? 0, f.tsunami?.radius1mKm ?? 0, (f.plume?.scarDiameterKm[1] ?? 0) / 2, (f.crater?.finalKm ?? 0) * 3);
}
