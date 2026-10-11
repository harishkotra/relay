// The three tools, implemented once. Path A consumes `openaiToolSchemas` +
// `executeTool`; Path B consumes `strandsTools`. Same functions, same JSON
// schemas, same code, so a difference in the traces is a difference in the loop.

import { tool } from '@strands-agents/sdk';
import { DEMO_LIVE_URL } from './agent-spec.js';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * Recursive-descent arithmetic evaluator. No eval / new Function: an expression
 * that contains anything other than digits, operators, parens and spaces fails.
 * Precedence is unary < ** (right assoc) < * / % < + -.
 */
export function evaluateExpression(source: string): number {
  const s = source.replace(/\s+/g, '');
  if (s.length === 0) throw new Error('empty expression');
  let i = 0;

  const peek = (): string => s[i] ?? '';
  const eat = (token: string): boolean => {
    if (s.startsWith(token, i)) {
      i += token.length;
      return true;
    }
    return false;
  };

  const parseNumber = (): number => {
    const match = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!match) throw new Error(`unexpected '${peek() || 'end of input'}' at position ${i}`);
    i += match[0].length;
    return Number(match[0]);
  };

  const parsePrimary = (): number => {
    if (eat('(')) {
      const value = parseExpression();
      if (!eat(')')) throw new Error('missing closing parenthesis');
      return value;
    }
    return parseNumber();
  };

  const parseUnary = (): number => {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePrimary();
  };

  const parsePower = (): number => {
    const base = parseUnary();
    if (eat('**')) return base ** parsePower();
    return base;
  };

  const parseTerm = (): number => {
    let value = parsePower();
    for (;;) {
      if (eat('*')) value *= parsePower();
      else if (eat('/')) value /= parsePower();
      else if (eat('%')) value %= parsePower();
      else return value;
    }
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      if (eat('+')) value += parseTerm();
      else if (eat('-')) value -= parseTerm();
      else return value;
    }
  };

  const result = parseExpression();
  if (i < s.length) throw new Error(`unexpected '${s[i]}' at position ${i}`);
  if (!Number.isFinite(result)) throw new Error('result is not finite');
  return result;
}

export const MAX_BODY_CHARS = 1600;

function truncate(text: string, limit = MAX_BODY_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]` : text;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'calculator',
    description:
      'Evaluate an arithmetic expression and return the number. Supports + - * / % ** ( ) and decimals. Use this instead of doing arithmetic yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Arithmetic expression, e.g. "1873 * 42" or "(2 + 3) * 4".',
        },
      },
      required: ['expression'],
    },
    run: ({ expression }) => {
      const value = evaluateExpression(String(expression));
      return { expression: String(expression), result: value };
    },
  },
  {
    name: 'live_fetch',
    description: `Perform a real HTTP GET against a live public endpoint and return the status plus a truncated response body. Defaults to ${DEMO_LIVE_URL} when no url is given.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: `Absolute http(s) URL to fetch. Omit to fetch the default live endpoint (${DEMO_LIVE_URL}).`,
        },
      },
      required: [],
    },
    run: async ({ url }) => {
      const target = url === undefined || url === '' ? DEMO_LIVE_URL : String(url);
      const parsed = new URL(target);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`refusing protocol ${parsed.protocol}`);
      }
      const started = Date.now();
      const response = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'relay-demo/1.0' },
      });
      const text = truncate(await response.text());
      return {
        url: target,
        status: response.status,
        contentType: response.headers.get('content-type') ?? null,
        fetchedAt: new Date().toISOString(),
        ms: Date.now() - started,
        body: text,
      };
    },
  },
  {
    name: 'now_utc',
    description: 'Return the real current UTC time from the system clock. No input.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => {
      const now = new Date();
      return {
        iso: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        time: `${now.toISOString().slice(11, 19)} UTC`,
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
        epochSeconds: Math.floor(now.getTime() / 1000),
      };
    },
  },
];

/** Wire format for the hand-written path's /chat/completions `tools` field. */
export const openaiToolSchemas = TOOLS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

/** Registry view for GET /tools. */
export const toolCatalog = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

export async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`unknown tool '${name}'`);
  return def.run(input ?? {});
}

/** The same tool objects, wrapped for the framework path. One implementation, two adapters. */
export const strandsTools = TOOLS.map((t) =>
  tool({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as never,
    callback: (input: unknown) => t.run((input ?? {}) as Record<string, unknown>),
  }),
);
