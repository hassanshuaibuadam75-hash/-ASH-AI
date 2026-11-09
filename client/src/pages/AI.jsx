import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Spinner, useToast, Badge } from '../ui.jsx';

const LANGUAGES = [
  ['English', 'English'], ['Hausa', 'Hausa'], ['Igbo', 'Igbo'], ['Yoruba', 'Yoruba'],
  ['Arabic', 'Arabic'], ['French', 'French'], ['Swahili', 'Swahili'], ['Spanish', 'Spanish'],
  ['Portuguese', 'Portuguese'], ['Chinese', 'Chinese'],
];

export default function AI() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [feature, setFeature] = useState('compose');
  const [text, setText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('English');
  const [tone, setTone] = useState('friendly');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/ai/status').then(setStatus).catch((err) => setError(err.message));
  }, []);

  async function run(event) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    setOutput('');
    try {
      const data = await api('/ai/assist', {
        method: 'POST',
        body: { feature, text, targetLanguage: feature === 'translate' || feature === 'summarize' ? targetLanguage : undefined, tone: feature === 'compose' ? tone : undefined },
      });
      setOutput(data.text);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function copyOutput() {
    navigator.clipboard?.writeText(output).then(
      () => toast.push('Copied to clipboard.', 'success'),
      () => toast.push('Copy failed — select the text manually.', 'error')
    );
  }

  if (!status) return <Spinner label="Checking #ash AI" />;

  const active = status.features?.find((f) => f.key === feature);

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>#ash AI</h2>
          <Badge tone={status.configured ? 'green' : 'amber'}>{status.configured ? `Connected · ${status.model}` : 'Not connected'}</Badge>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          #ash AI is an assistant inside #ash Mesh. It only receives the text you paste here — it never reads your
          end-to-end encrypted messages, which this server cannot decrypt.
        </p>
      </div>

      {!status.configured ? (
        <div className="banner warn">
          <strong>#ash AI is not connected on this deployment.</strong> No simulated answers are produced.
          The Founder must set the <code>GROQ_API_KEY</code> environment variable for the backend, then the assistant
          becomes available here with no further changes.
        </div>
      ) : null}

      <div className="card">
        <div className="tabs">
          {(status.features || []).map((f) => (
            <button key={f.key} className={`tab ${feature === f.key ? 'active' : ''}`} onClick={() => setFeature(f.key)}>{f.label}</button>
          ))}
        </div>

        <form onSubmit={run} className="stack" style={{ marginTop: 14 }}>
          {active ? <p className="tiny muted" style={{ margin: 0 }}>{active.description}</p> : null}
          <Field label={feature === 'discover' ? 'Your question' : 'Your text'}>
            <textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={feature === 'translate' ? 'Paste the text to translate…' : feature === 'discover' ? 'Ask #ash AI a question…' : 'Paste or write your text…'}
              maxLength={4000}
            />
          </Field>
          {feature === 'translate' || feature === 'summarize' ? (
            <Field label="Language">
              <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
                {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          ) : null}
          {feature === 'compose' ? (
            <Field label="Tone">
              <select value={tone} onChange={(e) => setTone(e.target.value)}>
                <option value="friendly">Friendly</option>
                <option value="professional">Professional</option>
                <option value="concise">Concise</option>
                <option value="enthusiastic">Enthusiastic</option>
              </select>
            </Field>
          ) : null}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy || !status.configured || !text.trim()}>
              {busy ? <span className="spinner" /> : 'Ask #ash AI'}
            </button>
            <span className="tiny muted">{text.length}/4000</span>
          </div>
        </form>

        {error ? <div className="banner warn" style={{ marginTop: 12 }}>{error}</div> : null}

        {output ? (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h4 style={{ margin: 0 }}>Result</h4>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn ghost sm" onClick={copyOutput}>Copy</button>
                <button className="btn ghost sm" onClick={() => { setText(output); setOutput(''); }}>Use as input</button>
              </div>
            </div>
            <pre className="ai-output">{output}</pre>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>What #ash AI can help with</h4>
        <ul className="plain-list">
          {(status.features || []).map((f) => <li key={f.key}><strong>{f.label}</strong> — {f.description}</li>)}
        </ul>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Requests are rate limited per account, and the provider key stays on the backend. Nothing you do not submit is sent to the provider.
        </p>
      </div>
    </div>
  );
}
