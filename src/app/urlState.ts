// Extra key=value tokens in the location hash, registered by features. main.ts's
// hash is `-`-separated, so a part's value is percent-encoded and `-` becomes
// %2D; with nothing registered the written hash is byte-identical to before.

export interface UrlPart {
  key: string;
  /** The token's value, or null to leave the part out of this hash. */
  write(): string | null;
  /** The decoded value from a link being opened. */
  read(value: string): void;
}

const parts = new Map<string, UrlPart>();
let writer: (() => void) | null = null;

// token shapes readHash already owns: future<n>, y<year>, l<level>, p<pid>,
// [bsghc]<id>, x<ex>.<id>, plus the micro scale (m...) and the build stamp (r...)
const RESERVED = new Set(['future', 'y', 'l', 'p', 'b', 's', 'g', 'h', 'c', 'x', 'm', 'r']);

export function registerUrlPart(p: UrlPart): void {
  if (!/^[a-z]+$/.test(p.key)) throw new Error(`url part "${p.key}": key must match /^[a-z]+$/`);
  if (RESERVED.has(p.key)) throw new Error(`url part "${p.key}": collides with an existing hash token`);
  if (parts.has(p.key)) throw new Error(`url part "${p.key}": already registered`);
  parts.set(p.key, p);
}

const enc = (v: string): string => encodeURIComponent(v).replace(/-/g, '%2D');

export function urlPartTokens(): string[] {
  const out: string[] = [];
  for (const [key, p] of parts) {
    const v = p.write();
    if (v !== null) out.push(`${key}=${enc(v)}`);
  }
  return out;
}

/** Feed the registered parts their values from a hash just opened. */
export function applyUrlParts(hash: string): void {
  for (const tok of hash.split('-')) {
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    const p = parts.get(tok.slice(0, eq));
    if (p) p.read(decodeURIComponent(tok.slice(eq + 1)));
  }
}

/** Who writes the hash (main.ts's writeHash); parts ask for a rewrite through here. */
export function setHashWriter(fn: () => void): void { writer = fn; }
export function requestHashWrite(): void { writer?.(); }
