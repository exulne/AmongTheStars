// Fleet battles inside a star system. The war log says who fights whom, where,
// and how many have died; this draws it as fleets meeting between the two
// front worlds: rockets and warships in each side's colour, tracer fire,
// missiles, ships breaking apart, and reinforcements streaming in from home.
// Ships are an illustration of the war, not units the sim tracks: each slot
// lives a loop of real time (launch, fight, die, relaunch), seeded from the
// war's id so a war looks the same every time it is watched. How many fight
// and how fast they die follow the war's dead.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import type { WarVis } from '../sim/worker.ts';
import type { World } from '../sim/world.ts';
import { addGpuSet } from '../explain/picker.ts';
import { registerExplainer, type ExCtx, type Explanation } from '../explain/registry.ts';
import { factionColor } from './colorModes.ts';
import { pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';
import { frontOf, targetOf, warActive, whash } from './warState.ts';

const MAX_SHIPS = 900, MAX_SEG = 3000, MAX_PTS = 3000;
const CYCLE = 26;     // seconds a ship slot takes to launch, fight, die and relaunch
const FLY_IN = 5;     // seconds from launch at home to the fleet's position
const BOOM = 1.6;     // seconds an explosion lasts

const up = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), tmpS = new THREE.Vector3();
const d = new THREE.Vector3(), u = new THREE.Vector3(), M = new THREE.Vector3();
const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), q = new THREE.Vector3();
const cS = new THREE.Color(), cE = new THREE.Color();
const FIRE = new THREE.Color(1, 0.55, 0.2), HOT = new THREE.Color(1, 0.95, 0.8), SMOKE = new THREE.Color(0.35, 0.3, 0.28);

/** A ship's place in its fleet, for one frame. */
interface Ship { pos: THREE.Vector3; side: number; alive: boolean; big: boolean }

const smooth = (x: number) => x * x * (3 - 2 * x);

export class BattleLayer {
  readonly group = new THREE.Group();
  private hulls: THREE.InstancedMesh;
  private nShips = 0;
  private lines: THREE.LineSegments; private lPos: Float32Array; private lCol: Float32Array; private ns = 0;
  private pts: THREE.Points; private pPos: Float32Array; private pCol: Float32Array; private pSize: Float32Array; private np = 0;
  private centres = new Map<number, THREE.Vector3>();
  private ptWar: number[] = [];
  private ships: Ship[] = [];

  /**
   * `body(b)`: where a world of the shown system sits now (null if not drawn). `card`: the war's card,
   * so clicking a battle explains the war. `scale`: world units per ship length.
   */
  constructor(private body: (b: number) => THREE.Vector3 | null, private card: (id: number, c: ExCtx) => Explanation, kind = 'batl') {
    // a rocket: a slim cone hull, nose along +z
    const hull = new THREE.ConeGeometry(0.05, 0.24, 6);
    hull.rotateX(Math.PI / 2);
    this.hulls = new THREE.InstancedMesh(hull, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SHIPS);
    this.hulls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHIPS * 3), 3);
    this.hulls.frustumCulled = false;
    this.hulls.count = 0;
    const g = new THREE.BufferGeometry();
    this.lPos = new Float32Array(MAX_SEG * 6); this.lCol = new Float32Array(MAX_SEG * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.lPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.lCol, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PTS * 3); this.pCol = new Float32Array(MAX_PTS * 3); this.pSize = new Float32Array(MAX_PTS);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    this.pts = new THREE.Points(pg, pointsMaterial({ attenuate: false, minPx: 1, maxPx: 64 }));
    this.pts.frustumCulled = false;
    this.group.add(this.hulls, this.lines, this.pts);
    registerExplainer(kind, {
      obj: this.pts,
      idOf: (i) => this.ptWar[i] ?? -1,
      explain: (id, c) => this.card(id, c),
      locate: (id, out) => { const p = this.centres.get(id); return p ? out.copy(p).applyMatrix4(this.pts.matrixWorld) : null; },
    });
    addGpuSet({ kind, points: this.pts, prio: 6, minLum: 0.05, pickPx: 6 });
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, ka: number, cb: THREE.Color, kb: number): void {
    if (this.ns >= MAX_SEG) return;
    this.lPos.set([a.x, a.y, a.z, b.x, b.y, b.z], this.ns * 6);
    this.lCol.set([ca.r * ka, ca.g * ka, ca.b * ka, cb.r * kb, cb.g * kb, cb.b * kb], this.ns * 6);
    this.ns++;
  }
  private dot(p: THREE.Vector3, c: THREE.Color, k: number, size: number, war = -1): void {
    if (this.np >= MAX_PTS || size <= 0 || k <= 0) return;
    this.ptWar[this.np] = war;
    this.pPos.set([p.x, p.y, p.z], this.np * 3);
    this.pCol.set([c.r * k, c.g * k, c.b * k], this.np * 3);
    this.pSize[this.np++] = size;
  }
  private hull(p: THREE.Vector3, facing: THREE.Vector3, c: THREE.Color, scale: number): void {
    if (this.nShips >= MAX_SHIPS) return;
    tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
    tmpM.compose(p, tmpQ, tmpS.setScalar(scale));
    this.hulls.setMatrixAt(this.nShips, tmpM);
    this.hulls.setColorAt(this.nShips++, c);
  }

  /** `t`: real seconds (the animation clock), `year`: the year on the timeline, `here`: the system shown. */
  draw(world: World, snap: StateMsg | null, year: number, t: number, here: number): void {
    this.ns = 0; this.np = 0; this.nShips = 0; this.ptWar.length = 0; this.centres.clear();
    const T = REDUCED_MOTION ? t * 0.35 : t;
    if (snap && here >= 0) for (const w of snap.wars) {
      if (w.kinetic || w.sys !== here || !warActive(w, year)) continue;
      const fa = frontOf(w, world, snap), fb = targetOf(w, world, snap);
      const pa = fa >= 0 ? this.body(fa) : null, pb = fb >= 0 ? this.body(fb) : null;
      if (pa && pb && fa !== fb) this.fight(w, world, pa, pb, T);
    }
    this.hulls.count = this.nShips;
    this.hulls.instanceMatrix.needsUpdate = true;
    if (this.hulls.instanceColor) this.hulls.instanceColor.needsUpdate = true;
    const g = this.lines.geometry;
    g.setDrawRange(0, this.ns * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    const pg = this.pts.geometry;
    pg.setDrawRange(0, this.np);
    pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true; pg.attributes.size.needsUpdate = true;
  }

  /** One war: two fleets between the attacker's world `pa` and the defender's `pb`. */
  private fight(w: WarVis, world: World, pa: THREE.Vector3, pb: THREE.Vector3, t: number): void {
    const id = w.id, earth = world.earth;
    const dist = pa.distanceTo(pb);
    d.subVectors(pb, pa).normalize();
    u.crossVectors(up, d).normalize();
    // the battle is fought nearer the defender: the attacker has come to it
    M.lerpVectors(pa, pb, 0.62);
    this.centres.set(id, M.clone());
    const intensity = Math.min(1, Math.log10(1 + w.killed) / 10);
    const per = Math.min(MAX_SHIPS / 2 - 4, Math.round(14 + 110 * intensity));
    const gap = Math.min(1.6, dist * 0.08), depth = Math.min(1.4, dist * 0.06), width = Math.min(2.6, 0.6 + dist * 0.08);
    // the dead decide how fast ships die: a hard war loses most of a fleet each cycle, a skirmish a few
    const lethal = 0.25 + 0.6 * intensity;
    const home = [pa, pb];
    const col = sideColors(w.a, w.b, earth);
    this.ships.length = 0;
    for (let s = 0; s < 2; s++) {
      const sgn = s === 0 ? -1 : 1, from = home[s];
      for (let k = 0; k < per; k++) {
        const h = (n: number) => whash(id, s, k, n);
        const big = k < 3;
        // where it holds in the line: rows and ranks in a loose wedge facing the enemy
        const lat = (h(1) - 0.5) * width * (big ? 0.4 : 1), rank = h(2) * depth + (big ? depth * 0.8 : 0), alt = (h(3) - 0.5) * width * 0.45;
        // attack runs: ships surge toward the enemy line and fall back
        const surge = (big ? 0.15 : 0.55 + 0.6 * h(4)) * gap * Math.max(0, Math.sin(t * (0.35 + 0.5 * h(5)) + h(6) * 6.28));
        q.copy(M).addScaledVector(d, sgn * (gap / 2 + rank - surge)).addScaledVector(u, lat + 0.15 * Math.sin(t * 0.7 + h(7) * 6)).addScaledVector(up, alt + 0.1 * Math.cos(t * 0.9 + h(8) * 6));
        // its life this cycle: launched from home, flies in, fights until it dies (or the cycle ends), relaunches
        const cyc = big ? CYCLE * 3 : CYCLE;
        const local = (t + h(9) * cyc) % cyc;
        const dies = big ? cyc * (0.75 + 0.2 * h(10)) : FLY_IN + (cyc - FLY_IN - BOOM) * (1 - lethal * h(10));
        const facing = d.clone().multiplyScalar(-sgn);
        if (local < FLY_IN) {
          // reinforcements: from home along an arc into the line, exhaust behind
          const f = smooth(local / FLY_IN);
          p0.copy(from).addScaledVector(up, 0.3);
          p1.lerpVectors(p0, q, 0.5).addScaledVector(up, 0.6 + h(11)).addScaledVector(u, (h(12) - 0.5) * 2);
          bez(p0, p1, q, f, p2);
          bez(p0, p1, q, Math.max(0, f - 0.04), M2);
          const dir = p2.clone().sub(M2);
          if (dir.lengthSq() > 1e-8) facing.copy(dir.normalize());
          this.seg(M2, p2, FIRE, 0, cS.copy(col[s]).lerp(HOT, 0.5), 0.9);
          this.hull(p2, facing, col[s], big ? 3 : 1);
          this.dot(p2, FIRE, 0.6, 2.5);
          this.dot(p2, col[s], 0.8, 3);
          this.ships.push({ pos: p2.clone(), side: s, alive: true, big });
          continue;
        }
        if (local < dies) {
          this.hull(q, facing, col[s], big ? 3 : 1);
          this.dot(q, col[s], 0.7, big ? 7 : 3, id);
          this.ships.push({ pos: q.clone(), side: s, alive: true, big });
          continue;
        }
        const since = local - dies;
        if (since < BOOM) this.explode(q, since, h(13), big, id);
      }
    }
    this.fire(id, col, t, gap, intensity);
  }

  /** Tracers between the two lines and missiles that curve in; hits flash. */
  private fire(id: number, col: THREE.Color[], t: number, gap: number, intensity: number): void {
    const A = this.ships.filter((s) => s.side === 0), B = this.ships.filter((s) => s.side === 1);
    if (!A.length || !B.length) return;
    const sides = [A, B];
    for (let s = 0; s < 2; s++) {
      const mine = sides[s], foes = sides[1 - s];
      for (let k = 0; k < mine.length; k++) {
        const h = (n: number) => whash(id, s, k, n, 77);
        // each ship fires in bursts; a shot takes `fly` seconds to cross
        const rate = (mine[k].big ? 2.2 : 0.9) * (0.6 + intensity);
        const shot = t * rate + h(1) * 10;
        const n = Math.floor(shot), f = shot - n;
        const fly = 0.45;
        if (f > fly) continue;
        const foe = foes[Math.floor(whash(id, s, k, n) * foes.length)];
        const u0 = f / fly;
        const missile = !mine[k].big && whash(id, s, k, n, 5) < 0.18;
        if (missile) {
          // a missile: curves out and in, a bright head and a smoke trail
          p0.copy(mine[k].pos);
          p1.lerpVectors(mine[k].pos, foe.pos, 0.5).addScaledVector(up, gap * (0.4 + h(2))).addScaledVector(u, (h(3) - 0.5) * gap);
          bez(p0, p1, foe.pos, u0, p2);
          bez(p0, p1, foe.pos, Math.max(0, u0 - 0.15), M2);
          this.seg(M2, p2, SMOKE, 0.1, FIRE, 0.9);
          this.dot(p2, HOT, 1, 3.5);
          if (u0 > 0.9) this.dot(foe.pos, FIRE, 1, 6 + 14 * (u0 - 0.9) * 10);
        } else {
          // a tracer: a short bright dash crossing the gap
          p0.lerpVectors(mine[k].pos, foe.pos, u0);
          p1.lerpVectors(mine[k].pos, foe.pos, Math.min(1, u0 + (mine[k].big ? 0.22 : 0.12)));
          cS.copy(col[s]).lerp(HOT, 0.6);
          this.seg(p0, p1, cS, 0.25, cS, 1);
          if (u0 > 0.85) this.dot(foe.pos, cS, 0.8, 4);
        }
      }
    }
  }

  /** A ship breaking apart: a white flash, a fireball, and debris thrown out, fading. */
  private explode(p: THREE.Vector3, since: number, seed: number, big: boolean, war: number): void {
    const k = since / BOOM, s = big ? 2.4 : 1;
    cE.copy(HOT).lerp(FIRE, Math.min(1, k * 2.5));
    this.dot(p, cE, 1 - k, (6 + 26 * Math.sqrt(k)) * s * (1 - 0.5 * k), war);
    for (let j = 0; j < (big ? 14 : 7); j++) {
      const a = whash(seed * 1e4, j, 1) * 6.283, b = (whash(seed * 1e4, j, 2) - 0.5) * 3, v = (0.15 + 0.35 * whash(seed * 1e4, j, 3)) * s;
      p0.set(Math.cos(a), b * 0.4, Math.sin(a)).normalize().multiplyScalar(v * k).add(p);
      this.dot(p0, j % 3 ? FIRE : SMOKE, (1 - k) * 0.9, 2.5 * s);
    }
  }
}

const M2 = new THREE.Vector3();
const hA = { h: 0, s: 0, l: 0 }, hB = { h: 0, s: 0, l: 0 };
/** The two sides' colours, pushed apart when their faction hues are close so the fleets read as two. */
function sideColors(a: number, b: number, earth: number): THREE.Color[] {
  const A = factionColor(a, earth, new THREE.Color()), B = factionColor(b, earth, new THREE.Color());
  A.getHSL(hA); B.getHSL(hB);
  const dh = Math.abs(((hA.h - hB.h + 1.5) % 1) - 0.5);
  if (dh < 0.18) B.setHSL((hA.h + 0.5) % 1, Math.max(0.7, hB.s), 0.6);
  A.setHSL(hA.h, Math.max(0.75, hA.s), 0.62);
  return [A, B];
}
/** A point on the quadratic Bézier a→c with control b. */
function bez(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, f: number, out: THREE.Vector3): THREE.Vector3 {
  const g = 1 - f;
  return out.set(g * g * a.x + 2 * g * f * b.x + f * f * c.x, g * g * a.y + 2 * g * f * b.y + f * f * c.y, g * g * a.z + 2 * g * f * b.z + f * f * c.z);
}
