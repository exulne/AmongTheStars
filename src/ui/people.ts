// Every resident of every settlement, generated on demand from a hash of
// (settlement, index, generation). Nothing is stored, so a settlement of
// 40 billion still has a person #39,999,999,999 you can look up.

import { hash01 } from '../sim/rng.ts';

const SYL = [
  ['ka', 'ren', 'mi', 'to', 'sa', 'li', 'an', 'or', 'el', 'ya', 'zu', 'ri', 'no', 'va', 'de', 'su', 'jun', 'ha', 'ko', 'ma'],
  ['ash', 'bel', 'cor', 'dov', 'esk', 'fen', 'gal', 'hol', 'ith', 'jor', 'kel', 'lun', 'mar', 'nev', 'ost', 'pel', 'quin', 'ros', 'sol', 'tav'],
  ['ae', 'ix', 'ul', 'ys', 'oth', 'eph', 'ira', 'uun', 'aal', 'oxi', 'eyr', 'ith', 'ova', 'zan', 'qel', 'vyr', 'ael', 'ixi', 'orr', 'yth'],
];
const FIRST_EARTH = ['Amara', 'Wei', 'Lucas', 'Priya', 'Mateo', 'Yuki', 'Noah', 'Fatima', 'Kofi', 'Elena', 'Arjun', 'Mei', 'Omar', 'Sofia', 'Kenji', 'Zara', 'Ivan', 'Ana', 'Tariq', 'Lin', 'Diego', 'Nia', 'Hana', 'Kwame', 'Lea'];
const LAST_EARTH = ['Okafor', 'Chen', 'Silva', 'Nakamura', 'Patel', 'Müller', 'Haddad', 'Kim', 'Mensah', 'Novak', 'García', 'Ivanova', 'Wang', 'Kowalski', 'Ramos', 'Sato', 'Diallo', 'Singh', 'Rossi', 'Nguyen'];
const JOBS: [string, number][] = [
  ['hydroponics tech', 3], ['life-support engineer', 3], ['miner', 3], ['teacher', 3], ['medic', 2], ['fabricator', 3],
  ['pilot', 1], ['researcher', 2], ['child', 4], ['retired', 2], ['artist', 1], ['administrator', 1], ['robot wrangler', 2],
  ['reactor operator', 1], ['trader', 2], ['xenogeologist', 1], ['priest', 0.5], ['soldier', 1], ['terraformer', 1], ['archivist', 0.5],
];
const JOB_TOTAL = JOBS.reduce((a, [, w]) => a + w, 0);

export interface Person {
  index: number; name: string; age: number; born: number; job: string; height: number; health: number;
  education: number; generation: number; divergence: number; faith: number; mood: string;
}

function syl(seed: number, n: number, set: number, culture: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += SYL[(set + i + culture) % 3][Math.floor(hash01(seed, i, culture) * 20)];
  return s[0].toUpperCase() + s.slice(1);
}

/** Names drift away from Earth names the longer and farther a culture has been on its own. */
export function personAt(body: number, index: number, year: number, ctx: { founded: number; gravity: number; divergence: number; culture: number; medianAge: number }): Person {
  const epoch = Math.floor((year + hash01(body, index) * 70) / 70);
  const h = (k: number) => hash01(body, index, epoch, k);
  const age = Math.min(160, Math.max(0, Math.round(-Math.log(1 - h(1) * 0.98) * ctx.medianAge / 0.69 * 0.75)));
  const born = Math.round(2040 + year - age);
  const drift = Math.min(1, (year - ctx.founded) / 1500 + ctx.divergence * 0.5);
  const name = h(2) > drift
    ? `${FIRST_EARTH[Math.floor(h(3) * FIRST_EARTH.length)]} ${LAST_EARTH[Math.floor(h(4) * LAST_EARTH.length)]}`
    : `${syl(index * 7 + body, 2, 0, ctx.culture)} ${syl(body * 31 + Math.floor(h(5) * 400), 2 + Math.floor(h(6) * 2), 1, ctx.culture)}`;
  let job = 'child';
  if (age >= 16) {
    let x = h(7) * JOB_TOTAL;
    for (const [j, w] of JOBS) { x -= w; if (x <= 0) { job = j; break; } }
    if (job === 'child') job = 'apprentice';
    if (age > 75 && h(8) < 0.7) job = 'retired';
  }
  // low gravity grows tall people
  const height = Math.round(170 + (1 - Math.min(ctx.gravity, 1.5)) * 22 * Math.min(1, (year - ctx.founded) / 300) + (h(9) - 0.5) * 24);
  return {
    index, name, age, born, job, height,
    health: Math.round(100 * (0.55 + 0.45 * h(10)) * (age > 80 ? 0.8 : 1)),
    education: Math.round(6 + h(11) * 14),
    generation: Math.max(1, Math.floor((year - ctx.founded) / 28) + (h(12) < 0.1 ? 0 : 1)),
    divergence: Math.round(ctx.divergence * 1000 * (0.8 + 0.4 * h(13))) / 10,
    faith: Math.floor(h(14) * (ctx.culture + 3)),
    mood: ['content', 'restless', 'hopeful', 'homesick', 'proud', 'tired', 'curious', 'grieving', 'in love'][Math.floor(h(15) * 9)],
  };
}
