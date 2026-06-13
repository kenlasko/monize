'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ProviderList } from '@/components/settings/ai/ProviderList';
import { CustomInstructionsCard } from '@/components/settings/ai/CustomInstructionsCard';
import { UsageDashboard } from '@/components/settings/ai/UsageDashboard';
import { aiApi } from '@/lib/ai';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import type { AiProviderConfig, AiUsageSummary, AiStatus } from '@/types/ai';
import Link from 'next/link';
import { useDemoMode } from '@/hooks/useDemoMode';

export default function AiSettingsPage() {
  return (
    <ProtectedRoute>
      <AiSettingsContent />
    </ProtectedRoute>
  );
}

function AiSettingsContent() {
  const t = useTranslations('settings.aiSettings');
  const isDemoMode = useDemoMode();
  const [isLoading, setIsLoading] = useState(true);
  const [configs, setConfigs] = useState<AiProviderConfig[]>([]);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [instructions, setInstructions] = useState('');
  const [usageDays, setUsageDays] = useState<number | undefined>(30);

  const loadData = useCallback(async () => {
    try {
      const [configsData, usageData, statusData, preferencesData] = await Promise.all([
        aiApi.getConfigs(),
        aiApi.getUsage(usageDays),
        aiApi.getStatus(),
        userSettingsApi.getPreferences(),
      ]);
      setConfigs(configsData);
      setUsage(usageData);
      setStatus(statusData);
      setInstructions(preferencesData.aiImportInstructions || '');
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [usageDays, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePeriodChange = async (days?: number) => {
    setUsageDays(days);
    try {
      const usageData = await aiApi.getUsage(days);
      setUsage(usageData);
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.usageLoadFailed')));
    }
  };

  if (isLoading) {
    return (
      <PageLayout>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className="flex justify-center items-center h-64">
            <LoadingSpinner />
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="mb-4">
          <Link
            href="/settings"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            &larr; {t('backLink')}
          </Link>
        </div>

        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
        />

        {isDemoMode && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('demoRestricted.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('demoRestricted.body')}
            </p>
          </div>
        )}

        <ProviderList
          configs={configs}
          encryptionAvailable={status?.encryptionAvailable ?? false}
          onConfigsChanged={loadData}
          hasSystemDefault={status?.hasSystemDefault}
          systemDefaultProvider={status?.systemDefaultProvider}
          systemDefaultModel={status?.systemDefaultModel}
          disabled={isDemoMode}
        />

        <CustomInstructionsCard
          initialInstructions={instructions}
          defaultPrompt={status?.defaultSystemPrompt || ''}
          disabled={isDemoMode}
        />

        {usage && (
          <UsageDashboard
            usage={usage}
            configs={configs}
            onPeriodChange={handlePeriodChange}
          />
        )}
      </main>
    </PageLayout>
  );
}
