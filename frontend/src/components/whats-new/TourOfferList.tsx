'use client';

import { useTranslations } from 'next-intl';
import { CheckIcon, PlayIcon } from '@heroicons/react/24/solid';
import { Badge } from '@/components/ui/Badge';
import { useTourStore } from '@/store/tourStore';
import { getReleaseTours, INTRO_TOUR } from '@/lib/tours/registry';
import { isTourOfferable } from '@/lib/tours/requirements';
import { useTourRequirements } from '@/hooks/useTourRequirements';
import type { TourDefinition } from '@/lib/tours/types';

interface TourOfferListProps {
  /** The running app version; picks the release tours to offer. */
  currentVersion: string;
  /**
   * Called just before a tour starts, so the What's New modal can step aside:
   * the tour drives the app underneath it.
   */
  onStartTour: () => void;
}

/**
 * The "Take a quick tour" chips inside the What's New modal, one per tour,
 * with the tour's area as the chip's tooltip and a tick once it was viewed. Offers the current
 * release's tours plus, for users who never took it, the introduction tour --
 * most existing users have dismissed the Getting Started card, so this row is
 * their only other path to it. Completed tours stay restartable ("Viewed").
 * Renders nothing when there is nothing to offer. Works in demo mode (manual
 * start only).
 */
export function TourOfferList({
  currentVersion,
  onStartTour,
}: TourOfferListProps) {
  const t = useTranslations('tours');
  const progress = useTourStore((s) => s.progress);
  const startTour = useTourStore((s) => s.startTour);

  const releaseTours = getReleaseTours(currentVersion);
  const showIntro = !progress[INTRO_TOUR.id];
  const candidates: TourDefinition[] = showIntro
    ? [INTRO_TOUR, ...releaseTours]
    : [...releaseTours];

  // Only fetch when a candidate is actually gated, which is the exception.
  const requirements = useTourRequirements(
    candidates.some((tour) => tour.requiresData),
  );
  // A tour about data the user does not have would strand them on its first
  // step, so it is left out rather than offered and then abandoned.
  const rows = candidates.filter((tour) => isTourOfferable(tour, requirements));

  if (rows.length === 0) return null;

  const handleStart = (tour: TourDefinition) => {
    // Start first, step aside second: `startTour` declines a tour with no steps
    // left for this viewport, and a modal that closed for a tour that never ran
    // would neither come back nor clear its pending resume. Both stores settle
    // in one render -- this is a single event handler.
    startTour(tour);
    if (useTourStore.getState().active) onStartTour();
  };

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('offer.heading')}
        </h3>
        {rows.map((tour) => {
          const isIntro = tour.id === INTRO_TOUR.id;
          const completed = progress[tour.id]?.status === 'completed';
          const title = isIntro
            ? t('offer.introTitle')
            : t(`${tour.i18nPrefix}.title`);
          const subtitle = isIntro
            ? t('offer.introSubtitle')
            : t(`areas.${tour.area}`);
          const Icon = completed ? CheckIcon : PlayIcon;
          return (
            <Badge
              key={tour.id}
              as="button"
              type="button"
              size="md"
              variant={completed ? 'gray' : 'blue'}
              title={subtitle}
              onClick={() => handleStart(tour)}
              className="max-w-full hover:brightness-95 dark:hover:brightness-125 transition motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Icon aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{title}</span>
              {completed && <span className="sr-only">{t('offer.viewed')}</span>}
            </Badge>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
        {t('offer.subheading')}
      </p>
    </div>
  );
}
