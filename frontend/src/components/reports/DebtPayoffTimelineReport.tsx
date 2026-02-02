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
} from 'recharts';
import { format, addMonths, parseISO } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { Account, PaymentFrequency } from '@/types/account';
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

const FREQUENCY_MONTHS: Record<PaymentFrequency, number> = {
  WEEKLY: 1 / 4.33,
  BIWEEKLY: 1 / 2.17,
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

export function DebtPayoffTimelineReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
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

  const payoffSchedule = useMemo((): PayoffScheduleItem[] => {
    if (!selectedAccount) return [];

    const balance = Math.abs(selectedAccount.currentBalance);
    const rate = (selectedAccount.interestRate || 0) / 100;
    const payment = selectedAccount.paymentAmount || 0;
    const frequency = selectedAccount.paymentFrequency || 'MONTHLY';

    if (balance <= 0 || payment <= 0) return [];

    const monthlyRate = rate / 12;
    const paymentMonths = FREQUENCY_MONTHS[frequency];
    const schedule: PayoffScheduleItem[] = [];
    let currentBalance = balance;
    let currentDate = new Date();
    let cumulativePrincipal = 0;
    let cumulativeInterest = 0;
    let iterations = 0;
    const maxIterations = 600; // 50 years max

    while (currentBalance > 0.01 && iterations < maxIterations) {
      const monthsElapsed = paymentMonths;
      const interestAmount = currentBalance * monthlyRate * monthsElapsed;
      const principalAmount = Math.min(payment - interestAmount, currentBalance);

      if (principalAmount <= 0) {
        // Payment doesn't cover interest - debt will never be paid off
        break;
      }

      currentBalance -= principalAmount;
      cumulativePrincipal += principalAmount;
      cumulativeInterest += interestAmount;

      schedule.push({
        date: format(currentDate, 'yyyy-MM-dd'),
        label: format(currentDate, 'MMM yyyy'),
        balance: Math.max(0, currentBalance),
        principalPaid: principalAmount,
        interestPaid: interestAmount,
        cumulativePrincipal,
        cumulativeInterest,
      });

      currentDate = addMonths(currentDate, Math.ceil(paymentMonths));
      iterations++;
    }

    // Sample the data if there are too many points
    if (schedule.length > 60) {
      const sampledSchedule: PayoffScheduleItem[] = [];
      const step = Math.ceil(schedule.length / 60);
      for (let i = 0; i < schedule.length; i += step) {
        sampledSchedule.push(schedule[i]);
      }
      // Always include the last item
      if (sampledSchedule[sampledSchedule.length - 1] !== schedule[schedule.length - 1]) {
        sampledSchedule.push(schedule[schedule.length - 1]);
      }
      return sampledSchedule;
    }

    return schedule;
  }, [selectedAccount]);

  const summary = useMemo(() => {
    if (payoffSchedule.length === 0) return null;
    const lastItem = payoffSchedule[payoffSchedule.length - 1];
    const originalBalance = Math.abs(selectedAccount?.currentBalance || 0);
    return {
      payoffDate: lastItem.label,
      totalPayments: payoffSchedule.length,
      totalInterest: lastItem.cumulativeInterest,
      totalPaid: lastItem.cumulativePrincipal + lastItem.cumulativeInterest,
      originalBalance,
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
              {accounts.map((account) => (
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
            <div className="text-sm text-gray-500 dark:text-gray-400">Payoff Date</div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {summary.payoffDate}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Current Balance</div>
            <div className="text-xl font-bold text-red-600 dark:text-red-400">
              {formatCurrency(summary.originalBalance)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Total Interest</div>
            <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary.totalInterest)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Total to Pay</div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {formatCurrency(summary.totalPaid)}
            </div>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {payoffSchedule.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            Unable to calculate payoff schedule. Please ensure the account has a payment amount and interest rate configured.
          </p>
        ) : (
          <>
            {viewType === 'balance' ? (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={payoffSchedule}>
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
                    <Line
                      type="monotone"
                      dataKey="balance"
                      stroke="#ef4444"
                      name="Remaining Balance"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
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
              <span className="text-gray-500 dark:text-gray-400">Interest Rate</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payment Amount</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.paymentAmount
                  ? formatCurrency(selectedAccount.paymentAmount)
                  : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payment Frequency</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.paymentFrequency || 'Not set'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
