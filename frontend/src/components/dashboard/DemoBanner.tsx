'use client';

import { useTranslations } from 'next-intl';
import { useDemoMode } from '@/hooks/useDemoMode';

/**
 * Prominent demo-instance banner shown at the top of the dashboard. Distinct
 * from the thin app-wide strip in SwipeShell: this is a full card that greets a
 * user landing on the dashboard so it is immediately clear they are in the
 * demo. Reuses the shared `layout.demoBanner` copy (already localized) and
 * renders nothing outside demo mode.
 */
export function DemoBanner() {
  const t = useTranslations('layout');
  const isDemoMode = useDemoMode();

  if (!isDemoMode) return null;

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/30"
    >
      <svg
        className="mt-0.5 h-6 w-6 flex-shrink-0 text-amber-600 dark:text-amber-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
        />
      </svg>
      <div>
        <p className="font-semibold text-amber-900 dark:text-amber-100">
          {t('demoBanner.label')}
        </p>
        <p className="text-sm text-amber-800 dark:text-amber-200">
          {t('demoBanner.message')}
        </p>
      </div>
    </div>
  );
}
