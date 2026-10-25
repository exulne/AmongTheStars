// Observed historical impacts: the validation cases and the "Historical
// observation" layer of the impact lab. Values are the published estimates,
// with their ranges; where an estimate is contested the range says so.

import type { Provenance } from '../data/provenance.ts';

export interface ObservedImpact {
  id: string;
  body: string;
  date: string;
  name: string;
  /** published impactor estimates */
  diameterM: [number, number, number];
  speedKms?: number; angleDeg?: number; densityKgM3?: number;
  /** bulk strength (Pa) and target material the validation uses, where the published case needs them (scripts/impact-check.ts) */
  strengthPa?: number; material?: import('./bodies.ts').Material;
  energyMt?: [number, number, number];
  outcome: 'airburst' | 'ground-impact' | 'deep-deposition' | 'small-crater';
  observed: string;
  /** what the model should reproduce, for the checks */
  check?: { burstAltKm?: [number, number]; craterM?: [number, number]; depositionAltKm?: [number, number] };
  sources: Provenance[];
}

const R = '2026-10-25T00:00:00Z';
const src = (organization: string, url: string, note?: string): Provenance => ({ organization, url, retrieved: R, basis: 'reported', quality: 'high', note });

export const OBSERVED_IMPACTS: ObservedImpact[] = [
  {
    id: 'chelyabinsk-2013', body: 'Earth', date: '2013-02-15', name: 'Chelyabinsk airburst',
    diameterM: [15, 19.8, 24], speedKms: 19.03, angleDeg: 18.3, densityKgM3: 3300, energyMt: [0.4, 0.5, 0.6], outcome: 'airburst',
    observed: 'Superbolide over Chelyabinsk, Russia: peak brightness near 30 km altitude, about 500 kt; the shock wave broke windows across the region and injured about 1,600 people, mostly from glass.',
    check: { burstAltKm: [20, 45] },
    sources: [src('Popova et al. 2013, Science 342:1069', 'https://doi.org/10.1126/science.1242642'), src('NASA/JPL CNEOS fireball data', 'https://cneos.jpl.nasa.gov/fireballs/')],
  },
  {
    id: 'tunguska-1908', body: 'Earth', date: '1908-06-30', name: 'Tunguska event',
    diameterM: [40, 60, 80], speedKms: 18, angleDeg: 35, densityKgM3: 3000, energyMt: [3, 10, 15], outcome: 'airburst',
    observed: 'Airburst over Siberia that flattened about 2,000 km² of forest; no crater. Energy estimates range from about 3 to 15 Mt.',
    check: { burstAltKm: [3, 20] },
    sources: [src('NASA Science, "The Tunguska Impact – 100 Years Later" (2008)', 'https://science.nasa.gov/science-research/planetary-science/the-tunguska-impact-100-years-later/')],
  },
  {
    id: 'meteor-crater', body: 'Earth', date: '−50,000 (approx.)', name: 'Barringer (Meteor) Crater',
    diameterM: [40, 50, 60], speedKms: 12.8, angleDeg: 45, densityKgM3: 7800, strengthPa: 2e8, material: 'soft-rock', outcome: 'ground-impact',
    observed: 'A 1.2 km simple crater in Arizona made by an iron impactor about 50 m across, roughly 50,000 years ago.',
    check: { craterM: [800, 1500] },
    sources: [src('USGS / Kring 2007, Guidebook to the Geology of Barringer Meteorite Crater', 'https://www.lpi.usra.edu/publications/books/barringer_crater_guidebook/')],
  },
  {
    id: 'sl9-1994', body: 'Jupiter', date: '1994-07-16', name: 'Comet Shoemaker–Levy 9',
    diameterM: [300, 1000, 2000], speedKms: 60, angleDeg: 45, densityKgM3: 500, energyMt: [1e5, 6e6, 1e7], outcome: 'deep-deposition',
    observed: 'Twenty-one fragments struck Jupiter over six days. Plumes rose about 3,000 km above the cloud tops and left dark scars, some larger than Earth, that lasted for weeks. The largest (fragment G) released energy equivalent to about 6 million megatons of TNT. No crater: Jupiter has no surface to make one in.',
    check: { depositionAltKm: [-200, 150] },
    sources: [src('NASA Science, Comet Shoemaker–Levy 9', 'https://science.nasa.gov/solar-system/comets/shoemaker-levy-9/')],
  },
  {
    id: 'jupiter-2009', body: 'Jupiter', date: '2009-07-19', name: 'Jupiter impact scar (Wesley)',
    diameterM: [200, 300, 500], outcome: 'deep-deposition',
    observed: 'A dark debris field found by amateur astronomer Anthony Wesley and imaged by Hubble, from an impactor a few hundred metres across.',
    sources: [src('NASA, Hubble images of the 2009 Jupiter impact', 'https://science.nasa.gov/missions/hubble/')],
  },
  {
    id: 'mars-2021', body: 'Mars', date: '2021-12-24', name: 'Amazonis Planitia impact (InSight-detected)',
    diameterM: [5, 8, 12], speedKms: 10, angleDeg: 45, densityKgM3: 3000, strengthPa: 5e6, outcome: 'ground-impact',
    observed: 'InSight recorded a magnitude-4 marsquake; Mars Reconnaissance Orbiter found a fresh crater about 150 m across with ice blocks in its ejecta.',
    check: { craterM: [80, 300] },
    sources: [src('NASA JPL news, 2022-10-27', 'https://www.jpl.nasa.gov/news/nasas-insight-lander-detects-stunning-meteoroid-impact-on-mars/')],
  },
  {
    id: 'moon-2013', body: 'Moon', date: '2013-03-17', name: 'Lunar impact flash (NASA Meteoroid Environment Office)',
    diameterM: [0.3, 0.35, 0.4], speedKms: 25.6, angleDeg: 45, densityKgM3: 3000, material: 'sand', outcome: 'small-crater',
    observed: 'A 40 kg meteoroid made a flash visible from Earth; Lunar Reconnaissance Orbiter later found its crater, about 18 m across.',
    check: { craterM: [8, 40] },
    sources: [src('NASA, "Bright Explosion on the Moon" (2013)', 'https://science.nasa.gov/science-research/planetary-science/17may_lunarimpact/')],
  },
  {
    id: '2008-tc3', body: 'Earth', date: '2008-10-07', name: '2008 TC3 (Almahata Sitta)',
    diameterM: [3, 4, 5], speedKms: 12.4, densityKgM3: 2000, outcome: 'airburst',
    observed: 'The first asteroid found before it struck Earth, about 19 hours ahead; it exploded over Sudan and meteorites were recovered.',
    sources: [src('NASA/JPL CNEOS', 'https://cneos.jpl.nasa.gov/news/2008tc3.html')],
  },
];

export const NO_OBSERVED = { Mercury: 'No impact on Mercury has been observed directly; its craters record an ancient and ongoing flux.', Venus: 'No impact on Venus has been observed directly; the thick atmosphere screens out small bodies (no craters below ≈ 2 km).', Saturn: 'Impact flashes on Saturn have been searched for by amateurs without detections so far (Hueso et al. 2018).', Uranus: 'No observed impacts.', Neptune: 'No observed impacts.' } as Record<string, string>;
