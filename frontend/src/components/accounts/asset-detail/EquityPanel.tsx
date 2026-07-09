'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { BalanceHistoryChart } from '@/components/transactions/BalanceHistoryChart';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { DailyBalancePoint } from '@/lib/balance-history';
import type { Account } from '@/types/account';

const logger = createLogger('EquityPanel');

interface EquityPanelProps {
  account: Account;
  linkedLoan: Account | null;
  loanOptions: Account[];
  assetValue: number;
  equitySeries: DailyBalancePoint[];
  currency: string;
  isLoading: boolean;
  onChanged: () => void;
}

/**
 * Equity view for an asset linked to a financing loan: asset value minus the
 * amount still owed, with an equity-over-time chart. When no loan is linked it
 * offers a picker to link one; when linked it can unlink.
 */
export function EquityPanel({
  account,
  linkedLoan,
  loanOptions,
  assetValue,
  equitySeries,
  currency,
  isLoading,
  onChanged,
}: EquityPanelProps) {
  const t = useTranslations('accountDetail-asset');
  const { formatCurrency } = useNumberFormat();
  const [selectedLoanId, setSelectedLoanId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const setLinkedLoan = async (loanId: string | null) => {
    setIsSubmitting(true);
    try {
      await accountsApi.update(account.id, { linkedLoanAccountId: loanId });
      toast.success(loanId ? t('equity.linked') : t('equity.unlinked'));
      onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t('equity.actionFailed')));
      logger.error('Failed to update linked loan:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const loanOwed = linkedLoan ? Math.abs(Number(linkedLoan.currentBalance) || 0) : 0;
  const equity = assetValue - loanOwed;

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('equity.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('equity.subtitle')}</p>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 space-y-4">
        {!linkedLoan ? (
          loanOptions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('equity.noLoans')}</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('equity.linkPrompt')}</p>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <Select
                    label={t('equity.selectLoan')}
                    value={selectedLoanId}
                    onChange={(e) => setSelectedLoanId(e.target.value)}
                    options={[
                      { value: '', label: t('equity.selectLoan') },
                      ...loanOptions.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </div>
                <Button
                  onClick={() => setLinkedLoan(selectedLoanId)}
                  disabled={!selectedLoanId || isSubmitting}
                >
                  {t('equity.link')}
                </Button>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {t('equity.linkedTo', { name: linkedLoan.name })}
              </span>
              <button
                type="button"
                onClick={() => setLinkedLoan(null)}
                disabled={isSubmitting}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
              >
                {t('equity.unlink')}
              </button>
            </div>

            <dl className="grid grid-cols-3 gap-4">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">{t('equity.assetValue')}</dt>
                <dd className="text-lg font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrency(assetValue, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">{t('equity.loanBalance')}</dt>
                <dd className="text-lg font-bold text-red-600 dark:text-red-400">
                  {formatCurrency(loanOwed, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">{t('equity.equity')}</dt>
                <dd
                  className={`text-lg font-bold ${
                    equity < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}
                >
                  {formatCurrency(equity, currency)}
                </dd>
              </div>
            </dl>

            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('equity.chartTitle')}
              </h3>
              <BalanceHistoryChart
                data={equitySeries}
                isLoading={isLoading}
                currencyCode={currency}
                accountName={account.name}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
