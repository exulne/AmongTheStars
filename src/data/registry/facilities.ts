// Public launch, landing, test and mission-control facilities. Only public
// information: names, owners, operators and tenants from official NASA, FAA,
// Space Force and company pages; coordinates are public pad or site centres
// (precision stated per record). A date is listed only when sourced: an unknown
// date stays null and the timeline shows the facility without it.

import type { Classification, Provenance } from '../provenance.ts';
import type { OrgId } from './orgs.ts';

export type FacilityType = 'launch-pad' | 'launch-site' | 'landing-zone' | 'landing-ship' | 'engine-test' | 'manufacturing' | 'mission-control' | 'spaceport';

export interface FacilityEvent { date: string; what: string; source: string }

export interface Facility {
  id: string;
  name: string;
  type: FacilityType;
  owner: OrgId | string;
  operator: OrgId | string;
  tenants: OrgId[];
  /** degrees; null for mobile assets (landing ships) */
  lat: number | null; lon: number | null;
  /** how precise the public coordinates are, degrees */
  coordPrecisionDeg: number | null;
  status: Classification;
  operational: 'operational' | 'under construction' | 'inactive' | 'mobile' | 'unknown';
  vehicles: string[];
  /** sourced dates only (first use, lease, expansion, retirement) */
  events: FacilityEvent[];
  provenance: Provenance;
}

const CURATED = '2026-10-25T00:00:00Z';
const faaDir = 'https://www.faa.gov/space/spaceports_by_state';
const p = (organization: string, url: string, note?: string, quality: Provenance['quality'] = 'medium'): Provenance => ({ organization, url, retrieved: CURATED, basis: 'reported', quality, note });

export const FACILITIES: Facility[] = [
  {
    id: 'ksc-39a', name: 'Kennedy Space Center Launch Complex 39A', type: 'launch-pad', owner: 'nasa', operator: 'spacex', tenants: ['spacex'],
    lat: 28.6083, lon: -80.6041, coordPrecisionDeg: 0.002, status: 'active', operational: 'operational',
    vehicles: ['Falcon 9', 'Falcon Heavy', 'Starship (approved by FAA, 2026)', 'Saturn V (historical)', 'Space Shuttle (historical)'],
    events: [
      { date: '1967-11-09', what: 'First launch (Apollo 4, Saturn V)', source: 'NASA' },
      { date: '2014-04-14', what: 'NASA signs a 20-year property agreement with SpaceX', source: 'NASA' },
      { date: '2017-02-19', what: 'First SpaceX launch from 39A (CRS-10)', source: 'NASA' },
      { date: '2026-01-30', what: 'FAA Record of Decision for Starship-Super Heavy at LC-39A', source: 'FAA' },
    ],
    provenance: p('NASA / FAA', 'https://www.faa.gov/space/stakeholder_engagement/spacex_starship_ksc', 'Pad centre from public maps; owner NASA, operator SpaceX under property agreement.'),
  },
  {
    id: 'ksc-39b', name: 'Kennedy Space Center Launch Complex 39B', type: 'launch-pad', owner: 'nasa', operator: 'nasa', tenants: ['nasa'],
    lat: 28.6272, lon: -80.6208, coordPrecisionDeg: 0.002, status: 'active', operational: 'operational',
    vehicles: ['Space Launch System', 'Space Shuttle (historical)', 'Saturn V (historical)'],
    events: [
      { date: '1969-05-18', what: 'First launch (Apollo 10)', source: 'NASA' },
      { date: '2022-11-16', what: 'First SLS launch (Artemis I)', source: 'NASA' },
      { date: '2026-04-01', what: 'First crewed SLS launch (Artemis II)', source: 'NASA' },
    ],
    provenance: p('NASA', 'https://www.nasa.gov/kennedy/', 'Pad centre from public maps.'),
  },
  {
    id: 'ccsfs-slc40', name: 'Cape Canaveral Space Force Station Space Launch Complex 40', type: 'launch-pad', owner: 'ussf', operator: 'spacex', tenants: ['spacex'],
    lat: 28.5622, lon: -80.5772, coordPrecisionDeg: 0.002, status: 'active', operational: 'operational',
    vehicles: ['Falcon 9'],
    events: [{ date: '2010-06-04', what: 'First Falcon 9 launch', source: 'SpaceX' }],
    provenance: p('US Space Force / SpaceX', faaDir, 'Space Force land leased to SpaceX.'),
  },
  {
    id: 'ccsfs-slc41', name: 'Cape Canaveral Space Force Station Space Launch Complex 41', type: 'launch-pad', owner: 'ussf', operator: 'ula', tenants: ['ula'],
    lat: 28.5833, lon: -80.5830, coordPrecisionDeg: 0.002, status: 'active', operational: 'operational',
    vehicles: ['Atlas V', 'Vulcan'],
    events: [],
    provenance: p('US Space Force / ULA', faaDir),
  },
  {
    id: 'ccsfs-lc36', name: 'Cape Canaveral Space Force Station Launch Complex 36', type: 'launch-pad', owner: 'ussf', operator: 'blueOrigin', tenants: ['blueOrigin'],
    lat: 28.4704, lon: -80.5376, coordPrecisionDeg: 0.005, status: 'active', operational: 'operational',
    vehicles: ['New Glenn'],
    events: [{ date: '2025-01-16', what: 'First New Glenn launch (NG-1)', source: 'Blue Origin' }],
    provenance: p('US Space Force / Blue Origin', 'https://www.blueorigin.com/new-glenn', 'Space Force land used by Blue Origin; lease date not stated here because no official source was checked.'),
  },
  {
    id: 'vsfb-slc4e', name: 'Vandenberg Space Force Base Space Launch Complex 4E', type: 'launch-pad', owner: 'ussf', operator: 'spacex', tenants: ['spacex'],
    lat: 34.6321, lon: -120.6106, coordPrecisionDeg: 0.002, status: 'active', operational: 'operational',
    vehicles: ['Falcon 9'],
    events: [{ date: '2013-09-29', what: 'First SpaceX launch from SLC-4E (CASSIOPE)', source: 'SpaceX' }],
    provenance: p('US Space Force / SpaceX', faaDir),
  },
  {
    id: 'starbase', name: 'SpaceX Starbase launch site, Boca Chica, Texas', type: 'launch-site', owner: 'spacex', operator: 'spacex', tenants: ['spacex'],
    lat: 25.9971, lon: -97.1554, coordPrecisionDeg: 0.005, status: 'active', operational: 'operational',
    vehicles: ['Starship / Super Heavy'],
    events: [
      { date: '2023-04-20', what: 'First Starship integrated flight test', source: 'SpaceX' },
      { date: '2024-10-13', what: 'First Super Heavy booster caught by the launch tower (Flight 5)', source: 'SpaceX' },
      { date: '2025-05-06', what: 'FAA tiered environmental assessment and Record of Decision (up to 25 launches/yr)', source: 'FAA' },
    ],
    provenance: p('FAA / SpaceX', 'https://www.faa.gov/space/stakeholder_engagement/spacex_starship'),
  },
  {
    id: 'bo-ls1', name: 'Blue Origin Launch Site One, West Texas', type: 'launch-site', owner: 'blueOrigin', operator: 'blueOrigin', tenants: ['blueOrigin'],
    lat: 31.4229, lon: -104.7571, coordPrecisionDeg: 0.01, status: 'active', operational: 'operational',
    vehicles: ['New Shepard'],
    events: [
      { date: '2015-04-29', what: 'First New Shepard flight', source: 'Blue Origin' },
      { date: '2021-07-20', what: 'First crewed New Shepard flight (NS-16)', source: 'Blue Origin' },
    ],
    provenance: p('Blue Origin / FAA', 'https://www.blueorigin.com/new-shepard', 'Site centre approximate (public FAA licence maps).', 'low'),
  },
  {
    id: 'ccsfs-lz1', name: 'Cape Canaveral Landing Zone 1 (former LC-13)', type: 'landing-zone', owner: 'ussf', operator: 'spacex', tenants: ['spacex'],
    lat: 28.4858, lon: -80.5442, coordPrecisionDeg: 0.005, status: 'historical', operational: 'unknown',
    vehicles: ['Falcon 9 first stage', 'Falcon Heavy side boosters'],
    events: [{ date: '2015-12-22', what: 'First orbital-class booster landing (ORBCOMM OG2-2)', source: 'SpaceX' }],
    provenance: p('SpaceX', 'https://www.spacex.com/vehicles/falcon-9/', 'Current operational status not checked against an official source, so it is shown as unknown.', 'low'),
  },
  {
    id: 'spacex-mcgregor', name: 'SpaceX Rocket Development and Test Facility, McGregor, Texas', type: 'engine-test', owner: 'spacex', operator: 'spacex', tenants: ['spacex'],
    lat: 31.40, lon: -97.46, coordPrecisionDeg: 0.05, status: 'active', operational: 'operational',
    vehicles: ['Merlin', 'Raptor', 'Draco (engine tests)'],
    events: [],
    provenance: p('SpaceX', 'https://www.spacex.com/', 'Town-level coordinates only.', 'low'),
  },
  {
    id: 'nasa-jsc-mcc', name: 'NASA Johnson Space Center, Christopher C. Kraft Jr. Mission Control Center', type: 'mission-control', owner: 'nasa', operator: 'nasa', tenants: ['nasa'],
    lat: 29.5593, lon: -95.0900, coordPrecisionDeg: 0.01, status: 'active', operational: 'operational',
    vehicles: ['ISS', 'Orion', 'Artemis'],
    events: [],
    provenance: p('NASA', 'https://www.nasa.gov/johnson/'),
  },
  {
    id: 'spacex-hawthorne', name: 'SpaceX Hawthorne headquarters and Dragon mission control', type: 'mission-control', owner: 'spacex', operator: 'spacex', tenants: ['spacex'],
    lat: 33.9207, lon: -118.3280, coordPrecisionDeg: 0.01, status: 'active', operational: 'operational',
    vehicles: ['Dragon', 'Starlink operations'],
    events: [],
    provenance: p('SpaceX', 'https://www.spacex.com/', 'Building-level coordinates.', 'low'),
  },
  {
    id: 'kourou-ela3', name: 'Guiana Space Centre ELA-3, Kourou', type: 'launch-pad', owner: 'CNES / ESA', operator: 'arianespace', tenants: ['arianespace'],
    lat: 5.2394, lon: -52.7686, coordPrecisionDeg: 0.005, status: 'historical', operational: 'inactive',
    vehicles: ['Ariane 5 (retired 2023)'],
    events: [{ date: '2021-12-25', what: 'Launch of JWST (Ariane 5 VA256)', source: 'NASA / ESA' }],
    provenance: p('ESA / CNES', 'https://www.esa.int/Enabling_Support/Space_Transportation/Europe_s_Spaceport'),
  },
  {
    id: 'jacklyn', name: 'Blue Origin landing ship Jacklyn', type: 'landing-ship', owner: 'blueOrigin', operator: 'blueOrigin', tenants: ['blueOrigin'],
    lat: null, lon: null, coordPrecisionDeg: null, status: 'active', operational: 'mobile',
    vehicles: ['New Glenn first stage'],
    events: [{ date: '2025-11-13', what: 'First New Glenn booster landing (NG-2)', source: 'Blue Origin' }],
    provenance: p('Blue Origin', 'https://www.blueorigin.com/new-glenn'),
  },
];
