'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useTourStore } from '@/store/tourStore';
import { toursApi } from '@/lib/tours-api';
import { INTRO_TOUR } from '@/lib/tours/registry';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Tours');

/**
 * Settings row for guided tours: start the introduction tour on demand, or
 * reset all recorded tour progress so completed/dismissed tours are offered
 * afresh. Extracted from PreferencesSection to keep that file under the size
 * ceiling.
 */
export function TourSettingsRow() {
  const t = useTranslations('tours');
  const startTour = useTourStore((s) => s.startTour);
  const clearProgress = useTourStore((s) => s.clearProgress);
  const [resetting, setResetting] = useState(false);

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
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('settings.title')}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('settings.description')}
      </span>
      <div className="mt-1 flex flex-wrap gap-4">
        <button
          type="button"
          onClick={() => startTour(INTRO_TOUR)}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('settings.startIntro')}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={resetting}
          className="text-sm font-medium text-gray-600 hover:underline disabled:opacity-50 dark:text-gray-300"
        >
          {t('settings.reset')}
        </button>
      </div>
    </div>
  );
}
