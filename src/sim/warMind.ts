// A war mind makes the decisions that are otherwise dice rolls in polity.ts:
// how much to arm, whom to fight, when to launch a kinetic strike, and what
// peace to take. The physics of a fight (losses from the balance of forces,
// light-lag, strike energy, the second strike) stays in polity.ts. With no
// mind set, Politics runs its random rules exactly as before.

/** A pair of factions sharing a contested star system, with why they might fight. */
export interface PressCand {
  sy: number; a: number; b: number;
  cause: number;                 // WAR_CAUSE of the loudest term
  res: number; faith: number; indep: number; grudge: number;   // the terms polity.ts scores
}

/** A pair of factions in different systems with a grudge deep enough for a kinetic war. */
export interface StrikeCand { a: number; b: number; d: number; grudge: number; beta: number }

/** A local war whose resolution is due; the winner chooses. */
export interface TermsCand {
  war: number; winner: number; loser: number;
  ratio: number;                 // winner's force over loser's, ≥ 1
  can: [peace: boolean, reparations: boolean, annex: boolean, fightOn: boolean];
}

/** TermsCand choices, in the order of `can` (the first three equal OUTCOME). */
export const TERMS = { PEACE: 0, REPARATIONS: 1, ANNEX: 2, FIGHT_ON: 3 } as const;
/** extra military spending each posture adds (H.posture) */
export const POSTURES = [-0.5, 0, 1, 2.5] as const;
export const MAX_ROUNDS = 3;

export interface WarMind {
  /** Once per politics step, before any decision: write H.posture for the factions it speaks for. */
  begin(year: number, dt: number): void;
  /** For each candidate: the faction that strikes first, or -1 for no war. */
  press(c: PressCand[], year: number): number[];
  /** For each candidate: the faction that launches, or -1. */
  strike(c: StrikeCand[], year: number): number[];
  /** One of TERMS, from those allowed by `can`. */
  terms(c: TermsCand, year: number): number;
}
