// Mission and launch economics: a transparent, auditable scenario model of what
// it costs to move people and cargo, built from public evidence. It does NOT
// know SpaceX's (or anyone's) internal costs: every input is a range with its
// provenance (R reported, E engineering estimate, D design assumption), and
// every output can be recomputed from the mission spec, its context and an
// assumption set. Pure functions only: no engine state, no Math.random.
// Formulas and limitations: research/launch-economics.md.

import { next, seedRng } from './rng.ts';
import type { Body, World } from './world.ts';

export const MODEL_VERSION = '1.0.0';
export const ASSUMPTIONS_VERSION = '2026-10-24';
export const CURRENCY = 'USD 2024 (1 credit = 1 USD 2024)';

// ---------------------------------------------------------------- provenance

export type EvidenceClass = 'R' | 'E' | 'D';
export type Confidence = 'high' | 'medium' | 'low';

export interface SourceRef { title: string; url: string; date: string }

export const SOURCES = {
  spacex: { title: 'SpaceX, Starship vehicle page (100+ t to orbit reusable; ship ≈1,600 t and booster ≈3,650 t of propellant; 6 and 33 Raptor engines; liquid methane and oxygen)', url: 'https://www.spacex.com/vehicles/starship/', date: '2025' },
  faaKsc: { title: 'FAA, SpaceX Starship-Super Heavy at KSC LC-39A: EIS and Record of Decision (up to 44 launches/yr; analysed loads ≈2,650 t ship, ≈4,100 t booster)', url: 'https://www.faa.gov/space/stakeholder_engagement/spacex_starship_ksc', date: '2026-01-30' },
  faaStarbase: { title: 'FAA, Starbase tiered environmental assessment and Record of Decision (up to 25 launches/yr, ≈24,000 truck trips/yr, +10.27 M gal water/yr)', url: 'https://www.faa.gov/space/stakeholder_engagement/spacex_starship', date: '2025-05-06' },
  nasaCeh: { title: 'NASA Cost Estimating Handbook (WBS, recurring vs non-recurring, learning curves, cost-risk ranges)', url: 'https://www.nasa.gov/ocfo/ppc-corner/nasa-cost-estimating-handbook-ceh/', date: '2015 (v4.0)' },
  nasaHls: { title: 'NASA, NextSTEP-H Human Landing System (firm-fixed-price milestone contracts: Option A 2021, Option B 2022); program-level reference only', url: 'https://www.nasa.gov/humans-in-space/nextstep-h-human-landing-system/', date: '2022-11-15' },
  tankerEstimates: { title: 'Public HLS tanker-count estimates: NASA presentation 8–16 tankers of 100–150 t; GAO 2021 16 launches; NASA 2023 "high teens"; SpaceX ≤ 8 (orientation)', url: 'https://en.wikipedia.org/wiki/Starship_HLS', date: '2025' },
  eiaGas: { title: 'EIA, Natural Gas Prices: US industrial average 2024 $4.07/Mcf (Natural Gas Annual, table 23); monthly 2026 $4.2–8.4/Mcf', url: 'https://www.eia.gov/dnav/ng/NG_PRI_SUM_A_EPG0_PIN_DMCF_M.htm', date: '2026-09' },
  eiaElec: { title: 'EIA, Electric Power Monthly table 5.6.A: average industrial retail price ≈8 ¢/kWh (2024)', url: 'https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a', date: '2025' },
  ntrs: { title: 'NASA Technical Reports Server: methane/oxygen propulsion, cryogenic fluid management, Mars ISRU studies', url: 'https://ntrs.nasa.gov/', date: 'various' },
  falcon9: { title: 'SpaceX, Falcon 9 (boosters reflown 30+ times; ≈99% mission success; reported)', url: 'https://www.spacex.com/vehicles/falcon-9/', date: '2025' },
  bible: { title: '2SOON2026 simulation bible §1.2 launch cost, §1.3 vehicles, §1.4 transfers, §3.6 propulsion, §7.5 transport', url: 'research/simulation-bible.md', date: '2026' },
  model: { title: '2SOON2026 launch-economics design assumption (no public data)', url: 'research/launch-economics.md', date: '2026-10-24' },
} as const satisfies Record<string, SourceRef>;
export type SourceId = keyof typeof SOURCES;

/** One uncertain input. `dir`: +1 if a higher value raises cost, −1 if it lowers it, 0 if mixed or not a cost input. */
export interface SourcedRange {
  label: string;
  base: number; low: number; high: number;
  unit: string;
  confidence: Confidence;
  classification: EvidenceClass;
  source: SourceId;
  sourceUrl: string; sourceTitle: string; sourceDate: string;
  note?: string;
  dir: -1 | 0 | 1;
}

function r(label: string, base: number, low: number, high: number, unit: string, classification: EvidenceClass, confidence: Confidence, source: SourceId, dir: -1 | 0 | 1, note?: string): SourcedRange {
  const s = SOURCES[source];
  return { label, base, low, high, unit, confidence, classification, source, sourceUrl: s.url, sourceTitle: s.title, sourceDate: s.date, note, dir };
}

export function isRange(x: unknown): x is SourcedRange {
  return typeof x === 'object' && x !== null && 'base' in x && 'classification' in x;
}

// ---------------------------------------------------------------- assumptions

/** Two-stage fully reusable methalox vehicle (Starship / Super Heavy class), in one configuration version. */
export interface StarshipConfig {
  id: string; name: string; version: string; note: string;
  payloadToLeoKg: SourcedRange; shipPropellantKg: SourcedRange; boosterPropellantKg: SourcedRange;
  oxygenFuelMassRatio: SourcedRange; shipDryMassKg: SourcedRange; ispVacS: SourcedRange; seats: SourcedRange;
  shipBuildCost: SourcedRange; boosterBuildCost: SourcedRange;
  shipDesignLifeFlights: SourcedRange; boosterDesignLifeFlights: SourcedRange; fleetRetirementFactor: SourcedRange;
  refurbishmentPerFlight: SourcedRange; groundOpsPerFlight: SourcedRange; missionOpsPerFlight: SourcedRange;
  crewOpsMultiplier: SourcedRange; tankerOpsFactor: SourcedRange; rangeRegulatoryPerFlight: SourcedRange;
  thirdPartyInsurancePerFlight: SourcedRange; insuranceRiskLoading: SourcedRange;
  payloadIntegrationCost: SourcedRange; crewIntegrationMultiplier: SourcedRange;
  infrastructureCapital: SourcedRange; infrastructureLifeYears: SourcedRange; infrastructureOandM: SourcedRange; annualInfrastructureFlights: SourcedRange;
  missionFailureProbability: SourcedRange; lossResidualFraction: SourcedRange;
  tankerPayloadKg: SourcedRange; transferEfficiency: SourcedRange; boiloffPerDay: SourcedRange; loiterDays: SourcedRange;
  depotBoiloffFactor: SourcedRange; reserveFraction: SourcedRange; missionMargin: SourcedRange; scrubFailAllowance: SourcedRange; ascentResidualKg: SourcedRange;
  learningRate: SourcedRange; learningRefLaunches: SourcedRange; learningFloor: SourcedRange;
}

const STARSHIP_COMMON = {
  oxygenFuelMassRatio: r('Raptor oxygen:methane mass ratio', 3.6, 3.5, 3.8, 'kg/kg', 'E', 'medium', 'ntrs', -1, 'Not published by SpaceX; ≈3.6 is the commonly reported Raptor mixture ratio (orientation: Wikipedia, Raptor). Methane is the pricier kg, so a higher ratio is slightly cheaper.'),
  ispVacS: r('Ship specific impulse (in-space mix)', 375, 365, 382, 's', 'E', 'medium', 'bible', -1, 'Raptor Vacuum ≈380 s; sea-level engines used for landing are lower.'),
  shipBuildCost: r('Ship build cost (recurring unit)', 40e6, 15e6, 120e6, 'USD2024', 'D', 'low', 'model', 1, 'Not public. Mature serial production with 6 Raptors. NASA CEH recurring-unit cost, before learning.'),
  boosterBuildCost: r('Booster build cost (recurring unit)', 60e6, 25e6, 180e6, 'USD2024', 'D', 'low', 'model', 1, 'Not public. 33 Raptors dominate. Before learning.'),
  shipDesignLifeFlights: r('Ship design life', 50, 10, 200, 'flights', 'D', 'low', 'model', -1, 'Heat-shield refurbishment drives ship life; no public figure.'),
  boosterDesignLifeFlights: r('Booster design life', 100, 20, 300, 'flights', 'E', 'low', 'falcon9', -1, 'Falcon 9 boosters have flown 30+ times (reported); Super Heavy is designed for rapid reuse.'),
  fleetRetirementFactor: r('Share of design life realised before retirement', 0.6, 0.4, 0.9, '', 'D', 'low', 'model', -1, 'Configuration churn retires vehicles early. Losses are priced separately (expected loss), not here, to avoid double counting.'),
  refurbishmentPerFlight: r('Inspection and refurbishment (ship + booster)', 3e6, 0.5e6, 15e6, 'USD2024/flight', 'E', 'low', 'model', 1),
  groundOpsPerFlight: r('Ground operations and launch site', 3e6, 1e6, 10e6, 'USD2024/flight', 'E', 'low', 'faaKsc', 1, 'Pad turnaround, propellant loading, catch/recovery, commodities and trucking (activities described by FAA filings; costs are not).'),
  missionOpsPerFlight: r('Labour and mission operations (cargo flight)', 2e6, 0.5e6, 8e6, 'USD2024/flight', 'E', 'low', 'model', 1),
  crewOpsMultiplier: r('Crewed-flight operations multiplier', 3, 2, 6, '×', 'D', 'low', 'model', 1),
  tankerOpsFactor: r('Tanker-flight operations factor', 0.3, 0.15, 0.6, '×', 'D', 'low', 'model', 1),
  rangeRegulatoryPerFlight: r('Range, licensing and environmental monitoring', 0.5e6, 0.2e6, 2e6, 'USD2024/flight', 'E', 'low', 'faaKsc', 1),
  thirdPartyInsurancePerFlight: r('Third-party liability insurance', 0.5e6, 0.2e6, 2e6, 'USD2024/flight', 'E', 'low', 'faaKsc', 1, 'FAA licences require maximum-probable-loss liability cover.'),
  insuranceRiskLoading: r('Insurer loading on expected loss', 0.3, 0.1, 0.6, '× expected loss', 'D', 'low', 'model', 1, 'Vehicle and payload are self-insured through the expected-loss line; this is the premium above it.'),
  payloadIntegrationCost: r('Payload integration (cargo)', 1.5e6, 0.5e6, 5e6, 'USD2024/flight', 'E', 'low', 'model', 1),
  crewIntegrationMultiplier: r('Crew integration multiplier', 2, 1.5, 4, '×', 'D', 'low', 'model', 1),
  infrastructureCapital: r('Launch-site capital (pad, tower, tank farm, ASU, liquefaction)', 3e9, 1.5e9, 8e9, 'USD2024/site', 'E', 'low', 'faaKsc', 1, 'Facilities are described in FAA documents; their cost is not published.'),
  infrastructureLifeYears: r('Launch-site economic life', 25, 15, 40, 'yr', 'D', 'medium', 'nasaCeh', -1),
  infrastructureOandM: r('Launch-site upkeep', 0.03, 0.02, 0.06, 'share of capital/yr', 'E', 'low', 'nasaCeh', 1),
  annualInfrastructureFlights: r('Launches per site per year', 100, 25, 300, 'launches/site/yr', 'D', 'low', 'faaKsc', -1, 'FAA-analysed caps today: 44/yr at LC-39A (2026), 25/yr at Starbase (2025); a 2026 FAA notice studies up to 456/yr. Mature 2040 cadence is assumed.'),
  missionFailureProbability: r('Vehicle loss probability per launch', 0.01, 0.002, 0.05, '/launch', 'E', 'medium', 'falcon9', 1, 'Mature reusable fleet incl. landing; Falcon 9 mission success ≈99%+ (reported).'),
  lossResidualFraction: r('Value at risk when a vehicle is lost', 0.5, 0.3, 0.8, 'share of build cost', 'D', 'low', 'model', 1, 'Mid-life vehicle on average.'),
  transferEfficiency: r('Ship-to-ship propellant transfer efficiency', 0.95, 0.85, 0.99, '', 'E', 'low', 'ntrs', -1, 'Large-scale cryogenic transfer not yet demonstrated (2026).'),
  boiloffPerDay: r('Boil-off in orbit', 0.001, 0.0003, 0.003, '/day', 'E', 'low', 'ntrs', 1),
  loiterDays: r('Days a refilled ship waits in orbit', 30, 10, 90, 'days', 'D', 'low', 'model', 1),
  depotBoiloffFactor: r('Depot boil-off relative to a ship', 0.5, 0.3, 0.8, '×', 'D', 'low', 'ntrs', 1),
  reserveFraction: r('Tanker residuals and reserves', 0.03, 0.01, 0.08, 'share', 'D', 'low', 'model', 1),
  missionMargin: r('Mission propellant margin', 0.05, 0.02, 0.15, 'share', 'D', 'medium', 'model', 1),
  scrubFailAllowance: r('Allowance for failed or scrubbed tanker flights', 0.05, 0.02, 0.15, 'share', 'D', 'low', 'model', 1),
  ascentResidualKg: r('Propellant left in the ship on reaching orbit', 50e3, 20e3, 100e3, 'kg', 'E', 'low', 'model', -1),
  learningRate: r('Learning rate (Wright curve)', 0.9, 0.85, 0.95, 'per doubling', 'E', 'medium', 'nasaCeh', 1, 'Aerospace production learning curves are typically 85–95%.'),
  learningRefLaunches: r('Launches per learning doubling (reference)', 1000, 300, 3000, 'launches', 'D', 'low', 'model', 1),
  learningFloor: r('Floor on learning effect', 0.4, 0.25, 0.7, '× unit cost', 'D', 'low', 'model', 1),
};

/** Configuration versions are versions, not contradictions: SpaceX's overview and the FAA's LC-39A analysis describe different stacks. */
export const STARSHIP_CONFIGS: StarshipConfig[] = [
  {
    id: 'starship-2040', name: 'Starship / Super Heavy', version: 'mature fleet, FAA LC-39A configuration (simulation baseline from 2040)',
    note: 'Propellant loads as analysed by the FAA for LC-39A; payload and costs are mature-operations estimates and design assumptions.',
    payloadToLeoKg: r('Payload to LEO (reusable)', 150e3, 100e3, 200e3, 'kg', 'E', 'medium', 'spacex', -1, 'SpaceX publishes 100+ t; the larger FAA-analysed stack and stated goals point to 150–200 t.'),
    shipPropellantKg: r('Ship propellant capacity', 2650e3, 1600e3, 2650e3, 'kg', 'R', 'medium', 'faaKsc', 0, 'FAA LC-39A analysis (draft EIS era); SpaceX page lists ≈1,600 t for the current ship.'),
    boosterPropellantKg: r('Booster propellant capacity', 4100e3, 3650e3, 4100e3, 'kg', 'R', 'medium', 'faaKsc', 1),
    shipDryMassKg: r('Ship dry mass', 150e3, 120e3, 200e3, 'kg', 'E', 'low', 'bible', 1),
    seats: r('Passengers per ship', 60, 20, 100, 'people', 'D', 'low', 'spacex', -1, 'SpaceX has described up to 100 people; early Mars flights likely 12–24 (bible §1.3).'),
    ...STARSHIP_COMMON,
    tankerPayloadKg: r('Propellant delivered per tanker flight', 150e3, 100e3, 200e3, 'kg', 'E', 'medium', 'tankerEstimates', -1, 'NASA presentation: 100–150 t per tanker; larger stack assumed.'),
  },
  {
    id: 'starship-spacex', name: 'Starship / Super Heavy', version: 'SpaceX published figures (2025)',
    note: 'Capacities exactly as on the SpaceX vehicle page; costs as baseline.',
    payloadToLeoKg: r('Payload to LEO (reusable)', 100e3, 100e3, 150e3, 'kg', 'R', 'medium', 'spacex', -1, '"100+ metric tonnes" (SpaceX).'),
    shipPropellantKg: r('Ship propellant capacity', 1600e3, 1500e3, 1600e3, 'kg', 'R', 'high', 'spacex', 0),
    boosterPropellantKg: r('Booster propellant capacity', 3650e3, 3400e3, 3650e3, 'kg', 'R', 'high', 'spacex', 1),
    shipDryMassKg: r('Ship dry mass', 120e3, 100e3, 150e3, 'kg', 'E', 'low', 'bible', 1),
    seats: r('Passengers per ship', 24, 12, 100, 'people', 'D', 'low', 'bible', -1),
    ...STARSHIP_COMMON,
    tankerPayloadKg: r('Propellant delivered per tanker flight', 100e3, 80e3, 150e3, 'kg', 'E', 'medium', 'tankerEstimates', -1),
  },
  {
    id: 'starship-faa', name: 'Starship / Super Heavy', version: 'FAA LC-39A EIS configuration, early operations',
    note: 'FAA-analysed propellant loads with early-operations reuse and cadence (FAA caps: 44 launches/yr).',
    payloadToLeoKg: r('Payload to LEO (reusable)', 120e3, 100e3, 200e3, 'kg', 'E', 'medium', 'spacex', -1),
    shipPropellantKg: r('Ship propellant capacity', 2650e3, 2400e3, 2650e3, 'kg', 'R', 'medium', 'faaKsc', 0),
    boosterPropellantKg: r('Booster propellant capacity', 4100e3, 3650e3, 4100e3, 'kg', 'R', 'medium', 'faaKsc', 1),
    shipDryMassKg: r('Ship dry mass', 160e3, 130e3, 200e3, 'kg', 'E', 'low', 'bible', 1),
    seats: r('Passengers per ship', 24, 12, 60, 'people', 'D', 'low', 'bible', -1),
    ...STARSHIP_COMMON,
    shipDesignLifeFlights: r('Ship design life', 15, 5, 50, 'flights', 'D', 'low', 'model', -1),
    boosterDesignLifeFlights: r('Booster design life', 30, 10, 100, 'flights', 'E', 'low', 'falcon9', -1),
    annualInfrastructureFlights: r('Launches per site per year', 44, 25, 76, 'launches/site/yr', 'R', 'medium', 'faaKsc', -1, 'FAA: up to 44/yr at LC-39A; 76/yr proposed at SLC-37; 25/yr at Starbase.'),
    tankerPayloadKg: r('Propellant delivered per tanker flight', 120e3, 100e3, 150e3, 'kg', 'E', 'medium', 'tankerEstimates', -1),
  },
];

export interface Commodities {
  methaneFeedstock: SourcedRange; methanePurification: SourcedRange; methaneLiquefactionKWhPerKg: SourcedRange;
  oxygenProductionKWhPerKg: SourcedRange; electricityPrice: SourcedRange; conditioningStoragePerKg: SourcedRange;
  groundBoiloffFraction: SourcedRange; supplierMargin: SourcedRange;
  isruKWhPerKg: SourcedRange; offEarthElectricity: SourcedRange; isruPlantPerKg: SourcedRange; importedPropellantPerKg: SourcedRange;
  asteroidDepotPerKg: SourcedRange; lh2PerKg: SourcedRange; fusionFuelPerKg: SourcedRange;
  elevatorKWhPerKg: SourcedRange; elevatorCapitalPerKg: SourcedRange; elevatorOpsPerKg: SourcedRange; massDriverKWhPerKg: SourcedRange;
}

export interface MissionDefaults {
  massPerPassengerKg: SourcedRange; cargoPerCrewKg: SourcedRange; missionHardwarePerKg: SourcedRange;
  lifeSupportPerPersonYear: SourcedRange; destinationOpsPerCampaign: SourcedRange; transitLossPerYear: SourcedRange;
  transferMarginKmS: SourcedRange; atmosphereLandingDvKmS: SourcedRange; elevatorDvCreditKmS: SourcedRange;
  offEarthOpsMultiplier: SourcedRange; customerMargin: SourcedRange; discountRate: SourcedRange;
  serviceTransitYears: SourcedRange;
}

export interface NtpConfig { name: string; version: string; buildCost: SourcedRange; lifeTrips: SourcedRange; dryMassKg: SourcedRange; ispS: SourcedRange; tankCapacityKg: SourcedRange; payloadMaxKg: SourcedRange; lh2PerTankerFraction: SourcedRange; lh2BoiloffMult: SourcedRange; opsPerTrip: SourcedRange; failureProbability: SourcedRange }
export interface FusionConfig { name: string; version: string; buildCost: SourcedRange; lifeTrips: SourcedRange; dryMassKg: SourcedRange; exhaustKmS: SourcedRange; payloadMaxKg: SourcedRange; opsPerTrip: SourcedRange; failureProbability: SourcedRange }
export interface StarshipClass { name: string; version: string; massFixedKg: SourcedRange; massPerColonistKg: SourcedRange; complexity: SourcedRange }
export interface Interstellar {
  structureCostPerKg: SourcedRange; shipyardFactor: SourcedRange; colonyKitPerColonist: SourcedRange; opsPerColonist: SourcedRange;
  liftPerColonist: SourcedRange; shipyardCapital: SourcedRange; shipsPerShipyard: SourcedRange; departureOps: SourcedRange;
  fusionExhaustC: SourcedRange; antimatterExhaustC: SourcedRange; beamedExhaustC: SourcedRange; maxMassRatio: SourcedRange;
  fusionFuelPerKg: SourcedRange; antimatterFuelPerKg: SourcedRange; beamedFuelPerKg: SourcedRange; warpEnergyCost: SourcedRange;
  classes: Record<'fusionArk' | 'generation' | 'seed' | 'warp', StarshipClass>;
}
export interface Context {
  warInsuranceMult: SourcedRange; warOpsMult: SourcedRange; warCadenceMult: SourcedRange;
  pandemicOpsMult: SourcedRange; pandemicCadenceMult: SourcedRange;
  collapseOpsMult: SourcedRange; collapseCadenceMult: SourcedRange; collapsePropMult: SourcedRange;
  kesslerInsuranceMult: SourcedRange; kesslerCadenceMult: SourcedRange; kesslerLossAdd: SourcedRange;
  shortagePropSlope: SourcedRange; preReusableLifeMult: SourcedRange; preReusableRefurbMult: SourcedRange;
  manufElasticity: SourcedRange; energyPriceElasticity: SourcedRange;
}
export interface Budget {
  transportGdpShare: SourcedRange; capitalShare: SourcedRange; serviceShare: SourcedRange;
  interstellarGdpShare: SourcedRange; interstellarBuildYears: SourcedRange; interstellarCapitalShare: SourcedRange;
  /** multiplier on every budget by era (Expansion, Consolidation, Golden Age, Stagnation, War, Pandemic, Collapse, Renaissance) */
  eraBudget: number[];
}

export type ScenarioId = 'baseline' | 'conservative' | 'optimistic' | 'custom';
export interface Assumptions {
  scenario: ScenarioId;
  starship: StarshipConfig;
  commodities: Commodities;
  mission: MissionDefaults;
  ntp: NtpConfig;
  fusion: FusionConfig;
  interstellar: Interstellar;
  context: Context;
  budget: Budget;
}

const COMMODITIES: Commodities = {
  methaneFeedstock: r('Natural-gas feedstock', 0.21, 0.13, 0.45, 'USD/kg CH4', 'R', 'medium', 'eiaGas', 1, '$4.07/Mcf (2024 US industrial) ÷ 19.3 kg/Mcf; range spans 2020–2026 monthly prices. Raw gas is not delivered liquid methane: the lines below add the rest.'),
  methanePurification: r('Purification to propellant grade', 0.05, 0.02, 0.15, 'USD/kg CH4', 'E', 'low', 'ntrs', 1),
  methaneLiquefactionKWhPerKg: r('Methane liquefaction energy', 0.6, 0.35, 1.0, 'kWh/kg', 'E', 'medium', 'ntrs', 1, 'Large LNG trains ≈0.3–0.4 kWh/kg; site-scale plants more.'),
  oxygenProductionKWhPerKg: r('Liquid oxygen production energy (air separation + liquefaction)', 0.8, 0.5, 1.2, 'kWh/kg', 'E', 'medium', 'ntrs', 1),
  electricityPrice: r('Electricity price (Earth industrial)', 0.081, 0.06, 0.12, 'USD/kWh', 'R', 'medium', 'eiaElec', 1),
  conditioningStoragePerKg: r('Conditioning, storage and transport', 0.03, 0.01, 0.08, 'USD/kg', 'E', 'low', 'faaStarbase', 1, 'Tank farm, subcooling, trucking (FAA: ≈24,000 truck trips/yr at Starbase).'),
  groundBoiloffFraction: r('Ground boil-off and chill-down losses', 0.05, 0.02, 0.1, 'share of load', 'E', 'low', 'faaKsc', 1),
  supplierMargin: r('Propellant supplier margin', 0.15, 0.05, 0.3, 'share', 'D', 'low', 'model', 1),
  isruKWhPerKg: r('ISRU methalox energy (Sabatier + electrolysis + liquefaction)', 14, 11, 20, 'kWh/kg', 'E', 'medium', 'bible', 1, '≈15–20 GWh per 1,200 t (bible §2.2, NASA ISRU studies).'),
  offEarthElectricity: r('Off-Earth electricity cost', 0.3, 0.1, 1.5, 'USD/kWh', 'D', 'low', 'model', 1),
  isruPlantPerKg: r('ISRU plant capital and upkeep', 1.5, 0.5, 6, 'USD/kg', 'D', 'low', 'model', 1),
  importedPropellantPerKg: r('Imported propellant at an off-Earth origin without ISRU', 1500, 500, 5000, 'USD/kg', 'D', 'low', 'bible', 1, '≈ cost per kg delivered to the Mars surface (bible §1.2).'),
  asteroidDepotPerKg: r('Asteroid-sourced propellant at an orbital depot', 150, 50, 500, 'USD/kg', 'D', 'low', 'bible', 1, 'Bible N09: asteroid mining halves LEO propellant cost.'),
  lh2PerKg: r('Liquid hydrogen delivered', 6, 4, 10, 'USD/kg', 'E', 'medium', 'ntrs', 1),
  fusionFuelPerKg: r('Fusion fuel (deuterium-rich)', 100, 20, 2000, 'USD/kg', 'D', 'low', 'bible', 1),
  elevatorKWhPerKg: r('Space-elevator lift energy', 18, 11, 31, 'kWh/kg', 'E', 'medium', 'bible', 1, '33 MJ/kg ≈ 9.2 kWh/kg at 100%; 30–80% drive efficiency.'),
  elevatorCapitalPerKg: r('Space-elevator capital recovery', 20, 5, 100, 'USD/kg', 'D', 'low', 'model', 1),
  elevatorOpsPerKg: r('Space-elevator operations', 3, 1, 10, 'USD/kg', 'D', 'low', 'model', 1),
  massDriverKWhPerKg: r('Mass-driver launch energy (Moon-class body)', 1, 0.5, 3, 'kWh/kg', 'E', 'medium', 'bible', 1, 'Lunar escape ≈2.4 km/s ⇒ 2.9 MJ/kg at 100%.'),
};

const MISSION: MissionDefaults = {
  massPerPassengerKg: r('Mass per passenger (person, seat, transit consumables)', 500, 300, 1500, 'kg/person', 'E', 'low', 'bible', 1),
  cargoPerCrewKg: r('Founding cargo per crew member', 10000, 5000, 25000, 'kg/person', 'D', 'low', 'bible', 1, 'Habitat, power, ISRU, rovers for an outpost.'),
  missionHardwarePerKg: r('Mission-specific hardware', 2000, 500, 10000, 'USD/kg', 'D', 'low', 'nasaCeh', 1, 'Mass-produced surface equipment; NASA flight hardware runs far higher.'),
  lifeSupportPerPersonYear: r('In-space life support and operations', 0.2e6, 0.05e6, 1e6, 'USD/person-yr', 'D', 'low', 'model', 1),
  destinationOpsPerCampaign: r('Destination operations (landing site, unloading)', 5e6, 1e6, 20e6, 'USD/campaign', 'D', 'low', 'model', 1),
  transitLossPerYear: r('Crew-ship loss rate in transit', 0.002, 0.0005, 0.01, '/yr', 'D', 'low', 'model', 1),
  transferMarginKmS: r('Fast-transfer and window margin', 1.0, 0.3, 2.0, 'km/s', 'E', 'medium', 'bible', 1, 'Hohmann LEO→Mars ≈3.6 km/s; fast transfers 4.3–6 km/s (bible §1.4).'),
  atmosphereLandingDvKmS: r('Propulsive landing after atmospheric entry', 0.8, 0.5, 1.1, 'km/s', 'E', 'medium', 'bible', 1),
  elevatorDvCreditKmS: r('Δv gained from a space-elevator release', 3.0, 1.5, 4.5, 'km/s', 'E', 'low', 'bible', -1),
  offEarthOpsMultiplier: r('Off-Earth launch-site cost multiplier', 3, 1.5, 8, '×', 'D', 'low', 'model', 1),
  customerMargin: r('Provider margin (customer price only)', 0.3, 0.1, 1.0, 'share', 'D', 'low', 'model', 0, 'Price is not cost: the simulation spends fully burdened cost, never price.'),
  discountRate: r('Real discount rate for capital recovery', 0.07, 0.03, 0.1, '/yr', 'D', 'medium', 'nasaCeh', 1),
  serviceTransitYears: r('Scheduled-service transit time', 0.5, 0.25, 1, 'yr', 'E', 'medium', 'bible', 1),
};

const NTP: NtpConfig = {
  name: 'Nuclear thermal transport', version: 'bible V_NTR, 2050+',
  buildCost: r('NTP transport build cost', 1.5e9, 0.5e9, 4e9, 'USD2024', 'D', 'low', 'bible', 1),
  lifeTrips: r('NTP transport life', 15, 5, 40, 'trips', 'D', 'low', 'model', -1),
  dryMassKg: r('NTP transport dry mass', 80e3, 50e3, 150e3, 'kg', 'E', 'low', 'bible', 1),
  ispS: r('NTP specific impulse', 900, 850, 950, 's', 'E', 'medium', 'bible', -1),
  tankCapacityKg: r('NTP hydrogen tank capacity', 800e3, 400e3, 1200e3, 'kg', 'D', 'low', 'model', 0),
  payloadMaxKg: r('NTP payload limit', 200e3, 150e3, 300e3, 'kg', 'E', 'low', 'bible', -1),
  lh2PerTankerFraction: r('LH2 per tanker relative to methalox load', 0.4, 0.3, 0.5, 'share', 'D', 'low', 'model', -1, 'Hydrogen is ≈1/6 the density of methalox.'),
  lh2BoiloffMult: r('LH2 boil-off relative to methalox', 3, 2, 5, '×', 'E', 'medium', 'ntrs', 1),
  opsPerTrip: r('NTP operations per trip', 20e6, 5e6, 60e6, 'USD2024/trip', 'D', 'low', 'model', 1),
  failureProbability: r('NTP loss probability per trip', 0.01, 0.003, 0.05, '/trip', 'D', 'low', 'model', 1),
};

const FUSION: FusionConfig = {
  name: 'Fusion torch transport', version: 'bible V_DFD/V_TORCH, 2110+',
  buildCost: r('Fusion transport build cost', 10e9, 3e9, 40e9, 'USD2024', 'D', 'low', 'bible', 1),
  lifeTrips: r('Fusion transport life', 100, 30, 300, 'trips', 'D', 'low', 'model', -1),
  dryMassKg: r('Fusion transport dry mass', 500e3, 200e3, 2000e3, 'kg', 'D', 'low', 'bible', 1),
  exhaustKmS: r('Fusion exhaust velocity', 1000, 300, 3000, 'km/s', 'E', 'low', 'bible', -1),
  payloadMaxKg: r('Fusion transport payload limit', 1000e3, 500e3, 10000e3, 'kg', 'D', 'low', 'bible', -1),
  opsPerTrip: r('Fusion operations per trip', 50e6, 10e6, 200e6, 'USD2024/trip', 'D', 'low', 'model', 1),
  failureProbability: r('Fusion transport loss per trip', 0.005, 0.001, 0.02, '/trip', 'D', 'low', 'model', 1),
};

const INTERSTELLAR: Interstellar = {
  structureCostPerKg: r('Interstellar ship structure', 1000, 200, 10000, 'USD/kg', 'D', 'low', 'bible', 1),
  shipyardFactor: r('Orbital-shipyard build-cost factor', 0.5, 0.3, 0.8, '×', 'E', 'low', 'bible', 1, 'Bible N20: ship build cost ×0.5 with orbital shipyards.'),
  colonyKitPerColonist: r('Colony kit per colonist', 50e6, 10e6, 200e6, 'USD/colonist', 'D', 'low', 'model', 1),
  opsPerColonist: r('Selection, training and mission control per colonist', 1e6, 0.2e6, 5e6, 'USD/colonist', 'D', 'low', 'model', 1),
  liftPerColonist: r('Ferrying a colonist to the shipyard', 0.5e6, 0.1e6, 3e6, 'USD/colonist', 'D', 'low', 'model', 1),
  shipyardCapital: r('Interstellar shipyard capital', 5e12, 1e12, 3e13, 'USD2024', 'D', 'low', 'bible', 1),
  shipsPerShipyard: r('Ships built per shipyard', 50, 10, 200, 'ships', 'D', 'low', 'model', -1),
  departureOps: r('Departure operations', 1e9, 0.2e9, 5e9, 'USD2024', 'D', 'low', 'model', 1),
  fusionExhaustC: r('Fusion exhaust velocity (Daedalus-class)', 0.033, 0.02, 0.05, 'c', 'E', 'medium', 'bible', -1),
  antimatterExhaustC: r('Antimatter-catalysed exhaust velocity', 0.15, 0.08, 0.3, 'c', 'E', 'low', 'bible', -1),
  beamedExhaustC: r('Beamed/ramjet effective exhaust velocity', 0.3, 0.15, 0.6, 'c', 'D', 'low', 'bible', -1),
  maxMassRatio: r('Largest buildable mass ratio', 20, 10, 50, '×', 'D', 'low', 'model', 1),
  fusionFuelPerKg: r('Interstellar fusion fuel', 100, 20, 2000, 'USD/kg', 'D', 'low', 'bible', 1),
  antimatterFuelPerKg: r('Antimatter-catalysed propellant', 1000, 100, 1e5, 'USD/kg', 'D', 'low', 'bible', 1),
  beamedFuelPerKg: r('Beam energy, per kg-equivalent', 50, 5, 1000, 'USD/kg', 'D', 'low', 'bible', 1),
  warpEnergyCost: r('Warp field energy per voyage', 1e12, 1e11, 1e14, 'USD2024', 'D', 'low', 'model', 1, 'Speculative physics; a placeholder scale.'),
  classes: {
    fusionArk: { name: 'Fusion colony ship', version: 'cryo-assisted fusion ark', massFixedKg: r('Fusion ark fixed mass', 5e7, 1e7, 2e8, 'kg', 'D', 'low', 'bible', 1), massPerColonistKg: r('Fusion ark mass per colonist', 2e5, 5e4, 1e6, 'kg', 'D', 'low', 'bible', 1), complexity: r('Fusion ark complexity factor', 1, 0.7, 2, '×', 'D', 'low', 'model', 1) },
    generation: { name: 'Generation ship', version: 'bible §3.6 (Project Hyperion 2024: 1,000 ± 500 crew)', massFixedKg: r('Generation ship fixed mass', 1e8, 3e7, 5e8, 'kg', 'D', 'low', 'bible', 1), massPerColonistKg: r('Generation ship mass per colonist', 5e5, 1e5, 1e6, 'kg', 'E', 'low', 'bible', 1), complexity: r('Generation ship complexity factor', 1, 0.7, 2, '×', 'D', 'low', 'model', 1) },
    seed: { name: 'Embryo seed ship', version: 'bible §3.6 (≈1e6 kg class)', massFixedKg: r('Seed ship fixed mass', 2e7, 5e6, 1e8, 'kg', 'D', 'low', 'bible', 1), massPerColonistKg: r('Seed ship mass per colonist', 1000, 200, 5000, 'kg', 'D', 'low', 'bible', 1), complexity: r('Seed ship complexity factor', 2, 1, 5, '×', 'D', 'low', 'model', 1, 'Autonomous robots raising the first generation.') },
    warp: { name: 'Warp ship', version: 'speculative (Alcubierre metric engineering)', massFixedKg: r('Warp ship fixed mass', 1e8, 3e7, 5e8, 'kg', 'D', 'low', 'model', 1), massPerColonistKg: r('Warp ship mass per colonist', 2e4, 5e3, 1e5, 'kg', 'D', 'low', 'model', 1), complexity: r('Warp ship complexity factor', 10, 3, 50, '×', 'D', 'low', 'model', 1) },
  },
};

const CONTEXT: Context = {
  warInsuranceMult: r('War-risk insurance multiplier', 2.5, 1.5, 5, '×', 'D', 'low', 'model', 1),
  warOpsMult: r('War operations multiplier (security, labour)', 1.2, 1.05, 1.5, '×', 'D', 'low', 'model', 1),
  warCadenceMult: r('War cadence multiplier', 0.7, 0.5, 0.9, '×', 'D', 'low', 'bible', -1, 'Bible E63: space launches ×0.5 in a great-power war.'),
  pandemicOpsMult: r('Pandemic operations multiplier', 1.25, 1.05, 1.6, '×', 'D', 'low', 'model', 1),
  pandemicCadenceMult: r('Pandemic cadence multiplier', 0.6, 0.4, 0.9, '×', 'D', 'low', 'model', -1),
  collapseOpsMult: r('Collapse operations multiplier', 1.5, 1.2, 3, '×', 'D', 'low', 'model', 1),
  collapseCadenceMult: r('Collapse cadence multiplier', 0.3, 0.1, 0.6, '×', 'D', 'low', 'model', -1),
  collapsePropMult: r('Collapse propellant price multiplier', 1.5, 1.1, 3, '×', 'D', 'low', 'model', 1),
  kesslerInsuranceMult: r('Kessler-cascade insurance multiplier', 3, 2, 5, '×', 'D', 'low', 'bible', 1, 'Bible E06: launch_cost ×3 for 20–50 yr.'),
  kesslerCadenceMult: r('Kessler-cascade cadence multiplier', 0.3, 0.2, 0.5, '×', 'D', 'low', 'bible', -1, 'Bible E06: launch rate ×0.3.'),
  kesslerLossAdd: r('Kessler-cascade added loss probability', 0.01, 0.003, 0.03, '/launch', 'D', 'low', 'model', 1),
  shortagePropSlope: r('Propellant price rise per unit shortage at origin', 1, 0.5, 2, '× shortage', 'D', 'low', 'model', 1),
  preReusableLifeMult: r('Reuse life before mature full reuse', 0.2, 0.1, 0.4, '×', 'D', 'low', 'model', -1, 'Until "Fully reusable heavy lift" is known.'),
  preReusableRefurbMult: r('Refurbishment before mature full reuse', 2, 1.5, 4, '×', 'D', 'low', 'model', 1),
  manufElasticity: r('Hardware cost falls with productivity^−k', 0.5, 0.3, 0.7, 'k', 'D', 'low', 'model', -1, 'The legacy interstellar cost used 1/√productivity.'),
  energyPriceElasticity: r('Electricity price falls with energy technology^−k', 0.3, 0.1, 0.5, 'k', 'D', 'low', 'model', -1),
};

const BUDGET: Budget = {
  transportGdpShare: r('Transport budget, share of polity product', 0.01, 0.003, 0.03, '/yr', 'D', 'low', 'bible', 0, 'Space economy ≈1.2% of world product in 2040 (bible §1.1).'),
  capitalShare: r('Most of a seat\'s capital one step may spend on transport', 0.25, 0.1, 0.5, 'share', 'D', 'low', 'model', 0),
  serviceShare: r('Share of the transport budget scheduled services may use', 0.6, 0.3, 0.9, 'share', 'D', 'low', 'model', 0),
  interstellarGdpShare: r('Interstellar mission cap, share of product per build year', 0.05, 0.02, 0.1, '/yr', 'D', 'low', 'bible', 0, 'Bible §3.6: capital_cost ≤ 0.05 × GDP × build_years.'),
  interstellarBuildYears: r('Interstellar build years', 30, 10, 50, 'yr', 'D', 'low', 'bible', 0),
  interstellarCapitalShare: r('Most of a seat\'s capital one interstellar ship may take', 1, 0.5, 1, 'share', 'D', 'low', 'model', 0, 'Legacy rule: capital must exceed the ship\'s cost.'),
  eraBudget: [1.5, 1, 1.3, 0.7, 0.5, 0.6, 0.2, 1],
};

export const ERA_BUDGET_SOURCE = 'D: bible §5 regime expansion multipliers (Expansion 1.5, Golden Age 1.3, Stagnation 0.7, War 0.5, Pandemic 0.6, Collapse 0.2)';

export function baseline(configId = 'starship-2040'): Assumptions {
  const starship = STARSHIP_CONFIGS.find((c) => c.id === configId) ?? STARSHIP_CONFIGS[0];
  return structuredClone({ scenario: 'baseline', starship, commodities: COMMODITIES, mission: MISSION, ntp: NTP, fusion: FUSION, interstellar: INTERSTELLAR, context: CONTEXT, budget: BUDGET }) as Assumptions;
}

/** Every uncertain input with its dotted path. */
export function ranges(a: Assumptions): [string, SourcedRange][] {
  const out: [string, SourcedRange][] = [];
  const walk = (o: unknown, p: string) => {
    if (isRange(o)) { out.push([p, o]); return; }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
  };
  walk(a, '');
  return out;
}

/** A copy with each range's base replaced by fn(range, path). */
export function mapBases(a: Assumptions, fn: (x: SourcedRange, path: string) => number): Assumptions {
  const c = structuredClone(a);
  for (const [p, x] of ranges(c)) x.base = fn(x, p);
  return c;
}

export function getRange(a: Assumptions, path: string): SourcedRange | undefined {
  let o: unknown = a;
  for (const k of path.split('.')) o = (o as Record<string, unknown> | undefined)?.[k];
  return isRange(o) ? o : undefined;
}

/** Conservative and optimistic move every cost input halfway from its base to its costlier or cheaper end. */
export function scenario(id: ScenarioId, configId = 'starship-2040'): Assumptions {
  const b = baseline(configId);
  if (id === 'baseline' || id === 'custom') return { ...b, scenario: id };
  const s = id === 'conservative' ? 1 : -1;
  const out = mapBases(b, (x) => {
    if (x.dir === 0) return x.base;
    const end = x.dir * s > 0 ? x.high : x.low;
    return x.base + 0.5 * (end - x.base);
  });
  out.scenario = id;
  return out;
}

// ---------------------------------------------------------------- mission inputs

/** Geometry of a route, from the world (static per pair of bodies). km/s. */
export interface Route {
  /** 0 Earth (two-stage launch), 1 a body's surface (single-stage ascent), 2 already in space (habitat, small asteroid) */
  origin: number;
  ascentKmS: number;    // origin surface → parking orbit (single-stage origins)
  outKmS: number;       // origin parking orbit → destination surface, before the transfer margin
  backKmS: number;      // destination surface → origin parking orbit (for a reusable return)
  transitYears: number; // in-system transit, or interstellar voyage
  distanceLy: number;
}

export const KIND = ['crew', 'service', 'interstellar', 'warp'] as const;
export type MissionKind = typeof KIND[number];

export interface MissionSpec {
  kind: MissionKind; crew: number; cargoKg: number; route: Route;
  /** price only this way home (what-if analysis); by default the cheapest feasible one is chosen */
  forceReturn?: ReturnMode;
}

/** Context bits (engine state that changes costs). */
export const CF = { reusable: 1, isruDest: 2, isruOrigin: 4, asteroidDepot: 8, elevator: 16, massDriver: 32, ntp: 64, fusion: 128, shipyards: 256, kessler: 512, seedShips: 1024, genShip: 2048 } as const;

/** The state of the world a mission launches into. Raw values: the multipliers come from the assumptions. */
export interface MissionContext {
  era: number;
  flags: number;
  shortage: number;      // origin shortage 0..1
  productivity: number;  // fx.productivity
  energyFx: number;      // fx.energy
  launchGen: number;     // generated inventions' launch factor (<1 cheaper)
  cumLaunches: number;   // launches flown so far (learning)
  pLossTransit: number;  // interstellar: probability the ship is lost on the way
  shipSpeedC: number;
}

export const COST_KEYS = ['hardware', 'propellantEarth', 'propellantOffEarth', 'refurbishment', 'groundOps', 'missionOps', 'rangeRegulatory', 'insurance', 'payloadIntegration', 'infrastructure', 'expectedLoss', 'missionHardware', 'inSpaceOps'] as const;
export type CostKey = typeof COST_KEYS[number];
export type Costs = Record<CostKey, number>;
export const COST_LABELS: Record<CostKey, string> = {
  hardware: 'Vehicle hardware (amortised or expended)', propellantEarth: 'Propellant, Earth-produced', propellantOffEarth: 'Propellant, off-Earth (ISRU, depot, fusion fuel)',
  refurbishment: 'Inspection and refurbishment', groundOps: 'Ground operations and launch site', missionOps: 'Labour and mission operations',
  rangeRegulatory: 'Range and regulatory', insurance: 'Insurance', payloadIntegration: 'Payload integration', infrastructure: 'Infrastructure amortisation',
  expectedLoss: 'Expected loss and replacement', missionHardware: 'Mission-specific hardware', inSpaceOps: 'In-space and destination operations',
};
/** Groups for summary charts and global metrics. */
export const COST_GROUP: Record<CostKey, 'hardware' | 'propellant' | 'operations' | 'risk' | 'infrastructure' | 'missionHardware'> = {
  hardware: 'hardware', propellantEarth: 'propellant', propellantOffEarth: 'propellant', refurbishment: 'operations', groundOps: 'operations', missionOps: 'operations',
  rangeRegulatory: 'operations', insurance: 'risk', payloadIntegration: 'operations', infrastructure: 'infrastructure', expectedLoss: 'risk', missionHardware: 'missionHardware', inSpaceOps: 'operations',
};

export const VEHICLES = ['starship', 'ntp', 'fusion', 'fusionArk', 'generation', 'seed', 'warp'] as const;
export type VehicleId = typeof VEHICLES[number];
export const RETURN_MODES = ['reuse-isru', 'reuse-carried', 'expend', 'one-way', 'n/a'] as const;
export type ReturnMode = typeof RETURN_MODES[number];

export interface PropDetail { methaneKg: number; oxygenKg: number; feedstock: number; purification: number; liquefaction: number; oxygenEnergy: number; conditioning: number; boiloff: number; margin: number }

export interface Economics {
  feasible: boolean;
  vehicle: VehicleId;
  version: string;
  returnMode: ReturnMode;
  ships: number;            // crew/cargo vehicles (service: ship-equivalents, may be fractional)
  tankersPerShip: number;   // integer
  tankerFlights: number;
  depotLaunches: number;
  missionLaunches: number;  // launches of the mission vehicles themselves (incl. ascent lifts)
  totalLaunches: number;
  crew: number;
  payloadKg: number;
  earthLaunchedKg: number;  // everything lifted off Earth: payload plus propellant delivered by tankers
  methaneKg: number; oxygenKg: number; otherPropKg: number; offEarthPropKg: number;
  cost: Costs;
  total: number;
  tankerCost: number;
  marginal: number;
  customerPrice: number;
  costPerKg: number;
  costPerPassenger: number;
  pMissionLoss: number;
  prop: PropDetail;
}

const G0 = 9.80665;

function zeroCosts(): Costs { return Object.fromEntries(COST_KEYS.map((k) => [k, 0])) as Costs; }
function addCosts(into: Costs, c: Costs, k = 1): void { for (const key of COST_KEYS) into[key] += c[key] * k; }
function sumCosts(c: Costs): number { let s = 0; for (const k of COST_KEYS) s += c[k]; return s; }
const zeroProp = (): PropDetail => ({ methaneKg: 0, oxygenKg: 0, feedstock: 0, purification: 0, liquefaction: 0, oxygenEnergy: 0, conditioning: 0, boiloff: 0, margin: 0 });
function addProp(into: PropDetail, p: PropDetail, k = 1): void { for (const key of Object.keys(into) as (keyof PropDetail)[]) into[key] += p[key] * k; }

/** Capital recovery factor: equal yearly payments that repay 1 over n years at rate i. */
export function crf(i: number, n: number): number { return i <= 0 ? 1 / n : (i * (1 + i) ** n) / ((1 + i) ** n - 1); }

/** Multipliers this context puts on each component (all from the assumptions). */
export interface Mults { prop: number; ops: number; insurance: number; cadence: number; lossAdd: number; manuf: number; refurb: number; life: number; elec: number; learning: number }
export function mults(c: MissionContext, a: Assumptions): Mults {
  const x = a.context, S = a.starship;
  let ops = 1, insurance = 1, cadence = 1, prop = 1 + x.shortagePropSlope.base * Math.max(0, Math.min(1, c.shortage));
  if (c.era === 4) { ops *= x.warOpsMult.base; insurance *= x.warInsuranceMult.base; cadence *= x.warCadenceMult.base; }
  if (c.era === 5) { ops *= x.pandemicOpsMult.base; cadence *= x.pandemicCadenceMult.base; }
  if (c.era === 6) { ops *= x.collapseOpsMult.base; cadence *= x.collapseCadenceMult.base; prop *= x.collapsePropMult.base; }
  const kessler = (c.flags & CF.kessler) !== 0;
  if (kessler) { insurance *= x.kesslerInsuranceMult.base; cadence *= x.kesslerCadenceMult.base; }
  const reusable = (c.flags & CF.reusable) !== 0;
  // Wright learning curve on recurring hardware and refurbishment; quantised to 1/8 of a doubling so caches stay valid
  const doublings = Math.floor(Math.log2(1 + Math.max(0, c.cumLaunches) / S.learningRefLaunches.base) * 8) / 8;
  const learning = Math.max(S.learningFloor.base, Math.pow(S.learningRate.base, doublings));
  return {
    prop, ops, insurance, cadence, lossAdd: kessler ? x.kesslerLossAdd.base : 0,
    manuf: Math.pow(Math.max(1, c.productivity), -x.manufElasticity.base),
    refurb: (reusable ? 1 : x.preReusableRefurbMult.base) * Math.max(0.05, Math.min(1, c.launchGen)),
    life: reusable ? 1 : x.preReusableLifeMult.base,
    elec: Math.pow(Math.max(1, c.energyFx), -x.energyPriceElasticity.base),
    learning,
  };
}

/** Earth-produced methalox: price per kg of each species, and what goes into it. */
function earthPropPrices(a: Assumptions, m: Mults) {
  const C = a.commodities, elec = C.electricityPrice.base * m.elec;
  const ch4 = { feedstock: C.methaneFeedstock.base, purification: C.methanePurification.base, liquefaction: C.methaneLiquefactionKWhPerKg.base * elec, conditioning: C.conditioningStoragePerKg.base };
  const lox = { energy: C.oxygenProductionKWhPerKg.base * elec, conditioning: C.conditioningStoragePerKg.base };
  return { ch4, lox, loss: C.groundBoiloffFraction.base, margin: C.supplierMargin.base, mult: m.prop };
}

/** Propellant cost of loading `kg` of methalox on Earth, with every line item. */
function earthPropellant(kg: number, a: Assumptions, m: Mults): PropDetail {
  const r = a.starship.oxygenFuelMassRatio.base;
  const methaneKg = kg / (r + 1), oxygenKg = kg - methaneKg;
  const p = earthPropPrices(a, m), k = p.mult;
  const feedstock = methaneKg * p.ch4.feedstock * k, purification = methaneKg * p.ch4.purification * k;
  const liquefaction = methaneKg * p.ch4.liquefaction * k, oxygenEnergy = oxygenKg * p.lox.energy * k;
  const conditioning = (methaneKg * p.ch4.conditioning + oxygenKg * p.lox.conditioning) * k;
  const sub = feedstock + purification + liquefaction + oxygenEnergy + conditioning;
  const boiloff = sub * p.loss;
  return { methaneKg, oxygenKg, feedstock, purification, liquefaction, oxygenEnergy, conditioning, boiloff, margin: (sub + boiloff) * p.margin };
}
const propTotal = (p: PropDetail) => p.feedstock + p.purification + p.liquefaction + p.oxygenEnergy + p.conditioning + p.boiloff + p.margin;

/** Off-Earth methalox per kg: ISRU at the place, or imported. */
function offEarthPropPerKg(isru: boolean, a: Assumptions): number {
  const C = a.commodities;
  return isru ? C.isruKWhPerKg.base * C.offEarthElectricity.base + C.isruPlantPerKg.base : C.importedPropellantPerKg.base;
}

type Role = 'ship' | 'crew' | 'tanker' | 'depot';

/** One launch of the Starship-class vehicle from `origin` (0 Earth with booster, 1 single-stage from a surface). */
function launchCost(role: Role, origin: number, a: Assumptions, m: Mults, ctx: MissionContext, isruOrigin: boolean, offEarthOps: number): { cost: Costs; prop: PropDetail; propKg: number; offKg: number } {
  const S = a.starship, cost = zeroCosts();
  const earth = origin === 0, elevator = earth && (ctx.flags & CF.elevator) !== 0;
  const booster = earth && !elevator;
  const shipBuild = S.shipBuildCost.base * m.manuf * m.learning, boosterBuild = booster ? S.boosterBuildCost.base * m.manuf * m.learning : 0;
  const shipLife = Math.max(1, S.shipDesignLifeFlights.base * S.fleetRetirementFactor.base * m.life);
  const boosterLife = Math.max(1, S.boosterDesignLifeFlights.base * S.fleetRetirementFactor.base * m.life);
  cost.hardware = shipBuild / shipLife + boosterBuild / boosterLife;
  let prop = zeroProp(), propKg = 0, offKg = 0;
  if (booster) {
    propKg = S.shipPropellantKg.base + S.boosterPropellantKg.base;
    prop = earthPropellant(propKg, a, m);
    cost.propellantEarth = propTotal(prop);
  } else if (elevator) {
    // no ascent burn: the ship rides the elevator; its lift is the launch-site cost
    const liftKg = S.shipDryMassKg.base + S.payloadToLeoKg.base;
    cost.groundOps += liftKg * (a.commodities.elevatorKWhPerKg.base * a.commodities.electricityPrice.base * m.elec + a.commodities.elevatorOpsPerKg.base * m.ops);
    cost.infrastructure += liftKg * a.commodities.elevatorCapitalPerKg.base;
  } else {
    offKg = S.shipPropellantKg.base;
    cost.propellantOffEarth = offKg * offEarthPropPerKg(isruOrigin, a) * m.prop;
  }
  const site = earth ? 1 : offEarthOps;
  cost.refurbishment = S.refurbishmentPerFlight.base * m.refurb * m.learning * (booster ? 1 : 0.5);
  cost.groundOps += S.groundOpsPerFlight.base * m.ops * m.refurb * site;
  const opsFactor = role === 'crew' ? S.crewOpsMultiplier.base : role === 'tanker' || role === 'depot' ? S.tankerOpsFactor.base : 1;
  cost.missionOps = S.missionOpsPerFlight.base * opsFactor * m.ops;
  cost.rangeRegulatory = S.rangeRegulatoryPerFlight.base * m.ops * (earth ? 1 : 0.5);
  cost.payloadIntegration = role === 'tanker' || role === 'depot' ? 0 : S.payloadIntegrationCost.base * (role === 'crew' ? S.crewIntegrationMultiplier.base : 1) * m.ops;
  if (!elevator) {
    const annual = S.infrastructureCapital.base * (crf(a.mission.discountRate.base, S.infrastructureLifeYears.base) + S.infrastructureOandM.base) * site;
    cost.infrastructure += annual / Math.max(1, S.annualInfrastructureFlights.base * m.cadence);
  }
  const pLoss = Math.min(0.9, S.missionFailureProbability.base + m.lossAdd);
  cost.expectedLoss = pLoss * S.lossResidualFraction.base * (shipBuild + boosterBuild);
  cost.insurance = (S.thirdPartyInsurancePerFlight.base + S.insuranceRiskLoading.base * cost.expectedLoss) * m.insurance;
  return { cost, prop, propKg, offKg };
}

function infeasible(spec: MissionSpec, vehicle: VehicleId, version: string): Economics {
  return {
    feasible: false, vehicle, version, returnMode: 'n/a', ships: 0, tankersPerShip: 0, tankerFlights: 0, depotLaunches: 0, missionLaunches: 0, totalLaunches: 0,
    crew: spec.crew, payloadKg: payloadOf(spec, baselineMissionMass), earthLaunchedKg: 0, methaneKg: 0, oxygenKg: 0, otherPropKg: 0, offEarthPropKg: 0,
    cost: zeroCosts(), total: 0, tankerCost: 0, marginal: 0, customerPrice: 0, costPerKg: 0, costPerPassenger: 0, pMissionLoss: 0, prop: zeroProp(),
  };
}
const baselineMissionMass = MISSION.massPerPassengerKg.base;
function payloadOf(spec: MissionSpec, perPassenger: number): number { return spec.crew * perPassenger + spec.cargoKg; }

function finish(e: Economics, spec: MissionSpec, a: Assumptions): Economics {
  e.total = sumCosts(e.cost);
  const c = e.cost;
  e.marginal = c.propellantEarth + c.propellantOffEarth + c.refurbishment + c.groundOps + c.missionOps + c.rangeRegulatory + c.payloadIntegration + c.inSpaceOps + c.insurance +
    (e.returnMode === 'expend' || e.returnMode === 'one-way' ? c.hardware : 0);
  e.customerPrice = (e.total - c.missionHardware) * (1 + a.mission.customerMargin.base);
  e.costPerKg = e.payloadKg > 0 ? e.total / e.payloadKg : 0;
  e.costPerPassenger = spec.crew > 0 ? e.total / spec.crew : 0;
  return e;
}

/** Starship-class campaign: mission ships, tankers, an optional depot, and the return of each ship. */
function chemCampaign(spec: MissionSpec, ctx: MissionContext, a: Assumptions, m: Mults): Economics | null {
  const S = a.starship, M = a.mission, R = spec.route;
  const ve = S.ispVacS.base * G0 / 1000;
  const elevator = R.origin === 0 && (ctx.flags & CF.elevator) !== 0;
  const isruDest = (ctx.flags & CF.isruDest) !== 0, isruOrigin = (ctx.flags & CF.isruOrigin) !== 0;
  const offOps = M.offEarthOpsMultiplier.base;
  const dvOut = Math.max(0, R.outKmS + M.transferMarginKmS.base - (elevator ? M.elevatorDvCreditKmS.base : 0));
  const eOut = Math.exp(dvOut / ve), eBack = Math.exp(R.backKmS / ve), eAsc = Math.exp(R.ascentKmS / ve);
  const cap = S.shipPropellantKg.base, dry = S.shipDryMassKg.base;
  const payloadKg = payloadOf(spec, M.massPerPassengerKg.base);
  // mass driver: an airless, low-gravity origin flings the cargo to orbit; the ships only carry people
  const driver = R.origin === 1 && (ctx.flags & CF.massDriver) !== 0 && R.ascentKmS < 2.6 && spec.cargoKg > 0;
  const shipCargo = driver ? payloadKg - spec.cargoKg : payloadKg;
  const returnProp = dry * (eBack - 1);
  let best: Economics | null = null;
  for (const mode of ['reuse-isru', 'reuse-carried', 'expend'] as ReturnMode[]) {
    if (mode === 'reuse-isru' && !isruDest) continue;
    if (spec.forceReturn && spec.forceReturn !== mode) continue;
    const carry = mode === 'reuse-carried' ? returnProp : 0;
    // most payload one ship can take: (dry + p + carry)(e − 1) + carry ≤ cap, and no more than it can lift
    let pMax = (cap - carry) / Math.max(1e-9, eOut - 1) - dry - carry;
    pMax = Math.min(pMax, S.payloadToLeoKg.base);
    if (R.origin === 1) pMax = Math.min(pMax, cap / Math.max(1e-9, eAsc - 1) - dry);
    if (pMax < 1000 && shipCargo > 0) continue;
    const bySeats = spec.crew > 0 ? spec.crew / Math.max(1, S.seats.base) : 0;
    const byMass = shipCargo > 0 ? shipCargo / pMax : 0;
    const ships = spec.kind === 'service' ? Math.max(bySeats, byMass) : Math.max(1, Math.ceil(bySeats - 1e-9), Math.ceil(byMass - 1e-9));
    if (!(ships > 0)) continue;
    const pShip = shipCargo / ships;
    const burn = (dry + pShip + carry) * (eOut - 1) + carry;
    if (burn > cap * (1 + 1e-9)) continue;
    const residual = R.origin === 2 ? burn : Math.min(burn, S.ascentResidualKg.base);
    const required = Math.max(0, burn - residual);
    for (const depot of [false, true]) {
      const e = campaignWith(spec, ctx, a, m, { mode, depot, ships, required, payloadKg, returnProp, isruOrigin, offOps, elevator, driver });
      if (e && (!best || e.total < best.total)) best = e;
      if (required <= 0) break;
    }
  }
  return best;
}

interface CampaignOpts { mode: ReturnMode; depot: boolean; ships: number; required: number; payloadKg: number; returnProp: number; isruOrigin: boolean; offOps: number; elevator: boolean; driver: boolean }

function campaignWith(spec: MissionSpec, ctx: MissionContext, a: Assumptions, m: Mults, o: CampaignOpts): Economics | null {
  const S = a.starship, M = a.mission, R = spec.route, C = a.commodities;
  const ve = S.ispVacS.base * G0 / 1000;
  const e: Economics = { ...infeasible(spec, 'starship', S.version), feasible: true, returnMode: o.mode, ships: o.ships, payloadKg: o.payloadKg };
  const crewRole: Role = spec.crew > 0 ? 'crew' : 'ship';
  const ship = launchCost(crewRole, R.origin === 2 ? 1 : R.origin, a, m, ctx, o.isruOrigin, o.offOps);
  // in-space origins (habitats, small asteroids) need no ascent: only the departure load
  if (R.origin === 2) { ship.cost.propellantOffEarth = 0; ship.offKg = 0; }
  addCosts(e.cost, ship.cost, o.ships);
  addProp(e.prop, ship.prop, o.ships);
  e.missionLaunches = o.ships;
  e.offEarthPropKg += ship.offKg * o.ships;
  // refuelling in the parking orbit: tankers from the origin, an asteroid depot, an elevator, or local ISRU propellant
  let tankerCost = 0;
  if (o.required > 0) {
    const depotFactor = o.depot ? S.depotBoiloffFactor.base : 1;
    const boil = Math.min(0.5, S.boiloffPerDay.base * S.loiterDays.base * depotFactor);
    const perTanker = R.origin === 0 ? S.tankerPayloadKg.base : Math.min(S.shipPropellantKg.base - S.shipDryMassKg.base * (Math.exp(R.ascentKmS / ve) - 1), 2 * S.tankerPayloadKg.base);
    const effective = perTanker * S.transferEfficiency.base * (1 - boil) * (1 - S.reserveFraction.base);
    const need = o.required * (1 + S.missionMargin.base);
    const options: { cost: Costs; prop: PropDetail; tankers: number; depot: number; offKg: number; earthKg: number; tankerCost: number }[] = [];
    if (R.origin === 2) {
      // a space origin fills straight from local stock (ISRU) or imports
      const c = zeroCosts();
      c.propellantOffEarth = need * offEarthPropPerKg(o.isruOrigin, a) * m.prop;
      options.push({ cost: c, prop: zeroProp(), tankers: 0, depot: 0, offKg: need, earthKg: 0, tankerCost: 0 });
    } else if (effective > 0) {
      const tankers = Math.ceil(need / (effective * (1 - S.scrubFailAllowance.base)) - 1e-9);
      const t = launchCost('tanker', R.origin, a, m, ctx, o.isruOrigin, o.offOps);
      const d = o.depot ? launchCost('depot', R.origin, a, m, ctx, o.isruOrigin, o.offOps) : null;
      const c = zeroCosts(); addCosts(c, t.cost, tankers); if (d) addCosts(c, d.cost, 1);
      const p = zeroProp(); addProp(p, t.prop, tankers); if (d) addProp(p, d.prop, 1);
      options.push({ cost: c, prop: p, tankers, depot: d ? 1 : 0, offKg: (t.offKg * tankers + (d?.offKg ?? 0)), earthKg: R.origin === 0 ? tankers * perTanker : 0, tankerCost: sumCosts(c) });
    }
    if (R.origin !== 2 && (ctx.flags & CF.asteroidDepot) !== 0 && !o.depot) {
      const c = zeroCosts(); c.propellantOffEarth = need * C.asteroidDepotPerKg.base;
      options.push({ cost: c, prop: zeroProp(), tankers: 0, depot: 0, offKg: need, earthKg: 0, tankerCost: 0 });
    }
    if (o.elevator && !o.depot) {
      // propellant rides the elevator up: Earth propellant plus lift energy and capital per kg
      const c = zeroCosts(), p = earthPropellant(need, a, m);
      c.propellantEarth = propTotal(p);
      c.groundOps = need * (C.elevatorKWhPerKg.base * C.electricityPrice.base * m.elec + C.elevatorOpsPerKg.base * m.ops);
      c.infrastructure = need * C.elevatorCapitalPerKg.base;
      options.push({ cost: c, prop: p, tankers: 0, depot: 0, offKg: 0, earthKg: need, tankerCost: sumCosts(c) });
    }
    if (!options.length) return null;
    let pick = options[0];
    for (const x of options) if (sumCosts(x.cost) < sumCosts(pick.cost)) pick = x;
    const per = o.ships;
    addCosts(e.cost, pick.cost, per); addProp(e.prop, pick.prop, per);
    e.tankersPerShip = pick.tankers; e.tankerFlights = pick.tankers * per; e.depotLaunches = pick.depot * per;
    e.offEarthPropKg += pick.offKg * per; e.earthLaunchedKg += pick.earthKg * per; tankerCost = pick.tankerCost * per;
  } else if (o.depot) return null;
  // the cargo a mass driver flings up
  if (o.driver) {
    e.cost.groundOps += spec.cargoKg * C.massDriverKWhPerKg.base * C.offEarthElectricity.base;
    e.cost.infrastructure += spec.cargoKg * C.elevatorCapitalPerKg.base * 0.5;
  }
  if (R.origin === 0) e.earthLaunchedKg += o.payloadKg;
  // the ship's way home: expended, made at the destination, or already aboard
  if (o.mode === 'expend') {
    const full = S.shipBuildCost.base * m.manuf * m.learning;
    const amort = full / Math.max(1, S.shipDesignLifeFlights.base * S.fleetRetirementFactor.base * m.life);
    e.cost.hardware += (full - amort) * o.ships;
  } else if (o.mode === 'reuse-isru') {
    e.cost.propellantOffEarth += o.returnProp * offEarthPropPerKg(true, a) * o.ships;
    e.offEarthPropKg += o.returnProp * o.ships;
    e.cost.inSpaceOps += M.destinationOpsPerCampaign.base * 0.2 * o.ships * m.ops; // refuelling on the ground there
  }
  // what the mission brings and what it costs to fly
  const kitKg = spec.kind === 'crew' ? spec.cargoKg : 0;
  e.cost.missionHardware = kitKg * M.missionHardwarePerKg.base * m.manuf;
  const years = spec.kind === 'service' ? M.serviceTransitYears.base : Math.max(0.1, R.transitYears);
  e.cost.inSpaceOps += spec.crew * years * M.lifeSupportPerPersonYear.base * m.ops + (spec.kind === 'service' ? 0.2 * o.ships : 1) * M.destinationOpsPerCampaign.base * m.ops;
  e.depotLaunches = e.depotLaunches;
  e.totalLaunches = e.missionLaunches + e.tankerFlights + e.depotLaunches;
  e.tankerCost = tankerCost;
  e.methaneKg = e.prop.methaneKg; e.oxygenKg = e.prop.oxygenKg;
  const pLaunch = Math.min(0.9, S.missionFailureProbability.base + m.lossAdd);
  e.pMissionLoss = 1 - Math.pow((1 - pLaunch) * (1 - Math.min(0.5, M.transitLossPerYear.base * years)), Math.max(1, o.ships));
  return finish(e, spec, a);
}

/** Crew and cargo ride Starship-class launches to the parking orbit, then a nuclear or fusion transport does the rest. */
function transportCampaign(spec: MissionSpec, ctx: MissionContext, a: Assumptions, m: Mults, kind: 'ntp' | 'fusion'): Economics | null {
  const S = a.starship, M = a.mission, R = spec.route;
  const N = a.ntp, Fu = a.fusion;
  const payloadKg = payloadOf(spec, M.massPerPassengerKg.base);
  const ve = kind === 'ntp' ? N.ispS.base * G0 / 1000 : Fu.exhaustKmS.base;
  const dry = kind === 'ntp' ? N.dryMassKg.base : Fu.dryMassKg.base;
  const pCap = kind === 'ntp' ? N.payloadMaxKg.base : Fu.payloadMaxKg.base;
  const dv = R.outKmS + M.transferMarginKmS.base, eOut = Math.exp(dv / ve), eBack = Math.exp(R.backKmS / ve);
  const tank = kind === 'ntp' ? N.tankCapacityKg.base : Infinity;
  const isruDest = (ctx.flags & CF.isruDest) !== 0;
  const ret = dry * (eBack - 1);
  // the cheapest way home that still leaves room for payload: carried, made at the destination, or none (expended)
  let mode: ReturnMode | null = null, pMax = 0;
  for (const md of ['reuse-carried', 'reuse-isru', 'expend'] as ReturnMode[]) {
    if (md === 'reuse-isru' && !isruDest) continue;
    const carry = md === 'reuse-carried' ? ret : 0;
    const p = Math.min(pCap, (tank - carry) / Math.max(1e-9, eOut - 1) - dry - carry);
    if (p >= 1000) { mode = md; pMax = p; break; }
  }
  if (!mode) return null;
  const carry = mode === 'reuse-carried' ? ret : 0;
  const trips = spec.kind === 'service' ? payloadKg / pMax : Math.max(1, Math.ceil(payloadKg / pMax - 1e-9));
  const pTrip = payloadKg / Math.max(1e-9, trips);
  const propPerTrip = (dry + pTrip + carry) * (eOut - 1) + carry;
  const e: Economics = { ...infeasible(spec, kind, kind === 'ntp' ? N.version : Fu.version), feasible: true, returnMode: mode, payloadKg, ships: trips };
  // lifts from the origin to the parking orbit
  const isruOrigin = (ctx.flags & CF.isruOrigin) !== 0;
  if (R.origin !== 2) {
    const lifts = spec.kind === 'service' ? payloadKg / S.payloadToLeoKg.base : Math.max(1, Math.ceil(payloadKg / S.payloadToLeoKg.base - 1e-9));
    const l = launchCost(spec.crew > 0 ? 'crew' : 'ship', R.origin, a, m, ctx, isruOrigin, M.offEarthOpsMultiplier.base);
    addCosts(e.cost, l.cost, lifts); addProp(e.prop, l.prop, lifts);
    e.missionLaunches = lifts; e.offEarthPropKg += l.offKg * lifts;
    if (R.origin === 0) e.earthLaunchedKg += payloadKg;
  }
  // the transport itself, amortised over its trips
  const build = (kind === 'ntp' ? N.buildCost.base : Fu.buildCost.base) * m.manuf;
  const life = Math.max(1, kind === 'ntp' ? N.lifeTrips.base : Fu.lifeTrips.base);
  const pLoss = Math.min(0.9, (kind === 'ntp' ? N.failureProbability.base : Fu.failureProbability.base) + m.lossAdd);
  e.cost.hardware += (mode === 'expend' ? build : build / life) * trips;
  if (mode === 'reuse-isru') { e.cost.propellantOffEarth += ret * (kind === 'ntp' ? offEarthPropPerKg(true, a) : a.commodities.fusionFuelPerKg.base) * trips; e.offEarthPropKg += ret * trips; }
  e.cost.missionOps += (kind === 'ntp' ? N.opsPerTrip.base : Fu.opsPerTrip.base) * m.ops * trips;
  e.cost.expectedLoss += pLoss * S.lossResidualFraction.base * build * trips;
  e.cost.insurance += S.insuranceRiskLoading.base * pLoss * S.lossResidualFraction.base * build * trips * m.insurance;
  if (kind === 'ntp' && R.origin === 2) {
    // a space origin fills its hydrogen tanks from local ice (ISRU) or imports
    const need = propPerTrip * (1 + S.missionMargin.base);
    e.cost.propellantOffEarth += need * offEarthPropPerKg(isruOrigin, a) * m.prop * trips;
    e.otherPropKg = need * trips; e.offEarthPropKg += need * trips;
  } else if (kind === 'ntp') {
    // hydrogen comes up in tankers that carry less of it than methalox
    const boil = Math.min(0.6, S.boiloffPerDay.base * N.lh2BoiloffMult.base * S.loiterDays.base);
    const effective = S.tankerPayloadKg.base * N.lh2PerTankerFraction.base * S.transferEfficiency.base * (1 - boil) * (1 - S.reserveFraction.base);
    const need = propPerTrip * (1 + S.missionMargin.base);
    const tankers = Math.ceil(need / (effective * (1 - S.scrubFailAllowance.base)) - 1e-9);
    const t = launchCost('tanker', R.origin, a, m, ctx, isruOrigin, M.offEarthOpsMultiplier.base);
    // the tanker's own methalox, plus the hydrogen it delivers
    const c = zeroCosts(); addCosts(c, t.cost, tankers);
    c.propellantEarth += need * a.commodities.lh2PerKg.base * m.prop;
    addCosts(e.cost, c, trips); addProp(e.prop, t.prop, tankers * trips);
    e.tankersPerShip = tankers; e.tankerFlights = tankers * trips; e.tankerCost = sumCosts(c) * trips;
    e.otherPropKg = need * trips; e.offEarthPropKg += t.offKg * tankers * trips;
    if (R.origin === 0) e.earthLaunchedKg += need * trips;
  } else {
    const fuel = propPerTrip * (1 + S.missionMargin.base);
    e.cost.propellantOffEarth += fuel * a.commodities.fusionFuelPerKg.base * trips;
    e.otherPropKg = fuel * trips;
  }
  const kitKg = spec.kind === 'crew' ? spec.cargoKg : 0;
  e.cost.missionHardware = kitKg * M.missionHardwarePerKg.base * m.manuf;
  const years = spec.kind === 'service' ? M.serviceTransitYears.base : Math.max(0.1, R.transitYears * (kind === 'fusion' ? 0.3 : 0.7));
  e.cost.inSpaceOps += spec.crew * years * M.lifeSupportPerPersonYear.base * m.ops + M.destinationOpsPerCampaign.base * m.ops * (spec.kind === 'service' ? 0.2 * trips : 1);
  e.totalLaunches = e.missionLaunches + e.tankerFlights;
  e.methaneKg = e.prop.methaneKg; e.oxygenKg = e.prop.oxygenKg;
  e.pMissionLoss = 1 - Math.pow((1 - pLoss) * (1 - Math.min(0.5, M.transitLossPerYear.base * years)), Math.max(1, trips));
  return finish(e, spec, a);
}

/** Interstellar ship: built in orbit, flown once. */
function interstellarShip(spec: MissionSpec, ctx: MissionContext, a: Assumptions, m: Mults): Economics {
  const I = a.interstellar;
  const id: VehicleId = spec.kind === 'warp' ? 'warp' : (ctx.flags & CF.seedShips) ? 'seed' : (ctx.flags & CF.genShip) ? 'generation' : 'fusionArk';
  const cls = I.classes[id as 'warp' | 'seed' | 'generation' | 'fusionArk'];
  const massKg = cls.massFixedKg.base + spec.crew * cls.massPerColonistKg.base;
  const e: Economics = { ...infeasible(spec, id, cls.version), feasible: true, returnMode: 'one-way', ships: 1, missionLaunches: 1, totalLaunches: 1, payloadKg: massKg };
  const yard = (ctx.flags & CF.shipyards) ? I.shipyardFactor.base : 1;
  e.cost.hardware = massKg * I.structureCostPerKg.base * cls.complexity.base * m.manuf * yard;
  if (id === 'warp') e.cost.propellantOffEarth = I.warpEnergyCost.base * m.elec;
  else {
    const v = Math.max(0.001, ctx.shipSpeedC);
    const [veC, price] = v <= 0.05 ? [I.fusionExhaustC.base, I.fusionFuelPerKg.base] : v <= 0.15 ? [I.antimatterExhaustC.base, I.antimatterFuelPerKg.base] : [I.beamedExhaustC.base, I.beamedFuelPerKg.base];
    const ratio = Math.min(I.maxMassRatio.base, Math.exp((2 * v) / veC)); // accelerate, then brake
    e.otherPropKg = massKg * (ratio - 1);
    e.cost.propellantOffEarth = e.otherPropKg * price;
  }
  e.cost.missionHardware = spec.crew * I.colonyKitPerColonist.base * m.manuf;
  e.cost.missionOps = spec.crew * I.opsPerColonist.base * m.ops;
  e.cost.groundOps = I.departureOps.base * m.ops + spec.crew * I.liftPerColonist.base;
  e.cost.infrastructure = I.shipyardCapital.base * yard / Math.max(1, I.shipsPerShipyard.base);
  // self-insured: the expected cost of replacing what is lost on the way
  e.pMissionLoss = Math.max(0, Math.min(1, ctx.pLossTransit));
  e.cost.expectedLoss = e.pMissionLoss * (e.cost.hardware + e.cost.missionHardware);
  return finish(e, spec, a);
}

/** Price one mission: the cheapest feasible vehicle and campaign the context allows. */
export function evaluate(spec: MissionSpec, ctx: MissionContext, a: Assumptions): Economics {
  const m = mults(ctx, a);
  if (spec.kind === 'interstellar' || spec.kind === 'warp') return interstellarShip(spec, ctx, a, m);
  let best = chemCampaign(spec, ctx, a, m);
  for (const k of ['ntp', 'fusion'] as const) {
    if (!(ctx.flags & (k === 'ntp' ? CF.ntp : CF.fusion))) continue;
    const e = transportCampaign(spec, ctx, a, m, k);
    if (e && (!best || e.total < best.total)) best = e;
  }
  return best ?? infeasible(spec, 'starship', a.starship.version);
}

/** The all-cheap and all-costly envelope: every input at the end that lowers (raises) cost. Not a confidence interval. */
export function envelope(spec: MissionSpec, ctx: MissionContext, a: Assumptions): { low: Economics; base: Economics; high: Economics } {
  const lo = mapBases(a, (x) => (x.dir > 0 ? x.low : x.dir < 0 ? x.high : x.base));
  const hi = mapBases(a, (x) => (x.dir > 0 ? x.high : x.dir < 0 ? x.low : x.base));
  return { low: evaluate(spec, ctx, lo), base: evaluate(spec, ctx, a), high: evaluate(spec, ctx, hi) };
}

/** Faster envelope totals for the engine (same result as `envelope`, with the two variants built once). */
export class EnvelopeCache {
  readonly base: Assumptions; readonly lo: Assumptions; readonly hi: Assumptions;
  constructor(base: Assumptions) {
    this.base = base;
    this.lo = mapBases(base, (x) => (x.dir > 0 ? x.low : x.dir < 0 ? x.high : x.base));
    this.hi = mapBases(base, (x) => (x.dir > 0 ? x.high : x.dir < 0 ? x.low : x.base));
  }
}

export interface Sensitivity { path: string; label: string; unit: string; low: number; high: number; atLow: number; atHigh: number; swing: number; classification: EvidenceClass }

/** One-at-a-time (tornado) sensitivity of total campaign cost to every uncertain input. */
export function sensitivity(spec: MissionSpec, ctx: MissionContext, a: Assumptions): Sensitivity[] {
  const out: Sensitivity[] = [];
  for (const [path, x] of ranges(a)) {
    if (path.startsWith('budget.') || x.label.startsWith('Provider margin')) continue;
    if (x.low === x.high) continue;
    const at = (v: number) => evaluate(spec, ctx, mapBases(a, (y, p) => (p === path ? v : y.base))).total;
    const atLow = at(x.low), atHigh = at(x.high);
    out.push({ path, label: x.label, unit: x.unit, low: x.low, high: x.high, atLow, atHigh, swing: Math.abs(atHigh - atLow), classification: x.classification });
  }
  return out.filter((s) => s.swing > 0).sort((p, q) => q.swing - p.swing);
}

/** Seeded Monte Carlo over triangular(low, base, high) inputs, on demand only (never inside a simulation step). */
export function monteCarlo(spec: MissionSpec, ctx: MissionContext, a: Assumptions, n = 400, seed = 1): { p10: number; p50: number; p90: number; mean: number; n: number } {
  const rng = seedRng(seed);
  const tri = (x: SourcedRange) => {
    const { low: lo, base: c, high: hi } = x;
    if (hi <= lo) return c;
    const u = next(rng), f = (c - lo) / (hi - lo);
    return u < f ? lo + Math.sqrt(u * (hi - lo) * (c - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - c));
  };
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = evaluate(spec, ctx, mapBases(a, (x, p) => (p.startsWith('budget.') ? x.base : tri(x)))).total;
    if (Number.isFinite(t)) xs.push(t);
  }
  xs.sort((p, q) => p - q);
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))] ?? 0;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), mean: xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length), n: xs.length };
}

// ---------------------------------------------------------------- affordability

/** Per-step transport budget of a funding polity (in-system missions and services share it). */
export function stepBudget(a: Assumptions, era: number, gdp: number, capital: number, dt: number): number {
  const B = a.budget, eraK = B.eraBudget[era] ?? 1;
  return Math.max(0, Math.min(B.capitalShare.base * capital, B.transportGdpShare.base * eraK * gdp * Math.max(dt, 2)));
}
/** Most one interstellar mission may cost the seat that funds it (bible §3.6 rule, era-weighted). */
export function interstellarAllowance(a: Assumptions, era: number, gdp: number, capital: number): number {
  const B = a.budget, eraK = B.eraBudget[era] ?? 1;
  return Math.max(0, Math.min(B.interstellarCapitalShare.base * capital, B.interstellarGdpShare.base * B.interstellarBuildYears.base * eraK * gdp));
}

// ---------------------------------------------------------------- geometry

const AU = 1.496e11, MU_SUN = 1.32712e20;
const muOf = (b: Body) => b.g * G0 * (b.radius * 1e3) ** 2;
const vCirc = (b: Body, alt = 1.05) => Math.sqrt(muOf(b) / (b.radius * 1e3 * alt)) / 1000;
/** Bodies where a lander can aerobrake. */
export function hasAtmosphere(b: Body): boolean {
  return b.kind === 'superearth' || b.kind === 'ocean' || b.kind === 'desert' || b.kind === 'lava' || (b.kind === 'rocky' && b.hab >= 0.2) || b.name === 'Titan';
}
/** Surface to low orbit: 1.15 × circular speed, plus ≈1.5 km/s of drag and steering in a thick atmosphere. */
export function ascentDv(b: Body): number {
  if (b.kind === 'habitat' || b.g < 0.003) return 0;
  return 1.15 * vCirc(b, 1) + (hasAtmosphere(b) && b.g > 0.5 ? 1.5 : 0);
}
function landingDv(b: Body, vInf: number, mLand: number): number {
  if (b.kind === 'habitat' || b.g < 0.003) return vInf;
  if (hasAtmosphere(b)) return mLand;
  const vc = vCirc(b), vesc = vc * Math.SQRT2;
  return Math.sqrt(vInf * vInf + vesc * vesc) - vc + 1.1 * vc;
}
function departDv(b: Body, vInf: number): number {
  if (b.kind === 'habitat' || b.g < 0.003) return vInf;
  const vc = vCirc(b), vesc = vc * Math.SQRT2;
  return Math.sqrt(vInf * vInf + vesc * vesc) - vc;
}

/**
 * Δv by patched conics: Hohmann transfer around the star (or around the shared planet, for its own
 * moons), departure from a low parking orbit with the Oberth effect, and capture plus landing at the
 * other end (aerobraking where there is air). Moons orbit their parent; their `a` is in 1,000 km.
 */
export function routeFor(world: World, from: number, to: number, landingKmS = MISSION.atmosphereLandingDvKmS.base): Route {
  const A = world.bodies[from], B = world.bodies[to];
  const sa = world.systems[A.system], sb = world.systems[B.system];
  const distanceLy = Math.hypot(sa.x - sb.x, sa.y - sb.y, sa.z - sb.z);
  const origin = A.id === world.earth ? 0 : ascentDv(A) > 0 ? 1 : 2;
  const ascentKmS = origin === 1 ? ascentDv(A) : 0;
  if (A.system !== B.system) return { origin, ascentKmS, outKmS: 0, backKmS: 0, transitYears: 0, distanceLy };
  const planetOf = (b: Body) => (b.parent >= 0 ? world.bodies[b.parent] : b);
  const pa = planetOf(A), pb = planetOf(B);
  let out: number, back: number, years: number;
  if (pa === pb) {
    // inside one planet's system: the planet is the central body
    const P = pa, mu = muOf(P);
    const rOf = (b: Body) => (b === P ? P.radius * 1e3 * 1.05 : b.a * 1e6);
    const r1 = rOf(A), r2 = rOf(B), at = (r1 + r2) / 2;
    const peri = (x: number) => Math.abs(Math.sqrt(mu * (2 / x - 1 / at)) - Math.sqrt(mu / x)) / 1000;
    const d1 = peri(r1), d2 = peri(r2);
    out = (A === P ? d1 : departDv(A, d1)) + (B === P ? (hasAtmosphere(B) ? landingKmS : d2) : landingDv(B, d2, landingKmS));
    // home again: lift off, leave, and capture into the origin's parking orbit (aerobraking where there is air)
    back = ascentDv(B) + (B === P ? d2 : departDv(B, d2)) + (A === P ? (hasAtmosphere(A) ? 0 : d1) : departDv(A, d1));
    years = Math.PI * Math.sqrt(at ** 3 / mu) / 3.156e7;
  } else {
    const M = Math.min(3, Math.max(0.08, Math.pow(Math.max(sa.lum, 1e-4), 0.25)));
    const mu = MU_SUN * M, r1 = pa.a * AU, r2 = pb.a * AU, at = (r1 + r2) / 2;
    const v1 = Math.sqrt(mu / r1), v2 = Math.sqrt(mu / r2);
    const vInf1 = Math.abs(Math.sqrt(mu * (2 / r1 - 1 / at)) - v1) / 1000, vInf2 = Math.abs(v2 - Math.sqrt(mu * (2 / r2 - 1 / at))) / 1000;
    // a moon of a giant: the giant's gravity well between the transfer and the moon's orbit
    const well = (b: Body, p: Body, vInf: number) => {
      const mup = muOf(p), rm = b.a * 1e6;
      return Math.max(0, Math.sqrt(vInf * vInf * 1e6 + 2 * mup / rm) - Math.sqrt(mup / rm)) / 1000;
    };
    const arrive = (b: Body, p: Body, vInf: number) => (b === p ? landingDv(b, vInf, landingKmS) : well(b, p, vInf) + landingDv(b, 0, landingKmS));
    const leave = (b: Body, p: Body, vInf: number) => (b === p ? departDv(b, vInf) : departDv(b, 0) + well(b, p, vInf));
    out = leave(A, pa, vInf1) + arrive(B, pb, vInf2);
    back = ascentDv(B) + leave(B, pb, vInf2) + (A === pa && hasAtmosphere(A) ? 0 : leave(A, pa, vInf1));
    years = Math.PI * Math.sqrt(at ** 3 / mu) / 3.156e7;
  }
  return { origin, ascentKmS, outKmS: out, backKmS: back, transitYears: years, distanceLy };
}

// ---------------------------------------------------------------- records

/** Column layout of one mission record (engine log, worker transfer, exports). */
export const MC_NAMES = [
  'id', 'year', 'from', 'to', 'funder', 'kind', 'vehicle', 'returnMode', 'outcome', 'crew', 'payloadKg', 'ships', 'missionLaunches', 'tankerFlights', 'tankersPerShip', 'depotLaunches', 'totalLaunches',
  'methaneKg', 'oxygenKg', 'otherPropKg', 'offEarthPropKg', 'earthLaunchedKg', 'total', 'low', 'high', 'tankerCost', 'marginal', 'customerPrice', 'costPerKg', 'costPerPassenger', 'pMissionLoss',
  ...COST_KEYS.map((k) => `c_${k}`),
  // inputs: enough to recompute the record exactly under any assumption set
  'in_cargoKg', 'in_origin', 'in_ascentKmS', 'in_outKmS', 'in_backKmS', 'in_transitYears', 'in_distanceLy',
  'ctx_era', 'ctx_flags', 'ctx_shortage', 'ctx_productivity', 'ctx_energyFx', 'ctx_launchGen', 'ctx_cumLaunches', 'ctx_pLossTransit', 'ctx_shipSpeedC', 'isru',
  /** 1: no campaign is feasible with every input at its costly end, so `high` repeats the base */
  'envFlags',
] as const;
export const MC = Object.fromEntries(MC_NAMES.map((n, i) => [n, i])) as Record<typeof MC_NAMES[number], number>;
export const NMC = MC_NAMES.length;
export const OUTCOME_NAMES = ['in transit', 'succeeded', 'lost'] as const;

export function packMission(row: Float64Array, o: number, meta: { id: number; year: number; from: number; to: number; funder: number }, spec: MissionSpec, ctx: MissionContext, e: Economics, low: Economics, high: Economics): void {
  const w = (k: keyof typeof MC, v: number) => { row[o + MC[k]] = v; };
  w('id', meta.id); w('year', meta.year); w('from', meta.from); w('to', meta.to); w('funder', meta.funder);
  w('kind', KIND.indexOf(spec.kind)); w('vehicle', VEHICLES.indexOf(e.vehicle)); w('returnMode', RETURN_MODES.indexOf(e.returnMode)); w('outcome', 0);
  w('crew', spec.crew); w('payloadKg', e.payloadKg); w('ships', e.ships); w('missionLaunches', e.missionLaunches); w('tankerFlights', e.tankerFlights); w('tankersPerShip', e.tankersPerShip);
  w('depotLaunches', e.depotLaunches); w('totalLaunches', e.totalLaunches); w('methaneKg', e.methaneKg); w('oxygenKg', e.oxygenKg); w('otherPropKg', e.otherPropKg);
  w('offEarthPropKg', e.offEarthPropKg); w('earthLaunchedKg', e.earthLaunchedKg); w('total', e.total); w('low', low.feasible ? Math.min(low.total, e.total) : e.total); w('high', high.feasible ? Math.max(high.total, e.total) : e.total); w('tankerCost', e.tankerCost);
  w('marginal', e.marginal); w('customerPrice', e.customerPrice); w('costPerKg', e.costPerKg); w('costPerPassenger', e.costPerPassenger); w('pMissionLoss', e.pMissionLoss);
  for (const k of COST_KEYS) row[o + MC[`c_${k}` as keyof typeof MC]] = e.cost[k];
  const R = spec.route;
  w('in_cargoKg', spec.cargoKg); w('in_origin', R.origin); w('in_ascentKmS', R.ascentKmS); w('in_outKmS', R.outKmS); w('in_backKmS', R.backKmS); w('in_transitYears', R.transitYears); w('in_distanceLy', R.distanceLy);
  w('ctx_era', ctx.era); w('ctx_flags', ctx.flags); w('ctx_shortage', ctx.shortage); w('ctx_productivity', ctx.productivity); w('ctx_energyFx', ctx.energyFx);
  w('ctx_launchGen', ctx.launchGen); w('ctx_cumLaunches', ctx.cumLaunches); w('ctx_pLossTransit', ctx.pLossTransit); w('ctx_shipSpeedC', ctx.shipSpeedC);
  w('isru', ctx.flags & CF.isruDest ? 1 : 0);
  w('envFlags', high.feasible ? 0 : 1);
}

/** Mission records in one growable table (NMC columns per row), with outcomes found by mission id. */
export class MissionLog {
  rows = new Float64Array(NMC * 256);
  n = 0;
  private at = new Map<number, number>();
  /** offset of a fresh row */
  add(id: number): number {
    if ((this.n + 1) * NMC > this.rows.length) { const b = new Float64Array(this.rows.length * 2); b.set(this.rows); this.rows = b; }
    const o = this.n * NMC;
    this.rows.fill(0, o, o + NMC);
    this.at.set(id, this.n++);
    return o;
  }
  row(id: number): number { return this.at.get(id) ?? -1; }
  setOutcome(id: number, v: number): void { const i = this.at.get(id); if (i !== undefined) this.rows[i * NMC + MC.outcome] = v; }
  /** forget missions launched in or after `year` (a replay from a snapshot taken then) */
  truncateFrom(year: number): void {
    while (this.n > 0 && this.rows[(this.n - 1) * NMC + MC.year] >= year) { this.n--; this.at.delete(this.rows[this.n * NMC + MC.id]); }
  }
  /** rows launched up to `year`, as a copy */
  upTo(year: number): Float64Array {
    let k = this.n;
    while (k > 0 && this.rows[(k - 1) * NMC + MC.year] > year) k--;
    return this.rows.slice(0, k * NMC);
  }
}

/** Earth to low orbit, per kg of payload, for the context's vehicle and ascent (rocket or elevator): a reference price of access. */
export function leoCostPerKg(ctx: MissionContext, a: Assumptions): number {
  const m = mults(ctx, a), S = a.starship, C = a.commodities;
  // an elevator climber carries cargo by the kilogram: no rocket flight is needed to reach orbit
  if (ctx.flags & CF.elevator) return C.elevatorKWhPerKg.base * C.electricityPrice.base * m.elec + C.elevatorOpsPerKg.base * m.ops + C.elevatorCapitalPerKg.base;
  const l = launchCost('ship', 0, a, m, ctx, false, 1);
  return sumCosts(l.cost) / S.payloadToLeoKg.base;
}

export function unpackMission(row: ArrayLike<number>, o = 0): { spec: MissionSpec; ctx: MissionContext } {
  const g = (k: keyof typeof MC) => row[o + MC[k]];
  return {
    spec: { kind: KIND[g('kind')], crew: g('crew'), cargoKg: g('in_cargoKg'), route: { origin: g('in_origin'), ascentKmS: g('in_ascentKmS'), outKmS: g('in_outKmS'), backKmS: g('in_backKmS'), transitYears: g('in_transitYears'), distanceLy: g('in_distanceLy') } },
    ctx: { era: g('ctx_era'), flags: g('ctx_flags'), shortage: g('ctx_shortage'), productivity: g('ctx_productivity'), energyFx: g('ctx_energyFx'), launchGen: g('ctx_launchGen'), cumLaunches: g('ctx_cumLaunches'), pLossTransit: g('ctx_pLossTransit'), shipSpeedC: g('ctx_shipSpeedC') },
  };
}

/** A whole assumption set as plain data, for exports. */
export function assumptionsTable(a: Assumptions): Record<string, unknown>[] {
  return ranges(a).map(([path, x]) => ({ path, label: x.label, value: x.base, low: x.low, high: x.high, unit: x.unit, confidence: x.confidence, classification: x.classification, sourceTitle: x.sourceTitle, sourceUrl: x.sourceUrl, sourceDate: x.sourceDate, note: x.note ?? '' }));
}
