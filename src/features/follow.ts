// Pick one person out of this future and follow their whole life: the picker
// panel off the header, and the camera that shadows their pathway as time
// moves. Installed where the block used to live in main.ts.

import type { Biography } from '../sim/lives.ts';
import type { Ref } from '../view/views.ts';
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
}

export function installFollow(api: AppApi): FollowHandle {
  const lifePick = new LifePick({
    bodies: () => api.sim.birthPlaces(),
    home: api.world.earth,
    nameOf: (b) => api.naming.place(api.world, b),
    year: () => api.ctx.year,
    find: (b, n, k, y, w) => api.sim.findPerson(b, n, k, y, w),
    seek: api.seekTo,
    open: (pid) => { api.inspector.openPerson(pid); api.inspector.el.classList.add('open'); startFollow(pid); },
  });
  api.app.append(lifePick.el);
  const lifePickBtn = api.app.querySelector<HTMLButtonElement>('#lifepick')!;
  lifePick.onToggle = (on) => lifePickBtn.setAttribute('aria-expanded', String(on));
  lifePickBtn.addEventListener('click', () => { if (following) stopFollow(); else lifePick.toggle(); });

  // ------------------------------------------------------------------ following one life

  /** The person whose pathway the camera is shadowing, if any. */
  let following: { pid: string; name: string; path: Biography['path']; idx: number } | null = null;

  function stopFollow(): void {
    if (!following) return;
    following = null;
    api.street.followPid = null;
    api.setPull(null);
    lifePickBtn.textContent = 'Follow a life';
    lifePickBtn.setAttribute('aria-pressed', 'false');
  }

  /** Read their whole path once, then track them through it as time moves. */
  async function startFollow(pid: string): Promise<void> {
    const g = api.runGen();
    const m = await api.sim.person(pid, api.ctx.year);
    if (g !== api.runGen() || api.inspector.personId !== pid || !m.bio?.path.length) return;
    following = { pid, name: m.bio.name, path: m.bio.path, idx: -1 };
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

  /** Where they are at year y → where the camera goes. A no-op once in place. */
  function followYear(y: number): void {
    if (!following || !api.sim.years.length) return;
    const p = following.path;
    let idx = p.findIndex((s) => y < (s.to ?? Infinity));
    if (idx < 0) idx = p.length - 1;               // after death: linger where they ended
    const s = p[idx];
    const moved = idx !== following.idx;
    following.idx = idx;
    if (s.body !== null && api.world.bodies[s.body]) {
      api.setPull(null);
      if (moved || api.level() !== 'street' || api.ctx.body !== s.body) {
        const b = s.body;
        if (api.level() === 'street' && api.ctx.body !== b) { api.ctx.body = b; api.ctx.system = api.world.bodies[b].system; api.ctx.city = 0; api.setLevel('street', { kind: 'city', id: 0 }); }
        else if (api.level() !== 'street') api.setLevel('street', { kind: 'city', id: 0 }, () => { api.ctx.body = b; api.ctx.system = api.world.bodies[b].system; api.ctx.city = 0; });
      }
      return;
    }
    // mid-voyage (or lost): if their ship is drawn among the stars, shadow the ship itself
    const rec = s.ship && api.ctx.snap ? api.ctx.snap.ships.find((sh) => sh.kind !== 1 && sh.from === s.ship!.from && sh.to === s.ship!.to && Math.abs(sh.depart - s.ship!.depart) < 0.6) : undefined;
    if (rec) {
      // pull tracks whatever it points at every frame; the ship head appears once the view syncs
      const ref: Ref = { kind: 'thing', ex: 'shipl', id: api.shipId(rec) };
      if (api.level() !== 'local') api.setLevel('local');
      api.setPull(ref);
      return;
    }
    // an untrackable leg — a warp hop, or a ship already gone: wait at the world they're bound for
    api.setPull(null);
    const anchor = (s.ship && api.world.bodies[s.ship.to]) ? s.ship.to : nextStop(p, idx);
    if (anchor !== undefined && (api.level() !== 'planet' || api.ctx.body !== anchor))
      api.setLevel('planet', { kind: 'body', id: anchor }, () => { api.ctx.body = anchor; api.ctx.system = api.world.bodies[anchor].system; });
  }

  api.inspector.onFollow = (pid) => { api.inspector.el.classList.add('open'); startFollow(pid); };
  api.inspector.onPerson = (id) => { if (following && id !== following.pid) stopFollow(); };

  return { lifePick, lifePickBtn, followYear, stopFollow, following: () => following };
}
