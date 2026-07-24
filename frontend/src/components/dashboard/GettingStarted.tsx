'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { useDemoStore } from '@/store/demoStore';
import { useTourStore } from '@/store/tourStore';
import { INTRO_TOUR } from '@/lib/tours/registry';

export function GettingStarted() {
  const t = useTranslations('dashboard');
  const tt = useTranslations('tours');
  const preferences = usePreferencesStore((s) => s.preferences);
  const updatePreferences = usePreferencesStore((s) => s.updatePreferences);
  const isDemoMode = useDemoStore((s) => s.isDemoMode);
  const startTour = useTourStore((s) => s.startTour);
  const introCompleted = useTourStore(
    (s) => s.progress[INTRO_TOUR.id]?.status === 'completed',
  );
  const [dismissing, setDismissing] = useState(false);

  const steps = [
    {
      title: t('gettingStarted.steps.settings.title'),
      description: t('gettingStarted.steps.settings.description'),
      href: '/settings',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      title: t('gettingStarted.steps.categories.title'),
      description: t('gettingStarted.steps.categories.description'),
      href: '/categories',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
      ),
    },
    {
      title: t('gettingStarted.steps.account.title'),
      description: t('gettingStarted.steps.account.description'),
      href: '/accounts',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      ),
    },
    {
      title: t('gettingStarted.steps.import.title'),
      description: t('gettingStarted.steps.import.description'),
      href: '/import',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      ),
    },
  ];

  if (!preferences || preferences.gettingStartedDismissed || dismissing) {
    return null;
  }

  const handleDismiss = async () => {
    setDismissing(true);
    updatePreferences({ gettingStartedDismissed: true });
    try {
      await userSettingsApi.updatePreferences({ gettingStartedDismissed: true });
    } catch {
      // Already updated locally — best effort
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('gettingStarted.title')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('gettingStarted.subtitle')}
          </p>
          {!isDemoMode && (
            <button
              type="button"
              onClick={() => startTour(INTRO_TOUR)}
              className="mt-2 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              {introCompleted
                ? tt('gettingStarted.retakeTour')
                : tt('gettingStarted.takeTour')}
            </button>
          )}
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          title={t('gettingStarted.dismiss')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map((step) => (
          <Link
            key={step.href}
            href={step.href}
            className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group"
          >
            <div className="flex-shrink-0 text-blue-500 dark:text-blue-400 group-hover:text-blue-600 dark:group-hover:text-blue-300 mt-0.5">
              {step.icon}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {step.title}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {step.description}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
