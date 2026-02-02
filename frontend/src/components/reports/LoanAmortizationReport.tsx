'use client';

import { useState, useEffect, useMemo } from 'react';
import { format, addMonths } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { Account, PaymentFrequency } from '@/types/account';

interface AmortizationRow {
  paymentNumber: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

const FREQUENCY_MONTHS: Record<PaymentFrequency, number> = {
  WEEKLY: 1 / 4.33,
  BIWEEKLY: 1 / 2.17,
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

const FREQUENCY_LABELS: Record<PaymentFrequency, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Bi-weekly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
};

export function LoanAmortizationReport() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [showAllRows, setShowAllRows] = useState(false);

  useEffect(() => {
    const loadAccounts = async () => {
      setIsLoading(true);
      try {
        const allAccounts = await accountsApi.getAll();
        const loanAccounts = allAccounts.filter(
          (a) => (a.accountType === 'LOAN' || a.accountType === 'MORTGAGE') && !a.isClosed
        );
        setAccounts(loanAccounts);
        if (loanAccounts.length > 0) {
          setSelectedAccountId(loanAccounts[0].id);
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

  const amortizationSchedule = useMemo((): AmortizationRow[] => {
    if (!selectedAccount) return [];

    const balance = Math.abs(selectedAccount.currentBalance);
    const rate = (selectedAccount.interestRate || 0) / 100;
    const payment = selectedAccount.paymentAmount || 0;
    const frequency = selectedAccount.paymentFrequency || 'MONTHLY';

    if (balance <= 0 || payment <= 0) return [];

    const monthlyRate = rate / 12;
    const paymentMonths = FREQUENCY_MONTHS[frequency];
    const schedule: AmortizationRow[] = [];
    let currentBalance = balance;
    let currentDate = selectedAccount.paymentStartDate
      ? new Date(selectedAccount.paymentStartDate)
      : new Date();
    let paymentNumber = 1;
    const maxPayments = 1200; // 100 years max

    while (currentBalance > 0.01 && paymentNumber <= maxPayments) {
      const monthsElapsed = paymentMonths;
      const interestAmount = currentBalance * monthlyRate * monthsElapsed;
      const actualPayment = Math.min(payment, currentBalance + interestAmount);
      const principalAmount = actualPayment - interestAmount;

      if (principalAmount <= 0) {
        // Payment doesn't cover interest
        break;
      }

      currentBalance = Math.max(0, currentBalance - principalAmount);

      schedule.push({
        paymentNumber,
        date: format(currentDate, 'yyyy-MM-dd'),
        payment: actualPayment,
        principal: principalAmount,
        interest: interestAmount,
        balance: currentBalance,
      });

      currentDate = addMonths(currentDate, Math.ceil(paymentMonths));
      paymentNumber++;
    }

    return schedule;
  }, [selectedAccount]);

  const summary = useMemo(() => {
    if (amortizationSchedule.length === 0) return null;

    const totalInterest = amortizationSchedule.reduce((sum, row) => sum + row.interest, 0);
    const totalPrincipal = amortizationSchedule.reduce((sum, row) => sum + row.principal, 0);
    const totalPayments = amortizationSchedule.reduce((sum, row) => sum + row.payment, 0);
    const lastRow = amortizationSchedule[amortizationSchedule.length - 1];

    return {
      totalPayments,
      totalPrincipal,
      totalInterest,
      numberOfPayments: amortizationSchedule.length,
      payoffDate: lastRow.date,
    };
  }, [amortizationSchedule]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const displayedRows = showAllRows
    ? amortizationSchedule
    : amortizationSchedule.slice(0, 24);

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
          No loan or mortgage accounts found. Add a loan account with payment details to see the amortization schedule.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Account Selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Select Loan
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && selectedAccount && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Current Balance</div>
            <div className="text-lg font-bold text-red-600 dark:text-red-400">
              {formatCurrency(Math.abs(selectedAccount.currentBalance))}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Payment</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatCurrency(selectedAccount.paymentAmount || 0)}
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                / {selectedAccount.paymentFrequency ? FREQUENCY_LABELS[selectedAccount.paymentFrequency].toLowerCase() : 'month'}
              </span>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Interest Rate</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {selectedAccount.interestRate || 0}%
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Total Interest</div>
            <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary.totalInterest)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Payoff Date</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">
              {format(new Date(summary.payoffDate), 'MMM yyyy')}
            </div>
          </div>
        </div>
      )}

      {/* Amortization Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Amortization Schedule
          </h3>
          {summary && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {summary.numberOfPayments} payments over{' '}
              {Math.ceil(summary.numberOfPayments / 12)} years
            </p>
          )}
        </div>

        {amortizationSchedule.length === 0 ? (
          <p className="px-6 py-8 text-gray-500 dark:text-gray-400 text-center">
            Unable to generate amortization schedule. Please ensure the loan has a balance, payment amount, and interest rate configured.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Payment
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Principal
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Interest
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {displayedRows.map((row) => (
                    <tr key={row.paymentNumber} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {row.paymentNumber}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                        {format(new Date(row.date), 'MMM d, yyyy')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 dark:text-gray-100">
                        {formatCurrency(row.payment)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-green-600 dark:text-green-400">
                        {formatCurrency(row.principal)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-orange-600 dark:text-orange-400">
                        {formatCurrency(row.interest)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrency(row.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {amortizationSchedule.length > 24 && (
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setShowAllRows(!showAllRows)}
                  className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline"
                >
                  {showAllRows
                    ? 'Show fewer rows'
                    : `Show all ${amortizationSchedule.length} payments`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
