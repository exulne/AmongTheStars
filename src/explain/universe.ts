// The Local Group's real galaxies and the procedural galaxies behind them.

import * as THREE from 'three';
import { hash01 } from '../sim/rng.ts';
import { fmtLy, galToEq, jName, sig, fmtYears } from './astro.ts';
import { addCpuSet, nearestPoint, pxPerUnit } from './picker.ts';
import { h01, registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';

/** Real facts for the five galaxies the simulation names. */
export const LOCAL_GROUP: Record<string, { type: string; facts: Fact[]; lede: string; why: string }> = {
  'Milky Way': {
    type: 'SBbc barred spiral',
    lede: 'Our galaxy: a barred spiral about a hundred thousand light years across, with the Sun two-thirds of the way out.',
    facts: [
      { k: 'Type', v: 'SBbc barred spiral', t: 'R' }, { k: 'Diameter', v: '≈100,000 ly (stellar disc)', t: 'R' },
      { k: 'Stars', v: '100–400 billion', t: 'R' }, { k: 'Mass with dark matter', v: '≈1.5 trillion M☉', t: 'R' },
      { k: 'Age', v: '≈13.6 billion years', t: 'R' }, { k: 'Sun from centre', v: '26,700 ly', t: 'R' },
      { k: 'One turn of the Sun', v: '≈230 million years', t: 'R' },
    ],
    why: 'Everything humans do in this future happens here, unless someone opens a wormhole.',
  },
  'Large Magellanic Cloud': {
    type: 'SB(s)m Magellanic spiral',
    lede: 'The Milky Way\'s largest satellite galaxy, visible to the naked eye from Earth\'s southern hemisphere.',
    facts: [
      { k: 'Type', v: 'SB(s)m Magellanic spiral', t: 'R' }, { k: 'Distance', v: '163,000 ly', t: 'R' },
      { k: 'Diameter', v: '≈14,000 ly', t: 'R' }, { k: 'Stars', v: '≈30 billion', t: 'R' },
      { k: 'Mass with dark matter', v: '≈140 billion M☉', t: 'R' }, { k: 'Moving away at', v: '262 km/s (redshift 0.00087)', t: 'R' },
      { k: 'Brightest nebula', v: 'Tarantula Nebula, 30 Doradus', t: 'R' },
    ],
    why: 'The nearest other galaxy with room for a civilisation. In futures that build a wormhole, it is the first one reached.',
  },
  'Small Magellanic Cloud': {
    type: 'SB(s)m pec dwarf irregular',
    lede: 'A dwarf galaxy being pulled apart by the Large Cloud and the Milky Way; a bridge of gas joins the two Clouds.',
    facts: [
      { k: 'Type', v: 'SB(s)m pec dwarf irregular', t: 'R' }, { k: 'Distance', v: '200,000 ly', t: 'R' },
      { k: 'Diameter', v: '≈7,000 ly', t: 'R' }, { k: 'Stars', v: 'a few hundred million to billions', t: 'R' },
      { k: 'Mass', v: '≈7 billion M☉', t: 'R' }, { k: 'Moving away at', v: '146 km/s (redshift 0.00053)', t: 'R' },
      { k: 'Metals', v: 'about a fifth of the Sun\'s', t: 'R' },
    ],
    why: 'Poor in heavy elements, so rocky planets are scarcer here: a hard place to settle even for those who can reach it.',
  },
  Andromeda: {
    type: 'SA(s)b spiral',
    lede: 'The largest galaxy in the Local Group, falling toward the Milky Way at 110 km/s.',
    facts: [
      { k: 'Type', v: 'SA(s)b spiral (M31)', t: 'R' }, { k: 'Distance', v: '2.54 million ly', t: 'R' },
      { k: 'Diameter', v: '≈152,000 ly', t: 'R' }, { k: 'Stars', v: '≈1 trillion', t: 'R' },
      { k: 'Mass with dark matter', v: '≈1.5 trillion M☉', t: 'R' }, { k: 'Approaching at', v: '300 km/s (blueshift −0.0010)', t: 'R' },
      { k: 'Merges with the Milky Way', v: 'in ≈4.5 billion years', t: 'R' },
    ],
    why: 'A light signal sent there today arrives 2.5 million years after this simulation ends. Only a wormhole puts people here.',
  },
  Triangulum: {
    type: 'SA(s)cd spiral',
    lede: 'The third-largest Local Group galaxy, a loose spiral full of star-forming regions.',
    facts: [
      { k: 'Type', v: 'SA(s)cd spiral (M33)', t: 'R' }, { k: 'Distance', v: '2.73 million ly', t: 'R' },
      { k: 'Diameter', v: '≈61,000 ly', t: 'R' }, { k: 'Stars', v: '≈40 billion', t: 'R' },
      { k: 'Approaching at', v: '179 km/s (blueshift −0.0006)', t: 'R' }, { k: 'Biggest nebula', v: 'NGC 604, 1,500 ly across', t: 'R' },
    ],
    why: 'Probably a satellite of Andromeda. Beyond reach for anyone in this future without a wormhole.',
  },
};

const GAL_WORDS = ['Pinwheel', 'Lantern', 'Spindle', 'Ember', 'Feather', 'Whirl', 'Coin', 'Shell', 'Locket', 'Thistle', 'Mirror', 'Kite', 'Ripple', 'Bramble', 'Halo', 'Seed'];
const H0 = 70 / 3.2616; // km/s per million ly

/** Register the far galaxies drawn as sprites: `tex[i]` is the texture seed sprite i was drawn with. */
export function explainBackground(group: THREE.Object3D, sprites: THREE.Sprite[], tex: number[]): void {
  registerExplainer('bgal', {
    obj: group,
    explain: (i, c) => bgCard(sprites[i], tex[i], i, c),
    name: (i) => `${bgName(sprites[i], i)} · ${bgType(tex[i], i).short}`,
    locate: (i, out) => sprites[i].getWorldPosition(out),
  });
  addCpuSet({
    kind: 'bgal', obj: group, prio: -1,
    hit: (p) => nearestPoint(sprites.length, (i, out) => sprites[i].getWorldPosition(out), p, (i, _d, cam) => Math.max(7, sprites[i].scale.x * 0.35 * pxPerUnit(p, cam))),
  });
}

function bgType(seed: number, i: number): { short: string; long: string; elliptical: boolean } {
  const elliptical = hash01(seed, 9) < 0.35, arms = 2 + Math.floor(hash01(seed, 8) * 2);
  if (elliptical) { const e = Math.floor(h01(i, 70) * 8); return { short: `E${e} elliptical`, long: `E${e} elliptical galaxy`, elliptical }; }
  return arms === 2 ? { short: 'Sc spiral', long: 'grand-design spiral (Sc), two arms', elliptical } : { short: 'Sb spiral', long: 'many-armed spiral (Sb), three arms', elliptical };
}

function bgName(sp: THREE.Sprite, i: number): string {
  const p = sp.position;
  const e = galToEq(p.x, -p.z, p.y);
  if (h01(i, 71) < 0.18) return `${GAL_WORDS[Math.floor(h01(i, 72) * GAL_WORDS.length)]} Galaxy`;
  return `2SG ${jName(e.ra, e.dec).slice(0, 10)}`;
}

function bgCard(sp: THREE.Sprite, seed: number, i: number, c: ExCtx): Explanation {
  const t = bgType(seed, i);
  const dLy = sp.position.length() * 10000;
  const diam = (sp.scale.x / 3) * 10000 * 0.8; // drawn at the Local Group's 3× scale
  const stars = (t.elliptical ? 3e11 : 2e11) * Math.pow(diam / 100000, 2) * (0.6 + 0.8 * h01(i, 73));
  const vPec = (h01(i, 74) - 0.5) * 400;
  const v = H0 * (dLy / 1e6) + vPec;
  const e = galToEq(sp.position.x, -sp.position.z, sp.position.y);
  const lit = 2040 + c.year - dLy;
  const name = bgName(sp, i);
  const facts: Fact[] = [
    { k: 'Type', v: t.long, t: 'P' },
    { k: 'Distance', v: fmtLy(dLy), t: 'P' },
    { k: 'Diameter', v: `${Math.round(diam / 1000).toLocaleString('en-US')},000 ly`, t: 'P' },
    { k: 'Stars', v: `≈${sig(stars)}`, t: 'E' },
    { k: 'Receding at', v: `${Math.round(v)} km/s, redshift ${(v / 299792).toFixed(4)}`, t: 'E' },
    { k: 'Designation', v: `2SG ${jName(e.ra, e.dec)}`, t: 'P' },
    { k: 'Light we see left it', v: `${fmtYears(dLy)} ago`, t: 'E' },
    { k: 'Humans', v: 'never; the simulation\'s furthest reach is the Local Group', t: 'P' },
  ];
  void lit;
  return {
    eyebrow: 'Galaxy beyond the Local Group',
    title: name,
    lede: `A ${t.long} ${fmtLy(dLy)} away, one of the galaxies strung along the filaments of the cosmic web around us. Its speed is mostly the expansion of space (Hubble's law, 70 km/s per megaparsec).`,
    facts,
    why: t.elliptical ? 'Ellipticals have stopped making stars; their old red suns would make for long-lived but metal-rich, quiet systems. No one in this future will ever know.' : `A signal sent there in ${2040 + Math.round(c.year)} arrives ${fmtLy(dLy).replace(' ly', '')} years later. For everyone in this future, it can only be looked at.`,
  };
}
