'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { notificationsApi } from '@/lib/notifications';
import { publishNotificationsToShell, receivesNotificationsNatively } from '@/lib/shell';
import {
  bridgeIdentity,
  nextShellPollDelay,
  shellNotificationRows,
} from '@/lib/shell-notifications';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ShellNotificationBridge');

/**
 * Feeds a native shell's notification bridge (`docs/frontend/shell-contract.md`,
 * "Native notifications"): while signed in, read the notification centre every
 * minute and hand the shell the unread rows; on sign-out, tell it nobody is.
 *
 * The page polls rather than the shell because the page holds the session:
 * these are the bell's own requests, through `apiClient` with its refresh and
 * CSRF handling, so the shell never touches a credential. The full list is
 * read, as the bell reads it, because that read is what materializes bill
 * reminders. The shell decides what is new and keeps that across reloads; this
 * only reports what is there.
 *
 * Mounted once, in the authenticated shell; a no-op outside a shell that
 * receives notifications natively, so a browser makes no extra request.
 */
export function useShellNotificationBridge(): void {
  const enabled = receivesNotificationsNatively();
  const identity = useAuthStore((state) =>
    bridgeIdentity({
      hasHydrated: state._hasHydrated,
      isAuthenticated: state.isAuthenticated,
      userId: state.user?.id ?? null,
      actingAsUserId: state.actingAsUserId,
    }),
  );
  const t = useTranslations('notifications.native');
  // The copy follows the reader's language without restarting the poll.
  const copy = useRef<(key: string) => { title: string; body: string }>(() => ({
    title: '',
    body: '',
  }));
  useEffect(() => {
    copy.current = (key) => ({ title: t(`${key}.title`), body: t(`${key}.body`) });
  }, [t]);

  useEffect(() => {
    if (!enabled || identity === undefined) return;
    if (identity === null) {
      publishNotificationsToShell({ identity: null, rows: [] });
      return;
    }

    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const notifications = await notificationsApi.list();
        // Signed out or switched while the request was out: these rows are
        // the previous person's, and the next identity's effect publishes.
        if (cancelled) return;
        publishNotificationsToShell({
          identity,
          rows: shellNotificationRows(notifications, copy.current),
        });
        failures = 0;
      } catch (error) {
        failures += 1;
        logger.debug('Could not read notifications for the shell', error);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), nextShellPollDelay(failures));
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, identity]);
}
