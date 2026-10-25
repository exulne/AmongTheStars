// Smoke test for Lives.bornAt and Biography.path, plus the picker's filters and
// sampling. Run: node --experimental-strip-types scripts/lifepick-check.ts [seed]
import { Engine } from '../src/sim/engine.ts';
import { idStr } from '../src/sim/demography.ts';
import { FLOW, SHIP_BODY, isShipBody, periodOf, periodStart } from '../src/sim/ledger.ts';
import { Lives } from '../src/sim/lives.ts';
import { HIST_FIELDS } from '../src/sim/metrics.ts';
import { buildWorld } from '../src/sim/world.ts';
import { buildWant } from '../src/ui/lifePick.ts';

const seed = Number(process.argv[2] ?? 1);
const world = buildWorld();
const e = new Engine(world, seed);
while (!e.done) e.step();
const L = new Lives(e);
L.bodyShares = (b, y) => e.civ.bodiesAt(b, periodOf(y));
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
  const t0 = performance.now();
  const r = L.bornAt(world.earth, 2, kind, 8000);
  console.log(`bornAt Earth kind=${kind} →`, r.person ? idStr(r.person) : 'none', `scanned ${r.scanned.toLocaleString()} in ${(performance.now() - t0).toFixed(0)} ms`);
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

// --- T1: buildWant from raw control values (pure, no DOM)
{
  const V = (o: Record<string, string>) => (k: string) => o[k] ?? '';
  const w1 = buildWant(V({ 'born-lo': '2187', 'born-hi': '2187' }));
  ok(w1.born?.[0] === 147 && w1.born?.[1] === 148, `T1: born 2187–2187 → [${w1.born}]`);
  const w2 = buildWant(V({ 'born-lo': '1990' }));
  ok(w2.born?.[0] === -50 && w2.born?.[1] === 1e6, `T1: born 1990– → [${w2.born}]`);
  const w3 = buildWant(V({ 'born-lo': '300' }));
  ok(w3.born?.[0] === 300 && w3.born?.[1] === 1e6, `T1: born 300– → [${w3.born}]`);
  const w4 = buildWant(V({ 'age-lo': '30', 'age-hi': '30' }));
  ok(w4.age?.[0] === 30 && w4.age?.[1] === 31, `T1: age 30–30 → [${w4.age}]`);
  const w5 = buildWant(V({ 'wealth-lo': '0', 'wealth-hi': '10' }));
  ok(w5.wealth?.[0] === 90 && w5.wealth?.[1] === 100, `T1: wealth top 0–10% → [${w5.wealth}]`);
  ok(Object.values(buildWant(() => '')).every((v) => v === undefined), 'T1: all blank → {}');
}

// --- T2: a rolled person's traits, fed back as whole-year filters, still match people
{
  let r0 = L.pickLife(world.earth, 0, 'any', 1500, undefined, 12345);
  let b0 = r0.person ? L.biography(idStr(r0.person), 1500)! : null;
  for (let s = 20000; s < 20020 && !b0?.alive; s++) { r0 = L.pickLife(world.earth, 0, 'any', 1500, undefined, s); b0 = r0.person ? L.biography(idStr(r0.person), 1500)! : null; }
  ok(!!r0.person && !!b0?.alive, 'T2: pickLife finds someone living on Earth at 1500');
  if (r0.person && b0) {
    const bornY = Math.floor(2040 + b0.born), ageY = Math.floor(b0.age), mv = b0.standing?.moves ?? 0;
    const vals: Record<string, string> = {
      'born-lo': String(bornY), 'born-hi': String(bornY), 'age-lo': String(ageY), 'age-hi': String(ageY),
      sex: b0.sex, 'height-lo': String(b0.height), 'height-hi': String(b0.height),
      'moves-lo': String(mv), 'moves-hi': String(mv),
    };
    const want = buildWant((k) => vals[k] ?? '');
    let found = 0, bad = 0;
    for (const s2 of [11, 22, 33, 44, 55]) {
      const r2 = L.pickLife(world.earth, 0, 'any', 1500, want, s2);
      if (!r2.person) continue;
      found++;
      const b2 = L.biography(idStr(r2.person), 1500)!;
      const ey2 = b2.died ? Math.min(1500, Math.max(b2.born, b2.died.year - 1)) : 1500;   // match()'s year convention
      const age2 = Math.max(0, ey2 - b2.born);
      if (!(b2.sex === want.sex && b2.born >= want.born![0] && b2.born < want.born![1]
        && age2 >= want.age![0] && age2 < want.age![1]
        && b2.height >= want.height![0] && b2.height <= want.height![1]
        && (b2.standing?.moves ?? -1) >= want.moves![0] && (b2.standing?.moves ?? -1) <= want.moves![1])) bad++;
    }
    ok(found > 0, `T2: a found person's traits still find people (${found}/5 salts)`);
    ok(bad === 0, 'T2: every returned person satisfies all constraints');
  }
}

// --- T3: bodies drawn proportional to their people
{
  const YR = 3000;
  const bodies3 = L.birthBodies(YR);
  const preEarth = L.D.ensure(world.earth, 0).pools.filter((x) => x.native && x.q < 0).reduce((a, x) => a + x.n, 0);
  let wTot = 0;
  const wB = new Map<number, number>();
  for (const b of bodies3) {
    let w = 0;
    const br = e.ledger!.births.get(b);
    if (br) for (let k = 0; k < br.length; k++) if (br[k] > 0 && periodStart(k) <= YR) w += br[k];
    if (b === world.earth) w += preEarth;
    wB.set(b, w); wTot += w;
  }
  const expEarth = wB.get(world.earth)! / wTot;
  let hits = 0, got = 0;
  for (let k = 0; k < 400; k++) { const r = L.pickLife(-1, 0, 'any', YR, undefined, k + 1000); if (r.person) { got++; if (r.person.b === world.earth) hits++; } }
  ok(got > 300 && Math.abs(hits / got - expEarth) <= 0.07, `T3: births-path Earth share ${(hits / got).toFixed(3)} ≈ expected ${expEarth.toFixed(3)} (n=${got})`);
  // census path (filtered, no born range): ∝ head-count at the census period
  const pC = Math.max(0, Math.min(L.D.lastPeriod, periodOf(YR) - 1));
  let cTot = 0, cEarth = 0;
  for (const b of bodies3) { const v = Math.max(0, e.ledger!.popEnd.get(b)?.[pC] ?? 0); cTot += v; if (b === world.earth) cEarth = v; }
  const expC = cEarth / cTot;
  let hits2 = 0, got2 = 0;
  for (let k = 0; k < 400; k++) {
    const r = L.pickLife(-1, 0, 'any', YR, { sex: 'f' }, k + 5000);
    if (!r.person) continue;
    got2++;
    if (L.biography(idStr(r.person), YR)?.where?.body === world.earth) hits2++;
  }
  ok(got2 > 300 && Math.abs(hits2 / got2 - expC) <= 0.07, `T3: census-path Earth share ${(hits2 / got2).toFixed(3)} ≈ expected ${expC.toFixed(3)} (n=${got2})`);
}

// --- T4: 'random' is exactly 'any'
{
  const rA = L.pickLife(world.earth, 0, 'any', 5000, undefined, 777);
  const rR = L.pickLife(world.earth, 0, 'random', 5000, undefined, 777);
  ok(JSON.stringify(rA.person) === JSON.stringify(rR.person), `T4: kind 'random' ≡ 'any' → ${rA.person ? idStr(rA.person) : 'none'}`);
}

// --- T5/T7: wealth classes and heights over census draws
const CLS_WANT: Record<string, number> = { poor: 0.25, working: 0.30, comfortable: 0.25, 'well-off': 0.13, wealthy: 0.06, 'the elite': 0.01 };
const drawResidents = (b: number, year: number, n: number) => {
  const p = Math.max(0, Math.min(L.D.lastPeriod, periodOf(year) - (year >= 5 ? 1 : 0)));
  const c = L.D.census(b, p);
  const out: { cls: string; sex: string; h: number }[] = [];
  // an even stride through the member order: uniform over residents, near-exact marginals
  for (let k = 0; k < n && c.total; k++) {
    const bio = L.biography(idStr(c.at(Math.floor((k + 0.5) / n * c.total))), year);
    if (bio?.standing) out.push({ cls: bio.standing.class, sex: bio.sex, h: bio.height });
  }
  return out;
};
const sharesOf = (rows: { cls: string }[]) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.cls, (m.get(r.cls) ?? 0) + 1 / rows.length);
  return m;
};
const checkShares = (rows: { cls: string }[], label: string) => {
  const sh = sharesOf(rows);
  let worst = '';
  for (const [cls, exp] of Object.entries(CLS_WANT)) {
    const s = sh.get(cls) ?? 0, tol = cls === 'the elite' ? 0.01 : 0.03;
    if (Math.abs(s - exp) > tol) worst += ` ${cls} ${s.toFixed(3)}≠${exp}`;
  }
  console.log(`  ${label} shares: ${[...sh].map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`);
  ok(!worst, `T5: ${label} class shares${worst ? ' off:' + worst : ''}`);
};
const e1500 = drawResidents(world.earth, 1500, 2000);
checkShares(e1500, 'Earth@1500');
{
  const p3 = Math.max(0, Math.min(L.D.lastPeriod, periodOf(3000) - 1));
  let best = -1, bestN = 0;
  for (const [b, arr] of e.ledger!.popEnd) { if (b === world.earth || isShipBody(b)) continue; const v = Math.max(0, arr[p3]); if (v > bestN) { bestN = v; best = b; } }
  if (best >= 0 && bestN >= 1000) checkShares(drawResidents(best, 3000, 2000), `${world.bodies[best].name}@3000`);
  else console.log('  skip: no non-Earth body with ≥1000 residents at 3000');
}
{
  const men = e1500.filter((r) => r.sex === 'm').map((r) => r.h), women = e1500.filter((r) => r.sex === 'f').map((r) => r.h);
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
  const diff = mean(men) - mean(women);
  ok(diff >= 10 && diff <= 16, `T7: mean height men−women ${diff.toFixed(1)} cm`);
  ok(sd(men) >= 5 && sd(men) <= 9 && sd(women) >= 5 && sd(women) <= 9, `T7: within-sex SD m ${sd(men).toFixed(1)} / f ${sd(women).toFixed(1)}`);
}

// --- T6: histAt().gini is the last history row's gini at or before the year
{
  const w = 2 + HIST_FIELDS.length, gi = 2 + HIST_FIELDS.indexOf('gini');
  const giniAt = (b: number, year: number) => {
    const ys = e.years;
    let lo = 0, hi = ys.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ys[m] <= year) lo = m; else hi = m - 1; }
    for (let i = e.histLen - 1; i >= 0; i--) if (e.hist[i * w] <= lo && e.hist[i * w + 1] === b) return e.hist[i * w + gi];
    return NaN;
  };
  for (const [b, y] of [[world.earth, 300], [world.earth, 3000], [world.mars, 300], [world.mars, 3000]] as [number, number][]) {
    const got = ((L as unknown as { histAt(b: number, y: number): { gini: number } | null }).histAt(b, y)?.gini) ?? NaN, want = giniAt(b, y);
    ok(got === want || (Number.isNaN(got) && Number.isNaN(want)), `T6: histAt gini ${world.bodies[b].name}@${y} = ${got} (scan ${want})`);
  }
}

// --- T8: kind 'uploaded' share among residents ≈ the body's recorded uploaded share
{
  let kB = -1, kY = 0, kSh = 0;
  outer: for (const y of [8000, 6000, 10000, 4000, 2000]) {
    const p = periodOf(y);
    for (let n = 0; n < e.st.nSettled; n++) {
      const b = e.st.settled[n], sh = e.civ.bodiesAt(b, p);
      if (sh.uploaded >= 0.05) { kB = b; kY = y; kSh = sh.uploaded; break outer; }
    }
  }
  if (kB < 0) console.log('  skip T8: no body with uploaded share ≥ 0.05 in this seed');
  else {
    const p = Math.max(0, Math.min(L.D.lastPeriod, periodOf(kY) - 1));
    const c = L.D.census(kB, p);
    let up = 0, n2 = 0;
    for (let k = 0; k < 2000 && c.total; k++) {
      if (L.brief(c.at(Math.floor((k + 0.5) / 2000 * c.total)), kY).body === 'uploaded') up++;
      n2++;
    }
    const got = up / n2;
    ok(Math.abs(got - kSh) <= 0.04, `T8: ${world.bodies[kB].name}@${kY} uploaded share ${got.toFixed(3)} ≈ ${kSh.toFixed(3)} (n=${n2})`);
  }
}

// --- T9: no faith data on a person
{
  const r = L.pickLife(world.earth, 0, 'any', 3000, undefined, 4242);
  if (!r.person) ok(false, 'T9: found nobody to inspect');
  else {
    const b9 = L.biography(idStr(r.person), 3000)!;
    ok(!Object.hasOwn(b9, 'faith'), 'T9: biography has no faith field');
    ok(!b9.standing || !Object.hasOwn(b9.standing, 'devotion'), 'T9: standing has no devotion field');
  }
}

process.exit(fails ? 1 : 0);
