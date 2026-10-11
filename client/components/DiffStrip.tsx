import type { RunResult } from '../api.js';
import { findDivergences, toolSequence } from '../diff.js';

interface Props {
  a?: RunResult;
  b?: RunResult;
}

function cell(value: number | undefined, other: number | undefined, lowerIsBetter = true): string {
  if (value === undefined) return '—';
  if (other === undefined) return String(value);
  const delta = value - other;
  if (delta === 0) return `${value} (=)`;
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return `${value} (${delta > 0 ? '+' : ''}${delta}) ${better ? '◂' : ''}`.trim();
}

/** Side-by-side step counts and the places the two paths disagree, stated plainly. */
export default function DiffStrip({ a, b }: Props): React.ReactElement | null {
  if (!a && !b) return null;
  const divergences = findDivergences(a, b);
  const seqA = a ? toolSequence(a.trace) : [];
  const seqB = b ? toolSequence(b.trace) : [];
  const bridge = b?.locNote?.match(/\((\d+) lines\)/)?.[1];

  return (
    <section className="diff">
      <h2>Diff strip</h2>
      <div className="diff-body">
        <table className="compare">
          <thead>
            <tr>
              <th>measure</th>
              <th>Path A · hand-written</th>
              <th>Path B · Strands</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>trace steps</td>
              <td className="a">{cell(a?.trace.length, b?.trace.length)}</td>
              <td className="b">{cell(b?.trace.length, a?.trace.length)}</td>
            </tr>
            <tr>
              <td>model calls</td>
              <td className="a">{cell(a?.iterations, b?.iterations)}</td>
              <td className="b">{cell(b?.iterations, a?.iterations)}</td>
            </tr>
            <tr>
              <td>tool calls</td>
              <td className="a">{cell(a?.toolCalls, b?.toolCalls)}</td>
              <td className="b">{cell(b?.toolCalls, a?.toolCalls)}</td>
            </tr>
            <tr>
              <td>tokens (total)</td>
              <td className="a">{a?.tokens.reported ? cell(a.tokens.total, b?.tokens.total) : 'not reported'}</td>
              <td className="b">{b?.tokens.reported ? cell(b.tokens.total, a?.tokens.total) : 'not reported'}</td>
            </tr>
            <tr>
              <td>wall clock (ms)</td>
              <td className="a">{cell(a?.ms, b?.ms)}</td>
              <td className="b">{cell(b?.ms, a?.ms)}</td>
            </tr>
            <tr>
              <td>implementation LOC</td>
              <td className="a">{a ? String(a.loc) : '—'}</td>
              <td className="b">{b ? `${b.loc}${bridge ? ` (+${bridge} trace bridge = ${b.loc + Number(bridge)})` : ''}` : '—'}</td>
            </tr>
            <tr>
              <td>tool order</td>
              <td className="a">{seqA.join(' → ') || '—'}</td>
              <td className="b">{seqB.join(' → ') || '—'}</td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 10 }}>
          {a && b && divergences.length === 0 ? (
            <span className="div-none">no divergence detected: same tools, same order, same step count, matching answers</span>
          ) : (
            <div className="divergence-list">
              {divergences.length === 0 ? (
                <span className="hint">run both paths to compare</span>
              ) : (
                divergences.map((d) => (
                  <div className="div-item" key={`${d.kind}-${d.detail}`}>
                    <b>{d.kind}</b> {d.detail}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <p className="hint">
          /run/both runs the two paths concurrently, so wall-clock numbers share upstream latency; use "Run Path A only" / "Run Path B only" for isolated timings.
        </p>
      </div>
    </section>
  );
}
