'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
  ReferenceLine,
} from 'recharts';
import { accountsApi } from '@/lib/accounts';
import { Transaction } from '@/types/transaction';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  fetchAllAccountTransactions,
  fetchLoanInterestTransactions,
} from '@/lib/loan-history';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { chartColors } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useTranslations } from 'next-intl';

interface PayoffScheduleItem {
  date: string;
  label: string;
  balance: number;
  historicalBalance?: number;
  projectedBalance?: number;
  principalPaid: number;
  interestPaid: number;
  cumulativePrincipal: number;
  cumulativeInterest: number;
  isProjected: boolean;
}

export function DebtPayoffTimelineReport() {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedAccountIdState, setSelectedAccountId] = useState<string>('');
  const [viewType, setViewType] = useState<'balance' | 'breakdown' | 'distribution'>('balance');

  const {
    data: accountsData,
    isLoading: accountsLoading,
    error: accountsError,
    reload: reloadAccounts,
  } = useReportData(
    () =>
      accountsApi.getAll(true).then((allAccounts) =>
        allAccounts.filter(
          (a) =>
            a.accountType === 'LOAN' ||
            a.accountType === 'MORTGAGE' ||
            a.accountType === 'LINE_OF_CREDIT',
        ),
      ),
    [],
  );

  const accounts = useMemo(() => accountsData ?? [], [accountsData]);

  // Auto-select the first debt account until the user picks one. Derived during
  // render rather than via setState-in-effect.
  const selectedAccountId = selectedAccountIdState || accounts[0]?.id || '';
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load transactions from the loan account, paginating through all pages
  // (API limit is 200 per page).
  const {
    data: transactionsData,
    isLoading: transactionsLoading,
    error: transactionsError,
    reload: reloadTransactions,
  } = useReportData(
    async () => {
      if (!selectedAccountId) return [] as Transaction[];
      return fetchAllAccountTransactions(selectedAccountId);
    },
    [selectedAccountId],
  );

  const transactions = useMemo<Transaction[]>(() => transactionsData ?? [], [transactionsData]);

  // The loan's separately-booked interest expenses, so derived interest matches
  // the loan detail page (see #893). Folded into the combined isLoading/error/
  // reload below like the other loaders, so the schedule never paints with the
  // analytic interest estimate and then snaps to the booked interest.
  const {
    data: interestData,
    isLoading: interestLoading,
    error: interestError,
    reload: reloadInterest,
  } = useReportData(
    async () => {
      const account = accounts.find((a) => a.id === selectedAccountId);
      if (!account) return [] as Transaction[];
      return fetchLoanInterestTransactions(account);
    },
    [selectedAccountId, accounts],
  );
  const interestTransactions = useMemo<Transaction[]>(() => interestData ?? [], [interestData]);

  const isLoading = accountsLoading || transactionsLoading || interestLoading;
  const error = accountsError || transactionsError || interestError;
  const reload = () => {
    reloadAccounts();
    reloadTransactions();
    reloadInterest();
  };

  // Build payment timeline from actual transactions + projected future payments
  const { payoffSchedule, projectionStartLabel } = useMemo((): {
    payoffSchedule: PayoffScheduleItem[];
    projectionStartLabel: string | null;
  } => {
    if (!selectedAccount) return { payoffSchedule: [], projectionStartLabel: null };

    // --- Historical payments from actual transactions ---
    const history = deriveLoanPaymentHistory(selectedAccount, transactions, [], interestTransactions);
    const schedule: PayoffScheduleItem[] = history.events.map((event) => ({
      date: event.date,
      label: formatChartDate(event.date, 'MMM yyyy'),
      balance: event.balance,
      principalPaid: event.principal,
      interestPaid: event.interest,
      cumulativePrincipal: event.cumulativePrincipal,
      cumulativeInterest: event.cumulativeInterest,
      isProjected: false,
    }));

    // --- Project future payments ---
    const projectionInput = buildLoanProjectionInput(selectedAccount, history);
    if (projectionInput) {
      const projection = generateLoanSchedule({
        ...projectionInput,
        initialCumulativePrincipal: history.cumulativePrincipal,
        initialCumulativeInterest: history.cumulativeInterest,
      });

      for (const row of projection.rows) {
        schedule.push({
          date: row.date,
          label: formatChartDate(row.date, 'MMM yyyy'),
          balance: row.balance,
          principalPaid: row.principal,
          interestPaid: row.interest,
          cumulativePrincipal: row.cumulativePrincipal,
          cumulativeInterest: row.cumulativeInterest,
          isProjected: true,
        });
      }
    }

    // --- Aggregate by month ---
    const monthMap = new Map<string, PayoffScheduleItem>();
    for (const item of schedule) {
      const key = item.label;
      const existing = monthMap.get(key);
      if (existing) {
        existing.principalPaid += item.principalPaid;
        existing.interestPaid += item.interestPaid;
        existing.balance = item.balance;
        existing.cumulativePrincipal = item.cumulativePrincipal;
        existing.cumulativeInterest = item.cumulativeInterest;
        // A month is projected only if all its entries are projected
        if (!item.isProjected) existing.isProjected = false;
      } else {
        monthMap.set(key, { ...item });
      }
    }
    let monthlySchedule = Array.from(monthMap.values());

    // --- Sample if too many data points ---
    if (monthlySchedule.length > 60) {
      const sampledSchedule: PayoffScheduleItem[] = [];
      const step = Math.ceil(monthlySchedule.length / 60);
      for (let i = 0; i < monthlySchedule.length; i += step) {
        sampledSchedule.push(monthlySchedule[i]);
      }
      if (sampledSchedule[sampledSchedule.length - 1] !== monthlySchedule[monthlySchedule.length - 1]) {
        sampledSchedule.push(monthlySchedule[monthlySchedule.length - 1]);
      }
      monthlySchedule = sampledSchedule;
    }

    // --- Post-process: set historicalBalance / projectedBalance for chart ---
    const firstProjectedIdx = monthlySchedule.findIndex((item) => item.isProjected);
    let startLabel: string | null = null;

    for (let i = 0; i < monthlySchedule.length; i++) {
      const item = monthlySchedule[i];
      if (!item.isProjected) {
        item.historicalBalance = item.balance;
      }
      if (item.isProjected) {
        item.projectedBalance = item.balance;
      }
    }

    // Connect the two areas at the transition point
    if (firstProjectedIdx > 0) {
      // Last historical point also gets projectedBalance to connect the areas
      monthlySchedule[firstProjectedIdx - 1].projectedBalance = monthlySchedule[firstProjectedIdx - 1].balance;
      startLabel = monthlySchedule[firstProjectedIdx].label;
    } else if (firstProjectedIdx === 0 && monthlySchedule.length > 0) {
      startLabel = monthlySchedule[0].label;
    }

    return { payoffSchedule: monthlySchedule, projectionStartLabel: startLabel };
  }, [selectedAccount, transactions, interestTransactions, formatChartDate]);

  const summary = useMemo(() => {
    if (payoffSchedule.length === 0 || !selectedAccount) return null;
    const lastItem = payoffSchedule[payoffSchedule.length - 1];
    const currentBalance = Math.abs(selectedAccount.currentBalance);
    const totalPrincipalPaid = lastItem.cumulativePrincipal;
    // Use openingBalance if set, otherwise derive from principal paid + remaining balance
    const originalBalance = Math.abs(selectedAccount.openingBalance) || (totalPrincipalPaid + currentBalance);
    const hasProjection = payoffSchedule.some((item) => item.isProjected);
    const projectedPayoffDate = hasProjection ? lastItem.label : null;
    const projectedTotalInterest = hasProjection ? lastItem.cumulativeInterest : null;
    return {
      lastPaymentDate: lastItem.label,
      totalPayments: payoffSchedule.length,
      totalInterest: lastItem.cumulativeInterest,
      totalPrincipalPaid,
      originalBalance,
      currentBalance,
      percentPaid: originalBalance > 0 ? ((originalBalance - currentBalance) / originalBalance) * 100 : 0,
      hasProjection,
      projectedPayoffDate,
      projectedTotalInterest,
    };
  }, [payoffSchedule, selectedAccount]);

  const distributionData = useMemo(() => {
    return payoffSchedule
      .filter((item) => {
        const total = item.principalPaid + item.interestPaid;
        return total > 0;
      })
      .map((item) => {
        const total = item.principalPaid + item.interestPaid;
        return {
          label: item.label,
          principalPercent: (item.principalPaid / total) * 100,
          interestPercent: (item.interestPaid / total) * 100,
          principalPaid: item.principalPaid,
          interestPaid: item.interestPaid,
          isProjected: item.isProjected,
        };
      });
  }, [payoffSchedule]);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      // Check if this point is projected
      const chartData = payoffSchedule.find((item) => item.label === label);
      const isProjected = chartData?.isProjected ?? false;
      // Deduplicate entries that overlap at the transition point
      const seen = new Set<string>();
      const deduped = payload.filter((entry) => {
        if (entry.value === undefined || entry.value === null) return false;
        const key = entry.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            {label} {isProjected && <span className="text-xs text-blue-500 dark:text-blue-400">{t('debtPayoff.projected')}</span>}
          </p>
          {deduped.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = [t('debtPayoff.colAccountType'), t('debtPayoff.colAccountType'), t('debtPayoff.currentBalance'), t('debtPayoff.colInterestRate'), t('debtPayoff.colPaymentsMade')];
    const rows = selectedAccount ? [[
      selectedAccount.name,
      selectedAccount.accountType === 'LINE_OF_CREDIT'
        ? t('accountBalances.accountTypes.LINE_OF_CREDIT' as Parameters<typeof t>[0])
        : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase(),
      formatCurrency(Math.abs(selectedAccount.currentBalance)),
      selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : t('debtPayoff.notSet'),
      selectedAccount.paymentAmount ? formatCurrency(selectedAccount.paymentAmount) : t('debtPayoff.notSet'),
    ]] : [];
    await exportToPdf({
      title: t('page.names.debt-payoff-timeline' as Parameters<typeof t>[0]),
      summaryCards: summary ? [
        { label: t('debtPayoff.currentBalance'), value: formatCurrency(summary.currentBalance), color: '#dc2626' },
        { label: t('debtPayoff.principalPaid'), value: formatCurrency(summary.totalPrincipalPaid), color: '#16a34a' },
        { label: summary.hasProjection ? t('debtPayoff.estTotalInterest') : t('debtPayoff.interestPaid'), value: formatCurrency(summary.totalInterest), color: '#ea580c' },
        { label: t('debtPayoff.progress'), value: `${summary.percentPaid.toFixed(1)}%`, color: '#2563eb' },
      ] : undefined,
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'debt-payoff-timeline',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('debtPayoff.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('debtPayoff.labelSelectAccount')}
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 min-w-[200px]"
            >
              {accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={() => setViewType('balance')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'balance'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('debtPayoff.balanceOverTime')}
            </button>
            <button
              onClick={() => setViewType('breakdown')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'breakdown'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('debtPayoff.paymentBreakdown')}
            </button>
            <button
              onClick={() => setViewType('distribution')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'distribution'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('debtPayoff.viewPrincipalVsInterest')}
            </button>
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className={`grid grid-cols-2 ${summary.hasProjection ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-4`}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.currentBalance')}</div>
            <div className="text-xl font-bold text-red-600 dark:text-red-400">
              {formatCurrency(summary.currentBalance)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.principalPaid')}</div>
            <div className="text-xl font-bold text-green-600 dark:text-green-400">
              {formatCurrency(summary.totalPrincipalPaid)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.hasProjection ? t('debtPayoff.estTotalInterest') : t('debtPayoff.interestPaid')}
            </div>
            <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary.totalInterest)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.progress')}</div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
              {summary.percentPaid.toFixed(1)}%
            </div>
          </div>
          {summary.hasProjection && summary.projectedPayoffDate && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.estPayoff')}</div>
              <div className="text-xl font-bold text-purple-600 dark:text-purple-400">
                {summary.projectedPayoffDate}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {payoffSchedule.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('debtPayoff.noPaymentHistory')}
          </p>
        ) : (
          <>
            {viewType === 'balance' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart data={payoffSchedule}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={formatCurrencyAxis}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="historicalBalance"
                      stroke={chartColors.expense}
                      fill={chartColors.expense}
                      fillOpacity={0.3}
                      name={t('debtPayoff.seriesRemainingBalance')}
                      strokeWidth={2}
                      connectNulls={false}
                    />
                    {projectionStartLabel && (
                      <Area
                        type="monotone"
                        dataKey="projectedBalance"
                        stroke={chartColors.primary}
                        fill={chartColors.primary}
                        name={t('debtPayoff.seriesProjectedBalance')}
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        fillOpacity={0.15}
                        connectNulls={false}
                      />
                    )}
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            {viewType === 'breakdown' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={payoffSchedule}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={formatCurrencyAxis}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar
                      dataKey="cumulativePrincipal"
                      stackId="a"
                      fill={chartColors.income}
                      name={t('debtPayoff.seriesPrincipalPaid')}
                    />
                    <Bar
                      dataKey="cumulativeInterest"
                      stackId="a"
                      fill={chartColors.warning}
                      name={t('debtPayoff.seriesInterestPaid')}
                    />
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {viewType === 'distribution' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={distributionData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(value: number) => `${value}%`}
                      tick={{ fontSize: 12 }}
                      domain={[0, 100]}
                    />
                    <Tooltip
                      content={({ active, payload, label: tooltipLabel }) => {
                        if (active && payload && payload.length) {
                          const data = distributionData.find((d) => d.label === tooltipLabel);
                          return (
                            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                              <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                                {tooltipLabel}{' '}
                                {data?.isProjected && (
                                  <span className="text-xs text-blue-500 dark:text-blue-400">{t('debtPayoff.projected')}</span>
                                )}
                              </p>
                              <p className="text-sm text-green-600 dark:text-green-400">
                                {t('debtPayoff.seriesPrincipal')}: {data?.principalPercent.toFixed(1)}% ({formatCurrency(data?.principalPaid ?? 0)})
                              </p>
                              <p className="text-sm text-orange-500 dark:text-orange-400">
                                {t('debtPayoff.seriesInterest')}: {data?.interestPercent.toFixed(1)}% ({formatCurrency(data?.interestPaid ?? 0)})
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="principalPercent"
                      stackId="a"
                      fill={chartColors.income}
                      name={t('debtPayoff.seriesPrincipal')}
                    />
                    <Bar
                      dataKey="interestPercent"
                      stackId="a"
                      fill={chartColors.warning}
                      name={t('debtPayoff.seriesInterest')}
                    />
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {projectionStartLabel && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                {t('debtPayoff.projectionNote')}
              </p>
            )}
          </>
        )}
      </div>

      {/* Account Details */}
      {selectedAccount && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('debtPayoff.accountDetails')}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colAccountType')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.accountType === 'LINE_OF_CREDIT'
                    ? t('accountBalances.accountTypes.LINE_OF_CREDIT' as Parameters<typeof t>[0])
                    : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase()}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colOriginalAmount')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(Math.abs(selectedAccount.openingBalance))}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colInterestRate')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : t('debtPayoff.notSet')}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colPaymentsMade')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {payoffSchedule.filter((p) => !p.isProjected).length}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
