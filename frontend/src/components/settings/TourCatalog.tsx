'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { useTourStore } from '@/store/tourStore';
import { toursApi } from '@/lib/tours-api';
import { ALL_TOURS } from '@/lib/tours/registry';
import {
  groupToursByArea,
  tourStepCount,
  tourTitleKey,
} from '@/lib/tours/catalog';
import { isTourOfferable } from '@/lib/tours/requirements';
import { useTourRequirements } from '@/hooks/useTourRequirements';
import { createLogger } from '@/lib/logger';
import type { TourDefinition } from '@/lib/tours/types';
import type { TourRequirementMap } from '@/lib/tours/requirements';

const logger = createLogger('Tours');

/** Whether any listed tour is data-gated, so the lookup is worth making. */
const HAS_GATED_TOUR = ALL_TOURS.some((tour) => tour.requiresData);

const GROUPS = groupToursByArea(ALL_TOURS);

/**
 * The whole tour catalog: every tour the app knows about, grouped by area, with
 * its status and a button to start or retake it.
 *
 * Unlike the offer surfaces -- the What's New modal, the dashboard card -- this
 * page shows a tour the user's data cannot reach rather than hiding it. A
 * catalog that quietly changes size is worse than one that explains why a row
 * is not startable yet, and hiding the row leaves no way to find out the tour
 * exists at all.
 */
export function TourCatalog() {
  const t = useTranslations('tours');
  const startTour = useTourStore((s) => s.startTour);
  const clearProgress = useTourStore((s) => s.clearProgress);
  const progress = useTourStore((s) => s.progress);
  const [resetting, setResetting] = useState(false);

  // null until resolved. The rows read that as "not known yet", which is a
  // third state distinct from met and unmet -- see TourRow.
  const requirements = useTourRequirements(HAS_GATED_TOUR);

  const handleReset = async () => {
    setResetting(true);
    try {
      await toursApi.resetProgress();
      clearProgress();
      toast.success(t('settings.resetSuccess'));
    } catch (error) {
      logger.debug('Failed to reset tour progress', error);
      toast.error(t('settings.resetError'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div>
      {GROUPS.map((group) => (
        <section
          key={group.area}
          className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t(`areas.${group.area}`)}
          </h2>
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {group.tours.map((tour) => (
              <TourRow
                key={tour.id}
                tour={tour}
                status={progress[tour.id]?.status}
                requirements={requirements}
                onStart={() => startTour(tour)}
              />
            ))}
          </ul>
        </section>
      ))}

      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('settings.resetHeading')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('settings.resetDescription')}
        </p>
        <Button variant="secondary" onClick={handleReset} disabled={resetting}>
          {t('settings.reset')}
        </Button>
      </div>
    </div>
  );
}

function TourRow({
  tour,
  status,
  requirements,
  onStart,
}: {
  tour: TourDefinition;
  status?: 'completed' | 'dismissed';
  requirements: TourRequirementMap | null;
  onStart: () => void;
}) {
  const t = useTranslations('tours');

  // Three states, kept apart on purpose. "Still resolving" is not "blocked":
  // showing a reason before the lookup answers would tell the user their data
  // is missing when nobody has looked yet.
  const pending = !!tour.requiresData && requirements === null;
  const blocked = !pending && !isTourOfferable(tour, requirements);

  const stepsLabel = t('settings.stepCount', { count: tourStepCount(tour) });
  const statusLabel =
    status === 'completed'
      ? t('offer.viewed')
      : status === 'dismissed'
        ? t('settings.statusDismissed')
        : t('settings.statusNotViewed');

  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t(tourTitleKey(tour))}
        </p>
        {/*
          One catalog string per shape rather than fragments joined in JSX: the
          separators are punctuation a translator has to be able to reorder.
        */}
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {tour.version
            ? t('settings.metaWithRelease', {
                steps: stepsLabel,
                release: t('settings.releaseLabel', { version: tour.version }),
                status: statusLabel,
              })
            : t('settings.meta', { steps: stepsLabel, status: statusLabel })}
        </p>
        {pending && (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {t('settings.requirementsLoading')}
          </p>
        )}
        {blocked && tour.requiresData && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t(`settings.requires.${tour.requiresData}`)}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onStart}
        disabled={pending || blocked}
        aria-busy={pending || undefined}
        className="flex-shrink-0"
      >
        {status ? t('settings.restart') : t('settings.start')}
      </Button>
    </li>
  );
}
