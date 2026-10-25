// Below the street: one person's body, a cell of one of its tissues, a
// molecule from inside that cell, and one atom of the molecule. Four zoom
// levels that share one state (whose body, which part, which organelle, which
// atom), derived on demand from the person's biography and the world they
// live on, like everything else about people in this simulation.

import { cellPlan, type CellPlan } from '../micro/cells.ts';
import { moleculeFor, type Molecule } from '../micro/molecules.ts';
import { PART_CELL, specimenOf, type Specimen } from '../micro/specimen.ts';
import { elem } from '../micro/elements.ts';
import type { AtomSpec } from '../explain/micro.ts';
import { partName } from '../explain/micro.ts';
import type { Biography } from '../sim/lives.ts';
import type { Ctx, Level, Ref } from './views.ts';
import { PersonView } from './microBody.ts';
import { CellView } from './microCell.ts';
import { AtomView, MoleculeView } from './microAtoms.ts';

export type PersonFetch = (id: string, year: number) => Promise<{ bio: Biography | null; pending?: boolean }>;
export const MICRO_LEVELS: Level[] = ['person', 'cell', 'molecule', 'atom'];
export const isMicro = (l: Level) => MICRO_LEVELS.includes(l);
/** Explainer kinds that only exist inside the micro levels. */
export const MICRO_KIND = /^m(part|flow|nano|cell|org|pts|nbr|atm|mol|nuc|orb|atom)$/;

export class Micro {
  pid: string | null = null;
  bio: Biography | null = null;
  part = 0; orgl = 0; atom = 0;
  /** called when the person's biography arrives or changes with the year */
  onChange: () => void = () => {};
  readonly views: { person: PersonView; cell: CellView; molecule: MoleculeView; atom: AtomView };
  private asked = '';
  private gen = 0;
  private spMemo: { k: string; v: Specimen } | null = null;
  private planMemo: { k: string; v: CellPlan } | null = null;
  private molMemo: { k: string; v: Molecule } | null = null;

  constructor(private fetchPerson: PersonFetch) {
    this.views = { person: new PersonView(this), cell: new CellView(this), molecule: new MoleculeView(this), atom: new AtomView(this) };
  }

  /** Look at someone. A known biography (from the inspector) saves a round trip. */
  setPerson(pid: string, bio?: Biography | null): void {
    if (pid !== this.pid) { this.pid = pid; this.bio = bio ?? null; this.part = 0; this.orgl = 0; this.atom = 0; this.asked = ''; this.gen++; }
    else if (bio) this.bio = bio;
  }

  /** Ask the simulation for this person as of the viewed year, if we haven't. */
  ensure(ctx: Ctx): void {
    if (!this.pid) return;
    const key = `${this.pid}@${Math.floor(ctx.year)}`;
    if (key === this.asked) return;
    this.asked = key;
    const g = ++this.gen, pid = this.pid, year = ctx.year;
    const go = (): void => {
      this.fetchPerson(pid, year).then((r) => {
        if (g !== this.gen) return;
        if (r.pending) { setTimeout(go, 700); return; }
        if (r.bio) { this.bio = r.bio; this.onChange(); }
      });
    };
    go();
  }

  specimen(ctx: Ctx): Specimen | null {
    if (!this.bio) return null;
    const k = `${this.bio.id}|${Math.floor(ctx.year)}|${ctx.snap?.step ?? -1}|${this.bio.age}|${this.bio.body}|${this.bio.status}`;
    if (this.spMemo?.k !== k) this.spMemo = { k, v: specimenOf(ctx.world, ctx.snap, this.bio, ctx.year) };
    return this.spMemo.v;
  }

  plan(ctx: Ctx): CellPlan | null {
    const sp = this.specimen(ctx);
    if (!sp) return null;
    this.part = Math.min(this.part, sp.parts.length - 1);
    const k = `${sp.key}|${this.part}|${sp.tech.nanofab}`;
    if (this.planMemo?.k !== k) this.planMemo = { k, v: cellPlan(PART_CELL[sp.parts[this.part]], sp) };
    return this.planMemo.v;
  }

  molecule(ctx: Ctx): Molecule | null {
    const sp = this.specimen(ctx), plan = this.plan(ctx);
    if (!sp || !plan) return null;
    this.orgl = Math.min(this.orgl, plan.organelles.length - 1);
    const k = `${plan.key}|${this.orgl}`;
    if (this.molMemo?.k !== k) this.molMemo = { k, v: moleculeFor(plan.organelles[this.orgl], plan, sp) };
    return this.molMemo.v;
  }

  atomSpec(ctx: Ctx): AtomSpec | null {
    const m = this.molecule(ctx);
    if (!m) return null;
    let a = m.atoms[this.atom];
    if (!a || a.Z === 0) { this.atom = Math.max(0, m.atoms.findIndex((x) => x.mol < 0 && x.Z > 0)); a = m.atoms[this.atom]; }
    return { Z: a.Z, N: elem(a.Z).N, role: a.role, molName: m.name, hl: !!a.hl };
  }

  /** Breadcrumb text for each micro level. */
  crumb(level: Level, ctx: Ctx): string {
    const sp = this.specimen(ctx);
    if (level === 'person') return sp?.name ?? this.bio?.name ?? 'Someone';
    if (level === 'cell') { const p = this.plan(ctx); return p ? `${sp ? partName(sp.parts[this.part]) : ''}: ${p.type.name.toLowerCase()}` : 'Tissue'; }
    if (level === 'molecule') return this.molecule(ctx)?.name.replace(/^DNA: the (\S+) gene$/, 'DNA ($1)') ?? 'Molecule';
    const a = this.atomSpec(ctx);
    return a ? `${elem(a.Z).name[0].toUpperCase()}${elem(a.Z).name.slice(1)} atom` : 'Atom';
  }

  /** What entering a picked thing at a micro level leads to, and how to point the state at it. */
  enterRef(level: Level, r: Ref, ctx: Ctx): { next: Level; prep: () => void } | null {
    if (r.kind !== 'thing') return null;
    const sp = this.specimen(ctx);
    if (level === 'person' && sp) {
      if (r.ex === 'mpart') return { next: 'cell', prep: () => { this.part = r.id; this.orgl = 0; this.atom = 0; } };
      if (r.ex === 'mflow' || r.ex === 'mnano') {
        const p = sp.parts.indexOf(r.ex === 'mnano' ? 'nano' : 'blood');
        if (p >= 0) return { next: 'cell', prep: () => { this.part = p; this.orgl = 0; this.atom = 0; } };
      }
    }
    if (level === 'cell' && (r.ex === 'morg' || r.ex === 'mpts')) return { next: 'molecule', prep: () => { this.orgl = r.id; this.atom = 0; } };
    if (level === 'cell' && r.ex === 'mcell') return { next: 'molecule', prep: () => { this.orgl = 0; this.atom = 0; } };
    if (level === 'molecule' && r.ex === 'matm') {
      const m = this.molecule(ctx);
      if (m?.atoms[r.id]?.Z) return { next: 'atom', prep: () => { this.atom = r.id; } };
    }
    return null;
  }

  hash(): string { return `m${this.part}.${this.orgl}.${this.atom}`; }
  readHash(h: string): void {
    const m = h.match(/(?:^|-)m(\d+)\.(\d+)\.(\d+)(?=-|$)/);
    if (m) { this.part = Number(m[1]); this.orgl = Number(m[2]); this.atom = Number(m[3]); }
  }
}
