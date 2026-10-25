// Emergent invention (research/invention-model.md §4): known technologies
// recombine into new, named inventions. Each has two parents, a field, one
// effect on the engine (damped so effects never explode), a date, a place and
// an inventor. Different futures invent different things in different orders.

import { TECHS } from './catalog.ts';
import { hash01 } from './rng.ts';

export type Field = 'P' | 'E' | 'B' | 'M' | 'I' | 'H';
export const FIELDS: Field[] = ['P', 'E', 'B', 'M', 'I', 'H'];
export const FIELD_NAMES: Record<Field, string> = { P: 'propulsion', E: 'energy', B: 'biology', M: 'materials', I: 'information', H: 'habitat' };

/** Field of each spine tech. */
const SPINE_FIELD: Record<string, Field> = {
  isru: 'M', closedLoop: 'B', kilopower: 'E', reusable: 'P', synthBio: 'B', regolith: 'H', ntp: 'P', robotics: 'I',
  radShield: 'H', quantumComp: 'I', genMed: 'B', asteroidMining: 'M', cloudCities: 'H', starshot: 'P', agi: 'I',
  fusion: 'E', subIce: 'H', carbonNano: 'M', orbitalHabitats: 'H', neuralLace: 'I', magShield: 'H', he3Fusion: 'E',
  spaceElevator: 'P', fusionDrive: 'P', bioAdapt: 'B', genShip: 'P', paraterraform: 'H', psychohistory: 'I',
  laserComms: 'I', cryo: 'B', nanofab: 'M', lifeExt: 'B', terraform: 'H', dyson1: 'E', seedShips: 'B', laserSail: 'P',
  vonNeumann: 'M', bishopRings: 'H', antimatter: 'E', mindUpload: 'I', dyson2: 'E', bussard: 'P', starLifting: 'E',
  matrioshka: 'I', warp: 'P', wormholes: 'P',
};
export const spineField = (i: number): Field => SPINE_FIELD[TECHS[i]?.id] ?? 'M';

/** Field compatibility (bible-style W matrix). */
const W: Record<Field, Record<Field, number>> = {
  P: { P: 0.6, E: 0.9, B: 0.2, M: 0.9, I: 0.5, H: 0.4 },
  E: { P: 0.9, E: 0.6, B: 0.3, M: 0.7, I: 0.7, H: 0.6 },
  B: { P: 0.2, E: 0.3, B: 0.6, M: 0.4, I: 0.7, H: 0.8 },
  M: { P: 0.9, E: 0.7, B: 0.4, M: 0.6, I: 0.6, H: 0.9 },
  I: { P: 0.5, E: 0.7, B: 0.7, M: 0.6, I: 0.6, H: 0.5 },
  H: { P: 0.4, E: 0.6, B: 0.8, M: 0.9, I: 0.5, H: 0.6 },
};
export const compat = (a: Field, b: Field) => W[a][b];

/** Engine effect keys a field pair improves. `mul` keys multiply, `add` keys add, `down` keys shrink. */
export const EFFECTS = ['energy', 'extract', 'habitat', 'lifeSupport', 'research', 'productivity', 'death', 'growth', 'launch', 'voyage', 'shipSpeed', 'reliability', 'hab', 'habHostile'] as const;
export type EffectKey = typeof EFFECTS[number];
const ADD = new Set<EffectKey>(['shipSpeed', 'reliability', 'hab', 'habHostile']);
const DOWN = new Set<EffectKey>(['death', 'launch']);
const PAIR_EFFECT: Record<string, EffectKey[]> = {
  PP: ['shipSpeed', 'voyage'], PE: ['voyage', 'shipSpeed'], PM: ['launch', 'reliability'], PI: ['reliability'], PH: ['launch'], PB: ['voyage'],
  EE: ['energy'], EM: ['energy', 'extract'], EI: ['research', 'energy'], EH: ['habHostile', 'energy'], EB: ['lifeSupport'],
  BB: ['death', 'lifeSupport'], BM: ['growth'], BI: ['death', 'research'], BH: ['lifeSupport', 'hab'],
  MM: ['habitat', 'extract'], MI: ['productivity', 'extract'], MH: ['habitat', 'habHostile'],
  II: ['research', 'productivity'], IH: ['productivity'], HH: ['hab', 'habitat'],
};
export function effectFor(a: Field, b: Field, u: number): EffectKey {
  const k = PAIR_EFFECT[a + b] ?? PAIR_EFFECT[b + a] ?? ['productivity'];
  return k[Math.floor(u * k.length)];
}

/**
 * Size of one generated invention's effect, as a factor (mul/down) or an increment (add).
 * Heavy-tailed draw r, decay with combination depth, and saturation per key:
 * the 30th refinement of the same thing matters far less than the first.
 */
export function effectSize(key: EffectKey, r: number, depth: number, nSameKey: number): number {
  const m = r * Math.pow(0.7, depth - 1) * Math.exp(-nSameKey / 30);
  if (key === 'shipSpeed') return 0.0015 * m;
  if (key === 'reliability') return 0.006 * m;
  if (key === 'hab' || key === 'habHostile') return 0.004 * m;
  return 1 + 0.025 * m; // mul and down keys both store the improvement factor
}
export const isAdd = (k: EffectKey) => ADD.has(k);
export const isDown = (k: EffectKey) => DOWN.has(k);

// ---------------------------------------------------------------- names (used by the Chronicle)

const DEVICE: Record<Field, string[]> = {
  P: ['Thruster', 'Nozzle', 'Torch', 'Sail', 'Drive', 'Scoop', 'Tether', 'Catapult', 'Keel', 'Lofter'],
  E: ['Reactor', 'Collector', 'Accumulator', 'Lens', 'Cell', 'Furnace', 'Capacitor', 'Mirror', 'Turbine', 'Pile'],
  B: ['Graft', 'Bloom', 'Vat', 'Loop', 'Serum', 'Culture', 'Ferment', 'Splice', 'Garden', 'Tonic'],
  M: ['Hawser', 'Lattice', 'Foundry', 'Loom', 'Press', 'Weave', 'Kiln', 'Mill', 'Anvil', 'Crucible'],
  I: ['Forecaster', 'Mind', 'Archive', 'Relay', 'Array', 'Oracle', 'Ledger', 'Choir', 'Lens', 'Index'],
  H: ['Warren', 'Dome', 'Hull', 'Shield', 'Garden', 'Vault', 'Ring', 'Burrow', 'Canopy', 'Cistern'],
};
const MATERIAL: Record<Field, string[]> = {
  P: ['Boron', 'Tungsten', 'Graphene', 'Lithium', 'Xenon'], E: ['Helium-3', 'Perovskite', 'Hafnium', 'Deuterium', 'Sodium'],
  B: ['Chlorella', 'Basalt', 'Keratin', 'Mycelium', 'Tardigrade'], M: ['Diamond', 'Aerogel', 'Carbyne', 'Nanotube', 'Ferrite'],
  I: ['Sapphire', 'Niobium', 'Glass', 'Photonic', 'Qubit'], H: ['Regolith', 'Ice', 'Ferrite', 'Brine', 'Lava-glass'],
};
const ADJ: Record<Field, string[]> = {
  P: ['Cold', 'Pulsed', 'Annular', 'Toroidal', 'Staged'], E: ['Aneutronic', 'Coherent', 'Cascading', 'Resonant', 'Quiet'],
  B: ['Lead-Tolerant', 'Slow-Metabolic', 'Symbiotic', 'Hardy', 'Dormant'], M: ['Woven', 'Gradient', 'Self-Annealing', 'Grown', 'Folded'],
  I: ['Recursive', 'Deep', 'Patient', 'Consensus', 'Distributed'], H: ['Buried', 'Spun', 'Sealed', 'Terraced', 'Mirrored'],
};
const GREEK = ['Alpha', 'Sigma', 'Theta', 'Kappa', 'Omega', 'Delta', 'Lambda'];
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'IX'];
const pickS = <T>(xs: T[], u: number) => xs[Math.floor(u * xs.length) % xs.length];

export function inventionName(seed: number, field: Field, other: Field, surname: string, place: string): string {
  const u = (k: number) => hash01(seed, 911, k);
  const dev = pickS(DEVICE[field], u(1)), mat = pickS(MATERIAL[other], u(2)), adj = pickS(ADJ[field], u(3));
  switch (Math.floor(u(4) * 12)) {
    case 0: return `${surname} ${dev}`;
    case 1: return `${mat}-${pickS(DEVICE[other], u(5))} ${dev}`;
    case 2: return `${adj} ${mat} ${dev}`;
    case 3: return `${place} Process`;
    case 4: return `${pickS(GREEK, u(6))}-${mat} ${dev}`;
    case 5: return `${surname}'s ${dev}`;
    case 6: return `${dev} Mk ${pickS(ROMAN, u(7))}`;
    case 7: return `Self-${['Repairing', 'Annealing', 'Tuning', 'Seeding', 'Balancing'][Math.floor(u(8) * 5)]} ${dev}`;
    case 8: return `Distributed ${dev} Mesh`;
    case 9: return `${place}-pattern ${pickS(DEVICE.H, u(9))}`;
    case 10: return `${surname} Protocol`;
    default: return `${adj} ${dev} Array`;
  }
}

export function effectText(key: EffectKey, size: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  switch (key) {
    case 'energy': return `${pct(size - 1)} more energy per person`;
    case 'extract': return `${pct(size - 1)} more out of every mine and ice field`;
    case 'habitat': return `${pct(size - 1)} more room in every habitat`;
    case 'lifeSupport': return `${pct(size - 1)} more people per tonne of life support`;
    case 'research': return `research ${pct(size - 1)} faster`;
    case 'productivity': return `${pct(size - 1)} more made per hour of work`;
    case 'death': return `deaths down ${pct(1 - 1 / size)}`;
    case 'growth': return `${pct(size - 1)} more children survive to adulthood`;
    case 'launch': return `launch costs down ${pct(1 - 1 / size)}`;
    case 'voyage': return `ships ${pct(size - 1)} longer-lived in flight`;
    case 'shipSpeed': return `ships ${(size * 100).toFixed(2)}% of light speed faster`;
    case 'reliability': return `${pct(size)} fewer ships and habitats lost`;
    case 'hab': return `worlds ${pct(size)} more habitable`;
    case 'habHostile': return `hostile worlds ${pct(size)} more survivable`;
  }
}
