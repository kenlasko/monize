'use client';

import { use } from 'react';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { CustomReportViewer } from '@/components/reports/CustomReportViewer';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function ViewCustomReportPage({ params }: PageProps) {
  const { id } = use(params);

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AppHeader />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <CustomReportViewer reportId={id} />
        </main>
      </div>
    </ProtectedRoute>
  );
}
