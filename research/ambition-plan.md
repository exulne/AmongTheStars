# The Whole Future: build plan

The goal: ten times more ambitious, still driven by numbers, still consistent. Milestones land in the order of the brief, each one shippable. This page is the design. The README stays the plain-English version.

---

## M1. Persistent people (in progress)

### The problem
Today a resident is `hash(body, index, 70-year epoch)`, so resident #1234 of Mars turns into a different human every 70 years, and nobody has parents.

### The idea: exact demography with invertible identities
Simulating trillions of individuals is out. Instead we keep an **exact ledger of people flows** and give every individual a **position in that ledger**. Because each position can be computed both forwards and backwards, a person can be derived from their identity *and* their identity can be found from where they sit. Nothing about an individual is stored, yet everything about them is consistent.

**The ledger (T0 → T1).** The engine already decides births, deaths and migration in aggregate. It now also records, per settlement and per *demography period* (5 yr until 200, 8 yr until 1,000, 20 yr after; 590 periods in all):
- births;
- end-of-period head-count;
- every **flow record**: source, destination, count, period, and kind (in-system migration, founding crew, colony ship, lost ship), with depart and arrive years.

Deaths are the residual (`alive + births + in − out − pop_end`), so the ledger always sums to the engine's head-count. Engine change that this forces: **migration now conserves people**. Senders lose exactly what receivers gain, and Earth's emigrants leave Earth.

**Cohorts (T1)** are computed lazily in the worker from the ledger, one settlement at a time, and cached:
- **pools** are native birth cohorts `(settlement, birth period)` plus arrival groups (one per incoming flow record);
- each period, in order: births create a cohort, arrivals create groups, emigrants leave, deaths happen;
- deaths are spread across pools by a Gompertz–Makeham hazard `h(a) = a0 + A·e^{B·a}`, rescaled so the total equals the ledger's deaths. `B` falls with life-extension tech.
- The age × sex table at any `(settlement, year)` is a sum over pools, and it matches the head-count exactly.

**Ranks make individuals (T3).** Every pool has a seeded, invertible Feistel permutation `π` that maps member index → **rank**. The rules:
- Members in ranks `[0, A)` are present, where `A` is the pool's alive-and-resident count.
- Each period, emigrants take the top ranks, then deaths take the next ones down.
- So the period in which rank `r` dropped out tells you whether that person **left** (and on which flow record) or **died**.
- Sex is the parity of the rank, which gives exactly half women in every pool at every moment.

**Identity** = `birthplace.birthPeriod.index`. Earth's pre-2040 cohorts have negative periods (1920–2040, built from a 2040 age pyramid). This identity is the same at every year. A migrant keeps their birth identity: an arrival group's member `j` maps through the flow record's allocation to a rank in a source pool, then through `π⁻¹` to an index, so the arrival is a specific native of the source. The inverse also works: an emigrant's rank finds their flow record, and with it their slot in the destination group. Second and third moves chain the same way.

**Families are allocations, not guesses.**
- The births of child cohort `(s, p)` are split across the pools of fertile women present in `s` during `p`, weighted by count × age-specific fertility. The split uses largest-remainder rounding.
- A second permutation `σ_p` orders the children. A child's ordinal falls in pool `X`'s block at offset `o`, and its mother is the woman of rank `2·(o mod F_X)`.
- **Inverse:** a woman of rank `2k` has the children at offsets `o ≡ k (mod F_X)` in every period she was present and fertile.
- Fathers work the same way, with odd ranks and an independent `σ'_p`.
- So parents → children and children → parents agree exactly, from both directions, for any person in any century. Partners are a mother's distinct co-parents.

**What a person has (v1):**
- name: given name from birthplace culture and era; surname inherited from the father, with occasional cultural drift;
- sex, birth and death (year, place, cause);
- location history, including time spent aboard a named ship;
- parents, partners, children, siblings, and an ancestor chain;
- occupation history (15-year career blocks keyed by settlement stage), body (height from gravity, health), education, genome divergence;
- a descendant map, sampled breadth-first: where the bloodline lives at the current year.

Causes of death come from what happened to that settlement in that period: plague, breach, war, famine, gamma-ray burst, a ship lost in transit, or old age.

**T2 notables** (M2) promote specific identities from this space, so a notable always has a consistent family.

**Budgets:**
- Ledger: about 1–3 MB per run in the worker, never in snapshots.
- A settlement's cohort model is built in under 30 ms and cached.
- A biography takes under 5 ms.
- Earth (9 billion people) costs no more than Mars.

**Checks (world checker):**
- Σ pools equals the engine head-count every period.
- Mother ↔ child and emigrant ↔ immigrant agree both ways on random samples.
- Sampled residents reproduce the age × sex table (χ²).
- Same seed gives the same people.

**UI:**
- Residents list: every resident is reachable by `#N`, in random but stable order.
- Biography panel with clickable family.
- **Pin** a person: they follow you through time (shown as "not yet born" or "died 2311, Titan, habitat breach" when outside their life).
- "Bloodline" view of descendants.
- The feature builder adds the 3D district and street level: city → district → a person dot you can click.

---

## M2. Notables and the Chronicle
- **The T2 pool** of about 10k–200k notables holds persistent agents chosen *from* T1 identities by role queries. The roles are founder (each founding crew), captain (each ship), leader (each polity regime change), inventor (each M3 invention), rebel (revolts and independence), prophet (new faiths), and anyone the user pins.
- **Selection** is deterministic: `hash(seed, role, event)` picks a rank among adults present in the right pool.
- **Decisions:** each step a notable picks among actions weighted by Big-Five personality × needs × opportunity. The actions are migrate (boarding a specific ship), marry, research, seek office, found a faith, mutiny, or found a settlement.
- **Writes back:** actions raise or lower real hazards, such as secession, stage-up, launch probability and invention rate.
- **Storage:** a compact record table inside snapshots, delta-encoded.
- **The Chronicle** is a searchable feed generated from notable actions with templated prose, linked to people, places and ships. Ships get names.

## M3. Emergent invention (research brief in `research/invention-model.md`)
- **Capability axes:**
  - 20–40 quantities, each with physical ceilings;
  - speculative gates with `p_feasible` per seed, where a failed roll becomes a discovered no-go theorem.
- **Techs:**
  - the bible's 69 techs form the spine, with the 23 missing ones added;
  - each tech has inputs (axis thresholds, prerequisites, resources) and outputs (axis increments).
- **Invention:**
  - a Poisson process per settlement from researcher cohorts × skill × funding × stability × connectivity, under the semi-endogenous law (λ = 0.75, ideas get harder to find);
  - every invention gets a date, a place and named inventors (promoted to T2), and multiples and priority disputes can happen.
- **Diffusion:**
  - spreads per settlement at light-lag along trade and comms edges, is blocked by war and embargo, and can be lost in collapse;
  - deployment follows logistic adoption S-curves, and effects scale with the deployment level.

## M4. Procedural galaxy
- **Octree sectors:**
  - sector key = `(level, ix, iy, iz)`; star count ~ Poisson(density(x) × volume), using the bible §9.1 model (thin and thick disk, bulge, bar, 4 arms, halo);
  - each star = `hash(worldSeed, sectorKey, n)` gives mass (Kroupa IMF), age, metallicity, then luminosity, lifetime and habitable zone;
  - planets come from a disk model: frost line, mass–radius, atmosphere from escape velocity and temperature, greenhouse;
  - sector size is 50 ly at the leaf, and sectors are generated only near the camera or near human activity.
- **Real stars:** the current real list plus a compressed catalog within 100–300 ly if the single-file budget allows; it needs approval to download HYG. Procedural stars are suppressed within a real star's exclusion radius.
- **The engine's sparse active set:** today's fixed 7,600 systems become "materialised systems". Expansion queries the generator for candidates inside ship range.

## M5. Surfaces and cities
- **Terrain:** quadtree-LOD sphere terrain from the planet's physical parameters. Terraforming is visible over the centuries.
- **Cities:**
  - districts sized from settlement state (habitat ring, industry, farms, port, slums, government);
  - residents have home and work districts, and the street level shows people you can click.

## M6–M10
- **M6:** the combinatorial tech generator (Weitzman recombination, damped effects), plus a multi-seed Invention Atlas (P10/P50/P90) and a per-seed tech web.
- **M7:** polities (regime per polity; the global era becomes a summary), markets and trade routes, fleets and war, and ships as visible objects with crews.
- **M8:** abiogenesis rolls, native biospheres, and rare alien polities on the same invention model, so contact emerges from the sim.
- **M9:** Psychohistory 2.0. Per-polity features and invention tokens, multiple heads (next invention, regime change, who matters), and **counterfactual mode**: remove a person or event, re-run from the snapshot, diff the futures.
- **M10:** deep time to 1,000,000 years with coarser steps, and the Local Group beyond.

## Process
- Every commit builds and deploys.
- Each milestone gets a four-critic pass: looks, function, first-time UX, and "does this feel like sci-fi".
- The world checker owns the invariants.
- The researcher writes ahead of the build: `invention-model.md` now, the galaxy and planet-formation model next.
