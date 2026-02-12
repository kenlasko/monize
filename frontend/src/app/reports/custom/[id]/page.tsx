'use client';

import { use } from 'react';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { CustomReportViewer } from '@/components/reports/CustomReportViewer';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function ViewCustomReportPage({ params }: PageProps) {
  const { id } = use(params);

  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-8">
          <CustomReportViewer reportId={id} />
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}
