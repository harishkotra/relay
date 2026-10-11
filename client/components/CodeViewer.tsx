import { useEffect, useState } from 'react';
import { fetchSource, type SourceFile } from '../api.js';

const TABS = [
  { id: 'handrolled', label: 'server/handrolled.ts', blurb: 'Path A: the loop you write' },
  { id: 'strands', label: 'server/strands.ts', blurb: 'Path B: the agent you declare' },
  { id: 'strands-trace', label: 'server/strands-trace.ts', blurb: 'Path B observability bridge (not part of the agent)' },
  { id: 'tools', label: 'server/tools.ts', blurb: 'shared by both paths' },
  { id: 'agent-spec', label: 'server/agent-spec.ts', blurb: 'shared prompt, turn cap, tasks' },
];

/** Source is read from disk by the server on each tab switch, not bundled. */
export default function CodeViewer(): React.ReactElement {
  const [active, setActive] = useState('strands');
  const [file, setFile] = useState<SourceFile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    fetchSource(active)
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <section className="code">
      <div className="tabs">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" className={tab.id === active ? 'tab on' : 'tab'} onClick={() => setActive(tab.id)} title={tab.blurb}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="filemeta">
        {error ? (
          <span style={{ color: 'var(--bad)' }}>{error}</span>
        ) : file ? (
          <span>
            {file.path} · {file.loc} code lines · {file.commentOnlyLines} comment-only · {file.blankLines} blank · {file.totalLines} total · read from disk at request time
          </span>
        ) : (
          <span>loading…</span>
        )}
      </div>
      <pre className="source">{file ? file.content : ''}</pre>
    </section>
  );
}
