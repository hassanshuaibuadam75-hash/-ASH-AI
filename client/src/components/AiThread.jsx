import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import ProposalInbox from './ProposalInbox.jsx';
import FounderEditorPanel from './FounderEditorPanel.jsx';

// The one and only @ashai conversation.
//
// Messages are stored server-side per user (ai_thread_messages) and mirrored to localStorage
// so the thread is readable offline and after a reload. It is rendered both inside Messages
// and on the #ash AI page — there is no second, page-local chat state to lose.
const CACHE_PREFIX = 'ash:ai-thread:';
const PENDING_PREFIX = 'ash:ai-pending:';

function cacheKey(userId) {
  return `${CACHE_PREFIX}${userId}`;
}

function readCache(userId) {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCache(userId, messages) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(messages.slice(-200)));
  } catch {
    /* storage full or blocked — the server copy remains authoritative */
  }
}

function readPending(userId) {
  try {
    const raw = localStorage.getItem(`${PENDING_PREFIX}${userId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePending(userId, items) {
  try {
    localStorage.setItem(`${PENDING_PREFIX}${userId}`, JSON.stringify(items.slice(-50)));
  } catch {
    /* ignore */
  }
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function AiThread({ compact = false }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [messages, setMessages] = useState(() => (userId ? readCache(userId) : []));
  const [pending, setPending] = useState(() => (userId ? readPending(userId) : []));
  const [editorAllowed, setEditorAllowed] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [nearBottom, setNearBottom] = useState(true);

  const scrollRef = useRef(null);
  const textRef = useRef(null);
  const endRef = useRef(null);

  const online = status && (typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    if (!userId) return;
    setMessages(readCache(userId));
    setPending(readPending(userId));
  }, [userId]);

  // The editor is offered only when the server confirms Founder authority. A non-Founder
  // gets 403 here, so the controls never even render for them.
  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    api('/founder/editor/status')
      .then(() => { if (alive) setEditorAllowed(true); })
      .catch(() => { if (alive) setEditorAllowed(false); });
    return () => { alive = false; };
  }, [userId]);

  // Auto-scroll only when the reader is already at the bottom, so reading older messages is
  // never interrupted. A "jump to latest" control appears when scrolled up.
  const scrollToEnd = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setNearBottom(distance < 120);
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await api('/ai/thread');
      const list = Array.isArray(data.messages) ? data.messages : [];
      setMessages(list);
      writeCache(userId, list);
      setStatus(true);
      setError('');
    } catch (err) {
      // A failed request never clears the locally stored conversation.
      setStatus(false);
      if (err && err.status === 401) setError('Sign in again to load your #ash AI conversation.');
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function goOnline() { setStatus(true); load(); }
    function goOffline() { setStatus(false); }
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [load]);

  useEffect(() => {
    if (nearBottom) scrollToEnd(false);
  }, [messages.length, pending.length, nearBottom, scrollToEnd]);

  const flushPending = useCallback(async () => {
    if (!userId) return;
    const queue = readPending(userId);
    if (!queue.length) return;
    const remaining = [];
    for (const item of queue) {
      try {
        const data = await api('/ai/thread/messages', {
          method: 'POST',
          body: { content: item.content, clientId: item.clientId, surface: 'chat' },
        });
        setMessages((prev) => {
          const next = [...prev.filter((m) => m.clientId !== item.clientId), data.userMessage];
          if (data.reply) next.push(data.reply);
          writeCache(userId, next);
          return next;
        });
      } catch {
        remaining.push(item);
      }
    }
    writePending(userId, remaining);
    setPending(remaining);
    if (!remaining.length) load();
  }, [userId, load]);

  useEffect(() => {
    if (!online) return;
    flushPending();
  }, [online, flushPending]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sending || !userId) return;
    setSending(true);
    setError('');
    const clientId = newClientId();
    const optimistic = {
      id: `local-${clientId}`,
      role: 'user',
      content,
      clientId,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    setNearBottom(true);
    if (textRef.current) textRef.current.style.height = 'auto';

    try {
      const data = await api('/ai/thread/messages', {
        method: 'POST',
        body: { content, clientId, surface: 'chat' },
      });
      setMessages((prev) => {
        const base = prev.filter((m) => m.clientId !== clientId);
        const next = [...base, data.userMessage];
        if (data.reply) next.push(data.reply);
        writeCache(userId, next);
        return next;
      });
    } catch (err) {
      // Keep the user's words. If the device is offline (or the request never reached the
      // server) queue it for automatic delivery instead of pretending it was answered.
      const queued = { content, clientId, createdAt: optimistic.createdAt };
      const nextQueue = [...readPending(userId), queued];
      writePending(userId, nextQueue);
      setPending(nextQueue);
      const offline = typeof navigator !== 'undefined' && !navigator.onLine;
      setError(
        offline
          ? 'Saved offline — #ash AI will answer when you reconnect.'
          : (err && err.message) || 'Could not reach #ash AI. Your message was saved and will retry.'
      );
    } finally {
      setSending(false);
      requestAnimationFrame(() => {
        if (textRef.current) textRef.current.focus();
      });
    }
  }, [input, sending, userId]);

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  function autoGrow(event) {
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  const empty = useMemo(() => messages.length === 0 && pending.length === 0, [messages.length, pending.length]);

  return (
    <div className={`ai-thread ${compact ? 'compact' : ''}`}>
      <div className="ai-thread-head">
        <div className="ai-badge" aria-hidden="true">✦</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>#ash AI</div>
          <div className="tiny muted">@{'ashai'} · {online ? 'Online' : 'Offline'}</div>
        </div>
        <span className={`dot ${online ? 'ok' : 'off'}`} aria-hidden="true" />
        {editorAllowed ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowEditor((v) => !v)}
            title="Founder app editor"
          >
            {showEditor ? 'Hide editor' : 'Editor'}
          </button>
        ) : null}
      </div>
      {editorAllowed ? <ProposalInbox enabled={editorAllowed} /> : null}
      {editorAllowed && showEditor ? <FounderEditorPanel /> : null}

      <div className="ai-thread-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite">
        {empty ? (
          <div className="ai-empty">
            <p><strong>Ask #ash AI anything.</strong></p>
            <p className="tiny muted">Writing help, translation, marketplace questions or how #ash Mesh works. Your conversation is saved to your account.</p>
          </div>
        ) : null}

        {messages.map((m) => (
          <div key={m.id || m.clientId} className={`bubble-row ${m.role === 'assistant' ? 'in' : 'out'}`}>
            <div className={`bubble ${m.role === 'assistant' ? 'in' : 'out'} ${m.pending ? 'pending' : ''}`}>
              <div className="bubble-text">{m.content}</div>
              <div className="bubble-meta">
                {m.pending ? 'Sending…' : timeLabel(m.createdAt)}
                {m.role === 'assistant' ? ' · AI-generated' : ''}
              </div>
            </div>
          </div>
        ))}

        {pending.map((item) => (
          <div key={`q-${item.clientId}`} className="bubble-row out">
            <div className="bubble out queued">
              <div className="bubble-text">{item.content}</div>
              <div className="bubble-meta">Saved offline — will send automatically</div>
            </div>
          </div>
        ))}

        {sending ? (
          <div className="bubble-row in">
            <div className="bubble in typing"><span /><span /><span /></div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      {!nearBottom ? (
        <button className="jump-latest" onClick={() => { setNearBottom(true); scrollToEnd(); }}>↓ Latest</button>
      ) : null}

      {error ? <div className="ai-thread-error tiny">{error}</div> : null}

      <div className="ai-composer">
        <textarea
          ref={textRef}
          className="textarea"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={autoGrow}
          placeholder="Message #ash AI…"
          aria-label="Message #ash AI"
        />
        <button className="btn primary" onClick={send} disabled={sending || !input.trim()} aria-label="Send message">
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
