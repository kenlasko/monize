'use client';

import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { CreateRuleLink, RulesManager } from '@/components/rules/RulesManager';
import { docsUrl } from '@/lib/docs-links';

export default function RulesPage() {
  return (
    <ProtectedRoute>
      <RulesContent />
    </ProtectedRoute>
  );
}

function RulesContent() {
  const t = useTranslations('rules');

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('rules')}
          actions={<CreateRuleLink label={t('page.createButton')} anchor={tourAnchor(TOUR_ANCHORS.rulesCreateButton)} />}
        />
        <RulesManager />
      </main>
    </PageLayout>
  );
}
