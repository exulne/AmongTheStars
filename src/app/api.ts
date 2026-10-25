// The shared surface the feature modules in src/features install against: the
// app's long-lived objects, plus main.ts's mutable state reached through
// functions so nothing captured at install time goes stale.

import type { SimClient } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import type { Inspector } from '../ui/inspector.ts';
import type { Search } from '../ui/search.ts';
import type { Timeline } from '../ui/timeline.ts';
import type { StreetView } from '../view/street.ts';
import type { ShipRec } from '../explain/ships.ts';
import type { Ctx, Level, Pickable, Ref } from '../view/views.ts';

export interface AppApi {
  app: HTMLElement;
  world: World;
  sim: SimClient;
  ctx: Ctx;
  timeline: Timeline;
  inspector: Inspector;
  street: StreetView;
  naming: typeof import('../ui/names.ts').names;
  search: Search;
  seedInput: HTMLInputElement;

  level(): Level;
  runGen(): number;
  pendingYear(): number | null;
  setPendingYear(y: number | null): void;
  pull(): Ref | null;
  setPull(r: Ref | null): void;

  seekTo(y: number, b?: number): void;
  select(p: Pickable | null): void;
  asPick(r: Ref): Pickable;
  setLevel(next: Level, focus?: Ref | null, prep?: () => void, animate?: boolean): void;
  startRun(seed: number): void;
  shipId(s: ShipRec): number;
}
