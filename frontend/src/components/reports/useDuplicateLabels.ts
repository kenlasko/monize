'use client';

import { useTranslations } from 'next-intl';
import type {
  DuplicateConfidence,
  DuplicateGroup,
  DuplicateTransactionItem,
} from '@/types/built-in-reports';

const CONFIDENCE_LABEL_KEYS: Readonly<Record<DuplicateConfidence, string>> = {
  very_high: 'confidenceVeryHigh',
  high: 'confidenceHigh',
  medium: 'confidenceMedium',
  low: 'confidenceLow',
};

const REASON_LABEL_KEYS: Readonly<Record<DuplicateGroup['reasonCode'], string>> = {
  same_date_amount_payee_category: 'reasonSameDateAmountPayeeCategory',
  same_date_amount_payee: 'reasonSameDateAmountPayee',
  same_date_amount: 'reasonSameDateAmount',
  same_payee_amount_within_days: 'reasonSamePayeeAmountWithinDays',
  same_amount_within_days: 'reasonSameAmountWithinDays',
};

/**
 * The Duplicate Transaction Finder's translated labels, shared by the cards
 * on screen and the CSV/PDF export so the two never word a group differently.
 * The server's English `reason` is the fallback for a code this build does not
 * know.
 */
export function useDuplicateLabels() {
  const t = useTranslations('reports');

  const confidenceLabel = (level: DuplicateConfidence) =>
    t(`duplicateTransactions.${CONFIDENCE_LABEL_KEYS[level]}`);

  const reasonLabel = (group: DuplicateGroup) => {
    const key = REASON_LABEL_KEYS[group.reasonCode];
    return key ? t(`duplicateTransactions.${key}`, { days: group.windowDays }) : group.reason;
  };

  const categoryLabel = (tx: DuplicateTransactionItem) => {
    if (tx.isSplit) return t('duplicateTransactions.splitCategory');
    return tx.categoryName ?? t('duplicateTransactions.uncategorized');
  };

  return { confidenceLabel, reasonLabel, categoryLabel };
}
