// A normalised registry of SpaceX, Blue Origin and NASA missions, past,
// present and planned. Records are curated from primary sources (NASA NSSDCA,
// NASA Launch Services Program and mission pages, the SpaceX launch archive,
// Blue Origin's New Glenn and New Shepard pages); every flown orbital mission's
// designator and launch date are checked against the CelesTrak SATCAT snapshot
// by scripts/orbit-check.ts. Plans carry the class their evidence supports
// (scheduled, contracted, announced) and are never marked as flown.
// After the last sourced plan the simulation generates its own missions; those
// live in the engine's mission log and are always classed "simulated".

import type { Classification, Provenance, Quality } from '../provenance.ts';
import type { OrgId, OrgRole } from './orgs.ts';

export const CATEGORIES = [
  'human', 'cargo', 'science', 'tech-demo', 'earth-observation', 'constellation', 'lunar', 'planetary', 'national-security', 'suborbital',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  human: 'Human spaceflight', cargo: 'Cargo and station resupply', science: 'Science', 'tech-demo': 'Technology demonstration',
  'earth-observation': 'Earth observation', constellation: 'Communications constellation', lunar: 'Lunar', planetary: 'Mars and planetary',
  'national-security': 'National security', suborbital: 'Suborbital research',
};

export type Outcome = 'success' | 'partial' | 'failure' | 'pending' | 'unknown';

export interface Payload { name: string; owner: OrgId; cospar?: string; massKg?: number; massSource?: string }

export interface Recovery { site: string; kind: 'droneship' | 'landing-zone' | 'tower-catch' | 'ship' | 'ocean' | 'expended' | 'none'; outcome: 'success' | 'failure' | 'not attempted' | 'unknown'; booster?: string; boosterFlight?: number }

/** An officially reported contract value. Never a provider's internal cost, never a "price" invented here. */
export interface ContractValue { usd: number; year: number; scope: string; source: Provenance }

export interface Mission {
  id: string;
  name: string;
  /** launch designator (YYYY-NNN) and primary object (YYYY-NNNA) when catalogued */
  cospar?: string;
  /** the provider's own launch or flight name */
  launchId?: string;
  orgs: OrgRole[];
  launchProvider: OrgId | null;
  vehicle: string;
  variant?: string;
  payloads: Payload[];
  customers: OrgId[];
  categories: Category[];
  launchSite: string | null; // facility id (facilities.ts)
  recovery?: Recovery;
  /** planned window, UTC (plans); for flown missions the actual launch time */
  window?: { start: string; end?: string; note?: string };
  launched?: string;
  target: string;
  outcome: Outcome;
  status: Classification;
  confidence: Quality;
  sources: Provenance[];
  contract?: ContractValue;
  note?: string;
}

const CURATED = '2026-10-25T00:00:00Z';
const nssdca = (id: string): Provenance => ({ organization: 'NASA NSSDCA Master Catalog', url: `https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=${id}`, retrieved: CURATED, basis: 'reported', quality: 'high' });
const satcat = (intdes: string): Provenance => ({ organization: 'CelesTrak SATCAT (18th/19th Space Defense Squadron data)', url: `https://celestrak.org/satcat/records.php?INTDES=${intdes}`, retrieved: CURATED, basis: 'observed', quality: 'high', note: 'Designator, launch date and decay date checked against the snapshot.' });
const page = (organization: string, url: string, quality: Quality = 'high', note?: string): Provenance => ({ organization, url, retrieved: CURATED, basis: 'reported', quality, note });
const SPACEX_ARCHIVE = page('SpaceX launch archive', 'https://www.spacex.com/launches/');
const NEW_GLENN = page('Blue Origin, New Glenn', 'https://www.blueorigin.com/new-glenn');
const NEW_SHEPARD = page('Blue Origin, New Shepard', 'https://www.blueorigin.com/new-shepard');
const LSP = page('NASA Launch Services Program', 'https://www.nasa.gov/kennedy/launch-services-program/');

export const MISSIONS: Mission[] = [
  {
    id: 'apollo-11', name: 'Apollo 11', cospar: '1969-059A', orgs: [{ org: 'nasa', roles: ['program-owner', 'mission-operator', 'launch-provider'] }],
    launchProvider: 'nasa', vehicle: 'Saturn V', variant: 'SA-506', payloads: [{ name: 'Apollo 11 CSM Columbia and LM Eagle', owner: 'nasa', cospar: '1969-059A' }], customers: [],
    categories: ['human', 'lunar'], launchSite: 'ksc-39a', launched: '1969-07-16T13:32:00Z', target: 'Lunar surface (Mare Tranquillitatis) and return',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('1969-059A'), satcat('1969-059')],
  },
  {
    id: 'sts-31-hst', name: 'STS-31: Hubble Space Telescope', cospar: '1990-037B', orgs: [{ org: 'nasa', roles: ['program-owner', 'launch-provider', 'spacecraft-operator'] }, { org: 'esa', roles: ['partner'] }],
    launchProvider: 'nasa', vehicle: 'Space Shuttle', variant: 'Discovery (OV-103)', payloads: [{ name: 'Hubble Space Telescope', owner: 'nasa', cospar: '1990-037B' }], customers: [],
    categories: ['science'], launchSite: 'ksc-39b', launched: '1990-04-24T12:33:51Z', target: 'LEO ≈ 600 km, 28.5°',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('1990-037B'), satcat('1990-037')],
    note: 'Still operating; its current orbit is in the GP snapshot (HST).',
  },
  {
    id: 'iss-zarya', name: 'ISS: Zarya (first module)', cospar: '1998-067A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'partner'] }, { org: 'roscosmos', roles: ['launch-provider', 'partner'] }],
    launchProvider: 'roscosmos', vehicle: 'Proton-K', payloads: [{ name: 'Zarya FGB', owner: 'nasa', cospar: '1998-067A' }], customers: ['nasa'],
    categories: ['human', 'science'], launchSite: null, launched: '1998-11-20T06:40:00Z', target: 'LEO, 51.6°',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('1998-067A'), satcat('1998-067')],
    note: 'Zarya was US-funded and Russian-built, launched from Baikonur. The ISS is a partnership of NASA, Roscosmos, ESA, JAXA and CSA.',
  },
  {
    id: 'cots-2', name: 'COTS Demo Flight 2 (Dragon C2+)', cospar: '2012-027A', launchId: 'COTS Demo 2', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'spacecraft-operator'] }, { org: 'nasa', roles: ['customer', 'program-owner'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'v1.0', payloads: [{ name: 'Dragon C2+', owner: 'spacex', cospar: '2012-027A' }], customers: ['nasa'],
    categories: ['cargo', 'tech-demo'], launchSite: 'ccsfs-slc40', launched: '2012-05-22T07:44:38Z', target: 'ISS berthing',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('2012-027A'), satcat('2012-027'), SPACEX_ARCHIVE],
  },
  {
    id: 'fh-demo', name: 'Falcon Heavy test flight', cospar: '2018-017A', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer'] }, { org: 'tesla', roles: ['payload-owner'] }],
    launchProvider: 'spacex', vehicle: 'Falcon Heavy', payloads: [{ name: 'Tesla Roadster (dummy payload)', owner: 'tesla', cospar: '2018-017A' }], customers: [],
    categories: ['tech-demo'], launchSite: 'ksc-39a', launched: '2018-02-06T20:45:00Z', target: 'Heliocentric orbit crossing Mars',
    recovery: { site: 'LZ-1 and LZ-2 (side boosters); droneship (core)', kind: 'landing-zone', outcome: 'success', booster: 'side boosters landed; core lost' },
    outcome: 'success', status: 'historical', confidence: 'high', sources: [satcat('2018-017'), SPACEX_ARCHIVE],
  },
  {
    id: 'tess', name: 'TESS', cospar: '2018-038A', orgs: [{ org: 'nasa', roles: ['program-owner', 'science-agency', 'payload-owner', 'launch-services-manager'] }, { org: 'mit', roles: ['partner'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 4', payloads: [{ name: 'Transiting Exoplanet Survey Satellite', owner: 'nasa', cospar: '2018-038A' }], customers: ['nasa'],
    categories: ['science'], launchSite: 'ccsfs-slc40', launched: '2018-04-18T22:51:31Z', target: 'High Earth orbit in 2:1 lunar resonance',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2018-038A'), satcat('2018-038'), LSP],
    contract: { usd: 87e6, year: 2014, scope: 'NASA total launch cost: launch service, spacecraft processing, payload integration, tracking, data and telemetry, other launch support', source: page('NASA news release', 'https://www.nasa.gov/news-release/nasa-awards-launch-services-contract-for-transiting-exoplanet-survey-satellite-2') },
  },
  {
    id: 'mars-2020', name: 'Mars 2020 (Perseverance and Ingenuity)', cospar: '2020-052A', orgs: [{ org: 'nasa', roles: ['program-owner', 'science-agency', 'payload-owner', 'mission-operator', 'launch-services-manager'] }, { org: 'ula', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'ula', vehicle: 'Atlas V', variant: '541', payloads: [{ name: 'Perseverance rover, Ingenuity helicopter', owner: 'nasa', cospar: '2020-052A' }], customers: ['nasa'],
    categories: ['planetary', 'science'], launchSite: 'ccsfs-slc41', launched: '2020-07-30T11:50:00Z', target: 'Mars, Jezero crater (landed 2021-02-18)',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2020-052A'), satcat('2020-052'), LSP],
    note: 'A NASA mission on a ULA rocket: neither SpaceX nor Blue Origin is involved.',
  },
  {
    id: 'demo-2', name: 'Crew Dragon Demo-2', cospar: '2020-033A', launchId: 'Demo-2', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'spacecraft-operator'] }, { org: 'nasa', roles: ['customer', 'program-owner'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'Crew Dragon Endeavour (NASA astronauts Behnken and Hurley)', owner: 'spacex', cospar: '2020-033A' }], customers: ['nasa'],
    categories: ['human'], launchSite: 'ksc-39a', launched: '2020-05-30T19:22:45Z', target: 'ISS',
    recovery: { site: 'Of Course I Still Love You (droneship)', kind: 'droneship', outcome: 'success', booster: 'B1058', boosterFlight: 1 },
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('2020-033A'), satcat('2020-033'), SPACEX_ARCHIVE],
    note: 'NASA buys the crew transport service (Commercial Crew); SpaceX owns and operates the Dragon.',
  },
  {
    id: 'crew-1', name: 'NASA SpaceX Crew-1', cospar: '2020-084A', launchId: 'Crew-1', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'spacecraft-operator'] }, { org: 'nasa', roles: ['customer', 'program-owner'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'Crew Dragon Resilience', owner: 'spacex', cospar: '2020-084A' }], customers: ['nasa'],
    categories: ['human'], launchSite: 'ksc-39a', launched: '2020-11-16T00:27:17Z', target: 'ISS',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('2020-084A'), satcat('2020-084'), SPACEX_ARCHIVE],
  },
  {
    id: 'ns-16', name: 'New Shepard NS-16 (first crewed flight)', launchId: 'NS-16', orgs: [{ org: 'blueOrigin', roles: ['launch-provider', 'manufacturer', 'mission-operator'] }],
    launchProvider: 'blueOrigin', vehicle: 'New Shepard', payloads: [{ name: 'RSS First Step crew capsule (4 people)', owner: 'blueOrigin' }], customers: [],
    categories: ['suborbital', 'human'], launchSite: 'bo-ls1', launched: '2021-07-20T13:12:00Z', target: 'Suborbital, apogee ≈ 107 km',
    recovery: { site: 'Launch Site One booster pad', kind: 'landing-zone', outcome: 'success' },
    outcome: 'success', status: 'historical', confidence: 'high', sources: [NEW_SHEPARD], note: 'Suborbital: no COSPAR designator.',
  },
  {
    id: 'dart', name: 'DART (Double Asteroid Redirection Test)', cospar: '2021-110A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'jhuapl', roles: ['manufacturer', 'mission-operator'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'DART', owner: 'nasa', cospar: '2021-110A' }], customers: ['nasa'],
    categories: ['tech-demo', 'planetary'], launchSite: 'vsfb-slc4e', launched: '2021-11-24T06:21:02Z', target: 'Dimorphos (impact 2022-09-26)',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('2021-110A'), satcat('2021-110'), LSP],
    note: 'No contract value is shown: none was checked against an official NASA source in this snapshot.',
  },
  {
    id: 'jwst', name: 'James Webb Space Telescope', cospar: '2021-130A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'mission-operator'] }, { org: 'esa', roles: ['partner', 'customer'] }, { org: 'csa', roles: ['partner'] }, { org: 'arianespace', roles: ['launch-provider'] }],
    launchProvider: 'arianespace', vehicle: 'Ariane 5', variant: 'ECA (VA256)', payloads: [{ name: 'JWST', owner: 'nasa', cospar: '2021-130A' }], customers: ['esa'],
    categories: ['science'], launchSite: 'kourou-ela3', launched: '2021-12-25T12:20:00Z', target: 'Sun–Earth L2 halo orbit',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2021-130A'), satcat('2021-130')],
    note: "ESA provided the launch as part of its contribution; NASA leads the mission.",
  },
  {
    id: 'starlink-4-7', name: 'Starlink Group 4-7', cospar: '2022-010', launchId: 'Starlink 4-7', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'payload-owner', 'spacecraft-operator'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: '49 Starlink v1.5 satellites', owner: 'spacex', cospar: '2022-010' }], customers: [],
    categories: ['constellation'], launchSite: 'ksc-39a', launched: '2022-02-03T18:13:00Z', target: 'Low insertion orbit (perigee ≈ 210 km) before raising',
    outcome: 'partial', status: 'historical', confidence: 'high', sources: [satcat('2022-010'), page('Fang et al. 2022, Space Weather 20, e2022SW003193', 'https://doi.org/10.1029/2022SW003193', 'high', '38 of 49 satellites lost to enhanced neutral density during a minor-to-moderate geomagnetic storm (50–125% density enhancement at 200–400 km in WAM-IPE).')],
    note: 'Validation case for the drag model: see the Starlink 2022 card in Orbits.',
  },
  {
    id: 'artemis-1', name: 'Artemis I', cospar: '2022-156A', orgs: [{ org: 'nasa', roles: ['program-owner', 'launch-provider', 'mission-operator'] }, { org: 'esa', roles: ['partner'] }],
    launchProvider: 'nasa', vehicle: 'Space Launch System', variant: 'Block 1', payloads: [{ name: 'Orion (uncrewed)', owner: 'nasa', cospar: '2022-156A' }], customers: [],
    categories: ['lunar', 'tech-demo'], launchSite: 'ksc-39b', launched: '2022-11-16T06:47:44Z', target: 'Distant retrograde lunar orbit and return',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [nssdca('2022-156A'), satcat('2022-156')],
  },
  {
    id: 'swot', name: 'SWOT', cospar: '2022-173A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'cnes', roles: ['partner'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'Surface Water and Ocean Topography', owner: 'nasa', cospar: '2022-173A' }], customers: ['nasa'],
    categories: ['earth-observation', 'science'], launchSite: 'vsfb-slc4e', launched: '2022-12-16T11:46:00Z', target: 'LEO ≈ 890 km, 77.6°',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2022-173A'), satcat('2022-173'), LSP],
  },
  {
    id: 'ift-1', name: 'Starship Integrated Flight Test 1', launchId: 'IFT-1', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'mission-operator'] }],
    launchProvider: 'spacex', vehicle: 'Starship / Super Heavy', payloads: [], customers: [],
    categories: ['tech-demo', 'suborbital'], launchSite: 'starbase', launched: '2023-04-20T13:33:00Z', target: 'Planned near-orbital trajectory to a splashdown near Hawaii',
    recovery: { site: 'none', kind: 'expended', outcome: 'not attempted' },
    outcome: 'failure', status: 'historical', confidence: 'high', sources: [SPACEX_ARCHIVE, page('FAA mishap investigation', 'https://www.faa.gov/space/stakeholder_engagement/spacex_starship')],
    note: 'The vehicle was terminated about 4 minutes after liftoff. No COSPAR designator (did not reach orbit).',
  },
  {
    id: 'kuiper-protoflight', name: 'Project Kuiper Protoflight', cospar: '2023-154', orgs: [{ org: 'amazon', roles: ['payload-owner', 'spacecraft-operator', 'manufacturer'] }, { org: 'ula', roles: ['launch-provider'] }],
    launchProvider: 'ula', vehicle: 'Atlas V', variant: '501', payloads: [{ name: 'KUIPER-P1, KUIPER-P2', owner: 'amazon', cospar: '2023-154' }], customers: ['amazon'],
    categories: ['constellation', 'tech-demo'], launchSite: 'ccsfs-slc41', launched: '2023-10-06T18:06:00Z', target: 'LEO ≈ 500 km',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [satcat('2023-154')], note: 'Both prototypes were deorbited (SATCAT decay dates 2024-09-29 and 2025-04-29).',
  },
  {
    id: 'psyche', name: 'Psyche', cospar: '2023-157A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon Heavy', payloads: [{ name: 'Psyche', owner: 'nasa', cospar: '2023-157A' }], customers: ['nasa'],
    categories: ['planetary', 'science'], launchSite: 'ksc-39a', launched: '2023-10-13T14:19:43Z', target: 'Asteroid (16) Psyche, arrival 2029',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2023-157A'), satcat('2023-157'), LSP],
    contract: { usd: 117e6, year: 2020, scope: 'NASA total cost to launch Psyche and its secondary payloads: launch service and other mission-related costs', source: page('NASA news release', 'https://www.nasa.gov/news-release/nasa-awards-launch-services-contract-for-the-psyche-mission') },
  },
  {
    id: 'pace', name: 'PACE', cospar: '2024-025A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'Plankton, Aerosol, Cloud, ocean Ecosystem', owner: 'nasa', cospar: '2024-025A' }], customers: ['nasa'],
    categories: ['earth-observation', 'science'], launchSite: 'ccsfs-slc40', launched: '2024-02-08T06:33:00Z', target: 'Sun-synchronous LEO ≈ 677 km',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2024-025A'), satcat('2024-025'), LSP],
  },
  {
    id: 'ift-5', name: 'Starship Flight 5', launchId: 'Flight 5', orgs: [{ org: 'spacex', roles: ['launch-provider', 'manufacturer', 'mission-operator'] }],
    launchProvider: 'spacex', vehicle: 'Starship / Super Heavy', payloads: [], customers: [],
    categories: ['tech-demo', 'suborbital'], launchSite: 'starbase', launched: '2024-10-13T12:25:00Z', target: 'Suborbital; ship splashdown in the Indian Ocean',
    recovery: { site: 'Starbase launch tower', kind: 'tower-catch', outcome: 'success', booster: 'B12', boosterFlight: 1 },
    outcome: 'success', status: 'historical', confidence: 'high', sources: [SPACEX_ARCHIVE], note: 'First booster caught by the tower arms. Suborbital: no COSPAR designator.',
  },
  {
    id: 'europa-clipper', name: 'Europa Clipper', cospar: '2024-182A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager', 'mission-operator'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon Heavy', payloads: [{ name: 'Europa Clipper', owner: 'nasa', cospar: '2024-182A' }], customers: ['nasa'],
    categories: ['planetary', 'science'], launchSite: 'ksc-39a', launched: '2024-10-14T16:06:00Z', target: 'Jupiter system (arrival 2030), Europa flybys',
    outcome: 'success', status: 'active', confidence: 'high', sources: [nssdca('2024-182A'), satcat('2024-182'), LSP],
    contract: { usd: 178e6, year: 2021, scope: 'NASA total contract award for launch services (approximate)', source: page('NASA news release, 2021-07-23', 'https://www.nasa.gov/?p=52410', 'medium', 'Permalink to the NASA release; the figure is also reported by SpaceNews.') },
  },
  {
    id: 'ng-1', name: 'New Glenn NG-1', cospar: '2025-011A', launchId: 'NG-1', orgs: [{ org: 'blueOrigin', roles: ['launch-provider', 'manufacturer', 'payload-owner'] }],
    launchProvider: 'blueOrigin', vehicle: 'New Glenn', payloads: [{ name: 'Blue Ring Pathfinder', owner: 'blueOrigin', cospar: '2025-011A' }], customers: [],
    categories: ['tech-demo'], launchSite: 'ccsfs-lc36', launched: '2025-01-16T07:03:00Z', target: 'Medium Earth orbit',
    recovery: { site: 'Jacklyn (landing ship)', kind: 'ship', outcome: 'failure' },
    outcome: 'success', status: 'historical', confidence: 'high', sources: [satcat('2025-011'), NEW_GLENN], note: 'Reached orbit on the first flight; the booster was lost during descent.',
  },
  {
    id: 'kuiper-ka01', name: 'Amazon Kuiper KA-01', cospar: '2025-088', orgs: [{ org: 'amazon', roles: ['payload-owner', 'spacecraft-operator', 'manufacturer'] }, { org: 'ula', roles: ['launch-provider'] }],
    launchProvider: 'ula', vehicle: 'Atlas V', variant: '551', payloads: [{ name: '27 Kuiper production satellites', owner: 'amazon', cospar: '2025-088' }], customers: ['amazon'],
    categories: ['constellation'], launchSite: 'ccsfs-slc41', launched: '2025-04-28T23:01:00Z', target: 'LEO ≈ 450 km insertion, raising to ≈ 630 km',
    outcome: 'success', status: 'active', confidence: 'medium', sources: [satcat('2025-088')], note: 'Amazon Leo is an Amazon constellation, not a Blue Origin one.',
  },
  {
    id: 'kuiper-kf01', name: 'Amazon Kuiper KF-01', cospar: '2025-151', orgs: [{ org: 'amazon', roles: ['payload-owner', 'spacecraft-operator', 'manufacturer'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: '24 Kuiper satellites', owner: 'amazon', cospar: '2025-151' }], customers: ['amazon'],
    categories: ['constellation'], launchSite: 'ccsfs-slc40', launched: '2025-07-16T06:30:00Z', target: 'LEO insertion ≈ 465 km',
    outcome: 'success', status: 'active', confidence: 'medium', sources: [satcat('2025-151'), SPACEX_ARCHIVE], note: 'A competitor’s satellites on a SpaceX rocket: the launch provider is not the owner.',
  },
  {
    id: 'imap', name: 'IMAP (with Carruthers and NOAA SWFO-L1)', cospar: '2025-215A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'noaa', roles: ['payload-owner', 'partner'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon 9', variant: 'Block 5', payloads: [{ name: 'IMAP', owner: 'nasa', cospar: '2025-215A' }, { name: 'SWFO-L1', owner: 'noaa' }, { name: 'Carruthers Geocorona Observatory', owner: 'nasa' }], customers: ['nasa', 'noaa'],
    categories: ['science'], launchSite: 'ksc-39a', launched: '2025-09-24T11:30:00Z', target: 'Sun–Earth L1',
    outcome: 'success', status: 'active', confidence: 'high', sources: [satcat('2025-215'), LSP],
  },
  {
    id: 'ng-2', name: 'New Glenn NG-2: ESCAPADE', cospar: '2025-260', launchId: 'NG-2', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'ucb', roles: ['mission-operator', 'partner'] }, { org: 'rocketLab', roles: ['manufacturer'] }, { org: 'blueOrigin', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'blueOrigin', vehicle: 'New Glenn', payloads: [{ name: 'ESCAPADE Blue and Gold', owner: 'nasa', cospar: '2025-260' }], customers: ['nasa'],
    categories: ['planetary', 'science'], launchSite: 'ccsfs-lc36', launched: '2025-11-13T20:55:00Z', target: 'Sun–Earth L2 loiter, then Mars (two orbiters)',
    recovery: { site: 'Jacklyn (landing ship)', kind: 'ship', outcome: 'success' },
    outcome: 'success', status: 'active', confidence: 'high', sources: [satcat('2025-260'), NEW_GLENN, LSP],
  },
  {
    id: 'artemis-2', name: 'Artemis II', cospar: '2026-069A', orgs: [{ org: 'nasa', roles: ['program-owner', 'launch-provider', 'mission-operator'] }, { org: 'csa', roles: ['partner'] }, { org: 'esa', roles: ['partner'] }],
    launchProvider: 'nasa', vehicle: 'Space Launch System', variant: 'Block 1', payloads: [{ name: 'Orion Integrity (Wiseman, Glover, Koch, Hansen)', owner: 'nasa', cospar: '2026-069A' }], customers: [],
    categories: ['human', 'lunar'], launchSite: 'ksc-39b', launched: '2026-04-01T22:35:00Z', target: 'Crewed lunar flyby and return (splashdown 2026-04-10)',
    outcome: 'success', status: 'historical', confidence: 'high', sources: [satcat('2026-069'), page('NASA, Artemis II', 'https://www.nasa.gov/mission/artemis-ii/')],
  },
  {
    id: 'ng-3', name: 'New Glenn NG-3: BlueBird 7', launchId: 'NG-3', orgs: [{ org: 'ast', roles: ['payload-owner', 'spacecraft-operator', 'customer'] }, { org: 'blueOrigin', roles: ['launch-provider'] }],
    launchProvider: 'blueOrigin', vehicle: 'New Glenn', payloads: [{ name: 'BlueBird 7', owner: 'ast' }], customers: ['ast'],
    categories: ['constellation'], launchSite: 'ccsfs-lc36', launched: '2026-04-19T00:00:00Z', target: 'LEO ≈ 460 km (planned)',
    recovery: { site: 'Jacklyn (landing ship)', kind: 'ship', outcome: 'success', boosterFlight: 2 },
    outcome: 'failure', status: 'historical', confidence: 'medium',
    sources: [NEW_GLENN, page('Blue Origin and AST SpaceMobile statements as reported (Spectrum News 13, SatNews, Aviation Week)', 'https://satnews.com/2026/04/23/blue-origin-ceo-attributes-bluebird-7-satellite-loss-to-second-stage-thrust-anomaly/', 'medium', 'One BE-3U engine under-performed in the second upper-stage burn; the satellite was left in a low orbit (≈150 km instead of ≈460 km), declared lost and deorbited on 2026-04-20.')],
    note: 'First reflight of a New Glenn booster. Launch time of day not checked (date only). The payload is not in the SATCAT snapshot.',
  },
  {
    id: 'roman', name: 'Nancy Grace Roman Space Telescope', cospar: '2026-199A', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager', 'mission-operator'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon Heavy', payloads: [{ name: 'Roman (NGRST)', owner: 'nasa', cospar: '2026-199A' }], customers: ['nasa'],
    categories: ['science'], launchSite: 'ksc-39a', launched: '2026-08-30T11:26:00Z', target: 'Sun–Earth L2',
    outcome: 'success', status: 'active', confidence: 'high', sources: [satcat('2026-199'), page('NASA Science, Roman', 'https://science.nasa.gov/mission/roman-space-telescope/')],
  },
  // ---------------------------------------------------------------- plans (never shown as flown)
  {
    id: 'artemis-3', name: 'Artemis III (Earth-orbit rendezvous and docking test)', orgs: [{ org: 'nasa', roles: ['program-owner', 'launch-provider', 'mission-operator'] }, { org: 'spacex', roles: ['contractor'] }, { org: 'blueOrigin', roles: ['contractor'] }],
    launchProvider: 'nasa', vehicle: 'Space Launch System', payloads: [{ name: 'Orion', owner: 'nasa' }], customers: [],
    categories: ['human', 'tech-demo'], launchSite: 'ksc-39b', window: { start: '2027-07-01', end: '2027-12-31', note: 'NASA target "late 2027" (Administrator testimony, spring 2026). Redefined in 2026 as an Earth-orbit test with the SpaceX and Blue Origin landers.' },
    target: 'Earth orbit: docking tests with Starship HLS and Blue Moon', outcome: 'pending', status: 'scheduled', confidence: 'low',
    sources: [page('SpacePolicyOnline / The Register reporting NASA statements', 'https://spacepolicyonline.com/?p=88965', 'medium')],
  },
  {
    id: 'artemis-4', name: 'Artemis IV (first crewed landing of the programme)', orgs: [{ org: 'nasa', roles: ['program-owner', 'mission-operator'] }, { org: 'spacex', roles: ['contractor'] }, { org: 'blueOrigin', roles: ['contractor'] }],
    launchProvider: 'nasa', vehicle: 'Space Launch System', payloads: [{ name: 'Orion; Human Landing System', owner: 'nasa' }], customers: [],
    categories: ['human', 'lunar'], launchSite: 'ksc-39b', window: { start: '2028-01-01', end: '2028-12-31', note: 'NASA-stated target year only.' },
    target: 'Lunar south polar region', outcome: 'pending', status: 'announced', confidence: 'low',
    sources: [page('NASA statements as reported by SpacePolicyOnline', 'https://spacepolicyonline.com/?p=88965', 'medium')],
  },
  {
    id: 'dragonfly', name: 'Dragonfly', orgs: [{ org: 'nasa', roles: ['program-owner', 'payload-owner', 'launch-services-manager'] }, { org: 'jhuapl', roles: ['manufacturer', 'mission-operator'] }, { org: 'spacex', roles: ['launch-provider', 'contractor'] }],
    launchProvider: 'spacex', vehicle: 'Falcon Heavy', payloads: [{ name: 'Dragonfly rotorcraft lander', owner: 'nasa' }], customers: ['nasa'],
    categories: ['planetary', 'science'], launchSite: 'ksc-39a', window: { start: '2028-07-05', end: '2028-07-25', note: 'Launch period in the NASA contract announcement.' },
    target: 'Titan (arrival 2034)', outcome: 'pending', status: 'contracted', confidence: 'medium',
    sources: [page('NASA news release, 2024-11-25', 'https://www.nasa.gov/news-release/nasa-awards-launch-services-contract-for-dragonfly-mission/')],
    contract: { usd: 256.6e6, year: 2024, scope: 'Firm-fixed-price launch services contract, launch service and other mission-related costs (approximate)', source: page('NASA news release, 2024-11-25', 'https://www.nasa.gov/news-release/nasa-awards-launch-services-contract-for-dragonfly-mission/') },
  },
  {
    id: 'blue-moon-mk1', name: 'Blue Moon MK1 Pathfinder (MK1-SN001)', orgs: [{ org: 'blueOrigin', roles: ['manufacturer', 'mission-operator', 'launch-provider'] }],
    launchProvider: 'blueOrigin', vehicle: 'New Glenn', payloads: [{ name: 'Blue Moon MK1 lander', owner: 'blueOrigin' }], customers: [],
    categories: ['lunar', 'tech-demo'], launchSite: 'ccsfs-lc36', window: { start: '2026-06-01', end: '2027-06-30', note: 'Reported as slipping to "mid-to-late 2026"; New Glenn was grounded after NG-3 pending the mishap investigation. No firm date found.' },
    target: 'Lunar surface (precision landing demonstration)', outcome: 'pending', status: 'announced', confidence: 'low',
    sources: [page('Blue Origin, Blue Moon MK1', 'https://www.blueorigin.com/blue-moon/mark-1')],
  },
];

// ---------------------------------------------------------------- constellations: licensed plans vs observed

export interface ConstellationPlan {
  id: string; name: string; owner: OrgId; status: Classification;
  shells: { altKm: number; incDeg: number; count: number }[];
  authorizedTotal: number; source: Provenance; note?: string;
}

export const CONSTELLATION_PLANS: ConstellationPlan[] = [
  {
    id: 'amazon-leo-fcc-2020', name: 'Amazon Leo (Project Kuiper) FCC authorisation', owner: 'amazon', status: 'contracted',
    shells: [{ altKm: 590, incDeg: 33, count: 784 }, { altKm: 610, incDeg: 42, count: 1296 }, { altKm: 630, incDeg: 51.9, count: 1156 }],
    authorizedTotal: 3236, source: page('FCC Order FCC-20-102 (July 2020)', 'https://docs.fcc.gov/public/attachments/FCC-20-102A1.pdf', 'high'),
    note: 'A licence, not a deployment: the observed Amazon satellites are in the GP snapshot.',
  },
  {
    id: 'starlink-gen2-fcc-2022', name: 'Starlink Gen2 FCC partial grant', owner: 'spacex', status: 'contracted',
    shells: [{ altKm: 525, incDeg: 53, count: 2500 }, { altKm: 530, incDeg: 43, count: 2500 }, { altKm: 535, incDeg: 33, count: 2500 }],
    authorizedTotal: 7500, source: page('FCC Order FCC-22-91 (December 2022)', 'https://docs.fcc.gov/public/attachments/FCC-22-91A1.pdf', 'high'),
    note: 'The 2022 grant covered 7,500 satellites in these three shells; later modifications are not represented here.',
  },
];

// ---------------------------------------------------------------- merging

/** The keys two records of one mission share, strongest first: launch designator, provider launch id, payload designators, then vehicle + launch day. */
export function missionKeys(m: Pick<Mission, 'cospar' | 'launchId' | 'launchProvider' | 'vehicle' | 'launched' | 'payloads'>): string[] {
  const k: string[] = [];
  if (m.cospar) k.push(`cospar:${m.cospar.slice(0, 8)}`);
  if (m.launchId && m.launchProvider) k.push(`launch:${m.launchProvider}:${m.launchId.toLowerCase().replace(/\s+/g, '')}`);
  for (const p of m.payloads) if (p.cospar) k.push(`cospar:${p.cospar.slice(0, 8)}`);
  if (m.launched) k.push(`day:${m.vehicle.toLowerCase()}:${m.launched.slice(0, 10)}`);
  return k;
}

const QUAL: Record<Quality, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

/**
 * Merge records from several sources into one per mission. Two records are the
 * same mission when they share any key (never by name alone). The merged
 * record keeps the higher-confidence record's fields, fills its gaps from the
 * other, and keeps every source.
 */
export function mergeMissions(records: Mission[]): Mission[] {
  const out: Mission[] = [];
  const index = new Map<string, number>();
  for (const r of records) {
    const keys = missionKeys(r);
    const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
    if (hit === undefined) {
      out.push({ ...r, sources: [...r.sources], payloads: [...r.payloads] });
      for (const k of keys) index.set(k, out.length - 1);
      continue;
    }
    const a = out[hit], [hi, lo] = QUAL[r.confidence] > QUAL[a.confidence] ? [r, a] : [a, r];
    const merged: Mission = { ...lo, ...stripUndefined(hi), sources: dedupeSources([...a.sources, ...r.sources]), payloads: hi.payloads.length ? hi.payloads : lo.payloads };
    out[hit] = merged;
    for (const k of missionKeys(merged)) index.set(k, hit);
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
function dedupeSources(s: Provenance[]): Provenance[] {
  const seen = new Set<string>();
  return s.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

/** A plan can never be displayed as flown: only historical/active records may carry a launch time or a final outcome. */
export function isFlown(m: Mission): boolean {
  return (m.status === 'historical' || m.status === 'active') && !!m.launched;
}

/** Organisations holding a role on a mission. */
export function withRole(m: Mission, role: OrgRole['roles'][number]): OrgId[] {
  return m.orgs.filter((o) => o.roles.includes(role)).map((o) => o.org);
}
