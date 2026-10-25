// Print a future's Chronicle in the terminal, for reading the history the sim tells.
//   node scripts/chronicle.ts [seed=1] [--types=War,Treaty] [--min=4] [--from=0] [--to=10000] [--limit=80] [--bio=N] [--minds]
//   --minds: polities decide war with the trained generations in src/ml/warWeights.ts
import { Engine } from '../src/sim/engine.ts';
import { EVENT_NAMES } from '../src/sim/catalog.ts';
import { Chronicle } from '../src/sim/chronicle.ts';
import { Lives } from '../src/sim/lives.ts';
import { periodOf } from '../src/sim/ledger.ts';
import { buildWorld } from '../src/sim/world.ts';
import { NetMind } from '../src/ml/netMind.ts';
import { loadWarGens } from '../src/ml/warGens.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const seed = Number(args.find((a) => !a.startsWith('--')) ?? 1);
const types = opt('types', '').split(',').filter(Boolean);
const t0 = performance.now();
const e = new Engine(buildWorld(), seed);
if (args.includes('--minds')) {
  const g = await loadWarGens();
  if (!g) throw new Error('no trained generations in src/ml/warWeights.ts');
  const m = new NetMind(e, g.nets, () => 0, seed);
  m.byYear = g.genAt; e.civ.pol.mind = m;
}
while (!e.done) e.step();
const t1 = performance.now();
const L = new Lives(e);
const c = new Chronicle(e, L);
L.faithAt = (b, year, u) => {
  for (const [f, sh] of e.civ.faithsAt(b, periodOf(year))) { if (u < sh) return c.faithName(f); u -= sh; }
  return null;
};
L.bodyShares = (b, year) => e.civ.bodiesAt(b, periodOf(year));
L.deeds = (pid, stays) => c.deedsOf(pid, stays).map((en) => ({ year: en.year, text: en.segs.map((s) => (typeof s === 'string' ? s : s.t)).join('') }));
console.log(`seed ${seed}: sim ${(t1 - t0).toFixed(0)} ms, ${e.events.length} events`);
const text = (segs: (string | { t: string })[]) => segs.map((s) => (typeof s === 'string' ? s : s.t)).join('');
const all = c.list(Number(opt('from', '0')), Number(opt('to', '10000')), { limit: 1e9, minWeight: Number(opt('min', '0')) }).reverse();
const shown = all.filter((en) => !types.length || types.includes(EVENT_NAMES[en.type]));
for (const en of shown.slice(0, Number(opt('limit', '80')))) console.log(`${Math.round(2040 + en.year)}  [${EVENT_NAMES[en.type]}] ${text(en.segs)}`);
if (args.includes('--ages')) for (const a of c.ages()) console.log(`AGE ${Math.round(2040 + a.from)}–${Math.round(2040 + a.to)}  ${a.name}`);
const bio = opt('bio', '');
if (bio) {
  // biographies of the first N people the shown entries name
  const ids = [...new Set(shown.flatMap((en) => en.people))].slice(0, Number(bio));
  for (const id of ids) {
    const b = L.biography(id, 10000);
    if (!b) continue;
    console.log(`\n== ${b.name} (${Math.round(2040 + b.born)}–${b.died ? Math.round(2040 + b.died.year) : ''})`);
    for (const s of b.story) console.log(`  ${Math.round(2040 + s.year)}  ${s.text}`);
  }
}
