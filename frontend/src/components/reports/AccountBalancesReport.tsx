'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';

type AccountTypeFilter = 'all' | 'assets' | 'liabilities';

const accountTypeLabels: Record<string, string> = {
  CHEQUING: 'Chequing',
  SAVINGS: 'Savings',
  CREDIT_CARD: 'Credit Card',
  LINE_OF_CREDIT: 'Line of Credit',
  LOAN: 'Loan',
  MORTGAGE: 'Mortgage',
  INVESTMENT: 'Investment',
  RRSP: 'RRSP',
  TFSA: 'TFSA',
  RESP: 'RESP',
  CASH: 'Cash',
  OTHER: 'Other',
};

export function AccountBalancesReport() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<AccountTypeFilter>('all');
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const data = await accountsApi.getAll();
        setAccounts(data);
      } catch (error) {
        console.error('Failed to load accounts:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (!showClosed && acc.isClosed) return false;

      const balance = Number(acc.currentBalance) || 0;
      if (typeFilter === 'assets' && balance < 0) return false;
      if (typeFilter === 'liabilities' && balance >= 0) return false;

      return true;
    });
  }, [accounts, typeFilter, showClosed]);

  const groupedAccounts = useMemo(() => {
    const groups = new Map<string, Account[]>();

    filteredAccounts.forEach((acc) => {
      const type = acc.accountType || 'OTHER';
      if (!groups.has(type)) {
        groups.set(type, []);
      }
      groups.get(type)!.push(acc);
    });

    // Sort accounts within each group by balance
    groups.forEach((accs) => {
      accs.sort((a, b) => Math.abs(Number(b.currentBalance)) - Math.abs(Number(a.currentBalance)));
    });

    return groups;
  }, [filteredAccounts]);

  const totals = useMemo(() => {
    let assets = 0;
    let liabilities = 0;

    filteredAccounts.forEach((acc) => {
      const balance = Number(acc.currentBalance) || 0;
      if (balance >= 0) {
        assets += balance;
      } else {
        liabilities += Math.abs(balance);
      }
    });

    return { assets, liabilities, netWorth: assets - liabilities };
  }, [filteredAccounts]);

  const formatCurrency = (value: number, currency: string = 'CAD') => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const handleAccountClick = (accountId: string) => {
    router.push(`/transactions?accountId=${accountId}`);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-gray-200 dark:bg-gray-700 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Assets</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(totals.assets)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Liabilities</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(totals.liabilities)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Net Worth</div>
          <div className={`text-2xl font-bold ${
            totals.netWorth >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'
          }`}>
            {formatCurrency(totals.netWorth)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {(['all', 'assets', 'liabilities'] as AccountTypeFilter[]).map((filter) => (
              <button
                key={filter}
                onClick={() => setTypeFilter(filter)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                  typeFilter === filter
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Show closed accounts
          </label>
        </div>
      </div>

      {/* Account Groups */}
      {Array.from(groupedAccounts.entries()).map(([type, accs]) => {
        const groupTotal = accs.reduce((sum, acc) => sum + (Number(acc.currentBalance) || 0), 0);

        return (
          <div key={type} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {accountTypeLabels[type] || type}
              </h3>
              <span className={`font-semibold ${
                groupTotal >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              }`}>
                {formatCurrency(groupTotal)}
              </span>
            </div>
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {accs.map((acc) => {
                const balance = Number(acc.currentBalance) || 0;
                return (
                  <button
                    key={acc.id}
                    onClick={() => handleAccountClick(acc.id)}
                    className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                  >
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                        {acc.name}
                        {acc.isClosed && (
                          <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded">
                            Closed
                          </span>
                        )}
                      </div>
                      {acc.description && (
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {acc.description}
                        </div>
                      )}
                    </div>
                    <div className={`font-semibold ${
                      balance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatCurrency(balance, acc.currencyCode)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {filteredAccounts.length === 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">No accounts found.</p>
        </div>
      )}
    </div>
  );
}
