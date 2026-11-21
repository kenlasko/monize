'use client';

import Link from 'next/link';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';

interface BudgetBackLinkProps {
  href: string;
  /** Already translated: "Back to Budgets", "Back to <budget name>". */
  label: string;
}

/**
 * The way back on a budget page, on the line above the title -- the same
 * control the security, payee, category and report pages put there. A real
 * link rather than a history-back button, so the destination is the same
 * whatever route the reader arrived from, and middle-click still works.
 */
export function BudgetBackLink({ href, label }: BudgetBackLinkProps) {
  return (
    <Link
      href={href}
      className="ui-detail-back mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-200"
    >
      <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
