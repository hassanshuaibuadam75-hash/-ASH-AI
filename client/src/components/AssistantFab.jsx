import React from 'react';
import { Link, useLocation } from 'react-router-dom';

// Quick access to #ash AI from anywhere in the app. It is a real link to the assistant, not
// a decorative button: on the AI page itself it is hidden to avoid a pointless duplicate.
export default function AssistantFab() {
  const location = useLocation();
  if (location.pathname === '/ai') return null;

  return (
    <Link
      to="/ai"
      className="ai-fab"
      aria-label="Open #ash AI assistant"
      title="#ash AI assistant"
    >
      <span aria-hidden="true">✦</span>
    </Link>
  );
}
