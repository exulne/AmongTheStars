# Living worlds: geophysics, climate and cosmic events

*Feature spec for 2SOON2026. Elaborated from the request: "geography accurate… geological events,
spatial cosmos events, a little randomness, but over time every planet and every orbit is subject
to physics… weather changing, ice receding… procedural… emphasis on our planets."*

## 1. The goal in one paragraph

Today worlds in the sim are static backdrops: a body has fixed `temp`, `hab`, `flux`, `res`, and
the only physical randomness is a handful of disasters (`Solar storm`, `Asteroid strike`,
`Supernova`, `Gamma-ray burst`) that cut population. After this feature, **every world has a
physical state that evolves**: its climate drifts, ice advances and retreats, seas rise, volcanoes
load the sky with aerosol, impacts leave craters and winters, storms come and go, orbits slowly
precess. Natural processes run on their real rates with seeded randomness; human activity
(industrial warming, terraforming, megastructures, starlight capture) pushes the same state
variables. The result feeds back into habitability, capacity, deaths and the economy, is drawn on
the planets themselves, and is inspectable and chartable like every other metric. The Solar
System gets hand-tuned, sourced detail; exoplanets get the same physics procedurally.

## 2. Principles (non-negotiable, from the project)

- **Deterministic.** All randomness from the seed. Use a *separate* RNG stream for geophysics
  (e.g. `sfc32` seeded by `hash(seed, 0x6e0)`) so that adding geo draws does not reshuffle the
  existing engine stream; geo state must live in `SimState` (typed arrays) and be cloned by
  `snapshot()` / `restore()` so replay from snapshots is exact. `npm run check` (determinism and
  invariants on 30 seeds) and `node scripts/war-mind-check.ts` must pass; re-record
  `ml/rl/golden.json` with `node scripts/war-golden.ts write` because futures will change.
- **Honest and sourced.** Every rate below carries a source. Every number shown in the UI is
  tagged R (real data), E (estimate from real data) or P (procedural), like the explain cards.
- **Cheap.** A full 10,000-year run is currently ~3 s on one core; geophysics may add at most
  ~15%. Update slow variables at the engine's step; only roll events per step per body.
  Unsettled exoplanets can be updated lazily/coarsely (they still need state for when people
  arrive and for the explain cards).
- **Readable.** Keep the minimal UI style (Georgia serif, #f2f2f2 on near-black, underlined
  links, no rounded cards). Plain-English cards.

## 3. State per world (new typed-array block `geo` in SimState, NGEO fields per body)

| Field | Meaning | Notes |
|---|---|---|
| `tAnom` | surface temperature anomaly vs the body's baseline `temp` (K) | natural drift + forcing |
| `ice` | ice cover fraction (0–1), and for Mars split `capN`, `capS` | drives albedo and sea level |
| `sea` | sea level vs 2040 (m) (worlds with oceans) | from ice volume + thermal expansion |
| `pAtm` | surface pressure multiplier vs baseline | terraforming, escape, outgassing |
| `aero` | stratospheric aerosol optical depth | volcanic winters, impact winters |
| `dust` | dust optical depth (Mars, Venus-like, dusty worlds) | storms |
| `cloud` | cloud cover fraction | shader + albedo |
| `vol` | volcanic activity index | per-body baseline, events |
| `scar` | count / list of notable craters and lava fields (lat, lon, radius, year) | drawn on the surface |
| `field` | magnetic field strength multiplier | radiation, auroras |
| `orb*` | slow orbital elements where they matter over 10 kyr: Earth obliquity and precession phase, Moon distance, Mars obliquity | see §5 |

Derived each step: effective `hab` (from temperature, pressure, ice, aerosol, field) replacing the
static value in the formulas that use it; a per-body `climate` summary string for cards.

## 4. Event catalogue (rates are Poisson per body per year unless said; sources at the end)

**Cosmic and impact**
- **Airburst, Chelyabinsk class (~20 m)** on Earth: about once per 30–120 yr [1][2]. Local damage
  only; Chronicle-worthy over cities.
- **Tunguska class (~50–60 m)**: once per few hundred yr (some estimates few thousand) [1][3].
  Regional devastation; if it hits a settlement, heavy deaths.
- **1 km impactor**: once per ~500–700 kyr [1][4] → over 10 kyr ≈ 1.5–2% per future for Earth.
  Global impact winter: `aero` spike, −several K for years, crop failure (shortage), crater scar.
- Rates on other bodies scale by cross-section and gravitational focusing and by location (the
  asteroid belt, Jupiter's neighbourhood) — Jupiter gets Shoemaker-Levy-9-style impacts (dark
  scars that fade over weeks to months).
- **Named near-Earth objects as fixed historical events**: Apophis close pass 13 April 2029 (before
  the sim starts) is lore; comet Swift–Tuttle's 2126 close pass; Halley returns every ~76 yr
  (2061, 2137, …) as visible sky events. (Check exact dates when implementing.)
- **Extreme solar particle events (Miyake class)**: ~1 per 1,000–2,000 yr from tree-ring ¹⁴C
  (774/775 CE, 993 CE, 660 BCE, 7176 BCE, ~12,350 BCE) [5][6]. Carrington-class geomagnetic
  storms are far more frequent (order of a century; weakly sourced) [5]. Effects scale with the
  tech era: a Miyake event in 2300 knocks out grids and orbital infrastructure, kills unshielded
  crews; with planetary magnetic shields (an existing tech) Mars is protected. Replace or refine
  the existing `Solar storm` event with this.
- **Nearby supernova / GRB**: keep the existing events but tie them to real candidates and
  distances (Betelgeuse ~550–700 ly: harmless, but a spectacular sky event; could occur within
  the window with low probability); sterilisation only within tens of ly, which is essentially
  never.
- **Stellar flybys**: none within 10 kyr that matter (Gliese 710 passes in ~1.3 Myr) — mention in
  cards, don't simulate.

**Geological**
- **VEI 7 eruptions** on Earth: 1–2 per 1,000 yr [7][8] → about 10–20 per future. `aero` 0.2–0.5,
  global −0.5 to −1 K for 1–3 yr (Tambora 1815 "year without a summer"), harvest shortfall.
- **VEI 8 supereruption**: once per ~30–130 kyr [7][9] → ~10–30% per 10-kyr future. Multi-year
  volcanic winter, large shortage, Chronicle age-defining.
- **Great earthquakes and tsunamis** (Mw 9+): a few per century on Earth; affects coastal cities.
- **Io**: permanent extreme volcanism (hundreds of active volcanoes), frequent outbursts; affects
  settlements there and is drawn (hot spots on the night side).
- **Enceladus / Europa plumes**, **Triton geysers**: visible features and resource events.
- **Mars**: marsquakes (InSight), occasional fresh impact craters (MRO sees ~200/yr small ones).
- Venus: possible ongoing volcanism (Magellan/VERITAS); low-rate eruptions.

**Weather and seasons (procedural but anchored)**
- **Mars global dust storms**: aperiodic, about one every 3–5 Mars years (≈ every 5.5–9.5 Earth
  years), always starting between Ls 180° and 310° (perihelion season) [10][11]. Solar power
  drops (energy ↓ for solar-dependent settlements), sky drawn orange, rovers/settlements affected.
  Seasonal CO₂ caps grow and recede every Mars year; the southern cap is more variable.
- **Earth**: ENSO-like interannual variability (procedural, ±0.2 K), hurricane seasons; the solar
  11-year cycle (±0.1% irradiance, aurora frequency).
- **Titan**: methane monsoons on its 29.5-yr seasonal cycle; lakes at the poles.
- **Jupiter / Saturn**: belt and zone colour changes, Saturn's ~30-yr Great White Spots, the
  Great Red Spot shrinking (~930 km/yr longitudinally in the 2010s, may become circular ~2040)
  [12] — model as continuing to shrink then stabilising or dissolving, procedurally per future.
- Exoplanets: procedural weather classes from temperature, rotation, tidal locking (terminator
  climates on M-dwarf worlds), atmosphere.

**Climate (slow)**
- **Earth's committed warming and ice**: from the 2040 baseline (+~1.5–2 K over pre-industrial),
  ice sheets keep responding for millennia. Commitment ≈ 2.3 m sea level per °C of warming over
  ~2,000 yr (Antarctica ~1.2 m/°C, thermal expansion ~0.4 m/°C, Greenland nonlinear) [13];
  Greenland can approach complete loss (~7 m) over millennia at high warming. Drive `sea` and
  `ice` from a simple two-timescale response to the temperature anomaly, with the anomaly itself
  set by the sim's own energy/industry trajectory (fossil-free tech arrives → emissions stop;
  but CO₂ persists for tens of millennia [14]). Allow geoengineering / sunshades as technology
  options that pull `tAnom` down (and appear in Chronicle).
- **Glacial cycles**: the next glacial inception is not expected for ~50 kyr naturally and ~100
  kyr with anthropogenic CO₂ [14] — so **no ice age within the window** unless a 1 km impact or a
  supereruption causes a temporary cold snap. Cards should say this.
- **Orbital (Milankovitch) changes within 10 kyr**: Earth's obliquity is decreasing ~47″ per
  century (≈ −1.3° over 10 kyr, within its 22.1–24.5° 41-kyr cycle) [15]; axial precession
  (~25.7 kyr) moves perihelion from northern winter today toward northern summer in ~13 kyr [15]
  → northern seasons become more extreme by the end of the window. Implement these as
  deterministic functions of year (no randomness) and show them in Earth's card and in the
  seasons drawn.
- **The Moon** recedes ~3.8 cm/yr (≈ 380 m over 10 kyr; the day lengthens ~1.7 ms/century) —
  deterministic, shown in cards (tiny but real).
- **Mars obliquity** is chaotic over Myr but changes negligibly within 10 kyr; say so.
- **Saturn's rings** lose mass to ring rain over ~100–300 Myr [16] — negligible within 10 kyr,
  card fact only.
- **The Sun** brightens ~1% per ~110 Myr — negligible; card fact only.

**Human forcing (the sim already knows these)**
- Industrial warming on Earth until clean energy; waste heat from huge energy use (the engine
  already has waste-heat caps) raises `tAnom` on crowded worlds.
- **Terraforming** (existing techs `paraterraform`, `terraform`, magnetic shield, the shader's
  `uTerra`): instead of a flag, drive `pAtm`, `tAnom`, `ice` (polar caps melting into seas) and
  `cloud` gradually from energy spent; Mars visibly greens and gets oceans over centuries, Venus
  cools under sunshades. Failed or abandoned terraforming slowly reverts.
- Starlifting / Dyson swarms dim the star as seen from its planets (cooling) — tie to the
  existing swarm coverage.

## 5. Coupling to the simulation

- Effective habitability and capacity: shortage from crop failure in volcanic/impact winters;
  deaths from local disasters scaled by population density and tech (shielding, reliability);
  energy loss in dust storms for solar settlements; coastal capacity loss with sea-level rise on
  Earth (modest — Earth stays habitable); terraformed worlds gain capacity.
- Events go into the event log with the body and magnitude, so the Chronicle, ticker, annals and
  ages can name them ("the Long Winter of 3412", "the Mars Storm of 2093").
- Existing `Asteroid strike`, `Solar storm`, `Supernova`, `Gamma-ray burst` should be reworked to
  use the new physical rates rather than removed (keep the names for compatibility with
  chronicle/ticker code), and new event types appended to the end of `EVENT_NAMES` (appending
  keeps indices stable).
- The trained war minds (src/ml) observe state that may shift; that's fine, they're robust to
  new futures; just re-run `war-mind-check`.

## 6. What the user sees

- **Planet view** (src/view/planetShader.ts): new uniforms for ice extent (both poles, Mars caps
  growing/receding with the Mars season in real time as the slider moves), sea level (coastlines
  creep on Earth), cloud cover, dust (Mars goes orange-hazed in a global storm), aerosol (dimmed,
  reddened skies after eruptions), fresh craters and lava fields as scars, Io's hot spots,
  Jupiter's belts and a shrinking Great Red Spot, Titan's lakes, aurora at the poles during solar
  events. Must stay non-clipping under the per-level exposure (`LEVEL_LOOKS` in eraMood.ts).
- **System view**: comets with tails on their real orbits (Halley), visible impact flashes.
- **Inspector**: a "Climate and geology" section for each world: current temperature vs
  baseline, ice, sea level, pressure, aerosol/dust, active hazards, last big events, the orbital
  facts (Earth obliquity/precession, Moon distance), with a sparkline; every value R/E/P tagged.
- **Explain cards** for craters, storms, volcanic plumes, caps (pickable where drawn).
- **Charts and data desk**: new global metrics (Earth temperature anomaly, sea level, volcanic
  aerosol, impacts so far) and per-settlement fields queryable in the query language.
- **Chronicle**: geophysical events written up with named people affected, like other events.
- README: a plain-English section.

## 7. Verification

- `npx tsc --noEmit`, `npm run build`, `npm run check`, `npm run check:explain`, `npm run
  check:data`, `node scripts/war-mind-check.ts`.
- New `scripts/geo-check.ts`: over many seeds, event rates match the configured rates (Poisson
  confidence bands); Earth's sea level and temperature stay in physically sane ranges; replay
  from a snapshot reproduces geo state exactly; Mars caps follow the Mars year; Earth obliquity
  at 12040 ≈ 22.1–22.3°.
- Performance: full run time within +15% of before (measure with a headless timing script).
- Visual: headless Chrome screenshots of Earth, Mars (in and out of a dust storm, both cap
  seasons), Jupiter, Io, Titan, a post-eruption Earth, a terraformed Mars.

## Sources

1. Catalina Sky Survey FAQ, "How often do asteroids strike Earth?" https://catalina.lpl.arizona.edu/faq/how-often-do-asteroids-strike-earth
2. Science News on Chelyabinsk-size frequency (Brown et al. 2013, Nature). https://www.sciencenews.org/?p=15053
3. NASA, "Tunguska revisited". https://www.nasa.gov/solar-system/tunguska-revisited-111-year-old-mystery-impact-inspires-new-more-optimistic-asteroid-predictions/
4. Chodas, "Protecting Earth" (KISS short course). https://kiss.caltech.edu/workshops/neo/presentations/ShortCourse_Chodas-Protecting_Earth.pdf
5. Royal Society 2025 meeting, "Radiocarbon and cosmic radiation events". https://waftest2.royalsociety.org/science-events-and-lectures/2025/05/radiocarbon
6. Discover, "A record-setting solar storm hit the Earth 14,300 years ago". https://www.discovermagazine.com/a-record-setting-solar-storm-hit-the-earth-14-300-years-ago-according-to-45454
7. Wikipedia, "Volcanic explosivity index". https://en.wikipedia.org/wiki/Volcanic_explosivity_index
8. Rutgers-hosted VEI 7 paper. https://climate.envsci.rutgers.edu/pdf/VEI7ges01513.pdf
9. Discussion citing VEI 8 recurrence estimates (30–130 kyr). https://ea.greaterwrong.com/posts/o7DxtCiRKa8vu7cNp/paper-interventions-that-may-prevent-or-mollify/comment/mH37hpcbJinSyaPv4
10. Wolkenberg et al., MY 25/28/34 global dust storms (INAF). https://openaccess.inaf.it/handle/20.500.12386/32409
11. MSL navcam study of the MY34 global dust storm. https://arxiv.org/pdf/2008.01968
12. NASA/JPL, "Jupiter's Great Red Spot is smaller than ever measured"; Sky & Telescope. https://jpl.nasa.gov/news/jupiters-great-red-spot-is-smaller-than-ever-measured , https://www.skyandtelescope.com/astronomy-news/jupiters-shrinking-red-spot/
13. Levermann et al. 2013, PNAS, "The multimillennial sea-level commitment of global warming". https://pmc.ncbi.nlm.nih.gov/articles/PMC3752235
14. Carbon Brief on Ganopolski et al. 2016 (next glacial inception). https://www.carbonbrief.org/human-emissions-will-delay-next-ice-age-by-50000-years-study-says/
15. Wikipedia, "Axial tilt" (obliquity rate, cycles, precession). https://en.wikipedia.org/wiki/Axial_tilt
16. Live Science / Space.com on Saturn ring rain (O'Donoghue et al. 2018). https://livescience.com/64336-saturn-will-lose-its-rings.html
