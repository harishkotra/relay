// End-to-end verification through the HTTP API: every task on every path, run
// separately so timings are isolated, plus a freshness re-run of the fetch task.
// Writes a markdown evidence file and exits non-zero if any assertion fails.

import { mkdir, writeFile } from 'node:fs/promises';
import { TASKS } from '../server/agent-spec.js';
import type { PathId, RunResult } from '../server/types.js';

const BASE = process.env.VERIFY_API_TARGET ?? process.env.RELAY_VERIFY_TARGET ?? 'http://127.0.0.1:3001';
const CONFIG = {
  baseUrl: process.env.RELAY_BASE_URL ?? 'https://api.particle.ai/v1',
  apiKey: process.env.RELAY_API_KEY ?? '',
  model: process.env.RELAY_MODEL ?? 'deepseek-v4.1-flash',
};

let failures = 0;
const lines: string[] = [];

function say(text = ''): void {
  console.log(text);
  lines.push(text);
}

function assert(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1;
  say(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function run(path: PathId, prompt: string): Promise<RunResult> {
  const response = await fetch(`${BASE}/run/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, config: CONFIG }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text) as RunResult;
}

function toolsOf(result: RunResult): { name: string; args: unknown }[] {
  return result.trace
    .filter((s) => s.kind === 'tool_call')
    .map((s) => ({ name: s.label.replace(/\(.*$/, ''), args: (s.detail as { arguments?: unknown })?.arguments }));
}

function bodyOf(result: RunResult): string {
  const fetchStep = result.trace.find((s) => s.kind === 'tool_result' && JSON.stringify(s.detail).includes('"body"'));
  const nested = (fetchStep?.detail as { content?: { json?: Record<string, unknown> }[] } | undefined)?.content;
  const json = nested?.find((c) => c.json)?.json ?? (fetchStep?.detail as Record<string, unknown> | undefined);
  return String(json?.body ?? '');
}

say(`# relay verification`);
say('');
say(`- target: ${BASE}`);
say(`- provider: ${CONFIG.model} @ ${CONFIG.baseUrl} (key ${CONFIG.apiKey ? 'present' : 'absent'})`);
say(`- started: ${new Date().toISOString()}`);
say(`- mode: paths run one at a time (POST /run/<path>, no streaming) so wall-clock numbers are not shared`);
say('');

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
say(`- server identity: ${JSON.stringify(health)}`);
if ((health as { service?: string }).service !== 'relay') {
  say('');
  say(`ABORTED: ${BASE}/health did not identify itself as relay. Another service owns this port.`);
  process.exit(2);
}
say('');

const collected: Record<string, Record<PathId, RunResult>> = {};

for (const task of TASKS) {
  collected[task.id] = {} as Record<PathId, RunResult>;
  for (const path of ['handrolled', 'strands'] as PathId[]) {
    say(`## ${task.id} · ${path}`);
    say('');
    say('```');
    say(`prompt: ${task.prompt}`);
    let result: RunResult;
    try {
      result = await run(path, task.prompt);
    } catch (error) {
      say(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      say('```');
      say('');
      assert(`${task.id}/${path} reachable`, false);
      continue;
    }
    collected[task.id]![path] = result;
    say(`answer   : ${result.answer.replace(/\n/g, ' ')}`);
    say(`iterations: ${result.iterations} model calls, ${result.toolCalls} tool calls, ${result.trace.length} trace steps`);
    say(`tokens   : ${result.tokens.reported ? `${result.tokens.input} in + ${result.tokens.output} out = ${result.tokens.total} total` : 'not reported by upstream'}`);
    say(`ms / loc : ${result.ms}ms, ${result.loc} code lines`);
    if (result.error) say(`error    : ${result.error.message} :: ${(result.error.raw ?? '').slice(0, 300)}`);
    say('trace:');
    for (const step of result.trace) {
      say(`  ${String(step.n).padStart(2)}. [${step.kind}] ${step.label}`);
    }
    say('```');
    say('');

    assert(`${task.id}/${path} produced an answer`, result.answer.trim().length > 0, result.answer.slice(0, 80));
    assert(`${task.id}/${path} made at least one real tool call`, result.toolCalls > 0, `${result.toolCalls}`);

    if (task.id === 'calc-time') {
      assert(`${task.id}/${path} answered 78666`, result.answer.includes('78666'), result.answer.slice(0, 120));
      const year = new Date().toISOString().slice(0, 4);
      assert(`${task.id}/${path} used calculator`, toolsOf(result).some((t) => t.name === 'calculator'));
      assert(`${task.id}/${path} used now_utc`, toolsOf(result).some((t) => t.name === 'now_utc'));
      assert(`${task.id}/${path} reported a real current date`, result.answer.includes(year), result.answer.slice(0, 120));
    }
    if (task.id === 'fetch-summary') {
      const body = bodyOf(result);
      assert(`${task.id}/${path} fetched a real body`, body.includes('temperature_2m'), `${body.length} chars`);
      assert(`${task.id}/${path} used live_fetch`, toolsOf(result).some((t) => t.name === 'live_fetch'));
    }
    if (task.id === 'fetch-sum') {
      const used = toolsOf(result).map((t) => t.name);
      assert(`${task.id}/${path} used live_fetch then calculator`, used.includes('live_fetch') && used.includes('calculator'), used.join(', '));
    }
    say('');
  }
}

say('## cross-path comparison per task');
say('');
for (const task of TASKS) {
  const a = collected[task.id]?.handrolled;
  const b = collected[task.id]?.strands;
  if (!a || !b) {
    say(`- ${task.id}: one path did not complete (see failures above)`);
    continue;
  }
  const seq = (r: RunResult) => toolsOf(r).map((t) => t.name).join(' → ') || '(none)';
  say(`- ${task.id}: steps A=${a.trace.length} B=${b.trace.length} | model calls A=${a.iterations} B=${b.iterations} | tokens A=${a.tokens.total} B=${b.tokens.total} | ms A=${a.ms} B=${b.ms} | loc A=${a.loc} B=${b.loc}`);
  say(`  tools A: ${seq(a)}`);
  say(`  tools B: ${seq(b)}`);
  if (seq(a) !== seq(b)) say(`  DIVERGENCE: tool order differs`);
  if (a.iterations !== b.iterations) say(`  DIVERGENCE: iteration count differs`);
  if (a.answer.replace(/\D/g, '') !== b.answer.replace(/\D/g, '')) say(`  DIVERGENCE: answers differ -> A "${a.answer.slice(0, 90)}" vs B "${b.answer.slice(0, 90)}"`);
}

say('');
say('## freshness: the same fetch task run twice, live_fetch bodies must differ');
say('');
const again = await run('handrolled', TASKS[1]!.prompt);
const first = collected['fetch-summary']?.handrolled;
if (first && again) {
  const b1 = bodyOf(first);
  const b2 = bodyOf(again);
  say(`run 1 body[0..80]: ${b1.slice(0, 80).replace(/\n/g, ' ')}`);
  say(`run 2 body[0..80]: ${b2.slice(0, 80).replace(/\n/g, ' ')}`);
  assert('live_fetch is not cached (bodies differ between runs)', b1 !== b2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir('.verify', { recursive: true });
await writeFile(`.verify/${stamp}.md`, `${lines.join('\n')}\n`, 'utf8');
say('');
say(failures === 0 ? `ALL VERIFICATION CHECKS PASSED (evidence: .verify/${stamp}.md)` : `${failures} VERIFICATION CHECK(S) FAILED (evidence: .verify/${stamp}.md)`);
process.exit(failures === 0 ? 0 : 1);
