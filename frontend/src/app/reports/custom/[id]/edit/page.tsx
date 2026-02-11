'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { CustomReportForm } from '@/components/reports/CustomReportForm';
import { customReportsApi } from '@/lib/custom-reports';
import { CustomReport, CreateCustomReportData } from '@/types/custom-report';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('ReportEdit');

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function EditCustomReportPage({ params }: PageProps) {
  const { id } = use(params);

  return (
    <ProtectedRoute>
      <EditCustomReportContent reportId={id} />
    </ProtectedRoute>
  );
}

function EditCustomReportContent({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [report, setReport] = useState<CustomReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    const loadReport = async () => {
      try {
        const data = await customReportsApi.getById(reportId);
        setReport(data);
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to load report'));
        router.push('/reports');
      } finally {
        setIsLoading(false);
      }
    };
    loadReport();
  }, [reportId, router]);

  const handleSubmit = async (data: CreateCustomReportData) => {
    try {
      await customReportsApi.update(reportId, data);
      toast.success('Report updated');
      router.push(`/reports/custom/${reportId}`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update report'));
      throw error;
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await customReportsApi.delete(reportId);
      toast.success('Report deleted successfully');
      router.push('/reports');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete report'));
      logger.error(error);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  if (isLoading) {
    return (
      <PageLayout>
        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-12 py-8">
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        </main>
      </PageLayout>
    );
  }

  if (!report) {
    return null;
  }

  return (
    <PageLayout>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-12 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Edit Report
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              Modify your custom report configuration
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
          >
            Delete Report
          </Button>
        </div>

        <CustomReportForm
          report={report}
          onSubmit={handleSubmit}
          onCancel={() => router.push(`/reports/custom/${reportId}`)}
        />
      </main>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} maxWidth="md" className="p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          Delete Report
        </h3>
        <p className="text-gray-500 dark:text-gray-400 mb-6">
          Are you sure you want to delete &quot;{report?.name}&quot;? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            disabled={isDeleting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </PageLayout>
  );
}
