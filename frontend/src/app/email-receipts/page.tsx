'use client';

import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { EmailReceiptsManager } from '@/components/email-receipts/EmailReceiptsManager';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';

export default function EmailReceiptsPage() {
  return (
    <ProtectedRoute>
      <EmailReceiptsContent />
    </ProtectedRoute>
  );
}

function EmailReceiptsContent() {
  const t = useTranslations('emailReceipts.page');

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmailReceiptsManager />
      </main>
    </PageLayout>
  );
}
