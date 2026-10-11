import type { RunResult, TraceStep } from './api.js';

export interface Divergence {
  kind: 'tools' | 'steps' | 'answer' | 'failure' | 'tokens' | 'iterations';
  detail: string;
}

/** Tool names in the order each path actually executed them. */
export function toolSequence(trace: TraceStep[]): string[] {
  return trace.filter((s) => s.kind === 'tool_call').map((s) => s.label.replace(/\(.*$/, ''));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Where do the two runs disagree? Deliberately conservative: it reports the
 * difference instead of explaining it away, and says so when there is none.
 */
export function findDivergences(a?: RunResult, b?: RunResult): Divergence[] {
  if (!a || !b) return [];
  const out: Divergence[] = [];

  const seqA = toolSequence(a.trace);
  const seqB = toolSequence(b.trace);
  if (seqA.join(',') !== seqB.join(',')) {
    out.push({ kind: 'tools', detail: `tool order differs — A: [${seqA.join(', ')}] vs B: [${seqB.join(', ')}]` });
  }

  if (a.iterations !== b.iterations) {
    out.push({ kind: 'iterations', detail: `model calls differ — A: ${a.iterations}, B: ${b.iterations}` });
  }

  if (a.trace.length !== b.trace.length) {
    out.push({ kind: 'steps', detail: `trace length differs — A: ${a.trace.length} steps, B: ${b.trace.length} steps` });
  }

  if (a.error || b.error) {
    const which = a.error && b.error ? 'both paths' : a.error ? 'Path A' : 'Path B';
    const message = (a.error ?? b.error)!.message;
    out.push({ kind: 'failure', detail: `${which} returned an error: ${message}` });
  } else if (normalize(a.answer) !== normalize(b.answer)) {
    out.push({ kind: 'answer', detail: 'answers differ in wording or numbers (shown above, unsmoothed)' });
  }

  if (a.tokens.reported !== b.tokens.reported) {
    out.push({ kind: 'tokens', detail: `only one path received token usage from upstream (A reported: ${a.tokens.reported}, B reported: ${b.tokens.reported})` });
  }

  return out;
}
