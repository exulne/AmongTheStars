// Checker for the "what leads to…?" path machinery: parses plain-language
// goals, runs futures to them headless, prints the roads it found.
//   node scripts/paths-check.ts
import { Engine, YEAR0 } from '../src/sim/engine.ts';
import { STAGE, TECHS } from '../src/sim/catalog.ts';
import { EV } from '../src/sim/catalog.ts';
import { buildWorld } from '../src/sim/world.ts';
import { compareFutures, narrateOverview, parseGoal, reached, resultOf, toolSummary, type FutureResult, type Goal } from '../src/sim/milestones.ts';

let fails = 0;
const fail = (m: string) => { fails++; console.log('  FAIL', m); };
const ok = (m: string) => console.log('  ok', m);

const world = buildWorld();
const bId = (n: string) => world.bodies.find((b) => b.name === n)!.id;

// ------------------------------------------------------------------ parse

const cases: [string, (g: Goal) => boolean | string][] = [
  ['colonisation of mars', (g) => g.kind === 'stage' && g.stage === STAGE.COLONY && g.body === bId('Mars') || `got ${JSON.stringify(g)}`],
  ['terraform of venus', (g) => g.kind === 'terraform' && g.level === 3 && g.body === bId('Venus') || `got ${JSON.stringify(g)}`],
  ['first dyson sphere construction', (g) => g.kind === 'swarm' && g.phase === 1 && g.system === undefined || `got ${JSON.stringify(g)}`],
  ['dyson swarm phase 2', (g) => g.kind === 'swarm' && g.phase === 2 || `got ${JSON.stringify(g)}`],
  ['colonise tau ceti e', (g) => g.kind === 'stage' && g.body === bId('Tau Ceti e') && g.stage === STAGE.COLONY || `got ${JSON.stringify(g)}`],
  ['city on titan', (g) => g.kind === 'stage' && g.body === bId('Titan') && g.stage === STAGE.CITY || `got ${JSON.stringify(g)}`],
  ['matrioshka brain', (g) => g.kind === 'tech' && TECHS[g.tech!].id === 'matrioshka' || `got ${JSON.stringify(g)}`],
  ['warp drive', (g) => g.kind === 'tech' && TECHS[g.tech!].id === 'warp' || `got ${JSON.stringify(g)}`],
  ['first contact', (g) => g.kind === 'event' && g.event === EV['First contact'] || `got ${JSON.stringify(g)}`],
  ['a trillion people', (g) => g.kind === 'metric' && g.metric === 'pop' && g.threshold === 1e12 || `got ${JSON.stringify(g)}`],
  ['kardashev 2', (g) => g.kind === 'metric' && g.metric === 'kardashev' && g.threshold === 2 || `got ${JSON.stringify(g)}`],
  ['a million people on mars', (g) => g.kind === 'pop' && g.body === bId('Mars') && g.threshold === 1e6 || `got ${JSON.stringify(g)}`],
];

console.log('parseGoal');
for (const [text, test] of cases) {
  const r = parseGoal(text, world);
  if ('error' in r) fail(`"${text}" -> error: ${r.error}`);
  else {
    const t = test(r.goal);
    if (t === true) ok(`"${text}" -> ${r.goal.label}`);
    else fail(`"${text}" -> ${t}`);
  }
}
for (const bad of ['terraform jupiter', 'banana']) {
  const r = parseGoal(bad, world);
  if ('error' in r) ok(`"${bad}" -> error: ${r.error} (try: ${r.suggestions.join(', ')})`);
  else fail(`"${bad}" should not parse, got ${JSON.stringify(r.goal)}`);
}

// ------------------------------------------------------------------ run futures to the goals
// Probe values (calendar years), engines with no war minds and no ledger:
const PROBE: Record<string, number[]> = {
  'colonisation of mars': [2056, 2085, 2053],
  'terraform of venus': [2552, 2612, 2676],
  'first dyson sphere construction': [2388, 2388, 2396],
};

console.log('\npaths');
for (const [goalText, expected] of Object.entries(PROBE)) {
  const pr = parseGoal(goalText, world);
  if ('error' in pr) { fail(`goal "${goalText}" did not parse`); continue; }
  const goal = pr.goal;
  const results: FutureResult[] = [];
  for (const seed of [1, 2, 3]) {
    const e = new Engine(world, seed);
    e.ledger = null;
    let hit = false;
    const t0 = performance.now();
    while (!e.done && !hit) { e.step(); hit = reached(goal, e); }
    const r = resultOf(goal, e, hit);
    results.push(r);
    const ms = (performance.now() - t0).toFixed(0);
    const exp = expected[seed - 1];
    if (!r.reached) { fail(`"${goalText}" seed ${seed}: never reached (${ms}ms) — ${r.progress}`); continue; }
    if (r.year !== exp) fail(`"${goalText}" seed ${seed}: year ${r.year} != probe ${exp} (${ms}ms)`);
    else ok(`"${goalText}" seed ${seed}: reached in ${r.year} after step ${r.step} (${ms}ms)`);
    const s = r.steps;
    if (!s.length) fail(`seed ${seed}: empty path`);
    if (s.length > 12) fail(`seed ${seed}: ${s.length} steps > 12`);
    for (let i = 1; i < s.length; i++) if (s[i].year < s[i - 1].year) fail(`seed ${seed}: unsorted at ${s[i].year}`);
    const last = s[s.length - 1];
    if (last.kind !== 'goal' || last.year !== r.year) fail(`seed ${seed}: last step "${last.text}" @${last.year} is not the goal @${r.year}`);
    for (const st of s) if (st.year > r.year!) fail(`seed ${seed}: step "${st.text}" @${st.year} after goal @${r.year}`);
    console.log(`  -- seed ${seed} road to ${goal.label}:`);
    for (const st of s) console.log(`       ${st.year}  ${st.kind.padEnd(9)} ${st.text}`);
  }
  const cmp = compareFutures(goal, results);
  console.log(`  compare: median ${cmp.medianYear} min ${cmp.minYear} max ${cmp.maxYear}`);
  for (const [seed, h] of cmp.highlights) console.log(`    future ${seed}: ${h}`);
  console.log(`  narrated: ${narrateOverview(goal, results, 3)}`);
  console.log('  toolSummary:');
  for (const l of toolSummary(goal, results, 3).split('\n')) console.log(`    ${l}`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall checks passed');
process.exit(fails ? 1 : 0);
