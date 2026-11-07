'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { buttonClassName } from '@/components/ui/Button';
import { InvestmentReportForm } from '@/components/reports/InvestmentReportForm';
import { investmentReportsApi } from '@/lib/investment-reports';
import { getErrorMessage } from '@/lib/errors';
import { CreateInvestmentReportData } from '@/types/investment-report';

export default function NewInvestmentReportPage() {
  return (
    <ProtectedRoute>
      <NewInvestmentReportContent />
    </ProtectedRoute>
  );
}

function NewInvestmentReportContent() {
  const t = useTranslations('reports');
  const router = useRouter();

  const handleSubmit = async (data: CreateInvestmentReportData) => {
    try {
      const report = await investmentReportsApi.create(data);
      toast.success(t('investmentPages.createSuccess'));
      router.push(`/reports/investment/${report.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, t('investmentPages.createError')));
      throw error;
    }
  };

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('investmentPages.createTitle')}
          subtitle={t('investmentPages.createSubtitle')}
          help="reports"
          actions={
            <Link href="/reports" className={buttonClassName('outline')}>
              {t('detailHeader.backToReports')}
            </Link>
          }
        />

        <InvestmentReportForm
          onSubmit={handleSubmit}
          onCancel={() => router.push('/reports')}
        />
      </main>
    </PageLayout>
  );
}
