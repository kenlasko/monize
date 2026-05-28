'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, InvestmentAction } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { exportToCsv } from '@/lib/csv-export';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('InvestmentTransactionHistoryReport');

const MAX_PAGES = 50;

type InvestmentTxSortField = 'date' | 'action' | 'security' | 'account' | 'quantity' | 'price' | 'total';

const ACTION_LABELS: Record<InvestmentAction, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  SPLIT: 'Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  REINVEST: 'Reinvest',
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
};

const ACTION_COLORS: Record<InvestmentAction, string> = {
  BUY: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  SELL: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  DIVIDEND: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  INTEREST: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  CAPITAL_GAIN: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  SPLIT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  TRANSFER_IN: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  TRANSFER_OUT: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  REINVEST: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  ADD_SHARES: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  REMOVE_SHARES: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
};

interface ActionSummary {
  action: InvestmentAction;
  count: number;
  totalAmount: number;
}

export function InvestmentTransactionHistoryReport() {
  const { formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  const actionOptions = useMemo(
    () =>
      (Object.keys(ACTION_LABELS) as InvestmentAction[]).map((action) => ({
        value: action,
        label: ACTION_LABELS[action],
      })),
    [],
  );
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [isLoading, setIsLoading] = useState(true);
  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<InvestmentTxSortField>(
    'reports.investment-transactions.sort',
    { field: 'date', direction: 'desc' },
  );

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (isSingleAccount) return amount;
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [isSingleAccount, accountCurrencyMap, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  useEffect(() => {
    if (!isValid) return;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const allTransactions: InvestmentTransaction[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PAGES) {
          const result = await investmentsApi.getTransactions({
            accountIds: selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined,
            startDate: start || undefined,
            endDate: end,
            limit: 200,
            page,
          });
          allTransactions.push(...result.data);
          hasMore = result.pagination.hasMore;
          page++;
        }

        setTransactions(allTransactions);
      } catch (error) {
        logger.error('Failed to load investment transactions:', error);
      } finally {
        setIsLoading(false);
        setHasLoadedOnce(true);
      }
    };
    loadData();
  }, [selectedAccountIds, resolvedRange, isValid, reloadKey]);

  // Action filtering happens client-side so toggling actions never re-fetches.
  const filteredTransactions = useMemo(() => {
    if (selectedActions.length === 0) return transactions;
    const set = new Set(selectedActions);
    return transactions.filter((tx) => set.has(tx.action));
  }, [transactions, selectedActions]);

  const actionSummaries = useMemo((): ActionSummary[] => {
    const map = new Map<InvestmentAction, ActionSummary>();

    filteredTransactions.forEach((tx) => {
      let entry = map.get(tx.action);
      if (!entry) {
        entry = { action: tx.action, count: 0, totalAmount: 0 };
        map.set(tx.action, entry);
      }
      entry.count += 1;
      entry.totalAmount += getTxAmount(tx);
    });

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [filteredTransactions, getTxAmount]);

  const totalAmount = useMemo(
    () => filteredTransactions.reduce((sum, tx) => sum + getTxAmount(tx), 0),
    [filteredTransactions, getTxAmount],
  );

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  const sortedTransactions = useMemo(() => {
    const sorted = [...filteredTransactions];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'action':
          comparison = compareValues(a.action, b.action);
          break;
        case 'security':
          comparison = compareValues(a.security?.symbol || '', b.security?.symbol || '');
          break;
        case 'account':
          comparison = compareValues(
            accountNameMap.get(a.accountId) || '',
            accountNameMap.get(b.accountId) || '',
          );
          break;
        case 'quantity':
          comparison = compareValues(
            a.quantity != null ? Math.abs(a.quantity) : null,
            b.quantity != null ? Math.abs(b.quantity) : null,
          );
          break;
        case 'price':
          comparison = compareValues(a.price, b.price);
          break;
        case 'total':
          comparison = compareValues(getTxAmount(a), getTxAmount(b));
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredTransactions, sortField, sortDirection, accountNameMap, getTxAmount]);

  const getExportData = useCallback((formatted: boolean) => {
    const headers = ['Date', 'Action', 'Security', 'Account', 'Quantity', 'Price', 'Total'];
    const rows: (string | number)[][] = sortedTransactions.map((tx) => [
      format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd'),
      ACTION_LABELS[tx.action],
      tx.security?.symbol || '-',
      accountNameMap.get(tx.accountId) || '-',
      tx.quantity != null ? Math.abs(tx.quantity) : '',
      tx.price != null ? (formatted ? fmtValue(tx.price) : tx.price) : '',
      formatted ? fmtValue(Math.abs(tx.totalAmount)) : Math.abs(tx.totalAmount),
    ]);
    return { headers, rows };
  }, [sortedTransactions, accountNameMap, fmtValue]);

  const handleExportCsv = useCallback(() => {
    const { headers, rows } = getExportData(false);
    exportToCsv('investment-transactions', headers, rows);
  }, [getExportData]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData(true);
    const accountLabel = selectedAccount
      ? selectedAccount.name.replace(/ - (Brokerage|Cash)$/, '')
      : 'All Accounts';
    const uniqueSecurities = new Set(filteredTransactions.filter((tx) => tx.security).map((tx) => tx.security!.symbol)).size;
    await exportToPdf({
      title: 'Investment Transaction History',
      subtitle: `${accountLabel} | ${filteredTransactions.length} transactions | Total volume: ${fmtValue(totalAmount)}`,
      summaryCards: [
        { label: 'Total Transactions', value: String(filteredTransactions.length), color: '#111827' },
        { label: 'Total Volume', value: fmtValue(totalAmount), color: '#111827' },
        { label: 'Action Types', value: String(actionSummaries.length), color: '#111827' },
        { label: 'Securities Traded', value: String(uniqueSecurities), color: '#111827' },
      ],
      tableData: { headers, rows },
      filename: 'investment-transactions',
    });
  }, [getExportData, selectedAccount, filteredTransactions, fmtValue, totalAmount, actionSummaries]);

  if (isLoading && !hasLoadedOnce) {
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
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Transactions</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {filteredTransactions.length}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Volume</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totalAmount)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Action Types</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {actionSummaries.length}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Securities Traded</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {new Set(filteredTransactions.filter((tx) => tx.security).map((tx) => tx.security!.symbol)).size}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-3 items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
            <div className="w-48">
              <MultiSelect
                ariaLabel="Filter by action"
                placeholder="All Actions"
                showSearch={false}
                options={actionOptions}
                value={selectedActions}
                onChange={setSelectedActions}
              />
            </div>
          </div>
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="ml-auto shrink-0 flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} disabled={filteredTransactions.length === 0} />
          </div>
        </div>
      </div>

      {/* Action Summary */}
      {actionSummaries.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Activity Summary
          </h3>
          <div className="flex flex-wrap gap-3">
            {actionSummaries.map((summary) => (
              <div
                key={summary.action}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/50"
              >
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[summary.action]}`}>
                  {ACTION_LABELS[summary.action]}
                </span>
                <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">
                  {summary.count}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  ({fmtValue(summary.totalAmount)})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transaction List */}
      {filteredTransactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No investment transactions found for this period.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Transaction History ({filteredTransactions.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<InvestmentTxSortField>
                    field="date"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Date
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="action"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Action
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="security"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Security
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="account"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell"
                  >
                    Account
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="quantity"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Quantity
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="price"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Price
                  </SortableHeader>
                  <SortableHeader<InvestmentTxSortField>
                    field="total"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Total
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedTransactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[tx.action]}`}>
                        {ACTION_LABELS[tx.action]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                        {tx.security?.symbol || '-'}
                      </div>
                      {tx.security?.name && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {tx.security.name}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      {accountNameMap.get(tx.accountId) || '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {tx.quantity != null ? Math.abs(tx.quantity).toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {tx.price != null ? fmtValue(tx.price) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtValue(Math.abs(tx.totalAmount))}
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
