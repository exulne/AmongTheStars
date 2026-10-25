// What life is like in a place at a given year: government, language, faith,
// art, architecture, daily life. Everything is derived from the simulation's
// state (stage, wealth, stability, era, technologies, independence, distance
// from Earth, events), so a settlement's society visibly changes over time.

import { techAt } from './diffusion.ts';
import { EV, STAGE, TECHS } from './catalog.ts';
import type { Engine } from './engine.ts';
import { F, NF } from './metrics.ts';
import { hash01 } from './rng.ts';
import { H, NH, NPC, PC, REGIME, type CivState } from './civ.ts';
import { REGIME_NAMES } from './polity.ts';

export interface Society {
  year: number;
  government: string; governmentWhy: string;
  polity: { id: number; name: string; capital: number; regime: string; since: number } | null; // who governs this place
  bodies: { baseline: number; adapted: number; uploaded: number };                               // shares of its people
  language: string; languageDrift: number;      // 0 = Earth's languages, 1 = unrecognisable
  faith: string | null;
  faiths: { id: number; name: string; share: number; tenets: string }[]; // the top three, from the faith table
  art: string;
  architecture: { name: string; hue: number; height: number; curvature: number; density: number; glow: number; materials: string };
  daily: { work: string; food: string; dress: string; transport: string; family: string; lifespan: string };
  mood: string;
  sentences: string[];                          // a short portrait in prose
}

type Has = (id: string) => boolean;

const ROOTS = ['vel', 'ash', 'kor', 'mir', 'tal', 'zen', 'oru', 'sel', 'dra', 'nym', 'quel', 'tir', 'yam', 'esk', 'lun', 'hal'];
const ART_FORMS = ['{X}ism', 'the {X} School', 'Neo-{X}', 'the Long {X}', '{X} Realism', 'the {X} Quiet', 'Post-{X}'];

export class SocietyModel {
  private e: Engine;
  /** names and tenets of faith f (from the Chronicle) */
  faithInfo: (f: number) => { name: string; tenets: string } = (f) => ({ name: `faith ${f}`, tenets: '' });
  /** name of polity row p (from the Chronicle) */
  polityName: (p: number) => string = (p) => `polity ${p}`;
  private indep = new Map<number, number>();
  private specia = new Map<number, number>();

  constructor(e: Engine, private coined: (b: number, n: number) => string) {
    this.e = e;
    for (const ev of e.events) {
      if (ev.type === EV.Independence && !this.indep.has(ev.body)) this.indep.set(ev.body, ev.year);
      if (ev.type === EV.Speciation && !this.specia.has(ev.body)) this.specia.set(ev.body, ev.year);
    }
  }

  /** Society at body b in `year`, given that year's settlement row S (from the state snapshot). */
  at(b: number, year: number, S: Float64Array, techDone: Float64Array, era: number, hx?: CivState, techWhere?: Float64Array): Society {
    const v = (f: keyof typeof F) => S[b * NF + F[f]];
    // a place lives with what it has heard of: news of an invention arrives at light speed
    const has: Has = (id) => { const i = TECHS.findIndex((t) => t.id === id); return i >= 0 && (techWhere ? techAt(this.e.world, techDone, techWhere, i, b, year) : techDone[i] >= 0 && techDone[i] <= year); };
    const w = this.e.world, body = w.bodies[b], sys = w.systems[body.system];
    const stage = v('stage'), pop = v('pop'), stab = v('stability'), happy = v('happiness'), gini = v('gini');
    const gdpPc = pop > 0 ? v('gdp') / pop : 0, age = year - v('founded'), div = v('divergence');
    const independent = v('faction') === b && b !== w.earth;
    const h = (k: number) => hash01(b, Math.floor(year / 150), k);

    // government: the polity that rules this place, and the regime it has now
    let government: string, why: string;
    const fac = v('faction'), pRow = hx ? hx.H[fac * NH + H.pol] : -1;
    const regime = pRow >= 0 && hx ? hx.pol[pRow * NPC + PC.regime] : -1;
    const polity = pRow >= 0 && hx ? { id: pRow, name: this.polityName(pRow), capital: fac, regime: regime >= 0 ? REGIME_NAMES[regime] : REGIME_NAMES[0], since: hx.pol[pRow * NPC + PC.since] } : null;
    if (polity && regime >= 0 && stage > STAGE.BASE) {
      government = fac === b ? REGIME_NAMES[regime] : `${stage >= STAGE.CITY ? 'Province' : 'Territory'} of ${polity.name}`;
      why = fac === b
        ? `${polity.name}, ${['an elected charter government', 'every citizen votes on everything', 'the generals rule while the war lasts', 'its faith\'s elders hold the chair', 'the owning families run the state', 'policy is set by forecasts the citizens audit', 'uploaded minds vote continuously', 'an emergency committee holds what is left'][regime]}, since ${Math.round(2040 + polity.since)}`
        : `ruled from ${w.bodies[fac]?.name ?? 'elsewhere'}, ${REGIME_NAMES[regime].toLowerCase()}`;
      if (regime === REGIME.JUNTA && fac !== b) government = `Occupied territory of ${polity.name}`;
    } else if (stage <= STAGE.BASE) { government = 'Mission command'; why = 'a crew this small takes orders from whoever sent it'; }
    else if (era === 4 && stab < 0.45) { government = 'Military council'; why = 'war, and stability below half'; }
    else if (era === 6 || stab < 0.25) { government = 'Emergency committee'; why = 'the collapse left nothing else standing'; }
    else if (has('mindUpload') && stage >= STAGE.HUB) { government = 'Consensus mesh'; why = 'uploaded minds vote continuously on everything'; }
    else if (has('psychohistory') && stab > 0.7) { government = 'Forecast technocracy'; why = 'policy is set by predictive models the citizens audit'; }
    else if (faithsTop(hx, b) > 0.6 && stab < 0.6) { government = 'Covenant theocracy'; why = 'one faith holds most hearts and the state is shaky'; }
    else if (!independent && b !== w.earth) { government = stage >= STAGE.CITY ? 'Self-governing territory' : 'Colonial charter'; why = `still answers to ${w.bodies[v('faction')]?.name ?? 'its founders'}`; }
    else if (gini > 0.5) { government = 'Corporate republic'; why = 'a few families own most of the habitat'; }
    else if (has('neuralLace')) { government = 'Direct democracy'; why = 'every adult votes through their interface, weekly'; }
    else { government = b === w.earth ? 'Federated states of Earth' : 'Charter republic'; why = independent && b !== w.earth ? `independent since ${Math.round(2040 + (this.indep.get(b) ?? v('founded')))}` : 'elected assemblies, old habits'; }

    // language drifts with light-lag and time apart
    const drift = Math.min(1, Math.max(0, (age > 0 ? age : 0) / 1500 + Math.log10(1 + sys.dist) / 2.5 + (independent ? 0.1 : 0)));
    const language = drift < 0.15 ? 'Earth languages, mostly English and Mandarin' : drift < 0.4 ? `${this.coined(b, 3)} creole, still readable by Earth` : drift < 0.7 ? `${this.coined(b, 4)}, a daughter language of Earth's` : `${this.coined(b, 5)}, unrelated to anything spoken on Earth`;

    // faith: the shares this settlement holds in the faith table; the rest keep Earth's old religions
    const faiths: Society['faiths'] = [];
    if (hx) for (let k = 0; k < 3; k++) {
      const f = hx.H[b * NH + H.fa0 + 2 * k];
      if (f >= 0) faiths.push({ id: f, share: hx.H[b * NH + H.sh0 + 2 * k], ...this.faithInfo(f) });
    }
    const old = 1 - faiths.reduce((a, x) => a + x.share, 0);
    const faith = faiths.length
      ? `${faiths.map((x) => `${x.name} (${Math.round(x.share * 100)}%)`).join(', ')}${old > 0.05 ? `; ${Math.round(old * 100)}% keep Earth's old religions` : ''}`
      : b === w.earth ? "Earth's old religions, much diluted" : null;

    // art movement of this century
    const century = Math.floor((2040 + year) / 100);
    const art = ART_FORMS[Math.floor(hash01(b, century, 3) * ART_FORMS.length)].replace('{X}', ROOTS[Math.floor(hash01(b, century, 4) * ROOTS.length)].replace(/^./, (c) => c.toUpperCase()));

    // architecture follows technology, wealth and culture
    let arch: Society['architecture'];
    const hue = (hash01(body.system, Math.floor(year / 400), 7) * 360 + (independent ? 40 : 0)) % 360;
    if (stage <= STAGE.BASE) arch = { name: 'buried regolith huts and inflatable domes', hue, height: 0.05, curvature: 0.9, density: 0.1, glow: 0.2, materials: 'regolith, Kevlar, aluminium' };
    else if (has('mindUpload') && stage >= STAGE.HUB) arch = { name: 'quiet data-temples among overgrown towers', hue, height: 0.6, curvature: 0.6, density: 0.35, glow: 0.8, materials: 'diamond, light' };
    else if (has('nanofab')) arch = { name: 'grown spires and skyways', hue, height: 0.9, curvature: 0.8, density: 0.7, glow: 0.7, materials: 'grown carbon, smart glass' };
    else if (has('fusion') && stage >= STAGE.CITY) arch = { name: 'lit arcologies under pressure domes', hue, height: 0.7, curvature: 0.4, density: 0.8, glow: 0.6, materials: 'printed basalt, glass, steel' };
    else if (has('regolith')) arch = { name: 'printed regolith warrens and greenhouse rows', hue, height: 0.25, curvature: 0.6, density: 0.5, glow: 0.4, materials: 'sintered regolith, glass' };
    else arch = { name: 'prefabricated modules', hue, height: 0.15, curvature: 0.3, density: 0.3, glow: 0.3, materials: 'aluminium, composites' };
    if (v('terraform') > 0.2) arch = { ...arch, name: `${arch.name}, opening onto parks and water now that the air holds`, curvature: Math.min(1, arch.curvature + 0.1) };
    if (stab < 0.3 || era === 6) arch = { ...arch, name: `${arch.name}, many of them dark or abandoned`, glow: arch.glow * 0.4 };

    // daily life
    const ai = has('agi');
    const work = has('mindUpload') ? 'optional; most people make things for each other' : ai && has('nanofab') ? 'about 15 hours a week, mostly caring and making' : ai ? 'about 25 hours a week, beside machine colleagues' : stage <= STAGE.COLONY ? 'long shifts keeping the habitat alive' : '40-hour weeks in industry, farms and services';
    const food = has('synthBio') ? (v('terraform') > 0.3 ? 'grown outdoors again, plus vat proteins' : 'hydroponic greens and vat-grown protein') : 'shipped rations and the first hydroponic greens';
    const dress = body.g < 0.4 && age > 200 ? 'loose, long garments for tall, light-boned bodies' : stage <= STAGE.BASE ? 'pressure-rated work suits' : div > 0.5 ? 'clothing cut for a body Earth tailors would not recognise' : gdpPc > 1e5 && has('nanofab') ? 'expressive smart fabric that changes with mood' : 'practical layered fabrics';
    const transport = stage <= STAGE.BASE ? 'rovers and walking' : body.g < 0.1 ? 'tethers and low-gravity hoppers' : has('spaceElevator') ? 'maglev tubes, and elevators to orbit' : 'pressurised trams';
    const births = pop > 0 ? (v('births') / pop) * 1000 : 0;
    const family = births > 15 ? 'big families; the colony needs children' : births > 8 ? 'two or three children is usual' : 'children are rare and celebrated';
    const lifespan = has('lifeExt') ? 'people expect to live two centuries or more' : has('genMed') ? 'most live past a hundred' : 'most live into their eighties';
    const mood = happy > 0.7 ? 'confident' : happy > 0.5 ? 'steady' : happy > 0.35 ? 'anxious' : 'bitter';

    const name = body.name;
    const sentences = [
      `${name} in ${Math.round(2040 + year)}: ${government.charAt(0).toLowerCase() + government.slice(1)} (${why}).`,
      `People speak ${language}${faiths.length ? `, and many follow ${faiths[0].name}, which teaches ${faiths[0].tenets}` : ''}. The fashionable art is ${art}.`,
      `They live in ${arch.name}. Work is ${work}; food is ${food}; they wear ${dress} and get around by ${transport}.`,
      `${family[0].toUpperCase() + family.slice(1)}, and ${lifespan}. The mood is ${mood}.`,
    ];
    if (this.specia.has(b) && (this.specia.get(b) ?? Infinity) <= year) sentences.push(`Since ${Math.round(2040 + this.specia.get(b)!)} they are their own species.`);
    void h;
    const adapted = hx ? hx.H[b * NH + H.adapt] : 0, uploaded = hx ? hx.H[b * NH + H.upl] : 0;
    const bodies = { baseline: (1 - adapted) * (1 - uploaded), adapted: adapted * (1 - uploaded), uploaded };
    if (uploaded > 0.05 || adapted > 0.05) sentences.push(`${Math.round(bodies.baseline * 100)}% are baseline humans, ${Math.round(bodies.adapted * 100)}% are engineered for this world, and ${Math.round(uploaded * 100)}% run on machines.`);
    return { year, government, governmentWhy: why, polity, bodies, language, languageDrift: drift, faith, faiths, art, architecture: arch, daily: { work, food, dress, transport, family, lifespan }, mood, sentences };
  }

}

function faithsTop(hx: CivState | undefined, b: number): number { return hx && hx.H[b * NH + H.fa0] >= 0 ? hx.H[b * NH + H.sh0] : 0; }
