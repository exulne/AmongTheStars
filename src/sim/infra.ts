// What a world has built, on the ground and in orbit, at a year. The engine
// tracks people, product, power, military and the technologies each place has
// heard of (diffusion.ts); this reads those and says what that civilisation
// would have standing: spaceports, power plants, arcologies, maglev lines,
// mass drivers and terraformers below; constellations, power satellites,
// shipyards, defence platforms, habitats, elevators and orbital rings above.
//
// It is derived, not simulated: nothing here feeds back into the engine, so
// futures (and the war minds trained on them) are unchanged. Every view reads
// the same answer, so the planet, its orbit and its streets agree. Counts are
// for drawing, bounded, and grow smoothly with the world; each kind appears only
// once its technology has reached this world at light speed.

import { STAGE, TECHS, isAlive } from './catalog.ts';
import { techAt } from './diffusion.ts';
import { F, NF } from './metrics.ts';
import type { World } from './world.ts';

const TI = new Map(TECHS.map((t, i) => [t.id, i]));

/** The engine state this reads (a StateMsg carries all of it). */
export interface InfraState { S: Float64Array; techDone: Float64Array; techWhere: Float64Array }

/** Technological age of a world: what its people can build. */
export const TIERS = ['Frontier', 'Industrial space', 'Fusion age', 'Nanotech age', 'Stellar engineering', 'Post-stellar', 'Faster than light'] as const;

export interface Infra {
  tier: number;              // index into TIERS
  tierName: string;
  /** 0..1 within the tier, for smooth visual growth */
  progress: number;
  has: (id: string) => boolean;
  surface: {
    spaceports: number;      // launch complexes (pads, towers)
    massDrivers: number;     // electromagnetic launch tracks (regolith + fusion)
    fission: number;         // fission plants (kilopower onward)
    fusion: number;          // fusion plants
    solarFarms: number;      // ground solar / beamed-power rectennas
    arcologies: number;      // super-tall structures (carbon nanomaterials)
    maglev: number;          // 0..1 how far the city network is linked by fast transit (vacuum trains with fusion)
    vacTrain: boolean;
    farms: number;           // vertical / synthetic-biology farms
    compute: number;         // AI and data cores (AGI onward; brain-scale at Matrioshka)
    domes: number;           // pressurised domes on a hostile world
    terraformers: number;    // atmosphere processors while terraforming runs
    shields: number;         // planetary defence emplacements
  };
  orbit: {
    comms: number;           // communication and navigation satellites (laser-linked with laserComms)
    laserLinks: boolean;
    observation: number;     // science and survey satellites
    power: number;           // space solar power satellites, beaming down
    miners: number;          // asteroid tugs and smelters
    shipyards: number;       // orbital yards with hulls on the slips
    defence: number;         // weapon and interceptor platforms
    stations: number;        // crewed stations (Outpost onward)
    habitats: number;        // O'Neill cylinders
    rings: number;           // Bishop rings
    elevators: number;       // space elevator tethers (1..3)
    orbitalRing: boolean;    // a full ring around the equator (nanofab, carbon nanomaterials, Megastructure)
    swarm: number;           // 0..1 share of the star's light a Dyson swarm takes (shown from the planet as a glittering band)
  };
}

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lg = (x: number) => Math.log10(1 + Math.max(0, x));

/** What body b has built at `year`. */
export function infraOf(world: World, st: InfraState, b: number, year: number): Infra {
  const o = b * NF, S = st.S;
  const stage = S[o + F.stage], pop = S[o + F.pop], alive = isAlive(stage);
  const has = (id: string) => { const i = TI.get(id); return i !== undefined && techAt(world, st.techDone, st.techWhere, i, b, year); };
  const tierOf = (): [number, number] => {
    const steps: [number, string[]][] = [
      [6, ['warp']], [5, ['matrioshka', 'starLifting']], [4, ['dyson1', 'mindUpload', 'bishopRings']],
      [3, ['nanofab', 'spaceElevator', 'carbonNano']], [2, ['fusion']], [1, ['reusable', 'kilopower']],
    ];
    for (const [t, ids] of steps) {
      const n = ids.filter(has).length;
      if (n) {
        // progress toward the next tier: how much of it has arrived
        const next = steps.find(([u]) => u === t + 1);
        const p = next ? next[1].filter(has).length / next[1].length : 1;
        return [t, clamp(p * 0.5 + (n / ids.length) * 0.5)];
      }
    }
    return [0, 0];
  };
  const [tier, progress] = tierOf();
  const lp = lg(pop), lgdp = lg(S[o + F.gdp]), size = clamp((lp - 3) / 7); // 0 at a thousand people, 1 at ten billion
  const hostile = world.bodies[b].hab < 0.3;
  const terraforming = S[o + F.terraform] > 0 && S[o + F.terraform] < 1;
  const mil = lg(S[o + F.military]);
  // each age raises what a world of a given size builds, so the skyline keeps growing long after the tree is done
  const reach = 0.45 + 0.13 * (tier + progress);
  const n = (x: number, max: number) => Math.round(clamp(x) * max * reach);
  const fusion = has('fusion');

  const surface: Infra['surface'] = {
    spaceports: alive ? Math.max(1, n(size * (has('reusable') ? 1 : 0.5) + (stage >= STAGE.HUB ? 0.2 : 0), 8)) : 0,
    massDrivers: alive && has('regolith') && fusion && stage >= STAGE.TOWN ? 1 + n(size - 0.4, 3) : 0,
    fission: alive && has('kilopower') && !fusion ? Math.max(1, n(size, 6)) : alive && has('kilopower') ? n(size * 0.3, 2) : 0,
    fusion: alive && fusion ? Math.max(1, n(size * (has('he3Fusion') ? 1 : 0.7), 10)) : 0,
    solarFarms: alive ? n(size * (hostile ? 0.4 : 0.7) + (has('dyson1') ? 0.3 : 0), 8) : 0,
    arcologies: alive && has('carbonNano') && stage >= STAGE.CITY ? n(size * (has('nanofab') ? 1 : 0.6) + 0.1, 24) : 0,
    maglev: alive && stage >= STAGE.TOWN ? clamp((stage - 3) / 4 + (fusion ? 0.2 : 0)) : 0,
    vacTrain: alive && fusion && stage >= STAGE.CITY,
    farms: alive && has('synthBio') && stage >= STAGE.COLONY ? n(size, 10) : 0,
    compute: alive && has('agi') ? n(size * 0.6 + (has('mindUpload') ? 0.3 : 0) + (has('matrioshka') ? 0.4 : 0), 12) : 0,
    domes: alive && hostile && !(S[o + F.terraform] >= 1) ? Math.max(1, n(size, 14)) : 0,
    terraformers: alive && terraforming && has('paraterraform') ? 2 + n(size, 8) : 0,
    shields: alive && mil > 6 ? n((mil - 6) / 8 * (has('fusionDrive') ? 1 : 0.5), 6) : 0,
  };
  const orbit: Infra['orbit'] = {
    comms: alive || stage === STAGE.SURVEY ? 6 + n(size * (has('reusable') ? 1 : 0.4) + (has('laserComms') ? 0.3 : 0), 600) : 0,
    laserLinks: has('laserComms'),
    observation: stage >= STAGE.SURVEY ? 2 + n(lgdp / 20, 40) : 0,
    power: alive && has('robotics') && stage >= STAGE.CITY ? n(size * (fusion ? 0.6 : 1) + (has('dyson1') ? 0.4 : 0), 40) : 0,
    miners: alive && has('asteroidMining') ? 2 + n(size, 30) : 0,
    shipyards: alive && has('asteroidMining') && has('orbitalHabitats') && stage >= STAGE.CITY ? 1 + n(size * (stage >= STAGE.HUB ? 1 : 0.4), 5) : 0,
    defence: alive && mil > 6 ? n((mil - 6) / 8 * (has('fusionDrive') ? 1.2 : 0.4), 24) : 0,
    stations: alive ? 1 + n(size, 8) : 0,
    habitats: alive && has('orbitalHabitats') ? 1 + n(size * (stage >= STAGE.HUB ? 1 : 0.4), 12) : 0,
    rings: alive && has('bishopRings') && stage >= STAGE.MEGA ? 1 + n(size, 5) : 0,
    elevators: alive && has('spaceElevator') && stage >= STAGE.COLONY ? (stage >= STAGE.HUB ? 3 : 1) : 0,
    orbitalRing: alive && has('nanofab') && has('carbonNano') && stage >= STAGE.MEGA,
    swarm: has('dyson2') ? 0.8 : has('dyson1') ? 0.35 : 0,
  };
  return { tier, tierName: TIERS[tier], progress, has, surface, orbit };
}
