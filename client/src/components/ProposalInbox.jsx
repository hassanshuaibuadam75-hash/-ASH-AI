// #ash Mesh — Founder-only proposal inbox, rendered inside the @ashai conversation.
//
// When the Founder asks #ash AI to change the application, the server stores an inert
// proposal. This inbox surfaces any proposal still awaiting a decision so the approval card
// is never lost after a reload or navigation. A non-Founder gets 403 from the API and the
// inbox renders nothing at all.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import EditorProposal from './EditorProposal.jsx';

export default function ProposalInbox({ enabled }) {
  const [items, setItems] = useState([]);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api('/founder/editor/proposals?limit=10');
      const list = Array.isArray(data.proposals) ? data.proposals : [];
      setItems(list.filter((p) => p.status === 'proposed'));
    } catch (err) {
      if (err && (err.status === 403 || err.status === 401)) setDenied(true);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 5000);
    return () => clearInterval(timer);
  }, [enabled, load]);

  if (!enabled || denied || !items.length) return null;

  return (
    <div className="editor-inbox">
      {items.map((proposal) => (
        <EditorProposal key={proposal.id} initial={proposal} />
      ))}
    </div>
  );
}
