'use client';

import { useState, useEffect } from 'react';
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
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { BillPaymentHistoryResponse } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';

export function BillPaymentHistoryReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [billData, setBillData] = useState<BillPaymentHistoryResponse | null>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '1y', alignment: 'day' });
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'overview' | 'byBill'>('overview');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const data = await builtInReportsApi.getBillPaymentHistory({
          startDate: start,
          endDate: end,
        });
        setBillData(data);
      } catch (error) {
        console.error('Failed to load bill payment history:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [resolvedRange]);

  const handleBillClick = () => {
    router.push('/bills');
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

  if (!billData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          Failed to load bill payment history data.
        </p>
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
            {formatCurrency(billData.summary.totalPaid)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Average</div>
          <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(billData.summary.monthlyAverage)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Bills Paid</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.uniqueBills}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">unique bills</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Payments</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.totalPayments}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['6m', '1y', '2y']}
            value={dateRange}
            onChange={setDateRange}
          />
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

      {billData.billPayments.length === 0 ? (
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
              <BarChart data={billData.monthlyTotals}>
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
                {billData.billPayments.map((bp) => (
                  <tr
                    key={bp.scheduledTransactionId}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={handleBillClick}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {bp.scheduledTransactionName}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {bp.payeeName || 'No payee'}
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
