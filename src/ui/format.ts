// Number formatting for people, watts, dollars and tonnes.

// Words people know up to trillions; past that, scientific notation rather than Qa, Sx or ronna.
const SUFFIX = ['', 'K', 'M', 'B', 'T'];
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** 4.0 × 10²⁸ */
export function fmtSci(x: number, digits = 2): string {
  const e = Math.floor(Math.log10(Math.abs(x)));
  const m = x / 10 ** e;
  return `${m.toPrecision(digits)} × 10${String(e).replace('-', '⁻').replace(/\d/g, (d) => SUP[Number(d)])}`;
}

export function fmtNum(x: number, digits = 3): string {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a < 1000) return a < 10 && a % 1 !== 0 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US');
  if (a >= 1e15) return fmtSci(x);
  const k = Math.floor(Math.log10(a) / 3);
  return (x / 10 ** (k * 3)).toPrecision(digits) + SUFFIX[k];
}

const SI = ['', 'k', 'M', 'G', 'T'];
export function fmtSI(x: number, unit: string): string {
  if (!isFinite(x) || x === 0) return `0 ${unit}`;
  if (Math.abs(x) >= 1e15) return `${fmtSci(x)} ${unit}`;
  const k = Math.max(0, Math.min(SI.length - 1, Math.floor(Math.log10(Math.abs(x)) / 3)));
  return `${(x / 10 ** (k * 3)).toPrecision(3)} ${SI[k]}${unit}`;
}

const SUN_W = 3.828e26;
/** Power with a yardstick once it is star-sized: "4.0 × 10²⁸ W (≈100× the Sun)". */
export function fmtPower(x: number): string {
  const r = x / SUN_W;
  if (r < 1e-3) return fmtSI(x, 'W');
  return `${fmtSI(x, 'W')} (≈${r >= 1 ? `${fmtNum(r, 2)}× the Sun` : `${(r * 100).toPrecision(2)}% of the Sun`})`;
}

export function fmtUnit(x: number, unit: string): string {
  if (unit === 'W') return fmtPower(x);
  if (unit === '$/yr') return `$${fmtNum(x)}/yr`;
  if (unit === '$') return `$${fmtNum(x)}`;
  if (unit === 't' || unit === 't/yr') return `${fmtNum(x)} ${unit}`;
  if (unit === 'ly') return `${fmtNum(x)} ly`;
  if (unit === '%') return `${x.toFixed(2)}%`;
  if (unit === 'K') return `K ${x.toFixed(3)}`;
  if (unit === '' || unit === 'idx' || unit === '×') return x < 10 && x % 1 !== 0 ? x.toFixed(3) : fmtNum(x);
  if (unit === 'yr') return `${x.toFixed(1)} yr`;
  return `${fmtNum(x)} ${unit}`;
}

export function fmtYear(y: number): string {
  return String(Math.round(2040 + y));
}

/** "2.56B", "40M", "12k", "1,234" → a whole number; NaN if it isn't one. */
export function parseCount(s: string): number {
  const m = s.trim().toLowerCase().replace(/[,_\s]/g, '').match(/^#?(\d*\.?\d+)([kmbt]?)$/);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 } as Record<string, number>)[m[2]]);
}
