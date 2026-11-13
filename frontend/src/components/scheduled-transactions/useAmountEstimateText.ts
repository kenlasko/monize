'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { estimateEntryOn } from '@/lib/scheduled-effective-amount';
import type { ScheduleAmountEstimate, ScheduledTransaction } from '@/types/scheduled-transaction';

/**
 * What the estimate is matched on, as the reader knows them: a transaction's
 * payee and category, or a transfer's destination (issue #2164), which
 * `transferAccountName` being present marks.
 */
export interface AmountEstimateSubject {
  payeeName: string | null;
  categoryName: string | null;
  /** Set (a name or `null`) exactly for a transfer. */
  transferAccountName?: string | null;
}

/** The subject of `st`'s estimate: the one place a schedule becomes one. */
export function estimateSubjectOf(st: ScheduledTransaction): AmountEstimateSubject {
  return {
    payeeName: st.payee?.name ?? st.payeeName,
    categoryName: st.category?.name ?? null,
    ...(st.isTransfer ? { transferAccountName: st.transferAccount?.name ?? null } : {}),
  };
}

/**
 * Where a schedule's estimated amount comes from or, when it is unknown, the
 * exact thing that is missing and what to do about it
 * (docs/specs/scheduled-amount-estimate.md section 5,
 * `docs/financial-calculation-contract.md` section 1.3). The form, the
 * occurrence editor, the Post dialog and the forecast say it the same way.
 *
 * Given the `dueDate` of the occurrence being shown, it also says when what a
 * transfer's destination owes raised that occurrence above the history
 * (section 10).
 *
 * `null` is an estimate not read yet (a new schedule before its payee and
 * category are chosen): the reader is told it is worked out on save.
 */
export function useAmountEstimateText(): (
  estimate: ScheduleAmountEstimate | null | undefined,
  subject: AmountEstimateSubject,
  dueDate?: string,
) => string {
  const t = useTranslations('scheduledTransactions');
  const { formatDate } = useDateFormat();
  const { formatPercent } = useNumberFormat();
  return useCallback(
    (estimate, subject, dueDate) => {
      const isTransfer = subject.transferAccountName !== undefined;
      const account = subject.transferAccountName ?? t('estimate.theAccount');
      const payee = subject.payeeName ?? t('estimate.thePayee');
      const category = subject.categoryName ?? t('estimate.theCategory');
      switch (estimate?.status) {
        case 'estimated': {
          const raised =
            dueDate !== undefined && estimateEntryOn(estimate, dueDate)?.basis === 'balance'
              ? t('estimate.raisedToBalance', { account })
              : null;
          const basis =
            estimate.paymentCount === null
              ? isTransfer
                ? t('estimate.basisWithheldTransfer', { account })
                : t('estimate.basisWithheld')
              : estimate.growthRate !== null && estimate.growthRate !== 0
                ? t('estimate.basisWithGrowth', {
                    count: estimate.paymentCount,
                    date: estimate.latestPaymentDate ? formatDate(estimate.latestPaymentDate) : '',
                    growth: formatPercent(estimate.growthRate * 100, 1),
                  })
                : t('estimate.basis', {
                    count: estimate.paymentCount,
                    date: estimate.latestPaymentDate ? formatDate(estimate.latestPaymentDate) : '',
                  });
          return raised ? t('estimate.basisAndRaise', { basis, raised }) : basis;
        }
        case 'no-history':
          return isTransfer
            ? t('estimate.noHistoryTransfer', { account, months: estimate.historyMonths })
            : t('estimate.noHistory', {
                payee,
                category,
                months: estimate.historyMonths,
              });
        case 'missing-rate':
          return t(isTransfer ? 'estimate.missingRateTransfer' : 'estimate.missingRate', {
            from: estimate.missingPair?.from ?? '',
            to: estimate.missingPair?.to ?? '',
            account,
          });
        case 'no-basis':
          return t(isTransfer ? 'estimate.noBasisTransfer' : 'estimate.noBasis');
        default:
          return t(isTransfer ? 'estimate.pendingTransfer' : 'estimate.pending');
      }
    },
    [t, formatDate, formatPercent],
  );
}
