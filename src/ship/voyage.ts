// The Starship, flown inside the simulation. The ship lives in its own small
// scene drawn over the sim's view (before bloom, so its engines glow), with a
// camera that stays in chase or cockpit position. The sim's camera does the
// travelling; the ship reads how fast the world is moving past, whether we are
// jumping between scales, and how fast the year is changing, and answers with
// thrust, the warp tunnel and the chrono bubble.

import * as THREE from 'three';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Ship } from './ship.ts';

export type ShipView = 'chase' | 'cockpit';

/** What the simulation tells the ship every frame. */
export interface Motion {
  camera: THREE.PerspectiveCamera;  // the sim's camera
  orbit: THREE.Vector3;             // controls target (what we are looking at)
  jumping: boolean;                 // a flight between zoom levels is under way
  yearRate: number;                 // simulated years per real second, signed
}

const UP = new THREE.Vector3(0, 1, 0);

export class Voyage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  readonly ship = new Ship();
  readonly pass: RenderPass;
  boarded = false;
  view: ShipView = 'chase';
  private prevPos = new THREE.Vector3();
  private prevDir = new THREE.Vector3();
  private bank = 0;
  private yaw = 0;
  private haveprev = false;
  private sun = new THREE.DirectionalLight(0xfff1d6, 2.4);

  constructor(renderer: THREE.WebGLRenderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0x9ab8ff, 0x1a1410, 0.5));
    this.sun.position.set(4, 6, 3);
    this.scene.add(this.sun, this.ship.root);
    this.pass = new RenderPass(this.scene, this.camera);
    this.pass.clear = false;        // draw over the sim's frame
    this.pass.clearDepth = true;    // but never behind its geometry
    this.pass.enabled = false;
    this.setView('chase');
  }

  board(on: boolean): void {
    this.boarded = on;
    this.pass.enabled = on;
    this.haveprev = false;
  }

  setView(v: ShipView): void {
    this.view = v;
    this.ship.setFirstPerson(v === 'cockpit');
  }

  /** Light the hull from the direction of the nearest star, as the sim's camera sees it. */
  lightFrom(dirInView: THREE.Vector3): void {
    this.sun.position.copy(dirInView).normalize().multiplyScalar(10);
  }

  frame(dt: number, t: number, m: Motion): { throttle: number; warp: number; chrono: number; chronoDir: number } {
    const s = this.ship;
    if (!this.boarded) return { throttle: 0, warp: 0, chrono: 0, chronoDir: 1 };
    const cam = m.camera;
    this.camera.fov = cam.fov;
    this.camera.aspect = cam.aspect;

    // how fast the world streams past, relative to the scale we're at
    const dist = Math.max(1e-6, cam.position.distanceTo(m.orbit));
    const dir = tv1.copy(m.orbit).sub(cam.position).normalize();
    let speed = 0, turn = 0;
    if (this.haveprev && dt > 0) {
      speed = cam.position.distanceTo(this.prevPos) / dist / dt;
      turn = Math.atan2(tv2.crossVectors(this.prevDir, dir).dot(UP), this.prevDir.dot(dir)) / dt;
    }
    this.prevPos.copy(cam.position); this.prevDir.copy(dir); this.haveprev = true;

    const k = 1 - Math.exp(-dt * 3);
    const wantThrottle = Math.min(1, speed * 1.4 + (m.jumping ? 0.8 : 0)) * 0.95 + 0.05;
    const wantWarp = m.jumping ? 1 : Math.min(0.6, Math.max(0, speed - 0.6) * 0.5);
    const rate = Math.abs(m.yearRate);
    const wantChrono = rate < 0.5 ? 0 : Math.min(1, Math.log10(1 + rate) / 2.6);
    s.throttle += (wantThrottle - s.throttle) * k;
    s.warp += (wantWarp - s.warp) * (m.jumping ? 1 - Math.exp(-dt * 6) : k);
    s.chrono += (wantChrono - s.chrono) * (1 - Math.exp(-dt * 4));
    if (rate > 0.5) s.chronoDir = m.yearRate > 0 ? 1 : -1;
    s.speed = 40 + s.throttle * 120 + s.warp * 900;

    // bank into turns, yaw a little toward them, and keep a slow idle drift
    this.bank += (-turn * 0.6 - this.bank) * k;
    this.yaw += (turn * 0.25 - this.yaw) * k;
    s.root.rotation.set(Math.sin(t * 0.7) * 0.015, this.yaw, Math.max(-0.6, Math.min(0.6, this.bank)) + Math.sin(t * 0.5) * 0.02);
    s.update(dt, t);

    // our camera: behind and above the ship, or in the pilot's seat (the nose points +Z)
    if (this.view === 'cockpit') {
      this.camera.position.copy(s.cockpitEye).applyQuaternion(s.root.quaternion);
      this.camera.quaternion.copy(s.root.quaternion).multiply(FLIP);
    } else {
      this.camera.position.set(0, 1.9, -10.5);
      this.camera.up.copy(UP);
      this.camera.lookAt(0, 0.2, 6);
    }
    const fov = cam.fov + s.warp * 28 + s.chrono * 8;
    if (Math.abs(this.camera.fov - fov) > 0.01) this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    return { throttle: s.throttle, warp: s.warp, chrono: s.chrono, chronoDir: s.chronoDir };
  }
}

const tv1 = new THREE.Vector3(), tv2 = new THREE.Vector3();
const FLIP = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
