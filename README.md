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
| **People** | Every settlement has its real head-count, and you can browse individual residents. People are generated on the fly from the seed, so the sim can "contain" billions without storing billions. |

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
- **Events:** solar storms, habitat breaches, asteroid strikes, breakthroughs, plagues, mutinies, new religions, and humans slowly drifting genetically on low-gravity worlds.

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
| `src/sim/` | The simulation: world catalog, rules, background worker |
| `src/view/` | 3D: galaxies, stars, planets, the five zoom levels |
| `src/ui/` | Time slider, charts, inspector, the people generator |
| `src/ml/` | The transformer and the forecaster |
| `ml/` | Scripts that make training data and train the network |
| `research/` | Notes and the simulation bible |

---

## Starship (branch `starship`)

A first-person / chase-cam spaceflight game: tell the ship where (or when) to go and watch the trip.

```bash
npm install
npm run dev:ship        # opens http://localhost:5173/ship.html
```

- **Talk to it** in the chat bar on the left, by typing or with the mic: "send me to Alpha Centauri", "some random planet", "take me to Mars in the year 3000", "go back 66 million years", "black hole", "Andromeda", "when the sun dies", "cockpit view".
- **Cameras:** Cockpit (first person) and Chase cam (third person). Drag to look around, scroll to zoom the chase cam, double-click to reset.
- **The sky is real 3D data.** Stars and galaxies are drawn from their actual positions, so after a jump the constellations shift, and from Alpha Centauri the Sun is just another star.
- **Time travel** spins up a chrono bubble and runs the clock forward or back. The Solar System changes with it: no Sun before 4.6 billion years ago, a red giant in 6.5 billion, city lights only after 1880, a terraformed Mars and ring habitats in the far future, Andromeda filling the sky as it arrives.
- **Voice (ElevenLabs).** Put `ELEVENLABS_API_KEY=...` in `.env.local` (gitignored). The dev server proxies `/eleven`, so the key never reaches the page. You can also paste a key in the ⚙ panel, which keeps it in browser localStorage only. The panel shows remaining credits. Replies use `eleven_flash_v2_5`, the cheapest model, and repeated lines are cached. The mic uses Scribe speech-to-text. With no key, everything falls back to the browser's free speech engines.
- **Custom ship model:** drop a `.glb` into `public/models/` and open `ship.html?model=<file>.glb` (add `&rot=x,y,z` in degrees if the nose doesn't point forward). The default ship is a Starship-style vehicle built in code (`src/ship/starship.ts`).

Code: `src/ship/` — `places.ts` (destinations, eras), `sky.ts` (star and galaxy shader), `system.ts` (local star systems, black hole, nebulae), `starship.ts` + `ship.ts` (hull, cockpit, warp and chrono effects), `commands.ts` (plain-English parser), `voice.ts` (ElevenLabs and browser speech), `main.ts` (flight, cameras, HUD, chat).
