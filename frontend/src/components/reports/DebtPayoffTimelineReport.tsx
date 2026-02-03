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
  LineChart,
  Line,
  AreaChart,
  Area,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { Account, PaymentFrequency } from '@/types/account';
import { Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface PayoffScheduleItem {
  date: string;
  label: string;
  balance: number;
  principalPaid: number;
  interestPaid: number;
  cumulativePrincipal: number;
  cumulativeInterest: number;
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
        const allAccounts = await accountsApi.getAll();
        const debtAccounts = allAccounts.filter(
          (a) => (a.accountType === 'LOAN' || a.accountType === 'MORTGAGE' || a.accountType === 'LINE_OF_CREDIT') && !a.isClosed
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
        // Fetch transactions from the loan account
        // The linkedTransaction will have splits with principal/interest breakdown
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

  // Build payment timeline from actual transactions
  const payoffSchedule = useMemo((): PayoffScheduleItem[] => {
    if (!selectedAccount || transactions.length === 0) return [];

    const loanAccountId = selectedAccount.id;
    const schedule: PayoffScheduleItem[] = [];

    // Filter for positive transactions (payments to loan)
    const sortedTransactions = [...transactions]
      .filter((t) => t.amount > 0)
      .sort((a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime());

    // Calculate total principal paid to determine original balance if openingBalance is not set
    const totalPrincipalPaid = sortedTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);

    // Use openingBalance if available, otherwise calculate from currentBalance + total principal paid
    const openingBalance = Math.abs(selectedAccount.openingBalance || 0);
    const currentBalance = Math.abs(selectedAccount.currentBalance || 0);
    const calculatedOriginalBalance = currentBalance + totalPrincipalPaid;

    // Use the larger of openingBalance or calculated original balance
    // This handles cases where the account was imported mid-way with 0 opening balance
    let runningBalance = openingBalance > 0 ? openingBalance : calculatedOriginalBalance;

    let cumulativePrincipal = 0;
    let cumulativeInterest = 0;

    // Track which parent transactions we've already counted interest for
    // This prevents double-counting when multiple splits in the same parent go to the loan
    const processedParentIds = new Set<string>();

    for (const transaction of sortedTransactions) {
      const principal = Math.abs(transaction.amount);
      let interest = 0;

      // Look at the linkedTransaction's splits to find the interest portion
      const linkedTx = transaction.linkedTransaction;
      if (linkedTx?.splits && linkedTx.splits.length > 0) {
        // Only count interest once per parent transaction
        if (!processedParentIds.has(linkedTx.id)) {
          processedParentIds.add(linkedTx.id);
          // Find the interest split - any split that is NOT a transfer to this loan
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
      });
    }

    // Sample the data if there are too many points
    if (schedule.length > 60) {
      const sampledSchedule: PayoffScheduleItem[] = [];
      const step = Math.ceil(schedule.length / 60);
      for (let i = 0; i < schedule.length; i += step) {
        sampledSchedule.push(schedule[i]);
      }
      if (sampledSchedule[sampledSchedule.length - 1] !== schedule[schedule.length - 1]) {
        sampledSchedule.push(schedule[schedule.length - 1]);
      }
      return sampledSchedule;
    }

    return schedule;
  }, [selectedAccount, transactions]);

  const summary = useMemo(() => {
    if (payoffSchedule.length === 0 || !selectedAccount) return null;
    const lastItem = payoffSchedule[payoffSchedule.length - 1];
    const originalBalance = Math.abs(selectedAccount.openingBalance);
    const currentBalance = Math.abs(selectedAccount.currentBalance);
    return {
      lastPaymentDate: lastItem.label,
      totalPayments: payoffSchedule.length,
      totalInterest: lastItem.cumulativeInterest,
      totalPrincipalPaid: lastItem.cumulativePrincipal,
      originalBalance,
      currentBalance,
      percentPaid: originalBalance > 0 ? ((originalBalance - currentBalance) / originalBalance) * 100 : 0,
    };
  }, [payoffSchedule, selectedAccount]);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
          {payload.map((entry, index) => (
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            <div className="text-sm text-gray-500 dark:text-gray-400">Interest Paid</div>
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
                      dataKey="balance"
                      stroke="#ef4444"
                      fill="#fecaca"
                      name="Remaining Balance"
                      strokeWidth={2}
                    />
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
                  </BarChart>
                </ResponsiveContainer>
              </div>
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
                {selectedAccount.accountType.replace('_', ' ')}
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
                {summary?.totalPayments || 0}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
