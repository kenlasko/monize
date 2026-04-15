'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { updatesApi, UpdateStatus } from '@/lib/updatesApi';
import { createLogger } from '@/lib/logger';

const logger = createLogger('UpdateAvailableBanner');

/**
 * Admin-only banner that alerts operators when a newer Monize release is
 * available upstream on GitHub. Dismissal is stored per-version on the user's
 * preferences, so a dismissed banner re-appears once the next release lands.
 */
export function UpdateAvailableBanner() {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [hidden, setHidden] = useState(false);

  const isAdmin = isAuthenticated && user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;

    updatesApi
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => {
        // Silent failure — the banner is non-critical and should never surface
        // an error toast to the user. We still log it for debugging.
        logger.debug('Failed to fetch update status', err);
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || !status || hidden) return null;
  if (!status.updateAvailable || status.dismissed) return null;

  const handleDismiss = async () => {
    setHidden(true);
    try {
      await updatesApi.dismiss();
    } catch (err) {
      // If the dismiss call fails, un-hide so the user can try again next load.
      // No toast — silent recovery.
      logger.debug('Failed to dismiss update banner', err);
      setHidden(false);
    }
  };

  const label = status.latestVersion
    ? `Monize v${status.latestVersion} is available`
    : 'A new version of Monize is available';

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800 px-4 py-2 text-center text-sm text-blue-800 dark:text-blue-200 flex items-center justify-center gap-3">
      <span>
        <span className="font-semibold">{label}</span>
        {status.currentVersion && (
          <span className="ml-1 text-blue-700/80 dark:text-blue-300/80">
            (running v{status.currentVersion})
          </span>
        )}
      </span>
      {status.releaseUrl && (
        <a
          href={status.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium hover:text-blue-900 dark:hover:text-blue-100"
        >
          Release notes
        </a>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss update notification"
        className="ml-2 text-blue-700/70 dark:text-blue-300/70 hover:text-blue-900 dark:hover:text-blue-100"
      >
        Dismiss
      </button>
    </div>
  );
}
