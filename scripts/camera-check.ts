// Checks the camera rig (src/view/camRig.ts): easing curves, the travel profile,
// frame-rate independence, no overshoot or snaps, interruption and retargeting.
// Exit code 1 on any failure.
//   node scripts/camera-check.ts

import * as THREE from 'three';
import { CameraRig, PRESETS, easeInOutCubic, easeInOutSine, easeOutCubic, smootherstep, travelProfile, travelSpeed, type MotionPreset, type RigControls } from '../src/view/camRig.ts';

let bad = 0, n = 0;
const ok = (cond: boolean, what: string) => { n++; if (!cond) { bad++; console.log(`FAIL ${what}`); } };
const section = (s: string) => console.log(`— ${s}`);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Stand-in for OrbitControls: clamps the distance and looks at the target, as its update() does. */
class FakeControls implements RigControls {
  target = new THREE.Vector3();
  enabled = true;
  minDistance = 0;
  maxDistance = Infinity;
  rotateSpeed = 0.5;
  private cam: THREE.PerspectiveCamera;
  constructor(cam: THREE.PerspectiveCamera) { this.cam = cam; }
  update(): void {
    const off = this.cam.position.clone().sub(this.target), d = off.length();
    const c = Math.min(this.maxDistance, Math.max(this.minDistance, d));
    if (d > 0 && c !== d) this.cam.position.copy(this.target).addScaledVector(off, c / d);
    this.cam.lookAt(this.target);
  }
}

function setup(preset: MotionPreset = 'balanced') {
  const cam = new THREE.PerspectiveCamera(55, 1.6, 0.01, 1e7);
  const ctl = new FakeControls(cam);
  cam.position.set(10, 6, 30);
  ctl.update();
  const rig = new CameraRig(cam, ctl);
  rig.preset = preset;
  rig.setLimits(1.5, 900);
  rig.frame(1 / 60);
  return { cam, ctl, rig };
}

/** Run whole frames at `fps` for `secs`; `before` sees the frame's time first (to move things), `each` after. */
function run(rig: CameraRig, fps: number, secs: number, each?: (t: number) => void, before?: (t: number) => void): void {
  const dt = 1 / fps, frames = Math.round(secs * fps);
  for (let i = 1; i <= frames; i++) { before?.(i * dt); rig.frame(dt); each?.(i * dt); }
}

section('easing curves');
for (const [name, f] of [['easeInOutCubic', easeInOutCubic], ['easeOutCubic', easeOutCubic], ['easeInOutSine', easeInOutSine], ['smootherstep', smootherstep]] as const) {
  ok(near(f(0), 0, 1e-12) && near(f(1), 1, 1e-12), `${name} runs 0 → 1`);
  let mono = true, inside = true;
  for (let i = 1; i <= 1000; i++) { const a = f((i - 1) / 1000), b = f(i / 1000); if (b < a - 1e-12) mono = false; if (b < -1e-12 || b > 1 + 1e-12) inside = false; }
  ok(mono, `${name} never goes backwards`);
  ok(inside, `${name} never overshoots`);
}

section('travel profile');
{
  const a = 0.3, b = 0.45;
  ok(near(travelProfile(0, a, b), 0, 1e-12) && near(travelProfile(1, a, b), 1, 1e-12), 'progress runs 0 → 1');
  ok(near(travelSpeed(0, a, b), 0, 1e-12) && near(travelSpeed(1, a, b), 0, 1e-12), 'starts and ends at rest');
  let mono = true, maxErr = 0, maxJump = 0;
  for (let i = 1; i <= 4000; i++) {
    const k0 = (i - 1) / 4000, k1 = i / 4000;
    const p0 = travelProfile(k0, a, b), p1 = travelProfile(k1, a, b);
    if (p1 < p0) mono = false;
    // the closed-form speed matches the numerical derivative, and has no jumps (continuous acceleration)
    maxErr = Math.max(maxErr, Math.abs((p1 - p0) * 4000 - travelSpeed((k0 + k1) / 2, a, b)));
    maxJump = Math.max(maxJump, Math.abs(travelSpeed(k1, a, b) - travelSpeed(k0, a, b)));
  }
  ok(mono, 'progress never goes backwards');
  ok(maxErr < 1e-3, `speed is the derivative of progress (max error ${maxErr.toExponential(1)})`);
  ok(maxJump < 3e-3, `speed changes smoothly (largest step ${maxJump.toExponential(1)})`);
  ok(travelProfile(0.15, a, b) < 0.08, 'accelerates gently: little ground covered in the first 15%');
  ok(1 - travelProfile(0.85, a, b) < 0.08, 'decelerates gradually: little ground left in the last 15%');
}

section('travel: frame-rate independence, arrival, no overshoot');
{
  const dest = new THREE.Vector3(120, 0, -40);
  const ends: THREE.Vector3[] = [], mids: THREE.Vector3[] = [];
  let dur = 0;
  for (const fps of [24, 30, 60, 144, 240]) {
    const { cam, ctl, rig } = setup();
    dur = rig.travel({ dest: () => dest, dist: 8, limits: [2, 900] });
    let mid: THREE.Vector3 | null = null, last = cam.position.clone(), lastStep = Infinity, rising = 0, distPrev = Infinity, maxStep = 0;
    run(rig, fps, dur + 0.5, (t) => {
      if (!mid && t >= dur / 2) mid = cam.position.clone();
      const step = cam.position.distanceTo(last) * fps; // speed, units/s
      maxStep = Math.max(maxStep, step);
      if (t > dur * 0.95 && t <= dur) lastStep = step;
      // once past the middle, the camera only ever closes in on its arrival point
      const dEnd = cam.position.distanceTo(dest.clone().add(new THREE.Vector3(0, 0, 0)));
      if (t > dur * 0.55 && t <= dur && dEnd > distPrev + 1e-6) rising++;
      if (t > dur * 0.55) distPrev = dEnd;
      last = cam.position.clone();
    });
    ok(!rig.flying && ctl.enabled, `${fps} fps: flight ends and the controls take over`);
    ok(near(cam.position.distanceTo(dest), 8, 0.05), `${fps} fps: settles at the viewing distance (${cam.position.distanceTo(dest).toFixed(3)})`);
    ok(ctl.target.distanceTo(dest) < 1e-6, `${fps} fps: orbit pivot is the destination`);
    ok(rising === 0, `${fps} fps: no overshoot on the way in`);
    ok(lastStep < maxStep * 0.12, `${fps} fps: arrives slowly (${lastStep.toFixed(2)} vs peak ${maxStep.toFixed(1)} units/s)`);
    ends.push(cam.position.clone()); mids.push(mid!);
  }
  const spread = (vs: THREE.Vector3[]) => Math.max(...vs.map((v) => v.distanceTo(vs[2])));
  ok(spread(ends) < 1e-3, `same arrival pose at every frame rate (spread ${spread(ends).toExponential(1)})`);
  ok(spread(mids) < 0.05 * dest.length(), `same path at every frame rate (mid-flight spread ${spread(mids).toFixed(3)})`);
  ok(dur >= PRESETS.balanced.minDur && dur <= PRESETS.balanced.maxDur, `duration within the preset (${dur.toFixed(2)}s)`);
}

section('travel: moving destination, then following it');
{
  const { cam, ctl, rig } = setup();
  let t = 0;
  const dest = new THREE.Vector3();
  const where = () => dest.set(Math.cos(t * 0.4) * 60, 0, -Math.sin(t * 0.4) * 60);
  const dur = rig.travel({ dest: where, dist: 6 });
  run(rig, 60, dur + 1 / 60, undefined, (tt) => { t = tt; });
  ok(near(cam.position.distanceTo(where()), 6, 0.1), 'arrives at the moving destination');
  const off = cam.position.clone().sub(where());
  let maxDrift = 0;
  const t0 = t;
  run(rig, 60, 3, () => { maxDrift = Math.max(maxDrift, cam.position.clone().sub(where()).distanceTo(off)); }, (tt) => { t = t0 + tt; });
  ok(maxDrift < 0.05, `keeps the same view of it as it moves (drift ${maxDrift.toFixed(4)})`);
  ok(ctl.target.distanceTo(where()) < 1e-3, 'stays centred on it');
}

section('retargeting mid-flight keeps the motion continuous');
{
  const { cam, rig } = setup('cinematic');
  const a = new THREE.Vector3(200, 0, 0), b = new THREE.Vector3(-150, 20, 80);
  rig.travel({ dest: () => a, dist: 8 });
  const fps = 120, dt = 1 / fps;
  let prev = cam.position.clone(), v0 = new THREE.Vector3();
  run(rig, fps, 1.2, () => { v0 = cam.position.clone().sub(prev).divideScalar(dt); prev = cam.position.clone(); });
  rig.travel({ dest: () => b, dist: 8 });
  rig.frame(dt);
  const v1 = cam.position.clone().sub(prev).divideScalar(dt);
  ok(v1.distanceTo(v0) < 0.08 * v0.length() + 1, `velocity carries across the new pick (${v0.length().toFixed(1)} → ${v1.length().toFixed(1)} units/s)`);
  const d = rig.duration;
  run(rig, fps, d + 0.2);
  ok(near(cam.position.distanceTo(b), 8, 0.05), 'and still arrives at the new destination');
}

section('interrupting hands control back without a snap');
{
  const { cam, ctl, rig } = setup();
  const dest = new THREE.Vector3(300, 0, 0);
  rig.travel({ dest: () => dest, dist: 8 });
  const fps = 60, dt = 1 / fps;
  let prev = cam.position.clone(), v = 0;
  run(rig, fps, 1.0, () => { v = cam.position.distanceTo(prev) / dt; prev = cam.position.clone(); });
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const before = cam.position.clone();
  ok(rig.interrupt(), 'a travel can be interrupted');
  ok(ctl.enabled && !rig.flying, 'controls are back on');
  const toT = ctl.target.clone().sub(cam.position).normalize();
  ok(fwd.dot(toT) > 0.99999, 'the new pivot is straight ahead (the view does not turn)');
  rig.frame(dt);
  const fwd2 = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  ok(fwd.angleTo(fwd2) < 0.01, `no jump in orientation (${fwd.angleTo(fwd2).toExponential(1)} rad)`);
  const v1 = cam.position.distanceTo(before) / dt;
  ok(v1 <= v * 1.05 + 1e-6 && v1 > v * 0.5, `speed glides on instead of stopping dead (${v.toFixed(1)} → ${v1.toFixed(1)})`);
  let speeds: number[] = [];
  prev = cam.position.clone();
  run(rig, fps, 2, () => { speeds.push(cam.position.distanceTo(prev) / dt); prev = cam.position.clone(); });
  ok(speeds.every((s, i) => i === 0 || s <= speeds[i - 1] + 1e-6), 'and only slows down');
  ok(speeds[speeds.length - 1] < v * 0.05, 'until it comes to rest');
}

section('level flights cannot stop halfway: interrupting hurries them');
{
  const { cam, ctl, rig } = setup();
  let done = 0;
  rig.orbitTo(new THREE.Vector3(0, 2, 5), new THREE.Vector3(), 2, easeInOutCubic, () => done++);
  run(rig, 60, 0.5);
  ok(!rig.interrupt() && rig.flying, 'still flying after an interrupt');
  run(rig, 60, 1.0);
  ok(done === 1, 'but finishes well before its 2 s');
  ok(near(cam.position.distanceTo(ctl.target), Math.hypot(2, 5), 1e-6), 'at exactly its end pose');
}

section('skip');
{
  const { cam, rig } = setup('cinematic');
  const dest = new THREE.Vector3(500, 0, 0);
  const dur = rig.travel({ dest: () => dest, dist: 8 });
  run(rig, 60, 0.4);
  rig.skip();
  let t = 0, last = cam.position.clone(), lastSpeed = 0;
  while (rig.flying && t < dur) { rig.frame(1 / 60); t += 1 / 60; lastSpeed = cam.position.distanceTo(last) * 60; last = cam.position.clone(); }
  ok(!rig.flying && t < dur * 0.4, `skipping arrives much sooner (${(0.4 + t).toFixed(2)}s of ${dur.toFixed(2)}s)`);
  ok(near(cam.position.distanceTo(dest), 8, 0.05), 'at the proper viewing distance');
  ok(lastSpeed < 40, `still easing in at the end (${lastSpeed.toFixed(1)} units/s)`);
}

section('zoom: smooth, never past the goal, same at any frame rate');
{
  const results: number[] = [];
  for (const fps of [30, 60, 120]) {
    const { cam, ctl, rig } = setup();
    const d0 = cam.position.distanceTo(ctl.target);
    rig.zoomBy(0.5);
    let prev = d0, mono = true, maxStepRatio = 0;
    run(rig, fps, 0.2, () => { const d = cam.position.distanceTo(ctl.target); if (d > prev + 1e-9) mono = false; maxStepRatio = Math.max(maxStepRatio, prev / d); prev = d; });
    results.push(cam.position.distanceTo(ctl.target));
    run(rig, fps, 2);
    const d = cam.position.distanceTo(ctl.target);
    ok(mono, `${fps} fps: closes in without bouncing`);
    // one frame covers no more of the way than the exponential curve allows for that frame's length
    const bound = Math.exp(Math.log(2) * (1 - Math.exp(-PRESETS.balanced.zoomRate / fps)));
    ok(maxStepRatio <= bound + 1e-9, `${fps} fps: each frame follows the curve (${maxStepRatio.toFixed(3)}× ≤ ${bound.toFixed(3)}×)`);
    ok(near(d, d0 * 0.5, 1e-6), `${fps} fps: lands exactly on the asked distance`);
  }
  ok(Math.max(...results) - Math.min(...results) < 0.02, `same distance at the same moment at 30, 60 and 120 fps (${results.map((r) => r.toFixed(3)).join(', ')})`);
  // near the inner limit each wheel step is smaller
  const { cam, ctl, rig } = setup();
  rig.setLimits(10, 900);
  const far0 = cam.position.distanceTo(ctl.target);
  rig.zoomBy(0.8); run(rig, 60, 2);
  const farStep = far0 / cam.position.distanceTo(ctl.target);
  cam.position.sub(ctl.target).setLength(12).add(ctl.target);
  rig.zoomBy(0.8); run(rig, 60, 2);
  const nearStep = 12 / cam.position.distanceTo(ctl.target);
  ok(nearStep < farStep, `finer steps near the limit (${nearStep.toFixed(3)}× vs ${farStep.toFixed(3)}×)`);
  ok(cam.position.distanceTo(ctl.target) >= 10 - 1e-9, 'and never through it');
}

section('limits are soft: no snap when the camera is outside them');
{
  const { cam, ctl, rig } = setup();
  cam.position.sub(ctl.target).setLength(2).add(ctl.target);
  rig.setLimits(11.5, 160);
  rig.frame(1 / 60);
  const d1 = cam.position.distanceTo(ctl.target);
  ok(d1 < 3, `first frame moves only a little (${d1.toFixed(3)})`);
  run(rig, 60, 3);
  ok(near(cam.position.distanceTo(ctl.target), 11.5, 1e-3), 'then eases out to the limit');
}

section('obstacles: the camera never ends up inside a planet');
{
  const { cam, rig } = setup();
  const planet = new THREE.Vector3(60, 0, -20), R = 5;
  rig.keepClear = (p) => { const d = p.distanceTo(planet); if (d < R) p.sub(planet).multiplyScalar(R / Math.max(d, 1e-9)).add(planet); };
  // a destination straight through the planet
  const dest = new THREE.Vector3(120, 0, -40);
  const dur = rig.travel({ dest: () => dest, dist: 8 });
  let inside = 0;
  run(rig, 60, dur + 0.5, () => { if (cam.position.distanceTo(planet) < R - 1e-6) inside++; });
  ok(inside === 0, 'stays outside along the whole flight');
}

section('many picks and interrupts in a row leave a sane state');
{
  const { cam, ctl, rig } = setup('cinematic');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const dest = new THREE.Vector3();
  let finite = true;
  for (let i = 0; i < 200; i++) {
    const r = rnd();
    if (r < 0.5) { dest.set(rnd() * 400 - 200, rnd() * 40 - 20, rnd() * 400 - 200); const p = dest.clone(); rig.travel({ dest: () => p, dist: 2 + rnd() * 10, limits: [1, 900] }); }
    else if (r < 0.65) rig.interrupt();
    else if (r < 0.75) rig.skip();
    else if (r < 0.85) rig.zoomBy(rnd() < 0.5 ? 0.7 : 1.4);
    else rig.orbitTo(new THREE.Vector3(rnd() * 50, 10, 40), new THREE.Vector3(), 0.3 + rnd(), easeInOutCubic);
    run(rig, [20, 60, 165][i % 3], rnd() * 0.6);
    for (const v of [cam.position, ctl.target, cam.quaternion]) if (![v.x, v.y, v.z].every(Number.isFinite)) finite = false;
    if (!Number.isFinite(cam.fov)) finite = false;
  }
  run(rig, 60, 10);
  ok(finite, 'no NaN or infinity anywhere');
  ok(!rig.flying && ctl.enabled, 'ends idle with the controls on');
  ok(near(cam.fov, 55, 1e-6), 'field of view back to normal');
}

section('reduced motion: shorter and simpler');
{
  const { rig } = setup('cinematic');
  rig.reduced = true;
  const dest = new THREE.Vector3(400, 0, 0);
  const dur = rig.travel({ dest: () => dest, dist: 8 });
  ok(dur <= 0.8 + 1e-9, `short (${dur.toFixed(2)}s)`);
  ok(rig.spec.arc === 0 && rig.spec.fovKick === 0, 'no arc, no change of field of view');
}

console.log(`\n${n - bad}/${n} camera checks passed`);
if (bad) process.exit(1);
