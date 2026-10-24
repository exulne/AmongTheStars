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
| **Charts** | Lines over time: population, energy, wealth, knowledge, number of settlements, stability, and more. You can pick which ones to show. |
| **Inspector** (right side) | Click anything and you get every number about it, at the year you're on. |
| **People** | Every settlement has its real head-count, and you can browse individual residents. People are generated on the fly from the seed, so the sim can "contain" billions without storing billions. |

## How it works under the hood (still plain English)

- **`src/sim/`** is the engine. It runs in the background (a Web Worker) so the page stays smooth. It simulates year by year early on, then in bigger jumps later when things change slowly. Every 250 years it saves a full picture of the universe. When you jump to year 4,321 it loads the 4,250 picture and replays the last 71 years, which gives an exact answer quickly.
- **`src/view/`** draws everything in 3D with three.js: glowing particle galaxies, stars, orbits, planets with city lights.
- **`src/ui/`** holds the slider, charts, inspector and breadcrumb.
- **`research/`** holds the research notes and the "simulation bible": real numbers on planets, technologies, events, and ideas borrowed from sci-fi.

### The rules, roughly

- **Population** grows until it hits what the habitat can support. Better tech means bigger habitats.
- **Energy** comes from solar power (weaker further from the Sun), then fission, fusion, and eventually star-scale collectors (Dyson swarms).
- **Resources:** water, metals, volatiles (gases for fuel and air), rare elements, helium-3. Each world has different amounts. Ice moons have water, metal asteroids have metal.
- **Knowledge** accumulates from people doing research. It unlocks technologies in a tree (you can't build a fusion ship without fusion).
- **Expansion:** rich, stable settlements send ships to nearby worlds. Interstellar trips take decades to centuries, and some ships never arrive.
- **Politics:** humanity as a whole moves between moods such as expansion, golden age, stagnation, war, pandemic and collapse, and each mood changes the dice. Far-off colonies with long light-delay to Earth tend to declare independence.
- **Events:** solar storms, habitat breaches, asteroid strikes, breakthroughs, plagues, mutinies, new religions, and humans slowly drifting genetically on low-gravity worlds.

## Running it

```bash
npm install
npm run dev        # local dev server
npm run build      # builds one self-contained HTML file into dist/
```

## Status

Built in small commits so progress can be followed live. See `git log`.
