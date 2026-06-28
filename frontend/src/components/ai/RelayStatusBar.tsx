'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRelayStatus, type RelayState } from './useRelayStatus';
import { RelayConnectInstructions } from './RelayConnectInstructions';

const DOT_CLASS: Record<RelayState, string> = {
  // Blinking green = an agent is connected and listening.
  listening: 'bg-green-500 animate-pulse',
  // Solid amber = connected but currently handling a prompt.
  busy: 'bg-amber-500',
  // Solid amber (no pulse) = disconnected after inactivity; reconnect to resume.
  idle: 'bg-amber-400 dark:bg-amber-500',
  // Grey = no agent connected.
  offline: 'bg-gray-400 dark:bg-gray-600',
};

/**
 * Tunnel indicator for relay mode: a status dot plus a collapsible helper with
 * the exact command and loop prompt to connect a local MCP agent. Renders
 * nothing unless relay mode is on.
 */
export function RelayStatusBar({ enabled }: { enabled: boolean }) {
  const t = useTranslations('ai');
  const state = useRelayStatus(enabled);
  const [showHelp, setShowHelp] = useState(false);
  const toggleHelp = useCallback(() => setShowHelp((v) => !v), []);

  if (!enabled) return null;

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span
          className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[state]}`}
          aria-hidden="true"
        />
        <span>{t(`relay.status.${state}`)}</span>
        <button
          type="button"
          onClick={toggleHelp}
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          {showHelp ? t('relay.hideHelp') : t('relay.howToConnect')}
        </button>
      </div>

      {showHelp && (
        <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
          <RelayConnectInstructions />
        </div>
      )}
    </div>
  );
}
