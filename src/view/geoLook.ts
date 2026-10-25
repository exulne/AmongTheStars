// How a world's physical state shows on its surface: polar caps that grow and
// shrink with the seasons, coastlines that creep with the sea, clouds, dust
// storms, volcanic haze, fresh craters and lava, Io's hot spots, Jupiter's Red
// Spot, Saturn's white spots, Titan's lakes, aurorae. Reads geoView; stores nothing.

import * as THREE from 'three';
import type { StateMsg } from '../sim/client.ts';
import { worldNow, type WorldNow } from '../sim/geoView.ts';
import type { World } from '../sim/world.ts';
import { setScars } from './planetShader.ts';

const D2R = Math.PI / 180;
/** Calibrations so a cap edge (degrees from the pole) lands where the shader's noisy caps begin: Earth's 2040 caps keep their old look. */
const CAP_OFFSET: Record<string, [number, number]> = { Earth: [0.14, 0.09], Mars: [0, 0] };

const memo = new WeakMap<THREE.ShaderMaterial, { key: string; now: WorldNow }>();

/** Body b's state now (memoised per material, refreshed when the state or the date moves). */
export function geoNow(mat: THREE.ShaderMaterial, world: World, snap: StateMsg | null, b: number, year: number): WorldNow {
  const key = `${b}:${snap?.step ?? -1}:${snap?.geo?.seed ?? 0}:${Math.round(year * 100)}`;
  const m = memo.get(mat);
  if (m && m.key === key) return m.now;
  const now = worldNow(world, snap, b, year);
  memo.set(mat, { key, now });
  return now;
}

/** Set a planet material's living-world uniforms for body b now. */
export function applyGeo(mat: THREE.ShaderMaterial, world: World, snap: StateMsg | null, b: number, year: number): WorldNow {
  const u = mat.uniforms, now = geoNow(mat, world, snap, b, year), body = world.bodies[b], sol = body.system === 0;
  if (!u.uIceN) return now;
  const off = (sol && CAP_OFFSET[body.name]) || [0, 0];
  // a cold snap pushes the snow line toward the equator on worlds with weather
  const winter = b === world.earth ? now.cool * 2.5 : 0;
  const thr = (cap: number, o: number) => (cap >= 89.5 ? -1 : cap <= 0.2 ? 2 : Math.sin((90 - Math.min(89, cap + winter)) * D2R) - o);
  if (b === world.earth || b === world.mars) { u.uIceN.value = thr(now.capN, off[0]); u.uIceS.value = thr(now.capS, off[1]); }
  u.uSeaShift.value = b === world.earth ? Math.max(-0.05, Math.min(0.12, now.sea * 0.0025)) : 0;
  u.uCloud.value = b === world.earth ? Math.min(1.4, 1 + 0.4 * (1 - Math.exp(-now.aero))) : now.terra > 0 ? 1 : 1;
  u.uDust.value = now.dust > 1.2 ? Math.min(0.92, 1 - Math.exp(-(now.dust - 1) / 2.5)) : 0;
  u.uAero.value = Math.min(0.85, 1 - Math.exp(-now.aero));
  u.uAurora.value = now.aurora;
  u.uVolc.value = sol && body.name === 'Io' ? 1 : 0;
  if (sol && body.name === 'Jupiter') u.uSpot.value = now.grs / 12000;
  if (sol && body.name === 'Saturn') { u.uWhite.value = now.gws; u.uWhiteLat.value = Math.sin(now.gwsLat * D2R); }
  if (sol && body.name === 'Titan') { u.uLakes.value = 1 - Math.min(1, now.terra * 2); u.uSeason.value = now.season; }
  // terraforming as the geo state has it (0..1), past the engine's habitability share
  if (now.live) u.uTerra.value = now.terra;
  // the biggest and freshest marks first
  setScars(mat, [...now.scars].sort((p, q) => q.rad * q.amp - p.rad * p.amp));
  return now;
}

/** A surface feature worth a card: where it is (unit direction, body frame) and what it is. */
export interface Feature { kind: 'cap' | 'scar' | 'spot' | 'storm' | 'whitespot' | 'lakes' | 'plume' | 'hotspot' | 'aurora'; x: number; y: number; z: number; i: number; north?: boolean }

/** What on body b can be picked and explained now. */
export function features(world: World, b: number, now: WorldNow): Feature[] {
  const body = world.bodies[b], sol = body.system === 0, out: Feature[] = [];
  const name = sol ? body.name : '';
  if (b === world.mars || b === world.earth || (now.ice >= 0.01 && now.capN > 0.2 && now.capN < 89.5 && now.pAtm >= 0)) {
    if (now.capN > 0.2 && now.capN < 89.5) out.push({ kind: 'cap', x: 0, y: 1, z: 0, i: 0, north: true });
    if (now.capS > 0.2 && now.capS < 89.5) out.push({ kind: 'cap', x: 0, y: -1, z: 0, i: 1, north: false });
  }
  now.scars.slice(0, 12).forEach((s, i) => out.push({ kind: 'scar', x: s.x, y: s.y, z: s.z, i }));
  if (name === 'Jupiter' && now.grs > 0) { const lat = Math.asin(-0.3), lon = 1.6; out.push({ kind: 'spot', x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon), i: 0 }); }
  if (name === 'Saturn' && now.gws > 0.05) { const lat = now.gwsLat * D2R; out.push({ kind: 'whitespot', x: Math.cos(lat), y: Math.sin(lat), z: 0, i: 0 }); }
  if (now.storm) out.push({ kind: 'storm', x: 0.94, y: -0.34, z: 0, i: 0 });
  if (name === 'Titan') out.push({ kind: 'lakes', x: 0, y: 0.97, z: 0.24, i: 0 });
  if (name === 'Enceladus') out.push({ kind: 'plume', x: 0, y: -1, z: 0, i: 0 });
  if (name === 'Io') { const lat = 13 * D2R, lon = -51 * D2R; out.push({ kind: 'hotspot', x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon), i: 0 }); }
  if (now.aurora > 0.25 && (name === 'Earth' || name === 'Jupiter' || name === 'Saturn')) out.push({ kind: 'aurora', x: 0, y: 0.96, z: -0.28, i: 0 });
  return out;
}
