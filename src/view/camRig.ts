// Every automatic move of the sim camera goes through one rig: flights between
// zoom levels, travel to a selected world or craft, the glide that hands control
// back when someone grabs the view mid-flight, and the user's own zoom, which
// eases to where the wheel, pinch or buttons asked instead of stepping there.
//
// A move is a "leg" whose pose is a pure function of its normalized time k, so
// it plays the same at 30 fps or 240 (the clock is the frame's dt). States:
//   idle    — OrbitControls drive; the rig smooths zoom, follows the focus, keeps limits soft
//   flying  — a leg owns the camera (controls off); finishing it returns to idle
//   handoff — an interrupted leg's velocity glides out under the user's control (part of idle)
// A travel leg pulls away on an arc, turns toward the destination while still slow,
// accelerates, cruises, decelerates over a longer stretch and settles into a
// viewing orbit around the destination's live position, then keeps following it.

import * as THREE from 'three';

export type Ease = (x: number) => number;
export const easeInOutCubic: Ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutCubic: Ease = (x) => 1 - (1 - x) ** 3;
export const easeInOutSine: Ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
/** Quintic: zero speed and zero acceleration at both ends. */
export const smootherstep: Ease = (x) => x * x * x * (x * (6 * x - 15) + 10);

/**
 * Travel progress at normalized time k. Speed rises as sin² over the first `a`, cruises,
 * and falls as sin² over the last `b`: no jerk spikes, and zero speed and acceleration at both ends,
 * so nothing can overshoot.
 */
export function travelProfile(k: number, a: number, b: number): number {
  const x = Math.min(1, Math.max(0, k)), area = 1 - a / 2 - b / 2;
  let s: number;
  if (x < a) s = x / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * x) / a);
  else if (x <= 1 - b) s = a / 2 + (x - a);
  else { const y = 1 - x; s = area - (y / 2 - (b / (2 * Math.PI)) * Math.sin((Math.PI * y) / b)); }
  return s / area;
}
/** d(progress)/dk of travelProfile; its peak is 1 / (1 - a/2 - b/2). */
export function travelSpeed(k: number, a: number, b: number): number {
  const x = Math.min(1, Math.max(0, k)), area = 1 - a / 2 - b / 2;
  const v = x < a ? Math.sin((Math.PI * x) / (2 * a)) ** 2 : x <= 1 - b ? 1 : Math.sin((Math.PI * (1 - x)) / (2 * b)) ** 2;
  return v / area;
}
const ACCEL = 0.3, DECEL = 0.45; // decelerate over longer than we accelerate: the arrival is the part people watch

export type MotionPreset = 'cinematic' | 'balanced' | 'instant';
export interface MotionSpec {
  label: string;
  travel: number;      // travel duration multiplier
  minDur: number; maxDur: number;
  arc: number;         // height of the travel arc, as a share of the distance
  fovKick: number;     // degrees the view widens at cruise speed
  level: number;       // duration multiplier for flights between zoom levels
  zoomRate: number;    // 1/s: how fast zoom catches up with the wheel
  glide: number;       // 1/s: how fast an interrupted flight's speed dies away
}
export const PRESETS: Record<MotionPreset, MotionSpec> = {
  cinematic: { label: 'Cinematic', travel: 1.5, minDur: 1.8, maxDur: 7, arc: 0.3, fovKick: 6, level: 1.3, zoomRate: 7, glide: 2.5 },
  balanced: { label: 'Balanced', travel: 1, minDur: 1, maxDur: 4, arc: 0.2, fovKick: 3.5, level: 1, zoomRate: 10, glide: 3.5 },
  instant: { label: 'Instant', travel: 0.25, minDur: 0.2, maxDur: 0.45, arc: 0, fovKick: 0, level: 0.4, zoomRate: 22, glide: 9 },
};

/** The parts of OrbitControls the rig touches. */
export interface RigControls {
  target: THREE.Vector3;
  enabled: boolean;
  minDistance: number;
  maxDistance: number;
  rotateSpeed?: number;
  update(): unknown;
}

export interface TravelOpts {
  /** live position of the destination, read every frame (null: it is gone, keep the last one) */
  dest: () => THREE.Vector3 | null;
  /** camera distance from it on arrival */
  dist: number;
  /** a preferred side to arrive on (toward the star, away from the planet…), blended with the approach */
  side?: THREE.Vector3 | null;
  /** zoom limits while it is the focus */
  limits?: [number, number];
  label?: string;
  /** simulated years per second now: a fast clock moves the destination, so travel is quicker */
  yearRate?: number;
  done?: () => void;
}

interface Leg {
  travel: boolean;
  interruptible: boolean;
  t: number; dur: number;
  ease: Ease;
  done?: () => void;
  // orbit legs: target moves straight, direction slerps, distance changes in log space
  t0: THREE.Vector3; t1: THREE.Vector3; d0: THREE.Vector3; q: THREE.Quaternion; l0: number; l1: number;
  // travel legs
  p0: THREE.Vector3; offset: THREE.Vector3; arcDir: THREE.Vector3; arcH: number; carry: THREE.Vector3;
  look0: THREE.Vector3; turnEnd: number; dest?: () => THREE.Vector3 | null; destAt: THREE.Vector3;
  follow: boolean; limits?: [number, number];
}

const UP = new THREE.Vector3(0, 1, 0);
const tv1 = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const tq = new THREE.Quaternion(), qI = new THREE.Quaternion();

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: RigControls;
  preset: MotionPreset = 'balanced';
  /** prefers-reduced-motion: no arcs, no FOV changes, short flights */
  reduced = false;
  /** pushes a camera position out of anything solid (set by the app; views know their planets) */
  keepClear: ((p: THREE.Vector3) => void) | null = null;
  /** what the camera is looking at now: the pivot of a flight, else the controls target */
  readonly pivot = new THREE.Vector3();
  /** 0..1, how fast an automatic travel is going now (the ship's engines and the HUD read it) */
  speed = 0;
  label = '';
  progress = 0;
  baseFov: number;
  private leg: Leg | null = null;
  private glide = new THREE.Vector3();
  private gliding = false;
  private followFn: (() => THREE.Vector3 | null) | null = null;
  private followAt = new THREE.Vector3();
  private zoomGoal = NaN;
  private lim: [number, number] = [0, Infinity];
  private vel = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private havePrev = false;
  private timeScale = 1;
  private hurrying = false;
  private skipping = false;

  constructor(camera: THREE.PerspectiveCamera, controls: RigControls) {
    this.camera = camera;
    this.controls = controls;
    this.baseFov = camera.fov;
  }

  get flying(): boolean { return !!this.leg; }
  get travelling(): boolean { return !!this.leg?.travel; }
  get following(): boolean { return !!this.followFn; }
  /** the length of the current flight in seconds, at normal speed */
  get duration(): number { return this.leg?.dur ?? 0; }

  get spec(): MotionSpec {
    const s = PRESETS[this.preset];
    return this.reduced ? { ...s, arc: 0, fovKick: 0, travel: Math.min(s.travel, 0.4), maxDur: Math.min(s.maxDur, 0.8), level: Math.min(s.level, 0.6) } : s;
  }

  /** Zoom limits for what is in view. Applied softly: a camera already outside them eases back in. */
  setLimits(min: number, max: number): void { this.lim[0] = min; this.lim[1] = max; }

  /** Zoom by a factor of the current distance (<1 in). Near the inner limit the steps shrink, for precise approach. */
  zoomBy(s: number): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    const from = Number.isFinite(this.zoomGoal) ? this.zoomGoal : d;
    const [lo, hi] = this.lim;
    if (s < 1 && lo > 0) s **= Math.min(1, Math.max(0.25, Math.log(from / lo) / Math.log(4)));
    this.zoomGoal = Math.min(Math.max(from * s, Math.min(lo, d)), Math.max(hi, d));
  }

  /** Forget motion across a cut (a level swap moves the camera to another scene); a flight still going is dropped. */
  resetMotion(): void {
    if (this.leg) { this.leg = null; this.handBack(); }
    this.label = '';
    this.speed = 0;
    this.pivot.copy(this.controls.target);
    this.havePrev = false;
    this.vel.set(0, 0, 0);
    this.gliding = false;
    this.zoomGoal = NaN;
    this.followFn = null;
  }

  follow(fn: (() => THREE.Vector3 | null) | null): void {
    this.followFn = fn;
    const p = fn?.();
    if (p) this.followAt.copy(p); else this.followFn = null;
  }

  /** Fly to a pose: the target moves straight, the view direction slerps, the distance changes in log space. */
  orbitTo(pos: THREE.Vector3, target: THREE.Vector3, dur: number, ease: Ease, done?: () => void, interruptible = false): void {
    const leg = this.newLeg(false, interruptible, dur, ease, done);
    const o0 = tv1.copy(this.camera.position).sub(this.controls.target), o1 = tv2.copy(pos).sub(target);
    leg.l0 = Math.max(o0.length(), 1e-6); leg.l1 = Math.max(o1.length(), 1e-6);
    leg.d0.copy(o0).divideScalar(leg.l0);
    leg.q.setFromUnitVectors(leg.d0, o1.divideScalar(leg.l1));
    leg.t0.copy(this.controls.target); leg.t1.copy(target);
    this.begin(leg);
  }

  /** Travel to a (possibly moving) thing and settle into a viewing orbit around it. Returns the duration. */
  travel(o: TravelOpts): number {
    const now = o.dest();
    if (!now) return 0;
    const cam = this.camera, sp = this.spec;
    const leg = this.newLeg(true, true, 1, smootherstep, o.done);
    leg.dest = o.dest; leg.destAt.copy(now); leg.follow = true; leg.limits = o.limits;
    leg.p0.copy(cam.position);
    // start the turn from exactly where the camera faces (mid-turn that isn't the pivot)
    const piv = this.leg ? this.pivot : this.controls.target;
    leg.look0.set(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(Math.max(1e-4, cam.position.distanceTo(piv))).add(cam.position);
    // carry the speed we already have (a new pick mid-flight) so the path bends instead of stopping dead
    leg.carry.copy(this.vel);
    // arrive from the side we come from, leaning toward the preferred side and a little above
    const dir = tv1.copy(cam.position).sub(now);
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
    dir.normalize();
    if (o.side && o.side.lengthSq() > 1e-12) dir.add(tv2.copy(o.side).normalize()).normalize();
    dir.addScaledVector(UP, 0.35).normalize();
    leg.offset.copy(dir).multiplyScalar(o.dist);
    const chord = tv2.copy(now).add(leg.offset).sub(leg.p0), len = chord.length();
    // the arc rises away from the chord, toward "up" and back the way the camera faces from
    const away = tv3.copy(cam.position).sub(this.controls.target);
    if (away.lengthSq() > 1e-12) away.normalize();
    leg.arcDir.copy(UP).addScaledVector(away, 0.5);
    if (len > 1e-9) leg.arcDir.addScaledVector(chord, -leg.arcDir.dot(chord) / (len * len));
    if (leg.arcDir.lengthSq() < 1e-12) leg.arcDir.copy(UP);
    leg.arcDir.normalize();
    leg.arcH = sp.arc * len;
    // turn through a big angle over longer, so the view never whips round
    const fwd = tv3.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const ang = fwd.angleTo(tv1.copy(now).sub(cam.position));
    leg.turnEnd = Math.min(0.6, 0.25 + (ang / Math.PI) * 0.35);
    // time: grows with the distance in units of the current view, shrinks while the clock runs fast
    const scale = Math.max(1e-6, cam.position.distanceTo(this.controls.target), o.dist);
    const sim = 1 / (1 + 0.2 * Math.log10(1 + Math.abs(o.yearRate ?? 0)));
    const base = (1 + 0.85 * Math.log2(1 + len / scale)) * sp.travel * sim;
    leg.dur = Math.min(sp.maxDur, Math.max(sp.minDur, base));
    this.label = o.label ?? '';
    this.begin(leg);
    return leg.dur;
  }

  /**
   * Someone grabbed the view. A travel stops where it is and its speed glides out under their hand;
   * a flight between levels can't stop halfway (the scene swaps at its end), so it hurries instead.
   */
  interrupt(): boolean {
    const l = this.leg;
    if (!l) return false;
    if (!l.interruptible) { this.skipping = true; return false; }
    this.leg = null;
    // the new pivot sits straight ahead, so control resumes facing exactly where we were
    const fwd = tv1.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const d = Math.max(this.camera.position.distanceTo(this.pivot), 1e-4);
    this.controls.target.copy(this.camera.position).addScaledVector(fwd, d);
    this.glide.copy(this.vel);
    this.gliding = this.glide.lengthSq() > 0;
    this.followFn = null;
    this.handBack();
    this.label = '';
    return true;
  }

  /** Get there sooner: the rest of the flight plays faster, still easing in to rest. */
  skip(): void { if (this.leg) this.skipping = true; }
  hurry(on: boolean): void { this.hurrying = on; }

  frame(dt: number): void {
    const cam = this.camera, c = this.controls, sp = this.spec;
    if (this.leg) this.stepLeg(dt);
    if (!this.leg) {
      // an interrupted flight's speed carries on and dies away; target and camera move together, so it never fights a drag
      if (this.gliding) {
        tv1.copy(this.glide).multiplyScalar(dt);
        cam.position.add(tv1); c.target.add(tv1);
        this.glide.multiplyScalar(Math.exp(-dt * sp.glide));
        if (this.glide.lengthSq() < 1e-12) this.gliding = false;
      }
      // the focus moves (planets orbit): carry the camera with it, keeping whatever the user did around it
      if (this.followFn) {
        const p = this.followFn();
        if (!p) this.followFn = null;
        else {
          tv1.copy(p).sub(this.followAt);
          cam.position.add(tv1); c.target.add(tv1);
          this.followAt.copy(p);
        }
      }
      const d = cam.position.distanceTo(c.target);
      const [lo, hi] = this.lim;
      // soft limits: OrbitControls never clamps the camera past where it already is, the rig eases it back
      c.minDistance = Math.min(lo, d);
      c.maxDistance = Math.max(hi, d);
      if (d < lo * 0.999 && !(this.zoomGoal >= lo)) this.zoomGoal = lo;
      else if (d > hi * 1.001 && !(this.zoomGoal <= hi)) this.zoomGoal = hi;
      if (Number.isFinite(this.zoomGoal) && d > 0) {
        // exact exponential approach in log distance: the same curve at any frame rate, never past the goal
        const g = this.zoomGoal, nd = g * Math.pow(d / g, Math.exp(-dt * sp.zoomRate));
        const done = Math.abs(Math.log(nd / g)) < 1e-4;
        cam.position.sub(c.target).multiplyScalar((done ? g : nd) / d).add(c.target);
        if (done) this.zoomGoal = NaN;
      }
      // slower, finer rotation close in
      if (c.rotateSpeed !== undefined && lo > 0) c.rotateSpeed = 0.5 * (0.55 + 0.45 * Math.min(1, Math.max(0, Math.log(d / lo) / Math.log(4))));
      if (cam.fov !== this.baseFov) {
        const f = this.baseFov + (cam.fov - this.baseFov) * Math.exp(-dt * 5);
        cam.fov = Math.abs(f - this.baseFov) < 0.01 ? this.baseFov : f;
        cam.updateProjectionMatrix();
      }
      c.update();
      if (this.keepClear) { this.keepClear(cam.position); cam.lookAt(c.target); }
      this.pivot.copy(c.target);
      this.speed *= Math.exp(-dt * 6);
    }
    if (this.havePrev && dt > 0) this.vel.copy(cam.position).sub(this.prev).divideScalar(dt);
    else this.vel.set(0, 0, 0);
    this.prev.copy(cam.position);
    this.havePrev = true;
  }

  // ---------------------------------------------------------------- legs

  private newLeg(travel: boolean, interruptible: boolean, dur: number, ease: Ease, done?: () => void): Leg {
    const l = this.leg; // reuse the vectors of the leg it replaces
    const leg: Leg = l ?? {
      travel, interruptible, t: 0, dur, ease, done,
      t0: new THREE.Vector3(), t1: new THREE.Vector3(), d0: new THREE.Vector3(), q: new THREE.Quaternion(), l0: 1, l1: 1,
      p0: new THREE.Vector3(), offset: new THREE.Vector3(), arcDir: new THREE.Vector3(), arcH: 0, carry: new THREE.Vector3(),
      look0: new THREE.Vector3(), turnEnd: 0.4, destAt: new THREE.Vector3(), follow: false,
    };
    leg.travel = travel; leg.interruptible = interruptible; leg.t = 0; leg.dur = Math.max(1e-3, dur); leg.ease = ease; leg.done = done;
    leg.dest = undefined; leg.follow = false; leg.limits = undefined; leg.carry.set(0, 0, 0);
    return leg;
  }

  private begin(leg: Leg): void {
    if (!leg.travel) this.label = '';
    this.leg = leg;
    this.gliding = false;
    this.zoomGoal = NaN;
    this.followFn = null;
    this.timeScale = 1;
    this.skipping = false;
    this.progress = 0;
    this.controls.enabled = false;
  }

  private stepLeg(dt: number): void {
    const l = this.leg!, cam = this.camera, sp = this.spec;
    const want = this.skipping ? 6 : this.hurrying ? 3 : 1;
    this.timeScale = want + (this.timeScale - want) * Math.exp(-dt * 6);
    l.t = Math.min(l.dur, l.t + dt * this.timeScale);
    const k = l.t / l.dur;
    this.progress = k;
    if (l.travel) {
      const p = l.dest!();
      if (p) l.destAt.copy(p);
      const u = travelProfile(k, ACCEL, DECEL);
      const end = tv1.copy(l.destAt).add(l.offset);
      cam.position.copy(l.p0).lerp(end, u).addScaledVector(l.arcDir, l.arcH * Math.sin(Math.PI * u));
      // Hermite term k(1-k)²: starts at the speed we had, gone by the end
      cam.position.addScaledVector(l.carry, l.dur * k * (1 - k) * (1 - k));
      this.pivot.copy(l.look0).lerp(l.destAt, u);
      this.keepClear?.(cam.position);
      // look: slerp from where we faced at the start to the destination, finished while still slow
      const w = smootherstep(Math.min(1, k / l.turnEnd));
      const d0 = tv2.copy(l.look0).sub(l.p0).normalize(), d1 = tv3.copy(l.destAt).sub(cam.position).normalize();
      tq.setFromUnitVectors(d0, d1);
      qI.identity().slerp(tq, w);
      cam.lookAt(tv2.copy(d0).applyQuaternion(qI).add(cam.position));
      const s = travelSpeed(k, ACCEL, DECEL) * (1 - ACCEL / 2 - DECEL / 2);
      this.speed = s;
      const fov = this.baseFov + sp.fovKick * s * s;
      if (Math.abs(cam.fov - fov) > 0.005) { cam.fov = fov; cam.updateProjectionMatrix(); }
    } else {
      const e = l.ease(k);
      this.controls.target.lerpVectors(l.t0, l.t1, e);
      qI.identity().slerp(l.q, e);
      cam.position.copy(l.d0).applyQuaternion(qI).multiplyScalar(Math.exp(Math.log(l.l0) + (Math.log(l.l1) - Math.log(l.l0)) * e)).add(this.controls.target);
      this.keepClear?.(cam.position);
      cam.lookAt(this.controls.target);
      this.pivot.copy(this.controls.target);
    }
    if (k < 1) return;
    // arrived: the controls take over from exactly this pose
    this.leg = null;
    if (l.travel) {
      this.controls.target.copy(l.destAt);
      this.pivot.copy(l.destAt);
      if (l.limits) this.setLimits(l.limits[0], l.limits[1]);
      if (l.follow && l.dest) { this.followFn = l.dest; this.followAt.copy(l.destAt); }
    }
    this.label = '';
    this.handBack();
    l.done?.();
  }

  private handBack(): void {
    this.controls.enabled = true;
    // drop any damping momentum left from before the flight
    const c = this.controls as unknown as { _sphericalDelta?: THREE.Spherical; _panOffset?: THREE.Vector3; _scale?: number };
    c._sphericalDelta?.set(0, 0, 0); c._panOffset?.set(0, 0, 0);
    if (c._scale !== undefined) c._scale = 1;
  }
}
