'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { aiApi } from '@/lib/ai';
import { AiInsight, AiStatus, InsightType, InsightSeverity, INSIGHT_TYPE_LABELS } from '@/types/ai';
import { InsightCard } from './InsightCard';
import { RelayStatusBar } from '@/components/ai/RelayStatusBar';
import { createLogger } from '@/lib/logger';
import Link from 'next/link';
import { ArrowPathIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { summaryGridClass } from '@/components/accounts/shared/SummaryCardGrid';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { PageHeader } from '@/components/layout/PageHeader';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('InsightsList');

/** The severity segments, most urgent first. */
const SEVERITY_FILTERS = ['', 'alert', 'warning', 'info'] as const;

const POLL_INTERVAL = 5000;
const MAX_POLL_ATTEMPTS = 150; // 150 * 5s = 12.5 minutes max for CPU inference

export function InsightsList() {
  const t = useTranslations('insights');
  const formatRelativeTime = useRelativeTime();
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
        const response = await aiApi.getInsights({ includeDismissed: showDismissed });

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
  }, [showDismissed, t]);

  // A change of filter starts a new read: its error is cleared from this render on ("info from previous render").
  const filterKey = `${filterType}|${filterSeverity}|${showDismissed}`;
  const [loadedFilterKey, setLoadedFilterKey] = useState(filterKey);
  if (loadedFilterKey !== filterKey) {
    setLoadedFilterKey(filterKey);
    setError(null);
  }

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const loadInsights = useCallback(() => {
    const run = async () => {
      try {
        // Every insight the user has (the server caps the list), filtered by
        // type and severity here, so each severity segment can carry its count.
        const response = await aiApi.getInsights({ includeDismissed: showDismissed });
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
    };
    return run();
  }, [showDismissed, pollForResults, t]);

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
    setError(null);
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
      setError(t('list.errorDismissFailed'));
    } finally {
      setDismissingId(null);
    }
  };

  const active = insights.filter((i) => !i.isDismissed);
  const alertCount = active.filter((i) => i.severity === 'alert').length;
  const warningCount = active.filter((i) => i.severity === 'warning').length;
  const ofType = filterType ? insights.filter((i) => i.type === filterType) : insights;
  const severityCount = (severity: InsightSeverity | '') =>
    severity ? ofType.filter((i) => i.severity === severity).length : ofType.length;
  const visibleInsights = filterSeverity
    ? ofType.filter((i) => i.severity === filterSeverity)
    : ofType;
  const aiNotConfigured = aiStatus !== null && !aiStatus.configured;
  // Insights are generated through the user's own agent via the reverse MCP
  // relay, which only works while that agent is connected. Rather than a static
  // heads-up, we surface the live tunnel status and the same connect help as the
  // AI Assistant so the user can confirm their agent is listening before they
  // trigger a generation.
  const relayActive = aiStatus?.relayActive === true;

  const header = (
    <PageHeader
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      helpUrl={docsUrl('aiInsights')}
      actions={
        <Button
          variant="outline"
          onClick={handleGenerate}
          isLoading={isGenerating}
          disabled={aiNotConfigured}
          className="gap-1.5 whitespace-nowrap"
        >
          {!isGenerating && <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />}
          {t('list.refreshButton')}
          {lastGeneratedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('list.refreshAge', { time: formatRelativeTime(lastGeneratedAt) })}
            </span>
          )}
        </Button>
      }
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-gray-200 dark:bg-gray-700 rounded-lg"
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {header}
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

      {/* Relay tunnel: live connection status plus the same connect help shown
          on the AI Assistant, so the user can confirm their agent is listening
          before generating. Renders nothing when the relay is not active. */}
      {!aiNotConfigured && <RelayStatusBar enabled={relayActive} />}

      {/* Summary row */}
      <div className={summaryGridClass(3)}>
        <SummaryCard label={t('list.summary.active')} value={active.length} icon={SummaryIcons.list} />
        <SummaryCard
          label={t('list.summary.alerts')}
          value={alertCount}
          icon={<ExclamationCircleIcon className="h-6 w-6 text-red-400" />}
          valueColor={alertCount > 0 ? 'red' : 'default'}
        />
        <SummaryCard
          label={t('list.summary.warnings')}
          value={warningCount}
          icon={SummaryIcons.warning}
          valueColor={warningCount > 0 ? 'yellow' : 'default'}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <Select
          aria-label={t('list.typeFilterLabel')}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as InsightType | '')}
          options={[
            { value: '', label: t('list.allTypes') },
            ...Object.keys(INSIGHT_TYPE_LABELS).map((value) => ({
              value,
              label: t(`insightTypes.${value}`),
            })),
          ]}
          className="w-full sm:w-auto"
        />
        <div role="group" aria-label={t('list.severityFilterLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
          {SEVERITY_FILTERS.map((severity) => (
            <button
              key={severity || 'all'}
              type="button"
              onClick={() => setFilterSeverity(severity)}
              aria-pressed={filterSeverity === severity}
              className={toolbarSegmentClass(filterSeverity === severity)}
            >
              {t(`list.severityFilter.${severity || 'all'}`, { count: severityCount(severity) })}
            </button>
          ))}
        </div>
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
      {visibleInsights.length === 0 ? (
        <EmptyState
          title={total === 0 ? t('list.emptyNoInsights') : t('list.emptyFiltered')}
          action={
            total === 0 && !aiNotConfigured ? (
              <Button onClick={handleGenerate} isLoading={isGenerating}>
                {t('list.generateButton')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {visibleInsights.map((insight) => (
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
    </>
  );
}
