'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  AiUsageSummary,
  AiProviderConfig,
  AiProviderType,
  EstimatedCostByCurrency,
} from '@/types/ai';
import { AI_PROVIDER_LABELS } from '@/types/ai';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { preferredCurrency } from '@/lib/default-currency';
import { Th } from '@/components/ui/Table';

interface UsageDashboardProps {
  usage: AiUsageSummary;
  configs: AiProviderConfig[];
  onPeriodChange: (days?: number) => void;
}

// The two tables sit inside the dashboard card, flush with its headings, so
// the header cells keep TH_CLASS's face with the compact padding of the rows.
const USAGE_CELL_PAD = 'px-2 pt-0 pb-2 first:pl-0 last:pr-0';

const PERIOD_OPTIONS = [
  { labelKey: 'periods.d7', value: 7 },
  { labelKey: 'periods.d30', value: 30 },
  { labelKey: 'periods.d90', value: 90 },
  { labelKey: 'periods.all', value: undefined },
];

function providerLabel(provider: string): string {
  return AI_PROVIDER_LABELS[provider as AiProviderType] ?? provider;
}

/** Resolve a log's provider+model to the user's display name. */
function resolveLogName(
  provider: string,
  model: string,
  configs: AiProviderConfig[],
): string {
  const exact = configs.find(
    (c) => c.provider === provider && c.model === model && c.displayName,
  );
  if (exact?.displayName) return exact.displayName;
  const byProvider = configs.find(
    (c) => c.provider === provider && c.displayName,
  );
  if (byProvider?.displayName) return byProvider.displayName;
  return providerLabel(provider);
}

/** Display name for a provider-level aggregation row. */
function resolveProviderName(
  provider: string,
  configs: AiProviderConfig[],
): string {
  const matches = configs.filter((c) => c.provider === provider);
  if (matches.length === 1 && matches[0].displayName) {
    return matches[0].displayName;
  }
  return providerLabel(provider);
}

/** True when the per-currency bucket contains at least one positive amount. */
function hasAnyCost(bucket: EstimatedCostByCurrency): boolean {
  return Object.values(bucket).some((v) => v > 0);
}

export function UsageDashboard({ usage, configs, onPeriodChange }: UsageDashboardProps) {
  const t = useTranslations('settings.usage');
  // Request and token counts are read by a person, so they follow the
  // configured number locale like every other figure -- never the browser's,
  // which an explicit `numberFormat` preference exists to override.
  const { formatNumber, formatCurrencyPrecise } = useNumberFormat();
  /**
   * A model call costs fractions of a cent, so this column shows 2-4 decimals
   * rather than the currency's own two -- `formatCurrencyPrecise` expands only
   * when the base precision would round to zero, which is the same rule.
   * An unknown currency code loses the symbol rather than the reader's locale.
   */
  const formatCost = useCallback(
    (value: number, currency: string) => formatCurrencyPrecise(value, currency, 2),
    [formatCurrencyPrecise],
  );
  const [selectedPeriod, setSelectedPeriod] = useState<number | undefined>(30);
  const [showInHomeCurrency, setShowInHomeCurrency] = useState(true);
  const homeCurrency =
    preferredCurrency(
      usePreferencesStore((state) => state.preferences?.defaultCurrency),
    );
  const { formatDate } = useDateFormat();

  const handlePeriodChange = (days: number | undefined) => {
    setSelectedPeriod(days);
    onPeriodChange(days);
  };

  // Collect all distinct cost currencies that appear in the response so we
  // can decide whether to show the currency-mode toggle.
  const currenciesInUse = useMemo(() => {
    const set = new Set<string>();
    Object.keys(usage.totalEstimatedCostByCurrency).forEach((c) => set.add(c));
    usage.byProvider.forEach((row) =>
      Object.keys(row.estimatedCostByCurrency).forEach((c) => set.add(c)),
    );
    usage.recentLogs.forEach((log) => {
      if (log.costCurrency) set.add(log.costCurrency);
    });
    return set;
  }, [usage]);

  const hasForeignCurrency = useMemo(() => {
    for (const c of currenciesInUse) {
      if (c !== homeCurrency) return true;
    }
    return false;
  }, [currenciesInUse, homeCurrency]);

  // Format a bucket either as a single home-currency amount or as one line
  // per provider currency. The home-currency figure is the server's, each
  // day's cost at that day's rate, never a period of usage at today's rate
  // (issue #2106).
  const renderBucket = (
    bucket: EstimatedCostByCurrency,
    inReportingCurrency: number | null | undefined,
  ): string => {
    if (!hasAnyCost(bucket)) return '-';
    if (showInHomeCurrency || !hasForeignCurrency) {
      if (!hasForeignCurrency) {
        const [[currency, amount]] = Object.entries(bucket);
        return formatCost(amount, currency);
      }
      // A bucket that cannot be fully converted is reported as unavailable
      // rather than as the sum of the currencies that happened to have rates.
      if (inReportingCurrency === null || inReportingCurrency === undefined) return '-';
      return formatCost(inReportingCurrency, usage.reportingCurrency ?? homeCurrency);
    }
    return Object.entries(bucket)
      .filter(([, amount]) => amount > 0)
      .map(([currency, amount]) => formatCost(amount, currency))
      .join(' + ');
  };

  const renderLogCost = (log: AiUsageSummary['recentLogs'][number]): string => {
    if (log.estimatedCost === null || !log.costCurrency) return '-';
    if (showInHomeCurrency && log.costCurrency !== homeCurrency) {
      const converted = log.estimatedCostInReportingCurrency;
      if (converted === null || converted === undefined) return '-';
      return formatCost(converted, usage.reportingCurrency ?? homeCurrency);
    }
    return formatCost(log.estimatedCost, log.costCurrency);
  };

  const totalHasCost = hasAnyCost(usage.totalEstimatedCostByCurrency);

  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('heading')}</h2>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.labelKey}
              onClick={() => handlePeriodChange(opt.value)}
              className={`px-3 py-1 text-xs rounded-md ${
                selectedPeriod === opt.value
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {hasForeignCurrency && (
        <div className="flex justify-end mb-3">
          <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 text-xs overflow-hidden">
            <button
              type="button"
              onClick={() => setShowInHomeCurrency(true)}
              className={`px-3 py-1 ${
                showInHomeCurrency
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              {t('inHomeCurrency', { currency: homeCurrency })}
            </button>
            <button
              type="button"
              onClick={() => setShowInHomeCurrency(false)}
              className={`px-3 py-1 ${
                !showInHomeCurrency
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              {t('inProviderCurrency')}
            </button>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('totalRequests')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatNumber(usage.totalRequests, 0)}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('inputTokens')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatNumber(usage.totalInputTokens, 0)}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('outputTokens')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatNumber(usage.totalOutputTokens, 0)}
          </p>
        </div>
        <div
          className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4"
          title={t('estCostTooltip')}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('estCost')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {totalHasCost ? renderBucket(usage.totalEstimatedCostByCurrency, usage.totalEstimatedCostInReportingCurrency) : '-'}
          </p>
          {!totalHasCost && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
              {t('setRatesToEnable')}
            </p>
          )}
        </div>
      </div>

      {/* By Provider */}
      {usage.byProvider.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('byProvider.heading')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <Th className={USAGE_CELL_PAD}>{t('byProvider.provider')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('byProvider.requests')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('byProvider.inputTokens')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('byProvider.outputTokens')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('byProvider.estCost')}</Th>
                </tr>
              </thead>
              <tbody>
                {usage.byProvider.map((row) => (
                  <tr key={row.provider} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-gray-900 dark:text-gray-100">{resolveProviderName(row.provider, configs)}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">{formatNumber(row.requests, 0)}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">{formatNumber(row.inputTokens, 0)}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">{formatNumber(row.outputTokens, 0)}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">{renderBucket(row.estimatedCostByCurrency, row.estimatedCostInReportingCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Logs */}
      {usage.recentLogs.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('recentActivity.heading')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <Th className={USAGE_CELL_PAD}>{t('recentActivity.date')}</Th>
                  <Th className={USAGE_CELL_PAD}>{t('recentActivity.provider')}</Th>
                  <Th className={USAGE_CELL_PAD}>{t('recentActivity.feature')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('recentActivity.tokens')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('recentActivity.duration')}</Th>
                  <Th align="right" className={USAGE_CELL_PAD}>{t('recentActivity.estCost')}</Th>
                </tr>
              </thead>
              <tbody>
                {usage.recentLogs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-gray-600 dark:text-gray-300">
                      {formatDate(new Date(log.createdAt))}
                    </td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-gray-900 dark:text-gray-100">{resolveLogName(log.provider, log.model, configs)}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-gray-600 dark:text-gray-300">{log.feature}</td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">
                      {formatNumber(log.inputTokens + log.outputTokens, 0)}
                    </td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">
                      {log.durationMs}ms
                    </td>
                    <td className="py-2 px-2 first:pl-0 last:pr-0 text-right text-gray-600 dark:text-gray-300">
                      {renderLogCost(log)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {usage.totalRequests === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('noUsage')}
        </p>
      )}
    </div>
  );
}
