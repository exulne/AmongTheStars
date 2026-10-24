# Simulation Bible: Humanity 2040 to 12,040

Implementation reference for the stochastic Markov-chain and agent-based expansion sim. Every number here is meant to be a **default parameter**. Expose all of them in one config object so runs can be tuned and scenarios compared.

Status tags used throughout:
- **[R]**: real, sourced or well-established value (rounded).
- **[E]**: engineering estimate or extrapolation from real data.
- **[D]**: design parameter. Invented for gameplay and calibrated for plausibility, so tune it freely.
- **[S]**: speculative physics. Treat as a low-probability wildcard.

---

## 0. Conventions and core loop

### 0.1 Units

| Quantity | Unit in sim | Notes |
|---|---|---|
| Time | year (float); tick = 1 yr default | Use 1 yr ticks to 2300, then optionally 10 yr ticks for interstellar-only bookkeeping |
| Distance (in-system) | AU | 1 AU = 1.496e8 km = 499.0 light-seconds |
| Distance (interstellar) | light-year (ly) | 1 ly = 63,241 AU = 9.461e12 km; 1 pc = 3.2616 ly |
| Mass | tonne (t) or kg | |
| Energy flow | W (store as float64, log10 for display) | |
| Energy stock | J | 1 EJ = 1e18 J; 1 TW·yr = 3.156e19 J |
| Money | "credit" (cr) = 1 USD (2024) | Only meaningful inside connected trade networks |
| Knowledge | KP (knowledge points) | See §3.1 |
| Velocity | km/s in system; fraction of c interstellar | c = 299,792 km/s |
| Probabilities | per year unless stated "per decade" or "per event" | |

### 0.2 Probability conversion rules (use everywhere)

- Annual probability `p` to tick of length `dt` years: `p_dt = 1 - (1 - p)^dt`.
- Hazard rate `h` (per yr) to probability: `p_dt = 1 - exp(-h * dt)`.
- Per-decade matrix `M10` to annual: off-diagonal `a_ij ≈ M10_ij / 10`, diagonal `a_ii = 1 - Σ_{j≠i} a_ij` (first-order. It holds the stationary distribution exactly and is accurate to about 5% for these rates.)
- Modifiers multiply **off-diagonal** probabilities. Then clamp each to `[0, 0.95]` and renormalize the row by rescaling the diagonal. If off-diagonals sum to more than 0.95, scale them down proportionally.
- All 0-1 "scores" are linear unless stated. Combine scores by weighted geometric mean when any zero must veto (habitability) and by weighted arithmetic mean otherwise.

### 0.3 Core tick order (per year)

1. Astronomy: update orbital positions (Keplerian, circular approximation acceptable), light-lag matrix, and transfer-window flags.
2. Regime step: roll regime chains at the global level and for each polity (every 10 yrs, or annualized every tick).
3. Events: roll the event catalog (§6) per scope.
4. Economy: production (§7.2), consumption, stock updates, trade flows (§7.5).
5. Population: births, deaths, and migration (§7.3), with carrying capacity recomputed.
6. Research: KP produced and allocated, tech completions, tech diffusion with light-lag delay.
7. Agent decisions (§7.8): launch ships, build infrastructure, declare war or independence.
8. Settlement lifecycle Markov step (§4).
9. Ships in transit: advance, roll per-voyage hazards, handle arrivals.
10. Metrics snapshot (§10). Write a full snapshot every year for the first 500 yrs, then every 10 yrs plus every event-touched settlement.

### 0.4 Scopes

`Settlement` (one body or habitat) ⊂ `System` (star system) ⊂ `Polity` (political unit that may span settlements) ⊂ `Civilization` (all humans plus descendants). Regimes run at Polity scope, and Earth is its own polity group at start. Events declare their scope.

---

## 1. Real baseline (sim year 0 = 2040)

### 1.1 Earth starting state (2040)

| Variable | 2040 value | Source / basis |
|---|---|---|
| Population | 9.2e9 (p10 9.1e9, p90 9.3e9) | [R] UN WPP 2024 medium: 9.0B in 2037, 10.0B in 2061, peak 10.3B mid-2080s |
| Population peak | 10.3e9 around 2084, then a slow decline | [R] UN WPP 2024 |
| Total fertility rate (TFR) | 2.1 (replacement reached around 2036) | [R] UN WPP 2024: 2.25 in 2024 |
| Crude birth / death rate | 15.5 / 8.5 per 1000 per yr | [E] |
| Life expectancy at birth | 76 yr | [E] (73.3 in 2024) |
| Median age | 34 yr | [E] (30.9 in 2024) |
| Primary energy use | 21 TW (6.6e20 J/yr) | [E] from [R] 592 EJ in 2024 (18.8 TW), +0.8%/yr |
| Electricity (average) | 4.6 TW (≈40,000 TWh/yr) | [E] (≈31,000 TWh in 2024) |
| Fossil share of primary | 70% | [E] (86.6% in 2024) |
| Per-capita energy | 2.3 kW mean; range 0.1 kW (poorest) to 10 kW (USA) | [R/E] |
| Kardashev rating (Sagan) | K = (log10(2.1e13) − 6)/10 = 0.73 | [E] |
| World GDP | 1.7e14 cr/yr (2024 USD) | [E] ~1.1e14 nominal in 2024, +2.7%/yr real |
| Space economy | 2.0e12 cr/yr (≈1.2% GDP) | [E] $613B in 2024 (Space Foundation), $1.8T projected for 2035 (WEF/McKinsey) |
| Researchers (FTE) | 1.5e7 | [E] UNESCO ≈8.8M in 2018, +3%/yr |
| Space-relevant research share | 5% | [D] |
| Satellites in orbit | 60,000 active, 1.5e6 debris >1 cm | [E] ≈10k active in 2024; megaconstellations |
| Tracked debris >10 cm | 60,000 | [E] |
| Humans off-Earth at t0 | ≈50–200 (LEO stations plus a lunar base of 4–20) | [E] |
| Lunar outpost | crewed outpost state (Artemis/ILRS successors), 8–20 people rotating | [E] |
| Mars | first crewed landing in 2040 (premise): 4–12 crew, arrives from the late-2039 window | Premise |
| Nuclear warheads | ≈10,000 | [R/E] |
| Arable land | 1.5e7 km² | [R] |

### 1.2 Launch cost trajectory (cost to LEO, 2024 USD per kg)

| Year | System | $/kg LEO | Notes |
|---|---|---|---|
| 1981–2011 | Space Shuttle | 54,500 | [R] |
| 2010–2024 | Falcon 9 (reusable) | 2,700 (customer price); ≈1,000 internal | [R] |
| 2018– | Falcon Heavy | 1,500 | [R] |
| 2028 | Starship V3 (early ops) | 500–1,000 | [E] |
| 2035 | Starship mature, rapid reuse | 150–300 | [E] analyst targets $100–200/kg |
| **2040 (t0)** | Starship-class fleet, tanker ops routine | **100 (p10 50, p90 300)** | [E] |
| 2060 | Fully reusable, ≥3 vendors | 30–60 | [E] |
| Floor (chemical) | propellant + ops | ≈10–20 | [E] ≈4,600 t methalox ≈ $1–2M per launch / 100–150 t |
| Non-rocket (space elevator / launch loop) | energy cost only | 1–5 | [E] LEO specific energy ≈33 MJ/kg ≈ 9 kWh |

**Model:** `launch_cost_LEO(t) = floor + (C0 − floor) × exp(−(t − 2040)/τ)`, with C0 = 100, floor = 15, τ = 25 yr. Then multiply by tech multipliers (§3) and the Kessler multiplier (event E06).

**Mars surface delivery cost:** `cost_mars_surface ≈ launch_cost_LEO × (1 + N_tankers) × 1.1 + ops`. 2040: N_tankers ≈ 8 (100–150 t transferred per tanker, about 1,200–1,500 t of propellant per ship), so ≈ **1,500–3,000 cr/kg** to the Mars surface. With Mars ISRU return propellant, that falls to ≈ 500 cr/kg by 2060.

### 1.3 Vehicle classes (starting catalog and plausible successors)

| Class id | Example | Payload to LEO (t) | Payload to Mars surface (t) | Crew | Dry mass (t) | Prop (t) | Isp vac (s) | Available | Cost / flight (cr) |
|---|---|---|---|---|---|---|---|---|---|
| V_F9 | Falcon 9 | 17 (reusable) | – | 4 | 25 | 410 | 348 | t0 | 3e7 |
| V_SS2 | Starship V2 | 50–100 | – | – | 100 | 1,200 | 378 | 2025 | 1e8 → 2e7 |
| V_SS3 | Starship V3/V4 | 100–150 (expendable ≈200+) | 100 (needs ≈8–10 refills) | 12–24 early; 100 nominal | 120–150 | 1,500–2,300 | 380 | t0 | 2e7 → 5e6 |
| V_TANK | Starship tanker | 100–150 t prop transferred | – | 0 | 120 | 1,500 | 380 | t0 | 1e7 |
| V_NTR | Nuclear thermal transport | – | 150–300 | 50 | 300 | 1,000 LH2 | 900 | 2050+ | 3e8 |
| V_NEP | Nuclear electric cargo tug | – | 500 (slow, 2–3 yr) | 0 | 200 | 100 Xe/Ar | 3,000–10,000 | 2070+ | 2e8 |
| V_CYC | Aldrin cycler station | – | (cycler) | 100–1,000 | 5,000 | – | – | 2070+ | build 5e10 |
| V_DFD | Direct fusion drive ship | – | 1,000 | 100–1,000 | 2,000 | 500 | 10,000–100,000 | 2120+ | 1e9 |
| V_TORCH | High-thrust fusion torch | – | 10,000 | 5,000 | 20,000 | – | 1e5–1e6 | 2200+ [S] | 1e10 |

Notes:
- Starship V3: ≈124 m stack, 33 Raptor 3 engines on the booster. It is designed for 100+ t to LEO reusable [R/E]. Early Mars flights will likely carry 12–24 crew, not 100 [E].
- Mars landing requires on-orbit refilling. Each 100 t to Mars costs about 8–10 launches [E].

### 1.4 Mars transfer windows

| Parameter | Value | Source |
|---|---|---|
| Synodic period Earth–Mars | 779.94 d = 2.135 yr (≈26 months) | [R] |
| Hohmann transfer time | 259 d | [R] |
| Fast transfer (Starship, higher C3) | 90–180 d | [E] |
| Window duration (useful) | ≈30–60 d around the optimum | [E] |
| Window quality cycle | ≈15–17 yr (perihelic oppositions, e.g. 2035, 2050) | [R] |
| Δv LEO → trans-Mars injection | 3.6 km/s (Hohmann), 4.3–6 km/s (fast) | [R] |
| Mars entry | aerobraking/aerocapture; propulsive landing ≈0.7–1 km/s | [E] |

**Window list (departure from Earth, ±1 month)** [E]: 2026-11, 2029-01, 2031-03, 2033-05, 2035-07, 2037-09, **2039-11 (premise landing mid-2040)**, 2042-01, 2044-03, 2046-05, 2048-07, 2050-09, … then every +26.2 months.

**Implementation:** `window_open(t) = cos(2π (t − t_ref)/2.135) > 0.95` with t_ref = 2039.88. Window quality is `q = 0.75 + 0.25 cos(2π (t − 2035.7)/15.8)`, which scales the payload fraction. Apply the same synodic logic to every pair of bodies: `T_syn = 1/|1/P1 − 1/P2|`.

**Synodic periods from Earth** [R]: Venus 1.60 yr, Mars 2.135, Ceres 1.28, Jupiter 1.092, Saturn 1.035, Uranus 1.012, Neptune 1.006. Outer planets have a window roughly every year, but the trips are long.

### 1.5 Delta-v map (approximate, km/s, one-way, impulsive) [R/E]

| Leg | Δv | Notes |
|---|---|---|
| Earth surface → LEO | 9.4 | including gravity and drag losses |
| LEO → GEO | 3.9 | |
| LEO → Earth escape (C3=0) | 3.2 | |
| LEO → Earth–Moon L1/L2/L5 | 3.4–3.8 | |
| LEO → low lunar orbit | 4.0 | |
| LLO → lunar surface | 1.7 | Moon surface → LLO also 1.7, and escape is 2.38 |
| LEO → Mars transfer | 3.6 | |
| Mars transfer → LMO (propulsive) | 2.1 | 0–0.5 with aerocapture |
| LMO → Mars surface | 0.7 with aerobraking (4.1 without) | |
| Mars surface → LMO | 4.1 | escape 5.0 |
| Mars surface → Earth return transfer | 6.0–6.5 | |
| LEO → Venus transfer | 3.5 | |
| LEO → Mercury orbit | 13 | |
| LEO → Ceres orbit | 9.5 | Ceres surface ↔ orbit 0.5 |
| LEO → Vesta orbit | 10 | |
| LEO → typical NEA (NHATS accessible) | 4.5–6 | ≈1,500+ NEAs under 6 km/s |
| LEO → Jupiter transfer | 6.3 | capture to Callisto orbit +≈2.5–4 (gravity assists) |
| LEO → Saturn transfer | 7.3 | Titan aerocapture possible |
| LEO → Uranus transfer | 8.0 | |
| LEO → Neptune transfer | 8.2 | |
| LEO → solar escape | 8.8 | |
| Mars ↔ Ceres | ≈5–6 | |
| Jupiter system intramoon (Callisto ↔ Ganymede) | ≈2.5–3 | |

**Trade cost uses Δv** via the rocket equation (§7.5). Store a symmetric `dv[i][j]` matrix for Solar System bodies. For pairs not listed, use the Hohmann estimate `dv ≈ |v_circ(a1) − v_transfer| + |v_transfer2 − v_circ(a2)|` with the Sun's μ = 1.327e11 km³/s², plus a surface/orbit term `≈ 1.3 × v_escape` for bodies with surfaces, minus atmosphere assist where available.

### 1.6 Light-lag (one-way)

| Pair | Min | Max | Typical |
|---|---|---|---|
| Earth–Moon | 1.28 s | 1.35 s | 1.3 s |
| Earth–Mars | 3.0 min | 22.3 min | 12.5 min |
| Earth–Venus | 2.3 min | 14.5 min | |
| Earth–Ceres | 9.5 min | 31 min | |
| Earth–Jupiter | 33 min | 53 min | 43 min |
| Earth–Saturn | 68 min | 84 min | 76 min |
| Earth–Uranus | 2.6 h | 2.8 h | 2.7 h |
| Earth–Neptune | 4.0 h | 4.2 h | 4.1 h |
| Earth–Pluto | 4.1 h | 6.8 h | 5.5 h |
| Earth–Proxima | 4.25 yr | | |
| Earth–TRAPPIST-1 | 40.7 yr | | |

**Formula:** `lag_s = distance_km / 299792.458`. Use instantaneous positions. Lag drives: information friction in trade (§7.5), tech diffusion delay (a tech known at i becomes "available to copy" at j after `lag + transport_time_of_experts`), governance effectiveness (§5 modifiers), and secession pressure.

### 1.7 Solar flux by distance [R]

`S(a) = 1361 / a²` W/m² (a in AU). The habitable-zone equivalent for another star is `a_HZ ≈ sqrt(L/L☉)` AU.

| Body | a (AU) | Flux (W/m²) | Relative to Earth |
|---|---|---|---|
| Mercury | 0.387 | 9,087 | 6.68 |
| Venus | 0.723 | 2,604 | 1.91 |
| Earth/Moon | 1.000 | 1,361 | 1.00 |
| Mars | 1.524 | 586 | 0.43 |
| Vesta | 2.36 | 244 | 0.18 |
| Ceres | 2.77 | 177 | 0.13 |
| Psyche | 2.92 | 160 | 0.12 |
| Jupiter | 5.20 | 50.3 | 0.037 |
| Saturn | 9.54 | 14.9 | 0.011 |
| Uranus | 19.19 | 3.70 | 0.0027 |
| Neptune | 30.07 | 1.51 | 0.0011 |
| Pluto | 39.48 | 0.87 | 6.4e-4 |
| Eris | 67.9 | 0.30 | 2.2e-4 |
| Sedna (mean a) | 506 | 0.005 | 4e-6 |

**PV practicality** [E]: 2040 space PV is 30% efficient at ≈300 W/kg array at 1 AU, so specific power scales as `300/a²` W/kg. Beyond ≈5 AU, solar loses to fission or fusion: set `solar_viable = flux > 40 W/m²` unless concentrators are teched (×10 effective flux with mirrors, tech N19+). Surface PV on Mars loses ≈40–60% to dust, latitude and night (capacity factor ≈0.20–0.25, versus ≈0.6–0.9 in free space).

### 1.8 Early colony sizes and minimum viable population

| Item | Value | Source |
|---|---|---|
| First Mars crew (2040) | 4–12 | [E] premise |
| Mars by 2050 (p10/p50/p90) | 20 / 120 / 600 | [D] calibration target |
| Mars by 2070 | 200 / 2,000 / 20,000 | [D] |
| Mars by 2100 | 1e3 / 2e4 / 3e5 | [D] |
| SpaceX aspirational | 1e6 people via ≈1,000 ships per window | [R] stated goal; treat as the p99 case |
| Antarctic analog | ≈1,000 winter / 5,000 summer across ≈70 stations | [R] |
| Minimum crew, 6,300-yr generation voyage (HERITAGE sim) | 98 | [R] Marin & Beluffi 2018 |
| Minimum for multi-generation ship (anthropologist) | 150–180 | [R] Moore 2003 |
| Multi-generation colony preserving diversity | 14,000–44,000 | [R] Smith 2014 |
| Conservation "50/500" rule (N_e) | 50 short-term, 500 long-term | [R] Franklin 1980 |
| Median vertebrate MVP | 4,169 | [R] Traill et al. 2007 |
| Self-sufficient industrial base (no frozen embryos, no AGI) | 1e5–1e6 | [E] (Musk ≈1e6; Metzger 2013 bootstrapping with robots ≈ hundreds of tonnes seed) |

**Genetic rule** [R formula / D params]: effective population `N_e ≈ 0.4 × N`. Inbreeding increases by `ΔF = 1/(2 N_e)` per generation (25 yr). Health and fertility penalty `= 1 − 0.5 × F` on fertility, plus `+F × 0.02` added to annual mortality. Gene banks (frozen embryos/gametes, tech M22) set the effective `N_e = max(N_e, bank_size × 0.5)`.

### 1.9 Per-person consumables (no recycling) [R NASA BVAD / E]

| Consumable | kg/person/day | With 2040 ECLSS (ISS-class) | With closed loop 99% |
|---|---|---|---|
| O2 | 0.84 | 0.42 (≈50% recovered) | 0.008 |
| Drinking + food water | 3.5 | 0.07 (98% recovered) | 0.035 |
| Hygiene water | 7–25 (variable) | 0.3 | 0.1 |
| Food (dry mass) | 0.62 (≈1.8 kg wet) | 0.62 | 0.0–0.1 (local agriculture) |
| Spares and consumable hardware | 0.5–1.0 | 0.5 | 0.1 |
| Power, survival only | 2–5 kW/person | | |
| Power, outpost with ISRU and greenhouse | 10–25 kW/person | | |
| Power, mature colony | 5–10 kW/person (Earth average 2.3, US 10) | | |
| Pressurized volume | ISS ≈55 m³/person; long-duration minimum ≈25 m³; comfortable ≥100–120 m³ | | |
| Greenhouse area for 100% food | 40–60 m² per person (LED, high-yield); ≈200 m² low-intensity | | |
| Food-growing power | ≈1–1.5 kW/m² LED → ≈30–60 kW/person if fully artificial light | [E] which is why food dominates the energy budget |

**Resupply mass per person-year at t0:** ≈ 0.42+0.07+0.3+0.62+0.5 ≈ 1.9 kg/d ≈ **0.7 t/person/yr**. At 2,000 cr/kg to Mars, that is ≈1.4e6 cr/person/yr. This is the core economic driver for the ISRU and closed-loop techs.

### 1.10 ISRU processes [R chemistry / E energy]

| Process | Reaction / method | Inputs | Output | Energy (kWh/kg product) | Where |
|---|---|---|---|---|---|
| Ice mining + melt | heat/excavate | ice-cemented regolith (5–60% water) | H2O | 1–3 (ice), 5–10 (hydrated regolith, 3% water) | Moon poles, Mars mid-lat, Ceres, outer moons |
| Electrolysis | 2H2O → 2H2 + O2 | water | O2, H2 | ≈55 per kg H2 (≈5 per kg O2-equivalent) | anywhere |
| Sabatier | CO2 + 4H2 → CH4 + 2H2O | Mars air (95% CO2), H2 | CH4 | ≈ 10–15 for full methalox incl. water extraction | Mars |
| MOXIE-type SOXE | 2CO2 → 2CO + O2 | CO2 | O2 | ≈ 25–50 at scale | Mars (MOXIE 2021–23: 122 g total, max 12 g/h) |
| Molten regolith electrolysis | oxides → metal + O2 | lunar/Mars regolith | Fe, Si, Al, Ti, O2 | 10–20 per kg O2 | Moon, Mars, asteroids |
| Hydrogen reduction of ilmenite | FeTiO3 + H2 → Fe + TiO2 + H2O | mare regolith | O2 (1–5% yield) | ≈ 25 | Moon |
| Carbonyl (Mond) process | Fe/Ni + CO → carbonyls → pure metal | M/S-type asteroid metal | Fe, Ni, Co, PGM residue | 2–5 | asteroids |
| Regolith sintering / 3D print | microwave/laser sinter | regolith | structures | 0.5–1 | everywhere |
| He-3 extraction | heat regolith to 700 °C | mare regolith (≈5–30 ppb He-3) | He-3 + H2, N2, CO, He-4 | ≈ 1e5 tonnes regolith per kg He-3; net energy positive only with fusion | Moon |
| Atmospheric scoop | aerostat / scoop ship | gas giant atmosphere | H2, He-3 (He-3/He-4 ≈1e-4) | | Uranus/Saturn preferred (shallower wells) |

Rule of thumb [E]: one Starship's full Mars return load (≈1,200 t methalox) takes ≈15–20 GWh, which is ≈1 MW continuous over one synodic period.

### 1.11 Lunar resources [R/E]

| Resource | Amount | Notes |
|---|---|---|
| Polar water ice | 1e8 – 1e9 t (best guess 6e8 t) | LCROSS: 5.6 ± 2.9 wt% in Cabeus; Mini-RF craters |
| Regolith oxygen | ≈43% by mass | everywhere |
| Iron (FeO) | mare 15–22% FeO; highland ≈5% | |
| Titanium (TiO2) | high-Ti mare up to 10–13% (ilmenite) | |
| Aluminum (Al2O3) | highlands 26–28% | |
| He-3 | ≈1e6 t total (range 1e6–5e6 t extrapolated); 2–30 ppb, mare highest | [R/E] USGS rates it "probably unmineable" at today's tech |
| KREEP (K, REE, P, Th, U) | Procellarum; U ≈1–5 ppm in KREEP | |
| Solar power | 1,361 W/m²; peaks of near-eternal light at the poles (≈80–90% illuminated) | |
| Surface radiation | 1.37 mSv/day (Chang'e-4 LND) | [R] |
| Gravity | 0.165 g | |

### 1.12 Mars resources [R/E]

| Resource | Amount / concentration |
|---|---|
| Atmosphere | 95% CO2, 2.8% N2, 2.0% Ar; mean surface pressure 610 Pa (0.6% of Earth) |
| Water ice (total) | ≈5e6 km³ (equivalent to a 35 m global layer); polar caps ≈3e6 km³ |
| Mid-latitude buried ice | widespread at 30–60° latitude, < 1–10 m depth (SWIM project) |
| Regolith water | 1.5–3 wt% equatorial (Curiosity); 5–60% high latitude |
| Regolith oxides | SiO2 45%, FeO 18%, Al2O3 10%, MgO 8%, CaO 7%, SO3 6%, perchlorate 0.5–1% (toxic) |
| Deuterium | D/H ≈ 5–7× Earth (enriched) |
| Geothermal | weak; possible local residual heat |
| Surface radiation | 0.64 mSv/day ≈ 233 mSv/yr (Curiosity RAD) [R] |
| Cruise radiation | 1.84 mSv/day [R] |
| Global dust storms | ≈ one every 3 Mars years (≈5.5 Earth yr); local storms every season |
| Day length | 24 h 39 min 35 s |

### 1.13 Asteroid resources [R/E]

**Main belt totals:** mass ≈ 2.4e21 kg (≈3% of the Moon). Ceres ≈ 39%, and Vesta + Pallas + Hygiea ≈ 21%. NEAs known: >38,000 (2025). NEAs ≥1 km: ≈ 950 (≈95% found). Accessible (Δv from LEO < 6 km/s): ≈ 1,500+.

| Type | Share (main belt, by count of classified) | Location | Water % (hydrated or ice) | FeNi metal % | Silicates % | Carbon/organics % | PGM (ppm) | Meteorite analog | Use |
|---|---|---|---|---|---|---|---|---|---|
| C (Cb, Cg, B, Ch) | ≈75% | outer belt (2.7–3.3 AU), many NEAs | 5–20 | 0–5 | 60–70 | 2–5 | 0.5–1 | CI/CM chondrite | water, propellant, carbon, shielding, soil |
| S | ≈17% | inner belt (2.1–2.7 AU), most NEAs by discovery | < 1 | 10–25 | 75–85 | < 0.5 | 1–5 | ordinary chondrite (H 15–20% metal, L 7%, LL 2%) | silicates, metal byproduct |
| M (X-complex) | ≈8% | mid belt (≈2.7–3 AU) | 0 (some hydrated "W") | 30–95 (Psyche ≈30–60 vol% by density, earlier estimates 82%) | 5–70 | < 0.5 | 10–100 | iron, enstatite chondrite | iron, nickel, cobalt, PGMs |
| V | ≈ 6% of inner belt (Vesta family) | 2.3–2.5 AU | 0 | < 2 | ≈ 98 (basalt) | 0 | low | HED achondrite | construction, Al/Ca |
| D/P | dominant in outer belt (> 3.3 AU), Trojans | 3.3–5.2 AU | 10–40 (ice in interior) | < 5 | 40 | 5–15 | low | Tagish Lake | volatiles, organics |
| Comets (JFC, Oort) | – | all | 30–80 ice | < 2 | 20–40 | 5–20 | low | – | volatiles, N, C for terraforming |

**Value heuristics** [E]: a 1 km M-type ≈ 2e12 kg total ≈ 1e12 kg FeNi + ≈1e5 kg PGM. A 100 m C-type ≈ 1e9 kg with ≈1e8 kg water. Price collapse rule: any commodity's price elasticity is `P = P0 × (Q/Q0)^(−1/ε)` with ε ≈ 1.5. Shipping 1e5 kg of platinum to Earth crashes the platinum price, so asteroid PGMs are mostly valuable in space (§7).

### 1.14 Radiation [R]

| Location | Dose | |
|---|---|---|
| Earth sea level | 2.4 mSv/yr (world average background) | |
| ISS | 0.5–0.8 mSv/day | |
| Deep space cruise (solar min GCR) | 1.84 mSv/day (MSL RAD) | |
| Mars surface | 0.64 mSv/day | |
| Moon surface | 1.37 mSv/day | |
| Europa surface | ≈5.4 Sv/day (lethal in days) | |
| Io surface | ≈36 Sv/day (lethal in hours) | |
| Ganymede surface | ≈0.08 Sv/day (equator lower) | |
| Callisto surface | ≈0.0001–0.0003 Sv/day | lowest of the Galilean moons, which is why Callisto is the Jovian base |
| NASA career limit (2022) | 600 mSv | |
| Cancer risk coefficient | ≈5% fatal cancer per Sv | |
| Shielding to Earth-like dose | 2–3 m regolith, or ≈5 m water, or ≈ 4.5 t/m² mass | |

**Sim rule:** `excess_mortality_per_yr = 0.05 × dose_Sv_per_yr × (1 − shield_fraction)` for residents. `shield_fraction` rises with habitat depth/tech: 0.5 for surface habs in 2040, 0.9 with regolith burial (N05), 0.99 for O'Neill-class hulls.

### 1.15 Energy densities of fuels [R physics]

| Fuel | Specific energy (J/kg) | Notes |
|---|---|---|
| Methalox (combustion) | 1.0e7 | |
| Li-ion battery | 9e5 | |
| U-235 fission (complete) | 8.2e13 | burnup in practice ≈ 5% in LWR, 100% ideal breeder |
| D-T fusion | 3.4e14 | 17.6 MeV; neutron-heavy |
| D-He3 fusion (per kg of He-3) | 5.85e14 | 1 t He-3 ≈ 5.9e17 J ≈ 18.5 GW·yr thermal |
| D-D fusion | ≈ 8.7e13 (avg of branches) | deuterium from water: 156 ppm D/H on Earth |
| p-B11 fusion | 7e13 | aneutronic; very hard |
| Matter–antimatter | 9.0e16 (per kg total) | 1 g of antimatter + 1 g of matter = 1.8e14 J = 43 kt TNT |
| Black hole (Hawking, Kugelblitz) | up to 9e16 | [S] |

**He-3 demand check** [E]: humanity at 21 TW thermal-equivalent would need ≈ 1,100 t He-3/yr in D-He3 fusion. Lunar stock of ≈1e6 t gives about 1,000 yr at today's scale. Gas giants hold ≈1e20+ kg (effectively unlimited). Saturn and Uranus have shallower gravity wells than Jupiter.

---

## 2. Body catalog

### 2.1 Habitability / difficulty score definition

`H = Π_k (s_k)^(w_k)`, a weighted geometric mean. Zero in any factor means "needs a megaproject". Scores are from the viewpoint of 2040 technology. Tech raises specific factors (e.g. rotating habitats set the gravity factor to 1 anywhere).

| Factor k | w_k | 0 | 0.5 | 1 |
|---|---|---|---|---|
| gravity | 0.15 | < 0.001 g or > 2 g | 0.1–0.3 g | 0.7–1.1 g |
| temperature (surface/accessible layer) | 0.10 | < 30 K or > 600 K | 100–200 K | 260–310 K |
| radiation | 0.25 | > 1 Sv/day | 0.5–1.5 mSv/day | < 0.01 mSv/day |
| atmosphere / pressure | 0.10 | crushing/corrosive (Venus surface) | trace (Mars) or vacuum | breathable |
| water access | 0.20 | none | hydrated minerals | surface/near-surface ice or liquid |
| energy access | 0.20 | < 1 W/m² and no fissile/thermal | Mars-like solar | ≥ 1 AU solar or rich geothermal |

The table values below are pre-computed judgment scores in [0,1] (higher = easier). Use `H` as a multiplier on settlement transition rates (§4) and as the hazard divisor.

### 2.2 Solar System bodies: physical

`a` is the heliocentric semi-major axis. For moons, `a` is the parent's, and the moon orbit is listed separately. P is the orbital period around the Sun (moons: around the parent, in days). T is mean surface temperature (or at the 1-bar level for giants).

| id | Body | Type | Parent | g (Earth=1) | Radius (km) | a (AU) | P (yr) | Moon orbit (1000 km / days) | T mean (K) [range] | Atmosphere | Habitability H (0–1) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B00 | Sun | star | – | 28.0 | 695,700 | 0 | – | – | 5,772 | – | 0 |
| B01 | Mercury | planet | Sun | 0.378 | 2,439.7 | 0.387 | 0.241 | – | 440 [100–700]; polar craters < 100 | none | 0.20 |
| B02 | Venus (surface) | planet | Sun | 0.904 | 6,051.8 | 0.723 | 0.615 | – | 737 | 92 bar CO2, H2SO4 | 0.02 |
| B02a | Venus cloud layer (50–55 km) | aerostat zone | Venus | 0.90 | – | 0.723 | 0.615 | – | 300–350 at 0.5–1 bar | CO2; breathable air is a lifting gas | 0.35 |
| B03 | Earth | planet | Sun | 1.000 | 6,371.0 | 1.000 | 1.000 | – | 288 | N2/O2 1 bar | 1.00 |
| B04 | Moon | moon | Earth | 0.165 | 1,737.4 | 1.000 | 1.000 | 384.4 / 27.32 | 250 [100–390]; PSR 40 | none | 0.55 |
| B05 | Mars | planet | Sun | 0.379 | 3,389.5 | 1.524 | 1.881 | – | 210 [130–300] | CO2 0.006 bar | 0.60 |
| B06 | Phobos | moon | Mars | 0.0006 | 11.1 | 1.524 | 1.881 | 9.38 / 0.319 | 233 | none | 0.35 |
| B07 | Deimos | moon | Mars | 0.0003 | 6.2 | 1.524 | 1.881 | 23.46 / 1.263 | 233 | none | 0.30 |
| B08 | Ceres | dwarf planet | Sun | 0.029 | 469.7 | 2.77 | 4.60 | – | 168 [110–235] | trace H2O exosphere | 0.45 |
| B09 | Vesta | asteroid (V) | Sun | 0.025 | 262.7 | 2.36 | 3.63 | – | 190 [85–270] | none | 0.30 |
| B10 | Pallas | asteroid (B) | Sun | 0.021 | 256 | 2.77 | 4.62 | – | 164 | none | 0.20 |
| B11 | Hygiea | asteroid (C) | Sun | 0.013 | 217 | 3.14 | 5.57 | – | 164 | none | 0.22 |
| B12 | Psyche | asteroid (M) | Sun | 0.012 | 111 | 2.92 | 4.99 | – | 160 | none | 0.25 |
| B13 | Eros (generic S-type NEA) | NEA | Sun | 0.0006 | 8.4 | 1.458 | 1.76 | – | 227 | none | 0.30 |
| B14 | Bennu/Ryugu (generic C-type NEA) | NEA | Sun | ≈0 | 0.25–0.45 | 1.13–1.19 | 1.2–1.3 | – | 250–300 | none | 0.30 |
| B15 | Jupiter | gas giant | Sun | 2.53 | 69,911 | 5.20 | 11.86 | – | 165 | H2/He | 0.00 |
| B16 | Io | moon | Jupiter | 0.183 | 1,821.6 | 5.20 | 11.86 | 421.7 / 1.769 | 110 (volcanic 1,900) | SO2 trace | 0.02 |
| B17 | Europa | moon | Jupiter | 0.134 | 1,560.8 | 5.20 | 11.86 | 671.0 / 3.551 | 102 [50–125] | O2 trace | 0.10 (0.25 if under-ice) |
| B18 | Ganymede | moon | Jupiter | 0.146 | 2,634.1 | 5.20 | 11.86 | 1,070.4 / 7.155 | 110 [70–152] | O2 trace | 0.25 |
| B19 | Callisto | moon | Jupiter | 0.126 | 2,410.3 | 5.20 | 11.86 | 1,882.7 / 16.689 | 134 [80–165] | CO2 trace | 0.40 |
| B20 | Jupiter Trojans (e.g. Hektor) | asteroid swarm (D/P) | Sun | ≈0.01 | ≤ 112 | 5.20 | 11.86 | L4/L5 | 120 | none | 0.15 |
| B21 | Saturn | gas giant | Sun | 1.065 | 58,232 | 9.54 | 29.46 | – | 134 | H2/He | 0.00 |
| B22 | Mimas | moon | Saturn | 0.0065 | 198.2 | 9.54 | 29.46 | 185.5 / 0.942 | 64 | none | 0.10 |
| B23 | Enceladus | moon | Saturn | 0.0115 | 252.1 | 9.54 | 29.46 | 238.0 / 1.370 | 75 (plumes) | plume H2O | 0.25 |
| B24 | Tethys | moon | Saturn | 0.0149 | 531.1 | 9.54 | 29.46 | 294.7 / 1.888 | 86 | none | 0.18 |
| B25 | Dione | moon | Saturn | 0.0237 | 561.4 | 9.54 | 29.46 | 377.4 / 2.737 | 87 | trace O2 | 0.20 |
| B26 | Rhea | moon | Saturn | 0.0270 | 763.8 | 9.54 | 29.46 | 527.1 / 4.518 | 76 | trace O2/CO2 | 0.25 |
| B27 | Titan | moon | Saturn | 0.138 | 2,574.7 | 9.54 | 29.46 | 1,221.9 / 15.945 | 94 | N2 1.45 bar, 5% CH4 | 0.45 |
| B28 | Iapetus | moon | Saturn | 0.0228 | 734.5 | 9.54 | 29.46 | 3,560.8 / 79.32 | 90–130 | none | 0.20 |
| B29 | Uranus | ice giant | Sun | 0.886 | 25,362 | 19.19 | 84.0 | – | 76 | H2/He/CH4 | 0.00 |
| B30 | Miranda | moon | Uranus | 0.0081 | 235.8 | 19.19 | 84.0 | 129.9 / 1.413 | 60 | none | 0.10 |
| B31 | Ariel | moon | Uranus | 0.0274 | 578.9 | 19.19 | 84.0 | 190.9 / 2.520 | 60 | none | 0.15 |
| B32 | Umbriel | moon | Uranus | 0.0234 | 584.7 | 19.19 | 84.0 | 266.0 / 4.144 | 75 | none | 0.15 |
| B33 | Titania | moon | Uranus | 0.0386 | 788.4 | 19.19 | 84.0 | 436.3 / 8.706 | 70 | trace CO2 | 0.20 |
| B34 | Oberon | moon | Uranus | 0.0353 | 761.4 | 19.19 | 84.0 | 583.5 / 13.463 | 75 | none | 0.20 |
| B35 | Neptune | ice giant | Sun | 1.14 | 24,622 | 30.07 | 164.8 | – | 72 | H2/He/CH4 | 0.00 |
| B36 | Triton | moon (captured KBO) | Neptune | 0.0794 | 1,353.4 | 30.07 | 164.8 | 354.8 / 5.877 (retrograde) | 38 | N2 14 µbar | 0.18 |
| B37 | Pluto | dwarf planet (KBO) | Sun | 0.063 | 1,188.3 | 39.48 | 248 | – | 44 [33–55] | N2 ≈10 µbar | 0.15 |
| B38 | Charon | moon | Pluto | 0.029 | 606.0 | 39.48 | 248 | 19.6 / 6.387 | 53 | none | 0.12 |
| B39 | Haumea | dwarf planet | Sun | ≈0.04 | ≈780 (ellipsoid) | 43.2 | 284 | – | 50 | none | 0.08 |
| B40 | Makemake | dwarf planet | Sun | ≈0.05 | 715 | 45.4 | 306 | – | 40 | none | 0.08 |
| B41 | Quaoar | KBO | Sun | ≈0.03 | 545 | 43.7 | 289 | – | 44 | none | 0.07 |
| B42 | Gonggong | scattered disk | Sun | ≈0.03 | 615 | 67.5 | 552 | – | 35 | none | 0.06 |
| B43 | Eris | dwarf planet (SDO) | Sun | 0.084 | 1,163 | 67.9 | 559 | – | 42 [30–56] | none | 0.07 |
| B44 | Arrokoth (generic cold classical KBO) | KBO | Sun | ≈1e-4 | 18 | 44.6 | 298 | – | 40 | none | 0.05 |
| B45 | Sedna | detached object | Sun | ≈0.02 | ≈500 | 506 (q 76) | ≈11,400 | – | 12 | none | 0.03 |
| B46 | Oort cloud comet nuclei (generic) | comets | Sun | ≈0 | 1–20 | 2,000–100,000 | 1e5–1e7 | – | < 10 | none | 0.02 |
| H01 | Earth–Moon L4/L5 | free-space site | Earth | habitat-set | – | 1.000 | 1.000 | 384.4 | habitat | habitat | 0.50 (needs N21) |
| H02 | Sun–Earth L1/L2 | free-space site | Sun | habitat-set | – | 1.01 | 1.00 | – | habitat | habitat | 0.40 |
| H03 | Low Mars orbit / Mars L-points | free-space site | Mars | habitat-set | – | 1.524 | 1.881 | – | habitat | habitat | 0.40 |
| H04 | Main-belt free-space habitats | free-space | Sun | habitat-set | – | 2.2–3.3 | 3.3–6 | – | habitat | habitat | 0.40 (needs N21 + M17) |

### 2.3 Solar System bodies: resource endowments (0–1)

Scale: 1.0 = the best in the Solar System for that resource, relative to an accessible quantity (not just total). "Energy" = solar flux + accessible fission/geothermal/tidal/He-3 fuel, normalized so that Earth-orbit solar = 0.8. These are [D] judgments anchored on §1.

| id | Body | Water | Metals (Fe/Ni) | Light metals + construction (Al, Ti, Si, regolith) | Volatiles (C, N, CO2, CH4, NH3) | Rare (PGM, REE) | He-3 | Fissile (U/Th) | Energy | Special flags |
|---|---|---|---|---|---|---|---|---|---|---|
| B01 | Mercury | 0.10 (polar) | 0.70 | 0.70 | 0.02 | 0.40 | 0.30 (high solar wind) | 0.20 | 1.00 | Dyson swarm feedstock (3.3e23 kg) |
| B02 | Venus surface | 0.00 | 0.50 | 0.50 | 0.90 (CO2, N2) | 0.30 | 0.00 | 0.20 | 0.30 | inaccessible (92 bar) |
| B02a | Venus clouds | 0.05 (H2SO4) | 0.00 | 0.00 | 0.90 | 0.00 | 0.00 | 0.00 | 0.95 | D/H 120× Earth (deuterium) |
| B03 | Earth | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 0.80 | deep gravity well |
| B04 | Moon | 0.25 (polar) | 0.30 | 0.80 | 0.05 | 0.15 (KREEP) | 0.60 | 0.15 | 0.85 | low Δv to Earth orbit, mass driver ideal |
| B05 | Mars | 0.70 | 0.45 | 0.70 | 0.60 (CO2, N2 2.8%) | 0.30 | 0.02 | 0.15 | 0.40 | perchlorates; terraformable |
| B06 | Phobos | 0.10 | 0.10 | 0.40 | 0.10 | 0.05 | 0.05 | 0.00 | 0.40 | gateway to Mars; skyhook anchor |
| B07 | Deimos | 0.10 | 0.10 | 0.30 | 0.10 | 0.05 | 0.05 | 0.00 | 0.40 | |
| B08 | Ceres | 0.90 (≈25% water by mass) | 0.20 | 0.40 | 0.60 (NH3, carbonates) | 0.10 | 0.02 | 0.05 | 0.15 | belt hub; ammonia for N |
| B09 | Vesta | 0.05 | 0.40 | 0.70 (basalt) | 0.02 | 0.10 | 0.02 | 0.05 | 0.20 | differentiated iron core |
| B10 | Pallas | 0.40 | 0.20 | 0.40 | 0.30 | 0.10 | 0.02 | 0.02 | 0.15 | high inclination (34.8°): Δv penalty +2 km/s |
| B11 | Hygiea | 0.50 | 0.15 | 0.30 | 0.40 | 0.05 | 0.02 | 0.02 | 0.12 | |
| B12 | Psyche | 0.02 | 1.00 (in space) | 0.30 | 0.02 | 0.90 | 0.02 | 0.05 | 0.12 | ≈2.3e19 kg; metal-rich |
| B13 | S-type NEA | 0.05 | 0.40 | 0.40 | 0.05 | 0.20 | 0.02 | 0.00 | 0.70 | low Δv (4.5–6 km/s) |
| B14 | C-type NEA | 0.40 | 0.10 | 0.20 | 0.40 | 0.05 | 0.02 | 0.00 | 0.70 | propellant depot source |
| B15 | Jupiter (atmosphere) | 0.30 | 0.00 | 0.00 | 0.50 | 0.00 | 0.80 (deep well) | 0.00 | 0.20 | 2.53 g well, radiation |
| B16 | Io | 0.00 | 0.40 | 0.40 | 0.40 (S, SO2) | 0.20 | 0.00 | 0.10 | 0.60 (flux tube 1 TW, tidal heat) | lethal radiation |
| B17 | Europa | 1.00 (ocean ≈2–3× Earth's) | 0.10 | 0.20 | 0.30 | 0.05 | 0.00 | 0.02 | 0.15 | possible biosphere → planetary protection lock |
| B18 | Ganymede | 0.90 | 0.20 | 0.30 | 0.30 | 0.05 | 0.00 | 0.02 | 0.15 | magnetosphere (partial shield) |
| B19 | Callisto | 0.85 | 0.15 | 0.30 | 0.30 | 0.05 | 0.00 | 0.02 | 0.15 | low radiation; Jovian base (NASA HOPE study) |
| B20 | Jupiter Trojans | 0.50 | 0.15 | 0.20 | 0.50 | 0.05 | 0.00 | 0.00 | 0.12 | ≈1e6 bodies > 1 km |
| B21 | Saturn (atmosphere) | 0.30 | 0.00 | 0.00 | 0.50 | 0.00 | 0.90 | 0.00 | 0.10 | 1.07 g; feasible He-3 scoop |
| B22 | Mimas | 0.70 | 0.05 | 0.10 | 0.20 | 0.02 | 0.00 | 0.00 | 0.05 | |
| B23 | Enceladus | 0.90 | 0.05 | 0.10 | 0.50 (plume organics, NH3) | 0.02 | 0.00 | 0.00 | 0.08 | ocean access via plumes; protection lock possible |
| B24 | Tethys | 0.90 | 0.02 | 0.05 | 0.20 | 0.02 | 0.00 | 0.00 | 0.05 | nearly pure ice |
| B25 | Dione | 0.80 | 0.10 | 0.15 | 0.25 | 0.02 | 0.00 | 0.00 | 0.05 | |
| B26 | Rhea | 0.85 | 0.10 | 0.15 | 0.25 | 0.02 | 0.00 | 0.00 | 0.05 | |
| B27 | Titan | 0.80 | 0.10 | 0.20 | 1.00 (N2, CH4 lakes ≈1e5 km³ hydrocarbons) | 0.05 | 0.00 | 0.02 | 0.25 (chemical: CH4 + O2 combustion) | thick air = radiation shield + easy flight; aerocapture |
| B28 | Iapetus | 0.70 | 0.10 | 0.15 | 0.30 | 0.02 | 0.00 | 0.00 | 0.05 | |
| B29 | Uranus (atmosphere) | 0.40 | 0.00 | 0.00 | 0.60 | 0.00 | 1.00 (best: 0.89 g well) | 0.00 | 0.05 | He-3 scoop preferred |
| B30 | Miranda | 0.70 | 0.05 | 0.15 | 0.20 | 0.02 | 0.00 | 0.00 | 0.03 | |
| B31 | Ariel | 0.70 | 0.10 | 0.20 | 0.30 | 0.02 | 0.00 | 0.00 | 0.03 | |
| B32 | Umbriel | 0.70 | 0.10 | 0.20 | 0.30 | 0.02 | 0.00 | 0.00 | 0.03 | |
| B33 | Titania | 0.75 | 0.10 | 0.25 | 0.30 | 0.02 | 0.00 | 0.00 | 0.03 | Uranus system base |
| B34 | Oberon | 0.75 | 0.10 | 0.25 | 0.30 | 0.02 | 0.00 | 0.00 | 0.03 | |
| B35 | Neptune (atmosphere) | 0.40 | 0.00 | 0.00 | 0.60 | 0.00 | 0.90 | 0.00 | 0.02 | |
| B36 | Triton | 0.70 | 0.15 | 0.20 | 0.60 (N2 ice) | 0.02 | 0.00 | 0.02 | 0.02 | cryovolcanism |
| B37 | Pluto | 0.70 | 0.10 | 0.20 | 0.70 (N2, CH4, CO ices) | 0.02 | 0.00 | 0.02 | 0.01 | |
| B38 | Charon | 0.70 | 0.10 | 0.20 | 0.30 | 0.02 | 0.00 | 0.00 | 0.01 | |
| B39–B43 | Large KBOs/SDOs | 0.60 | 0.10 | 0.15 | 0.50 | 0.02 | 0.00 | 0.01 | 0.005 | waypoint to interstellar |
| B44 | Cold classical KBO | 0.60 | 0.02 | 0.05 | 0.50 | 0.01 | 0.00 | 0.00 | 0.005 | |
| B45 | Sedna | 0.60 | 0.05 | 0.10 | 0.50 | 0.01 | 0.00 | 0.00 | 0.001 | |
| B46 | Oort comets | 0.70 | 0.02 | 0.05 | 0.70 | 0.01 | 0.00 | 0.00 | 0.000 | ≈1e12 bodies; total mass ≈ 1–5 M⊕ |

**Quantity scaling** [D]: the endowment score sets the **rate cap** on extraction: `max_extraction_t_per_yr = score × 10^(6 + 2 × tech_mining_tier) × (settlement_pop/1e4)^0.7`. Total stock is effectively infinite for 10k yrs everywhere except: lunar polar ice (stock 6e8 t), lunar He-3 (1e6 t), Earth fossil fuels, Earth easily mined PGMs, and Venus deuterium. Track those as finite stocks.

### 2.4 Nearby star systems (within ≈20 ly, plus TRAPPIST-1 and LHS 1140) [R]

L = luminosity in L☉. HZ (habitable zone, moderate) ≈ 0.95–1.67 × sqrt(L) AU. "Plan." = number of confirmed planets (cand. = candidate). Flags: F = high flare activity (M dwarf), B = binary/multiple.

| id | System | Dist (ly) | Spectral | L (L☉) | Mass (M☉) | HZ (AU) | Plan. | Notes / flags |
|---|---|---|---|---|---|---|---|---|
| S01 | Alpha Centauri A/B | 4.37 | G2V + K1V | 1.52 + 0.50 | 1.08 + 0.91 | A: 1.17–2.06; B: 0.67–1.18 | A: 1 cand. (S1, JWST 2025) | B; AB separation 11–35 AU; best stellar target |
| S02 | Proxima Centauri | 4.25 | M5.5V | 0.00155 | 0.12 | 0.037–0.066 | 2 (b, d) | F; tidally locked; bound to α Cen at ≈13,000 AU |
| S03 | Barnard's Star | 5.96 | M4V | 0.0034 | 0.16 | 0.055–0.097 | 4 (b, c, d, e; 2024–25) | all too hot; old, quiet |
| S04 | Wolf 359 | 7.86 | M6V | 0.0011 | 0.11 | 0.03–0.055 | 0 (claims unconfirmed) | F |
| S05 | Lalande 21185 | 8.30 | M2V | 0.021 | 0.39 | 0.14–0.24 | 2 (b; c cand.) | |
| S06 | Sirius A/B | 8.60 | A1V + DA white dwarf | 25.4 | 2.06 + 1.02 | 4.8–8.4 | 0 | B; UV-intense; no planets |
| S07 | Luyten 726-8 (UV Ceti) | 8.7 | M5.5V + M6V | 0.0001 | 0.10 + 0.10 | – | 0 | F (archetypal flare star) |
| S08 | Ross 154 | 9.7 | M3.5V | 0.004 | 0.18 | – | 0 | F |
| S09 | Epsilon Eridani | 10.5 | K2V | 0.32 | 0.82 | 0.54–0.94 | 1 (b, ≈1 MJ, 3.5 AU) | young (≈0.4–0.8 Gyr), debris belts (asteroid-mining rich) |
| S10 | Lacaille 9352 (GJ 887) | 10.7 | M0.5V | 0.037 | 0.47 | 0.18–0.32 | 4 (b, c, d, e; some cand.) | quiet M dwarf |
| S11 | Ross 128 | 11.0 | M4V | 0.0036 | 0.17 | 0.057–0.1 | 1 (b) | quiet; approaching Sun (closest in ≈71,000 yr) |
| S12 | Procyon A/B | 11.46 | F5IV + WD | 6.9 | 1.50 + 0.6 | 2.5–4.4 | 0 | B |
| S13 | 61 Cygni A/B | 11.4 | K5V + K7V | 0.15 + 0.085 | 0.70 + 0.63 | 0.37–0.65 | 0 | B |
| S14 | Struve 2398 (GJ 725 A/B) | 11.5 | M3V + M3.5V | 0.016 + 0.009 | 0.33 + 0.25 | – | 2 (A b; B c) | B |
| S15 | Groombridge 34 (GJ 15 A/B) | 11.6 | M1.5V + M3.5V | 0.022 | 0.38 + 0.16 | 0.14–0.25 | 2 (A b, A c) | B |
| S16 | Epsilon Indi A + Ba/Bb | 11.87 | K5V + T1 + T6 brown dwarfs | 0.22 | 0.76 | 0.45–0.78 | 1 (Ab: ≈6–7.6 MJ, a ≈ 16–21 AU, imaged by JWST 2024, ≈275 K) | B (BD pair at 1,460 AU) |
| S17 | Tau Ceti | 11.9 | G8.5V | 0.52 | 0.78 | 0.69–1.2 | 4 cand. (g, h, e, f) | large debris disk (10× Sun's Kuiper belt) → high impact rate; low metallicity |
| S18 | GJ 1061 | 12.0 | M5.5V | 0.0017 | 0.12 | 0.04–0.07 | 3 (b, c, d) | quiet |
| S19 | YZ Ceti | 12.1 | M4.5V | 0.0022 | 0.13 | 0.045–0.08 | 3 (b, c, d) | F; star–planet magnetic interaction detected (radio) |
| S20 | Luyten's Star (GJ 273) | 12.35 | M3.5V | 0.0088 | 0.26 | 0.09–0.16 | 2 (b, c) + 2 cand. | target of 2017 METI message "Sónar Calling GJ 273b" |
| S21 | Teegarden's Star | 12.5 | M7V | 0.00073 | 0.097 | 0.026–0.045 | 3 (b, c, d) | old (≈8 Gyr), quiet |
| S22 | Kapteyn's Star | 12.8 | sdM1 | 0.012 | 0.27 | – | 0 (refuted) | halo star, 11 Gyr old |
| S23 | Wolf 1061 | 14.05 | M3V | 0.0101 | 0.29 | 0.095–0.17 | 3 (b, c, d) | |
| S24 | Gliese 687 | 14.8 | M3V | 0.021 | 0.40 | 0.14–0.24 | 2 (b, c) | |
| S25 | Gliese 674 | 14.8 | M2.5V | 0.016 | 0.35 | – | 1 (b, Neptune-mass) | F |
| S26 | Gliese 876 | 15.2 | M4V | 0.0122 | 0.37 | 0.1–0.18 | 4 (d, c, b, e; two are Jovian) | Laplace resonance; giant planets in HZ → habitable moons? |
| S27 | GJ 1002 | 15.8 | M5.5V | 0.00135 | 0.12 | 0.035–0.06 | 2 (b, c) | quiet |
| S28 | Gliese 832 | 16.2 | M2V | 0.035 | 0.45 | – | 1 (b, ≈1 MJ at 3.7 AU) | |
| S29 | 40 Eridani (ο² Eri) A/B/C | 16.3 | K0.5V + WD + M4.5V | 0.46 | 0.84 | 0.64–1.1 | 0 (2018 claim refuted 2023) | B; "Vulcan" |
| S30 | 70 Ophiuchi A/B | 16.6 | K0V + K4V | 0.6 + 0.15 | 0.90 + 0.70 | – | 0 | B |
| S31 | Altair | 16.7 | A7V | 10.6 | 1.86 | – | 0 | fast rotator |
| S32 | GJ 3323 | 17.5 | M4V | 0.0026 | 0.16 | – | 2 (b, c) | |
| S33 | Gliese 251 | 18.2 | M3V | 0.023 | 0.36 | 0.14–0.25 | 2 (b, c; c HZ super-Earth 2025) | |
| S34 | Sigma Draconis | 18.8 | G9V | 0.43 | 0.85 | 0.62–1.1 | 0 | quiet, Sun-like |
| S35 | Gliese 752 A (Wolf 1055) | 19.3 | M3V (+ VB 10) | 0.040 | 0.46 | – | 1 (b) | B |
| S36 | Eta Cassiopeiae A/B | 19.4 | G0V + K7V | 1.23 | 0.97 | 1.05–1.85 | 0 | B |
| S37 | 82 G. Eridani (HD 20794) | 19.7 | G8V | 0.69 | 0.70 | 0.79–1.39 | 3 (b, c, d; d in HZ, 2025) | Sun-like, quiet; priority target |
| S38 | Delta Pavonis | 19.9 | G8IV | 1.22 | 0.99 | 1.05–1.84 | 0 | subgiant, Sun's future analog |
| S39 | TRAPPIST-1 | 40.7 | M8V | 0.00055 | 0.09 | 0.022–0.039 | 7 (b–h) | F; resonant chain; JWST: b, c probably airless |
| S40 | LHS 1140 | 48.8 | M4.5V | 0.0038 | 0.18 | 0.06–0.1 | 2 (b in HZ, possible water world) | quiet |

Census for procedural fill: within 20 ly there are ≈ 130 stars and brown dwarfs in ≈ 100 systems [R]. Only ≈ 10 are not M/L/T/WD (α Cen A/B, Sirius A, Procyon A, ε Eri, 61 Cyg A/B, ε Ind A, τ Cet, 40 Eri A, 70 Oph A/B, Altair, σ Dra, η Cas A/B, 82 G Eri, δ Pav).

### 2.5 Nearby exoplanets (truth table seed)

Teq is computed as `278.6 × L^0.25 / sqrt(a) × (1−A)^0.25` [E], with A = 0 and A = 0.3. M_min = minimum mass (m sin i); use M_true = 1.15 × M_min in the sim. R_est uses the Chen & Kipping (2017) relation: `R = M^0.279` (M < 2 M⊕), `R = 1.22 × (M/2.04)^0.589` (2–130 M⊕), and ≈ 11 R⊕ for giants. `S` = insolation relative to Earth.

`P_hab_prior` is a [D] prior that the planet has a surface habitable for unprotected Earth biology (pressure, temperature, water, atmosphere). The sim draws the hidden truth `habitable = rand() < P_hab_prior` at world-gen. It is revealed only when a survey (telescope tech M-tier, or a probe flyby) reaches the system. Truth also includes `native_biosphere` (P = 0.5 × P_hab_prior) and `biochem_compatible` (P = 0.3 if a biosphere exists). This is the Aurora rule.

| Planet | Dist (ly) | Status | M_min (M⊕) | R_est (R⊕) | P (d) | a (AU) | S (⊕) | Teq A=0 / 0.3 (K) | Tidally locked | P_hab_prior | Settle class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Proxima b | 4.25 | conf. | 1.07 | 1.0–1.1 | 11.19 | 0.0486 | 0.66 | 251 / 229 | yes | 0.10 | terrestrial-HZ, flare-blasted |
| Proxima d | 4.25 | conf. | 0.26 | 0.7 | 5.12 | 0.029 | 1.86 | 325 / 297 | yes | 0.01 | hot rock |
| α Cen A S1 | 4.37 | cand. | 90–150 (true) | ≈11 (1–1.1 RJ) | ≈ 900 (2–3 yr) | ≈1.5–2 (e≈0.4) | ≈0.6 | ≈ 225–253 | no | 0.00 (moons 0.05) | gas giant in HZ; moons are targets |
| Barnard's b/c/d/e | 5.96 | conf. | 0.19–0.34 | 0.6–0.75 | 2.3–6.7 | 0.019–0.038 | 2.3–9.6 | 345–491 / 315–449 | yes | 0.00 | hot rocks (mining) |
| Lalande 21185 b | 8.30 | conf. | 2.69 | 1.4 | 12.94 | 0.079 | 3.4 | 378 / 346 | yes | 0.01 | hot super-Earth |
| Lalande 21185 c | 8.30 | cand. | 13.6 | 3.6 | 2,946 | 2.94 | 0.002 | 62 / 57 | no | 0.00 | cold Neptune |
| ε Eridani b (Ægir) | 10.5 | conf. | ≈318 (≈1 MJ true) | 11 | 2,680 | 3.53 | 0.026 | 112 / 102 | no | 0.00 | cold Jupiter; belts |
| GJ 887 b/c/e | 10.7 | conf./cand. | 1.5–6.5 | 1.1–2.2 | 4.4–21.8 | 0.04–0.12 | 2.5–21 | 351–595 | yes | 0.01 | hot |
| GJ 887 d | 10.7 | cand. | 6.1 | 2.1 | 50.8 | 0.212 | 0.82 | 265 / 242 | likely | 0.05 | mini-Neptune risk |
| Ross 128 b | 11.0 | conf. | 1.40 | 1.1 | 9.87 | 0.0496 | 1.47 | 307 / 281 | yes | 0.15 | temperate-hot terrestrial, quiet star |
| GJ 725 A b | 11.5 | conf. | 2.78 | 1.4 | 11.22 | 0.068 | 3.4 | 377 / 345 | yes | 0.01 | hot |
| GJ 725 B c | 11.5 | conf. | 3.4 | 1.6 | 37.9 | 0.139 | 0.45 | 228 / 209 | yes | 0.05 | cold super-Earth |
| GJ 15 A b | 11.6 | conf. | 3.03 | 1.5 | 11.44 | 0.072 | 4.3 | 400 / 366 | yes | 0.00 | hot |
| GJ 15 A c | 11.6 | conf. | 36 | 6.6 | 7,600 | 5.4 | 0.001 | 46 / 42 | no | 0.00 | cold Neptune |
| ε Indi Ab | 11.87 | conf. (imaged) | ≈2,000–2,400 (6–7.6 MJ) | 11–12 | ≈ 60,000–100,000 | ≈ 16–21 | ≈0.001 | ≈275 (self-heated) | no | 0.00 | super-Jupiter |
| τ Ceti g | 11.9 | cand. | 1.75 | 1.2 | 20.0 | 0.133 | 29 | 649 / 593 | maybe | 0.00 | hot |
| τ Ceti h | 11.9 | cand. | 1.83 | 1.2 | 49.4 | 0.243 | 8.8 | 480 / 439 | maybe | 0.00 | hot |
| τ Ceti e | 11.9 | cand. | 3.93 | 1.7 | 162.9 | 0.538 | 1.80 | 323 / 295 | no | 0.08 | warm super-Earth, inner HZ edge |
| τ Ceti f | 11.9 | cand. | 3.93 | 1.7 | 636 | 1.334 | 0.29 | 205 / 187 | no | 0.08 | cold super-Earth, outer HZ; heavy bombardment |
| GJ 1061 b | 12.0 | conf. | 1.37 | 1.1 | 3.20 | 0.021 | 3.9 | 390 / 357 | yes | 0.00 | hot |
| GJ 1061 c | 12.0 | conf. | 1.74 | 1.2 | 6.69 | 0.035 | 1.39 | 302 / 277 | yes | 0.12 | HZ inner |
| GJ 1061 d | 12.0 | conf. | 1.64 | 1.15 | 13.03 | 0.054 | 0.58 | 243 / 223 | yes | 0.10 | HZ outer |
| YZ Ceti b/c/d | 12.1 | conf. | 0.70–1.14 | 0.9–1.05 | 2.0–4.7 | 0.016–0.029 | 2.7–8.3 | 357–473 | yes | 0.00 | hot, flare star |
| Luyten b (GJ 273 b) | 12.35 | conf. | 2.89 | 1.4 | 18.65 | 0.091 | 1.06 | 283 / 259 | yes | 0.15 | HZ super-Earth |
| Luyten c | 12.35 | conf. | 1.18 | 1.05 | 4.72 | 0.037 | 6.6 | 447 / 409 | yes | 0.00 | hot |
| Teegarden b | 12.5 | conf. | 1.16 | 1.05 | 4.91 | 0.026 | 1.09 | 285 / 260 | yes | 0.20 | best Earth-similarity (ESI ≈0.95) |
| Teegarden c | 12.5 | conf. | 1.05 | 1.0 | 11.42 | 0.0455 | 0.35 | 215 / 196 | yes | 0.08 | cold HZ edge |
| Teegarden d | 12.5 | conf. | 0.82 | 0.95 | 26.13 | 0.079 | 0.12 | 163 / 149 | yes | 0.02 | cold |
| Wolf 1061 b | 14.05 | conf. | 1.91 | 1.2 | 4.89 | 0.0375 | 7.2 | 456 / 417 | yes | 0.00 | hot |
| Wolf 1061 c | 14.05 | conf. | 3.41 | 1.6 | 17.87 | 0.089 | 1.28 | 296 / 271 | yes | 0.10 | HZ super-Earth (inner edge) |
| Wolf 1061 d | 14.05 | conf. | 7.7 | 2.3 | 217 | 0.47 | 0.05 | 129 / 118 | no | 0.00 | cold mini-Neptune |
| GJ 687 b | 14.8 | conf. | 17.2 | 4.2 | 38.1 | 0.163 | 0.80 | 264 / 241 | likely | 0.00 | temperate Neptune (moons?) |
| GJ 687 c | 14.8 | conf. | 16.0 | 4.0 | 728 | 1.165 | 0.016 | 99 / 90 | no | 0.00 | cold Neptune |
| GJ 674 b | 14.8 | conf. | 11.1 | 3.3 | 4.69 | 0.039 | 10.5 | 502 / 459 | yes | 0.00 | hot Neptune |
| GJ 876 d | 15.2 | conf. | 6.7 | 2.2 | 1.94 | 0.021 | 28 | 639 / 584 | yes | 0.00 | hot |
| GJ 876 c | 15.2 | conf. | 235 (0.74 MJ) | 11 | 30.1 | 0.131 | 0.71 | 256 / 234 | – | 0.00 (moons 0.05) | HZ giant |
| GJ 876 b | 15.2 | conf. | 749 (2.4 MJ) | 11 | 61.1 | 0.210 | 0.28 | 202 / 185 | – | 0.00 (moons 0.03) | cold giant |
| GJ 876 e | 15.2 | conf. | 16 | 4.0 | 123.6 | 0.336 | 0.11 | 160 / 146 | – | 0.00 | cold Neptune |
| GJ 1002 b | 15.8 | conf. | 1.08 | 1.02 | 10.35 | 0.0457 | 0.65 | 250 / 228 | yes | 0.15 | HZ terrestrial, quiet star |
| GJ 1002 c | 15.8 | conf. | 1.36 | 1.1 | 21.2 | 0.0738 | 0.25 | 197 / 180 | yes | 0.07 | cold HZ edge |
| GJ 832 b | 16.2 | conf. | 315 | 11 | 3,853 | 3.7 | 0.003 | 63 / 57 | no | 0.00 | cold Jupiter |
| GJ 3323 b | 17.5 | conf. | 2.0 | 1.2 | 5.36 | 0.033 | 2.4 | 347 / 318 | yes | 0.01 | hot |
| GJ 3323 c | 17.5 | conf. | 2.3 | 1.3 | 40.5 | 0.126 | 0.16 | 177 / 162 | yes | 0.03 | cold |
| GJ 251 b | 18.2 | conf. | 3.85 | 1.7 | 14.24 | 0.081 | 3.5 | 381 / 348 | yes | 0.00 | hot |
| GJ 251 c | 18.2 | conf. (2025) | 3.84 | 1.7 | 53.6 | 0.196 | 0.59 | 245 / 224 | likely | 0.10 | HZ super-Earth |
| GJ 752 A b | 19.3 | conf. | 12.2 | 3.4 | 106 | 0.343 | 0.34 | 213 / 195 | no | 0.00 | cold Neptune |
| 82 G. Eri b | 19.7 | conf. | 2.15 | 1.3 | 18.3 | 0.126 | 43 | 715 / 654 | no | 0.00 | hot |
| 82 G. Eri c | 19.7 | conf. | 2.98 | 1.5 | 89.7 | 0.363 | 5.2 | 421 / 385 | no | 0.00 | hot |
| 82 G. Eri d | 19.7 | conf. (2025) | 5.82 | 2.1 | 648 | 1.354 (e≈0.45) | 0.38 (mean) | 218 / 200 | no | 0.10 | eccentric HZ super-Earth around G star |
| TRAPPIST-1 b | 40.7 | conf. | 1.37 (true) | 1.12 | 1.51 | 0.0115 | 4.2 | 398 / 364 | yes | 0.00 | airless (JWST) |
| TRAPPIST-1 c | 40.7 | conf. | 1.31 | 1.10 | 2.42 | 0.0158 | 2.2 | 340 / 311 | yes | 0.00 | likely airless |
| TRAPPIST-1 d | 40.7 | conf. | 0.39 | 0.79 | 4.05 | 0.0223 | 1.12 | 286 / 262 | yes | 0.05 | |
| TRAPPIST-1 e | 40.7 | conf. | 0.69 | 0.92 | 6.10 | 0.0293 | 0.65 | 250 / 228 | yes | 0.20 | best TRAPPIST HZ |
| TRAPPIST-1 f | 40.7 | conf. | 1.04 | 1.05 | 9.21 | 0.0385 | 0.37 | 218 / 199 | yes | 0.12 | water-rich? |
| TRAPPIST-1 g | 40.7 | conf. | 1.32 | 1.13 | 12.35 | 0.0468 | 0.25 | 197 / 181 | yes | 0.06 | |
| TRAPPIST-1 h | 40.7 | conf. | 0.33 | 0.76 | 18.77 | 0.0619 | 0.14 | 172 / 157 | yes | 0.01 | |
| LHS 1140 b | 48.8 | conf. | 5.6 (true) | 1.73 | 24.7 | 0.0946 | 0.43 | 225 / 206 | yes | 0.15 | possible water/snowball world |

**Interstellar-target scoring** [D]: `Target = 0.35 × H_best_planet + 0.20 × resource_score + 0.15 × star_quietness (G/K = 1, quiet M = 0.6, flare M = 0.2) + 0.10 × (1 − binary_penalty) − 0.20 × (dist_ly / max_range)`. Rocky planets that are not habitable still count for resources and habitat construction: every system gets `resource_score ≥ 0.3` (asteroids and planets are always there).

### 2.6 Procedural generation for unmapped stars

**Stellar type sampling (main sequence, by number)** [R]:

| Class | Fraction | Mass (M☉) | L (L☉) | Lifetime (yr) | Planet hosts? | Typical HZ (AU) |
|---|---|---|---|---|---|---|
| O | 0.00003% | 16–90 | 3e4–1e6 | 3e6–1e7 | irrelevant | – |
| B | 0.13% | 2.1–16 | 25–3e4 | 1e7–3e8 | rarely useful | 5–170 |
| A | 0.6% | 1.4–2.1 | 5–25 | 1e9 | yes (short window) | 2.2–5 |
| F | 3.0% | 1.04–1.4 | 1.5–5 | 3e9–7e9 | yes | 1.2–2.2 |
| G | 7.6% | 0.8–1.04 | 0.6–1.5 | 1e10 | yes | 0.75–1.25 |
| K | 12.1% | 0.45–0.8 | 0.08–0.6 | 2e10–5e10 | yes | 0.3–0.75 |
| M | 76.45% | 0.08–0.45 | 1e-4–0.08 | > 1e11 | yes (many) | 0.01–0.3 |
| White dwarfs (separate draw) | ≈ 6% of all stellar objects | 0.5–1.0 | 1e-4–1e-2 | – | rare | – |
| Brown dwarfs (separate draw) | ≈ 1 per 4–5 stars | 0.013–0.08 | < 1e-4 | – | some | – |

Multiplicity: ≈ 45% of G stars, ≈ 26% of M stars, and ≈ 33% of systems overall are binary or multiple [R].

**Planet occurrence per star** [R/E] (Kepler/TESS/RV synthesis):

| Quantity | FGK | M dwarfs |
|---|---|---|
| Mean planets per star (P < 1 yr, R > 0.5 R⊕) | ≈ 1.5 | ≈ 2.5 |
| η⊕ (rocky 0.5–1.5 R⊕ in conservative HZ) | 0.37–0.60 (Bryson 2021); use **0.3** | 0.16–0.24; use **0.2** |
| Cold giant planets (> 0.3 MJ, 1–10 AU) | 0.10–0.20 | ≈ 0.03 |
| Hot Jupiters | ≈ 0.01 | ≈ 0.002 |
| Debris / asteroid belt detectable | ≈ 0.2 | ≈ 0.05 (undercounted) |
| P(HZ planet truly surface-habitable \| in HZ) | 0.25 [D] | 0.08 [D] (flares, locking, water loss) |
| P(native biosphere \| habitable) | 0.5 [D, unknown] | 0.5 |
| P(intelligent life \| biosphere) | 1e-6 [D, user slider] | same |

Galactic metallicity gradient: planet occurrence × (1 + 2 × [Fe/H]), with [Fe/H] ≈ −0.06 dex/kpc × (R − 8.2 kpc).

---

## 3. Technology tree

### 3.1 Knowledge production model [D, structure from Jones 1995 semi-endogenous growth]

Per settlement s, per year:

```
R_eff(s)   = pop(s) × research_share(s) × space_share(s) × edu(s) × ai_mult(s)
KP_rate(s) = KP0 × (R_eff(s) / R0)^λ × stability(s) × energy_ok(s)
KP0 = 2,000 KP/yr      R0 = 9.2e5 researcher-equivalents (= Earth 2040)      λ = 0.75
```

| Parameter | Earth 2040 | Frontier colony | Notes |
|---|---|---|---|
| research_share | 0.002 | 0.01–0.05 (selection effect) | |
| space_share | 0.05, rising: `0.05 + 0.45 × min(1, GDP_space/GDP_earth)` | 1.0 | fraction of research relevant to the tree |
| edu | 1.0 | 1.0–1.3 | |
| ai_mult | 1 | 1 | ×3 with N14 AGI, ×30 with M13 ASI, ×1000 with F05 Matrioshka |
| stability | regime factor: GOLD 1.3, EXP 1.1, CON 1.0, STAG 0.7, SEC 0.8, WAR 0.6 (military research ×1.5), PAND 0.7, COLL 0.1, SING 3.0 | | |
| energy_ok | min(1, energy_supply / energy_demand) | | |

- **Pooling:** settlements in the same polity with mutual light-lag < 1 h pool KP into one budget. Beyond that, each system has its own budget, and techs diffuse.
- **Diffusion:** once tech X is known anywhere, another polity can acquire it at `0.2 × cost` (copying is cheap). It becomes available after `lag_years + 2` yr. Embargo during WAR: ×3 cost.
- **Allocation:** each polity splits KP across researchable techs by `priority_weight = need_score × (1 / cost)^0.3`. need_score comes from §7.8 decision rules (e.g. resupply cost high → ECLSS techs get high need). At most 8 techs in parallel. Minimum 3% of KP goes to "basic science" (adds a random +25% progress to one tech every 10 years; event E20).
- **Hard floor:** a tech cannot complete before `earliest_year − 0.25 × (earliest_year − 2040)`. This keeps a booming run from hitting fusion in 2041.
- **Knowledge loss (Tasmania effect, Henrich 2004):** in COLL regime, each tech with `practitioners < 1e3 × tier` has a 2%/yr chance to be lost at that polity (re-research at 0.3× cost).
- **Baseline calibration targets** (cumulative KP, median run): 2100 ≈ 2.5e5, 2150 ≈ 6.5e5, 2200 ≈ 1.2e6, 2300 ≈ 4e6, 2500 ≈ 3e7, 3000 ≈ 6e8, 5000 ≈ 1e10.

### 3.2 Modifiable variables (effects target these names)

`launch_cost_LEO`, `transport_cost_mult`, `transit_time_mult`, `payload_frac_mult`, `resupply_mass_mult`, `ls_failure_hazard`, `food_import_mult`, `energy_cap_W` (per settlement), `civ_energy_cap_W`, `habitat_cost_mult`, `shield_fraction`, `radiation_mortality_mult`, `lowg_health_penalty`, `lowg_fertility_mult`, `K_mult` (carrying capacity), `research_mult`, `labor_prod_mult`, `capital_growth_max`, `ssi_automation_mult`, `mortality_mult`, `fertility_mult`, `impact_prob_mult`, `interstellar_v_max_c`, `interstellar_payload_kg`, `t_settle_years`, `divergence_rate_mult`, `regime_mod[...]`, `event_enable[...]`, `settle_unlock[body_class]`.

### 3.3 Pre-known at 2040 (cost 0)

| id | Name | Effect at t0 |
|---|---|---|
| T00 | Reusable super-heavy lift (Starship-class) | launch_cost_LEO = 100 cr/kg; ship class V_SS3 |
| T01 | Orbital propellant transfer | enables Mars/Moon crewed landings (≈8–10 tankers per Mars ship) |
| T02 | ECLSS ISS-class | 98% water, 50% O2 recovery; resupply ≈0.7 t/person/yr |
| T03 | Space PV 300 W/kg | solar viable inside ≈5 AU |
| T04 | Fission surface power 10–100 kWe | outposts can survive night/dust storms |
| T05 | Pilot ISRU | MOXIE/Sabatier pilot; ice drilling at ≤ 1 t/day |
| T06 | Narrow AI + teleoperated robotics | robotic outposts possible; lag ≤ 1 s teleop on Moon only |
| T07 | Optical deep-space comms | ≈1–10 Gbps Mars link |

### 3.4 Researchable technologies (69)

Columns: id · name · prerequisites · cost (KP) · earliest plausible year · effects. A **[S]** suffix marks speculative tech that also needs a per-run `p_feasible` roll (drawn at world-gen). If the roll fails, completion yields "No-Go theorem proven" and refunds 30% as generic progress.

#### Near tier (2040–2120)

| id | Name | Prereqs | Cost | Earliest | Effects |
|---|---|---|---|---|---|
| N01 | Industrial ISRU propellant (Sabatier + electrolysis, ≥1,000 t/synod) | T05, T01 | 3,000 | 2045 | Mars (and any body with water + CO2/C) makes return propellant: Mars→Earth cost ×0.3; unlocks Mars state 3→4 (§4) |
| N02 | ECLSS-90 (90% O2, 99% water closure) | T02 | 2,500 | 2045 | resupply_mass_mult ×0.5; ls_failure_hazard ×0.8 |
| N03 | Bioregenerative life support (≥50% food local) | N02 | 6,000 | 2055 | food_import_mult ×0.5; activates K_food |
| N04 | Fission MWe reactors (1–10 MWe units) | T04 | 5,000 | 2050 | energy_cap_W ×10 per settlement; dust-storm energy loss ×0.2 |
| N05 | Regolith construction (sintering, 3D print, burial) | T05 | 4,000 | 2050 | habitat_cost_mult ×0.5; shield_fraction → 0.9 |
| N06 | Nuclear thermal propulsion (Isp ≈ 900 s) | T04 | 6,000 | 2050 | transit_time_mult ×0.67; payload_frac_mult ×1.3 (crewed interplanetary) |
| N07 | In-space manufacturing I (metal AM, microgravity fabs) | T06, N05 | 6,000 | 2055 | manufactured import share ×0.6; SSI +0.1 |
| N08 | NEA prospecting (survey fleet + sample return) | T01 | 2,500 | 2045 | all NEA bodies → SURVEYED; reveals resource scores |
| N09 | Asteroid mining I (volatiles from C-types, depots) | N08, N01 | 9,000 | 2060 | LEO propellant cost ×0.5; robotic outposts on NEAs |
| N10 | Lunar mass driver | N05, N04 | 12,000 | 2070 | Moon→L4/L5 cost ×0.1 (≈5 cr/kg); lunar export of O2, metals, regolith shielding |
| N11 | Space medicine (radioprotective drugs, partial-g countermeasures) | N02 | 8,000 | 2065 | radiation_mortality_mult ×0.5; lowg_health_penalty ×0.5; lowg_fertility_mult 0.6→0.85 |
| N12 | Controlled-environment agriculture (95% food closure) | N03 | 10,000 | 2075 | food_import_mult ×0.1; greenhouse m²/person ×0.5 |
| N13 | Nuclear electric propulsion, MW-class (Isp 3,000–10,000 s) | N04 | 9,000 | 2070 | outer-system cargo transport_cost_mult ×0.5 |
| N14 | AGI (human-level general AI and robotics) | T06 | 20,000 | 2045 (scenario dial) | ai_mult ×3; labor_prod_mult ×3; ssi_automation_mult ×100; enables M13; AI events on (E38) |
| N15 | D-T fusion power plants (grid) | – | 15,000 | 2060 | Earth energy growth +2%/yr; energy cost ×0.7; tritium breeding needs Li |
| N16 | Mature HTS magnets (≥20 T, cheap) | – | 10,000 | 2060 | N17 cost ×0.7; mass driver cost ×0.7; enables active magnetic shielding (shield +0.05) |
| N17 | Compact fusion (D-D / D-He3, 10 MW–1 GW units) | N15, N16 | 35,000 | 2095 | energy_cap_W ×10; outer-system settlements no longer flux-limited; He-3 demand on |
| N18 | Fusion drive (DFD; Isp 1e4–1e5 s; v_max ≈ 300 km/s) | N17, N06 | 50,000 | 2110 | transit_time_mult ×0.3 (Mars 30–60 d, Saturn ≈ 1 yr); interplanetary trade ×3 |
| N19 | Space solar power + concentrators | T03 | 7,000 | 2055 | beamed power to Earth/settlements; solar mirrors give flux ×10 (outer system ×3) |
| N20 | Orbital shipyards | N07, N09 | 15,000 | 2075 | ship build cost ×0.5; max ship mass 1e7 kg |
| N21 | Rotating habitats, small (≤10k pop; Kalpana One / Bernal-class) | N11, N20 | 25,000 | 2085 | settle free-space sites H01–H04; gravity factor = 1 |
| N22 | Germline gene editing (radiation, bone, low-O2 tolerance) | – | 15,000 | 2060 | radiation_mortality_mult ×0.7; divergence_rate_mult ×3; triggers E36/E37 ethics schisms |
| N23 | Medical torpor (weeks–months hibernation) | N11 | 25,000 | 2100 | in-transit consumables ×0.3; transit mutiny/psych hazard ×0.3 |
| N24 | Paraterraforming (km-scale domes, roofed craters, lava tubes) | N05, N12 | 25,000 | 2095 | K_mult ×5 on rocky bodies; shield_fraction 0.95 |
| N25 | Planetary defense (operational deflection) | N08 | 5,000 | 2050 | impact_prob_mult ×0.1 for ≥140 m objects, ×0.5 for 50 m |
| N26 | High-bandwidth BCI | N14 | 20,000 | 2080 | research_mult ×1.3; prerequisite for uploading |
| N27 | Longevity I (healthy life +30 yr) | N22 | 30,000 | 2090 | mortality ×0.6 above age 60; fertility_mult ×0.9; median age +8 |
| N28 | Laser-sail probes (Starshot: 1 g chips at 0.2c, 100 GW array) | N19, N16 | 30,000 | 2075 | flyby probes reach ≤ 20 ly in ≤ 100 yr → star systems SURVEYED (partial truth reveal) |
| N29 | Artificial womb (ectogenesis) | N22 | 20,000 | 2080 | births independent of gravity; lowg_fertility_mult → 1.0; enables embryo ships |
| N30 | Carbon nanomaterials at tonnage (CNT/graphene ≥ 50 GPa) | N07 | 30,000 | 2090 | structure mass ×0.5; prerequisite for elevators |
| N31 | Self-replicating factories I (90% closure, 10-yr doubling) | N14, N07 | 50,000 | 2100 | capital_growth_max ×2; robotic outposts self-expand to colony infrastructure without crew |

#### Mid tier (2100–2800)

| id | Name | Prereqs | Cost | Earliest | Effects |
|---|---|---|---|---|---|
| M01 | O'Neill cylinder (Island Three: 8 km × 32 km, 1–10M pop) | N21, N31, (N10 or N09) | 150,000 | 2150 | free-space habitat with K ≤ 1e7; build mass 1e10–1e11 kg (shield-dominated, ≈4.5 t/m²); build time 10–30 yr |
| M02 | Low-g elevators and skyhooks (Moon, Mars–Phobos) | N30, N16 | 80,000 | 2130 | launch cost from Moon/Mars ×0.05 |
| M03 | Earth space elevator [S p=0.5] | M02, N30 (≥100 GPa) | 400,000 | 2200 | launch_cost_LEO → 2–5 cr/kg; Earth emigration capacity ×10; E48 enabled |
| M04 | Venus aerostat cities | N12, N30 | 50,000 | 2130 | Venus cloud layer H 0.35→0.55; unlock Venus states ≥ 4 |
| M05 | Titan cryo-industry | N17 | 50,000 | 2140 | Titan H +0.15; nitrogen and hydrocarbon export |
| M06 | Gas-giant atmospheric scooping (He-3, H2, D) | N17, N18 | 90,000 | 2160 | He-3 effectively unlimited from Uranus/Saturn/Neptune |
| M07 | Asteroid mining II (main-belt metals, PGM, Psyche) | N09, N20 | 60,000 | 2110 | metal extraction cap ×10; belt hubs viable |
| M08 | Mars terraforming I (warming: engineered nanorods/SF6, +30 K) | N24, N04, N31 | 150,000 | 2150 | Mars T +0.3 K/yr until +30 K; CO2 release → 0.05–0.1 bar over 200 yr; H_Mars +0.1; liquid water seasonal |
| M09 | Mars terraforming II (thick atmosphere, open water) | M08, (M06 or M10) | 1,000,000 | 2300 | 0.3–0.5 bar over 300–500 yr; outdoor with breathing mask; H_Mars → 0.75 |
| M10 | Comet / KBO redirection (volatile delivery) | N18 | 200,000 | 2200 | volatile import to inner bodies; raises impact event risk ×1.5 at target |
| M11 | Synthetic ecosystems (engineered biospheres) | N22, N12 | 80,000 | 2120 | food closure 0.99; ecosystem collapse hazard (E17) ×0.5 |
| M12 | Closed loop 99.9% (1,000-yr stable biome) | M11 | 250,000 | 2200 | required for generation ships; Aurora biome drift (E18) ×0.2 |
| M13 | ASI (superhuman AI) | N14, N26 | 300,000 | 2120 (scenario dial) | ai_mult ×30 (replaces ×3); triggers SING regime check; misalignment events ×3 |
| M14 | Self-replicating industry II (99.9% closure, 2-yr doubling) | N31, M07 | 300,000 | 2180 | capital_growth_max ×5; prerequisite for Dyson phases |
| M15 | Dyson swarm phase 1 (1e16 W captured; Mercury mining starts) | M14, N19 | 400,000 | 2200 | civ_energy_cap_W = 1e16 (Kardashev I, Sagan) |
| M16 | Dyson swarm phase 2 (1e20 W) | M15 | 3,000,000 | 2350 | civ_energy_cap_W = 1e20 |
| M17 | Dyson swarm phase 3 (1e24 W) | M16 | 30,000,000 | 2600 | civ_energy_cap_W = 1e24 |
| M18 | Dyson swarm complete (≥ 3.8e25 W, ≥ 10% L☉) | M17 | 200,000,000 | 3000 | civ_energy_cap_W = 3.8e26 × coverage; Kardashev ≈ 2 |
| M19 | Industrial antimatter (g/yr → kg/yr, efficiency 1e-4 → 1e-2) | M15, N16 | 500,000 | 2300 | antimatter stock produced at `E_input × eff / 9e16` kg; E42 enabled |
| M20 | Fusion interstellar probe (Daedalus-class, 450 t, 0.12c flyby) | N18, M06 | 300,000 | 2200 | robotic flyby/orbiter to ≤ 15 ly within 150 yr; full truth reveal |
| M21 | Orion nuclear pulse (interstellar, 0.003–0.03c) | N06 | 100,000 | 2150 | heavy ships 1e8–1e9 kg; needs a treaty event (E66) to launch from Earth orbit |
| M22 | Generation ship (1e3–1e4 pop; 1e8–1e10 kg; 0.005–0.02c; magsail braking) | M01, M12, (M21 or N18) | 1,000,000 | 2300 | interstellar colonization; voyages 200–1,500 yr; events E27–E30 |
| M23 | Embryo / seed ship (frozen embryos + AI custodians; 1e5–1e6 kg; 0.02–0.05c) | N29, (N14 or M13), M12 | 600,000 | 2250 | interstellar colonization at 1% of the mass; first generation raised by machines; E58 risk |
| M24 | Longevity II (negligible senescence) | N27, M13 | 1,000,000 | 2300 | intrinsic mortality → 0.001/yr; fertility_mult ×0.5 (policy); crews outlive voyages ≤ 300 yr |
| M25 | Psychohistory (predictive social science) | M13 | 1,500,000 | 2400 | regime transitions into COLL and WAR ×0.6 for polities that adopt the Plan; E59 "Seldon crisis" |
| M26 | Beamed-sail crewed ships (km sails, 100 TW lasers, 0.05–0.1c) | N28, M16, N30 | 5,000,000 | 2500 | interstellar_v_max_c 0.1 for 1e7 kg ships; the beam station acts as a military asset (RKV capability) |
| M27 | Posthuman clades (directed adaptation to low-g, vacuum, cold) | N22, M11 | 1,500,000 | 2400 | create clades; H × 1.5 for the target environment; speciation events (E34) |
| M28 | Venus terraforming (L1 sunshade, CO2 sequestration, H import) | M15, M14 | 10,000,000 | 2600 | Venus T falls 737 K → ≈ 300 K over ≈ 300 yr (CO2 snow); H_Venus → 0.7 after ≈ 2,000 yr |
| M29 | Mars terraforming III (O2 biosphere, breathable) | M09, M11 | 5,000,000 | 2600 | H_Mars → 0.85 after ≈ 1,000 yr of biology plus industrial O2 |
| M30 | Solar gravitational lens telescope (550–1,000 AU) | N18 | 150,000 | 2150 | full truth reveal (habitable, biosphere) for all planets ≤ 100 ly; 1 target per decade |

#### Far tier (2400+)

| id | Name | Prereqs | Cost | Earliest | Effects |
|---|---|---|---|---|---|
| F01 | Antimatter rocket (beamed-core, 0.3–0.5c) | M19, M16 | 50,000,000 | 3000 | interstellar_v_max_c 0.3 for 1e6 kg ships |
| F02 | Mind uploading (whole-brain emulation) [S p=0.6] | M13, N26 | 20,000,000 | 2500 | digital persons: 1–10 kW compute each, no food/air; subjective speed ×1–1000; population splits bio/digital |
| F03 | Digital seed probe (uploads + nanofab, 1–1,000 kg at 0.2–0.5c) | F02, F04, (F01 or M26) | 30,000,000 | 2800 | t_settle_years → 50–200 (bootstraps an industrial base on arrival) |
| F04 | Molecular nanotechnology (atomically precise manufacturing) [S p=0.5] | M14, M13 | 5,000,000 | 2400 | manufacturing ×10; build times ×0.1; E40 grey goo and E60 nanoplague enabled |
| F05 | Matrioshka brain (stellar-scale computing) | M18, F02 | 500,000,000 | 4000 | research_mult ×1000 within the system |
| F06 | Star lifting | M18 | 200,000,000 | 5000 | stellar mass harvesting; metal feedstock ×100; extends stellar lifetime |
| F07 | Alcubierre warp drive [S p=0.01] | F01, F05 | 1e10 | 8000 | if feasible: effective v = 10c (config), interstellar trade possible; otherwise no-go |
| F08 | Traversable wormholes [S p=0.005] | F07 | 1e10 | 9000 | if feasible: zero-lag link between two systems once a mouth is carried sublight |

### 3.5 Kardashev scale thresholds

Sagan's continuous formula: `K = (log10(P_watts) − 6) / 10`.

| Level | Power (Sagan) | Kardashev 1964 original | Meaning | When in a sim run (median) |
|---|---|---|---|---|
| 0.73 | 2.1e13 W | – | Earth 2040 | t0 |
| 0.8 | 1e14 W | | Earth + early space solar/fusion | ≈ 2100–2150 |
| I (1.0) | 1e16 W | ≈ 4e12–1.7e17 W (planetary insolation 1.74e17 W) | planetary-scale | ≈ 2200–2400 (Dyson phase 1) |
| 1.4 | 1e20 W | | 2.6e-7 L☉ | ≈ 2400 |
| 1.8 | 1e24 W | | 0.3% L☉ | ≈ 2700–3500 |
| II (2.0) | 1e26 W | 3.8e26 W (L☉) | full stellar | ≈ 3000–5000 if expansion continues |
| III (3.0) | 1e36 W | 4e37 W | galactic | not reachable in 10k yrs (light-speed limit) |

### 3.6 Propulsion and interstellar vehicle reference

| Class | Isp (s) / exhaust v | v_max practical | Example | Earth→Mars | Earth→Saturn | To Proxima (4.25 ly) | Energy per mission (J) | In 2040-units (×6.6e20 J/yr) |
|---|---|---|---|---|---|---|---|---|
| Chemical methalox | 380 | 15–20 km/s | Starship | 90–260 d | 6–7 yr | 70,000 yr | – | – |
| NTR | 900 | 25 km/s | DRACO successors | 90–150 d | 3–4 yr | – | – | – |
| NEP | 3,000–10,000 | 50–100 km/s | | 150–300 d (cargo) | 2–3 yr | – | – | – |
| Fusion DFD | 1e4–1e5 | 300 km/s | PPPL DFD | 30–60 d | ≈ 1 yr | 4,000 yr | – | – |
| Orion pulse (Dyson 1968) | 1e4–1e6 | 0.0033–0.033c | 1e8–1e10 kg | days | months | 130–1,300 yr | ≈ 1e22 | ≈ 15 |
| Daedalus (BIS 1978) | 1e6 (1e4 km/s exhaust) | 0.12c (flyby) | 450 t payload, 5.4e4 t D/He-3 | – | – | 36 yr (Barnard's 50) | ≈ 1.7e22 | ≈ 26 |
| Starshot laser sail | photon | 0.2c | 1 g chip, 100 GW × 10 min | – | – | 20 yr (flyby) | ≈ 1e14 per chip (laser) | ≈ 0 |
| Generation ship (fusion) | 1e6 | 0.005–0.02c | 1e9 kg, 1,000–10,000 pop (Project Hyperion 2024: 1,000 ± 500 crew, 250 yr) | – | – | 210–850 yr | 4.5e21 (KE at 0.01c) × 3–10 | 20–70 |
| Embryo seed ship | 1e6 | 0.02–0.05c | 1e6 kg | – | – | 85–210 yr | ≈ 1e21 | ≈ 2 |
| Beamed crewed sail | photon | 0.1c | 1e7 kg; 150 TW for 10 yr; `E_laser = m v c / 2` | – | – | 43 yr | 4.5e22 | ≈ 70 |
| Antimatter beamed-core | 1e7 | 0.3–0.5c | 1e6 kg | – | – | 9–14 yr | ≈ 1e23 (incl. 1% production efficiency) | ≈ 150 |
| Alcubierre [S] | – | ≥ c | – | – | – | < 1 yr | unknown (≥ Jupiter mass-energy in early papers) | – |

**Interstellar launch rule** [D]: a polity may launch only if `E_mission ≤ 0.02 × civ_energy_W × 3.156e7 × build_years` (≤ 2% of annual energy for the build duration, build_years 10–50) and `capital_cost ≤ 0.05 × GDP × build_years`. Ships must also clear the "will" gate: regime ∈ {EXP, GOLD, SING} or an ideology event (E36 religion with an exodus doctrine).

**Relativistic notes:** at 0.1c, γ = 1.005 (ignore). At 0.5c, γ = 1.155, so ship time is 13% shorter. Dust impact at 0.1c: a 1 µg grain carries 4.5e5 J (≈ 100 g TNT). Ships need a Whipple shield or ablative front, and per-voyage loss hazard is E28.

