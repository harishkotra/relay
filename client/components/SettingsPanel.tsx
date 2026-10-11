import { useState } from 'react';
import { fetchModels, PRESETS, type ModelConfig } from '../api.js';

interface Props {
  config: ModelConfig;
  onSave: (config: ModelConfig) => void;
  onRunOne?: (path: 'handrolled' | 'strands') => void;
  busy: boolean;
}

/** Provider config, persisted to localStorage and sent with every request. */
export default function SettingsPanel({ config, onSave, onRunOne, busy }: Props) {
  const [draft, setDraft] = useState<ModelConfig>(config);
  const [preset, setPreset] = useState<string>('particle');
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<string>('');

  const set = (patch: Partial<ModelConfig>): void => setDraft((current) => ({ ...current, ...patch }));

  const applyPreset = (id: string): void => {
    const found = PRESETS.find((p) => p.id === id);
    if (!found) return;
    setPreset(id);
    // Presets set provider + model but never clear a key the user already typed.
    setDraft({ baseUrl: found.config.baseUrl, model: found.config.model, apiKey: draft.apiKey });
    setStatus(`${found.label}: ${found.note}`);
  };

  const save = (): void => {
    onSave(draft);
    setStatus('Saved to this browser (localStorage). The server keeps no copy.');
  };

  const loadModels = async (): Promise<void> => {
    setStatus('asking the provider for its model list…');
    try {
      const result = await fetchModels(draft);
      setModels(result.models);
      setStatus(`${result.models.length} models from ${draft.baseUrl}`);
    } catch (error) {
      setModels([]);
      setStatus(`model list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <section className="settings">
      <h2>Model config</h2>
      <div className="settings-grid">
        <div className="field">
          <label htmlFor="baseurl">Base URL</label>
          <input id="baseurl" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.particle.ai/v1" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="apikey">API key</label>
          <input id="apikey" type="password" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder="local servers can leave this empty" spellCheck={false} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="model">Model id</label>
          <input id="model" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="deepseek-v4.1-flash" spellCheck={false} />
        </div>
      </div>

      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.id} className={p.id === preset ? 'action primary' : 'action'} onClick={() => applyPreset(p.id)} type="button">
            {p.label}
          </button>
        ))}
        <button className="ghost" onClick={() => void loadModels()} type="button" disabled={busy}>
          Fetch models
        </button>
        <button className="action primary" onClick={save} type="button">
          Save
        </button>
      </div>

      {models.length > 0 && (
        <div className="presets">
          {models.slice(0, 24).map((id) => (
            <button key={id} className="ghost" onClick={() => set({ model: id })} type="button">
              {id}
            </button>
          ))}
        </div>
      )}

      <p className="hint">
        {status || 'Config travels with each request; nothing provider-specific is hardcoded server-side. Keys stay in this browser unless you also put them in .env as RELAY_API_KEY.'}
      </p>

      {onRunOne && (
        <div className="presets">
          <button className="action" onClick={() => onRunOne('handrolled')} type="button" disabled={busy}>
            Run Path A only
          </button>
          <button className="action" onClick={() => onRunOne('strands')} type="button" disabled={busy}>
            Run Path B only
          </button>
        </div>
      )}
    </section>
  );
}
