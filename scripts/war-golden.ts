// Fingerprint of whole futures, to prove a refactor changed nothing.
//   node scripts/war-golden.ts write   (saves ml/rl/golden.json)
//   node scripts/war-golden.ts         (compares, exit 1 on any difference)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/sim/engine.ts';
import { buildWorld } from '../src/sim/world.ts';
import { civParts } from '../src/sim/civ.ts';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PATH = 'ml/rl/golden.json';
const world = buildWorld();
const out: Record<string, string> = {};
for (const seed of SEEDS) {
  const e = new Engine(world, seed);
  while (!e.done) e.step();
  const h = createHash('sha256');
  const bytes = (a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  bytes(e.st.S); bytes(e.series);
  for (const [, a] of civParts(e.st.hx)) bytes(a as Float64Array);
  h.update(JSON.stringify(e.events));
  out[seed] = h.digest('hex');
}
if (process.argv[2] === 'write') { writeFileSync(PATH, JSON.stringify(out, null, 1)); console.log('wrote', PATH); }
else {
  const want = JSON.parse(readFileSync(PATH, 'utf8'));
  const bad = SEEDS.filter((s) => want[s] !== out[s]);
  console.log(bad.length ? `DIFFERENT: seeds ${bad.join(', ')}` : `identical on ${SEEDS.length} seeds`);
  process.exit(bad.length ? 1 : 0);
}
