// Molecules, atom by atom. Crystals (apatite, silicon, diamond, copper) come
// from their real lattices and space groups; small molecules from ideal bond
// lengths and angles; DNA, membranes and protein helices from their real
// dimensions with schematic atom placement. Lengths are in ångströms.

import type { CellPlan, F3, MolId, Organelle } from './cells.ts';
import { fmtSci } from '../ui/format.ts';
import { elem } from './elements.ts';
import { pidHash, type Specimen } from './specimen.ts';

export type V3 = [number, number, number];
/** Z = 0 is a vacancy: a missing atom in a crystal. `mol` ≥ 0 marks a neighbouring molecule, -1 the subject. */
export interface MAtom { Z: number; p: V3; role: string; mol: number; hl?: boolean }
export interface Molecule {
  id: MolId; name: string; formula: string; lede: string; facts: F3[];
  atoms: MAtom[]; bonds: [number, number][]; hbonds: [number, number][];
  envName: string;       // what the neighbouring molecules are
  hHidden: boolean;
  why?: string;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const cyl = (r: number, th: number, z: number): V3 => [r * Math.cos(th), r * Math.sin(th), z];
const D = Math.PI / 180;

/** Deterministic random numbers for one molecule. */
function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

class B {
  atoms: MAtom[] = []; bonds: [number, number][] = []; hbonds: [number, number][] = [];
  mol = -1;
  a(Z: number, p: V3, role: string, hl = false): number { this.atoms.push({ Z, p, role, mol: this.mol, hl: hl || undefined }); return this.atoms.length - 1; }
  b(i: number, j: number): void { this.bonds.push([i, j]); }
  chain(...ids: number[]): void { for (let k = 1; k < ids.length; k++) this.b(ids[k - 1], ids[k]); }
  ring(ids: number[]): void { this.chain(...ids, ids[0]); }
  /** bonds by distance (crystals): pairs closer than 1.15 × the covalent radii, within one molecule */
  auto(from = 0, tol = 1.15): void {
    const A = this.atoms, n = A.length, cell = 3.2, grid = new Map<string, number[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = from; i < n; i++) { const k = key(...A[i].p); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    for (let i = from; i < n; i++) {
      if (!A[i].Z) continue;
      const [x, y, z] = A[i].p;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
          if (j <= i || !A[j].Z || A[i].mol !== A[j].mol || (A[i].Z === 1 && A[j].Z === 1)) continue;
          const d = len(sub(A[i].p, A[j].p));
          if (d < tol * (elem(A[i].Z).cov + elem(A[j].Z).cov) / 100) this.bonds.push([i, j]);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- planar rings

/** A regular n-gon of atoms in the plane (u, v) around c with circumradius r, starting at angle a0 (deg). */
function polygon(c: V3, u: V3, v: V3, n: number, r: number, a0: number): V3[] {
  return Array.from({ length: n }, (_, k) => { const t = (a0 + (360 / n) * k) * D; return add(c, add(mul(u, r * Math.cos(t)), mul(v, r * Math.sin(t)))); });
}

/** A purine (two fused rings) or pyrimidine base in local 2D, with the atom that bonds to the sugar first. */
function base2D(kind: 'A' | 'G' | 'C' | 'T' | 'U'): { Z: number; x: number; y: number; name: string }[] {
  const out: { Z: number; x: number; y: number; name: string }[] = [];
  const P = (Z: number, x: number, y: number, name: string) => out.push({ Z, x, y, name });
  if (kind === 'A' || kind === 'G') {
    // pentagon (imidazole) on the left, hexagon on the right sharing an edge
    const c5 = [0, 0], c6 = [2.175, 0], r5 = 1.2, r6 = 1.39;
    const at5 = (deg: number) => [c5[0] + r5 * Math.cos(deg * D), c5[1] + r5 * Math.sin(deg * D)];
    const at6 = (deg: number) => [c6[0] + r6 * Math.cos(deg * D), c6[1] + r6 * Math.sin(deg * D)];
    const n9 = at5(252), c8 = at5(180), n7 = at5(108), c5a = at6(150), c4 = at6(210), n3 = at6(270), c2 = at6(330), n1 = at6(30), c6a = at6(90);
    P(7, n9[0], n9[1], 'N9'); P(6, c8[0], c8[1], 'C8'); P(7, n7[0], n7[1], 'N7'); P(6, c5a[0], c5a[1], 'C5'); P(6, c6a[0], c6a[1], 'C6');
    P(7, n1[0], n1[1], 'N1'); P(6, c2[0], c2[1], 'C2'); P(7, n3[0], n3[1], 'N3'); P(6, c4[0], c4[1], 'C4');
    const out6 = (from: number[], deg: number, Z: number, name: string) => P(Z, from[0] + 1.3 * Math.cos(deg * D), from[1] + 1.3 * Math.sin(deg * D), name);
    if (kind === 'A') out6(c6a, 90, 7, 'N6'); else { out6(c6a, 90, 8, 'O6'); out6(c2, 330, 7, 'N2'); }
  } else {
    const r = 1.39, at = (deg: number) => [r * Math.cos(deg * D), r * Math.sin(deg * D)];
    const n1 = at(180), c2 = at(240), n3 = at(300), c4 = at(0), c5 = at(60), c6 = at(120);
    P(7, n1[0], n1[1], 'N1'); P(6, c2[0], c2[1], 'C2'); P(7, n3[0], n3[1], 'N3'); P(6, c4[0], c4[1], 'C4'); P(6, c5[0], c5[1], 'C5'); P(6, c6[0], c6[1], 'C6');
    const o = (from: number[], deg: number, Z: number, name: string) => P(Z, from[0] + 1.25 * Math.cos(deg * D), from[1] + 1.25 * Math.sin(deg * D), name);
    o(c2, 240, 8, 'O2');
    if (kind === 'C') o(c4, 0, 7, 'N4'); else o(c4, 0, 8, 'O4');
    if (kind === 'T') P(6, c5[0] + 1.5 * Math.cos(60 * D), c5[1] + 1.5 * Math.sin(60 * D), 'C7 (methyl)');
  }
  return out;
}
/** Ring bonds of a base as built by base2D (indices into its list). */
function baseBonds(kind: string): [number, number][] {
  if (kind === 'A' || kind === 'G') {
    const r: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 0], [8, 3]];
    r.push([4, 9]);
    if (kind === 'G') r.push([6, 10]);
    return r;
  }
  const r: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 6], [3, 7]];
  if (kind === 'T') r.push([4, 8]);
  return r;
}

const PAIR: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };
const BASE_NAME: Record<string, string> = { A: 'adenine', T: 'thymine', G: 'guanine', C: 'cytosine' };

// ---------------------------------------------------------------- builders

function water(m: B, at: V3, rot: number, tilt: number, role = 'water'): number {
  // O–H 0.9572 Å, H–O–H 104.52°
  const s = Math.sin(52.26 * D) * 0.9572, c = Math.cos(52.26 * D) * 0.9572;
  const R = (x: number, y: number, z: number): V3 => {
    const x1 = x * Math.cos(rot) - z * Math.sin(rot), z1 = x * Math.sin(rot) + z * Math.cos(rot);
    const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt), z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
    return add(at, [x1, y2, z2]);
  };
  const o = m.a(8, R(0, 0, 0), role === 'water' ? 'oxygen of water' : role);
  const h1 = m.a(1, R(s, c, 0), 'hydrogen of water'), h2 = m.a(1, R(-s, c, 0), 'hydrogen of water');
  m.b(o, h1); m.b(o, h2);
  return o;
}

/** Neighbouring water filling a sphere around what's already built, kept 2.6 Å clear of it. */
function solvate(m: B, R: number, seed: number, max = 160): void {
  const r = rnd(seed), solid = m.atoms.map((a) => a.p);
  const min = [0, 1, 2].map((k) => Math.min(...solid.map((p) => p[k]))), mx = [0, 1, 2].map((k) => Math.max(...solid.map((p) => p[k])));
  const c: V3 = [(min[0] + mx[0]) / 2, (min[1] + mx[1]) / 2, (min[2] + mx[2]) / 2];
  let n = 0;
  const step = 3.1;
  for (let x = -R; x <= R && n < max; x += step) for (let y = -R; y <= R && n < max; y += step) for (let z = -R; z <= R && n < max; z += step) {
    const p: V3 = add(c, [x + (r() - 0.5) * 1.2, y + (r() - 0.5) * 1.2, z + (r() - 0.5) * 1.2]);
    if (len(sub(p, c)) > R) continue;
    if (solid.some((q) => len(sub(p, q)) < 2.7)) continue;
    m.mol = n++;
    water(m, p, r() * 6.28, r() * 6.28);
  }
  m.mol = -1;
}

function dna(m: B, seq: string, hlFrom: number, hlTo: number): void {
  const n = seq.length, rise = 3.38, twist = 34.3 * D;
  const c1: number[][] = [[], []];
  const prevO3: (number | null)[] = [null, null];
  for (let i = 0; i < n; i++) {
    const z = (i - n / 2) * rise, th = i * twist;
    const hl = i >= hlFrom && i <= hlTo;
    const bA = seq[i], bB = PAIR[bA];
    for (let s = 0; s < 2; s++) {
      const dir = s === 0 ? 1 : -1;
      const phi = th + (s === 0 ? 0 : 125 * D);
      const radial: V3 = [Math.cos(phi), Math.sin(phi), 0], tang: V3 = [-Math.sin(phi), Math.cos(phi), 0], up: V3 = [0, 0, dir];
      const C1: V3 = cyl(5.9, phi, z);
      // sugar ring in the radial–axial plane, C1' first
      const rc = add(C1, add(mul(radial, 1.05), mul(up, 0.65)));
      const ringPts = polygon(rc, norm(sub(C1, rc)), norm(cross(norm(sub(C1, rc)), tang)), 5, 1.25, 0);
      const strand = s === 0 ? 'strand 1' : 'strand 2';
      const ids = ringPts.map((p, k) => m.a(k === 1 ? 8 : 6, p, `deoxyribose sugar (${['C1′', 'O4′', 'C4′', 'C3′', 'C2′'][k]}), ${strand}`, hl));
      m.ring(ids);
      c1[s][i] = ids[0];
      const C4 = ringPts[2], C3 = ringPts[3];
      // the phosphate sits halfway to the 5′ neighbour (strand 1: the pair below; strand 2: the pair above)
      const Pp = cyl(8.9, phi - dir * 17.15 * D, z - dir * 1.69);
      const C5 = m.a(6, add(C4, add(mul(radial, 0.9), mul(up, -1.1))), `deoxyribose sugar (C5′), ${strand}`, hl);
      m.b(ids[2], C5);
      const O5 = m.a(8, mul(add(m.atoms[C5].p, Pp), 0.5), `phosphate ester oxygen (O5′), ${strand}`, hl);
      m.b(C5, O5);
      const P = m.a(15, Pp, `phosphate (backbone), ${strand}`, hl);
      m.b(O5, P);
      const op1 = m.a(8, add(Pp, add(mul(radial, 1.3), mul(tang, 0.6))), `phosphate oxygen, ${strand}`, hl);
      const op2 = m.a(8, add(Pp, add(mul(radial, 0.4), mul(tang, -1.4))), `phosphate oxygen, ${strand}`, hl);
      m.b(P, op1); m.b(P, op2);
      // O3′ points at the next phosphate along the strand
      const Pnext = cyl(8.9, phi + dir * 17.15 * D, z + dir * 1.69);
      const O3 = m.a(8, add(C3, mul(norm(sub(Pnext, C3)), 1.43)), `sugar oxygen (O3′), ${strand}`, hl);
      m.b(ids[3], O3);
      // strand 1's O3′ bonds the next pair's phosphate; strand 2's bonds the previous pair's
      if (s === 0 && prevO3[0] !== null) m.b(prevO3[0]!, P);
      if (s === 1 && prevO3[1] !== null) m.b(O3, prevO3[1]!);
      prevO3[s] = s === 0 ? O3 : P;
    }
    // the base pair, built flat and laid between the two C1′ atoms
    const A3 = m.atoms[c1[0][i]].p, B3 = m.atoms[c1[1][i]].p;
    const xA = base2D(bA as 'A'), xB = base2D(bB as 'A');
    const pur = (b: string) => b === 'A' || b === 'G';
    // attach points and where each base's sugar bond leaves
    const anchor = (b: string) => (pur(b) ? { x: 1.2 * Math.cos(252 * D) + 1.47 * Math.cos(252 * D), y: 1.2 * Math.sin(252 * D) + 1.47 * Math.sin(252 * D) } : { x: -1.39 - 1.47, y: 0 });
    const aA = anchor(bA), aB = anchor(bB);
    const extent = (L: typeof xA) => Math.max(...L.map((q) => q.x));
    const gap = 2.9;
    const offB = extent(xA) + gap + extent(xB); // B is mirrored: its local x becomes offB − x
    const locA = (q: { x: number; y: number }) => [q.x - aA.x, q.y - aA.y];
    const locB = (q: { x: number; y: number }) => [offB - q.x - aA.x, q.y - aA.y];
    const LB = locB(aB);
    const Ldist = Math.hypot(LB[0], LB[1]);
    const ex = norm(sub(B3, A3)), ey = norm(cross([0, 0, 1], ex)), scale = len(sub(B3, A3)) / Ldist;
    const rotL = Math.atan2(LB[1], LB[0]);
    const place = (l: number[]): V3 => {
      const x = (l[0] * Math.cos(-rotL) - l[1] * Math.sin(-rotL)), y = (l[0] * Math.sin(-rotL) + l[1] * Math.cos(-rotL));
      return add(A3, add(mul(ex, x * scale), mul(ey, y)));
    };
    const idA = xA.map((q) => m.a(q.Z, place(locA(q)), `${BASE_NAME[bA]} base (${q.name}), strand 1`, hl));
    const idB = xB.map((q) => m.a(q.Z, place(locB(q)), `${BASE_NAME[bB]} base (${q.name}), strand 2`, hl));
    for (const [u, v] of baseBonds(bA)) m.b(idA[u], idA[v]);
    for (const [u, v] of baseBonds(bB)) m.b(idB[u], idB[v]);
    m.b(c1[0][i], idA[0]); m.b(c1[1][i], idB[0]);
    // Watson–Crick hydrogen bonds: two for A·T, three for G·C, between the facing N and O atoms
    const face = (ids: number[]) => ids.filter((k) => m.atoms[k].Z === 7 || m.atoms[k].Z === 8);
    const pairs: [number, number, number][] = [];
    for (const u of face(idA)) for (const v of face(idB)) pairs.push([u, v, len(sub(m.atoms[u].p, m.atoms[v].p))]);
    pairs.sort((p, q) => p[2] - q[2]);
    const want = bA === 'G' || bA === 'C' ? 3 : 2, used = new Set<number>();
    let got = 0;
    for (const [u, v] of pairs) { if (got >= want) break; if (used.has(u) || used.has(v)) continue; used.add(u); used.add(v); m.hbonds.push([u, v]); got++; }
  }
}

function lipid(m: B, at: V3, flip: number, rot: number, r: () => number): void {
  // POPC: choline, phosphate, glycerol, a palmitoyl (16:0) and an oleoyl (18:1 cis-9) tail; heavy atoms only
  const u: V3 = [Math.cos(rot), Math.sin(rot), 0], v: V3 = [-Math.sin(rot), Math.cos(rot), 0], dn: V3 = [0, 0, -flip];
  const P = (x: number, y: number, z: number): V3 => add(at, add(add(mul(u, x), mul(v, y)), mul(dn, z)));
  const N = m.a(7, P(0, 0, -2.2), 'choline nitrogen (head group)');
  const me = [0, 1, 2].map((k) => m.a(6, P(1.3 * Math.cos(k * 2.09), 1.3 * Math.sin(k * 2.09), -2.8), 'choline methyl carbon'));
  for (const c of me) m.b(N, c);
  const ca = m.a(6, P(0.3, 0.2, -0.8), 'choline carbon'), cb = m.a(6, P(-0.5, 0.4, 0.4), 'choline carbon');
  const o1 = m.a(8, P(0.2, 0.3, 1.5), 'phosphate ester oxygen'), p = m.a(15, P(-0.3, 0.1, 2.9), 'phosphate (head group)');
  const op1 = m.a(8, P(-1.7, 0.2, 2.9), 'phosphate oxygen'), op2 = m.a(8, P(0.4, -1.2, 2.9), 'phosphate oxygen');
  const o2 = m.a(8, P(0.2, 1.1, 4.1), 'phosphate ester oxygen');
  m.chain(N, ca, cb, o1, p, o2); m.b(p, op1); m.b(p, op2);
  const g3 = m.a(6, P(0.1, 0.8, 5.5), 'glycerol carbon'), g2 = m.a(6, P(0.4, -0.4, 6.4), 'glycerol carbon'), g1 = m.a(6, P(-0.6, 1.6, 6.6), 'glycerol carbon');
  m.chain(o2, g3, g2); m.b(g3, g1);
  const tails: [number, number, number][] = [[g1, -2.2, 16], [g2, 2.2, 18]];
  tails.forEach(([g, off, n], ti) => {
    const oe = m.a(8, P(off * 0.5, 0, 7.4), 'ester oxygen'), cc = m.a(6, P(off * 0.75, 0, 8.6), 'carbonyl carbon'), od = m.a(8, P(off * 0.75 + 1.1, 0.4, 8.9), 'carbonyl oxygen');
    m.chain(g, oe, cc); m.b(cc, od);
    let prev = cc, x = off, y = 0, z = 8.6, dx = 0;
    for (let k = 2; k <= n; k++) {
      // zigzag about 1 Å down per carbon (fluid-phase tails are not fully stretched); oleoyl bends at its cis double bond (C9=C10)
      z += 1.0; x += (k % 2 ? 0.55 : -0.55) + dx; y += (r() - 0.5) * 0.15;
      if (ti === 1 && k === 10) dx = 0.55 * Math.sign(off);
      const c = m.a(6, P(x, y, z), ti === 0 ? 'palmitoyl tail carbon (saturated)' : k === 9 || k === 10 ? 'oleoyl tail carbon (cis double bond)' : 'oleoyl tail carbon');
      m.b(prev, c); prev = c;
    }
  });
}

function helix(m: B, n: number, opts: { perTurn: number; rise: number; r: number; at: V3; phase: number; seq: string; label: string; hb: boolean; twist?: number }): void {
  const { perTurn, rise, r, at, phase, seq, label } = opts;
  const step = (2 * Math.PI) / perTurn;
  const Ns: number[] = [], Os: number[] = [];
  let prevC = -1;
  for (let i = 0; i < n; i++) {
    const th = phase + i * step, z = (i - n / 2) * rise;
    const res = AA[seq[i % seq.length]] ?? 'alanine';
    const off = (c: V3): V3 => {
      if (!opts.twist) return add(at, c);
      const t = opts.twist * z; // supercoil: the strand winds around the bundle axis
      return add([at[0] * Math.cos(t) - at[1] * Math.sin(t), at[0] * Math.sin(t) + at[1] * Math.cos(t), at[2]], c);
    };
    const N = m.a(7, off(cyl(r * 0.67, th - 27 * D, z - 0.99)), `backbone nitrogen, ${res} ${i + 1}, ${label}`);
    const CA = m.a(6, off(cyl(r, th, z)), `alpha carbon, ${res} ${i + 1}, ${label}`);
    const C = m.a(6, off(cyl(r * 0.72, th + 26 * D, z + 0.9)), `carbonyl carbon, ${res} ${i + 1}, ${label}`);
    const O = m.a(8, off(cyl(r * 0.85, th + 30 * D, z + 0.9 + 1.23)), `carbonyl oxygen, ${res} ${i + 1}, ${label}`);
    m.chain(N, CA, C, O);
    if (prevC >= 0) m.b(prevC, N);
    if (res !== 'glycine') { const CB = m.a(6, off(cyl(r + 1.45, th + 5 * D, z - 0.4)), `side chain (Cβ), ${res} ${i + 1}, ${label}`); m.b(CA, CB); }
    prevC = C; Ns.push(N); Os.push(O);
  }
  if (opts.hb) for (let i = 0; i + 4 < n; i++) if (len(sub(m.atoms[Os[i]].p, m.atoms[Ns[i + 4]].p)) < 3.6) m.hbonds.push([Os[i], Ns[i + 4]]);
}
const AA: Record<string, string> = { A: 'alanine', L: 'leucine', E: 'glutamate', K: 'lysine', R: 'arginine', Q: 'glutamine', I: 'isoleucine', V: 'valine', D: 'aspartate', S: 'serine', G: 'glycine', P: 'proline', O: 'hydroxyproline', M: 'methionine', N: 'asparagine', T: 'threonine', F: 'phenylalanine' };

function heme(m: B): void {
  const fe = m.a(26, [0, 0, 0], 'iron at the heart of the heme');
  const ring: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = k * 90 * D;
    const N = m.a(7, cyl(2.0, a, 0), 'pyrrole nitrogen, bonded to the iron');
    const ca1 = m.a(6, cyl(3.0, a - 22 * D, 0), 'porphyrin ring carbon'), ca2 = m.a(6, cyl(3.0, a + 22 * D, 0), 'porphyrin ring carbon');
    const cb1 = m.a(6, cyl(4.3, a - 9 * D, 0), 'porphyrin ring carbon'), cb2 = m.a(6, cyl(4.3, a + 9 * D, 0), 'porphyrin ring carbon');
    m.ring([N, ca1, cb1, cb2, ca2]); m.b(fe, N);
    const meso = m.a(6, cyl(3.4, a + 45 * D, 0), 'meso carbon (bridge)');
    m.b(ca2, meso);
    ring.push(ca1, meso);
    // side groups: methyls and vinyls, and two propionates that reach into the protein
    const s1 = m.a(6, cyl(5.7, a - 13 * D, 0), k < 2 ? 'methyl carbon' : 'propionate carbon'), s2 = m.a(6, cyl(5.7, a + 13 * D, 0.2), k % 2 ? 'vinyl carbon' : 'methyl carbon');
    m.b(cb1, s1); m.b(cb2, s2);
    if (k >= 2) {
      const c2 = m.a(6, cyl(6.9, a - 18 * D, -0.9), 'propionate carbon'), c3 = m.a(6, cyl(8.1, a - 20 * D, -1.2), 'propionate carboxyl carbon');
      const o1 = m.a(8, cyl(8.6, a - 26 * D, -2.1), 'propionate oxygen'), o2 = m.a(8, cyl(8.9, a - 15 * D, -0.6), 'propionate oxygen');
      m.chain(s1, c2, c3, o1); m.b(c3, o2);
    }
  }
  for (let k = 0; k < 4; k++) m.b(ring[k * 2 + 1], ring[((k + 1) % 4) * 2]);
  // oxygen bound end-on above the iron (bent, as in oxyhaemoglobin), the protein's histidine below
  const oa = m.a(8, [0, 0, 1.8], 'bound oxygen molecule', true), ob = m.a(8, [0.85, 0.3, 2.65], 'bound oxygen molecule', true);
  m.b(fe, oa); m.b(oa, ob);
  const ne = m.a(7, [0, 0, -2.1], 'proximal histidine nitrogen (holds the iron from below)');
  const im = polygon([0, 0.0, -3.2], [0, 0, 1], [1, 0, 0], 5, 1.12, 0).slice(1).map((p, k) => m.a(k === 2 ? 7 : 6, p, 'proximal histidine ring'));
  m.ring([ne, ...im]); m.b(fe, ne);
  const cb = m.a(6, add(m.atoms[im[2]].p, [1.4, 0, -0.6]), 'proximal histidine (Cβ)'); m.b(im[2], cb);
}

/** Apply the 12 operations of P6₃/m to fractional coordinates, keep distinct positions in [0,1). */
function p63m(f: V3): V3[] {
  const [x, y, z] = f;
  const ops: V3[] = [[x, y, z], [-y, x - y, z], [-x + y, -x, z], [-x, -y, z + 0.5], [y, -x + y, z + 0.5], [x - y, x, z + 0.5],
    [-x, -y, -z], [y, -x + y, -z], [x - y, x, -z], [x, y, -z + 0.5], [-y, x - y, -z + 0.5], [-x + y, -x, -z + 0.5]];
  const out: V3[] = [];
  for (const o of ops) {
    const w = o.map((t) => ((t % 1) + 1) % 1) as V3;
    if (!out.some((q) => q.every((t, k) => Math.min(Math.abs(t - w[k]), 1 - Math.abs(t - w[k])) < 1e-3))) out.push(w);
  }
  return out;
}

function apatite(m: B): void {
  // hydroxyapatite Ca10(PO4)6(OH)2, P6₃/m, a = 9.418 Å, c = 6.884 Å (fractional sites after Hughes et al. 1989)
  const a = 9.418, c = 6.884;
  const sites: [number, V3, string][] = [
    [20, [1 / 3, 2 / 3, 0.0015], 'calcium (column site)'], [20, [0.2465, 0.9933, 0.25], 'calcium (screw-axis site)'],
    [15, [0.3982, 0.3689, 0.25], 'phosphorus of phosphate'], [8, [0.3272, 0.4848, 0.25], 'phosphate oxygen'], [8, [0.5876, 0.465, 0.25], 'phosphate oxygen'],
    [8, [0.3433, 0.2579, 0.0705], 'phosphate oxygen'],
  ];
  const cart = (f: V3, i: number, j: number, k: number): V3 => { const fx = f[0] + i, fy = f[1] + j, fz = f[2] + k; return [a * (fx - fy / 2) - a * 0.75, a * fy * Math.sqrt(3) / 2 - a * 0.85, c * fz - c]; };
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    for (const [Z, f, role] of sites) for (const q of p63m(f)) m.a(Z, cart(q, i, j, k), role);
    // the hydroxide columns run down the c axis (half-occupied sites: one of each pair)
    for (const z of [0.1979, 0.6979]) { const o = m.a(8, cart([0, 0, z], i, j, k), 'hydroxide oxygen'); const h = m.a(1, cart([0, 0, z + 0.14], i, j, k), 'hydroxide hydrogen'); m.b(o, h); }
  }
  m.auto(0, 1.08);
  // keep only the real bonds: P–O, O–H and the ionic Ca–O contacts
  m.bonds = m.bonds.filter(([i, j]) => { const z = [m.atoms[i].Z, m.atoms[j].Z].sort((x, y) => x - y).join(); return z === '8,15' || z === '1,8' || z === '8,20'; });
}

function diamondLattice(m: B, keep: (p: V3) => boolean, size: number, role: string): void {
  const a = 3.567, basis: V3[] = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0], [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
  const n = Math.ceil(size / a);
  for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) for (let k = -n; k < n; k++) for (const b of basis) {
    const p: V3 = [(i + b[0]) * a, (j + b[1]) * a, (k + b[2]) * a];
    if (keep(p)) m.a(6, p, role);
  }
}

function gear(m: B): void {
  // a 12-tooth diamondoid gear with an axle hole, after the machine-phase designs in Drexler's Nanosystems (1992)
  diamondLattice(m, (p) => {
    const r = Math.hypot(p[0], p[1]), th = Math.atan2(p[1], p[0]);
    if (Math.abs(p[2]) > 3.6 || r < 2.6) return false;
    const tooth = Math.cos(th * 12) > 0.15;
    return r < 8.5 || (tooth && r < 11.2);
  }, 12, 'diamondoid carbon');
  m.auto();
}

function nvDiamond(m: B): void {
  diamondLattice(m, (p) => Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) < 7.2, 8, 'diamond carbon');
  // one nitrogen-vacancy centre near the middle: swap a carbon for nitrogen, remove a neighbour
  let best = 0, bd = 1e9;
  m.atoms.forEach((q, i) => { const d = len(q.p); if (d < bd) { bd = d; best = i; } });
  const nb = m.atoms.findIndex((q, i) => i !== best && Math.abs(len(sub(q.p, m.atoms[best].p)) - 1.545) < 0.05);
  m.atoms[best] = { ...m.atoms[best], Z: 7, role: 'nitrogen of the NV centre', hl: true };
  if (nb >= 0) m.atoms[nb] = { ...m.atoms[nb], Z: 0, role: 'vacancy of the NV centre', hl: true };
  m.auto();
}

function silicon(m: B): void {
  const a = 5.431, basis: V3[] = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0], [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
  for (let i = -1; i < 2; i++) for (let j = -1; j < 2; j++) for (let k = -1; k < 2; k++) for (const b of basis) m.a(14, [(i + b[0]) * a, (j + b[1]) * a, (k + b[2]) * a], 'silicon');
  let best = 0, bd = 1e9;
  m.atoms.forEach((q, i) => { const d = len(sub(q.p, [2, 2, 2])); if (d < bd) { bd = d; best = i; } });
  m.atoms[best] = { ...m.atoms[best], Z: 15, role: 'phosphorus dopant (gives one spare electron: n-type)', hl: true };
  m.auto();
}

function copper(m: B): void {
  const a = 3.615, basis: V3[] = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
  for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) for (let k = -2; k < 2; k++) for (const b of basis) m.a(29, [(i + b[0] + 0.25) * a, (j + b[1] + 0.25) * a, (k + b[2] + 0.25) * a], 'copper');
  m.auto(0, 1.02);
}

function nanotube(m: B): void {
  // (10,10) armchair tube: graphene (C–C 1.42 Å) rolled along its chiral vector, 13.6 Å across
  const acc = 1.42, a = acc * Math.sqrt(3), C = a * Math.sqrt(300), L = 26;
  const a1: [number, number] = [a, 0], a2: [number, number] = [a / 2, (a * Math.sqrt(3)) / 2];
  const ch = norm([a1[0] + a2[0], a1[1] + a2[1], 0]), tv: V3 = [-ch[1], ch[0], 0];
  const pts: [number, number][] = [];
  for (let i = -40; i < 40; i++) for (let j = -40; j < 40; j++) for (const off of [[0, 0], [(a1[0] + a2[0]) / 3, (a1[1] + a2[1]) / 3]]) {
    const x = i * a1[0] + j * a2[0] + off[0], y = i * a1[1] + j * a2[1] + off[1];
    const u = x * ch[0] + y * ch[1], v = x * tv[0] + y * tv[1];
    if (u >= -1e-6 && u < C - 0.3 && v >= 0 && v < L) pts.push([u, v]);
  }
  const R = C / (2 * Math.PI);
  for (const [u, v] of pts) m.a(6, [R * Math.cos(u / R), R * Math.sin(u / R), v - L / 2], 'nanotube carbon');
  m.auto();
}

function polyethylene(m: B): void {
  // orthorhombic PE: a = 7.42 Å, b = 4.95 Å, chains along c (2.55 Å per CH2–CH2 repeat)
  const chains: [number, number, number][] = [];
  for (let i = -1; i <= 1; i++) for (let j = 0; j <= 1; j++) { chains.push([i * 7.42, j * 4.95, 0.8]); chains.push([i * 7.42 + 3.71, j * 4.95 + 2.475, -0.8]); }
  chains.forEach(([x0, y0, set], ci) => {
    m.mol = ci === 0 ? -1 : ci;
    let prev = -1;
    for (let k = 0; k < 12; k++) {
      const zig = (k % 2 ? 0.42 : -0.42);
      const c = m.a(6, [x0 + zig * Math.cos(set), y0 + zig * Math.sin(set), (k - 6) * 1.275], 'carbon of a CH₂ group');
      for (const s of [-1, 1]) { const h = m.a(1, [x0 + (zig * 2.2) * Math.cos(set) + s * 0.88 * -Math.sin(set), y0 + (zig * 2.2) * Math.sin(set) + s * 0.88 * Math.cos(set), (k - 6) * 1.275], 'hydrogen'); m.b(c, h); }
      if (prev >= 0) m.b(prev, c);
      prev = c;
    }
  });
  m.mol = -1;
}

function atp(m: B): void {
  const ad = base2D('A');
  const idx = ad.map((q) => m.a(q.Z, [q.x - 6, q.y + 2, 0], `adenine (${q.name})`));
  for (const [u, v] of baseBonds('A')) m.b(idx[u], idx[v]);
  const n9 = m.atoms[idx[0]].p, out = norm(sub(n9, [-6, 2, 0]));
  const c1: V3 = add(n9, mul(out, 1.47)), rc: V3 = add(c1, mul(norm(add(out, [0, 0, 0.5])), 1.25));
  const ru = norm(sub(c1, rc));
  const rib = polygon(rc, ru, norm(cross(ru, [0, 0, 1])), 5, 1.25, 0).map((p, k) => m.a(k === 1 ? 8 : 6, p, `ribose sugar (${['C1′', 'O4′', 'C4′', 'C3′', 'C2′'][k]})`));
  m.ring(rib); m.b(idx[0], rib[0]);
  const o2 = m.a(8, add(m.atoms[rib[4]].p, [-0.5, -1.3, 0]), 'ribose hydroxyl oxygen'), o3 = m.a(8, add(m.atoms[rib[3]].p, [0.3, -1.4, 0]), 'ribose hydroxyl oxygen');
  m.b(rib[4], o2); m.b(rib[3], o3);
  const c5 = m.a(6, add(m.atoms[rib[2]].p, [1.4, 0.3, 0]), 'ribose (C5′)'); m.b(rib[2], c5);
  let prev = m.a(8, add(m.atoms[c5].p, [1.0, 1.0, 0]), 'ester oxygen'); m.b(c5, prev);
  const names = ['alpha', 'beta', 'gamma'];
  for (let k = 0; k < 3; k++) {
    const pp = add(m.atoms[prev].p, [1.45, -0.5 * (k % 2 ? -1 : 1), 0]);
    const P = m.a(15, pp, `${names[k]} phosphate`, k === 2);
    m.b(prev, P);
    for (const d of k === 2 ? [[0, 1.4, 0.4], [0, -0.6, 1.3], [0.9, -0.5, -1.0]] as V3[] : [[0, 1.3 * (k % 2 ? -1 : 1), 0.5], [0, -0.3, -1.45]] as V3[]) m.b(P, m.a(8, add(pp, d), `${names[k]} phosphate oxygen`, k === 2));
    if (k < 2) { prev = m.a(8, add(pp, [1.4, -0.4 * (k % 2 ? -1 : 1), 0]), 'bridging oxygen (the high-energy bond)'); m.b(P, prev); }
  }
  m.a(12, add(m.atoms[prev].p, [0.8, 2.0, 1.4]), 'magnesium ion (holds the phosphates)');
}

function glutamate(m: B): void {
  const pts: V3[] = [[0, 0, 0], [1.25, 0.75, 0], [2.5, 0, 0], [3.75, 0.75, 0]];
  const ids = pts.map((p, k) => m.a(6, p, ['alpha carbon', 'side chain carbon', 'side chain carbon', 'side chain carboxyl carbon'][k]));
  m.chain(...ids);
  const n = m.a(7, [-0.2, -1.45, 0], 'amino nitrogen (NH₃⁺)'); m.b(ids[0], n);
  const c1 = m.a(6, [-1.25, 0.75, 0], 'carboxyl carbon'); m.b(ids[0], c1);
  m.b(c1, m.a(8, [-2.35, 0.2, 0], 'carboxylate oxygen')); m.b(c1, m.a(8, [-1.2, 2.0, 0], 'carboxylate oxygen'));
  m.b(ids[3], m.a(8, [4.4, -0.35, 0.1], 'side chain carboxylate oxygen')); m.b(ids[3], m.a(8, [4.6, 1.75, 0], 'side chain carboxylate oxygen'));
}

function glucose(m: B): void {
  // β-D-glucopyranose chair: ring atoms alternate up and down, every substituent equatorial
  const ring = Array.from({ length: 6 }, (_, k) => m.a(k === 5 ? 8 : 6, cyl(1.45, k * 60 * D, k % 2 ? 0.25 : -0.25), k === 5 ? 'ring oxygen (O5)' : `ring carbon (C${k + 1})`));
  m.ring(ring);
  for (let k = 0; k < 4; k++) m.b(ring[k], m.a(8, cyl(2.85, k * 60 * D, k % 2 ? 0.55 : -0.55), `hydroxyl oxygen (O${k + 1})`));
  const c6 = m.a(6, cyl(2.95, 4 * 60 * D, 0.6), 'carbon C6'); m.b(ring[4], c6);
  m.b(c6, m.a(8, cyl(3.6, 4 * 60 * D + 0.35, 1.7), 'hydroxyl oxygen (O6)'));
}

function dhi(m: B): void {
  // 5,6-dihydroxyindole: a benzene ring fused to a pyrrole, two hydroxyls on the benzene side
  const c5 = [0, 0], c6 = [2.175, 0];
  const at5 = (d: number): V3 => [c5[0] + 1.2 * Math.cos(d * D), c5[1] + 1.2 * Math.sin(d * D), 0];
  const at6 = (d: number): V3 => [c6[0] + 1.39 * Math.cos(d * D), c6[1] + 1.39 * Math.sin(d * D), 0];
  const N1 = m.a(7, at5(252), 'indole nitrogen (N1)'), C2 = m.a(6, at5(180), 'pyrrole carbon (C2)'), C3 = m.a(6, at5(108), 'pyrrole carbon (C3)');
  const C3a = m.a(6, at6(150), 'ring fusion carbon'), C4 = m.a(6, at6(90), 'benzene carbon (C4)'), C5 = m.a(6, at6(30), 'benzene carbon (C5)');
  const C6 = m.a(6, at6(330), 'benzene carbon (C6)'), C7 = m.a(6, at6(270), 'benzene carbon (C7)'), C7a = m.a(6, at6(210), 'ring fusion carbon');
  m.ring([N1, C2, C3, C3a, C7a]); m.ring([C3a, C4, C5, C6, C7, C7a]);
  m.b(C5, m.a(8, add(m.atoms[C5].p, [1.15, 0.65, 0]), 'hydroxyl oxygen (5-OH)')); m.b(C6, m.a(8, add(m.atoms[C6].p, [1.15, -0.65, 0]), 'hydroxyl oxygen (6-OH)'));
}

function gas(m: B, seed: number, dense: boolean): void {
  const r = rnd(seed);
  const o1 = m.a(8, [-0.604, 0, 0], 'oxygen of O₂'), o2 = m.a(8, [0.604, 0, 0], 'oxygen of O₂'); m.b(o1, o2);
  const n = dense ? 70 : 40, R = dense ? 13 : 22;
  for (let k = 0; k < n; k++) {
    m.mol = k;
    let p: V3;
    do { p = [(r() * 2 - 1) * R, (r() * 2 - 1) * R, (r() * 2 - 1) * R]; } while (len(p) < 4 || len(p) > R);
    const d = norm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const kind = dense ? (r() < 0.9 ? 'O2' : 'CO2') : (r() < 0.75 ? 'N2' : r() < 0.85 ? 'O2' : r() < 0.95 ? 'CO2' : 'H2O');
    if (kind === 'N2') { const a = m.a(7, add(p, mul(d, -0.549)), 'nitrogen of N₂'), b = m.a(7, add(p, mul(d, 0.549)), 'nitrogen of N₂'); m.b(a, b); }
    else if (kind === 'O2') { const a = m.a(8, add(p, mul(d, -0.604)), 'oxygen of O₂'), b = m.a(8, add(p, mul(d, 0.604)), 'oxygen of O₂'); m.b(a, b); }
    else if (kind === 'CO2') { const c = m.a(6, p, 'carbon of CO₂'), a = m.a(8, add(p, mul(d, -1.16)), 'oxygen of CO₂'), b = m.a(8, add(p, mul(d, 1.16)), 'oxygen of CO₂'); m.b(c, a); m.b(c, b); }
    else water(m, p, r() * 6, r() * 6);
  }
  m.mol = -1;
}

// ---------------------------------------------------------------- what each organelle's molecule is

const SEQ_MYOSIN = 'LEEKLRKAEERAKELEQQ', SEQ_KERATIN = 'LNDRLASYLEKVRQLEQE', SEQ_GENERIC = 'MAELKKALEEAIRQLSKE', SEQ_COLLAGEN = 'GPOGPOGPAGPOGPOGPA', SEQ_FLAG = 'AQVINTNSLSLLTQNNLN';

/** The molecule an organelle is built around, for this person (their DNA letters, their edit). */
export function moleculeFor(org: Organelle, plan: CellPlan, sp: Specimen): Molecule {
  const m = new B();
  const seed = Math.floor(pidHash(sp.pid, 7) * 1e6);
  let name = '', formula = '', lede = '', envName = 'water', why: string | undefined;
  let facts: F3[] = [], hHidden = true;
  switch (org.mol) {
    case 'water': {
      water(m, [0, 0, 0], 0.3, 0.2, 'oxygen of water');
      solvate(m, 11, seed, 140);
      name = 'Water'; formula = 'H₂O'; hHidden = false;
      lede = 'One water molecule among its neighbours, each tugging on the next through hydrogen bonds that break and re-form every few picoseconds.';
      facts = [['Molar mass', '18.015 g/mol', 'R'], ['O–H bond', '0.0957 nm', 'R'], ['H–O–H angle', '104.5°', 'R'], ['Share of an adult body', 'about 50 to 65% by mass', 'R'], ['Water molecules in this body', `about ${fmtSci(sp.massKg * 0.6 * 3.34e25)}`, 'E']];
      envName = org.shape === 'channels' ? 'coolant water' : 'water';
      break;
    }
    case 'dna': {
      const g = org.gene!;
      const r = rnd(seed + 11);
      const seq = Array.from({ length: 12 }, () => 'ATGC'[Math.floor(r() * 4)]).join('');
      const hl0 = g.edited ? (g.insert ? 3 : 6) : 99, hl1 = g.edited ? (g.insert ? 8 : 6) : -1;
      const s2 = g.edited && !g.insert ? seq.slice(0, 6) + 'G' + seq.slice(7) : seq;
      dna(m, s2, hl0, hl1);
      solvate(m, 22, seed, 120);
      name = `DNA: the ${g.name} gene`; formula = `12 base pairs of ${g.chrom}`;
      lede = g.edited ? `${g.does}` : `A stretch of ${g.name} on ${g.chrom}: ${g.does}.`;
      facts = [['Shape', 'B-form double helix, 2 nm wide, a turn every 10.5 base pairs', 'R'], ['Rise per base pair', '0.34 nm', 'R'], ['Letters shown', `${s2} / ${[...s2].map((b) => PAIR[b]).join('')}`, 'P'], ['Mass per base pair', 'about 650 daltons', 'R'], ['Atom positions', 'schematic: real helix dimensions, idealised atoms; hydrogens hidden', 'E']];
      if (g.edited) facts.push(['Edit', g.insert ? 'an inserted gene (highlighted)' : 'one A·T pair turned to G·C (highlighted), as an adenine base editor does', 'P'], ['The science', g.editFact!, 'R']);
      why = g.edited ? `This person carries the edit ${g.insert ? 'in every cell' : 'in cells like this one'}: ${g.editWhat}` : undefined;
      break;
    }
    case 'bilayer': {
      const r = rnd(seed + 3);
      let k = 0;
      for (const flip of [1, -1]) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        m.mol = flip === 1 && i === 0 && j === 0 ? -1 : k++;
        lipid(m, [i * 8.1 + (r() - 0.5), j * 8.1 + (r() - 0.5), flip * 25 + (r() - 0.5) * 1.5], flip, r() * 6.28, r);
      }
      m.mol = -1;
      name = 'Phospholipid (POPC)'; formula = 'C₄₂H₈₂NO₈P';
      lede = 'One lipid of the membrane: a water-loving head of choline and phosphate, two oily tails that hide from water in the middle of the bilayer.';
      facts = [['Molar mass', '760.1 g/mol', 'R'], ['Area per lipid', 'about 0.65 nm²', 'R'], ['Bilayer thickness', 'about 4 nm, phosphate to phosphate', 'R'], ['Lipids per µm² of one layer', 'about 1.5 million', 'E'], ['Tails', 'palmitoyl (16 carbons, straight) and oleoyl (18, kinked by a cis double bond)', 'R'], ['Hydrogens', 'hidden', 'E']];
      envName = 'other lipids of the bilayer';
      break;
    }
    case 'helix': {
      const s = org.shape;
      if (s === 'collagen') {
        for (let k = 0; k < 3; k++) { m.mol = k === 0 ? -1 : k; helix(m, 18, { perTurn: 3.33, rise: 2.9, r: 1.6, at: cyl(2.6, k * 120 * D, 0), phase: k * 2, seq: SEQ_COLLAGEN, label: `chain ${k + 1}`, hb: false, twist: 0.04 }); }
        m.mol = -1;
        name = 'Collagen triple helix'; formula = '(Gly–Pro–Hyp)ₙ chains';
        lede = 'Three chains wound into a rope; every third residue is glycine, small enough to sit at the centre.';
        facts = [['Molecule', 'about 300 nm long, 1.5 nm wide', 'R'], ['Repeat', 'glycine–X–Y, often proline and hydroxyproline', 'R'], ['Each chain', 'a left-handed polyproline helix, 3.3 residues a turn', 'R'], ['Hydroxyproline needs', 'vitamin C to make; without it, scurvy', 'R']];
        envName = 'the other two chains';
      } else if (s === 'myofibrils' || s === 'keratin') {
        const seq = s === 'keratin' ? SEQ_KERATIN : SEQ_MYOSIN;
        for (let k = 0; k < 2; k++) { m.mol = k === 0 ? -1 : 0; helix(m, 20, { perTurn: 3.6, rise: 1.5, r: 2.3, at: cyl(4.9, k * Math.PI, 0), phase: k * 3, seq, label: k ? 'partner helix' : 'this helix', hb: true, twist: 0.035 }); }
        m.mol = -1;
        name = s === 'keratin' ? 'Keratin coiled coil' : 'Myosin tail (coiled coil)'; formula = 'two α-helices';
        lede = s === 'keratin' ? 'Two keratin α-helices wound round each other: the unit of skin\'s, hair\'s and nails\' toughness.' : 'Two myosin α-helices wound into the tail of the motor that pulls actin: the molecular origin of every movement.';
        facts = [['α-helix', '3.6 residues a turn, 0.15 nm rise per residue (Pauling 1951)', 'R'], ['Held by', 'hydrogen bonds from each C=O to the N–H four residues on', 'R'], ['Coiled coil', 'a repeat of seven, with oily residues at positions a and d', 'R'], ['Sequence shown', seq, 'P']];
        if (s === 'myofibrils') facts.push(['Myosin step', 'about 5 to 10 nm per ATP', 'R']);
        envName = 'the partner helix';
      } else {
        helix(m, 18, { perTurn: 3.6, rise: 1.5, r: 2.3, at: [0, 0, 0], phase: 0, seq: s === 'flagellum' ? SEQ_FLAG : SEQ_GENERIC, label: 'helix', hb: true });
        solvate(m, 13, seed, 90);
        name = s === 'flagellum' ? 'Flagellin helix' : s === 'cytoskeleton' ? 'Tubulin helix' : s === 'microvilli' ? 'Actin-binding helix' : 'A new protein';
        formula = 'an α-helix of 18 amino acids';
        lede = s === 'ribosomes' || s === 'er' ? 'A stretch of protein just made by a ribosome, folded into the commonest shape in biology: the α-helix.' : 'An α-helix from one of this cell\'s structural proteins.';
        facts = [['α-helix', '3.6 residues a turn, 0.15 nm rise per residue (Pauling 1951)', 'R'], ['Held by', 'hydrogen bonds from each C=O to the N–H four residues on', 'R'], ['Side chains', 'shown only to their first carbon (Cβ)', 'E'], ['Hydrogens', 'hidden', 'E']];
      }
      break;
    }
    case 'heme':
      heme(m); solvate(m, 14, seed, 70);
      name = 'Heme (in haemoglobin)'; formula = 'C₃₄H₃₂FeN₄O₄';
      lede = 'The iron-holding ring inside haemoglobin, here carrying one oxygen molecule from the lungs. The iron is what makes blood red.';
      facts = [['Molar mass', '616.5 g/mol', 'R'], ['Iron–nitrogen bonds', 'about 0.20 nm', 'R'], ['Ring', 'a porphyrin: four pyrroles joined by bridging carbons', 'R'], ['Heme groups per haemoglobin', '4', 'R'], ['Hydrogens', 'hidden', 'E']];
      envName = 'water (in a real cell, the surrounding protein)';
      break;
    case 'apatite':
      apatite(m);
      name = 'Hydroxyapatite'; formula = 'Ca₁₀(PO₄)₆(OH)₂';
      lede = 'The mineral of bone and teeth: calcium and phosphate in a hexagonal crystal, with hydroxide ions threaded down its channels.';
      facts = [['Crystal system', 'hexagonal, space group P6₃/m', 'R'], ['Unit cell', 'a = 0.9418 nm, c = 0.6884 nm', 'R'], ['Molar mass', '1,004.6 g/mol', 'R'], ['Hardness', '5 on the Mohs scale', 'R'], ['Shown', '2 × 2 × 2 unit cells from the real atomic sites', 'R']];
      if (sp.bone < 0.95) facts.push(['In this skeleton', `about ${Math.round(sp.bone * 100)}% of an Earth adult's mineral density, from ${sp.env.g.toFixed(2)} g`, 'P']);
      envName = '';
      break;
    case 'diamond':
      gear(m);
      name = org.shape === 'electrode' ? 'Diamond-like carbon' : 'Diamondoid gear'; formula = 'C (diamond lattice)';
      lede = org.shape === 'electrode' ? 'The thread\'s coating: carbon in the diamond lattice, inert in the brain.' : 'A part of a nanomachine: a gear cut from the diamond lattice, its teeth a few atoms wide.';
      facts = [['Lattice', 'diamond cubic, 0.3567 nm cube edge', 'R'], ['C–C bond', '0.154 nm', 'R'], ['Density', '3.51 g/cm³', 'R'], ['Gear design', 'after machine-phase parts in Drexler\'s Nanosystems (1992); built here', 'P'], ['Surface hydrogens', 'hidden', 'E']];
      envName = '';
      break;
    case 'nvdiamond':
      nvDiamond(m);
      name = 'Diamond with an NV centre'; formula = 'C with one N and one vacancy';
      lede = 'Pure diamond with one flaw put there on purpose: a nitrogen atom beside an empty site, whose electron spin stores information.';
      facts = [['Lattice', 'diamond cubic, 0.3567 nm cube edge', 'R'], ['NV centre', 'nitrogen beside a vacancy; read out by its red fluorescence', 'R'], ['Spin coherence', 'over a second when cooled (2018 record about 1.6 s)', 'R']];
      envName = '';
      break;
    case 'silicon':
      silicon(m);
      name = 'Silicon crystal, doped'; formula = 'Si with one P';
      lede = 'The diamond lattice of silicon, with one phosphorus atom in place of a silicon: the spare electron it brings is what lets a transistor switch.';
      facts = [['Lattice', 'diamond cubic, 0.5431 nm cube edge', 'R'], ['Si–Si bond', '0.235 nm', 'R'], ['Band gap', '1.12 eV at 300 K', 'R'], ['Density', '2.33 g/cm³', 'R']];
      envName = '';
      break;
    case 'copper':
      copper(m);
      name = 'Copper metal'; formula = 'Cu (face-centred cubic)';
      lede = 'Copper atoms packed face-centred cubic, their outer electrons shared as a sea that carries current.';
      facts = [['Lattice', 'face-centred cubic, 0.3615 nm cube edge', 'R'], ['Nearest neighbours', '12, 0.256 nm apart', 'R'], ['Density', '8.96 g/cm³', 'R'], ['Sticks', 'metallic bonding drawn as sticks between neighbours', 'E']];
      envName = '';
      break;
    case 'nanotube':
      nanotube(m);
      name = 'Carbon nanotube (10,10)'; formula = 'C (rolled graphene)';
      lede = 'A sheet of graphene rolled into a seamless tube: in this direction of rolling it conducts like a metal.';
      facts = [['Diameter', '1.36 nm', 'R'], ['C–C bond', '0.142 nm', 'R'], ['Tensile strength measured', 'up to about 63 GPa (Yu et al. 2000)', 'R'], ['Discovered', 'by Sumio Iijima, 1991', 'R']];
      envName = '';
      break;
    case 'pe':
      polyethylene(m); hHidden = false;
      name = 'Polyethylene'; formula = '(C₂H₄)ₙ';
      lede = 'Chains of carbon, each wearing two hydrogens: the lightest practical shield against cosmic rays.';
      facts = [['Crystal', 'orthorhombic, a = 0.742 nm, b = 0.495 nm', 'R'], ['Hydrogen by mass', 'about 14%', 'R'], ['Density', '0.91 to 0.97 g/cm³', 'R']];
      envName = 'neighbouring chains';
      break;
    case 'atp':
      atp(m); solvate(m, 14, seed, 90);
      name = 'ATP'; formula = 'C₁₀H₁₆N₅O₁₃P₃';
      lede = 'Adenosine triphosphate, the cell\'s energy coin: breaking off the last phosphate releases energy that drives almost everything a cell does.';
      facts = [['Molar mass', '507.2 g/mol', 'R'], ['Energy released (to ADP)', 'about 30.5 kJ/mol under standard conditions, more in a cell', 'R'], ['Times each ATP is recycled', 'about 1,000 to 1,500 a day', 'E'], ['Made by', 'ATP synthase, a rotary motor in the mitochondrial membrane', 'R'], ['Hydrogens', 'hidden', 'E']];
      break;
    case 'glutamate':
      glutamate(m); solvate(m, 11, seed, 70);
      name = 'Glutamate'; formula = 'C₅H₈NO₄⁻';
      lede = 'The brain\'s main "go" signal: released at a synapse, it opens channels in the next neuron.';
      facts = [['Molar mass', '146.1 g/mol (ion)', 'R'], ['Role', 'the most common excitatory neurotransmitter', 'R'], ['Also', 'the taste of umami, named by Kikunae Ikeda in 1908', 'R'], ['Hydrogens', 'hidden', 'E']];
      break;
    case 'glucose':
      glucose(m); solvate(m, 11, seed, 70);
      name = 'Glucose'; formula = 'C₆H₁₂O₆';
      lede = org.shape === 'golgi' ? 'A sugar of the kind the Golgi strings onto proteins.' : 'One glucose unit of the cell\'s sugar store, in its chair-shaped ring.';
      facts = [['Molar mass', '180.16 g/mol', 'R'], ['Shape', 'β-D-glucopyranose: a chair, every hydroxyl pointing outward', 'R'], ['In an adult\'s blood', 'about 4 to 5 g in all', 'R'], ['Hydrogens', 'hidden', 'E']];
      break;
    case 'dhi':
      dhi(m); solvate(m, 11, seed, 70);
      name = 'DHI (a melanin unit)'; formula = 'C₈H₇NO₂';
      lede = '5,6-dihydroxyindole: one of the building blocks melanocytes polymerise into black-brown eumelanin.';
      facts = [['Molar mass', '149.15 g/mol', 'R'], ['Melanin', 'absorbs ultraviolet and turns more than 99.9% of it to heat', 'R'], ['Hydrogens', 'hidden', 'E']];
      break;
    case 'o2': {
      const dense = org.shape === 'tank';
      gas(m, seed, dense); hHidden = false;
      name = 'Oxygen, O₂'; formula = 'O₂';
      lede = dense ? 'Oxygen packed at a thousand atmospheres inside the nanomachine, almost as dense as liquid.' : 'One oxygen molecule in the air sac, with nitrogen, carbon dioxide and water vapour around it, drawn far closer together than in real air.';
      facts = [['O=O bond', '0.121 nm', 'R'], ['Molar mass', '32.00 g/mol', 'R'], ['Magnetism', 'paramagnetic: two unpaired electrons, so liquid oxygen sticks to a magnet', 'R'], ['Spacing in air at 1 atm', 'about 3.3 nm between molecules', 'R']];
      envName = dense ? 'oxygen and carbon dioxide' : 'air: nitrogen, oxygen, carbon dioxide, water';
      break;
    }
  }
  return { id: org.mol, name, formula, lede, facts, atoms: m.atoms, bonds: m.bonds, hbonds: m.hbonds, envName, hHidden, why };
}

/** Molar mass of the drawn subject's heavy atoms (for consistency checks). */
export function subjectCount(mol: Molecule): number { return mol.atoms.filter((a) => a.mol < 0).length; }
