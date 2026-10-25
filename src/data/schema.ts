// A small runtime validator for snapshot files and adapter output: shape
// checks with readable paths, no dependency. Missing optional fields stay
// undefined; a wrong type is an error, never a silent default.

export type Check<T> = (v: unknown, path: string) => T;

export class SchemaError extends Error {
  path: string;
  constructor(path: string, msg: string) { super(`${path}: ${msg}`); this.path = path; }
}

const fail = (path: string, msg: string): never => { throw new SchemaError(path, msg); };

export const num: Check<number> = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(p, `expected a finite number, got ${JSON.stringify(v)}`));
export const str: Check<string> = (v, p) => (typeof v === 'string' ? v : fail(p, `expected a string, got ${typeof v}`));
export const bool: Check<boolean> = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'expected a boolean'));

/** A number written as a string (JPL APIs), or null/'' when missing. */
export const numStr: Check<number | null> = (v, p) => {
  // JPL writes some missing values as the string "NaN": a gap, not a number
  if (v === null || v === undefined || v === '' || v === 'NaN') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : fail(p, `expected a numeric string, got ${JSON.stringify(v)}`);
};

export function oneOf<T extends string>(xs: readonly T[]): Check<T> {
  return (v, p) => (xs.includes(v as T) ? (v as T) : fail(p, `expected one of ${xs.join('|')}, got ${JSON.stringify(v)}`));
}

export function opt<T>(c: Check<T>): Check<T | undefined> {
  return (v, p) => (v === undefined || v === null ? undefined : c(v, p));
}

export function arr<T>(c: Check<T>, min = 0): Check<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) fail(p, 'expected an array');
    const a = v as unknown[];
    if (a.length < min) fail(p, `expected at least ${min} items, got ${a.length}`);
    return a.map((x, i) => c(x, `${p}[${i}]`));
  };
}

export function obj<S extends Record<string, Check<unknown>>>(shape: S): Check<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'expected an object');
    const o = v as Record<string, unknown>, out: Record<string, unknown> = {};
    for (const k in shape) out[k] = shape[k](o[k], `${p}.${k}`);
    return out as { [K in keyof S]: ReturnType<S[K]> };
  };
}

export function record<T>(c: Check<T>): Check<Record<string, T>> {
  return (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'expected an object');
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = c(x, `${p}.${k}`);
    return out;
  };
}

/** Validate, or return the error instead of throwing. */
export function tryCheck<T>(c: Check<T>, v: unknown, path = '$'): { ok: true; value: T } | { ok: false; error: string } {
  try { return { ok: true, value: c(v, path) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}
