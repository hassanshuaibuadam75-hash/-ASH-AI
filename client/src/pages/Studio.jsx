// #ash AI Creative Studio — one workspace for every studio, with honest capability labels.
//
// The capability list comes from the server (GET /api/creative/capabilities). Anything the
// server reports as unavailable is shown as unavailable and its form is disabled, so no
// button here can promise work that this deployment cannot actually do.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, mediaUrl } from '../api.js';
import { Badge, Empty, Spinner, useToast } from '../ui.jsx';

const STUDIOS = [
  { id: 'image', label: 'Image Studio', icon: '🖼️' },
  { id: 'video', label: 'Video Studio', icon: '🎬' },
  { id: 'audio', label: 'Audio & Music', icon: '🎵' },
  { id: 'document', label: 'Document Studio', icon: '📄' },
  { id: 'presentation', label: 'Presentation', icon: '📊' },
  { id: 'spreadsheet', label: 'Spreadsheet', icon: '📈' },
  { id: 'writing', label: 'Writing & Content', icon: '✍️' },
  { id: 'transcribe', label: 'File Understanding', icon: '🎙️' },
];

const CAP_LABEL = {
  available: 'Fully available',
  partial: 'Partially available',
  provider_required: 'Waiting for provider',
  unavailable: 'Unavailable',
};

function capTone(status) {
  if (status === 'available') return 'green';
  if (status === 'partial') return 'amber';
  return 'red';
}

function CapabilityList({ capabilities }) {
  if (!capabilities) return null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">What this deployment can actually do</div>
      <div className="stack" style={{ gap: 6 }}>
        {capabilities.map((cap) => (
          <div className="row" key={cap.id} style={{ gap: 8, alignItems: 'flex-start' }}>
            <Badge tone={capTone(cap.status)}>{CAP_LABEL[cap.status] || cap.status}</Badge>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{cap.label}</div>
              <div className="tiny muted">{cap.note}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PublishBox({ item, onPublished }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('public');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);

  async function publish() {
    setBusy(true);
    setState(null);
    try {
      const payload = { body: body.trim(), audience };
      if (item.mediaId) payload.mediaId = item.mediaId;
      const data = await api('/posts', { method: 'POST', body: payload });
      const status = data.moderation?.status || 'visible';
      setState({
        tone: status === 'visible' ? 'green' : 'amber',
        text:
          status === 'visible'
            ? 'Published to #ash Mesh.'
            : status === 'quarantined'
            ? 'Published, but held for moderator review. Only you and moderators can see it for now.'
            : 'Sent for review before it becomes visible.',
      });
      toast.push('Post submitted.', 'success');
      if (onPublished) onPublished(data.post);
    } catch (err) {
      setState({ tone: 'red', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">Publish this to #ash Mesh</div>
      <textarea
        className="input"
        rows={2}
        placeholder="Write a caption (optional)…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={5000}
        aria-label="Caption"
      />
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <select className="input sm" style={{ width: 150 }} value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Audience">
          <option value="public">Everyone</option>
          <option value="friends">Friends</option>
          <option value="private">Only me</option>
        </select>
        <button type="button" className="btn sm" onClick={publish} disabled={busy}>
          {busy ? 'Submitting…' : 'Publish'}
        </button>
      </div>
      {state ? (
        <div className="tiny" style={{ marginTop: 8, color: state.tone === 'red' ? '#ff9a9a' : state.tone === 'amber' ? '#ffd479' : '#00ff88' }}>
          {state.text}
        </div>
      ) : null}
      <div className="tiny muted" style={{ marginTop: 8 }}>
        Every post passes the same moderation screening as the normal composer.
      </div>
    </div>
  );
}

function ResultPreview({ item, onPublish, onSaved }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  if (!item) return null;

  async function saveAsDocument() {
    setSaving(true);
    try {
      await api('/creative/document', {
        method: 'POST',
        body: { format: 'md', title: item.title || 'Saved draft', content: item.textOutput || '' },
      });
      toast.push('Saved to your library as a Markdown document.', 'success');
      if (onSaved) onSaved();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="card-title" style={{ margin: 0 }}>{item.title || 'Result'}</div>
        <Badge tone="green">{item.kind}</Badge>
      </div>

      {item.kind === 'image' && item.mediaId ? (
        <img src={mediaUrl(item.mediaId)} alt={item.title || 'Generated image'} style={{ width: '100%', borderRadius: 12, marginTop: 10 }} />
      ) : null}
      {item.kind === 'video' && item.mediaId ? (
        <video src={mediaUrl(item.mediaId)} controls playsInline style={{ width: '100%', borderRadius: 12, marginTop: 10 }} />
      ) : null}
      {item.kind === 'audio' && item.mediaId ? (
        <audio src={mediaUrl(item.mediaId)} controls style={{ width: '100%', marginTop: 10 }} />
      ) : null}
      {item.kind === 'file' && item.mediaId ? (
        <a className="btn ghost sm" style={{ marginTop: 10 }} href={mediaUrl(item.mediaId)} download>
          Download {item.meta?.format ? `.${item.meta.format}` : 'file'}
        </a>
      ) : null}
      {item.textOutput ? (
        <pre className="tiny" style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.6 }}>{item.textOutput}</pre>
      ) : null}

      {item.applied?.length ? (
        <div className="tiny muted" style={{ marginTop: 8 }}>Applied: {item.applied.join(', ')}</div>
      ) : null}

      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        {item.mediaId ? (
          <a className="btn ghost sm" href={mediaUrl(item.mediaId)} download>Download</a>
        ) : null}
        {item.textOutput ? (
          <button type="button" className="btn ghost sm" onClick={saveAsDocument} disabled={saving}>
            {saving ? 'Saving…' : 'Save as document'}
          </button>
        ) : null}
      </div>

      {onPublish ? <PublishBox item={item} onPublished={onPublish} /> : null}
    </div>
  );
}

function Library({ items, onDelete, onOpen }) {
  if (!items.length) return <Empty title="Nothing saved yet" hint="Anything you create is kept here and can be published later." />;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((item) => (
        <div className="card" key={item.id} style={{ padding: 12 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <Badge tone="green">{item.studio}</Badge>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title || item.op}</div>
              <div className="tiny muted">{new Date(item.createdAt).toLocaleString()}</div>
            </div>
            {item.mediaId ? <a className="btn ghost sm" href={mediaUrl(item.mediaId)} download>Download</a> : null}
            <button type="button" className="btn ghost sm" onClick={() => onOpen(item)}>Open</button>
            <button type="button" className="btn ghost sm" onClick={() => onDelete(item)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Studio() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = STUDIOS.some((s) => s.id === params.get('tab')) ? params.get('tab') : 'image';
  const [caps, setCaps] = useState(null);
  const [library, setLibrary] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadLibrary = useCallback(async () => {
    try {
      const data = await api('/creative/library');
      setLibrary(data.items || []);
    } catch { /* library is optional until first use */ }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api('/creative/capabilities');
        if (alive) setCaps(data.capabilities || []);
      } catch { if (alive) setCaps([]); }
    })();
    loadLibrary();
    return () => { alive = false; };
  }, [loadLibrary]);

  const capabilityFor = (studio) => {
    const cap = (caps || []).find((c) => c.id === studio);
    return cap?.status || 'unavailable';
  };

  async function submitForm(path, form, onDone) {
    setBusy(true);
    setResult(null);
    try {
      const data = await api(path, { method: 'POST', form });
      setResult(data.item);
      toast.push('Done.', 'success');
      await loadLibrary();
      if (onDone) onDone(data);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitJson(path, payload) {
    setBusy(true);
    setResult(null);
    try {
      const data = await api(path, { method: 'POST', body: payload });
      setResult(data.item);
      toast.push('Done.', 'success');
      await loadLibrary();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item) {
    try {
      await api(`/creative/library/${item.id}`, { method: 'DELETE' });
      setPendingDelete(null);
      toast.push('Removed from your library.', 'success');
      await loadLibrary();
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }

  const status = capabilityFor(tab);
  const disabled = status === 'unavailable' || status === 'provider_required';

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-title">#ash AI Creative Studio</div>
        <div className="small muted">
          Create and edit images, audio, video, documents, slides, spreadsheets and writing.
          Everything you produce is saved to your private library first, and only becomes public when you publish it
          through moderation.
        </div>
      </div>

      <CapabilityList capabilities={caps} />

      <div className="row" style={{ gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
        {STUDIOS.map((studio) => (
          <button
            key={studio.id}
            type="button"
            className={`btn ${studio.id === tab ? '' : 'ghost'} sm`}
            onClick={() => setParams({ tab: studio.id })}
            style={{ whiteSpace: 'nowrap' }}
          >
            <span aria-hidden="true">{studio.icon}</span> {studio.label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="card-title" style={{ margin: 0 }}>{STUDIOS.find((s) => s.id === tab)?.label}</div>
          <Badge tone={capTone(status)}>{CAP_LABEL[status] || status}</Badge>
        </div>

        {disabled ? (
          <div className="small muted">
            {(caps || []).find((c) => c.id === tab)?.note || 'This capability is not available on this deployment.'}
          </div>
        ) : (
          <StudioForm
            tab={tab}
            busy={busy}
            onSubmitForm={submitForm}
            onSubmitJson={submitJson}
          />
        )}
      </div>

      {busy ? <div className="center"><Spinner label="Working…" /></div> : null}
      <ResultPreview item={result} onSaved={loadLibrary} onPublish={() => loadLibrary()} />

      <div className="card">
        <div className="card-title">Your creative library</div>
        <Library
          items={library}
          onOpen={(item) => setResult(item)}
          onDelete={(item) => setPendingDelete(item)}
        />
      </div>

      {pendingDelete ? (
        <div className="card" style={{ borderColor: '#ff6b6b' }}>
          <div className="card-title">Delete this item?</div>
          <div className="small muted">
            “{pendingDelete.title || pendingDelete.op}” will be removed from your library. Files already published stay in
            the feed until you delete the post itself.
          </div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button type="button" className="btn sm" onClick={() => removeItem(pendingDelete)}>Yes, delete</button>
            <button type="button" className="btn ghost sm" onClick={() => setPendingDelete(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StudioForm({ tab, busy, onSubmitForm, onSubmitJson }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [rotate, setRotate] = useState('');
  const [brightness, setBrightness] = useState('');
  const [contrast, setContrast] = useState('');
  const [grayscale, setGrayscale] = useState(false);
  const [sepia, setSepia] = useState(false);
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState('');
  const [volume, setVolume] = useState('');
  const [mode, setMode] = useState('thumbnail');
  const [format, setFormat] = useState('md');
  const [content, setContent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState('caption');
  const [language, setLanguage] = useState('');
  const [slideCount, setSlideCount] = useState('6');
  const [csv, setCsv] = useState('');

  function pick(event) {
    setFile(event.target.files?.[0] || null);
  }

  const fileInput = (accept, label) => (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
        {label}
        <input ref={fileRef} type="file" hidden accept={accept} onChange={pick} />
      </label>
      {file ? <span className="tiny muted">{file.name}</span> : null}
    </div>
  );

  const num = (value) => (value === '' ? undefined : Number(value));

  if (tab === 'image') {
    return (
      <div>
        {fileInput('image/*', 'Choose an image')}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input sm" style={{ width: 110 }} placeholder="Width" value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Width" />
          <input className="input sm" style={{ width: 110 }} placeholder="Height" value={height} onChange={(e) => setHeight(e.target.value)} aria-label="Height" />
          <input className="input sm" style={{ width: 110 }} placeholder="Rotate °" value={rotate} onChange={(e) => setRotate(e.target.value)} aria-label="Rotate" />
          <input className="input sm" style={{ width: 120 }} placeholder="Brightness" value={brightness} onChange={(e) => setBrightness(e.target.value)} aria-label="Brightness" />
          <input className="input sm" style={{ width: 120 }} placeholder="Contrast" value={contrast} onChange={(e) => setContrast(e.target.value)} aria-label="Contrast" />
        </div>
        <div className="row" style={{ gap: 12, marginTop: 8 }}>
          <label className="row tiny" style={{ gap: 6 }}>
            <input type="checkbox" checked={grayscale} onChange={(e) => setGrayscale(e.target.checked)} /> Grayscale
          </label>
          <label className="row tiny" style={{ gap: 6 }}>
            <input type="checkbox" checked={sepia} onChange={(e) => setSepia(e.target.checked)} /> Sepia
          </label>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button
            type="button"
            className="btn sm"
            disabled={busy || !file}
            onClick={() => {
              const form = new FormData();
              form.append('file', file);
              form.append('title', title || 'Edited image');
              form.append(
                'ops',
                JSON.stringify({
                  width: num(width), height: num(height), rotate: num(rotate),
                  brightness: num(brightness), contrast: num(contrast), grayscale, sepia,
                })
              );
              onSubmitForm('/creative/image/edit', form);
            }}
          >
            {busy ? 'Working…' : 'Apply edits'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          The original file is never modified: edits produce a new image in your library.
          Text-to-image generation needs an image provider, which this deployment does not have.
        </div>
      </div>
    );
  }

  if (tab === 'video') {
    return (
      <div>
        {fileInput('video/*', 'Choose a video')}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="input sm" style={{ width: 170 }} value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Video operation">
            <option value="thumbnail">Extract thumbnail</option>
            <option value="trim">Trim a clip</option>
          </select>
          {mode === 'trim' ? (
            <>
              <input className="input sm" style={{ width: 110 }} placeholder="Start s" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
              <input className="input sm" style={{ width: 130 }} placeholder="Duration s" value={duration} onChange={(e) => setDuration(e.target.value)} aria-label="Duration" />
            </>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            disabled={busy || !file}
            onClick={() => {
              const form = new FormData();
              form.append('file', file);
              form.append('title', title || 'Edited video');
              form.append('ops', JSON.stringify({ mode, start: num(start), duration: num(duration) }));
              onSubmitForm('/creative/video/edit', form);
            }}
          >
            {busy ? 'Processing…' : 'Process video'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Trimming and thumbnails run locally with ffmpeg. Generating new video from text needs a video provider,
          which is not configured here.
        </div>
      </div>
    );
  }

  if (tab === 'audio') {
    return (
      <div>
        {fileInput('audio/*', 'Choose audio')}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input sm" style={{ width: 110 }} placeholder="Start s" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
          <input className="input sm" style={{ width: 130 }} placeholder="Duration s" value={duration} onChange={(e) => setDuration(e.target.value)} aria-label="Duration" />
          <input className="input sm" style={{ width: 130 }} placeholder="Volume 0–2" value={volume} onChange={(e) => setVolume(e.target.value)} aria-label="Volume" />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            disabled={busy || !file}
            onClick={() => {
              const form = new FormData();
              form.append('file', file);
              form.append('title', title || 'Edited audio');
              form.append('ops', JSON.stringify({ start: num(start), duration: num(duration), volume: num(volume) }));
              onSubmitForm('/creative/audio/edit', form);
            }}
          >
            {busy ? 'Processing…' : 'Process audio'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Trim and volume changes run locally with ffmpeg. You must have the right to use any recording you upload.
          Music generation and voice cloning are not available on this deployment.
        </div>
      </div>
    );
  }

  if (tab === 'document') {
    return (
      <div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input sm" style={{ flex: 1, minWidth: 180 }} placeholder="Document title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <select className="input sm" style={{ width: 150 }} value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format">
            <option value="md">Markdown (.md)</option>
            <option value="txt">Text (.txt)</option>
            <option value="html">HTML (.html)</option>
            <option value="csv">CSV (.csv)</option>
          </select>
        </div>
        <textarea className="input" rows={8} style={{ marginTop: 8 }} placeholder="Write or paste your document content…" value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn sm" disabled={busy || !content.trim()} onClick={() => onSubmitJson('/creative/document', { format, title, content })}>
            {busy ? 'Creating…' : 'Create document'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Creates a real downloadable file. DOCX, XLSX, PPTX and PDF export are not available on this deployment.
        </div>
      </div>
    );
  }

  if (tab === 'presentation') {
    return (
      <div>
        <input className="input" placeholder="What is the presentation about?" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Topic" />
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <input className="input sm" style={{ width: 130 }} placeholder="Slides" value={slideCount} onChange={(e) => setSlideCount(e.target.value)} aria-label="Slide count" />
          <button type="button" className="btn sm" disabled={busy || !prompt.trim()} onClick={() => onSubmitJson('/creative/presentation', { topic: prompt, slides: num(slideCount) })}>
            {busy ? 'Building…' : 'Build slide deck'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Produces a real HTML slide deck you can open and present. PPTX export is not available here.
        </div>
      </div>
    );
  }

  if (tab === 'spreadsheet') {
    return (
      <div>
        <input className="input" placeholder="Spreadsheet title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea
          className="input"
          rows={8}
          style={{ marginTop: 8 }}
          placeholder={'One row per line, comma separated:\nName, Qty, Price\nRice, 2, 1500'}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn sm"
            disabled={busy || !csv.trim()}
            onClick={() => {
              const rows = csv.split('\n').filter((line) => line.trim()).map((line) => line.split(',').map((cell) => cell.trim()));
              onSubmitJson('/creative/spreadsheet', { title, rows });
            }}
          >
            {busy ? 'Creating…' : 'Create spreadsheet'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Builds a real CSV from the rows you provide. It never invents data.
        </div>
      </div>
    );
  }

  if (tab === 'writing') {
    return (
      <div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="input sm" style={{ width: 170 }} value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task">
            <option value="caption">Post caption</option>
            <option value="article">Article</option>
            <option value="script">Video script</option>
            <option value="hashtags">Hashtags</option>
            <option value="slogan">Slogans</option>
            <option value="explain">Explain something</option>
            <option value="summarize">Summarise text</option>
            <option value="improve">Improve my writing</option>
            <option value="translate">Translate</option>
            <option value="code">Write code</option>
          </select>
          <input className="input sm" style={{ width: 160 }} placeholder="Language (optional)" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language" />
        </div>
        <textarea className="input" rows={6} style={{ marginTop: 8 }} placeholder="Describe what you want written…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn sm" disabled={busy || !prompt.trim()} onClick={() => onSubmitJson('/creative/write', { task, prompt, language, title })}>
            {busy ? 'Writing…' : 'Generate'}
          </button>
        </div>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Powered by the configured Groq backend. Needs an internet connection.
        </div>
      </div>
    );
  }

  return (
    <div>
      {fileInput('audio/*,video/*', 'Choose audio or video')}
      <input className="input" placeholder="Language code (optional, e.g. ha, en)" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language" style={{ marginBottom: 8 }} />
      <button
        type="button"
        className="btn sm"
        disabled={busy || !file}
        onClick={() => {
          const form = new FormData();
          form.append('file', file);
          form.append('title', title || 'Transcript');
          form.append('language', language);
          onSubmitForm('/creative/transcribe', form);
        }}
      >
        {busy ? 'Transcribing…' : 'Transcribe'}
      </button>
      <div className="tiny muted" style={{ marginTop: 8 }}>
        Uses Groq speech-to-text. PDF, DOCX and image OCR reading are not available on this deployment.
      </div>
    </div>
  );
}
