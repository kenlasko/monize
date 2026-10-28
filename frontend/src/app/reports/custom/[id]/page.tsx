'use client';

import { ReportingBasisScope, ReportingBasisControl } from '@/components/reports/ReportingBasis';
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
      <ReportingBasisScope surface={`custom:${id}`}>
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-8 pt-6 pb-8">
          <ReportingBasisControl />
          <CustomReportViewer reportId={id} />
        </main>
      </PageLayout>
      </ReportingBasisScope>
    </ProtectedRoute>
  );
}
