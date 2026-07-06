'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { aiApi } from '@/lib/ai';
import { AiInsight, AiStatus, InsightType, InsightSeverity, INSIGHT_TYPE_LABELS, INSIGHT_SEVERITY_LABELS } from '@/types/ai';
import { InsightCard } from './InsightCard';
import { createLogger } from '@/lib/logger';
import Link from 'next/link';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatTime } from '@/lib/utils';

const logger = createLogger('InsightsList');

const POLL_INTERVAL = 5000;
const MAX_POLL_ATTEMPTS = 150; // 150 * 5s = 12.5 minutes max for CPU inference

export function InsightsList() {
  const t = useTranslations('insights');
  const { formatDate } = useDateFormat();
  const timeFormat = usePreferencesStore((s) => s.preferences?.timeFormat) || '24h';
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [total, setTotal] = useState(0);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<InsightType | ''>('');
  const [filterSeverity, setFilterSeverity] = useState<InsightSeverity | ''>('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const pollingRef = useRef(false);

  useEffect(() => {
    aiApi.getStatus().then(setAiStatus).catch(() => {});
  }, []);

  const pollForResults = useCallback(async (previousLastGeneratedAt: string | null) => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setIsGenerating(true);
    let keepGenerating = false;

    try {
      for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        const response = await aiApi.getInsights({
          type: filterType || undefined,
          severity: filterSeverity || undefined,
          includeDismissed: showDismissed,
        });

        if (!response.isGenerating) {
          setInsights(response.insights);
          setTotal(response.total);
          setLastGeneratedAt(response.lastGeneratedAt);
          return;
        }

        // Also check if lastGeneratedAt changed (new results available)
        if (response.lastGeneratedAt !== previousLastGeneratedAt) {
          setInsights(response.insights);
          setTotal(response.total);
          setLastGeneratedAt(response.lastGeneratedAt);
          return;
        }
      }
      // Max attempts reached — show message but keep generating state
      // if the server is still working
      keepGenerating = true;
      setError(t('list.errorTimeout'));
    } finally {
      pollingRef.current = false;
      if (!keepGenerating) {
        setIsGenerating(false);
      }
    }
  }, [filterType, filterSeverity, showDismissed, t]);

  const loadInsights = useCallback(async () => {
    try {
      setError(null);
      const response = await aiApi.getInsights({
        type: filterType || undefined,
        severity: filterSeverity || undefined,
        includeDismissed: showDismissed,
      });
      setInsights(response.insights);
      setTotal(response.total);
      setLastGeneratedAt(response.lastGeneratedAt);

      // Resume polling if generation is in progress on the server
      if (response.isGenerating) {
        pollForResults(response.lastGeneratedAt);
      }
    } catch (err) {
      logger.error('Failed to load insights:', err);
      setError(t('list.errorLoadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [filterType, filterSeverity, showDismissed, pollForResults, t]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    const previousLastGeneratedAt = lastGeneratedAt;
    try {
      await aiApi.generateInsights();
      await pollForResults(previousLastGeneratedAt);
    } catch (err) {
      logger.error('Failed to generate insights:', err);
      setError(t('list.errorGenerateFailed'));
      setIsGenerating(false);
    }
  };

  const handleDismiss = async (id: string) => {
    setDismissingId(id);
    try {
      await aiApi.dismissInsight(id);
      setInsights((prev) =>
        showDismissed
          ? prev.map((i) => (i.id === id ? { ...i, isDismissed: true } : i))
          : prev.filter((i) => i.id !== id),
      );
      setTotal((prev) => (showDismissed ? prev : prev - 1));
    } catch (err) {
      logger.error('Failed to dismiss insight:', err);
    } finally {
      setDismissingId(null);
    }
  };

  const alertCount = insights.filter((i) => i.severity === 'alert' && !i.isDismissed).length;
  const warningCount = insights.filter((i) => i.severity === 'warning' && !i.isDismissed).length;
  const aiNotConfigured = aiStatus !== null && !aiStatus.configured;
  // Insights will be generated through the user's own agent via the reverse
  // MCP relay, which only works while that agent is connected -- worth a
  // heads-up before they trigger a generation.
  const relayActive = aiStatus?.relayActive === true;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-gray-200 dark:bg-gray-700 rounded-lg"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* AI not configured banner */}
      {aiNotConfigured && (
        <div className="p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">{t('notConfigured.heading')}</h3>
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                {t.rich('notConfigured.message', {
                  link: (chunks) => (
                    <Link href="/settings/ai" className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Relay note: generation goes through the user's own MCP agent */}
      {!aiNotConfigured && relayActive && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
            </svg>
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('relayNote')}
            </p>
          </div>
        </div>
      )}

      {/* Header with stats and actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {alertCount > 0 && (
            <span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-full">
              {t('list.alertCount', { count: alertCount })}
            </span>
          )}
          {warningCount > 0 && (
            <span className="px-2 py-1 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded-full">
              {t('list.warningCount', { count: warningCount })}
            </span>
          )}
          {lastGeneratedAt && (() => {
            const d = new Date(lastGeneratedAt);
            const time24 = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('list.lastUpdated', { date: formatDate(d), time: formatTime(time24, timeFormat) })}
              </span>
            );
          })()}
        </div>
        <button
          onClick={handleGenerate}
          disabled={isGenerating || aiNotConfigured}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isGenerating ? t('list.generating') : t('list.refreshButton')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as InsightType | '')}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">{t('list.allTypes')}</option>
          {Object.keys(INSIGHT_TYPE_LABELS).map((value) => (
            <option key={value} value={value}>
              {t(`insightTypes.${value}`)}
            </option>
          ))}
        </select>
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value as InsightSeverity | '')}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">{t('list.allSeverities')}</option>
          {Object.keys(INSIGHT_SEVERITY_LABELS).map((value) => (
            <option key={value} value={value}>
              {t(`insightSeverities.${value}`)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          {t('list.showDismissed')}
        </label>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Insights list */}
      {insights.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            {total === 0
              ? t('list.emptyNoInsights')
              : t('list.emptyFiltered')}
          </p>
          {total === 0 && !aiNotConfigured && (
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isGenerating ? t('list.generating') : t('list.generateButton')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onDismiss={handleDismiss}
              isDismissing={dismissingId === insight.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
