// Pick one person out of this future and follow their whole life: the picker
// panel off the header, and the camera that shadows their pathway as time
// moves. Installed where the block used to live in main.ts.

import type { Biography } from '../sim/lives.ts';
import type { Level, Ref } from '../view/views.ts';
import { LifePick } from '../ui/lifePick.ts';
import type { AppApi } from '../app/api.ts';

export interface FollowHandle {
  lifePick: LifePick;
  lifePickBtn: HTMLButtonElement;
  /** Where they are at year y → where the camera goes. A no-op once in place. */
  followYear(y: number): void;
  stopFollow(): void;
  /** The person whose pathway the camera is shadowing, if any. */
  following(): { pid: string; name: string; path: Biography['path']; idx: number } | null;
  /** Call `cb` whenever the life picker opens (only then: not on "Stop following"). */
  onPickerOpen(cb: () => void): void;
}

export function installFollow(api: AppApi): FollowHandle {
  const lifePick = new LifePick({
    bodies: () => api.sim.birthPlaces(),
    home: api.world.earth,
    nameOf: (b) => api.naming.place(api.world, b),
    year: () => api.ctx.year,
    find: (b, n, k, y, w) => api.sim.findPerson(b, n, k, y, w),
    // a beat of the life being followed moves the year only and brings the camera back to them;
    // any other beat goes to its year and selects its world
    seek: (y, b, pid) => { if (following && pid === following.pid) { resume(false); api.seekTo(y); } else api.seekTo(y, b); },
    open: (pid) => { api.inspector.openPerson(pid); api.inspector.el.classList.add('open'); startFollow(pid); },
  });
  api.app.append(lifePick.el);
  const lifePickBtn = api.app.querySelector<HTMLButtonElement>('#lifepick')!;
  const pickerOpen: (() => void)[] = [];
  lifePick.onToggle = (on) => { lifePickBtn.setAttribute('aria-expanded', String(on)); if (on) for (const cb of pickerOpen) cb(); };
  lifePickBtn.addEventListener('click', () => { if (following) stopFollow(); else lifePick.toggle(); });
  // shown while a hand has the camera: one click takes it back to them
  const backBtn = document.createElement('button');
  backBtn.id = 'followback';
  backBtn.className = 'link';
  backBtn.type = 'button';
  backBtn.hidden = true;
  backBtn.addEventListener('click', () => resume(true));

  // ------------------------------------------------------------------ following one life

  /** The person whose pathway the camera is shadowing, if any. */
  let following: { pid: string; name: string; path: Biography['path']; idx: number } | null = null;
  /** A hand move (wheel, crumbs, search, a click on something else) pauses the camera; following goes on. */
  let suspended = false;
  /** Where the camera was last put for them; when a level change of ours was asked for (0 once it has
   *  switched); and whether that switch is still settling (entering a level can reselect, and that's ours). */
  let placed: { level: Level; body?: number; pull?: Ref } | null = null, flying = 0, switching = false;
  /** Looks for a hand move between year changes too, so "Back to <name>" shows as soon as the camera is taken. */
  let watch = 0;
  /** The selection when the camera last took them on: any other one is a hand's. */
  let selBase = '';
  const selKey = (): string => { const s = api.ctx.selected; return s ? `${s.kind}:${s.ex ?? ''}:${s.id}` : ''; };

  /** The camera takes them on afresh: nothing placed, nothing flying, the current selection as the baseline. */
  function reset(): void {
    suspended = false; placed = null; flying = 0; switching = false;
    api.setPull(null);
    selBase = selKey();
    backBtn.hidden = true;
  }

  function stopFollow(): void {
    if (!following) return;
    following = null;
    clearInterval(watch);
    reset();
    api.street.followPid = null;
    lifePickBtn.textContent = 'Follow a life';
    lifePickBtn.setAttribute('aria-pressed', 'false');
  }

  /** A hand moved the camera: leave it there, keep following, and offer the way back. */
  function suspend(): void {
    if (!following || suspended) return;
    suspended = true;
    if (placed?.pull && api.pull() === placed.pull) api.setPull(null);
    backBtn.textContent = `Back to ${following.name}`;
    backBtn.hidden = false;
    lifePickBtn.after(backBtn);
  }

  /** Give the camera back to them (reopening their card if a selection closed it); with `go`, now. */
  function resume(go: boolean): void {
    if (!following) return;
    const was = suspended;
    reset();
    following.idx = -1;
    if (was && api.inspector.personId !== following.pid) { api.inspector.openPerson(following.pid); api.inspector.el.classList.add('open'); }
    if (go) followYear(api.ctx.year);
  }

  /** Read their whole path once, then track them through it as time moves. */
  async function startFollow(pid: string): Promise<void> {
    const g = api.runGen();
    const m = await api.sim.person(pid, api.ctx.year);
    if (g !== api.runGen() || api.inspector.personId !== pid || !m.bio?.path.length) return;
    following = { pid, name: m.bio.name, path: m.bio.path, idx: -1 };
    reset();
    clearInterval(watch);
    watch = window.setInterval(() => { if (following && !suspended && handMoved()) suspend(); }, 250);
    api.street.followPid = pid;
    lifePickBtn.textContent = 'Stop following';
    lifePickBtn.setAttribute('aria-pressed', 'true');
    followYear(api.ctx.year);
  }

  /** The next stop of theirs with solid ground under it. */
  function nextStop(path: Biography['path'], i: number): number | undefined {
    for (let j = i; j < path.length; j++) if (path[j].body !== null) return path[j].body!;
    return undefined;
  }

  /** Did a hand move the camera, or select something, since the camera last took them on? */
  function handMoved(): boolean {
    if (switching) return false;
    if (selKey() !== selBase) return true;
    if (flying) {
      if (performance.now() - flying < 4000) return false;   // our own level change, still on its way (a dropped one gives up after 4 s)
      flying = 0;
    }
    const pull = api.pull();
    if (pull && pull !== placed?.pull) return true;   // a wheel pulling something else in
    if (!placed) return false;
    return api.level() !== placed.level || (placed.body !== undefined && api.ctx.body !== placed.body) || (placed.pull !== undefined && pull !== placed.pull);
  }

  /** The camera's own level change, remembered so it is never mistaken for a hand's. */
  function go(level: Level, focus: Ref | null, body?: number, prep?: () => void): void {
    placed = { level, body };
    flying = performance.now();
    // the switch ends once enterLevel (and anything it selects) has run: then read the selection afresh
    api.setLevel(level, focus, () => { prep?.(); flying = 0; switching = true; queueMicrotask(() => { switching = false; selBase = selKey(); }); });
  }

  /** Where they are at year y → where the camera goes. A no-op once in place, or while a hand has the camera. */
  function followYear(y: number): void {
    if (!following || !api.sim.years.length || suspended) return;
    if (handMoved()) { suspend(); return; }
    if (flying) return;   // our own level change is still on its way
    const p = following.path;
    let idx = p.findIndex((s) => y < (s.to ?? Infinity));
    if (idx < 0) idx = p.length - 1;               // after death: linger where they ended
    const s = p[idx];
    following.idx = idx;
    if (s.body !== null && api.world.bodies[s.body]) {
      const b = s.body;
      api.setPull(null);
      if (api.level() === 'street' && api.ctx.body !== b) { api.ctx.body = b; api.ctx.system = api.world.bodies[b].system; api.ctx.city = 0; go('street', { kind: 'city', id: 0 }, b); }
      else if (api.level() !== 'street') go('street', { kind: 'city', id: 0 }, b, () => { api.ctx.body = b; api.ctx.system = api.world.bodies[b].system; api.ctx.city = 0; });
      else placed = { level: 'street', body: b };
      return;
    }
    // mid-voyage (or lost): if their ship is drawn among the stars, shadow the ship itself
    const rec = s.ship && api.ctx.snap ? api.ctx.snap.ships.find((sh) => sh.kind !== 1 && sh.from === s.ship!.from && sh.to === s.ship!.to && Math.abs(sh.depart - s.ship!.depart) < 0.6) : undefined;
    if (rec) {
      // pull tracks whatever it points at every frame; the ship head appears once the view syncs
      const ref: Ref = { kind: 'thing', ex: 'shipl', id: api.shipId(rec) };
      if (api.level() !== 'local') go('local', null);
      api.setPull(ref);
      placed = { level: 'local', pull: ref };
      return;
    }
    // an untrackable leg — a warp hop, or a ship already gone: wait at the world they're bound for
    api.setPull(null);
    const anchor = (s.ship && api.world.bodies[s.ship.to]) ? s.ship.to : nextStop(p, idx);
    if (anchor === undefined) return;
    if (api.level() !== 'planet' || api.ctx.body !== anchor) go('planet', { kind: 'body', id: anchor }, anchor, () => { api.ctx.body = anchor; api.ctx.system = api.world.bodies[anchor].system; });
    else placed = { level: 'planet', body: anchor };
  }

  api.inspector.onFollow = (pid) => { api.inspector.el.classList.add('open'); startFollow(pid); };
  // only opening someone else ends a follow; closing their card (any new selection does) doesn't
  api.inspector.onPerson = (id) => { if (following && id !== null && id !== following.pid) stopFollow(); };

  return { lifePick, lifePickBtn, followYear, stopFollow, following: () => following, onPickerOpen: (cb) => { pickerOpen.push(cb); } };
}
