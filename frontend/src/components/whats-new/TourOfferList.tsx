'use client';

import { useTranslations } from 'next-intl';
import { useTourStore } from '@/store/tourStore';
import { getReleaseTours, INTRO_TOUR } from '@/lib/tours/registry';
import type { TourDefinition } from '@/lib/tours/types';

interface TourOfferListProps {
  /** The running app version; picks the release tours to offer. */
  currentVersion: string;
  /** Close the What's New modal before the tour starts. */
  onClose: () => void;
}

/**
 * The "Take a quick tour" rows inside the What's New modal. Offers the current
 * release's tours plus, for users who never took it, the introduction tour --
 * most existing users have dismissed the Getting Started card, so this row is
 * their only other path to it. Completed tours stay restartable ("Viewed").
 * Renders nothing when there is nothing to offer. Works in demo mode (manual
 * start only).
 */
export function TourOfferList({ currentVersion, onClose }: TourOfferListProps) {
  const t = useTranslations('tours');
  const progress = useTourStore((s) => s.progress);
  const startTour = useTourStore((s) => s.startTour);

  const releaseTours = getReleaseTours(currentVersion);
  const showIntro = !progress[INTRO_TOUR.id];
  const rows: TourDefinition[] = showIntro
    ? [INTRO_TOUR, ...releaseTours]
    : [...releaseTours];

  if (rows.length === 0) return null;

  const handleStart = (tour: TourDefinition) => {
    onClose();
    startTour(tour);
  };

  return (
    <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('offer.heading')}
      </h3>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {t('offer.subheading')}
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((tour) => {
          const isIntro = tour.id === INTRO_TOUR.id;
          const completed = progress[tour.id]?.status === 'completed';
          const title = isIntro
            ? t('offer.introTitle')
            : t(`${tour.i18nPrefix}.title`);
          const subtitle = isIntro
            ? t('offer.introSubtitle')
            : t(`areas.${tour.area}`);
          return (
            <li
              key={tour.id}
              className="flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
                  {title}
                </p>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleStart(tour)}
                className="flex-shrink-0 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                {completed ? t('offer.viewed') : t('offer.showMe')}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
