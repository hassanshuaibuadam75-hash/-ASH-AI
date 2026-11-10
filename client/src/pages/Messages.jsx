import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatTime } from '../api.js';
import { useAuth } from '../App.jsx';
import { Avatar, Empty, Spinner, useToast, Badge } from '../ui.jsx';
import { encryptForPeer, decryptFromPeer, encryptFile, decryptFile } from '../crypto.js';
import AiThread from '../components/AiThread.jsx';
import {
  ROUTE, ROUTE_LABEL, chooseRoute, newClientId, queueOutgoing, listQueued,
  removeQueued, bumpQueued, reportRoute, readCapabilities,
} from '../uar.js';

const MAX_UPLOAD = 25 * 1024 * 1024;

function otherPeer(conversation, meId) {
  return conversation?.peers?.find((p) => p.id !== meId) || conversation?.peers?.[0] || null;
}

export default function Messages() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('c');
  const aiOpen = params.get('ai') === '1';
  const [conversations, setConversations] = useState(null);
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [decrypted, setDecrypted] = useState({});
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [recording, setRecording] = useState(false);
  const [caps, setCaps] = useState(null);
  const bottomRef = useRef(null);
  const recorderRef = useRef(null);
  const pollRef = useRef(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api('/conversations');
      setConversations(data.conversations);
    } catch (err) {
      toast.push(err.message, 'error');
      setConversations([]);
    }
  }, [toast]);

  useEffect(() => { loadConversations(); readCapabilities().then(setCaps); }, [loadConversations]);

  // Load the active thread.
  useEffect(() => {
    if (!activeId) { setThread(null); setMessages([]); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const data = await api(`/conversations/${activeId}/messages`);
        if (cancelled) return;
        setMessages(data.messages);
        setThread(data.conversation || null);
        await api(`/conversations/${activeId}/read`, { method: 'POST' }).catch(() => {});
      } catch (err) {
        if (!cancelled) toast.push(err.message, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, toast]);

  // Decrypt everything we can; failures stay visible as "unable to decrypt".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const message of messages) {
        if (decrypted[message.id] !== undefined) { next[message.id] = decrypted[message.id]; continue; }
        if (!message.envelope) { next[message.id] = { error: 'missing' }; continue; }
        try {
          next[message.id] = { payload: await decryptFromPeer(message.envelope) };
        } catch {
          next[message.id] = { error: 'undecryptable' };
        }
      }
      if (!cancelled) setDecrypted((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const refreshQueue = useCallback(async () => {
    try { setQueuedCount((await listQueued()).length); } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => { refreshQueue(); }, [refreshQueue]);

  // Flush the offline queue whenever connectivity returns.
  const flushQueue = useCallback(async () => {
    if (!navigator.onLine) return;
    let items = [];
    try { items = await listQueued(); } catch { return; }
    if (!items.length) return;
    const batch = items.slice(0, 50).map((item) => ({
      conversationId: item.conversationId, clientId: item.clientId, kind: item.kind,
      envelope: item.envelope, mediaId: item.mediaId || null, transport: item.transport || 'queued',
    }));
    try {
      const { results } = await api('/messages/sync', { method: 'POST', body: { messages: batch } });
      let sent = 0;
      for (const result of results) {
        if (result.status === 'accepted') { await removeQueued(result.clientId); sent += 1; }
        else {
          const original = items.find((i) => i.clientId === result.clientId);
          if (original) await bumpQueued(original);
        }
      }
      if (sent) toast.push(`${sent} queued message${sent > 1 ? 's' : ''} delivered.`, 'success');
      await refreshQueue();
      if (activeId) {
        const data = await api(`/conversations/${activeId}/messages`);
        setMessages(data.messages);
      }
      loadConversations();
    } catch {
      /* still offline — retried on the next online event */
    }
  }, [activeId, loadConversations, refreshQueue, toast]);

  useEffect(() => {
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => { if (navigator.onLine) flushQueue(); }, 30000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(timer); };
  }, [flushQueue]);

  // Poll the open thread for new messages while the tab is visible.
  useEffect(() => {
    if (!activeId) return undefined;
    pollRef.current = setInterval(async () => {
      if (document.hidden || !navigator.onLine) return;
      try {
        const data = await api(`/conversations/${activeId}/messages`);
        setMessages((prev) => (data.messages.length !== prev.length ? data.messages : prev));
      } catch { /* transient */ }
    }, 6000);
    return () => clearInterval(pollRef.current);
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, activeId]);

  const peer = useMemo(() => {
    const conversation = thread || conversations?.find((c) => c.id === activeId);
    return otherPeer(conversation, user.id);
  }, [thread, conversations, activeId, user.id]);

  const peerKey = peer?.publicKey || null;

  async function sendPayload(payload, kind, mediaId) {
    const clientId = newClientId();
    const route = chooseRoute({ online: navigator.onLine, peers: 0, battery: caps?.battery });
    const item = {
      conversationId: activeId, clientId, kind, mediaId: mediaId || null,
      transport: route === ROUTE.OFFLINE ? 'queued' : 'internet',
      envelope: await encryptForPeer(peerKey, payload),
    };

    if (route === ROUTE.OFFLINE) {
      await queueOutgoing(item);
      await refreshQueue();
      toast.push('Saved offline — it will send automatically when you reconnect.', 'info');
      return;
    }
    try {
      const { message } = await api(`/conversations/${activeId}/messages`, { method: 'POST', body: item });
      setMessages((prev) => [...prev, message]);
      reportRoute(route, { size: 1 });
      loadConversations();
    } catch (err) {
      if (err.status === 0 || !navigator.onLine) {
        await queueOutgoing(item);
        await refreshQueue();
        toast.push('Connection lost — message queued and will retry.', 'info');
      } else {
        toast.push(err.message, 'error');
      }
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeId || !peerKey) return;
    setSending(true);
    setDraft('');
    try {
      await sendPayload({ text }, 'text');
    } finally {
      setSending(false);
    }
  }

  async function handleFile(event, forcedKind) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeId) return;
    if (!peerKey) { toast.push('Encryption keys are not available for this contact yet.', 'error'); return; }
    if (file.size > MAX_UPLOAD) { toast.push('Files must be 25 MB or smaller.', 'error'); return; }
    const kind = forcedKind || (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file');
    setSending(true);
    try {
      const { blob, meta } = await encryptFile(file);
      const form = new FormData();
      form.append('file', blob, `${meta.name}.enc`);
      form.append('kind', kind);
      const { mediaId } = await api(`/conversations/${activeId}/attachments`, { method: 'POST', form });
      await sendPayload({ text: draft.trim(), file: meta }, kind, mediaId);
      setDraft('');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSending(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.push('Voice recording is not available in this browser.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
        const fake = { target: { files: [file], value: '' } };
        await handleFile(fake, 'audio');
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast.push('Microphone permission was not granted.', 'error');
    }
  }

  async function openAttachment(message) {
    const entry = decrypted[message.id];
    const meta = entry?.payload?.file;
    if (!meta || !message.mediaUrl) return;
    try {
      const res = await api(message.mediaUrl.replace('/api', ''), { raw: true });
      const buffer = await res.arrayBuffer();
      const blob = await decryptFile(buffer, meta);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name || 'attachment';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      toast.push('Could not open that encrypted attachment.', 'error');
    }
  }

  if (!conversations) return <Spinner label="Loading conversations" />;

  return (
    <div className="messages-layout">
      <aside className="card conv-list">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>Messages</strong>
          {queuedCount ? <Badge tone="amber">{queuedCount} queued</Badge> : null}
        </div>
        {/* Official assistant first, always. Opens the persistent @ashai thread in place, so
            the conversation is not lost by navigating to another page. */}
        <button
          type="button"
          className={`conv-item pinned-ai ${aiOpen ? 'active' : ''}`}
          onClick={() => setParams({ ai: '1' })}
        >
          <span className="avatar ai-avatar" aria-hidden="true">✦</span>
          <span className="conv-meta">
            <span className="conv-name">#ash AI</span>
            <span className="tiny muted">Official assistant · AI</span>
          </span>
          <Badge tone="green">AI</Badge>
        </button>

        {conversations.length === 0 ? (
          <p className="muted small">No conversations yet. Open a profile and choose “Message”.</p>
        ) : null}
        {conversations.map((conversation) => {
          const other = otherPeer(conversation, user.id);
          return (
            <button
              key={conversation.id}
              className={`conv-item ${conversation.id === activeId ? 'active' : ''}`}
              onClick={() => setParams({ c: conversation.id })}
            >
              <Avatar user={other} size={38} />
              <span className="conv-meta">
                <span className="conv-name">{other?.fullName || other?.username || 'Conversation'}</span>
                <span className="tiny muted">
                  {conversation.lastMessage ? formatTime(conversation.lastMessage.createdAt) : 'No messages yet'}
                </span>
              </span>
              {conversation.unread ? <Badge tone="green">{conversation.unread}</Badge> : null}
            </button>
          );
        })}
      </aside>

      <section className="card thread">
        {aiOpen ? (
          <AiThread />
        ) : !activeId ? (
          <Empty title="Your private conversations" hint="Messages are encrypted on your device before they are sent." />
        ) : (
          <>
            <header className="row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
              <div className="row">
                <Avatar user={peer} size={34} />
                <div>
                  <div style={{ fontWeight: 700 }}>{peer?.fullName || peer?.username || 'Conversation'}</div>
                  <div className="tiny muted">End-to-end encrypted on this device</div>
                </div>
              </div>
              {queuedCount ? <Badge tone="amber">{queuedCount} offline</Badge> : <Badge tone="green">Secure</Badge>}
            </header>

            {!peerKey ? (
              <div className="banner warn" style={{ marginTop: 12 }}>
                This contact has not opened #ash Mesh on a device yet, so no encryption key is published.
                You cannot send encrypted messages until they do.
              </div>
            ) : null}

            <div className="thread-body">
              {messages.length === 0 ? <p className="muted small">No messages yet. Say hello.</p> : null}
              {messages.map((message) => {
                const entry = decrypted[message.id];
                const payload = entry?.payload;
                const mine = message.senderId === user.id;
                return (
                  <div key={message.id} className={`bubble-row ${mine ? 'mine' : ''}`}>
                    <div className={`bubble ${mine ? 'mine' : ''}`}>
                      {entry?.error ? (
                        <span className="tiny muted">Encrypted message — cannot be decrypted on this device.</span>
                      ) : !payload ? (
                        <span className="tiny muted">Decrypting…</span>
                      ) : (
                        <>
                          {payload.text ? <div className="bubble-text">{payload.text}</div> : null}
                          {payload.file ? (
                            <button className="link-btn" onClick={() => openAttachment(message)}>
                              🔒 {payload.file.name} · {(payload.file.size / 1024).toFixed(0)} KB — tap to decrypt &amp; open
                            </button>
                          ) : null}
                        </>
                      )}
                      <div className="tiny muted bubble-meta">
                        {formatTime(message.createdAt)}
                        {mine ? ` · ${message.status === 'read' ? 'Read' : message.status === 'delivered' ? 'Delivered' : 'Sent'}` : ''}
                        {message.transport === 'nearby' ? ' · #ash Nearby' : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <form className="composer" onSubmit={handleSend}>
              <label className="icon-btn" title="Send a photo or video">
                📎
                <input type="file" accept="image/*,video/*" hidden onChange={(e) => handleFile(e)} />
              </label>
              <label className="icon-btn" title="Send a file">
                🗂️
                <input type="file" hidden onChange={(e) => handleFile(e, 'file')} />
              </label>
              <button type="button" className={`icon-btn ${recording ? 'rec' : ''}`} onClick={toggleRecording} title="Record a voice message">
                {recording ? '⏹️' : '🎙️'}
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={peerKey ? 'Write an encrypted message…' : 'Encryption key unavailable'}
                disabled={!peerKey || sending}
                aria-label="Message"
              />
              <button className="btn primary" disabled={!draft.trim() || !peerKey || sending}>
                {sending ? <span className="spinner" /> : 'Send'}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
