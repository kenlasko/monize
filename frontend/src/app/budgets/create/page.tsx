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
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Create Budget"
          subtitle="Analyze your spending and create a personalized budget"
        />
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
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
