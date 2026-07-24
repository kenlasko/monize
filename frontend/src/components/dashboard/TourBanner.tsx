'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTourStore } from '@/store/tourStore';
import { useDemoMode } from '@/hooks/useDemoMode';
import { INTRO_TOUR } from '@/lib/tours/registry';

/**
 * Prominent dashboard banner inviting the user to take the guided introduction
 * tour. Shown only on demo instances, on every login (the dismiss is
 * session-only -- reloading, i.e. a fresh login, brings it back), and hidden
 * while a tour is actually running. The button label reflects whether the intro
 * tour has been completed. Reuses the already-localized `tours` copy, so it
 * needs no new strings.
 */
export function TourBanner() {
  const t = useTranslations('tours');
  const tDash = useTranslations('dashboard');
  const isDemoMode = useDemoMode();
  const startTour = useTourStore((s) => s.startTour);
  const active = useTourStore((s) => s.active);
  const introCompleted = useTourStore(
    (s) => s.progress[INTRO_TOUR.id]?.status === 'completed',
  );
  const [dismissed, setDismissed] = useState(false);

  if (!isDemoMode || dismissed || active) return null;

  return (
    <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/30">
      <svg
        className="h-6 w-6 flex-shrink-0 text-blue-600 dark:text-blue-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-blue-900 dark:text-blue-100">
          {t('offer.heading')}
        </p>
        <p className="text-sm text-blue-800 dark:text-blue-200">
          {t('settings.description')}
        </p>
      </div>
      <button
        type="button"
        onClick={() => startTour(INTRO_TOUR)}
        className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-offset-gray-900"
      >
        {introCompleted
          ? t('gettingStarted.retakeTour')
          : t('gettingStarted.takeTour')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={tDash('gettingStarted.dismiss')}
        title={tDash('gettingStarted.dismiss')}
        className="flex-shrink-0 rounded p-1 text-blue-400 hover:bg-blue-100 hover:text-blue-600 dark:hover:bg-blue-800/50 dark:hover:text-blue-200"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
