'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Terminal, Minus, Maximize2 } from 'lucide-react';

const KIND_LABEL = { platoon: 'TX', alert: 'RX', clear: 'OK', drain: 'DRN', preempt: 'PRE', emergency: 'SOS' };

/** Floating inter-agent message log. `messages` are the swarm mesh's log entries (newest last). */
export default function SwarmTerminal({ messages, selectedId, mode }) {
  const [minimized, setMinimized] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const bodyRef = useRef(null);
  const stickRef = useRef(true);

  const shown = (onlySelected && selectedId ? messages.filter(m => m.junction === selectedId || m.junction === null) : messages).slice(-120);
  const last = shown.length ? shown[shown.length - 1].seq : 0;

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [last, minimized]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className={`swarm-terminal ${minimized ? 'min' : ''}`}>
      <div className="swarm-terminal-head">
        <Terminal size={13} />
        <span className="swarm-terminal-title">inter-agent bus</span>
        <span className="swarm-terminal-live">● {messages.length ? `seq ${messages[messages.length - 1].seq}` : 'idle'}</span>
        <button onClick={() => setMinimized(m => !m)} aria-label={minimized ? 'Expand terminal' : 'Minimize terminal'}>
          {minimized ? <Maximize2 size={12} /> : <Minus size={12} />}
        </button>
      </div>
      {!minimized && (
        <>
          <div className="swarm-terminal-sub">
            {mode === 'fixed'
              ? 'Map shows static timers (no messages). The swarm mesh keeps running in parallel:'
              : 'Live JunctionAgent messages:'}
            <label>
              <input type="checkbox" checked={onlySelected} onChange={e => setOnlySelected(e.target.checked)} />
              selected junction
            </label>
          </div>
          <div className="swarm-terminal-body" ref={bodyRef} onScroll={onScroll}>
            {shown.length === 0 && <div className="term-line muted">waiting for first platoon…</div>}
            {shown.map(m => (
              <div key={m.seq} className={`term-line k-${m.kind}`}>
                <span className="term-clock">[{m.clock}]</span>{' '}
                <span className="term-kind">{KIND_LABEL[m.kind] || m.kind}</span>{' '}
                <span className="term-who">[{m.who}]</span>{' '}
                <span className="term-text">{m.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
