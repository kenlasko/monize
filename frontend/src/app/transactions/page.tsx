'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList } from '@/components/transactions/TransactionList';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';

export default function TransactionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | undefined>();

  // Filters - initialize from URL params
  const [filterAccountId, setFilterAccountId] = useState<string>(searchParams.get('accountId') || '');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [transactionsData, accountsData] = await Promise.all([
        transactionsApi.getAll({
          accountId: filterAccountId || undefined,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
        }),
        accountsApi.getAll(),
      ]);

      setTransactions(transactionsData);
      setAccounts(accountsData);
    } catch (error) {
      toast.error('Failed to load transactions');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [filterAccountId, filterStartDate, filterEndDate]);

  const handleCreateNew = () => {
    setEditingTransaction(undefined);
    setShowForm(true);
  };

  const handleEdit = (transaction: Transaction) => {
    setEditingTransaction(transaction);
    setShowForm(true);
  };

  const [formKey, setFormKey] = useState(0);

  const handleFormSuccess = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
    setFormKey(prev => prev + 1); // Force form re-creation on next open
    loadData();
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
  };

  const calculateSummary = () => {
    const income = transactions
      .filter(t => Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const expenses = transactions
      .filter(t => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    return { income, expenses, net: income - expenses };
  };

  const summary = calculateSummary();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Transactions</h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage your income and expenses
              </p>
            </div>
            <Button onClick={handleCreateNew}>
              + New Transaction
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Income</dt>
                    <dd className="text-lg font-semibold text-green-600">
                      ${summary.income.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Expenses</dt>
                    <dd className="text-lg font-semibold text-red-600">
                      ${summary.expenses.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Net Cash Flow</dt>
                    <dd className={`text-lg font-semibold ${summary.net >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      ${summary.net.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Form Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">
                {editingTransaction ? 'Edit Transaction' : 'New Transaction'}
              </h2>
              <TransactionForm
                key={`${editingTransaction?.id || 'new'}-${filterAccountId}-${formKey}`}
                transaction={editingTransaction}
                defaultAccountId={filterAccountId}
                onSuccess={handleFormSuccess}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white shadow rounded-lg p-6 mb-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Filters</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select
              label="Account"
              options={[
                { value: '', label: 'All accounts' },
                ...accounts.map(account => ({
                  value: account.id,
                  label: account.name,
                })),
              ]}
              value={filterAccountId}
              onChange={(e) => setFilterAccountId(e.target.value)}
            />

            <Input
              label="Start Date"
              type="date"
              value={filterStartDate}
              onChange={(e) => setFilterStartDate(e.target.value)}
            />

            <Input
              label="End Date"
              type="date"
              value={filterEndDate}
              onChange={(e) => setFilterEndDate(e.target.value)}
            />
          </div>

          {(filterAccountId || filterStartDate || filterEndDate) && (
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilterAccountId('');
                  setFilterStartDate('');
                  setFilterEndDate('');
                }}
              >
                Clear Filters
              </Button>
            </div>
          )}
        </div>

        {/* Transactions List */}
        <div className="bg-white shadow rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="mt-2 text-gray-500">Loading transactions...</p>
            </div>
          ) : (
            <TransactionList
              transactions={transactions}
              onEdit={handleEdit}
              onRefresh={loadData}
            />
          )}
        </div>
      </div>
    </div>
  );
}
