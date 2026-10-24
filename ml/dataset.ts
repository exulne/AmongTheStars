// Simulate many futures and save their token sequences for training.
// node ml/dataset.ts <seeds=400> <out=ml/data/futures.bin>
// File layout: Int32 [count, T, F] then per run: Float32 x[T*F], Uint8 era[T].

import { mkdirSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { Engine } from '../src/sim/engine.ts';
import { buildWorld } from '../src/sim/world.ts';
import { NF_ML, TOKENS, toTokens } from '../src/ml/features.ts';

if (!isMainThread) {
  const world = buildWorld();
  for (const seed of workerData.seeds as number[]) {
    const e = new Engine(world, seed);
    e.logEvents = false;
    while (!e.done) e.step();
    const { x, era } = toTokens(e.years, e.series);
    parentPort!.postMessage({ seed, x, era }, [x.buffer, era.buffer]);
  }
} else {
  const count = Number(process.argv[2] ?? 400);
  const out = process.argv[3] ?? 'ml/data/futures.bin';
  const threads = Math.max(1, availableParallelism() - 2);
  const t0 = performance.now();
  const runs = new Map<number, { x: Float32Array; era: Uint8Array }>();
  // seeds 1..count; seed 1-50 are kept out of training as a validation set by train.ts
  const seeds = Array.from({ length: count }, (_, i) => i + 1);
  await Promise.all(Array.from({ length: threads }, (_, w) => new Promise<void>((res, rej) => {
    const mine = seeds.filter((_, i) => i % threads === w);
    const wk = new Worker(new URL(import.meta.url), { workerData: { seeds: mine } });
    wk.on('message', (m) => {
      runs.set(m.seed, m);
      if (runs.size % 25 === 0) console.log(`${runs.size}/${count} futures (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
    });
    wk.on('exit', () => res());
    wk.on('error', rej);
  })));
  const head = new Int32Array([count, TOKENS, NF_ML]);
  const parts: Uint8Array[] = [new Uint8Array(head.buffer)];
  for (const s of seeds) {
    const r = runs.get(s)!;
    parts.push(new Uint8Array(r.x.buffer), r.era);
  }
  mkdirSync('ml/data', { recursive: true });
  writeFileSync(out, Buffer.concat(parts));
  console.log(`wrote ${count} futures × ${TOKENS} tokens × ${NF_ML} features to ${out} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
