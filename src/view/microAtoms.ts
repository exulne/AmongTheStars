// The two smallest levels. A molecule in ångströms, ball and stick, every
// atom pickable, its neighbours dimmed around it. And one atom: the electron
// cloud of every occupied subshell sampled from hydrogen-like orbitals (each
// dot a place an electron could be found, a few re-drawn every frame), around
// a nucleus of real protons and neutrons, enlarged so it can be seen at all.

import * as THREE from 'three';
import { atomInMolCard, molCard, nucleonCard, nucleusCard, subshellCard, wholeAtomCard, type AtomSpec } from '../explain/micro.ts';
import { addGpuSet } from '../explain/picker.ts';
import { registerExplainer } from '../explain/registry.ts';
import type { CellPlan } from '../micro/cells.ts';
import { angular, configuration, elem, meanRadius, orbitalFill, radialDensity, subName, type Subshell } from '../micro/elements.ts';
import type { Molecule } from '../micro/molecules.ts';
import type { Specimen } from '../micro/specimen.ts';
import { pointsMaterial } from './textures.ts';
import type { Micro } from './micro.ts';
import { addLights, rng } from './microKit.ts';
import type { Ctx, Label, Level, Pickable, Ref, View } from './views.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const ballR = (Z: number) => (Z === 0 ? 0.5 : 0.16 + 0.34 * elem(Z).cov / 100);

export class MoleculeView implements View {
  level: Level = 'molecule';
  group = new THREE.Group();
  limits: [number, number] = [0.5, 600];
  private key = '';
  private mol: Molecule | null = null;
  private sp: Specimen | null = null;
  private plan: CellPlan | null = null;
  private pos: THREE.Vector3[] = [];
  private R = 15;

  constructor(private m: Micro) {
    const none = { eyebrow: 'Molecule', title: 'Molecule', lede: 'Finding them…', facts: [{ k: 'Status', v: 'loading', t: 'P' as const }] };
    registerExplainer('matm', {
      obj: this.group,
      explain: (i) => (this.sp && this.mol ? atomInMolCard(this.sp, this.mol, i) : none),
      name: (i) => { const a = this.mol?.atoms[i]; return a ? (a.Z ? `${elem(a.Z).name[0].toUpperCase()}${elem(a.Z).name.slice(1)}: ${a.role}` : 'Vacancy') : ''; },
      locate: (i, out) => (this.pos[i] ? out.copy(this.pos[i]) : null),
    });
    registerExplainer('mmol', { obj: this.group, explain: () => (this.sp && this.mol && this.plan ? molCard(this.sp, this.plan, this.mol) : none), locate: (_i, out) => out.set(0, 0, 0) });
  }

  enter(ctx: Ctx): void {
    this.sync(ctx);
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(this.R * 0.8, this.R * 0.6, this.R * 2.3);
    this.limits = [0.6, this.R * 14];
  }

  sync(ctx: Ctx): void {
    this.m.ensure(ctx);
    const mol = this.m.molecule(ctx);
    this.sp = this.m.specimen(ctx); this.plan = this.m.plan(ctx); this.mol = mol;
    if (!mol || !this.plan) return;
    const key = `${this.plan.key}|${this.m.orgl}`;
    if (key === this.key) return;
    this.key = key;
    this.build(mol);
  }

  private build(mol: Molecule): void {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.group.clear();
    const subj = mol.atoms.filter((a) => a.mol < 0);
    const c = [0, 1, 2].map((k) => subj.reduce((s, a) => s + a.p[k], 0) / Math.max(1, subj.length));
    this.pos = mol.atoms.map((a) => V(a.p[0] - c[0], a.p[1] - c[1], a.p[2] - c[2]));
    this.R = Math.max(6, ...mol.atoms.map((a, k) => (a.mol < 0 ? this.pos[k].length() : 0))) + 3;
    addLights(this.group, this.R);
    const n = mol.atoms.length;
    const balls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.05, emissive: 0x0c0c0c }), n);
    const mtx = new THREE.Matrix4(), col = new THREE.Color(), dim = new THREE.Color(0x0a0c12);
    const vac: THREE.Vector3[] = [];
    mol.atoms.forEach((a, k) => {
      const s = a.Z ? ballR(a.Z) * (a.mol < 0 ? 1 : 0.85) : 0.0001;
      if (!a.Z) vac.push(this.pos[k]);
      balls.setMatrixAt(k, mtx.makeScale(s, s, s).setPosition(this.pos[k]));
      col.set(a.Z ? elem(a.Z).color : 0);
      if (a.Z === 1) col.multiplyScalar(0.82);
      if (a.mol >= 0) col.lerp(dim, 0.62);
      balls.setColorAt(k, col);
    });
    this.group.add(balls);
    // bonds: each a cylinder in two halves, coloured by the atom at its end
    const bonds = mol.bonds.filter(([i, j]) => mol.atoms[i].Z && mol.atoms[j].Z);
    const sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 8, 1, true), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, emissive: 0x080808 }), bonds.length * 2);
    const up = V(0, 1, 0), q = new THREE.Quaternion();
    bonds.forEach(([i, j], k) => {
      const a = this.pos[i], b = this.pos[j], d = b.clone().sub(a), L = d.length();
      q.setFromUnitVectors(up, d.clone().normalize());
      for (const h of [0, 1]) {
        const at = h ? mol.atoms[j] : mol.atoms[i];
        const mid = a.clone().addScaledVector(d, h ? 0.75 : 0.25);
        sticks.setMatrixAt(k * 2 + h, mtx.compose(mid, q, V(at.mol < 0 ? 1 : 0.7, L / 2, at.mol < 0 ? 1 : 0.7)));
        col.set(elem(at.Z).color).multiplyScalar(at.Z === 1 ? 0.75 : 0.9);
        if (at.mol >= 0) col.lerp(dim, 0.62);
        sticks.setColorAt(k * 2 + h, col);
      }
    });
    this.group.add(sticks);
    if (mol.hbonds.length) {
      const hp: number[] = [];
      for (const [i, j] of mol.hbonds) hp.push(this.pos[i].x, this.pos[i].y, this.pos[i].z, this.pos[j].x, this.pos[j].y, this.pos[j].z);
      const hl = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(hp, 3)), new THREE.LineDashedMaterial({ color: 0x9fd8ff, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.7 }));
      hl.computeLineDistances();
      this.group.add(hl);
    }
    for (const p of vac) {
      const w = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshBasicMaterial({ color: 0xff8080, wireframe: true, transparent: true, opacity: 0.6 }));
      w.position.copy(p);
      this.group.add(w);
    }
    // a soft glow on highlighted atoms: an edit, a dopant, a defect, the bound oxygen
    const hlIdx = mol.atoms.map((a, k) => (a.hl ? k : -1)).filter((k) => k >= 0);
    if (hlIdx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(hlIdx.flatMap((k) => [this.pos[k].x, this.pos[k].y, this.pos[k].z]), 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(hlIdx.flatMap(() => [0.25, 0.6, 0.7]), 3));
      geo.setAttribute('size', new THREE.Float32BufferAttribute(hlIdx.map(() => 1), 1));
      const glow = new THREE.Points(geo, pointsMaterial({ sizeScale: 1.6, minPx: 4, maxPx: 60 }));
      glow.frustumCulled = false;
      this.group.add(glow);
    }
  }

  frame(): void {}

  pickables(): Pickable[] {
    const mol = this.mol;
    if (!mol) return [];
    return mol.atoms.map((a, k) => ({ pos: this.pos[k], kind: 'thing' as const, ex: 'matm', id: k, name: a.Z ? `${elem(a.Z).name}: ${a.role}` : 'vacancy', r: ballR(a.Z), weight: a.mol < 0 ? 1 : 0 }));
  }

  labels(): Label[] {
    const mol = this.mol;
    if (!mol) return [];
    const top = Math.max(...this.pos.map((p, k) => (mol.atoms[k].mol < 0 ? p.y : -1e9)));
    const out: Label[] = [{ pos: V(0, top + 3, 0), text: mol.name, sub: `${mol.formula}${this.sp ? ` · in ${this.sp.name}` : ''}${mol.hHidden ? ' · hydrogens hidden' : ''}`, strong: true, prio: 12, ref: { kind: 'thing', ex: 'mmol', id: 0, name: mol.name } }];
    const hl = mol.atoms.findIndex((a) => a.hl);
    if (hl >= 0) out.push({ pos: this.pos[hl], text: mol.atoms[hl].role.replace(/,.*/, ''), sub: 'highlighted', prio: 9, ref: { kind: 'thing', ex: 'matm', id: hl, name: mol.atoms[hl].role } });
    const env = mol.atoms.findIndex((a) => a.mol >= 0);
    if (env >= 0 && mol.envName) out.push({ pos: this.pos[env], text: mol.envName, prio: 2, ref: { kind: 'thing', ex: 'matm', id: env, name: mol.envName } });
    return out;
  }

  locate(_ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'thing' && r.ex === 'matm') return this.pos[r.id]?.clone() ?? null;
    if (r.kind === 'thing' && (r.ex === 'mmol' || r.ex === 'morg' || r.ex === 'mpts')) return V(0, 0, 0);
    return null;
  }

  diveDist(_ctx: Ctx, r: Ref): number { return r.kind === 'thing' && r.ex === 'matm' && this.mol?.atoms[r.id]?.Z ? 2.2 : 0; }
  size(_ctx: Ctx, r: Ref): number { return r.kind === 'thing' && r.ex === 'matm' && this.mol?.atoms[r.id] ? ballR(this.mol.atoms[r.id].Z) : 0; }
}

// ---------------------------------------------------------------- the atom

interface Cloud { s: Subshell; from: number; to: number }

export class AtomView implements View {
  level: Level = 'atom';
  group = new THREE.Group();
  limits: [number, number] = [0.001, 60];
  private key = '';
  private spec: AtomSpec | null = null;
  private sp: Specimen | null = null;
  private cfg: Subshell[] = [];
  private clouds: Cloud[] = [];
  private nucleons: { p: THREE.Vector3; proton: boolean }[] = [];
  private Rn = 0.01;
  private outer = 1;
  private pts: THREE.Points | null = null;
  private pool: Float32Array | null = null;
  private shimmerAt = 0;

  constructor(private m: Micro) {
    const none = { eyebrow: 'Atom', title: 'Atom', lede: 'Finding it…', facts: [{ k: 'Status', v: 'loading', t: 'P' as const }] };
    registerExplainer('matom', { obj: this.group, explain: () => (this.sp && this.spec ? wholeAtomCard(this.sp, this.spec, this.Rn) : none), locate: (_i, out) => out.set(0, 0, 0) });
    registerExplainer('mnuc', {
      obj: this.group,
      explain: (i) => (this.sp && this.spec ? (i === 0 ? nucleusCard(this.sp, this.spec, this.Rn) : nucleonCard(this.nucleons[i - 1]?.proton ?? true, this.countOf(i))) : none),
      name: (i) => (i === 0 ? 'Nucleus' : this.nucleons[i - 1]?.proton ? 'Proton' : 'Neutron'),
      locate: (i, out) => (i === 0 ? out.set(0, 0, 0) : this.nucleons[i - 1] ? out.copy(this.nucleons[i - 1].p) : null),
    });
    registerExplainer('morb', {
      obj: this.group,
      explain: (k) => (this.spec && this.cfg[k] ? subshellCard(this.spec.Z, this.cfg[k], k === this.cfg.length - 1) : none),
      name: (k) => (this.cfg[k] ? `${subName(this.cfg[k])} electrons` : ''),
      locate: (_k, out) => out.set(0, 0, 0),
      idOf: (i) => this.clouds.findIndex((c) => i >= c.from && i < c.to),
    });
  }

  /** Proton 3, neutron 5…: numbered within their kind. */
  private countOf(i: number): number {
    const me = this.nucleons[i - 1];
    let n = 0;
    for (let k = 0; k < i; k++) if (this.nucleons[k].proton === me.proton) n++;
    return n;
  }

  enter(ctx: Ctx): void {
    this.sync(ctx);
    ctx.controls.target.set(0, 0, 0);
    const D = this.outer * 2.6;
    ctx.camera.position.set(D * 0.5, D * 0.45, D);
    this.limits = [this.Rn * 1.5, this.outer * 30];
  }

  /** Where to put the camera to see the nucleus itself. */
  nucleusView(): { pos: THREE.Vector3; target: THREE.Vector3 } { return { pos: V(this.Rn * 2.2, this.Rn * 1.6, this.Rn * 5), target: V(0, 0, 0) }; }

  sync(ctx: Ctx): void {
    this.m.ensure(ctx);
    const spec = this.m.atomSpec(ctx);
    this.sp = this.m.specimen(ctx); this.spec = spec;
    if (!spec || !this.sp) return;
    const key = `${spec.Z}|${spec.N}|${this.sp.pid}`;
    if (key === this.key) return;
    this.key = key;
    this.build(spec);
  }

  private build(spec: AtomSpec): void {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.group.clear();
    const r = rng(spec.Z * 0.013 + spec.N * 0.0007 + 0.1);
    const cfg = configuration(spec.Z);
    this.cfg = cfg;
    const radii = cfg.map(meanRadius);
    this.outer = Math.max(...radii);
    const inner = Math.min(...radii);
    this.Rn = Math.min(0.05 * this.outer, 0.4 * inner);
    addLights(this.group, this.Rn * 10);
    // the electron clouds
    const P: number[] = [], C: number[] = [], S: number[] = [], pool: number[] = [];
    this.clouds = [];
    const COL: [number, number, number][] = [[0.42, 0.58, 1.0], [0.3, 0.88, 0.72], [1.0, 0.72, 0.32]];
    cfg.forEach((s, k) => {
      const from = P.length / 3, mr = radii[k], rmax = mr * 4;
      // radial distribution, tabulated and inverted
      const N = 400, cdf = new Float64Array(N + 1);
      for (let q = 1; q <= N; q++) cdf[q] = cdf[q - 1] + radialDensity(s.n, s.l, s.zeff, (q / N) * rmax);
      const radius = (u: number) => { const t = u * cdf[N]; let lo = 0, hi = N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] < t) lo = mid; else hi = mid; } return (hi / N) * rmax; };
      const inside = k < cfg.length - 1 ? 0.55 : 1;
      for (const o of orbitalFill(s.l, s.e)) {
        if (!o.e) continue;
        const n = Math.min(2000, 900 * o.e);
        for (let q = 0; q < n * 2; q++) {
          let d = V(0, 0, 1);
          for (let t = 0; t < 40; t++) { d = V(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1); const L = d.length(); if (L > 1 || L < 1e-3) continue; d.divideScalar(L); if (r() < angular(o.name, d.x, d.y, d.z)) break; }
          const p = d.multiplyScalar(radius(r()));
          if (q < n) { P.push(p.x, p.y, p.z); const c = COL[s.l]; const v = (0.45 + 0.3 * r()) * inside; C.push(c[0] * v, c[1] * v, c[2] * v); S.push(mr * 0.05); }
          else pool.push(p.x, p.y, p.z);
        }
      }
      this.clouds.push({ s, from, to: P.length / 3 });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setAttribute('size', new THREE.Float32BufferAttribute(S, 1));
    const pts = new THREE.Points(geo, pointsMaterial({ sizeScale: 1, minPx: 1, maxPx: 5 }));
    pts.frustumCulled = false;
    this.group.add(pts);
    this.pts = pts; this.pool = Float32Array.from(pool);
    addGpuSet({ kind: 'morb', points: pts, pickPx: 4 });
    // the nucleus: protons and neutrons packed into a ball
    const A = spec.Z + spec.N, rn = this.Rn / Math.cbrt(A) * 0.98;
    const kinds = Array.from({ length: A }, (_, k) => k < spec.Z);
    for (let k = A - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [kinds[k], kinds[j]] = [kinds[j], kinds[k]]; }
    this.nucleons = kinds.map((proton, k) => {
      const rad = A === 1 ? 0 : this.Rn * 0.82 * Math.cbrt((k + 0.5) / A), y = 1 - (2 * (k + 0.5)) / A, rr = Math.sqrt(Math.max(0, 1 - y * y)), a = k * 2.39996;
      return { p: V(Math.cos(a) * rr * rad, y * rad, Math.sin(a) * rr * rad), proton };
    });
    const sph = new THREE.IcosahedronGeometry(rn, 2);
    const pm = new THREE.InstancedMesh(sph, new THREE.MeshStandardMaterial({ color: 0xd2604e, roughness: 0.4, emissive: 0x2a0c08 }), spec.Z);
    const nm = new THREE.InstancedMesh(sph, new THREE.MeshStandardMaterial({ color: 0x92a2ba, roughness: 0.4, emissive: 0x0c1018 }), Math.max(1, spec.N));
    nm.count = spec.N;
    let ip = 0, iN = 0;
    const mt = new THREE.Matrix4();
    for (const x of this.nucleons) { if (x.proton) pm.setMatrixAt(ip++, mt.makeTranslation(x.p.x, x.p.y, x.p.z)); else nm.setMatrixAt(iN++, mt.makeTranslation(x.p.x, x.p.y, x.p.z)); }
    this.group.add(pm, nm);
    // a faint halo so the nucleus can be found from afar
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)); hg.setAttribute('color', new THREE.Float32BufferAttribute([0.5, 0.25, 0.2], 3)); hg.setAttribute('size', new THREE.Float32BufferAttribute([1], 1));
    const halo = new THREE.Points(hg, pointsMaterial({ attenuate: false, sizeScale: 7, minPx: 7, maxPx: 7 }));
    halo.frustumCulled = false;
    this.group.add(halo);
  }

  frame(_ctx: Ctx, dt: number): void {
    // each frame a few electrons are found somewhere else in their cloud
    if (!this.pts || !this.pool || !this.pool.length) return;
    this.shimmerAt += dt;
    if (this.shimmerAt < 1 / 30) return;
    this.shimmerAt = 0;
    const a = this.pts.geometry.attributes.position.array as Float32Array;
    const n = a.length / 3, m = this.pool.length / 3;
    for (let k = 0; k < Math.ceil(n * 0.03); k++) {
      const i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * m);
      // only swap within the same subshell, so each cloud keeps its shape
      const c = this.clouds.find((x) => i >= x.from && i < x.to)!;
      const pj = this.poolIndex(c, j);
      if (pj < 0) continue;
      for (let q = 0; q < 3; q++) { const t = a[i * 3 + q]; a[i * 3 + q] = this.pool[pj * 3 + q]; this.pool[pj * 3 + q] = t; }
    }
    this.pts.geometry.attributes.position.needsUpdate = true;
  }

  /** The pool holds as many spare points per subshell as it draws, in the same order. */
  private poolIndex(c: Cloud, j: number): number {
    const len = c.to - c.from;
    return len > 0 ? c.from + (j % len) : -1;
  }

  pickables(ctx: Ctx): Pickable[] {
    const out: Pickable[] = [{ pos: V(0, 0, 0), kind: 'thing', ex: 'mnuc', id: 0, name: 'Nucleus', r: this.Rn * 1.3, weight: 3 }];
    if (ctx.camera.position.length() < this.Rn * 40) this.nucleons.forEach((x, k) => out.push({ pos: x.p, kind: 'thing', ex: 'mnuc', id: k + 1, name: x.proton ? 'Proton' : 'Neutron', r: this.Rn / Math.cbrt(this.nucleons.length), weight: 4 }));
    return out;
  }

  labels(ctx: Ctx): Label[] {
    const spec = this.spec;
    if (!spec) return [];
    const e = elem(spec.Z);
    const close = ctx.camera.position.length() < this.Rn * 40;
    const out: Label[] = [{ pos: V(0, this.outer * 1.9, 0), text: `${e.name[0].toUpperCase()}${e.name.slice(1)}-${spec.Z + spec.N}`, sub: `${spec.Z} protons, ${spec.N} neutrons, ${spec.Z} electrons · ${spec.role}`, strong: true, prio: 12, ref: { kind: 'thing', ex: 'matom', id: 0, name: e.name } }];
    out.push({ pos: V(this.Rn * 1.2, this.Rn * 1.2, 0), text: 'Nucleus', sub: close ? `drawn ${Math.round(this.Rn * 1e-10 / (1.2e-15 * Math.cbrt(spec.Z + spec.N))).toLocaleString('en-US')}× too large` : 'scroll in to see it', prio: 10, ref: { kind: 'thing', ex: 'mnuc', id: 0, name: 'Nucleus' } });
    this.cfg.forEach((s, k) => {
      const a = 0.6 + k * 0.9, rr = meanRadius(s);
      out.push({ pos: V(Math.cos(a) * rr, Math.sin(a) * rr * 0.6, Math.sin(a) * rr * 0.3), text: `${subName(s)}`, sub: `${s.e} electron${s.e > 1 ? 's' : ''}`, prio: 6 - k * 0.2, ref: { kind: 'thing', ex: 'morb', id: k, name: `${subName(s)} electrons` } });
    });
    return out;
  }

  locate(_ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind !== 'thing') return null;
    if (r.ex === 'mnuc') return r.id === 0 ? V(0, 0, 0) : this.nucleons[r.id - 1]?.p.clone() ?? null;
    if (r.ex === 'morb' || r.ex === 'matom' || r.ex === 'matm') return V(0, 0, 0);
    return null;
  }

  diveDist(): number { return 0; }
  size(_ctx: Ctx, r: Ref): number { return r.kind === 'thing' && r.ex === 'mnuc' && r.id === 0 ? this.Rn : 0; }
}
