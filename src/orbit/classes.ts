// Satellite-class priors for the drag and lifecycle models. Mass, drag area,
// drag coefficient, propulsion and design life are not public for most
// spacecraft, so each is a documented low/nominal/high range with its basis
// (R reported, E engineering estimate from public dimensions or physics,
// D design assumption). Observed objects are mapped to a class by name and
// catalogue number; that mapping is itself an inference and says so.

import { ranged, type Ranged } from '../data/provenance.ts';

export interface ClassPrior {
  id: string;
  label: string;
  massKg: Ranged;
  /** drag area in the normal operating attitude, m² */
  dragAreaM2: Ranged;
  /** area in a low-drag ("edge-on") attitude relative to normal; 1 if the vehicle has none */
  lowDragFactor: Ranged;
  /** free-molecular drag coefficient */
  cd: Ranged;
  propulsion: null | { thrustN: Ranged; ispS: Ranged; propellantKg: Ranged; dutyCycle: number };
  designLifeYears: Ranged;
  /** probability the end-of-life disposal manoeuvre succeeds */
  disposalSuccess: Ranged;
  /** fraction of dry mass expected to survive reentry */
  survivingFraction: Ranged;
  /** recurring unit cost, USD 2024 */
  unitCostUsd: Ranged;
  note: string;
}

const CD = (src = 'Moe & Moe 2005 (Planet. Space Sci. 53, 793): physical drag coefficients of satellites in LEO typically 2.0–2.6; 2.2 is the conventional value') => ranged(2.2, 2.0, 2.6, '', 'estimated', src);

export const CLASSES: Record<string, ClassPrior> = {
  'starlink-v1.5': {
    id: 'starlink-v1.5', label: 'Starlink v1.0/v1.5 class (flat-panel, single array)',
    massKg: ranged(295, 260, 310, 'kg', 'reported', 'SpaceX: ≈260 kg (v1.0); ≈295–306 kg reported for v1.5'),
    dragAreaM2: ranged(12, 4, 23, 'm²', 'estimated', 'From public dimensions: bus ≈ 2.8 × 1.4 m, one array ≈ 8 × 2.8 m; area depends on array angle'),
    lowDragFactor: ranged(0.2, 0.12, 0.35, '×', 'estimated', 'SpaceX described flying "edge-on like a sheet of paper" in safe mode (February 2022)'),
    cd: CD(),
    propulsion: { thrustN: ranged(0.06, 0.03, 0.1, 'N', 'estimated', 'Krypton Hall thruster; thrust not published (D)'), ispS: ranged(1300, 1000, 1600, 's', 'estimated', 'Typical krypton Hall-effect thruster'), propellantKg: ranged(20, 10, 35, 'kg', 'simulated', 'Not published: design assumption'), dutyCycle: 0.5 },
    designLifeYears: ranged(5, 4, 7, 'yr', 'reported', 'SpaceX: about five-year design life'),
    disposalSuccess: ranged(0.97, 0.9, 0.995, '', 'estimated', 'Low-orbit propulsive deorbit plus natural decay below 600 km'),
    survivingFraction: ranged(0, 0, 0.02, '', 'estimated', 'SpaceX: designed to demise fully'),
    unitCostUsd: ranged(0.5e6, 0.25e6, 1.5e6, 'USD 2024', 'simulated', 'Not public: design assumption'),
    note: 'Validation class for the February 2022 storm loss.',
  },
  'starlink-v2mini': {
    id: 'starlink-v2mini', label: 'Starlink v2 mini class',
    massKg: ranged(800, 730, 850, 'kg', 'reported', 'SpaceX: ≈800 kg'),
    dragAreaM2: ranged(30, 10, 60, 'm²', 'estimated', 'SpaceX: two arrays totalling ≈116 m²; drag area depends on array angle'),
    lowDragFactor: ranged(0.2, 0.12, 0.35, '×', 'estimated', 'Assumed similar to v1.5'),
    cd: CD(),
    propulsion: { thrustN: ranged(0.17, 0.12, 0.17, 'N', 'reported', 'SpaceX (2023): argon Hall thruster, 170 mN'), ispS: ranged(2500, 2000, 2500, 's', 'reported', 'SpaceX (2023): 2,500 s'), propellantKg: ranged(40, 20, 70, 'kg', 'simulated', 'Not published: design assumption'), dutyCycle: 0.5 },
    designLifeYears: ranged(5, 4, 7, 'yr', 'estimated', 'Assumed similar to v1.5'),
    disposalSuccess: ranged(0.97, 0.9, 0.995, '', 'estimated', 'As v1.5'),
    survivingFraction: ranged(0, 0, 0.03, '', 'estimated', 'Designed to demise'),
    unitCostUsd: ranged(0.8e6, 0.4e6, 2e6, 'USD 2024', 'simulated', 'Not public: design assumption'),
    note: '',
  },
  'kuiper': {
    id: 'kuiper', label: 'Amazon Leo (Kuiper) class',
    massKg: ranged(600, 450, 800, 'kg', 'simulated', 'Not published by Amazon: design assumption'),
    dragAreaM2: ranged(20, 8, 40, 'm²', 'simulated', 'Not published: design assumption'),
    lowDragFactor: ranged(0.3, 0.15, 0.5, '×', 'simulated', 'Assumed'),
    cd: CD(),
    propulsion: { thrustN: ranged(0.1, 0.05, 0.2, 'N', 'simulated', 'Assumed electric propulsion'), ispS: ranged(1500, 1000, 2500, 's', 'simulated', 'Assumed'), propellantKg: ranged(40, 20, 80, 'kg', 'simulated', 'Assumed'), dutyCycle: 0.5 },
    designLifeYears: ranged(7, 5, 10, 'yr', 'simulated', 'Assumed'),
    disposalSuccess: ranged(0.95, 0.85, 0.99, '', 'estimated', 'Assumed; FCC requires a disposal plan'),
    survivingFraction: ranged(0.01, 0, 0.05, '', 'estimated', 'Assumed'),
    unitCostUsd: ranged(1e6, 0.5e6, 3e6, 'USD 2024', 'simulated', 'Not public: design assumption'),
    note: 'Owner Amazon. Every property here is an assumption.',
  },
  'oneweb': {
    id: 'oneweb', label: 'OneWeb Gen 1 class',
    massKg: ranged(148, 145, 150, 'kg', 'reported', 'OneWeb/Airbus: ≈150 kg'),
    dragAreaM2: ranged(3, 1.5, 6, 'm²', 'estimated', 'From public dimensions'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'No low-drag mode modelled'),
    cd: CD(),
    propulsion: { thrustN: ranged(0.02, 0.01, 0.04, 'N', 'estimated', 'Xenon Hall thruster (assumed)'), ispS: ranged(1500, 1200, 1800, 's', 'estimated', 'Assumed'), propellantKg: ranged(10, 5, 20, 'kg', 'simulated', 'Assumed'), dutyCycle: 0.5 },
    designLifeYears: ranged(5, 5, 7, 'yr', 'reported', 'OneWeb: ≥ 5 years'),
    disposalSuccess: ranged(0.95, 0.85, 0.99, '', 'estimated', 'Assumed'),
    survivingFraction: ranged(0.01, 0, 0.05, '', 'estimated', 'Assumed'),
    unitCostUsd: ranged(1e6, 0.5e6, 2e6, 'USD 2024', 'simulated', 'Assumed'),
    note: '≈1,200 km shell: drag is small; lifetime is set by propulsion and design life.',
  },
  'iss': {
    id: 'iss', label: 'International Space Station',
    massKg: ranged(419725, 410000, 450000, 'kg', 'reported', 'NASA ISS facts: 925,335 lb'),
    dragAreaM2: ranged(1700, 1000, 2500, 'm²', 'estimated', 'Depends strongly on solar-array orientation'),
    lowDragFactor: ranged(0.7, 0.6, 0.8, '×', 'estimated', 'Arrays feathered ("night glider")'),
    cd: CD(),
    propulsion: { thrustN: ranged(1500, 600, 3000, 'N', 'estimated', 'Reboost by visiting vehicles and the Service Module (episodic)'), ispS: ranged(300, 280, 310, 's', 'estimated', 'Storable bipropellant'), propellantKg: ranged(7000, 4000, 10000, 'kg', 'simulated', 'Per year of reboost resupply (assumed)'), dutyCycle: 0.002 },
    designLifeYears: ranged(5, 3, 8, 'yr', 'reported', 'NASA plans retirement around 2030 with a deorbit vehicle'),
    disposalSuccess: ranged(0.99, 0.95, 0.999, '', 'estimated', 'Controlled deorbit (US Deorbit Vehicle)'),
    survivingFraction: ranged(0.1, 0.05, 0.2, '', 'estimated', 'Large dense structures survive in part'),
    unitCostUsd: ranged(150e9, 100e9, 200e9, 'USD 2024', 'estimated', 'Programme cost order of magnitude (not a unit cost)'),
    note: '',
  },
  'hst': {
    id: 'hst', label: 'Hubble Space Telescope',
    massKg: ranged(11110, 10900, 11300, 'kg', 'reported', 'NASA: 24,500 lb'),
    dragAreaM2: ranged(60, 40, 90, 'm²', 'estimated', 'Tube 13.2 × 4.2 m plus arrays'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'None'),
    cd: CD(),
    propulsion: null,
    designLifeYears: ranged(40, 30, 50, 'yr', 'estimated', 'Operating since 1990'),
    disposalSuccess: ranged(0, 0, 0, '', 'estimated', 'No propulsion: natural decay or a future reboost/deorbit mission'),
    survivingFraction: ranged(0.2, 0.1, 0.4, '', 'estimated', 'Mirror and large structures may survive'),
    unitCostUsd: ranged(10e9, 5e9, 16e9, 'USD 2024', 'estimated', 'Programme cost order of magnitude'),
    note: '',
  },
  'cubesat': {
    id: 'cubesat', label: 'CubeSat (1U–6U, unpropelled)',
    massKg: ranged(4, 1.3, 12, 'kg', 'reported', 'Cal Poly CubeSat Design Specification rev 14: 1U ≤ 2 kg, 3U ≤ 6 kg, 6U ≤ 12 kg'),
    dragAreaM2: ranged(0.05, 0.01, 0.2, 'm²', 'estimated', 'Mean tumbling cross-section incl. deployables'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'None'),
    cd: CD(),
    propulsion: null,
    designLifeYears: ranged(2, 0.5, 5, 'yr', 'estimated', 'Typical mission'),
    disposalSuccess: ranged(0, 0, 0, '', 'estimated', 'No propulsion'),
    survivingFraction: ranged(0, 0, 0.05, '', 'estimated', 'Small, demises'),
    unitCostUsd: ranged(0.3e6, 0.05e6, 2e6, 'USD 2024', 'estimated', 'Broad range'),
    note: '',
  },
  'generic-leo': {
    id: 'generic-leo', label: 'Unknown LEO spacecraft (class unknown)',
    massKg: ranged(300, 50, 2000, 'kg', 'simulated', 'Unknown: broad prior'),
    dragAreaM2: ranged(5, 1, 30, 'm²', 'simulated', 'Unknown: broad prior'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'None assumed'),
    cd: CD(),
    propulsion: null,
    designLifeYears: ranged(7, 3, 15, 'yr', 'simulated', 'Unknown'),
    disposalSuccess: ranged(0.5, 0, 0.9, '', 'simulated', 'Unknown'),
    survivingFraction: ranged(0.1, 0, 0.4, '', 'simulated', 'Unknown'),
    unitCostUsd: ranged(50e6, 1e6, 500e6, 'USD 2024', 'simulated', 'Unknown'),
    note: 'Used when nothing better is known: ranges are deliberately wide.',
  },
  'debris': {
    id: 'debris', label: 'Rocket body or debris',
    massKg: ranged(500, 1, 9000, 'kg', 'simulated', 'Unknown'),
    dragAreaM2: ranged(4, 0.01, 40, 'm²', 'simulated', 'Unknown'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'None'),
    cd: CD(),
    propulsion: null,
    designLifeYears: ranged(0, 0, 0, 'yr', 'estimated', 'Not operational'),
    disposalSuccess: ranged(0, 0, 0, '', 'estimated', 'None'),
    survivingFraction: ranged(0.2, 0.05, 0.5, '', 'estimated', 'Upper stages often leave surviving tanks'),
    unitCostUsd: ranged(0, 0, 0, 'USD 2024', 'estimated', 'Not an asset'),
    note: '',
  },
  'geo': {
    id: 'geo', label: 'Geostationary or MEO spacecraft',
    massKg: ranged(3500, 1500, 6500, 'kg', 'estimated', 'Typical GEO comsat'),
    dragAreaM2: ranged(40, 10, 100, 'm²', 'estimated', 'Irrelevant: no meaningful drag at these altitudes'),
    lowDragFactor: ranged(1, 1, 1, '×', 'estimated', 'None'),
    cd: CD(),
    propulsion: { thrustN: ranged(0.2, 0.1, 22, 'N', 'estimated', 'Chemical or electric stationkeeping'), ispS: ranged(1500, 300, 2000, 's', 'estimated', 'Mixed'), propellantKg: ranged(500, 100, 2000, 'kg', 'estimated', 'Typical'), dutyCycle: 0.01 },
    designLifeYears: ranged(15, 12, 20, 'yr', 'estimated', 'Typical GEO design life'),
    disposalSuccess: ranged(0.85, 0.7, 0.95, '', 'estimated', 'Re-orbit to a graveyard orbit (no reentry)'),
    survivingFraction: ranged(0, 0, 0, '', 'estimated', 'Does not reenter'),
    unitCostUsd: ranged(250e6, 100e6, 500e6, 'USD 2024', 'estimated', 'Typical'),
    note: 'Stationkeeping here fights lunisolar and radiation-pressure perturbations, not drag; those are acknowledged, not modelled.',
  },
};

export type ClassId = keyof typeof CLASSES;

/** Starlink v2 mini launches began in February 2023; earlier catalogue numbers are v1.x. An inference, labelled as such. */
const V2_FIRST_NORAD = 55500;

export function classOf(name: string, norad: number, perigeeKm: number): { cls: ClassId; inferred: string } {
  const n = name.toUpperCase();
  if (n.startsWith('STARLINK')) return norad >= V2_FIRST_NORAD ? { cls: 'starlink-v2mini', inferred: 'Starlink by name; v2 mini by catalogue number (inferred)' } : { cls: 'starlink-v1.5', inferred: 'Starlink by name; v1.x by catalogue number (inferred)' };
  if (n.startsWith('KUIPER') || n.startsWith('AMAZON')) return { cls: 'kuiper', inferred: 'by name' };
  if (n.startsWith('ONEWEB')) return { cls: 'oneweb', inferred: 'by name' };
  if (n.startsWith('ISS (')) return { cls: 'iss', inferred: 'by name' };
  if (n === 'HST') return { cls: 'hst', inferred: 'by name' };
  if (/R\/B|DEB|\bDEBRIS\b/.test(n)) return { cls: 'debris', inferred: 'by name (rocket body or debris)' };
  if (perigeeKm > 2000) return { cls: 'geo', inferred: 'by altitude (above LEO)' };
  return { cls: 'generic-leo', inferred: 'unknown class: broad prior' };
}
