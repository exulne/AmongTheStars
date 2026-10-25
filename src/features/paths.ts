// "What leads to…?": name a moment in the timeline and see the futures that
// reach it. The paths rail and the life picker share the same dock, so this
// installs against the follow handle. Lives where the block used to in main.ts.

import { Voice } from '../ship/voice.ts';
import { OracleAgent } from '../ship/agent.ts';
import { FuturePaths } from '../ui/futurePaths.ts';
import { toolSummary } from '../sim/milestones.ts';
import type { AppApi } from '../app/api.ts';
import type { FollowHandle } from './follow.ts';

export interface PathsHandle {
  paths: FuturePaths;
  /** Fly the screen into a future at a calendar year; with play, run time from ~40y before up to it. */
  showFuture(seed: number, calYear: number, o?: { body?: number; system?: number; play?: boolean }): void;
}

export function installPaths(api: AppApi, follow: FollowHandle): PathsHandle {
  const pathsVoice = new Voice();
  let pathsLinked = false, pathsWatch = 0;
  api.app.querySelector('#lifepick')!.insertAdjacentHTML('afterend', '<button id="paths" class="link" type="button" aria-expanded="false" title="Name a moment in the timeline and see the futures that reach it">What leads to…?</button>');
  const pathsBtn = api.app.querySelector<HTMLButtonElement>('#paths')!;
  const paths = new FuturePaths({
    world: api.world, seed: () => api.sim.seed, voice: pathsVoice,
    connect: () => { if (!pathsLinked) { pathsLinked = true; void pathsVoice.connect(); } },
    show: showFuture,
  });
  api.app.append(paths.el);
  // the paths rail and the life picker share the same dock: only one is open at a time
  paths.onToggle = (on) => { pathsBtn.setAttribute('aria-expanded', String(on)); if (on) follow.lifePick.hide(); };
  pathsBtn.addEventListener('click', () => paths.toggle());
  follow.lifePickBtn.addEventListener('click', () => paths.hide());

  /** Fly the screen into a future at a calendar year; with play, run time from ~40y before up to it. */
  function showFuture(seed: number, calYear: number, o: { body?: number; system?: number; play?: boolean } = {}): void {
    const y = Math.max(0, Math.min(calYear - 2040, 10000)), from = o.play ? Math.max(0, y - 40) : y;
    api.setPull(null);
    cancelAnimationFrame(pathsWatch);
    if (seed !== api.sim.seed) { api.seedInput.value = String(seed); api.startRun(seed); }
    const g = api.runGen();
    api.seekTo(from);
    if (o.body !== undefined && o.body >= 0) api.search.onPick({ kind: 'body', id: o.body, name: api.world.bodies[o.body].name, sub: '' });
    else if (o.system !== undefined) api.search.onPick({ kind: 'system', id: o.system, name: api.world.systems[o.system].name, sub: '' });
    if (!o.play) return;
    let started = false;
    const watch = () => {
      if (g !== api.runGen()) return;   // the user switched future
      if (!started) {
        if (api.pendingYear() !== null || api.ctx.year < from - 0.5) { pathsWatch = requestAnimationFrame(watch); return; }
        if (api.timeline.frontier <= api.ctx.year + 1) { pathsWatch = requestAnimationFrame(watch); return; }   // playing at the frontier would jump back to year 0
        started = true;
        if (!api.timeline.playing) api.timeline.toggle();
      } else if (!api.timeline.playing) return;   // the user paused: hands off
      if (api.ctx.year >= y) { if (api.timeline.playing) api.timeline.toggle(); return; }
      pathsWatch = requestAnimationFrame(watch);
    };
    pathsWatch = requestAnimationFrame(watch);
  }

  paths.setAgent(new OracleAgent(import.meta.env.VITE_ELEVEN_AGENT_ID || null, {
    // tool arguments come from the LLM: coerce them before they reach the sim
    find_futures: async ({ goal }) => {
      const r = await paths.ask(String(goal ?? ''));
      return 'error' in r ? `${r.error} Try: ${r.suggestions.join(', ')}.` : toolSummary(r.chain, r.results, r.tried);
    },
    watch_future: async ({ future, year }) => {
      const f = Math.trunc(Number(future)), y = year == null ? undefined : Math.round(Number(year));
      if (!(f >= 1) || (y !== undefined && !Number.isFinite(y))) throw new Error(`No future ${future}${year == null ? '' : ` at ${year}`}.`);
      paths.watch(f, y);
      return y ? `Showing future ${f} in ${y}.` : `Playing future ${f} up to the goal.`;
    },
  }));

  return { paths, showFuture };
}
