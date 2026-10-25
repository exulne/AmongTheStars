// Build-time ingestion of observed data into checked-in snapshots
// (src/data/snapshots/*.json). The browser never calls these services: JPL
// documents fair-use and CORS limits, CelesTrak asks for modest polling, and a
// run must replay identically from a fixed snapshot. Each file records its
// source, URL, retrieval time, API signature or version, and a SHA-256; the
// manifest's snapshot id is the hash of all of them.
//   node scripts/ingest.ts [--only gp,cad,...] [--dry]
// Space-Track (optional, needs an account): set SPACETRACK_USER and
// SPACETRACK_PASS in the environment; credentials are read here, at build
// time, and never reach the page or the repository.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MISSIONS } from '../src/data/registry/missions.ts';
import { adaptCad, adaptGp, adaptSatcat, adaptSentry, adaptSentryVi, CAD_BODIES, type CadQuery } from '../src/data/adapters.ts';
import { spaceWeatherStats } from '../src/orbit/spaceWeatherStats.ts';

const OUT = 'src/data/snapshots';
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const dry = process.argv.includes('--dry');
const want = (k: string) => !only || only.has(k);
const UA = '2SOON2026-ingest/1.0 (educational simulation; build-time snapshot)';
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- polite fetching

const MIN_GAP_MS: Record<string, number> = { 'celestrak.org': 1500, 'ssd-api.jpl.nasa.gov': 1200, 'ssd.jpl.nasa.gov': 1500, 'services.swpc.noaa.gov': 500, 'kp.gfz.de': 500 };
const lastHit = new Map<string, number>();

async function fetchText(url: string, tries = 4): Promise<string> {
  const host = new URL(url).host;
  for (let k = 0; k < tries; k++) {
    const wait = (lastHit.get(host) ?? 0) + (MIN_GAP_MS[host] ?? 1000) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(host, Date.now());
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(90_000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      // CelesTrak answers 403 when the same file is fetched again within its update interval: wait for the next update, do not hammer it
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}${r.status === 403 ? ' (CelesTrak refuses repeat downloads inside its 2-hour update cycle)' : ''}`), { fatal: true });
      return await r.text();
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || k === tries - 1) throw e;
      const back = 2000 * 2 ** k;
      console.warn(`  retry ${k + 1} in ${back} ms: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, back));
    }
  }
  throw new Error('unreachable');
}
const fetchJson = async (url: string): Promise<unknown> => JSON.parse(await fetchText(url));

// ---------------------------------------------------------------- writing

const manifestPath = `${OUT}/manifest.json`;
interface FileEntry { sha256: string; bytes: number; sources: string[]; retrieved: string }
const manifest: { schema: number; snapshotId: string; created: string; files: Record<string, FileEntry> } = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { schema: 1, snapshotId: '', created: '', files: {} };

function write(name: string, body: { provenance: { sources: { url: string }[]; retrieved: string } } & Record<string, unknown>): void {
  const text = JSON.stringify(body);
  const sha256 = createHash('sha256').update(text).digest('hex');
  manifest.files[name] = { sha256, bytes: text.length, sources: body.provenance.sources.map((s) => s.url), retrieved: body.provenance.retrieved };
  console.log(`  ${name}: ${(text.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 12)}`);
  if (!dry) writeFileSync(`${OUT}/${name}`, text);
}

// ---------------------------------------------------------------- sources

async function gp(): Promise<void> {
  console.log('CelesTrak GP (OMM JSON), group "active"');
  const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
  const raw = await fetchJson(url);
  const retrieved = now();
  const { rows, fields, rejected } = adaptGp(raw);
  console.log(`  ${rows.length} objects (${rejected} rejected by validation)`);
  write('gp.json', {
    provenance: { retrieved, sources: [{ organization: 'CelesTrak', url, version: 'GP API, OMM (CCSDS 502.0-B-3) JSON keywords' }], note: 'General-perturbations mean elements for SGP4 only. Positions are valid near each element-set epoch.' },
    fields, rows,
  });
}

async function satcat(): Promise<void> {
  console.log('CelesTrak SATCAT records for mission designators');
  const launches = [...new Set(MISSIONS.flatMap((m) => [m.cospar, ...m.payloads.map((p) => p.cospar)]).filter((x): x is string => !!x).map((c) => c.slice(0, 8)))];
  const records: Record<string, ReturnType<typeof adaptSatcat>> = {};
  const urls: string[] = [];
  for (const l of launches) {
    const url = `https://celestrak.org/satcat/records.php?INTDES=${l}&FORMAT=json`;
    urls.push(url);
    const text = await fetchText(url);
    // keep payloads and the first objects; long debris lists (the ISS has hundreds) add nothing to the check
    records[l] = text.trim().startsWith('[') ? adaptSatcat(JSON.parse(text)).filter((r, i) => r.type === 'PAY' || i < 8).slice(0, 60) : [];
    console.log(`  ${l}: ${records[l].length} objects`);
  }
  write('satcat.json', { provenance: { retrieved: now(), sources: [{ organization: 'CelesTrak SATCAT', url: 'https://celestrak.org/satcat/records.php', version: 'SATCAT JSON' }], queries: urls }, records });
}

async function cad(): Promise<void> {
  console.log('JPL SBDB Close Approach Data API, per body');
  const bodies: Record<string, unknown> = {};
  let signature: unknown = null;
  for (const q of CAD_BODIES) {
    let rows: unknown = null, used: CadQuery | null = null;
    // widen the search for the outer planets until something is found (few objects pass near them)
    for (const attempt of q.attempts) {
      const params = new URLSearchParams({ body: q.code, 'date-min': '1900-01-01', 'date-max': '2200-01-01', diameter: 'true', fullname: 'true', sort: 'dist', limit: '400', ...attempt });
      const url = `https://ssd-api.jpl.nasa.gov/cad.api?${params}`;
      const raw = await fetchJson(url) as { count: number | string; signature?: unknown };
      signature = raw.signature ?? signature;
      if (Number(raw.count) > 0 || attempt === q.attempts[q.attempts.length - 1]) { rows = raw; used = { url, ...attempt }; break; }
    }
    const a = adaptCad(rows, q.name);
    bodies[q.name] = { query: used, count: a.rows.length, fields: a.fields, rows: a.rows };
    console.log(`  ${q.name}: ${a.rows.length} approaches (${used?.url.slice(-80)})`);
  }
  write('cad.json', { provenance: { retrieved: now(), sources: [{ organization: 'NASA/JPL SSD', url: 'https://ssd-api.jpl.nasa.gov/doc/cad.html', version: JSON.stringify(signature) }], note: 'Close approaches are nominal-orbit distances with 3-sigma bounds. They are not impact probabilities.' }, bodies });
}

async function sentry(): Promise<void> {
  console.log('JPL Sentry (Earth impact monitoring)');
  const url = 'https://ssd-api.jpl.nasa.gov/sentry.api';
  const raw = await fetchJson(url) as { signature?: unknown };
  const s = adaptSentry(raw);
  // virtual impactors for the objects that matter most (highest cumulative Palermo value), plus every one large enough to matter
  const pick = [...s.rows].sort((a, b) => (b[s.fields.indexOf('psCum')] as number) - (a[s.fields.indexOf('psCum')] as number)).slice(0, 40).map((r) => r[0] as string);
  const vi: Record<string, ReturnType<typeof adaptSentryVi>> = {};
  for (const des of pick) {
    const u = `https://ssd-api.jpl.nasa.gov/sentry.api?des=${encodeURIComponent(des)}`;
    vi[des] = adaptSentryVi(await fetchJson(u));
  }
  console.log(`  ${s.rows.length} objects, virtual impactors for ${pick.length}`);
  write('sentry.json', { provenance: { retrieved: now(), sources: [{ organization: 'NASA/JPL CNEOS Sentry', url: 'https://ssd-api.jpl.nasa.gov/doc/sentry.html', version: JSON.stringify(raw.signature ?? null) }], note: 'Official Earth-impact probabilities over roughly the next 100 years, for this retrieval only. They change as new observations arrive; objects are routinely removed.' }, fields: s.fields, rows: s.rows, vi });
}

const SBDB_OBJECTS = ['99942', '101955', '29075', '2024 YR4', '433', '1', '4', '16', '25143', '65803'];
async function sbdb(): Promise<void> {
  console.log('JPL SBDB object metadata');
  const objects: Record<string, unknown> = {};
  for (const s of SBDB_OBJECTS) {
    const u = `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(s)}&phys-par=true`;
    const r = await fetchJson(u) as { object?: { fullname?: string; kind?: string; neo?: boolean; pha?: boolean; orbit_class?: { name?: string } }; phys_par?: { name: string; value: string; sigma?: string; units?: string; ref?: string }[]; orbit?: { epoch?: string; orbit_id?: string } };
    objects[s] = {
      fullname: r.object?.fullname, kind: r.object?.kind, neo: r.object?.neo, pha: r.object?.pha, orbitClass: r.object?.orbit_class?.name,
      orbitId: r.orbit?.orbit_id, epochJd: r.orbit?.epoch,
      phys: (r.phys_par ?? []).filter((p) => ['diameter', 'albedo', 'H', 'rot_per', 'density', 'spec_B', 'spec_T', 'GM'].includes(p.name)).map((p) => ({ name: p.name, value: p.value, sigma: p.sigma ?? null, units: p.units ?? null, ref: p.ref ?? null })),
    };
  }
  write('sbdb.json', { provenance: { retrieved: now(), sources: [{ organization: 'NASA/JPL SBDB', url: 'https://ssd-api.jpl.nasa.gov/doc/sbdb.html', version: 'sbdb.api 1.x' }] }, objects });
}

/** Nominal encounter geometry from JPL Horizons for a few featured approaches (state vectors relative to the target body). */
const HORIZONS = [
  { id: 'apophis-2029', command: "'99942'", center: "'500@399'", start: '2029-04-12 00:00', stop: '2029-04-15 00:00', step: "'1 h'", target: 'Earth', note: '99942 Apophis passes inside geostationary distance on 2029-04-13.' },
  { id: 'yr4-2032-moon', command: "'2024 YR4'", center: "'500@301'", start: '2032-12-20 00:00', stop: '2032-12-24 00:00', step: "'1 h'", target: 'Moon', note: 'The lunar encounter whose official impact probability (about 4%) was ruled out by JWST astrometry in 2026.' },
];
async function horizons(): Promise<void> {
  console.log('JPL Horizons vectors');
  const series: unknown[] = [];
  for (const h of HORIZONS) {
    const p = new URLSearchParams({ format: 'json', COMMAND: h.command, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'", CENTER: h.center, START_TIME: `'${h.start}'`, STOP_TIME: `'${h.stop}'`, STEP_SIZE: h.step, VEC_TABLE: "'2'", OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'", REF_PLANE: "'ECLIPTIC'" });
    const url = `https://ssd.jpl.nasa.gov/api/horizons.api?${p}`;
    const r = await fetchJson(url) as { result: string; signature?: unknown };
    const body = r.result.split('$$SOE')[1]?.split('$$EOE')[0] ?? '';
    const rows = body.trim().split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((c) => c.length >= 8).map((c) => [Number(c[0]), ...c.slice(2, 8).map(Number)]);
    series.push({ ...h, url, signature: r.signature ?? null, fields: ['jd_tdb', 'x_km', 'y_km', 'z_km', 'vx_kms', 'vy_kms', 'vz_kms'], rows });
    console.log(`  ${h.id}: ${rows.length} vectors`);
  }
  write('horizons.json', { provenance: { retrieved: now(), sources: [{ organization: 'NASA/JPL Horizons', url: 'https://ssd-api.jpl.nasa.gov/doc/horizons.html' }], note: 'Nominal trajectory only. The uncertainty of each encounter is the CAD 3-sigma range.' }, series });
}

async function spaceWeather(): Promise<void> {
  console.log('NOAA SWPC products and GFZ Kp/Ap/F10.7 record');
  const swpc = 'https://services.swpc.noaa.gov';
  const f107 = await fetchJson(`${swpc}/json/f107_cm_flux.json`) as { time_tag: string; flux: number; reporting_schedule?: string }[];
  const kp = await fetchJson(`${swpc}/products/noaa-planetary-k-index.json`) as unknown[];
  const predicted = await fetchJson(`${swpc}/json/solar-cycle/predicted-solar-cycle.json`) as Record<string, unknown>[];
  const observed = await fetchJson(`${swpc}/json/solar-cycle/observed-solar-cycle-indices.json`) as Record<string, number | string>[];
  const gfzUrl = 'https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt';
  const gfz = await fetchText(gfzUrl);
  const stats = spaceWeatherStats(gfz, observed);
  // the Kp product is a header row then rows, or objects (format changed in 2025): normalise to [time, Kp]
  const kpRows = (kp as unknown[]).flatMap((r) => Array.isArray(r) ? (r[0] === 'time_tag' ? [] : [[String(r[0]), Number(r[1])]]) : [[String((r as { time_tag: string }).time_tag), Number((r as { Kp: number }).Kp)]]);
  write('spaceweather.json', {
    provenance: {
      retrieved: now(),
      sources: [
        { organization: 'NOAA SWPC', url: `${swpc}/json/f107_cm_flux.json` },
        { organization: 'NOAA SWPC', url: `${swpc}/products/noaa-planetary-k-index.json` },
        { organization: 'NOAA SWPC', url: `${swpc}/json/solar-cycle/predicted-solar-cycle.json` },
        { organization: 'NOAA SWPC', url: `${swpc}/json/solar-cycle/observed-solar-cycle-indices.json` },
        { organization: 'GFZ Helmholtz Centre for Geosciences (Matzka et al. 2021, doi:10.1029/2020SW002641), CC BY 4.0; SN from WDC-SILSO (CC BY-NC 4.0); F10.7 from DRAO/NRCan', url: gfzUrl },
      ],
      note: 'Observed near-term inputs only. The simulation never repeats a present-day forecast centuries ahead: deep-future solar activity is generated from the statistics below.',
    },
    recentF107: f107.filter((r) => r.flux > 0).map((r) => [r.time_tag, r.flux]).slice(0, 60),
    recentKp: kpRows.slice(-56),
    predicted: predicted.map((r) => [r['time-tag'], r.predicted_ssn, r['predicted_f10.7'], r['high_f10.7'], r['low_f10.7']]),
    stats,
  });
}

// ---------------------------------------------------------------- main

if (!dry) mkdirSync(OUT, { recursive: true });
const jobs: [string, () => Promise<void>][] = [['gp', gp], ['satcat', satcat], ['cad', cad], ['sentry', sentry], ['sbdb', sbdb], ['horizons', horizons], ['spaceweather', spaceWeather]];
const failed: string[] = [];
for (const [k, f] of jobs) {
  if (!want(k)) continue;
  // a refused or failed source keeps its previous snapshot file (offline fallback); the manifest still hashes what is on disk
  try { await f(); } catch (e) { failed.push(k); console.warn(`  ${k} FAILED, keeping the previous snapshot: ${(e as Error).message}`); }
}
if (failed.length) console.warn(`sources not refreshed: ${failed.join(', ')}`);
manifest.created = now();
manifest.snapshotId = createHash('sha256').update(Object.keys(manifest.files).sort().map((k) => `${k}:${manifest.files[k].sha256}`).join('\n')).digest('hex').slice(0, 12);
if (!dry) writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`snapshot ${manifest.snapshotId}`);
