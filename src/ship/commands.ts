// Plain-language commands → actions. Rule-based so it costs nothing per
// message and works offline: "send me to alpha centauri", "go back 65 million
// years", "take me to mars in the year 3000", "some random ass planet".

import { BIG_BANG, DESTINATIONS, NOW_YEAR, norm, type Destination } from './places.ts';

export type Action =
  | { type: 'travel'; dest: Destination }
  | { type: 'random'; habitable?: boolean; kind?: 'gas' | 'lava' | 'ocean' | 'ice' }
  | { type: 'time'; year: number; label?: string }
  | { type: 'view'; mode: 'first' | 'third' | 'toggle' }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'stop' }
  | { type: 'unknown'; text: string };

const SMALL: Record<string, number> = {
  zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, half: 0.5,
};
const MULT: Record<string, number> = { hundred: 100, thousand: 1e3, k: 1e3, million: 1e6, mil: 1e6, billion: 1e9, bn: 1e9, trillion: 1e12 };

/** "sixty five million" → "65000000", "3,000" → "3000", "1.5 billion" → "1500000000". */
export function wordsToNumbers(text: string): string {
  const toks = text.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d)(k|m|bn)\b/g, '$1 $2').split(/\s+/);
  const out: string[] = [];
  let cur: number | null = null, total = 0;
  const flush = () => { if (cur !== null || total) { out.push(String(total + (cur ?? 0))); } cur = null; total = 0; };
  for (const raw of toks) {
    const t = raw.toLowerCase();
    const num = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : t in SMALL && !(t === 'a' || t === 'an') ? SMALL[t] : null;
    // "a" and "an" only count as 1 right before a multiplier ("a million years")
    if (num !== null) { cur = (cur ?? 0) + num; continue; }
    if ((t === 'a' || t === 'an') && cur === null) { cur = null; out.push(raw); continue; }
    if (t in MULT && (cur !== null || out.length && /^(a|an)$/i.test(out[out.length - 1]))) {
      if (cur === null) { out.pop(); cur = 1; }
      const m = MULT[t];
      if (m === 100) cur *= m;
      else { total += cur * m; cur = 0; }
      continue;
    }
    if (t === 'and' && (cur !== null || total)) continue;
    flush();
    out.push(raw);
  }
  flush();
  return out.join(' ').replace(/\b(\d+) (\d{1,2})\b(?= (?:years?|ad|bc|bce|ce)\b)/, (_, a, b) => String(Number(a) + Number(b)));
}

// named moments in time
const EPOCHS: [RegExp, number, string][] = [
  [/\bbig bang\b|\bbeginning of (time|the universe)\b|\bstart of the universe\b/, BIG_BANG + 3.8e5, 'the Big Bang'],
  [/\bfirst stars?\b|\bcosmic dawn\b/, BIG_BANG + 2.5e8, 'cosmic dawn'],
  [/\b(sun|solar system) (is )?(form|born|birth)/, -4.57e9, 'the birth of the Sun'],
  [/\bearth (form|was born|birth)|\bformation of earth\b|\bbaby earth\b/, -4.5e9, 'the young Earth'],
  [/\bsnowball earth\b/, -6.5e8, 'Snowball Earth'],
  [/\bdinosaurs? (die|went extinct|extinction)|\basteroid (hit|impact)|\bchicxulub\b/, -6.6e7 - 50, 'the dinosaur asteroid'],
  [/\bdinosaurs?\b|\bjurassic\b|\bcretaceous\b|\bt ?rex\b/, -6.8e7, 'the age of dinosaurs'],
  [/\bice age\b|\bmammoths?\b/, -20000, 'the last ice age'],
  [/\bpyramids?\b|\bancient egypt\b/, -2560, 'the Great Pyramid'],
  [/\b(roman empire|ancient rome|julius caesar)\b/, -44, 'ancient Rome'],
  [/\b(medieval|middle ages|knights?)\b/, 1200, 'the Middle Ages'],
  [/\brenaissance\b/, 1500, 'the Renaissance'],
  [/\bmoon landing\b|\bapollo 11\b/, 1969, 'the Moon landing'],
  [/\bsputnik\b/, 1957, 'Sputnik'],
  [/\b(now|present|today|present day|current year|back home in time)\b/, NOW_YEAR, 'the present'],
  [/\bandromeda (collision|merger|hits)|\bgalaxies collide\b/, 4.5e9, 'the Andromeda collision'],
  [/\b(sun (dies|dying|explodes|death)|red giant|end of the sun|death of the sun)\b/, 6.5e9, 'the red giant Sun'],
  [/\bwhite dwarf\b/, 8e9, 'the white dwarf Sun'],
  [/\b(heat death|end of (time|the universe|everything))\b/, 1e14, 'the heat death of the universe'],
  [/\bfar future\b|\bway into the future\b|\bdistant future\b/, NOW_YEAR + 1e6, 'the far future'],
];

const TRAVEL_VERBS = /\b(take|send|bring|fly|warp|jump|go|head|travel|navigate|move|set (a )?course|plot (a )?course|lets go|let s go|visit|teleport|launch|get|show)\b( me| us)?( to| for| towards?| over to)?\b/g;
const FILLER = /\b(please|yo|hey|ship|computer|can you|could you|would you|i want to|i wanna|wanna|i d like to|like|uh|um|the|a|an|now|right|okay|ok|real quick|bro|dude|man)\b/g;

export function parse(input: string): Action[] {
  const pre = input.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.,\s]/g, ' ').replace(/\.(?!\d)/g, ' ');
  let t = ' ' + norm(wordsToNumbers(pre)) + ' ';
  const actions: Action[] = [];

  if (/^\s*(help|what can you do|commands|how does this work)\s*$/.test(t)) return [{ type: 'help' }];
  if (/\b(stop|abort|cancel|halt|never ?mind)\b/.test(t)) return [{ type: 'stop' }];
  if (/\b(where am i|where are we|status|what year is it|what year|report)\b/.test(t)) return [{ type: 'status' }];

  // camera
  if (/\b(first person|cockpit|pov|inside view|pilot view|1st person)\b/.test(t)) { actions.push({ type: 'view', mode: 'first' }); t = t.replace(/\b(first person|cockpit|pov|inside view|pilot view|1st person)\b/g, ' '); }
  else if (/\b(third person|outside|chase cam|exterior|3rd person|see the ship|show the ship)\b/.test(t)) { actions.push({ type: 'view', mode: 'third' }); t = t.replace(/\b(third person|outside|chase cam|exterior|3rd person|see the ship|show the ship)\b/g, ' '); }
  else if (/\b(switch|change|toggle) (the )?(view|camera|perspective)\b/.test(t)) { actions.push({ type: 'view', mode: 'toggle' }); t = t.replace(/\b(switch|change|toggle) (the )?(view|camera|perspective)\b/g, ' '); }

  // time
  const time = parseTime(t);
  if (time) { t = time.rest; }

  // place
  let place: Action | null = null;
  if (/\b(random|somewhere|anywhere|surprise me|wherever|some planet|a planet|new planet|unknown|uncharted|explore)\b/.test(t)) {
    const habitable = /\b(habitable|livable|earth like|earthlike|alive|life|nice|green)\b/.test(t);
    const kind = /\b(gas giant|giant)\b/.test(t) ? 'gas' : /\b(lava|hot|volcanic|hell)\b/.test(t) ? 'lava' : /\b(water|ocean)\b/.test(t) ? 'ocean' : /\b(ice|frozen|cold)\b/.test(t) ? 'ice' : undefined;
    place = { type: 'random', habitable, kind };
  } else {
    const stripped = t.replace(TRAVEL_VERBS, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    const dest = matchDestination(stripped);
    if (dest) place = { type: 'travel', dest };
  }

  // a bare year with no place: "go to 3000"
  if (!time && !place) {
    const m = t.match(/\b(\d{3,})\b/);
    if (m && /\b(go|jump|take|send|travel|warp)\b/.test(t)) actions.push({ type: 'time', year: Number(m[1]) });
  }

  if (place) actions.push(place);
  if (time) actions.push({ type: 'time', year: time.year, label: time.label });
  if (!actions.length) actions.push({ type: 'unknown', text: input });
  return actions;
}

function parseTime(t: string): { year: number; label?: string; rest: string } | null {
  const num = parseNumericTime(t);
  if (num) return num;
  for (const [re, year, label] of EPOCHS) {
    const m = t.match(re);
    if (m) return { year, label, rest: t.replace(re, ' ') };
  }
  if (/\b(future)\b/.test(t)) return { year: NOW_YEAR + 1000, rest: t.replace(/\bfuture\b/, ' ') };
  if (/\b(past)\b/.test(t)) return { year: NOW_YEAR - 1000, rest: t.replace(/\bpast\b/, ' ') };
  return null;
}

function parseNumericTime(t: string): { year: number; label?: string; rest: string } | null {
  const N = '(\\d+(?:\\.\\d+)?)';
  let m: RegExpMatchArray | null;
  // "65000000 years ago", "back 300 years", "100 years in the past"
  if ((m = t.match(new RegExp(`\\b(?:back(?: in time)?\\s+)?${N}\\s+years?\\s+(ago|in the past|back|earlier|before)\\b`))) ||
      (m = t.match(new RegExp(`\\bback(?: in time)?\\s+${N}\\s+years?\\b`)))) {
    return { year: NOW_YEAR - Number(m[1]), rest: t.replace(m[0], ' ') };
  }
  // "1000 years from now", "forward 500 years", "into the future 1000000 years"
  if ((m = t.match(new RegExp(`\\b${N}\\s+years?\\s+(from now|in the future|forward|ahead|later|into the future)\\b`))) ||
      (m = t.match(new RegExp(`\\b(?:forward|ahead|into the future|future)\\s+${N}\\s+years?\\b`)))) {
    return { year: NOW_YEAR + Number(m[1]), rest: t.replace(m[0], ' ') };
  }
  // "year 3000", "the year 500 bc", "in 1969", "to 1200 ad"
  if ((m = t.match(new RegExp(`\\b(?:year|yr)\\s+${N}(?:\\s+(bc|bce|ad|ce))?\\b`))) ||
      (m = t.match(new RegExp(`\\b${N}\\s+(bc|bce|ad|ce)\\b`))) ||
      (m = t.match(new RegExp(`\\b(?:in|to|at|back to|forward to)\\s+${N}\\b(?!\\s*(?:light|ly|au|km))`)))) {
    const n = Number(m[1]);
    const era = m[2];
    // "in 3" or "to 1" are probably planet names; only accept real-looking years
    if (era || /\byear\b/.test(m[0]) || n >= 100) {
      const year = era === 'bc' || era === 'bce' ? 1 - n : n;
      return { year, rest: t.replace(m[0], ' ') };
    }
  }
  return null;
}

// ------------------------------------------------------------------ fuzzy destination match

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function matchDestination(text: string): Destination | null {
  const q = norm(text);
  if (!q) return null;
  let best: Destination | null = null, bestScore = 0;
  const words = q.split(' ');
  for (const d of DESTINATIONS) {
    for (const name of d.names) {
      let score = 0;
      if (q === name) score = 100 + name.length;
      else if ((' ' + q + ' ').includes(' ' + name + ' ')) score = 50 + name.length;
      else {
        // compare against every window of the query with the same word count
        const nw = name.split(' ').length;
        for (let i = 0; i + nw <= words.length; i++) {
          const win = words.slice(i, i + nw).join(' ');
          const dist = lev(win, name);
          const tol = name.length <= 4 ? 0 : name.length <= 7 ? 1 : Math.floor(name.length * 0.28);
          if (dist <= tol) score = Math.max(score, 30 + name.length - dist * 4);
        }
      }
      // prefer planets over their stars on a tie ("trappist 1 e" beats "trappist 1")
      if (score && d.body) score += 0.5;
      if (score > bestScore) { bestScore = score; best = d; }
    }
  }
  return best;
}
