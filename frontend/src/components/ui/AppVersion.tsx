'use client';

import { useTranslations } from 'next-intl';

/** Repository whose GitHub releases hold the per-version notes. */
const RELEASE_NOTES_BASE_URL = 'https://github.com/kenlasko/monize/releases/tag/v';

interface AppVersionProps {
  /** Classes for the wrapping paragraph (margins, text size/colour). */
  className?: string;
}

/**
 * Footer label showing the running app version, linked to that version's
 * GitHub release notes (e.g. v1.11.0 ->
 * github.com/kenlasko/monize/releases/tag/v1.11.0). The version is injected at
 * build time from package.json via NEXT_PUBLIC_APP_VERSION; if it is somehow
 * absent the component renders nothing rather than a link to a missing
 * release. Shown in the Settings and login footers.
 */
export function AppVersion({ className }: AppVersionProps) {
  const t = useTranslations('common');
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;

  return (
    <p className={className}>
      <a
        href={`${RELEASE_NOTES_BASE_URL}${version}`}
        target="_blank"
        rel="noopener noreferrer"
        title={t('appVersion.releaseNotes', { version })}
        className="hover:text-gray-600 dark:hover:text-gray-300 hover:underline focus:outline-none focus:underline"
      >
        v{version}
      </a>
    </p>
  );
}
