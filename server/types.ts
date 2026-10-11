// Shared vocabulary between the two implementations. Both paths produce exactly
// this shape, which is what makes the comparison side by side meaningful.

/** One entry in the step-by-step trace rendered by the client. */
export interface TraceStep {
  /** 1-based position in this path's own trace. */
  n: number;
  kind: 'model_call' | 'model_response' | 'tool_call' | 'tool_result' | 'answer' | 'notice' | 'error';
  /** Short human-readable label shown in the collapsed row. */
  label: string;
  /** Structured payload: tool arguments, tool output, model text, token counts. */
  detail?: unknown;
  /** Wall-clock milliseconds for this step, when measured. */
  ms?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** True when the upstream did not report usage and the numbers are unavailable. */
  reported: boolean;
}

/** The documented response shape of POST /run/handrolled and POST /run/strands. */
export interface RunResult {
  path: PathId;
  answer: string;
  trace: TraceStep[];
  /** Model round-trips performed. Strands calls these cycles; Path A counts its loop passes. */
  iterations: number;
  toolCalls: number;
  tokens: TokenUsage;
  ms: number;
  /** Non-comment, non-blank lines of this path's implementation file, read from disk. */
  loc: number;
  /** Second LOC number when instrumentation lives outside the implementation file. */
  locNote?: string;
  model: string;
  baseUrl: string;
  /** Raw upstream error text, surfaced verbatim in the UI when a path fails. */
  error?: { message: string; raw?: string };
}

export type PathId = 'handrolled' | 'strands';

export const PATHS: PathId[] = ['handrolled', 'strands'];

/** Per-request provider config. Nothing about the provider is fixed server-side. */
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Forwarded verbatim into the chat request body by both paths. */
  temperature?: number;
  maxTokens?: number;
}

/** NDJSON envelope used when a run is requested with stream=true. */
export type StreamEvent =
  | { type: 'config'; baseUrl: string; model: string; hasKey: boolean }
  | { type: 'step'; path: PathId; step: TraceStep }
  | { type: 'result'; path: PathId; result: RunResult }
  | { type: 'error'; path: PathId; message: string; raw?: string }
  | { type: 'done' };
