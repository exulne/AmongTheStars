# Launch and mission economics

Model 1.0.0, assumptions 2026-10-24. Code: `src/sim/launchEconomics.ts` (pure model), `src/sim/engine.ts` (where it is paid for), `src/ui/dataEcon.ts` (the "Launch economics" data tab), `scripts/econ-check.ts` (tests).

## What this is, and is not

A **transparent scenario model built from public evidence**. It estimates what it costs to move people and cargo, component by component, so a reader can see what drives the result and change it. It does **not** know or predict SpaceX's (or anyone's) confidential build, refurbishment, labour or per-flight costs. Those are not public, so they are design assumptions [D] with wide ranges, never presented as reported facts.

Three cost concepts stay separate:

| Concept | What it includes | Used for |
|---|---|---|
| **Internal marginal cost** | Cash spent because a flight happens: propellant, refurbishment, ground and mission operations, range, integration, in-space operations, third-party insurance, and hardware that is expended | Shown in the inspector |
| **Fully burdened economic cost** | Marginal cost plus amortised hardware, infrastructure amortisation, expected loss (self-insurance) and mission-specific hardware | **What the simulation spends** |
| **Customer price** (illustrative) | Transport cost × (1 + provider margin) [D] | Shown only, labelled as a price |

A customer price is never described as production cost. Money is 2024 US dollars (the project's "credit").

## Sources and assumptions

Every input is a `SourcedRange`: base value, low, high, unit, confidence, class (R reported / E engineering estimate / D design assumption), source title, URL, date, and a note. The full table (about 150 inputs) is exported by the tab's "Copy the assumption table" button. The anchors:

| Parameter | Value or range | Configuration | Source | Class |
|---|---|---|---|---|
| Payload to LEO, reusable | 100+ t (SpaceX page); 100–200 t, base 150 t (2040 config) | SpaceX 2025; mature 2040 | [SpaceX Starship](https://www.spacex.com/vehicles/starship/) | R (100 t) / E |
| Ship propellant capacity | ≈1,600 t | SpaceX 2025 | SpaceX Starship | R |
| Booster propellant capacity | ≈3,650 t | SpaceX 2025 | SpaceX Starship | R |
| Ship / booster propellant analysed for LC-39A | ≈2,650 t / ≈4,100 t | FAA LC-39A EIS | [FAA KSC LC-39A](https://www.faa.gov/space/stakeholder_engagement/spacex_starship_ksc) (meeting slides, draft-EIS era) | R |
| Engines | 6 (ship), 33 (booster); methane/oxygen | SpaceX 2025 | SpaceX Starship | R |
| Launch cadence caps | 44/yr LC-39A (ROD 2026-01-30); 25/yr Starbase (ROD 2025-05-06); 76/yr SLC-37 proposed; up to 456/yr studied (2026 notice) | per site | FAA LC-39A; FAA Starbase EA | R (caps), D (2040 base 100/yr) |
| Ground commodities | ≈24,000 truck trips/yr; +10.27 M gal water/yr at Starbase | Starbase 25/yr | FAA Starbase EA (via news coverage) | R |
| Oxygen:methane mass ratio | 3.6 (3.5–3.8) | Raptor | Not published by SpaceX; commonly reported (orientation: Wikipedia) | E |
| Industrial natural gas | $4.07/Mcf (2024 US average) ⇒ $0.21/kg CH₄ | – | [EIA](https://www.eia.gov/dnav/ng/NG_PRI_SUM_A_EPG0_PIN_DMCF_M.htm), Natural Gas Annual table 23 | R |
| Industrial electricity | ≈$0.081/kWh (2024) | – | EIA Electric Power Monthly 5.6.A | R |
| Liquefaction, oxygen production, purification, storage, boil-off, supplier margin | see table | – | NASA NTRS, FAA filings (activities, not costs) | E / D |
| Tanker propellant delivered | 100–150 t (NASA presentation); 150 t base for the larger stack | – | Public HLS estimates (orientation) | E |
| HLS tanker count | 4–20 public estimates (SpaceX ≤8; NASA 8–16; GAO 16 launches; NASA "high teens") | – | Orientation only: **the model computes its own** | – (check) |
| HLS contracts | firm-fixed-price, milestone-based (Option A 2021, Option B 2022) | – | [NASA HLS](https://www.nasa.gov/humans-in-space/nextstep-h-human-landing-system/) | Program reference only, **never divided into a per-flight price** |
| Learning curve | 85–95% per doubling, base 90% | – | [NASA Cost Estimating Handbook](https://www.nasa.gov/ocfo/ppc-corner/nasa-cost-estimating-handbook-ceh/) | E |
| Falcon 9 reuse and reliability | 30+ reflights per booster; ≈99% success | – | SpaceX Falcon 9 | R (anchor for E ranges) |
| Ship / booster build cost | $40M (15–120M) / $60M (25–180M) | mature 2040 | – | **D** |
| Design life | ship 50 (10–200), booster 100 (20–300) flights | mature 2040 | – | D / E |
| Refurbishment, ground ops, mission ops, range, insurance, integration | $0.5M–$3M per flight bases, wide ranges | – | – | E / D |
| Launch-site capital | $3B per site (1.5–8B) | – | FAA documents describe the facilities, not their cost | E |

**Configuration versioning.** SpaceX's overview and the FAA's LC-39A analysis describe different stacks. They are three versioned configurations, not contradictory constants: `starship-spacex` (published figures), `starship-faa` (FAA-analysed loads, early operations at FAA caps) and `starship-2040` (the simulation baseline: FAA-analysed loads, mature operations). The tab can reprice any run under each.

### Where the public record is insufficient

- Per-unit build cost, refurbishment cost, design life and labour of Starship and Super Heavy: **not public**. All [D].
- Large-scale ship-to-ship cryogenic transfer efficiency and in-orbit boil-off: not demonstrated at scale (as of 2026). [E], wide.
- Launch-site capital and upkeep: facilities are described in FAA filings, costs are not.
- Final-EIS propellant loads: the 2,650/4,100 t figures come from FAA meeting slides of the draft-EIS era; the final document may differ.
- Delivered liquid-methane price at a launch site: only the feedstock (EIA) is reported. Purification, liquefaction, storage and margin are estimates.
- Everything beyond about 2060 (NTP, fusion, generation and seed ships, elevators, warp) is a design assumption scaled from the bible's §1.3 and §3.6 tables.

## Work breakdown (cost components)

Following NASA CEH practice, recurring per-flight costs are separated from amortised non-recurring capital, and every line is its own field:

| Component | Group |
|---|---|
| `hardware`: vehicle hardware, amortised over realised life (or the full price if expended) | hardware |
| `propellantEarth`: Earth-produced propellant (methalox, or LH₂ for NTP) | propellant |
| `propellantOffEarth`: ISRU, asteroid-depot or imported propellant; fusion fuel | propellant |
| `refurbishment`: inspection and refurbishment | operations |
| `groundOps`: ground operations and launch site (incl. elevator and mass-driver energy) | operations |
| `missionOps`: labour and mission operations | operations |
| `rangeRegulatory`: range, licensing, environmental monitoring | operations |
| `payloadIntegration` | operations |
| `inSpaceOps`: life support in transit, destination operations | operations |
| `insurance`: third-party liability plus insurer loading | risk |
| `expectedLoss`: probability × value at risk (self-insurance) | risk |
| `infrastructure`: launch-site or shipyard capital recovery | infrastructure |
| `missionHardware`: mission-specific equipment (outpost kit, colony kit) | mission hardware |

The total is the exact sum of the components (tested). The tanker campaign is reported as a subtotal (`tankerCost`).

## Formulas

**Propellant per launch** (two-stage, Earth):

```
M          = shipPropellant + boosterPropellant
methane    = M / (r + 1),   oxygen = M − methane          (r = O:F mass ratio)
CH4 $/kg   = feedstock + purification + liquefaction_kWh × electricity + conditioning
LOX $/kg   = oxygen_kWh × electricity + conditioning
propellant = [methane × CH4 + oxygen × LOX] × (1 + groundBoiloff) × (1 + supplierMargin) × shortage/collapse multiplier
```

Each line item (feedstock, purification, liquefaction, oxygen energy, storage, boil-off, margin) is kept and shown.

**One launch**:

```
realisedLife   = designLife × fleetRetirementFactor × reuseMaturity
hardware       = shipBuild/realisedShipLife + boosterBuild/realisedBoosterLife      (build × learning × productivity^−k)
infrastructure = siteCapital × (CRF(i, n) + O&M) / (flightsPerSite × cadence multiplier)
expectedLoss   = P(loss) × residualFraction × (shipBuild + boosterBuild)
insurance      = (thirdPartyPremium + loading × expectedLoss) × war/Kessler multiplier
launch         = propellant + hardware + refurbishment + groundOps + missionOps + range + insurance + integration + infrastructure + expectedLoss
```

Losses shorten no vehicle's amortisation life. They are priced once, as expected loss, so they are not double-counted with amortisation.

**Δv** (`routeFor`): patched conics with the real orbits. There is a Hohmann transfer around the star (or around the shared planet for its moons; giant-planet moons add the giant's gravity well), Oberth departure from a low parking orbit, capture and propulsive landing on airless bodies, and aerocapture plus a 0.8 km/s landing where there is air. A fast-transfer margin (base +1 km/s) is added. LEO→lunar surface comes out at 5.7 km/s and LEO→Mars at 4.4 + 1.0 km/s.

**Campaign** (chemical): the most payload a ship can take with full tanks is

```
pMax = (capacity − carriedReturn) / (e^(Δv/ve) − 1) − dry − carriedReturn          (≤ payload to LEO)
ships = max(ceil(payload / pMax), ceil(crew / seats))
burn  = (dry + payload/ships + carriedReturn) × (e^(Δv/ve) − 1) + carriedReturn
requiredOrbitalPropellant = burn − residualAfterAscent
effectivePerTanker = tankerPayload × transferEfficiency × (1 − boiloff) × (1 − reserveFraction)
boiloff            = boiloffPerDay × loiterDays × (depot ? depotFactor : 1)
tankersPerShip     = ceil(required × (1 + missionMargin) / (effectivePerTanker × (1 − scrubFailAllowance)))
campaignLaunches   = ships + ships × tankersPerShip + depotLaunches
campaignCost       = Σ launches + missionHardware + inSpaceOps + destinationOps
costPerDeliveredKg = campaignCost / usefulPayload
```

The return home is chosen as the cheapest feasible option. `reuse-isru` uses propellant made at the destination, priced at ISRU energy × off-Earth electricity + plant. `reuse-carried` carries the return propellant up with the ship. `expend` leaves the ship at the destination, so the full ship price lands in `hardware`. With and without a depot are both evaluated, and so are asteroid-depot propellant (once asteroid mining exists) and elevator-lifted propellant; the cheapest wins. **Tanker counts emerge from the assumptions.** Baseline gives 11 per crewed lunar ship and 5–7 per Mars ship. On SpaceX-published capacities the lunar figure is 12 (public estimates: 4–20).

**NTP and fusion transports**: crew and cargo ride Starship-class lifts to the parking orbit. A reusable in-space transport then flies the route with the same mass logic, amortised over its trips. NTP hydrogen arrives in tankers that carry less of it than methalox. Fusion fuel is a small mass priced per kg.

**Interstellar ships**: built in orbit and flown once. Mass = fixed + colonists × mass per colonist (fusion ark, generation or seed ship, by technology). Hardware = mass × $/kg × complexity × productivity factor × shipyard factor. Fuel follows Tsiolkovsky with Δv = 2 × cruise speed (accelerate, then brake) and a drive exhaust velocity by speed tier, capped at a buildable mass ratio. Expected loss is the engine's own loss probability for the voyage × (hardware + colony kit). A typical 2,000-colonist generation ship at 0.03 c comes to about $1.5T, near the old flat `4e12/√productivity` it replaces.

## Simulation integration

- **What is priced.** Every crewed in-system founding mission (`crewMission`), every interstellar or warp ship (`expand`), and every scheduled passenger flow between worlds of one system (the migration block, priced per sender–receiver pair).
- **Who pays.** The *funding polity*: the settlement's faction seat while it lives, else the settlement. Interstellar ships are paid for by the hub that launches them. Spending comes out of the payer's capital (`book`), never below zero.
- **Affordability.** A per-step transport budget per polity = min(25% of the seat's capital, 1% of the polity's product × era multiplier × max(dt, 2)). Expansion ×1.5, Golden Age ×1.3, Stagnation ×0.7, War ×0.5, Pandemic ×0.6, Collapse ×0.2. Services may use 60% of it; each sender's emigration offer is capped so its dearest reachable destination fits. A crewed mission flies only if a vehicle can fly the route and its whole campaign fits what is left. An interstellar ship flies only if it costs no more than min(the hub's capital, 5% of product × 30 build years × era multiplier) (bible §3.6). Unreachable sender–receiver pairs carry nobody.
- **No double counting.** The flat interstellar `shipCost` was *replaced* by the economics, not added to. Migration and crew missions had no cost before. The destination's starting capital (existing logic) is what arrives; the funder pays to build and fly it.
- **Mission outcomes.** A crewed mission is lost with its campaign's loss probability (one seeded draw), and its crew flow is marked lost in the people ledger. Interstellar outcomes are set on arrival or loss.
- **Events.** `Mission launched` (origin, destination, mission id) and `Mission lost`, so the inspector can link to a mission's economics.
- **Technology changes the right component only.**

| Technology / state | Component it changes |
|---|---|
| Fully reusable heavy lift | realised life (hardware) and refurbishment; before it, life ×0.2 and refurbishment ×2 |
| Learning (launches flown) | recurring hardware and refurbishment (Wright curve) |
| ISRU (destination base) | return propellant made there (`propellantOffEarth`) instead of expending the ship |
| ISRU (origin) | origin propellant price |
| Asteroid mining | parking-orbit propellant purchasable from a depot instead of tankers |
| Asteroid mining + O'Neill cylinders ("orbital shipyards") | interstellar hardware ×0.5 |
| Regolith construction + fusion ("mass driver", a design mapping: no catalogue tech) | cargo launch from airless low-g bodies by energy |
| Space elevators | Earth ascent by climber energy + capital + ops per kg; release Δv credit |
| Nuclear thermal propulsion, fusion torch drive | new vehicles, chosen when cheaper or the only feasible one |
| Productivity | manufactured hardware ∝ productivity^−0.5 |
| Energy technology | electricity price ∝ energy^−0.3 |
| Generated "launch" inventions | refurbishment and ground operations |
| War era | insurance ×2.5, operations ×1.2, cadence ×0.7 |
| Pandemic / Collapse | operations and cadence; Collapse also propellant ×1.5 |
| Kessler cascade | insurance ×3, cadence ×0.3, +1% loss per launch |
| Shortage at origin | propellant price × (1 + shortage) |

- **Determinism.** No `Math.random`. The one new random draw (crewed-mission loss) uses the engine's seeded RNG. New mutable state lives in the snapshotted `g` slots: launches flown, cumulative spend, and this step's accounts, reset at step start. The per-settlement `transport` field lives in `S`. The mission log is like the event log: main run only, truncated on restore. Scratch arrays are zero between steps. Smooth context values (productivity, energy) are rounded to 1/20 of an e-fold before pricing, so prices can be cached; the record keeps exactly what was priced.
- **Scenario runs.** `new Engine(world, seed, { econ: scenario('conservative') })` simulates under another assumption set, deterministically per (seed, scenario).

### Metrics

Global (group "Transport", per year unless cumulative): `transportSpend`, `transportCum`, `transportShare` (% of product), `propellantSpend`, `hardwareSpend`, `operationsSpend`, `riskSpend`, `infraSpend`, `missionHwSpend`, `serviceSpend`, `launches`, `tankerFlights`, `campaigns` (missions plus service ship-equivalents), `payloadDispatched` (t, booked at departure, so interstellar payload counts when it leaves), `peopleTransported`, `costPerKg` (0 in steps where nothing flew), and `leoCostPerKg`, a reference price of Earth→orbit for the current vehicle and ascent. Per settlement: `transport`, the $/yr its polity seat spent (queryable, e.g. `transport > 1B`).

## Uncertainty and sensitivity

- **Envelope** (every record): every input at the end that lowers cost, and at the end that raises it, all at once. It is a bound on the assumption space, **not a confidence interval**, and it is wide by construction (the all-costly corner of a lunar outpost is about 50× base). When no campaign is feasible at the costly end, `high` repeats the base and is flagged.
- **Monte Carlo** (on demand in the inspector, never in a step): 400 seeded draws from triangular(low, base, high) for every input, giving p10/p50/p90. Most ranges reach further above their base than below, so p50 usually sits above the base case. That is a finding, not a bug.
- **Sensitivity** (on demand): one-at-a-time tornado over every uncertain input, ranked by swing in total campaign cost. It covers build cost, reuse life, refurbishment, cadence, failure probability, tanker payload, transfer efficiency, boil-off and commodity prices, among others.
- **Scenarios**: conservative and optimistic move every cost input halfway from base toward its costlier or cheaper end. The UI reprices recorded missions; the simulated history stays as it happened.

## Reproducibility

Each record stores its inputs: route Δv, ascent, transit, distance, cargo, crew, and the context of era, flags, shortage, productivity, energy, launch inventions, launches flown, transit loss and speed. `evaluate(unpackMission(row), assumptions)` reproduces its total exactly; this is tested on every record of a full run. Exports carry `modelVersion`, `assumptionsVersion`, the seed, the simulated and shown scenarios, the configuration, units and the full provenance table.

Sample exported record (seed 1, the first crewed mission):

```json
{
  "missionId": 2, "departureYear": 2041, "origin": "Earth", "destination": "Phobos", "fundingPolity": "Earth",
  "missionType": "crew", "vehicleClass": "starship",
  "vehicleVersion": "mature fleet, FAA LC-39A configuration (simulation baseline from 2040)",
  "returnMode": "expend", "outcome": "succeeded", "isruAvailable": false,
  "crewOrColonists": 34, "payload_kg": 357000, "missionVehicles": 3, "tankerFlights": 33, "tankersPerVehicle": 11, "depotLaunches": 0, "totalLaunches": 36,
  "propellant_kg": { "methane": 52826087, "oxygen": 190173913, "other": 0, "offEarth": 0 }, "earthLaunched_kg": 5307000,
  "cost_usd2024": { "low": 247116188, "base": 1916463272, "high": 98289403749, "highIsInfeasible": false },
  "breakdown_usd2024": { "hardware": 520000000, "propellantEarth": 43367846, "propellantOffEarth": 0, "refurbishment": 216000000, "groundOps": 216000000,
    "missionOps": 37800000, "rangeRegulatory": 18000000, "insurance": 23400000, "payloadIntegration": 9000000, "infrastructure": 125075359,
    "expectedLoss": 18000000, "missionHardware": 680000000, "inSpaceOps": 9820067 },
  "tankerCampaign_usd2024": 1009656270, "internalMarginal_usd2024": 1093387913, "illustrativeCustomerPrice_usd2024": 1607402253,
  "costPerKg_usd2024": 5368, "costPerPerson_usd2024": 56366567, "missionLossProbability": 0.0338,
  "inputs": { "in_cargoKg": 340000, "in_origin": 0, "in_outKmS": 5.46823, "in_backKmS": 1.88227, "in_transitYears": 0.708833, "ctx_era": 0, "ctx_flags": 0, "ctx_cumLaunches": 1.823, "...": "..." }
}
```

That 2041 mission predates "Fully reusable heavy lift" (2042 in this seed), so ships fly at 20% of their design life. Propellant is 2.3% of the bill; hardware, refurbishment, ground operations and the outpost kit dominate.

## Limitations

- Costs are not market prices and not any company's books; the [D] inputs dominate the uncertainty, and the tornado shows which ones.
- Earth launch cadence in the economics (per-site flights) is separate from the engine's existing `launchCap` (tonnes/yr that limits emigration). The two are not yet reconciled into one fleet-capacity model.
- Scheduled services are priced as continuous fleet operations (fractional ship-equivalents), not as discrete campaigns, and are not mission records.
- Crew safety is priced as mission loss probability only; no value is placed on lives.
- Δv uses circular, coplanar orbits and Hohmann transfers plus a margin. Windows, synodic waits and gravity assists are not modelled.
- The interstellar classes, the space elevator, the mass-driver mapping and all far-future prices are design assumptions.
