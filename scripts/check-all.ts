// The full check gate: every checker in order, each as a child process with
// inherited stdio, continuing after a failure so one bad check can't hide the
// rest. A summary table at the end; exit 1 if anything failed.
import { spawnSync } from 'node:child_process';

const STEPS: { name: string; cmd: [string, string[]] }[] = [
  { name: 'check', cmd: ['node', ['scripts/check.ts']] },
  { name: 'people-check', cmd: ['node', ['scripts/people-check.ts']] },
  { name: 'econ-check', cmd: ['node', ['scripts/econ-check.ts']] },
  { name: 'geo-check', cmd: ['node', ['scripts/geo-check.ts']] },
  { name: 'query-check', cmd: ['node', ['scripts/query-check.ts']] },
  { name: 'data-check', cmd: ['node', ['scripts/data-check.ts']] },
  { name: 'trends-check', cmd: ['node', ['scripts/trends-check.ts']] },
  { name: 'paths-check', cmd: ['node', ['scripts/paths-check.ts']] },
  { name: 'lifepick-check', cmd: ['node', ['scripts/lifepick-check.ts']] },
  { name: 'check:explain', cmd: ['npm', ['run', 'check:explain']] },
  { name: 'war-mind-check', cmd: ['node', ['scripts/war-mind-check.ts']] },
  { name: 'war-golden', cmd: ['node', ['scripts/war-golden.ts']] },
];

const rows: { name: string; code: number | null; s: number }[] = [];
for (const step of STEPS) {
  console.log(`\n=== ${step.name} ===`);
  const t = performance.now();
  const r = spawnSync(step.cmd[0], step.cmd[1], { stdio: 'inherit' });
  rows.push({ name: step.name, code: r.status, s: (performance.now() - t) / 1000 });
}

const w = Math.max(...rows.map((r) => r.name.length));
console.log('\ncheck summary');
for (const r of rows) console.log(`  ${r.name.padEnd(w)}  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.s.toFixed(1)}s`);
const bad = rows.filter((r) => r.code !== 0);
console.log(bad.length ? `${bad.length} check${bad.length === 1 ? '' : 's'} FAILED: ${bad.map((r) => r.name).join(', ')}` : 'all checks passed');
process.exit(bad.length ? 1 : 0);
