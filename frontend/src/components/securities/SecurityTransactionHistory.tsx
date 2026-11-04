'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { CAPTION_CLASS, CellLabel } from '@/components/ui/Table';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SecurityShareAdjustmentForm } from './SecurityShareAdjustmentForm';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { investmentTransactionModalClass } from '@/components/investments/investment-transaction-modal';
import { investmentsApi } from '@/lib/investments';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { priceDecimals, TRADE_PRICE_DISPLAY_DECIMALS } from '@/lib/security-detail';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import toast from 'react-hot-toast';
import type { Account } from '@/types/account';
import type {
  InvestmentTransaction,
  Security,
  SecurityTransactionHistory as SecurityTransactionHistoryData,
} from '@/types/investment';

const logger = createLogger('SecurityTxHistory');

// Shared chrome for a wrapped money/quantity cell: no padding on phones (the
// row's grid spaces the cards), the table cell's own padding from `sm` up. The
// figures never wrap so a locale that groups thousands with a space keeps them
// on one line.
const MONEY_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-3 sm:py-2 sm:text-sm';

interface SecurityTransactionHistoryProps {
  security: Security;
  /** Called after a transaction is added so callers can refresh dependent data. */
  onChanged?: () => void;
}

export function SecurityTransactionHistory({
  security,
  onChanged,
}: SecurityTransactionHistoryProps) {
  const t = useTranslations('securities');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatCurrencyPrecise, formatShareQuantity } = useNumberFormat();
  const [history, setHistory] = useState<SecurityTransactionHistoryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  // Full account objects (including closed) for the edit form's pickers.
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [editTransaction, setEditTransaction] = useState<InvestmentTransaction | null>(null);

  const fetchHistory = useCallback(() => {
    // The writes live in the inner function so they run after the request,
    // not during the effect that starts it.
    const run = async () => {
      try {
        const data = await investmentsApi.getSecurityTransactionHistory(security.id);
        setHistory(data);
      } catch (error) {
        logger.error('Failed to load security transaction history:', error);
        // getErrorMessage keeps the message consistent with the rest of the app.
        setHistory(null);
        throw new Error(getErrorMessage(error, t('transactionHistory.toasts.loadHistoryFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [security.id, t]);

  // Every reload after a change shows the spinner again.
  const load = useCallback(() => {
    setIsLoading(true);
    return fetchHistory();
  }, [fetchHistory]);

  // A different security is a new request: it shows as loading from the
  // render that asks for it (the "info from previous render" pattern). The
  // first load needs nothing here, `isLoading` starts true.
  const [loadingFor, setLoadingFor] = useState(security.id);
  if (loadingFor !== security.id) {
    setLoadingFor(security.id);
    setIsLoading(true);
  }

  useEffect(() => {
    fetchHistory().catch(() => {
      /* error already logged; UI shows empty state */
    });
  }, [fetchHistory]);

  // Load all accounts (including closed) once, so editing a transaction in a
  // closed account still has its account available in the form.
  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getAll(true)
      .then((data) => {
        if (!cancelled) setAllAccounts(data);
      })
      .catch((error) => {
        if (!cancelled) logger.error('Failed to load accounts:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEditClick = useCallback(async (id: string) => {
    try {
      const tx = await investmentsApi.getTransaction(id);
      setEditTransaction(tx);
    } catch (error) {
      toast.error(getErrorMessage(error, t('transactionHistory.toasts.loadTransactionFailed')));
    }
  }, [t]);

  const handleEditSuccess = () => {
    setEditTransaction(null);
    onChanged?.();
    load().catch(() => {});
  };

  const accounts = useMemo(() => history?.accounts ?? [], [history]);
  const showAccountColumn = selectedAccountId === 'all';

  const visibleTransactions = useMemo(() => {
    const txns = history?.transactions ?? [];
    if (selectedAccountId === 'all') return txns;
    return txns.filter((t) => t.accountId === selectedAccountId);
  }, [history, selectedAccountId]);

  const defaultAdjustAccountId =
    selectedAccountId !== 'all' ? selectedAccountId : accounts[0]?.accountId;

  const handleAdjustmentSubmitted = () => {
    setShowAddForm(false);
    onChanged?.();
    load().catch(() => {});
  };

  return (
    <div>
      {/* No heading or share count: the detail page's header and summary cards
          already carry both. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {accounts.length > 0 && (
          <div className="w-full sm:max-w-xs">
            <Select
              label={t('transactionHistory.accountLabel')}
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              options={[
                { value: 'all', label: t('transactionHistory.allAccounts', { shares: formatShareQuantity(history?.currentQuantityAll ?? 0) }) },
                ...accounts.map((a) => ({
                  value: a.accountId,
                  label: `${a.isClosed ? t('transactionHistory.accountClosed', { name: a.accountName }) : a.accountName} — ${formatShareQuantity(a.currentQuantity)}`,
                })),
              ]}
            />
          </div>
        )}
        {accounts.length > 0 && !showAddForm && (
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)}>
            {t('transactionHistory.addTransaction')}
          </Button>
        )}
      </div>

      {showAddForm && (
        <div className="mb-4">
          <SecurityShareAdjustmentForm
            securityId={security.id}
            accounts={accounts}
            defaultAccountId={defaultAdjustAccountId}
            onSubmitted={handleAdjustmentSubmitted}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner text={t('transactionHistory.loading')} />
      ) : visibleTransactions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400">
          {selectedAccountId !== 'all' ? t('transactionHistory.emptyAccount') : t('transactionHistory.emptyAll')}
        </div>
      ) : (
        // Below `sm` the table becomes a block and each row wraps into a
        // four-column grid card so date/amount, then action/quantity/running/
        // price, then account/edit fit a phone without a horizontal scroll; from
        // `sm` up it is the ordinary table. Explicit `role`s put back the table
        // semantics that restyling `display` strips (inert from `sm` up).
        <div className="overflow-x-auto">
          <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
            <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-800 sm:table-header-group">
              <tr role="row" className="hidden sm:table-row">
                <th role="columnheader" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.date')}</th>
                {showAccountColumn && (
                  <th role="columnheader" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.account')}</th>
                )}
                <th role="columnheader" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.action')}</th>
                <th role="columnheader" className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.quantity')}</th>
                <th role="columnheader" className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.runningTotal')}</th>
                <th role="columnheader" className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.price')}</th>
                <th role="columnheader" className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('transactionHistory.columns.amount')}</th>
                <th role="columnheader" className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <span className="sr-only">{t('transactionHistory.columns.actionsLabel')}</span>
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900 sm:table-row-group">
              {visibleTransactions.map((tx) => {
                const running =
                  selectedAccountId === 'all'
                    ? tx.runningQuantityAll
                    : tx.runningQuantityAccount;
                return (
                  <tr
                    key={tx.id}
                    role="row"
                    className="grid grid-cols-4 items-start gap-x-3 gap-y-1.5 px-3 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 sm:table-row sm:p-0"
                  >
                    <td role="cell" className="col-span-2 row-start-1 p-0 text-sm whitespace-nowrap text-gray-900 dark:text-gray-100 sm:table-cell sm:px-3 sm:py-2">
                      {formatDate(tx.transactionDate)}
                    </td>
                    {showAccountColumn && (
                      <td role="cell" className="col-start-1 col-span-3 row-start-3 p-0 text-sm text-gray-700 dark:text-gray-300 sm:table-cell sm:px-3 sm:py-2">
                        {tx.accountName}
                      </td>
                    )}
                    <td role="cell" className="col-start-1 row-start-2 p-0 text-sm text-gray-700 dark:text-gray-300 sm:table-cell sm:whitespace-nowrap sm:px-3 sm:py-2">
                      {t(`transactionHistory.actionLabels.${tx.action}` as Parameters<typeof t>[0]) ?? tx.action}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('transactionHistory.columns.quantity')}</CellLabel>
                      {tx.quantity === null ? '-' : formatShareQuantity(tx.quantity)}
                    </td>
                    <td role="cell" className={`col-start-3 row-start-2 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('transactionHistory.columns.runningTotal')}</CellLabel>
                      {formatShareQuantity(running)}
                    </td>
                    <td role="cell" className={`col-start-4 row-start-2 text-gray-700 dark:text-gray-300 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('transactionHistory.columns.price')}</CellLabel>
                      {tx.price === null
                        ? '-'
                        : /* Four decimals, or as many as the stored price
                             carries (capped at six): a price derived from an
                             executed total is a quotient, and 5.8200 is not
                             what 141 shares went at. */
                          formatCurrencyPrecise(
                            tx.price,
                            security.currencyCode,
                            Math.max(4, priceDecimals([tx.price], TRADE_PRICE_DISPLAY_DECIMALS)),
                          )}
                    </td>
                    <td role="cell" className={`col-start-3 col-span-2 row-start-1 text-gray-700 dark:text-gray-300 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('transactionHistory.columns.amount')}</CellLabel>
                      {formatCurrency(tx.totalAmount, security.currencyCode)}
                    </td>
                    <td role="cell" className="col-start-4 row-start-3 flex justify-end p-0 sm:table-cell sm:whitespace-nowrap sm:px-3 sm:py-2 sm:text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEditClick(tx.id)}
                        className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300"
                      >
                        {tc('edit')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit transaction modal, opened from a row on the detail page's
          Transactions tab. */}
      <Modal
        isOpen={!!editTransaction}
        onClose={() => setEditTransaction(null)}
        maxWidth="xl"
        className={investmentTransactionModalClass(false)}
        pushHistory
      >
        {editTransaction && (
          <>
            <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t('transactionHistory.editTransactionTitle')}
            </h2>
            <InvestmentTransactionForm
              transaction={editTransaction}
              accounts={allAccounts}
              allAccounts={allAccounts}
              onSuccess={handleEditSuccess}
              onCancel={() => setEditTransaction(null)}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
