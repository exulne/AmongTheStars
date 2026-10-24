// Number formatting for people, watts, dollars and tonnes.

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc'];

export function fmtNum(x: number, digits = 3): string {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a < 1000) return a < 10 && a % 1 !== 0 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US');
  const k = Math.min(SUFFIX.length - 1, Math.floor(Math.log10(a) / 3));
  if (k === SUFFIX.length - 1 && a >= 1e30) return x.toExponential(2);
  return (x / 10 ** (k * 3)).toPrecision(digits) + SUFFIX[k];
}

const SI = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
export function fmtSI(x: number, unit: string): string {
  if (!isFinite(x) || x === 0) return `0 ${unit}`;
  const k = Math.max(0, Math.min(SI.length - 1, Math.floor(Math.log10(Math.abs(x)) / 3)));
  return `${(x / 10 ** (k * 3)).toPrecision(3)} ${SI[k]}${unit}`;
}

export function fmtUnit(x: number, unit: string): string {
  if (unit === 'W') return fmtSI(x, 'W');
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
