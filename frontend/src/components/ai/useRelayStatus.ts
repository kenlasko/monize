'use client';

import { useEffect, useState } from 'react';
import { aiApi } from '@/lib/ai';

export type RelayState = 'offline' | 'listening' | 'busy' | 'idle';

const POLL_MS = 5000;

/**
 * Polls the reverse MCP relay tunnel status while `enabled`. Returns the live
 * state ('listening' = an agent is connected and idle, 'busy' = handling a
 * prompt, 'idle' = the agent was disconnected after a spell of inactivity,
 * 'offline' = no agent). Shared by the chat indicator and the provider modal so
 * both reflect the same connection state.
 */
export function useRelayStatus(enabled: boolean): RelayState {
  const [state, setState] = useState<RelayState>('offline');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const poll = () => {
      aiApi
        .getRelayStatus()
        .then((s) => {
          // An inactivity disconnect is shown distinctly from a plain offline so
          // the user knows it was deliberate and that they should reconnect.
          if (active) setState(s.idleDisconnected ? 'idle' : s.state);
        })
        .catch(() => {
          if (active) setState('offline');
        });
    };
    poll();
    const handle = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [enabled]);

  return state;
}
