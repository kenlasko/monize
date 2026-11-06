'use client';

import { useMemo } from 'react';
import { chartSeriesColorAsidePrimary } from '@/lib/chart-colors';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import {
  buildForecast,
  buildMultiAccountForecast,
  getForecastSummary,
  ForecastPeriod,
  ForecastDataPoint,
  ForecastAccountSeries,
  FutureTransaction,
} from '@/lib/forecast';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';

/** One account line, as the chart and its tooltip need it. */
export interface CashFlowForecastAccountLine {
  accountId: string;
  name: string;
  color: string;
}

/**
 * A point on screen. `balances` is present only in multi-account mode, where
 * `balance` is the total of those per-account figures.
 */
export type CashFlowForecastPoint = ForecastDataPoint & { balances?: Record<string, number> };

/** Every forecast period, in the order the period switchers offer them. */
export const FORECAST_PERIODS: ForecastPeriod[] = ['week', 'month', '90days', '6months', 'year'];

/** Narrow a stored value to a forecast period, or `null` when it is not one. */
export function asForecastPeriod(value: unknown): ForecastPeriod | null {
  return FORECAST_PERIODS.includes(value as ForecastPeriod) ? (value as ForecastPeriod) : null;
}

/**
 * The accounts a forecast can be drawn for: open, and neither an asset nor a
 * brokerage account (neither moves on a scheduled cash flow).
 */
export function forecastAccountOptions(accounts: Account[]): { value: string; label: string }[] {
  return buildAccountDropdownOptions(
    accounts,
    a => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE',
    a => a.name,
    // The favourites/rest separator is a disabled row a `<select>` can render
    // and a checkbox list cannot, so drop it here rather than offering a
    // selectable rule.
  )
    .filter(option => !option.disabled)
    .map(option => ({ value: option.value, label: option.label }));
}

interface UseCashFlowForecastArgs {
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  futureTransactions: FutureTransaction[];
  period: ForecastPeriod;
  /** The selected account ids; empty means every account, as one line. */
  accountIds: string[];
}

export interface CashFlowForecast {
  accountOptions: { value: string; label: string }[];
  /** The selection in picker order, restricted to accounts still on offer. */
  orderedAccountIds: string[];
  isMultiAccount: boolean;
  /** The currency every figure is in. */
  chartCurrency: string;
  points: CashFlowForecastPoint[];
  accountLines: CashFlowForecastAccountLine[];
  /** Currencies with no rate into `chartCurrency`; non-empty means no forecast. */
  missingCurrencies: string[];
  summary: ReturnType<typeof getForecastSummary>;
  totalForecastedTransactions: number;
}

/**
 * The cash flow forecast for a period and an account selection. Shared by the
 * Bills & Deposits chart and the dashboard widget, so the two surfaces build
 * the same projection from the same inputs and cannot disagree about it.
 */
export function useCashFlowForecast({
  accounts,
  scheduledTransactions,
  futureTransactions,
  period,
  accountIds,
}: UseCashFlowForecastArgs): CashFlowForecast {
  const { convertToDefault, defaultCurrency } = useExchangeRates();

  const accountOptions = useMemo(() => forecastAccountOptions(accounts), [accounts]);

  /**
   * The selection, in the picker's own order (favourites first, then
   * alphabetical) and restricted to accounts still on offer. That order is what
   * the legend reads and what colours are assigned from, so toggling a checkbox
   * cannot recolour the lines already drawn.
   */
  const orderedAccountIds = useMemo(() => {
    const selected = new Set(accountIds);
    return accountOptions.map(o => o.value).filter(id => selected.has(id));
  }, [accountOptions, accountIds]);

  const isMultiAccount = orderedAccountIds.length > 1;

  // Determine display currency from selected accounts
  const { chartCurrency, needsConversion } = useMemo(() => {
    const selected = new Set(orderedAccountIds);
    const targetAccounts = selected.size === 0
      ? accounts.filter(a => !a.isClosed)
      : accounts.filter(a => selected.has(a.id));
    const currencies = new Set(targetAccounts.map(a => a.currencyCode));
    return {
      chartCurrency: currencies.size === 1 ? [...currencies][0] : defaultCurrency,
      needsConversion: currencies.size > 1,
    };
  }, [accounts, orderedAccountIds, defaultCurrency]);

  const forecast = useMemo<{
    points: CashFlowForecastPoint[];
    series: ForecastAccountSeries[];
    missingCurrencies: string[];
  }>(() => {
    const convert = needsConversion ? convertToDefault : undefined;
    if (isMultiAccount) {
      return buildMultiAccountForecast(
        accounts, scheduledTransactions, period, orderedAccountIds, futureTransactions,
        convert,
      );
    }
    // One account (or none, meaning all of them) is a single line, and that
    // line already is the total -- so it keeps the filled-area presentation
    // unchanged.
    const single = buildForecast(
      accounts, scheduledTransactions, period, orderedAccountIds[0] ?? 'all',
      futureTransactions, convert,
    );
    return { points: single.points as CashFlowForecastPoint[], series: [], missingCurrencies: single.missingCurrencies };
  }, [accounts, scheduledTransactions, period, orderedAccountIds, isMultiAccount, futureTransactions, needsConversion, convertToDefault]);

  const accountLines: CashFlowForecastAccountLine[] = useMemo(
    () => forecast.series.map((s, i) => ({
      accountId: s.accountId,
      name: s.name,
      color: chartSeriesColorAsidePrimary(i),
    })),
    [forecast.series],
  );

  const summary = useMemo(
    () => getForecastSummary(forecast.points, chartCurrency),
    [forecast.points, chartCurrency],
  );

  const totalForecastedTransactions = useMemo(
    () => forecast.points.reduce((sum, dp) => sum + dp.transactions.length, 0),
    [forecast.points],
  );

  return {
    accountOptions,
    orderedAccountIds,
    isMultiAccount,
    chartCurrency,
    points: forecast.points,
    accountLines,
    missingCurrencies: forecast.missingCurrencies,
    summary,
    totalForecastedTransactions,
  };
}
