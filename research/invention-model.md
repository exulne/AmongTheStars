# Invention Model: Emergent Technology for 2SOON2026

Implementation spec for replacing fixed tech costs (`src/sim/catalog.ts`, 46 techs) with an **emergent invention model**: capability axes with physical ceilings, a 69-tech hand-written spine drawn from `simulation-bible.md` §3.4, a combinatorial generator that invents new techs from pairs of known ones, invention as a Poisson process driven by researcher populations, and diffusion and adoption across light-lag distances.

It extends bible §3.1 (semi-endogenous knowledge production, λ = 0.75) and does not replace it. KP stays the unit of knowledge. What changes is what KP buys, and when and where a given invention happens.

Status tags (same as the bible):
- **[R]**: real, sourced or well-established value (rounded).
- **[E]**: engineering estimate or extrapolation.
- **[D]**: design parameter, tune freely.
- **[S]**: speculative physics.

### Provenance

Numbers checked against a source **fetched in this session** are marked *(fetched)*:
- Bloom, Jones, Van Reenen & Webb, "Are Ideas Getting Harder to Find?" (NBER w23782; AER 110(4):1104–1144, 2020). Table 6 and the text figures were extracted from the PDF.
- Comin & Hobijn 2010 (AER 100:2031–2059): the 45-year average lag across 15 technologies and 166 countries, from the published abstract via search. An earlier draft gives 47 years with SD 39.
- The ITER 2024 re-baseline: research operation 2034, full magnetic energy 2036, D-T 2039.
- The DARPA/NASA DRACO NTR demonstrator: cancelled in the FY2026 budget request, May 2025.
- Grace et al. 2024, *Thousands of AI Authors on the Future of AI* (2,778 respondents): HLMI 10% by 2027 and 50% by 2047; full automation of occupations 10% by 2037 and 50% by 2116.

**Every other [R] value comes from memory of the literature and was not re-fetched.** Treat those as "very likely right to the stated rounding." Items I am least sure of carry *(memory, verify)*. In particular, these were **not** fetched: the per-technology lags in Comin & Hobijn, Merton's priority-dispute shares, every row of the adoption table in §6.4, and the learning rates in §6.5.

---

## 0. Architecture in one page

```
                 ┌────────────── world-gen ──────────────┐
                 │ roll speculative gates (§2) per seed   │
                 └────────────────────────────────────────┘
per year, per polity p:
  1. KP_rate(s) for each settlement s (§5.1)  →  pooled KP(p) by light-lag clusters (bible §3.1)
  2. allocate KP(p) across candidates: spine techs (§3) + generated techs (§4) + gate probes (§2)
  3. for each candidate j: progress P_j += a_j·KP(p); Poisson hazard of invention (§5.2)
  4. invention event → frontier axis values of p rise (§1) → name the inventor and settlement
  5. multiples and priority disputes (§5.4)
  6. blueprint diffusion to other polities: light lag + assimilation; war blocks it (§6.1–6.2)
  7. adoption S-curves per settlement: deployed axis values move toward the frontier (§6.3)
  8. knowledge loss (Tasmania) where practitioners < threshold (§6.6)
  9. deployed axis values → engine multipliers, ship classes, habitats, people, weapons (§8)
```

Three state layers per polity or settlement [D]:

| Layer | Scope | Stored as | Changes by |
|---|---|---|---|
| **Knowledge** (what is known) | polity | set of tech ids + `progress[j]` | invention, diffusion, loss |
| **Frontier capability** | polity | `frontier[axis]`: best value any known tech gives | invention (instant) |
| **Deployed capability** | settlement | `deployed[axis]` ≤ frontier | adoption S-curve (years to decades) |

The engine reads **deployed** values. The tech-tree UI shows **knowledge**. Charts can show both, since the gap between them is the "tech_lag" metric (bible §10.4 #58).

---

## 1. Capability axes (37)

### 1.1 Representation

Each axis `a` has a raw value `v` (real units), a 2040 anchor `v0`, a hard ceiling `vmax` (set by a physical law), and a transform kind:

| Kind | Progress coordinate `u` | Normalised level `ℓ ∈ [0,1)` |
|---|---|---|
| `log_up` (bigger is better, spans decades) | `u = ln(v / v0)` | `ℓ = u / ln(vmax / v0)` |
| `log_down` (smaller is better: cost, dose, time) | `u = ln(v0 / v)` | `ℓ = u / ln(v0 / vmin)` |
| `nines` (closure fractions) | `u = −log10(1 − f) − n0` | `ℓ = u / (n_max − n0)` |
| `linear` / `ordinal` | `u = v − v0` | `ℓ = u / (vmax − v0)` |

Rules [D]:
- `ℓ` can go negative after knowledge loss (a settlement below 2040 capability).
- **Spine techs** set a floor: `frontier = max(frontier, value)`.
- **Generated techs** add `Δu`, damped by `(1 − ℓ)²` (§4.4).
- **Derived** axes are computed from other axes and are never researched directly.

**Difficulty multiplier** (this is where "ideas get harder to find" lives; see §5.3):

```
Dif_a(ℓ) = exp(β'_a × u_a) / (1 − ℓ_a)^2
```

The first factor is the Bloom et al. power law, `A^β`, written in e-folds of progress. The second is a physics wall that diverges at the ceiling. `β'_a = λ × β_Bloom`, with λ = 0.75 (derivation in §5.3).

### 1.2 Axis table

Fields: **P** propulsion and transport, **E** energy, **B** bio and life support, **M** materials and fabrication, **I** information and AI, **H** habitat and environment. The "Curve / learning" column gives the shape of progress and, for cost axes, the Wright's-law learning rate (LR, cost drop per doubling of cumulative output).

| id | Axis (field) | Unit, kind | 2040 value | Plausible 2100 | Hard ceiling (law) | Curve / learning | β′ |
|---|---|---|---|---|---|---|---|
| A01 | High-thrust exhaust velocity (P) | Isp s, log_up | 380 (methalox) [R] | 900–1,000 (NTR) [E] | 3.06e7 s = c/g0, photon rocket (special relativity) [R]. Practical fusion-product ceiling ≈ 2e6 s (D-He3 products ≈ 0.05–0.08c) [R/E] | Step function: each engine family is its own logistic, set by spine techs | 1.5 [D] |
| A02 | Low-thrust (electric) Isp (P) | s, log_up | 4,000 (Hall/gridded ion; NEXT-C ≈ 4,100) [R] | 1e4 [E] | c/g0 [R]; in practice set by A03 | Logistic toward 1e5 | 1.1 [D] |
| A03 | Power-system specific power (P/E) | W/kg incl. radiators, log_up | 10 (SEP/NEP system) [E]; PV array alone 300 [bible T03] | 100 (fission NEP, early fusion) [E] | ≈1e4–1e5 W/kg, radiator-limited: q = εσT⁴ at T ≤ A21, plus Carnot reject fraction (Stefan–Boltzmann + Carnot) [R law / E value] | Logistic; jumps with N04, N13, N17, N18 | 1.5 [D] |
| A04 | Max cruise velocity, ≥1 t payload (P) | fraction of c, log_up, **derived** | 6e-5 (≈17–20 km/s; Voyager 1 17.0 km/s) [R] | 1e-3 (300 km/s DFD) [E] | 1 (c). Practical ≈0.3–0.5c: dust erosion, since 1 g at 0.3c carries 4.3e12 J (≈1 kt) [R physics] | From §8.1 formulas | – |
| A05 | Launch cost to LEO (P) | cr/kg, log_down | 100 [bible E] | 20 [E] | ≈0.3–1 cr/kg: orbital specific energy 33 MJ/kg ≈ 9 kWh plus capital (energy conservation) [R/E] | Wright LR ≈15% per doubling of cumulative mass to orbit [E, no clean data]; the bible uses `exp(−t/25)` toward a 15 cr/kg floor | 1.0 [D] |
| A06 | Directed-energy beam power per installation (P) | W, log_up | 1e6 (300 kW laser weapons fielded 2024) [R/E] | 1e10 [E]; Starshot needs 1e11 for ≈10 min [R] | Bounded by civilisation power × allowed share; reach bounded by diffraction θ = 1.22λ/D [R] | Logistic; Wright LR ≈20% on cr/W (diode lasers) [E] | 1.0 [D] |
| A07 | Civilisation power capture (E) | W, log_up, **derived** | 2.1e13 [bible E] | 4e13 [E] | L☉ = 3.83e26 W per Sun-like star (Kardashev II) [R] | Deployment-driven (bible §3.5) | – |
| A08 | Energy per capita, biological persons (E) | kW/person, log_up, **derived** | 2.3 [bible R/E] | 4 [E] | Planet-bound: waste heat. 1.7e15 W on Earth adds ≈3.4 W/m² (≈ CO₂-doubling forcing 3.7 W/m²), so ≈170 kW/person at 1e10 people [R physics/E]. Off-planet: L☉ / N | Derived | – |
| A09 | Energy-conversion efficiency (E) | %, linear | PV module 26% [E]; best cell 47.6% (4-junction concentrator, 2022) [R memory] | module 40–45% [E] | Shockley–Queisser 33.7% (single junction, 1 sun); 86.8% (infinite junctions, full concentration); Landsberg 93.3%; heat engines Carnot 1 − Tc/Th [R] | Logistic; PV module LR 20–24% on cr/W [R memory] | 1.9 [D] |
| A10 | Storage specific energy (E) | Wh/kg, log_up | 500 (cells) [E]; 2024 ≈ 300 [R] | 1,200 (Li-S / Li-air practical) [E] | Chemical: Li-air ≈ 11,000 Wh/kg excluding O₂ [R memory]. Absolute: mc² = 2.5e13 Wh/kg [R] | Logistic; pack LR ≈18–20% [R memory, Ziegler & Trancik 2021] | 1.5 [D] |
| A11 | Fusion tier (E) | ordinal 0–5, continuous | 1.3. Scientific gain > 1 shown (NIF, Dec 2022) [R]; ITER D-T 2039 *(fetched)* | 3.2 [E] | 4 = D-D/D-He3 compact. 5 = p-B11 net power, gate G13 [S]. Bremsstrahlung losses (Rider 1995) [R memory] | 0 none · 1 Q_sci > 1 · 2 D-T net electric · 3 D-T commercial · 4 advanced fuels · 5 p-B11 | 1.9 [D] |
| A12 | Antimatter production efficiency (E) | J rest-mass out / J in, log_up | 1e-9 (accelerator-scale) [E memory] | 1e-8 [E] | 0.5 (pair production makes matter + antimatter) [R physics]. Practical 1e-4, or 1e-2 if gate G07 passes [S] | Log-linear with Dyson-scale energy | 0.75 [D] |
| A13 | ECLSS closure, water + O₂ (B) | nines, nines | 1.7 (98% water, NASA 2023 [R memory]; ≈50% O₂ [bible]) | 3.0 (99.9%) [E] | ≈4–5 nines. Seal leakage and the minimum work of separation (2nd law); Biosphere 2 leaked ≈10% of its air per year [R memory] | Logistic in nines | 1.5 [D] |
| A14 | Growing area for a full diet (B) | m²/person, log_down | 50 (CEA; NASA BVAD ≈40–50) [E] | 20 [E] | ≈7 m² photosynthetic: 121 W food ÷ (6% C4 ceiling, Zhu, Long & Ort 2008 [R memory]) under 300 W/m² stacked light. ≈1 m² electro-chemical: CO₂→acetate→yeast ≈4× photosynthesis (Hann et al. 2022) [R memory] | Logistic | 2.5 [D] |
| A15 | Healthy life expectancy (B) | yr, log_up | 66 healthy / 76 total [bible E] | 80 healthy / 88 total [E] | No known law. Gompertz doubling ≈8 yr [R]; max observed 122 [R]. Negligible senescence → ≈1,000 yr actuarial at 0.001/yr accident risk (bible M24) [S] | Logistic in ln(mortality) | 2.6 (medicine: NME −3.5%/yr, Bloom) [D from R] |
| A16 | Gene-editing scope (B) | log10 safe germline edits per genome, linear | 1.0 (≈10). Somatic therapy approved 2023 (Casgevy) [R] | 3.0 (≈1,000) [E] | 9.5 = whole-genome synthesis (3.1e9 bp) [R size] | Logistic | 1.1 [D] |
| A17 | Suspended-animation duration (B) | days, log_up | 3 (therapeutic hypothermia scale) [E] | 180 [E] | Indefinite (vitrification) only via gate G11 [S]. Hibernators reach ≈5% BMR [R] | Logistic | 1.5 [D] |
| A18 | Ectogenesis coverage (B) | fraction of 40-week gestation, linear | 0.65 [E] (viability ≈22 wk = 0.55 in 2024 [R]; lamb "biobag" ≈4 wk [R memory]) | 1.0 [E] | 1.0 | Logistic | 1.5 [D] |
| A19 | Radiation tolerance (B) | Sv per +5% fatal-cancer risk, log_up | 1.0 (ICRP ≈5%/Sv) [R] | 2.0 (drugs + edits) [E] | ≈20 Sv [S]. Cellular extremophiles survive kGy (Deinococcus) but organisms differ; tardigrade Dsup cuts DNA damage ≈40% in human cells [R memory] | Logistic | 1.9 [D] |
| A20 | Specific strength, tonnage structure (M) | MN·m/kg (= MJ/kg), log_up | 2.0 bulk composite [E] (T1100 fibre ≈3.7, Zylon ≈3.8 [R memory]) | 15 (CNT/graphene composites; bible N30 ≥50 GPa) [E] | ≈50–100: graphene intrinsic σ ≈130 GPa (Lee et al. 2008) ÷ 1.3–2.2 g/cm³ (C–C bond strength) [R memory] | Logistic; jumps with N30 | 1.5 [D] |
| A21 | Max service temperature (M) | K, linear | 2,300 [E] | 3,000 [E] | ≈4,200–4,400 K (Ta₄HfC₅ ≈4,215 K; HfCN predicted ≈4,400 K) [R memory] | Logistic; sets Carnot Th for A03/A01 | 2.3 [D] |
| A22 | Practical magnet field (M) | T, linear | 20 (REBCO large coil, CFS 2021) [R] | 30 [E] | Magnetic pressure B²/2μ₀: 45 T ≈ 0.8 GPa, 100 T ≈ 4 GPa, so tied to A20. Non-destructive record ≈45.5 T [R memory] | Logistic; ×cost 0.1 if gate G06 | 1.5 [D] |
| A23 | Fabrication closure (M) | fraction of own mass made locally, linear | 0.3 (Mars) [E]; Earth ≈1.0 | 0.9 (bible N31) [bible] | 1 − ε: electronics need ≈50–70 elements [E] | Logistic; 0.999 at M14 | 1.1 [D] |
| A24 | Industrial doubling time (M) | yr, log_down, **derived** from A23, A27 | 20 [E] | 10 (bible N31) [bible] | 0.5 yr macroscale [E]; 0.05 yr with MNT (gate G04) [S]; bacteria 20 min [R] | Derived (§8.3) | – |
| A25 | Positional precision in mass manufacture (M) | nm, log_down | 0.5 [E] (EUV overlay ≈1–2 nm in 2024 [R memory]) | 0.3 [E] | 0.07–0.15 nm = atomic spacing (C–C 0.154 nm) [R]; reached only via gate G04 | Logistic | 0.4 [D] |
| A26 | Computation per joule (I) | FLOP/J, log_up | 1e12 [E] (Green500 top ≈7e10 in 2024 [R memory]) | 1e15 [E] | Landauer 1/(kT ln 2) = 3.5e20 bit-ops/J at 300 K, 3.5e22 at 3 K [R]. Reversible computing (gate G12) lifts it. Bremermann 1.36e50 bit/s/kg [R] | Koomey: doubling 1.57 yr (1946–2000), ≈2.6 yr after 2000 [R memory] | **0.15** (Moore's law β = 0.2 × λ) *(fetched)* |
| A27 | AI level (I) | 0–6 ordinal, continuous | 1.5 (strong narrow AI + teleoperation) [D scenario] | 3.0–4.0 [D] | None known [S]. 3 = AGI (N14), 5 = ASI (M13), 6 = Matrioshka-scale (F05) | ai_mult table in §8.6 | 1.1 [D] |
| A28 | Archival information density (I) | bits/kg, log_up | 1e16 [E] (HDD/tape ≈2e14 in 2024 [E]) | 1e19 [E] | ≈3e25 bits/kg at 1 bit/atom [E]. DNA demo density 215 PB/g ≈ 1.7e21 bits/kg (Erlich & Zielinski 2017) [R memory]. Bekenstein 2.6e43 bits for 1 kg in 1 m [R] | Logistic | 0.4 [D] |
| A29 | Deep-space link rate at 1 AU (I) | bit/s per link, log_up | 1e10 (bible T07 Mars link) [bible E]; DSOC 267 Mbps from 0.2 AU in 2023 [R memory] | 1e12 [E] | Holevo/photon-information bound: received photons/s × ≈10 bits/photon; received photons ∝ P·Dt²·Dr²/(λ²d²) [R law] | Logistic; scales 1/d² to stars | 0.75 [D] |
| A30 | BCI channels (I) | log10 neurons recorded/stimulated, linear | 4.5 [E] (1,024 electrodes in 2024 [R]) | 7.0 [E] | 10.9 = 8.6e10 neurons (Azevedo 2009) [R] | Logistic | 1.1 [D] |
| A31 | Connectome mapped, one specimen (I) | log10 synapses, linear | 11 (whole mouse ≈1e11) [E]; 2024: H01 1 mm³ human cortex ≈1.5e8, FlyWire fly ≈5e7 [R memory] | 14.2 (whole human ≈1.5e14) [E] | 14.2 for a human brain; beyond that, emulation fidelity (gate G03) | Logistic | 0.75 [D] |
| A32 | Exoplanet imaging (I) | resolution elements across an Earth at 10 pc, log_up | 1 (spectra only; ELT first light ≈2029–30, HWO 2040s) [E] | 10 (100 km-baseline space interferometer) [E/S] | Diffraction θ = 1.22λ/D [R]. Solar gravitational lens at ≥550 AU: ≈1,000 × 1,000 (Turyshev & Toth 2020) [R memory] | Step at M30 | 0.75 [D] |
| A33 | Social-forecast horizon (I) | yr at Brier skill > 0.1 vs base rate, log_up | 3 [E] (superforecasters ≈1–2 yr, near chance by 3–5 yr; Tetlock & Gardner 2015 [R memory]) | 6 [E] | ≈30–50 yr, chaos plus reflexivity [S]; beyond needs gate G14 | Logistic; feeds M25 and the app's forecaster | 2.3 [D] |
| A34 | Habitat radiation dose (H) | mSv/yr, log_down | 100 (Mars habitat, ≈1 m regolith; unshielded surface 230) [bible R/E] | 20 [E] | 2.4 = Earth background [R]. Passive: ≈5–10 t/m² (Earth's air column 10.3 t/m²) [R]. Active shield needs Bρ ≈5.7 T·m for 1 GeV protons [R physics] | Logistic | 1.5 [D] |
| A35 | Pressurised volume cost (H) | cr/m³, log_down | 1e4 (Mars) [bible] (ISS ≈1.6e8/m³ [R]) | 1.5e3 [E] | ≈10–30 cr/m³ (materials + energy) [E]. Minimum vessel mass = 1.5·P·V·ρ/σ for a sphere (hoop stress) [R law] | Wright LR ≈10% (construction learns slowly) [E] | 1.5 [D] |
| A36 | Terraforming rate, Mars-class body (H) | mbar of atmosphere per century, log_up | 0 (stored as 1e-3) [D] | 0.01 (pilots) [E] | Inventory-limited, not energy-limited: 1 bar Mars CO₂ ≈ 2.5e16 kg × 571 kJ/kg ≈ 1.4e22 J, i.e. 16 days at 1e16 W [E physics]; accessible Mars CO₂ is only ≈20 mbar (Jakosky & Edwards 2018) [R memory], hence comet import | Step at M08/M09/M10 | 1.5 [D] |
| A37 | Asteroid deflection capacity (H) | m diameter with 10 yr warning, log_up | 500 [E] (DART 2022 on 160 m Dimorphos, β ≈3.6 [R memory]) | 3,000 [E] | ≈10–20 km (nuclear standoff, energy coupling) [E] | Logistic; dual-use (§8.5) | 1.1 [D] |

**Why the β′ values look like this.** Bloom et al. Table 6 *(fetched)*: semiconductors β = 0.2, aggregate economy β = 3.4, crop yields 2.5–7.2, Compustat firms 0.9–1.8. Health has no β because the outputs are not growth rates, but research productivity falls 3.5%/yr for new molecular entities and 5.7–10.1%/yr for cancer trials. I scaled each field by analogy: IT is the low-β outlier, biology and agriculture are high. All per-axis β′ values are [D] and anchored only by analogy.

### 1.3 Field summary

| Field | Axes | Mean β′ [D] | Share of 2040 research KP [D] | Historical analogue |
|---|---|---|---|---|
| P Propulsion | A01–A06 | 1.3 | 0.20 | aerospace (high β, lumpy) |
| E Energy | A07–A12 | 1.5 | 0.20 | energy R&D; PV and battery learning |
| B Bio / life support | A13–A19 | 1.8 | 0.20 | pharma, crop yields (β 2.5–7) |
| M Materials / fab | A20–A25 | 1.4 | 0.15 | materials and chemicals |
| I Information / AI | A26–A33 | 0.8 | 0.20 | semiconductors (β 0.2) |
| H Habitat / environment | A34–A37 | 1.4 | 0.05 | civil engineering |

---

## 2. Speculative gates

A **gate** is a yes/no fact about physics (or extreme engineering) that the universe decides at world-gen and the civilisation discovers by research. It replaces the bible's `[S p=…]` flags with a richer mechanism.

### 2.1 Roll mechanics [D]

1. **World-gen.** For each gate g, draw `U_g ~ Uniform(0,1)` from the seed. The outcome is **feasible** if `U < p_g`, **costly** if `p_g ≤ U < p_g + p_costly,g` (works, at ×`c_g` cost), and **no-go** otherwise. Correlated gates draw conditionally (below).
2. **Hidden until probed.** No agent knows the outcome. A polity researching a gated tech first spends `K_probe = 0.3 × K_tech` on a "probe" candidate that follows the Poisson rules of §5.2.
3. **On probe completion.**
   - *Feasible*: event "Proof of principle: X". The gated tech becomes a normal candidate with the remaining 0.7·K.
   - *Costly*: event "Possible, but…". K and the deploy effort D are multiplied by `c_g`.
   - *No-go*: event "No-go theorem proven: {theorem name}". Refund 30% of KP spent as generic progress (bible rule). The axis ceiling freezes at its no-gate value, and every candidate (spine or generated) that requires the gate is pruned. The no-go result diffuses like a tech, so other polities stop spending on it once the news arrives.
4. **False dawns.** Each unresolved gate with active research has a **0.1 per century** chance of a "claimed breakthrough". Real precedents: cold fusion 1989, EmDrive 2001–2021, LK-99 2023 [R]. The event gives that field research_mult ×1.3 and a market bubble for 1–3 yr, then retraction (stability −0.02). It does not change the true outcome.

### 2.2 Gate table

| id | Gate | p_feasible | p_costly (×cost) | Unlocks (axis effect) | No-go event name (flavour from real physics) | Real status |
|---|---|---|---|---|---|---|
| G01 | Alcubierre / warp metric | 0.01 [bible D] | 0.01 (×100) | A04 effective > 1 (config: 10c); interstellar trade; F07 | "Quantum-inequality bound on negative energy (Ford–Roman)" | Needs negative energy density; positive-energy variants (2021) remain subluminal or disputed [R memory] |
| G02 | Traversable wormholes | P(G02 \| G01 feasible) = 0.25; P(G02 \| G01 no-go) = 0.002 → marginal ≈0.0045 [D] | 0 | Zero-lag link between two systems (F08) | "Topological censorship (Friedman–Schleich–Witt)" | Violates the averaged null energy condition classically [R] |
| G03 | Whole-brain emulation (uploads) | 0.6 [bible D] | 0.25 (compute per upload ×1e6) | People type "upload" (§8.4); F02, F03, F05 | "Emulation fidelity floor: mind requires sub-molecular state" | Fly connectome done; mouse feasible; consciousness question open [R/S] |
| G04 | Molecular nanotechnology (atomically precise manufacturing) | 0.5 [bible D] | 0.2 (×10, slow) | A25 → 0.07 nm; A24 → 0.05 yr; A23 → 0.9999; F04 | "Sticky-fingers theorem (Smalley)" | Drexler–Smalley debate 2003; partial progress in scanning-probe chemistry [R] |
| G05 | Macroscopic defect-free CNT ≥ 50 MN·m/kg | 0.5 [bible D for M03] | 0.2 (×5) | A20 ceiling → 60; Earth elevator M03 | "Weibull defect scaling caps macroscopic CNT at ≈30 GPa" | Long-fibre CNT ≈ few GPa in 2024 [R memory] |
| G06 | Room-temperature, ambient-pressure superconductor | 0.25 [S] | 0.15 (fragile, ×10) | A22 cost ×0.1, field ceiling +20 T; grid losses ×0.1; mass drivers ×0.3 cost | "Phonon-coupling Tc bound at ambient pressure" | Hydrides ≈250 K but only at ≈170 GPa (LaH₁₀, 2019) [R]; LK-99 refuted 2023 [R] |
| G07 | Antimatter production at scale (eff ≥ 1e-3) | 0.4 [S] | 0.3 (eff capped 1e-4) | A12 → 1e-2; F01 antimatter rocket | "Pair-production yield bound" | Nanograms ever produced [R memory] |
| G08 | Inertia damping / inertial-mass control | 0.002 [S] | 0 | Crew acceleration limit 3 g → 30 g: torch transit times ×0.3 | "Equivalence principle holds to 1e-15 (MICROSCOPE)" | MICROSCOPE 2022, η < 1e-15 [R memory] |
| G09 | Reactionless drive | 0.0005 [S]; P(G09 \| G08) = 0.2 | 0 | Propellantless thrust: A01 effectively ∞ at power-limited thrust | "Momentum conservation (Noether) reconfirmed; thrust anomalies were thermal artefacts" | EmDrive null results (Tajmar et al. 2021) [R memory] |
| G10 | Bussard ramjet net thrust | 0.1 [S] | 0.1 (only above 0.05c) | Fuel-free cruise to 0.1–0.2c (catalog `bussard`) | "Scoop drag exceeds fusion thrust (Fishback limit)" | Drag analyses since 1969 (Fishback; Zubrin & Andrews 1991) [R memory] |
| G11 | Reversible cryopreservation of humans | 0.3 [S] | 0.3 (50% revival survival) | A17 → indefinite; voyage consumables ≈0 | "Cryoprotectant toxicity is irreducible at organ scale" | Small organs vitrified; no mammal revival [R memory] |
| G12 | Reversible computing at scale | 0.3 [S] | 0.3 (×10 overhead) | A26 ceiling ×1e3 (beats Landauer) | "Error-correction entropy restores the Landauer cost" | Adiabatic CMOS demos only [R memory] |
| G13 | p-¹¹B fusion net power | 0.2 [S] | 0.2 (Q_eng ≈1.2 only) | A11 → 5: aneutronic, direct conversion, A03 ×3 | "Bremsstrahlung exceeds fusion power (Rider)" | Thermal p-B11 unlikely to ignite (Rider 1995) [R memory] |
| G14 | Psychohistory beyond the chaos horizon | 0.15 [S] | 0.25 (horizon 50 yr, not 200) | A33 ceiling 30 → 200 yr; M25 effect ×2 | "Reflexivity theorem: published forecasts destroy themselves" | Forecast skill decays to chance in 3–5 yr today [R memory] |
| G15 | Metastable metallic hydrogen | 0.05 [S] | 0 | A01 → 1,700 s chemical-class high thrust | "Metallic hydrogen is not metastable at zero pressure" | 2017 claim disputed [R memory] |
| G16 | Muon-catalysed fusion breakeven | 0.05 [S] | 0 | A11 +1 without big magnets | "α-sticking caps fusions per muon below breakeven" | ≈150 fusions/muon achieved, short of the ≈300+ needed [E memory] |

The p values for G01, G03, G04, G05 and the elevator gate come straight from the bible. Everything else is [S/D]. The UI should show gate status as "unknown", "proof of principle" or "no-go".

---

## 3. The 69-tech spine

The bible's 69 techs (§3.4) become the hand-written backbone. Each one has:
- **Inputs**: prerequisite techs (bible) plus **axis thresholds**, which the frontier must meet before the candidate enters the adjacent possible.
- **Outputs**: frontier floors (`A01 → 900`), increments (`A13 +0.3`) or unlocks.
- **Resources** (bible §7.1 R-ids).
- **K**: knowledge to invent, in KP; equal to the bible cost [D].
- **D**: effort to deploy, as a first-of-a-kind capital cost in cr. Per-settlement adoption cost is `D × (pop/1e6)^0.7 × (Q/Q0)^(−b)` (§6.5) [D/E].
- **catalog.ts**: the matching id. "≈" marks a partial match; "—" means missing.

Earliest-year floors stay as in the bible (`earliest − 0.25 × (earliest − 2040)`).

### 3.1 Near tier (31)

| id | Name | Inputs (prereqs; thresholds) | Outputs | Resources | K (KP) | D (cr) | catalog.ts |
|---|---|---|---|---|---|---|---|
| N01 | Industrial ISRU propellant | T05, T01; A23 ≥ 0.25 | Mars→Earth cost ×0.3; A23 +0.05; Mars state 3→4 | R01 water, R04 CO₂; ≈10 MWh per t methalox [E] | 3,000 | 5e9 | isru |
| N02 | ECLSS-90 | T02 | A13 → 2.0 | – | 2,500 | 5e8 | closedLoop |
| N03 | Bioregenerative life support | N02 | A14 → 40; food closure ≥ 0.5; A13 +0.2 | R07 phosphorus, R04 N | 6,000 | 1e9 | synthBio |
| N04 | Fission MWe reactors | T04; A21 ≥ 1,500 K | A03 → 20 (power plants); energy_cap ×10 | R08 U (HALEU); ≈180 kg nat-U per MWe·yr (LWR) [bible] | 5,000 | 2e9 | ≈kilopower |
| N05 | Regolith construction | T05 | A35 → 5e3; A34 → 50 | regolith | 4,000 | 5e8 | regolith |
| N06 | Nuclear thermal propulsion | T04; A21 ≥ 2,700 K | A01 → 900 | LH₂, R08 HALEU | 6,000 | 3e9 (DRACO cancelled 2025 *(fetched)*: no 2020s flight heritage) | ntp |
| N07 | In-space manufacturing I | T06, N05 | A23 → 0.5; manufactured imports ×0.6 | R05, R06 | 6,000 | 2e9 | ≈robotics |
| N08 | NEA prospecting | T01 | NEAs → SURVEYED; A37 +0.3 (u) | – | 2,500 | 5e8 | — |
| N09 | Asteroid mining I (C-type volatiles) | N08, N01; A23 ≥ 0.4 | LEO propellant ×0.5 | R01, R04 from C-types | 9,000 | 1e10 | asteroidMining |
| N10 | Lunar mass driver | N05, N04; A22 ≥ 5 T | lunar launch → 5 cr/kg; A05 (Moon) floor | R05/R06 Al, Cu; ≈1 GW·s per shot [E] | 12,000 | 2e10 | — |
| N11 | Space medicine | N02 | A19 → 1.5; low-g penalty ×0.5 | – | 8,000 | 1e9 | ≈radShield |
| N12 | Controlled-environment agriculture 95% | N03 | A14 → 25; food closure 0.95 | R07 P, Ga/In for LEDs | 10,000 | 3e9 | — |
| N13 | Nuclear electric propulsion, MW-class | N04 | A02 → 7,000; A03 → 30 (propulsion) | Xe/Ar, R08 | 9,000 | 5e9 | — |
| N14 | AGI | T06; A26 ≥ 1e12 | A27 → 3.0 | R15 compute ≈1e20 FLOP/s, R07 (Ga, Ge, REE) | 20,000 | 5e10 | agi |
| N15 | D-T fusion power plants | A22 ≥ 12 T; A11 ≥ 1.3 | A11 → 3.0 | Li-6 (tritium breeding), Be | 15,000 | 2e10 | fusion |
| N16 | Mature HTS magnets | – | A22 → 25; A34 −10% (u) via active shielding | R07 rare earths (Y/Gd/Eu), Ba, Cu | 10,000 | 5e9 | — |
| N17 | Compact fusion (D-D / D-He3) | N15, N16; A22 ≥ 25 | A11 → 4.0; A03 → 100 | R09 He-3 ≈54 kg per GW·yr thermal [bible]; R10 D | 35,000 | 3e10 | he3Fusion |
| N18 | Fusion drive (DFD) | N17, N06; A21 ≥ 3,000 K | A01 → 1e4 (DFD low end; 1e5 via generated techs); A03 → 1,000; A04 → 1e-3 | R09, R10 | 50,000 | 5e10 | fusionDrive |
| N19 | Space solar power and concentrators | T03 | A06 → 1e9; A09 +3 pts | Si, Ga/As | 7,000 | 2e10 | — |
| N20 | Orbital shipyards | N07, N09 | ship build cost ×0.5; max ship mass 1e7 kg | R05 | 15,000 | 3e10 | — |
| N21 | Small rotating habitats (≤ 10k) | N11, N20; A20 ≥ 1 | habitat class "Kalpana" (§8.2) | R05; shielding 4.5 t/m² | 25,000 | 5e10 | — |
| N22 | Germline gene editing | A16 ≥ 1.0 | A16 → 2.0; A19 ×1.4; divergence ×3 | – | 15,000 | 1e9 | bioAdapt |
| N23 | Medical torpor | N11 | A17 → 90 | – | 25,000 | 2e9 | ≈cryo |
| N24 | Paraterraforming | N05, N12; A20 ≥ 3 | K ×5 on rocky bodies; A34 → 10 | glass, R04 N₂ | 25,000 | 1e11 | paraterraform |
| N25 | Planetary defense | N08 | A37 → 1,000 | – | 5,000 | 5e9 | — |
| N26 | High-bandwidth BCI | N14; A30 ≥ 4.5 | A30 → 5.5; research_mult ×1.3 | – | 20,000 | 5e9 | neuralLace |
| N27 | Longevity I | N22 | A15 → 96 total LE (+30 healthy yr at 60+) | – | 30,000 | 1e10 | ≈genMed |
| N28 | Laser-sail probes (Starshot) | N19, N16 | A06 → 1e11; flyby probes ≤ 20 ly | sail material (A20 ≥ 3) | 30,000 | 1e10 (Starshot ≈5–10e9 [R memory]) | starshot |
| N29 | Artificial womb | N22; A18 ≥ 0.7 | A18 → 1.0 | – | 20,000 | 2e9 | — |
| N30 | Carbon nanomaterials at tonnage | N07; A25 ≤ 0.5 nm | A20 → 25 | carbon | 30,000 | 2e10 | carbonNano |
| N31 | Self-replicating factories I | N14, N07 | A23 → 0.9; A24 → 10 yr | ≈30 elements | 50,000 | 1e11 | ≈robotics |

### 3.2 Mid tier (30)

| id | Name | Inputs | Outputs | Resources | K | D | catalog.ts |
|---|---|---|---|---|---|---|---|
| M01 | O'Neill cylinder (Island Three) | N21, N31, (N10 or N09); A20 ≥ 2.5 | habitat class "Island Three" (§8.2) | ≈1e13 kg total (see the §8.2 note on bible mass) | 150,000 | 1e14 | orbitalHabitats |
| M02 | Low-g elevators and skyhooks | N30, N16; A20 ≥ 10 | Moon/Mars launch ×0.05 | carbon ≈1e7 kg | 80,000 | 5e11 | — |
| M03 | Earth space elevator | M02; **G05**; A20 ≥ 48 | A05 → 3 | carbon | 400,000 | 1e13 | spaceElevator |
| M04 | Venus aerostat cities | N12, N30 | Venus clouds H 0.35→0.55 | N₂/O₂ lift gas | 50,000 | 1e12 | cloudCities |
| M05 | Titan cryo-industry | N17; A21 low-T alloys (ignore) | Titan H +0.15 | hydrocarbons | 50,000 | 5e11 | — |
| M06 | Gas-giant atmospheric scooping | N17, N18 | R09 He-3 effectively unlimited | – | 90,000 | 1e12 | — |
| M07 | Asteroid mining II (metals, PGM) | N09, N20 | metal cap ×10 | R07 PGM | 60,000 | 5e11 | — |
| M08 | Mars terraforming I | N24, N04, N31 | A36 → 25 mbar/century | Al/Fe nanorods ≈1e10 kg total [E] | 150,000 | 1e13 | ≈magShield |
| M09 | Mars terraforming II | M08, (M06 or M10) | A36 → 100 mbar/century | ≈1e18 kg volatiles | 1,000,000 | 1e15 | terraform |
| M10 | Comet / KBO redirection | N18; A37 ≥ 3,000 m | volatile import; impact risk ×1.5 | – | 200,000 | 1e13 | — |
| M11 | Synthetic ecosystems | N22, N12 | A13 +0.5; food closure 0.99 | – | 80,000 | 1e11 | — |
| M12 | Closed loop 99.9% | M11 | A13 → 3.0 | – | 250,000 | 1e12 | — |
| M13 | ASI | N14, N26; A26 ≥ 1e15 | A27 → 5.0 | compute ≈1e24 FLOP/s | 300,000 | 1e13 | — |
| M14 | Self-replicating industry II | N31, M07 | A23 → 0.999; A24 → 2 yr | – | 300,000 | 1e13 | — |
| M15 | Dyson swarm phase 1 (1e16 W) | M14, N19 | A07 cap 1e16 | Mercury regolith | 400,000 | 1e15 | dyson1 |
| M16 | Dyson swarm phase 2 (1e20 W) | M15 | A07 cap 1e20 | – | 3,000,000 | 1e17 | dyson2 |
| M17 | Dyson swarm phase 3 (1e24 W) | M16 | A07 cap 1e24 | – | 30,000,000 | 1e19 | — |
| M18 | Dyson swarm complete | M17 | A07 cap 3.8e26 × coverage | ≈Mercury mass 3.3e23 kg | 200,000,000 | 1e21 | — |
| M19 | Industrial antimatter | M15, N16; **G07** decides the ceiling | A12 → 1e-4 (→ 1e-2 if G07 feasible) | – | 500,000 | 1e15 | antimatter |
| M20 | Fusion interstellar probe (Daedalus) | N18, M06 | robotic 0.12c flyby | R09 He-3 + D ≈5e7 kg [bible] | 300,000 | 1e14 | — |
| M21 | Orion nuclear pulse | N06 | heavy ships 0.003–0.03c | R08, ≈1e5 pulse units [E] | 100,000 | 1e13 | — |
| M22 | Generation ship | M01, M12, (M21 or N18) | interstellar colonisation | 1e9 kg | 1,000,000 | 1e15 | genShip |
| M23 | Embryo / seed ship | N29, (N14 or M13), M12 | interstellar colonisation at 1% of the mass | 1e6 kg | 600,000 | 1e13 | seedShips |
| M24 | Longevity II | N27, M13 | A15 → negligible senescence (0.001/yr) | – | 1,000,000 | 1e13 | lifeExt |
| M25 | Psychohistory | M13; A33 ≥ 10 yr | A33 → 30; COLL/WAR entry ×0.6 | – | 1,500,000 | 1e12 | psychohistory |
| M26 | Beamed crewed sails | N28, M16, N30 | A06 → 1.5e14; A04 → 0.1c | – | 5,000,000 | 1e17 | laserSail |
| M27 | Posthuman clades | N22, M11; A16 ≥ 3 | A16 → 4; clade creation | – | 1,500,000 | 1e12 | — |
| M28 | Venus terraforming | M15, M14 | Venus T 737 → 300 K over ≈300 yr | H import | 10,000,000 | 1e18 | — |
| M29 | Mars terraforming III | M09, M11 | H_Mars → 0.85 | – | 5,000,000 | 1e16 | — |
| M30 | Solar gravitational lens telescope | N18 | A32 → 1,000 | – | 150,000 | 1e13 | — |

### 3.3 Far tier (8)

| id | Name | Inputs | Outputs | Resources | K | D | catalog.ts |
|---|---|---|---|---|---|---|---|
| F01 | Antimatter beamed-core rocket | M19, M16 | A01 → 1e7 s; A04 → 0.3c | ≈5 t antimatter per 1e6 kg ship [E from bible 1e23 J] | 5e7 | 1e19 | — (catalog `antimatter` merges M19 and F01) |
| F02 | Mind uploading | M13, N26; **G03**; A31 ≥ 14, A26 ≥ 1e16 | people type "upload" | compute | 2e7 | 1e15 | mindUpload |
| F03 | Digital seed probe | F02, F04, (F01 or M26) | t_settle → 50–200 yr | 1–1,000 kg probes | 3e7 | 1e16 | ≈vonNeumann |
| F04 | Molecular nanotechnology | M14, M13; **G04**; A25 ≤ 0.15 | A25 → 0.07; A24 → 0.05 yr | – | 5e6 | 1e14 | nanofab |
| F05 | Matrioshka brain | M18, F02 | A27 → 6 | a star | 5e8 | 1e22 | matrioshka |
| F06 | Star lifting | M18 | metal feedstock ×100 | – | 2e8 | 1e21 | starLifting |
| F07 | Alcubierre warp | F01, F05; **G01** | FTL | – | 1e10 | ? | warp |
| F08 | Traversable wormholes | F07; **G02** | zero-lag links | – | 1e10 | ? | wormholes |

### 3.4 What catalog.ts is missing (and the reverse)

The task brief assumed 69 − 46 = 23 techs are missing. **The real count is 29**, because the mapping is not nested. Best one-to-one matching:
- **40** of the bible's techs have a catalog counterpart; 6 of those are only partial (≈).
- **29 bible techs are missing** from catalog.ts.
- **6 catalog techs have no bible entry.** 40 + 6 = 46.

Missing from catalog.ts (29):
- **Near (11):** N07 in-space manufacturing (robotics is only a loose match), N08 NEA prospecting, N10 lunar mass driver, N12 CEA 95%, N13 NEP, N16 HTS magnets, N19 space solar power, N20 orbital shipyards, N21 small rotating habitats, N25 planetary defense, N29 artificial womb.
- **Mid (17):** M02 low-g elevators, M05 Titan cryo-industry, M06 gas-giant scooping, M07 asteroid mining II, M10 comet redirection, M11 synthetic ecosystems, M12 closed loop 99.9%, M13 ASI, M14 self-replicating industry II, M17 Dyson phase 3, M18 Dyson complete, M20 Daedalus probe, M21 Orion, M27 posthuman clades, M28 Venus terraforming, M29 Mars terraforming III, M30 SGL telescope.
- **Far (1):** F01 antimatter rocket (folded into the catalog's `antimatter`).

Catalog-only techs (6). I recommend keeping them as extra spine rows X01–X06 [D], for a 75-row spine:

| New id | catalog id | Inputs | Outputs | K [D] | Note |
|---|---|---|---|---|---|
| X01 | quantumComp | T06; A26 ≥ 3e11 | research_mult ×1.25 in fields M and B (chemistry simulation) | 10,000 | Plausibly pre-known by 2040 (IBM-class roadmaps target ≈200 logical qubits ≈2029 [R memory]) |
| X02 | subIce | N16, N05; A34 ≤ 50 | settle_unlock[icy-moon ocean] | 60,000 | Europa / Enceladus |
| X03 | laserComms | N28, N17 | A29 → 1e12; secession ×0.7 | 90,000 | interstellar link |
| X04 | bishopRings | M01, N30, M15; A20 ≥ 15 | habitat class "Bishop ring" | 3e6 | §8.2 |
| X05 | bussard | M19, N18; **G10** | A04 → 0.1–0.2c, no fuel | 2e7 | [S] |
| X06 | reusable | – | bible T00, pre-known | 0 | delete as a researchable tech |

**Cost-scale warning.** catalog.ts costs are on an inconsistent scale relative to the bible:

| catalog id | catalog cost | bible cost | Ratio |
|---|---|---|---|
| isru | 90 | 3,000 (N01) | 1/33 |
| closedLoop | 135 | 2,500 (N02) | 1/18 |
| fusion | 9,000 | 15,000 (N15) | 1/1.7 |
| dyson1 | 840,000 | 400,000 (M15) | ×2.1 |
| warp | 8e9 | 1e10 (F07) | ×0.8 |

Adopt the bible K values and retune KP0, rather than mixing the two scales.

---

## 4. The combinatorial generator

### 4.1 Theory

- **Weitzman (1998, QJE 113:331), "Recombinant Growth"** [R memory]. New ideas are hybrids of old ones. Potential combinations grow faster than exponentially, so the binding constraint is the capacity to **process** (test and develop) ideas, not the supply of combinations. In the sim, the candidate pool can be huge, but realised inventions are limited by KP flow (§5).
- **Kauffman's adjacent possible** (*Investigations*, 2000) [R memory]. Only combinations of things that already exist are one step away. In the sim, a candidate exists only when both parents are known to the polity and the axis thresholds are met.
- **Arthur (2009), *The Nature of Technology*** [R memory]. Technologies are assemblies of earlier technologies, and many tests fail. In the sim, most combinations are incompatible, and compatible ones mostly yield small gains (heavy tail).

### 4.2 Compatibility rule

Each tech T has a **field** `f_T` (its dominant field) and a **signature** `σ_T`: the set of axes it outputs to, with magnitudes `Δu_T,a`. For a pair (A, B):

```
c_AB = W[f_A][f_B] × max_{a∈σ_A, b∈σ_B} C[a][b] × (1 − J(σ_A, σ_B))^0.5
J = |σ_A ∩ σ_B| / |σ_A ∪ σ_B|      (Jaccard overlap: punish redundant pairs)
Candidate exists iff c_AB ≥ c_min = 0.30   [D]
Target axis t = the coupling target of the argmax (a, b) pair
```

**Field matrix W** [D] (symmetric):

| | P | E | B | M | I | H |
|---|---|---|---|---|---|---|
| P | 0.6 | 0.9 | 0.2 | 0.9 | 0.5 | 0.4 |
| E | | 0.6 | 0.3 | 0.7 | 0.7 | 0.6 |
| B | | | 0.6 | 0.4 | 0.7 | 0.8 |
| M | | | | 0.6 | 0.6 | 0.9 |
| I | | | | | 0.6 | 0.5 |
| H | | | | | | 0.6 |

**Axis coupling list C** [D]. Symmetric in (a, b); unlisted pairs have C = 0. Weights: strong 1.0, medium 0.7, weak 0.4.

| # | a × b | → target | C | Mechanism |
|---|---|---|---|---|
| 1 | A20 strength × A01 Isp | A04 | 1.0 | lighter tanks → higher mass ratio |
| 2 | A20 × A22 field | A22 | 1.0 | coil bracing (B²/2μ₀ stress) |
| 3 | A20 × A35 hab cost | A35 | 1.0 | thinner hulls (hoop stress) |
| 4 | A20 × A06 beam | A06 | 0.7 | lighter mirrors and sails |
| 5 | A21 T_max × A01 | A01 | 1.0 | hotter chambers |
| 6 | A21 × A03 specific power | A03 | 1.0 | hotter radiators (T⁴) |
| 7 | A21 × A09 efficiency | A09 | 0.7 | thermophotovoltaics, higher Carnot Th |
| 8 | A22 × A34 dose | A34 | 1.0 | active magnetic shielding |
| 9 | A22 × A11 fusion | A11 | 1.0 | confinement scales ≈B⁴ |
| 10 | A22 × A05 launch | A05 | 0.7 | coilguns, mass drivers |
| 11 | A03 × A02 electric Isp | A02 | 1.0 | power-limited propulsion |
| 12 | A09 × A06 | A06 | 0.7 | efficient lasers |
| 13 | A10 storage × A03 | A03 | 0.7 | pulsed power |
| 14 | A11 × A01 | A01 | 1.0 | fusion exhaust |
| 15 | A12 antimatter × A01 | A01 | 1.0 | annihilation exhaust |
| 16 | A26 FLOP/J × A27 AI | A27 | 1.0 | compute → AI |
| 17 | A26 × A32 imaging | A32 | 0.7 | computational imaging |
| 18 | A26 × A33 forecast | A33 | 0.7 | simulation-based forecasting |
| 19 | A27 × A23 fab closure | A23 | 1.0 | AI-run fabs |
| 20 | A27 × A16 gene | A16 | 1.0 | AI genome and protein design |
| 21 | A27 × A15 lifespan | A15 | 0.7 | AI drug discovery |
| 22 | A30 BCI × A27 | A27 | 0.7 | human–AI teaming |
| 23 | A31 connectome × A30 | A30 | 0.7 | neural maps → better interfaces |
| 24 | A16 × A19 rad tolerance | A19 | 1.0 | engineered DNA repair |
| 25 | A16 × A14 growing area | A14 | 1.0 | engineered crops |
| 26 | A16 × A15 | A15 | 0.7 | gene therapy for ageing |
| 27 | A17 torpor × A13 closure | A13 | 0.4 | sleeping crews need less loop capacity |
| 28 | A13 × A14 | A13 | 0.7 | integrated bioregenerative loops |
| 29 | A23 × A27 | A24 (via A23) | 0.7 | replication speed |
| 30 | A25 precision × A26 | A26 | 1.0 | finer features → FLOP/J |
| 31 | A25 × A20 | A20 | 0.7 | defect-free fibres |
| 32 | A28 info × A29 link | A29 | 0.7 | compression, coding |
| 33 | A36 terraform × A16 | A36 | 0.7 | engineered pioneer biota |
| 34 | A37 deflection × A36 | A36 | 0.7 | comet redirection |
| 35 | A29 × A33 | A33 | 0.4 | more data → forecasting |
| 36 | A35 × A34 | A34 | 0.7 | cheap bulk mass for shielding |
| 37 | A18 ectogenesis × A16 | A16 | 0.4 | engineered gestation |
| 38 | A06 × A04 | A04 | 0.7 | beamed propulsion |

### 4.3 Knowledge to invent a generated tech

```
K_gen = κ_g × sqrt(K_A × K_B) × Dif_t(ℓ_t) / Dif_t(ℓ_t at the later parent's invention)
κ_g = 0.15 [D]
```

The ratio means combinations get harder as the target axis has moved on since the parents appeared. This is "ideas get harder to find" applied to combinations. The earliest year is `max(parent invention years) + 3` [D].

### 4.4 Effect size and damping (so effects don't explode)

```
Δu_t = η × ū_t × r × 0.7^(depth−1) × (1 − ℓ_t)^2
η    = 0.20                         [D]  gain relative to a typical spine step
ū_t  = median Δu of spine techs touching axis t   (computed at load)
r    ~ LogNormal(μ = −σ²/2, σ = 0.8), capped at 5     (mean 1; heavy tail)
depth = 1 + max(depth_A, depth_B); spine depth = 0; max depth 3 [D]
```

Five dampers act together [D]:
1. **Ceiling damping**: `(1 − ℓ)²` → 0 at the physical limit.
2. **Depth decay**: 0.7 per generation; combinations of combinations become refinements.
3. **Window budget**: Σ generated Δu on axis t within a sliding 50-yr window ≤ 0.5 × max spine Δu on t. Excess is wasted ("incremental novelty exhausted").
4. **Multiplier mapping**: axes feed the engine through bounded functions (§8.6), never as raw products of techs.
5. **No generated tech can pass a gate.** If a target axis is gate-capped, Δu is clipped at the no-gate ceiling.

The heavy tail of r (σ = 0.8: the top 10% of draws carry ≈35% of total effect) mirrors patent-value skew. Scherer and Harhoff find the top 10% of patents hold most of the value [R memory].

### 4.5 Candidate pool and graph size

Pool management [D]:
- A candidate's key is `hash(min(idA, idB), max(idA, idB))`.
- A **global registry** dedupes, so two polities inventing the same pair have made the same invention. That is a multiple (§5.4).
- Each polity keeps at most **256 active candidates**, by priority (§5.2). New candidates are created lazily when a parent becomes known.
- The global G-tech cap is **4,096**.

Expected sizes. These are [E] order-of-magnitude, with spine and generated sharing KP as in §5.2 (generated share 25%). **Calibrate with batch runs.**

| Year | Cumulative KP (bible App. A median) | Spine techs known (median polity) | Active candidates per polity | Generated techs invented (global unique) |
|---|---|---|---|---|
| 2100 | 2.5e5 | 18–25 | 60–120 | 25–50 |
| 2150 | 6.5e5 | 28–35 | 150–256 (capped) | 60–110 |
| 2200 | 1.2e6 | 35–42 | 256 | 90–160 |
| 2500 | 3e7 | 50–58 | 256 | 180–300 |
| 3000 | 6e8 | 58–64 | 256 | 280–450 |
| 5000 | 1e10 | 64–67 | 256 | 400–700 |
| 12,040 | ≈1e11–1e12 (extrapolated) | 65–69 | 256 | 600–2,000 (systems invent independently) |

Growth is roughly logarithmic in KP because K_gen rises with the parents' K and with axis difficulty. That curve is the emergent signature of "ideas get harder to find."

**Keep spine timing intact.** Diverting 25% of KP to generated techs would delay the spine. Raise bible KP0 from 2,000 to **2,650** (×1/0.75) [D] so that the Appendix A spine milestones still land.

### 4.6 Names and blurbs

Names come from a deterministic RNG (pair key + inventing settlement's culture seed). Templates pick slot words from field-specific lists.

**Name templates (36).** Examples are in parentheses.

1. `{Surname} {Device}` (Okafor Accumulator)
2. `{Surname}–{Surname} Cycle` (Lindqvist–Mbeki Cycle)
3. `{Material}-{Process} {Device}` (Boron-Lattice Fluxgate)
4. `{Adjective} {PhysicsNoun} {Device}` (Cold-Plasma Torch)
5. `{Place} Process` (Tharsis Process)
6. `{GreekLetter}-{Material} {Device}` (Sigma-Graphene Tether)
7. `{Number}-Stage {Device}` (Nine-Stage Sabatier Train)
8. `{Prefix}{Root} {Device}` (Magnetoplasma Nozzle)
9. `{Surname}'s {Effect} Engine` (Achterberg's Recoil Engine)
10. `{Material} {Organism}` (Basalt Cyanobiome)
11. `{Adjective} {Organ} Graft` (Lead-Tolerant Marrow Graft)
12. `{Place}-pattern {Habitat}` (Hellas-pattern Warren)
13. `{Acronym} {Device}` (HALO Reflector; acronyms built from the slot words)
14. `{Process}-grown {Material} {Structure}` (Vapor-grown Diamond Hawser)
15. `{Field} {Device} Mk {Roman}` (Torch Drive Mk IV)
16. `Self-{Verb}ing {Device}` (Self-Annealing Hull)
17. `{Adjective} {Device} Array` (Phased Mirror Array)
18. `{Surname} Bridge` (Ishikawa Bridge, for a link or comms tech)
19. `Distributed {Device} Mesh` (Distributed Radiator Mesh)
20. `{Temperature} {Material} {Device}` (Cryogenic Sapphire Oscillator)
21. `{Particle}-catalysed {Process}` (Muon-catalysed Burn)
22. `{Organism}-derived {Material}` (Tardigrade-derived Shield Gel)
23. `{Shape} {Device}` (Toroidal Sail)
24. `{Colour}-shift {Device}` (Blue-shift Lens)
25. `{Place} Accord Standard` (Ceres Accord Standard, for a social tech)
26. `{Adjective} {CognitiveNoun}` (Recursive Forecaster, Deep Consensus Engine)
27. `{Surname} Protocol` (Haldane Protocol)
28. `{Material} {Animal} Swarm` (Copper Locust Swarm)
29. `{Prefix}-{Device}` (Hyper-Sabatier Reactor)
30. `{Roman}-class {Device}` (VII-class Scoop)
31. `{Place} {Device} Yard` (Vesta Hull Yard)
32. `Neo-{Organ} Therapy` (Neo-Cochlear Therapy)
33. `{Field} Lattice` (Thermal Lattice)
34. `{Surname} Bloom` (Varga Bloom, for engineered biota)
35. `{Adjective} Archive` (Deep-Time Archive, an A28 tech)
36. `{Place} Gambit` (Callisto Gambit, a strategic or military tech)

**Slot vocabularies (excerpt; ≥20 entries per list in code)** [D]:

| Slot | Field P | Field E | Field B | Field M | Field I | Field H |
|---|---|---|---|---|---|---|
| Device | Thruster, Nozzle, Torch, Sail, Drive, Scoop | Reactor, Collector, Accumulator, Lens, Cell | Graft, Bloom, Vat, Loop, Serum | Hawser, Lattice, Foundry, Loom, Press | Forecaster, Mind, Archive, Relay, Array | Warren, Dome, Hull, Shield, Garden |
| Material | Boron, Tungsten, Graphene, Lithium | Helium-3, Perovskite, Hafnium | Chlorella, Basalt, Keratin | Diamond, Aerogel, Carbyne | Sapphire, Niobium, Glass | Regolith, Ice, Ferrite |
| Adjective | Cold-, Pulsed, Annular | Aneutronic, Coherent | Lead-Tolerant, Slow-Metabolic | Woven, Gradient | Recursive, Deep | Buried, Spun |

Surnames come from the inventing settlement's culture pool, drawn from its founding bloc (bible App. B2), and drift with cultural divergence (bible §7.9).

**Blurb templates (12)**:

1. "{ParentA} meets {ParentB}: {effect}."
2. "First built at {settlement} in {year} by {inventor}'s group; {effect}."
3. "{inventor} borrowed the trick from {ParentB} and applied it to {ParentA}. {effect}."
4. "A refinement nobody expected to matter: {effect}."
5. "{effect}. The {settlement} patent office logged rival claims within the year." (use when a multiple fires)
6. "What {ParentA} did for {axisA}, this does for {axisT}: {effect}."
7. "Born of necessity on {settlement}, where {needDriver}. {effect}."
8. "{effect}, at the cost of {sideEffect}."
9. "The {era} {inventorCulture} answer to {needDriver}: {effect}."
10. "Assembled from {ParentA} spares and {ParentB} theory. {effect}."
11. "{inventor} died before it worked. {effect}."
12. "Rediscovered at {settlement} after the {collapseName}; {effect}." (re-invention after loss)

`{effect}` is built from the target axis, for example "+18% specific strength" or "habitat dose −22%". `{needDriver}` comes from the need_score that drove allocation, for example "resupply ate a third of the budget".

---

## 5. Invention as a Poisson process caused by people

### 5.1 Knowledge production per settlement

This extends bible §3.1:

```
R_eff(s)   = Σ_c N_c(s) × research_share(s) × w_age(c) × skill(s) × burden(s) × ai_mult(s) × bci(s)
KP_rate(s) = KP0 × (R_eff(s)/R0)^λ × stability(s) × energy_ok(s) × fund(s) × conn(s)
KP0 = 2,650 KP/yr [D, §4.5]      R0 = 9.2e5 [bible]      λ = 0.75 [bible]
```

| Term | Formula | Value / source |
|---|---|---|
| N_c | population in age cohort c (bible 5 cohorts) | – |
| w_age | 20–29: 0.6 · 30–44: 1.0 · 45–59: 0.8 · 60+: 0.4 (0.7 with N27, 0.9 with M24) | [E] Jones 2010: great inventions peak in the late 30s, and the peak age rose ≈6 yr over the 20th century [R memory] |
| skill | edu index (bible 1.0–1.3) | bible |
| burden | `1 − T_train/T_career`; `T_train = 8 + 2·log10(K_frontier,f / 1e3)` yr; `T_career` = 35 yr (×1.6 with N27, ×3 with M24) | [D] after Jones 2009, "burden of knowledge" [R memory]. Longevity raises research |
| ai_mult | §8.6 table from A27 | bible values |
| bci | `1 + 0.3 × clamp((A30 − 4.5)/2.5, 0, 1)` | bible N26 ×1.3 |
| stability | bible regime factors (GOLD 1.3 … COLL 0.1, SING 3.0) | bible |
| fund | `clamp((spend_per_researcher / 2.3e5 cr)^0.25, 0.3, 2)` | 2.3e5 ≈ world GERD (≈2% of GDP [R memory]) / 1.5e7 researchers [bible] |
| conn | `clamp((1 + Σ_{j≠s} R_eff(j)·w_sj / R_eff(s))^0.1, 1, 2)`, `w_sj = open_sj / (1 + lag_sj / 0.1 yr)` | [D]. Mars (≤22 min) w ≈ 1; Saturn (≈1.3 h) ≈ 1; Proxima (4.2 yr) ≈ 0.023 |

Keep the bible pooling rule: lag < 1 h shares one KP budget. `conn` is the weaker, cross-cluster spillover.

### 5.2 From KP to invention events

**Allocation** (extends bible §3.1). Each polity spreads KP(p) over its candidates:

```
weight_j = need_j × (1/K_j)^0.3 × field_bias_f × (gate probe ? 0.5 : 1)
a_j      = weight_j / Σ weight                     (top 8 spine + top 8 generated + gate probes)
reserve  = 3% basic science (bible E20), 25% minimum to generated candidates  [D]
```

**Progress and hazard.** This is a Poisson clock gated by accumulated knowledge [D]:

```
P_j += a_j × KP(p) × dt
if P_j < 0.5 K_j:           h_j = 0                              (not ready: adjacent possible not yet reached)
if 0.5 K_j ≤ P_j < 1.5 K_j: h_j = a_j × KP(p) / K_j               (per year)
if P_j ≥ 1.5 K_j:           invent now                            (forced)
p_invent(dt) = 1 − exp(−h_j dt)       (bible §0.2)
```

So expected invention time is about K_j / (a·KP), bounded between 0.5 K and 1.5 K. Lucky runs come early and unlucky ones late. The bible's hard floor on earliest year still applies.

**Who invents it.** On an event, pick the settlement s with probability ∝ KP_rate(s) × field share, then a cohort ∝ N_c·w_age, then a person name from the culture pool. Record `{year, polity, settlement, inventor, techId, parents}`. The settlement gets prestige +1 (used by the migration pull, bible §7.3).

**Sanity check for 2040.** Earth's KP_rate(2040) = KP0 × 1 = 2,650 KP/yr; the US bloc and China each command about 30%. Near-tier K runs 2,500–50,000, and about 8 techs run in parallel. That gives ≈0.15–0.3 spine inventions per year on Earth, plus ≈0.3–0.6 small generated ones: one notable invention every 1–3 years. This matches the bible's calibration targets.

### 5.3 "Ideas get harder to find" (Bloom, Jones, Van Reenen & Webb 2020)

Figures from the paper *(fetched, NBER w23782, Table 6 and text)*:

| Scope | Period | Research productivity growth | Half-life | β |
|---|---|---|---|---|
| Aggregate US economy | 1930–2015 | −5.3%/yr | 13 yr | 3.4 |
| Moore's law | 1971–2014 | −6.8%/yr | 10 yr | 0.2 |
| Corn (v1 / v2) | 1969–2009 | −9.9% / −6.2% | 7 / 11 | 7.2 / 4.5 |
| Soybeans (v1 / v2) | 1969–2009 | −7.3% / −4.4% | 9 / 16 | 6.3 / 3.8 |
| Wheat (v1 / v2) | 1969–2009 | −6.1% / −3.3% | 11 / 21 | 6.8 / 3.7 |
| New molecular entities | 1970–2015 | −3.5% | 20 | – |
| Cancer, clinical trials | 1975–2006 | −5.7% | 12 | – |
| Heart disease, trials | 1968–2011 | −7.2% | 10 | – |
| Compustat firms (sales) | 3 decades | −11.1% | 6 | 1.1 |

Other text figures:
- Aggregate research effort rose ×23 since the 1930s (+4.3%/yr), while research productivity fell ×41 (−5.1%/yr in that passage).
- The number of researchers needed to double chip density rose ×18 since the early 1970s.
- "The economy has to double its research efforts every 13 years just to maintain the same overall rate of economic growth."

**Mapping to the sim.** Bloom's idea production function is `Ȧ/A = α A^(−β) S`. The bible uses `S^λ` with λ = 0.75. On a balanced growth path:

```
Bloom:  g_A = g_S / β          our model:  g_A = λ g_S / β'   ⇒  β' = λ β
Check: β_agg = 3.4 → β' = 0.75 × 3.4 = 2.55
       g_S = 4.3%/yr → g_A = 0.75 × 4.3 / 2.55 = 1.26%/yr   (TFP ≈ 1–1.5%/yr)  ✓
       Moore's law: β' = 0.75 × 0.2 = 0.15
```

This is the reason Dif_a(ℓ) uses `exp(β'_a u_a) = (v/v0)^β'`. Each e-fold of progress on an axis multiplies the cost of the next increment by e^β′. For computing (β′ = 0.15) the next e-fold costs only 16% more; for a medicine-like axis (β′ = 2.6) it costs ×13.

**Consequence.** Run-level growth is set by **researcher growth** (population × research share × AI). That is the semi-endogenous result Jones intended. A stagnant population stagnates technologically, and a boom (AGI's ai_mult, off-world population growth) is what sustains progress. The Tasmania rule (§6.6) is the same idea in reverse.

### 5.4 Multiples and priority disputes (Merton)

History:
- Ogburn & Thomas (1922) listed **148** independent multiple discoveries [R memory].
- Merton ("Singletons and Multiples", 1961) argued that multiples are the norm and singletons are the exception [R memory].
- Simonton (1979) analysed **≈579** multiples. Doublets dominate (≈2/3), triplets are ≈1/5, and higher-order multiples fall off geometrically, consistent with a Poisson model [E, memory, verify].
- **Priority disputes** in Merton's sample: ≈92% of 17th-century multiples were contested, ≈72% in the 18th century, ≈59% in the 19th, and ≈33% in the first half of the 20th *(memory, verify; my search could not confirm)*.
- Famous cases: calculus (Newton/Leibniz), natural selection (Darwin/Wallace), telephone (Bell/Gray, same day 1876), oxygen (Scheele/Priestley/Lavoisier) [R].

The sim model [D]:
1. **Emergent multiples.** When polity p invents j at time t, any polity q with `P_q,j ≥ 0.5 K_j` and no knowledge of p's result yet (blueprint not arrived, §6.1) keeps its own hazard. If q fires before p's blueprint arrives, that is a multiple. Expect P(multiple) ≈ 1 − exp(−Σ_q h_q × δ_pq), where δ_pq is the arrival delay. Multiples are common between Earth blocs (δ ≈ 2 yr) and between star systems (δ ≥ light-years).
2. **Explicit floor.** If the emergent rate in batch runs is below 10% of spine inventions, add a direct roll: `p_multi = 0.10` per invention, choosing a second inventor from polities with P ≥ 0.3 K [D].
3. **Disputes.** Given a multiple, `p_dispute = 0.33` [R-anchored on Merton's 20th-century rate] × 2 if the polities are rivals (tension > 0.5) × 0.5 within the same polity. A dispute raises tension +0.05 and costs both sides stability −0.01, emits the event "Priority dispute: {tech}" and assigns credit to the larger research community with probability 0.7 (the Matthew effect) [D].

---

## 6. Diffusion and adoption

### 6.1 Blueprint diffusion between polities

```
t_arrive(q) = t_invent + lag_ly(p, q) + T_assim + T_absorb
T_assim  ~ LogNormal(median = 2 yr near / 5 yr mid / 10 yr far, σ = 0.7)     [D]
T_absorb = 20 × max(0, 1 − edu_q/edu_p) + 10 × (1 − openness_q)               [D]
```

- Arrival requires a comm link (A29 > 0) or a ship arrival. Without comms, each ship arriving from a knowing polity carries each tech with probability 0.3 [D].
- **Absorptive capacity.** If q lacks the prerequisites, the tech is stored as a *blueprint*. It becomes buildable at **0.2 K** (bible copying rule) once the prerequisites are known.
- **Calibration.** Comin & Hobijn (2010) report that countries adopted technologies on average **45 years** after invention *(fetched abstract; an earlier draft gives 47 yr, SD 39)*. Lags shrank for newer technologies and depend on education and openness.
  - From memory and approximate: steam ships and railways ≈100+ yr; electricity and telephone ≈60 yr; cars ≈50 yr; PCs and cell phones ≈15 yr; internet ≈5–10 yr *(memory, verify)*.
  - The formula above gives Earth laggard-bloc lags of ≈5–20 yr for 2040-era techs, consistent with that trend [E].

### 6.2 War, embargo and capture

- **War between p and q** [D]: blueprint transfer ×0.1 (espionage leak hazard 0.05/yr per tech); copying cost ×3 (bible); trade-borne adoption is blocked.
- **Embargo without war**: transfer ×0.3; copying cost ×1.5.
- **Capture** (bible §7.7): the captor gains each of the loser settlement's techs with probability 0.5, at the deployed level.
- **Military research** under WAR gets ×1.5 (bible), applied to fields P and H and to weapon-tagged generated techs.

### 6.3 Adoption S-curves within a polity

Each settlement adopts known tech j along a logistic curve:

```
dx/dt = x(1 − x)/τ_j,     x(t_buildable + FOAK) = 0.01
τ_j = τ_class × (GDPpc_ref / GDPpc_s)^0.3 / stability_s × (1 + D_j / (0.05 × GDP_s × 10 yr))^0.5
deployed_a(s) = old_a + x × (frontier_a,j − old_a)        (in u-space)
FOAK delay = 1 + D_j / (0.02 × GDP_polity) yr, capped at 30 yr
```

Logistic arithmetic: 10%→50% takes 2.2τ; 10%→90% takes 4.4τ.

| τ_class | τ (yr) [E, from §6.4] | Examples |
|---|---|---|
| Granular digital | 1.5 | software, AI model upgrades, comms codecs |
| Consumer durable | 3 | TV, phone, devices |
| Equipment / vehicles | 5 | cars, robots, ECLSS units |
| Infrastructure | 8 | electrification, grids, ISRU plants |
| Energy systems | 12 | PV, fission, fusion fleets |
| Lumpy megaprojects | 20 | habitats, elevators, Dyson phases (adoption = build progress) |

Granular, small-unit technologies diffuse faster and learn faster than lumpy ones (Wilson et al. 2020, *Science*) [R memory]. So τ_class also sets the learning rate below.

### 6.4 Historical invention → adoption lags (US households unless noted)

Sources: Our World in Data "technology adoption by households in the US" (built from Comin & Hobijn 2004, the Census and Pew), plus Comin & Hobijn 2010. **All row values are from memory, not fetched, and rounded to ±2–3 yr: [E].**

| Technology | Invention / first commercial | US 10% | US 50% | Invention→10% (yr) | 10%→50% (yr) | Implied τ (yr) |
|---|---|---|---|---|---|---|
| Household electricity | 1882 (Pearl St.) | 1908 | 1925 | 26 | 17 | 7.7 |
| Landline telephone | 1876 | 1904 | 1946 | 28 | 42 (Depression dip) | 19 |
| Automobile | 1886 | 1915 | 1927 | 29 | 12 | 5.5 |
| Radio | 1906 (broadcast 1920) | 1924 | 1931 | 18 (4 from broadcast) | 7 | 3.2 |
| Refrigerator | 1913 | 1930 | 1940 | 17 | 10 | 4.5 |
| Washing machine | 1908 | 1925 | 1950 | 17 | 25 | 11 |
| Television | 1927 | 1950 | 1954 | 23 | 4 | 1.8 |
| Home air conditioning | 1914 | 1960 | 1975 | 46 | 15 | 6.8 |
| Colour TV | 1954 | 1966 | 1972 | 12 | 6 | 2.7 |
| Microwave oven | 1967 (countertop) | 1978 | 1986 | 11 | 8 | 3.6 |
| VCR | 1976 | 1985 | 1988 | 9 | 3 | 1.4 |
| Personal computer | 1977 | 1986 | 2000 | 9 | 14 | 6.4 |
| Cell phone | 1983 | 1994 | 2001 | 11 | 7 | 3.2 |
| Internet at home | 1991 (WWW) | 1996 | 2001 | 5 | 5 | 2.3 |
| Smartphone (adults) | 2007 | 2009 | 2012 | 2 | 3 | 1.4 |
| Social media (adults) | 2004 | 2006 | 2011 | 2 | 5 | 2.3 |
| EVs, share of global new car sales | 1991 (Li-ion) / 2008 (Roadster) | 2022 (≈14%) | ≈2032 [E] | 31 / 14 | ≈10 | ≈4.5 |
| Solar PV, share of world electricity | 1954 | ≈2032 [E] (≈5–7% in 2024) | – | ≈78 | – | ≈12 (energy class) |
| Nuclear fission, share of world electricity | 1954 (Obninsk) | ≈1983 | never (peak ≈17.5%, 1996) | 29 | ∞ | – |
| Jet airliners, share of US passenger-miles | 1952 (Comet) | ≈1960 | ≈1965 | 8 | 5 | 2.3 |

Patterns to reproduce [E]:
- invention → 10% has fallen from ≈25–45 yr (1880–1930 techs) to ≈2–10 yr (post-1990 digital);
- 10% → 50% ranges from 3 yr (digital) to 15–40 yr (infrastructure);
- some technologies plateau below 50% forever (fission). Model this with a per-tech `x_max` < 1 when a competing tech dominates [D].

### 6.5 Wright's-law learning on deployment

`cost(Q) = cost0 × (Q/Q0)^(−b)`, with `b = −log2(1 − LR)`. Q is cumulative deployed units in the polity, plus 0.5× the units of polities that share blueprints [D]. Wright's original paper (1936, aircraft labour hours) found LR ≈ 20% [R].

| Technology | Learning rate per doubling | Period | Source |
|---|---|---|---|
| Solar PV modules | 20–24% | 1976–2020 | Swanson; IRENA; Way et al. 2022 (Joule) [R memory] |
| Li-ion cells / packs | 18–24% (≈97% price fall 1991–2018) | 1991–2018 | Ziegler & Trancik 2021 [R memory] |
| Onshore wind | ≈10–12% | 1980–2020 | IRENA [R memory] |
| Aircraft (labour hours) | ≈20% | 1920s–30s | Wright 1936 [R] |
| Computing, cost per operation | ≈50%/yr *time-based* decline 1940s–2006; total ≈1e12× vs. manual computation | 1850–2006 | Nordhaus 2007, *J. Econ. Hist.* [R memory, approximate] |
| DRAM / transistors | ≈30–40% | 1970–2015 | Moore's law era [E memory] |
| Genome sequencing, cost per genome | ≈1e8 cr (2001) → ≈1e3 (2015) → ≈5e2 (2022); faster than Moore after 2007 | – | NHGRI [R memory] |
| LED lighting, cost per lumen | ×10 per decade (Haitz's law) | 1970–2015 | [R memory] |
| Nuclear fission (US/France) | **negative** (costs rose with build-out) | 1970–2000 | Grubler 2010 [R memory] |
| Launch to LEO | no clean Wright fit; ≈×20 drop Shuttle → Falcon 9 via reuse | 1981–2024 | bible §1.2 [R/E]; use LR 15% [E] |

Sim defaults [D]:

| Technology class | LR |
|---|---|
| Granular (PV, batteries, chips, small reactors, robots, ECLSS units) | 20% |
| Vehicles | 15% |
| Infrastructure | 10% |
| Lumpy megaprojects | 5% |
| Fission-like regulated tech | 0% (negative in STAG regimes) |

### 6.6 Loss in collapse (the Tasmania effect)

History [R memory]:
- **Tasmania (Henrich 2004, *Am. Antiquity* 69:197).** Bass Strait flooding (≈10–12 kya) cut off a population of ≈4,000. Over millennia they lost bone tools, fishing and cold-weather clothing.
- **Henrich's model.** Each learner copies the most skilled member of the population, imperfectly. Mean skill changes by Δz̄ = −α + β(ε + ln N). Complexity is maintained only if N > N* = exp(α/β − ε): skills that are harder to copy need larger connected populations.
- **Modern lost know-how.** Saturn V F-1 tooling (engineers reverse-engineered an F-1 in 2012–13) and the US "Fogbank" material (relearning took years).

Sim rule (replaces the bible's 2%/yr rule and keeps it as the COLL case) [D]:

```
practitioners_j(p) = Σ_s pop_s × field_share_s,f × x_j(s)     (only settlements within 1 yr lag pool)
N*_j = 300 × (K_j / 1e3)^0.5      → K = 3e3: 520 · K = 1e5: 3,000 · K = 1e7: 30,000 · K = 1e9: 3e5
h_loss = h0 × max(0, 1 − practitioners/N*_j)^2
h0 = 0.02 in COLL (bible), 0.005 if isolated (no comm link > 1 yr), else 0
```

Losing a tech:
- all of its outputs (and any techs that depend on it as a prerequisite) revert deployed axes to the pre-tech value;
- the event is "Knowledge lost: X at {polity}";
- re-acquisition costs 0.3 K (bible).

**Archives** cut re-acquisition to 0.1 K (the "Rediscovered" blurb) and halve h0. They require A28 ≥ 1e19 bits/kg plus a stable archive site, the generated-tech family `{Adjective} Archive` [D].

---

## 7. Calibration targets 2040–2150

Read these as "what a median batch run should show". The sim must reproduce the spread, not hit one year. Tags apply to the targets, which are [D] judgments informed by the cited sources.

| Milestone (precise definition) | P10 | P50 | P90 | Basis |
|---|---|---|---|---|
| **First commercial fusion**: ≥100 MWe net to a grid under a commercial PPA | 2048 | 2060 | 2090 | ITER: research operation 2034, D-T 2039 *(fetched)*. EU DEMO roadmap: electricity ≈2050s (EUROfusion 2018) [R memory]. UK STEP prototype ≈2040 [R memory]. DOE Milestone-Based Fusion Development Program (2023) targets pilot plants in the 2030s [R memory]. Private claims (CFS ARC early 2030s, Helion–Microsoft PPA 2028) [R memory] are discounted by fusion's record of slippage [E]. **Bible N15 earliest 2060 is too late for P10; set earliest 2050 (floor 2047).** |
| **AGI** (sim N14: human-level general AI *and* robotics, labor_prod ×3) | 2045 | 2056 | 2090 | Grace et al. 2024: HLMI 10% by 2027, 50% by 2047; full automation of all occupations 50% by 2116 *(fetched)*. The sim's AGI sits between those two definitions, so P50 is between 2047 and 2116, nearer the first. Scenario dial `ai_pace` (bible App. C). |
| **ECLSS ≥98% water + O₂ closure** in an operational habitat | 2042 | 2050 | 2068 | ISS reached 98% water recovery in 2023; O₂ ≈50% [R memory / bible]. Sabatier + Bosch O₂ loop closure is the remaining step [E] |
| **≥98% total consumables closure incl. food** (settlement scale) | 2070 | 2095 | 2150 | N12 earliest 2075; BVAD crop areas [E] |
| **First nuclear thermal stage fired in space** | 2042 | 2052 | 2075 | DRACO demonstration cancelled May 2025 (FY26 budget) *(fetched)*. NASA lunar fission surface power push (≈100 kWe, ≈2030 target) [R memory]. Sim starts with T04 known; N06 earliest 2050 (floor 2047.5). P10 assumes a non-US program (China/Russia nuclear tug studies) [E] |
| **First asteroid-mining profit year**: cumulative positive cash flow from space-sourced material, propellant included | 2058 | 2078 | 2130 | Planetary Resources and Deep Space Industries folded in 2018–19; AstroForge's 2025 mission failed [R memory]. Bible N09 earliest 2060; profit needs in-space buyers (N20 shipyards) [E] |
| **First small rotating habitat** (≥1,000 residents, ≥0.5 g) | 2085 | 2110 | 2170 | bible N21 earliest 2085 |
| **First O'Neill-class habitat** (≥1e5 residents, 1 g) | 2140 | 2180 | 2300 | bible App. A (unchanged) |
| **First interstellar probe launched** (≥0.05c, star target) | 2060 | 2080 | 2150 | bible App. A (Starshot-class). Breakthrough Starshot 2016 targets ≈20 yr to α Cen at 0.2c; launch dates are not committed [R] |
| *Precursor: 1,000 AU heliophysics probe launched* | 2038 | 2045 | 2070 | JHU-APL "Interstellar Probe" concept, launch ≈mid-2030s (study) [R memory] |
| *Launch cost to LEO ≤ 30 cr/kg* | 2050 | 2065 | 2100 | bible §1.2 model, τ = 25 yr [bible E] |
| *First ≥1 GW space solar power station* | 2060 | 2085 | 2140 | N19 earliest 2055 [bible]; ESA SOLARIS and JAXA studies [R memory] |
| *Kardashev 0.8 (1e14 W)* | 2090 | 2125 | 2170 | bible §3.5 |

Gate outcomes visible by 2150 [D]:
- G06 (RT superconductor) resolved in ≈40% of runs;
- G05 (CNT) resolved in ≈30%;
- G03 (uploads) resolved in ≈10%;
- no FTL gate resolved before 2400 in more than 1% of runs.

---

## 8. Feedback into objects

### 8.1 Ship classes from axis values

Formulas (all [R physics]):

```
Impulsive rocket:   Δv = v_e ln R,  v_e = Isp × g0 (g0 = 9.80665),  R = m0/mf
Payload fraction:   π = (e^(−Δv/v_e) − ε) / (1 − ε),   ε = structure/(structure + propellant)
Structure from strength [E]: ε = ε_ref × (2.0 / A20)^0.5,  ε_ref = 0.06 methalox, 0.10 LH2/NTR, 0.15 fusion
Power-limited (NEP, DFD; Stuhlinger):
   v_ch = sqrt(2 α t_b),  α = A03 (W/kg),  t_b = burn time
   π = e^(−x) − (v_e/v_ch)² (1 − e^(−x)),  x = Δv/v_e
   Optimum v_e ≈ 0.7 v_ch gives π ≈ 0.24 at Δv = 0.5 v_ch.  Max Δv ≈ 0.8 v_ch (π → 0)
Relativistic (Ackeret):  Δv = c × tanh((v_e/c) ln R)
Constant-acceleration trip (no coast):  t = 2 sqrt(d / a)
Laser sail (non-relativistic, perfect reflector):  F = 2P/c,  v = sqrt(4 P L / (m c)),
   L ≤ D_array D_sail / (2.44 λ)   (diffraction-limited acceleration distance)
```

| Class | Unlock (axes / techs) | Worked numbers | v_max |
|---|---|---|---|
| Chemical lander/tanker | 2040 | Isp 380, ε 0.06, Δv 9 km/s → R 11.2, π 3.1% | 15–20 km/s |
| NTR transport | N06; A01 ≥ 900 | ε 0.10, Δv 9 km/s → R 2.77, π 26% | 25 km/s |
| NEP cargo tug | N13; A02 ≥ 5,000, A03 ≥ 10 | α 10 W/kg, t_b 2 yr → v_ch 35.5 km/s → Δv 18 km/s at π 0.24. At α 30: v_ch 61 → Δv 31 | 50–100 km/s |
| DFD fast transport | N18; A03 ≥ 1,000 | α 1,000, t_b 0.25 yr → v_ch 126 km/s → Δv 63 km/s at π 0.24: Mars 30–60 d | ≈300 km/s (t_b 1 yr) |
| Fusion torch | generated, A03 ≥ 1e4, A01 ≥ 1e5 | α 1e4, t_b 1 yr → v_ch 795 km/s → Δv ≈400 km/s (1.3e-3 c) | 1e-3 c |
| Orion pulse | M21 | Isp 1e4–1e6; heavy 1e8–1e9 kg | 0.003–0.03c [bible] |
| Fusion generation ship | M22 + A01 ≥ 1e6 (v_e ≈ 0.033c) | R 4 per leg → Δv 0.046c (accelerate) → cruise ≈0.02c after a braking reserve | 0.005–0.02c |
| Daedalus probe | M20 | v_e 1e4 km/s, 2 stages, R ≈ 120 → ≈0.12c flyby [bible] | 0.12c |
| Starshot chip | N28; A06 ≥ 1e11 | P 1e11 W, D_array 1 km, sail 4 m, λ 1.06 µm → L 1.5e9 m; m 2 g → v ≈ 0.11c (≈0.15c at 1 g) | 0.1–0.2c |
| Beamed crewed sail | M26; A06 ≥ 1.5e14 | m 1e7 kg, v 0.1c: t = m v c / (2P) = 9.5 yr; E = 4.5e22 J [bible] | 0.1c |
| Antimatter beamed core | F01; A12 ≥ 1e-2 (G07) | v_e 0.3c, R 4 → Ackeret Δv = c·tanh(0.416) = 0.39c; split accel/decel → cruise ≈0.2–0.3c | 0.3c |
| Warp | F07 (G01) | – | config 10c [S] |

Thresholds to remember:
- Interstellar cruise at 0.01c with a **power-limited** drive needs v_ch ≈ 6,000 km/s, i.e. α·t_b ≈ 1.8e13 (α ≈ 1e5 W/kg for 5.7 yr).
- Below that, generation ships need high-thrust fusion (A01 ≥ 1e6) or Orion. Power-limited drives remain an in-system technology.
- The **crew acceleration cap** is 1 g sustained, 3 g peak [D]; ×10 with G08.

### 8.2 Habitat types from material strength

The rotating-shell hoop balance per unit area [R physics]:

```
σ_allow × t = (ρ_s t + q) × a × r + P × r
⇒ structural areal mass  m_s = ρ_s t = (q a r + P r) / (s_allow − a r),
   s_allow = A20 × 1e6 / SF  (J/kg),  SF = 2 [D]
Feasible iff s_allow > a r.   q = shielding + soil areal mass,  P = atmosphere pressure
```

| Habitat class | r | Spin g | Minimum A20 (SF 2, load q 4.5 t/m², 1 atm) | Structural areal mass at that A20 | Unlock |
|---|---|---|---|---|---|
| Kalpana One | 250 m | 1 g | ≈0.005 (any metal) | ≈0.3 t/m² (steel) | N21 |
| Stanford torus | 900 m | 1 g | ≈0.02 | ≈1.1 t/m² (steel) | N21 + generated |
| Island Three (O'Neill) | 4 km | 1 g | 0.08 strict; steel (0.25) works but is heavy; use ≥ 2.5 for sane mass | steel s_allow 1.25e5: **6.8 t/m²**. A20 = 2.5: 0.47 t/m². A20 = 25: 0.047 t/m² | M01 |
| McKendree cylinder | 460 km | 1 g | ≥ 9 strict (CNT) | at A20 25: ≈8.4 t/m² | generated (A20 ≥ 12) |
| Bishop ring (open top, walls hold air) | 1,000 km | 1 g | ≥ 20 strict | at A20 50: ≈9.5 t/m² (the 10.3 t/m² air column counts as load q) | X04 |
| Banks orbital | ≈1.5e6 km | 1 g | needs s ≈ 1.2e10 J/kg = 12,000 MN·m/kg | – | **impossible**: exceeds C–C bond limit ×100 [R physics] |
| Ringworld | 1 AU, v ≈ 1,250 km/s | 1 g | s ≈ 1.6e12 J/kg | – | **impossible** with baryonic matter [R physics]; never generate |

**Mass note (flag for the bible).** Using the hoop formula, Island Three (r = 4 km, L = 32 km, hull area 8.0e8 m²):

| Component | Mass |
|---|---|
| Shielding (4.5 t/m²) | 3.6e12 kg |
| Steel structure | 5.5e12 kg |
| CNT structure (alternative) | 4e10 kg |

So the total is ≈**1e13 kg** with steel, or ≈4e12 kg with CNT. Bible M01's "1e10–1e11 kg" matches only the CNT structure *without shielding*; it is probably tonnes mis-labelled as kg. I recommend changing M01 to 4e12–1e13 kg [E].

**Planet-bound habitat types by axis** [D]:

| Type | Unlock |
|---|---|
| Buried regolith warren | N05 |
| Lava-tube city | N05 + A35 ≤ 3e3 |
| Domed crater | N24 |
| Venus aerostat | M04 |
| Sub-ice ocean habitat | X02; A34 ≤ 50 |
| Titan cryo-dome | M05 |
| Free-floating torus | N21 |
| Cylinder | M01 |
| Swarm habitat | M15 + A24 ≤ 2 |

### 8.3 Megastructures

| Megastructure | Axis gate | Formula / numbers |
|---|---|---|
| Space elevator | A20 vs. ΔΦ | Taper ratio = exp(ΔΦ / s_allow). ΔΦ (surface → stationary orbit, rotating frame) = **48.5 MJ/kg Earth**, **9.5 MJ/kg Mars** [E, computed from GM, R and ω]. Earth with CNT 25 (SF 1.5 → 16.7): taper ≈ 18; with A20 = 48: ≈4.5. Mars with T1100 3.7 (SF 1.5 → 2.47): taper ≈ 47 (heavy but buildable); with CNT: 1.8. The Moon uses an L1 elevator, which Zylon-class materials can support [R memory]. |
| Dyson swarm | A24 (doubling), A23 | Build mass ≈ Mercury, 3.3e23 kg at ≈1 kg/m² over a 1 AU sphere (2.8e23 m²) [R physics; Armstrong & Sandberg 2013]. Doublings from a 1e9 kg seed: log2(3.3e14) ≈ 48 → T_build ≈ 48 × T_double. At 2 yr (M14) ≈ 100 yr; at 0.05 yr (MNT) ≈ 2.5 yr, limited in practice by energy and heat to ≈20–50 yr [E] |
| Matrioshka brain | A07 = L☉, A26 | Ops/s = 3.8e26 × A26. At practical 1e18 FLOP/J → 4e44 FLOP/s ≈ 4e26 uploads at 1e18 FLOP/s each [E]. Landauer at 300 K: 1.3e47 bit-ops/s [R] |
| Star lifting | F06 | Mass flux limited to ≈1e-3 of L☉/c² × efficiency [E]; feedstock ×100 [bible] |
| Planetary sunshade (Venus L1) | M28 | ≈1e14–1e15 kg of thin film at 1 g/m² for a 1.2e7 m radius disc [E] |
| Rigid Dyson shell | – | **Never.** Unstable and buckles; no material survives it [R physics] |

### 8.4 People types

| Type | Unlock | Numbers |
|---|---|---|
| Baseline human | 2040 | LE 76 [bible] |
| Edited (health) lineage | A16 ≥ 1 | mortality ×0.9; no divergence |
| Hardened lineage ("Spacer") | A16 ≥ 2 (N22) | A19 ×1.4; low-g bone loss ×0.5; divergence +0.02 per program [bible §7.9] |
| Adapted clade (low-g / cold / thin air) | A16 ≥ 3 (M27) | H ×1.5 in the target environment [bible]; reproductive isolation once divergence > 0.8 |
| Long-lived ("Elder") | A15 ≥ 96 (N27) / M24 | T_career ×1.6 / ×3 (§5.1); fertility ×0.9 / ×0.5 |
| Ectogenic cohort | A18 = 1 (N29) | births independent of gravity; enables embryo ships |
| Torpor traveller | A17 ≥ 90 d (N23) | in-transit consumables ×0.3 |
| Upload (digital person) | G03 feasible + F02; A31 ≥ 14 | Compute per upload C_up = 1e18 FLOP/s [E]; WBE roadmap range 1e18 (spiking net) to 1e25 (molecular) [R memory, Sandberg & Bostrom 2008]; ×1e6 if G03 is "costly". Power per upload = C_up / A26: 1 kW at 1e15 FLOP/J, 3 mW at Landauer (300 K). Subjective speed = allocated / C_up (1–1,000×) |
| AI citizen | A27 ≥ 3 + "personhood" event | count = 0.1 × compute_available / 1e17 FLOP/s [D]; votes and secession rights set by regime |
| Hive / merged | A30 ≥ 9 + A27 ≥ 5 [S] | clade flag; stability ×1.2, divergence ×5 [D] |

### 8.5 Weapons

All figures [R physics]; 1 Mt TNT = 4.184e15 J.

| Weapon | Unlock | Energy per unit |
|---|---|---|
| Kinetic orbital rod | 2040 | 1 t at 10 km/s = 5e10 J (12 t TNT) |
| Redirected asteroid (dual use of A37) | A37 ≥ diameter | 1 km stony (1.4e12 kg) at 20 km/s = 2.7e20 J ≈ 65,000 Mt |
| Laser (A06) | A06 | Spot radius at d = 1.22 λ d / D. At 1e14 W, D 1 km, λ 1 µm, 1 AU: 1.8e5 m spot → ≈1e3 W/m² (mild). At 0.01 AU: 1e7 W/m² (lethal to sensors and radiators) |
| Antimatter warhead | A12 | 1 g + 1 g matter = 1.8e14 J ≈ 43 kt |
| RKV | A04 + A06/F01 | E = (γ − 1) m c². 1 t at 0.1c = 4.5e17 J ≈ 108 Mt. At 0.5c = 1.4e19 J ≈ 3,300 Mt |
| Nicoll–Dyson beam | M18 + A06 | ≈1e26 W directed; "dark forest" scale [S] |

Military strength (bible §7.7) [D]: `tech_mult = 1 + 0.25 × max(0, log10(E_deliverable_per_yr / 1e17 J))`, where E_deliverable is the best weapon above × the number buildable from annual military capital. Planetary defense (A37) counts as deterrence and raises war-start tension thresholds by 0.1.

### 8.6 Axes → existing engine variables (bible §3.2 and catalog.ts `fx`)

| Engine variable (bible §3.2) | catalog fx key | Formula from deployed axes [D] |
|---|---|---|
| launch_cost_LEO | launch | = A05 (× Kessler and other multipliers) |
| transit_time_mult | voyage (inverse) | = t(best class)/t(2040 class) from §8.1, with d = route distance |
| payload_frac_mult | – | = π(best class) / π(chemical) |
| resupply_mass_mult | lifeSupport (inverse) | = (1 − f_A13)/(1 − 0.98) × food term (A14 closure) |
| ls_failure_hazard | reliability | × 0.8^(A13 − 1.7) |
| energy_cap_W | energy, fission, fusion | = A03 × installed plant mass; fusion allowed if A11 ≥ 2 |
| civ_energy_cap_W | dyson | = A07 cap (M15–M18) |
| habitat_cost_mult | habitat (inverse) | = A35 / 1e4 |
| shield_fraction, radiation_mortality_mult | habHostile, death | dose = A34; mortality term = dose(Sv) × 0.05 / A19 |
| research_mult | research | = ai_mult(A27) × bci(A30) |
| labor_prod_mult | productivity | = 1 + 2 × clamp(A27 − 2, 0, 1) + 0.5 × (A27 − 3)₊ |
| capital_growth_max | growth | = 0.69 / A24 ÷ 0.069 (normalised so A24 = 10 yr → 1) |
| mortality_mult | death | = (LE_2040 / A15)^3 |
| interstellar_v_max_c | shipSpeed | = A04 |
| t_settle_years | – | = 200 × (A24 / 10)^0.5, bounded 50–400 |
| impact_prob_mult | – | = 0.1 for objects ≤ A37, else 1 |
| K_mult | hab | from habitat class (§8.2) and A36 |
| interstellar FTL flags | ftl, ftl2 | G01/G02 feasible and F07/F08 known |

**ai_mult from A27** (piecewise-linear interpolation, matching the bible's ×3 / ×30 / ×1000):

| A27 | 1.5 | 2.0 | 3.0 (AGI) | 4.0 | 5.0 (ASI) | 6.0 (Matrioshka) |
|---|---|---|---|---|---|---|
| ai_mult | 1.0 | 1.2 | 3 | 10 | 30 | 1,000 |

---

## 9. Data schema and tick code (TypeScript-ish)

```ts
type Field = 'P' | 'E' | 'B' | 'M' | 'I' | 'H';
type AxisKind = 'log_up' | 'log_down' | 'nines' | 'linear' | 'ordinal';

interface Axis { id: string; name: string; field: Field; kind: AxisKind; unit: string;
  v2040: number; v2100: number; ceil: number; ceilGated?: { gate: string; ceil: number };
  betaP: number; derived?: boolean; lr?: number /* Wright learning rate if cost-type */ }

interface Gate { id: string; name: string; p: number; pCostly: number; costMult: number;
  conditional?: { on: string; pIfFeasible: number; pIfNoGo: number }; noGoName: string }

type Out = { axis: string; floor?: number; addU?: number } | { unlock: string };
interface SpineTech { id: string; name: string; field: Field; tier: 'N'|'M'|'F'|'X';
  req: string[]; reqAny?: string[][]; thresholds: { axis: string; op: '>='|'<='; v: number }[];
  gate?: string; out: Out[]; resources: Record<string, number>; K: number; D: number;
  earliest: number; tauClass: 'digital'|'durable'|'equipment'|'infra'|'energy'|'mega';
  catalogId?: string; blurb: string }

interface GenTech { id: string /* hash pair */; parents: [string, string]; depth: 1|2|3;
  field: Field; target: string; dU: number; K: number; name: string; blurb: string;
  firstBy?: { year: number; polity: string; settlement: string; inventor: string } }

interface PolityTech { known: Set<string>; blueprints: Set<string>; progress: Map<string, number>;
  frontier: Float64Array /* by axis index */; gateKnown: Map<string, 'feasible'|'costly'|'nogo'> }

interface SettlementTech { deployed: Float64Array; adoption: Map<string, number /* x */>;
  practitioners: Float32Array /* by field */ }

interface InventionEvent { year: number; techId: string; polity: string; settlement: string;
  inventor: string; kind: 'spine'|'generated'|'gate-probe'|'multiple'|'dispute'|'nogo'|'lost'|'rediscovered' }
```

Per-tick order (replaces bible §0.3 step 6):

```
for polity p:
  KP = Σ_cluster KP_rate(s)                         // §5.1
  refresh candidates: spine where req ⊆ known ∧ thresholds met ∧ year ≥ floor;
                      gen pairs on parent-known (lazy, cap 256)
  allocate (§5.2); progress += a·KP·dt
  for candidate j with P_j ≥ 0.5K: roll Poisson; on hit → invent(j, p)
invent(j, p): frontier update (§1, §4.4) → event → schedule blueprint arrivals (§6.1)
              → check rival hazards for multiples (§5.4)
for settlement s: adoption logistic (§6.3); deployed axes; Wright cost update (§6.5); loss roll (§6.6)
derive A04, A07, A08, A24; map to engine variables (§8.6)
```

**Performance** [E]: about 200 polities × 256 candidates × 1 Poisson roll per year ≈ 5e4 rolls/yr. Adoption runs over ≈1e3–1e5 settlements × ≈100 active techs. After 2300, use 5–10 yr ticks for settled S7/S8 systems (bible App. B); Poisson conversion is `1 − exp(−h dt)`.

**RNG streams** [D]:
- `hash(seed, 'gate', gateId)` for world-gen gates;
- `hash(seed, polityId, techId)` for invention rolls;
- `hash(seed, pairKey, cultureSeed)` for names.

Adding a polity then never reshuffles another polity's inventions, which supports the bible's "same seed, one parameter changed" comparisons.

---

## 10. Judgment calls and dials

| Call | Default | Why | Dial |
|---|---|---|---|
| Spine vs. emergence | 69 (+6) hand-written techs carry the calibrated milestones; generated techs add texture and ≈25% of KP | keeps Appendix A targets reachable while runs diverge | `gen_share` 0–0.5 |
| Ideas-harder exponent | β′ = λ·β_Bloom per field analogue (0.15 IT … 2.6 medicine) | Bloom Table 6 *(fetched)* | `beta_scale` ×0.5–×2 |
| Physics wall | (1 − ℓ)² in both cost and effect | ceilings must be asymptotic, never reached by luck | exponent 1–3 |
| Poisson window | invent between 0.5 K and 1.5 K | some luck without fusion-in-2041 | window width |
| Gate odds | bible p for warp, wormhole, uploads, MNT, elevator; new gates [S] | physics consensus says most exotic gates fail | `gate_optimism` ×0.1–×10 |
| Multiples | emergent, with a 10% floor; 33% disputed | Merton *(memory)* | `p_dispute` |
| Diffusion | light lag + LogNormal assimilation + absorptive gap; mean Earth laggard lag 5–20 yr | Comin & Hobijn 45-yr historical mean *(fetched)*, shrinking over time | `assim_scale` |
| Adoption | logistic τ by class (1.5–20 yr) | §6.4 table [E] | `tau_scale` |
| Learning | LR 20/15/10/5/0% by class | §6.5 [R memory] | `lr_scale` |
| Tasmania | N* = 300·(K/1e3)^0.5, h0 = 0.02 in collapse | Henrich 2004 *(memory)*; bible 2%/yr | `loss_scale` |
| KP0 | 2,000 → 2,650 | offsets the 25% generated share | – |
| Fusion date | P50 2060; move bible N15 earliest 2060 → 2050 | ITER 2039 D-T *(fetched)*, DEMO 2050s | `fusion_pace` |
| O'Neill mass | 4e12–1e13 kg, not 1e10–1e11 | hoop-stress arithmetic (§8.2) | – |
| catalog.ts scale | replace with bible K values | current costs are off by 1/33 to ×2 versus the bible | – |

## Appendix: sources

Fetched in this session:
- Bloom, N., Jones, C.I., Van Reenen, J., Webb, M. (2020). "Are Ideas Getting Harder to Find?" *AER* 110(4):1104–1144. NBER w23782, https://www.nber.org/papers/w23782 (Table 6 and text figures extracted).
- Comin, D., Hobijn, B. (2010). "An Exploration of Technology Diffusion." *AER* 100:2031–2059. Abstract figures (45 yr; 15 technologies; 166 countries) via https://research.vu.nl/en/publications/an-exploration-of-technology-diffusion/ and the NBER listing https://www.nber.org/papers/w12314. Note that w12314 (2006) is a different-sample precursor (19 technologies, 21 countries).
- ITER 2024 baseline: https://www.iter.org/sites/default/files/media/2024-07/baseline_press_conference_summary_july-2024_b.pdf ; https://physicsworld.com/a/iter-fusion-reactor-hit-by-massive-decade-long-delay-and-e5bn-price-hike/
- DRACO cancellation: https://breakingdefense.com/2025/06/darpas-draco-nuclear-propulsion-project-roars-no-more/ ; https://en.wikipedia.org/wiki/Demonstration_Rocket_for_Agile_Cislunar_Operations
- Grace, K. et al. (2024). "Thousands of AI Authors on the Future of AI." https://arxiv.org/abs/2401.02843 ; JAIR https://jair.org/index.php/jair/article/view/19087

From memory (verify before publishing numbers in the UI):
- Weitzman 1998 (QJE 113:331); Kauffman 2000 *Investigations*; Arthur 2009 *The Nature of Technology*; Jones 1995 (JPE 103:759); Jones 2009 (RES, burden of knowledge); Jones 2010 (age and great invention).
- Merton 1961 "Singletons and Multiples in Scientific Discovery"; Ogburn & Thomas 1922; Simonton 1979.
- Henrich 2004 (Am. Antiquity 69:197); Wright 1936 (J. Aeronautical Sciences 3:122); Nordhaus 2007 (J. Econ. Hist. 67:128); Ziegler & Trancik 2021 (Energy Environ. Sci.); Way, Ives, Mealy & Farmer 2022 (Joule); Wilson et al. 2020 (Science 368:36); Grubler 2010 (Energy Policy 38:5174).
- Comin & Hobijn 2004 (J. Monetary Econ., CHAT dataset); OWID technology-adoption chart.
- Lee et al. 2008 (Science 321:385, graphene strength); Zhu, Long & Ort 2008 (photosynthetic efficiency); Hann et al. 2022 (Nature Food, electro-agriculture); Erlich & Zielinski 2017 (Science, DNA Fountain); Azevedo et al. 2009 (neuron count); Sandberg & Bostrom 2008 (WBE roadmap); Turyshev & Toth 2020 (SGL imaging); Jakosky & Edwards 2018 (Nature Astronomy, Mars CO₂ inventory); Kite et al. 2024 (Sci. Adv., Mars nanorods); Rider 1995 (Phys. Plasmas, non-equilibrium fusion limits); Ford & Roman 1996 (quantum inequalities); Friedman, Schleich & Witt 1993 (topological censorship); Fishback 1969 (ramjet drag); Tajmar et al. 2021 (EmDrive null); Armstrong & Sandberg 2013 (Acta Astronautica 89:1); Tetlock & Gardner 2015 *Superforecasting*.
