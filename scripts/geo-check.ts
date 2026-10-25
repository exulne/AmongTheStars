// Living worlds checker: the geophysics stream keeps its configured rates, the
// clocks keep real time, worlds stay physically sane, and replay is exact.
// Exit code 1 on any failure.
//   node scripts/geo-check.ts [streamSeeds=300] [engineSeeds=4]
import { Engine, YEAR0, type SimState } from '../src/sim/engine.ts';
import { EV, EVENT_NAMES } from '../src/sim/catalog.ts';
import { buildWorld } from '../src/sim/world.ts';
import {
  GEO_CATALOGUE, GEV, GF, GG, Geo, MARS, NGEO, NGEV, earthObliquity, earthPerihelionLon, halleyReturns, marsCaps, marsLs, marsStorm, marsTimeAt, marsYear,
  moonDistanceKm, perihelionDay, stellarRates, gh, Y0,
} from '../src/sim/geo.ts';

const args = process.argv.slice(2).map(Number);
const N_STREAM = args[0] || 300, N_ENGINE = args[1] || 4;
const world = buildWorld();
let fails = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log('FAIL', msg); } };
const name = (n: string) => world.bodies.findIndex((b) => b.name === n && b.system === 0);
const T = 10000;

// ---- 1. the stream keeps its rates: counts over many seeds inside Poisson bands (4 sigma, or an exact tail for small means)
function band(obs: number, mean: number): boolean {
  if (mean > 30) return Math.abs(obs - mean) <= 4 * Math.sqrt(mean);
  // P(X >= obs) and P(X <= obs) both above 1e-5
  let p = Math.exp(-mean), cdf = 0;
  for (let k = 0; k < obs; k++) { cdf += p; p *= mean / (k + 1); }
  const lower = cdf + p, upper = 1 - cdf;
  return lower > 1e-5 && upper > 1e-5;
}
{
  const bodies = ['Earth', 'Mars', 'Moon', 'Io', 'Enceladus', 'Jupiter', 'Venus', 'Ceres'].map(name);
  const counts = new Map<number, Float64Array>(bodies.map((b) => [b, new Float64Array(NGEV)]));
  const t0 = performance.now();
  for (let s = 1; s <= N_STREAM; s++) {
    const g = new Geo(world, s);
    for (const b of bodies) { const c = counts.get(b)!; for (const ev of g.eventsIn(b, 0, T)) c[ev.cls]++; }
  }
  const g = new Geo(world, 1);
  let rows = 0;
  for (const b of bodies) {
    const c = counts.get(b)!;
    for (let k = 0; k < NGEV; k++) {
      const mean = g.rate[b * NGEV + k] * T * N_STREAM;
      if (mean === 0) { ok(c[k] === 0, `${world.bodies[b].name}: ${GEO_CATALOGUE[k].name} has no rate but happened ${c[k]} times`); continue; }
      rows++;
      ok(band(c[k], mean), `${world.bodies[b].name}: ${GEO_CATALOGUE[k].name} ${c[k]} vs expected ${mean.toFixed(1)}`);
    }
  }
  const e = counts.get(world.earth)!;
  const per = (k: number) => (e[k] / N_STREAM).toFixed(k === GEV.VEI8 || k === GEV.KM1 ? 3 : 1);
  console.log(`stream: ${N_STREAM} seeds × ${rows} body-classes in ${((performance.now() - t0) / 1000).toFixed(1)} s; Earth per future: airbursts ${per(GEV.AIR20)} (20 m), ${per(GEV.TUNG)} (50 m); VEI 6 ${per(GEV.VEI6)}, VEI 7 ${per(GEV.VEI7)}, VEI 8 ${per(GEV.VEI8)}; Mw 9 ${per(GEV.QUAKE)}; 1 km impacts ${per(GEV.KM1)}`);
  // same seed, same events; independent of the window it is asked through
  const a = new Geo(world, 7), b2 = new Geo(world, 7);
  const whole = a.eventsIn(world.earth, 0, 400).map((x) => `${x.cls}:${x.t}`).join();
  const parts: string[] = [];
  for (let y = 0; y < 400; y += 7) for (const x of b2.eventsIn(world.earth, y, Math.min(400, y + 7))) parts.push(`${x.cls}:${x.t}`);
  ok(whole === parts.join(), 'event stream differs when asked through different windows');
  // stellar storms: the Sun's classes over many seeds (the engine draws them per bin like worlds)
  const [carr, miy] = stellarRates('G2');
  ok(Math.abs(1 / carr - 100) < 1 && Math.abs(1 / miy - 2000) < 1, 'solar storm rates');
}

// ---- 2. Mars: global dust storms about one every 3–5 Mars years, always starting at Ls 180–310; caps follow the Mars year
{
  let storms = 0, years = 0, outside = 0;
  for (let s = 1; s <= N_STREAM; s++) for (let n = 36; n < 36 + 50; n++) {
    years++;
    const st = marsStorm(s, n);
    if (!st) continue;
    storms++;
    const ls = marsLs(st.start);
    if (ls < 179.5 || ls > 310.5) outside++;
    if (marsYear(st.start + 1e-6) !== n) outside++;
  }
  const per = storms / years;
  ok(per > 1 / 5 && per < 1 / 3, `Mars storms ${per.toFixed(3)} per Mars year, want 1/5–1/3`);
  ok(outside === 0, `${outside} Mars storms began outside Ls 180–310 or their Mars year`);
  // the clock: Mars Year 36 began on 7 February 2021 (Ls 0); the MY 34 storm began near Ls 186 at the end of May 2018
  ok(Math.abs(marsTimeAt(36, 0) - 2021.104) < 0.01, `MY 36 starts ${marsTimeAt(36, 0).toFixed(3)}`);
  ok(Math.abs(marsTimeAt(34, 186) - 2018.41) < 0.02, `MY 34 Ls 186 at ${marsTimeAt(34, 186).toFixed(3)}`);
  // caps: the north is biggest in late northern winter, smallest in northern summer; the south the other way round
  let northOk = 0, southOk = 0, periodic = 0;
  const N = 40;
  for (let n = 40; n < 40 + N; n++) {
    const capAt = (ls: number) => marsCaps(1, marsTimeAt(n, ls));
    if (capAt(345)[0] > capAt(120)[0] + 15) northOk++;
    if (capAt(165)[1] > capAt(320)[1] + 15) southOk++;
    const y = marsTimeAt(n, 60);
    if (Math.abs(marsCaps(1, y)[0] - marsCaps(1, y + MARS.P)[0]) < 3) periodic++;
  }
  ok(northOk === N && southOk === N && periodic === N, `Mars caps: north ${northOk}/${N}, south ${southOk}/${N}, periodic ${periodic}/${N}`);
  console.log(`Mars: ${(1 / per).toFixed(1)} Mars years between global storms; caps north ${marsCaps(1, marsTimeAt(50, 345))[0].toFixed(0)}° → ${marsCaps(1, marsTimeAt(50, 120))[0].toFixed(0)}° from the pole, south ${marsCaps(1, marsTimeAt(50, 165))[1].toFixed(0)}° → ${marsCaps(1, marsTimeAt(50, 320))[1].toFixed(0)}°`);
}

// ---- 3. clocks: Earth's orbit, the Moon, comets
{
  const e0 = earthObliquity(2040), e1 = earthObliquity(12040), rate = (earthObliquity(2140) - e0) * 3600;
  // Laskar (1986), as given by Meeus: 23.436° in 2040, falling ≈ 47″ a century now. Its curve bottoms out near 11,800 CE at about
  // 22.6°, so 12,040 lands there (a straight line at today's rate would overshoot to ≈ 22.1°).
  ok(Math.abs(e0 - 23.436) < 0.002, `obliquity 2040 ${e0.toFixed(4)}`);
  ok(rate < -44 && rate > -50, `obliquity changing ${rate.toFixed(1)}″ per century in 2040`);
  ok(e1 > 22.5 && e1 < 22.7, `obliquity 12040 ${e1.toFixed(3)}`);
  const p0 = perihelionDay(2040), p1 = perihelionDay(12040);
  ok(p0 > 2 && p0 < 5, `perihelion in 2040 on day ${p0.toFixed(1)} (early January)`);
  ok(p1 > 170 && p1 < 200, `perihelion in 12040 on day ${p1.toFixed(1)} (northern summer)`);
  ok(Math.abs(earthPerihelionLon(2000) - 102.94) < 0.01, 'perihelion longitude J2000');
  ok(Math.abs(moonDistanceKm(12040) - 384400 - 0.382) < 0.001, 'Moon recedes 3.82 cm a year (382 m by 12040)');
  const h = halleyReturns(1);
  ok(Math.abs(h[0].t - 2061.57) < 0.01 && Math.abs(h[1].t - 2134.24) < 0.01, 'Halley returns in 2061 and 2134');
  ok(h.length > 120 && h.length < 140 && h.every((r, i) => i === 0 || (r.t - h[i - 1].t > 72 && r.t - h[i - 1].t < 80)), `Halley: ${h.length} returns, 72–80 years apart`);
  console.log(`clocks: obliquity ${e0.toFixed(3)}° (2040) → ${e1.toFixed(3)}° (12040), ${rate.toFixed(1)}″/century now; perihelion day ${p0.toFixed(0)} → ${p1.toFixed(0)}; ${h.length} Halley returns`);
  void gh; void Y0;
}

// ---- 4. the engine: sane worlds, events applied as generated, replay exact
function same(a: ArrayLike<number>, b: ArrayLike<number>): number { if (a.length !== b.length) return -2; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i; return -1; }
for (let seed = 1; seed <= N_ENGINE; seed++) {
  const e = new Engine(world, seed);
  const geo = e.geo, earth = world.earth, mars = world.mars;
  let snap: SimState | null = null, snapStep = 0;
  const want = 300 + 37 * seed;
  let minSea = Infinity, maxSea = -Infinity, minT = Infinity, maxT = -Infinity, bad = '';
  const eo = earth * NGEO;
  while (!e.done) {
    if (e.st.step === want) { snap = e.snapshot(); snapStep = e.st.step; }
    e.step();
    const g = e.st.geo, rows = geo.nSol + e.st.nSettled;
    const sea = g[eo + GF.sea], Tm = g[eo + GF.tAnom] - g[eo + GF.avgCool];
    minSea = Math.min(minSea, sea); maxSea = Math.max(maxSea, sea); minT = Math.min(minT, Tm); maxT = Math.max(maxT, Tm);
    if (e.st.step % 25 === 0 && !bad) {
      for (let r = 0; r < rows && !bad; r++) {
        const o = r * NGEO;
        for (let k = 0; k < NGEO; k++) if (!Number.isFinite(g[o + k])) bad = `row ${r} field ${k} = ${g[o + k]}`;
        if (g[o + GF.ice] < -1e-9 || g[o + GF.ice] > 1 + 1e-9) bad = `row ${r} ice ${g[o + GF.ice]}`;
        if (g[o + GF.terra] < 0 || g[o + GF.terra] > 1) bad = `row ${r} terra ${g[o + GF.terra]}`;
        if (g[o + GF.aero0] < 0) bad = `row ${r} aerosol ${g[o + GF.aero0]}`;
        if (geo.baseP[r < geo.nSol ? r : e.st.settled[r - geo.nSol]] >= 0 && g[o + GF.pAtm] < 0) bad = `row ${r} pressure ${g[o + GF.pAtm]}`;
      }
    }
  }
  ok(!bad, `seed ${seed}: ${bad}`);
  // Earth: from +1.7 K in 2040, no ice age in the window (only brief volcanic or impact winters), seas within what the ice sheets allow
  ok(minSea > -3 && maxSea < 15, `seed ${seed}: Earth's sea level ${minSea.toFixed(2)}..${maxSea.toFixed(2)} m`);
  ok(minT > -9 && maxT < 6, `seed ${seed}: Earth's temperature anomaly ${minT.toFixed(2)}..${maxT.toFixed(2)} K`);
  // every supereruption and Mars dust storm the stream made was applied and written up
  const vei8 = geo.eventsIn(earth, 0, T).filter((x) => x.cls === GEV.VEI8).length;
  const logged8 = e.events.filter((x) => x.type === EV.Supereruption && x.body === earth).length;
  ok(vei8 === logged8, `seed ${seed}: ${vei8} supereruptions in the stream, ${logged8} written up`);
  let storms = 0;
  for (let n = marsYear(YEAR0); marsTimeAt(n, 0) < YEAR0 + T; n++) { const s = marsStorm(seed, n); if (s && s.start >= YEAR0 && s.start < YEAR0 + T) storms++; }
  const loggedStorms = e.events.filter((x) => x.type === EV['Dust storm'] && x.body === mars).length;
  ok(storms === loggedStorms, `seed ${seed}: ${storms} Mars storms in the stream, ${loggedStorms} written up`);
  // replay from a snapshot reproduces the geo state exactly
  const r = new Engine(world, seed);
  r.logEvents = false;
  r.restore(snap!);
  while (r.st.step < snapStep + 60) r.step();
  const ref = new Engine(world, seed);
  ref.logEvents = false;
  while (ref.st.step < snapStep + 60) ref.step();
  for (const k of ['geo', 'geoG', 'scars', 'geoRng', 'S'] as const) {
    const i = same(r.snapshot()[k], ref.snapshot()[k]);
    ok(i === -1, `seed ${seed}: replay from step ${snapStep} diverged in ${k} at ${i}`);
  }
  const G = e.st.geoG, counts: Record<string, number> = {};
  for (const x of e.events) if (x.type >= EV.Airburst || x.type === EV['Asteroid strike'] || x.type === EV['Solar storm']) counts[EVENT_NAMES[x.type]] = (counts[EVENT_NAMES[x.type]] ?? 0) + 1;
  console.log(`seed ${seed}: Earth ${(e.st.geo[eo + GF.tAnom]).toFixed(2)} K at the end (range ${minT.toFixed(2)}..${maxT.toFixed(2)}), sea ${minSea.toFixed(2)}..${maxSea.toFixed(2)} m; impacts ${G[GG.impacts]}, VEI 7+ ${G[GG.eruptions]}, Miyake-class ${G[GG.solar]}; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

console.log(fails ? `\ngeo: ${fails} FAILED` : '\ngeo: all checks ok');
process.exit(fails ? 1 : 0);
