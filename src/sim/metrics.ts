// Every global number the engine records each step. The order here is the
// column order of the series buffer.

export interface MetricDef { key: string; label: string; unit: string; log?: boolean; group: string; /** kept in the series for the engine but never offered as data */ internal?: true }

export const GLOBAL_METRICS: MetricDef[] = [
  { key: 'pop', label: 'Population', unit: 'people', log: true, group: 'People' },
  { key: 'offEarth', label: 'Off-Earth population', unit: 'people', log: true, group: 'People' },
  { key: 'interstellarPop', label: 'Population beyond Sol', unit: 'people', log: true, group: 'People' },
  { key: 'births', label: 'Births per year', unit: '/yr', log: true, group: 'People' },
  { key: 'deaths', label: 'Deaths per year', unit: '/yr', log: true, group: 'People' },
  { key: 'medianAge', label: 'Median age', unit: 'yr', group: 'People' },
  { key: 'lifeExp', label: 'Life expectancy at birth', unit: 'yr', group: 'People' },
  { key: 'tfr', label: 'Children per woman (TFR)', unit: '', group: 'People' },
  { key: 'divergence', label: 'Max genetic divergence', unit: 'idx', group: 'People' },
  { key: 'settlements', label: 'Living settlements', unit: '', log: true, group: 'Expansion' },
  { key: 'systems', label: 'Star systems settled', unit: '', log: true, group: 'Expansion' },
  { key: 'surveyed', label: 'Worlds surveyed', unit: '', log: true, group: 'Expansion' },
  { key: 'reach', label: 'Farthest settlement', unit: 'ly', log: true, group: 'Expansion' },
  { key: 'shipsInTransit', label: 'Ships in transit', unit: '', group: 'Expansion' },
  { key: 'shipsLaunched', label: 'Ships launched (total)', unit: '', log: true, group: 'Expansion' },
  { key: 'shipsLost', label: 'Ships lost (total)', unit: '', group: 'Expansion' },
  { key: 'dead', label: 'Settlements lost (total)', unit: '', group: 'Expansion' },
  { key: 'energy', label: 'Energy use', unit: 'W', log: true, group: 'Energy' },
  { key: 'kardashev', label: 'Kardashev rating', unit: 'K', group: 'Energy' },
  { key: 'energyPerCap', label: 'Energy per person', unit: 'W', log: true, group: 'Energy' },
  { key: 'swarmPower', label: 'Dyson swarm power', unit: 'W', log: true, group: 'Energy' },
  { key: 'swarms', label: 'Systems with a Dyson swarm', unit: '', group: 'Energy' },
  { key: 'heatLoad', label: 'Hottest world: waste heat vs limit', unit: '×', group: 'Energy' },
  { key: 'gdp', label: 'Gross product', unit: '$/yr', log: true, group: 'Economy' },
  { key: 'gdpPerCap', label: 'Product per person', unit: '$', log: true, group: 'Economy' },
  { key: 'tfp', label: 'Total factor productivity', unit: '×2040', log: true, group: 'Economy' },
  { key: 'capital', label: 'Capital stock', unit: '$', log: true, group: 'Economy' },
  { key: 'launchCap', label: 'Earth launch capacity', unit: 't/yr', log: true, group: 'Economy' },
  { key: 'gini', label: 'Inequality (Gini)', unit: '', group: 'Economy' },
  { key: 'water', label: 'Water stockpile', unit: 't', log: true, group: 'Resources' },
  { key: 'metals', label: 'Metal stockpile', unit: 't', log: true, group: 'Resources' },
  { key: 'volatiles', label: 'Volatiles stockpile', unit: 't', log: true, group: 'Resources' },
  { key: 'rare', label: 'Rare elements stockpile', unit: 't', log: true, group: 'Resources' },
  { key: 'he3', label: 'Helium-3 stockpile', unit: 't', log: true, group: 'Resources' },
  { key: 'shortage', label: 'People under shortage', unit: '%', group: 'Resources' },
  { key: 'knowledge', label: 'Knowledge (total)', unit: 'pts', log: true, group: 'Knowledge' },
  { key: 'research', label: 'Research rate', unit: 'pts/yr', log: true, group: 'Knowledge' },
  { key: 'techs', label: 'Technologies', unit: '', group: 'Knowledge' },
  { key: 'stability', label: 'Stability', unit: '', group: 'Society' },
  { key: 'happiness', label: 'Happiness', unit: '', group: 'Society' },
  { key: 'factions', label: 'Independent factions', unit: '', group: 'Society' },
  { key: 'wars', label: 'Wars (total)', unit: '', group: 'Society' },
  { key: 'military', label: 'Military spending', unit: '$/yr', log: true, group: 'Society' },
  { key: 'faiths', label: 'Faiths', unit: '', group: 'Society', internal: true },
  { key: 'era', label: 'Era', unit: '', group: 'Society' },
  // launch and mission economics (launchEconomics.ts): fully burdened cost, 2024 USD, booked when a mission or service departs
  { key: 'transportSpend', label: 'Transport spending', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'transportCum', label: 'Transport spending (total)', unit: '$', log: true, group: 'Transport' },
  { key: 'transportShare', label: 'Transport spending, share of product', unit: '%', group: 'Transport' },
  { key: 'propellantSpend', label: 'Propellant spending', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'hardwareSpend', label: 'Vehicle hardware spending', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'operationsSpend', label: 'Operations spending', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'riskSpend', label: 'Insurance and expected loss', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'infraSpend', label: 'Infrastructure amortisation', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'missionHwSpend', label: 'Mission-specific hardware', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'serviceSpend', label: 'Scheduled passenger services', unit: '$/yr', log: true, group: 'Transport' },
  { key: 'launches', label: 'Launches per year', unit: '/yr', log: true, group: 'Transport' },
  { key: 'tankerFlights', label: 'Tanker flights per year', unit: '/yr', log: true, group: 'Transport' },
  { key: 'campaigns', label: 'Campaigns per year', unit: '/yr', log: true, group: 'Transport' },
  { key: 'payloadDispatched', label: 'Payload dispatched', unit: 't/yr', log: true, group: 'Transport' },
  { key: 'peopleTransported', label: 'People transported', unit: '/yr', log: true, group: 'Transport' },
  { key: 'costPerKg', label: 'Average cost per kg dispatched', unit: '$/kg', log: true, group: 'Transport' },
  { key: 'leoCostPerKg', label: 'Earth to orbit, cost per kg', unit: '$/kg', log: true, group: 'Transport' },
  // living worlds (geo.ts): Earth's climate (means over the step that led here) and the worlds' upheavals
  { key: 'earthTemp', label: 'Earth temperature over pre-industrial', unit: 'K', group: 'Planet' },
  { key: 'seaLevel', label: 'Earth sea level against 2040', unit: 'm', group: 'Planet' },
  { key: 'aerosol', label: 'Earth volcanic and impact haze (optical depth)', unit: '', group: 'Planet' },
  { key: 'impacts', label: 'Notable impacts, all worlds (total)', unit: '', group: 'Planet' },
  { key: 'eruptions', label: 'Eruptions of VEI 7 or more, all worlds (total)', unit: '', group: 'Planet' },
  { key: 'stellarStorms', label: 'Miyake-class stellar storms (total)', unit: '', group: 'Planet' },
  { key: 'terraformed', label: 'Worlds terraformed past half', unit: '', group: 'Planet' },
];
export const GM = Object.fromEntries(GLOBAL_METRICS.map((m, i) => [m.key, i])) as Record<string, number>;
export const NGM = GLOBAL_METRICS.length;
/** The metrics the data channel offers: the series minus the engine-only ones. */
export const DATA_METRICS = GLOBAL_METRICS.filter((m) => !m.internal);

// Per-settlement fields (columns of the settlement state table).
export const SETTLEMENT_FIELDS = [
  'stage', 'pop', 'founded', 'parent', 'faction', 'energy', 'water', 'metals', 'volatiles', 'rare', 'he3',
  'food', 'capital', 'gdp', 'research', 'stability', 'happiness', 'gini', 'births', 'deaths', 'medianAge',
  'military', 'divergence', 'capacity', 'culture', 'imports', 'exports', 'energyRatio', 'shortage', 'robots',
  'lastEvent', 'terraform', 'inbound',
  'lifeExp', 'tfr', 'orbitalPower', 'heatLoad',
  'transport',
  // living worlds (geo.ts): the world's climate as its people feel it
  'tempAnom', 'seaLevel', 'aerosol', 'pressure', 'habEff',
] as const;
export type SField = typeof SETTLEMENT_FIELDS[number];
export const F = Object.fromEntries(SETTLEMENT_FIELDS.map((k, i) => [k, i])) as Record<SField, number>;
export const NF = SETTLEMENT_FIELDS.length;
/** The settlement fields the data channel offers: the state table minus 'culture' (faith is kept for the narrative, never exported). */
export const DATA_FIELDS = SETTLEMENT_FIELDS.filter((f) => f !== 'culture');
export const DATA_FIELD_IDX = DATA_FIELDS.map((f) => F[f]);

export const SETTLEMENT_LABELS: Partial<Record<SField, [string, string]>> = {
  pop: ['Population', 'people'], energy: ['Energy use', 'W'], gdp: ['Product', '$/yr'], capital: ['Capital', '$'],
  water: ['Water', 't'], metals: ['Metals', 't'], volatiles: ['Volatiles', 't'], rare: ['Rare elements', 't'],
  he3: ['Helium-3', 't'], food: ['Food security', ''], research: ['Research', 'pts/yr'], stability: ['Stability', ''],
  happiness: ['Happiness', ''], gini: ['Gini', ''], births: ['Births', '/yr'], deaths: ['Deaths', '/yr'],
  medianAge: ['Median age', 'yr'], military: ['Military', '$/yr'], divergence: ['Genetic divergence', ''],
  capacity: ['Habitat capacity', 'people'], imports: ['Imports', 't/yr'], exports: ['Exports', 't/yr'],
  lifeExp: ['Life expectancy at birth', 'yr'], tfr: ['Children per woman', ''],
  energyRatio: ['Energy supply ratio', '×'], orbitalPower: ['Power in orbit (habitats, swarm)', 'W'], transport: ['Transport spending it funds', '$/yr'], heatLoad: ['Surface waste heat, share of limit', '×'], shortage: ['Shortage', ''], robots: ['Robots', ''], terraform: ['Terraforming', ''],
  tempAnom: ['Temperature against normal', 'K'], seaLevel: ['Sea level against 2040', 'm'], aerosol: ['Volcanic and impact haze (optical depth)', ''],
  pressure: ['Surface pressure', 'bar'], habEff: ['Habitability now', ''],
};

// Settlement history columns logged every few steps (for per-settlement charts).
export const HIST_FIELDS: SField[] = ['pop', 'energy', 'gdp', 'stability', 'research', 'water', 'metals', 'happiness', 'tempAnom'];
