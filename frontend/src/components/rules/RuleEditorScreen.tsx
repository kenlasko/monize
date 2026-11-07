'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { RuleEditor } from '@/components/rules/RuleEditor';

/**
 * The editor page shell, shared by `/rules/new` and `/rules/<id>`: the way
 * back above the title (as every detail page has it), the header, the editor.
 */
export function RuleEditorScreen({ ruleId }: { ruleId?: string }) {
  const t = useTranslations('rules.editor.page');

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <Link
          href="/rules"
          className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          {t('backToRules')}
        </Link>
        <PageHeader title={ruleId ? t('editTitle') : t('newTitle')} subtitle={t('subtitle')} help="rules" />
        <div className="mt-6">
          <RuleEditor ruleId={ruleId} />
        </div>
      </main>
    </PageLayout>
  );
}
