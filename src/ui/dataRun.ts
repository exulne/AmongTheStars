// "This run": everything needed to reproduce it (build, rules hash, future
// number, link) and what the seed rolled before the first step: which
// speculative technologies its physics forbids, and each tech's cost luck.

import { TECHS } from '../sim/catalog.ts';
import type { DataRes } from '../sim/dataApi.ts';
import { esc, type DataHost, type DataTab } from './dataPanel.ts';
import { copyText, toCsv, toJson } from './exporter.ts';
import { fmtYear } from './format.ts';
import { BUILD, STAMP_CODE, stampLine } from './stamp.ts';

type RunInfo = Extract<DataRes, { type: 'runinfo' }>;

export class RunTab implements DataTab {
  id = 'run';
  label = 'This run';
  el: HTMLElement;
  private host: DataHost;
  private info: RunInfo | null = null;
  private asking = false;

  constructor(host: DataHost) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      const status = this.el.querySelector<HTMLElement>('.copy-status');
      if (act === 'link') { let l = ''; try { l = location.href; } catch { /* sandboxed */ } void copyText(l, 'Link', status); }
      else if (act === 'card' && this.info) void copyText(toJson(this.card(), `Run card for future #${this.info.seed}`), 'Run card as JSON', status);
      else if (act === 'techs' && this.info) {
        const i = this.info;
        void copyText(toCsv(['tech', 'era', 'chance_allowed', 'allowed_here', 'cost_luck', 'unlocked_year'],
          TECHS.map((t, k) => [t.id, t.era, t.feasible ?? 1, i.feasible[k], i.costMult[k], i.techDone[k] >= 0 ? 2040 + i.techDone[k] : ''])), 'Technologies as CSV', status);
      }
    });
  }

  private card(): Record<string, unknown> {
    const i = this.info!;
    return {
      build: BUILD, stamp: STAMP_CODE, future: i.seed, complete: i.done, wanderlust: i.wanderlust,
      forbidden: TECHS.filter((_, k) => !i.feasible[k]).map((t) => t.id),
      techs: TECHS.map((t, k) => ({ id: t.id, allowed: !!i.feasible[k], costLuck: i.costMult[k], unlocked: i.techDone[k] >= 0 ? 2040 + i.techDone[k] : null })),
    };
  }

  refresh(): void {
    const sim = this.host.sim;
    const stale = !this.info || this.info.seed !== sim.seed || (!this.info.done && sim.done);
    if (stale && !this.asking) {
      this.asking = true;
      sim.data<'runinfo'>({ type: 'runinfo' }).then((m) => { this.asking = false; this.info = m; this.render(); });
    }
    this.render();
  }

  private render(): void {
    const sim = this.host.sim, i = this.info && this.info.seed === sim.seed ? this.info : null;
    const spec = TECHS.map((t, k) => ({ t, k })).filter(({ t }) => (t.feasible ?? 1) < 1);
    const forbidden = i ? spec.filter(({ k }) => !i.feasible[k]) : [];
    const rows = spec.map(({ t, k }) => {
      const here = !i ? '' : i.feasible[k] ? 'allowed' : '<strong>forbidden</strong>';
      const done = i && i.techDone[k] >= 0 ? fmtYear(i.techDone[k]) : i && !i.feasible[k] ? 'never' : i?.done ? 'not reached' : '';
      return `<tr><th scope="row" class="txt" title="${esc(t.blurb ?? '')}">${esc(t.name)}</th><td class="num">${Math.round((t.feasible ?? 1) * 100)}%</td><td class="txt">${here}</td><td class="num">${i ? `×${i.costMult[k].toFixed(2)}` : ''}</td><td class="txt">${done}</td></tr>`;
    }).join('');
    this.el.innerHTML = `
      <dl class="run-stamp">
        <dt>Build</dt><dd class="num">${esc(BUILD.sha)}${BUILD.sha.endsWith('+') ? ' (with uncommitted changes)' : ''}${BUILD.built ? `, ${esc(BUILD.built)}` : ''}</dd>
        <dt>Rules hash</dt><dd class="num">${esc(BUILD.rules)} <span class="muted">(catalog, world and engine sources; the same hash and future number give the same run)</span></dd>
        <dt>Forecaster</dt><dd class="num">${BUILD.trainedAt ? `trained ${esc(BUILD.trainedAt.replace('T', ' ').slice(0, 19))} UTC` : 'unknown'}</dd>
        <dt>Future</dt><dd class="num">#${sim.seed}${i ? ` · wanderlust ×${i.wanderlust.toFixed(2)}` : ''}${sim.done ? '' : ' · still simulating'}</dd>
      </dl>
      <div class="data-actions">
        <button class="link" type="button" data-act="link">Copy link to this moment</button>
        <button class="link" type="button" data-act="card"${i ? '' : ' disabled'}>Copy run card (JSON)</button>
        <button class="link" type="button" data-act="techs"${i ? '' : ' disabled'}>Copy every technology (CSV)</button>
        <span class="copy-status muted" aria-live="polite"></span>
      </div>
      <h3 class="data-h">What this universe's physics allows</h3>
      <p class="muted">${!i ? 'Asking the simulation…' : forbidden.length
        ? `In future #${i.seed} physics forbids ${forbidden.map(({ t }) => esc(t.name)).join(', ')}. Researchers who get there find a no-go theorem instead.`
        : `In future #${i.seed} physics forbids none of the speculative technologies.`} Each is rolled once per future, before the first step; cost luck multiplies what each costs to discover.</p>
      <div class="tbl-scroll"><table class="dtable"><thead><tr><th scope="col" class="txt">technology</th><th scope="col">chance allowed</th><th scope="col" class="txt">here</th><th scope="col">cost luck</th><th scope="col" class="txt">discovered</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted">${esc(stampLine())}</p>`;
  }
}
