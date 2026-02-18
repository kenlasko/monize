'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { InsightsList } from '@/components/insights/InsightsList';

export default function InsightsPage() {
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title="Spending Insights"
            subtitle="AI-powered analysis of your spending patterns and anomalies"
          />
          <div className="max-w-4xl mx-auto">
            <InsightsList />
          </div>
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}
