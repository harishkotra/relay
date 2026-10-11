// Relay server: two implementations of one agent, behind one Hono app, on one
// shared set of tools. Port and bind host are overridable so a busy :3001 never
// forces a code edit.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MAX_TURNS, TASKS, DEMO_LIVE_URL } from './agent-spec.js';
import { assertUsable, ConfigError, resolveConfig } from './config.js';
import { countLoc, readServerFile, serverFile } from './loc.js';
import { runHandrolled } from './handrolled.js';
import { runStrands } from './strands-trace.js';
import { toolCatalog } from './tools.js';
import type { PathId, RunResult, StreamEvent } from './types.js';
import { redact } from './config.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '127.0.0.1';

/** Only these files are readable through /source; no arbitrary path access. */
const SOURCE_FILES = ['handrolled', 'strands', 'strands-trace', 'tools', 'agent-spec'] as const;
type SourceFile = (typeof SOURCE_FILES)[number];

const app = new Hono();

interface RunBody {
  prompt?: string;
  taskId?: string;
  config?: Record<string, unknown>;
  stream?: boolean;
  sequential?: boolean;
}

function promptFrom(body: RunBody): string {
  const task = body.taskId ? TASKS.find((t) => t.id === body.taskId) : undefined;
  const prompt = (body.prompt ?? task?.prompt ?? '').toString().trim();
  if (!prompt) throw new ConfigError('Nothing to run: provide a prompt or a taskId.');
  if (prompt.length > 4000) throw new ConfigError('Prompt is longer than 4000 characters.');
  return prompt;
}

function pathRunner(path: PathId) {
  return path === 'handrolled' ? runHandrolled : runStrands;
}

app.get('/health', (c) =>
  c.json({
    service: 'relay',
    ok: true,
    paths: ['handrolled', 'strands'],
    port: PORT,
    maxTurns: MAX_TURNS,
  }),
);

app.get('/tools', (c) =>
  c.json({
    tools: toolCatalog,
    sharedBy: ['handrolled', 'strands'],
    defaultLiveUrl: DEMO_LIVE_URL,
    note: 'One implementation per tool; both paths execute the same functions.',
  }),
);

app.get('/tasks', (c) => c.json({ tasks: TASKS, maxTurns: MAX_TURNS }));

app.get('/loc', async (c) => {
  const files: Record<string, ReturnType<typeof countLoc>> = {};
  for (const name of SOURCE_FILES) {
    const content = await readServerFile(name);
    files[name] = content.report;
  }
  return c.json({ files, command: 'npm run loc' });
});

app.get('/source', async (c) => {
  const requested = c.req.query('file') ?? 'handrolled';
  if (!(SOURCE_FILES as readonly string[]).includes(requested)) {
    return c.json({ error: `Unknown source file '${requested}'. Allowed: ${SOURCE_FILES.join(', ')}` }, 400);
  }
  const file = requested as SourceFile;
  const { content, path, report } = await readServerFile(file);
  return c.json({ file, path, content, ...report });
});

/**
 * Proxy for the provider's model list. The browser cannot call most providers
 * directly (CORS), and the server keeps no provider knowledge of its own: the
 * base URL and key come from the request body, exactly like a run.
 */
app.post('/models', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { config?: Record<string, unknown> };
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(body.config as never, process.env);
    assertUsable(config);
  } catch (error) {
    if (error instanceof ConfigError) return c.json({ error: error.message }, 400);
    throw error;
  }
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      signal: AbortSignal.timeout(15_000),
      headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    });
    const text = await response.text();
    if (!response.ok) return c.json({ error: redact(`upstream ${response.status}: ${text.slice(0, 400)}`, config) }, 502);
    const list = JSON.parse(text) as { data?: { id?: string }[]; models?: { name?: string }[] };
    const models = (list.data ?? [])
      .map((m) => m.id ?? '')
      .filter(Boolean)
      .concat((list.models ?? []).map((m) => m.name ?? '').filter(Boolean));
    return c.json({ models, count: models.length });
  } catch (error) {
    return c.json({ error: redact(error instanceof Error ? error.message : String(error), config) }, 502);
  }
});

/**
 * Runs one or both paths. With stream=true the response is NDJSON: step events
 * as they happen, then one result event per path carrying the documented shape.
 */
async function handleRun(c: import('hono').Context, paths: PathId[]) {
  const body = (await c.req.json().catch(() => ({}))) as RunBody;
  let prompt: string;
  let config: ReturnType<typeof resolveConfig>;
  try {
    prompt = promptFrom(body);
    config = resolveConfig(body.config as never, process.env);
    assertUsable(config);
  } catch (error) {
    if (error instanceof ConfigError) return c.json({ error: error.message }, 400);
    throw error;
  }

  if (!body.stream) {
    const run = async (path: PathId): Promise<RunResult> => pathRunner(path)(prompt, config);
    const results: Record<string, RunResult> = {};
    if (body.sequential || paths.length === 1) {
      for (const path of paths) results[path] = await run(path);
    } else {
      const settled = await Promise.all(paths.map((path) => run(path)));
      for (const result of settled) results[result.path] = result;
    }
    return paths.length === 1 ? c.json(results[paths[0]!]) : c.json(results);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      send({ type: 'config', baseUrl: redact(config.baseUrl, config), model: config.model, hasKey: Boolean(config.apiKey) });

      const run = async (path: PathId): Promise<void> => {
        try {
          const result = await pathRunner(path)(prompt, config, (step) => send({ type: 'step', path, step }));
          send({ type: 'result', path, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: 'error', path, message, raw: redact(message, config) });
        }
      };

      const job = (async () => {
        if (body.sequential || paths.length === 1) {
          for (const path of paths) await run(path);
        } else {
          await Promise.all(paths.map((path) => run(path)));
        }
        send({ type: 'done' });
        controller.close();
      })();

      job.catch((error) => {
        send({ type: 'error', path: paths[0]!, message: String(error) });
        controller.close();
      });
    },
  });

  return c.body(stream, 200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
}

app.post('/run/handrolled', (c) => handleRun(c, ['handrolled']));
app.post('/run/strands', (c) => handleRun(c, ['strands']));
app.post('/run/both', (c) => handleRun(c, ['handrolled', 'strands']));

app.onError((error, c) => c.json({ error: error instanceof Error ? error.message : String(error) }, 500));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const address = `http://${HOST}:${info.port}`;
  console.log(`[relay] server listening on ${address}`);
  console.log(`[relay] identity: GET ${address}/health  (service=relay)`);
  console.log(`[relay] source read from: ${serverFile('handrolled')}`);
});

export { app };
