'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { BudgetWizard } from '@/components/budgets/BudgetWizard';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { accountsApi } from '@/lib/accounts';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import type { Account } from '@/types/account';

export default function BudgetCreatePage() {
  return (
    <ProtectedRoute>
      <BudgetCreateContent />
    </ProtectedRoute>
  );
}

function BudgetCreateContent() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { defaultCurrency } = useExchangeRates();
  const router = useRouter();

  useEffect(() => {
    accountsApi.getAll().then(setAccounts).catch(() => {});
  }, []);

  return (
    <PageLayout>
      <main className="px-0 sm:px-6 lg:px-12 pt-2 sm:pt-6 pb-8">
        <div className="px-2 sm:px-0">
          <PageHeader
            title="Create Budget"
            subtitle="Analyze your spending and create a personalized budget"
          />
        </div>
        <div className="bg-white dark:bg-gray-800 sm:shadow sm:rounded-lg p-0 sm:p-6">
          <BudgetWizard
            onComplete={() => router.push('/budgets')}
            onCancel={() => router.push('/budgets')}
            defaultCurrency={defaultCurrency}
            accounts={accounts}
          />
        </div>
      </main>
    </PageLayout>
  );
}
