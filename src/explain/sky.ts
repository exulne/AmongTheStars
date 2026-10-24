// The starfield behind every close view. Each dot is a real-looking star in
// that direction: its colour fixes the spectral class, its drawn brightness
// fixes the apparent magnitude, and the two together fix the distance.

import * as THREE from 'three';
import { fmtNum } from '../ui/format.ts';
import { LUM_WORD, colourWord, distFromMags, fmtDec, fmtLy, fmtRa, galLB, galToEq, jName, mainSequence, sig, specName, type LumClass } from './astro.ts';
import { addGpuSet } from './picker.ts';
import { h01, hPoisson, pointWorld, registerExplainer, type ExCtx, type Explanation, type Fact } from './registry.ts';
import { calYear, humansFact } from './simInfo.ts';

export interface SkyData { pts: THREE.Points; cls: Uint8Array; bri: Float32Array; seed: number }
export interface Observer { name: string; x: number; y: number; z: number; sol: boolean }

const CLS = 'OBAFGKM';

/** Register a sky drawn by makeSky. `observer` says where it is seen from, at the time of asking. */
export function explainSky(kind: string, sky: SkyData, observer: () => Observer): void {
  registerExplainer(kind, {
    obj: sky.pts,
    explain: (i, c) => skyCard(sky, i, c, observer()),
    name: (i) => { const s = skyStar(sky, i, observer()); return `${s.name} · ${specName(s.spec)} ${s.lc} star, ${fmtLy(s.d)}`; },
    locate: (i, out) => pointWorld(sky.pts, i, out),
  });
  addGpuSet({ kind, points: sky.pts, prio: -5, minLum: 0.05, pickPx: 6 });
}

interface SkyStar { name: string; spec: number; lc: LumClass; m: number; M: number; d: number; l: number; b: number; ra: number; dec: number; dir: THREE.Vector3; lum: number; mass: number; teff: number }

function skyStar(sky: SkyData, i: number, o: Observer): SkyStar {
  const a = sky.pts.geometry.attributes.position.array as Float32Array;
  const size = (sky.pts.geometry.attributes.size.array as Float32Array)[i];
  // scene (x, y, z) → galactic (x, −z, y)
  const gx = a[i * 3], gy = -a[i * 3 + 2], gz = a[i * 3 + 1];
  const lb = galLB(gx, gy, gz);
  const H = (k: number) => h01(sky.seed, i, k);
  const letter = CLS[sky.cls[i]] ?? 'G';
  const spec = CLS.indexOf(letter) * 10 + Math.floor(H(1) * 10);
  // apparent brightness ∝ colour × area: map the drawn range onto magnitudes 6.5 (faintest) to 1.7
  const energy = sky.bri[i] * size * size;
  const m = 6.5 - 2.5 * Math.log10(Math.max(1, energy / 0.16));
  const warm = letter === 'K' || letter === 'M' || letter === 'G';
  const giant = warm && H(2) < (letter === 'M' ? 0.7 : 0.5) && energy > 0.4;
  const supergiant = letter === 'B' && energy > 3 && H(3) < 0.3;
  const lc: LumClass = supergiant ? 'Ib' : giant ? 'III' : 'V';
  const ms = mainSequence(spec);
  const M = supergiant ? -5 - 2 * H(4) : giant ? 0.8 - 1.8 * H(4) : ms.mv + 0.4 * (H(4) - 0.5);
  const d = distFromMags(m, M);
  const lum = Math.pow(10, (4.83 - M) / 2.5);
  const mass = supergiant ? 12 + 15 * H(5) : giant ? 1 + 2 * H(5) : ms.mass;
  const teff = giant ? (letter === 'G' ? 5000 : letter === 'K' ? 4300 : 3500) : ms.teff;
  const e = galToEq(gx, gy, gz);
  return { name: `${o.sol ? '2SN' : 'Local'} ${jName(e.ra, e.dec)}`, spec, lc, m, M, d, l: lb.l, b: lb.b, ra: e.ra, dec: e.dec, dir: new THREE.Vector3(gx, gy, gz).normalize(), lum, mass, teff };
}

function skyCard(sky: SkyData, i: number, c: ExCtx, o: Observer): Explanation {
  const s = skyStar(sky, i, o);
  const at = s.dir.clone().multiplyScalar(s.d).add(new THREE.Vector3(o.x, o.y, o.z));
  const planets = hPoisson(s.spec < 20 ? 0.3 : s.spec < 30 ? 1.2 : 2.6, sky.seed, i, 7);
  const band = Math.abs(s.b) < 10;
  const facts: Fact[] = [
    { k: 'Type', v: `${specName(s.spec)} ${s.lc}`, t: 'P' },
    { k: 'Colour as drawn', v: colourWord(s.spec, s.lc), t: 'P' },
    { k: 'Brightness from here', v: `magnitude ${s.m.toFixed(1)}`, t: 'P' },
    { k: 'True brightness', v: `${sig(s.lum)} L☉ (absolute mag. ${s.M.toFixed(1)})`, t: 'E' },
    { k: 'Distance', v: fmtLy(s.d), t: 'E' },
    { k: 'Surface temperature', v: `${fmtNum(Math.round(s.teff / 10) * 10)} K`, t: 'E' },
    { k: 'Mass', v: `${s.mass.toPrecision(2)} M☉`, t: 'E' },
    { k: 'Direction, galactic l, b', v: `${s.l.toFixed(1)}°, ${s.b >= 0 ? '+' : '−'}${Math.abs(s.b).toFixed(1)}°`, t: 'P' },
  ];
  if (o.sol) facts.push({ k: 'Right ascension, declination', v: `${fmtRa(s.ra)}, ${fmtDec(s.dec)}`, t: 'P' });
  facts.push({ k: 'Planets', v: planets ? String(planets) : 'none found', t: 'P' });
  facts.push({ k: 'Light we see left it', v: calYear(2040 + c.year - s.d), t: 'E' });
  facts.push(humansFact(c, at.x, at.y, at.z));
  const kind = s.lc === 'V' ? `${colourWord(s.spec, s.lc)} ${s.spec >= 50 ? 'dwarf' : 'star'}` : `${colourWord(s.spec, s.lc)} ${LUM_WORD[s.lc]}`;
  return {
    eyebrow: `Star in the sky of ${o.name}`,
    title: s.name,
    lede: `A ${kind} ${fmtLy(s.d)} away${band ? ', one of the crowd in the Milky Way\'s band' : ''}. Its colour gives the type and its brightness the distance: a ${specName(s.spec)} ${s.lc} star this bright must be about that far.`,
    facts,
    why: s.d < 60 ? 'Close enough that ships in this future can reach it in a lifetime or two: stars like this are the next ring of colonies.' : s.d < 900 ? 'Inside the region the simulation\'s ships can reach, given centuries.' : 'Far beyond the reach of any slower-than-light ship: it stays a point of light for everyone in this future who never gets a warp drive.',
  };
}
