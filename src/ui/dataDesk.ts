// Wires the data desk into the app: the panel and its tabs, the Data button,
// the map marks for query matches, and derived series for the bottom charts.
// main.ts calls installDataDesk once and dataDesk.refresh() when things change.

import type { SimClient } from '../sim/client.ts';
import type { World } from '../sim/world.ts';
import type { Ctx, View } from '../view/views.ts';
import './data.css';
import { DataPanel } from './dataPanel.ts';
import { TimeTab } from './dataTime.ts';
import { Highlight } from './highlight.ts';
import { RunTab } from './dataRun.ts';
import { GroupsTab } from './dataGroups.ts';
import { ChartsTab } from './dataCharts.ts';
import { TrendsTab } from './dataTrends.ts';
import { HistoryTab } from './dataHistory.ts';
import { EconTab } from './dataEcon.ts';
import { esc } from './dataPanel.ts';
import { installStamp, stampLine } from './stamp.ts';

export interface DeskOpts {
  app: HTMLElement;
  scene: HTMLCanvasElement;
  world: World;
  sim: SimClient;
  ctx: Ctx;
  view: () => View;
  selectBody: (b: number) => void;
  showSeries: (key: string) => void;
  pickYear?: (y: number) => void;
}

export function installDataDesk(o: DeskOpts): DataPanel {
  const hl = new Highlight(o.scene, o.view, o.ctx);
  const desk = new DataPanel({
    world: o.world, sim: o.sim, year: () => o.ctx.year,
    selectBody: o.selectBody,
    selectedBody: () => (o.ctx.selected?.kind === 'body' ? o.ctx.selected.id : -1),
    setHighlight: (ids) => hl.set(ids),
    showSeries: o.showSeries,
    pickYear: o.pickYear,
  });
  desk.add(new ChartsTab(desk.hostApi));
  desk.add(new TrendsTab(desk.hostApi));
  desk.add(new GroupsTab(desk.hostApi, desk));
  desk.add(new HistoryTab(desk.hostApi));
  desk.add(new TimeTab(desk.hostApi, desk));
  const econ = new EconTab(desk.hostApi);
  desk.add(econ);
  desk.openMission = (id) => { if (!desk.open) btn?.click(); desk.show('econ'); econ.open(id); };
  desk.add(new RunTab(desk.hostApi));
  const btn = o.app.querySelector<HTMLButtonElement>('#data');
  installStamp({ app: o.app, seed: () => o.sim.seed, year: () => o.ctx.year });
  desk.footer(`<span class="num">${esc(stampLine())}</span>`);
  o.app.append(desk.el);
  btn?.addEventListener('click', () => { desk.toggle(); btn.setAttribute('aria-pressed', String(desk.open)); });
  desk.onClose = () => btn?.setAttribute('aria-pressed', 'false');
  return desk;
}
