'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ForecastPeriod, FutureTransaction, FORECAST_PERIOD_LABELS } from '@/lib/forecast';
import { useCashFlowForecast, FORECAST_PERIODS, asForecastPeriod } from './useCashFlowForecast';
import { CashFlowForecastPlot } from './CashFlowForecastPlot';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { ChartCollapseButton, CollapsedChartStrip } from '@/components/transactions/ChartCollapseControls';

interface CashFlowForecastChartProps {
  scheduledTransactions: ScheduledTransaction[];
  accounts: Account[];
  futureTransactions?: FutureTransaction[];
  isLoading: boolean;
}

const STORAGE_KEY_PERIOD = 'cashFlowForecast.period';
const STORAGE_KEY_ACCOUNTS = 'cashFlowForecast.accountIds';
/** Pre-multi-select key, holding a single account id or the string 'all'. */
const STORAGE_KEY_ACCOUNT_LEGACY = 'cashFlowForecast.accountId';
/** Whether this browser has folded the chart away; absent means open. */
const STORAGE_KEY_COLLAPSED = 'cashFlowForecast.collapsed';

function getStoredPeriod(): ForecastPeriod {
  if (typeof window === 'undefined') return 'month';
  return asForecastPeriod(localStorage.getItem(STORAGE_KEY_PERIOD)) ?? 'month';
}

/**
 * The stored selection. An empty array means "all accounts", so a user who
 * never picked one -- and one upgrading from the single-account selector with
 * 'all' stored -- lands on the same view they had.
 */
function getStoredAccountIds(): string[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      // Unparseable: fall through to the legacy key rather than throwing during
      // the first render.
    }
  }
  const legacy = localStorage.getItem(STORAGE_KEY_ACCOUNT_LEGACY);
  return legacy && legacy !== 'all' ? [legacy] : [];
}

/** A stable empty list, so a caller passing none does not rebuild the forecast. */
const NO_FUTURE_TRANSACTIONS: FutureTransaction[] = [];

export function CashFlowForecastChart({
  scheduledTransactions,
  accounts,
  futureTransactions = NO_FUTURE_TRANSACTIONS,
  isLoading,
}: CashFlowForecastChartProps) {
  const t = useTranslations('bills');
  const [selectedPeriod, setSelectedPeriod] = useState<ForecastPeriod>(() => getStoredPeriod());
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(() =>
    getStoredAccountIds(),
  );
  const [storedCollapsed, setCollapsed] = useLocalStorage<unknown>(STORAGE_KEY_COLLAPSED, false);
  // A hand-edited entry that is not a boolean reads as open rather than as a
  // truthy string folding the chart.
  const collapsed = storedCollapsed === true;
  const collapse = useCallback(() => setCollapsed(true), [setCollapsed]);
  const expand = useCallback(() => setCollapsed(false), [setCollapsed]);

  // Persist period changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PERIOD, selectedPeriod);
  }, [selectedPeriod]);

  // Persist account changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(selectedAccountIds));
  }, [selectedAccountIds]);

  const forecast = useCashFlowForecast({
    accounts,
    scheduledTransactions,
    futureTransactions,
    period: selectedPeriod,
    accountIds: selectedAccountIds,
  });
  const { accountOptions, orderedAccountIds, totalForecastedTransactions } = forecast;

  if (collapsed) {
    return <CollapsedChartStrip onExpand={expand} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('forecast.title')}
          </h3>
          <ChartCollapseButton onCollapse={collapse} />
        </div>
        <div className="h-72 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (forecast.missingCurrencies.length > 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('forecast.title')}
          </h3>
          <ChartCollapseButton onCollapse={collapse} />
        </div>
        <CashFlowForecastPlot
          forecast={forecast}
          accounts={accounts}
          scheduledTransactions={scheduledTransactions}
        />
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
      {/* Header with controls; the fold button stays top-right at every width */}
      <div className="flex items-start sm:items-center justify-between gap-2 mb-4">
        <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('forecast.title')}
            </h3>
            {totalForecastedTransactions > 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('forecast.scheduledCount', { count: totalForecastedTransactions })}
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {/* Period selector */}
            <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              {FORECAST_PERIODS.map((period) => (
                <button
                  key={period}
                  onClick={() => setSelectedPeriod(period)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    selectedPeriod === period
                      ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  {FORECAST_PERIOD_LABELS[period]}
                </button>
              ))}
            </div>
            {/* Account selector: no selection means every account, as one line */}
            <div className="w-48">
              <MultiSelect
                ariaLabel={t('forecast.accountsAriaLabel')}
                placeholder={t('forecast.allAccounts')}
                options={accountOptions}
                value={orderedAccountIds}
                onChange={setSelectedAccountIds}
              />
            </div>
          </div>
        </div>
        <ChartCollapseButton onCollapse={collapse} />
      </div>

      <CashFlowForecastPlot
        forecast={forecast}
        accounts={accounts}
        scheduledTransactions={scheduledTransactions}
      />
    </div>
  );
}
