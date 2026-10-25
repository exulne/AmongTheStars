// The inspector's "Climate and geology" section: a world's physical state now,
// what is happening to it, what has happened lately, and the slow clocks of
// its orbit. Every number carries its provenance (R real, E estimate, P this future's draw).

import { EV, EVENT_NAMES } from '../sim/catalog.ts';
import type { HistoryMsg, SimEvent, StateMsg } from '../sim/client.ts';
import { dayLengthGainMs, dayToDate, earthObliquity, grsEnd, juneSunVs2040, moonDistanceKm, perihelionDay } from '../sim/geo.ts';
import { marsSeason, worldNow } from '../sim/geoView.ts';
import type { World } from '../sim/world.ts';
import { tagHtml } from '../explain/card.ts';
import type { Tag } from '../explain/registry.ts';
import { fmtYear } from './format.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const signed = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
/** event types that are the worlds' own doing */
export const GEO_EVENTS = new Set([
  EV['Asteroid strike'], EV['Solar storm'], EV.Supernova, EV['Gamma-ray burst'], EV.Airburst, EV['Impact winter'], EV.Eruption, EV.Supereruption,
  EV['Great earthquake'], EV['Solar superstorm'], EV['Dust storm'], EV['Io outburst'], EV['Plume surge'], EV['Jupiter impact'], EV['Comet return'],
  EV['Red Spot fades'], EV['Naked-eye supernova'], EV['Impact averted'], EV['Sunshade raised'], EV['Terraforming milestone'], EV['Seas rise'],
]);

export interface ClimateCtx { world: World; snap: StateMsg | null; year: number; events: SimEvent[]; history: HistoryMsg | null }

export function climateHtml(c: ClimateCtx, id: number): string {
  const w = c.world, b = w.bodies[id], now = worldNow(w, c.snap, id, c.year), Y = 2040 + c.year;
  const earth = id === w.earth, mars = id === w.mars, sol = b.system === 0, gas = now.pAtm < 0;
  const live: Tag = now.live ? 'P' : 'E';
  const rows: [string, string, Tag][] = [];
  if (earth) rows.push(['Temperature', `${signed(now.tNow)} K over pre-industrial`, 'E']);
  else rows.push(['Temperature', `${Math.round(b.temp + now.tNow)} K${Math.abs(now.tNow) >= 0.05 ? ` (${signed(now.tNow)} K against ${Math.round(b.temp)} K)` : ''}`, Math.abs(now.tNow) >= 0.05 ? live : sol ? 'R' : 'P']);
  if (now.heatK > 0.02) rows.push(['Warming from waste heat', `${signed(now.heatK, 2)} K`, 'E']);
  if (now.dimK < -0.02) rows.push(["Shade of the star's swarm", `${signed(now.dimK, 2)} K`, 'E']);
  if (now.shade < -0.02) rows.push(['Sunshade', `${signed(now.shade, 2)} K`, 'P']);
  if (earth) rows.push(['Sea level', `${signed(now.sea, 2)} m against 2040`, 'E']);
  if (!gas) rows.push(['Ice cover', `${(now.ice * 100).toFixed(now.ice < 0.1 ? 1 : 0)}% of the surface`, now.live && (earth || now.terra > 0) ? 'E' : sol ? 'R' : 'P']);
  if (!gas && (earth || mars || (now.capN > 0 && now.capN < 90))) rows.push(['Polar caps reach', `${Math.round(90 - now.capN)}° N and ${Math.round(90 - now.capS)}° S`, mars ? 'E' : earth ? 'E' : 'P']);
  rows.push(['Surface pressure', gas ? 'no surface' : now.pAtm >= 0.01 ? `${now.pAtm.toPrecision(3)} bar` : now.pAtm > 0 ? `${(now.pAtm * 1e3).toPrecision(2)} millibar` : 'none (vacuum)', now.terra > 0 ? 'P' : sol ? 'R' : 'P']);
  if (now.aero > 0.005) rows.push(['Stratospheric haze', `optical depth ${now.aero.toFixed(2)}, ${now.cool.toFixed(1)} K colder`, 'P']);
  if (mars || now.dust > 0.05) rows.push(['Dust in the air', `optical depth ${now.dust.toFixed(1)}${now.storm ? ', a global storm' : ''}`, mars && !now.storm ? 'E' : 'P']);
  rows.push(['Cloud cover', `${Math.round(now.cloud * 100)}%`, sol && now.terra === 0 ? 'R' : 'P']);
  if (now.vol > 0) rows.push(['Volcanism', now.vol >= 0.9 ? 'extreme (hundreds of active volcanoes)' : now.vol >= 0.25 ? 'active' : now.vol >= 0.08 ? 'some' : 'nearly dormant', sol ? 'R' : 'P']);
  if (now.field > 0) rows.push(['Magnetic field', now.field >= 2 ? `${Math.round(now.field).toLocaleString('en-US')}× Earth's` : `${now.field.toPrecision(2)}× Earth's`, sol && now.terra === 0 ? 'R' : 'P']);
  if (now.terra > 0) rows.push(['Terraformed', `${Math.round(now.terra * 100)}%`, 'P']);
  if (now.impacts > 0) rows.push(['Notable impacts here', String(now.impacts), 'P']);
  const facts = (r: [string, string, Tag][]) => `<dl class="kv ex-facts">${r.map(([k, v, t]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${tagHtml(t)}</dd>`).join('')}</dl>`;
  // the clocks of its orbit and sky
  const sky: [string, string, Tag][] = [];
  if (earth) {
    sky.push(['Axial tilt', `${earthObliquity(Y).toFixed(3)}° (${earthObliquity(2040).toFixed(3)}° in 2040)`, 'R']);
    sky.push(['Closest to the Sun', `${dayToDate(perihelionDay(Y))}`, 'R']);
    const js = juneSunVs2040(Y);
    if (Math.abs(js - 1) > 0.0005) sky.push(['June sunlight against 2040', `${signed((js - 1) * 100, 1)}%`, 'E']);
    sky.push(['The Moon', `${Math.round(moonDistanceKm(Y)).toLocaleString('en-US')} km away on average`, 'E']);
    if (c.year > 1) sky.push(['The day', `${dayLengthGainMs(Y).toFixed(1)} ms longer than in 2040`, 'E']);
    sky.push(['Next ice age', 'not due for ~50,000 years; ~100,000 with the carbon already emitted', 'E']);
  }
  if (b.name === 'Moon' && sol) sky.push(['Distance from Earth', `${Math.round(moonDistanceKm(Y)).toLocaleString('en-US')} km, receding 3.8 cm a year`, 'E']);
  if (mars) {
    sky.push(['Season', marsSeason(now.ls), 'R']);
    sky.push(['Mars Year', String(now.marsYear), 'R']);
    sky.push(['Axial tilt', '25.2°; chaotic over millions of years, unchanged within this window', 'E']);
  }
  if (b.name === 'Jupiter' && sol) {
    const end = grsEnd(c.snap?.geo?.seed ?? 1);
    sky.push(['Great Red Spot', now.grs > 0 ? `${Math.round(now.grs / 100) * 100} km across${end ? `; in this future it breaks up in ${Math.round(end)}` : '; in this future it settles and lasts'}` : `gone since ${Math.round(end ?? 0)}`, c.year < 1 ? 'E' : 'P']);
  }
  if (b.name === 'Saturn' && sol) {
    sky.push(['Great White Spot', now.gws > 0.05 ? `raging at ${Math.round(now.gwsLat)}° N` : 'quiet (one comes about every Saturn year)', now.gws > 0.05 ? 'P' : 'R']);
    sky.push(['Rings', 'raining onto Saturn; gone in 100–300 million years', 'E']);
  }
  if (b.name === 'Titan' && sol) sky.push(['Season', `${now.season > 0.5 ? 'northern summer' : now.season < -0.5 ? 'southern summer' : 'near equinox'}: methane rain follows the Sun (a year lasts 29.5 of ours)`, 'R']);
  if (sol && id === w.earth) sky.push(['The Sun', 'brightening 1% every ~110 million years; no star passes close within this window', 'E']);
  // temperature over its history
  const spark = sparkline(c.history, earth ? 'Temperature over pre-industrial, K, over its history' : 'Temperature against normal, K, over its history');
  const recent = c.events.filter((e) => GEO_EVENTS.has(e.type) && (e.body === id)).slice(0, 6);
  const lede = earth ? `${now.tNow >= 0 ? `${now.tNow.toFixed(1)} K warmer` : `${(-now.tNow).toFixed(1)} K colder`} than before industry; seas ${now.sea >= 0 ? `${now.sea.toFixed(2)} m higher` : `${(-now.sea).toFixed(2)} m lower`} than in 2040.`
    : mars ? `${marsSeason(now.ls)[0].toUpperCase()}${marsSeason(now.ls).slice(1)}.${now.storm ? ' A dust storm wraps the planet.' : ''}`
    : now.hazards.length ? '' : '';
  return `<h3>Climate and geology</h3>
    ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
    ${now.hazards.length ? `<p>Now: ${esc(now.hazards.join('; '))}.</p>` : ''}
    ${facts(rows)}${spark}
    ${sky.length ? `<h3>Orbit and sky</h3>${facts(sky)}` : ''}
    ${recent.length ? `<h3>Upheavals here</h3><ol class="events">${recent.map((e) => `<li><button class="link num ev-year" data-act="year" data-id="${e.year}" type="button">${fmtYear(e.year)}</button> <span class="ev-name">${esc(EVENT_NAMES[e.type])}</span> <span class="muted">${esc(eventNote(e))}</span></li>`).join('')}</ol>` : ''}`;
}

function eventNote(e: SimEvent): string {
  switch (e.type) {
    case EV.Eruption: return e.a ? `VEI ${e.a}${e.b ? `, ${e.b} K colder` : ''}` : 'lava';
    case EV.Supereruption: return `VEI 8, up to ${e.b} K colder`;
    case EV['Impact winter']: return `${e.a} km asteroid, up to ${e.b} K colder`;
    case EV.Airburst: return `${e.a} m`;
    case EV['Asteroid strike']: return `${e.b >= 1000 ? `${e.b / 1000} km` : `${e.b} m`} rock${e.a > 0 ? `, ${(e.a * 100).toPrecision(2)}% killed` : ''}`;
    case EV['Great earthquake']: return `magnitude ${e.a}`;
    case EV['Dust storm']: return `optical depth ${e.a}, ${Math.max(1, Math.round(e.b * 12))} months`;
    case EV['Comet return']: return e.a === 0 ? `Halley, ${e.b} AU away` : `Swift–Tuttle, ${e.b} AU away`;
    case EV['Impact averted']: return `${e.a >= 1000 ? `${e.a / 1000} km` : `${e.a} m`} rock deflected`;
    case EV['Terraforming milestone']: return ['', 'the air holds', 'open seas', 'breathable'][e.a] ?? '';
    case EV['Seas rise']: return `${e.a} m above 2040`;
    default: return '';
  }
}

function sparkline(h: HistoryMsg | null, caption: string): string {
  const v = h?.cols.tempAnom;
  if (!v || v.length < 2) return '';
  const lo = Math.min(0, ...v), hi = Math.max(0.5, ...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(2)},${(29 - ((x - lo) / span) * 27).toFixed(2)}`).join(' ');
  const zero = (29 - ((0 - lo) / span) * 27).toFixed(2);
  return `<figure class="spark"><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Temperature history"><line x1="0" x2="100" y1="${zero}" y2="${zero}" stroke="currentColor" stroke-opacity="0.25" stroke-width="0.5" vector-effect="non-scaling-stroke"/><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="0.8" vector-effect="non-scaling-stroke"/></svg><figcaption class="muted">${esc(caption)} (${lo.toFixed(1)} to ${hi.toFixed(1)})</figcaption></figure>`;
}
