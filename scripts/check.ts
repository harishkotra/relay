// Model-free verification of the parts that must be right before any agent run
// is meaningful: the shared tools really execute, the live fetch really hits
// the network twice and is not cached, and the LOC counter counts what it claims.

import { countLoc, stripComments, readServerFile } from '../server/loc.js';
import { evaluateExpression, executeTool, strandsTools, TOOLS, openaiToolSchemas } from '../server/tools.js';
import { DEMO_LIVE_URL, TASKS } from '../server/agent-spec.js';

let failures = 0;
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures += 1;
}

function near(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

console.log('--- calculator ---');
const calcCases: [string, number][] = [
  ['1873 * 42', 78666],
  ['(2 + 3) * 4', 20],
  ['2 + 3 * 4', 14],
  ['10 / 4', 2.5],
  ['7 % 3', 1],
  ['2 ** 10', 1024],
  ['2 ** 3 ** 2', 512],
  ['-5 + 2', -3],
  ['1.5e3 + .5', 1500.5],
  ['((1+2)*(3+4)) - 1', 20],
];
for (const [expression, expected] of calcCases) {
  let value = Number.NaN;
  try {
    value = evaluateExpression(expression);
  } catch (error) {
    console.log(`      threw: ${String(error)}`);
  }
  check(`calculator ${JSON.stringify(expression)} = ${expected}`, near(value, expected), `got ${value}`);
}

console.log('--- calculator rejects anything but arithmetic ---');
for (const bad of ['process.exit(1)', "require('fs')", '1 +', '2 * (3', 'x * 4', 'alert(1)', '1;2']) {
  let rejected = false;
  try {
    evaluateExpression(bad);
  } catch {
    rejected = true;
  }
  check(`rejects ${JSON.stringify(bad)}`, rejected);
}

console.log('--- now_utc returns the real clock ---');
const clock = (await executeTool('now_utc', {})) as { iso: string; epochSeconds: number; time: string };
const skew = Math.abs(Date.now() / 1000 - clock.epochSeconds);
check('now_utc within 2s of system clock', skew < 2, `skew ${skew.toFixed(3)}s, iso ${clock.iso}`);

console.log('--- live_fetch performs real network calls (twice) ---');
const first = (await executeTool('live_fetch', { url: DEMO_LIVE_URL })) as { status: number; body: string; fetchedAt: string };
await new Promise((resolve) => setTimeout(resolve, 1200));
const second = (await executeTool('live_fetch', {})) as { status: number; body: string; url: string; fetchedAt: string };
check('first call returns HTTP 200', first.status === 200, `status ${first.status}`);
check('body is real upstream JSON', first.body.includes('temperature_2m'), `${first.body.length} chars`);
check('default url used when omitted', second.url === DEMO_LIVE_URL);
check('fetchedAt timestamps differ between calls', first.fetchedAt !== second.fetchedAt, `${first.fetchedAt} vs ${second.fetchedAt}`);
check('upstream body changes between calls (not cached)', first.body !== second.body);
const changedLine = first.body
  .split(',')
  .findIndex((part, i) => part !== second.body.split(',')[i]);
console.log(`      first differing token index: ${changedLine}`);
console.log(`      first[0..90]: ${first.body.slice(0, 90).replace(/\n/g, ' ')}`);
console.log(`      second[0..90]: ${second.body.slice(0, 90).replace(/\n/g, ' ')}`);

console.log('--- tools are shared, not duplicated ---');
check('three tools', TOOLS.length === 3, TOOLS.map((t) => t.name).join(', '));
check('OpenAI schemas cover every tool', openaiToolSchemas.length === TOOLS.length);
check('Strands adapters wrap the same three tools', strandsTools.length === TOOLS.length);
const namesA = openaiToolSchemas.map((t) => t.function.name).sort().join(',');
const namesB = strandsTools.map((t) => t.name).sort().join(',');
check('identical tool names on both paths', namesA === namesB, namesA);

console.log('--- LOC counter ---');
const sample = [
  '// leading comment',
  'import { x } from "y"; // trailing comment',
  '',
  '   ',
  '/* block',
  ' * still block',
  ' */',
  'const url = "https://example.com/a"; // url in a string is code',
  'function f() {',
  '  return 1;',
  '}',
].join('\n');
const sampled = countLoc(sample);
check('counts code lines only', sampled.loc === 5, `got ${sampled.loc}`);
check('does not treat https:// inside a string as a comment', !stripComments(sample).includes('const url = ;'));
check('total lines reported', sampled.totalLines === 11, `got ${sampled.totalLines}`);

console.log('--- real implementation files ---');
for (const name of ['handrolled', 'strands', 'strands-trace', 'tools', 'agent-spec']) {
  const { path, report } = await readServerFile(name);
  console.log(`${String(report.loc).padStart(4)}  code lines  ${path}`);
}

console.log('--- task definitions ---');
check('three demo tasks', TASKS.length === 3, TASKS.map((t) => t.id).join(', '));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
