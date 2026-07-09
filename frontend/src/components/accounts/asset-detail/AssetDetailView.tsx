'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { DailyBalancePoint } from '@/lib/balance-history';
import { buildEquitySeries } from '@/lib/asset-equity';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/Button';
import { BalanceHistoryChart } from '@/components/transactions/BalanceHistoryChart';
import { AssetSummaryCards } from './AssetSummaryCards';
import { EquityPanel } from './EquityPanel';
import { UpdateValueDialog } from './UpdateValueDialog';
import type { Account, AccountType } from '@/types/account';

const logger = createLogger('AssetDetailView');

const LOAN_ACCOUNT_TYPES: AccountType[] = ['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

interface AssetDetailViewProps {
  account: Account;
  /** Reload the account itself (after a value update or loan link change). */
  onAccountChanged?: () => void;
}

/**
 * The asset/other detail body: value figures, value history, and an equity
 * panel when a financing loan is linked. Offers an "update value" action that
 * records a balance-adjustment transaction, and loan link/unlink.
 */
export function AssetDetailView({ account, onAccountChanged }: AssetDetailViewProps) {
  const t = useTranslations('accountDetail-asset');
  const currency = account.currencyCode;

  const [loanOptions, setLoanOptions] = useState<Account[]>([]);
  const [linkedLoan, setLinkedLoan] = useState<Account | null>(null);
  const [categoryName, setCategoryName] = useState<string | null>(null);
  const [assetBalances, setAssetBalances] = useState<DailyBalancePoint[]>([]);
  const [loanBalances, setLoanBalances] = useState<DailyBalancePoint[]>([]);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [accounts, categories, assetDaily] = await Promise.all([
        accountsApi.getAll().catch(() => [] as Account[]),
        categoriesApi.getAll().catch(() => []),
        accountsApi.getDailyBalances({ accountIds: account.id }).catch((error) => {
          logger.error('Failed to load value history:', error);
          return [] as { date: string; balance: number }[];
        }),
      ]);

      const loan = account.linkedLoanAccountId
        ? (accounts.find((a) => a.id === account.linkedLoanAccountId) ?? null)
        : null;
      const loanDaily = loan
        ? await accountsApi
            .getDailyBalances({ accountIds: loan.id })
            .catch(() => [] as { date: string; balance: number }[])
        : [];

      if (cancelled) return;
      setLoanOptions(
        accounts.filter(
          (a) => a.id !== account.id && !a.isClosed && LOAN_ACCOUNT_TYPES.includes(a.accountType),
        ),
      );
      setLinkedLoan(loan);
      setCategoryName(
        account.assetCategoryId
          ? (categories.find((c) => c.id === account.assetCategoryId)?.name ?? null)
          : null,
      );
      setAssetBalances(assetDaily.map((r) => ({ date: r.date, balance: r.balance })));
      setLoanBalances(loanDaily.map((r) => ({ date: r.date, balance: r.balance })));
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account, reloadKey]);

  const equitySeries = useMemo(
    () => buildEquitySeries(assetBalances, loanBalances),
    [assetBalances, loanBalances],
  );

  const handleChanged = () => {
    setReloadKey((k) => k + 1);
    onAccountChanged?.();
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setIsUpdateOpen(true)}>{t('updateValue.open')}</Button>
      </div>

      <AssetSummaryCards account={account} categoryName={categoryName} />

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('chart.title')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          {!isLoading && assetBalances.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('chart.empty')}</p>
          ) : (
            <BalanceHistoryChart
              data={assetBalances}
              isLoading={isLoading}
              currencyCode={currency}
              accountName={account.name}
            />
          )}
        </div>
      </section>

      <EquityPanel
        account={account}
        linkedLoan={linkedLoan}
        loanOptions={loanOptions}
        assetValue={Number(account.currentBalance) || 0}
        equitySeries={equitySeries}
        currency={currency}
        isLoading={isLoading}
        onChanged={handleChanged}
      />

      <UpdateValueDialog
        isOpen={isUpdateOpen}
        onClose={() => setIsUpdateOpen(false)}
        account={account}
        onComplete={handleChanged}
      />
    </div>
  );
}
