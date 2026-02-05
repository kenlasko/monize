'use client';

import { useState, useEffect, useMemo } from 'react';
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
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';

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
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'balance' | 'breakdown'>('balance');

  useEffect(() => {
    const loadAccounts = async () => {
      setIsLoading(true);
      try {
        const allAccounts = await accountsApi.getAll(true);
        const debtAccounts = allAccounts.filter(
          (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE' || a.accountType === 'LINE_OF_CREDIT'
        );
        setAccounts(debtAccounts);
        if (debtAccounts.length > 0) {
          setSelectedAccountId(debtAccounts[0].id);
        }
      } catch (error) {
        console.error('Failed to load accounts:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadAccounts();
  }, []);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load transactions from the loan account
  useEffect(() => {
    const loadTransactions = async () => {
      if (!selectedAccountId) {
        setTransactions([]);
        return;
      }

      try {
        const result = await transactionsApi.getAll({
          accountId: selectedAccountId,
          limit: 1000,
        });
        setTransactions(result.data);
      } catch (error) {
        console.error('Failed to load transactions:', error);
        setTransactions([]);
      }
    };

    loadTransactions();
  }, [selectedAccountId]);

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

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
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
          <div className="flex gap-2">
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {payoffSchedule.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No payment history found. Make payments to your debt account to see the timeline.
          </p>
        ) : (
          <>
            {viewType === 'balance' ? (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={payoffSchedule}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(value) => `$${Math.round(value / 1000)}k`}
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
            ) : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={payoffSchedule}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(value) => `$${Math.round(value / 1000)}k`}
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
