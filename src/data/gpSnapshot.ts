// The GP (OMM) element snapshot: thousands of currently active objects. Loaded
// only by the worker, which does every SGP4 propagation, so the page bundle
// does not carry it twice.

import gpJson from './snapshots/gp.json' with { type: 'json' };
import { GP_FIELDS, type GpRow } from './adapters.ts';
import { load } from './snapshotCore.ts';

export const GP = load<{ fields: string[]; rows: GpRow[] }>('gp.json', gpJson, (o) => {
  const f = o.fields as string[] | undefined;
  if (!f || f.join() !== GP_FIELDS.join()) return 'GP field list changed';
  return Array.isArray(o.rows) ? null : 'no rows';
});
