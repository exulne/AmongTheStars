// The checked-in observed-data snapshot (scripts/ingest.ts writes it): the core
// the engine needs (manifest, space weather, Sentry). snapshot.ts adds the rest. Every
// run starts from one snapshot id and one seed; exports carry both, so a rerun
// with the same pair reproduces the same numbers. Files are validated here on
// load: required provenance fields, expected API signature versions, table
// shapes. A file that fails is reported (SNAPSHOT_CHECKS) and treated as
// missing rather than half-read.

import manifestJson from './snapshots/manifest.json' with { type: 'json' };
import sentryJson from './snapshots/sentry.json' with { type: 'json' };
import swJson from './snapshots/spaceweather.json' with { type: 'json' };
import { SENTRY_FIELDS, type SentryRow, type SentryVi } from './adapters.ts';
import { arr, obj, opt, str, tryCheck, type Check } from './schema.ts';
import type { SpaceWeatherStats } from '../orbit/spaceWeatherStats.ts';

export interface SourceStamp { organization: string; url: string; version?: string }
export interface FileProvenance { retrieved: string; sources: SourceStamp[]; note?: string }

const provCheck: Check<FileProvenance> = obj({ retrieved: str, sources: arr(obj({ organization: str, url: str, version: opt(str) }), 1), note: opt(str) });

export interface SnapshotCheck { file: string; ok: boolean; message: string }
export const SNAPSHOT_CHECKS: SnapshotCheck[] = [];

export function load<T>(file: string, raw: unknown, check: (o: Record<string, unknown>) => string | null): (T & { provenance: FileProvenance }) | null {
  const o = raw as Record<string, unknown>;
  const p = tryCheck(provCheck, o?.provenance, `${file}.provenance`);
  if (!p.ok) { SNAPSHOT_CHECKS.push({ file, ok: false, message: p.error }); return null; }
  const err = check(o);
  SNAPSHOT_CHECKS.push({ file, ok: !err, message: err ?? `retrieved ${p.value.retrieved}` });
  return err ? null : (o as T & { provenance: FileProvenance });
}

/** The API signature recorded at ingest must be a version this adapter understands. */
export function signatureMajor(p: FileProvenance, expect: string): string | null {
  const v = p.sources[0]?.version ?? '';
  return v.includes(`"version":"${expect}`) ? null : `unexpected API signature ${v || '(none)'}; adapter expects version ${expect}.x`;
}

export const MANIFEST = manifestJson as { schema: number; snapshotId: string; created: string; files: Record<string, { sha256: string; bytes: number; sources: string[]; retrieved: string }> };
export const SNAPSHOT_ID = MANIFEST.snapshotId;

export const SENTRY = load<{ fields: string[]; rows: SentryRow[]; vi: Record<string, SentryVi> }>('sentry.json', sentryJson, (o) => {
  const sig = signatureMajor(o.provenance as FileProvenance, '2.');
  if (sig) return sig;
  return (o.fields as string[]).join() === SENTRY_FIELDS.join() ? null : 'field list changed';
});

export const SPACE_WEATHER = load<{ stats: SpaceWeatherStats; recentF107: [string, number][]; recentKp: [string, number][]; predicted: (string | number)[][] }>('spaceweather.json', swJson, (o) => {
  const s = o.stats as SpaceWeatherStats | undefined;
  if (!s || !s.cycles?.length || !s.apQuantiles?.length) return 'missing statistics';
  return s.cycles.length >= 10 ? null : 'too few solar cycles';
});

export function snapshotLine(): string {
  return `observed-data snapshot ${SNAPSHOT_ID} (created ${MANIFEST.created.slice(0, 16).replace('T', ' ')} UTC)`;
}
