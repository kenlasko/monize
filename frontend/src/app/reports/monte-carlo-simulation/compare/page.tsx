'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { buttonClassName } from '@/components/ui/Button';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { CompareScenariosView } from '@/components/reports/monte-carlo/CompareScenariosView';

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ComparePageContent() {
  const t = useTranslations('reports');
  const searchParams = useSearchParams();
  const ids = parseIds(searchParams.get('ids'));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('monteCarloComparePage.title')}
          subtitle={t('monteCarloComparePage.subtitle')}
          help="reports"
          actions={
            <Link href="/reports/monte-carlo-simulation" className={buttonClassName('outline')}>
              {t('monteCarloComparePage.backToMonteCarlo')}
            </Link>
          }
        />
        <CompareScenariosView ids={ids} />
      </main>
    </PageLayout>
  );
}

export default function CompareScenariosPage() {
  return (
    <ProtectedRoute>
      <ComparePageContent />
    </ProtectedRoute>
  );
}
