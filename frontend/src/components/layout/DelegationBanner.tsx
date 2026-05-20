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
      // Full reload so every view re-fetches under the new context, but
      // stay on whatever page the user was on rather than bouncing back
      // to /dashboard each time.
      window.location.reload();
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
        setDelegation(
          res.actingAsUserId,
          res.contexts,
          res.capabilities,
          res.sections,
        );
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

  // Nothing to switch between when there is at most one context (a pure
  // delegate with a single owner, or a normal user) -- hide the banner.
  if (!isAuthenticated || availableContexts.length < 2) return null;

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
    <div
      aria-busy={switching}
      className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 shadow-sm px-4 sm:px-6 lg:px-12 py-2.5 flex items-center gap-3 text-sm"
    >
      <svg
        aria-hidden="true"
        className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-300"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
      <span className="text-amber-700 dark:text-amber-300/90 truncate min-w-0 flex items-center gap-2">
        Viewing:
        <span className="inline-flex items-center max-w-[40vw] sm:max-w-xs truncate rounded-full bg-amber-200/70 dark:bg-amber-800/50 text-amber-900 dark:text-amber-100 font-medium px-2.5 py-0.5">
          {currentLabel}
        </span>
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
        className="ml-auto flex-shrink-0 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm px-2.5 py-1.5 shadow-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
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
