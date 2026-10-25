// A world at war, seen from its own orbit. The war log says who fights, how
// hard (the dead so far) and whether a kinetic strike is coming; this draws it:
//
//   launches      rockets climb from this world's cities and arc away toward
//                 the enemy, trailing exhaust in our colour
//   incoming      the enemy's rockets fall in from the same quarter; some are
//                 caught by interceptors high up, the rest strike near cities
//                 and the blast spreads across the ground
//   orbit         small warships of both sides circle the world trading tracer
//                 fire; now and then one breaks apart into debris
//   kinetic       a strike from another star shows as a white-hot slug closing
//                 in as its arrival year nears, then a blinding flash
//
// Everything is a pure function of (war id, slot, cycle) and the clock, so a
// war looks the same each time it is watched and the loops never jump. View
// only: nothing here touches the simulation.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import { pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';
import { bodyWars, whash, type BodyWar } from './warState.ts';

const R = 10;                 // the planet's radius in the planet view
const MAX_SEG = 8192, MAX_PTS = 4096, MAX_SHIPS = 96;
const KINETIC_LINGER = 40;    // years an impact stays on the ground

const FIRE = new THREE.Color(1, 0.42, 0.12), HOT = new THREE.Color(1, 0.92, 0.75), WHITE = new THREE.Color(1, 1, 1);
const SLUG = new THREE.Color(0.78, 0.9, 1), EMBER = new THREE.Color(0.55, 0.12, 0.04);
const tc = new THREE.Color(), tc2 = new THREE.Color();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3();
const g1 = new THREE.Vector3(), g2 = new THREE.Vector3(), g3 = new THREE.Vector3(); // groundPoint's own scratch
const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

/** Point u along the quadratic curve a → (control c) → b. */
function bez(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3): THREE.Vector3 {
  const s = 1 - u;
  return out.set(s * s * a.x + 2 * s * u * c.x + u * u * b.x, s * s * a.y + 2 * s * u * c.y + u * u * b.y, s * s * a.z + 2 * s * u * c.z + u * u * b.z);
}
/** A unit vector from two hashes, kept near the orbital plane so fights read side-on. */
function dirOf(h1: number, h2: number, out: THREE.Vector3): THREE.Vector3 {
  const th = h1 * Math.PI * 2, y = (h2 - 0.5) * 0.9;
  return out.set(Math.cos(th), y, Math.sin(th)).normalize();
}
/** Two axes spanning the ground's tangent plane at normal n. */
function tangents(n: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  t1.crossVectors(n, Math.abs(n.y) > 0.9 ? X : UP).normalize();
  t2.crossVectors(n, t1).normalize();
}

export class PlanetWar {
  /** Added to the planet's pivot, so the ground fighting turns with the ground. */
  readonly group = new THREE.Group();
  private lines: THREE.LineSegments;
  private pos: Float32Array; private col: Float32Array; private ns = 0;
  private pts: THREE.Points;
  private pPos: Float32Array; private pCol: Float32Array; private pSize: Float32Array; private np = 0;
  private ships: THREE.InstancedMesh;
  private nShip = 0;
  private cities: THREE.Vector3[] = [];
  private wars: BodyWar[] = [];
  private m4 = new THREE.Matrix4(); private q = new THREE.Quaternion(); private sc = new THREE.Vector3();

  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_SEG * 6); this.col = new Float32Array(MAX_SEG * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    // depth-tested against the planet, so the far side's fighting is hidden by the world itself
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PTS * 3); this.pCol = new Float32Array(MAX_PTS * 3); this.pSize = new Float32Array(MAX_PTS);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    this.pts = new THREE.Points(pg, pointsMaterial({ sizeScale: 2.6, minPx: 1.5, maxPx: 160 }));
    this.pts.frustumCulled = false;
    // warships: a slim dart, nose along +y, lit only by their own colour
    const hull = new THREE.ConeGeometry(0.09, 0.42, 5);
    this.ships = new THREE.InstancedMesh(hull, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SHIPS);
    this.ships.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHIPS * 3), 3);
    this.ships.frustumCulled = false;
    this.ships.count = 0;
    this.group.add(this.lines, this.pts, this.ships);
  }

  /** The cities' ground positions (pivot space), where rockets rise from and fall toward. */
  setCities(c: THREE.Vector3[]): void { this.cities = c; }

  /** The biggest war this world is in, for the planet's label. */
  label(): { text: string; sub: string } | null {
    const w = this.wars[0];
    if (!w) return null;
    return { text: w.name, sub: w.war.kinetic ? (w.attacking ? `${w.usName} strikes ${w.themName}` : `${w.themName} strikes ${w.usName}`) : `${w.usName} against ${w.themName}` };
  }

  // ------------------------------------------------------------ buffers

  private seg(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, ka: number, cb: THREE.Color, kb: number): void {
    if (this.ns >= MAX_SEG) return;
    this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], this.ns * 6);
    this.col.set([ca.r * ka, ca.g * ka, ca.b * ka, cb.r * kb, cb.g * kb, cb.b * kb], this.ns * 6);
    this.ns++;
  }
  private dot(p: THREE.Vector3, c: THREE.Color, k: number, size: number): void {
    if (this.np >= MAX_PTS || size <= 0 || k <= 0) return;
    this.pPos.set([p.x, p.y, p.z], this.np * 3);
    this.pCol.set([c.r * k, c.g * k, c.b * k], this.np * 3);
    this.pSize[this.np++] = size;
  }
  private ship(p: THREE.Vector3, heading: THREE.Vector3, c: THREE.Color, k: number): void {
    if (this.nShip >= MAX_SHIPS) return;
    this.q.setFromUnitVectors(UP, v5.copy(heading).normalize());
    this.m4.compose(p, this.q, this.sc.setScalar(1));
    this.ships.setMatrixAt(this.nShip, this.m4);
    this.ships.setColorAt(this.nShip++, tc2.copy(c).multiplyScalar(k));
  }
  /**
   * A curve drawn as a fading trail behind its head at u (from u - len to u), with an exhaust plume:
   * white-hot at the nozzle, cooling through fire into the side's colour and widening as it thins.
   */
  private trail(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, len: number, col: THREE.Color, k: number, n = 10, plume = 0): void {
    const u0 = Math.max(0, u - len);
    for (let i = 0; i < n; i++) {
      const s0 = u0 + ((u - u0) * i) / n, s1 = u0 + ((u - u0) * (i + 1)) / n;
      this.seg(bez(a, c, b, s0, v1), bez(a, c, b, s1, v2), col, k * Math.pow(i / n, 2), col, k * Math.pow((i + 1) / n, 2));
      if (plume > 0) {
        const f = (i + 1) / n; // 1 at the head
        tc.copy(col).lerp(FIRE, Math.min(1, f * 1.6)).lerp(HOT, Math.max(0, f - 0.75) * 4);
        this.dot(v2, tc, plume * k * f * f, 0.1 + 0.32 * (1 - f) + 0.08 * f);
      }
    }
  }

  /** A blast on the ground at p: a white flash, a fireball boiling outward, a shock ring, embers left glowing. */
  private blast(p: THREE.Vector3, age: number, size: number, col: THREE.Color, seed = 0): void {
    if (age < 0 || age > 1) return;
    const k = 1 - age;
    v3.copy(p).normalize();
    tangents(v3, v4, v5);
    tc.copy(HOT).lerp(col, Math.min(1, age * 2.5));
    this.dot(p, tc, k * k, size * (0.7 + 2.6 * Math.sqrt(age)) * (age < 0.08 ? 2.2 : 1));
    // the fireball: puffs scattered on the ground, rising a little as they cool
    for (let i = 0; i < 14; i++) {
      const a = whash(seed, i, 1) * Math.PI * 2, r = size * 0.9 * Math.sqrt(age) * (0.3 + 0.9 * whash(seed, i, 2));
      v1.copy(p).addScaledVector(v4, Math.cos(a) * r).addScaledVector(v5, Math.sin(a) * r).setLength(R + 0.05 + 0.5 * age * whash(seed, i, 3));
      tc2.copy(HOT).lerp(FIRE, Math.min(1, age * 3 + whash(seed, i, 4) * 0.3)).lerp(EMBER, Math.max(0, age - 0.5) * 2);
      this.dot(v1, tc2, k * (0.6 + 0.4 * whash(seed, i, 5)), size * (0.25 + 0.35 * whash(seed, i, 6)));
    }
    // the shock ring racing out along the ground
    if (age < 0.6) {
      const ka = 1 - age / 0.6, rr = size * (0.2 + 2.4 * Math.sqrt(age / 0.6)), N = 24, lift = R + 0.04;
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        v1.copy(p).addScaledVector(v4, Math.cos(a0) * rr).addScaledVector(v5, Math.sin(a0) * rr).setLength(lift);
        v2.copy(p).addScaledVector(v4, Math.cos(a1) * rr).addScaledVector(v5, Math.sin(a1) * rr).setLength(lift);
        this.seg(v1, v2, HOT, ka, FIRE, ka);
      }
    }
  }

  /** A burst in space: a flash and debris flying out, fading. */
  private burst(p: THREE.Vector3, age: number, size: number, col: THREE.Color, seed: number): void {
    if (age < 0 || age > 1) return;
    const k = 1 - age;
    tc.copy(HOT).lerp(col, Math.min(1, age * 3));
    this.dot(p, tc, k * k, size * (0.8 + 2 * age) * (age < 0.1 ? 1.6 : 1));
    for (let i = 0; i < 10; i++) {
      dirOf(whash(seed, i, 1), whash(seed, i, 2) * 2 - 0.5, v1);
      v2.copy(p).addScaledVector(v1, size * (0.4 + 1.6 * whash(seed, i, 3)) * Math.sqrt(age) * 1.6);
      this.dot(v2, tc, k * 0.8, 0.12 + 0.1 * whash(seed, i, 4));
    }
  }

  /** A city ground point for slot k in cycle c, scattered a little around the city. */
  private groundPoint(war: number, k: number, c: number, spread: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.cities.length;
    if (n) out.copy(this.cities[Math.floor(whash(war, k, c, 11) * n) % n]);
    else dirOf(whash(war, k, c, 12), whash(war, k, c, 13), out).multiplyScalar(R);
    g3.copy(out).normalize();
    tangents(g3, g1, g2);
    const a = whash(war, k, c, 14) * Math.PI * 2, r = spread * Math.sqrt(whash(war, k, c, 15));
    return out.addScaledVector(g1, Math.cos(a) * r).addScaledVector(g2, Math.sin(a) * r).setLength(R + 0.02);
  }

  // ------------------------------------------------------------ the fighting

  draw(world: World, snap: StateMsg | null, body: number, year: number, t: number): void {
    this.ns = 0; this.np = 0; this.nShip = 0;
    this.wars = bodyWars(world, snap, body, year).slice(0, 2);
    const clock = t * (REDUCED_MOTION ? 0.35 : 1);
    for (const bw of this.wars) {
      if (bw.war.kinetic) continue;
      const id = bw.war.id;
      // where the enemy is: their world's bearing, fixed per enemy, near the orbital plane
      const D = dirOf(whash(bw.enemyWorld, 1), whash(bw.enemyWorld, 2), new THREE.Vector3());
      const scale = (bw.main ? 1 : 0.35) * (0.45 + 0.75 * bw.intensity);
      this.launches(bw, D, Math.round(22 * scale) + 1, clock);
      this.incoming(bw, D, Math.round(18 * scale) + 1, clock);
      this.orbit(bw, Math.min(14, Math.round(9 * scale) + 2), clock, id);
      this.ground(bw, bw.main ? 4 : 1, clock);
    }
    if (snap) this.kinetic(snap, body, year, clock);
    this.finish();
  }

  /** Our rockets: up from a city, curving over toward the enemy's quarter, exhaust fading behind. */
  private launches(bw: BodyWar, D: THREE.Vector3, n: number, t: number): void {
    const id = bw.war.id, A = new THREE.Vector3(), C = new THREE.Vector3(), B = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const P = 5 + 4 * whash(id, k, 1), x = t / P + whash(id, k, 2), c = Math.floor(x), u = x - c;
      this.groundPoint(id, k, c, 0.5, A);
      v3.copy(A).normalize();
      // straight up first, then over: the control point sits high above the pad, leaning to the enemy
      C.copy(v3).multiplyScalar(R + 5 + 4 * whash(id, k, c, 3)).addScaledVector(D, 4);
      dirOf(whash(id, k, c, 4), whash(id, k, c, 5), B).multiplyScalar(6).addScaledVector(D, 46);
      const fly = Math.min(1, u / 0.75);
      if (u < 0.75) {
        this.trail(A, C, B, fly, 0.24, bw.usColor, 1, 26, 0.75);
        bez(A, C, B, fly, v1);
        this.dot(v1, HOT, 1, 0.38);
        this.dot(v1, bw.usColor, 0.8, 0.8);
        // the pad's flash at lift-off, and the smoke column it leaves
        if (fly < 0.12) this.dot(A, HOT, 1 - fly / 0.12, 1.2);
        if (fly < 0.3) this.dot(A, FIRE, 0.5 * (1 - fly / 0.3), 0.7);
      } else this.trail(A, C, B, 1, 1, bw.usColor, 0.25 * (1 - (u - 0.75) / 0.25), 16);
    }
  }

  /** Their rockets: falling in from the enemy's quarter. A third are caught high up; the rest hit near cities. */
  private incoming(bw: BodyWar, D: THREE.Vector3, n: number, t: number): void {
    const id = bw.war.id + 7919, A = new THREE.Vector3(), C = new THREE.Vector3(), B = new THREE.Vector3(), I = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const P = 6 + 5 * whash(id, k, 1), x = t / P + whash(id, k, 2), c = Math.floor(x), u = x - c;
      this.groundPoint(id, k, c, 0.9, B);
      v3.copy(B).normalize();
      dirOf(whash(id, k, c, 4), whash(id, k, c, 5), A).multiplyScalar(8).addScaledVector(D, 52);
      C.copy(v3).multiplyScalar(R + 9).addScaledVector(D, 10);
      const caught = whash(id, k, c, 6) < 0.33, hitAt = caught ? 0.38 + 0.15 * whash(id, k, c, 7) : 0.6;
      if (u < hitAt) {
        const f = caught ? (u / hitAt) * 0.82 : u / hitAt;
        this.trail(A, C, B, f, 0.25, bw.themColor, 1, 26, 0.75);
        bez(A, C, B, f, v1);
        this.dot(v1, HOT, 1, 0.36);
        this.dot(v1, FIRE, 0.8, 0.8);
        // an interceptor climbs from the nearest city to meet it
        if (caught && u > hitAt * 0.45) {
          bez(A, C, B, 0.82, I);
          this.groundPoint(id, k, c + 0.5, 0.3, v2);
          const g = (u - hitAt * 0.45) / (hitAt * 0.55);
          v4.copy(v2).lerp(I, g);
          this.seg(v2, v4, bw.usColor, 0.15, bw.usColor, 0.9);
          this.dot(v4, bw.usColor, 1, 0.3);
        }
      } else if (caught) {
        bez(A, C, B, 0.82, I);
        this.burst(I, (u - hitAt) / 0.3, 0.8, bw.themColor, id * 31 + k + c * 977);
      } else this.blast(B, (u - hitAt) / 0.4, 0.55 + 0.6 * bw.intensity, FIRE, id * 53 + k + c * 211);
    }
  }

  /** Fighting on the ground around a few cities: guns and fires flickering across a contested patch. */
  private ground(bw: BodyWar, n: number, t: number): void {
    const id = bw.war.id + 104729, C = new THREE.Vector3();
    const tick = REDUCED_MOTION ? 0 : Math.floor(t * 9);
    for (let k = 0; k < n; k++) {
      this.groundPoint(id, k, 0, 0.2, C);
      v3.copy(C).normalize();
      tangents(v3, v4, v5);
      const spread = 0.45 + 0.5 * bw.intensity;
      for (let i = 0; i < 26; i++) {
        const a = whash(id, k, i, 1) * Math.PI * 2, r = spread * Math.sqrt(whash(id, k, i, 2));
        v1.copy(C).addScaledVector(v4, Math.cos(a) * r).addScaledVector(v5, Math.sin(a) * r).setLength(R + 0.03);
        // each gun fires in bursts: on for a few ticks, then quiet
        const on = whash(id, k, i, tick) < 0.35;
        const burning = whash(id, k, i, 3) < 0.25;
        if (burning) this.dot(v1, EMBER, 0.9, 0.35 + 0.15 * whash(id, k, i, 4));
        if (on || REDUCED_MOTION) this.dot(v1, i & 1 ? bw.usColor : HOT, REDUCED_MOTION ? 0.5 : 0.9, 0.14 + 0.12 * whash(id, k, i, tick, 5));
      }
    }
  }

  /** Warships of both sides on inclined orbits, trading tracers; each lives a while, then breaks up. */
  private orbit(bw: BodyWar, n: number, t: number, id: number): void {
    const ships: { p: THREE.Vector3; side: number; life: number }[] = [];
    for (let k = 0; k < n * 2; k++) {
      const side = k & 1, s = id * 131 + k;
      const r = R + 2.2 + 3.5 * whash(s, 1), inc = (whash(s, 2) - 0.5) * 1.4, node = whash(s, 3) * Math.PI * 2;
      const w = (0.12 + 0.18 * whash(s, 4)) * (side ? -1 : 1);
      // a ship's life: it flies, is hit, breaks up, and a fresh one takes its slot
      const L = 9 + 8 * whash(s, 5), x = t / L + whash(s, 6), c = Math.floor(x), life = x - c;
      const th = node + w * t * 3 + c * 1.7;
      const p = new THREE.Vector3(Math.cos(th) * r, 0, Math.sin(th) * r).applyAxisAngle(X, inc).applyAxisAngle(UP, node);
      const col = side ? bw.themColor : bw.usColor;
      if (life < 0.85) {
        const vel = new THREE.Vector3(-Math.sin(th) * Math.sign(w), 0, Math.cos(th) * Math.sign(w)).applyAxisAngle(X, inc).applyAxisAngle(UP, node);
        this.ship(p, vel, col, 1.4);
        this.dot(v1.copy(p).addScaledVector(vel, -0.22), col, 0.8, 0.22); // drive glow
        ships.push({ p, side, life });
      } else this.burst(p, (life - 0.85) / 0.15, 0.7, col, s * 13 + c);
    }
    // each ship fires at the nearest enemy now and then: a bolt crossing the gap
    for (let i = 0; i < ships.length; i++) {
      const a = ships[i];
      let best = -1, bd = Infinity;
      for (let j = 0; j < ships.length; j++) {
        if (ships[j].side === a.side) continue;
        const d = a.p.distanceToSquared(ships[j].p);
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0 || bd > 64) continue;
      const b = ships[best], s = id * 977 + i;
      const P = 0.7 + 0.8 * whash(s, 1), f = (t / P + whash(s, 2)) % 1;
      if (f > 0.6) continue;
      const g = f / 0.6, col = a.side ? bw.themColor : bw.usColor;
      v1.lerpVectors(a.p, b.p, g);
      v2.lerpVectors(a.p, b.p, Math.min(1, g + 0.12));
      tc.copy(col).lerp(WHITE, 0.5);
      this.seg(v1, v2, tc, 0.3, tc, 1.4);
      this.dot(v2, tc, 0.9, 0.18);
      if (g > 0.85) this.dot(b.p, HOT, (g - 0.85) / 0.15, 0.35);
    }
  }

  /** A relativistic strike at this world: a slug closing in as the year nears, then the flash. */
  private kinetic(snap: StateMsg, body: number, year: number, t: number): void {
    for (const w of snap.wars ?? []) {
      if (!w.kinetic) continue;
      const hits: [number, number, number][] = [];
      // the strike lands on b at `arrive`; a reply, if the target could make one, lands on a at `end`
      if (w.b === body) hits.push([w.start, w.arrive, w.id]);
      if (w.a === body && w.end > w.arrive + 0.01) hits.push([w.arrive, w.end, w.id + 1e5]);
      for (const [t0, t1, seed] of hits) {
        if (year < t0) continue;
        const D = dirOf(whash(seed, 21), whash(seed, 22), new THREE.Vector3());
        const G = this.groundPoint(seed, 0, 0, 0.2, new THREE.Vector3());
        if (year < t1) {
          // closing: far out early on, grazing the sky in its last years
          const f = Math.min(1, (year - t0) / Math.max(0.1, t1 - t0));
          const d = R + 2 + 60 * Math.pow(1 - f, 1.5);
          const head = v1.copy(G).normalize().multiplyScalar(d * 0.3).addScaledVector(D, d * 0.95);
          const tail = v2.copy(head).addScaledVector(D, 6 + 10 * (1 - f));
          this.seg(tail, head, SLUG, 0.05, SLUG, 1.2);
          this.dot(head, WHITE, 1, 0.5 + (REDUCED_MOTION ? 0 : 0.15 * Math.sin(t * 13)));
          this.dot(head, SLUG, 0.6, 1.4);
        } else if (year < t1 + KINETIC_LINGER) {
          const age = (year - t1) / KINETIC_LINGER;
          this.blast(G, Math.min(1, age * 1.3), 3.5, FIRE, seed);
          // the glow of the crater, cooling for decades
          this.dot(G, FIRE, 0.8 * (1 - age), 2.2);
        }
      }
    }
  }

  private finish(): void {
    const g = this.lines.geometry;
    g.setDrawRange(0, this.ns * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    const pg = this.pts.geometry;
    pg.setDrawRange(0, this.np);
    pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true; pg.attributes.size.needsUpdate = true;
    this.ships.count = this.nShip;
    this.ships.instanceMatrix.needsUpdate = true;
    if (this.ships.instanceColor) this.ships.instanceColor.needsUpdate = true;
  }
}
