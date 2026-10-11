// The parts of the agent that must be byte-identical across both paths: the
// system prompt, the iteration guard, and the three demo tasks. Deliberately
// separate from either implementation so neither path gets an advantage.

export const SYSTEM_PROMPT = `You are Relay, a precise assistant with tools.
Rules:
- Use a tool whenever the answer depends on arithmetic, live data, or the current time. Never compute or guess those from memory.
- Call calculator for every arithmetic expression, one expression per call.
- Call live_fetch to read a URL, and now_utc when the current time is asked for.
- After tool results come back, answer in one short sentence using those results.
- Do not repeat a tool call that already returned a usable result.`;

/** Both paths stop after this many model round-trips. */
export const MAX_TURNS = 8;

/** Per-call completion budget, identical on both paths. */
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * Extra fields merged into the chat request body by BOTH paths, so the
 * comparison stays fair. `reasoning_effort: 'none'` is there because
 * deepseek-v4.1-flash on api.particle.ai otherwise spends the entire completion
 * budget on hidden reasoning tokens and returns an empty `content` string.
 */
export const EXTRA_BODY_PARAMS: Record<string, unknown> = { reasoning_effort: 'none' };

export interface DemoTask {
  id: string;
  label: string;
  /** Shown as the expected outcome so a wrong-but-confident answer is visible. */
  expect: string;
  prompt: string;
}

export const DEMO_LIVE_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,wind_speed_10m&forecast_days=1';

export const TASKS: DemoTask[] = [
  {
    id: 'calc-time',
    label: 'Arithmetic + current UTC time',
    expect: '78666 and the real current UTC time',
    prompt: 'What is 1873 * 42, and what is the current UTC time?',
  },
  {
    id: 'fetch-summary',
    label: 'Fetch a live endpoint, one line',
    expect: `A one-line reading of the real response body from ${DEMO_LIVE_URL}`,
    prompt: `Fetch ${DEMO_LIVE_URL} and tell me what it says in one line.`,
  },
  {
    id: 'fetch-sum',
    label: 'Fetch, then sum the numbers found',
    expect: 'live_fetch followed by calculator; the sum depends on which numbers the model picks',
    prompt: `Fetch ${DEMO_LIVE_URL}, then compute the sum of any numbers you found.`,
  },
];
