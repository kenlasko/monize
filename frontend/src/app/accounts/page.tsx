'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { Button } from '@/components/ui/Button';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

import { AccountList } from '@/components/accounts/AccountList';
import { AccountFormModal } from '@/components/accounts/AccountFormModal';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { institutionsApi } from '@/lib/institutions';
import { countLogicalAccounts } from '@/lib/account-utils';
import { Account } from '@/types/account';
import { Institution } from '@/types/institution';
import { PortfolioSummary } from '@/types/investment';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { showErrorToast } from '@/lib/errors';

const logger = createLogger('Accounts');

export default function AccountsPage() {
  return (
    <ProtectedRoute>
      <AccountsContent />
    </ProtectedRoute>
  );
}

function AccountsContent() {
  const t = useTranslations('accounts');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const formModal = useFormModal<Account>();
  const { openCreate, openEdit } = formModal;
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { formatCurrency } = useNumberFormat();

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      const [data, portfolio, insts] = await Promise.all([
        accountsApi.getAll(true),
        investmentsApi.getPortfolioSummary().catch(() => null),
        institutionsApi.getAll().catch(() => [] as Institution[]),
      ]);
      setAccounts(data);
      setPortfolioSummary(portfolio);
      setInstitutions(insts);
    } catch (error) {
      showErrorToast(error, t('toast.loadFailed'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useOnUndoRedo(loadAccounts);
  // An AI write can change account balances (e.g. a transaction created from
  // the chat bubble), so refresh the same way as an undo/redo.
  useOnAiAction(loadAccounts);

  // Build a map of brokerage account ID -> market value of holdings only.
  // Cash balance is tracked separately via the linked INVESTMENT_CASH account
  // to avoid double-counting in the net worth summary.
  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioSummary]);

  const calculateSummary = () => {
    const activeAccounts = accounts.filter((a) => !a.isClosed);
    const liabilityTypes = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];
    let totalAssets = 0;
    let totalLiabilities = 0;

    activeAccounts.forEach((a) => {
      // For brokerage accounts, use portfolio market value instead of currentBalance
      // For other accounts, include future-dated transactions in the balance
      const rawBalance = a.accountSubType === 'INVESTMENT_BROKERAGE'
        ? (brokerageMarketValues.get(a.id) ?? 0)
        : (Number(a.currentBalance) || 0) + (Number(a.futureTransactionsSum) || 0);
      // Convert to default currency for accurate aggregation
      const effectiveBalance = convertToDefault(rawBalance, a.currencyCode);

      if (liabilityTypes.includes(a.accountType)) {
        totalLiabilities += Math.abs(effectiveBalance);
      } else {
        totalAssets += effectiveBalance;
      }
    });

    const accountCount = countLogicalAccounts(activeAccounts);
    const totalBalance = totalAssets - totalLiabilities;
    return { totalBalance, totalAssets, totalLiabilities, accountCount };
  };

  const summary = calculateSummary();

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/Accounts"
          actions={
            <Button
              {...tourAnchor(TOUR_ANCHORS.accountsAddButton)}
              onClick={openCreate}
            >
              {t('page.newAccount')}
            </Button>
          }
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <SummaryCard
            label={t('page.summary.totalActiveAccounts')}
            value={summary.accountCount}
            icon={SummaryIcons.accounts}
          />
          <SummaryCard
            label={t('page.summary.netWorth')}
            value={formatCurrency(summary.totalBalance, defaultCurrency)}
            icon={SummaryIcons.money}
            valueColor={summary.totalBalance >= 0 ? 'blue' : 'red'}
          />
          <SummaryCard
            label={t('page.summary.totalAssets')}
            value={formatCurrency(summary.totalAssets, defaultCurrency)}
            icon={SummaryIcons.checkmark}
            valueColor="green"
          />
          <SummaryCard
            label={t('page.summary.totalLiabilities')}
            value={formatCurrency(summary.totalLiabilities, defaultCurrency)}
            icon={SummaryIcons.cross}
            valueColor="red"
          />
        </div>

        {/* Form Modal */}
        <AccountFormModal formModal={formModal} onSaved={loadAccounts} />

        {/* Accounts List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text={t('page.loadingAccounts')} />
          ) : (
            <AccountList accounts={accounts} institutions={institutions} brokerageMarketValues={brokerageMarketValues} defaultCurrency={defaultCurrency} convertToDefault={convertToDefault} onEdit={openEdit} onRefresh={loadAccounts} />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
