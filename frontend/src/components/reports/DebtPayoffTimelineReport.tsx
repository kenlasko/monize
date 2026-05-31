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
import { format, parseISO } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';

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

// --- Projection helper functions ---

function getPeriodsPerYear(frequency: string): number {
  switch (frequency) {
    case 'WEEKLY':
    case 'ACCELERATED_WEEKLY':
      return 52;
    case 'BIWEEKLY':
    case 'ACCELERATED_BIWEEKLY':
      return 26;
    case 'SEMI_MONTHLY':
      return 24;
    case 'MONTHLY':
      return 12;
    case 'QUARTERLY':
      return 4;
    case 'YEARLY':
      return 1;
    default:
      return 12;
  }
}

function getPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
  isCanadianMortgage: boolean,
  isVariableRate: boolean,
): number {
  if (annualRate === 0) return 0;
  if (isCanadianMortgage && !isVariableRate) {
    // Canadian fixed-rate: semi-annual compounding
    const semiAnnualRate = annualRate / 100 / 2;
    return Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
  }
  return annualRate / 100 / periodsPerYear;
}

function advanceDate(date: Date, frequency: string): Date {
  const next = new Date(date);
  switch (frequency) {
    case 'WEEKLY':
    case 'ACCELERATED_WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
    case 'ACCELERATED_BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'SEMI_MONTHLY':
      if (next.getDate() < 15) {
        next.setDate(15);
      } else {
        next.setMonth(next.getMonth() + 1);
        next.setDate(1);
      }
      break;
    case 'QUARTERLY':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1);
      break;
    case 'MONTHLY':
    default:
      next.setMonth(next.getMonth() + 1);
      break;
  }
  return next;
}

export function DebtPayoffTimelineReport() {
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
      let allTransactions: Transaction[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const result = await transactionsApi.getAll({
          accountId: selectedAccountId,
          limit: 200,
          page,
        });
        allTransactions = allTransactions.concat(result.data);
        hasMore = result.pagination.hasMore;
        page++;
      }
      return allTransactions;
    },
    [selectedAccountId],
  );

  const transactions = useMemo<Transaction[]>(() => transactionsData ?? [], [transactionsData]);
  const isLoading = accountsLoading || transactionsLoading;
  const error = accountsError || transactionsError;
  const reload = () => {
    reloadAccounts();
    reloadTransactions();
  };

  // Build payment timeline from actual transactions + projected future payments
  const { payoffSchedule, projectionStartLabel } = useMemo((): {
    payoffSchedule: PayoffScheduleItem[];
    projectionStartLabel: string | null;
  } => {
    if (!selectedAccount) return { payoffSchedule: [], projectionStartLabel: null };

    const loanAccountId = selectedAccount.id;
    const schedule: PayoffScheduleItem[] = [];

    // --- Historical payments from actual transactions ---
    const sortedTransactions = [...transactions]
      .filter((t) => t.amount > 0)
      .sort((a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime());

    const totalPrincipalPaid = sortedTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const openingBalance = Math.abs(selectedAccount.openingBalance || 0);
    const currentBalance = Math.abs(selectedAccount.currentBalance || 0);
    const calculatedOriginalBalance = currentBalance + totalPrincipalPaid;

    let runningBalance = openingBalance > 0 ? openingBalance : calculatedOriginalBalance;

    let cumulativePrincipal = 0;
    let cumulativeInterest = 0;

    const processedParentIds = new Set<string>();

    for (const transaction of sortedTransactions) {
      const principal = Math.abs(transaction.amount);
      let interest = 0;

      const linkedTx = transaction.linkedTransaction;
      if (linkedTx?.splits && linkedTx.splits.length > 0) {
        if (!processedParentIds.has(linkedTx.id)) {
          processedParentIds.add(linkedTx.id);
          const interestSplit = linkedTx.splits.find(
            (s) => s.transferAccountId !== loanAccountId
          );
          if (interestSplit) {
            interest = Math.abs(interestSplit.amount);
          }
        }
      }

      runningBalance = Math.max(0, runningBalance - principal);
      cumulativePrincipal += principal;
      cumulativeInterest += interest;

      schedule.push({
        date: transaction.transactionDate,
        label: format(parseISO(transaction.transactionDate), 'MMM yyyy'),
        balance: runningBalance,
        principalPaid: principal,
        interestPaid: interest,
        cumulativePrincipal,
        cumulativeInterest,
        isProjected: false,
      });
    }

    // --- Project future payments ---
    const projBalance = currentBalance;
    const canProject =
      projBalance > 0.01 &&
      selectedAccount.interestRate != null &&
      selectedAccount.paymentAmount &&
      selectedAccount.paymentAmount > 0 &&
      selectedAccount.paymentFrequency;

    if (canProject) {
      const frequency = selectedAccount.paymentFrequency as string;
      const periodsPerYear = getPeriodsPerYear(frequency);
      const periodicRate = getPeriodicRate(
        selectedAccount.interestRate!,
        periodsPerYear,
        selectedAccount.isCanadianMortgage || false,
        selectedAccount.isVariableRate || false,
      );
      const paymentAmount = selectedAccount.paymentAmount!;

      let projRunningBalance = projBalance;
      let projCumulativePrincipal = cumulativePrincipal;
      let projCumulativeInterest = cumulativeInterest;
      let projDate = new Date();

      const MAX_PROJECTED_PAYMENTS = 600;
      let paymentCount = 0;

      while (projRunningBalance > 0.01 && paymentCount < MAX_PROJECTED_PAYMENTS) {
        projDate = advanceDate(projDate, frequency);
        const interestCharge = projRunningBalance * periodicRate;
        let principalPortion = paymentAmount - interestCharge;

        if (principalPortion <= 0) break; // Payment doesn't cover interest

        // Cap principal to remaining balance (final payment)
        if (principalPortion > projRunningBalance) {
          principalPortion = projRunningBalance;
        }

        projRunningBalance = Math.max(0, projRunningBalance - principalPortion);
        projCumulativePrincipal += principalPortion;
        projCumulativeInterest += interestCharge;

        schedule.push({
          date: format(projDate, 'yyyy-MM-dd'),
          label: format(projDate, 'MMM yyyy'),
          balance: Math.round(projRunningBalance * 100) / 100,
          principalPaid: Math.round(principalPortion * 100) / 100,
          interestPaid: Math.round(interestCharge * 100) / 100,
          cumulativePrincipal: Math.round(projCumulativePrincipal * 100) / 100,
          cumulativeInterest: Math.round(projCumulativeInterest * 100) / 100,
          isProjected: true,
        });

        paymentCount++;
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
  }, [selectedAccount, transactions]);

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
            {label} {isProjected && <span className="text-xs text-blue-500 dark:text-blue-400">(Projected)</span>}
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
    const headers = ['Account', 'Type', 'Current Balance', 'Interest Rate', 'Payment Amount'];
    const rows = selectedAccount ? [[
      selectedAccount.name,
      selectedAccount.accountType === 'LINE_OF_CREDIT'
        ? 'Line of Credit'
        : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase(),
      formatCurrency(Math.abs(selectedAccount.currentBalance)),
      selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : 'Not set',
      selectedAccount.paymentAmount ? formatCurrency(selectedAccount.paymentAmount) : 'Not set',
    ]] : [];
    await exportToPdf({
      title: 'Debt Payoff Timeline',
      summaryCards: summary ? [
        { label: 'Current Balance', value: formatCurrency(summary.currentBalance), color: '#dc2626' },
        { label: 'Principal Paid', value: formatCurrency(summary.totalPrincipalPaid), color: '#16a34a' },
        { label: summary.hasProjection ? 'Est. Total Interest' : 'Interest Paid', value: formatCurrency(summary.totalInterest), color: '#ea580c' },
        { label: 'Progress', value: `${summary.percentPaid.toFixed(1)}%`, color: '#2563eb' },
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
          No debt accounts found. Add a loan, mortgage, or line of credit to see the payoff timeline.
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
              Select Account
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
              Balance Over Time
            </button>
            <button
              onClick={() => setViewType('breakdown')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'breakdown'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Payment Breakdown
            </button>
            <button
              onClick={() => setViewType('distribution')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'distribution'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Principal vs Interest
            </button>
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className={`grid grid-cols-2 ${summary.hasProjection ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-4`}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Current Balance</div>
            <div className="text-xl font-bold text-red-600 dark:text-red-400">
              {formatCurrency(summary.currentBalance)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Principal Paid</div>
            <div className="text-xl font-bold text-green-600 dark:text-green-400">
              {formatCurrency(summary.totalPrincipalPaid)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.hasProjection ? 'Est. Total Interest' : 'Interest Paid'}
            </div>
            <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary.totalInterest)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Progress</div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
              {summary.percentPaid.toFixed(1)}%
            </div>
          </div>
          {summary.hasProjection && summary.projectedPayoffDate && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
              <div className="text-sm text-gray-500 dark:text-gray-400">Est. Payoff</div>
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
            No payment history found. Make payments to your debt account to see the timeline.
          </p>
        ) : (
          <>
            {viewType === 'balance' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart data={payoffSchedule}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
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
                      stroke="#ef4444"
                      fill="#fecaca"
                      name="Remaining Balance"
                      strokeWidth={2}
                      connectNulls={false}
                    />
                    {projectionStartLabel && (
                      <Area
                        type="monotone"
                        dataKey="projectedBalance"
                        stroke="#3b82f6"
                        fill="#dbeafe"
                        name="Projected Balance"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        fillOpacity={0.4}
                        connectNulls={false}
                      />
                    )}
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke="#6b7280"
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: 'Today',
                          position: 'top',
                          fill: '#6b7280',
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
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
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
                      fill="#22c55e"
                      name="Principal Paid"
                    />
                    <Bar
                      dataKey="cumulativeInterest"
                      stackId="a"
                      fill="#f97316"
                      name="Interest Paid"
                    />
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke="#6b7280"
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: 'Today',
                          position: 'top',
                          fill: '#6b7280',
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
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
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
                                  <span className="text-xs text-blue-500 dark:text-blue-400">(Projected)</span>
                                )}
                              </p>
                              <p className="text-sm text-green-600 dark:text-green-400">
                                Principal: {data?.principalPercent.toFixed(1)}% ({formatCurrency(data?.principalPaid ?? 0)})
                              </p>
                              <p className="text-sm text-orange-500 dark:text-orange-400">
                                Interest: {data?.interestPercent.toFixed(1)}% ({formatCurrency(data?.interestPaid ?? 0)})
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
                      fill="#22c55e"
                      name="Principal"
                    />
                    <Bar
                      dataKey="interestPercent"
                      stackId="a"
                      fill="#f97316"
                      name="Interest"
                    />
                    {projectionStartLabel && (
                      <ReferenceLine
                        x={projectionStartLabel}
                        stroke="#6b7280"
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: 'Today',
                          position: 'top',
                          fill: '#6b7280',
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
                Dashed line marks today. Values after this point are projected based on current payment settings.
              </p>
            )}
          </>
        )}
      </div>

      {/* Account Details */}
      {selectedAccount && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Account Details
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Account Type</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.accountType === 'LINE_OF_CREDIT'
                    ? 'Line of Credit'
                    : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase()}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Original Amount</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(Math.abs(selectedAccount.openingBalance))}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Interest Rate</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payments Made</span>
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
