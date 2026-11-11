'use client';

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { describeCustomRecurrence } from '@/lib/custom-recurrence-label';
import type { FrequencyType } from '@/types/scheduled-transaction';
import type { CustomRecurrence } from '@/lib/custom-recurrence';

/**
 * How a schedule's frequency reads on every surface that labels one: the
 * frequency's word, or for a Custom schedule the rule's own summary ("Every
 * week on Mon, Wed and Fri") rather than the word "Custom"
 * (docs/specs/custom-recurrence.md section 6).
 */
export function useFrequencyLabel(): (schedule: {
  frequency: FrequencyType;
  customRecurrence?: CustomRecurrence | null;
}) => string {
  const t = useTranslations('scheduledTransactions');
  const locale = useLocale();
  return useCallback(
    (schedule) => {
      if (schedule.frequency === 'CUSTOM') {
        return describeCustomRecurrence(schedule.customRecurrence, locale, t) ?? t('frequency.CUSTOM');
      }
      return t(`frequency.${schedule.frequency}`);
    },
    [t, locale],
  );
}
