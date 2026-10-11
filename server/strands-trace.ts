// Observability bridge for Path B, kept out of strands.ts so the line count
// reported for the framework path is the line count of the agent declaration.
// Path A needs no equivalent file: its loop already contains these steps.

import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  ToolResultEvent,
  type AgentResult,
  type ContentBlock,
  type ToolResultBlock,
} from '@strands-agents/sdk';
import { MAX_TURNS } from './agent-spec.js';
import { redact } from './config.js';
import { readServerFile } from './loc.js';
import { createAgent } from './strands.js';
import type { ModelConfig, RunResult, TokenUsage, TraceStep } from './types.js';

type StepSink = (step: TraceStep) => void;

function blocksOf(message: { content: ContentBlock[] } | undefined, kind: string): ContentBlock[] {
  return message?.content.filter((b) => b.type === kind) ?? [];
}

function textOf(message: { content: ContentBlock[] } | undefined): string {
  return blocksOf(message, 'textBlock')
    .map((b) => ('text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim();
}

function resultPayload(result: ToolResultBlock): unknown {
  const parts = result.content.map((c) => {
    if (c.type === 'textBlock') return { text: c.text };
    if (c.type === 'jsonBlock') return { json: c.json };
    return { type: c.type };
  });
  return { status: result.status, content: parts };
}

export async function runStrands(prompt: string, config: ModelConfig, onStep?: StepSink): Promise<RunResult> {
  const startedAt = Date.now();
  const trace: TraceStep[] = [];
  const tokens: TokenUsage = { input: 0, output: 0, total: 0, reported: false };
  let iterations = 0;
  let toolCalls = 0;
  let modelCallStartedAt = Date.now();

  const emit = (step: Omit<TraceStep, 'n'>): void => {
    trace.push({ ...step, n: trace.length + 1 });
    onStep?.(trace[trace.length - 1]!);
  };

  const agent = createAgent(config);

  agent.addHook(BeforeModelCallEvent, () => {
    modelCallStartedAt = Date.now();
    iterations += 1;
    emit({
      kind: 'model_call',
      label: `Model call #${iterations}: driven by the framework loop`,
      detail: { model: config.model, endpoint: `${config.baseUrl}/chat/completions`, tools: undefined },
    });
  });

  agent.addHook(AfterModelCallEvent, (event) => {
    const message = event.stopData?.message;
    const requested = blocksOf(message, 'toolUseBlock').map((b) => ({
      name: 'name' in b ? b.name : undefined,
      input: 'input' in b ? b.input : undefined,
    }));
    emit({
      kind: 'model_response',
      label: event.error
        ? `Model call failed: ${event.error.message}`
        : requested.length
          ? `Model requested ${requested.length} tool call${requested.length === 1 ? '' : 's'}`
          : 'Model answered with text',
      ms: Date.now() - modelCallStartedAt,
      detail: { stopReason: event.stopData?.stopReason, text: textOf(message), toolCalls: requested, error: event.error?.message },
    });
  });

  agent.addHook(BeforeToolCallEvent, (event) => {
    toolCalls += 1;
    emit({
      kind: 'tool_call',
      label: `${event.toolUse.name}(${JSON.stringify(event.toolUse.input ?? {})})`,
      detail: { name: event.toolUse.name, arguments: event.toolUse.input, callId: event.toolUse.toolUseId },
    });
  });

  agent.addHook(ToolResultEvent, (event) => {
    emit({ kind: 'tool_result', label: `${event.result.toolUseId.slice(0, 8)} -> ${event.result.status}`, detail: resultPayload(event.result) });
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    if (event.error) emit({ kind: 'error', label: `${event.toolUse.name} threw: ${event.error.message}`, detail: { name: event.toolUse.name } });
  });

  try {
    const result: AgentResult = await agent.invoke(prompt, { limits: { turns: MAX_TURNS } });
    const invocation = result.metrics?.latestAgentInvocation;
    const usage = invocation?.usage ?? result.metrics?.accumulatedUsage;
    if (usage) {
      tokens.reported = true;
      tokens.input = usage.inputTokens;
      tokens.output = usage.outputTokens;
      tokens.total = usage.totalTokens;
    }
    // Prefer the framework's own cycle count; the hook counter is the cross-check.
    const frameworkCycles = result.metrics?.cycleCount ?? iterations;
    const answer = result.toString().trim();
    emit({
      kind: 'notice',
      label: `Framework reported ${frameworkCycles} cycle${frameworkCycles === 1 ? '' : 's'} and ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`,
      detail: {
        stopReason: result.stopReason,
        usage: usage ?? null,
        cycles: invocation?.cycles ?? null,
        hookCountedModelCalls: iterations,
        contextSize: result.contextSize ?? null,
      },
    });
    if (result.stopReason === 'limitTurns') {
      emit({ kind: 'notice', label: `Turn limit of ${MAX_TURNS} tripped before the model produced an answer`, detail: { maxTurns: MAX_TURNS, iterations } });
    }
    emit({ kind: 'answer', label: `Final answer after ${iterations} model call${iterations === 1 ? '' : 's'}`, detail: { answer, toolCalls } });
    return await build(config, answer, trace, frameworkCycles, toolCalls, tokens, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    emit({ kind: 'error', label: `Agent failed during model call #${iterations}: ${message}`, detail: { raw: redact(raw, config), stopReason: 'error' } });
    return await build(config, '', trace, iterations, toolCalls, tokens, startedAt, { message, raw: redact(raw, config) });
  }
}

async function build(
  config: ModelConfig,
  answer: string,
  trace: TraceStep[],
  iterations: number,
  toolCalls: number,
  tokens: TokenUsage,
  startedAt: number,
  error?: { message: string; raw?: string },
): Promise<RunResult> {
  const implementation = await readServerFile('strands');
  const bridge = await readServerFile('strands-trace');
  return {
    path: 'strands',
    answer,
    trace,
    iterations,
    toolCalls,
    tokens,
    ms: Date.now() - startedAt,
    loc: implementation.report.loc,
    locNote: `strands.ts declares the agent (${implementation.report.loc} lines); strands-trace.ts bridges the framework's hook events into this shared trace format (${bridge.report.loc} lines). Path A needs no bridge file because its loop emits these steps itself.`,
    model: config.model,
    baseUrl: config.baseUrl,
    ...(error ? { error } : {}),
  };
}
