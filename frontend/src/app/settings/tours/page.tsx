'use client';

import { BackToSettingsLink } from '@/components/settings/BackToSettingsLink';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { TourCatalog } from '@/components/settings/TourCatalog';

export default function ToursSettingsPage() {
  return (
    <ProtectedRoute>
      <ToursSettingsContent />
    </ProtectedRoute>
  );
}

function ToursSettingsContent() {
  const t = useTranslations('tours');

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <BackToSettingsLink label={t('settings.backLink')} />

        <PageHeader
          title={t('settings.pageTitle')}
          subtitle={t('settings.pageSubtitle')}
          help="tourSettings"
        />

        <TourCatalog />
      </main>
    </PageLayout>
  );
}
