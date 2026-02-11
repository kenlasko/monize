'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import dynamic from 'next/dynamic';

const AccountForm = dynamic(() => import('@/components/accounts/AccountForm').then(m => m.AccountForm), { ssr: false });
import { AccountList } from '@/components/accounts/AccountList';
import { Modal } from '@/components/ui/Modal';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { Account } from '@/types/account';
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
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Accounts');

export default function AccountsPage() {
  return (
    <ProtectedRoute>
      <AccountsContent />
    </ProtectedRoute>
  );
}

function AccountsContent() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem, openCreate, openEdit, close, isEditing } = useFormModal<Account>();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { formatCurrency } = useNumberFormat();

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const [data, portfolio] = await Promise.all([
        accountsApi.getAll(true),
        investmentsApi.getPortfolioSummary().catch(() => null),
      ]);
      setAccounts(data);
      setPortfolioSummary(portfolio);
    } catch (error) {
      toast.error('Failed to load accounts');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  // Build a map of brokerage account ID -> total market value of holdings
  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      const totalValue = accountHoldings.totalMarketValue + accountHoldings.cashBalance;
      map.set(accountHoldings.accountId, totalValue);
    }
    return map;
  }, [portfolioSummary]);

  const handleFormSubmit = async (data: any) => {
    try {
      const cleanedData = {
        ...data,
        openingBalance: data.openingBalance || data.openingBalance === 0 ? data.openingBalance : undefined,
        creditLimit: data.creditLimit || data.creditLimit === 0 ? data.creditLimit : undefined,
        interestRate: data.interestRate || data.interestRate === 0 ? data.interestRate : undefined,
      };

      Object.keys(cleanedData).forEach(key => {
        if (cleanedData[key] === undefined || cleanedData[key] === '' || (typeof cleanedData[key] === 'number' && isNaN(cleanedData[key]))) {
          delete cleanedData[key];
        }
      });

      if (editingItem) {
        await accountsApi.update(editingItem.id, cleanedData);
        toast.success('Account updated successfully');
      } else {
        await accountsApi.create(cleanedData);
        toast.success('Account created successfully');
      }
      close();
      loadAccounts();
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingItem ? 'update' : 'create'} account`));
      throw error;
    }
  };

  const calculateSummary = () => {
    const activeAccounts = accounts.filter((a) => !a.isClosed);
    const liabilityTypes = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];
    let totalAssets = 0;
    let totalLiabilities = 0;

    activeAccounts.forEach((a) => {
      // For brokerage accounts, use portfolio market value instead of currentBalance
      const rawBalance = a.accountSubType === 'INVESTMENT_BROKERAGE'
        ? (brokerageMarketValues.get(a.id) ?? 0)
        : (Number(a.currentBalance) || 0);
      // Convert to default currency for accurate aggregation
      const effectiveBalance = convertToDefault(rawBalance, a.currencyCode);

      if (liabilityTypes.includes(a.accountType)) {
        totalLiabilities += Math.abs(effectiveBalance);
      } else {
        totalAssets += effectiveBalance;
      }
    });

    const totalBalance = totalAssets - totalLiabilities;
    return { totalBalance, totalAssets, totalLiabilities, accountCount: activeAccounts.length };
  };

  const summary = calculateSummary();

  return (
    <PageLayout>
      <PageHeader
        title="Accounts"
        subtitle="Manage your bank accounts, credit cards, and investments"
        actions={<Button onClick={openCreate}>+ New Account</Button>}
      />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard
            label="Total Accounts"
            value={summary.accountCount}
            icon={SummaryIcons.accounts}
          />
          <SummaryCard
            label="Net Worth"
            value={formatCurrency(summary.totalBalance, defaultCurrency)}
            icon={SummaryIcons.money}
            valueColor={summary.totalBalance >= 0 ? 'blue' : 'red'}
          />
          <SummaryCard
            label="Total Assets"
            value={formatCurrency(summary.totalAssets, defaultCurrency)}
            icon={SummaryIcons.checkmark}
            valueColor="green"
          />
          <SummaryCard
            label="Total Liabilities"
            value={formatCurrency(summary.totalLiabilities, defaultCurrency)}
            icon={SummaryIcons.cross}
            valueColor="red"
          />
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} maxWidth="2xl" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Account' : 'New Account'}
          </h2>
          <AccountForm
            account={editingItem}
            onSubmit={handleFormSubmit}
            onCancel={close}
          />
        </Modal>

        {/* Accounts List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading accounts..." />
          ) : (
            <AccountList accounts={accounts} brokerageMarketValues={brokerageMarketValues} onEdit={openEdit} onRefresh={loadAccounts} />
          )}
        </div>
      </div>
    </PageLayout>
  );
}
