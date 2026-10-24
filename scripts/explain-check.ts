// Check every explainer in Node: build the views headless (canvas stubbed),
// run one future, then explain samples of every registered kind and check the
// cards are deterministic, complete and agree with what is drawn.
//   node --experimental-strip-types scripts/explain-check.ts [seed] [year] [--print]

// ---- browser stubs: the views draw textures into canvases at startup
const ctx2d: any = new Proxy({}, {
  get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient') ? () => ({ addColorStop() {} })
    : (k === 'createImageData' || k === 'getImageData') ? (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w, height: h })
    : () => {},
  set: () => true,
});
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) };
(globalThis as any).window = { devicePixelRatio: 1 };

const THREE = await import('three');
const { Engine } = await import('../src/sim/engine.ts');
const { F, NF } = await import('../src/sim/metrics.ts');
const { buildWorld } = await import('../src/sim/world.ts');
const views = await import('../src/view/views.ts');
const reg = await import('../src/explain/registry.ts');
const { Lives } = await import('../src/sim/lives.ts');
const { EV } = await import('../src/sim/catalog.ts');
const { specColor } = await import('../src/view/textures.ts');
const { STAGE, STAGE_NAMES } = await import('../src/sim/catalog.ts');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seed = Number(args[0] ?? 1), atYear = Number(args[1] ?? 2500);
const PRINT = process.argv.includes('--print');

const world = buildWorld();
const e = new Engine(world, seed);
while (!e.done) e.step();
const step = Math.max(0, e.years.findIndex((y) => y >= atYear - 2040));
// replay to the step we want a snapshot of
const r = new Engine(world, seed);
r.logEvents = false;
while (r.st.step < step) r.step();
const settled = Int32Array.from(r.st.settled.slice(0, r.st.nSettled));
const snap: any = { type: 'state', id: 0, step, S: Float64Array.from(r.st.S), techDone: Float64Array.from(r.st.techDone), techWhere: Float64Array.from(r.st.techWhere), ships: r.shipList(), globals: r.globals(), settled };
const year = r.years[step];
console.log(`seed ${seed}, year ${2040 + Math.round(year)}: ${settled.length} settled bodies, ${snap.ships.length} ships in transit`);

let fails = 0;
const fail = (msg: string) => { fails++; if (fails < 40) console.log('FAIL', msg); };

// ---- build every view the way main.ts does
const camera = new THREE.PerspectiveCamera(50, 1.6, 0.01, 1e7);
const controls: any = { target: new THREE.Vector3(), update() {} };
const scene = new THREE.Scene();
const sky = views.makeSky(1, 7000, 'sky');
scene.add(sky);
const ctx: any = { world, snap, year, camera, controls, system: 0, body: world.earth, city: 0, selected: null, t: 1, tm: 1, colorBy: 'stage' };
const V: Record<string, any> = {
  universe: new views.UniverseView(world), galaxy: new views.GalaxyView(world), local: new views.LocalView(world),
  system: new views.SystemView(), planet: new views.PlanetView(),
};
for (const v of Object.values(V)) scene.add(v.group);

const exc = { world, snap, year };
const kindsSeen = new Set<string>();
function checkCard(kind: string, i: number): any {
  const a = reg.explain(kind, i, exc), b = reg.explain(kind, i, exc);
  if (!a) { fail(`${kind}#${i}: no explanation`); return null; }
  kindsSeen.add(kind);
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) fail(`${kind}#${i}: not deterministic`);
  if (/NaN|undefined|Infinity|\[object/.test(ja)) fail(`${kind}#${i}: bad value in ${ja.slice(0, 400)}`);
  if (!a.title || !a.lede || !a.eyebrow) fail(`${kind}#${i}: missing title/lede/eyebrow`);
  if (!a.facts.length) fail(`${kind}#${i}: no facts`);
  for (const f of a.facts) if (!['R', 'E', 'P'].includes(f.t) || !f.k || f.v === '') fail(`${kind}#${i}: bad fact ${JSON.stringify(f)}`);
  const n = reg.explainName(kind, i, exc);
  if (!n || /NaN|undefined/.test(n)) fail(`${kind}#${i}: bad name ${n}`);
  return a;
}
const show = (a: any) => { if (!PRINT || !a) return; console.log(`\n  [${a.eyebrow}] ${a.title}\n  ${a.lede}`); for (const f of a.facts) console.log(`    ${f.k}: ${f.v} [${f.t}]`); if (a.why) console.log(`  why: ${a.why}`); };
const count = (p: any) => p.geometry.attributes.position.count;

// ---- galaxy: stars, colour ↔ class agreement, links to sim systems, knots, dust, nebulae, core
{
  const g = V.galaxy; g.sync(ctx);
  const data = (g.group.children[0] as any).userData.galaxy;
  const n = count(data.stars);
  const col = data.stars.geometry.attributes.color.array as Float32Array;
  let hueOk = 0, hueN = 0, linked = 0, knots = 0;
  const t0 = performance.now();
  for (let k = 0; k < 4000; k++) {
    const i = Math.floor(reg.h01(k, 5) * n);
    const card = checkCard('starg', i);
    if (!card) continue;
    if (k < 3) show(card);
    const type = card.facts.find((f: any) => f.k === 'Type')?.v as string | undefined;
    if (card.eyebrow.startsWith('Star system')) { linked++; continue; }
    if (card.eyebrow.startsWith('Star-forming')) { knots++; continue; }
    // the class letter's colour must be the nearest (or next-nearest) class colour to the dot's own hue
    const m = Math.max(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
    const dist = (L: string) => { const c = specColor(L), w = Math.max(c.r, c.g, c.b); return Math.hypot(col[i * 3] / m - c.r / w, col[i * 3 + 1] / m - c.g / w, col[i * 3 + 2] / m - c.b / w); };
    const ranked = [...'OBAFGKM'].sort((x, y) => dist(x) - dist(y));
    hueN++;
    if (ranked.slice(0, 2).includes(type![0])) hueOk++; else if (hueN - hueOk < 12) console.log('  off-hue dot', i, type, ranked.join(''), data.meta[i].toString(16));
  }
  console.log(`galaxy stars: 4000 cards in ${(performance.now() - t0).toFixed(0)} ms; class colour matches the dot's hue ${hueOk}/${hueN}; ${knots} nebula knots`);
  if (hueOk < hueN) fail('galaxy star colour and class disagree');
  // every linked particle names its sim system
  let k = 0;
  for (let i = 0; i < n && k < 20; i++) {
    if (((data.meta[i] >> 8) & 15) !== 15) continue;
    k++; linked++;
    const card = checkCard('starg', i);
    if (card && !card.links?.length) fail(`starg#${i}: linked particle without a system link`);
    if (k === 1) show(card);
  }
  console.log(`galaxy: ${linked} linked particles checked`);
  for (let i = 0; i < count(data.dust); i += 97) { const c = checkCard('dustg', i); if (i === 0) show(c); }
  for (let i = 0; i < data.nebulae.length; i++) { const c = checkCard('nebg', i); if (i < 2) show(c); }
  show(checkCard('coreg', 0));
  const hii = [...Array(n).keys()].filter((i) => data.meta[i] & 32).slice(0, 3);
  for (const i of hii) show(checkCard('starg', i));
  // SelectAs for settled nearby systems
  const near = reg.explainerFor('neargal')!;
  const s = near.selectAs!(0, exc);
  if (!s || s.kind !== 'system') fail('neargal does not resolve to a system');
}

// ---- universe: Local Group galaxies' stars and the background galaxies
{
  V.universe.sync(ctx);
  for (let gi = 0; gi < 5; gi++) {
    const kind = `staru${gi}`;
    if (!reg.explainerFor(kind)) { fail(`${kind} not registered`); continue; }
    for (let i = 0; i < 300; i++) { const c = checkCard(kind, i * 37); if (i === 0 && gi === 3) show(c); }
    checkCard(`coreu${gi}`, 0);
    for (let i = 0; i < 70; i++) checkCard(`nebu${gi}`, i);
  }
  const bg = reg.explainerFor('bgal')!;
  let el = 0;
  for (let i = 0; i < 520; i++) { const c = checkCard('bgal', i); if (c?.facts[0].v.includes('elliptical')) el++; if (i < 2) show(c); }
  console.log(`universe: 520 background galaxies, ${el} elliptical`);
  void bg;
}

// ---- sky: the dot's class letter must match the class drawn
{
  const pts = sky.children[0] as any;
  const col = pts.geometry.attributes.color.array as Float32Array;
  let ok = 0;
  for (let i = 0; i < 7000; i += 7) {
    const c = checkCard('sky', i);
    if (!c) continue;
    if (i < 14) show(c);
    const letter = (c.facts[0].v as string)[0];
    const want = specColor(letter);
    const r0 = col[i * 3], g0 = col[i * 3 + 1], b0 = col[i * 3 + 2], m = Math.max(r0, g0, b0);
    const w = Math.max(want.r, want.g, want.b);
    if (Math.abs(r0 / m - want.r / w) < 0.02 && Math.abs(b0 / m - want.b / w) < 0.02 && Math.abs(g0 / m - want.g / w) < 0.02) ok++;
  }
  console.log(`sky: ${ok}/1000 dots' class matches its drawn colour`);
  if (ok < 1000) fail('sky colour and class disagree');
}

// ---- local: rings and ships
{
  V.local.sync(ctx);
  for (let i = 0; i < 6; i++) { const c = checkCard('lring', i); if (i === 1) show(c); }
  V.local.frame(ctx);
  const ids: number[] = (V.local as any).shipIds;
  for (const id of ids.slice(0, 50)) { const c = checkCard('shipl', id); if (id === ids[0]) show(c); }
  console.log(`local: ${ids.length} ship heads explained`);
}

// ---- ships: the worker's name lookup finds every ship in transit
{
  const L = new Lives(e);
  let named = 0;
  const evs = e.events, T = EV['Ship launched'];
  const ships = snap.ships.slice(0, 200);
  for (const s of ships) {
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.type !== T || ev.body !== s.from || ev.a !== s.to || Math.abs(ev.year - s.depart) > 0.5) continue;
      const v = L.voyage(ev.b);
      if (v) { named++; if (named === 1) console.log(`ship: the ${L.shipName(e.ledger!.flows[v.flow])}, ${v.n} aboard`); }
      break;
    }
  }
  console.log(`ships: ${named}/${ships.length} in transit found in the launch record`);
  if (ships.length && named < ships.length * 0.9) fail('ship lookup misses ships');
}

// ---- system: belts, swarm, orbits, rings, sky, ships — Sol and the busiest other system
{
  const busiest = (() => {
    // the system with the most developed world (brain-stars and lifted stars show their works), else the most people
    let best = 0, bp = -1;
    for (const b of settled) { const s = world.bodies[b].system; if (s === 0) continue; const st = snap.S[b * NF + F.stage]; const p = (st <= STAGE.UPLOADED ? st : 0) * 1e15 + snap.S[b * NF + F.pop]; if (p > bp) { bp = p; best = s; } }
    return best;
  })();
  // and every system whose top world is a brain-star or a lifted star, for the star works
  const special = [...new Set([...settled].filter((b) => snap.S[b * NF + F.stage] === STAGE.BRAIN || snap.S[b * NF + F.stage] === STAGE.LIFTED).map((b) => world.bodies[b].system))].slice(0, 2);
  for (const sys of [0, busiest, ...special]) {
    ctx.system = sys;
    V.system.enter(ctx); V.system.sync(ctx); V.system.frame(ctx);
    let belts = 0;
    for (let k = 0; k < 6; k++) {
      const kind = `belt${k}`, ex = reg.explainerFor(kind);
      if (!ex || !reg.shown(ex.obj)) continue;
      belts++;
      const n = count(ex.obj);
      for (let i = 0; i < n; i += Math.ceil(n / 60)) { const c = checkCard(kind, i); if (i === 0 && (k === 0 || k === 4)) show(c); }
    }
    const orb = (V.system as any).vis.filter((v: any) => v.parent < 0);
    for (const v of orb) checkCard('orbit', v.id);
    show(checkCard('orbit', orb[0].id));
    for (const rg of (V.system as any).rings) show(checkCard('pring', rg.body));
    for (let i = 0; i < 9000; i += 450) checkCard('skys', i);
    if ((V.system as any).swarm) { for (let i = 0; i < 9000; i += 900) checkCard('swarm', i); show(checkCard('swarm', 0)); }
    const star = (V.system as any).star as any;
    star.children.forEach((o: any, slot: number) => { if (o.userData.work) show(checkCard('starw', slot * 10000)); });
    const tr = (V.system as any).trails;
    for (const id of new Set<number>(tr.headIds)) if (id >= 0) checkCard('shipy', id);
    console.log(`system ${world.systems[sys].name}: ${star.children.filter((o: any) => o.userData.work).length} star works, ${belts} belts, ${orb.length} orbits, ${(V.system as any).rings.length} ring systems, swarm ${!!(V.system as any).swarm}, ${new Set(tr.headIds).size} ships`);
  }
}

// ---- planet: the most developed world, and Earth
{
  let best = world.earth, bs = -1;
  for (const b of settled) { const s = snap.S[b * NF + F.stage]; if (s <= STAGE.UPLOADED && s > bs) { bs = s; best = b; } }
  for (const body of [world.earth, best]) {
    ctx.body = body; ctx.system = world.bodies[body].system;
    V.planet.enter(ctx); V.planet.sync(ctx); V.planet.frame(ctx);
    scene.updateMatrixWorld(true);
    const P = V.planet as any;
    const sat = P.sats ? count(P.sats.pts) : 0;
    for (let i = 0; i < sat; i += Math.ceil(sat / 30)) checkCard('sat', i);
    if (sat) show(checkCard('sat', 0));
    const works = P.works.works as any[];
    const tally: string[] = [];
    works.forEach((o, slot) => {
      const n = o.isInstancedMesh ? o.count : 1;
      tally.push(`${n} ${o.userData.work}`);
      for (let k = 0; k < n; k += Math.max(1, Math.ceil(n / 12))) { const c = checkCard('work', slot * 10000 + k); if (k === 0) show(c); }
    });
    for (let i = 0; i < P.elevators.length; i++) checkCard('elev', i);
    if (P.elevators.length) show(checkCard('elev', 0));
    for (let i = 0; i < 9000; i += 900) checkCard('skyp', i);
    console.log(`planet ${world.bodies[body].name} (${STAGE_NAMES[snap.S[body * NF + F.stage]]}): ${sat} satellites, ${P.elevators.length} elevators, works: ${tally.join(', ') || 'none'}`);
  }
}

console.log(`\nkinds explained: ${[...kindsSeen].sort().join(' ')}`);
console.log(fails ? `${fails} FAILURES` : 'all explain checks pass');
process.exit(fails ? 1 : 0);
