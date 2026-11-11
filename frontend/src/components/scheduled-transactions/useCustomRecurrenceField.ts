'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getLocalDateString } from '@/lib/utils';
import { CustomRecurrence, CustomRecurrenceUnit } from '@/lib/custom-recurrence';
import { formatList } from '@/lib/custom-recurrence-label';
import {
  customDateOnOrAfter,
  defaultCustomRecurrence,
  orphanedOverrideDates,
  sameCustomRecurrence,
} from '@/lib/custom-recurrence-edit';
import { FREQUENCY_VALUES, FrequencyType, ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Account } from '@/types/account';
import type { CustomRecurrenceEditorProps } from './CustomRecurrenceEditor';

interface UseCustomRecurrenceFieldArgs {
  /** The schedule being edited; absent for a new one. */
  scheduledTransaction?: ScheduledTransaction;
  /** The accounts the form loaded, which say whether a loan pays by this schedule. */
  accounts: readonly Account[];
  frequency: FrequencyType | undefined;
  nextDueDate: string | undefined;
  rule: CustomRecurrence | null | undefined;
  setRule: (rule: CustomRecurrence) => void;
}

export interface CustomRecurrenceField {
  frequencyOptions: { value: FrequencyType; label: string }[];
  /** For the frequency select's `register` `onChange`: seeds a rule the first time Custom is picked. */
  onFrequencyChange: (frequency: string) => void;
  /** The editor's props while the frequency is Custom, else null. */
  editorProps: CustomRecurrenceEditorProps | null;
  /** "First occurrence: ..." beside the due date while the frequency is Custom. */
  occurrenceCaption: string | null;
  /** The edited occurrences this save would delete, named, or null. */
  orphanWarning: string | null;
}

/**
 * The scheduled-transaction form's Custom frequency (docs/specs/custom-recurrence.md):
 * which frequencies the selector offers, the rule a first Custom choice
 * starts from, each unit's choices kept while the user switches units, the
 * date the pattern posts first, and the warning that a save deletes edited
 * occurrences that no longer fall on the schedule (section 5).
 */
export function useCustomRecurrenceField({
  scheduledTransaction,
  accounts,
  frequency,
  nextDueDate,
  rule,
  setRule,
}: UseCustomRecurrenceFieldArgs): CustomRecurrenceField {
  const t = useTranslations('scheduledTransactions');
  const locale = useLocale();
  const { formatDate } = useDateFormat();
  const weekStartsOn = usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1;
  // Each unit's last choices, so Weekly -> Monthly -> Weekly comes back to the
  // weekdays the user had picked.
  const [drafts, setDrafts] = useState<Partial<Record<CustomRecurrenceUnit, CustomRecurrence>>>(() =>
    scheduledTransaction?.customRecurrence
      ? { [scheduledTransaction.customRecurrence.unit]: scheduledTransaction.customRecurrence }
      : {},
  );

  const seedDate = nextDueDate || getLocalDateString();

  // Amortisation and payroll deduction pooling assume a fixed cadence, and the
  // API refuses Custom there (spec section 5); a schedule already Custom keeps
  // the option so the selector can show it.
  const isLoanPayment =
    !!scheduledTransaction && accounts.some((a) => a.scheduledTransactionId === scheduledTransaction.id);
  const isPayroll = (scheduledTransaction?.payrollDeductions?.length ?? 0) > 0;
  const offersCustom = !(isLoanPayment || isPayroll) || scheduledTransaction?.frequency === 'CUSTOM';
  const frequencyOptions = FREQUENCY_VALUES.filter((value) => value !== 'CUSTOM' || offersCustom).map((value) => ({
    value,
    label: t(`frequency.${value}`),
  }));

  const onFrequencyChange = (next: string) => {
    if (next === 'CUSTOM' && !rule) {
      setRule(drafts.WEEK ?? defaultCustomRecurrence('WEEK', seedDate, weekStartsOn));
    }
  };

  const onUnitChange = (unit: CustomRecurrenceUnit) => {
    if (rule) setDrafts((prev) => ({ ...prev, [rule.unit]: rule }));
    setRule(drafts[unit] ?? defaultCustomRecurrence(unit, seedDate, weekStartsOn));
  };

  const isCustom = frequency === 'CUSTOM';
  // A Custom schedule that arrived without a rule (a defect the API refuses to
  // write) shows the starting rule; the form refuses the save until the user
  // picks one, which writes it.
  const editorProps: CustomRecurrenceEditorProps | null = isCustom
    ? {
        rule: rule ?? defaultCustomRecurrence('WEEK', seedDate, weekStartsOn),
        onChange: setRule,
        onUnitChange,
        weekStartsOn,
        idPrefix: 'scheduled',
      }
    : null;

  // A new schedule's periods count from the date being typed (the server makes
  // it the start date); an existing one's from its stored start date.
  const periodStart = scheduledTransaction?.startDate ?? nextDueDate;
  const firstDate = isCustom ? customDateOnOrAfter(nextDueDate, rule, periodStart) : null;
  const occurrenceCaption = firstDate
    ? t(scheduledTransaction ? 'customRecurrence.nextOccurrence' : 'customRecurrence.firstOccurrence', {
        date: formatDate(firstDate),
      })
    : null;

  const patternChanged =
    !!scheduledTransaction &&
    !!frequency &&
    (frequency !== scheduledTransaction.frequency ||
      (frequency === 'CUSTOM' && !sameCustomRecurrence(rule, scheduledTransaction.customRecurrence)));
  const orphans =
    patternChanged && scheduledTransaction && frequency && nextDueDate
      ? orphanedOverrideDates(
          {
            frequency,
            nextDueDate,
            startDate: scheduledTransaction.startDate,
            customRecurrence: frequency === 'CUSTOM' ? rule : null,
          },
          scheduledTransaction.futureOverrides ?? [],
        )
      : [];
  const orphanWarning =
    orphans.length > 0
      ? t('customRecurrence.orphanWarning', {
          count: orphans.length,
          dates: formatList(orphans.map((d) => formatDate(d)), locale),
        })
      : null;

  return { frequencyOptions, onFrequencyChange, editorProps, occurrenceCaption, orphanWarning };
}
