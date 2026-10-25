// The full observed-data snapshot for the desk: the core (snapshotCore.ts) plus
// close approaches, object metadata, Horizons vectors and the SATCAT records
// used to check the mission registry.

import cadJson from './snapshots/cad.json' with { type: 'json' };
import sbdbJson from './snapshots/sbdb.json' with { type: 'json' };
import horizonsJson from './snapshots/horizons.json' with { type: 'json' };
import satcatJson from './snapshots/satcat.json' with { type: 'json' };
import { CAD_FIELDS, type CadRow, type SatcatRecord } from './adapters.ts';
import { arr, obj, record, str, tryCheck } from './schema.ts';
import { load, signatureMajor, type FileProvenance } from './snapshotCore.ts';

export * from './snapshotCore.ts';

export interface CadBody { query: { url: string } | null; count: number; fields: readonly string[]; rows: CadRow[] }
export const CAD = load<{ bodies: Record<string, CadBody> }>('cad.json', cadJson, (o) => {
  const prov = o.provenance as FileProvenance;
  const sig = signatureMajor(prov, '1.');
  if (sig) return sig;
  const b = o.bodies as Record<string, CadBody> | undefined;
  if (!b) return 'no bodies';
  for (const [k, v] of Object.entries(b)) if (v.fields.join() !== CAD_FIELDS.join()) return `${k}: field list changed`;
  return null;
});

export interface SbdbObject { fullname?: string; kind?: string; neo?: boolean; pha?: boolean; orbitClass?: string; orbitId?: string; epochJd?: string; phys: { name: string; value: string; sigma: string | null; units: string | null; ref: string | null }[] }
export const SBDB = load<{ objects: Record<string, SbdbObject> }>('sbdb.json', sbdbJson, (o) => (o.objects ? null : 'no objects'));

export interface HorizonsSeries { id: string; target: string; note: string; url: string; fields: string[]; rows: number[][]; start: string; stop: string }
export const HORIZONS = load<{ series: HorizonsSeries[] }>('horizons.json', horizonsJson, (o) => (Array.isArray(o.series) ? null : 'no series'));

export const SATCAT = load<{ records: Record<string, SatcatRecord[]> }>('satcat.json', satcatJson, (o) => {
  const r = tryCheck(record(arr(obj({ name: str, objectId: str }))), o.records, 'satcat.records');
  return r.ok ? null : r.error;
});

