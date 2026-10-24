// One cell of a tissue, in micrometres (1 unit = 1 µm), cut open: membrane,
// nucleus, mitochondria, reticulum and the rest at their real sizes, with its
// neighbours around it. For an uploaded mind, a tile of the substrate.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cellCard, flowCard, nbrCard, orgCard } from '../explain/micro.ts';
import { addGpuSet } from '../explain/picker.ts';
import { registerExplainer } from '../explain/registry.ts';
import type { CellPlan, CellShape, Organelle } from '../micro/cells.ts';
import { pidHash, type Specimen } from '../micro/specimen.ts';
import { pointsMaterial } from './textures.ts';
import type { Micro } from './micro.ts';
import { addLights, along, rimMaterial, rng, solid, type Grab } from './microKit.ts';
import type { Ctx, Label, Level, Pickable, Ref, View } from './views.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const RBC_R = 3.91;
/** Evans and Fung (1972): thickness of a red cell at radius r, µm. */
function rbcThick(r: number): number { const x = Math.min(1, r / RBC_R); return RBC_R * Math.sqrt(Math.max(0, 1 - x * x)) * (0.207 + 2.003 * x * x - 1.123 * x ** 4); }
function rbcGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= 24; k++) { const r = (k / 24) * RBC_R * 0.999; pts.push(new THREE.Vector2(r, rbcThick(r) / 2)); }
  for (let k = 24; k >= 0; k--) { const r = (k / 24) * RBC_R * 0.999; pts.push(new THREE.Vector2(r, -rbcThick(r) / 2)); }
  return new THREE.LatheGeometry(pts, 40);
}

interface Shape { geo: THREE.BufferGeometry; inside: (p: THREE.Vector3) => boolean; frame: number; nucleus: THREE.Vector3; nr: [number, number, number]; nbrGeo: THREE.BufferGeometry; nbr: THREE.Matrix4[] }

export class CellView implements View {
  level: Level = 'cell';
  group = new THREE.Group();
  limits: [number, number] = [0.05, 400];
  private key = '';
  private plan: CellPlan | null = null;
  private sp: Specimen | null = null;
  private grabs: Grab[] = [];
  private nbrs: THREE.Vector3[] = [];
  private frameR = 20;
  private spin: THREE.Object3D[] = [];
  private bots: { mesh: THREE.InstancedMesh; base: THREE.Vector3[] } | null = null;

  constructor(private m: Micro) {
    const card = (i: number) => (this.sp && this.plan ? orgCard(this.sp, this.plan, i) : { eyebrow: 'Cell', title: 'Cell', lede: 'Finding them…', facts: [{ k: 'Status', v: 'loading', t: 'P' as const }] });
    const at = (i: number, out: THREE.Vector3) => { const g = this.grabs.find((x) => x.id === i); return g ? out.copy(g.centre) : null; };
    registerExplainer('morg', { obj: this.group, explain: card, locate: at });
    registerExplainer('mcell', { obj: this.group, explain: () => (this.sp && this.plan ? cellCard(this.sp, this.plan) : card(0)), locate: (_i, out) => out.set(0, 0, 0) });
    registerExplainer('mnbr', {
      obj: this.group,
      explain: (i) => (this.sp && this.plan ? (this.plan.type.id === 'respirocyte' ? flowCard(this.sp, false, i) : nbrCard(this.sp, this.plan, i)) : card(0)),
      locate: (i, out) => (this.nbrs[i] ? out.copy(this.nbrs[i]) : null),
    });
  }

  enter(ctx: Ctx): void {
    this.sync(ctx);
    const D = this.frameR;
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(D * 1.1, D * 0.9, D * 2.2);
    this.limits = [D * 0.01, D * 12];
  }

  sync(ctx: Ctx): void {
    this.m.ensure(ctx);
    const plan = this.m.plan(ctx), sp = this.m.specimen(ctx);
    this.plan = plan; this.sp = sp;
    if (!plan || !sp) return;
    if (plan.key === this.key) return;
    this.key = plan.key;
    this.build(plan, sp);
  }

  // ---------------------------------------------------------------- shapes

  private shape(s: CellShape): Shape {
    const id = new THREE.Matrix4();
    const grid = (sp: number, y = 0, skip = true): THREE.Matrix4[] => {
      const out: THREE.Matrix4[] = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (!(skip && i === 0 && j === 0)) out.push(new THREE.Matrix4().makeTranslation(i * sp + (j % 2) * sp * 0.15, y, j * sp));
      return out;
    };
    const r = rng(0.37);
    const scatter = (n: number, R0: number, R1: number, s0 = 1): THREE.Matrix4[] => Array.from({ length: n }, () => {
      const d = V(r() - 0.5, (r() - 0.5) * 0.8, r() - 0.5).normalize().multiplyScalar(R0 + r() * (R1 - R0));
      return new THREE.Matrix4().compose(d, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 6, r() * 6, r() * 6)), V(s0, s0, s0));
    });
    void id;
    switch (s) {
      case 'disc': { const g = rbcGeometry(); return { geo: g, inside: (p) => Math.hypot(p.x, p.z) < RBC_R * 0.95 && Math.abs(p.y) < rbcThick(Math.hypot(p.x, p.z)) * 0.42, frame: 6, nucleus: V(0, 0, 0), nr: [0, 0, 0], nbrGeo: g, nbr: scatter(14, 9, 16) }; }
      case 'nanobot': return { geo: new THREE.SphereGeometry(0.5, 32, 20), inside: (p) => p.length() < 0.45, frame: 2.2, nucleus: V(0, 0, 0), nr: [0, 0, 0], nbrGeo: rbcGeometry(), nbr: scatter(10, 6, 11) };
      case 'rod': { const g = new THREE.CapsuleGeometry(0.45, 1.3, 6, 16).rotateZ(Math.PI / 2); return { geo: g, inside: (p) => Math.hypot(p.y, p.z) < 0.38 && Math.abs(p.x) < 1.0, frame: 3.2, nucleus: V(0, 0, 0), nr: [0.5, 0.25, 0.25], nbrGeo: g, nbr: scatter(14, 2.5, 6) }; }
      case 'fibre': {
        const big = this.plan!.type.id === 'myofibre', rf = big ? 22 : 9, L = big ? 110 : 90;
        const g = new THREE.CylinderGeometry(rf, rf, L, 40, 1).rotateZ(Math.PI / 2);
        const nbr = [[0, 2.15], [1.9, 1.1], [1.9, -1.1], [0, -2.15], [-1.9, -1.1], [-1.9, 1.1]].map(([y, z]) => new THREE.Matrix4().makeTranslation((r() - 0.5) * 20, y * rf, z * rf));
        return { geo: g, inside: (p) => Math.hypot(p.y, p.z) < rf * 0.92 && Math.abs(p.x) < L / 2 - 1, frame: rf * 3.2, nucleus: V(0, 0, 0), nr: big ? [rf * 0.5, rf * 0.14, rf * 0.14] : [rf * 0.6, rf * 0.3, rf * 0.3], nbrGeo: g, nbr };
      }
      case 'neuron': {
        const soma = 9, parts: THREE.BufferGeometry[] = [new THREE.SphereGeometry(soma, 32, 24)];
        for (let k = 0; k < 7; k++) {
          const dir = V(r() * 0.8 + 0.2, r() - 0.5, r() - 0.5).normalize();
          const pts = [dir.clone().multiplyScalar(soma * 0.8)];
          for (let q = 1; q < 6; q++) pts.push(pts[q - 1].clone().add(dir.clone().multiplyScalar(7 + r() * 4)).add(V((r() - 0.5) * 5, (r() - 0.5) * 5, (r() - 0.5) * 5)));
          parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 1.6 - k * 0.08, 8, false));
        }
        parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(-soma * 0.9, 0, 0), V(-20, 1, 2), V(-38, -1, 4), V(-55, 2, 3)]), 40, 0.9, 8, false));
        const g = mergeGeometries(parts)!;
        const nbr = [V(40, 12, -30), V(-25, -18, -40), V(30, -20, 35), V(-10, 25, 45)].map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
        return { geo: g, inside: (p) => p.length() < soma * 0.9, frame: 38, nucleus: V(0.5, 0.5, 0), nr: [3.6, 3.6, 3.6], nbrGeo: new THREE.SphereGeometry(soma, 24, 16), nbr };
      }
      case 'flat': {
        const R = this.plan!.type.id === 'pneumo' ? 22 : 14, h = this.plan!.type.id === 'pneumo' ? 0.1 : 0.32;
        const g = new THREE.SphereGeometry(R, 48, 24).scale(1, h, 1);
        return { geo: g, inside: (p) => (p.x * p.x + p.z * p.z) / (R * R) + (p.y * p.y) / (R * h * R * h) < 0.8, frame: R * 1.7, nucleus: V(0, 0, 0), nr: [R * 0.24, Math.max(1.4, R * h * 0.75), R * 0.2], nbrGeo: g, nbr: grid(R * 2.05) };
      }
      case 'osteo': {
        const g = new THREE.SphereGeometry(1, 32, 20).scale(7.5, 3, 4.5);
        const nbr = [-2, -1, 1, 2].map((k) => { const a = k * 0.55; return new THREE.Matrix4().compose(V(-16 + Math.cos(a) * 16, Math.sin(a) * 16, (r() - 0.5) * 20), new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), a), V(1, 1, 1)); });
        return { geo: g, inside: (p) => (p.x / 7) ** 2 + (p.y / 2.7) ** 2 + (p.z / 4.2) ** 2 < 1, frame: 40, nucleus: V(0.4, 0, 0), nr: [3, 1.8, 2.4], nbrGeo: g, nbr };
      }
      case 'tile': {
        const g = new THREE.BoxGeometry(2, 0.12, 2).translate(0, -0.06, 0);
        return { geo: g, inside: (p) => Math.abs(p.x) < 0.95 && Math.abs(p.z) < 0.95 && p.y > 0 && p.y < 0.4, frame: 2.8, nucleus: V(0, 0, 0), nr: [0, 0, 0], nbrGeo: g, nbr: grid(2.06) };
      }
      case 'poly': {
        const R = 12.5, g = new THREE.DodecahedronGeometry(R, 0);
        return { geo: g, inside: (p) => p.length() < R * 0.72, frame: R * 2.4, nucleus: V(1, 0.5, 0), nr: [R * 0.3, R * 0.3, R * 0.3], nbrGeo: g, nbr: grid(R * 2.0).concat(grid(R * 2.0, -R * 1.9, false).slice(0, 3)) };
      }
      default: { // round / cuboid
        const R = this.plan!.type.id === 'tubule' ? 7.5 : 9;
        const g = new THREE.SphereGeometry(R, 40, 28).scale(1, 0.82, 1);
        return { geo: g, inside: (p) => (p.x * p.x + p.z * p.z) / (R * R) + (p.y * p.y) / (0.82 * R) ** 2 < 0.72, frame: R * 2.6, nucleus: V(0, -R * 0.15, 0), nr: [R * 0.34, R * 0.3, R * 0.34], nbrGeo: g, nbr: grid(R * 2.05) };
      }
    }
  }

  // ---------------------------------------------------------------- build

  private build(plan: CellPlan, sp: Specimen): void {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.group.clear();
    this.grabs = []; this.nbrs = []; this.spin = []; this.bots = null;
    const S = this.shape(plan.type.shape);
    this.frameR = S.frame;
    addLights(this.group, S.frame);
    const r = rng(pidHash(sp.pid, 11) + plan.organelles.length * 0.01);
    const sub = sp.form === 'substrate';
    const sample = (avoidNucleus = true, tries = 60): THREE.Vector3 => {
      const b = S.frame;
      for (let k = 0; k < tries; k++) {
        const p = V((r() - 0.5) * b, (r() - 0.5) * b, (r() - 0.5) * b);
        if (!S.inside(p)) continue;
        if (avoidNucleus && S.nr[0] > 0) { const q = p.clone().sub(S.nucleus); if ((q.x / (S.nr[0] * 1.15)) ** 2 + (q.y / (S.nr[1] * 1.15)) ** 2 + (q.z / (S.nr[2] * 1.15)) ** 2 < 1) continue; }
        return p;
      }
      return S.nucleus.clone().add(V(S.nr[0] * 1.3, 0, 0));
    };
    // shared point cloud for everything too small or too many to draw as solids
    const P: number[] = [], C: number[] = [], Z: number[] = [], O: number[] = [];
    const dot = (p: THREE.Vector3, c: [number, number, number], size: number, org: number) => { P.push(p.x, p.y, p.z); C.push(...c); Z.push(size); O.push(org); };
    const grab = (id: number, at: THREE.Vector3[], rr: number, centre?: THREE.Vector3, weight = 0) => this.grabs.push({ id, at, r: rr, centre: centre ?? at[0], name: plan.organelles[id].name, weight });
    const unit = S.frame / 25; // a visible thickness for things finer than the cell

    plan.organelles.forEach((o: Organelle, i) => {
      switch (o.shape) {
        case 'membrane': {
          const mesh = new THREE.Mesh(S.geo, rimMaterial(sub ? 0x9fb4c8 : 0x8fc8ff, 0.1, 0.32, THREE.DoubleSide));
          mesh.renderOrder = 4;
          this.group.add(mesh);
          const pa = S.geo.attributes.position as THREE.BufferAttribute, at: THREE.Vector3[] = [];
          for (let k = 0; k < 14; k++) at.push(V(0, 0, 0).fromBufferAttribute(pa, Math.floor(r() * pa.count)));
          grab(i, at, unit * 1.2, at.reduce((a, b) => (b.y > a.y ? b : a), at[0]), -2);
          break;
        }
        case 'nucleus': {
          const fibre = plan.type.shape === 'fibre';
          const n = fibre ? (plan.type.id === 'myofibre' ? 7 : 2) : plan.type.id === 'hepato' && pidHash(sp.pid, 12) < 0.3 ? 2 : 1;
          const at: THREE.Vector3[] = [];
          for (let k = 0; k < n; k++) {
            const c = fibre ? (plan.type.id === 'myofibre' ? V(-40 + k * 13, Math.cos(k * 2.4) * S.nr[1] * 5.6, Math.sin(k * 2.4) * S.nr[1] * 5.6) : V((k - 0.5) * 22, 0, 0)) : n === 2 ? S.nucleus.clone().add(V((k - 0.5) * S.nr[0] * 2.3, 0, 0)) : S.nucleus.clone();
            const sc = n === 2 && !fibre ? 0.8 : 1;
            const env = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 22).scale(S.nr[0] * sc, S.nr[1] * sc, S.nr[2] * sc), rimMaterial(0x9a86e0, 0.28, 0.35));
            env.position.copy(c);
            this.group.add(env);
            const nuc = new THREE.Mesh(new THREE.SphereGeometry(Math.min(...S.nr) * 0.32, 16, 12), solid(0x5a3f8a, 0.2));
            nuc.position.copy(c).add(V(S.nr[0] * 0.25, S.nr[1] * 0.1, 0));
            this.group.add(nuc);
            for (let q = 0; q < 260; q++) {
              const d = V(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(Math.cbrt(r()) * 0.85);
              dot(c.clone().add(V(d.x * S.nr[0] * sc, d.y * S.nr[1] * sc, d.z * S.nr[2] * sc)), [0.42, 0.3, 0.62], 0.9, i);
            }
            at.push(c);
          }
          grab(i, at, Math.max(...S.nr) * 0.9, at[0], 3);
          break;
        }
        case 'nucleoid': {
          const pts: THREE.Vector3[] = [];
          let p = V(0, 0, 0);
          for (let k = 0; k < 40; k++) { p = p.clone().add(V((r() - 0.5) * 0.35, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3)); p.x = THREE.MathUtils.clamp(p.x, -0.7, 0.7); p.y = THREE.MathUtils.clamp(p.y, -0.25, 0.25); p.z = THREE.MathUtils.clamp(p.z, -0.25, 0.25); pts.push(p); }
          const c = new THREE.CatmullRomCurve3(pts);
          this.group.add(new THREE.Mesh(new THREE.TubeGeometry(c, 300, 0.02, 5), solid(0xa98ae8, 0.25)));
          grab(i, along(c, 0.2), 0.12, V(0, 0, 0), 2);
          break;
        }
        case 'mito': {
          const n = Math.min(o.count, plan.type.id === 'cardio' ? 60 : 40);
          const outer = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.32, 1.2, 4, 12), rimMaterial(0xe0784a, 0.35, 0.3), n);
          const cr: THREE.BufferGeometry[] = [];
          for (let q = 0; q < 6; q++) cr.push(new THREE.CylinderGeometry(0.24, 0.24, 0.035, 12).translate(0, -0.65 + q * 0.26, 0));
          const inner = new THREE.InstancedMesh(mergeGeometries(cr)!, solid(0xf0a060, 0.18), n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4();
          for (let k = 0; k < n; k++) {
            const p = sample();
            const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(r() - 0.5, r() - 0.5, r() - 0.5).normalize());
            const sc = plan.type.shape === 'fibre' && plan.type.id === 'myofibre' ? 1.3 : 1;
            m.compose(p, q, V(sc, sc, sc));
            outer.setMatrixAt(k, m); inner.setMatrixAt(k, m);
            at.push(p);
          }
          this.group.add(outer, inner);
          grab(i, at, 0.9, at[0], 1);
          break;
        }
        case 'er': {
          const at: THREE.Vector3[] = [], tubes: THREE.BufferGeometry[] = [];
          const nc = S.nucleus, R0 = Math.max(S.nr[0], 1);
          for (let k = 0; k < 6; k++) {
            const pts: THREE.Vector3[] = [];
            const a0 = r() * 6.28, tilt = (r() - 0.5) * 1.6;
            for (let q = 0; q < 9; q++) {
              const a = a0 + q * 0.55, rr = R0 * (1.35 + 0.35 * Math.sin(q * 1.7 + k));
              const p = nc.clone().add(V(Math.cos(a) * rr, Math.sin(a) * rr * Math.sin(tilt) * 0.6 + (r() - 0.5) * R0 * 0.3, Math.sin(a) * rr * Math.cos(tilt)));
              if (S.inside(p)) pts.push(p);
            }
            if (pts.length < 3) continue;
            const c = new THREE.CatmullRomCurve3(pts);
            tubes.push(new THREE.TubeGeometry(c, 64, Math.max(0.08, unit * 0.18), 6));
            at.push(...along(c, R0 * 0.6));
            for (const p of along(c, R0 * 0.08)) dot(p.clone().add(V((r() - 0.5) * unit * 0.4, (r() - 0.5) * unit * 0.4, (r() - 0.5) * unit * 0.4)), [0.55, 0.5, 0.75], 0.7, plan.organelles.findIndex((x) => x.shape === 'ribosomes') >= 0 ? plan.organelles.findIndex((x) => x.shape === 'ribosomes') : i);
          }
          if (tubes.length) this.group.add(new THREE.Mesh(mergeGeometries(tubes)!, solid(0x8fc070, 0.15, { transparent: true, opacity: 0.8 })));
          if (at.length) grab(i, at, unit * 0.9, at[0]);
          break;
        }
        case 'golgi': {
          const c = S.nucleus.clone().add(V(-S.nr[0] * 1.55, S.nr[1] * 0.4, S.nr[2] * 0.5));
          if (!S.inside(c)) c.copy(sample());
          const g = new THREE.Group();
          for (let k = 0; k < 5; k++) {
            const cap = new THREE.Mesh(new THREE.SphereGeometry(1.6 - k * 0.12, 28, 6, 0, Math.PI * 2, 0, 0.55), solid(0xe0b860, 0.16, { side: THREE.DoubleSide }));
            cap.position.y = -k * 0.22; cap.scale.set(1, 0.6, 1);
            g.add(cap);
          }
          g.position.copy(c); g.lookAt(S.nucleus); g.rotateX(Math.PI / 2);
          const sc = Math.max(0.6, unit * 0.9); g.scale.setScalar(sc);
          this.group.add(g);
          grab(i, [c], 1.6 * sc, c);
          break;
        }
        case 'ribosomes': {
          for (let k = 0; k < 1400; k++) dot(sample(), [0.5, 0.45, 0.7], 0.6, i);
          break;
        }
        case 'cytoskeleton': {
          const pos: number[] = [], at: THREE.Vector3[] = [];
          const centre = plan.type.shape === 'disc' ? null : S.nucleus.clone().add(V(S.nr[0] * 1.2, S.nr[1] * 0.6, 0));
          for (let k = 0; k < 70; k++) {
            if (centre) {
              const d = V(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), p = centre.clone();
              let L = 0;
              while (L < S.frame && S.inside(p.clone().addScaledVector(d, unit * 0.5))) { p.addScaledVector(d, unit * 0.5); L += unit * 0.5; }
              pos.push(centre.x, centre.y, centre.z, p.x, p.y, p.z);
              if (k % 7 === 0) at.push(centre.clone().lerp(p, 0.6));
            } else {
              // red cells: a spectrin mesh just under the membrane
              const a = r() * 6.28, rr = r() * RBC_R * 0.9, a2 = a + (r() - 0.5) * 0.8, r2 = Math.min(RBC_R * 0.9, rr + (r() - 0.5));
              for (const s of [1, -1]) { pos.push(Math.cos(a) * rr, s * rbcThick(rr) * 0.47, Math.sin(a) * rr, Math.cos(a2) * r2, s * rbcThick(r2) * 0.47, Math.sin(a2) * r2); }
              if (k % 7 === 0) at.push(V(Math.cos(a) * rr, rbcThick(rr) * 0.47, Math.sin(a) * rr));
            }
          }
          this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: 0x9ab8d8, transparent: true, opacity: 0.32 })));
          grab(i, at, unit * 0.8, at[0], -1);
          break;
        }
        case 'vesicles': {
          const n = Math.min(80, o.count), mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 10, 8), rimMaterial(0xffd08a, 0.5, 0.4), n);
          const end = V(-55, 2, 3), at: THREE.Vector3[] = [], m = new THREE.Matrix4();
          for (let k = 0; k < n; k++) { const p = end.clone().add(V(r() * 3 - 1.5, (r() - 0.5) * 3, (r() - 0.5) * 3)); mesh.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)); if (k % 8 === 0) at.push(p); }
          const bouton = new THREE.Mesh(new THREE.SphereGeometry(2.6, 20, 14), rimMaterial(0x8fc8ff, 0.1, 0.3));
          bouton.position.copy(end);
          this.group.add(mesh, bouton);
          grab(i, at, 1.2, end, 2);
          break;
        }
        case 'myelin': {
          const segs: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          const c = new THREE.CatmullRomCurve3([V(-12, 0.5, 1), V(-20, 1, 2), V(-38, -1, 4), V(-52, 2, 3)]);
          for (let k = 0; k < 5; k++) {
            const t0 = k / 5 + 0.01, t1 = (k + 1) / 5 - 0.03; // the gaps are the nodes of Ranvier
            const p0 = c.getPointAt(t0), p1 = c.getPointAt(t1);
            const g = new THREE.CylinderGeometry(1.9, 1.9, p0.distanceTo(p1), 20, 1, true);
            g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), p1.clone().sub(p0).normalize()));
            const mid = p0.clone().lerp(p1, 0.5);
            g.translate(mid.x, mid.y, mid.z);
            segs.push(g); at.push(mid);
          }
          this.group.add(new THREE.Mesh(mergeGeometries(segs)!, rimMaterial(0xf2ead8, 0.3, 0.35, THREE.DoubleSide)));
          grab(i, at, 2.2, at[1]);
          break;
        }
        case 'myofibrils': {
          const big = plan.type.id === 'myofibre', rf = big ? 22 : 9, L = big ? 110 : 90;
          const ring: [number, number][] = [[0, 0]];
          for (let q = 0; q < 6; q++) ring.push([Math.cos(q * 1.047) * 0.42, Math.sin(q * 1.047) * 0.42]);
          for (let q = 0; q < 10; q++) ring.push([Math.cos(q * 0.628 + 0.3) * 0.75, Math.sin(q * 0.628 + 0.3) * 0.75]);
          const fr = rf * 0.12, per = Math.floor(L / 2.5);
          const A = new THREE.InstancedMesh(new THREE.CylinderGeometry(fr, fr, 1.6, 10).rotateZ(Math.PI / 2), solid(0x9a3036, 0.16), ring.length * per);
          const I = new THREE.InstancedMesh(new THREE.CylinderGeometry(fr * 0.9, fr * 0.9, 0.9, 10).rotateZ(Math.PI / 2), solid(0xe7b2a8, 0.12), ring.length * per);
          const m = new THREE.Matrix4(), at: THREE.Vector3[] = [];
          let k = 0;
          for (const [y, z] of ring) for (let q = 0; q < per; q++) {
            const x = -L / 2 + 1.25 + q * 2.5;
            A.setMatrixAt(k, m.makeTranslation(x, y * rf, z * rf)); I.setMatrixAt(k, m.makeTranslation(x + 1.25, y * rf, z * rf)); k++;
            if (q % 9 === 0) at.push(V(x, y * rf, z * rf));
          }
          this.group.add(A, I);
          grab(i, at, fr * 2, V(0, 0, 0), 1);
          break;
        }
        case 'hemoglobin': {
          for (let k = 0; k < 2600; k++) { const p = sample(false); dot(p, [0.62, 0.1, 0.09], 0.8, i); }
          break;
        }
        case 'matrix': {
          const lam: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          for (let k = 1; k <= 7; k++) { const rr = k * 4; lam.push(new THREE.CylinderGeometry(rr, rr, 60, 64, 1, true).rotateX(Math.PI / 2).translate(-16, 0, 0)); at.push(V(-16 + rr * 0.7, rr * 0.7, 6)); }
          this.group.add(new THREE.Mesh(mergeGeometries(lam)!, rimMaterial(sp.bone < 0.9 ? 0xb8b0a0 : 0xe8dcc0, 0.05 + 0.05 * sp.bone, 0.18, THREE.DoubleSide)));
          const canal = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 60, 20).rotateX(Math.PI / 2).translate(-16, 0, 0), solid(0x8a2028, 0.2, { transparent: true, opacity: 0.7 }));
          this.group.add(canal);
          grab(i, at, 2.5, at[3]);
          break;
        }
        case 'collagen': {
          const pos: number[] = [], at: THREE.Vector3[] = [];
          for (let k = 1; k <= 7; k++) {
            const rr = k * 4 + 0.15, pitch = (k % 2 ? 1 : -1) * 0.18; // alternate lamellae twist opposite ways: "plywood" bone
            for (let q = 0; q < 10; q++) {
              const a0 = q * 0.628;
              let prev: THREE.Vector3 | null = null;
              for (let s = 0; s <= 30; s++) {
                const z = -30 + s * 2, a = a0 + z * pitch;
                const p = V(-16 + Math.cos(a) * rr, Math.sin(a) * rr, z);
                if (prev) pos.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
                prev = p;
              }
            }
            at.push(V(-16 + rr * 0.7, -rr * 0.7, -4));
          }
          this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: 0xf0e6c8, transparent: true, opacity: 0.09 })));
          grab(i, at, 2.2, at[3], -1);
          break;
        }
        case 'processes': {
          const tubes: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 34; k++) {
            const d = V(r() - 0.5, (r() - 0.5) * 1.4, r() - 0.5).normalize(), L = 8 + r() * 10;
            const p0 = V(d.x * 7, d.y * 2.8, d.z * 4.2), p1 = p0.clone().addScaledVector(d, L), mid = p0.clone().lerp(p1, 0.5).add(V((r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2));
            const c = new THREE.QuadraticBezierCurve3(p0, mid, p1);
            tubes.push(new THREE.TubeGeometry(c, 12, 0.12, 5));
            if (k % 3 === 0) at.push(c.getPoint(0.6));
          }
          this.group.add(new THREE.Mesh(mergeGeometries(tubes)!, solid(0x9cb8d0, 0.1, { transparent: true, opacity: 0.4 })));
          grab(i, at, 1.2, at[0]);
          break;
        }
        case 'flagellum': {
          const pts: THREE.Vector3[] = [];
          for (let k = 0; k <= 80; k++) { const t = k / 80, x = 1.05 + t * 7; pts.push(V(x, Math.cos(t * 7 / 2.3 * 6.283) * 0.22, Math.sin(t * 7 / 2.3 * 6.283) * 0.22)); }
          const c = new THREE.CatmullRomCurve3(pts);
          const f = new THREE.Mesh(new THREE.TubeGeometry(c, 240, 0.025, 6), solid(0xd8d0a0, 0.2));
          this.group.add(f); this.spin.push(f);
          grab(i, along(c, 0.7), 0.25, c.getPointAt(0.4));
          break;
        }
        case 'keratin': {
          const pos: number[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 120; k++) { const a = sample(false), b = sample(false); pos.push(a.x, a.y, a.z, b.x, b.y, b.z); if (k % 12 === 0) at.push(a.clone().lerp(b, 0.5)); }
          this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: 0xe0d090, transparent: true, opacity: 0.35 })));
          grab(i, at, unit, at[0], -1);
          break;
        }
        case 'melanosomes': {
          const n = Math.min(o.count, 40), mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 10, 8).scale(1, 0.6, 0.6), solid(0x3a2418, 0.12), n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4();
          for (let k = 0; k < n; k++) {
            // the supranuclear cap: melanin parked over the nucleus like a parasol
            const a = r() * 6.28, rr = Math.sqrt(r()) * S.nr[0] * 0.9;
            const p = S.nucleus.clone().add(V(Math.cos(a) * rr, S.nr[1] * 1.15, Math.sin(a) * rr));
            mesh.setMatrixAt(k, m.makeRotationY(r() * 6).setPosition(p)); at.push(p);
          }
          this.group.add(mesh);
          grab(i, at, 0.8, at[0], 2);
          break;
        }
        case 'glycogen': {
          for (let k = 0; k < 50; k++) { const c = sample(); for (let q = 0; q < 9; q++) dot(c.clone().add(V((r() - 0.5) * 0.5, (r() - 0.5) * 0.5, (r() - 0.5) * 0.5)), [0.85, 0.78, 0.42], 0.7, i); }
          break;
        }
        case 'gas': {
          for (let k = 0; k < 700; k++) dot(V((r() - 0.5) * S.frame * 1.6, 2 + r() * S.frame * 0.5, (r() - 0.5) * S.frame * 1.6), [0.55, 0.75, 1.0], 0.7, i);
          break;
        }
        case 'lamellar': {
          const n = Math.min(o.count, 8), mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 16, 12), rimMaterial(0xf0e0b0, 0.35, 0.4), n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4();
          for (let k = 0; k < n; k++) { const p = sample(); mesh.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)); at.push(p); }
          this.group.add(mesh);
          grab(i, at, 1, at[0], 1);
          break;
        }
        case 'microvilli': {
          const R = 7.5, n = 22, mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.12, 1.8, 6).translate(0, 0.9, 0), solid(0xa8d0e8, 0.15), n * n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4();
          let k = 0;
          for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const x = (a / (n - 1) - 0.5) * R * 1.4, z = (b / (n - 1) - 0.5) * R * 1.4;
            const top = 0.82 * R * Math.sqrt(Math.max(0, 1 - (x * x + z * z) / (R * R)));
            if (top < R * 0.3) continue;
            mesh.setMatrixAt(k++, m.makeTranslation(x, top - 0.2, z));
            if ((a + b) % 11 === 0) at.push(V(x, top + 0.9, z));
          }
          mesh.count = k;
          this.group.add(mesh);
          grab(i, at, 1, V(0, 0.82 * R + 1, 0), 1);
          break;
        }
        case 'electrode': {
          const c = new THREE.LineCurve3(V(-60, 6, 14), V(60, 4, 14));
          this.group.add(new THREE.Mesh(new THREE.TubeGeometry(c, 8, 2.5, 12), solid(0xb8c4d0, 0.12, { metalness: 0.6, roughness: 0.3 })));
          const pads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1.6, 0.6), solid(0xd8b060, 0.2, { metalness: 0.8 }), 12);
          const m = new THREE.Matrix4();
          for (let k = 0; k < 12; k++) pads.setMatrixAt(k, m.makeTranslation(-55 + k * 10, 6 - k * 0.17, 11.5));
          this.group.add(pads);
          grab(i, along(c, 10), 3, V(0, 5, 14), 2);
          break;
        }
        case 'nanobots': {
          const n = Math.max(3, Math.min(o.count, 8)), sc = Math.max(0.25, unit * 0.35);
          const mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(sc, 0), solid(0x7fe3ff, 0.35, { metalness: 0.5, roughness: 0.25 }), n);
          const base = Array.from({ length: n }, () => sample());
          this.group.add(mesh);
          this.bots = { mesh, base };
          grab(i, base, sc * 3, base[0], 4);
          break;
        }
        case 'cytosol': {
          for (let k = 0; k < 900; k++) dot(sample(false), [0.22, 0.32, 0.42], 0.55, i);
          break;
        }
        case 'shell': {
          this.group.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 28), rimMaterial(0xa8c0d8, 0.18, 0.4)));
          this.group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.505, 2)), new THREE.LineBasicMaterial({ color: 0xc8d8e8, transparent: true, opacity: 0.25 })));
          const at = Array.from({ length: 10 }, (_, k) => { const a = k * 2.4, y = (k / 9) * 2 - 1; return V(Math.cos(a) * Math.sqrt(1 - y * y) * 0.5, y * 0.5, Math.sin(a) * Math.sqrt(1 - y * y) * 0.5); });
          grab(i, at, 0.1, at[5], -1);
          break;
        }
        case 'rotors': {
          const n = 160, mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8).translate(0, 0.515, 0), solid(0x7fe3ff, 0.3), n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4(), up = V(0, 1, 0);
          for (let k = 0; k < n; k++) { const y = 1 - (2 * (k + 0.5)) / n, rr = Math.sqrt(1 - y * y), a = k * 2.39996; const d = V(Math.cos(a) * rr, y, Math.sin(a) * rr); mesh.setMatrixAt(k, m.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d))); if (k % 16 === 0) at.push(d.multiplyScalar(0.53)); }
          this.group.add(mesh);
          grab(i, at, 0.06, at[3], 1);
          break;
        }
        case 'tank': {
          for (let k = 0; k < 900; k++) dot(V(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(Math.cbrt(r()) * 0.44), [0.45, 0.7, 1.0], 0.6, i);
          break;
        }
        case 'gates': {
          const n = 14, mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.06, 0.07), solid(0xc8a888, 0.1, { metalness: 0.3 }), n * n);
          const at: THREE.Vector3[] = [], m = new THREE.Matrix4(), c = new THREE.Color();
          let k = 0;
          for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const p = V((a / (n - 1) - 0.5) * 1.7, 0.03, (b / (n - 1) - 0.5) * 1.7);
            mesh.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z));
            mesh.setColorAt(k, c.set(r() < 0.3 ? 0x7fe3ff : 0xc8a888));
            k++;
            if ((a * 7 + b) % 17 === 0) at.push(p);
          }
          this.group.add(mesh);
          grab(i, at, 0.08, V(0, 0.03, 0), 1);
          break;
        }
        case 'wires': {
          const pos: number[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 40; k++) { const z = (r() - 0.5) * 1.7, x0 = (r() - 0.5) * 1.7, x1 = (r() - 0.5) * 1.7; pos.push(x0, 0.09, z, x1, 0.09, z, x1, 0.09, z, x1, 0.09, z + (r() - 0.5) * 0.4); if (k % 5 === 0) at.push(V((x0 + x1) / 2, 0.09, z)); }
          this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), new THREE.LineBasicMaterial({ color: 0x9fb8ff, transparent: true, opacity: 0.6 })));
          grab(i, at, 0.06, at[0]);
          break;
        }
        case 'memcells': {
          for (let a = 0; a < 12; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 12; c++) dot(V((a / 11 - 0.5) * 1.7, 0.05 + b * 0.08, (c / 11 - 0.5) * 1.7), [0.85, 0.28, 0.24], 1, i);
          this.group.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.34, 1.8).translate(0, 0.17, 0), rimMaterial(0xdde8f0, 0.08, 0.3)));
          break;
        }
        case 'waveguide': {
          const g: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 6; k++) { const z = -0.75 + k * 0.3; g.push(new THREE.BoxGeometry(1.8, 0.022, 0.045).translate(0, 0.011, z)); at.push(V(0, 0.02, z)); }
          this.group.add(new THREE.Mesh(mergeGeometries(g)!, solid(0xd8b890, 0.3)));
          grab(i, at, 0.06, at[2]);
          break;
        }
        case 'channels': {
          const z = plan.type.id === 'coolant' ? 0 : 0.85;
          const c = new THREE.LineCurve3(V(-1, 0.12, z), V(1, 0.12, z));
          this.group.add(new THREE.Mesh(new THREE.TubeGeometry(c, 4, plan.type.id === 'coolant' ? 0.3 : 0.08, 16), rimMaterial(0x5aa0e0, 0.35, 0.35)));
          for (let k = 0; k < 300; k++) dot(V((r() - 0.5) * 2, 0.12 + (r() - 0.5) * 0.1, z + (r() - 0.5) * 0.1), [0.3, 0.55, 0.9], 0.6, i);
          grab(i, along(c, 0.3), 0.12, V(0, 0.12, z));
          break;
        }
        case 'busbars': {
          const g: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 4; k++) { const x = -0.6 + k * 0.4; g.push(new THREE.BoxGeometry(0.14, 0.1, 1.8).translate(x, 0.05, 0)); at.push(V(x, 0.1, 0)); }
          this.group.add(new THREE.Mesh(mergeGeometries(g)!, solid(0xc88033, 0.15, { metalness: 0.85, roughness: 0.3 })));
          grab(i, at, 0.1, at[1]);
          break;
        }
        case 'layers': {
          const g: THREE.BufferGeometry[] = [], at: THREE.Vector3[] = [];
          for (let k = 0; k < 5; k++) { g.push(new THREE.BoxGeometry(1.9, 0.05, 1.9).translate(0, 0.04 + k * 0.08, 0)); at.push(V(0.6, 0.06 + k * 0.08, 0.6)); }
          this.group.add(new THREE.Mesh(mergeGeometries(g)!, rimMaterial(0xe8e4dc, 0.18, 0.3)));
          grab(i, at, 0.1, at[2]);
          break;
        }
      }
    });
    // the base of a substrate tile
    if (plan.type.shape === 'tile') this.group.add(new THREE.Mesh(S.geo, solid(0x3a3f48, 0.05, { metalness: 0.4, roughness: 0.6 })));
    // neighbours of the same tissue
    if (S.nbr.length) {
      const nm = new THREE.InstancedMesh(S.nbrGeo, plan.type.id === 'respirocyte' ? solid(0x9a2228, 0.12, { transparent: true, opacity: 0.85 }) : rimMaterial(sub ? 0x6f8090 : plan.type.id === 'rbc' ? 0xc04040 : 0x6fa8d8, plan.type.id === 'rbc' ? 0.5 : 0.05, 0.22, THREE.DoubleSide), S.nbr.length);
      S.nbr.forEach((m, k) => { nm.setMatrixAt(k, m); this.nbrs.push(V(0, 0, 0).applyMatrix4(m)); });
      nm.renderOrder = 3;
      this.group.add(nm);
    }
    // the point cloud, pickable per organelle
    if (P.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      geo.setAttribute('size', new THREE.Float32BufferAttribute(Z, 1));
      const pts = new THREE.Points(geo, pointsMaterial({ sizeScale: unit * 0.35, minPx: 1, maxPx: 6 }));
      pts.frustumCulled = false;
      this.group.add(pts);
      const orgOf = Int16Array.from(O);
      // each organelle drawn as points gets a centre to fly to
      for (const id of new Set(O)) if (!this.grabs.some((g) => g.id === id)) {
        let k = O.indexOf(id), c = V(0, 0, 0), n = 0;
        for (; k < O.length; k++) if (O[k] === id) { c.add(V(P[k * 3], P[k * 3 + 1], P[k * 3 + 2])); n++; }
        this.grabs.push({ id, at: [], r: 0, centre: c.divideScalar(Math.max(1, n)), name: plan.organelles[id].name });
      }
      addGpuSet({ kind: 'mpts', points: pts, pickPx: 5 });
      registerExplainer('mpts', {
        obj: pts,
        explain: (i) => (this.sp && this.plan ? orgCard(this.sp, this.plan, i) : { eyebrow: '', title: '', lede: '', facts: [] }),
        idOf: (i) => orgOf[i] ?? -1,
        locate: (i, out) => { const g = this.grabs.find((x) => x.id === i); return g ? out.copy(g.centre) : null; },
      });
    }
  }

  frame(ctx: Ctx, dt: number): void {
    for (const s of this.spin) s.rotation.x += dt * 6; // a bacterial flagellum turns at up to hundreds of revolutions a second; shown slowed
    if (this.bots) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion();
      this.bots.base.forEach((b, k) => {
        const t = ctx.t * 0.4 + k * 1.7, s = this.frameR / 60;
        q.setFromEuler(new THREE.Euler(t, t * 1.3, 0));
        m.compose(b.clone().add(V(Math.sin(t) * s, Math.cos(t * 1.1) * s, Math.sin(t * 0.7) * s)), q, V(1, 1, 1));
        this.bots!.mesh.setMatrixAt(k, m);
      });
      this.bots.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  pickables(): Pickable[] {
    const out: Pickable[] = [];
    for (const g of this.grabs) for (const p of g.at) out.push({ pos: p, kind: 'thing', ex: 'morg', id: g.id, name: g.name, r: g.r, weight: g.weight });
    const nb = this.plan?.type.id === 'respirocyte' ? 'Red blood cell' : `Neighbouring ${this.plan?.type.name.toLowerCase() ?? 'cell'}`;
    this.nbrs.forEach((p, k) => out.push({ pos: p, kind: 'thing', ex: 'mnbr', id: k, name: nb, r: this.frameR * 0.15, weight: -3 }));
    return out;
  }

  labels(ctx: Ctx): Label[] {
    const plan = this.plan, sp = this.sp;
    if (!plan || !sp) return [];
    const out: Label[] = [{ pos: V(0, this.frameR * 0.55, 0), text: plan.type.name, sub: `${plan.type.tissue} · ${sp.name}${sp.form === 'substrate' ? ' (uploaded)' : ''}`, strong: true, prio: 12, ref: { kind: 'thing', ex: 'mcell', id: 0, name: plan.type.name } }];
    for (const g of this.grabs) if (g.at.length || g.r === 0) out.push({ pos: g.centre, text: g.name, ref: { kind: 'thing', ex: 'morg', id: g.id, name: g.name }, prio: 4 + (g.weight ?? 0) * 0.3 });
    void ctx;
    return out;
  }

  locate(_ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'thing' && (r.ex === 'morg' || r.ex === 'mpts')) return this.grabs.find((g) => g.id === r.id)?.centre.clone() ?? null;
    if (r.kind === 'thing' && r.ex === 'mnbr') return this.nbrs[r.id]?.clone() ?? null;
    if (r.kind === 'thing' && (r.ex === 'mpart' || r.ex === 'mcell')) return V(0, 0, 0);
    return null;
  }

  diveDist(_ctx: Ctx, r: Ref): number {
    return r.kind === 'thing' && (r.ex === 'morg' || r.ex === 'mpts') ? this.frameR * 0.35 : 0;
  }

  size(_ctx: Ctx, r: Ref): number {
    if (r.kind !== 'thing' || r.ex !== 'morg') return 0;
    const g = this.grabs.find((x) => x.id === r.id);
    return g ? Math.min(g.r, this.frameR * 0.3) : 0;
  }
}
