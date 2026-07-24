'use client';

import { useTranslations } from 'next-intl';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

interface AppVersionProps {
  /** Classes for the wrapping paragraph (margins, text size/colour). */
  className?: string;
}

/**
 * Footer label showing the running app version. Clicking it opens the "What's
 * New" release-notes modal for the current version (the modal itself links out
 * to the full GitHub release notes). The version is injected at build time from
 * package.json via NEXT_PUBLIC_APP_VERSION; if it is somehow absent the
 * component renders nothing. Shown in the Settings and login footers.
 */
export function AppVersion({ className }: AppVersionProps) {
  const t = useTranslations('common');
  const open = useWhatsNewStore((state) => state.open);
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;

  return (
    <p className={className}>
      <button
        type="button"
        {...tourAnchor(TOUR_ANCHORS.settingsAppVersion)}
        onClick={open}
        title={t('appVersion.releaseNotes', { version })}
        className="hover:text-gray-600 dark:hover:text-gray-300 hover:underline focus:outline-none focus:underline"
      >
        v{version}
      </button>
    </p>
  );
}
