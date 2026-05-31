'use client';

import { useState, useEffect, useMemo, Fragment } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { format, parseISO } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { createLogger } from '@/lib/logger';

const logger = createLogger('LoanAmortizationReport');

type AmortizationSortField = 'paymentNumber' | 'date' | 'payment' | 'principal' | 'interest' | 'balance';

interface PaymentRow {
  paymentNumber: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
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

function friendlyAccountType(type: string): string {
  switch (type) {
    case 'LINE_OF_CREDIT': return 'Line of Credit';
    case 'LOAN': return 'Loan';
    case 'MORTGAGE': return 'Mortgage';
    default: return type.charAt(0) + type.slice(1).toLowerCase();
  }
}

export function LoanAmortizationReport() {
  const { formatCurrency } = useNumberFormat();
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [showAllRows, setShowAllRows] = useState(false);
  const { sortField, sortDirection, handleSort } = useSortableTable<AmortizationSortField>(
    'reports.loan-amortization.sort',
    { field: 'paymentNumber', direction: 'asc' },
  );

  // Load all accounts and filter for loans.
  const { data: fetchedAccounts, isLoading, error, reload } = useReportData(
    () => accountsApi.getAll(true),
    [],
  );

  const accounts = useMemo(
    () =>
      (fetchedAccounts ?? []).filter(
        (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE' || a.accountType === 'LINE_OF_CREDIT',
      ),
    [fetchedAccounts],
  );

  // Default the selection to the first loan once accounts arrive. Seeded during
  // render (not in an effect) so the transactions fetch carries it immediately.
  const [seededAccounts, setSeededAccounts] = useState(false);
  if (!seededAccounts && accounts.length > 0) {
    setSeededAccounts(true);
    setSelectedAccountId(accounts[0].id);
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load transactions from the loan account
  useEffect(() => {
    const loadTransactions = async () => {
      if (!selectedAccountId) {
        setTransactions([]);
        return;
      }

      try {
        // Paginate through all transactions (API limit is 200 per page)
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
        setTransactions(allTransactions);
      } catch (error) {
        logger.error('Failed to load transactions:', error);
        setTransactions([]);
      }
    };

    loadTransactions();
  }, [selectedAccountId]);

  // Build payment history from actual transactions + projected future payments
  const paymentHistory = useMemo((): PaymentRow[] => {
    if (!selectedAccount) return [];

    const loanAccountId = selectedAccount.id;
    const payments: PaymentRow[] = [];

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

    let runningBalance = openingBalance > 0 ? openingBalance : calculatedOriginalBalance;

    let paymentNumber = 1;

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

      payments.push({
        paymentNumber,
        date: transaction.transactionDate,
        payment: principal + interest,
        principal,
        interest,
        balance: runningBalance,
        isProjected: false,
      });

      paymentNumber++;
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
      let projDate = new Date();

      const MAX_PROJECTED_PAYMENTS = 600;
      let projCount = 0;

      while (projRunningBalance > 0.01 && projCount < MAX_PROJECTED_PAYMENTS) {
        projDate = advanceDate(projDate, frequency);
        const interestCharge = projRunningBalance * periodicRate;
        let principalPortion = paymentAmount - interestCharge;

        if (principalPortion <= 0) break;

        if (principalPortion > projRunningBalance) {
          principalPortion = projRunningBalance;
        }

        projRunningBalance = Math.max(0, projRunningBalance - principalPortion);

        payments.push({
          paymentNumber,
          date: format(projDate, 'yyyy-MM-dd'),
          payment: Math.round((principalPortion + interestCharge) * 100) / 100,
          principal: Math.round(principalPortion * 100) / 100,
          interest: Math.round(interestCharge * 100) / 100,
          balance: Math.round(projRunningBalance * 100) / 100,
          isProjected: true,
        });

        paymentNumber++;
        projCount++;
      }
    }

    return payments;
  }, [selectedAccount, transactions]);

  const historicalCount = useMemo(() => paymentHistory.filter((r) => !r.isProjected).length, [paymentHistory]);
  const hasProjection = useMemo(() => paymentHistory.some((r) => r.isProjected), [paymentHistory]);

  const summary = useMemo(() => {
    if (paymentHistory.length === 0 || !selectedAccount) return null;

    const totalInterest = paymentHistory.reduce((sum, row) => sum + row.interest, 0);
    const totalPrincipal = paymentHistory.reduce((sum, row) => sum + row.principal, 0);
    const totalPaymentAmount = paymentHistory.reduce((sum, row) => sum + row.payment, 0);
    const lastRow = paymentHistory[paymentHistory.length - 1];
    const currentBalance = Math.abs(selectedAccount.currentBalance);
    const originalBalance = Math.abs(selectedAccount.openingBalance) || (totalPrincipal + currentBalance);

    return {
      totalPayments: totalPaymentAmount,
      totalPrincipal,
      totalInterest,
      numberOfPayments: historicalCount,
      lastPaymentDate: lastRow.date,
      originalBalance,
      hasProjection,
      projectedPayoffDate: hasProjection ? lastRow.date : null,
    };
  }, [paymentHistory, selectedAccount, historicalCount, hasProjection]);

  const getExportData = (formatted: boolean) => {
    const headers = ['#', 'Date', 'Payment', 'Principal', 'Interest', 'Balance', 'Type'];
    const currency = selectedAccount?.currencyCode;
    const rows = paymentHistory.map((row) => [
      row.paymentNumber,
      format(parseISO(row.date), 'yyyy-MM-dd'),
      formatted ? formatCurrency(row.payment, currency) : row.payment,
      formatted ? formatCurrency(row.principal, currency) : row.principal,
      formatted ? formatCurrency(row.interest, currency) : row.interest,
      formatted ? formatCurrency(row.balance, currency) : row.balance,
      row.isProjected ? 'Projected' : 'Actual',
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData(false);
    const accountName = selectedAccount?.name?.replace(/[^a-zA-Z0-9]/g, '-') || 'loan';
    exportToCsv(`amortization-${accountName}`, headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const currency = selectedAccount?.currencyCode;
    const { headers, rows } = getExportData(true);
    const accountName = selectedAccount?.name?.replace(/[^a-zA-Z0-9]/g, '-') || 'loan';
    const cards = [];
    if (selectedAccount) {
      cards.push(
        { label: 'Current Balance', value: formatCurrency(Math.abs(selectedAccount.currentBalance), currency), color: '#dc2626' },
        { label: 'Original Amount', value: formatCurrency(summary?.originalBalance || Math.abs(selectedAccount.openingBalance), currency), color: '#111827' },
        { label: 'Interest Rate', value: selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : 'Not set', color: '#111827' },
        { label: summary?.hasProjection ? 'Est. Total Interest' : 'Total Interest Paid', value: formatCurrency(summary?.totalInterest || 0, currency), color: '#ea580c' },
        { label: 'Payments Made', value: String(historicalCount), color: '#16a34a' },
      );
      if (summary?.hasProjection && summary.projectedPayoffDate) {
        cards.push({ label: 'Est. Payoff', value: format(parseISO(summary.projectedPayoffDate), 'MMM yyyy'), color: '#9333ea' });
      }
    }
    await exportToPdf({
      title: `Loan Amortization - ${selectedAccount?.name || 'Loan'}`,
      subtitle: summary ? `${historicalCount} payments made, ${formatCurrency(summary.totalInterest, currency)} total interest` : undefined,
      summaryCards: cards.length > 0 ? cards : undefined,
      tableData: { headers, rows },
      filename: `amortization-${accountName}`,
    });
  };

  const sortedPaymentHistory = useMemo(() => {
    const sorted = [...paymentHistory];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'paymentNumber':
          comparison = compareValues(a.paymentNumber, b.paymentNumber);
          break;
        case 'date':
          comparison = compareValues(a.date, b.date);
          break;
        case 'payment':
          comparison = compareValues(a.payment, b.payment);
          break;
        case 'principal':
          comparison = compareValues(a.principal, b.principal);
          break;
        case 'interest':
          comparison = compareValues(a.interest, b.interest);
          break;
        case 'balance':
          comparison = compareValues(a.balance, b.balance);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [paymentHistory, sortField, sortDirection]);

  const displayedRows = showAllRows
    ? sortedPaymentHistory
    : sortedPaymentHistory.slice(0, 24);

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
          No loan or mortgage accounts found. Add a loan account to see the payment history.
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
          <div className="ml-auto">
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {selectedAccount && (
        <div className={`grid grid-cols-2 ${summary?.hasProjection ? 'md:grid-cols-6' : 'md:grid-cols-5'} gap-4`}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Current Balance</div>
            <div className="text-lg font-bold text-red-600 dark:text-red-400">
              {formatCurrency(Math.abs(selectedAccount.currentBalance))}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Original Amount</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatCurrency(summary?.originalBalance || Math.abs(selectedAccount.openingBalance))}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Interest Rate</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {selectedAccount.interestRate ? `${selectedAccount.interestRate}%` : 'Not set'}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary?.hasProjection ? 'Est. Total Interest' : 'Total Interest Paid'}
            </div>
            <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary?.totalInterest || 0)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Payments Made</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">
              {historicalCount}
            </div>
          </div>
          {summary?.hasProjection && summary.projectedPayoffDate && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
              <div className="text-sm text-gray-500 dark:text-gray-400">Est. Payoff</div>
              <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                {format(parseISO(summary.projectedPayoffDate), 'MMM yyyy')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Account Details */}
      {selectedAccount && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Account Type</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {friendlyAccountType(selectedAccount.accountType)}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payment Frequency</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.paymentFrequency
                  ? selectedAccount.paymentFrequency.charAt(0) + selectedAccount.paymentFrequency.slice(1).toLowerCase().replace('_', '-')
                  : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payment Amount</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.paymentAmount ? formatCurrency(selectedAccount.paymentAmount) : 'Not set'}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Status</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.isClosed ? 'Closed' : 'Active'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Payment History Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Payment {hasProjection ? 'History & Projection' : 'History'}
          </h3>
          {summary && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {historicalCount} payments made
              {hasProjection && ` + ${paymentHistory.length - historicalCount} projected`}
              {' '}totaling {formatCurrency(summary.totalPayments)}
            </p>
          )}
        </div>

        {paymentHistory.length === 0 ? (
          <p className="px-6 py-8 text-gray-500 dark:text-gray-400 text-center">
            No payments found for this loan. Make payments to your loan account to see them here.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<AmortizationSortField>
                      field="paymentNumber"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      #
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="date"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      Date
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="payment"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      Payment
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="principal"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      Principal
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="interest"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      Interest
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="balance"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      Balance
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {displayedRows.map((row, idx) => {
                    // Show a separator row when transitioning from historical to projected
                    const prevRow = idx > 0 ? displayedRows[idx - 1] : null;
                    const showSeparator = row.isProjected && prevRow && !prevRow.isProjected;
                    return (
                      <Fragment key={row.paymentNumber}>
                        {showSeparator && (
                          <tr className="bg-gray-100 dark:bg-gray-700">
                            <td colSpan={6} className="px-4 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              Projected Future Payments
                            </td>
                          </tr>
                        )}
                        <tr
                          className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                            row.isProjected ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                          }`}
                        >
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                            {row.paymentNumber}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                            {format(parseISO(row.date), 'MMM d, yyyy')}
                            {row.isProjected && (
                              <span className="ml-1.5 text-xs text-blue-500 dark:text-blue-400">*</span>
                            )}
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
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {paymentHistory.length > 24 && (
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setShowAllRows(!showAllRows)}
                  className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline"
                >
                  {showAllRows
                    ? 'Show fewer rows'
                    : `Show all ${paymentHistory.length} payments`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
