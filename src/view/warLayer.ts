// Wars on the star map. The war log (src/sim/civ.ts WC) already holds who fought
// whom, where, when, how it ended and, for kinetic strikes, the launch and
// arrival; this layer only draws it, so it cannot change how a future plays.
//
//   local war     forces march from each side's capital to the contested star,
//                 which burns red while the fighting lasts; news of it spreads
//                 at light speed as a ring; the ending shows in its colour
//                 (annexed: the winner's; reparations: gold; white peace: pale)
//   kinetic war   a projectile crosses the light-years from launcher to target,
//                 flashes on impact, and the reply (if the target held other
//                 systems) comes back the other way
//   arming        stars of a polity whose war mind is building up or
//                 mobilising (H.posture > 0) pulse in its colour
//
// Most wars are fought inside one system (Venus against Titania), so the same
// layer has a second scope: inside a star system it draws between worlds, the
// attacker's world and the target's, and kinetic strikes come in from the edge
// of the system along the bearing of the star that launched them.

import * as THREE from 'three';
import { OUTCOME } from '../sim/civ.ts';
import type { Annals } from '../sim/chronicle.ts';
import type { StateMsg } from '../sim/client.ts';
import { F, NF } from '../sim/metrics.ts';
import type { WarVis } from '../sim/worker.ts';
import type { World } from '../sim/world.ts';
import { addGpuSet } from '../explain/picker.ts';
import { registerExplainer, type ExCtx, type Explanation, type Fact } from '../explain/registry.ts';
import { fmtNum, fmtYear } from '../ui/format.ts';
import { factionColor } from './colorModes.ts';
import { pointsMaterial } from './textures.ts';
import { REDUCED_MOTION } from './timeLook.ts';

/** How long an ended war stays on the map, fading, years (matches worker.ts WAR_LINGER). */
const LINGER = 40;
const MAX_SEG = 4096, MAX_HEADS = 1024, MAX_RINGS = 32;

const FIRE = new THREE.Color(1, 0.32, 0.14), GOLD = new THREE.Color(0xe8c25a), PALE = new THREE.Color(0xdfe8f0);
const SLUG = new THREE.Color(0.75, 0.9, 1), FLASH = new THREE.Color(1, 0.85, 0.6);
const cA = new THREE.Color(), cB = new THREE.Color(), cT = new THREE.Color();
const hash = (b: number) => ((b * 2654435761) >>> 0) / 4294967296;
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();

let annals: Annals | null = null;
/** The Chronicle's names for wars and polities, once the run is done. */
export function setWarAnnals(a: Annals | null): void { annals = a; }

const warName = (w: WarVis) => annals?.wars[w.id]?.name ?? (w.kinetic ? 'Kinetic strike' : 'War');
function sideName(w: WarVis, side: 'a' | 'b', world: World): string {
  const A = annals?.wars[w.id];
  const pol = A ? annals!.polities[side === 'a' ? A.polityA : A.polityB] : undefined;
  if (pol) return pol.name;
  if (w.kinetic) return world.systems[side === 'a' ? w.from : w.sys].name;
  return world.bodies[w[side]]?.name ?? '?';
}

export interface WarLabel { pos: THREE.Vector3; text: string; sub: string; sys: number; prio: number }

export class WarLayer {
  readonly group = new THREE.Group();
  private lines: THREE.LineSegments;
  private pos: Float32Array; private col: Float32Array; private ns = 0;
  private heads: THREE.Points;
  private hPos: Float32Array; private hCol: Float32Array; private hSize: Float32Array; private nh = 0;
  private headWar: number[] = [];
  private headAt = new Map<number, THREE.Vector3>();
  private rings: THREE.Mesh[] = []; private nr = 0;
  private wars: WarVis[] = [];

  /**
   * Star-map scope: `at(sys, out)` places a star system. System scope (`inner` given): `inner.here()` is
   * the system shown, `inner.body(b)` where a world of it sits now (null if not drawn), `inner.edge(sys, from, out)`
   * a point at the system's edge on the bearing of star `sys`, seen from `from`.
   */
  constructor(private at: (sys: number, out: THREE.Vector3) => THREE.Vector3, kind = 'war',
    private inner: { here: () => number; body: (b: number) => THREE.Vector3 | null; size: (b: number) => number; edge: (sys: number, from: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3 } | null = null) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_SEG * 6); this.col = new Float32Array(MAX_SEG * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    // drawn over worlds, not hidden inside them
    (this.lines.material as THREE.Material).depthTest = false; this.lines.renderOrder = 5;
    const hg = new THREE.BufferGeometry();
    this.hPos = new Float32Array(MAX_HEADS * 3); this.hCol = new Float32Array(MAX_HEADS * 3); this.hSize = new Float32Array(MAX_HEADS);
    hg.setAttribute('position', new THREE.BufferAttribute(this.hPos, 3));
    hg.setAttribute('color', new THREE.BufferAttribute(this.hCol, 3));
    hg.setAttribute('size', new THREE.BufferAttribute(this.hSize, 1));
    this.heads = new THREE.Points(hg, pointsMaterial({ minPx: 2.5, maxPx: 48 }));
    this.heads.frustumCulled = false;
    (this.heads.material as THREE.ShaderMaterial).depthTest = false; this.heads.renderOrder = 6;
    const ringGeo = new THREE.RingGeometry(0.97, 1, 128);
    for (let k = 0; k < MAX_RINGS; k++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.rings.push(m);
    }
    this.group.add(this.lines, this.heads, ...this.rings);
    registerExplainer(kind, {
      obj: this.heads,
      idOf: (i) => this.headWar[i] ?? -1,
      explain: (id, c) => this.card(id, c),
      name: (id, c) => { const w = this.wars.find((x) => x.id === id); return w ? `${warName(w)}: ${sideName(w, 'a', c.world)} against ${sideName(w, 'b', c.world)}` : 'War'; },
      locate: (id, out) => { const p = this.headAt.get(id); return p ? out.copy(p).applyMatrix4(this.heads.matrixWorld) : null; },
    });
    addGpuSet({ kind, points: this.heads, prio: 7, minLum: 0.02, pickPx: 8 });
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, ka: number, cb: THREE.Color, kb: number): void {
    if (this.ns >= MAX_SEG) return;
    this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], this.ns * 6);
    this.col.set([ca.r * ka, ca.g * ka, ca.b * ka, cb.r * kb, cb.g * kb, cb.b * kb], this.ns * 6);
    this.ns++;
  }
  private head(p: THREE.Vector3, c: THREE.Color, k: number, size: number, war = -1): void {
    if (this.nh >= MAX_HEADS || size <= 0) return;
    this.headWar[this.nh] = war;
    if (war >= 0 && !this.headAt.has(war)) this.headAt.set(war, p.clone());
    this.hPos.set([p.x, p.y, p.z], this.nh * 3);
    this.hCol.set([c.r * k, c.g * k, c.b * k], this.nh * 3);
    this.hSize[this.nh++] = size;
  }
  private ring(p: THREE.Vector3, r: number, c: THREE.Color, opacity: number): void {
    if (this.nr >= MAX_RINGS || r <= 0 || opacity <= 0.003) return;
    const m = this.rings[this.nr++];
    m.position.copy(p); m.scale.setScalar(r); m.visible = true;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.color.copy(c); mat.opacity = opacity;
  }

  /** Forces moving from a capital to the front: a line whose bright pulses march toward the fighting. */
  private march(from: THREE.Vector3, to: THREE.Vector3, c: THREE.Color, fade: number, t: number, phase: number): void {
    const N = 16;
    for (let k = 0; k < N; k++) {
      const u0 = k / N, u1 = (k + 1) / N;
      const pulse = (u: number) => (REDUCED_MOTION ? 0.55 : 0.3 + 0.9 * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * (u * 3 - t * 0.8 + phase)), 6));
      this.seg(v1.lerpVectors(from, to, u0), v2.lerpVectors(from, to, u1), c, pulse(u0) * fade, c, pulse(u1) * fade);
    }
  }

  /** A projectile crossing from p0 (launched t0) to p1 (lands t1): its trail, the course still ahead, the slug. */
  private slug(p0: THREE.Vector3, p1: THREE.Vector3, t0: number, t1: number, year: number, t: number, war: number): void {
    const f = Math.min(1, Math.max(0, (year - t0) / Math.max(0.1, t1 - t0)));
    v3.lerpVectors(p0, p1, f);
    const N = 24;
    for (let k = 0; k < N; k++) {
      const u0 = k / N, u1 = (k + 1) / N;
      if (u0 >= f) { this.seg(v1.lerpVectors(p0, p1, u0), v2.lerpVectors(p0, p1, u1), FIRE, 0.05, FIRE, 0.05); continue; }
      const w = (u: number) => 0.05 + 0.85 * Math.pow(Math.min(u, f) / Math.max(f, 1e-3), 4);
      this.seg(v1.lerpVectors(p0, p1, u0), v2.lerpVectors(p0, p1, Math.min(u1, f)), SLUG, w(u0), SLUG, w(Math.min(u1, f)));
    }
    this.head(v3, SLUG, 1, 6 + (REDUCED_MOTION ? 0 : 1.5 * Math.sin(t * 9 + war)), war);
  }

  /** An impact at p, `since` years ago. */
  private impact(p: THREE.Vector3, since: number, war: number, scale = 0): void {
    const k = Math.max(0, 1 - since / LINGER);
    if (k <= 0) return;
    cT.copy(FLASH).lerp(FIRE, Math.min(1, since / 8));
    this.head(p, cT, k, 4 + 16 * k * k, war);
    this.ring(p, scale ? scale * 1.4 + since * 0.05 : 0.3 + since * 0.12, FIRE, 0.5 * k * k);
  }

  draw(world: World, snap: StateMsg | null, year: number, t: number): void {
    this.ns = 0; this.nh = 0; this.nr = 0; this.headWar.length = 0; this.headAt.clear();
    this.wars = snap?.wars ?? [];
    if (this.inner) { this.drawWorlds(world, snap, year, t); this.finish(); return; }
    const earth = world.earth;
    const sysOf = (b: number) => world.bodies[b].system;
    const P = new THREE.Vector3(), PA = new THREE.Vector3(), PB = new THREE.Vector3();
    for (const w of this.wars) {
      if (year < w.start) continue;
      if (w.kinetic) {
        this.at(w.from, PA); this.at(w.sys, PB);
        if (year < w.arrive) this.slug(PA, PB, w.start, w.arrive, year, t, w.id);
        else this.impact(PB, year - w.arrive, w.id);
        if (w.end > w.arrive + 0.01 && year >= w.arrive) {
          if (year < w.end) this.slug(PB, PA, w.arrive, w.end, year, t, w.id);
          else this.impact(PA, year - w.end, w.id);
        }
        continue;
      }
      const active = year < w.end || w.outcome === OUTCOME.ONGOING;
      const fade = active ? 1 : Math.max(0, 1 - (year - w.end) / LINGER);
      if (fade <= 0) continue;
      this.at(w.sys, P); this.at(sysOf(w.a), PA); this.at(sysOf(w.b), PB);
      factionColor(w.a, earth, cA); factionColor(w.b, earth, cB);
      if (active) {
        if (PA.distanceToSquared(P) > 1e-4) this.march(PA, P, cA, 1, t, 0);
        if (PB.distanceToSquared(P) > 1e-4) this.march(PB, P, cB, 1, t, 0.5);
        const beat = REDUCED_MOTION ? 0 : Math.sin(t * 7 + w.id);
        this.head(P, FIRE, 0.9 + 0.1 * beat, 6 + 0.5 * Math.log10(1 + w.killed) + 1.5 * beat, w.id);
      } else {
        if (w.outcome === OUTCOME.ANNEX && w.winner >= 0) factionColor(w.winner, earth, cT);
        else cT.copy(w.outcome === OUTCOME.REPARATIONS ? GOLD : PALE);
        this.head(P, cT, fade, 3 + 6 * fade, w.id);
        if (w.outcome === OUTCOME.ANNEX) this.ring(P, 0.4 + (year - w.end) * 0.08, cT, 0.45 * fade * fade);
      }
      // news of the war, spreading at light speed (1 ly a year)
      const age = year - w.start;
      if (age < LINGER + 20) this.ring(P, Math.max(0.05, age), FIRE, 0.18 * fade * (1 - age / (LINGER + 20)));
    }
    // polities arming: their stars pulse in their colour
    if (snap?.postures.length) {
      const arming = new Map(snap.postures);
      const seen = new Set<number>();
      for (const b of snap.settled) {
        const f = snap.S[b * NF + F.faction], p = arming.get(f);
        if (p === undefined) continue;
        const sys = sysOf(b);
        if (seen.has(sys)) continue;
        seen.add(sys);
        factionColor(f, earth, cT).lerp(FIRE, 0.35);
        const beat = REDUCED_MOTION ? 0.5 : 0.5 + 0.5 * Math.sin(t * (2 + p) + f);
        this.head(this.at(sys, P), cT, 0.35 + 0.3 * beat, 2.5 + p * 1.6 * beat);
      }
    }
    this.finish();
  }

  private finish(): void {
    for (let k = this.nr; k < MAX_RINGS; k++) this.rings[k].visible = false;
    const g = this.lines.geometry;
    g.setDrawRange(0, this.ns * 2);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    const hg = this.heads.geometry;
    hg.setDrawRange(0, this.nh);
    hg.attributes.position.needsUpdate = true; hg.attributes.color.needsUpdate = true; hg.attributes.size.needsUpdate = true;
  }

  /** Inside one system: fights between its worlds, strikes in and out, worlds arming. */
  private drawWorlds(world: World, snap: StateMsg | null, year: number, t: number): void {
    const I = this.inner!, here = I.here(), earth = world.earth;
    if (!snap || here < 0) return;
    const S = snap.S, fac = (b: number) => S[b * NF + F.faction];
    const E = new THREE.Vector3();
    for (const w of this.wars) {
      if (year < w.start) continue;
      if (w.kinetic) {
        // a is the launching world, b the target; only the ends inside this system show
        const pa = world.bodies[w.a].system === here ? I.body(w.a) : null, pb = world.bodies[w.b].system === here ? I.body(w.b) : null;
        if (pb) {
          I.edge(w.from, pb, E);
          if (year < w.arrive) this.slug(E, pb, w.start, w.arrive, year, t, w.id);
          else this.impact(pb, year - w.arrive, w.id, I.size(w.b));
          if (w.end > w.arrive + 0.01 && year >= w.arrive && year < w.end) this.slug(pb, E, w.arrive, w.end, year, t, w.id);
        }
        if (pa) {
          I.edge(w.sys, pa, E);
          if (year < w.arrive) this.slug(pa, E, w.start, w.arrive, year, t, w.id);
          if (w.end > w.arrive + 0.01 && year >= w.arrive) {
            if (year < w.end) this.slug(E, pa, w.arrive, w.end, year, t, w.id);
            else this.impact(pa, year - w.end, w.id, I.size(w.a));
          }
        }
        continue;
      }
      if (w.sys !== here) continue;
      const active = year < w.end || w.outcome === OUTCOME.ONGOING;
      const fade = active ? 1 : Math.max(0, 1 - (year - w.end) / LINGER);
      if (fade <= 0) continue;
      const front = this.frontOf(w, world, snap), target = this.targetOf(w, world, snap);
      const pf = front >= 0 ? I.body(front) : null, pt = target >= 0 ? I.body(target) : null;
      if (!pf || !pt) continue;
      factionColor(w.a, earth, cA); factionColor(w.b, earth, cB);
      if (active) {
        // the two main worlds trade blows; every other world each side holds here sends its forces in
        this.march(pf, pt, cA, 1, t, 0);
        this.march(pt, pf, cB, 0.8, t, 0.5);
        let na = 0, nb = 0;
        for (const b of world.systems[here].bodies) {
          if (b === front || b === target) continue;
          const f = fac(b);
          if (f !== w.a && f !== w.b) continue;
          if ((f === w.a ? na++ : nb++) >= 6) continue;
          const p = I.body(b);
          if (p) this.march(p, f === w.a ? pt : pf, f === w.a ? cA : cB, 0.45, t, hash(b));
        }
        const beat = REDUCED_MOTION ? 0 : Math.sin(t * 7 + w.id);
        this.head(pt, FIRE, 0.9 + 0.1 * beat, 7 + 0.5 * Math.log10(1 + w.killed) + 1.5 * beat, w.id);
        this.head(pf, FIRE, 0.5, 4 + (REDUCED_MOTION ? 0 : 1.2 * Math.sin(t * 9 + w.id + 1)), w.id);
      } else {
        if (w.outcome === OUTCOME.ANNEX && w.winner >= 0) factionColor(w.winner, earth, cT);
        else cT.copy(w.outcome === OUTCOME.REPARATIONS ? GOLD : PALE);
        this.head(pt, cT, fade, 4 + 7 * fade, w.id);
        if (w.outcome === OUTCOME.ANNEX) this.ring(pt, I.size(target) * 1.6 + (year - w.end) * 0.04, cT, 0.5 * fade * fade);
      }
    }
    if (snap.postures.length) {
      const arming = new Map(snap.postures);
      for (const b of world.systems[here].bodies) {
        const f = fac(b), p = arming.get(f);
        if (p === undefined || !(S[b * NF + F.pop] > 0)) continue;
        const pos = I.body(b);
        if (!pos) continue;
        factionColor(f, earth, cT).lerp(FIRE, 0.35);
        const beat = REDUCED_MOTION ? 0.5 : 0.5 + 0.5 * Math.sin(t * (2 + p) + f);
        this.head(pos, cT, 0.3 + 0.3 * beat, 3 + p * 2 * beat);
        this.ring(pos, I.size(b) * (1.3 + 0.25 * beat * p), cT, 0.12 + 0.1 * beat);
      }
    }
  }

  /** Where each side fights from in the contested system: its most populous world there (the war log's front and target are polity-wide). */
  private sideWorld(f: number, world: World, snap: StateMsg, sys: number): number {
    let best = -1, top = -1;
    for (const b of world.systems[sys].bodies) {
      if (snap.S[b * NF + F.faction] !== f) continue;
      const p = snap.S[b * NF + F.pop];
      if (p > top) { top = p; best = b; }
    }
    return best >= 0 ? best : world.bodies[f]?.system === sys ? f : -1;
  }
  private frontOf(w: WarVis, world: World, snap: StateMsg): number { return this.sideWorld(w.a, world, snap, w.sys); }
  private targetOf(w: WarVis, world: World, snap: StateMsg): number {
    const t = this.sideWorld(w.b, world, snap, w.sys);
    // annexed: the loser's worlds here now fly the winner's flag, so fall back to the loser's capital
    return t >= 0 ? t : world.bodies[w.b]?.system === w.sys ? w.b : -1;
  }

  /** Labels for the biggest fights under way at this year. */
  labels(world: World, year: number, n = 4): WarLabel[] {
    return this.wars
      .filter((w) => year >= w.start && (year < (w.kinetic ? Math.max(w.arrive, w.end) : w.end) || (!w.kinetic && w.outcome === OUTCOME.ONGOING)) && (!this.inner || this.headAt.has(w.id)))
      .sort((a, b) => b.killed - a.killed)
      .slice(0, n)
      .map((w) => {
        const dead = w.killed > 0 ? ` · ${fmtNum(w.killed)} dead` : '';
        const sub = w.kinetic ? `${sideName(w, 'a', world)} strikes ${world.systems[w.sys].name}` : `${sideName(w, 'a', world)} against ${sideName(w, 'b', world)}${dead}`;
        const pos = this.inner ? this.headAt.get(w.id)!.clone().add(new THREE.Vector3(0, 2.6, 0)) : this.at(w.sys, new THREE.Vector3());
        return { pos, text: warName(w), sub, sys: w.sys, prio: 11 + Math.log10(1 + w.killed) / 4 };
      });
  }

  private card(id: number, c: ExCtx): Explanation {
    const w = this.wars.find((x) => x.id === id) ?? null;
    const A = annals?.wars[id];
    if (!w) return { eyebrow: 'War', title: A?.name ?? 'War', lede: 'This war is no longer on the map at this year.', facts: [] };
    const world = c.world, a = sideName(w, 'a', world), b = sideName(w, 'b', world), place = world.systems[w.sys].name;
    const done = w.outcome !== OUTCOME.ONGOING && c.year >= w.end;
    const fw = !w.kinetic && c.snap ? this.frontOf(w, world, c.snap) : -1, tw = !w.kinetic && c.snap ? this.targetOf(w, world, c.snap) : -1;
    const worlds = fw >= 0 && tw >= 0 && fw !== tw ? `${world.bodies[fw].name} against ${world.bodies[tw].name}` : '';
    const facts: Fact[] = [
      { k: 'Sides', v: `${a} against ${b}`, t: 'P' },
      { k: 'Began', v: fmtYear(w.start), t: 'P' },
    ];
    if (A) facts.push({ k: 'Cause', v: A.cause, t: 'P' });
    if (w.kinetic) {
      facts.push({ k: 'Launched from', v: world.systems[w.from].name, t: 'P' }, { k: 'Lands', v: fmtYear(w.arrive), t: 'P' });
      if (w.end > w.arrive + 0.01) facts.push({ k: 'Reply lands', v: fmtYear(w.end), t: 'P' });
    } else {
      facts.push({ k: 'Front', v: worlds ? `${worlds}, ${place}` : place, t: 'P' }, { k: done ? 'Ended' : 'Due to end', v: done || c.year < w.end ? fmtYear(w.end) : 'any year now', t: 'P' });
      if (done && w.outcome >= 0) {
        const how = w.outcome === OUTCOME.ANNEX ? 'annexation' : w.outcome === OUTCOME.REPARATIONS ? 'reparations' : 'white peace';
        const by = w.winner >= 0 ? ` (${w.winner === w.a ? a : b} won)` : '';
        facts.push({ k: 'Outcome', v: how + by, t: 'P' });
      }
    }
    if (w.killed > 0) facts.push({ k: 'Dead', v: fmtNum(w.killed), t: 'P' });
    const lede = w.kinetic
      ? `A relativistic strike: ${a} threw mass at ${place} at a fraction of light speed, unseen until its own light arrived just ahead of it.`
      : `${a} and ${b} fight in ${place}${worlds ? `, ${worlds}` : ''}. Each side's forces are drawn toward the front; the rest of both polities hear of it at light speed and mobilise then.`;
    return { eyebrow: w.kinetic ? 'Kinetic war' : 'War', title: warName(w), lede, facts, links: [{ label: place, act: 'system', id: w.sys }] };
  }
}
