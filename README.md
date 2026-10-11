# relay

**The same agent, implemented twice, running side by side.**

Built by [Harish Kotra](https://harishkotra.me) · [Checkout my other builds](https://dailybuild.xyz)

`relay` is a demo you can disprove on screen. One agent — three tools, one system prompt, one turn
budget — is implemented two ways:

| | Path A · hand-written | Path B · Strands Agents TS 1.x |
| --- | --- | --- |
| file | `server/handrolled.ts` | `server/strands.ts` |
| loop | `while` over `/chat/completions`, written here | owned by `@strands-agents/sdk` |
| tool calls | parsed from `message.tool_calls` by hand | framework dispatches to the same functions |
| stop condition | hand-written guard at `MAX_TURNS` | declared `limits: { turns }` |
| what you write | the whole loop | the tools and the prompt |

Both paths run against the same task and the UI puts their **real tool-call traces, token counts,
latencies and line counts** next to each other. The claim — "a framework lets you delete the loop" —
is then something you can check, not something I assert in prose.

---

## Run it

```bash
npm install
npm run dev            # server on :3001, client on :5173
```

Open <http://127.0.0.1:5173>. The **Model config** panel is where the provider lives: base URL, API
key, model id, plus one-click presets for Particle.ai (default), LM Studio, Ollama, Gemini and any
custom OpenAI-compatible URL. It persists to `localStorage` and travels with every request — the
server has no provider defaults of its own.

Prefer a file? `cp .env.example .env` and set `RELAY_BASE_URL` / `RELAY_API_KEY` / `RELAY_MODEL`.
That path exists so `npm run verify` can run headless; the browser panel remains the primary way to
configure the app, and the key never has to touch disk.

```bash
npm run check          # model-free self-checks: tools, network freshness, LOC counter
npm run verify         # 3 tasks x 2 paths through the HTTP API -> .verify/<timestamp>.md
npm run loc            # the line counts the UI displays, from the same code
npm run build && npm start   # tsc + vite build, then node dist/server/index.js
```

## The three tasks

1. `What is 1873 * 42, and what is the current UTC time?` — needs `calculator` **and** `now_utc`.
2. `Fetch https://api.open-meteo.com/… and tell me what it says in one line.` — needs a real network call.
3. `Fetch …, then compute the sum of any numbers you found.` — chained tools; the two paths disagree
   here on purpose (see [divergence](#divergence-is-the-point)).

## Shared tools (`server/tools.ts`)

Implemented once, adapted twice: `openaiToolSchemas` + `executeTool` feed Path A's request body and
loop; `strandsTools` wraps **the same functions** in `tool({…})` objects for Path B. A trace
difference is therefore a difference in the loop, never in the tools.

- `calculator(expression)` — recursive-descent arithmetic (`+ - * / % ** ( )`), no `eval`, no
  `new Function`. `process.exit(1)` and `require('fs')` are rejected as parse errors.
- `live_fetch(url)` — a real `fetch` GET with a 15 s timeout; returns status, content-type,
  `fetchedAt` and the first 1600 characters of the actual body.
- `now_utc()` — the real system clock in UTC.

## Endpoints

| | shape |
| --- | --- |
| `POST /run/handrolled` | `{ answer, trace[], iterations, toolCalls, tokens, ms, loc, model, baseUrl }` |
| `POST /run/strands` | same shape |
| `POST /run/both` | both, keyed by path |
| `GET /tools` | shared tool list + JSON schemas |

Additions the UI needs, all read-only except `/models`:

| | why |
| --- | --- |
| `GET /source?file=…` | the code viewer shows the file from disk, not a copy pasted into the bundle. Allowlisted — no path traversal. |
| `GET /tasks` | the task dropdown |
| `GET /loc` | the same numbers `npm run loc` prints |
| `GET /health` | identity: `{"service":"relay"}`, so a port collision can't masquerade as this app |
| `POST /models` | proxies `{baseUrl}/models` because browsers can't fetch it directly (CORS) |

**Streaming.** Every `/run/*` endpoint returns the plain documented object by default. Send
`"stream": true` and the response becomes NDJSON — `{"type":"step"}` per trace entry, then
`{"type":"result"}` carrying that same documented object. The UI uses stream mode so you watch the
loop think; `curl` and the verifier use the plain shape.

## What is actually fair here

The comparison only means something if everything except the loop is equal, so:

- identical system prompt, identical tool set, identical `MAX_TURNS = 8`, identical
  `max_tokens`, identical extra body params — all in `server/agent-spec.ts`, imported by both paths;
- Path B's OpenAI client is pinned to `maxRetries: 0`, because Path A's raw `fetch` never retries and
  a silent retry would change what "one model call" counts as;
- `reasoning_effort: "none"` goes to both paths. `deepseek-v4.1-flash` on the default gateway
  otherwise spends the entire completion budget on hidden reasoning tokens and returns an empty
  `content` string, which a hand-written loop would report as "the model returned nothing";
- `/run/both` runs the paths **concurrently**, so each `ms` covers only its own loop but both share
  upstream latency. "Path A only" / "Path B only" give isolated timings, as does `npm run verify`.

## The line counts

`loc` is computed at request time by reading the real file and counting lines that hold something
other than a comment or whitespace (`server/loc.ts` tracks string/template/comment state, so
`"https://…"` inside a string is code, not a comment). Nothing is hardcoded.

<!-- LOC_TABLE -->

Two honest caveats, both visible in the UI:

1. **Path A came out longer than the ~120 lines the spec sketched.** The extra lines are trace
   payloads the UI renders — the arguments, the raw `tool_calls`, the per-call token usage. Strip the
   observability and the loop proper is smaller; it is still a loop you write and maintain.
2. **Path B's number has two readings.** `strands.ts` is the agent. `strands-trace.ts` exists only so
   the framework path can emit the same trace format the demo compares against; Path A needs no
   equivalent file because its loop emits those steps as a side effect of existing. The UI shows
   `24 (+143 trace bridge)` rather than picking the flattering one. If you only want the
   "delete the loop" headline, the 24-line file is real — and so is the bridge.

## <a name="divergence-is-the-point"></a>Divergence is the point

The diff strip compares trace step counts, model calls, tool calls, tokens, wall clock, LOC and tool
order, and lists where the two paths disagree — different tool order, different iteration count,
different answer, one path erroring. It never averages them into agreement. Two structural
differences show up even when both paths get the right answer:

- **who decides the next step.** Path A's stop condition is a line of code you can see; Path B's is
  the framework's `stopReason` (`'stop'`, `'toolUse'`, `'limitTurns'`, `'cancelled'`).
- **what a failure looks like.** Path A throws on a non-2xx and surfaces the raw upstream body;
  Strands classifies it (`ModelError`, `ModelThrottledError`, …) and may retry throttling before it
  re-raises.

## Verification

<!-- VERIFY_BLOCK -->

## Stack

TypeScript only, no framework lock-in on the hand-written side.

| piece | version |
| --- | --- |
| Node | v26.7.0 (npm 11.19.0) |
| `@strands-agents/sdk` | 1.20.0 (1.x line; `Agent`, `tool`, `OpenAIModel`) |
| `zod` / `openai` (SDK peers) | 4.6.5 / 6.49.0 |
| `hono` + `@hono/node-server` | 4.13.13 / 2.1.4 |
| `vite` / `react` / `react-dom` | 8.3.4 / 19.3.0 / 19.3.0 |
| `typescript` / `tsx` | 7.0.2 / 4.23.15 |

```
        browser (:5173, Vite dev proxy)
                    │  same-origin fetch, NDJSON
                    ▼
   Hono server (:3001)  ──GET /source──►  its own .ts files on disk
        │
        ├── POST /run/handrolled ──► server/handrolled.ts ─
        │                                  plain fetch    ├──► server/tools.ts
        └── POST /run/strands ─────► server/strands.ts ───┘   calculator
                                    @strands-agents/sdk        live_fetch → real HTTP
                                    (framework owns loop)      now_utc
```

## Layout

```
server/
  agent-spec.ts     shared prompt, turn cap, tasks, extra body params
  tools.ts          the three tools + both adapters
  handrolled.ts     Path A: the explicit loop
  strands.ts        Path B: the agent declaration
  strands-trace.ts  Path B hook events -> shared trace format
  loc.ts            runtime line counter
  config.ts         per-request provider config, redaction
  index.ts          Hono app, endpoints, NDJSON streaming
client/
  App.tsx  api.ts  diff.ts  styles.css
  components/PathColumn.tsx DiffStrip.tsx CodeViewer.tsx SettingsPanel.tsx
scripts/
  check.ts   model-free self-checks
  verify.ts  end-to-end verification through the API
  loc.ts     prints the LOC table
```

## Contributing

Small, in-scope ideas:

- **A third column** for a different framework, keeping the shared tool contract intact.
- **Cost per correct answer**: multiply the reported tokens by a per-model price table and rank the
  two paths.
- **Trace diff view**: align the two traces side by side per step instead of per column, and highlight
  the first divergent step.
- **Replay from a snapshot**: persist a run's trace and re-run it against a different model to see
  whether the divergence is the loop or the model.
- **A `tool_choice: 'required'` toggle** to measure how often each path skips a tool it was given.

Deliberately out of scope: auth, a database, deployment, streaming token-by-token rendering, and any
second agent framework. This is a two-implementation comparison and stops there.

---

Built by [Harish Kotra](https://harishkotra.me) · [Checkout my other builds](https://dailybuild.xyz)
