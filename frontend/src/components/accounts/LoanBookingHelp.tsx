'use client';

import { useTranslations } from 'next-intl';

/**
 * Collapsible guidance on how to record loan payments so the loan account,
 * expense reports, and rate detection all stay correct: principal as an
 * uncategorized transfer to the loan, interest as a categorized expense.
 */
export function LoanBookingHelp() {
  const t = useTranslations('accounts');
  const b = (key: string) => t(`mortgageFields.bookingHelp.${key}`);

  return (
    <details className="mt-3 rounded-md border border-blue-200 dark:border-blue-900/50 bg-blue-50/60 dark:bg-blue-900/20 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-blue-800 dark:text-blue-200">
        {b('title')}
      </summary>
      <div className="mt-2 space-y-2 text-gray-600 dark:text-gray-300">
        <p>{b('intro')}</p>
        <p>
          <span className="font-medium text-gray-800 dark:text-gray-100">
            {b('principalTitle')}
          </span>{' '}
          {b('principalBody')}
        </p>
        <p>
          <span className="font-medium text-gray-800 dark:text-gray-100">
            {b('interestTitle')}
          </span>{' '}
          {b('interestBody')}
        </p>
        <p>{b('avoid')}</p>
        <p>{b('overpayments')}</p>
        <p className="italic text-gray-500 dark:text-gray-400">{b('tip')}</p>
      </div>
    </details>
  );
}
