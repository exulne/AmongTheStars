// Above the Local Group: every future played so far as a universe bubble,
// placed by what it came to (further right: more energy, the Kardashev
// rating it reached; higher: more star systems settled; deeper: more wars),
// sized by its peak population and coloured by its outcome. Around them, the
// foam of futures nobody has played yet. Entering a bubble switches the
// simulation to that future.

import * as THREE from 'three';
import { OUTCOME_COLOR, OUTCOME_NAME, foamSeed, futureCard, summarise, unplayedCard, type FutureSum } from '../explain/multiverse.ts';
import { addGpuSet } from '../explain/picker.ts';
import { pointWorld, registerExplainer } from '../explain/registry.ts';
import { fmtNum } from '../ui/format.ts';
import { pointsMaterial } from './textures.ts';
import { addLights, rimMaterial, rng } from './microKit.ts';
import type { Ctx, Label, Level, Pickable, Ref, View } from './views.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const FOAM = 1800;

interface Bubble { s: FutureSum; pos: THREE.Vector3; r: number; obj: THREE.Group }

export class MultiverseView implements View {
  level: Level = 'multiverse';
  group = new THREE.Group();
  limits: [number, number] = [3, 400];
  /** the future being simulated now */
  current = 1;
  /** how many sibling futures the background worker has finished, of how many */
  progress = { done: 0, of: 0 };
  private sums = new Map<number, FutureSum>();
  private bubbles: Bubble[] = [];
  private world = new THREE.Group();
  private axes = new THREE.Group();
  private key = '';
  private axisLabels: Label[] = [];
  private foam: THREE.Points;

  constructor() {
    this.group.add(this.world, this.axes);
    addLights(this.group, 40);
    // the foam: futures not yet played
    const r = rng(0.913), pos = new Float32Array(FOAM * 3), col = new Float32Array(FOAM * 3), size = new Float32Array(FOAM);
    for (let i = 0; i < FOAM; i++) {
      const d = V(r() - 0.5, (r() - 0.5) * 0.8, r() - 0.5).normalize().multiplyScalar(70 + Math.pow(r(), 0.6) * 160);
      pos.set([d.x, d.y, d.z], i * 3);
      const v = 0.08 + r() * 0.14, h = r();
      col.set([v * (0.7 + 0.3 * h), v * 0.8, v * (1.1 - 0.3 * h)], i * 3);
      size[i] = 1 + r() * 2.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.foam = new THREE.Points(geo, pointsMaterial({ sizeScale: 0.9, minPx: 1.2, maxPx: 10 }));
    this.foam.frustumCulled = false;
    this.group.add(this.foam);
    addGpuSet({ kind: 'futx', points: this.foam, pickPx: 6, minLum: 0.05 });
    registerExplainer('futx', { obj: this.foam, explain: (i) => unplayedCard(foamSeed(i)), name: (i) => `Future #${foamSeed(i)}, not yet played`, locate: (i, out) => pointWorld(this.foam, i, out), idOf: (i) => i });
    registerExplainer('futu', {
      obj: this.group,
      explain: (seed) => {
        const s = this.sums.get(seed);
        if (!s) return unplayedCard(seed);
        const list = this.shown();
        const rank = (x: FutureSum) => 1 + list.filter((y) => y.peakPop > x.peakPop).length;
        return futureCard(s, seed === this.current, rank, list.length);
      },
      name: (seed) => `Future #${seed}${seed === this.current ? ' (this one)' : ''}`,
      locate: (seed, out) => { const b = this.bubbles.find((x) => x.s.seed === seed); return b ? out.copy(b.pos) : null; },
    });
  }

  /** Record a future's series (the current run's as it grows, or a finished sibling's). */
  add(seed: number, years: ArrayLike<number>, series: Float64Array, nSteps: number, done: boolean): void {
    const old = this.sums.get(seed);
    if (old?.done && !done) return;
    this.sums.set(seed, summarise(seed, years, series, nSteps, done));
  }

  /** The futures drawn: this one, its played siblings, and earlier ones (at most 80). */
  private shown(): FutureSum[] {
    const all = [...this.sums.values()];
    const cur = all.filter((s) => s.seed === this.current), rest = all.filter((s) => s.seed !== this.current);
    return cur.concat(rest.slice(-79));
  }

  enter(ctx: Ctx): void {
    this.sync(ctx);
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(14, 10, 78);
  }

  sync(_ctx: Ctx): void {
    const list = this.shown();
    const key = `${this.current}|${list.map((s) => `${s.seed}:${s.done ? 1 : 0}:${Math.round(s.lastYear)}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.layout(list);
  }

  private layout(list: FutureSum[]): void {
    this.world.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.world.clear(); this.axes.clear();
    this.bubbles = [];
    // axes fitted to the futures shown, so they spread out however alike they are
    const ks = list.map((s) => s.peakK), ls = list.map((s) => Math.log10(Math.max(1, s.peakSystems))), ws = list.map((s) => s.wars);
    const pad = (lo: number, hi: number, min: number): [number, number] => { const m = Math.max(min, hi - lo); const c = (lo + hi) / 2; return [c - m * 0.6, c + m * 0.6]; };
    const [k0, k1] = pad(Math.min(...ks), Math.max(...ks), 0.1);
    const [l0, l1] = pad(Math.min(...ls), Math.max(...ls), 0.5);
    const [w0, w1] = pad(Math.min(...ws), Math.max(...ws), 4);
    const X = (k: number): number => ((k - k0) / (k1 - k0) - 0.5) * 64;
    const Y = (sy: number) => ((Math.log10(Math.max(1, sy)) - l0) / (l1 - l0) - 0.5) * 36;
    const Zd = (w: number) => -((w - w0) / (w1 - w0) - 0.5) * 22;
    // half by value, half by rank: alike futures still stand apart, and the order is always true
    const rk = (xs: number[], x: number) => (xs.length > 1 ? xs.filter((y) => y < x).length / (xs.length - 1) - 0.5 : 0);
    for (const s of list) {
      const r = rng(s.seed * 0.0001 + 0.3);
      const pos = V(X(s.peakK) * 0.5 + rk(ks, s.peakK) * 32 + (r() - 0.5) * 1.5, Y(s.peakSystems) * 0.5 + rk(ls, Math.log10(Math.max(1, s.peakSystems))) * 18 + (r() - 0.5) * 1.5, Zd(s.wars));
      const rad = Math.max(1.1, Math.min(3.6, 1.4 + 0.55 * Math.log10(Math.max(1, s.peakPop) / 1e9)));
      const g = new THREE.Group();
      g.position.copy(pos);
      const col = OUTCOME_COLOR[s.outcome], cur = s.seed === this.current;
      const skin = new THREE.Mesh(new THREE.SphereGeometry(rad, 40, 28), rimMaterial(col, cur ? 0.12 : 0.07, cur ? 0.55 : 0.3));
      skin.renderOrder = 4;
      g.add(skin);
      // inside: a little cosmos whose richness is what that future made of itself
      const n = Math.round(40 + 70 * Math.log10(1 + s.peakSystems)) * (s.outcome === 'died' ? 0.4 : 1);
      const P = new Float32Array(n * 3), C = new Float32Array(n * 3), Sz = new Float32Array(n);
      const tint = new THREE.Color(col), war = new THREE.Color(0xd04a3a);
      for (let i = 0; i < n; i++) {
        const arm = i % 3, t = r(), a = arm * 2.09 + t * 4.2, rr = t * rad * 0.8;
        P.set([Math.cos(a) * rr + (r() - 0.5) * 0.25 * rad, (r() - 0.5) * 0.12 * rad, Math.sin(a) * rr + (r() - 0.5) * 0.25 * rad], i * 3);
        const c = tint.clone().lerp(war, Math.min(0.8, s.warShare * 3) * r()).multiplyScalar(0.35 + 0.35 * r());
        C.set([c.r, c.g, c.b], i * 3);
        Sz[i] = 0.6 + r();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3)); geo.setAttribute('color', new THREE.BufferAttribute(C, 3)); geo.setAttribute('size', new THREE.BufferAttribute(Sz, 1));
      const pts = new THREE.Points(geo, pointsMaterial({ sizeScale: 0.12, minPx: 1, maxPx: 5 }));
      pts.rotation.set(r() * 0.8, r() * 6, r() * 0.8);
      pts.frustumCulled = false;
      g.add(pts);
      if (cur) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(rad * 1.3, rad * 0.015, 6, 64), new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.6 }));
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
      }
      this.world.add(g);
      this.bubbles.push({ s, pos, r: rad, obj: g });
    }
    // axes: thin rules with their meaning at the ends
    const line = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0x8a96a8, transparent: true, opacity: 0.28 }));
    const o = V(-34, -21, -14);
    this.axes.add(line(o, V(34, -21, -14)), line(o, V(-34, 21, -14)), line(o, V(-34, -21, 14)));
    this.axisLabels = [
      // the ends of each axis are the least and the most among the futures shown (placement is half value, half rank)
      { pos: V(34, -21, -14), text: `Kardashev ${Math.max(...ks).toFixed(2)}`, sub: 'most energy reached →', prio: 3 },
      { pos: V(-34, -23, -14), text: `Kardashev ${Math.min(...ks).toFixed(2)}`, prio: 2 },
      { pos: V(-35, 18, -14), text: `${fmtNum(Math.round(10 ** Math.max(...ls)))} star systems`, sub: 'most settled ↑', prio: 2 },
      { pos: V(-35, -18, -14), text: `${fmtNum(Math.round(10 ** Math.min(...ls)))} star system${Math.min(...ls) > 0 ? 's' : ''}`, prio: 2 },
      { pos: V(-34, -21, 15), text: `${Math.round(Math.min(...ws))} wars`, sub: `up to ${Math.round(Math.max(...ws))} further back`, prio: 2 },
    ];
  }

  frame(ctx: Ctx, dt: number): void {
    for (const b of this.bubbles) { const p = b.obj.children[1]; if (p) p.rotation.y += dt * 0.05 * (b.s.seed % 2 ? 1 : -1); }
    void ctx;
  }

  pickables(): Pickable[] {
    return this.bubbles.map((b) => ({ pos: b.pos, kind: 'thing' as const, ex: 'futu', id: b.s.seed, name: `Future #${b.s.seed} · ${OUTCOME_NAME[b.s.outcome]}`, r: b.r, weight: b.s.seed === this.current ? 3 : 1 }));
  }

  labels(): Label[] {
    const out: Label[] = this.bubbles.map((b) => {
      const cur = b.s.seed === this.current;
      return { pos: b.pos.clone().add(V(0, b.r * 1.15, 0)), text: cur ? `This future, #${b.s.seed}` : `#${b.s.seed}`, sub: `${OUTCOME_NAME[b.s.outcome]} · peak ${fmtNum(b.s.peakPop)}${b.s.done ? '' : ' · still playing'}`, strong: cur, prio: cur ? 12 : 5 + Math.log10(Math.max(1, b.s.peakPop)) * 0.1, ref: { kind: 'thing' as const, ex: 'futu', id: b.s.seed, name: `Future #${b.s.seed}` } };
    });
    const p = this.progress;
    out.push({ pos: V(0, 27, -14), text: 'Futures', sub: p.of && p.done < p.of ? `playing the other futures in the background: ${p.done} of ${p.of}` : `${this.bubbles.length} played, the rest of the 99,999 drawn as foam`, strong: true, prio: 11 });
    return out.concat(this.axisLabels);
  }

  locate(_ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'thing' && r.ex === 'futu') return this.bubbles.find((b) => b.s.seed === r.id)?.pos.clone() ?? null;
    // coming up from the Local Group: start at this future's bubble
    if (r.kind === 'galaxy' || r.kind === 'humanspace' || r.kind === 'system' || r.kind === 'body') return this.bubbles.find((b) => b.s.seed === this.current)?.pos.clone() ?? null;
    return null;
  }

  diveDist(_ctx: Ctx, r: Ref): number {
    if (r.kind !== 'thing' || r.ex !== 'futu') return 0;
    return (this.bubbles.find((b) => b.s.seed === r.id)?.r ?? 2) * 4;
  }

  size(_ctx: Ctx, r: Ref): number { return r.kind === 'thing' && r.ex === 'futu' ? this.bubbles.find((b) => b.s.seed === r.id)?.r ?? 0 : 0; }
}
