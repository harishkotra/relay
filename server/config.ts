// Per-request provider configuration. The client sends the config with every
// run; the server keeps no provider defaults of its own beyond optional
// environment fallbacks, so switching provider is a UI change, not a code edit.

import type { ModelConfig } from './types.js';

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function resolveConfig(input: Partial<ModelConfig> | undefined, env: Env): ModelConfig {
  const raw = input ?? {};
  const baseUrl = (raw.baseUrl ?? env.RELAY_BASE_URL ?? env.OPENAI_BASE_URL ?? '').trim();
  const apiKey = (raw.apiKey ?? env.RELAY_API_KEY ?? env.OPENAI_API_KEY ?? '').trim();
  const model = (raw.model ?? env.RELAY_MODEL ?? env.OPENAI_MODEL ?? '').trim();

  if (!baseUrl) {
    throw new ConfigError(
      'No base URL for this run. Open Settings in the UI and set a provider base URL (or start the server with RELAY_BASE_URL).',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError(`Base URL is not a valid absolute URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`Base URL must be http(s), got ${parsed.protocol}`);
  }
  if (!model) throw new ConfigError('No model id for this run. Set one in Settings (or RELAY_MODEL).');

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    temperature: raw.temperature,
    maxTokens: raw.maxTokens,
  };
}

/** Local servers (LM Studio, Ollama) accept any key; cloud gateways do not. */
function isLocalTarget(baseUrl: string): boolean {
  const { hostname } = new URL(baseUrl);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');
}

export function assertUsable(config: ModelConfig): void {
  if (!config.apiKey && !isLocalTarget(config.baseUrl)) {
    throw new ConfigError(
      `No API key for ${config.baseUrl}. Add one in Settings, or keep the key in this project's .env as RELAY_API_KEY.`,
    );
  }
}

/** Never let a secret reach a trace, a log line, or the client. */
export function redact(text: string, config: ModelConfig): string {
  if (!config.apiKey) return text;
  return text.split(config.apiKey).join('***');
}
