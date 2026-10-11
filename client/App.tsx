import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  fetchHealth,
  fetchTasks,
  fetchTools,
  loadConfig,
  saveConfig,
  streamRun,
  type ModelConfig,
  type PathId,
  type RunEvent,
  type RunResult,
  type TaskInfo,
  type ToolInfo,
  type TraceStep,
} from './api.js';
import PathColumn from './components/PathColumn.js';
import DiffStrip from './components/DiffStrip.js';
import CodeViewer from './components/CodeViewer.js';
import SettingsPanel from './components/SettingsPanel.js';

type Status = 'idle' | 'running' | 'done' | 'error';

interface RunState {
  steps: Record<PathId, TraceStep[]>;
  results: Record<PathId, RunResult | undefined>;
}

const EMPTY: RunState = { steps: { handrolled: [], strands: [] }, results: { handrolled: undefined, strands: undefined } };

export default function App(): React.ReactElement {
  const [config, setConfig] = useState<ModelConfig>(() => loadConfig());
  const [showSettings, setShowSettings] = useState(() => !localStorage.getItem('relay.config.v1'));
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [serverInfo, setServerInfo] = useState<Record<string, unknown>>({});
  const [taskId, setTaskId] = useState('calc-time');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [run, setRun] = useState<RunState>(EMPTY);
  const [banner, setBanner] = useState('');
  const abort = useRef<AbortController | null>(null);
  const runRef = useRef<((paths: PathId[] | 'both', promptOverride?: string) => Promise<void>) | null>(null);

  useEffect(() => {
    fetchTasks()
      .then(({ tasks: list }) => {
        setTasks(list);
        // Deep links make each UI state reachable without clicking:
        // ?task=fetch-sum&autorun=1&paths=both
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get('task');
        const chosen = (wanted ? list.find((t) => t.id === wanted) : undefined) ?? list[0];
        if (!chosen) return;
        setTaskId(chosen.id);
        const text = params.get('prompt') ?? chosen.prompt;
        setPrompt(text);
        if (params.get('autorun') === '1') {
          setShowSettings(false);
          const raw = params.get('paths');
          const paths: PathId[] | 'both' = raw === 'handrolled' || raw === 'strands' ? [raw] : 'both';
          void runRef.current?.(paths, text);
        }
      })
      .catch((error: unknown) => setBanner(`server unreachable: ${error instanceof Error ? error.message : String(error)}`));
    fetchTools()
      .then((result) => setTools(result.tools))
      .catch(() => setTools([]));
    fetchHealth()
      .then(setServerInfo)
      .catch(() => setServerInfo({}));
  }, []);

  const pickTask = (id: string): void => {
    setTaskId(id);
    const task = tasks.find((t) => t.id === id);
    if (task) setPrompt(task.prompt);
  };

  const selected = useMemo(() => tasks.find((t) => t.id === taskId), [tasks, taskId]);

  const startRun = useCallback(
    async (paths: PathId[] | 'both', promptOverride?: string): Promise<void> => {
      const runPrompt = (promptOverride ?? prompt).trim();
      if (!runPrompt) {
        setBanner('Nothing to run: type a prompt or pick a task.');
        return;
      }
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setStatus('running');
      setBanner('');
      setRun(structuredClone(EMPTY));
      const onEvent = (event: RunEvent): void => {
        if (event.type === 'step') {
          setRun((current) => ({ ...current, steps: { ...current.steps, [event.path]: [...current.steps[event.path], event.step] } }));
        } else if (event.type === 'result') {
          setRun((current) => ({ ...current, results: { ...current.results, [event.path]: event.result } }));
        } else if (event.type === 'error') {
          setRun((current) => ({
            ...current,
            results: {
              ...current.results,
              [event.path]: {
                path: event.path,
                answer: '',
                trace: current.steps[event.path],
                iterations: 0,
                toolCalls: 0,
                tokens: { input: 0, output: 0, total: 0, reported: false },
                ms: 0,
                loc: 0,
                model: config.model,
                baseUrl: config.baseUrl,
                error: { message: event.message, raw: event.raw },
              },
            },
          }));
        }
      };

      try {
        await streamRun(paths, { prompt: runPrompt, config, sequential: paths === 'both' ? false : undefined }, onEvent, controller.signal);
        setStatus('done');
      } catch (error) {
        if (controller.signal.aborted) {
          setStatus('idle');
          setBanner('Run cancelled.');
        } else {
          setStatus('error');
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [prompt, config],
  );
  runRef.current = startRun;

  const persist = (next: ModelConfig): void => {
    setConfig(next);
    saveConfig(next);
  };

  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return 'invalid base URL';
    }
  };
  const providerLabel = `${config.model || 'no model'} @ ${hostOf(config.baseUrl)}${config.apiKey ? '' : ' · no key'}`;

  return (
    <div className="app">
      <header className="top">
        <h1>relay</h1>
        <span className="tagline">one agent, two implementations: a hand-written loop and a Strands Agents TS 1.x agent, on the same tasks</span>
        <span className="spacer" />
        <span className="chip">{String((serverInfo as { service?: string }).service ?? 'server: unknown')}</span>
        <span className={config.apiKey || config.baseUrl.includes('localhost') ? 'chip' : 'chip warn'}>{providerLabel}</span>
        <button type="button" className="ghost" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? 'hide config' : 'config'}
        </button>
      </header>

      <div className="controls">
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="field">
            <label htmlFor="task">Task</label>
            <select id="task" value={taskId} onChange={(e) => pickTask(e.target.value)}>
              {tasks.map((task, index) => (
                <option key={task.id} value={task.id}>
                  {index + 1}. {task.label}
                </option>
              ))}
              <option value="custom">Custom (edit the prompt below)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="prompt">Prompt</label>
            <textarea id="prompt" value={prompt} onChange={(e) => { setPrompt(e.target.value); setTaskId('custom'); }} spellCheck={false} />
          </div>
          {selected && <p className="hint">expected: {selected.expect}</p>}
        </div>

        <div className="run-row">
          <button type="button" className="action primary" onClick={() => void startRun('both')} disabled={status === 'running'}>
            {status === 'running' ? 'running…' : 'Run both'}
          </button>
          <button type="button" className="action" onClick={() => void startRun(['handrolled'])} disabled={status === 'running'}>
            Path A only
          </button>
          <button type="button" className="action" onClick={() => void startRun(['strands'])} disabled={status === 'running'}>
            Path B only
          </button>
          <button type="button" className="ghost" onClick={() => { abort.current?.abort(); setRun(structuredClone(EMPTY)); setStatus('idle'); setBanner(''); }}>
            reset
          </button>
        </div>
      </div>

      {banner && <div className="answer err" style={{ marginBottom: 12 }}><span className="label">error</span>{banner}</div>}

      {showSettings && (
        <SettingsPanel
          config={config}
          onSave={(next) => {
            persist(next);
            setShowSettings(false);
          }}
          busy={status === 'running'}
        />
      )}

      <div className="columns">
        <PathColumn path="handrolled" steps={run.steps.handrolled} result={run.results.handrolled} running={status === 'running' && !run.results.handrolled} />
        <PathColumn path="strands" steps={run.steps.strands} result={run.results.strands} running={status === 'running' && !run.results.strands} />
      </div>

      <DiffStrip a={run.results.handrolled} b={run.results.strands} />

      {tools.length > 0 && (
        <section className="diff">
          <h2>Shared tools (GET /tools)</h2>
          <div className="diff-body">
            {tools.map((tool) => (
              <div key={tool.name} style={{ marginBottom: 8 }}>
                <b>{tool.name}</b> <span className="hint">{tool.description}</span>
              </div>
            ))}
            <p className="hint">Defined once in server/tools.ts. Path A sends their JSON schemas to /chat/completions and calls the same functions in its loop; Path B hands the same functions to the framework as tool objects.</p>
          </div>
        </section>
      )}

      <CodeViewer />

      <footer className="note">
        Built by{' '}
        <a href="https://harishkotra.me" style={{ color: 'var(--b)' }}>
          Harish Kotra
        </a>{' '}
        ·{' '}
        <a href="https://dailybuild.xyz" style={{ color: 'var(--b)' }}>
          other builds
        </a>{' '}
        · defaults: {DEFAULT_CONFIG.model} @ {DEFAULT_CONFIG.baseUrl}
      </footer>
    </div>
  );
}
