# 2SOON2026

**A simulation of humanity taking over space, starting with Mars in 2040 and running 10,000 years forward.**

You drag a slider through time. At any year you can zoom from the whole universe down to one galaxy, one star, one planet, one city, and one person in that city. Every number at every moment (people, energy, money, water, metal, knowledge, wars) comes out of the simulation and can be charted.

---

## The idea in plain English

Think of it as a very big board game that plays itself.

1. **The board.** The real Solar System (Mars, the Moon, Europa, Titan, the asteroid belt and so on), the real nearby stars (Proxima Centauri, TRAPPIST-1, Tau Ceti...), and a few thousand made-up but realistic star systems further out. Beyond those sits a fully drawn Milky Way and its neighbour galaxies.
2. **The pieces.** Settlements. Each one starts as a robot outpost and can grow into a crewed base, a colony, a town, a city, an industrial hub, or a megastructure. It can also starve, get abandoned, or die.
3. **The dice.** Each simulated year, every settlement rolls dice to decide what happens next: grow, stall, rebel, launch a ship, or collapse. This is the **Markov chain** part: *what happens next depends only on how things are right now.*
4. **The catch.** The dice are loaded by reality. A colony with no water rolls badly. A colony with fusion power and lots of people rolls well. Nobody gets to another star until somebody has researched the engine. Every decision depends on what resources, energy, people and knowledge exist at that moment.
5. **The output.** A record of everything, every step. That record is the product: you can ask "how many people lived around Tau Ceti in year 3,400, and how much energy did they use?" and get an answer.

Same **seed**, same future. Change the seed and you get a different future: maybe a war in 2300 sets everything back by 800 years, maybe fusion arrives early and humanity reaches 200 star systems.

## What you see on screen

| Thing | What it does |
|---|---|
| **Time slider** (bottom) | Years 0 to 10,000 after the first Mars landing. Drag it and the universe changes. |
| **Zoom levels** | Futures → Local Group → Milky Way → Local neighbourhood → Star system → Planet → City → Person → Cell → Molecule → Atom. Click to go deeper, use the breadcrumb at the top to go back up. |
| **Futures** (above the Local Group) | Every future played so far as a universe bubble: this one, the 24 sibling futures the background worker plays, and any you visited before. Further right means more energy (the Kardashev rating it reached), higher means more star systems settled, deeper means more wars; size is peak population, colour the outcome (spread across the stars, a few stars, stayed home, rose and fell, died out). The faint foam around them is the futures nobody has played yet. Click one for its card; enter it (double-click, scroll in, or "Enter this future") and the whole simulation switches to it. Scroll out of the Local Group to get here. |
| **Inside a person** (below the street) | Double-click or scroll into anyone in the street, or press "Look closer" on their biography. Their body is drawn life-size and see-through: skeleton, organs, vessels with blood moving, a heart beating about 70 times a minute. Build and bone density follow the world they live on (low gravity, cold, radiation); bodies adapted to their world carry the real genes for it (SOST for low gravity, Dsup from tardigrades against radiation, EPAS1 for thin air...), the era's medicine adds edits (PCSK9 after genetic medicine), nanomachines ride the blood once molecular nanofabrication reaches their world, and an uploaded person is the substrate their mind runs on. Go into any part for a cell of that tissue (neuron, red cell, osteocyte, hepatocyte, gut bacterium, respirocyte, logic tile...), into any organelle for its molecule (their own DNA letters and edits, a membrane lipid, heme, apatite, ATP, silicon, an NV centre in diamond...), and into any atom for its nucleus of protons and neutrons inside electron clouds sampled from real orbitals. Every piece has a card with real numbers and sizes in metres, tagged R (real), E (estimate) or P (this future's generator). |
| **Charts** | Lines over time for 39 measures: population, energy, wealth, knowledge, settlements, stability, wars, resources and more. Pick any one from each chart's menu, and click a chart to jump to that year. |
| **Future #** (top) | Each number is a different roll of the dice, so a different future. "Another future" picks one at random. |
| **Inspector** (right side) | Click anything and you get every number about it, at the year you're on. |
| **People** | Every settlement lists its residents, all of them real and persistent. Open anyone to read their life: where they were born, who their parents were, their partner, their children, where they moved, the plague they lived through, how they died. Click their mother, then her mother, and so on back to the generation ship and the world it left. |
| **Follow a life** (top) | Pick one person — filter by the world they were born on, their number among its births, and their kind (baseline, adapted, uploaded) — and their biography opens with the whole pathway of their life: every place they lived, in order, the voyages between, the stop they're at lit as you drag time. |
| **Ages** (under the slider) | Each future names its own ages after what defined them ("the Golden Age of O'Neill cylinders", "the Long Quiet after the Covenant of Kaeti"). Click one to go there. |
| **Peoples, wars, faiths** | With nothing selected, the inspector lists every polity standing that year, the wars fought so far (who fought, over what, who won, how many died) and the living faiths. Click a polity for its card: where it is governed from, what it broke away from and why, every government it had, every war it fought and who later broke away from it. Things still to come show faintly. |
| **Cities from orbit** | Each world's night lights take its society's colour and glow, and its buildings take its architecture's height, curve and density, so two cultures on neighbouring worlds look different from space and both change over the centuries. |

## How it works under the hood (still plain English)

- **`src/sim/`** is the engine. It runs in the background (a Web Worker) so the page stays smooth. It simulates year by year early on, then in bigger jumps later when things change slowly. Every 250 years it saves a full picture of the universe. When you jump to year 4,321 it loads the 4,250 picture and replays the last 71 years, which gives an exact answer quickly.
- **`src/view/`** draws everything in 3D with three.js: glowing particle galaxies, stars, orbits, planets with city lights.
- **`src/ui/`** holds the slider, charts, inspector and breadcrumb.
- **`src/ml/`** holds the neural network (see below).
- **`research/`** holds the research notes and the "simulation bible": real numbers on planets, technologies, events, and ideas borrowed from sci-fi.

### The rules, roughly

- **Population** grows until it hits what the habitat can support. Better tech means bigger habitats.
- **Energy** comes from solar power (weaker further from the Sun), then fission, fusion, and eventually star-scale collectors (Dyson swarms).
- **Resources:** water, metals, volatiles (gases for fuel and air), rare elements, helium-3. Each world has different amounts. Ice moons have water, metal asteroids have metal.
- **Knowledge** accumulates from people doing research. It unlocks technologies in a tree (you can't build a fusion ship without fusion).
- **Expansion:** rich, stable settlements send ships to nearby worlds. Interstellar trips take decades to centuries, and some ships never arrive.
- **Politics:** humanity as a whole moves between moods such as expansion, golden age, stagnation, war, pandemic and collapse, and each mood changes the dice. Far-off colonies with long light-delay to Earth tend to declare independence.
- **News travels at light speed:** an invention happens at one lab on one world. A colony 60 light years away hears of it 60 years later, and only then can it build with it or live differently because of it. Each world's inspector lists the news still on its way.
- **Events:** habitat breaches, breakthroughs, plagues, mutinies, new religions, and humans slowly drifting genetically on low-gravity worlds. The worlds themselves have their own events too (see *Living worlds* below).

## Living worlds: planets that change

Planets in this simulation are not painted backdrops. Every world has a physical state that changes over the ten thousand years: how warm it is, how much ice it has, where its sea level stands, how thick its air is, how much volcanic haze or dust hangs in its sky, how far it has been terraformed. Nature changes it, and so do people.

**Clocks that need no dice.** Some things are pure astronomy and run the same in every future. Earth's axis is slowly straightening (from 23.44° in 2040 toward 22.6° near the year 11,800, after Laskar's formula). Precession walks Earth's closest approach to the Sun from early January to early July, so northern summers get a little more sunlight. The Moon drifts away 3.8 cm a year. Mars's seasons follow its real 687-day year, so its polar caps grow over each winter pole and shrink in spring as you drag the slider. Halley's comet returns in 2061 and 2134 and about every 76 years after.

**Events at their real rates.** Natural disasters happen about as often as the real record says, rolled from their own dice so they never disturb the rest of the simulation:

| What | How often (on Earth) | Source |
|---|---|---|
| Chelyabinsk-size meteor (20 m) | about every 60 years | Brown et al. 2013 |
| Tunguska-size airburst (50 m) | about every 500 years | NASA, Catalina Sky Survey |
| 1 km asteroid (global winter) | about every 600,000 years | Chodas (KISS) |
| Tambora-size eruption (VEI 7) | about every 700 years | VEI records |
| Supervolcano (VEI 8) | about every 50,000 years | recurrence estimates of 30,000–130,000 years |
| Magnitude 9 earthquake | about every 30 years | USGS catalogue |
| Extreme solar storm (like 774 CE) | about every 2,000 years | tree-ring radiocarbon |
| Mars global dust storm | one Mars year in three to five, always in the dusty season | Mars orbiters and rovers |

Other worlds get the same physics scaled by size and neighbourhood: asteroid-belt colonies are hit far more often per square kilometre than Earth, Jupiter sweeps up comets (and wears their dark scars for months), Io erupts constantly, Enceladus's geysers surge, red dwarfs flare. Over a whole future that usually means a dozen or so Tambora-size eruptions and a one-in-five chance of a supervolcano, but almost never a big asteroid. No ice age comes within the window: the next one is not due for 50,000 years even without our carbon.

**People push back.** Earth starts at 1.7 °C above pre-industrial and keeps burning some fossil fuel until fusion power arrives. That carbon stays in the air for thousands of years, and the ice sheets keep melting long after the warming stops (about 2.3 m of sea level per degree, over millennia). A huge civilisation also warms its planets with its own waste heat, and a star's Dyson swarm shades its planets a little. When nanotechnology arrives, a stable Earth can raise a sunshade to cool itself back down. Terraforming is no longer a switch: it costs energy, so Mars only turns blue and green once its people can pay for it, and an abandoned project slowly fails.

**It matters to the people.** A volcanic or impact winter fails open-air harvests (indoor farms barely notice). Disasters kill by distance from each settlement drawn on the globe. Dust storms starve solar power. Solar superstorms knock out grids and satellites in proportion to how much a civilisation depends on them, and kill crews without shielding. Planetary defence pushes most big rocks aside once a world has asteroid mining and nuclear rockets. The Chronicle writes these up with the people who lived through them and names ages after them ("the Long Winter of 3170").

**What you see.** Mars's caps come and go with its seasons, and the whole planet blurs to butterscotch in a global dust storm. Earth's coastlines creep with the sea and its sky dims after a big eruption. Fresh craters, glowing lava, Io's hot spots, Jupiter's Red Spot (which in some futures finally breaks up), Saturn's white storms, Titan's methane seas and aurorae are all drawn, and you can click them for a card. Each world's inspector has a *Climate and geology* section; every number is tagged R (real data), E (estimate from real data) or P (this future's own roll). The charts and data desk gain Earth's temperature, sea level and haze, and every settlement's temperature, sea level, haze, pressure and habitability can be queried. The full plan, with sources, is in `research/geophysics-plan.md`; the code is `src/sim/geo.ts` and `src/sim/geoView.ts`, and `npm run check` now includes `scripts/geo-check.ts`.

## The people (how billions of real individuals fit in a browser)

The sim can't store a trillion people, so it does what a good accountant does instead.

- **A ledger.** For every settlement and every few years, the engine writes down how many babies were born, how many people moved where (and on which ship), and how many are alive at the end. Whoever isn't accounted for died. This always adds up exactly to the population on screen.
- **A seat number.** Every person has an identity: *where* they were born, *when*, and *which baby* they were (say, the 524,129th born on Mars in the 2230s). Think of a giant stadium. Each person has a seat, and the seats are shuffled by a code that can be run both forwards and backwards. When people die or emigrate, they leave from the back rows. So from your seat number we can work out exactly when you left and why, and from "who is still sitting here in 2340" we can work out exactly who you are.
- **Families from the same trick.** Each baby is assigned to a mother by seat, and couples sit next to each other. You can go from a child to their parents, or from a parent to their children, and both ways always agree. Couples move together and grow old together, and when one dies the other is widowed.
- **Generation ships.** A voyage longer than 25 years is a place of its own. People are born, age and die aboard, and the ones who step off at the other end are the grandchildren of the ones who left.
- **Names drift.** Early colonists have Earth names. The further from Earth and the longer since the Landing, the more names drift into new languages, one per star system. Surnames pass down family lines.
- **Deaths have causes.** If someone died on Titan the year the plague hit Titan, the plague probably killed them.

Nothing about a person is stored; everything is worked out when you look. That's why the same person is still there, older, when you drag the slider forward, and why Earth's 9 billion cost no more than Mars's first dozen.

## The AI part: a "psychohistory engine"

In *Foundation*, Hari Seldon predicts the future of a galactic empire with maths. We do a small version of that.

- **What it is.** A small **transformer**, the same kind of neural network behind ChatGPT but tiny (about 150,000 numbers instead of billions). Instead of words, it reads decades. Each "word" is one decade of one future: population, energy, money, wars, tech count, what era it is, and so on.
- **How it learns.** We run the simulation 400 times with different dice and get 400 different futures. The network reads them and learns to guess "given the last 640 years, what happens in the next 10?". It never sees the dice, only the history.
- **What it does in the app.** At any year, it reads the history so far and imagines a dozen possible next 400 years. You see that as a fan on the charts, with odds such as "chance of a war in the next century". Then you drag the slider forward and check whether it was right.
- **Why it's interesting.** It shows how predictable this universe is. Early on the fan is narrow. Around first contact or a collapse it blows wide open.
- **Built from scratch.** No AI libraries. The network, including the maths that lets it learn (backpropagation), is written by hand in TypeScript (`src/ml/transformer.ts`). It trains on this laptop's CPU in minutes and runs in your browser. No GPUs needed so far.

```bash
node ml/dataset.ts 400          # simulate 400 futures into ml/data/
node ml/train.ts                # train, writes src/ml/weights.ts
node ml/train.ts --gradcheck    # sanity check that the learning maths is right
```

## How it's being built

Everything lands as small commits on the `sim` branch, each one deployed so progress can be watched live.

**Live build:** https://claude.ai/artifact/TPxsi8YkASWSVSbKe89jG6 (private until shared from the page's Share menu)

Several AI agents work in parallel, each in its own copy of the repo:

| Agent | Job |
|---|---|
| **Integrator** | Writes the core, merges everyone's work, deploys. |
| **World checker** | Runs hundreds of futures and checks that they make sense: no negative people, Mars not empty in 2200, war not every century. Tunes the dials toward the research numbers. |
| **Feature builder** | Smooth camera flights, search, colouring by faction, event ticker, mobile layout. |
| **Devil's advocate** | Tries to break it and says what's bad, with three critics: looks (UI), whether things work (functionality), and whether a first-time visitor gets it (UX). |
| **Researcher** | Wrote `research/simulation-bible.md`: real planet data, a 69-technology tree, war and pandemic odds from history, and ideas from The Expanse, Foundation, Three-Body, Red Mars and more. |

## Running it

```bash
npm install
npm run dev           # local dev server
npm run build         # builds one self-contained HTML file into dist/
npm run sim -- 42     # run future #42 in the terminal and print a summary
```

## Map of the code

| Folder | What's in it |
|---|---|
| `src/sim/` | The simulation: world catalog, rules, background worker, the people (`ledger.ts`, `demography.ts`, `lives.ts`), and the living worlds (`geo.ts`, `geoView.ts`) |
| `src/view/` | 3D: galaxies, stars, planets, the zoom levels; `multiverse.ts` above them, `micro*.ts` (body, cell, molecule, atom) below the street |
| `src/micro/` | What a person is made of: their body read from their world and era (`specimen.ts`), cells and organelles (`cells.ts`), molecules atom by atom (`molecules.ts`), elements and electron orbitals (`elements.ts`) |
| `src/ui/` | Time slider, charts, inspector, the residents and biography panels |
| `src/ml/` | The transformer and the forecaster |
| `ml/` | Scripts that make training data and train the network |
| `research/` | Notes, the simulation bible, the invention-model research and the build plan (`ambition-plan.md`) |
| `src/ship/` | The Starship you can board and fly through the simulation (see below) |
| `src/data/` | Observed-data snapshots (CelesTrak, JPL, NOAA, GFZ) with provenance, their adapters, and the mission, facility and organisation registries |
| `src/orbit/` | Earth's thermosphere, the seeded Sun, drag and satellite lifecycles, SGP4 display, the simulated fleet |
| `src/impact/` | Body profiles, impact rates, entry, craters, effects, exposure and the deep-future impact events |

---

## Orbits, atmospheres and impacts

> Educational and strategic simulation: not an operational spaceflight, collision-avoidance, reentry-safety or planetary-defense tool.

- **Data → Orbits & missions.** About 17,000 tracked objects from a CelesTrak GP snapshot, drawn around Earth with SGP4 near their element-set epochs (never as the simulated year). Pick one for its drag regime, ballistic-coefficient range, decay and lifetime ranges under quiet, nominal and disturbed atmospheres, stationkeeping demand and replacement exposure. Also: this future's simulated fleet and what drag under its seeded Sun costs it, the February 2022 Starlink loss as a validation case, a NASA/SpaceX/Blue Origin mission registry with separate roles (owner, operator, customer, launch provider), and the launch, landing and mission-control facilities.
- **Data → Impact Lab** (Solar System Close Approach & Impact Scenario Lab). For all eight planets, the Moon, Pluto and Titan: the body's profile and atmosphere, observed impacts, JPL close approaches (never turned into probabilities), Sentry's official Earth risks, and hypothetical scenarios through body-specific physics (airbursts, craters, plumes on the giants) against the settlements standing at that year.
- **In the engine**, impacts on settled worlds come from this model (not from fixed size classes): each body's own rate, a specific landing point, and damage that depends on the impactor, the atmosphere, the settlement's sites, the warning and the era's planetary defence. The living-worlds model still adds the impact-winter haze and the scar.

Every object, mission and event carries one of seven classifications (historical, active, scheduled, contracted, announced, hypothetical, simulated). Methodology, sources, validation and limitations: `research/orbits-and-impacts.md`. Refresh the observed data with `npm run ingest`; test with `npm run check:orbits` and `npm run check:impacts`.

---

## The Starship: fly this future yourself

Click **Board the Starship** in the header. A Starship-class vehicle appears in front of you, and from then on every trip through the simulation is a flight.

- **Tell it where, and when.** The ship computer (bottom left) takes typed or spoken orders: "take me to Tau Ceti in 3400", "Titan", "random planet", "go back 300 years", "resident 12 of Titan", "cockpit view", "where are we?". It knows every star, world, galaxy and resident in this future, including procedurally generated worlds like "TOI 98077 b".
- **The trip is the simulation.** Jumping between scales (galaxy → stars → system → planet → city) opens the warp tunnel. Moving the year spins up the chrono bubble, blue going forward and amber going back, and the planets, cities, people and Chronicle change around you as time runs.
- **Cameras:** Chase (third person) or Cockpit (first person).
- **Voice (ElevenLabs).** Put `ELEVENLABS_API_KEY=...` in `.env.local` (gitignored). The dev server proxies `/eleven`, so the key never reaches the page. With no key, the ship uses the browser's free speech engines.

Code: `src/ship/`.
- `voyage.ts`: the ship's layer inside the sim's renderer.
- `console.ts`: the ship computer, which turns orders into sim actions.
- `ship.ts` + `starship.ts`: the hull, cockpit, warp tunnel and chrono effects.
- `commands.ts` and `places.ts`: the plain-English parser and the ship's star charts.
- `voice.ts` and `audio.ts`: speech and engine sound.
