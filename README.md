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
| **Zoom levels** | Universe → Milky Way → Local neighbourhood → Star system → Planet → City → Person. Click to go deeper, use the breadcrumb at the top to go back up. |
| **Charts** | Lines over time for 39 measures: population, energy, wealth, knowledge, settlements, stability, wars, resources and more. Pick any one from each chart's menu, and click a chart to jump to that year. |
| **Future #** (top) | Each number is a different roll of the dice, so a different future. "Another future" picks one at random. |
| **Inspector** (right side) | Click anything and you get every number about it, at the year you're on. |
| **People** | Every settlement lists its residents, all of them real and persistent. Open anyone to read their life: where they were born, who their parents were, their partner, their children, where they moved, the plague they lived through, how they died. Click their mother, then her mother, and so on back to the generation ship and the world it left. |
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
- **Events:** solar storms, habitat breaches, asteroid strikes, breakthroughs, plagues, mutinies, new religions, and humans slowly drifting genetically on low-gravity worlds.

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
| `src/sim/` | The simulation: world catalog, rules, background worker, and the people (`ledger.ts`, `demography.ts`, `lives.ts`) |
| `src/view/` | 3D: galaxies, stars, planets, the five zoom levels |
| `src/ui/` | Time slider, charts, inspector, the residents and biography panels |
| `src/ml/` | The transformer and the forecaster |
| `ml/` | Scripts that make training data and train the network |
| `research/` | Notes, the simulation bible, the invention-model research and the build plan (`ambition-plan.md`) |
| `src/ship/` | The Starship you can board and fly through the simulation (see below) |

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
