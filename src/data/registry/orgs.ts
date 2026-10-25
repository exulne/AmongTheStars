// Organisations and the roles they play. NASA, SpaceX and Blue Origin are not
// interchangeable: NASA can own a programme, fund a science mission, buy a
// launch or manage a launch service; SpaceX and Blue Origin build vehicles,
// sell launches and operate facilities and spacecraft. A payload flown on a
// Falcon 9 belongs to whoever owns the payload, not to SpaceX.

export const ORGS = {
  nasa: { name: 'NASA', kind: 'space agency (US)', url: 'https://www.nasa.gov/' },
  spacex: { name: 'SpaceX', kind: 'company: launch provider, manufacturer, spacecraft and constellation operator', url: 'https://www.spacex.com/' },
  blueOrigin: { name: 'Blue Origin', kind: 'company: launch provider, manufacturer, lander developer', url: 'https://www.blueorigin.com/' },
  amazon: { name: 'Amazon (Amazon Leo, formerly Project Kuiper)', kind: 'company: constellation owner and operator', url: 'https://www.aboutamazon.com/what-we-do/devices-services/project-kuiper' },
  ula: { name: 'United Launch Alliance', kind: 'company: launch provider', url: 'https://www.ulalaunch.com/' },
  arianespace: { name: 'Arianespace', kind: 'company: launch provider', url: 'https://www.arianespace.com/' },
  esa: { name: 'ESA', kind: 'space agency (Europe)', url: 'https://www.esa.int/' },
  csa: { name: 'Canadian Space Agency', kind: 'space agency (Canada)', url: 'https://www.asc-csa.gc.ca/' },
  cnes: { name: 'CNES', kind: 'space agency (France)', url: 'https://cnes.fr/' },
  roscosmos: { name: 'Roscosmos', kind: 'space agency and launch provider (Russia)', url: 'https://www.roscosmos.ru/' },
  ussf: { name: 'US Space Force', kind: 'military service: range and land owner', url: 'https://www.spaceforce.mil/' },
  noaa: { name: 'NOAA', kind: 'agency (US): weather and space weather', url: 'https://www.noaa.gov/' },
  ast: { name: 'AST SpaceMobile', kind: 'company: satellite owner and operator', url: 'https://ast-science.com/' },
  ucb: { name: 'UC Berkeley Space Sciences Laboratory', kind: 'university: mission lead', url: 'https://www.ssl.berkeley.edu/' },
  rocketLab: { name: 'Rocket Lab', kind: 'company: spacecraft manufacturer', url: 'https://www.rocketlabusa.com/' },
  mit: { name: 'MIT', kind: 'university: principal investigator institution', url: 'https://www.mit.edu/' },
  jhuapl: { name: 'Johns Hopkins APL', kind: 'research lab: mission builder and operator', url: 'https://www.jhuapl.edu/' },
  faa: { name: 'FAA Office of Commercial Space Transportation', kind: 'regulator (US)', url: 'https://www.faa.gov/space' },
  tesla: { name: 'Tesla / Elon Musk (owner of the Roadster)', kind: 'payload owner', url: 'https://www.spacex.com/vehicles/falcon-heavy/' },
} as const;
export type OrgId = keyof typeof ORGS;

export const ROLES = [
  'program-owner', 'science-agency', 'customer', 'payload-owner', 'spacecraft-operator', 'launch-provider',
  'launch-services-manager', 'manufacturer', 'contractor', 'mission-operator', 'partner', 'facility-owner', 'facility-operator', 'tenant', 'regulator',
] as const;
export type Role = (typeof ROLES)[number];

export interface OrgRole { org: OrgId; roles: Role[] }
