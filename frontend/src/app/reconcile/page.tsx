'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';
import { Transaction, ReconciliationData, TransactionStatus } from '@/types/transaction';

type ReconcileStep = 'setup' | 'reconcile' | 'complete';

export default function ReconcilePage() {
  return (
    <ProtectedRoute>
      <ReconcileContent />
    </ProtectedRoute>
  );
}

function ReconcileContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedAccountId = searchParams.get('accountId');

  const [step, setStep] = useState<ReconcileStep>('setup');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(preselectedAccountId || '');
  const [statementDate, setStatementDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [statementBalance, setStatementBalance] = useState<string>('');
  const [reconciliationData, setReconciliationData] = useState<ReconciliationData | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);

  // Load accounts
  useEffect(() => {
    const loadAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        // Filter out investment brokerage accounts
        const filteredAccounts = data.filter(
          (a) => a.accountSubType !== 'INVESTMENT_BROKERAGE' && !a.isClosed
        );
        setAccounts(filteredAccounts);
      } catch (error) {
        toast.error('Failed to load accounts');
      }
    };
    loadAccounts();
  }, []);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const handleStartReconciliation = async () => {
    if (!selectedAccountId || !statementDate || !statementBalance) {
      toast.error('Please fill in all fields');
      return;
    }

    setIsLoading(true);
    try {
      const data = await transactionsApi.getReconciliationData(
        selectedAccountId,
        statementDate,
        parseFloat(statementBalance)
      );
      setReconciliationData(data);

      // Pre-select all cleared transactions
      const clearedIds = new Set(
        data.transactions
          .filter((t) => t.status === TransactionStatus.CLEARED)
          .map((t) => t.id)
      );
      setSelectedTransactionIds(clearedIds);

      setStep('reconcile');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to load reconciliation data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleTransaction = (transactionId: string) => {
    setSelectedTransactionIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(transactionId)) {
        newSet.delete(transactionId);
      } else {
        newSet.add(transactionId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (reconciliationData) {
      setSelectedTransactionIds(new Set(reconciliationData.transactions.map((t) => t.id)));
    }
  };

  const handleSelectNone = () => {
    setSelectedTransactionIds(new Set());
  };

  // Calculate the current difference based on selected transactions
  const calculatedDifference = useMemo(() => {
    if (!reconciliationData) return 0;

    const selectedSum = reconciliationData.transactions
      .filter((t) => selectedTransactionIds.has(t.id))
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const newBalance = reconciliationData.reconciledBalance + selectedSum;
    return parseFloat(statementBalance) - newBalance;
  }, [reconciliationData, selectedTransactionIds, statementBalance]);

  const handleFinishReconciliation = async () => {
    if (Math.abs(calculatedDifference) > 0.01) {
      toast.error('The difference must be $0.00 to finish reconciliation');
      return;
    }

    if (selectedTransactionIds.size === 0) {
      toast.error('No transactions selected for reconciliation');
      return;
    }

    setIsReconciling(true);
    try {
      const result = await transactionsApi.bulkReconcile(
        selectedAccountId,
        Array.from(selectedTransactionIds),
        statementDate
      );
      toast.success(`Successfully reconciled ${result.reconciled} transactions`);
      setStep('complete');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to reconcile transactions');
    } finally {
      setIsReconciling(false);
    }
  };

  const handleCancel = () => {
    setStep('setup');
    setReconciliationData(null);
    setSelectedTransactionIds(new Set());
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: selectedAccount?.currencyCode || 'CAD',
    }).format(amount);
  };

  const renderSetupStep = () => (
    <div className="max-w-xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Start Reconciliation
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Reconcile your account against a bank statement to ensure your records match.
        </p>

        <div className="space-y-4">
          <Select
            label="Account"
            options={[
              { value: '', label: 'Select account...' },
              ...accounts.map((a) => ({
                value: a.id,
                label: `${a.name} (${formatCurrency(a.currentBalance)})`,
              })),
            ]}
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
          />

          <Input
            label="Statement Date"
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
          />

          <Input
            label="Statement Ending Balance"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
          />
        </div>

        <div className="flex justify-between mt-6">
          <Button variant="outline" onClick={() => router.push('/accounts')}>
            Cancel
          </Button>
          <Button
            onClick={handleStartReconciliation}
            isLoading={isLoading}
            disabled={!selectedAccountId || !statementDate || !statementBalance}
          >
            Start Reconciliation
          </Button>
        </div>
      </div>
    </div>
  );

  const renderReconcileStep = () => {
    if (!reconciliationData) return null;

    const selectedCount = selectedTransactionIds.size;
    const totalCount = reconciliationData.transactions.length;

    return (
      <div className="px-4 sm:px-6 lg:px-12">
        {/* Summary Bar */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Statement Balance</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(parseFloat(statementBalance))}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Reconciled Balance</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(reconciliationData.reconciledBalance)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Selected ({selectedCount})</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(
                  reconciliationData.transactions
                    .filter((t) => selectedTransactionIds.has(t.id))
                    .reduce((sum, t) => sum + Number(t.amount), 0)
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">Difference</p>
              <p
                className={`text-lg font-semibold ${
                  Math.abs(calculatedDifference) < 0.01
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {formatCurrency(calculatedDifference)}
              </p>
            </div>
          </div>
        </div>

        {/* Transaction List */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Unreconciled Transactions ({totalCount})
            </h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectAll}>
                Select All
              </Button>
              <Button variant="outline" size="sm" onClick={handleSelectNone}>
                Select None
              </Button>
            </div>
          </div>

          {totalCount === 0 ? (
            <div className="p-6 text-center text-gray-500 dark:text-gray-400">
              No unreconciled transactions found for this period.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-10">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Payee
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Category
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {reconciliationData.transactions.map((transaction) => (
                    <tr
                      key={transaction.id}
                      className={`cursor-pointer transition-colors ${
                        selectedTransactionIds.has(transaction.id)
                          ? 'bg-blue-50 dark:bg-blue-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                      }`}
                      onClick={() => handleToggleTransaction(transaction.id)}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedTransactionIds.has(transaction.id)}
                          onChange={() => handleToggleTransaction(transaction.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {format(new Date(transaction.transactionDate), 'MMM d, yyyy')}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                        {transaction.payee?.name || transaction.payeeName || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {transaction.category?.name || '-'}
                      </td>
                      <td
                        className={`px-4 py-3 text-sm text-right whitespace-nowrap font-medium ${
                          Number(transaction.amount) >= 0
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {formatCurrency(Number(transaction.amount))}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {transaction.status === TransactionStatus.CLEARED ? (
                          <span className="text-blue-600 dark:text-blue-400" title="Cleared">C</span>
                        ) : transaction.status === TransactionStatus.UNRECONCILED ? (
                          <span className="text-gray-400" title="Unreconciled">-</span>
                        ) : transaction.status === TransactionStatus.VOID ? (
                          <span className="text-gray-400 line-through" title="Void">V</span>
                        ) : (
                          <span className="text-green-600 dark:text-green-400" title="Reconciled">R</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-between">
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              onClick={handleFinishReconciliation}
              isLoading={isReconciling}
              disabled={Math.abs(calculatedDifference) > 0.01 || selectedTransactionIds.size === 0}
            >
              Finish Reconciliation
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderCompleteStep = () => (
    <div className="max-w-xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 text-center">
        <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 mb-4">
          <svg
            className="h-6 w-6 text-green-600 dark:text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Reconciliation Complete
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Your account has been successfully reconciled as of{' '}
          {format(new Date(statementDate), 'MMMM d, yyyy')}.
        </p>
        <div className="flex justify-center space-x-4">
          <Button variant="outline" onClick={() => router.push('/accounts')}>
            Back to Accounts
          </Button>
          <Button
            onClick={() => {
              setStep('setup');
              setReconciliationData(null);
              setSelectedTransactionIds(new Set());
              setStatementBalance('');
            }}
          >
            Reconcile Another Account
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
      <AppHeader />

      <main className="px-4 sm:px-6 lg:px-12 py-6">
        <div className="px-4 sm:px-0">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Reconcile Account
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              {selectedAccount
                ? `Reconciling: ${selectedAccount.name}`
                : 'Match your records against your bank statement'}
            </p>
          </div>

          {step === 'setup' && renderSetupStep()}
          {step === 'reconcile' && renderReconcileStep()}
          {step === 'complete' && renderCompleteStep()}
        </div>
      </main>
    </div>
  );
}
