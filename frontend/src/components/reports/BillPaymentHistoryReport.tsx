'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { Transaction } from '@/types/transaction';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';

type DateRange = '6m' | '1y' | '2y';

interface BillPayment {
  scheduledTransaction: ScheduledTransaction;
  transactions: Transaction[];
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  lastPaymentDate: string | null;
}

interface MonthlyTotal {
  month: string;
  label: string;
  total: number;
}

export function BillPaymentHistoryReport() {
  const router = useRouter();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('1y');
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'overview' | 'byBill'>('overview');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(now, 'yyyy-MM-dd');
    let start: string;

    switch (range) {
      case '6m':
        start = format(subMonths(now, 6), 'yyyy-MM-dd');
        break;
      case '1y':
        start = format(subMonths(now, 12), 'yyyy-MM-dd');
        break;
      case '2y':
        start = format(subMonths(now, 24), 'yyyy-MM-dd');
        break;
    }

    return { start, end };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = getDateRange(dateRange);
        const [txData, stData] = await Promise.all([
          transactionsApi.getAll({ startDate: start, endDate: end, limit: 50000 }),
          scheduledTransactionsApi.getAll(),
        ]);

        // Filter to non-transfer transactions only
        setTransactions(txData.data.filter((tx) => !tx.isTransfer));
        setScheduledTransactions(stData.filter((st) => !st.isTransfer));
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [dateRange, getDateRange]);

  const billPayments = useMemo((): BillPayment[] => {
    const paymentMap = new Map<string, BillPayment>();

    // Initialize with all scheduled transactions
    scheduledTransactions.forEach((st) => {
      paymentMap.set(st.id, {
        scheduledTransaction: st,
        transactions: [],
        totalPaid: 0,
        paymentCount: 0,
        averagePayment: 0,
        lastPaymentDate: null,
      });
    });

    // Match transactions to scheduled transactions by payee name and similar amount
    transactions.forEach((tx) => {
      const txPayeeName = (tx.payee?.name || tx.payeeName || '').toLowerCase().trim();
      const txAmount = Math.abs(Number(tx.amount));
      if (!txPayeeName) return;

      // Find matching scheduled transaction
      for (const st of scheduledTransactions) {
        const stPayeeName = (st.payee?.name || st.payeeName || '').toLowerCase().trim();
        const stAmount = Math.abs(st.amount);

        // Match by payee name (must match) and amount (within 20% tolerance for variable bills)
        if (
          txPayeeName === stPayeeName &&
          txAmount >= stAmount * 0.8 &&
          txAmount <= stAmount * 1.2
        ) {
          const payment = paymentMap.get(st.id);
          if (payment) {
            payment.transactions.push(tx);
            payment.totalPaid += txAmount;
            payment.paymentCount++;
          }
          break; // Only match to one scheduled transaction
        }
      }
    });

    // Calculate averages and last payment dates
    paymentMap.forEach((payment) => {
      if (payment.paymentCount > 0) {
        payment.averagePayment = payment.totalPaid / payment.paymentCount;

        // Find last payment date
        const sortedTx = [...payment.transactions].sort(
          (a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime()
        );
        payment.lastPaymentDate = sortedTx[0]?.transactionDate || null;
      }
    });

    // Sort by total paid
    return Array.from(paymentMap.values())
      .filter((p) => p.paymentCount > 0)
      .sort((a, b) => b.totalPaid - a.totalPaid);
  }, [transactions, scheduledTransactions]);

  // Get all matched transactions from bill payments
  const matchedTransactions = useMemo(() => {
    const txSet = new Set<Transaction>();
    billPayments.forEach((bp) => {
      bp.transactions.forEach((tx) => txSet.add(tx));
    });
    return Array.from(txSet);
  }, [billPayments]);

  const monthlyData = useMemo((): MonthlyTotal[] => {
    const { start, end } = getDateRange(dateRange);
    const startDate = parseLocalDate(start);
    const endDate = parseLocalDate(end);

    const months = eachMonthOfInterval({ start: startDate, end: endDate });
    const monthMap = new Map<string, MonthlyTotal>();

    months.forEach((month) => {
      const key = format(month, 'yyyy-MM');
      monthMap.set(key, {
        month: key,
        label: format(month, 'MMM yy'),
        total: 0,
      });
    });

    matchedTransactions.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const monthKey = format(txDate, 'yyyy-MM');
      const bucket = monthMap.get(monthKey);
      if (bucket) {
        bucket.total += Math.abs(Number(tx.amount));
      }
    });

    return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [matchedTransactions, dateRange, getDateRange]);

  const summary = useMemo(() => {
    const totalPaid = billPayments.reduce((sum, bp) => sum + bp.totalPaid, 0);
    const totalPayments = billPayments.reduce((sum, bp) => sum + bp.paymentCount, 0);
    const uniqueBills = billPayments.length;
    const monthsInRange = dateRange === '6m' ? 6 : dateRange === '1y' ? 12 : 24;
    const monthlyAverage = totalPaid / monthsInRange;

    return {
      totalPaid,
      totalPayments,
      uniqueBills,
      monthlyAverage,
    };
  }, [billPayments, dateRange]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const handleBillClick = (st: ScheduledTransaction) => {
    router.push(`/scheduled-transactions?id=${st.id}`);
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrency(payload[0].value)}
          </p>
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

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Paid</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(summary.totalPaid)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Average</div>
          <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(summary.monthlyAverage)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Bills Paid</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary.uniqueBills}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">unique bills</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Payments</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary.totalPayments}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {(['6m', '1y', '2y'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('overview')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'overview'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewType('byBill')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byBill'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Bill
            </button>
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No bill payments found for this period. Post scheduled transactions to see payment history.
          </p>
        </div>
      ) : viewType === 'overview' ? (
        /* Monthly Overview Chart */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Monthly Bill Payments
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" fill="#3b82f6" name="Total Paid" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        /* By Bill Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Payment History by Bill
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Bill
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Payments
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Average
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total Paid
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Last Payment
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {billPayments.map((bp) => (
                  <tr
                    key={bp.scheduledTransaction.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => handleBillClick(bp.scheduledTransaction)}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {bp.scheduledTransaction.name}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {bp.scheduledTransaction.payee?.name || bp.scheduledTransaction.payeeName || 'No payee'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-sm text-gray-900 dark:text-gray-100">
                      {bp.paymentCount}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {formatCurrency(bp.averagePayment)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrency(bp.totalPaid)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                      {bp.lastPaymentDate
                        ? format(parseLocalDate(bp.lastPaymentDate), 'MMM d, yyyy')
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
