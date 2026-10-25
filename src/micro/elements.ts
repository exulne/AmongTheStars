// The elements a body (or a computronium substrate) is built from: real
// values for each, and the electron configuration that shapes its clouds.

export interface Element {
  Z: number; sym: string; name: string;
  mass: number;        // standard atomic weight, u
  N: number;           // neutrons in the most common isotope
  iso: string;         // that isotope and its share, e.g. "carbon-12, 98.9%"
  cov: number;         // covalent radius, pm (Cordero et al. 2008)
  en: number | null;   // Pauling electronegativity
  color: number;       // CPK / Jmol colour
  body: string;        // share of a human body by mass, or "trace"
  fact: string;        // one true sentence
}

export const ELEMENTS: Record<number, Element> = {
  1: { Z: 1, sym: 'H', name: 'hydrogen', mass: 1.008, N: 0, iso: 'hydrogen-1 (protium), 99.98%', cov: 31, en: 2.2, color: 0xffffff, body: 'about 10% by mass, 62% of all atoms', fact: 'Most of the atoms in a body are hydrogen, and nearly all of it is older than the stars: made in the first minutes after the Big Bang.' },
  2: { Z: 2, sym: 'He', name: 'helium', mass: 4.0026, N: 2, iso: 'helium-4, 99.9998%', cov: 28, en: null, color: 0xd9ffff, body: 'none', fact: 'Its two electrons fill the first shell completely, so it bonds with nothing.' },
  5: { Z: 5, sym: 'B', name: 'boron', mass: 10.81, N: 6, iso: 'boron-11, 80.1%', cov: 84, en: 2.04, color: 0xffb5b5, body: 'trace', fact: 'In silicon, a boron atom takes one electron too few into the lattice and leaves a "hole" that carries current: p-type doping.' },
  6: { Z: 6, sym: 'C', name: 'carbon', mass: 12.011, N: 6, iso: 'carbon-12, 98.9%', cov: 76, en: 2.55, color: 0x909090, body: 'about 18.5% by mass', fact: 'Every carbon atom in a body was fused from three helium nuclei inside a star (the triple-alpha process) and scattered when it died.' },
  7: { Z: 7, sym: 'N', name: 'nitrogen', mass: 14.007, N: 7, iso: 'nitrogen-14, 99.6%', cov: 71, en: 3.04, color: 0x3050f8, body: 'about 3.2% by mass', fact: 'Every amino acid and every DNA base carries nitrogen; most of a body\'s comes from protein in food.' },
  8: { Z: 8, sym: 'O', name: 'oxygen', mass: 15.999, N: 8, iso: 'oxygen-16, 99.76%', cov: 66, en: 3.44, color: 0xff0d0d, body: 'about 65% by mass', fact: 'Oxygen is most of a body by weight, mostly locked in water; it pulls electrons harder than any element here but fluorine.' },
  11: { Z: 11, sym: 'Na', name: 'sodium', mass: 22.99, N: 12, iso: 'sodium-23, 100%', cov: 166, en: 0.93, color: 0xab5cf2, body: 'about 0.15% by mass', fact: 'Nerves fire by letting sodium ions rush into the cell; each neuron spends much of its energy pumping them back out.' },
  12: { Z: 12, sym: 'Mg', name: 'magnesium', mass: 24.305, N: 12, iso: 'magnesium-24, 79%', cov: 141, en: 1.31, color: 0x8aff00, body: 'about 0.05% by mass', fact: 'Almost every ATP molecule in a cell is held by a magnesium ion; the enzymes that use ATP need it.' },
  14: { Z: 14, sym: 'Si', name: 'silicon', mass: 28.085, N: 14, iso: 'silicon-28, 92.2%', cov: 111, en: 1.9, color: 0xf0c8a0, body: 'trace', fact: 'It crystallises in the diamond structure, each atom bonded to four neighbours 0.235 nm away: the lattice of every computer chip.' },
  15: { Z: 15, sym: 'P', name: 'phosphorus', mass: 30.974, N: 16, iso: 'phosphorus-31, 100%', cov: 107, en: 2.19, color: 0xff8000, body: 'about 1% by mass', fact: 'Phosphate links every DNA strand, carries the cell\'s energy in ATP and, as apatite, makes bone hard.' },
  16: { Z: 16, sym: 'S', name: 'sulfur', mass: 32.06, N: 16, iso: 'sulfur-32, 95%', cov: 105, en: 2.58, color: 0xffff30, body: 'about 0.25% by mass', fact: 'Sulfur bridges between cysteines hold proteins in shape; hair and nails are rich in them.' },
  17: { Z: 17, sym: 'Cl', name: 'chlorine', mass: 35.45, N: 18, iso: 'chlorine-35, 76%', cov: 102, en: 3.16, color: 0x1ff01f, body: 'about 0.15% by mass', fact: 'Chloride is the main negative ion outside cells and, as hydrochloric acid, the acid of the stomach.' },
  19: { Z: 19, sym: 'K', name: 'potassium', mass: 39.098, N: 20, iso: 'potassium-39, 93.3%', cov: 203, en: 0.82, color: 0x8f40d4, body: 'about 0.4% by mass', fact: 'One potassium atom in 8,500 is radioactive potassium-40: a 70 kg body hosts about 4,000 of its decays every second.' },
  20: { Z: 20, sym: 'Ca', name: 'calcium', mass: 40.078, N: 20, iso: 'calcium-40, 96.9%', cov: 176, en: 1.0, color: 0x3dff00, body: 'about 1.5% by mass', fact: '99% of a body\'s calcium is in bones and teeth; the last 1% makes muscles contract and hearts beat.' },
  26: { Z: 26, sym: 'Fe', name: 'iron', mass: 55.845, N: 30, iso: 'iron-56, 91.8%', cov: 132, en: 1.83, color: 0xe06633, body: 'about 0.006% by mass, some 4 g', fact: 'Iron-56 is close to the most tightly bound nucleus there is: stars fuse up to iron and no further. Two-thirds of a body\'s iron is in haemoglobin.' },
  29: { Z: 29, sym: 'Cu', name: 'copper', mass: 63.546, N: 34, iso: 'copper-63, 69.2%', cov: 132, en: 1.9, color: 0xc88033, body: 'about 0.0001% by mass', fact: 'Its one outer 4s electron moves freely through the metal, which is why copper conducts so well.' },
};

export const elem = (Z: number): Element => ELEMENTS[Z] ?? ELEMENTS[6];

// ---------------------------------------------------------------- electron configuration

export interface Subshell { n: number; l: number; e: number; zeff: number }
const L = 'spdf';
export const subName = (s: { n: number; l: number }) => `${s.n}${L[s.l]}`;
const ORDER: [number, number][] = [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [3, 2], [4, 1], [5, 0], [4, 2], [5, 1]];

/** Ground-state configuration by the Aufbau order (copper's real exception included), with Slater's effective nuclear charge. */
export function configuration(Z: number): Subshell[] {
  const out: Subshell[] = [];
  let left = Z;
  for (const [n, l] of ORDER) {
    if (left <= 0) break;
    const e = Math.min(left, 2 * (2 * l + 1));
    out.push({ n, l, e, zeff: 0 });
    left -= e;
  }
  if (Z === 29) { // [Ar] 3d10 4s1: a full d shell is worth one 4s electron
    const s4 = out.find((s) => s.n === 4 && s.l === 0)!, d3 = out.find((s) => s.n === 3 && s.l === 2)!;
    s4.e = 1; d3.e = 10;
  }
  for (const s of out) s.zeff = Z - slaterShield(out, s);
  return out.sort((a, b) => a.n - b.n || a.l - b.l);
}

/** Slater (1930): screening of one electron by the others, by groups (1s)(2s2p)(3s3p)(3d)(4s4p)(4d)... */
function slaterShield(cfg: Subshell[], me: Subshell): number {
  const group = (s: { n: number; l: number }) => s.n * 10 + (s.l >= 2 ? 5 : 0); // d sits in its own group, after s,p of the same n
  const g = group(me);
  let S = 0;
  for (const o of cfg) {
    const og = group(o);
    const count = o === me ? o.e - 1 : o.e;
    if (count <= 0) continue;
    if (og === g) S += count * (me.n === 1 ? 0.3 : 0.35);
    else if (og > g) continue;
    else if (me.l >= 2) S += count; // d electrons: everything inside screens fully
    else if (o.n === me.n - 1) S += count * 0.85;
    else if (o.n < me.n - 1) S += count;
    else S += count; // same n but an inner group (d inside s,p of the same n can't happen for s/p)
  }
  return S;
}

export const A0 = 0.529177; // Bohr radius, Å
/** Mean radius of a hydrogen-like orbital with charge Zeff, in Å: a0/Z × (3n² − l(l+1))/2. */
export function meanRadius(s: Subshell): number { return (A0 / Math.max(0.5, s.zeff)) * (3 * s.n * s.n - s.l * (s.l + 1)) / 2; }

export function configString(cfg: Subshell[]): string {
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  return cfg.map((s) => `${subName(s)}${String(s.e).replace(/\d/g, (d) => SUP[Number(d)])}`).join(' ');
}

/** Real orbital names in a subshell, and how many electrons each holds by Hund's rule (singly first, then paired). */
export function orbitalFill(l: number, e: number): { name: string; e: number }[] {
  const names = l === 0 ? ['s'] : l === 1 ? ['px', 'py', 'pz'] : ['dxy', 'dxz', 'dyz', 'dx²−y²', 'dz²'];
  const k = names.length;
  return names.map((name, i) => ({ name, e: (i < e ? 1 : 0) + (i < e - k ? 1 : 0) }));
}

/** Probability density of a real orbital's angular part along unit direction (x, y, z), scaled so its maximum is 1. */
export function angular(name: string, x: number, y: number, z: number): number {
  switch (name) {
    case 's': return 1;
    case 'px': return x * x;
    case 'py': return y * y;
    case 'pz': return z * z;
    case 'dxy': return 4 * x * x * y * y;
    case 'dxz': return 4 * x * x * z * z;
    case 'dyz': return 4 * y * y * z * z;
    case 'dx²−y²': return (x * x - y * y) ** 2;
    default: return ((3 * z * z - 1) / 2) ** 2; // dz²
  }
}

/** Hydrogen-like radial probability r²R(r)² at radius r (Å), unnormalised. */
export function radialDensity(n: number, l: number, Z: number, r: number): number {
  const rho = (2 * Z * r) / (n * A0);
  // associated Laguerre L_{n-l-1}^{2l+1}(rho) by recurrence
  const k = n - l - 1, a = 2 * l + 1;
  let L0 = 1, L1 = 1 + a - rho;
  let Lk = k === 0 ? L0 : L1;
  for (let j = 1; j < k; j++) { const L2 = ((2 * j + 1 + a - rho) * L1 - (j + a) * L0) / (j + 1); L0 = L1; L1 = L2; Lk = L2; }
  const R = Math.pow(rho, l) * Math.exp(-rho / 2) * Lk;
  return r * r * R * R;
}
