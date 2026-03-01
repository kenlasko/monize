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
import { createLogger } from '@/lib/logger';

const logger = createLogger('InvestmentTransactionHistoryReport');

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
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [selectedAction, setSelectedAction] = useState<string>('');
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [isLoading, setIsLoading] = useState(true);

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (selectedAccountId) return amount;
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [selectedAccountId, accountCurrencyMap, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

  useEffect(() => {
    if (!isValid) return;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;

        const accountsData = await investmentsApi.getInvestmentAccounts();
        let allTransactions: InvestmentTransaction[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const result = await investmentsApi.getTransactions({
            accountIds: selectedAccountId || undefined,
            startDate: start || undefined,
            endDate: end,
            action: selectedAction || undefined,
            limit: 200,
            page,
          });
          allTransactions = [...allTransactions, ...result.data];
          hasMore = result.pagination.hasMore;
          page++;
        }

        setTransactions(allTransactions);
        setAccounts(accountsData);
      } catch (error) {
        logger.error('Failed to load investment transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId, selectedAction, resolvedRange, isValid]);

  const actionSummaries = useMemo((): ActionSummary[] => {
    const map = new Map<InvestmentAction, ActionSummary>();

    transactions.forEach((tx) => {
      let entry = map.get(tx.action);
      if (!entry) {
        entry = { action: tx.action, count: 0, totalAmount: 0 };
        map.set(tx.action, entry);
      }
      entry.count += 1;
      entry.totalAmount += getTxAmount(tx);
    });

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [transactions, getTxAmount]);

  const totalAmount = useMemo(
    () => transactions.reduce((sum, tx) => sum + getTxAmount(tx), 0),
    [transactions, getTxAmount],
  );

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);



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
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Transactions</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {transactions.length}
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
            {new Set(transactions.filter((tx) => tx.security).map((tx) => tx.security!.symbol)).size}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center">
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value="">All Accounts</option>
            {accounts
              .filter((a) => a.accountSubType !== 'INVESTMENT_BROKERAGE')
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name.replace(/ - (Brokerage|Cash)$/, '')}
                </option>
              ))}
          </select>
          <select
            value={selectedAction}
            onChange={(e) => setSelectedAction(e.target.value)}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value="">All Actions</option>
            {(Object.keys(ACTION_LABELS) as InvestmentAction[]).map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action]}
              </option>
            ))}
          </select>
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
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
      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No investment transactions found for this period.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Transaction History ({transactions.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Action
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Security
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">
                    Account
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Quantity
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {transactions
                  .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
                  .map((tx) => (
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
