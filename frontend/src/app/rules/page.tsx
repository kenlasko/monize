'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { CreateRuleLink, NEW_RULE_HREF, RulesManager } from '@/components/rules/RulesManager';
import { useMobileAddAction } from '@/store/mobileAddActionStore';

export default function RulesPage() {
  return (
    <ProtectedRoute>
      <RulesContent />
    </ProtectedRoute>
  );
}

function RulesContent() {
  const t = useTranslations('rules');
  const router = useRouter();
  useMobileAddAction(t('page.createButton'), () => router.push(NEW_RULE_HREF));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          help='rules'
          actions={<CreateRuleLink label={t('page.createButton')} anchor={tourAnchor(TOUR_ANCHORS.rulesCreateButton)} />}
        />
        <RulesManager />
      </main>
    </PageLayout>
  );
}
