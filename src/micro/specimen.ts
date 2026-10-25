// One person, read for their body: the world they live on (gravity, cold,
// radiation, water), the technology that has reached it, and what follows:
// bone density, build, the gene edits of their era, nanomachines in the
// blood, or no flesh at all for an uploaded mind. Everything here is derived
// from the simulation's own numbers; nothing is stored.

import type { BodyKind } from '../sim/catalog.ts';
import { TECHS } from '../sim/catalog.ts';
import type { StateMsg } from '../sim/client.ts';
import { techAt } from '../sim/diffusion.ts';
import type { Biography } from '../sim/lives.ts';
import { hash01 } from '../sim/rng.ts';
import type { World } from '../sim/world.ts';

export type Tag = 'R' | 'E' | 'P';
export type PartId = 'brain' | 'heart' | 'lungs' | 'liver' | 'kidneys' | 'gut' | 'bone' | 'muscle' | 'skin' | 'blood' | 'lace' | 'nano'
  | 'core' | 'memory' | 'optic' | 'cooling' | 'power' | 'shield' | 'avatar';
export type CellId = 'neuron' | 'cardio' | 'pneumo' | 'hepato' | 'tubule' | 'bacterium' | 'osteocyte' | 'myofibre' | 'keratino' | 'rbc' | 'respirocyte'
  | 'logic' | 'memtile' | 'photonic' | 'coolant' | 'bus' | 'shieldtile';
export type Radiation = 'sheltered' | 'thin' | 'airless' | 'harsh' | 'ship';

export interface Env {
  home: number;          // body id, or -1 aboard a ship
  homeName: string;
  kind: BodyKind | 'ship';
  g: number; temp: number; water: number; flux: number;
  rad: Radiation;
}

export interface Edit {
  gene: string; chrom: string;
  what: string;          // what it does for this person
  fact: string;          // the real science behind it
  cells: CellId[] | 'all';
  why: 'adapt' | 'medicine' | 'ageing';
}

export interface Specimen {
  key: string;
  pid: string; name: string; sex: 'f' | 'm'; age: number; alive: boolean; status: Biography['status'];
  form: 'flesh' | 'substrate';
  adapted: boolean;
  bodyWord: string;      // the biography's words: "baseline human", "adapted to this world", "uploaded"
  env: Env;
  heightM: number; massKg: number;
  slender: number;       // girth relative to an Earth-born build
  bone: number;          // bone mineral density relative to an Earth adult
  fat: number;           // insulating layer relative to Earth
  edits: Edit[];
  tech: { genMed: boolean; bioAdapt: boolean; nanofab: boolean; lifeExt: boolean; neuralLace: boolean; mindUpload: boolean; radShield: boolean };
  parts: PartId[];
  year: number;
}

const T = (id: string) => TECHS.findIndex((t) => t.id === id);
const SHIP = 1_000_000;

/** The world (or ship) a person lives on, as a body would feel it. */
export function envOf(world: World, bio: Biography): Env {
  const b = bio.where && bio.where.body < SHIP ? bio.where.body : bio.bornAt < SHIP ? bio.bornAt : -1;
  if (b < 0 || bio.status === 'travelling') return { home: -1, homeName: bio.where?.name ?? 'a ship between the stars', kind: 'ship', g: 0.9, temp: 293, water: 0.5, flux: 0, rad: 'ship' };
  const body = world.bodies[b];
  const parent = body.parent >= 0 ? world.bodies[body.parent] : null;
  let rad: Radiation;
  if (body.kind === 'habitat') rad = 'ship';
  else if (body.id === world.earth || ((body.kind === 'ocean' || body.kind === 'rocky' || body.kind === 'superearth') && body.hab >= 0.5) || body.kind === 'gas' || body.kind === 'icegiant') rad = 'sheltered';
  else if (parent && (parent.kind === 'gas' || parent.kind === 'icegiant') && body.a < 800 && body.radius < 3000) rad = 'harsh';
  else if (body.kind === 'desert' || body.kind === 'rocky' || body.kind === 'superearth' || body.kind === 'lava' || (body.hab >= 0.3 && body.kind !== 'asteroid')) rad = 'thin';
  else rad = 'airless';
  return { home: b, homeName: bio.where?.name ?? bio.bornAtName, kind: body.kind, g: body.g, temp: body.temp, water: body.res[0], flux: body.flux, rad };
}

/** Real reference doses for each kind of sky, for the cards. */
export const RAD_TEXT: Record<Radiation, { dose: string; t: Tag }> = {
  sheltered: { dose: 'about 2.4 mSv a year at the surface, Earth\'s natural background under a thick atmosphere and magnetic field', t: 'R' },
  thin: { dose: 'about 0.7 mSv a day on an unshielded surface, as Curiosity measured on Mars (Hassler et al. 2014)', t: 'R' },
  airless: { dose: 'about 1.4 mSv a day on an airless surface, as Chang\'e 4 measured on the Moon (Zhang et al. 2020)', t: 'R' },
  harsh: { dose: 'up to 5.4 Sv a day on the surface inside a giant planet\'s radiation belts, as at Europa: a lethal dose in a day', t: 'R' },
  ship: { dose: 'set by the hull: cosmic rays outside run to about 1.8 mSv a day in deep space (Zeitlin et al. 2013)', t: 'R' },
};

const EDITS: Record<string, Edit> = {
  SOST: { gene: 'SOST', chrom: 'chromosome 17', why: 'adapt', cells: ['osteocyte'], what: 'Sclerostin, the brake on bone building, is switched off, so bones keep their strength without Earth\'s weight on them.', fact: 'People born without working SOST (sclerosteosis) have extremely dense bones; the drug romosozumab blocks sclerostin to treat osteoporosis.' },
  MSTN: { gene: 'MSTN', chrom: 'chromosome 2', why: 'adapt', cells: ['myofibre'], what: 'Myostatin, which caps muscle growth, is switched off: more muscle to carry a heavy world.', fact: 'Cattle and whippets without working myostatin are double-muscled; a German boy with the mutation was described in 2004 (Schuelke et al.).' },
  Dsup: { gene: 'Dsup', chrom: 'a transgene from the tardigrade Ramazzottius varieornatus', why: 'adapt', cells: 'all', what: 'A tardigrade protein wraps the DNA in every cell and shields it from radiation.', fact: 'In cultured human cells, Dsup cut X-ray damage to DNA by about 40% (Hashimoto et al. 2016).' },
  UCP1: { gene: 'UCP1', chrom: 'chromosome 4', why: 'adapt', cells: ['keratino', 'myofibre'], what: 'More brown fat: mitochondria that burn fuel straight into heat for a cold world.', fact: 'UCP1 lets brown-fat mitochondria leak their proton gradient as heat instead of making ATP; newborns rely on it, adults keep a little.' },
  PDE10A: { gene: 'PDE10A', chrom: 'chromosome 6', why: 'adapt', cells: ['hepato', 'tubule'], what: 'A larger spleen, a reserve of oxygen-rich red cells for life on and under water.', fact: 'The Bajau sea nomads carry PDE10A variants linked to spleens about 50% larger than their neighbours\' (Ilardo et al. 2018).' },
  EPAS1: { gene: 'EPAS1', chrom: 'chromosome 2', why: 'adapt', cells: ['pneumo', 'tubule'], what: 'Thin habitat air without thickened blood: the body asks for fewer red cells than an Earth body would.', fact: 'Most Tibetans carry an EPAS1 variant, inherited from Denisovans, that lets them live above 4,000 m without the thick blood that sickens lowlanders (Huerta-Sánchez et al. 2014).' },
  PCSK9: { gene: 'PCSK9', chrom: 'chromosome 1', why: 'medicine', cells: ['hepato'], what: 'One DNA letter changed in the liver switches PCSK9 off, keeping LDL cholesterol low for life.', fact: 'Base editors change a single letter without cutting both strands; a one-time PCSK9 base edit lowered LDL in the first human trials (Verve Therapeutics, 2023).' },
  TERT: { gene: 'TERT', chrom: 'chromosome 5', why: 'ageing', cells: 'all', what: 'Controlled telomerase in stem cells keeps chromosome ends from wearing down, part of this era\'s radical life extension.', fact: 'Telomeres shorten with every cell division; telomerase rebuilds them. Middle-aged mice given TERT gene therapy lived about 24% longer on average (Bernardes de Jesus et al. 2012).' },
};

/** A person's body at a year. `snap` gives what technology has reached their world. */
export function specimenOf(world: World, snap: StateMsg | null, bio: Biography, year: number): Specimen {
  const env = envOf(world, bio);
  const has = (id: string) => {
    if (!snap) return false;
    const i = T(id);
    if (i < 0) return false;
    if (env.home < 0) return snap.techDone[i] >= 0 && snap.techDone[i] <= year;
    return techAt(world, snap.techDone, snap.techWhere, i, env.home, year);
  };
  const tech = { genMed: has('genMed'), bioAdapt: has('bioAdapt'), nanofab: has('nanofab'), lifeExt: has('lifeExt'), neuralLace: has('neuralLace'), mindUpload: has('mindUpload'), radShield: has('radShield') };
  const word = bio.body ?? 'baseline human';
  const uploaded = word === 'uploaded';
  const adapted = word.startsWith('adapted');
  const age = Math.max(0.3, bio.status === 'dead' && bio.died ? bio.died.age : bio.age);
  const h = (k: number) => hash01(bio.born * 7, bio.bornAt, bio.name.length * 131 + k);
  // gene edits: what the world asks of an adapted body, and what medicine of the era gives everyone
  const edits: Edit[] = [];
  if (adapted) {
    if (env.g < 0.7) edits.push(EDITS.SOST);
    if (env.g > 1.25) edits.push(EDITS.MSTN);
    if (env.rad === 'airless' || env.rad === 'harsh' || env.rad === 'thin') edits.push(EDITS.Dsup);
    if (env.temp < 160 && env.kind !== 'ship') edits.push(EDITS.UCP1);
    if (env.kind === 'ocean' && env.home !== world.earth) edits.push(EDITS.PDE10A);
    if (env.rad === 'thin') edits.push(EDITS.EPAS1);
  }
  if (tech.genMed && h(1) < 0.55) edits.push(EDITS.PCSK9);
  if (tech.lifeExt && age > 25) edits.push(EDITS.TERT);
  // build: adapted bodies are engineered for their gravity; baseline bodies drift with it
  const g = env.g;
  const slender = adapted ? (g < 0.7 ? 0.86 : g > 1.25 ? 1.14 : 1) : 1 + (g - 1) * 0.04;
  const settled = age > 2;
  const bone = adapted && g < 0.7 ? 1.02 : adapted && g > 1.25 ? 1.12 : settled ? Math.min(1.12, Math.max(0.62, Math.pow(Math.max(0.05, g), 0.25))) : 1;
  const fat = adapted && env.temp < 160 ? 1.5 : 1;
  const grow = Math.min(1, 0.29 + 0.71 * Math.pow(Math.min(age, 18) / 18, 0.7));
  const heightM = (bio.height / 100) * grow;
  const massKg = 22 * heightM * heightM * slender * slender * (age < 16 ? 0.8 : 1) * (0.92 + 0.16 * h(2));
  const parts: PartId[] = uploaded
    ? ['core', 'memory', 'optic', 'cooling', 'power', 'shield', 'avatar']
    : ['brain', 'heart', 'lungs', 'liver', 'kidneys', 'gut', 'bone', 'muscle', 'skin', 'blood'];
  if (!uploaded && tech.neuralLace && age >= 16 && h(3) < 0.7) parts.push('lace');
  if (!uploaded && tech.nanofab) parts.push('nano');
  const key = [bio.id, uploaded, adapted, Math.round(heightM * 100), parts.length, edits.map((e) => e.gene).join(','), Math.round(bone * 100), bio.status].join('|');
  return {
    key, pid: bio.id, name: bio.name, sex: bio.sex, age, alive: bio.status === 'alive' || bio.status === 'travelling', status: bio.status,
    form: uploaded ? 'substrate' : 'flesh', adapted, bodyWord: word, env, heightM, massKg, slender, bone, fat, edits, tech, parts, year,
  };
}

/** The tissue under each part of a body. */
export const PART_CELL: Record<PartId, CellId> = {
  brain: 'neuron', heart: 'cardio', lungs: 'pneumo', liver: 'hepato', kidneys: 'tubule', gut: 'bacterium', bone: 'osteocyte',
  muscle: 'myofibre', skin: 'keratino', blood: 'rbc', lace: 'neuron', nano: 'respirocyte',
  core: 'logic', memory: 'memtile', optic: 'photonic', cooling: 'coolant', power: 'bus', shield: 'shieldtile', avatar: 'logic',
};

/** A stable small integer from a person id, for procedural detail that must not change between looks. */
export function pidHash(pid: string, k = 0): number {
  let x = 0;
  for (let i = 0; i < pid.length; i++) x = (x * 31 + pid.charCodeAt(i)) | 0;
  return hash01(x, k);
}
