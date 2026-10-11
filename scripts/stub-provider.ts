// A scripted stand-in provider for PLUMBING tests only.
//
// What it fakes: the model. It returns hard-coded tool_calls and then an answer.
// What stays real: the agent loops (both paths), the framework's tool dispatch,
// the three tools themselves -- so calculator really computes and live_fetch
// really hits api.open-meteo.com -- plus the HTTP API, NDJSON streaming and the
// line counter. Any number the scripted "answer" repeats was taken from a real
// tool result in the request body.
//
// This is NOT the acceptance verification. That runs against a real model.
//
// Usage: npx tsx scripts/stub-provider.ts   (prints the URL to paste into Settings)

import { createServer } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

const turns: ChatMessage[][] = [];

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Path A sends `content` as a string; Strands sends it as a content-block array
 * ([{type:'text',text:…}]). The stub has to read both, which is itself a
 * difference between the two implementations on the wire.
 */
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text?: unknown }).text ?? '') : '')).join(' ');
  }
  return '';
}

/** Decide the next scripted move from the tool results already in the history. */
function nextReply(messages: ChatMessage[]): { content: string | null; tool_calls?: ReturnType<typeof toolCall>[] } {
  const prompt = text(messages.find((m) => m.role === 'user')?.content);
  const results = messages.filter((m) => m.role === 'tool');
  const seen = results.map((m) => text(m.content));

  if (!seen.length) {
    if (/1873/.test(prompt)) {
      return { content: null, tool_calls: [toolCall('call_calc', 'calculator', { expression: '1873 * 42' }), toolCall('call_time', 'now_utc', {})] };
    }
    if (/sum/i.test(prompt)) {
      return { content: null, tool_calls: [toolCall('call_fetch', 'live_fetch', {})] };
    }
    if (/fetch/i.test(prompt)) {
      return { content: null, tool_calls: [toolCall('call_fetch', 'live_fetch', {})] };
    }
    return { content: 'The scripted provider has no plan for this prompt.' };
  }

  if (/sum/i.test(prompt) && !seen.some((s) => s.includes('"result"'))) {
    const numbers = (seen[0]?.match(/-?\d+\.?\d*/g) ?? []).slice(0, 6);
    return { content: null, tool_calls: [toolCall('call_calc', 'calculator', { expression: numbers.join(' + ') || '1 + 1' })] };
  }

  // Compose the answer out of values that really came back from the tools.
  const joined = seen.join(' ');
  const computed = joined.match(/"result":(-?[\d.]+)/)?.[1];
  const iso = joined.match(/"iso":"([^"]+)"/)?.[1];
  const temp = joined.match(/"temperature_2m":(-?[\d.]+)/)?.[1];
  const status = joined.match(/"status":(\d+)/)?.[1];
  const parts: string[] = [];
  if (computed !== undefined) parts.push(`computed ${computed}`);
  if (iso) parts.push(`UTC time ${iso}`);
  if (status) parts.push(`HTTP ${status}`);
  if (temp) parts.push(`temperature_2m ${temp}`);
  return { content: `Scripted answer from real tool output: ${parts.join(', ')}.` };
}

// Mounted twice: clients append /chat/completions to a base URL that may or may
// not already end in /v1, and both spellings have to answer.
app.get('/models', (c) => c.json({ data: [{ id: 'stub-model' }] }));
app.get('/v1/models', (c) => c.json({ data: [{ id: 'stub-model' }] }));

app.use('*', async (ctx, next) => {
  console.log(`[stub] ${ctx.req.method} ${ctx.req.path}`);
  await next();
});

/**
 * OpenAI SSE chunking. Strands' chat adapter hardcodes `stream: true` plus
 * `stream_options: { include_usage: true }` (chat-adapter.js), so a provider
 * that cannot stream breaks Path B while Path A is unaffected. This stub speaks
 * both so that asymmetry is visible rather than papered over.
 */
function sseStream(reply: { content: string | null; tool_calls?: ReturnType<typeof toolCall>[] }, promptTokens: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const base = { id: `chatcmpl-stub-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'stub-model' };
  const events: string[] = [JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })];

  if (reply.tool_calls?.length) {
    const fragment = process.env.STUB_FRAGMENT !== '0';
    reply.tool_calls.forEach((call, index) => {
      events.push(JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: fragment ? '' : call.function.arguments } }] }, finish_reason: null }],
      }));
      if (!fragment) return;
      // Split the arguments so the framework has to reassemble the JSON.
      const args = call.function.arguments;
      for (let i = 0; i < args.length; i += 12) {
        events.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(i, i + 12) } }] }, finish_reason: null }] }));
      }
    });
    events.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  } else {
    const text = reply.content ?? '';
    for (let i = 0; i < text.length; i += 24) {
      events.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 24) }, finish_reason: null }] }));
    }
    events.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  }

  events.push(JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 24, total_tokens: promptTokens + 24 } }));
  events.push('[DONE]');

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
}

async function completions(c: import('hono').Context) {
  const body = (await c.req.json()) as { messages: ChatMessage[]; stream?: boolean };
  turns.push(body.messages);
  if (process.env.STUB_DEBUG) console.log('[stub] request messages:', JSON.stringify(body.messages).slice(0, 700));
  const reply = nextReply(body.messages);
  const promptTokens = JSON.stringify(body.messages).length >> 2;

  if (body.stream) {
    return c.body(sseStream(reply, promptTokens), 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  }
  return c.json({
    id: `chatcmpl-stub-${turns.length}`,
    object: 'chat.completion',
    model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', ...reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 24, total_tokens: promptTokens + 24 },
  });
}

app.post('/chat/completions', (c) => completions(c));
app.post('/v1/chat/completions', (c) => completions(c));

/** Ask the OS for a free port so this never collides with a real provider. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const server: ServerType = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
console.log(`stub provider listening on http://127.0.0.1:${port}/v1`);
console.log('Settings -> base URL above, model "stub-model", API key anything.');

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => {
  console.log(`[stub] served ${turns.length} model turns`);
  process.exit(0);
});
