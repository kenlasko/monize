'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  AiUsageSummary,
  AiProviderConfig,
  AiProviderType,
  EstimatedCostByCurrency,
} from '@/types/ai';
import { AI_PROVIDER_LABELS } from '@/types/ai';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useDateFormat } from '@/hooks/useDateFormat';

interface UsageDashboardProps {
  usage: AiUsageSummary;
  configs: AiProviderConfig[];
  onPeriodChange: (days?: number) => void;
}

const PERIOD_OPTIONS = [
  { labelKey: 'periods.d7', value: 7 },
  { labelKey: 'periods.d30', value: 30 },
  { labelKey: 'periods.d90', value: 90 },
  { labelKey: 'periods.all', value: undefined },
];

function currencyFormatter(currency: string): Intl.NumberFormat {
  // Guard against any invalid currency code; fall back to USD so formatting
  // never throws for users with exotic codes.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  } catch {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }
}

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
  const [selectedPeriod, setSelectedPeriod] = useState<number | undefined>(30);
  const [showInHomeCurrency, setShowInHomeCurrency] = useState(true);
  const { convert } = useExchangeRates();
  const homeCurrency =
    usePreferencesStore((state) => state.preferences?.defaultCurrency) || 'USD';
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

  // Format a bucket either as a single converted home-currency amount or as
  // one line per provider currency.
  const renderBucket = (bucket: EstimatedCostByCurrency): string => {
    if (!hasAnyCost(bucket)) return '-';
    if (showInHomeCurrency || !hasForeignCurrency) {
      // A bucket that cannot be fully converted is reported as unavailable
      // rather than as the sum of the currencies that happened to have rates.
      let total = 0;
      for (const [currency, amount] of Object.entries(bucket)) {
        const converted = convert(amount, currency, homeCurrency);
        if (converted === null) return '-';
        total += converted;
      }
      return currencyFormatter(homeCurrency).format(total);
    }
    return Object.entries(bucket)
      .filter(([, amount]) => amount > 0)
      .map(([currency, amount]) => currencyFormatter(currency).format(amount))
      .join(' + ');
  };

  const renderLogCost = (
    cost: number | null,
    costCurrency: string | null,
  ): string => {
    if (cost === null || !costCurrency) return '-';
    if (showInHomeCurrency) {
      const converted = convert(cost, costCurrency, homeCurrency);
      if (converted === null) return '-';
      return currencyFormatter(homeCurrency).format(converted);
    }
    return currencyFormatter(costCurrency).format(cost);
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
            {usage.totalRequests.toLocaleString()}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('inputTokens')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {usage.totalInputTokens.toLocaleString()}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('outputTokens')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {usage.totalOutputTokens.toLocaleString()}
          </p>
        </div>
        <div
          className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4"
          title={t('estCostTooltip')}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('estCost')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {totalHasCost ? renderBucket(usage.totalEstimatedCostByCurrency) : '-'}
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
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 font-medium">{t('byProvider.provider')}</th>
                  <th className="pb-2 font-medium text-right">{t('byProvider.requests')}</th>
                  <th className="pb-2 font-medium text-right">{t('byProvider.inputTokens')}</th>
                  <th className="pb-2 font-medium text-right">{t('byProvider.outputTokens')}</th>
                  <th className="pb-2 font-medium text-right">{t('byProvider.estCost')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.byProvider.map((row) => (
                  <tr key={row.provider} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 text-gray-900 dark:text-gray-100">{resolveProviderName(row.provider, configs)}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.requests.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.inputTokens.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.outputTokens.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{renderBucket(row.estimatedCostByCurrency)}</td>
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
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 font-medium">{t('recentActivity.date')}</th>
                  <th className="pb-2 font-medium">{t('recentActivity.provider')}</th>
                  <th className="pb-2 font-medium">{t('recentActivity.feature')}</th>
                  <th className="pb-2 font-medium text-right">{t('recentActivity.tokens')}</th>
                  <th className="pb-2 font-medium text-right">{t('recentActivity.duration')}</th>
                  <th className="pb-2 font-medium text-right">{t('recentActivity.estCost')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.recentLogs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 text-gray-600 dark:text-gray-300">
                      {formatDate(new Date(log.createdAt))}
                    </td>
                    <td className="py-2 text-gray-900 dark:text-gray-100">{resolveLogName(log.provider, log.model, configs)}</td>
                    <td className="py-2 text-gray-600 dark:text-gray-300">{log.feature}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">
                      {(log.inputTokens + log.outputTokens).toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">
                      {log.durationMs}ms
                    </td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">
                      {renderLogCost(log.estimatedCost, log.costCurrency)}
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
