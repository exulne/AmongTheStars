// A hand on the timeline drops a parked year: the listeners that clear
// pendingYear when the user grabs the slider, its keys, an age or Play.
// Installed where the block used to live in main.ts.

import type { AppApi } from '../app/api.ts';

export function installTimelineHand(api: AppApi): void {
  // a hand on the timeline (the slider and its keys, a typed year, an age, Play, the Space and arrow
  // shortcuts) drops a year parked by a link, the URL or Watch; seeks made in code keep it
  const dropParked = (): void => { api.setPendingYear(null); };
  api.timeline.el.addEventListener('input', (e) => { if ((e.target as HTMLElement).matches('input[type=range]')) dropParked(); });
  api.timeline.el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('input[type=range]') ? e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.code === 'Space' : t.matches('.tl-big') && e.key === 'Enter') dropParked();
  });
  api.timeline.el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-age], .tl-play')) dropParked(); });
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') dropParked();
  });
}
