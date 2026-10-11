// Client-side view of the server contract. Types come from the server module so
// the two sides cannot drift; nothing here is erased-at-runtime unsafe.

export type { PathId, RunResult, TokenUsage, TraceStep } from '../server/types';
import type { PathId, RunResult, TraceStep } from '../server/types';

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const CONFIG_KEY = 'relay.config.v1';

/** The documented default provider. Nothing is baked into the server. */
export const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
};

export interface Preset {
  id: string;
  label: string;
  config: ModelConfig;
  note: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'particle',
    label: 'Particle.ai',
    config: { baseUrl: 'https://api.particle.ai/v1', apiKey: '', model: 'deepseek-v4.1-flash' },
    note: 'default; needs an API key',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    config: { baseUrl: 'http://localhost:1234/v1', apiKey: '', model: '' },
    note: 'local, no key needed',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' },
    note: 'local, no key needed',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    config: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash' },
    note: 'OpenAI-compatible mode; needs an API key',
  },
  {
    id: 'custom',
    label: 'Custom URL',
    config: { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', model: '' },
    note: 'any OpenAI-compatible /chat/completions server',
  },
];

export function loadConfig(): ModelConfig {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (!stored) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(stored) as Partial<ModelConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: ModelConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export interface TaskInfo {
  id: string;
  label: string;
  expect: string;
  prompt: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface SourceFile {
  file: string;
  path: string;
  content: string;
  loc: number;
  commentOnlyLines: number;
  blankLines: number;
  totalLines: number;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 400);
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`${response.status} ${message}`);
  }
  return JSON.parse(text) as T;
}

export const fetchTasks = (): Promise<{ tasks: TaskInfo[]; maxTurns: number }> => json('/tasks');
export const fetchTools = (): Promise<{ tools: ToolInfo[]; defaultLiveUrl: string }> => json('/tools');
export const fetchSource = (file: string): Promise<SourceFile> => json(`/source?file=${encodeURIComponent(file)}`);
export const fetchHealth = (): Promise<Record<string, unknown>> => json('/health');

export function fetchModels(config: ModelConfig): Promise<{ models: string[] }> {
  return json('/models', { method: 'POST', body: JSON.stringify({ config }) });
}

export type RunEvent =
  | { type: 'config'; model: string; baseUrl: string; hasKey: boolean }
  | { type: 'step'; path: PathId; step: TraceStep }
  | { type: 'result'; path: PathId; result: RunResult }
  | { type: 'error'; path: PathId; message: string; raw?: string }
  | { type: 'done' };

/** POST a run and hand each NDJSON line to onEvent as it arrives. */
export async function streamRun(paths: PathId[] | 'both', body: Record<string, unknown>, onEvent: (event: RunEvent) => void, signal?: AbortSignal): Promise<void> {
  const endpoint = paths === 'both' ? '/run/both' : `/run/${paths[0]}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(message.slice(0, 600));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as RunEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as RunEvent);
}
