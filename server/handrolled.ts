// Path A: the agent loop written by hand. Nothing here is framework code -- the
// message array, the HTTP call, tool_call parsing, execution, result append and
// the stop condition are all explicit below.

import { EXTRA_BODY_PARAMS, MAX_OUTPUT_TOKENS, MAX_TURNS, SYSTEM_PROMPT } from './agent-spec.js';
import { redact } from './config.js';
import { readServerFile } from './loc.js';
import type { ModelConfig, RunResult, TokenUsage, TraceStep } from './types.js';
import { executeTool, openaiToolSchemas } from './tools.js';

type StepSink = (step: TraceStep) => void;
interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Run `prompt` until the model stops requesting tools or MAX_TURNS trips. */
export async function runHandrolled(prompt: string, config: ModelConfig, onStep?: StepSink): Promise<RunResult> {
  const startedAt = Date.now();
  const trace: TraceStep[] = [];
  const tokens: TokenUsage = { input: 0, output: 0, total: 0, reported: false };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const emit = (step: Omit<TraceStep, 'n'>): void => {
    trace.push({ ...step, n: trace.length + 1 });
    onStep?.(trace[trace.length - 1]!);
  };

  let iterations = 0;
  let toolCalls = 0;
  let answer = '';
  let answered = false;

  try {
    while (iterations < MAX_TURNS) {
      iterations += 1;
      const callStarted = Date.now();
      emit({
        kind: 'model_call',
        label: `Model call #${iterations}: ${messages.length} messages, ${openaiToolSchemas.length} tool schemas`,
        detail: { model: config.model, endpoint: `${config.baseUrl}/chat/completions`, tools: openaiToolSchemas.map((t) => t.function.name) },
      });

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(90_000),
        headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: openaiToolSchemas,
          tool_choice: 'auto',
          max_tokens: config.maxTokens ?? MAX_OUTPUT_TOKENS,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...EXTRA_BODY_PARAMS,
          stream: false,
        }),
      });
      const rawText = await response.text();
      if (!response.ok) throw new UpstreamError(`Upstream ${response.status} ${response.statusText}`, rawText.slice(0, 1500));

      let data: { choices?: { message: ChatMessage; finish_reason?: string }[]; usage?: Record<string, number> };
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new UpstreamError('Upstream returned a body that is not JSON', rawText.slice(0, 1500));
      }
      const choice = data.choices?.[0];
      if (!choice) throw new UpstreamError('Upstream returned no choices', rawText.slice(0, 1500));
      if (data.usage) {
        tokens.reported = true;
        tokens.input += data.usage['prompt_tokens'] ?? 0;
        tokens.output += data.usage['completion_tokens'] ?? 0;
        tokens.total += data.usage['total_tokens'] ?? (data.usage['prompt_tokens'] ?? 0) + (data.usage['completion_tokens'] ?? 0);
      }

      const calls = choice.message.tool_calls ?? [];
      const text = choice.message.content ?? '';
      emit({
        kind: 'model_response',
        label: calls.length ? `Model requested ${calls.length} tool call${calls.length === 1 ? '' : 's'}` : 'Model answered with text',
        ms: Date.now() - callStarted,
        detail: { finishReason: choice.finish_reason, text, toolCalls: calls, usage: data.usage ?? null },
      });
      messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });

      if (calls.length === 0) {
        answer = text.trim();
        answered = true;
        break;
      }

      for (const call of calls) {
        toolCalls += 1;
        const args = parseArguments(call.function.arguments);
        emit({ kind: 'tool_call', label: `${call.function.name}(${call.function.arguments || '{}'})`, detail: { name: call.function.name, arguments: args, callId: call.id } });
        const toolStarted = Date.now();
        let ok = true;
        let payload: string;
        try {
          payload = JSON.stringify(await executeTool(call.function.name, args));
        } catch (error) {
          ok = false;
          payload = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        emit({ kind: 'tool_result', label: `${call.function.name} -> ${ok ? 'ok' : 'error'}`, ms: Date.now() - toolStarted, detail: JSON.parse(payload) });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: payload });
      }
    }

    if (!answered) {
      emit({ kind: 'notice', label: `Max-iteration guard tripped at ${MAX_TURNS} turns without a text answer`, detail: { maxTurns: MAX_TURNS, iterations } });
      answer = `Loop stopped after ${iterations} model calls without producing a text answer.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = error instanceof UpstreamError ? redact(error.raw, config) : redact(message, config);
    emit({ kind: 'error', label: `Loop failed at model call #${iterations}: ${message}`, detail: { raw } });
    const failed = await buildResult(config, answer, trace, iterations, toolCalls, tokens, startedAt);
    return { ...failed, error: { message, raw } };
  }

  emit({ kind: 'answer', label: `Final answer after ${iterations} model call${iterations === 1 ? '' : 's'}`, detail: { answer, toolCalls } });
  return buildResult(config, answer, trace, iterations, toolCalls, tokens, startedAt);
}

async function buildResult(
  config: ModelConfig,
  answer: string,
  trace: TraceStep[],
  iterations: number,
  toolCalls: number,
  tokens: TokenUsage,
  startedAt: number,
): Promise<RunResult> {
  const { report } = await readServerFile('handrolled');
  return { path: 'handrolled', answer, trace, iterations, toolCalls, tokens, ms: Date.now() - startedAt, loc: report.loc, model: config.model, baseUrl: config.baseUrl };
}
