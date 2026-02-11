'use client';

import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { CustomReportForm } from '@/components/reports/CustomReportForm';
import { customReportsApi } from '@/lib/custom-reports';
import { getErrorMessage } from '@/lib/errors';
import { CreateCustomReportData } from '@/types/custom-report';

export default function NewCustomReportPage() {
  return (
    <ProtectedRoute>
      <NewCustomReportContent />
    </ProtectedRoute>
  );
}

function NewCustomReportContent() {
  const router = useRouter();

  const handleSubmit = async (data: CreateCustomReportData) => {
    try {
      const report = await customReportsApi.create(data);
      toast.success('Report created');
      router.push(`/reports/custom/${report.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create report'));
      throw error;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Create Custom Report
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Define how you want to view and analyze your financial data
          </p>
        </div>

        <CustomReportForm
          onSubmit={handleSubmit}
          onCancel={() => router.push('/reports/custom')}
        />
      </main>
    </div>
  );
}
