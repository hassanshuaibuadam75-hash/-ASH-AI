import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Field, Spinner, useToast, Badge } from '../ui.jsx';
import * as aiQueue from '../aiQueue.js';
import { OfficialPublisher, ModerationPanel } from '../components/ModerationPanel.jsx';

const LANGUAGES = [
  ['English', 'English'], ['Hausa', 'Hausa'], ['Igbo', 'Igbo'], ['Yoruba', 'Yoruba'],
  ['Arabic', 'Arabic'], ['French', 'French'], ['Swahili', 'Swahili'], ['Spanish', 'Spanish'],
  ['Portuguese', 'Portuguese'], ['Chinese', 'Chinese'],
];

const TABS = [
  ['chat', 'Chat'],
  ['tools', 'Writing tools'],
  ['actions', 'Post with #ash AI'],
  ['support', 'Support'],
  ['moderation', 'Safety'],
];

export default function AI() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('chat');
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [isStaff, setIsStaff] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [queueNote, setQueueNote] = useState('');

  // chat
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const endRef = useRef(null);

  // writing tools (existing feature set, preserved)
  const [feature, setFeature] = useState('compose');
  const [text, setText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('English');
  const [tone, setTone] = useState('friendly');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [toolError, setToolError] = useState('');

  // actions
  const [draftType, setDraftType] = useState('post');
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [proposal, setProposal] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [audience, setAudience] = useState('public');
  const [targetPostId, setTargetPostId] = useState('');
  const [asAiAccount, setAsAiAccount] = useState(false);
  const [recent, setRecent] = useState([]);

  // support
  const [subject, setSubject] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');
  const [category, setCategory] = useState('other');
  const [tickets, setTickets] = useState([]);
  const [activeTicket, setActiveTicket] = useState(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState('');
  const [reply, setReply] = useState('');

  // moderation + staff
  const [checkText, setCheckText] = useState('');
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [flags, setFlags] = useState([]);
  const [summary, setSummary] = useState(null);
  const [summaryBusy, setSummaryBusy] = useState(false);

  const refreshQueue = useCallback(async () => {
    try {
      setQueueCount(await aiQueue.count());
    } catch {
      setQueueCount(0);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const data = await api('/ai/actions');
      setRecent(data.actions || []);
    } catch {
      /* non-critical */
    }
  }, []);

  const flushQueue = useCallback(async () => {
    if (flushing) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setQueueNote('Still offline — queued actions stay saved on this device.');
      return;
    }
    setFlushing(true);
    try {
      const result = await aiQueue.flush((action) =>
        api('/ai/actions', { method: 'POST', body: action })
      );
      await refreshQueue();
      await loadRecent();
      setQueueNote(
        result.sent
          ? `Sent ${result.sent} queued action${result.sent === 1 ? '' : 's'}${result.remaining ? `, ${result.remaining} still waiting.` : '.'}`
          : result.remaining
            ? `${result.remaining} queued action(s) could not be sent yet.`
            : 'Nothing queued.'
      );
      if (result.sent) toast.push(`#ash AI sent ${result.sent} queued action(s).`, 'success');
    } catch (err) {
      setQueueNote(err.message || 'Could not send queued actions yet.');
    } finally {
      setFlushing(false);
    }
  }, [flushing, loadRecent, refreshQueue, toast]);

  useEffect(() => {
    api('/ai/status')
      .then(setStatus)
      .catch((err) => setError(err.message || 'Could not load #ash AI status.'));
    loadRecent();
    refreshQueue();
    api('/ai/summary')
      .then((data) => {
        setIsStaff(true);
        setSummary(data);
      })
      .catch(() => setIsStaff(false));
  }, [loadRecent, refreshQueue]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      flushQueue();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [flushQueue]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.length, sending]);

  useEffect(() => {
    if (tab === 'support') {
      api('/ai/support/tickets')
        .then((data) => setTickets(data.tickets || []))
        .catch((err) => setSupportError(err.message));
    }
    if (tab === 'moderation' && isStaff) {
      api('/ai/moderate/flags')
        .then((data) => setFlags(data.flags || []))
        .catch(() => setFlags([]));
    }
  }, [tab, isStaff]);

  async function sendChat(event) {
    event.preventDefault();
    const body = chatInput.trim();
    if (!body || sending) return;
    const next = [...chat, { role: 'user', content: body }];
    setChat(next);
    setChatInput('');
    setChatError('');
    setSending(true);
    try {
      const data = await api('/ai/chat', {
        method: 'POST',
        body: {
          messages: next.slice(-20).map((m) => ({ role: m.role, content: m.content })),
          surface: 'ai-chat',
        },
      });
      setChat((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply, model: data.model, disclosure: data.disclosure },
      ]);
    } catch (err) {
      setChatError(err.message || 'Could not reach #ash AI. Your message was not answered.');
    } finally {
      setSending(false);
    }
  }

  async function runTool(event) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setToolError('');
    setOutput('');
    try {
      const data = await api('/ai/assist', {
        method: 'POST',
        body: {
          feature,
          text,
          targetLanguage: ['translate', 'summarize'].includes(feature) ? targetLanguage : undefined,
          tone: feature === 'compose' ? tone : undefined,
        },
      });
      setOutput(data.text);
    } catch (err) {
      setToolError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function proposeDraft() {
    setProposing(true);
    setActionError('');
    setProposal(null);
    try {
      const data = await api('/ai/actions/propose', {
        method: 'POST',
        body: { type: draftType === 'reply' ? 'reply' : draftType, prompt, draft },
      });
      setProposal(data.proposal);
      setDraft(data.proposal.body);
      if (data.message) setActionError(data.message);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setProposing(false);
    }
  }

  async function publishApproved() {
    if (!draft.trim()) {
      setActionError('Write or generate something to publish first.');
      return;
    }
    setPublishing(true);
    setActionError('');
    const clientId = aiQueue.newClientId();
    const payload = {
      type: draftType === 'reply' ? 'comment' : draftType,
      body: draft,
      postId: targetPostId.trim() || undefined,
      audience,
      asAiAccount,
      approved: true,
      clientId,
    };

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await aiQueue.enqueue(payload);
        await refreshQueue();
        setActionError('Saved on this device. It will be sent automatically when you are back online.');
        toast.push('Saved offline — will send automatically.', 'info');
        return;
      }
      await api('/ai/actions', { method: 'POST', body: payload });
      toast.push('Published. Your approval was recorded.', 'success');
      setProposal(null);
      setPrompt('');
      setDraft('');
      await loadRecent();
    } catch (err) {
      if (!err.status) {
        await aiQueue.enqueue(payload);
        await refreshQueue();
        setActionError('Connection lost — your action is saved and will send automatically.');
      } else {
        setActionError(err.message);
      }
    } finally {
      setPublishing(false);
    }
  }

  async function submitTicket(event) {
    event.preventDefault();
    if (!subject.trim() || !ticketMessage.trim()) return;
    setSupportBusy(true);
    setSupportError('');
    try {
      const data = await api('/ai/support/tickets', {
        method: 'POST',
        body: { subject, message: ticketMessage, category },
      });
      setActiveTicket(data.ticket);
      setTickets((prev) => [data.ticket, ...prev]);
      setSubject('');
      setTicketMessage('');
      toast.push(data.message || 'Support request created.', 'success');
      if (data.triageError) setSupportError('Saved for human staff — #ash AI triage is unavailable right now.');
    } catch (err) {
      setSupportError(err.message);
    } finally {
      setSupportBusy(false);
    }
  }

  async function openTicket(id) {
    setSupportError('');
    try {
      const data = await api(`/ai/support/tickets/${id}`);
      setActiveTicket(data.ticket);
    } catch (err) {
      setSupportError(err.message);
    }
  }

  async function sendReply(event) {
    event.preventDefault();
    if (!reply.trim() || !activeTicket) return;
    setSupportBusy(true);
    try {
      const data = await api(`/ai/support/tickets/${activeTicket.id}/messages`, {
        method: 'POST',
        body: { body: reply },
      });
      setActiveTicket(data.ticket);
      setReply('');
      if (data.message) toast.push(data.message, 'info');
    } catch (err) {
      setSupportError(err.message);
    } finally {
      setSupportBusy(false);
    }
  }

  async function checkContent(event) {
    event.preventDefault();
    if (!checkText.trim()) return;
    setChecking(true);
    try {
      const data = await api('/ai/moderate/check', { method: 'POST', body: { text: checkText } });
      setCheckResult(data);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setChecking(false);
    }
  }

  async function loadSummary() {
    setSummaryBusy(true);
    try {
      setSummary(await api('/ai/summary'));
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSummaryBusy(false);
    }
  }

  if (!status) {
    return error ? <div className="banner warn">{error}</div> : <Spinner label="Checking #ash AI" />;
  }

  const activeFeature = (status.features || []).find((f) => f.key === feature);

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>#ash AI</h2>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Badge tone={status.configured && online ? 'green' : 'amber'}>
              {status.configured && online ? '#ash AI · Online' : '#ash AI · Offline'}
            </Badge>
            {queueCount ? <Badge tone="amber">{queueCount} queued</Badge> : null}
            <Badge tone="grey">AI · not a human</Badge>
          </div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          #ash AI is an assistant inside #ash Mesh. It only receives text you submit. It cannot read your
          end-to-end encrypted messages, cannot move money, and never acts on your behalf without your approval.
        </p>
      </div>

      <ModerationPanel />

      {!status.configured ? (
        <div className="banner warn">
          <strong>#ash AI is not connected on this deployment.</strong> No simulated answers are produced. The
          Founder must set the <code>GROQ_API_KEY</code> environment variable for the backend, then the assistant
          works here with no further changes.
        </div>
      ) : null}

      {queueCount ? (
        <div className="banner">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span>
              {queueCount} approved action{queueCount === 1 ? '' : 's'} saved on this device, waiting to send.
              {queueNote ? ` ${queueNote}` : ''}
            </span>
            <button className="btn ghost sm" onClick={flushQueue} disabled={flushing || !online}>
              {flushing ? <span className="spinner" /> : 'Send now'}
            </button>
          </div>
        </div>
      ) : queueNote ? (
        <div className="banner">{queueNote}</div>
      ) : null}

      <div className="card">
        <div className="tabs">
          {TABS.map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
          {isStaff ? (
            <button className={`tab ${tab === 'staff' ? 'active' : ''}`} onClick={() => setTab('staff')}>
              Staff
            </button>
          ) : null}
        </div>

        {tab === 'staff' ? <OfficialPublisher /> : null}

        {tab === 'chat' ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="ai-chat" aria-live="polite">
              {chat.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  Ask #ash AI anything about #ash Mesh — posting, privacy, marketplace rules, #ash Academy or
                  troubleshooting. Answers come from a live AI model and can be wrong; check anything important.
                </p>
              ) : null}
              {chat.map((m, i) => (
                <div key={i} className={`ai-msg ${m.role}`}>
                  <div className="ai-msg-head">
                    <strong>{m.role === 'user' ? 'You' : '#ash AI'}</strong>
                    {m.role === 'assistant' ? <Badge tone="green">AI-generated</Badge> : null}
                  </div>
                  <div className="ai-msg-body">{m.content}</div>
                  {m.disclosure ? <div className="tiny muted">{m.disclosure}</div> : null}
                </div>
              ))}
              {sending ? (
                <div className="ai-msg assistant">
                  <div className="ai-msg-head"><strong>#ash AI</strong></div>
                  <div className="row small muted"><span className="spinner" /> Thinking…</div>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>

            {chatError ? <div className="banner warn">{chatError}</div> : null}

            <form onSubmit={sendChat} className="stack">
              <Field label="Message #ash AI">
                <textarea
                  rows={3}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask about posting, privacy, marketplace orders, #ash Academy…"
                  maxLength={4000}
                  disabled={sending}
                />
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={sending || !chatInput.trim() || !status.configured}>
                  {sending ? <span className="spinner" /> : 'Send'}
                </button>
                {chat.length ? (
                  <button type="button" className="btn ghost sm" onClick={() => { setChat([]); setChatError(''); }}>
                    Clear chat
                  </button>
                ) : null}
                <span className="tiny muted">Chat needs internet. Queued actions work offline.</span>
              </div>
            </form>
          </div>
        ) : null}

        {tab === 'tools' ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="tabs">
              {(status.features || []).map((f) => (
                <button key={f.key} className={`tab ${feature === f.key ? 'active' : ''}`} onClick={() => setFeature(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <form onSubmit={runTool} className="stack">
              {activeFeature ? <p className="tiny muted" style={{ margin: 0 }}>{activeFeature.label}</p> : null}
              <Field label={feature === 'discover' ? 'Your question' : 'Your text'}>
                <textarea
                  rows={6}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={feature === 'translate' ? 'Paste the text to translate…' : feature === 'discover' ? 'Ask #ash AI a question…' : 'Paste or write your text…'}
                  maxLength={4000}
                />
              </Field>
              {['translate', 'summarize'].includes(feature) ? (
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
            {toolError ? <div className="banner warn">{toolError}</div> : null}
            {output ? (
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h4 style={{ margin: 0 }}>Result</h4>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn ghost sm"
                      onClick={() => navigator.clipboard?.writeText(output).then(
                        () => toast.push('Copied to clipboard.', 'success'),
                        () => toast.push('Copy failed — select the text manually.', 'error')
                      )}
                    >
                      Copy
                    </button>
                    <button className="btn ghost sm" onClick={() => { setDraft(output); setTab('actions'); }}>
                      Use in a post
                    </button>
                  </div>
                </div>
                <pre className="ai-output">{output}</pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'actions' ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <p className="small muted" style={{ margin: 0 }}>
              #ash AI can draft for you, but nothing is published until you approve it. Every action you approve is
              recorded, and AI-assisted content is labelled.
            </p>

            <div className="tabs">
              {[['post', 'New post'], ['comment', 'Comment'], ['like', 'Like'], ['share', 'Share']].map(([key, label]) => (
                <button key={key} className={`tab ${draftType === key ? 'active' : ''}`} onClick={() => { setDraftType(key); setProposal(null); }}>
                  {label}
                </button>
              ))}
            </div>

            {['comment', 'like', 'share'].includes(draftType) ? (
              <Field label="Post ID" hint="Paste the post ID from the feed (⋯ menu → Copy link contains it).">
                <input value={targetPostId} onChange={(e) => setTargetPostId(e.target.value)} placeholder="p_…" />
              </Field>
            ) : null}

            {['post', 'comment'].includes(draftType) ? (
              <>
                <Field label="Ask #ash AI to draft it (optional)">
                  <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={draftType === 'post' ? 'Announce that our #ash Academy lesson on solar power is live' : 'Congratulate them warmly'}
                  />
                </Field>
                <Field label={draftType === 'post' ? 'Post text' : 'Comment text'}>
                  <textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={5000} />
                </Field>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn ghost" onClick={proposeDraft} disabled={proposing || !status.configured}>
                    {proposing ? <span className="spinner" /> : 'Draft with #ash AI'}
                  </button>
                  {proposal ? <Badge tone={proposal.generated ? 'green' : 'amber'}>{proposal.generated ? 'AI-generated draft' : 'Not AI-generated'}</Badge> : null}
                </div>
              </>
            ) : null}

            {draftType === 'post' ? (
              <Field label="Who can see it">
                <select value={audience} onChange={(e) => setAudience(e.target.value)}>
                  <option value="public">Public</option>
                  <option value="friends">Friends</option>
                  <option value="private">Only me</option>
                </select>
              </Field>
            ) : null}

            {isStaff ? (
              <label className="row small" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={asAiAccount} onChange={(e) => setAsAiAccount(e.target.checked)} />
                Publish as the official <strong>#ash AI</strong> account (staff only)
              </label>
            ) : null}

            {actionError ? <div className="banner warn">{actionError}</div> : null}

            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={publishApproved} disabled={publishing}>
                {publishing ? <span className="spinner" /> : `Approve & ${draftType === 'like' ? 'like' : draftType === 'share' ? 'share' : draftType === 'comment' ? 'comment' : 'publish'}`}
              </button>
              <span className="tiny muted">{online ? 'Sends immediately.' : 'Offline — will be queued and sent automatically.'}</span>
            </div>

            <div>
              <h4 style={{ marginBottom: 6 }}>Recent #ash AI actions</h4>
              {recent.length === 0 ? (
                <p className="tiny muted" style={{ margin: 0 }}>Nothing yet.</p>
              ) : (
                <ul className="plain-list">
                  {recent.slice(0, 8).map((a) => (
                    <li key={a.id}>
                      <strong>{a.type}</strong> · {new Date(a.createdAt).toLocaleString()}
                      {a.asAiAccount ? ' · official #ash AI account' : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'support' ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <form onSubmit={submitTicket} className="stack">
              <Field label="Subject">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} placeholder="I cannot upload my profile photo" />
              </Field>
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="account">Account</option>
                  <option value="messaging">Messaging</option>
                  <option value="marketplace">Marketplace</option>
                  <option value="privacy">Privacy</option>
                  <option value="technical">Technical</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="What happened?">
                <textarea rows={4} value={ticketMessage} onChange={(e) => setTicketMessage(e.target.value)} maxLength={4000} />
              </Field>
              <button className="btn primary" disabled={supportBusy || !subject.trim() || !ticketMessage.trim()}>
                {supportBusy ? <span className="spinner" /> : 'Create support request'}
              </button>
            </form>

            {supportError ? <div className="banner warn">{supportError}</div> : null}

            {activeTicket ? (
              <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                  <strong>{activeTicket.subject}</strong>
                  <Badge tone={activeTicket.status === 'escalated' ? 'amber' : 'green'}>{activeTicket.status}</Badge>
                </div>
                <ul className="plain-list" style={{ marginTop: 10 }}>
                  {activeTicket.messages.map((m) => (
                    <li key={m.id}>
                      <div className="tiny muted">
                        {m.authorKind === 'ai' ? '#ash AI (AI-generated)' : m.authorKind === 'staff' ? 'Support staff' : 'You'} ·{' '}
                        {new Date(m.createdAt).toLocaleString()}
                      </div>
                      <div className="small">{m.body}</div>
                    </li>
                  ))}
                </ul>
                <form onSubmit={sendReply} className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply, or ask for a human" style={{ flex: 1 }} />
                  <button className="btn ghost sm" disabled={supportBusy || !reply.trim()}>Send</button>
                </form>
              </div>
            ) : null}

            <div>
              <h4 style={{ marginBottom: 6 }}>Your support requests</h4>
              {tickets.length === 0 ? (
                <p className="tiny muted" style={{ margin: 0 }}>No support requests yet.</p>
              ) : (
                <ul className="plain-list">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <button className="linklike" onClick={() => openTicket(t.id)}>{t.subject}</button>{' '}
                      <Badge tone={t.status === 'escalated' ? 'amber' : 'grey'}>{t.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'moderation' ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <form onSubmit={checkContent} className="stack">
              <Field label="Check content for spam or abuse" hint="Uses #ash AI when connected, and always applies local rules.">
                <textarea rows={4} value={checkText} onChange={(e) => setCheckText(e.target.value)} maxLength={4000} />
              </Field>
              <button className="btn primary" disabled={checking || !checkText.trim()}>
                {checking ? <span className="spinner" /> : 'Check content'}
              </button>
            </form>

            {checkResult ? (
              <div className="banner">
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                  <strong>{checkResult.spam ? 'Likely spam or abuse' : 'No strong signal'}</strong>
                  <Badge tone={checkResult.provider === 'groq' ? 'green' : 'grey'}>
                    {checkResult.provider === 'groq' ? '#ash AI analysis' : 'Local rules only'}
                  </Badge>
                </div>
                <div className="small">Score: {Math.round((checkResult.score || 0) * 100)}% · category: {checkResult.category}</div>
                {checkResult.reasons?.length ? (
                  <ul className="plain-list">{checkResult.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                ) : null}
                {checkResult.note ? <div className="tiny muted">{checkResult.note}</div> : null}
              </div>
            ) : null}

            {isStaff ? (
              <div>
                <h4 style={{ marginBottom: 6 }}>Flagged for review</h4>
                {flags.length === 0 ? (
                  <p className="tiny muted" style={{ margin: 0 }}>No flags raised.</p>
                ) : (
                  <ul className="plain-list">
                    {flags.map((f) => (
                      <li key={f.id}>
                        <strong>{f.severity}</strong> · {f.reason || 'no reason given'} · post {f.postId}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            <p className="tiny muted" style={{ marginBottom: 0 }}>
              To report a post, use the report action in the feed — reports go to human moderators. #ash AI only
              suggests; it never removes content or restricts accounts.
            </p>
          </div>
        ) : null}

        {tab === 'staff' && isStaff ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h4 style={{ margin: 0 }}>Platform summary</h4>
              <button className="btn ghost sm" onClick={loadSummary} disabled={summaryBusy}>
                {summaryBusy ? <span className="spinner" /> : 'Refresh'}
              </button>
            </div>
            {summary?.counts ? (
              <ul className="plain-list">
                {Object.entries(summary.counts).map(([key, value]) => (
                  <li key={key}><strong>{key}</strong>: {value === null ? 'unavailable' : value}</li>
                ))}
              </ul>
            ) : null}
            {summary?.narrative ? <pre className="ai-output">{summary.narrative}</pre> : null}
            {summary?.narrativeError ? (
              <div className="banner warn">AI narrative unavailable: {summary.narrativeError.message}</div>
            ) : null}
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              #ash AI summarises counts only. It cannot suspend accounts, delete content, change roles or touch
              payments, and it never gains Founder authority.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
