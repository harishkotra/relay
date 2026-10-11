// Path B: the same agent, declared rather than looped. There is no while
// statement, no message-array bookkeeping, no tool_call parsing and no stop
// condition in this file -- the framework owns the loop.

import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { EXTRA_BODY_PARAMS, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from './agent-spec.js';
import { strandsTools } from './tools.js';
import type { ModelConfig } from './types.js';

export function createAgent(config: ModelConfig): Agent {
  return new Agent({
    model: new OpenAIModel({
      api: 'chat',
      modelId: config.model,
      apiKey: config.apiKey || 'relay-local-server',
      clientConfig: {
        baseURL: config.baseUrl,
        // Path A uses raw fetch, which never retries. The OpenAI client retries
        // twice by default, which would silently change what "one model call"
        // means between the two paths, so it is pinned to a single attempt.
        maxRetries: 0,
      },
      maxTokens: config.maxTokens ?? MAX_OUTPUT_TOKENS,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      params: EXTRA_BODY_PARAMS,
    }),
    tools: strandsTools,
    systemPrompt: SYSTEM_PROMPT,
    printer: false,
  });
}
