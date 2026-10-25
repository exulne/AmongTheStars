// Explain cards for what the living worlds draw on their surfaces: polar caps,
// craters and lava, storms, Titan's lakes, Enceladus's plumes, Io's hot spots,
// aurorae, and Halley's comet in the system view.

import * as THREE from 'three';
import { MARS, grsEnd, halleyReturns, marsLs } from '../sim/geo.ts';
import { marsSeason, worldNow } from '../sim/geoView.ts';
import type { Feature } from '../view/geoLook.ts';
import { addCpuSet, nearestPoint } from './picker.ts';
import { registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';

const yr = (y: number) => String(Math.round(2040 + y));
const f = (k: string, v: string, t: Fact['t']): Fact => ({ k, v, t });

/** Register the surface features of the world in the planet view: `at(i, out)` gives each one's position in world space (null when facing away). */
export function explainFeatures(kind: string, obj: THREE.Object3D, list: () => Feature[], body: () => number, at: (i: number, out: THREE.Vector3) => THREE.Vector3 | null): void {
  registerExplainer(kind, {
    obj,
    explain: (i, c) => featureCard(list()[i], body(), c),
    name: (i, c) => featureCard(list()[i], body(), c).title,
    locate: (i, out) => at(i, out),
    selectAs: () => null,
  });
  addCpuSet({ kind, obj, prio: 1, hit: (p) => nearestPoint(list().length, at, p, () => 16) });
}

export function featureCard(ft: Feature | undefined, b: number, c: ExCtx): Explanation {
  const w = c.world, body = w.bodies[b], now = worldNow(w, c.snap, b, c.year), Y = 2040 + c.year;
  const links = [{ label: body.name, act: 'body' as const, id: b }];
  if (!ft) return { eyebrow: 'Surface', title: body.name, lede: 'Nothing is drawn here now.', facts: [f('World', body.name, 'R')], links };
  switch (ft.kind) {
    case 'cap': {
      const cap = ft.north ? now.capN : now.capS, side = ft.north ? 'northern' : 'southern';
      if (b === w.mars) return {
        eyebrow: `Polar cap of Mars`, title: `The ${side} cap`,
        lede: `Water ice under a seasonal coat of frozen carbon dioxide: the frost spreads over each winter pole and sublimes in spring, while the permanent cap stays.`,
        facts: [f('Reaches', `${Math.round(90 - cap)}° ${ft.north ? 'N' : 'S'}`, 'E'), f('Season', marsSeason(now.ls), 'R'), f('Mars Year', String(now.marsYear), 'R'),
          f('Permanent cap', ft.north ? 'water ice, ~1,000 km across, up to 3 km thick' : 'CO₂ ice over water ice, ~400 km across', 'R'), f('Year', `${MARS.P.toFixed(2)} Earth years (687 days)`, 'R'),
          ...(now.terra > 0 ? [f('Terraforming', `${Math.round(now.terra * 100)}%: the caps melt into the new seas`, 'P')] : [])],
        why: 'The caps hold most of the water on Mars that is not underground: the first settlers mine them, and terraformers melt them.', links,
      };
      return {
        eyebrow: `Polar ice of ${body.name}`, title: `The ${side} ice`,
        lede: b === w.earth ? (ft.north ? 'Arctic sea ice and the Greenland ice sheet.' : 'The Antarctic ice sheet and the sea ice around it.') : `Ice around the ${side} pole of ${body.name}.`,
        facts: [f('Reaches', `${Math.round(90 - cap)}° ${ft.north ? 'N' : 'S'}`, b === w.earth ? 'E' : 'P'), f('Ice cover, whole world', `${(now.ice * 100).toFixed(1)}%`, b === w.earth ? 'E' : 'P'),
          ...(b === w.earth ? [f('Sea level', `${now.sea >= 0 ? '+' : '−'}${Math.abs(now.sea).toFixed(2)} m against 2040`, 'E'), f('If it all melted', ft.north ? 'Greenland alone: 7.2 m of sea level' : 'Antarctica: 58 m of sea level', 'R')] : [])],
        why: b === w.earth ? 'Ice sheets answer warming over millennia: the seas keep rising long after the warming stops (Levermann et al. 2013).' : undefined, links,
      };
    }
    case 'scar': {
      const s = now.scars[ft.i];
      if (!s) return { eyebrow: 'Surface', title: body.name, lede: 'The mark has faded.', facts: [f('World', body.name, 'R')], links };
      const age = c.year - s.year, km = s.rad * body.radius;
      const when = age < 1 ? `${Math.max(1, Math.round(age * 12))} months ago` : `${Math.round(age)} years ago (${yr(s.year)})`;
      if (s.kind === 2) return {
        eyebrow: 'Impact scar on Jupiter', title: 'A dark impact scar',
        lede: 'Debris from an impact, dark against the clouds, spreading and fading on the winds over weeks to months.',
        facts: [f('Struck', when, 'P'), f('Size', `${Math.round(km / 1000) * 1000} km across`, 'P'), f('Fades', `${Math.round(s.amp * 100)}% still visible`, 'P'), f('Rate', 'a scar like this every ~15 years; the 1994 Shoemaker–Levy 9 kind every ~500', 'E')],
        why: 'Jupiter sweeps up comets that would otherwise wander inward: every scar is one that did not reach the inner worlds.', links,
      };
      if (s.kind === 1) return {
        eyebrow: `Lava on ${body.name}`, title: s.what[0].toUpperCase() + s.what.slice(1),
        lede: body.name === 'Io' ? 'Fresh lava from one of Io’s hundreds of volcanoes, heated by Jupiter’s tides; it cools from glowing to black in years.' : s.what === 'supervolcano caldera' ? 'The collapsed caldera and ash field of a supereruption.' : 'A fresh lava flow, cooling and darkening.',
        facts: [f('Erupted', when, 'P'), f('Drawn', `${Math.round(km)} km across (larger than life where small)`, 'P'), f('Still fresh', `${Math.round(s.amp * 100)}%`, 'P')],
        why: s.what === 'supervolcano caldera' ? 'A supereruption darkens the sky for years: harvests fail wherever crops grow under the open sky.' : undefined, links,
      };
      return {
        eyebrow: `Impact crater on ${body.name}`, title: 'A fresh crater',
        lede: 'Where an asteroid struck: a dark floor, a raised bright rim and rays of thrown-out rock. On airless worlds it stays sharp for millions of years; on worlds with weather it softens.',
        facts: [f('Formed', when, 'P'), f('Drawn', `${Math.round(km)} km across (craters are drawn larger than life)`, 'P'), f('Still sharp', `${Math.round(s.amp * 100)}%`, 'P'), f('Impacts here so far', String(now.impacts), 'P')],
        why: 'Planetary defence (asteroid mining and nuclear propulsion) can push most big rocks aside, but only where someone is watching.', links,
      };
    }
    case 'spot': {
      const end = grsEnd(c.snap?.geo?.seed ?? 1);
      return {
        eyebrow: 'Storm on Jupiter', title: 'The Great Red Spot',
        lede: 'An anticyclone wider than Earth, watched since at least 1831. It has been shrinking for a century and a half.',
        facts: [f('Width now', `${Math.round(now.grs / 100) * 100} km`, c.year < 1 ? 'E' : 'P'), f('In 1879', '~39,000 km', 'R'), f('In 2017', '~16,350 km', 'R'), f('Winds', 'up to ~640 km/h at its edge', 'R'),
          f('In this future', end ? `it breaks up in ${Math.round(end)}` : 'it settles at a smaller size and lasts', 'P')],
        why: 'Nobody knows for certain whether it will last; each future of this simulation decides.', links,
      };
    }
    case 'whitespot': return {
      eyebrow: 'Storm on Saturn', title: 'A Great White Spot',
      lede: 'A planet-girdling thunderstorm that erupts about once a Saturn year, near northern summer, and smears along its band within weeks.',
      facts: [f('Latitude', `${Math.round(now.gwsLat)}° N`, 'P'), f('Strength', `${Math.round(now.gws * 100)}%`, 'P'), f('Seen in', '1876, 1903, 1933, 1960, 1990, 2010', 'R')],
      links,
    };
    case 'storm': return b === w.mars ? {
      eyebrow: 'Weather on Mars', title: 'A global dust storm',
      lede: 'A dust storm that has grown to wrap the planet, as in 2001, 2007 and 2018. It always starts in the perihelion season, between Ls 180° and 310°.',
      facts: [f('Dust optical depth', now.dust.toFixed(1), 'P'), f('Season', marsSeason(marsLs(Y)), 'R'), f('How often', 'about one Mars year in three to five', 'R'), f('Sunlight at the ground', `${Math.round(Math.exp(-now.dust) * 100)}%`, 'E')],
      why: 'It killed the Opportunity rover in 2018. Settlements that run on sunlight ration power for months; fission keeps the lights on.', links,
    } : {
      eyebrow: `Weather on ${body.name}`, title: 'A global dust storm', lede: 'Dust lifted by the winds until it hides the whole surface.',
      facts: [f('Dust optical depth', now.dust.toFixed(1), 'P'), f('How often', 'about once every six years (scaled from Mars)', 'E')], links,
    };
    case 'lakes': return {
      eyebrow: 'Seas of Titan', title: 'Methane seas',
      lede: 'Liquid methane and ethane fill seas near Titan’s poles, most in the north: Kraken Mare is bigger than the Caspian Sea. Rain follows the Sun over Titan’s 29.5-year seasons.',
      facts: [f('Kraken Mare', '~400,000 km²', 'R'), f('Ligeia Mare depth', 'up to ~160 m', 'R'), f('Surface', '94 K, 1.5 bar', 'R'), f('Season now', now.season > 0.5 ? 'northern summer' : now.season < -0.5 ? 'southern summer' : 'near equinox', 'R')],
      why: 'Hydrocarbon seas are fuel and feedstock for a whole industrial system, if there is oxygen to burn them with.', links,
    };
    case 'plume': return {
      eyebrow: 'Geysers of Enceladus', title: 'The tiger-stripe plumes',
      lede: 'Water from an ocean under the ice jets out of four warm fractures at the south pole, feeding Saturn’s E ring.',
      facts: [f('Output', '~200 kg of water a second', 'R'), f('Surges', 'every few years, with Saturn’s tides (in this future, about every five)', 'E'), f('Discovered', 'Cassini, 2005', 'R')],
      why: 'Free water from the sky: a small colony here gains tonnes in every surge.', links,
    };
    case 'hotspot': return {
      eyebrow: 'Volcano on Io', title: 'Loki Patera',
      lede: 'A lava lake 200 km across, the most powerful volcano in the Solar System, brightening every year or two as its crust founders.',
      facts: [f('Io’s heat flow', '~100 TW, from Jupiter’s tides', 'R'), f('Active volcanoes', 'over 400', 'R'), f('Recent outburst', now.outburst > 0.05 ? `glowing (${Math.round(now.outburst * 100)}%)` : 'quiet', 'P')],
      why: 'No world in the Solar System is harder to live on: radiation, sulfur, and a surface that renews itself every century.', links,
    };
    case 'aurora': return {
      eyebrow: `Sky of ${body.name}`, title: 'Aurora',
      lede: `Particles from the star, steered by ${body.name}'s magnetic field into ovals around its poles, make the upper air glow.`,
      facts: [f('Strength now', `${Math.round(now.aurora * 100)}%`, 'P'), f('Solar cycle', '11 years (Cycle 25 peaked about 2024–25)', 'R'), f('Magnetic field', `${now.field >= 2 ? Math.round(now.field).toLocaleString('en-US') : now.field.toPrecision(2)}× Earth's`, 'R')],
      links,
    };
  }
}

/** Halley's comet in the Sun's system view. */
export function explainComet(kind: string, obj: THREE.Object3D, locate: (out: THREE.Vector3) => THREE.Vector3 | null, au: () => number): void {
  registerExplainer(kind, {
    obj,
    explain: (_i, c) => cometCard(c, au()),
    name: () => "Halley's comet",
    locate: (_i, out) => locate(out),
  });
  addCpuSet({ kind, obj, prio: 2, hit: (p) => nearestPoint(1, (_i, out) => locate(out), p, () => 14) });
}

function cometCard(c: ExCtx, r: number): Explanation {
  const ret = halleyReturns(c.snap?.geo?.seed ?? 1), Y = 2040 + c.year;
  const next = ret.find((x) => x.t >= Y), last = [...ret].reverse().find((x) => x.t < Y);
  return {
    eyebrow: 'Comet', title: "Halley's comet",
    lede: 'A dirty snowball 15 km long on a 75-year loop from inside Venus’s orbit to beyond Neptune’s, going round the wrong way. Its tail always points away from the Sun.',
    facts: [
      f('Distance from the Sun', `${r.toFixed(1)} AU`, 'E'),
      f('Last return', last ? `${Math.round(last.t)}` : '1986', last && last.t > 2135 ? 'P' : 'R'),
      f('Next return', next ? `${Math.round(next.t)}` : 'after 12,040', next && next.t > 2135 ? 'P' : 'R'),
      f('Closest to the Sun', '0.59 AU', 'R'), f('Farthest', '35 AU', 'R'), f('Orbit tilt', '162° (retrograde)', 'R'),
    ],
    why: 'Seen at every return since at least 240 BCE: one of the few clocks that every age of this future shares with ours.',
  };
}
