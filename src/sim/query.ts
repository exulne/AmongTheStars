// A small, safe expression language for filtering settlements and deriving
// series: `stability < 0.3 && pop > 1M`, `gdp / pop`, `system ~ "centauri"`.
// Hand-written tokenizer and Pratt parser compiled to closures; never eval.
//
//   numbers   12  0.5  1e6  1_000  3k 2.5M 4B 1T
//   strings   "Mars"  'Tau Ceti'           (compare with == != ~ (contains))
//   operators ^  * / %  + -  < <= > >=  == != ~  && || !  (and / or / not)
//   functions abs sqrt log (base 10) ln exp min max floor ceil round pow if(c, a, b)

import { STAGE_NAMES } from './catalog.ts';
import { F, GLOBAL_METRICS, GM, NGM, SETTLEMENT_FIELDS } from './metrics.ts';
import type { World } from './world.ts';

export type Val = number | string;
export type Getter<R> = (r: R) => Val;
export type Binder<R> = (name: string) => Getter<R> | null;

export class QueryError extends Error {
  pos: number;
  constructor(msg: string, pos: number) { super(msg); this.pos = pos; }
}

type Tok = { k: 'num'; v: number; p: number } | { k: 'str'; v: string; p: number } | { k: 'id'; v: string; p: number } | { k: 'op'; v: string; p: number } | { k: 'end'; p: number };

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, G: 1e9, T: 1e12 };
const OPS = ['&&', '||', '==', '!=', '<=', '>=', '**', '<', '>', '+', '-', '*', '/', '%', '^', '!', '(', ')', ',', '~', '='];
const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d[\d_]*\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new QueryError(`Unexpected "${c}"`, i);
      let v = Number(m[0].replace(/_/g, ''));
      let len = m[0].length;
      const s = src[i + len];
      if (s && SUFFIX[s] && !/[A-Za-z0-9_]/.test(src[i + len + 1] ?? '')) { v *= SUFFIX[s]; len++; }
      out.push({ k: 'num', v, p: i });
      i += len;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new QueryError('Unclosed string', i);
      out.push({ k: 'str', v: src.slice(i + 1, j), p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const w = m[0];
      if (WORD_OPS[w.toLowerCase()]) out.push({ k: 'op', v: WORD_OPS[w.toLowerCase()], p: i });
      else out.push({ k: 'id', v: w, p: i });
      i += w.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new QueryError(`Unexpected "${c}"`, i);
    out.push({ k: 'op', v: op === '**' ? '^' : op === '=' ? '==' : op, p: i });
    i += op.length;
  }
  out.push({ k: 'end', p: src.length });
  return out;
}

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; name: string; p: number }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[]; p: number };

const BP: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '~': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8 };

function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const expect = (v: string) => {
    const t = take();
    if (t.k !== 'op' || t.v !== v) throw new QueryError(`Expected "${v}"`, t.p);
  };
  const prefix = (): Node => {
    const t = take();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'id') {
      const n = peek();
      if (n.k === 'op' && n.v === '(') {
        take();
        const args: Node[] = [];
        if (!(peek().k === 'op' && (peek() as { v: string }).v === ')')) {
          for (;;) { args.push(expr(0)); const s = peek(); if (s.k === 'op' && s.v === ',') { take(); continue; } break; }
        }
        expect(')');
        return { t: 'call', fn: t.v.toLowerCase(), args, p: t.p };
      }
      return { t: 'var', name: t.v, p: t.p };
    }
    if (t.k === 'op' && t.v === '(') { const e = expr(0); expect(')'); return e; }
    if (t.k === 'op' && (t.v === '-' || t.v === '!' || t.v === '+')) return { t: 'un', op: t.v, a: expr(7) };
    if (t.k === 'end') throw new QueryError('Unexpected end of expression', t.p);
    throw new QueryError(`Unexpected "${'v' in t ? t.v : ''}"`, t.p);
  };
  const expr = (min: number): Node => {
    let left = prefix();
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || BP[t.v] === undefined) break;
      const bp = BP[t.v];
      if (bp <= min) break;
      take();
      left = { t: 'bin', op: t.v, a: left, b: expr(t.v === '^' ? bp - 1 : bp) }; // ^ is right-associative
    }
    return left;
  };
  const root = expr(0);
  const end = peek();
  if (end.k !== 'end') throw new QueryError(`Unexpected "${'v' in end ? end.v : ''}"`, end.p);
  return root;
}

const FNS: Record<string, [number, number, (...a: number[]) => number]> = {
  abs: [1, 1, Math.abs], sqrt: [1, 1, Math.sqrt], log: [1, 1, Math.log10], log10: [1, 1, Math.log10], ln: [1, 1, Math.log],
  exp: [1, 1, Math.exp], floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil], round: [1, 1, Math.round],
  min: [1, 16, Math.min], max: [1, 16, Math.max], pow: [2, 2, Math.pow],
};

const num = (v: Val) => (typeof v === 'number' ? v : NaN);
const truthy = (v: Val) => (typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : v.length > 0);

function build<R>(n: Node, bind: Binder<R>, vars: Set<string>): Getter<R> {
  switch (n.t) {
    case 'num': { const v = n.v; return () => v; }
    case 'str': { const v = n.v; return () => v; }
    case 'var': {
      const g = bind(n.name);
      if (!g) throw new QueryError(`Unknown field "${n.name}"`, n.p);
      vars.add(n.name);
      return g;
    }
    case 'un': {
      const a = build(n.a, bind, vars);
      if (n.op === '-') return (r) => -num(a(r));
      if (n.op === '+') return (r) => num(a(r));
      return (r) => (truthy(a(r)) ? 0 : 1);
    }
    case 'call': {
      if (n.fn === 'if') {
        if (n.args.length !== 3) throw new QueryError('if(condition, then, else) takes three arguments', n.p);
        const [c, a, b] = n.args.map((x) => build(x, bind, vars));
        return (r) => (truthy(c(r)) ? a(r) : b(r));
      }
      const f = FNS[n.fn];
      if (!f) throw new QueryError(`Unknown function "${n.fn}"`, n.p);
      if (n.args.length < f[0] || n.args.length > f[1]) throw new QueryError(`${n.fn}() takes ${f[0] === f[1] ? f[0] : `${f[0]}–${f[1]}`} argument${f[1] > 1 ? 's' : ''}`, n.p);
      const args = n.args.map((x) => build(x, bind, vars));
      const fn = f[2];
      if (args.length === 1) { const a = args[0]; return (r) => fn(num(a(r))); }
      return (r) => fn(...args.map((a) => num(a(r))));
    }
    case 'bin': {
      const a = build(n.a, bind, vars), b = build(n.b, bind, vars);
      switch (n.op) {
        case '+': return (r) => num(a(r)) + num(b(r));
        case '-': return (r) => num(a(r)) - num(b(r));
        case '*': return (r) => num(a(r)) * num(b(r));
        case '/': return (r) => num(a(r)) / num(b(r));
        case '%': return (r) => num(a(r)) % num(b(r));
        case '^': return (r) => Math.pow(num(a(r)), num(b(r)));
        case '<': return (r) => (num(a(r)) < num(b(r)) ? 1 : 0);
        case '<=': return (r) => (num(a(r)) <= num(b(r)) ? 1 : 0);
        case '>': return (r) => (num(a(r)) > num(b(r)) ? 1 : 0);
        case '>=': return (r) => (num(a(r)) >= num(b(r)) ? 1 : 0);
        case '==': return (r) => (eq(a(r), b(r)) ? 1 : 0);
        case '!=': return (r) => (eq(a(r), b(r)) ? 0 : 1);
        case '~': return (r) => (String(a(r)).toLowerCase().includes(String(b(r)).toLowerCase()) ? 1 : 0);
        case '&&': return (r) => (truthy(a(r)) && truthy(b(r)) ? 1 : 0);
        case '||': return (r) => (truthy(a(r)) || truthy(b(r)) ? 1 : 0);
      }
    }
  }
  throw new QueryError('Bad expression', 0);
}

function eq(x: Val, y: Val): boolean {
  if (typeof x === 'string' || typeof y === 'string') return String(x).toLowerCase() === String(y).toLowerCase();
  return x === y;
}

export interface Compiled<R> { src: string; vars: string[]; value: (r: R) => number; test: (r: R) => boolean }

/** Compile an expression against a set of named fields. Throws QueryError (with a character position). */
export function compile<R>(src: string, bind: Binder<R>): Compiled<R> {
  if (!src.trim()) throw new QueryError('Empty expression', 0);
  const vars = new Set<string>();
  const g = build(parse(src), bind, vars);
  return { src, vars: [...vars], value: (r) => num(g(r)), test: (r) => truthy(g(r)) };
}

/** Like compile, but returns the error instead of throwing. */
export function tryCompile<R>(src: string, bind: Binder<R>): Compiled<R> | QueryError {
  try { return compile(src, bind); } catch (e) { return e instanceof QueryError ? e : new QueryError(String(e), 0); }
}

// ---------------------------------------------------------------- settlements

/** One settlement (body b) at one moment: its fields are S[o], S[o + 1], ... (o = b * NF in a full state). */
export interface PlaceRow { S: Float64Array; b: number; o: number; year: number }

const ALIASES: Record<string, string> = { faith: 'culture', population: 'pop', people: 'pop', loyal: 'allegiance', ruler: 'allegiance' };

/** Extra per-place columns beyond SETTLEMENT_FIELDS, with what they mean. */
export const PLACE_EXTRAS: [string, string][] = [
  ['name', 'name of the world'], ['system', 'star system name'], ['allegiance', 'name of the capital it answers to (capital is its capital stock in $)'], ['stageName', 'stage as a word'],
  ['kind', 'kind of world'], ['dist', 'light years from the Sun'], ['sys', 'star system id'], ['id', 'body id'],
  ['age', 'years since founded'], ['independent', '1 if it is its own capital'], ['hab', 'habitability 0–1'], ['g', 'surface gravity'],
  ['temp', 'temperature (K)'], ['faith', 'same as culture'], ['year', 'years after 2040'],
];

export function placeBinder(world: World): Binder<PlaceRow> {
  const B = world.bodies, Sy = world.systems;
  return (raw) => {
    const name = ALIASES[raw] ?? raw;
    const k = (SETTLEMENT_FIELDS as readonly string[]).indexOf(name);
    if (k >= 0) return (r) => r.S[r.o + k];
    switch (name) {
      case 'name': return (r) => B[r.b].name;
      case 'system': return (r) => Sy[B[r.b].system].name;
      case 'allegiance': return (r) => B[r.S[r.o + F.faction]]?.name ?? '';
      case 'stageName': return (r) => STAGE_NAMES[r.S[r.o + F.stage]] ?? '';
      case 'kind': return (r) => B[r.b].kind;
      case 'dist': return (r) => Sy[B[r.b].system].dist;
      case 'sys': return (r) => B[r.b].system;
      case 'id': return (r) => r.b;
      case 'age': return (r) => r.year - r.S[r.o + F.founded];
      case 'independent': return (r) => (r.S[r.o + F.faction] === r.b ? 1 : 0);
      case 'hab': return (r) => B[r.b].hab;
      case 'g': return (r) => B[r.b].g;
      case 'temp': return (r) => B[r.b].temp;
      case 'year': return (r) => r.year;
    }
    return null;
  };
}

// ---------------------------------------------------------------- global series

export interface GlobalRow { series: Float64Array; i: number; year: number }

export function globalBinder(): Binder<GlobalRow> {
  return (name) => {
    const col = GM[name];
    if (col !== undefined) return (r) => r.series[r.i * NGM + col];
    if (name === 'year') return (r) => r.year;
    return null;
  };
}

export const GLOBAL_NAMES = [...GLOBAL_METRICS.map((m) => m.key), 'year'];
export const PLACE_NAMES = [...SETTLEMENT_FIELDS, ...PLACE_EXTRAS.map(([k]) => k)];
