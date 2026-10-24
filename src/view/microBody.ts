// A person's body, life-size (1 unit = 1 m). Flesh is drawn see-through, with
// the skeleton, organs, vessels and moving blood inside; its build and bone
// density come from the world they grew up on. An uploaded person's "body"
// is the substrate their mind runs on, beside the self-model they picture.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flowCard, partCard, partName, partSize, personFacts } from '../explain/micro.ts';
import { addGpuSet } from '../explain/picker.ts';
import { pointWorld, registerExplainer } from '../explain/registry.ts';
import type { PartId, Specimen } from '../micro/specimen.ts';
import { pidHash } from '../micro/specimen.ts';
import { pointsMaterial } from './textures.ts';
import type { Micro } from './micro.ts';
import { addLights, along, capsule, rimMaterial, rng, solid, type Grab } from './microKit.ts';
import type { Ctx, Label, Level, Pickable, Ref, View } from './views.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Flow { curve: THREE.Curve<THREE.Vector3>; t: number; v: number }

export class PersonView implements View {
  level: Level = 'person';
  group = new THREE.Group();
  limits: [number, number] = [0.04, 12];
  private key = '';
  private grabs: Grab[] = [];
  private sp: Specimen | null = null;
  private heart: THREE.Object3D | null = null;
  private lungs: THREE.Object3D[] = [];
  private slabs: THREE.Mesh[] = [];
  private flows: { pts: THREE.Points; list: Flow[]; nano: boolean }[] = [];
  private H = 1.7;

  constructor(private m: Micro) {
    registerExplainer('mpart', {
      obj: this.group,
      explain: (i) => (this.sp ? partCard(this.sp, this.sp.parts[i]) : { eyebrow: 'Body', title: 'Someone', lede: 'Finding them…', facts: [{ k: 'Status', v: 'loading', t: 'P' }] }),
      name: (i) => (this.sp ? partName(this.sp.parts[i]) : 'Body'),
      locate: (i, out) => { const g = this.grabs.find((x) => x.id === i); return g ? out.copy(g.centre) : null; },
    });
  }

  enter(ctx: Ctx): void {
    this.sync(ctx);
    const H = this.H, sub = this.sp?.form === 'substrate';
    ctx.controls.target.set(sub ? 0.35 : 0, H * (sub ? 0.5 : 0.55), 0);
    ctx.camera.position.set(H * 0.9, H * 0.75, H * 1.75);
  }

  sync(ctx: Ctx): void {
    this.m.ensure(ctx);
    const sp = this.m.specimen(ctx);
    this.sp = sp;
    if (!sp) { if (this.key !== 'none') { this.clear(); this.key = 'none'; } return; }
    if (sp.key === this.key) return;
    this.key = sp.key;
    this.clear();
    this.H = Math.max(0.5, sp.heightM);
    addLights(this.group, this.H);
    if (sp.form === 'substrate') this.buildSubstrate(sp); else this.buildFlesh(sp);
  }

  private clear(): void {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.group.clear();
    this.grabs = []; this.heart = null; this.lungs = []; this.slabs = []; this.flows = [];
  }

  private grab(part: PartId, at: THREE.Vector3[], r: number, centre?: THREE.Vector3, weight = 0): void {
    const sp = this.sp!;
    const id = sp.parts.indexOf(part);
    if (id < 0) return;
    this.grabs.push({ id, at, r, centre: centre ?? at[0], name: partName(part), weight });
  }

  // ---------------------------------------------------------------- flesh

  private buildFlesh(sp: Specimen): void {
    const H = this.H, s = sp.slender, fat = 1 + 0.08 * (sp.fat - 1), kid = Math.max(0, 1 - sp.age / 16);
    const r = rng(pidHash(sp.pid, 3));
    const P = (x: number, y: number, z: number) => V(x * H, y * H, z * H);
    const headR = H * (0.062 + 0.045 * kid), headY = 1 - headR / H;
    const J = {
      head: P(0, headY, 0), neck0: P(0, 0.83, 0), neck1: P(0, headY - 0.05, 0), pelvis: P(0, 0.52, 0), chest: P(0, 0.71, 0),
      sh: [P(0.13 * s, 0.815, 0), P(-0.13 * s, 0.815, 0)], el: [P(0.16 * s, 0.63, -0.01), P(-0.16 * s, 0.63, -0.01)],
      wr: [P(0.17 * s, 0.475, 0.02), P(-0.17 * s, 0.475, 0.02)], hd: [P(0.172 * s, 0.425, 0.03), P(-0.172 * s, 0.425, 0.03)],
      hip: [P(0.055 * s, 0.505, 0), P(-0.055 * s, 0.505, 0)], kn: [P(0.06 * s, 0.285, 0.012), P(-0.06 * s, 0.285, 0.012)],
      an: [P(0.062 * s, 0.045, -0.005), P(-0.062 * s, 0.045, -0.005)], toe: [P(0.066 * s, 0.014, 0.1), P(-0.066 * s, 0.014, 0.1)],
    };
    // skin: one see-through shell of capsules
    const sk: THREE.BufferGeometry[] = [new THREE.SphereGeometry(headR, 24, 18).translate(J.head.x, J.head.y, J.head.z), capsule(J.neck0, J.neck1, H * 0.03 * fat)];
    const torso = new THREE.CapsuleGeometry(H * 0.1 * fat, H * 0.24, 6, 20).scale(1.18 * s, 1, 0.64 * s).translate(0, H * 0.665, 0);
    sk.push(torso);
    for (const k of [0, 1]) {
      sk.push(capsule(J.sh[k], J.el[k], H * 0.028 * s * fat), capsule(J.el[k], J.wr[k], H * 0.022 * s * fat), capsule(J.wr[k], J.hd[k], H * 0.017 * s));
      sk.push(capsule(J.hip[k], J.kn[k], H * 0.047 * s * fat), capsule(J.kn[k], J.an[k], H * 0.032 * s * fat), capsule(J.an[k], J.toe[k], H * 0.022));
    }
    const skin = new THREE.Mesh(mergeGeometries(sk)!, rimMaterial(sp.adapted ? 0x9fd8d0 : 0xc8d8ff, 0.07, 0.28));
    skin.renderOrder = 5;
    this.group.add(skin);
    this.grab('skin', [P(0, 0.66, 0.075 * s), P(0.12 * s, 0.6, 0), P(-0.12 * s, 0.6, 0), J.hd[0], J.hd[1], P(0, headY, headR / H)], H * 0.03, P(0, 0.66, 0.075 * s));

    // skeleton: denser bones are whiter and more solid
    const boneMat = solid(0xe8e0cc, 0.08, { transparent: true, opacity: Math.min(0.95, 0.35 + 0.55 * sp.bone), roughness: 0.7 });
    boneMat.color.lerp(new THREE.Color(0x8a8f99), Math.max(0, 1 - sp.bone) * 1.2);
    const bt = Math.sqrt(sp.bone) * (sp.slender > 1.05 ? 1.15 : 1);
    const bones: THREE.BufferGeometry[] = [new THREE.SphereGeometry(headR * 0.86, 20, 14).translate(J.head.x, J.head.y + headR * 0.05, J.head.z)];
    for (let v = 0; v < 24; v++) { const y = 0.53 + (v / 23) * 0.31; bones.push(new THREE.CylinderGeometry(H * 0.011 * bt, H * 0.011 * bt, H * 0.009, 10).translate(0, y * H, -0.045 * H * s)); }
    for (let k = 0; k < 10; k++) {
      const y = 0.785 - k * 0.018, rr = H * (0.085 + 0.025 * Math.sin((k + 2) / 12 * Math.PI)) * s;
      bones.push(new THREE.TorusGeometry(rr, H * 0.0035 * bt, 5, 32, Math.PI * 1.8).rotateX(Math.PI / 2).rotateY(-0.6 * Math.PI).scale(1, 1, 0.68).translate(0, y * H, -0.01 * H));
    }
    bones.push(new THREE.BoxGeometry(H * 0.022, H * 0.12, H * 0.006).translate(0, 0.72 * H, 0.062 * H * s));
    bones.push(new THREE.TorusGeometry(H * 0.07 * s, H * 0.014 * bt, 8, 28).rotateX(Math.PI / 2 + 0.4).scale(1, 1, 0.62).translate(0, 0.53 * H, -0.005 * H));
    for (const k of [0, 1]) {
      bones.push(capsule(J.sh[k], P(0, 0.82, 0.03), H * 0.006 * bt));
      bones.push(capsule(J.sh[k], J.el[k], H * 0.009 * bt), capsule(J.el[k], J.wr[k], H * 0.0065 * bt));
      bones.push(capsule(J.hip[k], J.kn[k], H * 0.0125 * bt), capsule(J.kn[k], J.an[k], H * 0.0105 * bt), capsule(J.an[k], J.toe[k], H * 0.007 * bt));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(bones)!, boneMat));
    this.grab('bone', [P(0.058 * s, 0.4, 0.01), P(-0.058 * s, 0.4, 0.01), P(0.061 * s, 0.17, 0.01), P(-0.061 * s, 0.17, 0.01), P(0, 0.53, 0), P(0.145 * s, 0.72, 0), P(-0.145 * s, 0.72, 0), P(0.1, 0.74, 0.04), P(-0.1, 0.74, 0.04)], H * 0.022, P(0.058 * s, 0.4, 0.01));

    // muscles: the big sleeves of the limbs and chest
    const mus: THREE.BufferGeometry[] = [];
    for (const k of [0, 1]) {
      mus.push(capsule(J.sh[k].clone().lerp(J.el[k], 0.15), J.el[k].clone().lerp(J.sh[k], 0.1), H * 0.022 * s * (sp.slender > 1.05 ? 1.15 : 1)));
      mus.push(capsule(J.el[k].clone().lerp(J.wr[k], 0.1), J.wr[k].clone().lerp(J.el[k], 0.3), H * 0.016 * s));
      mus.push(capsule(J.hip[k].clone().lerp(J.kn[k], 0.12), J.kn[k].clone().lerp(J.hip[k], 0.1), H * 0.038 * s * (sp.slender > 1.05 ? 1.15 : 1)));
      mus.push(capsule(J.kn[k].clone().lerp(J.an[k], 0.1), J.kn[k].clone().lerp(J.an[k], 0.6), H * 0.026 * s));
      mus.push(new THREE.SphereGeometry(H * 0.05, 14, 10).scale(1.1 * s, 0.75, 0.35).translate((k ? -1 : 1) * 0.055 * H * s, 0.745 * H, 0.05 * H * s));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(mus)!, rimMaterial(0xb8463c, 0.16, 0.18)));
    this.grab('muscle', [P(0.07 * s, 0.4, 0.03), P(-0.07 * s, 0.4, 0.03), P(0.065 * s, 0.2, 0.03), P(-0.065 * s, 0.2, 0.03), P(0.16 * s, 0.72, 0.01), P(-0.16 * s, 0.72, 0.01), P(0.06 * s, 0.75, 0.07 * s), P(-0.06 * s, 0.75, 0.07 * s)], H * 0.03, P(0.07 * s, 0.4, 0.03));

    // organs
    const brainG = new THREE.SphereGeometry(1, 48, 32);
    const pa = brainG.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const d = 1 + 0.035 * Math.sin(17 * x + 3) * Math.sin(15 * y) * Math.sin(19 * z + 1) + (Math.abs(x) < 0.05 ? -0.06 : 0);
      pa.setXYZ(i, x * d, y * d, z * d);
    }
    brainG.computeVertexNormals();
    const brR = headR * 0.78;
    const brain = new THREE.Mesh(brainG.scale(brR * 0.82, brR * 0.7, brR).translate(J.head.x, J.head.y + headR * 0.1, J.head.z - headR * 0.02), solid(0xd9a7a0, 0.14, { roughness: 0.8 }));
    this.group.add(brain);
    this.grab('brain', [brain.position.clone().add(P(0, headY + 0.1 * headR / H, 0))], brR, P(0, headY + 0.01, 0), 3);
    if (sp.parts.includes('lace')) {
      const lace = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 3)), new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.45 }));
      lace.scale.set(brR * 0.86, brR * 0.74, brR * 1.04);
      lace.position.set(J.head.x, J.head.y + headR * 0.14, J.head.z);
      this.group.add(lace);
      this.grab('lace', [lace.position.clone().add(V(0, brR * 0.7, 0)), lace.position.clone().add(V(brR * 0.6, brR * 0.4, 0)), lace.position.clone().add(V(-brR * 0.6, brR * 0.4, 0))], H * 0.025, lace.position.clone().add(V(0, brR * 0.7, 0)), 4);
    }
    const heart = new THREE.Mesh(new THREE.SphereGeometry(H * 0.032, 24, 18).scale(0.9, 1.15, 0.85).rotateZ(-0.5), solid(0xa3262a, 0.18, { roughness: 0.5 }));
    heart.position.copy(P(0.018, 0.705, 0.025));
    this.heart = heart;
    this.group.add(heart);
    this.grab('heart', [heart.position.clone()], H * 0.035, heart.position.clone(), 4);
    const lungMat = rimMaterial(0xe39a9a, 0.35, 0.2);
    for (const k of [1, -1]) {
      const lung = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18).scale(H * 0.045 * s, H * 0.095, H * 0.055 * s), lungMat);
      lung.position.copy(P(k * 0.058 * s, 0.725, -0.005));
      this.lungs.push(lung);
      this.group.add(lung);
    }
    this.grab('lungs', this.lungs.map((l) => l.position.clone().add(V(Math.sign(l.position.x) * H * 0.02, 0, 0))), H * 0.045, this.lungs[0].position.clone(), 1);
    const liver = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16).scale(H * 0.075 * s, H * 0.036, H * 0.05 * s).rotateZ(0.2), solid(0x7a2a22, 0.14));
    liver.position.copy(P(-0.04 * s, 0.6, 0.02));
    this.group.add(liver);
    this.grab('liver', [liver.position.clone()], H * 0.045, liver.position.clone(), 2);
    const kid2: THREE.Vector3[] = [];
    for (const k of [1, -1]) {
      const kd = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12).scale(H * 0.016, H * 0.028, H * 0.012), solid(0x8a2f36, 0.14));
      kd.position.copy(P(k * 0.042 * s, 0.57, -0.035 * s));
      this.group.add(kd); kid2.push(kd.position.clone());
    }
    this.grab('kidneys', kid2, H * 0.02, kid2[0], 3);
    // gut: a coil of small intestine framed by the colon
    const coil: THREE.Vector3[] = [];
    for (let k = 0; k <= 60; k++) { const t = k / 60, a = t * Math.PI * 9; coil.push(P(Math.cos(a) * (0.045 + 0.012 * Math.sin(t * 13)) * s, 0.565 - t * 0.065 + 0.008 * Math.sin(a * 0.5), 0.025 + Math.sin(a) * 0.022 * s)); }
    const small = new THREE.CatmullRomCurve3(coil);
    const colon = new THREE.CatmullRomCurve3([P(-0.07 * s, 0.49, 0.02), P(-0.075 * s, 0.58, 0.03), P(0, 0.595, 0.05), P(0.075 * s, 0.58, 0.03), P(0.07 * s, 0.5, 0.02), P(0.02, 0.48, 0.0)]);
    const gutMat = solid(0xc98a7a, 0.12, { roughness: 0.7 });
    this.group.add(new THREE.Mesh(new THREE.TubeGeometry(small, 240, H * 0.0065, 8), gutMat), new THREE.Mesh(new THREE.TubeGeometry(colon, 80, H * 0.012, 10), gutMat));
    this.grab('gut', [P(0, 0.535, 0.03), ...along(colon, H * 0.06)], H * 0.035, P(0, 0.535, 0.03), 1);

    // vessels and the blood in them
    const arch = P(0, 0.785, 0.0), heartP = heart.position;
    const art: THREE.CatmullRomCurve3[] = [];
    for (const k of [0, 1]) {
      const sx = k ? -1 : 1;
      art.push(new THREE.CatmullRomCurve3([heartP, arch, P(0, 0.7, -0.035), P(0, 0.56, -0.03), P(0, 0.5, -0.01), P(sx * 0.05 * s, 0.47, 0.012), J.kn[k].clone().add(P(0, 0, -0.01)), J.an[k].clone().add(P(0, 0.01, 0)), J.toe[k].clone().lerp(J.an[k], 0.4)]));
      art.push(new THREE.CatmullRomCurve3([heartP, arch, P(sx * 0.06 * s, 0.8, 0.01), J.sh[k], J.el[k].clone().add(P(0, 0, 0.012)), J.wr[k], J.hd[k]]));
      art.push(new THREE.CatmullRomCurve3([heartP, arch, P(sx * 0.02, 0.86, 0.015), P(sx * 0.03, headY - 0.02, 0.005), J.head.clone().add(V(sx * headR * 0.4, headR * 0.3, 0))]));
    }
    const vein = art.map((c) => new THREE.CatmullRomCurve3(c.points.map((p, i) => (i < 2 ? p.clone() : p.clone().add(V(Math.sign(p.x || 1) * H * 0.008, 0, H * 0.008))))));
    const vg: THREE.BufferGeometry[] = [], veg: THREE.BufferGeometry[] = [];
    for (const c of art) vg.push(new THREE.TubeGeometry(c, 120, H * 0.0035, 6));
    for (const c of vein) veg.push(new THREE.TubeGeometry(c, 120, H * 0.0038, 6));
    this.group.add(new THREE.Mesh(mergeGeometries(vg)!, solid(0xb3242a, 0.2, { transparent: true, opacity: 0.75 })), new THREE.Mesh(mergeGeometries(veg)!, solid(0x3a4fa8, 0.2, { transparent: true, opacity: 0.6 })));
    this.grab('blood', art.flatMap((c) => along(c, H * 0.08)), H * 0.012, J.kn[0].clone(), -1);
    this.flows.push(this.flow([...art, ...vein], 900, false, r, (i) => (i < 450 ? [0.85, 0.2, 0.18] : [0.42, 0.18, 0.38])));
    if (sp.parts.includes('nano')) this.flows.push(this.flow(art, 90, true, r, () => [0.35, 0.9, 1.0]));
  }

  /** Points riding along curves: red cells, or nanomachines. */
  private flow(curves: THREE.Curve<THREE.Vector3>[], n: number, nano: boolean, r: () => number, col: (i: number) => [number, number, number]) {
    const pos = new Float32Array(n * 3), c = new Float32Array(n * 3), size = new Float32Array(n);
    const list: Flow[] = [];
    for (let i = 0; i < n; i++) {
      const curve = curves[Math.floor(i / n * curves.length)];
      list.push({ curve, t: r(), v: (0.06 + r() * 0.05) * (nano ? 0.7 : 1) });
      c.set(col(i), i * 3);
      size[i] = nano ? 1.6 : 1.1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const pts = new THREE.Points(geo, pointsMaterial({ sizeScale: this.H * 0.004, minPx: 1.2, maxPx: 7 }));
    pts.frustumCulled = false;
    this.group.add(pts);
    const kind = nano ? 'mnano' : 'mflow';
    const f = { pts, list, nano };
    addGpuSet({ kind, points: pts, prio: nano ? 3 : 0, pickPx: 6 });
    registerExplainer(kind, {
      obj: pts,
      explain: (i) => flowCard(this.sp!, nano, i),
      locate: (i, out) => pointWorld(pts, i, out),
    });
    this.stepFlow(f, 0);
    return f;
  }

  private stepFlow(f: { pts: THREE.Points; list: Flow[] }, dt: number): void {
    const a = f.pts.geometry.attributes.position.array as Float32Array, p = new THREE.Vector3();
    f.list.forEach((x, i) => { x.t = (x.t + x.v * dt) % 1; x.curve.getPointAt(x.t, p); a[i * 3] = p.x; a[i * 3 + 1] = p.y; a[i * 3 + 2] = p.z; });
    f.pts.geometry.attributes.position.needsUpdate = true;
  }

  // ---------------------------------------------------------------- substrate

  private buildSubstrate(sp: Specimen): void {
    const r = rng(pidHash(sp.pid, 4));
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.12, 48, 1, true).translate(0, 0.56, 0), rimMaterial(0x8fb8d8, 0.06, 0.25, THREE.DoubleSide));
    this.group.add(shield);
    this.grab('shield', [V(0.34, 0.6, 0), V(-0.34, 0.6, 0), V(0, 0.6, 0.34), V(0, 1.1, 0)], 0.05, V(0, 1.1, 0));
    const slabMat = (k: number) => solid(0x2a7f8f, 0.25 + 0.1 * (k % 2), { metalness: 0.4, roughness: 0.35 });
    for (let k = 0; k < 9; k++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.3), slabMat(k));
      s.position.set(0, 0.3 + k * 0.07, 0);
      this.slabs.push(s); this.group.add(s);
    }
    this.grab('core', this.slabs.map((s) => s.position.clone().add(V(0.12, 0, 0.12))), 0.06, V(0, 0.58, 0), 2);
    const cube = new THREE.InstancedMesh(new THREE.BoxGeometry(0.026, 0.026, 0.026), solid(0xcfe6ff, 0.15, { transparent: true, opacity: 0.8, metalness: 0.2, roughness: 0.2 }), 7 * 3 * 7);
    let k = 0;
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) for (let l = 0; l < 7; l++) cube.setMatrixAt(k++, mtx.makeTranslation(-0.12 + i * 0.04, 0.07 + j * 0.04, -0.12 + l * 0.04));
    this.group.add(cube);
    this.grab('memory', [V(0, 0.11, 0.12), V(0.12, 0.11, 0), V(-0.12, 0.11, 0)], 0.06, V(0, 0.11, 0), 1);
    const lines: number[] = [];
    for (let q = 0; q < 16; q++) { const a = (q / 16) * Math.PI * 2, x = Math.cos(a) * 0.17, z = Math.sin(a) * 0.17; lines.push(x, 0.12, z, x * 0.9, 0.95, z * 0.9); }
    const optic = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.5 }));
    this.group.add(optic);
    this.grab('optic', Array.from({ length: 8 }, (_, q) => { const a = (q / 8) * Math.PI * 2; return V(Math.cos(a) * 0.165, 0.5, Math.sin(a) * 0.165); }), 0.03, V(0.17, 0.5, 0));
    const fins: THREE.BufferGeometry[] = [];
    for (let q = 0; q < 12; q++) { const a = (q / 12) * Math.PI * 2; fins.push(new THREE.BoxGeometry(0.1, 0.62, 0.004).rotateY(-a).translate(Math.cos(a) * 0.26, 0.58, Math.sin(a) * 0.26)); }
    this.group.add(new THREE.Mesh(mergeGeometries(fins)!, solid(0x9aa6b2, 0.06, { metalness: 0.7, roughness: 0.3 })));
    this.grab('cooling', Array.from({ length: 12 }, (_, q) => { const a = (q / 12) * Math.PI * 2; return V(Math.cos(a) * 0.27, 0.58, Math.sin(a) * 0.27); }), 0.04, V(0.27, 0.58, 0));
    const bars: THREE.BufferGeometry[] = [];
    for (const [x, z] of [[0.19, 0.19], [-0.19, 0.19], [0.19, -0.19], [-0.19, -0.19]]) bars.push(new THREE.BoxGeometry(0.018, 1.0, 0.018).translate(x, 0.52, z));
    this.group.add(new THREE.Mesh(mergeGeometries(bars)!, solid(0xc88033, 0.12, { metalness: 0.85, roughness: 0.3 })));
    this.grab('power', [V(0.19, 0.5, 0.19), V(-0.19, 0.5, 0.19), V(0.19, 0.5, -0.19), V(-0.19, 0.5, -0.19)], 0.03, V(0.19, 0.5, 0.19));
    // the self-model: a figure of points at their remembered height, standing beside
    const H = this.H, n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const segs: [THREE.Vector3, THREE.Vector3, number][] = [
      [V(0, 0.93, 0), V(0, 0.94, 0), 0.065], [V(0, 0.55, 0), V(0, 0.8, 0), 0.1], [V(0.13, 0.81, 0), V(0.17, 0.47, 0), 0.026], [V(-0.13, 0.81, 0), V(-0.17, 0.47, 0), 0.026],
      [V(0.055, 0.5, 0), V(0.06, 0.04, 0), 0.04], [V(-0.055, 0.5, 0), V(-0.06, 0.04, 0), 0.04],
    ];
    for (let i = 0; i < n; i++) {
      const [a, b, rad] = segs[Math.floor(r() * segs.length)];
      const t = r(), th = r() * Math.PI * 2;
      const p = a.clone().lerp(b, t).multiplyScalar(H).add(V(Math.cos(th) * rad * H * (segs.indexOf(segs[0]) ? 1 : 1), (r() - 0.5) * rad * H * 0.4, Math.sin(th) * rad * H * 0.7));
      pos.set([p.x + 0.85, p.y, p.z], i * 3);
      const v = 0.4 + r() * 0.25;
      col.set([v * 0.6, v * 0.85, v], i * 3);
      size[i] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const avatar = new THREE.Points(geo, pointsMaterial({ sizeScale: 0.006, minPx: 1, maxPx: 4 }));
    avatar.frustumCulled = false;
    this.group.add(avatar);
    this.grab('avatar', [V(0.85, H * 0.93, 0), V(0.85, H * 0.65, 0), V(0.85, H * 0.3, 0)], 0.12, V(0.85, H * 0.6, 0));
  }

  // ---------------------------------------------------------------- View

  frame(ctx: Ctx, dt: number): void {
    // a resting heart about 70 beats a minute, breathing about 14 times
    if (this.heart) { const b = (ctx.t * 70 / 60) % 1, k = 1 + 0.07 * Math.exp(-((b - 0.1) ** 2) / 0.004) + 0.04 * Math.exp(-((b - 0.32) ** 2) / 0.003); this.heart.scale.setScalar(k); }
    const br = 1 + 0.035 * Math.sin(ctx.t * Math.PI * 2 * 14 / 60);
    for (const l of this.lungs) l.scale.set(br, 1 + (br - 1) * 1.4, br);
    this.slabs.forEach((s, k) => { const m = s.material as THREE.MeshStandardMaterial; m.emissiveIntensity = 1 + 0.6 * Math.max(0, Math.sin(ctx.t * 3 - k * 0.7)); });
    for (const f of this.flows) this.stepFlow(f, dt);
  }

  pickables(): Pickable[] {
    const out: Pickable[] = [];
    for (const g of this.grabs) for (const p of g.at) out.push({ pos: p, kind: 'thing', ex: 'mpart', id: g.id, name: g.name, r: g.r, weight: g.weight });
    return out;
  }

  labels(ctx: Ctx): Label[] {
    const sp = this.sp;
    if (!sp) return [{ pos: V(0, 1.2, 0), text: this.m.bio?.name ?? 'Finding them…', strong: true, prio: 10 }];
    const H = this.H;
    const pf = personFacts(sp);
    const out: Label[] = [{ pos: V(0, H * 1.06, 0), text: sp.name, sub: `${Math.floor(sp.age)} · ${sp.bodyWord} · ${sp.form === 'substrate' ? `remembers being ${pf[1].v} tall` : `${pf[1].v} · ${pf[3].v}`}${sp.status === 'dead' ? ' · as they were at their death' : sp.status === 'unborn' ? ' · not yet born' : ''}`, strong: true, prio: 12 }];
    for (const g of this.grabs) out.push({ pos: g.centre, text: g.name, ref: { kind: 'thing', ex: 'mpart', id: g.id, name: g.name }, prio: 4 + (g.weight ?? 0) * 0.3 });
    void ctx;
    return out;
  }

  locate(_ctx: Ctx, r: Ref): THREE.Vector3 | null {
    if (r.kind === 'thing' && r.ex === 'mpart') return this.grabs.find((g) => g.id === r.id)?.centre.clone() ?? null;
    return r.kind === 'person' ? V(0, this.H * 0.55, 0) : null;
  }

  diveDist(_ctx: Ctx, r: Ref): number {
    if (r.kind !== 'thing' || !this.sp) return 0;
    if (r.ex === 'mflow' || r.ex === 'mnano') return 0.25;
    if (r.ex !== 'mpart') return 0;
    return Math.max(0.22, Math.min(0.5, partSize(this.sp, this.sp.parts[r.id]) * 1.4));
  }

  size(_ctx: Ctx, r: Ref): number {
    if (r.kind === 'thing' && r.ex === 'mpart' && this.sp) return Math.min(0.3, partSize(this.sp, this.sp.parts[r.id]) * 0.5);
    return 0;
  }
}
