'use client';

import Link from 'next/link';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';

/**
 * The way back to the Settings page from one of its sub-pages, above the
 * `PageHeader`: the chevron + "Back to <List>" control the detail pages and
 * `BackToReportsLink` put there (docs/frontend/ui-conventions.md, "A detail
 * page returns to its list above the title"). The caller passes its own
 * translated label so each page keeps its catalog key.
 */
export function BackToSettingsLink({ label }: { label: string }) {
  return (
    <Link
      href="/settings"
      className="ui-detail-back mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
