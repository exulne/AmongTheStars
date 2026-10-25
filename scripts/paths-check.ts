// Checker for the "what leads to…?" path machinery: parses plain-language
// goals, runs futures to them headless, prints the roads it found.
//   node scripts/paths-check.ts
import { Engine, YEAR0 } from '../src/sim/engine.ts';
import { STAGE, TECHS } from '../src/sim/catalog.ts';
import { EV } from '../src/sim/catalog.ts';
import { buildWorld } from '../src/sim/world.ts';
import { ChainTracker, chainFrom, chainLabel, chainOf, chainParts, compareFutures, countLine, goalYear, huntLine, lineageSeeds, narrateOverview, parseEvent, parseGoal, reached, resultOf, tagLabel, toolSummary, type FutureResult, type Goal } from '../src/sim/milestones.ts';

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
  const r = parseEvent(bad, world);
  if ('error' in r) ok(`"${bad}" -> error: ${r.error} (try: ${r.suggestions.join(', ')})`);
  else fail(`"${bad}" should not parse, got ${JSON.stringify(r.goal)}`);
}

// ------------------------------------------------------------------ countLine / huntLine

console.log('\ncountLine / huntLine');
const eq = (name: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) ? ok(`${name}: ${JSON.stringify(got)}`) : fail(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
eq('countLine 6', countLine(6, 16, 'the colonisation of Mars'), '6 futures from 16 simulated lead to the colonisation of Mars.');
eq('countLine 1', countLine(1, 16, 'the colonisation of Mars'), '1 future from 16 simulated leads to the colonisation of Mars.');
eq('countLine 0 near', countLine(0, 16, 'the colonisation of Mars', { near: 'Mars was never settled' }), '0 futures from 16 simulated lead to the colonisation of Mars. The closest: Mars was never settled.');
eq('countLine live 4', countLine(4, 9, 'the colonisation of Mars', { live: true }), '4 futures from 9 simulated so far lead to the colonisation of Mars.');
eq('countLine live 1', countLine(1, 9, 'the colonisation of Mars', { live: true }), '1 future from 9 simulated so far leads to the colonisation of Mars.');
eq('huntLine 3', huntLine(3, 16), 'Found 3 other futures (from 16 more simulated).');
eq('huntLine 1', huntLine(1, 16), 'Found 1 other future (from 16 more simulated).');
eq('huntLine 0', huntLine(0, 16), 'Found 0 other futures (from 16 more simulated).');

console.log('\nlineageSeeds');
const today = [1];
for (let k = 1; today.length < 16; k++) { const s = ((1 + k * 7919) % 99991) + 1; if (s !== 1) today.push(s); }
eq('lineage 16', lineageSeeds(1, 0, 16).seeds, today);
const b1 = lineageSeeds(1, 0, 16), b2 = lineageSeeds(1, b1.nextK, 40);
eq('batch sizes', [b1.seeds.length, b2.seeds.length], [16, 40]);
eq('no repeats across batches', new Set([...b1.seeds, ...b2.seeds]).size, 56);
const u = new Set(b2.seeds.slice(0, 3));
const b3 = lineageSeeds(1, b1.nextK, 40, u);
if (b3.seeds.length !== 40) fail(`used batch returned ${b3.seeds.length}, want 40`);
else if (b3.seeds.some((s) => u.has(s))) fail('used batch kept a used seed');
else ok('used batch skips 3 seeds, still returns 40');

// ------------------------------------------------------------------ chainFrom / chainParts

console.log('\nchains');
const gA = parseGoal('first dyson swarm', world) as { goal: Goal };
const gB = parseGoal('terraforming venus', world) as { goal: Goal };
const gC = parseGoal('colonisation of mars', world) as { goal: Goal };
{
  eq('chainFrom then', chainFrom([gA.goal, gB.goal], ['then']).stages.length, 2);
  eq('chainFrom and', chainFrom([gA.goal, gB.goal], ['and']).stages, [[gA.goal, gB.goal]]);
  eq('chainFrom and,then', chainFrom([gA.goal, gB.goal, gC.goal], ['and', 'then']).stages.map((s) => s.length), [2, 1]);
  const cp = chainParts(chainFrom([gA.goal, gB.goal, gC.goal], ['and', 'then']));
  eq('chainParts round-trip', [cp.goals.length, cp.joints.join(',')], [3, 'and,then']);
  eq('chainParts inverse', chainFrom(cp.goals, cp.joints).stages.map((s) => s.length), [2, 1]);
  eq('chainLabel', chainLabel(chainFrom([gA.goal, gB.goal], ['then'])), 'the first Dyson swarm and then a breathable Venus');
  eq('chainLabel and', chainLabel(chainFrom([gC.goal, gB.goal], ['and'])), 'the colonisation of Mars and a breathable Venus');
}

// ------------------------------------------------------------------ parseEvent: galaxies, typos, refusals, 2040

console.log('\nparseEvent');
const pe = (text: string) => parseEvent(text, world);
const peOk = (text: string, want: string) => {
  const r = pe(text);
  if ('error' in r) fail(`"${text}" -> ${r.error}`);
  else {
    const tl = tagLabel(r.goal);
    if (tl !== want) fail(`"${text}" -> "${tl}", want "${want}"`);
    else ok(`"${text}" -> ${tl}${r.notes ? ` [${r.notes.join('; ')}]` : ''}`);
  }
  return r;
};
{
  peOk('settle on andromeda', 'First colony in Andromeda');
  peOk('colonise andromeda', 'First colony in Andromeda');
  peOk('a colony in the andromeda galaxy', 'First colony in Andromeda');
  peOk('reach andromeda', 'First settlement in Andromeda');
  peOk('humans in andromeda', 'First settlement in Andromeda');
  peOk('andromeda', 'First settlement in Andromeda');
  peOk('city in andromeda', 'First city in Andromeda');
  peOk('another galaxy', 'First settlement in another galaxy');
  peOk('beyond the milky way', 'First settlement in another galaxy');
  peOk('m31', 'First settlement in Andromeda');
  const t1 = peOk('coionise andromeda', 'First colony in Andromeda');
  if ('goal' in t1 && t1.notes?.[0] === 'read "coionise" as "colonise"') ok(`note: ${t1.notes[0]}`);
  else fail(`coionise note: ${JSON.stringify(t1)}`);
  const t2 = peOk('andromda', 'First settlement in Andromeda');
  if ('goal' in t2 && t2.notes?.length) ok(`note: ${t2.notes[0]}`);
  else fail(`andromda note: ${JSON.stringify(t2)}`);
  const e1 = pe('settle on xyzzy');
  if ('error' in e1 && e1.error.includes('xyzzy')) ok(`xyzzy error: ${e1.error}`);
  else fail(`xyzzy: ${JSON.stringify(e1)}`);
  const e2 = pe('ware');
  if ('error' in e2 && /Did you mean/.test(e2.error)) ok(`ware refused: ${e2.error}`);
  else fail(`ware: ${JSON.stringify(e2)}`);
  const e3 = pe('first dyson sphere then terraform venus');
  if ('error' in e3 && /One event per tag/.test(e3.error)) ok(`connector: ${e3.error}`);
  else fail(`connector: ${JSON.stringify(e3)}`);
  const e4 = pe('milky way');
  if ('error' in e4 && /Milky Way/.test(e4.error)) ok(`milky way: ${e4.error}`);
  else fail(`milky way: ${JSON.stringify(e4)}`);
  const e5 = pe('colonise mars ross');
  if ('error' in e5 && e5.error.includes('ross')) ok(`ross named: ${e5.error}`);
  else fail(`ross: ${JSON.stringify(e5)}`);
  peOk('first colony', 'First colony beyond Earth');
  const a1 = pe('a billion people');
  if ('error' in a1 && /already true in 2040/.test(a1.error)) ok(`people: ${a1.error}`);
  else fail(`billion people: ${JSON.stringify(a1)}`);
  const a2 = pe('mars');
  if ('error' in a2 && /already true in 2040/.test(a2.error)) ok(`mars: ${a2.error}`);
  else fail(`mars: ${JSON.stringify(a2)}`);
  for (const chip of ['Colonisation of Mars', 'Terraforming Venus', 'First Dyson swarm', 'Mind uploading', 'First contact', 'A trillion people']) {
    const r = pe(chip);
    if ('error' in r) fail(`chip "${chip}": ${r.error}`); else ok(`chip "${chip}" -> ${tagLabel(r.goal)}`);
  }
}

// probe regression phrases: all parse through parseEvent, no error, no notes
{
  const want: Record<string, string> = {
    'an uploaded world': 'the first uploaded world beyond Earth',
    'cryo hibernation': 'Cryogenic suspension',
    'quantum computers': 'Fault-tolerant quantum computing',
  };
  const phrases = ['an uploaded world', 'cryo hibernation', 'cryosleep', 'colonisation of titan', 'self-replicating probes',
    'a ring world', 'a brain star', 'a lifted star', 'swarm world', 'matrioshka brain', 'beyond the milky way',
    'humans in andromeda', 'a metropolis on mars', 'a megastructure', 'bishop rings', 'generation ships', 'light sails',
    'quantum computers', 'neural lace', 'asteroid mining', 'space elevator', "o'neill cylinders", 'first footprint on titan',
    'boots on europa', 'a trillion people', 'kardashev 2', 'type ii civilisation', 'ten star systems',
    'colonise another star', 'independence of mars', 'the first war'];
  for (const ph of phrases) {
    const r = pe(ph);
    if ('error' in r) fail(`probe "${ph}" -> ${r.error}`);
    else if (r.notes?.length) fail(`probe "${ph}" spurious notes: ${r.notes.join('; ')}`);
    else if (want[ph] && r.goal.label !== want[ph]) fail(`probe "${ph}" -> "${r.goal.label}", want "${want[ph]}"`);
    else ok(`"${ph}" -> ${r.goal.label}`);
  }
}

// galaxy goals are never true at step 0
{
  let all = true;
  for (const gal of ['Andromeda', 'Triangulum', 'Large Magellanic Cloud', 'Small Magellanic Cloud', '*']) {
    for (const stage of [1, STAGE.COLONY]) {
      const g: Goal = { id: `t:${gal}:${stage}`, label: gal, detail: '', kind: 'stage', galaxy: gal, stage };
      for (let seed = 1; seed <= 5; seed++) {
        const e = new Engine(world, seed); e.ledger = null;
        if (reached(g, e)) { fail(`galaxy ${gal} stage ${stage} true at step 0 (seed ${seed})`); all = false; }
      }
    }
  }
  if (all) ok('all galaxy goals false at step 0, seeds 1-5');
}

// ------------------------------------------------------------------ chains: brute-force cross-check
// Every chain's tracker is driven step-by-step alongside an independent
// recomputation from recorded truth/event tables.

interface Evt { idx: number; year: number }
const pool: Goal[] = [];
const gp = (text: string): Goal => { const r = parseGoal(text, world); if ('error' in r) { fail(`pool goal "${text}": ${r.error}`); return chainOf(r as never).stages[0][0]; } return r.goal; };
const gMars = gp('colonisation of mars');
const gVenus = gp('terraforming venus');
const gDyson = gp('first dyson swarm');
const gWar = gp('the first war');
const gContact = gp('first contact');
const gTrillion = gp('a trillion people');
const gTitan = gp('city on titan');
const gUpload = gp('mind uploading');
const gMoon = gp('a city on the moon');
const gMoonBase = gp('a base on the moon');
const gMarsPop = gp('a million people on mars');
const gVenusPop = gp('a billion people on venus');
const gEarth10B = gp('ten billion people on earth');
const gIndep = gp('independence');
const gAnyGal = gp('another galaxy');
const gTri: Goal = { id: 'gal:tri', label: 'the first settlement in Triangulum', detail: '', kind: 'stage', galaxy: 'Triangulum', stage: 1 };
const gLmc: Goal = { id: 'gal:lmc', label: 'the first settlement in the Large Magellanic Cloud', detail: '', kind: 'stage', galaxy: 'Large Magellanic Cloud', stage: 1 };
const gSmc: Goal = { id: 'gal:smc', label: 'the first settlement in the Small Magellanic Cloud', detail: '', kind: 'stage', galaxy: 'Small Magellanic Cloud', stage: 1 };
pool.push(gMars, gVenus, gDyson, gWar, gContact, gTrillion, gTitan, gUpload, gMoon, gMoonBase, gMarsPop, gVenusPop, gEarth10B, gIndep, gAnyGal, gTri);
const gi = new Map<string, number>(pool.map((g, i) => [g.id, i]));
const poolOk = pool.every((g) => g && g.kind);

if (poolOk) {
  const chains: Chain[] = [
    chainFrom([gMars, gTrillion, gDyson], ['and', 'then']),          // then + and mix
    chainFrom([gDyson, gWar], ['then']),                            // event part in a later stage; wars before it opened must not count
    chainFrom([gWar, gContact, gMars], ['and', 'then']),            // two event parts in one chain
    chainFrom([gVenus, gDyson], ['then']),                          // permanent goal true before its stage opened → already
    chainFrom([gTitan, gMoon], ['then']),                           // lasting goal possibly true-then-ended before open
    chainFrom([gDyson, gMoonBase], ['then']),                       // moon bases come and go — true-then-ended before open
    chainFrom([gVenus, gMarsPop], ['then']),                        // Mars pop could dip before Venus breathes
    chainFrom([gVenusPop, gEarth10B], ['then']),                    // Earth pop oscillates — true-then-ended before open
    chainFrom([gMars, gVenus, gUpload], ['then', 'and']),           // 3-part chain
    chainFrom([gDyson, gVenus], ['then']),                          // two-stage chain
    chainFrom([gWar, gIndep], ['and']),                             // two event parts, one stage
    chainOf(gTri),                                                // named-galaxy endpoint (miss wording)
    chainOf(gAnyGal),                                               // galaxy endpoint run
  ];

  const cover = { andThenMix: false, earlierEvent: false, twoEvents: false, ended: false, already: false };
  const coverBy: string[] = [];

  for (const seed of [1, 2, 3]) {
    const e = new Engine(world, seed);
    e.ledger = null;
    const trs = chains.map((c) => new ChainTracker(c, e));
    const galTrs = [gTri, gLmc, gSmc].map((g) => new ChainTracker(chainOf(g), e));
    // per-step tables for independent recomputation
    const truthT: boolean[][] = pool.map(() => []);
    const gyT: number[][] = pool.map(() => []);
    const evLen: number[] = [e.events.length];
    const evHits: Evt[][] = pool.map(() => []);
    for (let i = 0; i < pool.length; i++) { truthT[i][0] = pool[i].kind !== 'event' && reached(pool[i], e); gyT[i][0] = goalYear(pool[i], e); }
    while (!e.done) {
      const before = e.events.length;
      e.step();
      const t = e.st.step;
      for (const tr of trs) tr.check(before);
      for (const tr of galTrs) tr.check(before);
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        if (g.kind !== 'event') { truthT[i][t] = reached(g, e); gyT[i][t] = goalYear(g, e); }
        else for (let j = before; j < e.events.length; j++) {
          const ev = e.events[j];
          if (ev.type === g.event && (g.body === undefined || ev.body === g.body)) evHits[i].push({ idx: j, year: ev.year });
        }
      }
      evLen[t] = e.events.length;
    }
    const maxT = e.st.step;

    // independent recomputation of each chain from the tables
    for (const [ci, chain] of chains.entries()) {
      const tr = trs[ci];
      const stages = chain.stages;
      const hits: ({ year: number; step: number; already: boolean } | null)[][] = stages.map((s) => s.map(() => null));
      const openStep = [0], openYear = [YEAR0 + e.years[0]];
      const marks = stages.map((s) => s.map(() => 0));
      const truthPrev = stages.map((s) => s.map((g) => truthT[gi.get(g.id)!][0]));
      let stage = 0, done = false, cStep = 0;
      for (let t = 1; t <= maxT && !done; t++) {
        for (;;) {
          let all = true;
          for (let i = 0; i < stages[stage].length; i++) {
            if (hits[stage][i]) continue;
            const g = stages[stage][i];
            if (g.kind === 'event') {
              const h = evHits[gi.get(g.id)!].find((x) => x.idx >= marks[stage][i] && x.idx < evLen[t]);
              if (h) hits[stage][i] = { year: YEAR0 + h.year, step: t, already: false };
              else all = false;
            } else if (truthT[gi.get(g.id)!][t]) {
              const already = stage > 0 && t === openStep[stage] && truthPrev[stage][i];
              hits[stage][i] = { year: already ? openYear[stage] : Math.max(YEAR0 + gyT[gi.get(g.id)!][t], openYear[stage]), step: t, already };
            } else all = false;
          }
          if (!all) break;
          if (stage + 1 < stages.length) {
            // coverage probes, at the moment stage+1 opens (step t)
            stage++;
            openStep[stage] = t;
            openYear[stage] = Math.max(...hits[stage - 1].map((h) => h!.year));
            for (let i = 0; i < stages[stage].length; i++) {
              const g = stages[stage][i];
              if (g.kind === 'event') {
                marks[stage][i] = evLen[t - 1] ?? 0;
                if (evHits[gi.get(g.id)!].some((x) => x.idx < marks[stage][i])) { cover.earlierEvent = true; coverBy.push(`case2 chain${ci} seed${seed}`); }
              } else {
                const k = gi.get(g.id)!;
                let wasTrue = false;
                for (let kx = 0; kx < t - 1; kx++) if (truthT[k][kx]) { wasTrue = true; break; }
                if (wasTrue && !truthT[k][t - 1]) { cover.ended = true; coverBy.push(`case4 chain${ci} seed${seed}`); }
              }
            }
          } else { done = true; cStep = t; break; }
        }
        for (let s = 0; s < stages.length; s++) for (let i = 0; i < stages[s].length; i++) {
          const g = stages[s][i];
          if (g.kind !== 'event') truthPrev[s][i] = truthT[gi.get(g.id)!][t];
        }
      }
      // coverage flags
      if (stages.some((s, si) => s.some((g, gi) => hits[si][gi]?.already && (g.kind === 'tech' || g.kind === 'swarm')))) { cover.already = true; coverBy.push(`case5 chain${ci} seed${seed}`); }
      if (stages.some((s) => s.length > 1) && stages.length > 1) { cover.andThenMix = true; }
      {
        let evHits_ = 0;
        for (let si = 0; si < stages.length; si++) for (let gi2 = 0; gi2 < stages[si].length; gi2++) {
          if (stages[si][gi2].kind === 'event' && hits[si][gi2]) evHits_++;
        }
        if (evHits_ >= 2) { cover.twoEvents = true; coverBy.push(`case3 chain${ci} seed${seed}`); }
      }

      // compare with the live tracker
      const fmtH = (hs: ({ year?: number; step?: number; already?: boolean } | null)[][]) => JSON.stringify(hs.map((s) => s.map((h) => h ? [h.year, h.step, h.already] : null)));
      const got = { hits: fmtH(tr.hits), done: tr.done, step: tr.completedStep };
      const want = { hits: fmtH(hits as never), done, step: cStep };
      if (JSON.stringify(got) !== JSON.stringify(want)) fail(`chain${ci} seed${seed}: tracker ${JSON.stringify(got)} != recomputed ${JSON.stringify(want)}`);
      else ok(`chain${ci} seed${seed}: ${chainLabel(chain)} → done=${done} step=${cStep}`);
      // eyeball the result
      const res = resultOf(chain, e, tr);
      if (ci < 4) console.log(`    ${chainLabel(chain)}: ${res.reached ? res.year : 'miss'} parts=${JSON.stringify(res.parts.map((p) => [p.label, p.year ?? '-', p.already ?? '']))}${res.progress ? ` | ${res.progress}` : ''}`);
    }
    // galaxy endpoint: reached on seed 2 only, never before wormholes
    {
      const tr = trs[trs.length - 1];
      const worm = YEAR0 + e.st.techDone[TECHS.findIndex((t) => t.id === 'wormholes')];
      if (seed === 2) {
        if (!tr.done || tr.completionYear() < worm) fail(`any-galaxy seed2: done=${tr.done} year=${tr.done ? tr.completionYear() : '-'} wormholes=${worm}`);
        else ok(`any-galaxy seed2 reached ${tr.completionYear()} >= wormholes ${worm}`);
      } else if (tr.done) fail(`any-galaxy seed${seed} reached ${tr.completionYear()}`);
      else {
        const res = resultOf(chains[chains.length - 1], e, tr);
        if (res.progress !== 'traversable wormholes were never invented') fail(`any-galaxy seed${seed} miss note: ${res.progress}`);
        else ok(`any-galaxy seed${seed} never reached | ${res.progress}`);
      }
    }
    for (const [gi2, g] of [gTri, gLmc, gSmc].entries()) {
      const tr = galTrs[gi2];
      if (tr.done) { ok(`${g.galaxy} seed${seed} reached ${tr.completionYear()}`); continue; }
      const res = resultOf(chainOf(g), e, tr);
      const inv = res.progress === 'traversable wormholes were never invented';
      const named = new RegExp(`^traversable wormholes came in \\d+, but (${g.galaxy === 'Large Magellanic Cloud' || g.galaxy === 'Small Magellanic Cloud' ? `the ${g.galaxy}` : g.galaxy} was never settled|nowhere in ${g.galaxy === 'Large Magellanic Cloud' || g.galaxy === 'Small Magellanic Cloud' ? `the ${g.galaxy}` : g.galaxy} passed)`).test(res.progress ?? '');
      if (inv || named) ok(`${g.galaxy} seed${seed} miss | ${res.progress}`);
      else fail(`${g.galaxy} seed${seed} miss note: ${res.progress}`);
    }
  }
  if (!cover.andThenMix) fail('case1 (and+then mix) never exercised');
  if (!cover.earlierEvent) fail('case2 (earlier event ignored) never exercised');
  if (!cover.twoEvents) fail('case3 (two event parts) never exercised');
  if (!cover.ended) fail('case4 (true-then-ended before open) never exercised');
  if (!cover.already) fail('case5 (permanent already-true) never exercised');
  console.log('  coverage:', Object.entries(cover).map(([k, v]) => `${k}=${v}`).join(' '), '|', coverBy.slice(0, 6).join('; '));
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
    const chain = chainOf(goal);
    const tr = new ChainTracker(chain, e);
    const t0 = performance.now();
    while (!e.done && !tr.done) tr.advance();
    const r = resultOf(chain, e, tr);
    const hit = tr.done;
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
  const cmp = compareFutures(chainOf(goal), results);
  console.log(`  compare: median ${cmp.medianYear} min ${cmp.minYear} max ${cmp.maxYear}`);
  for (const [seed, h] of cmp.highlights) console.log(`    future ${seed}: ${h}`);
  console.log(`  narrated: ${narrateOverview(chainOf(goal), results, 3)}`);
  console.log('  toolSummary:');
  for (const l of toolSummary(chainOf(goal), results, 3).split('\n')) console.log(`    ${l}`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall checks passed');
process.exit(fails ? 1 : 0);
