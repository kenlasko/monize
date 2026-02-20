'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ProviderList } from '@/components/settings/ai/ProviderList';
import { UsageDashboard } from '@/components/settings/ai/UsageDashboard';
import { aiApi } from '@/lib/ai';
import { getErrorMessage } from '@/lib/errors';
import type { AiProviderConfig, AiUsageSummary, AiStatus } from '@/types/ai';
import Link from 'next/link';

export default function AiSettingsPage() {
  return (
    <ProtectedRoute>
      <AiSettingsContent />
    </ProtectedRoute>
  );
}

function AiSettingsContent() {
  const [isLoading, setIsLoading] = useState(true);
  const [configs, setConfigs] = useState<AiProviderConfig[]>([]);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [usageDays, setUsageDays] = useState<number | undefined>(30);

  const loadData = useCallback(async () => {
    try {
      const [configsData, usageData, statusData] = await Promise.all([
        aiApi.getConfigs(),
        aiApi.getUsage(usageDays),
        aiApi.getStatus(),
      ]);
      setConfigs(configsData);
      setUsage(usageData);
      setStatus(statusData);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load AI settings'));
    } finally {
      setIsLoading(false);
    }
  }, [usageDays]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePeriodChange = async (days?: number) => {
    setUsageDays(days);
    try {
      const usageData = await aiApi.getUsage(days);
      setUsage(usageData);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load usage data'));
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
            &larr; Back to Settings
          </Link>
        </div>

        <PageHeader
          title="AI Settings"
          subtitle="Configure AI providers for intelligent financial features"
        />

        <ProviderList
          configs={configs}
          encryptionAvailable={status?.encryptionAvailable ?? false}
          onConfigsChanged={loadData}
          hasSystemDefault={status?.hasSystemDefault}
          systemDefaultProvider={status?.systemDefaultProvider}
          systemDefaultModel={status?.systemDefaultModel}
        />

        {usage && (
          <UsageDashboard
            usage={usage}
            onPeriodChange={handlePeriodChange}
          />
        )}
      </main>
    </PageLayout>
  );
}
