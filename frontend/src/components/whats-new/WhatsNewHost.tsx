'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { whatsNewApi, type ReleaseNotes } from '@/lib/whats-new';
import { createLogger } from '@/lib/logger';
import { WhatsNewModal } from './WhatsNewModal';

const logger = createLogger('WhatsNew');

/**
 * Drives the "What's New" release-notes modal. Mounted once in the root layout
 * so it is present on every route, including the login screen.
 *
 * On load it fetches the current version's notes: authenticated users get the
 * per-user status (and the modal auto-opens when the backend says so — the
 * backend suppresses this for acknowledged versions, disabled preference, and
 * demo instances); unauthenticated visitors get the public notes so the login
 * screen's version label can still open the modal manually.
 */
export function WhatsNewHost() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isOpen = useWhatsNewStore((s) => s.isOpen);
  const open = useWhatsNewStore((s) => s.open);
  const close = useWhatsNewStore((s) => s.close);

  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const request = isAuthenticated
      ? whatsNewApi.getWhatsNew()
      : whatsNewApi.getReleaseNotes();

    request
      .then((res) => {
        if (cancelled) return;
        setNotes(res.notes);
        setCurrentVersion(
          'currentVersion' in res ? res.currentVersion : res.version,
        );
        if ('autoShow' in res && res.autoShow && res.notes) {
          open();
        }
      })
      .catch((error) => {
        // Non-fatal: the digest is a nicety, never block the app on it.
        logger.debug('Failed to load release notes', error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, open]);

  const handleDontShowAgain = () => {
    whatsNewApi.markSeen().catch((error) => {
      logger.debug('Failed to record release notes as seen', error);
    });
    close();
  };

  const handleShowNextLogin = () => {
    whatsNewApi.remindNextLogin().catch((error) => {
      logger.debug('Failed to reset release notes reminder', error);
    });
    close();
  };

  return (
    <WhatsNewModal
      isOpen={isOpen}
      notes={notes}
      loading={loading}
      authenticated={isAuthenticated}
      currentVersion={currentVersion}
      onClose={close}
      onShowNextLogin={handleShowNextLogin}
      onDontShowAgain={handleDontShowAgain}
    />
  );
}
