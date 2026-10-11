import { useState } from 'react';
import type { PathId, RunResult, TraceStep } from '../api.js';

const DESCRIPTION: Record<PathId, string> = {
  handrolled: 'explicit while-loop over /chat/completions',
  strands: '@strands-agents/sdk Agent, framework-owned loop',
};

function StepRow({ step, defaultOpen }: { step: TraceStep; defaultOpen: boolean }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = step.detail !== undefined;
  return (
    <div className="step">
      <button type="button" className="step-head" onClick={() => setOpen((v) => !v)} disabled={!hasDetail} aria-expanded={open}>
        <span className="step-num">{String(step.n).padStart(2, '0')}</span>
        <span className={`kind ${step.kind}`}>{step.kind}</span>
        <span className="step-label">{step.label}</span>
        {step.ms !== undefined && <span className="step-ms">{step.ms}ms</span>}
        {hasDetail && <span className="step-ms">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasDetail && <pre className="step-detail">{JSON.stringify(step.detail, null, 2)}</pre>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="metric">
      <span className="k">{label}</span>
      <span>{value}</span>
    </div>
  );
}

interface Props {
  path: PathId;
  result?: RunResult;
  steps: TraceStep[];
  running: boolean;
}

export default function PathColumn({ path, result, steps, running }: Props): React.ReactElement {
  const shown = result?.trace.length ? result.trace : steps;
  const tokens = result?.tokens;
  const answer = result?.answer;
  const failed = Boolean(result?.error);

  return (
    <section className="column" data-path={path}>
      <header className="col-head">
        <span className="name">{path === 'handrolled' ? 'Path A · hand-written' : 'Path B · Strands 1.x'}</span>
        <span className="desc">{DESCRIPTION[path]}</span>
        <span className="spacer" />
        {running && <span className="chip warn">running</span>}
      </header>

      <div className="metrics">
        <Metric label="model calls" value={result ? String(result.iterations) : '—'} />
        <Metric label="tool calls" value={result ? String(result.toolCalls) : '—'} />
        <Metric label="tokens" value={tokens ? (tokens.reported ? `${tokens.input}+${tokens.output}=${tokens.total}` : 'not reported') : '—'} />
        <Metric label="wall clock" value={result ? `${result.ms}ms` : '—'} />
        <Metric label="impl LOC" value={result ? String(result.loc) : '—'} />
      </div>

      <div className={failed ? 'answer err' : 'answer'}>
        <span className="label">{failed ? 'no answer (see error)' : 'answer'}</span>
        {answer ? answer : running ? 'waiting for the loop to finish…' : shown.length ? 'running…' : 'not run yet'}
        {failed && <div className="upstream">{`upstream error: ${result?.error?.message}\n\n${result?.error?.raw ?? ''}`.trim()}</div>}
        {result?.locNote && <div className="hint">{result.locNote}</div>}
      </div>

      {shown.length === 0 ? (
        <div className="empty">no trace yet — pick a task and Run both</div>
      ) : (
        <div className="trace">
          {shown.map((step) => (
            <StepRow key={step.n} step={step} defaultOpen={step.kind === 'error' || step.kind === 'notice' || (step.kind === 'tool_call' && shown.length <= 6)} />
          ))}
        </div>
      )}
    </section>
  );
}
