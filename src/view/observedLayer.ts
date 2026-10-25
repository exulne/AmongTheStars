// Observed satellites for the 3D view: SGP4 positions computed in the worker
// at a chosen time near the snapshot's element-set epochs (never at the
// simulated year). The Orbits tab fills this; Earth's planet view draws it.

export const observedLayer = {
  on: false,
  /** Earth radii, view frame */
  positions: null as Float32Array | null,
  colors: null as Float32Array | null,
  norads: null as Int32Array | null,
  age: null as Uint8Array | null,
  tMs: 0,
  version: 0,
  /** show the simulated fleet shells too */
  simulated: true,
  /** called when a drawn observed object is picked */
  onPick: (_norad: number) => {},
  /** card facts for a picked object (set by the Orbits tab) */
  describe: (_norad: number): { title: string; lede: string; facts: { k: string; v: string; t?: 'R' | 'E' | 'P' }[] } | null => null,
};
