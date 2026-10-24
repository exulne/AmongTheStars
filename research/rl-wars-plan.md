# RL wars: polities that learn to fight across the ages

Branch: `rl-wars` (cut from `sim` at 2804ee3).

## Status (2026-10-24)

Built and running:

| Piece | File | Notes |
|---|---|---|
| War-mind hook | `src/sim/warMind.ts`, `src/sim/polity.ts` | Four decision points (posture, press, strike, terms). With no mind set, futures are byte-identical to before (`scripts/war-golden.ts`; the fingerprint is per machine). |
| Posture | `H.posture` in `civ.ts`, `engine.ts` | Extra military spending is drawn from capital. It's saved in snapshots. |
| Policy net | `src/ml/warNet.ts` | Trunk 32→128→64, posture/value heads, pair head 86→64→8. 18,893 params. Forward pass in TS. |
| Mind | `src/ml/netMind.ts` | Every draw is a hash of (seed, step, who, whom, what), so a replay from any snapshot is exact (`scripts/war-mind-check.ts`). |
| Rollout server | `ml/rl/rollout.ts` | Node worker per core. Doctrine = Realpolitik. Writes one binary batch per iteration. |
| Learner | `ml/rl/ppo.py` | PyTorch PPO + GAE on the A10. League of the last 8 generations (30% of polities). A new generation every 10 iterations, each evaluated on 28 held-out futures. |
| Browser | `src/ml/warGens.ts`, `src/ml/warWeights.ts`, `src/sim/worker.ts` | Generation k fights from year k·10000/N. `ml/rl/export.py` packs all generations as int8. |

Not yet: PBT across lineages, a rule-based anchor in the league, a "Way of War" panel in the UI,
and doctrine switching while playing.

Run it:

```
ssh lambda; cd ~/2SOON2026
python3 ml/rl/ppo.py --run realpolitik --iters 500 --gen-every 10 --futures 56   # resumes if interrupted
python3 ml/rl/export.py --run realpolitik                                         # then copy src/ml/warWeights.ts back
```

On the A10 box (30 vCPU), the sim is about 3.4× slower per core than on the M5 Pro. One iteration takes
about 45 s (rollouts 37 s, learning 8 s), so a 50-generation run is about 6 hours.

## The idea in one paragraph

Today every war in the sim is a dice roll. `Politics.localWars` and `Politics.kineticWars`
(`src/sim/polity.ts`) add up shortage, faith distance, independence and grudge terms, scale them by
regime and era, and then draw a random number. Nobody decides anything. In this plan each polity
gets a **policy** that makes those decisions: when to arm, whom to press, when to strike, what
peace to accept. Policies train by reinforcement learning across thousands of simulated futures.
The trick is that **sim time is training time.** Polities in year 2100 run generation 0 policies,
and polities in year 6000 run generation 40 policies, which have fought through every war their
ancestors lost. As you move forward through a future, war gets visibly *smarter*, and the
direction it takes (more violent, more decisive, or more restrained) is what the learning
finds, steered by a doctrine you choose.

## What exists to build on

| Piece | Where | Use |
|---|---|---|
| Deterministic engine, seeded RNG | `src/sim/engine.ts`, `rng.ts` | Reproducible rollouts; replay any training episode |
| War log: cause, kind, sides, severity, killed, outcome | `src/sim/civ.ts` `WC`, `WAR_CAUSE`, `OUTCOME` | Rewards and episode records come straight from this |
| Local wars, kinetic (relativistic) wars, second strike, light-lag mobilisation | `src/sim/polity.ts` | The action points (see below) |
| Regimes with war appetite (`REGIME_FX`) | `polity.ts` | Becomes a prior/bias on the policy, not the whole answer |
| Era war multiplier (`ERA_FX.war`) | `catalog.ts` | Becomes an observation, not a hard multiplier |
| Headless runner | `scripts/headless.ts` | **One 10,000-year future = 1301 steps in 0.87 s on one core** (M5 Pro), about 65 wars |
| Parallel rollout pattern | `ml/dataset.ts` (worker_threads, one engine per core) | Reuse for the rollout workers |
| Hand-written backprop, weights shipped to the browser | `src/ml/transformer.ts`, `src/ml/weights.ts` | Same route for policy weights |

## The agents

**Who acts:** each living polity (a faction capital, `F.faction === b`). There are usually
tens to a few hundred at once, and they appear and die through independence and annexation, so
this is a multi-agent setting with a changing set of agents. All polities share one network per
generation (parameter sharing) and are told apart by what they observe.

**When they act:** every sim step (about 7.7 years on average) for posture, and at each
contested pair for war decisions. 65 wars per future is too sparse a signal on its own, so the
posture decision gives every polity a dense, small action every step.

**Observation (about 40 floats per polity, plus one row per rival):**
- self: log pop, log GDP, military, shortage, stability, gini, regime one-hot, worlds, systems held, years since last war, faith tenets
- world: era one-hot, ship speed (β), FTL flag, tech count
- per rival in reach (top K=8 by threat): mil ratio from `reach()`, light-lag, grudge, faith distance, independence history, whether they hold a second-strike system, whether we're at war

**Actions:**
1. *Posture* (each step): military spending share in {cut, hold, build, mobilise}. This feeds `F.military` and costs capital and stability.
2. *Press* (per contested rival): {nothing, demand, war}. This replaces the random draw in `localWars`.
3. *Strike* (per kinetic-eligible rival): {hold, launch}. This replaces the draw in `kineticWars`. The deterrence term stays in the physics: the target's other systems still fire back.
4. *Terms* (when a war resolves): accept {white peace, reparations, annex} or fight on for another round. This replaces the fixed thresholds in `resolve`.

The physics of a fight (losses from the mil ratio, severity, light-lag mobilisation, strike energy)
**stays hand-written**. Agents choose *whether* and *when*, not the casualty formula. That keeps
the sim honest and the policies interpretable.

**Reward (per polity, per step)** is a weighted sum. The weights are the doctrine:

```
r = w_grow  · Δlog(pop·GDP)          // prosper
  + w_land  · Δworlds held           // expand
  + w_live  · survived this step     // don't get annexed
  − w_blood · own dead / pop         // casualties hurt
  − w_world · everyone's dead / total pop   // shared-fate term (0 = purely selfish)
```

## Populations across time (the "progressive" part)

```
gen 0  ── rollouts ──> PPO ──> gen 1 ──> ... ──> gen N
  ^ frozen opponents sampled from {gen 0..k} (a league, so nobody overfits to one rival)
```

- **League self-play**: generation k trains against a mix of itself (60%), earlier generations (30%) and the current hand-written rules (10%, as an anchor). This is standard league training (AlphaStar style). It stops a cycle where each generation only beats the one before it.
- **Population-based training**: each generation has P=8 lineages with slightly different hyperparameters and doctrine weights. The bottom quarter is replaced by mutated copies of the top quarter. Lineages that survive are the "peoples" whose way of war spreads.
- **Generation ↔ year mapping**: checkpoint k is used by polities from sim year `t_k` on, e.g. every 200 years, giving about 50 generations over 10,000 years. A new polity inherits its parent polity's lineage, so a breakaway colony starts out fighting like its old master and then drifts away.
- **What the player sees**: a "Way of War" readout per age: wars per century, deaths per war, mean duration, share ending in annexation (decisiveness), first-strike rate, and how often a kinetic strike was considered but held back (deterrence). The chronicle can name doctrines as they appear ("the Ceres Restraint", "the Junta Doctrine").

### Which direction should war go?

Don't hard-code it. Pick the doctrine and let the learning find the arc. Three presets:

| Preset | Weights | What I expect to emerge |
|---|---|---|
| **Realpolitik** (default) | grow 1, land 0.5, live 2, blood 0.5, world 0 | An arms race first, then **deterrence**. Since the kinetic second strike is already modelled, I expect fewer wars that are each larger and more decisive, and long cold peaces between multi-system powers. This is the most interesting arc and it comes from the existing physics. |
| **Conquest** | land 2, blood 0.1 | Escalation: more and bigger wars, faster annexation, consolidation into a few empires, and more kinetic wars once β > 0.1. |
| **Restraint** | blood 2, world 1 | War becomes rare and short and ends in reparations, not annexation. Military spending decays except where neighbours are junta-run. |

The player can change the doctrine while playing (see the interaction section). That's how "wars get
progressively X" becomes something the player controls rather than a fixed script.

## Engineering plan

**Phase 1: everything in TypeScript, on the Mac (no cloud needed).**
1. `src/sim/warPolicy.ts`: a `WarPolicy` interface with `act(obs) → actions`. The default implementation reproduces today's random rules exactly. Check: same seed gives a byte-identical war log (add this to `scripts/check.ts`).
2. Refactor `polity.ts` so the four decision points call the policy. Physics stays put.
3. `ml/rl/`: an MLP policy and value net (2×128) with hand-written backprop, like `transformer.ts`. PPO with GAE. Rollout workers from the `dataset.ts` pattern, each running many engines and batching every agent's observation into one matmul per step.
4. League and PBT driver, checkpoints to `ml/rl/ckpt/gen_XXX.bin`, and an eval report like `ml/EVAL.txt` (win rate vs earlier generations, the Way of War metrics per generation).
5. Browser: `weights.ts`-style export of all generations (2×128 MLP ≈ 25k params × 50 gens ≈ 5 MB float32, ~1.3 MB as int8). `worker.ts` loads them and polities pick the checkpoint for the current year.

Rough budget: 50 generations × 2,000 futures = 100k futures ≈ 25 core-hours of sim plus policy
inference. **On the 18-core M5 Pro that's roughly 2–3 hours for a full run.** That's fine for
getting the design right.

**Phase 2: scale on Lambda.** This is only needed once the policy grows (for example attention
over all rivals or a transformer over war history) or we want many doctrine variants at once.
- Rollouts stay in Node on CPU cores (the sim is the bottleneck, not the network).
- The learner moves to PyTorch on GPU. Node workers send observation, action and reward batches over shared memory or ZeroMQ to a Python learner. Weights go back every iteration.
- Export to the same browser format.

**Phase 3 (optional): live learning.** The player's own future streams to a Lambda learner, and
new checkpoints come back while they play, so their choices actually train the next generation.
This is cool but costly and fiddly. Do it only after phases 1–2 look good.

## Being straight about the GPUs

The expensive part is **simulating futures, which is single-threaded JS on CPU**. A 2×128 MLP
policy is trivial, and a GPU would sit idle in phase 1. GPUs pay off only in phase 2 (bigger
policy networks, many lineages trained at once) and for running the PyTorch learner. So for
Lambda, **vCPU count matters more than GPU model**: pick instances by how many cores they have.

## What I need from you

1. **Lambda Cloud API key** (phase 2). Put it in your shell as `LAMBDA_API_KEY`, not in the repo. Also the name of an SSH key registered in Lambda, and your preferred region.
2. **Budget cap per run** in $/hr or total. I'd start with one single-GPU instance to check the bridge, then one 8×GPU node only for a big sweep, since those come with far more vCPUs.
3. **Repo access from the box**: a deploy key or a GitHub token with read access to `exulne/2SOON2026`.
4. **Experiment tracking**: Weights & Biases API key if you want dashboards, otherwise I'll write plain JSON and CSV plus the existing chart UI.
5. **Decisions**:
   - Default doctrine: Realpolitik / Conquest / Restraint (my pick is Realpolitik).
   - How the player steers it: a doctrine dial in the data panel, a Starship voice command ("set doctrine: restraint"), or both.
   - Is Python OK for the phase 2 learner? (Phase 1 stays pure TS, matching the repo.)

Nothing else is needed for phase 1. It runs on this laptop.

## Risks

- **Degenerate equilibria**: everyone learns "never fight" (if blood is too high) or "always fight". The league anchor and PBT selection guard against this, and the eval report flags it.
- **Changing agent sets**: polities appear and die mid-episode. Handle it by treating each polity's life as its own trajectory with a terminal reward on annexation.
- **Credit assignment over light-lag**: kinetic strikes land decades after launch. Use a high γ (0.995 per step) and log the strike's outcome back to the launch step.
- **Sim drift**: physics changes on `sim` invalidate trained policies. Pin a sim version per checkpoint set and retrain on merges.
