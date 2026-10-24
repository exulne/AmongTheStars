// What each tissue is made of: the cell (or, for an uploaded mind, the
// substrate tile) under each part of a body, the organelles inside it and the
// molecule each one is built around. Facts are textbook values with sources
// where a single study is the usual reference.

import type { CellId, Specimen, Tag } from './specimen.ts';

export type MolId = 'water' | 'dna' | 'bilayer' | 'helix' | 'heme' | 'apatite' | 'diamond' | 'silicon' | 'nanotube' | 'atp' | 'glutamate' | 'o2' | 'glucose' | 'dhi' | 'copper' | 'nvdiamond' | 'pe';
export type CellShape = 'round' | 'poly' | 'disc' | 'fibre' | 'neuron' | 'flat' | 'rod' | 'cuboid' | 'osteo' | 'tile' | 'nanobot';
export type OrgShape = 'membrane' | 'nucleus' | 'mito' | 'er' | 'golgi' | 'ribosomes' | 'cytoskeleton' | 'vesicles' | 'myelin' | 'myofibrils' | 'hemoglobin'
  | 'matrix' | 'collagen' | 'processes' | 'nucleoid' | 'flagellum' | 'keratin' | 'melanosomes' | 'glycogen' | 'gas' | 'lamellar' | 'microvilli'
  | 'electrode' | 'nanobots' | 'cytosol' | 'shell' | 'rotors' | 'tank' | 'gates' | 'wires' | 'memcells' | 'waveguide' | 'channels' | 'busbars' | 'layers';
export type F3 = [string, string, Tag];

export interface Organelle { shape: OrgShape; name: string; mol: MolId; lede: string; facts: F3[]; count: number; gene?: Gene }
export interface Gene { name: string; chrom: string; does: string; edited: boolean; editWhat?: string; editFact?: string; insert?: boolean }
export interface CellType { id: CellId; name: string; tissue: string; shape: CellShape; size: number; lede: string; facts: F3[]; nucleus: boolean }
export interface CellPlan { type: CellType; organelles: Organelle[]; key: string }

const CELLS: Record<CellId, CellType> = {
  neuron: { id: 'neuron', name: 'Neuron', tissue: 'Cerebral cortex', shape: 'neuron', size: 20e-6, nucleus: true, lede: 'A nerve cell of the cerebral cortex: it adds up signals from thousands of others and fires when they pass a threshold.', facts: [['Neurons in a human brain', 'about 86 billion (Azevedo et al. 2009)', 'R'], ['Synapses per cortical neuron', 'several thousand', 'R'], ['Resting voltage across the membrane', 'about −70 mV', 'R'], ['Fastest signals', 'about 120 m/s along myelinated axons', 'R'], ['Lifespan', 'most last a whole life', 'R']] },
  cardio: { id: 'cardio', name: 'Heart muscle cell', tissue: 'Myocardium', shape: 'fibre', size: 100e-6, nucleus: true, lede: 'A cardiomyocyte: a branched, striped muscle cell joined to its neighbours so the whole heart contracts as one.', facts: [['Cardiomyocytes in a heart', 'a few billion', 'E'], ['Renewed each year', 'about 1% at 25, falling to 0.45% at 75 (Bergmann et al. 2009)', 'R'], ['Share of the cell that is mitochondria', 'about 30%', 'R'], ['Size', 'about 100 µm long, 10 to 25 µm wide', 'R']] },
  pneumo: { id: 'pneumo', name: 'Alveolar cell', tissue: 'Lung alveolus', shape: 'flat', size: 50e-6, nucleus: true, lede: 'A type I pneumocyte, spread thin as cling film over an air sac so oxygen can cross into the blood.', facts: [['Alveoli in two lungs', 'about 480 million (Ochs et al. 2004)', 'R'], ['Air–blood barrier', 'about 0.6 µm thick on average', 'R'], ['Gas-exchange surface', 'tens of square metres; estimates run from 50 to 140 m²', 'R'], ['Share of the alveolar surface these cells cover', 'about 95%', 'R']] },
  hepato: { id: 'hepato', name: 'Hepatocyte', tissue: 'Liver lobule', shape: 'poly', size: 25e-6, nucleus: true, lede: 'A liver cell: it makes most blood proteins, stores sugar as glycogen and clears drugs and toxins.', facts: [['Hepatocytes in a liver', 'about 240 billion (Sender et al. 2016)', 'E'], ['Size', '20 to 30 µm across', 'R'], ['Mitochondria in each', '1,000 to 2,000', 'R'], ['Lifespan', 'roughly 200 to 400 days', 'E'], ['Share of liver cells', 'about 60%, and 80% of its mass', 'R']] },
  tubule: { id: 'tubule', name: 'Kidney tubule cell', tissue: 'Proximal tubule', shape: 'cuboid', size: 15e-6, nucleus: true, lede: 'A proximal tubule cell: it takes back water, salt and sugar from the fluid the kidney has filtered, through a brush of microvilli.', facts: [['Nephrons per kidney', 'about a million, ranging 200,000 to 2.5 million (Bertram et al. 2011)', 'R'], ['Fluid filtered a day', 'about 180 litres', 'R'], ['Share of filtered salt and water taken back here', 'about two-thirds', 'R']] },
  bacterium: { id: 'bacterium', name: 'Gut bacterium', tissue: 'Colon microbiome', shape: 'rod', size: 2e-6, nucleus: false, lede: 'A Bacteroides cell, one of the most common bacteria in the colon: not human, but part of every human body.', facts: [['Bacteria in a body', 'about 38 trillion, slightly more than human cells (Sender et al. 2016)', 'R'], ['Their combined mass', 'about 0.2 kg', 'R'], ['Size', 'about 1 × 2 µm', 'R'], ['Nucleus', 'none: the DNA floats free as a nucleoid', 'R']] },
  osteocyte: { id: 'osteocyte', name: 'Osteocyte', tissue: 'Compact bone', shape: 'osteo', size: 15e-6, nucleus: true, lede: 'A bone cell walled into the mineral it once laid down, sensing load through fine channels and telling bone where to grow or thin.', facts: [['Osteocytes in a skeleton', 'about 42 billion (Buenzli and Sims 2015)', 'R'], ['Connections between them', 'about 3.7 trillion', 'R'], ['Share of bone cells', '90 to 95%', 'R'], ['Signal they make', 'sclerostin, from the SOST gene, which slows bone building', 'R']] },
  myofibre: { id: 'myofibre', name: 'Muscle fibre', tissue: 'Skeletal muscle', shape: 'fibre', size: 80e-6, nucleus: true, lede: 'A skeletal muscle fibre: one giant cell with hundreds of nuclei, packed with myofibrils that shorten when calcium floods in.', facts: [['Diameter', '10 to 100 µm', 'R'], ['Length', 'millimetres to over 10 cm', 'R'], ['Nuclei', 'hundreds to thousands per fibre', 'R'], ['Skeletal muscle in a body', 'about 40% of its mass', 'R']] },
  keratino: { id: 'keratino', name: 'Keratinocyte', tissue: 'Epidermis', shape: 'flat', size: 30e-6, nucleus: true, lede: 'A skin cell on its way to the surface, filling with keratin and catching melanin from pigment cells below.', facts: [['Share of epidermal cells', 'about 90%', 'R'], ['Time from base to shedding', 'about 4 to 8 weeks', 'R'], ['Skin area of an adult', 'about 1.8 m²', 'R']] },
  rbc: { id: 'rbc', name: 'Red blood cell', tissue: 'Blood', shape: 'disc', size: 7.8e-6, nucleus: false, lede: 'An erythrocyte: a flexible disc full of haemoglobin that carries oxygen out from the lungs. It has no nucleus and no mitochondria.', facts: [['Red cells in a body', 'about 25 trillion, 84% of all human cells (Sender et al. 2016)', 'R'], ['Size', 'about 7.8 µm across, 2 µm thick', 'R'], ['Haemoglobin molecules in each', 'about 270 million', 'R'], ['Lifespan', 'about 120 days', 'R'], ['Made each second', 'about 2 to 3 million', 'R']] },
  respirocyte: { id: 'respirocyte', name: 'Respirocyte', tissue: 'Blood, with nanomachines', shape: 'nanobot', size: 1e-6, nucleus: false, lede: 'An artificial red cell: a diamondoid pressure tank with molecular pumps, from Robert Freitas\'s 1998 design study, built in this future.', facts: [['Diameter', 'about 1 µm (design)', 'E'], ['Oxygen stored', 'at about 1,000 atmospheres (design)', 'E'], ['Oxygen carried, vs. the same volume of red cells', 'about 236 times as much (design)', 'E'], ['Atoms in one', 'about 18 billion, each placed (design)', 'E'], ['Made here by', 'molecular nanofabrication, once it reached this world', 'P']] },
  logic: { id: 'logic', name: 'Logic tile', tissue: 'Processor stack', shape: 'tile', size: 2e-6, nucleus: false, lede: 'A tile of the processor that runs this mind: gates switching billions of times a second, where neurons once fired.', facts: [['Gate pitch in 2020s chips', 'about 50 nm', 'R'], ['Least energy to erase a bit at 300 K', '2.9 × 10⁻²¹ J (Landauer limit)', 'R'], ['Power a human brain runs on', 'about 20 W', 'R'], ['Brain-equivalent computing', 'estimates run 10¹⁵ to 10¹⁸ operations a second', 'E']] },
  memtile: { id: 'memtile', name: 'Memory tile', tissue: 'Memory lattice', shape: 'tile', size: 2e-6, nucleus: false, lede: 'Diamond seeded with nitrogen-vacancy centres, each holding a spin state: a long-lived memory for a mind.', facts: [['NV centre', 'a nitrogen atom beside a missing carbon in diamond', 'R'], ['Spin memory', 'NV spins have held quantum states for over a second when cold', 'R'], ['Density here', 'one centre every few nanometres', 'P']] },
  photonic: { id: 'photonic', name: 'Photonic tile', tissue: 'Optical interconnect', shape: 'tile', size: 2e-6, nucleus: false, lede: 'Silicon waveguides carry the mind\'s signals as light between processor stacks.', facts: [['Typical silicon waveguide', '450 × 220 nm', 'R'], ['Telecom light', '1,550 nm wavelength, in which silicon is transparent', 'R'], ['Signal speed in silicon', 'about 0.29 of light speed in vacuum (group index ≈ 3.5)', 'E']] },
  coolant: { id: 'coolant', name: 'Cooling channel', tissue: 'Heat exchanger', shape: 'tile', size: 2e-6, nucleus: false, lede: 'Water flows through micro-channels cut into the substrate, carrying away the heat of thinking.', facts: [['Microchannel cooling, first shown', '790 W per cm² (Tuckerman and Pease 1981)', 'R'], ['Heat capacity of water', '4.18 J per gram per kelvin', 'R']] },
  bus: { id: 'bus', name: 'Power bus', tissue: 'Power distribution', shape: 'tile', size: 2e-6, nucleus: false, lede: 'Copper bus bars carry current to every tile.', facts: [['Copper resistivity', '1.68 × 10⁻⁸ Ω·m at 20 °C', 'R'], ['Copper lattice', 'face-centred cubic, 0.3615 nm cube edge', 'R']] },
  shieldtile: { id: 'shieldtile', name: 'Shield layer', tissue: 'Radiation shield', shape: 'tile', size: 2e-6, nucleus: false, lede: 'Hydrogen-rich polymer around the substrate: light atoms stop cosmic rays with the least secondary radiation.', facts: [['Best shields per kilogram', 'hydrogen-rich materials such as polyethylene', 'R'], ['Bit flips from cosmic rays', 'a real hazard for chips in space; shielding and error correction cut them', 'R']] },
};

// organelle building blocks
const MEMBRANE: Omit<Organelle, 'count'> = { shape: 'membrane', name: 'Cell membrane', mol: 'bilayer', lede: 'A double layer of lipids with proteins floating in it: the skin of the cell.', facts: [['Thickness', 'about 5 nm of lipid, 7 to 10 nm with its proteins', 'R'], ['Made of', 'about half lipid, half protein by mass', 'R']] };
const MITO: Omit<Organelle, 'count'> = { shape: 'mito', name: 'Mitochondria', mol: 'atp', lede: 'Descendants of bacteria swallowed two billion years ago; they burn sugar and fat with oxygen and make ATP.', facts: [['Size', '0.5 to 1 µm wide, 1 to 10 µm long', 'R'], ['Their own DNA', '16,569 base pairs, 37 genes', 'R'], ['ATP a body makes a day', 'roughly its own weight', 'R']] };
const ER: Omit<Organelle, 'count'> = { shape: 'er', name: 'Endoplasmic reticulum', mol: 'helix', lede: 'A folded membrane maze joined to the nucleus; ribosomes on its rough parts thread new proteins into it.', facts: [['Share of the cell\'s membrane', 'often more than half', 'R'], ['Job', 'makes membrane and secreted proteins, and lipids', 'R']] };
const GOLGI: Omit<Organelle, 'count'> = { shape: 'golgi', name: 'Golgi apparatus', mol: 'glucose', lede: 'A stack of flattened sacs that tags proteins with sugar chains and ships them out in vesicles.', facts: [['Stack', '4 to 8 cisternae, about 1 µm across', 'R'], ['Discovered', 'by Camillo Golgi, 1898', 'R']] };
const RIBO: Omit<Organelle, 'count'> = { shape: 'ribosomes', name: 'Ribosomes', mol: 'helix', lede: 'Molecular machines that read messenger RNA and join amino acids into proteins.', facts: [['Size', 'about 25 to 30 nm', 'R'], ['Speed', 'a few amino acids a second in human cells', 'E'], ['In a growing mammalian cell', 'up to about 10 million', 'R']] };
const CYTO: Omit<Organelle, 'count'> = { shape: 'cytoskeleton', name: 'Cytoskeleton', mol: 'helix', lede: 'Protein cables and tubes that hold the cell\'s shape and carry cargo along them.', facts: [['Microtubules', '25 nm wide, built of tubulin', 'R'], ['Actin filaments', 'about 7 nm wide', 'R'], ['Kinesin motors walk at', 'about 1 µm a second', 'R']] };
const CYTOSOL: Omit<Organelle, 'count'> = { shape: 'cytosol', name: 'Cytosol', mol: 'water', lede: 'The crowded water inside the cell: about 70% water, the rest proteins, salts and sugars jostling at random.', facts: [['Water', 'about 70% of a cell by mass', 'R'], ['Protein concentration', 'about 200 to 300 g per litre', 'R']] };

const GENES: Partial<Record<CellId, { name: string; chrom: string; does: string }>> = {
  neuron: { name: 'FOXP2', chrom: 'chromosome 7', does: 'a gene needed for learning speech; a family with a broken copy had trouble forming words (Lai et al. 2001)' },
  cardio: { name: 'MYH7', chrom: 'chromosome 14', does: 'β-myosin, the motor protein of heart muscle; faults in it are a leading cause of inherited heart thickening' },
  pneumo: { name: 'SFTPC', chrom: 'chromosome 8', does: 'surfactant protein C, which keeps the air sacs from collapsing' },
  hepato: { name: 'ALB', chrom: 'chromosome 4', does: 'albumin, the most abundant protein in blood plasma' },
  tubule: { name: 'UMOD', chrom: 'chromosome 16', does: 'uromodulin, the most abundant protein in urine' },
  bacterium: { name: 'rpoB', chrom: 'its single circular chromosome', does: 'the β subunit of RNA polymerase, the target of the antibiotic rifampicin' },
  osteocyte: { name: 'SOST', chrom: 'chromosome 17', does: 'sclerostin, the signal osteocytes send to slow bone building' },
  myofibre: { name: 'ACTN3', chrom: 'chromosome 11', does: 'α-actinin-3 of fast muscle fibres; about one person in five has no working copy' },
  keratino: { name: 'MC1R', chrom: 'chromosome 16', does: 'the melanocortin receptor; its variants give red hair and pale, burn-prone skin' },
};

function nucleusOf(cell: CellId, sp: Specimen, label = 'Nucleus'): Omit<Organelle, 'count'> {
  const edit = sp.edits.find((e) => e.cells !== 'all' && e.cells.includes(cell)) ?? sp.edits.find((e) => e.cells === 'all');
  const base = GENES[cell]!;
  const gene: Gene = edit
    ? { name: edit.gene, chrom: edit.chrom, does: edit.what, edited: true, editWhat: edit.what, editFact: edit.fact, insert: edit.gene === 'Dsup' }
    : { name: base.name, chrom: base.chrom, does: base.does, edited: false };
  return {
    shape: cell === 'bacterium' ? 'nucleoid' : 'nucleus', name: cell === 'bacterium' ? 'Nucleoid' : label, mol: 'dna', gene,
    lede: cell === 'bacterium' ? 'The bacterium\'s one circular chromosome, coiled loose in the cell with no membrane around it.' : 'The cell\'s library: two metres of DNA in 46 chromosomes, folded into a sphere a few micrometres wide.',
    facts: cell === 'bacterium'
      ? [['Chromosome', 'one circle of about 5 million base pairs', 'E'], ['Genes', 'about 4,000 to 5,000', 'E']]
      : [['Size', 'about 6 µm across', 'R'], ['DNA inside', 'about 2 m, 6.2 billion base pairs in 46 chromosomes', 'R'], ['Protein-coding genes', 'about 20,000', 'R']],
  };
}

/** The organelles of one cell of a tissue, for this person in this era. */
export function cellPlan(cell: CellId, sp: Specimen): CellPlan {
  const type = CELLS[cell];
  const O: Organelle[] = [];
  const add = (o: Omit<Organelle, 'count'>, count = 1) => O.push({ ...o, count });
  const nano = sp.tech.nanofab;
  switch (cell) {
    case 'neuron':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add(MITO, 40); add(ER); add(GOLGI); add(RIBO, 1);
      add({ ...CYTO, name: 'Dendrites and axon', lede: 'Branches that gather signals (dendrites) and one long cable that sends them (the axon), held out by microtubules.' });
      add({ shape: 'vesicles', name: 'Synaptic vesicles', mol: 'glutamate', lede: 'Tiny bubbles of neurotransmitter waiting at the axon\'s end to be released into a synapse.', facts: [['Size', 'about 40 nm across', 'R'], ['Inside each', 'a few thousand glutamate molecules', 'E'], ['Release after a signal arrives', 'in under a millisecond', 'R']] }, 60);
      add({ shape: 'myelin', name: 'Myelin sheath', mol: 'bilayer', lede: 'Fatty insulation wrapped around the axon by glial cells, so signals jump from gap to gap.', facts: [['Made of', 'about 70 to 80% lipid', 'R'], ['Speeds signals', 'from about 1 m/s to up to 120 m/s', 'R']] });
      if (sp.parts.includes('lace')) add({ shape: 'electrode', name: 'Electrode thread', mol: 'diamond', lede: 'A thread of a brain-computer interface lying among the neurons, listening to them fire and speaking back.', facts: [['Early implant (2020s)', '1,024 electrodes on 64 threads, each thread about 5 µm wide', 'R'], ['Thread coating here', 'diamond-like carbon', 'P']] });
      break;
    case 'cardio':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add({ ...MITO, facts: [...MITO.facts, ['Share of this cell', 'about 30% of its volume', 'R']] }, 60);
      add({ shape: 'myofibrils', name: 'Myofibrils', mol: 'helix', lede: 'Chains of sarcomeres where myosin pulls on actin, about 70 times a minute for a lifetime.', facts: [['Sarcomere length', 'about 2 µm', 'R'], ['Heartbeats in a lifetime', 'about 3 billion', 'E']] });
      add(ER); add(CYTOSOL);
      break;
    case 'pneumo':
      add({ ...MEMBRANE, name: 'Membrane and surfactant', lede: 'The cell\'s membrane, lined on the air side with surfactant that keeps the sac from collapsing.' });
      add(nucleusOf(cell, sp)); add(MITO, 8);
      add({ shape: 'gas', name: 'Air in the alveolus', mol: 'o2', lede: 'Oxygen crossing from the air sac into the blood, carbon dioxide crossing out.', facts: [['Oxygen in dry air', '20.95%', 'R'], ['Time blood spends passing an alveolus', 'about 0.75 s at rest', 'R']] }, 200);
      add({ shape: 'lamellar', name: 'Lamellar bodies', mol: 'bilayer', lede: 'Stores of surfactant lipid, made by the neighbouring type II cells.', facts: [['Surfactant', 'about 90% lipid, mostly DPPC', 'R']] }, 6);
      add(CYTOSOL);
      break;
    case 'hepato':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add(MITO, 70); add(ER); add(GOLGI); add(RIBO, 1);
      add({ shape: 'glycogen', name: 'Glycogen granules', mol: 'glucose', lede: 'Branched chains of glucose: the liver\'s sugar store, drawn on between meals.', facts: [['Glucose units in a large granule', 'up to about 55,000', 'R'], ['Glycogen a liver holds', 'about 100 g', 'R']] }, 200);
      add(CYTOSOL);
      break;
    case 'tubule':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add(MITO, 60);
      add({ shape: 'microvilli', name: 'Brush border', mol: 'helix', lede: 'Thousands of finger-like microvilli, each with an actin core, multiplying the surface that takes fluid back.', facts: [['Microvillus', 'about 1 to 3 µm long, 0.1 µm wide', 'R']] });
      add(ER); add(CYTOSOL);
      break;
    case 'bacterium':
      add({ ...MEMBRANE, name: 'Cell envelope', lede: 'Two membranes with a thin cell wall between them, as in every gram-negative bacterium.' });
      add(nucleusOf(cell, sp)); add({ ...RIBO, facts: [['Size', 'about 20 nm (70S)', 'R'], ['In a fast-growing cell', 'tens of thousands', 'R']] }, 1);
      add({ shape: 'flagellum', name: 'Flagellum', mol: 'helix', lede: 'A whip spun by a rotary motor in the envelope, the only true wheel in biology.', facts: [['Motor speed', 'up to hundreds of revolutions a second', 'R'], ['Filament made of', 'flagellin protein', 'R']] });
      add(CYTOSOL);
      break;
    case 'osteocyte':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add(MITO, 12); add(ER);
      add({ shape: 'matrix', name: 'Bone mineral', mol: 'apatite', lede: `Crystals of calcium phosphate packed between collagen fibres${sp.bone < 0.95 ? `, thinner here than in an Earth-grown skeleton` : sp.bone > 1.05 ? `, denser here than in an Earth-grown skeleton` : ''}.`, facts: [['Mineral share of bone mass', 'about 60 to 70%', 'R'], ['Crystals', 'thin plates tens of nanometres long, a few nanometres thick', 'R'], ['This person\'s bone density vs. an Earth adult', `${Math.round(sp.bone * 100)}%`, 'P']] });
      add({ shape: 'collagen', name: 'Collagen fibres', mol: 'helix', lede: 'Ropes of type I collagen that give bone its toughness; the mineral gives it its stiffness.', facts: [['Collagen molecule', 'a triple helix about 300 nm long, 1.5 nm wide', 'R'], ['Most abundant protein in the body', 'collagen, about a quarter to a third of all protein', 'R']] });
      add({ shape: 'processes', name: 'Canaliculi', mol: 'water', lede: 'Fine channels through the mineral where the cell\'s processes touch its neighbours and feel fluid move when bone bends.', facts: [['Processes per osteocyte', 'about 50 or more', 'E'], ['How they sense load', 'fluid flowing past them as bone flexes', 'R']] });
      break;
    case 'myofibre':
      add(MEMBRANE); add(nucleusOf(cell, sp, 'Nuclei')); add(MITO, 50);
      add({ shape: 'myofibrils', name: 'Myofibrils', mol: 'helix', lede: 'Bundles of sarcomeres, the stripes of muscle: myosin heads pull actin filaments together.', facts: [['Sarcomere length', 'about 2 to 3 µm', 'R'], ['Shortening', 'up to about 30% of resting length', 'E']] });
      add({ ...ER, name: 'Sarcoplasmic reticulum', lede: 'A calcium store wrapped round each myofibril; a nerve signal opens it and the muscle contracts.' });
      add({ shape: 'glycogen', name: 'Glycogen granules', mol: 'glucose', lede: 'Sugar stored for fast use by the fibre itself.', facts: [['Glycogen in a body\'s muscles', 'about 400 g', 'R']] }, 120);
      break;
    case 'keratino':
      add(MEMBRANE); add(nucleusOf(cell, sp)); add(MITO, 10);
      add({ shape: 'keratin', name: 'Keratin filaments', mol: 'helix', lede: 'Tough protein cables that fill the cell as it rises; at the surface it dies and becomes armour.', facts: [['Intermediate filaments', 'about 10 nm wide', 'R'], ['Keratin chains', 'pairs of α-helices coiled round each other', 'R']] });
      add({ shape: 'melanosomes', name: 'Melanosomes', mol: 'dhi', lede: 'Packets of melanin pigment, passed in from pigment cells, capping the nucleus against ultraviolet light.', facts: [['Size', 'about 0.5 µm', 'R'], ['Melanin', 'a polymer built from units such as DHI', 'R']] }, 30);
      add(CYTOSOL);
      break;
    case 'rbc':
      add(MEMBRANE);
      add({ shape: 'hemoglobin', name: 'Haemoglobin', mol: 'heme', lede: 'The protein that fills the cell: four chains, each holding a heme ring with an iron atom that binds one oxygen.', facts: [['Molecules per red cell', 'about 270 million', 'R'], ['Oxygen per molecule', 'up to 4', 'R'], ['Mass', 'about 64,500 daltons', 'R']] }, 400);
      add({ ...CYTO, name: 'Spectrin skeleton', lede: 'A mesh of spectrin under the membrane that lets the cell fold through capillaries narrower than itself.', facts: [['Narrowest capillaries', 'about 3 to 5 µm, narrower than the cell', 'R']] });
      break;
    case 'respirocyte':
      add({ shape: 'shell', name: 'Diamondoid shell', mol: 'diamond', lede: 'A sphere of diamond-like carbon thick enough to hold a thousand atmospheres.', facts: [['Material', 'diamondoid: carbon in the diamond lattice', 'E'], ['Burst margin in the design', 'several times the working pressure', 'E']] });
      add({ shape: 'rotors', name: 'Sorting rotors', mol: 'diamond', lede: 'Molecular pumps on the surface that pick oxygen or carbon dioxide out of the plasma, one molecule at a time.', facts: [['Rotors in the design', 'about 29,000 over the surface', 'E'], ['Selectivity', 'binding pockets shaped for one molecule', 'E']] });
      add({ shape: 'tank', name: 'Oxygen store', mol: 'o2', lede: 'Compressed oxygen, released where the blood runs low.', facts: [['Pressure', 'about 1,000 atm (design)', 'E']] }, 120);
      break;
    case 'logic': case 'memtile': case 'photonic': case 'coolant': case 'bus': case 'shieldtile': {
      const main: Record<string, Omit<Organelle, 'count'>> = {
        logic: { shape: 'gates', name: 'Logic gates', mol: 'silicon', lede: 'Doped silicon switches, each flipping a few billion times a second.', facts: [['Silicon lattice', 'diamond cubic, 0.5431 nm cube edge', 'R'], ['Dopants', 'boron or phosphorus atoms replacing silicon', 'R']] },
        memtile: { shape: 'memcells', name: 'NV memory cells', mol: 'nvdiamond', lede: 'Each bright point is a nitrogen-vacancy centre holding one spin.', facts: [['Diamond lattice', '0.3567 nm cube edge', 'R'], ['NV centre', 'nitrogen beside a vacancy, read out with light', 'R']] },
        photonic: { shape: 'waveguide', name: 'Waveguides', mol: 'silicon', lede: 'Ridges of silicon that trap light by total internal reflection.', facts: [['Silicon refractive index at 1,550 nm', 'about 3.48', 'R']] },
        coolant: { shape: 'channels', name: 'Coolant', mol: 'water', lede: 'Water carrying heat away from the logic.', facts: [['Water boils at', '100 °C at 1 atm', 'R']] },
        bus: { shape: 'busbars', name: 'Bus bars', mol: 'copper', lede: 'Copper strips carrying current.', facts: [['Copper conductivity', 'second only to silver', 'R']] },
        shieldtile: { shape: 'layers', name: 'Polymer layers', mol: 'pe', lede: 'Sheets of polyethylene, rich in hydrogen.', facts: [['Polyethylene', 'chains of CH₂, about 14% hydrogen by mass', 'R']] },
      };
      add(main[cell]);
      add({ shape: 'wires', name: 'Nanotube interconnects', mol: 'nanotube', lede: 'Carbon nanotubes wiring the tile to its neighbours.', facts: [['Diameter', 'about 1.4 nm for a (10,10) tube', 'R'], ['Current they carry', 'about 1,000 times copper\'s per area', 'R']] });
      if (cell !== 'coolant') add({ shape: 'channels', name: 'Coolant channel', mol: 'water', lede: 'Water carrying heat away from the logic.', facts: [['Heat capacity of water', '4.18 J per gram per kelvin', 'R']] });
      break;
    }
  }
  if (nano && sp.form === 'flesh' && cell !== 'respirocyte' && cell !== 'bacterium') add({ shape: 'nanobots', name: 'Repair nanomachines', mol: 'diamond', lede: 'Cell-repair machines that patrol the cytosol, fixing damaged proteins and DNA, from the era of molecular nanofabrication.', facts: [['Size', 'a few hundred nanometres', 'P'], ['Idea first set out', 'by K. Eric Drexler (1986) and Robert Freitas (Nanomedicine, 1999)', 'R'], ['Here since', 'molecular nanofabrication reached this world', 'P']] }, 5);
  return { type, organelles: O, key: `${cell}|${sp.key}|${O.length}` };
}

export const cellType = (id: CellId): CellType => CELLS[id];
