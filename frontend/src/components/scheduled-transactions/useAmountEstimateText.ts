'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { ScheduleAmountEstimate } from '@/types/scheduled-transaction';

/** What the estimate is matched on, as the reader knows them. */
export interface AmountEstimateSubject {
  payeeName: string | null;
  categoryName: string | null;
}

/**
 * Where a schedule's estimated amount comes from or, when it is unknown, the
 * exact thing that is missing and what to do about it
 * (docs/specs/scheduled-amount-estimate.md section 5,
 * `docs/financial-calculation-contract.md` section 1.3). The form, the
 * occurrence editor, the Post dialog and the forecast say it the same way.
 *
 * `null` is an estimate not read yet (a new schedule before its payee and
 * category are chosen): the reader is told it is worked out on save.
 */
export function useAmountEstimateText(): (
  estimate: ScheduleAmountEstimate | null | undefined,
  subject: AmountEstimateSubject,
) => string {
  const t = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  const { formatPercent } = useNumberFormat();
  return useCallback(
    (estimate, subject) => {
      const payee = subject.payeeName ?? t('estimate.thePayee');
      const category = subject.categoryName ?? t('estimate.theCategory');
      switch (estimate?.status) {
        case 'estimated':
          return estimate.growthRate !== null && estimate.growthRate !== 0
            ? t('estimate.basisWithGrowth', {
                count: estimate.paymentCount,
                date: estimate.latestPaymentDate ? formatDate(estimate.latestPaymentDate) : '',
                growth: formatPercent(estimate.growthRate * 100, 1),
              })
            : t('estimate.basis', {
                count: estimate.paymentCount,
                date: estimate.latestPaymentDate ? formatDate(estimate.latestPaymentDate) : '',
              });
        case 'no-history':
          return t('estimate.noHistory', {
            payee,
            category,
            months: estimate.historyMonths,
          });
        case 'missing-rate':
          return t('estimate.missingRate', {
            from: estimate.missingPair?.from ?? '',
            to: estimate.missingPair?.to ?? '',
          });
        case 'no-basis':
          return t('estimate.noBasis');
        default:
          return t('estimate.pending');
      }
    },
    [t, formatDate, formatPercent],
  );
}
