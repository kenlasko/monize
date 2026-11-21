'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';

/**
 * The way back to the Reports list, above the title -- the same control the
 * account, payee, category and security detail pages put there. It is a real
 * link rather than a history-back button, so the destination is the list
 * whatever route the reader arrived from, and middle-click still works.
 *
 * Every report surface uses this one; a hand-rolled second one is what
 * `ui-conventions.test.ts` scans for.
 */
export function BackToReportsLink() {
  const t = useTranslations('reports');

  return (
    <Link
      href="/reports"
      className="ui-detail-back mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
    >
      <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
      {t('detailHeader.backToReports')}
    </Link>
  );
}
