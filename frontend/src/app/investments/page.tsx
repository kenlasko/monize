'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { HoldingsList } from '@/components/investments/HoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  AssetAllocation,
  InvestmentTransaction,
} from '@/types/investment';

export default function InvestmentsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(
    null,
  );
  const [assetAllocation, setAssetAllocation] = useState<AssetAllocation | null>(
    null,
  );
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<InvestmentTransaction | undefined>();

  const loadInvestmentAccounts = useCallback(async () => {
    try {
      const accountsData = await investmentsApi.getInvestmentAccounts();
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load investment accounts:', error);
    }
  }, []);

  const loadPortfolioData = useCallback(async (accountId?: string) => {
    setIsLoading(true);
    try {
      const [summaryData, allocationData, txData] = await Promise.all([
        investmentsApi.getPortfolioSummary(accountId || undefined),
        investmentsApi.getAssetAllocation(accountId || undefined),
        investmentsApi.getTransactions({
          accountId: accountId || undefined,
        }),
      ]);

      setPortfolioSummary(summaryData);
      setAssetAllocation(allocationData);
      setTransactions(txData || []);
    } catch (error) {
      console.error('Failed to load portfolio data:', error);
      // Set empty arrays on error to prevent undefined errors
      setPortfolioSummary(null);
      setAssetAllocation(null);
      setTransactions([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
  }, [loadInvestmentAccounts]);

  useEffect(() => {
    loadPortfolioData(selectedAccountId || undefined);
  }, [loadPortfolioData, selectedAccountId]);

  const handleAccountChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedAccountId(e.target.value);
  };

  const handleDeleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return;
    try {
      await investmentsApi.deleteTransaction(id);
      // Reload data
      loadPortfolioData(selectedAccountId || undefined);
    } catch (error) {
      console.error('Failed to delete transaction:', error);
      alert('Failed to delete transaction');
    }
  };

  const handleNewTransaction = () => {
    setEditingTransaction(undefined);
    setShowTransactionForm(true);
  };

  const handleEditTransaction = (transaction: InvestmentTransaction) => {
    setEditingTransaction(transaction);
    setShowTransactionForm(true);
  };

  const handleFormSuccess = () => {
    setShowTransactionForm(false);
    setEditingTransaction(undefined);
    loadPortfolioData(selectedAccountId || undefined);
  };

  const handleFormCancel = () => {
    setShowTransactionForm(false);
    setEditingTransaction(undefined);
  };

  // Get brokerage account for the selected cash account
  const getSelectedBrokerageAccountId = () => {
    if (!selectedAccountId) return undefined;
    const cashAccount = accounts.find((a) => a.id === selectedAccountId);
    if (cashAccount?.linkedAccountId) {
      return cashAccount.linkedAccountId;
    }
    return undefined;
  };

  // Group accounts by pair for display
  const getAccountDisplayName = (account: Account) => {
    if (account.accountSubType === 'INVESTMENT_CASH') {
      return account.name.replace(' - Cash', '');
    }
    return account.name;
  };

  // Get unique investment pairs (only show cash accounts in selector)
  const cashAccounts = accounts.filter(
    (a) => a.accountSubType === 'INVESTMENT_CASH',
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <main className="px-4 sm:px-6 lg:px-12 py-6">
        <div className="px-4 sm:px-0">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                Investments
              </h1>
              <p className="text-gray-500 dark:text-gray-400">
                Track your investment portfolio
              </p>
            </div>

            {/* Account Filter and Actions */}
            <div className="flex items-center gap-4">
              <Select
                value={selectedAccountId}
                onChange={handleAccountChange}
                className="w-64"
                options={[
                  { value: '', label: 'All Investment Accounts' },
                  ...cashAccounts.map((account) => ({
                    value: account.id,
                    label: getAccountDisplayName(account),
                  })),
                ]}
              />
              <Button onClick={handleNewTransaction}>
                New Transaction
              </Button>
            </div>
          </div>

          {/* Summary and Allocation Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard summary={portfolioSummary} isLoading={isLoading} />
            <AssetAllocationChart allocation={assetAllocation} isLoading={isLoading} />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <HoldingsList
              holdings={portfolioSummary?.holdings || []}
              isLoading={isLoading}
            />
          </div>

          {/* Recent Transactions */}
          <div>
            <InvestmentTransactionList
              transactions={transactions}
              isLoading={isLoading}
              onDelete={handleDeleteTransaction}
              onEdit={handleEditTransaction}
            />
          </div>
        </div>
      </main>

      {/* Transaction Form Modal */}
      {showTransactionForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div
            className="fixed inset-0 bg-black bg-opacity-50"
            onClick={handleFormCancel}
          />
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-xl w-full p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {editingTransaction ? 'Edit Transaction' : 'New Investment Transaction'}
              </h2>
              <InvestmentTransactionForm
                accounts={accounts}
                transaction={editingTransaction}
                defaultAccountId={getSelectedBrokerageAccountId()}
                onSuccess={handleFormSuccess}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
