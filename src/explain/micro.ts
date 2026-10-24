// Cards for everything below a person: the parts of their body (or the
// substrate of an uploaded mind), the cells and organelles of each tissue,
// the molecule inside, each atom of it, and the atom's nucleus and electron
// subshells. Textbook values are tagged R, values worked out from them for
// this person E, and what this future's generator chose P.

import type { CellPlan, F3 } from '../micro/cells.ts';
import { configString, configuration, elem, meanRadius, orbitalFill, subName, type Subshell } from '../micro/elements.ts';
import type { Molecule } from '../micro/molecules.ts';
import { RAD_TEXT, type PartId, type Specimen } from '../micro/specimen.ts';
import { fmtNum, fmtSci, fmtYear } from '../ui/format.ts';
import type { Explanation, Fact } from './registry.ts';

const f = (k: string, v: string, t: Fact['t']): Fact => ({ k, v, t });
const facts = (xs: F3[]): Fact[] => xs.map(([k, v, t]) => f(k, v, t));

/** "6 µm (6.0 × 10⁻⁶ m)" */
export function metres(x: number): string {
  const units: [number, string][] = [[1, 'm'], [1e-3, 'mm'], [1e-6, 'µm'], [1e-9, 'nm'], [1e-12, 'pm'], [1e-15, 'fm']];
  const [u, name] = units.find(([u]) => x >= u * 0.999) ?? units[units.length - 1];
  const v = x / u;
  const s = v >= 100 ? String(Math.round(v)) : v.toPrecision(2).replace(/\.0$/, '');
  return name === 'm' ? `${s} m` : `${s} ${name} (${fmtSci(x)} m)`;
}

const scale = (sp: Specimen) => sp.massKg / 70;
const cnt = (x: number) => (x >= 1e12 ? `about ${(x / 1e12).toPrecision(2)} trillion` : x >= 1e9 ? `about ${(x / 1e9).toPrecision(2)} billion` : `about ${fmtNum(x)}`);

// ---------------------------------------------------------------- the body

interface PartInfo { name: string; eyebrow: string; lede: string; size: (sp: Specimen) => number; facts: (sp: Specimen) => Fact[]; why?: (sp: Specimen) => string | undefined }

const PARTS: Record<PartId, PartInfo> = {
  brain: { name: 'Brain', eyebrow: 'Organ', lede: 'Where this person is: about 86 billion neurons and as many glial cells, wired by some hundred trillion synapses.', size: () => 0.15, facts: (sp) => [f('Mass', 'about 1.3 to 1.4 kg in an adult', 'R'), f('Neurons', 'about 86 billion (Azevedo et al. 2009)', 'R'), f('Energy', 'about 20% of the body\'s at 2% of its mass: some 20 W', 'R'), f('Size', metres(0.15), 'R'), ...(sp.parts.includes('lace') ? [f('Interface', 'a brain-computer lace over the cortex', 'P')] : [])] },
  heart: { name: 'Heart', eyebrow: 'Organ', lede: 'A four-chambered muscle pump, beating here about 70 times a minute.', size: () => 0.12, facts: (sp) => [f('Mass', 'about 250 to 350 g', 'R'), f('Pumps at rest', 'about 5 litres a minute', 'R'), f('Beats a day', 'about 100,000', 'R'), f('Beats so far', cnt(sp.age * 365.25 * 24 * 60 * 70), 'E'), f('Size', metres(0.12), 'R')] },
  lungs: { name: 'Lungs', eyebrow: 'Organs', lede: 'Two spongy bags of some 480 million air sacs where oxygen meets blood.', size: () => 0.25, facts: (sp) => [f('Alveoli', 'about 480 million (Ochs et al. 2004)', 'R'), f('Breaths', '12 to 20 a minute at rest', 'R'), f('Air breathed a day', 'about 11,000 litres', 'R'), f('Air here', sp.env.kind === 'ship' ? 'the ship\'s, recycled' : sp.env.rad === 'sheltered' ? 'the world\'s own, or a habitat\'s' : 'a habitat\'s: outside would kill in minutes', 'P')] },
  liver: { name: 'Liver', eyebrow: 'Organ', lede: 'The body\'s chemical works: it makes blood proteins, stores sugar, breaks down toxins and can regrow from a quarter of itself.', size: () => 0.17, facts: () => [f('Mass', 'about 1.5 kg', 'R'), f('Hepatocytes', 'about 240 billion (Sender et al. 2016)', 'E'), f('Regrows from', 'as little as 25 to 30% of itself', 'R'), f('Size', metres(0.17), 'R')] },
  kidneys: { name: 'Kidneys', eyebrow: 'Organs', lede: 'Two fist-sized filters that clean the whole blood supply dozens of times a day.', size: () => 0.11, facts: () => [f('Each', 'about 150 g and 11 cm long', 'R'), f('Filtered a day', 'about 180 litres, of which about 1.5 leave as urine', 'R'), f('Nephrons', 'about a million per kidney', 'R'), f('Size', metres(0.11), 'R')] },
  gut: { name: 'Gut and microbiome', eyebrow: 'Organs', lede: 'Metres of intestine, and living in it more bacterial cells than the body has of its own.', size: () => 0.3, facts: (sp) => [f('Inner surface of the gut', 'about 32 m² (Helander and Fändriks 2014)', 'R'), f('Bacteria', `${cnt(3.8e13 * scale(sp))} (Sender et al. 2016, scaled to this body)`, 'E'), f('Their mass', `about ${(0.2 * scale(sp)).toFixed(2)} kg`, 'E'), f('Microbes brought from', sp.env.home < 0 ? 'the ship\'s farms and its people' : 'Earth, by every settler; this world\'s strains have drifted since', 'P')] },
  bone: { name: 'Skeleton', eyebrow: 'Organ system', lede: 'Living mineral that rebuilds itself to the loads it carries.', size: (sp) => sp.heightM, facts: (sp) => [
    f('Bones', '206 in an adult', 'R'), f('Share of body mass', 'about 15%', 'R'), f('Remodelled each year', 'about 10% of the skeleton', 'R'),
    f('Bone lost in weightlessness', '1 to 1.5% a month without countermeasures (NASA)', 'R'),
    f('Gravity here', `${sp.env.g.toFixed(2)} g`, sp.env.home === 0 ? 'R' : 'P'),
    f('Density vs. an Earth adult', `${Math.round(sp.bone * 100)}%${sp.adapted && sp.env.g < 0.7 ? ' (engineered to hold strength at low gravity)' : sp.bone < 0.97 ? ' (assumes bone settles near g^0.25 of Earth\'s; no one has lived long at low gravity yet)' : ''}`, 'P')],
    why: (sp) => (sp.edits.find((e) => e.gene === 'SOST')?.what) },
  muscle: { name: 'Muscles', eyebrow: 'Organ system', lede: 'Some 600 skeletal muscles, about two-fifths of the body\'s mass.', size: (sp) => sp.heightM, facts: (sp) => [f('Skeletal muscles', 'more than 600', 'R'), f('Share of body mass', 'about 40%', 'R'), f('This body\'s muscle', `about ${Math.round(sp.massKg * 0.4)} kg`, 'E'), f('Build', sp.slender < 0.95 ? 'slender, for low gravity' : sp.slender > 1.05 ? 'heavy, for high gravity' : 'Earth-like', 'P')], why: (sp) => sp.edits.find((e) => e.gene === 'MSTN')?.what },
  skin: { name: 'Skin', eyebrow: 'Organ', lede: 'The largest organ: a waterproof, self-renewing barrier against the world.', size: (sp) => sp.heightM, facts: (sp) => [f('Area', `about ${(0.2025 * Math.pow(sp.massKg, 0.425) * Math.pow(sp.heightM * 100, 0.725) / 100).toFixed(2)} m² (Du Bois formula for this body)`, 'E'), f('Renewal', 'the outer layer every 4 to 8 weeks', 'R'), f('Insulating fat', sp.fat > 1.2 ? 'thicker than an Earth body\'s, with extra brown fat' : 'as on Earth', 'P'), f('Radiation outside', RAD_TEXT[sp.env.rad].dose, RAD_TEXT[sp.env.rad].t)], why: (sp) => sp.edits.find((e) => e.gene === 'Dsup')?.what },
  blood: { name: 'Blood', eyebrow: 'Tissue', lede: 'About 7% of the body\'s mass, going round the whole body about once a minute.', size: (sp) => sp.heightM, facts: (sp) => [f('Volume', `about ${(sp.massKg * 0.07).toFixed(1)} litres`, 'E'), f('Red cells', `${cnt(2.5e13 * scale(sp))}`, 'E'), f('One circuit at rest', 'about a minute', 'R'), f('Haemoglobin per red cell', 'about 270 million molecules', 'R'), ...(sp.parts.includes('nano') ? [f('Also carries', 'respirocytes: artificial oxygen carriers', 'P')] : [])] },
  lace: { name: 'Neural lace', eyebrow: 'Implant', lede: 'A mesh of electrodes over the cortex that lets this person think to machines, and lets machines answer.', size: () => 0.16, facts: () => [f('First human implants', '2020s: 1,024 electrodes on 64 threads (Neuralink), and stent electrodes in a vein (Synchron)', 'R'), f('Here', 'a lace of many thousands of threads', 'P'), f('Thread width', metres(5e-6), 'R')] },
  nano: { name: 'Nanomachines in the blood', eyebrow: 'Implant', lede: 'Respirocytes and repair machines riding the bloodstream, built atom by atom.', size: () => 1e-6, facts: () => [f('Respirocyte design', 'Robert Freitas, 1998', 'R'), f('Size of each', metres(1e-6), 'E'), f('Oxygen carried vs. red cells', 'about 236 times per volume (design)', 'E'), f('A dose of them', 'could let a person hold their breath for hours (design claim)', 'E')] },
  core: { name: 'Processor stack', eyebrow: 'Substrate', lede: 'Where this mind now runs: layers of logic doing the work a brain\'s neurons did.', size: () => 0.4, facts: () => [f('Brain-equivalent computing', 'estimates run 10¹⁵ to 10¹⁸ operations a second', 'E'), f('A brain\'s power', 'about 20 W', 'R'), f('Least energy to erase a bit at 300 K', '2.9 × 10⁻²¹ J (Landauer)', 'R'), f('Height', metres(0.4), 'P')] },
  memory: { name: 'Memory lattice', eyebrow: 'Substrate', lede: 'Diamond seeded with spin defects, holding everything this person remembers.', size: () => 0.2, facts: () => [f('A brain\'s storage', 'estimates near a petabyte (from about 4.7 bits per synapse, Bartol et al. 2015)', 'E'), f('Medium here', 'NV-centre diamond', 'P')] },
  optic: { name: 'Optical interconnect', eyebrow: 'Substrate', lede: 'Light-guides between the stacks, the substrate\'s white matter.', size: () => 0.4, facts: () => [f('Light in silicon', 'about 0.29 of its speed in vacuum', 'E'), f('Axons, for comparison', 'up to about 120 m/s', 'R')] },
  cooling: { name: 'Cooling', eyebrow: 'Substrate', lede: 'Thinking makes heat; water in micro-channels carries it away.', size: () => 0.5, facts: () => [f('Microchannel cooling', '790 W/cm² shown in 1981 (Tuckerman and Pease)', 'R')] },
  power: { name: 'Power bus', eyebrow: 'Substrate', lede: 'Copper bars that feed the stacks.', size: () => 0.5, facts: () => [f('Copper resistivity', '1.68 × 10⁻⁸ Ω·m', 'R')] },
  shield: { name: 'Radiation shield', eyebrow: 'Substrate', lede: 'A hydrogen-rich case around the substrate against cosmic rays.', size: () => 0.6, facts: (sp) => [f('Best shield per kilogram', 'hydrogen-rich polymers', 'R'), f('Radiation outside', RAD_TEXT[sp.env.rad].dose, RAD_TEXT[sp.env.rad].t)] },
  avatar: { name: 'Self-model', eyebrow: 'Substrate', lede: 'The body this person still pictures themselves in: drawn from their last flesh height and build.', size: (sp) => sp.heightM, facts: (sp) => [f('Height they picture', `${(sp.heightM).toFixed(2)} m`, 'P'), f('Body schema', 'brains keep a map of the body; uploaded minds are assumed to keep theirs', 'E')] },
};

export function partName(p: PartId): string { return PARTS[p].name; }
export function partSize(sp: Specimen, p: PartId): number { return PARTS[p].size(sp); }

export function personFacts(sp: Specimen): Fact[] {
  return [
    f('Body', sp.bodyWord, 'P'),
    f('Height', `${sp.heightM.toFixed(2)} m`, 'P'),
    f('Mass', `about ${Math.round(sp.massKg)} kg`, 'E'),
    f('Weight here', sp.env.kind === 'ship' ? `as on a spinning ship at ${sp.env.g} g` : `like ${Math.round(sp.massKg * sp.env.g)} kg on Earth (${sp.env.g.toFixed(2)} g on ${sp.env.homeName})`, 'E'),
    f('Cells', `${cnt(3.0e13 * scale(sp))} human, ${cnt(3.8e13 * scale(sp))} bacterial (Sender et al. 2016, scaled)`, 'E'),
    f('Atoms', `about ${fmtSci(7e27 * scale(sp), 2)}`, 'E'),
  ];
}

export function partCard(sp: Specimen, p: PartId): Explanation {
  const info = PARTS[p];
  const rel = sp.edits.filter((e) => e.why === 'adapt');
  return {
    eyebrow: `${info.eyebrow} · ${sp.name}`, title: info.name, lede: info.lede,
    facts: [...info.facts(sp), ...(p === 'brain' || p === 'core' ? personFacts(sp).slice(0, 4) : [])],
    why: info.why?.(sp) ?? (rel.length && (p === 'skin' || p === 'bone' || p === 'muscle') ? `Adapted to ${sp.env.homeName}: ${rel.map((e) => e.gene).join(', ')}.` : undefined),
    links: [{ label: 'Look inside', act: 'enter', id: 0 }, { label: 'Their life', act: 'bio', id: 0 }],
  };
}

export function flowCard(sp: Specimen, nano: boolean, i: number): Explanation {
  return nano
    ? { eyebrow: `Nanomachine · ${sp.name}'s blood`, title: `Respirocyte ${i + 1}`, lede: 'An artificial oxygen carrier: a diamondoid tank of compressed oxygen with molecular pumps on its skin.', facts: [f('Size', metres(1e-6), 'E'), f('Design', 'Robert Freitas, 1998', 'R'), f('Pressure inside', 'about 1,000 atm (design)', 'E'), f('Drawn', 'far larger than life, a few among billions', 'P')], links: [{ label: 'Look inside', act: 'enter', id: 0 }] }
    : { eyebrow: `Blood cell · ${sp.name}'s blood`, title: `Red blood cell ${fmtNum(i + 1)}`, lede: 'One of the red cells going round; each lap of the body takes it about a minute.', facts: [f('Size', metres(7.8e-6), 'R'), f('Lifespan', 'about 120 days', 'R'), f('Laps of the body in a life', 'about 170,000', 'E'), f('Drawn', 'far larger than life, a few among trillions', 'P')], links: [{ label: 'Look inside', act: 'enter', id: 0 }] };
}

// ---------------------------------------------------------------- cells

export function cellCard(sp: Specimen, plan: CellPlan): Explanation {
  const t = plan.type;
  return { eyebrow: `${t.tissue} · ${sp.name}`, title: t.name, lede: t.lede, facts: [f('Size', metres(t.size), 'R'), ...facts(t.facts)], why: sp.form === 'substrate' ? `${sp.name} was uploaded; this is what holds their mind now.` : undefined, links: [{ label: 'Their life', act: 'bio', id: 0 }] };
}

export function orgCard(sp: Specimen, plan: CellPlan, i: number): Explanation {
  const o = plan.organelles[i];
  if (!o) return cellCard(sp, plan);
  const fx = facts(o.facts);
  if (o.count > 1) fx.push(f('Drawn in this cell', `${o.count >= 200 ? 'a sample of' : ''} ${o.count}`.trim(), 'P'));
  let why: string | undefined;
  if (o.gene) {
    fx.push(f('Gene shown inside', `${o.gene.name} (${o.gene.chrom})`, 'P'));
    if (o.gene.edited) why = `Edited: ${o.gene.editWhat}`;
  }
  if (o.shape === 'nanobots') why = `Here because molecular nanofabrication reached ${sp.env.homeName}.`;
  if (o.shape === 'electrode') why = `${sp.name} has a brain-computer interface.`;
  return { eyebrow: `In a ${plan.type.name.toLowerCase()} · ${sp.name}`, title: o.name, lede: o.lede, facts: fx, why, links: [{ label: 'Look inside', act: 'enter', id: 0 }] };
}

export function nbrCard(sp: Specimen, plan: CellPlan, i: number): Explanation {
  const t = plan.type;
  return { eyebrow: `${t.tissue} · ${sp.name}`, title: `Neighbouring ${t.name.toLowerCase()} ${i + 1}`, lede: `Another ${t.name.toLowerCase()} of the same tissue. ${t.lede}`, facts: [f('Size', metres(t.size), 'R'), ...facts(t.facts.slice(0, 2)), f('Placed', 'by this future\'s generator', 'P')] };
}

// ---------------------------------------------------------------- molecules and atoms

export function molCard(sp: Specimen, plan: CellPlan, m: Molecule): Explanation {
  const sub = m.atoms.filter((a) => a.mol < 0 && a.Z > 0);
  const ext = sizeOf(sub.map((a) => a.p));
  const tally = new Map<number, number>();
  for (const a of sub) tally.set(a.Z, (tally.get(a.Z) ?? 0) + 1);
  const drawn = [...tally].sort((a, b) => a[0] - b[0]).map(([Z, n]) => `${n} ${elem(Z).sym}`).join(', ');
  return {
    eyebrow: `Molecule in a ${plan.type.name.toLowerCase()} · ${sp.name}`, title: m.name, lede: m.lede,
    facts: [f(m.id === 'dna' ? 'What is drawn' : 'Formula', m.formula, m.id === 'dna' ? 'P' : 'R'), f('Size of what is drawn', metres(ext * 1e-10), 'E'), f('Atoms drawn', `${sub.length}: ${drawn}`, 'P'), ...facts(m.facts)],
    why: m.why,
  };
}

function sizeOf(ps: [number, number, number][]): number {
  if (!ps.length) return 0;
  let d = 0;
  const c = [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length);
  for (const p of ps) d = Math.max(d, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return Math.max(1, 2 * d);
}

export function atomInMolCard(sp: Specimen, m: Molecule, i: number): Explanation {
  const a = m.atoms[i];
  if (!a) return { eyebrow: 'Atom', title: 'Nothing here', lede: 'This atom is not drawn now.', facts: [f('Index', String(i), 'P')] };
  if (a.Z === 0) return { eyebrow: `Defect in ${m.name.toLowerCase()}`, title: 'Vacancy', lede: 'A site in the crystal where an atom should be and is not. Next to the nitrogen, it traps electrons whose spin can be set and read with light.', facts: [f('What is missing', 'one carbon atom', 'R'), f('Spacing it leaves', metres(1.545e-10), 'R')], why: 'The vacancy and its nitrogen together are one bit of this mind\'s memory.' };
  const e = elem(a.Z);
  const bonded = m.bonds.filter(([x, y]) => x === i || y === i).map(([x, y]) => m.atoms[x === i ? y : x]).filter((b) => b.Z > 0);
  const nb = new Map<string, number>();
  for (const b of bonded) nb.set(elem(b.Z).name, (nb.get(elem(b.Z).name) ?? 0) + 1);
  const env = a.mol >= 0;
  return {
    eyebrow: env ? `Atom in a neighbouring molecule (${m.envName})` : `Atom in ${m.name.toLowerCase()}`,
    title: `${e.name[0].toUpperCase()}${e.name.slice(1)} (${e.sym})`, lede: `${a.role[0].toUpperCase()}${a.role.slice(1)}${a.hl ? ', highlighted' : ''}.`,
    facts: [
      f('Atomic number', String(e.Z), 'R'), f('Atomic mass', `${e.mass} u`, 'R'),
      f('Bonded to', bonded.length ? [...nb].map(([k, n]) => `${n} ${k}`).join(', ') : 'nothing drawn', 'P'),
      f('Covalent radius', metres(e.cov * 1e-12), 'R'),
      ...(e.en !== null ? [f('Electronegativity (Pauling)', String(e.en), 'R')] : []),
      f('Share of a human body', e.body, 'R'),
    ],
    why: e.fact,
    links: [{ label: 'Look inside', act: 'enter', id: 0 }],
  };
}

/** The atom drawn at the atom level: which element, which isotope, where it sits. */
export interface AtomSpec { Z: number; N: number; role: string; molName: string; hl: boolean }

/** Binding energy per nucleon from the semi-empirical mass formula (Weizsäcker), MeV. */
export function bindingPerNucleon(Z: number, N: number): number {
  const A = Z + N;
  if (A < 2) return 0;
  const pair = Z % 2 === 0 && N % 2 === 0 ? 1 : Z % 2 === 1 && N % 2 === 1 ? -1 : 0;
  const B = 15.75 * A - 17.8 * A ** (2 / 3) - 0.711 * Z * (Z - 1) / A ** (1 / 3) - 23.7 * (N - Z) ** 2 / A + pair * 11.18 / Math.sqrt(A);
  return Math.max(0, B / A);
}

export const nuclearRadius = (A: number) => 1.2e-15 * Math.cbrt(A);

export function wholeAtomCard(sp: Specimen, a: AtomSpec, drawnNucleus: number): Explanation {
  const e = elem(a.Z), cfg = configuration(a.Z), A = a.Z + a.N;
  const outer = Math.max(...cfg.map(meanRadius));
  const deut = sp.env.home < 0 ? null : sp.env.homeName;
  const dh = a.Z !== 1 ? null : sp.env.kind === 'ice' || sp.env.kind === 'moon' || sp.env.kind === 'dwarf' ? ['about 1 in 3,500 (the D/H ratio measured in Enceladus\'s plumes is roughly twice Earth\'s)', 'E'] : sp.env.homeName === 'Mars' ? ['about 1 in 1,000 (Mars\'s water is about 6 times richer in deuterium than Earth\'s)', 'R'] : ['about 1 in 6,420, as in Earth\'s oceans', 'R'];
  return {
    eyebrow: `Atom · ${a.role} · ${sp.name}`, title: `A${/^[aeiou]/.test(e.name) ? 'n' : ''} ${e.name} atom`, lede: `${a.role[0].toUpperCase()}${a.role.slice(1)}, in ${a.molName.replace(/^[A-Z][a-z]/, (x) => x.toLowerCase())}. A nucleus of ${a.Z} proton${a.Z > 1 ? 's' : ''} and ${a.N} neutron${a.N === 1 ? '' : 's'}, wrapped in ${a.Z} electron${a.Z > 1 ? 's' : ''}.`,
    facts: [
      f('Isotope', e.iso, 'R'), f('Electron configuration', configString(cfg), 'R'),
      f('Size of the electron cloud drawn', metres(2 * outer * 1e-10), 'E'),
      f('Nucleus', metres(2 * nuclearRadius(A)), 'E'),
      f('Nucleus vs. atom', `about 1 / ${Math.round(outer * 1e-10 / nuclearRadius(A)).toLocaleString('en-US')} of the width; drawn ${Math.round(drawnNucleus * 1e-10 / nuclearRadius(A)).toLocaleString('en-US')} times too large so it can be seen`, 'E'),
      f('Mass in the nucleus', 'more than 99.9%', 'R'),
      ...(dh ? [f(`Deuterium among hydrogen${deut ? ` on ${deut}` : ''}`, dh[0], dh[1] as Fact['t'])] : []),
    ],
    why: `One of about ${fmtSci(7e27 * scale(sp), 2)} atoms in ${sp.name}. ${e.fact}`,
  };
}

export function nucleusCard(sp: Specimen, a: AtomSpec, drawn: number): Explanation {
  const A = a.Z + a.N, e = elem(a.Z);
  return {
    eyebrow: `Nucleus of ${e.name}-${A}`, title: 'The nucleus', lede: `${a.Z} proton${a.Z > 1 ? 's' : ''} and ${a.N} neutron${a.N === 1 ? '' : 's'}, held together by the strong force against the protons' electric repulsion.`,
    facts: [
      f('Radius', `${metres(nuclearRadius(A))}, from R ≈ 1.2 fm × A^⅓`, 'E'),
      f('Binding energy per nucleon', A > 1 ? `about ${bindingPerNucleon(a.Z, a.N).toFixed(1)} MeV (semi-empirical mass formula)` : 'none: a lone proton', 'E'),
      f('Density', 'about 2.3 × 10¹⁷ kg/m³, the same for every nucleus', 'R'),
      f('Drawn', `${Math.round(drawn * 1e-10 / nuclearRadius(A)).toLocaleString('en-US')} times larger than true`, 'E'),
    ],
    why: a.Z === 26 ? 'Iron-56 sits near the peak of nuclear binding: stars fuse up to iron and no further.' : undefined,
  };
}

export function nucleonCard(proton: boolean, k: number): Explanation {
  return proton
    ? { eyebrow: 'Particle in the nucleus', title: `Proton ${k}`, lede: 'Two up quarks and a down quark bound by gluons; most of its mass is the energy of that binding, not the quarks themselves.', facts: [f('Charge', '+1 e', 'R'), f('Mass', '1.6726 × 10⁻²⁷ kg (938.27 MeV/c²)', 'R'), f('Charge radius', metres(0.8409e-15), 'R'), f('Quarks', 'up, up, down', 'R'), f('Lifetime', 'no decay ever seen: over 10³⁴ years', 'R')] }
    : { eyebrow: 'Particle in the nucleus', title: `Neutron ${k}`, lede: 'One up quark and two down quarks. Stable inside a nucleus; alone, it decays into a proton, an electron and an antineutrino.', facts: [f('Charge', '0', 'R'), f('Mass', '1.6749 × 10⁻²⁷ kg (939.57 MeV/c²)', 'R'), f('Quarks', 'up, down, down', 'R'), f('Free lifetime', 'about 879 s (14.7 minutes)', 'R')] };
}

export function subshellCard(Z: number, s: Subshell, outermost: boolean): Explanation {
  const fill = orbitalFill(s.l, s.e);
  const shape = s.l === 0 ? 'a sphere' : s.l === 1 ? 'three dumbbells along x, y and z' : 'five cloverleaves';
  return {
    eyebrow: `Electrons of ${elem(Z).name}`, title: `${subName(s)} subshell`, lede: `${s.e} electron${s.e > 1 ? 's' : ''} in ${shape}. Each dot is a place an electron could be found; the cloud is where it probably is, not a path it travels.`,
    facts: [
      f('Principal and angular quantum numbers', `n = ${s.n}, l = ${s.l}`, 'R'),
      f('Orbitals', fill.map((o) => `${o.name} ${o.e === 2 ? '↑↓' : o.e === 1 ? '↑' : '·'}`).join('  '), 'R'),
      f('Effective nuclear charge felt', `${s.zeff.toFixed(2)} (Slater's rules)`, 'E'),
      f('Mean distance from the nucleus', metres(meanRadius(s) * 1e-10), 'E'),
      ...(outermost ? [f('Valence', 'these outermost electrons make the chemical bonds', 'R')] : []),
    ],
  };
}

export const yearStr = (y: number) => fmtYear(y);
