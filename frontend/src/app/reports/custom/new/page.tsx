'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { buttonClassName } from '@/components/ui/Button';
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
  const t = useTranslations('reports');
  const router = useRouter();

  const handleSubmit = async (data: CreateCustomReportData) => {
    try {
      const report = await customReportsApi.create(data);
      toast.success(t('customPages.createSuccess'));
      router.push(`/reports/custom/${report.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, t('customPages.createError')));
      throw error;
    }
  };

  return (
    <PageLayout>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('customPages.createTitle')}
          subtitle={t('customPages.createSubtitle')}
          help="reports"
          actions={
            <Link href="/reports" className={buttonClassName('outline')}>
              {t('detailHeader.backToReports')}
            </Link>
          }
        />

        <CustomReportForm
          onSubmit={handleSubmit}
          onCancel={() => router.push('/reports/custom')}
        />
      </main>
    </PageLayout>
  );
}
