// Smoke test for Lives.bornAt and Biography.path. Run: node --experimental-strip-types scripts/lifepick-check.ts [seed]
import { Engine } from '../src/sim/engine.ts';
import { idStr } from '../src/sim/demography.ts';
import { FLOW, SHIP_BODY } from '../src/sim/ledger.ts';
import { Lives } from '../src/sim/lives.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 1);
const world = buildWorld();
const e = new Engine(world, seed);
while (!e.done) e.step();
const L = new Lives(e);
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log(cond ? '  ok ' : 'FAIL ', msg); if (!cond) fails++; };

console.log(`seed ${seed}, ${e.st.settled.length} settled bodies`);

// --- numbering: the n-th person born on a body resolves to a valid identity
for (const [b, n] of [[world.earth, 1], [world.earth, 9_300_000_000], [world.mars, 1], [world.mars, 5000]] as [number, number][]) {
  const r = L.bornAt(b, n, 'any', 3000);
  const name = world.bodies[b]?.name;
  console.log(`bornAt ${name} #${n.toLocaleString()} →`, r.person ? idStr(r.person) : 'none', `(of ${r.total.toLocaleString()})`);
  ok(r.total > 0, `${name} has births`);
  ok(!!r.person === n <= r.total, `${name} #${n}: resolves iff within total`);
  if (r.person) {
    const bio = L.biography(idStr(r.person), 3000);
    ok(!!bio && bio.bornAt === b, `bio of ${idStr(r.person)} exists and was born on ${name}`);
    ok(!!bio && bio.path.length >= 1, 'has a pathway');
  }
}
// out of range
ok(L.bornAt(world.mars, 0, 'any', 3000).person === null, 'n=0 → none');
{
  const r = L.bornAt(world.mars, 1, 'any', 3000);
  ok(L.bornAt(world.mars, r.total + 1, 'any', 3000).person === null, 'n>total → none');
}
ok(L.bornAt(999_999, 1, 'any', 3000).person === null, 'unsettled body → none');

// determinism: same ask, same person
const a = L.bornAt(world.mars, 42, 'any', 5000), c = L.bornAt(world.mars, 42, 'any', 5000);
ok(JSON.stringify(a.person) === JSON.stringify(c.person), 'bornAt is deterministic');

// kind filters find someone (or honestly report none)
for (const kind of ['baseline', 'adapted', 'uploaded']) {
  const r = L.bornAt(world.earth, 2, kind, 8000);
  console.log(`bornAt Earth kind=${kind} →`, r.person ? idStr(r.person) : 'none', `scanned ${r.scanned.toLocaleString()}`);
  if (r.person) {
    const b = L.brief(r.person, 8000);
    console.log('   kind reported:', b.body);
  }
}

// ship-born people, if this future had a generation ship
const ship = [...e.ledger!.births.keys()].find((b) => b >= SHIP_BODY && e.ledger!.births.get(b)!.some((x) => x > 0));
if (ship !== undefined) {
  const r = L.bornAt(ship, 1, 'any', 8000);
  console.log('bornAt ship', ship, '#1 →', r.person ? idStr(r.person) : 'none');
  ok(!!r.person, 'someone was born aboard');
  if (r.person) {
    const bio = L.biography(idStr(r.person), 8000);
    console.log('   ', bio?.name, '| path:', bio?.path.map((s) => s.name).join(' → '));
  }
} else console.log('no generation ships in this future');

// travellers show multi-stop pathways: birthplace → voyage → destination
{
  let multi = 0, sample = '', voyages = 0, tried = 0;
  const srcDone = new Set<number>();
  for (const f of e.ledger!.flows) {
    if (multi >= 5 || tried >= 60) break;
    if (f.kind !== FLOW.MIGRATION || f.lost || srcDone.has(f.src)) continue;
    srcDone.add(f.src); tried++;
    const pid = L.pickTraveller(f.id, 3);
    if (!pid) continue;
    const bio = L.biography(idStr(pid), 10000);
    if (bio && bio.path.length > 1) {
      multi++;
      if (!sample) sample = `${bio.name}: ${bio.path.map((s) => `${s.name} [${Math.round(s.from)}–${s.to === null ? '∞' : Math.round(s.to)}]`).join(' → ')}`;
    }
  }
  console.log(sample || '(no traveller pathway found)');
  ok(multi > 0, 'travellers show multi-stop pathways');
  for (const [, v] of [...e.ledger!.ships.entries()].slice(0, 20)) {
    if (voyages >= 2) break;
    const pid = L.pickTraveller(v.flow, 5);
    if (!pid) continue;
    const bio = L.biography(idStr(pid), 10000);
    if (bio && bio.path.length > 2) {
      voyages++;
      console.log('  voyager:', `${bio.name}: ${bio.path.map((s) => `${s.name} [${Math.round(s.from)}–${s.to === null ? '∞' : Math.round(s.to)}]`).join(' → ')}`);
    }
  }
  ok(voyages > 0 || !e.ledger!.ships.size, 'ship journeys appear in the pathway');
}

// pathway times never go backwards and cover the whole life
for (let k = 0; k < 20; k++) {
  const r = L.bornAt(world.earth, 1 + k * 400_000_000, 'any', 10000);
  if (!r.person) break;
  const bio = L.biography(idStr(r.person), 10000);
  if (!bio) continue;
  let prev = -Infinity, bad = 0;
  for (const s of bio.path) { if (s.from < prev - 0.01) bad++; prev = s.to ?? s.from; }
  ok(bad === 0, `${bio.name}: pathway monotone`);
  ok(Math.abs(bio.path[0].from - bio.born) < 1, `${bio.name}: pathway starts at birth`);
}

process.exit(fails ? 1 : 0);
