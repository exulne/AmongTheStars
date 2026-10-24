// Real stellar astrophysics the explainers lean on: the main sequence by
// spectral type, giants, lifetimes, coordinates and catalogue designations.

/** Spectral type as a number: O0 = 0 … M9 = 69. */
export const CLASSES = 'OBAFGKM';
export function specNum(spec: string): number {
  const c = CLASSES.indexOf(spec[0]);
  const sub = parseFloat(spec.slice(1));
  return (c < 0 ? 4 : c) * 10 + (Number.isFinite(sub) ? sub : 5);
}
export function specName(s: number): string {
  const c = Math.max(0, Math.min(69, s));
  const sub = c % 10;
  return `${CLASSES[Math.floor(c / 10)]}${Number.isInteger(sub) ? sub : sub.toFixed(1)}`;
}

// Main-sequence anchors, after Pecaut & Mamajek (2013): [type, Teff K, mass M☉, log L/L☉, Mv]
const MS: [number, number, number, number, number][] = [
  [5, 41400, 40, 5.5, -5.2], [9, 33000, 18, 4.8, -4.3], [10, 31400, 15, 4.4, -3.6], [15, 15700, 5.4, 2.9, -1.1],
  [20, 9700, 2.2, 1.5, 1.1], [25, 8100, 1.85, 1.15, 2.0], [30, 7220, 1.6, 0.75, 2.5], [35, 6550, 1.35, 0.5, 3.4],
  [40, 5930, 1.08, 0.13, 4.4], [42, 5770, 1.0, 0.0, 4.83], [50, 5270, 0.88, -0.35, 5.9], [55, 4440, 0.7, -0.78, 7.3],
  [60, 3850, 0.57, -1.15, 8.9], [63, 3400, 0.36, -1.85, 11.0], [65, 3060, 0.16, -2.6, 13.0], [68, 2500, 0.09, -3.4, 17.0],
];
export interface MainSeq { teff: number; mass: number; lum: number; mv: number }
export function mainSequence(s: number): MainSeq {
  const x = Math.max(MS[0][0], Math.min(MS[MS.length - 1][0], s));
  let k = 0;
  while (k < MS.length - 2 && MS[k + 1][0] < x) k++;
  const a = MS[k], b = MS[k + 1], t = (x - a[0]) / (b[0] - a[0]);
  const lerp = (u: number, v: number) => u + (v - u) * t;
  return { teff: lerp(a[1], b[1]), mass: Math.exp(lerp(Math.log(a[2]), Math.log(b[2]))), lum: Math.pow(10, lerp(a[3], b[3])), mv: lerp(a[4], b[4]) };
}

/** Main-sequence lifetime in years: 10 Gyr × M / L. */
export function lifetime(mass: number, lum: number): number { return 1e10 * mass / Math.max(lum, 1e-6); }

/** Conservative habitable zone (Kopparapu et al. 2013, rounded): inner/outer edge in AU. */
export function habZone(lum: number): [number, number] { return [0.95 * Math.sqrt(lum), 1.67 * Math.sqrt(lum)]; }

export type LumClass = 'V' | 'IV' | 'III' | 'II' | 'Ib' | 'Ia';
export const LUM_WORD: Record<LumClass, string> = { V: 'main-sequence star', IV: 'subgiant', III: 'giant', II: 'bright giant', Ib: 'supergiant', Ia: 'luminous supergiant' };

/** Colour word for a type, as an eye would call it. */
export function colourWord(s: number, lc: LumClass): string {
  const giant = lc !== 'V' && lc !== 'IV';
  if (s < 10) return 'blue';
  if (s < 20) return 'blue-white';
  if (s < 30) return 'white';
  if (s < 40) return 'yellow-white';
  if (s < 50) return giant ? 'yellow' : 'yellow';
  if (s < 60) return giant ? 'orange' : 'orange';
  return 'red';
}

/** Distance in light years from apparent and absolute magnitude (no extinction). */
export function distFromMags(m: number, M: number): number { return 3.2616 * Math.pow(10, (m - M + 5) / 5); }

// ---------------------------------------------------------------- coordinates

/** Galactic (Sun-centred, ly; +x toward the centre) → l, b in degrees. */
export function galLB(x: number, y: number, z: number): { l: number; b: number; d: number } {
  const d = Math.hypot(x, y, z);
  let l = (Math.atan2(y, x) * 180) / Math.PI;
  if (l < 0) l += 360;
  return { l, b: d ? (Math.asin(z / d) * 180) / Math.PI : 0, d };
}

/** Galactic unit vector → right ascension and declination (J2000), degrees. Inverse of world.ts eqToGal. */
export function galToEq(x: number, y: number, z: number): { ra: number; dec: number } {
  const n = Math.hypot(x, y, z) || 1;
  const gx = x / n, gy = y / n, gz = z / n;
  const ex = -0.0548755604 * gx + 0.4941094279 * gy - 0.867666149 * gz;
  const ey = -0.8734370902 * gx - 0.44482963 * gy - 0.1980763734 * gz;
  const ez = -0.4838350155 * gx + 0.7469822445 * gy + 0.4559837762 * gz;
  let ra = (Math.atan2(ey, ex) * 180) / Math.PI;
  if (ra < 0) ra += 360;
  return { ra, dec: (Math.asin(Math.max(-1, Math.min(1, ez))) * 180) / Math.PI };
}

const pad = (n: number, w: number, d = 0) => n.toFixed(d).padStart(w + (d ? d + 1 : 0), '0');
/** IAU-style "Jhhmmss.s+ddmmss" designation from a direction. */
export function jName(ra: number, dec: number): string {
  let s = (ra / 15) * 3600;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const sg = dec < 0 ? '−' : '+';
  let a = Math.abs(dec) * 3600;
  const dd = Math.floor(a / 3600); a -= dd * 3600;
  const dm = Math.floor(a / 60); a -= dm * 60;
  return `J${pad(h, 2)}${pad(m, 2)}${pad(Math.min(59.9, Math.floor(s * 10) / 10), 2, 1)}${sg}${pad(dd, 2)}${pad(dm, 2)}${pad(Math.min(59, Math.floor(a)), 2)}`;
}
/** "G312.441+01.203" style galactic designation, as used for nebulae. */
export function gName(l: number, b: number, digits = 3): string {
  return `G${l.toFixed(digits)}${b < 0 ? '−' : '+'}${Math.abs(b).toFixed(digits).padStart(digits + 3, '0')}`;
}
export function fmtRa(ra: number): string {
  let s = (ra / 15) * 3600;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${h}h ${pad(m, 2)}m ${pad(Math.floor(s), 2)}s`;
}
export function fmtDec(dec: number): string {
  let a = Math.abs(dec) * 3600;
  const d = Math.floor(a / 3600); a -= d * 3600;
  const m = Math.floor(a / 60); a -= m * 60;
  return `${dec < 0 ? '−' : '+'}${d}° ${pad(m, 2)}′ ${pad(Math.floor(a), 2)}″`;
}

// ---------------------------------------------------------------- formatting

export function fmtLy(ly: number): string {
  if (ly >= 1e6) return `${(ly / 1e6).toFixed(ly >= 1e7 ? 1 : 2)} million ly`;
  if (ly >= 100) return `${Math.round(ly).toLocaleString('en-US')} ly`;
  if (ly >= 1) return `${ly.toFixed(1)} ly`;
  return `${(ly * 63241).toFixed(0)} AU`;
}
export function fmtYears(y: number): string {
  if (y >= 1e9) return `${(y / 1e9).toFixed(y >= 1e10 ? 0 : 1)} billion years`;
  if (y >= 1e6) return `${(y / 1e6).toFixed(y >= 1e8 ? 0 : 1)} million years`;
  if (y >= 1e3) return `${Math.round(y / 1e3).toLocaleString('en-US')},000 years`;
  return `${Math.round(y)} years`;
}
export function sig(x: number, n = 2): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e5 || a < 1e-3) {
    const e = Math.floor(Math.log10(a));
    const m = x / Math.pow(10, e);
    return `${m.toFixed(n - 1)}×10${sup(e)}`;
  }
  return Number(x.toPrecision(n)).toLocaleString('en-US');
}
const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
export function sup(e: number): string { return String(e).split('').map((c) => SUP[c] ?? c).join(''); }
export function fmtW(w: number): string {
  const u: [number, string][] = [[1e24, 'YW'], [1e21, 'ZW'], [1e18, 'EW'], [1e15, 'PW'], [1e12, 'TW'], [1e9, 'GW'], [1e6, 'MW'], [1e3, 'kW']];
  for (const [k, s] of u) if (w >= k) return `${(w / k).toPrecision(3)} ${s}`;
  return `${w.toPrecision(3)} W`;
}
export function fmtKm(km: number): string {
  if (km >= 1e6) return `${(km / 1e6).toPrecision(3)} million km`;
  if (km >= 10) return `${Math.round(km).toLocaleString('en-US')} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round(km * 1000)} m`;
}
/** A whole number with thousands separators: 5,770 K, not 5.77K K. */
export function num(x: number): string { return Math.round(x).toLocaleString('en-US'); }
/** "a" or "an" before a word or designation: an M0 star, an S-type asteroid, an outpost, a K9 star. */
export function an(w: string): string {
  const t = w.trim();
  const vowel = /^[aeio]/i.test(t) || /^u(?!ni|se|sa|ro)/i.test(t);
  const letter = /^[AEFHILMNORSX](?=[^a-z]|$)/.test(t);
  return `${vowel || letter ? 'an' : 'a'} ${t}`;
}
export const L_SUN_W = 3.828e26;
export const G_SI = 6.674e-11;
export const AU_M = 1.496e11;
