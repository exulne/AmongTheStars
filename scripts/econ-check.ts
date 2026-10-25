// Checks the launch-economics model (src/sim/launchEconomics.ts) and its place in
// the engine: mass and cost accounting, tanker campaigns, reuse, cadence, risk,
// ISRU, affordability, determinism, snapshot replay and value sanity.
//   node scripts/econ-check.ts [seed]
import { Engine, type SimState } from '../src/sim/engine.ts';
import { GM, NGM } from '../src/sim/metrics.ts';
import {
  CF, COST_KEYS, KIND, MC, MC_NAMES, NMC, baseline, envelope, evaluate, getRange, interstellarAllowance, leoCostPerKg, mapBases, monteCarlo, ranges, routeFor, scenario, sensitivity, stepBudget, unpackMission,
  type Assumptions, type MissionContext, type MissionSpec,
} from '../src/sim/launchEconomics.ts';
import { buildWorld } from '../src/sim/world.ts';

const seed = Number(process.argv[2] ?? 3);
const world = buildWorld();
const body = (n: string) => world.bodies.find((b) => b.name === n)!.id;
let bad = 0, n = 0;
const ok = (cond: boolean, what: string) => { n++; if (!cond) { bad++; console.log(`FAIL ${what}`); } };
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

const ctx0: MissionContext = { era: 1, flags: CF.reusable, shortage: 0, productivity: 1, energyFx: 1, launchGen: 1, cumLaunches: 0, pLossTransit: 0, shipSpeedC: 0 };
const A = baseline();
const set = (a: Assumptions, path: string, v: number) => mapBases(a, (x, p) => (p === path ? v : x.base));
const crew = (from: string, to: string, people = 20): MissionSpec => ({ kind: 'crew', crew: people, cargoKg: people * 10000, route: routeFor(world, body(from), body(to)) });
const service = (from: string, to: string): MissionSpec => ({ kind: 'service', crew: 100, cargoKg: 0, route: routeFor(world, body(from), body(to)) });

// 1. mass conservation: methane + oxygen = everything loaded on Earth, in the mixture ratio
{
  const e = evaluate(crew('Earth', 'Mars'), ctx0, A), S = A.starship;
  const loaded = (e.missionLaunches + e.tankerFlights + e.depotLaunches) * (S.shipPropellantKg.base + S.boosterPropellantKg.base);
  ok(near(e.methaneKg + e.oxygenKg, loaded), `methane ${e.methaneKg} + oxygen ${e.oxygenKg} = loaded ${loaded}`);
  ok(near(e.oxygenKg / e.methaneKg, S.oxygenFuelMassRatio.base), 'oxygen:methane mass ratio');
}

// 2. campaign: tanker count is the ceiling of need over effective delivery, and moves the right way
{
  const spec = crew('Earth', 'Moon');
  const base = evaluate(spec, ctx0, A);
  ok(Number.isInteger(base.tankersPerShip) && base.tankersPerShip > 0 && base.tankerFlights === base.tankersPerShip * base.ships, `integer tankers: ${base.tankersPerShip} per ship × ${base.ships}`);
  const worse = (path: string, v: number) => evaluate(spec, ctx0, set(A, path, v)).tankersPerShip;
  ok(worse('starship.transferEfficiency', 0.7) > base.tankersPerShip, 'lower transfer efficiency needs more tankers');
  ok(worse('starship.boiloffPerDay', 0.006) > base.tankersPerShip, 'more boil-off needs more tankers');
  ok(worse('starship.reserveFraction', 0.2) > base.tankersPerShip, 'larger reserves need more tankers');
  ok(worse('starship.tankerPayloadKg', 300e3) < base.tankersPerShip, 'bigger tankers mean fewer of them');
  // the ceiling, recomputed by hand for one ship
  const S = A.starship, M = A.mission, ve = S.ispVacS.base * 9.80665 / 1000, R = spec.route;
  const ships = base.ships, p = (spec.crew * M.massPerPassengerKg.base + spec.cargoKg) / ships;
  const carry = base.returnMode === 'reuse-carried' ? S.shipDryMassKg.base * (Math.exp(R.backKmS / ve) - 1) : 0;
  const burn = (S.shipDryMassKg.base + p + carry) * (Math.exp((R.outKmS + M.transferMarginKmS.base) / ve) - 1) + carry;
  const need = (burn - S.ascentResidualKg.base) * (1 + S.missionMargin.base);
  const boil = Math.min(0.5, S.boiloffPerDay.base * S.loiterDays.base * (base.depotLaunches ? S.depotBoiloffFactor.base : 1));
  const eff = S.tankerPayloadKg.base * S.transferEfficiency.base * (1 - boil) * (1 - S.reserveFraction.base);
  ok(base.tankersPerShip === Math.ceil(need / (eff * (1 - S.scrubFailAllowance.base)) - 1e-9), `tankers = ceil(need/effective): ${base.tankersPerShip}`);
  const mars = evaluate(crew('Earth', 'Mars'), ctx0, A).tankersPerShip, spacex = evaluate(spec, ctx0, baseline('starship-spacex')).tankersPerShip;
  ok(mars !== base.tankersPerShip && spacex !== base.tankersPerShip, `tanker count emerges: Moon ${base.tankersPerShip}, Mars ${mars}, Moon on SpaceX-published figures ${spacex}`);
  console.log(`  tankers per ship: Moon ${base.tankersPerShip} (public estimates 4–20), Mars ${mars}, Moon with SpaceX-published capacities ${spacex}`);
}

// 3. cost accounting: components add exactly to the total, everywhere
{
  let worst = 0;
  const names = ['Moon', 'Mars', 'Phobos', 'Ceres', 'Europa', 'Titan', 'Venus', 'Vesta', 'Callisto'];
  for (const from of ['Earth', 'Mars', 'Moon']) for (const to of names) for (const flags of [0, CF.reusable, CF.reusable | CF.isruDest | CF.isruOrigin, CF.reusable | CF.ntp, CF.reusable | CF.fusion | CF.asteroidDepot, CF.elevator | CF.massDriver | CF.kessler]) {
    if (from === to) continue;
    for (const spec of [crew(from, to), service(from, to)]) {
      const e = evaluate(spec, { ...ctx0, flags }, A);
      if (!e.feasible) continue;
      const sum = COST_KEYS.reduce((s, k) => s + e.cost[k], 0);
      worst = Math.max(worst, Math.abs(sum - e.total) / e.total);
    }
  }
  ok(worst <= 1e-12, `components add to the total (worst relative gap ${worst})`);
}

// 4. reuse: a longer life lowers amortised hardware
{
  const spec = service('Earth', 'Mars'), ctx = { ...ctx0, flags: CF.reusable | CF.isruDest };
  const h = (life: number) => evaluate(spec, ctx, set(set(A, 'starship.shipDesignLifeFlights', life), 'starship.boosterDesignLifeFlights', life)).cost.hardware;
  ok(h(20) > h(50) && h(50) > h(200), `hardware falls with life: ${h(20).toExponential(3)} > ${h(50).toExponential(3)} > ${h(200).toExponential(3)}`);
  ok(leoCostPerKg(ctx0, set(A, 'starship.shipDesignLifeFlights', 10)) > leoCostPerKg(ctx0, A), 'LEO price falls with reuse life');
}

// 5. cadence: more launches per site spread the infrastructure thinner
{
  const spec = crew('Earth', 'Mars');
  const per = (c: number) => { const e = evaluate(spec, ctx0, set(A, 'starship.annualInfrastructureFlights', c)); return e.cost.infrastructure / e.totalLaunches; };
  ok(per(25) > per(100) && per(100) > per(300), `infrastructure per launch falls with cadence: ${per(25).toFixed(0)} > ${per(100).toFixed(0)} > ${per(300).toFixed(0)}`);
}

// 6. failure risk raises expected cost
{
  const spec = crew('Earth', 'Mars');
  const at = (p: number) => evaluate(spec, ctx0, set(A, 'starship.missionFailureProbability', p));
  ok(at(0.05).cost.expectedLoss > at(0.01).cost.expectedLoss && at(0.05).total > at(0.01).total && at(0.05).pMissionLoss > at(0.01).pMissionLoss, 'a higher loss probability raises expected loss, total and mission risk');
  const ship = (p: number) => evaluate({ kind: 'interstellar', crew: 2000, cargoKg: 0, route: { origin: 0, ascentKmS: 0, outKmS: 0, backKmS: 0, transitYears: 300, distanceLy: 10 } }, { ...ctx0, flags: CF.genShip, shipSpeedC: 0.03, pLossTransit: p }, A).total;
  ok(ship(0.4) > ship(0.1), 'interstellar: a riskier voyage costs more');
}

// 7. ISRU: return propellant made at the destination instead of lifted from Earth
{
  const spec = crew('Earth', 'Moon');
  const carried = evaluate({ ...spec, forceReturn: 'reuse-carried' }, ctx0, A);
  const isru = evaluate({ ...spec, forceReturn: 'reuse-isru' }, { ...ctx0, flags: ctx0.flags | CF.isruDest }, A);
  ok(carried.feasible && isru.feasible, 'both return modes are feasible to the Moon');
  ok(isru.earthLaunchedKg < carried.earthLaunchedKg && isru.tankerFlights < carried.tankerFlights, `Earth-launched mass falls: ${(isru.earthLaunchedKg / 1e3).toFixed(0)} t vs ${(carried.earthLaunchedKg / 1e3).toFixed(0)} t`);
  ok(isru.cost.propellantEarth < carried.cost.propellantEarth && isru.cost.propellantOffEarth > carried.cost.propellantOffEarth, 'Earth propellant falls, off-Earth propellant appears');
  // carrying the way home leaves less room for payload, so more ships fly; each launch wears the same hardware
  ok(isru.cost.missionHardware === carried.cost.missionHardware && near(isru.cost.hardware / isru.totalLaunches, carried.cost.hardware / carried.totalLaunches) && isru.ships <= carried.ships,
    `hardware per launch and mission hardware are untouched by where propellant is made (ships ${isru.ships} vs ${carried.ships})`);
  const expend = evaluate({ ...spec, forceReturn: 'expend' }, ctx0, A);
  ok(expend.cost.hardware > isru.cost.hardware, 'without a way home the ship is expended: hardware rises');
  const marsNo = evaluate(service('Earth', 'Mars'), ctx0, A), marsIsru = evaluate(service('Earth', 'Mars'), { ...ctx0, flags: ctx0.flags | CF.isruDest }, A);
  ok(marsIsru.total < marsNo.total && marsIsru.returnMode === 'reuse-isru', `Mars ISRU makes a passenger cheaper: $${(marsIsru.costPerPassenger / 1e6).toFixed(2)}M vs $${(marsNo.costPerPassenger / 1e6).toFixed(2)}M`);
}

// propellant is a component, not the launch cost
{
  const e = evaluate(service('Earth', 'Mars'), ctx0, A);
  ok(e.cost.propellantEarth / e.total < 0.3, `propellant is ${(100 * e.cost.propellantEarth / e.total).toFixed(1)}% of a Mars service, not all of it`);
}

// envelope, scenarios, sensitivity and Monte Carlo
{
  const spec = crew('Earth', 'Mars'), env = envelope(spec, ctx0, A);
  ok(env.low.total <= env.base.total && env.base.total <= env.high.total, 'envelope low ≤ base ≤ high');
  const opt = evaluate(spec, ctx0, scenario('optimistic')).total, con = evaluate(spec, ctx0, scenario('conservative')).total;
  ok(opt < env.base.total && env.base.total < con, 'optimistic < baseline < conservative');
  const s = sensitivity(spec, ctx0, A);
  ok(s.length > 10 && s[0].swing >= s[s.length - 1].swing, `sensitivity ranks ${s.length} inputs; top: ${s.slice(0, 3).map((x) => x.label).join('; ')}`);
  const need = ['shipBuildCost', 'shipDesignLifeFlights', 'refurbishmentPerFlight', 'annualInfrastructureFlights', 'missionFailureProbability', 'tankerPayloadKg', 'transferEfficiency', 'boiloffPerDay', 'methaneFeedstock'];
  ok(need.every((k) => s.some((x) => x.path.endsWith(k))), 'sensitivity covers build cost, reuse, refurbishment, cadence, failure, tanker payload, transfer, boil-off, commodity prices');
  const m1 = monteCarlo(spec, ctx0, A, 200, 42), m2 = monteCarlo(spec, ctx0, A, 200, 42);
  ok(m1.p10 <= m1.p50 && m1.p50 <= m1.p90 && m1.p10 >= env.low.total * 0.999 && m1.p90 <= env.high.total * 1.001 && m1.p50 === m2.p50, `seeded Monte Carlo p10 ${(m1.p10 / 1e6).toFixed(0)}M p50 ${(m1.p50 / 1e6).toFixed(0)}M p90 ${(m1.p90 / 1e6).toFixed(0)}M, repeatable, inside the envelope`);
}

// provenance: every input carries value, range, unit, class, confidence and source
{
  const rs = ranges(A);
  const okR = rs.every(([, x]) => x.unit !== undefined && x.sourceUrl && x.sourceTitle && x.sourceDate && 'RED'.includes(x.classification) && x.low <= x.base && x.base <= x.high && ['high', 'medium', 'low'].includes(x.confidence));
  ok(okR, `${rs.length} inputs carry full provenance and low ≤ base ≤ high`);
  ok(getRange(A, 'starship.shipBuildCost')!.classification !== 'R', 'build cost is not presented as reported');
}

// 8. affordability: budgets cap what one step and one ship may cost
{
  ok(stepBudget(A, 6, 1e12, 1e15, 1) < stepBudget(A, 0, 1e12, 1e15, 1), 'a collapse funds less than an expansion');
  ok(stepBudget(A, 1, 1e15, 1e9, 1) <= A.budget.capitalShare.base * 1e9, 'never more than a share of capital');
  ok(interstellarAllowance(A, 1, 1e12, 5e11) <= 5e11, 'an interstellar ship never costs more than the capital behind it');
  // a starved budget sends nobody
  const poor = new Engine(world, seed, { econ: set(A, 'budget.transportGdpShare', 1e-12) });
  while (poor.st.step < 120) poor.step();
  let crewN = 0;
  for (let i = 0; i < poor.missions.n; i++) if (KIND[poor.missions.rows[i * NMC + MC.kind]] === 'crew') crewN++;
  ok(crewN === 0, `no crewed mission without a budget (${crewN})`);
}

// 9–11. a full run: determinism, replay, sanity, reproducibility, budgets respected
{
  const SNAP = 20, checkAt = [3 * SNAP, 9 * SNAP, 40 * SNAP];
  const e = new Engine(world, seed);
  const snaps = new Map<number, SimState>();
  // instrument affordability in the engine: crew missions within the step budget; ships within their allowance
  type Priv = { budgetLeft(f: number, dt: number): number; funder(b: number): number; crewMission(b: number, to: number, crew: number, year: number, dt: number): void; spent: Float64Array };
  const P = e as unknown as Priv;
  let over = 0, crewSeen = 0;
  const cm = P.crewMission.bind(e);
  P.crewMission = (b, to, c, year, dt) => { const f = P.funder(b), left = P.budgetLeft(f, dt), before = P.spent[f]; cm(b, to, c, year, dt); const d = P.spent[f] - before; if (d > 0) crewSeen++; if (d > left * (1 + 1e-12) + 1e-6) over++; };
  while (!e.done) { if (checkAt.includes(e.st.step)) snaps.set(e.st.step, e.snapshot()); e.step(); }
  ok(over === 0 && crewSeen > 0, `${crewSeen} crewed missions, none above its polity's budget (${over} over)`);
  const R = e.missions.rows, N = e.missions.n;
  ok(N > 50, `${N} missions recorded`);
  let ships = 0, shipsOver = 0, badVals = 0, notRepro = 0, badTankers = 0, badEnv = 0;
  for (let i = 0; i < N; i++) {
    const o = i * NMC;
    for (let c = 0; c < NMC; c++) if (!Number.isFinite(R[o + c])) badVals++;
    for (const k of ['total', 'low', 'high', 'payloadKg', 'methaneKg', 'oxygenKg', 'otherPropKg', 'offEarthPropKg', 'earthLaunchedKg', 'crew', 'totalLaunches', 'tankerFlights'] as const) if (R[o + MC[k]] < 0) badVals++;
    for (const k of COST_KEYS) if (R[o + MC[`c_${k}` as keyof typeof MC]] < 0) badVals++;
    if (!Number.isInteger(R[o + MC.tankerFlights]) || !Number.isInteger(R[o + MC.tankersPerShip]) || R[o + MC.tankerFlights] > 1e5) badTankers++;
    if (!(R[o + MC.low] <= R[o + MC.total] && R[o + MC.total] <= R[o + MC.high])) badEnv++;
    const { spec, ctx } = unpackMission(R, o);
    if (evaluate(spec, ctx, A).total !== R[o + MC.total]) notRepro++;
    const kind = KIND[R[o + MC.kind]];
    if (kind === 'interstellar' || kind === 'warp') { ships++; if (!(R[o + MC.outcome] >= 0 && R[o + MC.outcome] <= 2)) shipsOver++; }
  }
  ok(badVals === 0, `no NaN, infinity or negative cost or mass in any record (${badVals})`);
  ok(badTankers === 0, `tanker counts are whole and possible (${badTankers})`);
  ok(badEnv === 0, `every record has low ≤ base ≤ high (${badEnv})`);
  ok(notRepro === 0, `every record recomputes exactly from its stored inputs (${notRepro} differ)`);
  ok(ships > 0 && shipsOver === 0, `${ships} interstellar records with valid outcomes`);
  const cols = ['transportSpend', 'transportCum', 'transportShare', 'propellantSpend', 'hardwareSpend', 'operationsSpend', 'riskSpend', 'infraSpend', 'missionHwSpend', 'serviceSpend', 'launches', 'tankerFlights', 'campaigns', 'payloadDispatched', 'peopleTransported', 'costPerKg', 'leoCostPerKg'];
  let badSeries = 0, gap = 0, cumBack = 0;
  for (let s = 0; s < e.years.length; s++) {
    const g = (k: string) => e.series[s * NGM + GM[k]];
    for (const k of cols) if (!Number.isFinite(g(k)) || g(k) < 0) badSeries++;
    const parts = g('propellantSpend') + g('hardwareSpend') + g('operationsSpend') + g('riskSpend') + g('infraSpend') + g('missionHwSpend');
    gap = Math.max(gap, Math.abs(parts - g('transportSpend')) / Math.max(1, g('transportSpend')));
    if (s > 0 && g('transportCum') < e.series[(s - 1) * NGM + GM.transportCum]) cumBack++;
  }
  ok(badSeries === 0, `transport metrics finite and non-negative (${badSeries})`);
  ok(gap < 1e-9, `the six spending groups add to transport spending (worst gap ${gap})`);
  ok(cumBack === 0, 'cumulative spending never falls');
  const last = e.years.length - 1;
  console.log(`  run: ${N} missions, $${(e.series[last * NGM + GM.transportCum] / 1e12).toFixed(1)}T spent on transport by 12,040; Earth to orbit $${e.series[GM.leoCostPerKg].toFixed(0)}/kg in 2040, $${e.series[60 * NGM + GM.leoCostPerKg].toFixed(0)}/kg in 2100`);

  // 9. determinism: the same seed gives byte-identical economic histories
  const e2 = new Engine(world, seed);
  while (!e2.done) e2.step();
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
  ok(e2.missions.n === N && same(e2.missions.rows.subarray(0, N * NMC), R.subarray(0, N * NMC)), 'second run: identical mission records');
  ok(same(e2.series, e.series), 'second run: identical series');

  // 10. snapshot replay: restore, replay, and get the same missions and totals
  for (const at of checkAt) {
    const to = at + 37, r = new Engine(world, seed);
    r.restore(snaps.get(at)!);
    while (r.st.step < to) r.step();
    const y0 = e.years[at], y1 = e.years[to];
    const pick = (x: Engine) => { const out: number[] = []; for (let i = 0; i < x.missions.n; i++) { const y = x.missions.rows[i * NMC + MC.year]; if (y >= y0 && y < y1) out.push(...x.missions.rows.subarray(i * NMC, i * NMC + MC.outcome), ...x.missions.rows.subarray(i * NMC + MC.outcome + 1, i * NMC + NMC)); } return out; };
    const a = pick(r), b = pick(e);
    ok(a.length === b.length && same(a, b), `replay ${at}→${to}: ${a.length / (NMC - 1)} missions identical`);
    ok(same(r.series.subarray((at + 1) * NGM, (to + 1) * NGM), e.series.subarray((at + 1) * NGM, (to + 1) * NGM)), `replay ${at}→${to}: series and cumulative totals identical`);
  }
  void MC_NAMES;
}

// a scenario run is deterministic too, and is priced with its own assumptions
{
  const c1 = new Engine(world, seed, { econ: scenario('conservative') }), c2 = new Engine(world, seed, { econ: scenario('conservative') });
  while (c1.st.step < 150) { c1.step(); c2.step(); }
  ok(c1.series.subarray(0, 150 * NGM).every((v, i) => Object.is(v, c2.series[i])), 'conservative scenario: deterministic');
  ok(c1.series[GM.leoCostPerKg] > new Engine(world, seed).series[GM.leoCostPerKg], 'conservative scenario: reaching orbit costs more than under baseline');
}

console.log(bad ? `${bad} of ${n} economics checks failed` : `economics: all ${n} checks ok`);
process.exit(bad ? 1 : 0);
