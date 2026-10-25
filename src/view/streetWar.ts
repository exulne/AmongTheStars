// War in the street. When the settlement's world is in a war (warState.ts),
// the street shows it:
//
//   battle    this world is its side's main world in the fight: the enemy has
//             landed. Squads of attackers in their colour bound toward a front
//             line across the city, defenders in ours hold behind cover, and
//             tracers cross between them; some fall and lie where they fell,
//             reinforcements walk up from the rear. Rockets arc in from the
//             enemy's side of the sky and burst among the buildings (flash,
//             fireball, debris, smoke that keeps rising from the ruins), some
//             met in the air by interceptors; our own batteries fire back.
//             Fires glow on the horizon, the sky takes their colour, and at
//             night searchlights sweep it. Civilians shelter or flee to the rear.
//   sending   this world sends forces to a fight elsewhere in its system (or
//             launched a kinetic strike): rockets climb out of the city.
//   struck    a kinetic strike from another star is in flight at this world:
//             sirens of light, and flashes far off on the horizon.
//
// Everything is a function of the war's id (whash) and the clock, so a war
// looks the same every time it is watched; nothing is kept between frames.
// View only: nothing here reaches the simulation.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import type { Agent } from './life.ts';
import { glowTex, pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';
import { bodyWars, whash, type BodyWar } from './warState.ts';

const MAX_SIDE = 200;                 // soldiers a side
const MAX_SEG = 2400, MAX_DOTS = 1400, MAX_SMOKE = 120, MAX_BLASTS = 14, MAX_LIGHTS = 4, FIRES = 6, SEARCH = 3;
const FLIGHT = 3.2;                   // seconds an incoming rocket is in the air
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1), FIRE = new THREE.Color(1, 0.45, 0.12), EMBER = new THREE.Color(0.55, 0.08, 0.02);
const SMOKE = new THREE.Color(0.34, 0.3, 0.27), INTERCEPT = new THREE.Color(0.6, 0.85, 1), EXHAUST = new THREE.Color(1, 0.7, 0.35);

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
const c1 = new THREE.Color(), c2 = new THREE.Color();
const fract = (x: number) => x - Math.floor(x);
const smooth = (x: number) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };

type Mode = 'battle' | 'sending' | 'struck';

export class StreetWar {
  readonly group = new THREE.Group();
  /** 0..1: how much the sky should take the colour of the fires (read by the street for its light). */
  raid = 0;
  /** what the war is, for the street's labels; null in peace */
  bw: BodyWar | null = null;
  private mode: Mode | null = null;
  private R = 10;
  private span = 0; // street grid spacing (0: no grid, an outpost)
  private road = 0; // half the width a soldier can use of a street
  private checkedAt = -1;
  // soldiers
  private troops: THREE.InstancedMesh;
  private troopWalk: THREE.InstancedBufferAttribute;
  // tracers, rocket trails, searchlight glints: one additive line buffer
  private lines: THREE.LineSegments;
  private lPos: Float32Array; private lCol: Float32Array; private ns = 0;
  // rocket heads, muzzle flashes, debris, soldiers seen from afar
  private dots: THREE.Points;
  private dPos: Float32Array; private dCol: Float32Array; private dSize: Float32Array; private nd = 0;
  private blasts: THREE.Sprite[] = []; private nb = 0;
  private smoke: THREE.Sprite[] = []; private nsm = 0;
  private lights: THREE.PointLight[] = []; private nl = 0;
  private fires: THREE.Sprite[] = [];
  private beams: THREE.Mesh[] = [];
  private frontAt = new THREE.Vector3();
  // the two sides as drawn: their own colours, pushed apart when they are too alike to tell apart in a firefight
  private ours = new THREE.Color(); private theirs = new THREE.Color();

  /** `geo` and `mat`: the street's own person figure, so soldiers are people too. */
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material) {
    const g = geo.clone();
    this.troopWalk = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SIDE * 2 * 2), 2);
    this.troopWalk.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aWalk', this.troopWalk);
    this.troops = new THREE.InstancedMesh(g, mat, MAX_SIDE * 2);
    this.troops.frustumCulled = false;
    this.troops.count = 0;
    this.troops.setColorAt(0, WHITE);

    const lg = new THREE.BufferGeometry();
    this.lPos = new Float32Array(MAX_SEG * 6); this.lCol = new Float32Array(MAX_SEG * 6);
    lg.setAttribute('position', new THREE.BufferAttribute(this.lPos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lCol, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;

    const dg = new THREE.BufferGeometry();
    this.dPos = new Float32Array(MAX_DOTS * 3); this.dCol = new Float32Array(MAX_DOTS * 3); this.dSize = new Float32Array(MAX_DOTS);
    dg.setAttribute('position', new THREE.BufferAttribute(this.dPos, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(this.dCol, 3));
    dg.setAttribute('size', new THREE.BufferAttribute(this.dSize, 1));
    this.dots = new THREE.Points(dg, pointsMaterial({ minPx: 1.5, maxPx: 40, sizeScale: 0.6 }));
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 5;

    const sprite = (blending: THREE.Blending) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending, depthWrite: false, transparent: true }));
      s.visible = false;
      return s;
    };
    for (let k = 0; k < MAX_BLASTS; k++) this.blasts.push(sprite(THREE.AdditiveBlending));
    for (let k = 0; k < MAX_SMOKE; k++) this.smoke.push(sprite(THREE.NormalBlending));
    for (let k = 0; k < FIRES; k++) this.fires.push(sprite(THREE.AdditiveBlending));
    for (let k = 0; k < MAX_LIGHTS; k++) { const l = new THREE.PointLight(0xff8a3a, 0, 0, 1); l.visible = false; this.lights.push(l); }
    const cone = new THREE.ConeGeometry(0.16, 1, 24, 1, true).rotateX(Math.PI).translate(0, 0.5, 0);
    for (let k = 0; k < SEARCH; k++) {
      const m = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      this.beams.push(m);
    }
    this.group.add(this.troops, this.lines, this.dots, ...this.blasts, ...this.smoke, ...this.fires, ...this.lights, ...this.beams);
    this.group.visible = false;
  }

  /** The soldiers' material: the street sets its clock so their limbs swing. */
  get material(): THREE.MeshStandardMaterial { return this.troops.material as THREE.MeshStandardMaterial; }

  /** Into a freshly built city (the street rebuilds its scene graph when the place changes). */
  attach(city: THREE.Group, R: number, span = 0, road = 0): void {
    this.R = R; this.span = span; this.road = road;
    city.add(this.group);
    this.checkedAt = -1;
  }

  /** Which war this world is in now; checked a few times a second. */
  private check(world: World, snap: StateMsg | null, body: number, year: number, t: number): void {
    if (t - this.checkedAt < 0.3 && this.checkedAt >= 0) return;
    this.checkedAt = t;
    const ws = bodyWars(world, snap, body, year);
    const fight = ws.find((w) => !w.war.kinetic && w.main);
    const struck = ws.find((w) => w.war.kinetic && !w.attacking && year < w.war.arrive + 2);
    const send = ws.find((w) => !w.war.kinetic || w.attacking);
    this.bw = fight ?? struck ?? send ?? null;
    if (this.bw) {
      const a = { h: 0, s: 0, l: 0 }, b = { h: 0, s: 0, l: 0 };
      this.bw.usColor.getHSL(a); this.bw.themColor.getHSL(b);
      const dh = Math.min(Math.abs(a.h - b.h), 1 - Math.abs(a.h - b.h));
      this.ours.setHSL(a.h, 0.85, 0.55);
      this.theirs.setHSL(dh < 0.15 ? (a.h + 0.5) % 1 : b.h, 0.85, 0.55);
    }
    this.mode = fight ? 'battle' : struck ? 'struck' : send ? 'sending' : null;
  }

  // ------------------------------------------------------------ geometry of the fight

  /** The attackers' direction (unit, in the city's plane), its tangent, and how far out the front line sits now. */
  private axes(t: number): { n: THREE.Vector3; tg: THREE.Vector3; front: number } {
    const id = this.bw!.war.id, th = whash(id, 1) * Math.PI * 2;
    const n = new THREE.Vector3(Math.cos(th), 0, Math.sin(th)), tg = new THREE.Vector3(-n.z, 0, n.x);
    // the line surges and gives way over minutes; harder wars push it deeper into the city
    const push = 0.08 - 0.1 * this.bw!.intensity;
    const front = this.R * (push + 0.06 * Math.sin(t * 0.021 + whash(id, 2) * 6.28) + 0.03 * Math.sin(t * 0.057 + whash(id, 3) * 6.28));
    return { n, tg, front };
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, ka: number, cb: THREE.Color, kb: number): void {
    if (this.ns >= MAX_SEG) return;
    this.lPos.set([a.x, a.y, a.z, b.x, b.y, b.z], this.ns * 6);
    this.lCol.set([ca.r * ka, ca.g * ka, ca.b * ka, cb.r * kb, cb.g * kb, cb.b * kb], this.ns * 6);
    this.ns++;
  }
  private dot(p: THREE.Vector3, c: THREE.Color, k: number, size: number): void {
    if (this.nd >= MAX_DOTS || size <= 0 || k <= 0) return;
    this.dPos.set([p.x, p.y, p.z], this.nd * 3);
    this.dCol.set([c.r * k, c.g * k, c.b * k], this.nd * 3);
    this.dSize[this.nd++] = size;
  }
  private blast(p: THREE.Vector3, age: number, scale: number, ground: boolean): void {
    const R = this.R;
    if (age < 0 || age > 9) return;
    // flash, then a fireball that lingers
    if (age < 2.2 && this.nb < MAX_BLASTS) {
      const s = this.blasts[this.nb++];
      s.visible = true;
      s.position.copy(p).setY(p.y + R * 0.02 * scale);
      s.scale.setScalar(R * scale * (0.08 + 0.42 * smooth(age / 0.25)));
      const m = s.material as THREE.SpriteMaterial;
      m.color.copy(WHITE).lerp(FIRE, Math.min(1, age * 1.6));
      m.opacity = Math.exp(-age * 2.2);
    }
    if (age < 4 && this.nb < MAX_BLASTS) {
      const s = this.blasts[this.nb++];
      s.visible = true;
      s.position.copy(p).setY(p.y + R * scale * (0.05 + age * 0.02));
      s.scale.setScalar(R * scale * 0.22 * (1 + age * 0.45));
      const m = s.material as THREE.SpriteMaterial;
      m.color.copy(FIRE).lerp(EMBER, age / 4);
      m.opacity = 0.85 * Math.max(0, 1 - age / 4) * (REDUCED_MOTION ? 1 : 0.85 + 0.15 * Math.sin(age * 31));
    }
    // the blast lights the street around it
    if (age < 1.5 && this.nl < MAX_LIGHTS) {
      const l = this.lights[this.nl++];
      l.visible = true;
      l.position.copy(p).setY(p.y + R * 0.06);
      l.distance = R * 1.4 * scale;
      l.intensity = 60 * scale * Math.exp(-age * 2.6);
    }
    // debris thrown out, falling back
    const N = ground ? 26 : 14;
    if (age < 2.6) for (let k = 0; k < N; k++) {
      const a = whash(p.x, p.z, k, 1) * Math.PI * 2, up = 0.4 + whash(p.x, p.z, k, 2) * 1.1, sp = R * scale * (0.08 + 0.18 * whash(p.x, p.z, k, 3));
      v1.set(Math.cos(a) * sp * age, Math.max(0, up * sp * age - 0.5 * R * 0.09 * age * age) + p.y * Math.max(0, 1 - age), Math.sin(a) * sp * age).add(v2.set(p.x, 0, p.z));
      c1.copy(FIRE).lerp(EMBER, age / 2.6);
      this.dot(v1, c1, 1.2 * (1 - age / 2.6), 1.6 + 2 * (1 - age / 2.6));
    }
  }
  /** A column of smoke rising from a ruin, `age` seconds after the hit, with fire at its foot. */
  private burn(p: THREE.Vector3, age: number, t: number, seed: number): void {
    const R = this.R, life = 26;
    if (age < 0.5 || age > life) return;
    const fade = Math.min(1, (age - 0.5) / 2) * Math.min(1, (life - age) / 6);
    for (let k = 0; k < 9 && this.nsm < MAX_SMOKE; k++) {
      const a = fract(t / 9 + k / 9 + seed) * 9; // each puff's own age, 0..9 s, recycled
      const s = this.smoke[this.nsm++];
      s.visible = true;
      s.position.set(p.x + a * R * 0.012 * Math.cos(seed * 6.28), R * (0.04 + a * 0.05), p.z + a * R * 0.012 * Math.sin(seed * 6.28));
      s.scale.setScalar(R * (0.05 + a * 0.028));
      const m = s.material as THREE.SpriteMaterial;
      // lit from below by the fire for the first seconds, then grey
      m.color.copy(SMOKE).lerp(FIRE, Math.max(0, 1 - a / 2.5) * 0.6);
      m.opacity = 0.7 * fade * (1 - a / 9);
    }
    // embers at the foot
    c1.copy(FIRE);
    this.dot(v1.set(p.x, R * 0.015, p.z), c1, fade * (REDUCED_MOTION ? 0.8 : 0.6 + 0.4 * Math.sin(t * 13 + seed * 50)), 6 + 3 * fade);
  }

  /** A rocket climbing out of the city from `pad`, `tau` seconds after launch, bending toward `dir`. */
  private launch(pad: THREE.Vector3, dir: THREE.Vector3, tau: number, life: number, head: THREE.Color): void {
    const R = this.R;
    if (tau < 0 || tau > life) return;
    const at = (u: number, out: THREE.Vector3) => out.copy(pad).addScaledVector(UP, R * 0.12 * u * u).addScaledVector(dir, R * 0.012 * u * u * u);
    // exhaust trail: the path it has flown, fading behind
    const N = 16, back = Math.min(tau, 1.4);
    for (let k = 0; k < N; k++) {
      const u0 = tau - (back * k) / N, u1 = tau - (back * (k + 1)) / N;
      at(u0, v1); at(u1, v2);
      this.seg(v1, v2, EXHAUST, 0.9 * (1 - k / N), SMOKE, 0.5 * (1 - (k + 1) / N));
      if (k % 2 === 0) this.dot(v1, k < 4 ? EXHAUST : SMOKE, 1 - k / N, 2 + 6 * (k / N));
    }
    at(tau, v3);
    this.dot(v3, head, 1, 7 + (REDUCED_MOTION ? 0 : Math.sin(tau * 40)));
    // the pad lights up as it goes
    if (tau < 0.6) this.dot(pad, EXHAUST, 1 - tau / 0.6, 14);
  }

  // ------------------------------------------------------------ per frame

  update(world: World, snap: StateMsg | null, body: number, year: number, t: number, night: number, near: boolean, figure: number): void {
    this.check(world, snap, body, year, t);
    this.ns = 0; this.nd = 0; this.nb = 0; this.nsm = 0; this.nl = 0;
    this.troops.count = 0;
    this.raid = 0;
    if (!this.mode || !this.bw) { this.group.visible = false; return; }
    this.group.visible = true;
    const tm = REDUCED_MOTION ? t * 0.3 : t;
    if (this.mode === 'battle') this.battle(tm, night, near, figure);
    else if (this.mode === 'sending') this.sending(tm);
    else this.struck(tm);
    for (let k = this.nb; k < MAX_BLASTS; k++) this.blasts[k].visible = false;
    for (let k = this.nsm; k < MAX_SMOKE; k++) this.smoke[k].visible = false;
    for (let k = this.nl; k < MAX_LIGHTS; k++) { this.lights[k].visible = false; this.lights[k].intensity = 0; }
    const lg = this.lines.geometry;
    lg.setDrawRange(0, this.ns * 2);
    lg.attributes.position.needsUpdate = true; lg.attributes.color.needsUpdate = true;
    const dg = this.dots.geometry;
    dg.setDrawRange(0, this.nd);
    dg.attributes.position.needsUpdate = true; dg.attributes.color.needsUpdate = true; dg.attributes.size.needsUpdate = true;
    this.troops.instanceMatrix.needsUpdate = true;
    if (this.troops.instanceColor) this.troops.instanceColor.needsUpdate = true;
    this.troopWalk.needsUpdate = true;
  }

  private battle(tm: number, night: number, near: boolean, figure: number): void {
    const bw = this.bw!, id = bw.war.id, R = this.R, I = bw.intensity;
    const { n, tg, front } = this.axes(tm);
    this.frontAt.copy(n).multiplyScalar(front);
    const crowd = Math.min(1, Math.max(0.25, R / 14));
    const nDef = Math.min(MAX_SIDE, Math.round((40 + 120 * I) * crowd)), nAtt = Math.min(MAX_SIDE, Math.round((50 + 150 * I) * crowd));
    // the fight fills the plaza and the streets near it, not the whole city
    const W = Math.min(R * 0.55, Math.sqrt(Math.max(R * R * 0.8 - front * front, R * R * 0.15)));
    const dieShare = 0.1 + 0.35 * I;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), lie = new THREE.Quaternion(), s = new THREE.Vector3(), zero = new THREE.Vector3();
    const walk = this.troopWalk.array as Float32Array;
    const where: THREE.Vector3[][] = [[], []];
    const alive: boolean[][] = [[], []];
    // place everyone first, so tracers can find their marks
    const sides: [number, THREE.Color, number][] = [[nDef, this.ours, 0], [nAtt, this.theirs, 1]];
    let slot = 0;
    for (const [count, col, side] of sides) {
      const sign = side === 1 ? 1 : -1; // attackers on +n of the line
      for (let k = 0; k < count; k++) {
        const h = (x: number) => whash(id, side, k, x);
        const L = 28 + h(4) * 40, phase = h(5);
        const life = (tm / L + phase), cyc = Math.floor(life), lp = life - cyc;
        const dead = lp > 1 - dieShare;
        const diedAgo = dead ? (lp - (1 - dieShare)) * L : 0;
        const tAt = tm - diedAgo; // where they were when they fell
        const squad = Math.floor(k / 7);
        const Ps = 7 + whash(id, side, squad, 6) * 6, bound = fract(tAt / Ps + whash(id, side, squad, 7));
        const lane = (whash(id, side, k, 8 + cyc) * 2 - 1) * W * 0.92;
        const depth = R * (0.015 + 0.16 * whash(id, side, k, 9 + cyc) ** 1.6);
        // attackers rush forward and go to ground; defenders shift between cover
        const surge = side === 1 ? R * 0.035 * Math.cos(bound * Math.PI * 2) : R * 0.012 * Math.sin(bound * Math.PI * 2);
        // reinforcements walk up from the rear in the first seconds of a new life
        const walkIn = Math.max(0, 1 - (lp * L) / 5) * R * 0.3;
        const d = sign * (depth + surge + walkIn);
        v1.copy(n).multiplyScalar(front + d).addScaledVector(tg, lane);
        if (v1.length() > R * 1.6) v1.setLength(R * 1.6);
        // outside the open plaza, fighting runs along the streets, not through the blocks
        if (this.span > 0 && v1.length() > R * 0.19) {
          const jit = (whash(id, side, k, 11) - 0.5) * 2 * this.road;
          if (whash(id, side, k, 12) < 0.5) v1.x = Math.round(v1.x / this.span) * this.span + jit;
          else v1.z = Math.round(v1.z / this.span) * this.span + jit;
        }
        const moving = !dead && (walkIn > 0 || (side === 1 && Math.sin(bound * Math.PI * 2) < -0.3));
        const heading = Math.atan2(-sign * n.x, -sign * n.z);
        q.setFromAxisAngle(UP, heading);
        let k2 = 1;
        if (dead) {
          // fallen: lying where they were hit, darkening, gone after a while
          lie.setFromAxisAngle(v2.set(Math.cos(heading), 0, -Math.sin(heading)), Math.PI / 2 * Math.min(1, diedAgo / 0.5));
          q.premultiply(lie);
          k2 = Math.max(0, 1 - diedAgo / 18);
        }
        const crouch = !moving && !dead ? 0.72 : 1;
        s.set(figure, figure * crouch, figure);
        const show = near && k2 > 0.02;
        m.compose(v1.setY(dead ? 0.012 : 0), q, show ? s : zero);
        this.troops.setMatrixAt(slot, m);
        c1.copy(col).multiplyScalar(dead ? 0.2 + 0.3 * k2 : 1.6);
        this.troops.setColorAt(slot, c1);
        walk[slot * 2] = h(10); walk[slot * 2 + 1] = moving ? 1.4 : 0;
        slot++;
        where[side].push(v1.clone());
        alive[side].push(!dead);
        // each soldier carries a marker light in their side's colour; from afar it is all you see
        if (!dead) this.dot(v1.setY(near ? 0.15 * figure * crouch : 0.1), col, 0.7, near ? 1.5 : 1.3);
      }
    }
    this.troops.count = slot;

    // fire: bursts of tracers across the line, muzzle flashes
    const muzzle = 0.13 * figure, chest = 0.1 * figure;
    for (const side of [0, 1]) {
      const mine = where[side], theirs = where[1 - side], ok = alive[1 - side];
      if (!theirs.length) continue;
      c2.copy(side === 1 ? this.theirs : this.ours).lerp(WHITE, 0.15);
      for (let k = 0; k < mine.length; k++) {
        if (!alive[side][k]) continue;
        const per = (0.5 + whash(id, side, k, 20) * 1.6) / (0.6 + I), sh = tm / per + whash(id, side, k, 21);
        const shot = Math.floor(sh), u = sh - shot;
        if (u > 0.22) continue;
        // the nearest of a few enemies in view
        let j = -1, best = Infinity;
        for (let tries = 0; tries < 6; tries++) {
          const c = Math.floor(whash(id, side, k, shot, tries) * theirs.length);
          const dd = ok[c] ? theirs[c].distanceToSquared(mine[k]) : Infinity;
          if (dd < best) { best = dd; j = c; }
        }
        if (j < 0) continue;
        const a = v1.copy(mine[k]).setY(muzzle), b = v2.copy(theirs[j]).setY(chest);
        const dist = a.distanceTo(b);
        if (dist > R * 0.4) continue;
        // a near miss most of the time
        b.addScaledVector(tg, (whash(id, side, k, shot, 3) - 0.5) * R * 0.03);
        const f0 = u / 0.22, f1 = Math.min(1, f0 + Math.min(0.35, (R * 0.02) / Math.max(dist, 1e-3)));
        this.seg(v3.lerpVectors(a, b, f0), v4.lerpVectors(a, b, f1), c2, 0.4, c2, 2);
        this.dot(v4, c2, 1.4, 2.6);
        if (u < 0.05) this.dot(a, EXHAUST, 1.2, 4.5);
      }
    }

    // rockets in from the enemy's sky, interceptors up to meet some, impacts, ruins burning
    const nIn = 2 + Math.round(6 * I);
    for (let j = 0; j < nIn; j++) {
      const P = 5.5 + whash(id, j, 30) * 6, ph = whash(id, j, 31) * P;
      const cNow = Math.floor((tm + ph) / P);
      for (let back = 0; back < 5; back++) {
        const c = cNow - back, tau = tm + ph - c * P;
        const h = (x: number) => whash(id, j, c, x);
        const O = v1.copy(n).multiplyScalar(R * (1.5 + 0.8 * h(1))).addScaledVector(tg, (h(2) - 0.5) * R * 2.4).setY(R * (0.7 + 0.5 * h(3)));
        const Ip = v2.copy(n).multiplyScalar(front - R * (0.03 + 0.45 * h(4) ** 1.5)).addScaledVector(tg, (h(5) - 0.5) * R * 1.0).setY(0);
        if (Ip.length() > R * 1.05) Ip.setLength(R * 1.05);
        const C = v3.copy(O).add(Ip).multiplyScalar(0.5).setY(O.y * 1.15);
        const intercepted = h(6) < 0.3 + 0.2 * (1 - I), ti = 1.6 + h(7) * 0.9;
        const bez = (u: number, out: THREE.Vector3) => {
          const w = 1 - u;
          return out.set(w * w * O.x + 2 * w * u * C.x + u * u * Ip.x, w * w * O.y + 2 * w * u * C.y + u * u * Ip.y, w * w * O.z + 2 * w * u * C.z + u * u * Ip.z);
        };
        const end = intercepted ? ti : FLIGHT;
        if (back === 0 && tau < end) {
          for (let k = 0; k < 12; k++) {
            const u0 = Math.max(0, tau - k * 0.07) / FLIGHT, u1 = Math.max(0, tau - (k + 1) * 0.07) / FLIGHT;
            const pa = bez(u0, new THREE.Vector3()), pb = bez(u1, new THREE.Vector3());
            this.seg(pa, pb, FIRE, 1.2 * (1 - k / 12), SMOKE, 0.4 * (1 - k / 12));
            if (k % 2 === 1) this.dot(pa, FIRE, 0.8 * (1 - k / 12), 3.5 * (1 - k / 14));
          }
          const hp = bez(tau / FLIGHT, new THREE.Vector3());
          this.dot(hp, WHITE, 1, 8);
          this.dot(hp, FIRE, 0.6, 16);
        }
        if (intercepted) {
          const meet = bez(ti / FLIGHT, new THREE.Vector3());
          const pad = new THREE.Vector3().copy(n).multiplyScalar(-R * (0.35 + 0.3 * h(8))).addScaledVector(tg, (h(9) - 0.5) * R);
          const t0 = ti - 1.1;
          if (back === 0 && tau > t0 && tau < ti) {
            const u = (tau - t0) / 1.1;
            const at = (x: number, out: THREE.Vector3) => out.lerpVectors(pad, meet, x ** 1.5).addScaledVector(UP, R * 0.15 * Math.sin(Math.PI * x));
            for (let k = 0; k < 8; k++) this.seg(at(Math.max(0, u - k * 0.06), new THREE.Vector3()), at(Math.max(0, u - (k + 1) * 0.06), new THREE.Vector3()), INTERCEPT, 1 - k / 8, INTERCEPT, 0.2 * (1 - k / 8));
            this.dot(at(u, new THREE.Vector3()), INTERCEPT, 1, 4);
          }
          this.blast(meet, tau - ti, 0.55, false);
        } else {
          const ip = Ip.clone();
          this.blast(ip, tau - FLIGHT, 1, true);
          this.burn(ip, tau - FLIGHT, tm, h(10));
        }
      }
    }
    // our batteries fire back at the enemy's landing grounds
    const nOut = 1 + Math.round(2 * I);
    for (let j = 0; j < nOut; j++) {
      const P = 7 + whash(id, j, 40) * 5, ph = whash(id, j, 41) * P, c = Math.floor((tm + ph) / P), tau = tm + ph - c * P;
      const pad = new THREE.Vector3().copy(n).multiplyScalar(-R * (0.5 + 0.4 * whash(id, j, 42))).addScaledVector(tg, (whash(id, j, 43) - 0.5) * R * 1.2);
      this.launch(pad, n, tau, 4.5, WHITE);
    }

    // fires on the horizon on the enemy's side, the sky lit by them, searchlights at night
    const flick = (k: number) => (REDUCED_MOTION ? 0.8 : 0.65 + 0.2 * Math.sin(tm * 3.1 + k * 1.7) + 0.15 * Math.sin(tm * 7.3 + k * 4.1));
    this.fires.forEach((f, k) => {
      f.visible = true;
      f.position.copy(n).multiplyScalar(R * (1.7 + 1.3 * whash(id, k, 50))).addScaledVector(tg, (whash(id, k, 51) - 0.5) * R * 3.2).setY(R * 0.1);
      f.scale.set(R * (0.7 + 0.5 * whash(id, k, 52)), R * 0.35, 1);
      const mm = f.material as THREE.SpriteMaterial;
      mm.color.copy(FIRE);
      mm.opacity = (0.25 + 0.35 * I) * flick(k);
    });
    this.raid = (0.35 + 0.4 * I) * flick(9);
    this.beams.forEach((b, k) => {
      b.visible = night > 0.05;
      b.position.copy(n).multiplyScalar(-R * (0.2 + 0.5 * whash(id, k, 60))).addScaledVector(tg, (whash(id, k, 61) - 0.5) * R * 1.4);
      b.scale.set(R * 1.4, R * 2.6, R * 1.4);
      b.rotation.set(0.45 * Math.sin(tm * 0.31 + k * 2.1) + 0.25, 0, 0.5 * Math.sin(tm * 0.23 + k * 1.3));
      (b.material as THREE.MeshBasicMaterial).opacity = 0.05 * night;
    });
  }

  private sending(tm: number): void {
    const bw = this.bw!, id = bw.war.id, R = this.R, I = bw.intensity;
    // forces for the front climb out of the city, toward wherever the fight is
    const dir = new THREE.Vector3(Math.cos(whash(id, 70) * 6.28), 0, Math.sin(whash(id, 70) * 6.28));
    const nL = 2 + Math.round(4 * I);
    for (let j = 0; j < nL; j++) {
      const P = 4 + whash(id, j, 71) * 5, ph = whash(id, j, 72) * P, c = Math.floor((tm + ph) / P), tau = tm + ph - c * P;
      const a = whash(id, j, c, 73) * Math.PI * 2, r = R * (0.3 + 0.6 * whash(id, j, c, 74));
      this.launch(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), dir, tau, 6, bw.usColor.clone().lerp(WHITE, 0.6));
    }
    this.hideScene();
    this.raid = 0.12;
  }

  private struck(tm: number): void {
    const bw = this.bw!, id = bw.war.id, R = this.R;
    // far-off flashes where the strike's fragments land, and the sky flickering with them
    const n = new THREE.Vector3(Math.cos(whash(id, 80) * 6.28), 0, Math.sin(whash(id, 80) * 6.28));
    const P = 9, c = Math.floor(tm / P), tau = tm - c * P;
    const at = new THREE.Vector3().copy(n).multiplyScalar(R * (3 + 2 * whash(id, c, 81))).addScaledVector(new THREE.Vector3(-n.z, 0, n.x), (whash(id, c, 82) - 0.5) * R * 4);
    this.blast(at, tau, 3, true);
    this.burn(at, tau, tm, whash(id, c, 83));
    this.hideScene();
    this.raid = 0.25 + 0.5 * Math.exp(-tau * 0.8);
  }

  private hideScene(): void {
    for (const f of this.fires) f.visible = false;
    for (const b of this.beams) b.visible = false;
  }

  /**
   * Civilians in a battle: most shelter indoors, the rest keep clear of the front, back toward the rear.
   * Call after the agent is placed for the hour; changes where it is drawn, not who it is.
   */
  shelter(a: Agent, k: number): void {
    if (this.mode !== 'battle' || !this.bw || !a.vis) return;
    const I = this.bw.intensity, h = whash(this.bw.war.id, k, 90);
    if (h < 0.35 + 0.4 * I) { a.vis = false; a.doing = 'sheltering from the fighting'; return; }
    const th = whash(this.bw.war.id, 1) * Math.PI * 2, nx = Math.cos(th), nz = Math.sin(th);
    const front = this.frontAt.dot(v1.set(nx, 0, nz));
    const d = a.x * nx + a.z * nz - (front - this.R * 0.25);
    if (d > 0) {
      const back = d + this.R * 0.15 * whash(this.bw.war.id, k, 91);
      a.x -= nx * back; a.z -= nz * back;
      a.doing = 'fleeing the fighting';
    }
  }

  /** A label over the front while there is a battle here. */
  label(): { pos: THREE.Vector3; text: string; sub: string } | null {
    const bw = this.bw;
    if (!bw) return null;
    if (this.mode === 'battle') return { pos: this.frontAt.clone().setY(this.R * 0.35 + 1), text: `${bw.name}: the battle here`, sub: `${bw.usName} holds against ${bw.themName}` };
    if (this.mode === 'struck') return { pos: new THREE.Vector3(0, this.R * 0.5 + 1, 0), text: `${bw.name}: incoming`, sub: `a relativistic strike from ${bw.themName}` };
    return { pos: new THREE.Vector3(0, this.R * 0.45 + 1, 0), text: bw.name, sub: `${bw.usName} sends its forces against ${bw.themName}` };
  }
}
