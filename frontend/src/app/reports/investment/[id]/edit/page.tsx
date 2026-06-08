'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { InvestmentReportForm } from '@/components/reports/InvestmentReportForm';
import { investmentReportsApi } from '@/lib/investment-reports';
import { InvestmentReport, CreateInvestmentReportData } from '@/types/investment-report';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('InvestmentReportEdit');

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function EditInvestmentReportPage({ params }: PageProps) {
  const { id } = use(params);

  return (
    <ProtectedRoute>
      <EditInvestmentReportContent reportId={id} />
    </ProtectedRoute>
  );
}

function EditInvestmentReportContent({ reportId }: { reportId: string }) {
  const router = useRouter();
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const [report, setReport] = useState<InvestmentReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    const loadReport = async () => {
      try {
        const data = await investmentReportsApi.getById(reportId);
        setReport(data);
      } catch (error) {
        toast.error(getErrorMessage(error, t('editReport.toasts.loadFailed')));
        router.push('/reports');
      } finally {
        setIsLoading(false);
      }
    };
    loadReport();
  }, [reportId, router, t]);

  const handleSubmit = async (data: CreateInvestmentReportData) => {
    try {
      await investmentReportsApi.update(reportId, data);
      toast.success(t('editReport.toasts.updated'));
      router.push(`/reports/investment/${reportId}`);
    } catch (error) {
      toast.error(getErrorMessage(error, t('editReport.toasts.updateFailed')));
      throw error;
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await investmentReportsApi.delete(reportId);
      toast.success(t('editReport.toasts.deleted'));
      router.push('/reports');
    } catch (error) {
      toast.error(getErrorMessage(error, t('editReport.toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  if (isLoading) {
    return (
      <PageLayout>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
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
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('editReport.titleInvestment')}
          subtitle={t('editReport.subtitleInvestment')}
          actions={
            <div className="flex items-center gap-3 w-full justify-between sm:w-auto sm:justify-end">
              <Link href="/reports" className="order-1 sm:order-2">
                <Button variant="outline">{t('editReport.backToReports')}</Button>
              </Link>
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(true)}
                className="order-2 sm:order-1 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
              >
                {t('editReport.deleteButton')}
              </Button>
            </div>
          }
        />

        <InvestmentReportForm
          report={report}
          onSubmit={handleSubmit}
          onCancel={() => router.push(`/reports/investment/${reportId}`)}
        />
      </main>

      <Modal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        maxWidth="md"
        className="p-6"
      >
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          {t('editReport.deleteButton')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400 mb-6">
          {t('editReport.deleteConfirmMessage', { name: report?.name ?? '' })}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={handleDelete}
            disabled={isDeleting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {isDeleting ? t('editReport.deleting') : tc('delete')}
          </Button>
        </div>
      </Modal>
    </PageLayout>
  );
}
