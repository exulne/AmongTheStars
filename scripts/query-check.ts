// Checks the query language: parsing, precedence, strings, errors.
//   node scripts/query-check.ts
import { DATA_METRICS } from '../src/sim/metrics.ts';
import { globalBinder, PLACE_NAMES, placeBinder, QueryError, tryCompile } from '../src/sim/query.ts';
import { buildWorld } from '../src/sim/world.ts';

const vars: Record<string, number | string> = { pop: 2e6, stability: 0.2, gdp: 4e9, name: 'Mars', system: 'Sol' };
const bind = (n: string) => (n in vars ? () => vars[n] : null);
const cases: [string, number | string][] = [
  ['stability < 0.3 && pop > 1e6', 1], ['gdp/pop', 2000], ['2^3^2', 512], ['-2^2', -4], ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9],
  ['pop > 1M and not (stability > 0.5)', 1], ['name == "mars"', 1], ['system ~ "so"', 1], ["name != 'Mars'", 0],
  ['max(1,2,3)+min(4,5)', 7], ['if(pop>1k, 1, 2)', 1], ['1_000 * 2.5B', 2.5e12], ['stability = 0.2', 1],
  ['sqrt(9)*log(1000)', 9], ['10 % 3', 1], ['1 < 2 == 1', 1], ['!0 || 0', 1],
  ['pop >', 'error'], ['foo + 1', 'error'], ['(1', 'error'], ['1 2', 'error'], ['nope(1)', 'error'], ['"open', 'error'],
];
let bad = 0;
for (const [src, want] of cases) {
  const c = tryCompile(src, bind);
  const got = c instanceof Error ? 'error' : c.value(null);
  if (got !== want) { bad++; console.log(`FAIL ${src}: got ${got}, want ${want}${c instanceof Error ? ` (${c.message})` : ''}`); }
}
// faith and culture are narrative, not data: the query language doesn't bind them
const pb = placeBinder(buildWorld());
for (const src of ['culture > 0', 'faith > 0']) {
  const c = tryCompile(src, pb);
  if (!(c instanceof QueryError)) { bad++; console.log(`FAIL ${src}: expected Unknown field`); }
}
if (globalBinder()('faiths') !== null) { bad++; console.log('FAIL globalBinder("faiths") should be null'); }
if (PLACE_NAMES.includes('culture') || PLACE_NAMES.includes('faith')) { bad++; console.log('FAIL PLACE_NAMES lists culture or faith'); }
if (DATA_METRICS.some((m) => m.key === 'faiths')) { bad++; console.log('FAIL DATA_METRICS includes faiths'); }

console.log(bad ? `${bad} query checks failed` : `query: ${cases.length} checks ok`);
if (bad) process.exit(1);
