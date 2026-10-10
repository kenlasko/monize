'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import type { LoanOccurrenceMissing } from '@/types/scheduled-transaction';

/**
 * Why a projected loan occurrence's amount is unknown, in the reader's
 * language, naming the thing that is missing and where it is repaired
 * (`docs/financial-calculation-contract.md` section 1.3). The picker and the
 * override editor say it the same way.
 */
export function useLoanOccurrenceMissingText(): (missing: LoanOccurrenceMissing | null) => string {
  const t = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  return useCallback(
    (missing: LoanOccurrenceMissing | null) => {
      switch (missing?.kind) {
        case 'rate':
          return t('loanOccurrence.missing.rate', { date: formatDate(missing.date) });
        case 'cadence':
          return t('loanOccurrence.missing.cadence', { frequency: missing.frequency });
        case 'override-lines':
          return t('loanOccurrence.missing.overrideLines');
        case 'override-on-settled-debt':
          return t('loanOccurrence.missing.overrideOnSettledDebt');
        case 'earlier-occurrence':
          return t('loanOccurrence.missing.earlierOccurrence', {
            date: formatDate(missing.originalDate),
          });
        default:
          return t('loanOccurrence.missing.unknown');
      }
    },
    [t, formatDate],
  );
}
