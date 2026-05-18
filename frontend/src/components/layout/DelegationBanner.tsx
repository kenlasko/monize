'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { delegationApi } from '@/lib/delegation';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DelegationBanner');

/**
 * Always-visible "Viewing: X" indicator + context switcher for delegates
 * (Phase 1, req 1G/1H). Renders nothing for normal users with no delegations.
 */
export function DelegationBanner() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const availableContexts = useAuthStore((s) => s.availableContexts);
  const setDelegation = useAuthStore((s) => s.setDelegation);
  const [switching, setSwitching] = useState(false);
  const autoPicked = useRef(false);

  const switchTo = useCallback(async (targetUserId: string) => {
    setSwitching(true);
    try {
      await delegationApi.switchContext(targetUserId);
      // Full reload so every view re-fetches under the new context.
      window.location.assign('/dashboard');
    } catch (err: unknown) {
      setSwitching(false);
      const status =
        typeof err === 'object' && err && 'response' in err
          ? (err as { response?: { status?: number; data?: { message?: string } } }).response
          : undefined;
      if (status?.data?.message === 'DELEGATE_2FA_REQUIRED') {
        toast.error(
          'That account requires two-factor authentication. Set up 2FA in Settings before switching.',
        );
      } else {
        toast.error('Unable to switch account');
      }
      logger.error(err);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    delegationApi
      .getContexts()
      .then((res) => {
        if (cancelled) return;
        setDelegation(res.actingAsUserId, res.contexts, res.capabilities);
        // Smart auto-pick: a pure delegate with exactly one owner context
        // and not yet acting is dropped straight into that account.
        if (
          !autoPicked.current &&
          res.actingAsUserId === null &&
          res.contexts.length === 1 &&
          !res.contexts[0].isSelf
        ) {
          autoPicked.current = true;
          void switchTo(res.contexts[0].userId);
        }
      })
      .catch((err) => {
        // Non-delegate users get an empty list / harmless failure.
        logger.error(err);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, setDelegation, switchTo]);

  if (!isAuthenticated || availableContexts.length === 0) return null;

  const current =
    availableContexts.find((c) =>
      actingAsUserId === null ? c.isSelf : c.userId === actingAsUserId,
    ) ?? null;
  const currentLabel = current
    ? current.label
    : actingAsUserId
      ? availableContexts.find((c) => c.userId === actingAsUserId)?.label ??
        'Shared account'
      : 'Your account';

  return (
    <div className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-700 px-4 sm:px-6 lg:px-12 py-2 flex flex-wrap items-center gap-3 text-sm">
      <span className="font-medium text-amber-900 dark:text-amber-100">
        Viewing: {currentLabel}
      </span>
      <label className="sr-only" htmlFor="delegation-context-select">
        Switch account
      </label>
      <select
        id="delegation-context-select"
        disabled={switching}
        value={actingAsUserId ?? current?.userId ?? ''}
        onChange={(e) => {
          if (e.target.value) void switchTo(e.target.value);
        }}
        className="rounded border border-amber-400 dark:border-amber-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1"
      >
        {availableContexts.map((c) => (
          <option key={c.userId} value={c.userId}>
            {c.isSelf ? `${c.label} (you)` : c.label}
          </option>
        ))}
      </select>
    </div>
  );
}
