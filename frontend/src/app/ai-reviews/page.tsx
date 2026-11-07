'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { AiReviewInbox } from '@/components/ai-review/AiReviewInbox';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';

export default function AiReviewsPage() {
  return (
    <ProtectedRoute>
      <AiReviewsContent />
    </ProtectedRoute>
  );
}

function AiReviewsContent() {
  const t = useTranslations('aiReview');

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} help="aiReviewInbox" />
        {/* The inbox reads ?kind= through useSearchParams, which needs a Suspense boundary. */}
        <Suspense fallback={null}>
          <AiReviewInbox />
        </Suspense>
      </main>
    </PageLayout>
  );
}
