'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { EmailReceiptsHub } from '@/components/email-receipts/EmailReceiptsHub';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { docsUrl } from '@/lib/docs-links';

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
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          helpUrl={docsUrl('emailReceipts')}
        />
        {/* The hub reads `?tab=` and `?domain=`, which needs a Suspense boundary above it. */}
        <Suspense fallback={null}>
          <EmailReceiptsHub />
        </Suspense>
      </main>
    </PageLayout>
  );
}
